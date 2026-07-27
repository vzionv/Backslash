import fs from "fs/promises";
import path from "path";

async function assertNoSymbolicLinks(directory: string): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    const stats = await fs.lstat(entryPath);
    if (stats.isSymbolicLink()) {
      throw new Error("outside project root");
    }
    if (stats.isDirectory()) {
      await assertNoSymbolicLinks(entryPath);
    }
  }
}

export async function copyProjectForCompilation(
  sourceDirectory: string,
  destinationDirectory: string
): Promise<void> {
  await assertNoSymbolicLinks(sourceDirectory);
  await fs.cp(sourceDirectory, destinationDirectory, {
    recursive: true,
    force: true,
  });
}
