import type { CSSProperties } from "react";

import { isUsableCrop, storedCrop, type CropColumns, type CropRect } from "./crop";
import type { MediaLike } from "./url";

/**
 * Framing per screen size: which photograph, and which part of it, at each width.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS. A single stored rectangle cannot be right at every width, and the hero is the proof:
 * `HeroSection` draws its picture full-bleed with `aspect="none"`, so the same photograph lands in a
 * frame running from roughly 0.5:1 on a phone to 2.5:1 on a wide desktop. A crop framed for one is wrong
 * for the other, and no amount of care in the cropper fixes it — the editor is being asked for one answer
 * to six different questions.
 *
 * So a placement may carry a framing: per screen bucket, optionally a different CROP, and optionally a
 * different PHOTOGRAPH. Neither is required, and the common case stores nothing at all.
 *
 * ⚠ EVERYTHING HERE IS PURE, AND THAT IS THE POINT RATHER THAN A STYLE PREFERENCE. `resolvePicture` is
 * the ONE boundary: storage produces a `Picture`, and BOTH the public renderer and the studio's preview
 * ladder consume it. The last time this area shipped, the crop was stored, editable, and rendered by
 * nothing — the editor's preview and the site disagreed and no gate could see it. Sharing the resolver
 * means a preview that looks right IS right, and the first disagreement is a failing assertion in
 * `scripts/screens-check.ts` rather than a report six weeks later.
 *
 * No `server-only`, no Prisma, no env — a sibling of crop.ts and url.ts, importable from a Server
 * Component, a route handler and the client cropper alike.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export interface ScreenBucket {
  id: string;
  /** What an editor is shown. Named for the device, because "md" means nothing to somebody cropping. */
  label: string;
  /** Inclusive lower bound in CSS pixels. */
  min: number;
  /** Inclusive upper bound, or null for "and wider". Derived from the next bucket; stated for the label. */
  max: number | null;
  /**
   * The `min-width` for a media query, in rem, or null for the bucket that needs no query.
   *
   * ⚠ REM, NOT PX, AND THE TWO ARE NOT INTERCHANGEABLE HERE. Tailwind's stock screens are `40rem`,
   * `48rem`, `64rem`, `80rem`, `96rem`, and a reader who has raised their browser's default font size
   * moves every one of those boundaries. Writing `768px` where Tailwind wrote `48rem` would put the
   * layout's breakpoint and the picture's breakpoint at different widths for exactly the readers who
   * most need the layout to behave — so the queries are generated from the same unit Tailwind uses.
   */
  minRem: string | null;
}

/**
 * The six ranges, ascending, mobile-first.
 *
 * SIX, BECAUSE FIVE BREAKPOINTS MAKE SIX RANGES. Tailwind declares `sm` `md` `lg` `xl` `2xl` and the
 * unprefixed base below all of them — tailwind.config.ts sets no `screens` key, so these are the stock
 * values and they must not be restated as anything else.
 *
 * `as const satisfies` rather than an annotation: the annotation would widen every `id` to `string`, and
 * `ScreenBucketId` would become an alias for `string` that catches no typo.
 */
export const SCREEN_BUCKETS = [
  { id: "base", label: "Phones", min: 0, max: 639, minRem: null },
  { id: "sm", label: "Large phones", min: 640, max: 767, minRem: "40rem" },
  { id: "md", label: "Tablets", min: 768, max: 1023, minRem: "48rem" },
  { id: "lg", label: "Small laptops", min: 1024, max: 1279, minRem: "64rem" },
  { id: "xl", label: "Laptops and desktops", min: 1280, max: 1535, minRem: "80rem" },
  { id: "2xl", label: "Wide desktops", min: 1536, max: null, minRem: "96rem" }
] as const satisfies readonly ScreenBucket[];

export type ScreenBucketId = (typeof SCREEN_BUCKETS)[number]["id"];

export const SCREEN_BUCKET_IDS = SCREEN_BUCKETS.map((bucket) => bucket.id) as readonly ScreenBucketId[];

/** "Tablets (768 to 1023px)" — the device first, the numbers in brackets for whoever needs them. */
export function screenBucketLabel(id: ScreenBucketId): string {
  const bucket = SCREEN_BUCKETS.find((entry) => entry.id === id);
  if (!bucket) return id;
  if (bucket.max === null) return `${bucket.label} (${bucket.min}px and wider)`;
  if (bucket.min === 0) return `${bucket.label} (up to ${bucket.max}px)`;
  return `${bucket.label} (${bucket.min} to ${bucket.max}px)`;
}

/**
 * One bucket's override.
 *
 * ⚠ EVERY MEMBER NULL MEANS **INHERIT**, WHICH IS NOT THE SAME AS "THE WHOLE PICTURE". The whole picture
 * is `0/0/1/1`, and it is a real answer an editor may want — "on desktop, show all of it". The cropper
 * collapses a whole-image rectangle to `null` on the assumption that null means "no crop chosen", which
 * is right for an asset and wrong for a bucket; the panel that edits a bucket therefore has to keep the
 * two apart. `isUsableCrop(FULL_CROP)` is already true, so the render side needs no special case.
 *
 * Extends `CropColumns` structurally so the same four field names travel from Prisma, through this, to
 * `storedCrop` — one name for one number, everywhere.
 */
