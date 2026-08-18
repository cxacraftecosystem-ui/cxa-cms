"use client";

/**
 * HostedVideoFrame — a video or a page on somebody else's server: a poster of ours, then their frame.
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
 * `title` IS THE FRAME'S ONLY DESCRIPTION. A screen reader announces an untitled `<iframe>` as
 * "frame", which tells the reader nothing about whether entering it is worth their time — which is
 * why `embedSectionSchema` makes it the one conditional requirement in the whole section model.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ IT IS SHARED BY THE BLOCK AND BY A BODY OF WRITING, which is the whole reason it is a file rather
 * than a function inside `EmbedSection`. The EMBED block and the `videoEmbed` node in a rich-text
 * document put the same thing on a page and must make the same privacy trade; two implementations
 * would be two chances to mount an iframe on load, and the second one would be the one nobody
 * reviewed. `components/RichText.tsx` is a SERVER component and renders this as a client island.
 */

import { useState } from "react";
import { Play, TriangleAlert } from "lucide-react";

import { resolveEmbedTarget, type EmbedAspectRatio, type VideoSettings } from "@/lib/media/video";
import { cn } from "@/lib/utils";

/** Complete literal class strings — an `aspect-[${r}]` built from data is purged (contract §5). */
const ASPECT_CLASS: Record<EmbedAspectRatio, string> = {
  "16:9": "aspect-video",
  "4:3": "aspect-[4/3]",
  "1:1": "aspect-square",
  "9:16": "aspect-[9/16]"
};

/**
 * The same table, read by an arbitrary string.
 *
 * ⚠ THE SAME WIDENING `EmbedForm`'s `PATTERN_FOR_PROVIDER` CARRIES, and here it covers two callers
 * whose values reach it by different routes. A block payload whose `aspectRatio` is a value this
 * release has never heard of fails its parse, and a page in PRODUCTION renders nothing for a failed
 * parse — but the studio's LIVE PREVIEW renders the builder's raw working copy through this very
 * component, and a rich-text node's attributes are coerced by `lib/richtext.ts` rather than validated
 * at all. In both of those the value really can be a string that has never been through the enum,
 * where the narrow read produced `undefined` in a `className`: Tailwind ignores it, so the frame
 * silently lost its shape and collapsed to nothing rather than crashing. A missing entry means "no
 * shape stated", which is what 16:9 already is for anything anybody embeds.
 */
const ASPECT_FOR: Partial<Record<string, string>> = ASPECT_CLASS;

export interface HostedVideoFrameProps {
  /**
   * Where the video is — `"youtube"`, `"vimeo"`, `"drive"`, or anything else for a plain frame.
   *
   * A plain string rather than the enum, for the two reasons `ASPECT_FOR` sets out. `resolveEmbedTarget`
   * treats an unknown provider as a plain frame, which is the honest answer.
   */
  provider: string;
  url: string;
  /** The frame's accessible name. Never "Video" — see the header. */
  title: string;
  aspectRatio: string;
  /**
   * The block's player settings, for the handful a provider can carry in its URL — a start time, a
   * loop, a muted start, the controls. `providerHonours()` in lib/media/video.ts is the table of which,
   * and the studio only ever offers those.
   */
  settings?: VideoSettings | null;
  className?: string;
}

export function HostedVideoFrame({
  provider,
  url,
  title,
  aspectRatio,
  settings,
  className
}: HostedVideoFrameProps) {
  const [playing, setPlaying] = useState(false);

  const target = resolveEmbedTarget(provider, url, settings);
  const hasUrl = url.trim().length > 0;
  const aspect = ASPECT_FOR[aspectRatio] ?? ASPECT_CLASS["16:9"];

  if (!target) {
    /**
     * SAY SO RATHER THAN LEAVE A GAP (contract §1.6). An embed that renders nothing is
     * indistinguishable from a page that was never finished, and the editor who pasted a channel URL
     * instead of a video URL has no other way to discover it.
     */
    return (
      <div
        className={cn(
          "flex items-start gap-3 rounded-lg border border-dashed border-line-200 bg-surface-50 px-5 py-4",
          className
        )}
      >
        <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" />
        <p className="text-sm leading-relaxed text-ink-500">
          {hasUrl
            ? "This video has an address that could not be read. Check that the link is the ordinary share link for the video rather than a channel, a playlist or a Drive folder."
            : "This video has no address yet."}
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-lg border border-line-200",
        aspect,
        playing ? "bg-ink-900" : "grad-brand",
        className
      )}
    >
      {playing ? (
        <iframe
          src={target.src}
          // The frame's only description. Never "Video" — see the header.
          title={title || "Embedded media"}
          loading="lazy"
          allow={target.allow}
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          // `allow-same-origin` is what lets the player reach its own cookies and storage, and it is
          // safe HERE because the frame's origin is the provider's, not ours. ⚠ For the generic
          // "frame" provider pointed at a same-origin page, the pair cancels the sandbox out — that
          // combination is a deliberate embed of our own content, not a third party, and there is
          // nothing to contain.
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation allow-forms"
          className="absolute inset-0 h-full w-full border-0"
        />
      ) : (
        <>
          <button
            type="button"
            onClick={() => setPlaying(true)}
            className="group absolute inset-0 flex flex-col items-center justify-center gap-5 px-6 text-center transition hover:bg-ink-900/15"
          >
            <span className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-white/15 text-white ring-1 ring-white/40 transition group-hover:bg-white/25">
              <Play aria-hidden="true" className="ml-0.5 h-7 w-7" />
            </span>
            {/* "Play" is spoken, not printed: the visible title is already the label, and a button
                captioned "Play <title>" reads as clutter beside a play glyph. */}
            <span className="sr-only">Play </span>
            <span className="display-title text-balance text-lg text-white sm:text-xl">
              {title || "Watch this video"}
            </span>
          </button>

          {/*
            Outside the button so it is not folded into the button's accessible name, and
            `pointer-events-none` so the sentence is not a dead patch in the middle of the poster — a
            press on it falls through to the button underneath.
          */}
          <p className="pointer-events-none absolute inset-x-0 bottom-0 px-5 pb-4 text-center text-xs leading-relaxed text-white/70">
            Playing this loads the player from {target.host}.
          </p>
        </>
      )}
    </div>
  );
}
