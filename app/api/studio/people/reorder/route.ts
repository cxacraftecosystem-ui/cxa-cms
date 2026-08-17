import { z } from "zod";
// `Prisma` is imported as a VALUE, not merely as a type: `Prisma.sql` and `Prisma.join` are the
// tagged-template helpers the one statement below is built from. See the note on that statement.
import { Prisma, type PersonKind } from "@prisma/client";

import { assertSameOrigin, conflict, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageContent } from "@/lib/permissions";
import { buildAuditContext, fieldProblem, parseStudioJson } from "@/lib/studio/crud";
import { unique } from "@/lib/utils";

/**
 * Re-order one group of people: ONE request carrying the whole order of one group.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS PATH WAS BEING EATEN BY A SIBLING. `app/api/studio/people/[id]/route.ts` already existed, so
 * `POST /api/studio/people/reorder` resolved to it with `id="reorder"` and answered 405 — every drag on the
 * people board silently failed. A STATIC segment always beats a dynamic one (contract §13b), so the presence
 * of this file is the fix. No person can ever be found at that id either: the lookups in `[id]/route.ts` are
 * `where: { id }` against the `people` table, and "reorder" is not a cuid.
 *
 * THE WHOLE ORDER, NOT "MOVE THIS PERSON TO POSITION 3". Moving one name changes the position of everything
 * between its old place and its new one, so N independent requests would have two in flight the moment
 * somebody drags twice and the saved order would be neither of the two the reader saw. `PeopleBoard` sends
 * the complete list of the group and the write is one transaction: it either commits or it does not.
 *
 * ⚠ THE WHOLE GROUP IS RENUMBERED BY ONE STATEMENT, AND THAT IS A BUG FIX, NOT A MICRO-OPTIMISATION.
 * This handler used to loop, issuing one `updateMany` per profile. Every one of those is a network round
 * trip, they all sit inside a single interactive transaction, and Prisma closes an interactive transaction
 * that outlives its timeout — raising `P2028`, which is not an `ApiError`, so `toErrorResponse` could only
 * answer "Something went wrong on our side". A group of a dozen people on a small shared Postgres was
 * already enough to spend that budget, and the failure grew with the roster: the more faculty a Centre
 * added, the more certain it became that their order could never be saved again. One statement is a fixed
 * cost no matter how long the list is.
 *
 * It also makes a HALF-APPLIED ORDER impossible by construction rather than by trusting a rollback: one
 * `UPDATE` either renumbers the group or renumbers nobody.
 *
 * `FROM (VALUES …)` is what carries the positions. Every parameter is cast explicitly — `::text` and
 * `::int` on each pair, `::"PersonKind"` on the group — because an overload Postgres picks by inference is
 * not something a statement that rewrites a whole group should depend on. `kind` and `deletedAt IS NULL`
 * are restated in the `WHERE` although the checks above already proved both: the check and the write are
 * separated by a transaction boundary, and restating them is what makes it impossible for a later edit to
 * that check to turn into a silent cross-group move.
 *
 * ⚠ THIS SHAPE IS SAFE HERE AND WOULD NOT BE ON `PageSection`. `Person.sortOrder` has NO unique constraint
 * (prisma/schema.prisma) — only an index, `@@index([kind, sortOrder])` — so a single statement may hand out
 * every number at once. `PageSection` carries `@@unique([pageId, position])`, Postgres checks a unique
 * constraint at the end of each STATEMENT, and so `rewriteSectionPositions()` in lib/studio/crud.ts has to
 * move every row through a negative range first. The difference is the constraint, and it is worth knowing
 * which model has which before copying either one.
 *
 * ⚠ EVERY ID MUST BELONG TO THE GROUP BEING ORDERED. A person's group is a field on their own profile, and
 * the board says out loud that dragging cannot change it. If an id from another group were accepted, its
 * `sortOrder` would be rewritten against a list it is not in — quietly moving somebody up or down inside a
 * group nobody was looking at. So a stranger is refused, and the refusal says whose profile it is and where
 * they actually are.
 *
 * THE SET MUST BE COMPLETE, for the same reason `navigation/order` insists on it: a partial list leaves the
 * omitted people on their old numbers, which now collide with the new ones, and with no unique index to catch
 * it the group renders in an order nobody chose and nothing anywhere reports a problem.
 *
 * NO SEARCH RE-INDEX. `searchDocFromPerson()` (lib/search/index.ts) reads the name, the job title, the
 * department, the biography and the research interests — not `sortOrder`. A re-order changes nothing a reader
 * could search for, so re-indexing here would be work with no effect.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * A safety bound on one request. Above this the board has already stood ordering down: the people screen
 * reads at most 400 profiles and turns dragging off when there are more (app/studio/people/page.tsx).
 */
