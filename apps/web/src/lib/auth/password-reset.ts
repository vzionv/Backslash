import crypto from "crypto";
import {
  createPasswordResetRecord,
  isPasswordResetTokenUsableRecord,
  resetPasswordWithTokenRecord,
} from "@/lib/db/auth-mutations";

const TOKEN_BYTES = 32;
const TOKEN_TTL_MINUTES = 30;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function issueResetToken(userId: string): Promise<string> {
  const raw = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000);

  createPasswordResetRecord({
    userId,
    tokenHash,
    expiresAt: expiresAt.toISOString(),
    createdAt: new Date().toISOString(),
  });

  return raw;
}

export interface ConsumedToken {
  userId: string;
  userEmail: string;
}

export function isResetTokenUsable(token: string): boolean {
  return isPasswordResetTokenUsableRecord({
    tokenHash: hashToken(token),
    now: new Date().toISOString(),
  });
}

/**
 * Atomically consume a reset token, update the password, and revoke sessions.
 * Returns null if the token is missing, expired, or already used.
 */
export async function resetPasswordWithToken(
  token: string,
  passwordHash: string
): Promise<ConsumedToken | null> {
  return resetPasswordWithTokenRecord({
    tokenHash: hashToken(token),
    passwordHash,
    now: new Date().toISOString(),
  });
}
