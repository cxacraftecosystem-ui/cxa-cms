"use client";

/**
 * FileManager — the whole document and dataset store: the list, the upload, and one file's details.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS FILE IS THE CLIENT HALF OF `app/studio/files/page.tsx`. It exists because uploading a dataset
 * cannot be done from a Server Component: the bytes go BROWSER → STORAGE directly, through a signed PUT,
 * and both a Server Action (1 MB body limit by default) and a plain form POST to the application (the
 * platform's request-body limit, a few megabytes) would refuse a corpus long before storage would.
 *
 * VERSIONS ARE THE POINT OF THIS SCREEN. Replacing a file does not overwrite it — it issues a new
 * `FileVersion` and leaves the old bytes reachable, so a citation of "v2 of the Bagru corpus" does not
 * silently start resolving to v3 (schema, `FileAsset`). The version list is therefore not a diagnostic
 * panel tucked away somewhere; it is on screen beside the file, newest first, with the size and date of
 * each one.
 *
 * ⚠ THE PUBLIC FLAG AND THE EXPIRY ARE ENFORCED ON THE SERVER, AT THE DOWNLOAD ROUTE, and this screen
 * says so beside both controls. `app/api/public/files/[slug]/route.ts` checks `isPublic` (answering 404
 * rather than 403, because a 403 confirms an embargoed file exists) and `expiresAt` (answering 410 with
 * the date). Nobody may read this screen and conclude that hiding a button is the control — the URL is
 * guessable from a slug that appears in the search index.
 *
 * `items === null` IS LOADING; `[]` IS "THERE IS NOTHING HERE". Different screens throughout
 * (contract §9) — "no files" during a fetch tells a researcher the corpus has vanished.
 *
 * THE FILTERS ARE REACT STATE MIRRORED INTO THE URL with the browser's own `history.replaceState`, not
 * `router.replace`: a router navigation on every keystroke would re-run the server component and its
 * Prisma queries for data this screen is already fetching, and it would tear down the upload in progress
 * with it. The mirror is what makes a filtered view a link somebody can send, which is all the URL is
 * needed for here. (`FilterToolbar` makes the opposite trade, correctly, for server-rendered lists.)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  CalendarClock,
  CircleCheck,
  Download,
  FileText,
  FileWarning,
  Globe,
  History,
  Lock,
  SearchX,
  TriangleAlert,
  Upload
} from "lucide-react";

import { asApiClientError, buildQuery, del, patch, post } from "@/lib/client/fetcher";
import {
  MAX_UPLOAD_BYTES
} from "@/lib/client/upload";
import { FILE_PRESIGN_PATH, uploadToFileStore } from "@/lib/client/fileUpload";
import { useDebouncedValue, useResource } from "@/lib/client/useResource";
import { cn, formatBytes } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { DateField } from "@/components/ui/DateField";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { FileDropzone } from "@/components/ui/FileDropzone";
import { Input } from "@/components/ui/Input";
import { Pagination } from "@/components/ui/Pagination";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { SearchInput } from "@/components/ui/SearchInput";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/ToastProvider";
import { DeleteButton } from "@/components/studio/DeleteButton";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";

/**
 * Every address this screen calls, in one place, so the route handlers have a single list to satisfy.
 *
 * `presign` answers the SAME shape as `/api/studio/media/presign` (documented in lib/client/upload.ts):
 * `{ uploadUrl, headers, objectKey }`. It is a separate address because the object key belongs in the
 * file store's own prefix rather than under the media library's, and because a file has no `MediaKind`.
 */
export const FILE_ENDPOINTS = {
  list: (query: string) => `/api/studio/files${query}`,
  create: "/api/studio/files",
  detail: (id: string) => `/api/studio/files/${encodeURIComponent(id)}`,
  versions: (id: string) => `/api/studio/files/${encodeURIComponent(id)}/versions`,
  preview: (id: string) => `/api/studio/files/${encodeURIComponent(id)}/preview`,
  presign: FILE_PRESIGN_PATH
} as const;

/** The public download address, which is also the URL a citation records. */
export function publicDownloadPath(slug: string): string {
  return `/api/public/files/${encodeURIComponent(slug)}`;
}

export const FILES_PAGE_SIZE = 25;

/** One timer for the search box and every dropdown, so there is one race to reason about, not two. */
const DEBOUNCE_MS = 250;

/** Anything is a document if somebody wants to download it. The size cap is what actually constrains. */
const FILE_ACCEPT: readonly string[] = ["*/*"];

export type FileVisibilityFilter = "public" | "private" | "expired";
export type FileSortKey = "updated" | "title" | "downloads" | "size";

export interface FileFilters {
  q: string;
  category: string;
  visibility: FileVisibilityFilter | "";
  sort: FileSortKey;
  dir: "asc" | "desc";
  page: number;
}

const DEFAULT_FILE_FILTERS: FileFilters = {
  q: "",
  category: "",
  visibility: "",
  sort: "updated",
  dir: "desc",
  page: 1
};

