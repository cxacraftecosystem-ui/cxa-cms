/**
 * CraftExplorerSection — a compact taste of the craft archive, with a way into the whole of it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS IS A PREVIEW, NOT THE EXPLORER.
 *
 * The full page at `/craft-explorer` owns the live filters, the URL state and the deep map; this block
 * shows a region row, optionally a map, a handful of cards and a link. That division is deliberate:
 * two components that both owned the filter state would need two copies of the query logic, and the
 * copy on the homepage would be the one that quietly stopped matching.
 *
 * SO EVERY FILTER HERE IS A `<Link>` INTO THE FULL EXPLORER, not a control that narrows this block.
 * That is what keeps this a Server Component; it is also the honest design, because a preview whose
 * chips filter the preview teaches the reader a control that behaves differently on the page it links
 * to. The regions offered are the regions PRESENT IN THIS SELECTION — the block has not read the
 * region table and must not imply that it has, which is why the row is named for what it is.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * EVERY OMISSION IS NAMED. The map leaves out crafts with no coordinates; the timeline leaves out
 * crafts with no origin year; the block as a whole leaves out everything past `limit`, and hand-picked
 * crafts that are no longer published. Each is stated on screen with a number, because a list that
 * quietly stops is indistinguishable from a place with no records (contract §1.6) — and in an archive
 * "we have nothing from Rajasthan" and "we have not recorded where these are" are very different
 * claims to make on the Centre's behalf.
 *
 * IT NEVER QUERIES. Rows come from the one batched pass in `lib/sections/resolve.ts`, which also
 * applies `regionSlug` and — for the timeline view — restricts to crafts that have an origin year.
 * The filters below are re-applied defensively rather than trusted, because a renderer that assumes
 * its input was pre-filtered breaks silently the day the resolver's planner changes.
 */

import Link from "next/link";
import type { PageSection } from "@prisma/client";
import { Compass } from "lucide-react";

import { Reveal } from "@/components/motion";
import { MapAttribution, MapCanvas, type MapPoint } from "@/components/sections/MapSection";
import { CraftPlate } from "@/components/craft/CraftPlate";
import { EntityCard } from "@/components/site/EntityCard";
import { SectionHeading } from "@/components/site/SectionHeading";
import { TagList } from "@/components/site/TagList";
import { EmptyState } from "@/components/ui/EmptyState";
import { pictureFromMap, type ScreenFraming } from "@/lib/media/screens";
import type { CraftRow, MediaRow, ResolvedSectionData } from "@/lib/sections/resolve";
import type { CraftExplorerSectionData } from "@/lib/sections/schema";
import { cn, truncateWords } from "@/lib/utils";

/** Where the full explorer lives. One constant, so the cards and the links cannot drift apart. */
const EXPLORER_PATH = "/craft-explorer";

/** How many region links the preview shows before it says how many it is not showing. */
const MAX_REGION_LINKS = 8;

/** Complete literal class strings, matching the chips in components/site/FilterBar.tsx. */
const CHIP_BASE =
  "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition";
const CHIP_OFF =
  "border-line-200 bg-card text-ink-700 hover:border-purple-300 hover:bg-purple-50 hover:text-purple-700";
const CHIP_ON = "border-purple-700 bg-purple-700 text-white hover:bg-purple-800";

export interface CraftExplorerSectionProps {
  data: CraftExplorerSectionData;
  section: PageSection;
  /** Resolved in one batched pass by `lib/sections/resolve.ts`. Never fetched here. */
  rows: CraftRow[];
  /**
   * The same batched read the rows came from, for its media map alone: it carries each cover AND every
   * alternate photograph a per-screen framing names, which `attachCraftFraming` put there. Optional
   * because a studio preview or a bespoke page may hand over rows on their own — a cover then draws
   * unframed rather than not at all.
   */
  resolved?: ResolvedSectionData;
  /** How many crafts match the block's criteria in total, ignoring `limit`. */
  total?: number;
  /** Hand-picked ids that no longer resolve. */
  droppedIds?: number;
}

