import { describe, it, expect } from "vitest";
import { parseLatexLog, summarizeLog, extractErrors } from "../../apps/web/src/lib/compiler/logParser";

describe("logParser", () => {
  describe("file-line-error format", () => {
    it("parses Unix-style paths", () => {
      const log = "./chapters/intro.tex:42: Undefined control sequence.";
      const entries = parseLatexLog(log);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        type: "error",
        file: "chapters/intro.tex",
        line: 42,
        message: "Undefined control sequence.",
      });
    });

    it("parses Windows-style paths", () => {
      const log = ".\\chapters\\intro.tex:15: Missing $ inserted.";
      const entries = parseLatexLog(log);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        type: "error",
        file: "chapters/intro.tex",
        line: 15,
        message: "Missing $ inserted.",
      });
    });

    it("parses paths without ./ prefix", () => {
      const log = "main.tex:10: Undefined control sequence.";
      const entries = parseLatexLog(log);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        type: "error",
        file: "main.tex",
        line: 10,
        message: "Undefined control sequence.",
      });
    });
  });

  describe("classic LaTeX error format", () => {
    it("parses ! LaTeX Error with line number", () => {
      const log = `! LaTeX Error: Environment itemize undefined.
l.27 \\begin{itemiz}`;
      const entries = parseLatexLog(log);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        type: "error",
        line: 27,
      });
      expect(entries[0].message).toContain("LaTeX Error");
    });

    it("parses ! Undefined control sequence", () => {
      const log = "! Undefined control sequence.\nl.15 \\badcommand";
      const entries = parseLatexLog(log);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        type: "error",
        line: 15,
        message: "Undefined control sequence.",
      });
    });
  });

  describe("warning parsing", () => {
    it("parses LaTeX warnings", () => {
      const log = "LaTeX Warning: Reference `fig:foo' on page 3 undefined on input line 45.";
      const entries = parseLatexLog(log);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        type: "warning",
        line: 45,
      });
    });

    it("parses Package warnings", () => {
      const log = "Package natbib Warning: Citation `bar' on page 2 undefined on input line 88.";
      const entries = parseLatexLog(log);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        type: "warning",
        line: 88,
      });
      expect(entries[0].message).toContain("Citation");
    });
  });

  describe("summarizeLog", () => {
    it("counts errors, warnings, and info", () => {
      const log = `./main.tex:5: Error one.
! Error two.
l.10 \\bad
LaTeX Warning: Warning message on input line 15.
Overfull \\hbox (6pt too wide) in paragraph at lines 20--20`;

      const summary = summarizeLog(log);
      expect(summary.errorCount).toBeGreaterThanOrEqual(2);
      expect(summary.warningCount).toBeGreaterThanOrEqual(1);
      expect(summary.infoCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe("extractErrors", () => {
    it("returns only error entries", () => {
      const log = `./main.tex:5: Real error.
LaTeX Warning: Just a warning on input line 10.
Overfull \\hbox (6pt too wide) at lines 15--15`;

      const errors = extractErrors(log);
      expect(errors).toHaveLength(1);
      expect(errors[0].type).toBe("error");
    });
  });
});
