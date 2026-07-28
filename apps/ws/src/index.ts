import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { randomUUID } from "crypto";

import { getInternalWsConfig } from "./internal-config.js";
import { createInternalEventsServer } from "./internal-events-server.js";
import { authorizeWithWeb } from "./web-authorize.js";
import { isSocketIdentityCompatible } from "./socket-identity.js";
import { createCorsPolicy, isCorsOriginAllowed } from "./cors-policy.js";

// ─── Shared Types (inlined to avoid monorepo build issues) ─

interface PresenceUser {
  userId: string;
  name: string;
  email: string;
  color: string;
  activeFileId: string | null;
  activeFilePath: string | null;
}

interface CursorPosition {
  line: number;
  ch: number;
}

interface CursorSelection {
  anchor: CursorPosition;
  head: CursorPosition;
}

interface ChatMessage {
  id: string;
  userId: string;
  userName: string;
  text: string;
  timestamp: number;
  kind?: "user" | "system" | "build";
  build?: {
    buildId: string;
    status: "queued" | "compiling" | "success" | "error" | "timeout" | "canceled";
    durationMs?: number | null;
    actorUserId?: string | null;
    actorName?: string | null;
  };
}

interface ChatReadReceipt {
  userId: string;
  lastReadMessageId: string;
  timestamp: number;
}

interface DocChange {
  from: number;
  to: number;
  insert: string;
}

// ─── Socket.IO Event Maps ──────────────────────────

interface ServerToClientEvents {
  "self:identity": (data: { userId: string; name: string; email: string; color: string }) => void;
  "build:status": (data: { projectId: string; buildId: string; status: "queued" | "compiling"; triggeredByUserId?: string | null }) => void;
  "build:complete": (data: { projectId: string; buildId: string; status: string; pdfUrl: string | null; logs: string; durationMs: number; errors: any[]; triggeredByUserId?: string | null }) => void;
  "presence:users": (data: { users: PresenceUser[] }) => void;
  "presence:joined": (data: { user: PresenceUser }) => void;
  "presence:left": (data: { userId: string }) => void;
  "presence:updated": (data: { userId: string; activeFileId: string | null; activeFilePath: string | null }) => void;
  "cursor:updated": (data: { userId: string; fileId: string; selection: CursorSelection }) => void;
  "cursor:cleared": (data: { userId: string }) => void;
  "doc:changed": (data: { userId: string; fileId: string; changes: DocChange[]; version: number }) => void;
  "chat:message": (data: ChatMessage) => void;
  "chat:history": (data: { messages: ChatMessage[] }) => void;
  "chat:read": (data: ChatReadReceipt) => void;
  "chat:readState": (data: { reads: ChatReadReceipt[] }) => void;
  "file:created": (data: { userId: string; file: { id: string; path: string; isDirectory: boolean } }) => void;
  "file:deleted": (data: { userId: string; fileId: string; path: string }) => void;
  "file:saved": (data: { userId: string; fileId: string; path: string }) => void;
  "file:renamed": (data: { userId: string; fileId: string; path: string; oldPath: string; mainFile?: string; isDirectory?: boolean }) => void;
}

interface ClientToServerEvents {
  "join:project": (data: { projectId: string }) => void;
  "leave:project": (data: { projectId: string }) => void;
  "presence:activeFile": (data: { fileId: string | null; filePath: string | null }) => void;
  "cursor:move": (data: { fileId: string; selection: CursorSelection }) => void;
  "doc:change": (data: { fileId: string; changes: DocChange[]; version: number }) => void;
  "chat:send": (data: { text: string }) => void;
  "chat:read": (data: { lastReadMessageId: string }) => void;
}

// ─── Configuration ─────────────────────────────────

