import type { Prisma, SectionType } from "@prisma/client";

import { ApiError, assertSameOrigin, conflict, ok, route } from "@/lib/api";
import { getRevision, mutateWithHistory } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { LIVE_STATUSES, STATUS_LABELS } from "@/lib/content";
import { prisma } from "@/lib/db";
import {
  describePublishBlockers,
  normalisePageSlug,
  pagePath,
  pagePublishBlockers
} from "@/lib/pages";
import { canManageStructure } from "@/lib/permissions";
import { isSectionType, parseSectionData } from "@/lib/sections/schema";
import {
  assertSlugAvailable,
  buildAuditContext,
  found,
  isUniqueViolation,
  reindexPage
} from "@/lib/studio/crud";

/**
 * Put a saved version of a page back — as a NEW version, not by rewinding the history.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A RESTORE IS ITSELF A SAVE. NOTHING IS EVER REMOVED FROM THE HISTORY.
 *
 * The version being restored is read, written over the page, and the result is appended as the next
 * revision. The state that was on screen a moment ago therefore becomes a version of its own, sitting
 * above the one that was just restored — which is what makes the single most calming sentence in
 * `RevisionHistory`'s confirmation true: somebody who restores the wrong version can come straight back
 * here and restore what they had. Rewinding — deleting the revisions after N — would make the first
 * mistaken restore unrecoverable, and it is exactly the moment a person is most likely to make one.
 *
 * THE PUBLICATION STATE IS DELIBERATELY NOT RESTORED, AND THE ANSWER SAYS SO.
 *
 * `status`, `publishedAt`, `publishAt` and `unpublishAt` are kept exactly as they are now. Restoring them
 * would mean that reverting a wording change on a live page could take the page off the site — or, worse,
 * put a draft in front of readers — as a side effect of a decision that was about wording. Neither is
 * something anybody asks for by pressing Restore, and both are silent: the page simply stops being where
 * it was, with nothing on the screen to connect the two.
 *
 * All four are kept, not just `status`, because `unpublishAt` is a publication decision wearing a date's
 * clothing: publication is resolved at READ time (lib/content.ts), so restoring a stale `unpublishAt`
 * would take a published page off the site while its status still read "Published". Changing publication
 * state has its own control, its own permission (`canPublish`) and its own audit verb, and this route is
 * not a back door to any of them. The response reports the status it left alone so a screen can say it.
 *
 * THE ADDRESS *IS* RESTORED, AND IT LEAVES A REDIRECT BEHIND.
 *
 * The history panel lists the address as one of the things a restore changes, so it is restored. But an
 * institutional address outlives the page: it is in papers, syllabi, emails and other people's websites.
 * So the same three things happen here as in `pages/[id]`'s PATCH — a redirect from the old address to the
 * restored one, any redirect that pointed at the old address re-pointed, and any redirect claiming the
 * restored address deleted so the page wins its own URL. All inside the same transaction as the page's
 * update; a redirect that exists without the move is worse than neither.
 *
 * ⚠ A MISSING KEY IN A SNAPSHOT MEANS `null`, NOT "LEAVE IT ALONE".
 *
 * `redact()` in lib/audit.ts drops null values on the way into a revision, so a page saved with no menu
 * label has NO `navLabel` key in its snapshot at all. Reading an absent key as "unchanged" would make a
 * restore unable to empty a field: restoring a version from before the search-engine description was
 * written would silently keep today's description. So for every nullable text column, absent means null.
 * The two columns where absent is ambiguous rather than meaningful — `seoNoIndex` and `sortOrder`, which
 * are NOT NULL and so can only be absent in a snapshot written before the column existed — keep their
 * current value.
 *
 * BLOCKS ARE RESTORED ONLY IF THAT VERSION RECORDED THEM, and the answer says which happened.
 *
 * A page's own revisions (written by `pages/[id]`'s PATCH) snapshot the page's columns and NOT its
 * blocks — each block keeps its own history, which is what the History tab tells the reader. So on today's
 * data this restores the page's details and leaves the blocks untouched, and the response states that
 * rather than letting a reader assume the page has been put back whole. Where a snapshot DOES carry a
 * `sections` array, it is honoured, and the reason it is written the way it is below is worth reading.
 *
 * The version this restore appends has the SAME SHAPE as the one an ordinary save writes — the page's
 * columns, and not its blocks — so the history panel's field-by-field comparison keeps working instead of
 * growing a "Sections" row holding a page's worth of JSON. The blocks that were replaced are therefore held
 * by this change's AUDIT entry rather than by its revision, which is where the whole prior state belongs
 * (lib/audit.ts) and is enough to put them back by hand.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ THE PERMISSION IS `canManageStructure`, NOT `canPublish`.
 *
 * `PageEditor` passes `canRestore={canPublish(user)}` and its comment claims this handler enforces the
 * same thing. It does not, on purpose: a restore writes the very columns `pages/[id]`'s PATCH writes, and
 * that PATCH requires `canManageStructure`. Enforcing the weaker predicate here would leave a route by
 * which somebody who has been granted publishing rights without editor access could rewrite the site's
 * page titles and addresses — a thing the direct save refuses them. The two predicates coincide for every
 * editor and administrator, so in practice the same people see the control and may use it; the divergence
 * bites only a lower tier holding an explicit publishing grant, and it reaches them as a sentence in a
 * toast rather than as a silent structural change. The screen's `canRestore` should be moved to
 * `canManageStructure` to close the gap; that file is not this one's to edit.
 */

