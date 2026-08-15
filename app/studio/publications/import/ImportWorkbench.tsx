"use client";

/**
 * Paste, check, import — and a report with one line per row.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THREE STATES, AND THEY ARE DIFFERENT SCREENS (contract §9).
 *
 *   • `candidates === null` — nothing has been checked yet. The table is not there at all.
 *   • `candidates === []`   — the paste was read and contained no records. That is a real answer with a
 *                             real remedy (check the format), and it must not look like "still working".
 *   • `candidates.length`   — the table, with a tick box per row.
 *
 * DUPLICATES ARRIVE UNTICKED, WITH THE REASON AND THE RECORD THEY MATCH. Matched on the DOI first,
 * because a DOI is the one identifier that cannot be typed two ways; then on the title and year with
 * punctuation and capitalisation ignored, because the same paper pasted from two managers differs by a
 * colon and a capital letter. A reader who genuinely wants a second record can tick it, and the row
 * says what that means.
 *
 * THE IMPORT SENDS KEYS, NOT RECORDS. The server re-reads the same paste and imports the ticked rows,
 * so the thing that is created is the thing that was parsed, not a copy of the parse that has been
 * round-tripped through a browser. Anything else would mean trusting a client to describe the record it
 * is asking for.
 *
 * EVERY ROW COMES BACK NAMED. Created, skipped or failed, each with its own sentence — "12 imported"
 * cannot be checked and says nothing about the thirteenth (contract §1.6).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import type { PublicationKind } from "@prisma/client";
import {
  CircleCheck,
  CircleSlash,
  FileWarning,
  Search,
  TriangleAlert,
  Upload
} from "lucide-react";

import { post } from "@/lib/client/fetcher";
import { useMutation } from "@/lib/client/useResource";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/Badge";
import { Button, LinkButton } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";

/** Which of the two things has been pasted. */
export type ImportSource = "bibtex" | "doi";

/**
 * One record the server read out of the paste.
 *
 * `key` is unique WITHIN one paste — the BibTeX citation key where there is one, and a generated
 * `row-3`-style key where there is not. It is what the import call ticks, so it must survive a re-parse
 * of the same text unchanged.
 */
export interface ImportCandidate {
  key: string;
  kind: PublicationKind;
  /** Already worded by the server: "Journal article", not "JOURNAL_ARTICLE". */
  kindLabel: string;
  title: string;
  authorLine: string;
  /** Null when the entry carried no readable year. The row says so. */
  year: number | null;
  venue: string | null;
  doi: string | null;
  /** Things worth seeing that do not stop an import: a missing year, an unrecognised entry type. */
  problems: string[];
  /** The record this looks like, or null. */
  duplicateOf: { id: string; title: string; year: number | null } | null;
  /** How the duplicate was found. Null when there is no duplicate. */
  matchedOn: "doi" | "title-year" | null;
}

export interface ImportPreviewResponse {
  candidates: ImportCandidate[];
  /** Entries that could not be read at all, each NAMED with its own reason. Never merely counted. */
  unreadable: { source: string; reason: string }[];
  /** True when the paste held more than the server would read. Stated on screen. */
  truncated: boolean;
  /** How many records one paste may contain. */
  limit: number;
}

export interface ImportOutcome {
  key: string;
  title: string;
  outcome: "created" | "skipped" | "failed";
  /** The new publication's id, for a created row. */
  id: string | null;
  /** Why it was skipped, or how it failed. A plain sentence, ready to render. */
  message: string | null;
}

export interface ImportRunResponse {
  results: ImportOutcome[];
}

const ENDPOINT = {
  preview: "/api/studio/publications/import/preview",
  run: "/api/studio/publications/import"
} as const;

const SOURCE_OPTIONS: readonly { value: ImportSource; label: string }[] = [
  { value: "bibtex", label: "BibTeX" },
  { value: "doi", label: "A list of DOIs" }
];

