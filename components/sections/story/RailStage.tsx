"use client";

/**
 * RailStage — the CLIENT half of the sideways rail, and the half that is allowed to do nothing.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE RAIL ALREADY WORKS BEFORE THIS FILE RUNS, AND THAT IS THE WHOLE DESIGN.
 *
 * `HorizontalRailSection` — a Server Component — renders every card, every photograph and every word
 * inside an `overflow-x: auto` strip with CSS scroll-snap. That strip is operable by touch, by a
 * trackpad, by its scrollbar and by the keyboard, and it is what a reader gets with JavaScript off,
 * under reduced motion, on a phone, and on any screen narrower than `lg`. This wrapper owns no
 * content at all; it adds ONE optional enhancement on top of a rail that is already complete:
 *
 *   • **The pin.** On a wide screen, and only when the editor asked for it, the section holds still
 *     while the track travels sideways by exactly the distance the reader would otherwise have had to
 *     drag it. Nothing appears, nothing fades in, nothing is hidden until the chunk lands — the rail
 *     starts at x: 0, which is precisely where the HTML already puts it.
 *
 * ⚠ THE OPPOSITE ORDER IS THE COMMON BUG, and the schema's header names it: a rail built as a pinned
 * GSAP effect with a fallback bolted on is a carousel that cannot be scrolled on the one device where
 * sideways scrolling is natural, and whose fallback nobody ever looks at.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ PINNING TAKES THE SCROLL AWAY, SO IT REFUSES TO ENGAGE WHERE THAT WOULD TRAP SOMEBODY. Below
 * `lg` there is no pin (a phone has one natural axis and it is the one the reader is already using),
 * and where the track is no wider than its viewport there is no pin either — pinning a rail with
 * nothing to travel is a section that eats the scroll wheel and then gives nothing back for it. Both
 * gates live inside `gsap.matchMedia()`, so crossing the breakpoint reverts the pin rather than
 * leaving a stale one measured against a width that no longer exists.
 *
 * ⚠ EVERY ELEMENT IS FOUND BY `data-*` ATTRIBUTE, never by class name — `data-rail-track` is a
 * contract between two files and reads as one at both ends, where a Tailwind class is a styling
 * decision somebody will change on a Tuesday.
 */

import type { ReactNode } from "react";

import { useGsapScope } from "@/components/motion/gsap/useGsapScope";
import { clamp } from "@/lib/utils";

export interface RailStageProps {
  /**
   * The editor's opt-in, straight from the payload.
   *
   * `false` passes a null builder to `useGsapScope`, which builds nothing and keeps the hook order
   * identical either way — the rail is then purely the native scroller underneath.
   */
  pin: boolean;
  children: ReactNode;
}

/**
 * The pin never engages below this.
 *
 * `lg` is where the site's two-column layouts appear and where a reader is holding a pointing device
 * rather than a thumb. It is the same breakpoint `StoryScrollSection` sticks its figures at, on
 * purpose: one number for "there is room for cinema here".
 */
const PIN_QUERY = "(min-width: 1024px)";

/**
 * `--nav-clearance` in pixels, asked of the browser rather than restated as "6rem".
 *
 * The pinned section has to stop below the floating header or its heading spends the whole pin behind
 * the glass pill. That clearance is ONE number, declared once in globals.css (contract §7), and
 * ScrollTrigger needs it as pixels — so a zero-width probe is inserted, measured and removed rather
 * than the number being copied here where it would quietly drift when the header changes.
 *
 * Out of flow and zero-width, so it cannot reflow anything or fire the runtime's body `ResizeObserver`
 * on the way in or out.
 */
function navClearance(within: HTMLElement): number {
  const probe = within.ownerDocument.createElement("div");
  probe.style.cssText =
    "position:absolute;top:0;left:0;width:0;height:var(--nav-clearance);visibility:hidden;pointer-events:none";
  within.appendChild(probe);
  const height = probe.getBoundingClientRect().height;
  probe.remove();
  return height;
}

