import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ApiError } from "@/lib/api";
import { redact } from "@/lib/audit";
import { dayPrefix } from "@/lib/logArchive";
import { scrubRequestTarget } from "@/lib/requestLog";
import { isSafeObjectKey } from "@/lib/storage/keys";

/**
 * Receiving a Vercel Log Drain, and putting its lines where the archival slice keeps everything else.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS BEFORE IT CAN POSSIBLY RUN.
 *
 * Clause 4 of the CIC hosting undertaking makes us responsible for retaining "all website-related
 * logs" for ninety days. The application can log itself — that is what the audit and access slices
 * do — but it cannot see the traffic it never wakes for: a CDN cache hit, a static asset, a request
 * the proxy refused, a function killed before it could write anything. Only the PLATFORM sees
 * those, and the only way to get them out of Vercel is a Log Drain.
 *
 * Drains are Pro-and-above. This team is on Hobby. So this endpoint cannot receive a single byte
 * today, and everything here is written for the day the plan changes:
 *
 *   • It is INERT until `VERCEL_LOG_DRAIN_SECRET` is set. With no secret it refuses every request,
 *     for the same reason `assertCronAuthorised` does (lib/cron.ts:44-50) — a deployment that forgot
 *     the secret must have a closed endpoint, not an open one.
 *   • It writes into the SAME date-partitioned object layout `lib/logArchive.ts` defines, so that
 *     "what happened on 2026-09-16" is one question with one answer regardless of which system
 *     produced the line. See the key-layout block below, and `drainDeliveryKey`.
 *
 * The alternative was to build nothing until the plan changes. Rejected: the shape of the sink is
 * the part that is expensive to change later. A drain switched on against a receiver that writes
 * somewhere else means two archives, two retention jobs, and two answers to the CIC's question.
 *
 * ⚠ THIS MODULE CANNOT RUN ON THE EDGE, and the route that uses it must never be moved there.
 * `node:crypto`'s HMAC is synchronous and `Buffer` is a Node type; the Edge runtime has neither, and
 * the AWS SDK that stores the bytes does not run there either. The failure would not be a build
 * error — it would be a signature check that throws on every delivery, i.e. a drain that retains
 * nothing while reporting a fault that reads like a Vercel outage.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE KEY LAYOUT BELONGS TO THE ARCHIVAL SLICE. THIS ONE INHERITS IT.
 *
 * `lib/logArchive.ts` owns the retrieval contract for everything the application retains:
 *
 *     files/logs/<source>/<YYYY>/<MM>/<DD>/…
 *
 * A drain delivery is simply another source under it:
 *
 *     files/logs/vercel/2026/09/16/delivery-141233047-a7f3c9d1.ndjson
 *
 * which is what makes "what happened on this date" one question rather than two. Two details of
 * that contract are inherited rather than re-decided here, and both are load-bearing:
 *
 *   • **`files/logs`, not `logs`.** `isSafeObjectKey` (lib/storage/keys.ts:120-125) rejects any key
 *     whose first segment is not in `KEY_NAMESPACES` — `media`, `files`, `models`, `tmp` — so a key
 *     beginning `logs/` throws a 400 `bad_object_key` before a byte leaves the function. Reusing the
 *     `files` namespace means that array never has to be edited. There is no collision with real
 *     file assets: `buildObjectKey` always emits `files/<YYYY>/…`, and a four-digit year is never
 *     the literal `logs`.
 *   • **`YYYY/MM/DD` as separate segments**, so a month and a year are also single prefixes — which
 *     is what an S3 lifecycle rule and a bulk copy each operate on.
 *
 * The parts this file does decide are the filename and the one-object-per-delivery rule:
 *
 *   • **A sortable time, then a prefix of the delivery's own SHA-256.** The time makes a listing
 *     chronological within the day; the digest makes two deliveries in the same millisecond
 *     impossible to collide, and — since `frameDelivery` no longer stores the delivered bytes
 *     verbatim — it is also the only durable record of WHICH delivery an object came from. It
 *     replaced four random bytes, which gave the collision property alone. Two deliveries that
 *     collide now are byte-identical deliveries in the same millisecond, i.e. the same delivery
 *     twice, and one overwriting the other loses nothing. A sequence number would need shared state a
 *     receiver deliberately does not have.
 *   • **One object per delivery, never an append.** S3 has no append, so "add to today's object"
 *     means read-modify-write, which under two concurrent deliveries silently loses one of them. An
 *     archive that drops lines under load — exactly when the lines matter — is worse than one with
 *     many small objects. Rejected on those grounds, deliberately.
 *
 * ⚠ `dayPrefix` IS IMPORTED RATHER THAN REIMPLEMENTED, and that is worth defending because it costs
 * something. lib/logArchive.ts imports `@/lib/db`, which calls `new PrismaClient()` at MODULE SCOPE
 * (lib/db.ts:16-47) — so importing it drags a database client into a receiver that never queries.
 * That was the argument for keeping a private copy of the root here, and it no longer holds: `route()`
 * in lib/api.ts now imports lib/requestLog.ts, which imports the same Prisma singleton, so EVERY
 * route file in the application already carries it and this one cannot avoid it by abstaining. With
 * the cost gone, the remaining consideration is one-sided. lib/logArchive.ts's own comment on the
 * root says it is a RETRIEVAL CONTRACT and that splitting the history across two roots makes every
 * range query silently return half an answer — which is exactly what a second, drifting copy of the
 * string in this file would eventually cause.
 *
 * What is still duplicated is the three-line UTC date formatting, because `utcDayString` is private
 * to that module. It is duplicated rather than exported-on-request because it is the trivial half:
 * a wrong date format here produces a key that is visibly wrong the first time anybody looks, while
 * a wrong ROOT produces an archive that looks right and is invisible to every reader.
 *
 * THE SAME ARGUMENT, TWICE MORE. `scrubRequestTarget` comes from lib/requestLog.ts and `redact` from
 * lib/audit.ts for exactly the reason above: a second copy of "which query parameters carry a
 * credential" would be right on the day it was written and wrong the first time somebody added a link
 * builder. Neither import costs anything this file was not already paying — lib/requestLog.ts is what
 * `route()` itself imports, and lib/audit.ts reaches nothing this module does not already reach.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** The `<source>` segment: which system produced the lines inside. */
