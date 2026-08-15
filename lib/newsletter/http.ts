import "server-only";

import { NextResponse } from "next/server";
import type { ZodType, ZodTypeDef } from "zod";

import { ApiError, badRequest, describeZodError, toErrorResponse } from "@/lib/api";
import { NEWSLETTER_OUTCOME_ID } from "@/lib/newsletter/paths";
import {
  checkRateLimit,
  rateLimitResponse,
  retryAfterPhrase,
  type RateLimitPolicy
} from "@/lib/ratelimit";

/**
 * The plumbing that lets the three newsletter routes answer BOTH a browser with no JavaScript and a
 * `fetch` from the sign-up component — with one parser, one schema and one code path.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE PROBLEM THIS FILE SOLVES, AND WHY IT IS NOT `parseJson`.
 *
 * The newsletter form has to work with scripting switched off. That means a real `<form method="post">`
 * — and a real form POST differs from every other write in this application in two ways that reach all
 * the way into the response:
 *
 *   1. **The body is `application/x-www-form-urlencoded`, not JSON.** `parseJson` (lib/api.ts) would
 *      answer "The request body was not valid JSON" to every reader whose browser did exactly what the
 *      HTML told it to.
 *   2. **The answer must be a REDIRECT, not a JSON document.** A browser that submitted a form and
 *      received `{"received":true}` renders that literally: the reader is left staring at a line of
 *      JSON on a blank page, having lost the site entirely. The correct answer to a form POST is
 *      `303 See Other` to a page that says what happened.
 *
 * So: the body is read from whichever format arrived, and the SHAPE OF THE ANSWER is decided by the
 * `Accept` header — the one signal that reliably distinguishes "a browser navigating" from "a script
 * that will read a body". A native form POST sends `Accept: text/html,…`; the sign-up component sends
 * `accept: application/json` explicitly.
 *
 * ⚠ THE COMPONENT POSTS THE **SAME URL-ENCODED BODY** THE NO-SCRIPT PATH DOES, deliberately. It builds
 * it with `new FormData(form)` and lets `fetch` encode it. That is what keeps the two paths honest:
 * there is one body format, one Zod schema and one set of field names, so the enhanced path cannot
 * quietly start working while the plain one rots. Two body formats would mean two schemas, and the
 * no-script path is the one nobody would notice had broken.
 *
 * ⚠ EVERY FIELD ARRIVES AS A STRING, including the ones that mean a number or a boolean. HTML has no
 * other kind of value. The schemas in the routes therefore coerce rather than expecting types, and an
 * unticked checkbox is ABSENT from the body rather than `false` — which is why "consent" is validated
 * as "present and equal to the value the input carries", never as a boolean.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * Every newsletter rate limit, in one object, for the reason `RATE_LIMITS` in lib/ratelimit.ts gives:
 * so the number a route ENFORCES and the number its sentence QUOTES cannot drift apart.
 *
 * ⚠ THESE LIVE HERE RATHER THAN IN `RATE_LIMITS` PURELY BECAUSE OF FILE OWNERSHIP in the session that
 * built this feature — lib/ratelimit.ts was not this author's to edit. `enforceRateLimit` takes a
 * policy object, so nothing is lost functionally; what IS lost is the property that "what are the
 * limits on the public API" is answerable by reading one object. Folding these three keys into
 * `RATE_LIMITS` and deleting this constant is a mechanical change and is recorded in the handover.
 *
 * The shapes differ on purpose, and the third one is the interesting one:
 *
 *   • **Signing up** is a once-ever act. Five in a quarter of an hour is a genuine attempt, a typo, a
 *     second address for a colleague, and two more mistakes. It is useless for a script.
 *   • **Confirming** is where a token is presented, so it is the one place a token could be guessed.
 *     The token is far too long to guess; the limit exists so that remains true if it is ever
 *     shortened, and so a broken mail client retrying in a loop cannot hammer the route.
 *   • **Unsubscribing is deliberately the loosest of the three.** Refusing an unsubscribe is the worst
 *     refusal available in this feature: the reader's conclusion is that the Centre will not let them
 *     stop, and their next move is a spam report or a complaint to a regulator. A shared office behind
 *     one address getting six people's unsubscribes in an afternoon must not hit a wall.
 */
