import { randomBytes } from "node:crypto";

import type { Prisma, RegistrationStatus } from "@prisma/client";

import { assertSameOrigin, conflict, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageContent } from "@/lib/permissions";
import { buildAuditContext, found, isUniqueViolation } from "@/lib/studio/crud";

/**
 * Issue a certificate of attendance to one registration.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE CODE IS RANDOM, AND THAT IS A REQUIREMENT RATHER THAN A PREFERENCE.
 *
 * `EventRegistration.certificateCode` is the public handle in a verification address — the string somebody
 * types to check that a certificate is genuine. A sequential code (certificate 41, certificate 42) turns
 * one certificate into a list of every attendee: an attendance record, with names, for anybody who holds a
 * single one. Twelve characters from a 32-letter alphabet is sixty bits, so guessing one is not a strategy.
 *
 * The alphabet leaves out I, L, O and U: the first three are misread as 1, 1 and 0 when a code is copied
 * off a printed certificate, and the fourth only appears in words nobody wants on a document. The bytes
 * are mapped with `% 32`, which is unbiased here because 32 divides 256 exactly — a modulo over an
 * alphabet that did NOT divide evenly would quietly favour its first letters.
 *
 * ISSUING IS IDEMPOTENT. Re-issuing answers the code that already exists, with the date it was issued, and
 * writes nothing. A certificate that has been sent to somebody must keep verifying: minting a second code
 * would invalidate the document they are holding, and they would find out when they tried to prove it.
 * The studio hides the action once a code exists, so this is the defence rather than the mechanism — a
 * double click on a slow connection, or two organisers working the same list, must not produce two codes.
 *
 * ⚠ THE RACE IS CLOSED BY THE WRITE ITSELF, NOT BY A READ. The claim is a single `updateMany` whose `where`
 * includes `certificateCode: null`. Two simultaneous requests both reach it; Postgres serialises them on the
 * row, the second re-evaluates its `where` against the row the first committed, matches nothing, and reports
 * a count of zero. That is the signal that somebody else got there first, and it needs no lock and no retry.
 * A read-then-write would have both requests read "no code" and both mint one.
 *
 * ONLY AN ATTENDED REGISTRATION MAY HAVE ONE, AND THE REFUSAL SAYS WHY. A certificate is the Centre's word
 * that a person was in the room, so it cannot be issued to somebody who registered and did not come. The
 * refusal names their current state and what to do about it, because "not allowed" leaves an organiser
 * guessing at which of five states is the problem.
 *
 * NO REQUEST BODY IS READ. `RegistrationsManager` posts to this address with nothing in it, and a handler
 * that called `parseJson` would answer "the request body was not valid JSON" to a request that was
 * perfectly correct.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/** Crockford-style base32 without I, L, O or U. Exactly 32 letters — see the header. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Twelve letters, in groups of four, because a code is read aloud and typed by hand. */
const CODE_GROUPS = 3;
const CODE_GROUP_LENGTH = 4;

/**
 * How many times a collision is worked around before giving up.
 *
 * `certificateCode` is unique across the whole installation, and sixty bits of randomness makes a clash
 * vanishingly unlikely — but "unlikely" is not "impossible", and a clash left unhandled would reach an
 * organiser as "something went wrong on our side" for a certificate that simply needed a different code.
 */
const CODE_ATTEMPTS = 4;

/** Plain words for a state. Never the enum name — every one of these reaches a reader. */
const STATE_WORDS: Record<RegistrationStatus, string> = {
  PENDING: "pending, which means nobody has confirmed their place yet",
  CONFIRMED: "confirmed, which means they held a place but has not been marked as having attended",
  WAITLISTED: "on the waiting list",
  CANCELLED: "cancelled",
  ATTENDED: "attended"
};

const REGISTRATION_SELECT = {
  id: true,
  name: true,
  email: true,
  organisation: true,
  state: true,
  certificateCode: true,
  certificateIssuedAt: true
} as const;

type RegistrationRow = Prisma.EventRegistrationGetPayload<{ select: typeof REGISTRATION_SELECT }>;

interface RouteContext {
  params: Promise<{ id: string; registrationId: string }>;
}

function certificateCode(): string {
  const bytes = randomBytes(CODE_GROUPS * CODE_GROUP_LENGTH);
  const groups: string[] = [];
  for (let group = 0; group < CODE_GROUPS; group += 1) {
    let text = "";
    for (let index = 0; index < CODE_GROUP_LENGTH; index += 1) {
      // `randomBytes` returns exactly the length asked for, so this index is in range; the `?? 0` is what
      // `noUncheckedIndexedAccess` requires rather than a claim that the byte might be missing.
      const byte = bytes[group * CODE_GROUP_LENGTH + index] ?? 0;
      text += CODE_ALPHABET.charAt(byte % CODE_ALPHABET.length);
    }
    groups.push(text);
  }
  return groups.join("-");
}

/**
 * "Somebody else has already issued this one" — carried out of the transaction so it can be answered as a
 * success rather than as a failure.
 *
 * A thrown value is the only way out of `mutateWithHistory`'s transaction that leaves NO audit entry
 * behind, which is what this case needs: nothing was written, and a log line saying a certificate was
 * issued would be a false record of an act that did not happen.
 */
class AlreadyIssued extends Error {
  constructor(
    readonly code: string,
    readonly issuedAt: Date | null
  ) {
    super("This registration already has a certificate.");
    this.name = "AlreadyIssued";
  }
}

