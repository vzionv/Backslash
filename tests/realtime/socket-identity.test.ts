import { describe, expect, it } from "vitest";

import { isSocketIdentityCompatible } from "../../apps/ws/src/socket-identity";

const authenticated = {
  access: true as const,
  userId: "user-1",
  email: "user@example.com",
  name: "User",
  role: "owner" as const,
  isAnonymous: false,
};

describe("socket identity compatibility", () => {
  it("keeps authenticated sockets bound to the same account", () => {
    expect(
      isSocketIdentityCompatible(
        { userId: "user-1", isAnonymous: false },
        authenticated
      )
    ).toBe(true);
    expect(
      isSocketIdentityCompatible(
        { userId: "user-2", isAnonymous: false },
        authenticated
      )
    ).toBe(false);
  });

  it("rejects switching between authenticated and anonymous identities", () => {
    expect(
      isSocketIdentityCompatible(
        { userId: "user-1", isAnonymous: false },
        { ...authenticated, userId: "anonymous-1", isAnonymous: true }
      )
    ).toBe(false);
    expect(
      isSocketIdentityCompatible(
        { userId: "anonymous-1", isAnonymous: true },
        authenticated
      )
    ).toBe(false);
  });

  it("allows one anonymous socket to access another authorized share project", () => {
    expect(
      isSocketIdentityCompatible(
        { userId: "anonymous-1", isAnonymous: true },
        { ...authenticated, userId: "anonymous-2", isAnonymous: true }
      )
    ).toBe(true);
  });
});
