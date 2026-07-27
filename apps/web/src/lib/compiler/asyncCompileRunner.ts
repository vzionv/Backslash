import fs from "fs/promises";
import path from "path";
import { parseLatexLog } from "./logParser";
import {
  computeAsyncCompileExpiryIso,
  deleteAsyncCompileJob,
  getAsyncCompileJobDir,
  getAsyncCompilePdfPath,
  isExpired,
  isTerminalStatus,
  listAsyncCompileJobIds,
  patchAsyncCompileMetadata,
  readAsyncCompileMetadata,
  writeAsyncCompileErrors,
  writeAsyncCompileLogs,
} from "./asyncCompileStore";
import {
  getCompileTaskManager,
  type CompileTask,
} from "./compile-task-manager";
import { detectEngineFromSource } from "./main-file-resolver";
import { compileConfig } from "./config";
import { executeLatexProcess } from "./process-executor";
import type { Engine } from "@backslash/shared";

export interface AsyncCompileJobData {
  jobId: string;
  userId: string;
  engine: Engine;
  mainFile: string;
}

export interface AsyncCompileRunnerHealth {
  running: boolean;
  activeJobs: number;
  maxConcurrent: number;
  totalProcessed: number;
  totalErrors: number;
  uptimeMs: number;
}

const ASYNC_CLEANUP_INTERVAL_MS = Math.max(
  parseInt(process.env.ASYNC_COMPILE_CLEANUP_INTERVAL_MINUTES || "15", 10),
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

class AsyncCompileRunner {
  private taskManager = getCompileTaskManager();
  private running = false;
  private totalProcessed = 0;
  private totalErrors = 0;
  private startedAt = Date.now();
  private activeControllers = new Map<string, AbortController>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.running) return;

    this.running = true;
    this.startedAt = Date.now();
    void cleanExpiredAsyncCompileJobs();
    this.cleanupTimer = setInterval(() => {
      void cleanExpiredAsyncCompileJobs();
    }, ASYNC_CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();

    console.log(
      `[AsyncCompileRunner] Started (concurrency=${this.taskManager.getStats().maxConcurrent})`
    );
  }

  async addJob(data: AsyncCompileJobData): Promise<void> {
    if (!this.running) {
      this.start();
    }

    const controller = new AbortController();
    this.activeControllers.set(data.jobId, controller);

    const task: CompileTask = {
      taskId: data.jobId,
      projectId: data.jobId,
      status: "waiting",
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      abortController: controller,
      onDiscarded: () => this.activeControllers.delete(data.jobId),
      run: async () => {
        await this.processJob(data, controller);
      },
    };

    this.taskManager.enqueue(task);
    console.log(`[AsyncCompileRunner] Job queued: ${data.jobId}`);
  }

  private async processJob(
    data: AsyncCompileJobData,
    controller: AbortController
  ): Promise<void> {
    const { jobId, engine, mainFile } = data;
    const startTime = Date.now();

    try {
      const meta = await readAsyncCompileMetadata(jobId);
      if (!meta) {
        throw new Error("Async compile metadata not found");
      }

      await patchAsyncCompileMetadata(jobId, {
        status: "compiling",
        startedAt: new Date().toISOString(),
        message: undefined,
      });

      const jobDir = getAsyncCompileJobDir(jobId);
      const compileResult = await compileInDirectory(
        jobDir,
        mainFile,
        engine,
        controller.signal
      );

      const durationMs = Date.now() - startTime;
      const parsedEntries = parseLatexLog(compileResult.logs);
      const hasErrors = parsedEntries.some((e) => e.type === "error");
      const errorCount = parsedEntries.filter((e) => e.type === "error").length;
      const warningCount = parsedEntries.filter(
        (e) => e.type === "warning"
      ).length;

      const pdfPath = getAsyncCompilePdfPath(jobId, mainFile);
      let pdfExists = await fs
        .access(pdfPath)
        .then(() => true)
        .catch(() => false);
      let outputLimitExceeded = false;
      if (pdfExists) {
        const outputBytes = (await fs.stat(pdfPath)).size;
        const maxOutputBytes = compileConfig.maxOutputSizeMB * 1024 * 1024;
        if (outputBytes > maxOutputBytes) {
          outputLimitExceeded = true;
          pdfExists = false;
          await fs.rm(pdfPath, { force: true });
          compileResult.logs +=
            `\n[Backslash] Generated PDF is ${outputBytes} bytes; ` +
            `limit is ${maxOutputBytes} bytes.`;
        }
      }

      const logsFile = await writeAsyncCompileLogs(
        jobId,
        compileResult.canceled ? "Build canceled by user." : compileResult.logs
      );
      const errorsFile = await writeAsyncCompileErrors(jobId, parsedEntries);

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

      await patchAsyncCompileMetadata(jobId, {
        status: finalStatus,
        engineUsed: compileResult.engineUsed,
        logsPath: logsFile,
        errorsPath: errorsFile,
        pdfPath: pdfExists ? path.basename(pdfPath) : undefined,
        errorCount,
        warningCount,
        durationMs,
        exitCode: compileResult.exitCode,
        completedAt: new Date().toISOString(),
        expiresAt: computeAsyncCompileExpiryIso(),
        message: compileResult.canceled
          ? "Build canceled by user."
          : undefined,
      });

      this.totalProcessed++;
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);
      await patchAsyncCompileMetadata(jobId, {
        status: "error",
        message: `Compilation infrastructure error: ${errorMessage}`,
        durationMs,
        exitCode: -1,
        completedAt: new Date().toISOString(),
        expiresAt: computeAsyncCompileExpiryIso(),
      });
      this.totalErrors++;
      throw err;
    } finally {
      this.activeControllers.delete(jobId);
    }
  }

  async cancelJob(
    jobId: string
  ): Promise<{ wasQueued: boolean; wasRunning: boolean }> {
    const result = this.taskManager.cancelByTaskId(jobId);

    if (!result.canceled) {
      // Fallback: try to cancel by direct controller
      const controller = this.activeControllers.get(jobId);
      if (controller) {
        controller.abort();
        result.wasRunning = true;
      }
    }

    if (result.wasQueued && !result.wasRunning) {
      await patchAsyncCompileMetadata(jobId, {
        status: "canceled",
        message: "Build canceled before starting.",
        completedAt: new Date().toISOString(),
        expiresAt: computeAsyncCompileExpiryIso(),
        exitCode: -1,
      });
    }

    return {
      wasQueued: result.wasQueued,
      wasRunning: result.wasRunning,
    };
  }

  getHealth(): AsyncCompileRunnerHealth {
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
    this.running = false;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    console.log("[AsyncCompileRunner] Shutting down...");
    // Note: we don't shut down the shared taskManager here
    // since it may be used by the regular compile runner too
  }
}

