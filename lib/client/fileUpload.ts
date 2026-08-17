/**
 * Uploading into the FILE STORE — presign, PUT the bytes, report progress.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS IS NOT `uploadFiles()` FROM lib/client/upload.ts, and the difference is not cosmetic: that
 * function finishes by registering a `MediaAsset`, which is the wrong table for a document. A dataset in
 * the media library would appear in every PICTURE picker and would be purged on the media schedule. What
 * the two share are the CONSTANTS imported below, so the two paths cannot drift apart on what "stalled"
 * means or how large a file may be.
 *
 * ⚠ AND IT DELIBERATELY STOPS AT THE OBJECT. It returns what the register step needs and registers
 * nothing itself, because "the bytes are in storage" and "a `FileAsset` row exists" are two different
 * facts and the callers disagree about the second: the file manager collects a title, a category and a
 * visibility before it registers, while a picker registers immediately with the file's own name as the
 * title. One function that did both would have to take a form's worth of arguments it does not use.
 *
 * ⚠ IT LIVED IN `app/studio/files/FileManager.tsx` AND HAD TO MOVE. Uploading was reachable from exactly
 * one screen, so every other place a document is chosen — a publication, a project, a DOCUMENT_EMBED
 * block on a page or a template — could only offer a list of files somebody had already uploaded
 * somewhere else. An editor with the document in front of them had to leave the form, find the file
 * library, upload, come back and search for it. The code was never screen-specific; only its address was.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { post } from "@/lib/client/fetcher";
import { FINALISE_TIMEOUT_MS, MAX_UPLOAD_BYTES, STALL_TIMEOUT_MS } from "@/lib/client/upload";
import { clamp, formatBytes } from "@/lib/utils";

/**
 * Where a file-store upload is signed.
 *
 * It answers the SAME shape as `/api/studio/media/presign` — `{ uploadUrl, headers, objectKey }` — and is
 * a separate address because the object key belongs in the file store's own prefix rather than under the
 * media library's, and because a file has no `MediaKind`.
 */
export const FILE_PRESIGN_PATH = "/api/studio/files/presign";

/** Where a `FileAsset` row is created once the bytes are up. */
export const FILE_CREATE_PATH = "/api/studio/files";

export interface PresignResponse {
  uploadUrl: string;
  headers: Record<string, string>;
  objectKey: string;
}

export interface UploadedObject {
  objectKey: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
}

/**
 * PUT the bytes straight to storage, reporting progress.
 *
 * ⚠ NOT `uploadFiles()` from lib/client/upload.ts, and the difference is not cosmetic: that function
 * finishes by registering a `MediaAsset`, which is the wrong table for a document — a dataset in the
 * media library would appear in every picture picker and would be purged on the media schedule. What is
 * shared with it are the CONSTANTS below, so the two paths cannot drift apart on what "stalled" means.
 *
 * PROGRESS COMES FROM XMLHttpRequest because `fetch` still cannot report upload progress in any shipping
 * browser, and a 400 MB corpus with no progress at all is indistinguishable from a hang.
 *
 * THE WATCHDOG IS A STALL TIMER, NEVER A FLAT DEADLINE. A fixed timeout dooms a large dataset on a slow
 * link; this one is reset on every progress event, and re-armed generously once the last byte is away
 * because storage emits nothing at all while it finalises a large object.
 */
export function putToStorage(input: {
  url: string;
  headers: Record<string, string>;
  file: File;
  onFraction: (fraction: number) => void;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let watchdog: number | undefined;
    let stallMessage: string | null = null;
    let settled = false;

    const arm = (ms: number, message: string) => {
      if (watchdog !== undefined) window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => {
        stallMessage = message;
        xhr.abort();
      }, ms);
    };

    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      if (watchdog !== undefined) window.clearTimeout(watchdog);
      if (error) reject(error);
      else resolve();
    };

    xhr.upload.addEventListener("progress", (event) => {
      arm(
        STALL_TIMEOUT_MS,
        "The upload stopped moving for a minute and was abandoned. Check the connection and try again — nothing has been changed."
      );
      const total = event.lengthComputable && event.total > 0 ? event.total : input.file.size;
      input.onFraction(total > 0 ? clamp(event.loaded / total, 0, 1) : 0);
    });

    xhr.upload.addEventListener("loadend", () => {
      input.onFraction(1);
      arm(
        FINALISE_TIMEOUT_MS,
        "Storage accepted the file but never confirmed it, even after five minutes. Try uploading it again."
      );
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        finish(null);
        return;
      }
      if (xhr.status === 403) {
        finish(
          new Error(
            "Storage refused this upload. The signed link had probably expired — try again, and if it keeps happening the storage credentials need checking."
          )
        );
        return;
      }
      finish(new Error(`Storage refused this upload with HTTP ${xhr.status}.`));
    });

    xhr.addEventListener("error", () => {
      // Status 0 with no response is also what a missing CORS rule on the bucket looks like, which is by
      // far the most common cause the first time a deployment is wired up.
      finish(
        new Error(
          "The upload could not reach storage. Either the connection dropped or the storage bucket is not accepting uploads from this site."
        )
      );
    });

    xhr.addEventListener("abort", () => {
      finish(new Error(stallMessage ?? "The upload was interrupted."));
    });

    xhr.open("PUT", input.url, true);
    xhr.responseType = "text";

    // ⚠ THE SIGNED HEADERS ARE REPLAYED EXACTLY. `Content-Type` is part of the signature, so sending a
    // different one comes back as a signature mismatch — which reads like a credentials problem and
    // sends the reader hunting through IAM for an hour.
    let sentContentType = false;
    for (const [name, value] of Object.entries(input.headers)) {
      xhr.setRequestHeader(name, value);
      if (name.toLowerCase() === "content-type") sentContentType = true;
    }
    if (!sentContentType) xhr.setRequestHeader("content-type", input.file.type || "application/octet-stream");

    arm(
      STALL_TIMEOUT_MS,
      "The upload never started moving and was abandoned after a minute. Check the connection and try again."
    );
    xhr.send(input.file);
  });
}

/** Presign, PUT, and hand back what the register step needs. Throws with a sentence ready to render. */
export async function uploadToFileStore(file: File, onFraction: (fraction: number) => void): Promise<UploadedObject> {
  if (file.size === 0) {
    throw new Error(
      "That file is empty (0 bytes). If you dragged a folder in, open it and choose the files inside."
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    // The message states BOTH numbers: "too large" leaves the reader guessing whether trimming a little
    // would help, and here the answer is no.
    throw new Error(
      `That file is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_UPLOAD_BYTES)}. Split it, compress it, or ask an administrator to raise the limit.`
    );
  }

  const contentType = file.type.trim().length > 0 ? file.type.trim() : "application/octet-stream";

  const presigned = await post<PresignResponse>(FILE_PRESIGN_PATH, {
    fileName: file.name,
    contentType,
    byteSize: file.size
  });

  await putToStorage({
    url: presigned.uploadUrl,
    headers: presigned.headers,
    file,
    onFraction
  });

  return {
    objectKey: presigned.objectKey,
    fileName: file.name,
    mimeType: contentType,
    byteSize: file.size
  };
}
