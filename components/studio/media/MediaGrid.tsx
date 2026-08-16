/**
 * MediaGrid — the tile grid every media surface renders through, and the home of the shapes the
 * media screens and the `/api/studio/media/*` routes both speak.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THERE IS NO `"use client"` HERE, AND IT MUST NOT BE ADDED.
 *
 * Every export of a `"use client"` module becomes a CLIENT REFERENCE, and calling one from a Server
 * Component fails at runtime with "attempted to call a client function from the server". The server
 * page (`app/studio/media/page.tsx`) reads `readMediaFilters()`, `mediaFiltersAreDefault()` and
 * `MEDIA_PAGE_SIZE` from this file in order to render the first page itself — so the directive would
 * break the screen, not merely enlarge a bundle.
 *
 * The component below has event handlers and no hooks, which is fine: `"use client"` marks a BOUNDARY,
 * and this component is only ever rendered from one (MediaLibrary and MediaPicker both carry it), so it
 * is compiled into their client bundles by the ordinary rules. Rendering it directly from a Server
 * Component would be an error — with a clear message saying so.
 *
 * WHY THE SHARED TYPES LIVE IN THIS FILE. This feature has no types module of its own, and this is
 * the one component with no sibling imports — the library, the picker, the detail panel, the folder
 * tree, the bulk bar and the cropper all render through it. Putting the shapes here means there is
 * exactly one definition of "a media asset as it arrives over JSON" and no import cycle. If a types
 * module is ever added, move them wholesale rather than copying them.
 *
 * `StudioMediaAsset` IS STRUCTURALLY IDENTICAL TO `UploadedMediaAsset` from lib/client/upload.ts, on
 * purpose. A file that has just finished uploading can be put straight into the grid with no re-fetch
 * and no cast — which is the whole reason the upload result carries the full row rather than an id.
 *
 * ⚠ DATES ARRIVE AS ISO STRINGS, not `Date` objects. JSON has no date type and `lib/client/fetcher.ts`
 * does not revive them; `new Date(asset.createdAt)` is the caller's job.
 *
 * SELECTION IS NOT HELD HERE. The grid reports an intent — replace, toggle, or "range from the last
 * one I touched" — and the screen that owns the list resolves it, because only that screen knows the
 * order the range runs through. A grid that held its own selection would lose it on every re-fetch,
 * and the bulk bar above it would be reading a different set from the one on screen.
 *
 * `assets === null` MEANS LOADING and renders placeholder tiles; `assets === []` means there is
 * nothing here and renders `emptyState`. They are different screens (contract §9) — "No images"
 * during a fetch tells an administrator their library has vanished.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * NO ENTRANCE ANIMATION ON THE TILES. The studio is calm and dense: somebody who typed the address
 * wants the grid to be there, not to arrive. The only motion is `.flash-row`, the recipe from
 * globals.css that says "this is the one you just changed" — and its static purple outline is the
 * half of that signal a reduced-motion reader still gets (contract §1.4).
 */

import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
  Box,
  FileText,
  Film,
  Image as ImageIcon,
  ScanEye,
  TriangleAlert,
  Volume2,
  type LucideIcon
} from "lucide-react";

import { buildQuery } from "@/lib/client/fetcher";
import type { MediaKindName } from "@/lib/client/upload";
import type { MediaLike } from "@/lib/media/url";
import { cn, formatBytes } from "@/lib/utils";
import { Checkbox } from "@/components/ui/Checkbox";
import { MediaImage } from "@/components/ui/MediaImage";

export type { MediaKindName };

// ─── The shapes ─────────────────────────────────────────────────────────────────────────────────

export interface MediaVariantSummary {
  id: string;
  /** "thumb" | "sm" | "md" | "lg" | "xl" | "og" — see VARIANT_LABELS in lib/media/url.ts. */
  label: string;
  format: string;
  objectKey: string;
  width: number;
  height: number;
  byteSize: number;
}

/**
 * One media asset as the studio API returns it.
 *
 * Extends `MediaLike` so it can be handed straight to `<MediaImage>`; `variants` is optional because
 * a non-image, or an image whose derivatives have not been generated, legitimately has none.
 */
