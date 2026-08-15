"use client";

/**
 * AccessibilityMenu — the popover that flips theme, reduced motion, larger text and high contrast.
 *
 * It appears twice: in the public footer (opening upwards) and in the studio top bar (opening
 * downwards). Both mount the same component; `side` and `align` are the only difference, because two
 * copies of these four controls would drift the moment one gained a fifth.
 *
 * THE CONTROLS ARE REAL `<button role="switch" aria-checked>` ELEMENTS WITH VISIBLE LABELS. A styled
 * `<div>` with a click handler is invisible to a screen reader and unreachable by keyboard; a switch
 * that only shows its state as a colour is invisible to the readers this menu exists for. So each row
 * carries the label inside the button (that is the accessible name), the word "On"/"Off" beside the
 * track for eyes, and `aria-checked` for assistive technology — three routes to one fact. THE WHOLE
 * ROW IS THE TARGET AND IT IS 44px TALL (`min-h-11` plus padding): the switch itself is 20px, and a
 * 20px target on a phone is a coin toss on precisely the menu somebody opens because pointing is hard.
 *
 * EACH OPTION EXPLAINS ITSELF IN ONE LINE, wired with `aria-describedby` rather than nested inside
 * the button: text inside a `<button>` becomes part of its accessible name, so an explanation placed
 * there would be read out on every focus as though it were the label.
 *
 * NO POPOVER LIBRARY AND NO ENTRANCE ANIMATION. A focus trap, Escape, click-outside and focus
 * restoration are the whole contract of a popover, and they are ~40 lines. The panel appears
 * instantly: CSS cannot transition a mount without a two-frame dance, and pulling framer-motion in
 * for a 200 ms fade would put an `AnimatePresence` between a reader and the control they opened the
 * menu to reach.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { Accessibility, Monitor, Moon, Sun, X, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { usePreferences } from "@/components/providers/PreferencesProvider";
import type { Preferences, ThemeChoice } from "@/lib/preferences";

export interface AccessibilityMenuProps {
  className?: string;
  /** Which edge of the trigger the panel lines up with. Default "end" (right edge). */
  align?: "start" | "end";
  /** "bottom" for a top bar, "top" for a footer. Default "bottom". */
  side?: "top" | "bottom";
  /** Show the word beside the icon. Off in a dense studio bar, on in the public footer. */
  showLabel?: boolean;
}

// Complete literal class strings — a name assembled by concatenation is purged (contract §5).
const SIDE_CLASS: Record<"top" | "bottom", string> = {
  bottom: "top-full mt-2",
  top: "bottom-full mb-2"
};

const ALIGN_CLASS: Record<"start" | "end", string> = {
  start: "left-0",
  end: "right-0"
};

const THEME_OPTIONS: ReadonlyArray<{ value: ThemeChoice; label: string; icon: LucideIcon }> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor }
];

/** The three boolean modes, in the order they are most often wanted. */
const SWITCHES: ReadonlyArray<{
  key: Exclude<keyof Preferences, "theme">;
  label: string;
  description: string;
}> = [
  {
    key: "reducedMotion",
    label: "Reduced motion",
    description: "Stops decorative animation, parallax and smooth scrolling across the site."
  },
  {
    key: "largerText",
    label: "Larger text",
    description: "Raises the base text size from 16 to 18 pixels; the whole layout scales with it."
  },
  {
    key: "highContrast",
    label: "High contrast",
    description: "Strengthens borders, muted text and the keyboard focus ring."
  }
];

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  );
}

