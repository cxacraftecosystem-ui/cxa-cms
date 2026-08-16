"use client";

/**
 * MediaPicker — the dialog every other editor opens to choose a photograph, a video or a document.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT CAN UPLOAD FROM INSIDE ITSELF, AND THAT IS THE WHOLE REASON IT EXISTS AS A DIALOG. An author
 * halfway through writing an article who has to leave it, go to the media library, upload a
 * photograph, come back and find their place has lost the thread of what they were writing — and, if
 * the article was not saved first, the paragraph as well. The upload area is here, in the dialog, and
 * a file that lands is selected straight away.
 *
 * AND A FILE UPLOADED HERE CAN BE TAKEN BACK HERE. The upload area's own "Just added" list carries a
 * Remove on every row, which matters more in this dialog than it does in the library: an author who
 * picks the wrong photograph for the article they are writing has no reason to be sent to another
 * screen to undo the last five seconds, and being sent there is how the wrong photograph gets
 * published. Removing is the same soft delete as everywhere else — recycle bin, bytes intact — and the
 * file leaves the selection with it, so "Use this file" can never confirm a row that is no longer in
 * the library.
 *
 * A PICTURE CAN BE CROPPED FROM HERE, AT THE MOMENT IT IS CHOSEN — including one uploaded years ago.
 * The report this answers is "I am not allowed to crop a pre-uploaded image when I select it for
 * something": cropping had reached the upload queue (for a file landing now) and the media library's
 * detail panel (for somebody who went looking), but not this dialog — the one an editor actually
 * stands in when they attach a photograph to a page, a person, a project or a section. So the moment
 * somebody picks a picture, the list below the filters shows it in the shape the site will draw and
 * offers "Choose what is shown". It is the SAME dialog (`components/studio/ImageCropper`) and the SAME
 * five columns as everywhere else — see `saveCrop`.
 *
 * ⚠ THE CROP IS A PROPERTY OF THE FILE, NOT OF THIS PLACEMENT. There is one rectangle per `MediaAsset`
 * and nowhere to hang a second one, so cropping the photograph here reframes it on EVERY page already
 * using it — not merely on the article being written. That is a real consequence of a design that is
 * otherwise right (see the migration: four numbers fix the whole existing library at no cost), and an
 * editor who has never seen the media screen has no reason to expect it. So it is said in the section
 * below AND again inside the cropper, above the button that commits it — before, never after. A
 * per-placement crop would be a different feature: a rectangle on each pointing row, fifteen relations
 * wide, and it is not what this picker pretends to offer.
 *
 * ONE RECTANGLE, ONE RENDER PATH. What finally draws it is `components/ui/MediaImage.tsx`, and it
 * cannot read the crop until `cropFrameStyle` moves out of a `"use client"` module — the ⚠ written
 * beside that function. Nothing here changes when that happens; the columns this dialog writes are
 * already the ones it will read.
 *
 * IT IS NOT A PERMISSION BOUNDARY. Whatever renders this dialog has already checked that the reader
 * may manage media (`canManageMedia` from lib/permissions.ts), and the `/api/studio/media/*` handlers
 * check it again — which is the check that actually matters. A dialog is a courtesy, never a guard.
 *
 * THE FETCH IS SUSPENDED WHILE THE DIALOG IS SHUT. `useResource` takes `null` as "do not ask", so a
 * closed picker sitting in an editor's tree costs nothing. Opening it asks once.
 *
 * `kind` NARROWS BOTH HALVES. A picker asking for an image filters the list AND restricts what the
 * upload area will accept, so an author cannot upload a PDF into a slot that needs a photograph and
 * then wonder why the page has a hole in it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Crop, ImageOff, SearchX, TriangleAlert, UploadCloud } from "lucide-react";

import { asApiClientError, patch } from "@/lib/client/fetcher";
import { useDebouncedValue, useResource } from "@/lib/client/useResource";
import { mediaSrc } from "@/lib/media/url";
import {
  FULL_CROP,
  ImageCropper as FramingCropper,
  cropFrameStyle,
  storedCrop,
  type CropChoice,
  type CropRect
} from "@/components/studio/ImageCropper";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Pagination } from "@/components/ui/Pagination";
import { SearchInput } from "@/components/ui/SearchInput";
import { Select } from "@/components/ui/Select";
import {
  DEFAULT_MEDIA_FILTERS,
  MEDIA_ENDPOINTS,
  MEDIA_KIND_LABELS,
  MEDIA_PAGE_SIZE,
  MediaGrid,
  NO_FOLDER,
  buildMediaListPath,
  hasPicture,
  type MediaFilters,
  type MediaFoldersResponse,
  type MediaKindName,
  type MediaListResponse,
  type MediaSelectMode,
  type StudioMediaAsset
} from "./MediaGrid";
import { UploadQueue } from "./UploadQueue";

/** A dialog holds fewer tiles than a full screen, and scrolling a dialog is worse than paging it. */
const PICKER_PAGE_SIZE = 24;

