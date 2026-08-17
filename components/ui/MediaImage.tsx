/**
 * MediaImage — the ONE way an image from the media library reaches a page.
 *
 * Every asset renders through here so four decisions are made once instead of at forty call sites:
 * which derivative to serve, what the alt text is, how the space is reserved, and what happens when
 * there is nothing to serve at all.
 *
 * ⚠ THE NULL CASE IS THE POINT. `mediaSrc()` returns null when no public base URL is configured or
 * when the asset has no variants yet, and the obvious shortcut — passing that through to `<Image>` —
 * produces `<img src="">`, which every browser resolves to the CURRENT PAGE and re-downloads the
 * whole document as if it were an image. So a null renders a labelled placeholder block instead. The
 * placeholder is not decoration: it is how an editor finds out that storage is not wired up, rather
 * than staring at an empty rectangle.
 *
 * SPACE IS RESERVED BEFORE THE BYTES ARRIVE, from the stored width/height or the `aspect` prop. The
 * frame is `position: relative` with an `aspect-ratio` and the image is `fill`, so the layout is
 * final at first paint and nothing below it moves when the image loads.
 *
 * No `"use client"`: this renders identically in a Server Component and inside a client tree, and
 * marking it would push `next/image` into the client bundle of every page that shows a photograph.
 */

import Image from "next/image";
import { ImageOff } from "lucide-react";

import { cropFrameStyle, cropImageStyle, storedCrop } from "@/lib/media/crop";
import { cdnConfigured, mediaAlt, mediaSrc, type MediaLike } from "@/lib/media/url";
import { cn } from "@/lib/utils";

/**
 * Complete literal class strings, never built by concatenation — a `rounded-${size}` would be purged
 * by the content scanner (contract §5). Note that `rounded-lg` is 16px and `rounded` is 4px, TIGHTER
 * than `rounded-sm`; the names do not tell you the radius here (contract §4).
 */
const RADIUS_CLASSES = {
  none: "",
  sm: "rounded-sm",
  md: "rounded-md",
  lg: "rounded-lg",
  xl: "rounded-xl",
  full: "rounded-full"
} as const;

export type MediaImageRadius = keyof typeof RADIUS_CLASSES;

/**
 * Used only when the asset carries no dimensions and the caller named none. A stated default beats a
 * frame of zero height, which collapses the layout and looks like a missing section.
 */
const FALLBACK_ASPECT = "16 / 9";

/**
 * The `lg` derivative. Handing the optimiser a source at least as wide as any slot on the site means
 * its own resizes land on a cached object instead of re-fetching the full-size original — and it is
 * the width `next.config.ts` was tuned against.
 */
const DEFAULT_TARGET_WIDTH = 1600;

export interface MediaImageProps {
  media: MediaLike | null | undefined;
  /**
   * The layout hint `next/image` needs in `fill` mode. The default of `100vw` is correct but
   * wasteful; pass the real column width wherever one is known, e.g. `"(min-width: 1024px) 33vw, 100vw"`.
   */
  sizes?: string;
  /** Only for an image ABOVE THE FOLD. More than one or two per page and none of them is a priority. */
  priority?: boolean;
  /** Classes for the FRAME (size, radius overrides, ring, margin). */
  className?: string;
  /**
   * How the space is reserved. A number is a width/height ratio (`1.5`), a string is any CSS
   * `aspect-ratio` (`"16 / 9"`), and `"none"` reserves nothing — for a caller whose own container
   * already has a height. Omitted, the asset's stored dimensions are used.
   */
  aspect?: number | string;
  rounded?: MediaImageRadius;
  /** Which derivative to ask for. Rarely worth changing; see `DEFAULT_TARGET_WIDTH`. */
  targetWidth?: number;
  /**
   * Overrides the asset's stored alt text for this one placement. `""` is MEANINGFUL — it marks the
   * image decorative and tells a screen reader to skip it, which is right when an adjacent caption
   * already says the same thing.
   */
  alt?: string;
  /**
   * Classes for the `<img>` itself. It is `object-cover` by default; because `cn()` is a plain join
   * and later classes do NOT win (contract §5), overriding that needs `!object-contain`.
   */
  imageClassName?: string;
  /**
   * Set false to IGNORE the asset's stored crop and draw the whole picture.
   *
   * ⚠ THIS EXISTS FOR THE STUDIO, AND NOTHING ON THE PUBLIC SITE SHOULD PASS IT. A screen whose job is
   * to show an editor what they HAVE — the media library's detail preview, which deliberately asks for
   * `!object-contain` — must show the whole photograph, or the crop dialog opens on a picture that has
   * already had the crop applied to it and the editor is cropping a crop. Everywhere a reader sees an
   * image, the crop is the point and this stays at its default.
   */
  crop?: boolean;
}

