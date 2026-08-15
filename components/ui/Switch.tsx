"use client";

/**
 * Switch — a real `<input type="checkbox" role="switch">`.
 *
 * A switch and a checkbox differ in meaning, not in mechanics: a checkbox is an answer that takes
 * effect when the form is submitted, a switch is a setting that takes effect NOW. `role="switch"` is
 * the one attribute that carries that difference to a screen reader, and it is permitted on a
 * checkbox input, so the control stays a real form element — keyboard, `FormData`, native input
 * events and all (see Checkbox.tsx for why that matters to the studio's dirty tracker).
 *
 * THREE ROUTES TO ONE FACT, as in AccessibilityMenu: the knob's POSITION (survives monochrome and
 * reduced motion — it is a static offset, not an animation), the WORD "On"/"Off" beside it, and
 * `aria-checked`, which the browser derives from `checked` on a real input. Colour is the fourth and
 * is never asked to carry it alone (contract §11).
 *
 * THE INPUT IS `sr-only`, SO ITS OWN FOCUS RING IS DRAWN ROUND A 1px BOX and is effectively
 * invisible. The ring therefore lives on the track via `peer-focus-visible:` — and it is NAMED
 * `ring-purple-600/15`, because an unnamed `ring-4` is stock BLUE (contract §3).
 *
 * THE TRACK AND THE KNOB ARE BOTH SIBLINGS OF THE INPUT. Tailwind's `peer-*` variants compile to a
 * general-sibling selector (`.peer:checked ~ …`), which does not reach descendants — a knob nested
 * inside the track would silently never move.
 */

import { useId, useState, type ChangeEvent, type ComponentPropsWithRef, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { useFieldContext } from "@/components/ui/Field";

export interface SwitchProps extends Omit<ComponentPropsWithRef<"input">, "type" | "className"> {
  /** The setting's name, as a phrase. "Show this person on the public site". */
  label: ReactNode;
  /** One line saying what turning it on actually does. */
  description?: ReactNode;
  /** Convenience over `onChange`. Both fire; `onChange` first. */
  onCheckedChange?: (checked: boolean) => void;
  /** Hide the "On"/"Off" word in a dense row where the label already carries the state. */
  hideStateWord?: boolean;
  /** ⚠ Goes to the outer ROW, not the input — this is a composite control and the row is laid out. */
  className?: string;
}

export function Switch({
  label,
  description,
  onCheckedChange,
  hideStateWord = false,
  className,
  id,
  checked,
  defaultChecked,
  onChange,
  disabled,
  "aria-describedby": ariaDescribedBy,
  ...rest
}: SwitchProps) {
  const field = useFieldContext();
  const uid = useId();
  const inputId = id ?? field?.controlId ?? `${uid}switch`;
  const descriptionId = `${uid}description`;

  // The visible word needs the state, and an uncontrolled input keeps its state in the DOM. Mirror
  // it so both modes work; when `checked` is supplied it always wins, so this shadow copy can never
  // disagree with the prop.
  const [uncontrolled, setUncontrolled] = useState(defaultChecked ?? false);
  const isOn = checked ?? uncontrolled;

  const describedBy =
    [ariaDescribedBy ?? field?.describedBy, description ? descriptionId : null]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" ") || undefined;

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    setUncontrolled(event.target.checked);
    onChange?.(event);
    onCheckedChange?.(event.target.checked);
  };

  return (
    <div>
      <label
        htmlFor={inputId}
        className={cn(
          "flex min-h-11 items-center justify-between gap-3 py-1.5",
          disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
          className
        )}
      >
        <span className="text-sm font-medium text-ink-900">{label}</span>

        <span className="flex shrink-0 items-center gap-2">
          {hideStateWord ? null : (
            // `aria-hidden`, because `aria-checked` already tells assistive technology the state and
            // folding the word into the name makes it read "Featured On, switch, on".
            <span
              aria-hidden="true"
              className={cn("text-xs font-medium", isOn ? "text-purple-700" : "text-ink-500")}
            >
              {isOn ? "On" : "Off"}
            </span>
          )}

          <span className="relative inline-flex h-6 w-11 shrink-0 items-center">
            <input
              id={inputId}
              type="checkbox"
              role="switch"
              className="peer sr-only"
              checked={checked}
              defaultChecked={defaultChecked}
              disabled={disabled}
              onChange={handleChange}
              aria-describedby={describedBy}
              {...rest}
            />

            <span
              aria-hidden="true"
              className="absolute inset-0 rounded-full border border-line-200 bg-surface-200 transition peer-checked:border-purple-700 peer-checked:bg-purple-700 peer-focus-visible:ring-4 peer-focus-visible:ring-purple-600/15"
            />

            {/* A plain CSS transition, so the global reduced-motion rule collapses it to an instant
                jump. The POSITION is the signal and it survives either way. */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5"
            />
          </span>
        </span>
      </label>

      {description ? (
        <p id={descriptionId} className="-mt-0.5 text-xs leading-relaxed text-ink-500">
          {description}
        </p>
      ) : null}
    </div>
  );
}
