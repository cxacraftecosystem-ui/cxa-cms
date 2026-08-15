import type { NextRequest } from "next/server";
// `Prisma` is imported as a VALUE, not merely as a type: `Prisma.sql` is the tagged template `$queryRaw`
// needs for the event row lock. See `lockEvent`.
import { Prisma, type RegistrationStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  ApiError,
  assertSameOrigin,
  clientIp,
  conflict,
  notFound,
  ok,
  parseJson,
  route,
  userAgent
} from "@/lib/api";
import { recordEvent, type AuditContext, type TxClient } from "@/lib/audit";
import { liveStatusWhere } from "@/lib/content";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/ratelimit";
import { getSetting } from "@/lib/settings/service";

/**
 * Public registration for an event.
 *
 * FOUR THINGS THIS ROUTE IS RESPONSIBLE FOR, in order:
 *
 *  1. **The event is actually open.** Published, `isRegistrationOpen`, inside its window, and not
 *     already over. Every one of those is checked HERE and not merely used to hide a form — a hidden
 *     form is not a closed door, and this endpoint is reachable by anyone who has read the page source.
 *  2. **The last place cannot be taken twice.** The count and the insert happen in ONE SERIALIZABLE
 *     transaction that also holds a lock on the event row. See `register()` for why the default isolation
 *     level is not enough, and why Serializable on its own is not either once the studio is writing too.
 *  3. **A repeat registration is a 409 that says what state you are already in** — never a second row,
 *     and never a silent overwrite of the row that exists. Somebody who cannot remember whether they
 *     registered needs to be told, not quietly re-registered.
 *  4. **Nothing is invented.** A full event answers WAITLISTED and says the capacity in the sentence,
 *     so "am I coming?" has an answer rather than an implication.
 *
 * WHY THERE IS NO SPAM SCORING HERE, unlike the contact form: `EventRegistration` has no `spamScore`
 * and no SPAM state, so a filter on this route could only either discard a real person's place or
 * change nothing at all. Discarding is exactly what lib/spam.ts exists to avoid, so the defences are
 * the rate limit, the unique (eventId, email) index, and organisers who can cancel a row they do not
 * believe.
 */

