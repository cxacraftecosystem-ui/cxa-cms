import type { NextRequest } from "next/server";
import { z } from "@/lib/zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  ApiError,
  assertSameOrigin,
  badRequest,
  clientIp,
  ok,
  parseJson,
  parseQuery,
  route,
  userAgent
} from "@/lib/api";
import { mutateWithHistory, type AuditContext } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { canManageMedia } from "@/lib/permissions";
import { indexDocument, searchDocFromFile } from "@/lib/search/index";
import { confirmUploadedObject, requireStorage } from "@/lib/storage/client";
import { isSafeObjectKey } from "@/lib/storage/keys";
import { FILE_STORE_MAX_BYTES, sha256Hex } from "@/lib/storage/upload-limits";
import { UploadTicketField, verifyUploadTicket } from "@/lib/storage/upload-ticket";
import { formatBytes, slugify } from "@/lib/utils";

/**
 * The file store: the list, and registering an upload as a new catalogue entry.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE SHAPES ARE `FileListResponse` and `StudioFileDetail` from app/studio/files/FileManager.tsx,
 * and the query string is the one `buildFileListPath` there produces.
 *
 * FILES ARE VERSIONED, AND CREATING ONE CREATES VERSION 1. A replacement never overwrites: it issues a
 * new `FileVersion` and leaves the old bytes reachable, so a citation of "version 2 of the Bagru corpus"
 * does not silently start resolving to version 3 (schema, `FileAsset`). That is why this route writes a
 * `FileVersion` rather than storing a key on the entry itself.
 *
 * THE BYTES ARE CONFIRMED BEFORE THE ROW EXISTS. The body's `uploadTicket` is presign's signed record of
 * the size, type and SHA-256 it signed into the PUT (lib/storage/upload-ticket.ts); `confirmUploadedObject`
 * `HEAD`s the object and compares size, storage-verified checksum and type against it, deleting the object
 * on any mismatch — trusting the browser's "done" produces a catalogue entry pointing at a key that was
 * never written, which is a download button that answers "not found" with a healthy-looking database.
 *
 * ⚠ AN ASSUMPTION `POST /api/studio/files/presign` MUST HONOUR (it is a different file): the key it
 * signs has to come from `buildObjectKey({ namespace: "files", fileName })`. This route accepts nothing
 * else, precisely so a caller cannot register an arbitrary bucket object — including a media asset or
 * another entry's version — as a download.
 *
 * `isPublic` AND `expiresAt` ARE ENFORCED AT THE DOWNLOAD ROUTE, not here and not by hiding a button.
 * This route only records them. `app/api/public/files/[slug]/route.ts` is the control.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/** The file store's cap, shared with presign and the browser through lib/storage/upload-limits.ts. */
const MAX_UPLOAD_BYTES = FILE_STORE_MAX_BYTES;

/**
 * How many entries the "largest first" ordering may consider.
 *
 * A file's size is the size of its NEWEST version, which lives in a different table, and no relational
 * ordering expresses "order the parents by a column of one particular child". So that one ordering reads
 * the matching ids plus their newest version's size and sorts them here. The cap is stated in the answer
 * (`sortCapped`) rather than left silent; a store larger than this wants a denormalised size column on
 * `FileAsset`, which is a migration rather than a query.
 */
const SIZE_SORT_CAP = 2000;

/** The exact shape `buildObjectKey({ namespace: "files", … })` produces. */
const ISSUED_FILE_KEY = /^files\/\d{4}\/\d{2}\/[0-9a-f]{16}-[a-z0-9-]+(?:\.[a-z0-9]+)?$/;

const VERSION_SELECT = {
  select: {
    id: true,
    version: true,
    fileName: true,
    mimeType: true,
    byteSize: true,
    checksum: true,
    notes: true,
    createdAt: true,
    /**
     * The PDF rendition, so the studio can say whether this document will be SHOWN on a page or only
     * offered as a download — and, when the last attempt failed, why.
     *
     * ⚠ THE KEY ITSELF IS NOT SENT, only whether there is one. It is an internal storage address; the
     * public route that serves the preview looks it up server-side, and a studio screen has no use for
     * it. `previewByteSize` is sent because it is what the frame actually fetches.
     */
    previewByteSize: true,
    previewAttemptedAt: true,
    previewFailedReason: true
  },
  orderBy: { version: "desc" as const }
};

