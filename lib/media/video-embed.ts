/**
 * The isomorphic, zod-free half of lib/media/video.ts: what counts as a film, where a pasted address
 * points, and the player's fixed menus.
 *
 * ⚠ IT IMPORTS NOTHING BUT A TYPE, AND THAT IS WHY IT IS A SEPARATE FILE. lib/media/video.ts also
 * declares the player's settings schema, which builds a zod object when the module loads — and a
 * module with load-time side effects cannot be tree-shaken. VideoPlayer and HostedVideoFrame are client
 * components on the public site and need only what is in here, so importing them from video.ts put zod
 * (~88 KB compressed) into every page that shows a film. lib/media/video.ts re-exports all of this, so
 * server code and the studio keep importing from there; public client code imports from here.
 */

import type { VideoSettings } from "@/lib/media/video";

// ─────────────────────────────────────────────────────────────────────────────
// Is this file a film?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ THE OBJECT KEY IS THE ONLY SIGNAL AVAILABLE — `MediaLike` (lib/media/url.ts) carries no asset kind
 * and `MEDIA_IMAGE_SELECT` fetches no `mimeType`, deliberately (see its header). It matters: a video
 * pushed through the image optimiser answers 400 and draws a broken frame with no clue why.
 *
 * ⚠ IT IS WIDER THAN WHAT CAN BE UPLOADED, AND THAT IS ON PURPOSE. `app/api/studio/media/presign`
 * accepts exactly three containers — mp4, webm and quicktime — but the media library also holds rows
 * imported before that allow-list existed and rows a future release may add. A key this test does not
 * recognise is drawn as a picture, which is the failure mode above; a key it recognises that no
 * browser can play falls through to the player's own "cannot be played here" sentence, which is a
 * sentence rather than a broken image.
 */
const VIDEO_OBJECT_KEY = /\.(mp4|webm|ogv|mov|m4v)(\?|$)/i;

export function isVideoObjectKey(objectKey: string): boolean {
  return VIDEO_OBJECT_KEY.test(objectKey);
}

/** `.vtt` is the one caption format every browser reads, and the only one `<track>` accepts. */
const CAPTIONS_OBJECT_KEY = /\.vtt(\?|$)/i;

export function isCaptionsObjectKey(objectKey: string): boolean {
  return CAPTIONS_OBJECT_KEY.test(objectKey);
}

// ─────────────────────────────────────────────────────────────────────────────
// Where a pasted address points
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where the video lives.
 *
 * `upload` is the one that is not a frame at all: the file is on the Centre's own object store and is
 * drawn by `components/site/VideoPlayer.tsx`. Everything else is somebody else's page in an
 * `<iframe>`, which is why `resolveEmbedTarget` answers null for it rather than inventing a `src`.
 */
export const EMBED_PROVIDERS = ["youtube", "vimeo", "drive", "iframe", "upload"] as const;

export type EmbedProvider = (typeof EMBED_PROVIDERS)[number];

/**
 * The shapes a frame is offered in.
 *
 * Declared here rather than inline in the block schema because the rich-text video node offers the
 * same four and `HostedVideoFrame` holds the one table of Tailwind classes that draws them. Three
 * hand-written copies of "16:9, 4:3, 1:1, 9:16" is three chances for one of them to gain a fifth.
 */
export const EMBED_ASPECT_RATIOS = ["16:9", "4:3", "1:1", "9:16"] as const;

export type EmbedAspectRatio = (typeof EMBED_ASPECT_RATIOS)[number];

/** The provider's name as a reader says it. Used in the poster's "this loads from…" sentence. */
export const EMBED_PROVIDER_NAMES: Record<EmbedProvider, string> = {
  youtube: "YouTube",
  vimeo: "Vimeo",
  drive: "Google Drive",
  iframe: "another site",
  upload: "this site"
};

export interface EmbedTarget {
  /** The `src` for the iframe, already carrying autoplay — the reader has just pressed play. */
  src: string;
  /** The host named in the poster's warning, so nobody is surprised by the request. */
  host: string;
  allow: string;
}

/** YouTube ids are 11 characters today, but the length has changed before; the shape has not. */
const ID_SHAPE = /^[A-Za-z0-9_-]{6,24}$/;

