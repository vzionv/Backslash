import type { CursorSelection } from "@backslash/shared";

export interface RemoteCursorData {
  color: string;
  name: string;
  selection: CursorSelection;
}

export function clampCursorPosition(
  lineFrom: number,
  lineTo: number,
  character: number
): number {
  return Math.min(Math.max(lineFrom + character, lineFrom), lineTo);
}