export interface StudioMediaAsset extends MediaLike {
  id: string;
  kind: MediaKindName;
  objectKey: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  checksum: string | null;
  blurDataUrl: string | null;
  /**
   * `null` means NOBODY HAS WRITTEN ONE. `""` means somebody decided the image is decorative, which
   * is a real answer in HTML — it tells a screen reader to skip the image. The two are different
   * statements and the whole library UI keeps them apart; see `altState()` below.
   */
  altText: string | null;
  caption: string | null;
  credit: string | null;
  copyright: string | null;
  tags: string[];
  folderId: string | null;
  uploaderId: string | null;
  /**
   * The stored crop, as fractions of the FULL image (0–1, origin top left), or five nulls for "nobody
   * has chosen — show the whole picture".
   *
   * ⚠ ALL FIVE MOVE TOGETHER. Four of five is not a rectangle, and both the render side
   * (`isUsableCrop` in components/studio/ImageCropper.tsx) and the API refuse an incomplete set rather
   * than guessing at the missing number. Optional on this type because a row read by an older client,
   * or a `MediaLike` assembled by a section that never selected these columns, legitimately has none —
   * and "no crop" is the same outcome either way.
   */
  cropX?: number | null;
  cropY?: number | null;
  cropWidth?: number | null;
  cropHeight?: number | null;
  /** The preset the editor chose ("16-9", "og", "free"). Nothing renders from it — see `cropX`. */
  cropAspect?: string | null;
  /** ISO 8601. Not a `Date`. */
  createdAt: string;
  updatedAt: string;
  variants?: { label: string; format: string; objectKey: string; width: number }[];
}

/** Where something is used. `href` is null when the thing has no editor screen of its own. */
export interface MediaUsage {
  /** The record's own name — "Bagru dyeing", not "Craft 7". This is what makes a warning actionable. */
  label: string;
  /** Plain words for the kind of use: "news article cover", "album photograph". */
  where: string;
  href: string | null;
}

export interface MediaAssetDetail extends StudioMediaAsset {
  folder: { id: string; name: string; path: string } | null;
  uploader: { id: string; name: string } | null;
  variants: MediaVariantSummary[];
  /** Every place this asset appears, computed across all the relations that point at it. */
  usage: MediaUsage[];
  /** True when the server stopped counting. The panel says so out loud (contract §1.6). */
  usageTruncated?: boolean;
  /** Other live assets with byte-for-byte identical contents. */
  duplicates?: { id: string; fileName: string }[];
  /**
   * How many days a deleted file can still be restored for — `MEDIA_PURGE_AFTER_DAYS`, as configured
   * on THIS installation.
   *
   * It arrives over the wire rather than being written into a component because the browser cannot
   * read it: the variable has no `NEXT_PUBLIC_` prefix, which is right. Optional, because an older
   * server answers without it, and the wording falls back to naming the recycle bin without a number
   * rather than inventing one (contract §1.6 — say what you do not know).
   */
  recoveryDays?: number;
}

/**
 * What `DELETE /api/studio/media/:id` answers.
 *
 * ⚠ THE REFERENCES ARE RE-READ AT DELETE TIME AND SENT BACK, so a page that started using the file
 * between opening the panel and pressing the button is still named. Anything that deletes must show
 * this list; discarding it is how an administrator finds out from a reader instead.
 */
export interface MediaDeleteResponse {
  deleted: true;
  id: string;
  fileName: string;
  references: MediaUsage[];
  referenceCount: number;
  referencesTruncated: boolean;
  /** The configured recovery window in days. See `MediaAssetDetail.recoveryDays`. */
  recoveryDays?: number;
  /** A whole sentence, already fit to show a reader. */
  message: string;
}

/**
 * A folder as the API returns it — FLAT, with the materialised `path`. The tree is assembled in the
 * browser (see FolderTree), so the whole hierarchy is one query rather than one per level.
 */
export interface MediaFolderNode {
  id: string;
  name: string;
  parentId: string | null;
  /** Materialised, e.g. "/events/2026/convocation". Unique, so it doubles as a stable sort key. */
  path: string;
  /** Assets filed DIRECTLY in this folder, recycle bin excluded. Drives "cannot delete: 12 files". */
  assetCount: number;
}

export interface MediaListResponse {
  items: StudioMediaAsset[];
  total: number;
  /** True when `total` is a capped count rather than the real one — Pagination renders "of at least N". */
  totalIsLowerBound?: boolean;
  page: number;
  pageSize: number;
  /**
   * The accessibility backlog for the WHOLE library, independent of the filters in force, so the
   * "needs a description" control always carries a real number. `missing` is `altText IS NULL`;
   * `decorative` is `altText = ''`. Null when the server chose not to compute it.
   */
  altBacklog?: { missing: number; decorative: number } | null;
}

