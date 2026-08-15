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
import { CircleCheck, Copy, RefreshCw, TriangleAlert, X } from "lucide-react";

import { asApiClientError, del, post } from "@/lib/client/fetcher";
import {
  ACCEPTED_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  UploadError,
  uploadFiles,
  type MediaKindName,
  type UploadFailure,
  type UploadProgress
} from "@/lib/client/upload";
import { cn, formatBytes } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { FileDropzone } from "@/components/ui/FileDropzone";
import { MediaImage } from "@/components/ui/MediaImage";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { useToast } from "@/components/ui/ToastProvider";
import {
  MEDIA_ENDPOINTS,
  hasPicture,
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

export function UploadQueue({
  folderId,
  folderLabel,
  storageReady,
  onUploaded,
  onUseExisting,
  accept = ACCEPTED_CONTENT_TYPES,
  kind,
  compact = false,
  className
}: UploadQueueProps) {
  const { toast } = useToast();

  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [failures, setFailures] = useState<FailureRow[]>([]);
  const [duplicates, setDuplicates] = useState<MediaDuplicateMatch[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<string | null>(null);

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
      onUseExisting?.(match.existing, match.uploadedId);
    } catch (thrown) {
      if (mountedRef.current) setNotice(asApiClientError(thrown).message);
    } finally {
      if (mountedRef.current) setDiscarding(null);
    }
  };

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
