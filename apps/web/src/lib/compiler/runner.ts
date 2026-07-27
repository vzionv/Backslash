import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import fs from "fs/promises";
import path from "path";

import { builds } from "@/lib/db/schema";
import { getProjectDir, getPdfPath, fileExists } from "@/lib/storage";
import {
  assertProjectPathHasNoSymlink,
  normalizeProjectTexPath,
  resolveProjectPath,
} from "@/lib/storage/path-security";
import { parseLatexLog } from "./logParser";
import { injectMissingPackages } from "./preamble";
import { broadcastBuildUpdate } from "@/lib/websocket/server";
import {
  getCompileTaskManager,
  type CompileTask,
} from "./compile-task-manager";
import { detectEngineFromSource } from "./main-file-resolver";
import { compileConfig } from "./config";
import { selectBuildIdsForRetentionCleanup } from "./build-retention";
import { executeLatexProcess, truncateCompilerLog } from "./process-executor";
import { copyProjectForCompilation } from "./project-copy";
import type { Engine } from "@backslash/shared";

const STORAGE_PATH = compileConfig.storagePath;

// ─── Types ───────────────────────────────────────────

export interface CompileJobData {
  buildId: string;
  projectId: string;
  userId: string;
  storageUserId: string;
  engine: Engine;
  mainFile: string;
  triggeredByUserId: string | null;
}

export interface CompileJobResult {
  success: boolean;
  exitCode: number;
  logs: string;
  pdfPath: string | null;
  durationMs: number;
}

export interface RunnerHealth {
  running: boolean;
  activeJobs: number;
  maxConcurrent: number;
  totalProcessed: number;
  totalErrors: number;
  uptimeMs: number;
}

// ─── Configuration ───────────────────────────────────

const STALE_BUILD_TTL_MINUTES = parseInt(
  process.env.STALE_BUILD_TTL_MINUTES || "60",
  10
);
const BUILD_RETENTION_DAYS = Math.max(
  parseInt(process.env.BUILD_RETENTION_DAYS || "30", 10),
  1
);
const BUILD_RETENTION_MAX_PER_PROJECT = Math.max(
  parseInt(process.env.BUILD_RETENTION_MAX_PER_PROJECT || "50", 10),
  1
);
const BUILD_CLEANUP_INTERVAL_MS = Math.max(
  parseInt(process.env.BUILD_CLEANUP_INTERVAL_MINUTES || "60", 10),
  1
) * 60_000;

async function compileInDirectory(
  directory: string,
  mainFile: string,
  engine: Engine,
  signal: AbortSignal
): Promise<{
  exitCode: number;
  logs: string;
  timedOut: boolean;
  canceled: boolean;
  engineUsed: Exclude<Engine, "auto">;
}> {
  let engineUsed: Exclude<Engine, "auto">;
  if (engine !== "auto") {
    engineUsed = engine;
  } else {
    try {
      engineUsed = detectEngineFromSource(
        await fs.readFile(path.join(directory, mainFile), "utf-8")
      );
    } catch {
      engineUsed = compileConfig.defaultEngine as Exclude<Engine, "auto">;
    }
  }

  return {
    ...(await executeLatexProcess(directory, engineUsed, mainFile, signal)),
    engineUsed,
  };
}

// ─── CompileRunner Class ─────────────────────────────

class CompileRunner {
  private taskManager = getCompileTaskManager();

