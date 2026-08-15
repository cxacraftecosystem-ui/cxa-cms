"use client";

/**
 * CinematicStory — the Centre's story, told in ninety seconds of full-screen cinema.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS. Sixteen scenes — the owner's sixteen-chapter script with chapter 01 living in the
 * page hero and chapter 02 split across two scenes — auto-advancing on their own clocks over a
 * permanently dark ground. A click
 * anywhere skips one scene forward; "Skip the story" (always visible) and Escape end it; the final
 * scene holds until the reader chooses to leave. The form is ChartMate's BrandIntro — the
 * acknowledged inspiration — rebuilt on this repo's motion vocabulary and colour system.
 *
 * IT IS A REAL MODAL, and every mechanic below exists because of a specific failure the reference
 * implementation already paid for (its header records them; they are not re-derived here):
 *   • a labelled `role="dialog"` with `aria-modal`, never a decorative sheet — a screen reader
 *     must be TOLD the takeover happened;
 *   • focus moves to Skip on mount, Tab cycles inside, and focus is handed back to whatever
 *     opened it — otherwise Tab walks the invisible page behind;
 *   • the page scroll is locked while it is up, or the reader lands at a random offset after;
 *   • a held key must not blow through the timeline (`event.repeat` is dropped).
 *
 * ⚠ REDUCED MOTION PLAYS, IT DOES NOT SKIP — and this deliberately DIVERGES from the reference,
 * which ends the whole intro before it starts. Here the invitation is a visible button; a reader
 * who pressed it and got nothing would read the button as broken, and the words of the story are
 * the content, not the choreography. So under reduced motion every displacement collapses to zero
 * (the storyShared factories and each scene gate on `reduce`) and the scenes become a timed
 * sequence of plain fades — time is not motion. The always-visible Skip is the WCAG 2.2.2
 * pause/stop mechanism for the auto-advance.
 *
 * ⚠ THE SCENE SWAP ANIMATES OPACITY AND A WHISPER OF SCALE, NEVER `filter`. The reference exits
 * scenes through `blur(8px)`; on a full-viewport layer that is a whole-screen repaint per frame,
 * and this repo's vocabulary is opacity and transform only (contract §8, variants.ts).
 *
 * LOADED ONLY ON INVITATION. `StoryInvite` dynamic-imports this module on hover/press, so none of
 * it — scenes, kolam, choreography — is in any page's first-paint bundle (the same rule the GSAP
 * runtime follows).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, type Variants } from "framer-motion";

import { cn } from "@/lib/utils";
import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";
import { useScrollLock } from "@/components/ui/useScrollLock";
import { announceTakeover, clearTakeover } from "@/lib/takeover";
import { AMBIENT, EASE } from "@/components/site/story/storyShared";
import {
  SceneCentre,
  SceneCraft,
  SceneEcosystem,
  SceneFragments,
  SceneHands,
  SceneIdea,
  SceneKnowing,
  SceneQuestion
} from "@/components/site/story/StoryScenesA";
import {
  SceneAi,
  SceneConvergence,
  SceneEnables,
  SceneEveryone,
  SceneIdentity,
  SceneImpact,
  SceneMaker,
  SceneResearch
} from "@/components/site/story/StoryScenesB";

interface SceneDef {
  id: string;
  /**
   * Auto-advance after this many milliseconds; null = the scene holds for the reader (the ending).
   * ⚠ COUPLED to the phrase delays inside the scene component — the last phrase must have landed
   * with a beat to spare, or the cut arrives mid-thought. Change either side with the other open.
   */
  duration: number | null;
  /** Where the ambient glow drifts for this scene, and how strongly it shows. */
  focal: { x: string; y: string; o: number };
}

