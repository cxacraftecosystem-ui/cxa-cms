/**
 * /craft-explorer — the archive interface.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A SERVER COMPONENT. It reads Prisma directly and hands plain data to three client components: the
 * filter row, the period scrubber and the two panes. Nothing on this page fetches its own API over
 * HTTP, and the whole listing is in the HTML — which is what makes a filtered view crawlable, and what
 * lets a reader with no JavaScript still read the archive (they simply cannot change the filters).
 *
 * ORDINALS ARE DERIVED FROM ARRAY ORDER, HERE. The order below is total and stable (region, then name,
 * then slug — and `slug` is unique, so no two requests can disagree), which is what makes "3 · Bagru"
 * mean the same thing in the list and on the map. An unstable sort would renumber the archive between
 * two renders and look like data changing.
 *
 * EVERY CAP AND EVERY OMISSION IS COUNTED AND PRINTED (contract §1.6):
 *
 *   • the list stops at LIST_LIMIT, and the total that matched is named beside it;
 *   • the filter option lists stop at MAX_FACET_OPTIONS, and are built from a scan that itself stops
 *     at FACET_SCAN — both stated when they bite;
 *   • crafts with no coordinates are not on the map, and the count is printed by the panes;
 *   • crafts with no origin year drop out whenever the timeline is narrowed, and the scrubber says how
 *     many and why.
 *
 * In an archive these are not pedantry: "we have nothing from Rajasthan" and "we have not recorded
 * where these are" are very different claims to make on the Centre's behalf.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE FACETS ARE BUILT FROM THE PUBLISHED CORPUS, NOT FROM THE FILTERED ROWS. A facet list built from
 * what is on screen can only ever offer what is already selected.
 *
 * MATERIALS AND TECHNIQUES ARE SLUGGED FOR THE URL AND MAPPED BACK TO THEIR STORED SPELLINGS HERE.
 * They are free text on `Craft`, so "Indigo" and "indigo" are two values meaning one material; slugging
 * merges them for the reader and the map back to every raw spelling is what makes the merged chip
 * actually match both rows.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ENTRANCE IS ON THE FRAME, AND NOWHERE NEAR THE RESULTS.
 *
 * The control column — the filter row, the period scrubber and the summary under them — rises into
 * place on the house `Reveal`, so the archive arrives the way /research, /credits and every other index
 * arrives. A page that is entirely still on a site where everything else moves does not read as
 * restraint; it reads as a page that stopped halfway through loading.
 *
 * THE TWO PANES BELOW ARE LEFT COMPLETELY STILL, AND THAT IS A DECISION, NOT AN OVERSIGHT. Four
 * separate reasons, any one of which would be enough:
 *
 *   • They are the RESULTS, and the results answer a scrubber the reader DRAGS. Anything that fades
 *     when they change is a workspace flickering under the hand that is using it.
 *   • Both panes are `lg:sticky` (components/site/CraftMap.tsx). `Reveal` writes an inline `transform`
 *     on its own element, and putting a transform over two sticky descendants is not a thing to
 *     introduce for half a second of ornament.
 *   • Stacked on a phone the pair runs to many viewports, so nothing short of `amount="some"` could
 *     ever meet its threshold — and the failure mode of getting that wrong is the entire archive left
 *     at `opacity: 0`, which is exactly the "this page failed to load" the motion exists to avoid.
 *   • The map is built ONCE AND KEPT so a filter change does not throw away the reader's zoom and pan.
 *     It has no business being inside anything that animates.
 *
 * The control column has none of those properties: it is short, it has no sticky descendant, and it
 * sits at a fixed position in this tree with no key — so a filter change re-renders its contents
 * without remounting the wrapper, and `once` means the entrance plays on arrival and never again.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { Metadata } from "next";
import type { Prisma } from "@prisma/client";
import { notFound } from "next/navigation";
import { Compass, SearchX } from "lucide-react";

import { Reveal } from "@/components/motion";
import { CRAFT_PARAMS, CraftFilters, type CraftFilterFacets } from "@/components/site/CraftFilters";
import {
  CraftExplorerPanes,
  type CraftRowData
} from "@/components/site/CraftMap";
import { CraftTimeline, type CraftTimelineBucket } from "@/components/site/CraftTimeline";
import type { FilterOption } from "@/components/site/FilterBar";
import { PageHero } from "@/components/site/PageHero";
import { ResultSummary } from "@/components/site/ResultSummary";
import { LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { framingAssets, withBaseAsset } from "@/lib/media/framing";
import { pictureFromMap, type ScreenFraming } from "@/lib/media/screens";
import { MEDIA_IMAGE_SELECT } from "@/lib/media/select";
import { pageMetadata } from "@/lib/seo";
import { getSettingCached } from "@/lib/settings/service";
import { clamp, slugify } from "@/lib/utils";
import { prerenderSafe } from "@/lib/prerender";

const EXPLORER_PATH = "/craft-explorer";

/**
 * How many crafts the list renders.
 *
 * Both panes are one viewport tall from `lg` up, so this is a scroll of about two minutes rather than
 * a page that never ends — and it is the number ResultSummary prints, so nothing about it is silent.
 */
