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
 * ⚠ IT HANDS BACK AN ID AND NOTHING ELSE. The picker adds that id to its own selection and resolves it
 * through the same lookup every other chip goes through, so an uploaded item and a searched one are the
 * same thing by the time they are on screen. Anything else would be a second code path for displaying a
 * chosen record, and the first time the two disagreed the editor would see a chip that vanished on
 * reload.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useId, useRef, useState } from "react";
import { Upload } from "lucide-react";

import { asApiClientError, post } from "@/lib/client/fetcher";
import { FILE_CREATE_PATH, uploadToFileStore } from "@/lib/client/fileUpload";
import {
  ACCEPTED_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  UploadError,
  kindForContentType,
  summariseFailures,
  uploadFiles,
  type MediaKindName
} from "@/lib/client/upload";
import { formatBytes } from "@/lib/utils";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { HelpText } from "@/components/studio/HelpText";

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

      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}
