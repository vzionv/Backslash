import { completeStrictJson } from "@/lib/ai/client";
import { getUserAiSettings } from "@/lib/ai/settings";
import { withAuth } from "@/lib/auth/middleware";
import { CompileQueueFullError } from "@/lib/compiler/compile-task-manager";
import { parseLatexLog } from "@/lib/compiler/logParser";
import {
  ProjectCompileError,
  queueProjectCompile,
} from "@/lib/compiler/queue-project-compile";
import { db } from "@/lib/db";
import { updateProjectFilesAfterBatchWrite } from "@/lib/db/project-file-mutations";
import { builds, projectFiles } from "@/lib/db/schema";
import { checkProjectAccess } from "@/lib/db/queries/projects";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { readJsonBody, RequestBodyError } from "@/lib/security/request-body";
import * as storage from "@/lib/storage";
import {
  assertProjectPathHasNoSymlink,
  resolveProjectPath,
} from "@/lib/storage/path-security";
import { withProjectMutationLock } from "@/lib/storage/project-mutation-lock";
import {
  MAX_TEXT_CONTENT_BYTES,
  validateProjectStorage,
} from "@/lib/storage/resource-limits";
import { stageFileWrite, type StagedPathMutation } from "@/lib/storage/staged-mutation";
import { validateFilePath } from "@/lib/utils/validation";
import { broadcastFileEvent } from "@/lib/websocket/server";
import { desc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const MAX_AI_EDIT_TEXT_CHARS = 256_000;
const MAX_PROMPT_FILE_COUNT = 500;
const MAX_ACTIVE_FILE_PROMPT_BYTES = 256 * 1024;
const MAX_AI_FIX_REQUEST_BYTES = 512 * 1024;

const requestSchema = z.object({
  projectId: z.string().uuid(),
  activeFilePath: z.string().trim().max(1000).optional(),
  activeFileContent: z
    .string()
    .refine(
      (content) =>
        Buffer.byteLength(content, "utf-8") <= MAX_ACTIVE_FILE_PROMPT_BYTES,
      { message: `Active file content exceeds ${MAX_ACTIVE_FILE_PROMPT_BYTES} bytes` }
    )
    .optional(),
  errorLimit: z.number().int().min(1).max(20).optional(),
  recentBuildLimit: z.number().int().min(1).max(5).optional(),
});

const aiEditSchema = z.object({
  filePath: z.string().trim().min(1).max(1000),
  replaceFrom: z.number().int().min(1),
  replaceTo: z.number().int().min(1),
  newText: z.string().max(MAX_AI_EDIT_TEXT_CHARS),
});

const aiResponseSchema = z.object({
  edits: z.array(aiEditSchema).max(40),
  explanation: z.string().trim().min(1).max(4000),
});

interface AiEdit {
  filePath: string;
  replaceFrom: number;
  replaceTo: number;
  newText: string;
}

interface PreparedFileEdit {
  id: string;
  path: string;
  fullPath: string;
  nextContent: string;
  edits: AiEdit[];
}

class AiApplyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 413 | 500
  ) {
    super(message);
    this.name = "AiApplyError";
  }
}

