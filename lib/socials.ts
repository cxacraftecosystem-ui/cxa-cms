/**
 * socials — ONE answer to "which glyph and which name does this social link get?", for every surface.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS: THE SAME TWENTY LINES WERE WRITTEN TWICE AND THE TWO COPIES DISAGREED.
 *
 * The URLs themselves were never the duplicated part — `social.links` is an editor-owned array in the
 * settings document (`socialSettingsSchema`, lib/settings/schema.ts:477), read once per request by
 * `app/(site)/layout.tsx` and handed down. Nothing hard-codes a URL and nothing here changes that.
 *
 * What WAS duplicated is the resolution either side of it — slug → icon, link → accessible name — and
 * the two copies were keyed on different things:
 *
 *   • components/site/SiteFooter.tsx keyed its map on the lucide EXPORT NAME ("Linkedin"), reached
 *     through `SOCIAL_PLATFORMS[].icon`, so a platform slug absent from that list fell to `Globe`.
 *   • app/(site)/contact/page.tsx:147 keys its map on the PLATFORM SLUG ("linkedin") and carried an
 *     extra `x: Twitter` row that the footer's route could not reach.
 *
 * ⚠ THE DEFECT THAT PRODUCED: an administrator who typed the platform `x` — which is what the network
 * now calls itself, and which `socialLinkSchema` accepts because `platform` is a free-form slug and not
 * a closed list — got the X glyph on /contact and a featureless GLOBE in the footer, on the same page
 * load, for the same row of the same settings document. Nothing in the product could see it: both
 * spellings typecheck, both lint, and both render a real icon. It is only visible to somebody looking
 * at the two surfaces side by side.
 *
 * Adding the top navigation as a THIRD surface is what made this worth fixing rather than noting: three
 * copies of a lookup is not a smell, it is a guarantee that at least two of them are wrong.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * NOT `"use client"`, AND THAT IS LOAD-BEARING. Its consumers are a Server Component (`SiteFooter`) and
 * a Client Component (`SocialMenu`, inside the header pill). A directive here would make every export a
 * client reference the moment the footer imported it, which is the exact trap `app/(site)/layout.tsx`
 * records against `SiteHeader`'s feature filter — a plain module can be imported by both.
 *
 * THE ICONS ARE `lucide-react` AND ONLY `lucide-react` (contract §13). There is no brand-logo set in
 * this repository and adding one is explicitly out of bounds, so "its own brand logo" means lucide's
 * own brand glyphs — the same eight the footer and the contact page have always drawn.
 */

import {
  Facebook,
  Github,
  Globe,
  Instagram,
  Linkedin,
  Rss,
  Twitter,
  Youtube,
  type LucideIcon
} from "lucide-react";

import {
  SOCIAL_FALLBACK_ICON,
  SOCIAL_PLATFORMS,
  type SocialLink
} from "@/lib/settings/schema";

/**
 * The lucide exports named by `SOCIAL_PLATFORMS[].icon`, resolved by hand.
 *
 * A literal map rather than `icons[name]` on the lucide namespace: a dynamic lookup defeats
 * tree-shaking and pulls the entire icon set — some 1,500 components — into the bundle of every public
 * page, and this module is now in the header, so that bundle is EVERY page rather than just the two it
 * used to be. It is also untypeable: `platform` is a free-form slug, so the key is a `string` and the
 * value would be `unknown`.
 *
 * `Globe` is the documented fallback for a platform nobody has written an icon for — `Rss` and `Globe`
 * are in the map for the same reason the other six are, because `SOCIAL_PLATFORMS` names them.
 */
const ICONS_BY_LUCIDE_NAME: Record<string, LucideIcon> = {
  Linkedin,
  Twitter,
  Youtube,
  Instagram,
  Facebook,
  Github,
  Rss,
  Globe
};

/**
 * Slugs that mean a platform `SOCIAL_PLATFORMS` already knows under another name.
 *
 * ⚠ EXACTLY ONE ENTRY, AND IT IS NOT INVENTED HERE. `x: twitter` is lifted verbatim from the map at
 * app/(site)/contact/page.tsx:150, which has carried it since the network renamed itself; the footer
 * never had it, which is the divergence this file's header describes. Resolving the alias HERE is what
 * makes the three surfaces agree — and it is deliberately an alias rather than a ninth row in
 * `SOCIAL_PLATFORMS`, because that array is the studio's PICKER and a second "X (Twitter)" option
 * beside the first is a choice no editor can make correctly.
 *
 * ⚠ DO NOT GROW THIS SPECULATIVELY. Every entry here is a slug an administrator has actually typed and
 * a glyph the product already ships; a guessed alias is a silent override of what somebody wrote.
 */
const PLATFORM_ALIASES: Record<string, string> = {
  x: "twitter"
};

/** A platform slug reduced to the spelling `SOCIAL_PLATFORMS` uses, if it knows one. */
function canonicalPlatform(platform: string): string {
  const slug = platform.trim().toLowerCase();
  return PLATFORM_ALIASES[slug] ?? slug;
}

/** The `SOCIAL_PLATFORMS` row for a slug, aliases resolved. `undefined` for anything unlisted. */
export function socialPlatformMeta(platform: string) {
  const slug = canonicalPlatform(platform);
  return SOCIAL_PLATFORMS.find((entry) => entry.value === slug);
}

/**
 * The glyph for a platform slug. Never null — an icon-less row would render as a gap the reader
 * cannot press.
 */
export function socialIcon(platform: string): LucideIcon {
  const meta = socialPlatformMeta(platform);
  return ICONS_BY_LUCIDE_NAME[meta?.icon ?? SOCIAL_FALLBACK_ICON] ?? Globe;
}

/**
 * The accessible name for a social link.
 *
 * AN ICON-ONLY LINK WITH NO NAME IS UNUSABLE — a screen reader announces "link" and stops — so this
 * must return something for every row, including a row an administrator half-filled.
 *
 * The cascade, in the order it resolves:
 *
 *   1. The editor's own label. They typed it about this account; nothing here knows better.
 *   2. The platform's name from `SOCIAL_PLATFORMS`, unless the platform is literally `other` —
 *      that row's label is the picker's prompt ("Something else"), which is a thing to read in a form
 *      and not a thing to read out loud on a link.
 *   3. The URL's host, trimmed of `www.`. This step is the FOOTER's, not the contact page's: that copy
 *      stopped at the raw slug, so an "other" row with no label announced itself as the word "other".
 *      Keeping the better of the two behaviours is the point of having one implementation.
 *
 * `new URL` cannot throw on a value that reached here — `socialLinkSchema`'s `externalUrl` validated it
 * — but the guard costs nothing, and a footer is not worth crashing a page over.
 */
export function socialLabel(link: SocialLink): string {
  const label = link.label.trim();
  if (label.length > 0) return label;

  const meta = socialPlatformMeta(link.platform);
  if (meta && meta.value !== "other") return meta.label;

  try {
    return new URL(link.url).hostname.replace(/^www\./i, "");
  } catch {
    return link.platform;
  }
}
