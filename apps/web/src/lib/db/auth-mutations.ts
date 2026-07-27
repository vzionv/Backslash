import { randomUUID } from "crypto";

import { withSqliteDatabase, withSqliteTransaction } from "@/lib/db";

function assertSingleChange(changes: number | bigint, operation: string): void {
  if (Number(changes) !== 1) {
    throw new Error(`${operation} affected ${changes.toString()} rows`);
  }
}

export function createSessionRecord(options: {
  userId: string;
  sessionToken: string;
  expiresAt: string;
  createdAt: string;
  maxSessionsPerUser: number;
}): void {
  withSqliteTransaction((database) => {
    database
      .prepare("DELETE FROM sessions WHERE expires_at <= ?")
      .run(options.createdAt);

    const result = database
      .prepare(
        "INSERT INTO sessions (id, user_id, token, expires_at, created_at) " +
          "VALUES (?, ?, ?, ?, ?)"
      )
      .run(
        randomUUID(),
        options.userId,
        options.sessionToken,
        options.expiresAt,
        options.createdAt
      );
    assertSingleChange(result.changes, "session creation");

    database
      .prepare(
        "DELETE FROM sessions WHERE user_id = ? AND token <> ? AND id IN (" +
          "SELECT id FROM sessions WHERE user_id = ? AND token <> ? " +
          "ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?" +
          ")"
      )
      .run(
        options.userId,
        options.sessionToken,
        options.userId,
        options.sessionToken,
        Math.max(0, options.maxSessionsPerUser - 1)
      );
  });
}

export function createPasswordResetRecord(options: {
  userId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}): void {
  withSqliteTransaction((database) => {
    // A user only needs one live reset link. Invalidating older links also
    // prevents unbounded token accumulation under repeated requests.
    database
      .prepare("DELETE FROM password_reset_tokens WHERE user_id = ?")
      .run(options.userId);
    database
      .prepare("DELETE FROM password_reset_tokens WHERE expires_at <= ?")
      .run(options.createdAt);

    const result = database
      .prepare(
        "INSERT INTO password_reset_tokens " +
          "(id, user_id, token_hash, expires_at, used_at, created_at) " +
          "VALUES (?, ?, ?, ?, NULL, ?)"
      )
      .run(
        randomUUID(),
        options.userId,
        options.tokenHash,
        options.expiresAt,
        options.createdAt
      );
    assertSingleChange(result.changes, "password reset token creation");
  });
}

export function isPasswordResetTokenUsableRecord(options: {
  tokenHash: string;
  now: string;
}): boolean {
  return withSqliteDatabase((database) =>
    Boolean(
      database
        .prepare(
          "SELECT 1 FROM password_reset_tokens " +
            "WHERE token_hash = ? AND expires_at > ? AND used_at IS NULL LIMIT 1"
        )
        .get(options.tokenHash, options.now)
    )
  );
}

export function resetPasswordWithTokenRecord(options: {
  tokenHash: string;
  passwordHash: string;
  now: string;
}): { userId: string; userEmail: string } | null {
  return withSqliteTransaction((database) => {
    const row = database
      .prepare(
        "SELECT t.id AS token_id, t.user_id AS user_id, u.email AS user_email " +
          "FROM password_reset_tokens t " +
          "JOIN users u ON u.id = t.user_id " +
          "WHERE t.token_hash = ? AND t.expires_at > ? AND t.used_at IS NULL " +
          "LIMIT 1"
      )
      .get(options.tokenHash, options.now) as
      | { token_id: string; user_id: string; user_email: string }
      | undefined;
    if (!row) return null;

    const tokenResult = database
      .prepare(
        "UPDATE password_reset_tokens SET used_at = ? " +
          "WHERE id = ? AND used_at IS NULL AND expires_at > ?"
      )
      .run(options.now, row.token_id, options.now);
    if (Number(tokenResult.changes) !== 1) return null;

    const userResult = database
      .prepare(
        "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?"
      )
      .run(options.passwordHash, options.now, row.user_id);
    assertSingleChange(userResult.changes, "password update");

    database.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.user_id);
    database
      .prepare("DELETE FROM password_reset_tokens WHERE user_id = ? AND id <> ?")
      .run(row.user_id, row.token_id);

    return { userId: row.user_id, userEmail: row.user_email };
  });
}
