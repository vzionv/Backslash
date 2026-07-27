import { afterEach, describe, expect, it } from "vitest";
import { tryAcquireCleanTask } from "../../apps/web/src/lib/compiler/clean-task-limit";

const state = globalThis as typeof globalThis & {
  __backslash_clean_task_state__?: { active: number };
};

afterEach(() => {
  delete state.__backslash_clean_task_state__;
  delete process.env.MAX_CONCURRENT_CLEAN_TASKS;
});

describe("clean task concurrency guard", () => {
  it("limits concurrent clean processes and releases slots idempotently", () => {
    process.env.MAX_CONCURRENT_CLEAN_TASKS = "1";
    const release = tryAcquireCleanTask();
    expect(release).toBeTypeOf("function");
    expect(tryAcquireCleanTask()).toBeNull();

    release?.();
    release?.();
    expect(tryAcquireCleanTask()).toBeTypeOf("function");
  });
});
