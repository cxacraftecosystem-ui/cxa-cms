"use client";

/**
 * FilterBar — the listing filter row: a search box, one or more closed lists, the active-filter
 * summary and Clear all.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE URL IS THE STATE. Every change is written back with `router.replace(…, { scroll: false })`,
 * so a filtered view is a link somebody can send, bookmark and come back to, and the Back button
 * walks the filters instead of leaving the page. `replace` and not `push`: each keystroke would
 * otherwise be a history entry and Back would spell the reader's query out backwards one letter at
 * a time. `scroll: false` because a filtered list must not throw the reader back to the top of the
 * page they were halfway down.
 *
 * ONE TIMER FOR EVERYTHING. The search box and every clicked chip share the SAME debounce, so there
 * is exactly one race to reason about instead of two systems taking turns to win. The cost is that a
 * chip commits a quarter of a second after it is pressed; the benefit is that typing and clicking
 * cannot interleave into a URL that reflects neither.
 *
 * EMPTY MEANS EVERYTHING. A group with nothing selected is ABSENT from the query string — never
 * serialised as "every option ticked". If the two were spelled the same way, "nothing ticked" and
 * "everything ticked" would be two states meaning one thing, and they would start to disagree the
 * moment a new option is added: an old bookmark that meant "all of them" would quietly mean "all of
 * them except the new one". The `All` chip is how the reader SEES that empty state.
 *
 * A VALUE IN THE URL THAT MATCHES NO OPTION IS STILL SHOWN, labelled with its raw value. It is
 * narrowing the list, so hiding it would leave a reader looking at a short list with no visible
 * reason for it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `useSearchParams()` OPTS A PAGE OUT OF STATIC RENDERING UNLESS IT SITS UNDER A `<Suspense>`. The
 * boundary is built into the exported `FilterBar` — a page can drop it in without knowing that, and
 * the listing itself (rendered on the server from `searchParams`) is still fully prerendered.
 */

import {
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ChangeEvent,
  type FormEvent
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Check, FilterX, X } from "lucide-react";

import { Field } from "@/components/ui/Field";
import { SearchInput } from "@/components/ui/SearchInput";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";

export interface FilterOption {
  /** What goes in the query string. Keep it a slug — it is a public, quotable URL. */
  value: string;
  label: string;
}

export interface FilterGroup {
  /** The query parameter this group owns. */
  key: string;
  /** The visible name — "Research area", "Year", "Type". */
  label: string;
  options: readonly FilterOption[];
  /** Several values at once, appended as repeated parameters (`?area=a&area=b`). */
  multiple?: boolean;
  /** `select` is a native closed list; `chips` is a row of toggles. Default: chips when `multiple`. */
  control?: "select" | "chips";
  /** The empty option's label on a `select`. Default "All <label>". */
  placeholder?: string;
  /** The "no narrowing" chip's label on a `chips` group. Default "All". */
  allLabel?: string;
}

export interface FilterSearchConfig {
  /** The query parameter. Default "q". */
  key?: string;
  /** REQUIRED — a search box's only accessible name. "Search publications", not "Search". */
  label: string;
  placeholder?: string;
}

export interface FilterBarProps {
  search?: FilterSearchConfig;
  groups?: readonly FilterGroup[];
  /**
   * Parameters dropped whenever a filter changes. Page 4 of an unfiltered list is not page 4 of a
   * filtered one, and landing on an empty page 4 looks exactly like a list with no records.
   */
  resetParams?: readonly string[];
  debounceMs?: number;
  /** Names the region for a screen reader. */
  label?: string;
  /**
   * Render the bar as a real `<form method="get" action={formAction}>` instead of a `<section>`, so
   * the SEARCH BOX WORKS WITHOUT JAVASCRIPT: the input gets `name`, Enter submits the browser's way,
   * and the server renders the filtered page from `searchParams`. With JavaScript present the submit
   * is intercepted and simply flushes the debounce — nothing else about the bar changes. Parameters
   * the bar does not own (a facet, a sort) ride along as hidden inputs, because a GET submission
   * replaces the whole query string; `resetParams` are deliberately NOT carried, exactly as a
   * debounced commit drops them.
   */
  formAction?: string;
  className?: string;
}

interface FilterState {
  q: string;
  /** Keyed by group key. An absent or empty array means "no narrowing" — see the header. */
  values: Record<string, string[]>;
}

