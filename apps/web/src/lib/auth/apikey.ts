import crypto from "crypto";
import { db } from "@/lib/db";
import { apiKeys, users } from "@/lib/db/schema";
import { eq, and, gt, or, isNull, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

// ─── Key Generation ─────────────────────────────────

const KEY_PREFIX = "bs_";
const KEY_BYTES = 32;
const API_KEY_USAGE_FLUSH_MS = 30_000;

interface PendingApiKeyUsage {
  count: number;
  lastUsedAt: string;
}

type ApiKeyUsageGlobal = typeof globalThis & {
  __backslashPendingApiKeyUsage__?: Map<string, PendingApiKeyUsage>;
  __backslashApiKeyUsageTimer__?: ReturnType<typeof setTimeout>;
};

const usageGlobal = globalThis as ApiKeyUsageGlobal;
usageGlobal.__backslashPendingApiKeyUsage__ ??= new Map();

function scheduleApiKeyUsageFlush(): void {
  if (usageGlobal.__backslashApiKeyUsageTimer__) return;
  usageGlobal.__backslashApiKeyUsageTimer__ = setTimeout(() => {
    usageGlobal.__backslashApiKeyUsageTimer__ = undefined;
    void flushApiKeyUsage();
  }, API_KEY_USAGE_FLUSH_MS);
  usageGlobal.__backslashApiKeyUsageTimer__.unref?.();
}

async function flushApiKeyUsage(): Promise<void> {
  const pending = usageGlobal.__backslashPendingApiKeyUsage__;
  if (!pending || pending.size === 0) return;
  usageGlobal.__backslashPendingApiKeyUsage__ = new Map();

  for (const [keyId, usage] of pending) {
    try {
      await db
        .update(apiKeys)
        .set({
          lastUsedAt: usage.lastUsedAt,
          requestCount: sql`${apiKeys.requestCount} + ${usage.count}`,
        })
        .where(eq(apiKeys.id, keyId));
    } catch {
      const retry = usageGlobal.__backslashPendingApiKeyUsage__!;
      const current = retry.get(keyId);
      retry.set(keyId, {
        count: usage.count + (current?.count ?? 0),
        lastUsedAt: current?.lastUsedAt ?? usage.lastUsedAt,
      });
    }
  }

  // A transient database error must not silently stop future usage accounting.
  if (usageGlobal.__backslashPendingApiKeyUsage__?.size) {
    scheduleApiKeyUsageFlush();
  }
}

function recordApiKeyUsage(keyId: string): void {
  const pending = usageGlobal.__backslashPendingApiKeyUsage__!;
  const current = pending.get(keyId);
  pending.set(keyId, {
    count: (current?.count ?? 0) + 1,
    lastUsedAt: new Date().toISOString(),
  });

  scheduleApiKeyUsageFlush();
}

/**
 * Generate a new API key.
 * Returns { key, keyHash, keyPrefix } — `key` is only shown once.
 */
export function generateApiKey(): {
  key: string;
  keyHash: string;
  keyPrefix: string;
} {
  const rawBytes = crypto.randomBytes(KEY_BYTES);
  const key = KEY_PREFIX + rawBytes.toString("base64url");
  const keyHash = hashApiKey(key);
  const keyPrefix = key.substring(0, KEY_PREFIX.length + 8);
  return { key, keyHash, keyPrefix };
}

/**
 * Hash an API key for storage (SHA-256).
 */
export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

// ─── Authenticated User from API Key ────────────────

export interface ApiKeyUser {
  id: string;
  email: string;
  name: string;
  apiKeyId: string;
}

/**
 * Validate an API key and return the user it belongs to.
 * Also bumps lastUsedAt and requestCount.
 */
export async function validateApiKey(
  key: string
): Promise<ApiKeyUser | null> {
  const keyHash = hashApiKey(key);

  const result = await db
    .select({
      apiKey: apiKeys,
      user: {
        id: users.id,
        email: users.email,
        name: users.name,
      },
    })
    .from(apiKeys)
    .innerJoin(users, eq(apiKeys.userId, users.id))
    .where(
      and(
        eq(apiKeys.keyHash, keyHash),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date().toISOString()))
      )
    )
    .limit(1);

  if (result.length === 0) return null;

  const { apiKey, user } = result[0];

  // Batch usage updates to reduce write amplification on the API authentication hot path.
  recordApiKeyUsage(apiKey.id);

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    apiKeyId: apiKey.id,
  };
}

// ─── Middleware: withApiKey ──────────────────────────

/**
 * Protect an API route with API key authentication.
 * Expects `Authorization: Bearer bs_...` header.
 */
export async function withApiKey(
  request: NextRequest,
  handler: (req: NextRequest, user: ApiKeyUser) => Promise<Response>
): Promise<Response> {
  const authHeader = request.headers.get("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return NextResponse.json(
      {
        error: "Unauthorized",
        message:
          "API key required. Set the Authorization header to: Bearer bs_...",
      },
      { status: 401 }
    );
  }

  const key = authHeader.slice(7).trim();

  if (!key.startsWith(KEY_PREFIX)) {
    return NextResponse.json(
      {
        error: "Unauthorized",
        message: "Invalid API key format.",
      },
      { status: 401 }
    );
  }

  const user = await validateApiKey(key);

  if (!user) {
    return NextResponse.json(
      {
        error: "Unauthorized",
        message: "Invalid or expired API key.",
      },
      { status: 401 }
    );
  }

  return handler(request, user);
}
