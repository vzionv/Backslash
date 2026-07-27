import { describe, expect, it } from "vitest";
import {
  MAX_TEXT_CONTENT_BYTES,
  MAX_UPLOAD_BATCH_BYTES,
  MAX_UPLOAD_FILE_COUNT,
  validateContentLength,
  validateProjectStorage,
  validateUploadBatch,
} from "../../apps/web/src/lib/storage/resource-limits";
import { updateFileSchema } from "../../apps/web/src/lib/utils/validation";

describe("validateUploadBatch", () => {
  it("rejects more files than the request limit", () => {
    expect(
      validateUploadBatch(
        Array.from({ length: MAX_UPLOAD_FILE_COUNT + 1 }, (_, index) => ({
          path: `chapter-${index}.tex`,
          size: 1,
        }))
      )
    ).toMatchObject({ status: 413 });
  });

  it("rejects a batch larger than the available project capacity", () => {
    expect(
      validateUploadBatch([{ path: "main.tex", size: 101 * 1024 * 1024 }])
    ).toMatchObject({ status: 413 });
  });

  it("rejects a request whose aggregate file sizes exceed the batch limit", () => {
    expect(
      validateUploadBatch([
        { path: "first.tex", size: MAX_UPLOAD_BATCH_BYTES / 2 + 1 },
        { path: "second.tex", size: MAX_UPLOAD_BATCH_BYTES / 2 },
      ])
    ).toMatchObject({ status: 413 });
  });

  it("rejects duplicate normalized paths", () => {
    expect(
      validateUploadBatch([
        { path: "chapters/main.tex", size: 1 },
        { path: "chapters/main.tex", size: 1 },
      ])
    ).toMatchObject({ status: 400 });
  });
});

describe("updateFileSchema", () => {
  it("rejects text content beyond the file limit", () => {
    expect(
      updateFileSchema.safeParse({ content: "x".repeat(MAX_TEXT_CONTENT_BYTES + 1) })
        .success
    ).toBe(false);
  });
});

describe("validateProjectStorage", () => {
  it("accounts for replaced files when checking the project cap", () => {
    expect(
      validateProjectStorage(
        [
          { path: "main.tex", sizeBytes: 80 * 1024 * 1024, isDirectory: false },
          { path: "image.png", sizeBytes: 15 * 1024 * 1024, isDirectory: false },
        ],
        [{ path: "main.tex", sizeBytes: 10 * 1024 * 1024 }]
      )
    ).toEqual({ valid: true });
  });

  it("rejects updates that exceed the project cap", () => {
    expect(
      validateProjectStorage(
        [{ path: "main.tex", sizeBytes: 99 * 1024 * 1024, isDirectory: false }],
        [{ path: "image.png", sizeBytes: 2 * 1024 * 1024 }]
      )
    ).toMatchObject({ status: 413 });
  });
});


describe("validateContentLength", () => {
  it("accepts a missing or bounded content length", () => {
    expect(validateContentLength(null, 100)).toEqual({ valid: true });
    expect(validateContentLength("100", 100)).toEqual({ valid: true });
  });

  it("rejects malformed and oversized content lengths", () => {
    expect(validateContentLength("not-a-number", 100)).toMatchObject({ status: 400 });
    expect(validateContentLength("101", 100)).toMatchObject({ status: 413 });
  });
});
