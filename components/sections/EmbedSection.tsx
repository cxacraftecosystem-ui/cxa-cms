/**
 * EmbedSection — a video or another page, from wherever it lives.
 *
 * ⚠ IT CARRIES NO `"use client"` ANY MORE, AND THAT IS A CHANGE RATHER THAN AN OVERSIGHT. The
 * poster-then-frame state that made it interactive now lives in `components/site/HostedVideoFrame.tsx`,
 * where the rich-text video node can reach it too, and the uploaded branch is
 * `components/site/VideoPlayer.tsx`. What is left decides which of the two to draw and how wide it may
 * be, which is a Server Component's job (contract §12) — and it keeps this file out of the bundle of
 * every page that carries an embed.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * NOTHING FROM A THIRD PARTY IS LOADED UNTIL SOMEBODY ASKS FOR IT.
 *
 * A third-party player mounted on page load is a request to someone else's server for every single
 * visitor, whether or not they ever press play. It is reliably the heaviest thing on any page that
 * carries one — YouTube's embed pulls several hundred kilobytes of script before a frame of video
 * exists — and it hands that visitor's IP address and referrer to the provider without being asked.
 *
 * So the frame starts as a POSTER we render ourselves: a brand panel, the title, and a plain sentence
 * naming the host that will be contacted. The poster is deliberately NOT the provider's thumbnail —
 * `i.ytimg.com` is the same third-party request in a smaller costume, and it would have to be
 * allowlisted in `next.config.ts` besides.
 *
 * `title` IS REQUIRED ON THE IFRAME, and the schema enforces it as the one conditional requirement in
 * the whole of lib/sections/schema.ts. A screen reader announces an untitled frame as "frame", which
 * tells the reader nothing about whether entering it is worth their time.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ THE `upload` PROVIDER IS A COMPLETELY DIFFERENT BRANCH AND SHARES NONE OF THE ABOVE. A film in the
 * Centre's own media library is served from the Centre's own object base, so there is no third party
 * to withhold, nothing to warn the reader about, and no reason to make them press a poster before the
 * player exists. It is handed to `components/site/VideoPlayer.tsx`, which is the only place on this
 * site that honours the block's video settings in full — `providerHonours()` in lib/media/video.ts is
 * the table that says which settings each of the other providers can take, and the studio form offers
 * exactly those and no more.
 *
 * A BLOCK WITH NO USABLE ADDRESS SAYS SO. An embed that renders nothing is indistinguishable from a
 * page that was never finished, and the editor who pasted a channel URL instead of a video URL has no
 * way to discover it (contract §1.6, and rule 4 of lib/sections/schema.ts). The same sentence covers
 * an uploaded film whose asset has since been deleted from the library.
 */

import type { PageSection } from "@prisma/client";
import { TriangleAlert } from "lucide-react";

import { Reveal } from "@/components/motion";
import { HostedVideoFrame } from "@/components/site/HostedVideoFrame";
import { VideoPlayer } from "@/components/site/VideoPlayer";
import { publicObjectUrl } from "@/lib/media/url";
import { isCaptionsObjectKey } from "@/lib/media/video";
import type { ResolvedSectionData } from "@/lib/sections/resolve";
import type { EmbedSectionData } from "@/lib/sections/schema";
import { cn } from "@/lib/utils";

/**
 * How wide the frame is allowed to be.
 *
 * Vertical video is capped hard: a 9:16 frame at the full content width is nearly three screens tall
 * and pushes everything after it off the page.
 */
const WIDTH_CLASS: Record<EmbedSectionData["aspectRatio"], string> = {
  "16:9": "max-w-4xl",
  "4:3": "max-w-3xl",
  "1:1": "max-w-xl",
  "9:16": "max-w-sm"
};

/**
 * The same table, read by an arbitrary string.
 *
 * ⚠ THE SAME WIDENING `EmbedForm`'s `PATTERN_FOR_PROVIDER` CARRIES, AND FOR THE SAME REASON — except
 * that here the value being looked up is `aspectRatio` rather than `provider`. A payload whose
 * `aspectRatio` is a value this release has never heard of fails the parse, and a page in PRODUCTION
 * renders nothing for a failed parse (see `SectionProblem`), so this table is not on that path today.
 * It is widened because the studio's LIVE PREVIEW renders the builder's raw working copy through this
 * very component, and there `data.aspectRatio` really can be a string that has never been through the
 * enum — where the narrow read produced `undefined` in a `className`, which Tailwind ignores, so the
 * figure silently lost its width cap rather than crashing. `HostedVideoFrame` carries the twin of this
 * note for the SHAPE table, which lives there because the frame is what draws it.
 */
