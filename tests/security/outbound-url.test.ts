import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeOutboundUrl,
  normalizeOutboundUrl,
} from "../../apps/web/src/lib/security/outbound-url";

describe("outbound AI endpoint validation", () => {
  afterEach(() => {
    delete process.env.AI_ALLOW_PRIVATE_ENDPOINTS;
  });

  it("normalizes HTTP(S) URLs and strips fragments/trailing slash", () => {
    expect(normalizeOutboundUrl("https://api.example.com/v1/#fragment")).toBe(
      "https://api.example.com/v1"
    );
  });

  it("rejects non-HTTP schemes and embedded credentials", () => {
    expect(() => normalizeOutboundUrl("file:///etc/passwd")).toThrow();
    expect(() => normalizeOutboundUrl("https://user:pass@example.com/v1")).toThrow();
  });

  it("rejects loopback/private literal addresses by default", async () => {
    await expect(assertSafeOutboundUrl("http://127.0.0.1:8080/v1")).rejects.toThrow();
    await expect(assertSafeOutboundUrl("http://[::1]:8080/v1")).rejects.toThrow();
    await expect(assertSafeOutboundUrl("http://192.168.1.10:8080/v1")).rejects.toThrow();
  });

  it("permits explicitly opted-in LAN endpoints", async () => {
    process.env.AI_ALLOW_PRIVATE_ENDPOINTS = "true";
    await expect(assertSafeOutboundUrl("http://127.0.0.1:8080/v1")).resolves.toBe(
      "http://127.0.0.1:8080/v1"
    );
  });
});
