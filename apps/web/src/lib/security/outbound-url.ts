import { lookup } from "dns/promises";
import net from "net";

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return true;
  }
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPrivateIp(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family !== 6) return true;

  const normalized = address.toLowerCase().split("%", 1)[0];
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith("ff")) return true;
  if (normalized.startsWith("2001:db8:")) return true;
  if (normalized.startsWith("::ffff:")) {
    return isPrivateIpv4(normalized.slice("::ffff:".length));
  }
  return false;
}

export function normalizeOutboundUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("AI endpoint must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("AI endpoint must not contain embedded credentials");
  }
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/**
 * Reject obvious SSRF targets immediately before each provider request.
 * Redirects are disabled by the caller so every contacted host is validated.
 * Deployments that intentionally use a LAN-hosted AI endpoint must opt in.
 */
export async function assertSafeOutboundUrl(value: string): Promise<string> {
  const normalized = normalizeOutboundUrl(value);
  if (process.env.AI_ALLOW_PRIVATE_ENDPOINTS === "true") return normalized;

  const hostname = new URL(normalized).hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("Private AI endpoints are disabled");
  }

  const addresses = net.isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  const safe =
    addresses.length > 0 &&
    addresses.every(({ address }) => !isPrivateIp(address));
  if (!safe) throw new Error("Private AI endpoints are disabled");
  return normalized;
}
