import { getInternalWsConfig } from "./internal-config.js";

export type RealtimeAccessRole = "owner" | "viewer" | "editor";

export interface WebAuthorizationRequest {
  projectId: string;
  sessionToken: string | null;
  shareToken: string | null;
}

export interface WebAuthorizationGranted {
  access: true;
  userId: string;
  email: string;
  name: string;
  role: RealtimeAccessRole;
  isAnonymous: boolean;
}

export interface WebAuthorizationDenied {
  access: false;
}

export type WebAuthorizationResult =
  | WebAuthorizationGranted
  | WebAuthorizationDenied;

function isAuthorizationResult(value: unknown): value is WebAuthorizationResult {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Record<string, unknown>;
  if (candidate.access === false) return true;

  return (
    candidate.access === true &&
    typeof candidate.userId === "string" &&
    typeof candidate.email === "string" &&
    typeof candidate.name === "string" &&
    (candidate.role === "owner" ||
      candidate.role === "viewer" ||
      candidate.role === "editor") &&
    typeof candidate.isAnonymous === "boolean"
  );
}

export async function authorizeWithWeb(
  request: WebAuthorizationRequest
): Promise<WebAuthorizationResult | null> {
  const config = getInternalWsConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_500);

  try {
    const response = await fetch(
      `http://127.0.0.1:${config.webPort}/authorize`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-backslash-internal-key": config.sharedKey,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      }
    );
    if (!response.ok) return null;

    const result: unknown = await response.json();
    return isAuthorizationResult(result) ? result : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[WS] Web authorization request failed: ${message}\n`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
