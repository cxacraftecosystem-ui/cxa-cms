"use client";

/**
 * PickerUpload — upload a document or a picture from inside the picker that is asking for one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE HOLE THIS CLOSES. `EntityPicker` could only ever offer a list of things somebody had already
 * uploaded somewhere else. So an editor writing a publication, with the PDF in front of them, had to
 * abandon the form, find the file library, upload, come back, and search for what they had just added —
 * and an autosaving form abandoned mid-edit is the one journey most likely to lose work. The same was
 * true of a DOCUMENT_EMBED block on a page or a template, whose own help text said "Upload it there
 * first", naming a screen it could not link to.
 *
 * ⚠ IT UPLOADS INTO TWO DIFFERENT TABLES AND THE CHOICE IS NOT COSMETIC. The distinction is the one
 * `documentEmbedSectionSchema` sets out at length:
 *
 *   • `media` → a `MediaAsset`, served straight off the object store with its stored `Content-Type` and
 *     no `Content-Disposition`. That is the ONLY one of the two a browser will render IN PLACE, which is
 *     why an embedded document must be one.
 *   • `file` → a `FileAsset`, served by `/api/public/files/[slug]` which 302s to a signed URL carrying
 *     `Content-Disposition: attachment`. A browser handed that SAVES it. Right for a dataset or a report
 *     meant to be downloaded and counted; useless inside an `<iframe>`.
 *
 * A picker asking for one must not quietly upload into the other, so the table follows `kind` and is
 * never a setting.
 *
 * ⚠ THE TITLE IS THE FILE'S OWN NAME, AND THAT IS DELIBERATE RATHER THAN LAZY. A `FileAsset` needs a
 * title, and asking for one here would put a second form inside a form that is already autosaving — two
 * things to fill in, one of which blocks the upload. "annual-report-2026.pdf" is a worse title than a
 * human would write and a far better one than an empty required field, and the file library is where it
 * is renamed. The slug is derived there once and then left alone, so a rename never breaks the public
 * download address.
 *
 * ⚠ A PICTURE IS OFFERED A CROP ONCE IT HAS LANDED, AND THIS USED TO BE THE ONE UPLOAD THAT WAS NOT.
 * Every other way a picture enters this studio — the library's `UploadQueue`, the `MediaPicker` an
 * author opens to choose a cover, `MediaDetailPanel` for an asset already stored — opens
 * `components/studio/ImageCropper` and writes the same five columns. Uploading from inside a picker did
 * not, so an editor adding a video's poster frame got no preview of what they had just sent and no way
 * to say which part of it to show. That is not a neutral omission: `MediaImage` draws every asset
 * `object-cover` inside whatever shape the surface asked for, so "no choice" means trimmed from the
 * centre, which is the wrong guess for most photographs of a person or an object. The dialog is REUSED
 * rather than reimplemented — same component, same endpoint, same columns, same degradation rules.
 *
 * ⚠ IT HANDS BACK AN ID AND NOTHING ELSE. The picker adds that id to its own selection and resolves it
 * through the same lookup every other chip goes through, so an uploaded item and a searched one are the
 * same thing by the time they are on screen. Anything else would be a second code path for displaying a
 * chosen record, and the first time the two disagreed the editor would see a chip that vanished on
 * reload.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Crop, Upload } from "lucide-react";

import { asApiClientError, patch, post } from "@/lib/client/fetcher";
import { FILE_CREATE_PATH, uploadToFileStore } from "@/lib/client/fileUpload";
import {
  ACCEPTED_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  UploadError,
  kindForContentType,
  summariseFailures,
  uploadFiles,
  type MediaKindName,
  type UploadedMediaAsset
} from "@/lib/client/upload";
import { formatBytes } from "@/lib/utils";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { HelpText } from "@/components/studio/HelpText";
import { ImageCropper, storedCrop, type CropChoice } from "@/components/studio/ImageCropper";
import { MEDIA_ENDPOINTS, type StudioMediaAsset } from "@/components/studio/media/MediaGrid";

/** The two picker kinds that have an upload path behind them. */
export type UploadableKind = "file" | "media";

/** Which media files a `kind="media"` upload offers. Ignored for `kind="file"`, which takes anything. */
export type UploadableMediaKind = Extract<MediaKindName, "DOCUMENT" | "VIDEO" | "IMAGE">;

