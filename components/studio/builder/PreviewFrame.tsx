"use client";

/**
 * PreviewFrame — the real page, in a real device width, inside the studio.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE FRAME IS THE DEVICE'S REAL WIDTH, SCALED DOWN. IT IS NEVER RESIZED TO FIT.
 *
 * This is the whole point of the component and it is worth being exact about, because the obvious
 * implementation is wrong. Setting an iframe to `width: 390px` gives the page inside a 390px viewport —
 * so the phone layout appears — but it appears at the studio's own pixel density, in a window whose
 * height is whatever is left over, with the page's own `min-width` rules and its horizontal scrollbar
 * behaving as they would on a 390px DESKTOP window. That is a different thing from a phone, and the
 * differences are exactly the ones a builder is checking for.
 *
 * So the iframe is laid out at the device's true size — 390 by 844 for a phone — and a CSS `transform:
 * scale()` shrinks the whole thing to fit the column. The media queries the page evaluates are the ones
 * a reader on that device will hit, the line lengths are the real line lengths, and a picture that is
 * too small at 390px looks too small here.
 *
 * IT RELOADS ON A TOKEN, NEVER ON A KEYSTROKE, AND IT KEEPS ITS PLACE ACROSS THE RELOAD.
 *
 * The original rule here was "reloads on save and at no other time", and the reason it gave still
 * stands word for word: *a preview that reloads while you are typing loses its scroll position four
 * times a sentence and makes the panel beside it unusable — you cannot look at the thing you are
 * editing.* Live preview does not repeal that objection; it answers it in two parts.
 *
 *   1. **The reload is still on a token, and the token is still bumped by the builder.** Nothing here
 *      watches the editor type. With live preview on, the builder bumps it a few hundred milliseconds
 *      after typing STOPS and only when a draft was genuinely stored — so a sentence is one reload,
 *      not thirty.
 *   2. **⚠ THE SCROLL POSITION SURVIVES THE RELOAD.** `contentWindow.scrollY` is read before the
 *      navigation and written back on the next frame after `load`. This is what makes reloading
 *      cheap enough to do at all, and it is not optional: without it every reload throws the editor
 *      back to the top of a page they were half way down, which is the failure the paragraph above
 *      describes. It works because the frame is same-origin. See `restoreScroll` for what happens when
 *      the page has got SHORTER since.
 *
 * ⚠ **THE WORDING HERE IS TRUE IN BOTH LAYOUTS, AND THAT IS WHY IT IS WORDED AS IT IS.** This used to
 * be a note that nobody could ever be typing and watching at the same moment, because Build and Preview
 * were two panels of one `Tabs` and `Tabs` mounts only the selected one. **Side by side now exists**
 * (`mode: "split"` in PageBuilder), so that is no longer true: in that layout an editor really is typing
 * into a block with this frame open beside it. Every sentence below was deliberately written to hold
 * either way — "refreshes a moment after a change", never "refreshes shortly after you stop typing" —
 * so the split view needed no new copy here. **Keep it that way.** A sentence that is true only in a tab
 * is a sentence that lies to half the people reading it.
 *
 * And because "a reload every few hundred milliseconds" is genuinely not what everybody wants while
 * writing a long paragraph, LIVE PREVIEW CAN BE TURNED OFF from the toolbar. Off, the frame is exactly
 * what it always was: the page as saved, refreshed when a save lands, and saying so when there is
 * unsaved work. The notice under the toolbar states which of the two the reader is looking at, always.
 *
 * LIGHT AND DARK ARE APPLIED BY WRITING `data-theme` INTO THE FRAME'S OWN DOCUMENT, which is the
 * attribute `lib/preferences.ts` puts on `<html>` and `tailwind.config.ts` keys `dark:` off. The frame
 * is same-origin, so this is a plain attribute write; it is done after every load, because the boot
 * script inside the frame sets the attribute from the reader's OWN stored preference the moment it
 * loads, and would otherwise win.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * NO ANIMATION. Changing device or theme is instant, and so is switching live preview on and off. The
 * studio is calm (contract §0) and an administrator switching to the phone width wants to see the phone
 * width, not watch it arrive. Nothing here needs `useReducedMotionPreference()` because nothing here
 * moves — the live indicator is a word and a pressed state, never a pulse (contract §1.4).
 *
 * NO `aria-live` ON THE STATUS NOTICE, deliberately. It changes every time the editor pauses typing,
 * and a screen reader interrupting somebody mid-sentence to say "up to date" every few seconds is not
 * help. The same reasoning as the scroll-position readouts on the public site (contract §8).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ExternalLink,
  Laptop,
  Monitor,
  MoonStar,
  RefreshCw,
  RotateCcw,
  Smartphone,
  Sun,
  Tablet,
  Zap,
  type LucideIcon
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button, LinkButton } from "@/components/ui/Button";
import { HelpText, type HelpTone } from "@/components/studio/HelpText";

// ─────────────────────────────────────────────────────────────────────────────
// The devices
// ─────────────────────────────────────────────────────────────────────────────
//
// Four widths, chosen because each one sits on a different side of a breakpoint the site actually uses
// (stock Tailwind: sm 640, md 768, lg 1024, xl 1280, 2xl 1536 — contract §2):
//
//   1440 — a wide desktop, above 2xl only in spirit: the widest layout most readers ever see.
//   1280 — exactly `xl`, the width at which several layouts change, so it is worth its own button.
//    768 — exactly `md`, the tablet boundary. A layout that breaks does it here.
//    390 — a modern phone in portrait. Below `sm`, so everything is stacked.
//
// The heights are the real usable viewport heights of those devices, not round numbers, because "is the
// call to action above the fold" is a question with a different answer at 844 than at 900.

interface DeviceSpec {
  id: string;
  label: string;
  /** The CSS pixel width of the viewport in its natural orientation. */
  width: number;
  height: number;
  icon: LucideIcon;
}

