"use client";

/**
 * The publication editor.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE AUTHOR LINE AND THE LINKED PEOPLE ARE TWO DIFFERENT LISTS, AND THE SCREEN SAYS SO TWICE.
 *
 *   • THE AUTHOR LINE is the authoritative printed credit, in order, exactly as it appears on the work.
 *     Every citation on the public site is built from this string and nothing else.
 *   • THE LINKED PEOPLE are the subset of those authors who have a profile at the Centre. Linking one
 *     puts the publication on their profile page and makes it findable by the author filter.
 *
 * Conflating them is the single most damaging mistake available on this screen: an editor who thinks
 * the links ARE the author list links three colleagues, leaves the line blank or trims it to those
 * three, and every external co-author disappears from the citation. That is a misattribution of
 * somebody else's work, published under this institution's name. Hence the wording beside both fields
 * and the parsed-name readout under the line — an editor can see how the line will be read before
 * anybody cites it.
 *
 * THE CITATION PREVIEW IS THE POINT OF THE SCREEN. Four styles, recomputed as you type, from
 * lib/citation.ts — the same functions the public page uses. A metadata mistake shows up here as a
 * wrong citation, which is a thing an academic reader spots instantly, rather than being discovered
 * months later by somebody who copied it.
 *
 * LEAVING BIBTEX EMPTY IS NORMAL, AND THE FIELD SAYS SO. An entry is generated when it is blank; a
 * stored one is kept verbatim, because an imported record carries a canonical citation key that other
 * people's manuscripts already `\cite{}`. Regenerating it would silently break their bibliography.
 *
 * KEYWORDS ARE TYPED AS TEXT, one per line or separated by commas, and the chips under the box show
 * exactly what will be stored. A chip control with its own keyboard rules is a second thing to learn
 * for a field that is a list of words.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ContentStatus, PublicationKind } from "@prisma/client";
import { Quote } from "lucide-react";

import { del, patch, post } from "@/lib/client/fetcher";
import {
  formatCitation,
  generateBibtex,
  parseAuthorLine,
  type CitablePublication,
  type CitationStyle
} from "@/lib/citation";
import { cn, unique } from "@/lib/utils";
import { Field, FieldBlock } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/ToastProvider";
import { DeleteButton } from "@/components/studio/DeleteButton";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";
import { SaveBar } from "@/components/studio/SaveBar";
import { SlugField } from "@/components/studio/SlugField";
import { StatusControl, statusProblems } from "@/components/studio/StatusControl";
import { PUBLISHED_AUTOSAVE_NOTICE, useAutosave } from "@/components/studio/useAutosave";
import { useLeaveGuard } from "@/components/studio/useUnsavedChanges";
import { EntityPicker } from "@/components/studio/fields/EntityPicker";

export interface PublicationFormValue {
  title: string;
  slug: string;
  kind: PublicationKind;
  abstract: string;
  /** The authoritative printed credit. See the header. */
  authorLine: string;
  venue: string;
  publisher: string;
  volume: string;
  issue: string;
  pages: string;
  /** Held as text; a whole number once converted. */
  year: string;
  /** "" or 1–12. */
  month: string;
  doi: string;
  isbn: string;
  issn: string;
  patentNumber: string;
  arxivId: string;
  url: string;
  /** Verbatim BibTeX, or "" to have one generated. See the header. */
  bibtex: string;
  /** One per line or comma-separated. Parsed on the way to the server. */
  keywordsText: string;
  /** Zero or one file from the file store. */
  pdfFileIds: string[];
  researchAreaIds: string[];
  /** Centre people, in printed order. NOT the author line. */
  authorPersonIds: string[];
  isFeatured: boolean;
  status: ContentStatus;
  publishedAt: string | null;
  /**
   * Send the old address to the new one when a published address changes.
   *
   * Defaults to true, and it matters more here than anywhere else in the studio: a publication's
   * address is what appears in somebody else's bibliography, and a citation that stops resolving is a
   * citation that makes this institution look careless. The server ignores it unless the address
   * actually changed on a record that is public.
   */
  createRedirect: boolean;
}

export interface PublicationEditorProps {
  publicationId: string | null;
  initialValue: PublicationFormValue;
  siteUrl: string;
  /** Read-only: the projects this publication is listed on. Managed from the project's own screen. */
  projects: readonly { id: string; title: string }[];
  canPublish: boolean;
  canDelete: boolean;
}

