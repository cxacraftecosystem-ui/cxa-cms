/**
 * lib/ical.ts — the Centre's events as RFC 5545 iCalendar text.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE FUSSY PARTS OF THE FORMAT ARE THE LOAD-BEARING PARTS, and every one of them fails in the same
 * way: the calendar client refuses the whole file, or imports it silently wrong. There is no partial
 * credit and no error message a reader can act on, so all four are handled here, once:
 *
 *   1. **CRLF, everywhere.** RFC 5545 §3.1 says lines end `\r\n`. A file written with bare newlines
 *      is rejected outright by several clients rather than repaired.
 *   2. **Folding at 75 OCTETS, not characters** (§3.1), with a single leading space on every
 *      continuation. `foldLine` counts UTF-8 bytes and walks by CODE POINT, so a Devanagari title or
 *      an emoji cannot be cut in half — half a code point is invalid UTF-8, which is a worse failure
 *      than a long line.
 *   3. **TEXT values escape `\`, `;`, `,` and newlines** (§3.3.11). An event description WILL contain
 *      a comma. ⚠ The backslash must be escaped FIRST or every other escape gets double-escaped.
 *   4. **UID and DTSTAMP are mandatory on every VEVENT** (§3.6.1).
 *
 * ⚠ THE UID IS DERIVED FROM THE RECORD ID AND THE SITE HOST, NEVER FROM THE TITLE OR THE SLUG. A UID
 * is how a subscriber's calendar recognises an event it already holds. Derive it from anything an
 * editor can change and a renamed event becomes a SECOND event in everybody's calendar, sitting beside
 * the first, with no way for anyone to remove the ghost. The `cuid` never changes; the host makes it
 * globally unique, which is what §3.8.4.7 asks for. (A consequence worth knowing: moving the site to
 * another domain re-issues every UID, so a domain move needs a word to subscribers.)
 *
 * TIMES ARE WRITTEN IN UTC, WITH NO VTIMEZONE. `startsAt`/`endsAt` are absolute instants
 * (prisma/schema.prisma), and a `Z` value is the one form every client reads identically. The
 * alternative — `TZID=Asia/Kolkata` — is only legal alongside a full VTIMEZONE block with its own
 * transition rules, and a hand-written VTIMEZONE that drifts from the real zone is a silent hour-out
 * bug. The reader's calendar then shows the event on the reader's own clock, which is the right
 * behaviour for a calendar and the ONE place the site's "always the Centre's time" rule does not
 * apply: this file is not a page, it is a row in somebody's own diary. The event page says so beside
 * the download.
 *
 * MULTI-DAY EVENTS BECOME ALL-DAY ENTRIES, and that is the page's decision, not a new one.
 * `describeEventDates` — the SAME function `/events/[slug]` renders with — refuses to state a time for
 * an event spanning more than one calendar day, because a single start time invites a reader to arrive
 * on the wrong day; the sessions are on the programme instead. Carried into a calendar, that is
 * exactly a `VALUE=DATE` banner across the dates. Writing it as one long timed block would instead
 * claim the reader is busy through both nights.
 *
 * ⚠ BUT THE CLOCK TIMES ARE STILL WRITTEN DOWN, IN THE DESCRIPTION. A `VALUE=DATE` banner throws the
 * hours away, and a subscriber holding only "6–9 August, all day" has no way to know the festival opens
 * at half past ten — the entry has quietly lost something the record knows, which is the one failure this
 * codebase treats as worse than being ugly (contract §1.6). So a multi-day VEVENT carries a sentence
 * naming the opening and closing times, and saying why it is a banner rather than a block. An event that
 * merely crosses midnight — a night of ragas from 22:30 to 01:00 — is a two-day banner for the same
 * reason the page calls it two days, and that sentence is what stops the banner being a lie by omission.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * NO `ORGANIZER` PROPERTY, AND THEREFORE NO `METHOD` EITHER — THE TWO ARE ONE DECISION. A CAL-ADDRESS
 * must be a real `mailto:`, and the Centre's contact address is a setting an editor may leave blank; an
 * ORGANIZER pointing at nothing is worse than none, because some clients offer to "reply to the
 * organiser" with it.
 *
 * ⚠ `METHOD:PUBLISH` WOULD THEN MAKE THE FILE NON-CONFORMANT rather than merely sparse. `METHOD` turns a
 * calendar into an iTIP message (RFC 5546), and the PUBLISH table in §3.2.1 lists ORGANIZER as presence
 * `1` — mandatory on every VEVENT. A PUBLISH document with no ORGANIZER is a scheduling message with no
 * sender, which Outlook in particular treats as a meeting invitation it cannot resolve. A calendar with
 * no `METHOD` is not a message at all: it is simply a calendar, which is exactly what this is, and it is
 * what Apple's and Google's own published feeds emit. The Centre is named in the calendar's own `NAME`,
 * which the route builds from the branding setting; `PRODID` identifies the software that wrote the file,
 * which is why it carries the host rather than an editable title.
 *
 * The only consumer of the BUILDER is `app/(site)/events/calendar.ics/route.ts`, which owns the queries,
 * the publish filter and the cap. This module owns the FORMAT and nothing else. `eventCalendarHref` has a
 * second caller — the download control on `app/(site)/events/[slug]/page.tsx` — which is the whole reason
 * the path is exported rather than typed out in two places.
 */

