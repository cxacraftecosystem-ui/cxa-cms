"use client";

/**
 * FilterToolbar — the studio list's filter row: a search box, the publication-status filter, any other
 * closed lists a screen needs, a summary of what is currently narrowing the list, and Clear all.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE URL IS THE STATE. Every change is written back with `router.replace(…, { scroll: false })`, so a
 * filtered view is a link an administrator can send to a colleague, bookmark, and come back to — and
 * the Back button walks the filters instead of leaving the screen. `replace` and not `push`: each
 * keystroke would otherwise be a history entry and Back would spell the reader's query out backwards,
 * one letter at a time. `scroll: false` because a filtered list must not throw a reader back to the top
 * of the page they were halfway down.
 *
 * ONE TIMER FOR EVERYTHING. The search box and every dropdown share the SAME debounce, so there is
 * exactly one race to reason about instead of two systems taking turns to win. The cost is that a
 * dropdown commits a quarter of a second after it is changed; the benefit is that typing and choosing
 * cannot interleave into a URL that reflects neither.
 *
 * EMPTY MEANS EVERYTHING, AND IT IS NEVER SERIALISED. A filter with nothing chosen is ABSENT from the
 * query string — never written as "every option selected". If the two were spelled the same way they
 * would start to disagree the moment a new option was added: an old bookmark that meant "all of them"
 * would quietly come to mean "all of them except the new one". The dropdown's own "Any status" entry is
 * how the reader SEES that empty state, and the line under the row says it in words when nothing at all
 * is set.
 *
 * A VALUE IN THE URL THAT MATCHES NO OPTION IS STILL SHOWN, labelled with its raw value. It is
 * narrowing the list, so hiding it would leave a reader looking at a short list with no visible reason
 * for it — and a list that quietly stops is indistinguishable from a place with no records (contract
 * §1.6).
 *
 * PARAMETERS THIS BAR DOES NOT OWN SURVIVE. The next query is built from the current one, so a `sort`
 * written by `DataTable`, or a `view` written by the screen, is not wiped by a filter change. Only the
 * keys listed here and `resetParams` are removed.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * NO `<Suspense>` BOUNDARY, unlike the public site's `FilterBar`. `useSearchParams()` opts a page out
 * of static prerendering, and on the public site that would cost a listing its prerender — hence the
 * boundary there. Every studio route is dynamic already, because the layout calls `requireUser()`,
 * which reads cookies. Adding a boundary here would only mean a skeleton flashing over the toolbar on
 * every navigation, and an administrator hitting a filter wants it to be there.
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FilterX, X } from "lucide-react";
import type { ContentStatus } from "@prisma/client";

import { STATUS_LABELS } from "@/lib/content";
import { cn } from "@/lib/utils";
import { Field } from "@/components/ui/Field";
import { SearchInput } from "@/components/ui/SearchInput";
import { Select } from "@/components/ui/Select";

const DEFAULT_SEARCH_KEY = "q";
const DEFAULT_STATUS_KEY = "status";
const DEFAULT_DEBOUNCE_MS = 250;

/**
 * Dropped whenever a filter changes. Page 4 of an unfiltered list is not page 4 of a filtered one, and
 * landing on an empty page 4 looks exactly like a list with no records.
 */
const DEFAULT_RESET_PARAMS: readonly string[] = ["page"];

/** The order a reader thinks about them in: what they are working on first, what is finished last. */
const DEFAULT_STATUSES: readonly ContentStatus[] = [
  "DRAFT",
  "IN_REVIEW",
  "SCHEDULED",
  "PUBLISHED",
  "ARCHIVED"
];

export interface FilterToolbarOption {
  /** What goes in the query string. Keep it short and stable — it is part of a shareable address. */
  value: string;
  label: string;
}

export interface FilterToolbarSelect {
  /** The query parameter this list owns. */
  key: string;
  /** The visible name — "Research area", "Type", "Author". */
  label: string;
  options: readonly FilterToolbarOption[];
  /** The empty entry's label. Default "Any <label lower-cased>". */
  placeholder?: string;
}

export interface FilterToolbarSearch {
  /** Default "q". */
  key?: string;
  /** REQUIRED — a search box's only accessible name. "Search publications", not "Search". */
  label: string;
  placeholder?: string;
}

export interface FilterToolbarStatus {
  /** Default "status". */
  key?: string;
  /** Only the statuses this list can contain. Default: all five. */
  statuses?: readonly ContentStatus[];
  /** Default "Status". */
  label?: string;
}

