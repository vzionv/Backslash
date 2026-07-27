import type Database from "better-sqlite3";

interface SqliteMigration {
  version: string;
  apply: (database: Database.Database) => void;
}

const INITIAL_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users(email)",
  "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_idx ON sessions(token)",
  "CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)",
  "CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at)",
  "CREATE TABLE IF NOT EXISTS password_reset_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_hash_idx ON password_reset_tokens(token_hash)",
  "CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens(user_id)",
  "CREATE INDEX IF NOT EXISTS password_reset_tokens_expires_idx ON password_reset_tokens(expires_at)",
  "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT DEFAULT '', engine TEXT DEFAULT 'auto' NOT NULL, main_file TEXT DEFAULT 'main.tex' NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS projects_user_idx ON projects(user_id)",
  "CREATE INDEX IF NOT EXISTS projects_user_updated_idx ON projects(user_id, updated_at)",
  "CREATE TABLE IF NOT EXISTS project_files (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, path TEXT NOT NULL, mime_type TEXT DEFAULT 'text/plain', size_bytes INTEGER DEFAULT 0, is_directory INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS files_project_path_idx ON project_files(project_id, path)",
  "CREATE INDEX IF NOT EXISTS files_project_idx ON project_files(project_id)",
  "CREATE TABLE IF NOT EXISTS labels (id TEXT PRIMARY KEY, name TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS labels_user_name_idx ON labels(user_id, name)",
  "CREATE TABLE IF NOT EXISTS project_labels (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE, created_at TEXT NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS project_labels_unique_idx ON project_labels(project_id, label_id)",
  "CREATE INDEX IF NOT EXISTS project_labels_file_idx ON project_labels(project_id)",
  "CREATE INDEX IF NOT EXISTS project_labels_label_idx ON project_labels(label_id)",
  "CREATE TABLE IF NOT EXISTS builds (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, status TEXT DEFAULT 'queued' NOT NULL, engine TEXT NOT NULL, logs TEXT DEFAULT '', duration_ms INTEGER, pdf_path TEXT, exit_code INTEGER, created_at TEXT NOT NULL, completed_at TEXT)",
  "CREATE INDEX IF NOT EXISTS builds_project_idx ON builds(project_id)",
  "CREATE INDEX IF NOT EXISTS builds_project_created_idx ON builds(project_id, created_at)",
  "CREATE INDEX IF NOT EXISTS builds_user_idx ON builds(user_id)",
  "CREATE INDEX IF NOT EXISTS builds_status_idx ON builds(status)",
  "CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, key_hash TEXT NOT NULL, key_prefix TEXT NOT NULL, last_used_at TEXT, request_count INTEGER DEFAULT 0 NOT NULL, expires_at TEXT, created_at TEXT NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys(key_hash)",
  "CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys(user_id)",
  "CREATE TABLE IF NOT EXISTS user_ai_settings (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, ai_enabled INTEGER DEFAULT 1 NOT NULL, build_provider TEXT DEFAULT 'openai' NOT NULL, build_model TEXT DEFAULT 'gpt-4o-mini' NOT NULL, build_endpoint TEXT, build_api_key TEXT, writer_provider TEXT DEFAULT 'openai' NOT NULL, writer_model TEXT DEFAULT 'gpt-4o-mini' NOT NULL, writer_endpoint TEXT, writer_api_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS user_ai_settings_user_idx ON user_ai_settings(user_id)",
  "CREATE INDEX IF NOT EXISTS user_ai_settings_provider_idx ON user_ai_settings(build_provider, writer_provider)",
  "CREATE TABLE IF NOT EXISTS project_shares (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT DEFAULT 'viewer' NOT NULL, expires_at TEXT, invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS shares_project_user_idx ON project_shares(project_id, user_id)",
  "CREATE INDEX IF NOT EXISTS shares_user_idx ON project_shares(user_id)",
  "CREATE INDEX IF NOT EXISTS shares_project_idx ON project_shares(project_id)",
  "CREATE INDEX IF NOT EXISTS shares_expires_idx ON project_shares(expires_at)",
  "CREATE TABLE IF NOT EXISTS project_public_shares (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, token TEXT NOT NULL, role TEXT DEFAULT 'viewer' NOT NULL, expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS public_shares_project_idx ON project_public_shares(project_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS public_shares_token_idx ON project_public_shares(token)",
  "CREATE INDEX IF NOT EXISTS public_shares_expires_idx ON project_public_shares(expires_at)",
];

function hasTable(database: Database.Database, table: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table)
  );
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQLite identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function hasColumn(
  database: Database.Database,
  table: string,
  column: string
): boolean {
  const rows = database
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all() as Array<{ name?: unknown }>;
  return rows.some((row) => row.name === column);
}

const MIGRATIONS: SqliteMigration[] = [
  {
    version: "1",
    apply(database) {
      for (const statement of INITIAL_SCHEMA) database.exec(statement);
    },
  },
  {
    version: "2",
    apply(database) {
      if (
        hasColumn(database, "user_ai_settings", "id") &&
        !hasColumn(database, "user_ai_settings", "ai_enabled")
      ) {
        database.exec(
          "ALTER TABLE user_ai_settings ADD COLUMN ai_enabled INTEGER DEFAULT 1 NOT NULL"
        );
      }
    },
  },
  {
    version: "3",
    apply(database) {
      database.exec(
        "CREATE INDEX IF NOT EXISTS projects_user_updated_idx ON projects(user_id, updated_at)"
      );
      database.exec(
        "CREATE INDEX IF NOT EXISTS builds_project_created_idx ON builds(project_id, created_at)"
      );
    },
  },
  {
    version: "4",
    apply(database) {
      database.exec("DROP INDEX IF EXISTS labels_name_idx");
      database.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS labels_user_name_idx ON labels(user_id, name)"
      );
    },
  },
  {
    version: "5",
    apply(database) {
      database.exec(
        "CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at)"
      );
      database.exec(
        "CREATE INDEX IF NOT EXISTS password_reset_tokens_expires_idx " +
          "ON password_reset_tokens(expires_at)"
      );
      // Existing LuaLaTeX projects would otherwise retain an engine that is
      // deliberately unavailable in the native unsandboxed runtime.
      database.exec(
        "UPDATE projects SET engine = 'xelatex', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') " +
          "WHERE engine = 'lualatex'"
      );
    },
  },
];

export function initializeSqliteSchema(database: Database.Database): boolean {
  const hasMigrationTable = hasTable(database, "__backslash_schema_migrations");
  const applied = hasMigrationTable
    ? new Set(
        (
          database
            .prepare("SELECT version FROM __backslash_schema_migrations")
            .all() as Array<{ version: string }>
        ).map((row) => String(row.version))
      )
    : new Set<string>();
  const pending = MIGRATIONS.filter(
    (migration) => !applied.has(migration.version)
  );

  if (hasMigrationTable && pending.length === 0) return false;

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(
      "CREATE TABLE IF NOT EXISTS __backslash_schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
    );
    const recordMigration = database.prepare(
      "INSERT INTO __backslash_schema_migrations (version, applied_at) VALUES (?, ?)"
    );

    for (const migration of pending) {
      migration.apply(database);
      recordMigration.run(migration.version, new Date().toISOString());
    }

    database.exec("COMMIT");
    return true;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original migration error.
    }
    throw error;
  }
}
