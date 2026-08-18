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
import { VideoPlayer } from "@/components/site/VideoPlayer";
import { LinkButton } from "@/components/ui/Button";
import { MediaImage } from "@/components/ui/MediaImage";
import { pictureFromMap } from "@/lib/media/screens";
import { publicObjectUrl } from "@/lib/media/url";
import { isCaptionsObjectKey, isVideoObjectKey } from "@/lib/media/video";
import type { ResolvedSectionData } from "@/lib/sections/resolve";
import type { MediaSplitSectionData } from "@/lib/sections/schema";
import { cn } from "@/lib/utils";

export interface MediaSplitSectionProps {
  data: MediaSplitSectionData;
  section: PageSection;
  /** The batched read from `lib/sections/resolve.ts`; `resolved.media` is keyed by ASSET id. */
  resolved?: ResolvedSectionData;
}

export function MediaSplitSection({ data, section, resolved }: MediaSplitSectionProps) {
  const asset = data.mediaId ? resolved?.media[data.mediaId] : undefined;
  const primary = data.primaryCta.label && data.primaryCta.href ? data.primaryCta : null;
  const secondary = data.secondaryCta.label && data.secondaryCta.href ? data.secondaryCta : null;

  if (!asset && !data.heading && !data.body && !primary && !secondary) return null;

  // `isVideoObjectKey` is read off lib/media/video.ts so that the studio's form can offer the framing
  // panel on exactly the branch that draws a picture — see its note there.
  const isFilm = Boolean(asset && isVideoObjectKey(asset.objectKey));
  const videoSrc = asset && isFilm ? publicObjectUrl(asset.objectKey) : null;

  /**
   * The film's still and its captions, from the same batched read the picture comes out of.
   *
   * Both are `MediaAsset` ids on the block's own settings, collected by `videoSettingsMediaIds` in
   * lib/sections/resolve.ts — the collector exists precisely so a poster that was never fetched
   * cannot be told apart from a poster that was never chosen (its header says so at length).
   */
  const settings = data.videoSettings;
  const posterAsset = settings.posterMediaId ? resolved?.media[settings.posterMediaId] : undefined;
  const captionsAsset = settings.captionsMediaId
    ? resolved?.media[settings.captionsMediaId]
    : undefined;
  /**
   * The per-screen framing, resolved. It reaches only the image branch: a film is drawn by the
   * browser's own player and no rectangle of ours applies to it. `pictureFromMap` has already folded in
   * the asset's own stored crop, so nothing here re-reads those columns.
   */
  const picture = pictureFromMap(data.mediaId, data.mediaScreens, resolved?.media);
  const mediaSide = data.side;

  return (
    <section id={`s-${section.id}`} data-anchor="" className="py-20 md:py-28">
      <div className="shell">
        <div className={cn("grid items-center gap-10 lg:gap-16", asset && "lg:grid-cols-2")}>
          {asset ? (
            <Reveal className={cn("order-1", mediaSide === "right" && "lg:order-2")}>
              <figure>
                {isFilm ? (
                  /*
                    Content video, not a backdrop, and now through the SAME player every other film on
                    this site uses. It used to be a bare `<video controls>` written out here — which
                    was a perfectly good player and was also the third hand-written one on the site,
                    each with its own accessibility decisions and its own fallback sentence.
                    `VideoPlayer` is one of them, it carries the block's own settings, and it is what
                    makes "start it when it comes into view" and "keep it in the corner" available
                    here rather than only in the video block.

                    ⚠ IT IS INSIDE A FINISHED `Reveal`, WHICH IS THE ONE PLACEMENT RULE THE PLAYER HAS:
                    a permanent transform on an ancestor would make the corner player position itself
                    against this figure instead of against the viewport. `Reveal` writes a transform
                    only while it animates and leaves `none` behind — see the ⚠ in VideoPlayer's own
                    header, where the rule and the check are written out.
                  */
                  <VideoPlayer
                    src={videoSrc}
                    title={data.caption.trim() || data.heading.trim() || "Video"}
                    poster={posterAsset ? publicObjectUrl(posterAsset.objectKey) : null}
                    // WebVTT or nothing: a browser handed anything else as a caption track fails in
                    // silence. See the same guard in `EmbedSection`.
                    captionsSrc={
                      captionsAsset && isCaptionsObjectKey(captionsAsset.objectKey)
                        ? publicObjectUrl(captionsAsset.objectKey)
                        : null
                    }
                    captionsLabel={settings.captionsLabel}
                    settings={settings}
                    downloadName={asset.fileName}
                  />
                ) : (
                  <MediaImage
                    media={asset}
                    picture={picture}
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
