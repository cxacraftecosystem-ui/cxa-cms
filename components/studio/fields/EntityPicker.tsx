"use client";

/**
 * EntityPicker — "which records?", answered by searching for them and seeing what was chosen.
 *
 * It serves every hand-picked list in the studio: the people in a people block, the projects in a
 * projects block, the albums in a gallery, the single photograph behind a hero, the file behind a
 * download.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT SHOWS REAL TITLES, IT SHOWS DRAFTS, AND IT SHOWS WHAT HAS GONE.
 *
 * The payload stores ids (`lib/sections/schema.ts` — an id, never a title, because a title changes and
 * a reference must not). A screen that shows those ids back is unverifiable: nobody can look at
 * `clzk3f9a70003` and say whether it is the right person. So every chosen id is resolved to its title
 * and shown as itself.
 *
 * Two states matter more than the titles, and both are stated in words rather than implied:
 *
 *   • A DRAFT that is chosen produces a block that renders nothing to the public. It is the most
 *     confusing possible outcome of a curation choice — the editor picked six people and four appear —
 *     so a draft carries its status chip AND is counted in a sentence beneath the list.
 *   • A record that has been DELETED since it was chosen cannot be resolved at all. It is shown as
 *     missing, with the offer to take it out, rather than quietly vanishing from the list — a list
 *     that silently shortened itself is indistinguishable from one nobody finished (contract §1.6).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE ENDPOINT IT TALKS TO. One route, three questions, all `GET` — a read needs no same-origin
 * assertion and benefits from being cache-controllable:
 *
 *   GET /api/studio/lookup?type=person&q=anita&limit=20   → search by name
 *   GET /api/studio/lookup?type=person&ids=a,b,c          → resolve chosen ids to titles
 *   GET /api/studio/lookup?type=page&path=%2Fabout        → is there anything at this address?
 *
 * answering `{ items: LookupItem[]; total: number }`, where `total` is how many rows matched BEFORE the
 * limit — the number a truncation notice needs. It must require a signed-in user: the answer includes
 * the titles of unpublished work, which is not public information.
 *
 * `LookupItem` is exported and so is the path builder, so the route handler and every picker are
 * written against one shape.
 *
 * `items === null` IS LOADING; `items === []` IS "NOTHING MATCHED" (contract §9). They are different
 * screens here as everywhere: a search that renders "No people found" while it is still running tells
 * an administrator their colleague is not in the system.
 *
 * `FieldBlock`, NOT `Field` — this control is made of buttons, and a `<label>` wrapped round buttons
 * forwards stray clicks into them and folds their text into the accessible name (Field.tsx).
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, GripVertical, Plus, Search, TriangleAlert, X } from "lucide-react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ContentStatus } from "@prisma/client";

import { buildQuery } from "@/lib/client/fetcher";
import { useDebouncedValue, useResource } from "@/lib/client/useResource";
import type { MediaLike } from "@/lib/media/url";
import { cn } from "@/lib/utils";
import { FieldBlock, useFieldContext } from "@/components/ui/Field";
import { MediaImage } from "@/components/ui/MediaImage";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { HelpText } from "@/components/studio/HelpText";
import { PickerUpload } from "@/components/studio/fields/PickerUpload";

/** Every table a picker can search. The route handler switches on exactly these words. */
export const LOOKUP_KINDS = [
  "person",
  "project",
  "publication",
  "news",
  "event",
  "craft",
  "album",
  "galleryImage",
  "research",
  "partner",
  "file",
  "media",
  "page"
] as const;

export type LookupKind = (typeof LOOKUP_KINDS)[number];

export interface LookupItem {
  id: string;
  /** What the record is called. Never empty — the handler falls back to the file name or the id. */
  title: string;
  /** A second line: a designation, a year, a venue, a file size. `""` when there is none. */
  subtitle: string;
  /** Publication state, or `null` for a record type that has none (media, partners, files). */
  status: ContentStatus | null;
  /** The public address. `""` when the record has none. */
  path: string;
  /** A thumbnail, where the record has one. */
  media: MediaLike | null;
}

