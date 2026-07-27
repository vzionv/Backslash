type LockState = {
  tail: Promise<void>;
  pending: number;
};

type MutationLockGlobal = typeof globalThis & {
  __backslashProjectMutationLocks__?: Map<string, LockState>;
};

const globalState = globalThis as MutationLockGlobal;
const locks =
  globalState.__backslashProjectMutationLocks__ ?? new Map<string, LockState>();
globalState.__backslashProjectMutationLocks__ = locks;

/**
 * Serialize all disk/database mutations for one project in this Node process.
 * This closes quota-check/write, save/rename, and rename/delete races between
 * browser sessions. SQLite still provides the cross-process write lock.
 */
export async function withProjectMutationLock<T>(
  projectId: string,
  operation: () => Promise<T>
): Promise<T> {
  let state = locks.get(projectId);
  if (!state) {
    state = { tail: Promise.resolve(), pending: 0 };
    locks.set(projectId, state);
  }

  const previous = state.tail.catch(() => undefined);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  state.tail = previous.then(() => gate);
  state.pending += 1;

  await previous;
  try {
    return await operation();
  } finally {
    release();
    state.pending -= 1;
    if (state.pending === 0 && locks.get(projectId) === state) {
      locks.delete(projectId);
    }
  }
}

export function getProjectMutationLockCountForTests(): number {
  return locks.size;
}