/** A craft that has been confirmed to carry coordinates. */
type LocatedCraft = CraftRow & { latitude: number; longitude: number };

/** A craft that has been confirmed to carry an origin year. */
type DatedCraft = CraftRow & { originYear: number };

interface RegionTally {
  slug: string;
  name: string;
  count: number;
}

/**
 * A year as it should read. Negative is BCE, which is why the column is signed rather than a string.
 * A qualification — "sometime in the medieval period" — belongs in `originNote` beside it, never
 * baked into an invented number (see `Craft.originYear` in prisma/schema.prisma).
 */
function formatOriginYear(year: number): string {
  return year < 0 ? `${Math.abs(year)} BCE` : String(year);
}

/**
 * The explorer link with `region` set to one slug — or removed, for the chip that means "every region".
 *
 * ⚠ NEVER `${href}?region=…`. The href here is `ctaHref`, an editor's free text, and `LINK_SHAPE` in
 * lib/sections/schema.ts admits a link that already carries its own query or fragment. Concatenation
 * then writes a SECOND `?`: "/craft-explorer?material=indigo" becomes
 * "/craft-explorer?material=indigo?region=rajasthan", which parses as one parameter called `material`
 * whose value is "indigo?region=rajasthan" — the editor's filter and the reader's region are both
 * silently dropped and the chip lands on an archive it never asked for. A fragment swallows the query
 * outright. `FormEmbedSection` merges parameters through `searchParams.set` for exactly this reason.
 *
 * Split by hand rather than parsed with `new URL()`, which would need a base invented for the ordinary
 * root-relative case; the fragment is re-attached last so a reader's anchor still lands where it did.
 */
function regionHref(href: string, slug: string | null): string {
  const hashAt = href.indexOf("#");
  const hash = hashAt === -1 ? "" : href.slice(hashAt);
  const beforeHash = hashAt === -1 ? href : href.slice(0, hashAt);

  const queryAt = beforeHash.indexOf("?");
  const path = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const params = new URLSearchParams(queryAt === -1 ? "" : beforeHash.slice(queryAt + 1));

  // "Every region" must actually clear the filter, even when the editor's own link carried one —
  // a chip marked `aria-current` while pointing at a filtered page says two different things.
  if (slug === null) params.delete("region");
  else params.set("region", slug);

  const query = params.toString();
  return `${path}${query ? `?${query}` : ""}${hash}`;
}

/** The distinct regions in this selection, in first-seen order, with how many crafts each holds. */
function tallyRegions(rows: readonly CraftRow[]): RegionTally[] {
  const tallies = new Map<string, RegionTally>();
  for (const craft of rows) {
    const region = craft.region;
    if (!region) continue;
    const existing = tallies.get(region.slug);
    if (existing) {
      existing.count += 1;
      continue;
    }
    tallies.set(region.slug, { slug: region.slug, name: region.name, count: 1 });
  }
  return [...tallies.values()];
}

