import "server-only";
import { clamp, truncateWords } from "@/lib/utils";

/**
 * Scoring a public form submission for spam.
 *
 * **IT MARKS. IT DOES NOT DELETE.** A submission over the threshold is stored like any other, with
 * `state: SPAM` and its `spamScore` / `spamReason` beside it, and it appears in the studio's inquiries
 * screen under a Spam filter. That is the entire design, and it is not negotiable:
 *
 *   • A false positive that was STORED can be found, read, explained and answered a day late.
 *   • A false positive that was DISCARDED on the server is a collaboration enquiry, a PhD application
 *     or a press request that simply never existed. Nobody ever learns it was sent. The sender is
 *     told "thank you", believes they made contact, and waits.
 *
 * The asymmetry is total, so the design is not "how do we catch more" but "how do we make a mistake
 * recoverable". Hence: store everything, record WHY it scored, and never tell the sender.
 *
 * WEIGHTING. Only the honeypot is decisive on its own. Every other signal is worth less than the
 * threshold, so it takes at least two independent ones to mark a submission — a person on a slow
 * connection who happened to paste two links is not enough, and neither is a real name that mixes
 * scripts. The weights are stated next to each signal below with the reason for its size.
 *
 * `import "server-only"` is load-bearing: shipping the weights and the thresholds to the browser hands
 * the tuning instructions to whoever is tuning against them.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shape
// ─────────────────────────────────────────────────────────────────────────────

export interface SpamSignalInput {
  /**
   * The honeypot field's value.
   *
   * The form renders an input that is hidden from sight and from assistive technology and left empty;
   * a person never fills it in, and an automated submitter that walks the DOM fills in everything.
   * ⚠ It must be hidden with CSS and `tabindex="-1"` plus `aria-hidden="true"` — NOT with
   * `type="hidden"`, which many bots skip, and never with a `required` attribute.
   */
  honeypot?: string | null;
  /**
   * When the form was RENDERED, stamped by the server into the page.
   *
   * Server clock to server clock, so it is immune to the wrong-by-hours clocks that make a
   * browser-supplied timestamp useless. Two honest caveats, which are why this signal is not decisive:
   * a bot can send any value it likes, and on a statically prerendered page the stamp is the BUILD
   * time, which makes the signal inert rather than wrong.
   */
  renderedAt?: Date | number | string | null;
  message: string;
  email: string;
  /** Scored for mixed-script look-alikes. Optional because not every form asks for one. */
  name?: string | null;
  subject?: string | null;
  /**
   * Recorded on the submission, deliberately NOT scored.
   *
   * No reputation list ships with this application, and scoring an address without one is
   * superstition — a residential address in a country with a lot of spam belongs to a lot of people
   * who are not sending it. The parameter exists so the call shape is stable if a real reputation
   * lookup is ever added, and so the caller has one object to assemble.
   */
  ipAddress?: string | null;
}

export interface SpamAssessment {
  /** 0 (nothing suspicious) to 1 (certain). Stored verbatim in `ContactSubmission.spamScore`. */
  score: number;
  /**
   * One plain sentence per signal that fired, with the numbers in it. Rendered to an editor deciding
   * whether the filter was right, so "suspicious content" would be useless — it has to say WHAT.
   */
  reasons: string[];
}

/**
 * At or above this, the submission is filed as SPAM rather than NEW.
 *
 * 0.7 with the weights below means: the honeypot alone marks it; a fast submit plus any second signal
 * marks it; two mid-weight signals alone (a disposable address and four links, say) do NOT. That last
 * case is the calibration decision — a throwaway address with a few links is exactly what a genuine
 * enquiry from someone protecting their privacy looks like.
 */
export const SPAM_THRESHOLD = 0.7;

/** Under this many seconds between render and submit, nobody has read the form. */
export const MIN_HUMAN_SECONDS = 2;

/** Weights. Each is documented where it is applied; they are collected here to be read as a set. */
const WEIGHT_HONEYPOT = 1;
const WEIGHT_TOO_FAST = 0.5;
const WEIGHT_REPEATED_TOKEN = 0.4;
const WEIGHT_LINK_FLOOD = 0.35;
const WEIGHT_DISPOSABLE_DOMAIN = 0.3;
const WEIGHT_HOMOGLYPH_NAME = 0.25;

/** More links than this in a short message is the flood. */
const LINK_LIMIT = 3;
/** "Short" for the purpose of the link count. A 4 000-word proposal may legitimately cite six papers. */
const SHORT_MESSAGE_CHARS = 500;
/** Below this many tokens, "all one word" is a plausible answer ("thanks", "no thanks"). */
const MIN_TOKENS_FOR_REPETITION = 4;
/** `spamReason` is rendered in a table cell, so the joined sentences are capped for the column. */
const MAX_REASON_CHARS = 600;

