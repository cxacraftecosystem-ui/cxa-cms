"use client";

/**
 * The browser half of the direct-to-storage upload.
 *
 * Bytes never pass through the application server. Three steps, and the shapes of all three are
 * written out below so the two halves of this feature cannot drift apart in separate files:
 *
 *   1. POST /api/studio/media/presign
 *        → { fileName: string; contentType: string; byteSize: number; kind: MediaKindName }
 *        ← { uploadUrl: string; headers: Record<string, string>; objectKey: string;
 *            expiresInSeconds: number }
 *   2. PUT <uploadUrl>  — the raw File as the body, with `headers` replayed VERBATIM.
 *   3. POST /api/studio/media/complete
 *        → { objectKey: string; fileName: string; contentType: string; byteSize: number;
 *            folderId?: string }
 *        ← the created MediaAsset (JSON: dates are ISO strings, not Date objects)
 *
 * ⚠ THE ONE THING EVERY CALLER MUST DO. `uploadFiles` RESOLVES with a populated `failed` list when
 * SOME files fail; it throws only when NOTHING landed. A caller that treats a resolved promise as
 * "all done" silently loses files — the editor sees a success toast, the library is short two
 * photographs, and nobody finds out until a page is published with a gap in it. **Inspect `failed`
 * and NAME the files that did not make it.** `summariseFailures()` exists so that sentence does not
 * have to be reinvented at every call site.
 *
 * Three further decisions worth knowing before changing anything here:
 *
 *   • THE SIGNED HEADERS ARE REPLAYED EXACTLY. `Content-Type` is part of the signature, so sending a
 *     different one comes back as a signature mismatch — which reads like a credentials problem and
 *     sends the reader hunting through IAM for an hour. If the presign response carries no
 *     content-type we set the one we asked to sign, because XHR would otherwise infer its own from
 *     the Blob and that inferred value is what breaks the signature.
 *   • PROGRESS COMES FROM XMLHttpRequest. `fetch` still cannot report upload progress in any shipping
 *     browser, so the PUT (and only the PUT) is an XHR wrapped in a promise.
 *   • THE WATCHDOG IS A STALL TIMER, NEVER A FLAT DEADLINE. A fixed `xhr.timeout` dooms a large video
 *     on a slow link and burns every retry with it. Instead the timer is reset on every progress
 *     event, and once the last byte is away it is re-armed for five minutes — storage emits no
 *     progress at all while it finalises a large object, and a silent connection there is normal.
 */

import { asApiClientError, post } from "@/lib/client/fetcher";
import type { MediaLike } from "@/lib/media/url";
import { clamp, formatBytes } from "@/lib/utils";

/** Nothing over this is accepted, and the message always states both numbers. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** No movement for this long means the connection is dead, whatever the socket still believes. */
export const STALL_TIMEOUT_MS = 60_000;

/** Grace after the last byte, while storage writes and checksums the object. */
export const FINALISE_TIMEOUT_MS = 5 * 60_000;

/**
 * Three at a time.
 *
 * Twenty parallel PUTs on a domestic uplink make every one of them slow, none of them finish first,
 * and the first failure is ambiguous because they were all starved by each other.
 */
export const UPLOAD_CONCURRENCY = 3;

/**
 * `MediaKind` from the Prisma schema, restated as a string union.
 *
 * Deliberately NOT imported from `@prisma/client`: that import pulls the generated client — and the
 * engine bindings it references — into the browser bundle. The two lists must be kept in step by
 * hand, which is cheap because the enum only changes when a new kind of thing can be stored.
 */
export type MediaKindName = "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT" | "MODEL_3D" | "PANORAMA";

/**
 * The allow-list, and the kind each type implies.
 *
 * An allow-list rather than a deny-list: the derivative pipeline, the thumbnailer and the viewers all
 * assume they were handed something they understand, and a `.exe` renamed to `.png` is not the thing
 * to discover downstream. PANORAMA and MODEL_3D are absent on purpose — a panorama is an ordinary
 * JPEG on the wire and can only ever be declared by the caller (see `UploadOptions.kind`).
 */
