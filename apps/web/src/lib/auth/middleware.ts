import { NextRequest, NextResponse } from "next/server";
import { clearInvalidSessionCookie } from "./invalid-session";
import { validateSession } from "./session";

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export async function withAuth(
  request: NextRequest,
  handler: (
    req: NextRequest,
    user: AuthenticatedUser
  ) => Promise<NextResponse>
): Promise<NextResponse> {
  const token = request.cookies.get("session")?.value;

  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await validateSession(token);

  if (!result) {
    const response = NextResponse.json(
      { error: "Session expired or invalid" },
      { status: 401 }
    );
    clearInvalidSessionCookie(response, request.cookies.has("session"));
    return response;
  }

  return handler(request, result.user as unknown as AuthenticatedUser);
}
