import { z } from "zod";
import type { MediaKind, Prisma } from "@prisma/client";

import { badRequest, ok, parseQuery, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { livePublishableWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { MEDIA_IMAGE_SELECT } from "@/lib/media/select";
import { canAuthor } from "@/lib/permissions";
import { searchUrlFor } from "@/lib/search/index";
import { formatBytes, truncateWords, unique } from "@/lib/utils";
import type {
  LookupItem,
  LookupKind,
  LookupResponse
} from "@/components/studio/fields/EntityPicker";

/**
 * `/api/studio/lookup` — the read side of every relation control in the studio.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT DEPENDS ON THIS FILE. `components/studio/fields/EntityPicker.tsx` is the control that answers
 * "which records?" for the people in a project, the speakers at an event, the authors of a
 * publication, the related articles under a news item, the albums in a gallery block and the single
 * photograph behind a hero. `components/studio/fields/LinkField.tsx` uses it to suggest pages and to
 * warn about a link that goes nowhere. Between them that is every hand-picked list in the CMS, so
 * this one handler being absent means not one relation can be set anywhere.
 *
 * THE TYPES COME FROM THE CLIENT, ON PURPOSE. `LookupItem`, `LookupResponse` and `LookupKind` are
 * imported from EntityPicker rather than restated here, so the two halves of the contract cannot
 * drift into two different ideas of what a row looks like. EntityPicker is a `"use client"` module,
 * which is safe for a TYPE-ONLY import — the import is erased at compile time and nothing from that
 * module reaches this file at runtime. Its runtime exports (`LOOKUP_KINDS`, `LOOKUP_NOUNS`) are
 * deliberately NOT imported: on the server a client module is replaced by a reference stub, so
 * reading a value out of one would fail at request time. The 13 kinds are therefore listed once here,
 * as the keys of `LOOKUPS`, and `satisfies Record<LookupKind, Lookup>` makes a missing or misspelled
 * kind a compile error rather than a picker that 422s.
 *
 * THREE QUESTIONS, ALL `GET`. A read needs no same-origin assertion (lib/api.ts):
 *
 *   ?type=person&q=anita&limit=20    search by name
 *   ?type=person&ids=a,b,c           resolve chosen ids to their titles
 *   ?type=page&path=%2Fabout         is anything published at this address?
 *
 * FIVE RULES THE CLIENT DEPENDS ON, each of which is a bug if it is broken:
 *
 *  1. **`total` is the count BEFORE the limit.** The picker prints "showing the first 20 of 312" from
 *     it. Answering `items.length` would make that notice permanently say nothing was left out —
 *     a list that quietly stops is indistinguishable from a place with no records (contract §1.6).
 *
 *  2. **Drafts are included and every row carries its REAL status.** A draft that is chosen produces
 *     a block that renders nothing to the public, which is the most confusing possible outcome of a
 *     curation choice, so the picker shows a status chip and counts unpublished picks in a sentence.
 *     It can only do that if the answer tells the truth about them.
 *
 *  3. **Soft-deleted rows are excluded.** A record thrown away since it was chosen must FAIL to
 *     resolve, so the picker can show that row as missing and offer to take it out. Filtering it in
 *     would leave the list looking complete while the page rendered one item short.
 *
 *  4. **The ids form answers in the order the ids were given.** Prisma returns `in` results in index
 *     order, not argument order, so an unsorted answer silently rearranges an editor's manual
 *     ordering — the single most confusing possible bug in a curation control. (The client SORTS the
 *     ids to build its cache key and keeps the true order itself, so answering in the requested
 *     sequence is correct as well as deterministic.)
 *
 *  5. **`title` is never empty, `subtitle` is never `undefined`, `status` is `null` where the record
 *     has none, `path` is `""` where there is no public address.** The picker renders all four
 *     without guarding them, because the shape promises they are there.
 *
 * WHY THIS IS A TABLE AND NOT A 13-BRANCH SWITCH. Thirteen near-identical Prisma calls hide an
 * omission: one of them forgets the soft-delete filter, or the status column, or a fallback title,
 * and nothing says so. As one table of descriptors, a missing kind is a compile error and a missing
 * field is visible by reading down a column.
 *
 * THE PERMISSION FLOOR IS `canAuthor`, AND IT IS A FLOOR RATHER THAN A CEILING. A picker lives inside
 * editors, so anybody who may draft anything must be able to use one — requiring editor here would
 * make the people field unusable for the author whose article it is. It is NOT public, though: the
 * answer includes the titles of unpublished work, which is not public information, so an anonymous
 * request is a 401.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

// ─────────────────────────────────────────────────────────────────────────────
// Caps
// ─────────────────────────────────────────────────────────────────────────────

/** How many search results one panel shows when it does not ask. Matches EntityPicker's own default. */
const DEFAULT_LIMIT = 20;

/**
 * The most rows a SEARCH will return, whatever was asked for.
 *
 * Nobody reads past fifty rows in a picker, and an unbounded page size from a client is a denial of
 * service with a database bill attached. The cap is applied silently rather than refused because
 * `total` reports the truth alongside it, so the screen prints "showing the first 50 of 312" and the
 * reader can see exactly what was left out (contract §1.6).
 */
const MAX_SEARCH_LIMIT = 50;

/**
 * The most ids one request may ask to resolve.
 *
 * Exceeding it is REFUSED rather than truncated, which is the opposite of the search cap and for a
 * concrete reason: an id that comes back unresolved is displayed as "deleted, take it out", so
 * quietly dropping the tail of the list would invite an editor to tidy away twenty perfectly good
 * picks. A refusal is shown by the picker as a sentence saying nothing has been lost. No field in the
 * studio allows a list this long, so in practice this only ever fires on a malformed request.
 */
const MAX_IDS = 100;

/** A cuid is 25 characters; 40 each is generous and stops a pasted document becoming a query string. */
const MAX_IDS_CHARS = MAX_IDS * 40;

/** Subtitles are one truncated line on screen, so there is nothing to gain from sending more. */
const MAX_SUBTITLE_CHARS = 140;

// ─────────────────────────────────────────────────────────────────────────────
// The query
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A bounded whole number from a query string, VALIDATED AS A STRING and converted at the call site.
 *
 * The house pattern, for the reason app/api/studio/media/route.ts sets out: `parseQuery` takes a
 * `ZodSchema<T>`, whose input and output types are the same `T`, so a `.default()` or a `.transform()`
 * makes the two differ and the call stops type-checking. `.refine()` does not. It also produces a
 * better message than coercion, which answers `?limit=abc` with "Expected number, received nan" — a
 * sentence about JavaScript, shown to somebody who edited a URL.
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

/** The paired conversion. Safe because `boundedInt` has already proved the shape and the range. */
function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** The chosen ids, de-duplicated, in the order they were sent. Order is the whole point — see rule 4. */
function readIdList(raw: string): string[] {
  return unique(
    raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
  );
}

const LookupQuery = z.object({
  /**
   * Validated as a plain string and checked against `LOOKUPS` below, rather than as a `z.enum`.
   * The table is the only list of kinds in this file, and deriving the enum from it would need a cast
   * that could disagree with it. The refusal names what was asked for, so a mistyped `type` in a
   * client is obvious from the response alone.
   */
  type: z.string().trim().min(1, "Say which kind of record to look for.").max(40),
  q: z.string().trim().max(160, "That search is too long. Try fewer words.").optional(),
  ids: z
    .string()
    .trim()
    .max(MAX_IDS_CHARS, "That list of chosen items is longer than this can look up at once.")
    .refine(
      (value) => readIdList(value).length <= MAX_IDS,
      `Only ${MAX_IDS} chosen items can be looked up at once. Take some out of this list, or split it between two blocks.`
    )
    .optional(),
  path: z.string().trim().max(512, "That address is too long to look up.").optional(),
  limit: boundedInt("The number of results", 1, MAX_IDS)
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared pieces of a row
// ─────────────────────────────────────────────────────────────────────────────

/** A case-insensitive "contains". `mode` is what makes it case-insensitive on Postgres. */
const like = (term: string) => ({ contains: term, mode: "insensitive" as const });

/**
 * The `OR` for a search, or `undefined` when there is nothing to search for.
 *
 * `undefined` and not `[]`: Prisma reads an absent key as "no filter" and an empty `OR: []` as "match
 * nothing", so answering `[]` for a cleared search box would report that the studio contains no
 * records at all. `contains: ""` is the other trap — it matches every row through a `LIKE '%%'` scan
 * that no index can serve.
 */
function searchOr<T>(term: string, clauses: T[]): T[] | undefined {
  return term.length === 0 ? undefined : clauses;
}

/** `id IN (…)` for the resolve form; no id filter at all for a search. */
function onlyIds(ids: readonly string[] | null): { in: string[] } | undefined {
  return ids === null ? undefined : { in: [...ids] };
}

/**
 * Most recently changed first, with `id` as a tiebreaker.
 *
 * The tiebreaker is not decoration: two rows saved in the same millisecond have no defined order, so
 * without it the "most recent twenty" can differ between two identical requests and read as data
 * changing under the reader.
 */
const RECENT_FIRST = [{ updatedAt: "desc" as const }, { id: "desc" as const }];

/** The first candidate with any text in it. `title` is never empty (LookupItem), so the id is last. */
function firstText(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    const text = candidate?.trim() ?? "";
    if (text.length > 0) return text;
  }
  return "";
}

/**
 * A subtitle from the parts that exist, or `""`.
 *
 * `""` and never `undefined`: the picker renders `item.subtitle.length > 0` without guarding it.
 * Truncated because it is drawn as one clipped line — sending a 2000-character summary fifty times
 * over would be fifty times the bytes for text nobody can read.
 */
function line(...parts: Array<string | null | undefined>): string {
  const joined = parts
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0)
    .join(" · ");
  return truncateWords(joined, MAX_SUBTITLE_CHARS);
}

/**
 * A record that is switched off is a record that will not appear, and nothing else on the row says so.
 *
 * `Person.isVisible` and `Partner.isVisible` hide a row from every public listing regardless of its
 * publication state, so a published-but-hidden person chosen for a people block is the same
 * disappointment as a draft one. The picker's status chip cannot express it, so it is said in words in
 * the second line instead.
 */
function hiddenNote(isVisible: boolean): string | null {
  return isVisible ? null : "Hidden from the site";
}

/** Why a chosen file may not be downloadable. At most one phrase, worst first. */
function fileAccessNote(
  file: { isPublic: boolean; expiresAt: Date | null },
  now: Date
): string | null {
  if (file.expiresAt && file.expiresAt.getTime() <= now.getTime()) return "The download has expired";
  if (!file.isPublic) return "Not public yet";
  return null;
}

/**
 * A day, in UTC.
 *
 * The Centre's timezone is a SETTING (prisma/schema.prisma, `CoeEvent`) and the site renders event
 * times through it. This is only a caption telling one event apart from another, so it is formatted
 * against UTC rather than reading a setting on every lookup — the authoritative time is on the
 * event's own screen, and a subtitle is not a source of truth.
 */
const DAY_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC"
});

