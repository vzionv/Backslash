import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertProjectPathHasNoSymlink,
  buildUploadPlan,
  normalizeProjectTexPath,
  resolveProjectPath,
} from "../../apps/web/src/lib/storage/path-security";
import {
  createProjectSchema,
  updateProjectSchema,
} from "../../apps/web/src/lib/utils/validation";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe("resolveProjectPath", () => {
  const projectRoot = path.resolve("test-project");

  it.each([
    "../../outside.tex",
    "nested/../../outside.tex",
    "..\\outside.tex",
    "/outside.tex",
    "C:\\outside.tex",
    "C:outside.tex",
    "nested/../C:\\outside.tex",
    ".private/main.tex",
    "nested/.private/main.tex",
    "main.tex\nspoof",
    "trailing-space /main.tex",
    "aux.tex",
    "folder/con.txt",
    "bad:name.tex",
  ])("rejects unsafe path %s", (candidate) => {
    expect(() => resolveProjectPath(projectRoot, candidate)).toThrow(
      "outside project root"
    );
  });

  it("resolves an allowed nested path within the project root", () => {
    expect(resolveProjectPath(projectRoot, "chapters/intro.tex")).toBe(
      path.join(projectRoot, "chapters", "intro.tex")
    );
  });

  it("canonicalizes a harmless trailing slash", () => {
    expect(resolveProjectPath(projectRoot, "chapters/")).toBe(
      path.join(projectRoot, "chapters")
    );
  });
});

describe("normalizeProjectTexPath", () => {
  it.each(["../../backslash.db", "notes.txt", "main.pdf", "", "-eunsafe.tex"])(
    "rejects an unsafe or non-TeX main file %s",
    (candidate) => {
      expect(() => normalizeProjectTexPath(candidate)).toThrow();
    }
  );

  it("normalizes a nested TeX main file", () => {
    expect(normalizeProjectTexPath("chapters\\main.tex")).toBe(
      "chapters/main.tex"
    );
  });
});

describe("assertProjectPathHasNoSymlink", () => {
  it("rejects a symlinked parent directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "backslash-path-"));
    const external = await fs.mkdtemp(path.join(os.tmpdir(), "backslash-external-"));
    temporaryDirectories.push(root, external);
    await fs.symlink(external, path.join(root, "chapters"), "junction");

    await expect(
      assertProjectPathHasNoSymlink(root, "chapters/intro.tex")
    ).rejects.toThrow("outside project root");
  });
});

describe("updateProjectSchema", () => {
  it("rejects unsafe or non-TeX main file paths", () => {
    expect(updateProjectSchema.safeParse({ mainFile: "../../backslash.db" }).success).toBe(false);
    expect(updateProjectSchema.safeParse({ mainFile: "notes.txt" }).success).toBe(false);
  });

  it("accepts a project-relative TeX main file", () => {
    expect(
      updateProjectSchema.safeParse({ mainFile: "chapters/main.tex" }).success
    ).toBe(true);
  });

  it("trims project metadata and rejects whitespace-only names", () => {
    expect(createProjectSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(
      createProjectSchema.parse({ name: "  Thesis  ", description: "  Draft  " })
    ).toMatchObject({ name: "Thesis", description: "Draft" });
  });

  it("rejects LuaLaTeX project settings without an OS sandbox", () => {
    expect(createProjectSchema.safeParse({ name: "Unsafe", engine: "lualatex" }).success)
      .toBe(false);
    expect(updateProjectSchema.safeParse({ engine: "lualatex" }).success).toBe(false);
  });
});

describe("buildUploadPlan", () => {
  it("validates every file and parent path before returning directories", () => {
    expect(() =>
      buildUploadPlan(["chapters/intro.tex", "../../outside.tex"])
    ).toThrow("outside project root");
  });

  it("derives normalized parent directories for valid uploads", () => {
    expect(buildUploadPlan(["chapters/intro.tex", "figures/chart.jpg"])).toEqual({
      filePaths: ["chapters/intro.tex", "figures/chart.jpg"],
      directoryPaths: ["chapters", "figures"],
    });
  });
});
