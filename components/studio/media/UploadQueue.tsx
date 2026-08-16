"use client";

/**
 * UploadQueue — the drop target, the per-file progress, and the two things that go wrong.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * 1. ⚠ A RESOLVED PROMISE IS NOT A SUCCESS. `uploadFiles()` RESOLVES with a populated `failed` list
 *    when SOME files fail; it throws only when NOTHING landed (lib/client/upload.ts). Treating the
 *    resolved promise as "all done" shows a success notice, leaves the library two photographs short,
 *    and nobody finds out until a page is published with a gap in it.
 *
 *    So every settled batch is read twice: `uploaded` goes to the library, and `failed` becomes a
 *    LIST ON SCREEN THAT NAMES EVERY FILE AND ITS REASON, with a "Try these again" button that still
 *    holds the actual `File` objects. Not a toast — a toast is `aria-live="polite"`, never interrupts,
 *    and may never be read at all (Toast.tsx). The names stay on screen until they are dealt with.
 *
 * 1b. WHAT JUST LANDED STAYS ON SCREEN, NAMED, WITH BOTH OF THE DECISIONS THAT BELONG TO IT.
 *
 *    ⚠ "I UPLOADED THE WRONG PICTURE AND I CANNOT GET RID OF IT" IS THE FAULT THIS PANEL FIXES, and
 *    it was never a missing capability: `DELETE /api/studio/media/:id` has always been there, it has
 *    always been a SOFT delete, and the library's own detail panel and bulk bar have always offered
 *    it. What was missing was the offer AT THE MOMENT THE MISTAKE IS MADE — which is here, and, more
 *    importantly, inside `MediaPicker`, where an author uploading a cover for the article they are
 *    writing never sees the library screen at all. Sending them to another screen to undo the last
 *    five seconds is how a wrong photograph ends up published.
 *
 *    So every row carries "Remove", which asks first, says how long the file can be restored for, and
 *    repeats whatever the server reports about what was still using it. Removing is the same soft
 *    delete as everywhere else: the row goes to the recycle bin and the bytes outlive it.
 *
 *    And every PICTURE also carries "Choose what is shown", which opens
 *    `components/studio/ImageCropper` — a preview of the picture in the frames the site uses, a
 *    choice of shape, and a draggable rectangle. The chosen rectangle is stored on the asset and
 *    applied at RENDER; the uploaded bytes are never altered. See that component's header, and
 *    prisma/migrations/20260816190000_media_asset_crop for the columns.
 *
 *    ⚠ CROPPING IS OFFERED AFTER THE BYTES LAND, NOT BEFORE THEY ARE SENT, and that is a deliberate
 *    ordering. Cropping first would mean thirty modal dialogs standing between a reader and a thirty
 *    file drop, with the uplink idle throughout — and the crop is a display decision that can be
 *    changed at any time afterwards, so there is nothing to be gained by blocking on it. Uploading
 *    first also means the preview can use the local `File` rather than waiting for the CDN, so the
 *    picture appears instantly and works even where object storage has no public address configured.
 *
 * 2. IDENTICAL BYTES ARE REPORTED, NOT MERGED. Straight after a batch the server is asked which of the
 *    new rows match an existing asset's checksum — never the filename, because "IMG_0421.jpg" collides
 *    constantly and identical bytes almost never do. The offer names the asset it matched and shows
 *    its thumbnail, because "this is a duplicate" without saying WHAT OF is not something a reader can
 *    act on. Taking the offer moves the new copy to the recycle bin (soft delete, recoverable) and
 *    hands the existing one back to the caller.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * IT WARNS BEFORE THE PAGE IS UNLOADED WHILE TRANSFERS ARE IN FLIGHT, and it aborts them on unmount.
 * Only `beforeunload` can stop a real unload, and the browser supplies its own wording — a custom
 * message has been ignored since 2016. An in-app navigation is NOT intercepted here: that is
 * `UnsavedChangesProvider`'s mechanism, and a second capture-phase click listener fighting it over the
 * same event is worse than the problem. What keeps a batch alive instead is WHERE this component
 * lives: on the library screen itself, above the grid, the detail panel and the picker, so opening any
 * of those does not unmount it.
 *
 * ONE BATCH AT A TIME. `uploadFiles` already runs three transfers in parallel (UPLOAD_CONCURRENCY);
 * a second batch on top would starve both, and the first failure would be ambiguous because they were
 * all starved by each other. While one is running the zone says so rather than silently ignoring a drop.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheck, Copy, Crop, RefreshCw, Trash2, TriangleAlert, X } from "lucide-react";

import { asApiClientError, del, patch, post } from "@/lib/client/fetcher";
import {
  ACCEPTED_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  UploadError,
  uploadFiles,
  type MediaKindName,
  type UploadFailure,
  type UploadProgress
} from "@/lib/client/upload";
import { mediaSrc } from "@/lib/media/url";
import { cn, formatBytes } from "@/lib/utils";
import { ImageCropper, isUsableCrop, type CropChoice } from "@/components/studio/ImageCropper";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { FileDropzone } from "@/components/ui/FileDropzone";
import { MediaImage } from "@/components/ui/MediaImage";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { useToast } from "@/components/ui/ToastProvider";
import {
  MEDIA_ENDPOINTS,
  hasPicture,
  type MediaDeleteResponse,
  type MediaDuplicateMatch,
  type MediaDuplicateResponse,
  type StudioMediaAsset
} from "./MediaGrid";

/** How many per-file rows are listed while a batch runs. The remainder is COUNTED OUT LOUD below. */
const VISIBLE_PROGRESS_ROWS = 6;

