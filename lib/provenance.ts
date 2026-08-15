import "server-only";
// `Prisma` is imported as a VALUE, not merely as a type: `Prisma.sql` is the tagged template
// `$queryRaw` needs for the two day-bucket queries below, and `Prisma.JsonValue` is a type from the
// same namespace. Same pattern as app/api/public/events/[slug]/register/route.ts.
import { Prisma, type AuditAction, type AuthProvider, type Role } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * The provenance queries — "where did this come from, and who touched it?"
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT THE AUDIT SCREEN, WHICH ALREADY EXISTS.
 *
 * `/studio/audit` answers ONE question: "what happened to this page?" It is a log — ordered by time,
 * filtered by whatever an administrator types — and an administrator may read it.
 *
 * This module answers three different questions, and the third is why the whole surface is master-admin
 * only (`canViewProvenance` in lib/permissions.ts):
 *
 *   1. FOR ONE RECORD — its full lineage. Who created it and when, every edit with the NAMES of the
 *      fields that changed, every publish and unpublish, its revisions and their authors, who holds the
 *      editing lock right now, and whether it has ever been pulled back out of the recycle bin.
 *   2. FOR ONE PERSON — everything they have done, across every kind of record, with the network
 *      addresses they did it from and their sign-in history, refused attempts included.
 *   3. FOR THE INSTALLATION — who signed in, which grants on the access list have never been used,
 *      which accounts have no second factor, and anything that looks like an attempt to get in.
 *
 * Question 2 is the reason this is not an administrator's screen. A log of content changes is a record
 * of the website. A cross-entity history of one named colleague, with the addresses they worked from, is
 * a record of a PERSON — and the tier that may read it is the tier that already decides who may sign in
 * at all, so that the account used every day cannot also be the account that reads it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * TWO PRIVACY RULES ARE ENFORCED HERE RATHER THAN LEFT TO THE SCREEN, because a rule that lives in a
 * component is a rule the next screen forgets:
 *
 *   • **A network address is returned only where the question needs one.** `recordProvenance` — "where
 *     did this page come from?" — deliberately does not carry them: the answer is about the content, and
 *     an address printed beside a colleague's name where nobody asked for it is surveillance by default.
 *     `actorProvenance` and `installationProvenance` DO carry them, because "which addresses has this
 *     person worked from" and "who is trying the door" cannot be answered without them.
 *
 *   • **No email address belonging to somebody who is not a studio user is ever returned.** The audit
 *     log's `entityLabel` for a contact enquiry is literally `"Name <address>"` (see
 *     app/api/public/contact/route.ts), so a record lookup on an enquiry would print a member of the
 *     public's correspondence details onto a security screen. `safeEntityLabel` withholds those, and a
 *     refused sign-in from an address nobody recognises is reported with its local part masked — the
 *     domain is the part that answers "is somebody probing this institution", and the local part is the
 *     part that names a person.
 *
 * EVERY LIST IS CAPPED AND EVERY CAP IS REPORTED (contract §1.6). `CappedList.truncated` is never
 * derived by a caller: a list that quietly stops is indistinguishable from a place with only that many
 * records, and on a screen whose whole purpose is completeness that is the worst possible failure.
 *
 * NOTHING HERE WRITES. There is no mutation in this module and no route that calls it writes either —
 * see app/api/studio/provenance/route.ts.
 */

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Caps
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const PROVENANCE_CAPS = {
  /**
   * Events in one record's timeline.
   *
   * Lower than the audit screen's page size looks sensible for, and deliberately: each row carries the
   * full `before` and `after` snapshots of the entity, because the field NAMES that changed can only be
   * worked out by comparing them. Eighty rows of two page snapshots is already megabytes for a list that
   * renders one sentence per row.
   */
  timeline: 80,
  /** Field names named per timeline event. */
  fieldsPerEvent: 12,
  /** Revisions listed for one record. */
  revisions: 60,
  /** Kinds of record one person's work is grouped into. */
  entityTypes: 30,
  /** Sign-in events listed for one person. */
  signIns: 80,
  /** Distinct network addresses listed for one person. */
  addresses: 30,
  /** Refused sign-in attempts listed for the installation. */
  refusals: 80,
  /** Addresses grouped in the refusal summary. */
  refusalSources: 20,
  /** Grants on the access list that have never been used. */
  unusedGrants: 60,
  /** Active accounts with no second factor. */
  withoutTwoFactor: 60,
  /** People in the "most active" and "signed in" lists. */
  people: 25,
  /** Fields reported by one revision comparison. */
  diffFields: 80,
  /** Rows a search offers. */
  searchResults: 25,
  /** Audit entries a record search reads before de-duplicating them. See `searchRecords`. */
  searchScan: 240
} as const;

/** The longest window one question may cover. A year of daily buckets is 366 numbers, which is plenty. */
export const MAX_RANGE_DAYS = 366;

/** The default window: "who signed in this week". */
export const DEFAULT_RANGE_DAYS = 7;

/** How much of one value a comparison shows before it says how much more there is. */
export const VALUE_PREVIEW_LIMIT = 400;

/**
 * The sentence the screen and the API answer both carry.
 *
 * Written once, here, because it is a promise about the whole surface rather than a caption on one
 * panel: the people whose actions are listed are entitled to know the record exists.
 */
export const PROVENANCE_NOTICE =
  "This screen is a record of your colleagues' work, not only of the website's content. It shows who " +
  "did what and when, and — only where the question needs it — the network address they worked from. " +
  "Everybody named here is entitled to know that this record is kept and that a master administrator " +
  "can read it. Nothing on this screen can be changed or removed.";

const DAY_MS = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Shared shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One list, with everything a screen needs to describe it honestly.
 *
 * `total` is `null` where counting every match would cost more than the answer is worth — a grouped
 * count over the whole audit log, for instance. `truncated` is still exact in that case, because the
 * query asks for one row more than the cap and throws it away: "20 shown, and there are more" is an
 * honest sentence, "20" on its own is not.
 */
export interface CappedList<T> {
  items: T[];
  total: number | null;
  cap: number;
  truncated: boolean;
}

function capped<T>(items: readonly T[], cap: number, total: number | null): CappedList<T> {
  const list = items.slice(0, cap);
  return {
    items: list,
    total,
    cap,
    truncated: total === null ? items.length > cap : total > list.length
  };
}

/** A list built by asking for `cap + 1` rows, where no cheap count exists. */
function cappedByProbe<T>(rows: readonly T[], cap: number): CappedList<T> {
  const truncated = rows.length > cap;
  return { items: rows.slice(0, cap), total: truncated ? null : rows.length, cap, truncated };
}