export const DRAIN_SOURCE = "vercel";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS SOURCE HAS NO MANIFEST, AND ANY READER OF THE ARCHIVE MUST KNOW THAT.
 *
 * lib/logArchive.ts seals each CLOSED day with a `manifest.json` naming its parts, and its stated
 * retrieval protocol is "for each date in the range, GET the manifest, then GET the parts it names".
 * That protocol deliberately needs no bucket listing, because the bucket policy denies
 * `s3:ListBucket` and `listObjectKeys` throws above 200 keys (lib/storage/client.ts:301).
 *
 * A drain cannot participate in it. Deliveries arrive continuously, so there is no moment at which
 * today's set is complete; writing a manifest per delivery would mean read-modify-write on a shared
 * object — the same race rejected above, and here it would corrupt the index rather than a part.
 * Writing one after the day closes is correct and belongs to a SCHEDULED JOB, not to a receiver.
 *
 * So until such a job exists, DRAIN OBJECTS ARE DISCOVERABLE ONLY BY LISTING THEIR DAY PREFIX, and a
 * reader following the manifest protocol will not see them at all. The filename says so deliberately:
 * `delivery-…` rather than `part-NNNN.ndjson` marks these as unsealed, and stops a future sealing
 * job from mistaking them for parts it wrote itself.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * A hard ceiling on a single delivery, as a MEMORY guard rather than a policy.
 *
 * Vercel's own request-body limit for a function is well below this, so in practice a larger body
 * never arrives from Vercel at all; this exists so that a body which is NOT from Vercel cannot be
 * buffered unboundedly before the signature check gets a chance to reject it.
 *
 * It is a whole-body cap rather than a streaming one in the style of `downloadOpenCollectionImage`
 * (lib/media/open-collections.ts:451-457), and that is forced rather than lazy: the signature covers
 * the entire body, so there is nothing useful to do with the first four megabytes of a body whose
 * authenticity cannot yet be established. The declared `content-length` is checked first, before a
 * byte is read, which is where the cheap refusal actually happens.
 */