  private running = false;
  private totalProcessed = 0;
  private totalErrors = 0;
  private startedAt: number = Date.now();
  private activeControllers = new Map<string, AbortController>();
  private staleBuildsCleaned = false;
  private buildCleanupTimer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.running) return;

    this.running = true;
    this.startedAt = Date.now();
    this.buildCleanupTimer = setInterval(() => {
      void cleanRetainedBuildRecords();
    }, BUILD_CLEANUP_INTERVAL_MS);
    this.buildCleanupTimer.unref?.();

    console.log(
      `[Runner] Compile runner started (concurrency=${this.taskManager.getStats().maxConcurrent})`
    );
  }

  async addJob(data: CompileJobData): Promise<void> {
    if (!this.running) {
      this.start();
    }

    const controller = new AbortController();
    this.activeControllers.set(data.buildId, controller);

    const task: CompileTask = {
      taskId: data.buildId,
      projectId: data.projectId,
      deduplicationKey: data.projectId,
      status: "waiting",
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      abortController: controller,
      onDiscarded: (() => {
        let discarded = false;
        return () => {
          if (discarded) return;
          discarded = true;
          this.activeControllers.delete(data.buildId);
          void updateBuildDiscarded(data.buildId);
          broadcastBuildUpdate(data.userId, {
            projectId: data.projectId,
            buildId: data.buildId,
            status: "canceled",
            pdfUrl: null,
            logs: "Build canceled before execution.",
            durationMs: 0,
            errors: [],
            triggeredByUserId: data.triggeredByUserId ?? null,
          });
        };
      })(),
      run: async () => {
        await this.processJob(data, controller);
      },
    };

    try {
      this.taskManager.enqueue(task);
    } catch (error) {
      task.onDiscarded?.();
      throw error;
    }
    console.log(`[Runner] Job queued: ${data.buildId}`);
  }

  private async processJob(
    data: CompileJobData,
    controller: AbortController
  ): Promise<void> {
    const { buildId, projectId, userId, engine } = data;
    const storageUserId = data.storageUserId ?? userId;
    const notifyUserId = userId;
    const actorUserId = data.triggeredByUserId ?? null;
    const startTime = Date.now();

    // Isolated build directory to prevent race conditions between concurrent builds
    const buildDir = path.join(STORAGE_PATH, "builds", buildId);

    try {
      const mainFile = normalizeProjectTexPath(data.mainFile);
      if (!this.staleBuildsCleaned) {
        this.staleBuildsCleaned = true;
        await cleanStaleBuildRecords();
      }

      // Step 1: Mark as compiling
      await updateBuildStatus(buildId, "compiling");

      broadcastBuildUpdate(notifyUserId, {
        projectId,
        buildId,
        status: "compiling",
        triggeredByUserId: actorUserId,
      });

      // Step 2: Copy project files to isolated build directory
      const projectDir = getProjectDir(storageUserId, projectId);
      await assertProjectPathHasNoSymlink(projectDir, mainFile);
      await copyProjectForCompilation(projectDir, buildDir);
      console.log(`[Runner] Copied project files to build dir: ${buildDir}`);

      // Step 2.5: Auto-inject missing LaTeX packages into the build copy
      await injectMissingPackages(buildDir, mainFile);

      // Step 3: Run the native LaTeX compilation against the isolated build dir
      const compileResult = await compileInDirectory(
        buildDir,
        mainFile,
        engine,
        controller.signal
      );

      console.log(
        `[Runner] Compilation finished for job ${buildId}, processing results...`
      );

      const durationMs = Date.now() - startTime;

      const parsedEntries = parseLatexLog(compileResult.logs);
      const hasErrors = parsedEntries.some((e) => e.type === "error");
      const buildErrors = compileResult.canceled
        ? []
        : parsedEntries.filter((e) => e.type === "error");
      let pdfExists = false;
      let outputLimitExceeded = false;
      const pdfOutputPath = getPdfPath(storageUserId, projectId, mainFile);

      if (!compileResult.canceled) {
        // Check for PDF in the build directory (compilation happened in buildDir)
        const pdfName = mainFile.replace(/\.tex$/i, ".pdf");
        const buildPdfPath = resolveProjectPath(buildDir, pdfName);
        const pdfInBuild = await fileExists(buildPdfPath);

        // Copy only a newly generated PDF that is within the configured cap.
        if (pdfInBuild) {
          const outputBytes = (await fs.stat(buildPdfPath)).size;
          const maxOutputBytes = compileConfig.maxOutputSizeMB * 1024 * 1024;
          if (outputBytes > maxOutputBytes) {
            outputLimitExceeded = true;
            compileResult.logs +=
              `\n[Backslash] Generated PDF is ${outputBytes} bytes; ` +
              `limit is ${maxOutputBytes} bytes.`;
          } else {
            await assertProjectPathHasNoSymlink(projectDir, pdfName);
            await fs.mkdir(path.dirname(pdfOutputPath), { recursive: true });
            await fs.copyFile(buildPdfPath, pdfOutputPath);
            pdfExists = await fileExists(pdfOutputPath);
          }
        }
      }

      // Determine final status
      let finalStatus: "success" | "error" | "timeout" | "canceled";
      if (compileResult.canceled) {
        finalStatus = "canceled";
      } else if (compileResult.timedOut) {
        finalStatus = "timeout";
      } else if (
        compileResult.exitCode !== 0 ||
        hasErrors ||
        outputLimitExceeded ||
        !pdfExists
      ) {
        finalStatus = "error";
      } else {
        finalStatus = "success";
      }

      // Step 4: Update database
      const retainedLogs = compileResult.canceled
        ? "Build canceled by user."
        : truncateCompilerLog(
            compileResult.logs,
            compileConfig.maxPersistedLogBytes
          );

      const completionPatch = {
        engine: compileResult.engineUsed,
        status: finalStatus,
        logs: retainedLogs,
        durationMs,
        exitCode: compileResult.exitCode,
        pdfPath: pdfExists ? pdfOutputPath : null,
        completedAt: new Date().toISOString(),
      };

      const db = await getDatabase();
      await db
        .update(builds)
        .set(completionPatch)
        .where(eq(builds.id, buildId));

      // Step 5: Broadcast completion
      broadcastBuildUpdate(notifyUserId, {
        projectId,
        buildId,
        status: finalStatus,
        pdfUrl: pdfExists ? `/api/projects/${projectId}/pdf` : null,
        logs: retainedLogs,
        durationMs,
        errors: buildErrors,
        triggeredByUserId: actorUserId,
      });

      this.totalProcessed++;
      console.log(`[Runner] Job ${buildId} completed with status=${finalStatus}`);
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Update the build as errored
      await updateBuildError(buildId, errorMessage, durationMs);

      // Broadcast the error
      broadcastBuildUpdate(notifyUserId, {
        projectId,
        buildId,
        status: "error",
        pdfUrl: null,
        logs: `Internal compilation error: ${errorMessage}`,
        durationMs,
        errors: [
          {
            type: "error",
            file: "system",
            line: 0,
            message: `Compilation infrastructure error: ${errorMessage}`,
          },
        ],
        triggeredByUserId: actorUserId,
      });

      this.totalErrors++;
      console.error(`[Runner] Job ${buildId} failed: ${errorMessage}`);
      throw err;
    } finally {
      this.activeControllers.delete(buildId);
      // Always clean up the isolated build directory
      try {
        await fs.rm(buildDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  getHealth(): RunnerHealth {
    const stats = this.taskManager.getStats();
    return {
      running: this.running,
      activeJobs: stats.running,
      maxConcurrent: stats.maxConcurrent,
      totalProcessed: this.totalProcessed,
      totalErrors: this.totalErrors,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  async shutdown(): Promise<void> {
    console.log("[Runner] Shutting down compile runner...");
    this.running = false;
    if (this.buildCleanupTimer) {
      clearInterval(this.buildCleanupTimer);
      this.buildCleanupTimer = null;
    }

    await this.taskManager.shutdown();

    console.log("[Runner] Compile runner stopped");
  }

  async cancelBuild(
    buildId: string
  ): Promise<{ wasQueued: boolean; wasRunning: boolean }> {
    const result = this.taskManager.cancelByTaskId(buildId);
    return {
      wasQueued: result.wasQueued,
      wasRunning: result.wasRunning,
    };
  }
}

// ─── Database Helpers ────────────────────────────────

async function getDatabase() {
  const { db } = await import("@/lib/db");
  return db;
}

async function updateBuildStatus(
  buildId: string,
  status: "queued" | "compiling"
): Promise<void> {
  const db = await getDatabase();
  await db
    .update(builds)
    .set({ status })
    .where(eq(builds.id, buildId));
}

async function updateBuildDiscarded(buildId: string): Promise<void> {
  try {
    const db = await getDatabase();
    await db
      .update(builds)
      .set({
        status: "canceled",
        logs: "Build canceled before execution.",
        durationMs: 0,
        exitCode: null,
        completedAt: new Date().toISOString(),
      })
      .where(and(eq(builds.id, buildId), eq(builds.status, "queued")));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[Runner] Failed to persist discarded build ${buildId}: ${message}\n`
    );
  }
}

async function updateBuildError(
  buildId: string,
  errorMessage: string,
  durationMs: number
): Promise<void> {
  const db = await getDatabase();
  await db
    .update(builds)
    .set({
      status: "error",
      logs: `Internal compilation error: ${errorMessage}`,
      durationMs,
      exitCode: -1,
      completedAt: new Date().toISOString(),
    })
    .where(eq(builds.id, buildId));
}

async function cleanRetainedBuildRecords(): Promise<void> {
  try {
    const db = await getDatabase();
    const terminalBuilds = await db
      .select({
        id: builds.id,
        projectId: builds.projectId,
        createdAt: builds.createdAt,
      })
      .from(builds)
      .where(
        or(
          eq(builds.status, "success"),
          eq(builds.status, "error"),
          eq(builds.status, "timeout"),
          eq(builds.status, "canceled")
        )
      )
      .orderBy(builds.projectId, desc(builds.createdAt));
    const buildIds = selectBuildIdsForRetentionCleanup(
      terminalBuilds,
      BUILD_RETENTION_DAYS,
      BUILD_RETENTION_MAX_PER_PROJECT
    );
    if (buildIds.length > 0) {
      await db.delete(builds).where(inArray(builds.id, buildIds));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[Runner] Failed to clean retained builds: ${message}\n`);
  }
}

async function cleanStaleBuildRecords(): Promise<void> {
  try {
    const db = await getDatabase();
    const cutoff = new Date(
      Date.now() - Math.max(STALE_BUILD_TTL_MINUTES, 1) * 60_000
    );
    // Find stale builds first (SQLite doesn't support .returning())
    const staleBuilds = await db
      .select({ id: builds.id })
      .from(builds)
      .where(
        and(
          inArray(builds.status, ["queued", "compiling"]),
          lt(builds.createdAt, cutoff.toISOString())
        )
      );

    if (staleBuilds.length > 0) {
      await db
        .update(builds)
        .set({
          status: "error",
          logs: "Build interrupted — server restarted. Please recompile.",
          completedAt: new Date().toISOString(),
        })
        .where(
          and(
            inArray(builds.status, ["queued", "compiling"]),
            lt(builds.createdAt, cutoff.toISOString())
          )
        );
      console.log(`[Runner] Cleaned ${staleBuilds.length} stale build(s) from previous instance`);
    }
  } catch (err) {
    console.error(
      "[Runner] Failed to clean stale builds:",
      err instanceof Error ? err.message : err
    );
  }
}

// ─── Singleton (survives Next.js hot-reloads) ────────

const RUNNER_KEY = "__backslash_compile_runner__" as const;

function getRunnerInstance(): CompileRunner | null {
  return (
    ((globalThis as unknown) as Record<string, CompileRunner | undefined>)[
      RUNNER_KEY
    ] ?? null
  );
}

function setRunnerInstance(runner: CompileRunner | null): void {
  ((globalThis as unknown) as Record<string, CompileRunner | null>)[
    RUNNER_KEY
  ] = runner;
}

// ─── Public API ──────────────────────────────────────

export function startCompileRunner(): CompileRunner {
  const existing = getRunnerInstance();
  if (existing) {
    return existing;
  }

  const runner = new CompileRunner();
  setRunnerInstance(runner);
  runner.start();
  return runner;
}

export async function addCompileJob(data: CompileJobData): Promise<void> {
  const runner = getRunnerInstance() || startCompileRunner();
  await runner.addJob(data);
}

export async function cancelCompileJob(
  buildId: string
): Promise<{ wasQueued: boolean; wasRunning: boolean }> {
  const runner = getRunnerInstance();
  if (!runner) {
    return { wasQueued: false, wasRunning: false };
  }
  return runner.cancelBuild(buildId);
}

export async function shutdownRunner(): Promise<void> {
  const runner = getRunnerInstance();
  if (runner) {
    await runner.shutdown();
    setRunnerInstance(null);
  }
}

export function getRunnerHealth(): RunnerHealth | null {
  const runner = getRunnerInstance();
  return runner ? runner.getHealth() : null;
}
