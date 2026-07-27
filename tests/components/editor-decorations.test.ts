import { describe, expect, it } from "vitest";

import { uniqueValidErrorLines } from "../../apps/web/src/components/editor/code-editor/error-decorations";
import { clampCursorPosition } from "../../apps/web/src/components/editor/code-editor/remote-cursors";

describe("CodeEditor decoration helpers", () => {
  it("keeps unique error lines within the active document", () => {
    expect(
      uniqueValidErrorLines(
        [
          { type: "error", file: "main.tex", line: 3, message: "first" },
          { type: "error", file: "main.tex", line: 3, message: "duplicate" },
          { type: "error", file: "main.tex", line: 0, message: "invalid" },
          { type: "error", file: "main.tex", line: 8, message: "invalid" },
        ],
        5
      )
    ).toEqual([3]);
  });

  it("clamps remote cursor characters to the current line", () => {
    expect(clampCursorPosition(10, 20, -2)).toBe(10);
    expect(clampCursorPosition(10, 20, 4)).toBe(14);
    expect(clampCursorPosition(10, 20, 50)).toBe(20);
  });
});