export const MAX_DELIVERY_BYTES = 8 * 1024 * 1024;

/**
 * The drain signature secret, or null when no drain is configured.
 *
 * Read from `process.env` directly rather than through lib/env.ts, matching `assertCronAuthorised`
 * (lib/cron.ts:42) — the nearest precedent for a shared secret guarding a machine-called endpoint.
 * An empty or whitespace-only value counts as ABSENT: a variable set to "" in a dashboard is a
 * half-finished configuration, and treating it as a secret would mean HMAC-ing with an empty key,
 * which is a signature anybody on the internet can compute.
 *
 * `configurationWarnings()` in lib/env.ts now surfaces "a drain is configured but storage is not" on
 * the diagnostics panel, which is where this comment used to say it belonged. Note what it
 * deliberately does NOT warn about: a deployment with NO drain secret. On Hobby a drain cannot exist,
 * so that warning would be permanently true on every deployment that is behaving correctly, and a
 * panel that always shows a red line it is impossible to clear is a panel operators stop reading.
 */
export function drainSecret(): string | null {
  const value = process.env.VERCEL_LOG_DRAIN_SECRET?.trim();
  return value ? value : null;
}

/** SHA-1 produces 20 bytes, so its hex digest is always exactly this long. */
const SIGNATURE_HEX_LENGTH = 40;

/**
 * Is this delivery really from Vercel?
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE THREE WAYS THIS CHECK IS USUALLY WRITTEN WRONG, AND WHY IT IS WRITTEN THIS WAY INSTEAD.
 *
 * 1. **It hashes the RAW BYTES, not a re-serialised object.** The most common way a webhook
 *    signature check silently passes everything is to `await request.json()` and then hash
 *    `JSON.stringify(parsed)` — which differs from what the sender signed by key order, by
 *    whitespace, by number formatting, and by how non-ASCII escapes round-trip. The check then fails
 *    for genuine traffic, somebody "fixes" it by loosening the comparison, and the endpoint ends up
 *    accepting anything. The caller therefore hands us a `Buffer` taken from `request.arrayBuffer()`
 *    before anything has parsed it, and we never decode it to a string first: Vercel's own sample
 *    does `Buffer.from(rawBody, 'utf-8')` after `request.text()`, and a decode-then-re-encode round
 *    trip is precisely the step worth not having.
 *
 * 2. **SHA-1, not SHA-256.** Vercel signs drain deliveries and webhooks with HMAC-SHA1 and sends the
 *    bare hex digest — no `sha1=` prefix, no timestamp, none of the envelope other providers use. A
 *    generic SHA-256 verifier copied from another integration rejects every genuine delivery.
 *    (Confirmed against vercel.com/docs/drains/security and vercel.com/docs/headers/request-headers,
 *    September 2026. HMAC-SHA1 is not a weakness here — collision attacks on SHA-1 do not extend to
 *    HMAC-SHA1 forgery — and the algorithm is the sender's choice regardless.)
 *
 * 3. **Constant-time comparison**, for the reason `secretsMatch` in lib/cron.ts:24-32 gives: a `===`
 *    on a credential is a timing oracle, the risk is small, and the fix is free. The well-formedness
 *    checks that precede it are NOT constant-time, and that is fine — they leak only whether the
 *    caller sent forty hex characters, which the caller already knows. What must not leak is how
 *    much of a valid-SHAPED signature was correct, and that comparison is timing-safe. Length is
 *    normalised before it so `timingSafeEqual` cannot throw, which would turn an auth check into a
 *    500 and leak the length through the exception path.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function verifyDrainSignature(
  rawBody: Buffer,
  offeredSignature: string | null,
  secret: string
): boolean {
  if (!offeredSignature) return false;

  // Vercel emits lowercase hex; accepting uppercase costs nothing and removes a class of false
  // negative that reads as "the secret is wrong" and sends somebody rotating a healthy secret.
  const offered = offeredSignature.trim().toLowerCase();
  if (offered.length !== SIGNATURE_HEX_LENGTH) return false;
  if (!/^[0-9a-f]+$/.test(offered)) return false;

  const expected = createHmac("sha1", secret).update(rawBody).digest("hex");
  return timingSafeEqual(Buffer.from(offered, "ascii"), Buffer.from(expected, "ascii"));
}

export type DeliveryFraming = "ndjson" | "json-array" | "unparsed";

export interface FramedDelivery {
  /** Exactly what should be written to storage. */
  bytes: Buffer;
  /** Advisory only — see `countRecords`. Reaches the response body and the server log line. */
  records: number;
  framing: DeliveryFraming;
  extension: string;
  contentType: string;
  /**
   * SHA-256 of the bytes AS DELIVERED, before any redaction. See the header below: the stored object
   * is no longer byte-identical to what the signature covered, and this is what is left of that
   * property. `drainDeliveryKey` puts a prefix of it in the object's own name, so a listing of a day
   * carries the provenance of every delivery in it without any reader having to open a file.
   */
  sourceDigest: string;
  /**
   * Lines that could not be parsed as JSON and were therefore stored as they arrived, unredacted.
   * Reaches the server log line so the residue described in the header is visible rather than
   * assumed to be zero.
   */
  unscrubbedLines: number;
}

