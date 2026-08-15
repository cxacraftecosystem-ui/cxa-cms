import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";

import { route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { BOM, csvRow } from "@/lib/csv";
import { prisma } from "@/lib/db";
import {
  NEWSLETTER_SOURCES,
  NEWSLETTER_SOURCE_LABELS,
  type NewsletterSource
} from "@/lib/newsletter/address";
import {
  SUBSCRIBER_STATUS_LABELS,
  isMailableSubscriber,
  isSubscriberStatus,
  liveSubscriberWhere,
  subscriberSearchWhere
} from "@/lib/newsletter/subscribers";
import { canManageInquiries } from "@/lib/permissions";

/**
 * The newsletter list as a spreadsheet: every subscriber the current filters describe.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE FORMULA GUARD IS THE MOST IMPORTANT THING IN THIS FILE, AND THIS IS THE CLASSIC TARGET.
 *
 * A cell whose text begins `=`, `+`, `-`, `@`, a tab or a carriage return is evaluated as a FORMULA by
 * Excel, Numbers and Google Sheets. Every address in this file was typed by a stranger into a form on the
 * public internet, and so was every `sourcePath` and every user-agent string — so `=HYPERLINK(...)` or
 * `=cmd|'/c calc'!A1` in any of them is a stranger running code on the machine of whichever member of
 * staff opens the export. A leading apostrophe makes the cell text; no spreadsheet displays the
 * apostrophe, so nothing is lost to read.
 *
 * A MAILING LIST IS THE MOST ATTRACTIVE TARGET THIS APPLICATION HAS for that attack, because it is the
 * one export whose entire content is attacker-supplied and whose reader is guaranteed to be staff.
 *
 * ⚠ AND THE GUARD IS NOT IN THIS FILE. `csvCell`, `csvRow` and the BOM are IMPORTED from `lib/csv.ts`.
 * This file's first draft copied them from `app/api/studio/inquiries/export/route.ts` "character for
 * character, rather than reinvented", and said in this paragraph that two implementations of an injection
 * guard means one of them is eventually weaker — which was true, and which that copy was an instance of:
 * it was the third in the repository, and nothing anywhere related them. Harden the character class in
 * `lib/csv.ts` and every export in the application is hardened at once.
 *
 * The quoting is the other half and is not optional either: every field is wrapped in double quotes and
 * internal quotes are doubled (the RFC 4180 escape). A consent sentence contains commas, and a
 * user-agent string can contain almost anything — without the quoting one subscriber silently becomes
 * several columns and several rows, which looks like corrupted data rather than like a quoting bug.
 *
 * ⚠ THE CAP IS STATED IN THE FILE ITSELF, not only on the screen it came from. A spreadsheet is opened
 * weeks later by somebody who never saw that screen, and a truncated export that does not announce
 * itself is treated as the complete record (contract §1.6). A mailing list is exactly the kind of file
 * somebody acts on.
 *
 * ══ ⚠ WHY THIS ROUTE LIVES UNDER `app/studio/` AND NOT UNDER `app/api/studio/` ══
 *
 * Every other studio export is an `/api/studio/...` handler, and this one is not. The consequence is
 * worth writing down because it is invisible: `scripts/route-check.ts` resolves `/api/...` LITERALS
 * found in `app`, `components` and `lib` against the handlers Next would route them to, so an
 * `/api/studio/...` link that no longer has a handler is caught mechanically. **This path is not
 * `/api/...`, so `npm run route-check` does not cover the link to it.** The link is built in
 * `app/studio/subscribers/page.tsx` (`exportHref`) and the only thing keeping the two in step is that
 * they are the same six words in the same directory. If this file is ever moved, grep for
 * `/studio/subscribers/export` before assuming a check will notice.
 *
 * ══ THE FILTERS ARE A MIRROR OF THE SCREEN'S, AND THEY ARE KEPT IN STEP BY IMPORT, NOT BY HAND ══
 *
 * A `route.ts` may export nothing but its HTTP handlers — the generated check in `.next/types/**` fails
 * the build on any other export — so the two cannot share a `where` builder defined in either file. What
 * they CAN share, and do, is `liveSubscriberWhere()` and `subscriberSearchWhere()` from
 * lib/newsletter/subscribers.ts, which is where those two clauses live precisely so a screen and an
 * export cannot disagree about what "the list" means. Only the assembly is repeated, and the narrowing
 * of `?status=`/`?source=` is repeated with it — including the trap noted on both sides:
 * `toNewsletterSource()` must NOT be used to read a query parameter, because it falls back to `"other"`
 * and would turn an absent filter into a filter for sign-ups from somewhere else.
 *
 * The screen prints "All 37 matching records are shown above. The export contains exactly these." and
 * this handler answers the file — so a filter clause that differed by one word would make that sentence
 * a lie about a spreadsheet somebody is about to circulate.
 *
 * ══ WHAT IS DELIBERATELY **NOT** IN THE FILE ══
 *
 *   • **No confirmation nonce.** `confirmationToken` is a live credential: a link signed over it
 *     confirms a subscription. A spreadsheet holding one turns every downloads folder and every email
 *     attachment into a way to confirm somebody else's subscription. The outbox does not store the link
 *     for the same reason (see the model's own comment); an export must not undo that.
 *   • **No erased records.** `liveSubscriberWhere()` filters them out, which is the whole point of the
 *     column. An erasure that still appeared in an export would not be an erasure.
 *   • **Unsubscribed records ARE included**, and that is not an oversight. They are the suppression
 *     record — the evidence that an address asked to stop — and a list exported for a migration that
 *     omitted them is precisely how those people get signed up again by the import at the other end.
 *     The status column says plainly which they are, and the header row is worded so that a reader who
 *     sorts by it cannot mistake the file for an audience.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * How many rows the file carries.
 *
 * ⚠ THE SAME NUMBER AS `LIST_LIMIT` ON THE SCREEN, and it has to be: the screen says "The export
 * contains exactly these" about the rows it is showing, and a cap here that was higher would make that
 * sentence false in the safe direction while a cap that was lower would make it false in the dangerous
 * one. When it bites, the file says so in its last row.
 */
const MAX_EXPORT_ROWS = 200;

/** The search box's cap on the screen. Repeated so a hand-edited URL cannot ask for more work. */
const QUERY_MAX = 200;

/**
 * ⚠ THE QUOTING, THE FORMULA GUARD AND THE BOM ARE **IMPORTED** FROM `lib/csv.ts`, NOT DEFINED HERE.
 *
 * This file used to carry its own copy of all three, under a header that argued against exactly that —
 * "two implementations of an injection guard means one of them is eventually weaker, and it will be the
 * one nobody re-read" — while being the THIRD such copy in the repository, with nothing anywhere relating
 * them. A `route.ts` may not EXPORT a helper (the generated check in `.next/types/**` fails the build on
 * any export that is not an HTTP handler), but it may freely IMPORT one, exactly as this file already
 * imports `liveSubscriberWhere`. So the guard now lives in one place, will be hardened in one place, and
 * this export — the one whose entire content is attacker-supplied and whose reader is guaranteed to be
 * staff — cannot be the copy that falls behind. Read `lib/csv.ts` before changing anything about the shape
 * of the file this route answers: the BOM, the CRLF and the leading-character class are argued for there.
 */

/** The columns the file carries, in the order they appear. */
const EXPORT_SELECT = {
  email: true,
  emailKey: true,
  status: true,
  source: true,
  sourcePath: true,
  consentText: true,
  consentVersion: true,
  consentAt: true,
  confirmationSentAt: true,
  confirmedAt: true,
  unsubscribedAt: true,
  createdAt: true,
  ipAddress: true,
  userAgent: true,
  id: true,
  /**
   * ⚠ SELECTED BUT NEVER PRINTED, AND IT IS NOT A LEFTOVER.
   *
   * `deletedAt` gets no column — `header` and the `csvRow([...])` below list the columns explicitly, and
   * every row in this file is already `liveSubscriberWhere()`-scoped so the value is always `null` here.
   * It is read for exactly one thing: `isMailableSubscriber(row)` at the foot of the file requires BOTH
   * halves of the mailable test, and its header says why a version taking only the status would be unsafe
   * to hand to any other caller. One field on a query that is already reading fifteen, in exchange for the
   * legal claim in the last row of the file being made by the shared definition rather than by a literal
   * written out here.
   */
  deletedAt: true
  // ⚠ `confirmationToken` and `confirmationExpiresAt` are absent on purpose. See the header.
} as const satisfies Prisma.NewsletterSubscriberSelect;

export const GET = route(async (request: Request) => {
  /**
   * ⚠ `requireCapability`, NOT `requireStudioCapability`, and the difference is not cosmetic.
   *
   * This file is a ROUTE HANDLER even though it sits under `app/studio/`. `requireStudioCapability`
   * calls Next's `forbidden()`, which renders `app/forbidden.tsx` — a page, in answer to a request for a
   * spreadsheet. `requireCapability` throws an `ApiError` that the `route()` wrapper turns into the house
   * JSON 403, which is the right answer to a fetch and the answer a browser will at least display as
   * text rather than as a broken download. The predicate is the SAME one the screen uses; only the shape
   * of the refusal differs.
   *
   * ⚠ AND `middleware.ts` GETS THERE FIRST FOR A SIGNED-OUT VISITOR. Its matcher is
   * `/studio/((?!login$|login/).*)`, which covers this path — so a click with no session is redirected
   * to `/studio/login` as a PAGE before this line ever runs, which is the right answer for a link
   * clicked in a browser. This check is therefore the one that matters for somebody who IS signed in
   * and lacks the rank, and for any request that reaches the handler another way. Both are needed:
   * middleware decides whether there is a session, and only this line knows what the session may read.
   */
  await requireCapability(
    canManageInquiries,
    "The newsletter list needs editor access or higher. An administrator can raise yours."
  );

  /**
   * ⚠ READ WITH `URL`, NOT `parseStudioQuery`, AND THE REASON IS NARROWER THAN IT LOOKS.
   *
   * An earlier version of this comment gave two reasons and both were false, which is worse than giving
   * none — a later reader would have believed them. They are written out here because the true constraint
   * is easy to rediscover wrongly:
   *
   *   • **`parseStudioQuery` does NOT refuse an unknown parameter.** It delegates to `parseQuery`
   *     (lib/studio/crud.ts), which validates against a plain Zod `z.object()`; zod is pinned at `^3.24.1`
   *     and no studio query schema calls `.strict()`, so an unknown key is **stripped**, silently and
   *     harmlessly. `?nonsense=1` would parse fine.
   *   • **An empty parameter never reaches this handler from this application anyway.** The filter form on
   *     `app/studio/subscribers/page.tsx` is a `<form method="get">` and a browser does submit every
   *     control in it including the empty ones — but that form submits to the PAGE, not here. This URL is
   *     assembled by `exportParams`, which calls `.set()` only for a value that is non-empty.
   *
   * What is actually true, and it is a Zod-enum fact rather than an unknown-key one: a schema written the
   * way the inquiries export writes its filters (`z.enum(STATES).optional()`) answers **422** to
   * `?status=`, because the empty string is not a member of the enum and `.optional()` only permits the key
   * to be ABSENT. So a hand-edited or hand-truncated URL — the one shape a person is most likely to
   * produce by deleting a value out of the address bar — would break the export rather than ignore the
   * filter. Everything below is narrowed by MEMBERSHIP instead, so an unrecognised or empty value is
   * DROPPED: the worst outcome is a file that ignores one filter, which the screen's own sentence about
   * what the export contains still describes honestly, against a 422 for a click nobody would call
   * unreasonable.
   *
   * ⚠ IF YOU DO ADOPT THE HELPER, the schema must be all-optional plain strings narrowed by membership
   * after parsing — not `z.enum(...)` — or the failure above comes back.
   */
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, QUERY_MAX);

  const statusParam = (url.searchParams.get("status") ?? "").trim();
  const status = isSubscriberStatus(statusParam) ? statusParam : null;

  const sourceParam = (url.searchParams.get("source") ?? "").trim();
  const source: NewsletterSource | null = (NEWSLETTER_SOURCES as readonly string[]).includes(
    sourceParam
  )
    ? (sourceParam as NewsletterSource)
    : null;

  /**
   * ⚠ ASSEMBLED IN THE SAME ORDER AS THE SCREEN'S, with the shared builders first. `subscriberSearchWhere()`
   * returns an `OR` and nothing else here writes one; if a second `OR` is ever added, both must move
   * inside a single `AND` or the later spread silently replaces the earlier one and the search stops
   * filtering — a bug whose only symptom is an export with too many rows in it.
   */
  const where: Prisma.NewsletterSubscriberWhereInput = {
    ...liveSubscriberWhere(),
    ...(status ? { status } : {}),
    ...(source ? { source } : {}),
    ...(q.length > 0 ? subscriberSearchWhere(q) : {})
  };

  const [rows, total] = await prisma.$transaction([
    prisma.newsletterSubscriber.findMany({
      where,
      select: EXPORT_SELECT,
      // The same total ordering as the screen, so the file reads in the order it was showing.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_EXPORT_ROWS
    }),
    prisma.newsletterSubscriber.count({ where })
  ]);

  /**
   * The header row.
   *
   * ⚠ PLAIN WORDS, and "Status" carries the same labels the screen shows (`SUBSCRIBER_STATUS_LABELS`)
   * rather than the enum. "PENDING" in a spreadsheet is a database value somebody has to be told the
   * meaning of; "Waiting to confirm" is the same fact in language they can act on — and using the shared
   * map means the screen and the file cannot describe a status differently.
   *
   * ⚠ EVERY TIMESTAMP IS LABELLED "(UTC)" AND IS AN ISO STRING. `csvCell` renders a `Date` with
   * `toISOString()`, which is UTC by definition — while the studio screen shows the Centre's own zone.
   * Two readers comparing a screen and a spreadsheet over a row created late in the evening would
   * otherwise see two different dates and conclude one of them was wrong.
   */
  const header = [
    "Email address (as typed)",
    "Email address (stored, folded)",
    "Status",
    "Signed up from",
    "Page they were on",
    "Signed up (UTC)",
    "Agreed (UTC)",
    "Wording version",
    "What they agreed to",
    "Confirmation link last issued (UTC)",
    "Confirmed (UTC)",
    "Asked to stop (UTC)",
    "Address they signed up from",
    "Browser they signed up with",
    "Record id"
  ];

  let body = csvRow(header);
  for (const row of rows) {
    body += csvRow([
      row.email,
      row.emailKey,
      SUBSCRIBER_STATUS_LABELS[row.status],
      // The stored `source` is free text at the database level (the column has a default and no check),
      // so a row written before the closed list existed — or by hand — may carry something not on it.
      // Falling back to the "other" label keeps the column readable instead of printing an empty cell.
      NEWSLETTER_SOURCE_LABELS[
        (NEWSLETTER_SOURCES as readonly string[]).includes(row.source)
          ? (row.source as NewsletterSource)
          : "other"
      ],
      row.sourcePath,
      row.createdAt,
      row.consentAt,
      row.consentVersion,
      // The sentence they actually read, verbatim. This column is the evidence the whole consent
      // register exists to preserve — see lib/newsletter/consent.ts.
      row.consentText,
      row.confirmationSentAt,
      row.confirmedAt,
      row.unsubscribedAt,
      row.ipAddress,
      row.userAgent,
      row.id
    ]);
  }

  if (total > rows.length) {
    // ⚠ IN THE FILE ITSELF. See the header: whoever opens this may never have seen the screen.
    body += csvRow([
      `This file holds the ${rows.length} most recent of ${total} records matching the filters that were ` +
        `set. The export stops at ${MAX_EXPORT_ROWS} rows — narrow the status, the place they signed up ` +
        "from, or the search, to reach the rest."
    ]);
  }

  /**
   * ⚠ A LINE SAYING WHO MAY ACTUALLY BE MAILED, IN EVERY FILE, EVEN A COMPLETE ONE.
   *
   * This is the one export in the application that somebody may paste into a mail provider, and the
   * single most expensive mistake available in this feature is treating the whole list as an audience:
   * a PENDING address never confirmed and may have been typed by somebody else, and an UNSUBSCRIBED
   * address has explicitly asked to stop. lib/newsletter/subscribers.ts exists so that question has one
   * answer in code; this row is the same answer for a person holding the file.
   *
   * ⚠ `isMailableSubscriber(row)`, NOT `row.status === "CONFIRMED"`. The comment above used to name
   * `mailableSubscriberWhere()` as the single definition of "who may be mailed" while this line kept a
   * private copy of it three words below — the exact defect this repository keeps producing (a comment
   * stating a rule the code does not keep), in the one file whose output somebody may paste into a mail
   * provider. A `where` builder cannot be used here: the figure has to describe the capped, filtered rows
   * that are actually IN this download, which no `count()` can answer. So the shared module grew the same
   * test in row form and this asks it. The day a `BOUNCED` status or a suppression flag is added, both the
   * screen's count and this row move with the definition instead of one of them being forgotten.
   */
  const mailable = rows.filter((row) => isMailableSubscriber(row)).length;
  body += csvRow([
    `Of the ${rows.length} ${rows.length === 1 ? "record" : "records"} above, ${mailable} ` +
      `${mailable === 1 ? "is" : "are"} marked “${SUBSCRIBER_STATUS_LABELS.CONFIRMED}” and only those ` +
      "may be sent a mailing. The rest have either not confirmed their address or have asked to stop, " +
      "and sending to them would be unlawful as well as unwelcome."
  ]);

  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(BOM + body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      // The date is in the NAME as well as in the rows: two exports taken a week apart otherwise sit in a
      // downloads folder as "subscribers.csv" and "subscribers (1).csv", and nobody can tell which is
      // which — which, for a mailing list, decides who gets written to.
      "content-disposition": `attachment; filename="newsletter-subscribers-${stamp}.csv"`,
      // Never cached: it is a snapshot of live personal data, and a proxy holding it would serve one
      // editor's filtered view to the next.
      "cache-control": "no-store, max-age=0"
    }
  });
});
