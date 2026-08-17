import type { CSSProperties } from "react";

/**
 * Crop geometry — the numbers, the test, and the CSS. Shared by the studio and by the public site.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS MODULE EXISTS AT ALL, AND WHY IT IS NOT IN `components/studio/ImageCropper.tsx`.
 *
 * It used to be. That file carries `"use client"`, and a plain function exported from a client module
 * and imported by a Server Component is not the function — it is a client reference, and calling it on
 * the server throws. `MediaImage` is deliberately server-renderable (no `"use client"`, so `next/image`
 * stays out of every page's client bundle), so it could not reach the geometry, so IT NEVER APPLIED THE
 * CROP AT ALL: the columns were written by the cropper, saved by the API, and read by nothing.
 *
 * That is the whole of the "cropping does not work" report. The rectangle was always correct and always
 * ignored. The old home said so in a standing note — "MOVE THIS FUNCTION BEFORE `MediaImage` CALLS IT" —
 * and this file is that move.
 *
 * NO REACT, NO PRISMA, NO ENV. `CSSProperties` is a type and erases at build. Everything here is pure,
 * so it runs identically in a Server Component, in a client dialog, and in a test.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * The crop, in fractions of the FULL image, origin at the top left.
 *
 * FRACTIONS, NOT PIXELS, and the reason is `VARIANT_WIDTHS` in lib/media/url.ts: the same asset is
 * served at six widths from 320 to 2560, and a pixel rectangle is meaningful against exactly one of
 * them. Fractions survive the derivative pipeline, a later regeneration at different widths, and the
 * `og` variant's forced 1200 × 630.
 */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The whole picture, which is what "no crop" means and what a reset returns to. */
export const FULL_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };

/**
 * The five columns a crop occupies on a row, as they arrive from Prisma.
 *
 * A structural type rather than a Prisma model type: the same five fields arrive on a `MediaAsset`
 * select, on an upload response and on a placement override, and naming one of those here would tie
 * this module to whichever came first.
 */
export interface CropColumns {
  cropX?: number | null;
  cropY?: number | null;
  cropWidth?: number | null;
  cropHeight?: number | null;
}

/**
 * Is this rectangle usable? Anything else is treated as "no crop" and the whole picture is shown.
 *
 * The render side and the studio share this exact test, so a row written by an older client, a
 * hand-edited database or a future bug degrades to the whole image, cover-fit — never to a stretched or
 * empty frame. A CHECK constraint was considered and rejected for the same reason; see
 * prisma/migrations/20260816190000_media_asset_crop/migration.sql.
 */
export function isUsableCrop(rect: Partial<CropRect> | null | undefined): rect is CropRect {
  if (!rect) return false;
  const { x, y, width, height } = rect;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return false;
  }
  if (![x, y, width, height].every(Number.isFinite)) return false;
  if (width <= 0 || height <= 0) return false;
  // A hair over 1 is allowed on the sums because the numbers come from floating-point division and
  // `0.3 + 0.7` is famously not 1. A hair is not a crop.
  return x >= 0 && y >= 0 && x + width <= 1.0001 && y + height <= 1.0001;
}

/**
 * The crop stored on a row, or null for "nobody has chosen — show the whole picture".
 *
 * ⚠ A ROW UPLOADED BEFORE THIS FEATURE EXISTED CARRIES NULLS, AND NULLS MEAN THE WHOLE IMAGE — never a
 * zero-size box. `isUsableCrop` rejects the undefined members, the answer is null, and every caller
 * reads null as `FULL_CROP`: the dialog opens on the whole picture and the render side cover-fits it
 * exactly as it did before the crop columns existed. That is the entire back-compatibility story, and it
 * is why the columns are nullable rather than defaulted to 0/0/1/1 — a default would be
 * indistinguishable from a decision somebody made.
 *
 * ⚠ THE `?? undefined` ON EACH LINE IS LOAD-BEARING, not noise. The columns are `number | null` and
 * `isUsableCrop` takes a `Partial<CropRect>`, whose members are `number | undefined`; passing the nulls
 * straight through does not typecheck, and widening the predicate instead would weaken the one test the
 * studio and the render side share.
 */
export function storedCrop(row: CropColumns | null | undefined): CropRect | null {
  if (!row) return null;
  const rect = {
    x: row.cropX ?? undefined,
    y: row.cropY ?? undefined,
    width: row.cropWidth ?? undefined,
    height: row.cropHeight ?? undefined
  };
  return isUsableCrop(rect) ? rect : null;
}

