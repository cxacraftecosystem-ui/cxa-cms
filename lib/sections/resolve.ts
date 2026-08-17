import "server-only";

import type { PageSection, Prisma } from "@prisma/client";

import { livePublishableWhere, liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { MEDIA_IMAGE_SELECT } from "@/lib/media/select";
import { screenFramingMediaIds } from "@/lib/media/screens";
import { getSettingCached } from "@/lib/settings/service";
import {
  CENSUS_METRICS,
  parseSectionData,
  type CensusMetric,
  type StatsSectionData,
  type CraftExplorerSectionData,
  type DocumentEmbedSectionData,
  type DownloadsSectionData,
  type EventShowcaseSectionData,
  type GallerySectionData,
  type HeroSectionData,
  type MediaSplitSectionData,
  type NewsShowcaseSectionData,
  type PartnerLogosSectionData,
  type PeopleShowcaseSectionData,
  type ProjectShowcaseSectionData,
  type PublicationListSectionData,
  type QuoteSectionData,
  type ResearchShowcaseSectionData,
  type RichTextSectionData,
  type TimelineSectionData,
  type StoryScrollSectionData,
  type ParallaxBannerSectionData,
  type HorizontalRailSectionData,
  type ProcessStepsSectionData
} from "@/lib/sections/schema";

/**
 * ONE batched pass that fetches every database row a page's blocks need.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS AT ALL
 *
 * A showcase renderer that queried for itself would turn a four-showcase page into four sequential
 * round trips, and a page builder can legitimately place two news blocks with different limits on one
 * page. So the renderers are pure: they are handed their rows and never touch `lib/db`. This module is
 * the only thing on the public site that knows how a curation mode becomes a query.
 *
 * THE THREE CURATION MODES, AND THE ONE THAT IS EASY TO GET WRONG
 *
 *   latest    — the record type's own "newest" ordering, described to the editor in the schema's help
 *               text. That wording is a PROMISE: projects say "most recently started first", people
 *               say "in the order set on the people page". The orderings below follow the help text,
 *               not a uniform `publishedAt desc`, because the help text is what the editor read.
 *   featured  — `isFeatured`, in the same ordering. Three record types have no such column; each one
 *               says so at its call site rather than failing quietly.
 *   manual    — `where id in ids`, AND THE RESULT IS RE-SORTED INTO THE ORDER OF `ids`. Postgres
 *               returns rows from an `IN` list in index order, never in the order of the list, so
 *               without `orderByIds` below a hand-curated block would silently ignore the arrangement
 *               the editor dragged into place — the single most confusing bug possible in a page
 *               builder, because everything looks saved and nothing looks broken.
 *
 * A manual id that no longer resolves — deleted, unpublished, embargo expired — is DROPPED, and the
 * number dropped is returned as `droppedIds` so the studio's preview can say "2 of the items you
 * picked are no longer published" instead of quietly rendering a shorter row.
 *
 * `total` IS RETURNED FOR THE SAME REASON. Every showcase carries a `limit` whose help text promises
 * "where there are more, the block says how many, so a shortened list never reads as the whole list"
 * (contract §1.6). A renderer cannot keep that promise without knowing how many rows matched, so
 * every automatic group runs a `count` beside its `findMany`.
 *
 * ONE ROUND TRIP, NOT ONE QUERY PER BLOCK
 *
 * Blocks with identical criteria share a query (deduplicated by `groupKey`, taking the largest limit
 * and slicing per block); blocks with different criteria genuinely need different SQL. All of it is
 * then issued inside a single `prisma.$transaction([...])`, which is one round trip AND one
 * consistent snapshot — so two blocks on the same page can never disagree about what is published.
 *
 * MANUAL MODE IGNORES THE AUXILIARY FILTERS (a project block's `state`, a people block's `kind`) but
 * never the publication filters. An editor who hand-picked a completed project into an "Active work"
 * block chose that deliberately; dropping it for failing a filter they did not think applied is a
 * disappearance with no explanation. Publication state is not theirs to override.
 *
 * PARTNERS AND FILES HAVE NO `status` COLUMN, so `liveStatusWhere()` on them would be a Prisma
 * RUNTIME error rather than a type error (contract §9 — that is exactly why there are two filter
 * functions). They gate on `isVisible` / `isPublic` + `expiresAt` instead.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────────────────────
// The shape every showcase renderer is typed against
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One block's resolved rows.
 *
 * The three fields are exactly the three props every showcase renderer accepts, so a page renderer
 * spreads them straight in:
 *
 *   <ProjectShowcaseSection data={data} section={section}
 *                           {...showcaseFor(resolved.projects, section.id)} />
 */
export interface ResolvedShowcase<T> {
  /** The rows to render, already limited and already in the order the block asked for. */
  rows: T[];
  /** How many rows match the block's criteria in total, IGNORING `limit`. Never less than `rows.length`. */
  total: number;
  /** Hand-picked ids that no longer resolve. Always zero in `latest` and `featured` modes. */
  droppedIds: number;
}

/**
 * A fresh empty result each call, never a shared constant.
 *
 * `rows` is a mutable array in the type, and a single shared `[]` handed to every unresolved block is
 * one `push` away from every empty showcase on the site gaining a row. One allocation on a path that
 * renders nothing is not worth defending.
 */
function emptyShowcase<T>(): ResolvedShowcase<T> {
  return { rows: [], total: 0, droppedIds: 0 };
}

/**
 * The rows for one block, or an empty result.
 *
 * Never returns `undefined`: a renderer forced to cope with three states — rows, no rows, and "the
 * resolver never ran for this block" — grows a branch nobody can test. A block that was not resolved
 * renders its own empty state, which is the truthful thing to show.
 */
export function showcaseFor<T>(
  map: ReadonlyMap<string, ResolvedShowcase<T>>,
  sectionId: string
): ResolvedShowcase<T> {
  return map.get(sectionId) ?? emptyShowcase<T>();
}

/**
 * The same answer, for a renderer that can be called two ways.
 *
 * `components/sections/SectionRenderer.tsx` dispatches every block with ONE uniform prop shape —
 * `{ data, section, resolved }` — because a per-type shape would need a per-type call site, which is
 * the `switch` the typed map exists to replace. But a showcase renderer is also legitimately called
 * with its rows handed to it directly: that is how the studio previews a block it has not saved, and
 * how a bespoke page composes one showcase without resolving a whole page of them.
 *
 * So both are supported, and the precedence is explicit: an explicit `rows` array WINS, because a
 * caller who passed one meant it. `total` defaults to the length of what was passed rather than to
 * zero — a caller who knows the rows but not the corpus size is saying "this is all of it", and a
 * zero would make the block announce "showing 3 of 0".
 */
export function pickShowcase<T>(
  map: ReadonlyMap<string, ResolvedShowcase<T>> | undefined,
  sectionId: string,
  explicit?: { rows?: T[]; total?: number; droppedIds?: number }
): ResolvedShowcase<T> {
  if (explicit?.rows) {
    return {
      rows: explicit.rows,
      total: explicit.total ?? explicit.rows.length,
      droppedIds: explicit.droppedIds ?? 0
    };
  }
  if (map) return showcaseFor(map, sectionId);
  return emptyShowcase<T>();
}

// ─────────────────────────────────────────────────────────────────────────────
// Selects — only the columns a card renders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything `<MediaImage>` needs, plus the two columns that describe a DOCUMENT.
 *
 * `variants` is not optional: without it `pickVariant` has nothing to choose from and every image on
 * the page falls back to the full-size ORIGINAL — a 6 MB photograph inside a 320px card. The shape is
 * deliberately a superset of `MediaLike` in lib/media/url.ts, which reads only what it names.
 *
 * ⚠ `fileName` AND `byteSize` ARE READ BY A BLOCK RATHER THAN BY AN IMAGE, and they are here rather
 * than in a select of their own because the media map is ONE batched read keyed by asset id (see
 * `ResolvedSectionData.media`): a second select would mean a second query for assets the page has
 * already fetched. `DOCUMENT_EMBED` needs both — the name a reader recognises and the file saves as,
 * whose extension also decides whether a browser can draw the thing at all, and the size that stops
 * somebody starting a 40 MB download on a telephone. Two small columns on a row the page was already
 * selecting; no new join and no new query.
 *
 * `mimeType` is deliberately NOT here. The format is read off the extension instead, for the reason
 * `DownloadsSection` sets out: a stored type is whatever the uploading browser guessed, and the
 * extension is what an editor actually named the file.
 */
/**
 * ⚠ THE IMAGE COLUMNS COME FROM `MEDIA_IMAGE_SELECT`, NOT FROM A LIST WRITTEN OUT HERE. This module used
 * to spell them out, as forty-three other queries did, and when the crop columns were added to
 * `MediaAsset` not one of those lists learned about them — so every crop an editor drew was fetched by
 * nothing. `MediaLike` makes every field optional, so every one of them still typechecked. Only
 * `fileName` and `byteSize` are local, because only the document block needs them (see the note above).
 */
const mediaSelect = {
  ...MEDIA_IMAGE_SELECT,
  fileName: true,
  byteSize: true
} satisfies Prisma.MediaAssetSelect;

export type MediaRow = Prisma.MediaAssetGetPayload<{ select: typeof mediaSelect }>;

const researchAreaSelect = {
  id: true,
  slug: true,
  title: true,
  summary: true,
  icon: true,
  accentColor: true,
  sortOrder: true,
  cover: { select: mediaSelect }
} satisfies Prisma.ResearchAreaSelect;

export type ResearchAreaRow = Prisma.ResearchAreaGetPayload<{ select: typeof researchAreaSelect }>;

const projectSelect = {
  id: true,
  slug: true,
  title: true,
  tagline: true,
  summary: true,
  state: true,
  progress: true,
  startedOn: true,
  endedOn: true,
  cover: { select: mediaSelect },
  researchArea: { select: { slug: true, title: true } }
} satisfies Prisma.ProjectSelect;

export type ProjectRow = Prisma.ProjectGetPayload<{ select: typeof projectSelect }>;

const personSelect = {
  id: true,
  slug: true,
  name: true,
  kind: true,
  designation: true,
  department: true,
  photo: { select: mediaSelect }
} satisfies Prisma.PersonSelect;

export type PersonRow = Prisma.PersonGetPayload<{ select: typeof personSelect }>;

/**
 * The publication columns a citation needs.
 *
 * Wider than the card looks, because `formatCitation` and `publicationDisplayVenue` in lib/citation.ts
 * read volume, issue, pages, publisher and the identifier columns to punctuate one line correctly.
 * Trimming this to "what is visible" would silently degrade every reference on the page.
 */
const publicationSelect = {
  id: true,
  slug: true,
  kind: true,
  title: true,
  abstract: true,
  authorLine: true,
  venue: true,
  publisher: true,
  volume: true,
  issue: true,
  pages: true,
  year: true,
  month: true,
  doi: true,
  isbn: true,
  issn: true,
  patentNumber: true,
  arxivId: true,
  url: true,
  pdfFileId: true,
  keywords: true
} satisfies Prisma.PublicationSelect;

type PublicationPayload = Prisma.PublicationGetPayload<{ select: typeof publicationSelect }>;

/**
 * A publication plus the SLUG of its PDF, which is not a Prisma relation.
 *
 * `Publication.pdfFileId` is a bare `String?` with no `@relation` in the schema, so it cannot be
 * joined. It is filled in by one follow-up query (`attachPublicationPdfs`) rather than left out — a
 * publications list whose PDF links are all missing looks like a Centre that publishes no PDFs.
 */
export type PublicationRow = PublicationPayload & {
  /** Feeds `/api/public/files/[slug]`, so the download is counted server-side. Null when not public. */
  pdfSlug: string | null;
};

const postSelect = {
  id: true,
  slug: true,
  title: true,
  subtitle: true,
  excerpt: true,
  publishedAt: true,
  publishAt: true,
  readingMinutes: true,
  cover: { select: mediaSelect },
  category: { select: { slug: true, name: true } }
} satisfies Prisma.PostSelect;

export type PostRow = Prisma.PostGetPayload<{ select: typeof postSelect }>;

const eventSelect = {
  id: true,
  slug: true,
  title: true,
  subtitle: true,
  summary: true,
  mode: true,
  venue: true,
  onlineUrl: true,
  startsAt: true,
  endsAt: true,
  registrationUrl: true,
  isRegistrationOpen: true,
  cover: { select: mediaSelect }
} satisfies Prisma.CoeEventSelect;

export type EventRow = Prisma.CoeEventGetPayload<{ select: typeof eventSelect }>;

const partnerSelect = {
  id: true,
  slug: true,
  name: true,
  url: true,
  category: true,
  logo: { select: mediaSelect }
} satisfies Prisma.PartnerSelect;

export type PartnerRow = Prisma.PartnerGetPayload<{ select: typeof partnerSelect }>;

/**
 * A downloadable file with ONLY its newest version.
 *
 * `take: 1` over a descending version order, because a downloads block shows what you would get if
 * you clicked, and the download route resolves the newest version too. Older versions stay reachable
 * by citation — that is what `FileVersion` is for — but they are not what this block is about.
 */
const fileSelect = {
  id: true,
  title: true,
  slug: true,
  description: true,
  category: true,
  updatedAt: true,
  createdAt: true,
  versions: {
    orderBy: { version: "desc" },
    take: 1,
    select: { version: true, fileName: true, mimeType: true, byteSize: true, createdAt: true }
  }
} satisfies Prisma.FileAssetSelect;

export type FileRow = Prisma.FileAssetGetPayload<{ select: typeof fileSelect }>;

const albumSelect = {
  id: true,
  slug: true,
  title: true,
  description: true,
  category: true,
  location: true,
  happenedOn: true,
  cover: { select: mediaSelect },
  _count: { select: { items: true } }
} satisfies Prisma.GalleryAlbumSelect;

type AlbumPayload = Prisma.GalleryAlbumGetPayload<{ select: typeof albumSelect }>;

/** `itemCount` is flattened out of `_count` so a card reads `album.itemCount` rather than reaching
 *  into a Prisma-shaped aggregate that means nothing to a renderer. */
export type AlbumRow = AlbumPayload & { itemCount: number };

const galleryItemSelect = {
  id: true,
  caption: true,
  presentation: true,
  position: true,
  // `credit` beyond the shared media select: a lightbox names the photographer under the picture,
  // and an uncredited photograph in an archive is a rights problem as much as a courtesy one.
  asset: { select: { ...mediaSelect, caption: true, credit: true } },
  album: { select: { slug: true, title: true } }
} satisfies Prisma.GalleryItemSelect;

type GalleryItemPayload = Prisma.GalleryItemGetPayload<{ select: typeof galleryItemSelect }>;

/**
 * One picture, FLATTENED onto its asset.
 *
 * The row extends `MediaRow` rather than nesting it, so it satisfies both `MediaLike` (for
 * `<MediaImage>`) and the lightbox's item shape without a mapping step in every renderer that shows
 * a picture. The `id` is the `GalleryItem` id — which is also what a manual curation stores.
 */
export interface GalleryImageRow extends MediaRow {
  id: string;
  caption: string | null;
  credit: string | null;
  /** How the item is PRESENTED — "image" | "video" | "panorama" | "tour" — which is not always what
   *  the asset is. See the comment on `GalleryItem.presentation` in the schema. */
  presentation: string;
  albumSlug: string;
  albumTitle: string;
}

const craftSelect = {
  id: true,
  slug: true,
  name: true,
  localName: true,
  localNameLang: true,
  summary: true,
  originYear: true,
  originNote: true,
  materials: true,
  techniques: true,
  latitude: true,
  longitude: true,
  cover: { select: mediaSelect },
  region: { select: { slug: true, name: true, level: true } },
  school: { select: { slug: true, name: true } }
} satisfies Prisma.CraftSelect;

export type CraftRow = Prisma.CraftGetPayload<{ select: typeof craftSelect }>;

// ─────────────────────────────────────────────────────────────────────────────
// The result
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything a page's blocks need, keyed by `PageSection.id`.
 *
 * One map per record type rather than one map of unions, so `resolved.projects.get(id)` is typed as
 * projects and a renderer can never be handed the wrong shape.
 */
export interface ResolvedSectionData {
  research: Map<string, ResolvedShowcase<ResearchAreaRow>>;
  projects: Map<string, ResolvedShowcase<ProjectRow>>;
  people: Map<string, ResolvedShowcase<PersonRow>>;
  publications: Map<string, ResolvedShowcase<PublicationRow>>;
  news: Map<string, ResolvedShowcase<PostRow>>;
  events: Map<string, ResolvedShowcase<EventRow>>;
  partners: Map<string, ResolvedShowcase<PartnerRow>>;
  files: Map<string, ResolvedShowcase<FileRow>>;
  albums: Map<string, ResolvedShowcase<AlbumRow>>;
  galleryImages: Map<string, ResolvedShowcase<GalleryImageRow>>;
  crafts: Map<string, ResolvedShowcase<CraftRow>>;
  /**
   * Every `MediaAsset` named BY ID in a payload — a hero background, the image beside text, a
   * timeline entry's picture, a quote's portrait. Keyed by ASSET id rather than by section id,
   * because one asset is regularly used by several blocks and must not be fetched twice.
   *
   * A plain record rather than a `Map`, unlike the showcase maps above: it is a lookup table by asset
   * id, not a per-block result, and `noUncheckedIndexedAccess` already makes every read
   * `MediaRow | undefined` — which is the honest type, because an asset can have been deleted since
   * the payload named it.
   */
  media: Record<string, MediaRow | undefined>;
  /**
   * How much of the Centre's work is published, for any STATS block that asked to be counted.
   *
   * `null` means NOT COUNTED — no block on this page named a metric, or the read failed. It is a
   * separate state from "counted, and the answer was nought", which is why `figures` holds
   * `number | null` per metric rather than a bare number. A renderer that conflated the two would
   * print 0 for an unreachable database, which is the exact defect this whole mechanism exists to
   * remove.
   */
  census: SiteCensus | null;
}

/**
 * The census for one render.
 *
 * ⚠ THIS REPORTS, IT DOES NOT DECIDE. A count of 0 is returned as 0, because 0 is the true answer and
 * this module's job is to answer truthfully. Whether a 0 should appear on the page is a PRESENTATION
 * question and it belongs to `StatsSection`, which drops the item — see the argument in
 * `CENSUS_METRICS` in lib/sections/schema.ts. Making that decision here would mean the resolver could
 * never be reused by anything that legitimately wants to show a zero, such as a studio screen telling
 * an editor their gallery is empty.
 *
 * THERE IS NO TIMESTAMP HERE, and that is deliberate. `/api/public/stats` carries a `computedAt`
 * because it may be an hour stale and an undated hour-old figure is a small lie. This census is
 * counted inside the page's own render and is therefore exactly as fresh as the page — five minutes
 * on the homepage. A printed "counted at 16:04" that changes on every regeneration would be noise
 * claiming a precision the reader has no use for, and the block's `source` field is where an editor
 * states provenance in their own words.
 */
export interface SiteCensus {
  /** Every metric to its count, or `null` where this render did not count it. */
  figures: Record<CensusMetric, number | null>;
  /**
   * `homepage.censusOverride.enabled` — the administrator has suspended the counts, for the weeks
   * when the true figure would mislead (a migration part-done, an embargoed batch). Nothing is
   * counted when this is on, so every figure is `null` and `note` is what the block shows instead.
   */
  suspended: boolean;
  /** `homepage.censusOverride.note`. Meaningful only when `suspended`. */
  note: string;
}

/** Every metric unknown. The starting point for a census, and the whole of a suspended one. */
function noFigures(): Record<CensusMetric, number | null> {
  // Built from `CENSUS_METRICS` rather than written out, so a metric added to the schema cannot be
  // missing here — `reduce` over the tuple covers the union by construction.
  return CENSUS_METRICS.reduce(
    (into, metric) => {
      into[metric] = null;
      return into;
    },
    {} as Record<CensusMetric, number | null>
  );
}

function emptyResolved(): ResolvedSectionData {
  return {
    research: new Map(),
    projects: new Map(),
    people: new Map(),
    publications: new Map(),
    news: new Map(),
    events: new Map(),
    partners: new Map(),
    files: new Map(),
    albums: new Map(),
    galleryImages: new Map(),
    crafts: new Map(),
    media: {},
    census: null
  };
}

/**
 * One counted figure, or `null` when there is none to show.
 *
 * The single reader of `resolved.census`, so a renderer never has to know that a suspended census and
 * an uncounted one are different states — both answer `null`, which is the only answer a renderer can
 * act on. Exported for the same reason `showcaseFor` is: it is the one place that knows the shape.
 */
export function censusFigure(
  resolved: ResolvedSectionData,
  metric: CensusMetric | ""
): number | null {
  if (!metric) return null;
  return resolved.census?.figures[metric] ?? null;
}

/**
 * A gallery block's rows, whichever table they came from.
 *
 * The gallery is the ONE block whose `manual` ids can name rows in two different tables — albums or
 * pictures — decided by its `source` field. Rather than making every caller know that, this hands
 * back both lists; at most one of them is ever populated, because the planner sent the block down
 * exactly one path.
 */
export function galleryRowsFor(
  resolved: ResolvedSectionData,
  sectionId: string
): { albums: AlbumRow[]; images: GalleryImageRow[]; total: number; droppedIds: number } {
  const albums = showcaseFor(resolved.albums, sectionId);
  const images = showcaseFor(resolved.galleryImages, sectionId);
  return {
    albums: albums.rows,
    images: images.rows,
    // One of the two is always the empty showcase, so `max` picks the populated one's figures
    // without the caller having to re-read `source`.
    total: Math.max(albums.total, images.total),
    droppedIds: Math.max(albums.droppedIds, images.droppedIds)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Planning primitives
// ─────────────────────────────────────────────────────────────────────────────

type CurationMode = "latest" | "featured" | "manual";
type AutoMode = Exclude<CurationMode, "manual">;

/** The half of every showcase payload this module reads. Every showcase schema `extend`s it. */
interface ShowcasePayload {
  mode: CurationMode;
  limit: number;
  ids: string[];
}

/**
 * One block's requirements for one record type.
 *
 * `groupKey` is the whole of what makes two blocks shareable: same mode, same auxiliary filters. Two
 * news blocks with limits of 3 and 8 share a key and run as ONE query taking 8.
 */
interface Plan<F> {
  sectionId: string;
  curation: ShowcasePayload;
  filter: F;
  groupKey: string;
}

/** Record a block's requirements. The filter object is written out in ONE place per record type, so
 *  `JSON.stringify` over it produces a stable key without needing a sorted serialiser. */
function planShowcase<F>(
  into: Plan<F>[],
  sectionId: string,
  payload: ShowcasePayload,
  filter: F
): void {
  into.push({
    sectionId,
    curation: { mode: payload.mode, limit: payload.limit, ids: payload.ids },
    filter,
    groupKey: `${payload.mode}|${JSON.stringify(filter)}`
  });
}

/**
 * Re-sort an `IN` result into the editor's order, dropping ids that no longer resolve.
 *
 * THE REASON THIS FUNCTION EXISTS is in the header: Postgres returns `IN` results in whatever order
 * the index hands back, so a manual curation without this step renders in an arbitrary order that
 * shifts as unrelated rows are edited. No `orderBy` expresses "the order of this list".
 */
function orderByIds<T extends { id: string }>(rows: readonly T[], ids: readonly string[]): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered: T[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) ordered.push(row);
  }
  return ordered;
}

function manualShowcase<T extends { id: string }>(
  pool: readonly T[],
  curation: ShowcasePayload
): ResolvedShowcase<T> {
  const ordered = orderByIds(pool, curation.ids);
  return {
    rows: ordered.slice(0, curation.limit),
    // The total is what still resolves, not what was picked — `droppedIds` carries the difference.
    // A block saying "showing 6 of 8" when two of the eight are gone would be a second untruth.
    total: ordered.length,
    droppedIds: curation.ids.length - ordered.length
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The batch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One statement in the transaction, plus what to do with its answer.
 *
 * The `unknown` and the cast inside each `receive` are the price of building the array at runtime:
 * `$transaction` infers a tuple only from a literal tuple. Every cast sits three lines below the
 * query that guarantees it, so it restates a fact rather than assuming one.
 */
interface BatchJob {
  query: Prisma.PrismaPromise<unknown>;
  receive(result: unknown): void;
}

/**
 * How one record type answers the three curation modes.
 *
 * The queries stay explicit per record type — the WHERE and the ORDER BY are the whole of what
 * differs between them, and hiding those behind a factory is exactly how an ordering promised in the
 * schema's help text quietly stops being kept. Only the plumbing is shared.
 */
interface EntitySource<F, R, T extends { id: string }> {
  findAuto(filter: F, mode: AutoMode, take: number): Prisma.PrismaPromise<R[]>;
  countAuto(filter: F, mode: AutoMode): Prisma.PrismaPromise<number>;
  findManual(ids: string[]): Prisma.PrismaPromise<R[]>;
  /** Raw row → exported row. Identity for everything but publications, which gain `pdfSlug`. */
  hydrate(raw: R): T;
}

function identity<T>(row: T): T {
  return row;
}

/**
 * Turn one record type's plans into batch jobs.
 *
 * Results are assembled in a FINALISER rather than inside `receive`, because an auto group's rows and
 * its count arrive from two different statements: writing a half-built showcase into the map and
 * patching its `total` later would leave the wrong number visible to anything that read it in
 * between, and would depend on the order the two jobs happen to have been pushed in.
 */
function addShowcaseJobs<F, R, T extends { id: string }>(
  jobs: BatchJob[],
  finalisers: (() => void)[],
  target: Map<string, ResolvedShowcase<T>>,
  plans: readonly Plan<F>[],
  source: EntitySource<F, R, T>
): void {
  if (plans.length === 0) return;

  interface AutoGroup {
    filter: F;
    mode: AutoMode;
    /** The largest limit any member asked for; each member slices its own share out of the answer. */
    take: number;
    members: Plan<F>[];
    rows: T[];
    total: number;
  }

  const groups = new Map<string, AutoGroup>();
  const manualIds = new Set<string>();
  const manualPlans: Plan<F>[] = [];

  for (const plan of plans) {
    if (plan.curation.mode === "manual") {
      for (const id of plan.curation.ids) manualIds.add(id);
      manualPlans.push(plan);
      continue;
    }
    const existing = groups.get(plan.groupKey);
    if (existing) {
      existing.take = Math.max(existing.take, plan.curation.limit);
      existing.members.push(plan);
      continue;
    }
    groups.set(plan.groupKey, {
      filter: plan.filter,
      mode: plan.curation.mode,
      take: plan.curation.limit,
      members: [plan],
      rows: [],
      total: 0
    });
  }

  for (const group of groups.values()) {
    jobs.push({
      query: source.findAuto(group.filter, group.mode, group.take),
      receive: (result) => {
        group.rows = (result as R[]).map(source.hydrate);
      }
    });
    jobs.push({
      query: source.countAuto(group.filter, group.mode),
      receive: (result) => {
        group.total = result as number;
      }
    });
    finalisers.push(() => {
      for (const member of group.members) {
        target.set(member.sectionId, {
          rows: group.rows.slice(0, member.curation.limit),
          total: group.total,
          droppedIds: 0
        });
      }
    });
  }

  if (manualIds.size > 0) {
    let pool: T[] = [];
    jobs.push({
      query: source.findManual([...manualIds]),
      receive: (result) => {
        pool = (result as R[]).map(source.hydrate);
      }
    });
    finalisers.push(() => {
      for (const plan of manualPlans) {
        target.set(plan.sectionId, manualShowcase(pool, plan.curation));
      }
    });
  }
}

/**
 * Resolve every block on a page in one batched pass.
 *
 * Blocks are read in the order given and `isVisible` is NOT consulted — the caller decides what a
 * page renders, and the studio's preview legitimately wants hidden blocks resolved. A block whose
 * payload fails to parse is skipped here and rendered as an editor-only error card by the page
 * renderer; it never becomes a blank gap.
 */
export async function resolveSectionData(
  sections: readonly PageSection[]
): Promise<ResolvedSectionData> {
  /**
   * An unreachable database resolves to EMPTY rather than throwing.
   *
   * Every showcase renderer already handles an empty row set — it is the same state as a curation that
   * matches nothing, and each says so on screen rather than leaving a gap. So the failure degrades into
   * a path that is already written and already correct.
   *
   * It has to, because `next build` renders the pages that call this. A throw would fail the whole
   * deploy for a reason unrelated to the change being shipped, which is the argument lib/prerender.ts
   * makes at length; every page calling this carries a `revalidate` window, so the empty prerender
   * repairs itself.
   *
   * ⚠ THE GUARD IS HERE, AT THE BOUNDARY, rather than around each of the dozen queries inside. One
   * `catch` cannot be forgotten when a fourteenth showcase type is added; twelve can.
   */
  try {
    return await resolveSectionDataOrThrow(sections);
  } catch (error) {
    console.error(
      "[sections] the page's blocks could not be filled in, so they are rendering empty. This repairs " +
        "itself at the next revalidation. " +
        `Reason: ${error instanceof Error ? error.message : String(error)}`
    );
    return emptyResolved();
  }
}

async function resolveSectionDataOrThrow(
  sections: readonly PageSection[]
): Promise<ResolvedSectionData> {
  const out = emptyResolved();
  if (sections.length === 0) return out;

  // ONE `now` for the whole page. Computed per query, a post published in the millisecond between two
  // statements could appear in one block and not in another on the same render.
  const now = new Date();

  const researchPlans: Plan<ResearchFilter>[] = [];
  const projectPlans: Plan<ProjectFilter>[] = [];
  const peoplePlans: Plan<PersonFilter>[] = [];
  const publicationPlans: Plan<PublicationFilter>[] = [];
  const newsPlans: Plan<EmptyFilter>[] = [];
  const eventPlans: Plan<EventFilter>[] = [];
  const partnerPlans: Plan<EmptyFilter>[] = [];
  const filePlans: Plan<FileFilter>[] = [];
  const albumPlans: Plan<EmptyFilter>[] = [];
  const galleryImagePlans: Plan<EmptyFilter>[] = [];
  const craftPlans: Plan<CraftFilter>[] = [];
  const mediaIds = new Set<string>();
  /**
   * The metrics some STATS block on this page asked to have counted.
   *
   * A SET, so two stats blocks both showing "crafts documented" cost one `count` between them and can
   * never print two different numbers for the same thing on the same page.
   */
  const censusMetrics = new Set<CensusMetric>();

  const rememberMedia = (id: string): void => {
    const trimmed = id.trim();
    if (trimmed) mediaIds.add(trimmed);
  };

  for (const section of sections) {
    const parsed = parseSectionData(section.type, section.data);
    if (!parsed.ok) continue;

    switch (section.type) {
      case "RESEARCH_SHOWCASE":
        planShowcase(researchPlans, section.id, parsed.data as ResearchShowcaseSectionData, {});
        break;
      case "PROJECT_SHOWCASE": {
        const data = parsed.data as ProjectShowcaseSectionData;
        planShowcase(projectPlans, section.id, data, { state: data.state });
        break;
      }
      case "PEOPLE_SHOWCASE": {
        const data = parsed.data as PeopleShowcaseSectionData;
        planShowcase(peoplePlans, section.id, data, { kind: data.kind });
        break;
      }
      case "PUBLICATION_LIST": {
        const data = parsed.data as PublicationListSectionData;
        planShowcase(publicationPlans, section.id, data, { kind: data.kind });
        break;
      }
      case "NEWS_SHOWCASE":
        planShowcase(newsPlans, section.id, parsed.data as NewsShowcaseSectionData, {});
        break;
      case "EVENT_SHOWCASE": {
        const data = parsed.data as EventShowcaseSectionData;
        planShowcase(eventPlans, section.id, data, { when: data.when });
        break;
      }
      case "PARTNER_LOGOS":
        planShowcase(partnerPlans, section.id, parsed.data as PartnerLogosSectionData, {});
        break;
      case "DOWNLOADS": {
        const data = parsed.data as DownloadsSectionData;
        planShowcase(filePlans, section.id, data, { category: data.category.trim() });
        break;
      }
      case "GALLERY": {
        const data = parsed.data as GallerySectionData;
        // `source` decides WHICH TABLE the ids in manual mode name, which is why albums and images
        // are planned into two lists rather than one list with a flag.
        planShowcase(data.source === "images" ? galleryImagePlans : albumPlans, section.id, data, {});
        break;
      }
      case "CRAFT_EXPLORER": {
        const data = parsed.data as CraftExplorerSectionData;
        planShowcase(craftPlans, section.id, data, {
          regionSlug: data.regionSlug.trim(),
          // The help text promises the timeline "leaves out any craft with no date", so the view is
          // part of the FILTER rather than a renderer-side decision — otherwise a block asked for
          // twelve would fetch twelve and silently render eight.
          datedOnly: data.view === "timeline"
        });
        break;
      }
      /*
       * The one block that reads a FIGURE rather than a list of rows.
       *
       * Only the metrics actually named are collected, and a block whose figures are all typed by hand
       * adds nothing — so the overwhelmingly common stats block still costs zero queries, exactly as it
       * did before the census existed.
       */
      case "STATS":
        for (const item of (parsed.data as StatsSectionData).items) {
          if (item.metric) censusMetrics.add(item.metric);
        }
        break;

      case "HERO": {
        const data = parsed.data as HeroSectionData;
        if (data.backgroundKind === "image" || data.backgroundKind === "video") {
          rememberMedia(data.backgroundMediaId);
          /**
           * The alternate photographs a per-screen framing names, fetched WITH the page.
           *
           * ⚠ WITHOUT THIS THE FEATURE FAILS SILENTLY RATHER THAN LOUDLY. `resolvePicture` looks an
           * alternate up through the `media` map, and a bucket whose photograph is missing INHERITS —
           * so an unfetched row does not error, it just quietly draws the phone picture on a desktop.
           * Adding the ids to the same census the background id goes through costs no extra query: they
           * all end up in one `IN (…)`.
           */
          for (const id of screenFramingMediaIds(data.backgroundMediaScreens)) rememberMedia(id);
        }
        break;
      }
      case "MEDIA_SPLIT":
        rememberMedia((parsed.data as MediaSplitSectionData).mediaId);
        break;
      /*
       * Mirrors HERO above: the id is fetched only when the arrangement actually shows a picture.
       * The three text-alone arrangements ignore both picture fields (the schema says so), so a
       * picture chosen and then parked by switching the arrangement must not cost the page a row in
       * the `IN (…)`. The craft slug half resolves from a compiled-in constant with no query — see
       * the narrative blocks' note below.
       */
      case "RICH_TEXT": {
        const data = parsed.data as RichTextSectionData;
        if (
          data.layout === "text-left-media-right" ||
          data.layout === "text-right-media-left" ||
          data.layout === "center-media-between"
        ) {
          rememberMedia(data.mediaId);
        }
        break;
      }
      case "QUOTE":
        rememberMedia((parsed.data as QuoteSectionData).portraitMediaId);
        break;
      /*
       * The document a DOCUMENT_EMBED block puts on the page. It is a `MediaAsset` like every other
       * id collected here — see the block's schema for why it is not a `FileAsset` — so it costs one
       * more id in the same `IN (…)` and no extra query. The file name and size that this one block
       * reads are the two columns added to `mediaSelect` above, on a row the page was fetching
       * anyway.
       */
      case "DOCUMENT_EMBED":
        rememberMedia((parsed.data as DocumentEmbedSectionData).mediaId);
        break;
      case "TIMELINE":
        for (const entry of (parsed.data as TimelineSectionData).entries) {
          rememberMedia(entry.mediaId);
        }
        break;

      /*
       * The narrative blocks. Each holds a LIST of pictures, and each picture may be either an
       * uploaded asset or a slug from the bundled craft manifest.
       *
       * ⚠ ONLY THE UPLOADED HALF BELONGS HERE. A `craftImage` slug resolves against a compiled-in
       * constant with no query at all (lib/media/craft-imagery.ts), so passing one to
       * `rememberMedia` would put a slug like "warli" into the `MediaAsset` id list — a lookup that
       * matches nothing, costs a row in the `IN (…)`, and would leave whoever debugged it hunting
       * for a missing asset that was never meant to exist.
       */
      case "STORY_SCROLL":
        for (const chapter of (parsed.data as StoryScrollSectionData).chapters) {
          rememberMedia(chapter.mediaId);
        }
        break;
      case "PARALLAX_BANNER":
        rememberMedia((parsed.data as ParallaxBannerSectionData).mediaId);
        break;
      case "HORIZONTAL_RAIL":
        for (const item of (parsed.data as HorizontalRailSectionData).items) {
          rememberMedia(item.mediaId);
        }
        break;
      case "PROCESS_STEPS":
        for (const step of (parsed.data as ProcessStepsSectionData).steps) {
          rememberMedia(step.mediaId);
        }
        break;

      default:
        break;
    }
  }

  const jobs: BatchJob[] = [];
  const finalisers: (() => void)[] = [];

  /**
   * The census, and the administrator's power to suspend it.
   *
   * ⚠ THE SETTING IS READ EVEN THOUGH IT MAY SUSPEND EVERYTHING, and the order matters: it is read
   * FIRST, and the counts are only queued when the switch is off. Counting and then discarding would
   * be nine pointless statements on the busiest page of the site during exactly the weeks an
   * administrator has said the figures are not to be trusted.
   *
   * `getSettingCached` is React `cache()`-wrapped and reads all seven groups in one query, which the
   * site layout has already paid for by the time a page body runs — so this costs nothing on a real
   * render. It also swallows an unreachable database and returns defaults rather than throwing
   * (lib/settings/service.ts), which is right here: a settings outage must not be the thing that
   * decides whether a page renders, and with the counts unavailable every figure is `null` anyway.
   */
  if (censusMetrics.size > 0) {
    const homepage = await getSettingCached("homepage");
    const census: SiteCensus = {
      figures: noFigures(),
      suspended: homepage.censusOverride.enabled,
      note: homepage.censusOverride.note
    };
    out.census = census;
    if (!census.suspended) addCensusJobs(jobs, census.figures, censusMetrics);
  }

  addShowcaseJobs(jobs, finalisers, out.research, researchPlans, researchSource());
  addShowcaseJobs(jobs, finalisers, out.projects, projectPlans, projectSource());
  addShowcaseJobs(jobs, finalisers, out.people, peoplePlans, personSource());
  addShowcaseJobs(jobs, finalisers, out.publications, publicationPlans, publicationSource());
  addShowcaseJobs(jobs, finalisers, out.news, newsPlans, postSource(now));
  addEventJobs(jobs, finalisers, out.events, eventPlans, now);
  addShowcaseJobs(jobs, finalisers, out.partners, partnerPlans, partnerSource());
  addShowcaseJobs(jobs, finalisers, out.files, filePlans, fileSource(now));
  addShowcaseJobs(jobs, finalisers, out.albums, albumPlans, albumSource());
  addShowcaseJobs(jobs, finalisers, out.galleryImages, galleryImagePlans, galleryImageSource());
  addShowcaseJobs(jobs, finalisers, out.crafts, craftPlans, craftSource());
  addMediaJob(jobs, out, [...mediaIds]);

  if (jobs.length === 0) return out;

  const results = await prisma.$transaction(jobs.map((job) => job.query));
  results.forEach((result, index) => {
    jobs[index]?.receive(result);
  });
  for (const finalise of finalisers) finalise();

  // A SECOND round trip, and only when a publication that is actually being rendered carries a PDF.
  // `pdfFileId` is not a relation (see `PublicationRow`), so its slug cannot be joined in the first
  // pass. One extra query for the whole page is the price of that schema decision.
  await attachPublicationPdfs(out.publications, now);

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-record-type sources
// ─────────────────────────────────────────────────────────────────────────────

type EmptyFilter = Record<string, never>;
type ResearchFilter = EmptyFilter;

function researchSource(): EntitySource<ResearchFilter, ResearchAreaRow, ResearchAreaRow> {
  // "most recently published first", then the curated order, then id so the sort is TOTAL — an
  // unstable sort renders a different list on every request, which reads as data changing by itself.
  const orderBy: Prisma.ResearchAreaOrderByWithRelationInput[] = [
    { publishedAt: { sort: "desc", nulls: "last" } },
    { sortOrder: "asc" },
    { id: "asc" }
  ];
  // ResearchArea has no `isFeatured` column, so `featured` resolves to the curated order — which is
  // the order an editor arranged on the research screen, and therefore already their answer to
  // "which areas matter most".
  const where = (): Prisma.ResearchAreaWhereInput => ({ ...liveStatusWhere() });

  return {
    findAuto: (_filter, _mode, take) =>
      prisma.researchArea.findMany({ where: where(), orderBy, take, select: researchAreaSelect }),
    countAuto: () => prisma.researchArea.count({ where: where() }),
    findManual: (ids) =>
      prisma.researchArea.findMany({
        where: { ...where(), id: { in: ids } },
        select: researchAreaSelect
      }),
    hydrate: identity
  };
}

interface ProjectFilter {
  /** `""` is "any stage" — the schema's empty-string convention for a cleared picker. */
  state: "" | "PROPOSED" | "ACTIVE" | "COMPLETED" | "ON_HOLD";
}

function projectSource(): EntitySource<ProjectFilter, ProjectRow, ProjectRow> {
  // "most recently started first" — the promise in the schema's help text. `nulls: "last"` is
  // load-bearing: Postgres sorts NULLs FIRST on a DESC order, so a project with no start date would
  // otherwise head a list titled "most recently started".
  const orderBy: Prisma.ProjectOrderByWithRelationInput[] = [
    { startedOn: { sort: "desc", nulls: "last" } },
    { publishedAt: { sort: "desc", nulls: "last" } },
    { id: "asc" }
  ];
  const where = (filter: ProjectFilter, mode: AutoMode): Prisma.ProjectWhereInput => ({
    ...liveStatusWhere(),
    ...(filter.state ? { state: filter.state } : {}),
    ...(mode === "featured" ? { isFeatured: true } : {})
  });

  return {
    findAuto: (filter, mode, take) =>
      prisma.project.findMany({
        where: where(filter, mode),
        // A featured block leads with the editor's own arrangement; a latest block never does,
        // because `sortOrder` there would override the recency the block is named for.
        orderBy: mode === "featured" ? [{ sortOrder: "asc" }, ...orderBy] : orderBy,
        take,
        select: projectSelect
      }),
    countAuto: (filter, mode) => prisma.project.count({ where: where(filter, mode) }),
    findManual: (ids) =>
      prisma.project.findMany({
        where: { ...liveStatusWhere(), id: { in: ids } },
        select: projectSelect
      }),
    hydrate: identity
  };
}

/** Mirrors `PERSON_KINDS` in ./schema.ts — see the warning there about nothing checking the mirror. */
interface PersonFilter {
  kind:
    | ""
    | "FACULTY"
    | "SCIENTIST"
    | "RESEARCHER"
    | "STUDENT"
    | "STAFF"
    | "VISITOR"
    | "ALUMNUS"
    | "DC_HANDICRAFTS";
}

function personSource(): EntitySource<PersonFilter, PersonRow, PersonRow> {
  // "in the order set on the people page" — `sortOrder`, ties broken on name exactly as the comment
  // on `Person.sortOrder` in the schema requires, so the ordering is total.
  const orderBy: Prisma.PersonOrderByWithRelationInput[] = [
    { sortOrder: "asc" },
    { name: "asc" },
    { id: "asc" }
  ];
  // `isVisible` is a second, editor-facing switch beside publication state: a person can be published
  // — so their page exists and is citable — and still be deliberately absent from every listing.
  // Person has no `isFeatured`, so `featured` is the top of that same curated order.
  const where = (filter: PersonFilter): Prisma.PersonWhereInput => ({
    ...liveStatusWhere(),
    isVisible: true,
    ...(filter.kind ? { kind: filter.kind } : {})
  });

  return {
    findAuto: (filter, _mode, take) =>
      prisma.person.findMany({ where: where(filter), orderBy, take, select: personSelect }),
    countAuto: (filter) => prisma.person.count({ where: where(filter) }),
    findManual: (ids) =>
      prisma.person.findMany({
        where: { ...liveStatusWhere(), isVisible: true, id: { in: ids } },
        select: personSelect
      }),
    hydrate: identity
  };
}

/** Mirrors `PUBLICATION_KINDS` in ./schema.ts — see the warning there about nothing checking the mirror. */
interface PublicationFilter {
  kind:
    | ""
    | "JOURNAL_ARTICLE"
    | "CONFERENCE_PAPER"
    | "BOOK"
    | "BOOK_CHAPTER"
    | "PATENT"
    | "DATASET"
    | "SOFTWARE"
    | "PREPRINT"
    | "THESIS"
    | "REPORT"
    | "FLYER"
    | "BOOKLET";
}

function publicationSource(): EntitySource<PublicationFilter, PublicationPayload, PublicationRow> {
  // "newest year first". Month is the secondary key so two papers from one year are not ordered by
  // insertion, and title is the tiebreaker so the list is identical between two requests.
  const orderBy: Prisma.PublicationOrderByWithRelationInput[] = [
    { year: "desc" },
    { month: { sort: "desc", nulls: "last" } },
    { title: "asc" }
  ];
  const where = (filter: PublicationFilter, mode: AutoMode): Prisma.PublicationWhereInput => ({
    ...liveStatusWhere(),
    ...(filter.kind ? { kind: filter.kind } : {}),
    ...(mode === "featured" ? { isFeatured: true } : {})
  });

  return {
    findAuto: (filter, mode, take) =>
      prisma.publication.findMany({ where: where(filter, mode), orderBy, take, select: publicationSelect }),
    countAuto: (filter, mode) => prisma.publication.count({ where: where(filter, mode) }),
    findManual: (ids) =>
      prisma.publication.findMany({
        where: { ...liveStatusWhere(), id: { in: ids } },
        select: publicationSelect
      }),
    // Null until `attachPublicationPdfs` runs. Declared rather than left absent so the property
    // always exists — an `undefined` here would read as "not looked up yet" everywhere downstream.
    hydrate: (raw) => ({ ...raw, pdfSlug: null })
  };
}

/**
 * Fill in `pdfSlug` for the publications actually being rendered.
 *
 * Only the rows that survived the limit are looked up, and only when at least one carries a
 * `pdfFileId` — so a page of publications with no PDFs issues no extra query at all. A file that is
 * not public, is soft-deleted, or whose embargo has expired resolves to null and the renderer shows
 * no PDF link. Hiding the link is NOT the access control: the download route enforces the identical
 * predicate, because a hidden button is not a guard (contract §1.7).
 */
async function attachPublicationPdfs(
  showcases: Map<string, ResolvedShowcase<PublicationRow>>,
  now: Date
): Promise<void> {
  const wanted = new Set<string>();
  for (const showcase of showcases.values()) {
    for (const row of showcase.rows) {
      if (row.pdfFileId) wanted.add(row.pdfFileId);
    }
  }
  if (wanted.size === 0) return;

  const files = await prisma.fileAsset.findMany({
    where: {
      id: { in: [...wanted] },
      deletedAt: null,
      isPublic: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
    },
    select: { id: true, slug: true }
  });

  const slugById = new Map(files.map((file) => [file.id, file.slug]));
  for (const showcase of showcases.values()) {
    showcase.rows = showcase.rows.map((row) =>
      row.pdfFileId ? { ...row, pdfSlug: slugById.get(row.pdfFileId) ?? null } : row
    );
  }
}

function postSource(now: Date): EntitySource<EmptyFilter, PostRow, PostRow> {
  // `Post` is the one record type here with publishAt/unpublishAt, so it needs `livePublishableWhere`
  // and NOT `liveStatusWhere`. Getting that backwards is a Prisma runtime error in one direction and
  // a leaked embargo in the other (contract §9).
  //
  // A SCHEDULED post that has gone live has a `publishAt` but may not have a `publishedAt` yet — the
  // cron that stamps it is a convenience, not the mechanism — so `publishAt` is the second sort key.
  // Without it, a newly live piece would sit at the bottom of "most recently published first" until
  // the job next ran.
  const orderBy: Prisma.PostOrderByWithRelationInput[] = [
    { publishedAt: { sort: "desc", nulls: "last" } },
    { publishAt: { sort: "desc", nulls: "last" } },
    { id: "asc" }
  ];
  const where = (mode: AutoMode): Prisma.PostWhereInput => ({
    ...livePublishableWhere(now),
    ...(mode === "featured" ? { isFeatured: true } : {})
  });

  return {
    findAuto: (_filter, mode, take) =>
      prisma.post.findMany({ where: where(mode), orderBy, take, select: postSelect }),
    countAuto: (_filter, mode) => prisma.post.count({ where: where(mode) }),
    findManual: (ids) =>
      prisma.post.findMany({
        where: { ...livePublishableWhere(now), id: { in: ids } },
        select: postSelect
      }),
    hydrate: identity
  };
}

interface EventFilter {
  when: "upcoming" | "past" | "all";
}

/**
 * "Upcoming" means NOT YET FINISHED, not "not yet started".
 *
 * A three-day conference on its second morning is upcoming for every reader who might still attend;
 * comparing only `startsAt` would move it into the archive the moment it began.
 */
function upcomingWhere(now: Date): Prisma.CoeEventWhereInput {
  return { OR: [{ endsAt: { gte: now } }, { endsAt: null, startsAt: { gte: now } }] };
}

function pastWhere(now: Date): Prisma.CoeEventWhereInput {
  return { OR: [{ endsAt: { lt: now } }, { endsAt: null, startsAt: { lt: now } }] };
}

/**
 * Events do not fit `addShowcaseJobs`, and the reason is worth stating.
 *
 * "Latest" points in two directions here: upcoming counts FORWARD from today and past counts
 * BACKWARDS from it, so a block set to "all" needs both halves in opposite orders. There is no
 * ORDER BY that expresses "nearest to now, in either direction", so it is two statements — in the
 * same batch, so still one round trip.
 */
function addEventJobs(
  jobs: BatchJob[],
  finalisers: (() => void)[],
  target: Map<string, ResolvedShowcase<EventRow>>,
  plans: readonly Plan<EventFilter>[],
  now: Date
): void {
  if (plans.length === 0) return;

  interface Slice {
    where: Prisma.CoeEventWhereInput;
    orderBy: Prisma.CoeEventOrderByWithRelationInput[];
    take: number;
    rows: EventRow[];
    total: number;
  }
  const slices = new Map<string, Slice>();

  const needSlice = (direction: "upcoming" | "past", featured: boolean, take: number): Slice => {
    const key = `${direction}|${featured ? "featured" : "any"}`;
    const existing = slices.get(key);
    if (existing) {
      existing.take = Math.max(existing.take, take);
      return existing;
    }
    const slice: Slice = {
      where: {
        ...liveStatusWhere(),
        ...(direction === "upcoming" ? upcomingWhere(now) : pastWhere(now)),
        ...(featured ? { isFeatured: true } : {})
      },
      orderBy: [{ startsAt: direction === "upcoming" ? "asc" : "desc" }, { id: "asc" }],
      take,
      rows: [],
      total: 0
    };
    slices.set(key, slice);
    return slice;
  };

  const manualIds = new Set<string>();
  const manualPlans: Plan<EventFilter>[] = [];
  const autoPlans: { plan: Plan<EventFilter>; parts: Slice[] }[] = [];

  for (const plan of plans) {
    if (plan.curation.mode === "manual") {
      for (const id of plan.curation.ids) manualIds.add(id);
      manualPlans.push(plan);
      continue;
    }
    const featured = plan.curation.mode === "featured";
    const directions: ("upcoming" | "past")[] =
      plan.filter.when === "all" ? ["upcoming", "past"] : [plan.filter.when];
    autoPlans.push({
      plan,
      parts: directions.map((direction) => needSlice(direction, featured, plan.curation.limit))
    });
  }

  for (const slice of slices.values()) {
    jobs.push({
      query: prisma.coeEvent.findMany({
        where: slice.where,
        orderBy: slice.orderBy,
        take: slice.take,
        select: eventSelect
      }),
      receive: (result) => {
        slice.rows = result as EventRow[];
      }
    });
    jobs.push({
      query: prisma.coeEvent.count({ where: slice.where }),
      receive: (result) => {
        slice.total = result as number;
      }
    });
  }

  if (autoPlans.length > 0) {
    finalisers.push(() => {
      for (const entry of autoPlans) {
        // Upcoming before past, because a reader scanning a mixed block is looking for what they can
        // still attend. The limit applies to the merged list, and the renderer splits it again under
        // headings that state the boundary in words.
        const rows = entry.parts.flatMap((part) => part.rows);
        const total = entry.parts.reduce((sum, part) => sum + part.total, 0);
        target.set(entry.plan.sectionId, {
          rows: rows.slice(0, entry.plan.curation.limit),
          total,
          droppedIds: 0
        });
      }
    });
  }

  if (manualIds.size > 0) {
    let pool: EventRow[] = [];
    jobs.push({
      query: prisma.coeEvent.findMany({
        where: { ...liveStatusWhere(), id: { in: [...manualIds] } },
        select: eventSelect
      }),
      receive: (result) => {
        pool = result as EventRow[];
      }
    });
    finalisers.push(() => {
      for (const plan of manualPlans) {
        target.set(plan.sectionId, manualShowcase(pool, plan.curation));
      }
    });
  }
}

function partnerSource(): EntitySource<EmptyFilter, PartnerRow, PartnerRow> {
  // ⚠ Partner has NO `status` column, so `liveStatusWhere()` here would be a Prisma RUNTIME error.
  // It has no `isFeatured` either, so `featured` resolves to the same curated order as `latest` —
  // the order an administrator arranged on the partners screen, which is already their answer to
  // "which of these come first".
  const where = (): Prisma.PartnerWhereInput => ({ deletedAt: null, isVisible: true });
  const orderBy: Prisma.PartnerOrderByWithRelationInput[] = [
    { sortOrder: "asc" },
    { name: "asc" },
    { id: "asc" }
  ];

  return {
    findAuto: (_filter, _mode, take) =>
      prisma.partner.findMany({ where: where(), orderBy, take, select: partnerSelect }),
    countAuto: () => prisma.partner.count({ where: where() }),
    findManual: (ids) =>
      prisma.partner.findMany({ where: { ...where(), id: { in: ids } }, select: partnerSelect }),
    hydrate: identity
  };
}

interface FileFilter {
  /** `""` is every category. */
  category: string;
}

function fileSource(now: Date): EntitySource<FileFilter, FileRow, FileRow> {
  // ⚠ FileAsset has NO `status` column either. `isPublic` is the gate and `expiresAt` is an embargo
  // compared at READ time — the cron is a convenience, the filter is the mechanism. The download
  // route enforces the identical predicate; this only decides what is OFFERED.
  const base = (): Prisma.FileAssetWhereInput => ({
    deletedAt: null,
    isPublic: true,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
  });
  const orderBy: Prisma.FileAssetOrderByWithRelationInput[] = [{ createdAt: "desc" }, { id: "asc" }];
  const where = (filter: FileFilter): Prisma.FileAssetWhereInput => ({
    ...base(),
    // Case-insensitive equality: an editor typing "Datasets" into the block must match a file filed
    // under "datasets". Exact matching produces an empty block with no visible cause, and FileAsset
    // has no `isFeatured`, so `featured` is simply the newest-first order.
    ...(filter.category ? { category: { equals: filter.category, mode: "insensitive" } } : {})
  });

  return {
    findAuto: (filter, _mode, take) =>
      prisma.fileAsset.findMany({ where: where(filter), orderBy, take, select: fileSelect }),
    countAuto: (filter) => prisma.fileAsset.count({ where: where(filter) }),
    findManual: (ids) =>
      prisma.fileAsset.findMany({ where: { ...base(), id: { in: ids } }, select: fileSelect }),
    hydrate: identity
  };
}

function albumSource(): EntitySource<EmptyFilter, AlbumPayload, AlbumRow> {
  // GalleryAlbum has no `isFeatured`; `featured` falls back to the curated order.
  const where = (): Prisma.GalleryAlbumWhereInput => ({ ...liveStatusWhere() });
  const orderBy: Prisma.GalleryAlbumOrderByWithRelationInput[] = [
    { publishedAt: { sort: "desc", nulls: "last" } },
    { sortOrder: "asc" },
    { id: "asc" }
  ];

  return {
    findAuto: (_filter, _mode, take) =>
      prisma.galleryAlbum.findMany({ where: where(), orderBy, take, select: albumSelect }),
    countAuto: () => prisma.galleryAlbum.count({ where: where() }),
    findManual: (ids) =>
      prisma.galleryAlbum.findMany({ where: { ...where(), id: { in: ids } }, select: albumSelect }),
    hydrate: (raw) => ({ ...raw, itemCount: raw._count.items })
  };
}

function galleryImageSource(): EntitySource<EmptyFilter, GalleryItemPayload, GalleryImageRow> {
  // A picture is public because its ALBUM is: `GalleryItem` carries no status of its own, so the
  // filter has to reach through the relation or every draft album's photographs would be readable.
  const where = (): Prisma.GalleryItemWhereInput => ({ album: liveStatusWhere() });
  const orderBy: Prisma.GalleryItemOrderByWithRelationInput[] = [
    { album: { publishedAt: "desc" } },
    { position: "asc" },
    { id: "asc" }
  ];

  return {
    findAuto: (_filter, _mode, take) =>
      prisma.galleryItem.findMany({ where: where(), orderBy, take, select: galleryItemSelect }),
    countAuto: () => prisma.galleryItem.count({ where: where() }),
    findManual: (ids) =>
      prisma.galleryItem.findMany({
        where: { ...where(), id: { in: ids } },
        select: galleryItemSelect
      }),
    // The item's own caption wins over the asset's: the same photograph legitimately says something
    // different in two albums, and the asset caption is the fallback rather than the authority.
    hydrate: (raw) => ({
      objectKey: raw.asset.objectKey,
      // `fileName` and `byteSize` are flattened through even though no gallery surface prints them.
      // `GalleryImageRow extends MediaRow`, and `mediaSelect` gained both when the document block
      // started needing them (see the note at mediaSelect) — so omitting them here is not "leaving
      // out what we do not use", it is failing to satisfy the type this row claims to be. They are
      // already in the payload; this only carries them across the flattening.
      fileName: raw.asset.fileName,
      byteSize: raw.asset.byteSize,
      width: raw.asset.width,
      height: raw.asset.height,
      altText: raw.asset.altText,
      blurDataUrl: raw.asset.blurDataUrl,
      // ⚠ THE CROP HAS TO BE CARRIED ACROSS THE FLATTENING TOO. Selecting the four columns is only half
      // the job: this hydrate rebuilds a row by hand, and a field not named here is a field
      // `MediaImage` never sees — so a gallery image would go back to being trimmed from the centre
      // while every other surface honoured its crop. Anywhere else that assembles a `MediaLike` by hand
      // has the same obligation.
      cropX: raw.asset.cropX,
      cropY: raw.asset.cropY,
      cropWidth: raw.asset.cropWidth,
      cropHeight: raw.asset.cropHeight,
      variants: raw.asset.variants,
      id: raw.id,
      caption: raw.caption ?? raw.asset.caption,
      credit: raw.asset.credit,
      presentation: raw.presentation,
      albumSlug: raw.album.slug,
      albumTitle: raw.album.title
    })
  };
}

interface CraftFilter {
  regionSlug: string;
  datedOnly: boolean;
}

function craftSource(): EntitySource<CraftFilter, CraftRow, CraftRow> {
  const where = (filter: CraftFilter, mode: AutoMode): Prisma.CraftWhereInput => ({
    ...liveStatusWhere(),
    ...(filter.regionSlug ? { region: { slug: filter.regionSlug } } : {}),
    ...(filter.datedOnly ? { originYear: { not: null } } : {}),
    ...(mode === "featured" ? { isFeatured: true } : {})
  });
  // A timeline reads forward through history; every other view reads newest-first like the rest of
  // the site.
  const order = (filter: CraftFilter): Prisma.CraftOrderByWithRelationInput[] =>
    filter.datedOnly
      ? [{ originYear: { sort: "asc", nulls: "last" } }, { name: "asc" }]
      : [{ publishedAt: { sort: "desc", nulls: "last" } }, { name: "asc" }];

  return {
    findAuto: (filter, mode, take) =>
      prisma.craft.findMany({
        where: where(filter, mode),
        orderBy: order(filter),
        take,
        select: craftSelect
      }),
    countAuto: (filter, mode) => prisma.craft.count({ where: where(filter, mode) }),
    findManual: (ids) =>
      prisma.craft.findMany({ where: { ...liveStatusWhere(), id: { in: ids } }, select: craftSelect }),
    hydrate: identity
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The census
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How each metric is counted.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ EVERY PREDICATE HERE IS THE ONE ITS OWN PUBLIC LISTING ALREADY USES, AND THAT IS THE WHOLE
 * REQUIREMENT. A figure counted with a filter its listing does not use is a figure that disagrees
 * with the page it sits above: "42 crafts documented" over a Craft Explorer showing 39 is a defect a
 * reader can see and nobody can explain. So each line below names where its twin lives.
 *
 *   crafts        `craftSource()` in this file, and app/(site)/craft-explorer  — liveStatusWhere()
 *   people        `personSource()` in this file, and app/(site)/people/page.tsx — liveStatusWhere()
 *                 PLUS `isVisible: true`. ⚠ Forgetting `isVisible` is the easy mistake here: a person
 *                 can be published, and so have a citable page, while being deliberately absent from
 *                 every directory. The listing hides them, so the census must not count them.
 *   projects      `projectSource()`, unfiltered by state — all published projects.
 *   research      `researchSource()`
 *   publications  `publicationSource()`, unfiltered by kind.
 *   events        `addEventJobs()`, with NEITHER the upcoming nor the past window: a census counts the
 *                 record, and an event that has happened is still a record of work done.
 *   albums        `albumSource()`
 *   galleryItems  `galleryImageSource()` — through the ALBUM, because `GalleryItem` carries no status
 *                 of its own. An album is the unit an editor publishes.
 *   partners      `partnerSource()`. ⚠ `Partner` has neither `status` nor `publishedAt`, so
 *                 `liveStatusWhere()` here would be a Prisma RUNTIME error rather than a type error —
 *                 the trap the file header names. Visible and not deleted is the equivalent predicate.
 *
 * `Post` is deliberately absent. News is the one collection carrying `publishAt`/`unpublishAt`, so a
 * "news items" figure would be true for a window rather than for a date and would tick DOWN on its
 * own as items retired. A figure that falls with nobody touching it reads as a fault; if it is ever
 * wanted it needs `livePublishableWhere(now)` and a note saying so.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
function censusCount(metric: CensusMetric): Prisma.PrismaPromise<number> {
  switch (metric) {
    case "crafts":
      return prisma.craft.count({ where: liveStatusWhere() });
    case "people":
      return prisma.person.count({ where: { ...liveStatusWhere(), isVisible: true } });
    case "projects":
      return prisma.project.count({ where: liveStatusWhere() });
    case "research":
      return prisma.researchArea.count({ where: liveStatusWhere() });
    case "publications":
      return prisma.publication.count({ where: liveStatusWhere() });
    case "events":
      return prisma.coeEvent.count({ where: liveStatusWhere() });
    case "albums":
      return prisma.galleryAlbum.count({ where: liveStatusWhere() });
    case "galleryItems":
      return prisma.galleryItem.count({ where: { album: liveStatusWhere() } });
    case "partners":
      return prisma.partner.count({ where: { deletedAt: null, isVisible: true } });
    default:
      /*
       * Unreachable while `CENSUS_METRICS` and this switch agree — and TypeScript PROVES they do, which
       * is the point: adding a metric to the tuple without a count here makes `metric` something other
       * than `never` on the line below and fails the build. That is the second half of the "adding a
       * metric is two edits, not one" warning in lib/sections/schema.ts.
       */
      return exhaustiveCensus(metric);
  }
}

function exhaustiveCensus(metric: never): never {
  throw new Error(`[sections] no count is defined for the census metric "${String(metric)}".`);
}

/**
 * Count only what this page's blocks actually asked for.
 *
 * A page with one stats block naming three metrics runs three `count`s, never all nine. They join the
 * SAME `$transaction` as every showcase on the page, which buys three things at once: one round trip
 * rather than one per figure; one consistent snapshot, so a crafts figure can never disagree with a
 * craft showcase two blocks below it; and the page's own `revalidate` window as the cache policy, with
 * no second policy to keep in step.
 */
function addCensusJobs(
  jobs: BatchJob[],
  figures: Record<CensusMetric, number | null>,
  metrics: ReadonlySet<CensusMetric>
): void {
  // Iterated over the TUPLE rather than over `metrics`, so the queries are issued in a stable order
  // whatever order the blocks named them in. Two renders of one page then produce the same statement
  // list, which is what makes a slow query log readable.
  for (const metric of CENSUS_METRICS) {
    if (!metrics.has(metric)) continue;
    jobs.push({
      query: censusCount(metric),
      receive: (result) => {
        figures[metric] = result as number;
      }
    });
  }
}

/**
 * Every media asset a payload names, in one query.
 *
 * Soft-deleted assets are excluded, so a hero whose background went to the recycle bin falls back to
 * its gradient rather than rendering a broken frame.
 */
function addMediaJob(jobs: BatchJob[], out: ResolvedSectionData, ids: readonly string[]): void {
  if (ids.length === 0) return;
  jobs.push({
    query: prisma.mediaAsset.findMany({
      where: { id: { in: [...ids] }, deletedAt: null },
      select: { id: true, ...mediaSelect }
    }),
    receive: (result) => {
      for (const row of result as (MediaRow & { id: string })[]) out.media[row.id] = row;
    }
  });
}