const DEVICES: readonly DeviceSpec[] = [
  { id: "desktop", label: "Desktop", width: 1440, height: 900, icon: Monitor },
  { id: "laptop", label: "Laptop", width: 1280, height: 800, icon: Laptop },
  { id: "tablet", label: "Tablet", width: 768, height: 1024, icon: Tablet },
  { id: "phone", label: "Phone", width: 390, height: 844, icon: Smartphone }
];

type PreviewTheme = "light" | "dark";

/**
 * The three display choices — which device, which way up, which theme.
 *
 * ⚠ OWNED BY THE CALLER, NOT BY THIS COMPONENT, and that is the entire feature. Build, Side by side
 * and Preview each mount their own `PreviewFrame`, so state held here would reset to desktop-portrait-
 * light on every tab switch — pick the phone in Side by side, glance at Build, come back, and you are
 * on desktop again with no idea why. The builder outlives every tab, so it holds the choice and every
 * frame it mounts agrees. Live preview is deliberately NOT in here: it changes which DOCUMENT is
 * shown rather than how it is displayed, and it already lives in the builder for its own reasons.
 */
export interface PreviewDisplay {
  deviceId: string;
  landscape: boolean;
  theme: PreviewTheme;
}

export const DEFAULT_PREVIEW_DISPLAY: PreviewDisplay = {
  deviceId: "desktop",
  landscape: false,
  theme: "light"
};

/**
 * The name of the query parameter that asks the preview route for the editor's unsaved draft.
 *
 * ⚠ **DECLARED IN TWO PLACES.** The other one is `PAGE_PREVIEW_LIVE_QUERY_KEY` in
 * `lib/pages/preview-draft.ts`, which is what the preview route reads. That module is `server-only` —
 * deliberately, because it holds other people's unsaved words and must never be bundled for a browser
 * — so it cannot be imported here, and the two constants must be kept in step by hand. Renaming one
 * without the other does not fail the build; it silently turns live preview off.
 */
const LIVE_QUERY_KEY = "live";
const LIVE_QUERY_VALUE = "1";

/**
 * The address to point at the preview, with the live flag on or off.
 *
 * ⚠ EXPORTED SO THE BUILDER'S OWN "Open in a new tab" CANNOT DRIFT FROM THE FRAME. That button sits
 * outside this component — it has to, because it is useful from the Build tab, where this component is
 * not mounted — and the one thing worse than not having it is having it open a DIFFERENT page from the
 * one in the panel. The live flag is already declared in two places (see above); a third copy, in a
 * caller, is how "the new tab shows the saved page and the panel shows the draft" happens.
 *
 * Appended rather than rebuilt: `src` already carries the preview token, and the token is the one part
 * of this URL nothing in the browser is allowed to compute.
 */