import type { EventMode } from "@prisma/client";

import {
  CENTRE_TIME_ZONE,
  describeEventDates,
  centreZoneName,
  eventPhase,
  formatCentreDate,
  formatCentreTime
} from "@/components/site/EventDateBlock";
import { siteUrl } from "@/lib/env";
import { parseRichText, richTextExcerpt } from "@/lib/richtext";
import { absoluteUrl } from "@/lib/seo";
import { slugify } from "@/lib/utils";

/** What the route must serve. The charset is not optional — the file is UTF-8 and says so nowhere else. */
export const ICS_CONTENT_TYPE = "text/calendar; charset=utf-8";

/**
 * The feed's path, written once.
 *
 * A link to a route handler is a plain string that nothing in TypeScript checks (contract §13b), and
 * `npm run route-check` only inspects `/api/...` literals — so this one would be checked by nobody.
 * One exported helper is the mitigation: the page and the route cannot drift apart if there is only
 * one spelling of the path.
 */
export const EVENT_CALENDAR_PATH = "/events/calendar.ics";

/** The whole feed, or one event's own file. */
export function eventCalendarHref(slug?: string): string {
  return slug ? `${EVENT_CALENDAR_PATH}?event=${encodeURIComponent(slug)}` : EVENT_CALENDAR_PATH;
}

const CRLF = "\r\n";

/** §3.1: "Lines of text SHOULD NOT be longer than 75 octets, excluding the line break." */
const MAX_OCTETS = 75;

/** Long enough to be worth reading in a calendar popup, short enough not to be the whole article. */
const DESCRIPTION_CHARS = 600;

const ENCODER = new TextEncoder();

/** `YYYY-MM-DD` in the Centre's zone. `en-CA` is the one common locale whose short date IS that shape. */
const ISO_DAY = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: CENTRE_TIME_ZONE
});

/**
 * Fold one property line to 75 octets, continuations prefixed with a single space.
 *
 * ⚠ THREE THINGS ARE EASY TO GET WRONG HERE AND ALL THREE HAVE THE SAME SYMPTOM — a file that opens
 * as gibberish or not at all:
 *
 *   • The limit is OCTETS. `line.length` counts UTF-16 units, so a line of Devanagari would be folded
 *     at roughly 25 characters too late and exceed the limit by two thirds.
 *   • `for…of` iterates by CODE POINT, so an astral character (an emoji in a title) stays whole. A
 *     `for (i…)` loop over `.length` would split its surrogate pair and produce invalid UTF-8.
 *   • The continuation's leading space COUNTS towards its 75, so the payload budget after the first
 *     line is 74.
 */