const CONTENT_TYPE_KINDS: Readonly<Record<string, MediaKindName>> = {
  "image/jpeg": "IMAGE",
  "image/png": "IMAGE",
  "image/webp": "IMAGE",
  "image/avif": "IMAGE",
  "image/gif": "IMAGE",
  "image/tiff": "IMAGE",
  "image/svg+xml": "IMAGE",

  "video/mp4": "VIDEO",
  "video/webm": "VIDEO",
  "video/quicktime": "VIDEO",

  "audio/mpeg": "AUDIO",
  "audio/mp4": "AUDIO",
  "audio/ogg": "AUDIO",
  "audio/wav": "AUDIO",
  "audio/x-wav": "AUDIO",
  "audio/webm": "AUDIO",

  "application/pdf": "DOCUMENT",
  "application/msword": "DOCUMENT",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCUMENT",
  "application/vnd.ms-excel": "DOCUMENT",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "DOCUMENT",
  "application/vnd.ms-powerpoint": "DOCUMENT",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "DOCUMENT",
  "application/zip": "DOCUMENT",
  "text/plain": "DOCUMENT",
  "text/csv": "DOCUMENT",

  "model/gltf-binary": "MODEL_3D",
  "model/gltf+json": "MODEL_3D"
};

/** For the `accept` attribute on a file input, and for the rules line a dropzone shows up front. */
export const ACCEPTED_CONTENT_TYPES: readonly string[] = Object.keys(CONTENT_TYPE_KINDS);

/** The same rule as a sentence, for readers who do not think in MIME types. */
export const ACCEPTED_TYPES_SUMMARY =
  "Images, video, audio, PDFs, Office documents, plain text and glTF models";

/** The kind implied by a content type, or null when the type is not accepted at all. */
export function kindForContentType(contentType: string): MediaKindName | null {
  return CONTENT_TYPE_KINDS[contentType.toLowerCase().trim()] ?? null;
}

export interface UploadFailure {
  /** The file's own name — this is what the reader recognises, so it is what gets reported. */
  file: string;
  /** A plain sentence, ready to render. Never a code, never an exception's `.message`. */
  reason: string;
}

export type UploadFileStatus = "pending" | "uploading" | "finalising" | "done" | "failed";

export interface UploadFileProgress {
  file: string;
  status: UploadFileStatus;
  /** 0–1 for this file alone. */
  progress: number;
  /** Present only once `status` is "failed". */
  reason?: string;
}

export interface UploadProgress {
  /** 0–1 across the whole batch, weighted by BYTES — ten thumbnails and one film are not eleven equal steps. */
  overall: number;
  /** Files that have settled, successfully or not. */
  completed: number;
  total: number;
  /** Per-file state, in the order the files were given. */
  files: UploadFileProgress[];
}

/**
 * The created asset as it arrives over JSON.
 *
 * `createdAt`/`updatedAt` are ISO STRINGS, not `Date`s — JSON has no date type and the fetcher does
 * not revive them. Extending `MediaLike` is load-bearing: it means a freshly uploaded asset can be
 * handed straight to `<MediaImage>` without a cast or a re-fetch.
 */
export interface UploadedMediaAsset extends MediaLike {
  id: string;
  kind: MediaKindName;
  objectKey: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  checksum: string | null;
  blurDataUrl: string | null;
  altText: string | null;
  caption: string | null;
  credit: string | null;
  copyright: string | null;
  tags: string[];
  folderId: string | null;
  uploaderId: string | null;
  createdAt: string;
  updatedAt: string;
  variants?: { label: string; format: string; objectKey: string; width: number }[];
}

export interface UploadResult {
  uploaded: UploadedMediaAsset[];
  /** ⚠ Read this even when the promise resolved. See the file header. */
  failed: UploadFailure[];
}

export interface UploadOptions {
  onProgress?: (progress: UploadProgress) => void;
  folderId?: string;
  signal?: AbortSignal;
  /**
   * Force the stored kind. Only ever needed for PANORAMA and MODEL_3D, which are indistinguishable
   * from an ordinary image or binary by content type alone.
   */
  kind?: MediaKindName;
}

/**
 * Thrown ONLY when the batch produced nothing at all.
 *
 * It still carries the per-file reasons, because "the upload failed" without the names is a message
 * the reader cannot act on. `cancelled` is true when the caller aborted, so a UI can stay quiet about
 * something the reader did on purpose.
 */
export class UploadError extends Error {
  readonly failed: UploadFailure[];
  readonly cancelled: boolean;

  constructor(message: string, failed: UploadFailure[], cancelled: boolean) {
    super(message);
    this.name = "UploadError";
    this.failed = failed;
    this.cancelled = cancelled;
  }
}

