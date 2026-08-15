/**
 * EventDateBlock — when an event happens, and the shared vocabulary both event pages describe it with.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ONE ZONE FOR EVERY READER, AND IT IS NAMED ON SCREEN.
 *
 * `CoeEvent.startsAt` / `endsAt` are absolute UTC instants, and prisma/schema.prisma is explicit that
 * the site renders them in the CENTRE's zone rather than the viewer's: "the seminar is at 4pm" has to
 * mean one time for everyone, or two people comparing notes disagree about when to arrive and an
 * international audience misses it altogether. Rendering in the browser's locale is the failure this
 * whole module exists to prevent — so every time is formatted HERE, on the server, and every one of
 * them carries its zone name, so a reader in another country can convert rather than guess.
 *
 * ⚠ THERE IS NO TIMEZONE SETTING IN `lib/settings/schema.ts` YET, so the zone is the constant below.
 * It is the single place the decision is made: when a setting appears, `CENTRE_TIME_ZONE` becomes its
 * default and every formatter here follows. The zone's NAMES are derived from the constant through
 * `Intl` rather than written out beside it, so there is no second string to forget to change.
 *
 * (`components/sections/EventShowcaseSection.tsx` carries its own copy of these formatters for the
 * homepage block. The RULES are identical on purpose — one product, one way of writing a date range —
 * and this module is the one the /events pages read.)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * "UPCOMING" MEANS NOT YET FINISHED. A three-day conference on its second morning is still upcoming
 * for anybody who might attend the rest of it, so the boundary is `endsAt ?? startsAt`, never
 * `startsAt` alone. `eventIsUpcoming` and `eventPhase` are the only two places that rule is written.
 *
 * A Server Component. Nothing here is interactive, so nothing here ships JavaScript.
 */

import type { EventMode } from "@prisma/client";
import { CalendarDays, Clock, Globe, MapPin, Video, type LucideIcon } from "lucide-react";

import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { cn } from "@/lib/utils";

/** The Centre's zone. See the header — this is the single place it is decided. */
export const CENTRE_TIME_ZONE = "Asia/Kolkata";

const FMT_DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", timeZone: CENTRE_TIME_ZONE });
const FMT_MONTH = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: CENTRE_TIME_ZONE });
const FMT_YEAR = new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone: CENTRE_TIME_ZONE });
const FMT_LONG = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: CENTRE_TIME_ZONE
});
const FMT_LONG_NO_YEAR = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  timeZone: CENTRE_TIME_ZONE
});
const FMT_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: CENTRE_TIME_ZONE
});
const FMT_TIME = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: CENTRE_TIME_ZONE
});
const FMT_ZONE_SHORT = new Intl.DateTimeFormat("en-GB", {
  timeZone: CENTRE_TIME_ZONE,
  timeZoneName: "short"
});
const FMT_ZONE_LONG = new Intl.DateTimeFormat("en-GB", {
  timeZone: CENTRE_TIME_ZONE,
  timeZoneName: "long"
});

/** `en-CA` is the one common locale whose short date IS `YYYY-MM-DD`, so no parts have to be reassembled. */
const FMT_ISO_DATE = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: CENTRE_TIME_ZONE
});

/**
 * The calendar date in the Centre's zone, as a comparable `YYYY-MM-DD` string.
 *
 * This is what "is this event multi-day?" is decided on. Comparing the two instants directly would
 * call a 22:00–01:00 seminar a two-day event, and comparing them in UTC would do it for a different
 * set of events than the reader's own calendar agrees with.
 */
function calendarDay(date: Date): string {
  return FMT_ISO_DATE.format(date);
}

/**
 * The zone's name, pulled out of a formatted string because `Intl` offers no way to ask for the name
 * on its own. `short` is "GMT+5:30" or "IST" depending on the runtime's ICU data; `long` is
 * "India Standard Time". Both are derived from the constant, so neither can drift from it.
 */
export function centreZoneName(date: Date, style: "short" | "long" = "short"): string {
  const formatter = style === "long" ? FMT_ZONE_LONG : FMT_ZONE_SHORT;
  const part = formatter.formatToParts(date).find((piece) => piece.type === "timeZoneName");
  return part?.value ?? "";
}

/** The four-digit year in the Centre's zone — what the /events year filter is built from. */
export function centreYear(date: Date): string {
  return FMT_YEAR.format(date);
}

