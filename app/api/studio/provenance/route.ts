import type { NextRequest } from "next/server";
import { z } from "zod";

import { badRequest, ok, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { canViewProvenance } from "@/lib/permissions";
import { parseStudioQuery } from "@/lib/studio/crud";
import {
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
  PROVENANCE_CAPS,
  PROVENANCE_NOTICE,
  actorProvenance,
  diffRevisions,
  installationProvenance,
  parseDay,
  recordProvenance,
  resolveRange,
  searchPeople,
  searchRecords
} from "@/lib/provenance";

/**
 * The provenance console's data, read-only.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireCapability(canViewProvenance)` — MASTER ADMIN ONLY, and it is the first statement.
 *
 * This is `requireCapability`, not `requireStudioCapability`: a route handler throws an `ApiError`
 * that `route()` turns into a 403 JSON body, which is what `lib/client/fetcher.ts` knows how to read.
 * The page beside this one uses the other half of the pair for the opposite reason (contract §1.9).
 *
 * THERE IS NO WRITE HANDLER IN THIS FILE, AND THERE MUST NEVER BE ONE. Every answer here is assembled
 * from `AuditLog`, `Revision`, `ContentLock`, `StudioAccess` and `User`, and the first two are written
 * ONLY by lib/audit.ts inside the same transaction as the change they describe. An endpoint that could
 * add an entry could add a FALSE one; an endpoint that could remove one would make the whole record
 * worthless, because the only time anybody reads it is when somebody's account of events is in
 * question. Nothing mutates, so there is nothing for `assertSameOrigin` or `mutateWithHistory` to
 * guard — both belong to mutating handlers, and a GET is exempt from the first by construction.
 *
 * WHY THIS IS SEPARATE FROM `/api/studio/audit`. That endpoint answers "what happened to this page?"
 * for an administrator. This one answers three questions, and one of them — "what has this PERSON
 * done, everywhere, and from which addresses?" — is a record of a colleague rather than of content.
 * Two capabilities, two endpoints; sharing one would mean the narrower gate could be widened by
 * accident while nobody was looking at the other.
 *
 * ⚠ THE CONSOLE IS NOT AUDITED PER REQUEST, DELIBERATELY. Every keystroke in the search box is a
 * request, so logging reads would write hundreds of entries a session into the very log this screen
 * exists to read — the record would drown in the act of being consulted. Transparency is provided
 * where it can actually be read instead: the screen states plainly, at the top, that this record is
 * kept and that a master administrator can read it, and `PROVENANCE_NOTICE` travels with every answer
 * so a client cannot render the data without also having been handed the sentence.
 *
 * PRIVACY IS ENFORCED IN lib/provenance.ts, NOT HERE. A rule that lives in a route is a rule the next
 * route forgets: no network address is returned for the record view, and no email address belonging to
 * somebody who is not a studio user is returned at all. See that module's header.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * The six questions this endpoint answers.
 *
 * `view` is a closed list rather than six routes because every branch shares one capability check, one
 * error vocabulary and one notice. A misspelled view is REFUSED rather than falling back to a default:
 * silently answering a different question than the one asked is the failure mode that makes an
 * operator distrust the whole screen.
 */
const Query = z.object({
  view: z.enum(["records", "record", "people", "actor", "installation", "diff"]),
  q: z.string().trim().max(160, "That search is too long. Try fewer words.").default(""),
  entityType: z.string().trim().max(80).default(""),
  entityId: z.string().trim().max(64).default(""),
  userId: z.string().trim().max(64).default(""),
  /** `YYYY-MM-DD`, read as UTC — the log stores instants and this is how they are bucketed. */
  from: z.string().trim().max(24).default(""),
  to: z.string().trim().max(24).default(""),
  /** Two revision ids, for `view=diff`. */
  a: z.string().trim().max(64).default(""),
  b: z.string().trim().max(64).default("")
});

/** Turn the two date parameters into a window, refusing an unreadable one rather than guessing. */
function windowFrom(query: { from: string; to: string }) {
  const from = query.from.length > 0 ? parseDay(query.from) : null;
  const to = query.to.length > 0 ? parseDay(query.to) : null;

  if ((query.from.length > 0 && !from) || (query.to.length > 0 && !to)) {
    throw badRequest("A date has to be written as YYYY-MM-DD, for example 2026-03-04.");
  }

  return resolveRange(from, to);
}

/** The sentences a refused comparison is explained with. One per reason `diffRevisions` can return. */
const DIFF_PROBLEMS: Record<"missing" | "mismatched" | "same" | "withheld", string> = {
  missing:
    "One of those two versions is no longer stored, so there is nothing to compare. Choose two versions from the list beside the record.",
  mismatched:
    "Those two versions belong to different records, so comparing them would not mean anything. Choose two versions of the same record.",
  same: "Those are the same version, so there is nothing to compare. Choose two different ones.",
  withheld:
    "Versions of an enquiry or an event registration are not shown here, because they would carry the words of somebody who is not a member of this studio."
};

export const GET = route(async (request: NextRequest) => {
  await requireCapability(
    canViewProvenance,
    "The provenance console needs master administrator access. It shows the full history of who changed what, including your colleagues' sign-ins, so it is deliberately the narrowest door in the studio."
  );

  const query = parseStudioQuery(request, Query);

  switch (query.view) {
    // ── Search: find a record by what it is called ────────────────────────────────────────────────
    case "records": {
      const found = await searchRecords(query.q);
      return ok({
        view: "records" as const,
        ...found,
        notice: PROVENANCE_NOTICE,
        note:
          "The search reads the history rather than the tables, so a record that has since been deleted for good can still be found by name.",
        caps: PROVENANCE_CAPS
      });
    }

    // ── Question 1: one record's whole lineage ────────────────────────────────────────────────────
    case "record": {
      if (query.entityType.length === 0 || query.entityId.length === 0) {
        throw badRequest(
          "Ask for a record by both its kind and its id. Use the search above rather than typing them by hand."
        );
      }
      const found = await recordProvenance(query.entityType, query.entityId);
      return ok({
        view: "record" as const,
        record: found,
        notice: PROVENANCE_NOTICE,
        note:
          "Network addresses are deliberately left out of a record's history: the question is where the content came from, and an address printed beside a colleague's name where nobody asked for one is surveillance by default.",
        caps: PROVENANCE_CAPS
      });
    }

    // ── Search: find a colleague ──────────────────────────────────────────────────────────────────
    case "people": {
      const found = await searchPeople(query.q);
      return ok({
        view: "people" as const,
        ...found,
        notice: PROVENANCE_NOTICE,
        caps: PROVENANCE_CAPS
      });
    }

    // ── Question 2: everything one person has done ────────────────────────────────────────────────
    case "actor": {
      if (query.userId.length === 0) {
        throw badRequest("Choose whose activity to show. Search for the person by name or email address.");
      }
      const found = await actorProvenance(query.userId, windowFrom(query));
      if (!found.person) {
        // A 200 with `person: null` rather than a 404: an account that has been purged is a legitimate
        // thing to have asked about, and "that address does not exist" would send an operator looking
        // for a routing fault instead of reading the sentence.
        return ok({
          view: "actor" as const,
          activity: found,
          notice: PROVENANCE_NOTICE,
          note: "There is no account with that id any more. Anything it did is still in the record, filed under the address it used at the time.",
          caps: PROVENANCE_CAPS
        });
      }
      return ok({
        view: "actor" as const,
        activity: found,
        notice: PROVENANCE_NOTICE,
        caps: PROVENANCE_CAPS
      });
    }

    // ── Question 3: the installation ──────────────────────────────────────────────────────────────
    case "installation": {
      const found = await installationProvenance(windowFrom(query), { addressFilter: query.q });
      return ok({
        view: "installation" as const,
        overview: found,
        notice: PROVENANCE_NOTICE,
        note:
          `Without dates this covers the last ${DEFAULT_RANGE_DAYS} days. One request may cover at most ${MAX_RANGE_DAYS} days; a longer range is answered for the most recent ${MAX_RANGE_DAYS} and says so.`,
        caps: PROVENANCE_CAPS
      });
    }

    // ── Comparing two stored versions ─────────────────────────────────────────────────────────────
    case "diff": {
      if (query.a.length === 0 || query.b.length === 0) {
        throw badRequest("Choose two versions to compare.");
      }
      const result = await diffRevisions(query.a, query.b);
      if (!result.ok) {
        // A 200 with a sentence, not a 4xx. Every one of these is a legitimate pair of ids that cannot
        // be compared, and the client's job is to print the reason beside the picker the reader used —
        // not to decide whether the request itself was malformed.
        return ok({
          view: "diff" as const,
          diff: null,
          reason: result.reason,
          message: DIFF_PROBLEMS[result.reason],
          notice: PROVENANCE_NOTICE
        });
      }
      return ok({
        view: "diff" as const,
        diff: result.diff,
        reason: null,
        message: null,
        notice: PROVENANCE_NOTICE,
        note:
          "The comparison is worked out when you ask for it, from two whole stored versions. Nothing stores a difference — see lib/audit.ts for why the full state is kept instead.",
        caps: PROVENANCE_CAPS
      });
    }
  }
});
