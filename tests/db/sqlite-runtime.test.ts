import fs from "fs/promises";
import os from "os";
import path from "path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

const temporaryDirectories: string[] = [];

async function loadRuntimeDatabase(databasePath: string) {
  vi.resetModules();
  process.env.SQLITE_PATH = databasePath;
  return import("../../apps/web/src/lib/db");
}

afterEach(async () => {
  delete process.env.SQLITE_PATH;
  delete process.env.SQLITE_BUSY_TIMEOUT_MS;
  delete process.env.SQLITE_WAL_AUTOCHECKPOINT_PAGES;
  delete (globalThis as Record<string, unknown>).__backslashSqliteState__;
  delete (globalThis as Record<string, unknown>).__backslashSqliteInitialization__;
  delete (globalThis as Record<string, unknown>)
    .__backslashSqliteSignalHandlersRegistered__;

  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe("SQLite runtime initialization", () => {
  it("persists Drizzle writes directly and reopens the same SQLite file", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "backslash-db-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "backslash.db");
    const first = await loadRuntimeDatabase(databasePath);

    first.db.run(sql`
      INSERT INTO users (id, email, name, password_hash, created_at, updated_at)
      VALUES (${"user-1"}, ${"user@example.com"}, ${"User"}, ${"hash"}, ${"now"}, ${"now"})
    `);
    await first.flushDatabase();
    await first.closeDatabase();

    const second = await loadRuntimeDatabase(databasePath);
    const users = second.db.all(sql`SELECT email FROM users`);

    expect(users).toEqual([{ email: "user@example.com" }]);
    await second.closeDatabase();
  });

  it("enables WAL and foreign-key enforcement", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "backslash-db-"));
    temporaryDirectories.push(directory);
    const runtime = await loadRuntimeDatabase(path.join(directory, "backslash.db"));

    expect(runtime.db.get(sql`PRAGMA journal_mode`)).toMatchObject({
      journal_mode: "wal",
    });
    expect(runtime.db.get(sql`PRAGMA foreign_keys`)).toMatchObject({
      foreign_keys: 1,
    });
    await runtime.closeDatabase();
  });

  it("enforces the per-user project quota inside the write transaction", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "backslash-db-"));
    temporaryDirectories.push(directory);
    const runtime = await loadRuntimeDatabase(path.join(directory, "backslash.db"));
    const mutations = await import(
      "../../apps/web/src/lib/db/project-file-mutations"
    );
    const now = new Date().toISOString();

    runtime.db.run(sql`
      INSERT INTO users (id, email, name, password_hash, created_at, updated_at)
      VALUES (${"quota-user"}, ${"quota@example.com"}, ${"Quota"}, ${"hash"}, ${now}, ${now})
    `);

    const create = (id: string) =>
      mutations.createProjectWithFiles({
        maxProjectsPerUser: 1,
        project: {
          id,
          userId: "quota-user",
          name: id,
          description: "",
          engine: "auto",
          mainFile: "main.tex",
          createdAt: now,
          updatedAt: now,
        },
        files: [
          {
            id: `${id}-main`,
            path: "main.tex",
            mimeType: "text/x-tex",
            sizeBytes: 0,
            isDirectory: false,
          },
        ],
      });

    create("project-1");
    expect(() => create("project-2")).toThrow(
      mutations.ProjectQuotaExceededError
    );
    expect(
      runtime.db.get(sql`
        SELECT COUNT(*) AS count FROM projects WHERE user_id = ${"quota-user"}
      `)
    ).toEqual({ count: 1 });
    await runtime.closeDatabase();
  });

  it("caps active sessions and atomically resets passwords", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "backslash-db-"));
    temporaryDirectories.push(directory);
    const runtime = await loadRuntimeDatabase(path.join(directory, "backslash.db"));
    const mutations = await import("../../apps/web/src/lib/db/auth-mutations");
    const now = new Date().toISOString();

    runtime.db.run(sql`
      INSERT INTO users (id, email, name, password_hash, created_at, updated_at)
      VALUES (${"auth-user"}, ${"auth@example.com"}, ${"Auth"}, ${"old-hash"}, ${now}, ${now})
    `);

    for (const token of ["s1", "s2", "s3"]) {
      mutations.createSessionRecord({
        userId: "auth-user",
        sessionToken: token,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        createdAt: new Date(Date.now() + Number(token.slice(1))).toISOString(),
        maxSessionsPerUser: 2,
      });
    }

    expect(
      runtime.db.all(sql`
        SELECT token FROM sessions WHERE user_id = ${"auth-user"} ORDER BY token
      `)
    ).toEqual([{ token: "s2" }, { token: "s3" }]);

    mutations.createPasswordResetRecord({
      userId: "auth-user",
      tokenHash: "reset-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: now,
    });
    mutations.createPasswordResetRecord({
      userId: "auth-user",
      tokenHash: "reset-2",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: now,
    });

    expect(runtime.db.all(sql`SELECT token_hash FROM password_reset_tokens`)).toEqual([
      { token_hash: "reset-2" },
    ]);
    expect(
      mutations.isPasswordResetTokenUsableRecord({
        tokenHash: "reset-2",
        now,
      })
    ).toBe(true);

    expect(
      mutations.resetPasswordWithTokenRecord({
        tokenHash: "reset-2",
        passwordHash: "new-hash",
        now,
      })
    ).toEqual({ userId: "auth-user", userEmail: "auth@example.com" });
    expect(
      runtime.db.get(sql`
        SELECT password_hash FROM users WHERE id = ${"auth-user"}
      `)
    ).toEqual({ password_hash: "new-hash" });
    expect(
      runtime.db.all(sql`
        SELECT token FROM sessions WHERE user_id = ${"auth-user"}
      `)
    ).toEqual([]);
    expect(
      mutations.isPasswordResetTokenUsableRecord({
        tokenHash: "reset-2",
        now,
      })
    ).toBe(false);
    expect(
      mutations.resetPasswordWithTokenRecord({
        tokenHash: "reset-2",
        passwordHash: "second-hash",
        now,
      })
    ).toBeNull();
    await runtime.closeDatabase();
  });
});
