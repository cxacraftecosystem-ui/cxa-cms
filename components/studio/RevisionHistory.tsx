"use client";

/**
 * RevisionHistory — every saved version of a record, what each one would change, and a way back.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE LIST COMES FROM `listRevisions()` IN lib/audit.ts, AND IT DELIBERATELY HAS NO `data`.
 *
 * A history list does not need the snapshots — fifty Tiptap documents is a payload nobody is reading —
 * so `listRevisions` omits them and this component fetches ONE on demand, through `loadRevision`, when
 * a reader asks to compare. `lib/audit.ts` is `server-only`, so a Server Component page calls
 * `listRevisions()` and hands the rows down; the fetch for a single snapshot goes over HTTP through
 * `lib/client/fetcher.ts`, which is the split contract §9 sets out.
 *
 * THE COMPARISON IS AGAINST WHAT IS ON SCREEN NOW, not against the version before it. The question a
 * reader has open in front of a history list is "what happens if I restore this one", and that is
 * answered by the difference between that version and the present state. "What did this save change"
 * is a different question and a different screen.
 *
 * RESTORE IS A DANGER-TONE CONFIRMATION THAT NAMES THE VERSION AND ITS DATE. "Restore this version?"
 * next to a list of nine of them is a question about which nobody can be certain, and restoring the
 * wrong one silently replaces an afternoon's work. The dialog says which version, when it was saved and
 * who by — and it also says that the current state is itself kept as a version, because the single most
 * calming fact about a restore is that it can be undone.
 *
 * ⚠ THE LIST IS CAPPED AND SAYS SO. `listRevisions` takes 50 by default. A history that quietly stops
 * at fifty is indistinguishable from a record that has only ever been saved fifty times (contract
 * §1.6), so when the rows fill the cap the component prints the fact.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * TIMES ARE FORMATTED IN AN EXPLICIT TIME ZONE, AND THE ZONE IS PRINTED. Formatting in the reader's
 * own zone means the server, which does not know it, renders one date into the HTML and the browser
 * renders another — a hydration mismatch React resolves by keeping whichever it likes. Naming the zone
 * makes both sides agree AND makes the column honest: a revision list where "09:14" means a different
 * instant to two colleagues is a revision list that cannot settle an argument. The default is UTC; pass
 * the Centre's zone from settings if a screen has it, which is also the house rule for content times
 * (schema, `CoeEvent`).
 *
 * NO MOTION ON THE DISCLOSURE. A panel opening is one of the few things the studio does animate, but
 * this one holds a diff a reader is comparing character by character, and 220ms of height animation
 * before they can read it is 220ms of nothing useful.
 */

import { useCallback, useId, useState } from "react";
import { ChevronDown, ChevronRight, History, RotateCcw } from "lucide-react";

import { asApiClientError } from "@/lib/client/fetcher";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { EmptyState } from "@/components/ui/EmptyState";
import type { HeadingLevel } from "@/components/ui/Heading";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/ToastProvider";
import { HelpText } from "@/components/studio/HelpText";

/** One stored snapshot, as JSON. Keys are the row's columns. */
export type RevisionData = Record<string, unknown>;

/**
 * Exactly what `listRevisions()` selects. `createdAt` is typed for both shapes because a Server
 * Component hands down a `Date` and an HTTP response hands down the ISO string it serialised into.
 */
export interface RevisionSummary {
  id: string;
  version: number;
  summary: string | null;
  createdAt: string | Date;
  author: { id: string; name: string; email: string } | null;
}

/** Columns nobody wants to see in a diff: they change on every save and mean nothing on their own. */
const DEFAULT_IGNORED_FIELDS: readonly string[] = [
  "id",
  "createdAt",
  "updatedAt",
  "publishedAt",
  "viewCount",
  "downloadCount"
];

/** Where a long value is cut. The cut is always stated — see `formatValue`. */
const VALUE_LIMIT = 400;

/** What `listRevisions` takes by default, so the cap notice is right without the caller saying so. */
const DEFAULT_TAKE = 50;

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: RevisionData }
  | { kind: "error"; message: string };

