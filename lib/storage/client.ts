import "server-only";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { storageConfigured, storageEnv } from "@/lib/env";
import { ApiError } from "@/lib/api";
import { chunk } from "@/lib/utils";
import { isSafeObjectKey } from "./keys";

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
      "File storage is not configured on this deployment, so uploads are unavailable. " +
        "An administrator needs to set S3_BUCKET, S3_REGION and the access keys.",
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
 * Direct-to-storage rather than proxying through the app, because a 400 MB video through a
 * serverless function is a timeout at best and a memory limit at worst. Two consequences the caller
 * must honour:
 *
 *   • **`ContentType` is SIGNED.** The browser MUST send exactly the type named here, or the PUT is
 *     rejected with a signature mismatch that reads like a credentials problem.
 *   • **The bucket's CORS must expose `ETag`.** Without it a multipart upload cannot read the part
 *     identifiers back and the whole transfer has to fall back to single PUTs (skill §14.4).
 */
export async function presignUpload(input: {
  key: string;
  contentType: string;
  expiresInSeconds?: number;
  contentLength?: number;
}): Promise<{ url: string; headers: Record<string, string>; expiresInSeconds: number }> {
  assertKey(input.key);
  const expiresIn = input.expiresInSeconds ?? 15 * 60;
  const sse = serverSideEncryption();

  const command = new PutObjectCommand({
    Bucket: bucket(),
    Key: input.key,
    ContentType: input.contentType,
    ...(input.contentLength !== undefined ? { ContentLength: input.contentLength } : {}),
    ...sse
  });

  // `signer()`, not `s3()` — the browser follows this URL. See the note on `signer`.
  const url = await getSignedUrl(signer(), command, { expiresIn });

  // Every signed header must be replayed by the browser verbatim. Returning them alongside the URL
  // is what stops a caller from having to know which ones were signed.
  const headers: Record<string, string> = { "Content-Type": input.contentType };
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
}

/**
 * Read an object's metadata, or null when it is absent.
 *
 * The upload flow uses this to CONFIRM that a presigned PUT actually landed before it writes a
 * database row. Trusting the browser's "done" is how a MediaAsset row ends up pointing at a key that
 * was never written — a broken image with a perfectly healthy-looking database.
 */
export async function headObject(key: string): Promise<ObjectHead | null> {
  assertKey(key);
  try {
    const response = await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return {
      byteSize: response.ContentLength ?? 0,
      contentType: response.ContentType ?? null,
      etag: response.ETag?.replace(/"/g, "") ?? null
    };
  } catch (error) {
    const name = (error as { name?: string }).name;
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (name === "NotFound" || name === "NoSuchKey" || status === 404) return null;
    throw error;
  }
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