export function previewHref(src: string, livePreview: boolean): string {
  if (!livePreview) return src;
  return `${src}${src.includes("?") ? "&" : "?"}${LIVE_QUERY_KEY}=${LIVE_QUERY_VALUE}`;
}

/**
 * Where the live preview stands, as the builder sees it.
 *
 *   `waiting` — something has been typed that the preview has not been told about yet, or the very
 *               first draft is still on its way. Not a fault; the ordinary state mid-sentence.
 *   `live`    — the frame is showing the editor's unsaved words.
 *   `paused`  — the draft was refused (a block whose settings do not validate, a page over the size
 *               cap, a lost connection) and the frame is showing the last version that got through.
 *               `liveProblem` is the server's own sentence, ready to render verbatim.
 */
export type PreviewLiveState = "waiting" | "live" | "paused";

export interface PreviewFrameProps {
  /**
   * The preview address, COMPLETE WITH its `?preview=…` token.
   *
   * Built on the server, because the token is an HMAC under the signing secret — see `pagePreviewToken`
   * in lib/pages.ts, which is `server-only` for exactly that reason. Passing the finished URL keeps the
   * name of the query parameter defined in one place instead of two.
   *
   * The live flag is added HERE rather than by the caller, so that everything this component points at
   * — the frame, and "Open in a new tab" — agrees about which page is being shown.
   */
  src: string;
  /** The page's title. Names the frame, so a screen reader says what is inside it rather than "frame". */
  pageTitle: string;
  /**
   * Bumped by the builder when the frame should reload: after a save that lands (live preview off), or
   * after a draft is stored (live preview on). The frame reloads when it changes and at no other time —
   * see the header.
   */
  reloadToken: number;
  /** True when there are changes that have not been saved. Only interesting when live preview is off. */
  hasUnsavedChanges?: boolean;
  /** Whether the frame is asking for the editor's unsaved draft. Owned by the builder, which sends it. */
  livePreview: boolean;
  onLivePreviewChange: (next: boolean) => void;
  liveState: PreviewLiveState;
  /** The server's sentence when `liveState` is `paused`. Rendered verbatim (lib/api.ts guarantees it). */
  liveProblem?: string | null;
  /**
   * Shrink the toolbar to fit a half-width column — the side-by-side layout.
   *
   * ⚠ IT DROPS WORDS FROM THE SCREEN, NEVER FROM THE ACCESSIBLE NAME. Each control keeps its full label
   * in an `sr-only` span, so a screen reader hears "Desktop 1440" either way and the only thing that
   * changes is how much of it is painted. The alternative — letting eleven labelled buttons wrap — turns
   * the toolbar into four rows and pushes the page itself below the fold, which is the one thing the
   * split view exists to prevent.
   *
   * The device WIDTHS stay visible even here. They are the point of those buttons: an icon alone does
   * not tell you whether "tablet" means 768 or 834.
   */
  dense?: boolean;
  /** The device / orientation / theme choice. Held by the builder so it survives a tab switch. */
  display: PreviewDisplay;
  onDisplayChange: (next: PreviewDisplay) => void;
  className?: string;
}