/** A date with no time of day, in the Centre's zone: "6 August 2026". */
export function formatCentreDate(date: Date): string {
  return FMT_DATE.format(date);
}

/** A 24-hour clock time in the Centre's zone, with no zone suffix of its own. */
export function formatCentreTime(date: Date): string {
  return FMT_TIME.format(date);
}

/** A time of day WITH its zone named — the only shape a standalone time may be rendered in. */
export function formatCentreTimeWithZone(date: Date): string {
  return `${FMT_TIME.format(date)} ${centreZoneName(date)}`;
}

export interface EventDates {
  /** True when the event spans more than one calendar day in the Centre's zone. */
  multiDay: boolean;
  /** The three lines of the calendar tile. */
  block: { top: string; middle: string; bottom: string };
  /** The whole range in words, for a line beside a title. */
  sentence: string;
  /**
   * The time of day, zone included — or null for a multi-day entry, where a single start time invites
   * a reader to arrive on the wrong day. Those events carry their sessions in the agenda instead.
   */
  time: string | null;
}

/**
 * Describe an event's dates so both shapes read correctly.
 *
 * A single-day event wants a day, a month and a time. A multi-day one wants a RANGE — showing only
 * its first day makes a four-day festival look like an afternoon, and "6 Aug" beside a title that
 * mentions the closing ceremony is the sort of small wrongness a reader notices immediately.
 */
export function describeEventDates(startsAt: Date, endsAt: Date | null | undefined): EventDates {
  // The null test is inside the condition rather than beside it, so `endsAt` narrows to `Date` for the
  // whole multi-day branch below — no cast, and no way for the two halves to disagree.
  if (!endsAt || calendarDay(endsAt) === calendarDay(startsAt)) {
    const zone = centreZoneName(startsAt);
    const from = FMT_TIME.format(startsAt);
    const to = endsAt ? FMT_TIME.format(endsAt) : null;
    return {
      multiDay: false,
      block: {
        top: FMT_DAY.format(startsAt),
        middle: FMT_MONTH.format(startsAt),
        bottom: FMT_YEAR.format(startsAt)
      },
      sentence: FMT_LONG.format(startsAt),
      time: to && to !== from ? `${from}–${to} ${zone}` : `${from} ${zone}`
    };
  }

  const end = endsAt;
  const sameMonth = FMT_MONTH.format(end) === FMT_MONTH.format(startsAt);
  const sameYear = FMT_YEAR.format(end) === FMT_YEAR.format(startsAt);

  return {
    multiDay: true,
    block: sameMonth && sameYear
      ? {
          top: `${FMT_DAY.format(startsAt)}–${FMT_DAY.format(end)}`,
          middle: FMT_MONTH.format(startsAt),
          bottom: FMT_YEAR.format(startsAt)
        }
      : {
          top: `${FMT_DAY.format(startsAt)} ${FMT_MONTH.format(startsAt)}`,
          middle: `– ${FMT_DAY.format(end)} ${FMT_MONTH.format(end)}`,
          bottom: sameYear
            ? FMT_YEAR.format(startsAt)
            : `${FMT_YEAR.format(startsAt)}–${FMT_YEAR.format(end)}`
        },
    // "6 August – 9 August 2026" collapses to "6 August – 9 August 2026" with one year, which is how a
    // person writes it.
    sentence: sameYear
      ? `${FMT_LONG_NO_YEAR.format(startsAt)} – ${FMT_LONG_NO_YEAR.format(end)} ${FMT_YEAR.format(end)}`
      : `${FMT_LONG.format(startsAt)} – ${FMT_LONG.format(end)}`,
    time: null
  };
}

export type EventPhase = "upcoming" | "running" | "finished";

/**
 * Where an event stands relative to `now`.
 *
 * ⚠ THE ANSWER IS ONLY AS FRESH AS THE RENDER. Event pages are prerendered and revalidated on a
 * timer, so `running` can survive a few minutes past the closing session. The dates themselves are
 * beside it on screen and they are never stale, which is why the phase is allowed to be a badge and
 * not the only thing telling a reader whether to set off.
 */
export function eventPhase(
  startsAt: Date,
  endsAt: Date | null | undefined,
  now: Date = new Date()
): EventPhase {
  const boundary = endsAt ?? startsAt;
  if (boundary.getTime() < now.getTime()) return "finished";
  if (startsAt.getTime() <= now.getTime()) return "running";
  return "upcoming";
}

