import { describe, it, expect } from "vitest";
import { buildLatexmkArgs } from "../../apps/web/src/lib/compiler/latex-command-builder";

describe("buildLatexmkArgs", () => {
  it("builds xelatex args with hardened defaults", () => {
    const args = buildLatexmkArgs("xelatex", "main.tex");
    expect(args).toContain("-norc");
    expect(args).toContain("-xelatex");
    expect(args).toContain("-synctex=1");
    expect(args).toContain("-interaction=nonstopmode");
    expect(args).toContain("-latexoption=-file-line-error");
    expect(args).toContain("-halt-on-error");
    expect(args).toContain("-no-shell-escape");
    expect(args).toContain("main.tex");
  });

  it("adds halt-on-error when configured", () => {
    expect(buildLatexmkArgs("xelatex", "main.tex", { haltOnError: true }))
      .toContain("-halt-on-error");
  });

  it("builds pdflatex args", () => {
    const args = buildLatexmkArgs("pdflatex", "thesis.tex");
    expect(args).toContain("-pdf");
    expect(args).toContain("-synctex=1");
    expect(args).toContain("thesis.tex");
  });

  it("rejects LuaLaTeX because native LuaTeX cannot be safely isolated", () => {
    expect(() => buildLatexmkArgs("lualatex" as never, "main.tex")).toThrow();
  });

  it("respects haltOnError false option", () => {
    const args = buildLatexmkArgs("xelatex", "main.tex", { haltOnError: false });
    expect(args).not.toContain("-halt-on-error");
  });

  it("removes synctex when disabled", () => {
    const args = buildLatexmkArgs("pdflatex", "main.tex", { synctex: false });
    expect(args).not.toContain("-synctex=1");
  });

  it("builds clean args", () => {
    const args = buildLatexmkArgs("pdflatex", "main.tex", { clean: true });
    expect(args).toContain("-c");
    expect(args).toContain("main.tex");
    expect(args).not.toContain("-synctex=1");
  });

  it("builds deep clean args", () => {
    const args = buildLatexmkArgs("pdflatex", "main.tex", { deepClean: true });
    expect(args).toContain("-C");
  });

  it("throws on unsupported engine", () => {
    expect(() => buildLatexmkArgs("auto" as any, "main.tex")).toThrow();
  });

  it("rejects a main file that could be parsed as a latexmk option", () => {
    expect(() => buildLatexmkArgs("xelatex", "-eunsafe.tex")).toThrow(
      "project-relative .tex path"
    );
  });

  it("all args are safe strings (no shell operators)", () => {
    const args = buildLatexmkArgs("xelatex", "main.tex", { haltOnError: true });
    for (const arg of args) {
      expect(arg).not.toContain(";");
      expect(arg).not.toContain("&&");
      expect(arg).not.toContain("|");
      expect(arg).not.toContain("$(");
      expect(arg).not.toContain("`");
    }
  });
});
