"use client";

/**
 * VideoPlayer — the one player for every film this site hosts itself.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE TRANSPORT IS THE BROWSER'S OWN, AND THAT IS THE LOAD-BEARING DECISION IN THIS FILE.
 *
 * `controls` on a `<video>` is a complete, keyboard-operable, screen-reader-labelled, translated,
 * touch-sized transport that every reader already knows how to use, and it costs nothing to ship. A
 * hand-built control bar has to re-earn all of that — a seek slider that responds to Home, End and
 * the arrow keys, a volume control that is not a hover-only sliver, a fullscreen button that knows
 * about iOS, a time readout that does not talk over a screen reader on every frame — and the usual
 * result is a player that looks designed and is worse to use than the one it replaced.
 *
 * So this component adds only what a native transport does NOT do consistently, in a strip UNDER the
 * film rather than floating over it:
 *
 *   • A PLAYBACK SPEED control. Chrome and Safari have one in their own menu; Firefox does not, and
 *     none of the three exposes it to a keyboard without going through a menu the page cannot label.
 *   • A SAVE link, when the block says one is offered.
 *   • The CORNER PLAYER, which no browser has.
 *
 * ⚠ AND THE STRIP IS BENEATH, NOT OVER. Anything overlaid on the bottom of a video lands on top of
 * the native controls, which appear at different heights in different browsers and cannot be measured
 * from here — so an overlay is a control that swallows the play button on somebody else's machine.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ THE ELEMENT NEVER UNMOUNTS WHEN IT DOCKS. The corner player is the SAME `<figure>` with different
 * classes; a second `<video>` in a portal would be a second element, which starts at zero, refetches
 * the file and plays the opening again — the exact failure a corner player exists to prevent. A
 * placeholder of the recorded height stays in the flow so the article does not jump as the film
 * leaves it.
 *
 * ⚠ AUTOPLAY IS MUTED, ALWAYS, AND IS OFF UNDER REDUCED MOTION. Every browser refuses to start an
 * unmuted video without a gesture, so an "autoplay, unmuted" setting is a setting that silently does
 * nothing — the schema says so beside the two fields. And a film that starts itself is unrequested
 * movement: `useReducedMotionPreference()` turns it off entirely, leaving a poster and a play button,
 * which is what contract §8 asks for. The corner player is NOT disabled under reduced motion, because
 * with autoplay off the only way a film is playing at all is that the reader pressed play.
 *
 * ⚠ NOTHING HERE TOUCHES A THIRD PARTY. This is a file on the Centre's own object store, addressed
 * through `publicObjectUrl`. A YouTube, Vimeo or Drive embed is `EmbedSection`'s poster-then-frame,
 * and none of the settings below start one on the reader's behalf — see the ⚠ at the top of
 * lib/media/video.ts.
 *
 * ⚠ DO NOT PLACE THIS INSIDE AN ANCESTOR THAT HOLDS A TRANSFORM AT REST. A `transform` other than
 * `none` — or a `will-change: transform` — makes that ancestor the containing block for every fixed
 * descendant, so the corner player would be positioned against a paragraph instead of against the
 * viewport and would scroll away with it. `Reveal` writes `transform` only WHILE it animates and
 * leaves `none` behind (its own rescue stylesheet says so in as many words), so a player inside a
 * finished reveal is safe; a wrapper carrying a permanent `translate-*`, `scale-*` or `rotate-*`
 * utility is not. Every call site in this repository was checked against that.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Download, Minimize2, X } from "lucide-react";

import { useReducedMotionPreference } from "@/components/motion";
import { VIDEO_SPEEDS, type VideoSettings } from "@/lib/media/video";
import { cn } from "@/lib/utils";

export interface VideoPlayerProps {
  /** The file, already resolved through `publicObjectUrl`. Null when no public base is configured. */
  src: string | null;
  /**
   * The stored content type, where the caller has it.
   *
   * Optional because `MEDIA_IMAGE_SELECT` deliberately does not fetch `mimeType` (see its header), so
   * most callers cannot supply one. With it the browser can refuse an unplayable container before
   * fetching a byte; without it, it sniffs.
   */
  mimeType?: string | null;
  /**
   * The player's accessible name. Say what the film is, never "Video".
   *
   * A `<video>` with no name is announced as "video" and nothing else, which tells a reader nothing
   * about whether to spend four minutes on it (contract §11).
   */
  title: string;
  /** A still to show before it plays, already resolved to a URL. Nothing generates one — see §4. */
  poster?: string | null;
  /** A WebVTT file, already resolved to a URL. */
  captionsSrc?: string | null;
  /** What the subtitle track is called in the browser's own menu. */
  captionsLabel?: string;
  settings: VideoSettings;
  /** The name the file saves as, for the "save" link. Falls back to the browser's own guess. */
  downloadName?: string | null;
  /** Classes for the frame. The player is always full width of whatever it is given. */
  className?: string;
}

