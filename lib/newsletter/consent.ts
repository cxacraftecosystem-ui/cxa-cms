/**
 * The consent register — the sentence a person agrees to when they subscribe, and every earlier
 * wording of it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE RULE THIS FILE EXISTS TO ENFORCE: **THE CONSENT TEXT SHOWN IS THE CONSENT TEXT STORED.**
 *
 * A consent record is evidence. It answers one question — "what exactly did this person agree to?" —
 * and it is worthless if the answer is assembled later from whatever the wording happens to be at the
 * time somebody asks. Two failure modes make that concrete, and this module closes both:
 *
 *   1. **The wording drifts.** An editor improves the sentence next year. If the stored record were a
 *      pointer at "the current text", every subscriber from this year would retroactively be recorded
 *      as having agreed to words they never saw. So `NewsletterSubscriber.consentText` holds a COPY,
 *      written at sign-up and never touched again.
 *
 *   2. **The PAGE is older than the SERVER.** A prerendered page, a page held in a browser's back-
 *      forward cache, a tab left open over a deploy: the form the person read can be one release
 *      behind the route that receives it. Storing the server's current text there would record
 *      agreement to a sentence that was never on their screen — a small lie, and precisely the kind
 *      that matters in a consent challenge.
 *
 *      So the FORM POSTS ITS VERSION, and the route looks the text up in this register by that
 *      version. A version this register does not know is REFUSED, with a sentence telling the reader
 *      to reload. That refusal is deliberate and is the whole mechanism: the alternatives are to store
 *      a text they never saw (dishonest) or to store nothing (no record at all).
 *
 * ⚠ HOW TO CHANGE THE WORDING. Add a NEW entry to `CONSENT_TEXTS` with a new date-stamped version and
 * point `CURRENT_CONSENT_VERSION` at it. **Never edit an existing entry** — the old rows reference it,
 * and editing it rewrites their evidence, which is the exact defect this file is built to prevent. The
 * old entries stay for ever; they cost a few hundred bytes and they are the only thing that can
 * explain a five-year-old row.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * No `server-only` here, on purpose: the public sign-up component renders `consentText()` as the label
 * of its consent checkbox, so the text has to cross to the browser. There is nothing secret in it.
 */

/**
 * The version identifier of the wording in force.
 *
 * A DATE, not a number: it is read by a person reconstructing what somebody agreed to, and "1 August
 * 2026" is a fact they can line up against a screenshot or a deploy log in a way that "v3" is not.
 */
export const CURRENT_CONSENT_VERSION = "2026-08-14";

/**
 * Every wording that has ever been shown, keyed by version.
 *
 * ⚠ APPEND ONLY. See the header. The entries are `readonly` at the type level as a reminder, not as
 * protection — nothing can stop a determined edit, so the rule is written down where it will be read.
 *
 * ⚠ NOT EXPORTED, DELIBERATELY, AND IT WAS. Nothing outside this file ever imported it: the form renders
 * `currentConsentText()` and the sign-up route calls `consentTextFor(version)`, which are the only two
 * questions anybody has of this register — "what do I show?" and "what did they see?". Exporting the map
 * as well offered a third way to ask them, `CONSENT_TEXTS[someVersion]`, which returns `undefined` for an
 * unknown version instead of the `null` both accessors normalise to; a caller that reached for the map and
 * stored that `undefined` would write an empty consent record, which is the one outcome this whole file
 * exists to prevent. Two functions, no map, no third path.
 */
const CONSENT_TEXTS: Readonly<Record<string, string>> = {
  "2026-08-14":
    "I would like the Centre to email me its newsletter. I understand my address will be used " +
    "for that and nothing else, that it will not be given or sold to anyone, and that every " +
    "message carries a one-click link to stop them — which works without signing in to anything."
};

/**
 * The wording for a version, or `null` if this build has never heard of it.
 *
 * `null` is what the routes turn into a refusal. It is a normal, expected answer — a page cached from
 * an older release will produce it — and the sentence the routes show says so.
 */
export function consentTextFor(version: string | null | undefined): string | null {
  if (typeof version !== "string") return null;
  const trimmed = version.trim();
  if (trimmed.length === 0) return null;
  return CONSENT_TEXTS[trimmed] ?? null;
}

/** The wording in force, for the form to render. Throws only if the register and the pointer disagree. */
export function currentConsentText(): string {
  const text = CONSENT_TEXTS[CURRENT_CONSENT_VERSION];
  if (!text) {
    // Unreachable unless somebody moves the pointer without adding the entry — which is exactly the
    // mistake worth failing loudly on, at import time in development, rather than storing an empty
    // consent record in production.
    throw new Error(
      `CURRENT_CONSENT_VERSION is "${CURRENT_CONSENT_VERSION}" but CONSENT_TEXTS has no entry for it. ` +
        "Add the new wording to CONSENT_TEXTS — never repoint the version at an entry that does not exist."
    );
  }
  return text;
}

/**
 * The sentence shown to somebody whose page was too old to be accepted.
 *
 * Written as a complete, actionable instruction rather than "invalid consent version", because the
 * reader has done nothing wrong and the fix is one keystroke. `lib/api.ts` renders `message` verbatim,
 * so this is what they actually see.
 */
export const STALE_CONSENT_MESSAGE =
  "This page has been open since before the newsletter wording was last changed, so what you agreed " +
  "to and what we would have recorded are not the same thing — and recording the wrong one would be " +
  "worse than asking again. Reload the page and sign up once more; it takes a moment and nothing has " +
  "been saved.";
