import type { NextRequest } from "next/server";
import { LIMITS } from "@backslash/shared";

import { normalizeProjectRelativePath } from "@/lib/storage/path-security";
import {
  MAX_MULTIPART_OVERHEAD_BYTES,
  MAX_UPLOAD_BATCH_BYTES,
  validateContentLength,
  validateUploadBatch,
} from "@/lib/storage/resource-limits";
import type { ProjectUploadItem } from "@/lib/storage/project-file-operations";

export class ProjectUploadRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 411 | 413
  ) {
    super(message);
    this.name = "ProjectUploadRequestError";
  }
}

export async function parseProjectUploadRequest(
  request: NextRequest
): Promise<ProjectUploadItem[]> {
  const contentLength = request.headers.get("content-length");
  if (!contentLength) {
    throw new ProjectUploadRequestError(
      "Content-Length is required for multipart uploads",
      411
    );
  }

  const bodySize = validateContentLength(
    contentLength,
    MAX_UPLOAD_BATCH_BYTES + MAX_MULTIPART_OVERHEAD_BYTES
  );
  if (!bodySize.valid) {
    throw new ProjectUploadRequestError(bodySize.error, bodySize.status);
  }

  const formData = await request.formData();
  const files = formData.getAll("files");
  const paths = formData.getAll("paths");
  if (files.length === 0) {
    throw new ProjectUploadRequestError("No files provided", 400);
  }

  const uploads: ProjectUploadItem[] = files.map((value, index) => {
    if (!(value instanceof File)) {
      throw new ProjectUploadRequestError("Invalid multipart file", 400);
    }
    if (value.size > LIMITS.MAX_FILE_SIZE) {
      throw new ProjectUploadRequestError(
        `File too large (max ${LIMITS.MAX_FILE_SIZE} bytes)`,
        413
      );
    }

    const suppliedPath = paths[index];
    const rawPath = typeof suppliedPath === "string" && suppliedPath
      ? suppliedPath
      : value.name;
    try {
      return {
        file: value,
        path: normalizeProjectRelativePath(rawPath),
      };
    } catch (error) {
      throw new ProjectUploadRequestError(
        error instanceof Error ? error.message : "Invalid upload path",
        400
      );
    }
  });

  const batchValidation = validateUploadBatch(
    uploads.map((upload) => ({ path: upload.path, size: upload.file.size }))
  );
  if (!batchValidation.valid) {
    throw new ProjectUploadRequestError(
      batchValidation.error,
      batchValidation.status
    );
  }

  return uploads;
}
