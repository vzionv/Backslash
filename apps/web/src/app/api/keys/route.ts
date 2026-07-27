import { db } from "@/lib/db";
import { apiKeys } from "@/lib/db/schema";
import { withAuth } from "@/lib/auth/middleware";
import { generateApiKey } from "@/lib/auth/apikey";
import { eq, desc } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { MAX_SMALL_JSON_BODY_BYTES, readJsonBodyResult } from "@/lib/security/request-body";
import { z } from "zod";

const createApiKeySchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name is too long"),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

// ─── GET /api/keys ──────────────────────────────────
// List all API keys for the authenticated user.

export async function GET(request: NextRequest) {
  return withAuth(request, async (_req, user) => {
    try {
      const keys = await db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          keyPrefix: apiKeys.keyPrefix,
          lastUsedAt: apiKeys.lastUsedAt,
          requestCount: apiKeys.requestCount,
          expiresAt: apiKeys.expiresAt,
          createdAt: apiKeys.createdAt,
        })
        .from(apiKeys)
        .where(eq(apiKeys.userId, user.id))
        .orderBy(desc(apiKeys.createdAt));

      return NextResponse.json({ apiKeys: keys });
    } catch (error) {
      console.error("Error listing API keys:", error);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  });
}

// ─── POST /api/keys ─────────────────────────────────
// Create a new API key. The full key is returned only once.

export async function POST(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const bodyResult = await readJsonBodyResult(
        req,
        MAX_SMALL_JSON_BODY_BYTES
      );
      if (!bodyResult.ok) {
        return NextResponse.json(
          { error: bodyResult.error },
          { status: bodyResult.status }
        );
      }
      const parsed = createApiKeySchema.safeParse(bodyResult.body);

      if (!parsed.success) {
        return NextResponse.json(
          {
            error: "Validation failed",
            details: parsed.error.flatten().fieldErrors,
          },
          { status: 400 }
        );
      }

      const { name, expiresInDays } = parsed.data;

      // Limit to 10 API keys per user
      const existingKeys = await db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(eq(apiKeys.userId, user.id));

      if (existingKeys.length >= 10) {
        return NextResponse.json(
          { error: "Maximum of 10 API keys allowed per account" },
          { status: 400 }
        );
      }

      const { key, keyHash, keyPrefix } = generateApiKey();

      let expiresAt: string | null = null;
      if (expiresInDays) {
        const d = new Date();
        d.setDate(d.getDate() + expiresInDays);
        expiresAt = d.toISOString();
      }

      await db.insert(apiKeys).values({
        userId: user.id, name, keyHash, keyPrefix, expiresAt,
      });
      const [apiKey] = await db.select({
          id: apiKeys.id, name: apiKeys.name, keyPrefix: apiKeys.keyPrefix,
          lastUsedAt: apiKeys.lastUsedAt, requestCount: apiKeys.requestCount,
          expiresAt: apiKeys.expiresAt, createdAt: apiKeys.createdAt,
        }).from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1);

      return NextResponse.json({ apiKey, key }, { status: 201 });
    } catch (error) {
      console.error("Error creating API key:", error);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  });
}
