"use client";

/**
 * Calendar — the month grid, ported from D:/Portal_Development_Designer/frontend/components/ui/calendar.tsx.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE SOURCE IS react-day-picker AND THIS IS NOT. THAT IS THE WHOLE PORT.
 *
 * The Design Workshop's calendar is a `<DayPicker>` with every visible part re-skinned onto the
 * tokens — a hundred and eighty lines of `classNames` over a library that does the grid, the
 * keyboard, the ranges and the locale. That library is not in this repository, and adding it costs
 * `react-day-picker@10` (~34 KB gzipped, plus `react-day-picker/style.css` which has to be imported
 * from a client component and then fought with, because the port's own header describes two layers of
 * theming fighting `app/globals.css` over `.rdp-root`). This repository has `date-fns` already but
 * nothing that pulls in a date-picker, and the studio needs exactly one shape: a month grid.
 *
 * So the LOOK is ported exactly — the same 36px cells, the same 12px day pill, the same purple-700
 * selection, the same purple-50/purple-950 hover, the same ringed "today" that is findable without
 * colour vision, the same ink-300 out-of-month days, the same edge-to-edge range band with the pill
 * riding inside it — and the MECHANISM is written here. What is deliberately NOT ported is the
 * `ROOT_VARS` block: those thirty CSS custom properties exist to reach react-day-picker's internals,
 * and with no library underneath there is nothing for them to reach.
 *
 * WHAT THIS GAINS OVER THE SOURCE, because a port that only loses things is not worth making:
 *   • The grid is ALWAYS SIX WEEKS TALL. A month that fits in five rows still renders six, so the
 *     calendar never changes height between months. In the source it does, and inside a `Popover`
 *     that height change is seen by the ResizeObserver, which repositions the panel — so paging from
 *     February to March made the whole popover jump.
 *   • It carries no stylesheet, so nothing it does can leak onto a page that merely renders a date.
 *
 * WHAT IT DOES NOT DO, said plainly rather than discovered: no multi-month view, no year dropdown, no
 * week numbers, no locale beyond the browser's own (`Intl`). The source supports all four through
 * DayPicker props. If any of them is actually needed, that is the moment to reconsider the dependency
 * — not now, on the strength of a maybe.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ACCESSIBILITY IS THE PART A HAND-BUILT GRID USUALLY GETS WRONG, so it is spelled out. The grid is a
 * real `<table role="grid">`; selection lives on the `gridcell`, because `aria-selected` is not
 * supported on `role="button"` and would be silently ignored there. There is ONE tab stop in the
 * whole month (roving `tabIndex`), so Tab walks past the calendar in one press instead of thirty-five;
 * inside it the arrow keys move by a day, PageUp/PageDown by a month, and Home/End to the ends of the
 * week. Today carries a ring as well as a tint, so it is findable without colour vision.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { motion } from "framer-motion";

import { cn } from "@/lib/utils";
import { DURATION, EASE_OUT, useReducedMotionPreference } from "@/components/motion";

export interface DateRange {
  from: Date | null;
  to: Date | null;
}

/**
 * Midnight local time on the same day.
 *
 * ⚠ EVERY DATE IN THIS FILE IS LOCAL MIDNIGHT AND NOTHING COMPARES TIMESTAMPS. A calendar that
 * compares `getTime()` on dates carrying a time of day reports "not the same day" for two values a
 * few hours apart, which is how a picker ends up refusing to highlight the day the caller told it was
 * selected. Local rather than UTC because the grid is a picture of the reader's own calendar — in
 * Kolkata, `new Date().toISOString().slice(0, 10)` is yesterday for five and a half hours every day.
 */
