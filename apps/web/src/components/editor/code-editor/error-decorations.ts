export interface BuildError {
  type: string;
  file: string;
  line: number;
  message: string;
}

export function uniqueValidErrorLines(
  errors: BuildError[],
  documentLineCount: number
): number[] {
  const lines = new Set<number>();
  for (const error of errors) {
    if (error.line >= 1 && error.line <= documentLineCount) {
      lines.add(error.line);
    }
  }
  return [...lines].sort((left, right) => left - right);
}
