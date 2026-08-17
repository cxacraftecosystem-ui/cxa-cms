"use client";

/**
 * AlbumEditor — one gallery album: its details, and its pictures in the order a visitor will see them.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ORDER IS THE CONTENT, SO REORDERING WORKS THREE WAYS.
 *
 * Dragging is the discoverable one and it is here. It is also unusable with a keyboard, unusable with a
 * screen reader, and awkward on a small trackpad — so every tile ALSO carries "Move earlier" and "Move
 * later" buttons, and every move by either route is announced in a live region. A grid that silently
 * rearranged itself tells a reader who cannot see it nothing at all. (The same three-way rule as
 * `RepeaterField`, whose header sets it out; the ends are `aria-disabled` rather than `disabled` for the
 * reason given there — a browser blurs a control the instant it becomes disabled, so moving a picture to
 * the front with the keyboard would drop focus to the document body.)
 *
 * ONE SAVE, ONE TRANSACTION. The album's own fields and the whole list of pictures go in a SINGLE
 * request, and the order is the array's order. A per-tile "save this position" endpoint would mean a
 * failed drag could leave two pictures claiming one position — which the `@@unique([albumId, position])`
 * sibling on `PageSection` exists to prevent and which `GalleryItem` has no protection against at all.
 * Sending the list whole means the server can rewrite the range in one transaction.
 *
 * AUTOSAVE IS OFF UNTIL THE ALBUM EXISTS, AND OFF AGAIN ONCE IT IS PUBLISHED — and the bar says so both
 * times. A new album autosaved on the fourth keystroke would litter the gallery with untitled rows, and a
 * published album autosaved would put a half-written caption on the public site four seconds after
 * somebody starts typing it (`useAutosave`'s header is the full argument, and its
 * `PUBLISHED_AUTOSAVE_NOTICE` is the sentence every screen uses).
 *
 * A PICTURE CAN ONLY BE IN AN ALBUM ONCE. `GalleryItem` is unique on (album, asset), so a second copy
 * would fail the save with a constraint error nobody could act on. The picker's result is filtered, and
 * the screen SAYS how many were already there rather than quietly adding fewer than were chosen.
 *
 * THE COVER IS CHOSEN FROM THE ALBUM'S OWN PICTURES. The column will hold any media row, but a cover
 * that is not in the album is a picture a visitor never sees next to the ones they do — and offering a
 * second, separate picker for it invites exactly that. A stored cover that is NOT in the album (from an
 * import, or from a picture removed later) is reported rather than hidden, with the way to fix it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE ONLY MOTION IS THE LIFT UNDER A DRAGGED TILE. No entrance animation on the grid: an administrator
 * who opened this album wants the pictures to be there, not to arrive (contract §0).
 */

import { useCallback, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  GripVertical,
  ImageOff,
  ImagePlus,
  Images,
  Star,
  Tag as TagIcon,
  Trash2,
  X
} from "lucide-react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from "@dnd-kit/core";
import { restrictToParentElement } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ContentStatus } from "@prisma/client";

import { del, patch, post } from "@/lib/client/fetcher";
import type { ScreenFraming } from "@/lib/media/screens";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { DateField } from "@/components/ui/DateField";
import { Field, FieldBlock } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { MediaImage } from "@/components/ui/MediaImage";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/ToastProvider";
import { DeleteButton } from "@/components/studio/DeleteButton";
import { ScreenFramingPanel } from "@/components/studio/fields/ScreenFramingPanel";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";
import { SaveBar } from "@/components/studio/SaveBar";
import { SlugField } from "@/components/studio/SlugField";
import { StatusControl, statusProblems } from "@/components/studio/StatusControl";
import { PUBLISHED_AUTOSAVE_NOTICE, useAutosave } from "@/components/studio/useAutosave";
import { usePublishNotice } from "@/components/studio/usePublishNotice";
import { useLeaveGuard } from "@/components/studio/useUnsavedChanges";
import { MediaPicker } from "@/components/studio/media/MediaPicker";
import type { StudioMediaAsset } from "@/components/studio/media/MediaGrid";

/**
 * Every address this screen calls, in one place, so a rename is one edit and the route handlers have a
 * single list to satisfy.
 *
 * `PATCH` takes the album's fields AND the complete list of pictures; the array's order IS the order.
 */
const GALLERY_ENDPOINTS = {
  create: "/api/studio/gallery",
  detail: (id: string) => `/api/studio/gallery/${encodeURIComponent(id)}`
} as const;

/** Titles longer than this stop fitting the gallery listing's card. Counted under the field. */
const TITLE_MAX = 140;
/** The listing shows this much of the description before it truncates. */
const DESCRIPTION_MAX = 600;
const CAPTION_MAX = 300;
const CREDIT_MAX = 160;
const LOCATION_MAX = 160;
const CATEGORY_MAX = 80;
/** Past this many tags nothing is being described any more. Stated on screen beside the field. */
const TAG_LIMIT = 20;
const TAG_MAX_LENGTH = 40;

/**
 * How a picture is PRESENTED, which is not always what the file is — a still frame can introduce a
 * virtual tour (schema, `GalleryItem.presentation`). The descriptions are written for somebody choosing
 * between them, so they say what a visitor will get rather than which component renders it.
 */
const PRESENTATIONS = [
  {
    value: "image",
    label: "Photograph",
    description: "Shown as a picture. Clicking it opens the larger version."
  },
  {
    value: "video",
    label: "Video",
    description: "Shown with a play control. The file itself must be a video, not a still of one."
  },
  {
    value: "panorama",
    label: "Panorama",
    description:
      "A wide picture a visitor can drag to look around. Only use this for a photograph actually taken as a 360° or very wide shot."
  },
  {
    value: "tour",
    label: "Way into a virtual tour",
    description:
      "The picture is the door to a tour. Give the name of the scene the tour should open on, below."
  }
] as const;

export type PresentationValue = (typeof PRESENTATIONS)[number]["value"];

const PRESENTATION_VALUES: readonly string[] = PRESENTATIONS.map((entry) => entry.value);