function normalizeFilePath(value: string): string {
  return value.trim().replace(/^\.\//, "");
}

function tailLines(input: string, maxLines: number): string {
  const lines = input.split("\n");
  if (lines.length <= maxLines) return input;
  return lines.slice(lines.length - maxLines).join("\n");
}

function assertNonOverlappingEdits(filePath: string, edits: AiEdit[]): void {
  const ascending = [...edits].sort(
    (a, b) => a.replaceFrom - b.replaceFrom || a.replaceTo - b.replaceTo
  );
  let previousEnd = 0;
  for (const edit of ascending) {
    if (edit.replaceTo < edit.replaceFrom) {
      throw new Error(
        `Invalid range for ${filePath}: ${edit.replaceFrom}-${edit.replaceTo}`
      );
    }
    if (edit.replaceFrom <= previousEnd) {
      throw new Error(`Overlapping edits returned for ${filePath}`);
    }
    previousEnd = edit.replaceTo;
  }
}

function applyLineEdits(content: string, filePath: string, edits: AiEdit[]): string {
  assertNonOverlappingEdits(filePath, edits);
  const lines = content.split("\n");
  const sorted = [...edits].sort((a, b) => b.replaceFrom - a.replaceFrom);

  for (const edit of sorted) {
    if (edit.replaceTo > lines.length) {
      throw new Error(
        `Out-of-range edit for ${filePath}: max line ${lines.length}, got ${edit.replaceTo}`
      );
    }

    const startIndex = edit.replaceFrom - 1;
    const deleteCount = edit.replaceTo - edit.replaceFrom + 1;
    lines.splice(startIndex, deleteCount, ...edit.newText.split("\n"));
  }

  return lines.join("\n");
}

async function rollbackStagedMutations(
  mutations: StagedPathMutation[],
  originalError: unknown
): Promise<never> {
  const rollbackErrors: unknown[] = [];
  for (const mutation of [...mutations].reverse()) {
    try {
      await mutation.rollback();
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  if (rollbackErrors.length > 0) {
    throw new AggregateError(
      [originalError, ...rollbackErrors],
      "Failed to apply and fully roll back AI edits"
    );
  }
  throw originalError;
}

export async function POST(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    const limited = enforceRateLimit(req, "ai:fix-build", {
      limit: 12,
      windowMs: 10 * 60_000,
      identifier: user.id,
    });
    if (limited) return limited;

    let body: unknown;
    try {
      body = await readJsonBody(req, MAX_AI_FIX_REQUEST_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const { projectId } = parsed.data;
    const errorLimit = parsed.data.errorLimit ?? 8;
    const recentBuildLimit = parsed.data.recentBuildLimit ?? 3;

    const access = await checkProjectAccess(user.id, projectId);
    if (!access.access) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    if (access.role === "viewer") {
      return NextResponse.json({ error: "Permission denied" }, { status: 403 });
    }

    const aiSettings = await getUserAiSettings(user.id);
    if (!aiSettings.enabled) {
      return NextResponse.json(
        { error: "AI features are disabled in your settings" },
        { status: 403 }
      );
    }

    const project = access.project;
    const projectDir = storage.getProjectDir(project.userId, projectId);
    const files = await db
      .select({
        id: projectFiles.id,
        path: projectFiles.path,
        sizeBytes: projectFiles.sizeBytes,
        isDirectory: projectFiles.isDirectory,
      })
      .from(projectFiles)
      .where(eq(projectFiles.projectId, projectId));

    const editableFiles = files.filter((file) => !file.isDirectory);
    if (editableFiles.length === 0) {
      return NextResponse.json(
        { error: "No editable files found in project" },
        { status: 404 }
      );
    }

    const requestedActivePath = parsed.data.activeFilePath
      ? normalizeFilePath(parsed.data.activeFilePath)
      : "";
    const activeFile =
      editableFiles.find((file) => file.path === requestedActivePath) ??
      editableFiles.find((file) => file.path === project.mainFile) ??
      editableFiles.find((file) => file.path.toLowerCase().endsWith(".tex")) ??
      editableFiles[0];

    await assertProjectPathHasNoSymlink(projectDir, activeFile.path);
    const activeFullPath = resolveProjectPath(projectDir, activeFile.path);
    const diskActiveContent = await storage
      .readTextFileLimited(activeFullPath, MAX_TEXT_CONTENT_BYTES)
      .catch(() => "");
    const activeFileContent =
      typeof parsed.data.activeFileContent === "string"
        ? parsed.data.activeFileContent
        : diskActiveContent;

    const recentBuilds = await db
      .select({
        id: builds.id,
        status: builds.status,
        logs: builds.logs,
        createdAt: builds.createdAt,
      })
      .from(builds)
      .where(eq(builds.projectId, projectId))
      .orderBy(desc(builds.createdAt))
      .limit(recentBuildLimit);

    const topErrors = parseLatexLog(recentBuilds[0]?.logs ?? "")
      .filter((entry) => entry.type === "error")
      .slice(0, errorLimit)
      .map((entry) => ({
        type: entry.type,
        file: entry.file,
        line: entry.line,
        message: entry.message,
      }));

    const systemPrompt = [
      "You are a senior LaTeX error-fix assistant.",
      "Return ONLY valid JSON matching this exact schema:",
      "{ edits: [{ filePath: string, replaceFrom: number, replaceTo: number, newText: string }], explanation: string }",
      "Rules:",
      "1) filePath must match one of the provided project files.",
      "2) replaceFrom/replaceTo are 1-based inclusive line numbers in filePath.",
      "3) Edits in the same file must not overlap.",
      "4) Keep edits minimal and focused on fixing compile errors.",
      "5) Do not include markdown or extra keys.",
    ].join("\n");

    const userPrompt = JSON.stringify(
      {
        objective: "Fix current LaTeX build failures with minimal safe edits.",
        project: {
          id: project.id,
          name: project.name,
          engine: project.engine,
          mainFile: project.mainFile,
        },
        activeFile: {
          path: activeFile.path,
          content: activeFileContent.slice(0, 32_000),
        },
        topCompileErrors: topErrors,
        recentBuildLogs: recentBuilds.map((build) => ({
          buildId: build.id,
          status: build.status,
          createdAt: build.createdAt,
          logsTail: tailLines(build.logs ?? "", 80).slice(0, 10_000),
        })),
        availableFiles: editableFiles
          .slice(0, MAX_PROMPT_FILE_COUNT)
          .map((file) => file.path),
      },
      null,
      2
    );

    let aiPayload: unknown;
    try {
      aiPayload = await completeStrictJson({
        modelSettings: aiSettings.buildFix,
        systemPrompt,
        userPrompt,
        temperature: 0.1,
      });
    } catch (error) {
      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "AI provider request failed",
        },
        { status: 502 }
      );
    }

    const aiResult = aiResponseSchema.safeParse(aiPayload);
    if (!aiResult.success) {
      return NextResponse.json(
        {
          error: "AI response schema validation failed",
          details: aiResult.error.flatten().fieldErrors,
        },
        { status: 502 }
      );
    }

    const editsByFile = new Map<string, AiEdit[]>();
    const skipped: Array<{ filePath: string; reason: string }> = [];
    for (const rawEdit of aiResult.data.edits) {
      const edit = {
        ...rawEdit,
        filePath: normalizeFilePath(rawEdit.filePath),
      };
      const validPath = validateFilePath(edit.filePath);
      if (!validPath.valid || edit.replaceTo < edit.replaceFrom) {
        skipped.push({
          filePath: edit.filePath,
          reason: validPath.error ?? "Invalid edit range",
        });
        continue;
      }
      const next = editsByFile.get(edit.filePath) ?? [];
      next.push(edit);
      editsByFile.set(edit.filePath, next);
    }

    let changedFiles: PreparedFileEdit[];
    try {
      changedFiles = await withProjectMutationLock(projectId, async () => {
        const currentAccess = await checkProjectAccess(user.id, projectId);
        if (!currentAccess.access) {
          throw new AiApplyError("Project not found", 404);
        }
        if (currentAccess.role === "viewer") {
          throw new AiApplyError("Permission denied", 403);
        }

        const currentProject = currentAccess.project;
        const currentProjectDir = storage.getProjectDir(
          currentProject.userId,
          projectId
        );
        const currentFiles = await db
          .select({
            id: projectFiles.id,
            path: projectFiles.path,
            sizeBytes: projectFiles.sizeBytes,
            isDirectory: projectFiles.isDirectory,
          })
          .from(projectFiles)
          .where(eq(projectFiles.projectId, projectId));

        const prepared: PreparedFileEdit[] = [];
        for (const [filePath, edits] of editsByFile) {
          const file = currentFiles.find(
            (entry) => !entry.isDirectory && entry.path === filePath
          );
          if (!file) {
            skipped.push({ filePath, reason: "File not found in project" });
            continue;
          }

          try {
            await assertProjectPathHasNoSymlink(currentProjectDir, file.path);
            const fullPath = resolveProjectPath(currentProjectDir, file.path);
            const originalContent = await storage.readTextFileLimited(
              fullPath,
              MAX_TEXT_CONTENT_BYTES
            );
            const nextContent = applyLineEdits(originalContent, filePath, edits);
            if (Buffer.byteLength(nextContent, "utf-8") > MAX_TEXT_CONTENT_BYTES) {
              throw new Error("AI edit would exceed the per-file size limit");
            }
            if (nextContent !== originalContent) {
              prepared.push({
                id: file.id,
                path: file.path,
                fullPath,
                nextContent,
                edits,
              });
            }
          } catch (error) {
            skipped.push({
              filePath,
              reason: error instanceof Error ? error.message : "Invalid AI edit",
            });
          }
        }

        const storageCheck = validateProjectStorage(
          currentFiles.map((file) => ({
            path: file.path,
            sizeBytes: file.sizeBytes ?? 0,
            isDirectory: file.isDirectory ?? false,
          })),
          prepared.map((file) => ({
            path: file.path,
            sizeBytes: Buffer.byteLength(file.nextContent, "utf-8"),
          }))
        );
        if (!storageCheck.valid) {
          throw new AiApplyError(storageCheck.error, storageCheck.status);
        }

        const staged: StagedPathMutation[] = [];
        try {
          for (const file of prepared) {
            staged.push(await stageFileWrite(file.fullPath, file.nextContent));
          }
          if (prepared.length > 0) {
            updateProjectFilesAfterBatchWrite({
              projectId,
              files: prepared.map((file) => ({
                fileId: file.id,
                sizeBytes: Buffer.byteLength(file.nextContent, "utf-8"),
              })),
              updatedAt: new Date().toISOString(),
            });
          }
        } catch (error) {
          await rollbackStagedMutations(staged, error);
        }

        for (const mutation of staged) {
          await mutation.commit().catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(
              `[Storage] Failed to purge AI edit backup: ${message}\n`
            );
          });
        }
        return prepared;
      });
    } catch (error) {
      if (error instanceof AiApplyError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      return NextResponse.json(
        {
          error:
            error instanceof Error ? error.message : "Failed to apply AI edits",
        },
        { status: 500 }
      );
    }

    const applied: Array<{
      filePath: string;
      replaceFrom: number;
      replaceTo: number;
    }> = [];
    for (const file of changedFiles) {
      for (const edit of file.edits) {
        applied.push({
          filePath: file.path,
          replaceFrom: edit.replaceFrom,
          replaceTo: edit.replaceTo,
        });
      }
      broadcastFileEvent({
        type: "file:saved",
        projectId,
        userId: user.id,
        fileId: file.id,
        path: file.path,
      });
    }

    let compile: { statusCode: number; payload: unknown };
    try {
      const { buildId } = await queueProjectCompile({
        projectId,
        buildUserId: user.id,
        storageUserId: project.userId,
        triggeredByUserId: user.id,
      });
      compile = {
        statusCode: 202,
        payload: { buildId, status: "queued", message: "Compilation queued" },
      };
    } catch (error) {
      if (error instanceof CompileQueueFullError) {
        compile = {
          statusCode: 429,
          payload: { error: "Compilation queue is full. Try again later." },
        };
      } else if (error instanceof ProjectCompileError) {
        compile = {
          statusCode: error.status,
          payload: { error: error.message },
        };
      } else {
        compile = {
          statusCode: 500,
          payload: {
            error:
              error instanceof Error
                ? error.message
                : "Failed to queue compilation",
          },
        };
      }
    }

    return NextResponse.json({
      explanation: aiResult.data.explanation,
      appliedEdits: applied,
      skippedEdits: skipped,
      compile: {
        statusCode: compile.statusCode,
        result: compile.payload,
      },
    });
  });
}