export interface UploadQueueProps {
  /** Where new files are filed. Null means "no folder". */
  folderId: string | null;
  /** Said out loud before anything is dropped, so nothing lands somewhere unexpected. */
  folderLabel: string;
  /**
   * False when object storage is not configured. The zone is then disabled WITH the reason on screen —
   * this is a state, not a permission; a reader who may not upload never sees this component at all.
   */
  storageReady: boolean;
  /** Called with the rows that actually landed, newest first as the server returned them. */
  onUploaded: (assets: StudioMediaAsset[]) => void;
  /**
   * The reader chose the existing copy over the one they just uploaded. `discardedId` has already been
   * moved to the recycle bin by the time this is called, so the caller should drop it from its list.
   */
  onUseExisting?: (existing: StudioMediaAsset, discardedId: string) => void;
  /**
   * A file that had just been added has been moved to the recycle bin. It has ALREADY been handed to
   * `onUploaded`, so a caller that keeps a list — or a selection — has to drop it here or go on
   * showing a file that is no longer in the library.
   */
  onRemoved?: (id: string) => void;
  /**
   * How many days a removed file can still be restored for: `MEDIA_PURGE_AFTER_DAYS` as configured on
   * this installation, read on the server and handed down.
   *
   * ⚠ NULL IS A REAL ANSWER AND IT IS THE DEFAULT. The browser cannot read the variable itself (no
   * `NEXT_PUBLIC_` prefix, which is correct), and this component is mounted inside `MediaPicker` from
   * a dozen editors that have no way to pass it. Where it is null the confirmation names the recycle
   * bin and says the period is stated there, rather than inventing a number — a promise about how long
   * you have to change your mind is the last thing that should be a guess.
   */
  recoveryDays?: number | null;
  /** Content types the picker will accept. Defaults to the whole upload allow-list. */
  accept?: readonly string[];
  /** Forces the stored kind — only ever needed for PANORAMA and MODEL_3D. */
  kind?: MediaKindName;
  /** Tighter spacing and a shorter heading, for the picker dialog. */
  compact?: boolean;
  className?: string;
}

interface FailureRow extends UploadFailure {
  /** The original `File`, so "Try these again" is a real retry and not a re-pick. */
  retry: File | null;
}

/**
 * The `File` objects behind a list of failures.
 *
 * `uploadFiles` reports failures BY NAME, and two files in one drop can legitimately share a name. So
 * the names are counted and matched in order: three failures called "scan.jpg" claim the first three
 * files called "scan.jpg". Anything unmatched keeps `retry: null` and the row says it must be chosen
 * again — better than silently retrying the wrong bytes.
 */
function pairFailures(batch: readonly File[], failed: readonly UploadFailure[]): FailureRow[] {
  const wanted = new Map<string, number>();
  for (const failure of failed) wanted.set(failure.file, (wanted.get(failure.file) ?? 0) + 1);

  const claimed = new Map<string, File[]>();
  for (const file of batch) {
    const remaining = wanted.get(file.name) ?? 0;
    if (remaining === 0) continue;
    wanted.set(file.name, remaining - 1);
    const list = claimed.get(file.name);
    if (list) list.push(file);
    else claimed.set(file.name, [file]);
  }

  return failed.map((failure) => {
    const list = claimed.get(failure.file);
    const file = list && list.length > 0 ? (list.shift() ?? null) : null;
    return { ...failure, retry: file };
  });
}

