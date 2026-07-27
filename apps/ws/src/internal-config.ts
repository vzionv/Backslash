const DEFAULT_WEB_INTERNAL_PORT = 3010;
const DEFAULT_WS_INTERNAL_PORT = 3011;

function parsePort(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }

  return port;
}

export interface InternalWsConfig {
  sharedKey: string;
  webPort: number;
  wsPort: number;
  publicHost: string;
}

export function getInternalWsConfig(): InternalWsConfig {
  const sharedKey = process.env.BACKSLASH_INTERNAL_SERVICE_KEY;
  if (!sharedKey || sharedKey.length < 32) {
    throw new Error(
      "BACKSLASH_INTERNAL_SERVICE_KEY must be configured with at least 32 characters"
    );
  }

  return {
    sharedKey,
    webPort: parsePort(
      process.env.WEB_INTERNAL_PORT,
      DEFAULT_WEB_INTERNAL_PORT,
      "WEB_INTERNAL_PORT"
    ),
    wsPort: parsePort(
      process.env.WS_INTERNAL_PORT,
      DEFAULT_WS_INTERNAL_PORT,
      "WS_INTERNAL_PORT"
    ),
    publicHost: process.env.WS_HOST ?? "0.0.0.0",
  };
}
