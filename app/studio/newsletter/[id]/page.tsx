import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { storageConfigured } from "@/lib/env";
import { newsletterMailerInfo } from "@/lib/newsletter/delivery";
import {
  ISSUE_PREHEADER_MAX,
  ISSUE_STATUS_LABELS,
  ISSUE_SUBJECT_MAX,
  ISSUE_TITLE_MAX,
  countIssueAudience,
  issueDeliveryCounts
} from "@/lib/newsletter/issues";
import { ISSUE_SELECT } from "@/lib/newsletter/issue-studio";
import { canAuthor, canEditRecord, canPublish } from "@/lib/permissions";
import { CENTRE_TIME_ZONE, centreZoneName } from "@/components/site/EventDateBlock";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { IssueEditor } from "./IssueEditor";

/**
 * One newsletter issue. The permission questions are asked here only to decide what to DRAW; every
 * route the editor calls asks them again (lib/newsletter/issue-studio.ts).
 *
 * `notFound()` is called here, so no `loading.tsx` may be added to this segment (the events editor's page
 * explains why).
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Newsletter issue" };

export default async function StudioNewsletterIssuePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireStudioCapability(
    canAuthor,
    "Newsletter issues need author access or higher. An administrator can raise yours."
  );
  const { id } = await params;

  const issue = await prisma.newsletterIssue.findFirst({ where: { id, deletedAt: null }, select: ISSUE_SELECT });
  if (!issue) notFound();

  const [counts, audience] = await Promise.all([issueDeliveryCounts(id), countIssueAudience()]);

  // Built on the server: `Intl`'s zone names depend on the runtime's ICU data and must not differ across
  // hydration (the events editor makes the same argument).
  const now = new Date();
  const zoneShort = centreZoneName(now);
  const timeZoneLabel = `${centreZoneName(now, "long") || CENTRE_TIME_ZONE}${zoneShort ? ` (${zoneShort})` : ""}`;

  return (
    <div className="mx-auto w-full max-w-[72rem] space-y-6">
      <StudioPageHeader
        title={issue.title}
        back={{ href: "/studio/newsletter", label: "Newsletter issues" }}
        breadcrumb={[{ label: "Newsletter issues", href: "/studio/newsletter" }, { label: issue.title }]}
      />
      <IssueEditor
        initial={{
          id: issue.id,
          title: issue.title,
          subject: issue.subject,
          preheader: issue.preheader ?? "",
          body: issue.body,
          status: issue.status,
          scheduledAt: issue.scheduledAt?.toISOString() ?? null,
          sentAt: issue.sentAt?.toISOString() ?? null,
          recipientCount: issue.recipientCount,
          updatedAt: issue.updatedAt.toISOString()
        }}
        initialCounts={counts}
        statusLabels={ISSUE_STATUS_LABELS}
        audience={audience}
        mayEdit={canEditRecord(user, issue.createdById)}
        maySend={canPublish(user)}
        senderConfigured={newsletterMailerInfo().configured}
        storageReady={storageConfigured()}
        userEmail={user.email}
        timeZone={CENTRE_TIME_ZONE}
        timeZoneLabel={timeZoneLabel}
        titleMax={ISSUE_TITLE_MAX}
        subjectMax={ISSUE_SUBJECT_MAX}
        preheaderMax={ISSUE_PREHEADER_MAX}
      />
    </div>
  );
}