const ENDPOINT = {
  collection: "/api/studio/publications",
  detail: (id: string) => `/api/studio/publications/${encodeURIComponent(id)}`
} as const;

const TITLE_MAX = 400;
const ABSTRACT_MAX = 4000;
const AUTHOR_LINE_MAX = 2000;

/** The oldest and newest year the field will accept. The lower bound is historical scholarship, not a typo. */
const YEAR_MIN = 1;
const YEAR_MAX = 2200;

/**
 * ⚠ A COPY of the labels in `app/(site)/publications/filters.ts`, kept in step by hand — see that
 * file's header for why each surface carries its own. One publication cannot be a "Journal article"
 * here and a "Paper" there.
 */
const KIND_OPTIONS: readonly { value: PublicationKind; label: string }[] = [
  { value: "JOURNAL_ARTICLE", label: "Journal article" },
  { value: "CONFERENCE_PAPER", label: "Conference paper" },
  { value: "BOOK", label: "Book" },
  { value: "BOOK_CHAPTER", label: "Book chapter" },
  { value: "PREPRINT", label: "Preprint" },
  { value: "PATENT", label: "Patent" },
  { value: "DATASET", label: "Dataset" },
  { value: "SOFTWARE", label: "Software" },
  { value: "THESIS", label: "Thesis" },
  { value: "REPORT", label: "Report" }
];

/** What the venue field means for each type, so the label is never a guess. */
const VENUE_LABELS: Record<PublicationKind, string> = {
  JOURNAL_ARTICLE: "Journal",
  CONFERENCE_PAPER: "Conference or proceedings",
  BOOK: "Series, if it is in one",
  BOOK_CHAPTER: "Title of the book it is in",
  PREPRINT: "Preprint server",
  PATENT: "Patent office",
  DATASET: "Repository",
  SOFTWARE: "Repository or registry",
  THESIS: "University or institution",
  REPORT: "Institution"
};

const MONTHS: readonly { value: string; label: string }[] = [
  { value: "1", label: "January" },
  { value: "2", label: "February" },
  { value: "3", label: "March" },
  { value: "4", label: "April" },
  { value: "5", label: "May" },
  { value: "6", label: "June" },
  { value: "7", label: "July" },
  { value: "8", label: "August" },
  { value: "9", label: "September" },
  { value: "10", label: "October" },
  { value: "11", label: "November" },
  { value: "12", label: "December" }
];

const CITATION_STYLES: readonly { style: CitationStyle; label: string }[] = [
  { style: "apa", label: "APA (7th edition)" },
  { style: "mla", label: "MLA (9th edition)" },
  { style: "chicago", label: "Chicago (author–date)" },
  { style: "ieee", label: "IEEE" }
];

function orNull(text: string): string | null {
  const value = text.trim();
  return value.length > 0 ? value : null;
}

/** One per line, or separated by commas. Trimmed, de-duplicated, order preserved. */
function parseList(text: string): string[] {
  return unique(
    text
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  );
}

function toYear(text: string): number | null {
  const value = Number.parseInt(text.trim(), 10);
  if (!Number.isInteger(value)) return null;
  if (value < YEAR_MIN || value > YEAR_MAX) return null;
  return value;
}

/** The shape lib/citation.ts works from. Built from the form so the preview is live. */
function toCitable(value: PublicationFormValue): CitablePublication {
  return {
    kind: value.kind,
    title: value.title,
    authorLine: value.authorLine,
    // A citation of a work with no readable year renders "n.d.", which is the honest answer and is what
    // the preview will show.
    year: toYear(value.year) ?? Number.NaN,
    month: value.month.length > 0 ? Number.parseInt(value.month, 10) : null,
    venue: orNull(value.venue),
    publisher: orNull(value.publisher),
    volume: orNull(value.volume),
    issue: orNull(value.issue),
    pages: orNull(value.pages),
    doi: orNull(value.doi),
    isbn: orNull(value.isbn),
    issn: orNull(value.issn),
    patentNumber: orNull(value.patentNumber),
    arxivId: orNull(value.arxivId),
    url: orNull(value.url),
    bibtex: orNull(value.bibtex),
    keywords: parseList(value.keywordsText)
  };
}