export function CraftExplorerSection({
  data,
  section,
  rows,
  resolved,
  total,
  droppedIds = 0
}: CraftExplorerSectionProps) {
  const heading = data.heading.trim();
  const eyebrow = data.eyebrow.trim();
  const body = data.body.trim();
  const label = data.ctaLabel.trim();
  const ctaHref = data.ctaHref.trim();
  const explorerHref = ctaHref || EXPLORER_PATH;
  // Always defined, both halves included: `CraftNote` must have somewhere to send a reader whenever it
  // says the list is short, and an explorer this block previews always exists at a known path.
  const link = { href: explorerHref, label: label || "Open the craft explorer" };

  const matched = total ?? rows.length;
  const hidden = Math.max(0, matched - rows.length);

  /**
   * ⚠ THE TEST IS "DID AN EDITOR ASK FOR A CALL TO ACTION", NOT `link`.
   *
   * The sibling showcase blocks write `|| link` here, and copying that would be wrong in this one file:
   * `link` above is unconditionally truthy, so the header would be forced onto every CRAFT_EXPLORER
   * block and every card demoted from h2 to h3. Either half of the CTA pair counts as having been asked
   * for, because the other half has a sensible default — and `SectionHeading` is the ONLY thing that
   * draws the link outside the truncation footnote, so leaving it out of this test is what silently
   * discarded an editor's configured CTA on a block with no header text.
   */
  const showsHeader = Boolean(heading || eyebrow || body || label || ctaHref);
  const cardHeadingLevel = showsHeader ? 3 : 2;

  const located = rows.filter(
    (craft): craft is LocatedCraft =>
      typeof craft.latitude === "number" && typeof craft.longitude === "number"
  );
  const unlocated = rows.length - located.length;

  const dated = rows
    .filter((craft): craft is DatedCraft => typeof craft.originYear === "number")
    .sort((a, b) => a.originYear - b.originYear);
  const undated = rows.length - dated.length;

  const regions = tallyRegions(rows);

  return (
    <section id={`block-${section.id}`} className="py-20 md:py-28">
      <div className="shell">
        {showsHeader ? (
          <Reveal>
            <SectionHeading
              eyebrow={eyebrow || undefined}
              title={heading || "Craft explorer"}
              description={body || undefined}
              link={link}
              className="mb-10"
              titleClassName={heading ? undefined : "sr-only"}
            />
          </Reveal>
        ) : null}

        {data.showFilters && regions.length > 0 ? (
          <Reveal as="div" className="mb-10">
            <RegionLinks
              regions={regions}
              activeSlug={data.regionSlug.trim()}
              href={explorerHref}
            />
          </Reveal>
        ) : null}

        {rows.length === 0 ? (
          <EmptyState
            icon={Compass}
            headingLevel={cardHeadingLevel}
            title="No crafts to show yet"
            description={
              data.regionSlug.trim()
                ? "No published crafts have been recorded for this region yet."
                : "Crafts appear here once they have been published in the studio."
            }
          />
        ) : (
          <>
            {data.view === "map" ? (
              <Reveal as="div" className="mb-10">
                {located.length > 0 ? (
                  <>
                    <MapCanvas
                      points={located.map<MapPoint>((craft) => ({
                        id: craft.id,
                        latitude: craft.latitude,
                        longitude: craft.longitude,
                        label: craft.name
                      }))}
                      height="md"
                      label="Map of where these crafts are practised"
                    />
                    <MapAttribution />
                  </>
                ) : null}

                {unlocated > 0 ? (
                  <p className="mt-3 text-sm text-ink-500">
                    {located.length === 0
                      ? "None of these crafts has a recorded location yet, so there is nothing to place on a map. They are all listed below."
                      : `${unlocated} of these crafts ${
                          unlocated === 1 ? "has" : "have"
                        } no recorded location and ${
                          unlocated === 1 ? "is" : "are"
                        } not on the map. All of them are listed below.`}
                  </p>
                ) : null}
              </Reveal>
            ) : null}

            {data.view === "timeline" ? (
              <CraftTimeline
                entries={dated}
                undated={undated}
                headingLevel={cardHeadingLevel}
              />
            ) : (
              <CraftGrid crafts={rows} media={resolved?.media} headingLevel={cardHeadingLevel} />
            )}
          </>
        )}

        <CraftNote hidden={hidden} matched={matched} dropped={droppedIds} link={link} />
      </div>
    </section>
  );
}

