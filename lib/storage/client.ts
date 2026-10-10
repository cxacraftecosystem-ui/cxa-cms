import "server-only";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { storageConfigured, storageEnv } from "@/lib/env";
import { ApiError, badRequest } from "@/lib/api";
import { chunk, formatBytes } from "@/lib/utils";
import { isSafeObjectKey } from "./keys";
import { isSha256Base64, SHA256_REQUIRED_MESSAGE } from "./upload-limits";
import type { UploadIntent } from "./upload-ticket";

/**
 * The object-storage adapter.
 *
 * S3-compatible by interface, not by vendor: the same code drives AWS S3, MinIO, Cloudflare R2 and
 * Backblaze B2. `S3_ENDPOINT` + `S3_FORCE_PATH_STYLE` are the two switches that matter — every
 * self-hosted gateway needs path-style addressing, and virtual-host style against MinIO fails with a
 * DNS error that reads like a network outage.
 *
 * The client is a module-level singleton. Each `new S3Client()` builds its own connection pool and
 * credential resolver; creating one per request under load exhausts sockets long before it exhausts
 * anything else.
 */

let cachedClient: S3Client | null = null;
let cachedSigner: S3Client | null = null;

export function storageAvailable(): boolean {
  return storageConfigured();
}

/** Throws a 503 (not a 500) when storage is unconfigured: it is a deployment state, not a bug. */
export function requireStorage(): void {
  if (!storageConfigured()) {
    throw new ApiError(
      503,
      "Uploads aren't set up on this site.",
      { code: "storage_unconfigured" }
    );
  }
}

export function s3(): S3Client {
  requireStorage();
  if (cachedClient) return cachedClient;
  const env = storageEnv();
  cachedClient = new S3Client({
    region: env.region,
    credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
    ...(env.endpoint ? { endpoint: env.endpoint } : {}),
    forcePathStyle: env.forcePathStyle
  });
  return cachedClient;
}

/**
 * A SECOND client, used ONLY to sign URLs the BROWSER will follow.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY A SECOND CLIENT AND NOT A STRING REPLACE.
 *
 * The server and the browser frequently reach object storage at DIFFERENT addresses. In the local
 * container stack the server talks to `http://minio:9000` over the compose network while the browser
 * must use `http://localhost:9000`, because it sits outside that network and cannot resolve a service
 * name. The same split appears in production behind a VPC endpoint or a private gateway.
 *
 * The obvious fix — sign with the internal endpoint, then rewrite the host in the resulting URL — DOES
 * NOT WORK, and fails in a way that wastes an afternoon. SigV4 signs the `Host` header, so a URL whose
 * host has been edited after signing carries a signature for a different request; storage rejects it
 * with `SignatureDoesNotMatch`, which reads as a credentials problem rather than an addressing one.
 *
 * So the presigned URL is produced by a client CONFIGURED with the browser-facing origin. The signature
 * then covers the host the browser will actually send, and the two agree.
 *
 * With `S3_PUBLIC_ENDPOINT` unset this is the same client as `s3()`, which is the correct behaviour
 * everywhere the two addresses coincide — including plain AWS S3.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
function signer(): S3Client {
  requireStorage();
  const env = storageEnv();
  if (!env.publicEndpoint || env.publicEndpoint === env.endpoint) return s3();
  if (cachedSigner) return cachedSigner;
  cachedSigner = new S3Client({
    region: env.region,
    credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
    endpoint: env.publicEndpoint,
    forcePathStyle: env.forcePathStyle
  });
  return cachedSigner;
}

export function bucket(): string {
  return storageEnv().bucket;
}

function serverSideEncryption(): { ServerSideEncryption?: "AES256" | "aws:kms" } {
  const algorithm = storageEnv().sseAlgorithm;
  if (!algorithm) return {};
  if (algorithm === "AES256" || algorithm === "aws:kms") return { ServerSideEncryption: algorithm };
  // An unrecognised value would be sent verbatim and rejected by the gateway at PUT time, i.e. the
  // upload fails at the end rather than at configuration time. Fail here instead, with the reason.
  throw new ApiError(
    503,
    `S3_SSE_ALGORITHM is "${algorithm}", which is not a value this storage layer can send. Use AES256 or aws:kms.`,
    { code: "storage_misconfigured" }
  );
}

function assertKey(key: string): void {
  if (!isSafeObjectKey(key)) {
    throw new ApiError(400, "That storage key is not valid.", { code: "bad_object_key" });
  }
}

/**
 * A presigned PUT for a browser upload.
 *
 * Direct-to-storage rather than proxying through the app, because a 200 MB video through a
 * serverless function is a timeout at best and a memory limit at worst. That makes THIS SIGNATURE the
 * only control over what lands, so it pins down three things, and storage — not the browser, not a
 * later `HEAD` — refuses a PUT that differs in any of them:
 *
 *   • **`Content-Type` is SIGNED.** The browser MUST send exactly the type named here, or the PUT is
 *     rejected with a signature mismatch that reads like a credentials problem.
 *   • **`Content-Length` is SIGNED and REQUIRED.** Without it the URL would accept a body of any size
 *     for its whole lifetime, and the cap would be enforced only by the browser that was asked to obey
 *     it. The browser sets this header itself from the `File`; nothing has to replay it.
 *   • **`x-amz-checksum-sha256` is SIGNED and REQUIRED.** Storage computes the SHA-256 of the body it
 *     receives and refuses the PUT (`BadDigest`) when it differs, so the bytes stored are provably the
 *     bytes the browser fingerprinted — and `headObject` can read the verified digest back.
 *
 * ══ WHY `signableHeaders` AND `unhoistableHeaders` ARE SPELLED OUT ══
 *
 * Measured against @aws-sdk/s3-request-presigner 3.1098: with neither option the URL's
 * `X-Amz-SignedHeaders` is `content-length;host` — `Content-Type` was NOT signed, whatever the comment
 * that used to stand here said — and every `x-amz-*` header is HOISTED into the query string instead of
 * being sent as a request header. `signableHeaders` forces `content-type` into the signature;
 * `unhoistableHeaders` keeps the checksum (and the encryption choice) as real, signed request headers,
 * which is why they are returned in `headers` for the browser to replay. tests/storage/presign.test.ts
 * reads `X-Amz-SignedHeaders`, so a dependency bump that changes this is caught rather than discovered.
 *
 * Single PUT only: there is no multipart path in this codebase (lib/client/upload.ts), so the checksum
 * is a FULL_OBJECT SHA-256 and never a composite `…-N` one.
 *
 * The bucket's CORS must allow these request headers (`AllowedHeaders: ["*"]` in docs/OPERATIONS.md §1
 * already does) and expose `ETag`.
 */
