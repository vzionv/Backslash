import { afterEach, describe, expect, it } from "vitest";
import { tryAcquireUploadTask } from "../../apps/web/src/lib/storage/upload-task-limit";

const state = globalThis as typeof globalThis & {
  __backslash_upload_task_state__?: { active: number };
};

afterEach(() => {
  delete state.__backslash_upload_task_state__;
  delete process.env.MAX_CONCURRENT_UPLOADS;
});

describe("upload concurrency guard", () => {
  it("bounds buffered multipart requests and releases idempotently", () => {
    process.env.MAX_CONCURRENT_UPLOADS = "1";
    const release = tryAcquireUploadTask();
    expect(release).toBeTypeOf("function");
    expect(tryAcquireUploadTask()).toBeNull();
    release?.();
    release?.();
    expect(tryAcquireUploadTask()).toBeTypeOf("function");
  });
});
