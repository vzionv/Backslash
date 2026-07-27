import { describe, expect, it } from "vitest";

import {
  mergeProjectSummaries,
  type ProjectSummaryInput,
} from "../../apps/web/src/lib/projects/project-summary-service";

const ownedProject: ProjectSummaryInput = {
  id: "project-owned",
  userId: "owner-1",
  name: "Owned project",
  description: "Description",
  engine: "auto",
  mainFile: "main.tex",
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-25T00:00:00.000Z",
};

describe("mergeProjectSummaries", () => {
  it("maps latest builds, active sharing state, and labels by project id", () => {
    const summaries = mergeProjectSummaries(
      [ownedProject],
      [{ projectId: "project-owned", status: "success" }],
      [
        { projectId: "project-owned", id: "share-1" },
        { projectId: "project-owned", id: "share-2" },
      ],
      [{ projectId: "project-owned", id: "public-1" }],
      [
        { projectId: "project-owned", id: "label-1", name: "Research" },
        { projectId: "project-owned", id: "label-2", name: "Draft" },
      ]
    );

    expect(summaries).toEqual([
      {
        ...ownedProject,
        lastBuildStatus: "success",
        sharedWithCount: 2,
        anyoneShared: true,
        isShared: true,
        labels: [
          { id: "label-1", name: "Research" },
          { id: "label-2", name: "Draft" },
        ],
      },
    ]);
  });

  it("returns default summary values when related rows are absent", () => {
    expect(mergeProjectSummaries([ownedProject], [], [], [], [])).toEqual([
      {
        ...ownedProject,
        lastBuildStatus: null,
        sharedWithCount: 0,
        anyoneShared: false,
        isShared: false,
        labels: [],
      },
    ]);
  });
});