/**
 * Whoever did something, as far as the log can say.
 *
 * `email` here is ALWAYS a studio account's address: the audit row's `actorEmail` is written from the
 * signed-in session, and a failed sign-in has no actor at all (see app/api/auth/login/route.ts, which
 * passes `actor: null`). The address somebody TYPED at a refused sign-in never arrives through this
 * shape — it goes through `RefusedAttempt`, where it is masked unless it is recognised.
 *
 * `id` and `name` are null when the account has been hard-deleted: `AuditLog.actor` is
 * `onDelete: SetNull`, which nulls `actorId` too, and `actorEmail` is denormalised for exactly that
 * reason — a purged account must not erase the trail.
 */
export interface ActorRef {
  id: string | null;
  name: string | null;
  email: string | null;
}

interface ActorColumns {
  actorId: string | null;
  actorEmail: string | null;
  actor: { id: string; name: string; email: string } | null;
}

function actorRef(row: ActorColumns): ActorRef {
  return {
    id: row.actor?.id ?? row.actorId,
    name: row.actor?.name ?? null,
    email: row.actor?.email ?? row.actorEmail
  };
}

const ACTOR_SELECT = { select: { id: true, name: true, email: true } } as const;

/** The window a question covers, as resolved rather than as asked for. */
export interface ResolvedRange {
  /** ISO instant. The start of the first day, in UTC. */
  from: string;
  /** ISO instant. The last millisecond of the last day, in UTC. */
  to: string;
  days: number;
  /** True when a longer window was asked for than `MAX_RANGE_DAYS` allows. */
  capped: boolean;
  /** True when the two dates arrived the wrong way round and were swapped rather than refused. */
  swapped: boolean;
}

export interface ResolvedWindow {
  fromDate: Date;
  toDate: Date;
  range: ResolvedRange;
}

/** UTC midnight. Every bucket in this module is a UTC day, so a range means one thing everywhere. */
function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD` → UTC midnight, or null.
 *
 * The SHAPE is checked before `Date` sees it: `new Date("last Tuesday")` is an Invalid Date, which is
 * easy to spot, but `new Date("2026")` is a perfectly valid instant nobody meant to ask for.
 */
export function parseDay(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Turn two optional days into a window that is always usable.
 *
 * A TRANSPOSED RANGE IS SWAPPED AND SAID OUT LOUD, not refused. On a screen, "to" before "from" is a
 * typo, and an empty answer with no explanation is the least useful possible response to one. An
 * over-long range is capped from the RECENT end — somebody who asked for ten years wants this year's
 * shape, not 2016's — and `capped` is what makes the screen able to say so.
 */
export function resolveRange(from: Date | null, to: Date | null): ResolvedWindow {
  const today = utcDay(new Date());
  const requestedTo = to ? utcDay(to) : today;
  const requestedFrom = from
    ? utcDay(from)
    : new Date(requestedTo.getTime() - (DEFAULT_RANGE_DAYS - 1) * DAY_MS);

  const swapped = requestedFrom.getTime() > requestedTo.getTime();
  const [orderedFrom, orderedTo] = swapped
    ? [requestedTo, requestedFrom]
    : [requestedFrom, requestedTo];

  const askedDays = Math.floor((orderedTo.getTime() - orderedFrom.getTime()) / DAY_MS) + 1;
  const isCapped = askedDays > MAX_RANGE_DAYS;
  const startDay = isCapped
    ? new Date(orderedTo.getTime() - (MAX_RANGE_DAYS - 1) * DAY_MS)
    : orderedFrom;

  // The whole of the last day, so "to 4 June" includes everything that happened on the 4th.
  const endInstant = new Date(orderedTo.getTime() + DAY_MS - 1);
  const days = Math.floor((orderedTo.getTime() - startDay.getTime()) / DAY_MS) + 1;

  return {
    fromDate: startDay,
    toDate: endInstant,
    range: {
      from: startDay.toISOString(),
      to: endInstant.toISOString(),
      days,
      capped: isCapped,
      swapped
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Reading a stored snapshot
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function asRecord(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Columns that change on every save and mean nothing on their own.
 *
 * They are SKIPPED rather than hidden: `RevisionDiff.ignoredFields` names the ones that actually
 * differed, so a comparison that looks empty can be told apart from one that was quietly filtered.
 */
const NOISY_FIELDS: readonly string[] = ["id", "createdAt", "updatedAt"];

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    // A value that will not serialise cannot be compared, and calling it unchanged would hide a change.
    return false;
  }
}

/** Which columns differ between two snapshots, ignoring the ones that always do. */
function changedFields(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null
): string[] {
  if (!before && !after) return [];
  const fields = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
  return fields.filter(
    (field) => !NOISY_FIELDS.includes(field) && !sameValue(before?.[field], after?.[field])
  );
}

export type PreviewKind =
  | "empty"
  | "text"
  | "number"
  | "boolean"
  | "list"
  | "structure"
  | "unreadable";

/**
 * One value, ready to render.
 *
 * `length` is the length of the WHOLE value, always, so a shortened preview can say how much it is not
 * showing. A value cut without saying so is the same bug class as a list that quietly stops.
 *
 * `kind` exists so the screen never has to render the word "null": "not set" and the empty string are
 * different facts about a field, and both are different from the text "null".
 */
export interface ValuePreview {
  kind: PreviewKind;
  text: string;
  length: number;
  truncated: boolean;
}

export function previewValue(value: unknown): ValuePreview {
  if (value === null || value === undefined) return { kind: "empty", text: "", length: 0, truncated: false };

  if (typeof value === "string") {
    const truncated = value.length > VALUE_PREVIEW_LIMIT;
    return {
      kind: value.length === 0 ? "empty" : "text",
      text: truncated ? value.slice(0, VALUE_PREVIEW_LIMIT) : value,
      length: value.length,
      truncated
    };
  }

  if (typeof value === "number") {
    const text = String(value);
    return { kind: "number", text, length: text.length, truncated: false };
  }

  if (typeof value === "boolean") {
    const text = value ? "yes" : "no";
    return { kind: "boolean", text, length: text.length, truncated: false };
  }

  let serialised: string;
  try {
    serialised = JSON.stringify(value, null, 2) ?? "";
  } catch {
    return { kind: "unreadable", text: "", length: 0, truncated: false };
  }

  const truncated = serialised.length > VALUE_PREVIEW_LIMIT;
  return {
    kind: Array.isArray(value) ? "list" : "structure",
    text: truncated ? serialised.slice(0, VALUE_PREVIEW_LIMIT) : serialised,
    length: serialised.length,
    truncated
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Whose name may appear
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Records whose LABEL names a member of the public rather than a colleague.
 *
 * ⚠ THIS IS NOT A TIDINESS RULE. A contact enquiry is logged with `entityLabel` set to
 * `"Name <address>"` and an event registration the same way, so a record lookup on one of those would
 * print somebody's correspondence details onto a screen about studio security. They were never studio
 * users and never agreed to appear here.
 *
 * The timeline still renders — who triaged an enquiry and when is a legitimate question about a
 * colleague's work — but the label is replaced and the reason is stated.
 */
const PUBLIC_PERSON_ENTITIES = new Set(["ContactSubmission", "EventRegistration"]);

const PUBLIC_PERSON_STAND_INS: Record<string, string> = {
  ContactSubmission: "an enquiry sent through the website",
  EventRegistration: "somebody's registration for an event"
};

export function labelIsWithheld(entityType: string): boolean {
  return PUBLIC_PERSON_ENTITIES.has(entityType);
}

/** The label as it may be shown, or a stand-in phrase for a record that names a member of the public. */
export function safeEntityLabel(entityType: string, label: string | null): string | null {
  if (!labelIsWithheld(entityType)) return label;
  return PUBLIC_PERSON_STAND_INS[entityType] ?? "a record about a member of the public";
}

/**
 * An address with its local part removed.
 *
 * The domain is kept because it is the half that answers the question being asked — "is somebody
 * working through addresses at this institution?" — and the local part is the half that names a person.
 * A masked address is not an email address, which is why this is allowed where the whole thing is not.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "an address that could not be read";
  return `••••${email.slice(at)}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1. One record: where did this come from, and who touched it?
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface RecordEvent {
  id: string;
  action: AuditAction;
  /** ISO instant. */
  at: string;
  actor: ActorRef;
  /** The NAMES of the fields that changed. Never the values — see the module header. */
  changedFields: string[];
  changedFieldsTotal: number;
  /** True when this kind of entry records no before and after at all: a sign-in, a lock take-over. */
  isEvent: boolean;
}