export const NEWSLETTER_RATE_LIMITS = {
  signup: { limit: 5, windowSeconds: 15 * 60 },
  confirm: { limit: 10, windowSeconds: 15 * 60 },
  unsubscribe: { limit: 20, windowSeconds: 15 * 60 }
} as const satisfies Record<string, RateLimitPolicy>;

/**
 * How long before another confirmation email may be sent to the SAME address.
 *
 * ══ THIS IS NOT A RATE LIMIT, AND IT DEFENDS A DIFFERENT PERSON. ══
 *
 * The limits above protect the SERVER from one connection. This protects a THIRD PARTY from the form:
 * without it, anybody could type a colleague's address into the sign-up box repeatedly and this
 * application would obligingly send that colleague one email per submission. The rate limit does not
 * help, because the attacker is well within it — five sign-ups an hour, sustained for a week, is a
 * campaign of harassment conducted entirely through legitimate use.
 *
 * So a repeat sign-up inside this window still answers the reader identically, and simply does not
 * hand a second message to the delivery seam. Measured from `confirmationSentAt` on the row.
 */
export const CONFIRMATION_RESEND_COOLDOWN_MINUTES = 15;

/** The `?state=` codes the newsletter pages understand. ⚠ CODES, NEVER SENTENCES — see `refuse`. */
export type NewsletterStateCode =
  | "sent"
  | "invalid"
  | "consent"
  | "stale"
  | "busy"
  | "confirmed"
  | "already-confirmed"
  | "expired"
  | "bad-link"
  | "unsubscribed"
  | "not-found";

/**
 * ⚠ `NewsletterSchema<T>` RATHER THAN ZOD'S OWN `ZodSchema<T>`, AND THIS IS NOT A STYLE PREFERENCE.
 *
 * `ZodSchema<T>` is `ZodType<T, ZodTypeDef, T>` — it declares that the schema's INPUT and its OUTPUT are
 * the same type. That is true of a plain `z.object({ a: z.string() })` and FALSE of every schema in this
 * feature, because they all use `.default("")`: the input accepts a missing key, the output never has one.
 * Handed such a schema, TypeScript has to satisfy both `Output = T` and `Input = T`, resolves `T` to the
 * INPUT shape, and every field arrives at the call site as `string | undefined`.
 *
 * The symptom is the reason this is written down: it does not look like a variance problem. It looks like
 * "Zod's `.default()` is broken", and the tempting fixes are all wrong in the same direction — sprinkling
 * `?? ""` at every read (dead code that hides the real types), or `.optional().default("")` (which really
 * does put `undefined` in the output), or a cast. Declaring the input as `unknown` — which is the truth: it
 * is a request body — lets `T` be inferred from the output alone, and the defaults then mean what they say.
 */
export type NewsletterSchema<T> = ZodType<T, ZodTypeDef, unknown>;

/**
 * ⚠ DELIBERATELY NOT EXPORTED. It is the return shape of the private `readNewsletterSubmission` and
 * nothing outside this file can see either. `readNewsletterBody` — the one way in — returns
 * `NewsletterBody<T>` instead, because a caller must be handed a finished refusal rather than a throw.
 *
 * Exporting it would add a name to this module's surface that nothing imports, which is the defect this
 * repository keeps producing in its smallest form: an export with no consumer is indistinguishable from a
 * loose end, and the next reader has to grep the tree to find out which it is.
 */
interface NewsletterSubmission<T> {
  data: T;
  /**
   * True when the caller will read a body: answer with JSON. False when a browser is navigating:
   * answer with a redirect. Decided from `Accept` — see the header.
   */
  wantsJson: boolean;
}

