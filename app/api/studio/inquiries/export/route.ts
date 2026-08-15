import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma, SubmissionStatus } from "@prisma/client";

import { badRequest, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageInquiries } from "@/lib/permissions";
import { parseStudioQuery } from "@/lib/studio/crud";

/**
 * The contact inbox as a spreadsheet: every enquiry the current filters describe.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE FORMULA GUARD IS THE MOST IMPORTANT THING IN THIS FILE.
 *
 * A cell whose text begins `=`, `+`, `-`, `@`, a tab or a carriage return is evaluated as a FORMULA by Excel,
 * Numbers and Google Sheets. Every field in this file was typed by a stranger into a form on the public
 * internet, so `=HYPERLINK(...)` or `=cmd|'/c calc'!A1` in a message body is a stranger running code on the
 * machine of whichever member of staff opens the export. A leading apostrophe makes the cell text; no
 * spreadsheet displays the apostrophe, so nothing is lost to read.
 *
 * The quoting is the other half and it is not optional either: every field is wrapped in double quotes and
 * internal quotes are doubled (the RFC 4180 escape). Most messages contain a comma or a newline, and without
 * the quoting one enquiry silently becomes several columns and several rows — which looks like corrupted data
 * rather than like a quoting bug.
 *
 * ⚠ THE CAP IS STATED IN THE FILE ITSELF, not only in a header nobody reads. A spreadsheet is opened weeks
 * later by somebody who never saw the screen it came from, and a truncated export that does not announce
 * itself is treated as the complete record of the Centre's correspondence (contract §1.6). This export is
 * evidence somebody may act on.
 *
 * ⚠ THE FILTERS ARE A MIRROR OF `app/api/studio/inquiries/route.ts`, KEPT IN STEP BY HAND.
 *
 * A `route.ts` may export nothing but its HTTP handlers — the generated check in `.next/types/**` fails the
 * build on any other export — so the list's `ListQuery` and its `where` cannot be imported, and this is a
 * deliberate copy. It matters more here than anywhere else in the studio: the screen prints "Export these 37
 * enquiries" from the LIST's count and this handler answers the file, so a filter clause that differed by one
 * word would make that number a lie about an export somebody is about to circulate. If either changes, change
 * both.
 *
 * ⚠ THIS FILE TAKES OVER A PATH THAT WAS BEING SERVED BY A RESERVED ID. `inquiries/[id]/route.ts` dispatches
 * `GET` with `id="export"` to a copy of this handler, and its own header says that a static route file at this
 * path wins and turns that branch into dead code. It does (contract §13b); the branch is left in place only
 * because that file is not this one's to edit — see the manifest.
 *
 * NO SPAM SPECIAL CASE, BEYOND THE LIST'S. With no state filter, the export covers the same four working
 * states the inbox shows and leaves the ones marked as spam out — because that is what the screen is showing
 * and what its count says. Choosing the spam filter exports those instead.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * How many rows the file carries.
 *
 * ⚠ The same number as `MAX_EXPORT_ROWS` in `inquiries/[id]/route.ts`, so the cap does not change as this path
 * moves between the two files. High, because a spreadsheet that stopped at a thousand rows would be believed;
 * and when it bites, the file says so in its last row.
 */
const MAX_EXPORT_ROWS = 5000;

/** ⚠ Mirrors the list's own vocabulary. See the header. */
const STATES = ["NEW", "IN_PROGRESS", "REPLIED", "ARCHIVED", "SPAM"] as const;

/** The states an unfiltered inbox shows. SPAM is deliberately absent, exactly as in the list. */
const WORKING_STATES: readonly SubmissionStatus[] = ["NEW", "IN_PROGRESS", "REPLIED", "ARCHIVED"];

/**
 * The reserved word the assignee filter uses.
 *
 * `buildQuery` in lib/client/fetcher.ts DROPS the empty string, so "nobody yet" cannot be expressed as
 * `assignee=` — it would be indistinguishable from not filtering at all.
 */
