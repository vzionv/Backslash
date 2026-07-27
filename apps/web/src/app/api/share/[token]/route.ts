import { toPublicBuild } from "@/lib/compiler/public-build";
import { db } from "@/lib/db";
import { builds, projectFiles, projectPublicShares, projects } from "@/lib/db/schema";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/security/rate-limit";

// GET /api/share/[token]
// Resolve a public share token to project data for anonymous editor access.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    if (!/^[a-f0-9]{48}$/.test(token)) {
      return NextResponse.json(
        { error: "Share link is invalid or expired" },
        { status: 404 }
      );
    }

    const rateLimited = enforceRateLimit(request, "public-share:resolve", {
      limit: 120,
      windowMs: 60_000,
      identifier: token.slice(0, 12),
    });
    if (rateLimited) return rateLimited;

    const [publicShare] = await db
      .select({
        projectId: projectPublicShares.projectId,
        role: projectPublicShares.role,
      })
      .from(projectPublicShares)
      .where(
        and(
          eq(projectPublicShares.token, token),
          or(
            isNull(projectPublicShares.expiresAt),
            gt(projectPublicShares.expiresAt, new Date().toISOString())
          )
        )
      )
      .limit(1);

    if (!publicShare) {
      return NextResponse.json({ error: "Share link is invalid or expired" }, { status: 404 });
    }

    const [project] = await db
      .select({
        id: projects.id,
        userId: projects.userId,
        name: projects.name,
        description: projects.description,
        engine: projects.engine,
        mainFile: projects.mainFile,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
      })
      .from(projects)
      .where(eq(projects.id, publicShare.projectId))
      .limit(1);

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const files = await db
      .select()
      .from(projectFiles)
      .where(eq(projectFiles.projectId, project.id));

    const [lastBuild] = await db
      .select()
      .from(builds)
      .where(eq(builds.projectId, project.id))
      .orderBy(desc(builds.createdAt), desc(builds.id))
      .limit(1);

    return NextResponse.json(
      {
        project,
        files,
        lastBuild: toPublicBuild(lastBuild),
        role: publicShare.role,
        shareToken: token,
        isPublicShare: true,
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (error) {
    console.error("Error resolving share token:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
