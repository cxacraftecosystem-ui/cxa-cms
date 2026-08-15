import "server-only";
import { timingSafeEqual } from "node:crypto";
import { forbidden } from "@/lib/api";

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
 *   3. **Vercel's own scheduler is recognised.** Vercel Cron sends
 *      `Authorization: Bearer <CRON_SECRET>`; a `?secret=` query parameter is also accepted for
 *      other schedulers, with the caveat noted below.
 *
 * ⚠ A secret in a query string is logged by every proxy between the scheduler and the app. Prefer
 * the header. The query form exists because some managed schedulers cannot set one.
 */

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
 * Throws a 403 unless the request carries the cron secret.
 *
 * The message deliberately does not distinguish "no secret configured" from "wrong secret" to a
 * caller — but it DOES log the difference to the server, because those two need entirely different
 * fixes and an operator staring at a 403 has no other way to tell them apart.
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

  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (bearer && secretsMatch(bearer, expected)) return;

  const query = new URL(request.url).searchParams.get("secret")?.trim() ?? "";
  if (query && secretsMatch(query, expected)) return;

  throw forbidden("This endpoint is only callable by the scheduler.");
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