const UNASSIGNED = "none";

const exportQuery = z.object({
  q: z.string().trim().max(200).optional(),
  state: z.enum(STATES).optional(),
  assignee: z.string().trim().max(64).optional(),
  formKey: z.string().trim().max(40).optional(),
  /** Accepted and ignored: the export covers every page of the filter, and the screen promises that. */
  page: z.string().trim().max(8).optional(),
  pageSize: z.string().trim().max(8).optional()
});

/** The columns the file carries, in the order they appear. */
const EXPORT_SELECT = {
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
  createdAt: true,
  assignee: { select: { name: true } }
} as const satisfies Prisma.ContactSubmissionSelect;

/**
 * ⚠ A UTF-8 BYTE-ORDER MARK, and it is load-bearing.
 *
 * Excel on Windows reads a CSV with no BOM in the system code page, so every name with a diacritic — and every
 * enquiry written in a script that is not Latin — arrives as mojibake. Three bytes, ignored by every other
 * reader. Written as an escape rather than the character itself, which is invisible in source and is exactly
 * the sort of thing an editor silently strips.
 */
const BOM = "\uFEFF";

/** One cell: quoted, internal quotes doubled, and a leading formula character neutralised. See the header. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  const raw =
    value instanceof Date ? value.toISOString() : typeof value === "string" ? value : String(value);
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${guarded.replace(/"/g, '""')}"`;
}

function csvRow(values: readonly unknown[]): string {
  // CRLF, because that is what a spreadsheet on Windows expects and every other reader tolerates.
  return `${values.map(csvCell).join(",")}\r\n`;
}

export const GET = route(async (request: Request) => {
  await requireCapability(
    canManageInquiries,
    "The contact inbox needs editor access or higher. An administrator can raise yours."
  );

  const query = parseStudioQuery(request, exportQuery);

  const q = query.q ?? "";
  const assignee = query.assignee ?? "";

  if (assignee.length > 0 && assignee !== UNASSIGNED) {
    const exists = await prisma.user.findUnique({ where: { id: assignee }, select: { id: true } });
    if (!exists) {
      /**
       * Refused rather than answered with an empty file. ⚠ The same refusal as the list's, and for the same
       * reason: an id that no longer names anybody would produce a spreadsheet with a header row and nothing
       * else, which reads as "there are no enquiries" rather than as "that person has gone".
       */
      throw badRequest(
        "The person you filtered by no longer has an account here, so the filter could not be applied and nothing has been exported. Clear it and try again."
      );
    }
  }

  const where: Prisma.ContactSubmissionWhereInput = {
    // The recycle bin is `deletedAt IS NOT NULL`, and a row in it is already invisible everywhere else.
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

  const [rows, total] = await prisma.$transaction([
    prisma.contactSubmission.findMany({
      where,
      select: EXPORT_SELECT,
      // Newest first, with the id as the tiebreak — the same total ordering as the list, so the file reads in
      // the order the screen was showing.
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
    // ⚠ IN THE FILE ITSELF. See the header: the person who opens this may never have seen the screen.
    body += csvRow([
      `This file holds the ${rows.length} most recent of ${total} enquiries matching the filters that were set. ` +
        `The export stops at ${MAX_EXPORT_ROWS} rows — narrow the state, the form or the search to get the rest.`
    ]);
  }

  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(BOM + body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      // The date is in the NAME as well as in the rows: two exports taken a week apart otherwise sit in a
      // downloads folder as "enquiries.csv" and "enquiries (1).csv", and nobody can tell which is which.
      "content-disposition": `attachment; filename="enquiries-${stamp}.csv"`,
      // Never cached: an export of an inbox is a snapshot of live correspondence, and a proxy holding it would
      // serve one editor's filtered view to the next.
      "cache-control": "no-store, max-age=0"
    }
  });
});
