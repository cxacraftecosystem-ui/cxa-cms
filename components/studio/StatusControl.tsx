"use client";

/**
 * StatusControl — whether a record is public, and when.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE CURRENT-STATE SENTENCE IS `describeStatus()`, PRINTED VERBATIM.
 *
 * It is not paraphrased here and must not be. `lib/content.ts` is the single place the whole truth
 * about a row's publication state is worded, including the part the `status` column does not carry: a
 * PUBLISHED row whose `unpublishAt` has passed reads "Retired on 4 June — no longer public", and a
 * SCHEDULED row with no date reads "Scheduled, but no date has been set — it will not publish". A
 * second wording living in a component is how the studio's status column starts disagreeing with what
 * the public site actually shows.
 *
 * PUBLICATION STATE IS RESOLVED AT READ TIME (contract §9). The cron that flips SCHEDULED → PUBLISHED
 * is a convenience so this screen matches reality; the filters are the mechanism. That is why a
 * SCHEDULED row with a date in the past is *already live* and the sentence says so.
 *
 * A READER WHO CANNOT PUBLISH IS NOT SHOWN A PUBLISH OPTION THEY CANNOT USE.
 *
 * A failing permission check renders NOTHING, never a disabled control (contract §1.8). So:
 *   • without `canPublish`, only Draft and In review are offered, with one sentence saying who can
 *     take it further;
 *   • and if the record is ALREADY public, no control is rendered at all — moving a live page to Draft
 *     is unpublishing it, which is the very thing the permission governs.
 *
 * `canPublish` DEFAULTS TO FALSE, which is the safe direction: a screen that forgets to pass it
 * refuses an action (recoverable) rather than offering one the route handler will reject. Pass
 * `canPublish(user)` from `lib/permissions.ts` — the SAME predicate the route handler checks, because
 * a client guard that only hides a control is not a guard (contract §1.7).
 *
 * PUBLISHING SOMETHING WITH A VALIDATION PROBLEM IS REFUSED, WITH THE REASON.
 *
 * `publishBlockers` are the reasons — "There is no summary", "The cover image has no description".
 * Choosing Published or Scheduled while any exist does not change the value; the reasons appear in an
 * alert instead. The alert is keyed on an attempt counter so a second try re-announces it: a screen
 * reader will not read a region whose contents have not changed, and a reader who pressed the same
 * option twice and heard nothing the second time has been told the control is broken.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE DATE PICKERS APPEAR ONLY FOR SCHEDULED, and only when the model can store them. `Page` and
 * `Post` carry `publishAt`/`unpublishAt`; `Person`, `Project`, `Publication`, `Craft` and the rest
 * carry only `status` and `publishedAt`. Offering a schedule for one of those would write a date into
 * nothing and leave a record that never publishes — hence `scheduling`, which must match the model.
 * (To retire an already-published item on a date, set it to Scheduled with a publish date in the past
 * and a retirement date ahead: `isLive()` treats that as live, and the sentence reads "Live since …".)
 *
 * `datetime-local` MEANS THIS COMPUTER'S TIME ZONE, AND THAT IS SAID ON SCREEN. The site renders event
 * and publication times in the Centre's zone, which is a SETTING and not the viewer's locale (schema,
 * `CoeEvent`). An administrator scheduling from a different zone must be told which one the box is
 * speaking, or "publish at 9am" means two different instants to the two people who set it and read it.
 */

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { ContentStatus } from "@prisma/client";
import { CalendarClock, TriangleAlert } from "lucide-react";

import { STATUS_LABELS, describeStatus } from "@/lib/content";
import { cn } from "@/lib/utils";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select, type SelectOption } from "@/components/ui/Select";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { HelpText } from "@/components/studio/HelpText";

/**
 * The publication fields as an editor holds them: ISO instants, because that is what crosses the wire
 * and what Prisma stores. The pickers convert to and from the browser's local time; nothing else in
 * this component touches a time zone.
 */
