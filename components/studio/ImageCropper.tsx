"use client";

/**
 * ImageCropper — choose WHICH PART OF A PICTURE THE SITE IS ALLOWED TO SHOW, and see it first.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE REPORT THIS ANSWERS: "a larger portion of the image that is relevant is cut off or not shown".
 *
 * That is a DISPLAY fault, not an upload fault. `components/ui/MediaImage.tsx` draws every asset
 * `object-cover` inside a frame whose aspect ratio the calling SECTION chose — a 16:9 hero, a square
 * grid tile, a 3:2 card — so any picture whose own shape differs from its frame is trimmed from the
 * CENTRE. Centre is a guess, and it is the wrong guess for most photographs of a person, a loom or a
 * finished piece, because the subject is rarely dead centre. Nothing was cropping the image badly on
 * purpose; nothing was choosing at all.
 *
 * SO THIS DIALOG PRODUCES FOUR NUMBERS, NOT NEW BYTES. It returns a rectangle in fractions of the
 * full image (0–1, origin top left), which is stored on the `MediaAsset` and applied at render. See
 * `CropRect` below, and prisma/migrations/20260816190000_media_asset_crop for the columns and the
 * long-form argument. In one line: a re-encode at upload would fix only files uploaded after today,
 * would break the rule stated beside `objectKey` in the schema ("Originals are retained forever"),
 * and could never be undone; four numbers fix the whole existing library, cost no re-upload, and are
 * adjustable for ever.
 *
 * ⚠ IT ADDS NO DEPENDENCY, AND THAT IS A DELIBERATE REFUSAL RATHER THAN AN OVERSIGHT. The obvious
 * packages here (react-easy-crop, react-image-crop, cropperjs) are 20–45 KB gzipped and every one of
 * them exists to solve the part this component does not do — producing cropped BYTES, with a canvas,
 * a zoom transform and a rotation matrix. A rectangle over an `<img>` is roughly two hundred lines of
 * pointer arithmetic, which is what is below.
 *
 * ⚠ AND IT NEVER TOUCHES A CANVAS, WHICH IS WHY IT CANNOT HIT THE TAINTING TRAP. Its sibling
 * `components/studio/media/ImageCropper.tsx` — which does a different job: it re-encodes a crop as a
 * NEW asset — has to load with `crossOrigin="anonymous"` and fails outright when the bucket sends no
 * `Access-Control-Allow-Origin` header, because `canvas.toBlob()` throws on a tainted canvas. Reading
 * a rectangle needs no pixels, so this one works against a plain CDN URL, against a `blob:` URL for a
 * file that has not finished uploading, and behind a misconfigured bucket.
 *
 * WHAT THE READER SEES IS WHAT THE SITE WILL DRAW. The preview panel on the right is not a mock-up:
 * it is the exact nested-percentage geometry `MediaImage` uses (see `cropFrameStyle`), so a crop that
 * looks right here is right on the page.
 *
 * IT IS KEYBOARD-OPERABLE. The crop box and its four corners are real `<button>`s; arrow keys move
 * and resize, Shift makes the step ten times larger, and every one of them is labelled with the
 * percentage of the picture it currently keeps.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import { Check, Crop, RotateCcw, TriangleAlert } from "lucide-react";

/**
 * The geometry lives in `lib/media/crop.ts` and is imported, not defined here.
 *
 * It used to be defined here, and the standing note beside `cropFrameStyle` said to move it before
 * `MediaImage` called it. That was the right instruction for a blunt reason: this module carries
 * `"use client"`, and a function exported from a client module and imported by a Server Component is a
 * client reference rather than the function. `MediaImage` is server-renderable, so it could not reach
 * the geometry — and so it applied no crop at all, which is the entire "cropping does not work" report.
 * The names are re-exported below for the studio components that already import them from here.
 */
import {
  cropFrameStyle,
  isUsableCrop,
  isWholeImage,
  storedCrop,
  FULL_CROP,
  type CropRect
} from "@/lib/media/crop";
import { clamp, cn } from "@/lib/utils";
import { useReducedMotionPreference } from "@/components/motion";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";

export { cropFrameStyle, isUsableCrop, isWholeImage, storedCrop, FULL_CROP };
export type { CropRect };