function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isSameDay(a: Date | null | undefined, b: Date | null | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

/**
 * `n` days on from `date`.
 *
 * `setDate` past the end of a month rolls into the next one, which is exactly what is wanted, and it
 * is also DST-safe in a way that `+ n * 86400000` is not: on the two days a year a local day is 23 or
 * 25 hours long, adding a fixed number of milliseconds lands on the wrong date.
 */
function addDays(date: Date, n: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
  return next;
}

/**
 * `n` months on from `date`, clamped to the last day of the target month.
 *
 * ⚠ WITHOUT THE CLAMP, 31 JANUARY PLUS ONE MONTH IS 3 MARCH. `setMonth` overflows rather than
 * saturating, so paging forward from a 31-day month skips February entirely — and paging back lands
 * somewhere different again, so the reader cannot get where they were by pressing the other arrow.
 */
function addMonths(date: Date, n: number): Date {
  const target = new Date(date.getFullYear(), date.getMonth() + n, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), lastDay));
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * Always SIX weeks, starting on the Sunday or Monday before the 1st.
 *
 * Six rather than "as many as the month needs" is what keeps the calendar a fixed height — see the
 * header for the popover that jumped. The extra row is out-of-month days, which are drawn in ink-300
 * and are still selectable, exactly as in the source.
 */
const WEEKS = 6;
const DAYS_IN_WEEK = 7;

function buildGrid(month: Date, weekStartsOn: 0 | 1): Date[] {
  const first = startOfMonth(month);
  // `(day - weekStartsOn + 7) % 7` rather than a subtraction, because Sunday is 0 and a Monday-start
  // week needs six days of lead-in for it, not minus one.
  const lead = (first.getDay() - weekStartsOn + DAYS_IN_WEEK) % DAYS_IN_WEEK;
  const start = addDays(first, -lead);
  return Array.from({ length: WEEKS * DAYS_IN_WEEK }, (_, index) => addDays(start, index));
}

/**
 * Weekday headings in the reader's own locale, derived rather than hard-coded.
 *
 * A hard-coded ["Mon", …] is wrong in every locale but English and is the sort of thing nobody
 * notices until the site is shown to somebody it was not written for. 2024-01-07 is a Sunday, so
 * indexing from it gives the seven names in order whatever the week starts on.
 */
function weekdayNames(weekStartsOn: 0 | 1): { short: string; long: string }[] {
  const shortFormat = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  const longFormat = new Intl.DateTimeFormat(undefined, { weekday: "long" });
  const knownSunday = new Date(2024, 0, 7);
  return Array.from({ length: DAYS_IN_WEEK }, (_, index) => {
    const day = addDays(knownSunday, (index + weekStartsOn) % DAYS_IN_WEEK);
    return { short: shortFormat.format(day), long: longFormat.format(day) };
  });
}

/**
 * The day pill, ported class for class from the source's `DAY_BUTTON`.
 *
 * `focus-visible` rather than `focus`: the arrow keys move focus around this grid constantly, and a
 * ring that also fired on pointer-driven focus would flash on every single click.
 */
const DAY_BUTTON =
  "relative mx-auto flex h-9 w-9 items-center justify-center rounded-md text-sm tabular-nums outline-none transition-colors " +
  "focus-visible:ring-2 focus-visible:ring-purple-700 focus-visible:ring-offset-1 focus-visible:ring-offset-card";

/** Shared by the two month-navigation buttons. Ported from the source's `NAV_BUTTON`. */
const NAV_BUTTON =
  "inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-700 outline-none transition-colors " +
  "hover:bg-purple-50 hover:text-purple-700 dark:hover:bg-purple-950 dark:hover:text-purple-200 " +
  "focus-visible:ring-2 focus-visible:ring-purple-700 focus-visible:ring-offset-2 focus-visible:ring-offset-card " +
  "disabled:pointer-events-none disabled:text-ink-300";