export interface ScreenOverride extends CropColumns {
  /** A DIFFERENT photograph for this bucket, by media id. Null inherits the one below. */
  mediaId: string | null;
  /** The preset the bucket was cropped on, so the dialog reopens on that shape. Never rendered from. */
  cropAspect: string | null;
}

/** All six buckets, always present. See `emptyScreenFraming` for why they are never grown on demand. */
export type ScreenFraming = { [K in ScreenBucketId]: ScreenOverride };

function emptyOverride(): ScreenOverride {
  return { mediaId: null, cropX: null, cropY: null, cropWidth: null, cropHeight: null, cropAspect: null };
}

/**
 * A framing with nothing set — a FACTORY, never a shared constant.
 *
 * ⚠ ALL SIX KEYS ARE ALWAYS PRESENT, AND GROWING THEM ON DEMAND WOULD MARK A CLEAN FORM DIRTY.
 * `components/studio/useAutosave.ts` decides "has this changed?" by comparing `JSON.stringify` snapshots,
 * and its own note says that is only stable while the keys are built in the same order every render. A
 * framing that gained `md` the moment somebody opened the tablet panel would serialise differently from
 * one that never had it, so simply LOOKING at a bucket would queue a save. Every key exists from the
 * start, in `SCREEN_BUCKETS` order, and `setBucket` rebuilds in that order.
 *
 * A factory rather than a `const` because the result is handed to form state and mutated by the editor;
 * one shared object would be edited by every field on the page at once.
 */
export function emptyScreenFraming(): ScreenFraming {
  const framing = {} as ScreenFraming;
  for (const bucket of SCREEN_BUCKETS) framing[bucket.id] = emptyOverride();
  return framing;
}

/** Replace one bucket, rebuilding in `SCREEN_BUCKETS` order so the serialised form stays stable. */
export function setBucket(
  framing: ScreenFraming | null | undefined,
  id: ScreenBucketId,
  next: ScreenOverride
): ScreenFraming {
  const source = framing ?? emptyScreenFraming();
  const out = {} as ScreenFraming;
  for (const bucket of SCREEN_BUCKETS) {
    out[bucket.id] = bucket.id === id ? next : (source[bucket.id] ?? emptyOverride());
  }
  return out;
}

/** Is anything set at all? A framing of six empty buckets must behave exactly like no framing. */
export function isEmptyScreenFraming(framing: ScreenFraming | null | undefined): boolean {
  if (!framing) return true;
  return SCREEN_BUCKETS.every((bucket) => {
    const override = framing[bucket.id];
    if (!override) return true;
    return override.mediaId === null && storedCrop(override) === null;
  });
}

/** Every alternate photograph a framing names, so a caller knows which extra rows to fetch. */
export function screenFramingMediaIds(framing: ScreenFraming | null | undefined): string[] {
  if (!framing) return [];
  const ids = new Set<string>();
  for (const bucket of SCREEN_BUCKETS) {
    const id = framing[bucket.id]?.mediaId;
    if (typeof id === "string" && id.length > 0) ids.add(id);
  }
  return [...ids];
}

/**
 * One resolved band: what to draw from this width upward.
 *
 * `crop` IS ALREADY RESOLVED. Calling `storedCrop(band.media)` again is the one mistake that would
 * silently ignore every override, so it is stated here rather than left to be discovered.
 */
export interface PictureBand {
  bucket: ScreenBucketId;
  /** The `min-width` for this band's media query, or null for the first one. */
  minRem: string | null;
  media: MediaLike;
  crop: CropRect | null;
  /** Which bucket the PHOTOGRAPH came from, for the editor's "inherited from Phones" sentence. */
  mediaFrom: ScreenBucketId;
  /** Which bucket the RECTANGLE came from. Null when it came from the asset's own stored crop. */
  cropFrom: ScreenBucketId | null;
}

/**
 * The bands to draw, ascending, collapsed.
 *
 * THREE GUARANTEES THE RENDER LAYER MAY RELY ON:
 *   1. Non-empty and ascending, and `[0].bucket === "base"` — so no call site needs a non-null assertion.
 *   2. `crop` is resolved (see `PictureBand`).
 *   3. **Length 1 means nothing is overridden**, and a renderer MUST then take the exact path it took
 *      before any of this existed. Thousands of uncropped images depend on that, and it is the assertion
 *      `scripts/screens-check.ts` guards hardest.
 */
export type Picture = readonly [PictureBand, ...PictureBand[]];