export function PreviewFrame({
  src,
  pageTitle,
  reloadToken,
  hasUnsavedChanges = false,
  livePreview,
  onLivePreviewChange,
  liveState,
  liveProblem = null,
  dense = false,
  display,
  onDisplayChange,
  className
}: PreviewFrameProps) {
  const { deviceId, landscape, theme } = display;
  const setDeviceId = (next: string) => onDisplayChange({ ...display, deviceId: next });
  const setLandscape = (next: boolean) => onDisplayChange({ ...display, landscape: next });
  const setTheme = (next: PreviewTheme) => onDisplayChange({ ...display, theme: next });
  const [stageWidth, setStageWidth] = useState(0);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  const device = useMemo(
    () => DEVICES.find((entry) => entry.id === deviceId) ?? DEVICES[0],
    [deviceId]
  );

  // A defensive fallback rather than a non-null assertion: DEVICES is a literal with four entries, but
  // `noUncheckedIndexedAccess` is on for a reason and a crashing preview is worse than a default one.
  const frameWidth = landscape ? (device?.height ?? 900) : (device?.width ?? 1440);
  const frameHeight = landscape ? (device?.width ?? 1440) : (device?.height ?? 900);

  /** The address the frame is actually pointed at. See `previewHref`. */
  const frameSrc = useMemo(() => previewHref(src, livePreview), [src, livePreview]);

  /**
   * The column's width, measured rather than assumed.
   *
   * A percentage cannot be used here: the scale has to be a NUMBER, because the same figure sizes the
   * placeholder box that reserves room for the scaled frame. Without that box the frame would overlap
   * whatever follows it — a scaled element still occupies its unscaled space in layout.
   */
  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setStageWidth(entry.contentRect.width);
    });
    observer.observe(node);
    setStageWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);

  // Never scaled UP. A 390px phone blown up to fill a 1200px column would be a lie about type size.
  const scale = stageWidth > 0 ? Math.min(1, stageWidth / frameWidth) : 1;
  const percent = Math.round(scale * 100);

  const applyTheme = useCallback(() => {
    const frame = frameRef.current;
    if (!frame) return;
    try {
      const root = frame.contentDocument?.documentElement;
      // Same-origin, so this normally just works. Wrapped anyway: a frame mid-navigation has no
      // document, and a preview that throws while an administrator is switching theme is a dead screen.
      root?.setAttribute("data-theme", theme);
    } catch {
      // Nothing to do and nothing to say — the frame will be re-themed on its next load.
    }
  }, [theme]);

  // Runs on mount and whenever the choice changes. The `load` handler below covers every reload and
  // every internal navigation the reader makes inside the preview.
  useEffect(() => {
    applyTheme();
  }, [applyTheme]);

  // ── Keeping the reader's place across a reload ───────────────────────────
  //
  // ⚠ THIS IS WHAT MAKES A RELOADING PREVIEW USABLE AT ALL. See the header.

  /** The offset captured just before a reload, waiting for the next `load`. Null when there is none. */
  const pendingScroll = useRef<number | null>(null);
  const restoreFrame = useRef<number | null>(null);

  const captureScroll = useCallback(() => {
    try {
      const offset = frameRef.current?.contentWindow?.scrollY;
      pendingScroll.current = typeof offset === "number" ? offset : null;
    } catch {
      // The reader has navigated the frame to another origin — an outbound link in the page they are
      // previewing. There is no position to keep and no way to read one; the reload puts them back on
      // the page being previewed, at the top, which is the right answer for that case anyway.
      pendingScroll.current = null;
    }
  }, []);

  /**
   * Put the reader back where they were, once the reloaded document has a height.
   *
   * ⚠ ONLY WHEN THAT POSITION STILL MEANS SOMETHING. Two cases are handled and neither is theoretical,
   * because the reason for the reload is usually that the page has just changed shape:
   *
   *   • **The new page fits the viewport** (`furthest <= 0`). There is nowhere to scroll to; the
   *     browser is already showing the whole thing and writing 0 would be a no-op with a flicker.
   *   • **THE PAGE GOT SHORTER** — a block was deleted, a list collapsed, an image was removed — so
   *     the remembered offset is past the end of the document. Scrolling there would leave the reader
   *     staring at blank space below the footer, and browsers clamp it silently, so the position they
   *     would land on is arbitrary. The offset is therefore clamped to the LAST scrollable position:
   *     the closest surviving point to where they were, and always real content. Sending them back to
   *     the top instead would throw away their place entirely, which is the thing this function exists
   *     to prevent.
   *
   * Read on the frame AFTER `load`, so images and fonts have already settled. A page whose height is
   * still moving after that — a lazily-loaded map, say — can land a little short; that self-corrects
   * on the next reload and is not worth a resize observer inside somebody else's document.
   */
  const restoreScroll = useCallback(() => {
    const target = pendingScroll.current;
    pendingScroll.current = null;
    if (target === null || target <= 0) return;

    const frame = frameRef.current;
    if (!frame) return;

    try {
      const win = frame.contentWindow;
      const doc = frame.contentDocument;
      if (!win || !doc) return;

      const furthest = Math.max(0, doc.documentElement.scrollHeight - win.innerHeight);
      if (furthest <= 0) return;

      win.scrollTo(0, Math.min(target, furthest));
    } catch {
      // Cross-origin again, or a document torn down between the load event and this frame. Losing the
      // position is a small cost; throwing inside a load handler would take the studio down with it.
    }
  }, []);

  /**
   * ⚠ A RELOAD ASKED FOR WHILE THE FRAME IS STILL LOADING IS DEFERRED, NOT DROPPED.
   *
   * This is a real defect that was caught by photographing the split view on a cold server, and it is
   * worth describing because it is invisible on a warm one. Opening a preview with live preview on
   * starts two things at once: the frame navigates to `?live=1`, and the builder PUTs its first draft.
   * When the draft wins that race — which it does whenever the first page render is slow, so exactly
   * when a reader is most likely to be watching — the token bumps and `reload()` is called against a
   * document that has not finished arriving. That call goes nowhere. The load then completes against a
   * store that had no draft in it *at request time*, so the preview route renders its "your unsaved
   * changes could not be found" band, and because the draft signature has not changed since, NOTHING
   * EVER BUMPS AGAIN. The band stays until the editor types another character.
   *
   * So a reload that arrives mid-navigation is remembered and run on the next `load`. One extra
   * round trip in a case that used to be a dead end, and nothing at all in the ordinary case.
   */
  const loading = useRef(true);
  const reloadWhenLoaded = useRef(false);

  // React writes the new address to the `src` attribute and the browser navigates on its own — turning
  // live preview on or off is the path that does this — so this is where such a navigation is recorded
  // as having started. Without it the first reload after a live toggle would be the swallowed one.
  useEffect(() => {
    loading.current = true;
  }, [frameSrc]);

  /**
   * Declared BEFORE `handleLoad` because that handler calls it — a deferred reload runs from the very
   * `load` event that clears the deferral. Reading it from a `useCallback` dependency array below its
   * own declaration would be a use-before-initialisation error at render, not a lint warning.
   */
  const reload = useCallback(() => {
    const frame = frameRef.current;
    if (!frame) return;

    // Mid-navigation: remember it and let `handleLoad` run it. See the note above `loading`.
    if (loading.current) {
      reloadWhenLoaded.current = true;
      return;
    }

    // Captured BEFORE the navigation starts — a moment later there is no old document to ask.
    captureScroll();
    loading.current = true;
    try {
      frame.contentWindow?.location.reload();
    } catch {
      // A frame the reader has navigated to another origin cannot be reloaded from here. Re-assigning
      // the address starts a fresh navigation, which also puts them back on the page being previewed.
      frame.src = frameSrc;
    }
  }, [frameSrc, captureScroll]);

  const handleLoad = useCallback(() => {
    loading.current = false;
    applyTheme();
    if (restoreFrame.current !== null) window.cancelAnimationFrame(restoreFrame.current);
    // One frame later, so the restore runs after the browser has laid the new document out. Calling
    // `scrollTo` inside the load handler itself lands on a document whose height may still be zero.
    restoreFrame.current = window.requestAnimationFrame(() => {
      restoreFrame.current = null;
      restoreScroll();

      // The deferred reload, run once the document it was asked against actually exists. Last, so the
      // reader's position is restored on the document being replaced — which is what makes the second
      // load land where they were rather than at the top.
      if (reloadWhenLoaded.current) {
        reloadWhenLoaded.current = false;
        reload();
      }
    });
  }, [applyTheme, restoreScroll, reload]);

  useEffect(
    () => () => {
      if (restoreFrame.current !== null) window.cancelAnimationFrame(restoreFrame.current);
    },
    []
  );

  /**
   * Reload when — and only when — the token changes.
   *
   * The ref is what makes "only when" true: the effect also runs on mount (where the frame is loading
   * anyway) and whenever `reload` changes identity, and in both cases the comparison stops it. Without
   * it, changing the address would reload a frame that had only just been given that address.
   *
   * ⚠ Turning live preview on or off is NOT a token bump. It changes `frameSrc`, which React writes to
   * the `src` attribute and the browser navigates on its own; bumping as well would navigate twice.
   */
  const lastReload = useRef(reloadToken);
  useEffect(() => {
    if (lastReload.current === reloadToken) return;
    lastReload.current = reloadToken;
    reload();
  }, [reloadToken, reload]);

  const orientationWord = landscape ? "landscape" : "portrait";

  /**
   * What the frame says it is showing. Exactly one sentence, always true, never absent when there is
   * something to admit.
   *
   * The `warn` cases are the two where what is on screen is NOT what the editor is looking at in the
   * builder; the `neutral` cases are the ordinary running states. A `HelpText` rather than a hand-rolled
   * tinted box, so the amber-100/amber-800 pairing lives in one place (contract §1 — amber-50 and
   * amber-200 are stock Tailwind here and do not pair correctly). No `role="alert"`: nothing has gone
   * wrong, and this line is true for most of the time an editor spends on this screen.
   */
  const notice: { tone: HelpTone; text: string } | null = (() => {
    if (!livePreview) {
      if (!hasUnsavedChanges) return null;
      return {
        tone: "warn",
        text: "This is the page as it was last saved. There are changes that have not been saved yet, so they are not in the preview — it refreshes itself the moment they are. Turn on Live preview to see them here without saving them first."
      };
    }

    if (liveState === "paused") {
      return {
        tone: "warn",
        text:
          liveProblem ??
          "Live preview has stopped keeping up, so this is the last version that could be sent, not what is in the editor now."
      };
    }

    if (liveState === "waiting") {
      return {
        tone: "neutral",
        text: "Live preview is on. Catching up with your latest changes — the page below refreshes in a moment."
      };
    }

    return {
      tone: "neutral",
      text: "Live preview is on, so this is the page including changes you have not saved yet. It refreshes a moment after a change and keeps its place on the page. Readers still see the last published version."
    };
  })();

  return (
    <div className={cn("space-y-3", className)}>
      {/* ── The controls ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-line-200 bg-card px-3 py-2">
        <div className="flex flex-wrap items-center gap-1">
          {/*
            `aria-pressed` on real buttons rather than a radio group: these are four ways of looking at
            one thing, not an answer to a question, and a radio group would put "Preview width" into the
            accessible name of every one of them.
          */}
          {DEVICES.map((entry) => {
            const DeviceIcon = entry.icon;
            const active = entry.id === deviceId;
            return (
              <button
                key={entry.id}
                type="button"
                aria-pressed={active}
                onClick={() => setDeviceId(entry.id)}
                className={cn(
                  "inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition focus-visible:ring-4 focus-visible:ring-purple-600/15",
                  active
                    ? "bg-purple-700 text-white"
                    : "text-ink-700 hover:bg-surface-100 hover:text-ink-900"
                )}
              >
                <DeviceIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                <span className={cn(dense && "sr-only")}>{entry.label}</span>
                {/* The numbers are the point of the control, so they are on it rather than in a tooltip.
                    They survive `dense` for that reason — an icon alone cannot say 768 rather than 834. */}
                <span className="tabular-nums text-[0.6875rem] opacity-80">
                  {entry.width}
                </span>
              </button>
            );
          })}

          <span aria-hidden="true" className="mx-1 h-5 w-px bg-line-200" />

          <button
            type="button"
            aria-pressed={landscape}
            onClick={() => setLandscape(!landscape)}
            className={cn(
              "inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition focus-visible:ring-4 focus-visible:ring-purple-600/15",
              landscape ? "bg-purple-700 text-white" : "text-ink-700 hover:bg-surface-100 hover:text-ink-900"
            )}
          >
            <RotateCcw aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            <span className={cn(dense && "sr-only")}>Turn on its side</span>
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {/*
            The live switch, shaped like the device buttons rather than as a `Switch`, because it is one
            more way of looking at this page and it belongs in this row at this row's height. Nothing
            about it pulses — a live indicator that only exists as motion is one a reduced-motion reader
            never gets (contract §1.4).

            ⚠ THE LABEL CARRIES THE STATE IN WORDS — "Live preview on" / "Live preview off" — and that
            is not decoration. The device and theme rows beside it are groups where exactly one entry is
            filled purple, so the selection is legible by comparison; this is a lone toggle, and with a
            fixed label the ONLY difference between its two states is the purple, which is colour
            carrying meaning alone (contract §11). It cannot lean on the notice underneath either: with
            live preview off and nothing unsaved, that notice is deliberately absent, so the button
            would be the sole account of which of the two things the frame is showing.
          */}
          <button
            type="button"
            aria-pressed={livePreview}
            onClick={() => onLivePreviewChange(!livePreview)}
            className={cn(
              "inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition focus-visible:ring-4 focus-visible:ring-purple-600/15",
              livePreview
                ? "bg-purple-700 text-white"
                : "text-ink-700 hover:bg-surface-100 hover:text-ink-900"
            )}
          >
            <Zap aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            {/*
              ⚠ THE STATE WORD SURVIVES `dense`, unlike every other label in this toolbar. The note above
              is why: this is a lone toggle, so with the word hidden the ONLY difference between its two
              states would be the purple fill — colour carrying meaning alone (contract §11). Dense
              shortens "Live preview" to "Live"; it never drops the "on"/"off".
            */}
            <span className="sr-only">Live preview {livePreview ? "on" : "off"}</span>
            <span aria-hidden="true">
              {dense ? "Live" : "Live preview"} {livePreview ? "on" : "off"}
            </span>
          </button>

          <span aria-hidden="true" className="mx-1 h-5 w-px bg-line-200" />

          {(["light", "dark"] as const).map((choice) => {
            const ThemeIcon = choice === "light" ? Sun : MoonStar;
            const active = choice === theme;
            return (
              <button
                key={choice}
                type="button"
                aria-pressed={active}
                onClick={() => setTheme(choice)}
                className={cn(
                  "inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium capitalize transition focus-visible:ring-4 focus-visible:ring-purple-600/15",
                  active ? "bg-purple-700 text-white" : "text-ink-700 hover:bg-surface-100 hover:text-ink-900"
                )}
              >
                <ThemeIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                <span className={cn(dense && "sr-only")}>{choice}</span>
              </button>
            );
          })}

          <span aria-hidden="true" className="mx-1 h-5 w-px bg-line-200" />

          <Button variant="ghost" size="sm" icon={RefreshCw} onClick={reload}>
            <span className={cn(dense && "sr-only")}>Reload</span>
          </Button>

          <LinkButton variant="ghost" size="sm" icon={ExternalLink} href={frameSrc} newTab>
            <span className={cn(dense && "sr-only")}>Open in a new tab</span>
          </LinkButton>
        </div>
      </div>

      {notice ? <HelpText tone={notice.tone}>{notice.text}</HelpText> : null}

      {/* ── The stage ────────────────────────────────────────────────────── */}
      <div className="overflow-hidden rounded-lg border border-line-200 bg-surface-100 p-4">
        {/*
          The MEASURED element carries no padding of its own, deliberately. `ResizeObserver` reports the
          content box while `clientWidth` — used for the very first measurement, before the observer has
          fired — includes padding. Measuring a padded element would make those two figures disagree by
          exactly the padding, and the first frame would be drawn 32px too wide and clipped.
        */}
        <div ref={stageRef}>
          <div
            // The placeholder box. It is the SCALED size, so the page below the preview sits where it
            // should — a transformed element still takes up its untransformed space in layout.
            className="mx-auto"
            style={{ width: frameWidth * scale, height: frameHeight * scale }}
          >
            <iframe
              ref={frameRef}
              src={frameSrc}
              // The frame's accessible name. An untitled frame is announced as "frame", which tells a
              // screen-reader user nothing about whether to enter it (contract §11).
              title={`Preview of ${pageTitle} at ${frameWidth} by ${frameHeight} pixels`}
              onLoad={handleLoad}
              // Laid out at the device's REAL size and then scaled. See the header.
              style={{
                width: frameWidth,
                height: frameHeight,
                transform: `scale(${scale})`,
                transformOrigin: "top left"
              }}
              className="block border-0 bg-card"
            />
          </div>
        </div>
      </div>

      <p className="text-xs leading-relaxed text-ink-500">
        Shown at {percent}% of a {frameWidth} by {frameHeight} pixel screen, in {orientationWord}. The
        page inside is drawn at that full size and then shrunk to fit, so the layout you are looking at is
        the one a reader on that screen gets — not a squeezed desktop. It is the real page, not a picture
        of one: links, menus and buttons all work.
      </p>
    </div>
  );
}