/**
 * How much of the film has to be on screen before "on screen" is true.
 *
 * Half rather than a sliver: a film that starts as its top edge appears is a film that starts while
 * the reader is still reading the paragraph above it. It is also the threshold the pause side uses,
 * so there is one boundary rather than two that could straddle a scroll position and flap.
 */
const VISIBLE_THRESHOLD = 0.5;

/**
 * The ratios the observer is asked to report at.
 *
 * ⚠ A SINGLE `threshold: 0.5` REPORTS ONLY THE CROSSING, and the entry it hands over at the crossing
 * has `isIntersecting === true` in BOTH directions — half of the film is still on screen when it is
 * on its way out. Reading that flag therefore said "it has arrived" as it left. Several stops mean
 * the callback also fires once the film is genuinely gone, which is what makes the ratio test below
 * settle rather than stick at whatever the last crossing said.
 */
const VISIBILITY_STEPS = [0, 0.25, 0.5, 0.75, 1];

/**
 * Is enough of the film on screen to count as "the reader is looking at it"?
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE SECOND CLAUSE IS WHAT MAKES A TALL FILM WORK AT ALL, and it is the trap `Reveal` documents
 * for its own `amount` prop under `useAchievableAmount`. An upright 9:16 recording on a phone is
 * TALLER THAN THE VIEWPORT, so its intersection ratio can never reach a half however far the reader
 * scrolls — a ratio test on its own would mean the film never started and never docked, silently, on
 * exactly the devices vertical video is shot for.
 *
 * So "half of the film" OR "half of the screen". Both are the same intent said against whichever of
 * the two is the smaller.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
function isOnScreen(entry: IntersectionObserverEntry): boolean {
  if (entry.intersectionRatio >= VISIBLE_THRESHOLD) return true;
  const viewport = entry.rootBounds?.height ?? 0;
  return viewport > 0 && entry.intersectionRect.height >= viewport * VISIBLE_THRESHOLD;
}

/**
 * `HTMLMediaElement.HAVE_METADATA`, written out.
 *
 * The constant lives on the element's constructor, which is not defined during a server render — and
 * this module is evaluated there. Naming the number is the same trade `POPOVER_Z` and the z-index
 * ladder make: a magic number with a name beside it beats a reference that only exists in a browser.
 */
const HAVE_METADATA = 1;

/**
 * Read and write the remembered position, and never throw doing it.
 *
 * ⚠ `localStorage` THROWS RATHER THAN FAILING QUIETLY. Safari in private browsing raises
 * `QuotaExceededError` on every `setItem`, a full store raises it everywhere, and a browser
 * configured to block site data raises `SecurityError` on the very first ACCESS of `window.localStorage`
 * — before any method is called. One of those throwing inside an effect CLEANUP is the worst case: it
 * propagates out of unmount, and React tears the tree down mid-way.
 *
 * A remembered position is a convenience. Nothing about it is worth a broken page, so both directions
 * swallow and carry on.
 */
function readPosition(key: string): number | null {
  try {
    const stored = Number(window.localStorage.getItem(key));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  } catch {
    return null;
  }
}

function writePosition(key: string, seconds: number): void {
  try {
    window.localStorage.setItem(key, String(Math.floor(seconds)));
  } catch {
    // See above. There is nothing to tell the reader: they did not ask for this.
  }
}

/** Where a remembered position is kept. One key per file; the value is a number of seconds. */
function positionKey(src: string): string {
  return `cxa:video-position:${src}`;
}