export interface RecordRevision {
  id: string;
  version: number;
  at: string;
  summary: string | null;
  author: ActorRef;
}

export interface RecordLock {
  holderName: string;
  holderEmail: string;
  /** When they opened it — not when the heartbeat last refreshed it. */
  since: string;
  expiresAt: string;
  /** True when the hold has lapsed and the row is merely rubbish nobody has cleared. */
  lapsed: boolean;
}

export interface RecordProvenance {
  entityType: string;
  entityId: string;
  label: string | null;
  labelWithheld: boolean;
  /** The CREATE entry, read separately so a truncated timeline can never lose it. */
  created: { at: string; actor: ActorRef } | null;
  /** The oldest entry of any kind, for a record whose creation predates the log. */
  firstSeenAt: string | null;
  lastChangeAt: string | null;
  totalEvents: number;
  byAction: { action: AuditAction; count: number }[];
  timeline: CappedList<RecordEvent>;
  revisions: CappedList<RecordRevision>;
  lock: RecordLock | null;
  /** How many times it has been pulled back out of the recycle bin. */
  restoredFromBin: number;
  /** True when nothing at all is recorded against this pair. */
  empty: boolean;
}

/**
 * One record's whole lineage.
 *
 * ⚠ THE CREATION EVENT IS FETCHED SEPARATELY FROM THE TIMELINE, and that is the point of the extra
 * query. The timeline is newest-first — which is the order somebody reading an incident wants — so a
 * record with more than `timeline` entries would lose its own beginning to the cap. "Created by
 * whom" is the one fact this screen must never be unable to answer.
 *
 * NO NETWORK ADDRESSES. The question is about the content, and an address printed beside a
 * colleague's name where nobody asked for one is surveillance by default. `actorProvenance` carries
 * them, because there the address IS the question.
 */
