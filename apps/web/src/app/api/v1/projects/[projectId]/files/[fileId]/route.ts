import { db } from "@/lib/db";
import { projects, projectFiles } from "@/lib/db/schema";
import { withApiKey } from "@/lib/auth/apikey";
import { updateFileSchema } from "@/lib/utils/validation";
import * as storage from "@/lib/storage";
import {
  assertProjectPathHasNoSymlink,
  resolveProjectPath,
} from "@/lib/storage/path-security";
import {
  deleteProjectFilePath,
  ProjectFileOperationError,
  saveProjectFileContent,
} from "@/lib/storage/project-file-operations";
import { broadcastFileEvent } from "@/lib/websocket/server";
import { eq, and } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { readJsonBody, RequestBodyError } from "@/lib/security/request-body";
import { MAX_TEXT_CONTENT_BYTES } from "@/lib/storage/resource-limits";

// ─── GET /api/v1/projects/[projectId]/files/[fileId] ─
// Get file metadata and content.

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; fileId: string }> }
) {
  return withApiKey(request, async (req, user) => {
    try {
      const { projectId, fileId } = await params;

      const [project] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);

      if (!project || project.userId !== user.id) {
        return NextResponse.json(
          { error: "Project not found" },
          { status: 404 }
        );
      }

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

      const projectDir = storage.getProjectDir(user.id, projectId);
      await assertProjectPathHasNoSymlink(projectDir, file.path);
      const fullPath = resolveProjectPath(projectDir, file.path);

      if (req.nextUrl.searchParams.has("raw") && !file.isDirectory) {
        try {
          return await storage.createFileResponse(
            fullPath,
            { "Content-Type": file.mimeType || "application/octet-stream" },
            req
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
              { error: error.message, maxBytes: error.maxBytes },
              { status: 413 }
            );
          }
          content = "";
        }
      }

      return NextResponse.json({ file, content });
    } catch (error) {
      console.error("[API v1] Error reading file:", error);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  });
}

// ─── PUT /api/v1/projects/[projectId]/files/[fileId] ─
// Update file content.

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; fileId: string }> }
) {
  return withApiKey(request, async (req, user) => {
    try {
      const { projectId, fileId } = await params;
      const parsed = updateFileSchema.safeParse(
        await readJsonBody(req, MAX_TEXT_CONTENT_BYTES + 64 * 1024)
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

      const saved = await saveProjectFileContent({
        projectId,
        fileId,
        content: parsed.data.content,
        expectedOwnerUserId: user.id,
      });
      broadcastFileEvent({
        type: "file:saved",
        projectId,
        userId: user.id,
        fileId,
        path: saved.file.path,
      });
      return NextResponse.json({ file: saved.file });
    } catch (error) {
      if (error instanceof RequestBodyError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      if (error instanceof ProjectFileOperationError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      console.error("[API v1] Error updating file:", error);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  });
}

// ─── DELETE /api/v1/projects/[projectId]/files/[fileId] ─
// Delete a file.

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; fileId: string }> }
) {
  return withApiKey(request, async (_req, user) => {
    try {
      const { projectId, fileId } = await params;
      const deleted = await deleteProjectFilePath({
        projectId,
        fileId,
        expectedOwnerUserId: user.id,
      });
      broadcastFileEvent({
        type: "file:deleted",
        projectId,
        userId: user.id,
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
      console.error("[API v1] Error deleting file:", error);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  });
}
