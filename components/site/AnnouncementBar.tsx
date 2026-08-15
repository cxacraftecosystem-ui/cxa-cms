import Link from "next/link";
import { CircleAlert, CircleCheck, Info, Megaphone, TriangleAlert, X, type LucideIcon } from "lucide-react";
import type { AnnouncementTone } from "@prisma/client";

import { activeAnnouncementWhere } from "@/lib/announcements";
import { prisma } from "@/lib/db";
import { prerenderSafe } from "@/lib/prerender";
import { cn } from "@/lib/utils";

/**
 * AnnouncementBar — the one band across the top of the public site: a closure, a deadline, a call for
 * applications.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * VISIBILITY IS RESOLVED AT READ TIME, NEVER FROM `isActive` ALONE.
 *
 * `activeAnnouncementWhere(now)` ANDs the switch, the soft-delete filter and both ends of the window
 * against this request's clock — exactly as `livePublishableWhere()` does for pages, and for the reason
 * `prisma/schema.prisma` gives on the model: a banner that outlived its deadline because a scheduled job
 * did not run is worse than no banner, because it is the Centre stating something untrue on every page of
 * its own site. There is no cron in this path at all, and the filter is imported rather than restated so
 * there is no second version of the question to get wrong.
 *
 * ⚠ ONLY ONE BAND IS EVER DRAWN, AND THE RULE IS "THE MOST RECENTLY WRITTEN ONE WINS" — `orderBy:
 * createdAt desc`, `take: 1` by virtue of `findFirst`. Two bands stacked above a header is two things
 * nobody reads. THE SAME RULE IS RESTATED CLIENT-SIDE in app/studio/announcements/AnnouncementManager.tsx,
 * which is what lets that screen say "live, but hidden behind …" and warn before a second one is switched
 * on. It has to be duplicated — one half is a database ordering and the other is a screen — and the two
 * must agree, or the studio will promise one thing and the site will show another.
 *
 * FRESHNESS. The `(site)` pages carry `revalidate = 300`, so this band is as fresh as the page around it,
 * the same as the news and events lists. The read-time filter is what bounds the damage: an expired
 * announcement cannot outlive its window by more than one revalidation.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * NO LAYOUT SHIFT, BECAUSE IT IS IN NORMAL FLOW AND SERVER-RENDERED. It is not fixed, it reserves
 * nothing, and it is part of the first paint. See the mounting note at the foot of this file: it belongs
 * INSIDE `<main class="page-top">`, not above it — the site header is a `position: fixed` floating pill
 * that occupies no flow space, so a band placed above it in the document would be painted underneath it,
 * and a band with its own top padding would double the `--nav-clearance` contract (contract §7).
 *
 * ⚠ THE DISMISSAL IS A PLAIN PRE-PAINT SCRIPT, NOT A REACT CLIENT CHILD, AND THAT IS THE WHOLE REASON
 * THIS FILE HAS NO `"use client"` ANYWHERE IN IT.
 *
 * A client child can only decide "this reader already dismissed this" AFTER it mounts, because
 * `localStorage` does not exist during the server render. Every return visit would therefore paint the
 * band, hydrate, and remove it — a flash and a full-page jump on the one element sitting above all the
 * content. The theme has exactly the same problem and app/layout.tsx solves it exactly this way: a raw
 * `<script>` that runs before the first paint. The script here does three things and nothing else:
 *
 *   1. reads the dismissed key from `localStorage` and hides the band when it matches THIS announcement;
 *   2. wires the dismiss button;
 *   3. survives `localStorage` being unavailable — every access is inside its own `try`/`catch`.
 *
 * The third point is not defensive habit. `window.localStorage` THROWS on access in Safari's private
 * mode and wherever site data is blocked, and an exception in a band rendered on every page of the site
 * would take every page down with it.
 *
 * ⚠ THE KEY IS `id` **AND** `updatedAt`, AS THE SCHEMA'S NOTE REQUIRES. Keyed on the id alone, an editor
 * who corrects a closing date is showing the correction to nobody who dismissed the original — which is
 * the worst possible half-failure, because the people who most need the new date are the ones who read the
 * old one. Keyed on nothing but a boolean, a new announcement would be swallowed by last month's
 * dismissal. The studio says this out loud where the wording is edited.
 *
 * ⚠ THE KEY IS PASSED AS A `data-` ATTRIBUTE, NEVER INTERPOLATED INTO THE SCRIPT. The script is a fixed
 * string constant with no data in it at all, so there is nothing for a stored value to escape out of.
 * React writes the value into the attribute with its own escaping.
 *
 * WITH JAVASCRIPT UNAVAILABLE the band stays and the dismiss button does nothing. That is the deliberate
 * trade: hiding the button until scripting proves itself would mean React rendering an attribute the
 * pre-paint script must immediately contradict, which is a hydration mismatch on the one element that
 * must never flicker. A band that cannot be dismissed is a band; a flashing band is a fault.
 *
 * NO MOTION, DELIBERATELY. An entrance animation would need a client component, which would reintroduce
 * the flash above, and a band that slides in over the header is the reader's first impression of the site
 * arriving late. There is nothing to branch on `useReducedMotionPreference()` because there is nothing
 * animated (contract §8).
 *
 * THE TONE CARRIES AN ICON *AND* A WORD (contract §11). The band's colour is never the only signal:
 * "Notice", "Good news", "Please note" and "Urgent" are printed in front of the message, and the glyph
 * beside them is `aria-hidden` because the word already says it.
 */