export const dynamic = "force-dynamic";

/**
 * Every column a restore may write. `status`, `publishedAt`, `publishAt`, `unpublishAt`, `isSystem`,
 * `deletedAt`, `id` and the timestamps are absent from this list ON PURPOSE — see the header.
 *
 * A type rather than an array, so the object assembled below can `satisfies Record<RestorableColumn, …>`:
 * leaving a column out when this route is next edited is then a compile error, rather than a field that
 * quietly stops coming back.
 */
type RestorableColumn =
  | "title"
  | "slug"
  | "navLabel"
  | "seoTitle"
  | "seoDescription"
  | "seoImageId"
  | "seoNoIndex"
  | "canonicalUrl"
  | "sortOrder";

/** The shape the answer carries back, and the shape the new revision stores. Matches `pages/[id]`. */
const PAGE_SELECT = {
  id: true,
  slug: true,
  title: true,
  navLabel: true,
  status: true,
  publishedAt: true,
  publishAt: true,
  unpublishAt: true,
  seoTitle: true,
  seoDescription: true,
  seoImageId: true,
  seoNoIndex: true,
  canonicalUrl: true,
  isSystem: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true
} as const;

type PageRow = Prisma.PageGetPayload<{ select: typeof PAGE_SELECT }>;

const SECTION_SELECT = {
  id: true,
  type: true,
  position: true,
  label: true,
  data: true,
  isVisible: true
} as const;

interface RouteContext {
  params: Promise<{ id: string; version: string }>;
}

