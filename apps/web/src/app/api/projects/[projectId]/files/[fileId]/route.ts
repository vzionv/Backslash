import { CompileQueueFullError } from "@/lib/compiler/compile-task-manager";
import { db } from "@/lib/db";
import { projectFiles } from "@/lib/db/schema";
import { resolveProjectAccess } from "@/lib/auth/project-access";
import {
  updateFileSchema,
  renameFileSchema,
  validateFilePath,
} from "@/lib/utils/validation";
import { broadcastFileEvent } from "@/lib/websocket/server";
import * as storage from "@/lib/storage";
import {
  assertProjectPathHasNoSymlink,
  resolveProjectPath,
} from "@/lib/storage/path-security";
import {
  deleteProjectFilePath,
  ProjectFileOperationError,
  renameProjectFilePath,
  saveProjectFileContent,
} from "@/lib/storage/project-file-operations";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { readJsonBody, RequestBodyError } from "@/lib/security/request-body";
import { MAX_TEXT_CONTENT_BYTES } from "@/lib/storage/resource-limits";
import { and, eq } from "drizzle-orm";
import { queueProjectCompile } from "@/lib/compiler/queue-project-compile";
import { NextRequest, NextResponse } from "next/server";

// ─── GET /api/projects/[projectId]/files/[fileId] ──
// Get file metadata and content.

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; fileId: string }> }
) {
  try {
    const { projectId, fileId } = await params;

    const access = await resolveProjectAccess(request, projectId);
    if (!access.access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const project = access.project;

    const [file] = await db
      .select()
      .from(projectFiles)
      .where(
        and(
          eq(projectFiles.id, fileId),
          eq(projectFiles.projectId, projectId)
        )
      )
      .limit(1);

    if (!file) {
      return NextResponse.json(
        { error: "File not found" },
        { status: 404 }
      );
    }

    const projectDir = storage.getProjectDir(project.userId, projectId);
    await assertProjectPathHasNoSymlink(projectDir, file.path);
    const fullPath = resolveProjectPath(projectDir, file.path);

    // Stream the original file without loading it into the Node.js heap.
    const isRaw = request.nextUrl.searchParams.has("raw");
    if (isRaw && !file.isDirectory) {
      try {
        return await storage.createFileResponse(
          fullPath,
          {
            "Content-Type": file.mimeType || "application/octet-stream",
          },
          request
        );
      } catch {
        return NextResponse.json(
          { error: "File not found on disk" },
          { status: 404 }
        );
      }
    }

    let content = "";
    if (!file.isDirectory) {
      try {
        content = await storage.readTextFileLimited(
          fullPath,
          MAX_TEXT_CONTENT_BYTES
        );
      } catch (error) {
        if (error instanceof storage.TextFileTooLargeError) {
          return NextResponse.json(
            {
              error: error.message,
              maxBytes: error.maxBytes,
              rawUrl: `${request.nextUrl.pathname}?raw`,
            },
            { status: 413 }
          );
        }
        // Preserve the previous response shape for a stale database record.
        content = "";
      }
    }

    return NextResponse.json({ file, content });
  } catch (error) {
    console.error("Error reading file:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// ─── PUT /api/projects/[projectId]/files/[fileId] ──
// Update file content. Optionally triggers auto-compilation.

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; fileId: string }> }
) {
  try {
    const { projectId, fileId } = await params;
    const access = await resolveProjectAccess(request, projectId);
    if (!access.access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }
    if (access.role === "viewer") {
      return NextResponse.json({ error: "Permission denied" }, { status: 403 });
    }

    const parsed = updateFileSchema.safeParse(
      await readJsonBody(request, MAX_TEXT_CONTENT_BYTES + 64 * 1024)
    );
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const { content, autoCompile } = parsed.data;
    const saved = await saveProjectFileContent({ projectId, fileId, content });
    const actorUserId = access.user?.id ?? null;
    const buildUserId = access.user?.id ?? saved.storageUserId;
    let buildQueued = false;
    let compileWarning: string | null = null;

    const compileRateLimited = autoCompile
      ? enforceRateLimit(request, "project:auto-compile", {
          limit: 45,
          windowMs: 60_000,
          identifier: access.user?.id ?? `share:${projectId}`,
        })
      : null;

    if (autoCompile && compileRateLimited) {
      compileWarning =
        "Compilation rate limit reached; the file was saved but not compiled.";
    } else if (autoCompile) {
      try {
        await queueProjectCompile({
          projectId,
          buildUserId,
          storageUserId: saved.storageUserId,
          triggeredByUserId: actorUserId,
        });
        buildQueued = true;
      } catch (error) {
        const queueFull = error instanceof CompileQueueFullError;
        compileWarning = queueFull
          ? "Compilation queue is full; the file was saved but not compiled."
          : "Compilation service is unavailable; the file was saved but not compiled.";
        if (!queueFull) {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(
            `[Compile] Failed to queue autosave build for ${projectId}: ${message}\n`
          );
        }
      }
    }

    broadcastFileEvent({
      type: "file:saved",
      projectId,
      userId: actorUserId ?? "anonymous",
      fileId,
      path: saved.file.path,
    });

    return NextResponse.json({
      file: saved.file,
      buildQueued,
      compileWarning,
    });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ProjectFileOperationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Error updating file:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ─── PATCH /api/projects/[projectId]/files/[fileId] ──
// Rename or move a file/folder.

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; fileId: string }> }
) {
  try {
    const { projectId, fileId } = await params;
    const access = await resolveProjectAccess(request, projectId);
    if (!access.access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }
    if (access.role === "viewer") {
      return NextResponse.json({ error: "Permission denied" }, { status: 403 });
    }

    const parsed = renameFileSchema.safeParse(await readJsonBody(request, 64 * 1024));
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }
    const validation = validateFilePath(parsed.data.newPath);
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const renamed = await renameProjectFilePath({
      projectId,
      fileId,
      newPath: parsed.data.newPath,
    });

    broadcastFileEvent({
      type: "file:renamed",
      projectId,
      userId: access.user?.id ?? "anonymous",
      fileId,
      path: renamed.file.path,
      oldPath: renamed.oldPath,
      mainFile: renamed.mainFile,
      isDirectory: renamed.file.isDirectory ?? false,
    });

    return NextResponse.json({ file: renamed.file, mainFile: renamed.mainFile });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ProjectFileOperationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Error renaming file:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ─── DELETE /api/projects/[projectId]/files/[fileId]
// Delete a file from disk and database.

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; fileId: string }> }
) {
  try {
    const { projectId, fileId } = await params;
    const access = await resolveProjectAccess(request, projectId);
    if (!access.access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }
    if (access.role === "viewer") {
      return NextResponse.json({ error: "Permission denied" }, { status: 403 });
    }

    const deleted = await deleteProjectFilePath({ projectId, fileId });
    broadcastFileEvent({
      type: "file:deleted",
      projectId,
      userId: access.user?.id ?? "anonymous",
      fileId,
      path: deleted.path,
    });

    return NextResponse.json({ success: true, mainFile: deleted.mainFile });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ProjectFileOperationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Error deleting file:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
