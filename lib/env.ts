import "server-only";

/**
 * Validated server environment.
 *
 * WHY THIS FILE EXISTS AT ALL. The Field Repository shipped a defect this module is written to make
 * impossible (skill §14.1 / §17): a build with a blank `NEXT_PUBLIC_API_URL` *silently fell back to
 * localhost*, so every signal was green while the deployed site reached nothing. The lesson
 * generalises — **a missing configuration value must be loud at boot, never a plausible default at
 * runtime**. So:
 *
 *   • Secrets are REQUIRED and validated for strength. A short or placeholder `JWT_SECRET` throws.
 *   • Optional integrations (S3, CDN) are allowed to be absent, but their absence is REPORTED
 *     through `storageConfigured` / `cdnConfigured` rather than papered over with a default that
 *     points somewhere wrong.
 *   • Nothing here is read at module scope in a way that would break `next build` on a machine with
 *     no `.env` — the accessors throw on USE, not on import, so a page that needs no database still
 *     type-checks and builds.
 *
 * `import "server-only"` is load-bearing: it turns "someone imported the JWT secret into a client
 * component" from a silent secret leak into a build error.
 */

// The JWT settings live in lib/auth/config.ts, NOT here, because middleware must read them and this
// module is `server-only`. Re-exported so `authEnv()` still has exactly one implementation and one
// import site for everything that is not middleware.
export { authEnv, jwtSecretWeakness, MIN_JWT_SECRET_LENGTH } from "./auth/config";
export type { AuthEnv, JwtAlgorithm } from "./auth/config";

function read(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function required(name: string): string {
  const value = read(name);
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

function readInt(name: string, fallback: number): number {
  const raw = read(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  // A malformed number is a configuration MISTAKE, not a request to use the default — silently
  // substituting one is how a 30-minute token TTL becomes 30 days without anybody noticing.
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}".`);
  }
  return parsed;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = read(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`Environment variable ${name} must be a boolean, got "${raw}".`);
}

export interface StorageEnv {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string | undefined;
  /** The origin the BROWSER must use for signed URLs. See `signer()` in lib/storage/client.ts. */
  publicEndpoint: string | undefined;
  forcePathStyle: boolean;
  sseAlgorithm: string | undefined;
}

/**
 * ⚠ `S3_PUBLIC_BASE_URL` IS NOT PART OF THIS SHAPE, AND THAT IS DELIBERATE.
 *
 * It is a BUILD-TIME variable, read once by `remotePatternsFromEnv()` in next.config.ts to derive the
 * image optimiser's host allowlist. Nothing at run time turns an object key into a URL with it: the
 * only function that addresses a stored object publicly is `publicObjectUrl()` in lib/media/url.ts,
 * which reads `NEXT_PUBLIC_CDN_URL` and nothing else, because that module is client-safe and Next can
 * only inline a `NEXT_PUBLIC_` name written out in full.
 *
 * It used to be carried here as `StorageEnv.publicBaseUrl`, read by no one, which made it look like a
 * second public base and was half the reason the diagnostics warning below was wrong about it.
 */

/**
 * True when object storage is fully configured. Callers branch on this rather than catching a throw,
 * because "storage is not set up on this machine" is a normal state during local development of the
 * public pages and must not crash them — but an UPLOAD attempted without it fails loudly.
 */
export function storageConfigured(): boolean {
  return Boolean(
    read("S3_BUCKET") && read("S3_ACCESS_KEY_ID") && read("S3_SECRET_ACCESS_KEY") && read("S3_REGION")
  );
}

let cachedStorage: StorageEnv | null = null;

export function storageEnv(): StorageEnv {
  if (cachedStorage) return cachedStorage;
  cachedStorage = {
    bucket: required("S3_BUCKET"),
    region: required("S3_REGION"),
    accessKeyId: required("S3_ACCESS_KEY_ID"),
    secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
    endpoint: read("S3_ENDPOINT"),
    publicEndpoint: stripTrailingSlash(read("S3_PUBLIC_ENDPOINT")),
    forcePathStyle: readBool("S3_FORCE_PATH_STYLE", false),
    sseAlgorithm: read("S3_SSE_ALGORITHM")
  };
  return cachedStorage;
}

function stripTrailingSlash(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function databaseUrl(): string {
  return required("DATABASE_URL");
}

/**
 * The public origin. Falls back to localhost ONLY outside production; in production a missing value
 * throws, because canonical URLs, Open Graph tags and the sitemap all silently point at localhost
 * otherwise — the exact failure mode described in the skill's §14.1.
 *
 * ⚠ A VERCEL PREVIEW IS THE ONE PRODUCTION BUILD THAT FALLS BACK, AND IT FALLS BACK TO ITSELF.
 * `next build` runs with NODE_ENV=production on previews too, and Preview has no NEXT_PUBLIC_SITE_URL,
 * so every preview build died here while collecting page data. Giving Preview the production origin
 * would be the wrong fix: a password or newsletter link minted on a preview would carry its token to
 * production, where it does not exist. A configured value still wins, and production without one
 * still throws — `VERCEL_URL` is set on production deployments as well, and is not read there.
 */
export function siteUrl(): string {
  const configured = stripTrailingSlash(read("NEXT_PUBLIC_SITE_URL"));
  if (configured) return configured;
  const preview = previewOrigin();
  if (preview) return preview;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "NEXT_PUBLIC_SITE_URL is required in production — canonical URLs, Open Graph images and " +
        "sitemap.xml would otherwise be published pointing at localhost."
    );
  }
  return "http://localhost:3000";
}

