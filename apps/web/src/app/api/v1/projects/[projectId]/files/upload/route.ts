import { withApiKey } from "@/lib/auth/apikey";
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

// POST /api/v1/projects/[projectId]/files/upload
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  return withApiKey(request, async (req, user) => {
    let releaseUpload: (() => void) | null = null;
    try {
      const { projectId } = await params;
      const rateLimited = enforceRateLimit(req, "api:project-upload", {
        limit: 20,
        windowMs: 60_000,
        identifier: user.id,
      });
      if (rateLimited) return rateLimited;

      releaseUpload = tryAcquireUploadTask();
      if (!releaseUpload) {
        return NextResponse.json(
          { error: "Upload capacity is busy. Retry shortly." },
          { status: 503, headers: { "Retry-After": "2" } }
        );
      }

      const uploads = await parseProjectUploadRequest(req);
      const result = await uploadProjectFiles({
        projectId,
        uploads,
        expectedOwnerUserId: user.id,
      });
      for (const event of result.events) {
        broadcastFileEvent({
          type: event.type,
          projectId,
          userId: user.id,
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
      console.error("[API v1] Upload error:", error);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    } finally {
      releaseUpload?.();
    }
  });
}
