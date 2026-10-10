import type { AuditAction } from "@prisma/client";
import { DELETED_ACTOR_LABEL } from "@/lib/audit-actor";
import { auditEmailHashCandidates, hashAuditEmail, type AuditIpEnv } from "@/lib/audit-ip";

/**
 * Keeping email addresses out of the audit rows that are ABOUT an account.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS. Removing `actorEmail` from the row was not enough on its own. Every sign-in wrote
 * the same address again as `entityLabel` ("LOGIN, User, asha@…"), every sign-out did the same, and
 * every refused sign-in put the typed address in `entityLabel` AND in `after.email`. Those are the
 * most numerous rows in the log, so the address of an account that was later hard-deleted survived
 * in all of them, under a different column name, and the "Deleted user" label hid nothing.
 *
 * So for the rows that describe an ACCOUNT — `entityType: "User"`, and every sign-in event whatever
 * its type — `lib/audit.ts` passes the label and payloads through `scrubAccountIdentity` before the
 * insert, and nothing in them is an address:
 *
 *   • **The label** loses any address: `Asha Rao <asha@…>` becomes `Asha Rao`, a bare address becomes
 *     null. A screen names the account by joining `entityId` to `users` (`accountLabel`), so a row
 *     for a hard-deleted account reads "Deleted user", exactly like its actor column.
 *   • **`email` in a sign-in payload** becomes `emailHash` (a keyed fingerprint, same key and rotation
 *     as the IP fingerprint — lib/audit-ip.ts) and `emailDomain`. That is what a refused sign-in needs:
 *     forty refusals for one typed address still group, an address that belongs to a studio account or
 *     a grant is still recognised (`recogniseAttemptedAddresses`), and an address that belongs to
 *     nobody is shown, as it always was, masked to its domain.
 *   • **Any other string in a User payload that IS an address** (a snapshot's `email`, an OAuth
 *     `linkedAddress`) becomes `••••@domain #<12 hex>`: still different when the address changed, so
 *     the "what changed" diff still says so, and still comparable between rows, but not an address.
 *
 * The routes in app/api/auth/** no longer pass an address at all (they use `attemptedAddress`); this
 * scrub is the backstop that keeps the rule true for the next route somebody writes.
 *
 * NOT IN SCOPE, deliberately (docs/AUDIT-PRIVACY.md §5): a studio-access grant's label is the address
 * on the allow-list — the grant itself, not metadata about whoever acted — and a contact enquiry's label
 * is withheld by the provenance screens already.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Free of `server-only` and the database so the unit tests import it directly.
 */

/** The actions that are about getting in rather than about content. */
export const SIGN_IN_EVENT_ACTIONS: readonly AuditAction[] = ["LOGIN", "LOGIN_FAILED", "LOGOUT"];

const WHOLE_EMAIL = /^[^\s<>@]+@([^\s<>@]+\.[^\s<>@]+)$/;
const EMBEDDED_EMAIL = /\s*<?[^\s<>@]+@[^\s<>@]+>?/g;

/** The lower-cased domain of an address, or null when it is not one. Only the domain is ever kept. */
export function emailDomain(email: string | null | undefined): string | null {
  const match = WHOLE_EMAIL.exec(email?.trim().toLowerCase() ?? "");
  const domain = match?.[1] ?? null;
  return domain && domain.length <= 253 ? domain : null;
}

/** What a sign-in payload records about a typed address, in place of the address. */
export interface AttemptedAddress {
  /** `<keyId>:<hex>` — see `hashAuditEmail`. Null when there was no address or no key. */
  emailHash: string | null;
  emailDomain: string | null;
}

export function attemptedAddress(email: string | null | undefined, env?: AuditIpEnv): AttemptedAddress {
  return { emailHash: hashAuditEmail(email, env), emailDomain: emailDomain(email) };
}

/** `••••@domain`, the form an unrecognised address has always been shown in. */
export function maskedDomain(domain: string | null | undefined): string | null {
  return domain ? `••••@${domain}` : null;
}

/** An address anywhere else in a User payload: masked, with a short fingerprint so changes still show. */
function addressToken(email: string, env?: AuditIpEnv): string {
  const hash = hashAuditEmail(email, env);
  const masked = maskedDomain(emailDomain(email)) ?? "••••";
  return hash ? `${masked} #${hash.slice(hash.indexOf(":") + 1, hash.indexOf(":") + 13)}` : masked;
}

function scrubLabel(label: string | null | undefined): string | null {
  if (label === null || label === undefined) return null;
  const stripped = label.replace(EMBEDDED_EMAIL, "").trim();
  return stripped.length > 0 ? stripped : null;
}

function scrubPayload(value: unknown, signIn: boolean, env: AuditIpEnv | undefined, depth = 0): unknown {
  if (depth > 8 || value === null || value === undefined) return value;
  if (typeof value === "string") return WHOLE_EMAIL.test(value.trim()) ? addressToken(value, env) : value;
  if (Array.isArray(value)) return value.map((entry) => scrubPayload(entry, signIn, env, depth + 1));
  if (value instanceof Date || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    // The one field a refused sign-in is correlated on: kept as a fingerprint and a domain, by name.
    if (signIn && depth === 0 && key === "email" && typeof entry === "string") {
      Object.assign(out, attemptedAddress(entry, env));
      continue;
    }
    out[key] = scrubPayload(entry, signIn, env, depth + 1);
  }
  return out;
}

export interface AccountIdentityInput {
  action: AuditAction;
  entityType: string;
  entityLabel?: string | null;
  before?: unknown;
  after?: unknown;
}