/**
 * The record fields that hold a REQUEST TARGET — a path with a query string, or a whole URL.
 *
 * `path` at the top level and `proxy.path` are the ones Vercel's own reference names: `proxy.path` is
 * documented verbatim as "Request path with query parameters", with `/api/users?page=1` as the
 * example. `proxy.referer` is the third because a referer is a URL by definition and carries whatever
 * query string the previous page had.
 *
 * ⚠ THIS LIST IS THE SCOPE OF THE REDACTION AND NOTHING ELSE IS TOUCHED. In particular `message` —
 * up to 256 KB of the application's own console output per record — is stored as it arrives. It has
 * no structure to scrub: it is free text written by every `console.*` call in the tree, and a
 * pattern-matcher loose enough to find a credential in arbitrary prose is loose enough to destroy
 * evidence in it. The obligation that follows is on the WRITER, and it is the one lib/audit.ts and
 * lib/requestLog.ts already state: nothing in this application may print a credential. That is a rule
 * about `console.error("[drain] …")` calls, not about this function.
 */
const PROXY_TARGET_FIELDS = ["path", "referer"] as const;

/**
 * Turn a delivery into the one-record-per-line form the archive stores, with every request target in
 * it scrubbed by the same vocabulary the access log uses.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE NDJSON PATH USED TO PASS THE BYTES THROUGH VERBATIM. IT NO LONGER CAN, AND THE REASON IS
 * WORTH THE WHOLE COST.
 *
 * The rejected design is documented here rather than deleted, because it is genuinely attractive and
 * somebody will propose it again. A drain delivers either NDJSON or a JSON array
 * (vercel.com/docs/drains/reference/logs); the archive wants one record per line either way, so a
 * day's objects concatenate into something greppable. Passing NDJSON through untouched meant no JSON
 * work at all on the hot path of an endpoint that must return quickly — a receiver that is slow under
 * load gets its deliveries RETRIED, which is how a traffic spike becomes a second traffic spike on a
 * plan billed by the invocation — and it meant the bytes in the bucket were byte-identical to the
 * bytes the signature was computed over, which is a real property for an evidence store.
 *
 * WHAT IT ALSO MEANT: `proxy.path` is "Request path with query parameters", so
 * `GET /api/cron/purge?secret=<CRON_SECRET>` — a form `assertCronAuthorised` (lib/cron.ts) once
 * supported for managed schedulers that cannot set a header, and now refuses with a 401, which does
 * not stop the platform logging the request line of a stale scheduler — was filed verbatim into
 * `files/logs/vercel/<date>/`, under a ≥90-day retention policy, readable by every operator and by
 * the CIC recipient of any range export. The same applies to every invitation and password link:
 * `/studio/set-password?token=<live credential>` in cleartext is account takeover for the life of the
 * token. lib/cron.ts's own header warns that "a secret in a query string is logged by every proxy
 * between the scheduler and the app". The drain made this application one of those proxies, and the
 * only one whose log we are contractually obliged to KEEP.
 *
 * The sibling slice treats "a credential in a query string must never reach a log table" as its
 * central rule — `SECRET_QUERY_KEYS` in lib/requestLog.ts names `secret`, `token`, `code` and `state`
 * for precisely these call sites. Writing the same URLs into the same `files/logs/` root with none of
 * that scrubbing was not a different trade-off; it was the same rule, unenforced on the larger of the
 * two surfaces.
 *
 * ── WHAT IS DONE INSTEAD, AND WHAT IT COSTS ───────────────────────────────────────────────────
 *
 * Every line is parsed, its request-target fields are run through `scrubRequestTarget` — the SAME
 * function `recordAccess` uses, imported rather than reimplemented, so a key added to
 * `SECRET_QUERY_KEYS` or to lib/audit.ts's `REDACTED_KEYS` covers both surfaces on the day it is
 * added — and the record is re-emitted. That is O(records) of JSON work, bounded by
 * `MAX_DELIVERY_BYTES` (8 MB) and by nothing else, on a handler that does one S3 PUT anyway. A
 * megabyte of NDJSON is single-digit milliseconds of `JSON.parse`; the PUT it precedes is tens.
 *
 * ⚠ THE BYTE-IDENTITY PROPERTY IS GONE AND CANNOT BE RECOVERED. What replaces it is
 * `sourceDigest`: SHA-256 over the delivered bytes, taken before anything is touched, with a prefix
 * of it embedded in the object key. It does not let a reader re-verify Vercel's signature — nothing
 * could, once the stored bytes differ — and it is not offered as an equivalent. It ties a stored
 * object to the exact delivery it came from, which is the part of provenance that survives redaction.
 * Storing the unredacted body somewhere alongside it would give back the property and give back the
 * disclosure with it, which is the whole thing being fixed.
 *
 * ⚠ A LINE THAT DOES NOT PARSE IS STORED AS IT ARRIVED, UNREDACTED, and counted in
 * `unscrubbedLines`. That is the residue and it is deliberate: a line that is not JSON has no
 * `proxy.path` to find, and the alternative — refusing the delivery — means a non-2xx, which Vercel
 * retries, so a body we cannot frame would be redelivered indefinitely, trip Vercel's "80% of
 * deliveries failed" alarm, and have its evidence discarded on every attempt. The same argument
 * keeps a whole body that is neither NDJSON nor a JSON array, stored under `.raw`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function frameDelivery(rawBody: Buffer): FramedDelivery {
  // Taken FIRST, over the bytes exactly as they arrived. Anything computed after a scrub would be a
  // digest of our own output and would attest to nothing.
  const sourceDigest = createHash("sha256").update(rawBody).digest("hex");
  const opener = firstMeaningfulByte(rawBody);

  // 0x5b is "[". Anything else is treated as NDJSON.
  if (opener !== 0x5b) return scrubNdjson(rawBody, sourceDigest);

  try {
    const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
    if (Array.isArray(parsed)) {
      const joined = parsed.map((record) => JSON.stringify(scrubRecord(record))).join("\n");
      return {
        bytes: Buffer.from(parsed.length > 0 ? `${joined}\n` : "", "utf8"),
        records: parsed.length,
        framing: "json-array",
        extension: "ndjson",
        contentType: "application/x-ndjson",
        sourceDigest,
        unscrubbedLines: 0
      };
    }
  } catch {
    // Fall through to the verbatim branch: see the ⚠ note above on why this is not a refusal.
  }

  return {
    bytes: rawBody,
    records: countRecords(rawBody),
    framing: "unparsed",
    extension: "raw",
    contentType: "application/octet-stream",
    sourceDigest,
    unscrubbedLines: countRecords(rawBody)
  };
}

/**
 * One record with its request targets scrubbed, as a shallow copy.
 *
 * A COPY rather than a mutation: the JSON-array branch holds the whole parsed body, and a function
 * that edited it in place would make the scrub depend on nobody ever reading `parsed` again. Shallow
 * is enough because only two levels are touched, and the untouched branches are shared by reference
 * rather than cloned — so this is a handful of allocations per record, not a deep copy of it.
 *
 * Anything that is not a plain object comes back untouched. A drain record is always an object; a
 * line that is a bare number or a string is not one we can interpret, and inventing a shape for it is
 * how a scrubber corrupts evidence it did not understand.
 */