/**
 * Every player mounted on this page.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ ONE FILM AT A TIME, AND THE CORNER HOLDS ONE OF THEM. A page can legitimately carry several — a
 * project's video wall, an album, an article with two clips — and no browser stops one starting while
 * another plays. Two soundtracks at once is bad enough on its own; with `offScreen: "minimise"` it is
 * also two fixed panels in the same corner of the screen, on top of each other, both playing.
 *
 * So a player that STARTS stops every other player that was PLAYING, and returns it to the flow. A
 * player the reader paused themselves is left exactly where they left it — including docked, if that
 * is where they paused it, because taking a paused corner panel away from somebody who meant to come
 * back to it is the opposite of helpful.
 *
 * A module-level `Set` rather than React state or a context: this is a page-wide fact about DOM
 * elements, the players are rendered by four unrelated call sites that share no ancestor a provider
 * could sit on, and nothing here belongs in a render. Registration is an effect, so it is symmetric
 * with unmounting and a player removed from the page cannot be paused by one that is still on it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
interface RegisteredPlayer {
  video: HTMLVideoElement;
  /** Put this player back in the flow. Called only when it is stopped mid-play by another. */
  undock: () => void;
}

const players = new Set<RegisteredPlayer>();

function stopEveryOtherPlayer(current: HTMLVideoElement): void {
  for (const other of players) {
    if (other.video === current) continue;
    // Only the ones actually running. A paused player is a decision the reader made.
    if (other.video.paused) continue;
    other.video.pause();
    other.undock();
  }
}

function formatSpeed(rate: number): string {
  return rate === 1 ? "Normal" : `${rate}×`;
}