function readPort(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

function readBoundedInteger(
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

const PORT = readPort("WS_PORT", 3001);
const CORS_ORIGIN =
  process.env.CORS_ORIGIN || process.env.APP_URL || "http://localhost:3000";
const CORS_POLICY = createCorsPolicy(
  CORS_ORIGIN,
  process.env.CORS_ALLOW_ANY_ORIGIN_ACKNOWLEDGE_RISK === "true"
);
const INTERNAL_CONFIG = getInternalWsConfig();
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_CHAT_MESSAGE_CHARS = 4_000;
const MAX_DOC_CHANGES = 100;
const MAX_DOC_INSERT_BYTES = 256 * 1024;
const ACCESS_REVALIDATE_INTERVAL_MS = readBoundedInteger(
  "WS_ACCESS_REVALIDATE_INTERVAL_MS",
  60_000,
  10_000,
  3_600_000
);

// ─── Presence Colors ───────────────────────────────

const PRESENCE_COLORS = [
  "#f38ba8", // red
  "#fab387", // peach
  "#f9e2af", // yellow
  "#a6e3a1", // green
  "#94e2d5", // teal
  "#89b4fa", // blue
  "#b4befe", // lavender
  "#cba6f7", // mauve
  "#f5c2e7", // pink
  "#89dceb", // sky
];

let colorIndex = 0;
function nextColor(): string {
  const color = PRESENCE_COLORS[colorIndex % PRESENCE_COLORS.length];
  colorIndex++;
  return color;
}

// ─── Socket.IO Server ──────────────────────────────

const httpServer = createServer((req, res) => {
  if (req.method !== "GET" || req.url !== "/health") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({ status: "ok", service: "backslash-ws" }));
});

const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin(origin, callback) {
      const allowed = isCorsOriginAllowed(CORS_POLICY, origin);
      callback(allowed ? null : new Error("Origin not allowed"), allowed);
    },
    credentials: true,
  },
  maxHttpBufferSize: 512 * 1024,
  transports: ["websocket", "polling"],
  path: process.env.WS_PATH_PREFIX
    ? `${process.env.WS_PATH_PREFIX}/socket.io`
    : "/socket.io",
  pingInterval: 25000,
  pingTimeout: 20000,
});

// ─── Room Helpers ──────────────────────────────────

function getUserRoom(userId: string): string {
  return `user:${userId}`;
}

function getProjectRoom(projectId: string): string {
  return `project:${projectId}`;
}

// ─── In-memory State ───────────────────────────────

// Presence: projectId -> Map<userId, PresenceUser>
const presenceMap = new Map<string, Map<string, PresenceUser>>();

// Chat history: projectId -> ChatMessage[] (last 100)
const chatHistory = new Map<string, ChatMessage[]>();
// Per-project chat read markers: projectId -> Map<userId, ChatReadReceipt>
const chatReadState = new Map<string, Map<string, ChatReadReceipt>>();
const MAX_CHAT_HISTORY = 100;

// Track which project each socket is in: socketId -> projectId
const socketProjectMap = new Map<string, string>();
const connectedUserSocketCounts = new Map<string, number>();
const projectUserSocketCounts = new Map<string, Map<string, number>>();

interface SocketRateBucket {
  count: number;
  resetAt: number;
}

function allowSocketEvent(
  socket: any,
  event: string,
  limit: number,
  windowMs: number
): boolean {
  const now = Date.now();
  const buckets = (socket.data.rateBuckets ??= new Map<
    string,
    SocketRateBucket
  >()) as Map<string, SocketRateBucket>;
  const current = buckets.get(event);
  const bucket = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + windowMs }
    : current;
  bucket.count += 1;
  buckets.set(event, bucket);
  return bucket.count <= limit;
}

function isValidId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function isValidSelection(value: unknown): value is CursorSelection {
  if (!value || typeof value !== "object") return false;
  const selection = value as CursorSelection;
  return [selection.anchor, selection.head].every(
    (position) =>
      position &&
      Number.isSafeInteger(position.line) &&
      position.line >= 0 &&
      Number.isSafeInteger(position.ch) &&
      position.ch >= 0
  );
}

function isValidDocChanges(value: unknown): value is DocChange[] {
  if (!Array.isArray(value) || value.length > MAX_DOC_CHANGES) return false;
  let insertedBytes = 0;
  for (const change of value) {
    if (
      !change ||
      !Number.isSafeInteger(change.from) ||
      !Number.isSafeInteger(change.to) ||
      change.from < 0 ||
      change.to < change.from ||
      typeof change.insert !== "string"
    ) {
      return false;
    }
    insertedBytes += Buffer.byteLength(change.insert, "utf-8");
    if (insertedBytes > MAX_DOC_INSERT_BYTES) return false;
  }
  return true;
}

