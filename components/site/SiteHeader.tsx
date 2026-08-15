"use client";

/**
 * SiteHeader — the floating glass pill that collapses as the reader descends.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE WRAPPER IS `pointer-events-none`, THE PILL IS `pointer-events-auto`
 *
 * The wrapper spans the full width so the pill can be centred in it, but the pill is only as wide as
 * its contents. Without the pointer-events pair, the empty air either side of the pill is a fixed
 * element sitting over the top ~80px of every page, eating clicks on anything beneath it — a hero
 * button, a breadcrumb, the first line of an article.
 *
 * `.nav-frame` is the other half of the same idea: this element is `position: fixed`, so its
 * containing block is the viewport and the `padding-right` the scroll lock puts on <body> to replace
 * the vanished scrollbar cannot reach it. Fixed chrome re-pays `var(--scroll-gutter)` itself, or the
 * whole header slides 10px sideways the moment a menu opens (contract §6).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE COLLAPSE, AND WHY THERE ARE THREE BRANCHES AND A ±2px BAND:
 *
 *   latest < 24            → always expanded.  The top of a page is not "scrolled".
 *   latest > previous + 2  → compact.          A deliberate downward move: the reader wants the page.
 *   latest < previous - 2  → expanded.         ANY upward flick brings the full menu back, so it is
 *                                              never more than one gesture away and a reader is never
 *                                              made to scroll to the top to reach a link.
 *
 * The 2px dead band is the only thing standing between this and a pill that flickers: sub-pixel
 * scroll deltas (a trackpad settling, a smooth-scroll library easing out, a phone's rubber-banding)
 * arrive as a stream of ±0.5px changes, and a bare `latest > previous` comparison flaps the layout
 * animation on every frame of them.
 *
 * `layout` + SPRING_ISLAND is what makes the pill genuinely shrink AROUND its contents rather than
 * cross-fade between two sizes: framer measures both boxes and projects between them, so the border,
 * the shadow and the glass all travel as one object.
 *
 * KEYBOARD ROUTES AND WHY THE DROPDOWNS ARE NOT TRAPPED. Below `lg` the entire link strip is
 * `display: none` and NavSheet is the only menu in the accessibility tree — which is why the sheet
 * carries a real focus trap. Above `lg` the dropdown panels open on hover AND on focus, and their
 * links sit immediately after their trigger in DOM order, so Tab walks straight into an open panel
 * and Escape closes it. A trap there would be wrong: these are disclosures on a page, not modals.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type SetStateAction
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, useMotionValueEvent, useScroll } from "framer-motion";
import { ArrowUpRight, ChevronDown, Menu, Search, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { collectHrefs, isActiveHref, resolveActiveHref, type NavNode } from "@/lib/navigation";
import type { FeatureFlag, FeaturesSettings, BrandingSettings } from "@/lib/settings/schema";
import {
  DURATION,
  EASE_OUT,
  SPRING_ISLAND,
  SPRING_POPOVER,
  useReducedMotionPreference
} from "@/components/motion";
import { AccessibilityMenu } from "@/components/ui/AccessibilityMenu";
import { SiteBrand } from "@/components/site/SiteBrand";
import { EXTERNAL_LINK_PROPS, NavSheet } from "@/components/site/NavSheet";

// ─────────────────────────────────────────────────────────────────────────────
// The numbers
// ─────────────────────────────────────────────────────────────────────────────

/** Below this the pill is always expanded, whatever direction the last scroll went. */
const EXPAND_FLOOR = 24;

/** The dead band, in pixels. See the header: it is what stops sub-pixel jitter flapping the pill. */
const JITTER_BAND = 2;

/**
 * Must track Tailwind's `lg`, which is stock (contract §2) and therefore 1024px.
 *
 * Used to close the sheet when a rotation or a resize takes the reader from the hamburger to the
 * strip: leaving it open would hold the scroll lock over a menu nobody can see, and would put a
 * second `aria-current="page"` in the accessibility tree.
 */
const DESKTOP_QUERY = "(min-width: 1024px)";

/**
 * How many top-level entries the strip will attempt.
 *
 * Six entries of ~90px plus the wordmark, the search control, the accessibility menu and the
 * hamburger is already the width of a 1024px viewport. Past this the strip is NOT truncated — a
 * navigation that quietly stops listing sections is the single most repeated bug class in this
 * product's history (contract §1.6). Instead the strip stands down entirely and the hamburger is
 * shown at every width, where the sheet lists all of it with room to spare.
 */