/** A crop plus the preset it was made on, which is the whole answer this dialog returns. */
export interface CropChoice {
  rect: CropRect;
  /** `CropAspectId`. Stored only so the dialog reopens on the shape the editor chose. */
  aspectId: string;
}

interface AspectPreset {
  id: string;
  label: string;
  /** Width divided by height, in PIXELS of the finished crop. `null` is free. */
  ratio: number | null;
}

/**
 * The shapes on offer, and every one of them is a shape the site actually draws.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS LIST IS NOT A DESIGNER'S GUESS. It was read off the `aspect` props actually passed to
 * `MediaImage` across components/sections and components/site, and each entry names the surface it
 * serves so that the list can be checked against the code again later:
 *
 *   21:9        components/site/PageHero.tsx — the wide plate under a page title
 *   1200 × 630  lib/seo.ts and `VARIANT_WIDTHS.og` — the picture that appears when a page is shared
 *   16:9        ParallaxBannerSection, NewsShowcaseSection, ArticleMeta (lead), EmbedSection
 *   16:10       components/site/EntityCard.tsx, `cover` variant — the ordinary card across the site
 *   3:2         PartnerLogosSection, ProcessStepsSection
 *   4:3         GallerySection, HorizontalRailSection, TimelineSection, story/CinematicScroll
 *   1:1         EntityCard `compact`, QuoteSection, ArticleMeta avatar, CraftMap, the library tiles
 *   3:4         components/site/EntityCard.tsx, `portrait` variant
 *   4:5         `PORTRAIT_ASPECT` in PersonCard and PeopleShowcaseSection, ArcCarousel, StoryScroll
 *
 * THE PREVIOUS FIVE WERE NOT ENOUGH, and the gap mattered most for people. Every photograph of a
 * person on this site is drawn at 4:5 (`PORTRAIT_ASPECT`, defined identically in two files), and the
 * closest shape previously on offer was 3:4 — a crop framed to 3:4 loses another 6% off the top and
 * bottom in a 4:5 frame, which is exactly where a head is. 16:10, 3:2, 21:9 and the social card were
 * simply absent, so a card cover, a partner logo, a page hero and a shared link were all being framed
 * against the wrong rectangle or against nothing at all.
 *
 * ⚠ NO ID FROM THE PREVIOUS LIST WAS RENAMED OR REMOVED. `cropAspect` values are already stored
 * against real assets; a renamed id would silently reopen the dialog on "free" and lose the shape the
 * editor chose. Ids are only ever ADDED here.
 *
 * "Free" stays, and it is not an afterthought: it is the right answer for trimming dead space or a
 * scanned border, where the point is the picture rather than a frame.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
// `as const satisfies` rather than a `: readonly AspectPreset[]` annotation. The annotation checks the
// shape but WIDENS every `id` to `string`, so `CropAspectId` below would have been an alias for
// `string` and would have caught nothing — a typo in a stored `cropAspect` would compile.
export const CROP_ASPECTS = [
  { id: "free", label: "Free — trim to any shape", ratio: null },
  { id: "21-9", label: "Page hero 21:9", ratio: 21 / 9 },
  // Spelled as its real pixels rather than as 40:21. A crop made at this shape is the one that appears
  // when somebody shares the page, and "1200 × 630" is what everybody outside this file calls it.
  { id: "og", label: "Social card 1200 × 630", ratio: 1200 / 630 },
  { id: "16-9", label: "Wide 16:9 — banners and news covers", ratio: 16 / 9 },
  { id: "16-10", label: "Card 16:10 — the usual card cover", ratio: 16 / 10 },
  { id: "3-2", label: "Landscape 3:2 — logos and step photographs", ratio: 3 / 2 },
  { id: "4-3", label: "Landscape 4:3 — galleries and rails", ratio: 4 / 3 },
  { id: "1-1", label: "Square 1:1 — tiles and avatars", ratio: 1 },
  { id: "3-4", label: "Upright 3:4 — portrait cards", ratio: 3 / 4 },
  { id: "4-5", label: "Portrait 4:5 — photographs of people", ratio: 4 / 5 }
] as const satisfies readonly AspectPreset[];

export type CropAspectId = (typeof CROP_ASPECTS)[number]["id"];

/**
 * Nothing below this fraction of an edge can be kept.
 *
 * 5% of a 320px thumbnail is 16 real pixels. Below that the crop is not a decision anybody made on
 * purpose, and the handles are too close together to separate with a finger.
 */
