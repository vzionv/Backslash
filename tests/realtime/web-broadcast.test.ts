import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

import {
  broadcastBuildUpdate,
  broadcastProjectAccessChanged,
} from "../../apps/web/src/lib/websocket/server";

const servers: Server[] = [];
const originalEnvironment = {
  key: process.env.BACKSLASH_INTERNAL_SERVICE_KEY,
  port: process.env.WS_INTERNAL_PORT,
};

async function startEventReceiver(
  onEvent: (body: unknown) => void
): Promise<number> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    onEvent(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
    response.writeHead(204);
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve()))
    )
  );
  process.env.BACKSLASH_INTERNAL_SERVICE_KEY = originalEnvironment.key;
  process.env.WS_INTERNAL_PORT = originalEnvironment.port;
  vi.restoreAllMocks();
});

describe("Web realtime broadcasts", () => {
  it("posts the existing build payload to the WS loopback event endpoint", async () => {
    const received = vi.fn();
    const port = await startEventReceiver(received);
    process.env.BACKSLASH_INTERNAL_SERVICE_KEY = "test-internal-key-0123456789abcdef";
    process.env.WS_INTERNAL_PORT = String(port);

    broadcastBuildUpdate("user-1", {
      projectId: "project-1",
      buildId: "build-1",
      status: "success",
      pdfUrl: "/api/projects/project-1/pdf",
      logs: "done",
      durationMs: 42,
      errors: [],
    });

    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(1));
    expect(received).toHaveBeenCalledWith({
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
    });
  });


  it("posts project access changes for immediate socket revalidation", async () => {
    const received = vi.fn();
    const port = await startEventReceiver(received);
    process.env.BACKSLASH_INTERNAL_SERVICE_KEY = "test-internal-key-0123456789abcdef";
    process.env.WS_INTERNAL_PORT = String(port);

    broadcastProjectAccessChanged("project-1");

    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(1));
    expect(received).toHaveBeenCalledWith({
      type: "access",
      payload: { projectId: "project-1" },
    });
  });

  it("does not throw when the WS loopback endpoint is unavailable", () => {
    process.env.BACKSLASH_INTERNAL_SERVICE_KEY = "test-internal-key";
    process.env.WS_INTERNAL_PORT = "65534";

    expect(() => {
      broadcastBuildUpdate("user-1", {
        projectId: "project-1",
        buildId: "build-1",
        status: "queued",
      });
    }).not.toThrow();
  });
});
