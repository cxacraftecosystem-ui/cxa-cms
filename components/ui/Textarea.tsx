"use client";

/**
 * Textarea — the multi-line twin of Input, on the same `.field-input` recipe.
 *
 * `resize-y` and not `resize` or `resize-none`: horizontal resizing breaks the layout of every form
 * it sits in, and forbidding resize altogether takes away the one affordance that makes a long
 * abstract bearable to write in a 6-line box.
 *
 * A minimum height rather than `rows` alone, because `rows` is measured in the font's line height at
 * the moment of layout and the "Larger text" preference scales the root font size — a 4-row box that
 * was comfortable at 16px is a different shape at 18px. `rows` is still set, as the pre-CSS
 * fallback and for anyone printing the page.
 *
 * See Input.tsx for the FieldContext wiring, the `className` destination and why native `required`
 * is not inherited. Everything there holds here.
 */

import type { ComponentPropsWithRef } from "react";

import { cn } from "@/lib/utils";
import { FIELD_INVALID_CLASS, useFieldContext } from "@/components/ui/Field";

export interface TextareaProps extends ComponentPropsWithRef<"textarea"> {
  /** Forces the error treatment. Normally inherited from the Field's `error`. */
  invalid?: boolean;
}

export function Textarea({
  invalid,
  className,
  id,
  rows = 4,
  maxLength,
  required,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  ...rest
}: TextareaProps) {
  const field = useFieldContext();
  const isInvalid = invalid ?? field?.invalid ?? false;

  return (
    <textarea
      id={id ?? field?.controlId}
      rows={rows}
      maxLength={maxLength ?? field?.maxLength}
      required={required}
      aria-describedby={ariaDescribedBy ?? field?.describedBy}
      aria-invalid={ariaInvalid ?? (isInvalid ? true : undefined)}
      aria-required={!required && field?.required ? true : undefined}
      className={cn(
        "field-input min-h-[7rem] resize-y leading-relaxed",
        isInvalid ? FIELD_INVALID_CLASS : undefined,
        className
      )}
      {...rest}
    />
  );
}
