export interface RetainedBuild {
  id: string;
  projectId: string;
  createdAt: string;
}

export function selectBuildIdsForRetentionCleanup(
  builds: RetainedBuild[],
  retentionDays: number,
  maxPerProject: number,
  now: number = Date.now()
): string[] {
  const cutoff = now - retentionDays * 24 * 60 * 60_000;
  const perProjectCount = new Map<string, number>();
  const deletedIds: string[] = [];

  for (const build of builds) {
    const retained = perProjectCount.get(build.projectId) ?? 0;
    const olderThanRetention = Date.parse(build.createdAt) < cutoff;
    if (olderThanRetention || retained >= maxPerProject) {
      deletedIds.push(build.id);
      continue;
    }
    perProjectCount.set(build.projectId, retained + 1);
  }

  return deletedIds;
}
