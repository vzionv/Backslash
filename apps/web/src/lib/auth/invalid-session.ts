interface SessionCookieResponse {
  cookies: {
    delete: (name: string) => void;
  };
}

export function clearInvalidSessionCookie(
  response: SessionCookieResponse,
  hasSessionCookie: boolean
): void {
  if (hasSessionCookie) {
    response.cookies.delete("session");
  }
}
