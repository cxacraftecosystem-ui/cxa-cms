import type { NextRequest } from "next/server";
import { z } from "zod";
// `AnnouncementTone` is imported as a VALUE, not just a type: `z.nativeEnum` needs the runtime object,
// and taking the vocabulary from Prisma rather than retyping it means a tone added to the schema cannot
// be one the studio is unable to save.
import { AnnouncementTone, type Prisma } from "@prisma/client";

import { assertSameOrigin, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageContent } from "@/lib/permissions";
import {
  buildAuditContext,
  fieldProblem,
  optionalDateTime,
  optionalText,
  parseStudioJson,
  requiredText
} from "@/lib/studio/crud";

/**
 * Announcements — the list, and writing a new one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireCapability` HERE, `requireStudioCapability` ON THE SCREEN. They are not interchangeable: this
 * pair throws an `ApiError` that `route()` turns into a 403 JSON body, and the page pair calls Next's
 * `forbidden()`. Using this one inside a Server Component produces a 500 telling an editor the site is
 * broken when in fact they were deliberately refused (contract §1.9).
 *
 * `canManageContent` IS EDITOR AND ABOVE, AND THAT IS ALSO THE PUBLISHING BAR. A band across every page
 * of the public site is a publication act, so there is deliberately NO second `canPublish` check:
 * `canManageContent` and `canPublish` are both satisfied at EDITOR, so a second test would either be
 * redundant or — worse — a second hand-rolled rank test that can disagree with the first
 * (lib/permissions.ts).
 *
 * THE ANSWER CARRIES BOTH THE LIVE ROWS AND THE REMOVED ONES, in one request.
 *
 * `Announcement` carries `deletedAt`, so a delete here is SOFT — and the recycle-bin screen does not list
 * announcements (`BIN_TYPES` in app/api/studio/recycle-bin/route.ts has no entry for them). A soft delete
 * that no screen can see is a row that has silently vanished, which is the failure contract §1.6 exists to
 * prevent. So the announcements screen shows its own removed rows and can restore them, and this route
 * hands both lists down together: there are a handful of announcements in total, and two requests to
 * answer one question is a race waiting to be written.
 *
 * NO PAGING, AND THE CAP IS REPORTED. Ordered newest first, which is also the order the public band
 * resolves "which one wins" in. `truncated` is in the body because a list that quietly stops is
 * indistinguishable from a place with no records, and the screen prints the sentence.
 *
 * NO REVISIONS, ONLY AN AUDIT ENTRY. `revise: false` for the same reason `Redirect` uses it: the whole row
 * is one sentence, a link, two dates and two flags, and the audit entry this write creates already holds
 * every one of them. A revision would be a second copy with no screen able to restore it.
 *
 * A SECOND LIVE ANNOUNCEMENT IS ALLOWED AND NOT REFUSED. The public band draws the most recently written
 * live one; refusing the second would mean an editor could not queue next week's notice while this week's
 * is still up. The STUDIO warns before it happens and says which one readers will see — see
 * AnnouncementManager.tsx.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * How many rows of each list one answer carries.
 *
 * Far above any real number of announcements. It exists so a table nobody has pruned in five years cannot
 * become one unbounded query, and `truncated` says when it bites.
 */
const MAX_ROWS = 100;

/**
 * The field caps, shared with the studio screen's character counters.
 *
 * ⚠ DUPLICATED IN app/studio/announcements/AnnouncementManager.tsx, AND IT HAS TO BE — that file is a
 * client component and this module is server-only by virtue of everything it imports. If one changes,
 * change both, or a counter will say "38 of 240" while the save refuses at 200.
 */
const MESSAGE_MAX = 240;
const LINK_LABEL_MAX = 48;
const HREF_MAX = 500;

/**
 * The tone, taken straight from the Prisma enum.
 *
 * The error map is not decoration: `lib/api.ts` guarantees `message` is a plain human sentence ready to
 * render, and Zod's own "Invalid enum value. Expected 'INFO' | 'SUCCESS' …" is not one.
 */
const toneSchema = z.nativeEnum(AnnouncementTone, {
  errorMap: () => ({ message: "Choose one of the four kinds of announcement from the list." })
});

/**
 * The columns the studio screen renders. Written out rather than taking the whole row, so a column added
 * later cannot start travelling to a browser nobody meant to send it to.
 */
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

