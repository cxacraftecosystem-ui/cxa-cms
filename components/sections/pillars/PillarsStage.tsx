"use client";

/**
 * PillarsStage — the client half of the PLATFORM_PILLARS block, and deliberately the smaller half.
 *
 * `PlatformPillarsSection` (a Server Component) renders every panel, every word, every card, chip
 * and stroke; this wraps that markup and adds ONLY scroll-scrubbed motion, through `useGsapScope` —
 * so reduced motion builds nothing, a failed chunk costs nothing, and teardown is total (that
 * hook's header owns those arguments). Every target is found by `data-pillar-*` attribute: a
 * contract between these two files, never a class somebody will restyle.
 *
 * What the scrub adds, panel by panel — and every one of these RESTS in its final designed state,
 * so the page with no JavaScript is simply the finished page (contract §8):
 *
 *   1. THE RECORD CARDS assemble: each starts scattered and faded (its own `data-dx`/`data-dy`/
 *      `data-rot`, hand-seeded in the server file) and settles into the neat grid, staggered by
 *      index inside one scrubbed timeline. Opacity never starts below 0.2 — the resting design is
 *      the lit grid; the scrub only rewinds it, never hides it.
 *   2. THE KOLAM LINE draws through its pulli — the story's own dash trick: `pathLength` is set
 *      here at runtime so `KolamMark` stays pure-static for its other callers, dasharray 1000 with
 *      offset 1001 so no undrawn cap peeks at progress 0.
 *   3. THE PHOTOGRAPH CHIPS travel home into their corner stack, each from its own distance — the
 *      different distances over one scroll span ARE the different rates that read as parallax.
 *      Displacement only; opacity untouched.
 *   4. THE NETWORK's edges draw (same dash trick, staggered) and its nodes brighten from 0.35 —
 *      never from invisible, for the same resting-design reason as the cards.
 *   0. THE AMBIENT PAUSE: one trigger flips `data-pillars-ambient` on the scope, and
 *      app/platform-pillars.css pauses the gold query node's CSS breath while the section is off
 *      screen — the cinematic story's own economy. GSAP never touches that node's transform: the
 *      breath is CSS on an inner group, the brightening is opacity on the outer one, so no element
 *      carries two transform writers (contract §8).
 *
 * `ease: "none"` on every scrub, always — an eased scrub moves at a different speed from the
 * reader's hand and reads as lag, not craft (StoryStage says the same).
 */

import type { ReactNode } from "react";

import { useGsapScope } from "@/components/motion/gsap/useGsapScope";

export function PillarsStage({ children }: { children: ReactNode }) {
  const scopeRef = useGsapScope<HTMLDivElement>(({ gsap, ScrollTrigger, q, scope }) => {
    // ── 0. The ambient pause ────────────────────────────────────────────────
    // `onToggle` fires only on CHANGE, so a page that loads with the section off screen would run
    // the breath until the first crossing. Seed the attribute from the trigger's initial state.
    const ambient = ScrollTrigger.create({
      trigger: scope,
      start: "top bottom",
      end: "bottom top",
      onToggle: (self) => scope.setAttribute("data-pillars-ambient", self.isActive ? "on" : "off")
    });
    scope.setAttribute("data-pillars-ambient", ambient.isActive ? "on" : "off");

    // ── 1. The record cards assemble ────────────────────────────────────────
    // One scrubbed timeline, a fromTo per card at a position staggered by index — per-card tweens
    // because each card has its OWN scatter, which a single `stagger` option cannot express. The
    // trigger is the panel by data contract, never `closest("div")` (the self-referential-trigger
    // trap CinematicScrollStage documents).
    const cards = q("[data-pillar-card]");
    if (cards.length > 0) {
      const timeline = gsap.timeline({
        scrollTrigger: {
          trigger: cards[0]?.closest("[data-pillar='bases']") ?? scope,
          start: "top 88%",
          end: "center 45%",
          scrub: true
        }
      });
      cards.forEach((card, index) => {
        const dx = Number(card.dataset.dx) || 0;
        const dy = Number(card.dataset.dy) || 0;
        const rot = Number(card.dataset.rot) || 0;
        timeline.fromTo(
          card,
          { x: dx, y: dy, rotation: rot, opacity: 0.2 },
          { x: 0, y: 0, rotation: 0, opacity: 1, ease: "none", duration: 1 },
          index * 0.06
        );
      });
    }

    // ── 2. The kolam line, drawn ────────────────────────────────────────────
    // KolamMark ships without `pathLength`; setting it here keeps the mark itself pure-static for
    // its other callers while giving this one dash arithmetic that ignores real length.
    const kolamWrap = q("[data-pillar-kolam]")[0];
    const kolamPath = kolamWrap?.querySelector<SVGPathElement>("path[d]");
    if (kolamWrap && kolamPath) {
      kolamPath.setAttribute("pathLength", "1000");
      gsap.fromTo(
        kolamPath,
        { strokeDasharray: 1000, strokeDashoffset: 1001 },
        {
          strokeDashoffset: 0,
          ease: "none",
          scrollTrigger: {
            trigger: kolamWrap.closest("[data-pillar='field']") ?? kolamWrap,
            start: "top 88%",
            end: "center 40%",
            scrub: true
          }
        }
      );
    }

    // ── 3. The chips gather into the stack ──────────────────────────────────
    // Displacement only, to the seats the server laid; the static tilt lives on the INNER span so
    // this transform never erases it (the two-wrapper split the server file documents).
    for (const chip of q("[data-pillar-chip]")) {
      const dx = Number(chip.dataset.dx) || 0;
      const dy = Number(chip.dataset.dy) || 0;
      const rot = Number(chip.dataset.rot) || 0;
      gsap.fromTo(
        chip,
        { x: dx, y: dy, rotation: rot },
        {
          x: 0,
          y: 0,
          rotation: 0,
          ease: "none",
          scrollTrigger: {
            trigger: chip.closest("[data-pillar='field']") ?? chip,
            start: "top 88%",
            end: "center 45%",
            scrub: true
          }
        }
      );
    }

    // ── 4. The network: edges draw, nodes brighten ──────────────────────────
    // The edges all share one fromTo, so GSAP's own stagger works here — the amount is scroll
    // distance, not time, exactly as the cinematic's orbit uses it.
    const edges = q("[data-pillar-edge]");
    if (edges.length > 0) {
      gsap.fromTo(
        edges,
        { strokeDasharray: 1000, strokeDashoffset: 1001 },
        {
          strokeDashoffset: 0,
          ease: "none",
          stagger: 0.05,
          scrollTrigger: {
            trigger: edges[0]?.closest("[data-pillar='systems']") ?? scope,
            start: "top 88%",
            end: "center 40%",
            scrub: true
          }
        }
      );
    }

    const nodes = q("[data-pillar-node]");
    if (nodes.length > 0) {
      gsap.fromTo(
        nodes,
        { opacity: 0.35 },
        {
          opacity: 1,
          ease: "none",
          stagger: 0.06,
          scrollTrigger: {
            trigger: nodes[0]?.closest("[data-pillar='systems']") ?? scope,
            start: "top 85%",
            end: "center 45%",
            scrub: true
          }
        }
      );
    }
  }, []);

  return <div ref={scopeRef}>{children}</div>;
}
