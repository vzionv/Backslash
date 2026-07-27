import { afterEach, describe, expect, it, vi } from "vitest";

const SQLITE_STATE_KEY = "__backslashSqliteState__";
const SQLITE_INITIALIZATION_KEY = "__backslashSqliteInitialization__";

afterEach(async () => {
  const { shutdownRunner } = await import(
    "../../apps/web/src/lib/compiler/runner"
  );
  await shutdownRunner();
  delete (globalThis as Record<string, unknown>)[SQLITE_STATE_KEY];
  delete (globalThis as Record<string, unknown>)[SQLITE_INITIALIZATION_KEY];
  vi.resetModules();
});

describe("CompileRunner", () => {
  it("starts without initializing the SQLite runtime", async () => {
    delete (globalThis as Record<string, unknown>)[SQLITE_STATE_KEY];
    delete (globalThis as Record<string, unknown>)[SQLITE_INITIALIZATION_KEY];
    vi.resetModules();

    const { startCompileRunner } = await import(
      "../../apps/web/src/lib/compiler/runner"
    );
    startCompileRunner();

    expect((globalThis as Record<string, unknown>)[SQLITE_STATE_KEY]).toBeUndefined();
    expect(
      (globalThis as Record<string, unknown>)[SQLITE_INITIALIZATION_KEY]
    ).toBeUndefined();
  });
});
