"use client";

/**
 * Type a village, move the map. The one affordance that makes a coordinate picker usable in rural India.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ PORTED FROM `D:/Portal_Development_Designer/frontend/components/forms/PlaceSearchBox.tsx`. The
 * behaviour and the reasoning are that file's. What changed is the import of the geocoder
 * (`@/lib/geo/placeSearch` here) and the wording of the argument below, which is STRONGER in this product
 * than in the one it came from — see the firewall note.
 *
 * A SEARCH RESULT MOVES THE CAMERA AND WRITES NOTHING. This is the load-bearing rule, not a detail, and it
 * is why `onChoose` hands back a `PlaceHit` — a point and an extent — rather than an address: there is
 * nothing here a record could be filled in from. The coordinate that reaches a record is still the one an
 * editor places by hand afterwards. The geocoder may offer a value; a person accepts it.
 *
 * ⚠ WHY IT STOPS `input` AND `keydown` FROM LEAVING IT, AND WHY THAT MATTERS MORE HERE. In the product this
 * came from, an unfirewalled search box armed an unsaved-changes prompt on a form nobody had edited. This
 * studio AUTOSAVES (contract §10): a real text box inside a section or record form, whose `onInput` bubbles,
 * would make merely typing "Barpali" to LOOK at the map queue an actual WRITE of the record. Enter is worse
 * — it would reach the form's own handler and either walk focus out of the search or submit, from a box
 * whose entire job is to look at a map without touching anything.
 *
 * IT DOES NOT TRAP FOCUS, on purpose: Tab leaves, Escape dismisses. A picker that swallows the keyboard is
 * worse than no picker.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { LoaderCircle, Search } from "lucide-react";

import {
  MIN_QUERY_LENGTH,
  describeSearchFailure,
  placeSearchAvailable,
  searchPlaces,
  type PlaceHit
} from "@/lib/geo/placeSearch";
import { cn } from "@/lib/utils";

/**
 * The pause after the last keystroke before anything is sent.
 *
 * A request per keystroke is eight requests to spell "Barpali", each one billed and each one carried by the
 * connection this whole feature exists for. 350 ms is longer than a touch-typist's gap between letters and
 * shorter than the pause someone makes when they have finished a word.
 */
const DEBOUNCE_MS = 350;

/** Where the search is up to. `short` is not a failure — it is the box waiting to be worth asking. */
type SearchState = "idle" | "short" | "searching" | "done" | "failed";

export interface PlaceSearchBoxProps {
  /**
   * Where the map is looking, read at REQUEST time rather than passed as a value.
   *
   * A prop would have to be state, state would have to be updated as the editor pans, and updating state
   * on `move` re-renders the component that owns a MapLibre canvas on every frame of a drag. Reading it
   * through a callback the moment a request goes out costs nothing and biases the search to exactly where
   * the editor is looking when they ask.
   */
  getProximity?: () => { lon: number; lat: number } | null;
  /** Move the map. MUST NOT write a record value — see the header. */
  onChoose: (hit: PlaceHit) => void;
  label?: string;
  disabled?: boolean;
}

