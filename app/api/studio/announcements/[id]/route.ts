import type { NextRequest } from "next/server";
import { z } from "zod";
// A VALUE import for the tone enum — see the sibling collection route.
import { AnnouncementTone, type Prisma } from "@prisma/client";

import { assertSameOrigin, badRequest, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageContent, canRestoreDeleted } from "@/lib/permissions";
import {
  buildAuditContext,
  fieldProblem,
  found,
  optionalDateTime,
  optionalText,
  parseStudioJson,
  requiredText
} from "@/lib/studio/crud";

/**
 * One announcement: change it, switch it on or off, remove it, or put a removed one back.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `PATCH` IS PARTIAL, AND IT HAS TO BE. The editor panel sends the whole record, but the row's own "Switch
 * off" button sends `{ isActive: false }` and nothing else. A schema that required the full record would
 * answer 422 to that button, and one that treated an absent key as `null` would wipe the dates of
 * everything anybody switched off.
 *
 * ⚠ EVERY OPTIONAL FIELD IS `.optional()` ON TOP OF ITS SHARED HELPER, AND THE ORDER MATTERS. The helpers
 * in lib/studio/crud.ts carry `.default(null)`, which fires for a MISSING key — exactly what a partial
 * patch must not do. Wrapping them in `.optional()` puts a `ZodOptional` outermost, and that
 * short-circuits an absent key to `undefined` before the default is ever reached, so "not mentioned"
 * stays distinguishable from "cleared" (contract §14 — a default fires for a missing key, never for an
 * explicit null).
 *
 * THE WINDOW IS CHECKED AGAINST THE MERGED RECORD, not against the patch. Sending only an end date must
 * still be refused when it lands before the start date already stored — checking the patch alone would let
 * a two-step edit assemble a window that can never open.
 *
 * ⚠ THE DELETE IS SOFT, AND THE RESTORE IS ON THIS ROUTE RATHER THAN THE RECYCLE BIN'S. `Announcement`
 * carries `deletedAt`, so nothing is destroyed — but `BIN_TYPES` in the recycle-bin route has no entry for
 * announcements, so a soft-deleted one would be reachable from no screen at all. A row that has silently
 * vanished is the failure contract §1.6 exists to prevent, so the announcements screen lists its own
 * removed rows and `{ restore: true }` here is what puts one back.
 *
 * ⚠ RESTORING NEEDS `canRestoreDeleted` — ADMINISTRATOR — AND EDITING DOES NOT. That is the ladder's rule
 * verbatim (lib/permissions.ts): deleting is stricter than editing, because a restore can resurrect
 * something an editor deliberately retired. The screen renders the Restore control only for a reader who
 * holds it and NEVER as a disabled button (contract §1.8); this check is the boundary, and the client
 * guard is the courtesy.
 *
 * ⚠ A RESTORED ANNOUNCEMENT COMES BACK SWITCHED OFF, whatever it was when it was removed. Putting a
 * banner straight back in front of the public as a side effect of undoing a deletion is the one outcome
 * nobody asks for, and switching it on again is one press away.
 *
 * A ROW THAT IS ALREADY GONE ANSWERS 404 WITH A SENTENCE, never a 500: two editors on the same screen is
 * the ordinary case, not an exception.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/** ⚠ The same three caps as the collection route and the studio screen. See that file's note. */
const MESSAGE_MAX = 240;
const LINK_LABEL_MAX = 48;
const HREF_MAX = 500;

const LIST_SELECT = {
  id: true,
  message: true,
  href: true,
  linkLabel: true,
  tone: true,
  startsAt: true,
  endsAt: true,
  isActive: true,
  dismissible: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true
} satisfies Prisma.AnnouncementSelect;

type AnnouncementRow = Prisma.AnnouncementGetPayload<{ select: typeof LIST_SELECT }>;

const PatchBody = z.object({
  message: requiredText(
    MESSAGE_MAX,
    "An announcement needs something to say. One sentence is usually right."
  ).optional(),
  href: optionalText(HREF_MAX).optional(),
  linkLabel: optionalText(LINK_LABEL_MAX).optional(),
  tone: z
    .nativeEnum(AnnouncementTone, {
      errorMap: () => ({ message: "Choose one of the four kinds of announcement from the list." })
    })
    .optional(),
  startsAt: optionalDateTime("The date it starts showing").optional(),
  endsAt: optionalDateTime("The date it stops showing").optional(),
  isActive: z.boolean().optional(),
  dismissible: z.boolean().optional(),
  /** Put a removed announcement back. Administrator only — see the header. */
  restore: z.literal(true).optional()
});