export interface RevisionHistoryProps {
  /** `null` means "still loading"; `[]` means "there are no earlier versions". Different screens. */
  revisions: readonly RevisionSummary[] | null;
  /**
   * Fetches one version's stored snapshot. Throw to report a failure — the message is shown verbatim.
   * Usually `get<RevisionData>(\`/api/studio/…/revisions/${version}\`)`.
   */
  loadRevision: (version: number) => Promise<RevisionData | null>;
  /** The record as it stands on screen, to compare a version against. */
  current: RevisionData | null;
  /** Writes a version back over the record. Throw to report a failure. */
  onRestore: (version: number) => Promise<void> | void;
  /**
   * Whether this reader may restore. `false` renders no Restore control at all — a failing permission
   * check renders NOTHING, never a disabled control (contract §1.8). Pass `canRestoreDeleted(user)` or
   * whichever predicate from `lib/permissions.ts` the route handler enforces.
   */
  canRestore?: boolean;
  /** What is being versioned, named in the confirmation: "this publication". */
  subject?: string;
  /** How many rows were asked for. Only used to know whether the list hit its cap. Default 50. */
  take?: number;
  /** IANA name. Default "UTC" — see the header before changing it. */
  timeZone?: string;
  /** Proper names for the columns: `{ seoDescription: "Search engine description" }`. */
  fieldLabels?: Readonly<Record<string, string>>;
  /** Columns to leave out of every diff, on top of the noisy defaults. */
  ignoreFields?: readonly string[];
  /** The rank of the "No earlier versions" heading. See EmptyState. Default 3. */
  headingLevel?: HeadingLevel;
  className?: string;
}

