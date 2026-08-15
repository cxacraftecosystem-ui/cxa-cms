"use client";

/**
 * CinematicScrollStage — the client half of the cinematic story, and deliberately the smaller half.
 *
 * `CinematicScroll` (a Server Component) renders every word, photograph and stroke; this wraps it
 * and adds ONLY scroll-scrubbed motion, through `useGsapScope` — so reduced motion builds nothing,
 * a failed chunk costs nothing, and teardown is total (that hook's header owns those arguments).
 * Every target is found by `data-cine-*` attribute: a contract between these two files, never a
 * class somebody will restyle.
 *
 * What the scrub adds, layer by layer:
 *   1. THE SPINE THREAD — redrawn down the whole piece under the reader's hand. At rest it is
 *      fully drawn; the scrub sets the dash and pays it out. `pathLength=1000` normalises the
 *      arithmetic whatever the section's real height.
 *   2. PHOTOGRAPH PARALLAX — the movement-I pair drift at two speeds inside CraftPhoto's overscan.
 *      ⚠ ±8 is the ceiling, from StoryStage's MAX_SAFE_DRIFT: the overscan is 1.18 and drift past
 *      the spare shows the frame through as a bar at the end of the travel. The two speeds here
 *      are 7 and 4 — inside the ceiling, and different, which is what reads as depth.
 *   3. THE DISPERSED FIELDS — each drifts vertically at its own rate (the `data-cine-drift` value),
 *      so the constellation breathes apart as the reader passes. Seats are the resting design.
 *   4. THE QUESTION'S UNDERLINE and THE KOLAM — both path draws, both fully drawn at rest.
 *   5. THE ORBIT — the ten perspectives ease from a slightly-gathered start out to their seats as
 *      the mandala passes, arriving exactly when the kolam completes.
 *   6. THE VERB RAIL — scaleY fill plus an `is-lit` class per row as the rail passes it (the
 *      story-marks contract: the class is toggled here, its appearance lives in the server file).
 *   7. THE IMPACT CHAIN — `is-lit` left to right as the band crosses the middle of the screen.
 *   8. THE CONVERGENCE — nine words travel IN from far outside the ring to their seats: the
 *      reader's own descent gathers the ecosystem. fromTo displacement only; opacity untouched.
 *
 * `ease: "none"` on every scrub, always — an eased scrub moves at a different speed from the
 * reader's hand and reads as lag, not craft (StoryStage says the same).
 */

import type { ReactNode } from "react";

import { useGsapScope } from "@/components/motion/gsap/useGsapScope";

/** StoryStage's ceiling, restated: CraftPhoto's 1.18 overscan affords ±9%, minus 1% in hand. */
const MAX_SAFE_DRIFT = 8;

