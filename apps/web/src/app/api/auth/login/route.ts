import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import {
  createSession,
  setSessionCookie,
} from "@/lib/auth/session";
import { loginSchema } from "@/lib/utils/validation";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { MAX_SMALL_JSON_BODY_BYTES, readJsonBodyResult } from "@/lib/security/request-body";
import { enforceRateLimit } from "@/lib/security/rate-limit";

export async function POST(request: NextRequest) {
  try {
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

    const parsed = loginSchema.safeParse(bodyResult.body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { email, password } = parsed.data;

    const limited = enforceRateLimit(request, "auth:login", {
      limit: 8,
      windowMs: 15 * 60_000,
      identifier: email,
    });
    if (limited) return limited;

    // Find user by email
    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);

    if (!user) {
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401 }
      );
    }

    // Verify password
    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401 }
      );
    }

    // Create session and set cookie
    const token = await createSession(user.id);
    await setSessionCookie(token);

    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      }
    });
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
