import { NextRequest, NextResponse } from "next/server";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const RATE_LIMIT_STATE_KEY = "__backslash_rate_limit_state__" as const;
const MAX_TRACKED_KEYS = 20_000;

type RateLimitGlobal = typeof globalThis & {
  [RATE_LIMIT_STATE_KEY]?: Map<string, RateLimitEntry>;
};

function getState(): Map<string, RateLimitEntry> {
  const state = globalThis as RateLimitGlobal;
  state[RATE_LIMIT_STATE_KEY] ??= new Map();
  return state[RATE_LIMIT_STATE_KEY];
}

function requestAddress(request: NextRequest): string {
  if (process.env.TRUST_PROXY_HEADERS !== "true") return "direct";
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",", 1)[0].trim() || "direct";
  return request.headers.get("x-real-ip")?.trim() || "direct";
}

function pruneExpired(state: Map<string, RateLimitEntry>, now: number): void {
  if (state.size < MAX_TRACKED_KEYS) return;
  for (const [key, entry] of state) {
    if (entry.resetAt <= now) state.delete(key);
  }
  while (state.size >= MAX_TRACKED_KEYS) {
    const oldest = state.keys().next().value as string | undefined;
    if (!oldest) break;
    state.delete(oldest);
  }
}

export function enforceRateLimit(
  request: NextRequest,
  scope: string,
  options: {
    limit: number;
    windowMs: number;
    identifier?: string;
  }
): NextResponse | null {
  const now = Date.now();
  const state = getState();
  pruneExpired(state, now);

  const identity = (options.identifier || "anonymous").trim().toLowerCase();
  const key = `${scope}:${requestAddress(request)}:${identity}`;
  const existing = state.get(key);
  const entry = !existing || existing.resetAt <= now
    ? { count: 0, resetAt: now + options.windowMs }
    : existing;

  entry.count += 1;
  state.set(key, entry);
  if (entry.count <= options.limit) return null;

  const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  return NextResponse.json(
    { error: "Too many requests. Try again later." },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfter),
        "Cache-Control": "no-store",
      },
    }
  );
}
