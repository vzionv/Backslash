import { db } from "@/lib/db";
import { projects, projectFiles } from "@/lib/db/schema";
import { withApiKey } from "@/lib/auth/apikey";
import { createFileSchema, validateFilePath } from "@/lib/utils/validation";
import { broadcastFileEvent } from "@/lib/websocket/server";
import {
  createProjectFileEntry,
  ProjectFileOperationError,
} from "@/lib/storage/project-file-operations";
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { readJsonBody, RequestBodyError } from "@/lib/security/request-body";
import { MAX_TEXT_CONTENT_BYTES } from "@/lib/storage/resource-limits";

// ─── GET /api/v1/projects/[projectId]/files ─────────
// List all files in a project.

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  return withApiKey(request, async (_req, user) => {
    try {
      const { projectId } = await params;

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

      const files = await db
        .select()
        .from(projectFiles)
        .where(eq(projectFiles.projectId, projectId));

      return NextResponse.json({ files });
    } catch (error) {
      console.error("[API v1] Error listing files:", error);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  });
}

// ─── POST /api/v1/projects/[projectId]/files ────────
// Create a new file in a project.

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  return withApiKey(request, async (req, user) => {
    try {
      const { projectId } = await params;
      const parsed = createFileSchema.safeParse(
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
      const pathValidation = validateFilePath(parsed.data.path);
      if (!pathValidation.valid) {
        return NextResponse.json({ error: pathValidation.error }, { status: 400 });
      }

      const file = await createProjectFileEntry({
        projectId,
        filePath: parsed.data.path,
        content: parsed.data.content ?? "",
        isDirectory: parsed.data.isDirectory ?? false,
        expectedOwnerUserId: user.id,
      });
      broadcastFileEvent({
        type: "file:created",
        projectId,
        userId: user.id,
        fileId: file.id,
        path: file.path,
        isDirectory: file.isDirectory ?? false,
      });
      return NextResponse.json({ file }, { status: 201 });
    } catch (error) {
      if (error instanceof RequestBodyError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      if (error instanceof ProjectFileOperationError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      console.error("[API v1] Error creating file:", error);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  });
}