interface PresignResponse {
  uploadUrl: string;
  headers: Record<string, string>;
  objectKey: string;
  expiresInSeconds: number;
}

/**
 * One sentence naming the files that did not make it, with the count and any truncation stated.
 *
 * Exported because the rule in the file header ("name the files") only holds if naming them is the
 * easy thing to do. A list that quietly stops at three is indistinguishable from a batch where only
 * three failed (contract §6), so the remainder is counted out loud.
 */
export function summariseFailures(failed: readonly UploadFailure[], maxNamed = 3): string {
  if (failed.length === 0) return "";
  const named = failed.slice(0, Math.max(1, maxNamed));
  const parts = named.map((entry) => `${entry.file} — ${entry.reason}`);
  const remainder = failed.length - named.length;
  const head = failed.length === 1 ? "1 file was not uploaded" : `${failed.length} files were not uploaded`;
  const tail =
    remainder > 0
      ? ` ${remainder === 1 ? "1 more file also failed" : `${remainder} more files also failed`}.`
      : "";
  return `${head}: ${parts.join("; ")}.${tail}`;
}

/**
 * Everything that disqualifies a file before a single byte leaves the machine, as a sentence, or null
 * when the file is fine.
 *
 * Each message states the OFFENDING VALUE and the RULE. "That file is too large" leaves the reader
 * guessing whether trimming a little would help; "This file is 512 MB; the limit is 200 MB" tells
 * them the answer is no.
 */
function precheck(file: File, forcedKind: MediaKindName | undefined): string | null {
  if (file.size === 0) {
    return "This file is empty (0 bytes). If you dragged a folder in, open it and select the files inside.";
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `This file is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_UPLOAD_BYTES)}. Compress it or upload it as a linked file instead.`;
  }
  const contentType = file.type.trim();
  if (contentType.length === 0) {
    return "The browser could not tell what type of file this is, usually because it has no extension. Rename it with the correct extension and try again.";
  }
  if (!forcedKind && !kindForContentType(contentType)) {
    return `Files of type ${contentType} are not accepted. ${ACCEPTED_TYPES_SUMMARY} can be uploaded.`;
  }
  return null;
}

/**
 * S3 and its compatibles answer a refused PUT with an XML body whose `<Code>` is the only part worth
 * repeating — `SignatureDoesNotMatch`, `EntityTooLarge`, `AccessDenied`. Sliced first, because a
 * regular expression over a multi-megabyte error page is its own small disaster.
 */
function storageErrorCode(responseText: string): string | null {
  const match = /<Code>([^<]{1,64})<\/Code>/.exec(responseText.slice(0, 2000));
  return match?.[1] ?? null;
}

interface PutInput {
  url: string;
  headers: Record<string, string>;
  file: File;
  contentType: string;
  signal: AbortSignal | undefined;
  onBytes: (loaded: number, total: number) => void;
  onLastByte: () => void;
}

/**
 * The PUT itself, as a promise, with the stall watchdog.
 *
 * Rejects with an `Error` whose message is already a readable sentence; the caller does not
 * re-interpret it.
 */
