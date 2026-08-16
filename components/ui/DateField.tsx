"use client";

/**
 * DateField — a date TYPED INTO A BOX, with the month grid one button away.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE TEXT BOX IS THE FIELD. THE CALENDAR IS AN ASSISTANT.
 *
 * Somebody entering a date they already know — off a letter, a spreadsheet, the thing they are
 * copying from — must never be made to page a month grid to get to it. So the value lives in the
 * box, the box is a plain text input, and the grid does exactly one thing when a day is clicked:
 * it writes that day's digits into the box. Nothing in this file can produce a value the reader
 * could not have typed by hand, which is the property that makes the two routes interchangeable.
 *
 * IT IS `type="text"` RATHER THAN `type="date"`, AND THAT IS THE DECISION THIS COMPONENT EXISTS TO
 * MAKE. A native date input already offers typing, so keeping it and hanging our button off the side
 * looks like the smaller change — but Chrome draws its OWN picker glyph inside the box
 * (`::-webkit-calendar-picker-indicator`, hideable) and Firefox draws one too with no selector that
 * reliably hides it. The result on Firefox is two calendar buttons in one field, opening two
 * different calendars that disagree about the theme, the week start and the keyboard. One calendar
 * is worth more than the browser's segmented editor, which is why this box speaks plain text.
 *
 * WHAT THAT COSTS, said plainly rather than discovered: the reader types `2026-09-30` rather than
 * their own locale's order, and a phone shows a keypad rather than a spinner. The placeholder, the
 * `help` sentence a caller writes and the error message all say the shape in full, and the shape is
 * the one this repository already asks for everywhere else — `lib/sections/schema.ts` refuses a bad
 * date with "Enter a real date as year-month-day, such as 2026-09-30", in those words.
 *
 * ⚠ THIS COMPONENT HAS NO TIME ZONE, ON PURPOSE, AND IT MUST NOT ACQUIRE ONE.
 *
 * Values go in and come out as STRINGS — `YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm` under `withTime`. The
 * grid needs a `Date` to draw itself, so the digits are split apart and handed to
 * `new Date(year, month - 1, day)`, and the day the reader clicks is read back out with
 * `getFullYear()`/`getMonth()`/`getDate()`. Both halves are LOCAL and they are exact inverses, so the
 * digits that arrive are the digits that leave and this file changes nobody's convention.
 *
 * `new Date("2026-03-01")` IS NEVER CALLED HERE, and that is the whole reason for the paragraph
 * above. The specification parses a bare `YYYY-MM-DD` as UTC midnight, which is 31 March — the
 * PREVIOUS DAY — for every reader west of Greenwich; a picker that did it would show the wrong day
 * highlighted and then save a different one.
 *
 * ⚠ AND THERE IS NO SHARED HELPER IN THIS REPOSITORY TO DEFER TO. It was looked for. What exists is
 * roughly a dozen private ones across three DIFFERENT conventions, each correct for its own store:
 *   • UTC days — `app/studio/projects/[id]/page.tsx`, `app/studio/people/[id]/page.tsx`,
 *     `app/studio/gallery/[id]/AlbumEditor.tsx`, `app/studio/files/FileManager.tsx`,
 *     `lib/provenance.ts`, `app/api/studio/audit/route.ts` — for columns that hold a DAY;
 *   • local days — `components/studio/sections/ActionStepsForm.tsx`, where `lib/sections/schema.ts`
 *     stores the reader's string verbatim and never parses it at all;
 *   • the Centre's zone — `lib/ical.ts`, `components/site/EventDateBlock.tsx` and the conversions at
 *     the top of `app/studio/events/[id]/EventEditor.tsx` — for columns that hold an INSTANT.
 * Picking one of the three here would impose it on the other two, and inventing a fourth would be
 * worse. Staying string-in/string-out is the only answer that leaves all three intact: a call site
 * keeps whatever conversion it already had, on both sides of this component, untouched.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * IT WRAPS ITSELF IN `FieldBlock`, NEVER `Field`, AND THAT IS NOT A PREFERENCE. `Field` renders a
 * real `<label>` around its child, and a `<label>` re-dispatches a stray click to the first labelable
 * control inside it AND folds every named descendant into that control's accessible name
 * (Field.tsx's header sets out both traps in full). There is a `<button>` in here. Inside a `Field`
 * it would be announced as part of the box's name — "Closing date for this step, Open the calendar,
 * edit text" — and the click that opened it would be forwarded straight back into the input. This is
 * the same reason `PasswordInput` exists as a separate component with the same rule.
 *
 * ⚠ THE TRIGGER NEEDS `isolate` ON ITS WRAPPER AND A RUNG OF ITS OWN, AND WITHOUT THEM THIS FIELD
 * LOOKS LIKE A PLAIN TEXT BOX. `.field-input` composes `bg-card`; app/globals.css also declares a bare
 * `.bg-card { position: relative; z-index: 45 }`, and Tailwind's `@apply` inlines a `@layer components`
 * rule of the same name alongside the utility — so every `.field-input` in this repository is a
 * positioned element at z-index 45, and an `absolute` adornment at z-index auto paints UNDERNEATH its
 * opaque fill. It was reported as "the calendar has been removed from the date fields". The wrapper's
 * own note below carries the mechanism; the same trap is waiting for `PasswordInput`'s eye, `Input`'s
 * leading `icon` and `Input`'s `suffix`, and the real cure is `:where(.bg-card)` in globals.css, which
 * `@apply` cannot reach.
 *
 * THE TRIGGER IS IN THE TAB ORDER, WHICH IS WHERE IT DIFFERS FROM `PasswordInput`'s EYE. That button
 * is `tabIndex={-1}` because revealing a password is a convenience nobody has to use to finish the
 * form. This one is a second, complete route to the field's value — the route a reader takes when
 * they know it is "the second Tuesday" and not which number that is — so taking it off the keyboard
 * would leave that reader with no way to reach the grid at all.
 *
 * THE TYPED TEXT IS LOCAL STATE AND THE VALUE IS THE PROP, for the same reason `CoordinateField` in
 * the event editor holds a string beside its number: `2`, `2026-0` and `2026-09-3` are all halfway to
 * a date while meaning nothing, and a box driven straight from the parent's value would be wiped on
 * the first keystroke — the parent stores "no date", hands back `""`, and the character just typed
 * disappears. So the box keeps the characters and the form keeps the date, and the two are re-synced
 * only when they MEAN different things.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode
} from "react";
import { CalendarDays } from "lucide-react";

import { cn } from "@/lib/utils";
import { Calendar } from "@/components/ui/Calendar";
import { FieldBlock, useFieldContext } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Popover } from "@/components/ui/Popover";

/** Exactly the shape a `date` input used to produce, and the shape the schemas already accept. */
const ISO_DAY_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `HH:mm`, which is what `<input type="time">` emits and all it ever emits. */
const TIME_SHAPE = /^\d{2}:\d{2}$/;