export async function recordProvenance(
  entityType: string,
  entityId: string
): Promise<RecordProvenance> {
  const type = entityType.trim();
  const id = entityId.trim();
  const where: Prisma.AuditLogWhereInput = { entityType: type, entityId: id };

  const [creation, oldest, newest, entries, totalEvents, revisionRows, revisionTotal, lockRow, restoredFromBin] =
    await prisma.$transaction([
      prisma.auditLog.findFirst({
        where: { ...where, action: "CREATE" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { createdAt: true, actorId: true, actorEmail: true, actor: ACTOR_SELECT }
      }),
      prisma.auditLog.findFirst({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { createdAt: true, entityLabel: true }
      }),
      prisma.auditLog.findFirst({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { createdAt: true, entityLabel: true }
      }),
      prisma.auditLog.findMany({
        where,
        // Newest first, with the id as the tiebreak so two entries written in the same millisecond keep
        // a stable order between requests.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: PROVENANCE_CAPS.timeline,
        select: {
          id: true,
          action: true,
          createdAt: true,
          actorId: true,
          actorEmail: true,
          actor: ACTOR_SELECT,
          before: true,
          after: true
        }
      }),
      prisma.auditLog.count({ where }),
      prisma.revision.findMany({
        where: { entityType: type, entityId: id },
        orderBy: { version: "desc" },
        take: PROVENANCE_CAPS.revisions,
        // `data` is deliberately not selected. A revision list needs versions and authors; the payload
        // is read only when two of them are actually compared, by `diffRevisions`.
        select: {
          id: true,
          version: true,
          summary: true,
          createdAt: true,
          authorId: true,
          author: ACTOR_SELECT
        }
      }),
      prisma.revision.count({ where: { entityType: type, entityId: id } }),
      prisma.contentLock.findUnique({
        where: { entityType_entityId: { entityType: type, entityId: id } },
        select: { acquiredAt: true, expiresAt: true, user: ACTOR_SELECT }
      }),
      prisma.auditLog.count({ where: { ...where, action: "RESTORE" } })
    ]);

  /**
   * Run on its own rather than inside the array above, because the array form of `$transaction` erases
   * `groupBy`'s return type — `_count` comes back as the INPUT type and `_count._all` stops existing.
   * (Same note as app/api/studio/events/[id]/registrations/route.ts.)
   */
  const grouped = await prisma.auditLog.groupBy({
    by: ["action"],
    where,
    orderBy: { action: "asc" },
    _count: { _all: true }
  });

  const label = newest?.entityLabel ?? oldest?.entityLabel ?? null;
  const now = Date.now();

  return {
    entityType: type,
    entityId: id,
    label: safeEntityLabel(type, label),
    labelWithheld: labelIsWithheld(type) && label !== null,
    created: creation
      ? { at: creation.createdAt.toISOString(), actor: actorRef(creation) }
      : null,
    firstSeenAt: oldest ? oldest.createdAt.toISOString() : null,
    lastChangeAt: newest ? newest.createdAt.toISOString() : null,
    totalEvents,
    byAction: grouped.map((row) => ({ action: row.action, count: row._count._all })),
    timeline: capped(
      entries.map((entry): RecordEvent => {
        const before = asRecord(entry.before);
        const after = asRecord(entry.after);
        const fields = changedFields(before, after);
        return {
          id: entry.id,
          action: entry.action,
          at: entry.createdAt.toISOString(),
          actor: actorRef(entry),
          changedFields: fields.slice(0, PROVENANCE_CAPS.fieldsPerEvent),
          changedFieldsTotal: fields.length,
          isEvent: before === null && after === null
        };
      }),
      PROVENANCE_CAPS.timeline,
      totalEvents
    ),
    revisions: capped(
      revisionRows.map((row): RecordRevision => ({
        id: row.id,
        version: row.version,
        at: row.createdAt.toISOString(),
        summary: row.summary,
        author: {
          id: row.author?.id ?? row.authorId,
          name: row.author?.name ?? null,
          email: row.author?.email ?? null
        }
      })),
      PROVENANCE_CAPS.revisions,
      revisionTotal
    ),
    lock: lockRow
      ? {
          holderName: lockRow.user.name,
          holderEmail: lockRow.user.email,
          since: lockRow.acquiredAt.toISOString(),
          expiresAt: lockRow.expiresAt.toISOString(),
          // An expired row is reported as lapsed rather than dropped: "nobody is editing this, but
          // somebody had it open until 14:40" is a different and more useful fact than silence.
          lapsed: lockRow.expiresAt.getTime() <= now
        }
      : null,
    restoredFromBin,
    empty: totalEvents === 0 && revisionTotal === 0
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 2. One person: what have they done, and from where?
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface SignInEvent {
  id: string;
  action: AuditAction;
  at: string;
  ipAddress: string | null;
  /** A plain sentence for a refusal, null for a success. */
  reason: string | null;
  /** Which method, where the log recorded one. */
  provider: string | null;
}

export interface ActorProvenance {
  person: {
    id: string;
    name: string;
    email: string;
    role: Role;
    isActive: boolean;
    twoFactorEnabled: boolean;
    lastLoginAt: string | null;
    joinedAt: string;
  } | null;
  range: ResolvedRange;
  /** Changes made INSIDE the window. */
  totalActions: number;
  /**
   * Changes made outside it, so a quiet week is never mistaken for a quiet colleague. A filter that
   * does not say what it excluded is a filter that misleads.
   */
  actionsOutsideRange: number;
  byEntityType: CappedList<{ entityType: string; count: number }>;
  /** Dense: one entry per day in the window, zeros included. */
  byDay: { day: string; count: number }[];
  signIns: CappedList<SignInEvent>;
  addresses: CappedList<{ address: string; count: number; firstSeen: string; lastSeen: string }>;
}

/**
 * The reason a sign-in was refused, as a sentence.
 *
 * The log stores a SHORT CODE for the password door (`lib/auth/session.ts` returns "invalid" |
 * "locked" | "inactive") and a whole sentence for the allow-list, because `describeRefusal()` in
 * lib/auth/access.ts already writes one. Both arrive here; the codes are expanded and the sentences
 * are used as they stand, so a reason written by a newer deploy than this file still reads properly
 * instead of rendering as a bare word nobody outside the codebase knows.
 */
function refusalDetail(after: Prisma.JsonValue | null): {
  reason: string;
  provider: string | null;
  email: string | null;
} {
  const payload = asRecord(after);
  const rawReason = typeof payload?.reason === "string" ? payload.reason.trim() : "";
  const detail = typeof payload?.detail === "string" ? payload.detail.trim() : "";
  const provider = typeof payload?.provider === "string" ? payload.provider.trim() : null;
  const email = typeof payload?.email === "string" ? payload.email.trim() : null;

  const reason = ((): string => {
    switch (rawReason) {
      case "invalid":
        return "the email address or the password was wrong";
      case "locked":
        return "the account was temporarily locked after too many attempts";
      case "inactive":
        return "the account has been deactivated";
      case "second-factor":
        return "the password was right but the six-digit code was not";
      case "access-refused":
        return detail.length > 0
          ? detail
          : "the address is not allowed to sign in to the studio";
      case "":
        return "no reason was recorded";
      default:
        // Already a sentence (the allow-list and the OAuth callback write one), or a code from a
        // newer deploy. Either way it is more informative than "refused".
        return rawReason;
    }
  })();

  return { reason, provider: provider && provider.length > 0 ? provider : null, email };
}

/**
 * The three actions that are about getting in rather than about content.
 *
 * A MUTABLE array on purpose: Prisma's generated `in` / `notIn` filters take `AuditAction[]`, and a
 * `readonly` one is not assignable to it. Nothing reassigns it.
 */
const SIGN_IN_ACTIONS: AuditAction[] = ["LOGIN", "LOGIN_FAILED", "LOGOUT"];

/**
 * Everything one person has done, and the addresses they did it from.
 *
 * ⚠ A REFUSED SIGN-IN HAS NO ACTOR, so `actorId` alone would show a clean sheet for somebody whose
 * account has been under attack all week. `app/api/auth/login/route.ts` writes `LOGIN_FAILED` with
 * `actor: null` — deliberately, because nobody was signed in — and identifies the account through
 * `entityId` instead. Every query below that is about SIGN-INS therefore matches either column;
 * the queries about WORK match `actorId` only, because a refused sign-in is not something the person
 * did.
 */
export async function actorProvenance(
  userId: string,
  window: ResolvedWindow
): Promise<ActorProvenance> {
  const id = userId.trim();
  const { fromDate, toDate, range } = window;
  const inRange: Prisma.DateTimeFilter = { gte: fromDate, lte: toDate };

  const person = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      twoFactorEnabled: true,
      lastLoginAt: true,
      createdAt: true
    }
  });

  if (!person) {
    return {
      person: null,
      range,
      totalActions: 0,
      actionsOutsideRange: 0,
      byEntityType: { items: [], total: 0, cap: PROVENANCE_CAPS.entityTypes, truncated: false },
      byDay: [],
      signIns: { items: [], total: 0, cap: PROVENANCE_CAPS.signIns, truncated: false },
      addresses: { items: [], total: 0, cap: PROVENANCE_CAPS.addresses, truncated: false }
    };
  }

  /** Anything this person is named in, whether as the actor or as the account somebody tried. */
  const namedIn: Prisma.AuditLogWhereInput = {
    OR: [{ actorId: id }, { entityType: "User", entityId: id, action: { in: SIGN_IN_ACTIONS } }]
  };

  const [totalActions, totalEver, signInRows, signInTotal] = await prisma.$transaction([
    prisma.auditLog.count({ where: { actorId: id, createdAt: inRange } }),
    prisma.auditLog.count({ where: { actorId: id } }),
    prisma.auditLog.findMany({
      where: { AND: [namedIn, { action: { in: SIGN_IN_ACTIONS } }, { createdAt: inRange }] },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PROVENANCE_CAPS.signIns,
      select: { id: true, action: true, createdAt: true, ipAddress: true, after: true }
    }),
    prisma.auditLog.count({
      where: { AND: [namedIn, { action: { in: SIGN_IN_ACTIONS } }, { createdAt: inRange }] }
    })
  ]);

  // Two `groupBy` calls, each awaited on its own — see the note in `recordProvenance`.
  const byType = await prisma.auditLog.groupBy({
    by: ["entityType"],
    where: { actorId: id, createdAt: inRange },
    orderBy: { _count: { entityType: "desc" } },
    take: PROVENANCE_CAPS.entityTypes + 1,
    _count: { _all: true }
  });

  const byAddress = await prisma.auditLog.groupBy({
    by: ["ipAddress"],
    where: { AND: [namedIn, { createdAt: inRange }, { ipAddress: { not: null } }] },
    orderBy: { _count: { ipAddress: "desc" } },
    take: PROVENANCE_CAPS.addresses + 1,
    _count: { _all: true },
    _min: { createdAt: true },
    _max: { createdAt: true }
  });

  const dailyRows = await prisma.$queryRaw<{ day: Date; count: number }[]>(
    /**
     * ⚠ `count(*)::int`, NOT `count(*)`. Postgres counts as `bigint`, Prisma maps that to a JavaScript
     * `BigInt`, and `JSON.stringify` THROWS on a BigInt — so the cast is what stops this endpoint
     * answering 500 for a person with any activity at all. `date_trunc` is used because Prisma's
     * `groupBy` can only group on a whole column, and grouping on an instant is one bucket per
     * millisecond.
     */
    Prisma.sql`
      SELECT date_trunc('day', "createdAt") AS day, count(*)::int AS count
      FROM "audit_logs"
      WHERE "actorId" = ${id} AND "createdAt" >= ${fromDate} AND "createdAt" <= ${toDate}
      GROUP BY 1
      ORDER BY 1
    `
  );

  const perDay = new Map<string, number>();
  for (const row of dailyRows) perDay.set(dayKey(row.day), row.count);

  return {
    person: {
      id: person.id,
      name: person.name,
      email: person.email,
      role: person.role,
      isActive: person.isActive,
      twoFactorEnabled: person.twoFactorEnabled,
      lastLoginAt: person.lastLoginAt ? person.lastLoginAt.toISOString() : null,
      joinedAt: person.createdAt.toISOString()
    },
    range,
    totalActions,
    actionsOutsideRange: Math.max(0, totalEver - totalActions),
    byEntityType: cappedByProbe(
      byType.map((row) => ({ entityType: row.entityType, count: row._count._all })),
      PROVENANCE_CAPS.entityTypes
    ),
    byDay: denseDays(fromDate, range.days, (key) => ({ count: perDay.get(key) ?? 0 })),
    signIns: capped(
      signInRows.map((row): SignInEvent => {
        const failed = row.action === "LOGIN_FAILED";
        const detail = refusalDetail(row.after);
        return {
          id: row.id,
          action: row.action,
          at: row.createdAt.toISOString(),
          ipAddress: row.ipAddress,
          reason: failed ? detail.reason : null,
          provider: detail.provider
        };
      }),
      PROVENANCE_CAPS.signIns,
      signInTotal
    ),
    addresses: cappedByProbe(
      byAddress.flatMap((row) => {
        // The `not: null` filter above already excludes them; the narrowing is for TypeScript, which
        // cannot know that a `where` clause constrains a grouped key.
        if (row.ipAddress === null) return [];
        const first = row._min.createdAt ?? row._max.createdAt;
        const last = row._max.createdAt ?? row._min.createdAt;
        return [
          {
            address: row.ipAddress,
            count: row._count._all,
            firstSeen: first ? first.toISOString() : range.from,
            lastSeen: last ? last.toISOString() : range.to
          }
        ];
      }),
      PROVENANCE_CAPS.addresses
    )
  };
}

