import "server-only";
import { rateLimitStoreInfo } from "@/lib/ratelimit";
import { storageConfigured } from "@/lib/env";

/**
 * One honest answer to "where is this running, and what does that mean?"
 *
 * WHY THIS FILE EXISTS. Several things in this application are correct on a long-lived server and only
 * approximately correct on a platform that starts and stops copies of the app on demand. Each of them is
 * documented where it lives, which means an administrator has to read seven source files to learn that
 * the rate limits are not what the numbers say. This module collects the consequences into sentences the
 * studio's diagnostics panel can print next to `configurationWarnings()` from `lib/env.ts`, which it
 * matches deliberately: same `string[]` shape, same plain-words register, same panel.
 *
 * ══ HOW DETECTION WORKS, AND ITS THREE HONEST LIMITS ══
 *
 * Vercel sets `VERCEL`; anything on AWS Lambda (including other platforms built on it) sets
 * `AWS_LAMBDA_FUNCTION_NAME`. There is no general answer beyond looking for the platforms by name, so
 * this is a list rather than a test, and a platform not on the list reads as a long-lived server.
 *
 *   1. **`VERCEL` is also set during the BUILD**, and by `vercel dev` locally. So `isServerless()` is
 *      true in places that are not serving traffic. Everything below is a warning rather than a
 *      behaviour switch, which makes that harmless — but do not gate real logic on this.
 *   2. **Longer-lived serverless is still not shared.** A platform that keeps an instance warm and sends
 *      it several requests at once reduces cold starts; it does not give two instances one counter. Every
 *      warning here is about state being PER INSTANCE, so warm instances do not change any of them.
 *   3. **This module is `server-only` and never reaches the edge.** `middleware.ts` runs on the edge
 *      runtime and imports none of this; the numbers below describe the Node functions.
 *
 * ══ THE AUDIT BEHIND `runtimeWarnings()` ══
 *
 * Every warning names something real. The codebase was searched for module-level `Map`/`Set`, `let
 * cached…`, `setInterval`, `globalThis` state and filesystem writes. What was found, and what it means:
 *
 *   • `lib/ratelimit.ts` — a bucket map on `globalThis`. THE ONE THAT CHANGES A DECISION: the limit a
 *     caller actually meets is the configured one times the number of running instances. Reported below
 *     unless a shared store has been registered.
 *   • `app/api/studio/reindex/route.ts` — `__cxaReindexState` on `globalThis`, the guard against two
 *     search-index rebuilds at once. Per instance, so two administrators can start two rebuilds. The
 *     route already returns `singleProcessGuardOnly: true` in its answer; this says it before the fact.
 *   • `lib/db.ts` — the Prisma client on `globalThis`. Each instance opens its OWN connection pool, so
 *     the database's connection limit is shared out across a number of instances that changes with
 *     traffic. This is the reason the runtime URL must be a pooled one.
 *   • `lib/env.ts` (`cachedStorage`), `lib/auth/config.ts` (`cached`), `lib/auth/tokens.ts`
 *     (`cachedKey`), `lib/storage/client.ts` (`cachedClient`, `cachedSigner`), `lib/auth/oauth.ts`
 *     (`jwksCache`) — module-level caches, every one of them derived from an environment variable or
 *     re-fetchable from the provider. A cold start rebuilds them. **Cost: latency on the first request,
 *     never a wrong answer**, so they are reported as one sentence about speed rather than five warnings.
 *   • `lib/settings/service.ts` — `getSettingsCached` is React's `cache()`, which is scoped to one
 *     render and not to the process. Nothing to warn about; listed so nobody "fixes" it into a real one.
 *   • `setInterval` appears only in client components (`SaveBar`, `PageEditor`, `AnnouncementManager`),
 *     where it is a timer in a browser tab. There is no server-side interval anywhere, which matters:
 *     a serverless instance is frozen between invocations and a background timer would simply not fire.
 *   • **No file is written anywhere outside `node_modules` and the build output.** `scripts/route-check.ts`
 *     reads the source tree, and nothing in `app/`, `lib/` or `components/` imports `node:fs` at all.
 *     Uploads never touch the server's disk: the browser is given a presigned URL and PUTs the bytes
 *     straight to object storage (`lib/storage/client.ts`). That is what makes this application
 *     deployable to a read-only filesystem without changing a line, and it is worth not breaking.
 *
 * To re-run the audit after a change:
 *
 *     npx tsc --noEmit
 *     rg -n "setInterval|node:fs|globalThis as unknown as" app lib components
 *     rg -n "^(const|let) \w+(: [^=]+)? = new (Map|Set)" lib
 */

export type RuntimeKind = "vercel" | "aws-lambda" | "long-lived";

