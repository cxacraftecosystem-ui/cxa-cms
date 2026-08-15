import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { authEnv, siteUrl } from "@/lib/env";
import {
  NEWSLETTER_CONFIRM_PATH,
  NEWSLETTER_UNSUBSCRIBE_PATH
} from "@/lib/newsletter/paths";

/**
 * The signed links a newsletter email carries: "confirm this subscription" and "stop these emails".
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE SAME SIGNING CONSTRUCTION AS `pagePreviewToken` IN lib/pages.ts, AND DELIBERATELY SO.
 *
 * That function is the house pattern for "a URL somebody may hold that proves something without a
 * session": an HMAC-SHA256 under `authEnv().secret`, over a message whose first field is a PURPOSE
 * STRING and a version. This module reuses it exactly — same secret, same algorithm, same domain
 * separation — rather than inventing a second scheme. Two token formats in one codebase means two
 * things to rotate, two things to audit, and one of them will be the one nobody remembers.
 *
 * ⚠ DOMAIN SEPARATION IS NOT DECORATION. The same secret signs session tokens (lib/auth/tokens.ts)
 * and page-preview tokens. Without `newsletter:v1:<purpose>:` at the front of the signed message, a
 * signature produced by one construction could be presented to another — and an unsubscribe
 * signature that also confirms a subscription is a real, if narrow, bug. The purpose is INSIDE the
 * signature, not merely beside it in the URL, so it cannot be swapped.
 *
 * ⚠ ROTATING `JWT_SECRET` INVALIDATES EVERY OUTSTANDING LINK AT ONCE — every unclicked confirmation
 * and every unsubscribe link in every message ever sent. That is the right answer when a secret has
 * leaked and a disaster if it is done casually: the unsubscribe links in a year of archived mail all
 * stop working, and a reader who cannot unsubscribe complains to a regulator rather than to us. It is
 * written here because this is the file somebody reads before rotating.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ══ THE TWO PURPOSES ARE DELIBERATELY ASYMMETRIC ══
 *
 * **`confirm` expires and is single use.** It is a credential that CREATES something: presenting it
 * turns a pending row into a live subscription. So the signed payload carries an expiry (three days),
 * and it carries a NONCE that is also stored on the row — `confirmationToken`. Verification checks
 * the signature (cheap, no database, rejects every forgery before a query is issued) and then the
 * caller checks the nonce against the row, which is what makes an old link stop working the moment a
 * newer one is issued or the subscription is confirmed.
 *
 * **`unsubscribe` never expires and has no nonce.** It is a PROMISE, not a credential, and it must
 * still work when somebody digs a three-year-old message out of an archive. An unsubscribe link that
 * has rotted is worse than one that is guessable: the worst case for a leaked unsubscribe link is
 * that a reader stops receiving something they can sign up for again in ten seconds, and the worst
 * case for an expired one is a person who cannot make the mail stop. So it is derived purely from the
 * address — stable, stateless, and identical every time it is built. (This is also what RFC 8058
 * one-click unsubscribe assumes, so the same token can serve a `List-Unsubscribe` header later.)
 *
 * ⚠ THE TOKEN IS NOT SECRET FROM ITS HOLDER. The address is in the payload in plain base64url,
 * because the unsubscribe PAGE has to be able to say which address it is about before anything is
 * written. Base64url is an encoding, not encryption, and nothing here pretends otherwise — the
 * signature is what makes the token unforgeable, not the encoding.
 */

/** The two things a newsletter link can prove. Part of the signed message — see the header. */
export type NewsletterTokenPurpose = "confirm" | "unsubscribe";

/**
 * How long a confirmation link is accepted for.
 *
 * Three days: long enough to survive a weekend, a holiday Monday and a mailbox somebody only opens on
 * a laptop, and short enough that a link sitting in a forwarded thread is not a standing invitation to
 * subscribe somebody else. A person who misses it simply signs up again — the form is idempotent and
 * says the same thing either way — so the cost of the shorter end of that range is a repeated click,
 * while the cost of the longer end is a live credential in an old mailbox.
 */
export const CONFIRMATION_TTL_HOURS = 72;

/**
 * 128 bits, as 32 hex characters — the same size `pagePreviewToken` truncates its digest to.
 *
 * The nonce is not a secret anybody has to memorise, so it is generated rather than derived: it must
 * be UNPREDICTABLE (so a confirmation cannot be guessed for an address somebody knows) and it must
 * CHANGE on every re-issue (so the previous link dies).
 */
const NONCE_BYTES = 16;

/**
 * The signature length, in hex characters. 32 hex = 128 bits of HMAC output.
 *
 * Truncating an HMAC is safe and standard (RFC 2104 §5 discusses it explicitly); 128 bits is far
 * beyond a forging attempt against a rate-limited endpoint, and it keeps the link short enough to
 * survive being wrapped by a mail client without a hyphen appearing in the middle of it.
 */
const SIGNATURE_HEX_LENGTH = 32;

/**
 * The field separator inside the signed payload.
 *
 * A newline, because `normaliseEmail()` rejects any address containing whitespace — so no field can
 * contain the separator and no payload can be re-split into different fields than it was built from.
 * A comma or a colon would both appear inside a real address.
 */
