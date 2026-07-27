import { describe, expect, it } from "vitest";

import {
  buildProjectFileRenamePlan,
  ProjectFileMutationConflictError,
  selectFallbackMainFile,
} from "../../apps/web/src/lib/storage/project-file-plan";

const files = [
  { id: "dir", path: "chapters", isDirectory: true },
  { id: "one", path: "chapters/one.tex", isDirectory: false },
  { id: "two", path: "chapters/two.tex", isDirectory: false },
  { id: "other", path: "appendix.tex", isDirectory: false },
];

describe("project file mutation plans", () => {
  it("renames a directory tree and moves the main file", () => {
    const plan = buildProjectFileRenamePlan({
      files,
      fileId: "dir",
      newPath: "content",
      mainFile: "chapters/one.tex",
    });

    expect(plan.updates).toEqual([
      { id: "dir", oldPath: "chapters", newPath: "content" },
      { id: "one", oldPath: "chapters/one.tex", newPath: "content/one.tex" },
      { id: "two", oldPath: "chapters/two.tex", newPath: "content/two.tex" },
    ]);
    expect(plan.nextMainFile).toBe("content/one.tex");
  });

  it("rejects moves inside the directory itself", () => {
    expect(() =>
      buildProjectFileRenamePlan({
        files,
        fileId: "dir",
        newPath: "chapters/archive",
        mainFile: "chapters/one.tex",
      })
    ).toThrow(ProjectFileMutationConflictError);
  });

  it("detects descendant collisions before touching disk", () => {
    expect(() =>
      buildProjectFileRenamePlan({
        files: [...files, { id: "collision", path: "content/one.tex", isDirectory: false }],
        fileId: "dir",
        newPath: "content",
        mainFile: "chapters/one.tex",
      })
    ).toThrow("A file already exists at 'content/one.tex'");
  });

  it("uses a deterministic tex fallback after deleting the main file", () => {
    expect(
      selectFallbackMainFile({
        files,
        deletedIds: new Set(["one"]),
        currentMainFile: "chapters/one.tex",
      })
    ).toBe("appendix.tex");
  });
});
