import path from "path";
import { describe, expect, it } from "vitest";
import { resolveRuntimePath } from "../../apps/web/src/lib/storage";

describe("resolveRuntimePath", () => {
  it("resolves a relative path from the runtime root", () => {
    const runtimeRoot = path.resolve("backslash-runtime");

    expect(resolveRuntimePath("templates", runtimeRoot)).toBe(
      path.join(runtimeRoot, "templates")
    );
  });

  it("preserves an absolute path", () => {
    const absolutePath = path.resolve("external-templates");

    expect(resolveRuntimePath(absolutePath, path.resolve("backslash-runtime"))).toBe(
      absolutePath
    );
  });
});