export const dynamic = "force-dynamic";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep this to ${max} characters or fewer.`)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined));

const RegistrationBody = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter the name that should appear on the attendance list.")
    .max(120),
  email: z
    .string()
    .trim()
    .min(1, "Enter your email address — the confirmation and any joining details go there.")
    .max(254)
    .email("That does not look like an email address. Check for a missing @ or a typo in the domain."),
  organisation: optionalText(160),
  phone: optionalText(40),
  notes: optionalText(1000)
});

/** The states that occupy a place. CANCELLED and ATTENDED do not: one gave the place back, one is history. */
const PLACE_HOLDING_STATES: RegistrationStatus[] = ["CONFIRMED", "PENDING"];

/**
 * A date, with no time of day.
 *
 * Deliberately date-only. `CoeEvent.startsAt` is an absolute instant and the site renders it in the
 * CENTRE's timezone, which the schema describes as a setting — and there is no timezone setting yet.
 * Printing a time without saying which zone it is in is how somebody misses a deadline by five and a
 * half hours, so this sentence gives the day and the event page gives the time.
 */
function formatDay(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  });
}

/**
 * The sentence for somebody who is already on the list.
 *
 * Every branch NAMES THE STATE, because "you have already registered" leaves the only question they
 * actually have — am I coming? — unanswered.
 */
function alreadyRegisteredSentence(state: RegistrationStatus): string {
  switch (state) {
    case "CONFIRMED":
      return "You are already registered for this event and your place is confirmed. There is nothing more to do.";
    case "PENDING":
      return (
        "You are already registered for this event. Your place is provisional until the organisers " +
        "confirm it, and registering again will not make that happen any sooner."
      );
    case "WAITLISTED":
      return (
        "You are already on the waiting list for this event. If a place comes free the organisers will " +
        "write to the address you used."
      );
    case "CANCELLED":
      return (
        "Your registration for this event was cancelled. Registering again does not reinstate it — " +
        "write to the organisers and they will restore your place if one is available."
      );
    case "ATTENDED":
      return "Our records show you attended this event, so there is nothing left to register for.";
    default:
      return "There is already a registration against this email address for this event.";
  }
}

/**
 * Prisma's error code, read structurally.
 *
 * A `instanceof Prisma.PrismaClientKnownRequestError` check would mean importing the client as a value
 * purely to name a class, and it fails silently if two copies of the client are ever resolved. The code
 * string is the stable part of the contract: P2002 is a unique-constraint violation and P2034 is a
 * write conflict or deadlock.
 */
function prismaErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

interface RegistrationOutcome {
  id: string;
  state: RegistrationStatus;
  /** Places held at the moment the decision was taken, for the sentence and the payload. */
  placesTaken: number;
  /**
   * The limit as it stood when the decision was taken, read inside the lock.
   *
   * Carried back rather than read again outside, because the sentence this route answers with quotes the
   * number — and a sentence quoting a limit that did not decide anything is worse than no number at all.
   */
  capacity: number | null;
}

/**
 * Hold the event row until this transaction ends, so every writer that changes the number of places held
 * queues behind whoever got there first.
 *
 * ⚠ A FOURTH VERBATIM COPY of the helper in the three studio registration handlers, rather than a shared
 * function, because a `route.ts` may only export its handlers and its route config — Next's generated type
 * check refuses anything else — so there is nowhere to put a shared helper without adding a module outside
 * these files. The copies must stay identical: one writer that does not take the lock removes the guarantee
 * for all of them.
 *
 * `"events"` is `CoeEvent`'s table (`@@map`), and the model is named that way because `Event` is a DOM
 * global.
 */
async function lockEvent(tx: TxClient, eventId: string): Promise<void> {
  const locked = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT "id" FROM "events" WHERE "id" = ${eventId} FOR UPDATE`
  );
  // `FOR UPDATE` on a row that is not there locks nothing and returns nothing. The only way that happens is
  // the event being deleted between the read above and this transaction, and a registration written against
  // it would be a place nobody can honour.
  if (locked.length === 0) {
    throw conflict(
      "This event was withdrawn a moment ago, so nothing has been recorded. Its page will say what is happening."
    );
  }
}

