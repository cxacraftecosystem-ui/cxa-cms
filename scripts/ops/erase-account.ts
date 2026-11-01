/**
 * Delete one account permanently, from an operator's seat, through the studio's own code path.
 *
 *     npx tsx scripts/ops/erase-account.ts --mode check --email <target> --actor <master admin>
 *     npx tsx scripts/ops/erase-account.ts --mode erase --email <target> --actor <master admin> --via "<why/where>"
 *
 * Run by .github/workflows/ops-erase-account.yml against production (DATABASE_URL is a repository
 * secret); it can be pointed at any database the same way.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `check` IS READ-ONLY AND PRINTS COUNTS ONLY. Every query runs inside `SET TRANSACTION READ ONLY`, and
 * nothing personal is printed: whether the account exists, its role and state, how many rows point at it,
 * and how many rows anywhere else carry the address. The address itself is printed only as it was given.
 *
 * `erase` STOPS, WITHOUT WRITING ANYTHING, when the target is a master administrator or the only active
 * administrator of any tier, when the actor is not an active master administrator, or when a backup
 * table of the same name already exists. Otherwise it:
 *   1. copies every affected row into `_bak_<yyyymmdd>_erase_<table>` tables (same database; Supabase
 *      enables RLS on new tables and the Data API is closed, so they are not readable from outside);
 *   2. calls `eraseAccount()` from lib/auth/erase-account.ts — the same function, guards and audit row
 *      as the studio's "Delete permanently", with `via` recorded in the audit row;
 *   3. removes the address from the newsletter (subscriber and its delivery rows), audited.
 * Event registrations, enquiries and people-directory entries are reported, never touched: they are
 * records the person made as a member of the public, not parts of the account.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
import { existsSync } from "node:fs";

import { Prisma } from "@prisma/client";

import { writeAudit, type AuditContext } from "@/lib/audit";
import { domainKeyOf, normaliseEmail } from "@/lib/auth/access";
import { eraseAccount } from "@/lib/auth/erase-account";
import { prisma } from "@/lib/db";
import { normaliseEmail as newsletterKey } from "@/lib/newsletter/address";

if (existsSync(".env")) process.loadEnvFile(".env");

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const mode = arg("mode");
const rawEmail = arg("email");
const rawActor = arg("actor");
const via = arg("via") ?? "scripts/ops/erase-account.ts";

if ((mode !== "check" && mode !== "erase") || !rawEmail || !rawActor) {
  console.error("usage: erase-account.ts --mode check|erase --email <target> --actor <master admin email> [--via <text>]");
  process.exit(2);
}

const email = normaliseEmail(rawEmail);
const actorEmail = normaliseEmail(rawActor);
const subscriberKey = newsletterKey(rawEmail);
const domainKey = domainKeyOf(email);
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");

interface Census {
  target: { id: string; role: string; isActive: boolean; deleted: boolean; erased: boolean } | null;
  references: Record<string, number>;
  activeMasterAdmins: number;
  activeAdministrators: number;
  actorIsActiveMasterAdmin: boolean;
  accessEntries: { kind: string; grantedRole: string; revoked: boolean }[];
  domainEntryCovers: string | null;
  elsewhere: Record<string, number>;
}

async function count(tx: Prisma.TransactionClient, query: Prisma.Sql): Promise<number> {
  const rows = await tx.$queryRaw<{ n: bigint }[]>(query);
  return Number(rows[0]?.n ?? 0);
}

async function census(): Promise<Census> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");

    const user = await tx.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true, role: true, isActive: true, deletedAt: true, erasedAt: true }
    });

    const references: Record<string, number> = {};
    if (user) {
      const id = user.id;
      references.sessions = await count(tx, Prisma.sql`SELECT count(*) AS n FROM "sessions" WHERE "userId" = ${id}`);
      references.liveSessions = await count(
        tx,
        Prisma.sql`SELECT count(*) AS n FROM "sessions" WHERE "userId" = ${id} AND "revokedAt" IS NULL AND "expiresAt" > now()`
      );
      references.oauthAccounts = await count(tx, Prisma.sql`SELECT count(*) AS n FROM "oauth_accounts" WHERE "userId" = ${id}`);
      references.contentLocks = await count(tx, Prisma.sql`SELECT count(*) AS n FROM "content_locks" WHERE "userId" = ${id}`);
      references.postsAuthored = await count(tx, Prisma.sql`SELECT count(*) AS n FROM "posts" WHERE "authorId" = ${id}`);
      references.revisionsAuthored = await count(tx, Prisma.sql`SELECT count(*) AS n FROM "revisions" WHERE "authorId" = ${id}`);
      references.mediaUploaded = await count(tx, Prisma.sql`SELECT count(*) AS n FROM "media_assets" WHERE "uploaderId" = ${id}`);
      references.filesUploaded = await count(tx, Prisma.sql`SELECT count(*) AS n FROM "file_assets" WHERE "uploaderId" = ${id}`);
      references.announcements = await count(tx, Prisma.sql`SELECT count(*) AS n FROM "announcements" WHERE "createdById" = ${id}`);
      references.inquiriesAssigned = await count(tx, Prisma.sql`SELECT count(*) AS n FROM "contact_submissions" WHERE "assigneeId" = ${id}`);
      references.auditRowsAsActor = await count(tx, Prisma.sql`SELECT count(*) AS n FROM "audit_logs" WHERE "actorId" = ${id}`);
      references.auditRowsAboutAccount = await count(tx, Prisma.sql`SELECT count(*) AS n FROM "audit_logs" WHERE "entityId" = ${id}`);
      references.accessEntriesAddedOrRevoked = await count(
        tx,
        Prisma.sql`SELECT count(*) AS n FROM "studio_access" WHERE "addedById" = ${id} OR "revokedById" = ${id}`
      );
      references.hasAvatar = (await tx.user.count({ where: { id, avatarId: { not: null } } })) as number;
    }

    const activeMasterAdmins = await tx.user.count({ where: { role: "MASTER_ADMIN", isActive: true, deletedAt: null } });
    const activeAdministrators = await tx.user.count({ where: { role: "ADMINISTRATOR", isActive: true, deletedAt: null } });
    const actorIsActiveMasterAdmin =
      (await tx.user.count({
        where: { email: { equals: actorEmail, mode: "insensitive" }, role: "MASTER_ADMIN", isActive: true, deletedAt: null, erasedAt: null }
      })) === 1;

    const accessEntries = (
      await tx.studioAccess.findMany({ where: { email }, select: { kind: true, grantedRole: true, revokedAt: true } })
    ).map((row) => ({ kind: row.kind, grantedRole: row.grantedRole, revoked: row.revokedAt !== null }));
    const domainEntry = domainKey
      ? await tx.studioAccess.findFirst({ where: { email: domainKey, kind: "DOMAIN", revokedAt: null }, select: { email: true } })
      : null;

    const like = `%${email}%`;
    const elsewhere: Record<string, number> = {
      newsletterSubscribers: subscriberKey
        ? await count(tx, Prisma.sql`SELECT count(*) AS n FROM "newsletter_subscribers" WHERE "emailKey" = ${subscriberKey}`)
        : 0,
      newsletterDeliveries: subscriberKey
        ? await count(tx, Prisma.sql`SELECT count(*) AS n FROM "newsletter_deliveries" WHERE "emailKey" = ${subscriberKey}`)
        : 0,
      oauthAccountsByAddress: await count(tx, Prisma.sql`SELECT count(*) AS n FROM "oauth_accounts" WHERE lower("email") = ${email}`),
      eventRegistrations: await count(tx, Prisma.sql`SELECT count(*) AS n FROM "event_registrations" WHERE lower("email") = ${email}`),
      contactSubmissions: await count(tx, Prisma.sql`SELECT count(*) AS n FROM "contact_submissions" WHERE lower("email") = ${email}`),
      peopleDirectory: await count(tx, Prisma.sql`SELECT count(*) AS n FROM "people" WHERE lower("email") = ${email}`),
      settingsMentioning: await count(tx, Prisma.sql`SELECT count(*) AS n FROM "settings" WHERE "value"::text ILIKE ${like}`),
      auditRowsWithActorEmail: await count(tx, Prisma.sql`SELECT count(*) AS n FROM "audit_logs" WHERE lower("actorEmail") = ${email}`),
      auditRowsMentioning: await count(
        tx,
        Prisma.sql`SELECT count(*) AS n FROM "audit_logs" WHERE "entityLabel" ILIKE ${like} OR "before"::text ILIKE ${like} OR "after"::text ILIKE ${like}`
      ),
      accessLogRowsWithActorEmail: await count(tx, Prisma.sql`SELECT count(*) AS n FROM "access_logs" WHERE lower("actorEmail") = ${email}`)
    };

    return {
      target: user
        ? { id: user.id, role: user.role, isActive: user.isActive, deleted: user.deletedAt !== null, erased: user.erasedAt !== null }
        : null,
      references,
      activeMasterAdmins,
      activeAdministrators,
      actorIsActiveMasterAdmin,
      accessEntries,
      domainEntryCovers: domainEntry?.email ?? null,
      elsewhere
    };
  });
}

function report(label: string, value: Census) {
  const { target, ...rest } = value;
  console.log(`\n── ${label} ──`);
  console.log(JSON.stringify({ accountExists: target !== null, ...(target ? { role: target.role, isActive: target.isActive, softDeleted: target.deleted, erased: target.erased } : {}), ...rest }, null, 2));
}

/** Why `erase` must not proceed, or null. */
function stopReason(value: Census): string | null {
  if (!value.target) return "the account does not exist";
  if (value.target.erased) return "the account has already been erased";
  if (value.target.role === "MASTER_ADMIN") return "the account is a master administrator";
  const countedAdmin = value.target.isActive && !value.target.deleted && value.target.role === "ADMINISTRATOR";
  if (countedAdmin && value.activeAdministrators + value.activeMasterAdmins <= 1) return "the account is the only active administrator";
  if (countedAdmin && value.activeAdministrators <= 1) return "the account is the only active administrator (role ADMINISTRATOR)";
  if (!value.actorIsActiveMasterAdmin) return "the actor is not an active master administrator";
  return null;
}