const FIELD_SEPARATOR = "\n";

/** The token format's own version, first in every signed message so a future format cannot be replayed. */
const TOKEN_VERSION = "v1";

export interface NewsletterTokenInput {
  purpose: NewsletterTokenPurpose;
  /** The NORMALISED address — `normaliseEmail()`'s output. Never the address as typed. */
  emailKey: string;
  /** Required for `confirm`, ignored for `unsubscribe`. See the header. */
  nonce?: string | null;
  /** Required for `confirm`, ignored for `unsubscribe`. */
  expiresAt?: Date | null;
}

export type NewsletterTokenResult =
  | {
      ok: true;
      emailKey: string;
      /** `""` for an unsubscribe token, which carries none. */
      nonce: string;
      /** `null` for a token that does not expire. */
      expiresAt: Date | null;
    }
  | {
      ok: false;
      /**
       * Which failure it was, because the three produce three different sentences on screen and
       * collapsing them would make "your link has expired" indistinguishable from "your link was
       * mangled by your mail client".
       */
      reason: "malformed" | "forged" | "expired";
    };

/** A fresh confirmation nonce. Stored on the row AND signed into the link. */
export function newConfirmationNonce(): string {
  return randomBytes(NONCE_BYTES).toString("hex");
}

/** When a confirmation link issued now stops being accepted. */
export function confirmationExpiryFrom(now: Date = new Date()): Date {
  return new Date(now.getTime() + CONFIRMATION_TTL_HOURS * 60 * 60 * 1000);
}

/**
 * The payload as it is SIGNED — the plain, unencoded string.
 *
 * Built in one place so the signer and the verifier cannot assemble the fields in different orders,
 * which is the classic way a signature scheme is broken by an ordinary refactor.
 */
function payloadString(emailKey: string, nonce: string, expiresAtMs: number): string {
  return [emailKey, nonce, String(expiresAtMs)].join(FIELD_SEPARATOR);
}

function sign(purpose: NewsletterTokenPurpose, payload: string): string {
  // `authEnv()` THROWS on a missing or weak secret (lib/auth/config.ts). That is correct here: a
  // deployment with no signing secret must not be quietly issuing links that anybody can forge, and
  // the sign-up route turns the throw into an honest 500 rather than a subscription nobody can trust.
  return createHmac("sha256", authEnv().secret)
    .update(`newsletter:${TOKEN_VERSION}:${purpose}:${payload}`)
    .digest("hex")
    .slice(0, SIGNATURE_HEX_LENGTH);
}

/**
 * The token for a link.
 *
 * For `unsubscribe` the nonce and expiry arguments are IGNORED rather than rejected, which is what
 * makes the token stable: two calls a year apart produce the same string, so the same address always
 * has the same unsubscribe link and an old message keeps working.
 */
export function signNewsletterToken(input: NewsletterTokenInput): string {
  const nonce = input.purpose === "confirm" ? (input.nonce ?? "") : "";
  const expiresAtMs =
    input.purpose === "confirm" && input.expiresAt ? input.expiresAt.getTime() : 0;

  const payload = payloadString(input.emailKey, nonce, expiresAtMs);
  const encoded = Buffer.from(payload, "utf8").toString("base64url");
  return `${TOKEN_VERSION}.${encoded}.${sign(input.purpose, payload)}`;
}

/**
 * Compare in constant time.
 *
 * ⚠ `timingSafeEqual` THROWS on a length mismatch rather than returning false, so the lengths are
 * checked first — the same guard `previewTokenMatches` in lib/pages.ts carries, and for the same
 * reason: a thrown error inside a page render is a 500 where a refusal was meant.
 */
