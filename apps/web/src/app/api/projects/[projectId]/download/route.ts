import { resolveProjectAccess } from "@/lib/auth/project-access";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import * as storage from "@/lib/storage";
import { withProjectMutationLock } from "@/lib/storage/project-mutation-lock";
import { NextRequest, NextResponse } from "next/server";
import archiver from "archiver";
import { PassThrough, Readable } from "stream";

// ─── GET /api/projects/[projectId]/download ────────
// Download a consistent point-in-time snapshot of the entire project.

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  let snapshot: storage.DirectorySnapshot | null = null;
  try {
    const { projectId } = await params;

    const access = await resolveProjectAccess(request, projectId);
    if (!access.access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const rateLimited = enforceRateLimit(request, "project:download", {
      limit: 12,
      windowMs: 60_000,
      identifier: access.user?.id ?? `share:${projectId}`,
    });
    if (rateLimited) return rateLimited;

    const project = access.project;
    const projectDir = storage.getProjectDir(project.userId, projectId);
    snapshot = await withProjectMutationLock(projectId, async () => {
      if (!(await storage.fileExists(projectDir))) {
        return null;
      }
      return storage.createDirectorySnapshot(projectDir);
    });

    if (!snapshot) {
      return NextResponse.json(
        { error: "Project directory not found" },
        { status: 404 }
      );
    }

    const safeName =
      project.name
        .trim()
        .replace(/[^a-zA-Z0-9_\-. ]/g, "")
        .replace(/\s+/g, "_")
        .substring(0, 100) || "project";
    const zipFileName = `${safeName}.zip`;

    const archive = archiver("zip", { zlib: { level: 6 } });
    const output = new PassThrough();
    const activeSnapshot = snapshot;
    let cleanupStarted = false;
    const cleanup = () => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      void activeSnapshot.cleanup().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[Storage] Failed to remove download snapshot: ${message}\n`);
      });
    };

    output.once("close", cleanup);
    output.once("error", cleanup);
    archive.once("error", (error) => output.destroy(error));
    archive.pipe(output);
    archive.directory(activeSnapshot.directory, false);
    void archive.finalize().catch((error: unknown) =>
      output.destroy(error instanceof Error ? error : new Error(String(error)))
    );

    snapshot = null;
    return new NextResponse(Readable.toWeb(output) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${zipFileName}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (snapshot) {
      await snapshot.cleanup().catch(() => undefined);
    }
    console.error("Error downloading project:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
