import { constants as fsConstants, createReadStream } from "fs";
import fs from "fs/promises";
import path from "path";
import { Readable } from "stream";

import { normalizeProjectTexPath, resolveProjectPath } from "./path-security";
import {
  stageFileWrite,
  stageFileWriteFromStream,
  stagePathMove,
} from "./staged-mutation";
export {
  stageFileWrite,
  stageFileWriteFromStream,
  stagePathMove,
  stagePathRemoval,
  type StagedPathMutation,
} from "./staged-mutation";

const STORAGE_PATH = process.env.STORAGE_PATH || "./data";

const STALE_DOWNLOAD_AGE_MS = 24 * 60 * 60 * 1000;
let lastDownloadPruneAt = 0;

async function pruneStaleDownloadSnapshots(snapshotRoot: string): Promise<void> {
  const now = Date.now();
  if (now - lastDownloadPruneAt < 60 * 60 * 1000) return;
  lastDownloadPruneAt = now;

  const entries = await fs.readdir(snapshotRoot, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory() || !entry.name.startsWith("snapshot-")) return;
      const entryPath = path.join(snapshotRoot, entry.name);
      const stats = await fs.stat(entryPath).catch(() => null);
      if (!stats || now - stats.mtimeMs < STALE_DOWNLOAD_AGE_MS) return;
      await fs.rm(entryPath, { recursive: true, force: true });
    })
  );
}
function inferRepositoryRoot(): string {
  if (process.env.BACKSLASH_ROOT) {
    return path.resolve(process.env.BACKSLASH_ROOT);
  }

  const cwd = process.cwd();
  if (path.basename(cwd) === "web" && path.basename(path.dirname(cwd)) === "apps") {
    return path.resolve(cwd, "../..");
  }
  return cwd;
}

const REPOSITORY_ROOT = inferRepositoryRoot();

export function resolveRuntimePath(value: string, runtimeRoot: string): string {
  return path.isAbsolute(value) ? value : path.resolve(runtimeRoot, value);
}

const TEMPLATES_PATH = resolveRuntimePath(
  process.env.TEMPLATES_PATH || "templates",
  REPOSITORY_ROOT
);

export function getProjectDir(userId: string, projectId: string): string {
  return path.join(STORAGE_PATH, "projects", userId, projectId);
}

export function getPdfPath(
  userId: string,
  projectId: string,
  mainFile: string
): string {
  const normalizedMainFile = normalizeProjectTexPath(mainFile);
  const pdfName = normalizedMainFile.replace(/\.tex$/i, ".pdf");
  return resolveProjectPath(getProjectDir(userId, projectId), pdfName);
}

export function getPdfName(mainFile: string): string {
  return normalizeProjectTexPath(mainFile).replace(/\.tex$/i, ".pdf");
}

export class TextFileTooLargeError extends Error {
  constructor(
    readonly actualBytes: number,
    readonly maxBytes: number
  ) {
    super(`Text file is too large to open (${actualBytes} bytes; max ${maxBytes})`);
    this.name = "TextFileTooLargeError";
  }
}

export async function readFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf-8");
}

export async function readTextFileLimited(
  filePath: string,
  maxBytes: number
): Promise<string> {
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) throw new Error("Requested path is not a file");
  if (stats.size > maxBytes) {
    throw new TextFileTooLargeError(stats.size, maxBytes);
  }

  const content = await fs.readFile(filePath);
  if (content.byteLength > maxBytes) {
    throw new TextFileTooLargeError(content.byteLength, maxBytes);
  }
  return content.toString("utf-8");
}

export async function readFileBinary(filePath: string): Promise<Buffer> {
  return fs.readFile(filePath);
}

interface ByteRange {
  start: number;
  end: number;
}

function parseByteRange(value: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || size <= 0) return null;

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(rawStart);
  const requestedEnd = rawEnd ? Number(rawEnd) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return null;
  }

  return { start, end: Math.min(requestedEnd, size - 1) };
}