/**
 * One entry per day in the window, zeros included.
 *
 * ⚠ A SERIES BUILT ONLY FROM THE DAYS THAT HAVE ROWS SILENTLY CLOSES THE GAPS, and a quiet fortnight
 * then draws as a busy one — the chart is a different shape from the data. The loop is bounded by
 * `MAX_RANGE_DAYS` through `resolveRange`, so it cannot run away on a mistyped date.
 */
function denseDays<T extends object>(
  from: Date,
  days: number,
  valueFor: (key: string) => T
): ({ day: string } & T)[] {
  const out: ({ day: string } & T)[] = [];
  for (let index = 0; index < days; index += 1) {
    const key = dayKey(new Date(from.getTime() + index * DAY_MS));
    out.push({ day: key, ...valueFor(key) });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 3. The installation: who has been in, and who has been trying?
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface RefusedAttempt {
  id: string;
  at: string;
  /**
   * The address as it may be shown: in full when it belongs to a studio account or to a row on the
   * access list, masked to its domain otherwise. See `maskEmail`.
   */
  address: string | null;
  /** True when the address is one this installation recognises. False means `address` is masked. */
  addressKnown: boolean;
  ipAddress: string | null;
  provider: string | null;
  reason: string;
}

export interface UnusedGrant {
  id: string;
  email: string;
  name: string | null;
  grantedRole: Role;
  note: string | null;
  allowedProviders: AuthProvider[];
  addedAt: string;
  addedByName: string | null;
}

export interface InstallationPerson {
  id: string;
  name: string;
  email: string;
  role: Role;
  count: number;
}

export interface InstallationProvenance {
  range: ResolvedRange;
  /** Dense: one entry per day in the window. */
  byDay: { day: string; signIns: number; refused: number }[];
  totals: {
    signIns: number;
    refused: number;
    /** Changes to content and settings — everything that is not a sign-in, sign-out or refusal. */
    changes: number;
  };
  /** Who actually got in during the window, most sign-ins first. */
  signedIn: CappedList<InstallationPerson>;
  mostActive: CappedList<InstallationPerson>;
  refusals: CappedList<RefusedAttempt>;
  /** Where the refusals came from, so a burst from one address is visible as one line. */
  refusalSources: CappedList<{ address: string; count: number; lastSeen: string }>;
  unusedGrants: CappedList<UnusedGrant>;
  withoutTwoFactor: CappedList<{
    id: string;
    name: string;
    email: string;
    role: Role;
    lastLoginAt: string | null;
  }>;
  /** The address filter as applied, echoed so a screen can say what it is showing. */
  addressFilter: string;
}

/**
 * The whole installation's week.
 *
 * `addressFilter` narrows the REFUSALS ONLY, and only by network address. Deliberately not by the
 * address somebody typed: the attempted addresses are shown masked, and a search that confirmed a
 * masked address would undo the masking one guess at a time.
 */
export async function installationProvenance(
  window: ResolvedWindow,
  options: { addressFilter?: string } = {}
): Promise<InstallationProvenance> {
  const { fromDate, toDate, range } = window;
  const inRange: Prisma.DateTimeFilter = { gte: fromDate, lte: toDate };
  const addressFilter = (options.addressFilter ?? "").trim();

  const refusalWhere: Prisma.AuditLogWhereInput = {
    action: "LOGIN_FAILED",
    createdAt: inRange,
    ...(addressFilter.length > 0 ? { ipAddress: { contains: addressFilter } } : {})
  };

  const [signIns, refused, changes, refusalRows, refusalTotal, grantRows, grantTotal, weakRows, weakTotal] =
    await prisma.$transaction([
      prisma.auditLog.count({ where: { action: "LOGIN", createdAt: inRange } }),
      prisma.auditLog.count({ where: { action: "LOGIN_FAILED", createdAt: inRange } }),
      prisma.auditLog.count({
        where: { createdAt: inRange, action: { notIn: SIGN_IN_ACTIONS } }
      }),
      prisma.auditLog.findMany({
        where: refusalWhere,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: PROVENANCE_CAPS.refusals,
        select: {
          id: true,
          createdAt: true,
          entityLabel: true,
          ipAddress: true,
          after: true
        }
      }),
      prisma.auditLog.count({ where: refusalWhere }),
      prisma.studioAccess.findMany({
        // A grant that has never been used AND has not been revoked. A revoked one is a decision
        // somebody made; this list is the one that makes an access list prunable.
        where: { revokedAt: null, lastSignInAt: null },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: PROVENANCE_CAPS.unusedGrants,
        select: {
          id: true,
          email: true,
          name: true,
          grantedRole: true,
          note: true,
          allowedProviders: true,
          createdAt: true,
          addedBy: { select: { name: true } }
        }
      }),
      prisma.studioAccess.count({ where: { revokedAt: null, lastSignInAt: null } }),
      prisma.user.findMany({
        where: { deletedAt: null, isActive: true, twoFactorEnabled: false },
        // Role descending puts the consequential accounts first: an administrator with no second
        // factor is a different size of problem from a viewer with none.
        orderBy: [{ role: "desc" }, { name: "asc" }],
        take: PROVENANCE_CAPS.withoutTwoFactor,
        select: { id: true, name: true, email: true, role: true, lastLoginAt: true }
      }),
      prisma.user.count({ where: { deletedAt: null, isActive: true, twoFactorEnabled: false } })
    ]);

  // Each `groupBy` on its own — the array form of `$transaction` erases `_count`. See `recordProvenance`.
  const signedInGroups = await prisma.auditLog.groupBy({
    by: ["actorId"],
    where: { action: "LOGIN", createdAt: inRange, actorId: { not: null } },
    orderBy: { _count: { actorId: "desc" } },
    take: PROVENANCE_CAPS.people + 1,
    _count: { _all: true }
  });

  const activeGroups = await prisma.auditLog.groupBy({
    by: ["actorId"],
    where: {
      createdAt: inRange,
      actorId: { not: null },
      action: { notIn: SIGN_IN_ACTIONS }
    },
    orderBy: { _count: { actorId: "desc" } },
    take: PROVENANCE_CAPS.people + 1,
    _count: { _all: true }
  });

  const sourceGroups = await prisma.auditLog.groupBy({
    by: ["ipAddress"],
    where: { action: "LOGIN_FAILED", createdAt: inRange, ipAddress: { not: null } },
    orderBy: { _count: { ipAddress: "desc" } },
    take: PROVENANCE_CAPS.refusalSources + 1,
    _count: { _all: true },
    _max: { createdAt: true }
  });

  const dailyRows = await prisma.$queryRaw<{ day: Date; signIns: number; refused: number }[]>(
    // `::int` for the same reason as in `actorProvenance`: a `bigint` count reaches JSON as a BigInt
    // and `JSON.stringify` throws on one. `FILTER` gets both numbers from one pass over the range, and
    // each aggregate is PARENTHESISED before the cast so there is no question about what `::int`
    // applies to. The two aliases are quoted, or Postgres would fold them to lower case and the rows
    // would arrive with keys this file does not read.
    Prisma.sql`
      SELECT date_trunc('day', "createdAt") AS day,
             (count(*) FILTER (WHERE "action" = 'LOGIN'))::int AS "signIns",
             (count(*) FILTER (WHERE "action" = 'LOGIN_FAILED'))::int AS "refused"
      FROM "audit_logs"
      WHERE "createdAt" >= ${fromDate}
        AND "createdAt" <= ${toDate}
        AND "action" IN ('LOGIN', 'LOGIN_FAILED')
      GROUP BY 1
      ORDER BY 1
    `
  );

  const perDay = new Map<string, { signIns: number; refused: number }>();
  for (const row of dailyRows) {
    perDay.set(dayKey(row.day), { signIns: row.signIns, refused: row.refused });
  }

  // ── Names for the grouped actor ids ───────────────────────────────────────────────────────────
  const actorIds = [
    ...new Set(
      [...signedInGroups, ...activeGroups].flatMap((row) => (row.actorId ? [row.actorId] : []))
    )
  ];
  const actorRows =
    actorIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true, email: true, role: true }
        })
      : [];
  const actorsById = new Map(actorRows.map((row) => [row.id, row]));

  function toPeople(
    groups: { actorId: string | null; _count: { _all: number } }[]
  ): InstallationPerson[] {
    return groups.flatMap((row) => {
      if (!row.actorId) return [];
      const found = actorsById.get(row.actorId);
      // An id with no row is an account that has been hard-deleted since. It is kept, named as such,
      // rather than dropped: the sign-ins happened, and a silently shorter list is the bug this
      // module exists to avoid.
      return [
        {
          id: row.actorId,
          name: found?.name ?? "An account that has since been deleted",
          email: found?.email ?? "",
          role: found?.role ?? "VIEWER",
          count: row._count._all
        }
      ];
    });
  }

  // ── Which attempted addresses this installation recognises ────────────────────────────────────
  const attempted = refusalRows.flatMap((row) => {
    const fromPayload = refusalDetail(row.after).email;
    const candidate = fromPayload ?? row.entityLabel;
    if (!candidate) return [];
    const trimmed = candidate.trim().toLowerCase();
    return trimmed.includes("@") ? [trimmed] : [];
  });
  const unique = [...new Set(attempted)];

  const known = new Set<string>();
  if (unique.length > 0) {
    const [knownUsers, knownGrants] = await prisma.$transaction([
      prisma.user.findMany({ where: { email: { in: unique } }, select: { email: true } }),
      prisma.studioAccess.findMany({ where: { email: { in: unique } }, select: { email: true } })
    ]);
    for (const row of knownUsers) known.add(row.email.toLowerCase());
    for (const row of knownGrants) known.add(row.email.toLowerCase());
  }

  return {
    range,
    byDay: denseDays(fromDate, range.days, (key) => perDay.get(key) ?? { signIns: 0, refused: 0 }),
    totals: { signIns, refused, changes },
    signedIn: cappedByProbe(toPeople(signedInGroups), PROVENANCE_CAPS.people),
    mostActive: cappedByProbe(toPeople(activeGroups), PROVENANCE_CAPS.people),
    refusals: capped(
      refusalRows.map((row): RefusedAttempt => {
        const detail = refusalDetail(row.after);
        const candidate = (detail.email ?? row.entityLabel ?? "").trim().toLowerCase();
        const looksLikeAddress = candidate.includes("@");
        const isKnown = looksLikeAddress && known.has(candidate);
        return {
          id: row.id,
          at: row.createdAt.toISOString(),
          address: looksLikeAddress
            ? isKnown
              ? candidate
              : maskEmail(candidate)
            : null,
          addressKnown: isKnown,
          ipAddress: row.ipAddress,
          provider: detail.provider,
          reason: detail.reason
        };
      }),
      PROVENANCE_CAPS.refusals,
      refusalTotal
    ),
    refusalSources: cappedByProbe(
      sourceGroups.flatMap((row) => {
        if (row.ipAddress === null) return [];
        const last = row._max.createdAt;
        return [
          {
            address: row.ipAddress,
            count: row._count._all,
            lastSeen: last ? last.toISOString() : range.to
          }
        ];
      }),
      PROVENANCE_CAPS.refusalSources
    ),
    unusedGrants: capped(
      grantRows.map((row): UnusedGrant => ({
        id: row.id,
        email: row.email,
        name: row.name,
        grantedRole: row.grantedRole,
        note: row.note,
        allowedProviders: row.allowedProviders,
        addedAt: row.createdAt.toISOString(),
        addedByName: row.addedBy?.name ?? null
      })),
      PROVENANCE_CAPS.unusedGrants,
      grantTotal
    ),
    withoutTwoFactor: capped(
      weakRows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role,
        lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null
      })),
      PROVENANCE_CAPS.withoutTwoFactor,
      weakTotal
    ),
    addressFilter
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 4. Comparing two stored revisions
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface RevisionSide {
  id: string;
  version: number;
  at: string;
  summary: string | null;
  authorName: string | null;
}

