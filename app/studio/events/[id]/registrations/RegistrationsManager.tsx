"use client";

/**
 * RegistrationsManager — who has registered for one event, and the four things an organiser does about it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * CAPACITY IS A SENTENCE, NEVER A BARE NUMBER.
 *
 * "34" tells an organiser nothing. "34 of 60 places taken, 4 on the waiting list" tells them whether to
 * open more places, write to the waiting list, or do nothing — and it is the difference between a screen
 * that reports and a screen that helps. Where there is no limit the sentence says THAT, because an empty
 * capacity is a decision somebody took and not a value nobody filled in.
 *
 * A PLACE IS HELD BY A CONFIRMED OR ATTENDED REGISTRATION, AND BY NOTHING ELSE. Pending has not claimed
 * one, cancelled has given one back, and waitlisted is by definition waiting for one. Counting all five as
 * "registrations" would tell an organiser a half-full room was full.
 *
 * CONFIRMING PAST THE LIMIT IS ALLOWED, AND IT IS ASKED ABOUT FIRST. Rooms have real doors and organisers
 * have real judgement; refusing outright would send them to the database. So the question states how many
 * places there are, how many would be taken, and by how much the limit would be passed.
 *
 * A CERTIFICATE IS ONLY EVER ISSUED FOR SOMEBODY WHO ATTENDED. `EventRegistration.certificateCode` is the
 * public handle in a verification address, so issuing one to a person who did not turn up is a document the
 * institution has to stand behind. The action is therefore absent — not disabled — on every other row.
 *
 * THE EXPORT IS BUILT IN THE BROWSER, FROM THE ROWS ON SCREEN, AND SAYS SO. It needs no endpoint, so it
 * cannot half-work; and because it can only contain what was loaded, the note beside it repeats the cap.
 * A spreadsheet that quietly stopped at a thousand rows is the same bug class as a list that quietly stops
 * (contract §1.6).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Award,
  CircleCheck,
  CircleSlash,
  Clock,
  Copy,
  Download,
  Hourglass,
  UserCheck,
  UsersRound,
  type LucideIcon
} from "lucide-react";
import type { RegistrationStatus } from "@prisma/client";

import { asApiClientError, patch, post } from "@/lib/client/fetcher";
import { cn } from "@/lib/utils";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/ToastProvider";
import { DataTable, type DataTableBulkAction, type DataTableColumn } from "@/components/studio/DataTable";
import { FilterToolbar } from "@/components/studio/FilterToolbar";
import { HelpText } from "@/components/studio/HelpText";
import { RowActions, type RowAction } from "@/components/studio/RowActions";

// ─────────────────────────────────────────────────────────────────────────────
// The vocabulary, in one place
// ─────────────────────────────────────────────────────────────────────────────

const STATE_LABELS: Record<RegistrationStatus, string> = {
  PENDING: "Pending",
  CONFIRMED: "Confirmed",
  WAITLISTED: "Waitlisted",
  CANCELLED: "Cancelled",
  ATTENDED: "Attended"
};

/** One plain line per state, so a change is never a guess. */
const STATE_MEANINGS: Record<RegistrationStatus, string> = {
  PENDING: "They have registered and nobody has looked at it yet. No place is held.",
  CONFIRMED: "They hold a place and have been told so.",
  WAITLISTED: "Waiting for a place to come free. No place is held.",
  CANCELLED: "They are not coming. Their place is free again.",
  ATTENDED: "They came. Only an attended registration can be given a certificate."
};

/** Colour never carries the meaning alone (contract §11), so every state has a word and a glyph too. */
const STATE_TONES: Record<RegistrationStatus, BadgeTone> = {
  PENDING: "warn",
  CONFIRMED: "success",
  WAITLISTED: "info",
  CANCELLED: "neutral",
  ATTENDED: "brand"
};

const STATE_ICONS: Record<RegistrationStatus, LucideIcon> = {
  PENDING: Hourglass,
  CONFIRMED: CircleCheck,
  WAITLISTED: Clock,
  CANCELLED: CircleSlash,
  ATTENDED: UserCheck
};

/** The states that hold a place. See the header. */
const HOLDING_STATES: readonly RegistrationStatus[] = ["CONFIRMED", "ATTENDED"];

const ALL_STATES: readonly RegistrationStatus[] = [
  "PENDING",
  "CONFIRMED",
  "WAITLISTED",
  "CANCELLED",
  "ATTENDED"
];

