import { NextRequest, NextResponse } from "next/server";
import { withApiKey } from "@/lib/auth/apikey";
import { getAuthorizedAsyncCompileJob } from "@/lib/compiler/asyncCompileAccess";
import { MAX_ASYNC_COMPILE_BASE64_PDF_BYTES } from "@/lib/compiler/asyncCompileLimits";
import {
  getAsyncCompilePdfPath,
  readAsyncCompileErrors,
  readAsyncCompileLogs,
} from "@/lib/compiler/asyncCompileStore";
import { parseLatexLog } from "@/lib/compiler/logParser";
import fs from "fs/promises";
import { createFileResponse } from "@/lib/storage";

// ─── GET /api/v1/compile/[jobId]/output ─────────────
// Retrieve async one-shot compile artifacts/output.
//
// Query:
//   format=json|pdf|base64   (default: json)

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function jsonNoStore(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> }
): NextResponse {
  return NextResponse.json(body, {
    ...init,
    headers: {
      ...NO_STORE_HEADERS,
      ...(init?.headers ?? {}),
    },
  });
}

function terminalErrorMessage(status: string): string {
  switch (status) {
    case "timeout":
      return "Compilation timed out";
    case "canceled":
      return "Compilation canceled";
    default:
      return "Compilation failed";
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  return withApiKey(request, async (req, user) => {
    try {
      const { jobId } = await params;
      const format = req.nextUrl.searchParams.get("format") || "json";
      if (format !== "json" && format !== "pdf" && format !== "base64") {
        return jsonNoStore(
          { error: "Invalid format. Use one of: pdf, base64, json" },
          { status: 400 }
        );
      }

      const result = await getAuthorizedAsyncCompileJob(user.id, jobId);
      if (!result.ok) {
        return jsonNoStore({ error: result.error }, { status: result.status });
      }

      const meta = result.meta;
      if (meta.status === "queued" || meta.status === "compiling") {
        return jsonNoStore(
          {
            error: "Compilation still in progress",
            status: meta.status,
            pollUrl: `/api/v1/compile/${jobId}`,
          },
          { status: 409 }
        );
      }

      const logs = await readAsyncCompileLogs(jobId);
      const parsedEntries = await readAsyncCompileErrors(jobId);
      const errors = parsedEntries.length > 0
        ? parsedEntries
        : parseLatexLog(logs);

      const successful = meta.status === "success";
      const pdfPath = getAsyncCompilePdfPath(jobId, meta.mainFile);
      const pdfStats = successful
        ? await fs.stat(pdfPath).catch(() => null)
        : null;

      if (!successful || !pdfStats?.isFile()) {
        return jsonNoStore(
          {
            error: terminalErrorMessage(meta.status),
            status: meta.status,
            engineUsed: meta.engineUsed ?? null,
            logs,
            errors: errors.filter((entry) => entry.type === "error"),
            durationMs: meta.durationMs ?? null,
          },
          { status: 422 }
        );
      }

      if (format === "pdf") {
        return createFileResponse(
          pdfPath,
          {
            ...NO_STORE_HEADERS,
            "Content-Type": "application/pdf",
            "Content-Disposition": 'inline; filename="output.pdf"',
            "X-Compile-Duration-Ms": String(meta.durationMs ?? 0),
            "X-Compile-Engine": meta.engineUsed ?? "unknown",
            "X-Compile-Warnings": String(meta.warningCount),
            "X-Compile-Errors": String(meta.errorCount),
          },
          req
        );
      }

      const pdfUrl = `/api/v1/compile/${jobId}/output?format=pdf`;
      if (format === "json") {
        return jsonNoStore({
          pdfUrl,
          pdfSizeBytes: pdfStats.size,
          engineUsed: meta.engineUsed ?? null,
          logs,
          errors,
          durationMs: meta.durationMs ?? null,
        });
      }

      if (pdfStats.size > MAX_ASYNC_COMPILE_BASE64_PDF_BYTES) {
        return jsonNoStore(
          {
            error: "PDF is too large for base64 output; use format=pdf",
            pdfUrl,
            pdfSizeBytes: pdfStats.size,
            maxBase64PdfBytes: MAX_ASYNC_COMPILE_BASE64_PDF_BYTES,
          },
          { status: 413 }
        );
      }

      const pdfBuffer = await fs.readFile(pdfPath);
      return jsonNoStore({
        pdf: pdfBuffer.toString("base64"),
        pdfSizeBytes: pdfStats.size,
        engineUsed: meta.engineUsed ?? null,
        logs,
        errors,
        durationMs: meta.durationMs ?? null,
      });
    } catch (error) {
      console.error("[API v1] Error fetching async compile output:", error);
      return jsonNoStore(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  });
}