async function backup(targetId: string) {
  const table = (name: string) => Prisma.raw(`"_bak_${stamp}_erase_${name}"`);
  const statements: [string, Prisma.Sql][] = [
    ["users", Prisma.sql`CREATE TABLE ${table("users")} AS SELECT * FROM "users" WHERE "id" = ${targetId}`],
    ["sessions", Prisma.sql`CREATE TABLE ${table("sessions")} AS SELECT * FROM "sessions" WHERE "userId" = ${targetId}`],
    ["oauth_accounts", Prisma.sql`CREATE TABLE ${table("oauth_accounts")} AS SELECT * FROM "oauth_accounts" WHERE "userId" = ${targetId}`],
    ["content_locks", Prisma.sql`CREATE TABLE ${table("content_locks")} AS SELECT * FROM "content_locks" WHERE "userId" = ${targetId}`],
    ["studio_access", Prisma.sql`CREATE TABLE ${table("studio_access")} AS SELECT * FROM "studio_access" WHERE "email" = ${email}`],
    [
      "newsletter_subscribers",
      Prisma.sql`CREATE TABLE ${table("newsletter_subscribers")} AS SELECT * FROM "newsletter_subscribers" WHERE "emailKey" = ${subscriberKey ?? ""}`
    ],
    [
      "newsletter_deliveries",
      Prisma.sql`CREATE TABLE ${table("newsletter_deliveries")} AS SELECT * FROM "newsletter_deliveries" WHERE "emailKey" = ${subscriberKey ?? ""}`
    ]
  ];
  // One transaction: either every backup table exists, or none does.
  await prisma.$transaction(async (tx) => {
    for (const [, statement] of statements) await tx.$executeRaw(statement);
  });
  const sizes: Record<string, number> = {};
  for (const [name] of statements) {
    sizes[`_bak_${stamp}_erase_${name}`] = await count(prisma as never, Prisma.sql`SELECT count(*) AS n FROM ${table(name)}`);
  }
  return sizes;
}

