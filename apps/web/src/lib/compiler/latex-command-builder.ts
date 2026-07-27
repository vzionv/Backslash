import { normalizeProjectTexPath } from "@/lib/storage/path-security";
import { compileConfig } from "./config";
import type { SafeConcreteEngine } from "./engine-policy";

type ConcreteEngine = SafeConcreteEngine;

const ENGINE_LATEXMK_FLAGS: Record<ConcreteEngine, string[]> = {
  xelatex: ["-xelatex"],
  pdflatex: ["-pdf"],
  latex: ["-pdfdvi"],
};

/**
 * Builds a safe argument array for child_process.spawn to invoke latexmk.
 * Never returns a shell command string.
 */
export function buildLatexmkArgs(
  engine: ConcreteEngine,
  mainFile: string,
  options?: {
    synctex?: boolean;
    haltOnError?: boolean;
    clean?: boolean;
    deepClean?: boolean;
  }
): string[] {
  const normalizedMainFile = normalizeProjectTexPath(mainFile);
  // Never execute system/user/project latexmkrc files. Project rc files are
  // Perl code and therefore bypass TeX shell-escape controls entirely.
  const args: string[] = ["-norc"];

  const flags = ENGINE_LATEXMK_FLAGS[engine];
  if (!flags) {
    throw new Error(`Unsupported engine: ${engine}`);
  }
  args.push(...flags);

  if (options?.deepClean) {
    args.push("-C", normalizedMainFile);
    return args;
  }

  if (options?.clean) {
    args.push("-c", normalizedMainFile);
    return args;
  }

  if (options?.synctex !== false) {
    args.push("-synctex=1");
  }

  args.push("-interaction=nonstopmode");
  args.push("-latexoption=-file-line-error");

  const haltOnError = options?.haltOnError ?? compileConfig.haltOnError;
  if (haltOnError) {
    args.push("-halt-on-error");
  }

  args.push(
    compileConfig.allowShellEscape ? "-shell-escape" : "-no-shell-escape"
  );

  args.push(normalizedMainFile);

  return args;
}

/**
 * Builds the executable path and args for spawn.
 */
export function buildSpawnCommand(
  engine: ConcreteEngine,
  mainFile: string,
  options?: {
    synctex?: boolean;
    haltOnError?: boolean;
  }
): { executable: string; args: string[] } {
  return {
    executable: compileConfig.latexmkPath,
    args: buildLatexmkArgs(engine, mainFile, options),
  };
}