/** Is this crop indistinguishable from the whole picture? Then there is nothing worth storing. */
export function isWholeImage(rect: CropRect): boolean {
  return rect.x < 0.001 && rect.y < 0.001 && rect.width > 0.999 && rect.height > 0.999;
}

/**
 * The CSS that shows `rect` of an image inside a frame — the geometry `MediaImage` uses.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * PURE PERCENTAGES, NO MEASUREMENT, so this works in a Server Component and needs no ResizeObserver.
 *
 * The frame is `position: relative; overflow: hidden` with its own `aspect-ratio`. Inside it sits a box
 * holding the FULL image, sized so that the crop sub-rectangle comes out exactly frame-sized:
 *
 *     width  = 100 / rect.width  %          → the crop's width becomes 100% of the frame
 *     height = 100 / rect.height %          → the crop's height becomes 100% of the frame
 *     left   = −(rect.x / rect.width)  ×100% → slide the crop's left edge onto the frame's
 *     top    = −(rect.y / rect.height) ×100%
 *
 * The image inside that box is `object-fit: cover`, and the arithmetic of why is worth writing down.
 * The box's own aspect ratio works out at `frameAspect × (rect.height / rect.width)`. When the frame is
 * the shape the editor cropped for — a 16:9 crop landing in a 16:9 hero, which is the case this whole
 * feature exists to serve — that expression collapses to the image's NATURAL aspect ratio, so `cover`
 * has nothing to do and the picture is neither stretched nor re-trimmed. The crop is shown exactly.
 *
 * ⚠ `FULL_CROP` PRODUCES EXACTLY TODAY'S RENDERING, and that is what makes wiring this in safe. Feed it
 * 0/0/1/1 and it returns width 100%, height 100%, left 0, top 0 — an `inset: 0` box with a cover-fit
 * image in it, which is what `next/image`'s own `fill` already does. So an asset nobody has cropped
 * cannot move by a pixel, and there are thousands of those.
 *
 * ⚠ WHEN THE FRAME IS A DIFFERENT SHAPE FROM THE CROP, `cover` RE-TRIMS FROM THE CENTRE OF THE CROP. A
 * 16:9 crop dropped into a square tile loses its own left and right edges. That is a real limitation and
 * it is the honest one: a single stored rectangle cannot be simultaneously correct for a 21:9 banner and
 * a 1:1 avatar — which is precisely why a crop can also be overridden per placement. What this
 * guarantees is that the trimming happens around the region the editor chose instead of around the
 * middle of the original frame, which is the whole complaint. `object-fit: contain` was the alternative
 * and is worse — it letterboxes, so a gallery of mixed shapes grows grey bars and the layout stops
 * reading as a grid.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function cropFrameStyle(rect: CropRect): CSSProperties {
  return {
    position: "absolute",
    width: `${100 / rect.width}%`,
    height: `${100 / rect.height}%`,
    left: `${-(rect.x / rect.width) * 100}%`,
    top: `${-(rect.y / rect.height) * 100}%`
  };
}

/**
 * What the `<img>` INSIDE a crop box needs, so a `transform` on it still pivots where a reader expects.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ WITHOUT THIS, EVERY HOVER ZOOM ON A CROPPED PICTURE SLIDES OFF ITS SUBJECT.
 *
 * Five surfaces scale the image on hover through `MediaImage`'s `imageClassName` — `EntityCard`, which is
 * the card used across the whole site, `StoryPicture` at `scale-[1.18]`, and the gallery grids on the
 * event, gallery and project pages. `transform-origin` defaults to the centre of the element being
 * transformed, and before the crop existed that element filled the frame, so "the centre" was the centre
 * of what the reader could see.
 *
 * Inside a crop box it is not. The `<img>` now fills the box holding the WHOLE picture, and the frame is
 * only the sub-rectangle `[x, x+w] × [y, y+h]` of it — so scaling about the image's centre pushes the
 * visible region towards a part of the photograph the editor deliberately cropped out. On a tight or
 * off-centre crop the subject walks out of frame on hover, which reads as the crop moving by itself.
 *
 * The frame's centre, in the box's own coordinates, is exactly `(x + w/2, y + h/2)` — the crop rectangle's
 * own centre, because the box IS the full image and the rectangle is expressed as fractions of it. One
 * property, no extra element, and `scale()` zooms about what is on screen again.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function cropImageStyle(rect: CropRect): CSSProperties {
  return {
    transformOrigin: `${(rect.x + rect.width / 2) * 100}% ${(rect.y + rect.height / 2) * 100}%`
  };
}
