import fs from "fs/promises";
import path from "path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema";
import { initializeSqliteSchema } from "./sqlite-schema";

const DATABASE_PATH =
  process.env.SQLITE_PATH ??
  path.join(process.env.STORAGE_PATH ?? "./data", "backslash.db");

interface DatabaseState {
  database: Database.Database;
}

type DatabaseGlobal = typeof globalThis & {
  __backslashSqliteState__?: DatabaseState;
  __backslashSqliteInitialization__?: Promise<DatabaseState>;
  __backslashSqliteSignalHandlersRegistered__?: boolean;
};

const globalState = globalThis as DatabaseGlobal;

function readBoundedInteger(
  name: string,
  fallback: number,
  options: { min: number; max: number }
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < options.min ||
    parsed > options.max
  ) {
    throw new Error(
      `${name} must be an integer between ${options.min} and ${options.max}`
    );
  }
  return parsed;
}

function configureDatabase(database: Database.Database): void {
  const busyTimeoutMs = readBoundedInteger("SQLITE_BUSY_TIMEOUT_MS", 5_000, {
    min: 0,
    max: 60_000,
  });
  const walAutocheckpointPages = readBoundedInteger(
    "SQLITE_WAL_AUTOCHECKPOINT_PAGES",
    1_000,
    { min: 1, max: 100_000 }
  );

  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = NORMAL");
  database.exec("PRAGMA temp_store = MEMORY");
  database.exec(`PRAGMA wal_autocheckpoint = ${walAutocheckpointPages}`);
}

function registerShutdownClose(): void {
  if (globalState.__backslashSqliteSignalHandlersRegistered__) return;

  globalState.__backslashSqliteSignalHandlersRegistered__ = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      const state = globalState.__backslashSqliteState__;
      globalState.__backslashSqliteState__ = undefined;
      globalState.__backslashSqliteInitialization__ = undefined;
      try {
        state?.database.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[DB] Failed to close SQLite: ${message}\n`);
      } finally {
        process.exit(process.exitCode ?? 0);
      }
    });
  }
}

async function initializeDatabase(): Promise<DatabaseState> {
  await fs.mkdir(path.dirname(DATABASE_PATH), { recursive: true });

  const database = new Database(DATABASE_PATH);
  try {
    configureDatabase(database);
    initializeSqliteSchema(database);
    registerShutdownClose();
  } catch (error) {
    database.close();
    throw error;
  }

  const state = { database };
  globalState.__backslashSqliteState__ = state;
  return state;
}

async function getOrCreateDatabase(): Promise<DatabaseState> {
  if (globalState.__backslashSqliteState__) {
    return globalState.__backslashSqliteState__;
  }

  if (!globalState.__backslashSqliteInitialization__) {
    globalState.__backslashSqliteInitialization__ = initializeDatabase().catch(
      (error: unknown) => {
        globalState.__backslashSqliteInitialization__ = undefined;
        throw error;
      }
    );
  }

  return globalState.__backslashSqliteInitialization__;
}

const { database } = await getOrCreateDatabase();
export const db = drizzle({ client: database, schema });

/** Run synchronous SQLite statements atomically on the process-local handle. */
export function withSqliteDatabase<T>(
  operation: (database: Database.Database) => T
): T {
  const result = operation(database);
  if (result instanceof Promise) {
    throw new TypeError("SQLite callbacks must be synchronous");
  }
  return result;
}

export function withSqliteTransaction<T>(
  operation: (database: Database.Database) => T
): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation(database);
    if (result instanceof Promise) {
      throw new TypeError("SQLite transaction callbacks must be synchronous");
    }
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original error; a failed rollback means the connection is
      // already unusable and the next operation will surface that state.
    }
    throw error;
  }
}

/**
 * Force a passive WAL checkpoint. Normal writes are already durable without
 * this call; it exists for operational scripts and deterministic tests.
 */
export async function flushDatabase(): Promise<void> {
  database.exec("PRAGMA wal_checkpoint(PASSIVE)");
}

/** Close the process-local database handle. Intended for tests and shutdown. */
export async function closeDatabase(): Promise<void> {
  const state = globalState.__backslashSqliteState__;
  if (!state) return;

  globalState.__backslashSqliteState__ = undefined;
  globalState.__backslashSqliteInitialization__ = undefined;
  state.database.close();
}
