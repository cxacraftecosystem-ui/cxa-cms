/**
 * ProgressBar — determinate and indeterminate.
 *
 * THE INDETERMINATE VARIANT IS A CSS ANIMATION, not framer-motion, for one reason: CSS is the half of
 * the reduced-motion contract that works without a JS branch (contract §3), and a progress bar is
 * exactly the sort of ambient chrome that gets copied into a Server Component where hooks are not
 * available. It reuses the shared `sweep` keyframe rather than inventing a second sweeping animation
 * — one vocabulary, shared with `.skeleton`, and neither caller owns it.
 *
 * ⚠ AND IT KEEPS A STATIC BAR UNDERNEATH. Under `prefers-reduced-motion` the global rule in
 * globals.css collapses every animation to 0.01ms and one iteration, so the sweep simply parks. A bar
 * whose only substance was the moving highlight would then be an empty grey track — a signal that
 * exists solely as motion is a signal those readers never get (contract §1.4). The static
 * purple-tinted fill is what remains, and the wording beside it ("Working…") says the same thing again.
 *
 * ⚠ THE DETERMINATE FILL TRAVELS ON `transform`, NOT ON `width`. An animated width relays out the
 * track — and, through it, whatever the bar is sitting inside — on every one of the ~13 frames the
 * transition lasts, which is the one thing contract §8 forbids outright. The fill is therefore full
 * width and translated into place. ⚠ Do not "simplify" it back to `width: ${percent}%`: it looks
 * identical and costs a layout per frame, on a component that is often on screen beside an upload
 * doing real work.
 *
 * ⚠ THE INDETERMINATE SWEEP IS NOW FREE, AND THE NOTE THAT USED TO SIT HERE SAID IT WAS NOT. It moved
 * `background-position` — a property no browser composites — on an `infinite` animation, so the bar
 * repainted on the main thread for as long as it was mounted, which is precisely the span during
 * which the main thread is doing the work the bar is reporting on. The keyframe is now `sweep`, a
 * translated child inside the track's own `overflow-hidden` frame: one compositor layer, no repaint.
 * `.skeleton` moved to the identical keyframe in the same change, so there is still exactly one
 * sweeping vocabulary — see the long note above `.skeleton` in app/globals.css.
 *
 * ⚠ AND THE `-translate-x-full` ON THE MOVING SPAN IS NOT A STARTING VALUE — IT IS WHERE THE HIGHLIGHT
 * HAS TO COME TO REST. A CSS animation with no `forwards` fill snaps back to the element's base style
 * when it stops, and the reduced-motion rules in globals.css stop every animation after 0.01ms with a
 * single iteration. Without that class the base transform is `none`, so the purple band would settle
 * dead centre in the track and STAY there — which on an indeterminate bar does not read as "stopped",
 * it reads as "half done", on the one control whose entire meaning is that the total is unknown.
 * Delete the class and the bar starts lying to every reader who asked for less motion.
 *
 * ⚠ AN INDETERMINATE BAR OMITS `aria-valuenow` ENTIRELY. That omission is precisely how ARIA spells
 * "the amount of progress is unknown"; sending 0 instead is a claim we cannot support — it says the
 * work has not started.
 *
 * No `"use client"` — no hooks, no handlers, so it renders in either tree.
 */

import { clamp, cn } from "@/lib/utils";

/** Complete literal class strings; a `h-${size}` built from a prop would be purged (contract §5). */
const TRACK_HEIGHTS = {
  sm: "h-1.5",
  md: "h-2.5"
} as const;

export type ProgressBarSize = keyof typeof TRACK_HEIGHTS;

export interface ProgressBarProps {
  /**
   * Percent complete, 0–100. `null` or omitted gives the indeterminate variant — pass it when the
   * total genuinely is not known, never as a stand-in for "not started".
   */
  value?: number | null;
  /** What is progressing, as a phrase: "Uploading 4 files". It is the bar's accessible name. */
  label: string;
  /** A second line of detail — "12.4 MB of 40 MB", "2 of 4 done". Optional and never load-bearing. */
  hint?: string;
  /** Hide the numeric readout where the surrounding UI already states it. */
  showValue?: boolean;
  size?: ProgressBarSize;
  className?: string;
}

export function ProgressBar({
  value,
  label,
  hint,
  showValue = true,
  size = "md",
  className
}: ProgressBarProps) {
  // Narrowed through a value rather than a boolean flag, so `percent` needs no assertion and a NaN
  // (which arrives easily from `loaded / total` when total is 0) falls into the indeterminate branch
  // rather than rendering "NaN%".
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : null;
  const determinate = numeric !== null;
  const percent = numeric === null ? 0 : Math.round(clamp(numeric, 0, 100));
  const trackHeight = TRACK_HEIGHTS[size];

  return (
    <div className={cn("w-full", className)}>
      <div className="flex items-baseline justify-between gap-3">
        {/*
          Hidden from assistive technology because the identical string is the progressbar's
          `aria-label` below; announcing it twice is noise, and dropping the visible copy would leave
          a bar with no on-screen explanation.
        */}
        <p aria-hidden="true" className="text-sm font-medium text-ink-700">
          {label}
        </p>
        {showValue ? (
          <p aria-hidden="true" className="text-sm tabular-nums text-ink-500">
            {determinate ? `${percent}%` : "Working…"}
          </p>
        ) : null}
      </div>

      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(determinate ? { "aria-valuenow": percent } : {})}
        className={cn(
          "relative mt-2 w-full overflow-hidden rounded-full bg-surface-200",
          trackHeight
        )}
      >
        {determinate ? (
          // The fill is FULL WIDTH AND SLID INTO VIEW, not grown. See the header for why width is the
          // wrong property; `translateX` is a percentage of the element's own width, so -100% parks it
          // entirely off the left of the track and 0% fills it. The track's `overflow-hidden` clips the
          // part that hangs off, and the fill's right cap stays a true circle — which a `scaleX` of the
          // same journey would have squashed into an ellipse.
          //
          // Inline style, not a utility: `translate-x-[${percent}%]` would be assembled at runtime and
          // purged (contract §5). 220ms is `DURATION.page`, the contract's figure for this bar.
          <div
            style={{ transform: `translateX(${percent - 100}%)` }}
            className="h-full w-full rounded-full bg-purple-700 transition-transform duration-[220ms] ease-out"
          />
        ) : (
          <>
            {/* The static half of the signal — what a reduced-motion reader sees. */}
            <span aria-hidden="true" className="absolute inset-0 rounded-full bg-purple-200" />
            {/*
              The moving half, and it is a TRANSLATED CHILD rather than a moving background: a band
              exactly as wide as the track, parked off its left edge, swept across it and off the
              right by the shared `sweep` keyframe. The track above is already `overflow-hidden`,
              which is what clips the two ends — no second frame is needed.

              ⚠ `-translate-x-full` is the RESTING position and removing it breaks the reduced-motion
              case in a way that looks like a wrong value rather than a missing class. See the header.
              No `rounded-full` here either: the band is clipped by the track's own radius, and a
              rounded band inside a rounded track puts a visible notch at each end of the sweep.
            */}
            <span
              aria-hidden="true"
              className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-purple-600 to-transparent animate-sweep"
            />
          </>
        )}
      </div>

      {hint ? <p className="mt-1.5 text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}