function getProjectPresence(projectId: string): Map<string, PresenceUser> {
  let map = presenceMap.get(projectId);
  if (!map) {
    map = new Map();
    presenceMap.set(projectId, map);
  }
  return map;
}

function getProjectChat(projectId: string): ChatMessage[] {
  let msgs = chatHistory.get(projectId);
  if (!msgs) {
    msgs = [];
    chatHistory.set(projectId, msgs);
  }
  return msgs;
}

function addChatMessage(projectId: string, msg: ChatMessage): void {
  const msgs = getProjectChat(projectId);
  msgs.push(msg);
  if (msgs.length > MAX_CHAT_HISTORY) {
    msgs.shift();
  }
}

function getProjectReadState(projectId: string): Map<string, ChatReadReceipt> {
  let reads = chatReadState.get(projectId);
  if (!reads) {
    reads = new Map();
    chatReadState.set(projectId, reads);
  }
  return reads;
}

function upsertReadState(
  projectId: string,
  userId: string,
  lastReadMessageId: string,
  timestamp: number = Date.now()
): ChatReadReceipt {
  const reads = getProjectReadState(projectId);
  const receipt: ChatReadReceipt = { userId, lastReadMessageId, timestamp };
  reads.set(userId, receipt);
  return receipt;
}

// ─── Authentication Middleware ──────────────────────

io.use((socket, next) => {
  const cookieHeader = socket.handshake.headers.cookie;
  let sessionToken = extractCookieToken(cookieHeader);
  const shareToken =
    typeof socket.handshake.auth?.shareToken === "string"
      ? socket.handshake.auth.shareToken
      : null;
  if (!sessionToken && typeof socket.handshake.auth?.token === "string") {
    sessionToken = socket.handshake.auth.token;
  }
  if (!sessionToken && !shareToken) {
    return next(new Error("Authentication required or valid share link required"));
  }

  socket.data.sessionToken = sessionToken;
  socket.data.shareToken = shareToken;
  next();
});

// ─── Connection Handler ────────────────────────────

