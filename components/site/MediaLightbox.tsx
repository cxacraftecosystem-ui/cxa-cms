"use client";

/**
 * MediaLightbox — the full-screen picture viewer, plus the two pieces that open it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THREE EXPORTS, AND THE SPLIT IS THE POINT.
 *
 *   • `MediaLightbox`      the controlled viewer. Owns nothing; the caller says which index is open.
 *   • `MediaLightboxProvider`  holds that index, so a Server Component can wrap a grid it rendered
 *                          on the server and still get a working lightbox.
 *   • `LightboxTrigger`    the `<button>` around one thumbnail.
 *
 * The provider/trigger pair exists so the GRID STAYS ON THE SERVER. A gallery is a list of
 * `<MediaImage>`s, and `MediaImage` pulls `next/image` with it; making the whole grid a Client
 * Component to get one `onClick` would ship the image component, the layout and every caption to the
 * browser for the sake of a click handler. Instead the server renders the thumbnails and passes them
 * as `children` through the trigger, which is a button and nothing else.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE BACKDROP DISMISS TESTS THE MOUSEDOWN AS WELL AS THE CLICK. A click event fires on the nearest
 * common ancestor of where the press started and where it ended, so a drag that begins on the caption
 * — selecting the text — and ends over the backdrop still produces a click whose target is the
 * backdrop. Testing only the click target therefore dismisses the viewer in the middle of a text
 * selection, which is one of those bugs nobody reports and everybody notices. Both ends of the press
 * must land on a surface marked `data-lightbox-dismiss`.
 *
 * ONLY THE NEIGHBOURS ARE PRELOADED. Exactly three slides are mounted — previous, current, next —
 * and the two neighbours are `opacity-0` rather than unmounted. They are still laid out and still
 * intersect the viewport, so `next/image`'s lazy loader fetches them through the SAME optimiser URL
 * the visible slide will use, which is what makes the next arrow press instant. Preloading the raw
 * object instead would warm a URL the page never requests. Mounting all 27 slides would download an
 * album nobody asked for.
 *
 * FOCUS RESTORATION READS `document.activeElement` AT OPEN TIME, unlike `components/ui/Dialog.tsx`,
 * which keeps a document-wide tracker because its triggers routinely disable themselves ("Delete" →
 * "Deleting…") and drop focus to `<body>` before the dialog mounts. A lightbox trigger is a
 * thumbnail: it is still there, still enabled and still focused when the viewer opens. The simpler
 * read is correct here and the tracker would be machinery with no failure to prevent.
 *
 * The Tab trap, the Escape swallow and the focusable-element definition are shared with `Dialog` —
 * `focusableWithin` is imported rather than re-derived so two overlays cannot disagree about where
 * the tab order ends.
 *
 * Reduced motion branches `initial` here, which is forbidden on the prerendered public sections and
 * fine in this one file: a lightbox only ever mounts after a click, so there is no server-rendered
 * first paint for the entrance to disagree with (contract §8).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

import { DURATION, EASE_OUT, SPRING_LAYOUT, useReducedMotionPreference } from "@/components/motion";
import { focusableWithin } from "@/components/ui/Dialog";
import { MediaImage } from "@/components/ui/MediaImage";
import { useScrollLock } from "@/components/ui/useScrollLock";
import type { MediaLike } from "@/lib/media/url";
import { cn, unique } from "@/lib/utils";

/** The dialog rung of the z-index ladder (contract §6). Written inline; it is not a stock utility. */
const LIGHTBOX_Z = 100;

/**
 * How tall a slide may be.
 *
 * The frame's WIDTH is derived from this and the picture's own ratio, so a portrait photograph is
 * narrow and a panorama is wide, and neither is ever taller than the space between the chrome bars.
 */
const STAGE_MAX_HEIGHT = "72vh";

/**
 * One picture in the viewer.
 *
 * It extends `MediaLike`, so a `MediaAsset` row selected with its variants satisfies it as it stands;
 * `caption` and `credit` are the placement's, not the asset's, because the same photograph carries a
 * different caption in an album than it does on a project page.
 */
export interface LightboxItem extends MediaLike {
  id: string;
  caption?: string | null;
  credit?: string | null;
  /** Overrides the asset's stored alt text. `""` marks the picture decorative — see lib/media/url.ts. */
  alt?: string | null;
}

