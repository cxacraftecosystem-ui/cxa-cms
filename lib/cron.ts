import "server-only";
import { timingSafeEqual } from "node:crypto";
import { forbidden, unauthorized } from "@/lib/api";

/**
 * Authorising a scheduled job.
 *
 * A cron endpoint is a URL on the public internet that mutates data. It needs a credential, and the
 * credential needs three properties this module provides:
 *
 *   1. **Compared in constant time.** A `===` on a shared secret is a timing oracle. The secret is
 *      long, so this is a small risk — but it is a free fix and the habit is what matters.
 *   2. **Absent secret means REFUSE, not allow.** A deployment that forgot `CRON_SECRET` must have
 *      inert cron endpoints, not open ones. The failure mode of the opposite choice is that anybody
 *      can trigger a purge.
 *   3. **Header only.** Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`, and so does every
 *      scheduler this deployment uses (.github/workflows/*.yml). Nothing else is a credential.
 *
 * ⚠ THE `?secret=` QUERY FORM IS GONE, AND A REQUEST THAT STILL USES IT IS REFUSED WITH A 401 EVEN
 * WHEN ITS BEARER IS RIGHT. It was accepted "for schedulers that cannot set a header", and a secret in
 * a URL is written down by every proxy, platform log, browser history and drain between the scheduler
 * and the app — the credential that can trigger a purge, sitting in a 90-day archive. Refusing the
 * request outright, rather than ignoring the parameter, is what makes a misconfigured scheduler turn
 * red the same night instead of leaking the secret quietly for a year. The value is never compared
 * and never logged; the server log says only that the form was used. A scheduler that cannot send a
 * header must call through something that can (a GitHub Actions step, as both workflows do).
 */

/** The name of the retired query parameter. Exported for the tests, which pin its refusal. */
export const RETIRED_SECRET_PARAM = "secret";

/**
 * True when the URL carries a `?secret=` at all — empty or not, right or wrong. Read from the parsed
 * URL rather than a substring test so `?secretary=` is not caught and `?Secret=` is not either (the
 * parameter was always lower case; anything else was never a credential here).
 */
function carriesQuerySecret(request: Request): boolean {
  try {
    return new URL(request.url).searchParams.has(RETIRED_SECRET_PARAM);
  } catch {
    return false;
  }
}

/** Refuse the retired form, saying so to the operator WITHOUT repeating the value. */
function refuseQuerySecret(request: Request, job: string): never {
  let path = "(unreadable URL)";
  try {
    path = new URL(request.url).pathname;
  } catch {
    // The path is for the log line only; the refusal stands either way.
  }
  console.error(
    `[cron] ${job}: refused a request to ${path} that carried the secret in its query string. Only ` +
      "`Authorization: Bearer <secret>` is accepted. Move the scheduler to the header and ROTATE the " +
      "secret, since every hop that saw the URL has a copy."
  );
  throw unauthorized("Send the scheduler's secret as an Authorization: Bearer header, not in the URL.");
}

function bearerFrom(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // `timingSafeEqual` THROWS on a length mismatch, which would itself leak the length through an
  // exception path. Compare lengths first and return early — the length of a secret is not the part
  // worth protecting, and a thrown error inside an auth check is worse than a fast false.
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * Throws unless the request carries the cron secret as a bearer.
 *
 *   • 403 — the deployment has no `CRON_SECRET`, so nothing could be authorised.
 *   • 401 — the secret is configured and this request did not present it in the header: missing,
 *     wrong, or sent in the query string (see the header of this file).
 *
 * The message to a caller does not name the secret or echo anything it sent; the server log says
 * which case it was, because those need entirely different fixes.
 */
export function assertCronAuthorised(request: Request): void {
  const expected = process.env.CRON_SECRET?.trim();

  if (!expected) {
    console.error(
      "[cron] CRON_SECRET is not set, so scheduled jobs are refusing every request. " +
        "Set it in the environment and re-deploy."
    );
    throw forbidden("Scheduled jobs are not configured on this deployment.");
  }

  if (carriesQuerySecret(request)) refuseQuerySecret(request, "cron");

  const bearer = bearerFrom(request);
  if (bearer && secretsMatch(bearer, expected)) return;

  throw unauthorized("This endpoint is only callable by the scheduler.");
}

/**
 * Throws (403 when unconfigured, 401 otherwise) unless the request carries the newsletter drain's
 * bearer — `NEWSLETTER_DRAIN_SECRET` (the GitHub Actions schedule) or `CRON_SECRET` (Vercel's own cron,
 * which can only present that one).
 *
 * Header only, like `assertCronAuthorised`, with the same 403-unconfigured / 401-not-presented split and
 * the same outright refusal of a `?secret=` query. Both secrets are compared in constant time, both are
 * checked whatever the first answer was, and an unset secret matches nothing.
 */
export function assertNewsletterDrainAuthorised(request: Request): void {
  const drain = process.env.NEWSLETTER_DRAIN_SECRET?.trim() ?? "";
  const cron = process.env.CRON_SECRET?.trim() ?? "";

  if (!drain && !cron) {
    console.error(
      "[cron] neither NEWSLETTER_DRAIN_SECRET nor CRON_SECRET is set, so the newsletter drain is refusing " +
        "every request."
    );
    throw forbidden("Scheduled jobs are not configured on this deployment.");
  }

  if (carriesQuerySecret(request)) refuseQuerySecret(request, "newsletter-drain");

  const bearer = bearerFrom(request);
  // Evaluated separately and OR-ed afterwards, so the time taken does not say which one matched.
  const matchesDrain = bearer.length > 0 && drain.length > 0 && secretsMatch(bearer, drain);
  const matchesCron = bearer.length > 0 && cron.length > 0 && secretsMatch(bearer, cron);
  if (matchesDrain || matchesCron) return;

  throw unauthorized("This endpoint is only callable by the scheduler.");
}

/**
 * The result shape every cron route returns.
 *
 * `skipped` and `failed` are REQUIRED, not optional. A job that reports only what it did leaves the
 * question "and what didn't it do?" unanswerable, which is exactly the question asked when something
 * has quietly stopped working for a fortnight.
 */
export interface CronResult {
  job: string;
  ranAt: string;
  durationMs: number;
  processed: number;
  skipped: number;
  failed: { id: string; reason: string }[];
  notes: string[];
}

export async function runCronJob(
  job: string,
  work: (notes: string[]) => Promise<{ processed: number; skipped: number; failed: CronResult["failed"] }>
): Promise<CronResult> {
  const startedAt = Date.now();
  const notes: string[] = [];
  const outcome = await work(notes);
  const result: CronResult = {
    job,
    ranAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    ...outcome,
    notes
  };
  // One structured line per run, so "when did this last work" is answerable from the platform log
  // without a database query.
  console.log(`[cron] ${job}`, JSON.stringify({ ...result, failed: result.failed.length }));
  return result;
}
