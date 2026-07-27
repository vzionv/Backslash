import type { Engine } from "@backslash/shared";
import { and, eq } from "drizzle-orm";
import path from "path";
import { v4 as uuidv4 } from "uuid";

import { db } from "@/lib/db";
import {
  applyProjectFileRename,
  applyProjectUploadRecords,
  createProjectFileRecord,
  deleteProjectFileRows,
  updateProjectFileAfterWrite,
} from "@/lib/db/project-file-mutations";
import { projectFiles, projects } from "@/lib/db/schema";
import { MIME_TYPES } from "@backslash/shared";
import * as storage from "@/lib/storage";
import {
  assertProjectPathHasNoSymlink,
  buildUploadPlan,
  resolveProjectPath,
} from "@/lib/storage/path-security";
import {
  buildProjectFileRenamePlan,
  ProjectFileMutationConflictError,
  selectFallbackMainFile,
} from "@/lib/storage/project-file-plan";
import { withProjectMutationLock } from "@/lib/storage/project-mutation-lock";
import { validateProjectStorage } from "@/lib/storage/resource-limits";

type ProjectFileRow = typeof projectFiles.$inferSelect;

export class ProjectFileOperationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 413
  ) {
    super(message);
    this.name = "ProjectFileOperationError";
  }
}