function signatureMatches(expected: string, offered: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(offered, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Read a token, or say why it cannot be read.
 *
 * ⚠ THE SIGNATURE IS CHECKED BEFORE ANYTHING ELSE IS BELIEVED. The expiry lives inside the signed
 * payload, so checking it first would be trusting a number an attacker chose. Order here is load
 * bearing: version → decode → signature → expiry.
 *
 * ⚠ THE PURPOSE MUST BE PASSED BY THE CALLER and is not read out of the token. A verifier that took
 * the purpose from the token would accept an unsubscribe token at the confirm route, which is the
 * confused-deputy version of having no domain separation at all.
 */
export function verifyNewsletterToken(
  purpose: NewsletterTokenPurpose,
  token: string | null | undefined
): NewsletterTokenResult {
  if (typeof token !== "string") return { ok: false, reason: "malformed" };

  // Mail clients wrap long URLs and some readers paste them back with surrounding space.
  const trimmed = token.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return { ok: false, reason: "malformed" };

  const parts = trimmed.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };

  const [version, encoded, signature] = parts;
  if (version !== TOKEN_VERSION || !encoded || !signature) return { ok: false, reason: "malformed" };

  let payload: string;
  try {
    payload = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const fields = payload.split(FIELD_SEPARATOR);
  if (fields.length !== 3) return { ok: false, reason: "malformed" };

  const [emailKey = "", nonce = "", expiresRaw = ""] = fields;
  const expiresAtMs = Number.parseInt(expiresRaw, 10);
  if (emailKey.length === 0 || !Number.isFinite(expiresAtMs) || expiresAtMs < 0) {
    return { ok: false, reason: "malformed" };
  }

  // ⚠ Re-signed from the DECODED payload, not from `encoded`. Signing the transport encoding would
  // let two different encodings of the same bytes carry the same signature and diverge afterwards.
  if (!signatureMatches(sign(purpose, payloadString(emailKey, nonce, expiresAtMs)), signature)) {
    return { ok: false, reason: "forged" };
  }

  if (expiresAtMs > 0 && Date.now() > expiresAtMs) {
    return { ok: false, reason: "expired" };
  }

  return {
    ok: true,
    emailKey,
    nonce,
    expiresAt: expiresAtMs > 0 ? new Date(expiresAtMs) : null
  };
}

/**
 * Compare a stored nonce with the one in a link, in constant time.
 *
 * A plain `===` would be fine in practice — the nonce is random and an attacker gets no useful
 * feedback from a rate-limited endpoint — but the comparison is here anyway so that nobody reading
 * this file later has to work out whether it was fine, and so the two token checks look alike.
 *
 * A row with NO stored nonce never matches: that is a subscription that has already been confirmed,
 * or one whose link was superseded, and both must refuse.
 */
export function confirmationNonceMatches(
  stored: string | null | undefined,
  offered: string
): boolean {
  if (typeof stored !== "string" || stored.length === 0 || offered.length === 0) return false;
  return signatureMatches(stored, offered);
}

// ─────────────────────────────────────────────────────────────────────────────
// The links themselves
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The query parameter both links carry. Exported so the pages that read it and the builders that
 * write it cannot disagree about the name — the same reasoning as `PAGE_PREVIEW_QUERY_KEY`.
 */
export const NEWSLETTER_TOKEN_QUERY_KEY = "token";

/**
 * ⚠ BOTH LINKS POINT AT A **PAGE**, NOT AT THE MUTATING ROUTE, AND THAT IS THE WHOLE DESIGN.
 *
 * A link in an email is fetched by things that are not the recipient: corporate mail gateways, link
 * scanners and "safe links" rewriters follow every URL in every message before a person sees it. A
 * confirmation link that mutated on GET would therefore be clicked by a security appliance, and the
 * subscription would confirm itself — turning a double opt-in into a single one without anybody
 * noticing. The same appliance would silently unsubscribe people from a `List-Unsubscribe` URL.
 *
 * So each link lands on a page that VERIFIES the token, shows the reader what is about to happen, and
 * offers a real `<form method="post">`. The mutation is a POST, which no scanner performs, and the
 * page works with JavaScript switched off because it is an ordinary form. The cost is one extra
 * click; the thing it buys is that the click is a person's.
 *
 * ⚠ THE PATHS COME FROM lib/newsletter/paths.ts AND ARE NOT SPELLED OUT HERE. They were, and both of
 * them named a page that did not exist anywhere in the application — so every confirmation link and
 * every unsubscribe link this module composed was a 404, and no check in the repository could see it.
 * One constant per address, imported by the page that answers it as well as by the builder that writes
 * it, is what makes the two impossible to move apart.
 */
export function newsletterConfirmUrl(token: string): string {
  return `${siteUrl()}${NEWSLETTER_CONFIRM_PATH}?${NEWSLETTER_TOKEN_QUERY_KEY}=${encodeURIComponent(token)}`;
}

/**
 * ⚠ THE ASYMMETRY OF THESE TWO IS DELIBERATE, AND IT LOOKS LIKE AN OVERSIGHT UNTIL YOU READ WHY.
 *
 * `newsletterConfirmUrl` is exported because `sendConfirmationEmail` genuinely has a token in its hand and
 * needs the URL for it. This one is NOT exported, because no caller ever should: composing an unsubscribe
 * link means signing a fresh token from the address, which is `unsubscribeUrlFor(emailKey)` immediately
 * below and is the only shape any caller has wanted. An exported URL-builder that takes a token invites a
 * call site to sign one itself — and the two mistakes available there are signing it with the WRONG purpose
 * (`confirm`, which the unsubscribe route then refuses as forged) and signing over `email` rather than
 * `emailKey` (which produces a link that verifies and then matches no row). Both would present as "the
 * unsubscribe link does not work", which is the one failure this feature must never have.
 *
 * It stays a named function rather than being inlined so the two builders still read as a pair.
 */
function newsletterUnsubscribeUrl(token: string): string {
  return `${siteUrl()}${NEWSLETTER_UNSUBSCRIBE_PATH}?${NEWSLETTER_TOKEN_QUERY_KEY}=${encodeURIComponent(token)}`;
}

/**
 * The unsubscribe link for an address, built from the address alone.
 *
 * This is the function a mailing composes its footer with, and it needs nothing but the key — no row,
 * no query, no state. That is the practical payoff of the derived design described in the header.
 */
export function unsubscribeUrlFor(emailKey: string): string {
  return newsletterUnsubscribeUrl(signNewsletterToken({ purpose: "unsubscribe", emailKey }));
}
