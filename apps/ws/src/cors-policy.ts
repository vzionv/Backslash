export interface CorsPolicy {
  displayValue: string;
  allowedOrigins: ReadonlySet<string>;
  allowAnyOrigin: boolean;
}

function normalizeOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported CORS origin protocol: ${parsed.protocol}`);
  }
  if (
    parsed.username ||
    parsed.password ||
    (parsed.pathname && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`CORS origins must not include credentials, a path, query, or fragment: ${value}`);
  }
  return parsed.origin;
}

export function createCorsPolicy(
  configuredValue: string,
  allowAnyOrigin: boolean
): CorsPolicy {
  const entries = configuredValue
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (entries.length === 0) throw new Error("CORS_ORIGIN must not be empty");

  const hasWildcard = entries.includes("*");
  if (hasWildcard && !allowAnyOrigin) {
    throw new Error(
      "CORS_ORIGIN=* requires CORS_ALLOW_ANY_ORIGIN_ACKNOWLEDGE_RISK=true"
    );
  }
  if (hasWildcard && entries.length > 1) {
    throw new Error("CORS_ORIGIN=* cannot be combined with explicit origins");
  }

  return {
    displayValue: configuredValue,
    allowedOrigins: new Set(hasWildcard ? [] : entries.map(normalizeOrigin)),
    allowAnyOrigin: hasWildcard && allowAnyOrigin,
  };
}

export function isCorsOriginAllowed(
  policy: CorsPolicy,
  origin: string | undefined
): boolean {
  return !origin || policy.allowAnyOrigin || policy.allowedOrigins.has(origin);
}
