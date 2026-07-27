import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDirectorySnapshot,
  createFileResponse,
  readTextFileLimited,
  TextFileTooLargeError,
} from "../../apps/web/src/lib/storage";

let root: string;
let filePath: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "backslash-response-"));
  filePath = path.join(root, "output.pdf");
  await fs.writeFile(filePath, "0123456789");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("streaming file responses", () => {
  it("streams a full file with validators and range support", async () => {
    const response = await createFileResponse(
      filePath,
      { "Content-Type": "application/pdf" },
      new Request("http://localhost/file")
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("10");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("ETag")).toBeTruthy();
    expect(await response.text()).toBe("0123456789");
  });

  it("serves ordinary and suffix byte ranges", async () => {
    const partial = await createFileResponse(
      filePath,
      { "Content-Type": "application/pdf" },
      new Request("http://localhost/file", {
        headers: { Range: "bytes=2-5" },
      })
    );
    expect(partial.status).toBe(206);
    expect(partial.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(await partial.text()).toBe("2345");

    const suffix = await createFileResponse(
      filePath,
      { "Content-Type": "application/pdf" },
      new Request("http://localhost/file", {
        headers: { Range: "bytes=-3" },
      })
    );
    expect(suffix.status).toBe(206);
    expect(await suffix.text()).toBe("789");
  });

  it("returns 416 for invalid ranges and 304 for a matching ETag", async () => {
    const invalid = await createFileResponse(
      filePath,
      { "Content-Type": "application/pdf" },
      new Request("http://localhost/file", {
        headers: { Range: "bytes=20-30" },
      })
    );
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("Content-Range")).toBe("bytes */10");

    const initial = await createFileResponse(
      filePath,
      {},
      new Request("http://localhost/file")
    );
    const notModified = await createFileResponse(
      filePath,
      {},
      new Request("http://localhost/file", {
        headers: { "If-None-Match": initial.headers.get("ETag")! },
      })
    );
    expect(notModified.status).toBe(304);
  });

  it("bounds editable text reads before decoding the whole file", async () => {
    await expect(readTextFileLimited(filePath, 10)).resolves.toBe("0123456789");
    await expect(readTextFileLimited(filePath, 9)).rejects.toBeInstanceOf(
      TextFileTooLargeError
    );
  });

  it("creates an isolated directory snapshot and removes it on cleanup", async () => {
    const source = path.join(root, "project");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "main.tex"), "before");

    const snapshot = await createDirectorySnapshot(source);
    await fs.writeFile(path.join(source, "main.tex"), "after");
    expect(await fs.readFile(path.join(snapshot.directory, "main.tex"), "utf8")).toBe(
      "before"
    );

    const workspace = path.dirname(snapshot.directory);
    await snapshot.cleanup();
    await expect(fs.access(workspace)).rejects.toThrow();
  });
});