export interface StatusControlValue {
  status: ContentStatus;
  /** When it first went public. Read-only here — the server stamps it. */
  publishedAt?: string | null;
  publishAt?: string | null;
  unpublishAt?: string | null;
}

export interface StatusControlProps {
  value: StatusControlValue;
  onChange: (next: StatusControlValue) => void;
  /** See the header. Pass `canPublish(user)` from lib/permissions.ts. */
  canPublish?: boolean;
  /** False for a model with no `publishAt`/`unpublishAt` columns. See the header. */
  scheduling?: boolean;
  /**
   * Why this cannot go public yet, as complete sentences. Non-empty refuses Published and Scheduled
   * and prints the reasons. Empty or absent means there is nothing in the way.
   */
  publishBlockers?: readonly string[];
  className?: string;
}

/** The statuses a reader without publishing rights may choose between. */
const DRAFTING_STATUSES: readonly ContentStatus[] = ["DRAFT", "IN_REVIEW"];

/** The statuses that put something in front of the public, or deliberately take it away again. */
const PUBLISHING_STATUSES: readonly ContentStatus[] = ["SCHEDULED", "PUBLISHED", "ARCHIVED"];

/** One plain line per choice, so a picker is never a guess. */
const STATUS_MEANINGS: Record<ContentStatus, string> = {
  DRAFT: "Only visible in the studio. Nobody outside can reach it.",
  IN_REVIEW: "Finished, and waiting for an editor to look at it.",
  SCHEDULED: "Goes public on its own, at the date and time below.",
  PUBLISHED: "Live on the public site now.",
  ARCHIVED: "Kept in the studio, taken off the public site."
};

function isPublishingStatus(status: ContentStatus): boolean {
  return PUBLISHING_STATUSES.includes(status);
}

/**
 * An ISO instant as a `datetime-local` box wants it: `YYYY-MM-DDTHH:mm`, in local time, with no zone.
 *
 * Built by hand from the local getters rather than by slicing `toISOString()`, which returns UTC — a
 * slice of it puts a 9am publication in Jaipur into the box as 03:30 and the reader "corrects" it.
 */
function toLocalInputValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The reverse. `new Date("2026-07-30T09:00")` is parsed as LOCAL time by the specification, which is
 * exactly what we want here — and note it differs from `new Date("2026-07-30")`, which is parsed as
 * UTC. The two spellings look alike and mean different instants.
 */
