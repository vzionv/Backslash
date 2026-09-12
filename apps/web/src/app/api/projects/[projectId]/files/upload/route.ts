import { resolveProjectAccess } from "@/lib/auth/project-access";
import { broadcastFileEvent } from "@/lib/websocket/server";
import {
  ProjectFileOperationError,
  uploadProjectFiles,
} from "@/lib/storage/project-file-operations";
import {
  parseProjectUploadRequest,
  ProjectUploadRequestError,
} from "@/lib/storage/upload-request";
import { tryAcquireUploadTask } from "@/lib/storage/upload-task-limit";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { NextRequest, NextResponse } from "next/server";

// POST /api/projects/[projectId]/files/upload
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  let releaseUpload: (() => void) | null = null;
  try {
    const { projectId } = await params;
    const access = await resolveProjectAccess(request, projectId);
    if (!access.access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }
    if (access.role === "viewer") {
      return NextResponse.json({ error: "Permission denied" }, { status: 403 });
    }

    const rateLimited = enforceRateLimit(request, "project:upload", {
      limit: 20,
      windowMs: 60_000,
      identifier: access.user?.id ?? `share:${projectId}`,
    });
    if (rateLimited) return rateLimited;

    releaseUpload = tryAcquireUploadTask();
    if (!releaseUpload) {
      return NextResponse.json(
        { error: "Upload capacity is busy. Retry shortly." },
        { status: 503, headers: { "Retry-After": "2" } }
      );
    }

    const uploads = await parseProjectUploadRequest(request);
    const conflictValue = request.nextUrl.searchParams.get("conflict");
    const conflict = conflictValue === "overwrite" || conflictValue === "rename"
      ? conflictValue
      : "cancel";
    const result = await uploadProjectFiles({ projectId, uploads, conflict });
    const actorUserId = access.user?.id ?? "anonymous";
    for (const event of result.events) {
      broadcastFileEvent({
        type: event.type,
        projectId,
        userId: actorUserId,
        fileId: event.fileId,
        path: event.path,
        isDirectory: event.isDirectory,
      });
    }

    return NextResponse.json({ files: result.files }, { status: 201 });
  } catch (error) {
    if (
      error instanceof ProjectUploadRequestError ||
      error instanceof ProjectFileOperationError
    ) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Error uploading files:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  } finally {
    releaseUpload?.();
  }
}
