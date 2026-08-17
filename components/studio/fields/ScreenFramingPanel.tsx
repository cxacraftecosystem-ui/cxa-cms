"use client";

/**
 * ScreenFramingPanel — frame one picture differently at each screen size.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IT IS FOR. A hero is drawn full-bleed, so the same photograph lands in a frame of roughly 0.5:1
 * on a phone and 2.5:1 on a wide desktop. One rectangle cannot be right for both, and until this existed
 * the editor was being asked one question that had six different answers. Each row here is one of those
 * answers: which part of the picture, and optionally which picture, at that width.
 *
 * ⚠ THE PREVIEW USES THE RENDERER'S OWN GEOMETRY, AND THAT IS THE POINT OF THE WHOLE DESIGN. Each row
 * draws its thumbnail through `resolvePicture` and `cropFrameStyle` — the same resolver and the same
 * function `components/ui/MediaImage.tsx` uses on the public page. So a row that looks right IS right.
 * The alternative, a panel that re-implements the cascade for display, is exactly how the studio and the
 * site come to disagree, and how the single crop shipped stored-but-never-rendered.
 *
 * ⚠ NOTHING IS REQUIRED, AND THE PANEL HAS TO LOOK THAT WAY. One photograph is used at every width
 * unless a bucket says otherwise; a bucket left alone inherits from the next smaller one that was set,
 * and the smallest falls back to the photograph's own crop. So this is SUPPLEMENTARY, and it stays shut
 * until somebody opens it — six rows sitting open under every picture in the studio reads as six things
 * that need filling in, which is how a control nobody needs becomes a control everybody dreads. It
 * starts open only when a framing already exists, because a setting that is in force must be visible
 * without hunting for it.
 *
 * ⚠ INHERITED AND DELIBERATE ARE SHOWN AS DIFFERENT THINGS. A row says where its framing came from,
 * because "this looks like the phone crop" and "this IS the phone crop, because nobody set this size"
 * are different facts and only the second one has a remedy. The whole picture is a real answer too — see
 * `wholeImageIsAChoice` on the cropper — so "show all of it on desktop" survives a save.
 *
 * IT WORKS FROM THE KEYBOARD. Every control is a real `<button>` or a real input, the per-bucket
 * photograph picker is a disclosure with `aria-expanded`, and every change is announced — a panel that
 * silently re-framed itself tells a reader who cannot see it nothing at all (RepeaterField, decision 1).
 *
 * ⚠ IT DOES NOT PATCH ANYTHING. The three existing cropper callers PATCH the asset row the moment the
 * dialog closes, because a file's crop belongs to the file. A per-screen override belongs to the BLOCK,
 * so this hands the value up through `onChange` and rides the host form's autosave (contract §10). One
 * dialog with two commit semantics is the thing to avoid.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useId, useMemo, useState } from "react";
import { ChevronDown, Crop, ImageIcon, RotateCcw } from "lucide-react";

import { lookupResolvePath, EntityPicker, type LookupResponse } from "@/components/studio/fields/EntityPicker";
import { HelpText } from "@/components/studio/HelpText";
import { ImageCropper, type CropChoice } from "@/components/studio/ImageCropper";
import { Button } from "@/components/ui/Button";
import { useResource } from "@/lib/client/useResource";
import { cropFrameStyle, storedCrop, FULL_CROP } from "@/lib/media/crop";
import {
  SCREEN_BUCKETS,
  emptyScreenFraming,
  isEmptyScreenFraming,
  resolvePicture,
  screenBucketLabel,
  screenFramingMediaIds,
  setBucket,
  type ScreenBucketId,
  type ScreenFraming
} from "@/lib/media/screens";
import { mediaSrc, type MediaLike } from "@/lib/media/url";
import { cn } from "@/lib/utils";

export interface ScreenFramingPanelProps {
  label: string;
  help?: string;
  /** The block's main photograph. Empty means none chosen — the panel then explains rather than offering. */
  mediaId: string;
  value: ScreenFraming | null;
  onChange: (next: ScreenFraming | null) => void;
}

