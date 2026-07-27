import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { initializeSqliteSchema } from "../../apps/web/src/lib/db/sqlite-schema";

function migrationVersions(database: DatabaseSync): string[] {
  return (
    database
      .prepare(
        "SELECT version FROM __backslash_schema_migrations ORDER BY version"
      )
      .all() as Array<{ version: string }>
  ).map((row) => row.version);
}

describe("initializeSqliteSchema", () => {
  it("creates the current schema and records migrations idempotently", () => {
    const database = new DatabaseSync(":memory:");
    try {
      expect(initializeSqliteSchema(database)).toBe(true);
      expect(initializeSqliteSchema(database)).toBe(false);

      const tables = (
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name);

      expect(tables).toEqual(
        expect.arrayContaining([
          "users",
          "projects",
          "builds",
          "user_ai_settings",
          "password_reset_tokens",
        ])
      );
      expect(migrationVersions(database)).toEqual(["1", "2", "3", "4", "5"]);
    } finally {
      database.close();
    }
  });

  it("allows different users to reuse the same label name", () => {
    const database = new DatabaseSync(":memory:");
    try {
      initializeSqliteSchema(database);
      const now = new Date().toISOString();
      const insertUser = database.prepare(
        "INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      );
      insertUser.run("u1", "u1@example.test", "U1", "hash", now, now);
      insertUser.run("u2", "u2@example.test", "U2", "hash", now, now);

      const insertLabel = database.prepare(
        "INSERT INTO labels (id, name, user_id, created_at) VALUES (?, ?, ?, ?)"
      );
      insertLabel.run("l1", "research", "u1", now);
      insertLabel.run("l2", "research", "u2", now);

      const count = database
        .prepare("SELECT COUNT(*) AS count FROM labels WHERE name = ?")
        .get("research") as { count: number };
      expect(count.count).toBe(2);
    } finally {
      database.close();
    }
  });

  it("upgrades a legacy database that lacks later tables", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(
        "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
      );
      database.exec(
        "CREATE TABLE projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT '', engine TEXT DEFAULT 'auto' NOT NULL, main_file TEXT DEFAULT 'main.tex' NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
      );

      initializeSqliteSchema(database);

      const table = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
        )
        .get("password_reset_tokens") as { name: string } | undefined;
      expect(table?.name).toBe("password_reset_tokens");
    } finally {
      database.close();
    }
  });

  it("normalizes legacy LuaLaTeX projects to XeLaTeX", () => {
    const database = new DatabaseSync(":memory:");
    try {
      initializeSqliteSchema(database);
      const now = new Date().toISOString();
      database
        .prepare(
          "INSERT INTO users (id, email, name, password_hash, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run("u1", "u1@example.test", "U1", "hash", now, now);
      database
        .prepare(
          "INSERT INTO projects (id, user_id, name, description, engine, main_file, created_at, updated_at) " +
            "VALUES (?, ?, ?, '', 'lualatex', 'main.tex', ?, ?)"
        )
        .run("p1", "u1", "Legacy", now, now);
      database
        .prepare("DELETE FROM __backslash_schema_migrations WHERE version = '5'")
        .run();

      initializeSqliteSchema(database);

      expect(
        database.prepare("SELECT engine FROM projects WHERE id = 'p1'").get()
      ).toEqual({ engine: "xelatex" });
    } finally {
      database.close();
    }
  });

  it("rolls back a failed migration transaction", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(
        "CREATE TABLE labels (id TEXT PRIMARY KEY, name TEXT NOT NULL, user_id TEXT NOT NULL, created_at TEXT NOT NULL)"
      );
      database.exec(
        "CREATE INDEX labels_name_idx ON labels(name)"
      );
      database.exec(
        "CREATE TABLE __backslash_schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
      );
      database.exec(
        "INSERT INTO __backslash_schema_migrations VALUES ('1', 'now'), ('2', 'now'), ('3', 'now')"
      );
      database.exec(
        "INSERT INTO labels VALUES ('1', 'duplicate', 'u1', 'now'), ('2', 'duplicate', 'u1', 'now')"
      );

      expect(() => initializeSqliteSchema(database)).toThrow();
      expect(migrationVersions(database)).toEqual(["1", "2", "3"]);
      const oldIndex = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'labels_name_idx'"
        )
        .get();
      expect(oldIndex).toBeTruthy();
    } finally {
      database.close();
    }
  });
});
