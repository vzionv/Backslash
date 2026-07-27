import fs from "fs/promises";
import path from "path";
import type { BuildStatus, Engine, ParsedLogEntry } from "@backslash/shared";
import { normalizeProjectTexPath } from "@/lib/storage/path-security";
import { stageFileWrite } from "@/lib/storage/staged-mutation";

const STORAGE_PATH = process.env.STORAGE_PATH || "./data";
const ASYNC_COMPILE_ROOT = path.join(STORAGE_PATH, "async-compiles");
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const metadataLocks = new Map<string, Promise<void>>();

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export const ASYNC_COMPILE_RESULT_TTL_MINUTES = readPositiveInteger(
  "ASYNC_COMPILE_RESULT_TTL_MINUTES",
  60
);

export type AsyncCompileStatus = BuildStatus;

export interface AsyncCompileMetadata {
  id: string;
  userId: string;
  status: AsyncCompileStatus;
  requestedEngine: Engine;
  engineUsed?: Exclude<Engine, "auto">;
  mainFile: string;
  sourcePath: string;
  pdfPath?: string;
  logsPath?: string;
  errorsPath?: string;
  warningCount: number;
  errorCount: number;
  durationMs?: number;
  exitCode?: number;
  message?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  expiresAt?: string;
}


export function assertAsyncCompileJobId(jobId: string): string {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new Error("Invalid async compile job id");
  }
  return jobId;
}

async function withMetadataLock<T>(
  jobId: string,
  operation: () => Promise<T>
): Promise<T> {
  assertAsyncCompileJobId(jobId);
  const previous = metadataLocks.get(jobId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  metadataLocks.set(jobId, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (metadataLocks.get(jobId) === tail) metadataLocks.delete(jobId);
  }
}

async function writeMetadataAtomic(meta: AsyncCompileMetadata): Promise<void> {
  const metadataPath = getAsyncCompileMetadataPath(meta.id);
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  const mutation = await stageFileWrite(
    metadataPath,
    JSON.stringify(meta, null, 2)
  );
  await mutation.commit();
}

export function getAsyncCompileRootDir(): string {
  return ASYNC_COMPILE_ROOT;
}

export function getAsyncCompileJobDir(jobId: string): string {
  return path.join(ASYNC_COMPILE_ROOT, assertAsyncCompileJobId(jobId));
}

export function getAsyncCompileMetadataPath(jobId: string): string {
  return path.join(getAsyncCompileJobDir(jobId), "metadata.json");
}

export function getAsyncCompileSourcePath(
  jobId: string,
  mainFile: string = "main.tex"
): string {
  return path.join(
    getAsyncCompileJobDir(jobId),
    normalizeProjectTexPath(mainFile)
  );
}

export function getAsyncCompilePdfPath(
  jobId: string,
  mainFile: string = "main.tex"
): string {
  return path.join(
    getAsyncCompileJobDir(jobId),
    normalizeProjectTexPath(mainFile).replace(/\.tex$/i, ".pdf")
  );
}

export function getAsyncCompileLogsPath(jobId: string): string {
  return path.join(getAsyncCompileJobDir(jobId), "compile.log");
}

export function getAsyncCompileErrorsPath(jobId: string): string {
  return path.join(getAsyncCompileJobDir(jobId), "errors.json");
}

export function computeAsyncCompileExpiryIso(): string {
  return new Date(
    Date.now() + ASYNC_COMPILE_RESULT_TTL_MINUTES * 60_000
  ).toISOString();
}

export function isTerminalStatus(status: AsyncCompileStatus): boolean {
  return ["success", "error", "timeout", "canceled"].includes(status);
}

export function isExpired(meta: AsyncCompileMetadata): boolean {
  if (!meta.expiresAt) return false;
  return new Date(meta.expiresAt).getTime() <= Date.now();
}

export async function ensureAsyncCompileRootDir(): Promise<void> {
  await fs.mkdir(ASYNC_COMPILE_ROOT, { recursive: true });
}

export async function createAsyncCompileJob(params: {
  jobId: string;
  userId: string;
  source: string;
  requestedEngine: Engine;
  mainFile?: string;
}): Promise<AsyncCompileMetadata> {
  const mainFile = params.mainFile ?? "main.tex";
  const jobDir = getAsyncCompileJobDir(params.jobId);
  await fs.mkdir(jobDir, { recursive: true });

  const sourcePath = getAsyncCompileSourcePath(params.jobId, mainFile);

  const nowIso = new Date().toISOString();
  const meta: AsyncCompileMetadata = {
    id: params.jobId,
    userId: params.userId,
    status: "queued",
    requestedEngine: params.requestedEngine,
    mainFile,
    sourcePath: path.basename(sourcePath),
    warningCount: 0,
    errorCount: 0,
    createdAt: nowIso,
  };

  try {
    await fs.writeFile(sourcePath, params.source, {
      encoding: "utf-8",
      flag: "wx",
    });
    await writeAsyncCompileMetadata(meta);
    return meta;
  } catch (error) {
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readAsyncCompileMetadata(
  jobId: string
): Promise<AsyncCompileMetadata | null> {
  try {
    const raw = await fs.readFile(getAsyncCompileMetadataPath(jobId), "utf-8");
    return JSON.parse(raw) as AsyncCompileMetadata;
  } catch {
    return null;
  }
}

export async function writeAsyncCompileMetadata(
  meta: AsyncCompileMetadata
): Promise<void> {
  await withMetadataLock(meta.id, () => writeMetadataAtomic(meta));
}

export async function patchAsyncCompileMetadata(
  jobId: string,
  patch: Partial<AsyncCompileMetadata>
): Promise<AsyncCompileMetadata | null> {
  return withMetadataLock(jobId, async () => {
    const current = await readAsyncCompileMetadata(jobId);
    if (!current) return null;
    const next = {
      ...current,
      ...patch,
    };
    await writeMetadataAtomic(next);
    return next;
  });
}

export async function writeAsyncCompileLogs(
  jobId: string,
  logs: string
): Promise<string> {
  const logsPath = getAsyncCompileLogsPath(jobId);
  await fs.mkdir(path.dirname(logsPath), { recursive: true });
  await fs.writeFile(logsPath, logs, "utf-8");
  return path.basename(logsPath);
}

export async function readAsyncCompileLogs(jobId: string): Promise<string> {
  try {
    return await fs.readFile(getAsyncCompileLogsPath(jobId), "utf-8");
  } catch {
    return "";
  }
}

export async function writeAsyncCompileErrors(
  jobId: string,
  entries: ParsedLogEntry[]
): Promise<string> {
  const errorsPath = getAsyncCompileErrorsPath(jobId);
  await fs.mkdir(path.dirname(errorsPath), { recursive: true });
  await fs.writeFile(errorsPath, JSON.stringify(entries, null, 2), "utf-8");
  return path.basename(errorsPath);
}

export async function readAsyncCompileErrors(
  jobId: string
): Promise<ParsedLogEntry[]> {
  try {
    const raw = await fs.readFile(getAsyncCompileErrorsPath(jobId), "utf-8");
    return JSON.parse(raw) as ParsedLogEntry[];
  } catch {
    return [];
  }
}

export async function deleteAsyncCompileJob(jobId: string): Promise<void> {
  await fs.rm(getAsyncCompileJobDir(jobId), { recursive: true, force: true });
}

export async function listAsyncCompileJobIds(): Promise<string[]> {
  try {
    await ensureAsyncCompileRootDir();
    const entries = await fs.readdir(ASYNC_COMPILE_ROOT, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && JOB_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