function scrubRecord(record: unknown): unknown {
  if (!record || typeof record !== "object" || Array.isArray(record)) return record;

  const source = record as Record<string, unknown>;
  const out: Record<string, unknown> = { ...source };

  if (typeof source.path === "string") {
    out.path = scrubRequestTarget(source.path, redact) ?? source.path;
  }

  const proxy = source.proxy;
  if (proxy && typeof proxy === "object" && !Array.isArray(proxy)) {
    const nested: Record<string, unknown> = { ...(proxy as Record<string, unknown>) };
    for (const field of PROXY_TARGET_FIELDS) {
      const value = nested[field];
      if (typeof value === "string") nested[field] = scrubRequestTarget(value, redact) ?? value;
    }
    out.proxy = nested;
  }

  return out;
}

/**
 * The NDJSON path: one record per line in, one scrubbed record per line out.
 *
 * Blank lines are dropped rather than preserved, which is what `countRecords` already counted and
 * what a line-oriented reader expects. `\r` is trimmed so a CRLF delivery does not leave a stray
 * carriage return inside a JSON line — it would parse, but it would also survive into whatever an
 * operator exports the archive as.
 */
function scrubNdjson(rawBody: Buffer, sourceDigest: string): FramedDelivery {
  const lines: string[] = [];
  let unscrubbedLines = 0;

  for (const rawLine of rawBody.toString("utf8").split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length === 0) continue;
    try {
      lines.push(JSON.stringify(scrubRecord(JSON.parse(line))));
    } catch {
      // Not JSON. Kept verbatim and counted — see the ⚠ note in the header on why this is not a
      // refusal, and why the count reaches the server log line rather than being assumed to be zero.
      unscrubbedLines += 1;
      lines.push(line);
    }
  }

  return {
    bytes: Buffer.from(lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8"),
    records: lines.length,
    framing: "ndjson",
    extension: "ndjson",
    contentType: "application/x-ndjson",
    sourceDigest,
    unscrubbedLines
  };
}

