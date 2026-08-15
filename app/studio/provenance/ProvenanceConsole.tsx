"use client";

/**
 * ProvenanceConsole — three tabs for the three questions the console exists to answer.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * 1. THIS INSTALLATION — who signed in, who was refused, which grants have never been used, which
 *    accounts have no second factor. It is FIRST because it is the only one of the three that answers
 *    without being asked a question, so it is what a reader can usefully land on.
 * 2. ONE RECORD — its whole lineage: created by whom, every change with the names of the fields that
 *    moved, every publication, its stored versions, and who has it open right now.
 * 3. ONE PERSON — everything a colleague has done, the addresses they worked from, and their sign-ins.
 *
 * EVERY TIMELINE READS AS A SENTENCE, NEVER AS AN ENUM. "Priya published this on 4 June 2026, 10:32
 * UTC" is the same fact as `PUBLISH`, said in words an administrator who has never seen this codebase
 * can act on. The maps below are total `Record`s, so adding an `AuditAction` to the schema is a compile
 * error here rather than a blank word on screen — and they are READ through a `Partial` view, so a row
 * written by a newer deploy than this bundle still renders something.
 *
 * COLOUR NEVER CARRIES MEANING ALONE (contract §11). Every event kind has an icon AND a word in its
 * chip; the bars in the day charts are `aria-hidden` decoration beside numbers that are already text.
 *
 * ⚠ THE STATE IS NOT IN THE ADDRESS BAR, and that is a departure from `/studio/audit` worth naming.
 * The audit screen is a plain GET form precisely so a filtered view can be pasted into an incident
 * note. This screen is an investigation: a search that reacts per keystroke, a record chosen from
 * results, two versions chosen from that record, a range changed and changed back. Writing each of
 * those into the URL would make the browser's Back button undo a comparison instead of leaving the
 * screen, and would rewrite the address on every letter typed. The audit log remains the pasteable
 * artefact; this is the surface you work on.
 *
 * ⚠ THE `import type` FROM `@/lib/provenance` MUST STAY `import type`. That module carries
 * `server-only`, so a value import would be a build error the moment this file reaches the client
 * bundle. Types are erased at compile time, which is what makes ONE definition of the wire shape
 * possible instead of a second copy here that can drift from the one the endpoint actually sends.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `data === null` IS LOADING and an empty list IS "nothing here" — different screens throughout
 * (contract §9). Nothing on this screen writes, so there is no mutation, no confirm and no toast.
 */

import { useMemo, useState } from "react";
import {
  Archive,
  Building2,
  Eye,
  EyeOff,
  FileSearch,
  Fingerprint,
  Flame,
  GitCompare,
  Globe,
  History,
  Hourglass,
  Info,
  KeyRound,
  Layers,
  Lock,
  LogIn,
  LogOut,
  Network,
  Pencil,
  Plus,
  RotateCcw,
  SearchX,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Trash2,
  TriangleAlert,
  Undo2,
  Upload,
  UserRound,
  UserSearch,
  Users
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AuditAction } from "@prisma/client";

import { buildQuery } from "@/lib/client/fetcher";
import { useDebouncedValue, useResource } from "@/lib/client/useResource";
import { ROLE_LABELS } from "@/lib/permissions";
import { cn } from "@/lib/utils";
// ⚠ TYPE-ONLY. See the header — lib/provenance.ts is `server-only`.
import type {
  ActorProvenance,
  CappedList,
  InstallationProvenance,
  PersonSearchHit,
  RecordProvenance,
  RecordSearchHit,
  RevisionDiff,
  RevisionFieldChange,
  ValuePreview
} from "@/lib/provenance";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { SearchInput } from "@/components/ui/SearchInput";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { Tabs } from "@/components/ui/Tabs";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";

const DEBOUNCE_MS = 250;

/**
 * How many day rows the charts draw.
 *
 * The range picker offers at most 90 days, so this cannot bite today. It is here because the endpoint
 * accepts a longer range than the picker offers, and a chart that quietly stopped at row 92 would be
 * the exact bug this contract's §1.6 exists to prevent.
 */
const SERIES_ROW_LIMIT = 92;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The vocabulary
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface ActionWords {
  /** The chip's word. */
  label: string;
  /** How it reads inside a sentence about one record: "Priya {phrase} on 4 June". */
  phrase: string;
  icon: LucideIcon;
  tone: BadgeTone;
}

const ACTION_WORDS: Record<AuditAction, ActionWords> = {
  CREATE: { label: "Created", phrase: "created this", icon: Plus, tone: "success" },
  UPDATE: { label: "Changed", phrase: "changed this", icon: Pencil, tone: "neutral" },
  DELETE: {
    label: "Moved to the recycle bin",
    phrase: "moved this to the recycle bin",
    icon: Trash2,
    tone: "warn"
  },
  RESTORE: {
    label: "Restored",
    phrase: "restored this from the recycle bin",
    icon: Undo2,
    tone: "info"
  },
  PUBLISH: { label: "Published", phrase: "published this", icon: Globe, tone: "success" },
  UNPUBLISH: {
    label: "Taken off the site",
    phrase: "took this off the site",
    icon: EyeOff,
    tone: "warn"
  },
  ARCHIVE: { label: "Archived", phrase: "archived this", icon: Archive, tone: "neutral" },
  LOGIN: { label: "Signed in", phrase: "signed in", icon: LogIn, tone: "neutral" },
  LOGIN_FAILED: {
    label: "Sign-in refused",
    phrase: "was refused a sign-in",
    icon: ShieldAlert,
    tone: "error"
  },
  LOGOUT: { label: "Signed out", phrase: "signed out", icon: LogOut, tone: "neutral" },
  PERMISSION_CHANGE: {
    label: "Changed what somebody may do",
    phrase: "changed what somebody is allowed to do",
    icon: KeyRound,
    tone: "error"
  },
  UPLOAD: { label: "Uploaded", phrase: "uploaded this", icon: Upload, tone: "neutral" },
  PURGE: { label: "Deleted for good", phrase: "deleted this for good", icon: Flame, tone: "error" },
  ROLLBACK: {
    label: "Earlier version put back",
    phrase: "put back an earlier version of this",
    icon: RotateCcw,
    tone: "warn"
  }
};

/** Read through a `Partial` view, so an action from a newer deploy still renders. See the header. */
function actionWords(action: AuditAction): ActionWords {
  const table: Partial<Record<AuditAction, ActionWords>> = ACTION_WORDS;
  return (
    table[action] ?? {
      label: humanise(action),
      phrase: `recorded ${humanise(action).toLowerCase()} against this`,
      icon: Info,
      tone: "neutral"
    }
  );
}

