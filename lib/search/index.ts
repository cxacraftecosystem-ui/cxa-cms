import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { TxClient } from "@/lib/audit";
import { isLive, type PublishableFields } from "@/lib/content";
import { richTextToPlainText } from "@/lib/richtext";
import { truncateWords, unique } from "@/lib/utils";

/**
 * The global search INDEX — everything that writes to `SearchDocument`.
 *
 * The site has ten searchable content types living in ten different tables with ten different
 * shapes. Searching them by UNION-ing ten queries would mean ten plans, ten sets of filters, and a
 * ranking that cannot compare a publication abstract with a craft description. So there is one
 * denormalised row per entity, and this module is the only thing that writes it.
 *
 * Three decisions worth stating, because they are all load-bearing elsewhere:
 *
 *  1. **`isPublished` is denormalised onto the index row.** The alternative — every caller
 *     remembering to join back to the source table and re-apply `isLive()` — is a rule that holds
 *     until the first caller forgets, and the failure mode is an embargoed draft appearing in public
 *     search results. It is computed here, once, with `isLive` from lib/content.ts.
 *
 *  2. **`keywords` are folded into the stored `body` as well as kept in the array column.** The
 *     full-text index in lib/search/query.ts is an EXPRESSION index, and an expression index must be
 *     IMMUTABLE — `array_to_string(keywords, ' ')` is only STABLE, so Postgres refuses to index any
 *     expression containing it. Rather than lose keyword matching, the keywords are appended to the
 *     indexed text at write time. The array column survives for facets and display.
 *
 *  3. **Every writer takes a `TxClient`.** Indexing joins the same transaction as the write it
 *     describes, so a rolled-back save cannot leave a search result pointing at content that does
 *     not exist. `prisma` itself satisfies `TxClient`, so a caller with no transaction can pass it
 *     directly.
 *
 * Soft-deleted rows are never indexed: `reindexAll` skips them and a delete route calls
 * `removeDocument`. The recycle bin is reached from the studio, not from search.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The type vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every entity type the index carries. The string is stable and stored in the database, so renaming
 * one is a data migration, not a rename — treat these as identifiers, not labels.
 */
export const SEARCH_ENTITY_TYPES = [
  "page",
  "person",
  "research-area",
  "project",
  "publication",
  "post",
  "event",
  "craft",
  "album",
  "file"
] as const;

export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

/** Singular, sentence-case labels for a facet list or a result badge. */
export const SEARCH_TYPE_LABELS: Record<SearchEntityType, string> = {
  page: "Page",
  person: "Person",
  "research-area": "Research area",
  project: "Project",
  publication: "Publication",
  post: "News",
  event: "Event",
  craft: "Craft",
  album: "Gallery album",
  file: "File"
};

