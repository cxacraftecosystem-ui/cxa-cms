import type { Metadata } from "next";

import { prisma } from "@/lib/db";
import { requireStudioCapability } from "@/lib/auth/current-user";
import { ROLES_DESCENDING, canManageInquiries } from "@/lib/permissions";
import { getSettingCached } from "@/lib/settings/service";
import { HelpText } from "@/components/studio/HelpText";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { InquiryInbox } from "./InquiryInbox";

/**
 * The contact inbox.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canManageInquiries)` IS THE FIRST STATEMENT, and it is the same predicate the
 * `/api/studio/inquiries/*` handlers call and the same one `StudioNav` hides the sidebar entry with. It
 * THROWS rather than rendering (contract §1.8). Triage is an editor job because a reply speaks for the
 * institution.
 *
 * THE INBOX ITSELF IS A CLIENT COMPONENT because triage is a sequence of clicks — filter, open, claim,
 * note, archive — and every one of them has to leave the reader where they were. A server-rendered list
 * would re-run the whole page and lose the panel, the scroll position and the selection on each of them.
 *
 * WHAT THIS PAGE HANDS DOWN IS ONLY WHAT A SERVER CAN KNOW: who an enquiry may be handed to, which forms
 * have actually produced one, and who is looking at the screen. The filters, the page size and the rows
 * live on the browser side — every export of a `"use client"` module is a client reference, so a Server
 * Component cannot call one, and parsing the query string here as well would mean two parsers to keep in
 * step (MediaGrid.tsx's header sets out the trap).
 *
 * ⚠ THE ASSIGNABLE ROLES ARE DERIVED FROM THE PREDICATE, never listed by hand. A second rank test that
 * disagrees with the first is how a rule silently stops matching (contract §1.7) — so the roles below are
 * exactly those for which `canManageInquiries` returns true, which is the same function the route handler
 * uses to decide whether an assignment is legal.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Enquiries"
};

/** How many forms the filter offers. There are four in the schema; the cap is protection, not a policy. */
const FORM_KEY_LIMIT = 20;

export default async function StudioInquiriesPage() {
  const user = await requireStudioCapability(
    canManageInquiries,
    "The contact inbox needs editor access or higher. An administrator can raise yours."
  );

  /**
   * Every role that may be handed an enquiry, worked out from the predicate itself.
   *
   * The `id` is a placeholder: `canManageInquiries` is a pure rank test and never reads it. Writing
   * `["EDITOR", "ADMINISTRATOR"]` here instead would be the second rank test lib/permissions.ts exists to
   * prevent — and the day a tier is inserted between them, this list would silently stop matching.
   */
  const assignableRoles = ROLES_DESCENDING.filter((role) => canManageInquiries({ id: "", role }));

  const [assigneeRows, formRows, newCount] = await prisma.$transaction([
    prisma.user.findMany({
      where: { deletedAt: null, isActive: true, role: { in: assignableRoles } },
      select: { id: true, name: true, email: true },
      // A total ordering, so the list never reshuffles between requests and reads as data changing.
      orderBy: [{ name: "asc" }, { email: "asc" }]
    }),
    prisma.contactSubmission.findMany({
      where: { deletedAt: null },
      select: { formKey: true },
      distinct: ["formKey"],
      orderBy: { formKey: "asc" },
      take: FORM_KEY_LIMIT
    }),
    prisma.contactSubmission.count({ where: { deletedAt: null, state: "NEW" } })
  ]);

  /**
   * The contact form can be switched off for the whole site.
   *
   * Worth saying here rather than only on the settings screen: an inbox that has gone quiet looks like a
   * quiet week, and the difference between that and "the form is not on the page any more" is a fortnight
   * of unanswered enquiries nobody sent.
   */
  const features = await getSettingCached("features");

  return (
    <div className="mx-auto w-full max-w-[100rem] space-y-6">
      <StudioPageHeader
        title="Enquiries"
        description="Messages sent through the contact forms on the website. Nothing here is ever deleted automatically, and nothing is deleted in bulk — a lost enquiry is somebody's only attempt to reach the Centre."
        meta={
          <span className="text-xs tabular-nums text-ink-500">
            {newCount === 0
              ? "nothing new"
              : newCount === 1
                ? "1 new"
                : `${newCount} new`}
          </span>
        }
      />

      {!features.contactForm ? (
        <HelpText tone="warn">
          The contact form is switched off, so the website no longer shows a way to send a message and
          nothing new will arrive here. The contact page still shows the address, the email and the
          telephone number. An administrator can turn the form back on in Settings → Features.
        </HelpText>
      ) : null}

      <InquiryInbox
        assignees={assigneeRows}
        formKeys={formRows.map((row) => row.formKey)}
        currentUserId={user.id}
      />
    </div>
  );
}