/** The row this route answers with, derived from the select so the two cannot disagree. */
type AnnouncementRow = Prisma.AnnouncementGetPayload<{ select: typeof LIST_SELECT }>;

const CreateBody = z.object({
  message: requiredText(
    MESSAGE_MAX,
    "An announcement needs something to say. One sentence is usually right."
  ),
  href: optionalText(HREF_MAX),
  linkLabel: optionalText(LINK_LABEL_MAX),
  tone: toneSchema.default(AnnouncementTone.INFO),
  startsAt: optionalDateTime("The date it starts showing"),
  endsAt: optionalDateTime("The date it stops showing"),
  /**
   * OFF when the key is absent, even though the COLUMN defaults to on.
   *
   * The two are not in conflict and the difference is deliberate: the column's default is what a seed or a
   * script gets, and this is what a REQUEST that failed to say gets. A create call that omitted the flag
   * because of a client bug must not put an unread sentence in front of every visitor to the site. The
   * studio's form always sends the switch's real value, so an editor never meets this default.
   */
  isActive: z.boolean().default(false),
  dismissible: z.boolean().default(true)
});

/**
 * "It must stop after it starts", as one sentence.
 *
 * ⚠ THE SAME SENTENCE IS SHOWN IN THE FORM by AnnouncementManager.tsx, which refuses the save for the same
 * reason before it ever reaches here. Duplicated rather than imported because that file is a client
 * component; if one is reworded, reword both, or the studio will refuse a save for one reason and explain
 * a different one.
 */
function assertWindowOrder(startsAt: Date | null, endsAt: Date | null): void {
  if (!startsAt || !endsAt) return;
  if (endsAt.getTime() > startsAt.getTime()) return;
  throw fieldProblem(
    "endsAt",
    "The date it stops showing has to be after the date it starts. As it stands the announcement would never appear."
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// GET
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const GET = route(async () => {
  await requireCapability(
    canManageContent,
    "Announcements need editor access or higher. An administrator can raise yours."
  );

  // `id` breaks the ties on both lists, so the order is TOTAL — two rows created in the same millisecond
  // would otherwise arrive in a different order on every request, which reads as data moving on its own.
  const orderBy: Prisma.AnnouncementOrderByWithRelationInput[] = [
    { createdAt: "desc" },
    { id: "desc" }
  ];

  const [rows, total, removed, removedTotal] = await Promise.all([
    prisma.announcement.findMany({
      where: { deletedAt: null },
      orderBy,
      take: MAX_ROWS,
      select: LIST_SELECT
    }),
    prisma.announcement.count({ where: { deletedAt: null } }),
    prisma.announcement.findMany({
      where: { deletedAt: { not: null } },
      // Most recently removed first: a mistake somebody wants back is almost always the last one made.
      orderBy: [{ deletedAt: "desc" }, { id: "desc" }],
      take: MAX_ROWS,
      select: LIST_SELECT
    }),
    prisma.announcement.count({ where: { deletedAt: { not: null } } })
  ]);

  return ok({
    items: rows,
    total,
    /** REQUIRED READING for the screen. See the header. */
    truncated: total > rows.length,
    removed,
    removedTotal,
    removedTruncated: removedTotal > removed.length,
    limit: MAX_ROWS
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// POST
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageContent,
    "Writing an announcement needs editor access or higher. An administrator can raise yours."
  );

  const body = await parseStudioJson(request, CreateBody);
  assertWindowOrder(body.startsAt, body.endsAt);

  const created = await mutateWithHistory<AnnouncementRow>(
    buildAuditContext(request, user),
    {
      action: "CREATE",
      entityType: "Announcement",
      // The message itself is the handle: an announcement has no title, and "Announcement cm3x…" in an
      // audit list tells a reader nothing about what was put in front of the public.
      entityLabel: body.message,
      revise: false
    },
    async (tx) =>
      tx.announcement.create({
        data: {
          message: body.message,
          href: body.href,
          linkLabel: body.linkLabel,
          tone: body.tone,
          startsAt: body.startsAt,
          endsAt: body.endsAt,
          isActive: body.isActive,
          dismissible: body.dismissible,
          createdById: user.id
        },
        select: LIST_SELECT
      })
  );

  return ok(
    {
      announcement: created,
      message: created.isActive
        ? "The announcement is switched on. It appears at the top of every page once its start date has passed, and it can take a few minutes to show while pages refresh."
        : "The announcement has been saved and is switched off, so nobody outside the studio can see it yet."
    },
    { status: 201 }
  );
});