function RegionLinks({
  regions,
  activeSlug,
  href
}: {
  regions: readonly RegionTally[];
  activeSlug: string;
  href: string;
}) {
  const shown = regions.slice(0, MAX_REGION_LINKS);
  const hidden = regions.length - shown.length;

  return (
    <nav
      // Named for exactly what it is. "Craft regions" would claim to be the whole region list; this
      // row is built from the crafts on screen and nothing else.
      aria-label="Regions in this selection"
      className="flex flex-wrap items-center gap-2"
    >
      <Link
        href={regionHref(href, null)}
        // `aria-current` rather than colour alone: which region is selected must survive a monochrome
        // screen and reach a screen reader (contract §11).
        aria-current={activeSlug.length === 0 ? "true" : undefined}
        className={cn(CHIP_BASE, activeSlug.length === 0 ? CHIP_ON : CHIP_OFF)}
      >
        Every region
      </Link>

      {shown.map((region) => {
        const active = region.slug === activeSlug;
        return (
          <Link
            key={region.slug}
            href={regionHref(href, region.slug)}
            aria-current={active ? "true" : undefined}
            className={cn(CHIP_BASE, active ? CHIP_ON : CHIP_OFF)}
          >
            {region.name}
            <span className={active ? "text-white/70" : "text-ink-500"}>{region.count}</span>
          </Link>
        );
      })}

      {hidden > 0 ? (
        // The overflow chip goes somewhere. "+6 more" that is only a count tells the reader something
        // is missing without telling them where to find it.
        <Link href={regionHref(href, null)} className={cn(CHIP_BASE, CHIP_OFF)}>
          {hidden} more {hidden === 1 ? "region" : "regions"} in the explorer
        </Link>
      ) : null}
    </nav>
  );
}

function CraftGrid({
  crafts,
  media,
  headingLevel
}: {
  crafts: readonly CraftRow[];
  /** The page's media map, carrying each cover and the alternates its framing names. See the props above. */
  media?: Record<string, MediaRow | undefined>;
  headingLevel: 2 | 3;
}) {
  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {crafts.map((craft, index) => (
        <Reveal key={craft.id} delay={Math.min(index, 8) * 0.05} className="h-full">
          <EntityCard
            href={`${EXPLORER_PATH}/${craft.slug}`}
            media={craft.cover}
            /* The column is `Json?`, so its shape is a claim rather than a proof — safe because the
               resolver reads a framing defensively, which is what makes a hand-edited row degrade to no
               framing rather than to a broken frame. */
            picture={pictureFromMap(
              craft.coverId,
              craft.coverScreens as unknown as ScreenFraming | null,
              media
            )}
            /*
              ⚠ SIXTEEN OF THE FORTY-TWO CRAFTS HAVE NO PHOTOGRAPH, AND WITHOUT THIS THEY SHOWED
              `MediaImage`'s grey "No image" DIAGNOSTIC — on the archive's own front page. See
              CraftPlate's header: that placeholder is right for a file that failed to arrive and
              wrong for an absence that is permanent, which is exactly the distinction `PersonCard`
              already draws with its initials plate. The mechanism (`mediaFallback`) has existed
              since that fix; these cards simply never passed one.
            */
            mediaFallback={<CraftPlate slug={craft.slug} />}
            eyebrow={craft.region?.name ?? undefined}
            headingLevel={headingLevel}
            sizes="(min-width: 1024px) 30vw, (min-width: 640px) 46vw, 92vw"
            title={
              <>
                {craft.name}
                {craft.localName ? (
                  <span
                    // `lang` so a screen reader switches voice for the local-script name instead of
                    // reading Devanagari letter by letter in an English voice.
                    lang={craft.localNameLang ?? undefined}
                    className="mt-1 block text-base font-medium text-ink-500"
                  >
                    {craft.localName}
                  </span>
                ) : null}
              </>
            }
            description={craft.summary ? truncateWords(craft.summary, 140) : undefined}
            meta={
              <>
                {craft.originYear !== null ? (
                  <span>{formatOriginYear(craft.originYear)}</span>
                ) : craft.originNote ? (
                  <span>{craft.originNote}</span>
                ) : null}
                {craft.school ? <span>{craft.school.name}</span> : null}
              </>
            }
            footer={
              craft.materials.length > 0 ? (
                <TagList
                  tags={craft.materials}
                  label="Materials"
                  size="sm"
                  max={3}
                  moreHref={`${EXPLORER_PATH}/${craft.slug}`}
                />
              ) : undefined
            }
          />
        </Reveal>
      ))}
    </div>
  );
}

