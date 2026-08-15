/**
 * HelpText — one plain sentence telling an administrator what to put in a field, or what a control
 * will do.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHICH ONE TO REACH FOR. `Field` and `FieldBlock` already take a `help` prop, and THAT is the one
 * to use for a sentence describing a single control: the wrapper generates the id, joins it into
 * `aria-describedby` alongside the counter and the error, and a screen reader then reads the
 * sentence as the control's description. Reaching for `HelpText` there produces a sentence that is
 * on the screen but not in the accessibility tree — visible help that a screen-reader user is never
 * told about.
 *
 * `HelpText` is for the cases a Field cannot cover:
 *   • a sentence belonging to a GROUP of fields (inside a `FormSection`);
 *   • a sentence belonging to a composite control built from `<div>`s, where you pass `id` here and
 *     set `aria-describedby={thatId}` on the widget yourself;
 *   • a standing note about how a screen behaves ("Published items are not saved automatically").
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * IT RENDERS A BLOCK-DISPLAY `<span>`, NOT A `<p>`. A `<label>` takes phrasing content only, so a
 * paragraph inside `Field` would be invalid HTML — and this component is small enough that somebody
 * will eventually put it there. A `<span class="block">` renders identically and is valid in both
 * places, which is what lets one component serve every position (the same reasoning as Field.tsx's
 * parts).
 *
 * NO `"use client"`. Nothing here holds state, so a Server Component can render it directly.
 *
 * THE WORDS ARE THE POINT. One sentence, in plain British English, written for somebody who does not
 * work in software: no "entity", no "payload", no "slug" without explaining it, no exclamation marks.
 * If the help needs two sentences, the second one says what happens if you get it wrong.
 */

import type { ReactNode } from "react";
import { TriangleAlert, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * `warn` is for a consequence the reader should weigh before continuing ("changing this breaks
 * existing links"). `error` is for something that is already wrong. Neither replaces a `Field`'s
 * `error` prop, which is wired to `aria-invalid` on the control itself.
 */
export type HelpTone = "neutral" | "warn" | "error";

/**
 * Complete literal class strings — a name assembled by concatenation is purged (contract §5).
 *
 * `amber-100` + `amber-800` as a PAIR: `amber-50` and `amber-200` are stock Tailwind here and will
 * not pair correctly (contract §1). The status ramps are literal hex and do not invert, which is
 * deliberate — a warning must read the same in both themes.
 */
const TONE_CLASS: Record<HelpTone, string> = {
  neutral: "text-ink-500",
  warn: "rounded-md border border-amber-800/25 bg-amber-100 px-3 py-2 text-amber-800",
  error: "text-error-600"
};

/** Colour never carries meaning alone (contract §11), so the two loud tones bring a glyph. */
const TONE_ICON: Record<HelpTone, LucideIcon | null> = {
  neutral: null,
  warn: TriangleAlert,
  error: TriangleAlert
};

export interface HelpTextProps {
  children: ReactNode;
  /**
   * Pass this when the sentence describes a control that is NOT inside a `Field`, and put the same
   * id in that control's `aria-describedby`. Without the pairing the sentence is decoration.
   */
  id?: string;
  tone?: HelpTone;
  /** Overrides the tone's glyph. Decorative either way — the words carry the meaning. */
  icon?: LucideIcon;
  className?: string;
}

export function HelpText({ children, id, tone = "neutral", icon, className }: HelpTextProps) {
  const Icon = icon ?? TONE_ICON[tone];

  return (
    <span
      id={id}
      className={cn(
        // ONE display utility, chosen here rather than layered. `cn()` is a plain join and later
        // classes do NOT win (contract §5) — `block` and `flex` together would be settled by
        // Tailwind's own output order, which is not a thing to depend on.
        Icon ? "flex items-start gap-1.5" : "block",
        "text-xs leading-relaxed",
        TONE_CLASS[tone],
        className
      )}
    >
      {Icon ? <Icon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : null}
      {/* The wrapper span keeps the text as one flex child, so a two-line sentence indents under
          itself rather than wrapping back under the glyph. */}
      <span className="min-w-0">{children}</span>
    </span>
  );
}
