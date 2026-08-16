"use client";

/**
 * Two controls for choosing from a list, and knowing which one you want is the whole of this file.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `Select`               — a NATIVE `<select>` in `.field-input` clothing. The default.
 * `SearchableSelect`     — a themed listbox that grows a filter box once the list is long enough.
 * `SearchableMultiSelect`— the same, with checkboxes, "select all" and a Confirm button.
 *
 * ⚠ DO NOT REPLACE THE NATIVE `Select` WITH THE SEARCHABLE ONE ACROSS THE STUDIO. On a phone the
 * native control opens the platform picker — a wheel or a full-height sheet, thumb-sized, scrollable
 * with momentum, searchable by typing, and already translated. A hand-built listbox on the same
 * screen is a 200px scroller with 32px rows that a screen reader has to be told about through eight
 * ARIA attributes, each of which can be got wrong. A four-option enum keeps the plain list it
 * deserves. The searchable pair earns its place at the OTHER end: a list of ninety artisans, four
 * hundred pages or a folder tree is one the reader has to hunt through, and there the native control
 * offers nothing but scrolling.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── The native Select ──────────────────────────────────────────────────────────────────────────
 * The chevron is ours because `appearance-none` removes the platform's. It is `pointer-events-none`
 * so a click on the arrow still opens the menu — an arrow that swallows the click is the classic
 * symptom of this pattern done in a hurry.
 *
 * THE OPTION LIST IS PAINTED BY THE OPERATING SYSTEM and cannot be styled from here. It follows the
 * theme anyway because globals.css sets `color-scheme` on `:root` for both themes, which is exactly
 * why we do not try to fight it.
 *
 * THE PLACEHOLDER OPTION STAYS SELECTABLE, even on a required field. Disabling it means a reader who
 * picked a value by mistake cannot get back to "not answered"; the empty string is rejected by the
 * Zod schema on submit (contract §9), which is where every other rule in this product lives.
 *
 * ── The searchable pair, and where it came from ────────────────────────────────────────────────
 * Ported from D:/Portal_Development_Designer/frontend/components/ui/SearchableSelect.tsx (and its
 * thin adapters in that repository's `Dropdown.tsx`, which are not brought across — they were three
 * historical signatures kept for forty existing call sites there, and reproducing them here would be
 * importing somebody else's migration debt). NO DEPENDENCY WAS ADDED: the source is plain React over
 * its own `AnchoredPopover`, and this repository already has the equivalent in
 * `components/ui/Popover.tsx`.
 *
 * FOUR DECISIONS CARRY THE PORT, all inherited from the source and all worth keeping:
 *
 *  1. **Search is decided by option count, not by the call site.** Asking each of forty selects to opt
 *     in guarantees the long ones get missed. `SEARCH_THRESHOLD` splits them; see the constant for
 *     why the number is not a guess.
 *  2. **The highlight is derived, never stored raw.** A stored index goes stale the instant the
 *     filter changes, and a stale index means Enter commits a row that is not on screen — the exact
 *     data-entry bug a searchable select is supposed to prevent.
 *  3. **"Select all" follows the filter.** With a query active the button acts on the matches and
 *     says so ("Select 6 matching"), never on the 74 rows the reader cannot see.
 *  4. **The panel floats.** These lists live inside dialogs and `overflow-hidden` toolbars, where an
 *     absolutely positioned menu is sheared off rather than merely misplaced.
 *
 * WHAT CHANGED IN THE PORT, and why, so the two repositories can be compared later:
 *
 *  • `AnchoredPopover` → this repository's `Popover`. It already portals (to `<body>`, or to the
 *    enclosing `[data-dialog]` at the right z-rung), flips only when the panel does not fit AND the
 *    other side has more room, takes Escape on a stack so only the topmost panel closes, and closes on
 *    a user scroll or a width change but NOT on a height change. The source's `useEdgeTab` is
 *    therefore deleted rather than translated: `Popover` already intercepts both ends of the tab order
 *    and hands focus back to the anchor.
 *  • ⚠ `advanceOnSelect` IS GONE, and its absence is the one real loss. The source moves focus to the
 *    next form field after a pick, through `lib/formNav.focusNextField` — a DOM walker scoped with
 *    `closest("form")` and driven by `data-form-field` attributes on every control. That module does
 *    not exist in this repository and NOTHING here carries `data-form-field`, so porting the prop
 *    would have meant either importing a walker with no fields to walk (a no-op that looks like a
 *    feature) or attributing every input in the studio (a change across forty files, in a commit
 *    about a dropdown). Focus returns to the trigger instead, which is where `Popover` puts it and
 *    where the reader's place in the tab order actually is.
 *  • The `describedBy`/`invalid` handling is wired to this repository's `Field` context, so a
 *    `<Field label error help>` reaches these controls the way it reaches `Input` and the native
 *    `Select`. THERE IS STILL DELIBERATELY NO `invalid` BORDER: `aria-invalid` is not supported on
 *    `role="button"` and would be silently ignored, so a refusal reaches the reader through the
 *    Field's own error paragraph and `aria-describedby` rather than through a colour a screen reader
 *    cannot see.
 *  • `SelectOption` is shared with the native `Select` rather than declared twice, so a caller can
 *    hand the same array to either and swap between them without touching its data.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject
} from "react";
import { Check, ChevronDown, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { FIELD_INVALID_CLASS, useFieldContext } from "@/components/ui/Field";
import { Popover } from "@/components/ui/Popover";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The native select
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface SelectProps extends Omit<ComponentPropsWithRef<"select">, "children"> {
  /** The closed list. Use this, or pass `<option>`/`<optgroup>` children, or both. */
  options?: readonly SelectOption[];
  /** Rendered as an empty-valued first option — "Choose a research area". */
  placeholder?: string;
  /** Forces the error treatment. Normally inherited from the Field's `error`. */
  invalid?: boolean;
  /** `<optgroup>`s, or extra options appended after `options`. */
  children?: ReactNode;
}

