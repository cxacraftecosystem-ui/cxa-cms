import { notFound, redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { requireStudioCapability } from "@/lib/auth/current-user";
import { canManageMedia } from "@/lib/permissions";

/**
 * One file, by its id — the stable studio address for a document or a dataset.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT REDIRECTS TO `/studio/files?file=<id>`, AND THAT IS THE DESIGN RATHER THAN A SHORTCUT.
 *
 * The file store is ONE screen: the list on the left, the chosen file's details — its versions, its
 * download count, who may download it and until when — in a panel beside it. That is the same shape as
 * the media library, and for the same reason: replacing a file is a thing you do while looking at the
 * rest of the store, and a separate detail page would mean the title, the category, the public flag and
 * the expiry each existed in two places to be edited from. Two editors for one row is how two of them
 * start disagreeing.
 *
 * So this route exists to be LINKED TO. A project's file list, an audit entry, an email from a colleague
 * and the recycle bin all point at `/studio/files/<id>`; every one of them lands on the store with that
 * file already open.
 *
 * ⚠ IT STILL CHECKS THE PERMISSION AND THE ROW BEFORE REDIRECTING, and both matter:
 *
 *   • `requireStudioCapability(canManageMedia)` is the first statement, exactly as on every other studio page.
 *     A redirect that happened before the check would hand an unauthorised reader a `Location` header
 *     naming a file id — which is a small leak, but it is a leak from the one place that exists to stop
 *     them getting anything at all.
 *   • `notFound()` for a missing or soft-deleted file, rather than a redirect to a screen that would open
 *     an empty panel. A stale link must answer 404, not 200 with nothing in it — a link checker cannot
 *     tell the difference and neither can the person who followed it.
 *
 * ⚠ THE `notFound()` IS ALSO WHY NEITHER THIS SEGMENT NOR `app/studio/files` MAY EVER GAIN A
 * `loading.tsx`: streaming a fallback flushes the response headers as `200 OK` before the body is
 * decided, so the 404 would be rendered under a success status (contract §13a).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export default async function StudioFilePage({ params }: { params: Promise<{ id: string }> }) {
  await requireStudioCapability(
    canManageMedia,
    "The file store needs media manager access or higher. An administrator can raise yours."
  );

  const { id } = await params;

  // The narrowest possible read: this route renders nothing, so it needs to know one thing only — does a
  // live row with this id exist.
  const file = await prisma.fileAsset.findFirst({
    where: { id, deletedAt: null },
    select: { id: true }
  });

  if (!file) notFound();

  // `redirect()` throws a control-flow signal that Next catches, so it must not sit inside a try/catch —
  // there is deliberately none in this function.
  redirect(`/studio/files?file=${encodeURIComponent(file.id)}`);
}