/** Plain nouns for the polymorphic `entityType`, singular and plural. */
const ENTITY_NOUNS: Record<string, { one: string; many: string }> = {
  Page: { one: "page", many: "pages" },
  PageSection: { one: "block on a page", many: "blocks on pages" },
  Post: { one: "news article", many: "news articles" },
  Person: { one: "person's profile", many: "people's profiles" },
  Project: { one: "project", many: "projects" },
  Publication: { one: "publication", many: "publications" },
  ResearchArea: { one: "research area", many: "research areas" },
  CoeEvent: { one: "event", many: "events" },
  Craft: { one: "craft record", many: "craft records" },
  GalleryAlbum: { one: "gallery album", many: "gallery albums" },
  GalleryItem: { one: "picture in an album", many: "pictures in albums" },
  MediaAsset: { one: "media file", many: "media files" },
  MediaFolder: { one: "media folder", many: "media folders" },
  FileAsset: { one: "file", many: "files" },
  User: { one: "user account", many: "user accounts" },
  NavigationItem: { one: "menu item", many: "menu items" },
  Setting: { one: "setting", many: "settings" },
  Redirect: { one: "redirect", many: "redirects" },
  Partner: { one: "partner", many: "partners" },
  Category: { one: "news category", many: "news categories" },
  Tag: { one: "tag", many: "tags" },
  ContactSubmission: { one: "enquiry", many: "enquiries" },
  EventRegistration: { one: "event registration", many: "event registrations" }
};

function humanise(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim()
    .toLowerCase();
  if (words.length === 0) return value;
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function nounFor(entityType: string, count: number): string {
  const found = ENTITY_NOUNS[entityType];
  if (found) return count === 1 ? found.one : found.many;
  return humanise(entityType).toLowerCase();
}

/**
 * A date in a NAMED zone.
 *
 * UTC, matching the audit screen and every bucket the queries use. A studio whose people are in two
 * countries needs one answer to "when did this happen", and the zone is stated so nobody has to guess
 * whose afternoon it was.
 */
function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "a time that could not be read";
  return `${date.toLocaleString("en-GB", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC"
  })} UTC`;
}

function formatDayLabel(day: string): string {
  const date = new Date(day);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC"
  });
}

/** Whoever did it, named as well as the record allows. */
function whoDidIt(actor: { name: string | null; email: string | null }): string {
  const name = actor.name?.trim();
  if (name && name.length > 0) return name;
  const email = actor.email?.trim();
  if (email && email.length > 0) return email;
  return "Somebody whose account has since been removed";
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en-GB")} ${count === 1 ? one : many}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// What the endpoint answers
//
// The payload types come from lib/provenance.ts; only the envelopes are declared here, because the
// route composes them.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface RecordsResponse {
  results: CappedList<RecordSearchHit>;
  scanned: number;
  scanCap: number;
  note: string;
}

interface RecordResponse {
  record: RecordProvenance;
  note: string;
}

interface PeopleResponse {
  results: CappedList<PersonSearchHit>;
}

interface ActorResponse {
  activity: ActorProvenance;
  note?: string;
}

interface InstallationResponse {
  overview: InstallationProvenance;
  note: string;
}

