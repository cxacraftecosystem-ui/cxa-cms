"use client";

/**
 * MediaDetailPanel — everything about one file, and the place where the accessibility of the whole
 * public site is actually decided.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE DESCRIPTION IS THE POINT OF THIS SCREEN, so it is first, it is explained, and it is never
 * silently optional. Three states, and they are three different statements:
 *
 *   • NOBODY HAS WRITTEN ONE (`altText` is null in the database). Somebody using a screen reader is
 *     told nothing at all, or has the filename read at them. This is the backlog.
 *   • THE IMAGE IS DECORATIVE (`altText` is the empty string). An empty `alt` is MEANINGFUL in HTML —
 *     it tells a screen reader to skip the image entirely, which is exactly right for a background
 *     texture or a photograph whose caption already says the same thing. It is a decision somebody
 *     made, and it counts as done.
 *   • IT HAS A DESCRIPTION.
 *
 * A checkbox — not a blank field — is what turns the first into the second, because "I left it empty
 * because it does not need one" and "I have not got to it yet" must not be spelled the same way. The
 * whole media library's "needs a description" filter depends on that distinction being real.
 *
 * SAVING IS EXPLICIT HERE, unlike the long-form editors, which autosave (contract §10). The reason is
 * how this panel is dismissed: by clicking the next photograph. A four-second timer belonging to a
 * panel that has just been replaced is a save that either fires for a screen nobody is looking at or
 * does not fire at all — and half-typed alt text saved by a timer reads, to the next person, as a
 * description somebody wrote. So: a Save bar that is always visible, a Discard beside it, and the
 * library asks before it swaps a panel with unsaved changes out from under you (`onDirtyChange`).
 *
 * DELETING SHOWS WHAT BREAKS FIRST. Every place the file is used is listed, each as a link, because an
 * administrator about to remove a photograph needs to know it is the one on the About page. The delete
 * itself is a SOFT delete — the row goes to the recycle bin and the bytes survive the purge window —
 * so the confirm is a plain danger confirm rather than a type-the-name one. The window is named as a
 * REAL NUMBER OF DAYS, taken from `recoveryDays` on the loaded row rather than written into this file:
 * see `MediaAssetDetail.recoveryDays`. Where the server did not send one, the confirm says the file
 * goes to the recycle bin and stops there rather than inventing a period.
 *
 * ⚠ AND IT SAYS "AN ADMINISTRATOR CAN PUT IT BACK", NOT "YOU CAN". Deleting needs `canManageMedia`;
 * restoring needs `canRestoreDeleted`, which is ADMINISTRATOR only. The two are not the same rank, so
 * the reassurance has to name who can actually act on it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE TWO CROP BUTTONS ARE TWO DIFFERENT OPERATIONS AND THE WORDING HAS TO KEEP THEM APART.
 *
 *   • "Choose what is shown" edits FIVE NUMBERS ON THIS ROW (`components/studio/ImageCropper`). No
 *     bytes are touched, no derivative is regenerated, no new file appears in the library, and every
 *     page already using this photograph picks the new framing up. It is undoable for ever, because
 *     "show the whole picture" is just those five numbers set back to null. This is what an editor
 *     wants nine times in ten, and it is the one that works on a photograph uploaded two years ago.
 *
 *   • "Crop a copy" re-encodes the pixels into a NEW asset (`./ImageCropper`, the sibling). It costs an
 *     upload, a fresh set of derivatives and a description of its own, and nothing already using this
 *     file changes. It is the right tool only when the two crops must exist side by side — a tight
 *     portrait for a profile and the wide original for the story about the same person.
 *
 * SAVING A CROP DOES NOT GO THROUGH THE SAVE BAR, deliberately. The dialog's own "Use this crop" is the
 * commit, exactly as it is in the upload queue, and it writes immediately. Folding it into the panel's
 * dirty state would mean a reader could position a rectangle, press Cancel on the dialog, and still be
 * told they have unsaved changes — and a crop is not something you keep half-finished while typing a
 * caption.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * REPLACING THE FILE KEEPS THE SAME id, which is what makes it a replacement rather than a new upload:
 * every article, album and profile pointing at this asset picks up the new bytes with no re-linking.
 * The bytes go STRAIGHT TO STORAGE from the browser through a signed PUT, exactly as an ordinary upload
 * does — they never pass through the application server.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import {
  Copy,
  Crop,
  ExternalLink,
  Layers,
  Link2Off,
  RefreshCw,
  RotateCcw,
  ScanEye,
  Trash2,
  TriangleAlert,
  X
} from "lucide-react";

import { asApiClientError, del, patch, post } from "@/lib/client/fetcher";
import { useResource } from "@/lib/client/useResource";
import { kindForContentType, MAX_UPLOAD_BYTES } from "@/lib/client/upload";
import { mediaSrc } from "@/lib/media/url";
import { cn, formatBytes } from "@/lib/utils";
import {
  CROP_ASPECTS,
  ImageCropper as FramingCropper,
  cropFrameStyle,
  // Shared rather than re-derived here: the picker and the upload queue read the same five columns,
  // and three copies of "is there a crop on this row" is three chances for them to disagree about a
  // half-written rectangle. Its own doc comment carries the reason the `?? undefined`s are there.
  storedCrop,
  type CropChoice
} from "@/components/studio/ImageCropper";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { Field, FieldBlock } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { MediaImage } from "@/components/ui/MediaImage";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/ToastProvider";
import { HelpText } from "@/components/studio/HelpText";
import {
  MEDIA_ENDPOINTS,
  MEDIA_KIND_LABELS,
  altState,
  describeDimensions,
  hasPicture,
  type MediaAssetDetail,
  type MediaDeleteResponse,
  type MediaFolderNode,
  type StudioMediaAsset
} from "./MediaGrid";

/** Long enough for a real sentence, short enough that nobody writes a paragraph a reader must sit through. */
const ALT_MAX_LENGTH = 240;
const CAPTION_MAX_LENGTH = 400;