/**
 * The day's appearance, as COMPLETE LITERAL CLASS STRINGS chosen by a lookup.
 *
 * Never assembled — a `bg-purple-${shade}` would be purged by the content scanner (contract §5). The
 * order the caller applies them in is the precedence: a selected day is painted as selected even when
 * it is also today and also outside the month, which is what the source achieves with its
 * `[&:not([data-selected])]` guards.
 *
 * ⚠ EVERY PURPLE HERE NEEDS AN EXPLICIT `dark:` PARTNER, and this is the part of the port that is
 * easiest to drop. The purple ramp is brand colour and DOES NOT invert with the theme (tailwind.config.ts:
 * "purple-700 is THE action colour and never inverts"), so purple-50 is near-white in both modes — as a
 * hover it painted a white bar across a dark calendar, and purple-700 text on a dark card is unreadable.
 * The counterparts below are the ones the source landed on, and they are the same ones the searchable
 * dropdown in components/ui/Select.tsx uses, so a menu and a calendar highlight identically.
 */
const DAY_STATE = {
  selected: "bg-purple-700 font-semibold text-white hover:bg-purple-700 dark:hover:bg-purple-700",
  rangeMiddle: "rounded-none font-normal text-ink-900 hover:bg-purple-100 dark:hover:bg-purple-900",
  today:
    "font-semibold text-purple-700 ring-1 ring-inset ring-purple-200 hover:bg-purple-50 " +
    "dark:text-purple-300 dark:ring-purple-800 dark:hover:bg-purple-950",
  outside: "font-normal text-ink-300 hover:bg-purple-50 dark:hover:bg-purple-950",
  normal: "text-ink-900 hover:bg-purple-50 dark:hover:bg-purple-950",
  disabled: "cursor-not-allowed text-ink-300 hover:bg-transparent dark:hover:bg-transparent"
} as const;

/** The band a range paints on the CELL, so it runs edge to edge while the pill stays 36px inside it. */
const CELL_STATE = {
  none: "",
  start: "rounded-l-md bg-purple-50 dark:bg-purple-950",
  middle: "bg-purple-50 dark:bg-purple-950",
  end: "rounded-r-md bg-purple-50 dark:bg-purple-950",
  both: "rounded-md bg-purple-50 dark:bg-purple-950"
} as const;

type CellBand = keyof typeof CELL_STATE;

interface CalendarBaseProps {
  /** The visible month, controlled. Omit to let the calendar page on its own. */
  month?: Date;
  defaultMonth?: Date;
  onMonthChange?: (month: Date) => void;
  /** Days before this / after this cannot be chosen. Compared by DAY, not by timestamp. */
  min?: Date;
  max?: Date;
  /** Anything else that cannot be chosen — a booked-out day, a closed date. */
  isDisabled?: (date: Date) => boolean;
  /** 0 is Sunday, 1 is Monday. Not derived from the locale: `Intl` still does not expose it reliably. */
  weekStartsOn?: 0 | 1;
  /** The grid's accessible name — "Start date", "Filter from". Say which date, not "Calendar". */
  label?: string;
  className?: string;
}

interface CalendarSingleProps extends CalendarBaseProps {
  mode?: "single";
  selected?: Date | null;
  /** `null` when the reader clicks the day that was already chosen, which is how a date is cleared. */
  onSelect?: (date: Date | null) => void;
}

interface CalendarRangeProps extends CalendarBaseProps {
  mode: "range";
  selected?: DateRange | null;
  onSelect?: (range: DateRange) => void;
}

export type CalendarProps = CalendarSingleProps | CalendarRangeProps;

