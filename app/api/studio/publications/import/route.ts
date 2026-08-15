import type { NextRequest } from "next/server";
import { z } from "zod";
import type { PublicationKind } from "@prisma/client";
import { prisma } from "@/lib/db";
import { assertSameOrigin, clientIp, ok, parseJson, route, userAgent } from "@/lib/api";
import { mutateWithHistory, type AuditContext } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { canManageResearch } from "@/lib/permissions";
import { enforceRateLimit } from "@/lib/ratelimit";
import { indexDocument, searchDocFromPublication } from "@/lib/search/index";
import { parseAuthorLine } from "@/lib/citation";
import { slugify, unique } from "@/lib/utils";

/**
 * Importing publications from pasted BibTeX or a list of DOIs.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT IS A TWO-STEP CONTRACT AND THE FIRST STEP CREATES NOTHING.
 *
 *   • `POST …/import?dryRun=1` — reads the paste and answers what it found, with a duplicate verdict per
 *     row. Nothing is written. A body with no `keys` array is treated as a dry run too, so the two
 *     spellings of "just tell me" cannot disagree.
 *   • `POST …/import` with `{ source, text, keys: [...] }` — re-reads the SAME paste and imports the rows
 *     whose keys are listed.
 *
 * THE IMPORT TAKES KEYS, NOT RECORDS, and re-parses the text. Anything else would mean trusting a browser
 * to describe the record it is asking to have created — a client that had edited the parsed rows on the
 * way back could write anything into a citation.
 *
 * EVERY ROW COMES BACK NAMED, whether it was created, skipped or refused, each with its own sentence.
 * "12 imported" cannot be checked and says nothing about the thirteenth (contract §1.6). The same applies
 * to entries that could not be read at all: they are listed with their source text, never merely counted.
 *
 * DUPLICATES ARE MATCHED ON THE DOI FIRST, then on the normalised title and year. A DOI is the one
 * identifier that cannot be typed two ways; the title fallback ignores punctuation and capitalisation
 * because the same paper pasted from two reference managers differs by a colon and a capital letter. A
 * duplicate is REPORTED, never refused: a preprint and its published version are two legitimate records,
 * so the row arrives unticked and the reader decides.
 *
 * ⚠ THE BIBTEX SOURCE OF EACH ENTRY IS STORED VERBATIM. An imported record carries a canonical citation
 * key that other people's manuscripts already `\cite{}`, and `lib/citation.ts` only generates one when
 * the column is empty. Regenerating it would silently break their bibliography.
 *
 * EVERYTHING IMPORTED IS A DRAFT with no research area and no linked people. An import is a bibliographic
 * record, not an editorial decision, and a citation nobody has read should not be on the public site.
 *
 * ⚠ ONE THING ANOTHER AGENT MUST KNOW: `app/studio/publications/import/ImportWorkbench.tsx` calls
 * `/api/studio/publications/import/preview` for the first step. This route answers the same thing at
 * `…/import?dryRun=1`. Either that one line in the workbench changes, or a three-line
 * `import/preview/route.ts` has to forward to this handler. Both spellings are supported here so the fix
 * can be made on whichever side is cheaper.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * How many records one paste may contain.
 *
 * Stated in the answer as `limit` and reported as `truncated` when it bites, so a shortened list is never
 * mistaken for a complete one. 200 is a whole year's output for a Centre; past it the screen is a worse
 * tool than two pastes.
 */
const IMPORT_LIMIT = 200;

/** The whole paste. A megabyte of BibTeX is a mistake, not a bibliography. */
const MAX_TEXT_CHARS = 500_000;

/**
 * DOI resolution is bounded on both axes.
 *
 * Each DOI is one outbound request to doi.org, so a hundred of them is a hundred round trips and this is
 * the one route in the studio whose runtime is decided by somebody else's server. The per-request timeout
 * stops one unresponsive registration agency from holding the whole import; the total cap stops a paste of
 * a thousand DOIs from being attempted at all.
 */
const DOI_FETCH_TIMEOUT_MS = 8_000;
const DOI_FETCH_LIMIT = 60;

/** External calls, so this route has its own allowance rather than sharing one. */
const IMPORT_RATE_LIMIT = { limit: 12, windowSeconds: 10 * 60 };