export interface LookupResponse {
  items: LookupItem[];
  /** Matches in the database before `limit` was applied. Drives the truncation notice. */
  total: number;
}

/** How the picker refers to what it is picking, in the words an administrator uses. */
export const LOOKUP_NOUNS: Record<LookupKind, { one: string; many: string }> = {
  person: { one: "person", many: "people" },
  project: { one: "project", many: "projects" },
  publication: { one: "publication", many: "publications" },
  news: { one: "news item", many: "news items" },
  event: { one: "event", many: "events" },
  craft: { one: "craft", many: "crafts" },
  album: { one: "album", many: "albums" },
  galleryImage: { one: "picture", many: "pictures" },
  research: { one: "research area", many: "research areas" },
  partner: { one: "partner", many: "partners" },
  file: { one: "file", many: "files" },
  media: { one: "picture or video", many: "pictures and videos" },
  page: { one: "page", many: "pages" }
};

/** How many search results one panel shows. More than this and nobody reads to the bottom. */
const SEARCH_LIMIT = 20;

/** Quiet time before a search leaves the browser. Long enough not to fire on every letter. */
const SEARCH_DEBOUNCE_MS = 250;

/** Search for records of one kind. `query` may be empty, which asks for the most recent. */
export function lookupSearchPath(kind: LookupKind, query: string, limit = SEARCH_LIMIT): string {
  // `buildQuery` drops the empty string, so a cleared box and an untouched one produce the same path
  // and `useResource` does not re-fetch (see its header).
  return `/api/studio/lookup${buildQuery({ type: kind, q: query.trim(), limit })}`;
}

/** Resolve chosen ids to their titles. Returns null for an empty list — there is nothing to ask. */
export function lookupResolvePath(kind: LookupKind, ids: readonly string[]): string | null {
  if (ids.length === 0) return null;
  // SORTED, so that reordering the chosen list does not change the path and does not re-fetch. The
  // order the reader chose lives in `ids`; this is only a cache key.
  const key = [...ids].sort().join(",");
  return `/api/studio/lookup${buildQuery({ type: kind, ids: key, limit: ids.length })}`;
}

/** Ask whether anything is published at one address. Used by LinkField. */
export function lookupPathPath(path: string): string {
  return `/api/studio/lookup${buildQuery({ type: "page", path })}`;
}

/** A response is a cast, not a proof. One guard here beats a crash in a `.map` three components down. */
function readItems(response: LookupResponse | null): LookupItem[] | null {
  if (response === null) return null;
  return Array.isArray(response.items) ? response.items : [];
}

export interface EntityPickerProps {
  kind: LookupKind;
  /** The visible label — "People to show", "Picture". */
  label: string;
  /** The schema's `.describe()` sentence. */
  help?: ReactNode;
  ids: readonly string[];
  onChange: (next: string[]) => void;
  /**
   * The schema's cap. `1` turns the picker into a single chooser: picking replaces rather than adds,
   * and the ordering controls disappear because one item has no order.
   */
  max?: number;
  /** Whether the order is meaningful. Ignored when `max` is 1. */
  reorderable?: boolean;
  error?: string | null;
  /** An extra sentence under the chosen list — what a showcase says about unpublished picks. */
  footnote?: ReactNode;
  /**
   * Offer an UPLOAD inside the panel, for the two kinds that have somewhere to upload to.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * ⚠ OPT-IN RATHER THAN AUTOMATIC FOR `file` AND `media`, because not every picker of those kinds is a
   * place an upload belongs. The DOWNLOADS block's picker chooses which EXISTING files a showcase lists;
   * uploading a new document from there would add it to the library as a side effect of arranging a page,
   * which is a surprising thing for a layout control to do. A field that says "this document" is the
   * opposite case and should not send the editor to another screen.
   *
   * Passing it for any other kind does nothing: there is no generic "create a person" upload, and
   * silently ignoring it beats inventing one. See `components/studio/fields/PickerUpload.tsx` for which
   * TABLE each kind writes to and why a picker must not upload into the other one.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  upload?: boolean;
  className?: string;
}

export function EntityPicker(props: EntityPickerProps) {
  const { label, help, error, className } = props;
  return (
    <FieldBlock label={label} help={help} error={error} className={className}>
      <EntityPickerControl {...props} />
    </FieldBlock>
  );
}

function EntityPickerControl({
  kind,
  ids,
  onChange,
  max = 24,
  reorderable = true,
  footnote,
  upload = false
}: EntityPickerProps) {
  const field = useFieldContext();
  const noun = LOOKUP_NOUNS[kind];
  const single = max === 1;
  const canOrder = reorderable && !single;

  const [query, setQuery] = useState("");
  const [announcement, setAnnouncement] = useState("");

  /**
   * Titles for everything this picker has ever seen, from either request.
   *
   * State rather than a ref, because it is rendered: a ref written in an effect would not repaint, and
   * the list would show "Loading…" beside a title the component already had. It also means adding an
   * item straight out of the search results shows its title with no round trip.
   */
  const [known, setKnown] = useState<Record<string, LookupItem>>({});

