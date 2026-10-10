import { hasDatabase } from "../newsletter/setup";

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { recordEvent } from "@/lib/audit";
import { SCHEDULED_JOB_LABEL, auditActorLabel, isScheduledJobRow } from "@/lib/audit-actor";
import { prisma } from "@/lib/db";
import { recordProvenance } from "@/lib/provenance";
import { recentActivityWhere, scheduledProblemWhere } from "@/lib/studio/recent-activity";

/**
 * Scheduled-job rows against a real PostgreSQL, written through the REAL writer in the shapes the
 * cron routes and the public routes pass — so the naming rule is tested on what is actually stored,
 * not on a hand-built row that might carry a column the writer never sets.
 *
 * ⚠ THESE TESTS WRITE audit_logs ROWS (and remove only their own), so they refuse to run against
 * anything but a database on this machine — the same rule as tests/security/audit-provenance.db.test.ts.
 */

const LOCAL = /@(127\.0\.0\.1|localhost|\[::1\]|postgres)(:\d+)?\//.test(process.env.DATABASE_URL ?? "");
const skip = !hasDatabase ? "no DATABASE_URL" : !LOCAL ? "DATABASE_URL is not a local database" : false;

const RUN = `sysrows-${Date.now()}`;
const mine = { entityId: { startsWith: RUN } };

describe("scheduled-job rows as the writers store them", { skip }, () => {
  before(async () => {
    // app/api/cron/logs-archive/route.ts — a refusal, a gap and a routine day.
    await recordEvent(
      { actor: null },
      { action: "ARCHIVE", entityType: "LogArchiveRun", entityId: `${RUN}:run`, entityLabel: "logs-archive archived nothing — destination_not_private" }
    );
    await recordEvent(
      { actor: null },
      { action: "ARCHIVE", entityType: "LogArchiveGap", entityId: `${RUN}:gap`, entityLabel: "audit_logs — 2026-04-12 left the archive scan window unarchived" }
    );
    await recordEvent(
      { actor: null },
      { action: "ARCHIVE", entityType: "LogArchive", entityId: `${RUN}:day`, entityLabel: "audit_logs — 2026-10-09" }
    );
    // app/api/cron/publish/route.ts
    await recordEvent(
      { actor: null },
      { action: "PUBLISH", entityType: "Post", entityId: `${RUN}:post`, entityLabel: "Monsoon looms", after: { status: "PUBLISHED", by: "scheduler" } }
    );
    // app/api/public/contact/route.ts — anonymous, but a person, with the client IP.
    await recordEvent(
      { actor: null, ipAddress: "203.0.113.9", userAgent: "test" },
      { action: "CREATE", entityType: "ContactSubmission", entityId: `${RUN}:enquiry`, entityLabel: "Enquiry from a@b.example" }
    );
  });

  after(async () => {
    await prisma.auditLog.deleteMany({ where: mine });
  });

  it("names the cron rows 'Scheduled job' and leaves the public row alone", async () => {
    const rows = await prisma.auditLog.findMany({ where: mine, include: { actor: { select: { name: true, email: true } } } });
    const byId = new Map(rows.map((row) => [row.entityId, row]));
    for (const suffix of ["run", "gap", "day", "post"]) {
      const row = byId.get(`${RUN}:${suffix}`);
      assert.ok(row, suffix);
      assert.equal(isScheduledJobRow(row), true, suffix);
      assert.equal(auditActorLabel(row), SCHEDULED_JOB_LABEL, suffix);
    }
    const enquiry = byId.get(`${RUN}:enquiry`);
    assert.ok(enquiry);
    assert.equal(isScheduledJobRow(enquiry), false);
  });

  it("the dashboard's queries split them: no log-archive rows in the panel, only its problems in the block", async () => {
    const panel = await prisma.auditLog.findMany({ where: { AND: [mine, recentActivityWhere()] } });
    assert.deepEqual(new Set(panel.map((row) => row.entityId)), new Set([`${RUN}:post`, `${RUN}:enquiry`]));

    const problems = await prisma.auditLog.findMany({
      where: { AND: [mine, scheduledProblemWhere(new Date(Date.now() - 60 * 60 * 1000))] }
    });
    assert.deepEqual(new Set(problems.map((row) => row.entityId)), new Set([`${RUN}:run`, `${RUN}:gap`]));

    const none = await prisma.auditLog.count({ where: { AND: [mine, scheduledProblemWhere(new Date(Date.now() + 60 * 1000))] } });
    assert.equal(none, 0, "the window is honoured");
  });

  it("the provenance timeline says the scheduler published it, not a removed account", async () => {
    const record = await recordProvenance("Post", `${RUN}:post`);
    const [event] = record.timeline.items;
    assert.equal(event?.action, "PUBLISH");
    assert.equal(event?.actor.systemLabel, SCHEDULED_JOB_LABEL);
    assert.equal(event?.actor.email, null);
  });
});
