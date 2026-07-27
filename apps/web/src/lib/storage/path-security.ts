import fs from "fs/promises";
import path from "path";

import { ALLOWED_EXTENSIONS, LIMITS } from "@backslash/shared";

export interface UploadPlan {
  filePaths: string[];
  directoryPaths: string[];
}

function rejectUnsafePath(): never {
  throw new Error("outside project root");
}

export function normalizeProjectRelativePath(filePath: string): string {
  if (!filePath || filePath.includes("\0")) rejectUnsafePath();

  if (
    path.isAbsolute(filePath) ||
    path.win32.isAbsolute(filePath) ||
    /^[A-Za-z]:/.test(filePath)
  ) {
    rejectUnsafePath();
  }

  const normalized = path.posix
    .normalize(filePath.replace(/\\/g, "/"))
    .replace(/\/+$/, "");
  const parts = normalized.split("/");
  const windowsReservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  if (
    normalized === "" ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    parts.some(
      (part) =>
        part === "" ||
        part.startsWith(".") ||
        part !== part.trim() ||
        /[<>:"|?*\u0000-\u001f]/.test(part) ||
        part.endsWith(".") ||
        windowsReservedName.test(part)
    )
  ) {
    rejectUnsafePath();
  }

  if (normalized.length > LIMITS.MAX_PATH_LENGTH) {
    throw new Error("Path too long");
  }

  const extension = path.posix.extname(normalized).toLowerCase();
  if (extension && !ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error(`File type '${extension}' not allowed`);
  }

  return normalized;
}

export function normalizeProjectTexPath(mainFile: string): string {
  const normalized = normalizeProjectRelativePath(mainFile);
  if (normalized.startsWith("-")) {
    throw new Error("mainFile must be a project-relative .tex path");
  }
  if (path.posix.extname(normalized).toLowerCase() !== ".tex") {
    throw new Error("mainFile must be a project-relative .tex path");
  }
  return normalized;
}

export function resolveProjectPath(
  projectRoot: string,
  relativePath: string
): string {
  const normalized = normalizeProjectRelativePath(relativePath);
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedPath = path.resolve(resolvedRoot, normalized);
  const relative = path.relative(resolvedRoot, resolvedPath);

  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    rejectUnsafePath();
  }

  return resolvedPath;
}

export async function assertProjectPathHasNoSymlink(
  projectRoot: string,
  relativePath: string
): Promise<void> {
  const normalized = normalizeProjectRelativePath(relativePath);
  const root = path.resolve(projectRoot);
  const parts = normalized.split("/");
  let current = root;

  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stats = await fs.lstat(current);
      if (stats.isSymbolicLink()) rejectUnsafePath();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function buildUploadPlan(filePaths: string[]): UploadPlan {
  const normalizedFilePaths = filePaths.map(normalizeProjectRelativePath);
  const directoryPaths = new Set<string>();

  for (const filePath of normalizedFilePaths) {
    const parts = filePath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directoryPaths.add(parts.slice(0, index).join("/"));
    }
  }

  return {
    filePaths: normalizedFilePaths,
    directoryPaths: [...directoryPaths].sort(),
  };
}
