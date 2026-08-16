/**
 * PublicationListSection — a dense reference list, not a grid of cards.
 *
 * A publication is read as a CITATION: authors, then title, then where it appeared, then the year.
 * Cards would give each one a photograph-shaped hole and fit four to a screen; a list fits twenty and
 * is the shape an academic reader is already scanning for. So this block does not use `EntityCard`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE PUNCTUATION IS DELEGATED. `publicationDisplayVenue` and `formatCitation` in lib/citation.ts own
 * every stop, comma and dash, because in an academic setting a citation with the wrong punctuation
 * reads as carelessness about the source itself. Nothing here re-assembles a reference by hand.
 *
 * "Cite" IS A `<details>`, WHICH NEEDS NO JAVASCRIPT. It keeps this a Server Component, the revealed
 * text is real selectable text a reader can copy, and `<summary>` is a native disclosure control with
 * its own keyboard behaviour and its own announcement. A copy-to-clipboard button would ship a client
 * component to every publications page on the site to save one keystroke.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE STICKY YEAR APPEARS ONLY ON A LONG LIST. Below the threshold the years are all on screen at
 * once and a sticky label is chrome that earns nothing. It sits at `--nav-clearance` because the site
 * header is fixed above it, and at `z-10` — the ladder's rung for sticky in-page chrome (contract §6).
 * Never invent a rung, and never let page chrome exceed the header's 50.
 *
 * YEARS APPEAR IN THE ORDER THEY ARE FIRST SEEN, not sorted. In `latest` mode the rows already arrive
 * newest-first, so the groups come out descending on their own; in `manual` mode the editor's
 * arrangement decides, which is the only reading of a hand-curated list that respects it.
 */

import Link from "next/link";
import type { PageSection, PublicationKind } from "@prisma/client";
import { ArrowRight, BookOpen, ExternalLink, FileDown } from "lucide-react";

import { Reveal } from "@/components/motion/Reveal";
import { SectionHeading } from "@/components/site/SectionHeading";
import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatCitation, publicationDisplayVenue } from "@/lib/citation";
import {
  pickShowcase,
  type PublicationRow,
  type ResolvedSectionData
} from "@/lib/sections/resolve";
import type { PublicationListSectionData } from "@/lib/sections/schema";
import { cn, truncateWords } from "@/lib/utils";

export interface PublicationListSectionProps {
  data: PublicationListSectionData;
  section: PageSection;
  /** The whole batched read from `lib/sections/resolve.ts`; this block's rows are pulled out by id. */
  resolved?: ResolvedSectionData;
  /** The rows directly, for a studio preview or a bespoke page. Wins over `resolved` when given. */
  rows?: PublicationRow[];
  total?: number;
  droppedIds?: number;
}

/** The words a reader uses. The chip carries the kind so the title does not have to. */
const KIND_LABEL: Record<PublicationKind, string> = {
  JOURNAL_ARTICLE: "Journal article",
  CONFERENCE_PAPER: "Conference paper",
  BOOK: "Book",
  BOOK_CHAPTER: "Book chapter",
  PATENT: "Patent",
  DATASET: "Dataset",
  SOFTWARE: "Software",
  PREPRINT: "Preprint",
  THESIS: "Thesis",
  REPORT: "Report",
  FLYER: "Flyer",
  BOOKLET: "Booklet"
};

/** Above this many rows the year labels are worth sticking. See the header. */
const STICKY_THRESHOLD = 12;

/**
 * A DOI in whatever shape it was stored, as a resolvable URL.
 *
 * Editors paste DOIs three ways — bare, as a doi.org URL, and with a "doi:" prefix — and trusting the
 * column produces `https://doi.org/https://doi.org/10.1234/x`. lib/citation.ts normalises the same
 * three shapes for the same reason; it does not export the helper, so this is the one line of it that
 * an `href` needs.
 */
function doiHref(raw: string | null): string | null {
  const value = raw?.trim() ?? "";
  if (!value) return null;
  const bare = value.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").trim();
  return bare ? `https://doi.org/${bare}` : null;
}

interface YearGroup {
  year: number;
  rows: PublicationRow[];
}

