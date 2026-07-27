import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { projectPublicShares, projects } from "@/lib/db/schema";
import { checkProjectAccess } from "@/lib/db/queries/projects";
import { validateSession } from "@/lib/auth/session";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import type {
  RealtimeAuthorizationRequest,
  RealtimeAuthorizationResponse,
} from "@backslash/shared";
import type { NextRequest } from "next/server";

type AccessRole = "owner" | "viewer" | "editor";

interface SessionUser {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectAccessContext {
  access: true;
  role: AccessRole;
  project: typeof projects.$inferSelect;
  user: SessionUser | null;
  isAnonymous: boolean;
  shareToken: string | null;
}

export interface ProjectAccessError {
  access: false;
  status: 401 | 404;
  error: string;
}

function getSessionToken(request: NextRequest): string | null {
  return request.cookies.get("session")?.value || null;
}

export function getShareToken(request: NextRequest): string | null {
  return (
    request.nextUrl.searchParams.get("share") ||
    request.headers.get("x-share-token") ||
    null
  );
}

async function resolvePublicShareAccess(
  projectId: string,
  shareToken: string
): Promise<ProjectAccessContext | ProjectAccessError> {
  const [publicShare] = await db
    .select({
      role: projectPublicShares.role,
    })
    .from(projectPublicShares)
    .where(
      and(
        eq(projectPublicShares.projectId, projectId),
        eq(projectPublicShares.token, shareToken),
        or(
          isNull(projectPublicShares.expiresAt),
          gt(projectPublicShares.expiresAt, new Date().toISOString())
        )
      )
    )
    .limit(1);

  if (!publicShare) {
    return { access: false, status: 404, error: "Project not found" };
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) {
    return { access: false, status: 404, error: "Project not found" };
  }

  return {
    access: true,
    role: publicShare.role as AccessRole,
    project,
    user: null,
    isAnonymous: true,
    shareToken,
  };
}

export async function resolveProjectAccessFromCredentials(
  projectId: string,
  sessionToken: string | null,
  shareToken: string | null
): Promise<ProjectAccessContext | ProjectAccessError> {
  if (sessionToken) {
    const session = await validateSession(sessionToken);
    if (session?.user) {
      const access = await checkProjectAccess(session.user.id, projectId);
      if (access.access) {
        return {
          access: true,
          role: access.role,
          project: access.project,
          user: session.user as unknown as SessionUser,
          isAnonymous: false,
          shareToken: null,
        };
      }
      if (!shareToken) {
        return { access: false, status: 404, error: "Project not found" };
      }
    }
  }

  if (!shareToken) {
    return { access: false, status: 401, error: "Unauthorized" };
  }

  return resolvePublicShareAccess(projectId, shareToken);
}

export async function authorizeRealtimeClient(
  request: RealtimeAuthorizationRequest
): Promise<RealtimeAuthorizationResponse> {
  const session = request.sessionToken
    ? await validateSession(request.sessionToken)
    : null;
  const access = await resolveProjectAccessFromCredentials(
    request.projectId,
    request.sessionToken,
    request.shareToken
  );
  if (!access.access) return { access: false };

  const user = session?.user ?? access.user;
  if (user) {
    return {
      access: true,
      userId: user.id,
      email: user.email,
      name: user.name,
      role: access.role,
      isAnonymous: false,
    };
  }

  const visitorNumber = Math.floor(1000 + Math.random() * 9000);
  return {
    access: true,
    userId: `anon_${randomUUID()}`,
    email: "anonymous@public-link",
    name: `Visitor ${visitorNumber}`,
    role: access.role,
    isAnonymous: true,
  };
}

export async function resolveProjectAccess(
  request: NextRequest,
  projectId: string
): Promise<ProjectAccessContext | ProjectAccessError> {
  return resolveProjectAccessFromCredentials(
    projectId,
    getSessionToken(request),
    getShareToken(request)
  );
}
