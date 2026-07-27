import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { compileConfig } from "./config";

interface EnvironmentCheckResult {
  ok: boolean;
  errors: string[];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function dirWritable(dirPath: string): Promise<boolean> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
    const testFile = `${dirPath}/.write-test-${Date.now()}`;
    await fs.writeFile(testFile, "test");
    await fs.unlink(testFile);
    return true;
  } catch {
    return false;
  }
}

function runVersionCheck(
  executable: string
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(executable, ["-version"], {
      shell: false,
      timeout: 15_000,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      resolve({ ok: false, output: err.message });
    });

    child.on("close", (code) => {
      const output = stdout + stderr;
      if (code === 0 && output.length > 0) {
        resolve({ ok: true, output: output.trim() });
      } else {
        resolve({
          ok: false,
          output: output.trim() || `exit code ${code}`,
        });
      }
    });
  });
}

export async function checkEnvironment(): Promise<EnvironmentCheckResult> {
  const errors: string[] = [];

  // 0. Check STORAGE_PATH is set to an absolute path
  if (compileConfig.storagePath === "./data") {
    errors.push(
      `STORAGE_PATH is not set. Using default "./data" (relative to server CWD). ` +
      `Set STORAGE_PATH to an absolute path, e.g. STORAGE_PATH=/data/backslash`
    );
  } else if (!path.isAbsolute(compileConfig.storagePath)) {
    errors.push(
      `STORAGE_PATH must be an absolute path, got: ${compileConfig.storagePath}`
    );
  }

  // 1. Check latexmk.exe exists
  const latexmkExists = await fileExists(compileConfig.latexmkPath);
  if (!latexmkExists) {
    errors.push(
      `latexmk not found at: ${compileConfig.latexmkPath}. Set LATEXMK_PATH or TEXLIVE_BIN.`
    );
  }

  // 2. Check temp directory is writable
  const tempWritable = await dirWritable(compileConfig.tempRoot);
  if (!tempWritable) {
    errors.push(
      `Temp directory not writable: ${compileConfig.tempRoot}. Set LATEX_TEMP_ROOT.`
    );
  }

  // 3. Check output directory is writable
  const outputWritable = await dirWritable(compileConfig.outputRoot);
  if (!outputWritable) {
    errors.push(
      `Output directory not writable: ${compileConfig.outputRoot}. Set LATEX_OUTPUT_ROOT.`
    );
  }

  // 4. Check latexmk -version
  if (latexmkExists) {
    const version = await runVersionCheck(compileConfig.latexmkPath);
    if (!version.ok) {
      errors.push(
        `latexmk -version failed: ${version.output}. Check TeX Live installation.`
      );
    } else {
      console.log(`[EnvCheck] latexmk version: ${version.output.split("\n")[0]}`);
    }
  }

  // 5. Check default engine is valid
  const validEngines = ["xelatex", "pdflatex", "latex"];
  if (!validEngines.includes(compileConfig.defaultEngine)) {
    errors.push(
      `Invalid DEFAULT_LATEX_ENGINE: ${compileConfig.defaultEngine}. Must be one of: ${validEngines.join(", ")}.`
    );
  }

  if (errors.length > 0) {
    console.error("[EnvCheck] Environment check FAILED:");
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    return { ok: false, errors };
  }

  console.log("[EnvCheck] Environment check passed");
  return { ok: true, errors: [] };
}
