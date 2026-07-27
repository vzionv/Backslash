import { timingSafeEqual } from "crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "http";

import type { InternalRealtimeEvent } from "./realtime-internal.js";

const MAX_BODY_BYTES = 64 * 1024;
const INTERNAL_KEY_HEADER = "x-backslash-internal-key";

type EmitToUser = (
  userId: string,
  event: "build:status" | "build:complete",
  payload: unknown
) => void;
type EmitToProject = (
  projectId: string,
  event: "file:created" | "file:deleted" | "file:saved" | "file:renamed",
  payload: unknown
) => void;

interface InternalEventsServerOptions {
  sharedKey: string;
  emitToUser: EmitToUser;
  emitToProject: EmitToProject;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(serialized),
  });
  response.end(serialized);
}

function isValidInternalServiceKey(
  receivedKey: string | undefined,
  expectedKey: string
): boolean {
  if (!receivedKey) return false;

  const received = Buffer.from(receivedKey);
  const expected = Buffer.from(expectedKey);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function parseInternalRealtimeEvent(body: unknown): InternalRealtimeEvent | null {
  if (!isRecord(body) || (body.type !== "build" && body.type !== "file")) {
    return null;
  }
  if (!isRecord(body.payload)) return null;

  const payload = body.payload;
  if (
    typeof payload.projectId !== "string" ||
    !payload.projectId ||
    typeof payload.type === "string" &&
      !["file:created", "file:deleted", "file:saved", "file:renamed"].includes(payload.type)
  ) {
    return null;
  }

  if (body.type === "file") {
    if (
      typeof payload.type !== "string" ||
      typeof payload.userId !== "string" ||
      typeof payload.fileId !== "string" ||
      typeof payload.path !== "string" ||
      (payload.type === "file:renamed" && typeof payload.oldPath !== "string")
    ) {
      return null;
    }
    return body as unknown as InternalRealtimeEvent;
  }

  if (
    typeof body.userId !== "string" ||
    typeof payload.buildId !== "string" ||
    typeof payload.status !== "string" ||
    !["queued", "compiling", "success", "error", "timeout", "canceled"].includes(
      payload.status
    )
  ) {
    return null;
  }

  return body as unknown as InternalRealtimeEvent;
}

function dispatchEvent(
  event: InternalRealtimeEvent,
  emitToUser: EmitToUser,
  emitToProject: EmitToProject
): void {
  if (event.type === "file") {
    const { payload } = event;
    if (payload.type === "file:created") {
      emitToProject(payload.projectId, payload.type, {
        userId: payload.userId,
        file: {
          id: payload.fileId,
          path: payload.path,
          isDirectory: payload.isDirectory ?? false,
        },
      });
      return;
    }

    emitToProject(payload.projectId, payload.type, {
      userId: payload.userId,
      fileId: payload.fileId,
      path: payload.path,
      oldPath: payload.oldPath,
      mainFile: payload.mainFile,
      isDirectory: payload.isDirectory,
    });
    return;
  }

  const eventName =
    event.payload.status === "queued" || event.payload.status === "compiling"
      ? "build:status"
      : "build:complete";
  emitToUser(event.userId, eventName, event.payload);
}

export function createInternalEventsServer(
  options: InternalEventsServerOptions
): Server {
  return createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/events") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    const keyHeader = request.headers[INTERNAL_KEY_HEADER];
    const receivedKey = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
    if (!isValidInternalServiceKey(receivedKey, options.sharedKey)) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }

    try {
      const event = parseInternalRealtimeEvent(await readJsonBody(request));
      if (!event) {
        sendJson(response, 400, { error: "Invalid realtime event" });
        return;
      }

      dispatchEvent(event, options.emitToUser, options.emitToProject);
      response.writeHead(204);
      response.end();
    } catch (error) {
      const status = error instanceof Error && error.message === "Request body too large"
        ? 413
        : 400;
      sendJson(response, status, { error: "Invalid realtime event" });
    }
  });
}
