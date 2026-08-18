"use client";

/**
 * FilterDateRange — the "from / to" pair on a studio filter form, drawn with the studio's own calendar.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS: TWO SCREENS WERE ASKING FOR A DATE WITH THE BROWSER'S PICKER, NOT THE CENTRE'S.
 *
 * `components/ui/Calendar.tsx` is a hand-built month grid — the same 36px cells, the same purple-700
 * selection, the same ringed "today", one tab stop for the whole month, arrow keys, PageUp/PageDown —
 * and `components/ui/DateField.tsx` is the box that opens it. Nine studio screens use that pair. The
 * two that filter by a DATE RANGE, Analytics and the audit log, used a bare `<Input type="date">`
 * instead, so the one place an editor is most likely to page backwards through months was the one
 * place they got Chrome's grey grid, in Chrome's colours, in Chrome's week order — and on Firefox a
 * different grid again.
 *
 * ⚠ THE GET FORM IS KEPT, AND THAT IS THE PART WORTH READING. Both screens are Server Components
 * whose whole state is the URL — "the range is part of the address, so a report can be sent to
 * somebody exactly as you are looking at it", in Analytics' own words — and they submit with a plain
 * `<form method="get">`. The obvious way to put a controlled React field inside one is a hidden input
 * shadowing it, and that is exactly the arrangement that goes wrong the first time the two disagree.
 * So `DateField` gained a `name` instead: the box IS the form control, it submits the characters the
 * reader can see, and the calendar does what it always did — write digits into a box.
 *
 * The consequence, stated rather than discovered: the server-rendered HTML carries the current range
 * as the inputs' values, so the form still submits the range it was drawn with when JavaScript has not
 * arrived. What needs JavaScript is the calendar button, which is a second route to a value the box
 * can always be typed into.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ IT HOLDS THE TWO DATES AS STRINGS AND PARSES NEITHER. `DateField` is string-in/string-out and has
 * no time zone (its header explains why at length), and both screens read the submitted `YYYY-MM-DD`
 * as a UTC day because that is what their columns hold. A `Date` built here would have to pick a zone
 * and would impose it on both.
 *
 * ⚠ THE OUT-OF-ORDER CHECK IS A LEXICAL STRING COMPARISON, which is safe only because the shape is
 * fixed-width and zero-padded and `DateField` emits exactly that or the empty string, never a
 * half-typed value. It is the same comparison `ProjectEditor` and `PersonEditor` make for their own
 * date pairs, in the same words.
 */

import { useState } from "react";

import { DateField } from "@/components/ui/DateField";

export interface FilterDateRangeProps {
  /** The query-string names. `from` and `to` on both screens today; a prop so neither is assumed. */
  fromName: string;
  toName: string;
  /**
   * The range currently in the address, as `YYYY-MM-DD`.
   *
   * The two boxes FOLLOW this: a preset link above the form is a soft navigation, so the value can
   * change under a mounted component. See the note beside `seeded`.
   */
  fromValue: string;
  toValue: string;
  /** The visible labels. Say which date, not "Date". */
  fromLabel?: string;
  toLabel?: string;
  /** One sentence under the first box — which zone the dates are read as, most often. */
  fromHelp?: string;
  toHelp?: string;
  /** The latest day either box may hold. Both screens pass today: there is no data from tomorrow. */
  max?: string;
}

export function FilterDateRange({
  fromName,
  toName,
  fromValue,
  toValue,
  fromLabel = "From",
  toLabel = "To",
  fromHelp,
  toHelp,
  max
}: FilterDateRangeProps) {
  const [from, setFrom] = useState(fromValue);
  const [to, setTo] = useState(toValue);

  /**
   * Follow the address bar when it changes, and not otherwise.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * ⚠ SEEDING ONCE IS WRONG HERE, AND IT IS WRONG BECAUSE OF THE PRESET LINKS SITTING RIGHT ABOVE THIS
   * FORM. "Last 7 days" is a `<Link>`, so pressing it is a SOFT navigation: React keeps the component
   * mounted — the App Router's cache key deliberately ignores the search string, so a query-only
   * change reuses the same tree — the server re-renders with the new range, and this component's
   * `useState` sits there holding the old one. The charts would show seven days while the two boxes
   * under them still read the thirty they came from, and pressing "Show this range" would put the
   * reader straight back where they started.
   *
   * `FileManager` and `InquiryInbox` seed once and are right to: their filters are React state that
   * they MIRROR into the URL with `history.replaceState`, so the address bar never changes underneath
   * them. Here the URL is the source and the form is a view of it, which is the opposite direction and
   * needs the opposite rule.
   *
   * Adjusted DURING RENDER rather than in an effect. React documents this as the way to reset state
   * when a prop changes: it re-renders immediately, before anything is painted, so no stale value ever
   * reaches the screen — where an effect would paint the old dates for a frame first. The comparison
   * is against the last SEEDED props, not the current state, so it fires exactly once per navigation
   * and never fights a reader who has typed something.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  const [seeded, setSeeded] = useState({ from: fromValue, to: toValue });
  if (seeded.from !== fromValue || seeded.to !== toValue) {
    setSeeded({ from: fromValue, to: toValue });
    setFrom(fromValue);
    setTo(toValue);
  }

  /** Both complete, and the wrong way round. See the header for why a string comparison is enough. */
  const outOfOrder = from.length === 10 && to.length === 10 && from > to;

  return (
    <>
      <DateField
        label={fromLabel}
        name={fromName}
        value={from}
        onChange={setFrom}
        max={max}
        help={fromHelp}
      />
      <DateField
        label={toLabel}
        name={toName}
        value={to}
        onChange={setTo}
        max={max}
        help={toHelp}
        /**
         * ⚠ THE MESSAGE IS A WARNING RATHER THAN A REFUSAL, and both screens are why: each one SWAPS a
         * transposed range and says so, because an empty screen with no explanation is the least
         * useful possible answer. Blocking the submit here would take that repair away and leave the
         * reader with a form that will not go. The wording is the pair `ProjectEditor` and
         * `PersonEditor` already use for their own two-date checks.
         */
        error={outOfOrder ? "The second date is before the first, so the two will be swapped." : null}
      />
    </>
  );
}
