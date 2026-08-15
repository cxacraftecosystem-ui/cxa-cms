import { CircleCheck, MailCheck, TriangleAlert } from "lucide-react";

import { NEWSLETTER_OUTCOME_ID } from "@/lib/newsletter/paths";
import type { NewsletterNotice } from "@/lib/newsletter/states";
import { cn } from "@/lib/utils";

/**
 * The banner the three newsletter pages show after a form POST.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS ONE COMPONENT AND NOT THE SAME FOURTEEN LINES OF MARKUP IN THREE PAGES.
 *
 * All three pages are the destination of a `303 See Other` from a route handler, and all three have to
 * turn a `?state=` code into a panel. The panel has three properties that are easy to get subtly wrong
 * and impossible to notice: its ARIA role, its colour discipline, and its focus behaviour. Written three
 * times, one of the three would eventually be an `alert` where it should be a `status`, or a themed
 * paragraph on a literal-coloured panel. Written once, they cannot differ.
 *
 * A SERVER COMPONENT. It renders text and an icon; there is no state and no handler, so marking it
 * `"use client"` would push it into the JavaScript bundle of every page that carries it for no behaviour.
 *
 * ⚠ `role="alert"` ONLY FOR A PROBLEM. The reader has just tried to do something and been stopped, which
 * is the one case that justifies interrupting a screen reader mid-sentence. A success or a "we have sent
 * you a link" is `role="status"`, which is announced at the next natural pause. `app/studio/redirects/page.tsx`
 * makes the same split; getting it the wrong way round means either an outcome nobody hears or an
 * interruption on every ordinary page view.
 *
 * ⚠ `tabIndex={-1}` AND `NEWSLETTER_OUTCOME_ID`, BECAUSE FOCUS HAS TO LAND HERE. These pages arrive by a
 * full-page redirect: the browser puts focus back at the top of the document, so a reader who submitted the
 * form with the keyboard would have no idea a banner appeared several inches below. Every one of those
 * redirects therefore ends with `#outcome` — `newsletterStatePath()` in lib/newsletter/http.ts appends it —
 * and THIS is the element it names. The `tabIndex` is what makes the difference between moving focus and
 * merely moving the scroll position; an unfocusable fragment target does the latter and announces nothing,
 * which is the same trap `app/(site)/layout.tsx` documents about its skip link.
 *
 * ⚠ SO DO NOT REMOVE THE `tabIndex` OR RENAME THE `id`. Both failures are silent: the page renders exactly
 * as before and only the announcement disappears.
 *
 * ⚠ A THEMED SURFACE WITH LITERAL-COLOURED HEADINGS, NEVER A `bg-success-100` PANEL WITH THEMED TEXT.
 * The status ramps are literal oklch and deliberately do not invert (contract §3); the `ink-*` ladder
 * does. Put a `text-ink-700` paragraph on a pale green panel and it is near-white on pale green under
 * `data-theme="dark"` — invisible, in one theme only, which is how this class of bug survives review. So
 * the panel is the ordinary card surface, the border and the heading carry the status colour, and the body
 * text stays on the themed ladder where it is legible in both. `EventRegistration` and `NewsletterSignup`
 * both document the same rule.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export interface StateNoticeProps {
  notice: NewsletterNotice;
  /** ⚠ `h2` unless the page already has an `h2` above this point. Never skip a level (contract §11). */
  headingLevel?: 1 | 2;
  className?: string;
}

/** Border colour per tone. The panel body is always the themed card surface — see the header. */
const TONE_BORDER = {
  done: "border-success-600/25",
  waiting: "border-purple-200",
  problem: "border-error-200"
} as const;

/** Heading colour per tone. Literal status colours, which is why the body text is not one of them. */
const TONE_HEADING = {
  done: "text-success-600",
  waiting: "text-purple-700",
  problem: "text-error-700"
} as const;

/**
 * Icon per tone — the non-colour half of the signal.
 *
 * Colour alone never carries meaning (contract §11): a reader who cannot distinguish the green from the
 * red gets the same information from the tick, the envelope and the triangle.
 */
const TONE_ICON = {
  done: CircleCheck,
  waiting: MailCheck,
  problem: TriangleAlert
} as const;

export function StateNotice({ notice, headingLevel = 2, className }: StateNoticeProps) {
  const Icon = TONE_ICON[notice.tone];
  const Heading = headingLevel === 1 ? "h1" : "h2";

  return (
    <div
      id={NEWSLETTER_OUTCOME_ID}
      tabIndex={-1}
      role={notice.tone === "problem" ? "alert" : "status"}
      className={cn(
        "rounded-lg border bg-card p-5 shadow-sm outline-none sm:p-6",
        TONE_BORDER[notice.tone],
        className
      )}
    >
      <Heading
        className={cn(
          "flex items-start gap-2.5 font-display text-lg font-semibold leading-snug",
          TONE_HEADING[notice.tone]
        )}
      >
        <Icon aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
        {notice.title}
      </Heading>

      <p className="prose-measure mt-3 text-sm leading-relaxed text-ink-700">{notice.body}</p>
    </div>
  );
}
