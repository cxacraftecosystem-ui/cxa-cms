/**
 * Which site-wide announcement is showing RIGHT NOW.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE FILTER IS THE MECHANISM. THERE IS NO CRON.
 *
 * lib/content.ts makes the same argument for pages, and there at least a background job exists as a
 * convenience so the studio's status column matches reality. Here there is deliberately not even that:
 * an announcement has no status column to keep in step, so a scheduled job would have nothing to do
 * except add a way for the site to be wrong. A banner that outlived its `endsAt` because a job did not
 * run is the Centre stating something untrue on every page of its own site — "applications close on 30
 * September", read on 4 October, by somebody who then does not apply.
 *
 * So visibility is computed against `now` on every read, and these two functions are the only way to ask
 * the question. Nothing hand-rolls the four conditions, which is what stops one call site from
 * remembering `isActive` and forgetting `endsAt`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ WHY THIS IS ITS OWN MODULE RATHER THAN A THIRD HELPER IN lib/content.ts: that file's two `where`
 * builders are shaped around `ContentStatus`, which `Announcement` does not have. Its own header explains
 * that `livePublishableWhere()` and `liveStatusWhere()` are two functions rather than one clever generic
 * precisely because naming a column a model does not have is a Prisma RUNTIME error and not a type error.
 * This is the third shape, kept apart for the third time — and kept somewhere a developer cannot reach it
 * by accident while looking for the page filters.
 *
 * NOT `server-only`. There is nothing secret in a date comparison, and `isAnnouncementActive` is useful in
 * the browser: the studio's announcements screen re-reads the clock on a timer so an editor watching a
 * window open or close sees it happen without a reload.
 */

/**
 * The fields the visibility rules read.
 *
 * Structural rather than `Announcement` itself, so a `select`ed subset, an API row rebuilt from JSON, or a
 * test fixture all satisfy it. Both date fields are optional AND nullable: a Prisma row gives `null`, a
 * partial select gives nothing at all, and neither is a reason to refuse to answer.
 */
export interface AnnouncementVisibility {
  isActive: boolean;
  startsAt?: Date | null;
  endsAt?: Date | null;
  deletedAt?: Date | null;
}

/**
 * Is this announcement showing to a visitor right now?
 *
 * Deliberately total, and deliberately one condition at a time in the style of `isLive()`: every early
 * return names the fact that stopped it, so a banner that is not on the site can be explained rather than
 * merely observed.
 *
 * `endsAt` is compared with `<=`, so the instant a window closes the band is gone. Treating the end as
 * inclusive would make "ends 30 September" mean "ends some time on 1 October", which is not what an editor
 * typing a date means.
 */
export function isAnnouncementActive(
  announcement: AnnouncementVisibility,
  now: Date = new Date()
): boolean {
  if (announcement.deletedAt) return false;
  if (!announcement.isActive) return false;
  if (announcement.startsAt && announcement.startsAt.getTime() > now.getTime()) return false;
  if (announcement.endsAt && announcement.endsAt.getTime() <= now.getTime()) return false;
  return true;
}

/**
 * The Prisma `where` fragment for "showing now" — `where: activeAnnouncementWhere(new Date())`.
 *
 * ⚠ THE TWO WINDOW TESTS SIT INSIDE ONE `AND`, AND THAT IS NOT A STYLE CHOICE. A Prisma filter object can
 * carry only ONE `OR` key, so writing them as two sibling `OR`s means the second silently overwrites the
 * first: the result then checks the end of the window and not the beginning, and every announcement
 * scheduled for next month is live today. That failure typechecks, and it reads as correct.
 *
 * `deletedAt: null` is here because `Announcement` is soft-deleted like the rest of the content models —
 * the studio's announcements screen has a removed list and a restore, so a deleted row is still in the
 * table and a filter that forgot this clause would put it back on the site.
 */
export function activeAnnouncementWhere(now: Date = new Date()) {
  return {
    deletedAt: null,
    isActive: true,
    AND: [
      { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
      { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }
    ]
  };
}