export function CinematicScrollStage({ children }: { children: ReactNode }) {
  const scopeRef = useGsapScope<HTMLDivElement>(({ gsap, ScrollTrigger, q, scope }) => {
    // ── 0. The ambient pause ────────────────────────────────────────────────
    // The CSS breath (orbs, butis) has no business running while the story is eight viewports
    // away. One trigger flips the attribute the stylesheet watches; the animations pause in
    // place and resume where they left off — the ChartMate hero's own economy.
    const ambient = ScrollTrigger.create({
      trigger: scope,
      start: "top bottom",
      end: "bottom top",
      onToggle: (self) => scope.setAttribute("data-cine-ambient", self.isActive ? "on" : "off")
    });
    // `onToggle` fires only on CHANGE, so a page that loads with the story off screen would run
    // the breath until the first crossing. Seed the attribute from the trigger's initial state.
    scope.setAttribute("data-cine-ambient", ambient.isActive ? "on" : "off");

    // ── 0b. The dye orbs travel with the reader ─────────────────────────────
    // Each at its own rate (the data value, in yPercent), so the three sheets of colour slide
    // over one another as the piece scrolls — the depth is the difference between the rates.
    for (const orb of q("[data-cine-orb]")) {
      const rate = Number(orb.dataset.cineOrb) || 0;
      if (rate === 0) continue;
      gsap.fromTo(
        orb,
        { yPercent: -rate },
        {
          yPercent: rate,
          ease: "none",
          scrollTrigger: { trigger: scope, start: "top bottom", end: "bottom top", scrub: true }
        }
      );
    }

    // ── 1. The spine thread, and its lamplight ──────────────────────────────
    // ⚠ A dash scrub is PAINT work per frame — the browser re-rasterises the stroke's bounding
    // box, and this path's box is the whole piece. Measured judgement, not oversight: two thin
    // strokes rasterise in well under a frame on the hardware this site targets, the thread is
    // the signature image of the work, and the alternative (per-movement segments) breaks the
    // one-line conceit the whole piece is built on. If profiling ever disagrees, split the path
    // at the movement seams and draw the segments in sequence.
    const threads = q("[data-cine-thread], [data-cine-thread-glow]");
    for (const thread of threads) {
      gsap.fromTo(
        thread,
        { strokeDasharray: 1000, strokeDashoffset: 1001 },
        {
          strokeDashoffset: 0,
          ease: "none",
          scrollTrigger: {
            trigger: scope,
            // The draw finishes a little before the section does, so the thread has ARRIVED at
            // the kolam while the identity is still on screen — an ending, not a race.
            start: "top 80%",
            end: "bottom 95%",
            scrub: true
          }
        }
      );
    }

    // ── 1b. The shuttle rides the thread ────────────────────────────────────
    // Scroll progress → a point along the path → a transform. `getPointAtLength` answers in
    // viewBox units (100 × 1000); the section's box converts them to pixels. The box is measured
    // on build and on ScrollTrigger refresh — NEVER inside onUpdate, which runs per scrolled
    // frame and a getBoundingClientRect there is a forced layout at the worst possible moment.
    // The bead's resting seat is CSS left:50%/top:0, so the transform written here is the OFFSET
    // from that seat — at progress 0 the offset is 0 and the two systems agree exactly.
    const shuttle = q("[data-cine-shuttle]")[0];
    const threadPath = q("[data-cine-thread]")[0] as SVGPathElement | undefined;
    if (shuttle && threadPath && typeof threadPath.getTotalLength === "function") {
      const pathLength = threadPath.getTotalLength();
      const box = { width: 0, height: 0 };
      const measure = () => {
        box.width = scope.clientWidth;
        box.height = scope.clientHeight;
      };
      measure();

      ScrollTrigger.create({
        trigger: scope,
        // The same span as the thread draw, so the bead is always AT the pen's tip.
        start: "top 80%",
        end: "bottom 95%",
        scrub: true,
        onRefresh: measure,
        onUpdate: (self) => {
          if (box.width === 0 || box.height === 0) return;
          const point = threadPath.getPointAtLength(self.progress * pathLength);
          gsap.set(shuttle, {
            x: (point.x / 100) * box.width - box.width * 0.5,
            y: (point.y / 1000) * box.height
          });
        }
      });
    }

    // ── 1c. The mandala's ring wheels with the reader ───────────────────────
    // A slow ±6° turn of the whole orbit as the chapter passes — the ring is alive, not pinned
    // paper. The wheel is the PARENT of the chips; their own arrival tweens (below) write to the
    // inner spans, so no element carries two transform writers (contract §8).
    const ringWheel = q("[data-cine-ringwheel]")[0];
    if (ringWheel) {
      gsap.fromTo(
        ringWheel,
        { rotation: -6 },
        {
          rotation: 6,
          ease: "none",
          scrollTrigger: {
            trigger: ringWheel.closest("[data-cine-movement]") ?? ringWheel,
            start: "top bottom",
            end: "bottom top",
            scrub: true
          }
        }
      );
    }

    // ── 2. Photograph parallax, two depths ──────────────────────────────────
    for (const group of q("[data-cine-photo]")) {
      const image = group.querySelector<HTMLElement>("[data-craft-parallax]");
      if (!image) continue;
      const drift = group.dataset.cinePhoto === "fast" ? 7 : 4;
      const safe = Math.min(drift, MAX_SAFE_DRIFT);
      gsap.fromTo(
        image,
        { yPercent: -safe },
        {
          yPercent: safe,
          ease: "none",
          scrollTrigger: {
            trigger: group.closest("[data-cine-movement]") ?? group,
            start: "top bottom",
            end: "bottom top",
            scrub: true
          }
        }
      );
    }

    // ── 3. The dispersed fields and the butis ───────────────────────────────
    // ⚠ PIXELS, NOT yPercent: these are 30–60px chips and glyphs, so a percentage of their OWN
    // height is a drift of a few pixels — the review measured the first draft's "dispersal" at
    // ±11px, which is imperceptible. ×2 gives each field a 80–130px journey through its
    // movement, which is what actually reads as adrift.
    for (const field of q("[data-cine-drift]")) {
      const rate = Number(field.dataset.cineDrift) || 0;
      if (rate === 0) continue;
      gsap.fromTo(
        field,
        { y: -rate * 2 },
        {
          y: rate * 2,
          ease: "none",
          scrollTrigger: {
            trigger: field.closest("[data-cine-movement]") ?? field,
            start: "top bottom",
            end: "bottom top",
            scrub: true
          }
        }
      );
    }

    // ── 4. The underline and the kolam, drawn ───────────────────────────────
    const underline = q("[data-cine-underline]")[0];
    if (underline) {
      gsap.fromTo(
        underline,
        { strokeDasharray: 1000, strokeDashoffset: 1001 },
        {
          strokeDashoffset: 0,
          ease: "none",
          scrollTrigger: {
            trigger: underline.closest("svg"),
            start: "top 90%",
            end: "top 45%",
            scrub: true
          }
        }
      );
    }

    // The knowing list's short rail, drawn as its five lines pass. The trigger is the list's
    // wrapper by data contract — `closest("div")` would match the rail ITSELF (closest starts at
    // the element), the self-referential-trigger trap the review caught on the verb rail too.
    const knowingRail = q("[data-cine-knowing-rail]")[0];
    if (knowingRail) {
      gsap.fromTo(
        knowingRail,
        { scaleY: 0 },
        {
          scaleY: 1,
          ease: "none",
          scrollTrigger: {
            trigger: knowingRail.closest("[data-cine-knowing]") ?? knowingRail,
            start: "top 80%",
            end: "bottom 55%",
            scrub: true
          }
        }
      );
    }

    // The blooms: soft lights that rise as their moment arrives. Ornament (aria-hidden), never
    // below 0.15 — the resting design includes the lamp, the scrub only turns the wick.
    for (const bloom of q("[data-cine-bloom]")) {
      gsap.fromTo(
        bloom,
        { opacity: 0.15, scale: 0.9 },
        {
          opacity: 1,
          scale: 1,
          ease: "none",
          scrollTrigger: {
            trigger: bloom.parentElement,
            start: "top 85%",
            end: "center 50%",
            scrub: true
          }
        }
      );
    }

    const kolamWrap = q("[data-cine-kolam]")[0];
    const kolamPath = kolamWrap?.querySelector<SVGPathElement>("path[d]");
    if (kolamWrap && kolamPath) {
      // KolamMark ships without `pathLength`; setting it here keeps the mark itself pure-static
      // for its other callers while giving this one dash arithmetic that ignores real length.
      kolamPath.setAttribute("pathLength", "1000");
      gsap.fromTo(
        kolamPath,
        { strokeDasharray: 1000, strokeDashoffset: 1001 },
        {
          strokeDashoffset: 0,
          ease: "none",
          scrollTrigger: {
            trigger: kolamWrap,
            start: "top 85%",
            end: "center 45%",
            scrub: true
          }
        }
      );
    }

    // ── 5. The orbit's arrival ──────────────────────────────────────────────
    const orbit = q("[data-cine-orbit]");
    if (orbit.length > 0 && kolamWrap) {
      gsap.fromTo(
        orbit,
        { scale: 0.8, opacity: 0.35 },
        {
          scale: 1,
          opacity: 1,
          ease: "none",
          // A small stagger inside the scrub, so the ring assembles around the circle rather
          // than as one synchronized pop — the amount is scroll distance, not time.
          stagger: 0.06,
          scrollTrigger: {
            trigger: kolamWrap,
            start: "top 85%",
            end: "center 40%",
            scrub: true
          }
        }
      );
    }

    // ── 6. The verb rail ────────────────────────────────────────────────────
    const rail = q("[data-cine-rail]")[0];
    if (rail) {
      gsap.fromTo(
        rail,
        { scaleY: 0 },
        {
          scaleY: 1,
          ease: "none",
          scrollTrigger: {
            // The ladder wrapper by its data contract. ⚠ NOT `closest("ol")` — the list is the
            // hairline's SIBLING, not its ancestor, so that lookup never matched and the trigger
            // silently measured the 1px rail itself (the review caught it).
            trigger: rail.closest("[data-cine-ladder]") ?? rail,
            start: "top 75%",
            end: "bottom 45%",
            scrub: true
          }
        }
      );
    }
    for (const verb of q("[data-cine-verb]")) {
      ScrollTrigger.create({
        trigger: verb,
        start: "top 60%",
        onEnter: () => verb.classList.add("is-lit"),
        onLeaveBack: () => verb.classList.remove("is-lit")
      });
    }

    // ── 7. The impact chain ─────────────────────────────────────────────────
    const links = q("[data-cine-link]");
    links.forEach((link, index) => {
      ScrollTrigger.create({
        trigger: link,
        // Staggered by index rather than by geometry: the chips sit on ONE line, so a purely
        // positional trigger would light them all in the same frame.
        start: `top ${72 - index * 4}%`,
        onEnter: () => link.classList.add("is-lit"),
        onLeaveBack: () => link.classList.remove("is-lit")
      });
    });

    // ── 8. The convergence ──────────────────────────────────────────────────
    // Each word travels in from far outside the ring AND tilts home from its own angle — the
    // rotation is what makes the arrival read as settling rather than sliding.
    for (const word of q("[data-cine-converge]")) {
      const dx = word.dataset.dx ?? "0vw";
      const dy = word.dataset.dy ?? "0vh";
      const rot = Number(word.dataset.rot) || 0;
      gsap.fromTo(
        word,
        { x: dx, y: dy, rotation: rot },
        {
          x: "0vw",
          y: "0vh",
          rotation: 0,
          ease: "none",
          scrollTrigger: {
            // The ring itself, not the whole movement — the travel should complete as the ring
            // reaches the middle of the screen, whatever else the movement holds above it.
            trigger: word.closest("[data-cine-ring]") ?? word,
            start: "top 85%",
            end: "center 55%",
            scrub: true,
            // The start offsets are vw/vh, which GSAP snapshots to px at build — without this a
            // resized window travels the words from the OLD viewport's distances.
            invalidateOnRefresh: true
          }
        }
      );
    }
  }, []);

  return <div ref={scopeRef}>{children}</div>;
}