function isPresentation(value: string): value is PresentationValue {
  return PRESENTATION_VALUES.includes(value);
}

/** Unrecognised words become "Photograph" — but the screen says so rather than silently changing data. */
function normalisePresentation(value: string): PresentationValue {
  return isPresentation(value) ? value : "image";
}

function presentationLabel(value: PresentationValue): string {
  return PRESENTATIONS.find((entry) => entry.value === value)?.label ?? "Photograph";
}

/** Everything `<MediaImage>` needs, plus the two facts this screen states in words. */
export interface AlbumItemAsset {
  id: string;
  kind: string;
  fileName: string;
  objectKey: string;
  width: number | null;
  height: number | null;
  /** `null` means nobody has written a description. `""` means somebody marked it decorative. */
  altText: string | null;
  blurDataUrl: string | null;
  /**
   * The crop chosen on the asset. Carried so a picture rendered from this row honours it — a field
   * absent here is a field `MediaImage` never sees, whatever the query fetched.
   */
  cropX: number | null;
  cropY: number | null;
  cropWidth: number | null;
  cropHeight: number | null;
  variants: { label: string; format: string; objectKey: string; width: number }[];
}

export interface AlbumItemDraft {
  /**
   * Stable for the life of the tile. The `GalleryItem` id for a stored row, a generated one for a
   * picture added in this session — React then reuses the tile's DOM when it moves, so focus follows the
   * picture that moved rather than the position it left.
   */
  key: string;
  assetId: string;
  caption: string;
  /** A free-text column in the database; normalised on the way into this component. */
  presentation: string;
  tourEntry: string;
  /**
   * How THIS PICTURE IN THIS ALBUM is framed at each screen size, or null — the resting state, and what
   * nearly every row carries. It belongs to the row rather than to the file, so the same photograph can be
   * framed one way here and another in a project's gallery. A row never changes its picture (a different
   * photograph is a different row), so unlike `coverScreens` there is nothing to clear it against.
   */
  assetScreens: ScreenFraming | null;
  asset: AlbumItemAsset;
}

export interface AlbumDraft {
  /** `null` for an album that does not exist yet. It is what decides between a POST and a PATCH. */
  id: string | null;
  slug: string;
  title: string;
  description: string;
  category: string;
  location: string;
  credit: string;
  /** `YYYY-MM-DD`, or "" — the shape the `DateField` on this screen reads and writes, and no other. */
  happenedOn: string;
  coverId: string | null;
  /**
   * How the cover is framed at each screen size, or null — which is the resting state and what nearly
   * every album carries. It belongs to the COVER, so it is cleared whenever `coverId` changes: a
   * rectangle is a fraction of one particular photograph, and carried onto another it frames whatever
   * happens to sit at those coordinates (the rule `MediaFramingField` exists to hold for the blocks).
   */
  coverScreens: ScreenFraming | null;
  sortOrder: number;
  status: ContentStatus;
  /** ISO instant, read-only. The server stamps it. */
  publishedAt: string | null;
  tags: string[];
  items: AlbumItemDraft[];
}

/** The body sent to the server. The item ORDER is the position; nothing carries a number. */
interface AlbumPayload {
  title: string;
  slug: string;
  description: string;
  category: string;
  location: string;
  credit: string;
  /** An ISO instant at UTC midnight, or null. See `toIsoDay`. */
  happenedOn: string | null;
  coverId: string | null;
  coverScreens: ScreenFraming | null;
  sortOrder: number;
  status: ContentStatus;
  tags: string[];
  items: {
    assetId: string;
    caption: string;
    presentation: PresentationValue;
    tourEntry: string | null;
    assetScreens: ScreenFraming | null;
  }[];
}

/**
 * `YYYY-MM-DD` → an ISO instant at UTC MIDNIGHT.
 *
 * `new Date("2026-03-01")` is parsed as UTC by the specification, which is what is wanted for a column
 * holding a day — the alternative spelling, `new Date("2026-03-01T00:00")`, is parsed as LOCAL time, and
 * an album dated the 1st in a zone behind UTC would be stored as the 28th of the month before. The two
 * spellings look alike and mean different instants.
 */
