"use client";

/**
 * BeforeAfterSlider — the restoration comparison, driven by `CraftMedia.restorationPhase`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT IS A `role="slider"`, NOT A DRAG HANDLE.
 *
 * A comparison that only responds to a dragged pointer is unusable with a keyboard, unusable with
 * voice control and unreadable to a screen reader, which is a poor way to present conservation work.
 * So the handle is a real focusable control with `aria-valuenow`, `aria-valuetext`, arrow keys, Page
 * Up/Down for a bigger step and Home/End for the two extremes. Dragging is the fast path; the
 * keyboard is the guaranteed one.
 *
 * BOTH LABELS ARE ALWAYS VISIBLE, as words. A hover-revealed label does not exist on a touch screen
 * and does not exist for a reader who cannot see the pointer; and without them the two halves of the
 * picture are just a picture with a line through it. Colour and position never carry the meaning
 * alone (contract §11).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `touch-action: pan-y` on the frame, not `none`. The browser keeps vertical panning, so a reader
 * scrolling the page with their thumb over the picture still scrolls the page; only horizontal
 * gestures reach us, which is the only axis this control uses.
 *
 * THE REVEAL IS A `clip-path`, NOT A WIDTH. Narrowing an overlay's width squashes the picture inside
 * it; clipping leaves both images at their full size and simply hides part of one, which is what a
 * physical comparison does.
 *
 * ⚠ AND THE SEAM IS A `transform`, NOT A `left`. The seam and the handle ride ONE full-width carriage
 * that is placed with `translate3d(<position>%, 0, 0)` — a percentage on a transform resolves against
 * the carriage's own width, which is the frame's, so it lands exactly where `left: <position>%` would.
 * Both were `left` with a `transition-[left]`, which forces the browser to lay the frame out again on
 * every frame of every keyboard step, and did it twice over because the two elements each carried
 * their own copy. One carriage also means the 2px line and the 44px handle CANNOT drift apart, which
 * two independent transitions of the same duration only look like they guarantee.
 *
 * NO FRAMER HERE, DELIBERATELY. The only animations are two CSS transitions — the clip and the
 * carriage — and both are applied only when the pointer is not down (a transition during a drag makes
 * the seam lag the finger). Because they are CSS, the global reduced-motion rules in globals.css
 * collapse them for both preference sources at once and no JS branch is needed (contract §1.3).
 *
 * No `will-change` on the carriage: a 2px line and one small disc are trivial to composite, and a
 * permanent promotion for something that moves for 200ms after an arrow press is the memory cost the
 * contract's `will-change` rule exists to refuse.
 */

import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import { MediaImage } from "@/components/ui/MediaImage";
import type { LightboxItem } from "@/components/site/MediaLightbox";
import { clamp, cn } from "@/lib/utils";

/** Percentage moved by one arrow press, and by one Page Up/Down. */
const STEP = 2;
const PAGE_STEP = 10;

export interface BeforeAfterSliderProps {
  /** The state before the work. */
  before: LightboxItem;
  /** The state after it. Its proportions set the frame's, so the seam lines up across both. */
  after: LightboxItem;
  beforeLabel?: string;
  afterLabel?: string;
  /** A sentence under the frame — what was done, when, by whom. */
  caption?: ReactNode;
  /** Where the seam starts, 0–100. 50 shows half of each. */
  initialPosition?: number;
  /** `sizes` for both images. Pass the real column width; the default assumes a full-width block. */
  sizes?: string;
  className?: string;
}

