import { describe, expect, it, vi } from "vitest";
import { clearInvalidSessionCookie } from "../../apps/web/src/lib/auth/invalid-session";

describe("clearInvalidSessionCookie", () => {
  it("deletes the session cookie after a rejected cookie session", () => {
    const deleteCookie = vi.fn();

    clearInvalidSessionCookie({ cookies: { delete: deleteCookie } }, true);

    expect(deleteCookie).toHaveBeenCalledWith("session");
  });

  it("does not alter browser cookies for rejected bearer authentication", () => {
    const deleteCookie = vi.fn();

    clearInvalidSessionCookie({ cookies: { delete: deleteCookie } }, false);

    expect(deleteCookie).not.toHaveBeenCalled();
  });
});
