import type { Engine } from "@backslash/shared";

export const SAFE_REQUESTED_ENGINES = [
  "auto",
  "pdflatex",
  "xelatex",
  "latex",
] as const satisfies readonly Engine[];

export const LUALATEX_DISABLED_MESSAGE =
  "LuaLaTeX is disabled because a native unsandboxed TeX Live process cannot safely isolate LuaTeX file access. Use XeLaTeX or pdfLaTeX.";

export function isSafeRequestedEngine(value: string): value is Engine {
  return (SAFE_REQUESTED_ENGINES as readonly string[]).includes(value);
}

export type SafeConcreteEngine = Exclude<Engine, "auto" | "lualatex">;

export function assertConcreteEngineAllowed(
  engine: Exclude<Engine, "auto">
): asserts engine is SafeConcreteEngine {
  if (engine === "lualatex") {
    throw new Error(LUALATEX_DISABLED_MESSAGE);
  }
}
