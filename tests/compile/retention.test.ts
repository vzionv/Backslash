import { describe, expect, it } from "vitest";

import { selectBuildIdsForRetentionCleanup } from "../../apps/web/src/lib/compiler/build-retention";

describe("build retention", () => {
  it("keeps the newest terminal builds per project and removes expired records", () => {
    const now = Date.parse("2026-07-26T12:00:00.000Z");
    const ids = selectBuildIdsForRetentionCleanup(
      [
        { id: "newest", projectId: "project-1", createdAt: "2026-07-26T11:00:00.000Z" },
        { id: "second", projectId: "project-1", createdAt: "2026-07-25T11:00:00.000Z" },
        { id: "third", projectId: "project-1", createdAt: "2026-07-24T11:00:00.000Z" },
        { id: "expired", projectId: "project-2", createdAt: "2026-06-01T11:00:00.000Z" },
      ],
      7,
      2,
      now
    );

    expect(ids).toEqual(["third", "expired"]);
  });
});
