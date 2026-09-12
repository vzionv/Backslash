import { compileConfig } from "./config";

export type TaskStatus =
  | "waiting"
  | "running"
  | "success"
  | "error"
  | "timeout"
  | "canceled";

export interface CompileTask {
  taskId: string;
  projectId: string;
  deduplicationKey?: string;
  status: TaskStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  run: () => Promise<void>;
  abortController: AbortController;
  onDiscarded?: () => void;
}

export interface CompileTaskSummary {
  taskId: string;
  projectId: string;
  deduplicationKey?: string;
  status: TaskStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface TaskState {
  queue: CompileTask[];
  active: Map<string, CompileTask>;
  history: Map<string, CompileTaskSummary>;
}

export interface CompileTaskManagerOptions {
  historyLimit?: number;
  historyTtlMs?: number;
  maxQueued?: number;
}

export class CompileQueueFullError extends Error {
  constructor(readonly maxQueued: number) {
    super(`Compile queue is full (max ${maxQueued} waiting tasks)`);
    this.name = "CompileQueueFullError";
  }
}

export interface CancelResult {
  canceled: boolean;
  wasQueued: boolean;
  wasRunning: boolean;
  taskId: string | null;
}

function toTaskSummary(task: CompileTask): CompileTaskSummary {
  return {
    taskId: task.taskId,
    projectId: task.projectId,
    deduplicationKey: task.deduplicationKey,
    status: task.status,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
  };
}

export class CompileTaskManager {
  private state: TaskState = {
    queue: [],
    active: new Map(),
    history: new Map(),
  };
  private readonly maxConcurrent: number;
  private readonly historyLimit: number;
  private readonly historyTtlMs: number;
  private readonly maxQueued: number;
  private accepting = true;
  private processing = false;

  constructor(maxConcurrent?: number, options: CompileTaskManagerOptions = {}) {
    this.maxConcurrent = maxConcurrent ?? compileConfig.maxConcurrentCompilations;
    this.historyLimit = options.historyLimit ?? compileConfig.taskHistoryLimit;
    this.historyTtlMs = options.historyTtlMs ?? compileConfig.taskHistoryTtlMs;
    this.maxQueued = options.maxQueued ?? compileConfig.maxQueuedCompilations;
  }

  enqueue(task: CompileTask): void {
    if (!this.accepting) {
      throw new Error("CompileTaskManager is shutting down, not accepting new tasks");
    }

    if (task.deduplicationKey) {
      this.state.queue = this.state.queue.filter((queuedTask) => {
        if (queuedTask.deduplicationKey !== task.deduplicationKey) return true;
        this.cancelQueuedTask(queuedTask);
        return false;
      });
      for (const activeTask of this.state.active.values()) {
        if (activeTask.deduplicationKey === task.deduplicationKey) {
          activeTask.abortController.abort();
        }
      }
    }

    if (this.state.queue.length >= this.maxQueued) {
      task.onDiscarded?.();
      throw new CompileQueueFullError(this.maxQueued);
    }

    task.status = "waiting";
    this.state.queue.push(task);
    this.processNext();
  }

  cancelByTaskId(taskId: string): CancelResult {
    const queuedTask = this.state.queue.find((task) => task.taskId === taskId);
    if (queuedTask) {
      this.state.queue = this.state.queue.filter((task) => task.taskId !== taskId);
      this.cancelQueuedTask(queuedTask);
      return {
        canceled: true,
        wasQueued: true,
        wasRunning: false,
        taskId,
      };
    }

    const activeTask = this.state.active.get(taskId);
    if (!activeTask) {
      return { canceled: false, wasQueued: false, wasRunning: false, taskId: null };
    }

    activeTask.abortController.abort();
    return { canceled: true, wasQueued: false, wasRunning: true, taskId };
  }

  cancelByProjectId(projectId: string): CancelResult {
    let wasQueued = false;
    let wasRunning = false;
    let taskId: string | null = null;

    this.state.queue = this.state.queue.filter((task) => {
      if (task.projectId !== projectId) return true;
      this.cancelQueuedTask(task);
      wasQueued = true;
      taskId ??= task.taskId;
      return false;
    });

    for (const task of this.state.active.values()) {
      if (task.projectId !== projectId) continue;
      task.abortController.abort();
      wasRunning = true;
      taskId ??= task.taskId;
    }

    return {
      canceled: wasQueued || wasRunning,
      wasQueued,
      wasRunning,
      taskId,
    };
  }

  cancel(projectId: string): CancelResult {
    return this.cancelByProjectId(projectId);
  }