export interface FilterToolbarProps {
  search?: FilterToolbarSearch;
  /** Pass `{}` for the standard publication-status filter; omit it for a list with no statuses. */
  status?: FilterToolbarStatus;
  selects?: readonly FilterToolbarSelect[];
  /** Default `["page"]`. See the constant above. */
  resetParams?: readonly string[];
  debounceMs?: number;
  /**
   * Extra controls at the end of the row — a "Show deleted" switch, a view toggle. They own their own
   * query parameters, which this bar leaves alone.
   */
  children?: ReactNode;
  /** Names the region for a screen reader. Default "Filters". */
  label?: string;
  className?: string;
}

/** One internal shape for the status filter and every caller-supplied list, so the URL logic is one path. */
interface Group {
  key: string;
  label: string;
  options: readonly FilterToolbarOption[];
  placeholder: string;
}

interface ToolbarState {
  q: string;
  /** Keyed by group key. `""` means "no narrowing" — see the header. */
  values: Record<string, string>;
}

/** Read the whole bar's state out of a query string. The URL is the source of truth. */
function readState(
  params: URLSearchParams,
  groups: readonly Group[],
  searchKey: string | null
): ToolbarState {
  const values: Record<string, string> = {};
  for (const group of groups) {
    // A studio filter is one-of, so two values in the URL is a hand-edited or stale link; the first
    // wins, so the dropdown and the summary cannot disagree about what is selected.
    values[group.key] = params.getAll(group.key).find((value) => value.length > 0) ?? "";
  }
  return { q: searchKey ? (params.get(searchKey) ?? "") : "", values };
}

function buildQuery(
  state: ToolbarState,
  current: string,
  groups: readonly Group[],
  searchKey: string | null,
  resetParams: readonly string[]
): string {
  const next = new URLSearchParams(current);

  if (searchKey) next.delete(searchKey);
  for (const group of groups) next.delete(group.key);
  for (const key of resetParams) next.delete(key);

  const query = state.q.trim();
  if (searchKey && query.length > 0) next.set(searchKey, query);

  for (const group of groups) {
    const value = state.values[group.key] ?? "";
    if (value.length > 0) next.set(group.key, value);
  }

  return next.toString();
}

/**
 * Compare two query strings by MEANING, not by text. `buildQuery` deletes and re-sets the keys it owns,
 * so an unchanged filter set comes back in a different order; a string comparison would call that a
 * change and navigate on every keystroke.
 */
function sameQuery(a: string, b: string): boolean {
  const normalise = (input: string) =>
    [...new URLSearchParams(input).entries()]
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join("&");
  return normalise(a) === normalise(b);
}

const CHIP_ACTIVE =
  "inline-flex min-h-8 items-center gap-1.5 rounded-full border border-purple-200 bg-purple-50 px-3 py-1 text-xs font-medium text-purple-700 transition hover:border-purple-300 hover:bg-purple-100";

