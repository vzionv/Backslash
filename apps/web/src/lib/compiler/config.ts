import path from "path";

import type { Engine } from "@backslash/shared";

const STORAGE_PATH = process.env.STORAGE_PATH || "./data";
const VALID_ENGINES = new Set<Exclude<Engine, "auto">>([
  "pdflatex",
  "xelatex",
  "latex",
]);

function readBoundedInteger(
  name: string,
  fallback: number,
  options: { min?: number; max?: number } = {}
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw);
  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function resolveTexliveBin(): string {
  return process.env.TEXLIVE_BIN || "";
}

function resolveLatexmkPath(): string {
  if (process.env.LATEXMK_PATH) return process.env.LATEXMK_PATH;
  const bin = resolveTexliveBin();
  if (!bin) return "latexmk";
  return path.join(bin, process.platform === "win32" ? "latexmk.exe" : "latexmk");
}

function resolveDefaultEngine(): Exclude<Engine, "auto"> {
  const engine = (process.env.DEFAULT_LATEX_ENGINE || "xelatex") as Exclude<
    Engine,
    "auto"
  >;
  if (!VALID_ENGINES.has(engine)) {
    throw new Error(
      "DEFAULT_LATEX_ENGINE must be one of: pdflatex, xelatex, latex"
    );
  }
  return engine;
}

export const compileConfig = {
  texliveBin: resolveTexliveBin(),
  latexmkPath: resolveLatexmkPath(),
  defaultEngine: resolveDefaultEngine(),
  compileTimeoutMs: readBoundedInteger("COMPILE_TIMEOUT_MS", 120_000, {
    min: 1_000,
    max: 3_600_000,
  }),
  maxConcurrentCompilations: readBoundedInteger(
    "MAX_CONCURRENT_COMPILATIONS",
    2,
    { min: 1, max: 64 }
  ),
  maxQueuedCompilations: readBoundedInteger("MAX_QUEUED_COMPILATIONS", 200, {
    min: 1,
    max: 10_000,
  }),
  taskHistoryLimit: readBoundedInteger("COMPILE_TASK_HISTORY_LIMIT", 200, {
    min: 0,
    max: 100_000,
  }),
  taskHistoryTtlMs:
    readBoundedInteger("COMPILE_TASK_HISTORY_TTL_MINUTES", 60, {
      min: 1,
      max: 10_080,
    }) * 60_000,
  tempRoot:
    process.env.LATEX_TEMP_ROOT || path.join(STORAGE_PATH, "compile-temp"),
  outputRoot:
    process.env.LATEX_OUTPUT_ROOT || path.join(STORAGE_PATH, "compile-output"),
  allowShellEscape: process.env.LATEX_ALLOW_SHELL_ESCAPE === "true",
  haltOnError: process.env.LATEX_HALT_ON_ERROR !== "false",
  maxProjectSizeMB: readBoundedInteger("LATEX_MAX_PROJECT_SIZE_MB", 200, {
    min: 1,
    max: 10_240,
  }),
  maxOutputSizeMB: readBoundedInteger("LATEX_MAX_OUTPUT_SIZE_MB", 200, {
    min: 1,
    max: 10_240,
  }),
  maxLogBytes: readBoundedInteger("COMPILE_LOG_MAX_BYTES", 10_485_760, {
    min: 1_024,
    max: 268_435_456,
  }),
  maxPersistedLogBytes: readBoundedInteger(
    "BUILD_LOG_DB_MAX_BYTES",
    1_048_576,
    { min: 1_024, max: 67_108_864 }
  ),
  keepFailedWorkdir: process.env.LATEX_KEEP_FAILED_WORKDIR === "true",
  storagePath: STORAGE_PATH,
} as const;
