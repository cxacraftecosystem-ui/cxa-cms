import type { Metadata } from "next";
import Link from "next/link";
import { CircleCheck, Download, Eye, Globe, Search, SearchX, Users } from "lucide-react";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { requireStudioCapability } from "@/lib/auth/current-user";
import { canViewAnalytics } from "@/lib/permissions";
import { getSettingCached } from "@/lib/settings/service";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";

/**
 * Analytics — how many people read each page, what they downloaded, and what they looked for and did not
 * find.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canViewAnalytics)` IS THE FIRST STATEMENT — editor and above.
 *
 * THE MOST USEFUL REPORT ON THIS SCREEN IS "SEARCHES THAT FOUND NOTHING", and it is placed first for that
 * reason. It is a list of what people expected the Centre to have and did not find: every line is either
 * something to publish, something to rename, or a redirect to write. Page-view totals are interesting;
 * that list is actionable.
 *
 * THE CHARTS ARE INLINE SVG. No charting library is installed and none may be added (contract §13), which
 * turns out to suit the data: these are day-bucketed counts, so a bar per day is the honest form and
 * needs no library. Each chart has:
 *
 *   • ONE SERIES AND ONE AXIS. Page views and visitors are two charts, never two scales on one — a
 *     dual-axis chart lets the reader infer a relationship the numbers do not support. With one series
 *     there is no legend, because the title already names it.
 *   • EVERY DAY IN THE RANGE, including the days with no rows. A series built only from the days that have
 *     records silently closes the gaps and turns a quiet fortnight into a busy one.
 *   • A TABLE OF THE SAME NUMBERS, behind a disclosure. An SVG is not readable by a screen reader however
 *     it is labelled, and the table is also how somebody copies the figures into a report.
 *   • ONE DIRECT LABEL — the busiest day — rather than a number on every bar. Thirty numbers over thirty
 *     bars is thirty things to read and no shape to see.
 *
 * THE COLLECTION POLICY IS STATED ON THE SCREEN, not buried in a policy page. What is collected is a day, a
 * path and a country code; there is no cookie and no visitor identifier of any kind, which means "visitors"
 * is an estimate and this screen says so rather than implying a precision the data cannot carry.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Analytics"
};

/** The default window. Thirty days is long enough to show a shape and short enough to be about now. */
const DEFAULT_DAYS = 30;

/**
 * How many days one chart will draw.
 *
 * Past this the bars are thinner than a hairline and the chart stops being readable. A longer range is
 * still SUMMARISED in full — only the chart is trimmed, and it says so on screen (contract §1.6).
 */
const MAX_CHART_DAYS = 120;

/** How many rows each table shows. Every one of these caps is stated where it bites. */
const TOP_PAGES = 20;
const TOP_DOWNLOADS = 15;
const TOP_COUNTRIES = 12;
const TOP_QUERIES = 25;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Dates
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** UTC midnight for a day, matching the `@db.Date` columns and the day buckets the writers use. */
function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** `YYYY-MM-DD` → UTC midnight. `new Date("2026-03-01")` is parsed as UTC by the specification. */
function parseDay(value: string): Date | null {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDayInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Every day from `from` to `to` inclusive. The spine of every chart — see the header. */
function dayRange(from: Date, to: Date): Date[] {
  const days: Date[] = [];
  const step = 24 * 60 * 60 * 1000;
  for (let time = from.getTime(); time <= to.getTime(); time += step) {
    days.push(new Date(time));
  }
  return days;
}

function shortDay(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

function longDay(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  });
}

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/** Two-letter codes are what the writers store; the names are for reading. Unknown codes pass through. */
const COUNTRY_NAMES: Record<string, string> = {
  IN: "India",
  US: "United States",
  GB: "United Kingdom",
  DE: "Germany",
  FR: "France",
  NL: "Netherlands",
  JP: "Japan",
  CN: "China",
  AU: "Australia",
  CA: "Canada",
  SG: "Singapore",
  AE: "United Arab Emirates",
  BD: "Bangladesh",
  LK: "Sri Lanka",
  NP: "Nepal",
  PK: "Pakistan",
  IT: "Italy",
  ES: "Spain",
  SE: "Sweden",
  BR: "Brazil"
};