function toIsoDay(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export interface AlbumEditorProps {
  album: AlbumDraft;
  /** `canPublish(user)` from lib/permissions.ts — the same predicate the route handler enforces. */
  canPublish: boolean;
  /** False when object storage is not configured. The picker's upload area then says so. */
  storageReady: boolean;
  /** For the address preview. The site's own origin, with no trailing slash. */
  siteUrl: string;
  /** Categories other albums already use, offered as a datalist so spellings stay consistent. */
  categorySuggestions: readonly string[];
}

export function AlbumEditor({
  album,
  canPublish,
  storageReady,
  siteUrl,
  categorySuggestions
}: AlbumEditorProps) {
  const router = useRouter();
  const { toast } = useToast();
  const uid = useId();

  const [draft, setDraft] = useState<AlbumDraft>(() => ({
    ...album,
    items: album.items.map((item) => ({ ...item, presentation: normalisePresentation(item.presentation) }))
  }));
  const [albumId, setAlbumId] = useState<string | null>(album.id);
  const [selectedKey, setSelectedKey] = useState<string | null>(() => album.items[0]?.key ?? null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  /** The key generator for pictures added in this session. A ref: nobody renders it. */
  const nextKey = useRef(0);

  /** True when any stored `presentation` was a word this build does not know. Reported, not hidden. */
  const hadUnknownPresentation = useMemo(
    () => album.items.some((item) => !isPresentation(item.presentation)),
    [album.items]
  );

  const items = draft.items;

  const patchDraft = useCallback((partial: Partial<AlbumDraft>) => {
    setDraft((current) => ({ ...current, ...partial }));
  }, []);

  // ── The payload, and saving ────────────────────────────────────────────────────────────────────

  const payload = useMemo<AlbumPayload>(
    () => ({
      title: draft.title.trim(),
      slug: draft.slug.trim(),
      description: draft.description.trim(),
      category: draft.category.trim(),
      location: draft.location.trim(),
      credit: draft.credit.trim(),
      happenedOn: toIsoDay(draft.happenedOn),
      coverId: draft.coverId,
      // Sent on every save beside the id it frames. Null is a real answer the route writes through, so
      // clearing the panel clears the column rather than leaving the last framing in place.
      coverScreens: draft.coverScreens,
      sortOrder: draft.sortOrder,
      status: draft.status,
      tags: draft.tags,
      items: items.map((item) => ({
        assetId: item.assetId,
        caption: item.caption.trim(),
        presentation: normalisePresentation(item.presentation),
        // An empty entry scene is nothing, not the empty string: the column is nullable and "" would
        // read as a scene whose name happens to be blank.
        tourEntry: item.tourEntry.trim().length > 0 ? item.tourEntry.trim() : null,
        // Sent beside the picture it frames, on every save. Null is a real answer the route writes
        // through, so clearing a row's panel clears its column.
        assetScreens: item.assetScreens
      }))
    }),
    [draft, items]
  );

  const save = useCallback(
    async (body: AlbumPayload) => {
      if (albumId === null) {
        const created = await post<{ id: string }>(GALLERY_ENDPOINTS.create, body);
        setAlbumId(created.id);
        // Only to correct the address bar: the values the freshly-rendered server page will send down
        // are the ones we have just posted, so nothing on screen changes. `replace`, not `push`, because
        // "the new album screen" is not a place the Back button should return to.
        router.replace(`/studio/gallery/${created.id}`, { scroll: false });
        return;
      }
      await patch(GALLERY_ENDPOINTS.detail(albumId), body);
    },
    [albumId, router]
  );

  /**
   * SCHEDULED counts as public here as well as PUBLISHED.
   *
   * Publication state is resolved at READ time (contract §9), so a SCHEDULED album whose date has passed
   * is already live — and this editor cannot know the reader's clock is the server's. Treating both as
   * public is the safe direction: the cost is a Save button, and the cost of the other direction is a
   * half-written caption on the site.
   */
  const isPublic = draft.status === "PUBLISHED" || draft.status === "SCHEDULED";

  /**
   * The public address, handed over the moment this album crosses onto the site. `basePath` is the same
   * string `SlugField` is given below, so the preview in the form and the link in the notice cannot
   * disagree about where the album has gone.
   */
  const announcePublished = usePublishNotice({
    initial: album,
    origin: siteUrl,
    basePath: "/gallery/",
    subject: "album"
  });

  const autosave = useAutosave<AlbumPayload>({
    data: payload,
    save,
    isPublished: isPublic,
    // Nothing is created behind the reader's back. An album that does not exist yet is saved when they
    // choose Save, and the bar says so.
    enabled: albumId !== null,
    // The snapshot that was SENT, which is what `save` has just written — not `draft`, which the reader
    // may have carried on editing while the request was in flight.
    onSaved: (sent) => announcePublished(sent)
  });

  useLeaveGuard(autosave.isDirty);

  // ── Pictures ───────────────────────────────────────────────────────────────────────────────────

  const addPictures = useCallback(
    (assets: StudioMediaAsset[]) => {
      const existing = new Set(items.map((item) => item.assetId));
      const fresh: AlbumItemDraft[] = [];
      let alreadyHere = 0;

      for (const asset of assets) {
        if (existing.has(asset.id)) {
          alreadyHere += 1;
          continue;
        }
        existing.add(asset.id);
        nextKey.current += 1;
        fresh.push({
          key: `${uid}-new-${nextKey.current}`,
          assetId: asset.id,
          caption: asset.caption ?? "",
          presentation: asset.kind === "VIDEO" ? "video" : asset.kind === "PANORAMA" ? "panorama" : "image",
          tourEntry: "",
          // A new row starts unframed. Null, never an empty framing — see `emptyScreenFraming` in
          // lib/media/screens.ts for why six empty buckets would mark a clean form dirty.
          assetScreens: null,
          asset: {
            id: asset.id,
            kind: asset.kind,
            fileName: asset.fileName,
            objectKey: asset.objectKey,
            width: asset.width,
            height: asset.height,
            altText: asset.altText,
            blurDataUrl: asset.blurDataUrl,
            // The crop travels with the row: a field not named here is a field MediaImage never sees.
            cropX: asset.cropX ?? null,
            cropY: asset.cropY ?? null,
            cropWidth: asset.cropWidth ?? null,
            cropHeight: asset.cropHeight ?? null,
            variants: asset.variants ?? []
          }
        });
      }

      if (fresh.length > 0) {
        setDraft((current) => ({ ...current, items: [...current.items, ...fresh] }));
        const first = fresh[0];
        if (first) setSelectedKey(first.key);
        setAnnouncement(
          fresh.length === 1
            ? "1 picture added to the end of the album."
            : `${fresh.length} pictures added to the end of the album.`
        );
      }

      // Said out loud rather than swallowed: adding fewer pictures than were chosen, with no
      // explanation, reads as a screen that lost some of them (contract §1.6).
      if (alreadyHere > 0) {
        toast({
          tone: "warn",
          title:
            alreadyHere === 1
              ? "One picture was already in this album"
              : `${alreadyHere} pictures were already in this album`,
          description:
            "A picture can only appear once in an album, so those were left where they are. Move them instead if they are in the wrong place."
        });
      }
    },
    [items, toast, uid]
  );

  const move = useCallback(
    (from: number, to: number) => {
      if (from === to) return;
      setDraft((current) => {
        if (from < 0 || to < 0 || from >= current.items.length || to >= current.items.length) {
          return current;
        }
        return { ...current, items: arrayMove(current.items, from, to) };
      });
      setAnnouncement(`Picture moved from position ${from + 1} to position ${to + 1} of ${items.length}.`);
    },
    [items.length]
  );

  const removeItem = useCallback(
    (key: string) => {
      setDraft((current) => {
        const index = current.items.findIndex((item) => item.key === key);
        if (index === -1) return current;
        const removed = current.items[index];
        const remaining = current.items.filter((item) => item.key !== key);
        const losesCover = Boolean(removed && current.coverId === removed.assetId);
        return {
          ...current,
          items: remaining,
          // A cover that has just been taken out of the album would be a cover a visitor never sees
          // beside the pictures they do. Cleared with it, and the sentence below explains the rule.
          coverId: losesCover ? null : current.coverId,
          // And its framing goes with it: those rectangles are fractions of the photograph that has just
          // left, so keeping them would frame whatever a later cover happens to have at those coordinates.
          coverScreens: losesCover ? null : current.coverScreens
        };
      });
      setSelectedKey((current) => (current === key ? null : current));
      setAnnouncement("Picture taken out of the album. The picture itself is still in the media library.");
    },
    []
  );

  const updateItem = useCallback((key: string, partial: Partial<AlbumItemDraft>) => {
    setDraft((current) => ({
      ...current,
      items: current.items.map((item) => (item.key === key ? { ...item, ...partial } : item))
    }));
  }, []);

  /**
   * A short press must still be a click. Without the distance constraint the pointer sensor claims every
   * press on the grip and the handle can never be focused by clicking it — which is exactly how a drag
   * handle stops working with a trackpad.
   */
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const from = items.findIndex((item) => item.key === String(active.id));
      const to = items.findIndex((item) => item.key === String(over.id));
      if (from === -1 || to === -1) return;
      move(from, to);
    },
    [items, move]
  );

  const selected = items.find((item) => item.key === selectedKey) ?? null;
  const selectedIndex = selected ? items.findIndex((item) => item.key === selected.key) : -1;

  // ── What is in the way ─────────────────────────────────────────────────────────────────────────

  const missingDescriptions = items.filter((item) => item.asset.altText === null).length;

  /**
   * A cover recorded on the album that is not one of its pictures.
   *
   * Reported rather than quietly cleared: an editor who imported an album and finds its cover silently
   * gone has lost a decision somebody made, and there is no way for them to know it happened.
   */
  const coverIsForeign =
    draft.coverId !== null && !items.some((item) => item.assetId === draft.coverId);

  const publishBlockers = useMemo(() => {
    const reasons: string[] = [];
    if (draft.title.trim().length === 0) reasons.push("The album has no title.");
    if (draft.slug.trim().length === 0) reasons.push("The album has no web address.");
    if (items.length === 0) {
      reasons.push("There are no pictures in the album, so its page would be empty.");
    }
    const tourWithoutEntry = items.filter(
      (item) => normalisePresentation(item.presentation) === "tour" && item.tourEntry.trim().length === 0
    ).length;
    if (tourWithoutEntry > 0) {
      reasons.push(
        tourWithoutEntry === 1
          ? "One picture is set to open a virtual tour but has no scene name, so nothing would open."
          : `${tourWithoutEntry} pictures are set to open a virtual tour but have no scene name, so nothing would open.`
      );
    }
    // `GalleryAlbum` carries only `status` and `publishedAt` — no `publishAt`/`unpublishAt` — so the
    // scheduling half is refused rather than offered (StatusControl's header explains the trap).
    reasons.push(...statusProblems({ status: draft.status, publishedAt: draft.publishedAt }, false));
    return reasons;
  }, [draft.title, draft.slug, draft.status, draft.publishedAt, items]);

  /**
   * Why Save is refused, as a sentence naming what is wrong.
   *
   * Only the two things the SERVER will refuse: a title and an address are required columns. Everything
   * else on the blocker list stops it going PUBLIC, not being saved as a draft.
   */
  const saveDisabledReason =
    draft.title.trim().length === 0
      ? "The album needs a title before it can be saved."
      : draft.slug.trim().length === 0
        ? "The album needs a web address before it can be saved."
        : null;

  const onDelete = useCallback(async () => {
    if (albumId === null) return;
    await del(GALLERY_ENDPOINTS.detail(albumId));
  }, [albumId]);

  return (
    <div className="mt-6 space-y-6">
      {/* Mounted in both states so the region is registered before its content ever changes — a live
          region inserted at the same instant as its text is announced inconsistently. */}
      <span role="status" className="sr-only">
        {announcement}
      </span>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <FormSection
            title="Pictures"
            description={
              items.length === 0
                ? "Choose pictures from the media library. They appear in the order you put them in, and you can change that order by dragging or with the buttons on each one."
                : "Drag a picture to move it, or use the arrows on it. Click one to write its caption and choose how it is shown."
            }
            actions={
              <Button
                variant="secondary"
                size="sm"
                icon={ImagePlus}
                onClick={() => setPickerOpen(true)}
              >
                Add pictures
              </Button>
            }
          >
            {hadUnknownPresentation ? (
              <HelpText tone="warn">
                At least one picture was saved with a way of showing it that this version of the studio
                does not recognise, so it is shown here as an ordinary photograph. Check the choices
                below before saving — saving will replace the unrecognised value.
              </HelpText>
            ) : null}

            {items.length === 0 ? (
              <div className="rounded-md border border-dashed border-line-200 bg-surface-50 px-4 py-10 text-center">
                <Images aria-hidden="true" className="mx-auto h-6 w-6 text-ink-300" />
                <p className="mt-3 text-sm text-ink-500">
                  There are no pictures in this album yet.
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={ImagePlus}
                  onClick={() => setPickerOpen(true)}
                  className="mt-3"
                >
                  Add pictures
                </Button>
              </div>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                // Never outside the grid: a tile dragged away from its own group is a drag with nowhere
                // to land, and the pointer ends up somewhere the drop cannot be read.
                modifiers={[restrictToParentElement]}
                onDragEnd={onDragEnd}
              >
                <SortableContext items={items.map((item) => item.key)} strategy={rectSortingStrategy}>
                  <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                    {items.map((item, index) => (
                      <PictureTile
                        key={item.key}
                        item={item}
                        index={index}
                        count={items.length}
                        isCover={draft.coverId === item.assetId}
                        isSelected={item.key === selectedKey}
                        onSelect={() => setSelectedKey(item.key)}
                        onMove={move}
                      />
                    ))}
                  </ul>
                </SortableContext>
              </DndContext>
            )}

            {items.length > 0 ? (
              <p className="text-xs text-ink-500">
                {items.length === 1 ? "1 picture" : `${items.length} pictures`} in this album. The first
                one is used in the gallery listing unless another is marked as the cover.
              </p>
            ) : null}

            {missingDescriptions > 0 ? (
              <HelpText tone="warn">
                {missingDescriptions === 1
                  ? "One picture here has no description, so somebody using a screen reader is told nothing at all where it appears."
                  : `${missingDescriptions} pictures here have no description, so somebody using a screen reader is told nothing at all where they appear.`}{" "}
                Descriptions are set once, on the picture itself, in the{" "}
                <Link
                  href="/studio/media?alt=missing"
                  className="font-semibold underline underline-offset-2"
                >
                  media library
                </Link>
                .
              </HelpText>
            ) : null}

            {coverIsForeign ? (
              <HelpText tone="warn">
                The cover recorded for this album is a picture that is not in it, so the listing shows
                something a visitor cannot find inside the album. Choose one of the pictures below as the
                cover, or clear it.
                <Button
                  variant="ghost"
                  size="sm"
                  // The framing goes with the picture it was drawn on — see `coverScreens` on `AlbumDraft`.
                  onClick={() => patchDraft({ coverId: null, coverScreens: null })}
                  className="ml-2 !px-2"
                >
                  Clear the cover
                </Button>
              </HelpText>
            ) : null}
          </FormSection>

          <FormSection
            title="About this album"
            description="What the occasion was, when and where it happened, and who took the photographs."
          >
            <Field
              label="Title"
              required
              help="What the occasion was called. This is the heading on the album's page and the name in the gallery listing."
              maxLength={TITLE_MAX}
              value={draft.title}
            >
              <Input
                value={draft.title}
                onChange={(event) => patchDraft({ title: event.target.value })}
                placeholder="Natural dye workshop, March 2026"
              />
            </Field>

            <SlugField
              value={draft.slug}
              onChange={(slug) => patchDraft({ slug })}
              source={draft.title}
              basePath="/gallery/"
              siteUrl={siteUrl}
              originalValue={album.slug}
              isPublished={isPublic}
              required
            />

            <Field
              label="Description"
              help="A short paragraph saying what happened. It appears under the title on the album's page."
              maxLength={DESCRIPTION_MAX}
              value={draft.description}
            >
              <Textarea
                value={draft.description}
                onChange={(event) => patchDraft({ description: event.target.value })}
                rows={4}
              />
            </Field>

            <div className="grid gap-5 sm:grid-cols-2">
              {/*
                `Field` (a real `<label>`) is right for the three plain `<input>`s here: there is no
                button inside any of them for a stray click to be forwarded to, and nothing else with a
                name to be folded into the box's own (Field.tsx). The date is the exception and brings
                its own `FieldBlock` — see the note on it below.
              */}
              <Field
                label="Category"
                help="Groups albums in the listing — “Workshops”, “Field visits”, “Exhibitions”. Reuse a name you have used before so the groups stay tidy."
                maxLength={CATEGORY_MAX}
                value={draft.category}
              >
                <Input
                  value={draft.category}
                  onChange={(event) => patchDraft({ category: event.target.value })}
                  list={`${uid}categories`}
                  placeholder="Workshops"
                />
              </Field>

              {/*
                ⚠ `draft.happenedOn` IS STILL THE BARE `YYYY-MM-DD` IT ALWAYS WAS, and the single
                conversion to an instant is still the one in `toIsoDay` — read that function's note for
                why an album dated the 1st has to be stored at UTC midnight and not local. `DateField`
                is string-in/string-out and parses nothing on the way through (its header explains why
                it refuses to own a zone), so the day the reader sees, the day the grid highlights and
                the day `toIsoDay` is handed are the same digits throughout.

                It wraps itself in a `FieldBlock` rather than the `Field` beside it, and that is the
                exception the note above points at: this field contains the button that opens the
                calendar, and a `<label>` would fold that button into the box's accessible name and
                forward the click that opened it straight back into the box (Field.tsx).
              */}
              <DateField
                label="Date of the occasion"
                help="The day the photographs were taken, not the day you are adding them. Albums can be ordered by this."
                value={draft.happenedOn}
                onChange={(happenedOn) => patchDraft({ happenedOn })}
              />

              <Field
                label="Place"
                help="Where it happened, as you would say it out loud — “Bagru, Rajasthan”."
                maxLength={LOCATION_MAX}
                value={draft.location}
              >
                <Input
                  value={draft.location}
                  onChange={(event) => patchDraft({ location: event.target.value })}
                />
              </Field>

              <Field
                label="Credit"
                help="Who took the photographs, printed under the album. Leave it empty if there is nobody to name."
                maxLength={CREDIT_MAX}
                value={draft.credit}
              >
                <Input
                  value={draft.credit}
                  onChange={(event) => patchDraft({ credit: event.target.value })}
                />
              </Field>
            </div>

            {/* A datalist is a suggestion list, not a closed one: a new category has to be typeable, and
                a `<select>` here would make adding one a code change. */}
            <datalist id={`${uid}categories`}>
              {categorySuggestions.map((category) => (
                <option key={category} value={category} />
              ))}
            </datalist>

            <TagEditor
              tags={draft.tags}
              onChange={(tags) => patchDraft({ tags })}
              onAnnounce={setAnnouncement}
            />

            <Field
              label="Position in the listing"
              help="Albums with a lower number are shown first when the listing is ordered by hand. Leave it at 0 unless you are deliberately pinning this album to the top."
            >
              <Input
                type="number"
                inputMode="numeric"
                value={String(draft.sortOrder)}
                onChange={(event) => {
                  const parsed = Number.parseInt(event.target.value, 10);
                  patchDraft({ sortOrder: Number.isFinite(parsed) ? parsed : 0 });
                }}
                className="max-w-32"
              />
            </Field>
          </FormSection>

          {albumId !== null ? (
            <FormSection
              title="Delete this album"
              tone="danger"
              description="The album goes to the recycle bin. The photographs themselves stay in the media library — they are only taken out of this album."
            >
              <DeleteButton
                name={draft.title.trim().length > 0 ? draft.title : "this album"}
                noun="album"
                onDelete={onDelete}
                onDeleted={() => router.push("/studio/gallery")}
                consequences={
                  items.length > 0
                    ? `The ${items.length === 1 ? "picture" : `${items.length} pictures`} in it stay in the media library and in any other album that uses them.`
                    : undefined
                }
                successMessage={null}
              />
            </FormSection>
          ) : null}
        </div>

        {/* ── The selected picture ─────────────────────────────────────────────────────────── */}
        <aside className="min-w-0">
          <div className="xl:sticky xl:top-4">
            <FormSection
              title={selected ? "This picture" : "Pictures"}
              description={
                selected
                  ? "Everything here belongs to this picture inside this album. The description a screen reader hears belongs to the picture itself and is set in the media library."
                  : "Click a picture in the grid to write its caption and choose how it is shown."
              }
            >
              {selected === null ? (
                <p className="text-sm text-ink-500">Nothing is selected.</p>
              ) : (
                <>
                  <div className="flex items-start gap-3">
                    <MediaImage
                      media={selected.asset}
                      alt=""
                      aspect="none"
                      rounded="sm"
                      sizes="120px"
                      className="h-16 w-24 shrink-0"
                    />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink-900">
                        {selected.asset.fileName}
                      </p>
                      <p className="mt-0.5 text-xs text-ink-500">
                        Picture {selectedIndex + 1} of {items.length}
                      </p>
                      {selected.asset.altText === null ? (
                        <p className="mt-1 text-xs leading-relaxed text-amber-800">
                          No description. Add one in the media library.
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <Field
                    label="Caption"
                    help="Printed under the picture. Say what is happening, or who is in it — this is different from the description a screen reader hears."
                    maxLength={CAPTION_MAX}
                    value={selected.caption}
                  >
                    <Textarea
                      value={selected.caption}
                      onChange={(event) => updateItem(selected.key, { caption: event.target.value })}
                      rows={3}
                    />
                  </Field>

                  <Field
                    label="How it is shown"
                    help={
                      PRESENTATIONS.find(
                        (entry) => entry.value === normalisePresentation(selected.presentation)
                      )?.description
                    }
                  >
                    <Select
                      value={normalisePresentation(selected.presentation)}
                      options={PRESENTATIONS.map((entry) => ({
                        value: entry.value,
                        label: entry.label
                      }))}
                      onChange={(event) =>
                        updateItem(selected.key, {
                          presentation: normalisePresentation(event.target.value)
                        })
                      }
                    />
                  </Field>

                  {normalisePresentation(selected.presentation) === "tour" ? (
                    <Field
                      label="Scene the tour opens on"
                      required
                      help="The name of the starting scene inside the tour. Without it the tour has nowhere to open and nothing happens when a visitor clicks."
                      error={
                        selected.tourEntry.trim().length === 0
                          ? "A scene name is needed, or this picture will do nothing when clicked."
                          : null
                      }
                    >
                      <Input
                        value={selected.tourEntry}
                        onChange={(event) => updateItem(selected.key, { tourEntry: event.target.value })}
                        placeholder="courtyard"
                        className="font-mono text-xs"
                      />
                    </Field>
                  ) : null}

                  {/*
                    THIS ROW'S OWN FRAMING, which is a different column from the cover's panel further
                    down: `GalleryItem.assetScreens` frames the picture as it appears INSIDE the album,
                    and `GalleryAlbum.coverScreens` frames the one card in the listing. A picture that is
                    also the cover therefore has two, and the two help sentences say which is which.

                    Not `MediaFramingField`: that pairs a picker with the panel, and a row's photograph is
                    not swappable — a different picture is a different row (add it and take this one out).
                    So there is nothing here for the "changing the picture clears the framing" rule to act
                    on, which is the one thing that component exists to hold.

                    No gate on `presentation`: the album page and the gallery block both draw every item
                    as a still picture whatever it says, and the chip beside it is what tells a reader it
                    is a panorama or a tour. A panel offered on some tiles and not others would be the
                    confusing half-measure.
                  */}
                  <ScreenFramingPanel
                    /* Both labels name WHERE the framing lands, because a picture that is also the cover
                       shows both panels in this one column and two identical headings would be a puzzle. */
                    label="Framing per screen size, inside the album"
                    help="Optional. Frame this picture differently at each screen size, or use a different photograph on narrow screens. Anything left alone inherits from the next smaller size, and the smallest falls back to the picture's own crop. This applies to this picture inside this album, wherever the album's pictures are shown."
                    mediaId={selected.assetId}
                    value={selected.assetScreens}
                    onChange={(next) => updateItem(selected.key, { assetScreens: next })}
                  />

                  <div className="flex flex-wrap gap-2">
                    {draft.coverId === selected.assetId ? (
                      <p className="flex items-center gap-1.5 text-xs font-medium text-purple-700">
                        <Star aria-hidden="true" className="h-3.5 w-3.5" />
                        This is the album cover
                      </p>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={Star}
                        // A new cover starts unframed. The framing that was there belonged to the old
                        // photograph — see `coverScreens` on `AlbumDraft` for why carrying it across is
                        // the one thing that must never happen.
                        onClick={() => patchDraft({ coverId: selected.assetId, coverScreens: null })}
                      >
                        Use as the album cover
                      </Button>
                    )}

                    <Button
                      variant="ghost"
                      size="sm"
                      icon={Trash2}
                      onClick={() => removeItem(selected.key)}
                    >
                      Take out of this album
                    </Button>
                  </div>

                  {/*
                    THE COVER'S FRAMING, AND IT IS OFFERED ONLY ON THE PICTURE THAT IS THE COVER.

                    The framing belongs to the album's `coverScreens` column, not to this `GalleryItem`, so
                    it would be a lie to show it beside a picture that is merely selected. The panel is
                    where the cover DECISION is, which is here, next to the button that makes it.

                    Not `MediaFramingField`: that component pairs a picker with the panel, and this screen
                    deliberately has no picker for the cover — it is chosen from the album's own pictures
                    (see the file header). The rule that component exists to hold, that changing the
                    picture clears the framing, is held instead at the three places `coverId` moves.

                    ⚠ WHERE IT TAKES EFFECT IS STATED, because the answer is not the obvious one. The cover
                    is drawn on the gallery LISTING; the album's own page shows the pictures themselves and
                    carries no cover image at all (app/(site)/gallery/[slug]/page.tsx says why). An editor
                    framing something they then cannot find on the album's page would reasonably conclude
                    the control was broken.
                  */}
                  {draft.coverId === selected.assetId ? (
                    <ScreenFramingPanel
                      /* See the note on the panel above: the label says which of the two this is. */
                      label="Framing per screen size, on the gallery listing"
                      help="Optional. Frame the cover differently at each screen size, or use a different photograph on narrow screens. Anything left alone inherits from the next smaller size, and the smallest falls back to the picture's own crop. This shows in the gallery listing, where the cover is drawn — the album's own page shows the pictures themselves."
                      mediaId={selected.assetId}
                      value={draft.coverScreens}
                      onChange={(next) => patchDraft({ coverScreens: next })}
                    />
                  ) : null}
                </>
              )}
            </FormSection>

            <FormSection
              title="Publication"
              description="Whether this album can be reached by anybody outside the studio."
              className="mt-6"
            >
              <StatusControl
                value={{ status: draft.status, publishedAt: draft.publishedAt }}
                onChange={(next) => patchDraft({ status: next.status })}
                canPublish={canPublish}
                // Albums carry only `status` and `publishedAt`; there is nowhere to store a schedule, so
                // the option is not offered rather than written into nothing (StatusControl's header).
                scheduling={false}
                publishBlockers={publishBlockers}
              />
            </FormSection>
          </div>
        </aside>
      </div>

      <SaveBar
        status={autosave.status}
        lastSavedAt={autosave.lastSavedAt}
        onSave={() => void autosave.saveNow()}
        onDiscard={() => {
          // Putting the form back to what the server last gave it is all that is needed: `useAutosave`
          // compares a serialised snapshot, so this makes the form clean again by itself.
          setDraft({
            ...album,
            items: album.items.map((item) => ({
              ...item,
              presentation: normalisePresentation(item.presentation)
            }))
          });
          setSelectedKey(album.items[0]?.key ?? null);
        }}
        error={autosave.error?.message ?? null}
        saveDisabledReason={saveDisabledReason}
        subject="this album"
        note={
          albumId === null
            ? "This album has not been created yet, so nothing is saved automatically. Choose Save to create it, after which changes are kept for you every few seconds."
            : isPublic
              ? PUBLISHED_AUTOSAVE_NOTICE
              : autosave.retriesExhausted
                ? "Saving has stopped trying on its own after several failures. Choose Save to try again."
                : "Changes are saved automatically a few seconds after you stop typing."
        }
      >
        {/*
          A NEW TAB, so this screen and its unsaved work stay exactly where they are — which is also why the
          unsaved-changes guard leaves it alone (it only intercepts a plain left click that would navigate
          THIS tab). `album.slug` and not `draft.slug`: the address on the site is the one that was SAVED,
          and an unsaved change to it would open a page that does not exist yet.
        */}
        {albumId !== null && isPublic ? (
          <Button
            variant="secondary"
            onClick={() => window.open(`/gallery/${album.slug}`, "_blank", "noopener,noreferrer")}
          >
            Open on the site
          </Button>
        ) : null}
      </SaveBar>

      <MediaPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={addPictures}
        multiple
        storageReady={storageReady}
        title="Add pictures to this album"
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// One tile
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface PictureTileProps {
  item: AlbumItemDraft;
  index: number;
  count: number;
  isCover: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onMove: (from: number, to: number) => void;
}

function PictureTile({ item, index, count, isCover, isSelected, onSelect, onMove }: PictureTileProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.key });

  const position = `${index + 1} of ${count}`;
  const presentation = normalisePresentation(item.presentation);

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "relative overflow-hidden rounded-md border bg-card",
        isSelected ? "border-purple-600" : "border-line-200",
        // The lift is two signals and only one of them is motion: the shadow moves, the NAMED ring does
        // not. A bare `ring-2` would be stock blue (contract §3).
        isDragging && "z-10 shadow-panel ring-2 ring-purple-600/30"
      )}
    >
      {/*
        The whole tile is a button that SELECTS. It is deliberately not a link and not the drag handle:
        a tile that both navigates and drags cannot do either reliably, and a tile with no plain click
        target would leave a keyboard reader unable to reach the caption field for a picture.
      */}
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={isSelected}
        className="block w-full text-left"
      >
        <MediaImage
          media={item.asset}
          alt=""
          aspect={4 / 3}
          rounded="none"
          sizes="(min-width: 1024px) 20vw, 45vw"
          className="w-full"
        />
        <span className="block px-2 py-1.5">
          <span className="flex items-center gap-1.5">
            <span className="text-xs tabular-nums text-ink-500">{index + 1}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-ink-900">
              {item.caption.trim().length > 0 ? item.caption : item.asset.fileName}
            </span>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[0.6875rem] text-ink-500">
            {/* The presentation is a WORD, not an icon alone — colour and shape never carry meaning by
                themselves (contract §11). */}
            <span>{presentationLabel(presentation)}</span>
            {item.asset.altText === null ? (
              <span className="inline-flex items-center gap-0.5 text-amber-800">
                <ImageOff aria-hidden="true" className="h-3 w-3" />
                No description
              </span>
            ) : null}
          </span>
          <span className="sr-only">
            {" "}
            — picture {position}
            {isCover ? ", the album cover" : ""}
            {isSelected ? ", selected" : ""}
          </span>
        </span>
      </button>

      {isCover ? (
        <span className="pointer-events-none absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-purple-700 px-2 py-0.5 text-[0.6875rem] font-medium text-white">
          <Star aria-hidden="true" className="h-3 w-3" />
          Cover
        </span>
      ) : null}

      <div className="absolute right-1 top-1 flex items-center gap-0.5 rounded-md bg-card/90 p-0.5">
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label={`Drag to reorder picture ${position}`}
          // `touch-none` stops a phone scrolling the page instead of starting the drag.
          className="inline-flex h-7 w-6 cursor-grab touch-none items-center justify-center rounded text-ink-500 transition hover:bg-surface-100 hover:text-ink-900 focus-visible:ring-2 focus-visible:ring-purple-600/30"
          {...attributes}
          {...listeners}
        >
          <GripVertical aria-hidden="true" className="h-3.5 w-3.5" />
        </button>

        <MoveButton
          label={`Move picture ${position} earlier`}
          unavailable={index === 0}
          direction="earlier"
          onClick={() => onMove(index, index - 1)}
        />
        <MoveButton
          label={`Move picture ${position} later`}
          unavailable={index === count - 1}
          direction="later"
          onClick={() => onMove(index, index + 1)}
        />
      </div>
    </li>
  );
}

