"use client";

/**
 * StudioShell — the frame every studio screen sits inside.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IT OWNS, AND WHY EACH PIECE IS HERE RATHER THAN IN A PAGE:
 *
 *   1. THE SKIP LINK, FIRST IN TAB ORDER. Nineteen destinations sit between the top of the document
 *      and the table an administrator came to edit. Without it, reaching a row by keyboard costs
 *      twenty-odd Tab presses on every navigation.
 *   2. THE SIDEBAR, in two shapes: pinned from `lg` up, a slide-over below it. One component, one
 *      registry, so the two can never offer different destinations.
 *   3. THE COLLAPSE PREFERENCE, in `localStorage` INSIDE A try/catch. `localStorage` THROWS — not
 *      returns null — when a browser blocks storage (Safari private browsing, a locked-down managed
 *      profile). An unguarded read here would throw during the shell's first effect and leave the
 *      whole CMS unrendered because somebody's browser will not remember a sidebar width.
 *   4. NO SmoothScroll, NO ToastProvider, NO PreferencesProvider. Lenis makes landing on a table row
 *      feel broken; the other two are mounted once in `app/layout.tsx`, and a nested copy shadows the
 *      real one — a second toast viewport announces every notice twice and can open behind the first.
 *
 * THE SLIDE-OVER IS A REAL MODAL, SO IT CARRIES A REAL FOCUS TRAP. It declares `role="dialog"` and
 * `aria-modal`, which is an instruction to a screen reader to ignore everything behind it — so Tab must
 * not be able to leave. Four rules, the same four `components/site/NavSheet.tsx` states for the public
 * site's menu, because a studio panel and a public panel that disagreed about where the tab order ends
 * would be two traps to maintain and one of them would rot:
 *
 *   1. Focus moves INTO the panel on open, so the first Tab is inside the menu rather than past it.
 *   2. Tab wraps at both ends, and "focus is somewhere outside the panel" counts as being at the far
 *      end — so the first Tab after focus has escaped lands back inside instead of walking a page the
 *      reader's software has been told to ignore, announcing nothing.
 *   3. Escape closes the sheet and returns focus to the hamburger that opened it.
 *   4. The key handler is on the WINDOW, not the panel. A panel-bound handler only sees keys pressed
 *      while focus is inside it, and focus escapes more often than one expects — a scrim click, a
 *      control that removed itself. Escape has to work from wherever focus actually is.
 *
 * `focusableWithin` comes from `components/ui/Dialog`, so this sheet, that sheet and every dialog agree
 * about which element is "the last focusable one".
 *
 * ⚠ A DIALOG ON TOP OWNS BOTH KEYS, AND THIS SHEET STANDS DOWN WHILE ONE IS OPEN. `Dialog` sits at rung
 * 100, above this sheet at 50, and binds the same two keys to the window in the same phase — where
 * `stopPropagation()` does NOT stop another listener on the same target. Without the check below, one
 * Escape would close a confirm dialog AND the menu underneath it, and Tab inside that dialog would be
 * dragged out into the panel behind it.
 *
 * MOTION IS CONFINED TO WHAT CARRIES MEANING. The slide-over slides because a panel arriving from the
 * left edge is what tells you where it came from and how to dismiss it. Nothing else here animates:
 * no reveal on the sidebar, no fade on the main region. An administrator hitting a row must land on it
 * immediately.
 *
 * THE PADDING-LEFT SWITCH IS NOT TRANSITIONED ON FIRST PAINT. The stored width is only knowable after
 * mount, so the server always renders the expanded column. Animating the correction would show every
 * reader who collapsed their sidebar a 220ms slide on every single page load; `ready` holds the
 * transition back until after the correction has landed, so the first paint is simply right.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE FRAME DOES NOT PRINT, AND UNTIL NOW THERE WAS NOTHING FOR THE PRINT STYLESHEET TO HOLD ON TO
 *
 * Administrators print from the CMS: a table of pending inquiries to work through away from the desk,
 * a record to check against a PDF. Two things here would otherwise end up on the paper.
 *
 *   • THE PINNED SIDEBAR IS `position: fixed`, so it paints once over the FIRST sheet with the content
 *     underneath it — nineteen navigation links stamped across whatever the reader actually wanted.
 *   • THE CONTENT COLUMN PAYS THE SIDEBAR'S WIDTH as `lg:pl-64`, so 16rem of the paper goes on a
 *     gutter for a column that is no longer there.
 *
 * ⚠ AND BOTH ARE INTERMITTENT, WHICH IS WHY THEY SURVIVED. Each is behind `lg` (1024px = 270.9mm of
 * content), and a print lays out against the PAGE BOX rather than the window: at the 16mm margins
 * globals.css asks for, A4 portrait is 178mm and A4 landscape 265mm, so on ordinary paper the query
 * does not match and the sheet looks right. It matches once the page box passes about 303mm — A3 or
 * Tabloid landscape, or, realistically, A4 LANDSCAPE WITH MARGINS SET TO NONE, which overrides `@page`
 * and lifts it to 297mm ≈ 1122px. Landscape with tight margins is precisely what somebody printing a
 * wide studio table picks. So the fault is absent on the default sheet and certain on the sheet this
 * content asks for, which is the worst of both.
 *
 * `data-studio-chrome` and `data-studio-frame` are the hooks, and they are attributes rather than
 * classes for the reason every selector in that stylesheet is: the classes here are the two literal
 * `lg:pl-*` strings the comment below insists must stay literal, and a redesign moves them. The
 * matching rules are group 13 of the print block in app/globals.css, which carries the other half of
 * this note. The top bar deliberately keeps printing — its controls are already removed as
 * `button[type="button"]`, and its derived breadcrumb is the only thing on the sheet that says which
 * screen it came from.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { cn } from "@/lib/utils";
import type { SessionUser } from "@/lib/auth/current-user";
import { DURATION, EASE_OUT, SPRING_ISLAND, useReducedMotionPreference } from "@/components/motion";
import { useScrollLock } from "@/components/ui/useScrollLock";
// Reused rather than redefined: Dialog's comment calls this "one definition shared by every overlay",
// and a sheet that disagreed with a dialog about what "the last focusable element" is would hand the
// two traps different ends of the same tab order.
import { focusableWithin } from "@/components/ui/Dialog";
import { visibleStudioNav } from "@/components/studio/StudioNav";
import { StudioSidebar } from "@/components/studio/StudioSidebar";
import { StudioTopBar } from "@/components/studio/StudioTopBar";

/**
 * The stored preference key.
 *
 * Namespaced, because this is the same origin as the public site and an unprefixed "sidebar" would be
 * a name any future script could collide with. The VALUES are the words "collapsed" and "expanded"
 * rather than "true"/"1": a stray value read back from an old release then fails the comparison and
 * falls through to the default instead of being coerced into a truthy surprise.
 */