const WIDTH_FOR: Partial<Record<string, string>> = WIDTH_CLASS;

export interface EmbedSectionProps {
  data: EmbedSectionData;
  /** The block's own row — the anchor id comes off it. */
  section: PageSection;
  /**
   * The batched read from `lib/sections/resolve.ts`; `resolved.media` is keyed by ASSET id.
   *
   * Optional because the studio's live preview renders a block before any resolution has happened,
   * and an uploaded film with no resolved asset says so rather than throwing.
   */
  resolved?: ResolvedSectionData;
}

export function EmbedSection({ data, section, resolved }: EmbedSectionProps) {
  const title = data.title.trim();
  const width = WIDTH_FOR[data.aspectRatio] ?? WIDTH_CLASS["16:9"];

  return (
    <section id={`block-${section.id}`} className="py-20 md:py-28">
      <div className="shell">
        <Reveal as="figure" className={cn("mx-auto min-w-0", width)}>
          {data.provider === "upload" ? (
            <UploadedFilm data={data} title={title} resolved={resolved} />
          ) : (
            <HostedVideoFrame
              provider={data.provider}
              url={data.url}
              title={title}
              aspectRatio={data.aspectRatio}
              settings={data.videoSettings}
            />
          )}

          {data.caption ? (
            <figcaption className="prose-measure mt-3 text-sm leading-relaxed text-ink-500">
              {data.caption}
            </figcaption>
          ) : null}
        </Reveal>
      </div>
    </section>
  );
}

/**
 * A film this site hosts.
 *
 * ⚠ THE BLOCK'S `aspectRatio` ONLY CAPS THE WIDTH HERE; it does not force a shape onto the frame.
 * `VideoPlayer` lets the film size itself, which is what makes black bars impossible — a 4:3
 * recording inside a forced 16:9 box is letterboxed by the browser and there is nothing an editor can
 * do about it from the studio. The width cap is still worth having: an upright phone recording at the
 * full content width is three screens tall.
 */
function UploadedFilm({
  data,
  title,
  resolved
}: {
  data: EmbedSectionData;
  title: string;
  resolved: ResolvedSectionData | undefined;
}) {
  const asset = data.mediaId ? resolved?.media[data.mediaId] : undefined;
  if (!asset) {
    return (
      <EmbedProblem
        message={
          data.mediaId
            ? "This video block names a film that is no longer in the media library. Choose it again, or restore it from the recycle bin."
            : "This video block has no film chosen yet."
        }
      />
    );
  }

  const settings = data.videoSettings;
  const posterAsset = settings.posterMediaId ? resolved?.media[settings.posterMediaId] : undefined;
  const captionsAsset = settings.captionsMediaId
    ? resolved?.media[settings.captionsMediaId]
    : undefined;

  return (
    <VideoPlayer
      src={publicObjectUrl(asset.objectKey)}
      title={title || "Video"}
      poster={posterAsset ? publicObjectUrl(posterAsset.objectKey) : null}
      /**
       * ⚠ THE CAPTION FILE IS CHECKED BY ITS NAME BEFORE IT IS OFFERED AS ONE. `<track>` accepts
       * WebVTT and nothing else, and a browser handed a PDF as a caption track fails silently — no
       * error, no captions, and a subtitle menu that appears and does nothing. The studio's picker
       * refuses anything but `.vtt` for the same reason; this is the render-side half of it, because
       * a payload can outlive the form that wrote it.
       */
      captionsSrc={
        captionsAsset && isCaptionsObjectKey(captionsAsset.objectKey)
          ? publicObjectUrl(captionsAsset.objectKey)
          : null
      }
      captionsLabel={settings.captionsLabel}
      settings={settings}
      downloadName={asset.fileName}
    />
  );
}

/** One shape for every "this block cannot draw anything, and here is why" — see the header. */
function EmbedProblem({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-dashed border-line-200 bg-surface-50 px-5 py-4">
      <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" />
      <p className="text-sm leading-relaxed text-ink-500">{message}</p>
    </div>
  );
}
