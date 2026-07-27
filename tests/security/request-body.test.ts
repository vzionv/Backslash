import { describe, expect, it } from "vitest";
import {
  readJsonBody,
} from "../../apps/web/src/lib/security/request-body";

function post(body: BodyInit, contentType = "application/json"): Request {
  return new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
}

describe("bounded JSON request bodies", () => {
  it("accepts JSON media types with parameters and +json suffixes", async () => {
    await expect(
      readJsonBody(post('{"value":1}', "application/json; charset=utf-8") as never, 128)
    ).resolves.toEqual({ value: 1 });
    await expect(
      readJsonBody(post('{"ok":true}', "application/problem+json") as never, 128)
    ).resolves.toEqual({ ok: true });
  });

  it("does not accept a media type that merely contains application/json", async () => {
    await expect(
      readJsonBody(post("{}", "text/application/jsonish") as never, 128)
    ).rejects.toMatchObject({ status: 415 });
  });

  it("rejects an oversized declared or chunked body", async () => {
    const declared = new Request("http://localhost/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "1024",
      },
      body: "{}",
    });
    await expect(readJsonBody(declared as never, 64)).rejects.toMatchObject({
      status: 413,
    });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":"'));
        controller.enqueue(new Uint8Array(128));
        controller.enqueue(new TextEncoder().encode('"}'));
        controller.close();
      },
    });
    const chunked = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readJsonBody(chunked as never, 64)).rejects.toMatchObject({
      status: 413,
    });
  });

  it("rejects empty and malformed JSON", async () => {
    await expect(readJsonBody(post("") as never, 128)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      readJsonBody(post('{"broken"') as never, 128)
    ).rejects.toMatchObject({ status: 400 });
  });
});
