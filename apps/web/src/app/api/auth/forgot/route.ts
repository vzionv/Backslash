import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { issueResetToken } from "@/lib/auth/password-reset";
import { sendPasswordResetEmail } from "@/lib/email/send";
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { MAX_SMALL_JSON_BODY_BYTES, readJsonBodyResult } from "@/lib/security/request-body";
import { z } from "zod";
import { getApplicationBaseUrl } from "@/lib/http/base-url";
import { enforceRateLimit } from "@/lib/security/rate-limit";

const bodySchema = z.object({
  email: z.string().email("Invalid email address"),
});

export async function POST(request: NextRequest) {
  const bodyResult = await readJsonBodyResult(
    request,
    MAX_SMALL_JSON_BODY_BYTES
  );
  if (!bodyResult.ok) {
    return NextResponse.json({ ok: true });
  }
  const parsed = bodySchema.safeParse(bodyResult.body);
  if (!parsed.success) {
    // Don't leak validation details — we always want to respond the same way.
    return NextResponse.json({ ok: true });
  }

  const email = parsed.data.email.toLowerCase();
  const limited = enforceRateLimit(request, "auth:forgot", {
    limit: 5,
    windowMs: 30 * 60_000,
    identifier: email,
  });
  if (limited) return limited;

  try {
    const [user] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (user) {
      const token = await issueResetToken(user.id);
      const resetUrl = `${getApplicationBaseUrl(request)}/reset/${token}`;
      await sendPasswordResetEmail(user.email, resetUrl);
    }
  } catch (err) {
    console.error("[forgot] Failed to issue reset:", err);
    // Still return 200 so attackers cannot probe for valid emails.
  }

  return NextResponse.json({ ok: true });
}
