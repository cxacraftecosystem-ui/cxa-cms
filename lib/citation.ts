import type { PublicationKind } from "@prisma/client";

/**
 * Publication citations — BibTeX generation, a stable citation key, four house styles, and the one
 * venue line a card renders under a title.
 *
 * Everything here is pure and synchronous. No database, no `lib/db`: a citation is a function of the
 * row you already have, and making it async would drag a `await` into every card that renders one.
 *
 * Two facts about the data shape it works from drive most of the decisions below:
 *
 *   1. `Publication.authorLine` is the AUTHORITATIVE author string, in order, exactly as printed.
 *      `PublicationAuthor` links only the subset who are Centre people, so the links can never be the
 *      source of a citation — every external co-author would vanish and the work would be
 *      misattributed. Everything here parses the line.
 *   2. `Publication.bibtex` is verbatim and AUTHORITATIVE when present. An imported record carries a
 *      canonical citation key that other people's bibliographies already point at; regenerating one
 *      would silently break their `\cite{}`. `generateBibtex` is therefore only correct to call when
 *      the stored string is empty — `resolveBibtex` exists so that rule cannot be got wrong.
 *
 * Nothing here renders markup. Journal and book titles are italicised in every one of these styles
 * and these are plain strings, so the italics are simply absent; a caller that wants them can wrap
 * the venue itself. Straight quotation marks are used rather than typographic ones because the
 * output's job is to be copied — into a reference manager, a plain-text field, an email — and curly
 * quotes are mangled by more of those destinations than they are respected by.
 */

export type CitationStyle = "apa" | "mla" | "chicago" | "ieee";


/** One parsed name. `given` is `""` for a mononym or an institutional author — never undefined. */
export interface ParsedAuthor {
  given: string;
  family: string;
}

/**
 * The subset of `Publication` a citation needs.
 *
 * Declared structurally rather than as the Prisma row so a caller can pass a `select`-narrowed
 * object, a form's draft state, or an import candidate that has no id yet. A full `Publication`
 * satisfies it.
 */
