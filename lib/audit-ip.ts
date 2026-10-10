import { createHash, createHmac, hkdfSync } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { normaliseIp } from "@/lib/request-ip";

/**
 * The audit log's network fingerprint: a keyed hash of the client address, stored BESIDE the address.
 *
 * ⚠ OWNER DECISION, 2026-10-10 (docs/AUDIT-PRIVACY.md): the audit log stores and shows the real client
 * address again (`audit_logs.ipAddress`, written by lib/audit.ts from the trusted lib/request-ip.ts
 * derivation). The fingerprint below is still written on every row: it is the only network column on
 * the rows written between the 2026-10-10 deploy and that decision, and an exact-address search
 * (`auditIpSearchClauses`) matches those rows through it. The rationale that follows is why the
 * fingerprint is keyed — it no longer describes what the table holds.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IT IS FOR, AND WHAT IT DELIBERATELY CANNOT DO.
 *
 * The audit log is exported, read by every administrator, and kept indefinitely; an IP address in it
 * is personal data with no retention limit. What an investigator actually needs from it is
 * CORRELATION — "these forty refused sign-ins came from one place", "this colleague's session moved
 * to a network it has never used" — and equality of a keyed hash answers both. What the hash cannot
 * do, by design, is be turned back into an address by somebody holding the table or an export:
 *
 *   • **Keyed (HMAC-SHA256), not a plain hash.** The IPv4 space is 2³² values; an unkeyed SHA-256 of
 *     every one is a few minutes on a laptop, so a plain hash is the address with extra steps.
 *   • **Truncated to 128 bits.** Collisions stay astronomically unlikely for the few million
 *     addresses this log will ever see, and the stored value is shorter.
 *   • **Prefixed with a key id** (`<keyId>:<hex>`): eight hex characters of a hash OF the key. A
 *     rotation therefore shows up as a new prefix instead of as every address silently becoming
 *     "new", and lookups can try the previous keys (`AUDIT_IP_HASH_PREVIOUS_SECRETS`) so a search for
 *     an address still finds rows written before the rotation.
 *
 * THE KEY. `AUDIT_IP_HASH_SECRET`, at least 32 characters. Without one — or with a value too short to
 * be a key — it is DERIVED from `JWT_SECRET` with HKDF under a label of its own, so a deployment that
 * has not been given the new variable still writes a fingerprint beside the address. The derivation is one-way; knowing the fingerprint key reveals nothing about
 * the signing key. The cost is that rotating `JWT_SECRET` also rotates the fingerprints, which is why
 * a dedicated secret is the recommended setting and its absence is a diagnostics warning.
 *
 * ROTATION, INCLUDING OUT OF THE DERIVED KEY. Writing always uses the current key; SEARCHING tries the
 * current key and then every retired one, so an exact-address search still finds rows written before a
 * rotation. A retired key comes from two places:
 *
 *   • **Automatically**: while a dedicated secret is in use, the key derived from the CURRENT
 *     `JWT_SECRET` is always tried as well. The most likely first rotation — a deployment that ran on
 *     the derived key is given `AUDIT_IP_HASH_SECRET` — therefore needs no further setting at all.
 *   • **`AUDIT_IP_HASH_PREVIOUS_SECRETS`**, comma-separated. Each entry is either a retired dedicated
 *     secret (32+ characters, used as the key), or `jwt:<a retired JWT_SECRET>`, which re-derives the
 *     key that `JWT_SECRET` produced. The second form is what a `JWT_SECRET` rotation on a deployment
 *     still on the derived key needs: the old signing secret no longer verifies anything once it is
 *     retired, but it is the only way back to the fingerprints written under it.
 *
 * The same keys fingerprint the address TYPED at a refused sign-in (`hashAuditEmail`), domain-separated
 * from the IP fingerprint so equal strings in the two never collide.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const MIN_AUDIT_IP_SECRET_LENGTH = 32;

/** Hex characters of the HMAC that are kept: 32 = 128 bits. */
const HASH_HEX_LENGTH = 32;

const DERIVATION_LABEL = "cxa-cms/audit-ip-hash/v1";

/**
 * The variables read: `AUDIT_IP_HASH_SECRET`, `AUDIT_IP_HASH_PREVIOUS_SECRETS` and `JWT_SECRET`.
 * `process.env` by default; tests pass their own.
 */
export type AuditIpEnv = Readonly<Record<string, string | undefined>>;

interface IpKey {
  id: string;
  key: Buffer;
}

function usable(secret: string | undefined): string | null {
  const trimmed = secret?.trim() ?? "";
  return trimmed.length >= MIN_AUDIT_IP_SECRET_LENGTH ? trimmed : null;
}

function keyFrom(material: Buffer): IpKey {
  const id = createHash("sha256").update("cxa-audit-ip-key-id\0").update(material).digest("hex").slice(0, 8);
  return { id, key: material };
}

/** Where the current key came from — for the diagnostics panel, never the key itself. */
export function auditIpKeySource(env: AuditIpEnv = process.env): "dedicated" | "derived" | "none" {
  if (usable(env.AUDIT_IP_HASH_SECRET)) return "dedicated";
  if (env.JWT_SECRET?.trim()) return "derived";
  return "none";
}

/** The key a `JWT_SECRET` yields when no dedicated secret is set. */
function derivedKey(jwtSecret: string | undefined): IpKey | null {
  const jwt = jwtSecret?.trim();
  if (!jwt) return null;
  return keyFrom(Buffer.from(hkdfSync("sha256", jwt, Buffer.alloc(0), DERIVATION_LABEL, 32)));
}

function currentKey(env: AuditIpEnv): IpKey | null {
  const dedicated = usable(env.AUDIT_IP_HASH_SECRET);
  if (dedicated) return keyFrom(Buffer.from(dedicated, "utf8"));
  return derivedKey(env.JWT_SECRET);
}