function toPayload(value: PublicationFormValue) {
  return {
    title: value.title.trim(),
    slug: value.slug.trim(),
    kind: value.kind,
    abstract: orNull(value.abstract),
    authorLine: value.authorLine.trim(),
    venue: orNull(value.venue),
    publisher: orNull(value.publisher),
    volume: orNull(value.volume),
    issue: orNull(value.issue),
    pages: orNull(value.pages),
    year: toYear(value.year),
    month: value.month.length > 0 ? Number.parseInt(value.month, 10) : null,
    doi: orNull(value.doi),
    isbn: orNull(value.isbn),
    issn: orNull(value.issn),
    patentNumber: orNull(value.patentNumber),
    arxivId: orNull(value.arxivId),
    url: orNull(value.url),
    // Sent as null when empty, so the column stays empty and lib/citation.ts generates one at read
    // time. Sending a generated entry would freeze today's output into the record for ever.
    bibtex: orNull(value.bibtex),
    keywords: parseList(value.keywordsText),
    pdfFileId: value.pdfFileIds[0] ?? null,
    researchAreaId: value.researchAreaIds[0] ?? null,
    authorIds: value.authorPersonIds,
    isFeatured: value.isFeatured,
    status: value.status,
    createRedirect: value.createRedirect
  };
}

