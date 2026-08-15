"use client";

/**
 * InquiryInbox — the contact inbox: what has come in, who is dealing with it, and how old it is.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * SPAM IS FILTERED, NEVER HIDDEN, AND THE SCORE AND THE REASON ARE ON SCREEN.
 *
 * `lib/spam.ts` MARKS; it does not delete, and the asymmetry is total: a false positive that was stored
 * can be found, read and answered a day late, while a false positive that was discarded is a
 * collaboration enquiry or a PhD application that never existed — the sender was told "thank you",
 * believes they made contact, and waits. So this screen leaves spam out of the working list (an inbox
 * with the spam in it is an inbox nobody triages) and says out loud how many were left out, with a
 * filter that shows them, the score that was given and the sentences that produced it. A false positive
 * can then be RECOGNISED rather than merely regretted.
 *
 * THERE IS NO BULK DELETE, AND THERE MUST NEVER BE ONE. A deleted enquiry is a lost enquiry: it is
 * somebody's only attempt to reach the Centre, and there is no second copy anywhere. Bulk ARCHIVE is
 * offered instead — it clears the queue and keeps every word. (A single enquiry can still be sent to the
 * recycle bin from its own panel, deliberately one at a time.)
 *
 * THE EXPORT STATES ITS ROW COUNT BEFORE IT DOWNLOADS. "Export as CSV" next to a filtered list is a
 * button whose result nobody can predict; "Export these 37 enquiries" is a sentence somebody can check
 * against what they are looking at. It exports THE CURRENT FILTER, and says so.
 *
 * REPLYING HAPPENS IN THE READER'S OWN MAIL PROGRAM, and the screen is honest about the consequence:
 * this studio cannot see that the reply was sent, so the state has to be moved by hand afterwards. A
 * "Replied" that set itself would be a lie the next person to open the inbox would believe.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `items === null` IS LOADING and `[]` IS "NOTHING HERE" — different screens throughout (contract §9).
 * The only motion is the bulk bar arriving, which `DataTable` owns.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  Archive,
  CircleCheck,
  Download,
  Inbox,
  Mail,
  MailOpen,
  SearchX,
  ShieldAlert,
  TriangleAlert,
  UserRound
} from "lucide-react";
import type { SubmissionStatus } from "@prisma/client";

import { asApiClientError, buildQuery, patch, post } from "@/lib/client/fetcher";
import { useDebouncedValue, useResource } from "@/lib/client/useResource";
import { cn } from "@/lib/utils";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Pagination } from "@/components/ui/Pagination";
import { SearchInput } from "@/components/ui/SearchInput";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/ToastProvider";
import { DataTable, DATA_TABLE_PRIMARY_LINK_CLASS, type DataTableColumn } from "@/components/studio/DataTable";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";

/** Every address this screen calls, in one place, so the route handlers have one list to satisfy. */
const INQUIRY_ENDPOINTS = {
  list: (query: string) => `/api/studio/inquiries${query}`,
  detail: (id: string) => `/api/studio/inquiries/${encodeURIComponent(id)}`,
  bulk: "/api/studio/inquiries/bulk",
  /** Answers `text/csv` with a `Content-Disposition` filename. Same filters as the list. */
  exportCsv: (query: string) => `/api/studio/inquiries/export${query}`
} as const;

const PAGE_SIZE = 25;
const DEBOUNCE_MS = 250;
const NOTE_MAX = 2000;

/**
 * The states, in PLAIN WORDS — never the enum name.
 *
 * A total `Record`, so adding a `SubmissionStatus` is a compile error here rather than a blank chip on
 * screen. It is READ through a `Partial` view below, so a row written by a newer deploy than this one
 * still renders something rather than `undefined`.
 */
const STATE_LABELS: Record<SubmissionStatus, string> = {
  NEW: "New",
  IN_PROGRESS: "Being handled",
  REPLIED: "Replied",
  ARCHIVED: "Archived",
  SPAM: "Marked as spam"
};

/** SPAM is `warn`, not `error`: it is a guess this screen exists to let somebody overturn. */
const STATE_TONES: Record<SubmissionStatus, BadgeTone> = {
  NEW: "info",
  IN_PROGRESS: "warn",
  REPLIED: "success",
  ARCHIVED: "neutral",
  SPAM: "warn"
};