/** Bucket by year, keeping the years in the order the rows arrived in. See the header. */
function groupByYear(rows: readonly PublicationRow[]): YearGroup[] {
  const groups: YearGroup[] = [];
  const index = new Map<number, YearGroup>();
  for (const row of rows) {
    const existing = index.get(row.year);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    const group: YearGroup = { year: row.year, rows: [row] };
    index.set(row.year, group);
    groups.push(group);
  }
  return groups;
}

export function PublicationListSection({
  data,
  section,
  resolved,
  rows: given,
  total: givenTotal,
  droppedIds: givenDropped
}: PublicationListSectionProps) {
  const { rows, total: matched, droppedIds } = pickShowcase(resolved?.publications, section.id, {
    rows: given,
    total: givenTotal,
    droppedIds: givenDropped
  });

  const heading = data.heading.trim();
  const eyebrow = data.eyebrow.trim();
  const body = data.body.trim();
  const label = data.ctaLabel.trim();
  const href = data.ctaHref.trim();
  const link = label && href ? { href, label } : undefined;
  const showsHeader = Boolean(heading || eyebrow || body || link);
  const hidden = Math.max(0, matched - rows.length);

  const grouped = data.groupByYear && rows.length > 0;
  const sticky = grouped && rows.length > STICKY_THRESHOLD;
  const groups = grouped ? groupByYear(rows) : [];
  // Grouped, the year owns an <h3> and the titles sit under it at 4. Ungrouped, the titles sit
  // directly under the block's <h2>. Heading levels never skip (contract §11).
  const titleLevel = grouped ? 4 : 3;

  return (
    <section id={`block-${section.id}`} className="py-20 md:py-28">
      <div className="shell">
        <Reveal>
          <SectionHeading
            eyebrow={eyebrow || undefined}
            title={heading || "Publications"}
            titleClassName={heading ? undefined : "sr-only"}
            description={body || undefined}
            // ⚠ Withheld when the heading is off screen: `SectionHeading` gates its trailing link on
            // the link alone, so an `sr-only` title still paints it — and the row below would draw
            // the same call to action a second time. Exactly one of the two ever renders.
            link={heading ? link : undefined}
          />
        </Reveal>

        <div className={showsHeader ? "mt-12" : undefined}>
          {rows.length === 0 ? (
            <EmptyState
              icon={BookOpen}
              title={
                data.kind
                  ? `No ${KIND_LABEL[data.kind].toLowerCase()}s to show yet`
                  : "No publications to show yet"
              }
              description="Publications appear here once they are published in the studio."
              headingLevel={3}
            />
          ) : grouped ? (
            groups.map((group) => (
              <section key={group.year} className="mt-10 first:mt-0">
                <h3
                  className={cn(
                    "display-title border-b border-line-200 pb-2 text-sm font-semibold uppercase tracking-[0.14em] text-ink-500",
                    // z-10 is the ladder's rung for sticky in-page chrome; the offset is the header
                    // clearance contract, never a hand-picked number (contract §6, §7).
                    sticky ? "sticky top-[var(--nav-clearance)] z-10 bg-bg-0" : undefined
                  )}
                >
                  {group.year}
                </h3>
                <ul className="divide-y divide-line-200">
                  {group.rows.map((row) => (
                    <PublicationRowItem
                      key={row.id}
                      row={row}
                      titleLevel={titleLevel}
                      showAbstract={data.showAbstract}
                      showYear={false}
                    />
                  ))}
                </ul>
              </section>
            ))
          ) : (
            <ul className="divide-y divide-line-200 border-t border-line-200">
              {rows.map((row) => (
                <PublicationRowItem
                  key={row.id}
                  row={row}
                  titleLevel={titleLevel}
                  showAbstract={data.showAbstract}
                  showYear
                />
              ))}
            </ul>
          )}
        </div>

        <ShowcaseNote hidden={hidden} matched={matched} dropped={droppedIds} link={link} />

        {/* The CTA's one copy when the heading is off screen — see the note beside `SectionHeading`. */}
        {!heading && link ? (
          <div className="mt-10">
            <LinkButton href={link.href} variant="secondary" icon={ArrowRight} iconPosition="end">
              {link.label}
            </LinkButton>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function PublicationRowItem({
  row,
  titleLevel,
  showAbstract,
  showYear
}: {
  row: PublicationRow;
  titleLevel: 3 | 4;
  showAbstract: boolean;
  /** Off inside a year group, where the heading above already says it. */
  showYear: boolean;
}) {
  const venue = publicationDisplayVenue(row);
  const doi = doiHref(row.doi);
  const external = doi ?? row.url?.trim() ?? null;
  const titleClass =
    "display-title text-balance text-base leading-snug transition-colors hover:text-purple-700";

  // Rendered as two explicit branches rather than a computed tag: a dynamic `ElementType` here makes
  // TypeScript intersect the props of every heading element and collapse `children` to `never`.
  const titleLink = (
    <Link href={`/publications/${row.slug}`} className={titleClass}>
      {row.title}
    </Link>
  );

  return (
    <li className="py-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Badge size="sm">{KIND_LABEL[row.kind]}</Badge>
        {showYear ? <span className="text-xs tabular-nums text-ink-500">{row.year}</span> : null}
      </div>

      {titleLevel === 3 ? (
        <h3 className="mt-2">{titleLink}</h3>
      ) : (
        <h4 className="mt-2">{titleLink}</h4>
      )}

      {/* The authoritative author line, exactly as printed. It is never rebuilt from the linked
          people: `PublicationAuthor` holds only the Centre's own authors, so deriving the line from
          it would drop every external co-author and misattribute the work. */}
      <p className="mt-1.5 text-sm leading-relaxed text-ink-700">{row.authorLine}</p>

      {venue ? <p className="mt-1 text-sm text-ink-500">{venue}</p> : null}

      {showAbstract && row.abstract?.trim() ? (
        <p className="prose-measure mt-3 text-sm leading-relaxed text-ink-500">
          {/* Truncated on the SERVER: a CSS line clamp hides text from sighted readers while leaving
              it in the accessibility tree, so the two disagree about what the row says. */}
          {truncateWords(row.abstract, 320)}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        {external ? (
          <a
            href={external}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-medium text-purple-700 transition-colors hover:text-purple-800"
          >
            <ExternalLink aria-hidden="true" className="h-4 w-4" />
            {doi ? "DOI" : "View"}
            <span className="sr-only"> for {row.title} (opens in a new tab)</span>
          </a>
        ) : null}

        {row.pdfSlug ? (
          // A plain <a>, never `next/link`: the destination is an API route that answers with a file
          // and records the download server-side. Routing it through the client router would ask for
          // an RSC payload from something that returns a PDF. The count is kept there rather than by
          // a client beacon, which an ad blocker eats.
          <a
            href={`/api/public/files/${row.pdfSlug}`}
            className="inline-flex items-center gap-1.5 font-medium text-purple-700 transition-colors hover:text-purple-800"
          >
            <FileDown aria-hidden="true" className="h-4 w-4" />
            PDF
            <span className="sr-only"> of {row.title}</span>
          </a>
        ) : null}

        <details className="min-w-0 basis-full">
          <summary className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-ink-500 transition-colors hover:text-purple-700">
            Cite this
          </summary>
          <p className="mt-2 rounded-md border border-line-200 bg-surface-50 p-3 font-mono text-xs leading-relaxed text-ink-700">
            {formatCitation(row, "apa")}
          </p>
        </details>
      </div>
    </li>
  );
}

/** The honest footnote — contract §1.6. */
function ShowcaseNote({
  hidden,
  matched,
  dropped,
  link
}: {
  hidden: number;
  matched: number;
  dropped: number;
  link?: { href: string; label: string };
}) {
  if (hidden === 0 && dropped === 0) return null;

  return (
    <p className="mt-8 text-sm text-ink-500">
      {hidden > 0 ? (
        <>
          Showing {matched - hidden} of {matched} publications.{" "}
          {link ? (
            <Link href={link.href} className="font-medium text-purple-700 hover:text-purple-800">
              {link.label}
            </Link>
          ) : null}
        </>
      ) : null}
      {dropped > 0 ? (
        <>
          {hidden > 0 ? " " : null}
          {dropped} chosen {dropped === 1 ? "publication is" : "publications are"} no longer published
          and {dropped === 1 ? "is" : "are"} not shown.
        </>
      ) : null}
    </p>
  );
}