export function PublicationEditor({
  publicationId,
  initialValue,
  siteUrl,
  projects,
  canPublish,
  canDelete
}: PublicationEditorProps) {
  const router = useRouter();
  const { toast } = useToast();

  const [value, setValue] = useState<PublicationFormValue>(initialValue);
  const [saved, setSaved] = useState<PublicationFormValue>(initialValue);
  const createdId = useRef<string | null>(null);

  const isNew = publicationId === null;

  const update = useCallback(
    (next: Partial<PublicationFormValue>) => setValue((current) => ({ ...current, ...next })),
    []
  );

  const isLiveOrGoingLive =
    saved.status === "PUBLISHED" ||
    saved.status === "SCHEDULED" ||
    value.status === "PUBLISHED" ||
    value.status === "SCHEDULED";

  const save = useCallback(
    async (next: PublicationFormValue) => {
      if (publicationId === null) {
        const created = await post<{ id: string }>(ENDPOINT.collection, toPayload(next));
        createdId.current = created.id;
        return;
      }
      await patch(ENDPOINT.detail(publicationId), toPayload(next));
    },
    [publicationId]
  );

  const autosave = useAutosave<PublicationFormValue>({
    data: value,
    save,
    isPublished: isLiveOrGoingLive,
    enabled: !isNew,
    onSaved: (sent) => {
      setSaved(sent);
      const fresh = createdId.current;
      if (fresh !== null) {
        createdId.current = null;
        toast({ tone: "success", title: "The publication has been created" });
        router.replace(`/studio/publications/${fresh}`);
        return;
      }
      router.refresh();
    }
  });

  useLeaveGuard(autosave.isDirty);

  const year = toYear(value.year);
  const parsedAuthors = useMemo(() => parseAuthorLine(value.authorLine), [value.authorLine]);
  const keywords = useMemo(() => parseList(value.keywordsText), [value.keywordsText]);

  const saveBlockers = useMemo(() => {
    const problems: string[] = [];
    if (value.title.trim().length === 0) problems.push("The title is empty.");
    if (value.slug.trim().length === 0) problems.push("The web address is empty.");
    if (value.authorLine.trim().length === 0) problems.push("The author line is empty.");
    if (year === null) {
      problems.push(`The year must be a whole number between ${YEAR_MIN} and ${YEAR_MAX}.`);
    }
    problems.push(...statusProblems(value, false));
    return problems;
  }, [value, year]);

  const publishBlockers = useMemo(() => {
    const problems: string[] = [];
    if (value.title.trim().length === 0) problems.push("The publication has no title.");
    if (value.authorLine.trim().length === 0) {
      problems.push("The author line is empty, so every citation of this page would have no author.");
    }
    if (year === null) problems.push("There is no readable year, so citations would read “n.d.”.");
    if (value.kind === "PATENT" && value.patentNumber.trim().length === 0) {
      problems.push("A patent with no number cannot be looked up. Add the patent number.");
    }
    return problems;
  }, [value, year]);

  const remove = useCallback(async () => {
    if (publicationId === null) return;
    await del(ENDPOINT.detail(publicationId));
  }, [publicationId]);

  const citable = useMemo(() => toCitable(value), [value]);
  const storedBibtex = value.bibtex.trim();

  return (
    <div className="mt-6 space-y-5">
      <FormSection
        title="What it is"
        description="The type decides how the citation is punctuated and which of the fields below are asked for."
      >
        <Field label="Type" required help="Change this and the citation preview lower down changes with it.">
          <Select
            value={value.kind}
            options={KIND_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(event) => update({ kind: event.target.value as PublicationKind })}
          />
        </Field>

        <Field
          label="Title"
          required
          maxLength={TITLE_MAX}
          value={value.title}
          help="Exactly as printed, including any subtitle after a colon. Capitalisation is kept as you type it."
        >
          <Textarea
            value={value.title}
            onChange={(event) => update({ title: event.target.value })}
            rows={2}
          />
        </Field>

        <SlugField
          value={value.slug}
          onChange={(slug) => update({ slug })}
          source={value.title}
          basePath="/publications/"
          siteUrl={siteUrl}
          // `saved.slug`, not the value this screen opened with: after a save the stored address IS the
          // new one, and a warning about an address that no longer exists cannot be acted on.
          originalValue={isNew ? undefined : saved.slug}
          isPublished={saved.status === "PUBLISHED"}
          redirect={{
            enabled: value.createRedirect,
            onEnabledChange: (createRedirect) => update({ createRedirect })
          }}
          required
        />
      </FormSection>

      <FormSection
        title="Authors"
        description="Two separate things live here, and they are not the same list. Read both descriptions once — getting them the wrong way round drops external co-authors out of every citation."
      >
        <Field
          label="Author line, as printed"
          required
          maxLength={AUTHOR_LINE_MAX}
          value={value.authorLine}
          help={
            <>
              <strong className="font-semibold text-ink-700">The authoritative credit.</strong> Type every
              author, in the printed order, exactly as the work prints them — including everybody from
              other institutions. This is the only field citations are built from. Separate authors with
              semicolons if a comma could be read two ways.
            </>
          }
        >
          <Textarea
            value={value.authorLine}
            onChange={(event) => update({ authorLine: event.target.value })}
            rows={3}
            placeholder="Sharma, Anita; Doe, John; Kumar, R."
          />
        </Field>

        <AuthorLineReadout authors={parsedAuthors} hasText={value.authorLine.trim().length > 0} />

        <EntityPicker
          kind="person"
          label="Which of these authors work at the Centre"
          ids={value.authorPersonIds}
          onChange={(authorPersonIds) => update({ authorPersonIds })}
          max={40}
          help={
            <>
              <strong className="font-semibold text-ink-700">A separate, additional step.</strong> Linking
              somebody puts this publication on their profile page and lets the list be filtered by them.
              It does <strong className="font-semibold text-ink-700">not</strong> change the author line
              above, and leaving it empty changes nothing about the citation.
            </>
          }
          footnote="Only people with a profile here can be linked. Co-authors from other institutions have no profile and need none — they are already credited in the author line."
        />
      </FormSection>

      <FormSection
        title="Where it was published"
        description="What a reader needs in order to find the work itself."
        columns={2}
      >
        <Field label={VENUE_LABELS[value.kind]} help="Written as the publisher writes it, unabbreviated.">
          <Input value={value.venue} onChange={(event) => update({ venue: event.target.value })} />
        </Field>

        <Field label="Publisher" help="For a book, a report or a dataset. Optional for a journal article.">
          <Input
            value={value.publisher}
            onChange={(event) => update({ publisher: event.target.value })}
          />
        </Field>

        <Field
          label="Year"
          required
          error={
            value.year.trim().length > 0 && year === null
              ? `A whole number between ${YEAR_MIN} and ${YEAR_MAX}.`
              : null
          }
          help="The year of publication. For a preprint, the year the current version went up."
        >
          <Input
            type="number"
            inputMode="numeric"
            value={value.year}
            onChange={(event) => update({ year: event.target.value })}
            className="max-w-[10rem]"
          />
        </Field>

        <Field label="Month" help="Optional. Only some citation styles use it.">
          <Select
            value={value.month}
            options={MONTHS}
            placeholder="Not recorded"
            onChange={(event) => update({ month: event.target.value })}
          />
        </Field>

        <Field label="Volume">
          <Input value={value.volume} onChange={(event) => update({ volume: event.target.value })} />
        </Field>

        <Field label="Issue or number">
          <Input value={value.issue} onChange={(event) => update({ issue: event.target.value })} />
        </Field>

        <Field
          label="Pages"
          className="sm:col-span-2"
          help="A range such as 45–67, or a single page. Any kind of dash is tidied up in the citation."
        >
          <Input
            value={value.pages}
            onChange={(event) => update({ pages: event.target.value })}
            placeholder="45–67"
            className="max-w-[14rem]"
          />
        </Field>
      </FormSection>

      <FormSection
        title="Identifiers and links"
        description="Whatever the work has. A DOI is worth more than everything else here put together, because it is the one link that does not rot."
        columns={2}
      >
        <Field
          label="DOI"
          help="Paste it in any shape — bare, with “doi:”, or as a doi.org address. It is tidied for the citation."
        >
          <Input
            value={value.doi}
            onChange={(event) => update({ doi: event.target.value })}
            placeholder="10.1234/example.5678"
            spellCheck={false}
            className="font-mono text-xs"
          />
        </Field>

        <Field label="Web address" help="Use this only when there is no DOI.">
          <Input
            type="url"
            value={value.url}
            onChange={(event) => update({ url: event.target.value })}
            placeholder="https://"
            spellCheck={false}
            className="font-mono text-xs"
          />
        </Field>

        <Field label="ISBN" help="Books and book chapters.">
          <Input
            value={value.isbn}
            onChange={(event) => update({ isbn: event.target.value })}
            spellCheck={false}
            className="font-mono text-xs"
          />
        </Field>

        <Field label="ISSN" help="Journals.">
          <Input
            value={value.issn}
            onChange={(event) => update({ issn: event.target.value })}
            spellCheck={false}
            className="font-mono text-xs"
          />
        </Field>

        <Field
          label="Patent number"
          help="Patents. Without it the patent cannot be looked up, so it is required before publishing."
        >
          <Input
            value={value.patentNumber}
            onChange={(event) => update({ patentNumber: event.target.value })}
            spellCheck={false}
            className="font-mono text-xs"
          />
        </Field>

        <Field label="arXiv identifier" help="Preprints. Type it with or without the “arXiv:” prefix.">
          <Input
            value={value.arxivId}
            onChange={(event) => update({ arxivId: event.target.value })}
            placeholder="2401.01234"
            spellCheck={false}
            className="font-mono text-xs"
          />
        </Field>
      </FormSection>

      <FormSection
        title="Abstract and keywords"
        description="The abstract is shown on the publication's page and is searched by the site's search box."
      >
        <Field
          label="Abstract"
          maxLength={ABSTRACT_MAX}
          value={value.abstract}
          help="The published abstract, as printed. Leave it empty rather than writing a new one — a paraphrase attributed to the authors is worse than nothing."
        >
          <Textarea
            value={value.abstract}
            onChange={(event) => update({ abstract: event.target.value })}
            rows={7}
          />
        </Field>

        <FieldBlock
          label="Keywords"
          help="One per line, or separated by commas. They are used by the site's search and appear in the generated BibTeX entry."
        >
          <Textarea
            value={value.keywordsText}
            onChange={(event) => update({ keywordsText: event.target.value })}
            rows={3}
            placeholder={"block printing\nnatural dyes\nheritage documentation"}
          />

          {keywords.length > 0 ? (
            <>
              <p className="mt-2 text-xs text-ink-500">
                {keywords.length === 1
                  ? "This will be stored as one keyword:"
                  : `This will be stored as ${keywords.length} keywords:`}
              </p>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {keywords.map((keyword) => (
                  <li
                    key={keyword}
                    className="rounded-full border border-line-200 bg-surface-100 px-2.5 py-0.5 text-xs text-ink-700"
                  >
                    {keyword}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </FieldBlock>
      </FormSection>

      <FormSection
        title="The full text"
        description="A PDF or other document from the file store, offered as a download on the publication's page."
      >
        <EntityPicker
          kind="file"
          label="Document people can download"
          ids={value.pdfFileIds}
          onChange={(pdfFileIds) => update({ pdfFileIds })}
          max={1}
          help="Upload it in Files first, then choose it here. A file that is not marked public cannot be downloaded from the site, whatever is chosen here — which is how an accepted manuscript can be attached before an embargo lifts."
        />
      </FormSection>

      <FormSection
        title="Citations"
        description="Exactly what a reader will copy from the public page, recalculated as you type. If a citation below looks wrong, the mistake is in a field above rather than in the citation."
      >
        <CitationPreview citable={citable} />

        <FieldBlock
          label="BibTeX entry"
          help="Leave this empty unless the record came from a publisher or a reference manager. Empty is normal and correct: an entry is generated from the fields above whenever it is needed. A stored entry is kept exactly as it is, letters, key and all, because other people's manuscripts may already point at that key — so pasting one here freezes it."
        >
          <Textarea
            value={value.bibtex}
            onChange={(event) => update({ bibtex: event.target.value })}
            rows={8}
            spellCheck={false}
            className="font-mono text-xs"
            placeholder="@article{sharma2024block, … }"
          />

          {storedBibtex.length === 0 ? (
            <div className="mt-3">
              <p className="text-xs font-medium text-ink-700">
                This is what will be generated while the box above is empty:
              </p>
              <pre className="mt-1.5 overflow-x-auto rounded-md border border-line-200 bg-surface-50 px-3 py-2.5 font-mono text-[0.6875rem] leading-relaxed text-ink-700">
                {generateBibtex(citable)}
              </pre>
            </div>
          ) : (
            <HelpText className="mt-2">
              The entry above is stored and used exactly as it is. Nothing is generated while there is
              something in the box.
            </HelpText>
          )}
        </FieldBlock>
      </FormSection>

      <FormSection
        title="Filing"
        description="Where this publication is listed apart from the publications page."
      >
        <EntityPicker
          kind="research"
          label="Research area"
          ids={value.researchAreaIds}
          onChange={(researchAreaIds) => update({ researchAreaIds })}
          max={1}
          help="Files this publication under a theme, so it appears on that area's page. Optional."
        />

        <Switch
          checked={value.isFeatured}
          onCheckedChange={(isFeatured) => update({ isFeatured })}
          label="Feature this publication"
          description="Featured publications can be pulled onto the homepage and other pages by a publications block. It does not change this publication's own page."
        />

        <div>
          <span className="field-label">Projects it is listed on</span>
          {projects.length === 0 ? (
            <p className="mt-1.5 text-sm text-ink-500">
              Not listed on any project. That link is added from a project&rsquo;s own screen, under
              &ldquo;What this project has produced&rdquo;.
            </p>
          ) : (
            <>
              <ul className="mt-1.5 flex flex-wrap gap-2">
                {projects.map((project) => (
                  <li key={project.id}>
                    <Link
                      href={`/studio/projects/${project.id}`}
                      className="inline-flex rounded-full border border-line-200 bg-surface-100 px-2.5 py-1 text-xs text-ink-700 transition hover:border-purple-300 hover:text-purple-700"
                    >
                      {project.title}
                    </Link>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-xs text-ink-500">
                Shown here for reference. Add or remove a project from that project&rsquo;s own screen,
                which is where the whole list of its outputs is visible at once.
              </p>
            </>
          )}
        </div>
      </FormSection>

      <FormSection
        title="Publication"
        description="Whether this publication's page is on the public site. Publications cannot be scheduled."
      >
        <StatusControl
          value={{ status: value.status, publishedAt: value.publishedAt }}
          onChange={(next) => update({ status: next.status })}
          canPublish={canPublish}
          scheduling={false}
          publishBlockers={publishBlockers}
        />
      </FormSection>

      {canDelete && !isNew ? (
        <FormSection
          title="Delete this publication"
          tone="danger"
          description="Anyone who has cited the page will get a “page not found”. If the record is merely superseded, taking it off the site as an archived record is usually the better answer."
        >
          <DeleteButton
            name={saved.title.trim().length > 0 ? saved.title : "this publication"}
            noun="publication"
            onDelete={remove}
            onDeleted={() => router.push("/studio/publications")}
            successMessage={null}
          />
        </FormSection>
      ) : null}

      <SaveBar
        status={autosave.status}
        lastSavedAt={autosave.lastSavedAt}
        onSave={() => void autosave.saveNow()}
        onDiscard={() => setValue(saved)}
        error={autosave.error?.message ?? null}
        saveDisabledReason={saveBlockers[0] ?? null}
        saveLabel={isNew ? "Create publication" : "Save"}
        subject="this publication"
        note={
          isNew
            ? "Nothing is saved until you press Create. After that your changes are kept automatically every few seconds, until the publication is published."
            : autosave.retriesExhausted
              ? "Saving automatically has stopped after several failures. Press Save to try again."
              : isLiveOrGoingLive
                ? PUBLISHED_AUTOSAVE_NOTICE
                : "Your changes are kept automatically every few seconds while this is a draft."
        }
      />
    </div>
  );
}

/**
 * How the author line will be READ.
 *
 * A comma does two jobs in an author line — separating people and inverting one name — and no parser
 * resolves that from the punctuation alone (lib/citation.ts). So rather than hiding the guess, this
 * shows it: an editor sees "read as 3 authors" and can fix an ambiguous line with semicolons before
 * anybody cites it. Two names collapsing into one is invisible in the line itself and obvious here.
 */
function AuthorLineReadout({
  authors,
  hasText
}: {
  authors: readonly { given: string; family: string }[];
  hasText: boolean;
}) {
  if (!hasText) {
    return (
      <HelpText tone="warn">
        Nothing has been typed yet, so every citation of this work would appear with no author at all.
      </HelpText>
    );
  }

  return (
    <div className="rounded-md border border-line-200 bg-surface-50 px-3 py-2.5">
      <p className="text-xs font-medium text-ink-700">
        {authors.length === 0
          ? "No authors could be read from that line."
          : authors.length === 1
            ? "Read as one author:"
            : `Read as ${authors.length} authors, in this order:`}
      </p>

      {authors.length > 0 ? (
        <ol className="mt-1.5 space-y-0.5">
          {authors.map((author, index) => (
            <li key={`${author.family}-${author.given}-${index}`} className="text-xs text-ink-700">
              <span className="tabular-nums text-ink-500">{index + 1}.</span>{" "}
              <span className="font-medium">{author.family}</span>
              {author.given.length > 0 ? <>, {author.given}</> : (
                <span className="text-ink-500"> (one name only)</span>
              )}
            </li>
          ))}
        </ol>
      ) : null}

      <p className="mt-2 text-xs leading-relaxed text-ink-500">
        If two people have been run together, or one name has been split in two, separate the authors
        with semicolons — “Sharma, Anita; Doe, John” — and this readout will follow.
      </p>
    </div>
  );
}

/** The four styles, side by side, recomputed on every keystroke. */
function CitationPreview({ citable }: { citable: CitablePublication }) {
  const rendered = useMemo(
    () =>
      CITATION_STYLES.map((entry) => ({
        ...entry,
        text: formatCitation(citable, entry.style)
      })),
    [citable]
  );

  return (
    <div className="min-w-0 space-y-2">
      {rendered.map((entry) => (
        <div
          key={entry.style}
          className={cn(
            "rounded-md border border-line-200 bg-surface-50 px-3 py-2.5",
            "min-w-0"
          )}
        >
          <p className="flex items-center gap-1.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-ink-500">
            <Quote aria-hidden="true" className="h-3 w-3 shrink-0" />
            {entry.label}
          </p>
          {/*
            NOT a live region. It changes on every keystroke, and a polite region here would read the
            whole citation out again after every character (contract §11).
          */}
          <p className="prose-measure mt-1 break-words text-sm leading-relaxed text-ink-900">
            {entry.text.trim().length > 0
              ? entry.text
              : "Nothing to show yet — fill in the title, the authors and the year."}
          </p>
        </div>
      ))}

      <HelpText>
        Journal and book titles are set in italics in a typeset bibliography. They are shown as plain
        text here because this is the text a reader copies, and italics do not survive being pasted into
        most reference managers.
      </HelpText>
    </div>
  );
}