// ─────────────────────────────────────────────────────────────────────────────
// Disposable addresses
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A short, static list of throwaway-inbox providers.
 *
 * It is a HINT and it is weighted as one. The full lists are tens of thousands of domains long, change
 * weekly, and are the sort of dependency that quietly starts rejecting a whole university's mail after
 * an upstream edit. Everything here is a service whose entire product is an address that stops
 * existing in ten minutes — worth 0.3, never worth a refusal on its own, because "I do not want to
 * give a permanent address to a web form" is a reasonable position held by reasonable people.
 */
export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "0-mail.com",
  "10minutemail.com",
  "20minutemail.com",
  "33mail.com",
  "anonbox.net",
  "dispostable.com",
  "e4ward.com",
  "fakeinbox.com",
  "getairmail.com",
  "getnada.com",
  "guerrillamail.com",
  "guerrillamail.info",
  "harakirimail.com",
  "inboxbear.com",
  "jetable.org",
  "mail-temporaire.fr",
  "mail7.io",
  "mailcatch.com",
  "maildrop.cc",
  "mailinator.com",
  "mailnesia.com",
  "mintemail.com",
  "moakt.com",
  "mohmal.com",
  "mytemp.email",
  "sharklasers.com",
  "spam4.me",
  "spamgourmet.com",
  "temp-mail.org",
  "tempinbox.com",
  "tempmail.net",
  "tempr.email",
  "throwawaymail.com",
  "trashmail.com",
  "trbvm.com",
  "yopmail.com",
  "yopmail.fr"
]);

/**
 * The domain, and every parent of it.
 *
 * `inbox.mailinator.com` must match the entry for `mailinator.com` — these services hand out
 * subdomains freely, so testing only the exact host would miss most of their traffic. Stops at two
 * labels, so it can never test a public suffix such as `com` on its own.
 */
function domainAndParents(domain: string): string[] {
  const labels = domain.split(".").filter(Boolean);
  const out: string[] = [];
  for (let index = 0; index + 2 <= labels.length; index += 1) {
    out.push(labels.slice(index).join("."));
  }
  return out;
}

/** The lowercase domain of an address, or null when there is not one. */
function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");
  return domain.includes(".") ? domain : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Text signals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many links a message STARTS.
 *
 * Counts openings (`http://`, `https://`, `www.`, a BBCode `[url`) rather than trying to parse whole
 * URLs, and deliberately does NOT treat a bare `something.com` as a link: "we read about it on
 * example.com" is ordinary prose, and counting it would charge a real enquiry for mentioning a
 * website.
 */
function countLinks(message: string): number {
  const matches = message.match(/https?:\/\/|www\.|\[url[\s=\]]/gi);
  return matches ? matches.length : 0;
}

/** Lowercase word tokens, punctuation dropped. */
function tokenise(message: string): string[] {
  return message
    .toLowerCase()
    .split(/[\s\p{P}\p{S}]+/u)
    .filter((token) => token.length > 0);
}

/**
 * Words that mix Latin letters with Cyrillic or Greek ones.
 *
 * This is the homoglyph trick: `Аndrew` with a Cyrillic А, `pаypal` with a Cyrillic а. Reading a
 * mixture INSIDE ONE WORD is what makes the test precise — and the restriction to Cyrillic and Greek
 * is deliberate, because those are the two scripts that supply visual twins of Latin letters.
 *
 * A name written entirely in Devanagari, Tamil, Bengali or Cyrillic is a NAME, not an attack, and this
 * site's correspondents write plenty of them. Testing "not Latin" instead of "Latin mixed with a
 * look-alike script" would flag half the Centre's own faculty.
 */
function homoglyphWords(name: string): string[] {
  const out: string[] = [];
  for (const word of name.split(/\s+/).filter(Boolean)) {
    const hasLatin = /\p{Script=Latin}/u.test(word);
    const hasLookalike = /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(word);
    if (hasLatin && hasLookalike) out.push(word);
  }
  return out;
}

/** Milliseconds since the form was rendered, or null when the stamp is missing or unusable. */
function elapsedSinceRender(renderedAt: SpamSignalInput["renderedAt"]): number | null {
  if (renderedAt === null || renderedAt === undefined) return null;

  let stamp: number;
  if (renderedAt instanceof Date) {
    stamp = renderedAt.getTime();
  } else if (typeof renderedAt === "number") {
    stamp = renderedAt;
  } else {
    const trimmed = renderedAt.trim();
    if (trimmed.length === 0) return null;
    // Epoch milliseconds arrive as a string from a hidden input; an ISO string arrives from a form
    // that stamped a date. Both are accepted, and anything else is treated as absent.
    stamp = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Date.parse(trimmed);
  }
  if (!Number.isFinite(stamp)) return null;

  const elapsed = Date.now() - stamp;
  // A stamp from the future means the value is unusable — a mangled field, or a clock that is wrong.
  // An unusable stamp must not accuse anybody, so it produces no signal at all rather than a bad one.
  if (elapsed < 0) return null;
  return elapsed;
}