export interface MediaFoldersResponse {
  items: MediaFolderNode[];
}

export interface MediaTagsResponse {
  items: { tag: string; count: number }[];
  /** True when the list was capped. The filter says so rather than pretending it is complete. */
  truncated?: boolean;
}

export interface MediaDuplicateMatch {
  /** The asset that has just been uploaded. */
  uploadedId: string;
  uploadedFileName: string;
  /** The older asset whose bytes are identical. */
  existing: StudioMediaAsset;
}

export interface MediaDuplicateResponse {
  matches: MediaDuplicateMatch[];
}

// ─── The endpoints ──────────────────────────────────────────────────────────────────────────────

/**
 * Every address the media screens call, in one place.
 *
 * Written out here rather than inline at each call site so the route handlers have a single list to
 * satisfy, and so a rename is one edit.
 *
 * ⚠ `presign` is ALSO hard-coded inside `uploadFiles()` (lib/client/upload.ts), which owns the ordinary
 * upload path and must not import from a component. The duplication is deliberate and is the reason
 * that function documents all three step shapes in its header — if this address changes, both places
 * change. Nothing here calls `presign` except the file REPLACEMENT in MediaDetailPanel, which needs the
 * same signed PUT but a different final step.
 */
export const MEDIA_ENDPOINTS = {
  list: (query: string) => `/api/studio/media${query}`,
  detail: (id: string) => `/api/studio/media/${encodeURIComponent(id)}`,
  presign: "/api/studio/media/presign",
  replace: (id: string) => `/api/studio/media/${encodeURIComponent(id)}/replace`,
  duplicates: "/api/studio/media/duplicates",
  tags: "/api/studio/media/tags",
  folders: "/api/studio/media/folders",
  folder: (id: string) => `/api/studio/media/folders/${encodeURIComponent(id)}`
} as const;

// ─── Filters ────────────────────────────────────────────────────────────────────────────────────

export const MEDIA_SORT_KEYS = ["created", "name", "size"] as const;
export type MediaSortKey = (typeof MEDIA_SORT_KEYS)[number];

/** Three values, and each is a different statement about the alt text. See `StudioMediaAsset.altText`. */
export const MEDIA_ALT_FILTERS = ["missing", "decorative", "described"] as const;
export type MediaAltFilter = (typeof MEDIA_ALT_FILTERS)[number];

/**
 * The reserved word for "filed in no folder at all".
 *
 * `buildQuery` drops empty strings, so an intentionally-empty filter cannot be sent as `folder=`
 * (lib/client/fetcher.ts). A word the handler maps is the only way to express it.
 */
export const NO_FOLDER = "none";

export interface MediaFilters {
  q: string;
  kind: MediaKindName | "";
  /** A folder id, `NO_FOLDER`, or "" for every folder. */
  folder: string;
  tag: string;
  alt: MediaAltFilter | "";
  /** Referenced by nothing at all. Computed server-side — see the note on `buildMediaListPath`. */
  unused: boolean;
  sort: MediaSortKey;
  dir: "asc" | "desc";
  /** 1-based. */
  page: number;
}

export const MEDIA_PAGE_SIZE = 48;

export const DEFAULT_MEDIA_FILTERS: MediaFilters = {
  q: "",
  kind: "",
  folder: "",
  tag: "",
  alt: "",
  unused: false,
  sort: "created",
  dir: "desc",
  page: 1
};

export function mediaFiltersAreDefault(filters: MediaFilters): boolean {
  return (
    filters.q.trim().length === 0 &&
    filters.kind === "" &&
    filters.folder === "" &&
    filters.tag === "" &&
    filters.alt === "" &&
    !filters.unused &&
    filters.sort === DEFAULT_MEDIA_FILTERS.sort &&
    filters.dir === DEFAULT_MEDIA_FILTERS.dir &&
    filters.page === 1
  );
}

/** Only the parts a reader can see and change — used to decide whether "Clear all" is worth offering. */
export function mediaFiltersAreNarrowing(filters: MediaFilters): boolean {
  return (
    filters.q.trim().length > 0 ||
    filters.kind !== "" ||
    filters.folder !== "" ||
    filters.tag !== "" ||
    filters.alt !== "" ||
    filters.unused
  );
}

/**
 * The query string for a filter set. Also the cache key `useResource` dedupes on, which is why it
 * goes through `buildQuery`: two states of the filter bar that mean the same thing must produce the
 * same string, or a cleared search box re-fetches the list it is already showing.
 *
 * ⚠ `unused` and `alt` are SERVER-SIDE filters and cannot be anything else. "Referenced by nothing"
 * needs counts across a dozen relations, and a browser holding one page of 48 rows has no way to know
 * whether the other 4,000 use a file.
 */