export interface FileVersionRow {
  id: string;
  version: number;
  fileName: string;
  mimeType: string;
  byteSize: number;
  checksum: string | null;
  notes: string | null;
  /** ISO 8601. JSON has no date type and the fetcher does not revive them. */
  createdAt: string;
  /**
   * The PDF rendition's state, as three fields with no fourth holding a summary of them.
   *
   * `previewByteSize` set means there IS one; `previewFailedReason` set means the last attempt failed;
   * `previewAttemptedAt` null means nobody has tried. The schema's own note explains why there is
   * deliberately no `previewState` column — a stored state is a value that has to be written correctly in
   * five places instead of read correctly in one.
   */
  previewByteSize: number | null;
  previewAttemptedAt: string | null;
  previewFailedReason: string | null;
}

export interface StudioFileRow {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  category: string | null;
  isPublic: boolean;
  /** ISO instant, or null for "no expiry". */
  expiresAt: string | null;
  downloadCount: number;
  createdAt: string;
  updatedAt: string;
  /** Highest version number. `null` for a catalogue entry whose upload never finished. */
  latestVersion: FileVersionRow | null;
  versionCount: number;
  uploader: { id: string; name: string } | null;
}

export interface StudioFileDetail extends StudioFileRow {
  /** Newest first. */
  versions: FileVersionRow[];
}

export interface FileListResponse {
  items: StudioFileRow[];
  total: number;
  page: number;
  pageSize: number;
}

function buildFileListPath(filters: FileFilters): string {
  return FILE_ENDPOINTS.list(
    buildQuery({
      q: filters.q.trim(),
      category: filters.category,
      visibility: filters.visibility,
      sort: filters.sort,
      dir: filters.dir,
      page: filters.page > 1 ? filters.page : undefined,
      pageSize: FILES_PAGE_SIZE
    })
  );
}

function filtersAreDefault(filters: FileFilters): boolean {
  return (
    filters.q.trim().length === 0 &&
    filters.category.length === 0 &&
    filters.visibility.length === 0 &&
    filters.sort === DEFAULT_FILE_FILTERS.sort &&
    filters.dir === DEFAULT_FILE_FILTERS.dir
  );
}

/**
 * Read the filters out of the address bar.
 *
 * ⚠ DONE HERE, IN THE BROWSER, AND NOT HANDED DOWN BY THE SERVER PAGE. Every export of a `"use client"`
 * module is a CLIENT REFERENCE, so a Server Component that imported this function would be calling a
 * client function from the server — which fails at runtime (the trap MediaGrid.tsx sets out). Duplicating
 * the parser in the page instead would give the screen two opinions about what `?sort=` means and one
 * more constant to keep in step with `FILES_PAGE_SIZE`, so the whole job stays on this side of the
 * boundary and the page hands down nothing but facts it alone can know.
 */
function readFilters(params: { get: (name: string) => string | null }): FileFilters {
  const visibility = params.get("visibility") ?? "";
  const sort = params.get("sort") ?? "";
  const page = Number.parseInt(params.get("page") ?? "", 10);

  return {
    q: params.get("q") ?? "",
    category: params.get("category") ?? "",
    visibility:
      visibility === "public" || visibility === "private" || visibility === "expired" ? visibility : "",
    sort:
      sort === "title" || sort === "downloads" || sort === "size" || sort === "updated"
        ? sort
        : DEFAULT_FILE_FILTERS.sort,
    dir: params.get("dir") === "asc" ? "asc" : "desc",
    page: Number.isFinite(page) && page > 0 ? page : 1
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A date and time in a NAMED zone, so the server's HTML and the browser's hydration cannot disagree. */
function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC"
  })} UTC`;
}

/** `YYYY-MM-DD` for the `DateField`, from an ISO instant. Sliced from the UTC string — the column is a day. */
function toDateInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function hasExpired(file: StudioFileRow, now: number): boolean {
  if (!file.expiresAt) return false;
  const at = new Date(file.expiresAt).getTime();
  return Number.isFinite(at) && at <= now;
}

/** A filename without its extension, title-cased enough to be a starting point somebody will edit. */
function titleFromFileName(name: string): string {
  const stem = name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  if (stem.length === 0) return name;
  return `${stem.charAt(0).toUpperCase()}${stem.slice(1)}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The screen
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface FileManagerProps {
  /** Categories already in use, for the filter and the datalist. Only the server can know these. */
  categories: readonly string[];
  /** True when the category list above was capped. Said on screen (contract §1.6). */
  categoriesTruncated: boolean;
  /** False when object storage is not configured. Uploading and replacing then say so plainly. */
  storageReady: boolean;
}