/** One decimal place, so a reason reads "0.4 seconds" rather than "0.41999999 seconds". */
function seconds(ms: number): string {
  return (Math.round(ms / 100) / 10).toFixed(1);
}

/** A user's own words, quoted back into a reason. Curly quotes, and short enough to stay a sentence. */
function quote(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return `“${trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed}”`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The assessment
// ─────────────────────────────────────────────────────────────────────────────

export function scoreSubmission(input: SpamSignalInput): SpamAssessment {
  const reasons: string[] = [];
  let score = 0;

  const message = (input.message ?? "").trim();
  const name = (input.name ?? "").trim();

  // ── The honeypot: decisive ────────────────────────────────────────────────
  // Worth the whole threshold on its own because there is no honest way to fill it in. The field is
  // invisible and removed from the accessibility tree, so no person and no screen reader ever reaches
  // it; anything in it came from something that read the markup.
  if ((input.honeypot ?? "").trim().length > 0) {
    score += WEIGHT_HONEYPOT;
    reasons.push(
      "The hidden field that only an automated submitter would complete was filled in."
    );
  }

  // ── Submitted faster than a person can read ───────────────────────────────
  const elapsed = elapsedSinceRender(input.renderedAt);
  if (elapsed !== null && elapsed < MIN_HUMAN_SECONDS * 1000) {
    score += WEIGHT_TOO_FAST;
    reasons.push(
      `The form was sent ${seconds(elapsed)} seconds after it was rendered, which is faster than the ` +
        "fields can be read and filled in by hand."
    );
  }

  // ── A wall of links ───────────────────────────────────────────────────────
  // Only inside a SHORT message. A long proposal citing six sources is a normal thing to receive; six
  // links inside two sentences is an advertisement.
  const links = countLinks(message);
  if (links > LINK_LIMIT && message.length < SHORT_MESSAGE_CHARS) {
    score += WEIGHT_LINK_FLOOD;
    reasons.push(
      `The message is ${message.length} characters long and contains ${links} links, more than the ` +
        `${LINK_LIMIT} a short message would normally carry.`
    );
  }

  // ── One token, over and over ──────────────────────────────────────────────
  const tokens = tokenise(message);
  const distinct = new Set(tokens);
  if (tokens.length >= MIN_TOKENS_FOR_REPETITION && distinct.size === 1) {
    const only = tokens[0] ?? "";
    score += WEIGHT_REPEATED_TOKEN;
    reasons.push(
      `The whole message is the word ${quote(only)} repeated ${tokens.length} times.`
    );
  }

  // ── A throwaway address ───────────────────────────────────────────────────
  const domain = emailDomain((input.email ?? "").trim());
  if (domain) {
    const matched = domainAndParents(domain).find((candidate) =>
      DISPOSABLE_EMAIL_DOMAINS.has(candidate)
    );
    if (matched) {
      score += WEIGHT_DISPOSABLE_DOMAIN;
      reasons.push(
        `The address is at ${domain}, which belongs to ${matched} — a service that hands out ` +
          "inboxes that stop existing within the hour, so a reply may never be readable."
      );
    }
  }

  // ── Look-alike letters in the name ────────────────────────────────────────
  if (name.length > 0) {
    const mixed = homoglyphWords(name);
    const firstMixed = mixed[0];
    if (firstMixed) {
      score += WEIGHT_HOMOGLYPH_NAME;
      reasons.push(
        `The name mixes Latin letters with Cyrillic or Greek look-alikes (${quote(firstMixed)}), ` +
          "which is a common way to slip a word past a filter."
      );
    }
  }

  return {
    // Clamped, then rounded to three places: the column is a Float and an editor reads this number,
    // so 0.85 is useful and 0.8500000000000001 is noise.
    score: Math.round(clamp(score, 0, 1) * 1000) / 1000,
    reasons
  };
}

/** True when a score should be filed as SPAM. One predicate, so no route hard-codes the threshold. */
export function isLikelySpam(score: number): boolean {
  return score >= SPAM_THRESHOLD;
}

/**
 * The reasons as one string for `ContactSubmission.spamReason`, or null when nothing fired.
 *
 * Null rather than an empty string, so "this was filed as spam and we did not record why" is
 * distinguishable from "nothing was suspicious" — the first is a bug in a future edit of this file and
 * ought to be visible as one.
 */
export function spamReasonText(reasons: readonly string[]): string | null {
  if (reasons.length === 0) return null;
  return truncateWords(reasons.join(" "), MAX_REASON_CHARS);
}