export function buildMediaListPath(
  filters: MediaFilters,
  pageSize: number = MEDIA_PAGE_SIZE
): string {
  return MEDIA_ENDPOINTS.list(
    buildQuery({
      q: filters.q.trim(),
      kind: filters.kind,
      folder: filters.folder,
      tag: filters.tag,
      alt: filters.alt,
      unused: filters.unused ? "1" : "",
      sort: filters.sort,
      dir: filters.dir,
      page: filters.page > 1 ? filters.page : "",
      pageSize
    })
  );
}

/** The same filters as a browser query string, so a filtered view is a link somebody can send. */
export function mediaFiltersToSearch(filters: MediaFilters): string {
  return buildQuery({
    q: filters.q.trim(),
    kind: filters.kind,
    folder: filters.folder,
    tag: filters.tag,
    alt: filters.alt,
    unused: filters.unused ? "1" : "",
    sort: filters.sort === DEFAULT_MEDIA_FILTERS.sort ? "" : filters.sort,
    dir: filters.dir === DEFAULT_MEDIA_FILTERS.dir ? "" : filters.dir,
    page: filters.page > 1 ? filters.page : ""
  });
}

type RawParams = Record<string, string | string[] | undefined>;

function one(raw: RawParams, key: string): string {
  const value = raw[key];
  if (typeof value === "string") return value;
  // A repeated parameter is a hand-edited or stale link. The first value wins, so the control and the
  // list can never disagree about what is selected.
  if (Array.isArray(value)) return value[0] ?? "";
  return "";
}

const KIND_VALUES: readonly MediaKindName[] = [
  "IMAGE",
  "VIDEO",
  "AUDIO",
  "DOCUMENT",
  "MODEL_3D",
  "PANORAMA"
];

/**
 * Read a filter set out of a URL.
 *
 * `missingAlt=1` is accepted as an alias for `alt=missing` because the studio dashboard already links
 * that way (`/studio/media?missingAlt=1`). A link that has been printed on a dashboard is a link that
 * must keep working.
 *
 * Anything unrecognised falls back to the default rather than being passed through: an invalid `kind`
 * sent to the server is a 422 about a value the reader never typed.
 */
export function readMediaFilters(raw: RawParams): MediaFilters {
  const kindRaw = one(raw, "kind").toUpperCase();
  const kind = KIND_VALUES.find((value) => value === kindRaw) ?? "";

  const altRaw = one(raw, "alt").toLowerCase();
  const legacyMissingAlt = ["1", "true", "yes"].includes(one(raw, "missingAlt").toLowerCase());
  const alt: MediaAltFilter | "" =
    MEDIA_ALT_FILTERS.find((value) => value === altRaw) ?? (legacyMissingAlt ? "missing" : "");

  const sortRaw = one(raw, "sort").toLowerCase();
  const sort = MEDIA_SORT_KEYS.find((value) => value === sortRaw) ?? DEFAULT_MEDIA_FILTERS.sort;

  const dirRaw = one(raw, "dir").toLowerCase();
  const dir: "asc" | "desc" = dirRaw === "asc" ? "asc" : dirRaw === "desc" ? "desc" : DEFAULT_MEDIA_FILTERS.dir;

  const pageParsed = Number.parseInt(one(raw, "page"), 10);
  const page = Number.isFinite(pageParsed) && pageParsed > 1 ? pageParsed : 1;

  return {
    q: one(raw, "q"),
    kind,
    folder: one(raw, "folder"),
    tag: one(raw, "tag"),
    alt,
    unused: ["1", "true", "yes"].includes(one(raw, "unused").toLowerCase()),
    sort,
    dir,
    page
  };
}

// ─── Kinds and alt state ────────────────────────────────────────────────────────────────────────

export const MEDIA_KIND_LABELS: Record<MediaKindName, string> = {
  IMAGE: "Image",
  VIDEO: "Video",
  AUDIO: "Audio recording",
  DOCUMENT: "Document",
  MODEL_3D: "3D model",
  PANORAMA: "Panorama"
};

export const MEDIA_KIND_ICONS: Record<MediaKindName, LucideIcon> = {
  IMAGE: ImageIcon,
  VIDEO: Film,
  AUDIO: Volume2,
  DOCUMENT: FileText,
  MODEL_3D: Box,
  PANORAMA: ScanEye
};

