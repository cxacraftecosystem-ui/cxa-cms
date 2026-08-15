/**
 * CraftPhoto — one photograph from the craft manifest, with the credit its licence requires.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * REACH FOR THIS RATHER THAN `next/image` FOR ANYTHING IN `lib/media/craft-imagery.ts`.
 *
 * Not because it is shorter — because the credit is not optional (see ImageCredit.tsx) and a
 * component that renders it automatically is the only version of this rule that survives contact with
 * a hurried afternoon. A hand-composed `<Image src="/craft/warli.jpg">` is one line and is a licence
 * breach; this is one line and is not.
 *
 * ⚠ `MediaImage` IS A DIFFERENT COMPONENT FOR A DIFFERENT SOURCE, and they must not be merged. That
 * one renders an asset an EDITOR uploaded, addressed through the CDN, whose alt text lives in the
 * database and which may legitimately be missing. This one renders a file committed to `public/`,
 * whose dimensions and attribution are known at build time and can never be absent. Their null cases,
 * their alt-text rules and their obligations are all different.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * PARALLAX IS AN OPT-IN MARKER, NOT AN ANIMATION. Passing `parallax` adds `data-craft-parallax` to the
 * `<img>` and an overscan so a scrubbed translation never uncovers an edge — but nothing here moves.
 * The tween belongs to whichever section owns the `useGsapScope`, because a ScrollTrigger needs a
 * trigger element and the photograph is not it. A photograph marked for parallax on a page with no
 * scope is simply a photograph, correctly framed.
 *
 * No `"use client"`: this renders in a Server Component, and marking it would drag `next/image` into
 * the client bundle of every page that shows a craft.
 */

import Image from "next/image";

import { ImageCredit } from "@/components/site/ImageCredit";
import type { CraftImage } from "@/lib/media/craft-imagery";
import { cn } from "@/lib/utils";

/**
 * How much larger than its frame a parallax image is drawn.
 *
 * A layer translated by ±8% of its height must have at least 8% of spare height at both ends or the
 * frame shows through as a bar at the top or bottom of the travel. 1.18 covers ±9% with a margin, and
 * the cost is that the visible crop is slightly tighter — which is why it is opt-in rather than the
 * default for every photograph.
 */
const PARALLAX_OVERSCAN = 1.18;

export interface CraftPhotoProps {
  image: CraftImage;
  /**
   * Overrides the manifest's title as alt text.
   *
   * `""` is MEANINGFUL and marks the photograph decorative — correct when the caption beside it
   * already says the same words, where announcing both makes a screen reader read the sentence twice.
   */
  alt?: string;
  /**
   * How the space is reserved. A CSS `aspect-ratio` string crops to that shape; omitted, the
   * photograph keeps its own proportions and nothing is cropped.
   */
  aspect?: string;
  /** `next/image` sizes hint. The default is correct and wasteful — pass the real column width. */
  sizes?: string;
  /** Only for a photograph ABOVE THE FOLD. More than one or two per page and none of them is one. */
  priority?: boolean;
  /** A sentence of the site's own, under the picture. The credit is rendered separately and always. */
  caption?: string;
  /** Show the region under the caption. On a page that has already said where it is, switch it off. */
  showRegion?: boolean;
  /** Mark for a parallax tween owned by an enclosing `useGsapScope`. Adds overscan; animates nothing. */
  parallax?: boolean;
  /** Render the credit over the photograph instead of under it. For full-bleed placements. */
  creditOverlay?: boolean;
  /**
   * ⚠ OMIT THE ADJACENT CREDIT AND DISCHARGE THE LICENCE THROUGH /credits INSTEAD. The owner's
   * direction for the landing page: no attribution chips in the composition. This stays lawful
   * because CC BY 4.0 §3(a)(2) permits attribution "in any reasonable manner based on the medium,
   * means, and context", and the /credits page — linked from the footer of every page — carries
   * every bundled photograph's author, licence and source in full. It is NOT a licence to forget:
   * a caller may pass this only where /credits genuinely covers the image, which is every
   * manifest photograph and nothing else.
   */
  creditOnCreditsPage?: boolean;
  /** Classes for the `<figure>`. */
  className?: string;
  /** Classes for the frame that clips the image — radius, ring, shadow. */
  frameClassName?: string;
}

export function CraftPhoto({
  image,
  alt,
  aspect,
  sizes = "100vw",
  priority = false,
  caption,
  showRegion = true,
  parallax = false,
  creditOverlay = false,
  creditOnCreditsPage = false,
  className,
  frameClassName
}: CraftPhotoProps) {
  // `??`, not `||`: an empty string is a deliberate "this is decorative" and must survive.
  const altText = alt ?? image.title;

  return (
    <figure className={cn("m-0", className)}>
      <div
        // `isolate` so the overlay credit's stacking context is this frame rather than the page —
        // without it, a credit can paint over a sticky header on a full-bleed placement.
        className={cn("relative isolate overflow-hidden rounded-lg bg-surface-100", frameClassName)}
        style={aspect ? { aspectRatio: aspect } : undefined}
      >
        <Image
          src={image.src}
          alt={altText}
          // `fill` whenever the caller cropped to a shape, because the frame owns the box then.
          // Intrinsic otherwise, so a photograph in a text column reserves its own true height and
          // the paragraph below it never moves when the bytes arrive.
          {...(aspect
            ? { fill: true }
            : { width: image.width, height: image.height })}
          sizes={sizes}
          priority={priority}
          data-craft-parallax={parallax ? "" : undefined}
          /*
           * ⚠ NO `will-change` IN THIS CLASS LIST, DELIBERATELY — and the comment that used to sit
           * here stated the right rule while the code beneath it did the opposite.
           *
           * `parallax` is a render-time marker, not a signal that something is moving now, so a
           * `will-change-transform` keyed off it promoted a layer per photograph for the whole life of
           * the page — including under reduced motion, where nothing animates at all. A full-bleed
           * 1600×900 photograph is roughly 5.8 MB of GPU memory as its own layer.
           *
           * GSAP's `force3D: "auto"` already promotes an element via `translate3d` for the duration of
           * a tween and reverts it afterwards, which IS "set while animating, cleared after" done by
           * the library.
           */
          className={cn("object-cover", aspect ? "" : "h-auto w-full")}
          style={
            parallax
              ? {
                  // Scaled from the CENTRE, so the overscan is spent equally at the top and the
                  // bottom and a tween of ±9% never reaches either edge.
                  transform: `scale(${PARALLAX_OVERSCAN})`,
                  transformOrigin: "center"
                }
              : undefined
          }
        />

        {creditOverlay && !creditOnCreditsPage ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-end p-2">
            {/* Re-enabled on the credit itself: the wrapper is transparent to the pointer so it
                cannot swallow a click meant for the photograph, but the two links inside must
                still be clickable. */}
            <ImageCredit image={image} variant="overlay" className="pointer-events-auto" />
          </div>
        ) : null}
      </div>

      <figcaption className="mt-2.5 space-y-1">
        {caption ? <span className="block text-sm text-ink-700">{caption}</span> : null}
        {showRegion ? (
          <span className="block text-xs font-medium uppercase tracking-wide text-ink-500">
            {image.region}
          </span>
        ) : null}
        {creditOverlay || creditOnCreditsPage ? null : <ImageCredit image={image} />}
      </figcaption>
    </figure>
  );
}
