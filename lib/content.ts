import type { ContentStatus } from "@prisma/client";

/**
 * Publication state, resolved at READ time.
 *
 * There is a background job (app/api/cron/publish) that flips SCHEDULED → PUBLISHED and
 * PUBLISHED → ARCHIVED, and it is a CONVENIENCE, not the mechanism. The mechanism is these filters,
 * which compare against `now` on every query. The distinction is the whole point:
 *
 *   • a stalled cron cannot leave an expired embargo readable;
 *   • a scheduled piece goes live at its minute even if nothing has run since yesterday;
 *   • and a deployment with no cron configured at all still behaves correctly.
 *
 * The job exists only so `status` in the CMS list matches what the public sees, and so the audit log
 * records the transition against a time rather than inferring it.
 */

export const LIVE_STATUSES: ContentStatus[] = ["PUBLISHED", "SCHEDULED"];

export interface PublishableFields {
  status: ContentStatus;
  publishedAt?: Date | null;
  publishAt?: Date | null;
  unpublishAt?: Date | null;
  deletedAt?: Date | null;
}

/**
 * Is this row visible to an anonymous visitor right now?
 *
 * Deliberately total: every branch is spelled out rather than falling through to a default, because
 * "it wasn't DRAFT so we showed it" is how an ARCHIVED page stays reachable.
 */
export function isLive(entity: PublishableFields, now: Date = new Date()): boolean {
  if (entity.deletedAt) return false;

  switch (entity.status) {
    case "PUBLISHED": {
      // An unpublish time in the past retires it, whatever the status column still says.
      if (entity.unpublishAt && entity.unpublishAt.getTime() <= now.getTime()) return false;
      return true;
    }
    case "SCHEDULED": {
      // No `publishAt` on a SCHEDULED row is a data error. Treated as NOT live — the safe direction:
      // an unpublished draft staying private is recoverable, an embargo broken early is not.
      if (!entity.publishAt) return false;
      if (entity.publishAt.getTime() > now.getTime()) return false;
      if (entity.unpublishAt && entity.unpublishAt.getTime() <= now.getTime()) return false;
      return true;
    }
    case "DRAFT":
    case "IN_REVIEW":
    case "ARCHIVED":
      return false;
    default:
      return false;
  }
}

/**
 * The Prisma `where` fragment for "publicly visible", for models that support scheduling.
 *
 * Spread into a query: `where: { ...livePublishableWhere(), slug }`.
 */
export function livePublishableWhere(now: Date = new Date()) {
  return {
    deletedAt: null,
    OR: [
      { status: "PUBLISHED" as const, OR: [{ unpublishAt: null }, { unpublishAt: { gt: now } }] },
      {
        status: "SCHEDULED" as const,
        publishAt: { lte: now },
        OR: [{ unpublishAt: null }, { unpublishAt: { gt: now } }]
      }
    ]
  };
}

/**
 * The `where` fragment for models that carry only `status` (no publishAt/unpublishAt columns) —
 * people, research areas, projects, publications, albums, crafts.
 *
 * A SEPARATE function rather than one clever generic: a filter referencing a column the model does
 * not have is a Prisma runtime error, and finding out at request time which models have which
 * columns is exactly the sort of thing that is discovered in production.
 */
export function liveStatusWhere() {
  return { deletedAt: null, status: "PUBLISHED" as const };
}

/*
 * ⚠ THERE IS A THIRD FILTER OF THIS KIND, AND IT IS NOT IN THIS FILE. `Announcement` has neither a
 * `ContentStatus` nor `publishAt`/`unpublishAt` — its window is `isActive`/`startsAt`/`endsAt` — so
 * `activeAnnouncementWhere()` lives in lib/announcements.ts. Kept apart for the same reason the two
 * functions above are two functions: pointing one of these at a model that lacks the columns it names is
 * a Prisma RUNTIME error, not a type error, and a third builder sitting in this file is an invitation to
 * reach for the wrong one.
 */

/** Human wording for a status chip. Colour never carries the meaning alone (skill §13). */
export const STATUS_LABELS: Record<ContentStatus, string> = {
  DRAFT: "Draft",
  IN_REVIEW: "In review",
  SCHEDULED: "Scheduled",
  PUBLISHED: "Published",
  ARCHIVED: "Archived"
};

/**
 * The tone for a status chip.
 *
 * SCHEDULED is `info`, not `success`: it is not live yet, and a green chip on a piece that has not
 * published is the single most misread signal in a CMS.
 */
export const STATUS_TONES: Record<ContentStatus, "neutral" | "info" | "warn" | "success"> = {
  DRAFT: "neutral",
  IN_REVIEW: "warn",
  SCHEDULED: "info",
  PUBLISHED: "success",
  ARCHIVED: "neutral"
};

/**
 * A sentence describing where a row stands, for the editor's status line.
 *
 * Always says the WHOLE truth, including the part the status column does not carry — a PUBLISHED row
 * with an `unpublishAt` in the past reads "Retired on 4 June", not "Published".
 */
export function describeStatus(entity: PublishableFields, now: Date = new Date()): string {
  const formatDate = (date: Date) =>
    date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  if (entity.deletedAt) return `In the recycle bin since ${formatDate(entity.deletedAt)}`;

  switch (entity.status) {
    case "PUBLISHED":
      if (entity.unpublishAt && entity.unpublishAt.getTime() <= now.getTime()) {
        return `Retired on ${formatDate(entity.unpublishAt)} — no longer public`;
      }
      if (entity.unpublishAt) {
        return `Published${entity.publishedAt ? ` on ${formatDate(entity.publishedAt)}` : ""}, retiring on ${formatDate(entity.unpublishAt)}`;
      }
      return entity.publishedAt ? `Published on ${formatDate(entity.publishedAt)}` : "Published";
    case "SCHEDULED":
      if (!entity.publishAt) return "Scheduled, but no date has been set — it will not publish";
      if (entity.publishAt.getTime() > now.getTime()) {
        return `Scheduled for ${formatDate(entity.publishAt)}`;
      }
      return `Live since ${formatDate(entity.publishAt)}`;
    case "IN_REVIEW":
      return "Waiting for an editor to review it";
    case "ARCHIVED":
      return "Archived — kept, but not public";
    case "DRAFT":
    default:
      return "Draft — only visible in the studio";
  }
}
