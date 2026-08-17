import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { BookOpen, ExternalLink, FileDown, Users } from "lucide-react";

import { CitationBlock } from "@/components/site/CitationBlock";
import {
  DefinitionList,
  hasVisibleDefinitions,
  type DefinitionItem
} from "@/components/site/DefinitionList";
import { PageHero } from "@/components/site/PageHero";
import { houseProseTypeset } from "@/components/site/ProseArticle";
import { SectionHeading } from "@/components/site/SectionHeading";
import { DocumentFrame } from "@/components/site/DocumentFrame";
import { TagList } from "@/components/site/TagList";
import { LinkButton } from "@/components/ui/Button";
import { publicationDisplayVenue, resolveBibtex } from "@/lib/citation";
import { liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { pageMetadata, scholarlyArticleJsonLd, serializeJsonLd } from "@/lib/seo";
import { getSettingCached } from "@/lib/settings/service";
import { typesetClassName, typesetFaceClassName } from "@/lib/typography/typeset";
import { cn, formatBytes, truncateWords } from "@/lib/utils";

import {
  bareDoi,
  buildCitations,
  doiUrl,
  PUBLICATION_KIND_LABELS,
  publicationsHref,
  parsePublicationFilters
} from "../filters";

/**
 * /publications/[slug] — one publication, in full.
 *
 * A SERVER COMPONENT. The only client piece is `CitationBlock`, and it receives four ready-made
 * strings rather than the row, so lib/citation.ts never reaches the browser (see the note there).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE AUTHOR LINE IS PRINTED VERBATIM AND THE CENTRE'S AUTHORS ARE LINKED SEPARATELY.
 *
 * `Publication.authorLine` is the authoritative author string, in order, exactly as printed;
 * `PublicationAuthor` links only the subset who are Centre people (prisma/schema.prisma). So the line
 * itself is rendered as text and is never rebuilt from the links — that would drop every external
 * co-author and misattribute the work — and the profiles are offered as their own list beside it.
 *
 * The tempting alternative, hyperlinking matched names inside the line, is a string-matching problem
 * with no safe answer: two researchers who share a surname, an initialised given name, or a name that
 * also appears in the title would all mislink, and a citation that credits the wrong person is worse
 * than one that credits nobody in particular.
 *
 * `features.publications` GATES THE WHOLE SURFACE — with it off, the index and every citation page are
 * 404, matching what the setting promises in lib/settings/schema.ts. The records themselves are
 * untouched.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `revalidate` IS SET DELIBERATELY. This page reads no request-scoped input, so without it Next would
 * render it once on first request and serve that copy for the life of the deployment — a retracted or
 * corrected reference would keep being cited from a page nobody could change. Publication state is
 * resolved at read time (lib/content.ts), so the window below is also the longest anything here can be
 * stale.
 */

/** Five minutes. Long enough to be worth caching, short enough that a retraction takes effect. */
export const revalidate = 300;

/** How many related publications are offered. Enough to be useful, few enough to scan. */
const RELATED_CAP = 6;

const publicationSelect = {
  id: true,
  slug: true,
  kind: true,
  title: true,
  abstract: true,
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
  keywords: true,
  pdfFileId: true,
  researchAreaId: true,
  publishedAt: true,
  updatedAt: true,
  researchArea: { select: { slug: true, title: true } },
  // Only projects that are themselves published: a fact panel that links to a 404 is worse than one
  // that leaves the row out.
  projects: {
    where: liveStatusWhere(),
    orderBy: { title: "asc" },
    select: { slug: true, title: true }
  },
  /**
   * The Centre's own authors, in printed order.
   *
   * Filtered to profiles that are live AND visible, because these become links: an author whose profile
   * is a draft stays in the `authorLine` above (which is the record of who wrote the paper) but is not
   * offered as a destination that would 404.
   */
  authors: {
    where: { person: { ...liveStatusWhere(), isVisible: true } },
    orderBy: { position: "asc" },
    select: {
      position: true,
      person: { select: { slug: true, name: true, designation: true } }
    }
  }
} satisfies Prisma.PublicationSelect;

/** Memoised for ONE request, so `generateMetadata` and the page body share a single query. */
const loadPublication = cache(async (slug: string) => {
  return prisma.publication.findFirst({
    where: { ...liveStatusWhere(), slug },
    select: publicationSelect
  });
});

/** Month names, so "March 2024" reads as a date rather than as "2024-03". */
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
] as const;

