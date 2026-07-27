import { db } from "@/lib/db";
import { projectPublicShares } from "@/lib/db/schema";
import { withAuth } from "@/lib/auth/middleware";
import { checkProjectAccess } from "@/lib/db/queries/projects";
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { MAX_SMALL_JSON_BODY_BYTES, readJsonBodyResult } from "@/lib/security/request-body";
import { z } from "zod";
import { randomBytes } from "crypto";
import { getApplicationBaseUrl } from "@/lib/http/base-url";

const updateShareLinkSchema = z.object({
  enabled: z.boolean(),
  role: z.enum(["viewer", "editor"]).default("viewer"),
  expiresIn: z.enum(["30m", "7d", "never"]).default("never"),
});

function resolveExpiry(expiresIn: "30m" | "7d" | "never"): string | null {
  if (expiresIn === "never") return null;
  const now = Date.now();
  if (expiresIn === "30m") return new Date(now + 30 * 60 * 1000).toISOString();
  return new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
}



function serializeShare(
  share: {
    role: string;
    expiresAt: Date | string | null;
    token?: string;
  } | null,
  request: NextRequest
) {
  if (!share) {
    return {
      enabled: false,
      role: "viewer" as const,
      expiresAt: null,
      token: null,
      url: null,
    };
  }

  const expiresAt = share.expiresAt ? new Date(share.expiresAt) : null;
  if (expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= Date.now()) {
    return {
      enabled: false,
      role: "viewer" as const,
      expiresAt: null,
      token: null,
      url: null,
    };
  }

  const token = share.token ?? null;
  const baseUrl = getApplicationBaseUrl(request);

  return {
    enabled: true,
    role: share.role === "editor" ? "editor" : "viewer",
    expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
    token,
    url: token ? `${baseUrl}/share/${token}` : null,
  };
}

function generateShareToken(): string {
  return randomBytes(24).toString("hex");
}

// GET /api/projects/[projectId]/share-link
// Returns the current "anyone" share state for this project.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  return withAuth(request, async (_req, user) => {
    try {
      const { projectId } = await params;

      const access = await checkProjectAccess(user.id, projectId);
      if (!access.access) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }
      if (access.role !== "owner") {
        return NextResponse.json(
          { error: "Only the project owner can view link sharing settings" },
          { status: 403 }
        );
      }

      const [share] = await db
        .select({
          role: projectPublicShares.role,
          expiresAt: projectPublicShares.expiresAt,
          token: projectPublicShares.token,
        })
        .from(projectPublicShares)
        .where(eq(projectPublicShares.projectId, projectId))
        .limit(1);

      return NextResponse.json({ share: serializeShare(share ?? null, request) });
    } catch (error) {
      console.error("Error fetching share link settings:", error);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  });
}

// PUT /api/projects/[projectId]/share-link
// Owner toggles/updates anyone-share settings.
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  return withAuth(request, async (req, user) => {
    try {
      const { projectId } = await params;

      const access = await checkProjectAccess(user.id, projectId);
      if (!access.access || access.role !== "owner") {
        return NextResponse.json(
          { error: "Only the project owner can update link sharing" },
          { status: 403 }
        );
      }

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
      const parsed = updateShareLinkSchema.safeParse(bodyResult.body);
      if (!parsed.success) {
        return NextResponse.json(
          {
            error: "Validation failed",
            details: parsed.error.flatten().fieldErrors,
          },
          { status: 400 }
        );
      }

      const { enabled, role, expiresIn } = parsed.data;

      if (!enabled) {
        await db
          .delete(projectPublicShares)
          .where(eq(projectPublicShares.projectId, projectId));

        return NextResponse.json({
          share: {
            enabled: false,
            role: "viewer",
            expiresAt: null,
            token: null,
            url: null,
          },
        });
      }

      const expiresAt = resolveExpiry(expiresIn);

      const [existing] = await db
        .select({
          id: projectPublicShares.id,
          expiresAt: projectPublicShares.expiresAt,
        })
        .from(projectPublicShares)
        .where(eq(projectPublicShares.projectId, projectId))
        .limit(1);

      if (existing) {
        const existingExpiry = existing.expiresAt
          ? new Date(existing.expiresAt).getTime()
          : null;
        const expired =
          existingExpiry !== null &&
          !Number.isNaN(existingExpiry) &&
          existingExpiry <= Date.now();

        const [updated] = await db
          .update(projectPublicShares)
          .set({
            ...(expired ? { token: generateShareToken() } : {}),
            role,
            expiresAt,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(projectPublicShares.id, existing.id))
          .returning();

        return NextResponse.json({ share: serializeShare(updated, request) });
      }

      const [created] = await db
        .insert(projectPublicShares)
        .values({
          projectId,
          token: generateShareToken(),
          role,
          expiresAt,
        })
        .returning();

      return NextResponse.json(
        { share: serializeShare(created, request) },
        { status: 201 }
      );
    } catch (error) {
      console.error("Error updating share link settings:", error);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  });
}