/**
 * The UTF-8 byte-order mark, built from its code point rather than typed.
 *
 * Without it Excel opens a CSV as the system code page and reads any name containing a non-ASCII letter as
 * mojibake — and an attendee list is exactly where those live. Written as a literal it would be an
 * invisible character at the start of a template string that nobody could see in review, and that a stray
 * "tidy the whitespace" edit would silently remove.
 */
const UTF8_BOM = String.fromCharCode(0xfeff);

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface RegistrationRow {
  id: string;
  name: string;
  email: string;
  organisation: string | null;
  phone: string | null;
  notes: string | null;
  state: RegistrationStatus;
  certificateCode: string | null;
  /** Pre-formatted in the Centre's zone, or null when no certificate has been issued. */
  certificateIssuedLabel: string | null;
  /** Pre-formatted in the Centre's zone — the same clock as everything else about this event. */
  registeredLabel: string;
  /** The raw instant, for the export. A spreadsheet wants something sortable, not a sentence. */
  registeredIso: string;
}

export interface RegistrationsManagerProps {
  eventId: string;
  eventTitle: string;
  /** Filtered, sorted and capped by the server. */
  rows: readonly RegistrationRow[];
  /** Everybody registered for this event, whatever the filters say. */
  totalRegistrations: number;
  /**
   * How many the FILTERS matched — which is not the same number.
   *
   * The table's "select all" bar uses this to be honest about what a selection covers, and the cap notice
   * uses it to say how many rows were left off. Handing it the whole-event total would tell a reader
   * filtered to "waitlisted" that their twelve selected rows were twelve of four hundred.
   */
  matchingCount: number;
  /** True when the server stopped loading rows. Stated on screen and in the export note. */
  capped: boolean;
  cap: number;
  /** Counts across the WHOLE event, independent of the filters, so capacity is always a real number. */
  counts: Record<RegistrationStatus, number>;
  capacity: number | null;
  filtersActive: boolean;
  timeZoneLabel: string;
}

/** "1 person" / "14 people". Written out because an English plural is not a suffix rule worth guessing. */
function people(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}

/**
 * One CSV cell.
 *
 * Everything is quoted, not just the values that need it: a name with a comma, a note with a newline and an
 * organisation with a quotation mark in it are all ordinary, and a rule that only quotes "when necessary"
 * is a rule with an exception nobody remembers. Doubling an internal quote is the escape the format
 * specifies.
 */
function csvCell(value: string | null): string {
  return `"${(value ?? "").replace(/"/g, '""')}"`;
}