const MAX_STRIP_ENTRIES = 6;

/**
 * Which destinations a feature flag switches off entirely.
 *
 * Only flags that gate a WHOLE SURFACE appear here. `contactForm`, `eventRegistration` and
 * `analytics` gate part of a page that still exists and still needs its link — a contact page with no
 * form is still where the address is (see FEATURE_FLAGS in lib/settings/schema.ts).
 */
const FEATURE_ROUTES: ReadonlyArray<{ prefix: string; flag: FeatureFlag }> = [
  { prefix: "/craft-explorer", flag: "craftExplorer" },
  { prefix: "/gallery", flag: "gallery" },
  { prefix: "/events", flag: "events" },
  { prefix: "/publications", flag: "publications" }
];

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/** The path part of a nav href, with any query or fragment removed. */
function baseOf(href: string): string {
  return href.split("?")[0]?.split("#")[0] ?? "";
}

function isHrefEnabled(href: string, features: FeaturesSettings): boolean {
  const base = baseOf(href);
  for (const route of FEATURE_ROUTES) {
    if (base === route.prefix || base.startsWith(`${route.prefix}/`)) return features[route.flag];
  }
  return true;
}

/**
 * Drop every entry whose destination has been switched off.
 *
 * NOT RENDERED, never rendered disabled (contract §1.8): a greyed-out "Craft Explorer" invites every
 * visitor to press it and tells them nothing when they do.
 *
 * The awkward case is a GROUP whose own href is gated but whose children are not — the shipped
 * "Archive" entry points at `/craft-explorer` and also holds `/gallery`. Dropping the group takes the
 * gallery down with it; keeping it pointed where it is gives the reader a 404 that looks like a
 * broken deployment. So the group survives, re-pointed at the first destination still standing.
 */
function filterNavByFeatures(nodes: NavNode[], features: FeaturesSettings): NavNode[] {
  const out: NavNode[] = [];

  for (const node of nodes) {
    const children = filterNavByFeatures(node.children, features);

    if (isHrefEnabled(node.href, features)) {
      out.push({ ...node, children });
      continue;
    }

    const first = children[0];
    if (!first) continue;
    out.push({ ...node, href: first.href, children });
  }

  return out;
}

/**
 * The ONE node allowed to carry `aria-current="page"`, chosen by DOM order.
 *
 * `resolveActiveHref` already guarantees a single answer for "which base is active" (longest base
 * wins), but a menu can legitimately point two entries at the same place — the shipped tree has
 * "Archive" → `/craft-explorer` with a child "Craft Explorer" → `/craft-explorer`. Both match, and
 * marking both tells a screen reader the reader is in two places at once. The first in DOM order
 * wins; the other keeps the visual active treatment and loses only the announcement.
 */
