import type { NextRequest } from "next/server";
import { z } from "zod";
import { assertSameOrigin, ok, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { canAuthor } from "@/lib/permissions";
import {
  LOCK_TTL_MS,
  acquireLock,
  buildAuditContext,
  parseStudioJson,
  parseStudioQuery,
  readLock,
  releaseLock,
  takeOverLock
} from "@/lib/studio/crud";

/**
 * "Somebody else is editing this."
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS ENDPOINT ALWAYS ANSWERS 200. IT NEVER REFUSES ANYBODY.
 *
 * `ContentLock` is ADVISORY by design (prisma/schema.prisma), and this route is where that word has to be
 * honoured. A lock that blocked editing would be a lock that strands content: the tab that took it crashes,
 * the editor goes on leave, and a page nobody can open is a page nobody can fix. So a request for a lock
 * somebody else holds is not an error — it comes back with WHO holds it and `mine: false`, and the screen
 * shows a note rather than a wall.
 *
 * `PageEditor` reads it the same way round: a FAILED lock request means "carry on editing" and shows one
 * line of explanation. A lock service that is not there must not stop the studio working.
 *
 * ⚠ THE SEMANTICS LIVE IN `lib/studio/crud.ts`, NOT HERE. `acquireLock`, `readLock`, `releaseLock` and
 * `takeOverLock` own the expiry rule, the `acquiredAt` rule, the unique-index race and the audit entry. This
 * file is the HTTP shape around them and nothing more — two implementations of "who holds this" is two
 * answers to one question, and the one an editor sees would be whichever screen they happened to open.
 *
 * WHY `acquireLock` FOR BOTH THE FIRST CLAIM AND THE HEARTBEAT. The studio sends the same POST every sixty
 * seconds, and `acquireLock` already does the right thing in all three cases: takes a free lock, refreshes
 * one that is yours (keeping the original `acquiredAt`, so "has had this open since 14:32" stays true), and
 * reports the holder when it is somebody else's. `refreshLock` exists for a caller that must NEVER take a
 * lapsed lock; a studio heartbeat after a sleeping laptop should take it, so this is not that caller.
 *
 * ⚠ A HEARTBEAT IS NOT AUDITED. A TAKE-OVER IS. Sixty entries an hour per open editor would bury the audit
 * log, and the log is only ever read during an incident — so an ordinary acquire writes nothing.
 * `takeOverLock` files its entry against the CONTENT rather than the lock row, so an editor reading an
 * article's history sees "editing was taken over" beside the saves it explains.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `canAuthor` — the floor for any write at all. A viewer cannot edit, so a lock they held would be a lock
 * nobody could explain.
 */

export const dynamic = "force-dynamic";

/**
 * The entity types a lock may be taken on.
 *
 * A closed list rather than any string: the lock is keyed on (entityType, entityId) with nothing enforcing
 * that the type exists, so a typo would create a lock nobody could ever see or release, and it would sit in
 * the table until its expiry.
 */
const LOCKABLE = [
  "Page",
  "Post",
  "Person",
  "Project",
  "Publication",
  "ResearchArea",
  "CoeEvent",
  "Craft",
  "GalleryAlbum",
  "FileAsset"
] as const;

const LockQuery = z.object({
  entityType: z.enum(LOCKABLE),
  entityId: z.string().trim().min(1, "Which record?").max(64)
});

const LockBody = z.object({
  entityType: z.enum(LOCKABLE),
  entityId: z.string().trim().min(1, "Which record?").max(64),
  /** True only when the reader has deliberately chosen to take it from whoever holds it. */
  takeOver: z.boolean().default(false),
  /**
   * What the record is called, for the audit entry a take-over writes.
   *
   * Optional, because the client that has the title on screen can supply it and one that does not should
   * not be blocked. `takeOverLock` files the entry against the entity id either way, so a missing label
   * costs the log a readable name rather than the entry itself.
   */
  entityLabel: z.string().trim().max(300).optional()
});

/** Seconds, so a client can time its heartbeat from the same number the server enforces. */
const TTL_SECONDS = LOCK_TTL_MS / 1000;

/** "held for 4 minutes", for a sentence somebody has to act on rather than a bare timestamp. */
function heldFor(since: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - since.getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes === 1) return "for a minute";
  if (minutes < 60) return `for ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "for about an hour" : `for about ${hours} hours`;
}

export const GET = route(async (request: NextRequest) => {
  const user = await requireCapability(canAuthor, "Editing needs author access or higher.");

  const query = parseStudioQuery(request, LockQuery);
  const state = await readLock(query.entityType, query.entityId, user);

  return ok({ ...state, ttlSeconds: TTL_SECONDS });
});

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const user = await requireCapability(canAuthor, "Editing needs author access or higher.");

  const body = await parseStudioJson(request, LockBody);
  const now = new Date();

  if (body.takeOver) {
    /**
     * Deliberately NOT conditional on somebody else holding it. `takeOverLock` writes the audit entry only
     * when the previous holder was another person, so a reader who pressed "take it over" a second time
     * simply keeps the lock and adds nothing to the log — and a race in which the other person released it
     * in the meantime is a claim rather than a failure.
     */
    const state = await takeOverLock(
      buildAuditContext(request, user),
      user,
      body.entityType,
      body.entityId,
      body.entityLabel ?? null
    );

    return ok({
      ...state,
      ttlSeconds: TTL_SECONDS,
      tookOver: true,
      message:
        "You now have this open. Whoever had it has NOT been signed out — their unsaved changes are still on " +
        "their screen, and whoever saves last wins. This has been written to the audit log."
    });
  }

  const state = await acquireLock(user, body.entityType, body.entityId);

  if (!state.mine && state.holder) {
    // 200, with the holder named. See the header: a 409 here would turn an advisory lock into a blocking one
    // at every client that treats a non-2xx as a failure.
    return ok({
      ...state,
      ttlSeconds: TTL_SECONDS,
      message:
        `${state.holder.userName} has had this open ${heldFor(state.holder.acquiredAt, now)}. You can still edit ` +
        "it — nothing is locked — but if you both save, the last save wins and the earlier one is lost. Talk to " +
        "them first, or take it over, which is recorded."
    });
  }

  return ok({ ...state, ttlSeconds: TTL_SECONDS, message: "You have this open." });
});

export const DELETE = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const user = await requireCapability(canAuthor, "Editing needs author access or higher.");

  const query = parseStudioQuery(request, LockQuery);

  /**
   * `releaseLock` gives up YOUR OWN lock and leaves anybody else's alone — releasing somebody else's
   * silently would be a take-over with no record of it, which is the one thing the take-over path exists to
   * prevent. Releasing a lock that has already expired is a no-op rather than an error, because the studio
   * fires this from a cleanup function it cannot await and a closing tab has nowhere to show a refusal.
   */
  await releaseLock(user, query.entityType, query.entityId);

  return ok({
    released: true,
    message: "Nobody is shown as editing this now, unless somebody else has taken it over."
  });
});