const MAX_IDS = 400;

/**
 * Every `PersonKind`, as a tuple.
 *
 * `satisfies` rather than an annotation, so adding a group to the Prisma enum without adding it here is a
 * compile error rather than a group whose order silently cannot be saved.
 */
const PERSON_KINDS = [
  "FACULTY",
  "SCIENTIST",
  "RESEARCH_ASSISTANT",
  "STUDENT",
  "STAFF",
  "VISITOR",
  "ALUMNUS",
  "DC_HANDICRAFTS"
] as const satisfies readonly PersonKind[];

/**
 * The plural group names, for the sentences this handler writes.
 *
 * ⚠ A deliberate second copy of `PERSON_KIND_GROUPS` in components/site/PersonCard.tsx. That module is a CARD
 * — importing it here to read a label would pull a renderer and the components under it into an API route,
 * which is the wrong dependency for the sake of a handful of strings (`app/api/studio/research/route.ts` refuses the
 * same import for the same reason). Being a total `Record<PersonKind, string>` is what stops the two drifting:
 * a new group is a compile error in both files.
 *
 * Written out rather than derived from the enum because "Faculty" and "Staff" are already plural,
 * "Alumnus" pluralises to "Alumni" and "DC, Handicrafts" is one office — a naive `${label}s` gets four of
 * the eight wrong.
 */
const GROUP_LABELS: Record<PersonKind, string> = {
  FACULTY: "Faculty",
  SCIENTIST: "Scientists",
  RESEARCH_ASSISTANT: "Research assistants",
  STUDENT: "Students",
  STAFF: "Staff",
  VISITOR: "Visitors",
  ALUMNUS: "Alumni",
  DC_HANDICRAFTS: "DC, Handicrafts"
};

const orderBody = z.object({
  // One `message` rather than Zod's default, which lists every enum value back at the reader. The group
  // is chosen by the screen and never typed by hand, so an unexpected value means the screen is out of date.
  kind: z.enum(PERSON_KINDS, {
    message: "That is not a group on the people board. Reload the page and try the move again."
  }),
  ids: z
    .array(z.string().trim().min(1, "An empty reference to a profile cannot be saved.").max(40))
    .min(1, "The new order arrived empty, so nothing has been changed.")
    .max(MAX_IDS, `At most ${MAX_IDS} profiles can be re-ordered in one request.`)
});

function people(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}

