"use client";

/**
 * StoryScenesA — the first half of the cinematic story: chapters 02–08 of the owner's script.
 *
 * Every scene is a pure choreography of the SUPPLIED copy — the words are the owner's, verbatim,
 * with the script's ALL-CAPS realised as a type treatment in `BigLine` rather than typed into the
 * strings (see storyShared). A scene renders everything it will ever say in the HTML immediately;
 * only opacity and transform arrive late. Under reduced motion every displacement collapses to
 * zero and the phrases simply fade in on the same clock (the factories in storyShared gate it).
 *
 * The delays inside each scene are the choreography — the "beats" the script asks for ("Give them
 * one strong statement… Then… And finally") — and each scene's total runtime lives beside its
 * entry in CinematicStory's SCENES table. Change one and the other must move with it, or a scene
 * will be cut off mid-thought / sit finished and dead.
 */

import { motion } from "framer-motion";

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
// 02 · The opening statement
// ─────────────────────────────────────────────────────────────────────────────

export function SceneCraft({ reduce }: SceneProps) {
  return (
    <Stage>
      <motion.div variants={phrase(reduce, 0.3)} initial="hidden" animate="visible">
        <BigLine as="h2">Craft is more than what we make.</BigLine>
      </motion.div>
      <motion.div variants={quiet(reduce, 2.0)} initial="hidden" animate="visible">
        <SupportLine className="mt-6">
          It carries knowledge, memory, identity and generations of human experience.
        </SupportLine>
      </motion.div>
    </Stage>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 02 · …progressively — the five ways of knowing, then the landing
// ─────────────────────────────────────────────────────────────────────────────

const KNOWING_LINES = ["A technique.", "A material.", "A pattern.", "A story.", "A way of knowing."];

export function SceneKnowing({ reduce }: SceneProps) {
  return (
    <Stage>
      <div className="flex flex-col items-center gap-2">
        {KNOWING_LINES.map((line, index) => (
          <motion.p
            key={line}
            variants={phrase(reduce, 0.3 + index * 0.55, 14)}
            initial="hidden"
            animate="visible"
            className={cn(
              "font-display text-xl font-semibold text-white/85 sm:text-2xl",
              // The last of the five is the turn of the thought, so it carries the accent.
              index === KNOWING_LINES.length - 1 && "text-gold-300"
            )}
          >
            {line}
          </motion.p>
        ))}
      </div>
      <motion.div variants={phrase(reduce, 3.6)} initial="hidden" animate="visible">
        <BigLine as="h2" className="mt-9">A living body of knowledge.</BigLine>
      </motion.div>
    </Stage>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 03 · The human element
// ─────────────────────────────────────────────────────────────────────────────

const TRANSMISSION = ["Learned.", "Practised.", "Adapted.", "Preserved."];

export function SceneHands({ reduce }: SceneProps) {
  return (
    <Stage>
      <motion.div variants={phrase(reduce, 0.3)} initial="hidden" animate="visible">
        <BigLine as="h2">Behind every craft is knowledge.</BigLine>
      </motion.div>
      <motion.div variants={quiet(reduce, 1.5)} initial="hidden" animate="visible">
        <SupportLine className="mt-6">
          Passed from one generation to another, craft knowledge lives in the hands, minds and
          communities of its makers.
        </SupportLine>
      </motion.div>

      <div className="mt-8 flex flex-wrap items-center justify-center gap-2.5">
        {TRANSMISSION.map((word, index) => (
          <motion.span
            key={word}
            variants={phrase(reduce, 3.0 + index * 0.4, 10)}
            initial="hidden"
            animate="visible"
          >
            <Chip>{word}</Chip>
          </motion.span>
        ))}
      </div>

      <motion.div variants={quiet(reduce, 5.2)} initial="hidden" animate="visible">
        <SupportLine className="mt-8 text-white/60">
          Yet much of this knowledge remains dispersed across people, places, practices and
          generations.
        </SupportLine>
      </motion.div>
    </Stage>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 04 · The problem — the disconnected constellation
// ─────────────────────────────────────────────────────────────────────────────

/** The chain the script draws with arrows, and the four fields floating apart from it. */
const CHAIN = ["Artisan", "Craft", "Knowledge"];
const APART = ["Research", "Design", "Technology", "Community"];

/**
 * Where the four disconnected fields sit, as viewport offsets from the stage centre. Hand-placed
 * rather than computed so the composition can be judged as a picture; deliberately asymmetric,
 * because "scattered" drawn symmetrically reads as arranged. `drift` is the same seat pushed ~12%
 * further out — the "all initially disconnected" told as a slow outward drift. Precomputed numbers
 * in ONE unit, because framer interpolates "-30vw → -33.6vw" and cannot interpolate into `calc()`.
 */
const APART_SEATS = [
  { x: -30, y: -16, driftX: -33.6, driftY: -17.9 },
  { x: 30, y: -10, driftX: 33.6, driftY: -11.2 },
  { x: -26, y: 16, driftX: -29.1, driftY: 17.9 },
  { x: 28, y: 18, driftX: 31.4, driftY: 20.2 }
] as const;

export function SceneFragments({ reduce }: SceneProps) {
  return (
    <Stage>
      <motion.div variants={phrase(reduce, 0.3)} initial="hidden" animate="visible">
        <BigLine as="h2">Knowledge should not be fragmented.</BigLine>
      </motion.div>
      <motion.div variants={quiet(reduce, 1.6)} initial="hidden" animate="visible">
        <SupportLine className="mt-6">
          Craft knowledge exists across artisans, communities, researchers, designers, institutions
          and cultural traditions. Much of it remains difficult to document, connect, discover and
          carry forward into new contexts.
        </SupportLine>
      </motion.div>

      {/* The connected chain: the one line of transmission that DOES exist today. */}
      <div className="mt-9 flex flex-col items-center">
        {CHAIN.map((word, index) => (
          <div key={word} className="flex flex-col items-center">
            {index > 0 ? <FlowArrow reduce={reduce} delay={3.6 + index * 0.45} /> : null}
            <motion.span
              variants={phrase(reduce, 3.4 + index * 0.45, 10)}
              initial="hidden"
              animate="visible"
            >
              <Chip className="border-gold-300/30 text-gold-200">{word}</Chip>
            </motion.span>
          </div>
        ))}
      </div>

      {/* The four fields, adrift. They drift OUTWARD a little as they appear — disconnection told
          as motion — and under reduced motion they are simply seated apart, which says the same
          thing standing still. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 hidden items-center justify-center sm:flex">
        {APART.map((word, index) => {
          const seat = APART_SEATS[index] ?? APART_SEATS[0];
          return (
            <motion.span
              key={word}
              initial={{
                opacity: 0,
                x: `${seat.x}vw`,
                y: `${seat.y}vh`,
                scale: reduce ? 1 : 0.94
              }}
              animate={{
                opacity: 0.55,
                scale: 1,
                x: `${reduce ? seat.x : seat.driftX}vw`,
                y: `${reduce ? seat.y : seat.driftY}vh`
              }}
              transition={{
                duration: reduce ? 0 : AMBIENT.drift,
                ease: EASE,
                delay: 4.6 + index * 0.2
              }}
              className="absolute"
            >
              <Chip className="border-white/10 text-white/60">{word}</Chip>
            </motion.span>
          );
        })}
      </div>

      {/* What the picture says, said — the four names repeat for a reader who cannot see the
          constellation (it is hidden on small screens and aria-hidden everywhere). */}
      <motion.p
        variants={quiet(reduce, 5.4)}
        initial="hidden"
        animate="visible"
        className="mt-8 text-sm text-white/50 sm:sr-only"
      >
        Research. Design. Technology. Community. All initially disconnected.
      </motion.p>
    </Stage>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 05 · The question
// ─────────────────────────────────────────────────────────────────────────────

const WHAT_IFS = [
  "What if traditional knowledge could be documented without losing the context in which it lives?",
  "What if researchers could discover and work with this knowledge in new ways?",
  "What if technology could help carry it forward rather than simply preserve it?"
];

export function SceneQuestion({ reduce }: SceneProps) {
  return (
    <Stage>
      <motion.div variants={phrase(reduce, 0.3)} initial="hidden" animate="visible">
        <BigLine as="h2">What if we could connect it?</BigLine>
      </motion.div>

      <div className="mt-8 flex flex-col items-center gap-3">
        {WHAT_IFS.map((question, index) => (
          <motion.p
            key={question}
            variants={phrase(reduce, 1.7 + index * 1.15, 12)}
            initial="hidden"
            animate="visible"
            className="max-w-[52ch] text-base leading-relaxed text-white/70 sm:text-lg"
          >
            {question}
          </motion.p>
        ))}
      </div>

      {/* Where AI enters the narrative — the script's own stage direction. Gold, because the story
          has been saving the accent for exactly this turn. */}
      <motion.div variants={phrase(reduce, 5.6)} initial="hidden" animate="visible">
        <BigLine className="mt-10 text-gold-300">
          What if AI could help build that connection?
        </BigLine>
      </motion.div>
    </Stage>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 06 · The Centre appears
// ─────────────────────────────────────────────────────────────────────────────

const POSITIONING = [
  "Not replacing traditional knowledge.",
  "Not replacing the maker.",
  "Extending what is already there."
];

export function SceneCentre({ reduce }: SceneProps) {
  return (
    <Stage>
      <motion.div variants={phrase(reduce, 0.3)} initial="hidden" animate="visible">
        <Kicker>The Centre appears</Kicker>
        <BigLine as="h2" className="mt-4">This is where the Centre of Excellence begins.</BigLine>
      </motion.div>
      <motion.div variants={quiet(reduce, 1.8)} initial="hidden" animate="visible">
        <SupportLine className="mt-6">
          A platform bringing together craft, cultural knowledge, research, design and artificial
          intelligence to create new ways of preserving, understanding and engaging with craft.
        </SupportLine>
      </motion.div>

      {/* The positioning the owner called out as particularly important. The two "not"s land
          first and quiet; the extension lands last, gold and larger — the sentence the Centre
          stands on. */}
      <div className="mt-9 flex flex-col items-center gap-2.5">
        {POSITIONING.map((line, index) => {
          const last = index === POSITIONING.length - 1;
          return (
            <motion.p
              key={line}
              variants={phrase(reduce, 3.6 + index * 0.85, 12)}
              initial="hidden"
              animate="visible"
              className={cn(
                "font-display font-semibold",
                last ? "text-xl text-gold-300 sm:text-2xl" : "text-lg text-white/70 sm:text-xl"
              )}
            >
              {line}
            </motion.p>
          );
        })}
      </div>
    </Stage>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 07 · The core idea
// ─────────────────────────────────────────────────────────────────────────────

export function SceneIdea({ reduce }: SceneProps) {
  return (
    <Stage>
      <motion.div variants={phrase(reduce, 0.3)} initial="hidden" animate="visible">
        <BigLine as="h2">Connect what exists.</BigLine>
      </motion.div>
      <motion.div variants={phrase(reduce, 1.2)} initial="hidden" animate="visible">
        <BigLine className="mt-2 text-gold-300">Discover what is possible.</BigLine>
      </motion.div>
      <motion.div variants={quiet(reduce, 2.5)} initial="hidden" animate="visible">
        <SupportLine className="mt-7">
          The Centre seeks to create an integrated ecosystem in which knowledge can move between
          people, disciplines and technologies — enabling craft to be documented, understood,
          explored and carried forward.
        </SupportLine>
      </motion.div>
    </Stage>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 08 · The ecosystem — many perspectives around one centre
// ─────────────────────────────────────────────────────────────────────────────

const ECOSYSTEM = [
  "Artisans",
  "Communities",
  "Researchers",
  "Designers",
  "Students",
  "Institutions",
  "Technology",
  "AI",
  "Craft knowledge",
  "Cultural heritage"
];

/**
 * Ten seats on an ellipse around the centre plate, precomputed rather than measured. `vmin` keeps
 * the ring inside every viewport; the ellipse is wider than tall because the words are.
 */
const RING_SEATS = ECOSYSTEM.map((_, index) => {
  const angle = (index / ECOSYSTEM.length) * Math.PI * 2 - Math.PI / 2;
  return {
    x: `${(Math.cos(angle) * 38).toFixed(2)}vmin`,
    y: `${(Math.sin(angle) * 27).toFixed(2)}vmin`
  };
});

export function SceneEcosystem({ reduce }: SceneProps) {
  return (
    <Stage>
      {/* The centre plate. */}
      <motion.div
        variants={phrase(reduce, 0.3, 12)}
        initial="hidden"
        animate="visible"
        className="rounded-2xl border border-gold-300/30 bg-white/5 px-7 py-4"
      >
        <p className="font-display text-lg font-extrabold uppercase tracking-[0.06em] text-white sm:text-xl">
          Centre of Excellence
        </p>
      </motion.div>

      {/* The ring. Hidden from the accessibility tree — the list below is the readable account —
          and absent on small screens, where ten orbiting chips would collide with the plate. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 hidden items-center justify-center sm:flex">
        {ECOSYSTEM.map((member, index) => {
          const seat = RING_SEATS[index] ?? { x: "0vmin", y: "0vmin" };
          return (
            <motion.span
              key={member}
              initial={{
                opacity: 0,
                x: reduce ? seat.x : "0vmin",
                y: reduce ? seat.y : "0vmin",
                scale: reduce ? 1 : 0.9
              }}
              animate={{ opacity: 0.9, x: seat.x, y: seat.y, scale: 1 }}
              transition={{
                duration: reduce ? 0 : AMBIENT.ringArrive,
                ease: EASE,
                delay: 1.3 + index * 0.14
              }}
              className="absolute"
            >
              <Chip>{member}</Chip>
            </motion.span>
          );
        })}
      </div>

      {/* The readable account of the ring, and the phones' whole version of it. */}
      <motion.p
        variants={quiet(reduce, 1.6)}
        initial="hidden"
        animate="visible"
        className="mt-6 max-w-[44ch] text-sm leading-relaxed text-white/60 sm:sr-only"
      >
        Artisans, communities, researchers, designers, students, institutions, technology, AI,
        craft knowledge and cultural heritage.
      </motion.p>

      <motion.div variants={phrase(reduce, 3.6)} initial="hidden" animate="visible">
        <SupportLine className="mt-8 font-display text-lg font-semibold text-white sm:text-xl">
          Many perspectives. One connected ecosystem.
        </SupportLine>
      </motion.div>
    </Stage>
  );
}