export function RegistrationsManager({
  eventId,
  eventTitle,
  rows,
  totalRegistrations,
  matchingCount,
  capped,
  cap,
  counts,
  capacity,
  filtersActive,
  timeZoneLabel
}: RegistrationsManagerProps) {
  const router = useRouter();
  const confirm = useConfirm();
  const { toast } = useToast();

  const [busyId, setBusyId] = useState<string | null>(null);

  const placesTaken = HOLDING_STATES.reduce((sum, state) => sum + (counts[state] ?? 0), 0);
  const waiting = counts.WAITLISTED ?? 0;

  /** The one sentence this screen exists to say. See the header. */
  const capacitySentence =
    capacity === null
      ? `${people(placesTaken)} ${placesTaken === 1 ? "holds" : "hold"} a place, and no limit has been set for this event.${
          waiting > 0 ? ` ${people(waiting)} on the waiting list.` : ""
        }`
      : `${placesTaken} of ${capacity} ${capacity === 1 ? "place" : "places"} taken, ${waiting} on the waiting list.`;

  const overCapacity = capacity !== null && placesTaken > capacity;
  const remaining = capacity === null ? null : capacity - placesTaken;

  // ── Changing state ───────────────────────────────────────────────────────

  const setState = useCallback(
    async (row: RegistrationRow, next: RegistrationStatus) => {
      setBusyId(row.id);
      try {
        await patch<unknown>(
          `/api/studio/events/${encodeURIComponent(eventId)}/registrations/${encodeURIComponent(row.id)}`,
          { state: next }
        );
        toast({
          tone: "success",
          title: `${row.name} is now ${STATE_LABELS[next].toLowerCase()}`,
          description: STATE_MEANINGS[next]
        });
        router.refresh();
      } catch (thrown) {
        toast({
          tone: "error",
          title: "Nothing has changed",
          description: asApiClientError(thrown).message
        });
      } finally {
        setBusyId(null);
      }
    },
    [eventId, router, toast]
  );

  /**
   * A bulk change, as ONE request carrying every id.
   *
   * Not N requests: the server writes each row, its revision and its audit entry through
   * `mutateWithHistory()`, and forty of those competing for the same event is forty transactions for one
   * intention — with no way to report "twelve worked and twenty-eight did not" honestly afterwards.
   */
  const runBulk = useCallback(
    async (targets: readonly RegistrationRow[], next: RegistrationStatus): Promise<void> => {
      if (targets.length === 0) return;

      // Confirming past the limit is allowed and asked about first — see the header.
      if (HOLDING_STATES.includes(next) && capacity !== null) {
        const gaining = targets.filter((row) => !HOLDING_STATES.includes(row.state)).length;
        const after = placesTaken + gaining;
        if (after > capacity) {
          const agreed = await confirm({
            title: `Confirm ${people(targets.length)} past the limit?`,
            body: (
              <p>
                There {capacity === 1 ? "is" : "are"} {capacity} {capacity === 1 ? "place" : "places"} and{" "}
                {placesTaken} {placesTaken === 1 ? "is" : "are"} already taken. Confirming these would make
                it {after} — {after - capacity} over. Nobody is stopped from attending by this number; it
                only decides who the site puts on the waiting list.
              </p>
            ),
            confirmLabel: `Confirm ${people(targets.length)} anyway`,
            cancelLabel: "Leave them as they are"
          });
          if (!agreed) return;
        }
      }

      // Throwing keeps the selection so the reader can try again (DataTable's contract); reporting is ours.
      try {
        await post<unknown>(
          `/api/studio/events/${encodeURIComponent(eventId)}/registrations/bulk`,
          { ids: targets.map((row) => row.id), state: next }
        );
        toast({
          tone: "success",
          title: `${people(targets.length)} marked ${STATE_LABELS[next].toLowerCase()}`,
          description: STATE_MEANINGS[next]
        });
        router.refresh();
      } catch (thrown) {
        toast({
          tone: "error",
          title: "Nothing has changed",
          description: asApiClientError(thrown).message
        });
        throw thrown;
      }
    },
    [capacity, confirm, eventId, placesTaken, router, toast]
  );

  // ── Certificates ─────────────────────────────────────────────────────────

  const issueCertificate = useCallback(
    async (row: RegistrationRow) => {
      const agreed = await confirm({
        title: `Issue a certificate to ${row.name}?`,
        body: (
          <>
            <p>
              A certificate for “{eventTitle}” is issued to {row.name} ({row.email}) and given its own
              code, which anybody can use to check that it is genuine.
            </p>
            <p className="mt-2">
              Issue one only for somebody who actually attended — the code makes this a document the Centre
              stands behind.
            </p>
          </>
        ),
        confirmLabel: "Issue the certificate",
        cancelLabel: "Not yet"
      });
      if (!agreed) return;

      setBusyId(row.id);
      try {
        await post<unknown>(
          `/api/studio/events/${encodeURIComponent(eventId)}/registrations/${encodeURIComponent(row.id)}/certificate`
        );
        toast({
          tone: "success",
          title: `A certificate has been issued to ${row.name}`,
          description: "Its code is now on their row, ready to be sent to them."
        });
        router.refresh();
      } catch (thrown) {
        toast({
          tone: "error",
          title: "No certificate has been issued",
          description: asApiClientError(thrown).message
        });
      } finally {
        setBusyId(null);
      }
    },
    [confirm, eventId, eventTitle, router, toast]
  );

  const copyCode = useCallback(
    async (row: RegistrationRow) => {
      if (row.certificateCode === null) return;
      try {
        await navigator.clipboard.writeText(row.certificateCode);
        toast({ tone: "success", title: "The certificate code has been copied" });
      } catch {
        // A clipboard write can be refused outright — an insecure origin, a browser policy. The code is on
        // the row either way, so saying so beats a silent failure.
        toast({
          tone: "error",
          title: "The code could not be copied",
          description: `Your browser would not let this page use the clipboard. The code is ${row.certificateCode} — select it on the row and copy it by hand.`
        });
      }
    },
    [toast]
  );

  // ── The export ───────────────────────────────────────────────────────────

  const exportCsv = useCallback(() => {
    const header = [
      "Name",
      "Email",
      "Organisation",
      "Telephone",
      "State",
      "Registered at (UTC)",
      "Certificate code",
      "Notes"
    ];

    const lines = [
      header.map((title) => csvCell(title)).join(","),
      ...rows.map((row) =>
        [
          csvCell(row.name),
          csvCell(row.email),
          csvCell(row.organisation),
          csvCell(row.phone),
          csvCell(STATE_LABELS[row.state]),
          // The raw instant rather than the formatted sentence: a spreadsheet sorts and filters on this
          // column, and "6 August 2026, 16:00" sorts alphabetically.
          csvCell(row.registeredIso),
          csvCell(row.certificateCode),
          csvCell(row.notes)
        ].join(",")
      )
    ];

    // CRLF, because that is what the CSV format specifies and what Excel expects; and the byte-order mark
    // in front of it, for the reason set out on `UTF8_BOM`.
    const blob = new Blob([`${UTF8_BOM}${lines.join("\r\n")}\r\n`], {
      type: "text/csv;charset=utf-8"
    });

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `registrations-${eventId}.csv`;
    anchor.click();
    // Revoked immediately: the download has already been handed to the browser, and an object URL that is
    // never revoked keeps the whole file in memory for the life of the tab.
    URL.revokeObjectURL(url);

    toast({
      tone: "success",
      title: `${rows.length === 1 ? "1 registration" : `${rows.length} registrations`} exported`,
      description: capped
        ? `Only the ${cap} rows loaded on this screen are in the file. Narrow the filters and export again for the rest.`
        : "Every row on this screen is in the file."
    });
  }, [cap, capped, eventId, rows, toast]);

  // ── The table ────────────────────────────────────────────────────────────

  const columns: readonly DataTableColumn<RegistrationRow>[] = [
    {
      key: "name",
      header: "Who",
      sortable: true,
      render: (row) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium text-ink-900">{row.name}</span>
          {/* A real mailto: the most common next action on this screen is writing to somebody. */}
          <a
            href={`mailto:${row.email}`}
            className="block truncate text-xs text-purple-700 underline-offset-4 hover:underline"
          >
            {row.email}
          </a>
        </span>
      )
    },
    {
      key: "organisation",
      header: "Organisation",
      hideBelow: "md",
      render: (row) => (
        <span className="block min-w-0 truncate text-ink-700">
          {row.organisation ?? <span className="text-xs text-ink-500">Not given</span>}
        </span>
      )
    },
    {
      key: "state",
      header: "State",
      sortable: true,
      resizable: false,
      render: (row) => {
        const Icon = STATE_ICONS[row.state];
        return (
          <Badge tone={STATE_TONES[row.state]} size="sm" icon={Icon}>
            {STATE_LABELS[row.state]}
          </Badge>
        );
      }
    },
    {
      key: "certificate",
      header: "Certificate",
      hideBelow: "lg",
      render: (row) =>
        row.certificateCode === null ? (
          <span className="text-xs text-ink-500">
            {row.state === "ATTENDED" ? "Not issued yet" : "—"}
          </span>
        ) : (
          <span className="block min-w-0">
            <span className="block break-all font-mono text-[0.6875rem] text-ink-900">
              {row.certificateCode}
            </span>
            {row.certificateIssuedLabel ? (
              <span className="mt-0.5 block text-[0.6875rem] text-ink-500">
                Issued {row.certificateIssuedLabel}
              </span>
            ) : null}
          </span>
        )
    },
    {
      key: "registered",
      header: "Registered",
      sortable: true,
      defaultDirection: "desc",
      hideBelow: "sm",
      render: (row) => <span className="text-xs text-ink-700">{row.registeredLabel}</span>
    }
  ];

  const bulkActions: readonly DataTableBulkAction<RegistrationRow>[] = [
    {
      id: "confirm",
      label: "Confirm these",
      icon: CircleCheck,
      onRun: (targets) => runBulk(targets, "CONFIRMED")
    },
    {
      id: "attended",
      label: "Mark as attended",
      icon: UserCheck,
      onRun: (targets) => runBulk(targets, "ATTENDED")
    },
    {
      id: "waitlist",
      label: "Move to the waiting list",
      icon: Clock,
      onRun: (targets) => runBulk(targets, "WAITLISTED")
    },
    {
      id: "cancel",
      label: "Cancel these",
      icon: CircleSlash,
      tone: "danger",
      onRun: (targets) => runBulk(targets, "CANCELLED")
    }
  ];

  const rowActions = (row: RegistrationRow): React.ReactNode => {
    const stateActions: RowAction[] = ALL_STATES.filter((state) => state !== row.state).map((state) => ({
      id: `state-${state}`,
      label: `Mark as ${STATE_LABELS[state].toLowerCase()}`,
      icon: STATE_ICONS[state],
      description: STATE_MEANINGS[state],
      tone: state === "CANCELLED" ? "danger" : "default",
      disabled: busyId === row.id,
      onSelect: () => void setState(row, state)
    }));

    const certificateActions: RowAction[] = [
      {
        id: "issue-certificate",
        label: "Issue a certificate",
        icon: Award,
        // Absent, not disabled, on every row that has not attended — see the header. This is a permission
        // in the §1.8 sense: nobody may issue a certificate to somebody who did not come.
        show: row.state === "ATTENDED" && row.certificateCode === null,
        disabled: busyId === row.id,
        onSelect: () => void issueCertificate(row)
      },
      {
        id: "copy-code",
        label: "Copy the certificate code",
        icon: Copy,
        show: row.certificateCode !== null,
        onSelect: () => void copyCode(row)
      }
    ];

    return <RowActions subject={row.name} actions={[...certificateActions, ...stateActions]} />;
  };

  const stateCountLine = useMemo(
    () =>
      ALL_STATES.filter((state) => (counts[state] ?? 0) > 0)
        .map((state) => `${counts[state]} ${STATE_LABELS[state].toLowerCase()}`)
        .join(" · "),
    [counts]
  );

  return (
    <div className="space-y-5">
      {/* ── Capacity, in words ───────────────────────────────────────────── */}
      <div
        className={cn(
          "flex flex-wrap items-start justify-between gap-x-6 gap-y-3 rounded-lg px-4 py-3.5",
          // Width and colour together in each branch: a lone `border` is preflight's literal gray-200,
          // which does not invert (contract §3).
          overCapacity ? "border border-amber-800/25 bg-amber-100" : "border border-line-200 bg-card"
        )}
      >
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "flex items-start gap-2 text-sm font-medium leading-relaxed",
              overCapacity ? "text-amber-800" : "text-ink-900"
            )}
          >
            <UsersRound aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{capacitySentence}</span>
          </p>

          {stateCountLine.length > 0 ? (
            <p className="mt-1 text-xs text-ink-500">
              {stateCountLine} — {people(totalRegistrations)} altogether.
            </p>
          ) : null}

          {overCapacity ? (
            <p className="mt-1 text-xs leading-relaxed text-amber-800">
              More places are taken than there are places. That can be perfectly deliberate; it only means
              the site will put anybody new on the waiting list.
            </p>
          ) : remaining !== null && remaining > 0 && waiting > 0 ? (
            <p className="mt-1 text-xs leading-relaxed text-ink-500">
              {remaining === 1 ? "1 place is" : `${remaining} places are`} free and{" "}
              {people(waiting)} {waiting === 1 ? "is" : "are"} waiting. Confirming them is the way to fill
              the room.
            </p>
          ) : null}
        </div>

        <Button
          variant="secondary"
          size="sm"
          icon={Download}
          // "Not available right now", with the reason beside it: there is nothing to put in a file.
          disabled={rows.length === 0}
          onClick={exportCsv}
        >
          Export as a spreadsheet
        </Button>
      </div>

      <FilterToolbar
        search={{ label: "Search registrations by name or email", placeholder: "Name, email or organisation" }}
        selects={[
          {
            key: "state",
            label: "State",
            options: ALL_STATES.map((state) => ({ value: state, label: STATE_LABELS[state] })),
            placeholder: "Any state"
          }
        ]}
      />

      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.name}
        rowActions={rowActions}
        selectable
        bulkActions={bulkActions}
        totalItems={matchingCount}
        label={`Registrations for ${eventTitle}`}
        sort={{ defaultKey: "registered", defaultDirection: "desc" }}
        maxHeight="70vh"
        capNote={
          capped
            ? `Only the first ${cap} of ${matchingCount} matching registrations are shown. Narrow the filters above to reach the rest — and note that the export contains only what is on screen.`
            : null
        }
        empty={
          filtersActive ? (
            <EmptyState
              icon={UsersRound}
              title="No registrations match these filters"
              description="Clear the search box or choose “Any state” above to see everybody again."
              headingLevel={2}
            />
          ) : (
            <EmptyState
              icon={UsersRound}
              title="Nobody has registered yet"
              description="Registrations made through the event's page on the site appear here, and you can confirm them, move people to the waiting list and issue certificates afterwards."
              headingLevel={2}
            />
          )
        }
      />

      <HelpText>
        Every date on this screen is shown in {timeZoneLabel} — the Centre&rsquo;s own time. The spreadsheet
        uses UTC instead, so it sorts correctly in any application.
      </HelpText>
    </div>
  );
}
