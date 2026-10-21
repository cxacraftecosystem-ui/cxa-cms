import { Prisma, type RegistrationStatus } from "@prisma/client";

import { conflict } from "@/lib/api";
import { writeAuditMany, type AuditContext, type AuditInput, type TxClient } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { found } from "@/lib/studio/crud";

/**
 * The writes behind the event-registration routes that change the number of places held.
 *
 * Here rather than in the `route.ts` files because a route file may export only its handlers and its route
 * config (Next's generated type check refuses anything else), and these are shared — `lockEvent` by all
 * three writers — and exercised directly by tests/perf/query-counts.db.test.ts, which pins how many
 * statements a batch costs.
 */

/** The states that occupy a place. The screen and every registration route count places the same way. */
export const PLACE_HOLDING_STATES: readonly RegistrationStatus[] = ["CONFIRMED", "ATTENDED"];

/** Plain words for a state. Never the enum name — every one of these reaches a reader. */
export const STATE_WORDS: Record<RegistrationStatus, string> = {
  PENDING: "pending",
  CONFIRMED: "confirmed",
  WAITLISTED: "waitlisted",
  CANCELLED: "cancelled",
  ATTENDED: "attended"
};

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
 * ⚠ EVERY WRITER OF A REGISTRATION TAKES IT, and they all take THIS one. The collection route, the batch
 * route and the single-registration route used to carry three verbatim copies (a `route.ts` may export only
 * its handlers); they import it from here now. One writer that does not take the lock removes the guarantee
 * for all of them.
 *
 * `"events"` is `CoeEvent`'s table (`@@map`), and the model is named that way because `Event` is a DOM
 * global.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function lockEvent(tx: TxClient, eventId: string): Promise<void> {
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
// A batch moved to one state, row by row (the batch route)
// ─────────────────────────────────────────────────────────────────────────────

const REGISTRATION_SELECT = {
  id: true,
  name: true,
  email: true,
  state: true,
  certificateCode: true
} as const;

export interface RowOutcome {
  id: string;
  /** The person, where the row was found. Null for an id that is no longer on this event's list. */
  name: string | null;
  from: RegistrationStatus | null;
  /** A sentence, ready to render. */
  message: string;
}

export interface BatchResult {
  state: RegistrationStatus;
  changed: number;
  /** Rows that were already in the state asked for. Not a failure. */
  unchanged: RowOutcome[];
  /** Rows that could not be moved, each with the reason. */
  failed: RowOutcome[];
  capacity: number | null;
  placesTaken: number;
  overCapacity: boolean;
  warnings: string[];
}

/**
 * Walk the rows in order, inside one transaction, collecting an outcome for every one of them.
 *
 * The DECISIONS are made row by row, because the capacity arithmetic is per row: the fifty-ninth
 * confirmation in a room of sixty is allowed and the sixty-first is the one to report, and a set-based
 * update cannot tell them apart or say which rows it left behind. The WRITES are not: every row that is
 * allowed moves to the same state, so they go out after the walk as one `UPDATE … WHERE id IN (…)` and one
 * multi-row audit INSERT — two statements for a batch of two hundred rather than four hundred, inside a
 * transaction that is holding the event's lock while it runs.
 */
export async function applyRegistrationBatch(input: {
  event: { id: string; title: string; capacity: number | null };
  ids: readonly string[];
  state: RegistrationStatus;
  body: { allowOverCapacity: boolean; expectedPlacesTaken?: number | undefined };
  context: AuditContext;
}): Promise<BatchResult> {
  const { event, ids, state, body } = input;
  const takesPlace = PLACE_HOLDING_STATES.includes(state);

  return prisma.$transaction(async (tx) => {
    await lockEvent(tx, event.id);

    const targets = await tx.eventRegistration.findMany({
      where: { id: { in: [...ids] }, eventId: event.id },
      select: REGISTRATION_SELECT
    });
    const byId = new Map(targets.map((row) => [row.id, row]));

    /** How many places are held right now, across the whole event. Read under the lock. */
    let placesTaken = await tx.eventRegistration.count({
      where: { eventId: event.id, state: { in: [...PLACE_HOLDING_STATES] } }
    });

    if (body.expectedPlacesTaken !== undefined && body.expectedPlacesTaken !== placesTaken) {
      throw conflict(
        `The numbers changed while this was being decided: ${placesTaken} ${placesTaken === 1 ? "place is" : "places are"} now taken, not ${body.expectedPlacesTaken}. Nothing has been changed — look again and repeat it if you still want to.`
      );
    }

    const unchanged: RowOutcome[] = [];
    const failed: RowOutcome[] = [];
    const withCertificates: string[] = [];
    const movedIds: string[] = [];
    const entries: AuditInput[] = [];
    let changed = 0;

    for (const rowId of ids) {
      const row = byId.get(rowId);

      if (!row) {
        // A stale screen: the registration was deleted, or belongs to another event. Reported per row rather
        // than abandoning the batch, so one bad id does not cost an organiser thirty-nine good ones.
        failed.push({
          id: rowId,
          name: null,
          from: null,
          message:
            "This registration is no longer on this event's list, so it has been left alone. Reload the page to see the list as it is now."
        });
        continue;
      }

      if (row.state === state) {
        unchanged.push({
          id: row.id,
          name: row.name,
          from: row.state,
          message: `${row.name} was already marked ${STATE_WORDS[state]}.`
        });
        continue;
      }

      const wasHolding = PLACE_HOLDING_STATES.includes(row.state);

      // Only an allocation is capacity-checked. Marking somebody ATTENDED records a fact — they were in the
      // room — and refusing to record it would make the attendance list a worse record of what happened.
      if (
        state === "CONFIRMED" &&
        !wasHolding &&
        event.capacity !== null &&
        placesTaken + 1 > event.capacity &&
        !body.allowOverCapacity
      ) {
        failed.push({
          id: row.id,
          name: row.name,
          from: row.state,
          message: `${row.name} has been left as they are: ${placesTaken} of the ${event.capacity} ${event.capacity === 1 ? "place" : "places"} are taken, so confirming them would go over the limit.`
        });
        continue;
      }

      movedIds.push(row.id);
      changed += 1;

      if (wasHolding && !takesPlace) placesTaken -= 1;
      if (!wasHolding && takesPlace) placesTaken += 1;

      if (row.certificateCode !== null && row.state === "ATTENDED" && state !== "ATTENDED") {
        withCertificates.push(row.name);
      }

      // One entry per person, on THIS transaction, written with the others once the walk is done. See the
      // batch route's header for why this is not `mutateWithHistory`.
      entries.push({
        action: "UPDATE",
        entityType: "EventRegistration",
        entityId: row.id,
        entityLabel: `${row.name} <${row.email}> — ${event.title}`,
        before: { state: row.state },
        after: {
          state,
          batchOf: ids.length,
          capacity: event.capacity,
          placesTakenAfter: placesTaken,
          overCapacityAllowed:
            body.allowOverCapacity && event.capacity !== null && placesTaken > event.capacity
        }
      });
    }

    if (movedIds.length > 0) {
      const moved = await tx.eventRegistration.updateMany({
        where: { id: { in: movedIds }, eventId: event.id },
        data: { state }
      });
      // Every row was read inside this transaction, under the event lock that every writer of a registration
      // takes, so a shortfall means something bypassed the lock. Refused rather than reported as done:
      // throwing rolls the whole batch back, as the per-row update this replaces did.
      if (moved.count !== movedIds.length) {
        throw conflict(
          "Some of these registrations changed while this was being saved, so nothing has been changed. Reload the page and try again."
        );
      }
    }
    await writeAuditMany(tx, input.context, entries);

    const warnings: string[] = [];

    if (withCertificates.length === 1 && withCertificates[0]) {
      // Not a refusal: an organiser correcting a mistake must not be stranded. But a certificate that has
      // been issued stays verifiable, and saying nothing leaves a document nobody remembers exists.
      warnings.push(
        `${withCertificates[0]} has already been issued a certificate for this event. It stays valid and can still be checked with its code, even though they are no longer marked as having attended.`
      );
    } else if (withCertificates.length > 1) {
      warnings.push(
        `${withCertificates.length} of these people have already been issued certificates. Those stay valid and can still be checked with their codes, even though they are no longer marked as having attended.`
      );
    }

    if (event.capacity !== null && placesTaken > event.capacity) {
      warnings.push(
        `There are now ${placesTaken} places taken against a limit of ${event.capacity}. Nobody is stopped from attending by this number; it only decides who the site puts on the waiting list.`
      );
    }

    return {
      state,
      changed,
      unchanged,
      failed,
      capacity: event.capacity,
      placesTaken,
      overCapacity: event.capacity !== null && placesTaken > event.capacity,
      warnings
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// A set moved to one state, all or nothing (the collection route's PATCH)
// ─────────────────────────────────────────────────────────────────────────────

export interface StateChangeResult {
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
export async function applyRegistrationStates(input: {
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
      // succeeded and twenty-eight did not. `writeAuditMany` on this transaction keeps the guarantee that
      // matters — the change and its log cannot exist without each other — at the granularity that matters,
      // which is per person, because "who cancelled MY registration" is the question the log is read for.
      // One multi-row INSERT, not a statement per person.
      await writeAuditMany(
        tx,
        input.context,
        targets
          .filter((row) => row.state !== state)
          .map(
            (row): AuditInput => ({
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
            })
          )
      );

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
