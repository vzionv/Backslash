const UPLOAD_TASK_STATE_KEY = "__backslash_upload_task_state__" as const;

type UploadTaskGlobal = typeof globalThis & {
  [UPLOAD_TASK_STATE_KEY]?: { active: number };
};

function configuredLimit(): number {
  const parsed = Number.parseInt(process.env.MAX_CONCURRENT_UPLOADS || "2", 10);
  if (!Number.isFinite(parsed)) return 2;
  return Math.min(16, Math.max(1, parsed));
}

/** Bound multipart parsing and buffered File objects, not only disk writes. */
export function tryAcquireUploadTask(): (() => void) | null {
  const globalState = globalThis as UploadTaskGlobal;
  globalState[UPLOAD_TASK_STATE_KEY] ??= { active: 0 };
  const state = globalState[UPLOAD_TASK_STATE_KEY];
  if (state.active >= configuredLimit()) return null;

  state.active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.active = Math.max(0, state.active - 1);
  };
}