/**
 * A Drive file id. Longer and less constrained than YouTube's, so the test is only "long enough to be
 * one and made of the right characters" — a folder id looks identical and is caught by the PATH
 * instead, in `driveTarget` below.
 *
 * ⚠ THE UPPER BOUND IS FOR THE PUBLISHED-DOCUMENT ID, NOT THE FILE ID, AND 80 MADE A WHOLE BRANCH DEAD
 * CODE. An ordinary Drive file id is 28–44 characters; the `2PACX-…` id in a "Publish to the web"
 * address is 80–90, so the `/d/e/` branch below could never be reached and every published Google
 * Sheet or Slides deck an editor pasted was refused with "that address could not be read" — a branch
 * that read as live, compiled, and could not run. `scripts/video-check.ts` now asserts a real
 * 86-character id, so the bound cannot quietly shrink back under one.
 */
const DRIVE_ID_SHAPE = /^[A-Za-z0-9_-]{10,120}$/;

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
      /**
       * ⚠ `videoseries` IS NOT A VIDEO ID, AND IT PASSES EVERY SHAPE TEST. YouTube's own embed for a
       * PLAYLIST is `/embed/videoseries?list=PL…`, and the literal word sits exactly where an id sits
       * and is made of exactly the characters an id is made of. Accepted, it produces
       * `…/embed/videoseries?autoplay=1` with the `list` dropped — a player that loads and then says
       * the video is unavailable, which reads as our bug rather than as the wrong link.
       */
      if (second === "videoseries") return null;
      return ID_SHAPE.test(second) ? second : null;
    }
  }

  return null;
}

/**
 * How far into the film to start, as whole seconds, or null.
 *
 * Every provider spells this differently and none of them takes a fraction, so the one number is
 * rounded once here rather than three times below.
 */
function startSeconds(settings: VideoSettings | null | undefined): number | null {
  const at = Math.floor(settings?.startAt ?? 0);
  return at > 0 ? at : null;
}

function youTubeTarget(url: URL, settings: VideoSettings | null | undefined): EmbedTarget | null {
  const id = youTubeId(url);
  if (!id) return null;

  // youtube-nocookie.com is the same player without the tracking cookies set on first load. `rel=0`
  // keeps the end-card suggestions inside the same channel rather than sending a reader off into
  // whatever the recommender picks.
  const params = new URLSearchParams({
    autoplay: "1",
    rel: "0",
    modestbranding: "1",
    playsinline: "1"
  });

  const at = startSeconds(settings);
  if (at !== null) params.set("start", String(at));
  if (settings?.showControls === false) params.set("controls", "0");
  /**
   * ⚠ `startMuted` IS DELIBERATELY NOT PASSED ON, AND PASSING IT WAS A REAL DEFECT RATHER THAN A
   * MISSING NICETY.
   *
   * The setting means "start silent BECAUSE it starts by itself" — every browser refuses to autoplay
   * an unmuted video, so our own player has no choice. A hosted embed never starts by itself: the
   * reader has just pressed a poster that says "playing this loads the player from
   * youtube-nocookie.com". Sending `mute=1` there made every YouTube and Vimeo video on the site play
   * SILENTLY after a deliberate press — and because `startMuted` defaults to `true`, it would have
   * done it to every embed already published, with no editor having changed anything.
   *
   * `providerHonours()` says the same thing from the studio's side, so the control is not offered for
   * these two providers at all. Both halves are needed: the table decides what an editor sees, and
   * this decides what a payload written before the table existed does.
   */
  if (settings?.loop) {
    // ⚠ `loop=1` ALONE DOES NOTHING ON A SINGLE VIDEO. YouTube's player loops a PLAYLIST, and the
    // documented way to loop one film is to hand it a playlist consisting of itself. Without the
    // second parameter the setting is a control with no effect, which is the shape of bug the studio
    // forms in this repository exist to refuse.
    params.set("loop", "1");
    params.set("playlist", id);
  }

  return {
    src: `https://www.youtube-nocookie.com/embed/${id}?${params.toString()}`,
    host: "youtube-nocookie.com",
    allow:
      "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
  };
}

