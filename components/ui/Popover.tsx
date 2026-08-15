"use client";

/**
 * Popover — an anchored floating panel, measured against the viewport and portalled out of the flow.
 *
 * It is portalled because an anchored panel that stays in the DOM where it was written gets clipped
 * by the first ancestor with `overflow: hidden` — which, in a studio, is every table and every card.
 *
 * WHERE IT PORTALS DEPENDS ON WHETHER IT IS INSIDE A DIALOG. Outside one it goes to `<body>` at z-70.
 * Inside one it goes to that dialog's own fixed wrapper (`[data-dialog]`) at z-50 — a rung INSIDE the
 * dialog's stacking context, above the panel. Portalling to the body from inside a dialog would put
 * the popover at 70 while the dialog sits at 100: the panel would open behind the surface that owns
 * it. The dialog wrapper is deliberately the portal target rather than the animated panel, because
 * framer writes a `transform` onto the panel and a transformed ancestor becomes the containing block
 * for `position: fixed`, which would silently re-base every coordinate measured here.
 *
 * PLACEMENT IS MEASURED IN A LAYOUT EFFECT, before paint. There is deliberately NO `visibility:
 * hidden` measuring pass: a hidden element cannot take focus, so the first Tab into a menu measured
 * that way goes nowhere. The entrance already starts at `opacity: 0`, so the frame in which the panel
 * has not been placed yet is a frame in which it is invisible.
 *
 * FLIPPING NEEDS BOTH CONDITIONS — the panel must not fit below AND there must be more room above.
 * Testing only "does it fit below" throws the panel upward on a short viewport where it does not fit
 * in either direction, which is worse: at least downward it can scroll into the space that exists.
 *
 * THE LAST PLACEMENT IS NEVER CLEARED ON CLOSE. The exit animation keeps the panel mounted after
 * `open` goes false; a placement reset to null falls back to top/left 0 and the panel visibly flies
 * into the top-left corner as it fades.
 *
 * ONLY A USER SCROLL OR A WIDTH CHANGE MAY CLOSE IT. A `ResizeObserver` may only MOVE it. Running the
 * close check on every reposition made a popover dismiss itself a few hundred milliseconds after
 * opening, as its own content settled. A height-only resize is the mobile keyboard or the address bar
 * and must not close a panel the reader is typing into.
 *
 * IT DELIBERATELY DOES NOT TRAP FOCUS. A picker that swallows the keyboard is worse than the
 * `<select>` it replaces. Only the two ends of the tab order are intercepted: stepping off either end
 * closes the panel and returns focus to the anchor, so the reader continues from where they were.
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";

import { clamp, cn } from "@/lib/utils";
import { SPRING_POPOVER, useReducedMotionPreference } from "@/components/motion";
import { focusableWithin } from "@/components/ui/Dialog";

/** Breathing room between the panel and both the anchor and the edge of the viewport. */
const GUTTER = 8;

/**
 * A panel is never squeezed below this. On a short viewport the honest answer is a panel that
 * overflows and scrolls internally, not a 40px letterbox that shows one and a half rows.
 */
const MIN_PANEL_HEIGHT = 220;

/** The ladder rung for a popover portalled to `<body>` (contract §6). */
export const POPOVER_Z = 70;
/** Inside a dialog the rung is relative to the dialog's own stacking context. */
export const POPOVER_IN_DIALOG_Z = 50;

export type PopoverSide = "top" | "bottom";
export type PopoverAlign = "start" | "center" | "end";

