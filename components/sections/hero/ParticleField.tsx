"use client";

/**
 * ParticleField — the hero's PIGMENT, suspended in water and settling.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT IS NOT A STARFIELD, AND EVERY NUMBER BELOW IS THERE TO STOP IT BECOMING ONE.
 *
 * Nothing twinkles. Nothing streams past. The field never rotates as a whole. Each grain drifts
 * DOWNWARD on its own slow sine, and the lower it gets the slower it falls — which is what a
 * suspension actually does, and why the field reads as pigment settling out of water rather than as
 * snow or as sparkles. A grain crosses the frame in three to six minutes, so within any real visit
 * the movement is felt rather than watched.
 *
 * The palette is the natural-dye palette the Centre studies: indigo, madder, turmeric and lac, in
 * roughly the proportions a dyer's shelf holds them. They are DYES, not the brand ramp — the ≤5% gold
 * budget (contract §1.1) is about the marketing accent, and turmeric here is a few hundred soft
 * points at 70% opacity, which is a fraction of a percent of a viewport.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THIS MODULE IS LOADED BY `next/dynamic` WITH `ssr: false`, FROM HeroSection AND NOWHERE ELSE.
 *
 * three.js is roughly half a megabyte before compression. Importing it anywhere reachable from a
 * page's first bundle puts it in that page's bundle, so the import must stay behind the dynamic
 * boundary. It is also the CALLER — not this file — that decides whether the field may run at all:
 * reduced motion, a coarse pointer, a machine reporting few cores or little memory, and a machine
 * with no WebGL are ALL refused before the chunk is even requested, so a device that cannot afford
 * this never downloads it either. The single probe lives in `canRunParticleField()` in
 * HeroSection.tsx; putting a second copy here would be a second answer to one question.
 *
 * Every refusal falls back to `CraftTapestry` alone, which is a FINISHED DESIGN and not a degraded
 * one. Nothing in this file is load-bearing for the hero's composition.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO THINGS HERE ARE ABOUT NOT BURNING A BATTERY, AND BOTH ARE LOAD-BEARING
 *
 *  • The frame loop STOPS when the hero is off screen or the tab is in the background. A canvas that
 *    keeps painting sixty times a second while the reader is four screens down is power spent on
 *    something nobody can see. ⚠ AND THE POINTER LISTENER STOPS WITH IT, which is the half that is
 *    easy to leave behind: a `window` listener setting two springs is its own frame loop, because a
 *    spring goes on producing values for half a second after every movement. Left installed it would
 *    keep framer's clock awake for the whole visit, writing numbers that `useFrame` is no longer
 *    running to read — the same waste as the canvas, in a place nobody thinks to look for it.
 *  • Every geometry, material and texture is disposed on unmount. A leaked three.js context survives
 *    a client-side navigation, and browsers hard-cap how many live contexts a page may hold: leak
 *    enough of them and every later canvas on the site silently fails to initialise.
 *
 * The pointer is smoothed by `SPRING_POINTER`, the house spring for exactly this (contract §8) — the
 * field should FOLLOW the cursor, not track it. Reading a MotionValue inside `useFrame` keeps that
 * smoothing on framer's clock and off React's: nothing here re-renders while the field moves.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { useSpring, type MotionValue } from "framer-motion";
import {
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  NormalBlending,
  type Points,
  PointsMaterial
} from "three";

import { SPRING_POINTER } from "@/components/motion/constants";
import { pageIsCovered, TAKEOVER_EVENT } from "@/lib/takeover";
import { clamp, cn } from "@/lib/utils";

/**
 * The natural-dye palette, as sRGB hex, with the share of the field each one takes.
 *
 * three parses hex, not `oklch()`. These are pigments rather than tokens — they do not appear in
 * tailwind.config.ts and are not expected to follow the brand ramp — but they are chosen to sit on
 * the `purple-950` ground the hero paints behind them:
 *
 *   indigo   — Indigofera tinctoria, the vat blue. The commonest, and closest to the ground.
 *   madder   — Rubia cordifolia root, the brick red that most Indian block printing is built on.
 *   turmeric — the fugitive yellow, used sparingly here as it is used sparingly on cloth.
 *   lac      — the insect-resin crimson, the rarest and the most expensive.
 *
 * The weights must sum to 1. `pickPigment` walks them cumulatively, so changing one means changing
 * another; a set that sums to less than 1 would silently make the last colour more common.
 */
const PIGMENTS = [
  { hex: "#4055b8", weight: 0.42 }, // indigo
  { hex: "#b8503c", weight: 0.26 }, // madder
  { hex: "#dda52f", weight: 0.2 }, // turmeric
  { hex: "#a3335e", weight: 0.12 } // lac
] as const;

/**
 * FEW, on purpose.
 *
 * The old field held 720 grains and read as a haze. Pigment in suspension is legible as individual
 * particles, so there are fewer of them and each is larger and softer. It is also a third of the
 * per-frame work.
 */
const DEFAULT_COUNT = 340;

/** The field's extent in world units, against a camera at z = 6 with a 55° field of view. */
const SPREAD_X = 9;
const SPREAD_Y = 5.5;
const SPREAD_Z = 3;

/**
 * Fall speed, in world units per second.
 *
 * At the fast end a grain crosses the 11-unit field in about three minutes; at the slow end, fifteen.
 * Anything quicker stops being a suspension and becomes weather.
 */
const FALL_MIN = 0.012;
const FALL_MAX = 0.055;

/**
 * How much a grain slows as it approaches the floor of the field.
 *
 * This is the "settling" half of "drifting downward and settling": the lowest grains fall at a
 * quarter of their own speed, so the field visibly compresses toward the bottom of the hero the
 * longer it is left alone, exactly as pigment does in a still glass.
 */
const SETTLED_FALL_SHARE = 0.25;

/** A frame longer than this is a tab that was in the background, not a slow machine. */
const MAX_STEP_SECONDS = 1 / 30;

export interface ParticleFieldProps {
  /** Position and size. The field has no size of its own — give it `absolute inset-0`. */
  className?: string;
  count?: number;
}

export function ParticleField({ className, count = DEFAULT_COUNT }: ParticleFieldProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const pointerX = useSpring(0, SPRING_POINTER);
  const pointerY = useSpring(0, SPRING_POINTER);

  // Starts true so the first paint is not deferred behind an observer callback.
  const [painting, setPainting] = useState(true);

  // ── May the field paint at all? ─────────────────────────────────────────────
  //
  // Three independent reasons to stop, tracked separately and combined — any one alone would switch
  // the loop back on while another still wanted it off.
  //
  // ⚠ THE THIRD REASON EXISTS BECAUSE THE FIRST TWO CANNOT SEE AN OVERLAY. A full-screen takeover
  // (the cinematic story) leaves this element intersecting and the tab visible, so without
  // lib/takeover's signal the field painted at full rate behind an opaque ground for the story's
  // whole runtime — continuous canvas work nobody could see, found by the story's own review.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let onScreen = true;
    let tabVisible = !document.hidden;
    let uncovered = !pageIsCovered();
    const sync = () => setPainting(onScreen && tabVisible && uncovered);

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        onScreen = entry.isIntersecting;
        sync();
      },
      { threshold: 0 }
    );
    observer.observe(host);

    const onVisibilityChange = () => {
      tabVisible = !document.hidden;
      sync();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    const onTakeover = () => {
      uncovered = !pageIsCovered();
      sync();
    };
    window.addEventListener(TAKEOVER_EVENT, onTakeover);

    return () => {
      window.removeEventListener(TAKEOVER_EVENT, onTakeover);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      observer.disconnect();
    };
  }, []);

  // ── The pointer parallax, installed only while the field is painting ────────
  //
  // Gated on `painting` for the reason in the header: two springs fed from a `window` listener are a
  // frame loop of their own, and the one the reader cannot see is the one worth switching off. The
  // springs are left to settle rather than jumped to zero — a reader scrolling back up to the hero
  // should find the field where they left it, not snapped square.
  useEffect(() => {
    if (!painting) return;

    // Normalised to -1…1 across the VIEWPORT rather than across the canvas: the hero fills the first
    // screen, and a reader moving the cursor over the headline is moving it over this field.
    const onPointerMove = (event: PointerEvent) => {
      pointerX.set((event.clientX / window.innerWidth) * 2 - 1);
      pointerY.set((event.clientY / window.innerHeight) * 2 - 1);
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });

    return () => window.removeEventListener("pointermove", onPointerMove);
  }, [painting, pointerX, pointerY]);

  return (
    // Ornamental and never interactive: out of the accessibility tree, and transparent to the
    // pointer so the buttons sitting over it stay pressable.
    <div ref={hostRef} aria-hidden="true" className={cn("pointer-events-none", className)}>
      <Canvas
        // Capped device pixel ratio: a 2× screen would otherwise render four times the pixels for
        // grains that are deliberately soft-edged and gain nothing from the resolution.
        dpr={[1, 1.5]}
        frameloop={painting ? "always" : "never"}
        camera={{ position: [0, 0, 6], fov: 55 }}
        gl={{ antialias: false, alpha: true, powerPreference: "low-power" }}
        // The hero paints its own ground and tapestry behind this; the canvas must not fill over them.
        style={{ background: "transparent" }}
      >
        <Pigment count={count} pointerX={pointerX} pointerY={pointerY} />
      </Canvas>
    </div>
  );
}