/** One line saying what each state means, for the picker and the panel. */
const STATE_MEANINGS: Record<SubmissionStatus, string> = {
  NEW: "Nobody has picked this up yet.",
  IN_PROGRESS: "Somebody is dealing with it.",
  REPLIED: "A reply has been sent.",
  ARCHIVED: "Finished with. Kept, but out of the queue.",
  SPAM: "The anti-spam check thought this was not a real enquiry. Nothing has been deleted."
};

/** The order a reader thinks about them in: what needs doing first, what is finished last. */
const WORKING_STATES: readonly SubmissionStatus[] = ["NEW", "IN_PROGRESS", "REPLIED", "ARCHIVED"];

function stateLabel(state: SubmissionStatus): string {
  const labels: Partial<Record<SubmissionStatus, string>> = STATE_LABELS;
  return labels[state] ?? state.replace(/_/g, " ").toLowerCase();
}

function stateTone(state: SubmissionStatus): BadgeTone {
  const tones: Partial<Record<SubmissionStatus, BadgeTone>> = STATE_TONES;
  return tones[state] ?? "neutral";
}

/** Which form on the site produced this. Plain words for the four keys the schema documents. */
const FORM_LABELS: Record<string, string> = {
  general: "General enquiry",
  admissions: "Admissions",
  collaboration: "Collaboration",
  media: "Press and media"
};

function formLabel(key: string): string {
  return FORM_LABELS[key] ?? key.replace(/[_-]+/g, " ");
}

/** The reserved words the assignee filter uses. `buildQuery` drops the empty string, so a filter that
 *  means "nobody" needs a word the handler maps (lib/client/fetcher.ts). */
const UNASSIGNED = "none";
const ASSIGNED_TO_ME = "me";

export interface InquiryRow {
  id: string;
  name: string;
  email: string;
  organisation: string | null;
  subject: string | null;
  formKey: string;
  state: SubmissionStatus;
  assignee: { id: string; name: string } | null;
  repliedAt: string | null;
  spamScore: number | null;
  spamReason: string | null;
  hasNote: boolean;
  /** The first line or two of the message, for the list. The whole thing is in the detail. */
  preview: string;
  /** ISO 8601. JSON has no date type and the fetcher does not revive them. */
  createdAt: string;
}

export interface InquiryDetail extends InquiryRow {
  message: string;
  phone: string | null;
  internalNote: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  updatedAt: string;
}

export interface InquiryListResponse {
  items: InquiryRow[];
  total: number;
  page: number;
  pageSize: number;
  /** How many there are in each state, ignoring the filters. Drives the "spam is not shown" sentence. */
  counts: Partial<Record<SubmissionStatus, number>>;
}

export interface InquiryAssignee {
  id: string;
  name: string;
  email: string;
}

interface InquiryFilters {
  q: string;
  /** "" means every WORKING state — spam is left out, and the screen says so. */
  state: SubmissionStatus | "";
  /** A user id, `UNASSIGNED`, `ASSIGNED_TO_ME`, or "". */
  assignee: string;
  formKey: string;
  page: number;
}

const DEFAULT_FILTERS: InquiryFilters = { q: "", state: "", assignee: "", formKey: "", page: 1 };

function isState(value: string): value is SubmissionStatus {
  return value === "NEW" || value === "IN_PROGRESS" || value === "REPLIED" || value === "ARCHIVED" || value === "SPAM";
}

/**
 * Read the filters out of the address bar.
 *
 * ⚠ DONE HERE, IN THE BROWSER. Every export of a `"use client"` module is a client reference, so a
 * Server Component that imported this would be calling a client function from the server — which fails
 * at runtime (MediaGrid.tsx's header sets out the trap). Keeping the whole job on this side means one
 * parser and one page-size constant rather than two of each drifting apart.
 */