export function FilterToolbar({
  search,
  status,
  selects,
  resetParams = DEFAULT_RESET_PARAMS,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  children,
  label = "Filters",
  className
}: FilterToolbarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const uid = useId();

  const serialised = params.toString();
  const searchKey = search ? (search.key ?? DEFAULT_SEARCH_KEY) : null;

  const groups = useMemo<Group[]>(() => {
    const list: Group[] = [];

    if (status) {
      const statusLabel = status.label ?? "Status";
      list.push({
        key: status.key ?? DEFAULT_STATUS_KEY,
        label: statusLabel,
        options: (status.statuses ?? DEFAULT_STATUSES).map((value) => ({
          value,
          // From lib/content.ts, which is the one place a status is worded. A second wording here is
          // how the studio's chip starts disagreeing with the list filter.
          label: STATUS_LABELS[value] ?? value
        })),
        placeholder: `Any ${statusLabel.toLowerCase()}`
      });
    }

    for (const entry of selects ?? []) {
      list.push({
        key: entry.key,
        label: entry.label,
        options: entry.options,
        placeholder: entry.placeholder ?? `Any ${entry.label.toLowerCase()}`
      });
    }

    return list;
  }, [selects, status]);

  /**
   * The displayed state is the URL's, OVERLAID by the edit in flight.
   *
   * Holding only an overlay — rather than a full copy kept in sync with the URL — is what makes the
   * Back button work with no reconciliation at all: the moment `pending` is null the controls read
   * straight from the address bar again.
   */
  const [pending, setPending] = useState<ToolbarState | null>(null);
  const fromUrl = useMemo(
    () => readState(new URLSearchParams(serialised), groups, searchKey),
    [serialised, groups, searchKey]
  );
  const state = pending ?? fromUrl;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const serialisedRef = useRef(serialised);

  // Kept fresh in an effect rather than written during render: the commit below runs from a timer and
  // needs the query string as it is NOW, not as it was when the keystroke was typed.
  useEffect(() => {
    serialisedRef.current = serialised;
  }, [serialised]);

  useEffect(() => {
    // A newer edit is already queued. When its timer fires it writes a state that supersedes whatever
    // just landed, so dropping the draft here would silently lose those keystrokes.
    if (timerRef.current !== null) return;
    // Either our own write landed or somebody pressed Back. Both mean the URL is authoritative again.
    setPending(null);
  }, [serialised]);

  // A debounce that flushed on unmount would navigate as the reader leaves the screen.
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    []
  );

  const commit = (next: ToolbarState) => {
    setPending(next);
    if (timerRef.current !== null) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const current = serialisedRef.current;
      const query = buildQuery(next, current, groups, searchKey, resetParams);

      if (sameQuery(query, current)) {
        // Nothing actually changed — a dropdown set and unset inside one window. Navigating would
        // re-render the list for no reason, and leaving `pending` in place would freeze the controls on
        // a draft the URL is never going to confirm.
        setPending(null);
        return;
      }

      router.replace(query.length > 0 ? `${pathname}?${query}` : pathname, { scroll: false });
    }, Math.max(0, debounceMs));
  };

  const setValue = (key: string, value: string) =>
    commit({ ...state, values: { ...state.values, [key]: value } });

  const onSelectChange = (key: string) => (event: ChangeEvent<HTMLSelectElement>) =>
    setValue(key, event.target.value);

  const clearAll = () => commit({ q: "", values: {} });

  interface ActiveFilter {
    id: string;
    groupLabel: string;
    label: string;
    remove: () => void;
  }

  const active: ActiveFilter[] = [];
  if (search && searchKey && state.q.trim().length > 0) {
    active.push({
      id: "search",
      groupLabel: search.label,
      label: `“${state.q.trim()}”`,
      remove: () => commit({ ...state, q: "" })
    });
  }
  for (const group of groups) {
    const value = state.values[group.key] ?? "";
    if (value.length === 0) continue;
    const option = group.options.find((entry) => entry.value === value);
    active.push({
      id: `${group.key}:${value}`,
      groupLabel: group.label,
      // The raw value when no option matches — an unrecognised filter is still narrowing the list.
      label: option?.label ?? value,
      remove: () => setValue(group.key, "")
    });
  }

  return (
    <section aria-label={label} className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        {search ? (
          <SearchInput
            label={search.label}
            placeholder={search.placeholder}
            value={state.q}
            onValueChange={(value) => commit({ ...state, q: value })}
            className="sm:min-w-[16rem] sm:flex-1"
          />
        ) : null}

        {groups.map((group) => (
          // `Field` (a real `<label>`) is correct here and only here: the control is a NATIVE
          // `<select>`, so there is no button inside to swallow the forwarded click (Field.tsx).
          <Field key={group.key} label={group.label} className="sm:w-48" htmlFor={`${uid}${group.key}`}>
            <Select
              options={group.options}
              placeholder={group.placeholder}
              value={state.values[group.key] ?? ""}
              onChange={onSelectChange(group.key)}
            />
          </Field>
        ))}

        {children ? <div className="flex flex-wrap items-end gap-2">{children}</div> : null}
      </div>

      {active.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="field-label mr-1">Filtering by</p>

          {active.map((filter) => (
            // THE WHOLE CHIP IS THE REMOVE CONTROL. A 20px × inside a chip is a target nobody hits on a
            // laptop trackpad, and two controls per filter is twice the tab stops for one decision.
            <button key={filter.id} type="button" onClick={filter.remove} className={CHIP_ACTIVE}>
              <span>
                <span className="font-semibold">{filter.groupLabel}:</span> {filter.label}
              </span>
              <X aria-hidden="true" className="h-3.5 w-3.5" />
              <span className="sr-only"> — remove this filter</span>
            </button>
          ))}

          <button
            type="button"
            onClick={clearAll}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-ink-700 transition hover:bg-surface-100 hover:text-ink-900"
          >
            <FilterX aria-hidden="true" className="h-3.5 w-3.5" />
            Clear all
          </button>
        </div>
      ) : (
        // "Empty means everything", said out loud. Without this line the unfiltered state is an
        // absence, and an absence is not something a reader can see.
        <p className="text-xs text-ink-500">No filters are set, so everything is listed.</p>
      )}
    </section>
  );
}
