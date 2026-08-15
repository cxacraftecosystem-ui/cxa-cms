"use client";

/**
 * LinkDialog — add, change or remove the link on the selected words.
 *
 * IT IS THE ONLY PLACE A LINK IS WRITTEN, and it validates before it writes. The reason is in
 * components/RichText.tsx: the published renderer refuses to emit an anchor for an href it considers
 * unsafe and renders the words as plain text instead. So a `javascript:` link accepted here would
 * look like a link in the studio for as long as the author cared to check, and be no link at all on
 * the site. `classifyEditorHref()` — the same rule, in one place — is what both sides read.
 *
 * IT OFFERS A PAGE SEARCH RATHER THAN A TYPED PATH. An author who types "/about-us" when the page is
 * at "/about" has made a broken link that nothing detects: the studio saves happily, the page renders
 * an anchor, and the 404 is only found by a reader. Picking a real page removes the whole class.
 * Every search here guards its own race — a generation counter and an `AbortSignal` (contract §9) —
 * because a slow answer to "ab" must never overwrite the answer to "about".
 *
 * `items === null` IS "LOADING" AND `[]` IS "NOTHING FOUND". They are different screens, and "no
 * pages match" while a request is still in flight is both wrong and discouraging.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, FileText, Search, TriangleAlert, Unlink } from "lucide-react";

import { cn, truncateWords } from "@/lib/utils";
import { STATUS_LABELS } from "@/lib/content";
import { asApiClientError, buildQuery, get } from "@/lib/client/fetcher";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FieldBlock } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { SearchInput } from "@/components/ui/SearchInput";
import { classifyEditorHref } from "@/components/studio/editor/extensions";

/** How many pages the picker asks for. See the note where the cap is stated on screen. */
const PAGE_LIMIT = 8;
/** Quiet time before a search leaves the browser. Long enough that typing a word is one request. */
const SEARCH_DEBOUNCE_MS = 250;

export interface PageLinkResult {
  /** What the page is called. */
  title: string;
  /** The path a link should point at: `/about`, or `/` for the homepage. */
  path: string;
  /** "Draft", "Scheduled"… Null when the page is live and there is nothing to warn about. */
  statusNote: string | null;
}

export interface PageLinkSearchResult {
  results: PageLinkResult[];
  /** True when the server had more to give. It is stated on screen — contract §1.6. */
  truncated: boolean;
}

export type PageLinkSearch = (
  query: string,
  signal: AbortSignal
) => Promise<PageLinkSearchResult>;

export interface LinkDialogProps {
  open: boolean;
  onClose: () => void;
  /** The address already on the selection, or null when there is none. */
  href?: string | null;
  /** The words the link sits on. Shown so the author can see what they are about to link. */
  selectionText?: string | null;
  /** Store this address. The dialog has already validated it. */
  onSave: (href: string) => void;
  /** Remove the link. Only rendered when there is one — never as a disabled button (§1.8). */
  onRemove?: () => void;
  /**
   * Replaces the built-in page search. Pass one when the screen already holds the page list, or when
   * the search should be scoped.
   */
  searchPages?: PageLinkSearch;
}

/**
 * `""` → `/`, `"about"` → `/about`.
 *
 * ⚠ A COPY of `pagePath()` in lib/pages.ts, which carries `import "server-only"` and therefore cannot
 * be imported here. Two lines duplicated in front of a comment saying so beats a client bundle that
 * fails to build because it reached for Prisma.
 */
