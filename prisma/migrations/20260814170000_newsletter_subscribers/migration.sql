-- The newsletter: subscribers and the delivery outbox.
--
-- Written to match what `prisma migrate diff` produces for the models added to schema.prisma in the
-- same change, so a later `prisma migrate dev` finds nothing left to do. Two tables, three enums, no
-- alteration to anything that already exists — this migration is purely additive and is therefore
-- safe to apply to a populated database with no downtime and no backfill.
--
-- The unique index is on "emailKey" and NOT on "email": "email" keeps the capitals the person typed,
-- and uniqueness is decided on the normalised form. See lib/newsletter/address.ts.

-- CreateEnum
CREATE TYPE "SubscriberStatus" AS ENUM ('PENDING', 'CONFIRMED', 'UNSUBSCRIBED');

-- CreateEnum
CREATE TYPE "NewsletterMailKind" AS ENUM ('CONFIRMATION', 'ALREADY_SUBSCRIBED', 'WELCOME', 'UNSUBSCRIBE_RECEIPT');

-- CreateEnum
CREATE TYPE "NewsletterMailState" AS ENUM ('RECORDED', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "newsletter_subscribers" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailKey" TEXT NOT NULL,
    "status" "SubscriberStatus" NOT NULL DEFAULT 'PENDING',
    "confirmationToken" TEXT,
    "confirmationExpiresAt" TIMESTAMP(3),
    "confirmationSentAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "unsubscribedAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'newsletter-page',
    "sourcePath" TEXT,
    "consentText" TEXT NOT NULL,
    "consentVersion" TEXT NOT NULL,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "newsletter_subscribers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "newsletter_deliveries" (
    "id" TEXT NOT NULL,
    "subscriberId" TEXT,
    "emailKey" TEXT NOT NULL,
    "kind" "NewsletterMailKind" NOT NULL,
    "state" "NewsletterMailState" NOT NULL DEFAULT 'RECORDED',
    "subject" TEXT NOT NULL,
    "provider" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "newsletter_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "newsletter_subscribers_emailKey_key" ON "newsletter_subscribers"("emailKey");

-- CreateIndex
CREATE INDEX "newsletter_subscribers_status_createdAt_idx" ON "newsletter_subscribers"("status", "createdAt");

-- CreateIndex
CREATE INDEX "newsletter_subscribers_deletedAt_idx" ON "newsletter_subscribers"("deletedAt");

-- CreateIndex
CREATE INDEX "newsletter_subscribers_source_idx" ON "newsletter_subscribers"("source");

-- CreateIndex
CREATE INDEX "newsletter_deliveries_state_createdAt_idx" ON "newsletter_deliveries"("state", "createdAt");

-- CreateIndex
CREATE INDEX "newsletter_deliveries_emailKey_idx" ON "newsletter_deliveries"("emailKey");

-- CreateIndex
CREATE INDEX "newsletter_deliveries_subscriberId_idx" ON "newsletter_deliveries"("subscriberId");

-- AddForeignKey
ALTER TABLE "newsletter_deliveries" ADD CONSTRAINT "newsletter_deliveries_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "newsletter_subscribers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