export function Calendar(props: CalendarProps) {
  const {
    month: controlledMonth,
    defaultMonth,
    onMonthChange,
    min,
    max,
    isDisabled,
    weekStartsOn = 1,
    label,
    className
  } = props;

  /**
   * The only motion in the calendar, and it is a fade on the month rather than a slide.
   *
   * A slide has to know which way the reader went, and getting that from a keyboard PageUp as well as
   * from the two arrows means threading a direction through state that exists for no other purpose. A
   * fade reads as "this is a different month" either way.
   *
   * ⚠ IT IS framer-motion RATHER THAN AN `animate-in` UTILITY. `tailwindcss-animate` is not a plugin
   * in this repository (`plugins: []` in tailwind.config.ts), so `animate-in fade-in` compiles to
   * nothing at all — no error, no animation, and no way to tell the two apart by reading the source.
   * framer-motion is already a dependency and already animates every Popover and Dialog here.
   *
   * Zero duration under `prefers-reduced-motion`, because the arrow keys DO change the month when
   * they cross a boundary, and a grid that fades on an arrow press is exactly the unrequested movement
   * the preference is asking us to stop.
   */
  const reduceMotion = useReducedMotionPreference();
  const captionId = useId();
  const gridRef = useRef<HTMLTableElement | null>(null);

  /** The day that owns the single tab stop. Not the selection — the reader can move without choosing. */
  const [focusedDay, setFocusedDay] = useState<Date | null>(null);
  /**
   * True only while the keyboard is driving. Focus is moved imperatively after a key press and NOT
   * after a render caused by anything else — otherwise merely rendering the calendar would steal focus
   * from whatever the reader was actually typing into.
   */
  const wantsFocusRef = useRef(false);

  const selectedSingle = props.mode === "range" ? null : (props.selected ?? null);
  const selectedRange = props.mode === "range" ? (props.selected ?? null) : null;

  /**
   * The month to show when the caller controls neither `month` nor a selection: the selected day's
   * month, then today's. Landing on today for a calendar whose value is in 2019 makes the reader page
   * back sixty times.
   */
  const [uncontrolledMonth, setUncontrolledMonth] = useState<Date>(() =>
    startOfMonth(
      defaultMonth ?? selectedSingle ?? selectedRange?.from ?? new Date()
    )
  );
  const month = startOfMonth(controlledMonth ?? uncontrolledMonth);

  const goToMonth = useCallback(
    (next: Date) => {
      const normalised = startOfMonth(next);
      if (controlledMonth === undefined) setUncontrolledMonth(normalised);
      onMonthChange?.(normalised);
    },
    [controlledMonth, onMonthChange]
  );

  const today = useMemo(() => startOfDay(new Date()), []);
  const days = useMemo(() => buildGrid(month, weekStartsOn), [month, weekStartsOn]);
  const weekdays = useMemo(() => weekdayNames(weekStartsOn), [weekStartsOn]);

  // Built once and reused for the caption AND both arrow labels. `Intl.DateTimeFormat` is one of the
  // genuinely expensive constructors in the platform — it resolves a locale and loads its data — and
  // this component re-renders on every arrow key.
  const monthFormat = useMemo(
    () => new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }),
    []
  );
  const monthLabel = monthFormat.format(month);
  const dayLabelFormat = useMemo(
    () => new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
    []
  );

  const dayIsDisabled = useCallback(
    (date: Date): boolean => {
      if (min && date.getTime() < startOfDay(min).getTime()) return true;
      if (max && date.getTime() > startOfDay(max).getTime()) return true;
      return isDisabled?.(date) ?? false;
    },
    [min, max, isDisabled]
  );

  /**
   * Which day holds the tab stop, derived so it can never point at a day that is not on screen.
   *
   * A stored index would go stale the moment the month changed — and a `tabIndex={0}` on a day that
   * has been unmounted means the calendar has NO tab stop at all, so Tab skips straight past it and
   * the grid becomes unreachable by keyboard. Falling back through selection → today → the 1st means
   * there is always exactly one.
   */
  const tabStop = useMemo(() => {
    const candidates = [
      focusedDay,
      selectedSingle,
      selectedRange?.from ?? null,
      today,
      startOfMonth(month)
    ];
    for (const candidate of candidates) {
      if (candidate && days.some((day) => isSameDay(day, candidate))) return candidate;
    }
    // `days[0]` under `noUncheckedIndexedAccess` is `Date | undefined`; the grid is always 42 long, but
    // the compiler does not know that and a non-null assertion would be a claim rather than a check.
    return days[0] ?? startOfMonth(month);
  }, [focusedDay, selectedSingle, selectedRange, today, month, days]);

  // Move the real DOM focus only after a key press. See `wantsFocusRef`.
  useEffect(() => {
    if (!wantsFocusRef.current) return;
    wantsFocusRef.current = false;
    const grid = gridRef.current;
    if (!grid) return;
    grid.querySelector<HTMLButtonElement>('button[data-tab-stop="true"]')?.focus({ preventScroll: true });
  }, [tabStop, month]);

  const moveFocus = (to: Date) => {
    wantsFocusRef.current = true;
    setFocusedDay(to);
    if (to.getMonth() !== month.getMonth() || to.getFullYear() !== month.getFullYear()) {
      goToMonth(to);
    }
  };

  const choose = (date: Date) => {
    if (dayIsDisabled(date)) return;
    setFocusedDay(date);

    if (props.mode === "range") {
      const current = props.selected ?? null;
      // Three states, in the order a reader produces them: nothing chosen → a start; a start only →
      // an end; both → start again. Clicking BEFORE the start begins a new range rather than
      // producing an inverted one, because a range whose end precedes its start is not a range and
      // silently swapping the two hides a mis-click the reader would rather see.
      if (!current || (current.from && current.to) || !current.from) {
        props.onSelect?.({ from: date, to: null });
        return;
      }
      if (date.getTime() < current.from.getTime()) {
        props.onSelect?.({ from: date, to: null });
        return;
      }
      props.onSelect?.({ from: current.from, to: date });
      return;
    }

    // Clicking the chosen day again clears it. Without that a single-date filter can be narrowed but
    // never widened again without a separate "Clear" control the caller has to remember to provide.
    props.onSelect?.(isSameDay(props.selected ?? null, date) ? null : date);
  };

  const onGridKeyDown = (event: ReactKeyboardEvent<HTMLTableElement>) => {
    const from = tabStop;
    let next: Date | null = null;

    if (event.key === "ArrowLeft") next = addDays(from, -1);
    else if (event.key === "ArrowRight") next = addDays(from, 1);
    else if (event.key === "ArrowUp") next = addDays(from, -DAYS_IN_WEEK);
    else if (event.key === "ArrowDown") next = addDays(from, DAYS_IN_WEEK);
    else if (event.key === "Home") next = addDays(from, -((from.getDay() - weekStartsOn + DAYS_IN_WEEK) % DAYS_IN_WEEK));
    else if (event.key === "End")
      next = addDays(from, DAYS_IN_WEEK - 1 - ((from.getDay() - weekStartsOn + DAYS_IN_WEEK) % DAYS_IN_WEEK));
    else if (event.key === "PageUp") next = addMonths(from, event.shiftKey ? -12 : -1);
    else if (event.key === "PageDown") next = addMonths(from, event.shiftKey ? 12 : 1);
    else return;

    // Otherwise the arrow keys scroll the page (or the popover) out from under the grid the reader is
    // navigating, and PageDown leaves the calendar entirely.
    event.preventDefault();
    moveFocus(next);
  };

  /** Where a day sits in the chosen range. `"none"` for a single-mode calendar. */
  const bandFor = (date: Date): CellBand => {
    const from = selectedRange?.from ?? null;
    const to = selectedRange?.to ?? null;
    if (!from || !to) return "none";
    const time = date.getTime();
    const start = startOfDay(from).getTime();
    const end = startOfDay(to).getTime();
    if (time < start || time > end) return "none";
    if (start === end) return "both";
    if (time === start) return "start";
    if (time === end) return "end";
    return "middle";
  };

  const isSelected = (date: Date): boolean => {
    if (props.mode === "range") {
      return isSameDay(date, selectedRange?.from ?? null) || isSameDay(date, selectedRange?.to ?? null);
    }
    return isSameDay(date, selectedSingle);
  };

  return (
    <div className={cn("w-fit font-sans text-ink-900", className)}>
      {/* ── The caption and the two arrows ─────────────────────────────────────────────────────── */}
      <div className="relative flex h-9 items-center justify-between">
        <button
          type="button"
          onClick={() => goToMonth(addMonths(month, -1))}
          aria-label={`Go to ${monthFormat.format(addMonths(month, -1))}`}
          className={NAV_BUTTON}
        >
          <ChevronLeft aria-hidden="true" className="h-4 w-4" />
        </button>

        {/*
          `aria-live="polite"` on the caption, not on the grid. Paging the month replaces thirty-five
          cells, and a live region around the whole grid would read every one of them out; the month's
          name is the one thing that changed and the one thing worth hearing.
        */}
        <span
          id={captionId}
          aria-live="polite"
          className="font-display text-sm font-semibold text-ink-900"
        >
          {monthLabel}
        </span>

        <button
          type="button"
          onClick={() => goToMonth(addMonths(month, 1))}
          aria-label={`Go to ${monthFormat.format(addMonths(month, 1))}`}
          className={NAV_BUTTON}
        >
          <ChevronRight aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>

      {/* ── The grid ───────────────────────────────────────────────────────────────────────────── */}
      <motion.table
        ref={gridRef}
        role="grid"
        aria-label={label}
        aria-describedby={label ? captionId : undefined}
        onKeyDown={onGridKeyDown}
        // `key` on the month so the entrance replays when the month changes. Without it React reuses
        // the same DOM, the component never remounts, and an entrance animation runs exactly once —
        // on the first paint — which is the one time nobody is watching for it.
        key={`${month.getFullYear()}-${month.getMonth()}`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        // Written inline rather than hoisted, matching every other transition in this repository
        // (components/motion/Reveal.tsx, components/map/IndiaMap.tsx). See `reduceMotion` above.
        transition={reduceMotion ? { duration: 0 } : { duration: DURATION.scrim, ease: EASE_OUT }}
        className="mt-2 w-full border-collapse"
      >
        <thead>
          <tr>
            {weekdays.map((weekday) => (
              <th
                key={weekday.long}
                scope="col"
                // The full name is what a screen reader should say; "Mo" is an abbreviation drawn for
                // the eye and `<abbr>` inside a `<th>` is how the two are told apart.
                className="h-8 w-9 p-0 text-[0.7rem] font-semibold uppercase tracking-wide text-ink-500"
              >
                <abbr title={weekday.long} className="no-underline">
                  {weekday.short}
                </abbr>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: WEEKS }, (_, week) => (
            <tr key={week}>
              {days.slice(week * DAYS_IN_WEEK, week * DAYS_IN_WEEK + DAYS_IN_WEEK).map((date) => {
                const outside = date.getMonth() !== month.getMonth();
                const disabled = dayIsDisabled(date);
                const selected = isSelected(date);
                const band = bandFor(date);
                const isToday = isSameDay(date, today);
                const isTabStop = isSameDay(date, tabStop);

                const dayClass = disabled
                  ? DAY_STATE.disabled
                  : selected
                    ? DAY_STATE.selected
                    : band === "middle"
                      ? DAY_STATE.rangeMiddle
                      : isToday
                        ? DAY_STATE.today
                        : outside
                          ? DAY_STATE.outside
                          : DAY_STATE.normal;

                return (
                  <td
                    key={date.getTime()}
                    role="gridcell"
                    // On the CELL, because `aria-selected` is not supported on `role="button"` and is
                    // ignored there — it would look right in the source and be silent in a reader.
                    aria-selected={selected || undefined}
                    className={cn("h-9 w-9 p-0 text-center align-middle", CELL_STATE[band])}
                  >
                    <button
                      type="button"
                      // One tab stop for the whole month. See `tabStop`.
                      tabIndex={isTabStop ? 0 : -1}
                      data-tab-stop={isTabStop ? "true" : undefined}
                      disabled={disabled}
                      // `aria-current="date"` is the one correct way to say "today"; the ring and the
                      // tint are how it is said to everybody else.
                      aria-current={isToday ? "date" : undefined}
                      aria-label={dayLabelFormat.format(date)}
                      onClick={() => choose(date)}
                      onFocus={() => setFocusedDay(date)}
                      className={cn(DAY_BUTTON, dayClass, !disabled && "cursor-pointer")}
                    >
                      {date.getDate()}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </motion.table>
    </div>
  );
}