/** Two bands are indistinguishable when they draw the same photograph through the same rectangle. */
function sameBand(a: PictureBand, b: PictureBand): boolean {
  if (a.media.objectKey !== b.media.objectKey) return false;
  if (a.crop === null || b.crop === null) return a.crop === b.crop;
  return (
    a.crop.x === b.crop.x &&
    a.crop.y === b.crop.y &&
    a.crop.width === b.crop.width &&
    a.crop.height === b.crop.height
  );
}

/**
 * Resolve a base asset plus a framing into the bands to draw.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE CASCADE IS MOBILE-FIRST AND FILLS FORWARD. A bucket nobody has touched inherits from the nearest
 * smaller bucket that was, and the smallest falls back to the placement's own photograph and that
 * photograph's own stored crop. An editor is never required to fill in six of anything.
 *
 * ⚠ A BUCKET THAT NAMES A DIFFERENT PHOTOGRAPH DROPS THE INHERITED RECTANGLE. A rectangle is fractions
 * of one particular picture; carried onto another it frames whatever happens to sit at those coordinates
 * — a doorway instead of a face — and reads as the crop moving on its own. So a new photograph starts
 * from that asset's own stored crop, and the editor may then crop it for this bucket.
 *
 * ⚠ COLLAPSING COMPARES AGAINST THE BAND BELOW, NOT AGAINST `base`. "Emit a band only if it differs from
 * base" is wrong: with `base = A`, `sm = B`, `md = A`, dropping `md` because it matches base would leave
 * B winning at every width above 640, which is the opposite of what was asked for. Comparing with the
 * previous EMITTED band is what makes the collapse safe.
 *
 * `assetOf` resolves an alternate photograph's row. It returns null before those rows have been fetched,
 * and a bucket whose photograph cannot be resolved inherits rather than rendering nothing — a missing
 * join must never blank a picture that has a perfectly good base.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function resolvePicture(
  base: MediaLike | null | undefined,
  framing: ScreenFraming | null | undefined,
  assetOf: (mediaId: string) => MediaLike | null = () => null
): Picture | null {
  if (!base) return null;

  const bands: PictureBand[] = [];

  let media: MediaLike = base;
  let mediaFrom: ScreenBucketId = "base";
  let crop: CropRect | null = storedCrop(base);
  let cropFrom: ScreenBucketId | null = null;

  for (const bucket of SCREEN_BUCKETS) {
    const override = framing?.[bucket.id];

    if (override) {
      const nextId = override.mediaId;
      if (typeof nextId === "string" && nextId.length > 0) {
        const resolved = assetOf(nextId);
        if (resolved) {
          media = resolved;
          mediaFrom = bucket.id;
          // A different photograph: start again from ITS stored crop, not the inherited rectangle.
          crop = storedCrop(resolved);
          cropFrom = null;
        }
      }

      const rect = storedCrop(override);
      if (rect && isUsableCrop(rect)) {
        crop = rect;
        cropFrom = bucket.id;
      }
    }

    const band: PictureBand = { bucket: bucket.id, minRem: bucket.minRem, media, crop, mediaFrom, cropFrom };
    const previous = bands[bands.length - 1];
    if (!previous || !sameBand(previous, band)) bands.push(band);
  }

  // `base` is the first bucket and always produces a band, so this is a shape assertion rather than a
  // possibility — but the tuple type has to be established somewhere and a cast would be a lie.
  const first = bands[0];
  if (!first) return null;
  return [first, ...bands.slice(1)] as Picture;
}

/** The CSS custom properties one band's rectangle needs. Keyed so the bucket is visible in DevTools. */
function bandVars(band: PictureBand): Record<string, string> {
  const rect = band.crop;
  if (!rect) {
    // No crop at this width: the box is the frame exactly, which is what `FULL_CROP` produces.
    return { "--cxa-crop-w": "100%", "--cxa-crop-h": "100%", "--cxa-crop-x": "0%", "--cxa-crop-y": "0%" };
  }
  return {
    "--cxa-crop-w": `${100 / rect.width}%`,
    "--cxa-crop-h": `${100 / rect.height}%`,
    "--cxa-crop-x": `${-(rect.x / rect.width) * 100}%`,
    "--cxa-crop-y": `${-(rect.y / rect.height) * 100}%`
  };
}

/**
 * The FIRST band's variables, as an inline style.
 *
 * The remaining bands are emitted as flat `@media` rules by the renderer — inline style cannot hold a
 * media query, which is the whole reason the geometry moves into custom properties. Deliberately NOT a
 * chain of `var(--w-2xl, var(--w-xl, …))` fallbacks: that reimplements the cascade in a language with no
 * assertions, and an empty custom property (`--x: ;`) is a valid value that defeats the fallback
 * silently. Filling forward in TypeScript, where `screens-check` can assert it, is the honest version.
 */
export function cropVars(picture: Picture): CSSProperties {
  return bandVars(picture[0]) as CSSProperties;
}

/** Every band's variables, for a renderer emitting one rule per band. */
export function cropVarsFor(band: PictureBand): Record<string, string> {
  return bandVars(band);
}
