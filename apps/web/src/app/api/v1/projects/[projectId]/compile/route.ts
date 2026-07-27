import type { Engine } from "@backslash/shared";
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { withApiKey } from "@/lib/auth/apikey";
import { CompileQueueFullError } from "@/lib/compiler/compile-task-manager";
import {
  ProjectCompileError,
  queueProjectCompile,
} from "@/lib/compiler/queue-project-compile";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { readJsonBody, RequestBodyError } from "@/lib/security/request-body";
import { isSafeRequestedEngine } from "@/lib/compiler/engine-policy";


export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  return withApiKey(request, async (req, user) => {
    try {
      const { projectId } = await params;
      const [project] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      if (!project || project.userId !== user.id) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }

      const rateLimited = enforceRateLimit(req, "api:v1:project-compile", {
        limit: 30,
        windowMs: 60_000,
        identifier: `${user.id}:${projectId}`,
      });
      if (rateLimited) return rateLimited;

      let compileEngine = project.engine as Engine;
      const contentType = req.headers.get("content-type") || "";
      if (contentType.toLowerCase().includes("application/json")) {
        const body = await readJsonBody(req, 64 * 1024);
        if (body && typeof body === "object" && "engine" in body) {
          const requestedEngine = (body as Record<string, unknown>).engine;
          if (typeof requestedEngine !== "string" || !isSafeRequestedEngine(requestedEngine)) {
            return NextResponse.json({ error: "Invalid engine" }, { status: 400 });
          }
          compileEngine = requestedEngine;
        }
      }

      const { buildId } = await queueProjectCompile({
        projectId,
        buildUserId: user.id,
        storageUserId: user.id,
        triggeredByUserId: user.id,
        engine: compileEngine,
      });

      return NextResponse.json(
        { buildId, status: "queued", message: "Compilation queued" },
        { status: 202 }
      );
    } catch (error) {
      if (error instanceof RequestBodyError || error instanceof ProjectCompileError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      if (error instanceof CompileQueueFullError) {
        return NextResponse.json(
          { error: "Compilation queue is full. Try again later." },
          { status: 429, headers: { "Retry-After": "5" } }
        );
      }
      console.error("[API v1] Error triggering compilation:", error);
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
  });
}