const SIDEBAR_STORAGE_KEY = "cxa.studio.sidebar";

function readStoredCollapsed(): boolean | null {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (raw === "collapsed") return true;
    if (raw === "expanded") return false;
    return null;
  } catch {
    // Storage is blocked. Not an error worth showing anybody: the sidebar simply opens expanded every
    // time, which is the default and perfectly usable.
    return null;
  }
}

function writeStoredCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? "collapsed" : "expanded");
  } catch {
    // Blocked, or the quota is full. The width still changed on screen; only remembering it failed,
    // and telling somebody about that would be noise attached to a control that visibly worked.
  }
}

export interface StudioShellProps {
  /** The authoritative user, read from the database in app/studio/layout.tsx. */
  user: SessionUser;
  children: ReactNode;
}

export function StudioShell({ user, children }: StudioShellProps) {
  const pathname = usePathname();
  const reduce = useReducedMotionPreference();
  const sheetId = useId();

  // ONE call, in one place. The sidebar and the top bar's jump-to panel both receive this exact tree,
  // so an entry hidden from one cannot reappear in the other.
  const sections = useMemo(() => visibleStudioNav(user), [user]);

  const [collapsed, setCollapsed] = useState(false);
  const [ready, setReady] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  const navTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);

  // Held for as long as the sheet is open. The hook reference-counts at module scope, so a dialog
  // opened from inside the sheet cannot free the page when it closes.
  useScrollLock(navOpen);

  useEffect(() => {
    const stored = readStoredCollapsed();
    if (stored !== null) setCollapsed(stored);
    setReady(true);
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      writeStoredCollapsed(next);
      return next;
    });
  }, []);

  const closeNav = useCallback(() => {
    // Focus moves BEFORE the close, while the panel is still mounted and the hamburger is still what the
    // reader came from; letting the panel unmount first drops focus onto <body> and the reader loses
    // their place entirely. `preventScroll`, because the scroll lock is about to put the page back where
    // it was and a focus-induced scroll would immediately undo it.
    navTriggerRef.current?.focus({ preventScroll: true });
    setNavOpen(false);
  }, []);

  // A navigation closes the sheet. Without this the panel stays over the screen it just opened, and
  // the reader has to dismiss the menu to see what they chose. Focus is NOT pulled back to the trigger
  // here: the destination page is what should receive attention now.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  /**
   * Rule 1: focus moves into the sheet when it opens.
   *
   * The FIRST FOCUSABLE ELEMENT rather than the panel itself, exactly as NavSheet does — landing on a
   * real control means the reader is already inside the run of elements the trap wraps between, and the
   * panel is only the fallback for a menu with nothing in it at all. `requestAnimationFrame` waits for
   * the panel and its children to be in the document.
   */
  useEffect(() => {
    if (!navOpen) return;
    const frame = window.requestAnimationFrame(() => {
      const panel = sheetRef.current;
      if (!panel) return;
      const first = focusableWithin(panel)[0];
      (first ?? panel).focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [navOpen]);

  /**
   * Crossing into `lg` closes the sheet.
   *
   * The sheet is `lg:hidden`, so at that width it is invisible — but `useScrollLock` would still be
   * holding the page frozen with nothing on screen to dismiss. A reader who rotated a tablet would find
   * a CMS that refuses to scroll and no way to explain it. 1024px is the stock `lg` breakpoint, written
   * as a literal because a media query cannot read a Tailwind token.
   */
  useEffect(() => {
    if (!navOpen) return;
    const wide = window.matchMedia("(min-width: 1024px)");
    if (wide.matches) {
      setNavOpen(false);
      return;
    }
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setNavOpen(false);
    };
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, [navOpen]);

  // Rules 2, 3 and 4: the trap itself. See the header for why each branch is the shape it is.
  useEffect(() => {
    if (!navOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Tab") return;

      // Something above this sheet owns both keys: an open dialog (`data-dialog`, rung 100) or a popover
      // portalled to the body (`data-floating-layer`, rung 70). Both are the same two hooks Dialog
      // itself checks, so there is one convention rather than two. See the header.
      if (document.querySelector("[data-dialog],[data-floating-layer]") !== null) return;

      if (event.key === "Escape") {
        event.preventDefault();
        // Stopped here so one Escape cannot also close a dialog underneath this sheet (contract §14).
        event.stopPropagation();
        closeNav();
        return;
      }

      const panel = sheetRef.current;
      if (!panel) return;

      const focusables = focusableWithin(panel);
      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      // A panel with nothing focusable in it still must not leak focus to the page behind: `aria-modal`
      // has already told the reader's software that page is not there.
      if (!first || !last) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }

      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);

      // "Focus is outside the panel" is treated as "at the far end", so the first Tab after focus has
      // escaped lands back inside rather than continuing through the ignored page behind.
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

    // Capture, so a control on the page that stops propagation cannot strand the sheet open or keep the
    // trap from seeing a Tab.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [navOpen, closeNav]);

  return (
    <div className="min-h-screen bg-bg-0">
      {/*
        FIRST in tab order, and the target is `tabIndex={-1}` below — a skip link whose target cannot
        take focus only moves the scroll position and leaves focus back in the chrome.
      */}
      <a
        href="#studio-main"
        className="sr-only z-[60] rounded-md bg-purple-700 px-4 py-2 text-sm font-medium text-white shadow-cta focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to the main area
      </a>

      {/* The pinned column. Rung 40 — below the top bar at 50, so the bar's shadow reads over it.
          `data-studio-chrome` is the print hook: fixed, so on a wide enough sheet it stamps page one
          over the content. See the header. */}
      <div data-studio-chrome="" className="fixed inset-y-0 left-0 z-40 hidden lg:flex">
        <StudioSidebar
          sections={sections}
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
          variant="fixed"
        />
      </div>

      <div
        // The print hook for the gutter this column pays the sidebar. It is on the column rather than
        // on the `lg:pl-*` utilities because those are complete literal strings chosen for the reason
        // just below, and a stylesheet that keyed on them would break the moment the width changed.
        data-studio-frame=""
        className={cn(
          // One complete literal class string per state. A padding built by concatenation is purged,
          // and two competing `lg:pl-*` utilities in one string would be decided by CSS source order.
          collapsed ? "lg:pl-[4.5rem]" : "lg:pl-64",
          // 220ms and the brand curve: the width duration from the motion vocabulary (contract §8),
          // and `ease-out` the CLASS is the house expo curve rather than the CSS keyword of the same
          // name. Held back until `ready` — see the header.
          ready ? "transition-[padding] duration-[220ms] ease-out" : undefined
        )}
      >
        <StudioTopBar
          user={user}
          sections={sections}
          navOpen={navOpen}
          onOpenNav={() => setNavOpen(true)}
          navTriggerRef={navTriggerRef}
          navSheetId={sheetId}
        />

        {/*
          `tabIndex={-1}` makes this focusable by the skip link without putting it in the tab order.
          The gutters are paid ONCE, here — a screen adds vertical rhythm inside, never another
          horizontal pad, or the studio ends up with three numbers meaning one margin.
        */}
        <main id="studio-main" tabIndex={-1} className="px-4 py-6 outline-none sm:px-6 lg:px-8">
          {children}
        </main>
      </div>

      {/*
        The slide-over, rendered AFTER the content column so it shares rung 50 with the top bar and
        still paints above it — DOM order settles a tie without inventing a rung (contract §6).

        ⚠ BOTH HALVES ARE DIRECT, KEYED CHILDREN OF `AnimatePresence`. A wrapping `<div>` would be the
        only child it could see, and a plain div has no exit animation to wait for — so it would unmount
        instantly and the panel and scrim inside it would vanish rather than leave. The `lg:hidden` that
        would have lived on the wrapper is therefore on each half instead.
      */}
      <AnimatePresence>
        {navOpen ? (
          <motion.div
            key="studio-nav-scrim"
            // Only in the document if the reader pressed Ctrl+P with the menu open — but then it is a
            // full-viewport fixed scrim, which prints as a blank first sheet over the screen it was
            // opened from. Chrome, by any definition (see the header).
            data-studio-chrome=""
            aria-hidden="true"
            onClick={closeNav}
            // `touch-action: none` is what stops a drag on the dark area panning the page underneath on
            // iOS. It must land on THIS element and on no ancestor of the panel: the identical
            // declaration above the panel cancels the scroll gesture INSIDE it as well, and a sidebar
            // taller than a phone screen then cannot be reached on exactly the devices this sheet exists
            // for. The scrim being the panel's SIBLING rather than its parent is what makes it safe here.
            // Inline rather than a utility because `cn()` is a plain join and a second `touch-*` class
            // would be settled by CSS source order (contract §5).
            style={{ touchAction: "none" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : DURATION.scrim, ease: EASE_OUT }}
            className="fixed inset-0 z-40 bg-ink-900/50 backdrop-blur-sm lg:hidden"
          />
        ) : null}

        {navOpen ? (
          <motion.div
            key="studio-nav-sheet"
            ref={sheetRef}
            // Same reasoning as the scrim: a fixed panel carrying a duplicate of the navigation.
            data-studio-chrome=""
            id={sheetId}
            role="dialog"
            aria-modal="true"
            aria-label="Studio menu"
            tabIndex={-1}
            // Inside the studio, branching `initial` on a client-only value is safe: nothing here is
            // prerendered for an anonymous reader, so there is no server paint to disagree with. (On the
            // public site the same pattern would flash — see contract §8.)
            initial={reduce ? { opacity: 0 } : { x: "-100%" }}
            animate={reduce ? { opacity: 1 } : { x: 0 }}
            exit={reduce ? { opacity: 0 } : { x: "-100%" }}
            transition={reduce ? { duration: 0 } : SPRING_ISLAND}
            className="fixed inset-y-0 left-0 z-50 w-[17.5rem] max-w-[calc(100vw-3rem)] shadow-panel outline-none lg:hidden"
          >
            <StudioSidebar sections={sections} collapsed={false} variant="sheet" onClose={closeNav} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
