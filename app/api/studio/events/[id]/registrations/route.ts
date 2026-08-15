import { NextResponse } from "next/server";
import { z } from "zod";
// `Prisma` is imported as a VALUE, not merely as a type: `Prisma.sql` is the tagged template
// `$queryRaw` needs for the event row lock. See `lockEvent`.
import { Prisma, type RegistrationStatus } from "@prisma/client";

import { ApiError, assertSameOrigin, conflict, ok, route } from "@/lib/api";
import { mutateWithHistory, writeAudit, type AuditContext, type TxClient } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageContent } from "@/lib/permissions";
import {
  buildAuditContext,
  found,
  isUniqueViolation,
  isWriteConflict,
  listQuerySchema,
  optionalText,
  pageWindow,
  paginated,
  parseStudioJson,
  parseStudioQuery,
  requiredText,
  resolveSort,
  textSearchWhere
} from "@/lib/studio/crud";

/**
 * Who has registered for one event: the list, the export, adding somebody by hand, and changing state.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A PLACE IS HELD BY A CONFIRMED OR AN ATTENDED REGISTRATION, AND BY NOTHING ELSE.
 *
 * Pending has not claimed one, cancelled has given one back, waitlisted is by definition waiting for one.
 * `RegistrationsManager` counts places the same way and prints "34 of 60 places taken, 4 on the waiting
 * list" from it, so this handler MUST agree with that sentence or the screen and the server will refuse
 * things for reasons the numbers on screen do not explain.
 *
 * ⚠ THE PUBLIC REGISTRATION ROUTE COUNTS DIFFERENTLY, ON PURPOSE. It treats PENDING as holding a place too,
 * because it is deciding whether to promise a stranger a place and must not over-promise. This handler is
 * answering an organiser looking at a room, and a provisional registration nobody has confirmed does not
 * fill a seat. The two are different questions and the difference is deliberate.
 *
 * CAPACITY IS RE-CHECKED WHILE THE EVENT ROW IS LOCKED, on every write that can take a place. Two
 * administrators adding or confirming the last attendee at the same moment both read "58 of 60 taken", both
 * conclude there is room for three, and the room ends up with 64 people in it — a count followed by a write
 * is not safe at Postgres's default READ COMMITTED isolation, whatever it is wrapped in. `SELECT … FOR
 * UPDATE` on the EVENT row makes every such writer queue: the second one waits at the lock, and reads the
 * first one's registration when it gets through. See `lockEvent`.
 *
 * The state change also keeps its SERIALIZABLE isolation and its one retry. That is belt and braces on
 * purpose: Serializable's predicate checking protects a transaction only from OTHER Serializable
 * transactions, and the sibling handlers that move a single registration or a batch of them run at READ
 * COMMITTED with the row lock — so without taking the same lock this handler would be protected against
 * copies of itself and against nothing else.
 *
 * GOING OVER THE LIMIT IS ALLOWED, BUT ONLY DELIBERATELY. Rooms have real doors and organisers have real
 * judgement, so `allowOverCapacity` lets a batch through — and the refusal without it states the whole
 * arithmetic rather than saying "full". `expectedPlacesTaken` is the other half: if the numbers moved while
 * the organiser was deciding, the request is refused even WITH permission to overbook, because they agreed
 * to "63 in a room of 60" and not to whatever it has since become.
 *
 * THE EXPORT IS COMPLETE OR IT IS REFUSED. A spreadsheet that quietly stopped at a thousand rows is the
 * same bug class as a list that quietly stops (contract §1.6), and it is worse here because an attendance
 * list is used to let people into a building.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/** The states that occupy a place. See the header. */
const PLACE_HOLDING_STATES: readonly RegistrationStatus[] = ["CONFIRMED", "ATTENDED"];

const ALL_STATES = ["PENDING", "CONFIRMED", "WAITLISTED", "CANCELLED", "ATTENDED"] as const;

/** The most rows one export may contain. Beyond this the request is refused, never truncated. */
const MAX_EXPORT_ROWS = 20_000;

/** The most rows one state change may cover. A larger batch is a script, not an organiser. */
const MAX_BATCH = 200;

const SORTABLE = {
  createdAt: "createdAt",
  name: "name",
  email: "email",
  state: "state"
} as const;

