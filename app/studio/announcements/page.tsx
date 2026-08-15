import type { Metadata } from "next";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageContent, canRestoreDeleted } from "@/lib/permissions";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { AnnouncementManager } from "./AnnouncementManager";

/**
 * Announcements — the band across the top of every page of the public site.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canManageContent)` IS THE FIRST STATEMENT, and it is the PAGE guard. It calls
 * Next's `forbidden()` and renders `app/forbidden.tsx` with a real 403 status. `requireCapability` — the
 * one the `/api/studio/announcements` handlers use — throws an `ApiError`, which inside a Server Component
 * becomes an unhandled throw and a **500** telling a reader the site is broken when they were in fact
 * deliberately refused (contract §1.9). They are not interchangeable, and the same predicate is on both
 * sides of the boundary.
 *
 * EDITOR AND ABOVE, because a sentence on every page of the site speaks for the institution. That is also
 * the publishing bar, so there is no separate publish permission to check — see the route's header.
 *
 * ⚠ `canRestoreDeleted` IS ASKED SEPARATELY AND HANDED DOWN. Removing an announcement is an editor's job;
 * putting a removed one back is an administrator's, because a restore can resurrect something an editor
 * deliberately retired (lib/permissions.ts). The screen renders the Restore control only for a reader who
 * holds it and never as a disabled button (contract §1.8) — a courtesy, since the route handler enforces
 * the same predicate.
 *
 * ONLY THE COUNT IS READ HERE. Everything else on this screen is fetched by the client component, because
 * every action — switching one on, changing its dates, removing one — has to leave the reader looking at
 * the same rows, which a server-rendered list cannot do. The count is for the header; the live figures come
 * WITH the list, so they stay right after a change.
 *
 * ⚠ NOTHING DATE-DEPENDENT IS RENDERED ON THE SERVER. "Starts in three days" depends on the reader's own
 * clock and time zone, which this render does not know: printing it here produces a hydration mismatch
 * that React resolves by keeping the SERVER's answer, which is the wrong one (the same trap
 * StatusControl.tsx documents). Every such sentence is computed in the browser, after the list arrives.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Announcements"
};

export default async function StudioAnnouncementsPage() {
  const user = await requireStudioCapability(
    canManageContent,
    "Announcements appear on every page of the public site, so they need editor access or higher. " +
      "An administrator can raise yours."
  );

  // Removed rows are excluded: the header's figure has to mean the same thing as the list beneath it.
  const total = await prisma.announcement.count({ where: { deletedAt: null } });

  return (
    <div className="mx-auto w-full max-w-[84rem] space-y-6">
      <StudioPageHeader
        title="Announcements"
        description="A single band across the top of every page: a closure, a deadline, a call for applications. Only one is ever shown — where two are switched on at once, readers see the one written most recently. An announcement can be given a date to start and a date to stop, and it appears and disappears on its own."
        meta={
          <span className="text-xs tabular-nums text-ink-500">
            {total === 1 ? "1 announcement" : `${total} announcements`}
          </span>
        }
      />

      <AnnouncementManager canRestore={canRestoreDeleted(user)} />
    </div>
  );
}