io.on("connection", (socket) => {
  // ── Join project room ──────────────────────

  socket.on("join:project", async (data) => {
    const projectId = data?.projectId;
    if (!isValidId(projectId) || !allowSocketEvent(socket, "join", 20, 60_000)) {
      return;
    }
    if (socketProjectMap.get(socket.id) === projectId) return;

    const authorization = await authorizeWithWeb({
      projectId,
      sessionToken: socket.data.sessionToken ?? null,
      shareToken: socket.data.shareToken ?? null,
    });
    if (!authorization || !authorization.access) {
      console.warn(`[WS] Access denied for project ${projectId}`);
      return;
    }

    if (
      socket.data.userId &&
      !isSocketIdentityCompatible(
        {
          userId: socket.data.userId,
          isAnonymous: socket.data.isAnonymous === true,
        },
        authorization
      )
    ) {
      console.warn(
        `[WS] Identity change rejected for socket ${socket.id}; reconnect before switching authentication mode or account`
      );
      return;
    }

    if (!socket.data.userId) {
      const color = nextColor();
      socket.data.userId = authorization.userId;
      socket.data.email = authorization.email;
      socket.data.name = authorization.name;
      socket.data.color = color;
      socket.data.isAnonymous = authorization.isAnonymous;
      connectedUserSocketCounts.set(
        authorization.userId,
        (connectedUserSocketCounts.get(authorization.userId) ?? 0) + 1
      );
      socket.emit("self:identity", {
        userId: authorization.userId,
        name: authorization.name,
        email: authorization.email,
        color,
      });
      if (!authorization.isAnonymous) socket.join(getUserRoom(authorization.userId));
      console.log(
        `[WS] User connected: ${authorization.name} (${authorization.userId})`
      );
    }

    const userId = socket.data.userId as string;
    const name = socket.data.name as string;
    const email = socket.data.email as string;
    const color = socket.data.color as string;
    const role = authorization.role;

    // Leave any previously joined project
    const prevProject = socketProjectMap.get(socket.id);
    if (prevProject && prevProject !== projectId) {
      leaveProject(socket, prevProject);
    }

    socket.join(getProjectRoom(projectId));
    socketProjectMap.set(socket.id, projectId);
    socket.data.projectId = projectId;
    socket.data.role = role;

    // Add to presence
    const presence = getProjectPresence(projectId);
    const presenceUser: PresenceUser = {
      userId,
      name,
      email,
      color,
      activeFileId: null,
      activeFilePath: null,
    };
    presence.set(userId, presenceUser);
    const projectCounts = projectUserSocketCounts.get(projectId) ?? new Map();
    const previousSocketCount = projectCounts.get(userId) ?? 0;
    projectCounts.set(userId, previousSocketCount + 1);
    projectUserSocketCounts.set(projectId, projectCounts);

    // Send current presence to the joining user
    socket.emit("presence:users", {
      users: Array.from(presence.values()),
    });

    // Send chat history
    const history = getProjectChat(projectId);
    if (history.length > 0) {
      socket.emit("chat:history", { messages: history });
    }
    const reads = Array.from(getProjectReadState(projectId).values());
    if (reads.length > 0) {
      socket.emit("chat:readState", { reads });
    }

    // Notify others only when this is the user's first socket in the project.
    if (previousSocketCount === 0) {
      socket.to(getProjectRoom(projectId)).emit("presence:joined", {
        user: presenceUser,
      });
    }

    console.log(`[WS] User ${name} joined project ${projectId} as ${role}`);
  });

  // ── Leave project room ─────────────────────

  socket.on("leave:project", (data) => {
    const projectId = data?.projectId;
    if (!isValidId(projectId)) return;
    if (socketProjectMap.get(socket.id) !== projectId) return;
    leaveProject(socket, projectId);
  });

  // ── Presence: active file ──────────────────

  socket.on("presence:activeFile", (data) => {
    const fileId = data?.fileId;
    const filePath = data?.filePath;
    if (fileId !== null && !isValidId(fileId)) return;
    if (filePath !== null && (typeof filePath !== "string" || filePath.length > 1_024)) return;
    const projectId = socket.data.projectId;
    const userId = socket.data.userId as string | undefined;
    if (!projectId || !userId) return;

    const presence = getProjectPresence(projectId);
    const existing = presence.get(userId);
    if (existing) {
      existing.activeFileId = fileId;
      existing.activeFilePath = filePath;
    }

    socket.to(getProjectRoom(projectId)).emit("presence:updated", {
      userId,
      activeFileId: fileId,
      activeFilePath: filePath,
    });
  });

  // ── Cursor movement ────────────────────────

  socket.on("cursor:move", (data) => {
    const fileId = data?.fileId;
    const selection = data?.selection;
    if (
      !isValidId(fileId) ||
      !isValidSelection(selection) ||
      !allowSocketEvent(socket, "cursor", 120, 10_000)
    ) return;
    const projectId = socket.data.projectId;
    const userId = socket.data.userId as string | undefined;
    if (!projectId || !userId) return;

    socket.to(getProjectRoom(projectId)).emit("cursor:updated", {
      userId,
      fileId,
      selection,
    });
  });

  // ── Document changes (collaborative) ───────

  socket.on("doc:change", (data) => {
    const fileId = data?.fileId;
    const changes = data?.changes;
    const version = data?.version;
    if (
      !isValidId(fileId) ||
      !isValidDocChanges(changes) ||
      !Number.isSafeInteger(version) ||
      version < 0 ||
      !allowSocketEvent(socket, "doc", 200, 10_000)
    ) return;
    const projectId = socket.data.projectId;
    const userId = socket.data.userId as string | undefined;
    if (!projectId || !userId) return;

    // Viewers can't send document changes
    if (socket.data.role === "viewer") return;

    // Relay to all other users in the project
    socket.to(getProjectRoom(projectId)).emit("doc:changed", {
      userId,
      fileId,
      changes,
      version,
    });
  });

  // ── Chat ───────────────────────────────────

  socket.on("chat:send", (data) => {
    const text = data?.text;
    if (
      typeof text !== "string" ||
      text.length > MAX_CHAT_MESSAGE_CHARS ||
      !allowSocketEvent(socket, "chat", 20, 10_000)
    ) return;
    const projectId = socket.data.projectId;
    const userId = socket.data.userId as string | undefined;
    const name = socket.data.name as string | undefined;
    if (!projectId || !userId || !name || !text || !text.trim()) return;

    const msg: ChatMessage = {
      id: randomUUID(),
      userId,
      userName: name,
      text: text.trim(),
      timestamp: Date.now(),
      kind: "user",
    };

    addChatMessage(projectId, msg);

    // Broadcast to everyone in the project room (including sender)
    const projectRoom = getProjectRoom(projectId);
    io.to(projectRoom).emit("chat:message", msg);
    const senderRead = upsertReadState(projectId, userId, msg.id, msg.timestamp);
    io.to(projectRoom).emit("chat:read", senderRead);
  });

  socket.on("chat:read", (data) => {
    const lastReadMessageId = data?.lastReadMessageId;
    if (!isValidId(lastReadMessageId)) return;
    const projectId = socket.data.projectId;
    const userId = socket.data.userId as string | undefined;
    if (!projectId || !userId || !lastReadMessageId) return;

    const history = getProjectChat(projectId);
    const messageExists = history.some((msg) => msg.id === lastReadMessageId);
    if (!messageExists) return;

    const current = getProjectReadState(projectId).get(userId);
    if (current?.lastReadMessageId === lastReadMessageId) {
      return;
    }

    const receipt = upsertReadState(projectId, userId, lastReadMessageId);
    io.to(getProjectRoom(projectId)).emit("chat:read", receipt);
  });

  // ── Disconnect ─────────────────────────────

  socket.on("disconnect", (reason) => {
    const projectId = socketProjectMap.get(socket.id);
    if (projectId) {
      leaveProject(socket, projectId);
    }

    const userId = socket.data.userId as string | undefined;
    const name = socket.data.name as string | undefined;
    if (!userId || !name) return;

    const remaining = (connectedUserSocketCounts.get(userId) ?? 1) - 1;
    if (remaining <= 0) {
      connectedUserSocketCounts.delete(userId);
    } else {
      connectedUserSocketCounts.set(userId, remaining);
    }
    console.log(`[WS] User disconnected: ${name} (${userId}) - ${reason}`);
  });

  socket.on("error", (err) => {
    const userId = socket.data.userId as string | undefined;
    console.error(`[WS] Socket error for ${userId ?? "unidentified"}:`, err.message);
  });
});

