"use client";

/**
 * NavSheet — the navigation menu for phones and tablets, and the KEYBOARD ROUTE TO EVERY DESTINATION.
 *
 * That second job is why this file carries a real focus trap and the desktop dropdowns in SiteHeader
 * do not: below `lg` the whole link strip is `display: none`, so this sheet is the only thing in the
 * accessibility tree that lists the site's sections. If a destination cannot be reached from here, it
 * cannot be reached with a keyboard at all.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THREE LAYERS, AND THE SCRIM IS A SIBLING OF THE PANEL — NOT ITS PARENT
 *
 *     overlay   fixed inset-0 z-40, animates opacity only
 *       ├── scrim   absolute inset-0, aria-hidden, click-to-close, `touch-action: none`
 *       └── panel   role="dialog", the scroller, `.nav-sheet`
 *
 * `touch-action: none` on the scrim is what stops a drag on the dark area from panning the page
 * underneath on iOS. Put on an ANCESTOR of the panel — which is the obvious place, and the reason the
 * nesting is spelled out here — the identical declaration cancels the scroll gesture INSIDE the sheet
 * as well, and a menu longer than the screen becomes unreachable on exactly the devices this sheet
 * exists for.
 *
 * THE SCRIM IS z-40, BELOW THE HEADER'S z-50, ON PURPOSE (contract §6). The pill stays lit and
 * clickable above it, which is what makes the hamburger — now showing a cross — the close control a
 * thumb reaches for. Both rungs come off the ladder; neither is invented.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * FOCUS, IN FOUR RULES:
 *
 *  1. On open, focus the first focusable element inside the panel, so the first Tab is inside the
 *     menu rather than somewhere behind it.
 *  2. The key handler is bound to the WINDOW, not the panel. A panel-bound handler only sees keys
 *     pressed while focus is inside it, and focus escapes more often than one expects — a scrim
 *     click, an element that removed itself. Escape has to work from wherever focus actually is. It
 *     is bound in the BUBBLE phase (unlike Dialog's capture-phase handler) so that a popover opened
 *     from the header above can still claim Escape for itself before this sheet sees it.
 *  3. Tab wraps at both ends, and "focus is outside the panel" is treated as "at the far end", so the
 *     first Tab after focus has escaped lands back inside instead of walking the page behind.
 *  4. DISMISSING returns focus to the hamburger; CHOOSING A DESTINATION does not. A link replaces the
 *     page, and dragging focus back to a control in the header afterwards would put a screen-reader
 *     reader at the top of a document they have just left.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpRight, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { isActiveHref, type NavNode } from "@/lib/navigation";
import { DURATION, EASE_OUT, SPRING_ISLAND, useReducedMotionPreference } from "@/components/motion";
import { useScrollLock } from "@/components/ui/useScrollLock";
// Reused rather than redefined: Dialog's comment calls this "one definition shared by every overlay",
// and a sheet that disagreed with a dialog about what "the last focusable element" is would hand the
// two traps different ends of the same tab order.
import { focusableWithin } from "@/components/ui/Dialog";

/**
 * The attributes an external destination needs, in one place.
 *
 * `noopener` is the security half (the opened page cannot reach back through `window.opener`) and
 * `noreferrer` the privacy half. Imported by SiteHeader so the two menus cannot disagree about what
 * "external" means. Every use is paired with a spoken "(opens in a new tab)" — a reader whose focus
 * lands in a new tab with no warning has lost their place and their Back button with it.
 */
export const EXTERNAL_LINK_PROPS = { target: "_blank", rel: "noopener noreferrer" } as const;

export interface NavSheetProps {
  open: boolean;
  /** The panel's DOM id, so the hamburger can point `aria-controls` at it while it is mounted. */
  id: string;
  /** Already filtered by the feature flags — the sheet renders exactly what it is given. */
  items: NavNode[];
  /** From `resolveActiveHref`. Drives the visual active state on every row. */
  activeBase: string | null;
  /** The id of the ONE node allowed to carry `aria-current="page"`. See SiteHeader. */
  currentId: string | null;
  /** Escape, the scrim, the close button — anything that leaves the reader on this page. */
  onDismiss: () => void;
  /** A destination was chosen. The page is about to be replaced. */
  onNavigate: () => void;
  /** Focused when the sheet is dismissed. The hamburger. */
  returnFocusRef: RefObject<HTMLElement | null>;
}

