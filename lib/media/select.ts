import type { Prisma } from "@prisma/client";

/**
 * The ONE list of columns a renderable image needs, and the reason it exists.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS FILE IS A BUG FIX, NOT TIDYING. Forty-four queries across the site and the studio each carried
 * their own hand-written copy of this list, usually as a local `const mediaSelect` or `MEDIA_SELECT`.
 * Nothing tied them together, so when the crop columns were added to `MediaAsset` not one of the
 * forty-four learned about them — and `MediaLike` (lib/media/url.ts) makes every field optional, so
 * every one of them still typechecked. The cropper wrote rectangles, the API saved them, and every
 * renderer silently showed the uncropped picture. `tsc`, `lint` and `route-check` were all green.
 *
 * The lesson is the shape of the fix: a media column is only real once it is in THIS object.
 * `scripts/media-select-check.ts` enforces that by failing when a query names media columns without
 * going through here, so the next column added cannot repeat the same silent loss.
 *
 * `satisfies` rather than an annotation, so the literal keeps its exact shape for Prisma's inference
 * while still being checked against `MediaAssetSelect` — an annotation would widen it to the interface
 * and every `select` spreading it would lose its result type.
 *
 * ⚠ `id` IS NOT HERE. Roughly a third of the call sites need it and the rest do not, and a select that
 * fetches an id nobody reads is harmless while a MISSING id is a type error at the call site — so the
 * ones that need it spread and add it: `{ ...MEDIA_IMAGE_SELECT, id: true }`. `caption` and `credit` are
 * absent for the same reason; only the figure captions on gallery and craft pages read them.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const MEDIA_IMAGE_SELECT = {
  objectKey: true,
  width: true,
  height: true,
  altText: true,
  blurDataUrl: true,
  /**
   * The crop. Four columns, always together — `storedCrop` in lib/media/crop.ts treats a partial set as
   * no crop at all, so selecting three of them would be the same silent loss in a smaller costume.
   * `cropAspect` is deliberately NOT here: it records which preset the editor cropped on so the dialog
   * reopens on that shape, and nothing renders from it.
   */
  cropX: true,
  cropY: true,
  cropWidth: true,
  cropHeight: true,
  /**
   * Ordered smallest first so `pickVariant` walks a sorted list. It sorts defensively anyway, but an
   * unordered fetch made the previous copies of this select differ from one another for no reason.
   */
  variants: {
    select: { label: true, format: true, objectKey: true, width: true },
    orderBy: { width: "asc" }
  }
} as const satisfies Prisma.MediaAssetSelect;

/** The same list plus the row id, for call sites that key or link by it. */
export const MEDIA_IMAGE_SELECT_WITH_ID = {
  ...MEDIA_IMAGE_SELECT,
  id: true
} as const satisfies Prisma.MediaAssetSelect;

/** The same list plus the two credit lines, for figures that print them under the picture. */
export const MEDIA_FIGURE_SELECT = {
  ...MEDIA_IMAGE_SELECT,
  caption: true,
  credit: true
} as const satisfies Prisma.MediaAssetSelect;