/**
 * A file that has just landed, and the two decisions still open on it: remove it, and — if it is a
 * picture — choose what is shown of it.
 *
 * The `File` is kept alongside the row, and that is what makes the crop preview instant: the bytes are
 * already in this browser, so `URL.createObjectURL` costs nothing and there is no wait for storage, no
 * dependence on `NEXT_PUBLIC_CDN_URL` being configured, and no CORS header needed. It is NULLABLE
 * because the pairing is by name (see `pairAdded`) and can legitimately fail; the cropper then falls
 * back to the stored address, which is slower but not wrong.
 */
interface AddedRow {
  asset: StudioMediaAsset;
  file: File | null;
  /** True once a crop has been chosen (or explicitly declined) for this one. */
  cropSettled: boolean;
  /** True once it has been moved to the recycle bin. The row stays, saying so — see the render. */
  removed: boolean;
}

/**
 * Match the assets that were created back to the `File`s they came from.
 *
 * Matched BY NAME AND IN ORDER, exactly as `pairFailures` does above and for the same reason: two
 * files in one drop can legitimately share a name, `uploadFiles` preserves the order it was given,
 * and the server answers with the row it created for each.
 *
 * ⚠ AN UNMATCHED ROW IS KEPT, WITH A NULL `file`, AND THAT IS A CHANGE FROM PAIRING FOR THE CROP
 * ALONE. Cropping the wrong photograph is worse than not offering to crop it, so a guess was never
 * acceptable — but REMOVING is addressed by asset id, which the server returned and which cannot be
 * ambiguous. Dropping the row would mean a file the reader can see in the library, uploaded ten
 * seconds ago, with no way to take it back from the screen they are standing on.
 */
function pairAdded(batch: readonly File[], uploaded: readonly StudioMediaAsset[]): AddedRow[] {
  const byName = new Map<string, File[]>();
  for (const file of batch) {
    const list = byName.get(file.name);
    if (list) list.push(file);
    else byName.set(file.name, [file]);
  }

  return uploaded.map((asset) => ({
    asset,
    // SVG is filed as a DOCUMENT by the server, so `hasPicture` excludes it — which is right, because
    // a vector has no pixels to crop and the whole document scales.
    file: hasPicture(asset.kind) ? (byName.get(asset.fileName)?.shift() ?? null) : null,
    cropSettled: false,
    removed: false
  }));
}