/** Kinds a thumbnail can actually be drawn for. Everything else gets a labelled glyph. */
export function hasPicture(kind: MediaKindName): boolean {
  return kind === "IMAGE" || kind === "PANORAMA";
}

export type AltState = "described" | "decorative" | "missing" | "not-applicable";

/**
 * Which of the three statements this asset makes about its description.
 *
 * A blank-but-present value counts as "decorative", because that is what an empty `alt` attribute
 * means in HTML and a reader who typed a space did not mean to write a description.
 */
export function altState(asset: Pick<StudioMediaAsset, "kind" | "altText">): AltState {
  if (!hasPicture(asset.kind)) return "not-applicable";
  if (asset.altText === null) return "missing";
  return asset.altText.trim().length === 0 ? "decorative" : "described";
}

/** Dimensions as a phrase, or null when they were never recorded. */
export function describeDimensions(asset: Pick<StudioMediaAsset, "width" | "height">): string | null {
  if (!asset.width || !asset.height) return null;
  return `${asset.width} × ${asset.height}`;
}

// ─── The grid ───────────────────────────────────────────────────────────────────────────────────

export type MediaSelectMode = "replace" | "toggle" | "range";

/** Read the modifier keys once, so every surface interprets a click the same way. */
export function selectModeFromEvent(event: {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}): MediaSelectMode {
  if (event.shiftKey) return "range";
  if (event.metaKey || event.ctrlKey) return "toggle";
  return "replace";
}

export interface MediaGridProps {
  /** `null` while loading, `[]` when there is nothing. Not the same screen — see the header. */
  assets: readonly StudioMediaAsset[] | null;
  /** Names the list for a screen reader: "Media library". Not "Grid". */
  label: string;
  selectedIds: ReadonlySet<string>;
  onSelect: (id: string, mode: MediaSelectMode) => void;
  /** The asset whose details are open. Drawn with the brand ring so it is findable at a glance. */
  activeId?: string | null;
  /** Opening the details of one asset. Omit it where there is nothing to open (the picker). */
  onOpen?: (id: string) => void;
  /** Rendered instead of the grid when `assets` is `[]`. Say WHY it is empty. */
  emptyState: ReactNode;
  /** Ids to flash — "these are the ones that just changed". Clear it after about a second. */
  flashIds?: ReadonlySet<string>;
  /** Stated under the grid when the list is capped or truncated (contract §1.6). */
  capNote?: ReactNode;
  /** How many placeholder tiles while loading. */
  skeletonTiles?: number;
  className?: string;
}

const ALT_BADGE: Record<AltState, { label: string; className: string; icon: LucideIcon } | null> = {
  // amber-100 + amber-800 as a PAIR — the status ramps are literal hex and do not invert, and
  // amber-50/amber-200 are stock Tailwind here and will not pair correctly (contract §1).
  missing: {
    label: "No description",
    className: "bg-amber-100 text-amber-800",
    icon: TriangleAlert
  },
  decorative: { label: "Decorative", className: "bg-surface-200 text-ink-700", icon: ScanEye },
  described: null,
  "not-applicable": null
};