export interface MediaLightboxProps {
  items: readonly LightboxItem[];
  /** The open picture's index, or null for closed. */
  index: number | null;
  onClose: () => void;
  onIndexChange: (next: number) => void;
  /** Names the viewer for a screen reader — "Convocation 2026". Defaults to a generic name. */
  label?: string;
}

export function MediaLightbox({ items, index, onClose, onIndexChange, label }: MediaLightboxProps) {
  const [container, setContainer] = useState<HTMLElement | null>(null);

  // `document` is not available during the server render, so the portal target is taken after mount.
  useEffect(() => {
    setContainer(document.body);
  }, []);

  if (!container) return null;

  const open = index !== null && index >= 0 && index < items.length;

  return createPortal(
    <AnimatePresence>
      {open && index !== null ? (
        <LightboxSurface
          items={items}
          index={index}
          onClose={onClose}
          onIndexChange={onIndexChange}
          label={label}
        />
      ) : null}
    </AnimatePresence>,
    container
  );
}

interface LightboxSurfaceProps {
  items: readonly LightboxItem[];
  index: number;
  onClose: () => void;
  onIndexChange: (next: number) => void;
  label: string | undefined;
}

function LightboxSurface({ items, index, onClose, onIndexChange, label }: LightboxSurfaceProps) {
  const reduce = useReducedMotionPreference();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  // Whether the press that is currently in progress began on a dismissable surface. See the header.
  const pressStartedOnBackdrop = useRef(false);

  const count = items.length;

  // Held for as long as the surface is mounted, which includes the exit animation — releasing the
  // lock at the start of the fade brings the scrollbar back while the viewer is still on screen.
  useScrollLock(true);

  const goTo = useCallback(
    (next: number) => {
      if (count === 0) return;
      // Wraps rather than clamping: at the end of an album the next arrow returning to the first
      // picture is the behaviour every reader expects, and it avoids two dead controls at the ends.
      onIndexChange(((next % count) + count) % count);
    },
    [count, onIndexChange]
  );

  // Capture the element to return focus to, and put focus back on unmount. Both halves in one effect
  // so they cannot get out of step.
  useEffect(() => {
    const active = document.activeElement;
    restoreRef.current = active instanceof HTMLElement && active !== document.body ? active : null;

    return () => {
      const target = restoreRef.current;
      if (!target) return;
      window.requestAnimationFrame(() => {
        // The thumbnail may have gone — a filter changed underneath, a route transition began.
        if (!target.isConnected) return;
        // `preventScroll`, because the scroll lock has just put the page back where it was and a
        // focus-induced scroll would undo it.
        target.focus({ preventScroll: true });
      });
    };
  }, []);

  // Initial focus goes to the panel itself: it announces the viewer's name and leaves nothing
  // actionable under a reflex Enter. The arrow keys work from here because the handler is on window.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel) return;

      if (event.key === "Escape") {
        // Swallowed whether or not anything is listening behind us: a lightbox opened from inside a
        // dialog must not close both with one press (contract §14).
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }

      if (count > 1) {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          goTo(index + 1);
          return;
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          goTo(index - 1);
          return;
        }
        if (event.key === "Home") {
          event.preventDefault();
          goTo(0);
          return;
        }
        if (event.key === "End") {
          event.preventDefault();
          goTo(count - 1);
          return;
        }
      }

      if (event.key !== "Tab") return;

      const focusables = focusableWithin(panel);
      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);
      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      // A viewer with nothing focusable still must not leak focus to the page behind it.
      if (!first || !last) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }

      // Focus outside the panel is treated as "at the far end", so the first Tab after focus has
      // escaped lands back inside rather than walking the page underneath.
      if (event.shiftKey) {
        if (!inside || active === first || active === panel) {
          event.preventDefault();
          last.focus();
        }
        return;
      }

      if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // Capture, so a control on the page that stops propagation cannot strand the viewer open.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [count, goTo, index, onClose]);

  const current = items[index];

  const isDismissSurface = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement && target.dataset.lightboxDismiss !== undefined;

  const onBackdropPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    pressStartedOnBackdrop.current = isDismissSurface(event.target);
  };

  const onBackdropClick = (event: ReactMouseEvent<HTMLElement>) => {
    const startedOnBackdrop = pressStartedOnBackdrop.current;
    pressStartedOnBackdrop.current = false;
    if (!startedOnBackdrop) return;
    if (!isDismissSurface(event.target)) return;
    onClose();
  };

  // Previous, current and next — deduplicated, so an album of one or two pictures does not mount the
  // same slide twice. The current slide is last so it paints over its neighbours.
  const slideIndexes =
    count <= 1
      ? [index]
      : unique([((index - 1 + count) % count), ((index + 1) % count), index]);

  if (!current) return null;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={label ? `${label} — image viewer` : "Image viewer"}
      tabIndex={-1}
      className="fixed inset-0 outline-none"
      // Inline rather than utilities: 100 is a ladder rung and not a stock Tailwind z-index, and a
      // fixed element cannot inherit the padding the scroll lock puts on <body>, so it re-pays the
      // vanished scrollbar itself (contract §6).
      style={{ zIndex: LIGHTBOX_Z, paddingRight: "var(--scroll-gutter, 0px)" }}
    >
      <motion.div
        aria-hidden="true"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: reduce ? 0 : DURATION.scrim, ease: EASE_OUT }}
        /*
         * ⚠ `purple-950`, not `ink-900`. A lightbox backdrop's whole job is to sink the page behind a
         * photograph, so it must be dark in BOTH themes — but `ink-900` is a themed neutral and
         * inverts (#1e1b2e → #f2f0f9), which made the dark theme's lightbox open as a near-white
         * flash and left every white control on it invisible. See ImageCredit.tsx for the full note.
         */
        className="absolute inset-0 bg-purple-950/92 backdrop-blur-sm"
      />

      <motion.div
        data-lightbox-dismiss
        onPointerDown={onBackdropPointerDown}
        onClick={onBackdropClick}
        initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
        transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
        className="relative flex h-full w-full flex-col"
      >
        <header className="flex shrink-0 items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <p className="text-sm font-medium tabular-nums text-white/80">
            {/* The count is plain text and not a live region: it is repeated inside the caption
                region below, which IS live, and announcing the same fact twice on every arrow press
                is worse than announcing it once. */}
            {index + 1} of {count}
          </p>

          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-10 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-white/85 transition hover:bg-white/10 hover:text-white"
          >
            <X aria-hidden="true" className="h-4 w-4" />
            Close
          </button>
        </header>

        <div
          data-lightbox-dismiss
          className="relative flex min-h-0 flex-1 items-center justify-center px-4 sm:px-16"
        >
          {slideIndexes.map((slideIndex) => {
            const item = items[slideIndex];
            if (!item) return null;
            const isCurrent = slideIndex === index;
            const ratio =
              item.width && item.height && item.width > 0 && item.height > 0
                ? item.width / item.height
                : 16 / 9;

            return (
              <div
                key={item.id}
                // The neighbours stay mounted and laid out so they are fetched, and stay out of the
                // accessibility tree and out of the pointer's way so they are not read or clicked.
                aria-hidden={isCurrent ? undefined : true}
                className={cn(
                  "absolute inset-0 flex items-center justify-center px-1 py-2",
                  isCurrent ? undefined : "pointer-events-none opacity-0"
                )}
              >
                <div
                  // The height cap is the design constraint; the width follows from the picture's own
                  // proportions, so nothing is ever cropped or letterboxed by the frame.
                  style={{ width: `min(100%, calc(${STAGE_MAX_HEIGHT} * ${ratio}))` }}
                  className="max-h-full"
                >
                  <MediaImage
                    media={item}
                    alt={item.alt ?? undefined}
                    aspect={ratio}
                    rounded="md"
                    sizes="100vw"
                    targetWidth={2560}
                    className="w-full shadow-cinema"
                    imageClassName="!object-contain"
                  />
                </div>
              </div>
            );
          })}

          {count > 1 ? (
            <>
              <button
                type="button"
                onClick={() => goTo(index - 1)}
                aria-label="Previous image"
                className="absolute left-1 top-1/2 -mt-6 inline-flex h-12 w-12 items-center justify-center rounded-full bg-purple-950/60 text-white transition hover:bg-purple-950/80 sm:left-3"
              >
                <ChevronLeft aria-hidden="true" className="h-5 w-5" />
              </button>

              <button
                type="button"
                onClick={() => goTo(index + 1)}
                aria-label="Next image"
                className="absolute right-1 top-1/2 -mt-6 inline-flex h-12 w-12 items-center justify-center rounded-full bg-purple-950/60 text-white transition hover:bg-purple-950/80 sm:right-3"
              >
                <ChevronRight aria-hidden="true" className="h-5 w-5" />
              </button>
            </>
          ) : null}
        </div>

        {/*
          POLITE, AND DELIBERATELY SO. This is not a scroll-position readout (which must never be
          live — contract §8); it is the answer to a discrete action the reader just took. Pressing
          the right arrow with a screen reader open and hearing nothing is indistinguishable from
          pressing a key that did nothing.
        */}
        <footer
          aria-live="polite"
          className="shrink-0 px-4 pb-5 pt-3 text-center sm:px-6"
        >
          <p className="sr-only">
            Image {index + 1} of {count}
          </p>
          {current.caption ? (
            <p className="prose-measure mx-auto text-sm leading-relaxed text-white/85">
              {current.caption}
            </p>
          ) : null}
          {current.credit ? (
            <p className="mt-1 text-xs text-white/60">{current.credit}</p>
          ) : null}
        </footer>
      </motion.div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The provider and the trigger
