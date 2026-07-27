import { isResetTokenUsable, resetPasswordWithToken } from "@/lib/auth/password-reset";
import { authConfig } from "@/lib/auth/config";
import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { MAX_SMALL_JSON_BODY_BYTES, readJsonBodyResult } from "@/lib/security/request-body";
import { z } from "zod";
import { enforceRateLimit } from "@/lib/security/rate-limit";

const bodySchema = z.object({
  token: z.string().min(10, "Invalid reset link"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export async function POST(request: NextRequest) {
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

  const parsed = bodySchema.safeParse(bodyResult.body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      },
      { status: 400 },
    );
  }

  const globalLimit = enforceRateLimit(request, "auth:reset:global", {
    limit: 120,
    windowMs: 30 * 60_000,
  });
  if (globalLimit) return globalLimit;

  const limited = enforceRateLimit(request, "auth:reset", {
    limit: 8,
    windowMs: 30 * 60_000,
    identifier: parsed.data.token.slice(0, 16),
  });
  if (limited) return limited;

  // Reject random/expired tokens before the deliberately expensive bcrypt work.
  // The final transaction still re-checks and consumes the token to close races.
  if (!isResetTokenUsable(parsed.data.token)) {
    return NextResponse.json(
      { error: "This reset link is invalid or has expired." },
      { status: 400 }
    );
  }

  const passwordHash = await bcrypt.hash(
    parsed.data.password,
    authConfig.bcryptRounds
  );
  const consumed = await resetPasswordWithToken(
    parsed.data.token,
    passwordHash
  );
  if (!consumed) {
    return NextResponse.json(
      { error: "This reset link is invalid or has expired." },
      { status: 400 }
    );
  }

  return NextResponse.json({ ok: true });
}