const listSchema = listQuerySchema
  // `status` and `bin` belong to content with a publication state and a recycle bin. A registration has
  // neither, and leaving them in the schema would offer filters this route silently ignores.
  .omit({ status: true, bin: true })
  .extend({
    state: z.union([z.literal(""), z.enum(ALL_STATES)]).default(""),
    /** `csv` answers a spreadsheet with the same filters and no paging. */
    format: z.enum(["", "json", "csv"]).default("")
  });

const REGISTRATION_SELECT = {
  id: true,
  name: true,
  email: true,
  organisation: true,
  phone: true,
  notes: true,
  state: true,
  certificateCode: true,
  certificateIssuedAt: true,
  createdAt: true
} as const;

const stateChangeSchema = z.object({
  ids: z
    .array(z.string().trim().min(1, "An empty registration reference cannot be used.").max(40))
    .min(1, "Choose at least one registration to change.")
    .max(MAX_BATCH, `Change at most ${MAX_BATCH} registrations at a time.`),
  state: z.enum(ALL_STATES),
  /**
   * Confirm past the limit. The studio asks the organiser first and states the arithmetic; this is the
   * answer to that question travelling back.
   */
  allowOverCapacity: z.boolean().default(false),
  /**
   * How many places the organiser BELIEVED were taken when they decided. Optional, and worth sending: it
   * is what turns "two people confirming at once" from a silent overbooking into a question asked again.
   */
  expectedPlacesTaken: z.coerce.number().int().min(0).optional()
});

