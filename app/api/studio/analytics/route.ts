import type { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { badRequest, ok, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canViewAnalytics } from "@/lib/permissions";
import { getSetting } from "@/lib/settings/service";
import { parseStudioQuery } from "@/lib/studio/crud";

/**
 * Analytics: page views, downloads, and what people searched for.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * SEARCHES THAT FOUND NOTHING ARE A FIRST-CLASS REPORT, AND THEY COME FIRST IN THE ANSWER.
 *
 * `zeroResultQueries` is the only genuinely actionable list on this endpoint. Every line is something
 * somebody expected the Centre to have and did not find: either something to publish, something to rename
 * so it can be found, or a redirect to write. Page-view totals are interesting; that list is work.
 *
 * `hits` is overwritten rather than accumulated by `logSearch()` — its own header explains why: the question
 * is "which searches find nothing NOW", which is a property of the corpus as it stands, not a running total.
 * So a query that stopped returning nothing once something was published drops off this list on its own.
 *
 * ⚠ EVERY DAY IN THE RANGE IS PRESENT, INCLUDING THE ONES WITH NO ROWS. A series built only from the days
 * that have records silently closes the gaps and turns a quiet fortnight into a busy one — the chart would
 * be a different shape from the data. `series` is therefore dense, one entry per day, zeros included.
 *
 * ⚠ THE RANGE IS CAPPED, AND A REQUEST THAT EXCEEDS IT IS ANSWERED RATHER THAN REFUSED. `rangeCapped` says
 * it happened and `from`/`to` in the answer are the range as actually used — a dense series over ten years
 * is 3 650 objects per metric for a question nobody asked precisely, and silently answering a smaller range
 * would be a lie about what the numbers cover.
 *
 * ⚠ "VISITORS" IS AN ESTIMATE AND THE ANSWER SAYS SO. There is no cookie and no visitor identifier of any
 * kind — by design, per the schema — so the same person reading three pages may be counted once or three
 * times. Page views are exact. A client that presented the two with equal confidence would be misleading
 * whoever reports these figures upward.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `canViewAnalytics` — editor and above.
 */

export const dynamic = "force-dynamic";

/** The default window. Long enough to show a shape, short enough to be about now. */
const DEFAULT_DAYS = 30;

/**
 * The longest range one request may cover.
 *
 * Two years of daily buckets is 731 entries per series, which is a few hundred kilobytes of JSON and the
 * outer limit of what any chart can draw. Beyond it the request is answered for the most recent 731 days and
 * `rangeCapped` is set.
 */
const MAX_RANGE_DAYS = 731;

/** Every table's cap, reported alongside its rows so a truncated list is never silent. */
const TOP_PAGES = 20;
const TOP_DOWNLOADS = 15;
const TOP_COUNTRIES = 12;
const TOP_QUERIES = 25;

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC midnight, matching the `@db.Date` columns and the buckets every writer uses. */
function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * `YYYY-MM-DD` → UTC midnight.
 *
 * `new Date("2026-03-01")` is parsed as UTC by the specification, which is what makes a date range mean the
 * same thing wherever the server is running. The shape is checked first, because `new Date("last tuesday")`
 * is an Invalid Date and `new Date("2026")` is a valid one nobody meant.
 */
function parseDay(value: string | undefined): Date | null {
  if (!value || value.trim().length === 0) return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const RangeQuery = z.object({
  from: z.string().trim().max(24).optional(),
  to: z.string().trim().max(24).optional()
});

export const GET = route(async (request: NextRequest) => {
  await requireCapability(
    canViewAnalytics,
    "Analytics needs editor access or higher. An administrator can raise yours."
  );

  const query = parseStudioQuery(request, RangeQuery);

  if ((query.from && !parseDay(query.from)) || (query.to && !parseDay(query.to))) {
    throw badRequest("A date has to be written as YYYY-MM-DD, for example 2026-03-04.");
  }

  const today = utcDay(new Date());
  const requestedTo = parseDay(query.to) ?? today;
  const requestedFrom = parseDay(query.from) ?? new Date(requestedTo.getTime() - (DEFAULT_DAYS - 1) * DAY_MS);

  /**
   * A transposed range is a typo, not a request for nothing — swapped rather than refused, and said out loud.
   * An empty answer with no explanation is the least useful possible response to a mistyped date.
   */
  const swapped = requestedFrom.getTime() > requestedTo.getTime();
  const [orderedFrom, orderedTo] = swapped ? [requestedTo, requestedFrom] : [requestedFrom, requestedTo];

  const requestedDays = Math.floor((orderedTo.getTime() - orderedFrom.getTime()) / DAY_MS) + 1;
  const rangeCapped = requestedDays > MAX_RANGE_DAYS;
  // Capped from the RECENT end: an operator who asked for ten years wants this decade's shape, not 2016's.
  const from = rangeCapped ? new Date(orderedTo.getTime() - (MAX_RANGE_DAYS - 1) * DAY_MS) : orderedFrom;
  const to = orderedTo;

  const viewWhere: Prisma.PageViewDailyWhereInput = { day: { gte: from, lte: to } };
  const downloadWhere: Prisma.DownloadEventWhereInput = { day: { gte: from, lte: to } };
  const searchWhere: Prisma.SearchQueryLogWhereInput = { day: { gte: from, lte: to } };

  const [byDay, byPath, byCountry, downloads, searchTotals, zeroResult, topQueries] =
    await prisma.$transaction([
      prisma.pageViewDaily.groupBy({
        by: ["day"],
        where: viewWhere,
        _sum: { views: true, uniques: true },
        orderBy: { day: "asc" }
      }),
      prisma.pageViewDaily.groupBy({
        by: ["path"],
        where: viewWhere,
        _sum: { views: true, uniques: true },
        orderBy: { _sum: { views: "desc" } },
        take: TOP_PAGES
      }),
      prisma.pageViewDaily.groupBy({
        by: ["country"],
        where: viewWhere,
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
      /** ⚠ THE REPORT THIS ENDPOINT EXISTS FOR. See the header. */
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

  /**
   * Titles for what was downloaded. A list of ids is not a report.
   *
   * A row whose file has since been deleted keeps its downloads — the count happened — so the title is null
   * rather than the row being dropped, and the client says the record has gone.
   */
  const fileIds = downloads.filter((row) => row.entityType === "file").map((row) => row.entityId);
  const fileTitles = new Map<string, string>();
  if (fileIds.length > 0) {
    const rows = await prisma.fileAsset.findMany({
      where: { id: { in: fileIds } },
      select: { id: true, title: true }
    });
    for (const row of rows) fileTitles.set(row.id, row.title);
  }

  // ── The dense day series ────────────────────────────────────────────────────────────────────────
  const viewsByDay = new Map<string, number>();
  const uniquesByDay = new Map<string, number>();
  for (const row of byDay) {
    viewsByDay.set(dayKey(row.day), row._sum?.views ?? 0);
    uniquesByDay.set(dayKey(row.day), row._sum?.uniques ?? 0);
  }

  const series: { day: string; views: number; uniques: number }[] = [];
  for (let time = from.getTime(); time <= to.getTime(); time += DAY_MS) {
    const key = dayKey(new Date(time));
    // ⚠ ZEROS INCLUDED. See the header: a sparse series is a different shape from the data.
    series.push({ day: key, views: viewsByDay.get(key) ?? 0, uniques: uniquesByDay.get(key) ?? 0 });
  }

  const totalViews = series.reduce((sum, entry) => sum + entry.views, 0);
  const totalUniques = series.reduce((sum, entry) => sum + entry.uniques, 0);
  const totalDownloads = downloads.reduce((sum, row) => sum + (row._sum?.count ?? 0), 0);
  const totalSearches = searchTotals._sum?.count ?? 0;
  const totalZeroResult = zeroResult.reduce((sum, row) => sum + (row._sum?.count ?? 0), 0);

  /**
   * Whether counting is switched on at all.
   *
   * Worth answering rather than leaving the reader to infer it: an inbox of zeros looks like a quiet
   * fortnight, and the difference between that and "nothing has been recorded since somebody turned it off"
   * is a month of reporting nobody can explain.
   */
  const features = await getSetting("features");

  return ok({
    range: {
      from: dayKey(from),
      to: dayKey(to),
      days: series.length,
      /** ⚠ Both of these must be printed where they are true (contract §1.6). */
      rangeCapped,
      maxRangeDays: MAX_RANGE_DAYS,
      requestedDays,
      datesSwapped: swapped
    },
    totals: {
      views: totalViews,
      /** An ESTIMATE. There is no visitor identifier, so this cannot be exact — see the header. */
      uniques: totalUniques,
      uniquesIsEstimate: true,
      downloads: totalDownloads,
      searches: totalSearches,
      searchesWithNoResults: totalZeroResult
    },
    series,
    /** First in the object as well as first in importance. */
    zeroResultQueries: zeroResult.map((row) => ({ query: row.query, count: row._sum?.count ?? 0 })),
    zeroResultTruncated: zeroResult.length >= TOP_QUERIES,
    topQueries: topQueries.map((row) => ({ query: row.query, count: row._sum?.count ?? 0 })),
    topQueriesTruncated: topQueries.length >= TOP_QUERIES,
    topPages: byPath.map((row) => ({
      path: row.path,
      views: row._sum?.views ?? 0,
      uniques: row._sum?.uniques ?? 0
    })),
    topPagesTruncated: byPath.length >= TOP_PAGES,
    topDownloads: downloads.map((row) => ({
      entityType: row.entityType,
      entityId: row.entityId,
      title: fileTitles.get(row.entityId) ?? null,
      count: row._sum?.count ?? 0
    })),
    topDownloadsTruncated: downloads.length >= TOP_DOWNLOADS,
    countries: byCountry.map((row) => ({ country: row.country, views: row._sum?.views ?? 0 })),
    countriesTruncated: byCountry.length >= TOP_COUNTRIES,
    limits: {
      topPages: TOP_PAGES,
      topDownloads: TOP_DOWNLOADS,
      countries: TOP_COUNTRIES,
      queries: TOP_QUERIES
    },
    countingEnabled: features.analytics,
    note:
      "One row per day, per page, per country — a count and nothing else. No cookie is set and no visitor " +
      "identifier of any kind is stored, so “visitors” is an estimate of separate people rather than a count " +
      "of them. Page views are exact." +
      (features.analytics
        ? ""
        : " Counting is switched off in Settings → Features, so nothing new is being recorded — everything " +
          "here is what was recorded before it was switched off.") +
      (rangeCapped
        ? ` The range asked for was ${requestedDays} days; this answer covers the most recent ${MAX_RANGE_DAYS}.`
        : "")
  });
});
