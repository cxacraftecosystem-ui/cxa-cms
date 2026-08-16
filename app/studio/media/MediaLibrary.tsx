"use client";

/**
 * MediaLibrary — the whole media screen: folders down the left, the grid in the middle, one file's
 * details down the right, the upload queue above them and the bulk bar above that.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ACCESSIBILITY BACKLOG IS THE MOST PROMINENT THING ON THE SCREEN. Every image on the public site
 * gets its `alt` from this table, and a library that cannot show you which pictures have no description
 * is a library where that list is never cleared. So the count is a banner, not a filter buried in a
 * dropdown, and it is a real number for the WHOLE library rather than for whatever is currently
 * filtered — `altBacklog` comes back with every page of results for exactly that reason.
 *
 * "NEEDS A DESCRIPTION" AND "MARKED DECORATIVE" ARE COUNTED SEPARATELY, because they are separate
 * statements: `altText` null means nobody has written one, and `altText` empty means somebody decided
 * the picture is decorative and screen readers should skip it. Both are shown so the two numbers
 * reconcile with the one on the dashboard, which counts them together.
 *
 * "NOT USED ANYWHERE" IS A SERVER-SIDE FILTER AND CANNOT BE ANYTHING ELSE. It needs counts across a
 * dozen relations — avatars, covers, galleries, page SEO images, craft photographs — and a browser
 * holding forty-eight rows cannot know whether the other four thousand use a file.
 *
 * THE FILTERS ARE REACT STATE, AND THE URL IS A MIRROR OF THEM — written with the browser's own
 * `history.replaceState`, NOT `router.replace`. This screen fetches over HTTP; a router navigation on
 * every keystroke would re-run the server component and its Prisma queries for data the browser is
 * already fetching, and it would tear down the grid, the selection and the open panel with it. The
 * mirror is what makes a filtered view a link somebody can send, which is the only thing the URL is
 * needed for here. (`FilterToolbar` makes the opposite trade, correctly, for screens whose list is
 * rendered on the server.)
 *
 * THE UPLOAD QUEUE IS ALWAYS MOUNTED, never behind a toggle. A batch is aborted when its component
 * unmounts, and a reader who collapses the panel to look at the grid must not thereby cancel their own
 * upload. It lives here, above everything, so opening the detail panel, the picker or the cropper
 * leaves it running.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `items === null` is LOADING and `[]` is EMPTY, and they are different screens throughout (contract
 * §9). The only motion is the bulk bar arriving and the brief flash on rows that have just changed —
 * whose static purple outline is the half of the signal a reduced-motion reader still gets.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  Accessibility,
  CircleCheck,
  ImageOff,
  Link2Off,
  ScanEye,
  SearchX,
  TriangleAlert
} from "lucide-react";

import { asApiClientError, patch } from "@/lib/client/fetcher";
import { uploadFiles } from "@/lib/client/upload";
import { useDebouncedValue, useResource } from "@/lib/client/useResource";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Pagination } from "@/components/ui/Pagination";
import { SearchInput } from "@/components/ui/SearchInput";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/ToastProvider";
import { BulkActions } from "@/components/studio/media/BulkActions";
import { FolderTree } from "@/components/studio/media/FolderTree";
import { ImageCropper } from "@/components/studio/media/ImageCropper";
import { MediaDetailPanel } from "@/components/studio/media/MediaDetailPanel";
import {
  DEFAULT_MEDIA_FILTERS,
  MEDIA_ENDPOINTS,
  MEDIA_KIND_LABELS,
  MEDIA_PAGE_SIZE,
  MediaGrid,
  NO_FOLDER,
  buildMediaListPath,
  mediaFiltersAreNarrowing,
  mediaFiltersToSearch,
  type MediaAltFilter,
  type MediaAssetDetail,
  type MediaFilters,
  type MediaFolderNode,
  type MediaFoldersResponse,
  type MediaKindName,
  type MediaListResponse,
  type MediaSelectMode,
  type MediaSortKey,
  type MediaTagsResponse,
  type StudioMediaAsset
} from "@/components/studio/media/MediaGrid";
import { UploadQueue } from "@/components/studio/media/UploadQueue";

/** One timer for the search box and every dropdown, so there is one race to reason about, not two. */
const DEBOUNCE_MS = 250;

