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

/**
 * What a renderer needs from a media row.
 *
 * ⚠ EVERY MEMBER EXCEPT `objectKey` IS OPTIONAL, AND THAT IS A TRAP THIS TYPE HAS ALREADY FALLEN INTO.
 * A `select` that omits `blurDataUrl` still satisfies this and silently loses the blur placeholder; a
 * `select` that omitted the crop columns still satisfied it and silently lost the CROP — which is how
 * every crop an editor had drawn came to be stored and ignored. TypeScript cannot catch that, because
 * "absent" and "not selected" are the same shape.
 *
 * So the guard is not the type, it is `MEDIA_IMAGE_SELECT` in lib/media/select.ts — one exported
 * fragment that every query spreads, and `scripts/media-select-check.ts`, which fails the build when a
 * media `select` is hand-rolled instead. Add a field here and you must add it there.
 */
export interface MediaLike {
  objectKey: string;
  width?: number | null;
  height?: number | null;
  altText?: string | null;
  blurDataUrl?: string | null;
  /**
   * The part of the picture to show, as fractions of the full image. Absent or null means "the whole
   * thing", which renders exactly as an uncropped asset always has — see `cropFrameStyle` in
   * lib/media/crop.ts.
   */
  cropX?: number | null;
  cropY?: number | null;
  cropWidth?: number | null;
  cropHeight?: number | null;
  variants?: { label: string; format: string; objectKey: string; width: number }[];
}

/**
 * Pick the best variant at or above `targetWidth`, falling back to the largest available and then to
 * the original.
 *
 * Upward, never downward: serving a 640px derivative into a 1080px slot is visibly soft, and a
 * reader reads that as a low-quality institution rather than as a caching decision.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ `og` IS EXCLUDED, AND LEAVING IT IN WAS A REAL, WIDE BUG.
 *
 * Every other label is a RESIZE — `fit: "inside"`, so the whole picture survives at a smaller width.
 * `og` is not: lib/storage/derivatives.ts builds it as `resize(1200, 630, { fit: "cover" })`, a hard
 * centre-crop to the social-card shape. It is also the ONE label exempt from that module's "skip sizes
 * the original cannot fill" rule, because a share card has to exist for every picture however small.
 *
 * Put those two facts together with the fallback below and the result is that for any asset whose
 * largest real derivative is under the requested width — which is every image narrower than about
 * 1600px, so a great many of them — `og` was the widest thing in the pool at 1200 and won. The site
 * then served a 1200×630 crop as the picture. On anything portrait that removes most of the subject,
 * which is exactly the "a large part of the image is cut off" report that the whole crop feature was
 * built to answer; the crop feature was answering a different cause.
 *
 * It also broke the cropper. "Choose what is shown" is handed `mediaSrc(asset, 1600)`, so an editor
 * was drawing a rectangle on the already-cropped 1200×630 derivative — the parts of the photograph
 * above and below it could not be recovered, whatever they did with the box.
 *
 * `og` is now reachable only through `ogImageUrl()`, which asks for it BY LABEL, which is the only
 * place that legitimately wants that shape. If excluding it empties the pool, the answer is null and
 * `mediaSrc` falls back to `media.objectKey` — the ORIGINAL, uncropped and full size. That is the right
 * fallback rather than a lucky one: a slightly heavy original beats a picture with its subject cut out.
 * (`thumb` is always generated — the skip rule requires `targetWidth > VARIANT_WIDTHS.thumb`, which is
 * false for `thumb` itself — so in practice the pool is never empty.)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function pickVariant(
  media: MediaLike,
  targetWidth: number,
  preferredFormat: "avif" | "webp" = "webp"
): { objectKey: string; width: number } | null {
  const variants = (media.variants ?? []).filter((variant) => variant.label !== "og");
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
 *
 * ⚠ A DERIVATIVE NARROWER THAN THE ORIGINAL IS NEVER SERVED INTO A SLOT THAT ASKED FOR MORE, and this
 * clause is the other half of excluding `og` from `pickVariant`. lib/storage/derivatives.ts skips any
 * size the original cannot fill, so a 565px-wide photograph has no `sm` and no `md` — its only real
 * derivative is `thumb` at 320. Before `og` was excluded, such an asset answered with the 1200px og
 * crop, which was wrong in framing but at least large; excluding it alone would have swapped one fault
 * for another and served a 320px file into a 400px portrait frame, which reads as a blurred photograph.
 *
 * So when the best derivative is BOTH narrower than what was asked for AND narrower than the original,
 * the original wins. It is the only thing that carries the full resolution the uploader gave us, and the
 * schema guarantees it still exists ("Originals are retained forever"). The cost is bytes on a handful of
 * assets nobody has re-uploaded at a larger size; the alternative is a soft picture of somebody's face.
 */
export function mediaSrc(media: MediaLike | null | undefined, targetWidth = 1080): string | null {
  if (!media) return null;
  const variant = pickVariant(media, targetWidth);
  if (!variant) return publicObjectUrl(media.objectKey);

  const originalWidth = media.width ?? 0;
  const tooSmall = variant.width < targetWidth && originalWidth > variant.width;
  return publicObjectUrl(tooSmall ? media.objectKey : variant.objectKey);
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