async function commitCleanup(
  mutation: storage.StagedPathMutation,
  description: string
): Promise<void> {
  await mutation.commit().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[Storage] Failed to purge ${description}: ${message}\n`
    );
  });
}

function assertExpectedOwner(
  project: typeof projects.$inferSelect | undefined,
  expectedOwnerUserId?: string
): asserts project is typeof projects.$inferSelect {
  if (!project || (expectedOwnerUserId && project.userId !== expectedOwnerUserId)) {
    throw new ProjectFileOperationError("Project not found", 404);
  }
}

export async function saveProjectFileContent(options: {
  projectId: string;
  fileId: string;
  content: string;
  expectedOwnerUserId?: string;
}): Promise<{
  file: ProjectFileRow;
  storageUserId: string;
  mainFile: string;
  engine: Engine;
}> {
  return withProjectMutationLock(options.projectId, async () => {
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, options.projectId))
      .limit(1);
    assertExpectedOwner(project, options.expectedOwnerUserId);

    const [file] = await db
      .select()
      .from(projectFiles)
      .where(
        and(
          eq(projectFiles.id, options.fileId),
          eq(projectFiles.projectId, options.projectId)
        )
      )
      .limit(1);
    if (!file) throw new ProjectFileOperationError("File not found", 404);
    if (file.isDirectory) {
      throw new ProjectFileOperationError(
        "Directories do not have editable content",
        400
      );
    }

    const sizeBytes = Buffer.byteLength(options.content, "utf-8");
    const storedFiles = await db
      .select({
        path: projectFiles.path,
        sizeBytes: projectFiles.sizeBytes,
        isDirectory: projectFiles.isDirectory,
      })
      .from(projectFiles)
      .where(eq(projectFiles.projectId, options.projectId));
    const storageValidation = validateProjectStorage(
      storedFiles.map((entry) => ({
        path: entry.path,
        sizeBytes: entry.sizeBytes ?? 0,
        isDirectory: entry.isDirectory ?? false,
      })),
      [{ path: file.path, sizeBytes }]
    );
    if (!storageValidation.valid) {
      throw new ProjectFileOperationError(
        storageValidation.error,
        storageValidation.status
      );
    }

    const projectDir = storage.getProjectDir(project.userId, options.projectId);
    await assertProjectPathHasNoSymlink(projectDir, file.path);
    const fullPath = resolveProjectPath(projectDir, file.path);
    const diskMutation = await storage.stageFileWrite(fullPath, options.content);
    const updatedAt = new Date().toISOString();

    try {
      updateProjectFileAfterWrite({
        projectId: options.projectId,
        fileId: options.fileId,
        sizeBytes,
        updatedAt,
      });
    } catch (error) {
      await diskMutation.rollback();
      throw error;
    }
    await commitCleanup(diskMutation, `save backup for ${file.path}`);

    return {
      file: { ...file, sizeBytes, updatedAt },
      storageUserId: project.userId,
      mainFile: project.mainFile,
      engine: project.engine as Engine,
    };
  });
}

export async function renameProjectFilePath(options: {
  projectId: string;
  fileId: string;
  newPath: string;
  expectedOwnerUserId?: string;
}): Promise<{
  file: ProjectFileRow;
  oldPath: string;
  mainFile: string;
}> {
  return withProjectMutationLock(options.projectId, async () => {
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, options.projectId))
      .limit(1);
    assertExpectedOwner(project, options.expectedOwnerUserId);

    const files: ProjectFileRow[] = await db
      .select()
      .from(projectFiles)
      .where(eq(projectFiles.projectId, options.projectId));
    const target = files.find((entry) => entry.id === options.fileId);
    if (!target) throw new ProjectFileOperationError("File not found", 404);

    let plan;
    try {
      plan = buildProjectFileRenamePlan({
        files,
        fileId: options.fileId,
        newPath: options.newPath,
        mainFile: project.mainFile,
      });
    } catch (error) {
      if (error instanceof ProjectFileMutationConflictError) {
        throw new ProjectFileOperationError(error.message, 409);
      }
      throw error;
    }

    if (plan.updates.length === 0) {
      return { file: target, oldPath: target.path, mainFile: project.mainFile };
    }

    const projectDir = storage.getProjectDir(project.userId, options.projectId);
    await assertProjectPathHasNoSymlink(projectDir, target.path);
    await assertProjectPathHasNoSymlink(projectDir, options.newPath);
    const oldFullPath = resolveProjectPath(projectDir, target.path);
    const newFullPath = resolveProjectPath(projectDir, options.newPath);

    let diskMutation: storage.StagedPathMutation;
    try {
      diskMutation = await storage.stagePathMove(oldFullPath, newFullPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ProjectFileOperationError(
          "A file already exists at that path on disk",
          409
        );
      }
      throw error;
    }

    const updatedAt = new Date().toISOString();
    try {
      applyProjectFileRename({
        projectId: options.projectId,
        updates: plan.updates.map((update) => ({
          id: update.id,
          newPath: update.newPath,
        })),
        previousMainFile: project.mainFile,
        nextMainFile: plan.nextMainFile,
        updatedAt,
      });
    } catch (error) {
      await diskMutation.rollback();
      throw error;
    }
    await diskMutation.commit();

    return {
      file: { ...target, path: options.newPath, updatedAt },
      oldPath: target.path,
      mainFile: plan.nextMainFile,
    };
  });
}

export async function deleteProjectFilePath(options: {
  projectId: string;
  fileId: string;
  expectedOwnerUserId?: string;
}): Promise<{ path: string; mainFile: string }> {
  return withProjectMutationLock(options.projectId, async () => {
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, options.projectId))
      .limit(1);
    assertExpectedOwner(project, options.expectedOwnerUserId);

    const files: ProjectFileRow[] = await db
      .select()
      .from(projectFiles)
      .where(eq(projectFiles.projectId, options.projectId));
    const target = files.find((entry) => entry.id === options.fileId);
    if (!target) throw new ProjectFileOperationError("File not found", 404);

    const deletedEntries = target.isDirectory
      ? files.filter(
          (entry) =>
            entry.path === target.path ||
            entry.path.startsWith(`${target.path}/`)
        )
      : [target];
    const deletedIds = new Set(deletedEntries.map((entry) => entry.id));
    const mainFileWasDeleted = target.isDirectory
      ? project.mainFile === target.path ||
        project.mainFile.startsWith(`${target.path}/`)
      : project.mainFile === target.path;
    const nextMainFile = selectFallbackMainFile({
      files,
      deletedIds,
      currentMainFile: project.mainFile,
      currentWasDeleted: mainFileWasDeleted,
    });

    const projectDir = storage.getProjectDir(project.userId, options.projectId);
    await assertProjectPathHasNoSymlink(projectDir, target.path);
    const fullPath = resolveProjectPath(projectDir, target.path);
    const diskMutation = await storage.stagePathRemoval(fullPath);
    const updatedAt = new Date().toISOString();

    try {
      deleteProjectFileRows({
        projectId: options.projectId,
        fileIds: deletedEntries.map((entry) => entry.id),
        previousMainFile: project.mainFile,
        nextMainFile,
        updatedAt,
      });
    } catch (error) {
      await diskMutation.rollback();
      throw error;
    }
    await commitCleanup(diskMutation, `staged deletion for ${target.path}`);

    return { path: target.path, mainFile: nextMainFile };
  });
}

export async function createProjectFileEntry(options: {
  projectId: string;
  filePath: string;
  content: string;
  isDirectory: boolean;
  expectedOwnerUserId?: string;
}): Promise<ProjectFileRow> {
  return withProjectMutationLock(options.projectId, async () => {
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, options.projectId))
      .limit(1);
    assertExpectedOwner(project, options.expectedOwnerUserId);

    const [existing] = await db
      .select({ id: projectFiles.id })
      .from(projectFiles)
      .where(
        and(
          eq(projectFiles.projectId, options.projectId),
          eq(projectFiles.path, options.filePath)
        )
      )
      .limit(1);
    if (existing) {
      throw new ProjectFileOperationError(
        "A file with this path already exists",
        409
      );
    }

    const sizeBytes = options.isDirectory
      ? 0
      : Buffer.byteLength(options.content, "utf-8");
    const storedFiles = await db
      .select({
        path: projectFiles.path,
        sizeBytes: projectFiles.sizeBytes,
        isDirectory: projectFiles.isDirectory,
      })
      .from(projectFiles)
      .where(eq(projectFiles.projectId, options.projectId));
    const storageValidation = validateProjectStorage(
      storedFiles.map((entry) => ({
        path: entry.path,
        sizeBytes: entry.sizeBytes ?? 0,
        isDirectory: entry.isDirectory ?? false,
      })),
      [{ path: options.filePath, sizeBytes }]
    );
    if (!storageValidation.valid) {
      throw new ProjectFileOperationError(
        storageValidation.error,
        storageValidation.status
      );
    }

    const projectDir = storage.getProjectDir(project.userId, options.projectId);
    await assertProjectPathHasNoSymlink(projectDir, options.filePath);
    const fullPath = resolveProjectPath(projectDir, options.filePath);
    if (await storage.fileExists(fullPath)) {
      throw new ProjectFileOperationError(
        "A file already exists at that path on disk",
        409
      );
    }

    let diskMutation: storage.StagedPathMutation | null = null;
    if (options.isDirectory) {
      await storage.createDirectory(fullPath);
    } else {
      diskMutation = await storage.stageFileWrite(fullPath, options.content);
    }

    const extension = path.extname(options.filePath).toLowerCase();
    const now = new Date().toISOString();
    const file = {
      id: uuidv4(),
      projectId: options.projectId,
      path: options.filePath,
      mimeType: options.isDirectory
        ? "inode/directory"
        : MIME_TYPES[extension] || "text/plain",
      sizeBytes,
      isDirectory: options.isDirectory,
      createdAt: now,
      updatedAt: now,
    };

    try {
      createProjectFileRecord(file);
    } catch (error) {
      if (diskMutation) {
        await diskMutation.rollback();
      } else {
        await storage.deleteDirectory(fullPath).catch(() => undefined);
      }
      throw error;
    }

    if (diskMutation) await commitCleanup(diskMutation, `new file ${file.path}`);
    return file;
  });
}

export interface ProjectUploadItem {
  file: File;
  path: string;
}

export interface ProjectUploadResult {
  files: ProjectFileRow[];
  events: Array<{
    type: "file:created" | "file:saved";
    fileId: string;
    path: string;
    isDirectory?: boolean;
  }>;
}

export async function uploadProjectFiles(options: {
  projectId: string;
  uploads: ProjectUploadItem[];
  expectedOwnerUserId?: string;
}): Promise<ProjectUploadResult> {
  return withProjectMutationLock(options.projectId, async () => {
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, options.projectId))
      .limit(1);
    assertExpectedOwner(project, options.expectedOwnerUserId);

    const existingFiles: ProjectFileRow[] = await db
      .select()
      .from(projectFiles)
      .where(eq(projectFiles.projectId, options.projectId));
    const existingByPath = new Map<string, ProjectFileRow>(
      existingFiles.map((entry) => [entry.path, entry])
    );
    const uploadPaths = new Set(options.uploads.map((upload) => upload.path));
    const { directoryPaths } = buildUploadPlan(
      options.uploads.map((upload) => upload.path)
    );

    for (const directoryPath of directoryPaths) {
      if (uploadPaths.has(directoryPath)) {
        throw new ProjectFileOperationError(
          `Path '${directoryPath}' is used as both a file and directory`,
          409
        );
      }
      const existing = existingByPath.get(directoryPath);
      if (existing && !existing.isDirectory) {
        throw new ProjectFileOperationError(
          `Cannot upload beneath file '${directoryPath}'`,
          409
        );
      }
    }
    for (const upload of options.uploads) {
      const existing = existingByPath.get(upload.path);
      if (existing?.isDirectory) {
        throw new ProjectFileOperationError(
          `Cannot replace directory '${upload.path}' with a file`,
          409
        );
      }
    }

    const storageValidation = validateProjectStorage(
      existingFiles.map((entry) => ({
        path: entry.path,
        sizeBytes: entry.sizeBytes ?? 0,
        isDirectory: entry.isDirectory ?? false,
      })),
      options.uploads.map((upload) => ({
        path: upload.path,
        sizeBytes: upload.file.size,
      }))
    );
    if (!storageValidation.valid) {
      throw new ProjectFileOperationError(
        storageValidation.error,
        storageValidation.status
      );
    }

    const projectDir = storage.getProjectDir(project.userId, options.projectId);
    const staged: Array<{
      mutation: storage.StagedPathMutation;
      path: string;
    }> = [];

    try {
      for (const upload of options.uploads) {
        await assertProjectPathHasNoSymlink(projectDir, upload.path);
        const fullPath = resolveProjectPath(projectDir, upload.path);
        staged.push({
          mutation: await storage.stageFileWriteFromStream(
            fullPath,
            upload.file.stream()
          ),
          path: upload.path,
        });
      }
    } catch (error) {
      for (const entry of staged.reverse()) {
        await entry.mutation.rollback().catch(() => undefined);
      }
      for (const directoryPath of [...directoryPaths].sort(
        (left, right) => right.length - left.length
      )) {
        await storage
          .deleteDirectoryIfEmpty(resolveProjectPath(projectDir, directoryPath))
          .catch(() => undefined);
      }
      throw error;
    }

    const updatedAt = new Date().toISOString();
    const directoryRecords = directoryPaths
      .filter((directoryPath) => !existingByPath.has(directoryPath))
      .map((directoryPath) => ({ id: uuidv4(), path: directoryPath }));
    const fileRecords = options.uploads.map((upload) => {
      const existing = existingByPath.get(upload.path);
      const extension = path.extname(upload.path).toLowerCase();
      return {
        id: existing?.id ?? uuidv4(),
        path: upload.path,
        mimeType:
          MIME_TYPES[extension] ||
          upload.file.type ||
          "application/octet-stream",
        sizeBytes: upload.file.size,
        existing: Boolean(existing),
      };
    });

    try {
      applyProjectUploadRecords({
        projectId: options.projectId,
        directories: directoryRecords,
        files: fileRecords,
        updatedAt,
      });
    } catch (error) {
      for (const entry of staged.reverse()) {
        await entry.mutation.rollback().catch(() => undefined);
      }
      for (const directoryPath of [...directoryPaths].sort(
        (left, right) => right.length - left.length
      )) {
        await storage
          .deleteDirectoryIfEmpty(resolveProjectPath(projectDir, directoryPath))
          .catch(() => undefined);
      }
      throw error;
    }

    for (const entry of staged) {
      await commitCleanup(entry.mutation, `upload backup for ${entry.path}`);
    }

    const directoryRows = directoryRecords.map((directory) => ({
      id: directory.id,
      projectId: options.projectId,
      path: directory.path,
      mimeType: null,
      sizeBytes: 0,
      isDirectory: true,
      createdAt: updatedAt,
      updatedAt,
    }));
    const fileRows = fileRecords.map((file) => {
      const existing = existingByPath.get(file.path);
      return {
        id: file.id,
        projectId: options.projectId,
        path: file.path,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        isDirectory: false,
        createdAt: existing?.createdAt ?? updatedAt,
        updatedAt,
      };
    });

    return {
      files: fileRows,
      events: [
        ...directoryRows.map((directory) => ({
          type: "file:created" as const,
          fileId: directory.id,
          path: directory.path,
          isDirectory: true,
        })),
        ...fileRecords.map((file) => ({
          type: file.existing ? ("file:saved" as const) : ("file:created" as const),
          fileId: file.id,
          path: file.path,
          isDirectory: false,
        })),
      ],
    };
  });
}