export interface PickerUploadProps {
  kind: UploadableKind;
  /**
   * Which media files the chooser offers, for `kind="media"`.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * ⚠ IT DEFAULTS TO `DOCUMENT`, WHICH IS WHAT THIS COMPONENT USED TO DO AND ONLY DO. The paragraph
   * below the accept list explains why: the one picker that offered an upload was the DOCUMENT_EMBED
   * block's, and offering images there would have let an editor put a PNG into a field labelled "The
   * document".
   *
   * `VIDEO` exists because the EMBED block now has an `upload` provider whose entire purpose is a film
   * of up to 200 MB, and sending an editor to the media library to put it there first is exactly the
   * abandoned-form journey this component was written to remove. The same argument, the same answer.
   *
   * ⚠ THE FILTER IS STILL DERIVED FROM `ACCEPTED_CONTENT_TYPES`, NEVER WRITTEN OUT. A hand-written
   * per-kind list is the third copy the note below refuses; the kind is the only thing that varies.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  mediaKind?: UploadableMediaKind;
  /** The new record's id. The picker adds it to its selection and resolves it like any other. */
  onUploaded: (id: string) => void;
  /**
   * Why uploading is not available right now — the selection is full, say.
   *
   * A SENTENCE RATHER THAN A BOOLEAN: a control that is simply dead tells the reader nothing, and this
   * is the same rule the picker's own rows follow (contract §10).
   */
  unavailable?: string | null;
}

/**
 * The `accept` filter for a media upload, DERIVED rather than written out.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ A HAND-WRITTEN LIST HERE IS A LIST THAT DISAGREES WITH THE SERVER, and the first version of this file
 * managed to be wrong in both directions at once. It offered `.odt` and `.odp`, which
 * `app/api/studio/media/presign` refuses — so the chooser would happily accept a file and the upload would
 * then fail on a format the studio had just invited — and it left out `.xlsx`, `.csv` and `.txt`, which the
 * server does accept, so the chooser hid files that would have worked.
 *
 * ⚠ AND IT REMOVES A THIRD COPY RATHER THAN CREATING A SINGLE SOURCE, which is worth stating precisely
 * because the stronger claim would be false. `app/api/studio/media/presign/route.ts` keeps its OWN
 * `ALLOWED_CONTENT_TYPES`, because this module is `"use client"` and a route handler cannot import it; its
 * header says it is "in step with `CONTENT_TYPE_KINDS`" and that is maintained by hand. So there are two
 * tables and they can still drift from each other. What deriving buys is that the CHOOSER can no longer
 * drift from either independently — a hand-written third list was the copy nobody would have thought to
 * update. `accept` takes MIME types directly, so there is no translation step to get wrong either.
 *
 * FILTERED BY KIND, because a media picker that offers an upload is always asking for one PARTICULAR
 * sort of thing — a document for the DOCUMENT_EMBED block, a film for the EMBED block's `upload`
 * provider. A picture is normally chosen through `MediaPicker`, which uploads already and additionally
 * names the file and warns about missing alt text; offering everything here would let an editor put a
 * PNG into a field whose own label reads "The document".
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
function mediaAcceptFor(mediaKind: UploadableMediaKind): string {
  return ACCEPTED_CONTENT_TYPES.filter(
    (contentType) => kindForContentType(contentType) === mediaKind
  ).join(",");
}

/** What each media kind is called, and what an editor is told about where it goes. */
const MEDIA_NOUN: Record<UploadableMediaKind, { one: string; hint: string }> = {
  DOCUMENT: {
    one: "document",
    hint: "It is added to the media library, which is what a document embedded on a page has to come from."
  },
  VIDEO: {
    one: "video",
    hint: "It is added to the media library and played by this site's own player."
  },
  IMAGE: {
    one: "picture",
    hint: "It is added to the media library. Its description for screen readers is written there."
  }
};