/**
 * One reorder button.
 *
 * `aria-disabled` and a no-op at the ends rather than `disabled`: browsers blur a control the instant it
 * becomes disabled, so moving a picture to the front with the keyboard would drop focus to the document
 * body and the next press would start from the top of the page.
 */
function MoveButton({
  label,
  unavailable,
  direction,
  onClick
}: {
  label: string;
  unavailable: boolean;
  direction: "earlier" | "later";
  onClick: () => void;
}) {
  const Glyph = direction === "earlier" ? ChevronLeft : ChevronRight;
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
        "inline-flex h-7 w-6 items-center justify-center rounded transition focus-visible:ring-2 focus-visible:ring-purple-600/30",
        unavailable
          ? "cursor-default text-ink-300 opacity-50"
          : "text-ink-500 hover:bg-surface-100 hover:text-ink-900"
      )}
    >
      <Glyph aria-hidden="true" className="h-3.5 w-3.5" />
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Tags
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The tag list.
 *
 * `FieldBlock`, not `Field`: every tag is a `<button>` that removes it, and a `<label>` wrapped round a
 * button forwards stray clicks into it and folds its text into the input's accessible name (Field.tsx).
 *
 * A tag is committed on Enter or on a comma — the two things people actually type — and on blur, because
 * a half-typed tag left in the box when somebody moves on is a tag they believe they added. The cap is
 * stated before it is reached (contract §1.6).
 */
