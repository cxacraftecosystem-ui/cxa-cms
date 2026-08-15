/**
 * Every address the newsletter feature has, written down ONCE.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS, AND WHAT WAS ACTUALLY WRONG BEFORE IT DID.
 *
 * The newsletter is spread across eight places that all have to agree about six strings:
 *
 *   • `tokens.ts` builds the two links an EMAIL carries.
 *   • `delivery.ts` prints the sign-up address in the unsubscribe receipt.
 *   • the three route handlers redirect a no-script browser back to a PAGE with a `?state=` code.
 *   • the three pages read that code and POST to a route HANDLER.
 *   • `NewsletterSignup` posts to the same handler twice — once as a plain `<form action>` and once
 *     through `fetch` — and the two must be the same address or the enhanced path works while the
 *     plain one silently does not.
 *
 * Every one of those was, or would have been, a hand-typed string literal. That is how this repository
 * produced its signature defect twice already: the studio's preview panel pointed an iframe at a route
 * that had never existed, and `tokens.ts` shipped `newsletterConfirmUrl()` pointing at
 * `/newsletter/confirm` when no such page existed anywhere in the application — so every confirmation
 * link the feature composed was a 404, and nothing in the repository could notice.
 *
 * ⚠ THE `/api/...` STRINGS ARE DELIBERATELY WRITTEN AS LITERALS HERE, NOT ASSEMBLED. `scripts/route-check.ts`
 * scans `app`, `components` and `lib` for `/api/...` literals and resolves each one against the handler
 * Next would actually route it to. Its first documented blind spot is "a path assembled entirely from a
 * variable has no literal to find and is skipped" — so a clever `` `${API_BASE}/subscribe` `` here would
 * buy nothing and would switch the one mechanical check that covers this class of defect off for the
 * whole feature. Written out in full, `npm run route-check` covers all three endpoints from this file.
 *
 * NOT `server-only`: the pages, the sign-up component and the route handlers all import from it, and
 * there is nothing here that a reader cannot already see in their address bar.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────────────────────
// The pages a reader can be looking at
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The sign-up page, and the page a no-script sign-up is redirected back to.
 *
 * ⚠ Also printed verbatim in the unsubscribe receipt (`sendUnsubscribeReceipt` in delivery.ts) as the
 * way back for somebody who changes their mind, which is why it is a constant rather than being spelled
 * out in the message body: a message telling a former subscriber to visit a page that has moved is a
 * dead end they cannot report to anybody.
 */
export const NEWSLETTER_PATH = "/newsletter";

/**
 * Where the CONFIRMATION LINK IN AN EMAIL lands.
 *
 * ⚠ A PAGE, NOT THE MUTATING ROUTE, and the header of `tokens.ts` sets out why at length: corporate mail
 * gateways and "safe links" scanners fetch every URL in every message before a person sees it, so a
 * confirmation that mutated on GET would be clicked by a security appliance and the double opt-in would
 * quietly become a single one.
 */
export const NEWSLETTER_CONFIRM_PATH = "/newsletter/confirm";

/** Where the UNSUBSCRIBE LINK IN AN EMAIL lands. Same reasoning as the confirmation page. */
export const NEWSLETTER_UNSUBSCRIBE_PATH = "/newsletter/unsubscribe";

// ─────────────────────────────────────────────────────────────────────────────
// The handlers that change something
// ─────────────────────────────────────────────────────────────────────────────

/** POST only. `components/site/NewsletterSignup.tsx` posts here by both of its paths. */
export const NEWSLETTER_SUBSCRIBE_ENDPOINT = "/api/public/newsletter/subscribe";

/** POST only. The form on `NEWSLETTER_CONFIRM_PATH` submits here. */
export const NEWSLETTER_CONFIRM_ENDPOINT = "/api/public/newsletter/confirm";

/** POST only. The form on `NEWSLETTER_UNSUBSCRIBE_PATH` submits here. */
export const NEWSLETTER_UNSUBSCRIBE_ENDPOINT = "/api/public/newsletter/unsubscribe";

// ─────────────────────────────────────────────────────────────────────────────
// Where the reader's attention has to go afterwards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `id` of the outcome panel on all three pages, and the fragment every `303` redirect ends with.
 *
 * ══ WHY A FRAGMENT IS PART OF THE REDIRECT AND NOT A DETAIL OF THE PAGE ══
 *
 * The no-script path is a full-page navigation: the browser lands on a fresh document and puts focus at the
 * top of it. A reader who submitted the form with the keyboard — or with a screen reader — is therefore
 * returned to a page whose one important sentence is several inches below the fold, with nothing to say it
 * is there. They have no way to tell a successful sign-up from a form that did nothing.
 *
 * Ending the `Location` with `#outcome` fixes it in the one place that covers all three pages: the browser
 * scrolls to that element and, because the element carries `tabIndex={-1}`, MOVES FOCUS to it — so the
 * panel's `role="status"` or `role="alert"` is read out and the next Tab continues from there.
 *
 * ⚠ THE TARGET MUST STAY FOCUSABLE. A fragment pointing at an element with no `tabindex` moves the scroll
 * position and nothing else, which is the same trap `app/(site)/layout.tsx` documents about its skip link.
 * `StateNotice` is the only renderer of this id and it carries `tabIndex={-1}` for exactly this reason.
 *
 * ⚠ IT LIVES HERE RATHER THAN IN THE COMPONENT because `newsletterStatePath()` in lib/newsletter/http.ts
 * writes it into the redirect and `StateNotice` renders it as an attribute — two files, one string. A lib
 * module must not import from `app/`, so the shared constant belongs on this side of that line.
 */
export const NEWSLETTER_OUTCOME_ID = "outcome";