/** True for the rows `scrubAccountIdentity` rewrites. */
export function describesAnAccount(input: { action: AuditAction; entityType: string }): boolean {
  return input.entityType === "User" || SIGN_IN_EVENT_ACTIONS.includes(input.action);
}

/**
 * The label and payloads of an audit entry with every email address removed — for account rows only;
 * any other row is returned untouched. See the header.
 */
export function scrubAccountIdentity<T extends AccountIdentityInput>(input: T, env?: AuditIpEnv): T {
  if (!describesAnAccount(input)) return input;
  const signIn = SIGN_IN_EVENT_ACTIONS.includes(input.action);
  return {
    ...input,
    entityLabel: scrubLabel(input.entityLabel),
    before: scrubPayload(input.before, signIn, env),
    after: scrubPayload(input.after, signIn, env)
  };
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────

/** The account a row is about, joined by `entityId` at read time. */
export interface AccountRef {
  name?: string | null;
  email: string;
}

export interface AccountRowColumns {
  action: AuditAction;
  entityType: string;
  entityId: string | null;
  entityLabel: string | null;
  after?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The fingerprint and domain a sign-in payload carries, whichever generation wrote it. */
export function attemptedFromPayload(after: unknown): AttemptedAddress & { legacyEmail: string | null } {
  const payload = asRecord(after);
  const hash = typeof payload?.emailHash === "string" ? payload.emailHash : null;
  const domain = typeof payload?.emailDomain === "string" ? payload.emailDomain : null;
  // Rows written before the change carried the address itself (docs/AUDIT-PRIVACY.md §4).
  const legacy = typeof payload?.email === "string" && payload.email.includes("@") ? payload.email.trim().toLowerCase() : null;
  return { emailHash: hash, emailDomain: domain ?? emailDomain(legacy), legacyEmail: legacy };
}

/**
 * The name to print for what an audit row is about.
 *
 * For an account row: the joined account (`Name <address>`, its CURRENT address); "Deleted user" when
 * `entityId` names an account that no longer exists; for a refused sign-in for an address that belongs
 * to nobody, the typed address masked to its domain. A legacy label (written before the change) is
 * used only when nothing else can be said. Every other row prints its own label.
 */
export function accountLabel(row: AccountRowColumns, account: AccountRef | null | undefined): string | null {
  if (!describesAnAccount(row)) return row.entityLabel;
  if (account) {
    const name = account.name?.trim();
    return name ? `${name} <${account.email}>` : account.email;
  }
  const legacyLabel = row.entityLabel?.trim() || null;
  if (row.entityId) return legacyLabel ?? DELETED_ACTOR_LABEL;
  return maskedDomain(attemptedFromPayload(row.after).emailDomain) ?? legacyLabel;
}

/**
 * Which refused-sign-in fingerprints belong to an address this installation knows (a studio account or
 * a row on the access list), as `fingerprint → address`. The known addresses are hashed under every
 * search key, so recognition survives a key rotation. A fingerprint that is not in the map stays masked.
 */
export function recogniseAttemptedAddresses(
  knownAddresses: Iterable<string>,
  env?: AuditIpEnv
): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of knownAddresses) {
    const address = raw.trim().toLowerCase();
    for (const candidate of auditEmailHashCandidates(address, env)) map.set(candidate, address);
  }
  return map;
}

// ── Lock take-overs: who held the editor, by id ─────────────────────────────────────────────────

/**
 * The payload field a content-lock take-over (`takeOverLock`, lib/studio/crud.ts) records each holder
 * under: the ACCOUNT ID. That row is filed against a page or a post, so `scrubAccountIdentity` never
 * sees it, and it used to carry both holders' addresses as `editingHeldBy`. Now the id is stored and
 * the name is joined at read time, like the actor column.
 */
export const LOCK_HOLDER_ID_FIELD = "editingHeldById";
/** What a screen shows in its place, and what rows written before the change stored (an address). */
export const LOCK_HOLDER_FIELD = "editingHeldBy";

/** Every account id named as a lock holder in the `before` / `after` of `rows`. */
export function lockHolderIds(rows: readonly { before?: unknown; after?: unknown }[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    for (const payload of [row.before, row.after]) {
      const id = asRecord(payload)?.[LOCK_HOLDER_ID_FIELD];
      if (typeof id === "string" && id.length > 0) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * A payload with `editingHeldById` replaced by `editingHeldBy: <the account's name>` — the account as
 * it is now, its address when it has no name, "Deleted user" once it is gone. Any other payload is
 * returned as it was.
 */
export function withLockHolderNames<T>(payload: T, holders: ReadonlyMap<string, AccountRef>): T {
  const record = asRecord(payload);
  if (!record || !(LOCK_HOLDER_ID_FIELD in record)) return payload;
  const { [LOCK_HOLDER_ID_FIELD]: id, ...rest } = record;
  const account = typeof id === "string" ? holders.get(id) : undefined;
  const name = account ? account.name?.trim() || account.email : DELETED_ACTOR_LABEL;
  return { [LOCK_HOLDER_FIELD]: name, ...rest } as T;
}

/**
 * The names a screen shows for a list of changed payload fields: `editingHeldById` reads as
 * `editingHeldBy`, the field `withLockHolderNames` puts in its place, so a page of headlines names the
 * same field as the entry opened on its own. Order is kept and a name that would appear twice once.
 * (`changedFields` still compares the stored ids — only the name it reports changes.)
 */
export function displayFieldNames(fields: readonly string[]): string[] {
  return [...new Set(fields.map((field) => (field === LOCK_HOLDER_ID_FIELD ? LOCK_HOLDER_FIELD : field)))];
}