export async function presignUpload(input: {
  key: string;
  contentType: string;
  /** Exact size of the body, in bytes. Required and signed. */
  contentLength: number;
  /** Standard base64 of the SHA-256 of the body. Required and signed. */
  checksumSha256: string;
  expiresInSeconds?: number;
}): Promise<{ url: string; headers: Record<string, string>; expiresInSeconds: number }> {
  assertKey(input.key);
  if (!Number.isSafeInteger(input.contentLength) || input.contentLength <= 0) {
    throw badRequest("An upload must state its exact size in bytes.");
  }
  if (!isSha256Base64(input.checksumSha256)) {
    throw badRequest(SHA256_REQUIRED_MESSAGE);
  }
  const expiresIn = input.expiresInSeconds ?? 15 * 60;
  const sse = serverSideEncryption();

  const command = new PutObjectCommand({
    Bucket: bucket(),
    Key: input.key,
    ContentType: input.contentType,
    ContentLength: input.contentLength,
    ChecksumAlgorithm: "SHA256",
    ChecksumSHA256: input.checksumSha256,
    ...sse
  });

  // `signer()`, not `s3()` — the browser follows this URL. See the note on `signer`.
  const url = await getSignedUrl(signer(), command, {
    expiresIn,
    signableHeaders: new Set(["content-type", "content-length"]),
    unhoistableHeaders: new Set(["x-amz-checksum-sha256", "x-amz-server-side-encryption"])
  });

  // Every signed header must be replayed by the browser verbatim. Returning them alongside the URL
  // is what stops a caller from having to know which ones were signed. (`Content-Length` is absent:
  // a browser refuses to let script set it and sends the true length of the body itself.)
  const headers: Record<string, string> = {
    "Content-Type": input.contentType,
    "x-amz-checksum-sha256": input.checksumSha256
  };
  if (sse.ServerSideEncryption) headers["x-amz-server-side-encryption"] = sse.ServerSideEncryption;

  return { url, headers, expiresInSeconds: expiresIn };
}

/**
 * A presigned GET.
 *
 * `ResponseContentDisposition` is set for downloads so the browser saves the file under its ORIGINAL
 * name rather than the random object key. The filename is quoted and stripped of quotes and control
 * characters — an unescaped `"` in a header value truncates it and turns the download into a
 * response-header injection.
 */
export async function presignDownload(input: {
  key: string;
  expiresInSeconds?: number;
  downloadFileName?: string;
  contentType?: string;
}): Promise<string> {
  assertKey(input.key);
  const disposition = input.downloadFileName
    ? `attachment; filename="${input.downloadFileName.replace(/["\\\r\n]/g, "")}"`
    : undefined;

  const command = new GetObjectCommand({
    Bucket: bucket(),
    Key: input.key,
    ...(disposition ? { ResponseContentDisposition: disposition } : {}),
    ...(input.contentType ? { ResponseContentType: input.contentType } : {})
  });

  // `signer()`, not `s3()` — the browser follows this URL. See the note on `signer`.
  return getSignedUrl(signer(), command, { expiresIn: input.expiresInSeconds ?? 10 * 60 });
}