const MIN_EDGE = 0.05;

/** One arrow press, as a fraction of the edge. Shift multiplies it — 0.2% at a time is not a gesture. */
const NUDGE = 0.002;
const NUDGE_FAST = 0.02;


type Corner = "nw" | "ne" | "sw" | "se";
type DragKind = "move" | Corner;

interface DragState {
  kind: DragKind;
  startX: number;
  startY: number;
  /** The rendered size of the picture when the drag began — pointer pixels divide by this. */
  frame: { width: number; height: number };
  origin: CropRect;
}

/**
 * Corner metadata as complete literal class strings.
 *
 * A `cursor-${corner}-resize` assembled from data would be purged by the content scanner
 * (contract §5), and the positioning classes have the same problem, so every one is spelled out.
 */
const CORNERS: readonly { corner: Corner; label: string; cursor: string }[] = [
  { corner: "nw", label: "top left", cursor: "cursor-nwse-resize" },
  { corner: "ne", label: "top right", cursor: "cursor-nesw-resize" },
  { corner: "sw", label: "bottom left", cursor: "cursor-nesw-resize" },
  { corner: "se", label: "bottom right", cursor: "cursor-nwse-resize" }
];

/**
 * The frames the preview strip shows, with the `aspect-ratio` each surface actually passes.
 *
 * SIX, NOT TEN, and chosen for SPREAD rather than for frequency: the two extremes (21:9 and 4:5) are
 * where a centre-cropped picture goes most obviously wrong, and the four between them are what an
 * editor will actually see the picture in. 16:10 and 3:2 are deliberately absent — at this size they
 * are indistinguishable from 16:9 and 4:3 respectively, so a preview of each would be four boxes
 * saying the same thing while pushing the useful ones off the bottom.
 *
 * They are laid out two abreast, which is what keeps the strip shorter than the picture beside it. One
 * column of six would run to roughly 50rem against a 24rem picture, so the reader would be scrolling
 * to compare the thing they are adjusting with the result of adjusting it.
 */
const PREVIEW_FRAMES: readonly { id: string; label: string; ratio: string }[] = [
  { id: "page-hero", label: "Page hero", ratio: "21 / 9" },
  { id: "social", label: "Shared link", ratio: "1200 / 630" },
  { id: "banner", label: "Banner", ratio: "16 / 9" },
  { id: "gallery", label: "Gallery", ratio: "4 / 3" },
  { id: "tile", label: "Square tile", ratio: "1 / 1" },
  { id: "person", label: "Person", ratio: "4 / 5" }
];

/**
 * The largest rectangle of `ratio` that fits inside the image, centred.
 *
 * `ratio` is in PIXELS, so it has to be converted into the normalised space first — a 1:1 crop of a
 * 4000 × 3000 photograph is 0.75 wide and 1.0 tall in fractions, not 1.0 × 1.0. Getting this the
 * wrong way round produces a "square" preset that is square only for square photographs, which looks
 * like a rounding bug and is actually a units bug.
 */
function fitRect(ratio: number | null, natural: { width: number; height: number }): CropRect {
  if (ratio === null) return { ...FULL_CROP };
  const normalised = ratio * (natural.height / natural.width);
  let width = 1;
  let height = width / normalised;
  if (height > 1) {
    height = 1;
    width = height * normalised;
  }
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}

/** Keep a rectangle inside the picture, honouring the locked shape if there is one. */
function constrain(rect: CropRect, normalisedRatio: number | null): CropRect {
  let width = clamp(rect.width, MIN_EDGE, 1);
  let height = clamp(rect.height, MIN_EDGE, 1);

  if (normalisedRatio !== null) {
    // The width leads and the height follows, unless that pushes the box out of the picture, in which
    // case the height leads. Doing it the other way round lets a locked shape drift a fraction of a
    // percent per drag event, and over a long drag the "square" ends up visibly oblong.
    height = width / normalisedRatio;
    if (height > 1) {
      height = 1;
      width = height * normalisedRatio;
    }
  }

  return {
    width,
    height,
    x: clamp(rect.x, 0, 1 - width),
    y: clamp(rect.y, 0, 1 - height)
  };
}