/** One timer for the search box and every dropdown, so there is one race to reason about, not two. */
const DEBOUNCE_MS = 250;

/**
 * The true shape of the part that is kept, for a chosen row's thumbnail.
 *
 * The thumbnail is drawn in THIS ratio rather than in a square, so that what the reader sees is the
 * region they chose and nothing else: a 21:9 crop shown in a square box would be re-trimmed from the
 * middle by `object-cover` and would look like the crop had moved.
 *
 * ⚠ `crop ?? FULL_CROP` IS THE WHOLE-IMAGE CASE, and it is the ordinary one. A file uploaded before
 * the crop columns existed has five nulls, `storedCrop` reads that as null, and null means the whole
 * picture — the row's own natural ratio here, and no rectangle stored anywhere. It must never mean a
 * zero-size box: `1 / 0` is `Infinity`, which would collapse the thumbnail to nothing and would be
 * read as "cropping broke the old images".
 *
 * A file with no recorded dimensions falls back to a square. That happens for an asset whose metadata
 * was never read, and a square placeholder is a wrong-shaped box rather than a division by zero.
 */
function keptAspect(asset: StudioMediaAsset, crop: CropRect | null): number {
  const width = asset.width ?? 0;
  const height = asset.height ?? 0;
  if (width <= 0 || height <= 0) return 1;
  const rect = crop ?? FULL_CROP;
  return (rect.width * width) / (rect.height * height);
}

export interface MediaPickerProps {
  open: boolean;
  onClose: () => void;
  /** The chosen files, in the order they were picked. Called once, then the dialog closes. */
  onSelect: (assets: StudioMediaAsset[]) => void;
  /** Off by default: most slots take one file, and a picker that allows more invites a mistake. */
  multiple?: boolean;
  /** Restricts the list AND the upload area. Omit it to offer everything. */
  kind?: MediaKindName;
  /** False when object storage is not configured — the upload area then says so instead of failing. */
  storageReady?: boolean;
  /**
   * How many days a file moved to the recycle bin can still be restored for — `MEDIA_PURGE_AFTER_DAYS`
   * as configured on this installation.
   *
   * OPTIONAL, AND USUALLY ABSENT. Only a server component can read it, and this dialog is opened from a
   * dozen editors that have no reason to. Where it is missing the removal confirmation names the
   * recycle bin and says the period is stated there, rather than inventing a number — see
   * `UploadQueue.recoveryDays`. An editor whose page already reads it may pass it through.
   */
  recoveryDays?: number | null;
  /** Overrides the dialog title where the slot has a name: "Choose a cover photograph". */
  title?: string;
}