export interface RevisionFieldChange {
  field: string;
  before: ValuePreview | null;
  after: ValuePreview | null;
}

export interface RevisionDiff {
  entityType: string;
  entityId: string;
  /** Always the OLDER of the two, whichever order they were named in. */
  from: RevisionSide;
  to: RevisionSide;
  /** Fields the later version has and the earlier one did not. */
  added: RevisionFieldChange[];
  /** Fields the earlier version had and the later one does not. */
  removed: RevisionFieldChange[];
  changed: RevisionFieldChange[];
  /** How many fields are the same in both. */
  unchanged: number;
  /** Which of `id` / `createdAt` / `updatedAt` differed and were left out. */
  ignoredFields: string[];
  cap: number;
  truncated: boolean;
}

export type RevisionDiffResult =
  | { ok: true; diff: RevisionDiff }
  | { ok: false; reason: "missing" | "mismatched" | "same" | "withheld" };

/**
 * A field-level comparison of two stored revisions.
 *
 * ⚠ THE DIFF IS COMPUTED HERE RATHER THAN STORED, and that is a consequence of a decision made in
 * lib/audit.ts: `before` / `after` and `Revision.data` hold the FULL serialised entity, because a diff
 * computed at write time is only as good as the differ that produced it and a rollback needs the whole
 * prior state anyway. So the whole state is what is kept, and the comparison is done at read time by
 * whichever version of this function is deployed.
 *
 * A RESULT, NOT A THROW. This module is called by a PAGE as well as by a route handler, and an
 * `ApiError` thrown inside a Server Component is an unhandled server error — a 500 where a plain
 * sentence belongs (contract §1.9). The caller decides how to say it.
 *
 * The pair is normalised so `from` is always the older version: a comparison that reads backwards
 * because of the order two ids were clicked in is a comparison somebody will misread.
 */