async function cleanExpiredAsyncCompileJobs(): Promise<void> {
  try {
    const ids = await listAsyncCompileJobIds();
    for (const id of ids) {
      const meta = await readAsyncCompileMetadata(id);
      if (!meta) {
        await deleteAsyncCompileJob(id);
        continue;
      }
      if (isTerminalStatus(meta.status) && isExpired(meta)) {
        await deleteAsyncCompileJob(id);
      }
    }
  } catch (err) {
    console.error(
      "[AsyncCompileRunner] Failed to clean expired async compile jobs:",
      err instanceof Error ? err.message : err
    );
  }
}

const RUNNER_KEY = "__backslash_async_compile_runner__" as const;

function getRunnerInstance(): AsyncCompileRunner | null {
  return (
    ((globalThis as unknown) as Record<string, AsyncCompileRunner | undefined>)[
      RUNNER_KEY
    ] ?? null
  );
}

function setRunnerInstance(runner: AsyncCompileRunner | null): void {
  ((globalThis as unknown) as Record<string, AsyncCompileRunner | null>)[
    RUNNER_KEY
  ] = runner;
}

export function startAsyncCompileRunner(): AsyncCompileRunner {
  const existing = getRunnerInstance();
  if (existing) return existing;

  const runner = new AsyncCompileRunner();
  setRunnerInstance(runner);
  runner.start();
  return runner;
}

export async function addAsyncCompileJob(
  data: AsyncCompileJobData
): Promise<void> {
  const runner = getRunnerInstance() || startAsyncCompileRunner();
  await runner.addJob(data);
}

export async function cancelAsyncCompileJob(
  jobId: string
): Promise<{ wasQueued: boolean; wasRunning: boolean }> {
  const runner = getRunnerInstance();
  if (!runner) {
    return { wasQueued: false, wasRunning: false };
  }
  return runner.cancelJob(jobId);
}

export function getAsyncCompileRunnerHealth(): AsyncCompileRunnerHealth | null {
  const runner = getRunnerInstance();
  return runner ? runner.getHealth() : null;
}

export async function shutdownAsyncCompileRunner(): Promise<void> {
  const runner = getRunnerInstance();
  if (!runner) return;
  await runner.shutdown();
  setRunnerInstance(null);
}