export function PlaceSearchBox({
  getProximity,
  onChoose,
  label = "Search for a place",
  disabled
}: PlaceSearchBoxProps) {
  const baseId = useId();
  const inputId = `${baseId}-input`;
  const listboxId = `${baseId}-listbox`;

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [state, setState] = useState<SearchState>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const request = useRef<AbortController | null>(null);

  /*
   * The two callbacks, held in refs and read through them.
   *
   * Both close over the map's owner and change identity on every render of the form around it, so as
   * dependencies of the search effect below they would cancel and restart the in-flight request every time
   * a neighbouring field re-rendered — a fresh geocoding call per keystroke in a box that is not even this
   * one. `MapPointPicker` holds its `onPick` the same way and for the same reason.
   */
  const proximityRef = useRef(getProximity);
  const chooseRef = useRef(onChoose);
  useEffect(() => {
    proximityRef.current = getProximity;
    chooseRef.current = onChoose;
  }, [getProximity, onChoose]);

  // Debounced, abortable, and re-armed by the query alone. The previous request is cancelled as the next
  // keystroke lands, so a slow answer for "Barp" can never overwrite the list for "Barpali".
  useEffect(() => {
    const wanted = query.trim();
    request.current?.abort();

    if (wanted.length < MIN_QUERY_LENGTH) {
      setHits([]);
      setProblem(null);
      setState(wanted ? "short" : "idle");
      return;
    }

    setState("searching");
    const timer = window.setTimeout(() => {
      const controller = new AbortController();
      request.current = controller;
      searchPlaces(wanted, { signal: controller.signal, proximity: proximityRef.current?.() ?? null })
        .then((found) => {
          // An abort is a newer keystroke, never an answer. Rendering it would put a stale list under a
          // query that has moved on.
          if (controller.signal.aborted) return;
          setHits(found);
          setProblem(null);
          setState("done");
          setHighlight(0);
          setOpen(true);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setHits([]);
          setProblem(describeSearchFailure(error));
          setState("failed");
          setOpen(true);
        });
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [query]);

  // A panel closed by unmounting must not leave a request running on a metered connection.
  useEffect(() => () => request.current?.abort(), []);

  // Dismissal by pointer, on `mousedown` so the list is gone before the click's target can move under it.
  // Bound to the document because the click that dismisses is by definition somewhere else.
  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);

  // Derived every render, never trusted from state: a stored index goes stale the instant a slower query
  // lands a shorter list, and Enter would then fly the map to a row nobody could see.
  const safeHighlight = highlight >= 0 && highlight < hits.length ? highlight : 0;

  const choose = useCallback((hit: PlaceHit) => {
    chooseRef.current(hit);
    setOpen(false);
  }, []);

  /**
   * The listbox's one line when it has no rows, and the sentence the live region reads out.
   *
   * FOUR OUTCOMES, KEPT APART, because the editor's next move differs in every one: wait, type more, try a
   * different name, or stop trying and place the pin by hand. "No results" for all four is the failure this
   * branch exists to avoid — somebody with one bar of signal being told the village does not exist.
   */
  const status =
    state === "short"
      ? `Type at least ${MIN_QUERY_LENGTH} letters to search.`
      : state === "searching"
        ? "Searching…"
        : state === "failed"
          ? (problem ?? "The place search did not answer.")
          : state === "done"
            ? hits.length
              ? `${hits.length} place${hits.length === 1 ? "" : "s"} found. Use the arrow keys to review them.`
              : `No place in India is called “${query.trim()}”. Check the spelling, try the nearest town, or place the pin by hand.`
            : "";

  // No key, no tiles, and nothing to move. The callers hide the whole map in that case, so this is the belt
  // to that braces — and it names which thing is missing rather than rendering a box that could only fail.
  if (!placeSearchAvailable()) {
    return (
      <p className="text-xs leading-5 text-ink-500">
        Place search needs NEXT_PUBLIC_MAPTILER_API_KEY, which this build does not have. Pan the map, or type
        the coordinates in.
      </p>
    );
  }

  return (
    <div
      ref={wrapperRef}
      className="relative grid gap-1"
      // The firewall. See the header: without it, typing a place name to look at the map would queue an
      // autosave of a record nobody has edited.
      onInput={(event) => event.stopPropagation()}
    >
      <label htmlFor={inputId} className="field-label">
        {label}
      </label>

      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-500"
        />
        <input
          id={inputId}
          className="field-input pl-9 pr-9"
          type="text"
          role="combobox"
          autoComplete="off"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-describedby={`${baseId}-hint`}
          aria-activedescendant={open && hits.length ? `${baseId}-opt-${safeHighlight}` : undefined}
          placeholder="Village, town or district"
          value={query}
          disabled={disabled}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlight(0);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setHighlight((current) => Math.min(current + 1, Math.max(0, hits.length - 1)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setHighlight((current) => Math.max(current - 1, 0));
            } else if (event.key === "Enter") {
              // Stopped unconditionally, INCLUDING when there is nothing to choose. A bare Enter would
              // reach the form above and either walk focus out of the search or submit the record.
              event.preventDefault();
              event.stopPropagation();
              const hit = hits[safeHighlight];
              if (open && hit) choose(hit);
            } else if (event.key === "Escape") {
              // Consumed only when this component actually had something open, so Escape still reaches a
              // dialog hosting the map when the list is already dismissed.
              if (open) {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
              }
            }
          }}
        />
        {state === "searching" ? (
          <LoaderCircle
            aria-hidden="true"
            className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-ink-500"
          />
        ) : null}
      </div>

      {/*
        THE PROMISE, IN THE PLACE IT IS MADE. An editor has every reason to expect a search box on a
        location form to fill the location in — so the box says, before they use it, that it does not.
      */}
      <p id={`${baseId}-hint`} className="text-xs leading-5 text-ink-500">
        Searching only moves the map. Nothing is filled in until you place the pin yourself.
      </p>

      {/*
        How many results there are, for a reader who cannot see the list appear. `polite` because it fires
        on every settled query and must never interrupt typing. Rendered whether or not it has anything to
        say: assistive technology only announces mutations inside a region that already existed.
      */}
      <span className="sr-only" role="status" aria-live="polite">
        {open ? status : ""}
      </span>

      {open && state !== "idle" ? (
        // z-10 is the ladder's rung for in-page chrome; the map's own controls are inside the canvas below.
        <div className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-md border border-line-200 bg-card shadow-panel">
          <ul id={listboxId} role="listbox" aria-label={label} className="max-h-72 overflow-y-auto">
            {hits.length ? (
              hits.map((hit, index) => (
                <li
                  key={hit.id}
                  id={`${baseId}-opt-${index}`}
                  role="option"
                  aria-selected={index === safeHighlight}
                >
                  <button
                    type="button"
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition",
                      index === safeHighlight ? "bg-purple-50" : "hover:bg-surface-50"
                    )}
                    onMouseEnter={() => setHighlight(index)}
                    onClick={() => choose(hit)}
                  >
                    <span className="w-full truncate text-sm text-ink-900">{hit.name}</span>
                    {hit.context ? (
                      <span className="w-full truncate text-xs text-ink-500">{hit.context}</span>
                    ) : null}
                  </button>
                </li>
              ))
            ) : (
              <li
                data-place-search-status
                className={cn(
                  "px-3 py-3 text-sm",
                  state === "failed" ? "font-medium text-error-600" : "text-ink-500"
                )}
              >
                {status}
              </li>
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