/**
 * The time a day gets when a date is picked under `withTime` and no time has been typed yet.
 *
 * Midnight rather than a guess at office hours. "Starts at 00:00" is visibly odd on the form, so the
 * editor sees it and corrects it; "starts at 09:00" is plausible enough to be published unread.
 */
const DEFAULT_TIME = "00:00";

/**
 * `YYYY-MM-DD` → local midnight on that day, or `null` for anything else.
 *
 * ⚠ THE ROLLOVER CHECK IS THE POINT OF THIS FUNCTION. `new Date(2026, 1, 31)` is 3 March: the
 * constructor overflows rather than refusing, so a closing date typed one digit wrong would be
 * accepted here, saved, and then shown to readers as a different day with nothing anywhere saying
 * so. `lib/sections/schema.ts` refuses the same string on the server for the same reason; comparing
 * the parts back is how the two agree without sharing code across the client boundary.
 */
function parseIsoDay(value: string): Date | null {
  const match = ISO_DAY_SHAPE.exec(value.trim());
  if (!match) return null;

  const [, rawYear, rawMonth, rawDay] = match;
  // The three groups always match when the regex does; `noUncheckedIndexedAccess` does not know that
  // and a non-null assertion would be a claim rather than a check.
  if (!rawYear || !rawMonth || !rawDay) return null;

  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);

  const date = new Date(year, month - 1, day);
  // ⚠ A two-digit year argument means 19xx to the constructor, so `0099-01-01` would silently become
  // 1999. `setFullYear` is the only way to say a year below 100 and mean it.
  if (year < 100) date.setFullYear(year);

  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

