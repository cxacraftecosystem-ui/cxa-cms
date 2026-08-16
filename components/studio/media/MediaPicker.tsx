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
import { ImageOff, SearchX, UploadCloud } from "lucide-react";

import { useDebouncedValue, useResource } from "@/lib/client/useResource";
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

  // A fresh dialog every time. Carrying the last search over would show somebody a filtered library
  // with no memory of why, and carrying a selection over would let a stale pick be confirmed.
  useEffect(() => {
    if (open) return;
    setFilters({ ...DEFAULT_MEDIA_FILTERS, kind: kind ?? "" });
    setChosen([]);
    setShowUpload(false);
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
    </Dialog>
  );
}