/** The one sentence that describes a certificate, used for both a fresh one and an existing one. */
function describe(row: { name: string }, eventTitle: string, code: string, fresh: boolean): string {
  return fresh
    ? `A certificate for “${eventTitle}” has been issued to ${row.name}. Its code is ${code} — that is the handle anybody can use to check the certificate is genuine, so it is safe to print on it and to send to them.`
    : `${row.name} was already issued a certificate for “${eventTitle}”. Its code is still ${code}; no second certificate has been made, because the one they may already have must keep working.`;
}

export const POST = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageContent,
    "Issuing a certificate needs editor access. An administrator can raise yours."
  );

  const { id, registrationId } = await context.params;

  const event = found(
    await prisma.coeEvent.findUnique({ where: { id }, select: { id: true, title: true } }),
    "That event"
  );

  const existing = found(
    await prisma.eventRegistration.findFirst({
      where: { id: registrationId, eventId: event.id },
      select: REGISTRATION_SELECT
    }),
    "That registration"
  );

  // Already has one: answered without writing anything, and without an audit entry — see `AlreadyIssued`.
  if (existing.certificateCode !== null) {
    return ok({
      registration: existing,
      certificate: { code: existing.certificateCode, issuedAt: existing.certificateIssuedAt },
      alreadyIssued: true,
      message: describe(existing, event.title, existing.certificateCode, false)
    });
  }

  if (existing.state !== "ATTENDED") {
    throw conflict(
      `A certificate can only be issued to somebody marked as having attended, and ${existing.name} is ` +
        `${STATE_WORDS[existing.state]}. Mark them as attended first — the code on a certificate is the ` +
        "Centre's word that they were there, so it cannot be given to somebody who did not come."
    );
  }

  const auditContext = buildAuditContext(request, user);

  for (let attempt = 1; attempt <= CODE_ATTEMPTS; attempt += 1) {
    const code = certificateCode();
    const issuedAt = new Date();

    try {
      const issued = await mutateWithHistory<RegistrationRow>(
        auditContext,
        {
          action: "UPDATE",
          entityType: "EventRegistration",
          entityLabel: `${existing.name} <${existing.email}> — ${event.title}`,
          before: existing,
          /**
           * Logged, not versioned. A registration is not editorial content, and "restore the version of
           * this row from before the certificate" is not a thing anybody should be offered.
           */
          revise: false,
          summary: "Certificate issued"
        },
        async (tx) => {
          /**
           * The claim, as ONE statement. `state` and `certificateCode` are both in the `where`, so this
           * cannot issue a certificate to a registration that stopped being ATTENDED while the request was
           * in flight, and it cannot mint a second code over an existing one. See the header.
           */
          const claimed = await tx.eventRegistration.updateMany({
            where: {
              id: existing.id,
              eventId: event.id,
              state: "ATTENDED",
              certificateCode: null
            },
            data: { certificateCode: code, certificateIssuedAt: issuedAt }
          });

          if (claimed.count === 0) {
            // Something moved under us. Which of the three possible things it was decides whether this is a
            // success (somebody else issued it) or a refusal (they are no longer marked as attended).
            const now = await tx.eventRegistration.findFirst({
              where: { id: existing.id, eventId: event.id },
              select: REGISTRATION_SELECT
            });

            if (!now) {
              throw conflict(
                "That registration is no longer on this event's list, so no certificate has been issued. Reload the page to see the list as it is now."
              );
            }
            if (now.certificateCode !== null) {
              throw new AlreadyIssued(now.certificateCode, now.certificateIssuedAt);
            }
            throw conflict(
              `${now.name} is no longer marked as having attended, so no certificate has been issued. Somebody changed it while this was being done — mark them as attended again if that is right, and issue it then.`
            );
          }

          // Read back rather than assembling the answer from what was sent: the row is the record, and a
          // response built from the request is a response that cannot report a trigger or a default.
          const row = await tx.eventRegistration.findFirst({
            where: { id: existing.id },
            select: REGISTRATION_SELECT
          });
          if (!row) {
            throw conflict(
              "That registration was removed while the certificate was being issued, so nothing has been issued."
            );
          }
          return row;
        }
      );

      return ok({
        registration: issued,
        certificate: { code: issued.certificateCode, issuedAt: issued.certificateIssuedAt },
        alreadyIssued: false,
        message: describe(issued, event.title, issued.certificateCode ?? code, true)
      });
    } catch (error) {
      if (error instanceof AlreadyIssued) {
        // Not a failure. The certificate exists, which is what the organiser asked for.
        const row = await prisma.eventRegistration.findFirst({
          where: { id: existing.id },
          select: REGISTRATION_SELECT
        });
        return ok({
          registration: row ?? existing,
          certificate: { code: error.code, issuedAt: error.issuedAt },
          alreadyIssued: true,
          message: describe(existing, event.title, error.code, false)
        });
      }

      // A code that was already in use somewhere else on the installation. Try another; the whole
      // transaction rolled back, so nothing was written and nothing was logged.
      if (isUniqueViolation(error)) {
        if (attempt < CODE_ATTEMPTS) continue;
        // Every attempt collided. With sixty bits per code that is a reason to look at the random source
        // rather than at the data — but an organiser still gets a sentence rather than "something went
        // wrong on our side", which would send them hunting for a fault in the registration.
        throw conflict(
          `A certificate code could not be generated for ${existing.name} after ${CODE_ATTEMPTS} attempts, so nothing has been issued. Try again; if it keeps happening, this needs looking at by whoever runs the site.`
        );
      }
      throw error;
    }
  }

  // Unreachable: every path inside the loop returns or throws. It is here so the handler's control flow is
  // provably total rather than relying on a reader to see that.
  throw conflict("No certificate has been issued. Try again.");
});