/** A `Date` back to `YYYY-MM-DD`, read off the LOCAL calendar — the exact inverse of `parseIsoDay`. */
function formatIsoDay(date: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The stored value split into the two boxes it is drawn in. `""` for either half that is missing.
 *
 * Splitting on `T` rather than matching a shape is deliberate, and it is what makes a LEGACY value
 * readable. `lib/sections/schema.ts` accepts a full ISO instant as well as a bare day, "because both
 * arrive: the date picker gives the first, and a value pasted out of a spreadsheet or an older
 * payload can be the second" — and `2026-09-30T00:00:00Z` split this way puts the right day in the
 * box. A `date` input handed the same string simply showed nothing, so the editor could not see what
 * was stored and overwrote it blind.
 */
function splitValue(value: string): { day: string; time: string } {
  const parts = value.trim().split("T");
  return { day: parts[0] ?? "", time: parts[1] ?? "" };
}

/**
 * What the two boxes currently MEAN to the caller — the value this component would push up.
 *
 * `""` for anything unreadable, which is deliberate and is what makes the re-sync effect below safe:
 * a half-typed date means "no date", the parent stores nothing, and the characters stay in the box
 * because the box is the one holding them.
 */
function meaningOf(dayText: string, timeText: string, withTime: boolean): string {
  const day = parseIsoDay(dayText);
  if (!day) return "";
  const iso = formatIsoDay(day);
  if (!withTime) return iso;
  const time = timeText.trim();
  return `${iso}T${TIME_SHAPE.test(time) ? time : DEFAULT_TIME}`;
}

export interface DateFieldProps {
  /**
   * The visible label.
   *
   * ⚠ A `string`, not a `ReactNode` as `FieldProps` allows, because it is SPOKEN as part of two other
   * accessible names: the trigger button's ("Open the calendar for Closing date") and, under
   * `withTime`, the time box's. The event editor puts six of these on one screen, where six buttons
   * all named "Open the calendar" leave a reader listing the page's controls with no way to tell
   * which field each belongs to, and a voice-control user with an ambiguous target.
   */
  label: string;
  /**
   * `YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm` under `withTime`. `""` is "no date" and is normal.
   *
   * ⚠ A STRING, AND IT STAYS A STRING. See the file header: this component holds no time zone and
   * every caller keeps its own conversion on both sides.
   */
  value: string;
  /** Called with the same shape as `value`, and with `""` when the field is emptied or unreadable. */
  onChange: (next: string) => void;
  /**
   * Adds a `<input type="time">` beside the date box and lengthens the value to `YYYY-MM-DDTHH:mm`.
   *
   * The calendar writes only the DATE half — a month grid has nothing to say about the time — so the
   * two controls stay separately typeable, which is the whole point of a split field.
   */
  withTime?: boolean;
  /** Bounds, as `YYYY-MM-DD`. Days outside them are unclickable in the grid AND refused in the box. */
  min?: string;
  max?: string;
  required?: boolean;
  /** One plain sentence under the label. Say the shape, or the zone, or what "empty" means here. */
  help?: ReactNode;
  /** The caller's validation message. Shown ahead of this component's own. */
  error?: string | null;
  className?: string;
}

export function DateField({
  label,
  value,
  onChange,
  withTime = false,
  min,
  max,
  required = false,
  help,
  error = null,
  className
}: DateFieldProps) {
  // Lazy initialisers: `splitValue` would otherwise run on every render to produce a value used once.
  const [dayText, setDayText] = useState<string>(() => splitValue(value).day);
  const [timeText, setTimeText] = useState<string>(() => splitValue(value).time);
  /**
   * Whether the reader has STOPPED editing the date box, having put something in it.
   *
   * The format complaint below is gated on this because `2026-0` is not a mistake, it is somebody four
   * characters into typing — and a field that turns red on the fourth keystroke of a correct answer
   * teaches the reader to ignore it by the time it is right about something. Set on blur and cleared
   * again by the next keystroke (in `commit`), so the message can only ever appear beside a box nobody
   * is currently inside: it never interrupts, and it never lingers over a correction in progress.
   */
  const [settled, setSettled] = useState(false);

  const meaning = meaningOf(dayText, timeText, withTime);

  /**
   * Re-sync only when the value arriving from outside MEANS something different from what is typed —
   * a discard, a revision being restored, a sibling field rewriting this one.
   *
   * Comparing meanings rather than strings is what stops this from fighting the typing: ` 2026-09-30`
   * and `2026-09-30` mean the same day, so nothing is rewritten under the cursor.
   */
  useEffect(() => {
    if (value === meaning) return;
    const next = splitValue(value);
    setDayText(next.day);
    setTimeText(next.time);
    // `meaning` is deliberately not a dependency: it changes on every keystroke, and reacting to it
    // would reintroduce exactly the fight this effect exists to avoid — the same rule, and the same
    // exemption, as `CoordinateField` in app/studio/events/[id]/EventEditor.tsx.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = useCallback(
    (nextDay: string, nextTime: string) => {
      setDayText(nextDay);
      setTimeText(nextTime);
      // Editing again withdraws the complaint until the reader stops. See `settled`.
      setSettled(false);
      onChange(meaningOf(nextDay, nextTime, withTime));
    },
    [onChange, withTime]
  );

  const parsed = parseIsoDay(dayText);
  const minDay = min ? parseIsoDay(min) : null;
  const maxDay = max ? parseIsoDay(max) : null;
  const outOfRange =
    parsed !== null && ((minDay !== null && parsed < minDay) || (maxDay !== null && parsed > maxDay));

  /**
   * The caller's message wins, because it knows things this component cannot — that the end is before
   * the start, that the window closes after the event.
   *
   * `??` would not do here: `error=""` is how several call sites say "no error", and `"" ?? x` is
   * `""`, which would swallow this component's own complaint whenever a parent passed an empty string.
   */
  const callerError = typeof error === "string" && error.trim().length > 0 ? error : null;
  const ownError = outOfRange
    ? minDay && maxDay
      ? `Choose a date from ${min} to ${max}.`
      : minDay
        ? `Choose ${min} or later.`
        : `Choose ${max} or earlier.`
    : settled && dayText.trim().length > 0 && parsed === null
      ? // Worded as the server words it (`lib/sections/schema.ts`), so a reader who gets past this box
        // and fails the save is not told the same thing twice in two different ways.
        "Write the date as year-month-day, such as 2026-09-30. Check the day exists in that month."
      : null;

  return (
    <FieldBlock
      label={label}
      required={required}
      help={help}
      error={callerError ?? ownError}
      className={className}
    >
      <DateFieldControl
        label={label}
        dayText={dayText}
        timeText={timeText}
        selected={parsed}
        minDay={minDay}
        maxDay={maxDay}
        withTime={withTime}
        onDayText={(next) => commit(next, timeText)}
        onTimeText={(next) => commit(dayText, next)}
        onSettled={() => setSettled(true)}
      />
    </FieldBlock>
  );
}

/**
 * The control itself, separate ONLY so it can read `useFieldContext()`.
 *
 * A hook cannot see a provider its own component renders, so the id, the description and the invalid
 * flag are unreachable from `DateField` above — the same split `IconPicker` and `CraftImagePicker`
 * make, for the same reason.
 */
function DateFieldControl({
  label,
  dayText,
  timeText,
  selected,
  minDay,
  maxDay,
  withTime,
  onDayText,
  onTimeText,
  onSettled
}: {
  label: string;
  dayText: string;
  timeText: string;
  /** The typed date, when it is readable. What the grid highlights, and nothing else. */
  selected: Date | null;
  minDay: Date | null;
  maxDay: Date | null;
  withTime: boolean;
  onDayText: (next: string) => void;
  onTimeText: (next: string) => void;
  /** The reader has left the date box. Only then may a format complaint be shown — see `settled`. */
  onSettled: () => void;
}) {
  const field = useFieldContext();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Generated rather than fixed: the event editor renders six of these on one screen, and a constant
  // id would give six panels the same one — at which point every `aria-controls` points at the first.
  const uid = useId();
  const panelId = `${uid}calendar`;
  const timeId = `${uid}time`;

  /**
   * Closing, from wherever it is asked for — Escape, a click outside, a scroll, or a day being chosen.
   *
   * ⚠ FOCUS HAS TO BE RESCUED FIRST. `Popover` closes without moving focus anywhere, so if the reader
   * is standing on a day when the panel unmounts, focus falls to `<body>` and the keyboard is back at
   * the top of the document — several screens away from the form they were filling in. `activeElement`
   * is read synchronously, before the state change tears the panel down.
   *
   * Focus returns to the TRIGGER rather than the text box because that is where the reader's place in
   * the tab order actually is: they pressed this button, and the button's `aria-expanded` flipping
   * back to false is what tells a screen reader the panel has gone.
   */
  const close = useCallback(() => {
    const panel = panelRef.current;
    const active = document.activeElement;
    const wasInside = panel !== null && active instanceof Node && panel.contains(active);
    setOpen(false);
    if (wasInside) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className={cn("flex flex-wrap items-start gap-2", withTime && "sm:flex-nowrap")}>
      {/*
        Positions the trigger over the input, exactly as PasswordInput positions its eye.

        ⚠ `isolate` IS THE REASON THE CALENDAR BUTTON IS VISIBLE AT ALL, AND IT IS NOT DECORATION.
        `.field-input` composes `bg-card`, and app/globals.css gives `.bg-card` `position: relative;
        z-index: 45` (the rung that lifts every card over the fluid cursor). Tailwind's `@apply`
        resolves a class defined in `@layer components` as well as the utility of the same name, so
        that whole rule is inlined into `.field-input` — every input on this site is a POSITIONED
        element at z-index 45. The trigger below is `absolute` at z-index auto, so it painted UNDER
        the input's opaque card fill: invisible, and unclickable, because the input's own box then
        swallowed the pointer. That is the "the calendar is gone" this component was reported for.

        `isolate` makes this span a stacking context, so the input's 45 and the trigger's 50 are
        compared HERE and nowhere else — the trigger can sit above the fill it was buried under
        without its rung ever being measured against the z-50 header or anything else on the ladder
        (contract §6). The fix survives `.bg-card` being repaired: with the input back at z-index
        auto the trigger is still the higher of the two.

        `[&_input]:block` is the second half of the same repair. `Input` wraps its `<input>` in a
        `relative block` span, and an inline-level input gives that span a LINE BOX — five or six
        pixels of descender leading below the field — so `top-1/2` centres on the span rather than
        on the box the reader sees. A block-level input makes the two the same height and the
        centring honest, which matters now that the trigger is a visible chip rather than a bare
        glyph: 2px out of centre reads as a mistake once there is a border to see it against.
      */}
      <span
        className={cn(
          "relative isolate block min-w-0 [&_input]:block",
          withTime ? "w-full sm:flex-1" : "w-full"
        )}
      >
        <Input
          // ⚠ NOT `type="date"`. See the file header — two browsers draw their own picker glyph and
          // one of them cannot be talked out of it.
          type="text"
          // A date is digits and two hyphens. `numeric` is the keypad a phone should offer; it is a
          // hint rather than a restriction, so a hardware keyboard is unaffected.
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          placeholder="YYYY-MM-DD"
          // Ten characters is the whole shape. Set on the INPUT rather than on the `FieldBlock`, which
          // would draw a "3 of 10 characters" counter under a date — a limit nobody is at risk of
          // hitting, counted at every keystroke.
          maxLength={10}
          value={dayText}
          onChange={(event) => onDayText(event.target.value)}
          onBlur={onSettled}
          // The trigger's 36px chip inset by 6px needs 42px kept clear, and 48px is the nearest step
          // — the same class PasswordInput uses for its own sum. `.field-input` pays 14px of its own
          // right padding, which would leave the year underneath the button.
          className="pr-12 tabular-nums"
        />

        <button
          // ⚠ Explicit, because these fields sit inside `<form>` elements: a `<button>` with no type
          // is a SUBMIT button, so the first press of the calendar would post the half-filled form.
          type="button"
          ref={triggerRef}
          onClick={() => (open ? close() : setOpen(true))}
          aria-expanded={open}
          // Only while it exists. `aria-controls` pointing at an id that is not in the document is a
          // broken relationship rather than an absent one, and some readers announce it as such.
          aria-controls={open ? panelId : undefined}
          // Says WHICH field, because six of these share the event screen. See `DateFieldProps.label`.
          aria-label={`Open the calendar for ${label}`}
          // ⚠ A BORDERED, FILLED CHIP RATHER THAN A BARE GREY GLYPH, AND THAT IS THE POINT OF IT.
          //
          // What this component replaced was a native `type="date"`, which handed the reader the
          // browser's own picker button for free. An `ink-500` icon floating on the field's own fill
          // announces nothing: it reads as an ornament printed on the box, so a reader who wants a
          // month grid never learns there is one — and losing a picker they had is worse than never
          // having offered one. `border-line-200` is the same hairline the field itself wears and
          // `bg-surface-100` is a genuinely different ground from `bg-card` in BOTH themes (#f3f1fa
          // on white, #262135 on #1a1725), so the chip is a thing sitting IN the box rather than
          // printed on it. Under `prefers-contrast: more` globals.css collapses surface-100 to the
          // card colour and darkens line-200 — which is why the BORDER, not the fill, is the part
          // carrying the message.
          //
          // `z-50` is measured only against the input's 45 inside this span's `isolate`; see the
          // wrapper's note. `h-9 w-9` rather than the eye's `h-10 w-10`: the field is 42px between
          // its borders, so a 40px chip's border would land flush against the field's own and read
          // as one doubled line. 36px leaves 3px of air and is still a comfortable pointer target.
          //
          // The hover is Calendar's `NAV_BUTTON` hover, so the trigger and the arrows it opens tint
          // identically — and every purple carries its `dark:` partner, because the purple ramp is
          // brand colour and does not invert (see Calendar's DAY_STATE note).
          className="absolute right-1.5 top-1/2 z-50 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-md border border-line-200 bg-surface-100 text-ink-700 transition hover:border-purple-300 hover:bg-purple-50 hover:text-purple-700 dark:hover:bg-purple-950 dark:hover:text-purple-200"
        >
          <CalendarDays aria-hidden="true" className="h-4 w-4" />
        </button>
      </span>

      {withTime ? (
        <>
          {/*
            The time box carries its own name because `FieldBlock`'s `<label>` points at the DATE box
            by id, and one label cannot name two controls. It is a native `time` input on purpose: it
            emits `HH:mm` or nothing and never a half-typed value, so unlike the date box it can be
            driven straight from the prop without a local copy.
          */}
          <label htmlFor={timeId} className="sr-only">
            {`Time — ${label}`}
          </label>
          {/*
            ⚠ THE WIDTH GOES ON THIS SPAN, NOT ON THE INPUT. `Input` sends `className` to the `<input>`
            itself (its header says so) and wraps it in a `relative block` span of its own — so a `w-32`
            passed through would size an input inside an auto-width flex item, which is circular and
            settles wherever the browser feels like. The flex item is what has to be measurable.
          */}
          <span className="block w-full sm:w-32">
            <Input
              id={timeId}
              type="time"
              value={timeText}
              onChange={(event) => onTimeText(event.target.value)}
              // The field's description — the time zone sentence, on the event screen — belongs to both
              // boxes; `Input` would inherit it anyway, and it is written out to say that is intended.
              aria-describedby={field?.describedBy}
              // ⚠ NOT inherited from the Field. Every message this component raises is about the DATE,
              // and a red border round the time box would send the reader to correct a box that is fine.
              invalid={false}
              className="tabular-nums"
            />
          </span>
        </>
      ) : null}

      <Popover
        open={open}
        onClose={close}
        // The trigger, not the field wrapper. `Popover` restores focus to its anchor when Tab steps
        // off either end of the panel, and a `<span>` cannot take focus; anchoring to the button also
        // means a click on the text input counts as "outside" and closes the grid — which is right,
        // because choosing to type is choosing not to use the grid.
        anchorRef={triggerRef}
        panelRef={panelRef}
        id={panelId}
        // `end` so the panel's right edge meets the button's. Aligned to the left of a full-width
        // field the 252px grid would sit under one corner of it with an acre of nothing beside.
        align="end"
        label={`Calendar for ${label}`}
        // `!p-3`, with the bang. `Popover` sets `p-1.5` and `cn()` is a plain join, so a later class
        // decides nothing (contract §5); padding utilities are emitted in ascending order, which would
        // happen to work today and stop working the day the value changed. IconPicker's `!p-0` carries
        // the same note.
        className="!p-3"
      >
        <Calendar
          mode="single"
          label={label}
          selected={selected}
          // No `defaultMonth`: `Calendar` already opens on the selected day's month and falls back to
          // today, and the panel is unmounted on close, so that choice is remade on every opening
          // rather than frozen at the first. Passing one would restate the default and then go stale.
          min={minDay ?? undefined}
          max={maxDay ?? undefined}
          // See Calendar's own note: the panel is portalled, so without this the grid cannot be
          // reached from the keyboard at all.
          autoFocus
          onSelect={(date) => {
            // `null` arrives when the reader clicks the day that is already chosen, which is how the
            // grid clears a date. Emptying the box is the same thing said the other way, and both
            // have to work or the field can be narrowed and never widened again.
            onDayText(date === null ? "" : formatIsoDay(date));
            // Choosing a day answers the question the panel was opened to ask.
            close();
          }}
        />
      </Popover>
    </div>
  );
}
