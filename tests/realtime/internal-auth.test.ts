import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import type { Server } from "http";

import {
  createWebInternalServer,
  isValidInternalServiceKey,
} from "../../apps/web/src/lib/realtime/web-internal-server";

const servers: Server[] = [];

async function startServer(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve()))
    )
  );
});

describe("Web realtime internal authorization", () => {
  it("accepts the shared key and returns project credentials", async () => {
    const server = createWebInternalServer({
      sharedKey: "test-internal-key",
      authorize: async (request) => {
        expect(request).toEqual({
          projectId: "project-1",
          sessionToken: "session-token",
          shareToken: null,
        });
        return {
          access: true,
          userId: "user-1",
          email: "user@example.com",
          name: "User",
          role: "editor",
          isAnonymous: false,
        };
      },
    });
    const baseUrl = await startServer(server);

    const response = await fetch(`${baseUrl}/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-backslash-internal-key": "test-internal-key",
      },
      body: JSON.stringify({
        projectId: "project-1",
        sessionToken: "session-token",
        shareToken: null,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access: true,
      userId: "user-1",
      role: "editor",
    });
  });

  it("rejects missing and invalid shared keys", async () => {
    const server = createWebInternalServer({
      sharedKey: "test-internal-key",
      authorize: async () => ({ access: false }),
    });
    const baseUrl = await startServer(server);

    const missing = await fetch(`${baseUrl}/authorize`, { method: "POST" });
    const invalid = await fetch(`${baseUrl}/authorize`, {
      method: "POST",
      headers: { "x-backslash-internal-key": "incorrect" },
    });

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(isValidInternalServiceKey("short", "much-longer-key")).toBe(false);
  });
});