export function isSearchEntityType(value: string): value is SearchEntityType {
  return (SEARCH_ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * A label for a stored `entityType`.
 *
 * Takes a plain `string`, not the union: an index row written by an older deployment can carry a
 * type this build no longer knows about, and a result the reader can still click is better than a
 * crash in a `Record` lookup.
 */
export function searchTypeLabel(entityType: string): string {
  return isSearchEntityType(entityType) ? SEARCH_TYPE_LABELS[entityType] : "Content";
}

/**
 * The public path for an indexed entity.
 *
 * ONE place builds these. If a public route ever moves, change it here and re-run `reindexAll()` —
 * the URL is stored on the row, so nothing else in the codebase needs to know the mapping.
 *
 * Files resolve to the download endpoint rather than a detail page because there is no public file
 * detail route; the trade-off is that following a file result starts a download.
 */
export function searchUrlFor(entityType: SearchEntityType, slug: string): string {
  const path = slug.replace(/^\/+/, "");
  switch (entityType) {
    // The homepage's slug is the empty string, which would otherwise build the path "/".
    case "page":
      return path.length === 0 ? "/" : `/${path}`;
    case "person":
      return `/people/${path}`;
    case "research-area":
      return `/research/${path}`;
    case "project":
      return `/projects/${path}`;
    case "publication":
      return `/publications/${path}`;
    case "post":
      return `/news/${path}`;
    case "event":
      return `/events/${path}`;
    case "craft":
      return `/craft-explorer/${path}`;
    case "album":
      return `/gallery/${path}`;
    case "file":
      // No `/download` suffix. The handler is a SINGLE dynamic segment —
      // `app/api/public/files/[slug]/route.ts` — so `/api/public/files/x/download` matches no route and
      // every file result on /search was a hard 404 while the card printed the path as though it worked.
      // ⚠ A change here is only half a fix: the wrong string is already persisted in
      // `SearchDocument.url`, so `reindexAll()` must be run afterwards.
      return `/api/public/files/${path}`;
    default:
      return "/";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing the index
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchDocumentInput {
  entityType: SearchEntityType;
  entityId: string;
  title: string;
  summary?: string | null;
  /** Plain text only. Markup and JSON structure are stripped before it gets here. */
  body?: string | null;
  url: string;
  keywords?: readonly string[];
  isPublished: boolean;
}

/**
 * Caps.
 *
 * A tsvector is limited to 1 MB and the cost of building one grows with the input, while the tail of
 * a long document almost never decides relevance. 20 000 characters is roughly 3 000 words — longer
 * than any piece on this site that is not a whole thesis. The cut is mid-word on purpose: the body
 * column is a search corpus and is never rendered, so a clean word boundary would buy nothing.
 */
const MAX_BODY_CHARS = 20_000;
const MAX_SUMMARY_CHARS = 320;
const MAX_KEYWORDS = 40;
const MAX_KEYWORD_CHARS = 80;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Join the parts of a body/summary that exist, dropping the ones that do not. */
function joinParts(parts: ReadonlyArray<string | null | undefined>, separator = " "): string {
  return collapse(parts.filter((part): part is string => Boolean(part && part.trim())).join(separator));
}

function cleanKeywords(values: readonly string[] | undefined): string[] {
  const cleaned = (values ?? [])
    .map((value) => collapse(value))
    .filter((value) => value.length > 0 && value.length <= MAX_KEYWORD_CHARS);
  return unique(cleaned).slice(0, MAX_KEYWORDS);
}

/**
 * Turn an enum value into something a reader would actually type.
 *
 * "JOURNAL_ARTICLE" lexes as a single token, so it matches the query "journal article" not at all.
 * Lower-cased and de-underscored, it matches both words.
 *
 * (The example used to be "RESEARCH_ASSISTANT", which was renamed to the single word "RESEARCHER" and
 * stopped demonstrating anything. Indexed text written before that rename still carries the old words,
 * which costs nothing: a stale document is rewritten the next time its record is saved, and until then
 * searching the old phrase simply still finds it.)
 */
function humaniseEnum(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.toLowerCase().replace(/_/g, " ");
}

/**
 * Rich text through the shared renderer's plain-text path.
 *
 * The indirection exists so a signature change in lib/richtext.ts (owned elsewhere) cannot break
 * this module: whatever parameter type it declares, the cast satisfies it, and the null/undefined
 * cases are handled here rather than being everyone's problem at every call site.
 */
function plainText(value: unknown): string {
  if (value === null || value === undefined) return "";
  const asText = richTextToPlainText(value as Parameters<typeof richTextToPlainText>[0]);
  return typeof asText === "string" ? collapse(asText) : "";
}

/**
 * The keys inside a `PageSection.data` payload that hold prose.
 *
 * An allowlist rather than a blanket walk of every string in the JSON: a blanket walk sweeps in
 * cuids, storage keys, hex colours, icon names and URLs, none of which any reader will ever type,
 * and all of which dilute the ranking of the words that matter.
 */
const SECTION_TEXT_KEYS = new Set([
  "heading",
  "title",
  "subtitle",
  "eyebrow",
  "text",
  "body",
  "summary",
  "description",
  "caption",
  "quote",
  "attribution",
  "question",
  "answer",
  "name",
  "role"
]);

function collectSectionText(value: unknown, out: string[], depth = 0): void {
  if (depth > 8 || out.length > 400) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectSectionText(entry, out, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  // A nested Tiptap document goes through the real renderer rather than the key allowlist, which
  // would otherwise pick up the node names ("paragraph", "heading") and none of the words.
  if (record.type === "doc" && Array.isArray(record.content)) {
    out.push(plainText(record));
    return;
  }
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") {
      if (SECTION_TEXT_KEYS.has(key)) out.push(entry);
      continue;
    }
    collectSectionText(entry, out, depth + 1);
  }
}

/** Searchable prose out of a page's typed section payloads. */
export function plainTextFromSections(
  sections: ReadonlyArray<{ isVisible?: boolean; data: unknown }> | null | undefined
): string {
  if (!sections || sections.length === 0) return "";
  const out: string[] = [];
  for (const section of sections) {
    // A hidden section is not on the page, so matching it would send a reader to a page where the
    // words they searched for do not appear.
    if (section.isVisible === false) continue;
    collectSectionText(section.data, out);
  }
  return collapse(out.join(" "));
}

/**
 * Strip MDX down to its prose.
 *
 * Order matters: code fences before inline code, images before links (an image is a link with a
 * leading `!`, so handling links first leaves a stray `!` and the alt text of every image).
 */
export function plainTextFromMdx(mdx: string | null | undefined): string {
  if (!mdx) return "";
  return collapse(
    mdx
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`[^`]*`/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, " ")
      .replace(/^\s{0,3}(?:#{1,6}|>)\s*/gm, " ")
      .replace(/[*_~|]+/g, " ")
  );
}

/**
 * The row Prisma writes, built once so `indexDocument` and `reindexAll` cannot drift apart.
 *
 * `body` is the concatenation the full-text expression in lib/search/query.ts reads — see decision 2
 * in the header for why the keywords are in it.
 */
function upsertArgs(input: SearchDocumentInput): Prisma.SearchDocumentUpsertArgs {
  const keywords = cleanKeywords(input.keywords);
  const title = collapse(input.title) || `Untitled ${SEARCH_TYPE_LABELS[input.entityType].toLowerCase()}`;
  const summary = collapse(input.summary ?? "");
  const merged = joinParts([input.body ?? "", keywords.join(" ")]);

  const fields = {
    title,
    summary: summary.length > 0 ? truncateWords(summary, MAX_SUMMARY_CHARS) : null,
    body: merged.length > MAX_BODY_CHARS ? merged.slice(0, MAX_BODY_CHARS) : merged,
    url: input.url,
    keywords,
    isPublished: input.isPublished
  };

  return {
    where: { entityType_entityId: { entityType: input.entityType, entityId: input.entityId } },
    create: { entityType: input.entityType, entityId: input.entityId, ...fields },
    update: fields
  };
}

/**
 * Upsert one document.
 *
 * Upsert rather than create-or-update-by-hand: (entityType, entityId) is unique, and a route that
 * checked for existence first would race with a concurrent save on the same entity.
 */
export async function indexDocument(client: TxClient, input: SearchDocumentInput): Promise<void> {
  await client.searchDocument.upsert(upsertArgs(input));
}

/**
 * Drop a document.
 *
 * `deleteMany`, not `delete`: deleting a row that was never indexed must be a no-op. `delete` throws
 * P2025 when nothing matches, which inside a transaction would roll back the deletion of the entity
 * itself — the content would survive because its search row did not.
 */
export async function removeDocument(
  client: TxClient,
  entityType: SearchEntityType,
  entityId: string
): Promise<void> {
  await client.searchDocument.deleteMany({ where: { entityType, entityId } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-entity extractors
//
// Each takes the row as read from Prisma and returns the index shape. The row types are structural
// and minimal, so a caller may pass a fuller row than the extractor needs. Enum columns are typed as
// `string` because these functions only humanise them — a new enum member should widen the search
// corpus, not break the build.
//
// Every extractor takes an optional `now`, so one rebuild resolves publication state against a
// single instant rather than drifting across a long run.
// ─────────────────────────────────────────────────────────────────────────────

export interface IndexablePage extends PublishableFields {
  id: string;
  slug: string;
  title: string;
  navLabel?: string | null;
  seoDescription?: string | null;
  seoNoIndex?: boolean;
  sections?: ReadonlyArray<{ isVisible?: boolean; data: unknown }> | null;
}

/**
 * Should this page appear in the site's own search at `now`?
 *
 * A page the editor has asked search engines to skip should not surface in the site's own search
 * either — the intent is "this page is not a destination", and it does not stop at Google. So the
 * predicate is `isLive` AND NOT `seoNoIndex`, which is more than `isLive` alone.
 *
 * Named and exported for the same reason as `fileIsPublished` below: TWO callers need exactly this
 * answer — `searchDocFromPage` when somebody saves a page, and `resyncPublishedFlags` when nobody has
 * saved anything and only the clock has moved. A hand-rolled copy in the sweep is how the two came to
 * disagree, and because the sweep runs unattended every few minutes it is the copy that wins: it
 * quietly republished every noindex page into the search box and reported it as a correction.
 */
export function pageIsPublished(
  page: PublishableFields & { seoNoIndex?: boolean },
  now: Date = new Date()
): boolean {
  return isLive(page, now) && page.seoNoIndex !== true;
}

export function searchDocFromPage(page: IndexablePage, now: Date = new Date()): SearchDocumentInput {
  return {
    entityType: "page",
    entityId: page.id,
    title: page.title,
    summary: page.seoDescription ?? null,
    body: joinParts([page.navLabel, page.seoDescription, plainTextFromSections(page.sections)]),
    url: searchUrlFor("page", page.slug),
    keywords: [],
    isPublished: pageIsPublished(page, now)
  };
}

export interface IndexablePerson extends PublishableFields {
  id: string;
  slug: string;
  name: string;
  kind?: string | null;
  designation?: string | null;
  department?: string | null;
  bio?: string | null;
  bioRich?: unknown;
  researchInterests?: readonly string[];
  isVisible?: boolean;
}

export function searchDocFromPerson(
  person: IndexablePerson,
  now: Date = new Date()
): SearchDocumentInput {
  return {
    entityType: "person",
    entityId: person.id,
    title: person.name,
    summary: joinParts([person.designation, person.department], ", "),
    body: joinParts([person.designation, person.department, person.bio, plainText(person.bioRich)]),
    url: searchUrlFor("person", person.slug),
    keywords: [...(person.researchInterests ?? []), humaniseEnum(person.kind) ?? ""],
    // `isVisible` hides a person from every public listing; search is a public listing.
    isPublished: isLive(person, now) && person.isVisible !== false
  };
}

export interface IndexableResearchArea extends PublishableFields {
  id: string;
  slug: string;
  title: string;
  summary?: string | null;
  body?: unknown;
}

export function searchDocFromResearchArea(
  area: IndexableResearchArea,
  now: Date = new Date()
): SearchDocumentInput {
  return {
    entityType: "research-area",
    entityId: area.id,
    title: area.title,
    summary: area.summary ?? null,
    body: joinParts([area.summary, plainText(area.body)]),
    url: searchUrlFor("research-area", area.slug),
    keywords: [],
    isPublished: isLive(area, now)
  };
}

export interface IndexableProject extends PublishableFields {
  id: string;
  slug: string;
  title: string;
  tagline?: string | null;
  summary?: string | null;
  body?: unknown;
  state?: string | null;
  fundingBody?: string | null;
  researchArea?: { title: string } | null;
}

export function searchDocFromProject(
  project: IndexableProject,
  now: Date = new Date()
): SearchDocumentInput {
  return {
    entityType: "project",
    entityId: project.id,
    title: project.title,
    summary: project.tagline ?? project.summary ?? null,
    body: joinParts([project.tagline, project.summary, plainText(project.body), project.fundingBody]),
    url: searchUrlFor("project", project.slug),
    keywords: [
      humaniseEnum(project.state) ?? "",
      project.fundingBody ?? "",
      project.researchArea?.title ?? ""
    ],
    isPublished: isLive(project, now)
  };
}

export interface IndexablePublication extends PublishableFields {
  id: string;
  slug: string;
  title: string;
  kind?: string | null;
  abstract?: string | null;
  authorLine: string;
  venue?: string | null;
  publisher?: string | null;
  year: number;
  doi?: string | null;
  arxivId?: string | null;
  keywords?: readonly string[];
  researchArea?: { title: string } | null;
}

export function searchDocFromPublication(
  publication: IndexablePublication,
  now: Date = new Date()
): SearchDocumentInput {
  const venue = publication.venue ?? publication.publisher ?? null;
  return {
    entityType: "publication",
    entityId: publication.id,
    title: publication.title,
    // The citation line is the summary because it is what a reader scans a results list for — who
    // wrote it, where, and when.
    summary: joinParts([publication.authorLine, venue, String(publication.year)], ", "),
    body: joinParts([publication.abstract, publication.authorLine, venue]),
    url: searchUrlFor("publication", publication.slug),
    keywords: [
      ...(publication.keywords ?? []),
      humaniseEnum(publication.kind) ?? "",
      publication.doi ?? "",
      publication.arxivId ?? "",
      publication.researchArea?.title ?? ""
    ],
    isPublished: isLive(publication, now)
  };
}

export interface IndexablePost extends PublishableFields {
  id: string;
  slug: string;
  title: string;
  subtitle?: string | null;
  excerpt?: string | null;
  body?: unknown;
  mdx?: string | null;
  category?: { name: string } | null;
  tags?: ReadonlyArray<{ tag: { name: string } }> | null;
}

export function searchDocFromPost(post: IndexablePost, now: Date = new Date()): SearchDocumentInput {
  return {
    entityType: "post",
    entityId: post.id,
    title: post.title,
    summary: post.excerpt ?? post.subtitle ?? null,
    // `body` and `mdx` are mutually exclusive per post, but reading both costs nothing and means an
    // article that switched modes mid-life is still fully searchable.
    body: joinParts([post.subtitle, post.excerpt, plainText(post.body), plainTextFromMdx(post.mdx)]),
    url: searchUrlFor("post", post.slug),
    keywords: [
      post.category?.name ?? "",
      ...(post.tags ?? []).map((link) => link.tag.name)
    ],
    isPublished: isLive(post, now)
  };
}

export interface IndexableEvent extends PublishableFields {
  id: string;
  slug: string;
  title: string;
  subtitle?: string | null;
  summary?: string | null;
  body?: unknown;
  mode?: string | null;
  venue?: string | null;
  address?: string | null;
  tags?: ReadonlyArray<{ tag: { name: string } }> | null;
}

export function searchDocFromEvent(
  event: IndexableEvent,
  now: Date = new Date()
): SearchDocumentInput {
  return {
    entityType: "event",
    entityId: event.id,
    title: event.title,
    summary: event.summary ?? event.subtitle ?? null,
    body: joinParts([
      event.subtitle,
      event.summary,
      plainText(event.body),
      event.venue,
      event.address
    ]),
    url: searchUrlFor("event", event.slug),
    keywords: [
      humaniseEnum(event.mode) ?? "",
      event.venue ?? "",
      ...(event.tags ?? []).map((link) => link.tag.name)
    ],
    isPublished: isLive(event, now)
  };
}

export interface IndexableCraft extends PublishableFields {
  id: string;
  slug: string;
  name: string;
  localName?: string | null;
  summary?: string | null;
  body?: unknown;
  originNote?: string | null;
  materials?: readonly string[];
  techniques?: readonly string[];
  region?: { name: string } | null;
  school?: { name: string } | null;
}

export function searchDocFromCraft(
  craft: IndexableCraft,
  now: Date = new Date()
): SearchDocumentInput {
  return {
    entityType: "craft",
    entityId: craft.id,
    title: craft.name,
    summary: craft.summary ?? null,
    // The local name is indexed as written, in its own script. A reader who types it should find the
    // craft even though the English name is what the card shows.
    body: joinParts([
      craft.localName,
      craft.summary,
      plainText(craft.body),
      craft.originNote,
      craft.region?.name,
      craft.school?.name
    ]),
    url: searchUrlFor("craft", craft.slug),
    keywords: [
      craft.localName ?? "",
      ...(craft.materials ?? []),
      ...(craft.techniques ?? []),
      craft.region?.name ?? "",
      craft.school?.name ?? ""
    ],
    isPublished: isLive(craft, now)
  };
}

export interface IndexableAlbum extends PublishableFields {
  id: string;
  slug: string;
  title: string;
  description?: string | null;
  category?: string | null;
  location?: string | null;
  credit?: string | null;
  tags?: readonly string[];
  items?: ReadonlyArray<{ caption?: string | null }> | null;
}

export function searchDocFromAlbum(
  album: IndexableAlbum,
  now: Date = new Date()
): SearchDocumentInput {
  return {
    entityType: "album",
    entityId: album.id,
    title: album.title,
    summary: album.description ?? null,
    // Captions are often the only prose an album has; without them a photo essay is one sentence
    // long as far as search is concerned.
    body: joinParts([
      album.description,
      album.location,
      album.credit,
      ...(album.items ?? []).map((item) => item.caption ?? "")
    ]),
    url: searchUrlFor("album", album.slug),
    keywords: [...(album.tags ?? []), album.category ?? "", album.location ?? ""],
    isPublished: isLive(album, now)
  };
}

export interface IndexableFile {
  id: string;
  slug: string;
  title: string;
  description?: string | null;
  category?: string | null;
  isPublic: boolean;
  expiresAt?: Date | null;
  deletedAt?: Date | null;
}

/**
 * Is this file publicly downloadable at `now`?
 *
 * `FileAsset` has no `ContentStatus` column, so `isLive` does not apply to it — passing a row without
 * `status` would be a runtime error, exactly the trap lib/content.ts splits its two `where` helpers
 * to avoid. The equivalent predicate is spelled out here instead, expiry included: an embargoed
 * download that has lapsed must leave the index, not merely be refused at the route, because the
 * TITLE of an embargoed dataset in a search result is itself a disclosure.
 *
 * Named and exported rather than written inline, because TWO callers need exactly this answer:
 * `searchDocFromFile` when somebody saves a file, and `resyncPublishedFlags` when nobody has saved
 * anything and only the clock has moved. Two hand-rolled copies of "public, not deleted, not expired"
 * is how the write path and the sweep would eventually disagree about the same file.
 */
export function fileIsPublished(
  file: { isPublic: boolean; expiresAt?: Date | null; deletedAt?: Date | null },
  now: Date = new Date()
): boolean {
  if (file.deletedAt) return false;
  if (!file.isPublic) return false;
  // No expiry means no embargo. An expiry exactly at `now` has passed — the download route refuses it,
  // and the index must agree with the door.
  return !file.expiresAt || file.expiresAt.getTime() > now.getTime();
}

export function searchDocFromFile(file: IndexableFile, now: Date = new Date()): SearchDocumentInput {
  return {
    entityType: "file",
    entityId: file.id,
    title: file.title,
    summary: file.description ?? null,
    body: joinParts([file.description, file.category]),
    url: searchUrlFor("file", file.slug),
    keywords: [file.category ?? ""],
    isPublished: fileIsPublished(file, now)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Full rebuild
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rows per page, and per transaction.
 *
 * Small enough that one batch is a short transaction and a modest amount of memory; large enough
 * that a few thousand rows is tens of round trips rather than thousands. One enormous `createMany`
 * over the whole corpus would hold a write lock for the length of the rebuild.
 */
const REINDEX_BATCH = 100;

interface IndexSource<T extends { id: string }> {
  type: SearchEntityType;
  /** Keyset pagination on `id`: stable under concurrent inserts, unlike `skip`/`take`. */
  page: (cursor: string | null, take: number) => Promise<T[]>;
  toDocument: (row: T) => SearchDocumentInput;
}

/** The generic erased, so the ten sources can live in one array without `any`. */
interface ErasedSource {
  type: SearchEntityType;
  run: () => Promise<number>;
}

function defineSource<T extends { id: string }>(source: IndexSource<T>): ErasedSource {
  return { type: source.type, run: () => indexSource(source) };
}

async function indexSource<T extends { id: string }>(source: IndexSource<T>): Promise<number> {
  let cursor: string | null = null;
  let count = 0;

  for (;;) {
    const rows = await source.page(cursor, REINDEX_BATCH);
    if (rows.length === 0) break;

    await prisma.$transaction(rows.map((row) => prisma.searchDocument.upsert(upsertArgs(source.toDocument(row)))));
    count += rows.length;

    // The bound is proved by the length check above, but `noUncheckedIndexedAccess` cannot see that,
    // and a silent `undefined` cursor here would restart the scan from the beginning forever.
    const last = rows[rows.length - 1];
    if (!last || rows.length < REINDEX_BATCH) break;
    cursor = last.id;
  }

  return count;
}

/**
 * `take`/`cursor` in the shape every source's `findMany` wants.
 *
 * ONE object shape, with `cursor: undefined` for the first page rather than a branch that omits the
 * key: Prisma infers its argument type exactly, and a union of two shapes does not satisfy that
 * inference — the call fails to type-check even though both halves are individually valid.
 */
function pageArgs(cursor: string | null, take: number) {
  return {
    take,
    orderBy: { id: "asc" as const },
    cursor: cursor ? { id: cursor } : undefined,
    // `skip: 1` steps past the cursor row itself. Zero on the first page, where there is none.
    skip: cursor ? 1 : 0
  };
}

function buildSources(now: Date): ErasedSource[] {
  return [
    defineSource({
      type: "page",
      page: (cursor, take) =>
        prisma.page.findMany({
          ...pageArgs(cursor, take),
          where: { deletedAt: null },
          select: {
            id: true,
            slug: true,
            title: true,
            navLabel: true,
            seoDescription: true,
            seoNoIndex: true,
            status: true,
            publishedAt: true,
            publishAt: true,
            unpublishAt: true,
            deletedAt: true,
            sections: { select: { isVisible: true, data: true } }
          }
        }),
      toDocument: (row) => searchDocFromPage(row, now)
    }),
    defineSource({
      type: "person",
      page: (cursor, take) =>
        prisma.person.findMany({
          ...pageArgs(cursor, take),
          where: { deletedAt: null },
          select: {
            id: true,
            slug: true,
            name: true,
            kind: true,
            designation: true,
            department: true,
            bio: true,
            bioRich: true,
            researchInterests: true,
            isVisible: true,
            status: true,
            publishedAt: true,
            deletedAt: true
          }
        }),
      toDocument: (row) => searchDocFromPerson(row, now)
    }),
    defineSource({
      type: "research-area",
      page: (cursor, take) =>
        prisma.researchArea.findMany({
          ...pageArgs(cursor, take),
          where: { deletedAt: null },
          select: {
            id: true,
            slug: true,
            title: true,
            summary: true,
            body: true,
            status: true,
            publishedAt: true,
            deletedAt: true
          }
        }),
      toDocument: (row) => searchDocFromResearchArea(row, now)
    }),
    defineSource({
      type: "project",
      page: (cursor, take) =>
        prisma.project.findMany({
          ...pageArgs(cursor, take),
          where: { deletedAt: null },
          select: {
            id: true,
            slug: true,
            title: true,
            tagline: true,
            summary: true,
            body: true,
            state: true,
            fundingBody: true,
            status: true,
            publishedAt: true,
            deletedAt: true,
            researchArea: { select: { title: true } }
          }
        }),
      toDocument: (row) => searchDocFromProject(row, now)
    }),
    defineSource({
      type: "publication",
      page: (cursor, take) =>
        prisma.publication.findMany({
          ...pageArgs(cursor, take),
          where: { deletedAt: null },
          select: {
            id: true,
            slug: true,
            title: true,
            kind: true,
            abstract: true,
            authorLine: true,
            venue: true,
            publisher: true,
            year: true,
            doi: true,
            arxivId: true,
            keywords: true,
            status: true,
            publishedAt: true,
            deletedAt: true,
            researchArea: { select: { title: true } }
          }
        }),
      toDocument: (row) => searchDocFromPublication(row, now)
    }),
    defineSource({
      type: "post",
      page: (cursor, take) =>
        prisma.post.findMany({
          ...pageArgs(cursor, take),
          where: { deletedAt: null },
          select: {
            id: true,
            slug: true,
            title: true,
            subtitle: true,
            excerpt: true,
            body: true,
            mdx: true,
            status: true,
            publishedAt: true,
            publishAt: true,
            unpublishAt: true,
            deletedAt: true,
            category: { select: { name: true } },
            tags: { select: { tag: { select: { name: true } } } }
          }
        }),
      toDocument: (row) => searchDocFromPost(row, now)
    }),
    defineSource({
      type: "event",
      page: (cursor, take) =>
        prisma.coeEvent.findMany({
          ...pageArgs(cursor, take),
          where: { deletedAt: null },
          select: {
            id: true,
            slug: true,
            title: true,
            subtitle: true,
            summary: true,
            body: true,
            mode: true,
            venue: true,
            address: true,
            status: true,
            publishedAt: true,
            deletedAt: true,
            tags: { select: { tag: { select: { name: true } } } }
          }
        }),
      toDocument: (row) => searchDocFromEvent(row, now)
    }),
    defineSource({
      type: "craft",
      page: (cursor, take) =>
        prisma.craft.findMany({
          ...pageArgs(cursor, take),
          where: { deletedAt: null },
          select: {
            id: true,
            slug: true,
            name: true,
            localName: true,
            summary: true,
            body: true,
            originNote: true,
            materials: true,
            techniques: true,
            status: true,
            publishedAt: true,
            deletedAt: true,
            region: { select: { name: true } },
            school: { select: { name: true } }
          }
        }),
      toDocument: (row) => searchDocFromCraft(row, now)
    }),
    defineSource({
      type: "album",
      page: (cursor, take) =>
        prisma.galleryAlbum.findMany({
          ...pageArgs(cursor, take),
          where: { deletedAt: null },
          select: {
            id: true,
            slug: true,
            title: true,
            description: true,
            category: true,
            location: true,
            credit: true,
            tags: true,
            status: true,
            publishedAt: true,
            deletedAt: true,
            items: { select: { caption: true } }
          }
        }),
      toDocument: (row) => searchDocFromAlbum(row, now)
    }),
    defineSource({
      type: "file",
      page: (cursor, take) =>
        prisma.fileAsset.findMany({
          ...pageArgs(cursor, take),
          where: { deletedAt: null },
          select: {
            id: true,
            slug: true,
            title: true,
            description: true,
            category: true,
            isPublic: true,
            expiresAt: true,
            deletedAt: true
          }
        }),
      toDocument: (row) => searchDocFromFile(row, now)
    })
  ];
}

/**
 * Rebuild the whole index, for the studio's maintenance panel.
 *
 * The sweep at the end is the subtle part. Stale rows — entities deleted while the index was stale,
 * or types that have been retired — are identified by `updatedAt < startedAt`: Prisma's `@updatedAt`
 * bumps on every upsert whether or not a value changed, so anything this run touched has a newer
 * timestamp and anything it did not is by definition no longer indexable. That is bounded and needs
 * no giant `NOT IN` list. It also does the right thing under concurrency — a save that lands
 * mid-rebuild writes `now` and survives the sweep.
 *
 * The sweep runs only if every source completed. A failure part-way through throws before it, so a
 * half-finished rebuild leaves the previous index in place rather than deleting most of it.
 */
export async function reindexAll(): Promise<{ indexed: number; byType: Record<string, number> }> {
  const startedAt = new Date();
  const byType: Record<string, number> = {};
  let indexed = 0;

  for (const source of buildSources(startedAt)) {
    const count = await source.run();
    byType[source.type] = count;
    indexed += count;
  }

  await prisma.searchDocument.deleteMany({ where: { updatedAt: { lt: startedAt } } });

  return { indexed, byType };
}

/**
 * Re-evaluate `isPublished` for every indexed page, article and file.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS, AND WHY A REINDEX WOULD BE THE WRONG TOOL.
 *
 * `SearchDocument.isPublished` is computed by `isLive()` AT WRITE TIME, and the two search predicates
 * filter on that column alone — they never join back to the source row. Publication state, however, is
 * resolved at READ time from `publishAt` / `unpublishAt` (lib/content.ts), which means it can change
 * with nothing more than the clock advancing, and nothing writes the row when it does:
 *
 *   • a PUBLISHED page whose `unpublishAt` passes vanishes from the site and 404s at its own URL, but
 *     its title and summary keep being returned by /search and /api/public/suggest — INDEFINITELY.
 *     That is the leak this function exists to close: a withdrawn page is still findable by name.
 *   • symmetrically, a SCHEDULED article goes live at its minute but stays ABSENT from the site's own
 *     search until somebody happens to re-save it.
 *   • and a FILE whose `expiresAt` passes goes on appearing in public search results with its title
 *     and description, while its download correctly refuses. `FileAsset` has no publication status at
 *     all and no cron transition — the expiry alone decides — so a lapsed embargo is the ONLY way its
 *     index row can go stale, and it is the case where the stale row discloses something.
 *
 * A full `reindexAll()` would fix both, and is far too heavy to run every ten minutes: it re-reads and
 * re-writes every row of every content type. This touches only the one boolean, in two statements, and
 * it is idempotent — so the publish cron can call it on every pass.
 *
 * It recomputes from the SOURCE ROWS rather than from what the cron happened to transition, so a
 * deployment whose cron has not run for a day converges on the first pass afterwards, and a stalled
 * cron leaves the index at worst stale rather than permanently wrong.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function resyncPublishedFlags(
  now: Date = new Date()
): Promise<{ checked: number; corrected: number }> {
  const [pages, posts, files, documents] = await Promise.all([
    // `seoNoIndex` is selected because `pageIsPublished` reads it. Recomputing from `isLive` alone here
    // would contradict what the save path wrote and republish every noindex page into the search box.
    prisma.page.findMany({
      select: {
        id: true,
        status: true,
        publishedAt: true,
        publishAt: true,
        unpublishAt: true,
        deletedAt: true,
        seoNoIndex: true
      }
    }),
    prisma.post.findMany({
      select: { id: true, status: true, publishedAt: true, publishAt: true, unpublishAt: true, deletedAt: true }
    }),
    // Three columns, because `fileIsPublished` reads three. A file has no status and no schedule.
    prisma.fileAsset.findMany({
      select: { id: true, isPublic: true, expiresAt: true, deletedAt: true }
    }),
    prisma.searchDocument.findMany({
      where: { entityType: { in: ["page", "post", "file"] } },
      select: { id: true, entityType: true, entityId: true, isPublished: true }
    })
  ]);

  const liveById = new Map<string, boolean>();
  // ⚠ EVERY LINE HERE MUST BE THE SAME PREDICATE THE EXTRACTOR ABOVE WROTE, or this sweep spends its
  // time undoing the save path — permanently, because once the two agree on the wrong value no later
  // pass flips it back. Hence the shared helpers rather than a second copy of each rule.
  for (const page of pages) liveById.set(`page:${page.id}`, pageIsPublished(page, now));
  for (const post of posts) liveById.set(`post:${post.id}`, isLive(post, now));
  // Not `isLive`: a file has no `status` column, and handing one to `isLive` would be the runtime error
  // lib/content.ts splits its two `where` helpers to avoid. See `fileIsPublished`.
  for (const file of files) liveById.set(`file:${file.id}`, fileIsPublished(file, now));

  const shouldBeTrue: string[] = [];
  const shouldBeFalse: string[] = [];

  for (const document of documents) {
    // A document whose source row has vanished entirely is left alone: `reindexAll()` prunes those by
    // timestamp, and guessing here risks hiding a row whose model simply is not in the three above.
    const live = liveById.get(`${document.entityType}:${document.entityId}`);
    if (live === undefined) continue;
    if (live === document.isPublished) continue;
    (live ? shouldBeTrue : shouldBeFalse).push(document.id);
  }

  // Two statements rather than one per row. `updateMany` with an `in` list is a single round trip, and
  // the flag is the only column being written.
  if (shouldBeTrue.length > 0) {
    await prisma.searchDocument.updateMany({
      where: { id: { in: shouldBeTrue } },
      data: { isPublished: true }
    });
  }
  if (shouldBeFalse.length > 0) {
    await prisma.searchDocument.updateMany({
      where: { id: { in: shouldBeFalse } },
      data: { isPublished: false }
    });
  }

  return { checked: documents.length, corrected: shouldBeTrue.length + shouldBeFalse.length };
}