/** The row the list renders: the entry, its newest version, how many there are, and who added it. */
const ROW_SELECT = {
  id: true,
  title: true,
  slug: true,
  description: true,
  category: true,
  isPublic: true,
  expiresAt: true,
  downloadCount: true,
  createdAt: true,
  updatedAt: true,
  uploader: { select: { id: true, name: true } },
  versions: { ...VERSION_SELECT, take: 1 },
  _count: { select: { versions: true } }
} satisfies Prisma.FileAssetSelect;

type FileRow = Prisma.FileAssetGetPayload<{ select: typeof ROW_SELECT }>;

/**
 * The wire row.
 *
 * `latestVersion` is `null` for an entry whose upload never finished — a real state the panel words as
 * "no file has been uploaded against this entry yet" rather than pretending the entry is broken.
 */
function toRow(row: FileRow) {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    description: row.description,
    category: row.category,
    isPublic: row.isPublic,
    expiresAt: row.expiresAt,
    downloadCount: row.downloadCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    latestVersion: row.versions[0] ?? null,
    versionCount: row._count.versions,
    uploader: row.uploader
  };
}

function auditContext(request: NextRequest, actor: { id: string; email: string }): AuditContext {
  return { actor, ipAddress: clientIp(request), userAgent: userAgent(request) };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// GET
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A bounded whole number from a query string, VALIDATED AS A STRING and converted at the call site.
 *
 * The house pattern, for the reason app/api/public/search/route.ts sets out: a string with a `.refine()`
 * answers a bad value with the sentence below, where coercion would answer in Zod's own words.
 */
const boundedInt = (label: string, min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,6}$/, `${label} has to be a whole number.`)
    .refine((value) => {
      const parsed = Number.parseInt(value, 10);
      return parsed >= min && parsed <= max;
    }, `${label} has to be between ${min} and ${max}.`)
    .optional();

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const ListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.string().trim().max(80).optional(),
  visibility: z.enum(["public", "private", "expired"]).optional(),
  sort: z.enum(["updated", "title", "downloads", "size"]).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  page: boundedInt("The page number", 1, 100000),
  pageSize: boundedInt("The page size", 1, MAX_PAGE_SIZE)
});

/** The query with its defaults settled, so nothing downstream repeats a `?? "updated"`. */
interface FileListFilters {
  q: string | undefined;
  category: string | undefined;
  visibility: "public" | "private" | "expired" | undefined;
  sort: "updated" | "title" | "downloads" | "size";
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
}

function readFilters(request: Request): FileListFilters {
  const raw = parseQuery(request, ListQuery);
  return {
    q: raw.q && raw.q.length > 0 ? raw.q : undefined,
    category: raw.category,
    visibility: raw.visibility,
    sort: raw.sort ?? "updated",
    dir: raw.dir ?? "desc",
    page: toInt(raw.page, 1),
    pageSize: toInt(raw.pageSize, DEFAULT_PAGE_SIZE)
  };
}

function buildWhere(query: FileListFilters, now: Date): Prisma.FileAssetWhereInput {
  // The recycle bin belongs to /studio/recycle-bin. An entry listed here is one that can be downloaded.
  const where: Prisma.FileAssetWhereInput = { deletedAt: null };
  const and: Prisma.FileAssetWhereInput[] = [];

  if (query.category) where.category = query.category;

  if (query.q && query.q.length > 0) {
    and.push({
      OR: [
        { title: { contains: query.q, mode: "insensitive" } },
        { description: { contains: query.q, mode: "insensitive" } },
        // The stored filename too: somebody searching for "bagru-corpus-v2.csv" is searching for the
        // thing they downloaded, not for the title an editor gave it.
        { versions: { some: { fileName: { contains: query.q, mode: "insensitive" } } } }
      ]
    });
  }

  if (query.visibility === "public") {
    // "Anyone can download it" is BOTH conditions. A public file past its date is not public, and
    // listing it as though it were is how an embargo is believed to have lapsed when it has not.
    and.push({ isPublic: true, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });
  } else if (query.visibility === "private") {
    and.push({ isPublic: false });
  } else if (query.visibility === "expired") {
    and.push({ expiresAt: { lte: now } });
  }

  if (and.length > 0) where.AND = and;
  return where;
}

