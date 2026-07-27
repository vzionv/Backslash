import { resolveProjectAccess } from "@/lib/auth/project-access";
import * as storage from "@/lib/storage";
import { assertProjectPathHasNoSymlink } from "@/lib/storage/path-security";
import { NextRequest, NextResponse } from "next/server";

function buildDownloadPdfName(projectName: string): string {
  const safeProjectName =
    projectName
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  const unixEpoch = Math.floor(Date.now() / 1000);
  return `${safeProjectName}-${unixEpoch}.pdf`;
}

// ─── GET /api/projects/[projectId]/pdf ─────────────
// Serve the compiled PDF for a project.

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;

    const access = await resolveProjectAccess(request, projectId);
    if (!access.access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const project = access.project;

    // Resolve the PDF path on disk (use project owner's directory)
    let pdfPath: string;
    let pdfName: string;
    try {
      pdfPath = storage.getPdfPath(project.userId, projectId, project.mainFile);
      pdfName = storage.getPdfName(project.mainFile);
    } catch {
      return NextResponse.json(
        { error: "PDF not found. Please compile the project first." },
        { status: 404 }
      );
    }
    try {
      await assertProjectPathHasNoSymlink(
        storage.getProjectDir(project.userId, projectId),
        pdfName
      );
    } catch {
      return NextResponse.json(
        { error: "PDF not found. Please compile the project first." },
        { status: 404 }
      );
    }
    const exists = await storage.fileExists(pdfPath);

    if (!exists) {
      return NextResponse.json(
        { error: "PDF not found. Please compile the project first." },
        { status: 404 }
      );
    }

    const downloadPdfName = buildDownloadPdfName(project.name);

    // Support ?download=true for Content-Disposition: attachment
    const download = request.nextUrl.searchParams.get("download") === "true";

    return storage.createFileResponse(pdfPath, {
      "Content-Type": "application/pdf",
      "Content-Disposition": download
        ? `attachment; filename="${downloadPdfName}"`
        : `inline; filename="${pdfName}"`,
    }, request);
  } catch (error) {
    console.error("Error serving PDF:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