async function main() {
  const before = await census();
  report("check (read-only)", before);
  if (mode === "check") return;

  const reason = stopReason(before);
  if (reason || !before.target) {
    console.log(`\nSTOP: ${reason ?? "the account does not exist"}. Nothing has been written.`);
    process.exitCode = 3;
    return;
  }
  const targetId = before.target.id;

  const sizes = await backup(targetId);
  console.log("\n── backup ──");
  console.log(JSON.stringify(sizes, null, 2));

  const actor = await prisma.user.findFirstOrThrow({
    where: { email: { equals: actorEmail, mode: "insensitive" }, role: "MASTER_ADMIN", isActive: true, deletedAt: null, erasedAt: null },
    select: { id: true, email: true, role: true, canPublish: true, canManageMedia: true }
  });
  const context: AuditContext = { actor: { id: actor.id, email: actor.email }, ipAddress: null, userAgent: via.slice(0, 512) };

  const result = await eraseAccount({ context, actor, targetId, confirmEmail: email, via });
  console.log("\n── erase ──");
  console.log(JSON.stringify(result, null, 2));

  if (subscriberKey && (before.elsewhere.newsletterSubscribers ?? 0) + (before.elsewhere.newsletterDeliveries ?? 0) > 0) {
    const removed = await prisma.$transaction(async (tx) => {
      const deliveries = await tx.newsletterDelivery.deleteMany({ where: { emailKey: subscriberKey } });
      const subscribers = await tx.newsletterSubscriber.deleteMany({ where: { emailKey: subscriberKey } });
      await writeAudit(tx, context, {
        action: "DELETE",
        entityType: "NewsletterSubscriber",
        entityLabel: email,
        before: { emailKey: subscriberKey },
        after: { subscribersRemoved: subscribers.count, deliveriesRemoved: deliveries.count, via }
      });
      return { subscribers: subscribers.count, deliveries: deliveries.count };
    });
    console.log("\n── newsletter ──");
    console.log(JSON.stringify(removed, null, 2));
  }

  const auditRow = await prisma.auditLog.findFirst({
    where: { entityType: "User", entityId: targetId, action: "DELETE" },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true, actorId: true }
  });
  console.log("\n── audit row ──");
  console.log(JSON.stringify({ id: auditRow?.id, createdAt: auditRow?.createdAt, actorIsTheGivenMasterAdmin: auditRow?.actorId === actor.id }, null, 2));

  report("after", await census());
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
