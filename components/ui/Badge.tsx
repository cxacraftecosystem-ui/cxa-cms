/**
 * Badge — a small labelled chip.
 *
 * EVERY TONE CAN CARRY AN ICON, AND THE WORD IS ALWAYS THE CHILD. Colour never carries meaning alone
 * (contract §11): a reader who cannot separate the greens from the ambers, or who is looking at a
 * printout, must still be able to read the badge. The `icon` prop is optional here because a badge
 * is often a plain category label ("Journal article") where there is no state to signal — but the
 * moment a badge means a STATE, give it a glyph. StatusBadge does exactly that and is the component
 * to use for `ContentStatus`.
 *
 * THE TONE RAMPS ARE LITERAL HEX AND DO NOT INVERT — that is deliberate (contract §3). Each chip is
 * a light fill with dark ink, which reads the same in both themes rather than dissolving into a dark
 * canvas. The `neutral` tone is the exception: it uses the themed `surface`/`ink` ladders, because a
 * badge with no state should sit in whatever the page is made of.
 */

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Matches the tone vocabulary in lib/content.ts and Toast.tsx, plus `error` and `brand`. */
export type BadgeTone = "neutral" | "info" | "success" | "warn" | "error" | "brand";
export type BadgeSize = "sm" | "md";

/** Complete literal class strings — a name assembled by concatenation is purged (contract §5). */
const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: "border-line-200 bg-surface-100 text-ink-700",
  info: "border-purple-200 bg-purple-100 text-purple-700",
  success: "border-success-600/25 bg-success-100 text-success-600",
  // amber-100 + amber-800 as a PAIR. amber-50 and amber-200 are stock Tailwind here and will not
  // pair correctly (contract §1).
  warn: "border-amber-800/25 bg-amber-100 text-amber-800",
  error: "border-error-200 bg-error-100 text-error-600",
  brand: "border-purple-700 bg-purple-700 text-white"
};

const SIZE_CLASS: Record<BadgeSize, string> = {
  sm: "gap-1 px-2 py-0.5 text-[0.6875rem]",
  md: "gap-1.5 px-2.5 py-1 text-xs"
};

const GLYPH_CLASS: Record<BadgeSize, string> = {
  sm: "h-3 w-3 shrink-0",
  md: "h-3.5 w-3.5 shrink-0"
};

export interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  size?: BadgeSize;
  /** Decorative: the child text is what a reader is told, so the glyph is `aria-hidden`. */
  icon?: LucideIcon;
  className?: string;
  /** Rare — a badge that must be announced as a term rather than as running text. */
  title?: string;
}

export function Badge({
  children,
  tone = "neutral",
  size = "md",
  icon: Icon,
  className,
  title
}: BadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center rounded-full border font-medium leading-none",
        TONE_CLASS[tone],
        SIZE_CLASS[size],
        className
      )}
    >
      {Icon ? <Icon aria-hidden="true" className={GLYPH_CLASS[size]} /> : null}
      <span>{children}</span>
    </span>
  );
}