export function BeforeAfterSlider({
  before,
  after,
  beforeLabel = "Before",
  afterLabel = "After",
  caption,
  initialPosition = 50,
  sizes = "(min-width: 1024px) 60vw, 100vw",
  className
}: BeforeAfterSliderProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState(() => clamp(initialPosition, 0, 100));
  const [dragging, setDragging] = useState(false);

  // The "after" picture is the base layer, so its proportions decide the frame's. A pair whose two
  // halves were cropped differently would otherwise show a seam that moves as well as reveals.
  const ratio =
    after.width && after.height && after.width > 0 && after.height > 0
      ? after.width / after.height
      : 3 / 2;

  const positionFromClientX = useCallback((clientX: number) => {
    const frame = frameRef.current;
    if (!frame) return null;
    const rect = frame.getBoundingClientRect();
    if (rect.width === 0) return null;
    return clamp(((clientX - rect.left) / rect.width) * 100, 0, 100);
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // Only the primary button drags; a right-click should open the context menu on the photograph.
    if (event.button !== 0) return;
    const next = positionFromClientX(event.clientX);
    if (next === null) return;

    // Captured on the FRAME so a drag that leaves the picture — which is most drags, because the
    // interesting positions are at the two edges — keeps tracking instead of stopping at the border.
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    setPosition(next);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const next = positionFromClientX(event.clientX);
    if (next !== null) setPosition(next);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    // Up/Down as well as Left/Right: the WAI-ARIA slider pattern maps both pairs, and readers who
    // arrive on this control from a vertical list reach for the vertical keys first.
    const deltas: Record<string, number> = {
      ArrowLeft: -STEP,
      ArrowDown: -STEP,
      ArrowRight: STEP,
      ArrowUp: STEP,
      PageDown: -PAGE_STEP,
      PageUp: PAGE_STEP
    };

    if (event.key === "Home") {
      event.preventDefault();
      setPosition(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setPosition(100);
      return;
    }

    const delta = deltas[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    setPosition((current) => clamp(current + delta, 0, 100));
  };

  const rounded = Math.round(position);

  return (
    <figure className={cn("min-w-0", className)}>
      <div
        ref={frameRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{ aspectRatio: ratio, touchAction: "pan-y" }}
        // `[&_img]:*` stops the browser's native image drag, which would otherwise start a ghost
        // drag of the photograph the moment the reader tries to move the seam.
        className="relative select-none overflow-hidden rounded-lg border border-line-200 bg-surface-100 [&_img]:pointer-events-none [&_img]:select-none"
      >
        {/* The base layer: the state AFTER the work. */}
        <div className="absolute inset-0">
          <MediaImage
            media={after}
            alt={after.alt ?? undefined}
            aspect="none"
            rounded="none"
            sizes={sizes}
            className="h-full w-full"
          />
        </div>

        {/* The overlay: the state BEFORE, clipped from the right so the seam reveals it. */}
        <div
          style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
          className={cn(
            "absolute inset-0",
            dragging ? undefined : "transition-[clip-path] duration-200 ease-out"
          )}
        >
          <MediaImage
            media={before}
            alt={before.alt ?? undefined}
            aspect="none"
            rounded="none"
            sizes={sizes}
            className="h-full w-full"
          />
        </div>

        {/*
          THE CARRIAGE. Full width, so a percentage transform on it measures the frame; transparent to
          the pointer, so the whole picture stays draggable underneath it. See the file header for why
          this is a transform and not a `left`.
        */}
        <div
          style={{ transform: `translate3d(${position}%, 0, 0)` }}
          className={cn(
            "pointer-events-none absolute inset-y-0 left-0 w-full",
            dragging ? undefined : "transition-transform duration-200 ease-out"
          )}
        >
          {/* The seam. Decorative — the handle below carries the value. */}
          <div
            aria-hidden="true"
            className="absolute inset-y-0 left-0 w-0.5 -translate-x-1/2 bg-white/90"
          />

          {/*
            THE CONTROL. A real `<button>` carrying `role="slider"`, not a bare `<div>`: the role is
            what assistive technology reads, but the element is what gives free focusability, a working
            `disabled` story if one is ever needed, and a target voice control can say "click" at
            (contract §11). Space and Enter fire a click that nothing listens for, which is harmless.

            `pointer-events-auto` puts back what the carriage takes away: the button must stay
            focusable and clickable, and a press on it still bubbles to the frame so grabbing the
            handle starts a drag exactly as grabbing the picture does.
          */}
          <button
            type="button"
            role="slider"
            aria-label={`Reveal the ${beforeLabel.toLowerCase()} image`}
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={rounded}
            aria-valuetext={`${rounded}% ${beforeLabel.toLowerCase()}, ${100 - rounded}% ${afterLabel.toLowerCase()}`}
            onKeyDown={onKeyDown}
            className="pointer-events-auto absolute left-0 top-1/2 inline-flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-full border border-line-200 bg-card shadow-panel"
          >
            <span aria-hidden="true" className="text-sm font-semibold text-purple-700">
              ‹›
            </span>
          </button>
        </div>

        {/*
          Both names, always. Not a hover state, not a tooltip.

          ⚠ `purple-950` AND NOT `ink-900` FOR THE PILL. These sit on a PHOTOGRAPH, so their text is
          unconditionally white and their scrim must be unconditionally dark. `ink-900` is a themed
          neutral that INVERTS (#1e1b2e → #f2f0f9), which turned both pills into near-white plates
          carrying white text in the dark theme. Same reasoning, written out in full, in ImageCredit.tsx.
        */}
        <p className="pointer-events-none absolute bottom-3 left-3 rounded-full bg-purple-950/70 px-2.5 py-1 text-xs font-medium text-white">
          {beforeLabel}
        </p>
        <p className="pointer-events-none absolute bottom-3 right-3 rounded-full bg-purple-950/70 px-2.5 py-1 text-xs font-medium text-white">
          {afterLabel}
        </p>
      </div>

      {caption ? (
        <figcaption className="prose-measure mt-3 text-sm leading-relaxed text-ink-500">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Pairing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One row of `CraftMedia`, as much of it as the pairing needs.
 *
 * `restorationPhase` is a nullable string in the schema rather than an enum, so it is compared
 * case-insensitively and trimmed: "Before" typed into the studio must pair with "before".
 */
export interface RestorationCandidate {
  /** Stable key — the asset id is what `CraftMedia` is keyed on alongside the craft. */
  id: string;
  restorationPhase?: string | null;
  caption?: string | null;
  media: LightboxItem;
}

export interface RestorationPair {
  before: RestorationCandidate;
  after: RestorationCandidate;
}

export interface RestorationSplit {
  pairs: RestorationPair[];
  /** Everything that is not half of a complete pair, in its original order. */
  singles: RestorationCandidate[];
}

function phaseOf(candidate: RestorationCandidate): "before" | "after" | null {
  const phase = candidate.restorationPhase?.trim().toLowerCase();
  if (phase === "before") return "before";
  if (phase === "after") return "after";
  return null;
}

/**
 * Split an ordered list of craft media into comparison pairs and ordinary images.
 *
 * THE RULE IS ADJACENCY IN `position` ORDER: a "before" is held, and the next "after" completes it.
 * `CraftMedia` has no column linking one half to the other, so the editor's ordering is the only
 * evidence of which pairs with which — and it is the evidence they are already giving by dragging the
 * two next to each other.
 *
 * A "before" that never meets an "after", and an "after" with no preceding "before", both fall
 * through to `singles` and render as ordinary photographs. Half a comparison is not a comparison, and
 * showing one half under a slider that has nothing to reveal is worse than showing the picture.
 */
export function splitRestorationPhases(
  items: readonly RestorationCandidate[]
): RestorationSplit {
  const pairs: RestorationPair[] = [];
  const singles: RestorationCandidate[] = [];
  let pendingBefore: RestorationCandidate | null = null;

  for (const item of items) {
    const phase = phaseOf(item);

    if (phase === "before") {
      // Two "before"s in a row: the first one never found its partner, so it is an ordinary image.
      if (pendingBefore) singles.push(pendingBefore);
      pendingBefore = item;
      continue;
    }

    if (phase === "after" && pendingBefore) {
      pairs.push({ before: pendingBefore, after: item });
      pendingBefore = null;
      continue;
    }

    singles.push(item);
  }

  if (pendingBefore) singles.push(pendingBefore);

  return { pairs, singles };
}
