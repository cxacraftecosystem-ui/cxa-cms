import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DELETED_ACTOR_LABEL,
  SCHEDULED_JOB_LABEL,
  auditActorLabel,
  auditActorName,
  isScheduledJobRow
} from "@/lib/audit-actor";
import {
  collapseScheduledRows,
  collapsedCount,
  isRoutineScheduledRow,
  isScheduledProblem,
  recentActivityWhere,
  scheduledProblemWhere,
  summariseRecentActivity,
  type ActivityRow
} from "@/lib/studio/recent-activity";

/**
 * Audit rows nobody wrote. The cron routes record with `{ actor: null }` and no request, and the
 * dashboard used to call every one of them "Somebody" — eight nights of the log archive refusing to
 * write filled the whole Recent activity panel. These pin the naming rule (lib/audit-actor.ts
 * `isScheduledJobRow`) and the panel's filtering and collapsing (lib/studio/recent-activity.ts).
 */

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-10T12:00:00Z");
let sequence = 0;

/** A row as the dashboard selects it. Defaults to a cron row: no actor, no address, no IP. */
function row(overrides: Partial<ActivityRow> & { hoursAgo?: number } = {}): ActivityRow & { id: string } {
  const { hoursAgo = 0, ...rest } = overrides;
  sequence += 1;
  return {
    id: `row-${sequence}`,
    action: "ARCHIVE",
    entityType: "LogArchiveRun",
    entityId: "logs-archive:destination_not_private",
    entityLabel: "logs-archive archived nothing — destination_not_private",
    actorId: null,
    actor: null,
    actorEmail: null,
    ipAddress: null,
    ipHash: null,
    createdAt: new Date(NOW - hoursAgo * HOUR),
    ...rest
  };
}

/** A studio edit by a signed-in person. */
function human(hoursAgo: number, label = "About us"): ActivityRow & { id: string } {
  return row({
    hoursAgo,
    action: "UPDATE",
    entityType: "Page",
    entityId: `page-${label}`,
    entityLabel: label,
    actorId: "user-asha",
    actor: { name: "Asha Rao", email: "asha@cxa.example.org" },
    actorEmail: "asha@cxa.example.org",
    ipAddress: "198.51.100.7",
    ipHash: "hash"
  });
}

/** The eight nightly refusals from the report, 13 hours to 8 days old. */
function refusals(): (ActivityRow & { id: string })[] {
  return [13, 24 + 13, 72 + 13, 96 + 13, 120 + 13, 144 + 13, 168 + 13, 192 + 13].map((hoursAgo) => row({ hoursAgo }));
}

describe("naming a scheduled job's row", () => {
  it("calls every cron writer's row 'Scheduled job', never 'Somebody' or 'Deleted user'", () => {
    const cronRows = [
      row({ entityType: "LogArchiveRun" }),
      row({ entityType: "LogArchiveGap", entityId: "audit:2026-09-04" }),
      row({ entityType: "LogArchive", entityId: "audit:2026-10-09" }),
      row({ action: "PUBLISH", entityType: "Post", entityId: "post-1", entityLabel: "Monsoon looms" }),
      row({ action: "PUBLISH", entityType: "Page", entityId: "page-1", entityLabel: "Visit us" }),
      row({ action: "PURGE", entityType: "MediaAsset", entityId: "m-1", entityLabel: "loom.jpg" }),
      row({ action: "PURGE", entityType: "FileAsset", entityId: "f-1", entityLabel: "report.pdf" })
    ];
    for (const entry of cronRows) {
      assert.equal(isScheduledJobRow(entry), true, `${entry.action} ${entry.entityType}`);
      assert.equal(auditActorName(entry, "Somebody"), SCHEDULED_JOB_LABEL);
      assert.equal(auditActorName(entry), SCHEDULED_JOB_LABEL);
      assert.equal(auditActorLabel(entry), SCHEDULED_JOB_LABEL);
    }
    assert.equal(SCHEDULED_JOB_LABEL, "Scheduled job");
  });

  it("leaves anonymous PUBLIC rows alone — a refused sign-in, an enquiry, a registration", () => {
    const publicRows = [
      row({ action: "LOGIN_FAILED", entityType: "User", entityId: null, entityLabel: "typed@x.example", ipAddress: "203.0.113.9" }),
      row({ action: "CREATE", entityType: "ContactSubmission", entityId: "c-1", entityLabel: "Enquiry from a@b.example", ipAddress: "203.0.113.9" }),
      row({ action: "CREATE", entityType: "EventRegistration", entityId: "r-1", entityLabel: "a@b.example", ipAddress: "203.0.113.9" }),
      // Even without an IP: the action is not one a cron writes.
      row({ action: "LOGIN_FAILED", entityType: "User", entityId: null, entityLabel: "typed@x.example" })
    ];
    for (const entry of publicRows) {
      assert.equal(isScheduledJobRow(entry), false, `${entry.action} ${entry.entityType}`);
      assert.equal(auditActorName(entry, "Somebody"), "Somebody");
      assert.equal(auditActorLabel(entry), DELETED_ACTOR_LABEL);
    }
  });

  it("does not mistake a person's publish for the scheduler's when the account was hard-deleted", () => {
    // The recorded address names them (commit e4ec8e5) — unchanged.
    const withEmail = row({ action: "PUBLISH", entityType: "Post", actorEmail: "gone@cxa.example.org", ipAddress: "198.51.100.7" });
    assert.equal(isScheduledJobRow(withEmail), false);
    assert.equal(auditActorName(withEmail), "gone@cxa.example.org");
    assert.equal(auditActorLabel(withEmail), "gone@cxa.example.org");

    // A 2026-10-10 row with no address at all still carries the client fingerprint the studio request recorded.
    const fingerprintOnly = row({ action: "PUBLISH", entityType: "Post", ipHash: "abc" });
    assert.equal(isScheduledJobRow(fingerprintOnly), false);
    assert.equal(auditActorLabel(fingerprintOnly), DELETED_ACTOR_LABEL);
  });

  it("keeps a real actor's name and address on rows of the log archive's own types", () => {
    const named = row({ actor: { name: "Asha Rao", email: "asha@cxa.example.org" }, actorEmail: "asha@cxa.example.org", actorId: "u" });
    assert.equal(isScheduledJobRow(named), false);
    assert.equal(auditActorLabel(named), "Asha Rao <asha@cxa.example.org>");
  });

  it("gives a caller that does not select action and entityType exactly the old fallbacks", () => {
    assert.equal(isScheduledJobRow({ actor: null, actorEmail: null }), false);
    assert.equal(auditActorName({ actor: null, actorEmail: null }), DELETED_ACTOR_LABEL);
    assert.equal(auditActorName({ actor: null, actorEmail: null }, "Somebody"), "Somebody");
  });
});