  async cancelProjectAndWait(
    projectId: string,
    timeoutMs = 10_000
  ): Promise<CancelResult & { settled: boolean }> {
    const result = this.cancelByProjectId(projectId);
    const deadline = Date.now() + Math.max(timeoutMs, 0);

    while (
      [...this.state.active.values()].some((task) => task.projectId === projectId)
    ) {
      if (Date.now() >= deadline) {
        return { ...result, settled: false };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    return { ...result, settled: true };
  }

  getTask(taskId: string): CompileTaskSummary | null {
    const queued = this.state.queue.find((task) => task.taskId === taskId);
    if (queued) return toTaskSummary(queued);

    const active = this.state.active.get(taskId);
    if (active) return toTaskSummary(active);

    this.pruneHistory();
    return this.state.history.get(taskId) ?? null;
  }

  getStats(): {
    waiting: number;
    running: number;
    total: number;
    maxConcurrent: number;
    accepting: boolean;
    maxQueued: number;
  } {
    this.pruneHistory();
    return {
      waiting: this.state.queue.length,
      running: this.state.active.size,
      total: this.state.queue.length + this.state.active.size + this.state.history.size,
      maxConcurrent: this.maxConcurrent,
      maxQueued: this.maxQueued,
      accepting: this.accepting,
    };
  }

  async shutdown(): Promise<void> {
    this.accepting = false;
    for (const task of this.state.queue) {
      this.cancelQueuedTask(task);
    }
    this.state.queue = [];

    const deadline = Date.now() + 30_000;
    while (this.state.active.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    for (const task of this.state.active.values()) {
      task.abortController.abort();
    }
  }

  private cancelQueuedTask(task: CompileTask): void {
    task.status = "canceled";
    task.completedAt = new Date().toISOString();
    task.abortController.abort();
    task.onDiscarded?.();
    this.recordHistory(task);
  }

  private async processNext(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.accepting && this.state.active.size < this.maxConcurrent) {
        const task = this.state.queue.shift();
        if (!task) return;

        this.state.active.set(task.taskId, task);
        this.executeTask(task);
      }
    } finally {
      this.processing = false;
    }
  }

  private executeTask(task: CompileTask): void {
    task.status = "running";
    task.startedAt = new Date().toISOString();

    void task
      .run()
      .then(() => {
        if (task.status === "running") {
          task.status = task.abortController.signal.aborted ? "canceled" : "success";
        }
      })
      .catch((error: unknown) => {
        if (task.status === "running") {
          task.status = task.abortController.signal.aborted ? "canceled" : "error";
        }
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[TaskManager] Task ${task.taskId} failed: ${message}\n`);
      })
      .finally(() => this.onTaskComplete(task));
  }

  private onTaskComplete(task: CompileTask): void {
    this.state.active.delete(task.taskId);
    task.completedAt = new Date().toISOString();
    this.recordHistory(task);
    void this.processNext();
  }

  private recordHistory(task: CompileTask): void {
    this.state.history.delete(task.taskId);
    this.state.history.set(task.taskId, toTaskSummary(task));
    this.pruneHistory();
  }

  private pruneHistory(): void {
    const now = Date.now();
    for (const [taskId, task] of this.state.history) {
      const completedAt = task.completedAt ? Date.parse(task.completedAt) : now;
      if (now - completedAt > this.historyTtlMs) {
        this.state.history.delete(taskId);
      }
    }

    while (this.state.history.size > this.historyLimit) {
      const oldestTaskId = this.state.history.keys().next().value as string | undefined;
      if (!oldestTaskId) return;
      this.state.history.delete(oldestTaskId);
    }
  }
}

const MANAGER_KEY = "__backslash_compile_task_manager__" as const;

function getSingleton(): CompileTaskManager | null {
  return (
    (globalThis as unknown as Record<string, CompileTaskManager | undefined>)[
      MANAGER_KEY
    ] ?? null
  );
}

function setSingleton(instance: CompileTaskManager | null): void {
  (globalThis as unknown as Record<string, CompileTaskManager | null>)[
    MANAGER_KEY
  ] = instance;
}

export function getCompileTaskManager(): CompileTaskManager {
  const existing = getSingleton();
  if (existing) return existing;

  const manager = new CompileTaskManager();
  setSingleton(manager);
  return manager;
}

export async function cancelProjectCompileTasks(
  projectId: string,
  timeoutMs = 10_000
): Promise<CancelResult & { settled: boolean }> {
  return getCompileTaskManager().cancelProjectAndWait(projectId, timeoutMs);
}

export async function shutdownCompileTaskManager(): Promise<void> {
  const manager = getSingleton();
  if (manager) {
    await manager.shutdown();
    setSingleton(null);
  }
}
