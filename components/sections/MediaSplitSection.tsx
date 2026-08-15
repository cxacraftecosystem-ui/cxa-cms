/**
 * MediaSplitSection — one picture on one side, a heading and its text on the other.
 *
 * A Server Component; `Reveal` is the only client piece.
 *
 * ⚠ ON A NARROW SCREEN THE PICTURE ALWAYS COMES FIRST, WHATEVER `side` SAYS. The two halves stack on
 * a phone, and a text-then-image order there puts a full viewport of prose between a caption and the
 * picture it describes — the reader arrives at the image having already read what it was for. `side`
 * therefore only takes effect from `lg` up, where both halves are on screen at once.
 *
 * With no asset resolved the text simply fills the column. That is a legitimate one-column block,
 * and it is what an editor sees while they are still choosing the picture; an empty frame beside the
 * words would read as a broken image rather than as an unfinished one.
 */

import { ArrowRight } from "lucide-react";
import type { PageSection } from "@prisma/client";

import { Reveal } from "@/components/motion/Reveal";
import { LinkButton } from "@/components/ui/Button";
import { MediaImage } from "@/components/ui/MediaImage";
import { publicObjectUrl } from "@/lib/media/url";
import type { ResolvedSectionData } from "@/lib/sections/resolve";
import type { MediaSplitSectionData } from "@/lib/sections/schema";
import { cn } from "@/lib/utils";

export interface MediaSplitSectionProps {
  data: MediaSplitSectionData;
  section: PageSection;
  /** The batched read from `lib/sections/resolve.ts`; `resolved.media` is keyed by ASSET id. */
  resolved?: ResolvedSectionData;
}

/**
 * `MediaLike` carries no asset kind, so the object key is the only signal available here. It matters:
 * a video pushed through the image optimiser answers 400 and draws a broken frame with no clue why.
 */
const VIDEO_KEY = /\.(mp4|webm|ogv|mov|m4v)(\?|$)/i;

export function MediaSplitSection({ data, section, resolved }: MediaSplitSectionProps) {
  const asset = data.mediaId ? resolved?.media[data.mediaId] : undefined;
  const primary = data.primaryCta.label && data.primaryCta.href ? data.primaryCta : null;
  const secondary = data.secondaryCta.label && data.secondaryCta.href ? data.secondaryCta : null;

  if (!asset && !data.heading && !data.body && !primary && !secondary) return null;

  const videoSrc = asset && VIDEO_KEY.test(asset.objectKey) ? publicObjectUrl(asset.objectKey) : null;
  const mediaSide = data.side;

  return (
    <section id={`s-${section.id}`} data-anchor="" className="py-20 md:py-28">
      <div className="shell">
        <div className={cn("grid items-center gap-10 lg:gap-16", asset && "lg:grid-cols-2")}>
          {asset ? (
            <Reveal className={cn("order-1", mediaSide === "right" && "lg:order-2")}>
              <figure>
                {videoSrc ? (
                  // Content video, not a backdrop: it has controls and does not autoplay, so nothing
                  // here moves until the reader asks it to and there is no reduced-motion branch to
                  // get wrong.
                  <video
                    src={videoSrc}
                    controls
                    preload="metadata"
                    className="w-full rounded-lg border border-line-200"
                  />
                ) : (
                  <MediaImage
                    media={asset}
                    rounded="lg"
                    sizes="(min-width: 1024px) 42rem, 100vw"
                    className="w-full border border-line-200 shadow-md"
                  />
                )}

                {data.caption ? (
                  <figcaption className="mt-3 text-sm leading-relaxed text-ink-500">
                    {data.caption}
                  </figcaption>
                ) : null}
              </figure>
            </Reveal>
          ) : null}

          <Reveal className={cn("order-2", mediaSide === "right" && "lg:order-1")}>
            {data.eyebrow ? <p className="eyebrow">{data.eyebrow}</p> : null}

            {data.heading ? (
              <h2
                className={cn(
                  "display-title text-balance text-3xl sm:text-4xl",
                  data.eyebrow && "mt-3"
                )}
              >
                {data.heading}
              </h2>
            ) : null}

            {data.body ? (
              <p className="prose-measure mt-5 text-base leading-relaxed text-ink-700">{data.body}</p>
            ) : null}

            {primary || secondary ? (
              <div className="mt-8 flex flex-wrap items-center gap-3">
                {primary ? (
                  <LinkButton href={primary.href} icon={ArrowRight} iconPosition="end">
                    {primary.label}
                  </LinkButton>
                ) : null}
                {secondary ? (
                  <LinkButton href={secondary.href} variant="secondary">
                    {secondary.label}
                  </LinkButton>
                ) : null}
              </div>
            ) : null}
          </Reveal>
        </div>
      </div>
    </section>
  );
}
