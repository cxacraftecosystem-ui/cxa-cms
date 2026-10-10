import "server-only";

import type { NewsletterIssueStatus, Prisma } from "@prisma/client";

import { conflict, forbidden, notFound } from "@/lib/api";
import type { SessionUser } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canEditRecord, canPublish } from "@/lib/permissions";
import { isEmptyRichText, parseRichText } from "@/lib/richtext";
import { fieldProblem, optionalText, requiredText } from "@/lib/studio/crud";
import { z } from "@/lib/zod";
import { richTextLinksAreSafe, UNSAFE_RICH_TEXT_LINK_MESSAGE } from "@/lib/safe-href";
import {
  EDITABLE_ISSUE_STATUSES,
  ISSUE_PREHEADER_MAX,
  ISSUE_SUBJECT_MAX,
  ISSUE_TITLE_MAX
} from "@/lib/newsletter/issues";

/**
 * The studio's side of newsletter issues: the shape the screens read, the body they write, and the two
 * permission questions every issue route asks.
 *
 * ══ WHO MAY DO WHAT — THE NEWSROOM'S RULES, BECAUSE AN ISSUE IS AN ARTICLE THAT GOES TO INBOXES ══
 *
 *   • **Write a draft, and send a test of it to yourself:** an author, for their own issue; an editor for
 *     anybody's (`canEditRecord`, exactly as a news article).
 *   • **Send it to every subscriber, schedule it, or cancel a send:** whoever may publish (`canPublish` —
 *     an editor, or anybody granted publishing). Sending a newsletter IS publishing, to a list of people
 *     who cannot un-receive it, so it takes the publishing permission and nothing less.
 *
 * Both are asked of the SERVER by every route; the screen asks the same predicates only to decide what
 * to draw (contract §1.7).
 */

export const ISSUE_SELECT = {
  id: true,
  title: true,
  subject: true,
  preheader: true,
  body: true,
  status: true,
  scheduledAt: true,
  sendStartedAt: true,
  sentAt: true,
  cancelledAt: true,
  recipientCount: true,
  sentCount: true,
  failedCount: true,
  suppressedCount: true,
  createdById: true,
  sentById: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.NewsletterIssueSelect;

export type IssueRow = Prisma.NewsletterIssueGetPayload<{ select: typeof ISSUE_SELECT }>;

export const IssueCreateBody = z.object({
  title: requiredText(ISSUE_TITLE_MAX, "Give the issue a title. It is the heading readers see at the top."),
  subject: optionalText(ISSUE_SUBJECT_MAX),
  preheader: optionalText(ISSUE_PREHEADER_MAX),
  body: z.unknown().refine(richTextLinksAreSafe, { message: UNSAFE_RICH_TEXT_LINK_MESSAGE }).optional()
});

export const IssuePatchBody = z.object({
  title: requiredText(ISSUE_TITLE_MAX, "Give the issue a title. It is the heading readers see at the top.").optional(),
  subject: requiredText(ISSUE_SUBJECT_MAX, "Give the issue a subject line. It is what readers see in their inbox.").optional(),
  // Not `optionalText(...)`: its `.default(null)` would turn an ABSENT key into "clear the preheader".
  preheader: z
    .union([z.string().trim().max(ISSUE_PREHEADER_MAX, `Keep this to ${ISSUE_PREHEADER_MAX} characters or fewer.`), z.null()])
    .optional(),
  body: z.unknown().refine(richTextLinksAreSafe, { message: UNSAFE_RICH_TEXT_LINK_MESSAGE }).optional(),
  /** The `updatedAt` the editor loaded, so two people saving the same draft cannot silently overwrite. */
  expectedUpdatedAt: z.string().trim().optional()
});

/** A body value as it should be stored: a parsed document, or null for an empty one. */
export function storedBody(value: unknown): Prisma.InputJsonValue | null {
  const doc = parseRichText(value ?? null);
  if (!doc || isEmptyRichText(doc)) return null;
  return doc as unknown as Prisma.InputJsonValue;
}

export async function loadIssue(id: string): Promise<IssueRow> {
  const issue = await prisma.newsletterIssue.findFirst({ where: { id, deletedAt: null }, select: ISSUE_SELECT });
  if (!issue) throw notFound("That newsletter issue");
  return issue;
}

/** The author of the issue, or an editor. Throws the house 403 otherwise. */
export function assertMayEdit(user: SessionUser, issue: { createdById: string | null }): void {
  if (!canEditRecord(user, issue.createdById)) {
    throw forbidden("Only the issue's author or an editor can change it.");
  }
}

export function assertMaySend(user: SessionUser): void {
  if (!canPublish(user)) {
    throw forbidden("Sending a newsletter to subscribers needs publishing access. An editor can send it for you.");
  }
}

export function assertEditable(status: NewsletterIssueStatus): void {
  if (!EDITABLE_ISSUE_STATUSES.includes(status)) {
    throw conflict("This issue has already been sent or cancelled, so its words are fixed as they went out.");
  }
}

/** An issue must have something to say before it can be sent anywhere, including to a test inbox. */
export function assertSendable(issue: { subject: string; body: Prisma.JsonValue | null }): void {
  if (issue.subject.trim().length === 0) {
    throw fieldProblem("subject", "Give the issue a subject line before sending it.");
  }
  const doc = parseRichText(issue.body);
  if (!doc || isEmptyRichText(doc)) {
    throw fieldProblem("body", "The issue has no body yet. Write something before sending it.");
  }
}
