import { afterEach, describe, expect, it } from "vitest";

import {
  getProjectMutationLockCountForTests,
  withProjectMutationLock,
} from "../../apps/web/src/lib/storage/project-mutation-lock";

describe("project mutation lock", () => {
  afterEach(() => {
    expect(getProjectMutationLockCountForTests()).toBe(0);
  });

  it("serializes operations for the same project", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withProjectMutationLock("p1", async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
    });
    const second = withProjectMutationLock("p1", async () => {
      order.push("second");
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("allows different projects to proceed independently", async () => {
    const started = new Set<string>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const one = withProjectMutationLock("p1", async () => {
      started.add("p1");
      await gate;
    });
    const two = withProjectMutationLock("p2", async () => {
      started.add("p2");
    });

    await two;
    expect(started).toEqual(new Set(["p1", "p2"]));
    release();
    await one;
  });
});