// The timed scenes sum to ~97s and the ending holds for the reader, so the invite says "a minute
// and a half" — round and honest. If a scene's copy or delays change, re-sum this column and keep
// the invite's spoken duration truthful. The review's reading-time rule is the floor everywhere: a
// closing SENTENCE (not a chip or a single word) gets at least ~2.5s between landing and the cut.
const SCENES: SceneDef[] = [
  { id: "craft", duration: 4200, focal: { x: "0vw", y: "0vh", o: 0.4 } },
  { id: "knowing", duration: 5800, focal: { x: "-6vw", y: "-6vh", o: 0.3 } },
  { id: "hands", duration: 7000, focal: { x: "6vw", y: "4vh", o: 0.4 } },
  { id: "fragments", duration: 7000, focal: { x: "0vw", y: "8vh", o: 0.25 } },
  { id: "question", duration: 7400, focal: { x: "0vw", y: "-8vh", o: 0.5 } },
  { id: "centre", duration: 6800, focal: { x: "0vw", y: "0vh", o: 0.6 } },
  { id: "idea", duration: 5600, focal: { x: "-8vw", y: "0vh", o: 0.4 } },
  { id: "ecosystem", duration: 6200, focal: { x: "0vw", y: "0vh", o: 0.55 } },
  { id: "enables", duration: 7400, focal: { x: "8vw", y: "-4vh", o: 0.35 } },
  { id: "ai", duration: 6000, focal: { x: "0vw", y: "-6vh", o: 0.55 } },
  { id: "maker", duration: 5800, focal: { x: "-6vw", y: "6vh", o: 0.4 } },
  { id: "research", duration: 5800, focal: { x: "6vw", y: "-6vh", o: 0.4 } },
  { id: "impact", duration: 7000, focal: { x: "0vw", y: "6vh", o: 0.45 } },
  { id: "everyone", duration: 6800, focal: { x: "0vw", y: "0vh", o: 0.35 } },
  { id: "convergence", duration: 7600, focal: { x: "0vw", y: "0vh", o: 0.65 } },
  { id: "identity", duration: null, focal: { x: "0vw", y: "-4vh", o: 0.55 } }
];

/** Everything the browser will hand a Tab press inside the overlay. */
const FOCUSABLE =
  'a[href],area[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * The scene swap: fade with a whisper of settle. See the header for why never blur. A factory
 * gated on `reduce`, like every variant in this feature — under reduced motion the swap is a hard
 * cut with no scale, which is what a slideshow does when asked not to move.
 */
function frameVariants(reduce: boolean): Variants {
  return {
    // `opacity: 0` in BOTH branches — reduction collapses the duration, never the initial state
    // (variants.ts's own rule). At zero duration the fade is instant anyway.
    enter: { opacity: 0 },
    center: { opacity: 1, transition: { duration: reduce ? 0 : 0.5, ease: EASE } },
    exit: {
      opacity: 0,
      scale: reduce ? 1 : 0.995,
      // 0.4 — the documented slide duration (§8's list), not an invented 0.45.
      transition: { duration: reduce ? 0 : 0.4, ease: EASE }
    }
  };
}

/** One scene, by id. A component so each gets its own element type and React reconciles the swap. */
function Scene({
  id,
  reduce,
  onFinish
}: {
  id: string;
  reduce: boolean;
  onFinish: () => void;
}) {
  switch (id) {
    case "craft":
      return <SceneCraft reduce={reduce} />;
    case "knowing":
      return <SceneKnowing reduce={reduce} />;
    case "hands":
      return <SceneHands reduce={reduce} />;
    case "fragments":
      return <SceneFragments reduce={reduce} />;
    case "question":
      return <SceneQuestion reduce={reduce} />;
    case "centre":
      return <SceneCentre reduce={reduce} />;
    case "idea":
      return <SceneIdea reduce={reduce} />;
    case "ecosystem":
      return <SceneEcosystem reduce={reduce} />;
    case "enables":
      return <SceneEnables reduce={reduce} />;
    case "ai":
      return <SceneAi reduce={reduce} />;
    case "maker":
      return <SceneMaker reduce={reduce} />;
    case "research":
      return <SceneResearch reduce={reduce} />;
    case "impact":
      return <SceneImpact reduce={reduce} />;
    case "everyone":
      return <SceneEveryone reduce={reduce} />;
    case "convergence":
      return <SceneConvergence reduce={reduce} />;
    case "identity":
      return <SceneIdentity reduce={reduce} onFinish={onFinish} />;
    default:
      return null;
  }
}

