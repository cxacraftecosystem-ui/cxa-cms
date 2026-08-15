"use client";

/**
 * OpenCollectionImport — search two museums that publish openly-licensed photographs, see exactly what
 * each licence asks of the Centre, and bring the chosen pictures into the media library.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE LICENCE AND THE CREDIT ARE ON EVERY TILE, BEFORE ANYTHING IS IMPORTED. That is the whole point
 * of this screen. An editor is agreeing to a condition of use on the Centre's behalf — CC BY-SA, for
 * instance, requires the named credit to travel with the picture wherever it is published — and a
 * picker that showed a thumbnail and a tick box would be asking them to agree to something they cannot
 * see. So the licence is a badge that is never abbreviated, the credit is printed under it, and the
 * full credit is one press away when it is long.
 *
 * WHAT THIS SCREEN CANNOT DECIDE. Nothing here is a control. The licence filter runs on the server, in
 * `lib/media/open-collections.ts`, and it runs AGAIN when each picture is imported — the import route
 * re-fetches the record and re-reads its licence rather than believing anything this component sends.
 * A browser is not a place to enforce a copyright rule (contract §1.7).
 *
 * THE SEARCH RUNS ON SUBMIT, NOT WHILE TYPING, and that is deliberate rather than lazy. One search of
 * the Metropolitan Museum is up to forty requests to somebody else's free API, because its search
 * returns identifiers and each record has to be read to find out whether it is in the public domain. A
 * debounced search box would spend that on every pause in a sentence. Pressing Search is one keystroke
 * and it removes the whole race — there is no timer here and no late answer to ignore.
 *
 * IMPORTS RUN ONE AT A TIME, IN THE ORDER THEY WERE PICKED. Each one downloads up to 40 MB and has it
 * resized on the server, so three at once is how the server meets its memory limit and loses all three.
 * One at a time is also what gives every picture its own row: `imported`, `already in the library`, or
 * `failed` with the reason in words. ⚠ A BATCH THAT PART-SUCCEEDS IS THE ORDINARY CASE, never treated
 * as a success — the failures stay on screen, named, and stay selected so pressing Import again retries
 * exactly those.
 *
 * ⚠ THE THUMBNAILS ARE LOADED FROM THE MUSEUM, and no photograph is ever stored in this repository.
 * The pictures a tile shows are transient previews of records the SERVER has already confirmed are
 * public domain, CC0, CC BY or CC BY-SA — nothing under copyright reaches this component to be
 * displayed. They are `unoptimized`, so they are fetched by the browser and never pass through this
 * site's image optimiser or its cache: a third party's bytes have no business being cached on the
 * Centre's infrastructure, and the museums' hosts are deliberately absent from `next.config.ts`'s
 * `remotePatterns` for the same reason.
 *
 * NO FRAMER-MOTION HERE, so there is no reduced-motion branch to get wrong. The studio is calm and
 * dense and its grids do not animate in (see MediaGrid's header); every state on this screen — chosen,
 * importing, imported, failed — is carried by a border, an icon AND a word, so nothing depends on
 * movement or on colour alone (contract §1.4, §11).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import {
  Check,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  ExternalLink,
  ImageOff,
  Landmark,
  Scale,
  SearchX,
  TriangleAlert
} from "lucide-react";

import { asApiClientError, buildQuery, post } from "@/lib/client/fetcher";
import { useResource } from "@/lib/client/useResource";
import { cn } from "@/lib/utils";
import {
  OPEN_COLLECTION_LIMITS,
  OPEN_COLLECTION_SOURCES,
  OPEN_COLLECTION_SOURCE_LABELS,
  OPEN_COLLECTION_SOURCE_NOTES,
  type OpenCollectionResult,
  type OpenCollectionSearchOutcome,
  type OpenCollectionSource
} from "@/lib/media/open-collections";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { SearchInput } from "@/components/ui/SearchInput";
import { useToast } from "@/components/ui/ToastProvider";
import type { StudioMediaAsset } from "./MediaGrid";

/**
 * The two addresses this screen calls.
 *
 * ⚠ NOT in `MEDIA_ENDPOINTS` (components/studio/media/MediaGrid.tsx), which is the map the library, the
 * picker and the detail panel share. This feature has exactly one caller — this file — and adding it
 * there would mean editing a module every media screen imports for the sake of one screen's benefit. If
 * a second caller ever appears, move both entries into that map rather than copying them.
 */
