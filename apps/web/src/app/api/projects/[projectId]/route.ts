import { toPublicBuild } from "@/lib/compiler/public-build";
import { db } from "@/lib/db";
import { projects, projectFiles, builds, labels, projectLabels } from "@/lib/db/schema";
import { withAuth } from "@/lib/auth/middleware";
import { resolveProjectAccess } from "@/lib/auth/project-access";
import { updateProjectSchema } from "@/lib/utils/validation";
import { checkProjectAccess } from "@/lib/db/queries/projects";
import { eq, desc } from "drizzle-orm";
import { deleteOwnedProject, ProjectOperationError } from "@/lib/storage/project-operations";
import { NextRequest, NextResponse } from "next/server";
import { MAX_SMALL_JSON_BODY_BYTES, readJsonBodyResult } from "@/lib/security/request-body";
import { broadcastProjectAccessChanged } from "@/lib/websocket/server";

// ─── GET /api/projects/[projectId] ─────────────────
// Get project details with file list and last build.
// Accessible by owner AND shared collaborators.

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;

    const access = await resolveProjectAccess(request, projectId);
    if (!access.access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const project = access.project;

    const files = await db
      .select()
      .from(projectFiles)
      .where(eq(projectFiles.projectId, projectId));

    const [lastBuild] = await db
      .select()
      .from(builds)
      .where(eq(builds.projectId, projectId))
      .orderBy(desc(builds.createdAt))
      .limit(1);

      const labelsForProject = await db
        .select({ id: labels.id, name: labels.name })
        .from(projectLabels)
        .innerJoin(labels, eq(labels.id, projectLabels.labelId))
        .where(eq(projectLabels.projectId, project.id));

    return NextResponse.json({
      project,
      files,
      lastBuild: toPublicBuild(lastBuild),
      role: access.role,
      shareToken: access.shareToken,
      isAnonymous: access.isAnonymous,
      labels: labelsForProject,
    });
  } catch (error) {
    console.error("Error fetching project:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// ─── PUT /api/projects/[projectId] ─────────────────
// Update project settings. Owner only.

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
          { error: "Only the project owner can update settings" },
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

      const parsed = updateProjectSchema.safeParse(bodyResult.body);
      if (!parsed.success) {
        return NextResponse.json(
          {
            error: "Validation failed",
            details: parsed.error.flatten().fieldErrors,
          },
          { status: 400 }
        );
      }

      const updates = parsed.data;

      const [updatedProject] = await db
        .update(projects)
        .set({
          ...updates,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(projects.id, projectId))
        .returning();

      return NextResponse.json({ project: updatedProject });
    } catch (error) {
      console.error("Error updating project:", error);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  });
}

// ─── DELETE /api/projects/[projectId] ──────────────
// Delete project, its DB rows, and project directory from disk. Owner only.

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  return withAuth(request, async (_req, user) => {
    try {
      const { projectId } = await params;
      await deleteOwnedProject({ projectId, ownerUserId: user.id });
      broadcastProjectAccessChanged(projectId);
      return NextResponse.json({ success: true });
    } catch (error) {
      if (error instanceof ProjectOperationError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      console.error("Error deleting project:", error);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  });
}
