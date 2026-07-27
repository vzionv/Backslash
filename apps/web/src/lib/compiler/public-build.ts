interface BuildWithPrivateFields {
  pdfPath?: string | null;
  userId?: string;
  triggeredByUserId?: string | null;
}

export type PublicBuild<T extends BuildWithPrivateFields> = Omit<
  T,
  "pdfPath" | "userId" | "triggeredByUserId"
> & {
  pdfPath: null;
  pdfAvailable: boolean;
};

/** Strip server paths and internal user identifiers from API build payloads. */
export function toPublicBuild<T extends BuildWithPrivateFields>(
  build: T | null | undefined
): PublicBuild<T> | null {
  if (!build) return null;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { pdfPath: privatePath, userId, triggeredByUserId, ...publicBuild } = build;
  return {
    ...publicBuild,
    pdfPath: null,
    pdfAvailable: Boolean(privatePath),
  } as PublicBuild<T>;
}