/**
 * Remove a socket from a project room and clean up presence.
 */
function leaveProject(socket: any, projectId: string) {
  if (socketProjectMap.get(socket.id) !== projectId) return;
  const userId = socket.data.userId as string | undefined;

  socket.leave(getProjectRoom(projectId));
  socketProjectMap.delete(socket.id);

  const projectCounts = projectUserSocketCounts.get(projectId);
  const remainingSockets = Math.max(
    0,
    (projectCounts?.get(userId ?? "") ?? 1) - 1
  );
  if (userId && remainingSockets > 0) {
    projectCounts?.set(userId, remainingSockets);
  } else if (userId) {
    projectCounts?.delete(userId);
    const presence = presenceMap.get(projectId);
    presence?.delete(userId);
    socket.to(getProjectRoom(projectId)).emit("presence:left", { userId });
    socket.to(getProjectRoom(projectId)).emit("cursor:cleared", { userId });
    if (presence?.size === 0) presenceMap.delete(projectId);
  }

  if (projectCounts?.size === 0) {
    projectUserSocketCounts.delete(projectId);
    // These are ephemeral collaboration states; release them when the room empties.
    chatHistory.delete(projectId);
    chatReadState.delete(projectId);
  }

  if (socket.data.projectId === projectId) {
    socket.data.projectId = null;
    socket.data.role = null;
  }
}