/** Upload bytes from the server. Used by the derivative pipeline, never for user uploads. */
export async function putObject(input: {
  key: string;
  body: Buffer | Uint8Array;
  contentType: string;
  cacheControl?: string;
}): Promise<void> {
  assertKey(input.key);
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      // Derivatives are immutable by construction — a regeneration overwrites the same key with
      // better bytes, and a year of browser caching is exactly what we want in between.
      CacheControl: input.cacheControl ?? "public, max-age=31536000, immutable",
      ...serverSideEncryption()
    })
  );
}

export async function getObjectBytes(key: string): Promise<Buffer> {
  assertKey(key);
  const response = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  if (!response.Body) {
    throw new ApiError(404, "That file is no longer in storage.", { code: "object_missing" });
  }
  return Buffer.from(await response.Body.transformToByteArray());
}

export interface ObjectHead {
  byteSize: number;
  contentType: string | null;
  etag: string | null;
  /**
   * The SHA-256 storage computed and verified at PUT time, base64 — or null when the object was stored
   * without one (an old upload, a server-side write, or a gateway that ignores checksums). For a
   * multipart object this is a composite `…-N` value, which is not a digest of the whole body.
   */
  checksumSha256: string | null;
}

/**
 * Read an object's metadata, or null when it is absent.
 *
 * The upload flow uses this to CONFIRM that a presigned PUT actually landed before it writes a
 * database row. Trusting the browser's "done" is how a MediaAsset row ends up pointing at a key that
 * was never written — a broken image with a perfectly healthy-looking database.
 */