export const GET = route(async (request: Request) => {
  await requireCapability(
    canManageMedia,
    "The file store needs media manager access or higher. An administrator can raise yours."
  );

  const query = readFilters(request);
  const now = new Date();
  const where = buildWhere(query, now);

  const total = await prisma.fileAsset.count({ where });

  if (query.sort === "size") {
    // See SIZE_SORT_CAP. The ids are ordered here and the page is then read in that order.
    const candidates = await prisma.fileAsset.findMany({
      where,
      select: { id: true, versions: { select: { byteSize: true }, orderBy: { version: "desc" }, take: 1 } },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: SIZE_SORT_CAP
    });

    const ordered = candidates
      .map((entry) => ({ id: entry.id, byteSize: entry.versions[0]?.byteSize ?? 0 }))
      .sort((a, b) =>
        // Ties break on the id so the order is TOTAL — two files of identical size must not swap places
        // between two requests, which reads as the list shuffling itself.
        a.byteSize === b.byteSize
          ? a.id.localeCompare(b.id)
          : query.dir === "asc"
            ? a.byteSize - b.byteSize
            : b.byteSize - a.byteSize
      )
      .slice((query.page - 1) * query.pageSize, query.page * query.pageSize);

    const rows = await prisma.fileAsset.findMany({
      where: { id: { in: ordered.map((entry) => entry.id) } },
      select: ROW_SELECT
    });
    const byId = new Map(rows.map((row) => [row.id, row]));

    return ok({
      items: ordered
        .map((entry) => byId.get(entry.id))
        .filter((row): row is FileRow => row !== undefined)
        .map(toRow),
      total,
      page: query.page,
      pageSize: query.pageSize,
      /** Stated, not silent: past the cap this ordering is over the most recently changed entries only. */
      sortCapped: total > SIZE_SORT_CAP,
      ...(total > SIZE_SORT_CAP
        ? {
            sortNote:
              `Ordering by size looks at the ${SIZE_SORT_CAP} most recently changed files, and there are ` +
              `${total} altogether, so the very largest may not be listed. Narrow the search to be sure.`
          }
        : {})
    });
  }

  const orderBy: Prisma.FileAssetOrderByWithRelationInput[] =
    query.sort === "title"
      ? [{ title: query.dir }, { id: "asc" }]
      : query.sort === "downloads"
        ? [{ downloadCount: query.dir }, { id: "asc" }]
        : [{ updatedAt: query.dir }, { id: "asc" }];

  const rows = await prisma.fileAsset.findMany({
    where,
    orderBy,
    skip: (query.page - 1) * query.pageSize,
    take: query.pageSize,
    select: ROW_SELECT
  });

  return ok({
    items: rows.map(toRow),
    total,
    page: query.page,
    pageSize: query.pageSize,
    sortCapped: false
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// POST — a new catalogue entry plus version 1
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const CreateBody = z.object({
  title: z
    .string()
    .trim()
    .min(1, "A file needs a title. It is what people see in the list of downloads.")
    .max(200, "Keep the title to 200 characters or fewer."),
  objectKey: z.string().trim().min(1).max(1024),
  fileName: z.string().trim().min(1, "The file has no name.").max(255),
  mimeType: z.string().trim().min(1).max(160),
  byteSize: z.number().int().positive(),
  /** Presign's signed record of what it agreed to. Required — see the header. */
  uploadTicket: UploadTicketField,
  description: z.string().trim().max(2000).nullable().optional(),
  category: z.string().trim().max(80).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional()
});

/**
 * A slug nobody else is using.
 *
 * The slug is the PUBLIC download address and therefore the thing a citation records, so it is derived
 * from the title once and then left alone. A numeric suffix is appended rather than the title being
 * refused: an editor uploading "Annual report" for the third year running should not have to invent a
 * different name for the file to be accepted.
 */
async function uniqueSlug(title: string): Promise<string> {
  const base = slugify(title) || "file";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const taken = await prisma.fileAsset.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!taken) return candidate;
  }
  // Fifty entries whose titles all slugify identically. A timestamp is ugly and it is unique, which is
  // the only property that matters at this point.
  return `${base}-${Date.now().toString(36)}`;
}

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageMedia,
    "Adding to the file store needs media manager access or higher. An administrator can raise yours."
  );
  requireStorage();

  const body = await parseJson(request, CreateBody);
  const objectKey = body.objectKey;

  if (!isSafeObjectKey(objectKey) || !ISSUED_FILE_KEY.test(objectKey)) {
    throw badRequest(
      "That storage address is not one the file store issues, so nothing was added. Start the upload again."
    );
  }

  if (body.byteSize > MAX_UPLOAD_BYTES) {
    throw new ApiError(
      413,
      `This file is ${formatBytes(body.byteSize)} and the limit is ${formatBytes(MAX_UPLOAD_BYTES)}. ` +
        "Split it or compress it, or ask an administrator to raise the limit.",
      { code: "too_large" }
    );
  }

  // What presign signed for this key — the reference for every check on the bytes below.
  const intent = verifyUploadTicket(body.uploadTicket, { objectKey, userId: user.id });
  if (intent.contentType !== body.mimeType.toLowerCase() || intent.byteSize !== body.byteSize) {
    throw badRequest(
      "This upload is being described differently from how it was started, so nothing was added. Start the upload again."
    );
  }

  const alreadyUsed = await prisma.fileVersion.findUnique({
    where: { objectKey },
    select: { fileId: true }
  });
  if (alreadyUsed) {
    throw badRequest("That upload has already been registered as a file. Reload the file store to see it.");
  }

  // The bytes, before the row. See the header. Absent → 400; any mismatch with the ticket → the object
  // (issued by the file store, referenced by nothing) is deleted, then 400.
  const head = await confirmUploadedObject(intent, {
    logTag: "[studio/files]",
    nothingChanged: "Nothing was added."
  });

  // Storage's own SHA-256, verified at PUT time, as hex — the form the column has always held.
  const checksum = sha256Hex(intent.sha256);

  const slug = await uniqueSlug(body.title);

  const created = await mutateWithHistory<
    Prisma.FileAssetGetPayload<{ select: typeof ROW_SELECT & { versions: typeof VERSION_SELECT } }>
  >(
    auditContext(request, { id: user.id, email: user.email }),
    {
      action: "CREATE",
      entityType: "FileAsset",
      entityLabel: body.title,
      summary: "Added to the file store"
    },
    async (tx) => {
      const file = await tx.fileAsset.create({
        data: {
          title: body.title,
          slug,
          description: body.description?.trim() || null,
          category: body.category?.trim() || null,
          // PRIVATE until somebody says otherwise. A dataset that becomes public because that is the
          // default is a disclosure nobody decided to make.
          isPublic: false,
          uploaderId: user.id,
          versions: {
            create: {
              version: 1,
              objectKey,
              fileName: body.fileName,
              mimeType: body.mimeType.toLowerCase(),
              byteSize: head.byteSize,
              checksum,
              notes: body.notes?.trim() || null
            }
          }
        },
        select: { ...ROW_SELECT, versions: VERSION_SELECT }
      });

      // The index row joins the same transaction as the write it describes, so a rolled-back save cannot
      // leave a search result pointing at content that does not exist (lib/search/index.ts).
      await indexDocument(tx, searchDocFromFile(file));

      return file;
    }
  );

  return ok(
    {
      ...toRow(created),
      /** Newest first — the panel lists them in that order and calls the first one "the one people get now". */
      versions: created.versions
    },
    { status: 201 }
  );
});
