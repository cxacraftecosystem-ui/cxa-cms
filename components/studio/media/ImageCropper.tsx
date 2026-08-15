"use client";

/**
 * ImageCropper — crop, turn and flip a picture, and save the result as a NEW file.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT NEVER WRITES OVER THE ORIGINAL. THIS IS THE WHOLE DESIGN, NOT A DETAIL.
 *
 * The schema keeps every original upload for ever precisely so that a bad crop is recoverable, and a
 * cropper that overwrites its source is a destructive edit disguised as an adjustment: the moment it
 * saves, the photograph the crop was taken from is gone and no undo can bring it back. So this dialog
 * produces a NEW FILE, which the caller uploads as a new asset; the original keeps its id, its
 * derivatives and every reference to it.
 *
 * NOR IS THE RESULT A `MediaVariant`. The variant rows belong to the derivative pipeline, whose
 * contract is "delete every variant and regenerate is always safe" (prisma/schema.prisma) — a crop
 * filed as a variant would be silently destroyed the next time the pipeline ran, and it would be
 * unreachable in every editor's media picker. A crop is a new asset, which is the only shape that
 * survives a regeneration and can be chosen for a page.
 *
 * THE OUTPUT DIMENSIONS ARE STATED BEFORE ANYTHING IS COMMITTED. A cropper that reveals the size after
 * the fact is a cropper that produces 180px social cards.
 *
 * IT IS KEYBOARD-OPERABLE. The crop box and its four corners are real `<button>`s: arrow keys move the
 * box, arrow keys on a corner resize from that corner, and Shift makes the step ten pixels. Dragging
 * with a pointer is the convenience, not the mechanism.
 *
 * ⚠ READING THE PIXELS NEEDS PERMISSION FROM STORAGE. Drawing an image from another origin into a
 * canvas TAINTS it, and `toBlob()` then throws a SecurityError — so the image is loaded with
 * `crossOrigin="anonymous"`, which means the CDN or bucket must send an `Access-Control-Allow-Origin`
 * header. Without it the load fails outright, and the message below says exactly that rather than
 * leaving somebody to wonder why cropping is broken.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import { Crop, FlipHorizontal, FlipVertical, RotateCw, TriangleAlert } from "lucide-react";

import { mediaSrc } from "@/lib/media/url";
import { clamp, cn, formatBytes } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import type { StudioMediaAsset } from "./MediaGrid";

/**
 * The filename stem for a crop, made safe here rather than borrowed from `safeStem()` in
 * lib/storage/keys.ts — that module imports `node:crypto` and cannot be pulled into a browser bundle.
 * The server slugifies the key it stores in any case; this only has to produce something a person
 * recognises in a download folder.
 */
function safeCropStem(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]*$/, "");
  const slug = withoutExtension
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "picture";
}

/** The longest edge of the preview canvas. Big enough to judge a crop, small enough to stay smooth. */
const PREVIEW_MAX = 620;
/** Nothing useful can be cropped below this, and nothing smaller can be grabbed again to enlarge. */
const MIN_CROP = 16;
/** One arrow press. Shift multiplies it — a pixel at a time is not a gesture. */
const NUDGE = 1;
const NUDGE_FAST = 10;

interface AspectPreset {
  id: string;
  label: string;
  /** Width divided by height. `null` is free. */
  ratio: number | null;
}

/**
 * The presets, with the social card spelled out as its real numbers.
 *
 * 1200 × 630 is the size an Open Graph image is served at (`VARIANT_WIDTHS.og` in lib/media/url.ts), so
 * a crop made at that shape is the one that appears when somebody shares a page.
 */
const ASPECTS: readonly AspectPreset[] = [
  { id: "free", label: "Free — any shape", ratio: null },
  { id: "1-1", label: "Square (1:1)", ratio: 1 },
  { id: "4-3", label: "Landscape (4:3)", ratio: 4 / 3 },
  { id: "16-9", label: "Wide (16:9)", ratio: 16 / 9 },
  { id: "4-5", label: "Portrait (4:5)", ratio: 4 / 5 },
  { id: "og", label: "Social card (1200 × 630)", ratio: 1200 / 630 }
];

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Corner = "nw" | "ne" | "sw" | "se";
type DragKind = "move" | Corner;