export function UploadQueue({
  folderId,
  folderLabel,
  storageReady,
  onUploaded,
  onUseExisting,
  onRemoved,
  recoveryDays = null,
  accept = ACCEPTED_CONTENT_TYPES,
  kind,
  compact = false,
  className
}: UploadQueueProps) {
  const { toast } = useToast();
  const confirm = useConfirm();

  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [failures, setFailures] = useState<FailureRow[]>([]);
  const [duplicates, setDuplicates] = useState<MediaDuplicateMatch[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<string | null>(null);

  const [added, setAdded] = useState<AddedRow[]>([]);
  /** The asset id currently open in the cropper, or null when the dialog is closed. */
  const [cropping, setCropping] = useState<string | null>(null);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  /** The asset id being moved to the recycle bin, so one row's button spins and not all of them. */
  const [removing, setRemoving] = useState<string | null>(null);

  const cropTarget = added.find((row) => row.asset.id === cropping) ?? null;

  /**
   * The `blob:` URL for the picture being cropped, created on open and REVOKED ON CLOSE.
   *
   * ⚠ AN UNREVOKED OBJECT URL PINS THE WHOLE FILE IN MEMORY for the lifetime of the document. A drop
   * of forty 12-megapixel photographs is comfortably a gigabyte, so creating one per row up front —
   * the obvious shape — turns a routine batch into a tab the browser kills. One at a time, revoked
   * the moment the dialog closes, means at most one file is held.
   *
   * A row whose `File` could not be matched by name falls back to the stored address. That needs
   * storage to have a public URL and needs the derivatives to exist, so it can come back null — and
   * the cropper already says so plainly rather than opening onto an empty box.
   */
  useEffect(() => {
    if (!cropTarget) {
      setCropSrc(null);
      return;
    }
    const file = cropTarget.file;
    if (!file) {
      setCropSrc(mediaSrc(cropTarget.asset, 1600));
      return;
    }
    const url = URL.createObjectURL(file);
    setCropSrc(url);
    return () => {
      URL.revokeObjectURL(url);
      setCropSrc(null);
    };
  }, [cropTarget]);

  const running = progress !== null;

  const abortRef = useRef<AbortController | null>(null);
  /** True when the reader pressed Stop, so a cancelled file is not reported as a failure. */
  const stoppedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // The transfers belong to a screen that no longer exists. Aborting is what stops three XHRs
      // saturating the uplink for a page nobody is looking at.
      abortRef.current?.abort();
    };
  }, []);

  /**
   * The real-unload guard. Registered only while something is in flight, so a quiet library screen
   * never asks the browser to interrupt a reader who is simply leaving.
   */
  useEffect(() => {
    if (!running) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      // Both, deliberately: `preventDefault()` is the modern spelling and `returnValue` is what
      // several browsers still read. The wording is the browser's — ours is ignored.
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [running]);

  const start = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || abortRef.current !== null) return;

      const controller = new AbortController();
      abortRef.current = controller;
      stoppedRef.current = false;
      setNotice(null);
      setFailures([]);
      setDuplicates([]);
      // The previous batch's rows go with it. Leaving them up would invite a reader to crop — or
      // remove — a file from a drop they finished ten minutes ago while a new one is running, and the
      // `File` handles behind those rows are exactly what we do not want to keep alive (see below).
      setAdded([]);
      setCropping(null);

      let uploaded: StudioMediaAsset[] = [];
      let failed: UploadFailure[] = [];
      let cancelled = false;

      try {
        const result = await uploadFiles(files, {
          signal: controller.signal,
          ...(folderId ? { folderId } : {}),
          ...(kind ? { kind } : {}),
          onProgress: (next) => {
            if (mountedRef.current) setProgress(next);
          }
        });
        // ⚠ BOTH halves are read. See rule 1 in the header.
        uploaded = result.uploaded;
        failed = result.failed;
      } catch (thrown) {
        if (thrown instanceof UploadError) {
          failed = thrown.failed;
          cancelled = thrown.cancelled;
        } else {
          failed = files.map((file) => ({
            file: file.name,
            reason: asApiClientError(thrown).message
          }));
        }
      } finally {
        abortRef.current = null;
        if (mountedRef.current) setProgress(null);
      }

      if (!mountedRef.current) return;

      if (uploaded.length > 0) onUploaded(uploaded);
      // Offered, never forced: an editor who ignores this panel gets exactly today's behaviour — the
      // whole picture cover-fitted into whatever frame the section chose, and the file left where it
      // landed.
      if (uploaded.length > 0) setAdded(pairAdded(files, uploaded));

      const stopped = cancelled || stoppedRef.current;

      // Named even when the reader stopped on purpose: they still need to know WHICH files did not make
      // it, and "cancelled" is one of the reasons the list carries. What changes is the wording of the
      // notice, not whether the names are shown.
      if (failed.length > 0) setFailures(pairFailures(files, failed));

      if (stopped) {
        setNotice(
          uploaded.length === 0
            ? "The upload was stopped and nothing was added."
            : `The upload was stopped. ${
                uploaded.length === 1 ? "1 file had already been added" : `${uploaded.length} files had already been added`
              } and ${failed.length === 1 ? "1 was not sent" : `${failed.length} were not sent`}.`
        );
        return;
      }

      // A short spoken confirmation for the successful part; the failures live on screen, not here.
      if (uploaded.length > 0) {
        toast({
          title:
            failed.length === 0
              ? uploaded.length === 1
                ? "1 file added to the library"
                : `${uploaded.length} files added to the library`
              : `${uploaded.length} of ${uploaded.length + failed.length} files were added`,
          description:
            failed.length === 0
              ? undefined
              : "The ones that did not make it are listed under the drop area, with the reason for each.",
          tone: failed.length === 0 ? "success" : "warn"
        });
      }

      if (uploaded.length === 0) return;

      // The duplicate check is a separate question and is allowed to fail on its own: losing it must
      // never cast doubt on files that are already safely in the library.
      try {
        const report = await post<MediaDuplicateResponse>(MEDIA_ENDPOINTS.duplicates, {
          ids: uploaded.map((asset) => asset.id)
        });
        if (mountedRef.current && report.matches.length > 0) setDuplicates(report.matches);
      } catch (thrown) {
        if (mountedRef.current) {
          setNotice(
            `The files were added, but the library could not check whether any of them were already here. ${
              asApiClientError(thrown).message
            }`
          );
        }
      }
    },
    [folderId, kind, onUploaded, toast]
  );

  const retryFailed = () => {
    const files = failures.map((row) => row.retry).filter((file): file is File => file !== null);
    if (files.length === 0) return;
    void start(files);
  };

  // NOT named `useExisting`: a function whose name begins with "use" is treated as a hook by the lint
  // rules, and this one is called from inside a click handler.
  const switchToExisting = async (match: MediaDuplicateMatch) => {
    setDiscarding(match.uploadedId);
    try {
      // A soft delete — the row goes to the recycle bin and the bytes stay until the purge window
      // passes, so a reader who changes their mind has a way back.
      await del(MEDIA_ENDPOINTS.detail(match.uploadedId));
      if (!mountedRef.current) return;
      setDuplicates((current) => current.filter((entry) => entry.uploadedId !== match.uploadedId));
      // The "Just added" row for the copy that has been discarded says so too. Left alone it would go
      // on offering "Remove" for a file already in the recycle bin, which answers 404 — a reader
      // pressing it would be told something went wrong when nothing had.
      setAdded((current) =>
        current.map((row) =>
          row.asset.id === match.uploadedId ? { ...row, removed: true } : row
        )
      );
      onUseExisting?.(match.existing, match.uploadedId);
    } catch (thrown) {
      if (mountedRef.current) setNotice(asApiClientError(thrown).message);
    } finally {
      if (mountedRef.current) setDiscarding(null);
    }
  };

  /**
   * Store the chosen crop against the asset.
   *
   * `null` clears the crop, which is what "show the whole picture" means. The five fields are always
   * sent together — a row with three of five set is not a rectangle — and the API refuses every other
   * combination rather than storing half of one. The render side treats any incomplete or
   * out-of-range set as "no crop" (`isUsableCrop`), so the worst case is today's behaviour.
   *
   * ⚠ IT DOES NOT RE-ENCODE ANYTHING. Five numbers change on the row; the uploaded bytes, the
   * derivatives and the checksum are all untouched, which is why re-cropping later costs nothing and
   * why this is safe to offer on a file somebody else uploaded two years ago.
   */
  const saveCrop = async (assetId: string, choice: CropChoice | null) => {
    try {
      const updated = await patch<StudioMediaAsset>(MEDIA_ENDPOINTS.detail(assetId), {
        cropX: choice ? choice.rect.x : null,
        cropY: choice ? choice.rect.y : null,
        cropWidth: choice ? choice.rect.width : null,
        cropHeight: choice ? choice.rect.height : null,
        cropAspect: choice ? choice.aspectId : null
      });
      if (!mountedRef.current) return;
      // The PATCHED row replaces the created one, so "Change the crop" reopens on the rectangle that
      // was actually stored rather than on the whole picture. The server is the authority on what the
      // five columns now hold — it clamps nothing, but it does refuse, and a refusal must not leave a
      // row here claiming a crop the database does not have.
      setAdded((current) =>
        current.map((row) =>
          row.asset.id === assetId ? { ...row, asset: updated, cropSettled: true } : row
        )
      );
    } catch (thrown) {
      if (!mountedRef.current) return;
      // On screen rather than in a toast: the reader has just spent time positioning a rectangle and
      // must be told it did not stick, at the moment they would otherwise move on to the next one.
      setNotice(
        `The crop for that picture could not be saved, so the site will keep showing the whole image. ${
          asApiClientError(thrown).message
        }`
      );
    }
  };

  /**
   * Move a file that has just been added to the recycle bin.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * IT ASKS FIRST, EVEN THOUGH IT IS REVERSIBLE. The fault being fixed here is an accidental upload,
   * and answering it with a one-click destroy-adjacent button would only move the accident along one
   * step. The question names the file, because a list of forty rows and a dialog saying "this file"
   * is a dialog nobody can answer.
   *
   * ⚠ WHAT IS USING IT IS NOT KNOWN UNTIL THE SERVER ANSWERS, and the confirmation says so instead of
   * implying nothing can break. Nothing counts references in the browser: the count spans fifteen
   * relations and only `DELETE` computes it — which it does at delete time, so a page that started
   * using the file since it landed is still named. That happens easily here, because this component
   * is mounted inside `MediaPicker`: an author can upload a photograph, put it straight into the
   * article they are writing, and then think better of the photograph. The reply's `message` already
   * names the count and is repeated verbatim.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  const removeUpload = async (row: AddedRow) => {
    if (removing !== null || row.removed) return;

    const agreed = await confirm({
      title: `Move “${row.asset.fileName}” to the recycle bin?`,
      body: (
        <>
          {/*
            ⚠ "AN ADMINISTRATOR CAN PUT IT BACK", NOT "YOU CAN". Removing a file needs
            `canManageMedia`, which is what everybody looking at this panel has; putting it back needs
            `canRestoreDeleted`, which is ADMINISTRATOR only (lib/permissions.ts). Telling a media
            manager they can undo this themselves is a promise the studio refuses to keep, and they
            would discover that only after removing something they wanted.
          */}
          <p>
            It disappears from the library straight away, and nothing is destroyed:{" "}
            {typeof recoveryDays === "number"
              ? `it goes to the recycle bin, where an administrator can put it back for the next ${
                  recoveryDays === 1 ? "1 day" : `${recoveryDays} days`
                }, after which the stored copy is removed for good.`
              : "it goes to the recycle bin, where an administrator can put it back. Studio → Recycle bin states how long this installation keeps it for."}
          </p>
          <p className="mt-2">
            If you have already put this file on a page, that page will be left without a picture. The
            library will say which pages as soon as this is done — nothing here can work that out until
            the file is asked about.
          </p>
        </>
      ),
      confirmLabel: "Move to recycle bin"
    });
    if (!agreed) return;

    setRemoving(row.asset.id);
    try {
      const result = await del<MediaDeleteResponse>(MEDIA_ENDPOINTS.detail(row.asset.id));
      if (!mountedRef.current) return;
      setAdded((current) =>
        current.map((entry) =>
          entry.asset.id === row.asset.id ? { ...entry, removed: true } : entry
        )
      );
      onRemoved?.(row.asset.id);

      // The server's sentence, verbatim: it already names the file, the window and how many records
      // have just lost their picture, and rewording it would stop it matching the audit log.
      if (result.referenceCount > 0) {
        // Left on screen as well as spoken. A toast is `aria-live="polite"`, never interrupts, and may
        // never be read at all — and "four pages now have a hole in them" is not a passing remark.
        setNotice(result.message);
      }
      toast({
        title: `${row.asset.fileName} was moved to the recycle bin`,
        description: result.message,
        tone: result.referenceCount > 0 ? "warn" : "success"
      });
    } catch (thrown) {
      if (mountedRef.current) {
        setNotice(
          `${row.asset.fileName} could not be removed, so it is still in the library. ${
            asApiClientError(thrown).message
          }`
        );
      }
    } finally {
      if (mountedRef.current) setRemoving(null);
    }
  };

  const liveAdded = added.filter((row) => !row.removed);
  const unsettledCrops = liveAdded.filter(
    (row) => hasPicture(row.asset.kind) && !row.cropSettled
  ).length;

  /**
   * The crop the dialog should open on, or null for the whole picture.
   *
   * `?? undefined` on each field because the columns are `number | null` and `isUsableCrop` takes a
   * `Partial<CropRect>`, whose members are `number | undefined`. Widening the predicate instead would
   * weaken the one test the render side relies on.
   */
  const cropTargetRect = cropTarget
    ? (() => {
        const rect = {
          x: cropTarget.asset.cropX ?? undefined,
          y: cropTarget.asset.cropY ?? undefined,
          width: cropTarget.asset.cropWidth ?? undefined,
          height: cropTarget.asset.cropHeight ?? undefined
        };
        return isUsableCrop(rect) ? rect : null;
      })()
    : null;

  const retryable = failures.filter((row) => row.retry !== null).length;
  const visibleRows = progress ? progress.files.slice(0, VISIBLE_PROGRESS_ROWS) : [];
  const hiddenRows = progress ? progress.files.length - visibleRows.length : 0;

  return (
    <div className={cn("min-w-0", className)}>
      <FileDropzone
        onFiles={(files) => void start(files)}
        accept={accept}
        multiple
        disabled={!storageReady || running}
        disabledReason={
          !storageReady
            ? "Uploads are switched off because the file store has not been set up on this installation. An administrator can check Settings for the details."
            : "A batch is being uploaded at the moment. This will be ready again as soon as it finishes."
        }
        title={compact ? "Add files without leaving this dialog" : "Add files to the library"}
      />

      <p className="mt-2 text-xs leading-relaxed text-ink-500">
        New files are filed under <span className="font-medium text-ink-700">{folderLabel}</span>. You
        can move them afterwards, and every original is kept exactly as you uploaded it.
      </p>

      {progress ? (
        <div className="mt-3 rounded-md border border-line-200 bg-surface-50 p-3">
          <ProgressBar
            value={Math.round(progress.overall * 100)}
            label={
              progress.total === 1
                ? "Uploading 1 file"
                : `Uploading ${progress.total} files`
            }
            hint={`${progress.completed} of ${progress.total} finished`}
          />

          <ul className="mt-3 space-y-1.5">
            {visibleRows.map((file, index) => (
              // The index is part of the key because two files in one drop may share a name, and a
              // duplicate React key silently drops a row.
              <li
                key={`${file.file}-${index}`}
                className="flex items-center justify-between gap-3 text-xs"
              >
                <span className="min-w-0 flex-1 truncate text-ink-700">{file.file}</span>
                <span className="shrink-0 tabular-nums text-ink-500">
                  {file.status === "pending"
                    ? "Waiting"
                    : file.status === "uploading"
                      ? `${Math.round(file.progress * 100)}%`
                      : file.status === "finalising"
                        ? "Finishing"
                        : file.status === "done"
                          ? "Added"
                          : "Did not upload"}
                </span>
              </li>
            ))}
          </ul>

          {hiddenRows > 0 ? (
            // The cap, on screen. A list that quietly stops at six is indistinguishable from a batch
            // of six (contract §1.6).
            <p className="mt-2 text-xs text-ink-500">
              {hiddenRows === 1
                ? "1 more file is in this batch and is not listed above."
                : `${hiddenRows} more files are in this batch and are not listed above.`}
            </p>
          ) : null}

          <div className="mt-3">
            <Button
              size="sm"
              variant="ghost"
              icon={X}
              onClick={() => {
                stoppedRef.current = true;
                abortRef.current?.abort();
              }}
            >
              Stop uploading
            </Button>
          </div>
        </div>
      ) : null}

      {failures.length > 0 ? (
        // Rule 1, on screen and staying there. `role="alert"` rather than a status: files have been
        // lost and the reader must know now, not when the reader happens to look.
        <div
          role="alert"
          className="mt-3 rounded-md border border-error-200 bg-error-100 p-3 text-error-700"
        >
          <p className="flex items-start gap-1.5 text-sm font-semibold">
            <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {failures.length === 1
                ? "1 file was not uploaded"
                : `${failures.length} files were not uploaded`}
            </span>
          </p>

          <ul className="mt-2 space-y-2">
            {failures.map((row, index) => (
              <li key={`${row.file}-${index}`} className="text-xs leading-relaxed">
                <span className="block break-all font-medium">{row.file}</span>
                <span className="block">{row.reason}</span>
                {row.retry === null ? (
                  <span className="block italic">
                    This one cannot be retried automatically — choose it again from your computer.
                  </span>
                ) : null}
              </li>
            ))}
          </ul>

          <div className="mt-3 flex flex-wrap gap-2">
            {retryable > 0 ? (
              <Button
                size="sm"
                variant="secondary"
                icon={RefreshCw}
                disabled={running}
                onClick={retryFailed}
              >
                {retryable === 1 ? "Try that file again" : `Try those ${retryable} files again`}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => setFailures([])}>
              Dismiss this list
            </Button>
          </div>
        </div>
      ) : null}

      {duplicates.length > 0 ? (
        <div className="mt-3 rounded-md border border-amber-800/25 bg-amber-100 p-3 text-amber-800">
          <p className="flex items-start gap-1.5 text-sm font-semibold">
            <Copy aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {duplicates.length === 1
                ? "1 file is already in the library"
                : `${duplicates.length} files are already in the library`}
            </span>
          </p>
          <p className="mt-1 text-xs leading-relaxed">
            The contents are identical, not just the name. Using the copy that is already here keeps the
            description and credit somebody has already written for it.
          </p>

          <ul className="mt-3 space-y-2.5">
            {duplicates.map((match) => (
              <li
                key={match.uploadedId}
                className="flex flex-wrap items-center gap-3 rounded-md bg-card p-2.5"
              >
                {hasPicture(match.existing.kind) ? (
                  <MediaImage
                    media={match.existing}
                    aspect={1}
                    rounded="sm"
                    targetWidth={320}
                    sizes="64px"
                    alt=""
                    className="h-16 w-16 shrink-0"
                  />
                ) : null}

                <span className="min-w-0 flex-1 text-xs leading-relaxed text-ink-700">
                  <span className="block break-all font-medium text-ink-900">
                    {match.uploadedFileName}
                  </span>
                  <span className="block">
                    matches <span className="font-medium">{match.existing.fileName}</span>, which was
                    added on{" "}
                    {new Date(match.existing.createdAt).toLocaleDateString("en-GB", {
                      day: "numeric",
                      month: "long",
                      year: "numeric"
                    })}
                    .
                  </span>
                </span>

                <span className="flex shrink-0 flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    isLoading={discarding === match.uploadedId}
                    loadingLabel="switching"
                    onClick={() => void switchToExisting(match)}
                  >
                    Use the existing one
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setDuplicates((current) =>
                        current.filter((entry) => entry.uploadedId !== match.uploadedId)
                      )
                    }
                  >
                    Keep both
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {added.length > 0 ? (
        <div className="mt-3 rounded-md border border-line-200 bg-surface-50 p-3">
          <p className="flex items-start gap-1.5 text-sm font-semibold text-ink-900">
            <CircleCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" />
            <span>
              {added.length === 1 ? "Just added" : `Just added — ${added.length} files`}
            </span>
          </p>
          <p className="mt-1 text-xs leading-relaxed text-ink-700">
            Wrong file? Remove it here — it goes to the recycle bin, and an administrator can put it
            back. And where the site fits a picture into a frame of its own — a wide banner, a card, a
            square tile — it trims from the middle unless you say otherwise, which is often the wrong
            half.
          </p>

          {/*
            No thumbnails in this list, deliberately. Each one would need its own object URL, and an
            object URL pins the entire file in memory until it is revoked — forty photographs is
            comfortably a gigabyte. The name is enough to choose a row, and the picture itself appears
            the instant the row is opened.
          */}
          <ul className="mt-2.5 space-y-1.5">
            {added.map((row) => (
              <li
                key={row.asset.id}
                className={cn(
                  "flex flex-wrap items-center gap-2 rounded-md px-2.5 py-2",
                  // A removed row is kept, greyed, saying what happened. Making it vanish would be a
                  // second thing to be uncertain about a second after the first — "did that work, or
                  // did I remove the one below it?".
                  row.removed ? "bg-surface-100" : "bg-card"
                )}
              >
                <span
                  className={cn(
                    "min-w-0 flex-1 break-all text-xs font-medium",
                    row.removed ? "text-ink-500 line-through" : "text-ink-900"
                  )}
                >
                  {row.asset.fileName}
                </span>

                {row.removed ? (
                  <span className="shrink-0 text-xs text-ink-500">
                    In the recycle bin
                    <span className="sr-only"> — {row.asset.fileName} was removed</span>
                  </span>
                ) : (
                  <>
                    {row.cropSettled ? (
                      <span className="flex shrink-0 items-center gap-1 text-xs text-ink-500">
                        <Crop aria-hidden="true" className="h-3.5 w-3.5" />
                        Crop set
                      </span>
                    ) : null}

                    {hasPicture(row.asset.kind) ? (
                      <Button
                        size="sm"
                        variant={row.cropSettled ? "ghost" : "secondary"}
                        onClick={() => setCropping(row.asset.id)}
                      >
                        {row.cropSettled ? "Change the crop" : "Choose what is shown"}
                        {/*
                          Every row's button would otherwise carry the same four words, and a screen
                          reader listing the buttons on this panel would read forty identical names
                          with nothing to tell them apart. The file name goes into the accessible name
                          and stays out of the visible one, where it would wrap the button to three
                          lines.
                        */}
                        <span className="sr-only"> of {row.asset.fileName}</span>
                      </Button>
                    ) : null}

                    <Button
                      size="sm"
                      variant="ghost"
                      icon={Trash2}
                      isLoading={removing === row.asset.id}
                      loadingLabel="removing"
                      disabled={removing !== null && removing !== row.asset.id}
                      onClick={() => void removeUpload(row)}
                    >
                      Remove
                      <span className="sr-only"> {row.asset.fileName} from the library</span>
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>

          <div className="mt-2.5">
            <Button size="sm" variant="ghost" onClick={() => setAdded([])}>
              {unsettledCrops === 0
                ? "Hide this list"
                : unsettledCrops === 1
                  ? "Leave that one showing the whole picture"
                  : `Leave those ${unsettledCrops} showing the whole picture`}
            </Button>
          </div>
        </div>
      ) : null}

      {/*
        One dialog for the whole list rather than one per row: it is a modal, only one can be open,
        and mounting forty of them would mount forty <img> elements pointed at forty object URLs.
      */}
      <ImageCropper
        open={cropTarget !== null}
        onClose={() => setCropping(null)}
        src={cropSrc}
        fileName={cropTarget?.asset.fileName ?? ""}
        // Reopening a row that has already been cropped reopens ON that crop rather than on the whole
        // picture — `saveCrop` writes the patched row back, so these carry whatever was stored. A
        // rectangle that fails `isUsableCrop` is passed as null and the dialog opens on the whole
        // picture, which is the same degradation the render side makes.
        initialRect={cropTargetRect}
        initialAspectId={cropTarget?.asset.cropAspect ?? undefined}
        onApply={(choice) => {
          const assetId = cropTarget?.asset.id;
          if (!assetId) return;
          return saveCrop(assetId, choice);
        }}
      />

      {notice ? (
        <p
          role="status"
          className="mt-3 flex items-start gap-1.5 rounded-md border border-line-200 bg-surface-50 px-2.5 py-2 text-xs leading-relaxed text-ink-700"
        >
          <CircleCheck aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-500" />
          <span>{notice}</span>
        </p>
      ) : null}

      {!compact && !running && failures.length === 0 ? (
        <p className="mt-2 text-xs leading-relaxed text-ink-500">
          Large files are fine — the only limit is the {formatBytes(MAX_UPLOAD_BYTES)} per file stated
          above. If you close this page while an upload is running, the browser will ask before letting
          you go.
        </p>
      ) : null}
    </div>
  );
}
