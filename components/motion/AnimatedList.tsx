"use client";

/**
 * AnimatedList — a list that enters as a stagger and reacts to hover as one organism.
 *
 * Rows come in with the house downward stagger (`staggerParent` releasing `riseItem` children), and
 * on hover the pointed-at row lifts on `SPRING_PRESS` while every sibling dims and shrinks a
 * fraction — the list responds as a group, not as unrelated cells. The group half is what this file
 * adds over `Reveal`; the entrance half is the same vocabulary every other section already speaks.
 *
 * EACH ITEM IS TWO ELEMENTS, AND THE SPLIT IS LOAD-BEARING. The outer `<li>` carries only the
 * entrance variants, orchestrated by the parent's `staggerChildren`; the inner `<div>` carries the
 * hover organism as an `animate` target. They cannot be one element: a motion component with its own
 * `animate` prop stops inheriting the parent's variant state, so a dim target on the staggered
 * element would silently kill the stagger. The split also keeps each transform written by exactly
 * one animation on one element (contract §8's one-writer rule) — entrance `y` on the outside, hover
 * `y`/`scale` on the inside, composing through nesting instead of fighting over a style.
 *
 * Everything animated is a transform or opacity. No height, no width, no layout properties — a row
 * that grows on hover reflows every row below it, which is the opposite of "the list as organism".
 *
 * THE HOVER INDEX IS ORDINARY REACT STATE shared through context: one `useState` in the parent, read
 * by every item. A hovered row re-renders the group, which at showcase sizes (a handful to a couple
 * of dozen rows) is nothing; the `MutationObserver`-backed reduction hook, by contrast, is mounted
 * once here and shared down, rather than once per row.
 *
 * UNDER REDUCED MOTION the entrance collapses inside the factories (zero duration, zero interval,
 * zero displacement — nowhere to forget it), and the hover organism returns PLAIN elements, exactly
 * as `press()` does: no lift, no dim, nothing framer can write. The rows are not left without
 * feedback — their content's own CSS `:hover`/`:focus-visible` colour states are static states and
 * survive (contract §1.4); this whole interaction is the garnish, never the affordance. The pointer
 * handlers detach too, so hovering does not re-render the group for an effect that no longer exists.
 *
 * AND THE READER WHOSE JAVASCRIPT NEVER ARRIVES: the entrance means every row is server-rendered at
 * inline `opacity: 0`, which only `whileInView` — client code — ever clears. So each row is stamped
 * `data-reveal` and ships the same `<noscript>` rescue `Reveal` ships, from inside the row (a
 * sibling would be an extra flex/grid item and would break a `<ul>`'s `:last-child`; see
 * RevealNoScriptRescue's own header).
 *
 * ⚠ `viewport` amount is 0.3 and is NOT height-corrected here (Reveal's `useAchievableAmount` guards
 * Reveal alone). A list taller than ~3.3 viewports can never reach a 0.3 intersection ratio and
 * would stay invisible for ever. Showcase lists are short by construction; do not wrap a long feed
 * in this without rethinking that number.
 */

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction
} from "react";
import { motion, type TargetAndTransition } from "framer-motion";

import { SPRING_PRESS, STAGGER } from "@/components/motion/constants";
import { riseItem, staggerParent } from "@/components/motion/variants";
import { RevealNoScriptRescue } from "@/components/motion/Reveal";
import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";

/** The hovered row's response. The list's own numbers, not `press()`'s: a row is larger than a
 *  button, so the scale is a touch more visible and there is no tap-squash — rows navigate, they
 *  are not pressed. */
const HOVER_LIFT = { scale: 1.02, y: -2 } as const satisfies TargetAndTransition;

/** What every OTHER row does while one is hovered. Dimmed, not hidden: 0.55 keeps the siblings
 *  legible — they recede, the reader is never told they stopped existing. */
const SIBLING_DIM = { opacity: 0.55, scale: 0.98 } as const satisfies TargetAndTransition;

/** Rest, stated in full so a row released from either state above springs back to identity. */
const ITEM_REST = { opacity: 1, scale: 1, y: 0 } as const satisfies TargetAndTransition;