export function FileManager({ categories, categoriesTruncated, storageReady }: FileManagerProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { toast } = useToast();

  /**
   * The address bar seeds the state ONCE and is a mirror thereafter.
   *
   * A lazy initialiser, not a value: reading `searchParams` on every render and feeding it back into
   * state would fight the `replaceState` mirror below and the filters would never settle. A link with
   * `?visibility=expired&file=…` therefore lands filtered, with that file open, and from then on this
   * component owns the state.
   */
  const [filters, setFilters] = useState<FileFilters>(() => readFilters(searchParams));
  const [activeId, setActiveId] = useState<string | null>(() => searchParams.get("file"));
  const [uploading, setUploading] = useState<{ name: string; fraction: number } | null>(null);

  /**
   * `now` is read once, after mount.
   *
   * "Has this expired?" depends on the clock, and the server rendering the first HTML has a different one
   * from the reader's browser — printing the answer during SSR is a hydration mismatch React resolves by
   * keeping whichever it likes. Until this lands, an expiry is shown as a date and nothing more.
   */
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
  }, []);

  // The COMPOSED PATH is debounced, not the text box: typing and choosing a filter share one timer, so
  // they cannot interleave into a request that reflects neither (useResource.ts).
  const path = buildFileListPath(filters);
  const debouncedPath = useDebouncedValue(path, DEBOUNCE_MS);

  const list = useResource<FileListResponse>(debouncedPath);

  const files = list.data?.items ?? null;
  const total = list.data?.total ?? 0;

  // Mirror the filters into the address bar. `replaceState` rather than `pushState` because each
  // keystroke would otherwise be a history entry and Back would spell the search out backwards.
  const search = useMemo(() => {
    const params = new URLSearchParams();
    if (filters.q.trim().length > 0) params.set("q", filters.q.trim());
    if (filters.category.length > 0) params.set("category", filters.category);
    if (filters.visibility.length > 0) params.set("visibility", filters.visibility);
    if (filters.sort !== DEFAULT_FILE_FILTERS.sort) params.set("sort", filters.sort);
    if (filters.dir !== DEFAULT_FILE_FILTERS.dir) params.set("dir", filters.dir);
    if (filters.page > 1) params.set("page", String(filters.page));
    if (activeId !== null) params.set("file", activeId);
    const query = params.toString();
    return query.length > 0 ? `?${query}` : "";
  }, [filters, activeId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const next = `${pathname}${search}`;
    if (`${window.location.pathname}${window.location.search}` === next) return;
    window.history.replaceState(null, "", next);
  }, [pathname, search]);

  /** Reset to page 1 whenever a filter changes: page 4 of one list is not page 4 of another. */
  const narrow = useCallback((partial: Partial<FileFilters>) => {
    setFilters((current) => ({ ...current, ...partial, page: 1 }));
  }, []);

  const detail = useResource<StudioFileDetail>(
    activeId === null ? null : FILE_ENDPOINTS.detail(activeId)
  );

  // ── Adding a file ────────────────────────────────────────────────────────────────────────────

  const addFile = useCallback(
    async (chosen: File[]) => {
      const file = chosen[0];
      if (!file) return;

      setUploading({ name: file.name, fraction: 0 });
      try {
        const object = await uploadToFileStore(file, (fraction) =>
          setUploading({ name: file.name, fraction })
        );

        const created = await post<StudioFileDetail>(FILE_ENDPOINTS.create, {
          // A starting point, not a guess anybody has to keep: the panel opens on it straight away so
          // the next thing the reader does is give it a proper title.
          title: titleFromFileName(file.name),
          ...object
        });

        setActiveId(created.id);
        await list.refresh();
        toast({
          tone: "success",
          title: `${created.title} has been added`,
          description:
            "It is private until you tick “Available to the public”. Give it a proper title and description on the right."
        });
      } catch (thrown) {
        // The server's `message` is already a plain sentence (lib/api.ts guarantees it), so it is shown
        // verbatim rather than reworded into something less specific.
        const message =
          thrown instanceof Error && thrown.name !== "ApiClientError"
            ? thrown.message
            : asApiClientError(thrown).message;
        toast({ tone: "error", title: `${file.name} was not added`, description: message });
      } finally {
        setUploading(null);
      }
    },
    [list, toast]
  );

  const narrowed = !filtersAreDefault(filters);

  const categoryOptions = categories.map((value) => ({ value, label: value }));

  return (
    <div className="space-y-5">
      {!storageReady ? (
        <HelpText tone="warn">
          The file store is not set up on this installation, so nothing can be uploaded or replaced.
          Everything already here can still be renamed, described and taken off the public site. An
          administrator can see exactly what is missing in Settings → Diagnostics.
        </HelpText>
      ) : null}

      {/* ── Filters ───────────────────────────────────────────────────────────────────────── */}
      <section aria-label="Filters" className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <SearchInput
            label="Search files by title, description or file name"
            placeholder="Search files"
            value={filters.q}
            onValueChange={(value) => narrow({ q: value })}
            className="sm:min-w-[16rem] sm:flex-1"
          />

          {/* `Field` (a real `<label>`) is right for all three: every control is a NATIVE `<select>`,
              so there is no button inside for a stray click to be forwarded to (Field.tsx). */}
          <Field label="Category" className="sm:w-44">
            <Select
              value={filters.category}
              placeholder="Any category"
              options={categoryOptions}
              onChange={(event) => narrow({ category: event.target.value })}
            />
          </Field>

          <Field label="Who can download it" className="sm:w-52">
            <Select
              value={filters.visibility}
              placeholder="Anyone or nobody"
              options={[
                { value: "public", label: "Anyone (public)" },
                { value: "private", label: "Only the studio" },
                { value: "expired", label: "Link has expired" }
              ]}
              onChange={(event) =>
                narrow({ visibility: (event.target.value as FileVisibilityFilter | "") || "" })
              }
            />
          </Field>

          <Field label="Order" className="sm:w-48">
            <Select
              value={`${filters.sort}:${filters.dir}`}
              options={[
                { value: "updated:desc", label: "Recently changed" },
                { value: "downloads:desc", label: "Most downloaded" },
                { value: "size:desc", label: "Largest first" },
                { value: "title:asc", label: "Title, A to Z" }
              ]}
              onChange={(event) => {
                const [sort, dir] = event.target.value.split(":");
                narrow({
                  sort: (sort as FileSortKey) ?? "updated",
                  dir: dir === "asc" ? "asc" : "desc"
                });
              }}
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {/* "Empty means everything", said out loud. Without this line the unfiltered state is an
              absence, and an absence is not something a reader can see. */}
          <p className="text-xs text-ink-500">
            {narrowed
              ? "Some filters are set, so this is not everything in the store."
              : "No filters are set, so everything is listed."}
          </p>
          {narrowed ? (
            <Button size="sm" variant="ghost" onClick={() => setFilters({ ...DEFAULT_FILE_FILTERS })}>
              Clear all filters
            </Button>
          ) : null}
          {categoriesTruncated ? (
            <p className="text-xs leading-relaxed text-ink-500">
              The category list is only the most recently used ones, not all of them. Search for a file by
              name if its category is not offered.
            </p>
          ) : null}
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <section aria-labelledby="files-heading" className="min-w-0 space-y-4">
          {/* A real heading, visually hidden: the panel beside this one renders an `<h2>`, and the empty
              state below renders its own at level 3. Heading levels never skip and never sit under the
              wrong parent (contract §11); a label attribute is not a heading. */}
          <h2 id="files-heading" className="sr-only">
            Files
          </h2>

          {storageReady ? (
            uploading !== null ? (
              <div className="rounded-lg border border-line-200 bg-card px-4 py-4">
                <ProgressBar
                  // Determinate wherever the browser reports bytes; the fraction is per file, and there
                  // is only ever one at a time here on purpose — a dataset upload should have the whole
                  // uplink to itself.
                  value={Math.round(uploading.fraction * 100)}
                  label={`Uploading ${uploading.name}`}
                  hint="The file goes straight to the file store — it does not pass through this site, so leaving this page cancels it."
                />
              </div>
            ) : (
              <FileDropzone
                onFiles={(chosen) => void addFile(chosen)}
                accept={FILE_ACCEPT}
                acceptSummary="Any document, dataset, slide deck or archive"
                maxBytes={MAX_UPLOAD_BYTES}
                multiple={false}
                title="Add a file"
              />
            )
          ) : null}

          {list.error ? (
            <p
              role="alert"
              className="flex items-start gap-1.5 rounded-md border border-error-200 bg-error-100 px-3 py-2.5 text-sm text-error-700"
            >
              <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{list.error.message}</span>
            </p>
          ) : null}

          {files === null ? (
            // Loading, not empty. The two are different screens (contract §9).
            <div className="space-y-2 rounded-md border border-line-200 bg-card p-4">
              <span role="status" className="sr-only">
                Loading files…
              </span>
              <div aria-hidden="true" className="space-y-2">
                {[0, 1, 2, 3, 4].map((row) => (
                  <div key={row} className="skeleton h-9 w-full" />
                ))}
              </div>
            </div>
          ) : files.length === 0 ? (
            narrowed ? (
              <EmptyState
                icon={SearchX}
                headingLevel={3}
                title="No files match these filters"
                description="Nothing fits all of what you have asked for. That is a fact about the filters rather than about the store — clear them to see everything again."
                action={
                  <Button variant="secondary" onClick={() => setFilters({ ...DEFAULT_FILE_FILTERS })}>
                    Clear the filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={FileText}
                headingLevel={3}
                title="There are no files yet"
                description={
                  storageReady
                    ? "This is where documents, datasets, slide decks and archives live — anything people download rather than read on the page. Drop the first one on the area above."
                    : "Files cannot be uploaded until the file store has been set up on this installation."
                }
              />
            )
          ) : (
            <>
              <div className="overflow-x-auto rounded-md border border-line-200 bg-card">
                <table aria-label="Files" className="w-full border-collapse text-sm">
                  <thead>
                    <tr>
                      <th scope="col" className={HEADING_CLASS}>
                        File
                      </th>
                      <th scope="col" className={cn(HEADING_CLASS, "hidden md:table-cell")}>
                        Who can download it
                      </th>
                      <th scope="col" className={cn(HEADING_CLASS, "text-right")}>
                        Downloads
                      </th>
                      <th scope="col" className={cn(HEADING_CLASS, "hidden lg:table-cell text-right")}>
                        Version
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {files.map((file) => {
                      const expired = now !== null && hasExpired(file, now);
                      return (
                        <tr
                          key={file.id}
                          className={cn(
                            "group border-b border-line-200 transition-colors last:border-b-0 hover:bg-surface-50",
                            file.id === activeId && "bg-purple-50"
                          )}
                        >
                          <td className="min-w-0 px-3 py-2.5 align-middle">
                            {/*
                              ONE control in the row opens the file, and it is a `<button>` because it
                              opens a panel on this screen rather than going anywhere. The row gets a
                              hover fill so it still reads as one target — a row wrapped in a link
                              fights every control inside it.
                            */}
                            <button
                              type="button"
                              onClick={() => setActiveId(file.id)}
                              aria-pressed={file.id === activeId}
                              className="block min-w-0 rounded text-left font-medium text-ink-900 underline-offset-4 transition-colors hover:text-purple-700 hover:underline group-hover:text-purple-700"
                            >
                              {file.title}
                            </button>
                            <span className="mt-0.5 block truncate text-xs text-ink-500">
                              {file.latestVersion
                                ? `${file.latestVersion.fileName} · ${formatBytes(file.latestVersion.byteSize)}`
                                : "No file has been uploaded against this entry yet"}
                              {file.category ? ` · ${file.category}` : ""}
                            </span>
                          </td>

                          <td className="hidden px-3 py-2.5 align-middle md:table-cell">
                            {/* Icon AND word, never colour alone (contract §11). */}
                            {expired ? (
                              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-800">
                                <CalendarClock aria-hidden="true" className="h-3.5 w-3.5" />
                                Link has expired
                              </span>
                            ) : file.isPublic ? (
                              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-600">
                                <Globe aria-hidden="true" className="h-3.5 w-3.5" />
                                Anyone
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-500">
                                <Lock aria-hidden="true" className="h-3.5 w-3.5" />
                                Only the studio
                              </span>
                            )}
                          </td>

                          <td className="px-3 py-2.5 text-right align-middle tabular-nums text-ink-700">
                            {file.downloadCount}
                          </td>

                          <td className="hidden px-3 py-2.5 text-right align-middle tabular-nums text-ink-700 lg:table-cell">
                            {file.latestVersion ? (
                              <>
                                v{file.latestVersion.version}
                                {file.versionCount > 1 ? (
                                  <span className="ml-1 text-xs text-ink-500">
                                    of {file.versionCount}
                                  </span>
                                ) : null}
                              </>
                            ) : (
                              <span className="text-ink-300">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <Pagination
                page={filters.page}
                pageSize={list.data?.pageSize ?? FILES_PAGE_SIZE}
                totalItems={total}
                itemNoun={{ singular: "file", plural: "files" }}
                label="Files"
                onPageChange={(page) => setFilters((current) => ({ ...current, page }))}
              />
            </>
          )}
        </section>

        {/* ── One file ─────────────────────────────────────────────────────────────────────── */}
        <aside className="min-w-0">
          <div className="xl:sticky xl:top-4">
            {activeId === null ? (
              <FormSection
                title="One file at a time"
                description="Choose a file on the left to change its title, decide who may download it, and see every version of it."
              >
                <p className="text-sm text-ink-500">Nothing is selected.</p>
              </FormSection>
            ) : detail.error !== null ? (
              <FormSection title="This file could not be opened">
                <HelpText tone="error">{detail.error.message}</HelpText>
              </FormSection>
            ) : detail.data === null ? (
              <FormSection title="Opening the file…">
                <span role="status" className="sr-only">
                  Loading this file&rsquo;s details…
                </span>
                <div aria-hidden="true" className="space-y-2">
                  <div className="skeleton h-4 w-2/3" />
                  <div className="skeleton h-9 w-full" />
                  <div className="skeleton h-9 w-full" />
                </div>
              </FormSection>
            ) : (
              <FileDetailPanel
                key={detail.data.id}
                file={detail.data}
                categories={categories}
                storageReady={storageReady}
                now={now}
                onSaved={() => {
                  void detail.refresh();
                  void list.refresh();
                }}
                onDeleted={() => {
                  setActiveId(null);
                  void list.refresh();
                }}
                onClose={() => setActiveId(null)}
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

const HEADING_CLASS =
  "border-b border-line-200 bg-surface-50 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-500";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// One file's details
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface FileDetailPanelProps {
  file: StudioFileDetail;
  categories: readonly string[];
  storageReady: boolean;
  now: number | null;
  onSaved: () => void;
  onDeleted: () => void;
  onClose: () => void;
}

/**
 * The one-file panel.
 *
 * EXPLICIT SAVE, NOT AUTOSAVE, and "Available to the public" is a CHECKBOX rather than a `Switch` for the
 * same reason: a switch means "this takes effect now" (Switch.tsx), and putting an embargoed dataset on
 * the public web is not something that should happen because somebody's finger slipped while reading. The
 * whole panel is one form and nothing changes until Save.
 *
 * REMOUNTED PER FILE by a `key` on the caller, so the draft state cannot carry one file's title onto
 * another. Deriving the state in an effect instead would leave a window where the fields show the
 * previous file — and a Save pressed in that window writes the wrong values.
 */
function FileDetailPanel({
  file,
  categories,
  storageReady,
  now,
  onSaved,
  onDeleted,
  onClose
}: FileDetailPanelProps) {
  const { toast } = useToast();

  const [title, setTitle] = useState(file.title);
  const [description, setDescription] = useState(file.description ?? "");
  const [category, setCategory] = useState(file.category ?? "");
  const [isPublic, setIsPublic] = useState(file.isPublic);
  const [expiresOn, setExpiresOn] = useState(() => toDateInput(file.expiresAt));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const [versionNotes, setVersionNotes] = useState("");
  const [replacing, setReplacing] = useState<{ name: string; fraction: number } | null>(null);

  const expired = now !== null && hasExpired(file, now);
  const trimmedTitle = title.trim();

  const dirty =
    trimmedTitle !== file.title ||
    description.trim() !== (file.description ?? "").trim() ||
    category.trim() !== (file.category ?? "").trim() ||
    isPublic !== file.isPublic ||
    expiresOn !== toDateInput(file.expiresAt);

  const save = useCallback(async () => {
    if (trimmedTitle.length === 0) {
      setProblem("A file needs a title. It is what people see in the list of downloads.");
      return;
    }
    setProblem(null);
    setSaving(true);
    try {
      await patch(FILE_ENDPOINTS.detail(file.id), {
        title: trimmedTitle,
        description: description.trim(),
        category: category.trim(),
        isPublic,
        /**
         * An empty box is `null`, never today's date and never the empty string. A nullable `DateTime`
         * column cannot take `""`, and a date parsed from an empty string is Invalid Date — which
         * Prisma would refuse with a message about a value the reader never typed.
         *
         * `T23:59:59Z` rather than midnight: an editor who types the 30th means "still available ON the
         * 30th", and midnight on the 30th would take it away as the 29th ends.
         */
        expiresAt: expiresOn.trim().length > 0 ? `${expiresOn}T23:59:59.000Z` : null
      });
      onSaved();
      toast({ tone: "success", title: `${trimmedTitle} has been saved` });
    } catch (thrown) {
      const failure = asApiClientError(thrown);
      setProblem(failure.message);
    } finally {
      setSaving(false);
    }
  }, [category, description, expiresOn, file.id, isPublic, onSaved, toast, trimmedTitle]);

  /**
   * Ask for a PDF rendition of the latest version.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * ⚠ MANUAL, NOT AUTOMATIC ON UPLOAD, and the reason is cost rather than difficulty. A conversion spends
   * a paid quota entry at a third party. Most of what this library holds is a dataset or a corpus nobody
   * will ever frame on a page, so converting everything on the way in would spend the allowance on
   * documents no reader looks at — and it would do so for an author uploading, when the decision belongs
   * to whoever publishes the page. So it is a press, next to the sentence saying what a reader currently
   * gets.
   *
   * ⚠ THE ROUTE ANSWERS 200 FOR "no preview was made", so a refusal is read out of the BODY rather than
   * caught. `made: false` covers the honest non-failures — already a PDF, a format the converter does not
   * take, no converter configured — and each carries its own sentence. Treating those as errors would put
   * a red banner in front of an editor whose file simply needs no conversion.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  const [previewing, setPreviewing] = useState(false);

  /** The version every public route serves. `versions` arrives newest-first. */
  const latest = file.versions[0] ?? null;
  const latestIsPdf = latest?.mimeType.toLowerCase() === "application/pdf";

  const makePreview = useCallback(async () => {
    setPreviewing(true);
    try {
      const answer = await post<{ made?: boolean; message?: string }>(
        FILE_ENDPOINTS.preview(file.id),
        {}
      );
      onSaved();
      toast({
        tone: answer.made ? "success" : "info",
        title: answer.made ? "A PDF preview has been made" : "No preview was made",
        description: answer.message
      });
    } catch (thrown) {
      toast({
        tone: "error",
        title: "The preview could not be made",
        description: asApiClientError(thrown).message
      });
    } finally {
      setPreviewing(false);
    }
  }, [file.id, onSaved, toast]);

  const replace = useCallback(
    async (chosen: File[]) => {
      const upload = chosen[0];
      if (!upload) return;

      setReplacing({ name: upload.name, fraction: 0 });
      try {
        const object = await uploadToFileStore(upload, (fraction) =>
          setReplacing({ name: upload.name, fraction })
        );
        await post(FILE_ENDPOINTS.versions(file.id), {
          ...object,
          notes: versionNotes.trim().length > 0 ? versionNotes.trim() : null
        });
        setVersionNotes("");
        onSaved();
        toast({
          tone: "success",
          title: `A new version of ${file.title} has been added`,
          description:
            "The earlier versions are untouched and can still be downloaded, so an existing citation keeps resolving to the version it named."
        });
      } catch (thrown) {
        const message =
          thrown instanceof Error && thrown.name !== "ApiClientError"
            ? thrown.message
            : asApiClientError(thrown).message;
        toast({ tone: "error", title: "The new version was not added", description: message });
      } finally {
        setReplacing(null);
      }
    },
    [file.id, file.title, onSaved, toast, versionNotes]
  );

  return (
    <div className="space-y-6">
      <FormSection
        title="This file"
        description="What it is called, who may download it, and until when."
        actions={
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        }
        footer={
          <>
            <p className="mr-auto text-xs text-ink-500">
              {dirty ? "Unsaved changes" : "Everything here is saved"}
            </p>
            <Button onClick={() => void save()} isLoading={saving} loadingLabel="saving" disabled={!dirty}>
              Save
            </Button>
          </>
        }
      >
        {problem ? (
          <p role="alert" className="text-sm text-error-600">
            {problem}
          </p>
        ) : null}

        <Field
          label="Title"
          required
          help="What people see in a list of downloads. Say what the file is, not what format it is in."
          maxLength={200}
          value={title}
        >
          <Input value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>

        <Field
          label="Description"
          help="One or two sentences about what is in the file, so somebody can decide whether to download it before they spend the bandwidth."
          maxLength={800}
          value={description}
        >
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
          />
        </Field>

        <Field
          label="Category"
          help="Groups downloads together — “Datasets”, “Reports”, “Teaching material”."
          maxLength={80}
          value={category}
        >
          <Input
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            list="studio-file-categories"
          />
        </Field>

        <datalist id="studio-file-categories">
          {categories.map((entry) => (
            <option key={entry} value={entry} />
          ))}
        </datalist>

        {/*
          A Checkbox, not a Switch: this is an answer that takes effect when the form is submitted, and a
          switch promises it takes effect now (Switch.tsx). For an embargoed dataset that promise is the
          difference between a decision and an accident.
        */}
        <Checkbox
          checked={isPublic}
          onCheckedChange={setIsPublic}
          label="Available to the public"
          description="With this off, only people signed in to the studio can get the file. Nobody else can download it even if they know the address."
        />

        {/*
          ⚠ BOTH ENDS OF THIS DATE ARE UTC AND NEITHER END MOVED. `expiresOn` is still the UTC day
          `toDateInput` slices out of the stored instant, and `save` still puts it back as
          `${expiresOn}T23:59:59.000Z` — the pair that makes "available ON the 30th" mean the whole of
          the 30th. `DateField` is string-in/string-out and parses nothing on the way through (its
          header explains why it refuses to own a zone), so the digits in the box are the digits that
          were sliced and the digits that are sent. Anything that turned this into a `Date` would parse
          a UTC day on the local clock and expire the file a day early west of Greenwich.

          It is the dirty check above that makes this worth stating: `dirty` compares `expiresOn`
          against `toDateInput(file.expiresAt)` as STRINGS, and `DateField` never calls `onChange` on
          mount — it only speaks when the reader types or picks — so opening the panel cannot arm the
          "Unsaved changes" line on a file nobody has touched.

          `DateField` brings its own `FieldBlock` in place of the `Field` this was: the field now holds
          the button that opens the calendar, and `Field`'s real `<label>` would fold that button into
          the box's accessible name and forward the opening click back into the box (Field.tsx).
        */}
        <DateField
          label="Available until"
          help="Leave this empty to keep the file available indefinitely. A date here is the last day it can be downloaded."
          value={expiresOn}
          onChange={setExpiresOn}
        />

        {/*
          THE SENTENCE THAT MUST BE ON THIS SCREEN. Nobody may read the two controls above and conclude
          that hiding a download button is the control.
        */}
        <HelpText>
          Both of these are enforced by the server, on the download address itself — not by hiding a
          button. A file that is not public answers “not found” to anybody outside the studio, and one
          past its date answers “this link has expired” with the date on it. The address is guessable
          from the file&rsquo;s name, which is exactly why the check is where it is.
        </HelpText>

        {expired ? (
          <HelpText tone="warn">
            This file&rsquo;s link expired on {formatWhen(file.expiresAt)}. Nobody outside the studio can
            download it. Clear the date, or set a later one, to make it available again — the file itself
            has not been deleted.
          </HelpText>
        ) : null}

        {file.isPublic && !expired ? (
          <p className="flex items-start gap-1.5 break-all text-xs leading-relaxed text-ink-500">
            <Download aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              The public address, which is what a citation should record:{" "}
              <span className="font-mono text-ink-700">{publicDownloadPath(file.slug)}</span>
            </span>
          </p>
        ) : null}
      </FormSection>

      <FormSection
        title="Versions"
        description="Replacing a file adds a new version and leaves the old bytes where they are, so a citation of “version 2” goes on resolving to version 2."
      >
        <p className="flex items-center gap-2 text-sm text-ink-700">
          <Download aria-hidden="true" className="h-4 w-4 shrink-0 text-ink-500" />
          <span>
            <span className="font-semibold tabular-nums">{file.downloadCount}</span>{" "}
            {file.downloadCount === 1 ? "download" : "downloads"} counted altogether, across every
            version.
          </span>
        </p>

        {/*
          WHAT A READER ACTUALLY SEES, said in one sentence, with the way to change it beside it.
          It describes the LATEST version only, because that is the one every public route serves — a
          per-row preview state would be four lines of noise about versions nobody is offered.
        */}
        {latest ? (
          <div className="rounded-md border border-line-200 bg-surface-50 p-3">
            {latestIsPdf ? (
              <p className="text-sm leading-relaxed text-ink-700">
                This is a PDF, so it is shown on the page wherever it is attached — a publication&apos;s
                full text, for instance — as well as being offered as a download. Nothing to convert.
              </p>
            ) : latest.previewByteSize !== null ? (
              <>
                <p className="text-sm leading-relaxed text-ink-700">
                  A PDF preview exists ({formatBytes(latest.previewByteSize)}), so this document is shown
                  on the page rather than only offered as a download. The download still gives the
                  original file.
                </p>
                <Button
                  className="mt-2"
                  variant="secondary"
                  size="sm"
                  isLoading={previewing}
                  loadingLabel="converting"
                  onClick={() => void makePreview()}
                >
                  Make it again
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm leading-relaxed text-ink-700">
                  No browser can draw a {latest.fileName.split(".").pop()?.toUpperCase() || "file"} of
                  this kind, so it is offered as a download and not shown on the page. Converting it once
                  to a PDF changes that; the download goes on giving the original.
                </p>
                {latest.previewFailedReason ? (
                  // The route's own words. An editor pressing a button twice with nothing to show for it
                  // is the failure this sentence exists to prevent.
                  <p className="mt-1.5 text-xs leading-relaxed text-amber-800">
                    The last attempt did not produce one: {latest.previewFailedReason}
                  </p>
                ) : null}
                <Button
                  className="mt-2"
                  variant="secondary"
                  size="sm"
                  isLoading={previewing}
                  loadingLabel="converting"
                  onClick={() => void makePreview()}
                >
                  {latest.previewAttemptedAt ? "Try again" : "Make a PDF preview"}
                </Button>
              </>
            )}
          </div>
        ) : null}

        {file.versions.length === 0 ? (
          <HelpText tone="warn" icon={FileWarning}>
            This entry has no file against it, so there is nothing to download. That happens when an
            upload was started and never finished. Upload the file below and the entry starts working.
          </HelpText>
        ) : (
          <ol className="divide-y divide-line-200 rounded-md border border-line-200">
            {file.versions.map((version, index) => (
              <li key={version.id} className="flex items-start gap-3 px-3 py-2.5">
                <History aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-ink-300" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink-900">
                    Version {version.version}
                    {index === 0 ? (
                      <span className="ml-1.5 inline-flex items-center gap-1 text-xs font-normal text-success-600">
                        <CircleCheck aria-hidden="true" className="h-3 w-3" />
                        the one people get now
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 break-all text-xs text-ink-500">
                    {version.fileName} · {formatBytes(version.byteSize)} ·{" "}
                    <time dateTime={version.createdAt}>{formatWhen(version.createdAt)}</time>
                  </p>
                  {version.notes ? (
                    <p className="mt-1 text-xs leading-relaxed text-ink-700">{version.notes}</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}

        {storageReady ? (
          <div className="space-y-3">
            <Field
              label="What changed in the new version"
              help="One line, kept with the version for ever — “corrected the 2019 rows”. Worth writing: it is what tells somebody which version they need."
              maxLength={300}
              value={versionNotes}
            >
              <Input
                value={versionNotes}
                onChange={(event) => setVersionNotes(event.target.value)}
                placeholder="Corrected the 2019 rows"
              />
            </Field>

            {replacing !== null ? (
              <ProgressBar
                value={Math.round(replacing.fraction * 100)}
                label={`Uploading ${replacing.name}`}
                hint="Leaving this page cancels it. The current version is untouched until the new one has finished."
              />
            ) : (
              <FileDropzone
                onFiles={(chosen) => void replace(chosen)}
                accept={FILE_ACCEPT}
                acceptSummary="Any document, dataset, slide deck or archive"
                maxBytes={MAX_UPLOAD_BYTES}
                multiple={false}
                title={file.versions.length === 0 ? "Upload the file" : "Upload a new version"}
              />
            )}
          </div>
        ) : (
          <HelpText tone="warn" icon={Upload}>
            A new version cannot be uploaded until the file store is set up on this installation.
          </HelpText>
        )}
      </FormSection>

      <FormSection
        title="Delete this file"
        tone="danger"
        description="The entry goes to the recycle bin and stops being downloadable straight away. The stored bytes are kept for a while afterwards, so an administrator can put it back."
      >
        <DeleteButton
          name={file.title}
          noun="file"
          onDelete={async () => {
            await del(FILE_ENDPOINTS.detail(file.id));
          }}
          onDeleted={onDeleted}
          consequences={
            file.downloadCount > 0
              ? `It has been downloaded ${file.downloadCount} ${file.downloadCount === 1 ? "time" : "times"}, so there may be links to it in print. Any address pointing at it will stop working immediately.`
              : undefined
          }
        />
      </FormSection>
    </div>
  );
}