function readFilters(params: { get: (name: string) => string | null }): InquiryFilters {
  const state = params.get("state") ?? "";
  const page = Number.parseInt(params.get("page") ?? "", 10);
  return {
    q: params.get("q") ?? "",
    state: isState(state) ? state : "",
    assignee: params.get("assignee") ?? "",
    formKey: params.get("formKey") ?? "",
    page: Number.isFinite(page) && page > 0 ? page : 1
  };
}

function toQuery(filters: InquiryFilters, currentUserId: string): string {
  return buildQuery({
    q: filters.q.trim(),
    state: filters.state,
    // Resolved here rather than on the server: "assigned to me" is a fact about who is looking at the
    // screen, and a route handler that resolved it from the session would answer differently for two
    // people following the same shared link — which is the one thing a shareable URL must not do.
    assignee: filters.assignee === ASSIGNED_TO_ME ? currentUserId : filters.assignee,
    formKey: filters.formKey,
    page: filters.page > 1 ? filters.page : undefined,
    pageSize: PAGE_SIZE
  });
}

/** "3 days ago". Safe to compute here: every row arrives from a fetch, so there is no server paint. */
function age(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "an unknown time ago";
  return formatDistanceToNow(date, { addSuffix: true });
}

/** The exact instant, in a NAMED zone, for the tooltip and for the panel. */
function exactWhen(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  })} UTC`;
}

export interface InquiryInboxProps {
  /** Everybody an enquiry may be handed to — editors and above, active, read on the server. */
  assignees: readonly InquiryAssignee[];
  /** The forms that have actually produced an enquiry, so the filter offers nothing empty. */
  formKeys: readonly string[];
  currentUserId: string;
}

export function InquiryInbox({ assignees, formKeys, currentUserId }: InquiryInboxProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { toast } = useToast();

  // The address bar seeds the state ONCE and is a mirror thereafter — a lazy initialiser, not a value,
  // or the mirror below and the read would fight and the filters would never settle.
  const [filters, setFilters] = useState<InquiryFilters>(() => readFilters(searchParams));
  const [activeId, setActiveId] = useState<string | null>(() => searchParams.get("id"));
  const [flashId, setFlashId] = useState<string | null>(null);

  const query = toQuery(filters, currentUserId);
  // The COMPOSED PATH is debounced, not the text box: typing and choosing a filter share one timer, so
  // they cannot interleave into a request that reflects neither (useResource.ts).
  const debouncedPath = useDebouncedValue(INQUIRY_ENDPOINTS.list(query), DEBOUNCE_MS);

  const list = useResource<InquiryListResponse>(debouncedPath);
  const detail = useResource<InquiryDetail>(
    activeId === null ? null : INQUIRY_ENDPOINTS.detail(activeId)
  );

  const rows = list.data?.items ?? null;
  const total = list.data?.total ?? 0;
  const counts = list.data?.counts ?? {};
  const spamCount = counts.SPAM ?? 0;

  // Mirror the filters into the address bar with the browser's own history API. `router.replace` would
  // re-run the server component on every keystroke for data this screen is already fetching, and
  // `replaceState` rather than `pushState` because Back would otherwise spell the search out backwards.
  const mirror = useMemo(() => {
    const params = new URLSearchParams();
    if (filters.q.trim().length > 0) params.set("q", filters.q.trim());
    if (filters.state.length > 0) params.set("state", filters.state);
    if (filters.assignee.length > 0) params.set("assignee", filters.assignee);
    if (filters.formKey.length > 0) params.set("formKey", filters.formKey);
    if (filters.page > 1) params.set("page", String(filters.page));
    if (activeId !== null) params.set("id", activeId);
    const search = params.toString();
    return search.length > 0 ? `?${search}` : "";
  }, [filters, activeId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const next = `${pathname}${mirror}`;
    if (`${window.location.pathname}${window.location.search}` === next) return;
    window.history.replaceState(null, "", next);
  }, [pathname, mirror]);

  /** Reset to page 1 whenever a filter changes: page 4 of one list is not page 4 of another. */
  const narrow = useCallback((partial: Partial<InquiryFilters>) => {
    setFilters((current) => ({ ...current, ...partial, page: 1 }));
  }, []);

  const applyChange = useCallback(
    async (id: string, body: Record<string, unknown>, success: string) => {
      try {
        await patch(INQUIRY_ENDPOINTS.detail(id), body);
        setFlashId(id);
        await Promise.all([list.refresh(), detail.refresh()]);
        toast({ tone: "success", title: success });
      } catch (thrown) {
        // The server's `message` is already a plain sentence ready to render (lib/api.ts guarantees it).
        toast({
          tone: "error",
          title: "Nothing was changed",
          description: asApiClientError(thrown).message
        });
      }
    },
    [detail, list, toast]
  );

  const archiveMany = useCallback(
    async (selected: InquiryRow[]) => {
      const ids = selected.map((row) => row.id);
      if (ids.length === 0) return;
      try {
        await post(INQUIRY_ENDPOINTS.bulk, { ids, action: "archive" });
        await list.refresh();
        toast({
          tone: "success",
          title: ids.length === 1 ? "1 enquiry archived" : `${ids.length} enquiries archived`,
          description: "Nothing has been deleted — every word is still there under the Archived filter."
        });
      } catch (thrown) {
        // Re-thrown so `DataTable` keeps the selection: the reader can press the same button again and
        // it will act on exactly the rows that did not work.
        toast({
          tone: "error",
          title: "Nothing was archived",
          description: asApiClientError(thrown).message
        });
        throw thrown;
      }
    },
    [list, toast]
  );

  const columns = useMemo<DataTableColumn<InquiryRow>[]>(
    () => [
      {
        key: "sender",
        header: "From",
        render: (row) => (
          <div className="min-w-0">
            {/*
              ONE control in the row opens the enquiry, and it is a `<button>` because it opens a panel
              on this screen rather than going anywhere. The row's hover fill is what still makes it read
              as a target (DataTable's rule 2).
            */}
            <button
              type="button"
              onClick={() => setActiveId(row.id)}
              aria-pressed={row.id === activeId}
              className={cn(DATA_TABLE_PRIMARY_LINK_CLASS, "block max-w-full truncate text-left")}
            >
              {row.name}
            </button>
            <span className="mt-0.5 block truncate text-xs text-ink-500">
              {row.email}
              {row.organisation ? ` · ${row.organisation}` : ""}
            </span>
          </div>
        )
      },
      {
        key: "subject",
        header: "About",
        hideBelow: "md",
        render: (row) => (
          <div className="min-w-0">
            <span className="block truncate text-ink-900">
              {row.subject && row.subject.trim().length > 0 ? row.subject : formLabel(row.formKey)}
            </span>
            <span className="mt-0.5 block truncate text-xs text-ink-500">{row.preview}</span>
          </div>
        )
      },
      {
        key: "state",
        header: "State",
        width: 150,
        resizable: false,
        render: (row) => (
          <div className="space-y-1">
            {/* Icon AND word: colour never carries the meaning alone (contract §11). */}
            <Badge
              tone={stateTone(row.state)}
              size="sm"
              icon={row.state === "SPAM" ? ShieldAlert : row.state === "REPLIED" ? CircleCheck : Mail}
            >
              {stateLabel(row.state)}
            </Badge>
            {row.hasNote ? (
              <span className="block text-[0.6875rem] text-ink-500">Has an internal note</span>
            ) : null}
          </div>
        )
      },
      {
        key: "assignee",
        header: "With",
        width: 140,
        hideBelow: "lg",
        render: (row) =>
          row.assignee ? (
            <span className="flex items-center gap-1.5 truncate text-ink-700">
              <UserRound aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-ink-300" />
              {row.assignee.name}
            </span>
          ) : (
            <span className="text-ink-500">Nobody yet</span>
          )
      },
      {
        key: "age",
        header: "Age",
        width: 130,
        align: "end",
        render: (row) => (
          <time dateTime={row.createdAt} title={exactWhen(row.createdAt)} className="text-xs text-ink-500">
            {age(row.createdAt)}
          </time>
        )
      }
    ],
    [activeId]
  );

  const narrowed =
    filters.q.trim().length > 0 ||
    filters.state.length > 0 ||
    filters.assignee.length > 0 ||
    filters.formKey.length > 0;

  const assigneeOptions = [
    { value: ASSIGNED_TO_ME, label: "Me" },
    { value: UNASSIGNED, label: "Nobody yet" },
    ...assignees.map((person) => ({ value: person.id, label: person.name }))
  ];

  return (
    <div className="space-y-5">
      {/* ── Filters ───────────────────────────────────────────────────────────────────────── */}
      <section aria-label="Filters" className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <SearchInput
            label="Search enquiries by name, address, organisation, subject or message"
            placeholder="Search enquiries"
            value={filters.q}
            onValueChange={(value) => narrow({ q: value })}
            className="sm:min-w-[16rem] sm:flex-1"
          />

          {/* `Field` (a real `<label>`) is right for all three: every control is a NATIVE `<select>`, so
              there is no button inside for a stray click to be forwarded to (Field.tsx). */}
          <Field label="State" className="sm:w-48">
            <Select
              value={filters.state}
              placeholder="Everything except spam"
              options={[
                ...WORKING_STATES.map((state) => ({
                  value: state,
                  label: `${stateLabel(state)}${counts[state] !== undefined ? ` (${counts[state]})` : ""}`
                })),
                { value: "SPAM", label: `${stateLabel("SPAM")} (${spamCount})` }
              ]}
              onChange={(event) => narrow({ state: (event.target.value as SubmissionStatus | "") || "" })}
            />
          </Field>

          <Field label="Being handled by" className="sm:w-48">
            <Select
              value={filters.assignee}
              placeholder="Anybody"
              options={assigneeOptions}
              onChange={(event) => narrow({ assignee: event.target.value })}
            />
          </Field>

          <Field label="Form" className="sm:w-44">
            <Select
              value={filters.formKey}
              placeholder="Any form"
              options={formKeys.map((key) => ({ value: key, label: formLabel(key) }))}
              onChange={(event) => narrow({ formKey: event.target.value })}
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-xs text-ink-500">
            {narrowed
              ? "Some filters are set, so this is not the whole inbox."
              : "No filters are set, so everything is listed except the ones marked as spam."}
          </p>
          {narrowed ? (
            <Button size="sm" variant="ghost" onClick={() => setFilters({ ...DEFAULT_FILTERS })}>
              Clear all filters
            </Button>
          ) : null}
        </div>

        {/*
          THE SPAM SENTENCE. The working list leaves them out, and a list that quietly stops is
          indistinguishable from a place with no records (contract §1.6) — so the number is stated, with
          the way to see them.
        */}
        {filters.state !== "SPAM" && spamCount > 0 ? (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-800/25 bg-amber-100 px-3.5 py-2.5 text-amber-800">
            <p className="flex min-w-0 flex-1 items-start gap-2 text-xs leading-relaxed">
              <ShieldAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {spamCount === 1
                  ? "1 message was marked as spam and is not in this list."
                  : `${spamCount} messages were marked as spam and are not in this list.`}{" "}
                Nothing has been deleted. Worth a look now and then — the check can be wrong, and a real
                enquiry sitting there is one nobody has answered.
              </span>
            </p>
            <Button size="sm" variant="secondary" onClick={() => narrow({ state: "SPAM" })}>
              Show them
            </Button>
          </div>
        ) : null}

        {filters.state === "SPAM" ? (
          <HelpText tone="warn">
            These were marked by the automatic check, not by a person. Each one shows the score it was
            given and the exact reasons. If one is a real enquiry, choose “This is not spam” in its panel
            — it goes back into the queue as new and can be answered.
          </HelpText>
        ) : null}
      </section>

      {list.error ? (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-md border border-error-200 bg-error-100 px-3 py-2.5 text-sm text-error-700"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{list.error.message}</span>
        </p>
      ) : null}

      {/* ── The export, with its row count stated before anybody presses it ───────────────── */}
      {total > 0 ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {/*
            A plain `<a download>`, not a `LinkButton`: the target answers `text/csv`, and routing a
            download through the client router would have it try to render a spreadsheet as a page.
            `download` makes the browser save it and never leave this screen.
          */}
          <a
            href={INQUIRY_ENDPOINTS.exportCsv(query)}
            download
            className={buttonClasses({ variant: "secondary", size: "sm" })}
          >
            <Download aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            Export {total === 1 ? "this 1 enquiry" : `these ${total} enquiries`} as a spreadsheet
          </a>
          <p className="text-xs leading-relaxed text-ink-500">
            The file holds exactly what these filters are showing — every page of it, not only the page on
            screen — with the sender, the message, the state and the internal note in columns.
          </p>
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="min-w-0 space-y-4">
          <DataTable<InquiryRow>
            rows={rows}
            columns={columns}
            getRowId={(row) => row.id}
            getRowLabel={(row) => `the enquiry from ${row.name}`}
            label="Enquiries"
            selectable
            totalItems={total}
            flashRowId={flashId}
            bulkActions={[
              {
                id: "archive",
                label: "Archive",
                icon: Archive,
                onRun: archiveMany
              }
            ]}
            // NO `sort` config on purpose: `DataTable` writes a sort to the URL with `router.replace`,
            // and this screen already owns the address bar through `replaceState`. Two owners of one
            // query string is a fight the reader sees as filters that undo themselves. The ordering here
            // is newest-first from the server, which is the only order an inbox wants.
            empty={
              narrowed ? (
                <EmptyState
                  icon={SearchX}
                  headingLevel={2}
                  title="No enquiries match these filters"
                  description="Nothing fits all of what you have asked for. That is a fact about the filters rather than about the inbox — clear them to see everything again."
                  action={
                    <Button variant="secondary" onClick={() => setFilters({ ...DEFAULT_FILTERS })}>
                      Clear the filters
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={Inbox}
                  headingLevel={2}
                  title="Nothing has come in yet"
                  description="Messages sent through the contact forms on the website arrive here. Nothing is ever deleted automatically."
                />
              )
            }
          />

          <Pagination
            page={filters.page}
            pageSize={list.data?.pageSize ?? PAGE_SIZE}
            totalItems={total}
            itemNoun={{ singular: "enquiry", plural: "enquiries" }}
            label="Enquiries"
            onPageChange={(page) => setFilters((current) => ({ ...current, page }))}
          />
        </div>

        {/* ── One enquiry ──────────────────────────────────────────────────────────────────── */}
        <aside className="min-w-0">
          <div className="xl:sticky xl:top-4">
            {activeId === null ? (
              <FormSection
                title="One enquiry at a time"
                description="Choose a name on the left to read the whole message, take it on, make a note and reply."
              >
                <p className="text-sm text-ink-500">Nothing is selected.</p>
              </FormSection>
            ) : detail.error !== null ? (
              <FormSection title="This enquiry could not be opened">
                <HelpText tone="error">{detail.error.message}</HelpText>
              </FormSection>
            ) : detail.data === null ? (
              <FormSection title="Opening the enquiry…">
                <span role="status" className="sr-only">
                  Loading this enquiry…
                </span>
                <div aria-hidden="true" className="space-y-2">
                  <div className="skeleton h-4 w-1/2" />
                  <div className="skeleton h-20 w-full" />
                </div>
              </FormSection>
            ) : (
              <InquiryPanel
                key={detail.data.id}
                inquiry={detail.data}
                assignees={assignees}
                currentUserId={currentUserId}
                onClose={() => setActiveId(null)}
                onChange={applyChange}
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// One enquiry
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface InquiryPanelProps {
  inquiry: InquiryDetail;
  assignees: readonly InquiryAssignee[];
  currentUserId: string;
  onClose: () => void;
  onChange: (id: string, body: Record<string, unknown>, success: string) => Promise<void>;
}

/**
 * REMOUNTED PER ENQUIRY by a `key` on the caller, so the note being typed for one message can never be
 * saved onto another. Deriving the draft in an effect instead would leave a window in which the textarea
 * shows the previous enquiry's note — and a Save pressed in that window writes it to the wrong row.
 */
function InquiryPanel({ inquiry, assignees, currentUserId, onClose, onChange }: InquiryPanelProps) {
  const [note, setNote] = useState(inquiry.internalNote ?? "");
  const [savingNote, setSavingNote] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const noteDirty = note.trim() !== (inquiry.internalNote ?? "").trim();

  const run = useCallback(
    async (key: string, body: Record<string, unknown>, success: string) => {
      setBusy(key);
      try {
        await onChange(inquiry.id, body, success);
      } finally {
        setBusy(null);
      }
    },
    [inquiry.id, onChange]
  );

  const saveNote = useCallback(async () => {
    setSavingNote(true);
    try {
      await onChange(inquiry.id, { internalNote: note.trim() }, "The note has been saved");
    } finally {
      setSavingNote(false);
    }
  }, [inquiry.id, note, onChange]);

  /**
   * The reply link.
   *
   * `mailto:` opens the reader's own mail program, which is the right place for a reply that speaks for
   * the institution — it goes out from a real mailbox, with a signature, and lands in a thread the sender
   * can answer. The subject is prefilled; the body deliberately is not, because a template nobody edited
   * is worse than a blank message.
   */
  const replySubject = inquiry.subject?.trim()
    ? `Re: ${inquiry.subject.trim()}`
    : `Re: your enquiry to the Centre`;
  const mailto = `mailto:${encodeURIComponent(inquiry.email)}?subject=${encodeURIComponent(replySubject)}`;

  return (
    <div className="space-y-6">
      <FormSection
        title="The message"
        description={`Sent ${age(inquiry.createdAt)} · ${exactWhen(inquiry.createdAt)}`}
        actions={
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        }
      >
        {inquiry.state === "SPAM" ? (
          /*
            The score AND the reasons, verbatim from `lib/spam.ts`. "Suspicious content" would be useless
            here: an editor deciding whether the filter was right needs to know WHAT fired, and the
            module writes one plain sentence per signal for exactly this screen.
          */
          <div className="rounded-md border border-amber-800/25 bg-amber-100 px-3.5 py-3 text-amber-800">
            <p className="flex items-start gap-2 text-sm font-semibold">
              <ShieldAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Marked as spam
                {typeof inquiry.spamScore === "number"
                  ? ` — scored ${inquiry.spamScore.toFixed(2)} out of 1`
                  : ""}
              </span>
            </p>
            <p className="mt-1.5 text-xs leading-relaxed">
              {inquiry.spamReason ??
                "No reason was recorded, which is itself unusual — treat this one as unexplained rather than as certain."}
            </p>
            <p className="mt-1.5 text-xs leading-relaxed">
              The check is a guess. If this reads like a real person, put it back in the queue.
            </p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2.5"
              isLoading={busy === "unspam"}
              loadingLabel="moving"
              onClick={() =>
                void run("unspam", { state: "NEW" }, "Put back in the queue as a new enquiry")
              }
            >
              This is not spam
            </Button>
          </div>
        ) : null}

        <div className="space-y-1">
          <p className="text-sm font-semibold text-ink-900">
            {inquiry.subject && inquiry.subject.trim().length > 0
              ? inquiry.subject
              : formLabel(inquiry.formKey)}
          </p>
          <p className="text-xs text-ink-500">
            Sent through the {formLabel(inquiry.formKey).toLowerCase()} form
          </p>
        </div>

        {/*
          `whitespace-pre-wrap` and nothing else: the message is PLAIN TEXT typed by a stranger, and it is
          rendered as text. Nothing here interprets markup, and nothing here ever should.
        */}
        <p className="whitespace-pre-wrap break-words rounded-md border border-line-200 bg-surface-50 px-3.5 py-3 text-sm leading-relaxed text-ink-900">
          {inquiry.message}
        </p>

        <dl className="space-y-1.5 text-sm">
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-ink-500">Name</dt>
            <dd className="text-ink-900">{inquiry.name}</dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-ink-500">Email</dt>
            <dd className="break-all text-ink-900">{inquiry.email}</dd>
          </div>
          {inquiry.organisation ? (
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-ink-500">Organisation</dt>
              <dd className="text-ink-900">{inquiry.organisation}</dd>
            </div>
          ) : null}
          {inquiry.phone ? (
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-ink-500">Telephone</dt>
              <dd className="text-ink-900">{inquiry.phone}</dd>
            </div>
          ) : null}
          {inquiry.repliedAt ? (
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-ink-500">Replied</dt>
              <dd className="text-ink-900">{exactWhen(inquiry.repliedAt)}</dd>
            </div>
          ) : null}
        </dl>

        <div className="flex flex-wrap gap-2">
          {/*
            A plain `<a>` rather than a `LinkButton`: `mailto:` is not a route, and handing it to the
            client router is a surprise nobody wants. It opens in the reader's mail program.
          */}
          <a href={mailto} className={buttonClasses({ variant: "primary", size: "sm" })}>
            <MailOpen aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            Reply by email
          </a>
        </div>

        <HelpText>
          The reply is written and sent in your own mail program, so this studio cannot see that it went.
          Mark the enquiry as replied yourself once you have sent it — otherwise the next person to open
          the inbox will answer it again.
        </HelpText>
      </FormSection>

      <FormSection
        title="Who is dealing with it"
        description="Taking an enquiry on is how two people avoid replying to the same message twice."
      >
        <Field label="Being handled by" help={STATE_MEANINGS[inquiry.state]}>
          <Select
            value={inquiry.assignee?.id ?? ""}
            placeholder="Nobody yet"
            options={assignees.map((person) => ({ value: person.id, label: person.name }))}
            onChange={(event) =>
              void run(
                "assign",
                // The empty option means "nobody", which is `null` in the column — not the empty string,
                // which would be a user id nobody has.
                { assigneeId: event.target.value.length > 0 ? event.target.value : null },
                event.target.value.length > 0 ? "Handed over" : "Nobody is handling it now"
              )
            }
          />
        </Field>

        {inquiry.assignee?.id !== currentUserId ? (
          <Button
            variant="secondary"
            size="sm"
            icon={UserRound}
            isLoading={busy === "claim"}
            loadingLabel="claiming"
            onClick={() => void run("claim", { assigneeId: currentUserId }, "You are handling this now")}
          >
            Assign it to me
          </Button>
        ) : (
          <p className="text-sm text-ink-700">You are handling this one.</p>
        )}

        <Field label="State" help={STATE_MEANINGS[inquiry.state]}>
          <Select
            value={inquiry.state}
            options={[...WORKING_STATES, "SPAM"].map((state) => ({
              value: state,
              label: stateLabel(state as SubmissionStatus)
            }))}
            onChange={(event) => {
              const next = event.target.value;
              if (!isState(next) || next === inquiry.state) return;
              void run("state", { state: next }, `Moved to “${stateLabel(next)}”`);
            }}
          />
        </Field>

        {inquiry.state !== "REPLIED" ? (
          <Button
            variant="secondary"
            size="sm"
            icon={CircleCheck}
            isLoading={busy === "replied"}
            loadingLabel="saving"
            onClick={() => void run("replied", { state: "REPLIED" }, "Marked as replied")}
          >
            Mark as replied
          </Button>
        ) : null}
      </FormSection>

      <FormSection
        title="Internal note"
        description="For colleagues, never for the sender. Nothing here is sent to anybody outside the studio."
        footer={
          <>
            <p className="mr-auto text-xs text-ink-500">
              {noteDirty ? "Unsaved changes" : "The note is saved"}
            </p>
            <Button
              onClick={() => void saveNote()}
              isLoading={savingNote}
              loadingLabel="saving"
              disabled={!noteDirty}
            >
              Save the note
            </Button>
          </>
        }
      >
        <Field
          label="Note"
          hideLabel
          help="What was agreed, who else was copied in, what is still outstanding."
          maxLength={NOTE_MAX}
          value={note}
        >
          <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={5} />
        </Field>
      </FormSection>

      <FormSection
        title="Where it came from"
        description="Recorded when the form was sent. Useful only when something looks wrong."
      >
        <dl className="space-y-1.5 text-xs">
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-ink-500">Connection</dt>
            <dd className="break-all text-ink-700">{inquiry.ipAddress ?? "not recorded"}</dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-ink-500">Browser</dt>
            <dd className="break-all text-ink-700">{inquiry.userAgent ?? "not recorded"}</dd>
          </div>
        </dl>
      </FormSection>
    </div>
  );
}
