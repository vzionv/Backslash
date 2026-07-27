const CLEAN_TASK_STATE_KEY = "__backslash_clean_task_state__" as const;

type CleanTaskGlobal = typeof globalThis & {
  [CLEAN_TASK_STATE_KEY]?: { active: number };
};

function configuredLimit(): number {
  const parsed = Number.parseInt(
    process.env.MAX_CONCURRENT_CLEAN_TASKS || "2",
    10
  );
  if (!Number.isFinite(parsed)) return 2;
  return Math.min(8, Math.max(1, parsed));
}

/**
 * Acquire an in-process clean slot. Cleaning launches latexmk directly rather
 * than using the compile queue, so it needs an independent concurrency guard.
 */
export function tryAcquireCleanTask(): (() => void) | null {
  const globalState = globalThis as CleanTaskGlobal;
  globalState[CLEAN_TASK_STATE_KEY] ??= { active: 0 };
  const state = globalState[CLEAN_TASK_STATE_KEY];

  if (state.active >= configuredLimit()) return null;
  state.active += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.active = Math.max(0, state.active - 1);
  };
}