function foldLine(line: string): string {
  const pieces: string[] = [];
  let current = "";
  let octets = 0;
  let budget = MAX_OCTETS;

  for (const char of line) {
    const size = ENCODER.encode(char).length;
    if (octets + size > budget) {
      pieces.push(current);
      current = "";
      octets = 0;
      budget = MAX_OCTETS - 1; // the leading space of a continuation line
    }
    current += char;
    octets += size;
  }
  pieces.push(current);

  return pieces.join(`${CRLF} `);
}

/**
 * Remove every C0 control character and DEL.
 *
 * ⚠ THIS IS AN INJECTION GUARD WHEREVER IT IS USED ON A NON-TEXT VALUE, not a tidy-up. URI values are
 * NOT escaped (§3.3.13), so a stored `onlineUrl` carrying a CR/LF would end its property line and let
 * whatever followed be parsed as fresh iCalendar lines — `BEGIN:VEVENT` included. Nothing in the
 * format can carry a control character in any case, so removing them costs nothing anywhere else.
 *
 * Written as a code-point comparison rather than a regex range on purpose: the range can only be
 * spelled in a regex with `\u` escapes, and an escape typed wrong is invisible in the source. Numbers
 * are legible. The `for…of` also keeps astral characters whole, as in `foldLine`.
 *
 * The tab goes with the rest. §3.3.11 does permit one inside a TEXT value, but a tab is meaningless in
 * the single-line field a calendar client renders these into, and letting it through would mean two
 * rules where one will do.
 */
function stripControls(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 32 && code !== 127) out += char;
  }
  return out;
}

/**
 * Escape a TEXT value (§3.3.11).
 *
 * ⚠ THE ORDER IS THE WHOLE FUNCTION. Backslashes first: escape the comma before the backslash and
 * `a,b` becomes `a\\,b` — a literal backslash followed by an unescaped comma, which splits the value
 * in two at exactly the place the escape existed to prevent.
 *
 * The colon is deliberately NOT escaped: §3.3.11 lists only `\`, `;`, `,` and the line break, and a
 * `\:` in the wild is rendered literally by strict parsers.
 */
function escapeText(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
  // The line breaks are already gone — turned into the two-character sequence `\n` by the replace
  // above — so what `stripControls` still finds is only what the format cannot carry at all.
  return stripControls(escaped);
}

/** Clean a value that is NOT text — a URI, a geo pair, a date. See `stripControls` for the guard. */
function sanitiseRaw(value: string): string {
  return stripControls(value).trim();
}

/** `YYYYMMDDTHHMMSSZ` — a UTC DATE-TIME (§3.3.5). */
function utcStamp(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

/** `YYYYMMDD` — the calendar day this instant falls on in the Centre's zone. */
function centreDateValue(date: Date): string {
  const parts = ISO_DAY.formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}${pick("month")}${pick("day")}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * The day AFTER a `YYYYMMDD` value.
 *
 * ⚠ `DTEND` FOR AN ALL-DAY EVENT IS EXCLUSIVE (§3.6.1). A festival ending on the 9th is written
 * `DTEND;VALUE=DATE:20260810`, and getting this wrong is the classic iCalendar off-by-one: every
 * multi-day event loses its final day, which nobody notices until somebody misses the closing session.
 *
 * `Date.UTC` does the month and year rollover, and it is safe to use UTC arithmetic on a value that
 * is already a Centre-zone calendar date — no clock is involved, only the day counter.
 */
function nextDayValue(value: string): string {
  const shifted = new Date(
    Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8)) + 1)
  );
  return `${shifted.getUTCFullYear()}${pad2(shifted.getUTCMonth() + 1)}${pad2(shifted.getUTCDate())}`;
}

/** A TEXT property, or nothing at all when the value is absent — an empty `LOCATION:` is noise. */
function textProp(name: string, value: string | null | undefined): string[] {
  const clean = value?.trim();
  return clean ? [`${name}:${escapeText(clean)}`] : [];
}

