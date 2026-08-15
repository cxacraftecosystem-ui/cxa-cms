import "server-only";
import type { Metadata } from "next";
import { siteName, siteUrl } from "@/lib/env";
import { ogImageUrl, type MediaLike } from "@/lib/media/url";
import { truncateWords } from "@/lib/utils";

/**
 * Metadata construction, in one place.
 *
 * Every `generateMetadata` on the site funnels through `pageMetadata()` so four things cannot be got
 * wrong independently on twenty-five pages:
 *
 *   1. **The canonical URL is always absolute and always set.** A canonical that is relative, or
 *      absent, is how a filtered listing (`/publications?year=2024`) gets indexed as a separate page
 *      competing with its own parent.
 *   2. **The description is truncated on a word boundary at 160 characters.** Search engines cut it
 *      anyway; cutting it here means the cut lands somewhere a human chose.
 *   3. **`noIndex` sets BOTH `robots` and `googleBot`.** Setting only the first leaves Google's
 *      crawler following its own directive, which is not the same directive.
 *   4. **An Open Graph image is always emitted**, falling back to the site default, because a card
 *      with no image is a card most platforms render as a bare grey rectangle.
 */

const MAX_DESCRIPTION = 160;

export interface PageMetadataInput {
  title: string;
  description?: string | null;
  /** Path WITH a leading slash, e.g. "/research/heritage-ai". */
  path: string;
  image?: MediaLike | null;
  /** Absolute URL, used when the entity has no media asset (e.g. a generated OG route). */
  imageUrl?: string | null;
  noIndex?: boolean;
  type?: "website" | "article" | "profile";
  publishedTime?: Date | null;
  modifiedTime?: Date | null;
  authors?: string[];
  keywords?: string[];
  /** Set when the content genuinely lives elsewhere — a cross-posted article, a mirrored dataset. */
  canonicalOverride?: string;
}

export function absoluteUrl(path: string): string {
  const base = siteUrl();
  if (!path || path === "/") return base;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export function pageMetadata(input: PageMetadataInput): Metadata {
  const canonical = input.canonicalOverride ?? absoluteUrl(input.path);
  const description = input.description
    ? truncateWords(input.description.replace(/\s+/g, " ").trim(), MAX_DESCRIPTION)
    : undefined;

  /**
   * The social card, or NOTHING AT ALL — and "nothing" is the interesting branch.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * ⚠ WITH NO IMAGE OF ITS OWN, THIS EMITS NO `images` KEY, SO NEXT'S FILE CONVENTION TAKES OVER.
   *
   * Next applies an `opengraph-image.tsx` route ONLY when the segment's metadata does not already
   * carry `openGraph.images` (`mergeStaticMetadata` in next/dist/lib/metadata/resolve-metadata).
   * So a hard-coded fallback here does not merely duplicate the file convention — it SUPPRESSES it,
   * and every per-type card in the codebase becomes unreachable.
   *
   * ⚠ AND THE URL CANNOT BE BUILT BY HAND. Next serves those routes at a CACHE-BUSTED path
   * (`/people/x/opengraph-image-17pym6`), never at the plain one, and the suffix is a build-time hash
   * no application code can know. An earlier attempt at this passed `absoluteUrl(".../opengraph-image")`
   * and every affected page advertised a card that 404s — strictly worse than the generic card,
   * because a platform that fetches a 404 renders a broken image rather than falling back.
   *
   * Omitting the key gets both halves right for free: Next resolves the NEAREST `opengraph-image` in
   * the segment hierarchy — the per-type card where one exists, `app/opengraph-image.tsx` everywhere
   * else — and writes the correct hashed URL itself.
   *
   * ⚠ NOTHING SURFACES THIS CLASS OF MISTAKE. A metadata URL is never requested by the application,
   * only by somebody else's crawler, so the page renders perfectly either way. The same omission once
   * shipped as `/og-default.png`, a file that has never existed in this repository.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  const image = input.imageUrl ?? ogImageUrl(input.image);

  return {
    title: input.title,
    description,
    keywords: input.keywords?.length ? input.keywords : undefined,
    alternates: { canonical },
    robots: input.noIndex
      ? {
          index: false,
          follow: false,
          // Google's crawler reads its own key. Setting only `index/follow` above leaves googleBot
          // on the default, which is the opposite of what was asked for.
          googleBot: { index: false, follow: false }
        }
      : { index: true, follow: true },
    openGraph: {
      type: input.type === "profile" ? "profile" : input.type === "article" ? "article" : "website",
      title: input.title,
      description,
      url: canonical,
      siteName: siteName(),
      // Spread, so the key is ABSENT rather than undefined when there is no image — see above. An
      // `images: undefined` would still count as "the segment declared images" to some resolvers.
      ...(image ? { images: [{ url: image, width: 1200, height: 630, alt: input.title }] } : {}),
      ...(input.type === "article"
        ? {
            publishedTime: input.publishedTime?.toISOString(),
            modifiedTime: input.modifiedTime?.toISOString(),
            authors: input.authors
          }
        : {})
    },
    twitter: {
      card: "summary_large_image",
      title: input.title,
      description,
      ...(image ? { images: [image] } : {})
    }
  };
}

/**
 * JSON-LD, rendered by the page as a `<script type="application/ld+json">`.
 *
 * ⚠ The output MUST be escaped before it reaches the DOM: a `</script>` sequence inside any string
 * value — a project title, a person's biography — terminates the script element early and everything
 * after it is parsed as HTML. `serializeJsonLd` below does that escaping; use it, never
 * `JSON.stringify` directly.
 */
export function serializeJsonLd(data: Record<string, unknown>): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export function organizationJsonLd(input: {
  name: string;
  description?: string | null;
  logoUrl?: string | null;
  email?: string | null;
  telephone?: string | null;
  address?: {
    street?: string | null;
    city?: string | null;
    region?: string | null;
    postalCode?: string | null;
    country?: string | null;
  } | null;
  sameAs?: string[];
}): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "ResearchOrganization",
    name: input.name,
    url: siteUrl(),
    ...(input.description ? { description: input.description } : {}),
    ...(input.logoUrl ? { logo: input.logoUrl } : {}),
    ...(input.email ? { email: input.email } : {}),
    ...(input.telephone ? { telephone: input.telephone } : {}),
    ...(input.address
      ? {
          address: {
            "@type": "PostalAddress",
            streetAddress: input.address.street ?? undefined,
            addressLocality: input.address.city ?? undefined,
            addressRegion: input.address.region ?? undefined,
            postalCode: input.address.postalCode ?? undefined,
            addressCountry: input.address.country ?? undefined
          }
        }
      : {}),
    ...(input.sameAs?.length ? { sameAs: input.sameAs } : {})
  };
}

