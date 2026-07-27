import { db } from "@/lib/db";
import { labels, projectLabels, projects } from "@/lib/db/schema";
import { withAuth } from "@/lib/auth/middleware";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { MAX_SMALL_JSON_BODY_BYTES, readJsonBodyResult } from "@/lib/security/request-body";
import { z } from "zod";

const detachLabelSchema = z.object({
  projectId: z.string().trim().min(1).max(100),
  labelId: z.string().trim().min(1).max(100),
});

// ─── PUT /api/labels/detach ─────────────────────────
// Detach a user-owned label from a user-owned project.

export async function PUT(request: NextRequest) {
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
      const parsed = detachLabelSchema.safeParse(bodyResult.body);
      if (!parsed.success) {
        return NextResponse.json(
          {
            error: "Validation failed",
            details: parsed.error.flatten().fieldErrors,
          },
          { status: 400 }
        );
      }
      const { projectId, labelId } = parsed.data;

      const [existing] = await db
        .select({ id: projectLabels.id })
        .from(projectLabels)
        .innerJoin(projects, eq(projectLabels.projectId, projects.id))
        .innerJoin(labels, eq(projectLabels.labelId, labels.id))
        .where(
          and(
            eq(projectLabels.projectId, projectId),
            eq(projectLabels.labelId, labelId),
            eq(projects.userId, user.id),
            eq(labels.userId, user.id)
          )
        )
        .limit(1);

      // Return the same response for missing and unauthorized associations.
      if (!existing) {
        return NextResponse.json(
          { error: "Label association not found" },
          { status: 404 }
        );
      }

      const [projectLabel] = await db
        .delete(projectLabels)
        .where(eq(projectLabels.id, existing.id))
        .returning();

      const [remaining] = await db
        .select({ id: projectLabels.id })
        .from(projectLabels)
        .where(eq(projectLabels.labelId, labelId))
        .limit(1);

      if (!remaining) {
        await db
          .delete(labels)
          .where(and(eq(labels.id, labelId), eq(labels.userId, user.id)));
      }

      return NextResponse.json(
        { ...projectLabel, deletedLabel: !remaining },
        { status: 200 }
      );
    } catch (error) {
      console.error("Error detaching label:", error);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  });
}
