import { withApiKey } from "@/lib/auth/apikey";
import {
  MAX_ASYNC_COMPILE_REQUEST_OVERHEAD_BYTES,
  MAX_ASYNC_COMPILE_SOURCE_BYTES,
} from "@/lib/compiler/asyncCompileLimits";
import { addAsyncCompileJob } from "@/lib/compiler/asyncCompileRunner";
import {
  assertConcreteEngineAllowed,
  isSafeRequestedEngine,
} from "@/lib/compiler/engine-policy";
import { detectEngineFromSource } from "@/lib/compiler/main-file-resolver";
import { CompileQueueFullError } from "@/lib/compiler/compile-task-manager";
import {
  createAsyncCompileJob,
  deleteAsyncCompileJob,
} from "@/lib/compiler/asyncCompileStore";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { readJsonBody, RequestBodyError } from "@/lib/security/request-body";
import { validateContentLength } from "@/lib/storage/resource-limits";
import { tryAcquireUploadTask } from "@/lib/storage/upload-task-limit";
import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import type { Engine } from "@backslash/shared";


export async function POST(request: NextRequest) {
  return withApiKey(request, async (req, user) => {
    try {
      const rateLimited = enforceRateLimit(req, "api:v1:compile", {
        limit: 30,
        windowMs: 60_000,
        identifier: user.id,
      });
      if (rateLimited) return rateLimited;

      let source: string;
      let engine: Engine = "auto";
      const contentType = req.headers.get("content-type") || "";

      if (contentType.toLowerCase().includes("multipart/form-data")) {
        if (!req.headers.get("content-length")) {
          return NextResponse.json(
            { error: "Content-Length is required for multipart uploads" },
            { status: 411 }
          );
        }
        const bodySize = validateContentLength(
          req.headers.get("content-length"),
          MAX_ASYNC_COMPILE_SOURCE_BYTES + MAX_ASYNC_COMPILE_REQUEST_OVERHEAD_BYTES
        );
        if (!bodySize.valid) {
          return NextResponse.json(
            { error: bodySize.error },
            { status: bodySize.status }
          );
        }

        const releaseUploadTask = tryAcquireUploadTask();
        if (!releaseUploadTask) {
          return NextResponse.json(
            { error: "Too many multipart requests. Try again later." },
            { status: 503, headers: { "Retry-After": "2" } }
          );
        }

        try {
          const formData = await req.formData();
          const file = formData.get("file");
          if (!file || !(file instanceof Blob)) {
            return NextResponse.json(
              { error: "Missing 'file' field" },
              { status: 400 }
            );
          }
          if (file.size > MAX_ASYNC_COMPILE_SOURCE_BYTES) {
            return NextResponse.json(
              {
                error: `File too large (max ${MAX_ASYNC_COMPILE_SOURCE_BYTES} bytes)`,
              },
              { status: 413 }
            );
          }
          source = await file.text();
          const engineField = formData.get("engine");
          if (engineField && typeof engineField === "string") {
            if (!isSafeRequestedEngine(engineField)) {
              return NextResponse.json({ error: "Invalid engine" }, { status: 400 });
            }
            engine = engineField;
          }
        } finally {
          releaseUploadTask();
        }
      } else {
        const body = await readJsonBody(
          req,
          MAX_ASYNC_COMPILE_SOURCE_BYTES + MAX_ASYNC_COMPILE_REQUEST_OVERHEAD_BYTES
        );
        const { source: src, engine: eng } = body as Record<string, unknown>;
        if (typeof src !== "string" || src.length === 0) {
          return NextResponse.json({ error: "'source' is required" }, { status: 400 });
        }
        if (Buffer.byteLength(src, "utf-8") > MAX_ASYNC_COMPILE_SOURCE_BYTES) {
          return NextResponse.json({ error: "Source too large" }, { status: 413 });
        }
        source = src;
        if (typeof eng === "string") {
          if (!isSafeRequestedEngine(eng)) {
            return NextResponse.json({ error: "Invalid engine" }, { status: 400 });
          }
          engine = eng;
        }
      }

      const qEngine = req.nextUrl.searchParams.get("engine");
      if (qEngine) {
        if (!isSafeRequestedEngine(qEngine)) {
          return NextResponse.json({ error: "Invalid engine" }, { status: 400 });
        }
        engine = qEngine;
      }

      try {
        assertConcreteEngineAllowed(
          engine === "auto" ? detectEngineFromSource(source) : engine
        );
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : "Engine unavailable" },
          { status: 400 }
        );
      }

      const jobId = uuidv4();
      await createAsyncCompileJob({
        jobId,
        userId: user.id,
        source,
        requestedEngine: engine,
        mainFile: "main.tex",
      });

      try {
        await addAsyncCompileJob({
          jobId,
          userId: user.id,
          engine,
          mainFile: "main.tex",
        });
      } catch (enqueueError) {
        await deleteAsyncCompileJob(jobId).catch(() => undefined);
        throw enqueueError;
      }

      return NextResponse.json(
        {
          jobId,
          status: "queued",
          message: "Compilation queued",
          pollUrl: `/api/v1/compile/${jobId}`,
          outputUrl: `/api/v1/compile/${jobId}/output`,
          cancelUrl: `/api/v1/compile/${jobId}/cancel`,
        },
        { status: 202 }
      );
    } catch (error) {
      if (error instanceof RequestBodyError) {
        return NextResponse.json(
          { error: error.message },
          { status: error.status }
        );
      }
      if (error instanceof CompileQueueFullError) {
        return NextResponse.json(
          { error: "Compilation queue is full. Try again later." },
          { status: 429, headers: { "Retry-After": "5" } }
        );
      }
      console.error("[API v1] Compile error:", error);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  });
}
