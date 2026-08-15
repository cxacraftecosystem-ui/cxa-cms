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
 */
export function siteUrl(): string {
  const configured = stripTrailingSlash(read("NEXT_PUBLIC_SITE_URL"));
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "NEXT_PUBLIC_SITE_URL is required in production — canonical URLs, Open Graph images and " +
        "sitemap.xml would otherwise be published pointing at localhost."
    );
  }
  return "http://localhost:3000";
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
  if (isProduction() && !read("NEXT_PUBLIC_SITE_URL")) {
    warnings.push("NEXT_PUBLIC_SITE_URL is not set — canonical URLs and sitemap entries will be wrong.");
  }
  return warnings;
}