/** Prefix of an `AUDIT_IP_HASH_PREVIOUS_SECRETS` entry that names a retired `JWT_SECRET`. */
const JWT_ENTRY_PREFIX = "jwt:";

/**
 * Every retired key, for searching only — see ROTATION above. Entries that are neither form are
 * skipped rather than thrown on: a typo here must cost a search hit, never every audit write.
 */
function previousKeys(env: AuditIpEnv): IpKey[] {
  const keys: IpKey[] = [];
  // While a dedicated secret is current, the derived key is the one the deployment ran on before it.
  if (usable(env.AUDIT_IP_HASH_SECRET)) {
    const fromCurrentJwt = derivedKey(env.JWT_SECRET);
    if (fromCurrentJwt) keys.push(fromCurrentJwt);
  }
  for (const raw of (env.AUDIT_IP_HASH_PREVIOUS_SECRETS ?? "").split(",")) {
    const entry = raw.trim();
    if (entry.startsWith(JWT_ENTRY_PREFIX)) {
      const key = derivedKey(entry.slice(JWT_ENTRY_PREFIX.length));
      if (key) keys.push(key);
      continue;
    }
    const dedicated = usable(entry);
    if (dedicated) keys.push(keyFrom(Buffer.from(dedicated, "utf8")));
  }
  return keys;
}

/** The current key, then every retired one, without duplicates (by key id). */
function searchKeys(env: AuditIpEnv): IpKey[] {
  const seen = new Set<string>();
  return [currentKey(env), ...previousKeys(env)].filter((key): key is IpKey => {
    if (key === null || seen.has(key.id)) return false;
    seen.add(key.id);
    return true;
  });
}

function fingerprint(key: IpKey, input: string): string {
  const digest = createHmac("sha256", key.key).update(input).digest("hex").slice(0, HASH_HEX_LENGTH);
  return `${key.id}:${digest}`;
}

/**
 * The value written to `audit_logs.ipHash`, or null when there is no (valid) address or no key.
 * Never throws: an audit write must not fail because of the fingerprint.
 */
export function hashAuditIp(ip: string | null | undefined, env: AuditIpEnv = process.env): string | null {
  const address = normaliseIp(ip);
  if (!address) return null;
  const key = currentKey(env);
  return key ? fingerprint(key, address) : null;
}

/**
 * Every fingerprint the address may have been stored under — the current key first, then each
 * previous one — for an exact-match search across a rotation.
 */
export function auditIpHashCandidates(ip: string, env: AuditIpEnv = process.env): string[] {
  const address = normaliseIp(ip);
  if (!address) return [];
  return searchKeys(env).map((key) => fingerprint(key, address));
}

// ── The address typed at a refused sign-in ────────────────────────────────────────────────────────

/**
 * Domain separation: the IP fingerprint hashes the bare address, this hashes a tagged string, so an
 * email fingerprint can never equal an IP fingerprint under the same key.
 */
const EMAIL_TAG = "cxa-audit-email\0";

function normaliseEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim().toLowerCase() ?? "";
  return trimmed.length > 0 && trimmed.length <= 320 ? trimmed : null;
}

/**
 * A keyed fingerprint of an email address, for the one place the audit log needs to correlate an
 * address it must not store: the address somebody TYPED at a refused sign-in, which may belong to
 * nobody (lib/audit-subject.ts). Same key, format and rotation as `hashAuditIp`.
 */
export function hashAuditEmail(email: string | null | undefined, env: AuditIpEnv = process.env): string | null {
  const normalised = normaliseEmail(email);
  if (!normalised) return null;
  const key = currentKey(env);
  return key ? fingerprint(key, EMAIL_TAG + normalised) : null;
}

/** Every fingerprint `email` may have been stored under — current key first. */
export function auditEmailHashCandidates(email: string, env: AuditIpEnv = process.env): string[] {
  const normalised = normaliseEmail(email);
  if (!normalised) return [];
  return searchKeys(env).map((key) => fingerprint(key, EMAIL_TAG + normalised));
}

/**
 * How a fingerprint is shown: `net·` and the first twelve hex characters. Enough to tell sources
 * apart on a screen and to paste into the search box (which matches by prefix); the key id is left
 * off because it is the same on every row between rotations and only adds noise.
 */
export function displayIpFingerprint(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const hex = stored.includes(":") ? stored.slice(stored.indexOf(":") + 1) : stored;
  return `net·${hex.slice(0, 12)}`;
}

/** The hex a pasted `net·…` label (or bare hex) searches for, or null when it is neither. */
export function fingerprintSearchHex(input: string): string | null {
  const trimmed = input.trim().toLowerCase().replace(/^net[·.:-]?/, "");
  return /^[0-9a-f]{4,32}$/.test(trimmed) ? trimmed : null;
}

/**
 * The search clauses for "rows from this IP address": the stored address, exactly (in its canonical
 * spelling, and as typed), and — for the rows that carry only a fingerprint — every fingerprint it may
 * have been stored under. Empty when `q` is not a whole IP address: part of an address is not searched
 * as one (it would still match `entityLabel` / `entityId` through the ordinary text search).
 */
export function auditIpSearchClauses(q: string, env: AuditIpEnv = process.env): Prisma.AuditLogWhereInput[] {
  const typed = q.trim();
  const address = normaliseIp(typed);
  if (!address) return [];
  const clauses: Prisma.AuditLogWhereInput[] = [{ ipAddress: address }];
  if (typed !== address) clauses.push({ ipAddress: typed });
  const candidates = auditIpHashCandidates(address, env);
  if (candidates.length > 0) clauses.push({ ipHash: { in: candidates } });
  return clauses;
}
