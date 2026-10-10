/**
 * How large an upload may be, and what its integrity fingerprint must look like.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS MODULE IS IMPORTED BY BOTH HALVES, AND THAT IS WHY IT HAS NO IMPORTS OF ITS OWN.
 *
 * The older caps (`MAX_UPLOAD_BYTES`) are restated in five files because lib/client/upload.ts is
 * `"use client"` and a route cannot read a plain constant from it. This file is neither `"use client"`
 * nor `server-only` and touches nothing but literals, so the presign routes (authoritative) and the
 * browser (early refusal, before a byte is hashed or sent) read the SAME numbers. Keep it that way: an
 * import of `node:crypto`, `@/lib/env` or Prisma here would drag the server into the browser bundle.
 *
 * ══ WHY A SIZE AND A CHECKSUM ARE REQUIRED AT ALL ══
 *
 * A presigned PUT that names neither lets whoever holds the URL — for its whole lifetime — write ANY
 * number of bytes of ANY content under the key. The cap was then only enforced by the browser and by a
 * `HEAD` long after the bytes had landed. `presignUpload` (lib/storage/client.ts) now SIGNS both:
 * `Content-Length` so storage refuses a body of any other size, and `x-amz-checksum-sha256` so storage
 * refuses a body whose SHA-256 is not the one the browser declared. The finalize routes then `HEAD` the
 * object and compare all three (size, checksum, content type) against the signed upload ticket
 * (lib/storage/upload-ticket.ts) before a row is written.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

const MB = 1024 * 1024;

/** `MediaKind` restated, for the same reason lib/client/upload.ts restates it: no Prisma in the browser. */
export type UploadMediaKind = "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT" | "MODEL_3D" | "PANORAMA";

/**
 * The per-kind cap for the MEDIA LIBRARY, by the kind the file will be STORED as.
 *
 * Video and 3D models keep the historical 200 MB, which is the number every screen states. The rest are
 * lower because nothing legitimate of those kinds needs more and the derivative/probe paths decode
 * images in memory: a 150 MB heritage TIFF is already well past the 80 MB derivative limit in
 * media/complete. An SVG is stored as a DOCUMENT, so it is held to the document cap.
 */
export const MEDIA_MAX_BYTES_BY_KIND: Readonly<Record<UploadMediaKind, number>> = {
  IMAGE: 150 * MB,
  PANORAMA: 150 * MB,
  VIDEO: 200 * MB,
  MODEL_3D: 200 * MB,
  AUDIO: 100 * MB,
  DOCUMENT: 100 * MB
};

/** The FILE STORE's single cap. Research datasets and archives are its whole point. */
export const FILE_STORE_MAX_BYTES = 200 * MB;

/** The largest cap anywhere: what a dropzone states up front before it knows what the file is. */
export const ABSOLUTE_MAX_UPLOAD_BYTES = Math.max(FILE_STORE_MAX_BYTES, ...Object.values(MEDIA_MAX_BYTES_BY_KIND));

export function mediaMaxBytes(kind: UploadMediaKind): number {
  return MEDIA_MAX_BYTES_BY_KIND[kind];
}

/**
 * A SHA-256 digest in the form S3 wants it in `x-amz-checksum-sha256`: standard base64 (NOT base64url)
 * of the 32 raw bytes — always 43 characters plus one `=`.
 *
 * Checked by shape rather than decoded and re-encoded loosely, because a value storage cannot parse is
 * refused at PUT time as `InvalidRequest`, which the reader sees as an unexplained storage failure.
 * The final character is limited to the four values whose low bits are zero, so only canonical
 * encodings pass and the same digest cannot be spelled two ways.
 */
const SHA256_BASE64 = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;

export function isSha256Base64(value: unknown): value is string {
  return typeof value === "string" && SHA256_BASE64.test(value);
}

/**
 * The same digest as lower-case hex — the form the `checksum` columns have always stored (they were
 * filled by `createHash("sha256").digest("hex")`), so duplicate detection keeps matching old rows.
 */
export function sha256Hex(base64: string): string {
  if (!isSha256Base64(base64)) throw new Error("Not a base64 SHA-256 digest.");
  let hex = "";
  for (const char of atob(base64)) hex += char.charCodeAt(0).toString(16).padStart(2, "0");
  return hex;
}

/** The same message everywhere a missing or malformed fingerprint is refused. */
export const SHA256_REQUIRED_MESSAGE =
  "The upload did not include a valid SHA-256 fingerprint of the file, so it was refused. Reload the page and try again.";
