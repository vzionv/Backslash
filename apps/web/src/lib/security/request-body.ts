import type { NextRequest } from "next/server";

export class RequestBodyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 415
  ) {
    super(message);
    this.name = "RequestBodyError";
  }
}

export const MAX_SMALL_JSON_BODY_BYTES = 64 * 1024;
export const MAX_SETTINGS_JSON_BODY_BYTES = 256 * 1024;

export type JsonBodyResult =
  | { ok: true; body: unknown }
  | { ok: false; error: string; status: 400 | 413 | 415 };

export async function readJsonBodyResult(
  request: NextRequest,
  maxBytes: number
): Promise<JsonBodyResult> {
  try {
    return { ok: true, body: await readJsonBody(request, maxBytes) };
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return { ok: false, error: error.message, status: error.status };
    }
    throw error;
  }
}

function validateDeclaredLength(
  contentLength: string | null,
  maxBytes: number
): void {
  if (!contentLength) return;
  const parsed = Number(contentLength);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RequestBodyError("Invalid Content-Length", 400);
  }
  if (parsed > maxBytes) {
    throw new RequestBodyError(
      `Request body too large (max ${maxBytes} bytes)`,
      413
    );
  }
}

/**
 * Read and parse a JSON request while enforcing the byte limit during streaming.
 * This also protects chunked requests that omit Content-Length.
 */
export async function readJsonBody(
  request: NextRequest,
  maxBytes: number
): Promise<unknown> {
  const contentType = request.headers.get("content-type") || "";
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
    throw new RequestBodyError("Content-Type must be application/json", 415);
  }
  validateDeclaredLength(request.headers.get("content-length"), maxBytes);

  if (!request.body) {
    throw new RequestBodyError("Request body is required", 400);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("request body limit exceeded").catch(() => undefined);
        throw new RequestBodyError(
          `Request body too large (max ${maxBytes} bytes)`,
          413
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    throw new RequestBodyError("Request body is required", 400);
  }

  const body = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
    totalBytes
  ).toString("utf-8");

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new RequestBodyError("Invalid JSON", 400);
  }
}
