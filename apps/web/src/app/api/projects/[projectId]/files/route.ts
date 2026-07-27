import { db } from "@/lib/db";
import { projectFiles } from "@/lib/db/schema";
import { resolveProjectAccess } from "@/lib/auth/project-access";
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

// ─── GET /api/projects/[projectId]/files ───────────
// List all files in a project.

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;

    const access = await resolveProjectAccess(request, projectId);
    if (!access.access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const files = await db
      .select()
      .from(projectFiles)
      .where(eq(projectFiles.projectId, projectId));

    return NextResponse.json({ files, mainFile: access.project.mainFile });
  } catch (error) {
    console.error("Error listing files:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// ─── POST /api/projects/[projectId]/files ──────────
// Create a new file or directory in a project.

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;
    const access = await resolveProjectAccess(request, projectId);
    if (!access.access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }
    if (access.role === "viewer") {
      return NextResponse.json({ error: "Permission denied" }, { status: 403 });
    }

    const parsed = createFileSchema.safeParse(
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
    const pathValidation = validateFilePath(parsed.data.path);
    if (!pathValidation.valid) {
      return NextResponse.json({ error: pathValidation.error }, { status: 400 });
    }

    const file = await createProjectFileEntry({
      projectId,
      filePath: parsed.data.path,
      content: parsed.data.content ?? "",
      isDirectory: parsed.data.isDirectory ?? false,
    });
    broadcastFileEvent({
      type: "file:created",
      projectId,
      userId: access.user?.id ?? "anonymous",
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
    console.error("Error creating file:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
