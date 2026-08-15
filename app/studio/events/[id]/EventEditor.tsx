"use client";

/**
 * EventEditor — an event, its programme, its speakers and its registration window.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ EVERY TIME ON THIS SCREEN IS THE CENTRE'S TIME. THIS IS THE MOST IMPORTANT THING IN THIS FILE.
 *
 * `CoeEvent.startsAt` and `endsAt` are absolute UTC instants, and prisma/schema.prisma is explicit that
 * the site renders them in the CENTRE's zone rather than the viewer's: "the seminar is at 4pm" has to
 * mean one instant for everyone, or two people comparing notes disagree about when to arrive.
 *
 * The consequence for an editor is the whole reason `ZonedDateTimeField` exists. A plain
 * `<input type="datetime-local">` speaks THIS COMPUTER'S time zone — so an administrator in London typing
 * "16:00" would store 16:00 UTC, which is half past nine at night in Jaipur, and an administrator in
 * Jaipur typing the same thing would store something else. Both boxes look identical and neither says
 * which zone it means.
 *
 * So every time field here converts in both directions through the Centre's zone, and every one of them
 * NAMES THAT ZONE ON SCREEN, under the field, where somebody filling it in will read it. A comment in
 * this file would be read by nobody who is about to get it wrong.
 *
 * (The zone comes from the server, which is where the setting will live. `components/site/EventDateBlock`
 * is the single declared home of the constant today.)
 *
 * TWO IMPOSSIBLE STATES ARE REFUSED, WITH THE REASON:
 *
 *   • an end before its start — a negative event;
 *   • a registration window that closes after the event has finished, or opens after it closes. Taking
 *     registrations for something that has already happened is not a preference, it is a bug that fills
 *     an attendee list nobody reads.
 *
 * The refusal names the problem in the save bar AND beside the field, from the same function, so the two
 * can never word it differently.
 *
 * `CoeEvent` HAS NO `publishAt`/`unpublishAt`, so scheduling is OFF on the publish control. Offering a
 * schedule for a model with nowhere to store it writes a date into nothing and leaves a record that never
 * publishes (see StatusControl's header).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CalendarClock, ClipboardList, Image as ImageIcon, MapPin, Plus, X } from "lucide-react";
import type { ContentStatus, EventMode } from "@prisma/client";

import { asApiClientError, patch, post } from "@/lib/client/fetcher";
import type { MediaLike } from "@/lib/media/url";
import { canPublish as canPublishPredicate, type PermissionSubject } from "@/lib/permissions";
import type { RichTextDoc } from "@/lib/richtext";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Field, FieldBlock } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { MediaImage } from "@/components/ui/MediaImage";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { Textarea } from "@/components/ui/Textarea";
// One vocabulary for the three modes, shared with the public site, so "Hybrid" cannot be a chip in one
// place and a different word in the other.
import { EVENT_MODES } from "@/components/site/EventDateBlock";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";
import { SaveBar } from "@/components/studio/SaveBar";
import { SlugField } from "@/components/studio/SlugField";
import { StatusControl, statusProblems, type StatusControlValue } from "@/components/studio/StatusControl";
import { PUBLISHED_AUTOSAVE_NOTICE, useAutosave } from "@/components/studio/useAutosave";
import { useLeaveGuard } from "@/components/studio/useUnsavedChanges";
import { EntityPicker } from "@/components/studio/fields/EntityPicker";
import { RepeaterField } from "@/components/studio/fields/RepeaterField";
import { RichTextEditor } from "@/components/studio/editor/RichTextEditor";
import { MediaPicker } from "@/components/studio/media/MediaPicker";
import type { StudioMediaAsset } from "@/components/studio/media/MediaGrid";

// ─────────────────────────────────────────────────────────────────────────────
// Limits
// ─────────────────────────────────────────────────────────────────────────────

const TITLE_MAX = 200;
const SUBTITLE_MAX = 240;
const SUMMARY_MAX = 400;
const VENUE_MAX = 160;
const ADDRESS_MAX = 400;
const AGENDA_MAX = 40;
const SPEAKERS_MAX = 20;
const GALLERY_MAX = 40;
const TAG_MAX = 12;

// ─────────────────────────────────────────────────────────────────────────────
// Time in the Centre's zone
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An instant broken into the numbers a person in `timeZone` would read off a clock.
 *
 * `hourCycle: "h23"` rather than `hour12: false`: some ICU builds render midnight as "24" under the
 * latter, which would produce `2026-08-06T24:00` — a value the input silently refuses.
 */
function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : 0;
  };

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second")
  };
}

/** The zone's offset from UTC, in milliseconds, AT a given instant. Positive east of Greenwich. */
function offsetAt(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return asIfUtc - date.getTime();
}