/** `width` and `height` are null for audio and for anything that failed to probe. */
function dimensions(row: { width: number | null; height: number | null }): string | null {
  if (row.width === null || row.height === null) return null;
  return `${row.width} × ${row.height}`;
}

/**
 * The six media kinds in the words the media library uses.
 *
 * `satisfies Record<MediaKind, string>` rather than an annotation, so adding a kind to the Prisma
 * enum without adding it here is a compile error rather than a blank subtitle. The same list lives in
 * `MEDIA_KIND_LABELS` in components/studio/media/MediaGrid.tsx; it is duplicated rather than imported
 * because that module is a client component and its runtime exports cannot be read from a route.
 */
const MEDIA_KIND_WORDS = {
  IMAGE: "Image",
  VIDEO: "Video",
  AUDIO: "Audio recording",
  DOCUMENT: "Document",
  MODEL_3D: "3D model",
  PANORAMA: "Panorama"
} satisfies Record<MediaKind, string>;

/**
 * Everything `MediaImage` needs to choose a size, and nothing else.
 *
 * The variants come with it because the picker draws a 56px thumbnail: without them `mediaSrc` falls
 * back to the ORIGINAL, and a 4000px original in a 56px box is several megabytes per row.
 */
const MEDIA_SELECT = MEDIA_IMAGE_SELECT satisfies Prisma.MediaAssetSelect;

