import { NextResponse } from "next/server";
import { getRunnerHealth } from "@/lib/compiler/runner";
import { getAsyncCompileRunnerHealth } from "@/lib/compiler/asyncCompileRunner";
import { getCompileTaskManager } from "@/lib/compiler/compile-task-manager";
import { checkEnvironment } from "@/lib/compiler/environment-check";

interface HealthCheck {
  ok: boolean;
  detail?: string;
}

interface CachedEnvironmentCheck {
  expiresAt: number;
  promise: Promise<HealthCheck>;
}

const ENVIRONMENT_CACHE_TTL_MS = 60_000;
let environmentCache: CachedEnvironmentCheck | null = null;

function getEnvironmentCheck(): Promise<HealthCheck> {
  const now = Date.now();
  if (environmentCache && environmentCache.expiresAt > now) {
    return environmentCache.promise;
  }

  const promise = checkEnvironment()
    .then((result) => ({
      ok: result.ok,
      detail: result.ok ? "all checks passed" : result.errors.join("; "),
    }))
    .catch((error: unknown) => ({
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    }));
  environmentCache = {
    expiresAt: now + ENVIRONMENT_CACHE_TTL_MS,
    promise,
  };
  return promise;
}

// Public health response is intentionally sanitized. Set
// HEALTH_DETAILS_ENABLED=true only on a trusted management network.
export async function GET() {
  const checks: Record<string, HealthCheck> = {};
  checks.environment = await getEnvironmentCheck();

  const runner = getRunnerHealth();
  checks.compile_runner = {
    ok: runner ? runner.running : false,
    detail: runner
      ? `active=${runner.activeJobs}/${runner.maxConcurrent} processed=${runner.totalProcessed} errors=${runner.totalErrors}`
      : "Runner not started",
  };

  const asyncRunner = getAsyncCompileRunnerHealth();
  checks.async_compile_runner = {
    ok: asyncRunner ? asyncRunner.running : false,
    detail: asyncRunner
      ? `active=${asyncRunner.activeJobs}/${asyncRunner.maxConcurrent} processed=${asyncRunner.totalProcessed} errors=${asyncRunner.totalErrors}`
      : "Async runner not started",
  };

  try {
    const stats = getCompileTaskManager().getStats();
    checks.task_manager = {
      ok: stats.accepting,
      detail: `waiting=${stats.waiting}/${stats.maxQueued} running=${stats.running}/${stats.maxConcurrent}`,
    };
  } catch (error) {
    checks.task_manager = {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const allOk = Object.values(checks).every((check) => check.ok);
  const includeDetails = process.env.HEALTH_DETAILS_ENABLED === "true";
  const responseChecks = Object.fromEntries(
    Object.entries(checks).map(([name, check]) => [
      name,
      includeDetails ? check : { ok: check.ok },
    ])
  );

  return NextResponse.json(
    { status: allOk ? "healthy" : "unhealthy", checks: responseChecks },
    {
      status: allOk ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    }
  );
}