function fromLocalInputValue(input: string): string | null {
  if (input.trim().length === 0) return null;
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The two things that can be wrong with a schedule, each as one sentence or null.
 *
 * They are separate functions, and `statusProblems` is built FROM them, so the message attached to a
 * date field and the message in the screen's save check are literally the same string. The alternative
 * — matching a sentence out of an array by its opening words — breaks silently the day somebody
 * rewords it.
 */
function missingPublishDateProblem(value: StatusControlValue): string | null {
  if (value.status !== "SCHEDULED") return null;
  return parseDate(value.publishAt) === null
    ? "A scheduled item needs a date and time to go public, or it never will."
    : null;
}

function retirementOrderProblem(value: StatusControlValue): string | null {
  if (value.status !== "SCHEDULED") return null;
  const publishAt = parseDate(value.publishAt);
  const unpublishAt = parseDate(value.unpublishAt);
  if (!publishAt || !unpublishAt) return null;
  return unpublishAt.getTime() <= publishAt.getTime()
    ? "The date it comes off the site must be after the date it goes on."
    : null;
}

/**
 * The problems with a publication state, as sentences ready to render.
 *
 * Exported so a screen can refuse a save for the same reasons this control refuses a status, without a
 * second copy of the rules. Empty means the state is coherent.
 */
export function statusProblems(value: StatusControlValue, scheduling = true): string[] {
  if (value.status !== "SCHEDULED") return [];

  if (!scheduling) {
    return ["This kind of record cannot be scheduled. Choose Draft or Published instead."];
  }

  return [missingPublishDateProblem(value), retirementOrderProblem(value)].filter(
    (problem): problem is string => problem !== null
  );
}

export function StatusControl({
  value,
  onChange,
  canPublish = false,
  scheduling = true,
  publishBlockers,
  className
}: StatusControlProps) {
  const uid = useId();
  const refusalId = `${uid}refusal`;

  /**
   * Counts refused attempts. Used as the alert's `key`, so React remounts the region and the refusal
   * is announced again on a second try — see the header.
   */
  const [refusedAt, setRefusedAt] = useState(0);
  const [refusedStatus, setRefusedStatus] = useState<ContentStatus | null>(null);

  /**
   * `describeStatus()` formats dates with `toLocaleDateString`, which depends on the reader's time
   * zone — and the server rendering this HTML does not know it. Printing the sentence during SSR
   * therefore produces a hydration mismatch that React resolves by keeping the SERVER's date, which
   * is the wrong one. So the first paint shows the status word alone and the sentence lands on mount.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const blockers = publishBlockers ?? [];
  const blocked = blockers.length > 0;

  const alreadyPublic = isPublishingStatus(value.status);

  /**
   * A record that is SCHEDULED on a model with nowhere to store the dates. It happens when data
   * predates the `scheduling` flag being set correctly, and the picker below is not rendered for it —
   * so without this the reader would see "Scheduled" with no dates, no explanation and no way to tell
   * that it is never going to publish.
   */
  const unstorableSchedule = useMemo(
    () => (value.status === "SCHEDULED" && !scheduling ? statusProblems(value, scheduling) : []),
    [value, scheduling]
  );

  const sentence = mounted
    ? describeStatus({
        status: value.status,
        publishedAt: parseDate(value.publishedAt),
        publishAt: parseDate(value.publishAt),
        unpublishAt: parseDate(value.unpublishAt),
        deletedAt: null
      })
    : (STATUS_LABELS[value.status] ?? value.status);

  const options = useMemo<SelectOption[]>(() => {
    const list: SelectOption[] = DRAFTING_STATUSES.map((status) => ({
      value: status,
      label: STATUS_LABELS[status] ?? status
    }));
    if (!canPublish) return list;

    for (const status of PUBLISHING_STATUSES) {
      // A model with only a `status` column has nowhere to put a schedule — see the header.
      if (status === "SCHEDULED" && !scheduling) continue;
      list.push({ value: status, label: STATUS_LABELS[status] ?? status });
    }
    return list;
  }, [canPublish, scheduling]);

  const handleStatusChange = useCallback(
    (next: string) => {
      const status = next as ContentStatus;

      if (blocked && isPublishingStatus(status) && status !== "ARCHIVED") {
        // Refused. The value is left exactly as it was, so the control keeps showing the truth.
        setRefusedStatus(status);
        setRefusedAt((count) => count + 1);
        return;
      }

      setRefusedStatus(null);
      // Moving away from Scheduled clears the schedule. A stored `publishAt` on a DRAFT is invisible
      // in the studio and would silently reappear the next time somebody chose Scheduled — a date
      // nobody set, on a piece nobody meant to publish that day.
      if (status !== "SCHEDULED") {
        onChange({ ...value, status, publishAt: null, unpublishAt: null });
        return;
      }
      onChange({ ...value, status });
    },
    [blocked, onChange, value]
  );

  /**
   * A reader without publishing rights looking at something that is already public gets NO control —
   * only the state and who can change it. See the header.
   */
  const readOnly = !canPublish && alreadyPublic;

  return (
    <div className={cn("min-w-0 space-y-4", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StatusBadge status={value.status} />
        {/* The whole truth, in one sentence, from lib/content.ts. */}
        <p className="min-w-0 flex-1 text-sm leading-relaxed text-ink-700">{sentence}</p>
      </div>

      {readOnly ? (
        <HelpText>
          This is public, and only an editor can change that. Ask an editor if it needs to come down or
          be republished.
        </HelpText>
      ) : (
        <>
          {/* `Field` (a real `<label>`) is correct here: the control is a NATIVE `<select>`, so there
              is no button inside to swallow the forwarded click (Field.tsx). */}
          <Field
            label="Publication"
            help={STATUS_MEANINGS[value.status]}
            error={blocked && isPublishingStatus(value.status) ? "This cannot stay public until the problems below are fixed." : null}
          >
            <Select
              value={value.status}
              options={options}
              onChange={(event) => handleStatusChange(event.target.value)}
            />
          </Field>

          {!canPublish ? (
            <HelpText>
              Only an editor can put something on the public site. Set it to “In review” and an editor
              will take it from there.
            </HelpText>
          ) : null}
        </>
      )}

      {/*
        The refusal. Keyed on the attempt count so a repeated attempt remounts the region and is
        announced again. `role="alert"` rather than `role="status"`: the reader has just tried to do
        something and been stopped, which is the one case that warrants interrupting them.
      */}
      {refusedStatus !== null ? (
        <div
          key={refusedAt}
          id={refusalId}
          role="alert"
          className="rounded-md border border-error-200 bg-error-100 px-3 py-2.5 text-xs leading-relaxed text-error-600"
        >
          <p className="flex items-start gap-1.5 font-semibold">
            <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Not set to {STATUS_LABELS[refusedStatus] ?? refusedStatus}. Fix this first:
            </span>
          </p>
          <ul className="ml-5 mt-1.5 list-disc space-y-1">
            {blockers.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* The standing list of what is in the way, whether or not anybody has tried yet. Hiding it
          until a refusal would make the refusal a surprise. */}
      {blocked && refusedStatus === null && !alreadyPublic ? (
        <div className="rounded-md border border-amber-800/25 bg-amber-100 px-3 py-2.5 text-xs leading-relaxed text-amber-800">
          <p className="flex items-start gap-1.5 font-semibold">
            <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>This cannot be published yet:</span>
          </p>
          <ul className="ml-5 mt-1.5 list-disc space-y-1">
            {blockers.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {unstorableSchedule.map((problem) => (
        <HelpText key={problem} tone="warn">
          {problem}
        </HelpText>
      ))}

      {/* Only for Scheduled, and only where the model can store the dates. */}
      {!readOnly && value.status === "SCHEDULED" && scheduling ? (
        <div className="space-y-4 rounded-md border border-line-200 bg-surface-50 px-4 py-4">
          <p className="flex items-center gap-1.5 text-xs font-medium text-ink-700">
            <CalendarClock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            When it goes public
          </p>

          <Field label="Goes public on" required error={missingPublishDateProblem(value)}>
            <Input
              type="datetime-local"
              value={toLocalInputValue(value.publishAt)}
              onChange={(event) =>
                onChange({ ...value, publishAt: fromLocalInputValue(event.target.value) })
              }
            />
          </Field>

          <Field
            label="Comes off the site on"
            help="Leave this empty to keep it up indefinitely."
            error={retirementOrderProblem(value)}
          >
            <Input
              type="datetime-local"
              value={toLocalInputValue(value.unpublishAt)}
              onChange={(event) =>
                onChange({ ...value, unpublishAt: fromLocalInputValue(event.target.value) })
              }
            />
          </Field>

          {/* Stated, not assumed — see the header. Deliberately does not name the zone: reading it from
              `Intl` gives a value the server does not have, and printing it during SSR is a hydration
              mismatch for the sake of four words. */}
          <HelpText>
            These times are in this computer’s time zone, which may not be the Centre’s. Check the time
            with whoever set the Centre’s time zone if it matters to the minute.
          </HelpText>
        </div>
      ) : null}
    </div>
  );
}
