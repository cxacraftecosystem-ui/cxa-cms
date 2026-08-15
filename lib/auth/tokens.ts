import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import type { Role } from "@prisma/client";
import { authEnv } from "./config";

/**
 * Access-token minting and verification.
 *
 * Edge-safe on purpose: `jose` uses WebCrypto, so the same code verifies a token in middleware, in a
 * route handler and in a server component. No `server-only` import — see lib/auth/config.ts for why.
 *
 * The access token is a BEARER OF CLAIMS, not a session. It is short-lived (30 minutes by default)
 * and carries the role so middleware can make a routing decision without a database round trip. The
 * authoritative role is still re-read from the database by `requireUser()` for anything that
 * actually writes — a token minted before a demotion is valid until it expires, and a demotion must
 * take effect immediately for a write.
 */

const ISSUER = "cxa-portal";
const AUDIENCE = "cxa-studio";

export interface AccessClaims extends JWTPayload {
  sub: string;
  role: Role;
  email: string;
  name: string;
  /** Session family, so a token can be tied back to the refresh chain that produced it. */
  sid: string;
  typ: "access";
}

let cachedKey: Uint8Array | null = null;

function secretKey(): Uint8Array {
  if (cachedKey) return cachedKey;
  cachedKey = new TextEncoder().encode(authEnv().secret);
  return cachedKey;
}

export async function signAccessToken(input: {
  userId: string;
  role: Role;
  email: string;
  name: string;
  sessionId: string;
}): Promise<string> {
  const { algorithm, accessTtlMinutes } = authEnv();
  return new SignJWT({
    role: input.role,
    email: input.email,
    name: input.name,
    sid: input.sessionId,
    typ: "access"
  })
    .setProtectedHeader({ alg: algorithm })
    .setSubject(input.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${accessTtlMinutes}m`)
    .sign(secretKey());
}

/**
 * Verify and decode. Returns null for ANY failure — expired, wrong signature, wrong issuer, wrong
 * type — rather than throwing, because every call site's response to a bad token is identical and a
 * try/catch per call site is how one of them ends up swallowing a different error too.
 *
 * `algorithms` is pinned to the single configured algorithm. Leaving it open is what makes
 * algorithm-confusion attacks possible in the first place.
 */
export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  if (!token) return null;
  try {
    const { algorithm } = authEnv();
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: [algorithm]
    });
    if (payload.typ !== "access") return null;
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    if (typeof payload.role !== "string") return null;
    return payload as AccessClaims;
  } catch {
    return null;
  }
}
