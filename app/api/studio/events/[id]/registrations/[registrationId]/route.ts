import { z } from "zod";
// `Prisma` is imported as a VALUE: `Prisma.sql` is the tagged template `$queryRaw` needs. See `lockEvent`.
import { Prisma, type RegistrationStatus } from "@prisma/client";

import { assertSameOrigin, badRequest, conflict, ok, route } from "@/lib/api";
import { mutateWithHistory, type TxClient } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageContent } from "@/lib/permissions";
import { buildAuditContext, found, parseStudioJson } from "@/lib/studio/crud";

/**
 * ONE attendee: change their state, or their notes.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A PLACE IS HELD BY A CONFIRMED OR AN ATTENDED REGISTRATION, AND BY NOTHING ELSE.
 *
 * Pending has not claimed one, cancelled has given one back, waitlisted is by definition waiting for one.
 * `RegistrationsManager` counts places exactly this way and prints "34 of 60 places taken, 4 on the waiting
 * list" from it, and so does the collection route beside this one — all three must agree or the screen will
 * be refused things for reasons the numbers on it do not explain.
 *
 * ⚠ THE PUBLIC REGISTRATION ROUTE COUNTS PENDING AS HOLDING A PLACE, ON PURPOSE. It is deciding whether to
 * promise a stranger a place and must not over-promise. This handler is answering an organiser looking at a
 * room, where a registration nobody has confirmed does not fill a seat. Two different questions; the
 * difference is deliberate and is documented at both ends.
 *
 * ⚠ THE EVENT ROW IS LOCKED BEFORE THE COUNT IS READ, AND THAT IS THE WHOLE POINT OF THE TRANSACTION.
 *
 * Counting places and then writing a row inside a plain transaction does NOT stop two organisers
 * confirming the last place at the same moment: at Postgres's default READ COMMITTED each of them takes a
 * snapshot that does not contain the other's row, both read "59 of 60", and the room ends up with 61 people
 * in it. `SELECT … FOR UPDATE` on the EVENT row makes the two queue: the second one waits at the lock, and
 * because READ COMMITTED gives every statement a fresh snapshot, the count it runs afterwards sees the
 * first one's committed row. No retry loop, no serialisation failure to explain to a reader.
 *
 * The lock is taken on the event rather than on the registration because the thing being protected is the
 * COUNT of registrations for that event, and a lock on one row of a table does not stop an insert into
 * another. Every writer that changes how many places are held takes the same lock, which is what makes them
 * queue rather than interleave.
 *
 * ONLY A MOVE TO CONFIRMED IS REFUSED FOR CAPACITY. Marking somebody ATTENDED records a fact — they were in
 * the room — and refusing to record it because the room was notionally full would make the attendance list
 * a worse record of what happened while protecting a number that is already wrong. So attendance is
 * recorded and the overrun is REPORTED, and only the act that allocates a place is refused.
 *
 * ⚠ THE REFUSAL IS DIFFERENT HERE FROM THE `bulk` ROUTE, AND THAT IS DELIBERATE. The studio's row menu
 * sends a single change without asking anything, so a refusal is the only way an organiser can be told the
 * room is full — and the sentence says what to do instead. The bulk endpoint is reached only after
 * `RegistrationsManager` has shown the organiser the arithmetic and they have agreed to go over, so
 * refusing there would refuse the exact request somebody has just been asked about. Both files carry this
 * note.
 *
 * CANCELLING IS A STATE, NOT A DELETE. There is no DELETE here: an attendance list is a record of who asked
 * to come, and erasing a row loses the fact that they did. CANCELLED frees the place and keeps the record.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/** The states that occupy a place. See the header. */
const PLACE_HOLDING_STATES: readonly RegistrationStatus[] = ["CONFIRMED", "ATTENDED"];

const ALL_STATES = ["PENDING", "CONFIRMED", "WAITLISTED", "CANCELLED", "ATTENDED"] as const;