export async function headObject(
  key: string,
  options: { withChecksum?: boolean } = {}
): Promise<ObjectHead | null> {
  assertKey(key);
  try {
    // `ChecksumMode: ENABLED` is what makes storage return the stored checksum at all; without it the
    // field is simply absent and every finalize would look like a gateway that ignores checksums. It is
    // opt-in because only the upload finalize needs it, and on an SSE-KMS bucket it additionally needs
    // `kms:Decrypt` — the public download routes HEAD too and should not grow that requirement.
    const response = await s3().send(
      new HeadObjectCommand({
        Bucket: bucket(),
        Key: key,
        ...(options.withChecksum ? { ChecksumMode: "ENABLED" as const } : {})
      })
    );
    return {
      byteSize: response.ContentLength ?? 0,
      contentType: response.ContentType ?? null,
      etag: response.ETag?.replace(/"/g, "") ?? null,
      checksumSha256: response.ChecksumSHA256 ?? null
    };
  } catch (error) {
    const name = (error as { name?: string }).name;
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (name === "NotFound" || name === "NoSuchKey" || status === 404) return null;
    throw error;
  }
}

/**
 * Why a landed object is not the one that was presigned, or null when it is.
 *
 * Pure, so the rule can be tested without a bucket. Size, checksum and content type are all compared:
 * storage already refused a PUT that differed in any of them (see `presignUpload`), so a mismatch here
 * means the gateway did not enforce what was signed — which is exactly the case this exists to catch.
 * A MISSING checksum is a mismatch, not a pass: it is what a gateway that silently ignores
 * `x-amz-checksum-sha256` looks like.
 */
export function landedObjectProblem(intent: UploadIntent, head: ObjectHead): string | null {
  if (head.byteSize !== intent.byteSize) {
    return (
      `What reached storage is ${formatBytes(head.byteSize)} but the upload was signed for ` +
      `${formatBytes(intent.byteSize)}.`
    );
  }
  if (!head.checksumSha256) {
    return "Storage did not record a SHA-256 fingerprint for the upload, so its contents cannot be confirmed.";
  }
  if (head.checksumSha256 !== intent.sha256) {
    return "The file in storage does not match the fingerprint the upload was signed for.";
  }
  if ((head.contentType ?? "").toLowerCase() !== intent.contentType.toLowerCase()) {
    return `What reached storage is typed ${head.contentType ?? "unknown"} but the upload was signed for ${intent.contentType}.`;
  }
  return null;
}

/**
 * Confirm a browser upload landed AS PRESIGNED before any row points at it.
 *
 * `HEAD` the object; refuse (400) when it is absent; when it differs from the ticket in size, checksum
 * or type, DELETE it and refuse. The delete is safe because the key is a fresh random one the presign
 * route issued and no row references it yet — and it is the only way a refusal does not leave an
 * object nothing will ever collect.
 *
 * `nothingChanged` is the route's own ending ("Nothing was added to the library."), so the sentence
 * the reader sees still says what did NOT happen.
 */
export async function confirmUploadedObject(
  intent: UploadIntent,
  options: { logTag: string; nothingChanged: string }
): Promise<ObjectHead> {
  const head = await headObject(intent.objectKey, { withChecksum: true });
  if (!head) {
    throw badRequest(
      `The upload did not reach storage. ${options.nothingChanged} Nothing is stored under that address. ` +
        "Try uploading the file again."
    );
  }

  const problem = landedObjectProblem(intent, head);
  if (problem) {
    await deleteObject(intent.objectKey).catch((error: unknown) => {
      console.error(`${options.logTag} could not remove a rejected upload`, intent.objectKey, error);
    });
    throw badRequest(`${problem} ${options.nothingChanged} Try uploading the file again.`);
  }

  return head;
}

export async function deleteObject(key: string): Promise<void> {
  assertKey(key);
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

/**
 * Delete many objects.
 *
 * Chunked at 1000 because that is the hard per-request limit; a larger array is rejected wholesale,
 * so a purge of 1,500 stale derivatives would delete nothing at all rather than most of them.
 * Failures are COLLECTED, not thrown: a purge that aborts on the first missing key leaves the rest
 * of the batch behind forever, and a key that is already gone is a success for our purposes.
 */
export async function deleteObjects(keys: string[]): Promise<{ deleted: number; failed: string[] }> {
  const safe = keys.filter(isSafeObjectKey);
  const failed: string[] = keys.filter((key) => !isSafeObjectKey(key));
  let deleted = 0;

  for (const batch of chunk(safe, 1000)) {
    try {
      const response = await s3().send(
        new DeleteObjectsCommand({
          Bucket: bucket(),
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true }
        })
      );
      deleted += batch.length - (response.Errors?.length ?? 0);
      for (const error of response.Errors ?? []) {
        if (error.Key) failed.push(error.Key);
      }
    } catch {
      failed.push(...batch);
    }
  }

  return { deleted, failed };
}


/**
 * How many objects one prefix may hold before a sweep refuses to guess.
 *
 * A single upload's derivative ladder is six widths in two formats — twelve, plus the odd retry. Two
 * hundred is a wide margin for that and far below anything that could plausibly be one asset. A prefix
 * holding more than this is not a derivative set; it is a key collision or a mistake, and deleting it
 * would take somebody else's objects with it.
 */
const MAX_SWEPT_OBJECTS = 200;

/**
 * Every object key actually present under a prefix.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS: THE VARIANT ROWS ARE NOT A COMPLETE RECORD OF THE BYTES.
 *
 * `lib/storage/derivatives.ts` states plainly that a derivative run can PARTLY fail, and that the
 * caller writes down what actually landed. So a derivative can exist in the bucket with no row naming
 * it — written successfully, recorded unsuccessfully. Delete an asset by its rows alone and every one
 * of those survives at a publicly readable URL, with the only record that could ever have found it now
 * gone. Storage that costs money for ever and cannot be enumerated by anybody who did not already know
 * the key.
 *
 * Both purge paths need this and each had grown its own answer to it, which is why it lives here now:
 * the recycle bin's `purge-record.ts` swept correctly, and `app/api/cron/purge/route.ts` did not sweep
 * at all — so every unrecorded derivative it has ever passed over is still in the bucket.
 *
 * ⚠ A FAILED LISTING IS A FAILED DELETE, NEVER AN EMPTY ONE. If storage cannot be listed the set is
 * UNKNOWN, and deleting what we happen to know about before dropping the row leaves exactly the orphans
 * this exists to prevent. It throws; the caller must keep the row.
 *
 * ⚠ AND SO IS AN OVER-LARGE PREFIX. Stopping at the cap and returning a partial list would delete some
 * objects and then release the row, arriving at the orphan case through the very code written to avoid
 * it. It throws instead, and somebody looks at why one prefix holds hundreds of objects.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function listObjectKeys(prefix: string): Promise<string[]> {
  requireStorage();

  const keys: string[] = [];
  let token: string | undefined;

  do {
    const page = await s3().send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: prefix,
        MaxKeys: 1000,
        ...(token ? { ContinuationToken: token } : {})
      })
    );

    for (const object of page.Contents ?? []) {
      if (object.Key) keys.push(object.Key);
    }

    // `IsTruncated` without a token would loop for ever; both are required to continue.
    token = page.IsTruncated && page.NextContinuationToken ? page.NextContinuationToken : undefined;

    if (keys.length > MAX_SWEPT_OBJECTS) {
      throw new Error(
        `More than ${MAX_SWEPT_OBJECTS} objects under ${prefix}; refusing to guess which of them belong to this asset.`
      );
    }
  } while (token);

  return keys;
}
