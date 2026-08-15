"use client";

/**
 * Checkbox — a real `<input type="checkbox">`, restyled, never re-implemented.
 *
 * A `<div role="checkbox">` has to be taught Space, focus, the accessible name, the checked state
 * and the form value; it participates in no `<form>`, appears in no `FormData`, and fires no native
 * input event — which matters here, because a studio form's dirty tracker listens for `onInput` on
 * the form (contract §10) and a fake control is invisible to it. `appearance-none` on the real thing
 * gives us the same pixels with none of that debt.
 *
 * THE WHOLE ROW IS THE TARGET, 44px MINIMUM (`min-h-11`). A 16px box is a coin toss on a phone. The
 * label wraps the input, so a tap anywhere across the row toggles it — that is the one case where a
 * wrapping `<label>` is right, because the input is the only labelable thing inside it.
 *
 * THE DESCRIPTION SITS OUTSIDE THE LABEL, wired with `aria-describedby`. Inside, it would be folded
 * into the accessible name and read out in full every time the box is focused (see Field.tsx).
 *
 * FOCUS KEEPS THE PLATFORM OUTLINE and ADDS the brand ring — a deliberate deviation from
 * `.field-input`, which sets `outline-none`. The high-contrast block in globals.css thickens
 * `input:focus-visible` outlines to 3px, and on a 20px control that outline is the strongest cue
 * available; the ring alone at 15% alpha is not enough to find. The ring colour is NAMED, because a
 * bare `ring-4` is stock BLUE (contract §3).
 */

import { useEffect, useId, useRef, type ChangeEvent, type ComponentPropsWithRef, type ReactNode } from "react";
import { Check, Minus } from "lucide-react";

import { cn } from "@/lib/utils";
import { useFieldContext } from "@/components/ui/Field";

export interface CheckboxProps extends Omit<ComponentPropsWithRef<"input">, "type" | "className"> {
  /** The clickable label. Keep it to a phrase; anything longer belongs in `description`. */
  label: ReactNode;
  /** One line under the row, describing what ticking it does. */
  description?: ReactNode;
  /**
   * The third state, for a "select all" that covers some but not all rows.
   *
   * `indeterminate` is a DOM property, not an attribute — React cannot render it, so it is set from
   * an effect. A checkbox left `checked` while indeterminate shows the dash, which is why the glyph
   * is chosen in JS rather than by racing two `peer-*` variants of equal specificity.
   */
  indeterminate?: boolean;
  /** Convenience over `onChange`. Both fire; `onChange` first. */
  onCheckedChange?: (checked: boolean) => void;
  /** ⚠ Goes to the outer ROW, not the input — this is a composite control and the row is laid out. */
  className?: string;
  /** For the box itself, on the rare occasion the row class is not the one you meant. */
  inputClassName?: string;
}

export function Checkbox({
  label,
  description,
  indeterminate = false,
  onCheckedChange,
  className,
  inputClassName,
  id,
  ref,
  onChange,
  disabled,
  "aria-describedby": ariaDescribedBy,
  ...rest
}: CheckboxProps) {
  const field = useFieldContext();
  const uid = useId();
  const inputId = id ?? field?.controlId ?? `${uid}checkbox`;
  const descriptionId = `${uid}description`;

  const innerRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const node = innerRef.current;
    if (node) node.indeterminate = indeterminate;
  }, [indeterminate]);

  // We need our own handle for the indeterminate property AND must not swallow a forwarded ref.
  const attachRef = (node: HTMLInputElement | null) => {
    innerRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };

  const describedBy =
    [ariaDescribedBy ?? field?.describedBy, description ? descriptionId : null]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" ") || undefined;

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange?.(event);
    onCheckedChange?.(event.target.checked);
  };

  return (
    <div>
      <label
        htmlFor={inputId}
        className={cn(
          "flex min-h-11 items-center gap-3 py-1.5",
          disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
          className
        )}
      >
        <span className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center">
          <input
            id={inputId}
            ref={attachRef}
            type="checkbox"
            disabled={disabled}
            onChange={handleChange}
            aria-describedby={describedBy}
            className={cn(
              "peer h-5 w-5 shrink-0 appearance-none rounded-sm border border-line-200 bg-card transition",
              "checked:border-purple-700 checked:bg-purple-700",
              "indeterminate:border-purple-700 indeterminate:bg-purple-700",
              "focus-visible:border-purple-600 focus-visible:ring-4 focus-visible:ring-purple-600/15",
              "disabled:cursor-not-allowed disabled:border-line-200 disabled:bg-surface-200",
              disabled ? undefined : "cursor-pointer",
              inputClassName
            )}
            {...rest}
          />

          {/* The glyph is the non-colour half of the signal: a filled purple box and an empty one
              differ by more than hue for anyone who cannot tell the two apart. */}
          {indeterminate ? (
            <Minus aria-hidden="true" className="pointer-events-none absolute h-3.5 w-3.5 text-white" />
          ) : (
            <Check
              aria-hidden="true"
              className="pointer-events-none absolute h-3.5 w-3.5 text-white opacity-0 transition-opacity peer-checked:opacity-100"
            />
          )}
        </span>

        <span className="text-sm text-ink-900">{label}</span>
      </label>

      {description ? (
        // Indented to the label text: 20px box + 12px gap.
        <p id={descriptionId} className="ml-8 -mt-0.5 text-xs leading-relaxed text-ink-500">
          {description}
        </p>
      ) : null}
    </div>
  );
}
