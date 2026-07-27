import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFileFromStream } from "../../apps/web/src/lib/storage";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

function createStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("writeFileFromStream", () => {
  it("atomically replaces an existing file after a complete stream", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "backslash-stream-"));
    temporaryDirectories.push(directory);
    const outputPath = path.join(directory, "main.tex");
    await fs.writeFile(outputPath, "old content");

    await writeFileFromStream(
      outputPath,
      createStream([new TextEncoder().encode("new "), new TextEncoder().encode("content")])
    );

    await expect(fs.readFile(outputPath, "utf-8")).resolves.toBe("new content");
  });
});
