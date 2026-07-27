import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "net";
import type { Server } from "http";

import { createInternalEventsServer } from "../../apps/ws/src/internal-events-server";

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

describe("WS internal event server", () => {
  it("maps build and file events to the established rooms and socket payloads", async () => {
    const emitToUser = vi.fn();
    const emitToProject = vi.fn();
    const server = createInternalEventsServer({
      sharedKey: "test-internal-key",
      emitToUser,
      emitToProject,
    });
    const baseUrl = await startServer(server);

    const buildResponse = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-backslash-internal-key": "test-internal-key",
      },
      body: JSON.stringify({
        type: "build",
        userId: "user-1",
        payload: {
          projectId: "project-1",
          buildId: "build-1",
          status: "success",
          pdfUrl: "/api/projects/project-1/pdf",
          logs: "done",
          durationMs: 42,
          errors: [],
        },
      }),
    });
    const fileResponse = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-backslash-internal-key": "test-internal-key",
      },
      body: JSON.stringify({
        type: "file",
        payload: {
          type: "file:created",
          projectId: "project-1",
          userId: "user-1",
          fileId: "file-1",
          path: "chapters/intro.tex",
          isDirectory: false,
        },
      }),
    });

    expect(buildResponse.status).toBe(204);
    expect(fileResponse.status).toBe(204);
    expect(emitToUser).toHaveBeenCalledWith(
      "user-1",
      "build:complete",
      expect.objectContaining({ buildId: "build-1", status: "success" })
    );
    expect(emitToProject).toHaveBeenCalledWith(
      "project-1",
      "file:created",
      {
        userId: "user-1",
        file: {
          id: "file-1",
          path: "chapters/intro.tex",
          isDirectory: false,
        },
      }
    );
  });

  it("rejects invalid shared keys and malformed events", async () => {
    const server = createInternalEventsServer({
      sharedKey: "test-internal-key",
      emitToUser: vi.fn(),
      emitToProject: vi.fn(),
    });
    const baseUrl = await startServer(server);

    const unauthorized = await fetch(`${baseUrl}/events`, { method: "POST" });
    const invalid = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-backslash-internal-key": "test-internal-key",
      },
      body: JSON.stringify({ type: "unknown" }),
    });

    expect(unauthorized.status).toBe(401);
    expect(invalid.status).toBe(400);
  });
});