// ─────────────────────────────────────────────────────────────────────────────
// The per-kind table
// ─────────────────────────────────────────────────────────────────────────────

interface LookupSource<Where> {
  /**
   * Everything that narrows the query: the soft-delete exclusion, the search term, and the explicit
   * id list when one was asked for.
   *
   * ONE builder for both questions on purpose. Two — a `where` for searching and another for
   * resolving — is how the soft-delete filter comes to be present in one and missing from the other,
   * which would resurrect binned records in the chosen list while hiding them from the search.
   */
  where: (term: string, ids: readonly string[] | null) => Where;
  /** One page of rows, already in the client's shape. Most recently changed first. */
  list: (where: Where, take: number) => Promise<LookupItem[]>;
  /** How many rows match, before `take`. This is what `total` is (rule 1). */
  count: (where: Where) => Promise<number>;
}

interface Lookup {
  search: (term: string, take: number) => Promise<LookupResponse>;
  resolve: (ids: readonly string[]) => Promise<LookupItem[]>;
}

/**
 * Turn one descriptor into the two questions, so neither is written thirteen times.
 *
 * The generic is erased here — the same trick `defineSource` uses in lib/search/index.ts — which is
 * what lets thirteen differently-typed Prisma delegates live in one object without a cast.
 */
function defineLookup<Where>(source: LookupSource<Where>): Lookup {
  return {
    search: async (term, take) => {
      const where = source.where(term, null);
      // The count runs against the SAME `where` as the rows, so `total` cannot describe a different
      // question from the one the list answered.
      const [items, total] = await Promise.all([source.list(where, take), source.count(where)]);
      return { items, total };
    },
    resolve: async (ids) => {
      if (ids.length === 0) return [];
      // The window is the number of ids, and `?limit=` is deliberately ignored here. The client sends
      // `limit=<ids.length>` on this form, and honouring a smaller number would hand back fewer rows
      // than were asked about — every id left out is then drawn as "deleted, take it out", which
      // invites an editor to tidy away picks that are perfectly fine.
      const found = await source.list(source.where("", ids), ids.length);
      const byId = new Map(found.map((item) => [item.id, item]));

      // RULE 4. Walking the requested ids rather than the rows is what preserves the editor's
      // arrangement; an id with no row is left out entirely, which is how the picker knows to show it
      // as deleted.
      const ordered: LookupItem[] = [];
      for (const id of ids) {
        const item = byId.get(id);
        if (item !== undefined) ordered.push(item);
      }
      return ordered;
    }
  };
}

