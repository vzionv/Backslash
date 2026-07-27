import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { withApiKey } from "@/lib/auth/apikey";
import { createProjectSchema } from "@/lib/utils/validation";
import { desc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { MAX_SMALL_JSON_BODY_BYTES, readJsonBodyResult } from "@/lib/security/request-body";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { createOwnedProject, ProjectOperationError } from "@/lib/storage/project-operations";
import { getLatestBuildStatuses } from "@/lib/projects/project-summary-service";

// ─── GET /api/v1/projects ───────────────────────────
// List all projects for the API key owner.

export async function GET(request: NextRequest) {
  return withApiKey(request, async (_req, user) => {
    try {
      const userProjects = await db
        .select()
        .from(projects)
        .where(eq(projects.userId, user.id))
        .orderBy(desc(projects.updatedAt));

      const latestBuildStatuses = await getLatestBuildStatuses(userProjects);
      const result = userProjects.map((project) => ({
        ...project,
        lastBuildStatus: latestBuildStatuses.get(project.id) ?? null,
      }));

      return NextResponse.json({ projects: result });
    } catch (error) {
      console.error("[API v1] Error listing projects:", error);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  });
}

// ─── POST /api/v1/projects ──────────────────────────
// Create a new project.

export async function POST(request: NextRequest) {
  return withApiKey(request, async (req, user) => {
    try {
      const limited = enforceRateLimit(req, "project:create", {
        limit: 20,
        windowMs: 60 * 60_000,
        identifier: user.id,
      });
      if (limited) return limited;

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
      const parsed = createProjectSchema.safeParse(bodyResult.body);
      if (!parsed.success) {
        return NextResponse.json(
          {
            error: "Validation failed",
            details: parsed.error.flatten().fieldErrors,
          },
          { status: 400 }
        );
      }

      const project = await createOwnedProject({
        ownerUserId: user.id,
        ...parsed.data,
      });
      return NextResponse.json({ project }, { status: 201 });
    } catch (error) {
      if (error instanceof ProjectOperationError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      console.error("[API v1] Error creating project:", error);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  });
}