  const searchPath = useDebouncedValue(lookupSearchPath(kind, query), SEARCH_DEBOUNCE_MS);
  const search = useResource<LookupResponse>(searchPath);
  const resolve = useResource<LookupResponse>(lookupResolvePath(kind, ids));

  const searchItems = useMemo(() => readItems(search.data), [search.data]);
  const resolvedItems = useMemo(() => readItems(resolve.data), [resolve.data]);

  useEffect(() => {
    const incoming = [...(resolvedItems ?? []), ...(searchItems ?? [])];
    if (incoming.length === 0) return;
    setKnown((current) => {
      let changed = false;
      const next = { ...current };
      for (const item of incoming) {
        if (next[item.id] !== item) {
          next[item.id] = item;
          changed = true;
        }
      }
      return changed ? next : current;
    });
    // Neither dependency changes as a result of this write, so there is no loop to guard against.
  }, [resolvedItems, searchItems]);

  /**
   * Is an id we cannot resolve genuinely gone, or merely not answered yet?
   *
   * Three conditions, and leaving any of them out produces "this item has been deleted" on a list that
   * is simply still loading: the request must have finished, must have succeeded, and must not have
   * been superseded by a newer one (`useResource` keeps the previous answer while the next runs).
   */
  const resolveSettled = resolvedItems !== null && !resolve.isLoading && resolve.error === null;

  const atLimit = ids.length >= max;

  const add = useCallback(
    (item: LookupItem) => {
      if (single) {
        onChange([item.id]);
        setAnnouncement(`${item.title} chosen.`);
        return;
      }
      if (ids.includes(item.id) || ids.length >= max) return;
      onChange([...ids, item.id]);
      setAnnouncement(`${item.title} added. ${ids.length + 1} of ${max} chosen.`);
    },
    [ids, max, onChange, single]
  );

  /**
   * Choose a record by id alone, for something that did not come out of the search.
   *
   * ⚠ AN UPLOAD CANNOT GO THROUGH `add`, which takes a whole `LookupItem` in order to announce a title.
   * A file that existed a quarter of a second ago is not in any search result the panel has fetched, and
   * waiting for one before choosing it would leave the editor watching a spinner after their upload had
   * already succeeded. The title arrives on its own: `resolvedItems` resolves every chosen id through the
   * same lookup, so the chip fills in a moment later exactly as a searched one does. `PickerUpload` does
   * the announcing, because it is the thing that knows the file's name.
   */
  const addById = useCallback(
    (id: string) => {
      if (single) {
        onChange([id]);
        return;
      }
      if (ids.includes(id) || ids.length >= max) return;
      onChange([...ids, id]);
    },
    [ids, max, onChange, single]
  );

  const removeAt = useCallback(
    (index: number) => {
      const id = ids[index];
      if (id === undefined) return;
      onChange(ids.filter((_unused, position) => position !== index));
      const title = known[id]?.title ?? "That item";
      setAnnouncement(`${title} removed. ${ids.length - 1} left.`);
    },
    [ids, known, onChange]
  );