/** A URI property. Not escaped (§3.3.13), only stripped of control characters. See `sanitiseRaw`. */
function uriProp(name: string, value: string | null | undefined): string[] {
  const clean = value ? sanitiseRaw(value) : "";
  return clean ? [`${name}:${clean}`] : [];
}

/** Exactly what a VEVENT needs. Deliberately a plain shape, so the route's `select` is the only place
 *  that knows about Prisma. */
export interface CalendarEvent {
  id: string;
  slug: string;
  title: string;
  subtitle?: string | null;
  summary?: string | null;
  /** The Tiptap document, used only when there is no summary. `unknown` because that is what a `Json`
   *  column is until `parseRichText` has looked at it. */
  body?: unknown;
  mode: EventMode;
  venue?: string | null;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  onlineUrl?: string | null;
  startsAt: Date;
  endsAt?: Date | null;
  /** Drives `SEQUENCE` and `LAST-MODIFIED`, so an edited event updates in a subscriber's calendar. */
  updatedAt: Date;
}

export interface CalendarOptions {
  /** What the calendar is called in a subscriber's sidebar. ⚠ If anything has been left out of the
   *  file, this is where it is said — see the route. */
  name: string;
  /** A sentence about what the file holds, carried in both the standard and the de-facto property. */
  description: string;
  /** ONE `now` for every `DTSTAMP` and every "has it finished?" decision in the file. */
  now?: Date;
}

/**
 * `SEQUENCE` from the record's own `updatedAt`, in whole minutes since the epoch.
 *
 * A client only re-reads an event it already holds when the revision goes UP, so a hard-coded `0`
 * means an edited event never corrects itself in anybody's calendar. A counter is not available (the
 * schema has no revision number on `CoeEvent`), and `updatedAt` is monotonic per record, which is the
 * one property `SEQUENCE` genuinely requires.
 *
 * ⚠ MINUTES, NOT SECONDS. `SEQUENCE` is an INTEGER, capped by §3.3.8 at 2147483647; seconds since the
 * epoch cross that in January 2038 and would wrap to a NEGATIVE number, i.e. an event that appears to
 * go backwards in every subscriber's calendar at once. Minutes reach the cap in the year 6053. The
 * cost is that two edits inside one minute share a revision, which loses nothing a reader can see.
 */
function sequenceOf(updatedAt: Date): number {
  return Math.max(0, Math.floor(updatedAt.getTime() / 60_000));
}

/** The host half of every UID. See the header for why it is part of the identity. */
function calendarHost(): string {
  return new URL(siteUrl()).host;
}

function describeEvent(event: CalendarEvent): string {
  const summary = event.summary?.trim() || event.subtitle?.trim();
  return summary || richTextExcerpt(parseRichText(event.body), DESCRIPTION_CHARS);
}

/**
 * One VEVENT.
 *
 * The property order is the conventional one (identity, then time, then content) purely for a human
 * reading the file — iCalendar itself is order-independent inside a component.
 */