/**
 * Does this caller want a body it can parse, or a page it can render?
 *
 * ⚠ EXPORTED, AND THE ROUTES CALL IT **BEFORE** THEY READ THE BODY. The rate limit has to answer in the
 * caller's own shape, and it runs first — `app/api/public/contact/route.ts` states the rule this follows:
 * a refusal should cost as little as possible, and a script sending megabytes of body should not have it
 * read. So the shape of the answer is decided from a header, which is free, rather than from the return
 * value of the parser, which is not.
 *
 * `readNewsletterSubmission` calls this same function rather than repeating the test, so there is one
 * implementation of "who is asking" and the limiter's answer and the handler's answer can never disagree
 * about it.
 */
export function newsletterWantsJson(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  // A browser's form POST sends `text/html,application/xhtml+xml,…` and, in some versions, a trailing
  // `*/*`. Testing for "application/json" specifically — rather than "not text/html" — means the
  // DEFAULT for anything ambiguous is the redirect, which is the answer that cannot strand a reader on
  // a page of JSON. A script that wanted JSON and forgot to ask for it gets a 303 it can follow.
  return accept.includes("application/json");
}

/**
 * Read the body, whichever way it arrived, and validate it.
 *
 * ⚠ `request.formData()` THROWS on a body that is not form-encoded, and `request.json()` throws on one
 * that is not JSON — both are turned into a 400 with a sentence rather than being allowed to become a
 * 500. The request never reached the handler's logic, so calling it a server error would send an
 * operator looking in the wrong place (the same argument `parseJson` makes).
 *
 * ⚠ A REPEATED FIELD COLLAPSES TO THE LAST VALUE, matching `parseQuery`'s documented behaviour and
 * `URLSearchParams.get`. No newsletter field is legitimately repeated, and a body carrying `email`
 * twice is a script probing for a parser difference — taking the last is at least a defined answer.
 *
 * ⚠ A FILE UPLOAD IS DISCARDED. `formData()` yields a `File` for a file input; every value is coerced
 * to a string, and a `File` becomes something Zod will reject. Nothing here accepts an upload, and
 * that is the correct outcome rather than a crash on `.trim()`.
 */
async function readNewsletterSubmission<T>(
  request: Request,
  schema: NewsletterSchema<T>
): Promise<NewsletterSubmission<T>> {
  const wantsJson = newsletterWantsJson(request);
  const contentType = request.headers.get("content-type") ?? "";

  let raw: unknown;

  if (contentType.includes("application/json")) {
    try {
      raw = await request.json();
    } catch {
      throw badRequest("The request body was not valid JSON.");
    }
  } else {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw badRequest(
        "The form could not be read. Reload the page and try again — nothing has been saved."
      );
    }
    const entries: Record<string, string> = {};
    form.forEach((value, key) => {
      entries[key] = typeof value === "string" ? value : "";
    });
    raw = entries;
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const { message, fieldErrors } = describeZodError(result.error);
    throw new ApiError(422, message, { code: "validation_failed", fieldErrors });
  }

  return { data: result.data, wantsJson };
}

/**
 * The body, or a finished response that says why not — never a throw.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS WRAPPER IS THE WHOLE POINT, AND WITHOUT IT THIS FILE'S HEADER WAS A PROMISE THE CODE BROKE.
 *
 * `readNewsletterSubmission` signals failure by THROWING an `ApiError`. Every route in this application
 * is wrapped in `route()`, which turns a throw into `toErrorResponse(error)` — a **JSON document**. For
 * the sign-up component that is exactly right. For a browser that submitted a real `<form>` with
 * scripting switched off it is the precise failure the header of this file says must never happen: the
 * reader is left staring at `{"error":true,"message":"…"}` on a blank page, having lost the site.
 *
 * So the throw is caught HERE, once, rather than in three route handlers that would each have to
 * remember to. The JSON caller still gets the house error body, byte for byte, because the same
 * `ApiError` is handed to the same `toErrorResponse`. The browser gets a 303 to a page that explains
 * itself.
 *
 * ⚠ AN UNEXPECTED ERROR IS RE-THROWN, DELIBERATELY. Only an `ApiError` is a refusal this layer
 * understands. A `TypeError` from a broken stream is a BUG, and swallowing it into a tidy "check your
 * address" redirect would hide a server fault behind a sentence blaming the reader — so it goes back up
 * to `route()`, which logs it and answers 500. Never widen this `catch`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `fallbackState` is the code the browser is sent back with when the body could not be read at all. It
 * is per-route because the honest sentence differs: a sign-up whose body is unreadable is a form
 * problem, and a confirmation whose body is unreadable is a broken link.
 */