/** The element ids the script below looks for. Fixed, because the band is mounted once per page. */
const BAND_ID = "cxa-announcement";
const DISMISS_ID = "cxa-announcement-dismiss";

interface TonePresentation {
  /** Printed in front of the message. The half of the signal that survives monochrome and print. */
  word: string;
  icon: LucideIcon;
  /**
   * Complete literal class strings — a name assembled by concatenation is purged (contract §5).
   *
   * The status ramps are literal hex and the purple ramp is literal OKLCH, so NONE of these invert, and
   * that is on purpose: an urgent notice must read the same in both themes rather than dissolving into a
   * dark canvas (contract §3). `amber-100` + `amber-800` as a PAIR — `amber-50` and `amber-200` are stock
   * Tailwind here and will not pair correctly.
   */
  band: string;
}

/**
 * The four tones, using the pairings `components/ui/Badge.tsx` defines — which the schema's own note names
 * as the only place these colours are decided: INFO → `info`, SUCCESS → `success`, WARNING → `warn`,
 * URGENT → `error`.
 *
 * The one departure is URGENT's ink: `error-700` rather than Badge's `error-600`, because this is a FILLED
 * BAND of running prose rather than a chip of two words, and `error-600` on `error-100` is too close for
 * a sentence. It is the same pairing the filled error panels in the studio use.
 *
 * Declared as a TOTAL `Record` so adding a value to the Prisma enum is a compile error here, and READ
 * through a partial view with a fallback — the two halves of the rule StatusBadge.tsx sets out. A tone
 * this build has never heard of is a real runtime case (a row written by a newer release, read after a
 * rollback), and a band reading "Notice" in the neutral treatment is a prompt to update this map where a
 * blank strip at the top of every page is a bug that ships.
 */
const TONES: Record<AnnouncementTone, TonePresentation> = {
  INFO: {
    word: "Notice",
    icon: Megaphone,
    band: "border-b border-purple-200 bg-purple-100 text-purple-700"
  },
  SUCCESS: {
    word: "Good news",
    icon: CircleCheck,
    band: "border-b border-success-600/25 bg-success-100 text-success-600"
  },
  WARNING: {
    word: "Please note",
    icon: TriangleAlert,
    band: "border-b border-amber-800/25 bg-amber-100 text-amber-800"
  },
  URGENT: {
    word: "Urgent",
    icon: CircleAlert,
    band: "border-b border-error-200 bg-error-100 text-error-700"
  }
};

const FALLBACK_TONE: TonePresentation = {
  word: "Notice",
  icon: Info,
  band: "border-b border-line-200 bg-surface-100 text-ink-900"
};

function presentationFor(tone: AnnouncementTone): TonePresentation {
  // The `Partial<>` view is the point: it forces the `??` that a total Record would let TypeScript
  // optimise away, and an unrecognised tone is exactly the runtime case. See the note above.
  const tones: Partial<Record<AnnouncementTone, TonePresentation>> = TONES;
  return tones[tone] ?? FALLBACK_TONE;
}

/**
 * The pre-paint script. A CONSTANT with no interpolation — see the header.
 *
 * `data-wired` guards against running twice, which happens on a client navigation that remounts the
 * band: a second listener would be harmless, but a second pass is work nobody asked for.
 */