export function MediaPicker({
  open,
  onClose,
  onSelect,
  multiple = false,
  kind,
  storageReady = true,
  recoveryDays = null,
  title
}: MediaPickerProps) {
  const [filters, setFilters] = useState<MediaFilters>({
    ...DEFAULT_MEDIA_FILTERS,
    kind: kind ?? ""
  });
  /** Insertion-ordered, so "in the order they were picked" is a promise we can keep. */
  const [chosen, setChosen] = useState<StudioMediaAsset[]>([]);
  const [showUpload, setShowUpload] = useState(false);
  /** The id of the picture open in the cropper, or null when that dialog is shut. */
  const [cropping, setCropping] = useState<string | null>(null);
  /**
   * A crop that would not save, said in the section rather than in a toast: the reader has just spent
   * time positioning a rectangle and has to be told it did not stick at the moment they would
   * otherwise press "Use this file" believing the page will be framed the way they left it.
   */
  const [cropError, setCropError] = useState<string | null>(null);

  // A fresh dialog every time. Carrying the last search over would show somebody a filtered library
  // with no memory of why, and carrying a selection over would let a stale pick be confirmed.
  useEffect(() => {
    if (open) return;
    setFilters({ ...DEFAULT_MEDIA_FILTERS, kind: kind ?? "" });
    setChosen([]);
    setShowUpload(false);
    setCropping(null);
    setCropError(null);
  }, [open, kind]);

  // The COMPOSED PATH is debounced, not the text box: typing and choosing a filter then share one
  // timer, so they cannot interleave into a request that reflects neither (useResource.ts).
  const path = buildMediaListPath(filters, PICKER_PAGE_SIZE);
  const debouncedPath = useDebouncedValue(path, DEBOUNCE_MS);

  const list = useResource<MediaListResponse>(open ? debouncedPath : null);
  const folders = useResource<MediaFoldersResponse>(open ? MEDIA_ENDPOINTS.folders : null, {
    // Folders are a small, slow-moving table; a failure here must not stop somebody choosing a file.
    onError: () => undefined
  });

  const assets = list.data?.items ?? null;
  const total = list.data?.total ?? 0;

  const chosenIds = useMemo(() => new Set(chosen.map((asset) => asset.id)), [chosen]);

  const onSelectAsset = useCallback(
    (id: string, mode: MediaSelectMode) => {
      const rows = assets ?? [];
      const asset = rows.find((entry) => entry.id === id);
      if (!asset) return;

      if (!multiple) {
        setChosen([asset]);
        return;
      }

      if (mode === "range") {
        // A range needs an anchor, and the last thing picked is the only honest one.
        const last = chosen[chosen.length - 1];
        const from = last ? rows.findIndex((entry) => entry.id === last.id) : -1;
        const to = rows.findIndex((entry) => entry.id === id);
        if (from !== -1 && to !== -1) {
          const [start, end] = from <= to ? [from, to] : [to, from];
          const span = rows.slice(start, end + 1);
          setChosen((current) => {
            const known = new Set(current.map((entry) => entry.id));
            return [...current, ...span.filter((entry) => !known.has(entry.id))];
          });
          return;
        }
      }

      setChosen((current) =>
        current.some((entry) => entry.id === id)
          ? current.filter((entry) => entry.id !== id)
          : [...current, asset]
      );
    },
    [assets, chosen, multiple]
  );

  /** Only the chosen rows a crop means anything for. A PDF has no framing to choose. */
  const chosenPictures = chosen.filter((asset) => hasPicture(asset.kind));

  /**
   * The picture the cropper is open on, read out of `chosen` rather than held separately.
   *
   * One source of truth: `saveCrop` writes the patched row back into `chosen`, so reopening the same
   * picture reopens on the rectangle that was actually stored, and a row that leaves the selection
   * takes its open cropper with it rather than leaving a dialog editing something nobody has chosen.
   */
  const cropTarget = chosen.find((asset) => asset.id === cropping) ?? null;

  /**
   * Where the cropper reads its pixels from.
   *
   * Every row here is ALREADY UPLOADED, so this is a plain CDN address and never a `blob:` URL — the
   * upload queue's object-URL bookkeeping has nothing to do here. `mediaSrc` returns null where no
   * public base URL is configured or the derivatives do not exist yet, and the cropper says so in its
   * own words instead of opening onto an empty box.
   */
  const cropSrc = cropTarget ? mediaSrc(cropTarget, 1600) : null;

  /**
   * Store the chosen crop against the FILE.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * ⚠ THIS IS THE SAME PATH `MediaDetailPanel.saveFraming` AND `UploadQueue.saveCrop` TAKE — one
   * PATCH of five columns on the asset row. There is deliberately no second way to persist a crop and
   * no `/crop` route to call: a crop made here, in the library or on the upload queue has to be the
   * same crop, or an editor who framed a photograph in one screen would find it re-framed in another.
   *
   * ⚠ FIVE FIELDS, ALWAYS SENT TOGETHER, and `null` across all five is what "show the whole picture"
   * means — the API refuses every other combination, because four numbers out of five is not a
   * rectangle and the render side would have to guess at the missing one.
   *
   * ⚠ IT MUST NOT REJECT. The cropper calls this from `void apply()` and closes on the resolved
   * promise; a rejection there is an unhandled rejection with no message anywhere a reader can see it.
   *
   * IT RE-ENCODES NOTHING. Five numbers change on the row; the uploaded bytes, the derivatives and the
   * checksum are untouched — which is what makes this safe to offer on a photograph somebody else
   * uploaded two years ago, and why the reader can come back and choose differently for ever.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  const saveCrop = async (assetId: string, choice: CropChoice | null) => {
    setCropError(null);
    try {
      const updated = await patch<StudioMediaAsset>(MEDIA_ENDPOINTS.detail(assetId), {
        cropX: choice ? choice.rect.x : null,
        cropY: choice ? choice.rect.y : null,
        cropWidth: choice ? choice.rect.width : null,
        cropHeight: choice ? choice.rect.height : null,
        cropAspect: choice ? choice.aspectId : null
      });
      // The PATCHED row replaces the chosen one, so `onSelect` hands the caller the asset as the
      // database now has it. The server is the authority on what those five columns hold — it clamps
      // nothing, but it does refuse, and a refusal must not leave this dialog handing an editor a row
      // claiming a crop that was never stored.
      setChosen((current) => current.map((entry) => (entry.id === assetId ? updated : entry)));
      // And the list underneath, because the same file is sitting in the grid: without this, clicking
      // that tile again would put the pre-crop row back into the selection and the cropper would
      // reopen on the rectangle the editor has just replaced.
      void list.refresh();
    } catch (thrown) {
      setCropError(
        `That crop could not be saved, so the site will go on showing what it showed before. ${
          asApiClientError(thrown).message
        }`
      );
    }
  };

  const kindOptions = (
    Object.keys(MEDIA_KIND_LABELS) as MediaKindName[]
  ).map((value) => ({ value, label: MEDIA_KIND_LABELS[value] }));

  const folderOptions = (folders.data?.items ?? [])
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((folder) => ({ value: folder.id, label: folder.path }));

  const narrowed =
    filters.q.trim().length > 0 || filters.folder !== "" || (filters.kind !== "" && !kind);

  const confirmSelection = () => {
    if (chosen.length === 0) return;
    onSelect(chosen);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title ?? (multiple ? "Choose files" : "Choose a file")}
      description={
        multiple
          ? "Click to pick a file. Hold Shift for a run of them, or Ctrl (⌘ on a Mac) to add one at a time."
          : "Click a file to choose it."
      }
      size="lg"
      footer={
        <>
          <p className="mr-auto text-xs text-ink-500">
            {chosen.length === 0
              ? "Nothing chosen yet"
              : chosen.length === 1
                ? "1 file chosen"
                : `${chosen.length} files chosen`}
          </p>
          <button type="button" data-dialog-cancel onClick={onClose} className="field-button-secondary">
            Cancel
          </button>
          <Button disabled={chosen.length === 0} onClick={confirmSelection}>
            {chosen.length > 1 ? `Use these ${chosen.length} files` : "Use this file"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <SearchInput
          label="Search the library by file name, description or tag"
          placeholder="Search files"
          value={filters.q}
          onValueChange={(value) => setFilters((current) => ({ ...current, q: value, page: 1 }))}
          className="sm:min-w-[14rem] sm:flex-1"
        />

        {/* `Field` (a real `<label>`) is right here: these are NATIVE `<select>`s, so there is no
            button inside for a stray click to be forwarded to (Field.tsx). */}
        {kind ? null : (
          <Field label="Type" className="sm:w-44">
            <Select
              value={filters.kind}
              placeholder="Any type"
              options={kindOptions}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  kind: (event.target.value as MediaKindName | "") || "",
                  page: 1
                }))
              }
            />
          </Field>
        )}

        <Field label="Folder" className="sm:w-48">
          <Select
            value={filters.folder}
            placeholder="Every folder"
            options={folderOptions}
            onChange={(event) =>
              setFilters((current) => ({ ...current, folder: event.target.value, page: 1 }))
            }
          />
        </Field>

        {storageReady ? (
          <Button
            variant="secondary"
            icon={UploadCloud}
            onClick={() => setShowUpload((current) => !current)}
          >
            {showUpload ? "Hide the upload area" : "Add a file"}
          </Button>
        ) : null}
      </div>

      {kind ? (
        <p className="mt-2 text-xs text-ink-500">
          Only {MEDIA_KIND_LABELS[kind].toLowerCase()} files are shown, because that is what this slot
          needs.
        </p>
      ) : null}

      {showUpload ? (
        <div className="mt-3">
          <UploadQueue
            folderId={
              filters.folder.length > 0 && filters.folder !== NO_FOLDER ? filters.folder : null
            }
            folderLabel={
              filters.folder.length > 0 && filters.folder !== NO_FOLDER
                ? (folders.data?.items.find((folder) => folder.id === filters.folder)?.path ??
                  "the chosen folder")
                : "no folder"
            }
            storageReady={storageReady}
            recoveryDays={recoveryDays}
            {...(kind ? { kind } : {})}
            compact
            onUploaded={(uploaded) => {
              // Selected immediately: the reader uploaded it in order to use it, and making them find
              // it again in the grid is the step this dialog exists to remove.
              setChosen((current) => (multiple ? [...current, ...uploaded] : uploaded.slice(-1)));
              void list.refresh();
            }}
            // ⚠ THE REMOVED FILE HAS TO LEAVE THE SELECTION TOO. `onUploaded` above chose it the
            // instant it landed, which is the whole point of uploading from inside this dialog — so a
            // reader who uploads the wrong photograph and removes it would otherwise press "Use this
            // file" on a row that is now in the recycle bin, and the slot would be filled with a file
            // that no longer exists.
            onRemoved={(id) => {
              setChosen((current) => current.filter((entry) => entry.id !== id));
              void list.refresh();
            }}
            onUseExisting={(existing, discardedId) => {
              setChosen((current) => {
                // The discarded copy goes for the same reason: it was chosen on upload and has just
                // been soft-deleted in favour of the older, identical file. `existing` is filtered out
                // as well before being appended, so choosing the older copy twice — once from the grid
                // and once from this offer — cannot put it in the list twice.
                const withoutDiscarded = current.filter(
                  (entry) => entry.id !== discardedId && entry.id !== existing.id
                );
                return multiple ? [...withoutDiscarded, existing] : [existing];
              });
              void list.refresh();
            }}
          />
        </div>
      ) : null}

      {/*
        ── What has been chosen, and what the site will show of it ──────────────────────────────
        Above the grid, in the same place and the same idiom as the upload area's "Just added" list,
        because the two lists answer the same question — "what have I just put in this slot, and is it
        right?" — and because a control that appeared BELOW twenty-four tiles would be a control an
        editor who picked the first tile never scrolls to.
      */}
      {chosenPictures.length > 0 ? (
        <div className="mt-3 rounded-md border border-line-200 bg-surface-50 p-3">
          <p className="flex items-start gap-1.5 text-sm font-semibold text-ink-900">
            <Crop aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" />
            <span>
              {chosenPictures.length === 1
                ? "What the site will show of this picture"
                : `What the site will show of these ${chosenPictures.length} pictures`}
            </span>
          </p>
          <p className="mt-1 text-xs leading-relaxed text-ink-700">
            Where the site fits a picture into a frame of its own — a wide banner, a card, a square
            tile — it trims from the <span className="font-medium">middle</span> unless somebody says
            otherwise, and the middle is the wrong guess whenever the subject is not dead centre. You
            can choose here, before you use the file.
          </p>
          {/*
            ⚠ THE SENTENCE THIS FEATURE CANNOT SHIP WITHOUT. See the file header: there is one
            rectangle per file and none per placement, so this reframes the picture everywhere. It is
            said here, before the cropper is even opened, and again inside the cropper above the button
            that commits it — the `note` prop below.
          */}
          <p className="mt-1 text-xs leading-relaxed text-ink-700">
            What you choose is stored on the <span className="font-medium">file</span>, not on the
            place you are about to put it — so every other page already using this picture will show
            the new framing too.
          </p>

          <ul className="mt-2.5 space-y-1.5">
            {chosenPictures.map((asset) => {
              const crop = storedCrop(asset);
              const thumb = mediaSrc(asset, 320);
              const kept = crop ? Math.round(crop.width * crop.height * 100) : null;

              return (
                <li
                  key={asset.id}
                  className="flex flex-wrap items-center gap-2 rounded-md bg-card px-2.5 py-2"
                >
                  {thumb ? (
                    <span
                      // Inline, not a Tailwind class: an `aspect-[16/9]` assembled from stored data
                      // would be purged by the content scanner (contract §5).
                      style={{ aspectRatio: String(keptAspect(asset, crop)) }}
                      className="relative block w-14 shrink-0 overflow-hidden rounded-sm border border-line-200 bg-surface-100"
                    >
                      {/*
                        The stored rectangle drawn with the SAME nested-percentage geometry
                        `cropFrameStyle` hands the render side, so this is what a page will paint
                        rather than an illustration of it. `FULL_CROP` through the same function is
                        exactly "the whole picture", which is why an uncropped file needs no second
                        code path here.

                        A plain <img>: the source is a CDN address rather than a media row, nothing on
                        the page is laid out from it, and next/image would buy a second copy of bytes
                        the grid below has already loaded.

                        ⚠ IT DOES NOT MATCH THE TILE IN THE GRID BELOW, and that is not a fault here.
                        `components/ui/MediaImage.tsx` still draws every asset from the whole image —
                        it cannot call `cropFrameStyle` until that function moves out of a
                        `"use client"` module, which is the ⚠ written beside it. Until then this row is
                        the one showing what was chosen, and the tile shows the file. When the move
                        happens they agree and nothing here changes.
                      */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={thumb}
                        alt=""
                        aria-hidden="true"
                        style={cropFrameStyle(crop ?? FULL_CROP)}
                        className="max-w-none object-cover"
                      />
                    </span>
                  ) : null}

                  <span className="min-w-0 flex-1">
                    <span className="block break-all text-xs font-medium text-ink-900">
                      {asset.fileName}
                    </span>
                    <span className="mt-0.5 block text-xs text-ink-500">
                      {kept === null
                        ? "The whole picture is shown, trimmed from the middle to fit."
                        : `Keeping ${kept}% of the picture.`}
                    </span>
                  </span>

                  <Button
                    size="sm"
                    variant={crop ? "ghost" : "secondary"}
                    icon={Crop}
                    onClick={() => setCropping(asset.id)}
                  >
                    {crop ? "Change what is shown" : "Choose what is shown"}
                    {/*
                      Every row's button would otherwise carry the same four words, and a screen reader
                      listing the buttons in this dialog would read a run of identical names with
                      nothing to tell them apart. The file name goes into the accessible name and stays
                      out of the visible one, where it would wrap the button to three lines.
                    */}
                    <span className="sr-only"> of {asset.fileName}</span>
                  </Button>
                </li>
              );
            })}
          </ul>

          {cropError ? (
            <p
              role="alert"
              className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-error-600"
            >
              <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{cropError}</span>
            </p>
          ) : null}
        </div>
      ) : null}

      {list.error ? (
        <p role="alert" className="mt-3 text-sm text-error-600">
          {list.error.message}
        </p>
      ) : null}

      <div className="mt-3">
        <MediaGrid
          assets={assets}
          label="Files in the library"
          selectedIds={chosenIds}
          onSelect={onSelectAsset}
          skeletonTiles={8}
          emptyState={
            narrowed ? (
              <EmptyState
                icon={SearchX}
                // The dialog's own title is an h2, so a nested empty state must be an h3 —
                // heading levels never skip and never duplicate a rank they sit under (contract §11).
                headingLevel={3}
                title="Nothing matches what you have asked for"
                description="Try a shorter search, a different type, or look in every folder."
                action={
                  <Button
                    variant="secondary"
                    onClick={() =>
                      setFilters({ ...DEFAULT_MEDIA_FILTERS, kind: kind ?? "" })
                    }
                  >
                    Clear the filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={ImageOff}
                headingLevel={3}
                title="There is nothing in the library yet"
                description={
                  storageReady
                    ? "Add a file with the button above and it will be chosen for you straight away."
                    : "Files cannot be uploaded until the file store has been set up on this installation."
                }
              />
            )
          }
        />
      </div>

      {total > 0 ? (
        <Pagination
          className="mt-4"
          page={filters.page}
          pageSize={list.data?.pageSize ?? PICKER_PAGE_SIZE}
          totalItems={total}
          countIsLowerBound={list.data?.totalIsLowerBound ?? false}
          itemNoun={{ singular: "file", plural: "files" }}
          label="Files"
          onPageChange={(page) => setFilters((current) => ({ ...current, page }))}
        />
      ) : null}

      {/* The default page size is quoted so the two numbers in this dialog cannot drift apart. */}
      {total > PICKER_PAGE_SIZE ? (
        <p className="mt-2 text-xs leading-relaxed text-ink-500">
          {PICKER_PAGE_SIZE} files are shown at a time here, rather than the {MEDIA_PAGE_SIZE} the full
          library shows, so the dialog stays quick. Search or use the pages above to reach the rest.
        </p>
      ) : null}

      {/*
        One cropper for the whole list rather than one per row: it is a modal, only one can be open at
        a time, and mounting one per chosen picture would mount an <img> for each. A dialog opened from
        inside a dialog is a case `components/ui/Dialog.tsx` handles — it keeps a stack, so Escape
        closes the cropper and leaves the picker standing.
      */}
      <FramingCropper
        open={cropTarget !== null}
        onClose={() => setCropping(null)}
        src={cropSrc}
        fileName={cropTarget?.fileName ?? ""}
        // A picture cropped earlier — in the library, on upload, or here a moment ago — reopens ON its
        // stored rectangle. A file uploaded before the crop columns existed has none, `storedCrop`
        // answers null, and the dialog opens on the whole picture: the same degradation the render
        // side makes, and the reason the feature works on a library that predates it.
        initialRect={cropTarget ? storedCrop(cropTarget) : null}
        initialAspectId={cropTarget?.cropAspect ?? undefined}
        // The consequence, at the moment of committing it. This dialog cannot name the pages that will
        // change — the list endpoint counts no references, and only the media library's detail panel
        // does — so it says that plainly rather than inventing a number (contract §1.6).
        note={
          <>
            This is stored on the file, not on the place you are putting it. Every other page already
            using this picture will show the new framing too — the media library lists which ones.
          </>
        }
        onApply={(choice) => {
          const assetId = cropTarget?.id;
          if (!assetId) return;
          return saveCrop(assetId, choice);
        }}
      />
    </Dialog>
  );
}
