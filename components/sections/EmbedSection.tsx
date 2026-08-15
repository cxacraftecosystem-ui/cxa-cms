"use client";

/**
 * EmbedSection — a YouTube or Vimeo video, or any other page in a frame.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * NOTHING IS LOADED UNTIL SOMEBODY ASKS FOR IT.
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
 * A BLOCK WITH NO USABLE ADDRESS SAYS SO. An embed that renders nothing is indistinguishable from a
 * page that was never finished, and the editor who pasted a channel URL instead of a video URL has no
 * way to discover it (contract §1.6, and rule 4 of lib/sections/schema.ts).
 */

import { useState } from "react";
import type { PageSection } from "@prisma/client";
import { Play, TriangleAlert } from "lucide-react";

import { Reveal } from "@/components/motion";
import type { EmbedSectionData } from "@/lib/sections/schema";
import { cn } from "@/lib/utils";

/** Complete literal class strings — an `aspect-[${r}]` built from data is purged (contract §5). */
const ASPECT_CLASS: Record<EmbedSectionData["aspectRatio"], string> = {
  "16:9": "aspect-video",
  "4:3": "aspect-[4/3]",
  "1:1": "aspect-square",
  "9:16": "aspect-[9/16]"
};

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

interface EmbedTarget {
  /** The `src` for the iframe, already carrying autoplay — the reader has just pressed play. */
  src: string;
  /** The host named in the poster's warning, so nobody is surprised by the request. */
  host: string;
  allow: string;
}

/** YouTube ids are 11 characters today, but the length has changed before; the shape has not. */
const ID_SHAPE = /^[A-Za-z0-9_-]{6,24}$/;

function parseUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const url = new URL(trimmed);
    // A relative path cannot host a video, and `javascript:` in an iframe src is a script injection.
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url;
  } catch {
    return null;
  }
}

function youTubeId(url: URL): string | null {
  const host = url.hostname.replace(/^www\./, "");

  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0] ?? "";
    return ID_SHAPE.test(id) ? id : null;
  }

  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
    const query = url.searchParams.get("v");
    if (query && ID_SHAPE.test(query)) return query;

    // /embed/…, /shorts/…, /v/… and /live/… all put the id in the second segment.
    const segments = url.pathname.split("/").filter(Boolean);
    const [first, second] = segments;
    if (first && second && ["embed", "shorts", "v", "live"].includes(first)) {
      return ID_SHAPE.test(second) ? second : null;
    }
  }

  return null;
}

function vimeoTarget(url: URL): EmbedTarget | null {
  const host = url.hostname.replace(/^www\./, "");
  if (host !== "vimeo.com" && host !== "player.vimeo.com") return null;

  const segments = url.pathname.split("/").filter(Boolean);
  // The id is the first purely numeric segment: /123, /channels/staff/123 and /video/123 all occur.
  const index = segments.findIndex((segment) => /^\d+$/.test(segment));
  const id = index >= 0 ? segments[index] : undefined;
  if (!id) return null;

  // An unlisted video carries a private hash, either as the segment after the id or as ?h=.
  const following = index >= 0 ? segments[index + 1] : undefined;
  const hash =
    url.searchParams.get("h") ?? (following && /^[a-f0-9]{6,20}$/i.test(following) ? following : null);

  const params = new URLSearchParams({ autoplay: "1", dnt: "1" });
  if (hash) params.set("h", hash);

  return {
    src: `https://player.vimeo.com/video/${id}?${params.toString()}`,
    host: "player.vimeo.com",
    allow: "autoplay; fullscreen; picture-in-picture; clipboard-write"
  };
}

/**
 * Turn the editor's pasted share link into something safe to put in a `src`, or null.
 *
 * Exported because the studio's block editor shows the same "this address could not be read" warning
 * while the URL is being typed, and two copies of this parser would disagree the first time either
 * one learned about a new URL shape.
 */
export function resolveEmbedTarget(
  provider: EmbedSectionData["provider"],
  rawUrl: string
): EmbedTarget | null {
  const url = parseUrl(rawUrl);
  if (!url) return null;

  if (provider === "youtube") {
    const id = youTubeId(url);
    if (!id) return null;
    // youtube-nocookie.com is the same player without the tracking cookies set on first load. `rel=0`
    // keeps the end-card suggestions inside the same channel rather than sending a reader off into
    // whatever the recommender picks.
    return {
      src: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1&playsinline=1`,
      host: "youtube-nocookie.com",
      allow:
        "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    };
  }

  if (provider === "vimeo") return vimeoTarget(url);

  return { src: url.toString(), host: url.hostname, allow: "fullscreen" };
}

export interface EmbedSectionProps {
  data: EmbedSectionData;
  /** Unused here — an EMBED block needs no resolved rows — but part of the renderer signature. */
  section: PageSection;
}

export function EmbedSection({ data, section }: EmbedSectionProps) {
  const [playing, setPlaying] = useState(false);

  const target = resolveEmbedTarget(data.provider, data.url);
  const title = data.title.trim();
  const hasUrl = data.url.trim().length > 0;

  return (
    <section id={`block-${section.id}`} className="py-20 md:py-28">
      <div className="shell">
        <Reveal as="figure" className={cn("mx-auto min-w-0", WIDTH_CLASS[data.aspectRatio])}>
          {target ? (
            <div
              className={cn(
                "relative overflow-hidden rounded-lg border border-line-200",
                ASPECT_CLASS[data.aspectRatio],
                playing ? "bg-ink-900" : "grad-brand"
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
                  // `allow-same-origin` is what lets the player reach its own cookies and storage, and
                  // it is safe HERE because the frame's origin is the provider's, not ours. ⚠ For the
                  // generic "frame" provider pointed at a same-origin page, the pair cancels the
                  // sandbox out — that combination is a deliberate embed of our own content, not a
                  // third party, and there is nothing to contain.
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
                    {/* "Play" is spoken, not printed: the visible title is already the label, and a
                        button captioned "Play <title>" reads as clutter beside a play glyph. */}
                    <span className="sr-only">Play </span>
                    <span className="display-title text-balance text-lg text-white sm:text-xl">
                      {title || "Watch this video"}
                    </span>
                  </button>

                  {/*
                    Outside the button so it is not folded into the button's accessible name, and
                    `pointer-events-none` so the sentence is not a dead patch in the middle of the
                    poster — a press on it falls through to the button underneath.
                  */}
                  <p className="pointer-events-none absolute inset-x-0 bottom-0 px-5 pb-4 text-center text-xs leading-relaxed text-white/70">
                    Playing this loads the player from {target.host}.
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className="flex items-start gap-3 rounded-lg border border-dashed border-line-200 bg-surface-50 px-5 py-4">
              <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" />
              <p className="text-sm leading-relaxed text-ink-500">
                {hasUrl
                  ? "This video block has an address that could not be read. Check that the link is the ordinary share link for the video rather than a channel or playlist."
                  : "This video block has no address yet."}
              </p>
            </div>
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