function resolveAspect(aspect: number | string | undefined, media: MediaLike | null | undefined) {
  if (aspect === "none") return undefined;
  if (typeof aspect === "number") {
    return Number.isFinite(aspect) && aspect > 0 ? String(aspect) : FALLBACK_ASPECT;
  }
  if (typeof aspect === "string" && aspect.trim().length > 0) return aspect;

  const width = media?.width ?? 0;
  const height = media?.height ?? 0;
  if (width > 0 && height > 0) return `${width} / ${height}`;
  return FALLBACK_ASPECT;
}

export function MediaImage({
  media,
  sizes = "100vw",
  priority = false,
  className,
  aspect,
  rounded = "md",
  targetWidth = DEFAULT_TARGET_WIDTH,
  alt: altOverride,
  imageClassName,
  crop: applyCrop = true
}: MediaImageProps) {
  const crop = applyCrop ? storedCrop(media) : null;

  /**
   * A CROP NEEDS A BIGGER SOURCE THAN THE FRAME DOES, and asking for the frame's width would quietly
   * undo half the point of cropping.
   *
   * The geometry blows the full picture up to `1 / crop.width` times the frame's width so that the
   * chosen rectangle lands frame-sized. A crop keeping 40% of the width therefore paints a source that
   * is 2.5× the frame, and asking `mediaSrc` for the frame's width would hand it a derivative with 40%
   * of the pixels it needs — a sharp decision by an editor rendered as a soft photograph. Scaling the
   * request is the whole fix; `pickVariant` already answers "the largest I have" when nothing is big
   * enough, and `mediaSrc` now prefers the original over a derivative narrower than it.
   */
  const sourceWidth = crop ? Math.round(targetWidth / crop.width) : targetWidth;
  const src = mediaSrc(media, sourceWidth);
  const alt = altOverride ?? mediaAlt(media);
  const ratio = resolveAspect(aspect, media);
  // Inline, not a Tailwind class: an arbitrary `aspect-[3/2]` assembled from data would be purged.
  const frameStyle = ratio ? { aspectRatio: ratio } : undefined;
  const radiusClass = RADIUS_CLASSES[rounded];

  if (!src) {
    const label = media ? "Image unavailable" : "No image";
    // The specific cause, for whoever has to fix it. `configurationWarnings()` says the same thing in
    // Settings → Diagnostics; this is the copy that appears where the hole actually is.
    const title = media
      ? cdnConfigured()
        ? "This asset has no stored variants yet, so there is nothing to display."
        : "No CDN or public storage base URL is configured, so stored images cannot be addressed."
      : undefined;

    return (
      <div
        style={frameStyle}
        title={title}
        // A placeholder standing in for a MEANINGFUL image must still carry that meaning; one
        // standing in for a decorative image stays out of the accessibility tree entirely.
        {...(alt ? { role: "img", "aria-label": alt } : { "aria-hidden": true })}
        className={cn(
          "relative flex items-center justify-center overflow-hidden border border-line-200 bg-surface-100",
          radiusClass,
          className
        )}
      >
        <span className="flex flex-col items-center gap-1.5 p-3 text-center">
          <ImageOff aria-hidden="true" className="h-5 w-5 text-ink-300" />
          <span className="text-xs font-medium text-ink-500">{label}</span>
        </span>
      </div>
    );
  }

  // The optimiser refuses SVG unless `dangerouslyAllowSVG` is set, and answers 400 — which renders as
  // a broken image with no clue why. Tested on the resolved src, because a raster asset with
  // derivatives resolves to a .webp variant and is optimised normally.
  const isVector = /\.svg(\?|$)/i.test(src);

  /**
   * THE CROP, AND WHY IT IS A NESTED BOX RATHER THAN AN `object-position`.
   *
   * ⚠ UNTIL THIS EXISTED, NOTHING ON THE SITE READ THE CROP COLUMNS. The cropper wrote them, the API
   * saved them, `MediaLike` did not carry them and this component did not look — so every rectangle an
   * editor drew was stored and ignored, and photographs kept being trimmed from the centre. That is the
   * whole of the "cropping does not work" report; the rectangles were always right.
   *
   * `object-position` was the cheaper option and it is not enough: it moves the visible window but
   * cannot ZOOM, so a tight crop — the case where somebody has cut a face out of a wide group shot —
   * would come out framed the same as no crop at all. So the image goes inside a box holding the FULL
   * picture, sized and offset by `cropFrameStyle` so that the chosen rectangle lands exactly frame-sized.
   * Pure percentages, no measurement, no `ResizeObserver`, and it renders on the server.
   *
   * ⚠ THE GEOMETRY GOES ON A WRAPPER, NOT ON THE `<Image>`'s OWN `style`, AND THAT IS A DELIBERATE
   * CHOICE BETWEEN TWO WORKING OPTIONS. `next/image` builds its `fill` styles and then spreads the
   * caller's `style` LAST (node_modules/next/dist/shared/lib/get-img-props.js), so
   * `style={cropFrameStyle(rect)}` directly on a `fill` image does win today and would save a DOM node.
   * It wins because of the argument order inside an internal helper, though — an implementation detail
   * of one Next version, invisible from here, and silent if it ever changes: the crop would simply stop
   * applying and every photograph would go back to being centre-trimmed with nothing to show it had
   * happened. A wrapper that owns the absolute positioning outright cannot be quietly overruled by an
   * upgrade. One span is a cheap price for that.
   *
   * `sizes` still describes the FRAME, which is right: it tells the browser how much of the viewport the
   * picture occupies. The crop changes which pixels are shown, not how wide the slot is — the extra
   * source resolution a crop needs is handled by `sourceWidth` above.
   *
   * An asset nobody has cropped takes the plain `fill` branch, so the overwhelming majority of images on
   * the site render through byte-identical markup to before.
   *
   * ⚠ THE CROP BOX CARRIES NO `aria-hidden`, and that is deliberate. It is a positioning box with no
   * meaning of its own, so hiding it looks tidy — but `aria-hidden` hides a whole SUBTREE, and it would
   * take the `<img>` and its alt text with it, silencing every cropped photograph on the site for a
   * screen reader. A `span` with no role and no text contributes nothing to the accessibility tree
   * anyway, so there is nothing to hide.
   */

  return (
    <div
      style={frameStyle}
      className={cn("relative overflow-hidden", radiusClass, className)}
    >
      {crop ? (
        <span style={cropFrameStyle(crop)} className="block">
          <Image
            src={src}
            alt={alt}
            fill
            sizes={sizes}
            priority={priority}
            unoptimized={isVector}
            placeholder={media?.blurDataUrl ? "blur" : "empty"}
            blurDataURL={media?.blurDataUrl ?? undefined}
            // Only inside the crop box, and only because the box is the whole picture rather than the
            // frame — see `cropImageStyle`. The uncropped branch below needs no origin: its image fills
            // the frame, so the default centre already is the centre of what the reader sees.
            style={cropImageStyle(crop)}
            className={cn("object-cover", imageClassName)}
          />
        </span>
      ) : (
        <Image
          src={src}
          alt={alt}
          fill
          sizes={sizes}
          priority={priority}
          unoptimized={isVector}
          // `blurDataURL` — capital URL — is next/image's spelling; the database column is
          // `blurDataUrl`. The mismatch is a silent no-op if you get it the wrong way round.
          placeholder={media?.blurDataUrl ? "blur" : "empty"}
          blurDataURL={media?.blurDataUrl ?? undefined}
          className={cn("object-cover", imageClassName)}
        />
      )}
    </div>
  );
}
