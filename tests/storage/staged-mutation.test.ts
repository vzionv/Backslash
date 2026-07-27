import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "backslash-storage-"));
  vi.stubEnv("STORAGE_PATH", root);
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe("staged filesystem mutations", () => {
  it("restores the original file when a replacement is rolled back", async () => {
    const { stageFileWrite } = await import(
      "../../apps/web/src/lib/storage/staged-mutation"
    );
    const target = path.join(root, "project", "main.tex");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "old");

    const mutation = await stageFileWrite(target, "new");
    expect(await fs.readFile(target, "utf8")).toBe("new");
    expect(
      (await fs.readdir(path.dirname(target))).some((name) => name.endsWith(".write"))
    ).toBe(false);
    await mutation.rollback();
    expect(await fs.readFile(target, "utf8")).toBe("old");
  });

  it("commits a replacement and removes its backup", async () => {
    const { stageFileWrite } = await import(
      "../../apps/web/src/lib/storage/staged-mutation"
    );
    const target = path.join(root, "project", "main.tex");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "old");

    const mutation = await stageFileWrite(target, "new");
    await mutation.commit();
    expect(await fs.readFile(target, "utf8")).toBe("new");
    expect(await fs.readdir(path.join(root, ".mutations"))).toEqual([]);
  });

  it("can roll back a recursive removal", async () => {
    const { stagePathRemoval } = await import(
      "../../apps/web/src/lib/storage/staged-mutation"
    );
    const directory = path.join(root, "project", "chapters");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "one.tex"), "test");

    const mutation = await stagePathRemoval(directory);
    await expect(fs.access(directory)).rejects.toThrow();
    await mutation.rollback();
    expect(await fs.readFile(path.join(directory, "one.tex"), "utf8")).toBe("test");
  });

  it("does not overwrite an untracked destination during a move", async () => {
    const { stagePathMove } = await import(
      "../../apps/web/src/lib/storage/staged-mutation"
    );
    const oldPath = path.join(root, "project", "old.tex");
    const newPath = path.join(root, "project", "new.tex");
    await fs.mkdir(path.dirname(oldPath), { recursive: true });
    await fs.writeFile(oldPath, "old");
    await fs.writeFile(newPath, "existing");

    await expect(stagePathMove(oldPath, newPath)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await fs.readFile(oldPath, "utf8")).toBe("old");
    expect(await fs.readFile(newPath, "utf8")).toBe("existing");
  });
});
