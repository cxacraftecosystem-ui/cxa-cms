-- A master administrator can now delete an account for good (lib/users/erase-account.ts).
--
-- PURELY ADDITIVE. One nullable column. The account row is NOT removed: every table that points at
-- `users` (posts, revisions, media, files, announcements, enquiries, audit logs, the access list) keeps
-- its foreign key, and the row becomes a TOMBSTONE — name "Deleted admin", an `@erased.invalid`
-- address, no password, no second factor, no linked sign-ins, no sessions. Authored content therefore
-- stays attributed to one stable placeholder rather than to nobody, which a hard delete
-- (`ON DELETE SET NULL`) would have done. "erasedAt" is what tells a tombstone apart from an ordinary
-- soft-deleted account, which can still be restored; a tombstone cannot.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "erasedAt" TIMESTAMP(3);
