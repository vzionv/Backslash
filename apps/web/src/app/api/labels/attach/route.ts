import { db } from "@/lib/db";
import { labels, projectLabels, projects } from "@/lib/db/schema";
import { withAuth } from "@/lib/auth/middleware";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { MAX_SMALL_JSON_BODY_BYTES, readJsonBodyResult } from "@/lib/security/request-body";
import { z } from "zod";

const attachLabelSchema = z.object({
  projectId: z.string().trim().min(1).max(100),
  labelName: z.string().trim().min(1).max(64),
});

// PUT /api/labels/attach
// Attach a label to a user-owned project, creating the label when necessary.
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
      const parsed = attachLabelSchema.safeParse(bodyResult.body);
      if (!parsed.success) {
        return NextResponse.json(
          {
            error: "Validation failed",
            details: parsed.error.flatten().fieldErrors,
          },
          { status: 400 }
        );
      }
      const { projectId, labelName } = parsed.data;

      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.userId, user.id)))
        .limit(1);
      if (!project) {
        return NextResponse.json(
          { error: "Project not found or access denied" },
          { status: 404 }
        );
      }

      let [label] = await db
        .select()
        .from(labels)
        .where(and(eq(labels.name, labelName), eq(labels.userId, user.id)))
        .limit(1);

      if (!label) {
        [label] = await db
          .insert(labels)
          .values({ name: labelName, userId: user.id })
          .returning();
      }

      const [existing] = await db
        .select({ id: projectLabels.id })
        .from(projectLabels)
        .where(
          and(
            eq(projectLabels.labelId, label.id),
            eq(projectLabels.projectId, projectId)
          )
        )
        .limit(1);
      if (existing) {
        return NextResponse.json(
          { error: "Label is already attached to this project" },
          { status: 409 }
        );
      }

      const [projectLabel] = await db
        .insert(projectLabels)
        .values({ labelId: label.id, projectId })
        .returning();

      return NextResponse.json({ projectLabel, label });
    } catch (error) {
      console.error("Error attaching label:", error);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  });
}
