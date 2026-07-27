import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import {
  createSession,
  setSessionCookie,
} from "@/lib/auth/session";
import { registerSchema } from "@/lib/utils/validation";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { MAX_SMALL_JSON_BODY_BYTES, readJsonBodyResult } from "@/lib/security/request-body";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { authConfig } from "@/lib/auth/config";

export async function POST(request: NextRequest) {
  try {
    if (process.env.DISABLE_SIGNUP === "true") {
      return NextResponse.json(
        { error: "Registration is currently disabled" },
        { status: 403 }
      );
    }

    const bodyResult = await readJsonBodyResult(
      request,
      MAX_SMALL_JSON_BODY_BYTES
    );
    if (!bodyResult.ok) {
      return NextResponse.json(
        { error: bodyResult.error },
        { status: bodyResult.status }
      );
    }

    const parsed = registerSchema.safeParse(bodyResult.body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { email, name, password } = parsed.data;

    const limited = enforceRateLimit(request, "auth:register", {
      limit: 8,
      windowMs: 15 * 60_000,
      identifier: email,
    });
    if (limited) return limited;

    // Check if a user with this email already exists
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);

    if (existing.length > 0) {
      return NextResponse.json(
        { error: "A user with this email already exists" },
        { status: 409 }
      );
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, authConfig.bcryptRounds);

    // Insert user
    const userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId, email: email.toLowerCase(), name, passwordHash,
    });
    const [user] = await db.select({
      id: users.id, email: users.email, name: users.name, createdAt: users.createdAt,
    }).from(users).where(eq(users.id, userId)).limit(1);

    // Create session and set cookie
    const token = await createSession(user.id);
    await setSessionCookie(token);

    return NextResponse.json({ user }, { status: 201 });
  } catch (error) {
    console.error("Registration error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
