"use client";

/**
 * Select — a NATIVE `<select>` in `.field-input` clothing.
 *
 * ⚠ DO NOT REPLACE THIS WITH A CUSTOM LISTBOX. On a phone the native control opens the platform
 * picker — a wheel or a full-height sheet, thumb-sized, scrollable with momentum, searchable by
 * typing, and already translated. A hand-built listbox on the same screen is a 200px scroller with
 * 32px rows that a screen reader has to be told about through eight ARIA attributes, each of which
 * can be got wrong. The searchable/multi-select case is a separate component and a deliberate
 * trade; a plain closed list is not that case.
 *
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
 */

import type { ComponentPropsWithRef, ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { FIELD_INVALID_CLASS, useFieldContext } from "@/components/ui/Field";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

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
