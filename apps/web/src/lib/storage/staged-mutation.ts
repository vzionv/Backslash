import { createWriteStream } from "fs";
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

const STORAGE_PATH = process.env.STORAGE_PATH || "./data";
const MUTATION_STAGING_PATH = path.join(STORAGE_PATH, ".mutations");

const STALE_MUTATION_AGE_MS = 24 * 60 * 60 * 1000;
const MUTATION_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const MUTATION_PRUNE_STATE_KEY = "__backslash_mutation_prune_state__" as const;

type MutationPruneGlobal = typeof globalThis & {
  [MUTATION_PRUNE_STATE_KEY]?: { lastRunAt: number; running?: Promise<void> };
};

async function pruneStaleMutationArtifacts(): Promise<void> {
  const stateRoot = globalThis as MutationPruneGlobal;
  stateRoot[MUTATION_PRUNE_STATE_KEY] ??= { lastRunAt: 0 };
  const state = stateRoot[MUTATION_PRUNE_STATE_KEY];
  const now = Date.now();
  if (state.running) return state.running;
  if (now - state.lastRunAt < MUTATION_PRUNE_INTERVAL_MS) return;

  state.lastRunAt = now;
  state.running = (async () => {
    await fs.mkdir(MUTATION_STAGING_PATH, { recursive: true });
    const entries = await fs.readdir(MUTATION_STAGING_PATH, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(MUTATION_STAGING_PATH, entry.name);
        const stats = await fs.stat(entryPath).catch(() => null);
        if (!stats || now - stats.mtimeMs < STALE_MUTATION_AGE_MS) return;
        await fs.rm(entryPath, { recursive: true, force: true });
      })
    );
  })()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[Storage] Failed to prune stale mutations: ${message}\n`);
    })
    .finally(() => {
      state.running = undefined;
    });

  return state.running;
}

export interface StagedPathMutation {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function prepareReplacement(
  filePath: string,
  writeTemporary: (temporaryPath: string) => Promise<void>
): Promise<StagedPathMutation> {
  await pruneStaleMutationArtifacts();
  const directory = path.dirname(filePath);
  const mutationId = randomUUID();
  const temporaryPath = path.join(MUTATION_STAGING_PATH, `${mutationId}.write`);
  const backupPath = path.join(MUTATION_STAGING_PATH, `${mutationId}.backup`);
  let hadOriginal = false;
  let replacementInstalled = false;

  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(MUTATION_STAGING_PATH, { recursive: true });

  try {
    await writeTemporary(temporaryPath);
    try {
      await fs.rename(filePath, backupPath);
      hadOriginal = true;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    await fs.rename(temporaryPath, filePath);
    replacementInstalled = true;
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    if (replacementInstalled) {
      await fs.rm(filePath, { force: true }).catch(() => undefined);
    }
    if (hadOriginal) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      try {
        await fs.rename(backupPath, filePath);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Failed to install and restore ${filePath}`
        );
      }
    }
    throw error;
  }

  let settled = false;
  return {
    async commit() {
      if (settled) return;
      if (hadOriginal) {
        await fs.rm(backupPath, { force: true });
      }
      settled = true;
    },
    async rollback() {
      if (settled) return;
      await fs.rm(filePath, { force: true }).catch(() => undefined);
      if (hadOriginal) {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.rename(backupPath, filePath);
      }
      settled = true;
    },
  };
}

export async function stageFileWrite(
  filePath: string,
  content: string | Buffer
): Promise<StagedPathMutation> {
  return prepareReplacement(filePath, async (temporaryPath) => {
    if (typeof content === "string") {
      await fs.writeFile(temporaryPath, content, {
        encoding: "utf-8",
        flag: "wx",
      });
    } else {
      await fs.writeFile(temporaryPath, content, { flag: "wx" });
    }
  });
}

async function* streamChunks(
  source: ReadableStream<Uint8Array>
): AsyncGenerator<Uint8Array> {
  const reader = source.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function stageFileWriteFromStream(
  filePath: string,
  source: ReadableStream<Uint8Array>
): Promise<StagedPathMutation> {
  return prepareReplacement(filePath, async (temporaryPath) => {
    await pipeline(
      Readable.from(streamChunks(source)),
      createWriteStream(temporaryPath, { flags: "wx" })
    );
  });
}

export async function stagePathRemoval(
  filePath: string
): Promise<StagedPathMutation> {
  await pruneStaleMutationArtifacts();
  const stagingPath = path.join(
    MUTATION_STAGING_PATH,
    `${randomUUID()}.removed`
  );
  await fs.mkdir(MUTATION_STAGING_PATH, { recursive: true });

  let wasPresent = true;
  try {
    await fs.rename(filePath, stagingPath);
  } catch (error) {
    if (isMissing(error)) {
      wasPresent = false;
    } else {
      throw error;
    }
  }

  let settled = false;
  return {
    async commit() {
      if (settled) return;
      if (wasPresent) {
        await fs.rm(stagingPath, { recursive: true, force: true });
      }
      settled = true;
    },
    async rollback() {
      if (settled) return;
      if (wasPresent) {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.rename(stagingPath, filePath);
      }
      settled = true;
    },
  };
}

export async function stagePathMove(
  oldPath: string,
  newPath: string
): Promise<StagedPathMutation> {
  await pruneStaleMutationArtifacts();
  const stagingPath = path.join(
    MUTATION_STAGING_PATH,
    `${randomUUID()}.moving`
  );
  await fs.mkdir(MUTATION_STAGING_PATH, { recursive: true });
  await fs.rename(oldPath, stagingPath);

  try {
    if (await fileExists(newPath)) {
      const error = new Error("Destination already exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    }
    await fs.mkdir(path.dirname(newPath), { recursive: true });
    await fs.rename(stagingPath, newPath);
  } catch (error) {
    await fs.mkdir(path.dirname(oldPath), { recursive: true });
    try {
      await fs.rename(stagingPath, oldPath);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `Failed to move and restore ${oldPath}`
      );
    }
    throw error;
  }

  let settled = false;
  return {
    async commit() {
      settled = true;
    },
    async rollback() {
      if (settled) return;
      await fs.mkdir(path.dirname(oldPath), { recursive: true });
      await fs.rename(newPath, oldPath);
      settled = true;
    },
  };
}