const LIST_LIMIT = 120;

/** How many crafts are read to build the material and technique lists. */
const FACET_SCAN = 1000;

/** How many chips a free-text facet offers before it says how many it is not offering. */
const MAX_FACET_OPTIONS = 24;

/** Bars in the timeline's distribution strip. 24 puts a century in a bar over a 2,400-year corpus. */
const BUCKET_COUNT = 24;

type SearchParams = Record<string, string | string[] | undefined>;

interface CraftExplorerPageProps {
  /** A Promise in Next 15: `searchParams` is awaited, never read synchronously. */
  searchParams: Promise<SearchParams>;
}

export async function generateMetadata(): Promise<Metadata> {
  /**
   * The canonical is the unfiltered path, deliberately.
   *
   * `pageMetadata` builds it from `path`, and passing the bare route means `?region=rajasthan` is
   * indexed as this page rather than as a second page competing with it — the exact failure lib/seo.ts
   * exists to prevent.
   */
  return pageMetadata({
    title: "Craft Explorer",
    description:
      "A living archive of craft traditions: where they are practised, the schools they belong to, " +
      "the materials and techniques they use, and when they were first recorded.",
    path: EXPLORER_PATH
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the query string
// ─────────────────────────────────────────────────────────────────────────────

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return (value[0] ?? "").trim();
  return (value ?? "").trim();
}

function allValues(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return raw.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function intValue(value: string | string[] | undefined): number | null {
  const raw = firstValue(value);
  if (raw.length === 0) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Facets over a free-text array column
// ─────────────────────────────────────────────────────────────────────────────

interface ValueFacet {
  options: FilterOption[];
  /** Slug → every stored spelling that slugs to it. This is what the `hasSome` filter is built from. */
  spellings: Map<string, string[]>;
  /** How many distinct values exist in total, so a capped option list can say what it left out. */
  distinct: number;
}

function tallyValues(rows: ReadonlyArray<readonly string[]>): ValueFacet {
  const tallies = new Map<string, { label: string; count: number; spellings: Set<string> }>();

  for (const values of rows) {
    // A single craft listing "Cotton" twice must not count twice — the tally answers "how many crafts
    // use this", which is what a facet count means to a reader.
    const seen = new Set<string>();
    for (const raw of values) {
      const value = raw.trim();
      if (value.length === 0) continue;
      const slug = slugify(value);
      if (slug.length === 0 || seen.has(slug)) continue;
      seen.add(slug);

      const existing = tallies.get(slug);
      if (existing) {
        existing.count += 1;
        existing.spellings.add(value);
        continue;
      }
      tallies.set(slug, { label: value, count: 1, spellings: new Set([value]) });
    }
  }

  const spellings = new Map<string, string[]>();
  for (const [slug, entry] of tallies) spellings.set(slug, [...entry.spellings]);

  // Ordered by how many crafts carry the value, then alphabetically, so the cap keeps the values a
  // reader is most likely to be looking for and the order is total.
  const ranked = [...tallies.entries()].sort((a, b) => {
    if (a[1].count !== b[1].count) return b[1].count - a[1].count;
    return a[1].label.localeCompare(b[1].label, "en-GB");
  });

  const options: FilterOption[] = ranked
    .slice(0, MAX_FACET_OPTIONS)
    .map(([slug, entry]) => ({ value: slug, label: entry.label }))
    // Presented alphabetically: a reader scans a chip row for a word, not for a ranking.
    .sort((a, b) => a.label.localeCompare(b.label, "en-GB"));

  return { options, spellings, distinct: tallies.size };
}

/** Every stored spelling for the slugs the reader chose. Unrecognised slugs contribute nothing. */
function spellingsFor(facet: ValueFacet, slugs: readonly string[]): string[] {
  const out: string[] = [];
  for (const slug of slugs) {
    for (const spelling of facet.spellings.get(slug) ?? []) out.push(spelling);
  }
  return out;
}

function buildBuckets(
  years: readonly number[],
  min: number,
  max: number
): CraftTimelineBucket[] {
  if (years.length === 0 || max <= min) return [];

  const span = max - min + 1;
  const width = Math.max(1, Math.ceil(span / BUCKET_COUNT));
  const buckets: CraftTimelineBucket[] = [];

  for (let start = min; start <= max; start += width) {
    buckets.push({ start, end: Math.min(max, start + width - 1), count: 0 });
  }

  for (const year of years) {
    const index = clamp(Math.floor((year - min) / width), 0, buckets.length - 1);
    const bucket = buckets[index];
    // The index is bounded by the clamp above, but `noUncheckedIndexedAccess` cannot see that and a
    // silent `undefined` here would drop a craft out of the distribution.
    if (bucket) bucket.count += 1;
  }

  return buckets;
}

// ─────────────────────────────────────────────────────────────────────────────
// The page
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Refreshed every five minutes rather than frozen at build time. Required by the `prerenderSafe` guards
 * below — see lib/prerender.ts — and right on its own terms: the archive grows without a deploy.
 */
export const revalidate = 300;

export default async function CraftExplorerPage({ searchParams }: CraftExplorerPageProps) {
  const params = await searchParams;

  const features = await getSettingCached("features");
  /**
   * The feature flag gates the ROUTE, not merely the navigation entry.
   *
   * `FEATURE_FLAGS` in lib/settings/schema.ts says a flag that gates a surface gates its pages too. A
   * page left reachable after the section was switched off is a page whose links have all been removed
   * — which is a worse experience than an honest 404.
   */
  if (!features.craftExplorer) notFound();

  const live = liveStatusWhere();

  const [totalPublished, datedCount, extremes, scan, regionRows, schoolRows] = await prerenderSafe(
    "craft-explorer facets",
    () =>
      Promise.all([
          prisma.craft.count({ where: live }),
          prisma.craft.count({ where: { ...live, originYear: { not: null } } }),
          // Exact bounds, rather than the bounds of the capped scan below: the scrubber's ends must be the
          // real ends of the archive or a craft becomes unreachable by year.
          prisma.craft.aggregate({
            where: live,
            _min: { originYear: true },
            _max: { originYear: true }
          }),
          prisma.craft.findMany({
            where: live,
            // Narrow on purpose: this is a scan of the whole corpus and it must not pull bodies or media.
            select: { materials: true, techniques: true, originYear: true },
            orderBy: { slug: "asc" },
            take: FACET_SCAN
          }),
          // Taxonomy tables, filtered to the entries that actually hold something published — a region with
          // nothing in it is an option that can only ever produce an empty list.
          prisma.craftRegion.findMany({
            where: { crafts: { some: live } },
            select: { slug: true, name: true },
            orderBy: { name: "asc" }
          }),
          prisma.craftSchool.findMany({
            where: { crafts: { some: live } },
            select: { slug: true, name: true },
            orderBy: { name: "asc" }
          })
      ]),
    // `extremes` is an aggregate, and its EMPTY shape is `{ _min: {…null}, _max: {…null} }` rather than
  // `null` — the same answer Prisma gives for a table with no rows, which is exactly the state a
  // fallback should imitate.
  [0, 0, { _min: { originYear: null }, _max: { originYear: null } }, [], [], []]
  );

  const materialFacet = tallyValues(scan.map((row) => row.materials));
  const techniqueFacet = tallyValues(scan.map((row) => row.techniques));

  const facets: CraftFilterFacets = {
    regions: regionRows.map((row) => ({ value: row.slug, label: row.name })),
    schools: schoolRows.map((row) => ({ value: row.slug, label: row.name })),
    materials: materialFacet.options,
    techniques: techniqueFacet.options
  };

  const query = firstValue(params[CRAFT_PARAMS.search]);
  const regionSlug = firstValue(params[CRAFT_PARAMS.region]);
  const schoolSlug = firstValue(params[CRAFT_PARAMS.school]);
  const materialSlugs = allValues(params[CRAFT_PARAMS.material]);
  const techniqueSlugs = allValues(params[CRAFT_PARAMS.technique]);

  const corpusMin = extremes._min.originYear ?? 0;
  const corpusMax = extremes._max.originYear ?? 0;
  const requestedFrom = intValue(params[CRAFT_PARAMS.from]);
  const requestedTo = intValue(params[CRAFT_PARAMS.to]);
  const boundedFrom = requestedFrom === null ? corpusMin : clamp(requestedFrom, corpusMin, corpusMax);
  const boundedTo = requestedTo === null ? corpusMax : clamp(requestedTo, corpusMin, corpusMax);
  // A hand-edited or stale link can invert the pair; the smaller end is the start, always.
  const windowFrom = Math.min(boundedFrom, boundedTo);
  const windowTo = Math.max(boundedFrom, boundedTo);
  const narrowedByYear = datedCount > 0 && (windowFrom > corpusMin || windowTo < corpusMax);

  // Everything except the year window, so the counts below can say what the window itself excluded.
  const baseWhere: Prisma.CraftWhereInput = { ...live };
  if (regionSlug) baseWhere.region = { slug: regionSlug };
  if (schoolSlug) baseWhere.school = { slug: schoolSlug };

  const materialSpellings = spellingsFor(materialFacet, materialSlugs);
  if (materialSpellings.length > 0) baseWhere.materials = { hasSome: materialSpellings };
  const techniqueSpellings = spellingsFor(techniqueFacet, techniqueSlugs);
  if (techniqueSpellings.length > 0) baseWhere.techniques = { hasSome: techniqueSpellings };

  if (query.length > 0) {
    // `mode: "insensitive"` on every leg: a reader typing "bagru" must find "Bagru". The local-language
    // name is included, so somebody who knows the craft by its own name finds it.
    baseWhere.OR = [
      { name: { contains: query, mode: "insensitive" } },
      { localName: { contains: query, mode: "insensitive" } },
      { summary: { contains: query, mode: "insensitive" } },
      { originNote: { contains: query, mode: "insensitive" } },
      { region: { name: { contains: query, mode: "insensitive" } } },
      { school: { name: { contains: query, mode: "insensitive" } } }
    ];
  }

  const where: Prisma.CraftWhereInput = narrowedByYear
    ? { ...baseWhere, originYear: { gte: windowFrom, lte: windowTo } }
    : baseWhere;

  const [matched, rows, datedBeforeWindow, undatedDropped] = await prerenderSafe(
    "craft-explorer results",
    () =>
      Promise.all([
          prisma.craft.count({ where }),
          prisma.craft.findMany({
            where,
            // Total and stable: region, then name, then the unique slug. The ordinals depend on it.
            orderBy: [{ region: { name: "asc" } }, { name: "asc" }, { slug: "asc" }],
            take: LIST_LIMIT,
            select: {
              id: true,
              slug: true,
              name: true,
              localName: true,
              localNameLang: true,
              summary: true,
              originYear: true,
              originNote: true,
              materials: true,
              latitude: true,
              longitude: true,
              region: { select: { name: true } },
              school: { select: { name: true } },
              // `coverId` beside the row itself, because the framing resolver looks the base photograph
              // up by id in the same map it looks an alternate up in — see `pictureFromMap`.
              coverId: true,
              coverScreens: true,
              cover: { select: MEDIA_IMAGE_SELECT }
            }
          }),
          // How many DATED crafts the other filters matched, so the difference from `matched` is exactly what
          // the year window excluded. Only worth asking when a window is in force.
          narrowedByYear
            ? prisma.craft.count({ where: { ...baseWhere, originYear: { not: null } } })
            : Promise.resolve(0),
          // Asked ALWAYS, and against `baseWhere` rather than the corpus: the scrubber's sentence is about the
          // crafts these filters matched, not about the archive as a whole, and a number that silently
          // switched between those two meanings would be worse than no number.
          prisma.craft.count({ where: { ...baseWhere, originYear: null } })
      ]),
    [0, [], 0, 0]
  );

  /**
   * The framings, and the alternate photographs they name.
   *
   * The column is `Json?`, so the shape is a claim rather than a proof: the studio route validates it
   * with `screenFramingField()` on the way in, and `resolvePicture` reads every bucket defensively —
   * an out-of-range rectangle degrades to "no crop" instead of drawing a broken frame.
   *
   * ONE query for the whole list, and NO query at all when nobody has framed anything, which is the
   * common case and the reason this is not guarded by a condition (see lib/media/framing.ts).
   */
  const framings = rows.map((row) => (row.coverScreens ?? null) as unknown as ScreenFraming | null);
  const alternates = await framingAssets(...framings);

  const crafts: CraftRowData[] = rows.map((row, index) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    localName: row.localName,
    localNameLang: row.localNameLang,
    summary: row.summary,
    regionName: row.region?.name ?? null,
    schoolName: row.school?.name ?? null,
    originYear: row.originYear,
    originNote: row.originNote,
    materials: row.materials,
    latitude: row.latitude,
    longitude: row.longitude,
    cover: row.cover,
    picture: pictureFromMap(
      row.coverId,
      framings[index],
      withBaseAsset(alternates, row.coverId, row.cover)
    )
  }));

  const truncated = matched > crafts.length;
  const filtering =
    query.length > 0 ||
    regionSlug.length > 0 ||
    schoolSlug.length > 0 ||
    materialSlugs.length > 0 ||
    techniqueSlugs.length > 0 ||
    narrowedByYear;

  const facetNotes: string[] = [];
  if (scan.length >= FACET_SCAN && totalPublished > scan.length) {
    facetNotes.push(
      `The material and technique lists are built from ${scan.length} of ${totalPublished} published crafts, so a value used only by the rest is not offered as a chip.`
    );
  }
  if (materialFacet.distinct > materialFacet.options.length) {
    facetNotes.push(
      `${materialFacet.options.length} of ${materialFacet.distinct} materials are shown, the most used first.`
    );
  }
  if (techniqueFacet.distinct > techniqueFacet.options.length) {
    facetNotes.push(
      `${techniqueFacet.options.length} of ${techniqueFacet.distinct} techniques are shown, the most used first.`
    );
  }

  return (
    <>
      <PageHero
        eyebrow="Living archive"
        title="Craft Explorer"
        description="Every craft tradition the Centre has recorded, on a map and in a list. Pick a marker to find its entry; narrow the archive by region, school, material, technique or period."
        breadcrumbs={[
          { name: "Home", href: "/" },
          { name: "Craft Explorer", href: EXPLORER_PATH }
        ]}
      />

      <div className="shell pb-24">
        {/* The frame. See the header for why the entrance stops here and the panes below get none. */}
        <Reveal as="div" className="flex flex-col gap-6">
          <CraftFilters
            facets={facets}
            note={
              facetNotes.length > 0 ? (
                <div className="flex flex-col gap-1.5 text-sm leading-relaxed text-ink-500">
                  {facetNotes.map((note) => (
                    <p key={note}>{note}</p>
                  ))}
                </div>
              ) : undefined
            }
          />

          <CraftTimeline
            min={corpusMin}
            max={corpusMax}
            from={windowFrom}
            to={windowTo}
            datedCount={datedCount}
            undatedCount={undatedDropped}
            excludedByWindow={narrowedByYear ? Math.max(0, datedBeforeWindow - matched) : 0}
            buckets={buildBuckets(
              scan
                .map((row) => row.originYear)
                .filter((year): year is number => typeof year === "number"),
              corpusMin,
              corpusMax
            )}
            fromParam={CRAFT_PARAMS.from}
            toParam={CRAFT_PARAMS.to}
          />

          {/*
            The summary sits with the filters, because that is where the question "how many did that
            leave?" is asked. It also owns the cap sentence — `truncated` is a fact here, not a guess:
            it is the count against what was rendered.
          */}
          <ResultSummary
            shown={crafts.length}
            total={matched}
            noun={{ singular: "craft", plural: "crafts" }}
            truncated={truncated}
            cap={LIST_LIMIT}
            omitted={Math.max(0, matched - crafts.length)}
            remedy="Narrow it by region, material or period to reach the rest."
          />
        </Reveal>

        <div className="mt-8">
          <CraftExplorerPanes
            crafts={crafts}
            basePath={EXPLORER_PATH}
            empty={
              filtering ? (
                <EmptyState
                  icon={SearchX}
                  headingLevel={2}
                  title="No crafts match these filters"
                  description="Nothing in the published archive answers all of them at once. Clearing one at a time usually shows which is doing the narrowing."
                  action={
                    <LinkButton href={EXPLORER_PATH} variant="secondary">
                      Clear every filter
                    </LinkButton>
                  }
                />
              ) : (
                <EmptyState
                  icon={Compass}
                  headingLevel={2}
                  title="No crafts have been published yet"
                  description="Craft records appear here as soon as they are published in the studio. Nothing is missing from this page — there is nothing in the archive yet."
                />
              )
            }
            note={
              truncated ? (
                // A SECOND sentence, in a second place, and not a duplicate: this one is at the point
                // where the list actually stops, which is where a reader scrolling the pane finds out.
                // The summary above is read before they start.
                <p className="text-sm leading-relaxed text-ink-500">
                  That is the end of the first {crafts.length} crafts. {matched} match in all — narrow
                  the filters or the period to reach the others.
                </p>
              ) : (
                <p className="text-sm leading-relaxed text-ink-500">
                  That is every craft in this selection.
                </p>
              )
            }
          />
        </div>
      </div>
    </>
  );
}