/**
 * A Vercel preview's own origin, or undefined anywhere else. The branch URL comes first because it
 * survives the next push to the branch, so a link sent from one build still opens on the next; the
 * per-deployment URL covers a preview with no branch. Vercel sets both without a scheme.
 */
function previewOrigin(): string | undefined {
  if (read("VERCEL_ENV") !== "preview") return undefined;
  const host = read("VERCEL_BRANCH_URL") ?? read("VERCEL_URL");
  return host ? `https://${host}` : undefined;
}

export function siteName(): string {
  return read("NEXT_PUBLIC_SITE_NAME") ?? "Centre of Excellence";
}

export function cdnBaseUrl(): string | undefined {
  return stripTrailingSlash(read("NEXT_PUBLIC_CDN_URL"));
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * How long a soft-deleted asset's BYTES survive in the bucket before the purge job may remove them.
 *
 * Long by default (30 days) and deliberately independent of the row's soft delete: the recycle bin
 * is only a real safety net if the object it points at still exists. A window shorter than a working
 * fortnight turns "restore the photograph we deleted before the holidays" into a permanent loss.
 */
export function mediaPurgeAfterDays(): number {
  return readInt("MEDIA_PURGE_AFTER_DAYS", 30);
}

/**
 * The floor the retention window may not go below, in days.
 *
 * Not a preference. The hosting undertaking signed with IIT KGP's Computer and Informatics Centre
 * requires website logs to be "retained for a MINIMUM OF 90 DAYS and made available to CIC upon
 * request", and clause 5 makes non-compliance grounds for deactivating the site. A number below this
 * is not a configuration choice, it is a breach, so it is refused rather than accepted quietly.
 */
export const ACCESS_LOG_RETENTION_FLOOR_DAYS = 90;

/**
 * The default access-log window, as a named constant because a SECOND module needs the number.
 *
 * `archiveScanDays()` in lib/logArchive.ts falls back to it when `accessLogRetentionDays()` throws on
 * a malformed value — an archiver must not stop scanning because a number it only uses to bound a
 * loop was mistyped. Exported rather than copied for the reason `LOG_RETENTION_FLOOR_DAYS` states at
 * length about the two 90s: two hand-maintained copies of a retention number are one edit away from
 * a system that enforces one value in one place and a different one in another, and reports success
 * from both.
 */
export const ACCESS_LOG_RETENTION_DEFAULT_DAYS = 180;

/**
 * How long a row in `access_logs` survives before a purge job may delete it.
 *
 * 180 BY DEFAULT, NOT 90, AND THE GAP IS THE POINT. 90 is the obligation; a window set AT the
 * obligation has no margin at all — one cron run that fails over a long weekend, one deploy that
 * forgets to register the job, one clock skew, and the oldest rows the undertaking promises are
 * already gone. Ninety days of margin costs a few hundred megabytes and buys the difference between
 * "we keep 90 days" and "we can PROVE we kept 90 days", which is the only version of the claim that
 * survives being asked for evidence.
 *
 * Below the floor it THROWS rather than clamping. Clamping would mean an administrator who set 30
 * believed the site kept 30 days while it kept 90, and the first person to discover the disagreement
 * would be whoever was reconciling a log export against what had been filed with CIC. `readInt`
 * already throws on a malformed or non-positive value, for the reason spelled out at its definition.
 *
 * ⚠ THIS IS THE THIRD RETENTION RULE IN THE APPLICATION AND NO TWO OF THEM ARE THE SAME. Media and
 * file BYTES: `mediaPurgeAfterDays()` above, 30 days, deliberately independent of the row's soft
 * delete. Sessions: 7 days, hardcoded in `pruneExpiredSessions()` (lib/auth/session.ts). Access logs:
 * this one, 180. `AuditLog` is a fourth case and is on NO window at all — it is content provenance,
 * read by lib/provenance.ts over the whole history, and purging it would silently break "has this
 * ever been restored". app/studio/recycle-bin/page.tsx already warns in capitals that two of these
 * are different rules; a third is a reason to name them all in one place, not to hope the reader
 * remembers.
 */
export function accessLogRetentionDays(): number {
  const days = readInt("ACCESS_LOG_RETENTION_DAYS", ACCESS_LOG_RETENTION_DEFAULT_DAYS);
  if (days < ACCESS_LOG_RETENTION_FLOOR_DAYS) {
    throw new Error(
      `ACCESS_LOG_RETENTION_DAYS is ${days}, below the ${ACCESS_LOG_RETENTION_FLOOR_DAYS}-day minimum ` +
        "the IIT KGP hosting undertaking requires. Raise it, or remove it to use the 180-day default."
    );
  }
  return days;
}

/**
 * Whether `route()` writes an `access_logs` row at all. ON unless explicitly switched off.
 *
 * ⚠ SWITCHING THIS OFF BREAKS A BINDING UNDERTAKING, so it defaults to true and its being false is
 * REPORTED in the diagnostics panel below rather than left to be discovered. It exists for one
 * situation, which is not hypothetical on a free database tier: the log insert starts failing for
 * every request — storage exhausted, connection limit reached — and each request then pays a doomed
 * round trip and a console line for nothing. The write is already structurally unable to fail a
 * request (lib/requestLog.ts never throws), so this is not a safety valve for correctness; it is the
 * lever that stops the bleeding without a deploy, and it is meant to be put back the same day.
 *
 * The other case it covers is a systematic 4xx on a high-traffic public endpoint. `/api/public/views`
 * is called once per public page view, and the scope rule in lib/requestLog.ts logs a public request
 * only when it was refused — so an endpoint that starts refusing every call turns that rule into a
 * row per page view.
 */
export function accessLogEnabled(): boolean {
  return readBool("ACCESS_LOG_ENABLED", true);
}

/**
 * Has an operator stated that the log archive's destination is NOT anonymously readable?
 *
 * ⚠ IT DEFAULTS TO "NO", AND EVERYTHING THAT WRITES UNDER `files/logs/` IS EXPECTED TO REFUSE ON IT.
 * The media bucket grants anonymous `s3:GetObject` on every key (docker/minio-public-read.json, and
 * docker-compose.yml says a real S3 bucket "needs the same care"), while archive keys are derived
 * from a date on purpose so a reader can fetch a range without listing. Anonymous GetObject plus a
 * derivable key is publication. `archiveDestinationPrivacy()` in lib/logArchive.ts wraps this with
 * the sentence that names the bucket policy and the fix; both the nightly archive job and the log
 * drain receiver refuse until this says yes.
 *
 * ⚠ IT RETURNS A MALFORMED VALUE RATHER THAN THROWING ON IT, WHICH DIVERGES FROM `readBool` ABOVE ON
 * PURPOSE. `readBool` throws on an unrecognised value and is right to: silently substituting a
 * default is how a 30-minute token TTL becomes 30 days. Here the substituted default is INACTION —
 * nothing is written and the reason is reported — so it cannot cause the harm that doctrine exists
 * to prevent, and a throw inside a cron job would take the whole run down before `runCronJob` writes
 * the line that explains what is wrong. The caller gets `malformed` so the difference between "set to
 * nonsense" and "never set" reaches the operator, which is the part that decides what they do next.
 */
export function logArchiveDestinationIsPrivate(): {
  confirmed: boolean;
  malformed: boolean;
  raw: string;
} {
  const raw = process.env.LOG_ARCHIVE_DESTINATION_IS_PRIVATE?.trim().toLowerCase() ?? "";
  if (["1", "true", "yes", "on"].includes(raw)) return { confirmed: true, malformed: false, raw };
  return {
    confirmed: false,
    malformed: raw.length > 0 && !["0", "false", "no", "off"].includes(raw),
    raw
  };
}

/**
 * Every configuration problem the app can detect, as sentences. Rendered by the CMS's Settings →
 * Diagnostics panel so an administrator sees "media uploads are disabled because S3_BUCKET is not
 * set" instead of discovering it when an upload fails at 90%.
 */
export function configurationWarnings(): string[] {
  const warnings: string[] = [];
  if (!storageConfigured()) {
    warnings.push(
      "Object storage is not configured (S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY). " +
        "Media and file uploads are disabled until it is."
    );
  }
  /**
   * ⚠ `NEXT_PUBLIC_CDN_URL` ALONE, because it is the only variable that can address a stored image.
   *
   * This warning once accepted `S3_PUBLIC_BASE_URL` as an alternative and promised a signed-URL
   * fallback. Neither was true: signing exists for document DOWNLOADS only, and an operator who
   * followed docs/DEPLOYMENT.md, set the storage base and left the CDN base blank got a silent
   * diagnostics panel and an "Image unavailable" placeholder in place of every photograph on the
   * public site — the discover-it-when-it-fails outcome this whole function exists to prevent.
   */
  if (!read("NEXT_PUBLIC_CDN_URL")) {
    warnings.push(
      "NEXT_PUBLIC_CDN_URL is not set, so stored images have no public address: every photograph on " +
        "the site renders as an “Image unavailable” placeholder. Set it to the public base URL of the " +
        "bucket (S3_PUBLIC_BASE_URL is read only at build time, for the image optimiser's host " +
        "allowlist, and cannot stand in for it) and rebuild — it is inlined at build time."
    );
  }
  if (!read("DIRECT_DATABASE_URL")) {
    warnings.push(
      "DIRECT_DATABASE_URL is not set. Migrations will run through the pooled connection, which fails " +
        "against a transaction-mode pooler."
    );
  }
  // Not on a preview that resolved its own address: that is the correct state there (see `siteUrl()`),
  // and a warning no correct deployment can clear is one operators learn to skip.
  if (isProduction() && !read("NEXT_PUBLIC_SITE_URL") && !previewOrigin()) {
    warnings.push("NEXT_PUBLIC_SITE_URL is not set — canonical URLs and sitemap entries will be wrong.");
  }
  /**
   * The request log, which is the only thing standing behind clause 4 of the hosting undertaking.
   *
   * ⚠ WRAPPED, BECAUSE BOTH ACCESSORS THROW ON PURPOSE. `accessLogEnabled()` throws on a value that is
   * not a boolean and `accessLogRetentionDays()` throws below the 90-day floor — and this function is
   * rendered by a panel whose whole job is to list configuration problems. An unhandled throw here
   * would replace that list with a 500, hiding every other warning behind the one that shouted
   * loudest. So the message becomes a warning like any other, which is what the reader needed anyway.
   */
  try {
    if (!accessLogEnabled()) {
      warnings.push(
        "ACCESS_LOG_ENABLED is off, so no record is being kept of requests to the studio or to the " +
          "authentication routes. The IIT KGP hosting undertaking requires website logs to be retained " +
          "for at least 90 days and produced to CIC on request; while this is off there is nothing to " +
          "produce."
      );
    } else {
      // Called for its throw, not its value: an out-of-range window is a problem to report here rather
      // than one for the purge job to hit at 03:17 where nobody is watching.
      accessLogRetentionDays();
    }
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }
  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * THE LOG ARCHIVE, WHICH IS INERT BY DEFAULT AND UNTIL THIS EXISTED SAID SO NOWHERE DURABLE.
   *
   * `logs-archive` runs nightly, takes the `!privacy.confirmed` early return, returns 200 with
   * `processed: 0`, and writes its explanation into a `[cron]` console line that Vercel's Hobby plan
   * discards after ONE HOUR — which is the exact retention problem the archive exists to solve. The
   * flag is in no `.env.example` (it is now) and in no deployment doc (it is now), so the realistic
   * path was: deploy, never set it, and discover nine months later that the mechanism standing behind
   * a signed undertaking had never written a byte. Nothing was broken on screen; the panel built to
   * list configuration problems reported a clean configuration.
   *
   * That is what this entry is for. It is not a preference an administrator might reasonably leave
   * alone — it is a precondition, and its default is refusal.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  if (storageConfigured()) {
    const privacy = logArchiveDestinationIsPrivate();
    if (!privacy.confirmed) {
      warnings.push(
        (privacy.malformed
          ? `LOG_ARCHIVE_DESTINATION_IS_PRIVATE is "${privacy.raw}", which is not a yes, so `
          : "LOG_ARCHIVE_DESTINATION_IS_PRIVATE is not set, so ") +
          "the nightly log archive is writing NOTHING and no platform log drain delivery would be " +
          "retained either. The IIT KGP hosting undertaking requires website logs to be retained for " +
          "at least 90 days and produced to CIC on request. The rows themselves are safe — nothing " +
          "deletes them — but there is no archive in object storage. Give the bucket a policy that " +
          "excludes files/logs/* from anonymous GetObject (or give the archive a private bucket of " +
          "its own), then set LOG_ARCHIVE_DESTINATION_IS_PRIVATE=true and the next runs back-fill " +
          "every pending day inside the scan window."
      );
    }
  }
  /*
   * A drain that is configured against a deployment that cannot store anything. This is the warning
   * lib/drains.ts's own header asked for, in the words it asked for.
   *
   * ⚠ NOTE WHICH DIRECTION IS WARNED ABOUT. Not "storage is configured but VERCEL_LOG_DRAIN_SECRET is
   * not" — drains are a Pro feature and this team is on Hobby, so that warning would be permanently
   * true on every correctly-behaving deployment, and a panel with a red line nobody can ever clear is
   * a panel operators stop reading. The combination below is different: somebody has deliberately set
   * a drain secret, which means a drain either exists or is about to, and every delivery it makes
   * will be refused with a 503 until storage is configured.
   */
  if (read("VERCEL_LOG_DRAIN_SECRET") && !storageConfigured()) {
    warnings.push(
      "VERCEL_LOG_DRAIN_SECRET is set but object storage is not, so every platform log drain " +
        "delivery is being refused with a 503 and no platform logs are being retained. Vercel flags " +
        "the drain once 80% of deliveries fail; set S3_BUCKET, S3_REGION and the access keys."
    );
  }
  return warnings;
}