export interface PopoverProps {
  open: boolean;
  /** Called for Escape, a pointer outside, a user scroll, a width change and stepping off either tab end. */
  onClose: () => void;
  /** The element the panel is measured against. Usually the trigger button. */
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  /** Preferred side. Flipped only when the panel does not fit AND the other side has more room. */
  side?: PopoverSide;
  align?: PopoverAlign;
  /** Menus pass "menu", pickers "listbox". The default suits a panel of ordinary controls. */
  role?: "dialog" | "menu" | "listbox" | "group";
  /** Give the panel a name. One of these is required for anything with `role="dialog"`. */
  label?: string;
  labelledBy?: string;
  /**
   * Put an id on the PANEL. A trigger's `aria-controls` must point at the element carrying the role,
   * and a wrapper inside the panel would sit between `role="menu"` and its `role="menuitem"` children.
   */
  id?: string;
  /** Match the anchor's width — what a select-like control wants, and nothing else does. */
  matchAnchorWidth?: boolean;
  /** A fixed panel width in pixels. Without it the panel is sized by its own content. */
  width?: number;
  className?: string;
  /** Exposes the panel node, for a caller that manages focus inside it (see DropdownMenu). */
  panelRef?: RefObject<HTMLDivElement | null>;
  /**
   * Runs BEFORE the panel's own Tab handling. A caller that owns the keyboard inside the panel — a
   * menu with arrow keys, a listbox — calls `preventDefault()` to say it has dealt with the key.
   */
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

interface Placement {
  top: number;
  left: number;
  width: number | undefined;
  maxHeight: number;
  side: PopoverSide;
}

/**
 * `useLayoutEffect` warns when a client component is rendered on the server, and every component in
 * this folder is. Effects never run on the server, so the two are equivalent there.
 */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Only the topmost popover reacts to Escape; two window listeners in the same phase both fire. */
const popoverStack: string[] = [];

const ORIGIN_X: Record<PopoverAlign, string> = {
  start: "left",
  center: "center",
  end: "right"
};

export function Popover({
  open,
  onClose,
  anchorRef,
  children,
  side = "bottom",
  align = "start",
  role = "dialog",
  label,
  labelledBy,
  id,
  matchAnchorWidth = false,
  width,
  className,
  panelRef: exposedPanelRef,
  onKeyDown
}: PopoverProps) {
  const reduce = useReducedMotionPreference();
  const instanceId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  // The callback is held in a ref and reached through a stable wrapper, so the scroll and pointer
  // listeners below are registered ONCE per open. With `onClose` in their dependencies, an inline
  // arrow from the caller would tear them down and rebuild them on every render — and rebuild the
  // "ignore the first frame" guard with them, which is how a popover ends up unable to close at all.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  const close = useCallback(() => onCloseRef.current(), []);

  // Decide the portal target from the anchor's position in the tree, not from where this component
  // was written: the same Popover is used inside dialogs and out.
  useIsomorphicLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const dialog = anchor?.closest<HTMLElement>("[data-dialog]") ?? null;
    setContainer(dialog ?? document.body);
  }, [open, anchorRef]);

  const insideDialog = container !== null && container.hasAttribute("data-dialog");
  const zIndex = insideDialog ? POPOVER_IN_DIALOG_Z : POPOVER_Z;

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;

    const rect = anchor.getBoundingClientRect();
    // `clientWidth` on the root excludes the scrollbar; `innerWidth` would include it and push every
    // right-aligned panel under it.
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;

    const panelWidth = matchAnchorWidth ? rect.width : (width ?? panel.offsetWidth);
    const panelHeight = panel.offsetHeight;

    const roomBelow = viewportHeight - rect.bottom - GUTTER;
    const roomAbove = rect.top - GUTTER;

    let resolvedSide: PopoverSide = side;
    if (side === "bottom" && panelHeight > roomBelow && roomAbove > roomBelow) resolvedSide = "top";
    if (side === "top" && panelHeight > roomAbove && roomBelow > roomAbove) resolvedSide = "bottom";

    const room = resolvedSide === "top" ? roomAbove : roomBelow;
    const maxHeight = Math.max(MIN_PANEL_HEIGHT, room);

    const top =
      resolvedSide === "top"
        ? Math.max(GUTTER, rect.top - GUTTER - Math.min(panelHeight, maxHeight))
        : rect.bottom + GUTTER;

    let left = rect.left;
    if (align === "end") left = rect.right - panelWidth;
    if (align === "center") left = rect.left + rect.width / 2 - panelWidth / 2;
    left = clamp(left, GUTTER, Math.max(GUTTER, viewportWidth - panelWidth - GUTTER));

    const next: Placement = {
      // Rounded, because a subpixel difference between two measurements of the same position would
      // make the ResizeObserver below re-render forever.
      top: Math.round(top),
      left: Math.round(left),
      width: matchAnchorWidth ? Math.round(rect.width) : width,
      maxHeight: Math.round(maxHeight),
      side: resolvedSide
    };

    setPlacement((current) =>
      current !== null &&
      current.top === next.top &&
      current.left === next.left &&
      current.width === next.width &&
      current.maxHeight === next.maxHeight &&
      current.side === next.side
        ? current
        : next
    );
  }, [align, anchorRef, matchAnchorWidth, side, width]);

  // Measure before paint, then keep the panel WHERE IT BELONGS as it and the anchor change size. The
  // observer only ever moves it — closing here is what made popovers dismiss themselves.
  useIsomorphicLayoutEffect(() => {
    if (!open || !container) return;
    reposition();

    const observer = new ResizeObserver(() => reposition());
    const panel = panelRef.current;
    const anchor = anchorRef.current;
    if (panel) observer.observe(panel);
    if (anchor) observer.observe(anchor);
    return () => observer.disconnect();
  }, [open, container, reposition, anchorRef]);

  // The stack, the outside-press listener and the scroll listener are all keyed on `open` rather than
  // on the panel's presence, because AnimatePresence keeps the panel mounted through its exit with
  // the props it had when it left — it would still look open to anything reading its markup.
  useEffect(() => {
    if (!open) return;
    popoverStack.push(instanceId);
    return () => {
      const index = popoverStack.lastIndexOf(instanceId);
      if (index !== -1) popoverStack.splice(index, 1);
    };
  }, [open, instanceId]);

  // `data-floating-layer` is what tells an enclosing Dialog that something on top of it owns Escape
  // and the tab order. Set imperatively for the same reason: the declarative prop would survive the
  // exit animation and go on claiming the keyboard for a panel that is already leaving. `container`
  // is in the dependencies because on the FIRST open the portal target takes one extra commit to
  // resolve, and the panel does not exist yet when `open` alone changes.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (open) panel.setAttribute("data-floating-layer", "");
    else panel.removeAttribute("data-floating-layer");
  }, [open, container]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (popoverStack[popoverStack.length - 1] !== instanceId) return;
      event.preventDefault();
      // Stopped so one Escape does not also close the dialog or the nav sheet this panel is inside.
      event.stopPropagation();
      close();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, instanceId, close]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      // The anchor is excluded so a trigger that toggles does not close here and reopen in its own
      // click handler, which reads as a panel that refuses to shut.
      if (anchorRef.current?.contains(target)) return;
      close();
    };

    // Capture, so a control elsewhere that stops propagation cannot strand the panel open.
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, anchorRef, close]);

  useEffect(() => {
    if (!open) return;

    // The panel's own entrance can shift layout by a pixel and some browsers report that as a scroll.
    // Nothing may close the popover until the frame after it opened.
    let ready = false;
    const frame = window.requestAnimationFrame(() => {
      ready = true;
    });
    let lastWidth = window.innerWidth;

    const onScroll = (event: Event) => {
      if (!ready) return;
      const target = event.target;
      // Scrolling the panel's own list is not a reason to take the list away.
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      close();
    };

    const onResize = () => {
      if (!ready) return;
      if (window.innerWidth === lastWidth) {
        // Height only: the on-screen keyboard, or a mobile address bar sliding away. Move, do not close.
        reposition();
        return;
      }
      lastWidth = window.innerWidth;
      close();
    };

    // Capture, so a scroll inside any container on the page is seen — scroll events do not bubble.
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, close, reposition]);

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;

    const items = focusableWithin(panel);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;

    const active = document.activeElement;
    const leaving = event.shiftKey ? active === first : active === last;
    if (!leaving) return;

    // Not a trap: the panel closes and hands focus back to the anchor, which is where the reader's
    // place in the tab order actually is.
    event.preventDefault();
    close();
    anchorRef.current?.focus({ preventScroll: true });
  };

  if (!container) return null;

  const resolvedSide = placement?.side ?? side;

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          ref={(node) => {
            panelRef.current = node;
            if (exposedPanelRef) exposedPanelRef.current = node;
          }}
          data-popover
          id={id}
          role={role}
          aria-label={label}
          aria-labelledby={labelledBy}
          tabIndex={-1}
          onKeyDown={onPanelKeyDown}
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: resolvedSide === "top" ? 4 : -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
          // One stiff spring for the whole entrance. A menu that eases open is a menu you wait for.
          transition={reduce ? { duration: 0 } : SPRING_POPOVER}
          style={{
            position: "fixed",
            // Before the first measurement this is 0,0 — invisible, because the entrance starts at
            // opacity 0 and the layout effect above lands before paint.
            top: placement?.top ?? 0,
            left: placement?.left ?? 0,
            width: placement?.width,
            maxHeight: placement?.maxHeight,
            zIndex,
            // Growing from the edge nearest the anchor is what makes the panel read as belonging to it.
            transformOrigin: `${ORIGIN_X[align]} ${resolvedSide === "top" ? "bottom" : "top"}`
          }}
          className={cn(
            "overflow-y-auto overscroll-contain rounded-lg border border-line-200 bg-card p-1.5 shadow-panel outline-none",
            className
          )}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>,
    container
  );
}