interface DragState {
  kind: DragKind;
  startX: number;
  startY: number;
  origin: Rect;
}

export interface ImageCropperProps {
  open: boolean;
  /** The image being cropped. Nothing is ever written back to it. */
  asset: StudioMediaAsset | null;
  onClose: () => void;
  /**
   * The finished crop, as a file ready to upload. The caller uploads it — the new asset belongs to the
   * caller's list, and this dialog has no business knowing where that is.
   */
  onCropped: (file: File, output: { width: number; height: number }) => void | Promise<void>;
}

/** The size of the picture AFTER turning it, which is the space the crop lives in. */
function outputSize(
  natural: { width: number; height: number },
  rotation: number
): { width: number; height: number } {
  return rotation % 180 === 0
    ? { width: natural.width, height: natural.height }
    : { width: natural.height, height: natural.width };
}

/** The largest crop of `ratio` that fits inside `space`, centred. `null` means the whole thing. */
function fitRect(space: { width: number; height: number }, ratio: number | null): Rect {
  if (ratio === null) return { x: 0, y: 0, width: space.width, height: space.height };
  let width = space.width;
  let height = width / ratio;
  if (height > space.height) {
    height = space.height;
    width = height * ratio;
  }
  return {
    x: Math.round((space.width - width) / 2),
    y: Math.round((space.height - height) / 2),
    width: Math.round(width),
    height: Math.round(height)
  };
}

/** Keep a rect inside its space, honouring the aspect if one is locked. */
function constrain(rect: Rect, space: { width: number; height: number }, ratio: number | null): Rect {
  let width = clamp(rect.width, MIN_CROP, space.width);
  let height = clamp(rect.height, MIN_CROP, space.height);

  if (ratio !== null) {
    // The width leads, and the height follows — unless that would push the box out of the picture, in
    // which case the height leads instead. Doing it the other way round lets a locked ratio drift.
    height = width / ratio;
    if (height > space.height) {
      height = space.height;
      width = height * ratio;
    }
  }

  const x = clamp(rect.x, 0, Math.max(0, space.width - width));
  const y = clamp(rect.y, 0, Math.max(0, space.height - height));
  return { x, y, width, height };
}

