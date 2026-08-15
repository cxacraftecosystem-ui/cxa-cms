import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { route } from "@/lib/api";
import { citationKey, resolveBibtex } from "@/lib/citation";
import { siteName, siteUrl } from "@/lib/env";
import {
  BIBTEX_EXPORT_CAP,
  bibtexFileName,
  describePublicationFilters,
  parsePublicationFilters,
  publicationOrderBy,
  publicationWhere
} from "@/app/(site)/publications/filters";

/**
 * GET /api/public/publications/export — the current filter set as a BibTeX file.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT PARSES THE QUERY STRING WITH THE SAME FUNCTION THE PAGE USES, and builds its `where` with the
 * same builder. That is the entire point of `app/(site)/publications/filters.ts`: a reader who has
 * narrowed to one year and presses "Download as BibTeX" must not receive the whole corpus, and two
 * independent parsers would eventually disagree about exactly that — silently, because nobody
 * proof-reads a .bib file against the page it came from.
 *
 * THE CAP IS ANNOUNCED IN THE FILE ITSELF. A web page that stops early can say so on screen; a
 * downloaded bibliography is read weeks later, in a LaTeX run, by somebody who never saw the page. So
 * when the export is short of the matches, the first lines of the file say how short and what to do.
 * Lines beginning with `%` are comments to every BibTeX implementation and to biber.
 *
 * DUPLICATE CITATION KEYS ARE REPORTED, NOT REWRITTEN. `citationKey()` is deliberately stable and
 * deliberately does not disambiguate (lib/citation.ts): a suffix invented here would depend on which
 * rows this particular filtered export happened to contain, so the same paper would be `smith2019a`
 * in one download and `smith2019b` in the next — and every `\cite{}` pointing at it would rot. BibTeX
 * keeps the first of a repeated key and warns; the header comment names the collisions so the person
 * who can fix them (by pasting a canonical entry into the record's BibTeX field in the studio) knows
 * they exist.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * No `assertSameOrigin`: this is a GET, it mutates nothing, and the origin check in lib/api.ts
 * returns early for safe methods in any case. Only published, non-deleted rows are ever readable —
 * `publicationWhere` starts from `liveStatusWhere()`.
 */

/**
 * Never prerendered and never cached: the answer depends on the query string AND on which rows are
 * published at this moment. A shared cache entry keyed on the URL would serve one reader's filter set
 * from before an embargo lifted.
 */
export const dynamic = "force-dynamic";

/**
 * Everything a citation needs — the same column list as `lib/sections/resolve.ts`, plus `bibtex`,
 * because `resolveBibtex()` must be able to prefer the stored entry. Narrowing this to "what BibTeX
 * prints" would silently degrade every generated entry: `formatPages`, the venue mapping and the
 * identifier fields all read columns a reader never sees.
 */
const exportSelect = {
  kind: true,
  title: true,
  authorLine: true,
  venue: true,
  publisher: true,
  volume: true,
  issue: true,
  pages: true,
  year: true,
  month: true,
  doi: true,
  isbn: true,
  issn: true,
  patentNumber: true,
  arxivId: true,
  url: true,
  bibtex: true,
  keywords: true
} satisfies Prisma.PublicationSelect;

/** One `%` comment line per input line, so a multi-line note cannot break out of the comment. */
function comment(lines: readonly string[]): string[] {
  return lines.flatMap((line) => line.split("\n").map((part) => `% ${part}`.trimEnd()));
}

export const GET = route(async (request: Request) => {
  const filters = parsePublicationFilters(new URL(request.url).searchParams);
  const where = publicationWhere(filters);
  const now = new Date();

  // The count and the page are two queries on purpose. `take: CAP + 1` would tell us only that there
  // is at least one more; the reader is owed the real number of matches so the note can say how many
  // are missing rather than "there are more".
  const [matched, rows] = await Promise.all([
    prisma.publication.count({ where }),
    prisma.publication.findMany({
      where,
      orderBy: publicationOrderBy(filters.sort),
      take: BIBTEX_EXPORT_CAP,
      select: exportSelect
    })
  ]);

  const omitted = Math.max(0, matched - rows.length);

  // Counted before anything is written, so the header can state the total. A Map of key → count
  // rather than a Set, because "which keys repeat" is the useful half of the message.
  const keyCounts = new Map<string, number>();
  for (const row of rows) {
    const key = citationKey(row);
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }
  const repeated = [...keyCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
    .sort();

  const header: string[] = [
    `${siteName()} — publications export`,
    `Generated ${now.toISOString()} from ${siteUrl()}/publications`,
    "",
    ...describePublicationFilters(filters),
    `entries in this file: ${rows.length}`,
    `publications matching these filters: ${matched}`
  ];

  if (omitted > 0) {
    header.push(
      "",
      `THIS EXPORT IS INCOMPLETE. It stops at ${BIBTEX_EXPORT_CAP} entries, so ${omitted} of the ` +
        `${matched} matching ${omitted === 1 ? "publication is" : "publications are"} NOT in this file.`,
      "Narrow the filters on the publications page and download again to get the rest."
    );
  }

  if (repeated.length > 0) {
    header.push(
      "",
      `${repeated.length} citation ${repeated.length === 1 ? "key is" : "keys are"} used by more than ` +
        "one entry below. BibTeX keeps only the first entry for a repeated key and warns about the rest, " +
        "so those references will be missing from a bibliography built from this file as it stands.",
      `Repeated: ${repeated.join(", ")}`
    );
  }

  const body =
    rows.length === 0
      ? [
          ...comment(header),
          "",
          ...comment([
            "No publications match these filters, so this file holds no entries. That is the answer,",
            "not a failure: try removing a filter on the publications page."
          ])
        ].join("\n")
      : [...comment(header), "", ...rows.map((row) => resolveBibtex(row))].join("\n\n");

  return new NextResponse(`${body}\n`, {
    status: 200,
    headers: {
      // `text/plain` rather than `application/x-bibtex`: the reader who opens it instead of saving it
      // gets readable text in every browser, and every reference manager sniffs the content anyway.
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${bibtexFileName(filters, now)}"`,
      // Publication state is resolved at read time (lib/content.ts). A cached export would keep
      // answering with the corpus as it stood before something was published or retired.
      "Cache-Control": "no-store"
    }
  });
});
