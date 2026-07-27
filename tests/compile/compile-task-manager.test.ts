import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  CompileQueueFullError,
  CompileTaskManager,
  CompileTask,
} from "../../apps/web/src/lib/compiler/compile-task-manager";

describe("CompileTaskManager", () => {
  let manager: CompileTaskManager;

  beforeEach(() => {
    manager = new CompileTaskManager(2);
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  function createMockTask(
    taskId: string,
    projectId: string,
    runDelayMs: number = 50
  ): CompileTask {
    return {
      taskId,
      projectId,
      status: "waiting",
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      abortController: new AbortController(),
      run: () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            resolve();
          }, runDelayMs);
        }),
    };
  }

  it("enqueues and processes a single task", async () => {
    const task = createMockTask("t1", "p1", 10);
    manager.enqueue(task);

    // Wait for processing
    await new Promise((r) => setTimeout(r, 50));

    const stats = manager.getStats();
    expect(stats.running).toBe(0);
    expect(stats.waiting).toBe(0);
    expect(stats.total).toBeGreaterThanOrEqual(1);
  });

  it("respects max concurrency limit", async () => {
    // Enqueue 3 tasks with concurrency 2
    const t1 = createMockTask("t1", "p1", 100);
    const t2 = createMockTask("t2", "p2", 100);
    const t3 = createMockTask("t3", "p3", 100);

    manager.enqueue(t1);
    manager.enqueue(t2);
    manager.enqueue(t3);

    // Small delay to let processing start
    await new Promise((r) => setTimeout(r, 20));

    const stats = manager.getStats();
    expect(stats.running).toBeLessThanOrEqual(2);
    expect(stats.running + stats.waiting).toBeGreaterThanOrEqual(2);

    // Wait for all to complete
    await new Promise((r) => setTimeout(r, 200));

    const finalStats = manager.getStats();
    expect(finalStats.running).toBe(0);
    expect(finalStats.waiting).toBe(0);
  });

  it("replaces only a waiting task with the same deduplication key", async () => {
    manager = new CompileTaskManager(1);
    const first = createMockTask("first", "project-1", 500);
    const replaced = createMockTask("replaced", "project-1", 100);
    const latest = createMockTask("latest", "project-1", 100);
    first.deduplicationKey = "project-1";
    replaced.deduplicationKey = "project-1";
    latest.deduplicationKey = "project-1";

    manager.enqueue(first);
    manager.enqueue(replaced);
    manager.enqueue(latest);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(manager.getTask("first")?.status).toBe("running");
    expect(manager.getTask("replaced")?.status).toBe("canceled");
    expect(manager.getTask("latest")?.status).toBe("waiting");
  });

  it("does not replace tasks without a deduplication key", async () => {
    manager = new CompileTaskManager(1);
    const first = createMockTask("first", "async-first", 500);
    const second = createMockTask("second", "async-second", 100);

    manager.enqueue(first);
    manager.enqueue(second);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(manager.getTask("first")).not.toBeNull();
    expect(manager.getTask("second")).not.toBeNull();
    expect(manager.getStats().waiting).toBe(1);
  });

  it("cancels an individual task without canceling another project task", async () => {
    manager = new CompileTaskManager(1);
    const first = createMockTask("first", "project-1", 500);
    const second = createMockTask("second", "project-1", 100);

    manager.enqueue(first);
    manager.enqueue(second);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = manager.cancelByTaskId("second");

    expect(result).toMatchObject({
      canceled: true,
      wasQueued: true,
      wasRunning: false,
      taskId: "second",
    });
    expect(manager.getTask("first")).not.toBeNull();
    expect(manager.getTask("second")?.status).toBe("canceled");
  });

  it("cancels a running task", async () => {
    const task = createMockTask("t1", "p1", 5000);
    let aborted = false;
    task.run = () =>
      new Promise<void>((resolve) => {
        task.abortController.signal.addEventListener("abort", () => {
          aborted = true;
          task.status = "canceled";
          resolve();
        });
        // Don't auto-resolve — only resolve on abort
      });

    manager.enqueue(task);
    // Wait for task to start running
    await new Promise((r) => setTimeout(r, 50));

    const result = manager.cancel("p1");
    expect(result.canceled).toBe(true);
    expect(aborted).toBe(true);

    // Wait for the abort handler to resolve
    await new Promise((r) => setTimeout(r, 50));

    const stats = manager.getStats();
    expect(stats.running).toBe(0);
  });

  it("cancels a queued task", async () => {
    // Use maxConcurrent=1 so the second task stays queued
    manager = new CompileTaskManager(1);
    const t1 = createMockTask("t1", "p1", 500);
    const t2 = createMockTask("t2", "p1", 100);

    manager.enqueue(t1);
    // t1 is now running, t2 should be queued
    manager.enqueue(t2);

    await new Promise((r) => setTimeout(r, 50));

    const result = manager.cancel("p1");
    expect(result.canceled).toBe(true);
    expect(result.wasQueued).toBe(true);
  });

  it("rejects tasks beyond the configured queue limit and discards them", async () => {
    manager = new CompileTaskManager(1, { maxQueued: 1 });
    const first = createMockTask("first", "project-1", 500);
    const waiting = createMockTask("waiting", "project-2", 100);
    const rejected = createMockTask("rejected", "project-3", 100);
    let discarded = false;
    rejected.onDiscarded = () => {
      discarded = true;
    };

    manager.enqueue(first);
    manager.enqueue(waiting);

    expect(() => manager.enqueue(rejected)).toThrow(CompileQueueFullError);
    expect(discarded).toBe(true);
    expect(manager.getStats()).toMatchObject({ running: 1, waiting: 1, maxQueued: 1 });
  });

  it("prevents new tasks after shutdown", async () => {
    await manager.shutdown();

    expect(() => {
      const task = createMockTask("t1", "p1");
      manager.enqueue(task);
    }).toThrow();
  });

  it("returns correct task status", async () => {
    const task = createMockTask("t1", "p1", 50);
    manager.enqueue(task);

    const found = manager.getTask("t1");
    expect(found).not.toBeNull();
    expect(found!.projectId).toBe("p1");
  });

  it("keeps only bounded terminal task summaries", async () => {
    manager = new CompileTaskManager(1, {
      historyLimit: 1,
      historyTtlMs: 60_000,
    });
    manager.enqueue(createMockTask("first", "project-1", 5));
    manager.enqueue(createMockTask("second", "project-2", 5));
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(manager.getTask("first")).toBeNull();
    expect(manager.getTask("second")).toMatchObject({
      taskId: "second",
      status: "success",
    });
  });

  it("returns correct stats", async () => {
    const stats = manager.getStats();
    expect(stats.waiting).toBe(0);
    expect(stats.running).toBe(0);
    expect(stats.maxConcurrent).toBe(2);
    expect(stats.accepting).toBe(true);
  });
});
