import type { Engine } from "@backslash/shared";

export function detectEngineFromSource(
  content: string
): Exclude<Engine, "auto"> {
  if (
    /\\usepackage\{luacode\}|\\directlua\b|\\usepackage\{luatextra\}/.test(
      content
    )
  ) {
    return "lualatex";
  }
  if (
    /\\usepackage\{fontspec\}|\\usepackage\{unicode-math\}|\\usepackage\{polyglossia\}/.test(
      content
    )
  ) {
    return "xelatex";
  }
  return "pdflatex";
}
