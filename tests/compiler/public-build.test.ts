import { describe, expect, it } from "vitest";
import { toPublicBuild } from "../../apps/web/src/lib/compiler/public-build";

describe("toPublicBuild", () => {
  it("removes absolute server paths and keeps only availability", () => {
    const value = toPublicBuild({ id: "build-1", userId: "private-user", triggeredByUserId: "actor", pdfPath: "/srv/private/build.pdf" });
    expect(value).toEqual({ id: "build-1", pdfPath: null, pdfAvailable: true });
    expect(JSON.stringify(value)).not.toContain("/srv/private");
    expect(JSON.stringify(value)).not.toContain("private-user");
    expect(JSON.stringify(value)).not.toContain("actor");
  });

  it("reports unavailable PDFs without inventing a path", () => {
    expect(toPublicBuild({ id: "build-2", pdfPath: null })).toEqual({
      id: "build-2",
      pdfPath: null,
      pdfAvailable: false,
    });
  });
});
