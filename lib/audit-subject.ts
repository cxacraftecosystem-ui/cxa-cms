import type { AuditAction } from "@prisma/client";
import { DELETED_ACTOR_LABEL } from "@/lib/audit-actor";
import { auditEmailHashCandidates, hashAuditEmail, type AuditIpEnv } from "@/lib/audit-ip";

/**
 * Reading and annotating the audit rows that are ABOUT an account — `entityType: "User"`, and every
 * sign-in event whatever its type.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * OWNER DECISION, 2026-10-10 (docs/AUDIT-PRIVACY.md, docs/security/2026-10-hardening.md finding 5).
 * These rows carry email addresses again, as they did before 2026-10: a sign-in or sign-out is
 * labelled with the account's address, a `User` change with `Name <address>`, and a refused sign-in
 * with the address that was TYPED, in `entityLabel` and in `after.email`.
 *
 * A refused sign-in's payload ALSO carries `emailHash` (a keyed fingerprint of the typed address — same
 * key and rotation as the IP fingerprint, lib/audit-ip.ts) and `emailDomain` (`attemptedAddress`).
 * They are additive: they let rows written between 2026-10-10's deploy and the reversal — which hold
 * only the fingerprint and the domain — still be grouped with, and recognised alongside, the rows
 * that hold the address.
 *
 * NOT IN SCOPE: a studio-access grant's label is the address on the allow-list, and a contact
 * enquiry's label is withheld by the provenance screens already.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Free of `server-only` and the database so the unit tests import it directly.
 */

/** The actions that are about getting in rather than about content. */
export const SIGN_IN_EVENT_ACTIONS: readonly AuditAction[] = ["LOGIN", "LOGIN_FAILED", "LOGOUT"];

const WHOLE_EMAIL = /^[^\s<>@]+@([^\s<>@]+\.[^\s<>@]+)$/;

/** The lower-cased domain of an address, or null when it is not one. */
export function emailDomain(email: string | null | undefined): string | null {
  const match = WHOLE_EMAIL.exec(email?.trim().toLowerCase() ?? "");
  const domain = match?.[1] ?? null;
  return domain && domain.length <= 253 ? domain : null;
}

/** The grouping fields a sign-in payload records beside the typed address itself. */
export interface AttemptedAddress {
  /** `<keyId>:<hex>` — see `hashAuditEmail`. Null when there was no address or no key. */
  emailHash: string | null;
  emailDomain: string | null;
}

export function attemptedAddress(email: string | null | undefined, env?: AuditIpEnv): AttemptedAddress {
  return { emailHash: hashAuditEmail(email, env), emailDomain: emailDomain(email) };
}

/** `••••@domain`, for the few rows that hold only a domain (written while addresses were not stored). */
export function maskedDomain(domain: string | null | undefined): string | null {
  return domain ? `••••@${domain}` : null;
}

/** True for the rows about an account (`entityType: "User"` and every sign-in event). */
export function describesAnAccount(input: { action: AuditAction; entityType: string }): boolean {
  return input.entityType === "User" || SIGN_IN_EVENT_ACTIONS.includes(input.action);
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

/** The typed address, fingerprint and domain a sign-in payload carries, whichever generation wrote it. */
export function attemptedFromPayload(after: unknown): AttemptedAddress & { email: string | null } {
  const payload = asRecord(after);
  const hash = typeof payload?.emailHash === "string" ? payload.emailHash : null;
  const domain = typeof payload?.emailDomain === "string" ? payload.emailDomain : null;
  const email = typeof payload?.email === "string" && payload.email.includes("@") ? payload.email.trim().toLowerCase() : null;
  return { emailHash: hash, emailDomain: domain ?? emailDomain(email), email };
}

/**
 * The name to print for what an audit row is about.
 *
 * For an account row: the label the row recorded when it holds an address (`asha@…`, `Asha <asha@…>`
 * — the account as it was at the time); otherwise the joined account (`Name <address>`); otherwise the
 * recorded label, the typed address of a refused sign-in, "Deleted user" when `entityId` names an
 * account that no longer exists, or — for a row written while addresses were not stored — the typed
 * address masked to its domain. Every other row prints its own label.
 */
export function accountLabel(row: AccountRowColumns, account: AccountRef | null | undefined): string | null {
  if (!describesAnAccount(row)) return row.entityLabel;
  const recorded = row.entityLabel?.trim() || null;
  if (recorded?.includes("@")) return recorded;
  if (account) {
    const name = account.name?.trim();
    return name ? `${name} <${account.email}>` : account.email;
  }
  const attempted = attemptedFromPayload(row.after);
  if (recorded) return recorded;
  if (attempted.email) return attempted.email;
  if (row.entityId) return DELETED_ACTOR_LABEL;
  return maskedDomain(attempted.emailDomain);
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

// ── Lock take-overs: who held the editor ────────────────────────────────────────────────────────

/**
 * A content-lock take-over (`takeOverLock`, lib/studio/crud.ts) records each holder twice: the address
 * at the time as `editingHeldBy`, and the account id as `editingHeldById`. Rows written while addresses
 * were not stored (2026-10-10, before the reversal) have only the id.
 */
export const LOCK_HOLDER_ID_FIELD = "editingHeldById";
/** The recorded address, and the field a screen shows the holder under. */
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
 * A payload with `editingHeldById` folded into `editingHeldBy`: the account's name while it exists
 * (its address when it has no name), the address recorded at the time once it is gone, and "Deleted
 * user" only when neither is known. A payload without the id is returned as it was.
 */
export function withLockHolderNames<T>(payload: T, holders: ReadonlyMap<string, AccountRef>): T {
  const record = asRecord(payload);
  if (!record || !(LOCK_HOLDER_ID_FIELD in record)) return payload;
  const { [LOCK_HOLDER_ID_FIELD]: id, [LOCK_HOLDER_FIELD]: recorded, ...rest } = record;
  const account = typeof id === "string" ? holders.get(id) : undefined;
  const name =
    (account ? account.name?.trim() || account.email : null) ??
    (typeof recorded === "string" && recorded.trim().length > 0 ? recorded : DELETED_ACTOR_LABEL);
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