function putWithProgress(input: PutInput): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    let watchdog: number | undefined;
    let stallMessage: string | null = null;
    let cancelledByCaller = false;
    let settled = false;

    const clearWatchdog = () => {
      if (watchdog !== undefined) {
        window.clearTimeout(watchdog);
        watchdog = undefined;
      }
    };

    const arm = (ms: number, message: string) => {
      clearWatchdog();
      watchdog = window.setTimeout(() => {
        stallMessage = message;
        xhr.abort();
      }, ms);
    };

    const onAbortSignal = () => {
      cancelledByCaller = true;
      xhr.abort();
    };

    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      input.signal?.removeEventListener("abort", onAbortSignal);
      if (error) reject(error);
      else resolve();
    };

    if (input.signal) {
      if (input.signal.aborted) {
        finish(new Error("This file was cancelled before it was sent."));
        return;
      }
      input.signal.addEventListener("abort", onAbortSignal);
    }

    xhr.upload.addEventListener("progress", (event) => {
      // Every byte resets the clock. This — not a deadline — is what distinguishes "the connection
      // died" from "this is a 900 MB film on a domestic uplink".
      arm(STALL_TIMEOUT_MS, "The upload stopped moving for a minute and was abandoned. Check the connection and try again.");
      const total = event.lengthComputable && event.total > 0 ? event.total : input.file.size;
      input.onBytes(event.loaded, total);
    });

    xhr.upload.addEventListener("loadend", () => {
      // The body is away. There will be no further progress events while storage writes and
      // checksums the object, so the watchdog is re-armed generously rather than left at 60s.
      input.onLastByte();
      arm(FINALISE_TIMEOUT_MS, "Storage accepted the file but never confirmed it, even after five minutes. Try uploading it again.");
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        finish(null);
        return;
      }
      const code = storageErrorCode(typeof xhr.responseText === "string" ? xhr.responseText : "");
      const detail = code ? ` (${code})` : "";
      if (xhr.status === 403) {
        finish(
          new Error(
            `Storage refused this upload${detail}. The signed link had probably expired — try again, and if it keeps happening the storage credentials need checking.`
          )
        );
        return;
      }
      finish(new Error(`Storage refused this upload with HTTP ${xhr.status}${detail}.`));
    });

    xhr.addEventListener("error", () => {
      // Status 0 with no response is also what a missing CORS rule on the bucket looks like, and that
      // is by far the most common cause the first time a deployment is wired up.
      finish(
        new Error(
          "The upload could not reach storage. Either the connection dropped or the storage bucket is not accepting uploads from this site."
        )
      );
    });

    xhr.addEventListener("abort", () => {
      if (stallMessage) {
        finish(new Error(stallMessage));
        return;
      }
      finish(new Error(cancelledByCaller ? "This file was cancelled." : "The upload was interrupted."));
    });

    xhr.open("PUT", input.url, true);
    // No `xhr.timeout` anywhere in this function, deliberately: that is the flat deadline the
    // watchdog above exists to replace.
    xhr.responseType = "text";

    let sentContentType = false;
    for (const [name, value] of Object.entries(input.headers)) {
      xhr.setRequestHeader(name, value);
      if (name.toLowerCase() === "content-type") sentContentType = true;
    }
    if (!sentContentType) xhr.setRequestHeader("content-type", input.contentType);

    // The stall clock starts now: a connection that never produces a first progress event is exactly
    // as stuck as one that stops halfway.
    arm(STALL_TIMEOUT_MS, "The upload never started moving and was abandoned after a minute. Check the connection and try again.");
    xhr.send(input.file);
  });
}

interface FileJob {
  file: File;
  state: UploadFileProgress;
  loaded: number;
  settled: boolean;
  asset?: UploadedMediaAsset;
}

/**
 * Run `worker` over `items`, `limit` at a time, in the order given.
 *
 * The cursor is read and advanced in one expression; JavaScript's single thread makes that atomic, so
 * no two runners can take the same item. Items are handed to the worker rather than indices, which
 * keeps `noUncheckedIndexedAccess` honest without a single non-null assertion.
 */
async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const take = (): T | undefined => (cursor < items.length ? items[cursor++] : undefined);

  const runners: Promise<void>[] = [];
  for (let slot = 0; slot < Math.min(limit, items.length); slot += 1) {
    runners.push(
      (async () => {
        for (let item = take(); item !== undefined; item = take()) {
          await worker(item);
        }
      })()
    );
  }
  await Promise.all(runners);
}

/**
 * Upload files straight to object storage and register each one as a MediaAsset.
 *
 * ⚠ **PARTIAL FAILURE RESOLVES, IT DOES NOT THROW.** If eight of ten files land, this resolves with
 * eight in `uploaded` and two in `failed`. A caller that ignores `failed` reports a success the
 * reader will believe and quietly loses two files. Inspect `failed` and NAME the files in whatever
 * you show — `summariseFailures()` writes that sentence for you.
 *
 * It throws `UploadError` only when NOTHING landed (and never for an empty selection, which is not a
 * failure). The error still carries the same per-file reasons.
 *
 * @param files    A `FileList` from an input, or any array of `File`s.
 * @param options  `onProgress` is called on every byte and every state change; `signal` aborts the
 *                 whole batch, in-flight transfers included.
 */
