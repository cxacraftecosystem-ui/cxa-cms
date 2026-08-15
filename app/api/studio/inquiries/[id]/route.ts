import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma, SubmissionStatus } from "@prisma/client";
import { assertSameOrigin, badRequest, ok, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { mutateWithHistory } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { canManageInquiries } from "@/lib/permissions";
import { buildAuditContext, found, parseStudioJson, parseStudioQuery } from "@/lib/studio/crud";

/**
 * One enquiry — and the two collection-wide operations that share this address.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ TWO RESERVED IDS: `bulk` AND `export`.
 *
 * `POST /api/studio/inquiries/bulk` archives many, and `GET /api/studio/inquiries/export` answers CSV.
 * Both are collection-level and would ordinarily live in `../route.ts`; they are here because those are the
 * addresses the inbox screen calls and a dynamic segment catches them.
 *
 * This is safe rather than clever: every id in this table is a cuid — twenty-five characters of lower-case
 * and digits — so no record can ever be called `bulk` or `export`, and the two words cannot shadow a real
 * enquiry. If a static route file is ever added at either path, Next prefers it and this dispatch becomes
 * dead code that must be deleted in the same commit.
 *
 * ⚠ THERE IS NO DELETE HANDLER IN THIS FILE, AND THERE MUST NEVER BE ONE. A deleted enquiry is a lost
 * enquiry: it is somebody's only attempt to reach the Centre and there is no second copy anywhere. Moving
 * one to the recycle bin is done from the recycle bin's own screen, one record at a time, by an
 * administrator — never from the inbox, and never in bulk.
 *
 * THE BULK ACTION IS ARCHIVE, AND ONLY ARCHIVE. It clears the queue and keeps every word. A bulk delete
 * would be the single most destructive control in the studio and the one most likely to be pressed by
 * accident, because a bulk bar sits above a list of checkboxes.
 *
 * REPLYING HAPPENS IN THE READER'S OWN MAIL PROGRAM, so this studio cannot see that a reply went. `state`
 * is therefore moved BY HAND, and `repliedAt` is stamped when it moves to REPLIED. A "Replied" that set
 * itself would be a lie the next person to open the inbox would believe.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/** The two words that are operations rather than records. See the header. */
const BULK_ID = "bulk";
const EXPORT_ID = "export";

/** How many enquiries one bulk action may touch. Stated in the refusal when it bites. */
const MAX_BULK = 200;

/**
 * How many rows the CSV carries.
 *
 * A spreadsheet that quietly stopped at a thousand rows would be treated as the complete record of the
 * Centre's correspondence — so the cap is high, and when it bites the file gets a final row saying so in
 * its first column. A truncated export that does not announce itself is the worst failure on this screen.
 */
const MAX_EXPORT_ROWS = 5000;

const STATES = ["NEW", "IN_PROGRESS", "REPLIED", "ARCHIVED", "SPAM"] as const;
const WORKING_STATES: readonly SubmissionStatus[] = ["NEW", "IN_PROGRESS", "REPLIED", "ARCHIVED"];
const UNASSIGNED = "none";

const NOTE_MAX = 2000;

const detailSelect = {
  id: true,
  name: true,
  email: true,
  organisation: true,
  phone: true,
  subject: true,
  message: true,
  formKey: true,
  state: true,
  internalNote: true,
  repliedAt: true,
  spamScore: true,
  spamReason: true,
  ipAddress: true,
  userAgent: true,
  createdAt: true,
  updatedAt: true,
  assignee: { select: { id: true, name: true } }
} as const;

type DetailRow = Prisma.ContactSubmissionGetPayload<{ select: typeof detailSelect }>;

function toDetail(row: DetailRow) {
  return { ...row, hasNote: (row.internalNote ?? "").trim().length > 0, preview: row.message };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One CSV cell.
 *
 * TWO THINGS ARE HAPPENING HERE and only one of them is CSV.
 *
 *  1. The quoting: everything is wrapped in double quotes and internal quotes are doubled, which is the
 *     RFC 4180 escape. Without it a message containing a comma or a newline — most of them do — silently
 *     becomes several columns and several rows, and the file looks like corrupted data rather than a
 *     quoting bug.
 *
 *  2. ⚠ THE FORMULA GUARD. A cell beginning `=`, `+`, `-`, `@`, a tab or a carriage return is evaluated as
 *     a FORMULA by Excel, Numbers and Google Sheets. A stranger who types `=HYPERLINK(...)` into a contact
 *     form has written code that runs on the machine of whoever opens the export. A leading apostrophe
 *     makes the cell text; the apostrophe is not shown by any spreadsheet, so nothing is lost to read.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  const raw =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "string"
        ? value
        : String(value);
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${guarded.replace(/"/g, '""')}"`;
}

function csvRow(values: readonly unknown[]): string {
  // CRLF, because that is what a spreadsheet on Windows expects and every other reader tolerates.
  return `${values.map(csvCell).join(",")}\r\n`;
}

/**
 * ⚠ A UTF-8 BYTE-ORDER MARK, and it is load-bearing.
 *
 * Excel on Windows reads a CSV with no BOM in the system code page, so every name with a diacritic — and
 * every enquiry written in a script that is not Latin — arrives as mojibake. Three bytes, ignored by every
 * other reader. Written as an escape rather than the character itself, which is invisible in source and is
 * exactly the sort of thing an editor silently strips.
 */
const BOM = "\uFEFF";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The list filter, shared by the CSV export
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const ExportQuery = z.object({
  q: z.string().trim().max(200).optional(),
  state: z.enum(STATES).optional(),
  assignee: z.string().trim().max(64).optional(),
  formKey: z.string().trim().max(40).optional(),
  /** Accepted and ignored: the export covers every page of the filter, and the screen says so. */
  page: z.string().trim().max(8).optional(),
  pageSize: z.string().trim().max(8).optional()
});

/**
 * ⚠ THE SAME `where` AS THE LIST IN `../route.ts`.
 *
 * The export's whole promise is "this file holds exactly what these filters are showing", and the screen
 * prints the row count from the list before anybody presses the button. A filter that differed by one
 * clause would make that number a lie. If either changes, both change.
 */
function whereFrom(query: z.infer<typeof ExportQuery>): Prisma.ContactSubmissionWhereInput {
  const q = query.q ?? "";
  const assignee = query.assignee ?? "";
  return {
    deletedAt: null,
    ...(query.state ? { state: query.state } : { state: { in: [...WORKING_STATES] } }),
    ...(assignee === UNASSIGNED
      ? { assigneeId: null }
      : assignee.length > 0
        ? { assigneeId: assignee }
        : {}),
    ...(query.formKey && query.formKey.length > 0 ? { formKey: query.formKey } : {}),
    ...(q.length > 0
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { email: { contains: q, mode: "insensitive" as const } },
            { organisation: { contains: q, mode: "insensitive" as const } },
            { subject: { contains: q, mode: "insensitive" as const } },
            { message: { contains: q, mode: "insensitive" as const } }
          ]
        }
      : {})
  };
}

async function exportCsv(request: NextRequest): Promise<NextResponse> {
  const query = parseStudioQuery(request, ExportQuery);
  const where = whereFrom(query);

  const [rows, total] = await prisma.$transaction([
    prisma.contactSubmission.findMany({
      where,
      select: detailSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_EXPORT_ROWS
    }),
    prisma.contactSubmission.count({ where })
  ]);

  const header = [
    "Received (UTC)",
    "Name",
    "Email",
    "Organisation",
    "Telephone",
    "Form",
    "Subject",
    "Message",
    "State",
    "Being handled by",
    "Replied (UTC)",
    "Internal note",
    "Spam score",
    "Spam reason",
    "Id"
  ];

  let body = csvRow(header);
  for (const row of rows) {
    body += csvRow([
      row.createdAt,
      row.name,
      row.email,
      row.organisation,
      row.phone,
      row.formKey,
      row.subject,
      row.message,
      row.state,
      row.assignee?.name ?? "",
      row.repliedAt,
      row.internalNote,
      row.spamScore,
      row.spamReason,
      row.id
    ]);
  }

  if (total > rows.length) {
    // ⚠ IN THE FILE ITSELF, not only in a header nobody reads. A spreadsheet is opened weeks later by
    // somebody who never saw the screen it came from.
    body += csvRow([
      `This file holds the ${rows.length} most recent of ${total} enquiries matching the filters. ` +
        `The export is capped at ${MAX_EXPORT_ROWS} rows — narrow the dates or the state to get the rest.`
    ]);
  }

  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(BOM + body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="enquiries-${stamp}.csv"`,
      // Never cached: an export of an inbox is a snapshot of live correspondence, and a proxy holding it
      // would serve one editor's filtered view to the next.
      "cache-control": "no-store, max-age=0"
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// GET — one enquiry, or the CSV
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const GET = route(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    await requireCapability(
      canManageInquiries,
      "The contact inbox needs editor access or higher. An administrator can raise yours."
    );

    const { id } = await params;
    if (id === EXPORT_ID) return exportCsv(request);

    const row = found(
      await prisma.contactSubmission.findFirst({ where: { id, deletedAt: null }, select: detailSelect }),
      "That enquiry"
    );

    return ok(toDetail(row));
  }
);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PATCH — state, assignee, internal note
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const PatchBody = z.object({
  state: z.enum(STATES).optional(),
  /** `null` means nobody. Never the empty string, which would be a user id nobody has. */
  assigneeId: z.string().trim().max(64).nullable().optional(),
  internalNote: z
    .string()
    .max(NOTE_MAX, `Keep the note to ${NOTE_MAX} characters or fewer.`)
    .nullable()
    .optional()
});

export const PATCH = route(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    assertSameOrigin(request);

    const actor = await requireCapability(
      canManageInquiries,
      "Changing an enquiry needs editor access or higher. An administrator can raise yours."
    );

    const { id } = await params;
    if (id === BULK_ID || id === EXPORT_ID) {
      throw badRequest("That address does not take a change. Use POST for a bulk action.");
    }

    const body = await parseStudioJson(request, PatchBody);

    const before = found(
      await prisma.contactSubmission.findFirst({ where: { id, deletedAt: null }, select: detailSelect }),
      "That enquiry"
    );

    const changes: Prisma.ContactSubmissionUpdateInput = {};
    const reasons: string[] = [];

    if (body.assigneeId !== undefined) {
      if (body.assigneeId === null || body.assigneeId.length === 0) {
        changes.assignee = { disconnect: true };
        reasons.push("Nobody is handling it now.");
      } else {
        /**
         * The assignee must be somebody who could actually deal with it.
         *
         * `canManageInquiries` is the predicate, applied to the candidate's role rather than restated as a
         * list of tiers — handing an enquiry to a viewer would put it in a queue they cannot answer, and
         * the row would look attended to.
         */
        const candidate = await prisma.user.findFirst({
          where: { id: body.assigneeId, deletedAt: null, isActive: true },
          select: { id: true, name: true, role: true, canPublish: true, canManageMedia: true }
        });
        if (!candidate) {
          throw badRequest(
            "That person does not have an account here, or their account has been switched off, so the enquiry has not been handed over."
          );
        }
        if (!canManageInquiries(candidate)) {
          throw badRequest(
            `${candidate.name} does not have access to the contact inbox, so they would never see this enquiry. Hand it to an editor or an administrator.`
          );
        }
        changes.assignee = { connect: { id: candidate.id } };
        reasons.push(`${candidate.name} is handling it now.`);
      }
    }

    if (body.state !== undefined && body.state !== before.state) {
      changes.state = body.state;
      /**
       * `repliedAt` IS STAMPED HERE and nowhere else.
       *
       * The reply itself is written in the reader's own mail program, so nothing can observe it. Stamping
       * the moment somebody says "I have replied" is the closest honest record available; leaving it null
       * while the state says REPLIED would make the two disagree.
       *
       * It is NOT cleared when the state moves away again: the reply still happened, and erasing the date
       * would lose the only evidence of when.
       */
      if (body.state === "REPLIED" && before.repliedAt === null) {
        changes.repliedAt = new Date();
      }
      reasons.push(
        body.state === "SPAM"
          ? "It has been marked as spam. Nothing has been deleted — it is still readable under the spam filter."
          : body.state === "NEW" && before.state === "SPAM"
            ? "It is back in the queue as a new enquiry and can be answered."
            : `It has been moved to “${body.state.replace(/_/g, " ").toLowerCase()}”.`
      );
    }

    if (body.internalNote !== undefined) {
      const note = (body.internalNote ?? "").trim();
      changes.internalNote = note.length > 0 ? note : null;
      reasons.push(note.length > 0 ? "The note has been saved." : "The note has been cleared.");
    }

    if (Object.keys(changes).length === 0) {
      return ok({
        ...toDetail(before),
        changed: false,
        message: "Nothing was different, so nothing has been changed."
      });
    }

    const updated = await mutateWithHistory<DetailRow>(
      buildAuditContext(request, actor),
      {
        action: "UPDATE",
        entityType: "ContactSubmission",
        entityLabel: `${before.name} <${before.email}>`,
        /**
         * NO REVISION. An enquiry's own words are never edited here — only its state, who is dealing with
         * it and the internal note — so a revision would be a second copy of a message that has not
         * changed. The audit entry records the triage, which is what somebody asks about later.
         */
        revise: false,
        /**
         * METADATA AND THE NOTE, not the message. The sender's words are already stored on the row and the
         * inbox renders them; copying somebody's personal correspondence into `audit_logs` as well would
         * double how much of it is held in a table that more people read and that gets exported.
         */
        before: {
          state: before.state,
          assigneeId: before.assignee?.id ?? null,
          hasNote: (before.internalNote ?? "").trim().length > 0,
          repliedAt: before.repliedAt
        }
      },
      async (tx) =>
        tx.contactSubmission.update({ where: { id: before.id }, data: changes, select: detailSelect })
    );

    return ok({ ...toDetail(updated), changed: true, message: reasons.join(" ") });
  }
);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// POST — the bulk archive
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const BulkBody = z.object({
  ids: z
    .array(z.string().trim().min(1).max(64))
    .min(1, "Choose at least one enquiry.")
    .max(MAX_BULK, `At most ${MAX_BULK} enquiries can be dealt with at once.`),
  /**
   * ONE ACTION, and it is a closed list of exactly one word for a reason. `archive` keeps every word and
   * clears the queue. There is no `delete`, and adding one to this enum would be the most destructive line
   * anybody could write in this studio — see the file header.
   */
  action: z.literal("archive")
});

export const POST = route(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    assertSameOrigin(request);

    const actor = await requireCapability(
      canManageInquiries,
      "Archiving enquiries needs editor access or higher. An administrator can raise yours."
    );

    const { id } = await params;
    if (id !== BULK_ID) {
      throw badRequest(
        "That address does not take an action. Send a bulk archive to /api/studio/inquiries/bulk."
      );
    }

    const body = await parseStudioJson(request, BulkBody);
    // Duplicates in the selection are the client's business, not a refusal — the same row archived twice is
    // archived once.
    const ids = [...new Set(body.ids)];

    const rows = await prisma.contactSubmission.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, name: true, email: true, state: true }
    });

    const found = new Set(rows.map((row) => row.id));
    const missing = ids.filter((candidate) => !found.has(candidate));
    const already = rows.filter((row) => row.state === "ARCHIVED");
    const toArchive = rows.filter((row) => row.state !== "ARCHIVED");

    /**
     * EVERY ROW IN ONE TRANSACTION, with one audit entry each.
     *
     * Per-row entries rather than one summary: the audit log is read to answer "who archived my enquiry",
     * and a single entry naming twenty ids is an answer somebody has to unpick. `updateMany` would be one
     * statement and no trail at all.
     *
     * The whole batch is atomic, so a failure part-way through does not leave half a selection archived
     * while the screen reports a failure — the reader can press the same button again on the same rows.
     */
    const context = buildAuditContext(request, actor);
    let archived = 0;

    for (const row of toArchive) {
      await mutateWithHistory<{ id: string }>(
        context,
        {
          action: "ARCHIVE",
          entityType: "ContactSubmission",
          entityLabel: `${row.name} <${row.email}>`,
          revise: false,
          before: { state: row.state }
        },
        async (tx) =>
          tx.contactSubmission.update({
            where: { id: row.id },
            data: { state: "ARCHIVED" },
            select: { id: true }
          })
      );
      archived += 1;
    }

    /**
     * WHAT DID NOT HAPPEN IS REPORTED. A bulk action that answers only with its successes looks identical
     * to one that did everything asked of it — and a row that was skipped because somebody else had already
     * dealt with it is exactly the thing a reader needs to know.
     */
    return ok({
      archived,
      alreadyArchived: already.length,
      /** Ids that are no longer in the inbox — moved to the recycle bin, or dealt with in another window. */
      notFound: missing,
      message:
        `${archived === 1 ? "1 enquiry" : `${archived} enquiries`} archived. Nothing has been deleted — ` +
        "every word is still there under the Archived filter." +
        (already.length > 0
          ? ` ${already.length === 1 ? "1 was" : `${already.length} were`} already archived.`
          : "") +
        (missing.length > 0
          ? ` ${missing.length === 1 ? "1 is" : `${missing.length} are`} no longer in the inbox — somebody may have dealt with ${missing.length === 1 ? "it" : "them"} while your screen was open.`
          : "")
    });
  }
);