export function NavSheet(props: NavSheetProps) {
  // The surface is mounted only while the sheet is open, which is what ties the scroll lock and the
  // focus trap to its lifetime — including the exit animation. `initial` is left on (unlike the
  // header's link strip) because this surface can only ever appear after an interaction; there is no
  // prerendered first paint for its entrance to disagree with.
  return <AnimatePresence>{props.open ? <NavSheetSurface {...props} /> : null}</AnimatePresence>;
}

function NavSheetSurface({
  id,
  items,
  activeBase,
  currentId,
  onDismiss,
  onNavigate,
  returnFocusRef
}: NavSheetProps) {
  const reduce = useReducedMotionPreference();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [leaving, setLeaving] = useState(false);

  /**
   * Held for as long as the surface is mounted, so the scrollbar does not come back — jumping every
   * centred element on the page sideways — while the sheet is still fading out.
   *
   * ⚠ WITH ONE EXCEPTION: A DESTINATION HAS BEEN CHOSEN. `unlockScroll()` restores the offset it
   * recorded, and useScrollLock.ts states the constraint in its own header — an overlay that navigates
   * while still mounted fights the router's own scroll restoration. This surface does navigate while
   * mounted: `SheetLink` does not `preventDefault()`, so `next/link` pushes the route in the same
   * click, while `AnimatePresence` keeps the panel alive for the whole `SPRING_ISLAND` exit. Half a
   * second later the new page would be yanked back to the OLD page's offset — a reader who tapped
   * "Publications" from 1200px down `/research` lands mid-list on a page they have never scrolled.
   *
   * So the lock is dropped at the moment of the click instead, while the reader is demonstrably still
   * on the old page at the offset that was recorded: the restore becomes a no-op and the router's own
   * reset is the last word. The gutter comes back a few hundred milliseconds early on a navigation,
   * which is a shift on a page that is being replaced anyway — the cheaper of the two faults.
   */
  useScrollLock(!leaving);

  /** A destination was chosen. See the note on the lock above; the panel still animates out. */
  const navigate = useCallback(() => {
    setLeaving(true);
    onNavigate();
  }, [onNavigate]);

  const dismiss = useCallback(() => {
    // Focus moves BEFORE the close, while the hamburger is still what the reader came from and while
    // this panel is still mounted; letting the panel unmount first drops focus onto <body>.
    // `preventScroll`, because the scroll lock is about to restore the page position and a
    // focus-induced scroll would immediately undo it.
    returnFocusRef.current?.focus({ preventScroll: true });
    onDismiss();
  }, [onDismiss, returnFocusRef]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const first = focusableWithin(panel)[0];
    (first ?? panel).focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Tab") return;

      if (event.key === "Escape") {
        event.preventDefault();
        // Stopped here so one Escape cannot also close something this sheet is rendered inside
        // (contract §14).
        event.stopPropagation();
        dismiss();
        return;
      }

      const panel = panelRef.current;
      if (!panel) return;

      const focusables = focusableWithin(panel);
      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      // A panel with nothing focusable in it still must not leak focus to the page behind.
      if (!first || !last) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }

      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);

      if (event.shiftKey) {
        if (!inside || active === first || active === panel) {
          event.preventDefault();
          last.focus();
        }
        return;
      }

      if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // Bubble phase, on the window: see rule 2 in the file header.
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dismiss]);

  return (
    <motion.div
      // `.overlay-frame` re-pays `var(--scroll-gutter)`: this element is `position: fixed`, so its
      // containing block is the viewport and the padding the scroll lock puts on <body> cannot reach
      // it (contract §6).
      className="nav-sheet-overlay overlay-frame fixed inset-0 z-40"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduce ? 0 : DURATION.scrim, ease: EASE_OUT }}
    >
      <div
        aria-hidden="true"
        onClick={dismiss}
        // Inline, not a utility class: `touch-action` has no Tailwind equivalent that would survive
        // the plain-join `cn()` next to another `touch-*` class, and this declaration must land on
        // THIS element and no ancestor (see the file header).
        style={{ touchAction: "none" }}
        className="absolute inset-0 cursor-pointer bg-ink-900/50 backdrop-blur-sm"
      />

      <motion.div
        ref={panelRef}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        tabIndex={-1}
        // The `initial` state does NOT branch on the motion preference. On a prerendered public page
        // an initial that differs between the server and the first client render flashes; reduction
        // collapses the DURATION instead, so the panel is placed rather than slid (contract §8).
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={reduce ? { duration: 0 } : SPRING_ISLAND}
        // The width is a single arbitrary value rather than horizontal padding on the overlay,
        // because `cn()` is a plain join and a `px-*` utility on the overlay would out-specify
        // `.overlay-frame` and silently take the scroll-gutter payment with it. `.nav-sheet` owns the
        // height ceiling, the overflow and the safe-area padding.
        className="nav-sheet relative mx-auto w-[min(100%-1.5rem,42rem)] rounded-lg border border-line-200 bg-card shadow-cinema outline-none"
      >
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.id}>
              <SheetLink
                node={item}
                level="parent"
                activeBase={activeBase}
                currentId={currentId}
                onNavigate={navigate}
              />

              {item.children.length > 0 ? (
                // Every child is shown, always. An accordion here would hide destinations behind a
                // second tap on the one surface that is meant to list all of them, and a collapsed
                // section is indistinguishable from a section with nothing in it.
                <ul className="mb-1 ml-4 mt-1 flex flex-col gap-0.5 border-l border-line-200 pl-3">
                  {item.children.map((child) => (
                    <li key={child.id}>
                      <SheetLink
                        node={child}
                        level="child"
                        activeBase={activeBase}
                        currentId={currentId}
                        onNavigate={navigate}
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>

        {/*
          A second way out, at the end of the list.

          Escape closes the sheet from anywhere, but Escape is knowledge a reader either has or does
          not, and the focus trap wraps rather than releasing — so the last element in the tab order
          is a control that closes rather than another destination. On a tall phone it is also simply
          the nearest thing to a thumb that has scrolled to the bottom.
        */}
        <button
          type="button"
          onClick={dismiss}
          className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-line-200 bg-surface-50 px-4 py-2 text-sm font-medium text-ink-700 transition hover:bg-surface-100 hover:text-ink-900"
        >
          <X aria-hidden="true" className="h-4 w-4" />
          Close menu
        </button>
      </motion.div>
    </motion.div>
  );
}

interface SheetLinkProps {
  node: NavNode;
  level: "parent" | "child";
  activeBase: string | null;
  currentId: string | null;
  onNavigate: () => void;
}

/** Complete literal class strings — a name assembled by concatenation is purged (contract §5). */
const SHEET_LINK_BASE =
  "flex min-h-11 items-center justify-between gap-3 rounded-md px-3 py-2.5 transition";

const SHEET_LINK_LEVEL: Record<"parent" | "child", string> = {
  parent: "font-display text-base font-semibold tracking-tight",
  child: "text-sm"
};

function SheetLink({ node, level, activeBase, currentId, onNavigate }: SheetLinkProps) {
  const active = isActiveHref(node.href, activeBase);

  const className = cn(
    SHEET_LINK_BASE,
    SHEET_LINK_LEVEL[level],
    active
      ? "bg-purple-700/10 text-ink-900 ring-1 ring-purple-600/20"
      : "text-ink-700 hover:bg-surface-100 hover:text-ink-900"
  );

  const body = (
    <>
      <span className="min-w-0 flex-1 truncate">{node.label}</span>
      {node.isExternal ? (
        <>
          <ArrowUpRight aria-hidden="true" className="h-4 w-4 shrink-0 text-ink-500" />
          <span className="sr-only">(opens in a new tab)</span>
        </>
      ) : null}
    </>
  );

  // A bare close, with no focus restoration: the page is being replaced (see rule 4). No
  // `preventDefault()` either — `next/link` must push the route in this same click — which is why the
  // surface's `onNavigate` also lets go of the scroll lock here rather than at unmount.
  const handleClick = () => onNavigate();

  if (node.isExternal) {
    // A plain anchor, not `next/link`: routing another origin through the client router adds prefetch
    // machinery to a navigation that is leaving the application anyway.
    return (
      <a href={node.href} {...EXTERNAL_LINK_PROPS} onClick={handleClick} className={className}>
        {body}
      </a>
    );
  }

  return (
    <Link
      href={node.href}
      onClick={handleClick}
      // At most ONE element in the document carries this, decided once in SiteHeader. Two links
      // marked current tell a screen reader the reader is in two places at once.
      aria-current={node.id === currentId ? "page" : undefined}
      className={className}
    >
      {body}
    </Link>
  );
}