export function RailStage({ pin, children }: RailStageProps) {
  const scopeRef = useGsapScope<HTMLDivElement>(
    pin
      ? ({ gsap, ScrollTrigger, q, scope }) => {
          const viewport = q("[data-rail-viewport]")[0];
          const track = q("[data-rail-track]")[0];
          if (!viewport || !track) return;

          /**
           * How far the track has to travel, measured for real.
           *
           * ⚠ MEASURED OFF THE TRACK, NOT THE VIEWPORT. `viewport.scrollWidth` is the obvious
           * spelling and it stops working the moment the native overflow is switched off below —
           * an `overflow: clip` box is not a scroll container and reports no scrollable width at
           * all, so the travel would collapse to zero on the first refresh. The track's own overflow
           * is `visible` and its two widths are unaffected both by the clip and by the transform
           * this tween writes on it, which makes them the only numbers safe to re-read later.
           *
           * The difference lands the last card's right edge exactly on the track's right edge, so
           * the rail ends with the same gutter it started with.
           */
          const travel = () => Math.max(0, track.scrollWidth - track.clientWidth);

          gsap.matchMedia().add(PIN_QUERY, () => {
            // Nothing to travel — three cards on a wide desktop — so nothing is built and the reader
            // keeps their scroll wheel. Re-evaluated whenever the query re-matches, which is what
            // makes a resize from "cards overflow" to "cards fit" undo the pin rather than freeze it.
            if (travel() <= 0) return;

            /*
             * ⚠ THE NATIVE SCROLLING MUST BE STOOD DOWN FOR AS LONG AS THE PIN IS UP, OR THE TWO
             * FIGHT OVER THE SAME RAIL. Both are live at once otherwise: the reader flicks a
             * trackpad sideways and the browser moves `scrollLeft`, while GSAP goes on writing a
             * transform computed only from the page's vertical position. The rail then sits at the
             * sum of two positions that disagree, the last cards become unreachable, and every
             * refresh snaps it somewhere else again.
             *
             * `clip` in preference to `hidden` because a `hidden` box is still a scroll container —
             * the browser can and does scroll it programmatically when focus lands on a card off to
             * the side, which is the same desync arriving by a quieter route. The assignment is
             * feature-tested rather than assumed: an unsupported value leaves the property untouched,
             * so `hidden` is the fallback and the `scroll` listener below repairs what it lets past.
             *
             * Everything taken here is given back in the cleanup, which `gsap.matchMedia()` runs when
             * the query stops matching, when the reader turns reduced motion on, and on unmount.
             */
            const previousOverflowX = viewport.style.overflowX;
            const previousSnapType = viewport.style.scrollSnapType;
            const previousScrollLeft = viewport.scrollLeft;

            // Back to the start first: a reader who dragged the rail sideways at a narrow width and
            // then widened the window would otherwise begin the pin part-way along, and the cards
            // past the end would be unreachable by either mechanism.
            viewport.scrollLeft = 0;
            viewport.style.overflowX = "clip";
            if (viewport.style.overflowX !== "clip") viewport.style.overflowX = "hidden";
            // Snap points on a box the reader can no longer scroll are dead weight, and on the
            // `hidden` fallback they would drag any stray programmatic scroll to a card edge.
            viewport.style.scrollSnapType = "none";

            const keepAtStart = () => {
              if (viewport.scrollLeft !== 0) viewport.scrollLeft = 0;
            };
            viewport.addEventListener("scroll", keepAtStart, { passive: true });

            /*
             * The travel itself.
             *
             * `ease: "none"` because it is scrubbed: an eased scrub moves at a different speed from
             * the reader's own hand, and that mismatch reads as the page lagging rather than as
             * cinema. `x` is written in pixels rather than a percentage so the distance is exactly
             * the distance measured — a `xPercent` would be a percentage of the TRACK's width, which
             * is not the number anybody here means.
             *
             * `paused` and handed to the trigger below: the ScrollTrigger owns its progress, and a
             * tween that also ran on its own clock would race it for one frame at creation.
             */
            const tween = gsap.fromTo(
              track,
              { x: 0 },
              { x: () => -travel(), ease: "none", paused: true }
            );

            const trigger = ScrollTrigger.create({
              // ⚠ THE TRIGGER AND THE PINNED ELEMENT ARE BOTH THE SECTION'S OWN CONTAINER, never the
              // rail inside it. A pinned child stops moving relative to the viewport the moment it
              // sticks and reports almost no progress for the rest of its life, so a trigger on it
              // would run the whole travel in a rush at each end.
              trigger: scope,
              pin: scope,
              start: () => {
                const clearance = navClearance(scope);
                // A section taller than the window cannot be pinned from its top without its last
                // row sitting below the fold for the entire journey. Where that happens the pin
                // waits for the BOTTOM edge instead, so the whole rail is on screen before the
                // scroll is taken away.
                return scope.offsetHeight + clearance > window.innerHeight
                  ? "bottom bottom"
                  : `top ${clearance}px`;
              },
              // One pixel of page for one pixel of rail. Any other ratio means the rail moves at a
              // speed the reader's hand did not ask for, which is the same complaint as an eased
              // scrub wearing different clothes.
              end: () => `+=${travel()}`,
              scrub: true,
              // The pin is applied a touch early, so a fast flick does not show a frame of the
              // section already scrolled past before `position: fixed` takes hold.
              anticipatePin: 1,
              // Re-measure on every refresh — and the runtime already calls `ScrollTrigger.refresh()`
              // from a `ResizeObserver` on `<body>`, so a late photograph, a font swap or a window
              // resize all re-run `travel()` and both function-based values above.
              invalidateOnRefresh: true,
              animation: tween
            });

            /*
             * ⚠ FOCUS MUST NOT LAND ON A CARD NOBODY CAN SEE.
             *
             * With the native overflow stood down, the browser's own "scroll the focused thing into
             * view" has nothing left to scroll: the rail's position is a transform driven entirely by
             * where the page is vertically. So a reader tabbing along the cards would move focus into
             * the clipped region and lose it completely — the failure this whole block exists to
             * avoid, arriving through the keyboard instead of the trackpad.
             *
             * The fix is to translate "this card should be visible" back into the only coordinate
             * that now matters: how far down the page the pin has been scrubbed. The card's offset
             * along the track, as a fraction of the total travel, is the trigger's progress; that
             * maps onto a scroll position between its start and its end.
             *
             * The visibility test first means a mouse click — which also fires `focusin`, on a card
             * that is plainly already on screen — never jumps the page under the pointer.
             */
            const revealFocused = (event: FocusEvent) => {
              const target = event.target;
              if (!(target instanceof HTMLElement)) return;

              const card = target.closest<HTMLElement>("[data-rail-card]");
              if (!card) return;

              /**
               * ⚠ "VISIBLE" IS MEASURED AGAINST THE RAIL'S OWN BOX, NEVER AGAINST THE WINDOW.
               *
               * The thing doing the clipping is the scroller, and the scroller is not the width of
               * the screen: `.shell` stops at 84rem, so on any display wider than about 1344px the
               * rail's right edge sits hundreds of pixels inside the viewport. Testing against
               * `window.innerWidth` therefore reads a card that has been clipped clean out of sight
               * as "already on screen", returns early, and leaves focus exactly where this handler
               * exists to stop it landing — and it does so ONLY on the large desktops that are the
               * only place the pin ever runs, which is what makes it invisible in development.
               */
              const frame = viewport.getBoundingClientRect();
              const box = card.getBoundingClientRect();
              if (box.left >= frame.left && box.right <= frame.right) return;

              const reach = travel();
              const span = trigger.end - trigger.start;
              if (reach <= 0 || span <= 0) return;

              // Both rectangles carry the same transform, so their difference is the card's untouched
              // offset along the track — which is what `offsetLeft` would have given had the track
              // been the offset parent, and this does not care whether it is.
              const distance = box.left - track.getBoundingClientRect().left;
              const progress = clamp(distance / reach, 0, 1);

              // Straight to the position; Lenis stands `scroll-behavior: smooth` down while it is
              // running and adopts an outside scroll on its next frame, so this is honoured in both
              // worlds. Reduced motion never reaches here at all — the hook builds nothing.
              window.scrollTo({ top: trigger.start + progress * span });
            };

            viewport.addEventListener("focusin", revealFocused);

            return () => {
              viewport.removeEventListener("focusin", revealFocused);
              viewport.removeEventListener("scroll", keepAtStart);
              // Put the box back exactly as the server rendered it. The tween, the trigger and the
              // pin spacer are killed by the context that owns this `matchMedia`, so they are
              // deliberately not touched here — reverting them twice is how a pin spacer gets left
              // behind with nothing in it.
              viewport.style.overflowX = previousOverflowX;
              viewport.style.scrollSnapType = previousSnapType;
              viewport.scrollLeft = previousScrollLeft;
            };
          });

          /*
           * ⚠ THE `tabIndex` ON THE SCROLLER IS DELIBERATELY LEFT ALONE while the pin is up, even
           * though the box it names cannot be scrolled sideways for as long as that lasts. It is
           * still the landmark that tells a keyboard reader the rail is here, the pin can end at any
           * moment (a resize, the reduced-motion toggle, a failed chunk), and an attribute that
           * JavaScript removes from a server-rendered element is a divergence with no owner. While
           * pinned, the keys that move the rail are the page's own — the page's scroll IS the rail's
           * position, which is the entire point of the effect.
           */
        }
      : null,
    [pin]
  );

  return <div ref={scopeRef}>{children}</div>;
}