export function MediaGrid({
  assets,
  label,
  selectedIds,
  onSelect,
  activeId = null,
  onOpen,
  emptyState,
  flashIds,
  capNote,
  skeletonTiles = 12,
  className
}: MediaGridProps) {
  const loading = assets === null;

  const gridClass =
    "grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6";

  if (!loading && assets.length === 0) {
    return <div className={cn("min-w-0", className)}>{emptyState}</div>;
  }

  return (
    <div className={cn("min-w-0", className)}>
      {/*
        Mounted from the first render so the region is registered before its content ever changes — a
        live region inserted at the same instant as its text is announced by nothing. One sentence for
        the whole grid, rather than one per placeholder tile.
      */}
      <span role="status" className="sr-only">
        {loading ? `Loading ${label}…` : ""}
      </span>

      {loading ? (
        <ul aria-hidden="true" className={gridClass}>
          {Array.from({ length: Math.max(1, skeletonTiles) }, (_unused, index) => (
            // The index is the right key: identical, ordered placeholders with no identity of their
            // own and nothing to reorder.
            <li key={index} className="rounded-md border border-line-200 bg-card p-2">
              <div className="skeleton aspect-square w-full" />
              <div className="skeleton mt-2 h-3 w-3/4" />
              <div className="skeleton mt-1.5 h-3 w-1/2" />
            </li>
          ))}
        </ul>
      ) : (
        <ul aria-label={label} className={gridClass}>
          {assets.map((asset) => {
            const selected = selectedIds.has(asset.id);
            const active = activeId === asset.id;
            const state = altState(asset);
            const badge = ALT_BADGE[state];
            const KindIcon = MEDIA_KIND_ICONS[asset.kind];
            const dimensions = describeDimensions(asset);

            const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
              const mode = selectModeFromEvent(event);
              onSelect(asset.id, mode);
              // A plain click means "show me this one". A modified click is building a selection and
              // must not swap the panel out from under the reader mid-gesture.
              if (mode === "replace") onOpen?.(asset.id);
            };

            return (
              <li
                key={asset.id}
                // `flash-row` is the recipe from globals.css; its static outline is the half of the
                // "just changed" signal that survives reduced motion (contract §1.4).
                className={cn(
                  // Every branch names its own border colour. A bare `border` utility resolves to
                  // preflight's literal gray-200, which does not invert with the theme (contract §3).
                  "flash-row relative rounded-md bg-card p-2 transition-colors",
                  selected
                    ? "border border-purple-700 bg-purple-50"
                    : active
                      ? "border border-purple-300 hover:bg-surface-50"
                      : "border border-line-200 hover:bg-surface-50",
                  // Named, because a bare `ring-4` is stock BLUE (contract §3).
                  active ? "ring-4 ring-purple-600/15" : undefined
                )}
                data-flash={flashIds?.has(asset.id) ? "true" : undefined}
              >
                {/*
                  The checkbox is a SIBLING of the tile button, overlaid — never nested inside it. A
                  button inside a button is invalid HTML and the inner one becomes unreachable.
                  Rung 10 of the z-ladder, the one for in-page chrome (contract §6).
                */}
                <div className="absolute left-3 top-3 z-10">
                  <Checkbox
                    checked={selected}
                    onCheckedChange={() => onSelect(asset.id, "toggle")}
                    // Named with the file, because forty checkboxes called "Select" are forty
                    // identical controls to anybody listening rather than looking.
                    label={<span className="sr-only">Select {asset.fileName}</span>}
                    // `!` on both: `cn()` is a plain join and later classes do NOT win (contract §5),
                    // so the recipe's own `min-h-11`/`py-1.5` would otherwise blow the tile apart.
                    className="!min-h-0 !py-0"
                    inputClassName="bg-card"
                  />
                </div>

                <button
                  type="button"
                  onClick={handleClick}
                  // The whole tile is one control with one name. The badges below are `aria-hidden`
                  // where their text is already in this label, so it is not read twice.
                  aria-label={`${asset.fileName} — ${MEDIA_KIND_LABELS[asset.kind]}${
                    badge ? `, ${badge.label.toLowerCase()}` : ""
                  }`}
                  aria-pressed={selected}
                  className="block w-full rounded text-left"
                >
                  {hasPicture(asset.kind) ? (
                    <MediaImage
                      media={asset}
                      aspect={1}
                      rounded="sm"
                      targetWidth={320}
                      sizes="(min-width: 1280px) 12vw, (min-width: 768px) 20vw, 45vw"
                      // Decorative here: the button's own label already names the file, and the tile
                      // is a control rather than a picture being presented for its content.
                      alt=""
                      className="w-full bg-surface-100"
                    />
                  ) : (
                    <span className="flex aspect-square w-full flex-col items-center justify-center gap-2 rounded-sm border border-line-200 bg-surface-100">
                      <KindIcon aria-hidden="true" className="h-6 w-6 text-ink-500" />
                      <span className="px-2 text-center text-[0.6875rem] font-medium text-ink-500">
                        {MEDIA_KIND_LABELS[asset.kind]}
                      </span>
                    </span>
                  )}

                  <span className="mt-2 block truncate text-xs font-medium text-ink-900">
                    {asset.fileName}
                  </span>
                  <span className="mt-0.5 block truncate text-[0.6875rem] text-ink-500">
                    {formatBytes(asset.byteSize)}
                    {dimensions ? ` · ${dimensions}` : ""}
                  </span>
                </button>

                {badge ? (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "pointer-events-none absolute right-3 top-3 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.625rem] font-semibold",
                      badge.className
                    )}
                  >
                    <badge.icon aria-hidden="true" className="h-3 w-3 shrink-0" />
                    {badge.label}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {capNote ? (
        <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-ink-500">
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{capNote}</span>
        </p>
      ) : null}
    </div>
  );
}