const DEFAULT_SEARCH_KEY = "q";
const DEFAULT_RESET_PARAMS = ["page"] as const;
const DEFAULT_DEBOUNCE_MS = 250;

const EMPTY_GROUPS: readonly FilterGroup[] = [];

/** Complete literal class strings — a name assembled by concatenation is purged (contract §5). */
const CHIP_BASE =
  "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition";
const CHIP_OFF =
  "border-line-200 bg-card text-ink-700 hover:border-purple-300 hover:bg-purple-50 hover:text-purple-700";
const CHIP_ON = "border-purple-700 bg-purple-700 text-white hover:bg-purple-800";
const CHIP_ACTIVE_FILTER =
  "border-purple-200 bg-purple-50 text-purple-700 transition hover:border-purple-300 hover:bg-purple-100";

function controlOf(group: FilterGroup): "select" | "chips" {
  return group.control ?? (group.multiple ? "chips" : "select");
}

/** Read the whole bar's state out of a query string. The URL is the source of truth. */
function readState(
  params: URLSearchParams,
  groups: readonly FilterGroup[],
  searchKey: string | null
): FilterState {
  const values: Record<string, string[]> = {};
  for (const group of groups) {
    const found = params.getAll(group.key).filter((value) => value.length > 0);
    // A single-value group with two values in the URL is a hand-edited or stale link. The first one
    // wins, so the control and the summary cannot disagree about what is selected.
    values[group.key] = group.multiple ? found : found.slice(0, 1);
  }
  return { q: searchKey ? (params.get(searchKey) ?? "") : "", values };
}

/**
 * Build the next query string from `current`, so parameters this bar does not own — a `sort`, a
 * `view` — survive a filter change instead of being wiped by a filter row that never knew about them.
 */
function buildQuery(
  state: FilterState,
  current: string,
  groups: readonly FilterGroup[],
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
    for (const value of state.values[group.key] ?? []) {
      if (value.length > 0) next.append(group.key, value);
    }
  }

  return next.toString();
}

/**
 * Compare two query strings by MEANING, not by text. `buildQuery` deletes and re-appends the keys it
 * owns, so an unchanged filter set comes back in a different order; a string comparison would call
 * that a change and navigate on every keystroke.
 */
function sameQuery(a: string, b: string): boolean {
  const normalise = (input: string) =>
    [...new URLSearchParams(input).entries()]
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join("&");
  return normalise(a) === normalise(b);
}

