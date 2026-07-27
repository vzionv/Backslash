import type { Engine } from "@backslash/shared";
import { NextRequest, NextResponse } from "next/server";

import { resolveProjectAccess } from "@/lib/auth/project-access";
import { CompileQueueFullError } from "@/lib/compiler/compile-task-manager";
import {
  ProjectCompileError,
  queueProjectCompile,
} from "@/lib/compiler/queue-project-compile";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { readJsonBody, RequestBodyError } from "@/lib/security/request-body";
import { isSafeRequestedEngine } from "@/lib/compiler/engine-policy";


// ─── POST /api/projects/[projectId]/compile ────────
// Trigger compilation for a project. Owner and editors can compile.

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;
    const access = await resolveProjectAccess(request, projectId);
    if (!access.access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }
    if (access.role === "viewer") {
      return NextResponse.json({ error: "Permission denied" }, { status: 403 });
    }

    const rateLimited = enforceRateLimit(request, "project:compile", {
      limit: 30,
      windowMs: 60_000,
      identifier: access.user?.id ?? `share:${projectId}`,
    });
    if (rateLimited) return rateLimited;

    const project = access.project;
    const storageUserId = project.userId;
    const actorUserId = access.user?.id ?? null;
    const buildUserId = access.user?.id ?? storageUserId;
    let compileEngine = project.engine as Engine;

    const contentType = request.headers.get("content-type") || "";
    if (contentType.toLowerCase().includes("application/json")) {
      const body = await readJsonBody(request, 64 * 1024);
      if (body && typeof body === "object" && "engine" in body) {
        const requestedEngine = (body as Record<string, unknown>).engine;
        if (typeof requestedEngine !== "string" || !isSafeRequestedEngine(requestedEngine)) {
          return NextResponse.json(
            {
              error:
                "Invalid engine. Use one of: auto, pdflatex, xelatex, latex",
            },
            { status: 400 }
          );
        }
        compileEngine = requestedEngine;
      }
    }

    const { buildId } = await queueProjectCompile({
      projectId,
      buildUserId,
      storageUserId,
      triggeredByUserId: actorUserId,
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
    console.error("Error triggering compilation:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
