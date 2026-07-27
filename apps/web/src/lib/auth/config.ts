function readInteger(
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function shouldUseSecureCookies(): boolean {
  return (
    process.env.SECURE_COOKIES === "true" ||
    (process.env.NODE_ENV === "production" &&
      process.env.SECURE_COOKIES !== "false")
  );
}

export const authConfig = {
  sessionExpiryDays: readInteger("SESSION_EXPIRY_DAYS", 7, 1, 365),
  maxSessionsPerUser: readInteger("MAX_SESSIONS_PER_USER", 10, 1, 100),
  disableSignup: process.env.DISABLE_SIGNUP === "true",
  bcryptRounds: readInteger("BCRYPT_ROUNDS", 12, 10, 15),
  cookieName: "session",
  cookieOptions: {
    httpOnly: true,
    secure: shouldUseSecureCookies(),
    sameSite: "lax" as const,
    path: "/",
  },
};
