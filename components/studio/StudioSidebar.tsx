"use client";

/**
 * StudioSidebar — the list of destinations, rendered from `STUDIO_NAV` and nothing else.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THERE IS NO JSX PER DESTINATION IN THIS FILE. Every link is produced by mapping over the tree
 * `visibleStudioNav()` returned, so adding a screen to the CMS is appending one object in
 * StudioNav.ts and touching nothing here. The moment a link is written out by hand it becomes a link
 * whose permission check can drift from the registry's.
 *
 * THE ACTIVE ENTRY COMES FROM `resolveActiveHref()`, WHICH IS "LONGEST BASE WINS". A bare
 * `pathname.startsWith(href)` would mark `/studio` and `/studio/publications` at the same time, and
 * `aria-current="page"` on two links tells a screen reader the reader is in two places at once. One
 * resolver, one answer, exactly one `aria-current`.
 *
 * TWO SHAPES, ONE COMPONENT. `variant="fixed"` is the column pinned to the left from `lg` up, which
 * can be collapsed to icons; `variant="sheet"` is the same list inside the slide-over below `lg`,
 * where collapsing makes no sense and the panel needs a close button. Two copies of this list would
 * drift the first time a group was renamed.
 *
 * COLLAPSED IS ICONS PLUS `sr-only` TEXT, NEVER ICONS ALONE. The label stays in the accessible name
 * in both states, so a screen-reader user and a voice-control user hear and speak the same word
 * whatever width the column happens to be; the `title` is what a mouse reader gets, and it carries
 * the entry's own description rather than repeating the label.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { isActiveHref, resolveActiveHref } from "@/lib/navigation";
import {
  STUDIO_HOME,
  studioNavHrefs,
  type StudioNavEntry,
  type StudioNavSection
} from "@/components/studio/StudioNav";

export type StudioSidebarVariant = "fixed" | "sheet";

export interface StudioSidebarProps {
  /** Already filtered by `visibleStudioNav(user)` in the shell — never filtered again here. */
  sections: StudioNavSection[];
  /** Icons-only. Ignored in the sheet, where there is no width to save. */
  collapsed: boolean;
  /** Omitted in the sheet: the collapse control belongs to the pinned column only. */
  onToggleCollapsed?: () => void;
  variant: StudioSidebarVariant;
  /** Sheet only — closes the slide-over after a destination is chosen, and from the close button. */
  onClose?: () => void;
}

/**
 * The institutional mark — the same reticle as `app/icon.svg` and `components/site/SiteBrand.tsx`.
 *
 * Inlined rather than imported because `SiteBrand` does not export its mark and exists to carry the
 * public wordmark, the seven-click studio door and a router. Pulling all of that into the studio
 * chrome to reuse twenty lines of SVG would be the more expensive coupling.
 *
 * The gold tick is the single deliberate asymmetry that gives the mark an orientation; without it the
 * thing reads as a loading spinner.
 */
function StudioMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false" className={className}>
      <rect width="64" height="64" rx="14" className="fill-purple-700" />
      <circle cx="32" cy="32" r="15" fill="none" strokeWidth="3" className="stroke-logo-cream/90" />
      <circle cx="32" cy="32" r="5.5" className="fill-logo-cream" />
      <g strokeWidth="3" strokeLinecap="round" className="stroke-logo-cream/90">
        <line x1="32" y1="7" x2="32" y2="13" />
        <line x1="32" y1="51" x2="32" y2="57" />
        <line x1="7" y1="32" x2="13" y2="32" />
      </g>
      <line
        x1="51"
        y1="32"
        x2="57"
        y2="32"
        strokeWidth="3"
        strokeLinecap="round"
        className="stroke-gold-500"
      />
    </svg>
  );
}

interface NavLinkProps {
  entry: Omit<StudioNavEntry, "group">;
  active: boolean;
  dense: boolean;
  onNavigate?: () => void;
}

function NavLink({ entry, active, dense, onNavigate }: NavLinkProps) {
  const Icon = entry.icon;

  return (
    <Link
      href={entry.href}
      onClick={onNavigate}
      // Exactly one link in the whole sidebar carries this, because the resolver returns one base.
      aria-current={active ? "page" : undefined}
      // The description, not the label: the label is already the accessible name, and a tooltip that
      // repeats it tells a reader who hovered nothing they did not already have.
      title={dense ? `${entry.label} — ${entry.description}` : undefined}
      className={cn(
        // No `transition-transform` and no scale: an administrator aiming at a row wants the row to
        // be where they aimed. Only the fill changes, and it changes instantly under reduced motion.
        "relative flex items-center gap-3 rounded-md py-2 text-sm transition-colors",
        dense ? "justify-center px-2" : "px-2.5",
        active
          // The proven pair from Badge's `info` tone. Both are literal brand values and do not invert,
          // so the row reads the same in either theme.
          ? "bg-purple-100 font-semibold text-purple-700"
          : "text-ink-700 hover:bg-surface-100 hover:text-ink-900"
      )}
    >
      {active ? (
        // The static half of the "you are here" signal. `aria-current` carries it to assistive
        // technology and the fill carries it to most eyes; this bar is what survives a monochrome
        // screen and a reader who cannot separate the purple from the surface (contract §1.4).
        <span
          aria-hidden="true"
          className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-purple-700"
        />
      ) : null}

      <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
      {/* Always rendered. `sr-only` hides it from eyes without taking it out of the accessible name. */}
      <span className={dense ? "sr-only" : "min-w-0 flex-1 truncate"}>{entry.label}</span>
    </Link>
  );
}