function FilterBarControls({
  search,
  groups = EMPTY_GROUPS,
  resetParams = DEFAULT_RESET_PARAMS,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  label = "Filters",
  formAction,
  className
}: FilterBarProps) {
  const router = useRouter();
  /**
   * Whether the server is still producing the filtered list.
   *
   * ⚠ WITHOUT THIS THE BAR LIED BY OMISSION. `router.replace` re-renders the listing ON THE SERVER,
   * and until that round trip returns the reader is looking at the PREVIOUS results with the new
   * filter shown as selected. On a fast connection that is invisible; on a slow one it reads as
   * "the filter did not work", and the reader presses it again — which debounces into a third
   * navigation and makes it slower still.
   *
   * `useTransition` is what makes the round trip observable. It costs nothing when the response is
   * quick, because the state simply never has time to be seen.
   */
  const [isNavigating, startNavigation] = useTransition();
  const pathname = usePathname();
  const params = useSearchParams();
  const uid = useId();

  const serialised = params.toString();
  const searchKey = search ? (search.key ?? DEFAULT_SEARCH_KEY) : null;

  /**
   * The displayed state is the URL's, OVERLAID by the edit in flight.
   *
   * Holding only an overlay — rather than a full copy of the state kept in sync with the URL — is
   * what makes the back button work without any reconciliation: the moment `pending` is null the
   * controls read straight from the address bar again.
   */
  const [pending, setPending] = useState<FilterState | null>(null);
  const fromUrl = useMemo(
    () => readState(new URLSearchParams(serialised), groups, searchKey),
    [serialised, groups, searchKey]
  );
  const state = pending ?? fromUrl;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const serialisedRef = useRef(serialised);

  // Kept fresh in an effect rather than written during render: the commit below runs from a timer
  // and needs the query string as it is NOW, not as it was when the keystroke was typed.
  useEffect(() => {
    serialisedRef.current = serialised;
  }, [serialised]);

  useEffect(() => {
    // A newer edit is already queued. When its timer fires it writes a state that supersedes
    // whatever just landed, so dropping the draft here would silently lose those keystrokes.
    if (timerRef.current !== null) return;
    // Either our own write landed or somebody pressed Back. Both mean the URL is authoritative again.
    setPending(null);
  }, [serialised]);

  // A debounce that flushed on unmount would navigate as the reader leaves the page.
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    []
  );

  /** Navigate NOW to wherever `next` points. The timer's body, shared with the form's submit. */
  const flush = (next: FilterState) => {
    timerRef.current = null;
    const current = serialisedRef.current;
    const query = buildQuery(next, current, groups, searchKey, resetParams);

    if (sameQuery(query, current)) {
      // Nothing actually changed — a chip toggled on and off again inside one window. Navigating
      // would re-render the list for no reason, and leaving `pending` in place would freeze the
      // controls on a draft the URL is never going to confirm.
      setPending(null);
      return;
    }

    startNavigation(() => {
      router.replace(query.length > 0 ? `${pathname}?${query}` : pathname, { scroll: false });
    });
  };

  const commit = (next: FilterState) => {
    setPending(next);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => flush(next), Math.max(0, debounceMs));
  };

  /**
   * Only reachable with `formAction` set and JavaScript running — without JavaScript the browser
   * performs the GET itself, which is the point of the form. Intercepted rather than allowed: a
   * native submission is a full document load, which would drop scroll position and re-run every
   * script for a navigation `router.replace` does in place. Enter therefore means "search now",
   * skipping the quarter-second the debounce would otherwise add to an explicit action.
   */
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    flush(state);
  };

  const setSearch = (value: string) => commit({ ...state, q: value });

  const setGroupValues = (group: FilterGroup, values: string[]) =>
    commit({ ...state, values: { ...state.values, [group.key]: values } });

  const toggleValue = (group: FilterGroup, value: string) => {
    const current = state.values[group.key] ?? [];
    if (group.multiple) {
      setGroupValues(
        group,
        current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value]
      );
      return;
    }
    // Pressing the selected chip again clears the group — back to "everything", which is the only
    // other state a single-value filter has.
    setGroupValues(group, current[0] === value ? [] : [value]);
  };

  const onSelectChange = (group: FilterGroup) => (event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    setGroupValues(group, value.length > 0 ? [value] : []);
  };

  const clearAll = () => commit({ q: "", values: {} });

  const selectGroups = groups.filter((group) => controlOf(group) === "select");
  const chipGroups = groups.filter((group) => controlOf(group) === "chips");

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
    for (const value of state.values[group.key] ?? []) {
      const option = group.options.find((entry) => entry.value === value);
      active.push({
        id: `${group.key}:${value}`,
        groupLabel: group.label,
        // The raw value when no option matches — an unrecognised filter is still narrowing the list.
        label: option?.label ?? value,
        remove: () =>
          setGroupValues(
            group,
            (state.values[group.key] ?? []).filter((entry) => entry !== value)
          )
      });
    }
  }

  /**
   * Parameters this bar does NOT own, replayed as hidden inputs when it is a form. A GET submission
   * replaces the whole query string, so without these a no-JavaScript search would silently drop a
   * facet the reader had picked — where the debounced `buildQuery` path preserves it. `resetParams`
   * stay out on purpose: page 4 of one query is not page 4 of another.
   */
  const owned = new Set<string>([
    ...(searchKey ? [searchKey] : []),
    ...groups.map((group) => group.key),
    ...resetParams
  ]);
  const carried = formAction
    ? [...new URLSearchParams(serialised).entries()].filter(([key]) => !owned.has(key))
    : [];

  /*
   * `aria-busy` is the half of this a screen-reader user gets, and the dimming is the half a
   * sighted reader gets. Neither is decoration and neither is enough on its own (contract §11).
   *
   * The dimming is on the BAR, not on the results: the results are rendered by the server
   * component below and this client component cannot reach them — and dimming the thing the
   * reader is trying to read would be the wrong half to fade anyway. What they need to see is
   * that the CONTROL has been heard.
   */
  const rootClassName = cn(
    "flex flex-col gap-5 transition-opacity duration-200 ease-out",
    isNavigating && "opacity-60",
    className
  );

  const body = (
    <>
      {carried.map(([key, value], index) => (
        <input key={`${key}:${value}:${index}`} type="hidden" name={key} value={value} />
      ))}

      {search || selectGroups.length > 0 ? (
        <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end">
          {search ? (
            <SearchInput
              label={search.label}
              placeholder={search.placeholder}
              value={state.q}
              onValueChange={setSearch}
              // Named only inside a form: that is what a no-JavaScript GET submission carries.
              name={formAction && searchKey ? searchKey : undefined}
              className="sm:min-w-[18rem] sm:flex-1"
            />
          ) : null}

          {selectGroups.map((group) => (
            // `Field` (a real <label>) is correct here and only here: the control is a NATIVE
            // <select>, so there is no button inside to swallow the forwarded click (Field.tsx).
            <Field key={group.key} label={group.label} className="sm:w-56">
              <Select
                options={group.options}
                placeholder={group.placeholder ?? `All ${group.label.toLowerCase()}`}
                value={state.values[group.key]?.[0] ?? ""}
                onChange={onSelectChange(group)}
                // As with the search box: named inside a form so a no-JavaScript submit carries it.
                name={formAction ? group.key : undefined}
              />
            </Field>
          ))}
        </div>
      ) : null}

      {chipGroups.map((group) => {
        const selected = state.values[group.key] ?? [];
        const groupLabelId = `${uid}-${group.key}`;

        return (
          <div key={group.key} role="group" aria-labelledby={groupLabelId} className="min-w-0">
            <p id={groupLabelId} className="field-label">
              {group.label}
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              {/* "Empty means everything", made visible. Without this chip the cleared state is an
                  absence, and an absence is not something a reader can see or press. */}
              <button
                type="button"
                aria-pressed={selected.length === 0}
                onClick={() => setGroupValues(group, [])}
                className={cn(CHIP_BASE, selected.length === 0 ? CHIP_ON : CHIP_OFF)}
              >
                {selected.length === 0 ? (
                  <Check aria-hidden="true" className="h-3.5 w-3.5" />
                ) : null}
                {group.allLabel ?? "All"}
              </button>

              {group.options.map((option) => {
                const on = selected.includes(option.value);
                return (
                  <button
                    key={option.value}
                    type="button"
                    // `aria-pressed` carries the state to the accessibility tree and the tick carries
                    // it to anyone who cannot separate the fill from the border — colour never
                    // carries meaning alone (contract §11).
                    aria-pressed={on}
                    onClick={() => toggleValue(group, option.value)}
                    className={cn(CHIP_BASE, on ? CHIP_ON : CHIP_OFF)}
                  >
                    {on ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : null}
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      {active.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line-200 pt-4">
          <p className="field-label mr-1">Filtering by</p>

          {active.map((filter) => (
            // THE WHOLE CHIP IS THE REMOVE CONTROL. A 20px × inside a chip is a target nobody hits
            // on a phone, and two controls per filter (the chip and its ×) is twice the tab stops
            // for one decision.
            <button
              key={filter.id}
              type="button"
              onClick={filter.remove}
              className={cn(CHIP_BASE, CHIP_ACTIVE_FILTER)}
            >
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
            className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-ink-700 transition hover:bg-surface-100 hover:text-ink-900"
          >
            <FilterX aria-hidden="true" className="h-3.5 w-3.5" />
            Clear all
          </button>
        </div>
      ) : null}
    </>
  );

  // A form with an accessible name is a landmark exactly as the named `<section>` is, so a screen
  // reader loses nothing in the swap — and gains the announced form semantics.
  if (formAction) {
    return (
      <form
        action={formAction}
        method="get"
        onSubmit={onSubmit}
        aria-label={label}
        aria-busy={isNavigating || undefined}
        className={rootClassName}
      >
        {body}
      </form>
    );
  }

  return (
    <section aria-label={label} aria-busy={isNavigating || undefined} className={rootClassName}>
      {body}
    </section>
  );
}

/**
 * The boundary lives here so no page has to remember it. During a static prerender the fallback is
 * what lands in the HTML; the listing beside it is server-rendered from `searchParams` and is fully
 * present, so a reader with no JavaScript still gets the filtered list — they simply cannot change it
 * from a statically-rendered bar. A DYNAMIC page that also passes `formAction` closes that last gap:
 * the boundary resolves on the server there, so the no-JavaScript reader receives a real GET form and
 * can submit it (the /search page is the one that needs this — its box is the page).
 */
export function FilterBar(props: FilterBarProps) {
  return (
    <Suspense
      fallback={
        <div className={cn("flex flex-col gap-4", props.className)}>
          <Skeleton height="2.75rem" label="Loading filters…" />
        </div>
      }
    >
      <FilterBarControls {...props} />
    </Suspense>
  );
}