const OPEN_COLLECTION_ENDPOINTS = {
  search: (query: string) => `/api/studio/media/collections/search${query}`,
  import: "/api/studio/media/collections/import"
} as const;

/** In step with `MIN_QUERY_LENGTH` in the search route, which refuses anything shorter. */
const MIN_QUERY_LENGTH = 2;

/** How many characters of a credit are shown before it is folded. */
const CREDIT_CLAMP_HINT = 150;

/** The source toggle's options. "Both" first, because it is the useful default. */
const SOURCE_CHOICES: readonly { value: OpenCollectionSource | "all"; label: string }[] = [
  { value: "all", label: "Both collections" },
  ...OPEN_COLLECTION_SOURCES.map((source) => ({
    value: source,
    label: OPEN_COLLECTION_SOURCE_LABELS[source]
  }))
];

/** What the import route answers. Its shape is fixed by app/api/studio/media/collections/import/route.ts. */
interface OpenCollectionImportAnswer {
  status: "imported" | "existing";
  /** Present when `status` is "existing" — says which copy was used instead, in words. */
  reason?: string;
  asset: StudioMediaAsset;
  derivatives: {
    generated: number;
    failed: { label: string; format: string; reason: string }[];
    notes: string[];
  };
}

type RowStatus = "waiting" | "importing" | "imported" | "existing" | "failed" | "stopped";

interface ImportRow {
  key: string;
  title: string;
  sourceLabel: string;
  status: RowStatus;
  /** A plain sentence. Always present for anything other than a clean import. */
  message: string | null;
}

/** Insertion-ordered selection key. A Met object number and a Commons title cannot collide. */
function keyOf(item: Pick<OpenCollectionResult, "source" | "sourceId">): string {
  return `${item.source}:${item.sourceId}`;
}

const ROW_WORDS: Record<RowStatus, string> = {
  waiting: "Waiting",
  importing: "Importing",
  imported: "Added to the library",
  existing: "Already in the library",
  failed: "Not imported",
  stopped: "Not attempted"
};

export interface OpenCollectionImportProps {
  /** Where imported pictures are filed. Null means "no folder". */
  folderId: string | null;
  /** Said out loud before anything is imported, so nothing lands somewhere unexpected. */
  folderLabel: string;
  /**
   * False when object storage is not configured. The trigger is then disabled WITH the reason beside
   * it — this is a deployment state, not a permission; a reader who may not manage media never sees
   * this component at all (contract §1.8).
   */
  storageReady: boolean;
  /** The rows that actually landed, ready to go straight into the grid with no re-fetch. */
  onImported: (assets: StudioMediaAsset[]) => void;
  className?: string;
}