export interface CitablePublication {
  kind: PublicationKind;
  title: string;
  authorLine: string;
  year: number;
  month?: number | null;
  venue?: string | null;
  publisher?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  doi?: string | null;
  isbn?: string | null;
  issn?: string | null;
  patentNumber?: string | null;
  arxivId?: string | null;
  url?: string | null;
  bibtex?: string | null;
  keywords?: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Small shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/** A trimmed value, or null for anything blank. Collapses the three empty shapes into one. */
function trimmed(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

/** Collapse every run of whitespace, including the newlines a pasted author line always carries. */
function tidy(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * End a sentence without doubling the stop.
 *
 * A title that already ends in "?" or "!" keeps it — "Why Weave?." is the single most visible sign
 * that a citation was assembled by string concatenation.
 */
function terminate(text: string): string {
  const value = text.trim();
  if (!value) return "";
  return /[.?!…]$/.test(value) ? value : `${value}.`;
}

/** Join the non-empty pieces of a citation with single spaces, so an absent field leaves no gap. */
function joinParts(parts: (string | null)[]): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join(" ").trim();
}

/**
 * Quote a title US-style, with the trailing stop INSIDE the closing quotation mark — which is what
 * MLA, Chicago and IEEE all specify. A title carrying its own terminal punctuation takes no stop.
 */
function quoteTitle(title: string, stop: "." | ","): string {
  const text = tidy(title).replace(/[.,]+$/, "");
  if (!text) return "";
  return /[?!]$/.test(text) ? `"${text}"` : `"${text}${stop}"`;
}

/** Strip diacritics by decomposing first — otherwise "é" is one codepoint a character class eats whole. */
function asciiFold(input: string): string {
  return input.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

/**
 * Page ranges, with the dash each style actually uses: APA and Chicago set an en dash, MLA and IEEE
 * a hyphen. Runs of any dash plus their surrounding spaces collapse, so "45 - 67", "45–67" and
 * "45--67" all normalise to one form.
 */
function formatPages(pages: string | null | undefined, dash: "–" | "-"): string | null {
  const value = trimmed(pages);
  if (!value) return null;
  return tidy(value.replace(/\s*[-–—]+\s*/g, dash));
}

/** "pp." for a range or a list, "p." for a single page. Getting this backwards is a proofreading flag. */
function pageLabel(pages: string): string {
  return /[–\-,]/.test(pages) ? "pp." : "p.";
}

/**
 * A bare DOI, whatever shape it was stored in.
 *
 * Editors paste DOIs three ways — bare, as a doi.org URL, and with a "doi:" prefix — and a citation
 * that renders "https://doi.org/https://doi.org/10.1234/x" is the result of trusting the column.
 */
function normaliseDoi(raw: string | null | undefined): string | null {
  const value = trimmed(raw);
  if (!value) return null;
  const bare = value
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim();
  return bare.length > 0 ? bare : null;
}

/** The arXiv identifier without its prefix, which editors include about half the time. */
function normaliseArxiv(raw: string | null | undefined): string | null {
  const value = trimmed(raw);
  if (!value) return null;
  const bare = value.replace(/^arxiv:\s*/i, "").trim();
  return bare.length > 0 ? bare : null;
}

/** The single best link for a record: a DOI outranks a bare URL, which outranks an arXiv landing page. */
function preferredLink(publication: CitablePublication): string | null {
  const doi = normaliseDoi(publication.doi);
  if (doi) return `https://doi.org/${doi}`;
  const url = trimmed(publication.url);
  if (url) return url;
  const arxiv = normaliseArxiv(publication.arxivId);
  return arxiv ? `https://arxiv.org/abs/${arxiv}` : null;
}

/** The awarding or issuing body. Publisher first; a thesis often records the university as the venue. */
function institutionOf(publication: CitablePublication): string | null {
  return trimmed(publication.publisher) ?? trimmed(publication.venue);
}

function yearLabel(year: number): string {
  return Number.isFinite(year) ? String(Math.trunc(year)) : "n.d.";
}

// ─────────────────────────────────────────────────────────────────────────────
// Author-line parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Surname particles. Only used to recognise a fragment as a bare surname when deciding how to read a
 * comma-only line — see `looksLikeFamilyName`.
 */
const SURNAME_PARTICLES = new Set([
  "van", "von", "de", "der", "den", "del", "della", "di", "du", "da", "dos", "das",
  "la", "le", "el", "al", "bin", "ibn", "ter", "ten", "af", "av", "san", "santa"
]);

/**
 * Parse an author line into ordered names.
 *
 * THE AMBIGUITY, STATED PLAINLY: a comma is used both to separate authors ("John Smith, Jane Doe")
 * and to invert a single name ("Smith, John"). No parser resolves that from the punctuation alone,
 * and the two readings of "Kumar, Sharma" — one inverted name, or two mononyms — are equally valid
 * English. What follows is a heuristic, not a solution, and it is arranged so the common shapes are
 * right and the rare ones are wrong in a way an editor can see and fix by adding semicolons.
 *
 * The order of decisions:
 *
 *   1. A trailing "et al." is removed. It is a marker, not a person named Al, and leaving it in
 *      throws off the even/odd fragment count everything below depends on.
 *   2. A LITERAL ";" anywhere in the line means the editor has punctuated it explicitly, so the line
 *      is split on semicolons and nothing further is guessed. This is the escape hatch: any line this
 *      function reads wrongly can be made unambiguous by an editor typing semicolons.
 *   3. Otherwise " and " and " & " are treated as separators — which does split an institutional
 *      author such as "Ministry of Textiles and Handicrafts" in two; semicolon the line if that
 *      matters — and the commas inside each resulting piece are classified. The
 *      "Family, Given, Family, Given" reading is taken only when the shape actually looks like it: an
 *      even number of fragments, every even-indexed one a bare surname, every odd-indexed one a short
 *      run of given names or initials. Anything else is read as "commas separate authors", which is
 *      what makes "John Smith, Jane Doe and Ravi Kumar" come out as three people rather than two.
 *
 * Then, per fragment: a comma inside it means "Family, Given"; without one, the LAST whitespace-run
 * is the family name. That last rule is what mis-reads "Jan van der Berg" as family "Berg", given
 * "Jan van der" — deliberately not special-cased, because a particle list is a bottomless pit and a
 * wrong-but-predictable rule is easier for an editor to work around than a clever one.
 */
export function parseAuthorLine(authorLine: string): ParsedAuthor[] {
  const line = tidy(authorLine).replace(/[,;]?\s*\bet\.?\s*al\.?\s*$/i, "");
  if (!line) return [];

  // Whether the editor punctuated the line themselves has to be decided BEFORE " and " is rewritten,
  // otherwise every conjunction would look like an explicit separator and disable the classifier.
  const punctuatedByHand = line.includes(";");
  const segments = line.replace(/\s+(?:and|&)\s+/gi, ";").split(";");

  const authors: ParsedAuthor[] = [];
  for (const segment of segments) {
    const text = tidy(segment);
    if (!text) continue;
    const fragments = punctuatedByHand ? [text] : splitCommaSeparatedAuthors(text);
    for (const fragment of fragments) {
      const author = authorFromSegment(fragment);
      if (author) authors.push(author);
    }
  }
  return authors;
}

/** Step 3 above: decide whether the commas in a piece separate names or invert a single one. */
function splitCommaSeparatedAuthors(line: string): string[] {
  const fragments = line
    .split(",")
    .map((fragment) => fragment.trim())
    .filter(Boolean);

  if (fragments.length < 2) return fragments;
  if (fragments.length % 2 !== 0 || !looksLikeInvertedPairs(fragments)) return fragments;

  const paired: string[] = [];
  for (let index = 0; index < fragments.length; index += 2) {
    const family = fragments[index];
    const given = fragments[index + 1];
    if (family === undefined || given === undefined) continue;
    paired.push(`${family}, ${given}`);
  }
  return paired;
}

function looksLikeInvertedPairs(fragments: string[]): boolean {
  for (let index = 0; index < fragments.length; index += 2) {
    const family = fragments[index];
    const given = fragments[index + 1];
    if (family === undefined || given === undefined) return false;
    if (!looksLikeFamilyName(family) || !looksLikeGivenNames(given)) return false;
  }
  return true;
}

/** A bare surname: one token, optionally behind particles ("Berg", "van der Berg"). */
function looksLikeFamilyName(fragment: string): boolean {
  const tokens = fragment.split(" ").filter(Boolean);
  let index = 0;
  while (index < tokens.length - 1) {
    const token = tokens[index];
    if (token === undefined || !SURNAME_PARTICLES.has(token.toLowerCase())) break;
    index += 1;
  }
  return tokens.length - index === 1;
}

/** Given names: one to three tokens, no digits. Longer than that and it is probably a whole name. */
function looksLikeGivenNames(fragment: string): boolean {
  const tokens = fragment.split(" ").filter(Boolean);
  if (tokens.length < 1 || tokens.length > 3) return false;
  return !/\d/.test(fragment);
}

function authorFromSegment(segment: string): ParsedAuthor | null {
  const text = tidy(segment);
  if (!text) return null;
  if (/^et\.?\s*al\.?$/i.test(text)) return null;

  const comma = text.indexOf(",");
  if (comma >= 0) {
    const family = text.slice(0, comma).trim();
    // A second comma inside one segment ("Smith, John, Jr.") is a suffix, not another name; folding it
    // into the given names keeps it attached to the person it belongs to.
    const given = tidy(text.slice(comma + 1).replace(/,/g, " "));
    return family ? { family, given } : null;
  }

  const tokens = text.split(" ").filter(Boolean);
  const last = tokens[tokens.length - 1];
  if (last === undefined) return null;
  if (tokens.length === 1) return { family: last, given: "" };
  return { family: last, given: tokens.slice(0, -1).join(" ") };
}

/**
 * Initials from a given-name string: "John Robert" → "J. R.", "Jean-Pierre" → "J.-P.".
 *
 * The hyphen is preserved because dropping it turns two distinct people, J.-P. Dubois and
 * J. P. Dubois, into one entry in a reference list.
 */
function initialsOf(given: string): string {
  const words = given.split(/\s+/).filter(Boolean);
  const rendered: string[] = [];
  for (const word of words) {
    const initials: string[] = [];
    for (const piece of word.split("-")) {
      const first = piece.trim().charAt(0);
      if (first) initials.push(`${first.toUpperCase()}.`);
    }
    if (initials.length > 0) rendered.push(initials.join("-"));
  }
  return rendered.join(" ");
}

/** "Smith, J. R." — APA. An author with no recorded given name is simply the family name. */
function apaName(author: ParsedAuthor): string {
  const initials = initialsOf(author.given);
  return initials ? `${author.family}, ${initials}` : author.family;
}

/** "Smith, John" — the inverted form MLA and Chicago use for the FIRST author only. */
function invertedName(author: ParsedAuthor): string {
  return author.given ? `${author.family}, ${author.given}` : author.family;
}

/** "John Smith" — the natural form MLA and Chicago use for every author after the first. */
function naturalName(author: ParsedAuthor): string {
  return author.given ? `${author.given} ${author.family}` : author.family;
}

/** "J. R. Smith" — IEEE puts initials first. */
function ieeeName(author: ParsedAuthor): string {
  const initials = initialsOf(author.given);
  return initials ? `${initials} ${author.family}` : author.family;
}

/**
 * Render an author list for a style, including its truncation rule. The rules genuinely differ, and
 * they are the part of a citation a reader checks first:
 *
 *   • APA 7    — list up to 20. From 21, the first 19, an ellipsis, then the LAST author (no "&").
 *   • MLA 9    — one author, or two joined with "and". Three or more collapse to "First, et al."
 *   • Chicago  — up to 10 listed. From 11, the first 7 then "et al."
 *   • IEEE     — up to 6 listed. From 7, the first author then "et al."
 *
 * The serial comma before the final conjunction is required by APA and Chicago and absent from IEEE
 * with exactly two names; those are not stylistic choices here.
 */
export function formatAuthorsForStyle(
  authors: readonly ParsedAuthor[],
  style: CitationStyle
): string {
  const first = authors[0];
  if (!first) return "";

  switch (style) {
    case "apa": {
      const names = authors.map(apaName);
      return joinApa(names);
    }
    case "mla": {
      if (authors.length === 1) return invertedName(first);
      const second = authors[1];
      if (authors.length === 2 && second) {
        return `${invertedName(first)}, and ${naturalName(second)}`;
      }
      return `${invertedName(first)}, et al.`;
    }
    case "chicago": {
      const names = authors.map((author, index) =>
        index === 0 ? invertedName(author) : naturalName(author)
      );
      if (names.length > 10) return `${names.slice(0, 7).join(", ")}, et al.`;
      return joinWithConjunction(names, "and");
    }
    case "ieee": {
      const names = authors.map(ieeeName);
      if (names.length > 6) {
        const head = names[0];
        return head ? `${head} et al.` : "";
      }
      if (names.length === 1) return names[0] ?? "";
      const last = names[names.length - 1];
      if (last === undefined) return "";
      // IEEE takes no serial comma with two names, and does take one with three or more.
      if (names.length === 2) return `${names[0] ?? ""} and ${last}`;
      return `${names.slice(0, -1).join(", ")}, and ${last}`;
    }
    default:
      return "";
  }
}

function joinApa(names: string[]): string {
  const last = names[names.length - 1];
  if (last === undefined) return "";
  if (names.length === 1) return last;
  if (names.length <= 20) return `${names.slice(0, -1).join(", ")}, & ${last}`;
  // 21 or more: the first nineteen, an ellipsis, then the final author — and no ampersand, which is
  // the detail most implementations get wrong.
  return `${names.slice(0, 19).join(", ")}, … ${last}`;
}

function joinWithConjunction(names: string[], conjunction: string): string {
  const last = names[names.length - 1];
  if (last === undefined) return "";
  if (names.length === 1) return last;
  return `${names.slice(0, -1).join(", ")}, ${conjunction} ${last}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Citation key
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The stable citation key: first author's surname + year + first title word, ASCII, lowercase.
 *
 * STABILITY IS THE WHOLE POINT. The key is what a `\cite{}` in someone else's manuscript points at,
 * so it must be a pure function of fields an editor does not routinely reword, and re-running this
 * must produce the same string it produced last year. Three consequences:
 *
 *   • Articles ("the", "a", "an") are NOT skipped. Skipping them is a defensible convention, but the
 *     stop-word list differs between every tool that implements it, and adopting one later would
 *     re-key every publication already exported.
 *   • Diacritics are folded rather than dropped, so "Chatterjee" and "Chatterjée" do not collide with
 *     a truncated stem.
 *   • Nothing is appended to disambiguate two papers that land on the same key. Uniqueness belongs to
 *     the caller, which is the only layer that can see the other rows; inventing a suffix here would
 *     make the key depend on query order and therefore unstable.
 */
export function citationKey(publication: CitablePublication): string {
  const authors = parseAuthorLine(publication.authorLine);
  const first = authors[0];
  const surname = first ? keySlug(first.family) : "";

  const titleWords = tidy(publication.title).split(" ");
  let titleWord = "";
  for (const word of titleWords) {
    const candidate = keySlug(word);
    if (candidate) {
      titleWord = candidate;
      break;
    }
  }

  const year = Number.isFinite(publication.year) ? String(Math.trunc(publication.year)) : "nd";
  return `${surname || "anon"}${year}${titleWord || "untitled"}`;
}

/** Fold to ASCII, lowercase, and keep only letters and digits — the character set every .bst accepts. */
function keySlug(input: string): string {
  return asciiFold(input).toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// BibTeX
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Entry type per publication kind.
 *
 * `@patent` is biblatex rather than classic BibTeX, and datasets, software and preprints all become
 * `@misc` because no standard `.bst` knows anything narrower — an entry type a style file does not
 * recognise is silently dropped from the bibliography, which is worse than a coarse but rendered one.
 * THESIS maps to `@phdthesis`: the schema has a single THESIS kind, so a master's thesis is labelled
 * doctoral everywhere in this file. An editor with a master's thesis should say so in the venue.
 */
const BIBTEX_ENTRY_TYPES: Record<PublicationKind, string> = {
  JOURNAL_ARTICLE: "article",
  CONFERENCE_PAPER: "inproceedings",
  BOOK: "book",
  BOOK_CHAPTER: "incollection",
  PATENT: "patent",
  DATASET: "misc",
  SOFTWARE: "misc",
  PREPRINT: "misc",
  THESIS: "phdthesis",
  REPORT: "techreport"
};

const BIBTEX_ESCAPES: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  $: "\\$",
  "%": "\\%",
  "&": "\\&",
  "#": "\\#",
  _: "\\_",
  "^": "\\textasciicircum{}",
  "~": "\\textasciitilde{}"
};

/**
 * Escape the ten characters BibTeX reads as syntax.
 *
 * ONE pass, driven by a lookup table, and that is load-bearing: sequential replaces would escape the
 * braces that `\textbackslash{}` and `\textasciitilde{}` introduce, so a single backslash in a title
 * would come out as `\textbackslash\{\}`. A single scan never revisits what it has written.
 */
function escapeBibtex(value: string): string {
  return value.replace(/[\\{}$%&#_^~]/g, (character) => BIBTEX_ESCAPES[character] ?? character);
}

const MONTH_ABBREVIATIONS = [
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"
];

interface BibtexField {
  key: string;
  value: string;
}

/**
 * The author field in BibTeX's own grammar: names joined by the literal word "and".
 *
 * Passing `authorLine` through verbatim is the tempting shortcut and it is wrong — BibTeX splits on
 * " and " and on nothing else, so "Smith, J., Doe, A." is read as ONE author whose family name is
 * "Smith" and whose given names are "J., Doe, A.", and every downstream sort and "et al." is then
 * computed from that. A mononym is braced so it is read as a family name rather than a given one.
 */
function bibtexAuthors(authors: readonly ParsedAuthor[]): string | null {
  if (authors.length === 0) return null;
  return authors
    .map((author) => {
      const family = escapeBibtex(author.family);
      if (!author.given) return `{${family}}`;
      return `${family}, ${escapeBibtex(author.given)}`;
    })
    .join(" and ");
}

/**
 * Generate a BibTeX entry.
 *
 * ⚠ Only correct to call when `publication.bibtex` is empty. A stored string is the record's
 * canonical citation, key included, and replacing it breaks every `\cite{}` already pointing at it.
 * Use `resolveBibtex` unless you specifically want a preview of what would be generated.
 *
 * The title is wrapped in a second pair of braces. Styles derived from `plain` lowercase title case,
 * which turns "GANs for Bagru Block Printing" into "Gans for bagru block printing"; the inner braces
 * protect it. The abstract is deliberately omitted — this string is offered behind a copy button, and
 * a two-thousand-character field makes the entry unreadable in the place it is actually read.
 */
export function generateBibtex(publication: CitablePublication): string {
  const authors = parseAuthorLine(publication.authorLine);
  const entryType = BIBTEX_ENTRY_TYPES[publication.kind] ?? "misc";
  const fields: BibtexField[] = [];

  const push = (key: string, value: string | null | undefined): void => {
    const text = trimmed(value ?? null);
    if (text) fields.push({ key, value: text });
  };
  /** Push a value that still needs escaping. */
  const pushText = (key: string, value: string | null | undefined): void => {
    const text = trimmed(value ?? null);
    if (text) fields.push({ key, value: escapeBibtex(text) });
  };

  push("author", bibtexAuthors(authors));
  const title = tidy(publication.title);
  if (title) fields.push({ key: "title", value: `{${escapeBibtex(title)}}` });

  const venue = trimmed(publication.venue);
  const publisher = trimmed(publication.publisher);
  const pages = formatPages(publication.pages, "-");

  switch (publication.kind) {
    case "JOURNAL_ARTICLE":
      pushText("journal", venue);
      pushText("volume", publication.volume);
      pushText("number", publication.issue);
      pushText("pages", pages ? pages.replace(/-/g, "--") : null);
      pushText("publisher", publisher);
      pushText("issn", publication.issn);
      break;
    case "CONFERENCE_PAPER":
      pushText("booktitle", venue);
      pushText("volume", publication.volume);
      pushText("pages", pages ? pages.replace(/-/g, "--") : null);
      pushText("publisher", publisher);
      break;
    case "BOOK":
      pushText("publisher", publisher);
      pushText("volume", publication.volume);
      pushText("isbn", publication.isbn);
      break;
    case "BOOK_CHAPTER":
      pushText("booktitle", venue);
      pushText("publisher", publisher);
      pushText("pages", pages ? pages.replace(/-/g, "--") : null);
      pushText("isbn", publication.isbn);
      break;
    case "PATENT":
      pushText("number", publication.patentNumber);
      pushText("holder", publisher);
      break;
    case "THESIS":
      pushText("school", institutionOf(publication));
      break;
    case "REPORT":
      pushText("institution", institutionOf(publication));
      pushText("number", publication.issue ?? publication.volume);
      break;
    case "DATASET":
    case "SOFTWARE":
      pushText("howpublished", publisher ?? venue);
      break;
    case "PREPRINT": {
      pushText("howpublished", venue ?? "Preprint");
      const arxiv = normaliseArxiv(publication.arxivId);
      if (arxiv) {
        pushText("eprint", arxiv);
        // biblatex and revtex both key off archivePrefix; without it an eprint is just an opaque id.
        pushText("archivePrefix", "arXiv");
      }
      break;
    }
    default:
      break;
  }

  if (Number.isFinite(publication.year)) {
    fields.push({ key: "year", value: String(Math.trunc(publication.year)) });
  }
  const monthIndex = typeof publication.month === "number" ? Math.trunc(publication.month) - 1 : -1;
  const monthAbbreviation = monthIndex >= 0 ? MONTH_ABBREVIATIONS[monthIndex] : undefined;
  if (monthAbbreviation) {
    // Braced rather than emitted as the bare `jan` macro: the macro is only defined by classic .bst
    // files, and an undefined control sequence stops a LaTeX run dead.
    fields.push({ key: "month", value: monthAbbreviation });
  }

  pushText("doi", normaliseDoi(publication.doi));
  pushText("url", publication.url);
  const keywords = publication.keywords?.filter((keyword) => trimmed(keyword)) ?? [];
  if (keywords.length > 0) pushText("keywords", keywords.join(", "));

  const width = fields.reduce((longest, field) => Math.max(longest, field.key.length), 0);
  const lines = fields.map(
    (field, index) =>
      `  ${field.key.padEnd(width)} = {${field.value}}${index === fields.length - 1 ? "" : ","}`
  );

  return `@${entryType}{${citationKey(publication)},\n${lines.join("\n")}\n}`;
}

/**
 * The BibTeX a reader should be given: the stored string when there is one, a generated entry when
 * there is not.
 *
 * This exists so the rule is mechanical rather than remembered. Call this from cards, detail pages
 * and export routes; call `generateBibtex` directly only in the studio, where showing an editor what
 * would be generated is the point.
 */
export function resolveBibtex(publication: CitablePublication): string {
  return trimmed(publication.bibtex) ?? generateBibtex(publication);
}

// ─────────────────────────────────────────────────────────────────────────────
// Human-readable styles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a citation as a plain string the reader can copy.
 *
 * The punctuation is the deliverable. In an academic setting a citation with the wrong stops is worse
 * than no citation at all: it reads as carelessness about the source itself, and a reader who spots
 * one stops trusting the rest of the page. Each style below is written out per kind rather than
 * assembled from a shared template, because the differences are not decorative — APA ends a DOI with
 * no full stop, Chicago ends with one; MLA and IEEE put the comma inside the closing quotation mark
 * while the container that follows differs entirely.
 */
export function formatCitation(publication: CitablePublication, style: CitationStyle): string {
  const authors = parseAuthorLine(publication.authorLine);
  switch (style) {
    case "apa":
      return apaCitation(publication, authors);
    case "mla":
      return mlaCitation(publication, authors);
    case "chicago":
      return chicagoCitation(publication, authors);
    case "ieee":
      return ieeeCitation(publication, authors);
    default:
      return apaCitation(publication, authors);
  }
}

/** The bracketed descriptor APA requires for anything that is not an article, book or chapter. */
function apaDescriptor(kind: PublicationKind): string | null {
  switch (kind) {
    case "CONFERENCE_PAPER":
      return "[Conference paper]";
    case "DATASET":
      return "[Data set]";
    case "SOFTWARE":
      return "[Computer software]";
    case "PREPRINT":
      return "[Preprint]";
    case "REPORT":
      return "[Report]";
    default:
      return null;
  }
}

function apaCitation(publication: CitablePublication, authors: readonly ParsedAuthor[]): string {
  const lead = formatAuthorsForStyle(authors, "apa");
  const year = yearLabel(publication.year);
  const title = tidy(publication.title);
  const venue = trimmed(publication.venue);
  const publisher = trimmed(publication.publisher);
  const pages = formatPages(publication.pages, "–");
  const link = preferredLink(publication);

  // With no author, APA moves the title into the author slot and the date follows it. Leaving the
  // slot empty would open the entry with "(2019)." and file it under nothing.
  const head = lead ? `${terminate(lead)} (${year}).` : `${terminate(title)} (${year}).`;

  const parts: (string | null)[] = [head];

  if (lead) {
    const descriptor = apaDescriptor(publication.kind);
    if (publication.kind === "PATENT") {
      const number = trimmed(publication.patentNumber);
      parts.push(terminate(number ? `${title} (Patent No. ${number})` : title));
    } else if (publication.kind === "THESIS") {
      const institution = institutionOf(publication);
      parts.push(
        terminate(institution ? `${title} [Doctoral thesis, ${institution}]` : `${title} [Doctoral thesis]`)
      );
    } else {
      parts.push(terminate(descriptor ? `${title} ${descriptor}` : title));
    }
  }

  switch (publication.kind) {
    case "JOURNAL_ARTICLE":
    case "PREPRINT": {
      const container = venue ?? (publication.kind === "PREPRINT" ? "arXiv" : null);
      if (container) {
        let line = container;
        const volume = trimmed(publication.volume);
        const issue = trimmed(publication.issue);
        if (volume) line += `, ${volume}${issue ? `(${issue})` : ""}`;
        if (pages) line += `, ${pages}`;
        parts.push(terminate(line));
      }
      break;
    }
    case "CONFERENCE_PAPER":
      parts.push(venue ? terminate(venue) : null);
      parts.push(publisher ? terminate(publisher) : null);
      break;
    case "BOOK":
      parts.push(publisher ? terminate(publisher) : null);
      break;
    case "BOOK_CHAPTER": {
      if (venue) parts.push(terminate(pages ? `In ${venue} (pp. ${pages})` : `In ${venue}`));
      parts.push(publisher ? terminate(publisher) : null);
      break;
    }
    case "THESIS":
      // The institution is already inside the bracketed descriptor; repeating it would read as two
      // different awarding bodies.
      break;
    case "PATENT":
    case "DATASET":
    case "SOFTWARE":
    case "REPORT":
      parts.push(publisher ? terminate(publisher) : venue ? terminate(venue) : null);
      break;
    default:
      parts.push(publisher ? terminate(publisher) : null);
      break;
  }

  // APA 7 takes NO full stop after a DOI or URL — a trailing dot has been clicked as part of the link
  // often enough that the style removed it.
  parts.push(link);
  return joinParts(parts);
}

/**
 * Is this work's own title the container — set plain here, italic in a typeset bibliography — rather
 * than a part quoted inside a larger container?
 *
 * Style-dependent, because the three quoting styles disagree about exactly two kinds and getting
 * either wrong is the sort of error a supervisor circles in red.
 */
function isStandaloneWork(kind: PublicationKind, style: CitationStyle): boolean {
  switch (kind) {
    case "BOOK":
    case "DATASET":
    case "SOFTWARE":
    case "PATENT":
      return true;
    case "THESIS":
      // MLA treats a dissertation as a self-contained work and italicises it. Chicago and IEEE both
      // quote the title and put the degree in the container that follows.
      return style === "mla";
    case "REPORT":
      // IEEE quotes a technical report's title; MLA and Chicago set it as a work in its own right.
      return style !== "ieee";
    default:
      return false;
  }
}

function mlaCitation(publication: CitablePublication, authors: readonly ParsedAuthor[]): string {
  const lead = formatAuthorsForStyle(authors, "mla");
  const year = yearLabel(publication.year);
  const title = tidy(publication.title);
  const venue = trimmed(publication.venue);
  const publisher = trimmed(publication.publisher);
  const pages = formatPages(publication.pages, "-");
  const link = preferredLink(publication);

  const volume = trimmed(publication.volume);
  const issue = trimmed(publication.issue);

  // `terminate` rather than a bare "." — a lead ending in an initial ("Roy, A.") or in "et al."
  // already carries its stop, and "et al.." is the classic tell of a concatenated bibliography.
  const head = lead ? `${terminate(lead)} ` : "";
  const titlePart = isStandaloneWork(publication.kind, "mla")
    ? terminate(title)
    : quoteTitle(title, ".");

  // MLA's container is a comma-separated list closed by a single full stop, so every element is
  // pushed bare and the stop is added exactly once at the end.
  const container: (string | null)[] = [];

  switch (publication.kind) {
    case "JOURNAL_ARTICLE":
      container.push(venue);
      container.push(volume ? `vol. ${volume}` : null);
      container.push(issue ? `no. ${issue}` : null);
      container.push(year);
      container.push(pages ? `${pageLabel(pages)} ${pages}` : null);
      break;
    case "PREPRINT":
      container.push(venue ?? "arXiv");
      container.push(year);
      break;
    case "CONFERENCE_PAPER":
      container.push(venue);
      container.push(publisher);
      container.push(year);
      container.push(pages ? `${pageLabel(pages)} ${pages}` : null);
      break;
    case "BOOK_CHAPTER":
      container.push(venue);
      container.push(publisher);
      container.push(year);
      container.push(pages ? `${pageLabel(pages)} ${pages}` : null);
      break;
    case "THESIS":
      container.push(year);
      container.push(institutionOf(publication));
      container.push("PhD dissertation");
      break;
    case "PATENT": {
      const number = trimmed(publication.patentNumber);
      container.push(number ? `Patent no. ${number}` : null);
      container.push(publisher);
      container.push(year);
      break;
    }
    default:
      container.push(publisher ?? venue);
      container.push(year);
      break;
  }

  container.push(link);

  const tail = container.filter((part): part is string => Boolean(part && part.trim())).join(", ");
  return tail ? `${head}${titlePart} ${tail}.` : `${head}${titlePart}`;
}

function chicagoCitation(publication: CitablePublication, authors: readonly ParsedAuthor[]): string {
  const lead = formatAuthorsForStyle(authors, "chicago");
  const year = yearLabel(publication.year);
  const title = tidy(publication.title);
  const venue = trimmed(publication.venue);
  const publisher = trimmed(publication.publisher);
  const pages = formatPages(publication.pages, "–");
  const link = preferredLink(publication);

  const head = lead ? `${terminate(lead)} ` : "";
  const titlePart = isStandaloneWork(publication.kind, "chicago")
    ? terminate(title)
    : quoteTitle(title, ".");
  const parts: (string | null)[] = [`${head}${titlePart}`];

  switch (publication.kind) {
    case "JOURNAL_ARTICLE": {
      // Chicago's journal locator is unpunctuated between the venue and the volume, parenthesises the
      // year, and takes a COLON before the pages — none of which any other style here does.
      let line = venue ?? "";
      const volume = trimmed(publication.volume);
      const issue = trimmed(publication.issue);
      if (volume) line += line ? ` ${volume}` : volume;
      if (issue) line += `, no. ${issue}`;
      line += line ? ` (${year})` : `(${year})`;
      if (pages) line += `: ${pages}`;
      parts.push(terminate(line));
      break;
    }
    case "PREPRINT":
      parts.push(terminate(venue ? `Preprint, ${venue}, ${year}` : `Preprint, ${year}`));
      break;
    case "CONFERENCE_PAPER":
      parts.push(terminate(venue ? `Paper presented at ${venue}, ${year}` : `Paper presented in ${year}`));
      break;
    case "BOOK_CHAPTER": {
      if (venue) parts.push(terminate(pages ? `In ${venue}, ${pages}` : `In ${venue}`));
      parts.push(terminate(publisher ? `${publisher}, ${year}` : year));
      break;
    }
    case "THESIS": {
      // An unrecorded institution drops out of the entry rather than becoming a placeholder — a
      // citation that says "unknown university" invites a reader to doubt the whole reference.
      const institution = institutionOf(publication);
      parts.push(terminate(institution ? `PhD diss., ${institution}, ${year}` : `PhD diss., ${year}`));
      break;
    }
    case "PATENT": {
      const number = trimmed(publication.patentNumber);
      parts.push(terminate(number ? `Patent ${number}, issued ${year}` : `Patent issued ${year}`));
      break;
    }
    default:
      parts.push(terminate(publisher ? `${publisher}, ${year}` : year));
      break;
  }

  // Chicago DOES close the entry with a full stop after the DOI or URL — the opposite of APA.
  parts.push(link ? terminate(link) : null);
  return joinParts(parts);
}

function ieeeCitation(publication: CitablePublication, authors: readonly ParsedAuthor[]): string {
  const lead = formatAuthorsForStyle(authors, "ieee");
  const year = yearLabel(publication.year);
  const title = tidy(publication.title);
  const venue = trimmed(publication.venue);
  const publisher = trimmed(publication.publisher);
  const pages = formatPages(publication.pages, "-");
  const doi = normaliseDoi(publication.doi);
  const url = trimmed(publication.url);
  const volume = trimmed(publication.volume);
  const issue = trimmed(publication.issue);

  const head = lead ? `${lead}, ` : "";
  // IEEE quotes the titles of parts and sets the titles of whole works plain, and the comma that ends
  // a quoted title lives inside the quotation mark — it is the separator, so nothing is added after.
  const titlePart = isStandaloneWork(publication.kind, "ieee")
    ? terminate(title)
    : quoteTitle(title, ",");

  const tail: (string | null)[] = [];

  switch (publication.kind) {
    case "JOURNAL_ARTICLE":
      tail.push(venue);
      tail.push(volume ? `vol. ${volume}` : null);
      tail.push(issue ? `no. ${issue}` : null);
      tail.push(pages ? `${pageLabel(pages)} ${pages}` : null);
      tail.push(year);
      break;
    case "CONFERENCE_PAPER":
      tail.push(venue ? `in ${venue}` : null);
      tail.push(year);
      tail.push(pages ? `${pageLabel(pages)} ${pages}` : null);
      break;
    case "BOOK_CHAPTER":
      tail.push(venue ? `in ${venue}` : null);
      tail.push(publisher);
      tail.push(year);
      tail.push(pages ? `${pageLabel(pages)} ${pages}` : null);
      break;
    case "THESIS":
      tail.push("Ph.D. dissertation");
      tail.push(institutionOf(publication));
      tail.push(year);
      break;
    case "REPORT":
      tail.push(institutionOf(publication));
      tail.push("Tech. Rep.");
      tail.push(issue ?? volume);
      tail.push(year);
      break;
    case "PATENT": {
      const number = trimmed(publication.patentNumber);
      tail.push(number ? `Patent ${number}` : "Patent");
      tail.push(year);
      break;
    }
    case "PREPRINT": {
      const arxiv = normaliseArxiv(publication.arxivId);
      tail.push(arxiv ? `arXiv:${arxiv}` : (venue ?? "preprint"));
      tail.push(year);
      break;
    }
    default:
      tail.push(publisher ?? venue);
      tail.push(year);
      break;
  }

  if (doi) tail.push(`doi: ${doi}`);

  const body = tail.filter((part): part is string => Boolean(part && part.trim())).join(", ");
  const sentence = body ? `${head}${titlePart} ${terminate(body)}` : `${head}${terminate(titlePart)}`;

  // IEEE cites a bare URL as an availability note rather than inline, and only when there is no DOI —
  // two links on one reference sends the reader to the same place twice.
  if (!doi && url) return `${sentence} [Online]. Available: ${url}`;
  return sentence;
}

// ─────────────────────────────────────────────────────────────────────────────
// Card line
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The single line a publication card shows under its title.
 *
 * Returns null rather than a placeholder when there is nothing to say, so the caller can close the
 * gap instead of rendering an em dash that looks like missing data.
 *
 * The year is deliberately NOT included: every list row and card in this product renders `year` as
 * its own column or chip, and repeating it here reads as a duplication bug. Neither is the kind, for
 * the same reason — it is a chip beside the title.
 */
export function publicationDisplayVenue(publication: CitablePublication): string | null {
  const venue = trimmed(publication.venue);
  const publisher = trimmed(publication.publisher);

  switch (publication.kind) {
    case "JOURNAL_ARTICLE": {
      if (!venue) return null;
      const volume = trimmed(publication.volume);
      const issue = trimmed(publication.issue);
      if (!volume) return venue;
      return `${venue}, ${volume}${issue ? `(${issue})` : ""}`;
    }
    case "CONFERENCE_PAPER":
      return venue ?? publisher;
    case "BOOK":
      return publisher ?? venue;
    case "BOOK_CHAPTER":
      return venue ? `In ${venue}` : publisher;
    case "PATENT": {
      const number = trimmed(publication.patentNumber);
      return number ? `Patent ${number}` : (publisher ?? venue);
    }
    case "PREPRINT": {
      if (venue) return venue;
      const arxiv = normaliseArxiv(publication.arxivId);
      return arxiv ? `arXiv:${arxiv}` : null;
    }
    case "THESIS":
    case "REPORT":
      return institutionOf(publication);
    case "DATASET":
    case "SOFTWARE":
      return publisher ?? venue;
    default:
      return venue ?? publisher;
  }
}
