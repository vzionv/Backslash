import { describe, expect, it } from "vitest";

import { createCorsPolicy, isCorsOriginAllowed } from "../../apps/ws/src/cors-policy";

describe("WebSocket CORS policy", () => {
  it("accepts only explicitly configured browser origins", () => {
    const policy = createCorsPolicy(
      "http://localhost:3000/,https://latex.example.com",
      false
    );
    expect(isCorsOriginAllowed(policy, undefined)).toBe(true);
    expect(isCorsOriginAllowed(policy, "https://latex.example.com")).toBe(true);
    expect(isCorsOriginAllowed(policy, "https://evil.example.com")).toBe(false);
  });

  it("requires explicit acknowledgement for wildcard origins", () => {
    expect(() => createCorsPolicy("*", false)).toThrow(/ACKNOWLEDGE_RISK/);
    const policy = createCorsPolicy("*", true);
    expect(isCorsOriginAllowed(policy, "https://any.example.com")).toBe(true);
  });

  it("rejects origins containing paths", () => {
    expect(() => createCorsPolicy("https://example.com/path", false)).toThrow(
      /must not include credentials, a path/
    );
  });
});
