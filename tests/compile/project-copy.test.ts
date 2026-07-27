import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { copyProjectForCompilation } from "../../apps/web/src/lib/compiler/project-copy";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe("copyProjectForCompilation", () => {
  it("copies a regular nested project tree", async () => {
    const sourceDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "backslash-project-source-")
    );
    const destinationDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "backslash-project-destination-")
    );
    temporaryDirectories.push(sourceDirectory, destinationDirectory);
    await fs.mkdir(path.join(sourceDirectory, "chapters"));
    await fs.writeFile(path.join(sourceDirectory, "chapters", "intro.tex"), "Text");

    await copyProjectForCompilation(sourceDirectory, destinationDirectory);

    await expect(
      fs.readFile(path.join(destinationDirectory, "chapters", "intro.tex"), "utf-8")
    ).resolves.toBe("Text");
  });

  it("rejects a source project containing a junction", async () => {
    const sourceDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "backslash-project-source-")
    );
    const destinationDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "backslash-project-destination-")
    );
    const externalDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "backslash-project-external-")
    );
    temporaryDirectories.push(sourceDirectory, destinationDirectory, externalDirectory);
    await fs.symlink(externalDirectory, path.join(sourceDirectory, "chapters"), "junction");

    await expect(
      copyProjectForCompilation(sourceDirectory, destinationDirectory)
    ).rejects.toThrow("outside project root");
  });
});