/**
 * A file the browser could not name, renamed by its extension.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ IT EXISTS FOR SUBTITLE FILES AND FOR NOTHING ELSE, AND WITHOUT IT THEY CANNOT BE UPLOADED AT ALL.
 * A browser fills `File.type` from the operating system's own registry, and `.vtt` is registered on
 * almost no desktop — so Windows and most Linux desktops hand over an EMPTY content type. Every layer
 * below reads that value: `kindForContentType("")` is null, `precheck` refuses the file, and the
 * message an editor gets is "Files of type are not accepted", with a blank where the type should be.
 *
 * The fix is deliberately one extension wide. A general "guess from the name" would let a renamed
 * `.exe` declare itself an image, which is precisely what the server-side allow-list exists to stop,
 * and the server still checks the declared type against its own table either way.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
function withDeclaredType(file: File): File {
  if (file.type.trim().length > 0) return file;
  if (!/\.vtt$/i.test(file.name)) return file;
  return new File([file], file.name, { type: "text/vtt", lastModified: file.lastModified });
}

export function PickerUpload({
  kind,
  mediaKind = "DOCUMENT",
  onUploaded,
  unavailable = null
}: PickerUploadProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const inputId = useId();
  const [busy, setBusy] = useState(false);
  const [fraction, setFraction] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** Announced rather than only drawn, because an upload finishing is not a visible change up here. */
  const [announcement, setAnnouncement] = useState("");

  /**
   * THE PICTURE THAT HAS JUST LANDED, AND THE BYTES IT LANDED FROM, kept so its framing can be chosen
   * here instead of on another screen.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * ⚠ THIS WAS THE ONE IMAGE UPLOAD IN THE STUDIO WITH NO CROP BEHIND IT. `UploadQueue` (the library),
   * `MediaPicker` (choosing a picture) and `MediaDetailPanel` (an existing asset) all open the same
   * dialog and write the same five columns; an editor who uploaded a picture from inside a picker —
   * today, a video's poster frame — got no preview of what they had just sent and no way to say which
   * part of it the site should show without leaving the form they were in the middle of. Since
   * `MediaImage` draws every asset `object-cover` inside whatever shape the surface asked for, "no
   * choice" is not neutral: it means trimmed from the centre, which is the wrong guess for most
   * photographs.
   *
   * ⚠ THE OFFER COMES AFTER THE BYTES LAND, NEVER BEFORE THEY ARE SENT, matching `UploadQueue`'s
   * ordering and for its reasons: a crop is a display decision that can be changed at any time, so
   * blocking an upload on a modal buys nothing and leaves the uplink idle; and uploading first means
   * the preview can use the local `File`, so the picture appears instantly and works even where object
   * storage has no public base URL configured.
   *
   * ⚠ AND THE ID IS HANDED TO THE PICKER IMMEDIATELY, BEFORE ANY OF THIS. The chip must appear the
   * moment the upload succeeds whether or not the editor ever opens the cropper — the form is
   * autosaving, and a picture that is only "chosen" once a dialog has been dismissed is a picture that
   * goes missing when somebody navigates away instead.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  const [cropAsset, setCropAsset] = useState<UploadedMediaAsset | StudioMediaAsset | null>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [cropOpen, setCropOpen] = useState(false);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [cropError, setCropError] = useState<string | null>(null);

  /**
   * The `blob:` URL for the picture being cropped, created ON OPEN and REVOKED ON CLOSE.
   *
   * ⚠ AN UNREVOKED OBJECT URL PINS THE WHOLE FILE IN MEMORY for the lifetime of the document — the same
   * trap `UploadQueue` documents. Only one picture is ever held here, and only while the dialog is
   * actually open, which is why this keys on `cropOpen` rather than on the asset.
   */
  useEffect(() => {
    if (!cropOpen || !cropFile) {
      setCropSrc(null);
      return;
    }
    const url = URL.createObjectURL(cropFile);
    setCropSrc(url);
    return () => {
      URL.revokeObjectURL(url);
      setCropSrc(null);
    };
  }, [cropOpen, cropFile]);

  /**
   * Store the chosen rectangle against the asset — THE SAME FIVE COLUMNS AND THE SAME ENDPOINT as
   * `UploadQueue.saveCrop`, `MediaPicker.saveCrop` and `MediaDetailPanel.saveFraming`.
   *
   * `null` clears the crop, which is what "show the whole picture" means. The bytes, the derivatives and
   * the checksum are untouched — a crop is four numbers applied at render — so re-cropping later costs
   * nothing. The PATCHED row replaces the one held here, so reopening the dialog reopens on what the
   * database actually stored rather than on what this component hoped it did.
   */
  const saveCrop = async (assetId: string, choice: CropChoice | null) => {
    setCropError(null);
    try {
      const updated = await patch<StudioMediaAsset>(MEDIA_ENDPOINTS.detail(assetId), {
        cropX: choice ? choice.rect.x : null,
        cropY: choice ? choice.rect.y : null,
        cropWidth: choice ? choice.rect.width : null,
        cropHeight: choice ? choice.rect.height : null,
        cropAspect: choice ? choice.aspectId : null
      });
      setCropAsset(updated);
      setAnnouncement(
        choice ? "What is shown of the picture has been saved." : "The whole picture will be shown."
      );
    } catch (thrown) {
      // The picture is uploaded and chosen either way, so this is a failure to save a REFINEMENT. Saying
      // exactly that is what stops an editor assuming the upload itself came apart.
      setCropError(
        `The choice could not be saved, so the site will keep showing the whole picture. ${
          thrown instanceof Error ? asApiClientError(thrown).message : "Try again."
        }`
      );
    }
  };

  /**
   * The file library takes anything a person might want to download, so the size cap is what
   * constrains it — the same reasoning as `FILE_ACCEPT` in the file library. The media library takes
   * only what the presign route accepts, narrowed to the kind this picker is asking for.
   */
  const noun =
    kind === "file"
      ? {
          one: "document",
          accept: "*/*",
          hint: "It is added to the file library, where it can be renamed and made public."
        }
      : { one: MEDIA_NOUN[mediaKind].one, accept: mediaAcceptFor(mediaKind), hint: MEDIA_NOUN[mediaKind].hint };

  const run = useCallback(
    async (chosen: File) => {
      // See `withDeclaredType`: a `.vtt` arrives from most desktops with no content type at all, and
      // every layer below this one reads that value.
      const file = withDeclaredType(chosen);
      setBusy(true);
      setError(null);
      setFraction(0);
      // The previous picture's offer goes with it. Leaving it up would invite an editor to crop the file
      // they uploaded a minute ago while looking at the one they just chose — the same reasoning
      // `UploadQueue` gives for clearing its own rows when a new batch starts.
      setCropAsset(null);
      setCropFile(null);
      setCropOpen(false);
      setCropError(null);
      try {
        if (kind === "media") {
          /**
           * `uploadFiles` presigns, PUTs and registers the `MediaAsset` in one call — and it RESOLVES
           * EVEN WHEN NOTHING UPLOADED, reporting per-file reasons in `failed`. Reading only the promise
           * is the documented way to miss a failure entirely (see its header), so `failed` is checked
           * before `uploaded` is trusted.
           */
          const result = await uploadFiles([file], {
            // `overall`, which is byte-weighted across the batch — one file here, so it is that file's own
            // fraction.
            onProgress: (progress) => setFraction(progress.overall)
          });
          const first = result.uploaded[0];
          if (!first) {
            setError(
              result.failed.length > 0
                ? summariseFailures(result.failed)
                : "The upload finished but storage returned nothing. Try again."
            );
            return;
          }
          onUploaded(first.id);
          /**
           * Held only for a PICTURE, and only where there are pixels to choose between.
           *
           * `kindForContentType` rather than the `mediaKind` prop: the prop says what the picker ASKED
           * for and this says what actually arrived, and offering to crop a document because the field
           * was configured for images would open the dialog onto nothing. SVG is excluded for the reason
           * `UploadQueue` gives — a vector has no pixels to crop and the whole document scales.
           */
          const arrived = kindForContentType(file.type);
          if (arrived === "IMAGE" && file.type !== "image/svg+xml") {
            setCropAsset(first);
            setCropFile(file);
            setCropError(null);
          }
          setAnnouncement(`${file.name} has been uploaded and chosen.`);
          return;
        }

        const object = await uploadToFileStore(file, setFraction);
        /**
         * The title is the file's own name with the extension taken off — see the header on why this is
         * not a form field. `basename` rather than the whole name because "Annual report.pdf" reads as a
         * mistake in a list of download titles, and the extension is already carried by `fileName`.
         */
        const title = file.name.replace(/\.[^.]+$/, "").trim() || file.name;
        const created = await post<{ file?: { id?: string } }>(FILE_CREATE_PATH, {
          title,
          objectKey: object.objectKey,
          fileName: object.fileName,
          mimeType: object.mimeType,
          byteSize: object.byteSize
        });
        const id = created.file?.id;
        if (!id) {
          // The bytes ARE in storage at this point. Saying so is the difference between "try again" and
          // an editor assuming the upload itself failed and hunting for a network problem.
          setError(
            "The document reached storage but was not recorded in the library, so it cannot be chosen yet. Try again, or add it from the file library."
          );
          return;
        }
        onUploaded(id);
        setAnnouncement(`${file.name} has been uploaded and chosen.`);
      } catch (thrown) {
        // `UploadError` and `ApiClientError` both already carry a sentence written for a reader; a raw
        // `Error` from the signed PUT does too (see lib/client/fileUpload.ts).
        setError(
          thrown instanceof UploadError
            ? thrown.message
            : thrown instanceof Error
              ? asApiClientError(thrown).message
              : "The upload did not finish."
        );
      } finally {
        setBusy(false);
        setFraction(0);
        // So choosing the SAME file again still fires a change event.
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [kind, onUploaded]
  );

  /**
   * ⚠ THE TWO ROW SHAPES DIFFER BY ONE FIELD, AND THAT IS DELIBERATE RATHER THAN AN OVERSIGHT TO CAST
   * AWAY. A picture that has just landed arrives as `UploadedMediaAsset`, which extends `MediaLike` —
   * and `MediaLike` omits `cropAspect` on purpose (lib/media/select.ts says why: it records which preset
   * the editor cropped on, and nothing RENDERS from it). A row that has been through `saveCrop` is a
   * `StudioMediaAsset`, which carries it. So the preset is read through a presence test instead of an
   * assertion, and the fallback is exactly right: a picture nobody has cropped has no preset, and the
   * dialog opening on its default shape is what should happen.
   */
  const cropFileName = cropAsset && "fileName" in cropAsset ? cropAsset.fileName : "";
  const cropAspectId =
    cropAsset && "cropAspect" in cropAsset ? (cropAsset.cropAspect ?? undefined) : undefined;

  if (unavailable) {
    return <HelpText>{unavailable}</HelpText>;
  }

  return (
    <div className="border-t border-line-200 pt-2">
      {/*
        A real <input type="file"> with a <label> over it, not a button calling `.click()`. The label IS
        the control: it is reachable by keyboard, it is announced as a file input, and it needs no
        JavaScript to open the chooser.
      */}
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={noun.accept}
        disabled={busy}
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void run(file);
        }}
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label
          htmlFor={inputId}
          className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-md border border-line-200 bg-card px-3 py-1.5 text-sm font-medium text-ink-700 transition hover:border-purple-300 hover:text-purple-700 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-purple-600 aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
          aria-disabled={busy || undefined}
        >
          <Upload aria-hidden="true" className="h-4 w-4" />
          {busy ? `Uploading a ${noun.one}…` : `Upload a ${noun.one}`}
        </label>

        <span className="text-xs text-ink-500">
          Up to {formatBytes(MAX_UPLOAD_BYTES)}. {noun.hint}
        </span>
      </div>

      {busy ? (
        <ProgressBar
          className="mt-2"
          value={Math.round(fraction * 100)}
          label={`Uploading — ${Math.round(fraction * 100)}%`}
        />
      ) : null}

      {error ? (
        // `role="alert"`: the reader chose a file and it did not arrive.
        <p role="alert" className="mt-2 text-sm leading-relaxed text-error-600">
          {error}
        </p>
      ) : null}

      {/*
        THE OFFER, on the picture that has just landed. A plain `<button>` rather than a second label
        over the file input — this one opens a dialog, not a file chooser, and the two must not look
        like the same control.

        The wording flips once a rectangle is stored, exactly as it does in the library and the picker,
        so an editor can tell at a glance whether this picture has been framed or is still showing whole.
      */}
      {cropAsset && !busy ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setCropOpen(true)}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-line-200 bg-card px-3 py-1.5 text-sm font-medium text-ink-700 transition hover:border-purple-300 hover:text-purple-700"
          >
            <Crop aria-hidden="true" className="h-4 w-4" />
            {storedCrop(cropAsset) ? "Change what is shown" : "Choose what is shown"}
          </button>

          <p className="mt-1.5 text-xs leading-relaxed text-ink-500">
            Optional. The picture is already uploaded and chosen. This decides which part of it the site
            shows when the space it goes into is a different shape — without a choice it is trimmed from
            the centre. It can be changed at any time in the media library.
          </p>

          {cropError ? (
            <p role="alert" className="mt-1.5 text-sm leading-relaxed text-error-600">
              {cropError}
            </p>
          ) : null}
        </div>
      ) : null}

      {/*
        THE SAME DIALOG THE OTHER THREE SURFACES OPEN — `components/studio/ImageCropper`, which returns
        four fractions and never touches the bytes. Reopening after a save reopens ON the stored
        rectangle, because `saveCrop` writes the patched row back into `cropAsset`; a rectangle that
        fails `isUsableCrop` arrives as null and the dialog opens on the whole picture, which is the same
        degradation the render side makes.
      */}
      <ImageCropper
        open={cropOpen}
        onClose={() => setCropOpen(false)}
        src={cropSrc}
        fileName={cropFileName}
        initialRect={storedCrop(cropAsset)}
        initialAspectId={cropAspectId}
        onApply={(choice) => {
          const assetId = cropAsset?.id;
          if (!assetId) return;
          return saveCrop(assetId, choice);
        }}
      />

      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}