const DISMISS_SCRIPT = `(function () {
  try {
    var band = document.getElementById("${BAND_ID}");
    if (!band || band.getAttribute("data-wired") === "true") return;
    band.setAttribute("data-wired", "true");

    var stamp = band.getAttribute("data-announcement") || "";
    var key = "cxa.announcement.dismissed";

    var store = null;
    try { store = window.localStorage; } catch (blocked) { store = null; }

    if (store && stamp.length > 0) {
      var seen = null;
      try { seen = store.getItem(key); } catch (blocked) { seen = null; }
      if (seen === stamp) { band.hidden = true; return; }
    }

    var button = document.getElementById("${DISMISS_ID}");
    if (!button) return;
    button.addEventListener("click", function () {
      band.hidden = true;
      try { if (store) store.setItem(key, stamp); } catch (blocked) {}
    });
  } catch (unexpected) {}
})();`;

/** `/path`, `#anchor` and `?query` are ours; anything else is another site, a mailto or a tel. */
function isInternalHref(href: string): boolean {
  return href.startsWith("/") || href.startsWith("#") || href.startsWith("?");
}

/**
 * ⚠ THE READ IS GUARDED, AND THE REASON IS NOT THIS COMPONENT — IT IS THE WHOLE BUILD.
 *
 * This runs in the `(site)` LAYOUT, so it runs for every page under it, including the ones declared
 * `force-static`. A statically exported page has no "render it on request instead" to fall back on, so
 * an unreachable database here does not degrade one band: it throws inside the export and **fails the
 * entire build**, naming whichever page happened to be exporting at the time. That is exactly what it
 * did — `docker compose build` died on `/credits` with `prisma.announcement.findFirst()` in the stack,
 * on a page that reads no database of its own and never had anything to do with announcements.
 *
 * It is worth being clear that this is not the Dockerfile being misconfigured. It sets a `DATABASE_URL`
 * it deliberately never connects to (Dockerfile §builder) precisely so the image can be built with no
 * database in reach, and `lib/prerender.ts` is the mechanism that is supposed to make that work. The
 * settings and page reads on the same render were already guarded and logged their failure and carried
 * on; this one was the last unguarded read in the layout.
 *
 * `null` IS THE HONEST FALLBACK, uniquely so here. For a listing page an empty fallback is a real loss
 * that `revalidate` has to repair, which is why `prerenderSafe` insists on one. Nothing live is this
 * component's ORDINARY state — it returns `null` and renders no band at all on most days of the year —
 * so "the database could not be reached" and "there is no announcement today" produce the identical,
 * correct screen. The cost is bounded to: a build run with no database in reach ships pages with no
 * announcement band until they revalidate.
 *
 * ⚠ AND IT IS BOUNDED FURTHER THAN IT LOOKS ON A `force-static` PAGE, which is worth saying because the
 * `prerenderSafe` header warns about exactly that pairing. Such a page bakes whatever this returns at
 * build time and never revalidates — but that is already true of the announcement band there with or
 * without this guard, because `force-static` is what freezes it. The guard changes a failed build into
 * a page with no band; it does not introduce the staleness.
 */
