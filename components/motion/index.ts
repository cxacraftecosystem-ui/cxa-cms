/**
 * The motion vocabulary, in one import.
 *
 * `import { Reveal, riseItem, STAGGER } from "@/components/motion"` — the barrel exists so a section
 * does not need to know which of six files each piece lives in.
 *
 * NO `"use client"` here, on purpose. constants.ts and variants.ts are plain data and plain functions
 * that a Server Component may legitimately evaluate (a variant object is serialisable and can be
 * handed to a client child as a prop); marking the barrel would drag them across the boundary for no
 * reason. The client components below carry their own directive, which is where it belongs.
 */

export {
  SPRING_ISLAND,
  SPRING_PRESS,
  SPRING_LAYOUT,
  SPRING_SCROLL,
  SPRING_POINTER,
  SPRING_POPOVER,
  SPRING_TOAST,
  EASE_OUT,
  DURATION,
  STAGGER
} from "@/components/motion/constants";

export {
  staggerParent,
  riseItem,
  slideItem,
  fadeItem,
  swapVariants,
  scaleIn,
  press,
  type PressMotion
} from "@/components/motion/variants";

export { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";
export { Reveal, type RevealProps, type RevealTag } from "@/components/motion/Reveal";
export { SmoothScroll, scrollToElement, type ScrollToElementOptions } from "@/components/motion/SmoothScroll";
export { ScrollProgress, type ScrollProgressProps } from "@/components/motion/ScrollProgress";
export { CountUp, type CountUpProps } from "@/components/motion/CountUp";
