import type { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma, SubmissionStatus } from "@prisma/client";
import { badRequest, ok, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageInquiries } from "@/lib/permissions";
import { parseStudioQuery } from "@/lib/studio/crud";
import { truncateWords } from "@/lib/utils";

/**
 * The contact inbox: what has come in, who is dealing with it, and how old it is.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * SPAM IS FILTERED OUT OF THE WORKING LIST AND COUNTED IN THE ANSWER.
 *
 * `lib/spam.ts` MARKS; it never deletes, and the asymmetry is total. A false positive that was stored can
 * be found, read and answered a day late. A false positive that was discarded is a collaboration enquiry
 * or a PhD application that never existed — the sender was told "thank you", believes they made contact,
 * and waits.
 *
 * So an unfiltered list leaves the ones marked SPAM out (an inbox with the spam in it is an inbox nobody
 * triages) and `counts` says how many were left out, per state, IGNORING the filters. That number is what
 * lets the screen print "12 messages were marked as spam and are not in this list" — a list that quietly
 * stops is indistinguishable from a place with no records (contract §1.6).
 *
 * ⚠ THERE IS NO DELETE ENDPOINT ANYWHERE UNDER `/api/studio/inquiries`, AND THERE MUST NEVER BE ONE. A
 * deleted enquiry is a lost enquiry: it is somebody's only attempt to reach the Centre and there is no
 * second copy anywhere. ARCHIVING clears the queue and keeps every word. The recycle bin is the only
 * removal path, and it is reached from its own screen, one record at a time, by an administrator.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `canManageInquiries` — editor and above, because a reply speaks for the institution.
 *
 * ⚠ THE BULK ARCHIVE AND THE CSV EXPORT LIVE IN `[id]/route.ts`, on the reserved ids `bulk` and `export`.
 * The header of that file explains why. They are collection-level operations and would ordinarily sit
 * here; the paths the inbox screen calls are what decided it.
 */

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
/** Deep paging into an inbox is always a sign the filters are the better tool. */
const MAX_PAGE = 400;

/** How much of the message the list carries. The whole thing is in the detail response. */
const PREVIEW_CHARS = 160;

/** The states, so a filter value can be checked without a second list of them. */
const STATES = ["NEW", "IN_PROGRESS", "REPLIED", "ARCHIVED", "SPAM"] as const;

/**
 * The states an unfiltered list shows. SPAM is deliberately absent — see the header.
 */
const WORKING_STATES: readonly SubmissionStatus[] = ["NEW", "IN_PROGRESS", "REPLIED", "ARCHIVED"];

/**
 * The reserved words the assignee filter uses.
 *
 * `buildQuery` in lib/client/fetcher.ts DROPS the empty string, so a filter meaning "nobody" cannot be
 * expressed as `assignee=` — it would be indistinguishable from not filtering at all. The reserved word is
 * the documented way round that, and this handler is the half that maps it.
 */
const UNASSIGNED = "none";

const ListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  state: z.enum(STATES).optional(),
  /** A user id, or the reserved word `none`. */
  assignee: z.string().trim().max(64).optional(),
  formKey: z.string().trim().max(40).optional(),
  page: z
    .string()
    .trim()
    .regex(/^\d{1,4}$/, "The page must be a whole number.")
    .optional(),
  pageSize: z
    .string()
    .trim()
    .regex(/^\d{1,3}$/, "The page size must be a whole number.")
    .optional()
});

export const GET = route(async (request: NextRequest) => {
  await requireCapability(
    canManageInquiries,
    "The contact inbox needs editor access or higher. An administrator can raise yours."
  );

  const query = parseStudioQuery(request, ListQuery);

  const q = query.q ?? "";
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, query.pageSize ? Number.parseInt(query.pageSize, 10) : DEFAULT_PAGE_SIZE)
  );
  const page = Math.min(MAX_PAGE, Math.max(1, query.page ? Number.parseInt(query.page, 10) : 1));

  const assignee = query.assignee ?? "";
  if (assignee.length > 0 && assignee !== UNASSIGNED) {
    const exists = await prisma.user.findUnique({ where: { id: assignee }, select: { id: true } });
    if (!exists) {
      // Refused rather than answered with nothing. An id that no longer names anybody would produce an
      // empty inbox, which reads as "there are no enquiries" rather than "that person has gone".
      throw badRequest(
        "The person you filtered by no longer has an account here, so the filter could not be applied. Clear it to see the inbox again."
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
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { organisation: { contains: q, mode: "insensitive" } },
            { subject: { contains: q, mode: "insensitive" } },
            { message: { contains: q, mode: "insensitive" } }
          ]
        }
      : {})
  };

  const [rows, total] = await prisma.$transaction([
    prisma.contactSubmission.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        organisation: true,
        subject: true,
        formKey: true,
        state: true,
        repliedAt: true,
        spamScore: true,
        spamReason: true,
        internalNote: true,
        message: true,
        createdAt: true,
        assignee: { select: { id: true, name: true } }
      },
      // Newest first, with the id as the tiebreak so two enquiries that arrived in the same millisecond
      // keep a stable order between requests — an unstable sort shows a row twice across two pages.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize
    }),
    prisma.contactSubmission.count({ where })
  ]);

  /**
   * The counts IGNORE the filters, on purpose.
   *
   * A count that only ever describes the current selection can never tell the reader that there are twelve
   * messages they are not being shown. This is the number the spam sentence is built from.
   *
   * ⚠ Read OUTSIDE the transaction above, and that is a type constraint rather than a preference: Prisma's
   * `$transaction([…])` unifies the element types of its array, and a `groupBy`'s `_count` payload does not
   * survive the unification — it comes back as a union nothing can read. Read on its own it is typed
   * exactly. The cost is one extra round trip and a count that may be a moment newer than the page, which
   * is invisible in a number rendered as "12 marked as spam".
   */
  const grouped = await prisma.contactSubmission.groupBy({
    by: ["state"],
    where: { deletedAt: null },
    orderBy: { state: "asc" },
    _count: { _all: true }
  });

  const counts: Partial<Record<SubmissionStatus, number>> = {};
  for (const entry of grouped) counts[entry.state] = entry._count._all;

  return ok({
    items: rows.map((row) => {
      // The note itself is NOT in the list: it is internal correspondence about somebody, and a list that
      // carried it would put it in every cached response and every screenshot of the inbox. Whether one
      // exists is what the table needs.
      const { internalNote, message, ...rest } = row;
      return {
        ...rest,
        hasNote: (internalNote ?? "").trim().length > 0,
        preview: truncateWords(message.replace(/\s+/g, " "), PREVIEW_CHARS)
      };
    }),
    total,
    page,
    pageSize,
    truncated: page * pageSize < total,
    counts
  });
});