interface MetaForm {
  /** What is in the box. Empty AND `decorative` false means "nobody has written one". */
  altText: string;
  decorative: boolean;
  caption: string;
  credit: string;
  copyright: string;
  tags: string[];
  /** "" means no folder. */
  folderId: string;
}

/** The wire shape of a metadata save. `altText: null` is a real value here — see the header. */
interface MetaBody {
  altText: string | null;
  caption: string | null;
  credit: string | null;
  copyright: string | null;
  tags: string[];
  folderId: string | null;
}

function formFromDetail(detail: MediaAssetDetail): MetaForm {
  return {
    // `null` (unwritten) and `""` (decorative) both leave the box empty; the checkbox is what tells
    // them apart, and it is the only thing that does.
    altText: detail.altText ?? "",
    decorative: detail.altText !== null && detail.altText.trim().length === 0,
    caption: detail.caption ?? "",
    credit: detail.credit ?? "",
    copyright: detail.copyright ?? "",
    tags: [...detail.tags],
    folderId: detail.folderId ?? ""
  };
}

function bodyFromForm(form: MetaForm): MetaBody {
  const trimmedAlt = form.altText.trim();
  return {
    altText: form.decorative ? "" : trimmedAlt.length > 0 ? trimmedAlt : null,
    caption: form.caption.trim() || null,
    credit: form.credit.trim() || null,
    copyright: form.copyright.trim() || null,
    // Trimmed, de-duplicated and order-preserved, so "Bagru, bagru" cannot become two tags.
    tags: form.tags.map((tag) => tag.trim()).filter((tag, index, all) => tag.length > 0 && all.indexOf(tag) === index),
    folderId: form.folderId.length > 0 ? form.folderId : null
  };
}

/** A stable snapshot for the dirty comparison. Key order is fixed by `bodyFromForm`, so this is stable. */
function snapshot(form: MetaForm): string {
  return JSON.stringify(bodyFromForm(form));
}

/** The shape the editor was working on, in their words, or null if the id is not one we offer. */
function cropShapeLabel(aspectId: string | null | undefined): string | null {
  if (!aspectId || aspectId === "free") return null;
  return CROP_ASPECTS.find((entry) => entry.id === aspectId)?.label ?? null;
}

/**
 * What shape to draw the panel's own crop preview in.
 *
 * The stored preset when there is one — showing a 4:5 portrait crop inside a 16:9 box would re-trim it
 * on screen and make a good crop look wrong. 16:9 is the fallback for a free-form crop, because it is
 * the widest frame the site draws often and therefore the one that loses the most.
 */
function cropPreviewRatio(aspectId: string | null | undefined): number {
  const preset = CROP_ASPECTS.find((entry) => entry.id === aspectId);
  return preset?.ratio ?? 16 / 9;
}

export interface MediaDetailPanelProps {
  /** Null closes the panel. Changing it loads a different file. */
  assetId: string | null;
  onClose: () => void;
  /** For the folder picker. `null` while they are loading. */
  folders: readonly MediaFolderNode[] | null;
  /** The row after a successful save, so the caller can update its list without a full re-fetch. */
  onSaved: (asset: StudioMediaAsset) => void;
  onDeleted: (id: string) => void;
  /** "Crop a copy" — the caller opens the cropper, because the new file lands in ITS list. */
  onCropRequest?: (asset: MediaAssetDetail) => void;
  /** Reported on every change so the library can ask before replacing an edited panel. */
  onDirtyChange?: (dirty: boolean) => void;
  /** False when object storage is not configured: replacing a file is then impossible, and it says so. */
  storageReady: boolean;
  className?: string;
}