function pathFromSlug(slug: string): string {
  const normalised = slug.trim().replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
  return normalised ? `/${normalised}` : "/";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** A status that is not PUBLISHED becomes a note beside the page. Unknown values are ignored. */
function statusNoteFor(raw: unknown): string | null {
  const value = readString(raw);
  if (!value || value === "PUBLISHED") return null;
  const match = Object.entries(STATUS_LABELS).find(([key]) => key === value);
  return match ? match[1] : null;
}

/** The rows, wherever the endpoint chose to put them. See `readPageResults`. */
function pickRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  for (const key of ["items", "pages", "results", "data"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

/**
 * Read the search response WITHOUT insisting on one exact shape.
 *
 * The studio's page endpoint is written by another part of this build, and a client that hard-codes
 * `payload.items[].slug` fails completely the day it answers `{ pages: [...] }`. Every field is
 * probed, an unreadable row is skipped rather than rendered as "undefined", and a `path` is derived
 * from the slug when the server did not send one.
 */
function readPageResults(payload: unknown): PageLinkSearchResult {
  const rows = pickRows(payload);
  const results: PageLinkResult[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const slug = readString(row.slug);
    const path = readString(row.path) ?? (slug === null ? null : pathFromSlug(slug));
    // The homepage's slug is the empty string, which `readString` reports as absent — so an explicit
    // `path` or a title is what saves it. Without either there is nothing to show and nothing to link.
    const title = readString(row.title) ?? readString(row.navLabel) ?? slug ?? path;
    if (!path || !title) continue;
    results.push({ title, path, statusNote: statusNoteFor(row.status) });
  }

  const truncated =
    isRecord(payload) && typeof payload.truncated === "boolean"
      ? payload.truncated
      : results.length >= PAGE_LIMIT;

  return { results, truncated };
}

/**
 * The default search.
 *
 * ⚠ ASSUMES `GET /api/studio/pages?q=…&limit=…` returns a list of pages. If that route is not there
 * yet, or answers something else, the failure is caught and stated in plain words with the typed
 * address still available — the dialog stays usable, which is the point.
 */
const defaultPageSearch: PageLinkSearch = async (query, signal) => {
  const payload = await get<unknown>(`/api/studio/pages${buildQuery({ q: query, limit: PAGE_LIMIT })}`, {
    signal
  });
  return readPageResults(payload);
};

export function LinkDialog({
  open,
  onClose,
  href = null,
  selectionText = null,
  onSave,
  onRemove,
  searchPages = defaultPageSearch
}: LinkDialogProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /** null = a search is running; [] = it finished and found nothing. Different screens. */
  const [results, setResults] = useState<PageLinkResult[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Every render of a closed dialog is a render nobody sees, so the fields are reset when it opens
  // rather than when it closes — a reset on close is visible for the length of the exit animation.
  useEffect(() => {
    if (!open) return;
    setValue(href ?? "");
    setError(null);
    setQuery("");
    setResults(null);
    setTruncated(false);
    setSearchError(null);
  }, [href, open]);

  /**
   * The search race guard.
   *
   * A generation counter, so a slow answer to an earlier query is dropped rather than painted over a
   * newer one, AND an abort so the earlier request stops costing anything. Both, because the counter
   * alone still lets a dead request finish and the abort alone still has a window where two responses
   * are in flight (contract §9).
   */
  const generationRef = useRef(0);

  /**
   * Held in a ref so an inline `searchPages` prop — the ordinary way a caller passes one — does not
   * re-run the search on every render of the parent form. The ref is updated rather than frozen, so a
   * screen that swaps the search (a different scope, a different list) still gets the new one.
   */
  const searchRef = useRef(searchPages);
  useEffect(() => {
    searchRef.current = searchPages;
  }, [searchPages]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      generationRef.current += 1;
      setResults(null);
      setTruncated(false);
      setSearchError(null);
      return;
    }

    const generation = (generationRef.current += 1);
    const controller = new AbortController();
    setResults(null);
    setSearchError(null);

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const answer = await searchRef.current(trimmed, controller.signal);
          if (generation !== generationRef.current) return;
          setResults(answer.results);
          setTruncated(answer.truncated);
        } catch (thrown) {
          if (generation !== generationRef.current) return;
          if (controller.signal.aborted) return;
          // The message from lib/api.ts is already a plain sentence ready to render, so it is shown
          // verbatim — with the sentence that says the dialog still works.
          setSearchError(asApiClientError(thrown).message);
          setResults([]);
          setTruncated(false);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query]);

  const classified = classifyEditorHref(value);

  const submit = useCallback(() => {
    const checked = classifyEditorHref(value);

    if (checked.kind === "empty") {
      setError("Enter a web address, or choose a page from this site below.");
      inputRef.current?.focus();
      return;
    }
    if (checked.kind === "unsafe") {
      // Named, not scolded. The author needs to know which addresses work, not that they did wrong.
      setError(
        "That address cannot be used as a link. Use one starting with https:// for another website, / for a page on this site, or mailto: for an email address."
      );
      inputRef.current?.focus();
      return;
    }

    onSave(checked.href);
  }, [onSave, value]);

  const applySuggestion = () => {
    if (!classified.suggestion) return;
    setValue(classified.suggestion);
    setError(null);
    inputRef.current?.focus();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={href ? "Edit this link" : "Add a link"}
      description={
        // Cut on a word boundary: a selection can be a whole paragraph, and the dialog's description
        // is announced with its title — a title that takes twenty seconds to read is a title nobody
        // hears the end of.
        selectionText
          ? `The link will be on “${truncateWords(selectionText, 90)}”.`
          : "The address will be added where the cursor is."
      }
      size="md"
      initialFocusRef={inputRef}
      footer={
        <>
          {/* Only present when there is a link to remove. An always-visible "Remove" that refuses is
              the pattern §1.8 forbids. */}
          {href && onRemove ? (
            <Button
              variant="danger"
              size="sm"
              icon={Unlink}
              onClick={onRemove}
              className="mr-auto"
            >
              Remove link
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={onClose} data-dialog-cancel>
            Cancel
          </Button>
          <Button size="sm" onClick={submit}>
            {href ? "Save link" : "Add link"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {/* FieldBlock, not Field: the block holds a button, and a `<label>` wrapped around one
            forwards stray clicks to the input and folds the button's text into the input's name
            (Field.tsx's header). */}
        <FieldBlock
          label="Web address"
          help="Start with https:// for another website, or / for a page on this site."
          error={error}
        >
          <Input
            ref={inputRef}
            value={value}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://example.org/report"
            onChange={(event) => {
              setValue(event.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(event) => {
              // Enter submits, because a one-field dialog where Enter does nothing feels broken.
              if (event.key !== "Enter") return;
              event.preventDefault();
              submit();
            }}
          />

          {classified.kind === "no-protocol" && classified.suggestion ? (
            <div className="mt-2 rounded-md border border-amber-800/25 bg-amber-100 px-3 py-2.5 text-xs leading-relaxed text-amber-800">
              <p className="flex items-start gap-1.5">
                <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  This has no <span className="font-semibold">https://</span> in front of it, so a
                  browser will look for a page on this site called “{classified.href}” rather than
                  going to another website.
                </span>
              </p>
              <button
                type="button"
                onClick={applySuggestion}
                className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-amber-800/30 bg-card px-2.5 py-1.5 text-xs font-medium text-amber-800 transition hover:bg-amber-100"
              >
                <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
                Use {classified.suggestion}
              </button>
            </div>
          ) : null}

          {classified.kind === "external" ? (
            <p className="mt-2 text-xs leading-relaxed text-ink-500">
              This goes to another website, so it will open in a new tab.
            </p>
          ) : null}
        </FieldBlock>

        <div className="border-t border-line-200 pt-4">
          <SearchInput
            label="Find a page on this site"
            showLabel
            value={query}
            onValueChange={setQuery}
            placeholder="Search page titles"
            clearLabel="Clear the page search"
          />

          <div className="mt-2">
            {query.trim().length === 0 ? (
              <p className="text-xs leading-relaxed text-ink-500">
                Search for a page instead of typing its address, so the link cannot point at a page
                that is not there.
              </p>
            ) : results === null ? (
              // Loading. Deliberately a sentence and not a skeleton: one line of text replaced by
              // one line of text does not move the dialog.
              <p className="text-xs text-ink-500">Looking for pages…</p>
            ) : results.length === 0 ? (
              <div className="text-xs leading-relaxed text-ink-500">
                {searchError ? (
                  <p className="flex items-start gap-1.5 text-error-600">
                    <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      {searchError} You can still type the address in the box above.
                    </span>
                  </p>
                ) : (
                  <p>No page titles match “{query.trim()}”.</p>
                )}
              </div>
            ) : (
              <>
                <ul className="m-0 max-h-56 list-none overflow-y-auto p-0">
                  {results.map((result) => (
                    <li key={result.path}>
                      <button
                        type="button"
                        onClick={() => {
                          setValue(result.path);
                          setError(null);
                          inputRef.current?.focus();
                        }}
                        className={cn(
                          "flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition",
                          value === result.path
                            ? "bg-purple-100"
                            : "bg-card hover:bg-surface-100"
                        )}
                      >
                        <FileText
                          aria-hidden="true"
                          className="mt-0.5 h-4 w-4 shrink-0 text-ink-300"
                        />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-ink-900">
                            {result.title}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-ink-500">
                            {result.path}
                          </span>
                          {result.statusNote ? (
                            // A word, not a colour (contract §11). A link to an unpublished page is
                            // not an error — it is a link that will not work yet, and the author is
                            // the only person who can decide whether that is fine.
                            <span className="mt-1 inline-flex items-center gap-1 rounded bg-warn-100 px-1.5 py-0.5 text-[0.6875rem] font-medium text-warn-800">
                              <TriangleAlert aria-hidden="true" className="h-3 w-3" />
                              {result.statusNote} — not visible to readers yet
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>

                {/* THE CAP IS STATED. A list that quietly stops at eight is indistinguishable from a
                    site with eight pages (contract §1.6). */}
                {truncated ? (
                  <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-ink-500">
                    <Search aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      Showing the first {PAGE_LIMIT} matches. Type more of the title to narrow them
                      down.
                    </span>
                  </p>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
