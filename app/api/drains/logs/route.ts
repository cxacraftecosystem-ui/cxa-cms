import { ApiError, ok, route } from "@/lib/api";
import { putObject, storageAvailable } from "@/lib/storage/client";
import { archiveDestinationPrivacy } from "@/lib/logArchive";
import {
  assertArchiveKeyWritable,
  drainDeliveryKey,
  drainSecret,
  frameDelivery,
  MAX_DELIVERY_BYTES,
  verificationToken,
  verifyDrainSignature
} from "@/lib/drains";

/**
 * The Vercel Log Drain receiver — schema "log", version v1.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS FOR, AND WHY IT IS DEAD CODE ON PURPOSE TODAY.
 *
 * Clause 4 of the CIC undertaking makes us retain "all website-related logs" for ninety days. The
 * audit and access slices cover what the application itself sees. They structurally cannot cover
 * what the application never wakes for — a CDN cache hit, a static asset, a request middleware
 * refused, a build, or a function killed by the platform before it could write a line. Those exist
 * only in Vercel's own logs, which last ONE HOUR on Hobby.
 *
 * Drains are a Pro-and-above feature, so nothing can reach this endpoint until the plan changes. It
 * ships now, inert, so that the day it does change the work is a dashboard form and an environment
 * variable rather than a design decision taken under time pressure. It writes into the same
 * date-partitioned archive the rest of the retention work uses, so "what happened on this date"
 * stays one question with one answer regardless of which system produced the line.
 *
 * ── THE ORDER OF THE CHECKS BELOW IS THE DESIGN, NOT AN ACCIDENT ──────────────────────────────
 *
 * This is an unauthenticated URL on the public internet that appends to a compliance evidence
 * store. Two distinct attacks matter, and they want opposite things from the ordering:
 *
 *   • FORGERY — a stranger writing plausible lines into the trail, or overwriting the record of
 *     their own visit. Defeated by the signature, and by nothing else. There is no IP allowlist to
 *     fall back on; Vercel publishes no source range for drain deliveries.
 *   • FLOOD — a stranger making us buffer and store megabytes per request until the bill or the
 *     bucket becomes the incident. Defeated by refusing as early as possible, which means every
 *     check that needs no body comes FIRST: the secret, then storage, then the destination's
 *     privacy, then the declared `content-length`. An unconfigured deployment therefore rejects a
 *     4 MB POST without ever reading it.
 *
 * The signature cannot come first, because computing it requires the whole body. That is the one
 * unavoidable cost of an HMAC-over-body scheme, and the cap above it is what bounds it.
 *
 * ⚠ AND THERE IS A THIRD THING THE ORDER HAS TO ANSWER TO, WHICH IS NOT AN ATTACK AT ALL:
 * DISCLOSURE. Every check above the PUT is about what reaches the bucket; the privacy gate at step 3
 * is about who can read it afterwards. It is cheap and body-free, so it sits with the other cheap
 * refusals — but it would belong here at any price, because the failure it prevents is the one this
 * endpoint's own output causes rather than one a stranger causes.
 *
 * ── WHAT THE ACCESS LOG DOES WITH THIS ENDPOINT, WHICH IS NOT NOTHING ─────────────────────────
 *
 * `route()` calls `recordAccess` (lib/requestLog.ts) on both branches. `/api/drains` is not in that
 * module's `ALWAYS_LOGGED_PREFIXES`, so its fallback rule applies: **a successful delivery writes no
 * row, a REFUSED one does.** That is the right split and it is worth knowing rather than
 * rediscovering. A 200 here is routine machine traffic and a row per delivery would multiply the
 * access log by the drain's own volume; a 403 here is somebody sending unsigned traffic to the
 * endpoint that appends to the compliance archive, which is as close to a textbook "suspected
 * security anomaly" as this application produces.
 *
 * ⚠ The corollary used to be that a flood of BADLY SIGNED requests cost one database insert each,
 * and this comment said that if it ever mattered the fix belonged in lib/requestLog.ts, which owns
 * that rule. It did matter and the fix is there: `recordAccess` now samples ANONYMOUS refusals per
 * (address, path, status), so a flood against this endpoint leaves a bounded heartbeat in
 * `access_logs` rather than a row per attempt. Nothing about this file changed for it, which is the
 * point of the rule living in one place. A refused delivery is still recorded; what is bounded is how
 * many identical refusals from one address are recorded.
 *
 * ── WHY THE WRITE IS INLINE AND NOT DEFERRED ──────────────────────────────────────────────────
 *
 * `after()` from next/server would let this respond 200 and store the bytes afterwards, shaving the
 * S3 round trip off the response. REJECTED, and the reason is worth keeping: Vercel retries a
 * delivery that does not return 2xx, and that retry is the ONLY thing standing between a transient
 * storage failure and a permanent hole in the ninety-day record. Answering 200 before the bytes are
 * safe converts a retryable failure into silent data loss, in the one system whose whole purpose is
 * not losing data. The work stays bounded instead: exactly one PUT and no database.
 *
 * ⚠ IT IS NO LONGER TRUE THAT THE NDJSON PATH DOES NOT PARSE. It used to, and this paragraph used to
 * say so as a selling point. `frameDelivery` now parses every record and scrubs its request-target
 * fields, because `proxy.path` is documented as "Request path with query parameters" and this
 * endpoint was filing `?secret=<CRON_SECRET>` and `?token=<password link>` verbatim into a 90-day
 * archive. The argument, the measurements and what was given up are all in lib/drains.ts's header on
 * `frameDelivery`. The work is still bounded — by `MAX_DELIVERY_BYTES`, at 8 MB — and it is still
 * small beside the PUT it precedes.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const dynamic = "force-dynamic";

export const POST = route(async (request: Request) => {
  /*
   * 1. Is a drain configured at all? Checked before the body is touched, so an endpoint nobody has
   *    configured costs a stranger a connection and costs us nothing.
   *
   *    The message to the caller does not distinguish "no secret configured" from "wrong signature",
   *    but the server log does — the same split `assertCronAuthorised` documents at lib/cron.ts:36-39,
   *    for the same reason: those two need entirely different fixes, and an operator staring at a
   *    refusal has no other way to tell them apart.
   */
  const secret = drainSecret();
  if (!secret) {
    console.error(
      "[drain] VERCEL_LOG_DRAIN_SECRET is not set, so the log drain receiver is refusing every " +
        "delivery. Set it to the drain's signature secret and re-deploy. Until then no platform " +
        "logs are being retained."
    );
    throw new ApiError(503, "Log drain delivery is not configured on this deployment.", {
      code: "drain_unconfigured"
    });
  }

  /*
   * 2. Can we store anything? A 503 here is correct and useful: Vercel retries it, and it shows up
   *    as an errored drain rather than as a quiet gap that nobody notices until the CIC asks.
   */
  if (!storageAvailable()) {
    console.error(
      "[drain] object storage is not configured, so a signed log drain delivery could not be " +
        "retained. Set S3_BUCKET, S3_REGION and the access keys."
    );
    throw new ApiError(503, "The log archive is not available on this deployment.", {
      code: "storage_unconfigured"
    });
  }

  /*
   * 3. ⚠ IS THE DESTINATION PRIVATE? THE SAME GATE THE ARCHIVE CRON REFUSES TO WRITE WITHOUT, AND FOR
   *    A STRICTER REASON.
   *
   *    `archiveDestinationPrivacy()` exists because docker/minio-public-read.json grants anonymous
   *    `s3:GetObject` on `arn:aws:s3:::<bucket>/*` — the WHOLE bucket, every prefix — and
   *    docker-compose.yml:103 says a real S3 bucket "needs the same care". The nightly archive job
   *    therefore refuses to write a single object until an operator states in the environment that
   *    the destination is not anonymously readable (app/api/cron/logs-archive/route.ts), and its own
   *    comment on writing anyway reads "a leak documented in a comment is a leak".
   *
   *    THIS RECEIVER WROTE INTO THE SAME ROOT AND NEVER ASKED. `dayPrefix(DRAIN_SOURCE, …)` puts
   *    deliveries at `files/logs/vercel/<YYYY>/<MM>/<DD>/…` — the same `LOG_ARCHIVE_KEY_ROOT`, the
   *    same bucket, the same policy — so a deployment that upgraded to Pro and followed
   *    docs/OPERATIONS.md §9 would publish every client IP, every referer and every request URL the
   *    CDN serves, WHILE the compliance job beside it was correctly reporting that this destination
   *    is not safe to write to. The two policies were exactly inverted relative to the sensitivity of
   *    what each writes: a drain carries the traffic the application never sees, which is the larger
   *    and richer half.
   *
   *    Per-object entropy is not a substitute and must not be read as one. The delivery key carries a
   *    millisecond stamp and sixteen hex of the body's digest, so one object is not guessable today —
   *    but §9's own "Unfinished" item 1 recommends a sealing job that writes `manifest.json` under
   *    this prefix, and a manifest key is a pure function of the date by design (lib/logArchive.ts).
   *    The day that lands, one anonymous GET enumerates the lot. Gating now is what stops that change
   *    from being a disclosure rather than a feature.
   *
   *    ⚠ 503 AND NOT 500, for the same reason `archive_write_failed` below is: Vercel retries a
   *    non-2xx, so nothing is lost while an operator fixes the bucket policy, and the drain shows as
   *    errored rather than as a quiet success that is publishing the institute's traffic. The
   *    `reason` is `archiveDestinationPrivacy`'s own sentence, which names the variable and the fix.
   */
  const privacy = archiveDestinationPrivacy();
  if (!privacy.confirmed) {
    console.error(`[drain] ${privacy.reason}`);
    throw new ApiError(
      503,
      "The log archive destination has not been confirmed private, so deliveries are not being " +
        "retained. See LOG_ARCHIVE_DESTINATION_IS_PRIVATE.",
      { code: "archive_destination_public" }
    );
  }

  // 4. The cheapest refusal there is — the sender's own declaration, before a byte is read.
  const declared = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_DELIVERY_BYTES) {
    throw new ApiError(413, "That log drain delivery is larger than this endpoint accepts.", {
      code: "too_large"
    });
  }

  /*
   * 5. The raw bytes, taken before anything parses them. `arrayBuffer()`, not `text()`: the
   *    signature covers the bytes on the wire, and a decode to a string and back is exactly the
   *    round trip that makes a signature check pass things it should not.
   */
  const rawBody = Buffer.from(await request.arrayBuffer());
  if (rawBody.byteLength > MAX_DELIVERY_BYTES) {
    // Reached when `content-length` was absent or untrue. The cap is the memory guard either way.
    throw new ApiError(413, "That log drain delivery is larger than this endpoint accepts.", {
      code: "too_large"
    });
  }

  // 6. The gate. Everything above this line is cost control; this is the security boundary.
  if (!verifyDrainSignature(rawBody, request.headers.get("x-vercel-signature"), secret)) {
    console.error(
      "[drain] rejected a delivery whose x-vercel-signature did not match. Either the request was " +
        "not from Vercel, or VERCEL_LOG_DRAIN_SECRET disagrees with the drain's signature secret."
    );
    throw new ApiError(403, "This endpoint only accepts signed log drain deliveries.", {
      code: "invalid_signature"
    });
  }

  const framed = frameDelivery(rawBody);
  const key = drainDeliveryKey({ extension: framed.extension, digest: framed.sourceDigest });
  assertArchiveKeyWritable(key);

  try {
    await putObject({
      key,
      body: framed.bytes,
      contentType: framed.contentType,
      /*
       * `private, no-store`, overriding `putObject`'s year-long immutable default (client.ts:209).
       * That default is right for a media derivative addressed by a public CDN URL and wrong for
       * every property of this object: these bytes are a record of who visited the site, they are
       * never served to a browser, and a cached copy of a compliance log sitting in an intermediary
       * is a disclosure with no upside whatsoever.
       */
      cacheControl: "private, no-store"
    });
  } catch (error) {
    /*
     * A STORAGE FAILURE IS A 503, NOT A 500, AND THE DIFFERENCE IS NOT COSMETIC.
     *
     * Left alone, an AWS error is not an `ApiError`, so `toErrorResponse` turns it into a generic
     * 500 and writes `[api] unhandled error` (lib/api.ts:106). Both are wrong here: an unreachable
     * bucket is a deployment state rather than a bug in this handler, and an operator reading
     * "unhandled error" goes looking for one. The same distinction `requireStorage` draws at
     * lib/storage/client.ts:38-47, and the same translation `asWriteFailure` performs for transient
     * Prisma failures in lib/audit.ts.
     *
     * ⚠ IT RETHROWS. It must: the non-2xx is what makes Vercel redeliver, and that retry is the only
     * thing between a transient blip and a permanent hole in the ninety-day record. Swallowing this
     * to keep the drain's error rate clean would trade the evidence for the appearance of health.
     *
     * An `ApiError` from inside `putObject` — a misconfigured `S3_SSE_ALGORITHM`, say — already
     * carries the right status and sentence, so it passes through untouched rather than being
     * relabelled as a storage outage it is not.
     */
    if (error instanceof ApiError) throw error;
    console.error(`[drain] could not write ${key} to the log archive`, error);
    throw new ApiError(
      503,
      "The log archive could not be written to. The delivery was not retained; please retry.",
      { code: "archive_write_failed", cause: error }
    );
  }

  /*
   * One structured line per delivery, matching `runCronJob`'s `[cron]` convention (lib/cron.ts:93-95).
   * It is written to the platform log this endpoint exists to escape, which is not circular: the
   * durable record is the OBJECT, and this line is only for watching a newly configured drain start
   * working in the dashboard, within the hour it survives.
   *
   * `unscrubbedLines` is here because zero is the expected value and a non-zero one is the residue
   * `frameDelivery` documents: lines that were not JSON, stored as they arrived and therefore never
   * scrubbed. If that number is ever not zero, the format the drain is sending is not the format this
   * receiver was written against, and somebody should look before ninety days of it accumulate.
   */
  console.log(
    "[drain] vercel",
    JSON.stringify({
      key,
      records: framed.records,
      bytes: framed.bytes.byteLength,
      framing: framed.framing,
      unscrubbedLines: framed.unscrubbedLines,
      sourceDigest: framed.sourceDigest
    })
  );

  // A verification token may ride along with a delivery; echo it when it does. See `verificationToken`.
  const token = verificationToken(request);
  return ok(
    { received: framed.records },
    token ? { headers: { "x-vercel-verify": token } } : undefined
  );
});

/**
 * The endpoint-verification challenge.
 *
 * Vercel's current documentation for a dashboard-created custom endpoint describes no challenge — it
 * sends a test delivery and expects a 200 — but its older integration flow required the endpoint to
 * echo an `x-vercel-verify` token before a drain could be created at all, and an endpoint that
 * cannot answer one cannot be registered. This handler exists so that drain creation can never be
 * blocked by it.
 *
 * ⚠ IT DELIBERATELY DOES NOT REQUIRE A SIGNATURE, because a verification request does not carry one.
 * That is safe: it either returns the caller its own header back, or returns a token that is only
 * meaningful to somebody who already configured it on the Vercel side. It touches no storage, writes
 * nothing, and — the part that matters — reveals nothing about whether a drain secret is set. With
 * no token to echo it is a plain 405, which discloses only that the path exists.
 */
export const GET = route(async (request: Request) => {
  const token = verificationToken(request);
  if (!token) {
    throw new ApiError(405, "This endpoint receives log drain deliveries by POST.", {
      code: "method_not_allowed"
    });
  }
  return ok({ verified: true }, { headers: { "x-vercel-verify": token } });
});

/** Some verification probes use HEAD. Same answer, no body — Next drops it for this method. */
export const HEAD = GET;