export function AccessibilityMenu({
  className,
  align = "end",
  side = "bottom",
  showLabel = false
}: AccessibilityMenuProps) {
  const { preferences, setPreference, setTheme } = usePreferences();
  const [open, setOpen] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const panelId = useId();
  const titleId = useId();
  const themeLabelId = useId();

  const close = useCallback(() => {
    // Read before the state change, while the panel is still mounted. Focus only goes back to the
    // trigger if it was inside the panel — after a click on something else on the page, yanking it
    // back would move the reader away from what they just chose.
    const panel = panelRef.current;
    const active = document.activeElement;
    const focusWasInside = panel !== null && active instanceof Node && panel.contains(active);
    setOpen(false);
    if (focusWasInside) triggerRef.current?.focus();
  }, []);

  // Move focus into the panel on open, so the first Tab is inside it rather than past it.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const first = focusableWithin(panel)[0];
    (first ?? panel).focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const target = event.target;
      // The trigger lives inside `root`, so its own click falls through to the toggle below rather
      // than being closed here and immediately reopened.
      if (target instanceof Node && root.contains(target)) return;
      close();
    };
    // Capture phase: a control elsewhere on the page that stops propagation must not be able to
    // strand this panel open.
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, close]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!open) return;

    if (event.key === "Escape") {
      event.preventDefault();
      // Stopped here so Escape cannot also reach a dialog or nav sheet this menu is rendered inside
      // and close two things at once (contract §14).
      event.stopPropagation();
      close();
      return;
    }

    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;

    const items = focusableWithin(panel);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;

    const active = document.activeElement;
    const insidePanel = active instanceof Node && panel.contains(active);

    if (event.shiftKey && (active === first || !insidePanel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div ref={rootRef} className={cn("relative inline-block", className)} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        // Only while the panel is mounted — an `aria-controls` pointing at an id that is not in the
        // document is worse than no `aria-controls` at all (contract §11).
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? close() : setOpen(true))}
        className="inline-flex min-h-10 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-ink-700 transition hover:bg-surface-100 hover:text-ink-900"
      >
        <Accessibility aria-hidden="true" className="h-4 w-4" />
        {/* The word is always in the accessible name; `showLabel` only decides whether eyes see it,
            so the name a voice control user speaks always matches any visible text. */}
        <span className={showLabel ? undefined : "sr-only"}>Accessibility</span>
      </button>

      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-labelledby={titleId}
          // Deliberately NOT `aria-modal`: the page behind stays operable and claiming modality would
          // tell a screen reader the rest of the document is inert when it is not. Focus is still
          // kept inside while it is open, so a keyboard reader cannot tab out and lose the panel.
          tabIndex={-1}
          className={cn(
            "absolute z-[70] w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-line-200 bg-card p-4 shadow-panel",
            SIDE_CLASS[side],
            ALIGN_CLASS[align]
          )}
        >
          <div className="flex items-start justify-between gap-2">
            {/* A <p>, not an <h_>: this component is mounted in a footer and in a top bar, and there
                is no heading level that is correct in both without skipping one (contract §11). */}
            <p id={titleId} className="text-sm font-semibold text-ink-900">
              Display and accessibility
            </p>
            <button
              type="button"
              onClick={close}
              aria-label="Close display and accessibility settings"
              className="-mr-1 -mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-500 transition hover:bg-surface-100 hover:text-ink-900"
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-4">
            <p id={themeLabelId} className="field-label">
              Theme
            </p>
            <p className="mt-1 text-xs leading-relaxed text-ink-500">
              System follows the light or dark setting of your device.
            </p>
            {/*
              A group of toggle buttons rather than a `radiogroup`: a radiogroup owes the reader a
              roving tabindex and arrow-key navigation, and a half-built one strands focus. Here every
              option is tabbable and Enter or Space picks it, which is the behaviour the rest of the
              menu already has.
            */}
            <div
              role="group"
              aria-labelledby={themeLabelId}
              className="mt-2 grid grid-cols-3 gap-1 rounded-md border border-line-200 bg-surface-50 p-1"
            >
              {THEME_OPTIONS.map((option) => {
                const active = preferences.theme === option.value;
                const OptionIcon = option.icon;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setTheme(option.value)}
                    className={cn(
                      "inline-flex flex-col items-center gap-1 rounded-sm px-2 py-2 text-xs font-medium transition",
                      active
                        ? "bg-purple-700 text-white shadow-glow-soft"
                        : "text-ink-700 hover:bg-surface-200 hover:text-ink-900"
                    )}
                  >
                    <OptionIcon aria-hidden="true" className="h-4 w-4" />
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-4 space-y-3 border-t border-line-200 pt-3">
            {SWITCHES.map((item) => (
              <SwitchRow
                key={item.key}
                label={item.label}
                description={item.description}
                checked={preferences[item.key]}
                onChange={(next) => setPreference(item.key, next)}
              />
            ))}
          </div>

          <p className="mt-4 text-xs leading-relaxed text-ink-500">
            These settings are kept in this browser only and apply the moment you change them.
          </p>
        </div>
      ) : null}
    </div>
  );
}

interface SwitchRowProps {
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}

function SwitchRow({ label, description, checked, onChange }: SwitchRowProps) {
  const descriptionId = useId();
  return (
    <div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={descriptionId}
        onClick={() => onChange(!checked)}
        // `min-h-11` and the padding are the whole point of the row: the tallest thing inside is the
        // 20px track, and a 20px target on the controls a reader with a motor impairment reaches for
        // first is the one place in the product that cannot be allowed to miss the 44px floor. Same
        // treatment as `Switch`, deliberately, so the two never drift apart.
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md py-1.5 text-left"
      >
        <span className="text-sm font-medium text-ink-900">{label}</span>
        <span className="flex shrink-0 items-center gap-2">
          {/* `aria-checked` already tells a screen reader the state; putting the word in the
              accessible name too would make it read "Reduced motion On, switch, on". */}
          <span
            aria-hidden="true"
            className={cn("text-xs font-medium", checked ? "text-purple-700" : "text-ink-500")}
          >
            {checked ? "On" : "Off"}
          </span>
          <span
            aria-hidden="true"
            className={cn(
              "inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition",
              checked ? "border-purple-700 bg-purple-700" : "border-line-200 bg-surface-200"
            )}
          >
            {/*
              The knob is a plain CSS transition, so the global reduced-motion rule collapses it to an
              instant jump — the POSITION is the signal, and it survives either way.

              ⚠ IT TRAVELS ON `transform`, NEVER ON A MARGIN. `ml-0.5` → `ml-[1.125rem]` under
              `transition-all` animated `margin-left`, which forces layout on every frame of the
              flip — and `transition-all` would have picked up any other property that changed with
              it. `translate-x-4` is the same 16px journey (2px → 18px) on the compositor, and it is
              the treatment `Switch` already uses, which this row is supposed to match.
            */}
            <span
              className={cn(
                "ml-0.5 h-3.5 w-3.5 rounded-full bg-white transition-transform",
                checked && "translate-x-4"
              )}
            />
          </span>
        </span>
      </button>
      <p id={descriptionId} className="mt-1 text-xs leading-relaxed text-ink-500">
        {description}
      </p>
    </div>
  );
}