// ─────────────────────────────────────────────────────────────────────────────

interface LightboxContextValue {
  open: (index: number) => void;
  count: number;
}

const LightboxContext = createContext<LightboxContextValue | null>(null);

export interface MediaLightboxProviderProps {
  items: readonly LightboxItem[];
  /** Names the viewer for a screen reader — usually the album or section title. */
  label?: string;
  children: ReactNode;
}

/**
 * Holds which picture is open and renders the viewer beneath its children.
 *
 * `children` is normally a grid rendered by a Server Component, which stays on the server: React
 * serialises the already-rendered tree and passes it through, so nothing inside it becomes client
 * code by being wrapped here.
 */
export function MediaLightboxProvider({ items, label, children }: MediaLightboxProviderProps) {
  const [index, setIndex] = useState<number | null>(null);

  const value = useMemo<LightboxContextValue>(
    () => ({ open: (next: number) => setIndex(next), count: items.length }),
    [items.length]
  );

  return (
    <LightboxContext.Provider value={value}>
      {children}
      <MediaLightbox
        items={items}
        index={index}
        onClose={() => setIndex(null)}
        onIndexChange={setIndex}
        label={label}
      />
    </LightboxContext.Provider>
  );
}

export interface LightboxTriggerProps {
  /** Which picture in the provider's `items` this thumbnail is. */
  index: number;
  /**
   * The button's accessible name. REQUIRED, and it must say what pressing it DOES — "Open image 3 of
   * 27 full screen: the dye vats at Bagru". The picture's own alt text describes the picture, which
   * is a different sentence.
   */
  label: string;
  className?: string;
  /**
   * Usually omitted: the trigger is normally an EMPTY overlay stretched over a thumbnail rendered
   * beside it, exactly as `EntityCard` overlays its link.
   *
   * ⚠ `<button>` takes PHRASING content, and `MediaImage` renders a `<div>` frame. Wrapping a
   * thumbnail in this button is therefore invalid HTML — harmless in every browser, but it also folds
   * any caption inside into the button's accessible name. Prefer the overlay.
   */
  children?: ReactNode;
}

/**
 * The control that opens one picture.
 *
 * Outside a `MediaLightboxProvider` it renders its children and no button. A trigger with nowhere to
 * open is still a perfectly good picture, and a button that does nothing when pressed is worse than
 * no button at all.
 */
export function LightboxTrigger({ index, label, className, children }: LightboxTriggerProps) {
  const context = useContext(LightboxContext);
  if (!context) return <>{children}</>;

  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => context.open(index)}
      // No ring utility: the overlay is the size of the thumbnail, so the global `button:focus-visible`
      // outline in globals.css traces the picture itself (and a bare `ring-2` would be stock BLUE).
      className={cn("cursor-zoom-in rounded-md", className)}
    >
      {children}
    </button>
  );
}