export function OpenCollectionImport({
  folderId,
  folderLabel,
  storageReady,
  onImported,
  className
}: OpenCollectionImportProps) {
  const { toast } = useToast();

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  /** The query actually being searched. Only changes on submit — see the header. */
  const [submitted, setSubmitted] = useState("");
  const [source, setSource] = useState<OpenCollectionSource | "all">("all");
  /** A Map so "the order they were picked" is a promise this screen can keep. */
  const [chosen, setChosen] = useState<Map<string, OpenCollectionResult>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // The imports belong to a screen that no longer exists. Anything already created is in the
      // library; this only stops the requests still in flight.
      abortRef.current?.abort();
    };
  }, []);

  const path =
    submitted.trim().length >= MIN_QUERY_LENGTH
      ? OPEN_COLLECTION_ENDPOINTS.search(
          buildQuery({ q: submitted.trim(), source, limit: OPEN_COLLECTION_LIMITS.default })
        )
      : null;

  // `null` suspends the fetch entirely, so a dialog that is shut — or open with nothing typed — costs
  // nothing at all (useResource.ts).
  const search = useResource<OpenCollectionSearchOutcome>(open ? path : null);

  const items = search.data?.items ?? null;
  const reports = search.data?.sources ?? [];

  const reset = useCallback(() => {
    setDraft("");
    setSubmitted("");
    setSource("all");
    setChosen(new Map());
    setExpanded(new Set());
    setRows([]);
    setNotice(null);
  }, []);

  const closeDialog = () => {
    // An import in flight is not interrupted by closing: the request is already with the server and
    // abandoning it would leave bytes in storage with no row. The dialog simply refuses to shut.
    if (running) {
      setNotice(
        "The import is still running. This will close on its own as soon as the last picture has been dealt with."
      );
      return;
    }
    setOpen(false);
    reset();
  };

  const toggle = (item: OpenCollectionResult) => {
    const key = keyOf(item);
    setChosen((current) => {
      const next = new Map(current);
      if (next.has(key)) next.delete(key);
      else next.set(key, item);
      return next;
    });
  };

  const toggleCredit = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const onSubmitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = draft.trim();
    setNotice(
      next.length > 0 && next.length < MIN_QUERY_LENGTH
        ? `Type at least ${MIN_QUERY_LENGTH} letters to search the collections.`
        : null
    );
    setSubmitted(next);
  };

  /**
   * Import the chosen pictures, one at a time, in the order they were picked.
   *
   * Every outcome is written into its own row as it happens, which is what makes the progress real
   * rather than a spinner: the reader can see which picture is being fetched and which one failed.
   */
  const runImport = async () => {
    const picks = [...chosen.values()];
    if (picks.length === 0 || running) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setNotice(null);
    setRows(
      picks.map((pick) => ({
        key: keyOf(pick),
        title: pick.title,
        sourceLabel: OPEN_COLLECTION_SOURCE_LABELS[pick.source],
        status: "waiting" as RowStatus,
        message: null
      }))
    );

    const landed: StudioMediaAsset[] = [];
    const unfinished: OpenCollectionResult[] = [];
    let stopped = false;

    const update = (key: string, patch: Partial<ImportRow>) => {
      if (!mountedRef.current) return;
      setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    };

    for (const pick of picks) {
      if (controller.signal.aborted) {
        stopped = true;
        unfinished.push(pick);
        update(keyOf(pick), {
          status: "stopped",
          message: "The import was stopped before this one was reached."
        });
        continue;
      }

      const key = keyOf(pick);
      update(key, { status: "importing", message: null });

      try {
        const answer = await post<OpenCollectionImportAnswer>(
          OPEN_COLLECTION_ENDPOINTS.import,
          { source: pick.source, sourceId: pick.sourceId, folderId },
          { signal: controller.signal }
        );

        landed.push(answer.asset);

        const failedSizes = answer.derivatives.failed.length;
        const derivativeNote =
          failedSizes > 0
            ? ` ${failedSizes === 1 ? "One smaller version" : `${failedSizes} smaller versions`} could not be made, so the site will send a larger file than it should until an administrator regenerates them.`
            : answer.derivatives.notes.length > 0
              ? ` ${answer.derivatives.notes.join(" ")}`
              : "";

        update(key, {
          status: answer.status === "existing" ? "existing" : "imported",
          message:
            answer.status === "existing"
              ? (answer.reason ?? "A copy of this picture was already in the library and that one was used.")
              : `Stored with its licence and credit.${derivativeNote}`.trim()
        });
      } catch (thrown) {
        const error = asApiClientError(thrown);
        unfinished.push(pick);
        update(key, { status: "failed", message: error.message });
      }
    }

    abortRef.current = null;
    if (!mountedRef.current) return;

    setRunning(false);
    if (landed.length > 0) onImported(landed);

    // Only the ones that did not land stay selected, so pressing Import again retries exactly those and
    // leaves the pictures that worked alone.
    setChosen(new Map(unfinished.map((pick) => [keyOf(pick), pick])));

    if (landed.length > 0) {
      toast({
        title:
          landed.length === 1
            ? "1 picture is now in the library"
            : `${landed.length} pictures are now in the library`,
        description:
          unfinished.length === 0
            ? "Each one carries its licence and credit. They still need a description before they are used."
            : "The ones that did not make it are listed below, with the reason for each.",
        tone: unfinished.length === 0 ? "success" : "warn"
      });
    }

    if (stopped) {
      setNotice(
        landed.length === 0
          ? "The import was stopped and nothing was added."
          : `The import was stopped. ${landed.length === 1 ? "1 picture had already been added" : `${landed.length} pictures had already been added`} and ${unfinished.length === 1 ? "1 was not" : `${unfinished.length} were not`}.`
      );
      return;
    }

    if (landed.length === 0 && unfinished.length > 0) {
      setNotice("Nothing was added. Every picture is listed below with the reason it did not import.");
    }
  };

  const chosenCount = chosen.size;
  const finished = rows.filter((row) => row.status !== "waiting" && row.status !== "importing").length;
  const failures = rows.filter((row) => row.status === "failed" || row.status === "stopped");
  const searched = submitted.trim().length >= MIN_QUERY_LENGTH;

  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          icon={Landmark}
          disabled={!storageReady}
          onClick={() => setOpen(true)}
        >
          Import from a museum collection
        </Button>
        <p className="text-xs leading-relaxed text-ink-500">
          {storageReady
            ? "Search The Metropolitan Museum of Art and Wikimedia Commons for photographs the Centre is free to use."
            : "Importing is switched off because the file store has not been set up on this installation. An administrator can check Settings for the details."}
        </p>
      </div>

      <Dialog
        open={open}
        onClose={closeDialog}
        title="Import from a museum collection"
        description="Only pictures the Centre may lawfully reuse are offered. Read each licence before you choose."
        size="lg"
        footer={
          <>
            <p className="mr-auto text-xs text-ink-500">
              {chosenCount === 0
                ? "Nothing chosen yet"
                : chosenCount === 1
                  ? "1 picture chosen"
                  : `${chosenCount} pictures chosen`}
            </p>
            <button
              type="button"
              data-dialog-cancel
              onClick={closeDialog}
              className="field-button-secondary"
            >
              {running ? "Close when finished" : "Close"}
            </button>
            <Button
              disabled={chosenCount === 0}
              isLoading={running}
              loadingLabel="importing"
              onClick={() => void runImport()}
            >
              {chosenCount > 1 ? `Import these ${chosenCount} pictures` : "Import this picture"}
            </Button>
          </>
        }
      >
        {/* ── What is on offer, and what is not ─────────────────────────────────────────────── */}
        <div className="rounded-md border border-line-200 bg-surface-50 p-3">
          <p className="text-xs leading-relaxed text-ink-700">
            Two institutions publish photographs with a licence that allows reuse. Everything offered
            here has been checked on the server, and it is checked a second time when you import it.
          </p>
          <ul className="mt-2 space-y-1.5">
            {OPEN_COLLECTION_SOURCES.map((entry) => (
              <li key={entry} className="text-xs leading-relaxed text-ink-500">
                <span className="font-medium text-ink-700">{OPEN_COLLECTION_SOURCE_LABELS[entry]}</span>{" "}
                — {OPEN_COLLECTION_SOURCE_NOTES[entry]}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs leading-relaxed text-ink-500">
            Pictures are filed under{" "}
            <span className="font-medium text-ink-700">{folderLabel}</span>. Each one arrives with its
            credit and licence already filled in, and with no description — a description has to be
            written by a person, and the library will keep asking until it is.
          </p>
        </div>

        {/* ── The search ─────────────────────────────────────────────────────────────────────── */}
        <form onSubmit={onSubmitSearch} className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
          <SearchInput
            label="Search the museum collections by subject, place or material"
            placeholder="For example: Bengal sari, Mughal miniature, block printing"
            value={draft}
            onValueChange={setDraft}
            clearLabel="Clear the collection search"
            className="min-w-0 sm:flex-1"
          />
          <Button type="submit" isLoading={search.isLoading} loadingLabel="searching">
            Search
          </Button>
        </form>

        {/*
          A real radio group. Three `<button>`s with `aria-pressed` would work too, but a source is one
          choice out of three and a radio group is the control that says so — arrow keys move between
          the options and a screen reader announces "2 of 3".
        */}
        <fieldset className="mt-3">
          <legend className="text-xs font-medium text-ink-700">Which collection to search</legend>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
            {SOURCE_CHOICES.map((choice) => (
              <label
                key={choice.value}
                className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-ink-700"
              >
                <input
                  type="radio"
                  name="open-collection-source"
                  value={choice.value}
                  checked={source === choice.value}
                  onChange={() => setSource(choice.value)}
                  // `accent-*`, not `text-*`: a native radio takes its fill from `accent-color`, and
                  // `text-purple-700` on one paints nothing at all. The ring colour is named because
                  // a bare `ring-2` is stock BLUE (contract §3).
                  className="h-4 w-4 accent-purple-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-600/40"
                />
                <span>{choice.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {search.error ? (
          <p role="alert" className="mt-3 text-sm text-error-600">
            {search.error.message}
          </p>
        ) : null}

        {/* ── What each source actually answered ─────────────────────────────────────────────── */}
        {searched && reports.length > 0 ? (
          <ul className="mt-3 space-y-1.5">
            {reports.map((report) => (
              <li
                key={report.source}
                className={cn(
                  "rounded-md border px-2.5 py-2 text-xs leading-relaxed",
                  report.problem
                    ? "border-amber-800/25 bg-amber-100 text-amber-800"
                    : "border-line-200 bg-surface-50 text-ink-500"
                )}
              >
                <span className="font-medium text-ink-700">{report.label}</span>{" "}
                {report.problem ? (
                  <span className="flex items-start gap-1.5">
                    <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{report.problem}</span>
                  </span>
                ) : (
                  <>
                    offered{" "}
                    {report.offered === 1 ? "1 picture" : `${report.offered} pictures`}
                    {report.withheldForLicence > 0
                      ? `. ${report.withheldForLicence === 1 ? "1 record was" : `${report.withheldForLicence} records were`} left out because the licence does not allow the Centre to reuse them`
                      : ""}
                    {report.withheldForFormat > 0
                      ? `. ${report.withheldForFormat === 1 ? "1 was" : `${report.withheldForFormat} were`} left out because the file is not a photograph the library can store`
                      : ""}
                    {report.truncated
                      ? ". There are more matches than are shown — narrow the search to reach them"
                      : ""}
                    .
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : null}

        {/* ── The results ────────────────────────────────────────────────────────────────────── */}
        {!searched ? (
          <p className="mt-3 text-xs leading-relaxed text-ink-500">
            Type a subject above and press Search. The search asks both museums directly, so it takes a
            few seconds.
          </p>
        ) : items === null ? (
          // `null` means LOADING, `[]` means nothing matched. Two different screens (contract §9).
          <p role="status" className="mt-3 text-xs text-ink-500">
            Searching the collections. This asks the museums for each record in turn, so it can take a
            few seconds.
          </p>
        ) : items.length === 0 ? (
          <EmptyState
            className="mt-3"
            icon={SearchX}
            // The dialog's own title is an h2, so a nested empty state must be an h3 — heading levels
            // never skip and never duplicate a rank they sit under (contract §11).
            headingLevel={3}
            title="Nothing here can be reused"
            description={
              "Either the collections have no photograph matching those words, or everything they " +
              "returned is still under copyright. Try a different subject, a place name, or the name " +
              "of a material."
            }
          />
        ) : (
          <>
            <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {items.map((item) => {
                const key = keyOf(item);
                const isChosen = chosen.has(key);
                const isExpanded = expanded.has(key);
                const longCredit = item.attribution.length > CREDIT_CLAMP_HINT;

                return (
                  <li
                    key={key}
                    className={cn(
                      "flex min-w-0 flex-col rounded-md border bg-card p-2",
                      isChosen ? "border-purple-700 ring-2 ring-purple-600/15" : "border-line-200"
                    )}
                  >
                    <button
                      type="button"
                      aria-pressed={isChosen}
                      onClick={() => toggle(item)}
                      className="min-w-0 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-600/40"
                    >
                      <span className="relative block aspect-[4/3] w-full overflow-hidden rounded-sm bg-surface-200">
                        {item.thumbnailUrl ? (
                          <Image
                            src={item.thumbnailUrl}
                            // Decorative in context: the button's own text names the work, and no
                            // machine can describe a photograph it has not seen.
                            alt=""
                            fill
                            sizes="(min-width: 640px) 12rem, 40vw"
                            // See the header: a third party's bytes never pass through this site's
                            // image optimiser or its cache.
                            unoptimized
                            loading="lazy"
                            referrerPolicy="no-referrer"
                            className="object-contain"
                          />
                        ) : (
                          <span className="absolute inset-0 flex items-center justify-center text-ink-500">
                            <ImageOff aria-hidden="true" className="h-5 w-5" />
                          </span>
                        )}
                      </span>

                      <span className="mt-1.5 block truncate text-xs font-medium text-ink-900">
                        {item.title}
                      </span>
                      <span className="block truncate text-[0.6875rem] text-ink-500">
                        {[item.artist, item.date, item.culture].filter(Boolean).join(" · ") ||
                          OPEN_COLLECTION_SOURCE_LABELS[item.source]}
                      </span>

                      {/* The chosen state as a word and a glyph, not only as a border colour. */}
                      <span
                        className={cn(
                          "mt-1 inline-flex items-center gap-1 text-[0.6875rem] font-medium",
                          isChosen ? "text-purple-700" : "text-ink-500"
                        )}
                      >
                        {isChosen ? <Check aria-hidden="true" className="h-3 w-3" /> : null}
                        {isChosen ? "Chosen" : "Choose this picture"}
                      </span>
                    </button>

                    {/* The licence, never abbreviated and never inside the button. */}
                    <p className="mt-2">
                      <Badge tone="info" size="sm" icon={Scale}>
                        {item.licence}
                      </Badge>
                    </p>

                    <p
                      className={cn(
                        "mt-1.5 break-words text-[0.6875rem] leading-relaxed text-ink-500",
                        longCredit && !isExpanded ? "line-clamp-3" : ""
                      )}
                    >
                      {item.attribution}
                    </p>

                    {longCredit ? (
                      <button
                        type="button"
                        onClick={() => toggleCredit(key)}
                        className="mt-1 inline-flex items-center gap-1 self-start text-[0.6875rem] font-medium text-purple-700 hover:underline"
                      >
                        {isExpanded ? (
                          <ChevronUp aria-hidden="true" className="h-3 w-3" />
                        ) : (
                          <ChevronDown aria-hidden="true" className="h-3 w-3" />
                        )}
                        {isExpanded ? "Fold the credit away" : "Show the full credit"}
                      </button>
                    ) : null}

                    <a
                      href={item.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1.5 inline-flex items-center gap-1 self-start text-[0.6875rem] text-ink-500 hover:text-ink-900 hover:underline"
                    >
                      <ExternalLink aria-hidden="true" className="h-3 w-3" />
                      Open the record at the museum
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  </li>
                );
              })}
            </ul>

            {/* The cap, on screen. A list that quietly stops is indistinguishable from a collection
                with only this many matches (contract §1.6). */}
            <p className="mt-2 text-xs leading-relaxed text-ink-500">
              {items.length === 1 ? "1 picture is" : `${items.length} pictures are`} shown, out of at
              most {search.data?.limit ?? OPEN_COLLECTION_LIMITS.default} per search
              {search.data?.truncated
                ? ". Both collections hold more than this — a narrower search brings different ones to the top."
                : "."}
            </p>
          </>
        )}

        {/* ── Progress, then the outcome of every single picture ─────────────────────────────── */}
        {rows.length > 0 ? (
          <div className="mt-4 rounded-md border border-line-200 bg-surface-50 p-3">
            <ProgressBar
              value={rows.length === 0 ? null : Math.round((finished / rows.length) * 100)}
              label={rows.length === 1 ? "Importing 1 picture" : `Importing ${rows.length} pictures`}
              hint={`${finished} of ${rows.length} finished`}
            />

            <ul className="mt-3 space-y-2">
              {rows.map((row) => (
                <li key={row.key} className="text-xs leading-relaxed">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="min-w-0 break-words font-medium text-ink-900">{row.title}</span>
                    <span
                      className={cn(
                        "shrink-0",
                        row.status === "failed"
                          ? "text-error-600"
                          : row.status === "imported"
                            ? "text-success-600"
                            : "text-ink-500"
                      )}
                    >
                      {ROW_WORDS[row.status]}
                    </span>
                    <span className="shrink-0 text-ink-300">{row.sourceLabel}</span>
                  </span>
                  {row.message ? <span className="block text-ink-500">{row.message}</span> : null}
                </li>
              ))}
            </ul>

            {running ? (
              <p className="mt-2 text-xs leading-relaxed text-ink-500">
                Pictures are fetched one at a time so a large file cannot exhaust the server. Leaving
                this dialog open is not required — anything already added is safely in the library.
              </p>
            ) : null}
          </div>
        ) : null}

        {failures.length > 0 && !running ? (
          // Named and staying on screen. `role="alert"` rather than a status: pictures the reader asked
          // for are missing and they must know now, not when they happen to look.
          <div
            role="alert"
            className="mt-3 rounded-md border border-error-200 bg-error-100 p-3 text-error-700"
          >
            <p className="flex items-start gap-1.5 text-sm font-semibold">
              <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {failures.length === 1
                  ? "1 picture was not imported"
                  : `${failures.length} pictures were not imported`}
              </span>
            </p>
            <ul className="mt-2 space-y-1.5">
              {failures.map((row) => (
                <li key={row.key} className="text-xs leading-relaxed">
                  <span className="block break-words font-medium">{row.title}</span>
                  <span className="block">{row.message}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs leading-relaxed">
              These are still chosen above, so pressing Import again tries exactly these and leaves the
              ones that worked alone.
            </p>
          </div>
        ) : null}

        {notice ? (
          <p
            role="status"
            className="mt-3 flex items-start gap-1.5 rounded-md border border-line-200 bg-surface-50 px-2.5 py-2 text-xs leading-relaxed text-ink-700"
          >
            <CircleCheck aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-500" />
            <span>{notice}</span>
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}
