import type { Engine } from "@backslash/shared";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

import { db } from "@/lib/db";
import { builds, projects } from "@/lib/db/schema";
import { withProjectMutationLock } from "@/lib/storage/project-mutation-lock";
import { broadcastBuildUpdate } from "@/lib/websocket/server";
import { addCompileJob } from "@/lib/compiler/runner";
import { assertConcreteEngineAllowed } from "@/lib/compiler/engine-policy";
import { detectEngineFromSource } from "@/lib/compiler/main-file-resolver";
import * as storage from "@/lib/storage";
import {
  assertProjectPathHasNoSymlink,
  resolveProjectPath,
} from "@/lib/storage/path-security";
import { MAX_TEXT_CONTENT_BYTES } from "@/lib/storage/resource-limits";

export class ProjectCompileError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409
  ) {
    super(message);
    this.name = "ProjectCompileError";
  }
}

/** Serialize the final existence check, build record, and enqueue with deletion. */
export async function queueProjectCompile(options: {
  projectId: string;
  buildUserId: string;
  storageUserId: string;
  triggeredByUserId: string | null;
  engine?: Engine;
}): Promise<{ buildId: string; mainFile: string; engine: Engine }> {
  return withProjectMutationLock(options.projectId, async () => {
    const [project] = await db
      .select({
        id: projects.id,
        userId: projects.userId,
        mainFile: projects.mainFile,
        engine: projects.engine,
      })
      .from(projects)
      .where(eq(projects.id, options.projectId))
      .limit(1);

    if (!project || project.userId !== options.storageUserId) {
      throw new ProjectCompileError("Project not found", 404);
    }

    const engine = options.engine ?? (project.engine as Engine);
    try {
      if (engine === "auto") {
        const projectDir = storage.getProjectDir(project.userId, options.projectId);
        await assertProjectPathHasNoSymlink(projectDir, project.mainFile);
        const source = await storage.readTextFileLimited(
          resolveProjectPath(projectDir, project.mainFile),
          MAX_TEXT_CONTENT_BYTES
        );
        assertConcreteEngineAllowed(detectEngineFromSource(source));
      } else {
        assertConcreteEngineAllowed(engine);
      }
    } catch (error) {
      throw new ProjectCompileError(
        error instanceof Error ? error.message : "Compilation engine is unavailable",
        400
      );
    }

    const buildId = uuidv4();
    await db.insert(builds).values({
      id: buildId,
      projectId: options.projectId,
      userId: options.buildUserId,
      status: "queued",
      engine,
    });
    await db
      .update(projects)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(projects.id, options.projectId));

    await addCompileJob({
      buildId,
      projectId: options.projectId,
      userId: options.buildUserId,
      storageUserId: options.storageUserId,
      triggeredByUserId: options.triggeredByUserId,
      engine,
      mainFile: project.mainFile,
    });

    broadcastBuildUpdate(options.buildUserId, {
      projectId: options.projectId,
      buildId,
      status: "queued",
      triggeredByUserId: options.triggeredByUserId,
    });

    return { buildId, mainFile: project.mainFile, engine };
  });
}