describe("the dashboard's Recent activity", () => {
  it("lifts the eight refusals out of the panel, and collapses them into one problem line", () => {
    const rows = [...refusals(), human(2)].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const panel = summariseRecentActivity(rows, 8);
    assert.deepEqual(
      panel.lines.map((line) => line.entry.entityLabel),
      ["About us"],
      "only what a person did"
    );
    assert.equal(panel.omitted, 8);

    const problems = collapseScheduledRows(rows.filter(isScheduledProblem));
    assert.equal(problems.length, 1);
    const [line] = problems;
    assert.equal(line?.count, 8);
    assert.equal(line?.entry.createdAt.getTime(), NOW - 13 * HOUR, "the newest is the line's time");
    assert.equal(line?.earliestAt.getTime(), NOW - (192 + 13) * HOUR);
    assert.equal(collapsedCount(line?.count ?? 0), " ×8");
  });

  it("leaves routine archive rows out and keeps the problems apart from them", () => {
    const routine = row({ entityType: "LogArchive", entityId: "audit:2026-10-09", entityLabel: "audit_logs — 2026-10-09" });
    const gap = row({ entityType: "LogArchiveGap", entityId: "audit:2026-04-12", entityLabel: "audit_logs — 2026-04-12 left the archive scan window unarchived" });
    assert.equal(isRoutineScheduledRow(routine), true);
    assert.equal(isScheduledProblem(routine), false);
    assert.equal(isRoutineScheduledRow(gap), false);
    assert.equal(isScheduledProblem(gap), true);
    assert.equal(isScheduledProblem(row()), true);
    assert.equal(summariseRecentActivity([routine, gap], 8).lines.length, 0);
  });

  it("collapses identical scheduled rows even when people's rows sit between them", () => {
    const rows = [
      row({ hoursAgo: 1, action: "PUBLISH", entityType: "Post", entityId: "p-1", entityLabel: "Monsoon looms" }),
      human(2),
      row({ hoursAgo: 3, action: "PUBLISH", entityType: "Post", entityId: "p-1", entityLabel: "Monsoon looms" }),
      human(4, "Contact"),
      row({ hoursAgo: 5, action: "PUBLISH", entityType: "Post", entityId: "p-2", entityLabel: "Dyes of Bengal" })
    ];
    const lines = summariseRecentActivity(rows, 8).lines;
    assert.deepEqual(
      lines.map((line) => [line.entry.entityLabel, line.count]),
      [
        ["Monsoon looms", 2],
        ["About us", 1],
        ["Contact", 1],
        ["Dyes of Bengal", 1]
      ]
    );
    assert.equal(collapsedCount(1), "");
  });

  it("never collapses people's rows, however alike", () => {
    const lines = collapseScheduledRows([human(1), human(2), human(3)]);
    assert.deepEqual(lines.map((line) => line.count), [1, 1, 1]);
  });

  it("keeps the newest row of a group even when rows arrive out of order", () => {
    const lines = collapseScheduledRows([row({ hoursAgo: 30 }), row({ hoursAgo: 2 }), row({ hoursAgo: 50 })]);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.entry.createdAt.getTime(), NOW - 2 * HOUR);
    assert.equal(lines[0]?.earliestAt.getTime(), NOW - 50 * HOUR);
  });

  it("caps the lines and says so", () => {
    const rows = Array.from({ length: 10 }, (_, index) => human(index + 1, `Page ${index}`));
    const panel = summariseRecentActivity(rows, 8);
    assert.equal(panel.lines.length, 8);
    assert.equal(panel.capped, true);
    assert.equal(summariseRecentActivity(rows.slice(0, 8), 8).capped, false);
  });

  it("asks the database for the same split", () => {
    assert.deepEqual(recentActivityWhere(), {
      NOT: { entityType: { in: ["LogArchive", "LogArchiveRun", "LogArchiveGap"] }, actorId: null, actorEmail: null }
    });
    const since = new Date(NOW);
    assert.deepEqual(scheduledProblemWhere(since), {
      entityType: { in: ["LogArchiveRun", "LogArchiveGap"] },
      actorId: null,
      actorEmail: null,
      createdAt: { gte: since }
    });
  });
});