interface PigmentProps {
  count: number;
  pointerX: MotionValue<number>;
  pointerY: MotionValue<number>;
}

function Pigment({ count, pointerX, pointerY }: PigmentProps) {
  const pointsRef = useRef<Points>(null);

  /**
   * A soft round grain, drawn once into a 64px canvas.
   *
   * Without it `PointsMaterial` draws squares, and a field of squares reads as pixels rather than as
   * pigment. It is a texture rather than a shader because a texture is one upload and no material
   * compilation, and because it costs nothing to dispose correctly.
   */
  const texture = useMemo(() => createGrainTexture(), []);

  const field = useMemo(() => createField(count), [count]);

  const geometry = useMemo(() => {
    const created = new BufferGeometry();
    created.setAttribute("position", field.positionAttribute);
    created.setAttribute("color", field.colorAttribute);
    return created;
  }, [field]);

  const material = useMemo(
    () =>
      new PointsMaterial({
        // Larger than a starfield's grain, because there are half as many and each one is meant to be
        // an individual particle rather than part of a haze.
        size: 0.115,
        sizeAttenuation: true,
        map: texture,
        vertexColors: true,
        transparent: true,
        opacity: 0.72,
        // Additive blending would blow out to white wherever grains overlap, which is exactly what
        // makes a field look like a starfield. Normal blending keeps the pigment reading as pigment.
        blending: NormalBlending,
        // Points have no meaningful depth against each other at this density, and writing depth makes
        // the draw order visible as hard edges where two grains cross.
        depthWrite: false
      }),
    [texture]
  );

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
    [geometry, material, texture]
  );

  useFrame((state, delta) => {
    const elapsed = state.clock.elapsedTime;
    // Clamped, because a tab returning from the background hands over one enormous delta and every
    // grain would jump a third of the way down the hero in a single frame.
    const step = Math.min(delta, MAX_STEP_SECONDS);
    const positions = field.positions;

    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      // Reads off a typed array are `number | undefined` under noUncheckedIndexedAccess; the
      // fallbacks are unreachable and are there so the loop cannot produce NaN if one ever is not.
      const previousY = positions[offset + 1] ?? 0;

      // 0 at the floor of the field, 1 anywhere in its upper reaches. The fall slows as it drops.
      const height = clamp((previousY + SPREAD_Y) / (SPREAD_Y * 1.4), 0, 1);
      const fall = (field.fall[index] ?? 0) * (SETTLED_FALL_SHARE + (1 - SETTLED_FALL_SHARE) * height);

      let y = previousY - fall * step;
      let originX = field.originX[index] ?? 0;

      // Off the bottom: back to the top with a fresh column, so the field never shows the same
      // vertical lane twice. The wrap happens well below the frustum at every depth in the field, so
      // the jump itself is never visible.
      if (y < -SPREAD_Y) {
        y = SPREAD_Y;
        originX = (Math.random() * 2 - 1) * SPREAD_X;
        field.originX[index] = originX;
      }

      // The horizontal drift is a sine on the grain's own phase and its own frequency, so no two
      // grains ever move together — the only shared movement in the field is the parallax below.
      positions[offset] =
        originX + Math.sin(elapsed * (field.swayFreq[index] ?? 0) + (field.phase[index] ?? 0)) * (field.swayAmp[index] ?? 0);
      positions[offset + 1] = y;
    }
    field.positionAttribute.needsUpdate = true;

    const points = pointsRef.current;
    if (!points) return;

    // The whole field slides a little against the pointer. Perspective does the rest: grains nearer
    // the camera travel further across the screen than the ones behind them, so the depth of the
    // field is what the reader perceives rather than the movement itself.
    points.position.x = -pointerX.get() * 0.38;
    points.position.y = pointerY.get() * 0.24;
  });

  return <points ref={pointsRef} geometry={geometry} material={material} />;
}

