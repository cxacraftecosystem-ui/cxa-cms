"use client";

/**
 * SiteBrand — the institutional mark plus the wordmark, and (in the footer) the studio door.
 *
 * ONE COMPONENT, TWO PLACEMENTS. The header wants a compact lockup that survives a 360px phone; the
 * footer wants the same lockup inverted onto the deep purple band, with the tagline under it. Two
 * copies would drift the first time the mark changed, so the difference is a `variant` and nothing
 * else.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE SEVEN-CLICK DOOR (`asStudioDoor`, footer only)
 *
 * Contract §0: no visible link ever points from the public site to the studio. The three ways in are
 * typing the address, `Ctrl+Shift+A` (see StudioDoorway) and clicking the footer wordmark seven times
 * in quick succession. This is the third.
 *
 * IT STAYS A REAL `<Link href="/">`. The tempting shape is a `<div onClick>` counting clicks, and it
 * is wrong twice over: it removes the site's own home link from the tab order, and it gives a screen
 * reader a clickable nothing where the masthead should be. So the element is an ordinary anchor, the
 * counter rides on top of it, and everyone who is not looking for a door simply gets the home link.
 *
 * TWO DETAILS THAT ARE NOT ARBITRARY:
 *
 *  1. **The counter is a pair of refs and a timestamp, not a timer.** The window is evaluated at the
 *     only moment it matters — the next click. There is no interval to leak, nothing to clean up on
 *     unmount, and no state change, so counting to six never re-renders the footer.
 *  2. **On "/" the click is swallowed.** The wordmark already points at the page the reader is on, so
 *     the anchor has nowhere to go and nothing is lost — whereas letting seven navigations to "/"
 *     through would scroll the page to the top seven times and take the footer out from under the
 *     pointer after the first one, making the door unopenable. Anywhere else on the site the first
 *     click behaves exactly like the home link it is; the header's wordmark (which is not a door) is
 *     always on screen and always navigates, so no reader is ever left without a working way home.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `"use client"` covers the whole file because the door needs a router and two refs. The mark below
 * is pure markup and would happily render on the server, but splitting it into a sixth file to save a
 * few hundred bytes of an SVG that both client trees already pull in is not a trade worth making.
 */

import { useRef, type MouseEvent as ReactMouseEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { cn } from "@/lib/utils";
import type { BrandingSettings } from "@/lib/settings/schema";

/** Kept as a literal here and in StudioDoorway; the two are separate files and share no constant. */
const STUDIO_PATH = "/studio";

/** How many clicks open the door. Seven is enough that it cannot be reached by fidgeting. */
const STUDIO_DOOR_CLICKS = 7;

/**
 * How long a click stays "part of the same burst".
 *
 * Three seconds from the PREVIOUS click, not from the first: the count resets after three quiet
 * seconds, so an ordinary double-click reaches two and is forgotten long before it can reach seven.
 */
const STUDIO_DOOR_WINDOW_MS = 3000;

export type SiteBrandVariant = "header" | "footer";

export interface SiteBrandProps {
  branding: BrandingSettings;
  variant: SiteBrandVariant;
  /** Footer only. Turns the wordmark into the seven-click studio door described above. */
  asStudioDoor?: boolean;
  className?: string;
}

/**
 * The mark: `app/icon.svg`'s geometry, inline.
 *
 * An observatory reticle — a ring, a solid core, three cream ticks and one gold one. The gold tick is
 * the single deliberate asymmetry that gives the mark an orientation; without it the thing reads as a
 * loading spinner. Proportions are the file's: a 64-unit box with a 14-unit corner radius, a ring at
 * r=15, a core at r=5.5, and ticks that stop 6 units short of the edge.
 *
 * Colours come through Tailwind classes rather than the file's literal hex, so the tile is the real
 * `purple-700` rather than the sRGB approximation `icon.svg` carries for surfaces that cannot resolve
 * oklch. None of these three colours inverts with the theme, which is correct — a logo that changed
 * colour with a preference would not be a logo.
 *
 * ON THE FOOTER THE MARK INVERTS: the purple tile becomes a faint cream plate (the band beneath it is
 * already purple-950, so a purple tile would simply disappear), the reticle stays cream, and the gold
 * tick stays gold.
 */
function BrandMark({ variant, className }: { variant: SiteBrandVariant; className?: string }) {
  const onDark = variant === "footer";

  return (
    <svg
      viewBox="0 0 64 64"
      // Decorative: the wordmark beside it is the link's accessible name, and a second name here
      // would have a screen reader read the Centre twice on one link.
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <rect
        width="64"
        height="64"
        rx="14"
        className={onDark ? "fill-logo-cream/10" : "fill-purple-700"}
      />
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

export function SiteBrand({ branding, variant, asStudioDoor = false, className }: SiteBrandProps) {
  const router = useRouter();
  const pathname = usePathname();

  // Refs, not state: the count is read and written inside one event handler and rendered nowhere, so
  // storing it in state would re-render the footer six times on the way to opening a door.
  const clicks = useRef(0);
  const lastClickAt = useRef(0);

  const onDark = variant === "footer";

  const handleClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!asStudioDoor) return;

    // A modified or non-primary click means "open in a new tab", "save this link", "paste-and-go" —
    // the browser's business. Counting it would let a stray middle-click contribute to a total the
    // reader cannot see, and swallowing it would break a perfectly ordinary browser gesture.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }

    const now = Date.now();
    const continuesBurst = now - lastClickAt.current <= STUDIO_DOOR_WINDOW_MS;
    lastClickAt.current = now;
    clicks.current = continuesBurst ? clicks.current + 1 : 1;

    // See the header: on the homepage the anchor has nowhere to go, so swallowing the click costs
    // nothing and is the only thing that lets a burst accumulate at all.
    if (pathname === "/") event.preventDefault();

    if (clicks.current < STUDIO_DOOR_CLICKS) return;

    clicks.current = 0;
    lastClickAt.current = 0;
    event.preventDefault();
    router.push(STUDIO_PATH);
  };

  return (
    <Link
      href="/"
      onClick={asStudioDoor ? handleClick : undefined}
      className={cn(
        "inline-flex max-w-full items-center gap-2.5 rounded-full",
        onDark ? "text-white" : "text-ink-900",
        className
      )}
    >
      <BrandMark variant={variant} className={onDark ? "h-11 w-11 shrink-0" : "h-9 w-9 shrink-0"} />

      <span className="flex min-w-0 flex-col">
        {variant === "header" ? (
          <>
            {/*
              Two spellings, one of which is always `display: none` — and an element that is display
              none is out of the accessibility tree, so the link's accessible name is whichever one
              the reader can actually see. The pill has to survive a 360px phone alongside a search
              control, an accessibility menu and the hamburger; the full name does not fit there and
              `shortName` exists in the branding settings for exactly this.
            */}
            <span className="truncate font-display text-[0.9375rem] font-semibold leading-tight tracking-tight sm:hidden">
              {branding.shortName || branding.siteName}
            </span>
            <span className="hidden truncate font-display text-[0.9375rem] font-semibold leading-tight tracking-tight sm:inline">
              {branding.siteName}
            </span>
          </>
        ) : (
          <>
            <span className="font-display text-lg font-semibold leading-tight tracking-tight">
              {branding.siteName}
            </span>
            {branding.tagline ? (
              <span className="mt-1 text-sm leading-snug text-white/60">{branding.tagline}</span>
            ) : null}
          </>
        )}
      </span>
    </Link>
  );
}