/**
 * Count the places, then take one — atomically.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ **BOTH THE ROW LOCK AND SERIALIZABLE ARE LOAD-BEARING, AND THEY DEFEND AGAINST DIFFERENT WRITERS.**
 *
 * At Postgres's default READ COMMITTED, two requests arriving together both read `taken = capacity - 1`,
 * both conclude there is a place, and both insert: the event is over capacity and neither reader was told.
 *
 *   • SERIALIZABLE catches that between two copies of THIS route: the pair becomes a serialisation failure,
 *     exactly one wins, and the other is retried below.
 *   • THE ROW LOCK catches it between this route and the STUDIO. Serializable's predicate checking protects a
 *     transaction only from other Serializable transactions, and the three studio registration handlers run
 *     at READ COMMITTED holding `SELECT … FOR UPDATE` on the event. Without taking the same lock, a visitor
 *     claiming the last place and an organiser confirming somebody into it are invisible to each other — and
 *     this is the half of the pair that answers a member of the public, who is then turned away at the door.
 *
 * The lock is taken FIRST, in the same order as every other writer, so no two of them can deadlock.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function register(input: {
  eventId: string;
  capacity: number | null;
  name: string;
  email: string;
  organisation?: string | undefined;
  phone?: string | undefined;
  notes?: string | undefined;
}): Promise<RegistrationOutcome> {
  return prisma.$transaction(
    async (tx) => {
      await lockEvent(tx, input.eventId);

      // The limit as it is NOW, read while the row is held. An organiser may have changed it since the read
      // that decided this event was open, and the lock means it cannot change again before this commits.
      // Falls back to the value passed in only if the row has somehow gone, which `lockEvent` has just ruled
      // out.
      const eventNow = await tx.coeEvent.findUnique({
        where: { id: input.eventId },
        select: { capacity: true }
      });
      const capacity = eventNow ? eventNow.capacity : input.capacity;

      const placesTaken = await tx.eventRegistration.count({
        where: { eventId: input.eventId, state: { in: PLACE_HOLDING_STATES } }
      });

      // `capacity === null` means unlimited. `capacity === 0` means no places at all and everybody
      // waits — 0 is not a synonym for unlimited, and reading it as one would silently over-fill an
      // event whose editor typed a zero on purpose.
      const full = capacity !== null && placesTaken >= capacity;

      const created = await tx.eventRegistration.create({
        data: {
          eventId: input.eventId,
          name: input.name,
          email: input.email,
          organisation: input.organisation ?? null,
          phone: input.phone ?? null,
          notes: input.notes ?? null,
          // PENDING, not CONFIRMED: the schema's default is PENDING because an organiser confirms
          // attendance. The response says so, so nobody turns up on a provisional place believing it
          // was final.
          state: full ? "WAITLISTED" : "PENDING"
        },
        select: { id: true, state: true }
      });

      return { id: created.id, state: created.state, placesTaken, capacity };
    },
    { isolationLevel: "Serializable" }
  );
}

export const POST = route(async (request: NextRequest, context: { params: Promise<{ slug: string }> }) => {
  assertSameOrigin(request);

  const limited = enforceRateLimit(
    request,
    "event-register",
    RATE_LIMITS.eventRegistration,
    (phrase) =>
      `Registration has been attempted ${RATE_LIMITS.eventRegistration.limit} times from your ` +
      `connection in the last few minutes, so it is paused. Try again in ${phrase}.`
  );
  if (limited) return limited;

  const { slug } = await context.params;

  // Both flags, because the settings screen says so: with Events off, registration is off whatever the
  // registration switch reads. Enforcing that here rather than only in the UI keeps the two halves of
  // the product from disagreeing about whether an event exists.
  const features = await getSetting("features");
  if (!features.events || !features.eventRegistration) {
    throw new ApiError(
      503,
      "Registration is switched off on this site at the moment. The event's page lists how else to " +
        "get in touch with the organisers.",
      { code: "feature_disabled" }
    );
  }

  const body = await parseJson(request, RegistrationBody);

  // `CoeEvent` carries `status` and `publishedAt` but no publishAt/unpublishAt, so `liveStatusWhere()`
  // is the correct filter and `livePublishableWhere()` would be a Prisma runtime error (lib/content.ts
  // splits them for exactly this reason).
  const event = await prisma.coeEvent.findFirst({
    where: { slug, ...liveStatusWhere() },
    select: {
      id: true,
      title: true,
      startsAt: true,
      endsAt: true,
      capacity: true,
      isRegistrationOpen: true,
      registrationOpensAt: true,
      registrationClosesAt: true
    }
  });

  // An unpublished or deleted event is a 404, not a 403: confirming that a draft event exists at a
  // guessed slug is a leak of the Centre's unannounced programme.
  if (!event) throw notFound("That event");

  const now = new Date();

  if (!event.isRegistrationOpen) {
    throw conflict(
      `Registration for ${event.title} is not open. The event's page will say when it opens, or how ` +
        "to write to the organisers instead."
    );
  }

  if (event.registrationOpensAt && event.registrationOpensAt.getTime() > now.getTime()) {
    throw conflict(
      `Registration for ${event.title} opens on ${formatDay(event.registrationOpensAt)}. Nothing has ` +
        "been recorded yet, so please come back then."
    );
  }

  if (event.registrationClosesAt && event.registrationClosesAt.getTime() <= now.getTime()) {
    throw conflict(
      `Registration for ${event.title} closed on ${formatDay(event.registrationClosesAt)}. Write to ` +
        "the organisers if you still need a place — they can add one by hand."
    );
  }

  // An event that has already finished. The window fields usually cover this, but an editor who left
  // `isRegistrationOpen` on after the event is a common state, and a registration for something that
  // happened last month is a row nobody can act on.
  const finishesAt = event.endsAt ?? event.startsAt;
  if (finishesAt.getTime() <= now.getTime()) {
    throw conflict(
      `${event.title} has already taken place, on ${formatDay(event.startsAt)}, so registration is ` +
        "closed. The event's page keeps the record of what happened."
    );
  }

  // Lower-cased for the unique index. Without this "A@example.org" and "a@example.org" are two
  // registrations for one person, and the duplicate check below would miss the second one.
  const email = body.email.toLowerCase();

  const existing = await prisma.eventRegistration.findUnique({
    where: { eventId_email: { eventId: event.id, email } },
    select: { state: true }
  });
  if (existing) throw conflict(alreadyRegisteredSentence(existing.state));

  let outcome: RegistrationOutcome;
  try {
    outcome = await register({
      eventId: event.id,
      capacity: event.capacity,
      name: body.name,
      email,
      organisation: body.organisation,
      phone: body.phone,
      notes: body.notes
    });
  } catch (error) {
    const code = prismaErrorCode(error);

    // Somebody registered the same address in the gap between the check above and the insert. The
    // unique index caught it, which is the point of having one; the answer is the same 409 the
    // pre-check would have given, built from the row that actually won.
    if (code === "P2002") {
      const winner = await prisma.eventRegistration.findUnique({
        where: { eventId_email: { eventId: event.id, email } },
        select: { state: true }
      });
      throw conflict(
        winner
          ? alreadyRegisteredSentence(winner.state)
          : "There is already a registration against this email address for this event."
      );
    }

    // A serialisation failure: two people took the last place at once and Postgres refused to let both
    // through. One retry, after a short random pause so the two do not collide again in lockstep.
    if (code === "P2034") {
      await new Promise((resolve) => setTimeout(resolve, 40 + Math.floor(Math.random() * 60)));
      try {
        outcome = await register({
          eventId: event.id,
          capacity: event.capacity,
          name: body.name,
          email,
          organisation: body.organisation,
          phone: body.phone,
          notes: body.notes
        });
      } catch (retryError) {
        if (prismaErrorCode(retryError) === "P2002") {
          throw conflict("There is already a registration against this email address for this event.");
        }
        throw new ApiError(
          409,
          "Several people registered for this event at the same moment and your request could not be " +
            "settled. Nothing was recorded — send it again and it will go through.",
          { code: "write_conflict" }
        );
      }
    } else {
      throw error;
    }
  }

  const waitlisted = outcome.state === "WAITLISTED";

  await recordEvent(
    { actor: null, ipAddress: clientIp(request), userAgent: userAgent(request) } satisfies AuditContext,
    {
      action: "CREATE",
      entityType: "EventRegistration",
      entityId: outcome.id,
      entityLabel: `${body.name} <${email}> — ${event.title}`,
      after: {
        eventId: event.id,
        eventTitle: event.title,
        state: outcome.state,
        // The limit the decision was actually taken against, not the one read before the transaction.
        capacity: outcome.capacity,
        placesTakenBefore: outcome.placesTaken
      }
    }
  );

  // The capacity and the number of places held are in the payload as well as in the sentence, so the
  // page can state the cap rather than leaving a waiting list looking like a malfunction (contract
  // §1.6 — a limit that is not said on screen is indistinguishable from a bug).
  return ok(
    {
      state: outcome.state,
      capacity: outcome.capacity,
      placesTaken: outcome.placesTaken,
      message: waitlisted
        ? `${event.title} has reached its capacity of ${outcome.capacity ?? 0} places, so you are on the ` +
          "waiting list. The organisers will write to you if a place comes free — you do not need to do " +
          "anything else."
        : "Your place is reserved. It stays provisional until the organisers confirm it, and the " +
          "confirmation goes to the address you gave."
    },
    { status: 201 }
  );
});