export function VideoPlayer({
  src,
  mimeType,
  title,
  poster,
  captionsSrc,
  captionsLabel,
  settings,
  downloadName,
  className
}: VideoPlayerProps) {
  const reduce = useReducedMotionPreference();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /**
   * The in-flow anchor, and the thing the observer actually watches.
   *
   * ⚠ NOT THE FIGURE. Once the figure is `position: fixed` it is on screen by definition, so an
   * observer watching it would report "visible" the instant it docked and undock it again on the next
   * frame — a player flickering between two places for as long as the reader stayed still.
   */
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const speedLabelId = useId();

  const [docked, setDocked] = useState(false);
  const [speed, setSpeed] = useState(1);
  /** The height to hold open while the film is in the corner, measured before it leaves. */
  const [placeholderHeight, setPlaceholderHeight] = useState<number | null>(null);

  /**
   * True once the reader has deliberately stopped the film.
   *
   * ⚠ WITHOUT IT, "PAUSE" AND "START WHEN VISIBLE" FIGHT EACH OTHER. A reader who pauses a playing
   * film, scrolls away and scrolls back would be started again by the visibility rule, every time,
   * with no way to make it stop short of leaving the page. A pause the READER performed is a decision
   * that outlives the scroll position; a pause this component performed is not, which is why the
   * off-screen branch below sets the flag back to false rather than leaving it alone.
   */
  const stoppedByReaderRef = useRef(false);

  /**
   * Set immediately before THIS component pauses the film, and spent by the `pause` handler.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * ⚠ THE `pause` EVENT DOES NOT FIRE SYNCHRONOUSLY, WHICH IS WHY A PLAIN ASSIGNMENT AFTER `pause()`
   * IS BACKWARDS. The media element's internal pause steps QUEUE a task to fire the event, so:
   *
   *     video.pause();                          // 1
   *     stoppedByReaderRef.current = false;     // 2 — runs now
   *     …                                       // 3 — the queued task fires `pause`
   *     onPause -> stoppedByReaderRef = true    // 4 — and undoes 2
   *
   * The flag therefore ended up saying "the reader stopped this" for a pause the OBSERVER performed,
   * and `autoplayOnScreen` then refused to start the film again when the reader scrolled back to it —
   * once, silently, and only for a reader who had scrolled past a playing video, which is the hardest
   * kind of bug to see. A flag the handler reads and clears is the only ordering that holds, because
   * it is the handler that runs last.
   *
   * ⚠ IT IS ONLY EVER SET WHERE THE FILM IS KNOWN TO BE PLAYING. `pause()` on an already-paused
   * element fires nothing, so a flag set there would never be spent and would swallow the reader's
   * NEXT pause instead. The one place that sets it has already returned early for a paused video.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  const ownPauseRef = useRef(false);

  /** Kept in a ref as well so the observer callback reads today's settings without re-subscribing. */
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const reduceRef = useRef(reduce);
  reduceRef.current = reduce;

  const undock = useCallback(() => {
    setDocked(false);
    setPlaceholderHeight(null);
  }, []);

  /**
   * Start the film, muted, and swallow the refusal.
   *
   * `play()` returns a promise that REJECTS when a browser declines the autoplay, and an unhandled
   * rejection in a `useEffect` is an error in the console on every page carrying a video. A refused
   * autoplay is a poster and a play button, which is a perfectly good outcome.
   */
  const startMuted = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = true;
    void video.play().catch(() => undefined);
  }, []);

  /**
   * Join the page's register of players, and leave it on unmount.
   *
   * ⚠ `undock` IS READ THROUGH A REF RATHER THAN CAPTURED. The registration must not re-run on every
   * render — a `Set` entry replaced mid-play is an entry another player may already be iterating — and
   * a captured callback would go stale the moment anything in this component changed. `undock` is a
   * `useCallback` with an empty dependency list, so the ref is belt as well as braces; it is written
   * this way so that adding a dependency to `undock` later cannot silently break the register.
   */
  const undockRef = useRef(undock);
  undockRef.current = undock;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const entry: RegisteredPlayer = { video, undock: () => undockRef.current() };
    players.add(entry);
    return () => {
      players.delete(entry);
    };
  }, []);

  // ── Visibility ─────────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    // A browser without the observer simply gets a player that never starts or docks by itself, which
    // is the same player somebody with reduced motion asked for. Nothing else degrades.
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        // The LAST entry, not the first: a scroll that crosses several thresholds in one frame is
        // delivered as several entries in one callback, and only the newest describes where the film
        // has actually ended up.
        const entry = entries[entries.length - 1];
        if (!entry) return;
        const video = videoRef.current;
        if (!video) return;
        const current = settingsRef.current;

        if (isOnScreen(entry)) {
          undock();
          if (
            current.autoplayOnScreen &&
            !reduceRef.current &&
            !stoppedByReaderRef.current &&
            video.paused
          ) {
            startMuted();
          }
          return;
        }

        // Off screen. A film that is not playing needs nothing done to it — docking a paused player
        // would put an empty panel in the corner of every page that happens to carry a video.
        if (video.paused) return;

        if (current.offScreen === "pause") {
          // OURS, not the reader's — so the film may start again when they scroll back to it. The
          // flag is set BEFORE the call and spent by the handler; see `ownPauseRef` for why the
          // obvious order is wrong. The early return above guarantees the film is playing, which is
          // what guarantees the event this flag is waiting for actually fires.
          ownPauseRef.current = true;
          video.pause();
          return;
        }

        if (current.offScreen === "minimise") {
          setPlaceholderHeight(anchor.getBoundingClientRect().height || null);
          setDocked(true);
        }
        // "continue" does nothing at all, which is the whole of it.
      },
      { threshold: VISIBILITY_STEPS }
    );

    observer.observe(anchor);
    return () => observer.disconnect();
  }, [startMuted, undock]);

  // ── Where it starts, and where it left off ─────────────────────────────────────────────────

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    const onLoadedMetadata = () => {
      /**
       * A remembered position WINS over the block's start time, and the order is deliberate: the
       * start time is where the editor wants a first-time reader to begin, and the remembered
       * position is where this particular reader stopped. Honouring the editor's number over the
       * reader's own progress would send somebody back to the beginning of a lecture every visit.
       */
      if (settings.rememberPosition && typeof window !== "undefined") {
        const stored = readPosition(positionKey(src));
        // A position at or past the end means "finished", and resuming there shows a black frame and
        // an ended player. Two seconds of slack covers a file whose duration is a fraction longer
        // than the last position event reported.
        if (stored !== null && stored < video.duration - 2) {
          video.currentTime = stored;
          return;
        }
      }
      if (settings.startAt > 0 && settings.startAt < video.duration) {
        video.currentTime = settings.startAt;
      }
    };

    video.addEventListener("loadedmetadata", onLoadedMetadata);

    /**
     * ⚠ THE EVENT MAY ALREADY HAVE HAPPENED, AND `preload="metadata"` IS WHAT MAKES THAT LIKELY. The
     * element is in the server-rendered HTML, so the browser can have the duration in hand before this
     * effect ever runs — hydration is not instant, and a cached file resolves in a frame. A listener
     * added afterwards is a listener for an event that has been and gone, and `startAt` and
     * `rememberPosition` then did nothing at all, intermittently, in a way that looked like a browser
     * quirk. `readyState` is the question "has it already?", asked once.
     */
    if (video.readyState >= HAVE_METADATA) onLoadedMetadata();

    return () => video.removeEventListener("loadedmetadata", onLoadedMetadata);
  }, [src, settings.rememberPosition, settings.startAt]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src || !settings.rememberPosition) return;
    if (typeof window === "undefined") return;

    /**
     * Written on `pause` and on leaving the page rather than on `timeupdate`.
     *
     * `timeupdate` fires four times a second on every playing video, and a `localStorage` write is
     * synchronous and touches the disk — four hundred writes over a two-minute film, for a value only
     * ever read once. The two events below are the only moments the number is worth anything.
     */
    const remember = () => {
      if (video.currentTime > 0) writePosition(positionKey(src), video.currentTime);
    };

    video.addEventListener("pause", remember);
    window.addEventListener("pagehide", remember);
    return () => {
      video.removeEventListener("pause", remember);
      window.removeEventListener("pagehide", remember);
      remember();
    };
  }, [src, settings.rememberPosition]);

  // ── The speed menu ─────────────────────────────────────────────────────────────────────────

  const changeSpeed = (rate: number) => {
    setSpeed(rate);
    const video = videoRef.current;
    if (video) video.playbackRate = rate;
  };

  /**
   * ⚠ RE-APPLIED WHENEVER THE SOURCE LOADS. `playbackRate` is a property of the media element's
   * current resource, and a browser resets it to 1 when a new one is loaded — so a rate chosen and
   * then followed by a reload is a control that visibly moved and did nothing.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const reapply = () => {
      video.playbackRate = speed;
    };
    video.addEventListener("loadeddata", reapply);
    return () => video.removeEventListener("loadeddata", reapply);
  }, [speed]);

  // ── No address ─────────────────────────────────────────────────────────────────────────────

  if (!src) {
    // SAY SO RATHER THAN LEAVE A GAP (contract §1.6): an editor finding out that the media base URL is
    // unset is worth more than a page that silently looks fine.
    return (
      <p
        className={cn(
          "rounded-md border border-dashed border-line-200 bg-surface-50 px-4 py-6 text-sm leading-relaxed text-ink-500",
          className
        )}
      >
        This video cannot be played, because no public media address is configured for this deployment.
      </p>
    );
  }

  const showsStrip = settings.speedMenu || settings.allowDownload;

  return (
    <>
      {/*
        The anchor. It is what the observer watches (see `anchorRef`) and what holds the article open
        while the film is in the corner — `min-height` rather than a fixed one, so a docked player
        whose page is then resized does not leave a hole of the wrong size behind it.
      */}
      <div
        ref={anchorRef}
        style={docked && placeholderHeight ? { minHeight: `${Math.round(placeholderHeight)}px` } : undefined}
        className={cn("min-w-0", className)}
      >
        <figure
          className={cn(
            "min-w-0",
            // ⚠ ONE LITERAL STRING PER STATE, never an array and never assembled. `cn()` is a plain join
            // over `string | false | null | undefined` (contract §5), and every class here has to appear
            // verbatim in the source for the content scan to keep it.
            //
            // z-40 is the bottom-dock rung of the ladder (contract §6) and this is a bottom dock. The
            // right offset pays the SCROLLBAR GUTTER: when a dialog or the lightbox locks the document the
            // scrollbar goes, the viewport widens by its width, and anything anchored to the right edge
            // slides outwards by that much. Every other fixed overlay here reads the same variable.
            docked
              ? "fixed bottom-4 right-[calc(1rem+var(--scroll-gutter,0px))] z-40 w-72 overflow-hidden rounded-lg border border-line-200 bg-card shadow-panel sm:w-96"
              : "relative"
          )}
        >
          {docked ? (
            <div className="flex items-center justify-between gap-2 border-b border-line-200 px-3 py-1.5">
              {/*
                It says WHICH film, because a corner panel with no name is a video playing at a reader
                from somewhere they can no longer see. Truncated rather than wrapped: the strip is one
                line high and a two-line title would push the film out of the panel.
              */}
              <p className="truncate text-xs font-medium text-ink-700" title={title}>
                {title}
              </p>
              <button
                type="button"
                onClick={() => {
                  videoRef.current?.pause();
                  stoppedByReaderRef.current = true;
                  undock();
                }}
                aria-label={`Stop ${title} and close the corner player`}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-500 transition hover:bg-purple-50 hover:text-purple-700 dark:hover:bg-purple-950 dark:hover:text-purple-200"
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
            </div>
          ) : null}

          <video
            ref={videoRef}
            // The film itself carries the name; the figure around it is layout.
            aria-label={title}
            controls={settings.showControls}
            loop={settings.loop}
            muted={settings.startMuted}
            poster={poster ?? undefined}
            // Never fullscreen-on-play on iOS: a film that takes over the whole phone the moment it is
            // touched is the single most disliked behaviour a mobile video can have.
            playsInline
            // The duration and the poster, without pulling a 180 MB file down for a reader who never
            // presses play.
            preload="metadata"
            // ⚠ `nodownload` HIDES THE BROWSER'S OWN SAVE ITEM; IT DOES NOT PROTECT THE FILE. The object
            // is public and its address is in the page source either way. The setting decides whether
            // the page OFFERS the file, and the schema's help says exactly that rather than implying a
            // protection this cannot give.
            controlsList={settings.allowDownload ? undefined : "nodownload"}
            disablePictureInPicture={!settings.allowPictureInPicture}
            /**
             * ⚠ WITHOUT THIS, SUBTITLES NEVER LOAD IN ANY REAL DEPLOYMENT, AND THEY FAIL IN SILENCE.
             *
             * A `<track>` is subject to CORS, and the media on this site is served from the object
             * store — `NEXT_PUBLIC_CDN_URL`, a DIFFERENT ORIGIN from the page (see `publicObjectUrl`).
             * A cross-origin track on an element with no `crossOrigin` is refused by every browser: no
             * error a reader can see, no captions, and a subtitles menu that appears and does nothing.
             *
             * ⚠ AND IT IS SET ONLY WHEN THERE IS A TRACK, WHICH IS THE OTHER HALF OF THE RULE. Putting
             * `crossOrigin` on a `<video>` makes the browser fetch the FILM itself as a CORS request
             * too — so a bucket whose CORS policy does not allow this origin would stop playing videos
             * that play perfectly today. Captions are new; playback is not. The narrow grant is the one
             * that cannot regress anything, and `docs/OPERATIONS.md` §1 is where the bucket policy is
             * written down.
             */
            crossOrigin={captionsSrc ? "anonymous" : undefined}
            /**
             * ⚠ A FINISHED FILM MUST NOT STAY IN THE CORNER. With `loop` off the last frame simply
             * stops, and the panel would sit over the article for the rest of the visit showing a still
             * of something that has ended — a thing the reader now has to dismiss for no reason. The
             * flag is set for the same reason the close button sets it: this is a stopped film, and
             * scrolling back to it must not start it again from the beginning.
             */
            onEnded={() => {
              stoppedByReaderRef.current = true;
              undock();
            }}
            onPlay={(event) => {
              stoppedByReaderRef.current = false;
              // One film at a time on a page. See `players` for why, and for what it deliberately
              // leaves alone.
              stopEveryOtherPlayer(event.currentTarget);
            }}
            onPause={() => {
              // A pause this component performed is spent here and means nothing about what the reader
              // wants — see `ownPauseRef`.
              if (ownPauseRef.current) {
                ownPauseRef.current = false;
                return;
              }
              /**
               * Everything else is a decision to stay stopped: the reader pressing pause, and ANOTHER
               * PLAYER STARTING. The second is deliberate — a film stopped because the reader started
               * a different one must not restart itself the moment they scroll back to it, or the page
               * ends up playing the one they walked away from.
               */
              stoppedByReaderRef.current = true;
            }}
            className={cn(
              "block w-full bg-ink-900",
              // The rounding lives on the FIGURE while docked, so the film must not round its own
              // corners as well or the two radii disagree at the top edge.
              //
              // ⚠ THE HEIGHT CAP IS FOR UPRIGHT VIDEO AND IS NOT OPTIONAL. The panel is 288px wide, and
              // a 9:16 recording inside it is 512px tall before its title bar — most of a phone's
              // screen, permanently, over the article the reader is trying to get back to. `object-contain`
              // rather than `cover` because letterboxing a film somebody is watching is better than
              // cropping it.
              docked ? "max-h-[45vh] object-contain" : "rounded-lg border border-line-200"
            )}
          >
            <source src={src} type={mimeType ?? undefined} />

            {captionsSrc ? (
              // `default` so captions are ON without the reader hunting for the menu. A caption file
              // exists because somebody made one; hiding it behind two clicks wastes that work.
              <track kind="captions" src={captionsSrc} label={captionsLabel || "Captions"} default />
            ) : null}

            {/* The last resort in a browser that cannot play the container. It is a real sentence,
                because "your browser does not support video" tells a reader nothing they can act on. */}
            <p className="p-4 text-sm text-white">
              This video cannot be played in this browser.{" "}
              <a href={src} className="underline">
                Download the file instead
              </a>
              .
            </p>
          </video>
        </figure>
      </div>

      {showsStrip && !docked ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
          {settings.speedMenu ? (
            <div className="flex items-center gap-2">
              {/*
                A REAL `<label>` AND A NATIVE `<select>`, on purpose.

                The studio's themed listbox is a `<button>` plus a portalled panel, and a `<label>`
                around one of those slams the menu shut on the first click (contract §10) — while the
                alternative, `FieldBlock`, drags the studio's form furniture onto a public article. A
                native select is one keyboard-operable control that every assistive technology already
                understands, and this is one setting rather than a form.
              */}
              <label htmlFor={speedLabelId} className="text-xs font-medium text-ink-500">
                Speed
              </label>
              <select
                id={speedLabelId}
                value={speed}
                onChange={(event) => changeSpeed(Number(event.target.value))}
                className="rounded-md border border-line-200 bg-card px-2 py-1 text-xs text-ink-700 outline-none transition focus-visible:ring-2 focus-visible:ring-purple-600/40"
              >
                {VIDEO_SPEEDS.map((rate) => (
                  <option key={rate} value={rate}>
                    {formatSpeed(rate)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {settings.allowDownload ? (
            /**
             * ⚠ IT OPENS THE FILE; IT DOES NOT SAVE IT, AND THE WORDS SAY SO.
             *
             * `<a download>` is IGNORED on a cross-origin href — the specification makes it a
             * same-origin-only hint — and every film on this site is served from the object store,
             * which is a different origin from the page by construction (`publicObjectUrl`). So the
             * attribute is inert here and a link captioned "Save this video" would be a promise the
             * browser refuses to keep: the file opens instead, in this tab, replacing the article.
             *
             * `target="_blank"` is the repair. The file opens in its own tab, where the browser's own
             * save is one keystroke away and the article is still where the reader left it. The
             * attribute stays because it costs nothing and is honoured the day the object store is
             * ever served from this origin; `downloadName` is what it would then use.
             */
            <a
              href={src}
              download={downloadName ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-purple-700 underline-offset-2 hover:underline dark:text-purple-300"
            >
              <Download aria-hidden="true" className="h-3.5 w-3.5" />
              Open the video file
              {/* Sighted readers get the new tab as a surprise they can undo; a screen-reader user gets
                  no cue at all unless the destination says so before it is followed. */}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : null}
        </div>
      ) : null}

      {docked ? (
        /*
          A LINE WHERE THE FILM WAS, so the reader can find it again. `Minimize2` rather than a word
          alone because the panel it refers to is a picture in the corner of the screen, and pairing
          the two makes the relationship findable at a glance.

          ⚠ It is not `aria-live`. The panel announces itself by containing a named, focusable control;
          a live region would interrupt a screen-reader user mid-sentence every time they scrolled
          past a video.
        */
        <p className="mt-2 flex items-center gap-1.5 text-xs leading-relaxed text-ink-500">
          <Minimize2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          This video is playing in the corner of the screen. Scroll back to it to put it here again.
        </p>
      ) : null}
    </>
  );
}