function vimeoTarget(url: URL, settings: VideoSettings | null | undefined): EmbedTarget | null {
  const host = url.hostname.replace(/^www\./, "");
  if (host !== "vimeo.com" && host !== "player.vimeo.com") return null;

  const segments = url.pathname.split("/").filter(Boolean);

  /**
   * The video's id.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * ⚠ "THE FIRST NUMERIC SEGMENT" IS WRONG FOR A SHOWCASE, AND A SHOWCASE LINK IS ONE AN EDITOR
   * ACTUALLY PASTES. `vimeo.com/showcase/1234567/video/890123` carries TWO numbers: the collection
   * and the film. The first one is the collection, so the old rule embedded a showcase id as though
   * it were a video — a player that loads and reports the video does not exist.
   *
   * So the segment AFTER an explicit `video` marker wins wherever there is one, which covers
   * `/video/890123`, `/showcase/…/video/890123` and `player.vimeo.com/video/890123` alike. Only when
   * there is no marker does the first numeric segment stand, which is what `/123456789` and
   * `/channels/staff/123456789` need.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  const marker = segments.indexOf("video");
  const afterMarker = marker >= 0 ? segments[marker + 1] : undefined;
  const index =
    afterMarker !== undefined && /^\d+$/.test(afterMarker)
      ? marker + 1
      : segments.findIndex((segment) => /^\d+$/.test(segment));
  const id = index >= 0 ? segments[index] : undefined;
  if (!id) return null;

  // An unlisted video carries a private hash, either as the segment after the id or as ?h=.
  const following = index >= 0 ? segments[index + 1] : undefined;
  const hash =
    url.searchParams.get("h") ?? (following && /^[a-f0-9]{6,20}$/i.test(following) ? following : null);

  const params = new URLSearchParams({ autoplay: "1", dnt: "1" });
  if (hash) params.set("h", hash);
  if (settings?.loop) params.set("loop", "1");
  // ⚠ `startMuted` IS DELIBERATELY NOT PASSED ON — see the note in `youTubeTarget`. It means "silent
  //   because it starts by itself", and a hosted embed only ever starts because the reader pressed a
  //   poster.
  if (settings?.showControls === false) params.set("controls", "0");

  const at = startSeconds(settings);
  // ⚠ VIMEO TAKES THE START TIME AS A FRAGMENT, NOT AS A QUERY PARAMETER, and `#t=90s` is the only
  // spelling its player reads. A `?t=90` is accepted by the URL and ignored by the film.
  const fragment = at !== null ? `#t=${at}s` : "";

  return {
    src: `https://player.vimeo.com/video/${id}?${params.toString()}${fragment}`,
    host: "player.vimeo.com",
    allow: "autoplay; fullscreen; picture-in-picture; clipboard-write"
  };
}

/**
 * `/u/0/file/d/<id>/view` → `/file/d/<id>/view`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ IT IS THE SHAPE ANYBODY SIGNED INTO TWO GOOGLE ACCOUNTS COPIES, and without this every one of
 * them is refused. Google inserts `u/<n>` — the index of the signed-in account — into the path of
 * every Drive and Docs URL taken from the address bar rather than from the Share dialog, and an editor
 * has no reason to know the two differ. The id, the file and the `/preview` that would be built from
 * it are identical either way; the segment addresses the SESSION, not the document, and carrying it
 * into an embed would be meaningless (a reader's own account index is not ours to guess).
 *
 * Only a leading `u/<digits>` PAIR is removed, so a file whose id is literally "u" cannot be mangled
 * by it and a folder path is still recognised as a folder.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
function withoutAccountSegment(segments: readonly string[]): string[] {
  if (segments[0] === "u" && segments[1] !== undefined && /^\d+$/.test(segments[1])) {
    return segments.slice(2);
  }
  return [...segments];
}

/**
 * A Google Drive share link, turned into the address that renders IN PLACE.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ `/view` IS A WHOLE GOOGLE PAGE AND REFUSES TO BE FRAMED. Drive serves `/view` with
 * `X-Frame-Options: SAMEORIGIN`, so an `<iframe>` pointed at the address an editor actually copies
 * out of the address bar renders an empty white box with a console error nobody reading the page can
 * see. `/preview` is the same file in the same viewer WITHOUT that header, and it is the only Drive
 * address that may go in a frame.
 *
 * That single substitution is the whole reason Drive is a provider of its own rather than an "in a
 * frame" address: left to the generic branch, every Drive link an editor pastes would be a blank
 * rectangle, and nothing on the page or in the studio would say why.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ IT IS NOT ONLY FOR VIDEO, and that is deliberate. Drive's viewer draws a film, a PDF, a
 * presentation and a spreadsheet, which is the whole point of reaching for it: a 400 MB recording or
 * a large dataset can be shown on a page without ever entering this deployment's object store or its
 * 200 MB upload limit. Google Docs, Slides and Sheets take the same `/preview` substitution and are
 * accepted here for the same reason.
 *
 * ⚠ A FOLDER IS NOT A FILE. `/drive/folders/…` has no `/preview`, so it is refused here and the block
 * says "that address could not be read" rather than framing a listing that will not load. Google
 * FORMS are refused too — a form belongs in the FORM_EMBED block, which knows about its host
 * allow-list and its consent notice.
 *
 * ⚠ A LINK THAT IS NOT SHARED IS A GOOGLE SIGN-IN PAGE. Nothing here can detect that: the sharing
 * state lives in Google's account system and a fetch from this application would be unauthenticated
 * whatever the reader's own browser can see. The studio form says so beside the field, which is the
 * only honest place for it.
 */
function driveTarget(url: URL): EmbedTarget | null {
  const host = url.hostname.replace(/^www\./, "");
  const segments = withoutAccountSegment(url.pathname.split("/").filter(Boolean));

  if (host === "drive.google.com") {
    // A folder listing has no in-page viewer. Refused rather than framed — see the header.
    if (segments[0] === "drive" || segments[0] === "folders") return null;

    // /file/d/<id>/view, /file/d/<id>/edit, /file/d/<id> — the id is always the third segment.
    if (segments[0] === "file" && segments[1] === "d") {
      const id = segments[2] ?? "";
      if (!DRIVE_ID_SHAPE.test(id)) return null;
      return {
        src: `https://drive.google.com/file/d/${id}/preview`,
        host: "drive.google.com",
        allow: "autoplay; fullscreen"
      };
    }

    // The two older shapes an editor still finds in an email: /open?id=… and /uc?id=…
    const query = url.searchParams.get("id");
    if ((segments[0] === "open" || segments[0] === "uc") && query && DRIVE_ID_SHAPE.test(query)) {
      return {
        src: `https://drive.google.com/file/d/${query}/preview`,
        host: "drive.google.com",
        allow: "autoplay; fullscreen"
      };
    }

    return null;
  }

  if (host === "docs.google.com") {
    const kind = segments[0] ?? "";
    // `forms` is deliberately absent: a form belongs in the FORM_EMBED block, which carries the host
    // allow-list and the consent sentence this block does not.
    if (!["document", "presentation", "spreadsheets"].includes(kind)) return null;

    /**
     * ⚠ THE ACCOUNT SEGMENT SITS AFTER THE PRODUCT HERE, NOT BEFORE IT. Drive writes
     * `/u/0/file/d/<id>` and Docs writes `/document/u/0/d/<id>` — the same session index in a
     * different place — so the leading strip above cannot catch this one and a second call is not
     * redundant. Measured against both products' address bars rather than assumed.
     */
    const rest = withoutAccountSegment(segments.slice(1));
    if (rest[0] !== "d") return null;

    /**
     * ⚠ A PUBLISHED DOCUMENT IS ALREADY A FRAMEABLE ADDRESS AND MUST BE LEFT ALONE.
     *
     * `/d/e/<id>/pubhtml`, `/d/e/<id>/pub` and `/d/e/<id>/embed` are what "File → Share → Publish to
     * the web" produces, and Google's own dialog hands the author an `<iframe src>` pointing at
     * exactly that path — it is designed to be embedded and carries no `X-Frame-Options`. Rewriting it
     * to `/preview`, which is the fix for an ORDINARY `/d/<id>` link, points at an endpoint a
     * published document does not have: the frame would load a Google error page, which is worse than
     * the blank box `/preview` exists to prevent because it looks like a permissions problem.
     *
     * So the published shape passes through untouched, keeping whatever query string it arrived with
     * (`?widget=true&headers=false` is part of what the publish dialog gives out).
     */
    if (rest[1] === "e") {
      const publishedId = rest[2] ?? "";
      if (!DRIVE_ID_SHAPE.test(publishedId)) return null;
      return { src: url.toString(), host: "docs.google.com", allow: "autoplay; fullscreen" };
    }

    const id = rest[1] ?? "";
    if (!DRIVE_ID_SHAPE.test(id)) return null;

    return {
      src: `https://docs.google.com/${kind}/d/${id}/preview`,
      host: "docs.google.com",
      allow: "autoplay; fullscreen"
    };
  }

  return null;
}

/**
 * Turn the editor's pasted share link into something safe to put in a `src`, or null.
 *
 * Null means "this address could not be read", and every caller says exactly that rather than
 * rendering an empty frame — an embed that draws nothing is indistinguishable from a page that was
 * never finished, and the editor who pasted a channel URL instead of a video URL has no other way to
 * find out (contract §1.6, and rule 4 of lib/sections/schema.ts).
 *
 * ⚠ `upload` RETURNS NULL AND THAT IS NOT A FAILURE. A file on our own object store is not a frame;
 * it is drawn by `VideoPlayer`, from a `MediaAsset` id rather than from a URL. Callers branch on the
 * provider before they ever ask this function.
 */
export function resolveEmbedTarget(
  provider: EmbedProvider | string,
  rawUrl: string,
  settings?: VideoSettings | null
): EmbedTarget | null {
  if (provider === "upload") return null;

  const url = parseUrl(rawUrl);
  if (!url) return null;

  if (provider === "youtube") return youTubeTarget(url, settings);
  if (provider === "vimeo") return vimeoTarget(url, settings);
  if (provider === "drive") return driveTarget(url);

  // Everything else — including a provider value written by a newer release and read after a rollback
  // — is treated as a plain frame. That is the same direction `EmbedForm`'s widened pattern lookup
  // takes: this release cannot say what such an address should look like, so it does not guess.
  return { src: url.toString(), host: url.hostname, allow: "fullscreen" };
}

/**
 * What an address on this provider normally looks like. A hint for the studio form, never a refusal.
 *
 * `null` means "there is no shape to check this against" — which is the truthful answer for a plain
 * frame, for an uploaded file that has no address at all, and for any provider a future release adds.
 */
export const EMBED_PROVIDER_PATTERNS: Record<EmbedProvider, RegExp | null> = {
  youtube: /(?:youtube\.com|youtu\.be)/i,
  vimeo: /vimeo\.com/i,
  drive: /(?:drive|docs)\.google\.com/i,
  iframe: null,
  upload: null
};

// ─────────────────────────────────────────────────────────────────────────────
// The player's settings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the player does when the film scrolls out of view.
 *
 * ⚠ `pause` IS THE DEFAULT AND THE OTHER TWO ARE DELIBERATE CHOICES, not variations on it. A video
 * that goes on playing after the reader has scrolled past it is sound coming from a page they are no
 * longer looking at, and a corner player is a panel that appears over the article without being
 * asked. Both are legitimate — a recorded lecture somebody listens to while reading the transcript is
 * exactly the case for `continue` — but neither is what a reader expects by default.
 */
export const VIDEO_OFF_SCREEN_BEHAVIOURS = ["pause", "minimise", "continue"] as const;

export type VideoOffScreenBehaviour = (typeof VIDEO_OFF_SCREEN_BEHAVIOURS)[number];

export const VIDEO_OFF_SCREEN_LABELS: Record<VideoOffScreenBehaviour, string> = {
  pause: "Pause it, and carry on where it stopped when it comes back",
  minimise: "Shrink it into the corner of the screen and keep playing",
  continue: "Keep playing where it is, out of sight"
};

/** How fast the player may be asked to run. The menu is built from this, so it cannot offer a rate
 *  the player does not set. 1 is always present and is always the one a fresh player starts at. */
export const VIDEO_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
