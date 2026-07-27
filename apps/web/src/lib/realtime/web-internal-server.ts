import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "http";
import { timingSafeEqual } from "crypto";

import type {
  RealtimeAuthorizationRequest,
  RealtimeAuthorizationResponse,
} from "@backslash/shared";

import { getInternalRealtimeConfig } from "./internal-config";

const MAX_BODY_BYTES = 64 * 1024;
const INTERNAL_KEY_HEADER = "x-backslash-internal-key";

interface WebInternalServerOptions {
  sharedKey: string;
  authorize: (
    request: RealtimeAuthorizationRequest
  ) => Promise<RealtimeAuthorizationResponse>;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown
): void {
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(serialized),
  });
  response.end(serialized);
}

export function isValidInternalServiceKey(
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
    if (length > MAX_BODY_BYTES) {
      throw new Error("Request body too large");
    }
    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

function parseAuthorizationRequest(body: unknown): RealtimeAuthorizationRequest | null {
  if (!body || typeof body !== "object") return null;

  const candidate = body as Record<string, unknown>;
  const { projectId, sessionToken, shareToken } = candidate;
  if (typeof projectId !== "string" || !projectId) return null;
  if (sessionToken !== null && typeof sessionToken !== "string") return null;
  if (shareToken !== null && typeof shareToken !== "string") return null;

  return {
    projectId,
    sessionToken: sessionToken ?? null,
    shareToken: shareToken ?? null,
  };
}

export function createWebInternalServer(options: WebInternalServerOptions): Server {
  return createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/authorize") {
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
      const authorizationRequest = parseAuthorizationRequest(
        await readJsonBody(request)
      );
      if (!authorizationRequest) {
        sendJson(response, 400, { error: "Invalid authorization request" });
        return;
      }

      sendJson(response, 200, await options.authorize(authorizationRequest));
    } catch (error) {
      const status = error instanceof Error && error.message === "Request body too large"
        ? 413
        : 400;
      sendJson(response, status, { error: "Invalid authorization request" });
    }
  });
}

const INTERNAL_SERVER_KEY = "__backslashWebInternalServer__" as const;

export function startWebInternalServer(): Server {
  const globalState = globalThis as typeof globalThis & {
    [INTERNAL_SERVER_KEY]?: Server;
  };
  const existing = globalState[INTERNAL_SERVER_KEY];
  if (existing) return existing;

  const config = getInternalRealtimeConfig();
  const server = createWebInternalServer({
    sharedKey: config.sharedKey,
    authorize: async (request) => {
      const { authorizeRealtimeClient } = await import(
        "@/lib/auth/project-access"
      );
      return authorizeRealtimeClient(request);
    },
  });
  server.listen(config.webPort, "127.0.0.1");
  globalState[INTERNAL_SERVER_KEY] = server;
  return server;
}
