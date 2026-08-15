import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, assertSameOrigin, badRequest, ok, parseJson, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { canManageMedia } from "@/lib/permissions";
import { presignUpload, requireStorage } from "@/lib/storage/client";
import { buildObjectKey } from "@/lib/storage/keys";
import { isSvg } from "@/lib/storage/derivatives";
import { formatBytes } from "@/lib/utils";

/**
 * Step 1 of 3 of the direct-to-storage upload: hand the browser a signed PUT.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE SHAPE OF THIS ANSWER IS FIXED BY `lib/client/upload.ts`, which documents all three steps in
 * its header and hard-codes this address. It takes
 * `{ fileName, contentType, byteSize, kind }` and returns
 * `{ uploadUrl, headers, objectKey, expiresInSeconds }`. `MediaDetailPanel`'s file replacement calls
 * the same address for the same shape. Changing a key name here breaks both, silently, at runtime.
 *
 * THE SIGNED HEADERS ARE RETURNED VERBATIM AND MUST BE REPLAYED VERBATIM. `Content-Type` is part of
 * the signature, so a browser that sends a different one is refused with a signature mismatch — which
 * reads like a credentials problem and sends whoever is debugging it through IAM for an hour.
 *
 * IT IS AN ALLOW-LIST, NEVER A DENY-LIST. The derivative pipeline, the thumbnailer and the 3D viewer
 * all assume they were handed something they understand, and a `.exe` renamed to `.png` is not the
 * thing to find out about downstream. A deny-list is a list of the attacks somebody had already
 * thought of.
 *
 * AN SVG IS A DOCUMENT, NOT A PICTURE. It can carry `<script>`, external references and XXE payloads,
 * so serving one inline from this origin is a stored-XSS primitive (lib/storage/derivatives.ts).
 * The browser's own allow-list files `image/svg+xml` under IMAGE; this route accepts the upload and
 * `complete` stores it as a DOCUMENT, which keeps it out of every picture picker and out of the
 * derivative pipeline. Refusing it outright was the alternative and it is worse: an editor with a
 * perfectly ordinary logo would be told "not accepted" with no way forward.
 *
 * NOTHING IS WRITTEN TO THE DATABASE HERE. A signed URL is a promise, not a fact — the row is created
 * by `complete`, and only after `headObject` has confirmed the bytes actually landed.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * The per-file cap, server-side and authoritative.
 *
 * ⚠ It MIRRORS `MAX_UPLOAD_BYTES` in lib/client/upload.ts and the two must move together. It is
 * restated rather than imported because that module is `"use client"`: importing it from a route
 * handler replaces the module with client references and reading a plain constant from it fails at
 * runtime. The browser's copy exists to refuse a 500 MB file before a byte leaves the machine; this
 * one is the one that actually matters.
 */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** How long the signed PUT is good for. Long enough for a large file on a domestic uplink. */
const PRESIGN_EXPIRY_SECONDS = 15 * 60;

const MEDIA_KINDS = ["IMAGE", "VIDEO", "AUDIO", "DOCUMENT", "MODEL_3D", "PANORAMA"] as const;
type MediaKindName = (typeof MEDIA_KINDS)[number];

/**
 * Content type → the kind it implies.
 *
 * ⚠ In step with `CONTENT_TYPE_KINDS` in lib/client/upload.ts, for the same reason the size cap is:
 * that file is `"use client"`. PANORAMA and MODEL_3D are absent on purpose — a panorama is an
 * ordinary JPEG on the wire and can only ever be DECLARED by the caller.
 */
