import { and, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  builds,
  labels,
  projectLabels,
  projectPublicShares,
  projectShares,
  projects,
} from "@/lib/db/schema";

export interface ProjectSummaryInput {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  engine: string;
  mainFile: string;
  createdAt: string;
  updatedAt: string;
}

interface LatestBuildRow {
  projectId: string;
  status: string;
}

interface ProjectIdRow {
  projectId: string;
  id: string;
}

interface ProjectLabelRow {
  projectId: string;
  id: string;
  name: string;
}

export interface ProjectSummary extends ProjectSummaryInput {
  lastBuildStatus: string | null;
  sharedWithCount: number;
  anyoneShared: boolean;
  isShared: boolean;
  labels: Array<{ id: string; name: string }>;
}

function groupLatestBuildStatuses(
  rows: LatestBuildRow[]
): Map<string, string> {
  const statuses = new Map<string, string>();
  for (const row of rows) {
    if (!statuses.has(row.projectId)) {
      statuses.set(row.projectId, row.status);
    }
  }
  return statuses;
}

function countProjectRows(rows: ProjectIdRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.projectId, (counts.get(row.projectId) ?? 0) + 1);
  }
  return counts;
}

function groupProjectLabels(
  rows: ProjectLabelRow[]
): Map<string, Array<{ id: string; name: string }>> {
  const labelsByProject = new Map<string, Array<{ id: string; name: string }>>();
  for (const row of rows) {
    const current = labelsByProject.get(row.projectId) ?? [];
    labelsByProject.set(row.projectId, [...current, { id: row.id, name: row.name }]);
  }
  return labelsByProject;
}

export function mergeProjectSummaries(
  projectRows: ProjectSummaryInput[],
  latestBuildRows: LatestBuildRow[],
  activeShareRows: ProjectIdRow[],
  publicShareRows: ProjectIdRow[],
  projectLabelRows: ProjectLabelRow[]
): ProjectSummary[] {
  const latestBuildStatuses = groupLatestBuildStatuses(latestBuildRows);
  const shareCounts = countProjectRows(activeShareRows);
  const publicProjectIds = new Set(publicShareRows.map((row) => row.projectId));
  const labelsByProject = groupProjectLabels(projectLabelRows);

  return projectRows.map((project) => {
    const sharedWithCount = shareCounts.get(project.id) ?? 0;
    const anyoneShared = publicProjectIds.has(project.id);

    return {
      ...project,
      lastBuildStatus: latestBuildStatuses.get(project.id) ?? null,
      sharedWithCount,
      anyoneShared,
      isShared: sharedWithCount > 0 || anyoneShared,
      labels: labelsByProject.get(project.id) ?? [],
    };
  });
}

export async function getProjectSummaries(
  projectRows: ProjectSummaryInput[]
): Promise<ProjectSummary[]> {
  if (projectRows.length === 0) return [];

  const projectIds = projectRows.map((project) => project.id);
  const now = new Date().toISOString();
  const [latestBuildRows, activeShareRows, publicShareRows, projectLabelRows] =
    await Promise.all([
      db
        .select({ projectId: builds.projectId, status: builds.status })
        .from(builds)
        .where(inArray(builds.projectId, projectIds))
        .orderBy(desc(builds.createdAt), desc(builds.id)),
      db
        .select({ projectId: projectShares.projectId, id: projectShares.id })
        .from(projectShares)
        .where(
          and(
            inArray(projectShares.projectId, projectIds),
            or(
              isNull(projectShares.expiresAt),
              gt(projectShares.expiresAt, now)
            )
          )
        ),
      db
        .select({ projectId: projectPublicShares.projectId, id: projectPublicShares.id })
        .from(projectPublicShares)
        .where(
          and(
            inArray(projectPublicShares.projectId, projectIds),
            or(
              isNull(projectPublicShares.expiresAt),
              gt(projectPublicShares.expiresAt, now)
            )
          )
        ),
      db
        .select({
          projectId: projectLabels.projectId,
          id: labels.id,
          name: labels.name,
        })
        .from(projectLabels)
        .innerJoin(labels, eq(labels.id, projectLabels.labelId))
        .where(inArray(projectLabels.projectId, projectIds)),
    ]);

  return mergeProjectSummaries(
    projectRows,
    latestBuildRows,
    activeShareRows,
    publicShareRows,
    projectLabelRows
  );
}

export async function getLatestBuildStatuses(
  projectRows: ProjectSummaryInput[]
): Promise<Map<string, string>> {
  if (projectRows.length === 0) return new Map();

  const rows = await db
    .select({ projectId: builds.projectId, status: builds.status })
    .from(builds)
    .where(inArray(builds.projectId, projectRows.map((project) => project.id)))
    .orderBy(desc(builds.createdAt), desc(builds.id));

  return groupLatestBuildStatuses(rows);
}

export async function getProjectLabelMap(
  projectRows: ProjectSummaryInput[]
): Promise<Map<string, Array<{ id: string; name: string }>>> {
  if (projectRows.length === 0) return new Map();

  const rows = await db
    .select({
      projectId: projectLabels.projectId,
      id: labels.id,
      name: labels.name,
    })
    .from(projectLabels)
    .innerJoin(labels, eq(labels.id, projectLabels.labelId))
    .where(
      inArray(
        projectLabels.projectId,
        projectRows.map((project) => project.id)
      )
    );

  return groupProjectLabels(rows);
}

export async function enrichProjectsWithBuildsAndLabels<
  T extends ProjectSummaryInput,
>(projectRows: T[]): Promise<Array<T & {
  lastBuildStatus: string | null;
  labels: Array<{ id: string; name: string }>;
}>> {
  const [latestBuildStatuses, labelsByProject] = await Promise.all([
    getLatestBuildStatuses(projectRows),
    getProjectLabelMap(projectRows),
  ]);

  return projectRows.map((project) => ({
    ...project,
    lastBuildStatus: latestBuildStatuses.get(project.id) ?? null,
    labels: labelsByProject.get(project.id) ?? [],
  }));
}

export async function listOwnedProjectSummaries(
  userId: string
): Promise<ProjectSummary[]> {
  const projectRows = await db
    .select()
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.updatedAt));

  return getProjectSummaries(projectRows);
}
