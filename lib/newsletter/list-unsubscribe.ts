/**
 * The RFC 2369 / RFC 8058 headers that put an "Unsubscribe" button in the reader's mail client.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THE TWO HEADERS SAY, AND THE RULES EACH ONE HAS TO KEEP
 *
 *   List-Unsubscribe: <https://…/api/public/newsletter/one-click?token=…>
 *   List-Unsubscribe-Post: List-Unsubscribe=One-Click
 *
 * Together they tell Gmail, Yahoo and Apple Mail that a POST to that URL, with the body
 * `List-Unsubscribe=One-Click`, unsubscribes the recipient with no further interaction. Since 2024 Gmail
 * and Yahoo require both on bulk mail, and a message without them is more likely to be filed as spam.
 *
 *   • **The URL must be HTTPS** (RFC 8058 §3.1). A deployment whose site URL is plain HTTP — a laptop, CI
 *     — still gets the header so it can be inspected, but no mail client will act on it.
 *   • **The URL must carry everything needed to identify the recipient**, because the POST has no cookie
 *     and no session. It carries the signed, non-expiring unsubscribe token.
 *   • **Angle brackets are part of the syntax**, and a comma separates alternatives. A URL may not contain
 *     a raw `>` or `,` — `encodeURIComponent` on the token guarantees neither appears.
 *
 * ⚠ NEVER ON A CONFIRMATION. The recipient of a confirmation is not subscribed to anything yet; a
 * one-click button there would offer to stop something that has not started. The delivery seam decides
 * which messages carry these (see `messageCarriesListUnsubscribe` in lib/newsletter/delivery.ts).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Pure, no `server-only`: the tests import it directly.
 */

export interface MailHeader {
  name: string;
  value: string;
}

export const LIST_UNSUBSCRIBE_POST_VALUE = "List-Unsubscribe=One-Click";

export function listUnsubscribeHeaders(oneClickUrl: string): MailHeader[] {
  if (/[\s<>,]/.test(oneClickUrl)) {
    // Unreachable with the URL builder in tokens.ts; a throw here beats a header no client can parse.
    throw new Error("A List-Unsubscribe URL may not contain whitespace, angle brackets or commas.");
  }
  return [
    { name: "List-Unsubscribe", value: `<${oneClickUrl}>` },
    { name: "List-Unsubscribe-Post", value: LIST_UNSUBSCRIBE_POST_VALUE }
  ];
}