interface AnimatedListContextValue {
  /** Index of the hovered row, or null when the pointer is elsewhere. */
  hovered: number | null;
  /** The raw setter, so an item's pointerleave can clear CONDITIONALLY (see the item). */
  setHovered: Dispatch<SetStateAction<number | null>>;
  /** Read once in the parent and shared, rather than one MutationObserver per row. */
  reduce: boolean;
}

/**
 * A NAMED error, following PreferencesProvider's reasoning: an item that silently read a default
 * context would enter with no stagger and dim nothing, which looks like a taste decision rather
 * than the plumbing mistake it is. The name makes the stack trace answer on sight.
 */
export class AnimatedListContextError extends Error {
  constructor() {
    super(
      "AnimatedListItem was rendered outside an AnimatedList. The group hover state lives in the parent; wrap the items in <AnimatedList>."
    );
    this.name = "AnimatedListContextError";
  }
}

const AnimatedListContext = createContext<AnimatedListContextValue | null>(null);

export interface AnimatedListProps {
  /** The rendered element. `ul` unless the children are not list items. */
  as?: "ul" | "div";
  className?: string;
  children?: ReactNode;
}

export function AnimatedList({ as = "ul", className, children }: AnimatedListProps) {
  const reduce = useReducedMotionPreference();
  const [hovered, setHovered] = useState<number | null>(null);

  const context = useMemo<AnimatedListContextValue>(
    () => ({ hovered, setHovered, reduce }),
    [hovered, setHovered, reduce]
  );

  // The same cast Reveal makes, for the same reason: TypeScript cannot check a JSX call against a
  // union of forwardRef components without collapsing every prop to `never`, and both tags accept
  // everything passed here.
  const Component = motion[as] as typeof motion.ul;

  return (
    <AnimatedListContext.Provider value={context}>
      <Component
        className={className}
        variants={staggerParent(reduce, STAGGER.default)}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, amount: 0.3 }}
        // Belt and braces under the per-item clears: whatever path the pointer takes out of the
        // list — including across a row that unmounted mid-hover — nothing stays dimmed behind it.
        onPointerLeave={() => setHovered(null)}
      >
        {children}
      </Component>
    </AnimatedListContext.Provider>
  );
}

export interface AnimatedListItemProps {
  /** `li` under an `as="ul"` list, `div` otherwise — the markup must agree with the parent's. */
  as?: "li" | "div";
  /** This row's position, which is its identity in the group hover state. */
  index: number;
  className?: string;
  children?: ReactNode;
}

export function AnimatedListItem({ as = "li", index, className, children }: AnimatedListItemProps) {
  const group = useContext(AnimatedListContext);
  if (group === null) throw new AnimatedListContextError();
  const { hovered, setHovered, reduce } = group;

  const dimmed = hovered !== null && hovered !== index;

  const Component = motion[as] as typeof motion.li;

  return (
    <Component
      // What the no-JS rescue keys on — this is the element carrying framer's inline `opacity: 0`.
      data-reveal=""
      className={className}
      variants={riseItem(reduce)}
      // The handlers live on the OUTER element so the whole row — padding included — owns its
      // index, and detach under reduction with the organism they feed.
      onPointerEnter={reduce ? undefined : () => setHovered(index)}
      onPointerLeave={
        reduce
          ? undefined
          : // Conditional, because enter-next can outrun leave-previous when the pointer skips
            // between rows: an unconditional null here would wipe the neighbour's fresh claim.
            () => setHovered((current) => (current === index ? null : current))
      }
    >
      <motion.div
        {...(reduce
          ? // Plain, per press(): under reduction the organism must not exist, not merely slow
            // down, and the content's CSS colour/focus states remain the real affordance.
            {}
          : {
              animate: dimmed ? SIBLING_DIM : ITEM_REST,
              whileHover: HOVER_LIFT,
              transition: SPRING_PRESS
            })}
      >
        {children}
      </motion.div>
      <RevealNoScriptRescue />
    </Component>
  );
}