/** The columns a page lookup needs. Named because the `path` question shares them with the table. */
const PAGE_SELECT = {
  id: true,
  title: true,
  navLabel: true,
  slug: true,
  status: true
} satisfies Prisma.PageSelect;

type PageRow = Prisma.PageGetPayload<{ select: typeof PAGE_SELECT }>;

/**
 * One page as the client sees it.
 *
 * The address is repeated in the subtitle because that is the field an editor recognises a page by —
 * two pages called "Overview" are told apart by `/research/overview` and nothing else. No thumbnail:
 * a page's only picture is its social-sharing image, which is not a picture OF the page and would
 * read as one.
 */
function pageItem(row: PageRow): LookupItem {
  const path = searchUrlFor("page", row.slug);
  return {
    id: row.id,
    title: firstText(row.title, row.navLabel, row.slug, row.id),
    subtitle: row.slug.length === 0 ? "The site's front page" : path,
    status: row.status,
    path,
    media: null
  };
}

/**
 * Every table a picker can search, and how to describe a row of it.
 *
 * `satisfies Record<LookupKind, Lookup>` is doing real work: `LookupKind` comes from EntityPicker, so
 * a kind the picker offers and this table has forgotten will not compile, and a kind here that the
 * picker does not offer will not either.
 */
const LOOKUPS = {
  person: defineLookup({
    where: (term, ids): Prisma.PersonWhereInput => ({
      deletedAt: null,
      id: onlyIds(ids),
      OR: searchOr(term, [{ name: like(term) }, { designation: like(term) }])
    }),
    count: (where) => prisma.person.count({ where }),
    list: async (where, take) => {
      const rows = await prisma.person.findMany({
        where,
        take,
        orderBy: RECENT_FIRST,
        select: {
          id: true,
          name: true,
          designation: true,
          department: true,
          isVisible: true,
          status: true,
          slug: true,
          photo: { select: MEDIA_SELECT }
        }
      });
      return rows.map((row) => ({
        id: row.id,
        title: firstText(row.name, row.id),
        subtitle: line(row.designation, row.department, hiddenNote(row.isVisible)),
        status: row.status,
        path: searchUrlFor("person", row.slug),
        media: row.photo
      }));
    }
  }),

  project: defineLookup({
    where: (term, ids): Prisma.ProjectWhereInput => ({
      deletedAt: null,
      id: onlyIds(ids),
      OR: searchOr(term, [{ title: like(term) }, { tagline: like(term) }])
    }),
    count: (where) => prisma.project.count({ where }),
    list: async (where, take) => {
      const rows = await prisma.project.findMany({
        where,
        take,
        orderBy: RECENT_FIRST,
        select: {
          id: true,
          title: true,
          tagline: true,
          summary: true,
          status: true,
          slug: true,
          cover: { select: MEDIA_SELECT }
        }
      });
      return rows.map((row) => ({
        id: row.id,
        title: firstText(row.title, row.id),
        subtitle: line(row.tagline ?? row.summary),
        status: row.status,
        path: searchUrlFor("project", row.slug),
        media: row.cover
      }));
    }
  }),

  publication: defineLookup({
    where: (term, ids): Prisma.PublicationWhereInput => ({
      deletedAt: null,
      id: onlyIds(ids),
      OR: searchOr(term, [
        { title: like(term) },
        { authorLine: like(term) },
        { venue: like(term) }
      ])
    }),
    count: (where) => prisma.publication.count({ where }),
    list: async (where, take) => {
      const rows = await prisma.publication.findMany({
        where,
        take,
        orderBy: RECENT_FIRST,
        select: {
          id: true,
          title: true,
          venue: true,
          publisher: true,
          year: true,
          status: true,
          slug: true
        }
      });
      // Where and when, which is what tells two papers with similar titles apart. Publications carry
      // no cover image in the schema, so there is nothing to show beside them.
      return rows.map((row) => ({
        id: row.id,
        title: firstText(row.title, row.id),
        subtitle: line(row.venue ?? row.publisher, String(row.year)),
        status: row.status,
        path: searchUrlFor("publication", row.slug),
        media: null
      }));
    }
  }),

  news: defineLookup({
    where: (term, ids): Prisma.PostWhereInput => ({
      deletedAt: null,
      id: onlyIds(ids),
      OR: searchOr(term, [{ title: like(term) }, { subtitle: like(term) }])
    }),
    count: (where) => prisma.post.count({ where }),
    list: async (where, take) => {
      const rows = await prisma.post.findMany({
        where,
        take,
        orderBy: RECENT_FIRST,
        select: {
          id: true,
          title: true,
          subtitle: true,
          excerpt: true,
          status: true,
          slug: true,
          cover: { select: MEDIA_SELECT }
        }
      });
      return rows.map((row) => ({
        id: row.id,
        title: firstText(row.title, row.id),
        subtitle: line(row.subtitle ?? row.excerpt),
        status: row.status,
        path: searchUrlFor("post", row.slug),
        media: row.cover
      }));
    }
  }),

  event: defineLookup({
    where: (term, ids): Prisma.CoeEventWhereInput => ({
      deletedAt: null,
      id: onlyIds(ids),
      OR: searchOr(term, [{ title: like(term) }, { subtitle: like(term) }, { venue: like(term) }])
    }),
    count: (where) => prisma.coeEvent.count({ where }),
    list: async (where, take) => {
      const rows = await prisma.coeEvent.findMany({
        where,
        take,
        orderBy: RECENT_FIRST,
        select: {
          id: true,
          title: true,
          startsAt: true,
          venue: true,
          status: true,
          slug: true,
          cover: { select: MEDIA_SELECT }
        }
      });
      // The date first: an annual seminar has the same title every year and the year is the only
      // thing that distinguishes the right one.
      return rows.map((row) => ({
        id: row.id,
        title: firstText(row.title, row.id),
        subtitle: line(DAY_FORMAT.format(row.startsAt), row.venue),
        status: row.status,
        path: searchUrlFor("event", row.slug),
        media: row.cover
      }));
    }
  }),

  craft: defineLookup({
    where: (term, ids): Prisma.CraftWhereInput => ({
      deletedAt: null,
      id: onlyIds(ids),
      OR: searchOr(term, [{ name: like(term) }, { localName: like(term) }])
    }),
    count: (where) => prisma.craft.count({ where }),
    list: async (where, take) => {
      const rows = await prisma.craft.findMany({
        where,
        take,
        orderBy: RECENT_FIRST,
        select: {
          id: true,
          name: true,
          localName: true,
          status: true,
          slug: true,
          cover: { select: MEDIA_SELECT },
          region: { select: { name: true } }
        }
      });
      // The local name is searched and shown as written, in its own script: somebody who knows the
      // craft by that name has to be able to find it by typing it.
      return rows.map((row) => ({
        id: row.id,
        title: firstText(row.name, row.id),
        subtitle: line(row.localName, row.region?.name),
        status: row.status,
        path: searchUrlFor("craft", row.slug),
        media: row.cover
      }));
    }
  }),

  album: defineLookup({
    where: (term, ids): Prisma.GalleryAlbumWhereInput => ({
      deletedAt: null,
      id: onlyIds(ids),
      OR: searchOr(term, [{ title: like(term) }, { location: like(term) }])
    }),
    count: (where) => prisma.galleryAlbum.count({ where }),
    list: async (where, take) => {
      const rows = await prisma.galleryAlbum.findMany({
        where,
        take,
        orderBy: RECENT_FIRST,
        select: {
          id: true,
          title: true,
          category: true,
          location: true,
          status: true,
          slug: true,
          cover: { select: MEDIA_SELECT }
        }
      });
      return rows.map((row) => ({
        id: row.id,
        title: firstText(row.title, row.id),
        subtitle: line(row.category, row.location),
        status: row.status,
        path: searchUrlFor("album", row.slug),
        media: row.cover
      }));
    }
  }),

  /**
   * A single picture inside an album — `GalleryItem`, not `MediaAsset`.
   *
   * Three things are unlike every other kind here, and all three follow from the same fact: the
   * picture has no life of its own.
   *
   *   • It has no `deletedAt` and no `status`. Its ALBUM has both, so the soft-delete filter and the
   *     status chip reach through the relation. A picture in a draft album will not appear on the
   *     public site, and the picker has to be able to say so.
   *   • Its public address is the album's page, because there is no page for one photograph.
   *   • Its caption is optional, so the title falls back to the file name — an editor recognises
   *     "convocation-2026-032.jpg" and recognises nothing at all in a cuid.
   */
  galleryImage: defineLookup({
    where: (term, ids): Prisma.GalleryItemWhereInput => ({
      album: { deletedAt: null },
      id: onlyIds(ids),
      OR: searchOr(term, [
        { caption: like(term) },
        { asset: { fileName: like(term) } },
        { album: { title: like(term) } }
      ])
    }),
    count: (where) => prisma.galleryItem.count({ where }),
    list: async (where, take) => {
      const rows = await prisma.galleryItem.findMany({
        where,
        take,
        // `GalleryItem` has no timestamps of its own, so "most recent" is its album's, and `position`
        // keeps one album's pictures in the order an editor arranged them.
        orderBy: [
          { album: { updatedAt: "desc" as const } },
          { position: "asc" as const },
          { id: "desc" as const }
        ],
        select: {
          id: true,
          caption: true,
          album: { select: { title: true, slug: true, status: true } },
          asset: { select: { fileName: true, ...MEDIA_SELECT } }
        }
      });
      return rows.map((row) => ({
        id: row.id,
        title: firstText(row.caption, row.asset.fileName, row.id),
        subtitle: line(row.album.title),
        status: row.album.status,
        path: searchUrlFor("album", row.album.slug),
        media: row.asset
      }));
    }
  }),

  research: defineLookup({
    where: (term, ids): Prisma.ResearchAreaWhereInput => ({
      deletedAt: null,
      id: onlyIds(ids),
      OR: searchOr(term, [{ title: like(term) }, { summary: like(term) }])
    }),
    count: (where) => prisma.researchArea.count({ where }),
    list: async (where, take) => {
      const rows = await prisma.researchArea.findMany({
        where,
        take,
        orderBy: RECENT_FIRST,
        select: {
          id: true,
          title: true,
          summary: true,
          status: true,
          slug: true,
          cover: { select: MEDIA_SELECT }
        }
      });
      return rows.map((row) => ({
        id: row.id,
        title: firstText(row.title, row.id),
        subtitle: line(row.summary),
        status: row.status,
        path: searchUrlFor("research-area", row.slug),
        media: row.cover
      }));
    }
  }),

  /**
   * Partners have no publication state and no public page of their own.
   *
   * `status` is therefore `null` — the picker draws no chip rather than an invented one — and `path`
   * is `""`, because a partner appears inside other pages and has no address to link to. Whether a
   * partner is hidden IS said, in the second line, since that is the one thing that would otherwise
   * make a chosen partner silently fail to appear.
   */
  partner: defineLookup({
    where: (term, ids): Prisma.PartnerWhereInput => ({
      deletedAt: null,
      id: onlyIds(ids),
      OR: searchOr(term, [{ name: like(term) }, { category: like(term) }])
    }),
    count: (where) => prisma.partner.count({ where }),
    list: async (where, take) => {
      const rows = await prisma.partner.findMany({
        where,
        take,
        orderBy: RECENT_FIRST,
        select: {
          id: true,
          name: true,
          category: true,
          isVisible: true,
          logo: { select: MEDIA_SELECT }
        }
      });
      return rows.map((row) => ({
        id: row.id,
        title: firstText(row.name, row.id),
        subtitle: line(row.category, hiddenNote(row.isVisible)),
        status: null,
        path: "",
        media: row.logo
      }));
    }
  }),

  /**
   * Files carry no `ContentStatus`, so `status` is `null`; what decides whether anybody can download
   * one is `isPublic` and `expiresAt`, and both are said in words instead.
   *
   * The size comes from the LATEST version — a file is versioned (prisma/schema.prisma), and the
   * figure an editor is looking at should be the one that would be downloaded today.
   */
  file: defineLookup({
    where: (term, ids): Prisma.FileAssetWhereInput => ({
      deletedAt: null,
      id: onlyIds(ids),
      OR: searchOr(term, [{ title: like(term) }, { description: like(term) }])
    }),
    count: (where) => prisma.fileAsset.count({ where }),
    list: async (where, take) => {
      const now = new Date();
      const rows = await prisma.fileAsset.findMany({
        where,
        take,
        orderBy: RECENT_FIRST,
        select: {
          id: true,
          title: true,
          category: true,
          isPublic: true,
          expiresAt: true,
          slug: true,
          versions: {
            orderBy: { version: "desc" },
            take: 1,
            select: { fileName: true, byteSize: true }
          }
        }
      });
      return rows.map((row) => {
        // A file with no version row has been created but never uploaded to. That is a real state in
        // the studio, so the size and the file name are both simply absent rather than assumed.
        const latest = row.versions[0];
        return {
          id: row.id,
          title: firstText(row.title, latest?.fileName, row.id),
          subtitle: line(
            row.category,
            latest ? formatBytes(latest.byteSize) : null,
            fileAccessNote(row, now)
          ),
          status: null,
          path: searchUrlFor("file", row.slug),
          media: null
        };
      });
    }
  }),

  /**
   * A picture or video in the media library. Here the row IS the asset, so it is its own thumbnail.
   *
   * The title is the FILE NAME rather than the alt text: the library lists file names, so that is
   * what an editor is looking for. The alt text and caption are still searched, because "the one with
   * the loom in it" is how somebody remembers a photograph they described months ago.
   */
  media: defineLookup({
    where: (term, ids): Prisma.MediaAssetWhereInput => ({
      deletedAt: null,
      id: onlyIds(ids),
      OR: searchOr(term, [
        { fileName: like(term) },
        { altText: like(term) },
        { caption: like(term) }
      ])
    }),
    count: (where) => prisma.mediaAsset.count({ where }),
    list: async (where, take) => {
      const rows = await prisma.mediaAsset.findMany({
        where,
        take,
        orderBy: RECENT_FIRST,
        select: { id: true, fileName: true, kind: true, byteSize: true, ...MEDIA_SELECT }
      });
      return rows.map((row) => ({
        id: row.id,
        title: firstText(row.fileName, row.id),
        subtitle: line(MEDIA_KIND_WORDS[row.kind], dimensions(row), formatBytes(row.byteSize)),
        // A picture is not published or unpublished; it appears wherever it has been placed.
        status: null,
        // The library is inside the studio, so there is no public address to offer.
        path: "",
        media: row
      }));
    }
  }),

  page: defineLookup({
    where: (term, ids): Prisma.PageWhereInput => ({
      deletedAt: null,
      id: onlyIds(ids),
      // The slug is searched as well as the title, because an editor looking for a link very often
      // remembers the address rather than the heading.
      OR: searchOr(term, [{ title: like(term) }, { navLabel: like(term) }, { slug: like(term) }])
    }),
    count: (where) => prisma.page.count({ where }),
    list: async (where, take) => {
      const rows = await prisma.page.findMany({
        where,
        take,
        orderBy: RECENT_FIRST,
        select: PAGE_SELECT
      });
      return rows.map(pageItem);
    }
  })
} satisfies Record<LookupKind, Lookup>;

