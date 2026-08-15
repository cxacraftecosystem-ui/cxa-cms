/**
 * JWT configuration.
 *
 * DELIBERATELY NOT `server-only`. Everything else that reads secrets lives in `lib/env.ts`, which
 * is `server-only` so a stray client import becomes a build error. This module is the one exception
 * because **Next.js middleware must verify tokens** and middleware is compiled for the edge runtime,
 * where the `server-only` guard is at best ambiguous. It is imported by middleware and by server
 * modules and by nothing else; `lib/env.ts` re-exports `authEnv` so there is still exactly one
 * implementation of "what are the token settings".
 */

const PLACEHOLDER_SECRETS = new Set([
  "changeme",
  "change-me",
  "secret",
  "jwt-secret",
  "your-secret-here",
  "please-change-me",
  "development",
  "insecure"
]);

export const MIN_JWT_SECRET_LENGTH = 32;

const ALLOWED_JWT_ALGORITHMS = new Set(["HS256", "HS384", "HS512"]);

export type JwtAlgorithm = "HS256" | "HS384" | "HS512";

export interface AuthEnv {
  secret: string;
  algorithm: JwtAlgorithm;
  accessTtlMinutes: number;
  refreshTtlDays: number;
  cookieDomain: string | undefined;
}

/** A sentence describing why a secret is unusable, or null when it is fine. */
export function jwtSecretWeakness(secret: string): string | null {
  const trimmed = secret.trim();
  if (trimmed.length < MIN_JWT_SECRET_LENGTH) {
    return `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters; it is ${trimmed.length}.`;
  }
  if (PLACEHOLDER_SECRETS.has(trimmed.toLowerCase())) {
    return "JWT_SECRET is a placeholder value shipped in the example file.";
  }
  // A key made of one repeated character passes a length test and has almost no entropy.
  if (new Set(trimmed).size < 8) {
    return "JWT_SECRET has too little variety to be a real key (fewer than 8 distinct characters).";
  }
  return null;
}

function readTrimmed(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = readTrimmed(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  // A malformed number is a configuration MISTAKE, not a request for the default. Silently
  // substituting one is how a 30-minute token lifetime quietly becomes 30 days.
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}".`);
  }
  return parsed;
}

let cached: AuthEnv | null = null;

export function authEnv(): AuthEnv {
  if (cached) return cached;

  const secret = readTrimmed("JWT_SECRET");
  if (!secret) {
    throw new Error(
      "Missing required environment variable JWT_SECRET. Generate one with `openssl rand -base64 48`."
    );
  }
  const weakness = jwtSecretWeakness(secret);
  if (weakness) {
    // Refusing to start is the point. A signing key an attacker can guess is indistinguishable from
    // having no authentication at all, and the CMS is the only thing between a visitor and the
    // institution's public voice.
    throw new Error(`Refusing to start: ${weakness} Generate one with \`openssl rand -base64 48\`.`);
  }

  const algorithm = readTrimmed("JWT_ALGORITHM") ?? "HS256";
  if (!ALLOWED_JWT_ALGORITHMS.has(algorithm)) {
    // Only symmetric HMAC is ever legitimate here. Accepting an asymmetric name whose "public key"
    // is this shared secret is the classic algorithm-confusion forgery.
    throw new Error(
      `JWT_ALGORITHM must be one of ${[...ALLOWED_JWT_ALGORITHMS].join(", ")}; got "${algorithm}".`
    );
  }

  cached = {
    secret,
    algorithm: algorithm as JwtAlgorithm,
    accessTtlMinutes: readPositiveInt("ACCESS_TOKEN_TTL_MINUTES", 30),
    refreshTtlDays: readPositiveInt("REFRESH_TOKEN_TTL_DAYS", 30),
    cookieDomain: readTrimmed("AUTH_COOKIE_DOMAIN")
  };
  return cached;
}