function env(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function runtimeKind(): RuntimeKind {
  // Vercel is checked first: a Vercel function also sets the Lambda variables, and "Vercel" is the more
  // useful of the two answers because it is the thing an operator actually configures.
  if (env("VERCEL")) return "vercel";
  if (env("AWS_LAMBDA_FUNCTION_NAME")) return "aws-lambda";
  return "long-lived";
}

/**
 * True when the platform runs a variable number of short-lived copies of the app rather than one
 * process that stays up.
 *
 * Use it to WARN, not to branch. Nothing in this codebase behaves differently on the two platforms, and
 * it must stay that way: a code path that only runs on one of them is a code path nobody tests.
 */
export function isServerless(): boolean {
  return runtimeKind() !== "long-lived";
}

/** A short phrase for a diagnostics heading. Plain enough to print unedited. */
export function runtimeLabel(): string {
  switch (runtimeKind()) {
    case "vercel":
      // VERCEL_ENV distinguishes a production deployment from a preview build of a branch, which is the
      // difference an administrator most often needs when a change has not appeared on the live site.
      return `Vercel serverless functions${env("VERCEL_ENV") ? ` (${env("VERCEL_ENV")})` : ""}`;
    case "aws-lambda":
      return "AWS Lambda serverless functions";
    default:
      return "a long-lived server process";
  }
}

/**
 * What this runtime implies, as complete sentences ready to render.
 *
 * Ordered by how much each one can cost somebody: a limit that is not the stated limit first, then
 * database connections, then the two that only bite when two people act at once, then speed.
 *
 * ⚠ Every sentence has to be true for a reader who has never opened this repository, because the panel
 * that prints them is read by an administrator, not a developer. That is why "cold start" is explained
 * in words the first time it matters and never used as a term on its own.
 */
export function runtimeWarnings(): string[] {
  const warnings: string[] = [];
  const limiter = rateLimitStoreInfo();

  if (isServerless()) {
    if (!limiter.shared) {
      warnings.push(
        "The request limits on the sign-in form, second-factor codes, password links, the contact form, " +
          "event registration, search and counted downloads are tallied separately inside each copy of " +
          "the website this platform runs. Several copies run at once and new ones start whenever traffic " +
          "needs them, so the limit actually reached is the configured number multiplied by however many " +
          "copies are running, and a copy that has just started allows a whole fresh allowance. The " +
          "limits still stop an ordinary script; they are not a firm ceiling. Making them exact means " +
          "registering a shared counter, which lib/ratelimit.ts is written to accept without any other " +
          "change."
      );
    } else if (!limiter.synchronous) {
      warnings.push(
        `The shared request counter (${limiter.name}) is in use, but it can only be consulted by the ` +
          "parts of the site that were moved over to it. Anything still using the older path is tallied " +
          "inside one copy of the website, so those limits are multiplied by the number of copies " +
          "running. The server log names the store and the gap at start-up."
      );
    }

    warnings.push(
      "Each copy of the website opens its own connections to the database, and the number of copies " +
        "changes with traffic. DATABASE_URL must therefore point at a connection pooler, or a busy " +
        "period will use up the database's connection allowance and pages will start failing with a " +
        "connection error. DIRECT_DATABASE_URL is the unpooled address and is used only for migrations."
    );

    warnings.push(
      "Rebuild search index, on this screen, refuses to start a second rebuild while one is running — " +
        "but it can only see the rebuilds inside its own copy of the website. Two people pressing it at " +
        "the same moment may be served by different copies, and both rebuilds will run, which leaves the " +
        "index briefly missing whatever the first one had already written. Agree who is doing it, and " +
        "prefer a quiet time of day."
    );

    warnings.push(
      "There is no disk here to keep anything on. A temporary folder exists for the length of a single " +
        "request and is then thrown away, and nothing else on the server can be written to. That is why " +
        "uploads travel from the browser straight to object storage instead of passing through the " +
        "website, and why object storage is not optional on this platform."
    );

    if (!storageConfigured()) {
      warnings.push(
        "Object storage is not configured, and on this platform there is no local disk to fall back on, " +
          "so uploads cannot work at all until S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID and " +
          "S3_SECRET_ACCESS_KEY are set. On a normal server the same setting is merely recommended; here " +
          "it is required."
      );
    }

    warnings.push(
      "Nothing is remembered between requests. After a quiet period the next request has to rebuild the " +
        "storage connection, the sign-in signing key and each sign-in provider's public keys, so that " +
        "one request is slower than the ones after it — commonly a second or two on the first sign-in of " +
        "the morning. Nothing is lost by this and no figure on the site is affected."
    );
  } else {
    warnings.push(
      "Nothing on this server runs the two scheduled jobs. The schedule in vercel.json applies to Vercel " +
        "only. Arrange for something to call /api/cron/publish every ten minutes and /api/cron/purge once " +
        "a day, sending the header Authorization: Bearer followed by the value of CRON_SECRET. Publication " +
        "dates are applied every time a page is read, so a missing schedule publishes nothing early and " +
        "leaves no expired page readable — but the status column in the studio drifts out of step with " +
        "reality, and search keeps returning withdrawn pages by name until the job runs."
    );

    if (!limiter.shared) {
      warnings.push(
        "The request limits are tallied in this process's own memory, which is exact while exactly one " +
          "copy of the server is running. Running a second container behind the reverse proxy, or a " +
          "process manager with several workers, multiplies every limit by that number with nothing on " +
          "screen to say so. The guard that stops two search-index rebuilds running at once has the same " +
          "boundary."
      );
    }
  }

  return warnings;
}
