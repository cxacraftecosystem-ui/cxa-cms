import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, assertSameOrigin, badRequest, conflict, ok, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { mutateWithHistory, type TxClient } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { mediaPurgeAfterDays } from "@/lib/env";
import { canPurge, canRestoreDeleted } from "@/lib/permissions";
import { deleteObjects, storageAvailable } from "@/lib/storage/client";
import { buildAuditContext, parseStudioQuery } from "@/lib/studio/crud";
import { formatBytes } from "@/lib/utils";

/**
 * The recycle bin: everything soft-deleted, and permanent deletion.
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
 * ⚠ A PERMANENT DELETE REMOVES THE BYTES BEFORE THE ROW, AND THE ORDER IS THE WHOLE DESIGN. It is the same
 * ordering `app/api/cron/purge/route.ts` explains at length, for the same three outcomes:
 *
 *   • bytes gone, row gone         → correct.
 *   • bytes gone, row still here   → an orphan ROW pointing at nothing. Visible, reported, fixable.
 *   • row gone, bytes still there  → an orphan OBJECT nothing references. Invisible, unbilled to any
 *     feature, and it accumulates forever. Nobody ever finds it.
 *
 * So a failure to delete the bytes ABORTS the row deletion, and the row stays in the bin for a later
 * attempt. The refusal says exactly that, because the natural reading of a failed delete is "it deleted
 * half of it".
 *
 * ⚠ A PERMANENT DELETE REQUIRES THE RECORD'S OWN LABEL TO BE SENT BACK. This is the API's version of the
 * typed confirmation on the recycle-bin screen, and it is not decoration: this is the only irreversible
 * operation in the studio, and a client looping over the wrong array of ids would otherwise destroy a
 * fortnight of work with a 200 for each one. Echoing the label proves the caller was looking at the record
 * it is asking to destroy.
 *
 * `canRestoreDeleted` reads the bin; `canPurge` destroys. Both are administrator, and they are checked
 * SEPARATELY so the two can diverge later without either quietly becoming the other.
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

/** The kinds this route can list, restore and destroy. Each has a branch in every switch below. */
const BIN_TYPES = [
  "Page",
  "Post",
  "Person",
  "Project",
  "Publication",
  "ResearchArea",
  "CoeEvent",
  "Craft",
  "GalleryAlbum",
  "Partner",
  "MediaAsset",
  "FileAsset",
  "ContactSubmission"
] as const;

type BinType = (typeof BIN_TYPES)[number];

interface BinTypeMeta {
  type: BinType;
  label: string;
  singular: string;
  /** True where `app/api/cron/purge` will eventually remove these on its own. */
  autoPurged: boolean;
}

const META: readonly BinTypeMeta[] = [
  { type: "Page", label: "Pages", singular: "page", autoPurged: false },
  { type: "Post", label: "News articles", singular: "news article", autoPurged: false },
  { type: "Person", label: "People", singular: "person's profile", autoPurged: false },
  { type: "Project", label: "Projects", singular: "project", autoPurged: false },
  { type: "Publication", label: "Publications", singular: "publication", autoPurged: false },
  { type: "ResearchArea", label: "Research areas", singular: "research area", autoPurged: false },
  { type: "CoeEvent", label: "Events", singular: "event", autoPurged: false },
  { type: "Craft", label: "Craft records", singular: "craft record", autoPurged: false },
  { type: "GalleryAlbum", label: "Gallery albums", singular: "album", autoPurged: false },
  { type: "Partner", label: "Partners", singular: "partner", autoPurged: false },
  { type: "MediaAsset", label: "Media files", singular: "media file", autoPurged: true },
  { type: "FileAsset", label: "Files", singular: "file", autoPurged: true },
  { type: "ContactSubmission", label: "Enquiries", singular: "enquiry", autoPurged: false }
];

function metaFor(type: string): BinTypeMeta | null {
  return META.find((entry) => entry.type === type) ?? null;
}

