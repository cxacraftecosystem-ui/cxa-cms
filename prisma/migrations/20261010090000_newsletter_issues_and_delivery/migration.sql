-- Newsletter issues, and the columns the outbox needs to be drained by a scheduled job.
--
-- PURELY ADDITIVE. One new enum, five new enum values, one new table, nullable/defaulted columns on the two
-- newsletter tables, and indexes. Nothing existing is renamed, dropped or rewritten, so it applies to a
-- populated database with no backfill and no downtime, and merges cleanly beside unrelated schema work.
--
-- ⚠ `ALTER TYPE ... ADD VALUE` may run inside the migration's transaction on PostgreSQL 12+, but a value
-- added that way cannot be USED until the transaction commits. Nothing below uses the new values (the
-- column defaults are the existing 'RECORDED' and 'DRAFT'), which is what keeps this one migration.
--
-- ⚠ `prisma migrate diff` also proposes dropping "search_documents_title_trgm_idx". That index is created by
-- hand in 20260814120000_restore_search_title_trgm_index and is invisible to the schema file by design; the
-- drop is deliberately NOT carried here.

-- CreateEnum
CREATE TYPE "NewsletterIssueStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'CANCELLED');

-- AlterEnum
ALTER TYPE "NewsletterMailKind" ADD VALUE 'ISSUE';
ALTER TYPE "NewsletterMailKind" ADD VALUE 'ISSUE_TEST';

-- AlterEnum
ALTER TYPE "NewsletterMailState" ADD VALUE 'SENDING';
ALTER TYPE "NewsletterMailState" ADD VALUE 'SUPPRESSED';
ALTER TYPE "NewsletterMailState" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "newsletter_deliveries" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "claimToken" TEXT,
ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "issueId" TEXT,
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "providerMessageId" TEXT;

-- AlterTable
ALTER TABLE "newsletter_subscribers" ADD COLUMN     "bouncedAt" TIMESTAMP(3),
ADD COLUMN     "complainedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "newsletter_issues" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "preheader" TEXT,
    "body" JSONB,
    "status" "NewsletterIssueStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "sendStartedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "suppressedCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "updatedById" TEXT,
    "sentById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "newsletter_issues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "newsletter_issues_status_scheduledAt_idx" ON "newsletter_issues"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "newsletter_issues_deletedAt_idx" ON "newsletter_issues"("deletedAt");

-- CreateIndex
CREATE INDEX "newsletter_deliveries_issueId_state_idx" ON "newsletter_deliveries"("issueId", "state");

-- CreateIndex
CREATE INDEX "newsletter_deliveries_state_nextAttemptAt_idx" ON "newsletter_deliveries"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "newsletter_deliveries_providerMessageId_idx" ON "newsletter_deliveries"("providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "newsletter_deliveries_issueId_subscriberId_key" ON "newsletter_deliveries"("issueId", "subscriberId");

-- AddForeignKey
ALTER TABLE "newsletter_deliveries" ADD CONSTRAINT "newsletter_deliveries_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "newsletter_issues"("id") ON DELETE SET NULL ON UPDATE CASCADE;
