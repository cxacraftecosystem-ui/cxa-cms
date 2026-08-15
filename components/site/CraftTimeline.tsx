"use client";

/**
 * CraftTimeline — the period control: a scrubber over `Craft.originYear`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * TWO REAL SLIDERS, NOT ONE DRAGGABLE BAR.
 *
 * A two-handled bar built from `<div>`s is a control a keyboard cannot operate, voice control cannot
 * name and a screen reader announces as nothing at all. Two `<input type="range">`s — "Earliest year"
 * and "Latest year" — give arrow keys, Home/End, Page Up/Down and a spoken value for free, and each
 * one's `min`/`max` is bounded by the other's current position, so the window can never invert.
 *
 * `aria-valuetext` IS NOT OPTIONAL HERE. The slider's value for the Indus valley is `-2600`, and
 * "minus two thousand six hundred" is not a date anybody recognises. The text says "2600 BCE", which
 * is why the column is a signed integer rather than a string in the first place (prisma/schema.prisma
 * on `Craft.originYear`).
 *
 * NARROWING THE WINDOW EXCLUDES CRAFTS WITH NO RECORDED YEAR, AND SAYS SO WITH A NUMBER. "Sometime in
 * the medieval period" is a real answer and a made-up year would be worse than none — but a craft with
 * no year cannot honestly be inside a window of 1700–1800 either. So they drop out, and the count of
 * what dropped out is printed rather than left for the reader to notice (contract §1.6).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE URL IS THE STATE, exactly as `FilterBar` holds it: one debounce, `router.replace` so a drag does
 * not write forty history entries, `scroll: false` so the page does not jump to the top of a list the
 * reader is halfway down, and an absent parameter meaning "not narrowed" rather than a parameter
 * spelling out the full range. The displayed value is the URL's, OVERLAID by the drag in flight — the
 * moment the overlay is dropped the handles read straight from the address bar again, which is what
 * makes the Back button walk the window with no reconciliation.
 *
 * `useSearchParams()` OPTS A PAGE OUT OF STATIC RENDERING UNLESS IT SITS UNDER A `<Suspense>`. The
 * boundary is inside the export, as it is in FilterBar, so a page can drop this in without knowing.
 */

