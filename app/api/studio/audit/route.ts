import type { NextRequest } from "next/server";
import { z } from "zod";
import type { AuditAction, Prisma } from "@prisma/client";
import { badRequest, ok, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canViewAuditLog } from "@/lib/permissions";
import { parseStudioQuery } from "@/lib/studio/crud";

/**
 * The audit log, read-only.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * READ-ONLY, AND THERE IS NO WRITE HANDLER IN THIS FILE BY DESIGN.
 *
 * The log is written only by `lib/audit.ts`, inside the same transaction as the change it describes. An
 * endpoint that could add an entry would be an endpoint that could add a FALSE entry, and an endpoint that
 * could remove one would make the whole log worthless — the only time anybody reads it is when something has
 * gone wrong and somebody's account of events is in question. Entries age out with the database and nothing
 * else touches them.
 *
 * `requireCapability(canViewAuditLog)` — administrator only, and the reason is the CONTENT rather than the
 * metadata. `before` and `after` hold the full serialised entity, so the log holds the text of unpublished
 * work and the email address of everybody who has ever signed in. Passwords, TOTP secrets and recovery codes
 * are stripped by NAME before they get there (`redact()`); everything else is in it in full.
 *
 * ⚠ THE PAYLOADS ARE SUMMARISED, NOT SENT WHOLE, and the cut is reported per entry. Forty entries each
 * carrying two complete snapshots of a page with twenty blocks is several megabytes for a screen that shows
 * a list of headlines. `changedFields` names what differs and `payloadOmitted` says the values are not here —
 * a client that needs them asks for one entry with `?id=`.
 *
 * EVERY CAP IS REPORTED. `truncated` for the page, `filterOptionsTruncated` for the two filter lists. A list
 * that quietly stops is indistinguishable from a place with only that many records — the most repeated bug
 * class this contract exists to prevent (§1.6).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 40;
const MAX_PAGE_SIZE = 100;

/**
 * How deep the paging goes.
 *
 * `skip` over a large offset costs the same as reading everything before it, and an operator who is 200
 * pages into the log wants the date filter rather than the Next button. The refusal says so.
 */
const MAX_PAGE = 200;

/** How many distinct actors and entity types the filter lists offer. Reported when it bites. */
const FILTER_OPTION_LIMIT = 60;

/** How much of one value a summarised payload carries when a single entry is asked for. */
const VALUE_LIMIT = 2000;

const ACTIONS = [
  "CREATE",
  "UPDATE",
  "DELETE",
  "RESTORE",
  "PUBLISH",
  "UNPUBLISH",
  "ARCHIVE",
  "LOGIN",
  "LOGIN_FAILED",
  "LOGOUT",
  "PERMISSION_CHANGE",
  "UPLOAD",
  "PURGE",
  "ROLLBACK"
] as const;

/** Columns that change on every save and mean nothing on their own. */
const NOISY_FIELDS: readonly string[] = ["id", "createdAt", "updatedAt"];

const ListQuery = z.object({
  /** One entry in full, by id. Everything else is ignored when this is given. */
  id: z.string().trim().max(64).optional(),
  q: z.string().trim().max(200).optional(),
  actor: z.string().trim().max(64).optional(),
  action: z.string().trim().max(40).optional(),
  entityType: z.string().trim().max(80).optional(),
  entityId: z.string().trim().max(64).optional(),
  /** `YYYY-MM-DD`, read as UTC — the log stores instants and this is how it is bucketed. */
  from: z.string().trim().max(24).optional(),
  to: z.string().trim().max(24).optional(),
  page: z
    .string()
    .trim()
    .regex(/^\d{1,4}$/, "The page must be a whole number.")
    .optional(),
  pageSize: z
    .string()
    .trim()
    .regex(/^\d{1,3}$/, "The page size must be a whole number.")
    .optional()
});

function isAction(value: string): value is AuditAction {
  return (ACTIONS as readonly string[]).includes(value);
}