/** The ambient glow, drifting to each scene's focal point over the dark ground. */
function AmbientGlow({ focal, reduce }: { focal: SceneDef["focal"]; reduce: boolean }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 flex items-center justify-center"
    >
      <motion.div
        className="h-[80vmax] w-[80vmax] rounded-full"
        style={{
          background:
            "radial-gradient(closest-side, rgb(147 51 234 / 0.16), rgb(88 28 135 / 0.06) 55%, transparent 72%)"
        }}
        initial={{ opacity: 0, x: "0vw", y: "0vh" }}
        animate={{ opacity: focal.o, x: reduce ? "0vw" : focal.x, y: reduce ? "0vh" : focal.y }}
        transition={{ duration: reduce ? 0 : AMBIENT.glow, ease: EASE }}
      />
    </div>
  );
}

export interface CinematicStoryProps {
  /** Called when the story ends, however it ends. The caller unmounts this component in it. */
  onComplete: () => void;
}

export default function CinematicStory({ onComplete }: CinematicStoryProps) {
  const reduce = useReducedMotionPreference();

  const [scene, setScene] = useState(0);
  const [leaving, setLeaving] = useState(false);
  /**
   * The WCAG 2.2.1/2.2.2 control for the auto-advance: paused, the clock stops and the current
   * scene holds (its own phrase choreography still lands — the phrases are content arriving, and
   * a paused reader wants to finish READING the scene, not to freeze it mid-sentence). Skip is
   * "stop"; this is "pause"; ArrowLeft below is "go back". Together the timeline stops being
   * something that happens TO a slow reader.
   */
  const [paused, setPaused] = useState(false);

  const sceneRef = useRef(0);
  const leavingRef = useRef(false);
  const completedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  const overlayRef = useRef<HTMLDivElement>(null);
  const skipRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  // Remember who opened us so focus can go home when the lights come up.
  useEffect(() => {
    const opener = document.activeElement;
    restoreFocusRef.current =
      opener instanceof HTMLElement && opener !== document.body ? opener : null;
  }, []);

  const fireComplete = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    // Focus first: onComplete unmounts this component, and a focus() on a node that is about to be
    // replaced is the one that gets thrown away.
    const opener = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (opener?.isConnected) opener.focus();
    onCompleteRef.current();
  }, []);

  /** Fade the whole overlay out, then hand the page back. */
  const finish = useCallback(() => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);
  }, []);

  /** Click-anywhere / keyboard: one scene forward (or finish, on the last). */
  const advance = useCallback(() => {
    if (leavingRef.current) return;
    if (sceneRef.current >= SCENES.length - 1) {
      finish();
      return;
    }
    sceneRef.current += 1;
    setScene(sceneRef.current);
  }, [finish]);

  /** One scene back, for the reader who missed a line. Does nothing on the first. */
  const retreat = useCallback(() => {
    if (leavingRef.current || sceneRef.current === 0) return;
    sceneRef.current -= 1;
    setScene(sceneRef.current);
  }, []);

  // The auto-advancing clock. The identity scene's null duration is what makes it hold, and
  // `paused` in the dependencies is what makes Resume restart the CURRENT scene's full time —
  // fair, since a reader who paused was not done with it.
  useEffect(() => {
    if (leaving || paused) return;
    const duration = SCENES[scene]?.duration ?? null;
    if (duration === null) return;
    const timer = window.setTimeout(advance, duration);
    return () => window.clearTimeout(timer);
  }, [leaving, paused, scene, advance]);

  // Focus enters the dialog at Skip — the one control that exists in every scene.
  useEffect(() => {
    skipRef.current?.focus();
  }, []);

  // When the ending scene arrives, hand focus to its close button: the story's last word is a
  // question ("Begin exploring") and the keyboard should be resting on the answer.
  //
  // ⚠ AFTER the button's own entrance, not on mount. The button is in the DOM from the scene's
  // first frame but transparent until its 4.2s beat (SceneIdentity), and focusing it early draws
  // a focus ring around nothing — which reads as a rendering fault to exactly the reader the ring
  // exists for. The delay is the same under reduced motion, because the factories keep their
  // beats there too (time is not motion).
  useEffect(() => {
    if (SCENES[scene]?.id !== "identity") return;
    const timer = window.setTimeout(() => {
      overlayRef.current?.querySelector<HTMLElement>("[data-story-close]")?.focus();
    }, 4400);
    return () => window.clearTimeout(timer);
  }, [scene]);

  // Keyboard: Tab cycles inside, Escape ends, Enter/Space/→ advance one scene per press.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Tab first, and BEFORE the repeat guard: a held Tab must not walk out of the dialog.
      if (event.key === "Tab") {
        const root = overlayRef.current;
        if (!root) return;
        const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (focusables.length === 0) {
          event.preventDefault();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !root.contains(active))) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && (active === last || !root.contains(active))) {
          event.preventDefault();
          first?.focus();
        }
        return;
      }
      if (event.repeat) return;
      if (event.key === "Escape") {
        finish();
      } else if (event.key === "ArrowRight") {
        // ⚠ ARROWS ARE EXEMPT FROM THE BUTTON GUARD BELOW, AND THAT EXEMPTION IS THE WHOLE OF
        // KEYBOARD ADVANCE. Focus lives on a button at all times in this dialog — Skip is the only
        // focusable thing in fifteen of the sixteen scenes — so a guard that swallowed arrows too
        // left a keyboard user with no way to move forward at all: Enter meant "skip everything"
        // and nothing meant "next". An arrow never activates a button, so there is no double-fire
        // to guard against (the review caught the original).
        event.preventDefault();
        advance();
      } else if (event.key === "ArrowLeft") {
        // Backwards, for the reader who missed a line — a screen-magnifier user sees a fraction
        // of the stage at a time and a strictly forward-only timeline reads faster than they can.
        event.preventDefault();
        retreat();
      } else if (event.key === "Enter" || event.key === " ") {
        // A focused button (Skip, Pause, Begin exploring) handles its own activation keys —
        // advancing here as well would double-fire.
        if (event.target instanceof HTMLElement && event.target.closest("button")) return;
        event.preventDefault();
        advance();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance, retreat, finish]);

  // Lock the page scroller while the story is up — the HOUSE lock, not a hand-rolled overflow
  // write: it pays back the scrollbar gutter in the same style flush (no sideways slide of the page
  // behind the fading overlay), reference-counts against other overlays, and restores the exact
  // offset on iOS where `overflow: hidden` alone loses it. It also stops Lenis — Lenis animates
  // window scroll, and a window that cannot scroll is a Lenis that cannot either.
  useScrollLock(true);

  // And announce the takeover, so the page's continuously-painting layers (the hero's particle
  // field sits DIRECTLY behind this opaque ground) stop burning frames nobody can see. Their own
  // observers cannot detect an overlay — the covered element still intersects and the tab is
  // still visible — which is the whole reason lib/takeover exists.
  useEffect(() => {
    announceTakeover();
    return () => clearTakeover();
  }, []);

  const current = SCENES[scene] ?? SCENES[0];
  if (!current) return null;

  /*
   * ⚠ PORTALLED TO <body>, AND THIS IS A BLOCKER-GRADE REQUIREMENT, NOT HYGIENE. This component is
   * rendered by `StoryInvite`, which lives INSIDE the hero — and the hero's <section> carries
   * `isolate` (a deliberate stacking context for its backdrop layers). A `position: fixed`
   * element inside a stacking context competes with the OUTSIDE world at its ANCESTOR's z-index,
   * not its own, so without the portal the site header's fixed pill (z-50, root context) paints
   * on top of the cinematic: a navigation bar floating over every scene. The review caught it;
   * `createPortal` is safe here because this module only ever mounts client-side, after a click.
   */
  return createPortal(
    <motion.div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label="The story of the Centre"
      onClick={advance}
      initial={{ opacity: 0 }}
      animate={{ opacity: leaving ? 0 : 1 }}
      transition={{ duration: reduce ? 0.18 : 0.5, ease: EASE }}
      onAnimationComplete={() => {
        if (leavingRef.current) fireComplete();
      }}
      // Fixed and full-bleed, so it re-pays the scrollbar the lock removed (contract §6) — without
      // this the stage's centred column sits ~8px left of the page's centred column behind it, and
      // the open/close moments read as a sideways flinch. The padding is on THIS element and the
      // absolute children anchor to the inner wrapper below — absolute positioning ignores an
      // ancestor's padding, so paying it here alone would be inert.
      style={{ paddingRight: "var(--scroll-gutter, 0px)" }}
      className={cn(
        // z-[100]: the DIALOG rung of the ladder (contract §6), because that is what this is — a
        // modal dialog that happens to fill the screen. Above the header (50) and popovers (70);
        // below the toast viewport (110), which may correctly speak over it.
        "fixed inset-0 z-[100] select-none overflow-hidden bg-purple-950 text-white",
        leaving && "pointer-events-none"
      )}
    >
      {/* The anchor every absolute layer measures against — sized by the padded content box, so
          the gutter payment above actually reaches the stage, the progress row and Skip. */}
      <div className="relative h-full w-full">
        <AmbientGlow focal={current.focal} reduce={reduce} />

        {/* Fine grain so the big soft gradient does not band on a large cheap panel. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.04] [background-image:radial-gradient(rgba(255,255,255,0.9)_0.5px,transparent_0.5px)] [background-size:24px_24px]"
        />

        <AnimatePresence>
          <motion.div
            key={current.id}
            variants={frameVariants(reduce)}
            initial="enter"
            animate="center"
            exit="exit"
            className="absolute inset-0"
          >
            <Scene id={current.id} reduce={reduce} onFinish={finish} />
          </motion.div>
        </AnimatePresence>

        {/* The progress row: one hair per scene, the current one long and gold. Ornament — the
            progress a reader needs ("how much longer?") is legible from it without a label, and a
            screen reader hears the dialog's own name instead of sixteen list items. z-10 is the
            ladder's in-page-chrome rung (contract §6): above the unlayered scenes, and nothing
            else inside this dialog to compete with. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-7 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5"
        >
          {SCENES.map((entry, index) => (
            <span
              key={entry.id}
              className={cn(
                // `transition-colors`, and the WIDTH change snaps: width is a layout property, and
                // animating it re-lays-out this whole 16-item row on the main thread at the exact
                // moment the scene swap is compositing (the review measured it). The colour fade
                // carries the "time is passing" signal on its own.
                "h-1 rounded-full transition-colors duration-300",
                index === scene ? "w-5 bg-gold-300" : "w-1.5",
                index < scene && "bg-white/45",
                index > scene && "bg-white/15"
              )}
            />
          ))}
        </div>

        {/* The reader's controls over the clock — both always available, Skip is the dialog's
            initial focus. `aria-pressed` on Pause because the label alone ("Pause" / "Resume")
            says the state; the pair sits where every video player has taught the hand to look. */}
        <div className="absolute bottom-6 right-6 z-10 flex items-center gap-1">
          <button
            type="button"
            aria-pressed={paused}
            onClick={(event) => {
              event.stopPropagation();
              setPaused((current) => !current);
            }}
            className="rounded-full px-4 py-2 font-display text-sm font-medium text-white/60 transition-colors hover:text-white focus-visible:!outline-logo-cream"
          >
            {paused ? "Resume" : "Pause"}
          </button>
          <button
            ref={skipRef}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              finish();
            }}
            className="rounded-full px-4 py-2 font-display text-sm font-medium text-white/60 transition-colors hover:text-white focus-visible:!outline-logo-cream"
          >
            Skip the story <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>
    </motion.div>,
    document.body
  );
}
