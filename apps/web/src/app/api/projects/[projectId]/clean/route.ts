import { spawn } from "child_process";
import { NextRequest, NextResponse } from "next/server";
import { resolveProjectAccess } from "@/lib/auth/project-access";
import { tryAcquireCleanTask } from "@/lib/compiler/clean-task-limit";
import { cancelProjectCompileTasks } from "@/lib/compiler/compile-task-manager";
import { compileConfig } from "@/lib/compiler/config";
import { WindowsProcessTreeManager } from "@/lib/compiler/windows-process-tree";
import { db } from "@/lib/db";
import { builds } from "@/lib/db/schema";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import {
  MAX_SMALL_JSON_BODY_BYTES,
  readJsonBodyResult,
} from "@/lib/security/request-body";
import { getProjectDir } from "@/lib/storage";
import { normalizeProjectTexPath } from "@/lib/storage/path-security";
import { withProjectMutationLock } from "@/lib/storage/project-mutation-lock";
import { eq } from "drizzle-orm";

const CLEAN_TIMEOUT_MS = 60_000;
const CLEAN_LOG_LIMIT_BYTES = 64 * 1024;

function appendBounded(current: string, chunk: Buffer): string {
  const remaining = CLEAN_LOG_LIMIT_BYTES - Buffer.byteLength(current, "utf-8");
  if (remaining <= 0) return current;
  return current + chunk.subarray(0, remaining).toString("utf-8");
}

// POST /api/projects/[projectId]/clean
// Clean auxiliary files using latexmk -c or -C.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const releaseCleanTask = tryAcquireCleanTask();
  if (!releaseCleanTask) {
    return NextResponse.json(
      { error: "Too many clean operations are already running" },
      { status: 429, headers: { "Retry-After": "5" } }
    );
  }

  try {
    const { projectId } = await params;
    const access = await resolveProjectAccess(request, projectId);
    if (!access.access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }
    if (access.role === "viewer") {
      return NextResponse.json({ error: "Permission denied" }, { status: 403 });
    }

    const rateLimited = enforceRateLimit(request, "project:clean", {
      limit: 6,
      windowMs: 60_000,
      identifier: access.user?.id ?? `share:${projectId}`,
    });
    if (rateLimited) return rateLimited;

    let deepClean = false;
    const contentType = request.headers.get("content-type") || "";
    const contentLength = request.headers.get("content-length");
    if (
      contentType.toLowerCase().includes("application/json") &&
      contentLength !== "0"
    ) {
      const bodyResult = await readJsonBodyResult(
        request,
        MAX_SMALL_JSON_BODY_BYTES
      );
      if (!bodyResult.ok) {
        return NextResponse.json(
          { error: bodyResult.error },
          { status: bodyResult.status }
        );
      }
      if (
        bodyResult.body &&
        typeof bodyResult.body === "object" &&
        "deep" in bodyResult.body
      ) {
        deepClean = (bodyResult.body as { deep?: unknown }).deep === true;
      }
    }

    return await withProjectMutationLock(projectId, async () => {
      const currentAccess = await resolveProjectAccess(request, projectId);
      if (!currentAccess.access) {
        return NextResponse.json(
          { error: currentAccess.error },
          { status: currentAccess.status }
        );
      }
      if (currentAccess.role === "viewer") {
        return NextResponse.json({ error: "Permission denied" }, { status: 403 });
      }

      const cancellation = await cancelProjectCompileTasks(projectId, 10_000);
      if (!cancellation.settled) {
        return NextResponse.json(
          { error: "A compilation process did not stop in time; clean was canceled." },
          { status: 409 }
        );
      }

      const project = currentAccess.project;
      let mainFile: string;
      try {
        mainFile = normalizeProjectTexPath(project.mainFile);
      } catch {
        return NextResponse.json(
          { error: "Invalid project main file" },
          { status: 400 }
        );
      }

      const projectDir = getProjectDir(project.userId, projectId);
      // -norc is mandatory: latexmkrc files are executable Perl and would bypass
      // TeX shell-escape restrictions.
      const args = ["-norc", deepClean ? "-C" : "-c", "--", mainFile];

      return await new Promise<NextResponse>((resolve) => {
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(compileConfig.latexmkPath, args, {
            cwd: projectDir,
            shell: false,
            windowsHide: true,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...process.env,
              HOME: projectDir,
              TEXMFOUTPUT: projectDir,
              openin_any: "p",
              openout_any: "p",
              shell_escape: "f",
            },
          });
        } catch (error) {
          resolve(
            NextResponse.json(
              {
                error: `Clean failed: ${
                  error instanceof Error ? error.message : "Unable to start latexmk"
                }`,
              },
              { status: 500 }
            )
          );
          return;
        }

        let output = "";
        let settled = false;
        let timedOut = false;
        const finish = (response: NextResponse) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(response);
        };
        const timeout = setTimeout(() => {
          timedOut = true;
          WindowsProcessTreeManager.killChildProcess(child);
        }, CLEAN_TIMEOUT_MS);
        timeout.unref?.();

        child.stdout?.on("data", (chunk: Buffer) => {
          output = appendBounded(output, chunk);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          output = appendBounded(output, chunk);
        });

        child.once("error", (error: NodeJS.ErrnoException) => {
          finish(
            NextResponse.json(
              { error: `Clean failed: ${error.message}` },
              { status: 500 }
            )
          );
        });

        child.once("close", (code) => {
          if (timedOut) {
            finish(
              NextResponse.json({ error: "Clean timed out" }, { status: 504 })
            );
            return;
          }

          if (code !== 0) {
            finish(
              NextResponse.json(
                {
                  error: `Clean exited with code ${code}`,
                  output: output.trim().slice(0, 4000),
                },
                { status: 500 }
              )
            );
            return;
          }

          void (async () => {
            if (deepClean) {
              await db
                .update(builds)
                .set({ pdfPath: null })
                .where(eq(builds.projectId, projectId));
            }
            finish(
              NextResponse.json({
                success: true,
                deep: deepClean,
                message: deepClean
                  ? "Deep clean complete. All generated files including PDF have been removed."
                  : "Clean complete. Auxiliary files have been removed.",
              })
            );
          })().catch((error: unknown) => {
            finish(
              NextResponse.json(
                {
                  error:
                    error instanceof Error
                      ? error.message
                      : "Clean completed but metadata update failed",
                },
                { status: 500 }
              )
            );
          });
        });
      });
    });
  } catch (error) {
    console.error("Error cleaning project:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  } finally {
    releaseCleanTask();
  }
}
