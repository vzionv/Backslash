import type { NextRequest } from "next/server";

function normalizeHttpOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("APP_URL must use http or https");
  }
  return url.origin;
}

export function getApplicationBaseUrl(request: NextRequest): string {
  const configured = process.env.APP_URL?.trim();
  if (configured) return normalizeHttpOrigin(configured);

  if (process.env.NODE_ENV === "production") {
    throw new Error("APP_URL must be configured in production");
  }

  if (process.env.TRUST_PROXY_HEADERS === "true") {
    const host = request.headers.get("x-forwarded-host")?.split(",", 1)[0].trim();
    const proto = request.headers.get("x-forwarded-proto")?.split(",", 1)[0].trim();
    if (host && (proto === "http" || proto === "https")) {
      return normalizeHttpOrigin(`${proto}://${host}`);
    }
  }

  return request.nextUrl.origin;
}