function CraftTimeline({
  entries,
  undated,
  headingLevel
}: {
  entries: readonly DatedCraft[];
  undated: number;
  headingLevel: 2 | 3;
}) {
  // Cast to ONE tag rather than the union `"h2" | "h3"`: TypeScript checks a JSX call against a union
  // of intrinsic elements by INTERSECTING their props, which collapses `children` to `never`. h2 and
  // h3 take identical props, so one of them stands for both (components/motion/Reveal.tsx casts to a
  // single component for the same reason).
  const Heading = (headingLevel === 2 ? "h2" : "h3") as "h2";

  return (
    <div>
      {entries.length === 0 ? (
        <EmptyState
          icon={Compass}
          headingLevel={headingLevel}
          title="No dated crafts to show"
          description="A timeline needs an origin year, and none of these crafts has one recorded yet."
        />
      ) : (
        <ol className="border-l border-line-200">
          {entries.map((craft, index) => (
            <Reveal
              as="li"
              key={craft.id}
              delay={Math.min(index, 8) * 0.035}
              className="relative pb-8 pl-6 last:pb-0"
            >
              {/* The dot, straddling the rail. Positioned with a negative offset rather than a
                  translate utility, because `Reveal` writes an inline transform on this element and a
                  transform class on it would be overwritten (contract §8). */}
              <span
                aria-hidden="true"
                className="absolute -left-[4.5px] top-1.5 h-2 w-2 rounded-full bg-purple-700"
              />

              <p className="text-xs font-semibold uppercase tracking-wide text-purple-700">
                {formatOriginYear(craft.originYear)}
                {craft.originNote ? (
                  <span className="ml-2 font-normal normal-case tracking-normal text-ink-500">
                    {craft.originNote}
                  </span>
                ) : null}
              </p>

              <Heading className="display-title mt-1 text-lg">
                <Link
                  href={`${EXPLORER_PATH}/${craft.slug}`}
                  className="transition-colors hover:text-purple-700"
                >
                  {craft.name}
                </Link>
                {craft.localName ? (
                  <span
                    lang={craft.localNameLang ?? undefined}
                    className="ml-2 text-base font-medium text-ink-500"
                  >
                    {craft.localName}
                  </span>
                ) : null}
              </Heading>

              {craft.region ? (
                <p className="mt-0.5 text-sm text-ink-500">{craft.region.name}</p>
              ) : null}

              {craft.summary ? (
                <p className="prose-measure mt-2 text-sm leading-relaxed text-ink-500">
                  {truncateWords(craft.summary, 200)}
                </p>
              ) : null}
            </Reveal>
          ))}
        </ol>
      )}

      {undated > 0 ? (
        <p className="mt-6 text-sm text-ink-500">
          {undated} {undated === 1 ? "craft is" : "crafts are"} not on this timeline because no origin
          year has been recorded for {undated === 1 ? "it" : "them"}. A made-up date would be worse
          than none.
        </p>
      ) : null}
    </div>
  );
}

/** The footnote. Same two facts, same wording, as every other showcase block on the site. */
function CraftNote({
  hidden,
  matched,
  dropped,
  link
}: {
  hidden: number;
  matched: number;
  dropped: number;
  link?: { href: string; label: string };
}) {
  if (hidden === 0 && dropped === 0) return null;

  return (
    <p className="mt-8 text-sm text-ink-500">
      {hidden > 0 ? (
        <>
          Showing {matched - hidden} of {matched} crafts.{" "}
          {link ? (
            <Link href={link.href} className="font-medium text-purple-700 hover:text-purple-800">
              {link.label}
            </Link>
          ) : null}
        </>
      ) : null}
      {dropped > 0 ? (
        <>
          {hidden > 0 ? " " : null}
          {dropped} chosen {dropped === 1 ? "craft is" : "crafts are"} no longer published and{" "}
          {dropped === 1 ? "is" : "are"} not shown.
        </>
      ) : null}
    </p>
  );
}