/** Plain words for a state. Never the enum name — every one of these reaches a reader. */
const STATE_WORDS: Record<RegistrationStatus, string> = {
  PENDING: "pending",
  CONFIRMED: "confirmed",
  WAITLISTED: "waitlisted",
  CANCELLED: "cancelled",
  ATTENDED: "attended"
};

const NOTES_MAX = 1000;

const patchSchema = z.object({
  state: z.enum(ALL_STATES).optional(),
  /**
   * ⚠ `.optional()` AND NOT `optionalText()`. That helper defaults to `null`, which would mean that the
   * studio's row menu — which sends `{ state }` alone — silently emptied the notes an organiser or the
   * registrant had written. Absent must mean "leave this column alone"; `null` and `""` both mean "clear
   * it", because a client that has never had a value sends one and a client that emptied the box sends the
   * other.
   */
  notes: z
    .union([z.string().trim().max(NOTES_MAX, `Keep the notes to ${NOTES_MAX} characters or fewer.`), z.null()])
    .optional(),
  /**
   * Confirm past the limit anyway. Defaults to refusing — see the header for why this differs from `bulk`.
   */
  allowOverCapacity: z.boolean().default(false)
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

interface RouteContext {
  params: Promise<{ id: string; registrationId: string }>;
}

/**
 * Hold the event row until this transaction ends, so every writer that changes the number of places held
 * queues behind whoever got there first. See the header for why this is on the event and not the row.
 *
 * ⚠ Duplicated in the sibling `bulk/route.ts` rather than shared, because a `route.ts` may only export its
 * handlers and its route config — Next's generated type check refuses anything else — so there is nowhere
 * to put a shared helper without adding a module outside these two files. The two copies must stay
 * identical; the collection route beside them takes the same lock.
 *
 * `"events"` is `CoeEvent`'s table (`@@map`), and the model is named that way because `Event` is a DOM
 * global.
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

export const PATCH = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageContent,
    "Changing a registration needs editor access. An administrator can raise yours."
  );

  const { id, registrationId } = await context.params;
  const body = await parseStudioJson(request, patchSchema);

  if (body.state === undefined && body.notes === undefined) {
    throw badRequest(
      "Nothing was sent to change. Include the state to move this person to, or the notes to store against them."
    );
  }

  const notes =
    body.notes === undefined ? undefined : body.notes === null || body.notes.length === 0 ? null : body.notes;

  // An event in the recycle bin is NOT refused here. Its registrations are still a record of who asked to
  // come, and an organiser tidying that list after an event was withdrawn is doing something reasonable.
  const event = found(
    await prisma.coeEvent.findUnique({
      where: { id },
      select: { id: true, title: true, capacity: true, deletedAt: true }
    }),
    "That event"
  );

  const before = found(
    await prisma.eventRegistration.findFirst({
      where: { id: registrationId, eventId: event.id },
      select: REGISTRATION_SELECT
    }),
    "That registration"
  );

  const warnings: string[] = [];

  /** The row as written, plus the arithmetic — flat, so the audit entry's `after` reads like the row. */
  type Written = Prisma.EventRegistrationGetPayload<{ select: typeof REGISTRATION_SELECT }> & {
    placesTakenAfter: number;
    capacity: number | null;
  };

  const result = await mutateWithHistory<Written>(
    buildAuditContext(request, user),
    {
      action: "UPDATE",
      entityType: "EventRegistration",
      // The event is named as well as the person: an audit list of twenty "CONFIRMED" lines is unreadable
      // without knowing which event each one belongs to.
      entityLabel: `${before.name} <${before.email}> — ${event.title}`,
      /**
       * The row as it was read for THIS request — which is the state the person making the change was
       * looking at. If another organiser moved it in the same instant, their entry sits beneath this one in
       * the log with its own before and after, so the two read in sequence and the trail is still complete.
       */
      before,
      /**
       * Logged, not versioned. A registration is not editorial content: there is no screen that would
       * restore one, and a revision of an attendance row would only duplicate the audit entry beside it.
       */
      revise: false
    },
    async (tx) => {
      await lockEvent(tx, event.id);

      // Re-read INSIDE the lock. Between the read above and here, another organiser may have moved this
      // person — and a capacity decision made from the earlier state would be arithmetic about a row that
      // no longer looks like that.
      const current = await tx.eventRegistration.findFirst({
        where: { id: registrationId, eventId: event.id },
        select: REGISTRATION_SELECT
      });
      if (!current) {
        throw conflict(
          "That registration is no longer on this event's list, so nothing has been changed. Reload the page to see the list as it is now."
        );
      }

      // Where the state is not being changed, "next" is whatever the row says NOW rather than what it said
      // when this request was read — the arithmetic below has to be about the row as it is.
      const nextState = body.state ?? current.state;

      const held = await tx.eventRegistration.count({
        where: { eventId: event.id, state: { in: [...PLACE_HOLDING_STATES] } }
      });

      // This row is taken out of the count first, so somebody who already holds a place is not counted
      // twice when they are confirmed again.
      const heldByOthers = held - (PLACE_HOLDING_STATES.includes(current.state) ? 1 : 0);
      const placesAfter = heldByOthers + (PLACE_HOLDING_STATES.includes(nextState) ? 1 : 0);

      // Only an allocation is refused. Recording attendance is not — see the header.
      if (
        nextState === "CONFIRMED" &&
        current.state !== "CONFIRMED" &&
        event.capacity !== null &&
        placesAfter > event.capacity &&
        !body.allowOverCapacity
      ) {
        throw conflict(
          `${event.title} has ${event.capacity} ${event.capacity === 1 ? "place" : "places"} and ${heldByOthers} ` +
            `${heldByOthers === 1 ? "is" : "are"} already taken, so confirming ${current.name} would make it ` +
            `${placesAfter}. Nothing has been changed. Put them on the waiting list, raise the limit on the ` +
            "event, or select them in the list and use “Confirm these”, which asks first and then lets the " +
            "number go over."
        );
      }

      const registration = await tx.eventRegistration.update({
        where: { id: current.id },
        data: {
          ...(body.state !== undefined ? { state: body.state } : {}),
          ...(notes !== undefined ? { notes } : {})
        },
        select: REGISTRATION_SELECT
      });

      // A certificate already sent must keep verifying, so moving somebody out of ATTENDED does not withdraw
      // it — but saying nothing would leave a document nobody remembers exists.
      if (
        current.certificateCode !== null &&
        current.state === "ATTENDED" &&
        registration.state !== "ATTENDED"
      ) {
        warnings.push(
          `${current.name} has already been issued a certificate for this event. It stays valid and can still be checked with its code, even though they are no longer marked as having attended.`
        );
      }

      if (event.capacity !== null && placesAfter > event.capacity) {
        warnings.push(
          `There are now ${placesAfter} places taken against a limit of ${event.capacity}. Nobody is stopped from attending by this number; it only decides who the site puts on the waiting list.`
        );
      }

      // `id` — which the spread carries — is what `mutateWithHistory` files the audit entry against.
      return { ...registration, placesTakenAfter: placesAfter, capacity: event.capacity };
    }
  );

  const { placesTakenAfter, capacity, ...registration } = result;
  const moved = registration.state !== before.state;

  return ok({
    registration,
    capacity,
    placesTaken: placesTakenAfter,
    overCapacity: capacity !== null && placesTakenAfter > capacity,
    warnings,
    message: moved
      ? `${registration.name} is now marked ${STATE_WORDS[registration.state]}.`
      : notes !== undefined
        ? `The notes against ${registration.name} have been saved.`
        : `${registration.name} was already marked ${STATE_WORDS[registration.state]}, so nothing has changed.`,
    /** Present so the event in the recycle bin is never a silent surprise on a screen that shows it. */
    ...(event.deletedAt ? { eventInRecycleBin: true } : {})
  });
});
