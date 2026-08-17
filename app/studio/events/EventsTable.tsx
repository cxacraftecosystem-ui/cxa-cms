"use client";

/**
 * EventsTable — the interactive half of the events list.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE DATES ARE FORMATTED ON THE SERVER, IN THE CENTRE'S ZONE, AND ARRIVE AS STRINGS.
 *
 * `CoeEvent.startsAt` is an absolute instant and the Centre's zone is what it must be read in — not the
 * browser's. Formatting here would also mean the server and the browser rendering different text for the
 * same row, which React resolves by keeping whichever it likes. So the page next door does the formatting
 * once, with `describeEventDates`, which is the same function the public event pages use.
 *
 * NO REGISTRATION NUMBER IS EVER A BARE FIGURE. "34" beside an event tells an organiser nothing they can
 * act on; "34 of 60 taken · 4 waiting" tells them whether to open more places. Where there is no limit the
 * sentence says that too, because an empty capacity is a decision and not a missing value.
 *
 * "UPCOMING" MEANS NOT YET FINISHED, and the phase is computed on the server from one `now` so that every
 * date-dependent statement on the screen agrees. A three-day conference on its second morning is still
 * upcoming for anybody who might attend the rest of it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  CalendarDays,
  ClipboardList,
  ExternalLink,
  Pencil,
  SearchX,
  Star,
  Trash2
} from "lucide-react";
import type { ContentStatus, EventMode } from "@prisma/client";

import { asApiClientError, del } from "@/lib/client/fetcher";
import type { MediaLike } from "@/lib/media/url";
import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { EmptyState } from "@/components/ui/EmptyState";
import { MediaImage } from "@/components/ui/MediaImage";
import type { Picture } from "@/lib/media/screens";
import { Pagination } from "@/components/ui/Pagination";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/ToastProvider";
import { EVENT_MODES } from "@/components/site/EventDateBlock";
import {
  DATA_TABLE_PRIMARY_LINK_CLASS,
  DataTable,
  type DataTableColumn
} from "@/components/studio/DataTable";
import { FilterToolbar } from "@/components/studio/FilterToolbar";
import { RowActions, type RowAction } from "@/components/studio/RowActions";

export type EventPhaseName = "upcoming" | "running" | "finished";

export interface StudioEventRow {
  id: string;
  title: string;
  path: string;
  status: ContentStatus;
  isLive: boolean;
  isFeatured: boolean;
  mode: EventMode;
  /** "6–9 August 2026", already in the Centre's zone. */
  whenLabel: string;
  /** "16:00–18:00 IST", or null for a multi-day event whose sessions are on its programme. */
  timeLabel: string | null;
  phase: EventPhaseName;
  /** The venue, or "Online" — whichever the mode makes true. */
  place: string;
  cover: MediaLike | null;
  /**
   * The cover resolved for every screen width, or null when nobody framed it.
   *
   * Resolved on the SERVER and handed down, not derived here: resolving needs the alternate assets a
   * framing names, and only the fetching query can get them.
   */
  picture: Picture | null;
  /** Everybody who has registered, whatever state they are in. */
  registrationCount: number;
  /** Confirmed plus attended — the people actually holding a place. */
  placesTaken: number;
  waitlistCount: number;
  capacity: number | null;
  isRegistrationOpen: boolean;
  canDelete: boolean;
}

export interface EventsTableProps {
  rows: readonly StudioEventRow[];
  total: number;
  page: number;
  pageSize: number;
  siteOrigin: string;
  filtersActive: boolean;
  timeZoneLabel: string;
}

const PHASE_LABEL: Record<EventPhaseName, string> = {
  upcoming: "Still to come",
  running: "Under way now",
  finished: "Finished"
};