export async function createFileResponse(
  filePath: string,
  headers: Record<string, string>,
  request?: Request
): Promise<Response> {
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) throw new Error("Requested path is not a file");

  const size = stats.size;
  const etag = `W/\"${size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}\"`;
  const commonHeaders = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-cache",
    ...headers,
    ETag: etag,
    "Last-Modified": stats.mtime.toUTCString(),
    "X-Content-Type-Options": "nosniff",
  };

  if (!request?.headers.get("range") && request?.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: commonHeaders });
  }

  const rangeHeader = request?.headers.get("range");
  if (rangeHeader) {
    const range = parseByteRange(rangeHeader, size);
    if (!range) {
      return new Response(null, {
        status: 416,
        headers: {
          ...commonHeaders,
          "Content-Range": `bytes */${size}`,
          "Content-Length": "0",
        },
      });
    }

    const stream = createReadStream(filePath, {
      start: range.start,
      end: range.end,
    });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        ...commonHeaders,
        "Content-Length": String(range.end - range.start + 1),
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
      },
    });
  }

  const stream = createReadStream(filePath);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      ...commonHeaders,
      "Content-Length": String(size),
    },
  });
}

export async function writeFile(
  filePath: string,
  content: string
): Promise<void> {
  const mutation = await stageFileWrite(filePath, content);
  await mutation.commit();
}

export async function writeFileBinary(
  filePath: string,
  content: Buffer
): Promise<void> {
  const mutation = await stageFileWrite(filePath, content);
  await mutation.commit();
}

export async function writeFileFromStream(
  filePath: string,
  source: ReadableStream<Uint8Array>
): Promise<void> {
  const mutation = await stageFileWriteFromStream(filePath, source);
  await mutation.commit();
}

export async function renameFile(
  oldPath: string,
  newPath: string
): Promise<void> {
  const mutation = await stagePathMove(oldPath, newPath);
  await mutation.commit();
}

export async function deleteFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function getFileSize(filePath: string): Promise<number> {
  const stats = await fs.stat(filePath);
  return stats.size;
}

export async function createDirectory(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function deleteDirectoryIfEmpty(dirPath: string): Promise<void> {
  try {
    await fs.rmdir(dirPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
      throw error;
    }
  }
}

export async function deleteDirectory(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

export async function listFiles(dirPath: string): Promise<string[]> {
  const entries: string[] = [];

  async function walk(dir: string, prefix: string) {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const relativePath = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        entries.push(relativePath + "/");
        await walk(path.join(dir, item.name), relativePath);
      } else {
        entries.push(relativePath);
      }
    }
  }

  await walk(dirPath, "");
  return entries;
}


async function assertDirectoryTreeHasNoSymlinks(directory: string): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    const stats = await fs.lstat(entryPath);
    if (stats.isSymbolicLink()) {
      throw new Error("Project contains a symbolic link");
    }
    if (stats.isDirectory()) {
      await assertDirectoryTreeHasNoSymlinks(entryPath);
    }
  }
}

export interface DirectorySnapshot {
  directory: string;
  cleanup(): Promise<void>;
}

export async function createDirectorySnapshot(
  sourceDirectory: string
): Promise<DirectorySnapshot> {
  const snapshotRoot = path.join(STORAGE_PATH, ".downloads");
  await fs.mkdir(snapshotRoot, { recursive: true });
  await pruneStaleDownloadSnapshots(snapshotRoot);
  const workspace = await fs.mkdtemp(path.join(snapshotRoot, "snapshot-"));
  const snapshotDirectory = path.join(workspace, "project");

  try {
    const stats = await fs.stat(sourceDirectory);
    if (!stats.isDirectory()) throw new Error("Snapshot source is not a directory");
    await assertDirectoryTreeHasNoSymlinks(sourceDirectory);
    await fs.cp(sourceDirectory, snapshotDirectory, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  } catch (error) {
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  let cleaned = false;
  return {
    directory: snapshotDirectory,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await fs.rm(workspace, { recursive: true, force: true });
    },
  };
}

export async function copyTemplate(
  templateName: string,
  destDir: string
): Promise<string[]> {
  const templateDir = path.join(TEMPLATES_PATH, templateName);
  const copiedFiles: string[] = [];

  if (!(await fileExists(templateDir))) {
    throw new Error(`Template '${templateName}' not found`);
  }

  await createDirectory(destDir);

  async function copyDir(src: string, dest: string, prefix: string) {
    const entries = await fs.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isSymbolicLink()) {
        throw new Error(`Template contains a symbolic link: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        await fs.mkdir(destPath, { recursive: true });
        await copyDir(srcPath, destPath, relativePath);
      } else if (entry.isFile()) {
        await fs.copyFile(srcPath, destPath, fsConstants.COPYFILE_EXCL);
        copiedFiles.push(relativePath);
      } else {
        throw new Error(`Template contains an unsupported entry: ${relativePath}`);
      }
    }
  }

  await copyDir(templateDir, destDir, "");
  return copiedFiles;
}