function buildEvent(event: CalendarEvent, now: Date, host: string): string[] {
  const path = `/events/${event.slug}`;
  const url = absoluteUrl(path);
  const dates = describeEventDates(event.startsAt, event.endsAt);
  const finished = eventPhase(event.startsAt, event.endsAt, now) === "finished";

  const lines: string[] = ["BEGIN:VEVENT", `UID:${event.id}@${host}`, `DTSTAMP:${utcStamp(now)}`];

  /**
   * The sentence that keeps an all-day banner honest, or null for a timed entry that needs none.
   *
   * ⚠ A `VALUE=DATE` PAIR CANNOT CARRY AN HOUR, so for a multi-day event the times the record holds
   * exist nowhere in the file unless they are written out in words. See the header: an entry that has
   * quietly dropped what the Centre knows is the failure this codebase guards hardest against.
   */
  let spanNote: string | null = null;

  if (dates.multiDay && event.endsAt) {
    const startDay = centreDateValue(event.startsAt);
    const endDay = centreDateValue(event.endsAt);
    // A row whose end precedes its start is a data error, and a DTEND before its DTSTART makes some
    // clients reject the ENTIRE file — one bad record would take every other event down with it. The
    // fallback is a single all-day entry on the start date, which is at least true about the start.
    const forwards = Number(endDay) > Number(startDay);
    const lastDay = forwards ? endDay : startDay;

    // Every standalone time on this site names its zone, and a calendar entry is the LAST place to
    // drop that rule: the reader's own client has already converted the DATE-TIMEs to their clock, so a
    // bare "10:30" beside them would be read as a third, local, time.
    const zoneLong = centreZoneName(event.startsAt, "long");
    const zoneShort = centreZoneName(event.startsAt);
    const zone = `${zoneLong}${zoneShort ? ` (${zoneShort})` : ""}`;

    spanNote = forwards
      ? `Runs from ${formatCentreTime(event.startsAt)} on ${formatCentreDate(event.startsAt)} to ` +
        `${formatCentreTime(event.endsAt)} on ${formatCentreDate(event.endsAt)}, ${zone}. It is ` +
        "entered here as an all-day span rather than one long block because it crosses more than one " +
        "day; the session times are on the programme."
      : // Said out loud rather than smoothed over: the reader is looking at one day where the record
        // describes two, and the reason is a finishing time nobody has corrected yet.
        `Starts at ${formatCentreTime(event.startsAt)} on ${formatCentreDate(event.startsAt)}, ` +
        `${zone}. The record's finishing time is earlier than its start, so only the opening day is ` +
        "entered here.";

    lines.push(
      `DTSTART;VALUE=DATE:${startDay}`,
      // Exclusive. See `nextDayValue`.
      `DTEND;VALUE=DATE:${nextDayValue(lastDay)}`,
      // An all-day banner is a statement about which days the Centre is doing something, not a claim
      // on the reader's diary; marking it OPAQUE would show a subscriber as busy for three days.
      "TRANSP:TRANSPARENT"
    );
  } else {
    lines.push(`DTSTART:${utcStamp(event.startsAt)}`);
    // No DTEND when the record has no end, or when the end is not after the start. §3.6.1 makes such
    // an event zero-length, which is exactly what the record knows; inventing "probably an hour" would
    // put a wrong finishing time in somebody's diary and look authoritative doing it.
    if (event.endsAt && event.endsAt.getTime() > event.startsAt.getTime()) {
      lines.push(`DTEND:${utcStamp(event.endsAt)}`);
    }
    lines.push("TRANSP:OPAQUE");
  }

  lines.push(...textProp("SUMMARY", event.title));

  /**
   * The description carries the link as well as the prose.
   *
   * `URL` is the correct property for it and it is emitted below, but Google Calendar and Outlook show
   * DESCRIPTION and hide URL — so a reader looking at the entry three weeks later would have no way
   * back to the page. The line is repeated rather than moved.
   */
  const summary = describeEvent(event);
  // The joining link follows the page's rule exactly (`showOnlineLink` in app/(site)/events/[slug]):
  // never for an in-person event, and never once the event has finished, when the room is closed and
  // the link is at best a dead end.
  const joining =
    !finished && event.mode !== "IN_PERSON" && event.onlineUrl?.trim()
      ? sanitiseRaw(event.onlineUrl)
      : null;

  const descriptionParts = [
    summary,
    // Before the link, because it is a fact about the entry the reader is looking at rather than a
    // pointer away from it. See `spanNote`.
    spanNote ?? "",
    `Full details: ${url}`,
    joining ? `Joining link: ${joining}` : ""
  ].filter((part) => part.length > 0);
  lines.push(...textProp("DESCRIPTION", descriptionParts.join("\n\n")));

  /**
   * LOCATION is where a person goes. For an online event that is the joining link — the convention
   * every major client follows, and the reason its "join" button lights up at all. For a hybrid one it
   * is the building, with the link in the description above, because a hybrid event has a room.
   */
  const place = [event.venue?.trim(), event.address?.trim()].filter(Boolean).join(", ");
  if (event.mode === "ONLINE") {
    // `||`, not `??`: `place` is a joined string, so its absence is "" rather than null, and `??` would
    // hand the reader an empty LOCATION line instead of the one word that is actually true.
    lines.push(...textProp("LOCATION", joining ?? (place || "Online")));
  } else {
    lines.push(...textProp("LOCATION", place));
  }

  // GEO is a structured value: two floats separated by a semicolon, which is NOT an escape here.
  if (
    typeof event.latitude === "number" &&
    typeof event.longitude === "number" &&
    Number.isFinite(event.latitude) &&
    Number.isFinite(event.longitude)
  ) {
    lines.push(`GEO:${event.latitude};${event.longitude}`);
  }

  lines.push(
    ...uriProp("URL", url),
    // Only published events reach this file, and the Centre has no "cancelled" state on the record —
    // a cancelled event is unpublished or archived, and simply leaves the feed. CONFIRMED is therefore
    // always the truth here; CANCELLED would need a column before it could be honest.
    "STATUS:CONFIRMED",
    `SEQUENCE:${sequenceOf(event.updatedAt)}`,
    `LAST-MODIFIED:${utcStamp(event.updatedAt)}`,
    "END:VEVENT"
  );

  return lines;
}