/** The recycle bin IS this filter. Written once so no branch below can forget it. */
const deletedWhere = { deletedAt: { not: null } } as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Listing
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface BinRow {
  type: BinType;
  id: string;
  /** Never empty — it is the string a permanent delete has to echo back. */
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

  // `flatMap` with a lookup rather than an index into `META`: with `noUncheckedIndexedAccess` an index would
  // be `BinTypeMeta | undefined` and need a non-null assertion at every one of thirteen call sites.
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
      "until somebody removes it — nothing clears it automatically. User accounts are never in this list: an " +
      "account is switched off rather than deleted, so everything the person wrote keeps their name on it."
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Permanent deletion
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const PurgeQuery = z.object({
  type: z.string().trim().min(1, "Which kind of record?").max(40),
  id: z.string().trim().min(1, "Which record?").max(64),
  /**
   * The record's own label, echoed back. See the file header: this is the API's version of the typed
   * confirmation, and it is the only guard between a mis-scripted loop and unrecoverable loss.
   */
  confirm: z.string().trim().min(1, "Send the record's name back to confirm.").max(400)
});

/** Every stored object a row owns, so the bytes can go before the row. */
async function objectKeysFor(type: BinType, id: string): Promise<string[]> {
  if (type === "MediaAsset") {
    const asset = await prisma.mediaAsset.findUnique({
      where: { id },
      select: { objectKey: true, variants: { select: { objectKey: true } } }
    });
    if (!asset) return [];
    return [asset.objectKey, ...asset.variants.map((variant) => variant.objectKey)];
  }
  if (type === "FileAsset") {
    const file = await prisma.fileAsset.findUnique({
      where: { id },
      select: { versions: { select: { objectKey: true } } }
    });
    if (!file) return [];
    return file.versions.map((version) => version.objectKey);
  }
  return [];
}

/**
 * Read the row's label and confirm it is really in the bin.
 *
 * ⚠ ONE EXPLICIT BRANCH PER MODEL, the same discipline the recycle-bin screen uses. Indexing the client by
 * a string would type-check nothing at all and would happily delete from a table nobody meant to include;
 * this way a kind with no branch simply cannot be destroyed, and adding one is a compile-time obligation.
 */
async function readBinRow(type: BinType, id: string): Promise<{ label: string } | null> {
  const where = { id, deletedAt: { not: null } };
  switch (type) {
    case "Page": {
      const row = await prisma.page.findFirst({ where, select: { title: true } });
      return row ? { label: row.title } : null;
    }
    case "Post": {
      const row = await prisma.post.findFirst({ where, select: { title: true } });
      return row ? { label: row.title } : null;
    }
    case "Person": {
      const row = await prisma.person.findFirst({ where, select: { name: true } });
      return row ? { label: row.name } : null;
    }
    case "Project": {
      const row = await prisma.project.findFirst({ where, select: { title: true } });
      return row ? { label: row.title } : null;
    }
    case "Publication": {
      const row = await prisma.publication.findFirst({ where, select: { title: true } });
      return row ? { label: row.title } : null;
    }
    case "ResearchArea": {
      const row = await prisma.researchArea.findFirst({ where, select: { title: true } });
      return row ? { label: row.title } : null;
    }
    case "CoeEvent": {
      const row = await prisma.coeEvent.findFirst({ where, select: { title: true } });
      return row ? { label: row.title } : null;
    }
    case "Craft": {
      const row = await prisma.craft.findFirst({ where, select: { name: true } });
      return row ? { label: row.name } : null;
    }
    case "GalleryAlbum": {
      const row = await prisma.galleryAlbum.findFirst({ where, select: { title: true } });
      return row ? { label: row.title } : null;
    }
    case "Partner": {
      const row = await prisma.partner.findFirst({ where, select: { name: true } });
      return row ? { label: row.name } : null;
    }
    case "MediaAsset": {
      const row = await prisma.mediaAsset.findFirst({ where, select: { fileName: true } });
      return row ? { label: row.fileName } : null;
    }
    case "FileAsset": {
      const row = await prisma.fileAsset.findFirst({ where, select: { title: true } });
      return row ? { label: row.title } : null;
    }
    case "ContactSubmission": {
      const row = await prisma.contactSubmission.findFirst({ where, select: { name: true } });
      return row ? { label: row.name } : null;
    }
    default:
      return null;
  }
}

/** A real DELETE. Same discipline as `readBinRow`. */
async function deleteRow(
  tx: TxClient,
  type: BinType,
  id: string
): Promise<({ id: string } & Record<string, unknown>) | null> {
  switch (type) {
    case "Page":
      return tx.page.delete({ where: { id } });
    case "Post":
      return tx.post.delete({ where: { id } });
    case "Person":
      return tx.person.delete({ where: { id } });
    case "Project":
      return tx.project.delete({ where: { id } });
    case "Publication":
      return tx.publication.delete({ where: { id } });
    case "ResearchArea":
      return tx.researchArea.delete({ where: { id } });
    case "CoeEvent":
      return tx.coeEvent.delete({ where: { id } });
    case "Craft":
      return tx.craft.delete({ where: { id } });
    case "GalleryAlbum":
      return tx.galleryAlbum.delete({ where: { id } });
    case "Partner":
      return tx.partner.delete({ where: { id } });
    case "MediaAsset":
      return tx.mediaAsset.delete({ where: { id } });
    case "FileAsset":
      return tx.fileAsset.delete({ where: { id } });
    case "ContactSubmission":
      return tx.contactSubmission.delete({ where: { id } });
    default:
      return null;
  }
}

function isBinType(value: string): value is BinType {
  return (BIN_TYPES as readonly string[]).includes(value);
}

export const DELETE = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canPurge,
    "Deleting something for good needs administrator access."
  );

  const query = parseStudioQuery(request, PurgeQuery);
  if (!isBinType(query.type)) {
    throw badRequest(
      `This does not know how to delete a “${query.type}”, so nothing has been changed. The kinds it handles are: ${BIN_TYPES.join(", ")}.`
    );
  }
  const type: BinType = query.type;
  const meta = metaFor(type);

  const row = await readBinRow(type, query.id);
  if (!row) {
    // Not `notFound()`: its sentence ends "it may have been deleted", which on this screen is exactly what
    // the reader was trying to do and would read as a contradiction.
    throw new ApiError(
      404,
      "That item is not in the recycle bin. Somebody may have restored it or removed it for good while your screen was open. Nothing has been changed.",
      { code: "not_found" }
    );
  }

  /**
   * THE CONFIRMATION, CHECKED HERE.
   *
   * Case and surrounding space are forgiven — the ceremony is what makes this a decision, and a caller that
   * sent the right name with a capital letter has already made it.
   */
  const expected = row.label.trim().length > 0 ? row.label.trim() : `${type} ${query.id}`;
  if (query.confirm.toLowerCase() !== expected.toLowerCase()) {
    throw badRequest(
      `Nothing has been deleted. To delete this ${meta?.singular ?? "record"} for good, send its name back ` +
        `exactly as it is stored: “${expected}”.`
    );
  }

  // ── ⚠ BYTES FIRST. See the file header for why the order is not negotiable. ──────────────────────
  const keys = await objectKeysFor(type, query.id);
  if (keys.length > 0) {
    if (!storageAvailable()) {
      throw new ApiError(
        503,
        "The file store is not set up on this installation, so this record's stored files cannot be removed — " +
          "and removing the record on its own would leave files that nothing points at. Nothing has been " +
          "changed, and restoring still works.",
        { code: "unavailable" }
      );
    }
    const outcome = await deleteObjects(keys);
    if (outcome.failed.length > 0) {
      console.error("[recycle-bin] could not delete stored objects for", type, query.id, outcome.failed);
      throw conflict(
        `${outcome.failed.length} of this record's ${keys.length} stored ${keys.length === 1 ? "file" : "files"} ` +
          "could not be removed, so the record was KEPT rather than leaving files behind that nothing points at. " +
          "Nothing has been lost — try again, or ask whoever looks after storage."
      );
    }
  }

  await mutateWithHistory<{ id: string }>(
    buildAuditContext(request, user),
    {
      action: "PURGE",
      entityType: type,
      entityLabel: expected,
      /**
       * NO REVISION. There is nothing left to be a revision OF, and a revision row pointing at an entity id
       * that no longer exists is a dangling reference that will confuse the next person who reads the
       * history. The audit entry is now the ONLY record that this ever existed, which is why it carries the
       * count of stored files that went with it.
       */
      revise: false,
      before: { storedFiles: keys.length, label: expected }
    },
    async (tx) => {
      const deleted = await deleteRow(tx, type, query.id);
      // Throwing inside the transaction rolls the audit entry back too, which is the property lib/audit.ts
      // exists to provide.
      if (!deleted) throw new Error(`No permanent delete is defined for ${type}.`);
      return deleted;
    }
  );

  return ok({
    purged: true,
    type,
    id: query.id,
    label: expected,
    storedFilesRemoved: keys.length,
    message:
      `“${expected}” has been deleted for good` +
      (keys.length > 0
        ? `, along with ${keys.length === 1 ? "its stored file" : `its ${keys.length} stored files`}.`
        : ".") +
      " Nothing can bring it back, and any address that pointed at it will stop working."
  });
});