/** ⚠ Word for word the sentence AnnouncementManager.tsx shows in the form. See the collection route. */
function assertWindowOrder(startsAt: Date | null, endsAt: Date | null): void {
  if (!startsAt || !endsAt) return;
  if (endsAt.getTime() > startsAt.getTime()) return;
  throw fieldProblem(
    "endsAt",
    "The date it stops showing has to be after the date it starts. As it stands the announcement would never appear."
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PATCH — edit, switch, or restore
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const PATCH = route(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    assertSameOrigin(request);

    const { id } = await context.params;
    const body = await parseStudioJson(request, PatchBody);

    // The stricter of the two permissions decides, and it is asked for FIRST — a request that both
    // restores and edits must clear the restore bar before anything is written.
    const user = body.restore
      ? await requireCapability(
          canRestoreDeleted,
          "Putting a removed announcement back needs administrator access. An editor can write a new one instead."
        )
      : await requireCapability(
          canManageContent,
          "Changing an announcement needs editor access or higher. An administrator can raise yours."
        );

    const before = found(
      await prisma.announcement.findUnique({ where: { id }, select: LIST_SELECT }),
      "That announcement"
    );

    if (body.restore) {
      if (before.deletedAt === null) {
        throw badRequest(
          "That announcement has not been removed, so there is nothing to put back. Reload the screen to see where it stands."
        );
      }

      const restored = await mutateWithHistory<AnnouncementRow>(
        buildAuditContext(request, user),
        {
          action: "RESTORE",
          entityType: "Announcement",
          entityLabel: before.message,
          revise: false,
          before
        },
        async (tx) =>
          tx.announcement.update({
            where: { id },
            // Switched off on the way back in — see the header.
            data: { deletedAt: null, isActive: false },
            select: LIST_SELECT
          })
      );

      return ok({
        announcement: restored,
        changed: true,
        message:
          "The announcement is back in the list, switched off. Nothing has changed on the public site until you switch it on."
      });
    }

    // A removed row is not editable. Restoring it first is one press, and an edit that quietly revived
    // something somebody had thrown away is the sort of change nobody can account for afterwards.
    if (before.deletedAt !== null) {
      throw badRequest(
        "That announcement has been removed, so it cannot be changed. Put it back first, then edit it."
      );
    }

    // The merged window, so a one-field patch is judged on the record it would produce. See the header.
    const startsAt = body.startsAt !== undefined ? body.startsAt : before.startsAt;
    const endsAt = body.endsAt !== undefined ? body.endsAt : before.endsAt;
    assertWindowOrder(startsAt, endsAt);

    const data: Prisma.AnnouncementUncheckedUpdateInput = {};
    if (body.message !== undefined) data.message = body.message;
    if (body.href !== undefined) data.href = body.href;
    if (body.linkLabel !== undefined) data.linkLabel = body.linkLabel;
    if (body.tone !== undefined) data.tone = body.tone;
    if (body.startsAt !== undefined) data.startsAt = body.startsAt;
    if (body.endsAt !== undefined) data.endsAt = body.endsAt;
    if (body.isActive !== undefined) data.isActive = body.isActive;
    if (body.dismissible !== undefined) data.dismissible = body.dismissible;

    // An empty patch is answered with the row as it stands rather than with a write. It happens: the
    // screen sends a save for a panel nobody changed, and an UPDATE with no columns would still bump
    // `updatedAt` — which is half the dismissal key, so it would show a dismissed banner to everybody
    // again for no reason at all — and file an audit entry recording that nothing happened.
    if (Object.keys(data).length === 0) return ok({ announcement: before, changed: false });

    const switchedOn = body.isActive === true && !before.isActive;
    const switchedOff = body.isActive === false && before.isActive;
    const rewritten = body.message !== undefined && body.message !== before.message;

    const updated = await mutateWithHistory<AnnouncementRow>(
      buildAuditContext(request, user),
      {
        // PUBLISH and UNPUBLISH rather than UPDATE when the switch moved: an audit list read during an
        // incident needs to show WHEN a band went in front of the public, not that a row was edited.
        action: switchedOn ? "PUBLISH" : switchedOff ? "UNPUBLISH" : "UPDATE",
        entityType: "Announcement",
        entityLabel: body.message ?? before.message,
        revise: false,
        before
      },
      async (tx) => tx.announcement.update({ where: { id }, data, select: LIST_SELECT })
    );

    return ok({
      announcement: updated,
      changed: true,
      message: switchedOn
        ? "Switched on. It appears at the top of every page once its start date has passed, and it can take a few minutes to show while pages refresh."
        : switchedOff
          ? "Switched off. It has gone from the public site, though a page somebody already has open may show it for a few minutes."
          : rewritten
            ? "The wording has been saved. Anyone who had closed the earlier version will be shown this one."
            : "The announcement has been saved."
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DELETE — soft, and reversible from the announcements screen
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const DELETE = route(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    assertSameOrigin(request);

    const user = await requireCapability(
      canManageContent,
      "Removing an announcement needs editor access or higher. An administrator can raise yours."
    );

    const { id } = await context.params;

    const before = found(
      await prisma.announcement.findUnique({ where: { id }, select: LIST_SELECT }),
      "That announcement"
    );

    // Already gone. Answered as done rather than as an error: two editors on one screen is ordinary, and
    // "it was already removed" is not a fault either of them can act on.
    if (before.deletedAt !== null) {
      return ok({
        deleted: true,
        id: before.id,
        message: "That announcement had already been removed."
      });
    }

    await mutateWithHistory<{ id: string }>(
      buildAuditContext(request, user),
      {
        action: "DELETE",
        entityType: "Announcement",
        entityLabel: before.message,
        revise: false,
        before
      },
      // SOFT — `deletedAt`, never a real DELETE. See the header for where it can be seen afterwards.
      async (tx) =>
        tx.announcement.update({
          where: { id },
          data: { deletedAt: new Date() },
          select: { id: true }
        })
    );

    return ok({
      deleted: true,
      id: before.id,
      message: before.isActive
        ? "The announcement has been removed and has gone from the public site. It is listed under the removed ones at the foot of this screen, where an administrator can put it back."
        : "The announcement has been removed. It is listed under the removed ones at the foot of this screen, where an administrator can put it back."
    });
  }
);