/** An ISO instant as `YYYY-MM-DDTHH:mm` on the Centre's clock. `""` for nothing. */
function toZonedInput(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = zonedParts(date, timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

/**
 * `YYYY-MM-DDTHH:mm` READ AS THE CENTRE'S CLOCK, back to an absolute instant.
 *
 * ⚠ `new Date("2026-08-06T16:00")` is parsed as the BROWSER's local time by the specification, which is
 * exactly the bug this whole module exists to avoid. So the wall-clock numbers are turned into a UTC
 * instant first and then corrected by the zone's offset.
 *
 * The correction is applied TWICE. The offset depends on the instant, and the first guess uses the offset
 * at the wrong instant — which is only wrong at all within an hour of a daylight-saving change, and only
 * then by exactly one hour. A second pass, taken at the corrected instant, converges. (India has no
 * daylight saving, so today the first pass is already exact; the second pass is what makes this correct
 * if the Centre's zone is ever set to one that does.)
 */
function fromZonedInput(local: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (!match) return null;

  const [, year, month, day, hour, minute] = match;
  if (!year || !month || !day || !hour || !minute) return null;

  const wall = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  const firstPass = wall - offsetAt(new Date(wall), timeZone);
  const secondPass = wall - offsetAt(new Date(firstPass), timeZone);
  const instant = new Date(secondPass);
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

function parseInstant(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface AgendaItemValue {
  title: string;
  detail: string;
  /** A free-text name. The speakers list below links to real people; an agenda line often names neither. */
  speaker: string;
  startsAt: string | null;
  endsAt: string | null;
}

export interface EventValue {
  title: string;
  slug: string;
  subtitle: string;
  summary: string;
  body: unknown;
  mode: EventMode;
  venue: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  onlineUrl: string;
  /** ISO instants. `startsAt` is required by the schema; the form allows it to be empty and refuses to save. */
  startsAt: string | null;
  endsAt: string | null;
  registrationUrl: string;
  registrationOpensAt: string | null;
  registrationClosesAt: string | null;
  capacity: number | null;
  isRegistrationOpen: boolean;
  coverId: string | null;
  galleryIds: string[];
  speakerIds: string[];
  /** Tag NAMES, as in the newsroom editor: a tag that does not exist yet is created on save. */
  tags: string[];
  agenda: AgendaItemValue[];
  status: ContentStatus;
  publishedAt: string | null;
  isFeatured: boolean;
}

interface EventResponse {
  event: { id: string };
}

export interface EventEditorProps {
  mode: "create" | "edit";
  eventId: string | null;
  initial: EventValue;
  initialCover: MediaLike | null;
  /** Existing tag names, offered while typing. Capped; the cap is stated. */
  tagSuggestions: readonly string[];
  tagSuggestionsTruncated: boolean;
  /** IANA name — the Centre's zone. Every time on this screen is read and written in it. */
  timeZone: string;
  /** "India Standard Time (IST)". Built on the server so both render passes agree on the wording. */
  timeZoneLabel: string;
  /** How many people have registered so far, so capacity can be judged rather than guessed. */
  registrationCount: number;
  user: PermissionSubject;
  storageReady: boolean;
  siteOrigin: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The two impossible states
// ─────────────────────────────────────────────────────────────────────────────

interface TimeProblems {
  /** The end is before the start. Attached to the end field. */
  endBeforeStart: string | null;
  /** Registration closes before it opens. Attached to the closing field. */
  windowOrder: string | null;
  /** Registration is still open after the event has finished. Attached to the closing field. */
  windowAfterEvent: string | null;
  /** Registration opens after the event has finished. Attached to the opening field. */
  opensAfterEvent: string | null;
}

/**
 * Every date problem, as one sentence each or null.
 *
 * ONE FUNCTION, so the message under a field and the message in the save bar are literally the same
 * string. The alternative — matching a sentence out of an array by its opening words — breaks silently the
 * day somebody rewords it.
 */
function timeProblems(value: EventValue): TimeProblems {
  const startsAt = parseInstant(value.startsAt);
  const endsAt = parseInstant(value.endsAt);
  const opensAt = parseInstant(value.registrationOpensAt);
  const closesAt = parseInstant(value.registrationClosesAt);
  /** The moment the event is over. An event with no end finishes when it starts. */
  const finishesAt = endsAt ?? startsAt;

  return {
    endBeforeStart:
      startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()
        ? "The event cannot finish before — or at the same moment as — it starts."
        : null,
    windowOrder:
      opensAt && closesAt && closesAt.getTime() <= opensAt.getTime()
        ? "Registration cannot close before it opens."
        : null,
    windowAfterEvent:
      closesAt && finishesAt && closesAt.getTime() > finishesAt.getTime()
        ? "Registration would still be open after the event has finished. Close it at or before the end."
        : null,
    opensAfterEvent:
      opensAt && finishesAt && opensAt.getTime() > finishesAt.getTime()
        ? "Registration would open after the event has finished, so nobody could ever use it."
        : null
  };
}

/**
 * One agenda session's own ordering, as a sentence or null.
 *
 * Compared as instants rather than as ISO strings. The strings happen to sort chronologically today
 * because they all come from `toISOString()`, which is a property of how they were produced rather than
 * of the type — and one imported record with an offset in it would break the comparison silently.
 */
function sessionOrderProblem(item: AgendaItemValue): string | null {
  const startsAt = parseInstant(item.startsAt);
  const endsAt = parseInstant(item.endsAt);
  if (!startsAt || !endsAt) return null;
  return endsAt.getTime() <= startsAt.getTime()
    ? "This session cannot finish before — or at the same moment as — it starts."
    : null;
}

function firstProblem(problems: TimeProblems): string | null {
  return (
    problems.endBeforeStart ??
    problems.windowOrder ??
    problems.windowAfterEvent ??
    problems.opensAfterEvent ??
    null
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The editor
// ─────────────────────────────────────────────────────────────────────────────

export function EventEditor({
  mode,
  eventId,
  initial,
  initialCover,
  tagSuggestions,
  tagSuggestionsTruncated,
  timeZone,
  timeZoneLabel,
  registrationCount,
  user,
  storageReady,
  siteOrigin
}: EventEditorProps) {
  const router = useRouter();

  const [value, setValue] = useState<EventValue>(initial);
  const [cover, setCover] = useState<MediaLike | null>(initialCover);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]> | null>(null);

  const problems = useMemo(() => timeProblems(value), [value]);

  // ── Saving ───────────────────────────────────────────────────────────────

  const isPublic = value.status === "PUBLISHED";

  const save = useCallback(
    async (data: EventValue): Promise<void> => {
      setFieldErrors(null);
      try {
        if (mode === "create") {
          const created = await post<EventResponse>("/api/studio/events", data);
          router.push(`/studio/events/${encodeURIComponent(created.event.id)}`);
          return;
        }
        if (eventId === null) return;
        await patch<EventResponse>(`/api/studio/events/${encodeURIComponent(eventId)}`, data);
      } catch (thrown) {
        const failure = asApiClientError(thrown);
        setFieldErrors(failure.fieldErrors ?? null);
        throw failure;
      }
    },
    [eventId, mode, router]
  );

  const autosave = useAutosave<EventValue>({
    data: value,
    save,
    enabled: mode === "edit",
    isPublished: isPublic
  });

  useLeaveGuard(autosave.isDirty);

  const discard = useCallback(() => {
    setValue(initial);
    setCover(initialCover);
    setFieldErrors(null);
  }, [initial, initialCover]);

  // ── Tags ─────────────────────────────────────────────────────────────────

  const atTagLimit = value.tags.length >= TAG_MAX;

  const addTag = useCallback((raw: string) => {
    const name = raw.trim().replace(/\s+/g, " ");
    if (name.length === 0) return;
    setTagDraft("");
    setValue((current) => {
      if (current.tags.length >= TAG_MAX) return current;
      // Case-insensitive: "Textiles" and "textiles" are one tag and two rows in a filter.
      if (current.tags.some((tag) => tag.toLowerCase() === name.toLowerCase())) return current;
      return { ...current, tags: [...current.tags, name] };
    });
  }, []);

  // ── Validation ───────────────────────────────────────────────────────────

  const titleMissing = value.title.trim().length === 0;
  const addressMissing = value.slug.trim().length === 0;
  const startMissing = value.startsAt === null;

  const scheduleProblems = statusProblems(
    { status: value.status, publishedAt: value.publishedAt },
    // `CoeEvent` has no publishAt/unpublishAt columns — see the header.
    false
  );

  const saveDisabledReason = titleMissing
    ? "The event has no title."
    : addressMissing
      ? "The event has no web address. It is usually the title with hyphens instead of spaces."
      : startMissing
        ? "The event has no start date and time. An event without one cannot be listed or ordered."
        : (firstProblem(problems) ?? scheduleProblems[0] ?? null);

  /** What must be true before the public sees it, as complete sentences. */
  const publishBlockers: string[] = [];
  if (titleMissing) publishBlockers.push("The event has no title.");
  if (startMissing) publishBlockers.push("The event has no start date and time.");
  if (value.mode !== "ONLINE" && value.venue.trim().length === 0) {
    publishBlockers.push(
      "There is no venue, and people are expected to come in person. A page that does not say where to go is worse than no page."
    );
  }
  if (value.mode !== "IN_PERSON" && value.onlineUrl.trim().length === 0) {
    publishBlockers.push(
      "There is no joining link, and people are expected to attend online."
    );
  }
  if (value.summary.trim().length === 0) {
    publishBlockers.push("There is no summary, so the event will appear in lists with nothing under its title.");
  }
  const timeProblem = firstProblem(problems);
  if (timeProblem !== null) publishBlockers.push(timeProblem);

  const mayPublish = canPublishPredicate(user);

  // ── Capacity, in words ───────────────────────────────────────────────────

  const capacityNote =
    value.capacity === null
      ? registrationCount === 0
        ? "No limit is set, so registration will not close on its own."
        : `No limit is set. ${registrationCount === 1 ? "1 person has" : `${registrationCount} people have`} registered so far.`
      : `${registrationCount} of ${value.capacity} ${value.capacity === 1 ? "place" : "places"} taken. Anyone registering after that goes on the waiting list.`;

  return (
    <div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,23rem)] lg:items-start">
        {/* ── The event itself ───────────────────────────────────────────── */}
        <div className="min-w-0 space-y-5">
          <FormSection
            title="What it is"
            description="The title and summary are what appear in every list of events, on the homepage and wherever the link is shared."
          >
            <Field
              label="Title"
              required
              maxLength={TITLE_MAX}
              value={value.title}
              error={fieldErrors?.title?.[0] ?? null}
              help="Name the event as it will be announced. Sentence case, no full stop."
            >
              <Input
                value={value.title}
                onChange={(event) => setValue((current) => ({ ...current, title: event.target.value }))}
                placeholder="Craft, code and continuity: a two-day workshop"
              />
            </Field>

            <SlugField
              value={value.slug}
              onChange={(next) => setValue((current) => ({ ...current, slug: next }))}
              source={value.title}
              basePath="/events/"
              siteUrl={siteOrigin}
              originalValue={mode === "edit" ? initial.slug : undefined}
              isPublished={isPublic}
              required
              error={fieldErrors?.slug?.[0] ?? null}
            />

            <Field
              label="Subtitle"
              maxLength={SUBTITLE_MAX}
              value={value.subtitle}
              help="One line under the title on the event's own page. Leave it empty if the title says enough."
            >
              <Input
                value={value.subtitle}
                onChange={(event) => setValue((current) => ({ ...current, subtitle: event.target.value }))}
              />
            </Field>

            <Field
              label="Summary"
              maxLength={SUMMARY_MAX}
              value={value.summary}
              help="Two or three sentences: what it is, who it is for, and why to come. Used in every list."
            >
              <Textarea
                value={value.summary}
                rows={3}
                onChange={(event) => setValue((current) => ({ ...current, summary: event.target.value }))}
              />
            </Field>
          </FormSection>

          <FormSection
            title="When"
            description={`Both times are entered and shown in ${timeZoneLabel} — the Centre's own time, not your computer's. They are stored as one exact moment, so an administrator anywhere in the world typing 16:00 means the same instant.`}
            columns={2}
          >
            <ZonedDateTimeField
              label="Starts"
              required
              value={value.startsAt}
              timeZone={timeZone}
              timeZoneLabel={timeZoneLabel}
              onChange={(next) => setValue((current) => ({ ...current, startsAt: next }))}
              error={startMissing ? "An event needs a start date and time." : null}
            />

            <ZonedDateTimeField
              label="Finishes"
              value={value.endsAt}
              timeZone={timeZone}
              timeZoneLabel={timeZoneLabel}
              onChange={(next) => setValue((current) => ({ ...current, endsAt: next }))}
              error={problems.endBeforeStart}
              help="Leave it empty for a single session with no stated end."
            />
          </FormSection>

          <FormSection
            title="Where"
            description="In person, online, or both. What is asked for below changes with the answer, because a venue for an online seminar is noise and a joining link for a workshop in a courtyard is a broken promise."
          >
            <Field label="How people attend" required>
              <Select
                value={value.mode}
                options={(Object.keys(EVENT_MODES) as EventMode[]).map((key) => ({
                  value: key,
                  label: EVENT_MODES[key].label
                }))}
                onChange={(event) =>
                  setValue((current) => ({ ...current, mode: event.target.value as EventMode }))
                }
              />
            </Field>

            {value.mode !== "ONLINE" ? (
              <>
                <Field
                  label="Venue"
                  required
                  maxLength={VENUE_MAX}
                  value={value.venue}
                  help="The name of the building or room, as somebody would ask for it at a gate."
                >
                  <Input
                    icon={MapPin}
                    value={value.venue}
                    onChange={(event) => setValue((current) => ({ ...current, venue: event.target.value }))}
                    placeholder="Seminar Hall, Design Block"
                  />
                </Field>

                <Field
                  label="Address"
                  maxLength={ADDRESS_MAX}
                  value={value.address}
                  help="The full postal address, for anybody travelling or using a map application."
                >
                  <Textarea
                    value={value.address}
                    rows={3}
                    onChange={(event) => setValue((current) => ({ ...current, address: event.target.value }))}
                  />
                </Field>

                <div className="grid gap-4 sm:grid-cols-2">
                  <CoordinateField
                    label="Latitude"
                    value={value.latitude}
                    min={-90}
                    max={90}
                    onChange={(next) => setValue((current) => ({ ...current, latitude: next }))}
                  />
                  <CoordinateField
                    label="Longitude"
                    value={value.longitude}
                    min={-180}
                    max={180}
                    onChange={(next) => setValue((current) => ({ ...current, longitude: next }))}
                  />
                </div>

                <HelpText>
                  Both coordinates are needed before a map is drawn — one on its own is not a place. Leave
                  them empty and the page shows the address as text, which is still useful.
                </HelpText>
              </>
            ) : null}

            {value.mode !== "IN_PERSON" ? (
              <Field
                label="Joining link"
                required
                help="The meeting address people use to attend. It is shown to registered attendees; treat it as you would the invitation itself."
              >
                <Input
                  value={value.onlineUrl}
                  inputMode="url"
                  onChange={(event) =>
                    setValue((current) => ({ ...current, onlineUrl: event.target.value }))
                  }
                  placeholder="https://meet.example.com/craft-workshop"
                  className="font-mono text-xs"
                />
              </Field>
            ) : null}
          </FormSection>

          <FormSection
            title="The full description"
            description="The body of the event's own page. Everything a reader needs that will not fit in the summary."
          >
            <RichTextEditor
              value={value.body}
              onChange={(doc: RichTextDoc) => setValue((current) => ({ ...current, body: doc }))}
              label="Event description"
              placeholder="What will happen, who is speaking, what to bring."
              minHeight={280}
            />
          </FormSection>

          <FormSection
            title="Programme"
            description={`Sessions in the order they happen. Times are in ${timeZoneLabel}, like the rest of this screen, and may be left empty for a session with no fixed hour.`}
          >
            <RepeaterField<AgendaItemValue>
              label="Sessions"
              help="Each row is one line on the published programme."
              items={value.agenda}
              onChange={(next) => setValue((current) => ({ ...current, agenda: next }))}
              max={AGENDA_MAX}
              itemNoun="session"
              createItem={() => ({ title: "", detail: "", speaker: "", startsAt: null, endsAt: null })}
              summary={(item) => item.title.trim()}
              isEmpty={(item) =>
                item.title.trim().length === 0 &&
                item.detail.trim().length === 0 &&
                item.speaker.trim().length === 0 &&
                item.startsAt === null &&
                item.endsAt === null
              }
              emptyMessage="No programme yet. Add the first session, or leave this empty for an event with a single continuous sitting."
              renderItem={({ item, update }) => (
                <>
                  <Field label="Session title" required value={item.title} maxLength={160}>
                    <Input
                      value={item.title}
                      onChange={(event) => update({ ...item, title: event.target.value })}
                      placeholder="Opening address"
                    />
                  </Field>

                  <Field
                    label="Who is leading it"
                    value={item.speaker}
                    maxLength={160}
                    help="A name as it should be printed. Speakers with a profile on the site are listed separately, on the right."
                  >
                    <Input
                      value={item.speaker}
                      onChange={(event) => update({ ...item, speaker: event.target.value })}
                    />
                  </Field>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <ZonedDateTimeField
                      label="Starts"
                      value={item.startsAt}
                      timeZone={timeZone}
                      timeZoneLabel={timeZoneLabel}
                      onChange={(next) => update({ ...item, startsAt: next })}
                    />
                    <ZonedDateTimeField
                      label="Finishes"
                      value={item.endsAt}
                      timeZone={timeZone}
                      timeZoneLabel={timeZoneLabel}
                      onChange={(next) => update({ ...item, endsAt: next })}
                      error={sessionOrderProblem(item)}
                    />
                  </div>

                  <Field label="Detail" value={item.detail} maxLength={400}>
                    <Textarea
                      value={item.detail}
                      rows={2}
                      onChange={(event) => update({ ...item, detail: event.target.value })}
                    />
                  </Field>
                </>
              )}
            />
          </FormSection>
        </div>

        {/* ── The side column ───────────────────────────────────────────── */}
        <div className="min-w-0 space-y-5 lg:sticky lg:top-4 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:overscroll-contain lg:pb-2">
          <FormSection
            title="Publishing"
            description="Whether the event appears on the public site."
          >
            <StatusControl
              value={{ status: value.status, publishedAt: value.publishedAt }}
              onChange={(next: StatusControlValue) =>
                setValue((current) => ({ ...current, status: next.status }))
              }
              canPublish={mayPublish}
              // No publishAt/unpublishAt columns on this model — see the header.
              scheduling={false}
              publishBlockers={publishBlockers}
            />

            {mayPublish ? (
              <Switch
                checked={value.isFeatured}
                onCheckedChange={(checked) =>
                  setValue((current) => ({ ...current, isFeatured: checked }))
                }
                label="Feature this event"
                description="Featured events can be shown on the homepage. Publishing it is still a separate step."
              />
            ) : null}
          </FormSection>

          <FormSection
            title="Registration"
            description="Whether people can register through the site, and for how long."
          >
            <Switch
              checked={value.isRegistrationOpen}
              onCheckedChange={(checked) =>
                setValue((current) => ({ ...current, isRegistrationOpen: checked }))
              }
              label="Take registrations on the site"
              description="With this off, the form does not appear even inside the dates below."
            />

            <ZonedDateTimeField
              label="Registration opens"
              value={value.registrationOpensAt}
              timeZone={timeZone}
              timeZoneLabel={timeZoneLabel}
              onChange={(next) =>
                setValue((current) => ({ ...current, registrationOpensAt: next }))
              }
              error={problems.opensAfterEvent}
              help="Leave it empty to accept registrations as soon as the event is published."
            />

            <ZonedDateTimeField
              label="Registration closes"
              value={value.registrationClosesAt}
              timeZone={timeZone}
              timeZoneLabel={timeZoneLabel}
              onChange={(next) =>
                setValue((current) => ({ ...current, registrationClosesAt: next }))
              }
              error={problems.windowOrder ?? problems.windowAfterEvent}
              help="Leave it empty to keep it open until the event finishes."
            />

            <Field
              label="Places"
              help="How many people can attend. Leave it empty for no limit."
            >
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                value={value.capacity === null ? "" : String(value.capacity)}
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  const parsed = Number.parseInt(raw, 10);
                  setValue((current) => ({
                    ...current,
                    // An empty box is NO LIMIT, not zero. `Number("")` is 0, and a capacity of 0 would
                    // put every single registration on the waiting list.
                    capacity: raw.length === 0 || !Number.isFinite(parsed) ? null : Math.max(0, parsed)
                  }));
                }}
                className="max-w-[8rem]"
              />
            </Field>

            {/* Never a bare number: the sentence is what an organiser is actually asking. */}
            <HelpText>{capacityNote}</HelpText>

            <Field
              label="Registration elsewhere"
              help="For an event handled by another system. Given an address here, the site links to it instead of showing its own form."
            >
              <Input
                value={value.registrationUrl}
                inputMode="url"
                onChange={(event) =>
                  setValue((current) => ({ ...current, registrationUrl: event.target.value }))
                }
                placeholder="https://forms.example.ac.in/craft-workshop"
                className="font-mono text-xs"
              />
            </Field>

            {mode === "edit" && eventId !== null ? (
              <Link
                href={`/studio/events/${encodeURIComponent(eventId)}/registrations`}
                className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-line-200 bg-card px-3 py-1.5 text-xs font-medium text-ink-700 transition hover:border-purple-300 hover:text-purple-700"
              >
                <ClipboardList aria-hidden="true" className="h-3.5 w-3.5" />
                Who has registered
              </Link>
            ) : null}
          </FormSection>

          <FormSection
            title="Speakers"
            description="People with a profile on the site. Their photograph and designation are taken from the profile, so nothing is typed twice."
          >
            <EntityPicker
              kind="person"
              label="Speakers"
              help={`Up to ${SPEAKERS_MAX}. The order here is the order they appear in.`}
              ids={value.speakerIds}
              onChange={(next) => setValue((current) => ({ ...current, speakerIds: next }))}
              max={SPEAKERS_MAX}
              footnote="A profile that is not published is listed here but will not appear on the event page. Each speaker's role at this event is not set here — the programme above is where a session names who is leading it."
            />
          </FormSection>

          <FormSection
            title="Cover photograph"
            description="Shown at the top of the event's page, in every list, and when the link is shared."
          >
            {cover !== null ? (
              <MediaImage
                media={cover}
                alt=""
                aspect="16 / 9"
                rounded="md"
                targetWidth={640}
                sizes="(min-width: 1024px) 21rem, 100vw"
              />
            ) : (
              <p className="rounded-md border border-dashed border-line-200 bg-surface-50 px-3 py-4 text-sm text-ink-500">
                No cover photograph. The event will appear without a picture everywhere it is listed.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" icon={ImageIcon} onClick={() => setPickerOpen(true)}>
                {cover === null ? "Choose a photograph" : "Change the photograph"}
              </Button>
              {cover !== null ? (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={X}
                  onClick={() => {
                    setCover(null);
                    setValue((current) => ({ ...current, coverId: null }));
                  }}
                >
                  Take it off
                </Button>
              ) : null}
            </div>
          </FormSection>

          <FormSection
            title="Photographs from the event"
            description="Added after the event has happened. They appear as a gallery at the foot of its page."
          >
            <EntityPicker
              kind="media"
              label="Gallery"
              help={`Up to ${GALLERY_MAX}, in the order they should be shown.`}
              ids={value.galleryIds}
              onChange={(next) => setValue((current) => ({ ...current, galleryIds: next }))}
              max={GALLERY_MAX}
              footnote="Captions and descriptions are written once in the media library and follow each picture wherever it is used."
            />
          </FormSection>

          <FormSection title="Tags" description="Cross-cutting labels, shared with the newsroom.">
            <FieldBlock
              label="Tags"
              htmlFor="event-tag-input"
              help={`Type a name and press Enter. A tag that does not exist yet is created when you save. Up to ${TAG_MAX}.`}
            >
              {value.tags.length > 0 ? (
                <ul className="mb-2 flex flex-wrap gap-1.5">
                  {value.tags.map((tag) => (
                    <li key={tag}>
                      {/* The whole chip removes the tag: a 12px × inside a chip is a target nobody hits. */}
                      <button
                        type="button"
                        onClick={() =>
                          setValue((current) => ({
                            ...current,
                            tags: current.tags.filter((entry) => entry !== tag)
                          }))
                        }
                        className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-purple-200 bg-purple-50 px-2.5 py-1 text-xs font-medium text-purple-700 transition hover:border-purple-300 hover:bg-purple-100"
                      >
                        {tag}
                        <X aria-hidden="true" className="h-3 w-3" />
                        <span className="sr-only"> — remove this tag</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}

              <div className="flex flex-wrap items-start gap-2">
                <Input
                  id="event-tag-input"
                  list="event-tag-suggestions"
                  value={tagDraft}
                  onChange={(event) => setTagDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    // Otherwise Enter submits whatever form this sits inside and the tag is lost with it.
                    event.preventDefault();
                    addTag(tagDraft);
                  }}
                  disabled={atTagLimit}
                  placeholder={atTagLimit ? "That is the most this event holds" : "workshop"}
                  className="min-w-0 flex-1"
                />
                <datalist id="event-tag-suggestions">
                  {tagSuggestions.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={Plus}
                  disabled={atTagLimit || tagDraft.trim().length === 0}
                  onClick={() => addTag(tagDraft)}
                >
                  Add
                </Button>
              </div>

              <p
                className={cn(
                  "mt-1.5 text-xs tabular-nums",
                  atTagLimit ? "text-amber-800" : "text-ink-500"
                )}
              >
                You can add up to {TAG_MAX}; {value.tags.length} added.
                {tagSuggestionsTruncated
                  ? " The suggestions show only the most used tags — typing one that is not offered still works."
                  : ""}
              </p>
            </FieldBlock>
          </FormSection>
        </div>
      </div>

      <SaveBar
        status={autosave.status}
        lastSavedAt={autosave.lastSavedAt}
        onSave={() => void autosave.saveNow()}
        onDiscard={discard}
        error={autosave.error?.message ?? null}
        saveDisabledReason={saveDisabledReason}
        saveLabel={mode === "create" ? "Create this event" : "Save"}
        subject="this event"
        note={
          mode === "create"
            ? "Nothing is saved until you choose Create. It starts as a draft."
            : autosave.retriesExhausted
              ? /*
                  AUTOMATIC SAVING HAS GIVEN UP, and it must say so in the error tone rather than the
                  note's usual grey. `useAutosave` stops retrying after three consecutive failures (its
                  rule 4) and exposes `retriesExhausted` for exactly this sentence. Without the branch
                  the bar goes on claiming the event is "saved on its own a few seconds after you stop
                  typing", which is now false — so an editor keeps typing into a form nothing is storing
                  and then closes the tab. The failure itself is printed above this line, verbatim from
                  the server; this line is the consequence and what to do about it.
                */
                <span className="font-medium text-error-600">
                  Not saving. Your last change was not stored. Press Save to try again.
                </span>
              : isPublic
                ? PUBLISHED_AUTOSAVE_NOTICE
                : `This event is not published, so it is saved on its own a few seconds after you stop typing. Every time is in ${timeZoneLabel}.`
        }
      />

      <MediaPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(assets: StudioMediaAsset[]) => {
          const chosen = assets[0];
          if (!chosen) return;
          setCover(chosen);
          setValue((current) => ({ ...current, coverId: chosen.id }));
          setPickerOpen(false);
        }}
        kind="IMAGE"
        storageReady={storageReady}
        title="Choose a cover photograph"
      />
    </div>
  );
}

/**
 * One date-and-time field, read and written in the Centre's zone, WITH THE ZONE NAMED UNDER IT.
 *
 * The naming is not decoration and it is not optional. `<input type="datetime-local">` has no zone of its
 * own: whatever is typed into it is just numbers, and the only thing that tells the person typing which
 * clock those numbers belong to is this sentence.
 *
 * `Field` (a real `<label>`) is correct here: the control is a plain native input, so there is no button
 * inside for a stray click to be forwarded into.
 */
function ZonedDateTimeField({
  label,
  value,
  timeZone,
  timeZoneLabel,
  onChange,
  error,
  help,
  required = false
}: {
  label: string;
  /** The stored ISO instant, or null. */
  value: string | null;
  timeZone: string;
  timeZoneLabel: string;
  onChange: (next: string | null) => void;
  error?: string | null;
  help?: ReactNode;
  required?: boolean;
}): ReactNode {
  return (
    <Field
      label={label}
      required={required}
      error={error ?? null}
      help={
        <>
          {help ? <>{help} </> : null}
          {/* The zone, in words, beside the field. See the component's header. */}
          <span className="font-medium text-ink-700">
            In {timeZoneLabel} — the Centre&rsquo;s time, not this computer&rsquo;s.
          </span>
        </>
      }
    >
      <Input
        type="datetime-local"
        icon={CalendarClock}
        value={toZonedInput(value, timeZone)}
        onChange={(event) => {
          const raw = event.target.value;
          // A cleared box is "no time", not "the epoch". `fromZonedInput` returns null for anything it
          // cannot read, which includes the half-typed values a date input emits while being edited.
          onChange(raw.trim().length === 0 ? null : fromZonedInput(raw, timeZone));
        }}
      />
    </Field>
  );
}

/**
 * A latitude or a longitude.
 *
 * ⚠ AN EMPTY BOX IS `null`, NEVER 0. `Number("")` is 0 and 0, 0 is a real place in the Gulf of Guinea —
 * the same trap `lib/settings/schema.ts` documents for the Centre's own map pin. A map dropped there is
 * not an obviously wrong answer on a small screenshot, which is what makes it worth a comment.
 */
function CoordinateField({
  label,
  value,
  min,
  max,
  onChange
}: {
  label: string;
  value: number | null;
  min: number;
  max: number;
  onChange: (next: number | null) => void;
}): ReactNode {
  /**
   * THE TEXT IS LOCAL STATE, AND THE NUMBER IS THE PROP.
   *
   * A coordinate is typed one character at a time, and "-", "12." and "-0" are all halfway to a valid
   * number while parsing to something else (or to nothing). Driving the box straight from the number would
   * erase the minus sign the moment it was typed — the field would simply refuse to accept a southern
   * latitude. So the box keeps the characters and the form keeps the number.
   */
  const [text, setText] = useState<string>(() => (value === null ? "" : String(value)));

  const meaning = ((): number | null => {
    const raw = text.trim();
    if (raw.length === 0) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  })();

  /**
   * Re-sync only when the number arriving from outside means something DIFFERENT from what is already
   * typed — a discard, or a revision being restored. Comparing meanings rather than strings is what stops
   * this from fighting the typing: "12." and 12 mean the same thing, so nothing is rewritten.
   */
  useEffect(() => {
    if (meaning === value) return;
    setText(value === null ? "" : String(value));
    // `meaning` is deliberately not a dependency: it changes on every keystroke, and reacting to it would
    // reintroduce exactly the fight this effect exists to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const outOfRange = meaning !== null && (meaning < min || meaning > max);

  return (
    <Field
      label={label}
      error={outOfRange ? `${label} runs from ${min} to ${max}.` : null}
      help={`Leave it empty if you do not have it. From ${min} to ${max}.`}
    >
      <Input
        type="number"
        inputMode="decimal"
        step="any"
        value={text}
        onChange={(event) => {
          const raw = event.target.value;
          setText(raw);
          const trimmed = raw.trim();
          if (trimmed.length === 0) {
            // Empty is NO COORDINATE, never 0 — see the component's header.
            onChange(null);
            return;
          }
          const parsed = Number(trimmed);
          onChange(Number.isFinite(parsed) ? parsed : null);
        }}
        className="font-mono text-xs"
      />
    </Field>
  );
}
