import "server-only";
import sharp from "sharp";
import { VARIANT_LABELS, VARIANT_WIDTHS, type VariantLabel } from "@/lib/media/url";
import { buildVariantKey } from "./keys";
import { putObject } from "./client";

/**
 * The responsive-image pipeline.
 *
 * Runs ONCE per upload, server-side, and writes every derivative the site will ever ask for. The
 * alternative — resizing on demand — turns the first visitor to every page into the person who pays
 * for it, and on a page with thirty gallery thumbnails that is thirty cold resizes in one request.
 *
 * FOUR RULES, each of which was a visible defect somewhere before it was a rule:
 *
 *   1. **Never upscale.** `withoutEnlargement` means a 900px original produces `md` (1080) at its
 *      own 900px and no `lg`/`xl` at all. An upscaled derivative is strictly worse than the original
 *      and larger on the wire.
 *   2. **The original is retained, untouched.** A pipeline that has thrown its source away can never
 *      be re-run with better settings.
 *   3. **EXIF orientation is APPLIED, then stripped.** `rotate()` with no argument bakes the
 *      orientation tag into the pixels; without it every phone photograph taken in portrait renders
 *      sideways in browsers that ignore the tag on a resized image. Stripping the rest of the
 *      metadata afterwards is a privacy measure — a field photograph carries GPS coordinates.
 *   4. **A failed derivative is REPORTED, never silently skipped.** The caller writes what actually
 *      landed; a variant row for an object that does not exist is a broken image with a healthy
 *      database.
 */

/** Formats emitted per size. AVIF first because the browser takes the first it accepts. */
const FORMATS = ["avif", "webp"] as const;
type DerivativeFormat = (typeof FORMATS)[number];

/**
 * Quality per format. AVIF is set lower than WebP ON PURPOSE — the two scales are not comparable,
 * and AVIF at 50 is visually equivalent to WebP at 78 while being roughly 30% smaller.
 */
const QUALITY: Record<DerivativeFormat, number> = { avif: 50, webp: 78 };

const MIME: Record<DerivativeFormat, string> = { avif: "image/avif", webp: "image/webp" };

export interface GeneratedVariant {
  label: VariantLabel;
  format: DerivativeFormat;
  objectKey: string;
  width: number;
  height: number;
  byteSize: number;
}

export interface DerivativeResult {
  variants: GeneratedVariant[];
  /** Sizes that could not be produced, with the reason — surfaced in the CMS, never swallowed. */
  failed: { label: VariantLabel; format: DerivativeFormat; reason: string }[];
  width: number;
  height: number;
  blurDataUrl: string | null;
}

export interface ImageProbe {
  width: number;
  height: number;
  format: string | null;
  hasAlpha: boolean;
}

/** Read dimensions without decoding the whole image. Returns null for anything sharp cannot parse. */
export async function probeImage(bytes: Buffer): Promise<ImageProbe | null> {
  try {
    const metadata = await sharp(bytes, { failOn: "none" }).metadata();
    if (!metadata.width || !metadata.height) return null;
    // `metadata()` reports the STORED dimensions. For an EXIF-rotated photograph the rendered
    // dimensions are transposed, and using the stored pair produces an aspect-ratio box that is
    // wrong by exactly 90° — the classic "portrait photo in a landscape frame" layout shift.
    const rotated = metadata.orientation !== undefined && metadata.orientation >= 5;
    return {
      width: rotated ? metadata.height : metadata.width,
      height: rotated ? metadata.width : metadata.height,
      format: metadata.format ?? null,
      hasAlpha: Boolean(metadata.hasAlpha)
    };
  } catch {
    return null;
  }
}

/**
 * A tiny blurred placeholder as a data URI, for `next/image`'s `blurDataURL`.
 *
 * 16px wide and WebP: the whole point is that it arrives inside the HTML document, so it must be
 * under about 1 KB. A JPEG at this size is larger for worse quality.
 */
export async function generateBlurDataUrl(bytes: Buffer): Promise<string | null> {
  try {
    const buffer = await sharp(bytes, { failOn: "none" })
      .rotate()
      .resize(16, 16, { fit: "inside" })
      .webp({ quality: 40 })
      .toBuffer();
    return `data:image/webp;base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Generate and upload every derivative for an image.
 *
 * Sequential rather than parallel: sharp holds the decoded bitmap in memory, and twelve concurrent
 * decodes of a 40-megapixel scan is how a serverless function meets its memory limit. The wall-clock
 * cost is paid once, at upload, by the person who chose to upload it.
 */
export async function generateDerivatives(input: {
  originalKey: string;
  bytes: Buffer;
}): Promise<DerivativeResult> {
  const probe = await probeImage(input.bytes);
  if (!probe) {
    return { variants: [], failed: [], width: 0, height: 0, blurDataUrl: null };
  }

  const variants: GeneratedVariant[] = [];
  const failed: DerivativeResult["failed"] = [];

  for (const label of VARIANT_LABELS) {
    const targetWidth = VARIANT_WIDTHS[label];

    // Skip sizes the original cannot fill. `og` is exempt: a social preview must exist at 1200×630
    // for EVERY image, even a small one, or the card renders with no picture at all.
    if (label !== "og" && probe.width < targetWidth && targetWidth > VARIANT_WIDTHS.thumb) {
      const largerExists = VARIANT_LABELS.some(
        (other) => other !== "og" && VARIANT_WIDTHS[other] <= probe.width
      );
      if (largerExists) continue;
    }

    for (const format of FORMATS) {
      try {
        const pipeline = sharp(input.bytes, { failOn: "none" }).rotate();

        const resized =
          label === "og"
            ? pipeline.resize(VARIANT_WIDTHS.og, 630, {
                fit: "cover",
                position: "attention",
                withoutEnlargement: false
              })
            : pipeline.resize(targetWidth, undefined, {
                fit: "inside",
                withoutEnlargement: true
              });

        const buffer =
          format === "avif"
            ? await resized.avif({ quality: QUALITY.avif, effort: 4 }).toBuffer()
            : await resized.webp({ quality: QUALITY.webp, effort: 4 }).toBuffer();

        const outputMeta = await sharp(buffer).metadata();
        const objectKey = buildVariantKey({ originalKey: input.originalKey, label, format });

        await putObject({ key: objectKey, body: buffer, contentType: MIME[format] });

        variants.push({
          label,
          format,
          objectKey,
          width: outputMeta.width ?? targetWidth,
          height: outputMeta.height ?? 0,
          byteSize: buffer.byteLength
        });
      } catch (error) {
        failed.push({
          label,
          format,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  return {
    variants,
    failed,
    width: probe.width,
    height: probe.height,
    blurDataUrl: await generateBlurDataUrl(input.bytes)
  };
}

/** Image MIME types the derivative pipeline can actually read. */
export const DERIVABLE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/tiff",
  "image/gif"
]);

/**
 * SVG is deliberately ABSENT from the derivable set and handled separately.
 *
 * An SVG is a document, not a bitmap: it can contain `<script>`, external references and XXE
 * payloads, and serving one from the same origin as the CMS is a stored-XSS primitive. Uploaded SVGs
 * are stored, served with `Content-Disposition: attachment` and a restrictive CSP, and never
 * rendered inline from user content.
 */
export function isSvg(mimeType: string): boolean {
  return mimeType === "image/svg+xml";
}