import {
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { History, RotateCcw } from "lucide-react";

import { Skeleton } from "@/components/ui/Skeleton";
import { clamp, cn } from "@/lib/utils";

/** One bar of the distribution strip. */
export interface CraftTimelineBucket {
  /** Inclusive. Negative is BCE. */
  start: number;
  /** Inclusive. */
  end: number;
  count: number;
}

export interface CraftTimelineProps {
  /** The earliest and latest `originYear` in the whole published corpus. */
  min: number;
  max: number;
  /** The window in force. Equal to `min`/`max` when nothing is narrowed. */
  from: number;
  to: number;
  /** How many published crafts carry an origin year at all — the corpus, not the current selection. */
  datedCount: number;
  /** How many crafts in the CURRENT selection carry no origin year, whatever the window is. */
  undatedCount: number;
  /** How many of the crafts currently listed were excluded by this window. */
  excludedByWindow?: number;
  /** The distribution. Decorative — every number it encodes is also written as text. */
  buckets?: readonly CraftTimelineBucket[];
  /** Query keys. Must match what the page reads. */
  fromParam?: string;
  toParam?: string;
  className?: string;
}

const DEBOUNCE_MS = 300;

/** The shortest bar the strip will draw. A bucket that rounds to no height reads as an empty century. */
const MIN_BAR_PERCENT = 6;

interface YearWindow {
  from: number;
  to: number;
}

/**
 * A year as a reader would say it.
 *
 * "CE" is appended only when the corpus actually reaches back before year zero — on an archive whose
 * earliest record is 1740, "1740 CE" is pedantry, and on one that starts at 2600 BCE a bare "400" is
 * ambiguous.
 */
function formatYear(year: number, spansBce: boolean): string {
  if (year < 0) return `${Math.abs(year)} BCE`;
  return spansBce ? `${year} CE` : String(year);
}

/** Compare two query strings by MEANING: the keys are deleted and re-appended, so order shifts. */
function sameQuery(a: string, b: string): boolean {
  const normalise = (input: string) =>
    [...new URLSearchParams(input).entries()]
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join("&");
  return normalise(a) === normalise(b);
}

function CraftTimelineControls({
  min,
  max,
  from,
  to,
  datedCount,
  undatedCount,
  excludedByWindow = 0,
  buckets = [],
  fromParam = "from",
  toParam = "to",
  className
}: CraftTimelineProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const uid = useId();

  const serialised = params.toString();
  const [pending, setPending] = useState<YearWindow | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const serialisedRef = useRef(serialised);

  // Kept fresh in an effect rather than read during render: the commit runs from a timer and needs the
  // query string as it is NOW, not as it was when the handle was first dragged.
  useEffect(() => {
    serialisedRef.current = serialised;
  }, [serialised]);

  useEffect(() => {
    // A newer drag is already queued; dropping the overlay here would snap the handles back under the
    // reader's finger.
    if (timerRef.current !== null) return;
    setPending(null);
  }, [serialised]);

  // A debounce that flushed on unmount would navigate as the reader leaves the page.
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    []
  );

  const spansBce = min < 0;
  // NOT named `window`: a local of that name shadows the global one, and the first line of code in
  // here that reaches for `window.requestAnimationFrame` would read an object with two year fields.
  const active: YearWindow = pending ?? { from, to };
  const narrowed = active.from > min || active.to < max;

  const commit = (next: YearWindow, immediate = false) => {
    setPending(next);
    if (timerRef.current !== null) clearTimeout(timerRef.current);

    const write = () => {
      timerRef.current = null;
      const current = serialisedRef.current;
      const query = new URLSearchParams(current);

      query.delete(fromParam);
      query.delete(toParam);
      // Page 4 of a wider window is not page 4 of a narrower one.
      query.delete("page");

      // ABSENT MEANS "NOT NARROWED". Writing the full range out would make "the whole archive" and
      // "the whole archive as it stood in March" two different URLs, and an old link would quietly
      // start excluding anything recorded outside the range it was bookmarked with.
      if (next.from > min) query.set(fromParam, String(next.from));
      if (next.to < max) query.set(toParam, String(next.to));

      const serialisedNext = query.toString();
      if (sameQuery(serialisedNext, current)) {
        // The handle came back to where it started inside one window. Navigating would re-render the
        // list for nothing, and leaving the overlay in place would freeze the handles on a value the
        // URL is never going to confirm.
        setPending(null);
        return;
      }

      router.replace(
        serialisedNext.length > 0 ? `${pathname}?${serialisedNext}` : pathname,
        { scroll: false }
      );
    };

    if (immediate) {
      write();
      return;
    }
    timerRef.current = setTimeout(write, DEBOUNCE_MS);
  };

  const onEarliestChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = Number.parseInt(event.target.value, 10);
    if (!Number.isFinite(value)) return;
    commit({ from: clamp(value, min, active.to), to: active.to });
  };

  const onLatestChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = Number.parseInt(event.target.value, 10);
    if (!Number.isFinite(value)) return;
    commit({ from: active.from, to: clamp(value, active.from, max) });
  };

  const groupLabelId = `${uid}timeline`;
  const earliestId = `${uid}earliest`;
  const latestId = `${uid}latest`;

  /**
   * The undated. Worded differently in the two states, because they are two different facts: while the
   * window is narrowed these crafts have been EXCLUDED, and while it is not they are simply in the list
   * without a place on the timeline. One sentence covering both would have to be vague about which.
   */
  const undatedSentence =
    undatedCount > 0 ? (
      narrowed ? (
        <>
          {undatedCount} {undatedCount === 1 ? "craft" : "crafts"} matching the other filters{" "}
          {undatedCount === 1 ? "has" : "have"} no recorded origin year, so{" "}
          {undatedCount === 1 ? "it is" : "they are"} not shown while the timeline is narrowed — a
          craft with no date cannot honestly be placed inside a window.
        </>
      ) : (
        <>
          {undatedCount} {undatedCount === 1 ? "craft" : "crafts"} in this selection{" "}
          {undatedCount === 1 ? "has" : "have"} no recorded origin year.{" "}
          {undatedCount === 1 ? "It is" : "They are"} in the list, and not on this timeline.
        </>
      )
    ) : null;

  return (
    <section
      aria-labelledby={groupLabelId}
      className={cn("rounded-lg border border-line-200 bg-surface-50 p-5", className)}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p id={groupLabelId} className="field-label flex items-center gap-1.5">
            <History aria-hidden="true" className="h-3.5 w-3.5" />
            Period
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-700">
            {datedCount === 0
              ? "No published craft has a recorded origin year yet, so there is nothing to place on a timeline."
              : narrowed
                ? `Showing crafts dated between ${formatYear(active.from, spansBce)} and ${formatYear(active.to, spansBce)}.`
                : `${datedCount} dated ${datedCount === 1 ? "craft" : "crafts"}, from ${formatYear(min, spansBce)} to ${formatYear(max, spansBce)}.`}
          </p>
        </div>

        {narrowed ? (
          <button
            type="button"
            onClick={() => commit({ from: min, to: max }, true)}
            className="field-button-ghost"
          >
            <RotateCcw aria-hidden="true" className="h-4 w-4 shrink-0" />
            Whole period
          </button>
        ) : null}
      </div>

      {datedCount > 0 && max > min ? (
        <>
          {buckets.length > 0 ? (
            <DistributionStrip buckets={buckets} range={active} className="mt-5" />
          ) : null}

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={earliestId} className="field-label block">
                Earliest year
              </label>
              <input
                id={earliestId}
                type="range"
                min={min}
                // Bounded by the other handle, so the window cannot invert and no code has to repair
                // it afterwards.
                max={active.to}
                step={1}
                value={active.from}
                onChange={onEarliestChange}
                aria-valuetext={formatYear(active.from, spansBce)}
                className="mt-2 w-full accent-purple-700"
              />
              <p aria-hidden="true" className="mt-1 text-sm font-medium tabular-nums text-ink-900">
                {formatYear(active.from, spansBce)}
              </p>
            </div>

            <div>
              <label htmlFor={latestId} className="field-label block">
                Latest year
              </label>
              <input
                id={latestId}
                type="range"
                min={active.from}
                max={max}
                step={1}
                value={active.to}
                onChange={onLatestChange}
                aria-valuetext={formatYear(active.to, spansBce)}
                className="mt-2 w-full accent-purple-700"
              />
              <p aria-hidden="true" className="mt-1 text-sm font-medium tabular-nums text-ink-900">
                {formatYear(active.to, spansBce)}
              </p>
            </div>
          </div>
        </>
      ) : null}

      {undatedSentence || excludedByWindow > 0 ? (
        <div className="mt-4 flex flex-col gap-2 border-t border-line-200 pt-4 text-sm leading-relaxed text-ink-500">
          {excludedByWindow > 0 ? (
            <p>
              {excludedByWindow} dated {excludedByWindow === 1 ? "craft falls" : "crafts fall"} outside
              this window and {excludedByWindow === 1 ? "is" : "are"} not listed.
            </p>
          ) : null}
          {undatedSentence ? <p>{undatedSentence}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The distribution above the handles.
 *
 * `aria-hidden`, and it is allowed to be: it encodes nothing that is not already a sentence above it
 * — how many crafts are dated, and between which two years the window sits. A chart is a shape, and a
 * shape read out bucket by bucket is thirty announcements nobody asked for.
 */
function DistributionStrip({
  buckets,
  range,
  className
}: {
  buckets: readonly CraftTimelineBucket[];
  range: YearWindow;
  className?: string;
}) {
  const busiest = buckets.reduce((highest, bucket) => Math.max(highest, bucket.count), 0);
  if (busiest === 0) return null;

  return (
    <div aria-hidden="true" className={cn("flex h-16 items-end gap-0.5", className)}>
      {buckets.map((bucket) => {
        // A bucket counts as inside when it overlaps the window at all: a century bar half inside a
        // window is not evidence of an empty century.
        const inside = bucket.end >= range.from && bucket.start <= range.to;
        const height =
          bucket.count === 0
            ? 0
            : Math.max(MIN_BAR_PERCENT, Math.round((bucket.count / busiest) * 100));

        return (
          <span
            key={`${bucket.start}:${bucket.end}`}
            // Inline, because a height computed from data cannot be a Tailwind class — an arbitrary
            // `h-[37%]` assembled at runtime is purged by the content scanner (contract §5).
            style={{ height: `${height}%` }}
            className={cn(
              "min-h-px flex-1 rounded-sm",
              inside ? "bg-purple-700" : "bg-surface-300"
            )}
          />
        );
      })}
    </div>
  );
}

export function CraftTimeline(props: CraftTimelineProps) {
  return (
    <Suspense
      fallback={
        <div className={cn("rounded-lg border border-line-200 bg-surface-50 p-5", props.className)}>
          <Skeleton lines={2} label="Loading the period control…" />
        </div>
      }
    >
      <CraftTimelineControls {...props} />
    </Suspense>
  );
}
