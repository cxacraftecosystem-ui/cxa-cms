/**
 * The ONE definition of "the same email address" for the newsletter.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A FILE AND NOT A `.toLowerCase()` AT EACH CALL SITE.
 *
 * `NewsletterSubscriber.emailKey` is `@unique`, and that constraint is only as good as the function
 * that produces the value. Six call sites — the sign-up route, the confirm route, the unsubscribe
 * route, the token signer, the token verifier and the studio search — all have to agree on the answer
 * to "is this the address we already hold". If any one of them folds a character the others do not,
 * the symptoms are not a crash: a person gets two rows, one of which they can never unsubscribe,
 * because the link they were sent was signed over a key nothing looks up any more.
 *
 * So there is one function, and everything keys on its output.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHAT IS FOLDED, AND WHY EACH ONE:
 *
 *   • **Surrounding whitespace.** Pasted addresses arrive with it constantly. Nothing is lost.
 *   • **Unicode composition (NFC).** `josé@example.org` can be typed as one code point or as `e`
 *     plus a combining acute. The two strings are not `===` equal, look identical on screen, and
 *     would become two rows nobody could tell apart. NFC — never NFKC, which also rewrites ligatures
 *     and full-width forms and would fold two addresses a mail server genuinely treats as different.
 *   • **Case, over the WHOLE address.** The domain half must be folded: DNS is case-insensitive, so
 *     `EXAMPLE.ORG` and `example.org` are one host and always have been. The local half is a
 *     deliberate, stated compromise: RFC 5321 §2.4 says only the receiving server may interpret it
 *     and that it MAY be case-sensitive — but no mainstream provider treats it so, and the brief
 *     here is a case-insensitively unique address. Folding it is the only way to honour that.
 *     ⚠ THE COST, SO IT IS NOT DISCOVERED LATER: at a hypothetical host that really does distinguish
 *     `Reader@` from `reader@`, those two people would share one subscription and the second would
 *     be told nothing. The original spelling is kept in `NewsletterSubscriber.email` and is what a
 *     mailing is addressed to, so the message still reaches the right mailbox; it is only the
 *     IDENTITY that is folded.
 *
 * WHAT IS DELIBERATELY **NOT** FOLDED — and this is the more important half:
 *
 *   • **Dots in the local part.** `first.last@` and `firstlast@` are the same mailbox at Gmail and
 *     different mailboxes almost everywhere else. Stripping them would silently merge two people at
 *     every other provider on earth to tidy up one.
 *   • **`+tag` suffixes.** Same argument, plus a second one: a reader who signs up as
 *     `me+centre@example.org` is deliberately creating a filterable address. Rewriting it to
 *     `me@example.org` overrides a privacy decision they made on purpose, and it means the address
 *     the Centre holds is not the address they gave.
 *   • **Anything provider-specific at all.** Every such rule is a guess about a domain that can
 *     change its mind, and a wrong guess here is invisible: it does not error, it just quietly
 *     unifies two strangers.
 *
 * ⚠ `toLowerCase()`, NEVER `toLocaleLowerCase()`. The locale-aware form maps `I` to a dotless `ı`
 * under a Turkish locale, so the same address normalises differently depending on the SERVER's
 * locale — an identity that changes when a container is redeployed with a different `LANG`.
 *
 * This module holds no secrets and touches no database, so it is deliberately NOT `server-only`:
 * the public sign-up component imports `NEWSLETTER_SOURCES` from it.
 */

/**
 * The longest address anything here accepts.
 *
 * 254 is the practical ceiling on a `Mailbox` in an SMTP `RCPT TO` command (RFC 5321 §4.5.3.1.3
 * gives 256 for the whole `<...>` including the angle brackets). It matches the `max(254)` on the
 * contact form and on event registration, so one form does not accept what another rejects.
 */
export const EMAIL_MAX_LENGTH = 254;

/**
 * A shape test, not a validator — the same permissive pattern the contact form uses, and for the
 * same reason set out there: every stricter regular expression anybody writes rejects a real address
 * somewhere, and refusing a correct address is a worse failure than a bounced message. The authority
 * on whether an address is deliverable is the mail server, and nothing here can stand in for it.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * The normalised identity for an address, or `null` when the input is not addressable at all.
 *
 * Returning `null` rather than throwing is deliberate: every caller already has a sentence to show
 * for a bad address, and a thrown error inside a route would become a 500 where a 422 was meant.
 */
export function normaliseEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;

  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > EMAIL_MAX_LENGTH) return null;

  const folded = trimmed.normalize("NFC").toLowerCase();
  if (!EMAIL_SHAPE.test(folded)) return null;

  return folded;
}

/**
 * The address as it should be WRITTEN TO — trimmed and NFC-normalised, but with the capitals the
 * person typed left alone.
 *
 * Kept as its own function so the difference between "the identity" and "the envelope" is visible in
 * every call site rather than being a comment somewhere. Both are stored: `emailKey` and `email`.
 */
export function displayEmail(raw: string): string {
  return raw.trim().normalize("NFC").slice(0, EMAIL_MAX_LENGTH);
}

/**
 * The surfaces a sign-up can come from.
 *
 * A CLOSED LIST rather than free text, because `source` is a studio FILTER: with free text, one
 * component shipping `"footer "` with a trailing space creates a second option in the dropdown that
 * looks identical to the first and matches none of the same rows. A value not on this list is
 * recorded as `"other"` rather than refused — losing a subscriber over a mislabelled form would be
 * absurd — but the list is what the filter offers.
 */
export const NEWSLETTER_SOURCES = ["newsletter-page", "footer", "article", "event", "other"] as const;

export type NewsletterSource = (typeof NEWSLETTER_SOURCES)[number];

/** Plain words for the studio's filter and its CSV. Colour and codes never carry meaning alone. */
export const NEWSLETTER_SOURCE_LABELS: Record<NewsletterSource, string> = {
  "newsletter-page": "The newsletter page",
  footer: "The footer of a page",
  article: "The foot of an article",
  event: "An event page",
  other: "Somewhere else"
};

/** `source` narrowed to the closed list, falling back to `"other"`. Never throws. */
export function toNewsletterSource(value: string | null | undefined): NewsletterSource {
  if (typeof value !== "string") return "other";
  const trimmed = value.trim();
  return (NEWSLETTER_SOURCES as readonly string[]).includes(trimmed)
    ? (trimmed as NewsletterSource)
    : "other";
}

/**
 * `r••••@example.org` — an address with its local part obscured.
 *
 * Used ONLY where a page has to prove to the holder of a signed link that it has the right address
 * without printing that address in full: the unsubscribe page is reachable from a link that may have
 * been forwarded, and a forwarded link should not hand the whole address to whoever received it.
 *
 * ⚠ NOT a security control. It is a courtesy, and anybody holding the token could reconstruct the
 * address from the token's own payload if they wanted to. It exists so a shoulder-surfer or a
 * screenshot does not carry the address, not to keep a secret from the person holding the link.
 */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return "•••";

  const local = address.slice(0, at);
  const domain = address.slice(at);
  // The first character is kept so the person can recognise their own address. A one-character local
  // part gets no reveal at all rather than being printed whole.
  const head = local.length > 1 ? local.slice(0, 1) : "";
  return `${head}${"•".repeat(Math.max(3, Math.min(6, local.length - head.length)))}${domain}`;
}
