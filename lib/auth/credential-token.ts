import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { authEnv, siteUrl } from "@/lib/env";

/**
 * The credential link — the one-off, single-use address that lets somebody set their own password.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS, AND WHAT MUST HAPPEN NEXT.
 *
 * The construction below already existed TWICE, copied verbatim into
 * `app/api/studio/users/route.ts` (which mints invitations) and `app/api/studio/users/[id]/route.ts`
 * (which mints password links). Both copies carry a note saying they must stay byte-for-byte
 * identical, and both say the code belongs in `lib/auth/`. It could not live in either file because
 * Next type-checks a `route.ts` against a fixed set of allowed exports, so a helper cannot be shared
 * out of one.
 *
 * Nothing could VERIFY a token, though, which is why no invited colleague could ever claim an
 * account: the link pointed at a screen that did not exist. A verifier is needed by two files at
 * once — the screen (`app/studio/set-password/page.tsx`) and the endpoint behind it
 * (`app/api/auth/set-password/route.ts`) — and a third and fourth copy of a signature check that
 * must agree exactly with the minting side is how everybody ends up locked out. So this is the
 * canonical implementation.
 *
 * ⚠ THE TWO ROUTE-LOCAL COPIES ARE NOW REDUNDANT AND SHOULD BE DELETED. Replace the private
 * `credentialFingerprint` / `mintCredentialToken` / `issueCredentialLink` / `issueResetLink` in
 * those two files with imports from here. They are left in place only because they were not in this
 * change's remit; until they go, THREE files carry the same construction and a change to any one of
 * them must be made in all three.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY NOT A JWT. `signAccessToken()` (lib/auth/tokens.ts) mints an ACCESS token, and anything shaped
 * like one risks being accepted as one by a call site that checks only the signature. A different
 * construction cannot be mistaken for a session.
 *
 * WHY THERE IS NO TABLE. A single-use token normally needs a row to mark as spent, a job to expire
 * the rows, and a window between "used" and "cleaned up" in which a replay still works. This one is
 * bound to the account's CURRENT credential state instead — see `credentialFingerprint`. Setting a
 * password changes the state, so every token minted before it stops verifying, immediately and
 * without anything having to remember.
 */

/** What a link is for. The two differ only in how long they last and in what the screen says. */
export type CredentialPurpose = "invite" | "reset";

/**
 * How long each kind of link lasts.
 *
 * An invitation is generous: it may be passed on by hand, read on a Monday and acted on after a
 * conference. A password link is short, because it is issued in response to somebody saying "I am
 * locked out now" and a link that outlives that conversation is a spare key left under the mat.
 */
export const INVITE_TTL_HOURS = 72;
export const RESET_TTL_HOURS = 2;

export function credentialTtlHours(purpose: CredentialPurpose): number {
  return purpose === "invite" ? INVITE_TTL_HOURS : RESET_TTL_HOURS;
}

/** The screen a link points at. Changing this changes every link already in somebody's inbox. */
export const SET_PASSWORD_PATH = "/studio/set-password";

/**
 * A cap on how much text will be treated as a token at all.
 *
 * A real token is a little over a hundred characters. The limit exists so a megabyte pasted into the
 * address bar is refused before any HMAC is computed over it.
 */
const MAX_TOKEN_LENGTH = 1024;

