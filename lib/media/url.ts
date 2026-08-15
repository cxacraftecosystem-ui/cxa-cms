/**
 * Public URLs for stored objects.
 *
 * CLIENT-SAFE ON PURPOSE — no `server-only`, no AWS SDK, no secrets. It reads only
 * `NEXT_PUBLIC_CDN_URL`, which Next inlines at build time, so the same function produces the same
 * URL in a server component, in a client component and inside `generateMetadata`.
 *
 * ⚠ `process.env.NEXT_PUBLIC_CDN_URL` is written out IN FULL rather than read through a variable.
 * Next's build-time substitution is a literal text replacement on `process.env.NEXT_PUBLIC_*`; a
 * dynamic lookup like `process.env[name]` is NOT substituted and silently reads `undefined` in the
 * browser — which would produce a relative URL for every image on the site.
 */

const CDN_BASE = (process.env.NEXT_PUBLIC_CDN_URL ?? "").trim().replace(/\/$/, "");

export function cdnConfigured(): boolean {
  return CDN_BASE.length > 0;
}

/**
 * The public URL for an object key, or null when there is no public base configured.
 *
 * NULL, NOT A GUESS. Returning a plausible-looking relative path when no CDN is configured is the
 * `NEXT_PUBLIC_API_URL` failure from the Field Repository in a new costume (skill §14.1): every
 * signal green, every image broken.
 *
 * ⚠ NULL MEANS "SAY SO", NOT "SIGN IT INSTEAD". This comment used to promise the caller would fall
 * back to a signed URL. No caller does, and none can from here: this module is client-safe on
 * purpose (no `server-only`, no AWS SDK, no secrets), and signing needs all three. `presignDownload`
 * exists but has exactly one caller — `app/api/public/files/[slug]`, for document DOWNLOADS — and
 * nothing signs a URL for an `<img>`. So the real contract is that `MediaImage` draws a labelled
 * placeholder and `lib/env.ts` warns at boot, which is the honest outcome: a reader sees a missing
 * picture and an operator is told why. Anyone adding a signing path must add it above this module,
 * on the server, not by making this one return a URL it cannot legitimately produce.
 */
export function publicObjectUrl(key: string | null | undefined): string | null {
  if (!key) return null;
  if (!CDN_BASE) return null;
  // Each path segment is encoded independently so the slashes survive — `encodeURIComponent` on the
  // whole key would turn every `/` into `%2F` and produce a single flat filename.
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return `${CDN_BASE}/${encoded}`;
}

/** Variant labels the derivative pipeline emits, smallest first. */
export const VARIANT_LABELS = ["thumb", "sm", "md", "lg", "xl", "og"] as const;
export type VariantLabel = (typeof VARIANT_LABELS)[number];

/** Target widths, in step with lib/storage/derivatives.ts. Both must move together. */
export const VARIANT_WIDTHS: Record<VariantLabel, number> = {
  thumb: 320,
  sm: 640,
  md: 1080,
  lg: 1600,
  xl: 2560,
  og: 1200
};

export interface MediaLike {
  objectKey: string;
  width?: number | null;
  height?: number | null;
  altText?: string | null;
  blurDataUrl?: string | null;
  variants?: { label: string; format: string; objectKey: string; width: number }[];
}

/**
 * Pick the best variant at or above `targetWidth`, falling back to the largest available and then to
 * the original.
 *
 * Upward, never downward: serving a 640px derivative into a 1080px slot is visibly soft, and a
 * reader reads that as a low-quality institution rather than as a caching decision.
 */
export function pickVariant(
  media: MediaLike,
  targetWidth: number,
  preferredFormat: "avif" | "webp" = "webp"
): { objectKey: string; width: number } | null {
  const variants = media.variants ?? [];
  if (variants.length === 0) return null;

  const inFormat = variants.filter((variant) => variant.format === preferredFormat);
  const pool = inFormat.length > 0 ? inFormat : variants;

  const atOrAbove = pool
    .filter((variant) => variant.width >= targetWidth)
    .sort((a, b) => a.width - b.width);
  if (atOrAbove[0]) return { objectKey: atOrAbove[0].objectKey, width: atOrAbove[0].width };

  const largest = [...pool].sort((a, b) => b.width - a.width)[0];
  return largest ? { objectKey: largest.objectKey, width: largest.width } : null;
}

/**
 * The `src` for a media asset at a target width.
 *
 * Falls back to the ORIGINAL key when no variant fits, and to null when nothing is servable.
 * `next/image` receives a real URL or the caller renders a placeholder — it never receives `""`,
 * which React renders as an `<img src="">` that re-requests the current page.
 */
export function mediaSrc(media: MediaLike | null | undefined, targetWidth = 1080): string | null {
  if (!media) return null;
  const variant = pickVariant(media, targetWidth);
  return publicObjectUrl(variant?.objectKey ?? media.objectKey);
}

/** The 1200×630 Open Graph image, or null. */
export function ogImageUrl(media: MediaLike | null | undefined): string | null {
  if (!media) return null;
  const og = media.variants?.find((variant) => variant.label === "og");
  return publicObjectUrl(og?.objectKey ?? media.objectKey);
}

/**
 * Alt text, or the empty string.
 *
 * `""` is MEANINGFUL in HTML: it marks an image as decorative and tells a screen reader to skip it.
 * `undefined` makes the reader announce the filename instead, which is worse than silence. So a
 * missing alt deliberately becomes `""` here, and the CMS's accessibility checker is what nags the
 * editor to write a real one.
 */
export function mediaAlt(media: { altText?: string | null } | null | undefined): string {
  return media?.altText?.trim() ?? "";
}