export interface ImageCropperProps {
  open: boolean;
  onClose: () => void;
  /**
   * Where the pixels are. A CDN URL from `mediaSrc()` for an asset already in the library, or a
   * `blob:` URL from `URL.createObjectURL(file)` for one still uploading — this component only
   * measures, so either works and neither needs a CORS header.
   */
  src: string | null;
  /** Named in the dialog so a reader cropping a batch knows which picture they are looking at. */
  fileName: string;
  /** Where the dialog opens. Omit for the whole picture. */
  initialRect?: CropRect | null;
  initialAspectId?: string;
  /**
   * A sentence shown at the top of the dialog, above the shapes — for the consequence THIS caller
   * knows about and the dialog does not.
   *
   * ⚠ IT BELONGS HERE RATHER THAN BESIDE THE BUTTON THAT OPENS THE DIALOG, and the reason is that the
   * commit happens in here. `MediaPicker` uses it to say that the crop is stored on the FILE, so every
   * other page already using the picture is reframed by pressing "Use this crop" — a consequence an
   * editor attaching a photograph to one article has no reason to expect, and one they must read
   * before they press it rather than discover from somebody else's page afterwards.
   */
  note?: ReactNode;
  /**
   * Treat a whole-image rectangle as a real ANSWER rather than as an absence.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * ⚠ THE TWO MEANINGS OF `null` DIVERGE THE MOMENT A CROP CAN BE PER-SCREEN, and this flag is where
   * they part company.
   *
   * For a FILE, `null` means "nobody has chosen" and the whole picture is the same statement — so the
   * three original callers collapse `0/0/1/1` to `null` and store five nulls, which is exactly right:
   * an asset with no crop and an asset cropped to its own edges are indistinguishable.
   *
   * For a per-screen BUCKET they are not the same statement at all. `null` there means INHERIT from the
   * next smaller size, and "show all of it on desktop" is a deliberate override that has to survive.
   * Collapsing it would silently hand the bucket back to the phone's tight crop — the editor sets it,
   * the preview springs back, and nothing says why.
   *
   * Defaults to false, so `MediaPicker`, `MediaDetailPanel` and `UploadQueue` keep behaving exactly as
   * they do. `isUsableCrop(FULL_CROP)` is already true, so the render side needs no new case either.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  wholeImageIsAChoice?: boolean;
  /** The chosen crop. `null` means "show the whole picture" — the reset button returns that. */
  onApply: (choice: CropChoice | null) => void | Promise<void>;
}