export async function AnnouncementBar() {
  const announcement = await prerenderSafe(
    "AnnouncementBar",
    () =>
      prisma.announcement.findFirst({
        where: activeAnnouncementWhere(new Date()),
        // See the header: the most recently written live announcement is the one readers see, and the
        // studio says so in those words.
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          message: true,
          href: true,
          linkLabel: true,
          tone: true,
          dismissible: true,
          // Part of the dismissal key, not display. An edit to the wording must reach somebody who
          // dismissed the version before it — see the header.
          updatedAt: true
        }
      }),
    null
  );

  // Nothing live is the normal state of this component, and it renders NOTHING rather than an empty
  // strip — a 1px band with no words in it reads as a rendering fault.
  if (!announcement) return null;

  const message = announcement.message.trim();
  if (message.length === 0) return null;

  const tone = presentationFor(announcement.tone);
  const ToneIcon = tone.icon;

  /** The dismissal key: this announcement, in this wording. See the header. */
  const stamp = `${announcement.id}:${announcement.updatedAt.toISOString()}`;

  const href = announcement.href?.trim() ?? "";
  /**
   * A link with no words of its own gets "Read more" rather than being dropped.
   *
   * The opposite decision from `cta()` in lib/sections/schema.ts, which draws nothing without both halves
   * — and the difference is that a button is optional furniture whereas an announcement's link is the
   * reason the announcement exists. Silently withholding it would leave a reader told about a deadline
   * with no way to reach it. The studio nags for real words instead, and says what the fallback reads.
   */
  const linkLabel = announcement.linkLabel?.trim() ?? "";
  const linkWords = linkLabel.length > 0 ? linkLabel : "Read more";
  const external = href.length > 0 && !isInternalHref(href);

  return (
    <>
      {/*
        A real landmark with a real name. `role="region"` is stated rather than left to `<aside>`'s
        implicit `complementary`, because a named region is what lets a screen-reader user jump to the
        announcement and back out of it; `aria-label` is what names it in that list.

        `suppressHydrationWarning` because the script below may have set `hidden` on this element before
        React reaches it. React never rendered that attribute, so there is nothing for it to patch back —
        the flag only silences the development warning about an attribute that appeared from outside.
      */}
      <aside
        id={BAND_ID}
        data-announcement={stamp}
        role="region"
        aria-label="Announcement"
        suppressHydrationWarning
        className={cn("relative", tone.band)}
      >
        <div className="shell flex items-start gap-2.5 py-2.5 sm:items-center sm:gap-3">
          <ToneIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 sm:mt-0" />

          <p className="min-w-0 flex-1 text-pretty text-sm leading-relaxed">
            {/* The word half of the signal. Colour never carries meaning alone (contract §11). */}
            <span className="font-semibold">{tone.word}.</span> {message}
            {href.length > 0 ? (
              <>
                {" "}
                {/*
                  The link takes the band's own ink through `currentColor` rather than the purple action
                  colour. Purple-700 on an amber or a red band fails contrast, and a link nobody can read
                  is worse than a link that is not purple; the underline and the weight are what mark it
                  as a link. This is the one place on the public site where an action is not purple, and
                  the reason is legibility rather than decoration (contract §1.1).
                */}
                {external ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold underline decoration-2 underline-offset-2"
                  >
                    {linkWords}
                    {/* Announced, because focus landing in a new tab loses a reader their Back button. */}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                ) : (
                  <Link
                    href={href}
                    className="font-semibold underline decoration-2 underline-offset-2"
                  >
                    {linkWords}
                  </Link>
                )}
              </>
            ) : null}
          </p>

          {/*
            A NON-DISMISSIBLE BANNER RENDERS NO BUTTON AT ALL rather than a dead one, as the schema's note
            requires — the same rule as contract §1.8. The glyph is `aria-hidden` because `aria-label`
            already names the control.
          */}
          {announcement.dismissible ? (
            <button
              type="button"
              id={DISMISS_ID}
              aria-label="Dismiss this announcement"
              className="-mr-1.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition hover:bg-black/5"
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </aside>

      {/*
        AFTER the band, so the element it reaches for has already been parsed, and inline rather than a
        Next `<Script>`: every strategy that component offers runs later than the first paint, which is
        the one thing this must not do.
      */}
      {announcement.dismissible ? (
        <script dangerouslySetInnerHTML={{ __html: DISMISS_SCRIPT }} />
      ) : null}
    </>
  );
}

/*
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHERE THIS IS MOUNTED — AND IT MUST BE MOUNTED, OR THE WHOLE FEATURE IS DEAD.
 *
 * ⚠ This note once read "deliberately NOT mounted by this branch" while prescribing the mount below as
 * fact, and the mount was never made: the studio's announcements screen told editors a closure notice
 * was live while no public page could draw it. There is no such thing as an announcement that is
 * switched on and not shown — the model, `activeAnnouncementWhere()` and that screen all exist for the
 * one purpose of putting these words in front of a visitor. If this component has no call site, the
 * feature is broken, not configured off.
 *
 * In `app/(site)/layout.tsx`, as the FIRST CHILD of `<main id="main-content">`:
 *
 *     <main id="main-content" tabIndex={-1} className="page-top flex-1 outline-none">
 *       <AnnouncementBar />
 *       {children}
 *     </main>
 *
 * Inside `<main>` and not above it, for two reasons that both come from the header:
 *
 *   • `SiteHeader` is a `position: fixed` floating pill. It occupies NO flow space, so a band placed
 *     before it in the document would be painted underneath it and the words would be hidden.
 *   • `.page-top` on `<main>` is the ONE place the `--nav-clearance` contract is paid (contract §7). A
 *     band outside `<main>` would need its own top padding, which is a second number meaning the same
 *     thing — exactly how three numbers for one clearance drifted apart upstream.
 *
 * It sits after `#main-content` in the document, so a reader using the skip link lands on the
 * announcement first, which is the right order for something the Centre thought worth saying.
 *
 * It is NOT mounted in `app/studio/layout.tsx`. The studio is a working surface, and a band announcing a
 * public closure over an editor's toolbar is chrome in the way of the job; the announcements screen is
 * where a member of staff sees the same information, with its dates.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */
