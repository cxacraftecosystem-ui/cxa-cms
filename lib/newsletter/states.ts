import type { NewsletterStateCode } from "@/lib/newsletter/http";

/**
 * What each `?state=` code SAYS to a reader, per page.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A TABLE AND NOT PROSE IN THREE PAGE FILES.
 *
 * The three newsletter route handlers answer in two shapes (lib/newsletter/http.ts explains why): a JSON
 * body carrying a finished sentence for the sign-up component, and — for a browser with no JavaScript — a
 * `303 See Other` carrying only a CODE. The code is meaningless on its own; the destination page has to
 * turn it back into a sentence.
 *
 * ⚠ `state` CARRIES A CODE AND NEVER A SENTENCE, and this table is the reason it can. A free-text message
 * taken out of the query string would let anybody craft a link that shows a reader any message they liked
 * over the Centre's own branding — the same rule the studio's `?problem=` codes follow. A code that is not
 * in this table renders NOTHING, which is the safe direction: a missing banner is a page that simply looks
 * ordinary, where an unfiltered one is a phishing surface.
 *
 * ⚠ THE SAME CODE MEANS DIFFERENT THINGS ON DIFFERENT PAGES, WHICH IS WHY THIS IS KEYED BY SURFACE FIRST.
 * `not-found` on the confirmation page means "there is no sign-up waiting for that address"; on the
 * unsubscribe page it means "that address is not on the list, so there is nothing to stop" — and those two
 * need opposite tones, because the first is a dead end and the second is the outcome the reader wanted. A
 * single flat map would have had to pick one of them and be wrong on the other page.
 *
 * ⚠ AND THE COUNTERPART SENTENCE LIVES IN THE ROUTE HANDLER. Each entry below names the branch that emits
 * it, so the pair can be read together. They are allowed to differ in detail — a JSON caller can be told
 * "that link has been superseded" where the page can only know "bad-link" — but they must never
 * CONTRADICT: if you reword one, open the other. Where one code covers more than one route branch, the
 * wording here is deliberately written to be true of all of them.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** Which page is showing the notice. Each has its own vocabulary — see the header. */
export type NewsletterSurface = "signup" | "confirm" | "unsubscribe";

export interface NewsletterNotice {
  /**
   * Drives the panel's colour AND its ARIA role.
   *
   * ⚠ `problem` renders `role="alert"` and everything else renders `role="status"`. The reader has just
   * been stopped only in the `problem` case, and that is the one case that warrants interrupting a screen
   * reader mid-sentence — the same split `app/studio/redirects/page.tsx` makes.
   */
  tone: "done" | "waiting" | "problem";
  /** A short headline. A complete clause, never a label like "Error". */
  title: string;
  /** What happened and what to do about it. Always says whether anything was saved. */
  body: string;
}

const SIGNUP: Partial<Record<NewsletterStateCode, NewsletterNotice>> = {
  /** ← `subscribe` route, the single success path (every address, identically). */
  sent: {
    tone: "waiting",
    title: "Nearly there — one more click",
    body:
      "If that address can receive mail, a message is on its way to it with a link to confirm. Nothing " +
      "will be sent to you until you open that link, and the link works for three days. If nothing " +
      "arrives within a few minutes, look in the folder your mail programme files bulk mail in."
  },
  /** ← `subscribe` route, `normaliseEmail` returned null. */
  invalid: {
    tone: "problem",
    title: "That address could not be read",
    body:
      "Nothing has been saved. Check for a missing @ or a typo in the part after it, and try again — the " +
      "form below is ready."
  },
  /** ← `subscribe` route, the consent field was absent (an unticked box sends nothing at all). */
  consent: {
    tone: "problem",
    title: "The consent box was not ticked",
    body:
      "Nothing has been saved. The Centre only sends its newsletter to somebody who has asked for it in " +
      "as many words, so the box below has to be ticked before an address can be recorded."
  },
  /** ← `subscribe` route, `consentTextFor()` did not recognise the version the page posted. */
  stale: {
    tone: "problem",
    title: "This page was open before the wording changed",
    body:
      "Nothing has been saved. What you agreed to and what would have been recorded are not the same " +
      "thing, and recording the wrong one would be worse than asking again. Reload this page and sign up " +
      "once more; it takes a moment."
  },
  /** ← `enforceNewsletterRateLimit`, which also sets a `Retry-After` header on the redirect. */
  busy: {
    tone: "problem",
    title: "This form is paused for a few minutes",
    body:
      "It has been used several times from your connection in the last few minutes. Nothing has been " +
      "lost — and if you have already signed up, the confirmation email is on its way and you do not " +
      "need to send this again."
  }
};

const CONFIRM: Partial<Record<NewsletterStateCode, NewsletterNotice>> = {
  /** ← `confirm` route, the guarded `updateMany` that won. The welcome message is sent on this path. */
  confirmed: {
    tone: "done",
    title: "Your subscription is confirmed",
    body:
      "This address will receive the newsletter from the next issue onwards, and nothing else. Every " +
      "message carries a link that stops them again in one click, without signing in to anything — that " +
      "link does not expire, so it is worth keeping."
  },
  /** ← `confirm` route, both the fast path and the loser of a two-click race. */
  "already-confirmed": {
    tone: "done",
    title: "That address is already confirmed",
    body:
      "There was nothing left to do, and no second subscription has been created. This is what you " +
      "should see if you open the confirmation link twice, so nothing has gone wrong."
  },
  /** ← `confirm` route, either the signed expiry or the row's own `confirmationExpiresAt`. */
  expired: {
    tone: "problem",
    title: "That confirmation link has expired",
    body:
      "Nothing has been changed. Confirmation links are given a short life on purpose, so that one " +
      "sitting in a forwarded message cannot be used to subscribe somebody else. Sign up again and a " +
      "fresh link will be sent."
  },
  /**
   * ← `confirm` route, three branches: an unreadable or forged token, a nonce that no longer matches the
   * row, and the rare lost race. All three are true of this wording.
   */
  "bad-link": {
    tone: "problem",
    title: "That confirmation link could not be used",
    body:
      "Nothing has been changed. Mail programmes sometimes break a long link across two lines, so " +
      "copying the whole address out of the message and pasting it into your browser often fixes it. It " +
      "will also have stopped working if a newer confirmation email has since been sent, or if this " +
      "address has been unsubscribed. Signing up again sends a fresh link."
  },
  /** ← `confirm` route, no row for that address, or a row whose record has been erased. */
  "not-found": {
    tone: "problem",
    title: "There is no sign-up waiting for that address",
    body:
      "So there was nothing to confirm, and nothing has been changed. If you would like the newsletter, " +
      "signing up again will send a fresh confirmation link."
  },
  /** ← `enforceNewsletterRateLimit`. */
  busy: {
    tone: "problem",
    title: "This link is paused for a few minutes",
    body:
      "It has been used several times from your connection in the last few minutes. Your subscription is " +
      "unaffected — wait a moment and open the link again."
  }
};

const UNSUBSCRIBE: Partial<Record<NewsletterStateCode, NewsletterNotice>> = {
  /** ← `unsubscribe` route: a fresh transition, an already-unsubscribed row, and a lost race alike. */
  unsubscribed: {
    tone: "done",
    title: "That address has been removed",
    body:
      "Nothing further will be sent to it. The Centre keeps a note that you asked to stop — and nothing " +
      "else — so that a later import cannot put you back on the list by accident. If you ever want the " +
      "newsletter again, you are welcome to sign up."
  },
  /**
   * ← `unsubscribe` route, no row or an erased one.
   *
   * ⚠ TONE `done`, NOT `problem`, AND THAT IS THE POINT. The reader clicked "unsubscribe" and what they
   * wanted — not to be sent this — is already true. A page headed "not found" after that click reads as a
   * broken link, and their next move is a spam report rather than a second attempt.
   */
  "not-found": {
    tone: "done",
    title: "That address is not on the newsletter list",
    body:
      "There was nothing to remove, and you will not be sent it. If messages do keep arriving, they are " +
      "not coming from this newsletter — forward one to the Centre using the contact page and somebody " +
      "will find out what is sending them."
  },
  /** ← `unsubscribe` route, an unreadable or forged token. */
  "bad-link": {
    tone: "problem",
    title: "That unsubscribe link could not be read",
    body:
      "Nothing has been changed, and you have NOT been unsubscribed. Mail programmes sometimes break a " +
      "long link across two lines, so copying the whole address out of the message and pasting it into " +
      "your browser usually fixes it. The link at the foot of any newer message will also work — or " +
      "write to the Centre using the contact page and your address will be removed by hand."
  },
  /** ← `enforceNewsletterRateLimit`, the loosest of the three limits for exactly this reason. */
  busy: {
    tone: "problem",
    title: "This is paused for a few minutes",
    body:
      "It has been used several times from your connection in the last few minutes. If you have already " +
      "unsubscribed, it worked — nothing more will be sent to that address."
  }
};

const BY_SURFACE: Record<NewsletterSurface, Partial<Record<NewsletterStateCode, NewsletterNotice>>> = {
  signup: SIGNUP,
  confirm: CONFIRM,
  unsubscribe: UNSUBSCRIBE
};

/**
 * The notice for a `?state=` value, or `null`.
 *
 * ⚠ TAKES A RAW `string | undefined` STRAIGHT OFF THE QUERY STRING and narrows here, once. The
 * alternative — casting to `NewsletterStateCode` at each call site — is a cast that asserts something
 * about a value a stranger controls, which is the shape of every "impossible" runtime error. An
 * unrecognised code, a repeated parameter, or a hand-crafted link all resolve to `null` and the page shows
 * no banner at all.
 */
export function newsletterNotice(
  surface: NewsletterSurface,
  state: string | string[] | undefined
): NewsletterNotice | null {
  // `parseQuery`'s documented rule, applied here too: a repeated parameter collapses to the FIRST value.
  // Nothing legitimately repeats `state`, and taking one defined value beats rendering "sent,confirmed".
  const code = Array.isArray(state) ? state[0] : state;
  if (typeof code !== "string" || code.length === 0) return null;
  return BY_SURFACE[surface][code as NewsletterStateCode] ?? null;
}