/** Not yet finished. The one rule; see the header. */
export function eventIsUpcoming(
  startsAt: Date,
  endsAt: Date | null | undefined,
  now: Date = new Date()
): boolean {
  return eventPhase(startsAt, endsAt, now) !== "finished";
}

/**
 * How each `EventMode` is named, glyphed and toned.
 *
 * Shared by the listing and the event page so "Hybrid" cannot be a chip in one place and a sentence in
 * the other. The word is always rendered — colour and a glyph never carry the meaning alone
 * (contract §11).
 */
export const EVENT_MODES: Record<EventMode, { label: string; icon: LucideIcon; tone: BadgeTone }> = {
  IN_PERSON: { label: "In person", icon: MapPin, tone: "neutral" },
  ONLINE: { label: "Online", icon: Video, tone: "info" },
  HYBRID: { label: "Hybrid", icon: Globe, tone: "info" }
};

const PHASE_BADGE: Record<EventPhase, { label: string; tone: BadgeTone; icon: LucideIcon } | null> = {
  // Nothing for an event that has not started: "Upcoming" beside a future date says the date twice.
  upcoming: null,
  running: { label: "Under way now", tone: "success", icon: Clock },
  finished: { label: "This event has finished", tone: "neutral", icon: CalendarDays }
};

export interface EventDateBlockProps {
  startsAt: Date;
  endsAt?: Date | null;
  /** Computed by the page from one `now`, so every date-dependent statement on it agrees. */
  phase?: EventPhase;
  className?: string;
}

/**
 * The event page's "when" panel: the calendar tile, the range in words, the time, and the zone.
 *
 * THE TILE IS `aria-hidden`. The sentence beside it says the same dates in words and inside a
 * machine-readable `<time>`; announcing "6 dash 9 Aug 2026" first as three loose fragments would be
 * noise rather than information.
 */
export function EventDateBlock({ startsAt, endsAt, phase, className }: EventDateBlockProps) {
  const dates = describeEventDates(startsAt, endsAt);
  const badge = phase ? PHASE_BADGE[phase] : null;
  const zoneLong = centreZoneName(startsAt, "long");
  const zoneShort = centreZoneName(startsAt);

  return (
    <div
      className={cn(
        "flex gap-5 rounded-lg border border-line-200 bg-surface-50 p-5 sm:p-6",
        className
      )}
    >
      <div
        aria-hidden="true"
        className="flex w-20 shrink-0 flex-col items-center justify-center rounded-md border border-line-200 bg-card px-2 py-3 text-center"
      >
        <span
          className={cn(
            "display-title leading-none text-purple-700",
            // A range like "6 Aug" needs a smaller size than a bare "6" or the tile wraps mid-word.
            dates.block.top.length > 5 ? "text-base" : "text-2xl"
          )}
        >
          {dates.block.top}
        </span>
        <span className="mt-1 text-xs font-semibold uppercase tracking-wide text-ink-700">
          {dates.block.middle}
        </span>
        <span className="mt-0.5 text-xs tabular-nums text-ink-500">{dates.block.bottom}</span>
      </div>

      <div className="min-w-0 flex-1">
        <p className="field-label">When</p>

        <p className="mt-1.5 text-base font-medium leading-snug text-ink-900">
          <time dateTime={startsAt.toISOString()}>{dates.sentence}</time>
        </p>

        {dates.time ? (
          <p className="mt-1 flex items-center gap-1.5 text-sm tabular-nums text-ink-700">
            <Clock aria-hidden="true" className="h-4 w-4 shrink-0 text-ink-500" />
            {dates.time}
          </p>
        ) : null}

        {/* The zone, spelled out once in full. Every time above already carries its abbreviation; this
            is the line that tells a reader in another country what that abbreviation means. */}
        <p className="mt-2 text-xs leading-relaxed text-ink-500">
          {dates.multiDay
            ? `Session times are on the agenda below, and are given in ${zoneLong}${zoneShort ? ` (${zoneShort})` : ""}.`
            : `Given in ${zoneLong}${zoneShort ? ` (${zoneShort})` : ""} — the Centre's own time, not your device's.`}
        </p>

        {badge ? (
          <p className="mt-3">
            <Badge tone={badge.tone} icon={badge.icon} size="sm">
              {badge.label}
            </Badge>
          </p>
        ) : null}
      </div>
    </div>
  );
}