function firstMatchingId(nodes: NavNode[], activeBase: string | null): string | null {
  if (!activeBase) return null;
  for (const node of nodes) {
    if (isActiveHref(node.href, activeBase)) return node.id;
    const inChildren = firstMatchingId(node.children, activeBase);
    if (inChildren) return inChildren;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Class recipes — complete literal strings, never assembled (contract §5)
// ─────────────────────────────────────────────────────────────────────────────

const PILL_BASE =
  "pointer-events-auto mx-auto flex w-fit max-w-full items-center gap-2 rounded-full border border-line-200 bg-card/70 shadow-island backdrop-blur-xl";

/**
 * The glass is `bg-card/70` + `backdrop-blur-xl` rather than the `.glass-card` utility: that recipe
 * is a literal white, which is right on a light page and a bright slab on a dark one. `card` is a
 * themed token and inverts with everything else (contract §1.2).
 */
const PILL_EXPANDED = "py-2 pl-3 pr-2";
const PILL_COMPACT = "py-1.5 pl-2 pr-1.5";

const CONTROL_BASE =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-full px-3 py-2 text-sm font-medium text-ink-700 transition hover:bg-surface-100 hover:text-ink-900";

const STRIP_LINK_BASE =
  "inline-flex min-h-9 items-center gap-1 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition";

/**
 * The active treatment is a purple wash and a NAMED ring.
 *
 * `ring-1` on its own would be preflight's stock blue (contract §3), and a solid purple-700 chip in a
 * row of plain links reads as a button rather than as "you are here". The wash inverts with the theme
 * because it is an alpha over the themed pill, and `aria-current` carries the same fact to anything
 * that cannot see it.
 */
const STRIP_LINK_ACTIVE = "bg-purple-700/10 text-ink-900 ring-1 ring-purple-600/20";
const STRIP_LINK_SECTION = "text-ink-900 hover:bg-surface-100";
const STRIP_LINK_IDLE = "text-ink-700 hover:bg-surface-100 hover:text-ink-900";

// ─────────────────────────────────────────────────────────────────────────────

export interface SiteHeaderProps {
  branding: BrandingSettings;
  items: NavNode[];
  features: FeaturesSettings;
}

export function SiteHeader({ branding, items, features }: SiteHeaderProps) {
  const pathname = usePathname();
  const reduce = useReducedMotionPreference();

  const [compact, setCompact] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  const hamburgerRef = useRef<HTMLButtonElement | null>(null);
  const sheetId = useId();

  const visibleItems = useMemo(() => filterNavByFeatures(items, features), [items, features]);
  const activeBase = useMemo(
    () => resolveActiveHref(pathname, collectHrefs(visibleItems)),
    [pathname, visibleItems]
  );
  const currentId = useMemo(
    () => firstMatchingId(visibleItems, activeBase),
    [visibleItems, activeBase]
  );

  // See MAX_STRIP_ENTRIES: too many sections and the strip stands down at every width rather than
  // silently dropping the ones that do not fit.
  const stripFits = visibleItems.length > 0 && visibleItems.length <= MAX_STRIP_ENTRIES;

  const { scrollY } = useScroll();

  useMotionValueEvent(scrollY, "change", (latest) => {
    // `getPrevious()` is the value at the end of the previous frame, which is exactly the reference
    // the dead band needs; a value captured in a ref would lag by a render.
    const previous = scrollY.getPrevious() ?? 0;

    if (latest < EXPAND_FLOOR) {
      setCompact(false);
      return;
    }
    if (latest > previous + JITTER_BAND) {
      setCompact(true);
      return;
    }
    if (latest < previous - JITTER_BAND) setCompact(false);
  });

  // A dropdown anchored to a link that is about to be unmounted by the collapse would be left
  // hanging under an empty pill.
  useEffect(() => {
    setOpenMenuId(null);
  }, [compact]);

  /**
   * The reset net.
   *
   * Every link already closes the sheet on its way out; this catches the routes that change without
   * one — the browser's Back button, a redirect, a `router.push` from anywhere else. It deliberately
   * does NOT move focus: the navigation has already moved the reader, and dragging focus back to the
   * hamburger afterwards would strand a screen-reader user at the top of a page they have left.
   */
  useEffect(() => {
    setSheetOpen(false);
    setOpenMenuId(null);
  }, [pathname]);

  /**
   * Close the sheet if the viewport grows past `lg` while it is open.
   *
   * Only when the strip is the alternative — with more sections than the strip can take, the
   * hamburger IS the desktop menu and the sheet must stay open. Without this a rotation would leave
   * the scroll lock held over an invisible menu, and both menus would claim `aria-current`.
   */
  useEffect(() => {
    if (!sheetOpen || !stripFits) return;

    const query = window.matchMedia(DESKTOP_QUERY);
    const sync = () => {
      if (query.matches) setSheetOpen(false);
    };

    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, [sheetOpen, stripFits]);

  const dismissSheet = useCallback(() => setSheetOpen(false), []);

  return (
    <>
      <header className="nav-frame pointer-events-none fixed inset-x-0 top-3 z-50">
        <motion.div
          layout
          transition={reduce ? { duration: 0 } : SPRING_ISLAND}
          className={cn(PILL_BASE, compact ? PILL_COMPACT : PILL_EXPANDED)}
        >
          <SiteBrand branding={branding} variant="header" />

          {/*
            One navigation landmark holding the strip, the search route and the hamburger. The
            accessibility menu sits inside it too: a landmark that empties itself on scroll would
            appear and disappear from a screen reader's landmark list on every gesture.
          */}
          <nav aria-label="Primary" className="flex min-w-0 items-center gap-1">
            {stripFits ? (
              // `initial={false}`: on the first paint the strip is simply present, at its animated
              // state. An entrance here would run on every prerendered page load, and `compact`
              // starts false on both the server and the first client render so there is nothing to
              // animate FROM (contract §8).
              <AnimatePresence initial={false}>
                {!compact ? (
                  <motion.div
                    key="strip"
                    initial={{ width: 0, opacity: 0 }}
                    animate={{ width: "auto", opacity: 1 }}
                    exit={{ width: 0, opacity: 0 }}
                    transition={{ duration: reduce ? 0 : DURATION.page, ease: EASE_OUT }}
                    className={cn(
                      "hidden lg:block",
                      // Clipping is what makes a width animation read as the pill swallowing the
                      // links rather than as text spilling out of a shrinking box — but it also
                      // clips an open dropdown panel, so it is lifted while one is open. The two
                      // never overlap in practice: opening a panel takes a pointer or a Tab, and
                      // neither is happening during a scroll.
                      openMenuId ? "overflow-visible" : "overflow-hidden"
                    )}
                  >
                    <ul className="flex items-center gap-0.5 px-1">
                      {visibleItems.map((item) => (
                        <StripItem
                          key={item.id}
                          node={item}
                          activeBase={activeBase}
                          currentId={currentId}
                          openMenuId={openMenuId}
                          setOpenMenuId={setOpenMenuId}
                        />
                      ))}
                    </ul>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            ) : null}

            <Link href="/search" className={CONTROL_BASE}>
              <Search aria-hidden="true" className="h-4 w-4" />
              {/* The icon is decorative, so this span IS the link's accessible name. */}
              <span className="sr-only">Search this site</span>
            </Link>

            <AccessibilityMenu side="bottom" align="end" />

            <button
              ref={hamburgerRef}
              type="button"
              onClick={() => setSheetOpen((open) => !open)}
              aria-expanded={sheetOpen}
              // Only while the sheet is mounted: `aria-controls` pointing at an id that is not in the
              // document is worse than no `aria-controls` at all (contract §11).
              aria-controls={sheetOpen ? sheetId : undefined}
              className={cn(CONTROL_BASE, stripFits && "lg:hidden")}
            >
              {sheetOpen ? (
                <X aria-hidden="true" className="h-5 w-5" />
              ) : (
                <Menu aria-hidden="true" className="h-5 w-5" />
              )}
              <span className="sr-only">{sheetOpen ? "Close menu" : "Open menu"}</span>
            </button>
          </nav>
        </motion.div>
      </header>

      {/*
        A SIBLING of <header>, not a child. The header is `pointer-events-none` so the air beside the
        pill does not eat clicks, and pointer-events is inherited — a sheet mounted inside it would
        render perfectly and refuse every tap.
      */}
      <NavSheet
        open={sheetOpen}
        id={sheetId}
        items={visibleItems}
        activeBase={activeBase}
        currentId={currentId}
        onDismiss={dismissSheet}
        onNavigate={dismissSheet}
        returnFocusRef={hamburgerRef}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

interface StripItemProps {
  node: NavNode;
  activeBase: string | null;
  currentId: string | null;
  openMenuId: string | null;
  setOpenMenuId: Dispatch<SetStateAction<string | null>>;
}

/**
 * One top-level entry in the desktop strip, with its dropdown panel if it has children.
 *
 * THE PANEL OPENS ON HOVER *AND* ON FOCUS, and it is not a `role="menu"`. A menu role owes the reader
 * a roving tabindex, arrow-key navigation and Home/End; a half-built one strands focus, and there is
 * nothing here that a plain list of links inside a disclosure does not do better. Because the panel's
 * links sit immediately after their trigger in DOM order, Tab walks into an open panel and out the
 * far side without any of that machinery.
 *
 * The trigger stays a real `<Link>` to the section, so the group heading is itself a destination
 * rather than a control that only opens something.
 */
function StripItem({ node, activeBase, currentId, openMenuId, setOpenMenuId }: StripItemProps) {
  const reduce = useReducedMotionPreference();
  const panelId = useId();

  const hasChildren = node.children.length > 0;
  const isOpen = hasChildren && openMenuId === node.id;
  const active = isActiveHref(node.href, activeBase);
  const inSection = active || node.children.some((child) => isActiveHref(child.href, activeBase));

  const openThis = () => setOpenMenuId(hasChildren ? node.id : null);

  const handleBlur = (event: ReactFocusEvent<HTMLLIElement>) => {
    const next = event.relatedTarget;
    // Focus moving WITHIN the group — trigger to first child, child to child — must not close it.
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setOpenMenuId((current) => (current === node.id ? null : current));
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLLIElement>) => {
    if (event.key !== "Escape" || !isOpen) return;
    event.preventDefault();
    // Swallowed so one Escape cannot also close the navigation sheet or a dialog (contract §14).
    event.stopPropagation();
    setOpenMenuId(null);
    // Focus goes back to the trigger rather than being left on a link that is about to vanish.
    event.currentTarget.querySelector<HTMLElement>("[data-nav-trigger]")?.focus();
  };

  const linkClass = cn(
    STRIP_LINK_BASE,
    active ? STRIP_LINK_ACTIVE : inSection ? STRIP_LINK_SECTION : STRIP_LINK_IDLE
  );

  const label = (
    <>
      <span>{node.label}</span>
      {node.isExternal ? (
        <>
          <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span className="sr-only">(opens in a new tab)</span>
        </>
      ) : null}
      {hasChildren ? (
        <ChevronDown
          aria-hidden="true"
          className={cn("h-3.5 w-3.5 shrink-0 transition", isOpen && "rotate-180")}
        />
      ) : null}
    </>
  );

  return (
    <li
      className="relative"
      onMouseEnter={openThis}
      onMouseLeave={() => setOpenMenuId((current) => (current === node.id ? null : current))}
      onFocus={openThis}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      {node.isExternal ? (
        <a
          href={node.href}
          {...EXTERNAL_LINK_PROPS}
          data-nav-trigger
          className={linkClass}
        >
          {label}
        </a>
      ) : (
        <Link
          href={node.href}
          data-nav-trigger
          // `aria-expanded` is supported on a link, and says what hovering or focusing this one does.
          aria-expanded={hasChildren ? isOpen : undefined}
          aria-controls={isOpen ? panelId : undefined}
          aria-current={node.id === currentId ? "page" : undefined}
          className={linkClass}
        >
          {label}
        </Link>
      )}

      {hasChildren ? (
        <AnimatePresence>
          {isOpen ? (
            <motion.div
              id={panelId}
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.98 }}
              transition={reduce ? { duration: 0 } : SPRING_POPOVER}
              // z-10 is the "in-page chrome" rung, and it is local: the pill's `backdrop-filter`
              // opens a stacking context of its own, so this cannot escape from under the sheet
              // scrim or a dialog however high it climbs inside the pill (contract §6).
              //
              // `pt-3` ON THE WRAPPER, NOT `mt-3` — and that is the whole reason there are two
              // elements here. A margin would leave 12px of bare page between the trigger and the
              // panel; `mouseleave` fires on that gap (an absolutely positioned DESCENDANT counts as
              // part of the element, a gap does not), so the menu would shut under the pointer on
              // its way down. The padding is transparent and bridges it.
              className="absolute left-0 top-full z-10 w-64 pt-3"
            >
              <ul className="flex flex-col gap-0.5 rounded-lg border border-line-200 bg-card p-1.5 shadow-panel">
                {node.children.map((child) => {
                  const childActive = isActiveHref(child.href, activeBase);
                  const childClass = cn(
                    "flex min-h-10 items-center gap-2 rounded-md px-3 py-2 text-sm transition",
                    childActive
                      ? "bg-purple-700/10 text-ink-900"
                      : "text-ink-700 hover:bg-surface-100 hover:text-ink-900"
                  );

                  return (
                    <li key={child.id}>
                      {child.isExternal ? (
                        <a href={child.href} {...EXTERNAL_LINK_PROPS} className={childClass}>
                          <span className="min-w-0 flex-1 truncate">{child.label}</span>
                          <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                          <span className="sr-only">(opens in a new tab)</span>
                        </a>
                      ) : (
                        <Link
                          href={child.href}
                          aria-current={child.id === currentId ? "page" : undefined}
                          className={childClass}
                        >
                          <span className="min-w-0 flex-1 truncate">{child.label}</span>
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            </motion.div>
          ) : null}
        </AnimatePresence>
      ) : null}
    </li>
  );
}