function isLookupKind(value: string): value is LookupKind {
  return Object.prototype.hasOwnProperty.call(LOOKUPS, value);
}

// ─────────────────────────────────────────────────────────────────────────────
// "Is anything published at this address?"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `Page.slug` is a full path WITHOUT a leading slash, and `""` is the homepage (prisma/schema.prisma).
 * The client sends what an editor typed into a link box, so both slashes come off here.
 */
function slugFromPath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * The third question, and the only one that filters by publication state.
 *
 * ⚠ IT ANSWERS "PUBLISHED", NOT "EXISTS", and that is deliberate. `LinkField` renders the answer as
 * "Goes to About the Centre on this site" in green, or as a warning that anyone following the link
 * will see a page not found. A draft page reported as a match would produce the green sentence for an
 * address that 404s for every reader — a confident wrong answer, which that file's own header calls
 * worse than an honest "not checked". So a page that is not live reads as nothing there, and the
 * warning it produces is true today: the link does not work yet.
 *
 * `livePublishableWhere()` and not `status: "PUBLISHED"`: `Page` carries `publishAt`/`unpublishAt`,
 * publication is resolved at READ time (lib/content.ts), and a page whose embargo has lapsed is
 * already gone from the site whatever its status column still says.
 *
 * It always answers 200 with a possibly-empty list, never a 404. The client tells "no page there"
 * from "the check has not finished" by the presence of a body, so a 404 would be read as a broken
 * endpoint and the warning would never appear.
 */