const ALLOWED_CONTENT_TYPES: Readonly<Record<string, MediaKindName>> = {
  "image/jpeg": "IMAGE",
  "image/png": "IMAGE",
  "image/webp": "IMAGE",
  "image/avif": "IMAGE",
  "image/gif": "IMAGE",
  "image/tiff": "IMAGE",
  // Accepted, then filed as a DOCUMENT by `resolveKind` below. See the header.
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

/** One sentence for readers who do not think in MIME types. Mirrors ACCEPTED_TYPES_SUMMARY. */
const ACCEPTED_SUMMARY =
  "Images, video, audio, PDFs, Office documents, plain text and glTF models can be uploaded.";

const PresignBody = z.object({
  fileName: z
    .string()
    .trim()
    .min(1, "The file has no name, so there is nothing to store it under.")
    .max(255, "That file name is longer than 255 characters. Rename it and try again."),
  contentType: z
    .string()
    .trim()
    .min(1, "The browser could not tell what type of file this is, usually because it has no extension.")
    .max(160),
  byteSize: z
    .number()
    .int("A file size has to be a whole number of bytes.")
    .positive("This file is empty (0 bytes). If you dragged a folder in, open it and choose the files inside."),
  kind: z.enum(MEDIA_KINDS)
});

/**
 * The kind this file will actually be stored as, or a sentence saying why it cannot be stored.
 *
 * The caller's `kind` is a DECLARATION, not a fact, so it is checked against the content type rather
 * than trusted. Three rules:
 *
 *   • an SVG is always a DOCUMENT, whatever was declared (see the header);
 *   • PANORAMA is only ever an image, and MODEL_3D only ever a model — those two exist precisely
 *     because the wire format cannot distinguish them, so they are the only overrides allowed;
 *   • anything else must match the kind the content type implies.
 */
function resolveKind(
  contentType: string,
  declared: MediaKindName
): { kind: MediaKindName } | { problem: string } {
  const implied = ALLOWED_CONTENT_TYPES[contentType];
  if (!implied) {
    return {
      problem: `Files of type ${contentType} are not accepted. ${ACCEPTED_SUMMARY}`
    };
  }

  if (isSvg(contentType)) return { kind: "DOCUMENT" };

  if (declared === "PANORAMA") {
    if (implied !== "IMAGE") {
      return {
        problem: `A panorama has to be a photograph, and ${contentType} is not one. Upload it as an ordinary file instead.`
      };
    }
    return { kind: "PANORAMA" };
  }

  if (declared === "MODEL_3D") {
    if (implied !== "MODEL_3D") {
      return {
        problem: `A 3D model has to be a glTF or GLB file, and ${contentType} is not one.`
      };
    }
    return { kind: "MODEL_3D" };
  }

  if (declared !== implied) {
    return {
      problem: `This was sent as ${declared.toLowerCase().replace(/_/g, " ")} but ${contentType} is ${implied
        .toLowerCase()
        .replace(/_/g, " ")}. Reload the page and try again.`
    };
  }

  return { kind: implied };
}

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  // The capability check is the boundary, not the media screen's own guard. A client guard that only
  // hides a control is not a guard (contract §1.7).
  await requireCapability(
    canManageMedia,
    "Uploading to the media library needs media manager access or higher. An administrator can raise yours."
  );

  // A 503 rather than a 500: unconfigured storage is a deployment state, not a bug, and the message
  // names the variables that are missing.
  requireStorage();

  const body = await parseJson(request, PresignBody);
  const contentType = body.contentType.toLowerCase();

  if (body.byteSize > MAX_UPLOAD_BYTES) {
    // BOTH numbers, always. "Too large" leaves the reader guessing whether trimming a little would
    // help; here the answer is no.
    throw new ApiError(
      413,
      `This file is ${formatBytes(body.byteSize)} and the limit is ${formatBytes(MAX_UPLOAD_BYTES)}. ` +
        "Compress it, or add it to the file store as a download instead of to the media library.",
      { code: "too_large" }
    );
  }

  const resolved = resolveKind(contentType, body.kind);
  if ("problem" in resolved) throw badRequest(resolved.problem);

  // The key is built HERE and never taken from the caller. It is random (so the bucket cannot be
  // enumerated), date-partitioned, and keeps the original filename on the end so a signed download
  // saves under a name a person recognises — see lib/storage/keys.ts.
  const objectKey = buildObjectKey({ namespace: "media", fileName: body.fileName });

  const signed = await presignUpload({
    key: objectKey,
    // The type we SIGN is the type the browser must send. It is also the only type `complete` will
    // accept for this key, which is what stops a signed PUT for a PNG being used to store a script.
    contentType,
    expiresInSeconds: PRESIGN_EXPIRY_SECONDS
  });

  return ok({
    uploadUrl: signed.url,
    // Returned verbatim so no caller has to know which headers were signed.
    headers: signed.headers,
    objectKey,
    expiresInSeconds: signed.expiresInSeconds
  });
});