/** The first byte that is not ASCII whitespace, or null for an empty or all-whitespace body. */
function firstMeaningfulByte(bytes: Buffer): number | null {
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte === undefined) return null;
    // space, tab, LF, CR
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return byte;
  }
  return null;
}

/**
 * How many records a pass-through body appears to hold: non-empty newline-separated segments.
 *
 * ADVISORY, and deliberately so. It counts LINES, so a pretty-printed single JSON object reads as
 * several. A record containing a newline inside a string does NOT break it, because JSON escapes
 * newlines inside strings. The number reaches the response body and the server log line and nothing
 * else — never the archive, never a billing figure — so one cheap pass over the bytes is the right
 * trade against a JSON parse per line.
 */
function countRecords(bytes: Buffer): number {
  let count = 0;
  let lineHasContent = false;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte === 0x0a) {
      if (lineHasContent) count += 1;
      lineHasContent = false;
      continue;
    }
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d) lineHasContent = true;
  }
  return lineHasContent ? count + 1 : count;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/**
 * The UTC calendar day as `YYYY-MM-DD`, the shape `dayPrefix` expects.
 *
 * UTC and not local time, because the whole archive is partitioned in UTC and a receiver that cut
 * its days at Asia/Kolkata midnight would file five and a half hours of every day under yesterday's
 * prefix — a gap a reader would find only by noticing that a date's own logs contain timestamps from
 * the date before.
 */