export async function uploadFiles(
  files: readonly File[] | FileList,
  options: UploadOptions = {}
): Promise<UploadResult> {
  if (typeof window === "undefined") {
    throw new UploadError("Files can only be uploaded from a browser.", [], false);
  }

  const list = Array.from(files);
  if (list.length === 0) return { uploaded: [], failed: [] };

  const { onProgress, folderId, signal, kind: forcedKind } = options;

  const jobs: FileJob[] = list.map((file) => ({
    file,
    state: { file: file.name, status: "pending", progress: 0 },
    loaded: 0,
    settled: false
  }));

  const totalBytes = jobs.reduce((sum, job) => sum + job.file.size, 0);

  const emit = () => {
    if (!onProgress) return;
    let loaded = 0;
    let completed = 0;
    for (const job of jobs) {
      // A settled file counts its whole size whether it succeeded or failed, otherwise a batch with
      // one rejected file stops at 94% for ever and reads as a hang.
      loaded += job.settled ? job.file.size : job.loaded;
      if (job.settled) completed += 1;
    }
    const overall =
      totalBytes > 0 ? clamp(loaded / totalBytes, 0, 1) : clamp(completed / jobs.length, 0, 1);
    onProgress({
      overall,
      completed,
      total: jobs.length,
      files: jobs.map((job) => ({ ...job.state }))
    });
  };

  const fail = (job: FileJob, reason: string) => {
    job.state.status = "failed";
    job.state.reason = reason;
    job.settled = true;
    emit();
  };

  emit();

  await runPool(jobs, UPLOAD_CONCURRENCY, async (job) => {
    if (signal?.aborted) {
      fail(job, "This file was cancelled before it was sent.");
      return;
    }

    const problem = precheck(job.file, forcedKind);
    if (problem) {
      fail(job, problem);
      return;
    }

    const contentType = job.file.type.trim();
    const kind = forcedKind ?? kindForContentType(contentType);
    if (!kind) {
      // `precheck` already covers this; the branch exists so `kind` narrows to a string below.
      fail(job, `Files of type ${contentType} are not accepted. ${ACCEPTED_TYPES_SUMMARY} can be uploaded.`);
      return;
    }

    job.state.status = "uploading";
    emit();

    let presigned: PresignResponse;
    try {
      presigned = await post<PresignResponse>(
        "/api/studio/media/presign",
        {
          fileName: job.file.name,
          contentType,
          byteSize: job.file.size,
          kind
        },
        { signal }
      );
    } catch (thrown) {
      if (signal?.aborted) {
        fail(job, "This file was cancelled before it was sent.");
        return;
      }
      // The server's `message` is already a plain sentence (lib/api.ts guarantees it), so it is
      // repeated verbatim rather than reworded into something less specific.
      fail(job, asApiClientError(thrown).message);
      return;
    }

    try {
      await putWithProgress({
        url: presigned.uploadUrl,
        headers: presigned.headers,
        file: job.file,
        contentType,
        signal,
        onBytes: (loaded, total) => {
          job.loaded = Math.min(loaded, job.file.size);
          job.state.progress = total > 0 ? clamp(loaded / total, 0, 1) : 0;
          emit();
        },
        onLastByte: () => {
          job.loaded = job.file.size;
          job.state.progress = 1;
          job.state.status = "finalising";
          emit();
        }
      });
    } catch (thrown) {
      fail(job, thrown instanceof Error ? thrown.message : "The upload failed for an unknown reason.");
      return;
    }

    try {
      const asset = await post<UploadedMediaAsset>(
        "/api/studio/media/complete",
        {
          objectKey: presigned.objectKey,
          fileName: job.file.name,
          contentType,
          byteSize: job.file.size,
          ...(folderId ? { folderId } : {})
        },
        { signal }
      );
      job.asset = asset;
      job.state.status = "done";
      job.state.progress = 1;
      job.settled = true;
      emit();
    } catch (thrown) {
      if (signal?.aborted) {
        // The bytes are in the bucket but no row was written. Said plainly, because an administrator
        // will otherwise be puzzled by an orphaned object the purge job eventually collects.
        fail(job, "The file reached storage but was cancelled before it was added to the library.");
        return;
      }
      fail(job, asApiClientError(thrown).message);
    }
  });

  const uploaded: UploadedMediaAsset[] = [];
  const failed: UploadFailure[] = [];
  for (const job of jobs) {
    if (job.asset) {
      uploaded.push(job.asset);
      continue;
    }
    failed.push({
      file: job.file.name,
      reason: job.state.reason ?? "The upload did not finish, and no reason was reported."
    });
  }

  if (uploaded.length === 0) {
    throw new UploadError(summariseFailures(failed), failed, Boolean(signal?.aborted));
  }

  return { uploaded, failed };
}