/** "seoDescription" → "Seo description". A last resort; pass `fieldLabels` for anything a reader sees often. */
function humaniseFieldName(field: string): string {
  const words = field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  if (words.length === 0) return field;
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/**
 * A stored value as text a person can compare.
 *
 * TRUNCATION IS STATED, never silent: a diff that stops mid-sentence with no explanation reads as two
 * values that differ where they actually agree (contract §1.6).
 */
function formatValue(value: unknown): { text: string; truncated: boolean } {
  if (value === null || value === undefined) return { text: "(empty)", truncated: false };
  if (typeof value === "string") {
    if (value.length === 0) return { text: "(empty)", truncated: false };
    return value.length > VALUE_LIMIT
      ? { text: value.slice(0, VALUE_LIMIT), truncated: true }
      : { text: value, truncated: false };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return { text: String(value), truncated: false };
  }

  // Objects and arrays — a rich-text document, a tag list. Pretty-printed, because a single line of
  // minified JSON is not something anybody compares by eye.
  let serialised: string;
  try {
    serialised = JSON.stringify(value, null, 2) ?? "(empty)";
  } catch {
    serialised = "(this value cannot be shown)";
  }
  return serialised.length > VALUE_LIMIT
    ? { text: serialised.slice(0, VALUE_LIMIT), truncated: true }
    : { text: serialised, truncated: false };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Structural comparison, which is what a diff means for a rich-text document or a tag array. Key
  // order can differ between two serialisations of the same object; that produces a false difference
  // rather than a missed one, which is the safe direction for a screen whose job is to show changes.
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

interface DiffRow {
  field: string;
  before: unknown;
  after: unknown;
}

function buildDiff(
  version: RevisionData,
  current: RevisionData,
  ignored: readonly string[]
): DiffRow[] {
  const fields = [...new Set([...Object.keys(version), ...Object.keys(current)])].sort();
  const rows: DiffRow[] = [];

  for (const field of fields) {
    if (ignored.includes(field)) continue;
    const before = version[field];
    const after = current[field];
    if (sameValue(before, after)) continue;
    rows.push({ field, before, after });
  }

  return rows;
}

/** The machine-readable instant for `<time dateTime>`, or nothing. `toISOString()` THROWS on an
 *  invalid date, and a malformed timestamp from an API is not a reason to blank the whole screen. */
function isoOrUndefined(value: string | Date): string | undefined {
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function formatWhen(value: string | Date, timeZone: string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "an unknown date";
  return date.toLocaleString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone
  });
}

export function RevisionHistory({
  revisions,
  loadRevision,
  current,
  onRestore,
  canRestore = false,
  subject = "this record",
  take = DEFAULT_TAKE,
  timeZone = "UTC",
  fieldLabels,
  ignoreFields,
  headingLevel = 3,
  className
}: RevisionHistoryProps) {
  const confirm = useConfirm();
  const { toast } = useToast();
  const uid = useId();

  const [openVersion, setOpenVersion] = useState<number | null>(null);
  const [loaded, setLoaded] = useState<Record<number, LoadState>>({});
  const [restoring, setRestoring] = useState<number | null>(null);

  const ignored = [...DEFAULT_IGNORED_FIELDS, ...(ignoreFields ?? [])];

  const toggle = useCallback(
    async (version: number) => {
      if (openVersion === version) {
        setOpenVersion(null);
        return;
      }
      setOpenVersion(version);

      // Fetched once per version and kept. A reader comparing two versions flips between them, and
      // re-fetching on every flip makes the panel blink for no reason.
      if (loaded[version]) return;

      setLoaded((entries) => ({ ...entries, [version]: { kind: "loading" } }));
      try {
        const data = await loadRevision(version);
        setLoaded((entries) => ({
          ...entries,
          [version]: data
            ? { kind: "ready", data }
            : { kind: "error", message: "This version could not be found. It may have been removed." }
        }));
      } catch (thrown) {
        // `message` from lib/api.ts is already a plain sentence ready to render (contract §9).
        setLoaded((entries) => ({
          ...entries,
          [version]: { kind: "error", message: asApiClientError(thrown).message }
        }));
      }
    },
    [loaded, loadRevision, openVersion]
  );

  const restore = useCallback(
    async (revision: RevisionSummary) => {
      const when = formatWhen(revision.createdAt, timeZone);
      const who = revision.author?.name ?? "somebody whose account has since been removed";

      const agreed = await confirm({
        title: `Restore version ${revision.version}?`,
        body: (
          <>
            <p>
              Version {revision.version}, saved on {when} ({timeZone}) by {who}, will be written back
              over {subject} as it stands now.
            </p>
            <p className="mt-2">
              What is on screen now is kept in this history as a new version, so if this turns out to be
              the wrong one you can come back here and restore that instead.
            </p>
          </>
        ),
        confirmLabel: `Restore version ${revision.version}`,
        cancelLabel: "Leave it as it is",
        tone: "danger"
      });

      if (!agreed) return;

      setRestoring(revision.version);
      try {
        await onRestore(revision.version);
        toast({
          tone: "success",
          title: `Version ${revision.version} has been restored`,
          description: "The version that was on screen before is still in this history."
        });
      } catch (thrown) {
        toast({
          tone: "error",
          title: "Nothing has been restored",
          description: asApiClientError(thrown).message
        });
      } finally {
        setRestoring(null);
      }
    },
    [confirm, onRestore, subject, timeZone, toast]
  );

  // `null` is "still loading"; `[]` is "there are none". They are different screens (contract §9).
  if (revisions === null) {
    return (
      <div className={cn("min-w-0", className)}>
        <Skeleton lines={4} height="3.5rem" label="Loading the version history…" />
      </div>
    );
  }

  if (revisions.length === 0) {
    return (
      <div className={cn("min-w-0", className)}>
        <EmptyState
          icon={History}
          title="No earlier versions yet"
          description={`Every save keeps a copy of ${subject} here, so you can see what changed and go back to it. The first save will create one.`}
          headingLevel={headingLevel}
        />
      </div>
    );
  }

  const cappedOut = revisions.length >= take;

  return (
    <div className={cn("min-w-0", className)}>
      <ul className="space-y-2">
        {revisions.map((revision) => {
          const panelId = `${uid}v${revision.version}`;
          const open = openVersion === revision.version;
          const state = loaded[revision.version];
          const diff = state?.kind === "ready" && current ? buildDiff(state.data, current, ignored) : null;

          return (
            <li key={revision.id} className="rounded-md border border-line-200 bg-card">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => void toggle(revision.version)}
                  aria-expanded={open}
                  // Only while the panel is in the document: an id that is not there is worse than not
                  // pointing at all (contract §11).
                  aria-controls={open ? panelId : undefined}
                  className="flex min-w-0 flex-1 items-start gap-2 rounded-md px-1 py-1 text-left transition hover:bg-surface-100"
                >
                  {open ? (
                    <ChevronDown aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" />
                  ) : (
                    <ChevronRight aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" />
                  )}

                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-ink-900">
                      Version {revision.version}
                      {revision.summary ? (
                        <span className="font-normal text-ink-700"> — {revision.summary}</span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block text-xs text-ink-500">
                      {/* `<time>` carries the machine-readable instant; the text is the human one, in
                          the named zone so both sides of hydration agree. */}
                      <time dateTime={isoOrUndefined(revision.createdAt)}>
                        {formatWhen(revision.createdAt, timeZone)}
                      </time>
                      {revision.author ? <> · {revision.author.name}</> : <> · author unknown</>}
                    </span>
                    <span className="sr-only">
                      {open ? " — comparison shown" : " — show what this version would change"}
                    </span>
                  </span>
                </button>

                {canRestore ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={RotateCcw}
                    isLoading={restoring === revision.version}
                    loadingLabel="restoring"
                    onClick={() => void restore(revision)}
                  >
                    Restore
                  </Button>
                ) : null}
              </div>

              {open ? (
                <div id={panelId} className="border-t border-line-200 px-3 py-3">
                  {state === undefined || state.kind === "loading" ? (
                    <Skeleton lines={3} label={`Loading version ${revision.version}…`} />
                  ) : state.kind === "error" ? (
                    <HelpText tone="error">{state.message}</HelpText>
                  ) : current === null ? (
                    <HelpText>
                      There is nothing to compare this against until the record on screen has finished
                      loading.
                    </HelpText>
                  ) : diff && diff.length === 0 ? (
                    <HelpText>
                      This version is the same as what is on screen now, apart from things that change on
                      every save.
                    </HelpText>
                  ) : (
                    <>
                      <p className="field-label">What restoring this would change</p>
                      <dl className="mt-2 space-y-3">
                        {(diff ?? []).map((row) => {
                          const before = formatValue(row.before);
                          const after = formatValue(row.after);
                          const name = fieldLabels?.[row.field] ?? humaniseFieldName(row.field);

                          return (
                            <div key={row.field} className="min-w-0">
                              <dt className="text-xs font-semibold text-ink-900">{name}</dt>
                              <dd className="mt-1 grid gap-2 sm:grid-cols-2">
                                <div className="min-w-0 rounded-md border border-success-600/25 bg-success-100 px-2.5 py-2">
                                  <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-success-600">
                                    Version {revision.version}
                                  </p>
                                  <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[0.6875rem] leading-relaxed text-ink-900">
                                    {before.text}
                                  </pre>
                                  {before.truncated ? (
                                    <p className="mt-1 text-[0.6875rem] text-ink-500">
                                      Shortened here — the whole value is restored.
                                    </p>
                                  ) : null}
                                </div>

                                <div className="min-w-0 rounded-md border border-line-200 bg-surface-50 px-2.5 py-2">
                                  <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-ink-500">
                                    On screen now
                                  </p>
                                  <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[0.6875rem] leading-relaxed text-ink-900">
                                    {after.text}
                                  </pre>
                                  {after.truncated ? (
                                    <p className="mt-1 text-[0.6875rem] text-ink-500">
                                      Shortened here — nothing is cut from the record itself.
                                    </p>
                                  ) : null}
                                </div>
                              </dd>
                            </div>
                          );
                        })}
                      </dl>
                    </>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="mt-3 space-y-1">
        {/* The cap, stated. See the header. */}
        {cappedOut ? (
          <HelpText>
            Only the {take} most recent versions are shown. There may be older ones — ask an
            administrator if you need to go further back.
          </HelpText>
        ) : null}
        <HelpText>Times are shown in {timeZone}.</HelpText>
      </div>
    </div>
  );
}