function countryName(code: string | null): string {
  if (!code) return "Not recorded";
  return COUNTRY_NAMES[code] ?? code;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The chart
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The plotting box, in user units. The SVG scales to its container; these are ratios, not pixels. */
const CHART_WIDTH = 760;
const CHART_HEIGHT = 170;
const PLOT_TOP = 18;
const PLOT_BOTTOM = 146;
const PLOT_LEFT = 4;
const PLOT_RIGHT = 756;
/** The surface gap between adjacent bars. Two units, per the mark spec. */
const BAR_GAP = 2;

/**
 * One bar, anchored to the baseline with its top corners rounded.
 *
 * A plain `<rect rx>` rounds all four corners, which lifts the bar off its own axis and makes a short bar
 * read as a lozenge. The radius is clamped to half the width so a one-unit-wide bar is not a circle.
 */
function barPath(x: number, y: number, width: number, height: number): string {
  const radius = Math.min(3, width / 2, height);
  if (height <= 0) return "";
  if (radius <= 0.5) return `M${x} ${y}h${width}v${height}h${-width}Z`;
  return [
    `M${x} ${y + radius}`,
    `a${radius} ${radius} 0 0 1 ${radius} ${-radius}`,
    `h${width - radius * 2}`,
    `a${radius} ${radius} 0 0 1 ${radius} ${radius}`,
    `v${height - radius}`,
    `h${-width}`,
    "Z"
  ].join(" ");
}

interface DayBarsProps {
  /** Names the series. With one series this replaces a legend entirely. */
  title: string;
  /** The singular and plural noun for a value: "page view" / "page views". */
  noun: { one: string; many: string };
  days: readonly Date[];
  values: readonly number[];
  /** True when the range was longer than the chart draws. Said out loud beneath it. */
  trimmed: boolean;
  /** How many days the whole range covers, for the trimming sentence. */
  totalDays: number;
}

function DayBars({ title, noun, days, values, trimmed, totalDays }: DayBarsProps) {
  const total = values.reduce((sum, value) => sum + value, 0);
  const max = values.reduce((highest, value) => Math.max(highest, value), 0);
  const peakIndex = values.findIndex((value) => value === max && max > 0);
  const peakDay = peakIndex === -1 ? null : days[peakIndex];

  const plotWidth = PLOT_RIGHT - PLOT_LEFT;
  const plotHeight = PLOT_BOTTOM - PLOT_TOP;
  const slot = days.length > 0 ? plotWidth / days.length : plotWidth;
  const barWidth = Math.max(1, slot - BAR_GAP);

  const firstDay = days[0];
  const lastDay = days[days.length - 1];

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm font-medium text-ink-900">{title}</p>
        <p className="text-sm tabular-nums text-ink-500">
          <span className="font-semibold text-ink-900">{total.toLocaleString("en-GB")}</span>{" "}
          {total === 1 ? noun.one : noun.many} in this range
        </p>
      </div>

      {max === 0 ? (
        <p className="mt-3 rounded-md border border-dashed border-line-200 bg-surface-50 px-3 py-6 text-center text-sm text-ink-500">
          Nothing was recorded on any day in this range.
        </p>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            // `role="img"` plus a label that states the shape, because an SVG is not readable by a screen
            // reader however carefully it is drawn. The table below is the real alternative.
            role="img"
            aria-label={`${title}: ${total.toLocaleString("en-GB")} ${
              total === 1 ? noun.one : noun.many
            } across ${days.length} days${
              peakDay ? `, with the most on ${longDay(peakDay)} at ${max.toLocaleString("en-GB")}` : ""
            }.`}
            className="mt-3 h-44 w-full"
            preserveAspectRatio="none"
          >
            {/* RECESSIVE GRID. Three lines only — nothing, half, and the peak — drawn in the themed line
                colour rather than a hardcoded neutral, so they invert with the theme. */}
            <g className="text-line-200" stroke="currentColor" strokeWidth="1">
              <line x1={PLOT_LEFT} y1={PLOT_BOTTOM} x2={PLOT_RIGHT} y2={PLOT_BOTTOM} />
              <line
                x1={PLOT_LEFT}
                y1={PLOT_TOP + plotHeight / 2}
                x2={PLOT_RIGHT}
                y2={PLOT_TOP + plotHeight / 2}
                strokeDasharray="3 4"
              />
              <line x1={PLOT_LEFT} y1={PLOT_TOP} x2={PLOT_RIGHT} y2={PLOT_TOP} strokeDasharray="3 4" />
            </g>

            {/* THE ONE SERIES, in the single action colour. `currentColor` from a themed class rather than a
                hex, so it is the same purple as every other affordance in the studio. */}
            <g className="text-purple-700" fill="currentColor">
              {values.map((value, index) => {
                const day = days[index];
                if (!day) return null;
                const height = max > 0 ? (value / max) * plotHeight : 0;
                const x = PLOT_LEFT + index * slot + BAR_GAP / 2;
                const y = PLOT_BOTTOM - height;
                if (height <= 0) return null;
                return (
                  <path key={day.toISOString()} d={barPath(x, y, barWidth, height)}>
                    {/* The hover layer, with no JavaScript: a native tooltip that assistive technology also
                        reads. A crosshair would need a client component and would buy nothing here. */}
                    <title>{`${longDay(day)}: ${value.toLocaleString("en-GB")} ${
                      value === 1 ? noun.one : noun.many
                    }`}</title>
                  </path>
                );
              })}
            </g>

            {/* ONE direct label — the peak. A number over every bar is thirty things to read. */}
            <text
              x={PLOT_LEFT}
              y={PLOT_TOP - 6}
              className="fill-ink-500"
              fontSize="11"
              // Not the series colour: values wear text tokens, and the bar beside them carries identity.
            >
              {max.toLocaleString("en-GB")}
            </text>

            {firstDay ? (
              <text x={PLOT_LEFT} y={CHART_HEIGHT - 4} className="fill-ink-500" fontSize="11">
                {shortDay(firstDay)}
              </text>
            ) : null}
            {lastDay && days.length > 1 ? (
              <text
                x={PLOT_RIGHT}
                y={CHART_HEIGHT - 4}
                textAnchor="end"
                className="fill-ink-500"
                fontSize="11"
              >
                {shortDay(lastDay)}
              </text>
            ) : null}
          </svg>

          {trimmed ? (
            <HelpText>
              The chart draws the most recent {MAX_CHART_DAYS} days of a {totalDays}-day range, because
              beyond that the bars are too thin to read. The totals and the tables below cover the whole
              range.
            </HelpText>
          ) : null}

          <details className="mt-2">
            <summary className="cursor-pointer rounded text-xs font-medium text-purple-700 transition hover:text-purple-800">
              Show these numbers as a table
            </summary>
            <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-line-200">
              <table className="w-full border-collapse text-xs">
                <caption className="sr-only">{title}, day by day</caption>
                <thead>
                  <tr>
                    <th scope="col" className="border-b border-line-200 bg-surface-50 px-2.5 py-1.5 text-left font-semibold text-ink-500">
                      Day
                    </th>
                    <th scope="col" className="border-b border-line-200 bg-surface-50 px-2.5 py-1.5 text-right font-semibold text-ink-500">
                      {noun.many.charAt(0).toUpperCase() + noun.many.slice(1)}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((day, index) => (
                    <tr key={day.toISOString()} className="border-b border-line-200 last:border-b-0">
                      <td className="px-2.5 py-1 text-ink-700">{longDay(day)}</td>
                      <td className="px-2.5 py-1 text-right tabular-nums text-ink-900">
                        {(values[index] ?? 0).toLocaleString("en-GB")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A stat tile
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A headline number.
 *
 * A single number is not a chart and must not be drawn as one: there is nothing to compare it to inside
 * itself. The tile states the number, what it counts, and — where the number is an estimate — that it is.
 */
function Stat({
  label,
  value,
  note,
  icon: Icon
}: {
  label: string;
  value: number;
  note?: string;
  icon: typeof Eye;
}) {
  return (
    <div className="panel px-4 py-3.5">
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink-500">
        <Icon aria-hidden="true" className="h-3.5 w-3.5" />
        {label}
      </p>
      <p className="mt-1.5 font-display text-2xl font-bold tabular-nums text-ink-900">
        {value.toLocaleString("en-GB")}
      </p>
      {note ? <p className="mt-1 text-xs leading-relaxed text-ink-500">{note}</p> : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The screen
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export default async function StudioAnalyticsPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireStudioCapability(
    canViewAnalytics,
    "Analytics needs editor access or higher. An administrator can raise yours."
  );

  const params = await searchParams;
  const today = utcDay(new Date());

  const requestedTo = parseDay(first(params.to));
  const requestedFrom = parseDay(first(params.from));

  const to = requestedTo ?? today;
  const from =
    requestedFrom ?? new Date(to.getTime() - (DEFAULT_DAYS - 1) * 24 * 60 * 60 * 1000);

  // A transposed range is a typo, not a request for nothing: swapped rather than refused, because an empty
  // screen with no explanation is the least useful possible answer.
  const [rangeFrom, rangeTo] = from.getTime() <= to.getTime() ? [from, to] : [to, from];

  const where: Prisma.PageViewDailyWhereInput = { day: { gte: rangeFrom, lte: rangeTo } };
  const downloadWhere: Prisma.DownloadEventWhereInput = { day: { gte: rangeFrom, lte: rangeTo } };
  const searchWhere: Prisma.SearchQueryLogWhereInput = { day: { gte: rangeFrom, lte: rangeTo } };

  const [
    byDay,
    byPath,
    byCountry,
    downloadTotals,
    searchTotals,
    zeroResultQueries,
    topQueries
  ] = await prisma.$transaction([
    prisma.pageViewDaily.groupBy({
      by: ["day"],
      where,
      _sum: { views: true, uniques: true },
      orderBy: { day: "asc" }
    }),
    prisma.pageViewDaily.groupBy({
      by: ["path"],
      where,
      _sum: { views: true, uniques: true },
      orderBy: { _sum: { views: "desc" } },
      take: TOP_PAGES
    }),
    prisma.pageViewDaily.groupBy({
      by: ["country"],
      where,
      _sum: { views: true },
      orderBy: { _sum: { views: "desc" } },
      take: TOP_COUNTRIES
    }),
    prisma.downloadEvent.groupBy({
      by: ["entityType", "entityId"],
      where: downloadWhere,
      _sum: { count: true },
      orderBy: { _sum: { count: "desc" } },
      take: TOP_DOWNLOADS
    }),
    prisma.searchQueryLog.aggregate({ where: searchWhere, _sum: { count: true } }),
    /**
     * THE MOST ACTIONABLE REPORT ON THE SCREEN. `hits: 0` is a search that returned nothing: somebody
     * expected the Centre to have this and it was not there, or it was there under another name.
     */
    prisma.searchQueryLog.groupBy({
      by: ["query"],
      where: { ...searchWhere, hits: 0 },
      _sum: { count: true },
      orderBy: { _sum: { count: "desc" } },
      take: TOP_QUERIES
    }),
    prisma.searchQueryLog.groupBy({
      by: ["query"],
      where: { ...searchWhere, hits: { gt: 0 } },
      _sum: { count: true },
      orderBy: { _sum: { count: "desc" } },
      take: TOP_QUERIES
    })
  ]);

  /** Titles for the things that were downloaded. A list of ids is not a report. */
  const fileIds = downloadTotals
    .filter((row) => row.entityType === "file")
    .map((row) => row.entityId);
  const fileTitles = new Map<string, string>();
  if (fileIds.length > 0) {
    const rows = await prisma.fileAsset.findMany({
      where: { id: { in: fileIds } },
      select: { id: true, title: true, slug: true }
    });
    for (const row of rows) fileTitles.set(row.id, row.title);
  }

  const features = await getSettingCached("features");

  // ── The day series, with every day present ──────────────────────────────────────────────────
  const allDays = dayRange(rangeFrom, rangeTo);
  const viewsByDay = new Map<string, number>();
  const uniquesByDay = new Map<string, number>();
  for (const row of byDay) {
    const key = toDayInput(row.day);
    viewsByDay.set(key, row._sum?.views ?? 0);
    uniquesByDay.set(key, row._sum?.uniques ?? 0);
  }

  const totalViews = allDays.reduce((sum, day) => sum + (viewsByDay.get(toDayInput(day)) ?? 0), 0);
  const totalUniques = allDays.reduce((sum, day) => sum + (uniquesByDay.get(toDayInput(day)) ?? 0), 0);
  const totalDownloads = downloadTotals.reduce((sum, row) => sum + (row._sum?.count ?? 0), 0);
  const totalSearches = searchTotals._sum?.count ?? 0;
  const totalZeroResult = zeroResultQueries.reduce((sum, row) => sum + (row._sum?.count ?? 0), 0);

  const chartDays = allDays.slice(-MAX_CHART_DAYS);
  const trimmed = allDays.length > MAX_CHART_DAYS;
  const chartViews = chartDays.map((day) => viewsByDay.get(toDayInput(day)) ?? 0);
  const chartUniques = chartDays.map((day) => uniquesByDay.get(toDayInput(day)) ?? 0);

  /** The presets, as links, so a chosen range is a place in the URL somebody can send. */
  const presets = [7, 30, 90, 365].map((days) => {
    const start = new Date(today.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
    return {
      days,
      href: `/studio/analytics?from=${toDayInput(start)}&to=${toDayInput(today)}`,
      active: allDays.length === days && toDayInput(rangeTo) === toDayInput(today)
    };
  });

  const maxPathViews = byPath.reduce((highest, row) => Math.max(highest, row._sum?.views ?? 0), 0);
  const maxCountryViews = byCountry.reduce((highest, row) => Math.max(highest, row._sum?.views ?? 0), 0);

  return (
    <div className="mx-auto w-full max-w-[84rem] space-y-6">
      <StudioPageHeader
        title="Analytics"
        description="How many people read each page, what they downloaded, and what they searched for. Counted on this site itself — nothing is sent to anybody else."
        meta={
          <span className="text-xs text-ink-500">
            {longDay(rangeFrom)} to {longDay(rangeTo)}
          </span>
        }
      />

      {/*
        THE COLLECTION POLICY, ON THE SCREEN. Somebody reading these numbers has to know what they are and
        are not: without a visitor identifier, "visitors" is an estimate, and saying so is the difference
        between a useful figure and a misleading one.
      */}
      <div className="panel px-4 py-3.5">
        <p className="flex items-start gap-2 text-sm font-semibold text-ink-900">
          <CircleCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success-600" />
          <span>What is counted, and what is not</span>
        </p>
        <p className="prose-measure mt-1.5 text-sm leading-relaxed text-ink-700">
          One row per day, per page, per country — a count and nothing else. No cookie is set, no visitor
          identifier of any kind is stored, and nothing is shared with another company. Because there is no
          identifier, “visitors” is an estimate of separate people rather than a count of them: the same
          person reading three pages may be counted once or three times. Page views are exact.
        </p>
        {!features.analytics ? (
          <p className="mt-2 text-sm leading-relaxed text-amber-800">
            Counting is currently switched off in Settings → Features, so nothing new is being recorded.
            Everything below is what was recorded before it was switched off.
          </p>
        ) : null}
      </div>

      {/* ── The range ─────────────────────────────────────────────────────────────────────── */}
      <FormSection
        title="Dates"
        description="Everything on this screen covers the range you choose here, and the range is part of the address — so a report can be sent to somebody exactly as you are looking at it."
      >
        <div className="flex flex-wrap gap-2">
          {presets.map((preset) => (
            <Link
              key={preset.days}
              href={preset.href}
              className={cn(
                "inline-flex min-h-8 items-center rounded-md border px-3 py-1 text-xs font-medium transition",
                preset.active
                  ? "border-purple-700 bg-purple-700 text-white"
                  : "border-line-200 bg-card text-ink-700 hover:border-purple-300 hover:bg-purple-50"
              )}
              aria-current={preset.active ? "page" : undefined}
            >
              {preset.days === 365 ? "Last year" : `Last ${preset.days} days`}
            </Link>
          ))}
        </div>

        {/* A GET form: no JavaScript, and the URL is the state. */}
        <form method="get" className="flex flex-wrap items-end gap-3">
          {/* `Field` (a real `<label>`) is right for both: each control is a plain `<input>`. */}
          <Field label="From" help="Read as UTC, which is how the counts are bucketed.">
            <Input name="from" type="date" defaultValue={toDayInput(rangeFrom)} max={toDayInput(today)} />
          </Field>
          <Field label="To">
            <Input name="to" type="date" defaultValue={toDayInput(rangeTo)} max={toDayInput(today)} />
          </Field>
          <Button type="submit" variant="secondary">
            Show this range
          </Button>
        </form>

        {requestedFrom && requestedTo && requestedFrom.getTime() > requestedTo.getTime() ? (
          <HelpText tone="warn">
            The two dates were the wrong way round, so they have been swapped. This is{" "}
            {longDay(rangeFrom)} to {longDay(rangeTo)}.
          </HelpText>
        ) : null}
      </FormSection>

      {/* ── The headline numbers ──────────────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Stat label="Page views" value={totalViews} icon={Eye} />
        <Stat
          label="Visitors"
          value={totalUniques}
          note="An estimate. There is no visitor identifier, so this cannot be exact."
          icon={Users}
        />
        <Stat label="Downloads" value={totalDownloads} icon={Download} />
        <Stat label="Searches" value={totalSearches} icon={Search} />
        <Stat
          label="Searches with no results"
          value={totalZeroResult}
          note="Each one is something somebody expected to find. The list is below."
          icon={SearchX}
        />
      </div>

      {/* ── Searches that found nothing: first, because it is the one to act on ───────────── */}
      <FormSection
        title="Searches that found nothing"
        description="What people typed into the search box and got no results for. Every line is either something to publish, something to rename so it can be found, or a redirect to write."
      >
        {zeroResultQueries.length === 0 ? (
          <p className="flex items-start gap-2 text-sm leading-relaxed text-success-600">
            <CircleCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Every search in this range found something. That is either very good or a sign that nobody is
              searching — the total above says which.
            </span>
          </p>
        ) : (
          <>
            <ol className="divide-y divide-line-200 rounded-md border border-line-200">
              {zeroResultQueries.map((row) => (
                <li key={row.query} className="flex items-center justify-between gap-4 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-900">“{row.query}”</span>
                  <span className="shrink-0 text-xs tabular-nums text-ink-500">
                    {(row._sum?.count ?? 0).toLocaleString("en-GB")}{" "}
                    {(row._sum?.count ?? 0) === 1 ? "time" : "times"}
                  </span>
                  {/* Straight to a search for the same words, so the reader can see what a visitor saw. */}
                  <Link
                    href={`/search?q=${encodeURIComponent(row.query)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-xs font-medium text-purple-700 underline-offset-4 transition hover:underline"
                  >
                    Try it
                    <span className="sr-only"> (opens in a new tab)</span>
                  </Link>
                </li>
              ))}
            </ol>
            {zeroResultQueries.length >= TOP_QUERIES ? (
              <HelpText>
                Showing the {TOP_QUERIES} most-repeated of these. There are more — narrow the date range to
                see a different set.
              </HelpText>
            ) : null}
          </>
        )}
      </FormSection>

      {/* ── Over time ─────────────────────────────────────────────────────────────────────── */}
      <FormSection
        title="Over time"
        description="Two charts rather than two lines on one: page views and visitors are counted differently, and putting them on one axis would invite a comparison the numbers do not support."
      >
        <DayBars
          title="Page views per day"
          noun={{ one: "page view", many: "page views" }}
          days={chartDays}
          values={chartViews}
          trimmed={trimmed}
          totalDays={allDays.length}
        />
        <DayBars
          title="Visitors per day (estimated)"
          noun={{ one: "visitor", many: "visitors" }}
          days={chartDays}
          values={chartUniques}
          trimmed={trimmed}
          totalDays={allDays.length}
        />
      </FormSection>

      {/* ── Top pages ─────────────────────────────────────────────────────────────────────── */}
      <FormSection title="Most-read pages" description="Across the whole range, busiest first.">
        {byPath.length === 0 ? (
          <EmptyState
            icon={Eye}
            headingLevel={3}
            title="No page views were recorded in this range"
            description="Either nothing was visited, or counting was switched off for these days."
          />
        ) : (
          <ol className="space-y-1.5">
            {byPath.map((row) => {
              const views = row._sum?.views ?? 0;
              const share = maxPathViews > 0 ? Math.round((views / maxPathViews) * 100) : 0;
              return (
                <li key={row.path} className="min-w-0">
                  <div className="flex items-baseline justify-between gap-4">
                    <Link
                      href={row.path}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="min-w-0 flex-1 truncate font-mono text-xs text-ink-900 underline-offset-4 transition hover:text-purple-700 hover:underline"
                    >
                      {row.path}
                      <span className="sr-only"> (opens in a new tab)</span>
                    </Link>
                    <span className="shrink-0 text-xs tabular-nums text-ink-500">
                      {views.toLocaleString("en-GB")}
                    </span>
                  </div>
                  {/*
                    A bar per row rather than a chart: the comparison is one-dimensional and a reader scans
                    down it. One colour, the action colour, and the number is beside it in text — the bar
                    is a shape, not the information (contract §11).
                  */}
                  <div
                    aria-hidden="true"
                    className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-200"
                  >
                    <div className="h-full rounded-full bg-purple-700" style={{ width: `${share}%` }} />
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {byPath.length >= TOP_PAGES ? (
          <HelpText>
            Showing the {TOP_PAGES} busiest pages. There are more in the range — this list is capped so it
            stays readable.
          </HelpText>
        ) : null}
      </FormSection>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ── Downloads ────────────────────────────────────────────────────────────────────── */}
        <FormSection
          title="Most-downloaded files"
          description="Counted when somebody actually starts a download, not when they open the page it is on."
        >
          {downloadTotals.length === 0 ? (
            <p className="text-sm text-ink-500">Nothing was downloaded in this range.</p>
          ) : (
            <ol className="divide-y divide-line-200 rounded-md border border-line-200">
              {downloadTotals.map((row) => (
                <li
                  key={`${row.entityType}-${row.entityId}`}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink-900">
                      {fileTitles.get(row.entityId) ??
                        `A ${row.entityType} that has since been deleted`}
                    </span>
                    {fileTitles.has(row.entityId) ? (
                      <Link
                        href={`/studio/files/${row.entityId}`}
                        className="text-xs text-purple-700 underline-offset-4 transition hover:underline"
                      >
                        Open it in the file store
                      </Link>
                    ) : (
                      <span className="text-xs text-ink-500">
                        The record has gone, but its downloads are still counted here.
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-ink-500">
                    {(row._sum?.count ?? 0).toLocaleString("en-GB")}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </FormSection>

        {/* ── Countries ────────────────────────────────────────────────────────────────────── */}
        <FormSection
          title="Where people are"
          description="From the country code the network reports. Nothing narrower than a country is recorded."
        >
          {byCountry.length === 0 ? (
            <p className="text-sm text-ink-500">No countries were recorded in this range.</p>
          ) : (
            <ol className="space-y-1.5">
              {byCountry.map((row) => {
                const views = row._sum?.views ?? 0;
                const share = maxCountryViews > 0 ? Math.round((views / maxCountryViews) * 100) : 0;
                return (
                  <li key={row.country ?? "unknown"} className="min-w-0">
                    <div className="flex items-baseline justify-between gap-4">
                      <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm text-ink-900">
                        <Globe aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-ink-300" />
                        {countryName(row.country)}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-ink-500">
                        {views.toLocaleString("en-GB")}
                      </span>
                    </div>
                    <div
                      aria-hidden="true"
                      className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-200"
                    >
                      <div className="h-full rounded-full bg-purple-700" style={{ width: `${share}%` }} />
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </FormSection>
      </div>

      {/* ── Searches that worked ──────────────────────────────────────────────────────────── */}
      <FormSection
        title="Searches that found something"
        description="What people are looking for and getting. Useful for deciding what belongs on the homepage."
      >
        {topQueries.length === 0 ? (
          <p className="text-sm text-ink-500">No successful searches were recorded in this range.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {topQueries.map((row) => (
              <li
                key={row.query}
                className="inline-flex items-center gap-1.5 rounded-full border border-line-200 bg-surface-50 px-3 py-1 text-xs text-ink-700"
              >
                <span>“{row.query}”</span>
                <span className="tabular-nums text-ink-500">
                  {(row._sum?.count ?? 0).toLocaleString("en-GB")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </FormSection>
    </div>
  );
}