export function ImageCropper({
  open,
  onClose,
  src,
  fileName,
  initialRect,
  initialAspectId,
  note,
  wholeImageIsAChoice = false,
  onApply
}: ImageCropperProps) {
  const reduceMotion = useReducedMotionPreference();

  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [aspectId, setAspectId] = useState<string>(initialAspectId ?? "free");
  const [rect, setRect] = useState<CropRect>(initialRect ?? FULL_CROP);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const ratio = CROP_ASPECTS.find((entry) => entry.id === aspectId)?.ratio ?? null;
  /** The locked shape in NORMALISED units. Null until the picture's own dimensions are known. */
  const normalisedRatio =
    ratio !== null && natural ? ratio * (natural.height / natural.width) : null;

  /**
   * The seed values, held in a ref and refreshed after every render.
   *
   * ⚠ THIS EXISTS SO THAT THE SEED EFFECT BELOW CAN DEPEND ON `open` ALONE. `initialRect` is a fresh
   * object on nearly every render — each caller derives it with `storedCrop(asset)` — so listing it as
   * a dependency compares two equal rectangles by IDENTITY, finds them different, and re-runs the
   * effect. That would throw away the box the reader is dragging, mid-drag, every time the caller
   * re-rendered for an unrelated reason: an upload progressing behind the upload queue, a debounced
   * search landing behind the picker. It reads exactly like the crop moving on its own, which is the
   * hardest kind of fault to report and the easiest to dismiss.
   *
   * Written in an effect rather than during render, because a render must have no side effects — and
   * DECLARED BEFORE the seed effect, because effects run in declaration order within one commit, so
   * on the render that opens the dialog this one has already stored that render's props by the time
   * the seed reads them.
   */
  const seedRef = useRef({ initialRect, initialAspectId });
  useEffect(() => {
    seedRef.current = { initialRect, initialAspectId };
  });

  // Reopening is a fresh start from whatever the caller stored. Carried in an effect rather than a
  // `key` on the caller's side because the caller is a queue that re-renders constantly, and a
  // remount on every render would lose a half-finished drag.
  //
  // ⚠ THE SEED IS READ ONCE, AT OPENING. A caller that changed `initialRect` while the dialog stood
  // open would not see it — which is right, because that is the reader's half-finished work, and no
  // caller does it: the dialog is modal, and the one asset it is editing cannot be swapped underneath
  // it without closing first.
  useEffect(() => {
    if (!open) return;
    const { initialRect: seedRect, initialAspectId: seedAspectId } = seedRef.current;
    setRect(seedRect && isUsableCrop(seedRect) ? seedRect : FULL_CROP);
    // An id this build does not know — a preset removed in a later version, or a hand-edited row —
    // falls back to "free" rather than leaving every chip unselected, which would read as a broken
    // control. The stored rectangle is still honoured; only the lock on its shape is lost.
    setAspectId(
      seedAspectId && CROP_ASPECTS.some((entry) => entry.id === seedAspectId) ? seedAspectId : "free"
    );
    setLoadError(false);
    setBusy(false);
    // `natural` is deliberately NOT cleared: the same picture is usually being reopened, the <img>
    // is already decoded, and clearing would blank the dialog for a frame on every open.
  }, [open]);

  /**
   * Picking a preset re-fits the box to the new shape.
   *
   * It does not try to preserve the old rectangle's centre or area. A 16:9 box "converted" to 3:4
   * either overflows the picture or shrinks to a sliver, and both outcomes look like the control
   * ignored the click. The largest centred fit is the one shape a reader can predict.
   */
  const chooseAspect = (nextId: string) => {
    setAspectId(nextId);
    const preset = CROP_ASPECTS.find((entry) => entry.id === nextId);
    if (!natural) return;
    if (!preset || preset.ratio === null) {
      // Free keeps whatever is on screen — the reader has just unlocked the shape, not asked for a
      // different one.
      return;
    }
    setRect(fitRect(preset.ratio, natural));
  };

  // ── Moving and resizing ─────────────────────────────────────────────────────────────────────
  const applyDrag = useCallback(
    (kind: DragKind, origin: CropRect, dx: number, dy: number): CropRect => {
      if (kind === "move") {
        // A move never changes the shape, so it is clamped directly rather than through `constrain`,
        // which would re-derive the height from the width and creep on a locked ratio.
        return {
          ...origin,
          x: clamp(origin.x + dx, 0, 1 - origin.width),
          y: clamp(origin.y + dy, 0, 1 - origin.height)
        };
      }

      // A corner drag moves two edges and pins the opposite corner, which is what makes the gesture
      // read as a resize rather than as a move.
      const right = origin.x + origin.width;
      const bottom = origin.y + origin.height;

      if (kind === "se") {
        return constrain(
          { ...origin, width: origin.width + dx, height: origin.height + dy },
          normalisedRatio
        );
      }
      if (kind === "sw") {
        const next = constrain(
          { ...origin, width: origin.width - dx, height: origin.height + dy },
          normalisedRatio
        );
        return { ...next, x: clamp(right - next.width, 0, 1 - next.width) };
      }
      if (kind === "ne") {
        const next = constrain(
          { ...origin, width: origin.width + dx, height: origin.height - dy },
          normalisedRatio
        );
        return { ...next, y: clamp(bottom - next.height, 0, 1 - next.height) };
      }
      const next = constrain(
        { ...origin, width: origin.width - dx, height: origin.height - dy },
        normalisedRatio
      );
      return {
        ...next,
        x: clamp(right - next.width, 0, 1 - next.width),
        y: clamp(bottom - next.height, 0, 1 - next.height)
      };
    },
    [normalisedRatio]
  );

  const onPointerDown = (kind: DragKind) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    const image = imageRef.current;
    if (!image) return;
    const frame = image.getBoundingClientRect();
    if (frame.width === 0 || frame.height === 0) return;

    // Both calls matter. The corner handles sit on top of the crop box, which is itself a button, so
    // without `stopPropagation` a corner drag would start a move at the same time.
    event.preventDefault();
    event.stopPropagation();

    dragRef.current = {
      kind,
      startX: event.clientX,
      startY: event.clientY,
      // Measured ONCE, at pointer-down. Re-measuring on every move would be correct only if nothing
      // reflowed mid-drag, and the preview strip beside the picture changes size as the crop changes.
      frame: { width: frame.width, height: frame.height },
      origin: rect
    };
    setDragging(true);
    // Capture, so a drag that leaves the picture — which is most of them, since the interesting
    // gesture is dragging a corner outward — keeps sending moves.
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = (event.clientX - drag.startX) / drag.frame.width;
    const dy = (event.clientY - drag.startY) / drag.frame.height;
    setRect(applyDrag(drag.kind, drag.origin, dx, dy));
  };

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onKeyDown = (kind: DragKind) => (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? NUDGE_FAST : NUDGE;
    let dx = 0;
    let dy = 0;
    if (event.key === "ArrowLeft") dx = -step;
    else if (event.key === "ArrowRight") dx = step;
    else if (event.key === "ArrowUp") dy = -step;
    else if (event.key === "ArrowDown") dy = step;
    else return;

    // Otherwise the arrow keys scroll the dialog body out from under the reader while they are
    // adjusting something they can no longer see.
    event.preventDefault();
    event.stopPropagation();
    setRect(applyDrag(kind, rect, dx, dy));
  };

  // ── What the numbers mean, said out loud ────────────────────────────────────────────────────
  const kept = Math.round(rect.width * rect.height * 100);
  const pixels = natural
    ? {
        width: Math.round(rect.width * natural.width),
        height: Math.round(rect.height * natural.height)
      }
    : null;

  /**
   * The crop as a sentence, for the crop box's accessible name and for the status line.
   *
   * Percentages rather than fractions, and the KEPT area rather than the discarded one: a reader
   * driving this with the keyboard is trying to answer "have I still got the loom in shot", and
   * "keeping 46% of the picture" is the number that answers it.
   */
  const cropSentence = pixels
    ? `Keeping ${kept}% of the picture — ${pixels.width} by ${pixels.height} pixels.`
    : `Keeping ${kept}% of the picture.`;

  const apply = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // A crop that keeps everything is stored as "no crop" rather than as four numbers that happen
      // to mean the same thing. Otherwise every asset an editor merely LOOKED at acquires a
      // rectangle, and the render side can no longer distinguish "nobody has decided" from "somebody
      // decided the whole picture" — which is the same three-state distinction `altText` makes and
      // for the same reason.
      // See `wholeImageIsAChoice`: for a file the whole picture and "no crop" are one statement; for a
      // per-screen bucket they are not, because null there means inherit.
      const collapse = !wholeImageIsAChoice && isWholeImage(rect);
      await onApply(collapse ? null : { rect, aspectId });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const boxStyle: CSSProperties = {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`
  };

  /**
   * The one piece of motion in this dialog, and it is switched off in two situations rather than one.
   *
   * Choosing a preset jumps the box to a different rectangle, and without a transition the reader
   * cannot see WHERE it went — on a large photograph the box can move most of the frame's width in a
   * single click. So the move is eased.
   *
   * ⚠ IT MUST BE OFF DURING A DRAG. A transition on `left`/`top`/`width`/`height` while the pointer
   * is moving makes the box chase the cursor a beat behind, which reads as a laggy application rather
   * than as an animation. And it is off entirely for `prefers-reduced-motion`, where a box that
   * slides is exactly the kind of unrequested movement the preference is asking us to stop.
   */
  const boxMotionClass = reduceMotion || dragging ? "" : "transition-[left,top,width,height] duration-200 ease-out";

  const handleClass =
    "absolute h-4 w-4 touch-none rounded-sm border-2 border-white bg-purple-700 shadow-panel " +
    "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-purple-600/25";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Choose what is shown"
      description={`Drag the box to the part of ${fileName} that matters. Everything outside it may be trimmed away on the site.`}
      size="lg"
      footer={
        <>
          <button type="button" data-dialog-cancel onClick={onClose} className="field-button-secondary">
            Cancel
          </button>
          <Button
            icon={Check}
            isLoading={busy}
            loadingLabel="saving the crop"
            disabled={natural === null}
            onClick={() => void apply()}
          >
            Use this crop
          </Button>
        </>
      }
    >
      {/*
        The caller's warning, above everything including the load error — a reader who cannot see the
        picture can still see what pressing the button would have done, and the sentence is as true of
        a picture that failed to load as of one that did not.

        amber-100 with amber-800 as a PAIR: the status ramps are literal hex and do not invert, and
        amber-50/amber-200 are stock Tailwind here and will not pair correctly (contract §1). No
        `role="alert"` — nothing has gone wrong and nothing has changed; it is part of the dialog the
        reader has just opened, and a live region would interrupt the dialog's own announcement.
      */}
      {note ? (
        <p className="mb-3 flex items-start gap-1.5 rounded-md bg-amber-100 px-3 py-2.5 text-sm leading-relaxed text-amber-800">
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{note}</span>
        </p>
      ) : null}

      {!src || loadError ? (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-md border border-error-200 bg-error-100 px-3 py-2.5 text-sm leading-relaxed text-error-700"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {src
              ? "This picture could not be loaded, so there is nothing to crop. It is stored safely — try again in a moment, and if it keeps happening the file store address needs checking."
              : "There is no web address for this picture yet, so it cannot be shown here. Wait for the upload to finish and try again."}
          </span>
        </p>
      ) : (
        <>
          <fieldset className="min-w-0">
            <legend className="mb-1.5 text-sm font-medium text-ink-900">Shape</legend>
            {/*
              Radio buttons, not a <select>. The shapes are the point of the dialog, and a closed list
              would hide all but one of them behind a click on the one screen where comparing them is
              the task. Native radios keep arrow-key navigation and the grouped announcement
              ("Shape, Square 1:1, tiles and avatars") for free.
            */}
            <div className="flex flex-wrap gap-1.5">
              {CROP_ASPECTS.map((preset) => {
                const active = preset.id === aspectId;
                return (
                  <label
                    key={preset.id}
                    className={cn(
                      "cursor-pointer rounded-md border px-2.5 py-1.5 text-xs font-medium transition",
                      "focus-within:ring-4 focus-within:ring-purple-600/15",
                      active
                        ? "border-purple-700 bg-purple-700 text-white"
                        : "border-line-200 bg-card text-ink-700 hover:border-purple-300"
                    )}
                  >
                    <input
                      type="radio"
                      name="crop-aspect"
                      value={preset.id}
                      checked={active}
                      onChange={() => chooseAspect(preset.id)}
                      className="sr-only"
                    />
                    {preset.label}
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_13rem]">
            {/* ── The picture, with the box over it ─────────────────────────────────────────── */}
            <div className="flex min-w-0 items-center justify-center rounded-md border border-line-200 bg-surface-100 p-3">
              <div className="relative inline-block max-w-full">
                {/*
                  A plain <img>, not next/image, and this is the one place in the studio where that is
                  correct. The source is a `blob:` URL as often as a CDN one — a file that is still
                  uploading has no public address yet — and the optimiser can fetch neither a blob nor
                  an origin absent from `next.config.ts`. The usual reasons to reach for `next/image`
                  do not apply either: nothing on the page is laid out from this element, so there is
                  no shift to prevent, and the bytes are already in the browser's cache from the
                  upload that just happened.
                */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  ref={imageRef}
                  src={src}
                  alt=""
                  aria-hidden="true"
                  onLoad={(event) =>
                    setNatural({
                      width: event.currentTarget.naturalWidth,
                      height: event.currentTarget.naturalHeight
                    })
                  }
                  onError={() => setLoadError(true)}
                  className="block max-h-[24rem] max-w-full select-none rounded-sm"
                  draggable={false}
                />

                {/*
                  The four bands of shade outside the crop. Four absolutely positioned divs rather
                  than one box-shadow, because a `0 0 0 9999px` shadow escapes `overflow: hidden` on
                  some engines and paints over the dialog's own footer.
                */}
                <div aria-hidden="true" className="pointer-events-none absolute inset-0">
                  <div className="absolute inset-x-0 top-0 bg-ink-900/45" style={{ height: `${rect.y * 100}%` }} />
                  <div
                    className="absolute inset-x-0 bottom-0 bg-ink-900/45"
                    style={{ height: `${(1 - rect.y - rect.height) * 100}%` }}
                  />
                  <div
                    className="absolute left-0 bg-ink-900/45"
                    style={{
                      top: `${rect.y * 100}%`,
                      height: `${rect.height * 100}%`,
                      width: `${rect.x * 100}%`
                    }}
                  />
                  <div
                    className="absolute right-0 bg-ink-900/45"
                    style={{
                      top: `${rect.y * 100}%`,
                      height: `${rect.height * 100}%`,
                      width: `${(1 - rect.x - rect.width) * 100}%`
                    }}
                  />
                </div>

                {/*
                  The crop box is a real <button>, so it is focusable, announced and driven by the
                  arrow keys. `touch-none` stops a drag on a touchscreen scrolling the dialog instead
                  of moving the box.
                */}
                <button
                  type="button"
                  aria-label={`Crop area. ${cropSentence} Use the arrow keys to move it, and hold Shift to move further.`}
                  onPointerDown={onPointerDown("move")}
                  onPointerMove={onPointerMove}
                  onPointerUp={endDrag}
                  onLostPointerCapture={endDrag}
                  onKeyDown={onKeyDown("move")}
                  style={boxStyle}
                  className={cn(
                    "absolute cursor-move touch-none border-2 border-white outline-none",
                    "focus-visible:ring-4 focus-visible:ring-purple-600/40",
                    boxMotionClass
                  )}
                />

                {/*
                  ⚠ THE FOUR HANDLES ARE SIBLINGS OF THE CROP BOX, NOT CHILDREN OF IT. Nesting them
                  inside would position them for free, but a <button> inside a <button> is invalid
                  HTML and the parser repairs it by HOISTING the inner one out of the outer — so the
                  handle silently detaches from the box it appears to belong to, and on some engines
                  stops receiving the pointer entirely. They are therefore positioned from the same
                  rectangle instead, and the negative margins centre each one on its corner.
                */}
                {CORNERS.map(({ corner, label, cursor }) => {
                  const left = corner === "nw" || corner === "sw" ? rect.x : rect.x + rect.width;
                  const top = corner === "nw" || corner === "ne" ? rect.y : rect.y + rect.height;
                  return (
                    <button
                      key={corner}
                      type="button"
                      aria-label={`Resize the crop from the ${label} corner. ${cropSentence} Use the arrow keys, and hold Shift to move further.`}
                      onPointerDown={onPointerDown(corner)}
                      onPointerMove={onPointerMove}
                      onPointerUp={endDrag}
                      onLostPointerCapture={endDrag}
                      onKeyDown={onKeyDown(corner)}
                      style={{ left: `${left * 100}%`, top: `${top * 100}%` }}
                      className={cn(handleClass, "-ml-2 -mt-2", cursor, boxMotionClass)}
                    />
                  );
                })}
              </div>
            </div>

            {/* ── What the site will actually draw ──────────────────────────────────────────── */}
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink-900">On the site</p>
              <p className="mt-0.5 text-xs leading-relaxed text-ink-500">
                The same crop in six of the frames the site draws. A picture only ever lands in some of
                these, so judge the ones it is actually for.
              </p>
              <ul className="mt-2 grid grid-cols-2 gap-x-2 gap-y-2">
                {PREVIEW_FRAMES.map((frame) => (
                  <li key={frame.id} className="min-w-0">
                    <div
                      // Inline, not a Tailwind class: an `aspect-[16/9]` assembled from data would be
                      // purged by the content scanner (contract §5).
                      style={{ aspectRatio: frame.ratio }}
                      className="relative w-full overflow-hidden rounded-md border border-line-200 bg-surface-100"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={src}
                        alt=""
                        aria-hidden="true"
                        style={cropFrameStyle(rect)}
                        className="max-w-none object-cover"
                      />
                    </div>
                    <p className="mt-0.5 text-xs text-ink-500">{frame.label}</p>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/*
            The measurement, before anything is committed. `role="status"` so a reader driving the box
            with the arrow keys is told what they have made once it settles, rather than on every
            single keystroke.
          */}
          <p role="status" className="mt-3 text-sm text-ink-700">
            {cropSentence}
            {pixels && (pixels.width < 640 || pixels.height < 360) ? (
              <span className="text-amber-800">
                {" "}
                That is small enough that it will look soft in a full-width hero. Keep more of the
                picture if this one is going to be used large.
              </span>
            ) : null}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              icon={RotateCcw}
              onClick={() => {
                setAspectId("free");
                setRect(FULL_CROP);
              }}
            >
              Show the whole picture
            </Button>
            <p className="text-xs leading-relaxed text-ink-500">
              <Crop aria-hidden="true" className="mr-1 inline h-3 w-3 align-[-1px]" />
              The file itself is not changed. This only records which part to show, so you can come
              back and choose differently at any time.
            </p>
          </div>
        </>
      )}
    </Dialog>
  );
}
