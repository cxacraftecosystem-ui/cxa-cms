"use client";

/**
 * Tooltip — a short label on hover AND on focus.
 *
 * ⚠ A TOOLTIP IS UNREACHABLE ON A TOUCH SCREEN. There is no hover on a phone and a tap is a click, so
 * roughly half of this product's readers will never see one. **Nothing may exist only in a tooltip.**
 * If the information is needed to use the control — what a button does, why it is unavailable, what a
 * field expects — it belongs in visible text, a `<label>`, an inline hint or the empty state. A
 * tooltip is for the extra sentence a mouse user gets for free, never for the sentence that makes the
 * screen make sense.
 *
 * DELAY ON OPEN, NONE ON CLOSE — and no delay at all on focus. The delay exists to stop a row of
 * icon buttons flashing labels as the pointer sweeps across them; a keyboard reader who deliberately
 * moved focus here has already expressed the intent the delay is waiting for. Closing is instant
 * because a label that lingers over the control the reader has moved on to is in the way.
 *
 * The bubble is `pointer-events-none`, so it can never swallow a click meant for the control beside
 * it, and Escape dismisses it while it is open (WCAG 1.4.13).
 *
 * `aria-describedby` is cloned ONTO THE CHILD, because a description must sit on the focusable
 * element itself — a wrapper carrying it describes nothing. The child therefore must be a single
 * element that forwards props to the DOM; a bare string still gets the visual bubble, but no
 * announcement. An existing `aria-describedby` on the child is replaced, not merged.
 */

import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode
} from "react";
import { AnimatePresence, motion } from "framer-motion";

import { cn } from "@/lib/utils";
import { DURATION, EASE_OUT, useReducedMotionPreference } from "@/components/motion";

export type TooltipSide = "top" | "bottom" | "left" | "right";

export interface TooltipProps {
  /** One short phrase. If it needs two sentences, it is not a tooltip. */
  content: ReactNode;
  children: ReactNode;
  side?: TooltipSide;
  /** Milliseconds before a hovered tooltip appears. Focus ignores it. */
  delay?: number;
  /** Turns the tooltip off without changing the markup around it — for a control whose label is enough. */
  disabled?: boolean;
  /** Applied to the inline wrapper, not the bubble. */
  className?: string;
}

/**
 * Complete literal class strings (contract §5). The translate here is on the POSITIONER, never on the
 * animated element: framer writes an inline `transform` and a `-translate-x-1/2` class would lose to
 * it, dropping the bubble half its own width off-centre (contract §8).
 */
const SIDE_CLASS: Record<TooltipSide, string> = {
  top: "bottom-full left-1/2 mb-2 -translate-x-1/2",
  bottom: "top-full left-1/2 mt-2 -translate-x-1/2",
  left: "right-full top-1/2 mr-2 -translate-y-1/2",
  right: "left-full top-1/2 ml-2 -translate-y-1/2"
};

const OFFSET: Record<TooltipSide, { x: number; y: number }> = {
  top: { x: 0, y: 4 },
  bottom: { x: 0, y: -4 },
  left: { x: 4, y: 0 },
  right: { x: -4, y: 0 }
};

/** Long enough to cross an icon row without firing, short enough not to feel broken. */
const DEFAULT_DELAY = 350;

export function Tooltip({
  content,
  children,
  side = "top",
  delay = DEFAULT_DELAY,
  disabled = false,
  className
}: TooltipProps) {
  const reduce = useReducedMotionPreference();
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  useEffect(() => clearTimer, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Not stopped: dismissing a tooltip is not a reason to swallow the key a dialog behind it may
      // also be waiting for.
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const show = (immediate: boolean) => {
    if (disabled) return;
    clearTimer();
    if (immediate || delay <= 0) {
      setOpen(true);
      return;
    }
    timer.current = window.setTimeout(() => setOpen(true), delay);
  };

  const hide = () => {
    clearTimer();
    setOpen(false);
  };

  const visible = open && !disabled;

  const trigger = isValidElement<{ "aria-describedby"?: string }>(children)
    ? cloneElement(children, { "aria-describedby": visible ? tooltipId : undefined })
    : children;

  const offset = OFFSET[side];

  return (
    <span
      className={cn("relative inline-flex", className)}
      onPointerEnter={(event) => {
        // Touch and pen raise a pointerenter that never leaves, stranding the bubble on screen.
        if (event.pointerType !== "mouse") return;
        show(false);
      }}
      onPointerLeave={hide}
      // React's onFocus/onBlur are focusin/focusout and bubble, so the child's focus reaches here.
      onFocus={(event) => {
        // Only a keyboard-ish focus. A click already focuses the control and does not want a label
        // hovering over what was just pressed.
        if (event.target instanceof Element && !event.target.matches(":focus-visible")) return;
        show(true);
      }}
      onBlur={hide}
    >
      {trigger}

      <AnimatePresence>
        {visible ? (
          <span
            className={cn(
              "pointer-events-none absolute z-10 block w-max max-w-[16rem]",
              SIDE_CLASS[side]
            )}
          >
            <motion.span
              role="tooltip"
              id={tooltipId}
              initial={reduce ? { opacity: 0 } : { opacity: 0, x: offset.x, y: offset.y }}
              animate={{ opacity: 1, x: 0, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduce ? 0 : DURATION.scrim, ease: EASE_OUT }}
              className="block rounded-md bg-ink-900 px-2.5 py-1.5 text-xs font-medium leading-snug text-bg-0 shadow-md"
            >
              {content}
            </motion.span>
          </span>
        ) : null}
      </AnimatePresence>
    </span>
  );
}
