import { LIMITS } from "@backslash/shared";

export const MAX_UPLOAD_FILE_COUNT = 100;
export const MAX_UPLOAD_BATCH_BYTES = LIMITS.MAX_PROJECT_SIZE;
function readTextContentLimit(): number {
  const raw = process.env.MAX_TEXT_CONTENT_BYTES;
  if (!raw) return 5 * 1024 * 1024;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1024 || parsed > LIMITS.MAX_FILE_SIZE) {
    throw new Error(
      `MAX_TEXT_CONTENT_BYTES must be an integer between 1024 and ${LIMITS.MAX_FILE_SIZE}`
    );
  }
  return parsed;
}

export const MAX_TEXT_CONTENT_BYTES = readTextContentLimit();
export const MAX_MULTIPART_OVERHEAD_BYTES = 2 * 1024 * 1024;

export function validateContentLength(
  contentLength: string | null,
  maxBytes: number
): LimitResult {
  if (!contentLength) return { valid: true };
  const parsed = Number(contentLength);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return { valid: false, error: "Invalid Content-Length", status: 400 };
  }
  if (parsed > maxBytes) {
    return {
      valid: false,
      error: `Request body too large (max ${maxBytes} bytes)`,
      status: 413,
    };
  }
  return { valid: true };
}

interface StoredProjectFile {
  path: string;
  sizeBytes: number;
  isDirectory: boolean;
}

interface PendingProjectFile {
  path: string;
  sizeBytes: number;
}

interface UploadCandidate {
  path: string;
  size: number;
}

interface LimitViolation {
  valid: false;
  error: string;
  status: 400 | 413;
}

interface ValidResult {
  valid: true;
}

type LimitResult = LimitViolation | ValidResult;

export function validateUploadBatch(uploads: UploadCandidate[]): LimitResult {
  if (uploads.length > MAX_UPLOAD_FILE_COUNT) {
    return {
      valid: false,
      error: `Too many files (max ${MAX_UPLOAD_FILE_COUNT})`,
      status: 413,
    };
  }

  const paths = new Set<string>();
  let batchBytes = 0;
  for (const upload of uploads) {
    if (upload.size > LIMITS.MAX_FILE_SIZE) {
      return {
        valid: false,
        error: `File too large (max ${LIMITS.MAX_FILE_SIZE} bytes)`,
        status: 413,
      };
    }
    if (paths.has(upload.path)) {
      return {
        valid: false,
        error: `Duplicate upload path: ${upload.path}`,
        status: 400,
      };
    }
    batchBytes += upload.size;
    if (batchBytes > MAX_UPLOAD_BATCH_BYTES) {
      return {
        valid: false,
        error: `Upload batch too large (max ${MAX_UPLOAD_BATCH_BYTES} bytes)`,
        status: 413,
      };
    }
    paths.add(upload.path);
  }

  return { valid: true };
}

export function validateProjectStorage(
  storedFiles: StoredProjectFile[],
  pendingFiles: PendingProjectFile[]
): LimitResult {
  const replacedPaths = new Set(pendingFiles.map((file) => file.path));
  const existingBytes = storedFiles
    .filter((file) => !file.isDirectory && !replacedPaths.has(file.path))
    .reduce((total, file) => total + file.sizeBytes, 0);
  const pendingBytes = pendingFiles.reduce(
    (total, file) => total + file.sizeBytes,
    0
  );

  if (existingBytes + pendingBytes > LIMITS.MAX_PROJECT_SIZE) {
    return {
      valid: false,
      error: `Project storage limit exceeded (max ${LIMITS.MAX_PROJECT_SIZE} bytes)`,
      status: 413,
    };
  }

  return { valid: true };
}
