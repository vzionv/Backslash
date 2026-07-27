import { spawn } from "child_process";

import type { Engine } from "@backslash/shared";

import { buildSpawnCommand } from "./latex-command-builder";
import { compileConfig } from "./config";
import { assertConcreteEngineAllowed } from "./engine-policy";
import { WindowsProcessTreeManager } from "./windows-process-tree";

export interface ProcessExecutionResult {
  exitCode: number;
  logs: string;
  timedOut: boolean;
  canceled: boolean;
}

async function collectOutput(
  stream: NodeJS.ReadableStream | null,
  remainingBytes: () => number,
  consumeBytes: (bytes: number) => void
): Promise<string> {
  if (!stream) return "";

  const chunks: Buffer[] = [];
  return new Promise((resolve) => {
    stream.on("data", (chunk: Buffer) => {
      const remaining = remainingBytes();
      if (remaining <= 0) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const retained = buffer.subarray(0, Math.min(buffer.length, remaining));
      chunks.push(retained);
      consumeBytes(retained.length);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    stream.on("error", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

export function truncateCompilerLog(logs: string, maxBytes: number): string {
  const buffer = Buffer.from(logs, "utf-8");
  if (buffer.length <= maxBytes) return logs;
  const suffix = `\n\n[Backslash] Stored build log truncated at ${maxBytes} bytes.`;
  const suffixBytes = Buffer.byteLength(suffix);
  return buffer
    .subarray(0, Math.max(0, maxBytes - suffixBytes))
    .toString("utf-8") + suffix;
}

export async function executeLatexProcess(
  directory: string,
  engine: Exclude<Engine, "auto">,
  mainFile: string,
  signal: AbortSignal
): Promise<ProcessExecutionResult> {
  assertConcreteEngineAllowed(engine);
  const { executable, args } = buildSpawnCommand(engine, mainFile);
  const childProcess = spawn(executable, args, {
    cwd: directory,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      HOME: directory,
      TEXMFOUTPUT: directory,
      openin_any: "p",
      openout_any: "p",
      shell_escape: compileConfig.allowShellEscape ? "t" : "f",
    },
  });
  const maxLogBytes = compileConfig.maxLogBytes;
  let retainedBytes = 0;
  let timedOut = false;
  let canceled = false;
  const timeout =
    compileConfig.compileTimeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          WindowsProcessTreeManager.killChildProcess(childProcess);
        }, compileConfig.compileTimeoutMs)
      : null;
  timeout?.unref?.();
  const abort = () => {
    canceled = true;
    if (timeout) clearTimeout(timeout);
    WindowsProcessTreeManager.killChildProcess(childProcess);
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });

  const remainingBytes = () => maxLogBytes - retainedBytes;
  const consumeBytes = (bytes: number) => {
    retainedBytes += bytes;
  };
  const stdout = collectOutput(childProcess.stdout, remainingBytes, consumeBytes);
  const stderr = collectOutput(childProcess.stderr, remainingBytes, consumeBytes);
  const exitCode = await new Promise<number>((resolve) => {
    childProcess.once("error", () => resolve(-1));
    childProcess.once("close", (code) => resolve(code ?? -1));
  });
  if (timeout) clearTimeout(timeout);
  signal.removeEventListener("abort", abort);

  let logs = [await stdout, await stderr].filter(Boolean).join("\n");
  if (retainedBytes >= maxLogBytes) {
    logs += `\n\n[Backslash] Compiler output truncated at ${maxLogBytes} bytes.`;
  }
  return {
    exitCode: timedOut ? -1 : exitCode,
    logs: canceled ? "Build canceled by user." : logs,
    timedOut,
    canceled,
  };
}
