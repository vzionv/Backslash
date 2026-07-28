import type { InternalRealtimeEvent, ParsedLogEntry } from "@backslash/shared";

import { getInternalRealtimeConfig } from "@/lib/realtime/internal-config";

// ─── Listeners ──────────────────────────────────────

type BuildUpdateListener = (userId: string, payload: BuildUpdatePayload) => void;
type FileEventListener = (payload: FileEventPayload) => void;

const buildUpdateListeners = new Set<BuildUpdateListener>();
const fileEventListeners = new Set<FileEventListener>();

function postInternalEvent(event: InternalRealtimeEvent): void {
  let config;
  try {
    config = getInternalRealtimeConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[Broadcast] WS event unavailable: ${message}\n`);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_500);
  void fetch(`http://127.0.0.1:${config.wsPort}/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-backslash-internal-key": config.sharedKey,
    },
    body: JSON.stringify(event),
    signal: controller.signal,
  })
    .then((response) => {
      if (!response.ok) {
        process.stderr.write(
          `[Broadcast] WS event rejected with status ${response.status}\n`
        );
      }
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[Broadcast] WS event delivery failed: ${message}\n`);
    })
    .finally(() => clearTimeout(timeout));
}

export function addBuildUpdateListener(listener: BuildUpdateListener): void {
  buildUpdateListeners.add(listener);
}

export function removeBuildUpdateListener(listener: BuildUpdateListener): void {
  buildUpdateListeners.delete(listener);
}

export function addFileEventListener(listener: FileEventListener): void {
  fileEventListeners.add(listener);
}

export function removeFileEventListener(listener: FileEventListener): void {
  fileEventListeners.delete(listener);
}

// ─── Build Update Payloads ─────────────────────────

/**
 * Payload for status-only build updates (queued, compiling).
 */
export interface BuildStatusPayload {
  projectId: string;
  buildId: string;
  status: "queued" | "compiling";
  triggeredByUserId?: string | null;
}

/**
 * Payload for completed build updates (success, error, timeout).
 */
export interface BuildCompletePayload {
  projectId: string;
  buildId: string;
  status: "success" | "error" | "timeout" | "canceled";
  pdfUrl: string | null;
  logs: string;
  durationMs: number;
  errors: ParsedLogEntry[];
  triggeredByUserId?: string | null;
}

export type BuildUpdatePayload = BuildStatusPayload | BuildCompletePayload;

// ─── Room Naming ───────────────────────────────────

export function getUserRoom(userId: string): string {
  return `user:${userId}`;
}

export function getProjectRoom(projectId: string): string {
  return `project:${projectId}`;
}

// ─── Broadcast ─────────────────────────────────────

/**
 * Broadcasts a build update to registered listeners.
 */
export function broadcastBuildUpdate(
  userId: string,
  payload: BuildUpdatePayload
): void {
  console.log(
    `[Broadcast] Build update: userId=${userId} status=${payload.status} buildId=${payload.buildId}`
  );

  // Notify all registered listeners
  for (const listener of buildUpdateListeners) {
    try {
      listener(userId, payload);
    } catch (err) {
      console.error(
        "[Broadcast] Listener error:",
        err instanceof Error ? err.message : err
      );
    }
  }

  postInternalEvent({ type: "build", userId, payload } as InternalRealtimeEvent);
}

// ─── File Events ───────────────────────────────────

export interface FileEventPayload {
  type: "file:created" | "file:deleted" | "file:saved" | "file:renamed";
  projectId: string;
  userId: string;
  fileId: string;
  path: string;
  oldPath?: string;
  mainFile?: string;
  isDirectory?: boolean;
}

/**
 * Broadcasts a file event to registered listeners.
 */
export function broadcastFileEvent(payload: FileEventPayload): void {
  console.log(
    `[Broadcast] File event: type=${payload.type} projectId=${payload.projectId} path=${payload.path}`
  );

  // Notify all registered listeners
  for (const listener of fileEventListeners) {
    try {
      listener(payload);
    } catch (err) {
      console.error(
        "[Broadcast] File event listener error:",
        err instanceof Error ? err.message : err
      );
    }
  }

  postInternalEvent({ type: "file", payload });
}

// ─── Access Changes ───────────────────────────────

/**
 * Requests immediate revalidation of every connected socket in a project.
 * Used after collaborator or public-share changes so revoked/expired access
 * does not remain active until the browser reconnects.
 */
export function broadcastProjectAccessChanged(projectId: string): void {
  postInternalEvent({ type: "access", payload: { projectId } });
}