export function MediaDetailPanel({
  assetId,
  onClose,
  folders,
  onSaved,
  onDeleted,
  onCropRequest,
  onDirtyChange,
  storageReady,
  className
}: MediaDetailPanelProps) {
  const confirm = useConfirm();
  const { toast } = useToast();

  const detail = useResource<MediaAssetDetail>(
    assetId === null ? null : MEDIA_ENDPOINTS.detail(assetId)
  );

  const [form, setForm] = useState<MetaForm | null>(null);
  /** Which asset `form` was seeded from, so a background refresh cannot stamp on an edit in progress. */
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [replaceError, setReplaceError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** The framing dialog. Its own "Use this crop" is the commit — see the header. */
  const [framingOpen, setFramingOpen] = useState(false);
  const [framingError, setFramingError] = useState<string | null>(null);

  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const altRef = useRef<HTMLTextAreaElement | null>(null);

  const data = detail.data;

  useEffect(() => {
    if (!data) return;
    // Seed ONCE per asset. `useResource` re-reads on every refresh, and re-seeding on each answer
    // would wipe half-typed alt text the moment an unrelated refresh landed.
    if (loadedId === data.id) return;
    setForm(formFromDetail(data));
    setLoadedId(data.id);
    setTagDraft("");
    setSaveError(null);
    setReplaceError(null);
  }, [data, loadedId]);

  const baseline = useMemo(() => (data ? snapshot(formFromDetail(data)) : null), [data]);
  const current = useMemo(() => (form ? snapshot(form) : null), [form]);
  const dirty = baseline !== null && current !== null && baseline !== current;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  if (assetId === null) return null;

  const state = data ? altState(data) : "not-applicable";

  // The framing, read once per render. `mediaSrc` returns null where no public base URL is configured
  // or the asset has no variants yet, and the cropper says so in its own words rather than opening
  // onto an empty box.
  const crop = data ? storedCrop(data) : null;
  const cropSource = data && hasPicture(data.kind) ? mediaSrc(data, 1600) : null;
  const cropShape = cropShapeLabel(data?.cropAspect);
  const cropKept = crop ? Math.round(crop.width * crop.height * 100) : null;

  const folderOptions = (folders ?? [])
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((folder) => ({ value: folder.id, label: folder.path }));

  const update = (partial: Partial<MetaForm>) => {
    setForm((currentForm) => (currentForm ? { ...currentForm, ...partial } : currentForm));
  };

  const addTag = () => {
    const tag = tagDraft.trim();
    if (tag.length === 0 || !form) return;
    if (form.tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
      setTagDraft("");
      return;
    }
    update({ tags: [...form.tags, tag] });
    setTagDraft("");
  };

  const save = async () => {
    if (!form || !data || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await patch<StudioMediaAsset>(
        MEDIA_ENDPOINTS.detail(data.id),
        bodyFromForm(form)
      );
      onSaved(updated);
      // Re-read rather than patching state locally: the folder, the usage list and the derivative list
      // can all have moved, and a panel that shows stale usage is a panel somebody deletes from.
      await detail.refresh();
      toast({ title: "Saved", tone: "success" });
    } catch (thrown) {
      setSaveError(asApiClientError(thrown).message);
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    if (!data) return;
    setForm(formFromDetail(data));
    setTagDraft("");
    setSaveError(null);
  };

  /**
   * Store the crop against this row.
   *
   * ⚠ FIVE FIELDS, ALWAYS SENT TOGETHER, and `null` across all five is what "show the whole picture"
   * means — the API refuses every other combination, because four numbers out of five is not a
   * rectangle and the render side would have to guess at the missing one.
   *
   * ⚠ IT MUST NOT REJECT. The cropper calls this from `void apply()` and closes on the resolved
   * promise; a rejection there is an unhandled rejection with no message anywhere a reader can see it.
   * So the failure is caught and put on screen, in the panel, where the reader is looking.
   */
  const saveFraming = async (choice: CropChoice | null) => {
    if (!data) return;
    setFramingError(null);
    try {
      const updated = await patch<StudioMediaAsset>(MEDIA_ENDPOINTS.detail(data.id), {
        cropX: choice ? choice.rect.x : null,
        cropY: choice ? choice.rect.y : null,
        cropWidth: choice ? choice.rect.width : null,
        cropHeight: choice ? choice.rect.height : null,
        cropAspect: choice ? choice.aspectId : null
      });
      onSaved(updated);
      // Re-read: the panel draws its own preview from the crop, and the usage list is what tells the
      // reader how many pages have just been reframed by this one click.
      await detail.refresh();
      toast({
        title: choice ? "The framing was saved" : "The whole picture is shown again",
        description:
          data.usage.length === 0
            ? "The file itself is unchanged — only which part of it the site shows."
            : `The file itself is unchanged. ${
                data.usage.length === 1
                  ? "The 1 place using it"
                  : `The ${data.usage.length} places using it`
              } will show the new framing.`,
        tone: "success"
      });
    } catch (thrown) {
      setFramingError(
        `The framing could not be saved, so the site will go on showing what it showed before. ${
          asApiClientError(thrown).message
        }`
      );
    }
  };

  const remove = async () => {
    if (!data || deleting) return;

    const used = data.usage.length;
    const agreed = await confirm({
      title: `Move “${data.fileName}” to the recycle bin?`,
      body: (
        <>
          <p>
            It disappears from the site straight away. Nothing is destroyed yet — the file goes to the
            recycle bin, and{" "}
            {/*
              ⚠ "AN ADMINISTRATOR CAN PUT IT BACK", NOT "YOU CAN". Deleting here needs
              `canManageMedia` (MEDIA_MANAGER and up); restoring needs `canRestoreDeleted`, which is
              ADMINISTRATOR only (lib/permissions.ts). Telling a media manager they can undo this
              themselves is a promise the studio will refuse to keep, and they would find that out
              only after deleting something.

              The window is the REAL configured number, from the row the server sent, or no number at
              all. A hard-coded "30 days" would go on saying 30 the day MEDIA_PURGE_AFTER_DAYS is set
              to 7, and a promise about how long there is to change your mind is the last thing that
              should be a guess (contract §1.6).
            */}
            {typeof data.recoveryDays === "number" ? (
              <>
                an administrator can put it back for the next{" "}
                <span className="font-semibold">
                  {data.recoveryDays === 1 ? "1 day" : `${data.recoveryDays} days`}
                </span>
                . After that the stored copy is removed for good.
              </>
            ) : (
              <>
                an administrator can put it back. It is removed for good once it has been in the
                recycle bin longer than this installation allows — Studio → Recycle bin states the
                period.
              </>
            )}
          </p>
          {used > 0 ? (
            <p className="mt-2">
              <span className="font-semibold">
                {used === 1 ? "It is used in 1 place" : `It is used in ${used} places`}
              </span>
              {data.usageTruncated ? " (at least)" : ""}, and those will be left without a picture:{" "}
              {data.usage
                .slice(0, 5)
                .map((entry) => entry.label)
                .join(", ")}
              {data.usage.length > 5 ? ` and ${data.usage.length - 5} more` : ""}.
            </p>
          ) : (
            <p className="mt-2">Nothing on the site uses it, so nothing will break.</p>
          )}
        </>
      ),
      confirmLabel: "Move to recycle bin"
    });
    if (!agreed) return;

    setDeleting(true);
    try {
      // A DELETE with no body. The handler SOFT-deletes — it sets `deletedAt` and records the change
      // through `mutateWithHistory()` like every other mutation — so this is a move to the recycle bin
      // and not a removal of bytes. Only the purge job removes bytes.
      const result = await del<MediaDeleteResponse>(MEDIA_ENDPOINTS.detail(data.id));
      onDeleted(data.id);
      // The server's own sentence, verbatim. It counts the references AGAIN at delete time, so a page
      // that started using this photograph while the panel was open is still named — which the list
      // above, read when the panel loaded, could not have known about.
      toast({
        title: `${data.fileName} was moved to the recycle bin`,
        description: result.message,
        tone: result.referenceCount > 0 ? "warn" : "success"
      });
      onClose();
    } catch (thrown) {
      setSaveError(asApiClientError(thrown).message);
    } finally {
      setDeleting(false);
    }
  };

  /**
   * Replace the bytes behind this asset, keeping its id.
   *
   * Three steps, the same first two as an ordinary upload: ask for a signed URL, PUT the file straight
   * to storage with the signed headers REPLAYED VERBATIM (the content type is part of the signature, so
   * sending a different one comes back as a mismatch that reads like a credentials problem), then tell
   * the server which object to point this row at.
   */
  const replaceFile = async (file: File) => {
    if (!data || replacing) return;

    setReplaceError(null);

    const contentType = file.type.trim();
    const kind = kindForContentType(contentType);
    if (file.size === 0) {
      setReplaceError("That file is empty (0 bytes). Choose the file itself rather than a folder.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setReplaceError(
        `That file is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_UPLOAD_BYTES)}.`
      );
      return;
    }
    if (kind === null) {
      setReplaceError(`Files of type ${contentType || "unknown"} cannot be stored in the library.`);
      return;
    }
    if (kind !== data.kind) {
      // Refused on both sides. Everything pointing at this row expects the kind it had: an article
      // laying out a photograph cannot render a PDF, and the page would simply have a hole in it.
      setReplaceError(
        `This is ${MEDIA_KIND_LABELS[data.kind].toLowerCase()} and the file you chose is ${MEDIA_KIND_LABELS[
          kind
        ].toLowerCase()}. A replacement has to be the same kind of thing, because everything already using this file expects it. Upload it as a new file instead.`
      );
      return;
    }

    setReplacing(true);
    try {
      const presigned = await post<{
        uploadUrl: string;
        headers: Record<string, string>;
        objectKey: string;
      }>(MEDIA_ENDPOINTS.presign, {
        fileName: file.name,
        contentType,
        byteSize: file.size,
        kind
      });

      const headers = new Headers(presigned.headers);
      if (!headers.has("content-type")) headers.set("content-type", contentType);

      const put = await fetch(presigned.uploadUrl, { method: "PUT", body: file, headers });
      if (!put.ok) {
        throw new Error(
          put.status === 403
            ? "Storage refused the upload. The signed link had probably expired — try again, and if it keeps happening the storage settings need checking."
            : `Storage refused the upload with HTTP ${put.status}.`
        );
      }

      const updated = await post<StudioMediaAsset>(MEDIA_ENDPOINTS.replace(data.id), {
        objectKey: presigned.objectKey,
        fileName: file.name,
        contentType,
        byteSize: file.size
      });

      onSaved(updated);
      await detail.refresh();
      toast({
        title: "The file was replaced",
        description:
          "Everything already using it now shows the new version. Smaller versions are being made again.",
        tone: "success"
      });
    } catch (thrown) {
      setReplaceError(
        thrown instanceof Error && thrown.name !== "ApiClientError"
          ? thrown.message
          : asApiClientError(thrown).message
      );
    } finally {
      setReplacing(false);
    }
  };

  return (
    <section
      aria-label="File details"
      className={cn("panel flex min-h-0 flex-col", className)}
    >
      <header className="flex items-start gap-2 border-b border-line-200 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-sm font-semibold text-ink-900">
            {data ? data.fileName : "Loading…"}
          </h2>
          {data ? (
            <p className="mt-0.5 text-xs text-ink-500">
              {MEDIA_KIND_LABELS[data.kind]} · {formatBytes(data.byteSize)}
              {describeDimensions(data) ? ` · ${describeDimensions(data)}` : ""}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the file details"
          className="-mr-1 -mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-500 transition hover:bg-surface-100 hover:text-ink-900"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        {detail.error && !data ? (
          <p
            role="alert"
            className="flex items-start gap-1.5 rounded-md border border-error-200 bg-error-100 px-3 py-2.5 text-sm text-error-700"
          >
            <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{detail.error.message}</span>
          </p>
        ) : null}

        {!data ? (
          <div>
            <span role="status" className="sr-only">
              Loading the file details…
            </span>
            <div aria-hidden="true" className="space-y-3">
              <div className="skeleton aspect-video w-full" />
              <div className="skeleton h-4 w-3/4" />
              <div className="skeleton h-16 w-full" />
              <div className="skeleton h-4 w-1/2" />
            </div>
          </div>
        ) : form === null ? null : (
          <>
            {hasPicture(data.kind) ? (
              <MediaImage
                media={data}
                targetWidth={1080}
                sizes="(min-width: 1280px) 24vw, 100vw"
                rounded="sm"
                // Decorative in this position: the heading above already names the file, and the panel
                // is about the file rather than presenting the picture for its content.
                alt=""
                className="w-full bg-surface-100"
                imageClassName="!object-contain"
              />
            ) : null}

            {/* ── What the site shows of it ─────────────────────────────────────────────── */}
            {hasPicture(data.kind) ? (
              <div className="mt-3 rounded-md border border-line-200 bg-surface-50 p-3">
                <h3 className="flex items-center gap-1.5 font-display text-sm font-semibold text-ink-900">
                  <Crop aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-ink-500" />
                  What the site shows of this picture
                </h3>

                {crop ? (
                  <>
                    <p className="mt-1 text-xs leading-relaxed text-ink-700">
                      A part of it has been chosen — {cropKept}% of the picture
                      {cropShape ? `, on the “${cropShape}” shape` : ", trimmed to a free shape"}.
                      Everywhere the site draws this file, that is the part it starts from.
                    </p>

                    {cropSource ? (
                      <div className="mt-2">
                        {/*
                          The stored rectangle, drawn with the SAME nested-percentage geometry
                          `cropFrameStyle` gives the render side — so this is what the page will
                          actually paint, not an illustration of it. A plain <img>: the source is a CDN
                          URL rather than a media row, nothing is laid out from it, and next/image
                          would buy a second copy of bytes the panel has already loaded above.
                        */}
                        <div
                          // Inline, not a Tailwind class: an `aspect-[16/9]` assembled from stored
                          // data would be purged by the content scanner (contract §5).
                          style={{ aspectRatio: String(cropPreviewRatio(data.cropAspect)) }}
                          className="relative w-full overflow-hidden rounded-sm border border-line-200 bg-surface-100"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={cropSource}
                            alt=""
                            aria-hidden="true"
                            style={cropFrameStyle(crop)}
                            className="max-w-none object-cover"
                          />
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <p className="mt-1 text-xs leading-relaxed text-ink-700">
                    The whole picture is used, and the site trims it from the{" "}
                    <span className="font-medium">middle</span> to fit whatever frame it lands in — a
                    wide banner, a card, a square tile. The middle is a guess, and it is the wrong
                    guess whenever the subject is not dead centre.
                  </p>
                )}

                <div className="mt-2.5 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={Crop}
                    onClick={() => setFramingOpen(true)}
                  >
                    {crop ? "Change what is shown" : "Choose what is shown"}
                  </Button>
                  {crop ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={RotateCcw}
                      onClick={() => void saveFraming(null)}
                    >
                      Show the whole picture again
                    </Button>
                  ) : null}
                </div>

                <p className="mt-2 text-xs leading-relaxed text-ink-500">
                  This makes no new file and changes nothing about the one you uploaded — it records
                  which part to show. Every page already using this photograph is reframed at once, and
                  you can come back and choose differently whenever you like.
                </p>

                {framingError ? (
                  <p
                    role="alert"
                    className="mt-2 flex items-start gap-1.5 rounded-md border border-error-200 bg-error-100 px-2.5 py-2 text-xs leading-relaxed text-error-700"
                  >
                    <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{framingError}</span>
                  </p>
                ) : null}
              </div>
            ) : null}

            {/* ── The description ───────────────────────────────────────────────────────── */}
            {hasPicture(data.kind) ? (
              <div className="mt-4">
                <h3 className="font-display text-sm font-semibold text-ink-900">Description</h3>

                <div className="mt-2 rounded-md border border-purple-200 bg-purple-50 px-3 py-2.5 text-xs leading-relaxed text-ink-700">
                  <p>
                    This is what somebody who cannot see the picture is told instead of it — through a
                    screen reader, or when the image fails to load. It is also what a search engine
                    reads.
                  </p>
                  <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
                    <li>Say what is in the picture, in one plain sentence.</li>
                    <li>
                      Name the people, the place or the craft if they are the point — “Two artisans
                      block-printing indigo cloth at Bagru”.
                    </li>
                    <li>Do not begin with “Image of” — that part is already announced.</li>
                    <li>If the caption underneath already says it all, mark the image decorative.</li>
                  </ul>
                </div>

                <div className="mt-3">
                  <Field
                    label="What is in this picture?"
                    maxLength={ALT_MAX_LENGTH}
                    value={form.altText}
                    help={
                      form.decorative
                        ? "Not needed while the image is marked decorative."
                        : "One sentence. It is read out in place of the picture."
                    }
                  >
                    <Textarea
                      ref={altRef}
                      rows={3}
                      value={form.decorative ? "" : form.altText}
                      disabled={form.decorative}
                      onChange={(event) => update({ altText: event.target.value })}
                    />
                  </Field>
                </div>

                <div className="mt-1">
                  <Checkbox
                    checked={form.decorative}
                    onCheckedChange={(checked) => {
                      // Ticking it is a DECISION and it is stored as one: the empty string, which tells
                      // a screen reader to skip the image. Unticking restores whatever was typed before,
                      // so the box is not a trap.
                      update({ decorative: checked });
                      if (!checked) window.setTimeout(() => altRef.current?.focus(), 0);
                    }}
                    label="This image is decorative"
                    description="Tick this when the picture adds nothing a reader would miss — a background texture, a divider, or a photograph whose caption already describes it. Screen readers will skip it entirely, which is the right outcome and is not the same as leaving the description blank."
                  />
                </div>

                {state === "missing" && !form.decorative && form.altText.trim().length === 0 ? (
                  <HelpText tone="warn" className="mt-1.5">
                    Nobody has written a description for this image yet. Either write one above or tick
                    the decorative box — leaving it blank is the one option that helps nobody.
                  </HelpText>
                ) : null}
                {state === "decorative" && form.decorative ? (
                  <HelpText className="mt-1.5" icon={ScanEye}>
                    Marked as decorative. Screen readers skip this image, which is a deliberate choice
                    and counts as finished.
                  </HelpText>
                ) : null}
              </div>
            ) : null}

            {/* ── The rest of the details ───────────────────────────────────────────────── */}
            <div className="mt-5 space-y-3">
              <Field
                label="Caption"
                maxLength={CAPTION_MAX_LENGTH}
                value={form.caption}
                help="Shown under the picture on the site, where one is shown. Visible to everybody."
              >
                <Textarea
                  rows={2}
                  value={form.caption}
                  onChange={(event) => update({ caption: event.target.value })}
                />
              </Field>

              <Field
                label="Credit"
                value={form.credit}
                maxLength={160}
                help="Who took or made this — “Photograph: R. Menon”. Printed beside the image."
              >
                <Input
                  value={form.credit}
                  onChange={(event) => update({ credit: event.target.value })}
                />
              </Field>

              <Field
                label="Copyright"
                value={form.copyright}
                maxLength={160}
                help="Who owns it, and any conditions on using it. Kept for the record even where it is not printed."
              >
                <Input
                  value={form.copyright}
                  onChange={(event) => update({ copyright: event.target.value })}
                />
              </Field>

              {/* A `FieldBlock` — a `<div>` with `htmlFor` — because this control contains buttons. A
                  real `<label>` around them would forward stray clicks into the input and fold every
                  tag's name into the input's own name (Field.tsx). */}
              <FieldBlock
                label="Tags"
                help="Words you will search for later — a place, an occasion, a craft. Press Enter after each one."
              >
                <div className="flex gap-2">
                  <Input
                    value={tagDraft}
                    onChange={(event) => setTagDraft(event.target.value)}
                    onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                      if (event.key !== "Enter") return;
                      // Otherwise Enter submits whatever form this panel happens to sit inside.
                      event.preventDefault();
                      addTag();
                    }}
                    placeholder="Add a tag"
                  />
                  <Button variant="secondary" onClick={addTag} disabled={tagDraft.trim().length === 0}>
                    Add
                  </Button>
                </div>

                {form.tags.length > 0 ? (
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {form.tags.map((tag) => (
                      <li key={tag}>
                        {/* THE WHOLE CHIP REMOVES THE TAG. A 20px × inside a chip is a target nobody
                            hits on a trackpad, and two controls per tag is twice the tab stops for one
                            decision. */}
                        <button
                          type="button"
                          onClick={() => update({ tags: form.tags.filter((entry) => entry !== tag) })}
                          className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-purple-200 bg-purple-50 px-2.5 py-1 text-xs font-medium text-purple-700 transition hover:border-purple-300 hover:bg-purple-100"
                        >
                          {tag}
                          <X aria-hidden="true" className="h-3 w-3" />
                          <span className="sr-only"> — remove this tag</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-xs text-ink-500">No tags yet.</p>
                )}
              </FieldBlock>

              <Field
                label="Folder"
                help="Only for finding things in this library. It makes no difference to the website."
              >
                <Select
                  value={form.folderId}
                  onChange={(event) => update({ folderId: event.target.value })}
                  placeholder="Not in a folder"
                  options={folderOptions}
                />
              </Field>
            </div>

            {/* ── Where it is used ─────────────────────────────────────────────────────── */}
            <div className="mt-6">
              <h3 className="font-display text-sm font-semibold text-ink-900">
                {data.usage.length === 0
                  ? "Not used anywhere yet"
                  : data.usage.length === 1
                    ? "Used in 1 place"
                    : `Used in ${data.usage.length} places`}
              </h3>

              {data.usage.length === 0 ? (
                <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-ink-500">
                  <Link2Off aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Nothing on the site points at this file, so removing it would not leave a gap
                    anywhere.
                  </span>
                </p>
              ) : (
                <ul className="mt-1.5 space-y-1">
                  {data.usage.map((entry, index) => (
                    <li key={`${entry.where}-${entry.label}-${index}`} className="text-xs leading-relaxed">
                      {entry.href ? (
                        <Link
                          href={entry.href}
                          className="inline-flex items-start gap-1 font-medium text-purple-700 underline-offset-4 hover:underline"
                        >
                          <span>{entry.label}</span>
                          <ExternalLink aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" />
                        </Link>
                      ) : (
                        <span className="font-medium text-ink-900">{entry.label}</span>
                      )}
                      <span className="text-ink-500"> — {entry.where}</span>
                    </li>
                  ))}
                </ul>
              )}

              {data.usageTruncated ? (
                // The cap, on screen. A list that quietly stops is indistinguishable from that being
                // all there was (contract §1.6).
                <p className="mt-1.5 text-xs leading-relaxed text-ink-500">
                  There are more places than the ones listed — this check stops after a while so the
                  panel stays quick. Treat the list as “at least these”.
                </p>
              ) : null}
            </div>

            {/* ── Derivatives ─────────────────────────────────────────────────────────── */}
            <div className="mt-6">
              <h3 className="flex items-center gap-1.5 font-display text-sm font-semibold text-ink-900">
                <Layers aria-hidden="true" className="h-3.5 w-3.5 text-ink-500" />
                Smaller versions
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-ink-500">
                Made once when the file was added, so the site can send a phone a small picture and a
                large screen a large one. The original you uploaded is always kept, untouched.
              </p>

              {data.variants.length === 0 ? (
                <p className="mt-2 text-xs leading-relaxed text-ink-500">
                  {hasPicture(data.kind)
                    ? "None have been made yet. Replacing the file, or asking an administrator to run the media job again, will create them."
                    : "This kind of file does not have smaller versions."}
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-line-200 rounded-md border border-line-200">
                  {data.variants.map((variant) => (
                    <li
                      key={variant.id}
                      className="flex items-center justify-between gap-3 px-2.5 py-1.5 text-xs"
                    >
                      <span className="font-medium text-ink-700">
                        {variant.label}
                        <span className="ml-1 font-normal uppercase text-ink-500">{variant.format}</span>
                      </span>
                      <span className="tabular-nums text-ink-500">
                        {variant.width} × {variant.height} · {formatBytes(variant.byteSize)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* ── Facts ────────────────────────────────────────────────────────────────── */}
            <dl className="mt-6 space-y-1.5 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-ink-500">Added</dt>
                <dd className="text-right text-ink-700">
                  {new Date(data.createdAt).toLocaleString("en-GB", {
                    dateStyle: "medium",
                    timeStyle: "short"
                  })}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-500">Added by</dt>
                <dd className="text-right text-ink-700">{data.uploader?.name ?? "Not recorded"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-500">File type</dt>
                <dd className="text-right text-ink-700">{data.mimeType}</dd>
              </div>
              {data.duration !== null ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-500">Length</dt>
                  <dd className="text-right text-ink-700">{Math.round(data.duration)} seconds</dd>
                </div>
              ) : null}
            </dl>

            {data.duplicates && data.duplicates.length > 0 ? (
              <p className="mt-3 rounded-md border border-amber-800/25 bg-amber-100 px-2.5 py-2 text-xs leading-relaxed text-amber-800">
                {data.duplicates.length === 1
                  ? "Another file in the library has exactly the same contents: "
                  : "Other files in the library have exactly the same contents: "}
                {data.duplicates.map((entry) => entry.fileName).join(", ")}. Keeping one of them and
                removing the rest saves everybody guessing which is the current one.
              </p>
            ) : null}

            {/* ── Actions ─────────────────────────────────────────────────────────────── */}
            <div className="mt-6 border-t border-line-200 pt-4">
              <h3 className="font-display text-sm font-semibold text-ink-900">This file</h3>

              <div className="mt-2 flex flex-wrap gap-2">
                {/*
                  `Copy`, not `Crop`, and the difference is the whole point: the control above already
                  crops THIS file. This one makes a second file. Two buttons with the same scissors on
                  them would be two buttons a reader has to try to tell apart.
                */}
                {hasPicture(data.kind) && onCropRequest ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={Copy}
                    onClick={() => onCropRequest(data)}
                  >
                    Crop a copy
                  </Button>
                ) : null}

                {storageReady ? (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={RefreshCw}
                      isLoading={replacing}
                      loadingLabel="replacing"
                      onClick={() => replaceInputRef.current?.click()}
                    >
                      Replace the file
                    </Button>
                    <input
                      ref={replaceInputRef}
                      type="file"
                      // One tab stop for the pair: the button above is the visible control.
                      tabIndex={-1}
                      className="sr-only"
                      accept={data.mimeType}
                      onChange={(event) => {
                        const chosen = event.target.files?.[0] ?? null;
                        // Clearing the value is load-bearing: without it, choosing the SAME file again
                        // fires no change event and the second attempt silently does nothing.
                        event.target.value = "";
                        if (chosen) void replaceFile(chosen);
                      }}
                    />
                  </>
                ) : null}
              </div>

              <p className="mt-2 text-xs leading-relaxed text-ink-500">
                {data.usage.length === 0
                  ? "Replacing swaps the stored file for a new one and keeps everything else — the description, the caption and the credit. The copy you uploaded first is kept."
                  : `Replacing keeps this file in place everywhere it is already used, so the ${
                      data.usage.length === 1 ? "one place" : `${data.usage.length} places`
                    } listed above will show the new version. The copy you uploaded first is kept.`}
              </p>

              {hasPicture(data.kind) && onCropRequest ? (
                // Said here rather than left to the button's four words, because choosing the wrong one
                // of the two costs an upload, a second description and a duplicate in every picker.
                <p className="mt-1.5 text-xs leading-relaxed text-ink-500">
                  “Crop a copy” cuts the pixels and adds a <span className="font-medium">second</span>{" "}
                  file to the library, which then needs a description of its own and does not change
                  anything already using this one. To change what the site shows of{" "}
                  <span className="font-medium">this</span> photograph, use “
                  {crop ? "Change what is shown" : "Choose what is shown"}” at the top instead.
                </p>
              ) : null}

              {replacing ? (
                <div className="mt-3">
                  <ProgressBar value={null} label="Replacing the file" showValue />
                </div>
              ) : null}

              {replaceError ? (
                <p
                  role="alert"
                  className="mt-2 flex items-start gap-1.5 rounded-md border border-error-200 bg-error-100 px-2.5 py-2 text-xs leading-relaxed text-error-700"
                >
                  <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{replaceError}</span>
                </p>
              ) : null}

              <div className="mt-4">
                <Button
                  size="sm"
                  variant="danger"
                  icon={Trash2}
                  isLoading={deleting}
                  loadingLabel="deleting"
                  onClick={() => void remove()}
                >
                  Delete this file
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* The save bar. Always visible, never scrolls away — a panel where Save is below the fold is a
          panel people leave without saving. */}
      {form !== null && data !== null ? (
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line-200 bg-surface-50 px-4 py-3">
          <p className="min-w-0 text-xs text-ink-500">
            {saving
              ? "Saving…"
              : dirty
                ? "Unsaved changes"
                : "Everything here is saved."}
          </p>
          <div className="flex shrink-0 flex-wrap gap-2">
            {dirty ? (
              <Button size="sm" variant="ghost" onClick={discard}>
                Discard
              </Button>
            ) : null}
            <Button
              size="sm"
              isLoading={saving}
              loadingLabel="saving"
              disabled={!dirty}
              onClick={() => void save()}
            >
              Save
            </Button>
          </div>

          {saveError ? (
            <p
              role="alert"
              className="flex w-full items-start gap-1.5 text-xs leading-relaxed text-error-600"
            >
              <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{saveError}</span>
            </p>
          ) : null}
        </footer>
      ) : null}

      {/*
        The framing dialog. Mounted here, inside the panel, so it closes with the panel and cannot
        outlive the row it is editing — the caller's own cropper (the one that makes a COPY) belongs to
        the library screen instead, because the new file lands in that screen's list.
      */}
      {data && hasPicture(data.kind) ? (
        <FramingCropper
          open={framingOpen}
          onClose={() => setFramingOpen(false)}
          src={cropSource}
          fileName={data.fileName}
          initialRect={crop}
          initialAspectId={data.cropAspect ?? undefined}
          onApply={(choice) => saveFraming(choice)}
        />
      ) : null}
    </section>
  );
}