export const POST = route(async (request: Request) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageContent,
    "Changing the order people appear in needs editor access or higher. An administrator can raise yours."
  );

  const body = await parseStudioJson(request, orderBody);
  const kind: PersonKind = body.kind;
  const groupLabel = GROUP_LABELS[kind];

  // A duplicate would be written twice and leave somebody else with no position at all.
  const ids = unique(body.ids);
  if (ids.length !== body.ids.length) {
    throw fieldProblem(
      "ids",
      "The new order lists the same person more than once. Reload the page and try the move again — nothing has been moved."
    );
  }

  /**
   * The group as the database has it. The order is checked against reality rather than against the body, and
   * soft-deleted profiles are out of scope because they are not on the board either.
   */
  const stored = await prisma.person.findMany({
    where: { kind, deletedAt: null },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true, sortOrder: true }
  });

  const here = new Set(stored.map((row) => row.id));
  const strangers = ids.filter((candidate) => !here.has(candidate));

  if (strangers.length > 0) {
    /**
     * TWO DIFFERENT SITUATIONS, AND THE READER'S NEXT ACTION DIFFERS.
     *
     * An id in another group means the board and the database disagree about somebody's job — usually because
     * their profile was changed in another tab. An id that names nobody at all means the profile has gone to
     * the recycle bin. "Reload" is the answer to both, but only the first can name the person.
     */
    const elsewhere = await prisma.person.findMany({
      where: { id: { in: strangers }, deletedAt: null },
      select: { name: true, kind: true },
      take: 1
    });

    const other = elsewhere[0];
    throw conflict(
      other
        ? `“${other.name}” is in ${GROUP_LABELS[other.kind]}, not ${groupLabel}, so that order cannot be saved. Somebody's group is a field on their own profile and dragging cannot change it. Reload the page and try again — nothing has been moved.`
        : `One of the profiles in that order is no longer here — it may have been moved to the recycle bin while your screen was open. Reload the page and try the move again. Nothing has been moved.`
    );
  }

  if (ids.length !== stored.length) {
    const sent = new Set(ids);
    const missing = stored.filter((row) => !sent.has(row.id));
    const named = missing
      .slice(0, 3)
      .map((row) => `“${row.name}”`)
      .join(", ");
    throw conflict(
      `There ${stored.length === 1 ? "is" : "are"} ${people(stored.length)} in ${groupLabel} and ${people(ids.length)} ${ids.length === 1 ? "was" : "were"} sent, so nothing has been moved. Missing: ${named}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""}. Somebody has probably added or removed a profile in another tab — reload the page and try again.`
    );
  }

  const currentIds = stored.map((row) => row.id);
  const alreadyInOrder =
    ids.every((candidate, index) => candidate === currentIds[index]) &&
    // A group that has never been ordered by hand holds `sortOrder: 0` for everybody, so it reads in the
    // right order by name while the numbers say nothing. Writing them is what makes the order survive a
    // rename, so "the ids match" is not on its own a reason to skip the write.
    stored.every((row, index) => row.sortOrder === index);

  if (alreadyInOrder) {
    // Answered as success: the board's optimistic list already shows this order, and an error would roll it
    // back to the identical order while claiming something went wrong.
    return ok({
      kind,
      order: currentIds,
      moved: 0,
      changed: false,
      message: `That is already the order of ${groupLabel.toLowerCase()}, so nothing has been changed.`
    });
  }

  await mutateWithHistory<{ id: string }>(
    buildAuditContext(request, user),
    {
      action: "UPDATE",
      /**
       * The entity is the GROUP, not any one profile: no single person's record is what changed. The audit
       * screen has no noun for "People" and humanises the type, which reads correctly
       * (app/studio/audit/page.tsx), and it is deliberately absent from that screen's `ROLLBACKABLE` list —
       * putting an order back is a drag, not a rewrite of a row.
       */
      entityType: "People",
      entityLabel: `The order of ${groupLabel.toLowerCase()}`,
      before: {
        kind,
        order: stored.map((row) => ({ id: row.id, name: row.name, sortOrder: row.sortOrder }))
      },
      /**
       * NO REVISION. Nothing about anybody's profile changed — only where they sit in a list — so a revision
       * would be an identical second copy of a state that already has one from the last real save.
       */
      revise: false
    },
    async (tx) => {
      /**
       * `"updatedAt" = NOW()` is set by hand because raw SQL bypasses Prisma's `@updatedAt`. It is set at
       * all so this keeps the behaviour the per-row `updateMany` loop had — a re-order has always touched
       * the timestamp, and quietly stopping would change what "last edited" means on every profile screen.
       */
      const renumbered = await tx.$executeRaw(Prisma.sql`
        UPDATE "people" AS p
           SET "sortOrder" = v."sortOrder", "updatedAt" = NOW()
          FROM (VALUES ${Prisma.join(
            ids.map((id, index) => Prisma.sql`(${id}::text, ${index}::int)`)
          )}) AS v("id", "sortOrder")
         WHERE p."id" = v."id"
           AND p."kind" = ${kind}::"PersonKind"
           AND p."deletedAt" IS NULL
      `);

      /**
       * Anything short of the whole group means a row changed hands between the checks above and this
       * statement — moved to another group, or sent to the recycle bin, in another tab. That is a refusal
       * rather than a quiet partial write, and throwing rolls the statement back with it.
       */
      if (renumbered !== ids.length) {
        throw conflict(
          "One of these profiles was changed by somebody else while the order was being saved. Reload the page and try the move again — nothing has been moved."
        );
      }

      return { id: kind, kind, order: ids };
    }
  );

  return ok({
    kind,
    order: ids,
    moved: ids.length,
    changed: true,
    message: `The order of ${groupLabel.toLowerCase()} has been saved. The public site shows it straight away.`
  });
});