export function ImageCropper({ open, asset, onClose, onCropped }: ImageCropperProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [rotation, setRotation] = useState(0);
  const [flipX, setFlipX] = useState(false);
  const [flipY, setFlipY] = useState(false);
  const [aspectId, setAspectId] = useState("free");
  const [crop, setCrop] = useState<Rect | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const source = asset ? mediaSrc(asset, 2560) : null;
  const ratio = ASPECTS.find((entry) => entry.id === aspectId)?.ratio ?? null;

  const space = useMemo(
    () => (natural ? outputSize(natural, rotation) : null),
    [natural, rotation]
  );

  const scale = space ? Math.min(PREVIEW_MAX / space.width, PREVIEW_MAX / space.height, 1) : 1;

  // ── Loading the pixels ────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;

    setLoaded(false);
    setLoadError(null);
    setNatural(null);
    setCrop(null);
    setRotation(0);
    setFlipX(false);
    setFlipY(false);
    setAspectId("free");
    setSaveError(null);

    if (!asset) return;
    if (!source) {
      setLoadError(
        "There is no public web address for this file, so the browser cannot load its pixels. A CDN or public storage address has to be configured before pictures can be cropped here."
      );
      return;
    }

    let cancelled = false;
    const image = new Image();
    // Load it as a cross-origin request so the canvas is not tainted and `toBlob()` will work. If
    // storage does not allow this site, the load FAILS rather than succeeding-but-unreadable — which is
    // the better failure, because it happens before any work is done.
    image.crossOrigin = "anonymous";

    image.onload = () => {
      if (cancelled) return;
      imageRef.current = image;
      setNatural({ width: image.naturalWidth, height: image.naturalHeight });
      setLoaded(true);
    };
    image.onerror = () => {
      if (cancelled) return;
      setLoadError(
        "The browser was not allowed to read this picture. Cropping needs the file store to permit this site to read images directly — an administrator can add the site's address to the storage bucket's allowed origins. Nothing has been changed."
      );
    };
    image.src = source;

    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
    };
  }, [open, asset, source]);

  // A fresh crop whenever the shape of the space or the locked ratio changes. Keeping the old rectangle
  // across a turn would leave a box hanging outside the picture.
  useEffect(() => {
    if (!space) return;
    setCrop(fitRect(space, ratio));
  }, [space, ratio]);

  // ── Drawing ───────────────────────────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image || !space || !natural) return;

    canvas.width = Math.max(1, Math.round(space.width * scale));
    canvas.height = Math.max(1, Math.round(space.height * scale));

    const context = canvas.getContext("2d");
    if (!context) return;

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.scale(scale, scale);
    // The flip is applied to the ALREADY-TURNED picture, because "flip horizontal" has to mean "mirror
    // what I can see". Canvas applies these to the drawn image in reverse, so the mirror is written
    // before the rotation here in order to happen after it on screen.
    context.translate(space.width / 2, space.height / 2);
    context.scale(flipX ? -1 : 1, flipY ? -1 : 1);
    context.rotate((rotation * Math.PI) / 180);
    context.drawImage(image, -natural.width / 2, -natural.height / 2, natural.width, natural.height);
    context.restore();
  }, [space, natural, scale, rotation, flipX, flipY]);

  useEffect(() => {
    if (loaded) draw();
  }, [loaded, draw]);

  // ── Moving and resizing ───────────────────────────────────────────────────────────────────────
  const applyDrag = (kind: DragKind, origin: Rect, dx: number, dy: number): Rect => {
    if (!space) return origin;

    if (kind === "move") {
      return constrain({ ...origin, x: origin.x + dx, y: origin.y + dy }, space, ratio);
    }

    // A corner drag moves two edges. The far corner stays put, which is what makes the gesture feel
    // like a resize rather than a move.
    const right = origin.x + origin.width;
    const bottom = origin.y + origin.height;

    if (kind === "se") {
      return constrain({ ...origin, width: origin.width + dx, height: origin.height + dy }, space, ratio);
    }
    if (kind === "sw") {
      const width = origin.width - dx;
      const next = constrain({ ...origin, width, height: origin.height + dy }, space, ratio);
      return { ...next, x: clamp(right - next.width, 0, Math.max(0, space.width - next.width)) };
    }
    if (kind === "ne") {
      const height = origin.height - dy;
      const next = constrain({ ...origin, width: origin.width + dx, height }, space, ratio);
      return { ...next, y: clamp(bottom - next.height, 0, Math.max(0, space.height - next.height)) };
    }
    // "nw"
    const next = constrain(
      { ...origin, width: origin.width - dx, height: origin.height - dy },
      space,
      ratio
    );
    return {
      ...next,
      x: clamp(right - next.width, 0, Math.max(0, space.width - next.width)),
      y: clamp(bottom - next.height, 0, Math.max(0, space.height - next.height))
    };
  };

  const onPointerDown = (kind: DragKind) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!crop) return;
    // Both: the corner handles sit inside the crop box, which is itself a button, so without these a
    // corner drag would also start a move.
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { kind, startX: event.clientX, startY: event.clientY, origin: crop };
    // Capture, so a drag that leaves the canvas — which is most of them — keeps sending moves.
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = (event.clientX - drag.startX) / scale;
    const dy = (event.clientY - drag.startY) / scale;
    setCrop(applyDrag(drag.kind, drag.origin, dx, dy));
  };

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onKeyDown = (kind: DragKind) => (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!crop) return;
    const step = event.shiftKey ? NUDGE_FAST : NUDGE;
    let dx = 0;
    let dy = 0;
    if (event.key === "ArrowLeft") dx = -step;
    else if (event.key === "ArrowRight") dx = step;
    else if (event.key === "ArrowUp") dy = -step;
    else if (event.key === "ArrowDown") dy = step;
    else return;

    // Otherwise the arrow keys scroll the dialog out from under the reader.
    event.preventDefault();
    event.stopPropagation();
    setCrop(applyDrag(kind, crop, dx, dy));
  };

  // ── Committing ────────────────────────────────────────────────────────────────────────────────
  const outputWidth = crop ? Math.max(1, Math.round(crop.width)) : 0;
  const outputHeight = crop ? Math.max(1, Math.round(crop.height)) : 0;

  const commit = async () => {
    const image = imageRef.current;
    if (!image || !crop || !space || !natural || !asset || busy) return;

    setBusy(true);
    setSaveError(null);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = outputWidth;
      canvas.height = outputHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser could not prepare the picture for saving.");

      // The same transform as the preview, shifted so the crop's top-left corner lands on the origin.
      context.translate(-crop.x, -crop.y);
      context.translate(space.width / 2, space.height / 2);
      context.scale(flipX ? -1 : 1, flipY ? -1 : 1);
      context.rotate((rotation * Math.PI) / 180);
      context.drawImage(image, -natural.width / 2, -natural.height / 2, natural.width, natural.height);

      // PNG in, PNG out. Re-encoding a diagram or a logo as WebP throws away exactly the sharp edges
      // it was chosen for; a photograph loses nothing worth keeping at this quality.
      const png = asset.mimeType === "image/png";
      const type = png ? "image/png" : "image/webp";
      const extension = png ? "png" : "webp";

      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((result) => resolve(result), type, png ? undefined : 0.92);
      });

      if (!blob) {
        throw new Error(
          "The browser could not produce the cropped picture. This usually means the image is larger than it can hold in memory — try again on a desktop machine."
        );
      }

      const file = new File(
        [blob],
        `${safeCropStem(asset.fileName)}-crop-${outputWidth}x${outputHeight}.${extension}`,
        { type }
      );

      await onCropped(file, { width: outputWidth, height: outputHeight });
      onClose();
    } catch (thrown) {
      setSaveError(
        thrown instanceof Error
          ? thrown.message
          : "The cropped picture could not be saved. Nothing has been changed."
      );
    } finally {
      setBusy(false);
    }
  };

  const boxStyle = crop
    ? {
        left: `${crop.x * scale}px`,
        top: `${crop.y * scale}px`,
        width: `${crop.width * scale}px`,
        height: `${crop.height * scale}px`
      }
    : undefined;

  const handleClass =
    "absolute h-4 w-4 touch-none rounded-sm border border-white bg-purple-700 focus-visible:ring-4 focus-visible:ring-purple-600/15";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Crop a copy"
      description="This makes a new picture and leaves the original exactly as it is."
      size="lg"
      footer={
        <>
          <button type="button" data-dialog-cancel onClick={onClose} className="field-button-secondary">
            Cancel
          </button>
          <Button
            icon={Crop}
            isLoading={busy}
            loadingLabel="saving the crop"
            disabled={!loaded || crop === null}
            onClick={() => void commit()}
          >
            Save as a new file
          </Button>
        </>
      }
    >
      {loadError ? (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-md border border-error-200 bg-error-100 px-3 py-2.5 text-sm leading-relaxed text-error-700"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{loadError}</span>
        </p>
      ) : null}

      {!loadError && !loaded ? (
        <div>
          <span role="status" className="sr-only">
            Loading the picture…
          </span>
          <div aria-hidden="true" className="skeleton aspect-video w-full" />
        </div>
      ) : null}

      {loaded && crop && space ? (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Shape" className="w-full sm:w-64">
              <Select
                value={aspectId}
                onChange={(event) => setAspectId(event.target.value)}
                options={ASPECTS.map((entry) => ({ value: entry.id, label: entry.label }))}
              />
            </Field>

            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                variant="secondary"
                icon={RotateCw}
                onClick={() => setRotation((current) => (current + 90) % 360)}
              >
                Turn right
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon={FlipHorizontal}
                onClick={() => setFlipX((current) => !current)}
              >
                {flipX ? "Undo mirror" : "Mirror"}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon={FlipVertical}
                onClick={() => setFlipY((current) => !current)}
              >
                {flipY ? "Undo upside down" : "Upside down"}
              </Button>
            </div>
          </div>

          <div className="mt-3 flex justify-center rounded-md border border-line-200 bg-surface-100 p-3">
            <div className="relative inline-block">
              <canvas ref={canvasRef} className="block max-w-full rounded-sm" />

              {/*
                The crop box is a real `<button>`, so it is focusable, announced, and driven by the arrow
                keys. `touch-none` stops a drag on a touchscreen scrolling the dialog instead.
              */}
              <button
                type="button"
                aria-label={`Crop area — ${outputWidth} by ${outputHeight} pixels. Use the arrow keys to move it, and hold Shift to move further.`}
                onPointerDown={onPointerDown("move")}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onLostPointerCapture={endDrag}
                onKeyDown={onKeyDown("move")}
                style={boxStyle}
                className="absolute cursor-move touch-none border-2 border-purple-700 bg-purple-600/10 focus-visible:ring-4 focus-visible:ring-purple-600/15"
              />

              {/* The four corners, each resizing from itself. Outside the box element so they are not
                  nested buttons, positioned from the same rectangle. */}
              {(
                [
                  { corner: "nw", label: "top left" },
                  { corner: "ne", label: "top right" },
                  { corner: "sw", label: "bottom left" },
                  { corner: "se", label: "bottom right" }
                ] as readonly { corner: Corner; label: string }[]
              ).map(({ corner, label }) => {
                const left =
                  corner === "nw" || corner === "sw" ? crop.x * scale : (crop.x + crop.width) * scale;
                const top =
                  corner === "nw" || corner === "ne" ? crop.y * scale : (crop.y + crop.height) * scale;
                return (
                  <button
                    key={corner}
                    type="button"
                    aria-label={`Resize the crop from the ${label} corner. Use the arrow keys, and hold Shift to move further.`}
                    onPointerDown={onPointerDown(corner)}
                    onPointerMove={onPointerMove}
                    onPointerUp={endDrag}
                    onLostPointerCapture={endDrag}
                    onKeyDown={onKeyDown(corner)}
                    style={{ left: `${left - 8}px`, top: `${top - 8}px` }}
                    className={cn(handleClass, "cursor-nwse-resize")}
                  />
                );
              })}
            </div>
          </div>

          {/*
            The size, before anything is committed. `role="status"` so a reader driving the box with the
            arrow keys is told what they have made, once it settles.
          */}
          <p role="status" className="mt-3 text-sm text-ink-700">
            The new picture will be{" "}
            <span className="font-semibold tabular-nums">
              {outputWidth} × {outputHeight}
            </span>{" "}
            pixels
            {aspectId === "og" && (outputWidth < 1200 || outputHeight < 630) ? (
              <span className="text-amber-800">
                {" "}
                — smaller than the 1200 × 630 a social card is shown at, so it will be stretched a
                little. Crop a larger area if you can.
              </span>
            ) : null}
            .
          </p>

          <p className="mt-1.5 text-xs leading-relaxed text-ink-500">
            The original {asset ? `(${formatBytes(asset.byteSize)})` : ""} is kept exactly as it is, so
            you can come back and crop it differently at any time. The new picture is added to the
            library as a file of its own.
          </p>

          {saveError ? (
            <p
              role="alert"
              className="mt-3 flex items-start gap-1.5 rounded-md border border-error-200 bg-error-100 px-3 py-2.5 text-sm leading-relaxed text-error-700"
            >
              <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{saveError}</span>
            </p>
          ) : null}
        </>
      ) : null}
    </Dialog>
  );
}