export function StudioSidebar({
  sections,
  collapsed,
  onToggleCollapsed,
  variant,
  onClose
}: StudioSidebarProps) {
  const pathname = usePathname();

  // Collapsing is a property of the pinned column only.
  const dense = variant === "fixed" && collapsed;

  const activeBase = resolveActiveHref(pathname, studioNavHrefs(sections));

  return (
    <div
      className={cn(
        "flex h-full flex-col bg-card",
        // Never `border` alone — that is preflight's literal gray-200 and it does not invert (§3).
        variant === "fixed" ? "border-r border-line-200" : "",
        // One complete literal class string per state; a width assembled by concatenation is purged,
        // and two competing width utilities in one string would be decided by CSS source order (§5).
        variant === "sheet" ? "w-[17.5rem]" : dense ? "w-[4.5rem]" : "w-64"
      )}
    >
      <div
        className={cn(
          "flex h-16 shrink-0 items-center gap-2.5 border-b border-line-200",
          dense ? "justify-center px-2" : "px-4"
        )}
      >
        <StudioMark className="h-8 w-8 shrink-0 rounded-sm" />
        {dense ? null : (
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-display text-sm font-semibold leading-tight text-ink-900">
              Studio
            </span>
            <span className="truncate text-xs leading-tight text-ink-500">
              Everything on the website
            </span>
          </span>
        )}
        {variant === "sheet" && onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the studio menu"
            className="-mr-1.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-500 transition hover:bg-surface-100 hover:text-ink-900"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {/*
        The NAV is the scroller, not the page: nineteen destinations do not fit on a laptop beside a
        16px base size and larger text turned on, and a sidebar that scrolls the document instead of
        itself takes the top bar away with it. `overscroll-contain` so reaching the last entry does
        not hand the gesture to the table behind.
      */}
      <nav
        aria-label="Studio sections"
        className={cn(
          "min-h-0 flex-1 overflow-y-auto overscroll-contain py-3",
          dense ? "px-2" : "px-2.5"
        )}
      >
        <ul className="space-y-1">
          <li>
            <NavLink
              entry={STUDIO_HOME}
              active={isActiveHref(STUDIO_HOME.href, activeBase)}
              dense={dense}
              onNavigate={onClose}
            />
          </li>
        </ul>

        {sections.map((section) => (
          // `role="group"` with `aria-label` rather than a heading: a sidebar that contributed six
          // <h2>s to every page's outline would put "Library" and the page's own sections at the same
          // rank. The visible label below is `aria-hidden` because the group already carries the name
          // through `aria-label`, and announcing it twice is worse than announcing it once.
          <div key={section.group} role="group" aria-label={section.group} className="mt-5">
            {dense ? (
              // A rule instead of a word. The group is still named for assistive technology by
              // `aria-label`, so nothing is lost — only the twelve pixels the word would have cost.
              <hr aria-hidden="true" className="mx-1 mb-2 border-t border-line-200" />
            ) : (
              <p aria-hidden="true" className="field-label mb-1.5 px-2.5">
                {section.group}
              </p>
            )}

            <ul className="space-y-1">
              {section.entries.map((entry) => (
                <li key={entry.href}>
                  <NavLink
                    entry={entry}
                    active={isActiveHref(entry.href, activeBase)}
                    dense={dense}
                    onNavigate={onClose}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}

        {sections.length === 0 ? (
          // Not an empty column. A viewer whose role opens nothing must be told that, or the CMS looks
          // broken to the one person least able to tell the difference.
          <p className={cn("mt-4 text-xs leading-relaxed text-ink-500", dense ? "sr-only" : "px-2.5")}>
            Your account can sign in but cannot open any of these sections yet. An administrator can
            change what you are allowed to see.
          </p>
        ) : null}
      </nav>

      {variant === "fixed" && onToggleCollapsed ? (
        <div className="shrink-0 border-t border-line-200 p-2">
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="field-button-ghost w-full"
            title={collapsed ? "Widen the menu" : "Narrow the menu to icons"}
          >
            {collapsed ? (
              <PanelLeftOpen aria-hidden="true" className="h-4 w-4 shrink-0" />
            ) : (
              <PanelLeftClose aria-hidden="true" className="h-4 w-4 shrink-0" />
            )}
            {/* The words are the button's accessible name in both states, and they name the ACTION
                rather than the state — "Collapse" is what pressing it does. */}
            <span className={collapsed ? "sr-only" : undefined}>
              {collapsed ? "Widen the menu" : "Narrow the menu"}
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