/** The shape each row previews in. Wide, because the surface this serves first is a full-bleed hero. */
const PREVIEW_ASPECT = "16 / 9";

export function ScreenFramingPanel({ label, help, mediaId, value, onChange }: ScreenFramingPanelProps) {
  const [cropping, setCropping] = useState<ScreenBucketId | null>(null);
  const [picking, setPicking] = useState<ScreenBucketId | null>(null);
  const [announcement, setAnnouncement] = useState("");
  /**
   * A generated id, not a literal. Two of these panels on one screen — a block with a foreground and a
   * background picture, say — would otherwise share one heading id, and `aria-labelledby` would point
   * both regions at whichever came first.
   */
  const headingId = useId();

  /**
   * Shut unless a framing already exists. See the header: this is supplementary, and six rows sitting
   * open under every picture reads as six things that need filling in.
   */
  const [open, setOpen] = useState(!isEmptyScreenFraming(value));
  /**
   * ⚠ THE SAME PREDICATE `isEmptyScreenFraming` USES, and it has to be. Judging a bucket "set" by
   * `cropX !== null` while the emptiness test judges by `storedCrop` — all four columns — would let a
   * bucket carrying three of the four numbers count as set here and empty there, so the summary would
   * read "1 of 6 set" under a heading that also said nothing was set.
   */
  const setCount = SCREEN_BUCKETS.filter((bucket) => {
    const entry = value?.[bucket.id];
    return Boolean(entry && (entry.mediaId !== null || storedCrop(entry) !== null));
  }).length;

  /**
   * Every photograph this panel needs: the base one, plus any a bucket names.
   *
   * Resolved through the SAME endpoint `EntityPicker` uses, so the rows carry the crop columns and the
   * variants — without the variants a 4000px original would be fetched into a 200px thumbnail six times.
   * `lookupResolvePath` sorts the ids, so re-ordering cannot cause a re-fetch.
   */
  const ids = useMemo(() => {
    const all = new Set<string>();
    if (mediaId.length > 0) all.add(mediaId);
    for (const id of screenFramingMediaIds(value)) all.add(id);
    return [...all];
  }, [mediaId, value]);

  const { data } = useResource<LookupResponse>(lookupResolvePath("media", ids));

  const assets = useMemo(() => {
    const map = new Map<string, MediaLike>();
    for (const item of data?.items ?? []) {
      if (item.media) map.set(item.id, item.media);
    }
    return map;
  }, [data]);

  const base = mediaId.length > 0 ? (assets.get(mediaId) ?? null) : null;

  /**
   * The resolved bands, indexed by bucket.
   *
   * `resolvePicture` COLLAPSES bands that draw the same thing — right for the renderer, which wants the
   * fewest possible CSS rules, and wrong for a panel that needs one row per bucket whether or not it
   * differs from the row above.
   *
   * So the collapse is undone here, by walking the buckets and carrying the last band at or below each
   * one. Undoing it costs six iterations; the alternative — a second resolver that does not collapse — is
   * two implementations of the cascade, and the first time they disagreed the panel would show an editor
   * a framing the site does not draw. One resolver is the property worth protecting.
   */
  const bands = useMemo(() => {
    const picture = resolvePicture(base, value, (id) => assets.get(id) ?? null);
    if (!picture) return null;
    const byBucket = new Map<ScreenBucketId, (typeof picture)[number]>();
    let current = picture[0];
    for (const bucket of SCREEN_BUCKETS) {
      const exact = picture.find((band) => band.bucket === bucket.id);
      if (exact) current = exact;
      byBucket.set(bucket.id, current);
    }
    return byBucket;
  }, [base, value, assets]);

  const framing = value ?? emptyScreenFraming();

  const apply = (bucket: ScreenBucketId, patch: Partial<ScreenFraming[ScreenBucketId]>, said: string) => {
    const next = setBucket(framing, bucket, { ...framing[bucket], ...patch });
    // Six untouched buckets are stored as `null`, not as six empty objects — see the schema's note.
    onChange(isEmptyScreenFraming(next) ? null : next);
    setAnnouncement(said);
  };

  if (mediaId.length === 0) {
    return (
      <section aria-labelledby={headingId} className="rounded-md border border-line-200 bg-surface-50 p-3">
        <h3 id={headingId} className="font-display text-sm font-semibold text-ink-900">
          {label}
        </h3>
        <HelpText className="mt-1">
          Choose the picture above first. Framing it per screen size is a decision about a photograph, so
          there is nothing to set until there is one.
        </HelpText>
      </section>
    );
  }

  return (
    <section aria-labelledby={headingId} className="rounded-md border border-line-200 bg-surface-50 p-3">
      {/*
        A real <button> with `aria-expanded`, not a <details>. `<details>` would work and read correctly,
        but its open state is DOM-owned rather than React-owned, so it and `startOpen` would disagree the
        moment a framing was cleared — and the panel would sit open showing six inherited rows with
        nothing to look at.
      */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 rounded text-left focus-visible:ring-2 focus-visible:ring-purple-600/30"
      >
        <Crop aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-ink-500" />
        <span id={headingId} className="font-display text-sm font-semibold text-ink-900">
          {label}
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-ink-500">
          {/*
            The state in words, so an editor can tell at a glance whether anything is in force without
            opening it. "Not set" is the common case and it is not a warning.
          */}
          {isEmptyScreenFraming(value) ? "Not set — one picture at every size" : `${setCount} of 6 set`}
          <ChevronDown
            aria-hidden="true"
            className={cn("h-4 w-4 shrink-0 transition-transform", open && "rotate-180")}
          />
        </span>
      </button>

      {help && open ? <HelpText className="mt-2">{help}</HelpText> : null}

      {/* Mounted in both states so the region is registered before its content ever changes. */}
      <span role="status" className="sr-only">
        {announcement}
      </span>

      <ul className={cn("mt-3 space-y-2", !open && "hidden")}>
        {SCREEN_BUCKETS.map((bucket) => {
          const band = bands?.get(bucket.id) ?? null;
          const override = framing[bucket.id];
          const setHere = override.cropX !== null || override.mediaId !== null;
          const inheritedFrom = band && band.cropFrom !== bucket.id ? band.cropFrom : null;
          const photographFrom = band && band.mediaFrom !== bucket.id ? band.mediaFrom : null;
          const src = band ? mediaSrc(band.media, 640) : null;

          return (
            <li
              key={bucket.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-line-200 bg-card p-2"
            >
              {/*
                The preview. `cropFrameStyle` is the renderer's own geometry, so this is what the page
                will draw rather than an impression of it. A plain <img>, not MediaImage: the source is
                already resolved for this band and the frame here is the panel's, not the site's.
              */}
              <span
                style={{ aspectRatio: PREVIEW_ASPECT }}
                className="relative block w-28 shrink-0 overflow-hidden rounded-sm border border-line-200 bg-surface-100"
              >
                {src ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={src}
                    alt=""
                    aria-hidden="true"
                    style={cropFrameStyle(band?.crop ?? FULL_CROP)}
                    className="max-w-none object-cover"
                  />
                ) : null}
              </span>

              <span className="min-w-[10rem] flex-1">
                <span className="block text-sm font-medium text-ink-900">{screenBucketLabel(bucket.id)}</span>
                <span className="mt-0.5 block text-xs text-ink-500">
                  {setHere
                    ? "Framed for this size"
                    : inheritedFrom
                      ? `Inherited from ${labelOf(inheritedFrom)}`
                      : "The picture's own crop"}
                  {photographFrom && photographFrom !== "base"
                    ? ` · photograph from ${labelOf(photographFrom)}`
                    : null}
                  {override.mediaId ? " · a different photograph" : null}
                </span>
              </span>

              <span className="flex shrink-0 flex-wrap items-center gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  icon={Crop}
                  onClick={() => setCropping(bucket.id)}
                  disabled={!band}
                >
                  {setHere ? "Change framing" : "Frame this size"}
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  icon={ImageIcon}
                  aria-expanded={picking === bucket.id}
                  onClick={() => setPicking(picking === bucket.id ? null : bucket.id)}
                >
                  Different photograph
                </Button>

                {setHere ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    icon={RotateCcw}
                    onClick={() =>
                      apply(
                        bucket.id,
                        { mediaId: null, cropX: null, cropY: null, cropWidth: null, cropHeight: null, cropAspect: null },
                        `${screenBucketLabel(bucket.id)} now inherits its framing.`
                      )
                    }
                  >
                    Clear
                  </Button>
                ) : null}
              </span>

              {/*
                Mounted only while open. Six pickers rendered eagerly would be six lookups and six
                comboboxes in the tab order for a control most editors never touch.
              */}
              {picking === bucket.id ? (
                <span className="w-full">
                  <EntityPicker
                    kind="media"
                    max={1}
                    label={`Photograph for ${screenBucketLabel(bucket.id)}`}
                    help="Leave empty to use the picture chosen above. A different photograph starts from its own crop, because a rectangle drawn on one picture means nothing on another."
                    ids={override.mediaId ? [override.mediaId] : []}
                    onChange={(next) => {
                      const chosen = next[0] ?? null;
                      apply(
                        bucket.id,
                        // A new photograph clears this bucket's rectangle: it was fractions of a
                        // different picture, and carried across it frames whatever happens to be there.
                        { mediaId: chosen, cropX: null, cropY: null, cropWidth: null, cropHeight: null, cropAspect: null },
                        chosen
                          ? `${screenBucketLabel(bucket.id)} now uses a different photograph.`
                          : `${screenBucketLabel(bucket.id)} is back to the main photograph.`
                      );
                    }}
                  />
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>

      {cropping && bands?.get(cropping) ? (
        <ImageCropper
          open
          onClose={() => setCropping(null)}
          src={mediaSrc(bands.get(cropping)!.media, 1600)}
          fileName={screenBucketLabel(cropping)}
          initialRect={bands.get(cropping)!.crop}
          initialAspectId={framing[cropping].cropAspect ?? undefined}
          /**
           * ⚠ THE WHOLE PICTURE IS A REAL ANSWER HERE. For a file, "no crop" and "all of it" are the
           * same statement; for a bucket they are not, because null means INHERIT. Without this the
           * editor sets "show all of it on desktop", the dialog collapses it to null, and the row springs
           * back to the phone's tight crop with nothing to say why.
           */
          wholeImageIsAChoice
          note={
            <>
              This framing applies to {screenBucketLabel(cropping).toLowerCase()} and to every larger size
              that has not been framed itself. It is stored on this block, so no other page using the same
              photograph is affected.
            </>
          }
          onApply={(choice: CropChoice | null) => {
            const bucket = cropping;
            if (choice) {
              apply(
                bucket,
                {
                  cropX: choice.rect.x,
                  cropY: choice.rect.y,
                  cropWidth: choice.rect.width,
                  cropHeight: choice.rect.height,
                  cropAspect: choice.aspectId
                },
                `${screenBucketLabel(bucket)} framed to ${Math.round(choice.rect.width * 100)}% by ${Math.round(choice.rect.height * 100)}% of the picture.`
              );
            } else {
              apply(
                bucket,
                { cropX: null, cropY: null, cropWidth: null, cropHeight: null, cropAspect: null },
                `${screenBucketLabel(bucket)} now inherits its framing.`
              );
            }
            setCropping(null);
          }}
        />
      ) : null}
    </section>
  );
}

/** A bucket's device name on its own — "Inherited from Tablets" reads better than the full range. */
function labelOf(id: ScreenBucketId): string {
  return SCREEN_BUCKETS.find((bucket) => bucket.id === id)?.label ?? id;
}