const KIND_LABELS: Record<PublicationKind, string> = {
  JOURNAL_ARTICLE: "Journal article",
  CONFERENCE_PAPER: "Conference paper",
  BOOK: "Book",
  BOOK_CHAPTER: "Book chapter",
  PATENT: "Patent",
  DATASET: "Dataset",
  SOFTWARE: "Software",
  PREPRINT: "Preprint",
  THESIS: "Thesis",
  REPORT: "Report"
};

const RequestBody = z.object({
  source: z.enum(["bibtex", "doi"]),
  text: z
    .string()
    .min(1, "Paste something to import first.")
    .max(MAX_TEXT_CHARS, "That paste is too large to read. Import it in a few smaller batches."),
  /**
   * The rows to import. ABSENT means "just tell me what you found" — the same as `?dryRun=1`. An empty
   * ARRAY is different: it means "import exactly nothing", which is answered with an empty report rather
   * than with a preview, because the reader pressed Import.
   */
  keys: z.array(z.string().trim().min(1).max(300)).max(IMPORT_LIMIT).optional()
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The parsed record
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface Candidate {
  /** Unique WITHIN one paste, and stable across a re-parse of the same text — see the header. */
  key: string;
  kind: PublicationKind;
  title: string;
  authorLine: string;
  year: number | null;
  month: number | null;
  venue: string | null;
  publisher: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  doi: string | null;
  isbn: string | null;
  issn: string | null;
  arxivId: string | null;
  url: string | null;
  abstract: string | null;
  keywords: string[];
  /** The entry exactly as pasted, for BibTeX. Null for a DOI lookup, which has no canonical entry. */
  bibtex: string | null;
  /** Things worth seeing that do NOT stop an import. Never a silent correction. */
  problems: string[];
}

interface Unreadable {
  /** The offending text, trimmed to something a reader can recognise. */
  source: string;
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// BibTeX
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The ten characters BibTeX escapes, undone, plus the two macros lib/citation.ts emits.
 *
 * ONE pass, driven by a single regular expression, and that is load-bearing for the same reason the
 * escaping side is: sequential replaces would re-process the braces that `\textbackslash{}` introduces.
 */
function unescapeBibtex(value: string): string {
  return value
    .replace(/\\textbackslash\{\}/g, "\\")
    .replace(/\\textasciitilde\{\}/g, "~")
    .replace(/\\textasciicircum\{\}/g, "^")
    .replace(/\\([&%$#_{}])/g, "$1");
}

/**
 * A field value with its protective braces removed and its whitespace collapsed.
 *
 * The braces in `title = {{GANs for Bagru}}` exist to stop a `.bst` file lowercasing the title, so they
 * carry no meaning in the stored value and are stripped. A pasted entry is nearly always hard-wrapped, so
 * collapsing the newlines is what turns three lines into one title.
 */
function cleanValue(raw: string): string {
  return unescapeBibtex(raw.replace(/[{}]/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** BibTeX entry type → the kind this schema stores. `null` means "recognised as nothing in particular". */
function kindFromBibtexType(type: string): PublicationKind | null {
  switch (type.toLowerCase()) {
    case "article":
      return "JOURNAL_ARTICLE";
    case "inproceedings":
    case "conference":
      return "CONFERENCE_PAPER";
    case "book":
    case "proceedings":
      return "BOOK";
    case "incollection":
    case "inbook":
      return "BOOK_CHAPTER";
    case "patent":
      return "PATENT";
    case "phdthesis":
    case "mastersthesis":
    case "thesis":
      return "THESIS";
    case "techreport":
    case "manual":
      return "REPORT";
    case "dataset":
      return "DATASET";
    case "software":
      return "SOFTWARE";
    default:
      return null;
  }
}

/**
 * Split a BibTeX paste into `@type{…}` blocks by matching braces.
 *
 * A regular expression cannot do this: a field value legitimately contains braces, so `\{[^}]*\}` stops at
 * the first inner one and every entry with a protected title comes out truncated. Counting depth is the
 * only correct reading, and it also lets an UNCLOSED entry be reported by name instead of swallowing the
 * rest of the paste.
 */
function splitBibtexEntries(text: string): { type: string; body: string; source: string }[] {
  const entries: { type: string; body: string; source: string }[] = [];
  const pattern = /@([A-Za-z]+)\s*\{/g;

  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const type = match[1] ?? "";
    const open = match.index + match[0].length;
    let depth = 1;
    let index = open;

    while (index < text.length && depth > 0) {
      const character = text[index];
      if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
      index += 1;
    }

    if (depth !== 0) {
      // An unclosed entry. Reported by the caller rather than skipped, and the scan stops: everything
      // after it is inside the unterminated brace and cannot be read either.
      entries.push({ type, body: text.slice(open), source: text.slice(match.index, match.index + 200) });
      break;
    }

    entries.push({
      type,
      body: text.slice(open, index - 1),
      source: text.slice(match.index, index)
    });
    // Continue after this entry, so a nested `@` inside a field value is not read as a new entry.
    pattern.lastIndex = index;
  }

  return entries;
}

/**
 * The fields of one entry body, plus its citation key.
 *
 * The key is everything before the first comma. Fields are read by walking the body and matching braces or
 * quotes, because a value may contain commas — which is exactly what a `pages = {1,3,7}` field or any
 * author list does.
 */
function parseBibtexBody(body: string): { key: string; fields: Record<string, string> } {
  const firstComma = body.indexOf(",");
  const key = (firstComma === -1 ? body : body.slice(0, firstComma)).trim();
  const rest = firstComma === -1 ? "" : body.slice(firstComma + 1);

  const fields: Record<string, string> = {};
  let index = 0;

  while (index < rest.length) {
    // The field name.
    const nameMatch = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*/.exec(rest.slice(index));
    if (!nameMatch || nameMatch.index === undefined) break;
    const name = (nameMatch[1] ?? "").toLowerCase();
    let cursor = index + nameMatch.index + nameMatch[0].length;

    let value = "";
    const opener = rest[cursor];
    if (opener === "{") {
      let depth = 1;
      cursor += 1;
      const start = cursor;
      while (cursor < rest.length && depth > 0) {
        if (rest[cursor] === "{") depth += 1;
        else if (rest[cursor] === "}") depth -= 1;
        cursor += 1;
      }
      value = rest.slice(start, Math.max(start, cursor - 1));
    } else if (opener === '"') {
      cursor += 1;
      const start = cursor;
      while (cursor < rest.length && rest[cursor] !== '"') cursor += 1;
      value = rest.slice(start, cursor);
      cursor += 1;
    } else {
      // A bare value: a number, or a month macro such as `jan`.
      const start = cursor;
      while (cursor < rest.length && rest[cursor] !== ",") cursor += 1;
      value = rest.slice(start, cursor);
    }

    if (name.length > 0) fields[name] = value;

    // Step past the separating comma.
    const nextComma = rest.indexOf(",", cursor);
    if (nextComma === -1) break;
    index = nextComma + 1;
  }

  return { key, fields };
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function parseMonth(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = cleanValue(raw).toLowerCase();
  const numeric = Number.parseInt(value, 10);
  if (Number.isFinite(numeric) && numeric >= 1 && numeric <= 12) return numeric;
  const index = MONTH_NAMES.findIndex((name) => value.startsWith(name));
  return index === -1 ? null : index + 1;
}

function normaliseDoi(value: string | null | undefined): string | null {
  if (!value) return null;
  const bare = value
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim()
    .toLowerCase();
  return bare.length > 0 ? bare : null;
}

/**
 * BibTeX joins names with the literal word "and". `parseAuthorLine` treats a literal ";" as "the editor
 * punctuated this themselves" and stops guessing, so converting the separator here is what makes an
 * imported author line unambiguous — otherwise "Smith, J. and Doe, A." is one of the shapes the heuristic
 * has to guess at.
 */
function bibtexAuthorLine(raw: string | undefined): string {
  if (!raw) return "";
  return cleanValue(raw)
    .split(/\s+and\s+/i)
    .map((name) => name.trim())
    .filter(Boolean)
    .join("; ");
}

function candidateFromBibtex(
  entry: { type: string; body: string; source: string },
  fallbackKey: string
): Candidate {
  const { key, fields } = parseBibtexBody(entry.body);
  const problems: string[] = [];

  const kind = kindFromBibtexType(entry.type);
  if (!kind) {
    problems.push(
      `“@${entry.type}” is not a type this site records, so it has been filed as a report. Change the type after ` +
        "importing if something else fits better."
    );
  }

  const title = cleanValue(fields.title ?? "");
  if (title.length === 0) problems.push("This entry has no title. It will be created as “Untitled”.");

  const authorLine = bibtexAuthorLine(fields.author ?? fields.editor);
  if (authorLine.length === 0) {
    problems.push(
      "No authors were recorded in this entry. The author line is what every citation prints, so it will need " +
        "filling in before this is published."
    );
  }

  const yearRaw = cleanValue(fields.year ?? fields.date ?? "");
  const yearMatch = /\d{4}/.exec(yearRaw);
  const year = yearMatch ? Number.parseInt(yearMatch[0], 10) : null;
  if (year === null) problems.push("No year could be read from this entry, and a publication needs one.");

  const venue =
    cleanValue(fields.journal ?? fields.booktitle ?? fields.howpublished ?? fields.school ?? fields.institution ?? "") ||
    null;

  const arxiv = cleanValue(fields.eprint ?? fields.archiveprefix ?? "");
  const isArxiv = /arxiv/i.test(cleanValue(fields.archiveprefix ?? "")) || /^\d{4}\.\d{4,5}/.test(arxiv);

  return {
    key: key.length > 0 ? key : fallbackKey,
    // `@misc` with an arXiv eprint is a preprint in everything but name, which is worth getting right
    // because it changes how the citation reads.
    kind: kind ?? (isArxiv ? "PREPRINT" : "REPORT"),
    title: title.length > 0 ? title : "Untitled",
    authorLine,
    year,
    month: parseMonth(fields.month),
    venue,
    publisher: cleanValue(fields.publisher ?? fields.holder ?? "") || null,
    volume: cleanValue(fields.volume ?? "") || null,
    issue: cleanValue(fields.number ?? fields.issue ?? "") || null,
    // "1--10" is BibTeX's en dash. Stored with a single hyphen, which is what lib/citation.ts formats from.
    pages: cleanValue(fields.pages ?? "").replace(/-{2,}/g, "-") || null,
    doi: normaliseDoi(cleanValue(fields.doi ?? "")),
    isbn: cleanValue(fields.isbn ?? "") || null,
    issn: cleanValue(fields.issn ?? "") || null,
    arxivId: isArxiv && arxiv.length > 0 ? arxiv.replace(/^arxiv:?/i, "") : null,
    url: cleanValue(fields.url ?? "") || null,
    abstract: cleanValue(fields.abstract ?? "") || null,
    keywords: unique(
      cleanValue(fields.keywords ?? "")
        .split(/[,;]/)
        .map((word) => word.trim())
        .filter(Boolean)
    ).slice(0, 40),
    // VERBATIM. This is the record's canonical citation and its key. See the header.
    bibtex: entry.source.trim(),
    problems
  };
}

function readBibtex(text: string): { candidates: Candidate[]; unreadable: Unreadable[]; truncated: boolean } {
  const entries = splitBibtexEntries(text);
  const candidates: Candidate[] = [];
  const unreadable: Unreadable[] = [];
  const usedKeys = new Set<string>();

  entries.forEach((entry, index) => {
    if (candidates.length >= IMPORT_LIMIT) return;

    if (!entry.source.trimEnd().endsWith("}")) {
      unreadable.push({
        source: entry.source.slice(0, 160),
        reason:
          "This entry is missing its closing brace, so it and everything after it could not be read. Check the " +
          "braces and paste again."
      });
      return;
    }

    const candidate = candidateFromBibtex(entry, `row-${index + 1}`);

    // A key has to be unique within one paste and stable across a re-parse of the same text, because it is
    // what the import call ticks. A suffix derived from the position satisfies both.
    let key = candidate.key;
    if (usedKeys.has(key)) {
      let suffix = 2;
      while (usedKeys.has(`${key}#${suffix}`)) suffix += 1;
      candidate.problems.push(
        `Another entry in this paste uses the citation key “${key}”, so this one is listed separately. Both can be ` +
          "imported; check afterwards that they are really two different works."
      );
      key = `${key}#${suffix}`;
    }
    usedKeys.add(key);
    candidates.push({ ...candidate, key });
  });

  return {
    candidates,
    unreadable,
    truncated: entries.length > candidates.length + unreadable.length
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DOI resolution
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** CSL-JSON type → the kind this schema stores. */
function kindFromCslType(type: string | undefined): PublicationKind {
  switch ((type ?? "").toLowerCase()) {
    case "journal-article":
    case "article-journal":
      return "JOURNAL_ARTICLE";
    case "proceedings-article":
    case "paper-conference":
      return "CONFERENCE_PAPER";
    case "book":
    case "monograph":
      return "BOOK";
    case "chapter":
    case "book-chapter":
      return "BOOK_CHAPTER";
    case "dataset":
      return "DATASET";
    case "software":
      return "SOFTWARE";
    case "posted-content":
      return "PREPRINT";
    case "report":
      return "REPORT";
    case "thesis":
      return "THESIS";
    case "patent":
      return "PATENT";
    default:
      return "JOURNAL_ARTICLE";
  }
}

function firstString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === "string");
    return typeof first === "string" ? first.trim() || null : null;
  }
  return null;
}

interface CslName {
  family?: unknown;
  given?: unknown;
  literal?: unknown;
}

/**
 * Build the printed author line from CSL names, joined with "; ".
 *
 * The semicolon is deliberate: `parseAuthorLine` in lib/citation.ts reads a literal ";" as "the editor has
 * punctuated this explicitly" and stops guessing where one name ends and the next begins. Anything else
 * would hand an unambiguous list back to a heuristic.
 */
function cslAuthorLine(authors: unknown): string {
  if (!Array.isArray(authors)) return "";
  const names: string[] = [];
  for (const entry of authors) {
    if (!entry || typeof entry !== "object") continue;
    const name = entry as CslName;
    const literal = typeof name.literal === "string" ? name.literal.trim() : "";
    if (literal) {
      names.push(literal);
      continue;
    }
    const family = typeof name.family === "string" ? name.family.trim() : "";
    const given = typeof name.given === "string" ? name.given.trim() : "";
    if (family && given) names.push(`${family}, ${given}`);
    else if (family) names.push(family);
  }
  return names.join("; ");
}

/** `issued["date-parts"]` is `[[year, month, day]]`, and every part after the year is optional. */
function cslDate(issued: unknown): { year: number | null; month: number | null } {
  if (!issued || typeof issued !== "object") return { year: null, month: null };
  const parts = (issued as { "date-parts"?: unknown })["date-parts"];
  if (!Array.isArray(parts)) return { year: null, month: null };
  const first = parts[0];
  if (!Array.isArray(first)) return { year: null, month: null };
  const year = typeof first[0] === "number" ? first[0] : Number.parseInt(String(first[0] ?? ""), 10);
  const month = typeof first[1] === "number" ? first[1] : Number.parseInt(String(first[1] ?? ""), 10);
  return {
    year: Number.isFinite(year) ? year : null,
    month: Number.isFinite(month) && month >= 1 && month <= 12 ? month : null
  };
}

/**
 * Resolve one DOI through doi.org's content negotiation.
 *
 * `doi.org` redirects to whichever registration agency owns the prefix, and every one of them answers
 * CSL-JSON for this `Accept` header — which is why this is asked of doi.org rather than of Crossref
 * directly: a DataCite DOI (every dataset) is not in Crossref at all.
 */
async function resolveDoi(doi: string): Promise<Candidate | { reason: string }> {
  let response: Response;
  try {
    response = await fetch(`https://doi.org/${encodeURIComponent(doi)}`, {
      headers: { accept: "application/vnd.citationstyles.csl+json" },
      redirect: "follow",
      cache: "no-store",
      // A stall on somebody else's server must not hold the whole import. `AbortSignal.timeout` is the
      // whole-request deadline, which is right here: the answer is a few kilobytes, so a slow one is a
      // broken one.
      signal: AbortSignal.timeout(DOI_FETCH_TIMEOUT_MS)
    });
  } catch {
    return {
      reason:
        "The lookup could not reach doi.org, or it took too long to answer. Nothing was created for this DOI — " +
        "try it again, or add the record by hand."
    };
  }

  if (response.status === 404) {
    return {
      reason: "doi.org does not know this DOI. Check it against the published paper — a transposed digit is common."
    };
  }
  if (!response.ok) {
    return { reason: `doi.org answered HTTP ${response.status} for this DOI, so nothing could be read from it.` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { reason: "doi.org answered with something that was not a citation record." };
  }
  if (!payload || typeof payload !== "object") {
    return { reason: "doi.org answered with something that was not a citation record." };
  }

  const record = payload as Record<string, unknown>;
  const problems: string[] = [];

  const title = firstString(record.title) ?? "";
  if (title.length === 0) problems.push("The lookup returned no title. It will be created as “Untitled”.");

  const authorLine = cslAuthorLine(record.author);
  if (authorLine.length === 0) {
    problems.push(
      "The lookup returned no authors. The author line is what every citation prints, so it will need filling in " +
        "before this is published."
    );
  }

  const { year, month } = cslDate(record.issued);
  if (year === null) problems.push("The lookup returned no year, and a publication needs one.");

  return {
    // The DOI is the key: unique within one paste and identical on a re-parse, which is what the import
    // call needs it to be.
    key: doi,
    kind: kindFromCslType(typeof record.type === "string" ? record.type : undefined),
    title: title.length > 0 ? title : "Untitled",
    authorLine,
    year,
    month,
    venue: firstString(record["container-title"]),
    publisher: firstString(record.publisher),
    volume: firstString(record.volume),
    issue: firstString(record.issue),
    pages: firstString(record.page),
    doi,
    isbn: firstString(record.ISBN),
    issn: firstString(record.ISSN),
    arxivId: null,
    url: firstString(record.URL),
    // Publishers commonly ship the abstract as a JATS fragment. The tags are stripped; the prose is kept.
    abstract: firstString(record.abstract)?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? null,
    keywords: [],
    // No canonical BibTeX from a lookup, so the column is left empty and lib/citation.ts generates an entry
    // at read time. That is the correct outcome: there is no third-party key to preserve.
    bibtex: null,
    problems
  };
}

async function readDois(
  text: string,
  wanted: ReadonlySet<string> | null
): Promise<{ candidates: Candidate[]; unreadable: Unreadable[]; truncated: boolean }> {
  const lines = text
    .split(/[\r\n,;]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const unreadable: Unreadable[] = [];
  const dois: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const doi = normaliseDoi(line);
    if (!doi || !/^10\.\d{4,9}\/\S+$/.test(doi)) {
      unreadable.push({
        source: line.slice(0, 160),
        reason: "This is not a DOI. A DOI looks like “10.1234/something”, one to a line."
      });
      continue;
    }
    if (seen.has(doi)) continue;
    seen.add(doi);
    dois.push(doi);
  }

  const truncated = dois.length > DOI_FETCH_LIMIT;
  // Only the rows that were ticked are looked up on the import step. A dry run looks up everything,
  // because that is the question it was asked.
  const toFetch = (wanted ? dois.filter((doi) => wanted.has(doi)) : dois).slice(0, DOI_FETCH_LIMIT);

  const candidates: Candidate[] = [];
  for (const doi of toFetch) {
    // Sequential, on purpose: sixty parallel requests to one registration agency is a good way to be rate
    // limited by it, and the wall-clock cost is paid once by the person who chose to paste sixty DOIs.
    const result = await resolveDoi(doi);
    if ("reason" in result) unreadable.push({ source: doi, reason: result.reason });
    else candidates.push(result);
  }

  return { candidates, unreadable, truncated };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Duplicate detection
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A title reduced to something two reference managers would agree on: letters, digits and single spaces.
 *
 * The same paper exported from two tools differs by a colon, a capital letter, a non-breaking space or a
 * pair of protective braces. None of those is a different paper.
 */
function normaliseTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

interface Verdict {
  duplicateOf: { id: string; title: string; year: number | null } | null;
  matchedOn: "doi" | "title-year" | null;
}

/**
 * Match every candidate against what is already here: the DOI first, then the normalised title and year.
 *
 * Two queries for the whole batch rather than two per row — a paste of two hundred records would otherwise
 * be four hundred round trips. The title comparison is done in memory because the normalisation is not
 * something the database can index on.
 */
async function findDuplicates(candidates: readonly Candidate[]): Promise<Map<string, Verdict>> {
  const verdicts = new Map<string, Verdict>();
  for (const candidate of candidates) verdicts.set(candidate.key, { duplicateOf: null, matchedOn: null });

  const dois = unique(candidates.map((candidate) => candidate.doi).filter((doi): doi is string => Boolean(doi)));
  const years = unique(
    candidates.map((candidate) => candidate.year).filter((year): year is number => year !== null)
  );

  const [byDoi, byYear] = await Promise.all([
    dois.length > 0
      ? prisma.publication.findMany({
          where: { doi: { in: dois }, deletedAt: null },
          select: { id: true, title: true, year: true, doi: true }
        })
      : Promise.resolve([]),
    years.length > 0
      ? prisma.publication.findMany({
          where: { year: { in: years }, deletedAt: null },
          select: { id: true, title: true, year: true }
        })
      : Promise.resolve([])
  ]);

  const doiIndex = new Map(byDoi.map((row) => [row.doi ?? "", row]));
  const titleIndex = new Map<string, { id: string; title: string; year: number }>();
  for (const row of byYear) {
    const key = `${row.year}::${normaliseTitle(row.title)}`;
    // The FIRST match wins, so the verdict is stable rather than depending on query order.
    if (!titleIndex.has(key)) titleIndex.set(key, row);
  }

  for (const candidate of candidates) {
    if (candidate.doi) {
      const match = doiIndex.get(candidate.doi);
      if (match) {
        verdicts.set(candidate.key, {
          duplicateOf: { id: match.id, title: match.title, year: match.year },
          matchedOn: "doi"
        });
        continue;
      }
    }
    if (candidate.year !== null) {
      const match = titleIndex.get(`${candidate.year}::${normaliseTitle(candidate.title)}`);
      if (match) {
        verdicts.set(candidate.key, {
          duplicateOf: { id: match.id, title: match.title, year: match.year },
          matchedOn: "title-year"
        });
      }
    }
  }

  return verdicts;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Slugs
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A readable address: first author's surname, the year, and the first few words of the title.
 *
 * Readable rather than a bare citation key, because this string is the public address and is what somebody
 * else's bibliography records. It is uniquified with a numeric suffix rather than refused: two papers by
 * the same author in the same year with similar titles is an ordinary thing, and an import that stopped
 * dead on the second one would be worse than an address ending in "-2".
 */
async function uniqueSlug(candidate: Candidate, taken: Set<string>): Promise<string> {
  const surname = parseAuthorLine(candidate.authorLine)[0]?.family ?? "";
  const words = candidate.title.split(/\s+/).slice(0, 4).join(" ");
  const base =
    slugify([surname, candidate.year ?? "", words].filter(Boolean).join(" ")) ||
    slugify(candidate.title) ||
    "publication";

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const proposal = attempt === 0 ? base : `${base}-${attempt + 1}`;
    if (taken.has(proposal)) continue;
    const clash = await prisma.publication.findUnique({ where: { slug: proposal }, select: { id: true } });
    if (!clash) {
      taken.add(proposal);
      return proposal;
    }
    taken.add(proposal);
  }

  const fallback = `${base}-${Date.now().toString(36)}`;
  taken.add(fallback);
  return fallback;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The handler
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface Outcome {
  key: string;
  title: string;
  outcome: "created" | "skipped" | "failed";
  id: string | null;
  message: string | null;
}

const INDEX_SELECT = {
  id: true,
  slug: true,
  title: true,
  kind: true,
  abstract: true,
  authorLine: true,
  venue: true,
  publisher: true,
  year: true,
  doi: true,
  arxivId: true,
  keywords: true,
  status: true,
  publishedAt: true,
  deletedAt: true,
  researchArea: { select: { title: true } }
} as const;

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageResearch,
    "Importing publications needs researcher access or higher. An administrator can raise yours."
  );

  // This route makes outbound requests on the DOI path, so it has its own allowance. Applied before the
  // body is read: a refusal should cost as little as possible.
  const limited = enforceRateLimit(
    request,
    "publication-import",
    IMPORT_RATE_LIMIT,
    (phrase) =>
      `That is a lot of imports in a short time, so this is paused for a moment. Try again in ${phrase} — ` +
      "everything already imported has been kept."
  );
  if (limited) return limited;

  const body = await parseJson(request, RequestBody);

  const url = new URL(request.url);
  const dryRunFlag = ["1", "true", "yes"].includes((url.searchParams.get("dryRun") ?? "").toLowerCase());
  // No `keys` at all means "just tell me what you found". An empty array means "import nothing", which is
  // a real answer to the Import button and is reported as such.
  const dryRun = dryRunFlag || body.keys === undefined;
  const wanted = body.keys === undefined ? null : new Set(body.keys);

  const read =
    body.source === "bibtex"
      ? readBibtex(body.text)
      : await readDois(body.text, dryRun ? null : wanted);

  const verdicts = await findDuplicates(read.candidates);

  // ── The dry run ────────────────────────────────────────────────────────────────────────────────
  if (dryRun) {
    return ok({
      candidates: read.candidates.map((candidate) => {
        const verdict = verdicts.get(candidate.key) ?? { duplicateOf: null, matchedOn: null };
        return {
          key: candidate.key,
          kind: candidate.kind,
          kindLabel: KIND_LABELS[candidate.kind],
          title: candidate.title,
          authorLine: candidate.authorLine,
          year: candidate.year,
          venue: candidate.venue,
          doi: candidate.doi,
          problems: candidate.problems,
          duplicateOf: verdict.duplicateOf,
          matchedOn: verdict.matchedOn
        };
      }),
      // NAMED, never merely counted. Each entry carries the text that could not be read.
      unreadable: read.unreadable,
      truncated: read.truncated,
      limit: body.source === "bibtex" ? IMPORT_LIMIT : DOI_FETCH_LIMIT
    });
  }

  // ── The import ─────────────────────────────────────────────────────────────────────────────────
  const keys = body.keys ?? [];
  const byKey = new Map(read.candidates.map((candidate) => [candidate.key, candidate]));
  const results: Outcome[] = [];
  const takenSlugs = new Set<string>();
  const createdDois = new Set<string>();

  const context: AuditContext = {
    actor: { id: user.id, email: user.email },
    ipAddress: clientIp(request),
    userAgent: userAgent(request)
  };

  for (const key of keys) {
    const candidate = byKey.get(key);

    if (!candidate) {
      // The paste is re-read on this step, so a key that is no longer in it means the text changed between
      // checking and importing. Said plainly rather than silently dropped.
      const failure = read.unreadable.find((entry) => entry.source === key);
      results.push({
        key,
        title: key,
        outcome: "skipped",
        id: null,
        message:
          failure?.reason ??
          "This row is not in the paste any more, so nothing was created for it. Check the paste again and re-import it."
      });
      continue;
    }

    if (candidate.year === null) {
      results.push({
        key,
        title: candidate.title,
        outcome: "failed",
        id: null,
        message:
          "A publication needs a year and none could be read from this entry. Add the year to the entry and import " +
          "it again, or create the record by hand."
      });
      continue;
    }

    if (candidate.doi && createdDois.has(candidate.doi)) {
      results.push({
        key,
        title: candidate.title,
        outcome: "skipped",
        id: null,
        message: `Another row in this batch has already been created with the DOI ${candidate.doi}, so this one was left out.`
      });
      continue;
    }

    try {
      const slug = await uniqueSlug(candidate, takenSlugs);
      const year = candidate.year;

      const created = await mutateWithHistory<{ id: string; title: string; slug: string }>(
        context,
        {
          action: "CREATE",
          entityType: "Publication",
          entityLabel: candidate.title,
          summary: body.source === "bibtex" ? "Imported from BibTeX" : "Imported from a DOI"
        },
        async (tx) => {
          const row = await tx.publication.create({
            data: {
              title: candidate.title,
              slug,
              kind: candidate.kind,
              abstract: candidate.abstract,
              authorLine: candidate.authorLine,
              venue: candidate.venue,
              publisher: candidate.publisher,
              volume: candidate.volume,
              issue: candidate.issue,
              pages: candidate.pages,
              year,
              month: candidate.month,
              doi: candidate.doi,
              isbn: candidate.isbn,
              issn: candidate.issn,
              arxivId: candidate.arxivId,
              url: candidate.url,
              // Verbatim, or empty. See the header: the stored entry carries a key other people cite.
              bibtex: candidate.bibtex,
              keywords: candidate.keywords,
              // A DRAFT, with no research area and no linked people. An import is a bibliographic record,
              // not an editorial decision.
              status: "DRAFT",
              publishedAt: null
            },
            select: INDEX_SELECT
          });

          await indexDocument(tx, searchDocFromPublication(row));
          return { id: row.id, title: row.title, slug: row.slug };
        }
      );

      if (candidate.doi) createdDois.add(candidate.doi);
      results.push({
        key,
        title: created.title,
        outcome: "created",
        id: created.id,
        message:
          candidate.problems.length > 0
            ? // The problems travel with the outcome, so a record created with a gap in it says so on the
              // report rather than only on the table that has now been retired.
              `Created as a draft at /publications/${created.slug}. ${candidate.problems.join(" ")}`
            : `Created as a draft at /publications/${created.slug}.`
      });
    } catch (error) {
      // One row failing must not abandon the rest — a `Promise.all` here would leave an unknowable number
      // created and no list of which.
      results.push({
        key,
        title: candidate.title,
        outcome: "failed",
        id: null,
        message:
          error instanceof Error && error.message.length < 300
            ? `This one could not be created: ${error.message}`
            : "This one could not be created. Nothing was written for it; try importing it on its own to see why."
      });
      console.error("[publications/import] a row could not be created", key, error);
    }
  }

  return ok({ results });
});
