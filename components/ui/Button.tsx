/**
 * Button and LinkButton — the action primitives, composing the `.field-button*` recipes.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * TWO EXPORTS, BECAUSE THERE ARE TWO THINGS. A `<button>` does something; an `<a>` goes somewhere.
 * Swapping them is common and both directions are wrong: a `<button onClick={() => router.push()}>`
 * cannot be middle-clicked, opened in a new tab, copied as a link or read as a link by a screen
 * reader; an `<a>` wired to submit a form does nothing without JavaScript and lies to everyone about
 * what pressing it will do. If it navigates, it is a `LinkButton`.
 *
 * NOTE THERE IS NO `disabled` ON LinkButton. HTML has no such thing for an anchor, and the polite
 * fakes (`aria-disabled`, `pointer-events-none`) leave a control that still looks pressable. A
 * failing permission check renders NOTHING (contract §1.8); an unavailable action is an absent
 * action or a real `<button disabled>` with a reason beside it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * NO `"use client"`. Nothing here holds state, so a Server Component can render a LinkButton
 * straight into a public page; a client parent passing `onClick` pulls it into the client bundle by
 * the ordinary rules.
 *
 * `isLoading` DISABLES AND ANNOUNCES. A spinner is a picture of waiting, and a screen-reader user is
 * told nothing by it. Worse: disabling a focused button makes several browsers drop focus to
 * `<body>`, so the reader is not even standing on the control any more. The label therefore sits in
 * a polite live region that is mounted in BOTH states — a region inserted at the same instant as its
 * text is announced inconsistently — and gains a spoken suffix when the wait starts. `aria-busy`
 * carries the same fact to anything reading the tree directly.
 *
 * The spinner's spin is collapsed by the global reduced-motion rule, as it should be. The state is
 * still legible without it: the fill drops to the disabled treatment and the live text has already
 * been read (contract §1.4 — never let motion be the only signal).
 */

import Link from "next/link";
import { LoaderCircle, type LucideIcon } from "lucide-react";
import type { ComponentPropsWithRef, ReactNode } from "react";

import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

/** Complete literal class strings — a name built by concatenation is purged (contract §5). */
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "field-button",
  secondary: "field-button-secondary",
  ghost: "field-button-ghost",
  danger: "field-danger"
};

/**
 * `md` adds nothing: the recipes already are the medium size. `sm` overrides them with utilities,
 * which beat a `@layer components` recipe regardless of the order they appear in the class string
 * — that is the one place `cn()`'s plain join is not a hazard (contract §5).
 *
 * `sm` is 32px tall, below the 44px touch minimum, and is for DENSE STUDIO CHROME ONLY — a table
 * row's action, a toolbar. Never on the public site, never as the primary action on a phone.
 */
const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: "min-h-8 gap-1.5 px-3 py-1.5 text-xs",
  md: ""
};

export interface ButtonAppearance {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** A leading (or trailing) glyph. Decorative — the label is what names the button. */
  icon?: LucideIcon;
  iconPosition?: "start" | "end";
  /** Stretch to the container. A `w-full` utility would do the same; this is just the readable name. */
  fullWidth?: boolean;
}

/**
 * The class string, exported for the rare control that must look like a button but cannot be one —
 * a `<summary>`, a drop-zone trigger. If you are reaching for it to style an `<a>`, use LinkButton.
 */
export function buttonClasses({
  variant = "primary",
  size = "md",
  fullWidth = false
}: ButtonAppearance = {}): string {
  return cn(VARIANT_CLASS[variant], SIZE_CLASS[size], fullWidth && "w-full");
}

export interface ButtonProps extends ComponentPropsWithRef<"button">, ButtonAppearance {
  /** Disables the button, swaps the icon for a spinner and announces the wait. */
  isLoading?: boolean;
  /**
   * What the wait is called, appended to the label for screen readers only: "Save changes — saving".
   * Say the verb, not "please wait".
   */
  loadingLabel?: string;
  children?: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  icon: Icon,
  iconPosition = "start",
  fullWidth = false,
  isLoading = false,
  loadingLabel = "working",
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  // `type` defaults to "button", never "submit": a bare <button> inside a form submits it, and the
  // Cancel that quietly saved the record is a bug nobody finds by reading the JSX.
  const glyphClass = size === "sm" ? "h-3.5 w-3.5 shrink-0" : "h-4 w-4 shrink-0";

  return (
    <button
      type={type}
      disabled={disabled || isLoading}
      aria-busy={isLoading || undefined}
      className={cn(buttonClasses({ variant, size, fullWidth }), className)}
      {...rest}
    >
      {isLoading ? (
        // The spinner leads even when the icon was trailing: a wait belongs where the eye starts.
        <LoaderCircle aria-hidden="true" className={cn(glyphClass, "animate-spin")} />
      ) : Icon && iconPosition === "start" ? (
        <Icon aria-hidden="true" className={glyphClass} />
      ) : null}

      {/* Mounted in both states so the region is registered before its content ever changes. */}
      <span aria-live="polite">
        {children}
        {isLoading ? <span className="sr-only"> — {loadingLabel}</span> : null}
      </span>

      {!isLoading && Icon && iconPosition === "end" ? (
        <Icon aria-hidden="true" className={glyphClass} />
      ) : null}
    </button>
  );
}

export interface LinkButtonProps
  extends Omit<ComponentPropsWithRef<"a">, "href">,
    ButtonAppearance {
  href: string;
  /**
   * Opens in a new tab, with the `rel` pair and a spoken "(opens in a new tab)".
   *
   * Announcing it is not politeness: a reader whose focus lands in a new tab with no warning has
   * lost their place in the document and their Back button with it.
   */
  newTab?: boolean;
  children?: ReactNode;
}

/** `/path`, `#anchor` and `?query` are ours; anything else is another origin, a mailto or a tel. */
function isInternalHref(href: string): boolean {
  return href.startsWith("/") || href.startsWith("#") || href.startsWith("?");
}

export function LinkButton({
  href,
  variant = "primary",
  size = "md",
  icon: Icon,
  iconPosition = "start",
  fullWidth = false,
  newTab = false,
  className,
  children,
  ...rest
}: LinkButtonProps) {
  const glyphClass = size === "sm" ? "h-3.5 w-3.5 shrink-0" : "h-4 w-4 shrink-0";
  const classes = cn(buttonClasses({ variant, size, fullWidth }), className);

  const body = (
    <>
      {Icon && iconPosition === "start" ? <Icon aria-hidden="true" className={glyphClass} /> : null}
      <span>{children}</span>
      {Icon && iconPosition === "end" ? <Icon aria-hidden="true" className={glyphClass} /> : null}
      {newTab ? <span className="sr-only"> (opens in a new tab)</span> : null}
    </>
  );

  const targetProps = newTab ? ({ target: "_blank", rel: "noopener noreferrer" } as const) : {};

  // `next/link` only for internal destinations. On an absolute URL it adds nothing but its prefetch
  // machinery, and routing a `mailto:` through the client router is a surprise nobody wants.
  if (isInternalHref(href)) {
    return (
      <Link href={href} className={classes} {...targetProps} {...rest}>
        {body}
      </Link>
    );
  }

  return (
    <a href={href} className={classes} {...targetProps} {...rest}>
      {body}
    </a>
  );
}