export interface CredentialTokenPayload {
  /** Bumped if the shape ever changes, so an old token is refused rather than misread. */
  v: 1;
  /** The user id the link is for. */
  sub: string;
  purpose: CredentialPurpose;
  /** Seconds since the epoch. */
  exp: number;
  /**
   * A short digest of the account's credential state when the link was minted — see
   * `credentialFingerprint`. This is what makes the token single-use with no table behind it.
   */
  cred: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * A short digest of "what the password is now".
 *
 * ⚠ THE HASH IS NEVER PUT IN THE TOKEN — only 16 hex characters of a SHA-256 of it, which is not
 * enough to attack and is enough to notice a change. A row with no password digests a fixed
 * sentinel, so an invitation is bound to "still has no password".
 *
 * The consequence, and it is the point: as soon as a password is set — by this link, by another
 * link, or by the person from their own account screen — every token minted before it stops
 * verifying.
 */
export function credentialFingerprint(passwordHash: string | null): string {
  return createHash("sha256").update(passwordHash ?? "no-password").digest("hex").slice(0, 16);
}

/**
 * Does the token's `cred` claim still describe this account?
 *
 * Compared in constant time. Not because a timing attack is reachable here — a caller only gets this
 * far by presenting a VALID signature, which needs the signing key — but because a credential
 * comparison written the short way is the one that gets copied somewhere it does matter.
 */
export function credentialFingerprintMatches(passwordHash: string | null, cred: string): boolean {
  const expected = Buffer.from(credentialFingerprint(passwordHash), "utf8");
  const presented = Buffer.from(cred, "utf8");
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(expected, presented);
}

/**
 * Mint a token: `base64url(payload).base64url(HMAC-SHA256(payload))`.
 *
 * Signed with `JWT_SECRET` through `authEnv()`, which refuses to start on a weak or placeholder key,
 * so this cannot quietly become a token anybody can forge.
 */
export function mintCredentialToken(payload: CredentialTokenPayload): string {
  const body = base64url(JSON.stringify(payload));
  const signature = base64url(createHmac("sha256", authEnv().secret).update(body).digest());
  return `${body}.${signature}`;
}

/** The address a person opens. `encodeURIComponent` because a base64url token is URL-safe but the query is not. */
export function credentialLink(token: string): string {
  return `${siteUrl()}${SET_PASSWORD_PATH}?token=${encodeURIComponent(token)}`;
}

export interface IssuedCredentialLink {
  token: string;
  link: string;
  expiresAt: Date;
}

/**
 * Mint a link for a user id, given the hash the account holds RIGHT NOW.
 *
 * The caller must read `passwordHash` immediately before calling: binding the token to a stale hash
 * would mint a link that was already spent, and binding it to none would mint one that stays valid
 * after a password is set.
 */
export function issueCredentialLink(input: {
  userId: string;
  passwordHash: string | null;
  purpose: CredentialPurpose;
}): IssuedCredentialLink {
  const expiresAt = new Date(Date.now() + credentialTtlHours(input.purpose) * 60 * 60 * 1000);
  const token = mintCredentialToken({
    v: 1,
    sub: input.userId,
    purpose: input.purpose,
    exp: Math.floor(expiresAt.getTime() / 1000),
    cred: credentialFingerprint(input.passwordHash)
  });
  return { token, link: credentialLink(token), expiresAt };
}

/**
 * Why a token was refused.
 *
 * `malformed` deliberately covers a forged signature as well as a mangled one. The two are
 * indistinguishable to a reader — both mean "this is not a link this site issued" — and separating
 * them in an answer would tell somebody probing the endpoint which half of their guess was wrong.
 */
export type CredentialTokenRefusal = "missing" | "malformed" | "expired";

export type CredentialTokenVerdict =
  | { ok: true; payload: CredentialTokenPayload }
  | { ok: false; reason: CredentialTokenRefusal };

/** Constant-time equality for two base64url signatures. Unequal lengths cannot be compared, so they fail. */
function signaturesMatch(presented: string, expected: string): boolean {
  const left = Buffer.from(presented, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * Validate the decoded payload's SHAPE before anything trusts a field on it.
 *
 * The signature proves the bytes came from this installation; it does not prove they parse into what
 * this version of the code expects. A token minted by an older build with a different `v` is refused
 * here rather than read with the wrong meaning.
 */
function readPayload(value: unknown): CredentialTokenPayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  if (raw.v !== 1) return null;
  if (typeof raw.sub !== "string" || raw.sub.length === 0 || raw.sub.length > 64) return null;
  if (raw.purpose !== "invite" && raw.purpose !== "reset") return null;
  if (typeof raw.exp !== "number" || !Number.isFinite(raw.exp)) return null;
  if (typeof raw.cred !== "string" || !/^[0-9a-f]{16}$/.test(raw.cred)) return null;

  return { v: 1, sub: raw.sub, purpose: raw.purpose, exp: raw.exp, cred: raw.cred };
}

/**
 * Verify a token's signature, shape and expiry.
 *
 * ⚠ IT DOES NOT CHECK THE FINGERPRINT, because that needs the account's current hash and this module
 * does not read the database. The caller MUST follow a successful verdict with
 * `credentialFingerprintMatches(user.passwordHash, payload.cred)` — that check is the entire
 * single-use guarantee, and a caller that skips it has built a link that works for ever.
 *
 * THE ORDER IS DELIBERATE: signature first, then shape, then expiry. Everything after the signature
 * is only reachable by somebody who already holds a link this installation issued, so the more
 * specific answers below cannot be used to learn anything — and the expiry, which is inside the
 * signed payload, can be reported honestly to a reader holding a link that has simply gone stale.
 */
export function verifyCredentialToken(
  raw: string | null | undefined,
  now: Date = new Date()
): CredentialTokenVerdict {
  if (typeof raw !== "string") return { ok: false, reason: "missing" };
  const token = raw.trim();
  if (token.length === 0) return { ok: false, reason: "missing" };
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };

  // EXACTLY ONE separator. A token with two would let the body be chosen after the signature was
  // computed over a prefix of it.
  const separator = token.indexOf(".");
  if (separator <= 0 || token.indexOf(".", separator + 1) !== -1) {
    return { ok: false, reason: "malformed" };
  }

  const body = token.slice(0, separator);
  const presented = token.slice(separator + 1);
  const expected = base64url(createHmac("sha256", authEnv().secret).update(body).digest());
  if (!signaturesMatch(presented, expected)) return { ok: false, reason: "malformed" };

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const payload = readPayload(decoded);
  if (!payload) return { ok: false, reason: "malformed" };

  if (payload.exp * 1000 <= now.getTime()) return { ok: false, reason: "expired" };

  return { ok: true, payload };
}