export type NewsletterBody<T> =
  | { ok: true; data: T; wantsJson: boolean }
  | { ok: false; response: NextResponse };

export async function readNewsletterBody<T>(
  request: Request,
  schema: NewsletterSchema<T>,
  fallback: { basePath: string; state: NewsletterStateCode }
): Promise<NewsletterBody<T>> {
  const wantsJson = newsletterWantsJson(request);

  try {
    const submission = await readNewsletterSubmission(request, schema);
    return { ok: true, data: submission.data, wantsJson: submission.wantsJson };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;

    if (wantsJson) return { ok: false, response: toErrorResponse(error) };
    return {
      ok: false,
      response: seeOther(newsletterStatePath(fallback.basePath, fallback.state))
    };
  }
}

/**
 * A `303 See Other` to a path on this site.
 *
 * ⚠ THE `Location` IS **RELATIVE**, AND THAT IS DELIBERATE RATHER THAN LAZY. `NextResponse.redirect()`
 * demands an absolute URL, which behind a proxy means building one from `request.url` — whose host is
 * the INTERNAL one, so every reader would be redirected to a hostname that does not resolve for them.
 * A relative `Location` is resolved by the browser against the address it actually asked for, which is
 * the right one by construction. RFC 7231 §7.1.2 permits it and every browser has honoured it for
 * years.
 *
 * ⚠ 303 AND NOT 302. A 302 leaves the method to the client's discretion and some clients replay the
 * POST against the new location; 303 mandates a GET. Without it, a reload of the destination page
 * could re-submit the sign-up.
 *
 * `no-store` matters: a shared proxy caching one reader's "you are subscribed" redirect would serve it
 * to the next person to submit the form.
 */
function seeOther(path: string, extraHeaders: Record<string, string> = {}): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { location: path, "cache-control": "no-store", ...extraHeaders }
  });
}

/**
 * Where a browser is sent, with a state code in the query.
 *
 * ⚠ `state` CARRIES A CODE, NEVER A SENTENCE — the same rule the audit screen's `?problem=` follows.
 * A free-text message taken from the query string would let anybody craft a link that shows a reader a
 * message this application never wrote, over the Centre's own branding.
 */
/*
  ⚠ NOT EXPORTED, AND THAT IS THE FINISHED STATE RATHER THAN AN OVERSIGHT.

  Only `seeOther`, `refuse` and `enforceNewsletterRateLimit` — all in this file — ever need to build one of
  these. The three PAGES read the resulting `?state=` code through `newsletterNotice()` in
  lib/newsletter/states.ts and never construct the URL themselves, so there is no consumer outside this
  module and exporting it would leave a name nothing imports. If a caller ever does need it, exporting it
  again is one word; leaving it exported "just in case" is how a module's surface stops describing what is
  actually used.
*/
function newsletterStatePath(basePath: string, state: NewsletterStateCode): string {
  /**
   * ⚠ THE `#outcome` FRAGMENT IS NOT DECORATION — IT IS THE ONLY THING THAT TELLS A KEYBOARD OR SCREEN
   * READER THAT ANYTHING HAPPENED.
   *
   * This is a full-page navigation, so the browser lands on a new document with focus at the top. Without
   * the fragment, the sentence explaining the outcome sits below the fold and is announced to nobody: a
   * successful sign-up is indistinguishable from a form that did nothing. With it, the browser scrolls to
   * the panel and moves focus into it (the panel carries `tabIndex={-1}` so that it can receive focus),
   * and the panel's `role="status"` / `role="alert"` is then read out.
   *
   * The id is shared with the component that renders it through lib/newsletter/paths.ts — see the note
   * there.
   */
  return `${basePath}?state=${state}#${NEWSLETTER_OUTCOME_ID}`;
}

