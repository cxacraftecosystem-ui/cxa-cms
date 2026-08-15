"use client";

/**
 * Input — a text input composing the `.field-input` recipe.
 *
 * It restates none of that recipe's utilities. `.field-input` already owns the border, the fill, the
 * padding, the placeholder colour and the focus ring (named `ring-purple-600/15`, because a bare
 * `ring-4` is stock BLUE); everything here is either an override for a state the recipe does not
 * know about or a slot for an adornment.
 *
 * IT READS `FieldContext`. Inside a `<Field>` it inherits the id, `aria-describedby`, `aria-invalid`,
 * `aria-required` and `maxLength` without the call site repeating them — the four attributes that
 * get wired on the first three fields of a form and forgotten on the fourth. An explicit prop always
 * wins, and outside a Field the component is an ordinary `<input>`.
 *
 * `className` GOES TO THE INPUT. This is an atomic control; the wrapper exists only to position the
 * adornments. (Composite controls in this folder — Checkbox, Switch, SearchInput — send `className`
 * to their outer row instead, because that is the element a caller lays out.)
 *
 * NATIVE `required` IS NOT SET FROM CONTEXT, only `aria-required`. The native attribute hands
 * validation to the browser's own bubble, which cannot be styled, cannot be translated and appears
 * in a different place from our inline errors. Validation is Zod's (contract §9); pass `required`
 * explicitly if you genuinely want the browser's.
 */

import type { ComponentPropsWithRef, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { FIELD_INVALID_CLASS, useFieldContext } from "@/components/ui/Field";

export interface InputProps extends ComponentPropsWithRef<"input"> {
  /**
   * A leading glyph — a search, a link, a currency mark. Decorative, so it is `aria-hidden`.
   *
   * ⚠ A COMPONENT **TYPE**, and that is a deliberate constraint with a consequence a caller has to
   * know about. This file is `"use client"` (it reads `FieldContext`), so a SERVER component cannot
   * pass `icon={Search}`: a component reference is a function, functions are not serialisable across
   * the server/client boundary, and React fails the render with "Functions cannot be passed directly
   * to Client Components". That shipped once, as a 500 on two studio screens.
   *
   * From a Server Component use `iconNode={<Search className="h-4 w-4" />}` instead — an already
   * created ELEMENT serialises perfectly well. From a Client Component either form works, and `icon`
   * is the tidier one.
   */
  icon?: LucideIcon;
  /**
   * The same glyph, pre-rendered. The form a SERVER component must use — see `icon` above.
   *
   * When both are given `icon` wins, because a caller that passed a component type meant it and the
   * two would otherwise stack into two glyphs in one slot.
   */
  iconNode?: ReactNode;
  /**
   * Static trailing text: a unit, a domain suffix, "px".
   *
   * ⚠ NEVER a button. A button here would sit inside the `<Field>` label and both label traps fire
   * at once — use `FieldBlock` and put the button beside the input instead.
   *
   * It is NOT `aria-hidden`, but neither is it announced with the input: content beside a control is
   * not part of its name or description. If the suffix carries meaning ("kg", "per year"), say it in
   * the field's `help` as well.
   */
  suffix?: ReactNode;
  /** Forces the error treatment. Normally inherited from the Field's `error`. */
  invalid?: boolean;
}

export function Input({
  icon: Icon,
  iconNode,
  suffix,
  invalid,
  className,
  id,
  maxLength,
  required,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  ...rest
}: InputProps) {
  const field = useFieldContext();
  const isInvalid = invalid ?? field?.invalid ?? false;

  return (
    <span className="relative block">
      {Icon ? (
        <Icon
          aria-hidden="true"
          className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-300"
        />
      ) : iconNode ? (
        // A pre-rendered element, so the positioning lives here rather than in every server caller.
        // `aria-hidden` on the wrapper covers whatever was handed in, and `[&>svg]` sizes it without
        // requiring the caller to remember the two utility classes.
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-300 [&>svg]:h-4 [&>svg]:w-4"
        >
          {iconNode}
        </span>
      ) : null}

      <input
        id={id ?? field?.controlId}
        maxLength={maxLength ?? field?.maxLength}
        required={required}
        aria-describedby={ariaDescribedBy ?? field?.describedBy}
        aria-invalid={ariaInvalid ?? (isInvalid ? true : undefined)}
        // Redundant when the caller asked for the native attribute — that already exposes required.
        aria-required={!required && field?.required ? true : undefined}
        className={cn(
          "field-input",
          // Either form of the glyph, because both are drawn in the same place. `.field-input` pays
          // 14px of left padding and the icon spans 14–30px, so a branch that forgot one of them put
          // the placeholder underneath the icon — which is exactly what the server-side `iconNode`
          // path did on the audit and redirects search boxes.
          Icon || iconNode ? "pl-10" : undefined,
          suffix ? "pr-14" : undefined,
          isInvalid ? FIELD_INVALID_CLASS : undefined,
          className
        )}
        {...rest}
      />

      {suffix ? (
        <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-sm text-ink-500">
          {suffix}
        </span>
      ) : null}
    </span>
  );
}