  const move = useCallback(
    (from: number, to: number) => {
      if (from === to || to < 0 || to >= ids.length) return;
      onChange(arrayMove([...ids], from, to));
      setAnnouncement(`Moved from position ${from + 1} to position ${to + 1} of ${ids.length}.`);
    },
    [ids, onChange]
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      move(ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    },
    [ids, move]
  );

  // The two counts the reader has to know about, and neither is visible from the titles alone.
  const draftCount = ids.filter((id) => {
    const status = known[id]?.status;
    return status !== undefined && status !== null && status !== "PUBLISHED";
  }).length;
  const missingCount = resolveSettled ? ids.filter((id) => known[id] === undefined).length : 0;

  const searchTotal = typeof search.data?.total === "number" ? search.data.total : (searchItems?.length ?? 0);
  const searchTruncated = searchItems !== null && searchTotal > searchItems.length;

  return (
    <div className="min-w-0">
      {/* Mounted in both states, so the region is registered before its text ever changes. */}
      <span role="status" className="sr-only">
        {announcement}
      </span>

      {ids.length === 0 ? (
        <p className="rounded-md border border-dashed border-line-200 bg-surface-50 px-3 py-3 text-sm text-ink-500">
          Nothing chosen yet. Search below and choose the {single ? noun.one : noun.many} to show.
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={[...ids]} strategy={verticalListSortingStrategy}>
            <ul className="space-y-1.5">
              {ids.map((id, index) => (
                <ChosenRow
                  key={id}
                  id={id}
                  index={index}
                  count={ids.length}
                  item={known[id]}
                  noun={noun.one}
                  // Not yet answered, so it is neither present nor missing.
                  loading={!resolveSettled && known[id] === undefined}
                  canOrder={canOrder}
                  showNumber={canOrder}
                  onMove={move}
                  onRemove={() => removeAt(index)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      {resolve.error !== null ? (
        <HelpText tone="error" className="mt-2">
          {resolve.error.message} The chosen {noun.many} cannot be listed until that is fixed — nothing
          has been lost.
        </HelpText>
      ) : null}

      {draftCount > 0 ? (
        <HelpText tone="warn" className="mt-2">
          {draftCount === 1
            ? `One of these is not published yet, so it will not appear on the public page.`
            : `${draftCount} of these are not published yet, so they will not appear on the public page.`}{" "}
          Publish {draftCount === 1 ? "it" : "them"} from its own screen, or take{" "}
          {draftCount === 1 ? "it" : "them"} out of this list.
        </HelpText>
      ) : null}

      {missingCount > 0 ? (
        <HelpText tone="warn" className="mt-2">
          {missingCount === 1 ? "One item here no longer exists" : `${missingCount} items here no longer exist`}{" "}
          — {missingCount === 1 ? "it has" : "they have"} been deleted since being chosen.{" "}
          {missingCount === 1 ? "It" : "They"} will not appear on the page. Take{" "}
          {missingCount === 1 ? "it" : "them"} out to tidy this list.
        </HelpText>
      ) : null}

      {footnote ? <p className="mt-2 text-xs leading-relaxed text-ink-500">{footnote}</p> : null}

      {/* ── Search ───────────────────────────────────────────────────────────── */}

      <div className="mt-3 rounded-md border border-line-200 bg-surface-50 p-2">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pb-2">
          <span className="relative block min-w-0 flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-300"
            />
            <input
              id={field?.controlId}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-describedby={field?.describedBy}
              placeholder={`Search ${noun.many} by name`}
              autoComplete="off"
              className="field-input pl-9 [&::-webkit-search-cancel-button]:appearance-none"
            />
          </span>

          {single ? null : (
            <span className={cn("shrink-0 text-xs tabular-nums", atLimit ? "text-amber-800" : "text-ink-500")}>
              You can choose up to {max}; {ids.length} chosen.
            </span>
          )}
        </div>

        {searchItems === null ? (
          // Loading, not empty. The two are different screens (contract §9).
          <div className="space-y-1.5 px-1 py-1">
            <Skeleton lines={3} height="2.25rem" label={`Searching ${noun.many}…`} />
          </div>
        ) : search.error !== null ? (
          <HelpText tone="error">{search.error.message}</HelpText>
        ) : searchItems.length === 0 ? (
          <p className="px-1 py-3 text-sm text-ink-500">
            {query.trim().length > 0
              ? `Nothing matched “${query.trim()}”. Check the spelling, or search for part of the name.`
              : `There are no ${noun.many} in the studio yet. Add one from its own screen first.`}
          </p>
        ) : (
          <>
            {/* A bounded scroller: twenty rows in a form is a form nobody can see the foot of. */}
            <ul className="max-h-64 space-y-1 overflow-y-auto overscroll-contain">
              {searchItems.map((item) => {
                const chosen = ids.includes(item.id);
                const blocked = !chosen && atLimit && !single;

                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      // A toggle, so a screen reader is told whether this row is already in the list
                      // rather than having to infer it from a tick (contract §11).
                      aria-pressed={chosen}
                      // `aria-disabled` rather than `disabled`: the reason is on screen beside it, and a
                      // control that vanishes at the cap makes the cap look like a fault.
                      aria-disabled={blocked || undefined}
                      onClick={() => {
                        if (blocked) return;
                        if (chosen && !single) {
                          removeAt(ids.indexOf(item.id));
                          return;
                        }
                        add(item);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-md border px-2 py-1.5 text-left transition",
                        chosen
                          ? "border-purple-300 bg-purple-50"
                          : "border-transparent bg-card hover:border-purple-300 hover:bg-purple-50",
                        blocked && "cursor-not-allowed opacity-60"
                      )}
                    >
                      <ItemThumbnail item={item} />

                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink-900">{item.title}</span>
                        {item.subtitle.length > 0 ? (
                          <span className="block truncate text-xs text-ink-500">{item.subtitle}</span>
                        ) : null}
                      </span>

                      {item.status !== null && item.status !== "PUBLISHED" ? (
                        <StatusBadge status={item.status} size="sm" className="shrink-0" />
                      ) : null}

                      <span className="shrink-0 text-ink-500">
                        {chosen ? (
                          <Check aria-hidden="true" className="h-4 w-4 text-purple-700" />
                        ) : (
                          <Plus aria-hidden="true" className="h-4 w-4" />
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {/* A shortened list says so, always (contract §1.6). */}
            {searchTruncated ? (
              <p className="mt-1.5 px-1 text-xs leading-relaxed text-ink-500">
                Showing the first {searchItems.length} of {searchTotal} matches. Type more of the name to
                narrow it down.
              </p>
            ) : null}
          </>
        )}

        {/*
          ⚠ BELOW THE RESULTS, AND OUTSIDE THE BRANCH ABOVE. It has to survive all three states — loading,
          error, and the empty list — because the empty list is exactly when an editor most needs it: "there
          are no files in the studio yet" used to end the journey, and now it is the moment to offer one.
        */}
        {upload && (kind === "file" || kind === "media") ? (
          <div className="mt-2">
            <PickerUpload
              kind={kind}
              onUploaded={addById}
              unavailable={
                atLimit && !single
                  ? `You have chosen the maximum of ${max}, so there is nowhere to put another. Remove one first to upload.`
                  : null
              }
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface ChosenRowProps {
  id: string;
  index: number;
  count: number;
  item: LookupItem | undefined;
  noun: string;
  loading: boolean;
  canOrder: boolean;
  showNumber: boolean;
  onMove: (from: number, to: number) => void;
  onRemove: () => void;
}

function ChosenRow({
  id,
  index,
  count,
  item,
  noun,
  loading,
  canOrder,
  showNumber,
  onMove,
  onRemove
}: ChosenRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled: !canOrder });

  const position = `${index + 1} of ${count}`;
  const missing = !loading && item === undefined;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-center gap-2 rounded-md border bg-card px-1.5 py-1.5",
        // A missing pick is tinted AND worded — the sentence under the list counts them, and this row
        // says which one. amber-100 with amber-800 as a pair (contract §1).
        missing ? "border-amber-800/40 bg-amber-100" : "border-line-200",
        isDragging && "relative z-10 shadow-panel ring-2 ring-purple-600/30"
      )}
    >
      {canOrder ? (
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label={`Drag to reorder item ${position}`}
          className="inline-flex h-8 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-ink-300 transition hover:text-ink-700 focus-visible:ring-2 focus-visible:ring-purple-600/30"
          {...attributes}
          {...listeners}
        >
          <GripVertical aria-hidden="true" className="h-4 w-4" />
        </button>
      ) : null}

      {showNumber ? (
        <span className="shrink-0 text-xs tabular-nums text-ink-500">{index + 1}</span>
      ) : null}

      {loading ? (
        <div className="min-w-0 flex-1 py-0.5">
          <Skeleton width="12rem" height="0.875rem" label="Looking up the chosen items…" />
        </div>
      ) : item === undefined ? (
        // Tested on `item` itself rather than on the `missing` boolean: a derived flag carries no
        // narrowing, and this branch is the one place the row is allowed to have no record behind it.
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-amber-800">
          <TriangleAlert aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className="min-w-0">
            Missing — this {noun} has been deleted, so it will not appear on the page.
          </span>
        </span>
      ) : (
        <>
          <ItemThumbnail item={item} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-ink-900">{item.title}</span>
            {item.subtitle.length > 0 ? (
              <span className="block truncate text-xs text-ink-500">{item.subtitle}</span>
            ) : null}
          </span>
          {item.status !== null && item.status !== "PUBLISHED" ? (
            <StatusBadge status={item.status} size="sm" className="shrink-0" />
          ) : null}
        </>
      )}

      <span className="flex shrink-0 items-center">
        {canOrder ? (
          <>
            <OrderButton
              label={`Move item ${position} up`}
              unavailable={index === 0}
              rotate
              onClick={() => onMove(index, index - 1)}
            />
            <OrderButton
              label={`Move item ${position} down`}
              unavailable={index === count - 1}
              onClick={() => onMove(index, index + 1)}
            />
          </>
        ) : null}

        <button
          type="button"
          onClick={onRemove}
          aria-label={
            item ? `Take ${item.title} out of this list` : `Take missing item ${position} out of this list`
          }
          className="inline-flex h-8 w-8 items-center justify-center rounded text-ink-500 transition hover:bg-error-100 hover:text-error-600 focus-visible:ring-2 focus-visible:ring-error-600/30"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </span>
    </li>
  );
}

/** A thumbnail where the record has one. `MediaImage` owns the "nothing to show" case (MediaImage.tsx). */
function ItemThumbnail({ item }: { item: LookupItem }) {
  if (!item.media) return null;
  return (
    <MediaImage
      media={item.media}
      // The caption beside it says what this is, so the picture itself is decorative here.
      alt=""
      aspect="none"
      rounded="sm"
      sizes="56px"
      className="h-9 w-14 shrink-0"
    />
  );
}

/**
 * One reorder button.
 *
 * `aria-disabled` and a no-op at the ends rather than `disabled`, for the reason set out in
 * RepeaterField.tsx: browsers blur a control the instant it becomes disabled, so moving a row to the
 * top with the keyboard would drop focus to the document body.
 */
function OrderButton({
  label,
  unavailable,
  rotate = false,
  onClick
}: {
  label: string;
  unavailable: boolean;
  rotate?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-disabled={unavailable || undefined}
      onClick={() => {
        if (unavailable) return;
        onClick();
      }}
      className={cn(
        "inline-flex h-8 w-6 items-center justify-center rounded transition focus-visible:ring-2 focus-visible:ring-purple-600/30",
        unavailable
          ? "cursor-default text-ink-300 opacity-50"
          : "text-ink-500 hover:bg-surface-100 hover:text-ink-900"
      )}
    >
      <ChevronDown aria-hidden="true" className={cn("h-4 w-4", rotate && "rotate-180")} />
    </button>
  );
}
