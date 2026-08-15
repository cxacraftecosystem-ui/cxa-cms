/**
 * StudioPageHeader — the top of every studio screen: the trail, the one back control, the `<h1>`, a
 * sentence saying what the screen is for, and the screen's actions.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ EXACTLY ONE BACK CONTROL PER SCREEN, AND IT IS THIS ONE.
 *
 * Never add a second "Back to publications" anywhere else on the page — not at the foot of the form,
 * not beside Save, not inside a panel. Two controls that both mean "leave this screen" is two places
 * to look for the one that discards your work, and an administrator who has learned that the back
 * control is at the top left stops reading the others. If a screen seems to need a second one, what
 * it actually needs is for the first one to be where the reader is looking.
 *
 * PASS `back` ONLY WHEN THE SCREEN IS A CHILD. A top-level list ("Publications") has nowhere to go
 * back to; a control that points at the dashboard is not "back", it is a sideways move dressed up as
 * one. If you pass a `breadcrumb` as well, the trail already names the parent — `back` is then for the
 * case where returning to that parent is the single most likely thing the reader wants (an editor
 * screen), not a habit to apply everywhere.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * IT RENDERS THE `<h1>`, AND THERE IS ONLY ONE PER PAGE (contract §11). Nothing else on a studio
 * screen may render an `<h1>`; `FormSection` starts at `<h2>` for exactly this reason.
 *
 * THE TRAIL IS RENDERED HERE RATHER THAN WITH `components/site/Breadcrumbs`. That component imports
 * `lib/seo.ts`, which carries `server-only`, because it also emits `BreadcrumbList` structured data —
 * so importing it would make this header unusable from any client screen, and the studio is
 * `noindex` anyway, so there is no structured data to emit. Same trail, none of the freight.
 *
 * NO `"use client"`. It is markup and links, so a Server Component page renders it directly; a client
 * editor that needs it pulls it into the client bundle by the ordinary rules.
 *
 * NO ENTRANCE ANIMATION, DELIBERATELY. The studio is calm and dense (contract §0): an administrator
 * who typed an address wants the screen to be there, not to arrive. Motion in the studio is confined
 * to state transitions that carry meaning — a panel opening, a row flashing after a save.
 */

import Link from "next/link";
import { ArrowLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface StudioCrumb {
  /** The visible label. Name the thing, not the route: "Publications", not "publications". */
  label: string;
  /**
   * Internal path with a leading slash. Omit it for the current screen — the last crumb is a
   * `<span>` with `aria-current="page"`, because a link to the page you are already on is a control
   * that does nothing and a screen reader announces it as somewhere to go.
   */
  href?: string;
}

export interface StudioBackLink {
  href: string;
  /** Name the destination: "Publications". The component renders "Back to Publications". */
  label: string;
}

export interface StudioPageHeaderProps {
  /** Sentence case, no full stop. It is the page's `<h1>` and its accessible name. */
  title: string;
  /** One or two plain sentences: what this screen is for, and what a reader can do here. */
  description?: ReactNode;
  breadcrumb?: readonly StudioCrumb[];
  /** The single back control. See the header — omit it on a top-level screen. */
  back?: StudioBackLink;
  /** The screen's actions — "New publication", a Publish button. Right-aligned beside the title. */
  actions?: ReactNode;
  /** A chip beside the title: a `StatusBadge`, a record count, "3 waiting". */
  meta?: ReactNode;
  /**
   * Keeps the header in view while a long editor scrolls, on rung 10 of the ladder — "sticky in-page
   * chrome" (contract §6). Never higher: the studio top bar is 50 and page chrome must not exceed it.
   *
   * ⚠ It only sticks if no ancestor is a scroll container. A parent with `overflow-x-auto` computes
   * `overflow-y: auto` as well and quietly becomes the thing this sticks to.
   */
  sticky?: boolean;
  className?: string;
  /** Rendered under the description — a tab row, a filter toolbar that belongs to the header. */
  children?: ReactNode;
}

export function StudioPageHeader({
  title,
  description,
  breadcrumb,
  back,
  actions,
  meta,
  sticky = false,
  className,
  children
}: StudioPageHeaderProps) {
  const crumbs = breadcrumb ?? [];
  const lastIndex = crumbs.length - 1;

  return (
    <header
      className={cn(
        "border-b border-line-200 pb-5",
        // `bg-bg-0` is load-bearing when sticky: without a fill the rows scrolling underneath show
        // through the header. It is the themed page background, never a hardcoded neutral (§1.2).
        sticky ? "sticky top-0 z-10 bg-bg-0 pt-5" : undefined,
        className
      )}
    >
      {back || crumbs.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {back ? (
            <Link
              href={back.href}
              className="-ml-2 inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-ink-700 transition hover:bg-surface-100 hover:text-ink-900"
            >
              <ArrowLeft aria-hidden="true" className="h-4 w-4 shrink-0" />
              {/* The destination is named, not implied. "Back" alone forces a reader to remember
                  where they came from, and a screen reader announcing five identical "Back" links
                  across a session tells them nothing. */}
              Back to {back.label}
            </Link>
          ) : null}

          {crumbs.length > 0 ? (
            <nav aria-label="Breadcrumb" className="min-w-0">
              <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
                {crumbs.map((crumb, index) => (
                  // The href alone is not unique — a trail can legitimately repeat a path — so the
                  // index is part of the key. The list is rendered whole and never reordered.
                  <li key={`${crumb.href ?? "current"}-${index}`} className="flex items-center gap-1.5">
                    {index > 0 ? (
                      // `aria-hidden`: the `<ol>` already tells a reader this is an ordered list of N
                      // items. A chevron read out between each pair adds "greater than" to every
                      // announcement.
                      <ChevronRight aria-hidden="true" className="h-3 w-3 shrink-0 text-ink-300" />
                    ) : null}

                    {crumb.href && index !== lastIndex ? (
                      <Link
                        href={crumb.href}
                        className="rounded text-ink-500 transition-colors hover:text-purple-700"
                      >
                        {crumb.label}
                      </Link>
                    ) : (
                      <span aria-current={index === lastIndex ? "page" : undefined} className="text-ink-500">
                        {crumb.label}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </nav>
          ) : null}
        </div>
      ) : null}

      <div
        className={cn(
          "flex flex-wrap items-start justify-between gap-x-6 gap-y-4",
          back || crumbs.length > 0 ? "mt-3" : sticky ? undefined : "mt-0"
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {/* `display-title` is the house recipe: font-display, bold, tight tracking, ink-900. */}
            <h1 className="display-title text-2xl">{title}</h1>
            {meta ? <div className="flex shrink-0 items-center gap-2">{meta}</div> : null}
          </div>

          {description ? (
            // Capped at the 68ch measure. A sentence running the full width of a 1400px studio window
            // is a sentence nobody reads to the end of.
            <p className="prose-measure mt-2 text-sm leading-relaxed text-ink-500">{description}</p>
          ) : null}
        </div>

        {actions ? (
          // `justify-end` so a wrapped action row stays aligned with the right edge rather than
          // drifting to the middle of the header.
          <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
        ) : null}
      </div>

      {children ? <div className="mt-5">{children}</div> : null}
    </header>
  );
}