interface DiffResponse {
  diff: RevisionDiff | null;
  reason: string | null;
  message: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Small shared pieces
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function ActionChip({ action, size = "sm" }: { action: AuditAction; size?: "sm" | "md" }) {
  const words = actionWords(action);
  return (
    <Badge tone={words.tone} size={size} icon={words.icon}>
      {words.label}
    </Badge>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="panel px-4 py-3">
      <p className="text-xs font-medium text-ink-500">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-ink-900">{value}</p>
      {hint ? <p className="mt-1 text-xs leading-relaxed text-ink-500">{hint}</p> : null}
    </div>
  );
}

/**
 * The truncation sentence.
 *
 * Rendered for EVERY capped list, because a list that quietly stops is indistinguishable from a place
 * with only that many records (contract §1.6). `total === null` is the case where counting every match
 * would have cost more than the answer is worth — the sentence says "and there are more" rather than
 * inventing a figure.
 */
function CapNote({
  list,
  one,
  many
}: {
  list: CappedList<unknown>;
  one: string;
  many: string;
}) {
  if (!list.truncated) return null;
  return (
    <HelpText tone="warn">
      {list.total === null
        ? `Showing the first ${plural(list.items.length, one, many)}. There are more than this — narrow the search or shorten the period to see them.`
        : `Showing ${list.items.length.toLocaleString("en-GB")} of ${plural(list.total, one, many)}. Narrow the search or shorten the period to see the rest.`}
    </HelpText>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="panel px-4 py-4">
      <Skeleton lines={3} label={label} />
    </div>
  );
}

function Problem({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-md border border-error-200 bg-error-100 px-3.5 py-3 text-sm leading-relaxed text-error-700"
    >
      <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </p>
  );
}

/**
 * A proportion bar.
 *
 * `aria-hidden`, and it must stay that way: the number it represents is already text beside it, so a
 * screen reader announcing the bar as well would read every figure twice. The width is an inline style
 * because it is a computed percentage — a class name built by concatenation is purged (contract §5).
 */
function SeriesBar({ value, max, tone }: { value: number; max: number; tone: "brand" | "alert" }) {
  const share = max > 0 ? (value / max) * 100 : 0;
  // A non-zero count always draws something: a bar of zero width for "1 sign-in" reads as none at all.
  const width = value > 0 ? Math.max(4, Math.round(share)) : 0;
  return (
    <span aria-hidden="true" className="block h-1.5 w-full rounded-full bg-surface-200">
      <span
        // Complete literal class strings — a name assembled by concatenation is purged (contract §5).
        className={cn("block h-1.5 rounded-full", tone === "brand" ? "bg-purple-700" : "bg-error-600")}
        style={{ width: `${width}%` }}
      />
    </span>
  );
}

/** The three periods this screen offers. Bounded so a day chart is always a readable length. */
const RANGE_CHOICES = [
  { value: "7", label: "The last 7 days" },
  { value: "30", label: "The last 30 days" },
  { value: "90", label: "The last 90 days" }
] as const;

/**
 * `from` and `to` for a preset, as `YYYY-MM-DD`.
 *
 * The two strings only ever reach a query string — never the screen — so the fact that the server and
 * the browser could compute a different "today" across midnight cannot produce a hydration mismatch.
 * Every date a reader sees comes back from the endpoint, resolved once, on the server.
 */
function rangeFor(days: number): { from: string; to: string } {
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  return {
    to: new Date(now).toISOString().slice(0, 10),
    from: new Date(now - (days - 1) * DAY_MS).toISOString().slice(0, 10)
  };
}

function RangePicker({
  days,
  onChange,
  label
}: {
  days: string;
  onChange: (next: string) => void;
  label: string;
}) {
  return (
    <Field label={label} help="Dates are read as UTC, which is how the history stores them.">
      <Select
        value={days}
        onChange={(event) => onChange(event.currentTarget.value)}
        options={RANGE_CHOICES.map((choice) => ({ value: choice.value, label: choice.label }))}
      />
    </Field>
  );
}

/** A person's role and standing, as words. Used wherever an account is listed. */
function PersonChips({
  role,
  isActive,
  twoFactorEnabled
}: {
  role: keyof typeof ROLE_LABELS;
  isActive?: boolean;
  twoFactorEnabled?: boolean;
}) {
  return (
    <>
      <Badge tone="neutral" size="sm" icon={UserRound}>
        {ROLE_LABELS[role]}
      </Badge>
      {isActive === false ? (
        <Badge tone="warn" size="sm" icon={Lock}>
          Deactivated
        </Badge>
      ) : null}
      {twoFactorEnabled === false ? (
        <Badge tone="warn" size="sm" icon={ShieldOff}>
          No second factor
        </Badge>
      ) : null}
      {twoFactorEnabled === true ? (
        <Badge tone="success" size="sm" icon={ShieldCheck}>
          Second factor on
        </Badge>
      ) : null}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Tab 1 — this installation
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function InstallationTab() {
  const [days, setDays] = useState("7");
  const [addressQuery, setAddressQuery] = useState("");

  // Named `dates`, never `window` — a local called `window` shadows the browser global for the whole
  // function, which is a trap waiting for the first line that needs it.
  const dates = useMemo(() => rangeFor(Number.parseInt(days, 10)), [days]);
  // Debounce the composed PATH, not the box: the period picker and the search then share one timer, so
  // changing both cannot put two overlapping requests in flight (lib/client/useResource.ts).
  const path = useDebouncedValue(
    `/api/studio/provenance${buildQuery({
      view: "installation",
      from: dates.from,
      to: dates.to,
      q: addressQuery.trim()
    })}`,
    DEBOUNCE_MS
  );

  const { data, error, isLoading } = useResource<InstallationResponse>(path);
  const overview = data?.overview ?? null;

  const series = overview?.byDay ?? [];
  const shownSeries = series.slice(0, SERIES_ROW_LIMIT);
  const maxSignIns = shownSeries.reduce((most, row) => Math.max(most, row.signIns), 0);
  const maxRefused = shownSeries.reduce((most, row) => Math.max(most, row.refused), 0);

  return (
    <div className="space-y-6">
      <FormSection
        title="What has been happening"
        description="Sign-ins, refusals and changes across the whole studio for the period you choose."
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <RangePicker days={days} onChange={setDays} label="Time covered" />

          {/*
            `SearchInput` is NOT wrapped in a `Field`. It contains a clear `<button>`, and a `<label>`
            around a button forwards stray clicks to it and folds its name into the input's accessible
            name (Field.tsx). The component carries its own label; the note below is a sibling.
          */}
          <SearchInput
            label="Search refused sign-ins by the network address they came from"
            placeholder="Search by address"
            value={addressQuery}
            onValueChange={setAddressQuery}
            clearLabel="Clear the address search"
            className="sm:min-w-[16rem] sm:flex-1"
          />
        </div>

        <HelpText>
          The search looks only at the network address an attempt came from. The addresses people typed
          are deliberately not searchable: they are shown with the name part hidden, and a search that
          could confirm one would undo that a guess at a time.
        </HelpText>
      </FormSection>

      {error ? <Problem message={error.message} /> : null}

      {overview === null ? (
        isLoading ? (
          <Loading label="Reading the studio's history" />
        ) : null
      ) : (
        <>
          {overview.range.swapped ? (
            <HelpText tone="warn">
              The two dates arrived the wrong way round, so they have been swapped. The figures below
              cover {plural(overview.range.days, "day", "days")}.
            </HelpText>
          ) : null}
          {overview.range.capped ? (
            <HelpText tone="warn">
              That range was longer than one request may cover, so these figures are for the most recent{" "}
              {plural(overview.range.days, "day", "days")} of it.
            </HelpText>
          ) : null}

          <dl className="grid gap-3 sm:grid-cols-3">
            <Metric
              label="Sign-ins"
              value={overview.totals.signIns.toLocaleString("en-GB")}
              hint={`Across ${plural(overview.range.days, "day", "days")}.`}
            />
            <Metric
              label="Sign-ins refused"
              value={overview.totals.refused.toLocaleString("en-GB")}
              hint="A wrong password, a wrong code, or an address that is not allowed in."
            />
            <Metric
              label="Changes made"
              value={overview.totals.changes.toLocaleString("en-GB")}
              hint="Everything that was not a sign-in, sign-out or refusal."
            />
          </dl>

          <FormSection
            title="Day by day"
            description="Every day in the period is here, including the quiet ones — a chart built only from the busy days would be a different shape from the record."
          >
            {shownSeries.length === 0 ? (
              <p className="text-sm text-ink-500">There are no days in this period.</p>
            ) : (
              <ol className="space-y-2">
                {shownSeries.map((row) => (
                  <li key={row.day} className="grid gap-x-4 gap-y-1 sm:grid-cols-[9rem_1fr]">
                    <p className="text-xs font-medium text-ink-700">
                      <time dateTime={row.day}>{formatDayLabel(row.day)}</time>
                    </p>
                    <div className="min-w-0 space-y-1.5">
                      <div>
                        <p className="text-xs text-ink-500">
                          <LogIn aria-hidden="true" className="mr-1 inline h-3 w-3" />
                          {plural(row.signIns, "sign-in", "sign-ins")}
                        </p>
                        <SeriesBar value={row.signIns} max={maxSignIns} tone="brand" />
                      </div>
                      <div>
                        <p className="text-xs text-ink-500">
                          <ShieldAlert aria-hidden="true" className="mr-1 inline h-3 w-3" />
                          {plural(row.refused, "refused", "refused")}
                        </p>
                        <SeriesBar value={row.refused} max={maxRefused} tone="alert" />
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {series.length > shownSeries.length ? (
              <HelpText tone="warn">
                Only the first {SERIES_ROW_LIMIT} days of that range are drawn. Choose a shorter period
                to see the rest.
              </HelpText>
            ) : null}
          </FormSection>

          <div className="grid gap-6 xl:grid-cols-2">
            <FormSection
              title="Who signed in"
              description="Everybody who got into the studio during this period, most sign-ins first."
            >
              {overview.signedIn.items.length === 0 ? (
                <p className="text-sm text-ink-500">Nobody signed in during this period.</p>
              ) : (
                <ul className="space-y-2.5">
                  {overview.signedIn.items.map((person) => (
                    <li key={person.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <span className="text-sm font-medium text-ink-900">{person.name}</span>
                      <PersonChips role={person.role} />
                      <span className="text-xs tabular-nums text-ink-500">
                        {plural(person.count, "sign-in", "sign-ins")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <CapNote list={overview.signedIn} one="person" many="people" />
            </FormSection>

            <FormSection
              title="Who changed the most"
              description="Counted by recorded changes to content and settings, not by sign-ins."
            >
              {overview.mostActive.items.length === 0 ? (
                <p className="text-sm text-ink-500">Nothing was changed during this period.</p>
              ) : (
                <ul className="space-y-2.5">
                  {overview.mostActive.items.map((person) => (
                    <li key={person.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <span className="text-sm font-medium text-ink-900">{person.name}</span>
                      <PersonChips role={person.role} />
                      <span className="text-xs tabular-nums text-ink-500">
                        {plural(person.count, "change", "changes")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <CapNote list={overview.mostActive} one="person" many="people" />
            </FormSection>
          </div>

          <FormSection
            title="Sign-ins that were refused"
            description="Every refusal in the period, with the reason it was refused. An address this studio does not recognise is shown with the name part hidden — the part after the @ is what answers whether somebody is working through a list of addresses here."
          >
            {overview.refusals.items.length === 0 ? (
              <p className="text-sm text-ink-500">
                {overview.addressFilter.length > 0
                  ? "No refused sign-ins in this period came from an address matching that search."
                  : "No sign-in was refused during this period."}
              </p>
            ) : (
              <ol className="space-y-2.5">
                {overview.refusals.items.map((attempt) => (
                  <li key={attempt.id} className="panel px-3.5 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <ActionChip action="LOGIN_FAILED" />
                      {attempt.address ? (
                        <span className="text-sm font-medium text-ink-900">{attempt.address}</span>
                      ) : (
                        <span className="text-sm text-ink-500">no address was recorded</span>
                      )}
                      {attempt.address && !attempt.addressKnown ? (
                        <Badge tone="neutral" size="sm" icon={Eye}>
                          Name part hidden
                        </Badge>
                      ) : null}
                      {attempt.addressKnown ? (
                        <Badge tone="warn" size="sm" icon={UserRound}>
                          Known to this studio
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-1.5 text-sm leading-relaxed text-ink-700">
                      Refused on <time dateTime={attempt.at}>{formatWhen(attempt.at)}</time>
                      {attempt.ipAddress ? ` from ${attempt.ipAddress}` : ""}
                      {attempt.provider ? ` using ${humanise(attempt.provider)}` : ""} — {attempt.reason}.
                    </p>
                  </li>
                ))}
              </ol>
            )}
            <CapNote list={overview.refusals} one="refusal" many="refusals" />
          </FormSection>

          <div className="grid gap-6 xl:grid-cols-2">
            <FormSection
              title="Where the refusals came from"
              description="The same refusals grouped by network address, so a burst from one place reads as one line rather than fifty."
            >
              {overview.refusalSources.items.length === 0 ? (
                <p className="text-sm text-ink-500">
                  No refused sign-in in this period recorded an address.
                </p>
              ) : (
                <ul className="space-y-2">
                  {overview.refusalSources.items.map((source) => (
                    <li key={source.address} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-900">
                        <Network aria-hidden="true" className="h-3.5 w-3.5 text-ink-500" />
                        {source.address}
                      </span>
                      <span className="text-xs tabular-nums text-ink-500">
                        {plural(source.count, "refusal", "refusals")}, last{" "}
                        <time dateTime={source.lastSeen}>{formatWhen(source.lastSeen)}</time>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <CapNote list={overview.refusalSources} one="address" many="addresses" />
            </FormSection>

            <FormSection
              title="Accounts with no second factor"
              description="Active accounts that can be signed into with a password alone. Listed with the most powerful first, because that is where it matters most."
            >
              {overview.withoutTwoFactor.items.length === 0 ? (
                <p className="text-sm text-ink-500">
                  Every active account has a second factor switched on.
                </p>
              ) : (
                <ul className="space-y-2.5">
                  {overview.withoutTwoFactor.items.map((person) => (
                    <li key={person.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <span className="text-sm font-medium text-ink-900">{person.name}</span>
                      <span className="text-xs text-ink-500">{person.email}</span>
                      <PersonChips role={person.role} twoFactorEnabled={false} />
                      <span className="text-xs text-ink-500">
                        {person.lastLoginAt
                          ? `last signed in ${formatWhen(person.lastLoginAt)}`
                          : "has never signed in"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <CapNote list={overview.withoutTwoFactor} one="account" many="accounts" />
            </FormSection>
          </div>

          <FormSection
            title="Grants that have never been used"
            description="Addresses on the studio access list that nobody has ever signed in with. An access list nobody can tell is stale is a list nobody dares tidy — these are the rows worth asking about."
          >
            {overview.unusedGrants.items.length === 0 ? (
              <p className="text-sm text-ink-500">
                Every address on the access list has been used at least once.
              </p>
            ) : (
              <ul className="space-y-2.5">
                {overview.unusedGrants.items.map((grant) => (
                  <li key={grant.id} className="panel px-3.5 py-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <span className="text-sm font-medium text-ink-900">{grant.email}</span>
                      {grant.name ? <span className="text-xs text-ink-500">{grant.name}</span> : null}
                      <Badge tone="neutral" size="sm" icon={KeyRound}>
                        {ROLE_LABELS[grant.grantedRole]} on first sign-in
                      </Badge>
                      <Badge tone="warn" size="sm" icon={Hourglass}>
                        Never used
                      </Badge>
                    </div>
                    <p className="mt-1.5 text-xs leading-relaxed text-ink-500">
                      Added <time dateTime={grant.addedAt}>{formatWhen(grant.addedAt)}</time>
                      {grant.addedByName ? ` by ${grant.addedByName}` : ""}.{" "}
                      {grant.allowedProviders.length === 0
                        ? "Any sign-in method the studio offers."
                        : `Only ${grant.allowedProviders.map((provider) => humanise(provider)).join(", ")}.`}
                    </p>
                    {grant.note ? (
                      <p className="mt-1 text-xs leading-relaxed text-ink-700">{grant.note}</p>
                    ) : (
                      <p className="mt-1 text-xs leading-relaxed text-ink-500">
                        No reason was written down for this grant.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <CapNote list={overview.unusedGrants} one="grant" many="grants" />
          </FormSection>

          <HelpText>{data?.note}</HelpText>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Tab 2 — one record
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function RecordTab() {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<{ entityType: string; entityId: string } | null>(null);

  const term = search.trim();
  const searchPath = useDebouncedValue(
    term.length > 0 ? `/api/studio/provenance${buildQuery({ view: "records", q: term })}` : "",
    DEBOUNCE_MS
  );

  // A null path SUSPENDS the fetch (lib/client/useResource.ts): with an empty box there is no question
  // to ask, and asking one would list whatever happens to be newest as though it were a result.
  const results = useResource<RecordsResponse>(searchPath.length > 0 ? searchPath : null);

  return (
    <div className="space-y-6">
      <FormSection
        title="Find a record"
        description="Search by what the record is called, or paste its id. The search reads the history rather than the tables, so something that has been deleted for good can still be found."
      >
        <Field label="Search" htmlFor="provenance-record-search">
          <SearchInput
            id="provenance-record-search"
            label="Search records by name or id"
            value={search}
            onValueChange={setSearch}
            placeholder="Annual report, or a record id"
            clearLabel="Clear the record search"
          />
        </Field>

        {results.error ? <Problem message={results.error.message} /> : null}

        {term.length === 0 ? (
          <p className="text-sm text-ink-500">
            Type a few words to look for a record. Nothing is listed until you do — a list of whatever
            happens to be newest is not a search result.
          </p>
        ) : results.data === null ? (
          results.isLoading ? (
            <Skeleton lines={3} label="Searching the history" />
          ) : null
        ) : results.data.results.items.length === 0 ? (
          <EmptyState
            icon={SearchX}
            headingLevel={3}
            title="Nothing matches those words"
            description={`The search looked at the ${plural(results.data.scanned, "most recent recorded action", "most recent recorded actions")} that mention them. Try a shorter phrase, or paste the record's id.`}
          />
        ) : (
          <>
            <ul className="space-y-1.5">
              {results.data.results.items.map((hit) => {
                const isSelected =
                  selected?.entityType === hit.entityType && selected?.entityId === hit.entityId;
                return (
                  <li key={`${hit.entityType}:${hit.entityId}`}>
                    <button
                      type="button"
                      onClick={() =>
                        setSelected({ entityType: hit.entityType, entityId: hit.entityId })
                      }
                      aria-pressed={isSelected}
                      className={cn(
                        "flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-left transition",
                        isSelected
                          ? "border-purple-700 bg-purple-100"
                          : "border-line-200 bg-card hover:bg-surface-100"
                      )}
                    >
                      <span className="text-sm font-medium text-ink-900">
                        {hit.label && hit.label.length > 0
                          ? hit.label
                          : `an unnamed ${nounFor(hit.entityType, 1)}`}
                      </span>
                      <span className="text-xs text-ink-500">{nounFor(hit.entityType, 1)}</span>
                      <ActionChip action={hit.lastAction} />
                      <span className="text-xs text-ink-500">
                        last touched <time dateTime={hit.lastChangeAt}>{formatWhen(hit.lastChangeAt)}</time>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <CapNote list={results.data.results} one="record" many="records" />
            <HelpText>{results.data.note}</HelpText>
          </>
        )}
      </FormSection>

      {selected ? (
        // The key remounts the panel when a different record is chosen, which resets the version
        // pickers below. Without it, "compare version 4 with version 7" would survive into a record
        // that has neither.
        <RecordDetail
          key={`${selected.entityType}:${selected.entityId}`}
          entityType={selected.entityType}
          entityId={selected.entityId}
        />
      ) : null}
    </div>
  );
}

function RecordDetail({ entityType, entityId }: { entityType: string; entityId: string }) {
  const { data, error, isLoading } = useResource<RecordResponse>(
    `/api/studio/provenance${buildQuery({ view: "record", entityType, entityId })}`
  );

  const [olderId, setOlderId] = useState("");
  const [newerId, setNewerId] = useState("");
  const [pair, setPair] = useState<{ a: string; b: string } | null>(null);

  const diff = useResource<DiffResponse>(
    pair ? `/api/studio/provenance${buildQuery({ view: "diff", a: pair.a, b: pair.b })}` : null
  );

  if (error) return <Problem message={error.message} />;
  if (data === null) return isLoading ? <Loading label="Reading this record's history" /> : null;

  const record = data.record;
  const noun = nounFor(record.entityType, 1);
  const versionOptions = record.revisions.items.map((revision) => ({
    value: revision.id,
    label: `Version ${revision.version} — ${formatWhen(revision.at)}`
  }));

  if (record.empty) {
    return (
      <EmptyState
        icon={FileSearch}
        headingLevel={2}
        title="Nothing is recorded against that record"
        description="No change, no version and no sign of it in the history. Either the id is not quite right, or the record was created before this studio began keeping a history."
      />
    );
  }

  return (
    <div className="space-y-6">
      <FormSection
        title="What this record is"
        description={data.note}
        actions={
          <span className="text-xs tabular-nums text-ink-500">
            {plural(record.totalEvents, "recorded action", "recorded actions")}
          </span>
        }
      >
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium text-ink-500">Name in the record</dt>
            <dd className="mt-1 text-sm font-medium text-ink-900">
              {record.label && record.label.length > 0 ? record.label : `an unnamed ${noun}`}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-ink-500">Kind of record</dt>
            <dd className="mt-1 text-sm text-ink-900">{humanise(noun)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-ink-500">Created</dt>
            <dd className="mt-1 text-sm leading-relaxed text-ink-900">
              {record.created ? (
                <>
                  {whoDidIt(record.created.actor)} created it on{" "}
                  <time dateTime={record.created.at}>{formatWhen(record.created.at)}</time>.
                </>
              ) : record.firstSeenAt ? (
                <>
                  No creation is recorded. The oldest entry about it is from{" "}
                  <time dateTime={record.firstSeenAt}>{formatWhen(record.firstSeenAt)}</time>, so it was
                  probably made before the studio began keeping a history.
                </>
              ) : (
                "No creation is recorded."
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-ink-500">Last touched</dt>
            <dd className="mt-1 text-sm text-ink-900">
              {record.lastChangeAt ? (
                <time dateTime={record.lastChangeAt}>{formatWhen(record.lastChangeAt)}</time>
              ) : (
                "Never"
              )}
            </dd>
          </div>
        </dl>

        {record.labelWithheld ? (
          <HelpText tone="warn">
            This record names somebody who is not a member of this studio, so what it is called is not
            shown here. Who did what to it, and when, still is.
          </HelpText>
        ) : null}

        {record.restoredFromBin > 0 ? (
          <HelpText tone="warn">
            This has been pulled back out of the recycle bin{" "}
            {record.restoredFromBin === 1 ? "once" : `${record.restoredFromBin} times`}. A record that
            keeps coming back is usually one two people disagree about.
          </HelpText>
        ) : null}

        {record.lock ? (
          <HelpText tone={record.lock.lapsed ? "neutral" : "warn"} icon={Lock}>
            {record.lock.lapsed ? (
              <>
                {record.lock.holderName} had this open until{" "}
                <time dateTime={record.lock.expiresAt}>{formatWhen(record.lock.expiresAt)}</time>, when
                the hold lapsed. Nobody is editing it now.
              </>
            ) : (
              <>
                {record.lock.holderName} has this open for editing, and has had since{" "}
                <time dateTime={record.lock.since}>{formatWhen(record.lock.since)}</time>.
              </>
            )}
          </HelpText>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {record.byAction.map((entry) => (
            <span key={entry.action} className="inline-flex items-center gap-1.5">
              <ActionChip action={entry.action} />
              <span className="text-xs tabular-nums text-ink-500">
                {entry.count.toLocaleString("en-GB")}
              </span>
            </span>
          ))}
        </div>
      </FormSection>

      <FormSection
        title="Everything that has happened to it"
        description="Newest first. Each line names whoever did it and, for a change, which fields moved — the values themselves are in the audit log."
      >
        {record.timeline.items.length === 0 ? (
          <p className="text-sm text-ink-500">Nothing is recorded against this record.</p>
        ) : (
          <ol className="space-y-2.5">
            {record.timeline.items.map((event) => (
              <li key={event.id} className="panel px-3.5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <ActionChip action={event.action} />
                  <p className="text-sm leading-relaxed text-ink-900">
                    {whoDidIt(event.actor)} {actionWords(event.action).phrase} on{" "}
                    <time dateTime={event.at}>{formatWhen(event.at)}</time>.
                  </p>
                </div>

                {event.changedFields.length > 0 ? (
                  <p className="mt-1.5 text-xs leading-relaxed text-ink-500">
                    Fields that changed:{" "}
                    {event.changedFields.map((field) => humanise(field).toLowerCase()).join(", ")}
                    {event.changedFieldsTotal > event.changedFields.length
                      ? `, and ${event.changedFieldsTotal - event.changedFields.length} more`
                      : ""}
                    .
                  </p>
                ) : event.isEvent ? (
                  <p className="mt-1.5 text-xs text-ink-500">
                    This kind of entry records no before and after — it is something that happened rather
                    than a change to the record.
                  </p>
                ) : (
                  <p className="mt-1.5 text-xs text-ink-500">
                    Nothing differs apart from fields that change on every save.
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
        <CapNote list={record.timeline} one="entry" many="entries" />
      </FormSection>

      <FormSection
        title="Stored versions"
        description="Every version the studio kept, newest first. Two of them can be compared, and the comparison is worked out when you ask for it rather than stored."
      >
        {record.revisions.items.length === 0 ? (
          <p className="text-sm text-ink-500">
            No versions were stored for this record. Some kinds of change are logged without a version —
            a change of state, or a re-ordering — because there is nothing new to keep.
          </p>
        ) : (
          <>
            <ol className="space-y-2">
              {record.revisions.items.map((revision) => (
                <li key={revision.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-sm font-medium tabular-nums text-ink-900">
                    Version {revision.version}
                  </span>
                  <span className="text-xs text-ink-500">
                    <time dateTime={revision.at}>{formatWhen(revision.at)}</time>
                  </span>
                  <span className="text-xs text-ink-500">by {whoDidIt(revision.author)}</span>
                  {revision.summary ? (
                    <span className="text-xs text-ink-700">{revision.summary}</span>
                  ) : null}
                </li>
              ))}
            </ol>
            <CapNote list={record.revisions} one="version" many="versions" />

            {record.revisions.items.length >= 2 ? (
              <div className="mt-2 grid gap-4 sm:grid-cols-2">
                <Field label="Compare this version">
                  <Select
                    value={olderId}
                    onChange={(event) => setOlderId(event.currentTarget.value)}
                    placeholder="Choose a version"
                    options={versionOptions}
                  />
                </Field>
                <Field label="With this one">
                  <Select
                    value={newerId}
                    onChange={(event) => setNewerId(event.currentTarget.value)}
                    placeholder="Choose a version"
                    options={versionOptions}
                  />
                </Field>
                <div className="sm:col-span-2">
                  <Button
                    type="button"
                    variant="secondary"
                    icon={GitCompare}
                    // Nothing to compare is nothing to press. The refusal is not hidden behind a
                    // click — the two boxes above are what the reader has to fill in.
                    disabled={olderId.length === 0 || newerId.length === 0}
                    onClick={() => setPair({ a: olderId, b: newerId })}
                  >
                    Compare these two versions
                  </Button>
                </div>
              </div>
            ) : (
              <HelpText>
                There is only one stored version, so there is nothing to compare it with yet.
              </HelpText>
            )}
          </>
        )}
      </FormSection>

      {pair ? (
        <FormSection
          title="What changed between those two versions"
          description="Field by field. A long value is shortened, and the length of the whole thing is stated beside it."
        >
          {diff.error ? <Problem message={diff.error.message} /> : null}
          {diff.data === null ? (
            diff.isLoading ? (
              <Skeleton lines={4} label="Comparing the two versions" />
            ) : null
          ) : diff.data.diff === null ? (
            <HelpText tone="warn">
              {diff.data.message ?? "Those two versions could not be compared."}
            </HelpText>
          ) : (
            <RevisionComparison diff={diff.data.diff} />
          )}
        </FormSection>
      ) : null}
    </div>
  );
}

function ValueBox({
  heading,
  preview
}: {
  heading: string;
  preview: ValuePreview | null;
}) {
  return (
    <div className="min-w-0 rounded-md border border-line-200 bg-surface-50 px-2.5 py-2">
      <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-ink-500">{heading}</p>
      {preview === null ? (
        <p className="mt-1 text-xs text-ink-500">The field was not there at all.</p>
      ) : preview.kind === "empty" ? (
        <p className="mt-1 text-xs text-ink-500">Not set.</p>
      ) : preview.kind === "unreadable" ? (
        <p className="mt-1 text-xs text-ink-500">This value cannot be shown on a screen.</p>
      ) : (
        <>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[0.6875rem] leading-relaxed text-ink-900">
            {preview.text}
          </pre>
          {preview.truncated ? (
            <p className="mt-1 text-[0.6875rem] text-ink-500">
              Shortened here. The whole value is {preview.length.toLocaleString("en-GB")} characters
              long.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function ChangeList({
  title,
  icon: Icon,
  rows,
  emptyLabel
}: {
  title: string;
  icon: LucideIcon;
  rows: RevisionFieldChange[];
  emptyLabel: string;
}) {
  return (
    <section>
      {/* `h3`, not `h4`: the enclosing `FormSection` renders an `h2` and heading levels never skip
          (contract §11). */}
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-900">
        <Icon aria-hidden="true" className="h-4 w-4 text-ink-500" />
        {title}
      </h3>
      {rows.length === 0 ? (
        <p className="mt-1 text-xs text-ink-500">{emptyLabel}</p>
      ) : (
        <dl className="mt-2 space-y-3">
          {rows.map((row) => (
            <div key={row.field} className="min-w-0">
              <dt className="text-xs font-semibold text-ink-900">{humanise(row.field)}</dt>
              <dd className="mt-1 grid gap-2 sm:grid-cols-2">
                <ValueBox heading="Before" preview={row.before} />
                <ValueBox heading="After" preview={row.after} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function RevisionComparison({ diff }: { diff: RevisionDiff }) {
  const changeCount = diff.added.length + diff.removed.length + diff.changed.length;

  return (
    <div className="space-y-5">
      <p className="text-sm leading-relaxed text-ink-700">
        Comparing version {diff.from.version} —{" "}
        <time dateTime={diff.from.at}>{formatWhen(diff.from.at)}</time>
        {diff.from.authorName ? `, saved by ${diff.from.authorName}` : ""} — with version{" "}
        {diff.to.version} — <time dateTime={diff.to.at}>{formatWhen(diff.to.at)}</time>
        {diff.to.authorName ? `, saved by ${diff.to.authorName}` : ""}. The comparison always reads
        forward in time, whichever order you chose them in.
      </p>

      {changeCount === 0 ? (
        <HelpText>
          Nothing differs between these two versions apart from fields that change on every save.
        </HelpText>
      ) : (
        <>
          <p className="text-xs text-ink-500">
            {plural(changeCount, "field differs", "fields differ")};{" "}
            {plural(diff.unchanged, "field is", "fields are")} the same in both.
          </p>

          <ChangeList
            title="Changed"
            icon={Pencil}
            rows={diff.changed}
            emptyLabel="No field that exists in both versions has a different value."
          />
          <ChangeList
            title="Added"
            icon={Plus}
            rows={diff.added}
            emptyLabel="The later version has no field the earlier one lacked."
          />
          <ChangeList
            title="Removed"
            icon={Trash2}
            rows={diff.removed}
            emptyLabel="The later version still has every field the earlier one had."
          />
        </>
      )}

      {diff.ignoredFields.length > 0 ? (
        <HelpText>
          Left out of the comparison because they change on every save:{" "}
          {diff.ignoredFields.map((field) => humanise(field).toLowerCase()).join(", ")}.
        </HelpText>
      ) : null}

      {diff.truncated ? (
        <HelpText tone="warn">
          More than {diff.cap} fields differ, so the list stops there. Compare two closer versions to see
          the rest.
        </HelpText>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Tab 3 — one person
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function PersonTab() {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // The people list is asked for with an EMPTY search too — unlike the record search. A studio has a
  // knowable number of colleagues, so the first page of them is a useful answer rather than noise.
  const searchPath = useDebouncedValue(
    `/api/studio/provenance${buildQuery({ view: "people", q: search.trim() })}`,
    DEBOUNCE_MS
  );
  const people = useResource<PeopleResponse>(searchPath);

  return (
    <div className="space-y-6">
      <FormSection
        title="Find a colleague"
        description="Only studio accounts appear here. Accounts that have been removed are included, because somebody whose account went last month is exactly who a review is usually about."
      >
        <Field label="Search" htmlFor="provenance-person-search">
          <SearchInput
            id="provenance-person-search"
            label="Search colleagues by name or email address"
            value={search}
            onValueChange={setSearch}
            placeholder="Name or email address"
            clearLabel="Clear the colleague search"
          />
        </Field>

        {people.error ? <Problem message={people.error.message} /> : null}

        {people.data === null ? (
          people.isLoading ? (
            <Skeleton lines={3} label="Looking up colleagues" />
          ) : null
        ) : people.data.results.items.length === 0 ? (
          <EmptyState
            icon={UserSearch}
            headingLevel={3}
            title="No account matches those words"
            description="Try part of a name, or the beginning of an email address."
          />
        ) : (
          <>
            <ul className="space-y-1.5">
              {people.data.results.items.map((person) => (
                <li key={person.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(person.id)}
                    aria-pressed={selectedId === person.id}
                    className={cn(
                      "flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-left transition",
                      selectedId === person.id
                        ? "border-purple-700 bg-purple-100"
                        : "border-line-200 bg-card hover:bg-surface-100"
                    )}
                  >
                    <span className="text-sm font-medium text-ink-900">{person.name}</span>
                    <span className="text-xs text-ink-500">{person.email}</span>
                    <PersonChips
                      role={person.role}
                      isActive={person.isActive}
                      twoFactorEnabled={person.twoFactorEnabled}
                    />
                  </button>
                </li>
              ))}
            </ul>
            <CapNote list={people.data.results} one="account" many="accounts" />
          </>
        )}
      </FormSection>

      {selectedId ? (
        // Remounted per person, so the range picker below starts from the default rather than carrying
        // one colleague's period onto the next.
        <PersonDetail key={selectedId} userId={selectedId} />
      ) : null}
    </div>
  );
}

function PersonDetail({ userId }: { userId: string }) {
  const [days, setDays] = useState("30");
  // `dates` for the same reason as in `InstallationTab`: a local named after the browser global would
  // shadow it for the whole function.
  const dates = useMemo(() => rangeFor(Number.parseInt(days, 10)), [days]);

  const { data, error, isLoading } = useResource<ActorResponse>(
    `/api/studio/provenance${buildQuery({
      view: "actor",
      userId,
      from: dates.from,
      to: dates.to
    })}`
  );

  if (error) return <Problem message={error.message} />;
  if (data === null) return isLoading ? <Loading label="Reading this colleague's activity" /> : null;

  const activity = data.activity;
  const series = activity.byDay.slice(0, SERIES_ROW_LIMIT);
  const maxCount = series.reduce((most, row) => Math.max(most, row.count), 0);

  if (!activity.person) {
    return (
      <EmptyState
        icon={UserSearch}
        headingLevel={2}
        title="That account no longer exists"
        description={
          data.note ??
          "Anything it did is still in the record, filed under the address it used at the time."
        }
      />
    );
  }

  const person = activity.person;

  return (
    <div className="space-y-6">
      <FormSection
        title={person.name}
        description="Everything this colleague has done in the period below, and the addresses they worked from."
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-ink-700">{person.email}</span>
          <PersonChips
            role={person.role}
            isActive={person.isActive}
            twoFactorEnabled={person.twoFactorEnabled}
          />
        </div>

        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium text-ink-500">Account created</dt>
            <dd className="mt-1 text-sm text-ink-900">
              <time dateTime={person.joinedAt}>{formatWhen(person.joinedAt)}</time>
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-ink-500">Last signed in</dt>
            <dd className="mt-1 text-sm text-ink-900">
              {person.lastLoginAt ? (
                <time dateTime={person.lastLoginAt}>{formatWhen(person.lastLoginAt)}</time>
              ) : (
                "Never"
              )}
            </dd>
          </div>
        </dl>

        <RangePicker days={days} onChange={setDays} label="Show" />

        {activity.range.capped ? (
          <HelpText tone="warn">
            That range was longer than one request may cover, so this covers the most recent{" "}
            {plural(activity.range.days, "day", "days")} of it.
          </HelpText>
        ) : null}
      </FormSection>

      <dl className="grid gap-3 sm:grid-cols-2">
        <Metric
          label="Changes in this period"
          value={activity.totalActions.toLocaleString("en-GB")}
          hint={`Across ${plural(activity.range.days, "day", "days")}.`}
        />
        <Metric
          label="Changes outside it"
          value={activity.actionsOutsideRange.toLocaleString("en-GB")}
          // Said out loud, because a filter that does not name what it excluded is a filter that
          // misleads: a quiet period is not the same as a quiet colleague.
          hint="Everything they have done at any other time. Widen the period to bring it into view."
        />
      </dl>

      <div className="grid gap-6 xl:grid-cols-2">
        <FormSection
          title="What they worked on"
          description="Their changes in this period, grouped by the kind of record."
        >
          {activity.byEntityType.items.length === 0 ? (
            <p className="text-sm text-ink-500">They changed nothing in this period.</p>
          ) : (
            <ul className="space-y-2">
              {activity.byEntityType.items.map((row) => (
                <li key={row.entityType} className="flex flex-wrap items-baseline gap-x-3">
                  <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-900">
                    <Layers aria-hidden="true" className="h-3.5 w-3.5 text-ink-500" />
                    {humanise(nounFor(row.entityType, row.count))}
                  </span>
                  <span className="text-xs tabular-nums text-ink-500">
                    {plural(row.count, "change", "changes")}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <CapNote list={activity.byEntityType} one="kind of record" many="kinds of record" />
        </FormSection>

        <FormSection
          title="Day by day"
          description="Every day in the period, including the ones they did nothing on."
        >
          {series.length === 0 ? (
            <p className="text-sm text-ink-500">There are no days in this period.</p>
          ) : (
            <ol className="space-y-1.5">
              {series.map((row) => (
                <li key={row.day} className="grid gap-x-4 gap-y-1 sm:grid-cols-[9rem_1fr]">
                  <p className="text-xs font-medium text-ink-700">
                    <time dateTime={row.day}>{formatDayLabel(row.day)}</time>
                  </p>
                  <div className="min-w-0">
                    <p className="text-xs tabular-nums text-ink-500">
                      {plural(row.count, "change", "changes")}
                    </p>
                    <SeriesBar value={row.count} max={maxCount} tone="brand" />
                  </div>
                </li>
              ))}
            </ol>
          )}
          {activity.byDay.length > series.length ? (
            <HelpText tone="warn">
              Only the first {SERIES_ROW_LIMIT} days of that period are drawn. Choose a shorter one to
              see the rest.
            </HelpText>
          ) : null}
        </FormSection>
      </div>

      <FormSection
        title="Their sign-ins"
        description="Successful and refused, newest first. The network address is shown here because it is the question this tab exists to answer."
      >
        {activity.signIns.items.length === 0 ? (
          <p className="text-sm text-ink-500">
            No sign-in, sign-out or refused attempt is recorded for them in this period.
          </p>
        ) : (
          <ol className="space-y-2.5">
            {activity.signIns.items.map((event) => (
              <li key={event.id} className="flex flex-wrap items-start gap-x-2.5 gap-y-1.5">
                <ActionChip action={event.action} />
                <p className="min-w-0 flex-1 text-sm leading-relaxed text-ink-700">
                  <time dateTime={event.at}>{formatWhen(event.at)}</time>
                  {event.ipAddress ? ` from ${event.ipAddress}` : ""}
                  {event.provider ? ` using ${humanise(event.provider)}` : ""}
                  {event.reason ? ` — ${event.reason}` : ""}.
                </p>
              </li>
            ))}
          </ol>
        )}
        <CapNote list={activity.signIns} one="sign-in event" many="sign-in events" />
      </FormSection>

      <FormSection
        title="Addresses they worked from"
        description="Every network address recorded against them in this period, most-used first. An address nobody recognises is worth asking about."
      >
        {activity.addresses.items.length === 0 ? (
          <p className="text-sm text-ink-500">
            No network address is recorded against them in this period.
          </p>
        ) : (
          <ul className="space-y-2">
            {activity.addresses.items.map((entry) => (
              <li key={entry.address} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-900">
                  <Fingerprint aria-hidden="true" className="h-3.5 w-3.5 text-ink-500" />
                  {entry.address}
                </span>
                <span className="text-xs tabular-nums text-ink-500">
                  {plural(entry.count, "action", "actions")}, first{" "}
                  <time dateTime={entry.firstSeen}>{formatWhen(entry.firstSeen)}</time>, last{" "}
                  <time dateTime={entry.lastSeen}>{formatWhen(entry.lastSeen)}</time>
                </span>
              </li>
            ))}
          </ul>
        )}
        <CapNote list={activity.addresses} one="address" many="addresses" />
      </FormSection>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The console
// ─────────────────────────────────────────────────────────────────────────────────────────────────

type TabId = "installation" | "record" | "person";

export function ProvenanceConsole() {
  const [tab, setTab] = useState<TabId>("installation");

  return (
    <Tabs
      label="Provenance views"
      value={tab}
      onChange={(next) => setTab(next as TabId)}
      items={[
        {
          id: "installation",
          label: "This studio",
          icon: Building2,
          content: <InstallationTab />
        },
        {
          id: "record",
          label: "One record",
          icon: History,
          content: <RecordTab />
        },
        {
          id: "person",
          label: "One person",
          icon: Users,
          content: <PersonTab />
        }
      ]}
    />
  );
}