async function publishedPageAt(path: string): Promise<LookupResponse> {
  const row = await prisma.page.findFirst({
    where: { ...livePublishableWhere(), slug: slugFromPath(path) },
    select: PAGE_SELECT
  });
  return row ? { items: [pageItem(row)], total: 1 } : { items: [], total: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `private, no-store` on every answer.
 *
 * The body contains the titles of unpublished work, so no shared cache and no browser history entry
 * may keep a copy of it for the next person at this computer. The client already asks for `no-store`
 * (lib/client/fetcher.ts); this is the half the server owes, and it is the half a proxy obeys.
 */
function answer(payload: LookupResponse) {
  return ok(payload, { headers: { "cache-control": "private, no-store" } });
}

export const GET = route(async (request: Request) => {
  // No `assertSameOrigin`: this is a read, and it changes nothing (contract §9).
  await requireCapability(
    canAuthor,
    "Choosing which records to show needs author access or higher. An administrator can raise yours."
  );

  const query = parseQuery(request, LookupQuery);

  if (!isLookupKind(query.type)) {
    throw badRequest(`There is no kind of record called “${query.type}” to look up.`);
  }
  const lookup = LOOKUPS[query.type];

  // ── The address question ──────────────────────────────────────────────────
  // Tested on PRESENCE, not on emptiness: `""` is the homepage's own address, and `buildQuery` in
  // lib/client/fetcher.ts drops an empty value, so a request for the homepage arrives with no `path`
  // at all and is correctly read as a search instead.
  if (query.path !== undefined) {
    if (query.type !== "page") {
      throw badRequest(
        "Only pages can be looked up by their address. Everything else is found by name."
      );
    }
    return answer(await publishedPageAt(query.path));
  }

  // ── The chosen-ids question ───────────────────────────────────────────────
  if (query.ids !== undefined) {
    const ids = readIdList(query.ids);
    const items = await lookup.resolve(ids);
    // `total` is what was FOUND, which is at most what was asked for: the resolve form takes exactly
    // the ids it was given, so there is nothing beyond the answer for a truncation notice to report.
    return answer({ items, total: items.length });
  }

  // ── The search ────────────────────────────────────────────────────────────
  // An empty search is "the most recently changed", NOT the whole table: the picker opens with the
  // box empty and has to show something useful without reading every row in the database.
  const term = query.q ?? "";
  const take = Math.min(toInt(query.limit, DEFAULT_LIMIT), MAX_SEARCH_LIMIT);
  return answer(await lookup.search(term, take));
});
