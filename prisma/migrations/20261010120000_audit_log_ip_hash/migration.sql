-- The audit log stops storing raw network addresses and email addresses (docs/AUDIT-PRIVACY.md).
--
-- PURELY ADDITIVE. One nullable column and one index. Nothing is dropped, renamed or rewritten:
--
--   • "ipHash" is where lib/audit.ts now writes a keyed HMAC of the address instead of the address.
--   • "actorEmail" and "ipAddress" were already nullable and STAY; the application simply stops
--     writing them. Old rows keep their values, because destroying production evidence is not
--     something a deploy should do on its own. Clearing them is a deliberate, separate, manual step —
--     prisma/manual/audit_log_scrub_legacy_pii.sql, which is NOT a migration and never runs by itself.
--
-- No backfill of "ipHash" for old rows: the hash needs AUDIT_IP_HASH_SECRET, which the database does
-- not have and must never be given.

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN "ipHash" TEXT;

-- CreateIndex
CREATE INDEX "audit_logs_ipHash_createdAt_idx" ON "audit_logs"("ipHash", "createdAt");
