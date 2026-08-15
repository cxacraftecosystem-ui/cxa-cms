/**
 * KolamMark — the kolam at rest, as a Server Component.
 *
 * `KolamLattice` is a client component for exactly one reason: the hand-drawn line needs
 * `useReducedMotionPreference()`. A caller that wants the FINISHED figure — the footer, which shows
 * the mark complete on every public page — was paying for a client island whose only hook resolved
 * to a value it never used (`animate={false}` makes it dead on arrival). This is the same figure
 * from the same `kolamFigure` geometry, rendered static and shipped as plain HTML: no directive,
 * no chunk, no hydration, and no reduced-motion question because nothing ever moves.
 *
 * If you need the drawing animation, use `KolamLattice`. If the mark is simply THERE, use this.
 * The SVG structure deliberately mirrors KolamLattice's resting render (dots at 0.55, stroke
 * 0.42, pad 1.6) so the two are indistinguishable at rest and a swap in either direction is
 * invisible.
 */

import { kolamFigure } from "@/components/craft/motifs";
import { cn } from "@/lib/utils";

export interface KolamMarkProps {
  /** Sizing and colour — the SVG uses `currentColor`. Give it a width; the height follows. */
  className?: string;
  /** `pulli` across. Keep coprime with `rows` for a true single-stroke kolam. */
  cols?: number;
  /** `pulli` down. */
  rows?: number;
}

export function KolamMark({ className, cols = 7, rows = 5 }: KolamMarkProps) {
  const figure = kolamFigure(cols, rows);
  const pad = 1.6;

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`${-pad} ${-pad} ${figure.width + pad * 2} ${figure.height + pad * 2}`}
      className={cn("block", className)}
    >
      <g fill="currentColor" opacity={0.55}>
        {figure.dots.map((dot) => (
          <circle key={`${dot.x}-${dot.y}`} cx={dot.x} cy={dot.y} r={0.34} />
        ))}
      </g>
      <path
        d={figure.d}
        stroke="currentColor"
        strokeWidth={0.42}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
