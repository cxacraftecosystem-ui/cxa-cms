/**
 * ProjectProgress — how far along a project is, or nothing at all.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `progress === 0` RENDERS NOTHING, AND THAT IS THE WHOLE REASON THIS COMPONENT EXISTS.
 *
 * `Project.progress` defaults to 0 and most projects never have it filled in, so a bar on every
 * project would report "0%" about work that is simply not tracked that way. "Not started" and "not
 * tracked" are different claims, a reader cannot tell them apart from an empty bar, and only one of
 * them is true — so the honest rendering of an untracked project is no bar. Absence of a bar means
 * the Centre does not publish a figure; a bar means it does.
 *
 * ⚠ IT CLAMPS ON THE WAY IN. The schema clamps on write, but a restored revision, a hand-edited row
 * or an import can still carry 140 or -3, and a bar that reads 140% is worse than no bar: it makes
 * every other number on the page suspect. A non-finite value (a `NaN` arriving from arithmetic
 * somewhere upstream) clamps to 0 and therefore renders nothing, which is the safe direction.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * IT COMPOSES `ProgressBar` RATHER THAN DRAWING A BAR. That component already owns the ARIA, the
 * track, the reduced-motion story and the numeric readout; what it does not own — and must not, since
 * an upload at 0% is a perfectly real thing to show — is the "0 means untracked" rule above. That rule
 * belongs to this record type, so it lives here.
 *
 * THE PROJECT'S TITLE IS PART OF THE BAR'S ACCESSIBLE NAME. A listing of eight projects would
 * otherwise announce eight controls all called "Progress", and a screen-reader user moving through
 * them by control would have no way to tell which project each one belongs to.
 *
 * A Server Component: no state, no handlers, no hooks. It renders inside a card on a listing page and
 * inside the fact panel on a project page without either of them shipping JavaScript for it.
 */

import { ProgressBar, type ProgressBarSize } from "@/components/ui/ProgressBar";
import { clamp } from "@/lib/utils";

export interface ProjectProgressProps {
  /** `Project.progress`. Clamped to 0–100 here; 0 (or anything below it) renders nothing. */
  progress: number;
  /** The project's title. It goes into the bar's accessible name — see the header. */
  projectTitle: string;
  /** `sm` for a card footer, `md` (the default) for a fact panel. */
  size?: ProgressBarSize;
  /**
   * A second line under the bar — "as reported in the March 2026 review". Worth passing wherever the
   * figure has a date attached, because a percentage with no date is a claim about now.
   */
  hint?: string;
  /** Hide the "42%" readout where the surrounding copy already states it. */
  showValue?: boolean;
  className?: string;
}

export function ProjectProgress({
  progress,
  projectTitle,
  size = "md",
  hint,
  showValue = true,
  className
}: ProjectProgressProps) {
  // Rounded after clamping, so 99.6 reads as 100 rather than as a fraction nobody published.
  const value = Math.round(clamp(progress, 0, 100));

  // The one rule this component owns. See the header before "simplifying" it to `value >= 0`.
  if (value <= 0) return null;

  return (
    <ProgressBar
      value={value}
      label={`Progress — ${projectTitle}`}
      size={size}
      hint={hint}
      showValue={showValue}
      className={className}
    />
  );
}