interface Field {
  /** The attribute three draws from, and the buffer `useFrame` writes into — the same memory. */
  positionAttribute: Float32BufferAttribute;
  positions: Float32Array;
  colorAttribute: Float32BufferAttribute;
  /** Where the grain's column sits. Re-rolled each time the grain wraps to the top. */
  originX: Float32Array;
  swayAmp: Float32Array;
  swayFreq: Float32Array;
  fall: Float32Array;
  phase: Float32Array;
}

/**
 * The grains: where each one hangs, how fast it falls, how far it sways and what colour it is.
 *
 * `Math.random` is safe here because this module never runs on the server — a field that differed
 * between the two renders would be a hydration mismatch, and `ssr: false` is what removes that
 * question entirely.
 *
 * The initial vertical distribution is DELIBERATELY BOTTOM-HEAVY: the field is meant to look as
 * though it has already been settling for a while when the reader arrives, not as though it has just
 * been poured.
 */
function createField(count: number): Field {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const originX = new Float32Array(count);
  const swayAmp = new Float32Array(count);
  const swayFreq = new Float32Array(count);
  const fall = new Float32Array(count);
  const phase = new Float32Array(count);

  const colour = new Color();

  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;

    const x = (Math.random() * 2 - 1) * SPREAD_X;
    // `1 - r²` biases the roll toward the low end of the range, so more grains start near the floor.
    const settledness = 1 - Math.random() * Math.random();
    const y = SPREAD_Y - settledness * SPREAD_Y * 2;
    // Biased toward the back so the near grains — the big, soft, obvious ones — stay a minority.
    const z = -Math.random() * SPREAD_Z * 1.5 + SPREAD_Z * 0.5;

    originX[index] = x;
    positions[offset] = x;
    positions[offset + 1] = y;
    positions[offset + 2] = z;

    swayAmp[index] = 0.05 + Math.random() * 0.16;
    // Radians per second. A grain completes one sway in roughly 45 seconds to two minutes.
    swayFreq[index] = 0.05 + Math.random() * 0.09;
    fall[index] = FALL_MIN + Math.random() * (FALL_MAX - FALL_MIN);
    phase[index] = Math.random() * Math.PI * 2;

    colour.set(pickPigment());
    // Grains further from the camera are dimmed toward the ground rather than merely made smaller.
    // Size attenuation alone leaves the back of the field reading as a flat sheet of confetti.
    const depth = 0.55 + 0.45 * ((z + SPREAD_Z) / (SPREAD_Z * 2.5));
    colors[offset] = colour.r * depth;
    colors[offset + 1] = colour.g * depth;
    colors[offset + 2] = colour.b * depth;
  }

  return {
    positionAttribute: new Float32BufferAttribute(positions, 3),
    positions,
    colorAttribute: new Float32BufferAttribute(colors, 3),
    originX,
    swayAmp,
    swayFreq,
    fall,
    phase
  };
}

/** One dye, chosen against the cumulative weights in `PIGMENTS`. */
function pickPigment(): string {
  const roll = Math.random();
  let running = 0;
  for (const pigment of PIGMENTS) {
    running += pigment.weight;
    if (roll <= running) return pigment.hex;
  }
  // Only reachable if the weights sum to less than 1, which the comment on PIGMENTS forbids. Falling
  // back to indigo keeps the field on-palette rather than throwing over a rounding error.
  return PIGMENTS[0].hex;
}

/** A white radial falloff, used as the grain's shape. White so the per-grain colour is what shows. */
function createGrainTexture(): CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    // A softer shoulder than a plain falloff: the grain has a definite core and a long fade, which is
    // what stops a large point from reading as a blurred circle.
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.3, "rgba(255,255,255,0.72)");
    gradient.addColorStop(0.62, "rgba(255,255,255,0.24)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}