function utcDay(at: Date): string {
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

/**
 * Where one delivery is stored.
 *
 * `delivery-` and not `part-NNNN`: see the ⚠ block above on this source having no manifest. The two
 * names must stay distinguishable, because a later sealing job has to be able to tell the objects it
 * wrote from the ones that arrived on their own.
 *
 * ⚠ `digest` IS REQUIRED, and it is `FramedDelivery.sourceDigest` — the hash of the bytes AS
 * DELIVERED, not of the bytes being written. Passing the hash of the stored body instead would look
 * identical, cost the same, and attest to nothing: the whole value of the field is that it names a
 * delivery whose exact bytes no longer exist anywhere. Sixteen hex characters is 64 bits, which is
 * far more than collision avoidance within one millisecond needs and short enough to read in a
 * listing.
 */
export function drainDeliveryKey(input: { digest: string; extension?: string; at?: Date }): string {
  const at = input.at ?? new Date();
  const time = `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}${pad(at.getUTCMilliseconds(), 3)}`;
  const token = input.digest.slice(0, 16);
  return `${dayPrefix(DRAIN_SOURCE, utcDay(at))}/delivery-${time}-${token}.${input.extension ?? "ndjson"}`;
}

/**
 * Refuse, with a sentence an operator can act on, if the key the archive layout produced is one the
 * storage layer will not write.
 *
 * This should never fire. `dayPrefix` puts every key under `files/`, which is already in
 * `KEY_NAMESPACES`, so the check passes by construction today — it is here for the version of this
 * code that comes after somebody changes the root, the source name, or the namespace list. That is
 * the same reason `isSafeObjectKey` itself exists (keys.ts:113-119): keys are built, never taken
 * from a client, and the guard is for the paths where one arrives from somewhere unexpected.
 *
 * What it buys when it does fire is the MESSAGE. Without it the failure is
 * `ApiError(400, "That storage key is not valid.", bad_object_key)` from `assertKey`
 * (lib/storage/client.ts:116-120), which names neither the key nor the allowlist, arrives as a 400
 * that Vercel retries indefinitely, and sends the reader to inspect the key builder where nothing is
 * wrong. Failing here with the reason follows `serverSideEncryption` (client.ts:103-113), which
 * refuses a bad `S3_SSE_ALGORITHM` up front rather than letting the gateway reject the PUT at the
 * end of the transfer.
 *
 * 503 rather than 400, because a key the storage layer refuses is a deployment state — exactly how
 * `requireStorage` (client.ts:38-47) treats unconfigured storage.
 */
export function assertArchiveKeyWritable(key: string): void {
  if (isSafeObjectKey(key)) return;
  console.error(
    `[drain] refusing to store a delivery: the object key "${key}" is not accepted by ` +
      "isSafeObjectKey (lib/storage/keys.ts). Its first segment must be one of KEY_NAMESPACES, and " +
      "the log archive root is expected to sit under `files/` — check LOG_ARCHIVE_KEY_ROOT in " +
      "lib/logArchive.ts if that root has moved."
  );
  throw new ApiError(503, "The log archive is not able to accept writes on this deployment.", {
    code: "log_archive_unavailable"
  });
}

/**
 * The value to echo back on `x-vercel-verify`, or null when there is nothing to echo.
 *
 * Vercel has historically required an endpoint to prove it is under the control of whoever is
 * creating the drain before the drain may be created, by sending a token and expecting it back. The
 * current documentation for a dashboard-created custom endpoint describes no such challenge — it
 * simply tests the endpoint and expects a 200 — but the older integration flow did, and a receiver
 * that cannot answer one cannot be registered at all. Three lines removes that possibility.
 *
 * ⚠ THE VERIFICATION REQUEST IS NOT SIGNED, so it must not require a signature. That sounds like a
 * hole and is not: echoing a header the caller supplied tells the caller only what it already sent,
 * and `VERCEL_LOG_DRAIN_VERIFY` is useful only to somebody who has already been given it on the
 * Vercel side. Neither path touches storage, neither writes anything, and neither reveals whether a
 * drain secret is configured.
 */
export function verificationToken(request: Request): string | null {
  const offered = request.headers.get("x-vercel-verify")?.trim();
  if (offered) return offered;
  const configured = process.env.VERCEL_LOG_DRAIN_VERIFY?.trim();
  return configured ? configured : null;
}
