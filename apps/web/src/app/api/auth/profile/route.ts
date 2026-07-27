import { withAuth } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import bcrypt from "bcryptjs";
import { eq, and, ne } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { MAX_SMALL_JSON_BODY_BYTES, readJsonBodyResult } from "@/lib/security/request-body";

export async function PUT(request: NextRequest) {
  return withAuth(request, async (req, user) => {
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
    const { name, email, currentPassword } = bodyResult.body as Record<string, unknown>;

    const updates: { name?: string; email?: string; updatedAt: string } = {
      updatedAt: new Date().toISOString(),
    };

    if (name !== undefined) {
      if (typeof name !== "string" || name.trim().length === 0 || name.length > 255) {
        return NextResponse.json(
          { error: "Name must be between 1 and 255 characters" },
          { status: 400 }
        );
      }
      updates.name = name.trim();
    }

    if (email !== undefined) {
      if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return NextResponse.json(
          { error: "Invalid email format" },
          { status: 400 }
        );
      }

      const emailChanging = email.toLowerCase() !== user.email.toLowerCase();

      if (emailChanging) {
        if (typeof currentPassword !== "string" || currentPassword.length === 0) {
          return NextResponse.json(
            { error: "Current password is required to change your email." },
            { status: 401 }
          );
        }

        const [authUser] = await db
          .select({ passwordHash: users.passwordHash })
          .from(users)
          .where(eq(users.id, user.id))
          .limit(1);

        if (!authUser) {
          return NextResponse.json(
            { error: "Account not found" },
            { status: 404 }
          );
        }

        const ok = await bcrypt.compare(currentPassword, authUser.passwordHash);
        if (!ok) {
          return NextResponse.json(
            { error: "Incorrect password" },
            { status: 401 }
          );
        }

        const existing = await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.email, email.toLowerCase()), ne(users.id, user.id)))
          .limit(1);

        if (existing.length > 0) {
          return NextResponse.json(
            { error: "Email is already in use" },
            { status: 409 }
          );
        }
      }
      updates.email = email.toLowerCase();
    }

    await db.update(users).set(updates).where(eq(users.id, user.id));
    const [updated] = await db.select({
      id: users.id, email: users.email, name: users.name,
      createdAt: users.createdAt, updatedAt: users.updatedAt,
    }).from(users).where(eq(users.id, user.id)).limit(1);

    return NextResponse.json({ user: updated });
  });
}