/**
 * A whole VCALENDAR document, ready to serve.
 *
 * An empty `events` array is a legitimate answer and produces a valid, empty calendar — a subscriber
 * whose feed is briefly empty must see "nothing on" rather than a parse error.
 */
export function buildEventCalendar(
  events: readonly CalendarEvent[],
  options: CalendarOptions
): string {
  const now = options.now ?? new Date();
  const host = calendarHost();

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${escapeText(host)}//Events//EN`,
    "CALSCALE:GREGORIAN",
    // ⚠ NO `METHOD`. It would oblige every VEVENT to carry an ORGANIZER, which this file deliberately
    // cannot supply — see the header. A calendar without one is a calendar; with one it is a scheduling
    // message, and a scheduling message with no sender is what clients reject.
    /**
     * ⚠ THE DOUBLED PROPERTIES ARE PROGRESSIVE ENHANCEMENT, NOT A DUPLICATE — the same shape as the
     * `.nav-sheet` doubled max-height in globals.css. `NAME`, `DESCRIPTION` and `REFRESH-INTERVAL` are
     * the standard properties (RFC 7986); `X-WR-CALNAME`, `X-WR-CALDESC` and `X-PUBLISHED-TTL` are the
     * de-facto ones that Google, Apple and Outlook actually read. Emitting only the standard set gives
     * every real subscriber a calendar named after its URL.
     */
    ...textProp("NAME", options.name),
    ...textProp("X-WR-CALNAME", options.name),
    ...textProp("DESCRIPTION", options.description),
    ...textProp("X-WR-CALDESC", options.description),
    // A display hint only: every DATE-TIME below is a UTC instant and needs no zone to be understood.
    // It tells a client which zone to show the all-day banners against, which is the Centre's.
    `X-WR-TIMEZONE:${CENTRE_TIME_ZONE}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    ...events.flatMap((event) => buildEvent(event, now, host)),
    "END:VCALENDAR"
  ];

  // The trailing CRLF is part of the format: the last line ends like every other one.
  return `${lines.map(foldLine).join(CRLF)}${CRLF}`;
}

/**
 * A safe `Content-Disposition` filename.
 *
 * ⚠ THE SANITISING IS A HEADER GUARD, NOT COSMETICS. The stem reaches this from a database row, and a
 * quotation mark or a newline in it would break out of the quoted filename and let an attacker append
 * header fields. `slugify` reduces it to `[a-z0-9-]`, which cannot express either.
 *
 * The stem is trimmed BEFORE the extension is added — slicing the finished name would eventually eat
 * the `.ics` and hand the reader a file their calendar refuses to open.
 */
export function icsFileName(stem: string): string {
  const safe = slugify(stem).slice(0, 90);
  return `${safe.length > 0 ? safe : "events"}.ics`;
}
