import type { Engine, TemplateName } from "@backslash/shared";
import { MIME_TYPES } from "@backslash/shared";
import { eq } from "drizzle-orm";
import path from "path";
import { v4 as uuidv4 } from "uuid";

import { cancelProjectCompileTasks } from "@/lib/compiler/compile-task-manager";
import { db } from "@/lib/db";
import {
  createProjectWithFiles,
  deleteProjectRecord,
  ProjectQuotaExceededError,
} from "@/lib/db/project-file-mutations";
import { projects } from "@/lib/db/schema";
import {
  buildUploadPlan,
  resolveProjectPath,
} from "@/lib/storage/path-security";
import * as storage from "@/lib/storage";
import { withProjectMutationLock } from "@/lib/storage/project-mutation-lock";

function readMaxProjectsPerUser(): number {
  const raw = process.env.MAX_PROJECTS_PER_USER;
  if (!raw) return 100;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000) {
    throw new Error("MAX_PROJECTS_PER_USER must be an integer between 1 and 10000");
  }
  return parsed;
}

const MAX_PROJECTS_PER_USER = readMaxProjectsPerUser();

export class ProjectOperationError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409
  ) {
    super(message);
    this.name = "ProjectOperationError";
  }
}

/**
 * Delete a project without racing file mutations or newly queued compiles.
 * Existing compile processes must stop before the directory is staged away.
 */
export async function deleteOwnedProject(options: {
  projectId: string;
  ownerUserId: string;
  cancelTimeoutMs?: number;
}): Promise<void> {
  await withProjectMutationLock(options.projectId, async () => {
    const [project] = await db
      .select({ id: projects.id, userId: projects.userId })
      .from(projects)
      .where(eq(projects.id, options.projectId))
      .limit(1);
    if (!project || project.userId !== options.ownerUserId) {
      throw new ProjectOperationError("Project not found", 404);
    }

    const cancellation = await cancelProjectCompileTasks(
      options.projectId,
      options.cancelTimeoutMs ?? 10_000
    );
    if (!cancellation.settled) {
      throw new ProjectOperationError(
        "A compilation process did not stop in time. The project was not deleted.",
        409
      );
    }

    const projectDir = storage.getProjectDir(
      options.ownerUserId,
      options.projectId
    );
    const diskMutation = await storage.stagePathRemoval(projectDir);
    try {
      deleteProjectRecord({
        projectId: options.projectId,
        ownerUserId: options.ownerUserId,
      });
    } catch (error) {
      await diskMutation.rollback();
      throw error;
    }

    await diskMutation.commit().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[Storage] Failed to purge deleted project ${options.projectId}: ${message}\n`
      );
    });
  });
}

export async function createOwnedProject(options: {
  ownerUserId: string;
  name: string;
  description?: string;
  engine?: Engine;
  template?: TemplateName;
}) {
  const projectId = uuidv4();
  const projectDir = storage.getProjectDir(options.ownerUserId, projectId);
  const createdAt = new Date().toISOString();
  const project = {
    id: projectId,
    userId: options.ownerUserId,
    name: options.name,
    description: options.description ?? "",
    engine: options.engine ?? ("auto" as Engine),
    mainFile: "main.tex",
    createdAt,
    updatedAt: createdAt,
  };

  try {
    const copiedFiles = await storage.copyTemplate(
      options.template ?? "blank",
      projectDir
    );
    if (!copiedFiles.includes(project.mainFile)) {
      throw new Error(
        `Template '${options.template ?? "blank"}' does not contain ${project.mainFile}`
      );
    }

    const templatePlan = buildUploadPlan(copiedFiles);
    const directoryRows = templatePlan.directoryPaths.map((directoryPath) => ({
      id: uuidv4(),
      path: directoryPath,
      mimeType: null,
      sizeBytes: 0,
      isDirectory: true,
    }));
    const fileRows = await Promise.all(
      templatePlan.filePaths.map(async (filePath) => {
        const extension = path.extname(filePath).toLowerCase();
        const fullPath = resolveProjectPath(projectDir, filePath);
        return {
          id: uuidv4(),
          path: filePath,
          mimeType: MIME_TYPES[extension] || "text/plain",
          sizeBytes: await storage.getFileSize(fullPath),
          isDirectory: false,
        };
      })
    );

    createProjectWithFiles({
      project,
      files: [...directoryRows, ...fileRows],
      maxProjectsPerUser: MAX_PROJECTS_PER_USER,
    });
    return project;
  } catch (error) {
    const operationError =
      error instanceof ProjectQuotaExceededError
        ? new ProjectOperationError(error.message, 409)
        : error;
    try {
      await storage.deleteDirectory(projectDir);
    } catch (cleanupError) {
      throw new AggregateError(
        [operationError, cleanupError],
        `Failed to create and clean up project ${projectId}`
      );
    }
    throw operationError;
  }
}
