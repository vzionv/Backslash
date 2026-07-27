function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export const MAX_ASYNC_COMPILE_SOURCE_BYTES = readPositiveInteger(
  "ASYNC_COMPILE_SOURCE_MAX_BYTES",
  5 * 1024 * 1024
);

export const MAX_ASYNC_COMPILE_REQUEST_OVERHEAD_BYTES = readPositiveInteger(
  "ASYNC_COMPILE_REQUEST_OVERHEAD_BYTES",
  1024 * 1024
);

/** Base64 is ~33% larger than the PDF and requires both forms in memory. */
export const MAX_ASYNC_COMPILE_BASE64_PDF_BYTES = readPositiveInteger(
  "ASYNC_COMPILE_BASE64_PDF_MAX_BYTES",
  10 * 1024 * 1024
);
