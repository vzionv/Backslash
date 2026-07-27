import fs from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";

const wsSourceDirectory = path.resolve(__dirname, "../../apps/ws/src");
const FORBIDDEN_RUNTIME_PATTERNS = [
  /from\s+["']sql\.js["']/,
  /from\s+["']jose["']/,
  /readFileSync|writeFileSync|mkdirSync|existsSync/,
  /SQLITE_PATH|DB_PATH|sqlDb/,
];

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listSourceFiles(entryPath);
      return entry.name.endsWith(".ts") ? [entryPath] : [];
    })
  );

  return files.flat();
}

describe("WS database isolation", () => {
  it("does not import SQL.js, session JWT handling, or direct database persistence", async () => {
    const sourceFiles = await listSourceFiles(wsSourceDirectory);
    const source = await Promise.all(
      sourceFiles.map(async (filePath) => ({
        filePath,
        content: await fs.readFile(filePath, "utf-8"),
      }))
    );

    for (const { filePath, content } of source) {
      for (const pattern of FORBIDDEN_RUNTIME_PATTERNS) {
        expect(content, `${filePath} must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
