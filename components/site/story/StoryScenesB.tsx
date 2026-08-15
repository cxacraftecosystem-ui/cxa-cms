"use client";

/**
 * StoryScenesB — the second half of the cinematic story: chapters 09–16 of the owner's script.
 *
 * Same rules as StoryScenesA: the copy is the owner's verbatim, the capitals are a treatment, every
 * word is in the HTML from mount, and the factories in storyShared gate every displacement on
 * `reduce`. See StoryScenesA's header for the duration/choreography coupling with CinematicStory.
 *
 * ⚠ The research themes in SceneResearch are the eight the owner supplied, kept in full — their
 * script notes they must be trimmed to the Centre's APPROVED research scope before this is
 * publishable, and that trim is an institutional decision nobody at a keyboard can make for them.
 * The list is one array below; cutting it is a one-line edit.
 */

import { useEffect, useState } from "react";
import { motion } from "framer-motion";

import { KolamLattice } from "@/components/craft/KolamLattice";
import { cn } from "@/lib/utils";
import {
  AMBIENT,
  BigLine,
  Chip,
  EASE,
  FlowArrow,
  Kicker,
  phrase,
  quiet,
  Stage,
  SupportLine
} from "@/components/site/story/storyShared";

interface SceneProps {
  reduce: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// 09 · What the Centre enables — the five verbs
// ─────────────────────────────────────────────────────────────────────────────

const ENABLES = [
  {
    verb: "Preserve",
    line: "Document and digitally preserve knowledge embedded in craft traditions."
  },
  {
    verb: "Understand",
    line: "Bring structure and context to materials, techniques, processes, patterns and cultural knowledge."
  },
  {
    verb: "Discover",
    line: "Make craft knowledge easier to explore, search and connect across disciplines and communities."
  },
  {
    verb: "Create",
    line: "Enable new forms of creative exploration through technology and AI."
  },
  {
    verb: "Connect",
    line: "Bring together artisans, researchers, designers, institutions and communities through a shared ecosystem."
  }
];

export function SceneEnables({ reduce }: SceneProps) {
  return (
    <Stage>
      <dl className="flex w-full max-w-2xl flex-col items-stretch">
        {ENABLES.map((entry, index) => (
          <motion.div
            key={entry.verb}
            variants={phrase(reduce, 0.4 + index * 1.05, 16)}
            initial="hidden"
            animate="visible"
            className={cn(
              "grid grid-cols-1 gap-x-6 gap-y-0.5 py-2.5 text-left sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-baseline",
              index > 0 && "border-t border-white/10"
            )}
          >
            <dt className="font-display text-xl font-extrabold uppercase tracking-[0.04em] text-gold-300 sm:text-2xl">
              {entry.verb}
            </dt>
            <dd className="text-sm leading-relaxed text-white/70 sm:text-base">{entry.line}</dd>
          </motion.div>
        ))}
      </dl>
    </Stage>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 10 · Craft × AI
// ─────────────────────────────────────────────────────────────────────────────

export function SceneAi({ reduce }: SceneProps) {
  return (
    <Stage>
      <motion.div variants={phrase(reduce, 0.3)} initial="hidden" animate="visible">
        <Kicker>Craft × AI</Kicker>
        <BigLine as="h2" className="mt-4">When craft meets intelligence.</BigLine>
      </motion.div>
      <motion.div variants={quiet(reduce, 1.7)} initial="hidden" animate="visible">
        <SupportLine className="mt-6">
          Artificial intelligence can help us work with complex forms of knowledge — across images,
          language, patterns, processes and cultural context.
        </SupportLine>
      </motion.div>
      <motion.p
        variants={phrase(reduce, 3.4, 12)}
        initial="hidden"
        animate="visible"
        className="mt-8 text-base text-white/60 sm:text-lg"
      >
        The opportunity is not simply to digitise craft.
      </motion.p>
      <motion.div variants={phrase(reduce, 4.4)} initial="hidden" animate="visible">
        <BigLine className="mt-4 text-gold-300">It is to make knowledge more connected.</BigLine>
      </motion.div>
    </Stage>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 11 · Human + AI positioning
// ─────────────────────────────────────────────────────────────────────────────

const PRINCIPLES = [
  { name: "Human-centred", line: "People and communities remain central to the ecosystem." },
  { name: "Knowledge-driven", line: "Technology builds upon knowledge rather than obscuring it." },
  {
    name: "Future-ready",
    line: "Traditional knowledge can evolve into new forms and new possibilities."
  }
];

export function SceneMaker({ reduce }: SceneProps) {
  return (
    <Stage>
      <motion.div variants={phrase(reduce, 0.3)} initial="hidden" animate="visible">
        <BigLine as="h2">Technology serves the maker.</BigLine>
      </motion.div>
      <motion.div variants={quiet(reduce, 1.6)} initial="hidden" animate="visible">
        <SupportLine className="mt-6">
          The Centre places human knowledge at the heart of technological innovation, using AI and
          digital systems to support discovery, documentation, learning and creative exploration.
        </SupportLine>
      </motion.div>

      <div className="mt-9 grid w-full max-w-3xl grid-cols-1 gap-3 sm:grid-cols-3">
        {PRINCIPLES.map((principle, index) => (
          <motion.div
            key={principle.name}
            variants={phrase(reduce, 3.2 + index * 0.5, 14)}
            initial="hidden"
            animate="visible"
            className="rounded-xl border border-white/10 bg-white/5 px-5 py-4 text-left"
          >
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-300">
              {principle.name}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-white/70">{principle.line}</p>
          </motion.div>
        ))}
      </div>
    </Stage>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 12 · Research
// ─────────────────────────────────────────────────────────────────────────────

/** ⚠ Trim to the approved research scope before launch — see the file header. */
const RESEARCH_THEMES = [
  "Artificial intelligence",
  "Generative AI",
  "Computer vision",
  "Multimodal knowledge",
  "Digital preservation",
  "Knowledge systems",
  "Computational design",
  "Human–AI collaboration"
];

export function SceneResearch({ reduce }: SceneProps) {
  return (
    <Stage>
      <motion.div variants={phrase(reduce, 0.3)} initial="hidden" animate="visible">
        <BigLine as="h2">Where craft becomes a field of research.</BigLine>
      </motion.div>
      <motion.div variants={quiet(reduce, 1.6)} initial="hidden" animate="visible">
        <SupportLine className="mt-6">
          The Centre brings together interdisciplinary research across artificial intelligence,
          digital technologies, craft, design, cultural knowledge and human creativity.
        </SupportLine>
      </motion.div>

      <div className="mt-9 flex max-w-2xl flex-wrap items-center justify-center gap-2.5">
        {RESEARCH_THEMES.map((theme, index) => (
          <motion.span
            key={theme}
            variants={phrase(reduce, 3.0 + index * 0.22, 10)}
            initial="hidden"
            animate="visible"
          >
            <Chip>{theme}</Chip>
          </motion.span>
        ))}
      </div>
    </Stage>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 13 · From knowledge to impact
// ─────────────────────────────────────────────────────────────────────────────

const IMPACT_CHAIN = ["Knowledge", "Research", "Technology", "Collaboration", "Impact"];

export function SceneImpact({ reduce }: SceneProps) {
  return (
    <Stage>
      <motion.div variants={phrase(reduce, 0.3)} initial="hidden" animate="visible">
        <BigLine as="h2">From knowledge to possibility.</BigLine>
      </motion.div>

      <div className="mt-9 flex flex-col items-center">
        {IMPACT_CHAIN.map((word, index) => {
          const last = index === IMPACT_CHAIN.length - 1;
          return (
            <div key={word} className="flex flex-col items-center">
              {index > 0 ? <FlowArrow reduce={reduce} delay={1.7 + index * 0.55} /> : null}
              <motion.span
                variants={phrase(reduce, 1.5 + index * 0.55, 10)}
                initial="hidden"
                animate="visible"
              >
                <Chip className={cn(last && "border-gold-300/40 text-gold-200")}>{word}</Chip>
              </motion.span>
            </div>
          );
        })}
      </div>

      <motion.div variants={quiet(reduce, 4.6)} initial="hidden" animate="visible">
        <SupportLine className="mt-8">
          By connecting disciplines and communities, the Centre aims to create new possibilities for
          how craft knowledge is preserved, studied, experienced and carried forward.
        </SupportLine>
      </motion.div>
    </Stage>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 14 · Who is it for?
// ─────────────────────────────────────────────────────────────────────────────

/** ⚠ The owner's script: confirm these six against the Centre's actual commitments before launch. */
const AUDIENCES = [
  { name: "For artisans", line: "Making knowledge more visible, connected and discoverable." },
  { name: "For communities", line: "Supporting the continuity of living cultural knowledge." },
  { name: "For researchers", line: "Opening new avenues for interdisciplinary research." },
  { name: "For designers", line: "Connecting contemporary creation with traditional knowledge." },
  { name: "For students", line: "Creating new opportunities for learning and experimentation." },
  {
    name: "For institutions",
    line: "Enabling collaboration across research, culture and technology."
  }
];

export function SceneEveryone({ reduce }: SceneProps) {
  return (
    <Stage>
      <motion.div variants={phrase(reduce, 0.3)} initial="hidden" animate="visible">
        <BigLine as="h2">An ecosystem built for many perspectives.</BigLine>
      </motion.div>

      <div className="mt-9 grid w-full max-w-3xl grid-cols-1 gap-x-8 gap-y-4 text-left sm:grid-cols-2 lg:grid-cols-3">
        {AUDIENCES.map((audience, index) => (
          <motion.div
            key={audience.name}
            variants={phrase(reduce, 1.6 + index * 0.4, 12)}
            initial="hidden"
            animate="visible"
          >
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-300">
              {audience.name}
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-white/70">{audience.line}</p>
          </motion.div>
        ))}
      </div>
    </Stage>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 15 · The convergence — the climax
// ─────────────────────────────────────────────────────────────────────────────

const CONVERGING = [
  "Craft",
  "Knowledge",
  "People",
  "Research",
  "Design",
  "Technology",
  "AI",
  "Community",
  "Culture"
];

/**
 * Where each word BEGINS, scattered wide — every seat from the fragments scene's family, plus
 * enough new ones for nine. They all travel to the centre and dim as the two closing statements
 * land over them: everything the story has shown, pulled into one point.
 */
const CONVERGE_SEATS = [
  { x: -34, y: -20 },
  { x: 0, y: -26 },
  { x: 34, y: -18 },
  { x: -38, y: 0 },
  { x: 38, y: 2 },
  { x: -30, y: 18 },
  { x: 12, y: 24 },
  { x: 32, y: 20 },
  { x: -10, y: 26 }
] as const;

export function SceneConvergence({ reduce }: SceneProps) {
  /**
   * ⚠ THE KOLAM MOUNTS AT ITS BEAT, NOT AT THE SCENE'S. `KolamLattice`'s hand-drawn line is a CSS
   * animation that starts the moment the SVG exists — mounted at 0s inside a wrapper that only
   * becomes visible at 3.4s, it had finished drawing before anyone could see it, and the "drawn
   * as one line" moment the whole climax builds to was never on screen (the review caught it).
   * Mounting it on its own timer makes the draw begin exactly when the wrapper fades in.
   */
  const [kolamOn, setKolamOn] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setKolamOn(true), 3400);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <Stage>
      {/* The nine words, travelling home. Ornamental (the closing statements carry the meaning),
          so the layer is aria-hidden; under reduced motion the words simply appear near the centre
          already gathered, which is the same picture at rest. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 hidden items-center justify-center sm:flex">
        {CONVERGING.map((word, index) => {
          const seat = CONVERGE_SEATS[index] ?? CONVERGE_SEATS[0];
          return (
            <motion.span
              key={word}
              initial={{
                opacity: 0,
                x: `${reduce ? 0 : seat.x}vw`,
                y: `${reduce ? 0 : seat.y}vh`
              }}
              animate={{
                opacity: [0, 0.85, 0.85, 0.12],
                x: "0vw",
                y: "0vh"
              }}
              transition={{
                duration: reduce ? 0 : AMBIENT.converge,
                times: reduce ? undefined : [0, 0.25, 0.62, 1],
                ease: EASE,
                delay: 0.3 + index * 0.16
              }}
              className="absolute"
            >
              <Chip className="border-white/10">{word}</Chip>
            </motion.span>
          );
        })}
      </div>

      {/* The kolam rises beneath the closing words — the Centre's own mark, drawn as one line.
          The wrapper fades on the shared clock; the lattice itself arrives via `kolamOn` so the
          draw and the fade begin together (see the note above). */}
      <motion.div
        aria-hidden="true"
        variants={quiet(reduce, 3.4)}
        initial="hidden"
        animate="visible"
        className="pointer-events-none absolute inset-0 flex items-center justify-center"
      >
        {kolamOn ? (
          <KolamLattice className="w-56 text-gold-300/25 sm:w-72" cols={7} rows={5} animate />
        ) : null}
      </motion.div>

      <motion.div variants={phrase(reduce, 3.9)} initial="hidden" animate="visible" className="relative">
        <BigLine as="h2">One ecosystem.</BigLine>
      </motion.div>
      {/* The pause the script asks for lives between these two delays. */}
      <motion.div variants={phrase(reduce, 5.4)} initial="hidden" animate="visible" className="relative">
        <BigLine className="mt-3 text-gold-300">One connected future.</BigLine>
      </motion.div>
    </Stage>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 16 · Final identity — everything stripped back
// ─────────────────────────────────────────────────────────────────────────────

export function SceneIdentity({
  reduce,
  onFinish
}: SceneProps & {
  /** Wired to the close button — the one scene that ends on the reader's word, not a clock. */
  onFinish: () => void;
}) {
  return (
    <Stage>
      <motion.div
        aria-hidden="true"
        variants={quiet(reduce, 0.2)}
        initial="hidden"
        animate="visible"
      >
        <KolamLattice className="mx-auto w-24 text-gold-300/60 sm:w-28" cols={5} rows={3} animate />
      </motion.div>

      <motion.div variants={phrase(reduce, 0.9)} initial="hidden" animate="visible">
        <Kicker className="mt-8">IIT Kharagpur</Kicker>
      </motion.div>

      <motion.div variants={phrase(reduce, 1.5)} initial="hidden" animate="visible">
        <BigLine as="h2" className="mt-4 md:text-6xl">
          Centre of Excellence
        </BigLine>
      </motion.div>

      <motion.div variants={phrase(reduce, 2.3)} initial="hidden" animate="visible">
        <p className="mt-4 font-display text-base font-semibold uppercase leading-relaxed tracking-[0.14em] text-white/75 sm:text-lg">
          For unified AI-enabled
          <br />
          craft ecosystem platform
        </p>
      </motion.div>

      <motion.div variants={quiet(reduce, 3.3)} initial="hidden" animate="visible">
        <p className="mt-7 font-display text-lg italic text-gold-300 sm:text-xl">
          Where heritage meets intelligence.
        </p>
      </motion.div>

      {/* The way out — the scene holds until the reader takes it (or Skip, or Escape; the
          orchestrator keeps both live). Autofocused by CinematicStory when this scene mounts, so
          Enter closes the story from the keyboard without hunting for Skip. */}
      <motion.div variants={quiet(reduce, 4.2)} initial="hidden" animate="visible">
        <button
          type="button"
          data-story-close
          onClick={(event) => {
            // The overlay advances on any click; this click is an ANSWER, not a request to advance
            // past the answer.
            event.stopPropagation();
            onFinish();
          }}
          className="mt-10 inline-flex min-h-11 items-center gap-2 rounded-full border border-gold-300/40 bg-gold-300/10 px-6 font-display text-sm font-bold text-gold-200 transition hover:border-gold-300/70 hover:bg-gold-300/20 focus-visible:!outline-logo-cream"
        >
          Begin exploring
          <span aria-hidden="true">→</span>
        </button>
      </motion.div>
    </Stage>
  );
}