export async function diffRevisions(a: string, b: string): Promise<RevisionDiffResult> {
  const leftId = a.trim();
  const rightId = b.trim();
  if (leftId.length === 0 || rightId.length === 0) return { ok: false, reason: "missing" };
  if (leftId === rightId) return { ok: false, reason: "same" };

  const rows = await prisma.revision.findMany({
    where: { id: { in: [leftId, rightId] } },
    select: {
      id: true,
      entityType: true,
      entityId: true,
      version: true,
      summary: true,
      createdAt: true,
      data: true,
      author: { select: { name: true } }
    }
  });

  const left = rows.find((row) => row.id === leftId);
  const right = rows.find((row) => row.id === rightId);
  if (!left || !right) return { ok: false, reason: "missing" };
  if (left.entityType !== right.entityType || left.entityId !== right.entityId) {
    return { ok: false, reason: "mismatched" };
  }
  // A revision of an enquiry or a registration would be a second copy of a member of the public's
  // words. Nothing writes those today (every inquiry route passes `revise: false`), and this is what
  // keeps that true if one ever starts.
  if (labelIsWithheld(left.entityType)) return { ok: false, reason: "withheld" };

  const [older, newer] = left.version <= right.version ? [left, right] : [right, left];

  const olderData = asRecord(older.data) ?? {};
  const newerData = asRecord(newer.data) ?? {};
  const fields = [...new Set([...Object.keys(olderData), ...Object.keys(newerData)])].sort();

  const added: RevisionFieldChange[] = [];
  const removed: RevisionFieldChange[] = [];
  const changed: RevisionFieldChange[] = [];
  const ignoredFields: string[] = [];
  let unchanged = 0;
  let counted = 0;
  let truncated = false;

  for (const field of fields) {
    const inOlder = Object.hasOwn(olderData, field);
    const inNewer = Object.hasOwn(newerData, field);
    const olderValue = olderData[field];
    const newerValue = newerData[field];

    if (sameValue(olderValue, newerValue)) {
      unchanged += 1;
      continue;
    }

    if (NOISY_FIELDS.includes(field)) {
      ignoredFields.push(field);
      continue;
    }

    if (counted >= PROVENANCE_CAPS.diffFields) {
      truncated = true;
      continue;
    }
    counted += 1;

    if (!inOlder && inNewer) {
      added.push({ field, before: null, after: previewValue(newerValue) });
      continue;
    }
    if (inOlder && !inNewer) {
      removed.push({ field, before: previewValue(olderValue), after: null });
      continue;
    }
    changed.push({ field, before: previewValue(olderValue), after: previewValue(newerValue) });
  }

  const side = (row: (typeof rows)[number]): RevisionSide => ({
    id: row.id,
    version: row.version,
    at: row.createdAt.toISOString(),
    summary: row.summary,
    authorName: row.author?.name ?? null
  });

  return {
    ok: true,
    diff: {
      entityType: older.entityType,
      entityId: older.entityId,
      from: side(older),
      to: side(newer),
      added,
      removed,
      changed,
      unchanged,
      ignoredFields,
      cap: PROVENANCE_CAPS.diffFields,
      truncated
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The two searches the console needs
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface RecordSearchHit {
  entityType: string;
  entityId: string;
  label: string | null;
  labelWithheld: boolean;
  lastAction: AuditAction;
  lastChangeAt: string;
}

/**
 * Find a record by what it is called.
 *
 * ⚠ IT SEARCHES THE LOG, NOT THE TABLES, and that is the point: a record that has been purged still
 * has a history, and a history is exactly what somebody looking for it wants. The alternative —
 * searching fifteen content tables — would find only what still exists.
 *
 * DE-DUPLICATION IS DONE IN MEMORY, over the most recent `searchScan` matching entries. Prisma's
 * `distinct` is only pushed into SQL when the `orderBy` leads with the distinct columns, and here the
 * order that matters is "most recently touched" — so asking the database for `take: 25` distinct pairs
 * would silently return fewer than 25. `scanned` says how deep the search looked, so a reader who
 * cannot find something old knows to narrow the words rather than concluding it was never there.
 */
export async function searchRecords(
  q: string
): Promise<{ results: CappedList<RecordSearchHit>; scanned: number; scanCap: number }> {
  const term = q.trim();
  if (term.length === 0) {
    return {
      results: { items: [], total: 0, cap: PROVENANCE_CAPS.searchResults, truncated: false },
      scanned: 0,
      scanCap: PROVENANCE_CAPS.searchScan
    };
  }

  const rows = await prisma.auditLog.findMany({
    where: {
      entityId: { not: null },
      OR: [
        { entityLabel: { contains: term, mode: "insensitive" } },
        { entityId: term },
        { entityType: { contains: term, mode: "insensitive" } }
      ]
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PROVENANCE_CAPS.searchScan,
    select: {
      action: true,
      entityType: true,
      entityId: true,
      entityLabel: true,
      createdAt: true
    }
  });

  const seen = new Set<string>();
  const hits: RecordSearchHit[] = [];
  for (const row of rows) {
    if (!row.entityId) continue;
    const key = `${row.entityType}:${row.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({
      entityType: row.entityType,
      entityId: row.entityId,
      label: safeEntityLabel(row.entityType, row.entityLabel),
      labelWithheld: labelIsWithheld(row.entityType) && row.entityLabel !== null,
      lastAction: row.action,
      lastChangeAt: row.createdAt.toISOString()
    });
  }

  return {
    results: cappedByProbe(hits, PROVENANCE_CAPS.searchResults),
    scanned: rows.length,
    scanCap: PROVENANCE_CAPS.searchScan
  };
}

export interface PersonSearchHit {
  id: string;
  name: string;
  email: string;
  role: Role;
  isActive: boolean;
  twoFactorEnabled: boolean;
  lastLoginAt: string | null;
}

/**
 * Find a colleague.
 *
 * Only studio accounts, which is the only kind of person whose email address may appear on this screen
 * at all. Soft-deleted accounts ARE included — somebody whose account was removed last month is
 * precisely who an incident review is about — and `isActive` says which is which.
 */
export async function searchPeople(
  q: string
): Promise<{ results: CappedList<PersonSearchHit> }> {
  const term = q.trim();
  const where: Prisma.UserWhereInput =
    term.length > 0
      ? {
          OR: [
            { name: { contains: term, mode: "insensitive" } },
            { email: { contains: term, mode: "insensitive" } }
          ]
        }
      : {};

  const [rows, total] = await prisma.$transaction([
    prisma.user.findMany({
      where,
      // A total ordering, so the list never reshuffles between requests and reads as data changing.
      orderBy: [{ name: "asc" }, { email: "asc" }],
      take: PROVENANCE_CAPS.searchResults,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        twoFactorEnabled: true,
        lastLoginAt: true
      }
    }),
    prisma.user.count({ where })
  ]);

  return {
    results: capped(
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role,
        isActive: row.isActive,
        twoFactorEnabled: row.twoFactorEnabled,
        lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null
      })),
      PROVENANCE_CAPS.searchResults,
      total
    )
  };
}