/** "March 2024", or just the year. `month` is 1-based in the schema and may be absent or nonsense. */
function publishedLabel(publication: { year: number; month: number | null }): string {
  const index = typeof publication.month === "number" ? Math.trunc(publication.month) - 1 : -1;
  const name = index >= 0 && index < MONTHS.length ? MONTHS[index] : undefined;
  return name ? `${name} ${publication.year}` : String(publication.year);
}

export async function generateMetadata({
  params
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const publication = await loadPublication(slug);

  if (!publication) {
    // Not `notFound()`: this function only produces `<head>`, and throwing here would replace the
    // page's own 404 with a metadata error.
    return pageMetadata({
      title: "Publication not found",
      description: "This publication is not available.",
      path: `/publications/${slug}`,
      noIndex: true
    });
  }

  return pageMetadata({
    title: publication.title,
    description: publication.abstract?.trim()
      ? publication.abstract
      : `${publication.authorLine} (${publication.year}). ${publicationDisplayVenue(publication) ?? PUBLICATION_KIND_LABELS[publication.kind]}.`,
    path: `/publications/${publication.slug}`,
    type: "article",
    publishedTime: publication.publishedAt,
    modifiedTime: publication.updatedAt,
    authors: [publication.authorLine],
    keywords: publication.keywords
  });
}

export default async function PublicationPage({
  params
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const features = await getSettingCached("features");
  // The flag gates the ROUTE, not merely the navigation entry — see the note on the index page.
  if (!features.publications) notFound();

  const publication = await loadPublication(slug);
  if (!publication) notFound();

  const relatedWhere: Prisma.PublicationWhereInput | null = publication.researchAreaId
    ? {
        ...liveStatusWhere(),
        researchAreaId: publication.researchAreaId,
        id: { not: publication.id }
      }
    : null;

  const now = new Date();

  const [pdf, related, relatedTotal] = await Promise.all([
    // `Publication.pdfFileId` is a bare `String?` with no `@relation`, so it cannot be joined. The
    // predicate here is the same one `/api/public/files/[slug]` enforces — hiding the link is not the
    // access control (contract §1.7), it only stops the page offering a download that would be refused.
    publication.pdfFileId
      ? prisma.fileAsset.findFirst({
          where: {
            id: publication.pdfFileId,
            deletedAt: null,
            isPublic: true,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
          },
          select: {
            slug: true,
            title: true,
            /**
             * The latest version, so the page can say whether a browser can DRAW this document.
             *
             * `mimeType` answers it for a PDF; `previewObjectKey` answers it for a `.docx` or a `.pptx`
             * somebody has converted (app/api/studio/files/[id]/preview/route.ts). Either one means the
             * document is framed below; neither means it stays a download, which is still offered in
             * both cases. `byteSize` is what the download link's own words carry, so nobody starts a
             * 40 MB transfer on a phone by accident.
             */
            versions: {
              orderBy: { version: "desc" },
              take: 1,
              select: { mimeType: true, byteSize: true, previewObjectKey: true, previewByteSize: true }
            }
          }
        })
      : Promise.resolve(null),
    relatedWhere
      ? prisma.publication.findMany({
          where: relatedWhere,
          orderBy: [{ year: "desc" }, { title: "asc" }, { id: "asc" }],
          take: RELATED_CAP,
          select: {
            id: true,
            slug: true,
            kind: true,
            title: true,
            authorLine: true,
            venue: true,
            publisher: true,
            volume: true,
            issue: true,
            year: true,
            patentNumber: true,
            arxivId: true
          }
        })
      : Promise.resolve([]),
    relatedWhere ? prisma.publication.count({ where: relatedWhere }) : Promise.resolve(0)
  ]);

  const doi = doiUrl(publication.doi);
  const arxiv = publication.arxivId?.trim().replace(/^arxiv:\s*/i, "") ?? "";
  const venue = publicationDisplayVenue(publication);
  const citations = buildCitations(publication);
  const bibtex = resolveBibtex(publication);
  const keywords = publication.keywords.filter((keyword) => keyword.trim().length > 0);

  /**
   * THE HOUSE TYPESETTING, RESOLVED ONCE FOR THIS PAGE.
   *
   * `houseProseTypeset()` is the public site's ONE resolved reader of the `typography` settings group
   * (components/site/ProseArticle.tsx). It is `cache()`-wrapped underneath, so reading it here costs no
   * query on a page that has already read the group, and it is awaited once here rather than twice
   * because the abstract below and the citation panel beside it must not be able to disagree about what
   * the house reading face is.
   *
   * `width` is left at its `narrow` default: this page has a real reading column, not a full-bleed one.
   */
  const typeset = await houseProseTypeset();
  const readingFace = typesetFaceClassName(typeset);
  // `PublicationAuthor.person` is a required relation, and the `where` above already dropped every row
  // whose person is not live and visible — so this is the ordered list of linkable Centre authors.
  const centreAuthors = publication.authors.map((entry) => entry.person);

  /**
   * The filter set that shows everything in this research area.
   *
   * Built through `parsePublicationFilters` rather than by concatenating a query string by hand, so the
   * link cannot drift from what the listing will actually read — the same reason the export route
   * shares the parser.
   */
  const areaHref = publication.researchArea
    ? publicationsHref(parsePublicationFilters({ area: publication.researchArea.slug }))
    : null;

  const details: DefinitionItem[] = [
    { term: "Type", value: PUBLICATION_KIND_LABELS[publication.kind] },
    { term: "Published", value: publishedLabel(publication) },
    { term: publication.kind === "BOOK_CHAPTER" ? "In" : "Venue", value: publication.venue },
    { term: "Publisher", value: publication.publisher },
    { term: "Volume", value: publication.volume },
    { term: "Issue", value: publication.issue },
    { term: "Pages", value: publication.pages },
    { term: "DOI", value: bareDoi(publication.doi), href: doi ?? undefined },
    {
      term: "arXiv",
      value: arxiv ? `arXiv:${arxiv}` : null,
      href: arxiv ? `https://arxiv.org/abs/${arxiv}` : undefined
    },
    { term: "ISBN", value: publication.isbn },
    { term: "ISSN", value: publication.issn },
    { term: "Patent number", value: publication.patentNumber },
    {
      term: "Research area",
      value: publication.researchArea?.title ?? null,
      href: publication.researchArea ? `/research/${publication.researchArea.slug}` : undefined
    },
    {
      term: publication.projects.length === 1 ? "Project" : "Projects",
      value:
        publication.projects.length > 0 ? (
          <span className="flex flex-col gap-1">
            {publication.projects.map((project) => (
              <Link
                key={project.slug}
                href={`/projects/${project.slug}`}
                className="rounded text-purple-700 underline decoration-purple-300 underline-offset-2 transition-colors hover:decoration-purple-700 dark:text-purple-300 dark:decoration-purple-300/50"
              >
                {project.title}
              </Link>
            ))}
          </span>
        ) : null
    },
    {
      term: "Publisher link",
      // Only when it is not already the DOI: two links to the same place is one link too many.
      value: !doi && publication.url?.trim() ? publication.url.trim() : null,
      href: !doi && publication.url?.trim() ? publication.url.trim() : undefined
    }
  ];

  const jsonLd = scholarlyArticleJsonLd({
    title: publication.title,
    authorLine: publication.authorLine,
    year: publication.year,
    venue: publication.venue,
    // The BARE identifier: the helper adds the `https://doi.org/` resolver itself, so passing a full
    // URL here would produce `https://doi.org/https://doi.org/…` (lib/seo.ts).
    doi: bareDoi(publication.doi),
    path: `/publications/${publication.slug}`
  });

  /**
   * Can a browser DRAW this document, or only save it?
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * ⚠ THE PDF USED TO BE A LINK AND NOTHING ELSE, which is a strange thing to offer on the page whose
   * whole subject is one document: a reader wanting to know whether this is the paper they need had to
   * download it to find out. It is framed now when it can be, and the LINK IS STILL RENDERED IN EVERY
   * CASE — for a reader whose PDF viewer is switched off, for one using a screen reader (for whom a
   * document opened in its own tab is measurably better than one nested in a page), and for anyone who
   * wants the file rather than a look at it.
   *
   * TWO WAYS TO BE DRAWABLE, and they are not the same fact. A PDF is drawable as it stands. Anything
   * else — a `.docx` full text, a `.pptx` of slides — is drawable only if somebody has made a PDF
   * preview of it in the studio, because no browser renders those. `previewByteSize` is what the frame
   * would actually fetch, so it is what the reader is told about; `byteSize` is the original, which is
   * what the DOWNLOAD gives them. Reporting one number for both would understate a 4 MB deck as its
   * 600 KB preview or the reverse.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  const pdfVersion = pdf?.versions[0] ?? null;
  const pdfFramable =
    pdfVersion !== null &&
    (pdfVersion.previewObjectKey !== null || pdfVersion.mimeType.toLowerCase() === "application/pdf");
  const pdfIsConverted = pdfVersion?.previewObjectKey !== null && pdfVersion?.previewObjectKey !== undefined;

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />

      <PageHero
        eyebrow={PUBLICATION_KIND_LABELS[publication.kind]}
        title={publication.title}
        // The authoritative author line, verbatim. See the header.
        description={publication.authorLine}
        meta={
          <>
            <span className="tabular-nums">{publishedLabel(publication)}</span>
            {venue ? <span>{venue}</span> : null}
          </>
        }
        actions={
          <>
            {doi ? (
              <LinkButton href={doi} icon={ExternalLink} newTab>
                View at the publisher
              </LinkButton>
            ) : publication.url?.trim() ? (
              <LinkButton href={publication.url.trim()} icon={ExternalLink} newTab>
                View at the publisher
              </LinkButton>
            ) : null}

            {pdf ? (
              // A plain <a>, never `next/link` or `LinkButton`: the destination is an API route that
              // answers with a file and counts the download server-side. Routing it through the client
              // router would ask for an RSC payload from something that returns a PDF.
              <a href={`/api/public/files/${pdf.slug}`} className="field-button-secondary">
                <FileDown aria-hidden="true" className="h-4 w-4 shrink-0" />
                {/*
                  THE WORDS CARRY THE SIZE, so nobody starts a 40 MB transfer on a phone by accident —
                  the rule `DownloadsSection` states for the file store. It is the ORIGINAL's size, which
                  is what this link gives, and deliberately not the preview's: the frame below reports
                  its own.
                */}
                <span>
                  Download the full text
                  {pdfVersion ? ` (${formatBytes(pdfVersion.byteSize)})` : ""}
                </span>
              </a>
            ) : null}
          </>
        }
        breadcrumbs={[
          { name: "Home", href: "/" },
          { name: "Publications", href: "/publications" },
          { name: truncateWords(publication.title, 60), href: `/publications/${publication.slug}` }
        ]}
      />

      <div className="shell grid gap-14 pb-24 sm:pb-32 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-16">
        <div className="flex flex-col gap-16">
          {publication.abstract?.trim() ? (
            <section>
              <SectionHeading title="Abstract" level={2} />
              {/*
                ══════════════════════════════════════════════════════════════════════════════════
                THE ABSTRACT IS THE LONGEST PASSAGE OF PROSE ON THIS PAGE, AND IT WAS THE ONLY ONE ON
                THE SITE SET IN THE INTERFACE FACE. It was
                `prose-measure mt-6 whitespace-pre-line text-base leading-7 text-ink-700`: Inter, at a
                fixed 16px over 1.75, on a page whose sibling articles are set in Source Serif 4 at the
                house reading size. Two hundred words of dense academic prose is exactly the material
                the reading face exists for, and this was the one place it never arrived.

                IT TAKES THE WHOLE RECIPE, NOT JUST THE FACE, AND THE ARITHMETIC IS WHY. The obvious
                move is `typesetFaceClassName(typeset)` on the paragraph — that is what
                ProseArticle's header recommends for a stray paragraph, and for a one-line citation it
                is right. It is not right here, because the house style has TWELVE settable dimensions
                and a lone `<p>` outside a `.prose-typeset` box can only receive one of them:
                `.ts-size-*` and `.ts-lead-*` re-point `--prose-size` and `--prose-leading`, and the
                only rules that READ those variables are `.prose-typeset :is(p, li)` and its
                neighbours. Put `ts-size-large` on a bare paragraph and it sets a custom property
                nobody reads — a control in Settings that visibly does nothing (contract §1.6). So the
                passage goes inside a real document box and the reading size, leading, face,
                `text-wrap: pretty`, hanging punctuation and `overflow-wrap` all reach it.

                ⚠ AND THE THREE THINGS A DOCUMENT BOX COULD DO TO A SINGLE PARAGRAPH, EACH CHECKED
                  AGAINST THE SELECTOR RATHER THAN HOPED ABOUT:
                   • **No drop cap.** `.ts-dropcap > * > p:first-of-type::first-letter` is TWO levels
                     deep by design (globals.css says so: "the first paragraph inside the ONE wrapper
                     RichText renders"). This `<p>` is a DIRECT child of the box, so the selector does
                     not match it and a house drop cap cannot land on an abstract. ⚠ Wrapping this
                     paragraph in anything would turn that on.
                   • **No stray paragraph margin.** Every space in the recipe is written `* + p`, never
                     a bare margin, so a first child has nothing to be spaced from. The `mt-6` on the
                     box is this page's own rhythm and is untouched.
                   • **No first-line indent.** `.ts-para-indented p + p` needs a preceding sibling
                     paragraph. There is one paragraph, so an "indented" house style leaves it flush —
                     which is also how a book sets its first paragraph.

                `whitespace-pre-line` STAYS: `Publication.abstract` is a plain `String` and an author's
                paragraph breaks are the only structure it has. ⚠ It is still ONE `<p>`, so a blank
                line inside it is a line break rather than a new paragraph — `--prose-gap` is inert
                here and no CSS in the recipe can change that. `text-ink-700` also stays, and mirrors
                the root `<div>` RichText itself wears; the recipe sets no colour at all, on purpose,
                because every rung has to come from the ink ladder to invert (contract §1.2).

                ⚠ `text-base leading-7` ARE GONE RATHER THAN OVERRIDDEN. They are utilities on the
                  element, (0,1,0); `.prose-typeset :is(p, li)` is (0,1,1) and would beat them wherever
                  it is emitted. Leaving them would be two numbers claiming to set one size, with the
                  losing one written down where the next reader would believe it.

                The "Abstract" heading takes no `sectionHeadingWrapClass()`: it is one word and can
                never wrap, so the class would be provably inert.
                ══════════════════════════════════════════════════════════════════════════════════
              */}
              <div className={cn(typesetClassName(typeset), "mt-6 text-ink-700")}>
                <p className="whitespace-pre-line">{publication.abstract.trim()}</p>
              </div>
            </section>
          ) : null}

          {pdfFramable && pdf ? (
            <section>
              <SectionHeading
                title="The full text"
                level={2}
                description={
                  pdfIsConverted
                    ? "Shown as a PDF made from the uploaded document. The original is what the download gives you."
                    : "Shown here in full. It scrolls inside its own frame, and the download above gives you the file itself."
                }
              />
              <DocumentFrame
                className="mt-6"
                src={`/api/public/files/${encodeURIComponent(pdf.slug)}/inline`}
                /*
                  ⚠ NAMED AFTER THE PUBLICATION, because the frame's title is the ONLY description a
                  screen reader gets — an untitled frame is announced as "frame". `pdf.title` is the
                  file's own name in the library, which is often a filename; the publication's title is
                  what the reader came for.
                */
                title={`The full text of “${publication.title}”`}
                // Taller than the default: this is the page's subject rather than one block on it.
                height="lg"
              />
            </section>
          ) : null}

          <section>
            <SectionHeading
              title="Cite this publication"
              level={2}
              description="Every style is generated from the record itself, so the text you copy is the text on the page."
            />
            <div className="mt-6">
              {/*
                `layout="all"` lists every style with its own copy button, and the BibTeX entry below
                them — this is the page a reader comes to specifically to take a reference.

                ⚠ `readingFaceClassName` IS RESOLVED HERE BECAUSE IT CANNOT BE RESOLVED THERE.
                `CitationBlock` is a Client Component and the `typography` settings group is read through
                `server-only` code with Prisma behind it, so the face has to cross the boundary as a
                finished class string. It is the SAME `typeset` the abstract above wears, awaited once at
                the top of this component — a citation set in one face beside an abstract set in another
                would be the single most visible way this page could contradict itself.
              */}
              <CitationBlock
                citations={citations}
                bibtex={bibtex}
                label={publication.title}
                layout="all"
                readingFaceClassName={readingFace}
              />
            </div>
          </section>

          {related.length > 0 ? (
            <section>
              <SectionHeading
                title="Related publications"
                level={2}
                description={
                  publication.researchArea
                    ? `More from ${publication.researchArea.title}.`
                    : undefined
                }
                link={
                  areaHref && relatedTotal > related.length
                    ? { href: areaHref, label: `All ${relatedTotal} in this area` }
                    : undefined
                }
              />

              <ul className="mt-6 divide-y divide-line-200 border-t border-line-200">
                {related.map((item) => {
                  const itemVenue = publicationDisplayVenue(item);
                  return (
                    <li key={item.id} className="py-4">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="text-xs font-semibold uppercase tracking-wide text-purple-700">
                          {PUBLICATION_KIND_LABELS[item.kind]}
                        </span>
                        <span className="text-xs tabular-nums text-ink-500">{item.year}</span>
                      </div>
                      <h3 className="mt-1.5">
                        <Link
                          href={`/publications/${item.slug}`}
                          className="display-title text-balance text-base leading-snug transition-colors hover:text-purple-700"
                        >
                          {item.title}
                        </Link>
                      </h3>
                      <p className="mt-1 text-sm leading-relaxed text-ink-500">{item.authorLine}</p>
                      {itemVenue ? (
                        <p className="mt-0.5 text-sm text-ink-500">{itemVenue}</p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>

              {relatedTotal > related.length ? (
                // The cap, stated (contract §1.6). A list of six out of forty must say which it is.
                <p className="mt-5 text-sm text-ink-500">
                  Showing {related.length} of {relatedTotal} other publications in this area.
                  {areaHref ? (
                    <>
                      {" "}
                      <Link
                        href={areaHref}
                        className="font-medium text-purple-700 hover:text-purple-800"
                      >
                        See them all
                      </Link>
                      .
                    </>
                  ) : null}
                </p>
              ) : null}
            </section>
          ) : null}
        </div>

        <aside className="flex flex-col gap-12">
          {hasVisibleDefinitions(details) ? (
            <section>
              <SectionHeading title="Details" level={2} titleClassName="text-xl" />
              <DefinitionList items={details} className="mt-6" />
            </section>
          ) : null}

          {centreAuthors.length > 0 ? (
            <section>
              <SectionHeading
                title={centreAuthors.length === 1 ? "Centre author" : "Centre authors"}
                level={2}
                titleClassName="text-xl"
              />
              <ul className="mt-6 flex flex-col gap-3">
                {centreAuthors.map((person) => (
                  <li key={person.slug}>
                    <Link
                      href={`/people/${person.slug}`}
                      className="group inline-flex items-start gap-2 rounded text-sm"
                    >
                      <Users aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-ink-300" />
                      <span>
                        <span className="font-medium text-ink-900 transition-colors group-hover:text-purple-700">
                          {person.name}
                        </span>
                        {person.designation ? (
                          <span className="block text-xs text-ink-500">{person.designation}</span>
                        ) : null}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              {/* Said plainly, because the author line above is longer than this list and a reader will
                  notice. Only the Centre's own people have profiles to link to. */}
              <p className="mt-4 text-xs leading-relaxed text-ink-500">
                Co-authors from outside the Centre appear in the author line above and have no profile
                here.
              </p>
            </section>
          ) : null}

          {keywords.length > 0 ? (
            <section>
              <SectionHeading title="Keywords" level={2} titleClassName="text-xl" />
              <TagList tags={keywords} label="Keywords" className="mt-6" />
            </section>
          ) : null}

          {!publication.abstract?.trim() ? (
            <p className="flex items-start gap-2.5 rounded-md border border-line-200 bg-surface-50 px-3.5 py-2.5 text-sm leading-relaxed text-ink-700">
              <BookOpen aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" />
              <span>
                No abstract has been recorded for this record. The publisher&rsquo;s page will have
                one.
              </span>
            </p>
          ) : null}
        </aside>
      </div>
    </>
  );
}
