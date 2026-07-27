export interface ProjectFilePlanEntry {
  id: string;
  path: string;
  isDirectory: boolean | null;
}

export interface ProjectFileRenameUpdate {
  id: string;
  oldPath: string;
  newPath: string;
}

export interface ProjectFileRenamePlan {
  updates: ProjectFileRenameUpdate[];
  nextMainFile: string;
}

export class ProjectFileMutationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectFileMutationConflictError";
  }
}

function pathKey(filePath: string, caseSensitive: boolean): string {
  return caseSensitive ? filePath : filePath.toLocaleLowerCase("en-US");
}

function isSameOrDescendant(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function buildProjectFileRenamePlan(options: {
  files: ProjectFilePlanEntry[];
  fileId: string;
  newPath: string;
  mainFile: string;
  caseSensitive?: boolean;
}): ProjectFileRenamePlan {
  const caseSensitive = options.caseSensitive ?? process.platform !== "win32";
  const target = options.files.find((entry) => entry.id === options.fileId);
  if (!target) {
    throw new ProjectFileMutationConflictError("File not found");
  }

  if (target.path === options.newPath) {
    return { updates: [], nextMainFile: options.mainFile };
  }

  if (
    target.isDirectory &&
    options.newPath.startsWith(`${target.path}/`)
  ) {
    throw new ProjectFileMutationConflictError(
      "A directory cannot be moved inside itself"
    );
  }

  const affected = target.isDirectory
    ? options.files.filter((entry) => isSameOrDescendant(entry.path, target.path))
    : [target];
  const affectedIds = new Set(affected.map((entry) => entry.id));
  const unaffected = options.files.filter((entry) => !affectedIds.has(entry.id));
  const occupied = new Map(
    unaffected.map((entry) => [pathKey(entry.path, caseSensitive), entry])
  );
  const generated = new Set<string>();

  const updates = affected
    .map((entry) => {
      const suffix = entry.path === target.path
        ? ""
        : entry.path.slice(target.path.length + 1);
      const nextPath = suffix ? `${options.newPath}/${suffix}` : options.newPath;
      const key = pathKey(nextPath, caseSensitive);

      if (occupied.has(key) || generated.has(key)) {
        throw new ProjectFileMutationConflictError(
          `A file already exists at '${nextPath}'`
        );
      }
      generated.add(key);

      const parts = nextPath.split("/");
      for (let index = 1; index < parts.length; index += 1) {
        const ancestorPath = parts.slice(0, index).join("/");
        const ancestor = occupied.get(pathKey(ancestorPath, caseSensitive));
        if (ancestor && !ancestor.isDirectory) {
          throw new ProjectFileMutationConflictError(
            `Cannot move beneath file '${ancestor.path}'`
          );
        }
      }

      return { id: entry.id, oldPath: entry.path, newPath: nextPath };
    })
    .sort((left, right) => left.oldPath.length - right.oldPath.length);

  let nextMainFile = options.mainFile;
  if (target.isDirectory) {
    if (isSameOrDescendant(options.mainFile, target.path)) {
      const suffix = options.mainFile === target.path
        ? ""
        : options.mainFile.slice(target.path.length + 1);
      nextMainFile = suffix ? `${options.newPath}/${suffix}` : options.newPath;
    }
  } else if (options.mainFile === target.path) {
    nextMainFile = options.newPath;
  }

  return { updates, nextMainFile };
}

export function selectFallbackMainFile(options: {
  files: ProjectFilePlanEntry[];
  deletedIds: ReadonlySet<string>;
  currentMainFile: string;
  currentWasDeleted?: boolean;
}): string {
  const currentWasDeleted =
    options.currentWasDeleted ??
    options.files.some(
      (entry) =>
        options.deletedIds.has(entry.id) && entry.path === options.currentMainFile
    );
  if (!currentWasDeleted) return options.currentMainFile;

  return (
    options.files
      .filter(
        (entry) =>
          !options.deletedIds.has(entry.id) &&
          !entry.isDirectory &&
          entry.path.toLocaleLowerCase("en-US").endsWith(".tex")
      )
      .sort((left, right) => left.path.localeCompare(right.path))[0]?.path ??
    "main.tex"
  );
}