export interface NewsletterRefusal {
  wantsJson: boolean;
  /** HTTP status for the JSON answer. The redirect is always a 303; the state code carries the meaning. */
  status: number;
  /** A complete human sentence, rendered verbatim by lib/client/fetcher.ts and by the form. */
  message: string;
  code: string;
  fieldErrors?: Record<string, string[]>;
  /** The page a browser goes back to. */
  basePath: string;
  state: NewsletterStateCode;
}

/**
 * One refusal, in whichever shape the caller can use.
 *
 * ⚠ THE TWO SHAPES MUST DESCRIBE THE SAME REFUSAL. The JSON body carries the sentence; the redirect
 * carries a code the destination page turns into a sentence of its own. Those two sentences are
 * written next to each other in the page that owns the code, so they cannot say different things about
 * the same event — which is what would happen if the redirect simply dropped the reader somewhere
 * neutral and let them guess.
 */
export function refuse(refusal: NewsletterRefusal): NextResponse {
  if (refusal.wantsJson) {
    return toErrorResponse(
      new ApiError(refusal.status, refusal.message, {
        code: refusal.code,
        fieldErrors: refusal.fieldErrors
      })
    );
  }
  return seeOther(newsletterStatePath(refusal.basePath, refusal.state));
}

/** The success answer, in whichever shape the caller can use. */
export function succeed(options: {
  wantsJson: boolean;
  /** The JSON body. ⚠ Must not contain anything the redirect's state code does not also convey. */
  json: Record<string, unknown>;
  basePath: string;
  state: NewsletterStateCode;
}): NextResponse {
  if (options.wantsJson) {
    return NextResponse.json(options.json, { headers: { "cache-control": "no-store" } });
  }
  return seeOther(newsletterStatePath(options.basePath, options.state));
}

/**
 * The rate limit, answering in whichever shape the caller can use.
 *
 * ⚠ WHY NOT `enforceRateLimit`. That helper builds a JSON 429 — correct for every other route in this
 * application, and wrong for a form POST from a browser with no JavaScript, which would render the
 * error body as text. So the verdict is taken with `checkRateLimit` and the JSON path hands it to
 * `rateLimitResponse` (keeping the house error body AND the `Retry-After` header), while the browser
 * path gets a 303 that still carries `Retry-After` — so a well-behaved client backs off either way.
 *
 * Returns `null` when the request may proceed, matching the house one-liner.
 */
export function enforceNewsletterRateLimit(options: {
  request: Request;
  /** The bucket name. Namespaced per route so one abused endpoint does not disable the others. */
  bucket: string;
  policy: RateLimitPolicy;
  wantsJson: boolean;
  basePath: string;
  /** A complete sentence about THIS endpoint, given the back-off phrase. */
  message: (phrase: string) => string;
}): NextResponse | null {
  const verdict = checkRateLimit(options.request, options.bucket, options.policy);
  if (verdict.ok) return null;

  const seconds = Math.max(1, Math.ceil(verdict.retryAfterSeconds));

  if (options.wantsJson) {
    /**
     * ⚠ `retryAfterPhrase` IS THE EXPORTED ONE FROM lib/ratelimit.ts, NOT A LOCAL COPY.
     *
     * This file previously carried a private `phraseFor()` that was byte-for-byte identical to it, under
     * a comment saying that importing the real one "would be the right thing to do". That is the shape
     * of comment this repository treats as worse than none at all: it stated a rule the code beside it
     * did not follow. The sentence has to be built BEFORE `rateLimitResponse` is called, which is a
     * reason to call the function early — never a reason to reimplement it. Both halves of the answer
     * are now derived from ONE verdict through ONE function, so the words and the `Retry-After` header
     * cannot quote different numbers even if the wording is ever changed.
     */
    return rateLimitResponse(verdict, options.message(retryAfterPhrase(seconds)));
  }

  return seeOther(newsletterStatePath(options.basePath, "busy"), { "retry-after": String(seconds) });
}
