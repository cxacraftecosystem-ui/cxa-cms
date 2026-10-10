import type { Metadata } from "next";
import Link from "next/link";
import { MailWarning, Send } from "lucide-react";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { newsletterMailerInfo } from "@/lib/newsletter/delivery";
import { ISSUE_STATUS_LABELS, ISSUE_STATUS_TONES, countIssueAudience } from "@/lib/newsletter/issues";
import { ISSUE_SELECT } from "@/lib/newsletter/issue-studio";
import { canAuthor, canManageInquiries } from "@/lib/permissions";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { CENTRE_TIME_ZONE } from "@/components/site/EventDateBlock";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { NewIssueButton } from "./NewIssueButton";

/**
 * Newsletter issues — every issue, where each one stands, and how many copies reached people.
 *
 * Author access and up, like the newsroom. The figures on each row are the snapshot the drain keeps on the
 * issue (lib/newsletter/issues.ts `refreshIssue`); the issue's own screen counts the outbox live.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Newsletter issues" };

const LIST_LIMIT = 100;

export default async function StudioNewsletterPage() {
  const user = await requireStudioCapability(
    canAuthor,
    "Newsletter issues need author access or higher. An administrator can raise yours."
  );

  const [issues, total, audience] = await Promise.all([
    prisma.newsletterIssue.findMany({
      where: { deletedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: LIST_LIMIT,
      select: ISSUE_SELECT
    }),
    prisma.newsletterIssue.count({ where: { deletedAt: null } }),
    countIssueAudience()
  ]);

  const mailer = newsletterMailerInfo();
  const formatter = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: CENTRE_TIME_ZONE
  });

  return (
    <div className="mx-auto w-full max-w-[84rem] space-y-6">
      <StudioPageHeader
        title="Newsletter issues"
        description={`Write an issue, send yourself a test, then send it to everybody who has confirmed their subscription — ${audience === 1 ? "1 person" : `${audience} people`} at the moment.`}
        meta={<span className="text-xs tabular-nums text-ink-500">{total === 1 ? "1 issue" : `${total} issues`}</span>}
        actions={<NewIssueButton />}
      />

      {!mailer.configured ? (
        <HelpText tone="warn" icon={MailWarning}>
          The email sender is not configured, so nothing can go out yet. Issues can still be written and
          scheduled; anything sent waits in the queue and goes out as soon as the sender is configured.
        </HelpText>
      ) : null}

      <FormSection title="Issues" description="Newest first. Open one to edit it, preview it or send it.">
        {issues.length === 0 ? (
          <EmptyState
            icon={Send}
            headingLevel={3}
            title="No issues yet"
            description="“New issue” starts a draft. Nothing is sent until somebody with publishing access presses Send and confirms."
          />
        ) : (
          <ul className="space-y-2">
            {issues.map((issue) => (
              <li key={issue.id} className="rounded-md border border-line-200 bg-surface-50 p-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
                  <Badge tone={ISSUE_STATUS_TONES[issue.status]} size="sm">
                    {ISSUE_STATUS_LABELS[issue.status]}
                  </Badge>
                  <Link
                    href={`/studio/newsletter/${issue.id}`}
                    className="font-medium text-ink-900 underline decoration-purple-300 underline-offset-2 hover:decoration-purple-700"
                  >
                    {issue.title}
                  </Link>
                  <span className="ml-auto shrink-0 text-xs tabular-nums text-ink-500">
                    {issue.status === "SENT" && issue.sentAt
                      ? `sent ${formatter.format(issue.sentAt)}`
                      : issue.status === "SCHEDULED" && issue.scheduledAt
                        ? `scheduled for ${formatter.format(issue.scheduledAt)}`
                        : issue.status === "CANCELLED" && issue.cancelledAt
                          ? `cancelled ${formatter.format(issue.cancelledAt)}`
                          : `last changed ${formatter.format(issue.updatedAt)}`}
                  </span>
                </div>
                <p className="mt-1 text-xs text-ink-500">Subject: {issue.subject}</p>
                {issue.status === "SENDING" || issue.status === "SENT" || issue.status === "CANCELLED" ? (
                  <p className="mt-1.5 text-xs tabular-nums text-ink-700">
                    {issue.recipientCount} recipients · {issue.sentCount} sent · {issue.failedCount} not
                    delivered · {issue.suppressedCount} not sent because the address had stopped
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {total > issues.length ? (
          <HelpText>
            Showing the {issues.length} most recent of {total} issues.
          </HelpText>
        ) : null}
      </FormSection>

      {canManageInquiries(user) ? (
        <HelpText>
          Who is on the list, and every message sent to each address, is on the{" "}
          <Link href="/studio/subscribers" className="underline decoration-purple-300 underline-offset-2 hover:decoration-purple-700">
            newsletter subscribers
          </Link>{" "}
          screen.
        </HelpText>
      ) : null}
    </div>
  );
}