/** How long a changed row keeps its outline. Longer and a permanent outline stops meaning anything. */
const FLASH_MS = 1200;

export interface MediaLibraryProps {
  /** Read from the URL by the server component, so a link with filters lands filtered. */
  initialFilters: MediaFilters;
  /**
   * The first page, rendered on the server. `null` when the URL carried filters — the browser then
   * fetches the filtered page and shows a loading state, which is honest, rather than painting the
   * unfiltered library for a moment first.
   */
  initialAssets: MediaListResponse | null;
  initialFolders: MediaFolderNode[];
  initialTags: MediaTagsResponse;
  /** False when object storage is not configured. Uploading and replacing then say so plainly. */
  storageReady: boolean;
  /**
   * How many days a file moved to the recycle bin can still be restored for — `MEDIA_PURGE_AFTER_DAYS`
   * as configured on this installation, read on the server because the browser cannot.
   *
   * It is handed down rather than fetched so that every confirmation on this screen can name the real
   * number BEFORE anybody agrees to anything. A component that wrote "30 days" into its own copy would
   * go on saying 30 the day an administrator sets it to 7.
   */
  recoveryDays: number;
  /** The configuration sentences from lib/env, or an empty list. Shown once, at the top. */
  configurationWarnings: readonly string[];
}

export function MediaLibrary({
  initialFilters,
  initialAssets,
  initialFolders,
  initialTags,
  storageReady,
  recoveryDays,
  configurationWarnings
}: MediaLibraryProps) {
  const pathname = usePathname();
  const confirm = useConfirm();
  const { toast } = useToast();

  const [filters, setFilters] = useState<MediaFilters>(initialFilters);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  /** The last row touched, which is the only honest anchor for a Shift-click range. */
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [panelDirty, setPanelDirty] = useState(false);
  const [flashIds, setFlashIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [cropping, setCropping] = useState<MediaAssetDetail | null>(null);

  const flashTimer = useRef<number | null>(null);

  // The COMPOSED PATH is what gets debounced, not the text box: typing and choosing a filter share one
  // timer, so they cannot interleave into a request that reflects neither (useResource.ts).
  const path = buildMediaListPath(filters);
  const debouncedPath = useDebouncedValue(path, DEBOUNCE_MS);

  const list = useResource<MediaListResponse>(debouncedPath, {
    ...(initialAssets ? { initialData: initialAssets } : {})
  });
  const folders = useResource<MediaFoldersResponse>(MEDIA_ENDPOINTS.folders, {
    initialData: { items: initialFolders }
  });
  const tags = useResource<MediaTagsResponse>(MEDIA_ENDPOINTS.tags, { initialData: initialTags });

  const assets = list.data?.items ?? null;
  const total = list.data?.total ?? 0;
  const backlog = list.data?.altBacklog ?? null;

  /**
   * Mirror the filters into the address bar.
   *
   * `history.replaceState` and not `router.replace` — see the header. `replaceState` rather than
   * `pushState` because each keystroke would otherwise be a history entry and Back would spell the
   * reader's search out backwards, one letter at a time.
   */
  const search = mediaFiltersToSearch(filters);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const next = `${pathname}${search}`;
    if (`${window.location.pathname}${window.location.search}` === next) return;
    window.history.replaceState(null, "", next);
  }, [pathname, search]);

  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    []
  );

  const flash = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return;
    setFlashIds(new Set(ids));
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => {
      flashTimer.current = null;
      setFlashIds(new Set<string>());
    }, FLASH_MS);
  }, []);

  /** Reset to page 1 whenever a filter changes: page 4 of one list is not page 4 of another. */
  const narrow = useCallback((partial: Partial<MediaFilters>) => {
    setFilters((current) => ({ ...current, ...partial, page: 1 }));
  }, []);

  const clearFilters = useCallback(() => {
    setFilters({ ...DEFAULT_MEDIA_FILTERS });
  }, []);

  // ── Selection ──────────────────────────────────────────────────────────────────────────────────

  const onSelect = useCallback(
    (id: string, mode: MediaSelectMode) => {
      const rows = assets ?? [];

      if (mode === "replace") {
        setSelectedIds(new Set([id]));
        setAnchorId(id);
        return;
      }

      if (mode === "range" && anchorId !== null) {
        const from = rows.findIndex((row) => row.id === anchorId);
        const to = rows.findIndex((row) => row.id === id);
        if (from !== -1 && to !== -1) {
          const [start, end] = from <= to ? [from, to] : [to, from];
          setSelectedIds((current) => {
            const next = new Set(current);
            for (const row of rows.slice(start, end + 1)) next.add(row.id);
            return next;
          });
          // The anchor deliberately does NOT move: a run of Shift-clicks from one anchor is how a
          // reader corrects the end of a range without starting again.
          return;
        }
      }

      setSelectedIds((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setAnchorId(id);
    },
    [assets, anchorId]
  );

  /**
   * Drop ids that are no longer on screen.
   *
   * Not about the count — the selected rows are derived from what is on screen — but about the set not
   * growing without bound as somebody pages through, and about a stale id not being silently
   * re-selected when a row reappears on a later page.
   */
  const rowIdsKey = (assets ?? []).map((row) => row.id).join("\n");
  useEffect(() => {
    const allowed = new Set(rowIdsKey.length > 0 ? rowIdsKey.split("\n") : []);
    setSelectedIds((current) => {
      if (current.size === 0) return current;
      const next = new Set<string>();
      current.forEach((id) => {
        if (allowed.has(id)) next.add(id);
      });
      return next.size === current.size ? current : next;
    });
  }, [rowIdsKey]);

  const selectedAssets = useMemo(
    () => (assets ?? []).filter((row) => selectedIds.has(row.id)),
    [assets, selectedIds]
  );

  const selectAllOnPage = () => {
    const rows = assets ?? [];
    setSelectedIds(new Set(rows.map((row) => row.id)));
    setAnchorId(rows[rows.length - 1]?.id ?? null);
  };

  // ── The detail panel ───────────────────────────────────────────────────────────────────────────

  /**
   * Open a file's details, asking first if the panel already open has unsaved changes.
   *
   * The click that got here has already moved the selection — the grid reports selection and opening as
   * one gesture, which is what makes a plain click feel like one action. Saying "stay" therefore leaves
   * the selection where the click put it and the panel where it was, which is the lesser of the two
   * surprises.
   */
  const openDetail = useCallback(
    async (id: string) => {
      if (activeId !== null && activeId !== id && panelDirty) {
        const leave = await confirm({
          title: "Leave the unsaved changes?",
          body: "The description, caption and credit you have typed for the file open on the right have not been saved yet. Opening another file discards them.",
          tone: "default",
          confirmLabel: "Discard and open the other file",
          cancelLabel: "Stay on this file"
        });
        if (!leave) return;
      }
      setActiveId(id);
    },
    [activeId, panelDirty, confirm]
  );

  const onAssetSaved = useCallback(
    (asset: StudioMediaAsset) => {
      // Written straight into the cached list rather than re-fetched: the grid must show the new
      // description immediately, and a full page re-read would also lose the reader's scroll position.
      list.setData((current) =>
        current
          ? { ...current, items: current.items.map((row) => (row.id === asset.id ? asset : row)) }
          : current
      );
      flash([asset.id]);
      // The backlog counts are computed server-side and have just moved, so they are re-read.
      void list.refresh();
    },
    [list, flash]
  );

  const onAssetDeleted = useCallback(
    (id: string) => {
      setActiveId((current) => (current === id ? null : current));
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      void list.refresh();
      void folders.refresh();
    },
    [list, folders]
  );

  const onUploaded = useCallback(
    (uploaded: StudioMediaAsset[]) => {
      flash(uploaded.map((asset) => asset.id));
      void list.refresh();
      void folders.refresh();
      const first = uploaded[0];
      // Straight into the panel of the first new file: the next job after uploading a photograph is
      // always writing its description, and this is the screen that decides whether that happens.
      if (first && uploaded.length === 1) setActiveId(first.id);
    },
    [flash, list, folders]
  );

  // ── The cropper ────────────────────────────────────────────────────────────────────────────────

  /**
   * Upload the crop as a NEW file and carry over the facts that still hold.
   *
   * The credit, copyright and tags belong to the photograph and are inherited. The DESCRIPTION IS NOT:
   * a crop shows something different from its source, and inheriting a sentence about the whole
   * photograph would put a confidently wrong description on the new one — which is worse than the empty
   * one it gets instead, because nothing then flags it as needing attention.
   */
  const onCropped = useCallback(
    async (file: File, output: { width: number; height: number }) => {
      const source = cropping;
      if (!source) return;

      try {
        const result = await uploadFiles([file], {
          ...(source.folderId ? { folderId: source.folderId } : {})
        });

        // ⚠ `failed` is read even though the promise resolved: a resolved promise is not a success
        // (lib/client/upload.ts). With one file it can only be one or the other, but the rule holds.
        const failure = result.failed[0];
        if (failure) {
          toast({
            title: "The cropped picture was not saved",
            description: `${failure.file} — ${failure.reason}`,
            tone: "error"
          });
          return;
        }

        const created = result.uploaded[0];
        if (!created) return;

        try {
          await patch<StudioMediaAsset>(MEDIA_ENDPOINTS.detail(created.id), {
            altText: null,
            caption: source.caption,
            credit: source.credit,
            copyright: source.copyright,
            tags: source.tags,
            folderId: source.folderId
          });
        } catch (thrown) {
          // The picture is safely in the library; only the inherited details failed. Said plainly
          // rather than swallowed, because the reader would otherwise wonder where the credit went.
          toast({
            title: "The cropped picture was added, but its credit was not copied across",
            description: asApiClientError(thrown).message,
            tone: "warn"
          });
        }

        flash([created.id]);
        setActiveId(created.id);
        void list.refresh();
        toast({
          title: `A new ${output.width} × ${output.height} picture was added`,
          description:
            "The original is untouched. The new picture needs a description of its own — it is open on the right.",
          tone: "success"
        });
      } catch (thrown) {
        // `uploadFiles` throws only when nothing landed at all, and its message already names the file
        // and the reason.
        toast({
          title: "The cropped picture could not be saved",
          description: thrown instanceof Error ? thrown.message : undefined,
          tone: "error"
        });
      }
    },
    [cropping, flash, list, toast]
  );

  // ── Derived copy ───────────────────────────────────────────────────────────────────────────────

  const narrowed = mediaFiltersAreNarrowing(filters);

  const kindOptions = (Object.keys(MEDIA_KIND_LABELS) as MediaKindName[]).map((value) => ({
    value,
    label: MEDIA_KIND_LABELS[value]
  }));

  const tagOptions = (tags.data?.items ?? []).map((entry) => ({
    value: entry.tag,
    label: `${entry.tag} (${entry.count})`
  }));

  const folderList = folders.data?.items ?? null;
  const folderLabel =
    filters.folder === "" || filters.folder === NO_FOLDER
      ? "no folder"
      : (folderList?.find((folder) => folder.id === filters.folder)?.path ?? "the chosen folder");

  const emptyState = narrowed ? (
    <EmptyState
      icon={SearchX}
      // This sits inside a section that owns an `<h2>`, so the empty state is an `<h3>`: heading
      // levels never skip and never duplicate a rank they should sit under (contract §11).
      headingLevel={3}
      title="Nothing matches these filters"
      description="Nothing in the library fits all of what you have asked for. That is a fact about the filters rather than about the library — clearing them shows everything again."
      action={
        <Button variant="secondary" onClick={clearFilters}>
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
          ? "Drag some photographs onto the area above, or use “Choose files”. Every original is kept exactly as you upload it."
          : "Files cannot be uploaded until the file store has been set up on this installation. An administrator can check Settings for what is missing."
      }
    />
  );

  return (
    <div className="space-y-5">
      {configurationWarnings.length > 0 ? (
        <div
          role="status"
          className="rounded-md border border-amber-800/25 bg-amber-100 px-3.5 py-3 text-amber-800"
        >
          <p className="flex items-start gap-1.5 text-sm font-semibold">
            <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Some things on this screen will not work until the setup is finished</span>
          </p>
          <ul className="mt-1.5 list-disc space-y-1 pl-6 text-xs leading-relaxed">
            {configurationWarnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ── The accessibility backlog, made impossible to miss ─────────────────────────────── */}
      {backlog !== null ? (
        backlog.missing > 0 ? (
          <div className="rounded-md border border-amber-800/25 bg-amber-100 px-3.5 py-3 text-amber-800">
            <p className="flex items-start gap-2 text-sm font-semibold">
              <Accessibility aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {backlog.missing === 1
                  ? "1 picture has no description"
                  : `${backlog.missing} pictures have no description`}
              </span>
            </p>
            <p className="mt-1 text-xs leading-relaxed">
              Somebody using a screen reader is told nothing at all where one of these appears. Each
              needs one plain sentence, or the “decorative” box ticked if it genuinely adds nothing.
              {backlog.decorative > 0
                ? ` ${
                    backlog.decorative === 1
                      ? "1 other picture is"
                      : `${backlog.decorative} other pictures are`
                  } already marked as decorative, which counts as done.`
                : ""}
            </p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={filters.alt === "missing" ? "primary" : "secondary"}
                onClick={() =>
                  narrow({ alt: filters.alt === "missing" ? "" : "missing", kind: "IMAGE" })
                }
              >
                {filters.alt === "missing" ? "Showing only these" : "Show me those pictures"}
              </Button>
              {backlog.decorative > 0 ? (
                <Button
                  size="sm"
                  variant={filters.alt === "decorative" ? "primary" : "secondary"}
                  icon={ScanEye}
                  onClick={() =>
                    narrow({ alt: filters.alt === "decorative" ? "" : "decorative", kind: "IMAGE" })
                  }
                >
                  {filters.alt === "decorative"
                    ? "Showing the decorative ones"
                    : `Marked decorative (${backlog.decorative})`}
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="flex items-start gap-2 rounded-md border border-success-600/25 bg-success-100 px-3.5 py-2.5 text-sm leading-relaxed text-success-600">
            <CircleCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Every picture in the library either has a description or is marked as decorative. That is
              the accessibility of every page that uses them looked after.
            </span>
          </p>
        )
      ) : null}

      {/* ── Filters ───────────────────────────────────────────────────────────────────────── */}
      <section aria-label="Filters" className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <SearchInput
            label="Search the library by file name, description, caption or tag"
            placeholder="Search files"
            value={filters.q}
            onValueChange={(value) => narrow({ q: value })}
            className="sm:min-w-[16rem] sm:flex-1"
          />

          {/* `Field` (a real `<label>`) is right for all of these: every control is a NATIVE
              `<select>`, so there is no button inside for a stray click to be forwarded to. */}
          <Field label="Type" className="sm:w-40">
            <Select
              value={filters.kind}
              placeholder="Any type"
              options={kindOptions}
              onChange={(event) => narrow({ kind: (event.target.value as MediaKindName | "") || "" })}
            />
          </Field>

          <Field label="Description" className="sm:w-52">
            <Select
              value={filters.alt}
              placeholder="Any"
              options={[
                { value: "missing", label: "Needs a description" },
                { value: "decorative", label: "Marked decorative" },
                { value: "described", label: "Has a description" }
              ]}
              onChange={(event) => narrow({ alt: (event.target.value as MediaAltFilter | "") || "" })}
            />
          </Field>

          <Field label="Tag" className="sm:w-44">
            <Select
              value={filters.tag}
              placeholder="Any tag"
              options={tagOptions}
              onChange={(event) => narrow({ tag: event.target.value })}
            />
          </Field>

          <Field label="Order" className="sm:w-48">
            <Select
              value={`${filters.sort}:${filters.dir}`}
              options={[
                { value: "created:desc", label: "Newest first" },
                { value: "created:asc", label: "Oldest first" },
                { value: "name:asc", label: "Name, A to Z" },
                { value: "name:desc", label: "Name, Z to A" },
                { value: "size:desc", label: "Largest first" },
                { value: "size:asc", label: "Smallest first" }
              ]}
              onChange={(event) => {
                const [sort, dir] = event.target.value.split(":");
                narrow({
                  sort: (sort as MediaSortKey) ?? "created",
                  dir: dir === "asc" ? "asc" : "desc"
                });
              }}
            />
          </Field>

          <Button
            variant={filters.unused ? "primary" : "secondary"}
            icon={Link2Off}
            onClick={() => narrow({ unused: !filters.unused })}
          >
            Not used anywhere
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {/* "Empty means everything", said out loud. Without this line the unfiltered state is an
              absence, and an absence is not something a reader can see. */}
          <p className="text-xs text-ink-500">
            {narrowed
              ? "Some filters are set, so this is not the whole library."
              : "No filters are set, so everything is listed."}
          </p>
          {narrowed ? (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              Clear all filters
            </Button>
          ) : null}
          {filters.unused ? (
            <p className="text-xs leading-relaxed text-ink-500">
              “Not used anywhere” is worked out on the server by checking every place a file can be
              referenced — covers, galleries, profiles, page images and craft photographs.
            </p>
          ) : null}
          {tags.data?.truncated ? (
            <p className="text-xs text-ink-500">
              The tag list above is only the most-used tags, not all of them. Search for a tag by name
              if it is not listed.
            </p>
          ) : null}
        </div>
      </section>

      {/* ── The three columns ─────────────────────────────────────────────────────────────── */}
      <div
        className={cn(
          "grid gap-5",
          "lg:grid-cols-[15rem_minmax(0,1fr)]",
          activeId !== null ? "xl:grid-cols-[15rem_minmax(0,1fr)_22rem]" : "xl:grid-cols-[15rem_minmax(0,1fr)]"
        )}
      >
        <aside className="min-w-0">
          <FolderTree
            folders={folderList}
            value={filters.folder}
            onChange={(value) => narrow({ folder: value })}
            // Always true on this screen: the page above calls `requireStudioCapability(canManageMedia)`
            // before rendering anything, so a reader who is here may manage the filing. It stays a prop
            // because the tree is also usable from a picker one day, where that may not hold.
            canEdit
            // Folders do not need object storage — they are rows, not bytes.
            onFoldersChanged={async () => {
              await folders.refresh();
              await list.refresh();
            }}
          />
        </aside>

        {/*
          A REAL `<h2>`, visually hidden. The folder panel beside this one renders an `<h2>`, so an
          `<h3>` inside here with nothing above it would read as nested under "Folders" — and the empty
          state in the grid renders its own heading at level 3. Heading levels never skip and never sit
          under the wrong parent (contract §11); a label attribute is not a heading.
        */}
        <section aria-labelledby="media-files-heading" className="min-w-0 space-y-4">
          <h2 id="media-files-heading" className="sr-only">
            Files
          </h2>

          <UploadQueue
            folderId={filters.folder !== "" && filters.folder !== NO_FOLDER ? filters.folder : null}
            folderLabel={folderLabel}
            storageReady={storageReady}
            recoveryDays={recoveryDays}
            onUploaded={onUploaded}
            // The same handler as the detail panel's delete: the row has gone to the recycle bin, so
            // the open panel closes if it was that file, the selection drops it, and the list and the
            // folder counts are re-read.
            onRemoved={onAssetDeleted}
            onUseExisting={(existing, discardedId) => {
              setActiveId(existing.id);
              flash([existing.id]);
              onAssetDeleted(discardedId);
            }}
          />

          <BulkActions
            selected={selectedAssets}
            rowsOnPage={(assets ?? []).length}
            totalRows={total}
            folders={folderList}
            recoveryDays={recoveryDays}
            onClearSelection={() => setSelectedIds(new Set<string>())}
            onFinished={({ changedIds, keepSelectedIds }) => {
              flash(changedIds);
              // Failed and unattempted rows STAY selected, so pressing the same button again retries
              // exactly those and leaves the ones that worked alone.
              setSelectedIds(new Set(keepSelectedIds));
              void list.refresh();
              void folders.refresh();
              if (changedIds.length > 0) {
                toast({
                  title:
                    changedIds.length === 1
                      ? "1 file was changed"
                      : `${changedIds.length} files were changed`,
                  tone: keepSelectedIds.length > 0 ? "warn" : "success"
                });
              }
            }}
          />

          {list.error ? (
            <p
              role="alert"
              className="flex items-start gap-1.5 rounded-md border border-error-200 bg-error-100 px-3 py-2.5 text-sm text-error-700"
            >
              <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{list.error.message}</span>
            </p>
          ) : null}

          {assets !== null && assets.length > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-ink-500">
                {selectedIds.size === 0
                  ? "Click a file to open it. Hold Shift for a run of files, or Ctrl (⌘ on a Mac) to pick them one at a time."
                  : selectedIds.size === 1
                    ? "1 file selected"
                    : `${selectedIds.size} files selected`}
              </p>
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" variant="ghost" onClick={selectAllOnPage}>
                  Select all {assets.length} on this page
                </Button>
                {selectedIds.size > 0 ? (
                  <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set<string>())}>
                    Clear selection
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          <MediaGrid
            assets={assets}
            label="Media library"
            selectedIds={selectedIds}
            onSelect={onSelect}
            activeId={activeId}
            onOpen={(id) => void openDetail(id)}
            flashIds={flashIds}
            emptyState={emptyState}
            capNote={
              list.data?.totalIsLowerBound
                ? "There are more files than the count shown — the library stops counting past a point so the screen stays quick. Narrow the search to see a complete count."
                : undefined
            }
          />

          {total > 0 ? (
            <Pagination
              page={filters.page}
              pageSize={list.data?.pageSize ?? MEDIA_PAGE_SIZE}
              totalItems={total}
              countIsLowerBound={list.data?.totalIsLowerBound ?? false}
              itemNoun={{ singular: "file", plural: "files" }}
              label="Media"
              onPageChange={(page) => setFilters((current) => ({ ...current, page }))}
            />
          ) : null}
        </section>

        {activeId !== null ? (
          <aside className="min-w-0">
            {/* Sticky only where there is room for a third column; below `xl` the panel simply sits
                under the grid, which is a better answer on a narrow screen than a modal that hides
                the file you are describing. */}
            <div className="xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)]">
              <MediaDetailPanel
                assetId={activeId}
                onClose={() => setActiveId(null)}
                folders={folderList}
                onSaved={onAssetSaved}
                onDeleted={onAssetDeleted}
                onCropRequest={(asset) => setCropping(asset)}
                onDirtyChange={setPanelDirty}
                storageReady={storageReady}
                className="max-h-full"
              />
            </div>
          </aside>
        ) : null}
      </div>

      <ImageCropper
        open={cropping !== null}
        asset={cropping}
        onClose={() => setCropping(null)}
        onCropped={onCropped}
      />
    </div>
  );
}