/**
 * The WebSite node, rendered once beside the organisation in the public site frame
 * (app/(site)/layout.tsx).
 *
 * ⚠ NO `potentialAction`/`SearchAction`, deliberately. robots.ts disallows `/search` — a results page
 * is an unbounded URL space (argument (b) there) — and a sitelinks search box that points crawlers at
 * a URL they are asked not to fetch is a mixed message: validators flag it and Google ignores it.
 */
export function webSiteJsonLd(input: { name: string }): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: input.name,
    url: siteUrl()
  };
}

export function articleJsonLd(input: {
  title: string;
  description?: string | null;
  path: string;
  imageUrl?: string | null;
  publishedAt?: Date | null;
  updatedAt?: Date | null;
  authorName?: string | null;
  publisherName: string;
}): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: input.title,
    ...(input.description ? { description: input.description } : {}),
    mainEntityOfPage: { "@type": "WebPage", "@id": absoluteUrl(input.path) },
    ...(input.imageUrl ? { image: [input.imageUrl] } : {}),
    ...(input.publishedAt ? { datePublished: input.publishedAt.toISOString() } : {}),
    ...(input.updatedAt ? { dateModified: input.updatedAt.toISOString() } : {}),
    ...(input.authorName ? { author: { "@type": "Person", name: input.authorName } } : {}),
    publisher: { "@type": "Organization", name: input.publisherName }
  };
}

/**
 * Breadcrumbs.
 *
 * `position` is 1-based, which is what the specification requires and what every validator checks
 * first — a 0-based list is silently ignored rather than reported as an error.
 */
export function breadcrumbJsonLd(trail: { name: string; path: string }[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((entry, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: entry.name,
      item: absoluteUrl(entry.path)
    }))
  };
}

export function scholarlyArticleJsonLd(input: {
  title: string;
  authorLine: string;
  year: number;
  venue?: string | null;
  doi?: string | null;
  path: string;
}): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "ScholarlyArticle",
    headline: input.title,
    author: input.authorLine
      .split(/;|\band\b/)
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => ({ "@type": "Person", name })),
    datePublished: String(input.year),
    ...(input.venue ? { isPartOf: { "@type": "Periodical", name: input.venue } } : {}),
    ...(input.doi ? { identifier: `https://doi.org/${input.doi}` } : {}),
    mainEntityOfPage: { "@type": "WebPage", "@id": absoluteUrl(input.path) }
  };
}

export function eventJsonLd(input: {
  title: string;
  description?: string | null;
  path: string;
  startsAt: Date;
  endsAt?: Date | null;
  venue?: string | null;
  address?: string | null;
  onlineUrl?: string | null;
  mode: "IN_PERSON" | "ONLINE" | "HYBRID";
  imageUrl?: string | null;
  organiserName: string;
}): Record<string, unknown> {
  const attendanceMode =
    input.mode === "ONLINE"
      ? "https://schema.org/OnlineEventAttendanceMode"
      : input.mode === "HYBRID"
        ? "https://schema.org/MixedEventAttendanceMode"
        : "https://schema.org/OfflineEventAttendanceMode";

  return {
    "@context": "https://schema.org",
    "@type": "Event",
    name: input.title,
    ...(input.description ? { description: input.description } : {}),
    startDate: input.startsAt.toISOString(),
    ...(input.endsAt ? { endDate: input.endsAt.toISOString() } : {}),
    eventAttendanceMode: attendanceMode,
    eventStatus: "https://schema.org/EventScheduled",
    ...(input.imageUrl ? { image: [input.imageUrl] } : {}),
    location:
      input.mode === "ONLINE"
        ? { "@type": "VirtualLocation", url: input.onlineUrl ?? absoluteUrl(input.path) }
        : {
            "@type": "Place",
            name: input.venue ?? undefined,
            address: input.address ?? undefined
          },
    organizer: { "@type": "Organization", name: input.organiserName, url: siteUrl() },
    url: absoluteUrl(input.path)
  };
}
