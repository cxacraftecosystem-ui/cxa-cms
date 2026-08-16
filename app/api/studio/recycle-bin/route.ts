import { ok, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { mediaPurgeAfterDays } from "@/lib/env";
import { canRestoreDeleted } from "@/lib/permissions";
import { storageAvailable } from "@/lib/storage/client";
import { formatBytes } from "@/lib/utils";

import { BIN_META, deletedWhere, metaFor, type BinType } from "./kinds";

/**
 * The recycle bin: everything soft-deleted, listed in one answer.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE RECYCLE BIN IS `deletedAt IS NOT NULL`. There is no separate table and no second flag to forget:
 * every read path on the public site and in the studio filters it out through `livePublishableWhere()` or
 * `liveStatusWhere()`, so a row in here is already invisible everywhere else.
 *
 * ⚠ TWO RETENTION RULES, AND THEY ARE NOT THE SAME. Both are reported on every row, because "the recycle
 * bin empties itself" and "the recycle bin never empties" are both wrong and lead to opposite mistakes.
 *
 *   • MEDIA FILES and STORED FILES are removed for good by `app/api/cron/purge` once they have been in here
 *     longer than the purge window, because they hold bytes that cost money and cannot be kept forever.
 *     Every one of those rows carries `purgeAt` and `daysLeft`.
 *   • EVERYTHING ELSE stays until somebody removes it. `daysLeft` is null, and `autoPurged` is false.
 *
 * ⚠ THE THREE OPERATIONS ARE THREE ROUTES, AND THE SPLIT IS A PERMISSION BOUNDARY RATHER THAN TIDINESS.
 *
 *   • THIS FILE reads the bin.                          `canRestoreDeleted` — administrator.
 *   • `restore/route.ts` puts one record back.          `canRestoreDeleted` — administrator.
 *   • `purge/route.ts` destroys one, for good.          `isMasterAdmin` — MASTER ADMIN ONLY.
 *
 * The permanent delete used to be a `DELETE` in this file, and moving it out was the point rather than a
 * side effect: sharing a file with the listing shared its permission story by proximity, and it read as
 * "same screen, same tier" when it is emphatically not. It also carried the name of the record being
 * destroyed in the QUERY STRING, which put it in every access log between here and the browser. Its
 * reasoning — why master admin, what it refuses, and why the bytes go before the row — is at the top of
 * `purge/route.ts` and `purge-record.ts`.
 *
 * Each capability is checked SEPARATELY at each boundary so the three can diverge later without any one
 * of them quietly becoming another.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * How many rows of each kind one answer carries.
 *
 * `take` is one MORE than this, so "there are more" is a fact rather than a guess — and `truncated` per
 * group is what the client prints. A list that quietly stops is indistinguishable from a place with only
 * that many records (contract §1.6).
 */
const PER_TYPE_LIMIT = 25;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Listing
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface BinRow {
  type: BinType;
  /** Never empty — it is the string a permanent delete has to echo back. */
  id: string;
  label: string;
  /** A second line: an address, a file size, an email. */
  detail: string;
  deletedAt: Date;
  /** Null for anything nothing removes on its own. */
  purgeAt: Date | null;
  daysLeft: number | null;
}

/** Whole days to the deadline, floored at 0. Rounded UP, so "1 day left" means "not yet gone". */
function daysUntil(deadline: Date, now: number): number {
  return Math.max(0, Math.ceil((deadline.getTime() - now) / (24 * 60 * 60 * 1000)));
}

export const GET = route(async () => {
  await requireCapability(
    canRestoreDeleted,
    "The recycle bin needs administrator access. Ask an administrator to restore something for you."
  );

  const take = PER_TYPE_LIMIT + 1;
  const orderBy = { deletedAt: "desc" as const };

  /**
   * THIRTEEN NARROW READS IN ONE BATCH.
   *
   * Sequentially each would pay a full round trip, and on a pooled connection that is several seconds for
   * thirteen short lists. Each `select` is written out rather than generated, because the column that NAMES
   * a record differs per model and getting that wrong would answer with a list of ids.
   */
  const [
    pages,
    posts,
    people,
    projects,
    publications,
    areas,
    events,
    crafts,
    albums,
    partners,
    media,
    files,
    enquiries
  ] = await prisma.$transaction([
    prisma.page.findMany({ where: deletedWhere, orderBy, take, select: { id: true, title: true, slug: true, deletedAt: true } }),
    prisma.post.findMany({ where: deletedWhere, orderBy, take, select: { id: true, title: true, slug: true, deletedAt: true } }),
    prisma.person.findMany({ where: deletedWhere, orderBy, take, select: { id: true, name: true, designation: true, deletedAt: true } }),
    prisma.project.findMany({ where: deletedWhere, orderBy, take, select: { id: true, title: true, slug: true, deletedAt: true } }),
    prisma.publication.findMany({ where: deletedWhere, orderBy, take, select: { id: true, title: true, year: true, deletedAt: true } }),
    prisma.researchArea.findMany({ where: deletedWhere, orderBy, take, select: { id: true, title: true, slug: true, deletedAt: true } }),
    prisma.coeEvent.findMany({ where: deletedWhere, orderBy, take, select: { id: true, title: true, startsAt: true, deletedAt: true } }),
    prisma.craft.findMany({ where: deletedWhere, orderBy, take, select: { id: true, name: true, slug: true, deletedAt: true } }),
    prisma.galleryAlbum.findMany({ where: deletedWhere, orderBy, take, select: { id: true, title: true, slug: true, deletedAt: true } }),
    prisma.partner.findMany({ where: deletedWhere, orderBy, take, select: { id: true, name: true, category: true, deletedAt: true } }),
    prisma.mediaAsset.findMany({ where: deletedWhere, orderBy, take, select: { id: true, fileName: true, byteSize: true, deletedAt: true } }),
    prisma.fileAsset.findMany({ where: deletedWhere, orderBy, take, select: { id: true, title: true, slug: true, deletedAt: true } }),
    prisma.contactSubmission.findMany({ where: deletedWhere, orderBy, take, select: { id: true, name: true, email: true, deletedAt: true } })
  ]);

  const windowDays = mediaPurgeAfterDays();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  /** `deletedAt` is nullable in the type and never null in these results — the filter guarantees it. */
  function rowsFrom<T extends { id: string; deletedAt: Date | null }>(
    type: BinType,
    source: readonly T[],
    label: (row: T) => string,
    detail: (row: T) => string
  ): BinRow[] {
    const autoPurged = metaFor(type)?.autoPurged ?? false;
    return source
      .filter((row): row is T & { deletedAt: Date } => row.deletedAt !== null)
      .map((row) => {
        const named = label(row).trim();
        const purgeAt = autoPurged ? new Date(row.deletedAt.getTime() + windowMs) : null;
        return {
          type,
          id: row.id,
          // NEVER empty: a permanent delete has to echo this string, and a blank one could be "confirmed"
          // by sending nothing at all.
          label: named.length > 0 ? named : `${type} ${row.id}`,
          detail: detail(row),
          deletedAt: row.deletedAt,
          purgeAt,
          daysLeft: purgeAt ? daysUntil(purgeAt, now) : null
        };
      });
  }

  const collected: { type: BinType; rows: BinRow[] }[] = [
    { type: "Page", rows: rowsFrom("Page", pages, (row) => row.title, (row) => `/${row.slug}`) },
    { type: "Post", rows: rowsFrom("Post", posts, (row) => row.title, (row) => `/news/${row.slug}`) },
    { type: "Person", rows: rowsFrom("Person", people, (row) => row.name, (row) => row.designation ?? "") },
    { type: "Project", rows: rowsFrom("Project", projects, (row) => row.title, (row) => `/projects/${row.slug}`) },
    { type: "Publication", rows: rowsFrom("Publication", publications, (row) => row.title, (row) => String(row.year)) },
    { type: "ResearchArea", rows: rowsFrom("ResearchArea", areas, (row) => row.title, (row) => `/research/${row.slug}`) },
    { type: "CoeEvent", rows: rowsFrom("CoeEvent", events, (row) => row.title, (row) => row.startsAt.toISOString()) },
    { type: "Craft", rows: rowsFrom("Craft", crafts, (row) => row.name, (row) => `/craft-explorer/${row.slug}`) },
    { type: "GalleryAlbum", rows: rowsFrom("GalleryAlbum", albums, (row) => row.title, (row) => `/gallery/${row.slug}`) },
    { type: "Partner", rows: rowsFrom("Partner", partners, (row) => row.name, (row) => row.category ?? "") },
    { type: "MediaAsset", rows: rowsFrom("MediaAsset", media, (row) => row.fileName, (row) => formatBytes(row.byteSize)) },
    { type: "FileAsset", rows: rowsFrom("FileAsset", files, (row) => row.title, (row) => row.slug) },
    { type: "ContactSubmission", rows: rowsFrom("ContactSubmission", enquiries, (row) => row.name, (row) => row.email) }
  ];

  // `flatMap` with a lookup rather than an index into `BIN_META`: with `noUncheckedIndexedAccess` an index
  // would be `BinTypeMeta | undefined` and need a non-null assertion at every one of thirteen call sites.
  const groups = collected.flatMap((entry) => {
    const meta = metaFor(entry.type);
    if (!meta) return [];
    return [
      {
        ...meta,
        rows: entry.rows.slice(0, PER_TYPE_LIMIT),
        /** REQUIRED READING. `take` was limit + 1 precisely so this is measured rather than assumed. */
        truncated: entry.rows.length > PER_TYPE_LIMIT
      }
    ];
  });

  const shown = groups.reduce((sum, group) => sum + group.rows.length, 0);

  return ok({
    groups,
    shown,
    perTypeLimit: PER_TYPE_LIMIT,
    /** Every kind the bin knows about, including the ones with nothing in them right now. */
    kinds: BIN_META,
    purgeWindowDays: windowDays,
    /**
     * A permanent delete of a media file or a stored file cannot proceed without object storage: its bytes
     * could not be removed, and taking the row alone would leave objects nothing points at. Restoring still
     * works, and the client must be able to say which is which.
     */
    storageReady: storageAvailable(),
    note:
      "Media files and stored files are removed for good " +
      `${windowDays} days after they were deleted, by a job that runs on its own. Everything else stays here ` +
      "until somebody removes it — nothing clears it automatically. Deleting something for good is a " +
      "separate request to /api/studio/recycle-bin/purge and needs master administrator access. User " +
      "accounts are never in this list: an account is switched off rather than deleted, so everything the " +
      "person wrote keeps their name on it."
  });
});