const projectsBeingRevalidated = new Set<string>();

async function revalidateProjectAccess(projectId: string): Promise<void> {
  if (projectsBeingRevalidated.has(projectId)) return;
  projectsBeingRevalidated.add(projectId);

  try {
    const sockets = Array.from(io.sockets.sockets.values()).filter(
      (socket) => socketProjectMap.get(socket.id) === projectId
    );

    for (const socket of sockets) {
      const authorization = await authorizeWithWeb({
        projectId,
        sessionToken: socket.data.sessionToken ?? null,
        shareToken: socket.data.shareToken ?? null,
      });

      // A temporary Web-service error must not create a mass disconnect. The
      // next interval retries. An explicit access:false result is authoritative.
      if (authorization === null) continue;

      const currentUserId = socket.data.userId as string | undefined;
      if (
        !authorization.access ||
        !currentUserId ||
        !isSocketIdentityCompatible(
          {
            userId: currentUserId,
            isAnonymous: socket.data.isAnonymous === true,
          },
          authorization
        )
      ) {
        console.warn(
          `[WS] Realtime access revoked for socket ${socket.id} in project ${projectId}`
        );
        leaveProject(socket, projectId);
        socket.disconnect(true);
        continue;
      }

      socket.data.role = authorization.role;
    }
  } finally {
    projectsBeingRevalidated.delete(projectId);
  }
}

const accessRevalidationTimer = setInterval(() => {
  for (const projectId of new Set(socketProjectMap.values())) {
    void revalidateProjectAccess(projectId);
  }
}, ACCESS_REVALIDATE_INTERVAL_MS);
accessRevalidationTimer.unref?.();

function getPayloadProjectId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const projectId = (payload as Record<string, unknown>).projectId;
  return isValidId(projectId) ? projectId : null;
}

// ─── Start Server ──────────────────────────────────

const internalEventsServer = createInternalEventsServer({
  sharedKey: INTERNAL_CONFIG.sharedKey,
  emitToUser: (userId, event, payload) => {
    const projectId = getPayloadProjectId(payload);
    const target = projectId
      ? io.to(getUserRoom(userId)).to(getProjectRoom(projectId))
      : io.to(getUserRoom(userId));
    target.emit(event, payload as never);
  },
  emitToProject: (projectId, event, payload) => {
    io.to(getProjectRoom(projectId)).emit(event, payload as never);
  },
  refreshProjectAccess: (projectId) => {
    void revalidateProjectAccess(projectId);
  },
});

internalEventsServer.listen(INTERNAL_CONFIG.wsPort, "127.0.0.1");
httpServer.listen(PORT, INTERNAL_CONFIG.publicHost, () => {
  console.log("");
  console.log("╔══════════════════════════════════════╗");
  console.log("║   Backslash WebSocket Server         ║");
  console.log("╠══════════════════════════════════════╣");
  console.log(`║  Port:     ${String(PORT).padEnd(25)}║`);
  console.log(`║  CORS:     ${CORS_ORIGIN.substring(0, 25).padEnd(25)}║`);
  console.log("╚══════════════════════════════════════╝");
  console.log("");
  console.log("[WS] Server ready — waiting for connections...");
});

// ─── Graceful Shutdown ─────────────────────────────

async function shutdown(signal: string) {
  console.log(`\n[WS] Received ${signal}, shutting down...`);
  clearInterval(accessRevalidationTimer);

  // Disconnect all clients
  const sockets = await io.fetchSockets();
  for (const socket of sockets) {
    socket.disconnect(true);
  }

  // Close servers
  await new Promise<void>((resolve) => {
    io.close(() => resolve());
  });
  await new Promise<void>((resolve) => {
    internalEventsServer.close(() => resolve());
  });

  console.log("[WS] Shutdown complete");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ─── Helpers ───────────────────────────────────────

function extractCookieToken(cookieHeader?: string): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  for (const cookie of cookies) {
    const [name, ...rest] = cookie.split("=");
    if (name.trim() === "session") {
      return rest.join("=").trim();
    }
  }
  return null;
}