const SOURCE_HELP: Record<ImportSource, string> = {
  bibtex:
    "Paste one or more BibTeX entries, exactly as a reference manager exports them. The citation key of each entry is kept, so anything already citing that key keeps working.",
  doi: "Paste one DOI per line. Each one is looked up and its details fetched, which takes a moment per DOI — a long list is not instant."
};

const SOURCE_PLACEHOLDER: Record<ImportSource, string> = {
  bibtex: "@article{sharma2024block,\n  author = {Sharma, Anita and Doe, John},\n  title   = {Block printing at Bagru},\n  journal = {Journal of Craft Studies},\n  year    = {2024}\n}",
  doi: "10.1234/example.5678\n10.5678/another.1234"
};

/** A row's own outcome, once an import has run. */
const OUTCOME_TONE = {
  created: "success",
  skipped: "neutral",
  failed: "error"
} as const;

const OUTCOME_WORD: Record<ImportOutcome["outcome"], string> = {
  created: "Created",
  skipped: "Skipped",
  failed: "Not created"
};

export function ImportWorkbench() {
  const [source, setSource] = useState<ImportSource>("bibtex");
  const [text, setText] = useState("");

  /** `null` means nothing has been checked yet — see the header. */
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
  const [notes, setNotes] = useState<Pick<
    ImportPreviewResponse,
    "unreadable" | "truncated" | "limit"
  > | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [results, setResults] = useState<ImportOutcome[] | null>(null);

  const preview = useMutation<{ source: ImportSource; text: string }, ImportPreviewResponse>(
    (input) => post<ImportPreviewResponse>(ENDPOINT.preview, input)
  );

  const run = useMutation<
    { source: ImportSource; text: string; keys: string[] },
    ImportRunResponse
  >((input) => post<ImportRunResponse>(ENDPOINT.run, input));

  const check = useCallback(async () => {
    if (text.trim().length === 0) return;
    // A new check retires the previous report: leaving it on screen beside a fresh table would leave
    // two answers about the same paste, and no way to tell which one is current.
    setResults(null);
    const answer = await preview.mutate({ source, text });
    if (!answer) return;

    const rows = Array.isArray(answer.candidates) ? answer.candidates : [];
    setCandidates(rows);
    setNotes({
      unreadable: Array.isArray(answer.unreadable) ? answer.unreadable : [],
      truncated: Boolean(answer.truncated),
      limit: answer.limit
    });
    // Duplicates arrive UNTICKED. Everything else is ticked, because the reader came here to import it.
    setSelected(new Set(rows.filter((row) => row.duplicateOf === null).map((row) => row.key)));
  }, [preview, source, text]);

  const doImport = useCallback(async () => {
    const keys = [...selected];
    if (keys.length === 0) return;
    const answer = await run.mutate({ source, text, keys });
    if (!answer) return;

    setResults(Array.isArray(answer.results) ? answer.results : []);
    // The table is retired once its rows have been acted on: every ticked row is now either a record or
    // a failure, and a table still offering to create them would invite a second attempt.
    setCandidates(null);
    setSelected(new Set());
  }, [run, selected, source, text]);

  const toggle = useCallback((key: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const rows = candidates ?? [];
  const duplicateCount = rows.filter((row) => row.duplicateOf !== null).length;
  const selectedDuplicates = rows.filter(
    (row) => row.duplicateOf !== null && selected.has(row.key)
  ).length;

  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.key));
  const someSelected = rows.some((row) => selected.has(row.key)) && !allSelected;

  const created = useMemo(
    () => (results ?? []).filter((entry) => entry.outcome === "created"),
    [results]
  );
  const skipped = useMemo(
    () => (results ?? []).filter((entry) => entry.outcome === "skipped"),
    [results]
  );
  const failed = useMemo(
    () => (results ?? []).filter((entry) => entry.outcome === "failed"),
    [results]
  );

  return (
    <div className="mt-6 space-y-5">
      <FormSection
        title="What you are pasting"
        description="Nothing is created by this step. The paste is read and shown back to you first."
      >
        <Field label="Format" help={SOURCE_HELP[source]}>
          <Select
            value={source}
            options={SOURCE_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label
            }))}
            onChange={(event) => {
              setSource(event.target.value as ImportSource);
              // The parsed rows belong to the format they were read with; keeping them beside a
              // different format would let the reader import a BibTeX row as a DOI lookup.
              setCandidates(null);
              setNotes(null);
              setResults(null);
              setSelected(new Set());
            }}
            className="max-w-[16rem]"
          />
        </Field>

        <Field
          label={source === "bibtex" ? "BibTeX" : "DOIs, one per line"}
          help="Paste as much as you like. Anything that cannot be read is listed by name rather than dropped quietly."
        >
          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={12}
            spellCheck={false}
            className="font-mono text-xs"
            placeholder={SOURCE_PLACEHOLDER[source]}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            icon={Search}
            onClick={() => void check()}
            isLoading={preview.isPending}
            loadingLabel="reading the paste"
            disabled={text.trim().length === 0}
          >
            Check what will be imported
          </Button>

          {text.trim().length === 0 ? (
            <span className="text-xs text-ink-500">Paste something above first.</span>
          ) : null}
        </div>

        {preview.error !== null ? (
          // `role="alert"`: the reader has just pressed something and it did not work.
          <p role="alert" className="text-sm leading-relaxed text-error-600">
            {preview.error.message}
          </p>
        ) : null}
      </FormSection>

      {notes !== null && (notes.truncated || notes.unreadable.length > 0) ? (
        <FormSection
          title="Things worth knowing about this paste"
          description="Read these before importing. Nothing here stops the rows below from being created."
        >
          {notes.truncated ? (
            <HelpText tone="warn">
              This paste held more than {notes.limit} records, so only the first {notes.limit} are listed
              below. Import these, then paste the rest.
            </HelpText>
          ) : null}

          {notes.unreadable.length > 0 ? (
            <div>
              <p className="flex items-start gap-1.5 text-sm font-medium text-amber-800">
                <FileWarning aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {notes.unreadable.length === 1
                    ? "One entry could not be read and is not in the list below:"
                    : `${notes.unreadable.length} entries could not be read and are not in the list below:`}
                </span>
              </p>
              <ul className="mt-2 space-y-1.5">
                {notes.unreadable.map((entry, index) => (
                  <li
                    key={`${entry.source}-${index}`}
                    className="rounded-md border border-amber-800/25 bg-amber-100 px-3 py-2 text-xs leading-relaxed text-amber-800"
                  >
                    <span className="block font-mono break-all">{entry.source}</span>
                    <span className="mt-1 block">{entry.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </FormSection>
      ) : null}

      {/* `null` is "not checked yet" and renders nothing at all; `[]` is a real answer with its own words. */}
      {candidates !== null ? (
        candidates.length === 0 ? (
          <FormSection title="Nothing was found in that paste">
            <p className="text-sm leading-relaxed text-ink-700">
              No records could be read from what you pasted.{" "}
              {source === "bibtex"
                ? "A BibTeX entry begins with an @ sign followed by a type and a brace — for example “@article{key,”. If you meant to paste DOIs, change the format above."
                : "A DOI looks like “10.1234/something”, one to a line. If you meant to paste BibTeX, change the format above."}
            </p>
          </FormSection>
        ) : (
          <FormSection
            title={`${candidates.length === 1 ? "1 record" : `${candidates.length} records`} were read`}
            description="Tick the ones to import. Everything created here is a draft — nothing appears on the public site until it is published, one by one."
            actions={
              <Checkbox
                checked={allSelected}
                indeterminate={someSelected}
                onCheckedChange={(checked) =>
                  setSelected(checked ? new Set(rows.map((row) => row.key)) : new Set())
                }
                label={`Tick all ${rows.length}`}
              />
            }
          >
            {duplicateCount > 0 ? (
              <HelpText tone="warn">
                {duplicateCount === 1
                  ? "One of these looks like a publication that is already here, so it has been left unticked."
                  : `${duplicateCount} of these look like publications that are already here, so they have been left unticked.`}{" "}
                A match is made on the DOI first, and where there is no DOI on the title and year with
                punctuation and capitalisation ignored. Tick one anyway if you really do want a second
                record for it.
              </HelpText>
            ) : null}

            {/* The wide table scrolls inside its own box; the page itself never scrolls sideways. */}
            <div className="overflow-x-auto rounded-md border border-line-200 bg-card">
              <table aria-label="Records read from the paste" className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <th scope="col" className="border-b border-line-200 bg-surface-50 px-2 py-2">
                      <span className="sr-only">Import this record</span>
                    </th>
                    <th
                      scope="col"
                      className="border-b border-line-200 bg-surface-50 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-500"
                    >
                      Title and authors
                    </th>
                    <th
                      scope="col"
                      className="border-b border-line-200 bg-surface-50 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-500"
                    >
                      Type and year
                    </th>
                    <th
                      scope="col"
                      className="border-b border-line-200 bg-surface-50 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-500"
                    >
                      What will happen
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const ticked = selected.has(row.key);
                    const duplicate = row.duplicateOf;

                    return (
                      <tr
                        key={row.key}
                        className={cn(
                          "border-b border-line-200 last:border-b-0",
                          ticked ? "bg-purple-50" : undefined
                        )}
                      >
                        <td className="px-2 py-2.5 align-top">
                          <Checkbox
                            checked={ticked}
                            onCheckedChange={(checked) => toggle(row.key, checked)}
                            label={<span className="sr-only">Import {row.title}</span>}
                            // `!` on both, because `cn()` is a plain join and later classes do not win
                            // (contract §5): the recipe's own padding would otherwise make each row 44px
                            // taller than the rest of the table.
                            className="!min-h-0 !py-0 justify-center"
                          />
                        </td>

                        <td className="min-w-[18rem] px-3 py-2.5 align-top">
                          <span className="block text-sm font-medium text-ink-900">{row.title}</span>
                          <span className="mt-0.5 block text-xs text-ink-500">
                            {row.authorLine.trim().length > 0
                              ? row.authorLine
                              : "No authors were recorded in this entry"}
                          </span>
                          {row.venue ? (
                            <span className="mt-0.5 block text-xs text-ink-500">{row.venue}</span>
                          ) : null}
                          {row.doi ? (
                            <span className="mt-0.5 block break-all font-mono text-[0.6875rem] text-ink-500">
                              {row.doi}
                            </span>
                          ) : null}
                        </td>

                        <td className="px-3 py-2.5 align-top">
                          <Badge tone="neutral" size="sm">
                            {row.kindLabel}
                          </Badge>
                          <span className="mt-1 block text-xs tabular-nums text-ink-700">
                            {row.year === null ? "No year" : row.year}
                          </span>
                        </td>

                        <td className="min-w-[16rem] px-3 py-2.5 align-top">
                          {duplicate ? (
                            <span className="block text-xs leading-relaxed text-amber-800">
                              <span className="flex items-start gap-1.5 font-medium">
                                <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                <span>
                                  {ticked
                                    ? "A second record will be created"
                                    : "Looks like it is already here"}
                                </span>
                              </span>
                              <span className="mt-1 block">
                                {row.matchedOn === "doi"
                                  ? "The same DOI as "
                                  : "The same title and year as "}
                                <Link
                                  href={`/studio/publications/${duplicate.id}`}
                                  className="font-medium text-purple-700 underline underline-offset-4 hover:text-purple-800"
                                >
                                  {duplicate.title}
                                  {duplicate.year === null ? "" : ` (${duplicate.year})`}
                                </Link>
                                .
                              </span>
                            </span>
                          ) : (
                            <span className="flex items-start gap-1.5 text-xs leading-relaxed text-ink-700">
                              <CircleCheck aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success-600" />
                              <span>
                                {ticked ? "Will be created as a draft" : "Will be left out"}
                              </span>
                            </span>
                          )}

                          {row.problems.length > 0 ? (
                            <ul className="mt-1.5 space-y-1">
                              {row.problems.map((problem) => (
                                <li key={problem} className="text-xs leading-relaxed text-ink-500">
                                  {problem}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                icon={Upload}
                onClick={() => void doImport()}
                isLoading={run.isPending}
                loadingLabel="importing"
                disabled={selected.size === 0}
              >
                {selected.size === 1 ? "Import 1 record" : `Import ${selected.size} records`}
              </Button>

              {selected.size === 0 ? (
                <span className="text-xs text-ink-500">
                  Nothing is ticked, so there is nothing to import.
                </span>
              ) : null}

              {selectedDuplicates > 0 ? (
                <span className="text-xs text-amber-800">
                  {selectedDuplicates === 1
                    ? "One ticked row is a duplicate and will become a second record."
                    : `${selectedDuplicates} ticked rows are duplicates and will become second records.`}
                </span>
              ) : null}
            </div>

            {run.error !== null ? (
              <p role="alert" className="text-sm leading-relaxed text-error-600">
                {run.error.message} Nothing was created.
              </p>
            ) : null}
          </FormSection>
        )
      ) : null}

      {results !== null ? (
        <FormSection
          title="What happened"
          description="One line for every row that was ticked. Anything created is a draft."
          actions={
            <LinkButton href="/studio/publications" variant="secondary" size="sm">
              Go to publications
            </LinkButton>
          }
        >
          <p className="text-sm leading-relaxed text-ink-700">
            {created.length === 0
              ? "Nothing was created."
              : created.length === 1
                ? "1 publication was created as a draft."
                : `${created.length} publications were created as drafts.`}
            {skipped.length > 0
              ? ` ${skipped.length === 1 ? "1 row was skipped" : `${skipped.length} rows were skipped`}.`
              : ""}
            {failed.length > 0
              ? ` ${failed.length === 1 ? "1 row could not be created" : `${failed.length} rows could not be created`}.`
              : ""}
          </p>

          <ul className="space-y-1.5">
            {results.map((entry) => (
              <li
                key={entry.key}
                className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-md border border-line-200 bg-card px-3 py-2"
              >
                <Badge
                  tone={OUTCOME_TONE[entry.outcome]}
                  size="sm"
                  icon={
                    entry.outcome === "created"
                      ? CircleCheck
                      : entry.outcome === "skipped"
                        ? CircleSlash
                        : TriangleAlert
                  }
                  className="shrink-0"
                >
                  {OUTCOME_WORD[entry.outcome]}
                </Badge>

                <span className="min-w-[14rem] flex-1">
                  {entry.outcome === "created" && entry.id !== null ? (
                    <Link
                      href={`/studio/publications/${entry.id}`}
                      className="text-sm font-medium text-purple-700 underline-offset-4 hover:underline"
                    >
                      {entry.title}
                    </Link>
                  ) : (
                    <span className="text-sm text-ink-900">{entry.title}</span>
                  )}
                  {entry.message ? (
                    <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">
                      {entry.message}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>

          {results.length === 0 ? (
            <p className="text-sm text-ink-500">
              Nothing came back. Check the list of publications before trying again — if the records are
              there, the import worked and only this report was lost.
            </p>
          ) : null}

          <HelpText>
            Everything imported is a draft with no research area and no linked people. Open each one to
            check the author line, file it under an area and link the authors who work here — a citation
            built from an unchecked import is a citation nobody has read.
          </HelpText>

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={Search} onClick={() => void check()}>
              Check this paste again
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setText("");
                setCandidates(null);
                setNotes(null);
                setResults(null);
                setSelected(new Set());
              }}
            >
              Start with a new paste
            </Button>
          </div>
        </FormSection>
      ) : null}
    </div>
  );
}