const manualRegistrationSchema = z.object({
  name: requiredText(120, "Enter the name that should appear on the attendance list."),
  email: z
    .string({ invalid_type_error: "Enter an email address." })
    .trim()
    .min(1, "Enter an email address — it is how this person is identified on the list.")
    .max(254)
    .email("That does not look like an email address. Check for a missing @ or a typo in the domain."),
  organisation: optionalText(160),
  phone: optionalText(40),
  notes: optionalText(1000),
  /** An organiser adding somebody by hand is normally giving them a place, so CONFIRMED is the default. */
  state: z.enum(ALL_STATES).default("CONFIRMED"),
  allowOverCapacity: z.boolean().default(false)
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (request: Request, context: RouteContext) => {
  // An attendance list is names, email addresses and telephone numbers. Reading it is an editor's job, not
  // something every signed-in viewer may do.
  await requireCapability(
    canManageContent,
    "Seeing who has registered needs editor access. An administrator can raise yours."
  );
  const { id } = await context.params;

  const query = parseStudioQuery(request, listSchema);
  const event = found(
    await prisma.coeEvent.findUnique({
      where: { id },
      select: { id: true, slug: true, title: true, capacity: true, startsAt: true }
    }),
    "That event"
  );

  const where: Record<string, unknown> = {
    eventId: event.id,
    ...(query.state === "" ? {} : { state: query.state }),
    ...textSearchWhere(query.q, ["name", "email", "organisation"])
  };

  const orderBy = resolveSort(query, SORTABLE, "createdAt");

  if (query.format === "csv") {
    const total = await prisma.eventRegistration.count({ where });
    if (total > MAX_EXPORT_ROWS) {
      throw conflict(
        `This selection covers ${total} registrations, which is more than the ${MAX_EXPORT_ROWS} one spreadsheet can carry. Filter by status and export each group in turn — a file that stopped part way would look complete and would not be.`
      );
    }

    const rows = await prisma.eventRegistration.findMany({
      where,
      orderBy,
      select: REGISTRATION_SELECT
    });

    return csvResponse(event.slug, rows);
  }

  const { page, pageSize, skip, take } = pageWindow(query);

  const [rows, total] = await prisma.$transaction([
    prisma.eventRegistration.findMany({ where, orderBy, skip, take, select: REGISTRATION_SELECT }),
    prisma.eventRegistration.count({ where })
  ]);

  // Every state's count for the WHOLE event, whatever the filters say: the capacity sentence has to be true
  // about the room, not about the current search.
  //
  // Read on its own rather than inside the `$transaction([...])` above, because the array form erases
  // `groupBy`'s return type — `_count` comes back as the INPUT type and `_count._all` stops existing. The
  // numbers are a summary of a table that anybody may be writing to, so a shared snapshot buys nothing.
  const grouped = await prisma.eventRegistration.groupBy({
    by: ["state"],
    where: { eventId: event.id },
    orderBy: { state: "asc" },
    _count: { _all: true }
  });

  // A total record seeded with zeros. `groupBy` returns rows only for states that occur, and a missing key
  // would render as "undefined on the waiting list".
  const counts: Record<RegistrationStatus, number> = {
    PENDING: 0,
    CONFIRMED: 0,
    WAITLISTED: 0,
    CANCELLED: 0,
    ATTENDED: 0
  };
  for (const entry of grouped) counts[entry.state] = entry._count._all;

  const placesTaken = PLACE_HOLDING_STATES.reduce((sum, state) => sum + counts[state], 0);

  return ok({
    ...paginated(rows, total, page, pageSize),
    event: { id: event.id, title: event.title, slug: event.slug, startsAt: event.startsAt },
    capacity: event.capacity,
    placesTaken,
    waiting: counts.WAITLISTED,
    counts,
    /** True when there are more places held than the room allows — it happens, and it is stated. */
    overCapacity: event.capacity !== null && placesTaken > event.capacity
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The event row lock
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hold the event row until this transaction ends, so every writer that changes the number of places held
 * queues behind whoever got there first.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY A LOCK AND NOT SIMPLY A CHECK. Counting the places taken and then inserting a registration are two
 * statements, and at READ COMMITTED each of them sees its own snapshot: a second transaction running
 * alongside is invisible until it commits. So two administrators adding the last attendee both count 59 of
 * 60, both insert, and the event is over capacity with nobody told. Putting both statements in one
 * transaction does not fix that — it is the isolation level, not the grouping, that decides what they can
 * see.
 *
 * `SELECT … FOR UPDATE` on the event makes the pair sequential: the second transaction blocks here until
 * the first commits, and its count then includes the row the first one wrote. The alternative is
 * SERIALIZABLE plus a retry loop, which works but needs every caller to recognise a serialisation failure
 * and repeat the whole request; the lock needs no retry handling at all, and it also serialises against
 * READ COMMITTED writers, which Serializable does not.
 *
 * ⚠ A THIRD VERBATIM COPY of the helper in `bulk/route.ts` and `[registrationId]/route.ts`, rather than a
 * shared function, because a `route.ts` may only export its handlers and its route config — Next's
 * generated type check refuses anything else — so there is nowhere to put a shared helper without adding a
 * module outside these three files. The three copies must stay identical: one writer that does not take the
 * lock removes the guarantee for all of them.
 *
 * `"events"` is `CoeEvent`'s table (`@@map`), and the model is named that way because `Event` is a DOM
 * global.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function lockEvent(tx: TxClient, eventId: string): Promise<void> {
  const locked = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT "id" FROM "events" WHERE "id" = ${eventId} FOR UPDATE`
  );
  // `FOR UPDATE` on a row that is not there locks nothing and returns nothing. The only way that happens is
  // a concurrent delete of the whole event, and writing a registration to it would leave a row nobody can
  // reach.
  if (locked.length === 0) {
    throw conflict(
      "This event was removed while the change was being made, so nothing has been changed. Reload the events list."
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Adding somebody by hand
// ─────────────────────────────────────────────────────────────────────────────

export const POST = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);
  const user = await requireCapability(
    canManageContent,
    "Adding a registration needs editor access. An administrator can raise yours."
  );
  const { id } = await context.params;

  const body = await parseStudioJson(request, manualRegistrationSchema);

  // No `capacity` here on purpose: the number that decides the answer is read inside the lock below, where
  // it cannot change under the decision. Reading it twice would invite the wrong copy being used.
  const event = found(
    await prisma.coeEvent.findUnique({
      where: { id },
      select: { id: true, title: true, deletedAt: true }
    }),
    "That event"
  );
  if (event.deletedAt) {
    throw conflict("This event is in the recycle bin. Restore it before adding registrations to it.");
  }

  // Lower-cased for the unique index, exactly as the public route does it. Without this
  // "A@example.org" and "a@example.org" are two registrations for one person.
  const email = body.email.toLowerCase();

  const context_ = buildAuditContext(request, user);
  const takesPlace = PLACE_HOLDING_STATES.includes(body.state);

  try {
    const created = await mutateWithHistory<{ id: string; state: RegistrationStatus }>(
      context_,
      {
        action: "CREATE",
        entityType: "EventRegistration",
        entityLabel: `${body.name} <${email}> — ${event.title}`,
        // Registrations are not versioned content: there is no editor screen that would restore one, and a
        // revision of an attendance row would only duplicate the audit entry beside it.
        revise: false
      },
      async (tx) => {
        // ⚠ FIRST STATEMENT IN THE TRANSACTION, and it is what makes the count below mean anything. See
        // `lockEvent`. Taken whatever state is being written, not only for the ones that take a place, so
        // that every writer touching this event's list queues in one place — a writer that skipped the lock
        // would be invisible to the ones that take it.
        await lockEvent(tx, event.id);

        // The capacity is re-read INSIDE the lock rather than taken from the copy read before the
        // transaction. An organiser may have raised the limit in another tab in the meantime, and a refusal
        // quoting a number nobody can see any more sends them looking for a fault that is not there.
        // Nothing can change it between here and the commit, because the lock holds the row.
        const current = found(
          await tx.coeEvent.findUnique({
            where: { id: event.id },
            select: { capacity: true, deletedAt: true }
          }),
          "That event"
        );
        if (current.deletedAt) {
          throw conflict(
            "This event was moved to the recycle bin while the registration was being added, so nobody has been added. Restore it first."
          );
        }

        if (takesPlace && current.capacity !== null && !body.allowOverCapacity) {
          const held = await tx.eventRegistration.count({
            where: { eventId: event.id, state: { in: [...PLACE_HOLDING_STATES] } }
          });
          if (held + 1 > current.capacity) {
            throw conflict(
              `${event.title} holds ${current.capacity} ${current.capacity === 1 ? "person" : "people"} and ${held} ${held === 1 ? "place is" : "places are"} already taken, so adding another would go over the limit. Add them to the waiting list, raise the capacity, or say that going over is intended.`
            );
          }
        }

        return tx.eventRegistration.create({
          data: {
            eventId: event.id,
            name: body.name,
            email,
            organisation: body.organisation,
            phone: body.phone,
            notes: body.notes,
            state: body.state
          },
          select: { id: true, state: true, name: true, email: true, createdAt: true }
        });
      }
    );

    return ok({ registration: created }, { status: 201 });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await prisma.eventRegistration.findUnique({
        where: { eventId_email: { eventId: event.id, email } },
        select: { state: true, name: true }
      });
      throw conflict(
        existing
          ? `${existing.name} is already on this event's list with the address ${email}, marked ${STATE_WORDS[existing.state]}. Change that registration instead of adding a second one.`
          : `There is already a registration against ${email} for this event.`
      );
    }
    throw error;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Changing state, one row or forty
// ─────────────────────────────────────────────────────────────────────────────

export const PATCH = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);
  const user = await requireCapability(
    canManageContent,
    "Changing a registration needs editor access. An administrator can raise yours."
  );
  const { id } = await context.params;

  const body = await parseStudioJson(request, stateChangeSchema);
  const ids = [...new Set(body.ids)];

  // As in POST: no `capacity` here, because the copy that decides is the one read inside the lock.
  const event = found(
    await prisma.coeEvent.findUnique({
      where: { id },
      select: { id: true, title: true }
    }),
    "That event"
  );

  const auditContext = buildAuditContext(request, user);

  try {
    const result = await applyStates({
      event,
      ids,
      state: body.state,
      allowOverCapacity: body.allowOverCapacity,
      expectedPlacesTaken: body.expectedPlacesTaken,
      context: auditContext
    });
    return ok(result);
  } catch (error) {
    // Two organisers took the last places at the same moment and Postgres refused to let both through. One
    // retry, after a short random pause so the two do not collide again in lockstep.
    if (!isWriteConflict(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 40 + Math.floor(Math.random() * 60)));
    try {
      const result = await applyStates({
        event,
        ids,
        state: body.state,
        allowOverCapacity: body.allowOverCapacity,
        expectedPlacesTaken: body.expectedPlacesTaken,
        context: auditContext
      });
      return ok(result);
    } catch (retryError) {
      if (!isWriteConflict(retryError)) throw retryError;
      throw new ApiError(
        409,
        "Several people were changing this event's registrations at the same moment, so the change could not be settled. Nothing has been changed — send it again and it will go through.",
        { code: "write_conflict" }
      );
    }
  }
});

interface StateChangeResult {
  changed: number;
  state: RegistrationStatus;
  capacity: number | null;
  placesTaken: number;
  overCapacity: boolean;
  /** Things the organiser should know that are not failures. Rendered as they are. */
  warnings: string[];
}

/**
 * Re-count the room, then move the rows — atomically.
 *
 * ⚠ THE EVENT ROW LOCK IS LOAD-BEARING, and Serializable on its own was not enough. At READ COMMITTED two
 * concurrent confirmations each read a count that does not include the other's rows; Serializable turns
 * that pair into a serialisation failure, but ONLY when both sides are Serializable. The handlers next door
 * — one registration, and a batch — run at READ COMMITTED holding a lock on the event, so this transaction
 * takes the same lock. Both mechanisms are kept: the lock is what makes it safe against those two, and
 * Serializable with the retry above is what it was already relied upon for.
 */
async function applyStates(input: {
  /** No `capacity`: the limit is read inside the lock, so a caller cannot pass a stale one in. */
  event: { id: string; title: string };
  ids: readonly string[];
  state: RegistrationStatus;
  allowOverCapacity: boolean;
  expectedPlacesTaken: number | undefined;
  context: AuditContext;
}): Promise<StateChangeResult> {
  const { event, ids, state } = input;
  const takesPlace = PLACE_HOLDING_STATES.includes(state);

  return prisma.$transaction(
    async (tx) => {
      // First, and in the same order as every other writer, so two of them can never deadlock each other.
      await lockEvent(tx, event.id);

      // The limit as it is NOW, read while the row is held, for the same reason the manual add re-reads it:
      // an organiser may have raised it since this request's first read, and every sentence below quotes the
      // number. `input.event.capacity` is deliberately not used past this point.
      const eventNow = found(
        await tx.coeEvent.findUnique({ where: { id: event.id }, select: { capacity: true } }),
        "That event"
      );
      const capacity = eventNow.capacity;

      const targets = await tx.eventRegistration.findMany({
        where: { id: { in: [...ids] }, eventId: event.id },
        select: {
          id: true,
          name: true,
          email: true,
          state: true,
          certificateCode: true
        }
      });

      // An id that is not on this event's list is a stale screen, and moving on regardless would report a
      // success for rows that were never touched.
      if (targets.length !== ids.length) {
        throw conflict(
          `${ids.length - targets.length} of the ${ids.length} registrations chosen are no longer on this event's list. Reload the page and try again — nothing has been changed.`
        );
      }

      const heldNow = await tx.eventRegistration.count({
        where: { eventId: event.id, state: { in: [...PLACE_HOLDING_STATES] } }
      });

      if (input.expectedPlacesTaken !== undefined && input.expectedPlacesTaken !== heldNow) {
        throw conflict(
          `The numbers changed while this was being decided: ${heldNow} ${heldNow === 1 ? "place is" : "places are"} now taken, not ${input.expectedPlacesTaken}. Nothing has been changed — look again and repeat it if you still want to.`
        );
      }

      // The rows being moved are taken out of the count first, so a registration that already holds a place
      // is not counted twice when it is confirmed again.
      const alreadyHolding = targets.filter((row) => PLACE_HOLDING_STATES.includes(row.state)).length;
      const heldExcludingTargets = heldNow - alreadyHolding;
      const placesAfter = heldExcludingTargets + (takesPlace ? targets.length : 0);

      if (takesPlace && capacity !== null && placesAfter > capacity && !input.allowOverCapacity) {
        const over = placesAfter - capacity;
        throw conflict(
          `${event.title} has ${capacity} ${capacity === 1 ? "place" : "places"} and ${heldExcludingTargets} ${heldExcludingTargets === 1 ? "is" : "are"} taken. This would make it ${placesAfter} — ${over} over the limit. Put some of them on the waiting list, raise the capacity, or confirm that going over is intended.`
        );
      }

      const updated = await tx.eventRegistration.updateMany({
        where: { id: { in: targets.map((row) => row.id) }, eventId: event.id },
        data: { state }
      });

      // ONE audit entry per registration, inside this transaction.
      //
      // `mutateWithHistory()` opens a transaction per entity, which is right for a single row and wrong for
      // a batch: forty transactions for one intention, with no way to report afterwards that twelve
      // succeeded and twenty-eight did not. `writeAudit` on this transaction keeps the guarantee that
      // matters — the change and its log cannot exist without each other — at the granularity that matters,
      // which is per person, because "who cancelled MY registration" is the question the log is read for.
      for (const row of targets) {
        if (row.state === state) continue;
        await writeAudit(tx, input.context, {
          action: "UPDATE",
          entityType: "EventRegistration",
          entityId: row.id,
          entityLabel: `${row.name} <${row.email}> — ${event.title}`,
          before: { state: row.state },
          after: {
            state,
            batchOf: targets.length,
            capacity,
            placesTakenAfter: placesAfter,
            overCapacityAllowed: input.allowOverCapacity && placesAfter > (capacity ?? Infinity)
          }
        });
      }

      const warnings: string[] = [];
      const withCertificates = targets.filter(
        (row) => row.certificateCode !== null && row.state === "ATTENDED" && state !== "ATTENDED"
      );
      if (withCertificates.length > 0) {
        // Not a refusal: an organiser correcting a mistake must not be stranded. But a certificate that has
        // been issued stays verifiable, and saying nothing would leave a document nobody remembers exists.
        warnings.push(
          withCertificates.length === 1
            ? `${withCertificates[0]?.name} has already been issued a certificate for this event. It remains valid and can still be checked with its code, even though they are no longer marked as having attended.`
            : `${withCertificates.length} of these people have already been issued certificates. Those remain valid and can still be checked with their codes, even though they are no longer marked as having attended.`
        );
      }
      if (takesPlace && capacity !== null && placesAfter > capacity) {
        warnings.push(
          `There are now ${placesAfter} places taken against a limit of ${capacity}. Nobody is stopped from attending by this number; it only decides who the site puts on the waiting list.`
        );
      }

      return {
        changed: updated.count,
        state,
        capacity,
        placesTaken: placesAfter,
        overCapacity: capacity !== null && placesAfter > capacity,
        warnings
      };
    },
    { isolationLevel: "Serializable" }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The spreadsheet
// ─────────────────────────────────────────────────────────────────────────────

/** Plain words for a state. Never the enum name — a spreadsheet is read by people. */
const STATE_WORDS: Record<RegistrationStatus, string> = {
  PENDING: "pending",
  CONFIRMED: "confirmed",
  WAITLISTED: "waitlisted",
  CANCELLED: "cancelled",
  ATTENDED: "attended"
};

/**
 * The UTF-8 byte-order mark, built from its code point rather than typed.
 *
 * Without it Excel opens a CSV as the system code page and reads any name containing a non-ASCII letter as
 * mojibake — and an attendance list is exactly where those live. Written as a literal it would be an
 * invisible character at the start of a string that nobody could see in review and that a stray "tidy the
 * whitespace" edit would silently remove. (`RegistrationsManager` carries the same constant for the export
 * it builds in the browser.)
 */
const UTF8_BOM = String.fromCharCode(0xfeff);

/**
 * One CSV cell.
 *
 * ⚠ THE LEADING-CHARACTER GUARD IS NOT COSMETIC. A cell that begins with `=`, `+`, `-`, `@`, a tab or a
 * carriage return is treated by Excel, Numbers and Sheets as a FORMULA, so a registration typed as
 * `=HYPERLINK("http://…","Click")` becomes a live link in the organiser's spreadsheet — and worse things
 * are possible. Prefixing an apostrophe makes the spreadsheet show the text exactly as it was typed. The
 * apostrophe is only added where it is needed, so an ordinary name is untouched.
 */
function cell(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = value instanceof Date ? value.toISOString() : String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}

function csvResponse(
  slug: string,
  rows: ReadonlyArray<{
    name: string;
    email: string;
    organisation: string | null;
    phone: string | null;
    notes: string | null;
    state: RegistrationStatus;
    certificateCode: string | null;
    certificateIssuedAt: Date | null;
    createdAt: Date;
  }>
): NextResponse {
  const header = [
    "Name",
    "Email",
    "Organisation",
    "Telephone",
    "Status",
    "Registered (UTC)",
    "Certificate code",
    "Certificate issued (UTC)",
    "Notes"
  ];

  const lines = [
    header.map((label) => cell(label)).join(","),
    ...rows.map((row) =>
      [
        cell(row.name),
        cell(row.email),
        cell(row.organisation),
        cell(row.phone),
        cell(STATE_WORDS[row.state]),
        // ISO 8601, in UTC, and the column says so. A bare "14:30" between two people in different cities
        // is a time they will disagree about, and a spreadsheet has nowhere to explain itself.
        cell(row.createdAt),
        cell(row.certificateCode),
        cell(row.certificateIssuedAt),
        cell(row.notes)
      ].join(",")
    )
  ];

  // CRLF, which is what every spreadsheet on Windows expects and what RFC 4180 specifies.
  const csv = `${UTF8_BOM}${lines.join("\r\n")}\r\n`;
  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="registrations-${slug}-${stamp}.csv"`,
      // An attendance list is personal data. It must never sit in a shared cache.
      "cache-control": "no-store"
    }
  });
}