/** One block as it will be recreated. `position` is assigned by the loop, densely, from 0. */
interface PlannedSection {
  type: SectionType;
  label: string | null;
  data: Prisma.InputJsonValue;
  isVisible: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Reading a stored snapshot
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function versionFrom(raw: string): number {
  if (!/^\d{1,9}$/.test(raw)) {
    throw new ApiError(
      400,
      `A version is a whole number, like 7. “${raw.slice(0, 40)}” could not be read as one.`,
      { code: "bad_request" }
    );
  }
  return Number.parseInt(raw, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A nullable text column from a snapshot. Absent, null, blank or the wrong type all mean null. */
function storedText(stored: Record<string, unknown>, key: string): string | null {
  const value = stored[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The handler
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const POST = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageStructure,
    "Restoring a version of a page needs editor access. An administrator can raise yours."
  );

  const { id, version: rawVersion } = await context.params;
  const version = versionFrom(rawVersion);

  const existing = found(
    await prisma.page.findUnique({ where: { id }, select: PAGE_SELECT }),
    "That page"
  );

  // A page in the recycle bin must come out of it first. Restoring a version into a deleted row would put
  // work into a page the editor believes they have thrown away, and the site would not show it either way.
  // Taking a page out of the bin is an administrator's act (`canRestoreDeleted`) and has its own screen.
  if (existing.deletedAt) {
    throw conflict(
      `“${existing.title}” is in the recycle bin, so a version of it cannot be restored yet. Restore the page itself from the recycle bin first, then come back to its history.`
    );
  }

  const revision = await getRevision("Page", existing.id, version);
  if (!revision) {
    throw new ApiError(
      404,
      `There is no version ${version} of “${existing.title}”. It may have been removed, or this screen may have gone stale — reload the page to see the versions that do exist.`,
      { code: "not_found" }
    );
  }

  if (!isRecord(revision.data)) {
    throw conflict(
      `Version ${version} of “${existing.title}” did not store a readable copy of the page, so there is nothing to put back. Nothing has been changed. Choose another version, or edit the page by hand.`
    );
  }
  const stored = revision.data;

  /** Things the reader should know that did not stop the restore. Rendered as they are. */
  const notes: string[] = [];

  // ── The page's own fields ──────────────────────────────────────────────────────────────────────

  const title = storedText(stored, "title");
  if (title === null) {
    throw conflict(
      `Version ${version} does not record a title, and a page cannot be saved without one. Nothing has been changed — choose another version.`
    );
  }

  const rawSlug = stored.slug;
  if (typeof rawSlug !== "string") {
    throw conflict(
      `Version ${version} does not record this page's address, so restoring it would leave the page with nowhere to live. Nothing has been changed — choose another version.`
    );
  }
  const slug = normalisePageSlug(rawSlug);

  // The address may have been taken by another page since this version was saved. Refused with the name of
  // whatever holds it — including a page in the recycle bin, which is invisible from every list an editor
  // can reach, so no amount of looking would have explained the refusal.
  if (slug !== existing.slug) await assertSlugAvailable("page", slug, existing.id);

  /**
   * The picture for shared links, if it is still in the library.
   *
   * A media row that has been PURGED would make this write fail on the foreign key, and one that is merely
   * in the recycle bin would be written happily and then simply not appear, with nothing on screen to say
   * why. Either way the version cannot be put back exactly, so the picture is dropped and the fact is
   * reported — refusing the whole restore over a missing picture would strand a reader who wants the words
   * back.
   */
  const storedImageId = storedText(stored, "seoImageId");
  let seoImageId: string | null = storedImageId;
  if (storedImageId !== null) {
    const asset = await prisma.mediaAsset.findFirst({
      where: { id: storedImageId, deletedAt: null },
      select: { id: true }
    });
    if (!asset) {
      seoImageId = null;
      notes.push(
        "The picture this version used for shared links is no longer in the media library, so the page has been left without one. Choose another on the Search and sharing tab."
      );
    }
  }

  const restored = {
    title,
    slug,
    navLabel: storedText(stored, "navLabel"),
    seoTitle: storedText(stored, "seoTitle"),
    seoDescription: storedText(stored, "seoDescription"),
    seoImageId,
    canonicalUrl: storedText(stored, "canonicalUrl"),
    // NOT NULL columns: absent can only mean "this snapshot predates the column", so the current value is
    // the honest answer rather than a made-up default. See the header.
    seoNoIndex: typeof stored.seoNoIndex === "boolean" ? stored.seoNoIndex : existing.seoNoIndex,
    sortOrder:
      typeof stored.sortOrder === "number" && Number.isInteger(stored.sortOrder)
        ? stored.sortOrder
        : existing.sortOrder
  } satisfies Record<RestorableColumn, unknown>;

  // ── The blocks, if this version recorded any ───────────────────────────────────────────────────

  const storedSections = stored.sections;
  let plannedSections: PlannedSection[] | null = null;

  if (Array.isArray(storedSections)) {
    const planned: PlannedSection[] = [];
    let unreadable = 0;

    /**
     * The entries that are objects at all, ordered by their stored position.
     *
     * Collected with a loop rather than `.filter(isRecord)`: the array's element type here is Prisma's
     * `JsonValue`, and `Array.prototype.filter`'s narrowing overload only applies when the guarded type
     * EXTENDS the element type — which `Record<string, unknown>` does not — so the filtered array would come
     * back still typed as JSON and every property read below would be an error.
     */
    const ordered: Record<string, unknown>[] = [];
    for (const entry of storedSections) {
      if (isRecord(entry)) ordered.push(entry);
      else unreadable += 1;
    }

    // Ordered by the stored position where there is one, so the page comes back in the order it was in
    // rather than in whatever order the array happened to be serialised.
    ordered.sort((left, right) => {
      const a = typeof left.position === "number" ? left.position : Number.MAX_SAFE_INTEGER;
      const b = typeof right.position === "number" ? right.position : Number.MAX_SAFE_INTEGER;
      return a - b;
    });

    for (const entry of ordered) {
      if (!isSectionType(entry.type)) {
        unreadable += 1;
        continue;
      }
      // Validated against the schema for its type, exactly as `sections/route.ts` validates a new block. A
      // stored payload is not automatically a payload this build can render: block schemas change, and a
      // block written back unchecked is a renderer reading a property that is not there.
      const parsed = parseSectionData(entry.type, entry.data);
      if (!parsed.ok) {
        unreadable += 1;
        continue;
      }
      planned.push({
        type: entry.type,
        label: typeof entry.label === "string" && entry.label.trim().length > 0 ? entry.label.trim() : null,
        data: parsed.data as Prisma.InputJsonValue,
        isVisible: typeof entry.isVisible === "boolean" ? entry.isVisible : true
      });
    }

    if (unreadable > 0) {
      notes.push(
        unreadable === 1
          ? "One block in that version could not be read by this version of the site, so it has been left out. Everything else has been put back."
          : `${unreadable} blocks in that version could not be read by this version of the site, so they have been left out. Everything else has been put back.`
      );
    }

    plannedSections = planned;
  }

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * ⚠ THE PLACEHOLDER GATE, IN THE ONE SHAPE IT CAN TAKE HERE.
   *
   * A restore KEEPS the publication state (see the header), so it can never make a page public — which
   * is where `pages/[id]`'s PATCH puts its gate. What it can do is the other half of the same defect:
   * replace the blocks of a page that is ALREADY in front of readers with content out of a version
   * nobody is looking at. If that version holds the studio's own prompt text, "Add a heading" is on the
   * public site the moment this succeeds, and the person who pressed Restore never saw the words.
   *
   * So the condition is the mirror of the PATCH's: the PATCH asks "is it becoming public", and this
   * asks "is it public already". Both read `LIVE_STATUSES`, so SCHEDULED counts — a page waiting for
   * app/api/cron/publish is committed to publication and nobody looks again when the job fires.
   *
   * ⚠ THIS REFUSAL CANNOT FIRE ON ANY INPUT THIS BUILD PRODUCES, AND IS WRITTEN ANYWAY. "Latent on
   * today's data" was the weaker way of putting it: the reason is structural, and it is spelled out here
   * so a reader can check it in one grep instead of taking it on trust. `mutateWithHistory()` in
   * lib/audit.ts versions the mutation's RETURN value — `writeRevision(tx, { data: result })` — and every
   * writer of a Page revision returns a column-only `select`: `PAGE_EDITABLE_SELECT` in `pages/[id]`'s
   * PATCH, `PAGE_SELECT` here, and a column list in `pages/route.ts`, in `duplicate` and in
   * `app/studio/templates/page.tsx`. The three block handlers version `entityType: "PageSection"`
   * instead, and `sections/order` and the soft DELETE both pass `revise: false`, so neither writes a
   * revision at all. No `sections` key can therefore reach a stored Page revision, `stored.sections` is
   * never an array, and `plannedSections` is always `null`.
   *
   * It stays, for a reason worth more than the branch costs. The half ABOVE it is fully reachable: this
   * handler honours a `sections` array in ANY snapshot that has one, which is what an import, a migrated
   * history or a future revision shape would arrive as. A gate that has to be REMEMBERED at that moment
   * is a gate that will not be there, and the whole reason this area exists is that the last such moment
   * put "Add a heading" on the public homepage.
   *
   * ⚠ WHAT MUST NOT HAPPEN IS A HEADER SOMEWHERE ELSE COUNTING THIS AS A LIVE CONSUMER. `lib/pages.ts`
   * and lib/sections/schema.ts both did, which made the gate read as twice as enforced as it is; both now
   * name the one call that can refuse something today and mark this one latent by construction.
   *
   * ⚠ REFUSED, NOT SILENTLY TRIMMED. Dropping the offending blocks would leave a page missing the
   * sections its editor asked to see restored, with a note nobody reads explaining it. And the refusal
   * is escapable in one move — take the page off the site, restore, replace the words — which is what
   * makes it a check rather than a trap. The sentence says so.
   *
   * `conflict()` and not `fieldProblem()`: there is no form field to attach this to. A restore is a
   * button in the History panel, and every other refusal in this handler is a 409 whose sentence ends
   * by saying that nothing was changed. This one matches, because nothing was.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  if (plannedSections !== null && LIVE_STATUSES.includes(existing.status)) {
    const refusal = describePublishBlockers(pagePublishBlockers(plannedSections));
    if (refusal) {
      throw conflict(
        `Version ${version} of “${existing.title}” brings back blocks that still hold the words the studio put there as a prompt, and this page is on the public site — so nothing has been changed. ` +
          `${refusal} ` +
          `To put this version back exactly as it is stored, take the page off the site first, then restore it.`
      );
    }
  }

  // The blocks as they stand, captured BEFORE anything is written so the audit entry holds the whole
  // outgoing state. This is what makes a restore of the blocks recoverable: the new revision records what
  // the page became, and the audit log records what it was.
  const outgoingSections =
    plannedSections === null
      ? null
      : await prisma.pageSection.findMany({
          where: { pageId: existing.id },
          orderBy: { position: "asc" },
          select: SECTION_SELECT
        });

  // ── The write ──────────────────────────────────────────────────────────────────────────────────

  const oldPath = pagePath(existing.slug);
  const newPath = pagePath(slug);
  // A redirect is only worth writing when there is an old address to redirect FROM. The homepage's slug is
  // the empty string, and "/" cannot redirect to a child page without taking the whole site with it.
  const redirecting = slug !== existing.slug && existing.slug.length > 0;

  try {
    const row = await mutateWithHistory<PageRow>(
      buildAuditContext(request, user),
      {
        // ROLLBACK, not UPDATE: an audit list where a restore is indistinguishable from an ordinary save is
        // an audit list that cannot answer "who put the old wording back".
        action: "ROLLBACK",
        entityType: "Page",
        entityLabel: existing.title,
        before: {
          ...existing,
          ...(outgoingSections ? { sections: outgoingSections } : {})
        },
        summary: `Restored from version ${version}`
      },
      async (tx) => {
        const updated = await tx.page.update({
          where: { id: existing.id },
          data: restored,
          select: PAGE_SELECT
        });

        if (slug !== existing.slug) {
          // The page must win the address it claims. A leftover redirect from this path would send every
          // reader straight off it, and the page would look broken with nothing to explain why.
          await tx.redirect.deleteMany({ where: { source: { in: [newPath, slug] } } });

          if (redirecting) {
            await tx.redirect.upsert({
              where: { source: oldPath },
              create: { source: oldPath, destination: newPath, permanent: true },
              // An existing row for the same source was written by an earlier move of this same page; the
              // newest destination is the only correct one.
              update: { destination: newPath, permanent: true }
            });

            // Collapse chains, so a citation from two moves ago still arrives in one hop.
            await tx.redirect.updateMany({
              where: { destination: oldPath },
              data: { destination: newPath }
            });
          }
        }

        /**
         * ⚠ THE BLOCKS ARE DELETED AND RECREATED, NEVER UPDATED IN PLACE.
         *
         * `PageSection` carries `@@unique([pageId, position])`, which Prisma creates as a unique INDEX, and
         * Postgres checks one of those PER ROW the instant that row is written. So writing the restored
         * blocks over the existing rows position by position collides the moment the two arrangements
         * overlap anywhere — which they nearly always do — and the transaction dies half way. (That is the
         * same index `rewriteSectionPositions()` exists to work around, by parking every row in the
         * negatives first. It does not help here: the blocks being restored are not the rows that are
         * there, so there is nothing to renumber.)
         *
         * Emptying the page in ONE statement and then inserting at 0…n-1 cannot collide with anything: by
         * the time the insert runs, no position on this page is occupied.
         *
         * ⚠ THE INSERT IS ONE `createMany`, NOT A LOOP OF `create`. Each `create` is a network round trip,
         * they all sit inside one interactive transaction, and Prisma closes a transaction that outlives
         * its timeout — `P2028`, which is not an `ApiError` and so reaches an editor as "Something went
         * wrong on our side". A long page restored over a slow link is precisely the shape that made the
         * people board unable to save an order at all (app/api/studio/people/reorder/route.ts). Two
         * statements now, whatever the page holds. `createMany` returns no rows, and nothing here wants
         * them — the blocks are re-read by `reindexPage` below.
         *
         * The recreated blocks are NEW rows. Nothing references a block's id, but each block's own version
         * history is keyed by it, so a restored block starts a fresh history while the outgoing rows are
         * preserved whole in this change's audit entry.
         */
        if (plannedSections !== null) {
          await tx.pageSection.deleteMany({ where: { pageId: existing.id } });
          if (plannedSections.length > 0) {
            await tx.pageSection.createMany({
              data: plannedSections.map((section, index) => ({
                pageId: existing.id,
                type: section.type,
                position: index,
                label: section.label,
                data: section.data,
                isVisible: section.isVisible
              }))
            });
          }
        }

        // A page's searchable text is its title, its search-engine description and the words inside its
        // blocks, so every one of those having just changed means the index must be rewritten — in this
        // transaction, so a rolled-back restore cannot leave a search result pointing at wording that was
        // never saved.
        await reindexPage(tx, existing.id);

        return updated;
      }
    );

    return ok({
      page: { ...row, path: newPath },
      restoredFromVersion: version,
      /** The blocks were only touched if that version recorded them — see the header. */
      sectionsRestored: plannedSections === null ? 0 : plannedSections.length,
      sectionsLeftAlone: plannedSections === null,
      redirectCreated: redirecting,
      /** Kept, not restored. Reported so a screen can say which state it is still in. */
      status: row.status,
      publicationStateKept: true,
      notes,
      message:
        `Version ${version} has been put back. This page is still ${STATUS_LABELS[row.status].toLowerCase()} — ` +
        "restoring an older version never changes whether a page is on the site. What was on screen before is " +
        "kept in this history as a new version, so you can go back to it." +
        (plannedSections === null
          ? " The blocks on the page have not been changed: they keep their own history, one per block."
          : "") +
        (redirecting ? ` Anybody using ${oldPath} is now sent to ${newPath}.` : "")
    });
  } catch (error) {
    // The address was taken between the check above and the write. Answered with the same 409 that names
    // the record holding it, rather than with a bare constraint failure.
    if (isUniqueViolation(error)) await assertSlugAvailable("page", slug, existing.id);
    throw error;
  }
});
