import { z } from "@/lib/zod";
import { isExternalHref, isStorableHref, safeRedirectDestination } from "@/lib/safe-href";

/**
 * The save-time link rules of the studio routes that are not section blocks or settings — navigation,
 * redirects, announcements and publications — in one module.
 *
 * They used to be written inside each route file, and a route file may export nothing but its handlers,
 * so none of them could be tested. Every rule here is lib/safe-href.ts; this file only adds each field's
 * length cap and the sentence an editor sees.
 *
 * It imports nothing that reaches the database (no lib/studio/crud.ts), so a test can load it without one.
 */

/** A menu item's destination. */
export const NAV_HREF_MAX = 500;

/**
 * Where a menu item goes: a path, `#anchor`, `https://`, `mailto:` or `tel:`.
 *
 * ⚠ `//evil.example` (and `/\evil.example`) IS REFUSED EXPLICITLY, with its own sentence. It starts with a
 * slash, so a naive "must start with /" test accepts it — and a browser reads it as a protocol-relative
 * link to another host. A menu item on the institution's own header that navigates to somebody else's
 * site is an open redirect with the Centre's name on it.
 */
export function navigationHrefSchema() {
  return z
    .string()
    .trim()
    .min(1, "A menu item needs a destination, or pressing it would do nothing.")
    .max(NAV_HREF_MAX, `Keep a destination to ${NAV_HREF_MAX} characters or fewer.`)
    .refine((value) => !/^[/\\][/\\]/.test(value), {
      message:
        "A destination beginning with // points at another website without saying so. Write the full address with https:// if that is what you meant."
    })
    // The rest of the rule is `isStorableHref`, shared with the renderer: it also refuses `/\evil.example`,
    // a tab or newline smuggled after the slash, `/%2F%2Fevil.example` and dot segments.
    .refine((value) => isStorableHref(value), {
      message: "A destination must be a page on this site starting with a single /, or start with #, https://, mailto: or tel:."
    });
}

/** A redirect row's destination. */
export const REDIRECT_DESTINATION_MAX = 500;

/**
 * A destination that will not send a reader somewhere dangerous: a path, an anchor, a query, or a full
 * http(s) address — and exactly what `findPageRedirect()` would send in `Location` when the row is read.
 *
 * `javascript:` and `data:` are refused by the positive allow-list rather than by a blacklist — a scheme
 * nobody thought about is exactly what a blacklist misses. A prefix test let `/\evil.example` through:
 * the URL parser reads `\` as `/`, so the `Location` left the site.
 */
export function isUsableRedirectDestination(destination: string): boolean {
  if (destination.length === 0 || destination.length > REDIRECT_DESTINATION_MAX) return false;
  return isStorableHref(destination, { contact: false }) && safeRedirectDestination(destination) === destination;
}

/** An announcement's link. */
export const ANNOUNCEMENT_HREF_MAX = 500;

/**
 * An announcement's optional link, for `optionalText(ANNOUNCEMENT_HREF_MAX).refine(...)` (that helper lives
 * in lib/studio/crud.ts, which this module must not import). The band renders it through `next/link`,
 * where `//evil.example` or `/\evil.example` would look internal and leave the site, and `javascript:`
 * would run. `null` is "no link".
 */
export function isStorableAnnouncementHref(value: string | null): boolean {
  return value === null || isStorableHref(value);
}

export const ANNOUNCEMENT_HREF_MESSAGE =
  "A link must be a page on this site starting with a single /, or start with https://, mailto: or tel:.";

/**
 * A publication's "View at the publisher" link: an absolute http(s) address only, never `javascript:` or a
 * protocol-relative `//host`. `""` clears it.
 */
export function publisherUrlSchema() {
  return z
    .string()
    .trim()
    .max(1000)
    .refine((value) => value === "" || isExternalHref(value), {
      message: "A publisher link must be a full web address starting with https://."
    })
    .nullable()
    .optional();
}