/**
 * `YYYY-MM-DD` → the UTC instant that starts that day.
 *
 * `new Date("2026-03-01")` is parsed as UTC by the specification, which is what makes a date filter mean the
 * same thing wherever the server happens to be running.
 */
function dayStart(value: string | undefined): Date | null {
  if (!value || value.trim().length === 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The END of the chosen day, so "to 4 March" includes everything that happened on the 4th. */
function dayEnd(value: string | undefined): Date | null {
  const start = dayStart(value);
  if (!start) return null;
  return new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
}

function asRecord(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    // A value that will not serialise cannot be compared, and calling it unchanged would hide a change.
    return false;
  }
}

/** Which columns actually differ between the two snapshots, ignoring the ones that always do. */
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

/** One value, cut to a readable length, with the cut stated rather than implied. */
function summariseValue(value: unknown): { value: unknown; truncated: boolean } {
  if (typeof value === "string" && value.length > VALUE_LIMIT) {
    return { value: value.slice(0, VALUE_LIMIT), truncated: true };
  }
  if (value !== null && typeof value === "object") {
    let serialised: string;
    try {
      serialised = JSON.stringify(value) ?? "";
    } catch {
      return { value: "(this value cannot be shown)", truncated: false };
    }
    if (serialised.length > VALUE_LIMIT) {
      return { value: `${serialised.slice(0, VALUE_LIMIT)}…`, truncated: true };
    }
  }
  return { value, truncated: false };
}

export const GET = route(async (request: NextRequest) => {
  await requireCapability(
    canViewAuditLog,
    "The audit log needs administrator access. Ask an administrator to look it up for you."
  );

  const query = parseStudioQuery(request, ListQuery);

  // ── One entry, in full ──────────────────────────────────────────────────────────────────────────
  if (query.id) {
    const entry = await prisma.auditLog.findUnique({
      where: { id: query.id },
      include: { actor: { select: { id: true, name: true, email: true } } }
    });
    if (!entry) {
      // A 200 with `entry: null` rather than a 404: the caller asked for a row that may legitimately have
      // aged out, and "that address does not exist" would send an operator looking for a routing fault.
      return ok({ entry: null, message: "That audit entry no longer exists." });
    }

    const before = asRecord(entry.before);
    const after = asRecord(entry.after);
    const fields = changedFields(before, after);

    /** Per-field, so a screen can show a diff without carrying two whole entities. */
    const diff = fields.map((field) => {
      const left = summariseValue(before?.[field]);
      const right = summariseValue(after?.[field]);
      return {
        field,
        before: left.value,
        after: right.value,
        beforeTruncated: left.truncated,
        afterTruncated: right.truncated
      };
    });

    return ok({
      entry: {
        id: entry.id,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        entityLabel: entry.entityLabel,
        actor: entry.actor,
        actorEmail: entry.actorEmail,
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
        createdAt: entry.createdAt,
        changedFields: fields,
        diff,
        /**
         * True when this kind of entry records no before and after at all — a sign-in, a sign-out. Said as a
         * fact rather than left as two empty objects a client would render as "nothing changed".
         */
        isEvent: before === null && after === null
      }
    });
  }

  // ── A page of the log ───────────────────────────────────────────────────────────────────────────
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, query.pageSize ? Number.parseInt(query.pageSize, 10) : DEFAULT_PAGE_SIZE)
  );
  const requestedPage = query.page ? Number.parseInt(query.page, 10) : 1;
  if (requestedPage > MAX_PAGE) {
    throw badRequest(
      `The log can be paged to ${MAX_PAGE} pages at a time. Narrow the dates, the person or the kind of ` +
        "record to reach older entries — reading past this point costs the same as reading everything before it."
    );
  }
  const page = Math.max(1, requestedPage);

  const action = query.action ?? "";
  if (action.length > 0 && !isAction(action)) {
    // Refused rather than ignored: a misspelled action would show the WHOLE log while the reader believed
    // they were looking only at deletions.
    throw badRequest(
      `There is no recorded action called “${action}”. The actions this log holds are: ${ACTIONS.join(", ")}.`
    );
  }

  const from = dayStart(query.from);
  const to = dayEnd(query.to);
  if ((query.from && !from) || (query.to && !to)) {
    throw badRequest("A date has to be written as YYYY-MM-DD, for example 2026-03-04.");
  }
  if (from && to && from.getTime() > to.getTime()) {
    // Refused rather than swapped. On a screen a transposed range is a typo worth forgiving; over an API it
    // is a caller with a bug, and silently answering a different question than the one asked is worse.
    throw badRequest("The first date is after the second one, so there is nothing to show. Swap them.");
  }

  const createdAt: Prisma.DateTimeFilter = {};
  if (from) createdAt.gte = from;
  if (to) createdAt.lte = to;

  const q = query.q ?? "";
  const where: Prisma.AuditLogWhereInput = {
    ...(query.actor && query.actor.length > 0 ? { actorId: query.actor } : {}),
    ...(action.length > 0 ? { action: action as AuditAction } : {}),
    ...(query.entityType && query.entityType.length > 0 ? { entityType: query.entityType } : {}),
    ...(query.entityId && query.entityId.length > 0 ? { entityId: query.entityId } : {}),
    ...(from || to ? { createdAt } : {}),
    ...(q.length > 0
      ? {
          OR: [
            { entityLabel: { contains: q, mode: "insensitive" } },
            { entityId: { contains: q, mode: "insensitive" } },
            { actorEmail: { contains: q, mode: "insensitive" } }
          ]
        }
      : {})
  };

  const [entries, total, actorRows, typeRows] = await prisma.$transaction([
    prisma.auditLog.findMany({
      where,
      // Newest first, with the id as the tiebreak so two entries written in the same millisecond keep a
      // stable order between requests — without it one entry can appear on two pages and another on none.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { actor: { select: { id: true, name: true, email: true } } }
    }),
    prisma.auditLog.count({ where }),
    prisma.user.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, email: true },
      orderBy: [{ name: "asc" }, { email: "asc" }],
      take: FILTER_OPTION_LIMIT
    }),
    prisma.auditLog.findMany({
      select: { entityType: true },
      distinct: ["entityType"],
      orderBy: { entityType: "asc" },
      take: FILTER_OPTION_LIMIT
    })
  ]);

  return ok({
    items: entries.map((entry) => {
      const before = asRecord(entry.before);
      const after = asRecord(entry.after);
      const fields = changedFields(before, after);
      return {
        id: entry.id,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        entityLabel: entry.entityLabel,
        actor: entry.actor,
        /** Denormalised on the row, so a deleted account does not erase who did it. */
        actorEmail: entry.actorEmail,
        ipAddress: entry.ipAddress,
        createdAt: entry.createdAt,
        changedFields: fields,
        isEvent: before === null && after === null,
        /**
         * ⚠ SAID OUT LOUD. The values are deliberately absent from a list answer — see the header. A client
         * that rendered "nothing changed" from their absence would be wrong about every entry.
         */
        payloadOmitted: before !== null || after !== null
      };
    }),
    total,
    page,
    pageSize,
    truncated: page * pageSize < total,
    /** So a client can offer only the filters that would actually match something. */
    actors: actorRows,
    entityTypes: typeRows.map((row) => row.entityType),
    filterOptionsTruncated:
      actorRows.length >= FILTER_OPTION_LIMIT || typeRows.length >= FILTER_OPTION_LIMIT,
    filterOptionLimit: FILTER_OPTION_LIMIT,
    actions: ACTIONS,
    note:
      "Each entry says which fields changed. Ask for one entry with ?id= to see the values — a page of full " +
      "before-and-after snapshots would be several megabytes."
  });
});