export function EventsTable({
  rows,
  total,
  page,
  pageSize,
  siteOrigin,
  filtersActive,
  timeZoneLabel
}: EventsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const confirm = useConfirm();
  const { toast } = useToast();

  const remove = useCallback(
    async (row: StudioEventRow) => {
      const agreed = await confirm({
        title: `Delete the event “${row.title}”?`,
        body: (
          <>
            <p>
              It moves to the recycle bin, where an administrator can restore it for 30 days.{" "}
              {row.isLive
                ? "It disappears from the public site straight away."
                : "It is not published, so nothing on the public site changes."}
            </p>
            {row.registrationCount > 0 ? (
              <p className="mt-2 font-medium text-ink-900">
                {row.registrationCount === 1
                  ? "1 person has registered for this event."
                  : `${row.registrationCount} people have registered for this event.`}{" "}
                Their registrations go with it, and nobody is told. If the event is cancelled rather than
                a mistake, write to them first.
              </p>
            ) : null}
          </>
        ),
        confirmLabel: "Move to recycle bin",
        cancelLabel: "Keep it",
        tone: "danger"
      });
      if (!agreed) return;

      try {
        await del<void>(`/api/studio/events/${encodeURIComponent(row.id)}`);
        toast({
          tone: "success",
          title: `“${row.title}” is in the recycle bin`,
          description: "An administrator can restore it for the next 30 days."
        });
        router.refresh();
      } catch (thrown) {
        toast({
          tone: "error",
          title: "It has not been deleted",
          description: asApiClientError(thrown).message
        });
      }
    },
    [confirm, router, toast]
  );

  const columns: readonly DataTableColumn<StudioEventRow>[] = [
    {
      key: "cover",
      header: "",
      headerLabel: "Cover picture",
      width: 76,
      resizable: false,
      render: (row) => (
        <MediaImage
          media={row.cover}
          picture={row.picture}
          alt=""
          aspect="16 / 10"
          rounded="sm"
          sizes="56px"
          targetWidth={320}
          className="w-14"
        />
      )
    },
    {
      key: "title",
      header: "Event",
      sortable: true,
      render: (row) => (
        <span className="block min-w-0">
          <Link href={`/studio/events/${encodeURIComponent(row.id)}`} className={DATA_TABLE_PRIMARY_LINK_CLASS}>
            {row.title}
          </Link>
          {row.isFeatured ? (
            <Badge tone="info" size="sm" icon={Star} className="ml-2 align-middle">
              Featured
            </Badge>
          ) : null}
          <span className="mt-0.5 block truncate text-xs text-ink-500">
            {row.whenLabel}
            {row.timeLabel ? ` · ${row.timeLabel}` : ""}
          </span>
        </span>
      )
    },
    {
      key: "starts",
      header: "Stage",
      sortable: true,
      defaultDirection: "desc",
      resizable: false,
      hideBelow: "md",
      render: (row) => (
        // A word, never a colour on its own (contract §11).
        <Badge tone={row.phase === "running" ? "success" : "neutral"} size="sm">
          {PHASE_LABEL[row.phase]}
        </Badge>
      )
    },
    {
      key: "mode",
      header: "Where",
      hideBelow: "lg",
      render: (row) => {
        const meta = EVENT_MODES[row.mode];
        return (
          <span className="block min-w-0">
            <Badge tone={meta.tone} size="sm" icon={meta.icon}>
              {meta.label}
            </Badge>
            <span className="mt-0.5 block truncate text-xs text-ink-500">{row.place}</span>
          </span>
        );
      }
    },
    {
      key: "status",
      header: "Publication",
      sortable: true,
      resizable: false,
      render: (row) => <StatusBadge status={row.status} size="sm" />
    },
    {
      key: "registrations",
      header: "Registrations",
      hideBelow: "sm",
      render: (row) => (
        <Link
          href={`/studio/events/${encodeURIComponent(row.id)}/registrations`}
          className="block min-w-0 rounded text-xs underline-offset-4 hover:underline"
        >
          {/* Never a bare number — see the header. */}
          <span className="block text-ink-700">
            {row.capacity === null
              ? row.registrationCount === 1
                ? "1 registered, no limit set"
                : `${row.registrationCount} registered, no limit set`
              : `${row.placesTaken} of ${row.capacity} ${row.capacity === 1 ? "place" : "places"} taken`}
          </span>
          <span className="mt-0.5 block text-ink-500">
            {row.waitlistCount > 0
              ? `${row.waitlistCount} on the waiting list`
              : row.isRegistrationOpen
                ? "Registration open"
                : "Registration closed"}
          </span>
        </Link>
      )
    }
  ];

  const rowActions = (row: StudioEventRow): React.ReactNode => {
    const actions: RowAction[] = [
      {
        id: "open",
        label: "Open this event",
        icon: Pencil,
        onSelect: () => router.push(`/studio/events/${encodeURIComponent(row.id)}`)
      },
      {
        id: "registrations",
        label: "Who has registered",
        icon: ClipboardList,
        onSelect: () => router.push(`/studio/events/${encodeURIComponent(row.id)}/registrations`)
      },
      {
        id: "view",
        label: "View it on the site",
        icon: ExternalLink,
        disabled: !row.isLive,
        description: row.isLive ? undefined : "It is not published, so there is nothing public to open.",
        onSelect: () => window.open(`${siteOrigin}${row.path}`, "_blank", "noreferrer")
      },
      {
        id: "delete",
        label: "Move to recycle bin",
        icon: Trash2,
        tone: "danger",
        show: row.canDelete,
        onSelect: () => void remove(row)
      }
    ];

    return <RowActions subject={row.title} actions={actions} />;
  };

  const query = params.toString();
  const baseHref = query.length > 0 ? `${pathname}?${query}` : pathname;

  return (
    <div className="space-y-4">
      <FilterToolbar
        search={{ label: "Search events by title or venue", placeholder: "Title, venue or address" }}
        status={{}}
        selects={[
          {
            key: "when",
            label: "Stage",
            options: [
              { value: "upcoming", label: "Still to come or under way" },
              { value: "past", label: "Finished" }
            ],
            placeholder: "Any stage"
          },
          {
            key: "mode",
            label: "How people attend",
            options: (Object.keys(EVENT_MODES) as EventMode[]).map((key) => ({
              value: key,
              label: EVENT_MODES[key].label
            }))
          }
        ]}
      />

      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.title}
        rowActions={rowActions}
        label="Events"
        sort={{ defaultKey: "starts", defaultDirection: "desc" }}
        totalItems={total}
        empty={
          filtersActive ? (
            <EmptyState
              icon={SearchX}
              title="No events match these filters"
              description="Clear the search box, or choose “Any stage” and “Any status” above, to see everything again."
              headingLevel={2}
            />
          ) : (
            <EmptyState
              icon={CalendarDays}
              title="There are no events yet"
              description="Seminars, workshops and conferences live here, with their programmes and the people who have registered. Add the first one and it will appear on the site's events page once it is published."
              headingLevel={2}
              action={
                <LinkButton href="/studio/events/new" icon={CalendarDays}>
                  New event
                </LinkButton>
              }
            />
          )
        }
      />

      {rows.length > 0 ? (
        <div className="flex flex-col gap-3">
          <Pagination
            page={page}
            pageSize={pageSize}
            totalItems={total}
            baseHref={baseHref}
            label="Events"
            itemNoun={{ singular: "event", plural: "events" }}
          />
          <p className="text-xs text-ink-500">
            Every date and time is shown in {timeZoneLabel} — the Centre&rsquo;s own time, not your
            computer&rsquo;s.
          </p>
        </div>
      ) : null}
    </div>
  );
}