function TagEditor({
  tags,
  onChange,
  onAnnounce
}: {
  tags: readonly string[];
  onChange: (next: string[]) => void;
  onAnnounce: (message: string) => void;
}) {
  const [pending, setPending] = useState("");
  const atLimit = tags.length >= TAG_LIMIT;

  const commit = useCallback(
    (raw: string) => {
      const value = raw.trim().replace(/\s+/g, " ").slice(0, TAG_MAX_LENGTH);
      if (value.length === 0) {
        setPending("");
        return;
      }
      if (atLimit) {
        onAnnounce(`No more tags can be added. The limit is ${TAG_LIMIT}.`);
        return;
      }
      // Case-insensitive, because "Textiles" and "textiles" filter the public gallery as two different
      // things and nobody typing the second one means that.
      if (tags.some((tag) => tag.toLowerCase() === value.toLowerCase())) {
        onAnnounce(`${value} is already on this album.`);
        setPending("");
        return;
      }
      onChange([...tags, value]);
      onAnnounce(`${value} added. ${tags.length + 1} of ${TAG_LIMIT} tags.`);
      setPending("");
    },
    [atLimit, onAnnounce, onChange, tags]
  );

  return (
    <FieldBlock
      label="Tags"
      help="Words a visitor can filter the gallery by — “textiles”, “block printing”, “Rajasthan”. Press Enter after each one."
    >
      <div className="min-w-0">
        {tags.length > 0 ? (
          <ul className="mb-2 flex flex-wrap gap-1.5">
            {tags.map((tag, index) => (
              <li key={tag}>
                {/* The WHOLE chip removes the tag. A 12px × inside a chip is a target nobody hits on a
                    trackpad, and two controls per tag is twice the tab stops for one decision. */}
                <button
                  type="button"
                  onClick={() => {
                    onChange(tags.filter((_unused, position) => position !== index));
                    onAnnounce(`${tag} removed. ${tags.length - 1} tags left.`);
                  }}
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-purple-200 bg-purple-50 px-3 py-1 text-xs font-medium text-purple-700 transition hover:border-purple-300 hover:bg-purple-100"
                >
                  <TagIcon aria-hidden="true" className="h-3 w-3" />
                  {tag}
                  <X aria-hidden="true" className="h-3 w-3" />
                  <span className="sr-only"> — remove this tag</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <Input
          value={pending}
          onChange={(event) => {
            const raw = event.target.value;
            // A comma is how people separate a list they are pasting in, so it commits rather than
            // becoming part of a tag.
            if (raw.includes(",")) {
              for (const part of raw.split(",")) commit(part);
              return;
            }
            setPending(raw);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            // Otherwise Enter submits the surrounding form, which on this screen means saving an album
            // halfway through typing a tag.
            event.preventDefault();
            commit(pending);
          }}
          onBlur={() => commit(pending)}
          maxLength={TAG_MAX_LENGTH}
          placeholder={atLimit ? "" : "textiles"}
          disabled={atLimit}
        />

        <p className={cn("mt-1.5 text-xs tabular-nums", atLimit ? "text-amber-800" : "text-ink-500")}>
          You can add up to {TAG_LIMIT}; {tags.length} added.
          {atLimit ? " Remove one before adding another." : ""}
        </p>
      </div>
    </FieldBlock>
  );
}