export function Select({
  options,
  placeholder,
  invalid,
  className,
  id,
  required,
  children,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  ...rest
}: SelectProps) {
  const field = useFieldContext();
  const isInvalid = invalid ?? field?.invalid ?? false;

  return (
    <span className="relative block">
      <select
        id={id ?? field?.controlId}
        required={required}
        aria-describedby={ariaDescribedBy ?? field?.describedBy}
        aria-invalid={ariaInvalid ?? (isInvalid ? true : undefined)}
        aria-required={!required && field?.required ? true : undefined}
        className={cn(
          "field-input cursor-pointer appearance-none pr-10",
          isInvalid ? FIELD_INVALID_CLASS : undefined,
          className
        )}
        {...rest}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options?.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
        {children}
      </select>

      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-500"
      />
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The searchable pair
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * At or above this many options the panel grows a search box.
 *
 * The number came across from the source with its reasoning, and it holds here too: every fixed
 * vocabulary in this studio tops out at about seven — publish state (3), alt-text state (4), media
 * kind (6), sort direction (2), section alignment (3) — while every list backed by records starts in
 * double figures: media folders, news categories, tags, people, projects, events, pages. So a single
 * threshold separates a closed vocabulary the reader takes in at a glance from a corpus they have to
 * hunt through, and a four-option enum keeps the plain list it deserves.
 */
const SEARCH_THRESHOLD = 8;

/**
 * Rows rendered at once, past which the list is capped and the footer says so.
 *
 * Cheaper than a virtualiser and better teaching: with four hundred pages the way to reach one is to
 * type, not to flick a finger for ten seconds. The cap only limits what is DRAWN — filtering and
 * "select all" both still see every match, so nothing is silently unreachable.
 */
const RENDER_CAP = 80;

/** Selected labels read out in full before the summary switches to a count. */
const SUMMARY_NAMES = 6;

/**
 * The trigger, built on `.field-input` so it sits at exactly the same height and weight as an
 * `<Input>` or a native `<Select>` beside it in the same `<Field>`. The source used its own border
 * and padding; matching the field primitive is what makes this look native to THIS repository.
 */
const TRIGGER_CLASS =
  "field-input flex w-full cursor-pointer items-center justify-between gap-2 text-left disabled:cursor-not-allowed disabled:opacity-60";

/**
 * `Popover` paints `p-1.5` and `overflow-y-auto` on its own panel, and `cn()` is a plain join rather
 * than tailwind-merge — later classes do NOT win (contract §5) — so both need `!` to actually take.
 * The panel must not scroll as a whole: the search box and the footer stay put while only the list
 * moves.
 *
 * `max-w-[520px]` is the cap the source applied through an `AnchoredPopover` prop this repository's
 * `Popover` does not have, so it is expressed as CSS instead — and it still wins, because `max-width`
 * clamps the computed width whatever set it, including the inline `width` `Popover` writes for
 * `matchAnchorWidth`. Without it a full-width field on a laptop produces a 1200px list of short
 * labels.
 */
const PANEL_CLASS = "!overflow-hidden !p-0 flex flex-col max-w-[520px]";

/** Diacritics folded so "Jodhpur" is reachable by typing "jodhpur" and "Ahmedābād" by "ahmedabad". */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/**
 * Matches, ordered so that Enter picks what the reader meant.
 *
 * Plain substring order is not good enough: typing "co" into a tag list would put "Bamboo comb" above
 * "Cotton hank" purely because it was entered first, and Enter would then take the wrong one. Ranking
 * label-prefix above word-prefix above mid-word puts the obvious answer on top, and the sort is stable
 * so equally-good matches keep the caller's ordering.
 */
function filterOptions(options: readonly SelectOption[], query: string): SelectOption[] {
  const needle = fold(query.trim());
  if (!needle) return [...options];

  const ranked: { option: SelectOption; rank: number; at: number }[] = [];
  options.forEach((option, at) => {
    const hay = fold(option.label);
    const index = hay.indexOf(needle);
    if (index < 0) return;
    // `hay[index - 1]` is `string | undefined` under noUncheckedIndexedAccess, and at index 0 it IS
    // undefined — which is the word-start case, so the `index === 0` test has to come first rather
    // than the regex being handed an undefined.
    const before = index === 0 ? undefined : hay[index - 1];
    const wordStart = before === undefined || /[\s\-–—/(,.·]/.test(before);
    ranked.push({ option, rank: index === 0 ? 0 : wordStart ? 1 : 2, at });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.at - b.at);
  return ranked.map((entry) => entry.option);
}

/**
 * Rolling type-ahead buffer (~700ms window, like the native `<select>`).
 *
 * Only ever used by a list too short to have earned a filter box. Losing it there would be a real
 * regression for the way these forms are filled: focus Status, press "d", get Draft, without the
 * control ever opening. A list WITH a filter box has a better answer already, and running both would
 * mean two different things happening for one keystroke.
 */
function useTypeahead() {
  const state = useRef({ text: "", at: 0 });
  return useCallback((char: string) => {
    const now = Date.now();
    if (now - state.current.at > 700) state.current.text = "";
    state.current.at = now;
    state.current.text += char.toLowerCase();
    return state.current.text;
  }, []);
}

/** Next enabled index walking `delta` (+1/-1) from `current`, wrapping around. */
function stepHighlight(options: readonly SelectOption[], current: number, delta: number): number {
  const count = options.length;
  if (count === 0) return -1;
  let index = current < 0 || current >= count ? (delta > 0 ? -1 : count) : current;
  for (let step = 0; step < count; step += 1) {
    index = (index + delta + count) % count;
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

/** A character key rather than a chord or a named key — Space excluded, it toggles the panel. */
function isPrintable(event: ReactKeyboardEvent): boolean {
  return (
    event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey
  );
}

function firstEnabled(options: readonly SelectOption[]): number {
  return options.findIndex((option) => !option.disabled);
}

/**
 * The highlighted row's appearance.
 *
 * The purple ramp is brand colour and deliberately does NOT invert with the theme, so purple-50 is
 * near-white in both modes — as a highlight it painted a white bar across a dark menu. The dark
 * counterparts are the ones `components/ui/Calendar.tsx` uses for its day cells, so a menu and a
 * calendar highlight the thing under the cursor identically.
 */
function optionClass(option: SelectOption, highlighted: boolean, active: boolean): string {
  return cn(
    "flex items-center gap-2 px-3.5 py-2 text-sm",
    option.disabled ? "cursor-not-allowed text-ink-300" : "cursor-pointer",
    !option.disabled && highlighted ? "bg-purple-50 dark:bg-purple-950" : undefined,
    active
      ? "font-medium text-purple-700 dark:text-purple-300"
      : option.disabled
        ? undefined
        : "text-ink-700"
  );
}

/**
 * Keeps the highlighted row on screen.
 *
 * `block: "nearest"` rather than "center", so arrowing down a long list scrolls by one row instead of
 * jumping the viewport around under the reader.
 */
function useScrollHighlightIntoView(open: boolean, highlight: number, baseId: string) {
  useEffect(() => {
    if (!open || highlight < 0) return;
    document.getElementById(`${baseId}-opt-${highlight}`)?.scrollIntoView({ block: "nearest" });
  }, [open, highlight, baseId]);
}

/**
 * Everything the panel needs, derived rather than stored.
 *
 * The one piece of raw state is `highlight`, and even that is passed through `safeHighlight` before
 * anything reads it — see decision 2 in the file header.
 */
function useSelectList(
  options: readonly SelectOption[],
  query: string,
  searchable: boolean,
  chosen: ReadonlySet<string>
) {
  const filtered = useMemo(
    () => (searchable ? filterOptions(options, query) : [...options]),
    [options, query, searchable]
  );

  const rendered = useMemo(() => {
    if (filtered.length <= RENDER_CAP) return filtered;
    const window = filtered.slice(0, RENDER_CAP);
    // A cap must never hide what the reader already picked. A folder sitting 140th of 300 would
    // otherwise reopen the picker with no tick anywhere in it and no hint that the value was real —
    // the control would be lying about its own state. Anything selected that the window missed is
    // pinned to the top, where the check mark says what it is.
    const missing = filtered.filter((option) => chosen.has(option.value) && !window.includes(option));
    return missing.length > 0 ? [...missing, ...window] : window;
  }, [filtered, chosen]);

  return { filtered, rendered, capped: filtered.length - rendered.length };
}

/**
 * Keeps the panel's own keystrokes inside the panel, and why that is not paranoia.
 *
 * A React portal moves the panel out of the DOM but NOT out of the React tree, so synthetic events
 * still bubble to whatever component rendered the select. The studio's editors are full of
 * `<form onInput={markDirty}>` and Enter-to-submit handling, and both would have picked up the filter
 * box: typing three letters to find a tag, changing nothing, would arm the unsaved-changes prompt, so
 * a reader who searched, picked nothing and pressed Escape could not leave the page.
 *
 * Nothing outside the panel has any business knowing what was typed into a filter, so the whole class
 * of problem is cut off here rather than patched per form.
 *
 * ⚠ TAB IS DELIBERATELY LET THROUGH, and this is the one line the port had to change. In the source
 * the panel owned both ends of the tab order itself (`useEdgeTab`); here `Popover` owns them, on a
 * handler attached to the panel element — which is an ANCESTOR of this wrapper. React portals move
 * the DOM but not the React tree, so a blanket `stopPropagation()` here would stop Tab reaching that
 * handler and the panel would trap the keyboard at its last control: no way out but the mouse. Escape
 * is unaffected either way, because `Popover` takes it on a window-CAPTURE listener that runs before
 * any of this.
 */
const PANEL_EVENT_GUARD = {
  onKeyDown: (event: ReactKeyboardEvent) => {
    if (event.key === "Tab") return;
    event.stopPropagation();
  },
  onInput: (event: FormEvent) => event.stopPropagation(),
  onChange: (event: FormEvent) => event.stopPropagation()
};

/** Shared search row, so the single- and multi-select boxes are the same box. */
function SearchRow({
  inputRef,
  inputId,
  listboxId,
  activeId,
  query,
  onQueryChange,
  onKeyDown,
  label,
  trailing
}: {
  inputRef: (node: HTMLInputElement | null) => void;
  inputId: string;
  listboxId: string;
  activeId: string | undefined;
  query: string;
  onQueryChange: (value: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  label: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-line-200 p-2">
      <div className="relative min-w-0 flex-1">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-500"
        />
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-label={label}
          autoComplete="off"
          spellCheck={false}
          value={query}
          placeholder="Type to filter"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
          className="w-full rounded-sm border border-line-200 bg-card py-1.5 pl-8 pr-2 text-sm text-ink-900 outline-none transition placeholder:text-ink-300 focus:border-purple-600 focus:ring-2 focus:ring-purple-600/15"
        />
      </div>
      {trailing}
    </div>
  );
}

/**
 * The "N of M shown" footer. Only drawn when the cap actually bit.
 *
 * A list that quietly stops at eighty is indistinguishable from a list of eighty (contract §6), so
 * the remainder is counted out loud.
 */
function CapNotice({ shown, total }: { shown: number; total: number }) {
  return (
    <p className="shrink-0 border-t border-line-200 bg-surface-50 px-3.5 py-2 text-xs leading-4 text-ink-500">
      Showing the first {shown} of {total}. Keep typing to narrow the list.
    </p>
  );
}

/**
 * Focus the filter box as it mounts — but only if the keyboard is still where opening left it.
 *
 * Two things make this less trivial than an effect keyed on `open`. The panel is portalled and only
 * mounts once `Popover` has resolved its host, a render later than `open` flipping, so an effect fires
 * before the box exists; attaching the focus to the ref callback is the one moment guaranteed to be
 * after it.
 *
 * The second is the reason for the guard, and it was caught on a real page rather than reasoned about.
 * Options that arrive over the network are not there when the panel opens: a folder list that takes a
 * second and a half means the select opens with zero options, sits BELOW the search threshold, renders
 * no filter box at all — and then grows one when the response lands. An unconditional focus there
 * yanks the keyboard out of whatever the reader moved on to, seconds after they opened the menu. So
 * the box claims focus only from the trigger it belongs to (or from nothing at all).
 */
function useFilterBoxFocus(triggerRef: RefObject<HTMLButtonElement | null>) {
  return useCallback(
    (node: HTMLInputElement | null) => {
      if (!node) return;
      // Deferred a frame rather than focused inline, and this one is load-bearing. Refs attach
      // bottom-up, so at the moment this callback runs `Popover`'s own panel ref — held on an ANCESTOR
      // of this input — is still null. Its outside-press guard asks whether the panel contains the
      // target, and against a null panel an in-panel focus is indistinguishable from a click away.
      requestAnimationFrame(() => {
        if (!node.isConnected) return;
        const active = document.activeElement;
        if (active && active !== document.body && active !== triggerRef.current) return;
        node.focus({ preventScroll: true });
      });
    },
    [triggerRef]
  );
}

export interface SearchableSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
  /**
   * The control's accessible name. Inside a `<Field>` the label is picked up automatically and this
   * is only needed for a bare control — a toolbar filter with a visually hidden label, say.
   */
  ariaLabel?: string;
  /** Extra ids to describe the control with, ON TOP of the Field's own help and error paragraphs. */
  describedBy?: string;
  /**
   * `undefined` lets `SEARCH_THRESHOLD` decide, which is what almost every call site should do. Force
   * it on for a list that is short today and long next month, off for one that is a fixed vocabulary
   * however many entries it grows.
   */
  searchable?: boolean;
}

export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = "Select",
  emptyLabel = "No options",
  disabled,
  className,
  ariaLabel,
  describedBy,
  searchable
}: SearchableSelectProps) {
  const field = useFieldContext();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const typeahead = useTypeahead();

  const withSearch = searchable ?? options.length >= SEARCH_THRESHOLD;
  const chosen = useMemo(() => new Set(value ? [value] : []), [value]);
  const { filtered, rendered, capped } = useSelectList(options, query, withSearch, chosen);

  // Derived, not stored — the stored index is only ever a hint. See decision 2 in the header.
  const safeHighlight =
    highlight >= 0 && highlight < rendered.length && !rendered[highlight]?.disabled
      ? highlight
      : firstEnabled(rendered);
  const activeId = safeHighlight >= 0 ? `${baseId}-opt-${safeHighlight}` : undefined;
  useScrollHighlightIntoView(open, safeHighlight, baseId);

  const selected = options.find((option) => option.value === value);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  const choose = (index: number) => {
    const option = rendered[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    close();
    // Back to the trigger, which is where the reader's place in the tab order is. See the header on
    // why the source's `advanceOnSelect` did not come across.
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  };

  const openPanel = () => {
    setQuery("");
    setOpen(true);
    // Indexed against `rendered`, which is what the highlight means everywhere else. Against the raw
    // options array a pinned selection past the cap would highlight whatever sat at that index.
    const at = rendered.findIndex((option) => option.value === value);
    setHighlight(at >= 0 && !rendered[at]?.disabled ? at : firstEnabled(rendered));
  };

  /** Typing in the box always re-aims Enter at the top match. */
  const onQueryChange = (next: string) => {
    setQuery(next);
    setHighlight(0);
  };

  /** Arrow/Enter/Home/End, shared by the trigger (short lists) and the search box (long ones). */
  const navigate = (event: ReactKeyboardEvent): boolean => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (open) setHighlight(stepHighlight(rendered, safeHighlight, 1));
        else openPanel();
        return true;
      case "ArrowUp":
        event.preventDefault();
        if (open) setHighlight(stepHighlight(rendered, safeHighlight, -1));
        else openPanel();
        return true;
      case "Home":
        if (!open) return false;
        event.preventDefault();
        setHighlight(stepHighlight(rendered, -1, 1));
        return true;
      case "End":
        if (!open) return false;
        event.preventDefault();
        setHighlight(stepHighlight(rendered, -1, -1));
        return true;
      case "Enter":
        if (!open) return false;
        event.preventDefault();
        // Guarded on the DERIVED index, so Enter can only ever take a row that is on screen.
        if (safeHighlight >= 0) choose(safeHighlight);
        return true;
      default:
        return false;
    }
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent) => {
    if (navigate(event)) return;
    if (event.key === " ") {
      event.preventDefault();
      if (open) {
        if (safeHighlight >= 0) choose(safeHighlight);
      } else openPanel();
      return;
    }
    if (event.key === "Tab" && open) close();
    // Native-`<select>` type-ahead, and only where there is no filter box to do the job properly.
    if (!withSearch && isPrintable(event)) {
      event.preventDefault();
      const typed = typeahead(event.key);
      const match = options.findIndex(
        (option) => !option.disabled && fold(option.label).startsWith(typed)
      );
      if (match < 0) return;
      if (open) setHighlight(match);
      else {
        const option = options[match];
        if (option) onChange(option.value);
      }
    }
    // Escape is not handled here: `Popover` takes it on a window-capture listener, closes only the
    // topmost panel, and puts focus back on the anchor — which is this trigger.
  };

  const inputRef = useFilterBoxFocus(triggerRef);

  const announcement =
    withSearch && query.trim()
      ? `${filtered.length} of ${options.length} options match ${query.trim()}`
      : `${options.length} options`;

  return (
    // `min-w-0` is load-bearing, not tidying. A grid or flex item defaults to `min-width: auto`, which
    // refuses to shrink below its content's intrinsic width — so a long option label widens this
    // wrapper past its column and the trigger overlaps the field beside it. The `truncate` inside
    // cannot prevent that on its own: it clips text within a box that has already been allowed to
    // grow. The box has to be allowed to shrink first.
    <div className={cn("relative min-w-0", className)}>
      <button
        ref={triggerRef}
        type="button"
        id={field?.controlId}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        // No `aria-labelledby` companion: the Field renders `<label htmlFor={controlId}>` and a
        // `<button>` is a labelable element, so the association already names this control. Adding
        // both would be two mechanisms saying the same thing, and the one that wins is not obvious.
        aria-label={ariaLabel}
        aria-describedby={cn(field?.describedBy, describedBy) || undefined}
        aria-controls={open ? listboxId : undefined}
        // Only when the trigger itself owns the keyboard; with a search box the input does.
        aria-activedescendant={open && !withSearch ? activeId : undefined}
        onClick={() => (open ? close() : openPanel())}
        onKeyDown={onTriggerKeyDown}
        className={TRIGGER_CLASS}
      >
        {/*
          `ink-500`, NOT the `ink-300` placeholder rung, and the distinction is one the token ladder
          does not draw for us. `ink-300` is below AA on the card in both themes — defensible for a
          `::placeholder` hovering behind text somebody is about to type over, and indefensible here:
          while nothing is selected this span is the ONLY text the control has, and the whole question
          it is asking is carried by it.
        */}
        <span className={cn("min-w-0 truncate", selected ? undefined : "text-ink-500")} title={selected?.label}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn("h-4 w-4 shrink-0 text-ink-500 transition-transform", open ? "rotate-180" : undefined)}
        />
      </button>

      <Popover
        open={open}
        onClose={close}
        // The BUTTON, not the wrapper: `Popover` returns focus to its anchor when the reader tabs off
        // either end of the panel, and a `<div>` cannot take focus.
        anchorRef={triggerRef}
        role="group"
        label={ariaLabel ? `${ariaLabel} options` : "Options"}
        matchAnchorWidth
        className={PANEL_CLASS}
      >
        <div {...PANEL_EVENT_GUARD} className="flex min-h-0 flex-col">
          {withSearch ? (
            <SearchRow
              inputRef={inputRef}
              inputId={`${baseId}-search`}
              listboxId={listboxId}
              activeId={activeId}
              query={query}
              onQueryChange={onQueryChange}
              onKeyDown={navigate}
              label={ariaLabel ? `Filter ${ariaLabel}` : "Filter options"}
            />
          ) : null}

          <ul
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel ?? "Options"}
            className="min-h-0 max-h-72 shrink overflow-y-auto overscroll-contain py-1"
          >
            {rendered.length === 0 ? (
              <li className="px-3.5 py-2 text-sm text-ink-500">
                {query.trim() ? "No matches" : emptyLabel}
              </li>
            ) : null}
            {rendered.map((option, index) => {
              const active = option.value === value;
              return (
                <li
                  key={option.value}
                  id={`${baseId}-opt-${index}`}
                  role="option"
                  aria-selected={active}
                  aria-disabled={option.disabled || undefined}
                  title={option.label}
                  onMouseEnter={() => {
                    if (!option.disabled) setHighlight(index);
                  }}
                  // Keeps focus in the search box so the reader can keep typing after a mis-click, and
                  // stops the browser hunting for a focus target as the row is removed.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(index)}
                  className={optionClass(option, index === safeHighlight, active)}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {active ? (
                    <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-purple-700 dark:text-purple-300" />
                  ) : null}
                </li>
              );
            })}
          </ul>

          {capped > 0 ? <CapNotice shown={rendered.length} total={filtered.length} /> : null}
          <p className="sr-only" role="status">
            {announcement}
          </p>
        </div>
      </Popover>
    </div>
  );
}

export interface SearchableMultiSelectProps {
  values: readonly string[];
  onChange: (values: string[]) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  describedBy?: string;
  searchable?: boolean;
  /**
   * Show a Confirm button in the panel once at least one option is ticked; confirming closes it.
   *
   * A multi-select cannot close on click the way a single-select does — picking one option is usually
   * not the end of the answer — so without an explicit "done" the reader has to know to click away,
   * and the form gives no signal that the answer was registered. Set false where the control filters a
   * list in place rather than answering a form field.
   */
  confirmOnSelect?: boolean;
  confirmLabel?: string;
}

export function SearchableMultiSelect({
  values,
  onChange,
  options,
  placeholder = "Select",
  emptyLabel = "No options",
  disabled,
  className,
  ariaLabel,
  describedBy,
  searchable,
  confirmOnSelect = true,
  confirmLabel = "Confirm"
}: SearchableMultiSelectProps) {
  const field = useFieldContext();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const typeahead = useTypeahead();

  const withSearch = searchable ?? options.length >= SEARCH_THRESHOLD;
  const chosen = useMemo(() => new Set(values), [values]);
  const { filtered, rendered, capped } = useSelectList(options, query, withSearch, chosen);

  const safeHighlight =
    highlight >= 0 && highlight < rendered.length && !rendered[highlight]?.disabled
      ? highlight
      : firstEnabled(rendered);
  const activeId = safeHighlight >= 0 ? `${baseId}-opt-${safeHighlight}` : undefined;
  useScrollHighlightIntoView(open, safeHighlight, baseId);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  const closeAndReturn = useCallback(() => {
    close();
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  }, [close]);

  const toggle = (index: number) => {
    const option = rendered[index];
    if (!option || option.disabled) return;
    if (chosen.has(option.value)) onChange(values.filter((entry) => entry !== option.value));
    else onChange([...values, option.value]);
  };

  /**
   * What "select all" acts on, and why it is the filtered set rather than every option.
   *
   * The reader typed to narrow the list; acting on the rows they deliberately filtered OUT would be
   * the one outcome they cannot see coming. So the button scopes itself to the matches, says which it
   * did ("Select 6 matching" vs "Select all 74"), and leaves any selection made outside the current
   * filter completely alone — clearing 6 matches never quietly drops a 7th pick the query hides. The
   * cap on rendered rows is NOT applied here: the label promises every match, so every match is what
   * it takes.
   */
  const bulk = useMemo(() => filtered.filter((option) => !option.disabled), [filtered]);
  const allChosen = bulk.length > 0 && bulk.every((option) => chosen.has(option.value));
  const filtering = withSearch && query.trim().length > 0;
  const bulkLabel = allChosen
    ? filtering
      ? `Clear ${bulk.length} matching`
      : `Clear all ${bulk.length}`
    : filtering
      ? `Select ${bulk.length} matching`
      : `Select all ${bulk.length}`;

  const applyBulk = () => {
    if (allChosen) {
      const drop = new Set(bulk.map((option) => option.value));
      onChange(values.filter((entry) => !drop.has(entry)));
      return;
    }
    // Appended rather than rebuilt, so the order the reader picked things in survives.
    const have = new Set(values);
    onChange([...values, ...bulk.map((option) => option.value).filter((entry) => !have.has(entry))]);
  };

  const openPanel = () => {
    setQuery("");
    setOpen(true);
    setHighlight(firstEnabled(rendered));
  };

  const onQueryChange = (next: string) => {
    setQuery(next);
    setHighlight(0);
  };

  const navigate = (event: ReactKeyboardEvent): boolean => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (open) setHighlight(stepHighlight(rendered, safeHighlight, 1));
        else openPanel();
        return true;
      case "ArrowUp":
        event.preventDefault();
        if (open) setHighlight(stepHighlight(rendered, safeHighlight, -1));
        else openPanel();
        return true;
      case "Home":
        if (!open) return false;
        event.preventDefault();
        setHighlight(stepHighlight(rendered, -1, 1));
        return true;
      case "End":
        if (!open) return false;
        event.preventDefault();
        setHighlight(stepHighlight(rendered, -1, -1));
        return true;
      case "Enter":
        if (!open) return false;
        event.preventDefault();
        // Ticks and STAYS OPEN — picking one option is rarely the end of a multi-select answer.
        if (safeHighlight >= 0) toggle(safeHighlight);
        return true;
      default:
        return false;
    }
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent) => {
    if (navigate(event)) return;
    if (event.key === " ") {
      event.preventDefault();
      if (open) {
        if (safeHighlight >= 0) toggle(safeHighlight);
      } else openPanel();
      return;
    }
    if (event.key === "Tab" && open) close();
    // Type-ahead only MOVES the highlight here — a multi-select must never tick a box from a keystroke
    // aimed at finding one.
    if (!withSearch && isPrintable(event)) {
      event.preventDefault();
      const typed = typeahead(event.key);
      const match = options.findIndex(
        (option) => !option.disabled && fold(option.label).startsWith(typed)
      );
      if (match < 0) return;
      if (!open) setOpen(true);
      setHighlight(match);
    }
  };

  const inputRef = useFilterBoxFocus(triggerRef);

  const chosenLabels = useMemo(
    () => options.filter((option) => chosen.has(option.value)).map((option) => option.label),
    [options, chosen]
  );

  /** The selected set as prose, so a screen reader gets the names and not just "3 selected". */
  const selectionSummary =
    chosenLabels.length === 0
      ? "Nothing selected"
      : chosenLabels.length <= SUMMARY_NAMES
        ? `${chosenLabels.length} selected: ${chosenLabels.join(", ")}`
        : `${chosenLabels.length} selected, including ${chosenLabels.slice(0, SUMMARY_NAMES).join(", ")}`;

  const announcement = `${
    filtering
      ? `${filtered.length} of ${options.length} options match ${query.trim()}`
      : `${options.length} options`
  }. ${selectionSummary}.`;

  /**
   * Reached with the mouse, and by Tab — it is the next control after the filter box, so a keyboard
   * reader finds it by walking rather than by knowing. An earlier draft in the source also bound
   * Ctrl/Cmd+A; it was dropped because inside a text box that chord already means "select the text I
   * just typed", and quietly redefining it to "tick 74 rows" is exactly the kind of surprise this
   * control exists to avoid.
   */
  const bulkButton =
    bulk.length > 0 ? (
      <button
        type="button"
        onClick={applyBulk}
        onMouseDown={(event) => event.preventDefault()}
        className="shrink-0 whitespace-nowrap rounded-sm border border-line-200 bg-card px-2 py-1.5 text-xs font-medium text-purple-700 outline-none transition hover:border-purple-300 hover:bg-purple-50 focus-visible:border-purple-600 focus-visible:ring-2 focus-visible:ring-purple-600/20 dark:text-purple-300 dark:hover:bg-purple-950"
      >
        {bulkLabel}
      </button>
    ) : null;

  return (
    <div className={cn("relative min-w-0", className)}>
      <button
        ref={triggerRef}
        type="button"
        id={field?.controlId}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        /*
          The selection travels as a DESCRIPTION, not folded into the name.
          The source appended it to `aria-label`, which works only when the caller supplies one — and
          inside a `<Field>` nobody does, because the label element already names the control. Worse,
          an `aria-label` there would OVERRIDE that label, so the field's own wording would vanish.
          `aria-describedby` is announced after the name in every reader and stacks with the Field's
          help and error paragraphs, which is exactly the behaviour wanted: "Craft tags, 3 selected:
          Bagru, Ajrakh, Kalamkari, required".
        */
        aria-describedby={cn(field?.describedBy, describedBy, `${baseId}-summary`)}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && !withSearch ? activeId : undefined}
        onClick={() => (open ? close() : openPanel())}
        onKeyDown={onTriggerKeyDown}
        className={TRIGGER_CLASS}
      >
        {/* Same rung, same reason as the single-select trigger above. */}
        <span className={cn("min-w-0 truncate", values.length === 0 ? "text-ink-500" : undefined)}>
          {values.length > 0 ? `${values.length} selected` : placeholder}
        </span>
        {/* The description `aria-describedby` above points at. Inside the button so it moves with it,
            and `sr-only` because the visible "3 selected" already says the count to everybody else. */}
        <span id={`${baseId}-summary`} className="sr-only">
          {selectionSummary}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn("h-4 w-4 shrink-0 text-ink-500 transition-transform", open ? "rotate-180" : undefined)}
        />
      </button>

      <Popover
        open={open}
        onClose={close}
        anchorRef={triggerRef}
        role="group"
        label={ariaLabel ? `${ariaLabel} options` : "Options"}
        matchAnchorWidth
        className={PANEL_CLASS}
      >
        <div {...PANEL_EVENT_GUARD} className="flex min-h-0 flex-col">
          {withSearch ? (
            <SearchRow
              inputRef={inputRef}
              inputId={`${baseId}-search`}
              listboxId={listboxId}
              activeId={activeId}
              query={query}
              onQueryChange={onQueryChange}
              onKeyDown={navigate}
              label={ariaLabel ? `Filter ${ariaLabel}` : "Filter options"}
              trailing={bulkButton}
            />
          ) : bulkButton ? (
            // No search box on a short list, but "select all" still earns its place — four folders is
            // four clicks otherwise.
            <div className="flex shrink-0 justify-end border-b border-line-200 p-2">{bulkButton}</div>
          ) : null}

          <ul
            id={listboxId}
            role="listbox"
            aria-multiselectable
            aria-label={ariaLabel ?? "Options"}
            className="min-h-0 max-h-72 shrink overflow-y-auto overscroll-contain py-1"
          >
            {rendered.length === 0 ? (
              <li className="px-3.5 py-2 text-sm text-ink-500">
                {query.trim() ? "No matches" : emptyLabel}
              </li>
            ) : null}
            {rendered.map((option, index) => {
              const checked = chosen.has(option.value);
              return (
                <li
                  key={option.value}
                  id={`${baseId}-opt-${index}`}
                  role="option"
                  aria-selected={checked}
                  aria-disabled={option.disabled || undefined}
                  title={option.label}
                  onMouseEnter={() => {
                    if (!option.disabled) setHighlight(index);
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => toggle(index)}
                  className={optionClass(option, index === safeHighlight, checked)}
                >
                  {/* Decoration: `aria-selected` on the row already carries the tick to a reader, and
                      a second announcement of the same fact is noise. */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "grid h-4 w-4 shrink-0 place-items-center rounded border transition",
                      checked ? "border-purple-700 bg-purple-700 text-white" : "border-line-200 bg-card"
                    )}
                  >
                    {checked ? <Check className="h-3 w-3" /> : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                </li>
              );
            })}
          </ul>

          {capped > 0 ? <CapNotice shown={rendered.length} total={filtered.length} /> : null}

          {confirmOnSelect && values.length > 0 ? (
            <div className="shrink-0 border-t border-line-200 bg-card p-2">
              <button
                type="button"
                className="field-button w-full py-1.5 text-xs"
                onClick={closeAndReturn}
                onMouseDown={(event) => event.preventDefault()}
              >
                {confirmLabel} ({values.length})
              </button>
            </div>
          ) : null}

          <p className="sr-only" role="status">
            {announcement}
          </p>
        </div>
      </Popover>
    </div>
  );
}
