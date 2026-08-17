/**
 * /craft-explorer/[slug] — one craft.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE LOCAL NAME CARRIES A `lang` ATTRIBUTE EVERY TIME IT IS RENDERED.
 *
 * `Craft.localName` is in its own script, and a screen reader with no language switch reads Devanagari
 * with an English voice — which produces sounds that are not the name of anything. The column
 * `localNameLang` exists for exactly this and is honoured in the heading, in the fact panel and in the
 * related cards.
 *
 * THE RELATED BLOCK AT THE FOOT COSTS ONE QUERY, and it is the page's only query besides the craft
 * itself. It relates on the four connections an editor recorded — region, school, a shared material, a
 * shared technique — and it draws through `components/site/RelatedContent`, the same block that ends
 * the project and research-area pages.
 *
 * A SERVER COMPONENT that reads Prisma once through `cache()`, so `generateMetadata` and the page body
 * cost one query between them rather than two. Anything unpublished, scheduled for later, retired or
 * soft-deleted resolves to `notFound()` — the filter is `liveStatusWhere()`, never hand-rolled.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `revalidate` IS SET DELIBERATELY. This page reads no request-scoped input, so without it Next would
 * render it once on first request and serve that copy for the life of the deployment — and a craft
 * corrected in the studio would never appear. Publication state is resolved at read time
 * (lib/content.ts), so the window below is also the longest anything here can be stale.
 */

import type { Metadata } from "next";
import { cache } from "react";
import type { Prisma } from "@prisma/client";
import { notFound } from "next/navigation";
import { Layers, MapPin } from "lucide-react";

import { Reveal } from "@/components/motion";
import { Artifact3D } from "@/components/site/Artifact3D";
import { BeforeAfterSlider } from "@/components/site/BeforeAfterSlider";
import {
  DefinitionList,
  hasVisibleDefinitions,
  type DefinitionItem
} from "@/components/site/DefinitionList";
import {
  LightboxTrigger,
  MediaLightboxProvider,
  type LightboxItem
} from "@/components/site/MediaLightbox";
import { PageHero } from "@/components/site/PageHero";
import { ProseArticle } from "@/components/site/ProseArticle";
import { RelatedContent, type RelatedItem } from "@/components/site/RelatedContent";
import { SectionHeading } from "@/components/site/SectionHeading";
import { TagList } from "@/components/site/TagList";
import { MediaImage } from "@/components/ui/MediaImage";
import { liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { framingAssets, withBaseAsset } from "@/lib/media/framing";
import { pictureFromMap, type Picture, type ScreenFraming } from "@/lib/media/screens";
import { MEDIA_FIGURE_SELECT } from "@/lib/media/select";
import { mediaAlt } from "@/lib/media/url";
import { isEmptyRichText, parseRichText } from "@/lib/richtext";
import { pageMetadata } from "@/lib/seo";
import { getSettingCached } from "@/lib/settings/service";
import { slugify, truncateWords } from "@/lib/utils";

const EXPLORER_PATH = "/craft-explorer";

/** Five minutes. Long enough to be worth having, short enough that a correction is not a mystery. */
export const revalidate = 300;

/**
 * How many related crafts the block shows — two full rows of the three-column grid.
 *
 * The query below takes one MORE than this, so "is that all of them?" is answered from a row that came
 * back rather than guessed. A list that quietly stops is indistinguishable from a region with six
 * crafts in it (contract §1.6).
 */
const RELATED_LIMIT = 6;

interface CraftPageProps {
  params: Promise<{ slug: string }>;
}

/**
 * The media columns every picture on this page needs, in one place so the two selects cannot drift —
 * and taken from lib/media/select.ts, because a hand-written copy of this list is exactly how the crop
 * columns came to be stored and never rendered. The figure variant for the caption and credit lines
 * printed under the gallery pictures, plus `id`, which keys the gallery.
 */
const MEDIA_SELECT = { ...MEDIA_FIGURE_SELECT, id: true } as const;

/**
 * One query, memoised for the duration of one request.
 *
 * React's `cache()` is per-render, which is exactly right here: `generateMetadata` and the component
 * both need the whole row, and neither should pay for it twice.
 */
const loadCraft = cache(async (slug: string) =>
  prisma.craft.findFirst({
    // `findFirst` and not `findUnique`: the publication filter is not part of the unique key, and a
    // `findUnique` on the slug alone would happily return a draft.
    where: { ...liveStatusWhere(), slug },
    include: {
      region: { select: { slug: true, name: true, level: true } },
      school: { select: { slug: true, name: true, description: true } },
      cover: { select: MEDIA_SELECT },
      media: {
        orderBy: { position: "asc" },
        select: {
          position: true,
          caption: true,
          restorationPhase: true,
          /**
           * This ROW's per-screen framing, in the same select as the photograph it frames — the pairing
           * the header of scripts/media-select-check.ts exists to enforce. On the row rather than the file
           * because the same photograph is framed one way in this gallery and another in an album. The
           * base id comes from `asset.id`, which `MEDIA_SELECT` already carries.
           */
          assetScreens: true,
          asset: { select: MEDIA_SELECT }
        }
      }
    }
  })
);

export async function generateMetadata({ params }: CraftPageProps): Promise<Metadata> {
  const { slug } = await params;
  const craft = await loadCraft(slug);

  if (!craft) {
    // The page itself calls `notFound()`; this is the metadata for the 404 that follows. `noIndex`
    // because a missing record must not leave a crawlable stub behind.
    return pageMetadata({
      title: "Craft not found",
      path: `${EXPLORER_PATH}/${slug}`,
      noIndex: true
    });
  }

  return pageMetadata({
    title: craft.name,
    description: craft.summary,
    path: `${EXPLORER_PATH}/${craft.slug}`,
    image: craft.cover,
    type: "article",
    publishedTime: craft.publishedAt,
    modifiedTime: craft.updatedAt,
    keywords: [...craft.materials, ...craft.techniques]
  });
}

/**
 * A year as it should read. Negative is BCE — the column is signed for that reason, and a hedge such as
 * "sometime in the medieval period" belongs in `originNote` beside it rather than as an invented date.
 *
 * The same three lines appear in components/sections/CraftExplorerSection.tsx and in CraftMap.tsx: a
 * date must not be spelled two ways on one site, and this is cheaper to keep identical than to import
 * across a client boundary.
 */
function formatOriginYear(year: number): string {
  return year < 0 ? `${Math.abs(year)} BCE` : String(year);
}

// ─────────────────────────────────────────────────────────────────────────────
// Restoration pairs
// ─────────────────────────────────────────────────────────────────────────────

interface Placement {
  id: string;
  caption: string | null;
  phase: "before" | "after" | null;
  item: LightboxItem;
  /**
   * The row's framing, resolved. Null where nobody framed it, which is nearly every picture.
   *
   * ⚠ IT IS USED ON THE GALLERY TILE AND NOWHERE ELSE, and the two omissions are deliberate. The LIGHTBOX
   * draws the whole photograph at its own proportions (`!object-contain` in MediaLightbox.tsx), so there is
   * no per-width frame for a rectangle to fit. And a restoration PAIR is two photographs registered against
   * each other in one frame whose shape is the "after"'s — re-framing one half per width would slide the
   * seam across the subject, so `BeforeAfterSlider` is handed the plain rows and the editor is not offered
   * the panel for a paired picture (CraftEditor).
   */
  picture: Picture | null;
}

/**
 * ⚠ THE PAIRING IS RE-IMPLEMENTED HERE RATHER THAN IMPORTED.
 *
 * `splitRestorationPhases()` lives in components/site/BeforeAfterSlider.tsx, which is a `"use client"`
 * module. Every export of such a module becomes a CLIENT REFERENCE when a Server Component imports it,
 * and calling one from the server throws ("attempted to call a client function from the server"). The
 * component itself is fine to render — that is what client components are for — but its plain helper
 * is not callable here.
 *
 * The rule it implements is copied exactly, because the two must agree: ADJACENCY IN `position` ORDER.
 * A "before" is held and the next "after" completes it; `CraftMedia` has no column linking one half to
 * the other, so the editor's ordering is the only evidence of which pairs with which — and it is the
 * evidence they gave by dragging the two next to each other. Half a comparison is not a comparison, so
 * an unmatched half falls through to the ordinary gallery.
 */
function splitPhases(placements: readonly Placement[]): {
  pairs: { before: Placement; after: Placement }[];
  singles: Placement[];
} {
  const pairs: { before: Placement; after: Placement }[] = [];
  const singles: Placement[] = [];
  let pendingBefore: Placement | null = null;

  for (const placement of placements) {
    if (placement.phase === "before") {
      // Two "before"s running: the first never found its partner, so it is an ordinary photograph.
      if (pendingBefore) singles.push(pendingBefore);
      pendingBefore = placement;
      continue;
    }
    if (placement.phase === "after" && pendingBefore) {
      pairs.push({ before: pendingBefore, after: placement });
      pendingBefore = null;
      continue;
    }
    singles.push(placement);
  }

  if (pendingBefore) singles.push(pendingBefore);
  return { pairs, singles };
}

/** `restorationPhase` is a nullable string, not an enum, so "Before" from the studio must match. */
function phaseOf(value: string | null): "before" | "after" | null {
  const phase = value?.trim().toLowerCase();
  if (phase === "before") return "before";
  if (phase === "after") return "after";
  return null;
}

/**
 * "a, b or c" — the related block's description names the connections the query actually searched on,
 * so it has to be assembled from whichever of them this craft has.
 *
 * `null` entries are dropped rather than printed as gaps. The last element is taken through `.at(-1)`
 * and CHECKED rather than asserted: under `noUncheckedIndexedAccess` an index is `string | undefined`,
 * and a template literal will happily interpolate the word "undefined" into a sentence on the page.
 * The all-null case returns an empty string, which is only ever reached on a craft with no connections
 * at all — where the block renders nothing and the sentence is never seen.
 */
function joinWithOr(parts: readonly (string | null)[]): string {
  const present = parts.filter((part): part is string => part !== null);
  const last = present.at(-1);
  if (last === undefined) return "";
  if (present.length === 1) return last;
  return `${present.slice(0, -1).join(", ")} or ${last}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The page
// ─────────────────────────────────────────────────────────────────────────────

export default async function CraftPage({ params }: CraftPageProps) {
  const { slug } = await params;

  const features = await getSettingCached("features");
  // The flag gates the route, exactly as it does on the index — see the note there.
  if (!features.craftExplorer) notFound();

  const craft = await loadCraft(slug);
  if (!craft) notFound();

  /**
   * The gallery's framings, in ONE query for the whole page.
   *
   * `framingAssets` costs no query when nothing is framed, which is nearly every craft, so it is called
   * without a guard (lib/media/framing.ts). It is asked for the cover's framing at the same time — one
   * round trip for the page rather than one for the cover and another for the pictures.
   */
  const mediaFramings = craft.media.map(
    (placement) => (placement.assetScreens ?? null) as unknown as ScreenFraming | null
  );
  const coverFraming = (craft.coverScreens ?? null) as unknown as ScreenFraming | null;
  const framingMedia = await framingAssets(coverFraming, ...mediaFramings);

  const placements: Placement[] = craft.media.map((placement, index) => ({
    id: placement.asset.id,
    caption: placement.caption ?? placement.asset.caption,
    phase: phaseOf(placement.restorationPhase),
    picture: pictureFromMap(
      placement.asset.id,
      mediaFramings[index] ?? null,
      withBaseAsset(framingMedia, placement.asset.id, placement.asset)
    ),
    item: {
      id: placement.asset.id,
      objectKey: placement.asset.objectKey,
      width: placement.asset.width,
      height: placement.asset.height,
      altText: placement.asset.altText,
      blurDataUrl: placement.asset.blurDataUrl,
      // Copied across one by one because this object is hand-built: an omitted crop column here would
      // lose the editor's rectangle again, one layer above the select.
      cropX: placement.asset.cropX,
      cropY: placement.asset.cropY,
      cropWidth: placement.asset.cropWidth,
      cropHeight: placement.asset.cropHeight,
      variants: placement.asset.variants,
      // The placement's caption wins over the asset's: the same photograph carries a different caption
      // in an album than it does here.
      caption: placement.caption ?? placement.asset.caption,
      credit: placement.asset.credit
    }
  }));

  const { pairs, singles } = splitPhases(placements);

  const hasBody = !isEmptyRichText(parseRichText(craft.body));

  /**
   * The cover, framed per screen width.
   *
   * The column is `Json?`, so the shape is a claim rather than a proof: the studio route validates it with
   * `screenFramingField()` on the way in, and `resolvePicture` reads every bucket defensively — an
   * out-of-range rectangle degrades to "no crop" rather than drawing a broken frame.
   *
   * The alternates come out of `framingMedia` above, which asked for the cover's and the gallery's in one
   * query — `framingAssets` costs nothing at all when nothing is framed (lib/media/framing.ts). With no
   * framing `pictureFromMap` returns a single band and the hero draws what it always drew.
   */
  const coverPicture = pictureFromMap(
    craft.coverId,
    coverFraming,
    withBaseAsset(framingMedia, craft.coverId, craft.cover)
  );

  /**
   * "Related" is the four connections an editor actually RECORDED — the region, the school, a shared
   * material, a shared technique — and nothing cleverer. A similarity score over an archive this size
   * guesses more often than it knows, and a guess presented as a relationship is a claim the Centre
   * never made.
   *
   * ONE QUERY, and it replaced two: this block used to run a `count()` beside the list so the "see the
   * rest" link could carry a real total. Taking one row more than the cap answers the same question —
   * "are there others?" — for the price of a row rather than a second round trip to the database, on
   * every craft page, for a block at the foot of it.
   *
   * ⚠ THE CLAUSES ARE AN EXPLICIT ARRAY, NOT A LIST OF CONDITIONALS WITH GAPS IN IT. `{}` inside an
   * `OR` matches every published craft, so a craft with no region would quietly relate to the entire
   * archive; `hasSome: []` is the opposite trap and matches nothing, which is why the two array clauses
   * are guarded rather than left to fall through.
   *
   * ⚠ `id: { not: craft.id }` is the point of the whole block. A record listed under its own "related"
   * heading is the classic version of this bug, and it is invisible in testing on an archive of one.
   */
  const relatedClauses: Prisma.CraftWhereInput[] = [];
  if (craft.region) relatedClauses.push({ region: { slug: craft.region.slug } });
  if (craft.school) relatedClauses.push({ school: { slug: craft.school.slug } });
  if (craft.materials.length > 0) relatedClauses.push({ materials: { hasSome: craft.materials } });
  if (craft.techniques.length > 0) {
    relatedClauses.push({ techniques: { hasSome: craft.techniques } });
  }

  const relatedPool =
    relatedClauses.length > 0
      ? await prisma.craft.findMany({
          // The same filter the record itself was loaded with, never a hand-rolled one: a draft craft
          // must not become readable by being related to a published one.
          where: {
            ...liveStatusWhere(),
            id: { not: craft.id },
            OR: relatedClauses
          },
          orderBy: [{ isFeatured: "desc" }, { name: "asc" }, { slug: "asc" }],
          // One MORE than the cap. See RELATED_LIMIT.
          take: RELATED_LIMIT + 1,
          select: {
            slug: true,
            name: true,
            localName: true,
            localNameLang: true,
            summary: true
          }
        })
      : [];

  const relatedTruncated = relatedPool.length > RELATED_LIMIT;

  const relatedItems: RelatedItem[] = relatedPool.slice(0, RELATED_LIMIT).map((entry) => ({
    href: `${EXPLORER_PATH}/${entry.slug}`,
    kind: "Craft",
    title: entry.localName ? (
      <>
        {entry.name}
        <span
          // The `lang` switch, on every card that carries a local name. See the file header.
          lang={entry.localNameLang ?? undefined}
          className="mt-1 block text-base font-medium text-ink-500"
        >
          {entry.localName}
        </span>
      </>
    ) : (
      entry.name
    ),
    // Truncated HERE, on the server. A CSS line clamp would hide the tail from sighted readers while
    // leaving it in the accessibility tree, so the two disagree about what the card says.
    summary: entry.summary ? truncateWords(entry.summary, 140) : undefined
  }));

  /**
   * Which of the four connections this craft actually has, as a sentence.
   *
   * Assembled rather than fixed, because the wording is a description of the query that just ran: a
   * craft with no school must not be told its related list came from one, or the absences on the page
   * stop meaning anything.
   */
  const relatedBasis = joinWithOr([
    craft.region ? "the same region" : null,
    craft.school ? "the same school" : null,
    craft.materials.length > 0 ? "a material" : null,
    craft.techniques.length > 0 ? "a technique" : null
  ]);

  /**
   * Where the rest of them are. The explorer filters by region and by school, so the link goes to the
   * narrowest listing this craft can name — and to the unfiltered explorer when a material or a
   * technique was the only thing that matched, because there is no single facet that holds them all.
   */
  const relatedMoreTarget = craft.region
    ? {
        href: `${EXPLORER_PATH}?region=${encodeURIComponent(craft.region.slug)}`,
        label: `Every craft recorded in ${craft.region.name}`
      }
    : craft.school
      ? {
          href: `${EXPLORER_PATH}?school=${encodeURIComponent(craft.school.slug)}`,
          label: `Every craft in the ${craft.school.name} school`
        }
      : { href: EXPLORER_PATH, label: "Browse the whole craft explorer" };

  const facts: DefinitionItem[] = [
    {
      term: "Region",
      value: craft.region?.name ?? null,
      href: craft.region
        ? `${EXPLORER_PATH}?region=${encodeURIComponent(craft.region.slug)}`
        : undefined
    },
    { term: "Place type", value: craft.region?.level ? craft.region.level.toLowerCase() : null },
    {
      term: "School",
      value: craft.school?.name ?? null,
      href: craft.school
        ? `${EXPLORER_PATH}?school=${encodeURIComponent(craft.school.slug)}`
        : undefined
    },
    {
      term: "First recorded",
      // `0` is a real year and a real fact, which is why this tests for null rather than for falsiness
      // (DefinitionList makes the same distinction).
      value: craft.originYear !== null ? formatOriginYear(craft.originYear) : null,
      note: craft.originNote ?? undefined
    },
    {
      term: "Period",
      // Only when there is no year to carry the note already.
      value: craft.originYear === null ? craft.originNote : null
    },
    {
      term: "Recorded position",
      value:
        typeof craft.latitude === "number" && typeof craft.longitude === "number"
          ? `${craft.latitude.toFixed(4)}, ${craft.longitude.toFixed(4)}`
          : null,
      note: "Latitude and longitude, as recorded during fieldwork."
    }
  ];

  return (
    <>
      <PageHero
        eyebrow={craft.region ? craft.region.name : "Craft record"}
        title={
          <>
            {craft.name}
            {craft.localName ? (
              <span
                // The `lang` switch. See the file header.
                lang={craft.localNameLang ?? undefined}
                className="mt-3 block text-2xl font-medium text-ink-500 sm:text-3xl"
              >
                {craft.localName}
              </span>
            ) : null}
          </>
        }
        description={craft.summary}
        media={craft.cover}
        picture={coverPicture}
        breadcrumbs={[
          { name: "Home", href: "/" },
          { name: "Craft Explorer", href: EXPLORER_PATH },
          { name: craft.name, href: `${EXPLORER_PATH}/${craft.slug}` }
        ]}
        meta={
          <>
            {/*
              ⚠ THE NOTE WINS OVER THE YEAR, and that order is the whole point of having both.
              
              `originYear` is a CENTURY MARKER for almost every record in this archive — patola is
              stored as 1500 meaning "documented from the sixteenth century", bidriware as 1400.
              `originNote` is where the real precision lives, written by a person. Showing the bare
              number and dropping the note — which is what this did — publishes "1500" as though
              somebody had dated the craft to that year, which is exactly the confident wrongness a
              craft archive cannot afford. The definition list below already showed both; this line,
              which is the one most readers see, showed only the misleading half.
              
              The year is still the fallback, because a record with a year and no note has nothing
              better to offer, and it remains the value the timeline sorts on.
            */}
            {craft.originNote ? (
              <span>{craft.originNote}</span>
            ) : craft.originYear !== null ? (
              <span>{formatOriginYear(craft.originYear)}</span>
            ) : null}
            {craft.school ? <span>{craft.school.name}</span> : null}
            {craft.latitude === null || craft.longitude === null ? (
              <span className="inline-flex items-center gap-1.5">
                <MapPin aria-hidden="true" className="h-3.5 w-3.5" />
                No recorded location
              </span>
            ) : null}
          </>
        }
      />

      <div className="shell pb-24">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-16">
          <div className="min-w-0">
            {/*
              THE CRAFT'S OWN DESCRIPTION — the one long passage of writing on this page.

              Tested through the parser rather than for truthiness. A `Json` column holding `{}` or an
              empty Tiptap document is truthy and renders NOTHING, which would leave neither the body
              nor the sentence explaining its absence — a blank gap where a description should be.

              ══════════════════════════════════════════════════════════════════════════════════════
              ⚠ IT IS `ProseArticle` AND NOT A BARE `RichText`, AND THAT IS THE FIX RATHER THAN A TIDY-UP.
                This page used to render `<RichText value={craft.body} className="prose-measure" />`
                directly — the ONE long-form surface on the site that bypassed the wrapper. Everything
                the house typesetting system does lives on the element `ProseArticle` puts around the
                renderer (`.prose-typeset` plus the `ts-*` classes, see lib/typography/typeset.ts), so
                bypassing it did not mean "styled a little more plainly". It meant a craft record got:
                no house reading face, no house measure, no house size or leading, no heading rhythm —
                the single most visible thing the recipe does — no `text-wrap: pretty`, no hyphenation
                even where the Centre had turned it on, and no lead paragraph, pull quote, side note or
                drop cap at the size the editor's Style menu promised. Every OTHER record type on the
                site (news, people, projects, research, events) got all of it. A reader moving from an
                article to a craft record was reading two differently-set publications.

              ⚠ THE WRAPPER DOES NOT DISTURB THIS PAGE'S LAYOUT, WHICH IS THE THING WORTH CHECKING ON A
                PAGE THAT ALSO CARRIES A MAP, A 3D ARTEFACT VIEWER AND COMPARISON SLIDERS. Three
                reasons, all structural rather than hopeful:
                  • `ProseArticle` renders ONE `<div>` carrying `prose-measure` + `ts-measure-*`. That
                    is the same constraint the `prose-measure` on `RichText` used to apply — the class
                    is literally included by `typesetMeasureClassName` — so the column's width is
                    unchanged for a site on the default Standard measure, and follows Settings for one
                    that has changed it.
                  • It is deliberately NOT centred (see its header), so the left edge stays where it
                    was and nothing shifts against the `18rem` sidebar in the grid above.
                  • The map, the artefact viewer and the before/after sliders are SIBLINGS of this
                    block, further down the same column — not children of it. Nothing they do is
                    inherited from a box they are not inside. (The `ts-*` classes work by setting custom
                    properties, which DO inherit, so this mattered enough to check rather than assume.)

              ⚠ THE FALLBACK STAYS OUTSIDE THE COMPONENT rather than becoming its `fallback` prop, and
                that is deliberate too: `ProseArticle` returns a bare fallback with NO column wrapper
                when a record has neither a body nor children, so handing it this sentence would drop
                the `prose-measure` and set an apology at the full width of the column. `hasBody` is
                also read once above and answers this branch and the parser question together.
              ══════════════════════════════════════════════════════════════════════════════════════
            */}
            {hasBody ? (
              <Reveal as="section" className="min-w-0">
                <ProseArticle value={craft.body} />
              </Reveal>
            ) : (
              <p className="prose-measure text-base leading-relaxed text-ink-500">
                No description has been written for this craft yet. The details beside this note are
                everything the archive currently records.
              </p>
            )}

            {craft.materials.length > 0 || craft.techniques.length > 0 ? (
              <Reveal as="section" className="mt-12 flex flex-col gap-6">
                <h2 className="display-title text-2xl">Materials and techniques</h2>

                {craft.materials.length > 0 ? (
                  <div>
                    <h3 className="field-label">Materials</h3>
                    <TagList
                      tags={craft.materials.map((material) => ({
                        label: material,
                        /**
                         * ⚠ THE LABEL IS THE STORED SPELLING; THE LINK CARRIES ITS SLUG.
                         *
                         * `Craft.materials` and `Craft.techniques` are free text, so "Natural indigo"
                         * is stored exactly as an editor typed it. The explorer keys its facets by
                         * `slugify(value)` and maps a slug back to every spelling that produces it, so
                         * a raw spelling in the query string matches nothing at all — and because the
                         * explorer decides it is "filtering" from the parameter rather than from the
                         * clause it managed to build, the reader would be shown the entire archive
                         * under a heading claiming it was narrowed. The region and school chips above
                         * already pass a `.slug`; these two are the same link with a different key.
                         */
                        href: `${EXPLORER_PATH}?material=${encodeURIComponent(slugify(material))}`
                      }))}
                      label="Materials"
                      className="mt-2"
                    />
                  </div>
                ) : null}

                {craft.techniques.length > 0 ? (
                  <div>
                    <h3 className="field-label">Techniques</h3>
                    <TagList
                      tags={craft.techniques.map((technique) => ({
                        label: technique,
                        // Slugged for the same reason as the materials above.
                        href: `${EXPLORER_PATH}?technique=${encodeURIComponent(slugify(technique))}`
                      }))}
                      label="Techniques"
                      className="mt-2"
                    />
                  </div>
                ) : null}
              </Reveal>
            ) : null}

            {pairs.length > 0 ? (
              <section className="mt-16">
                <SectionHeading
                  title="Before and after conservation"
                  description="Drag the handle, or use the arrow keys, to move between the two states. Both are photographs of the same object."
                  className="mb-8"
                />

                <div className="flex flex-col gap-10">
                  {pairs.map((pair) => (
                    <BeforeAfterSlider
                      key={`${pair.before.id}-${pair.after.id}`}
                      before={pair.before.item}
                      after={pair.after.item}
                      caption={pair.after.caption ?? pair.before.caption ?? undefined}
                      sizes="(min-width: 1024px) 46rem, 100vw"
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {singles.length > 0 ? (
              <section className="mt-16">
                <SectionHeading
                  title="Gallery"
                  description={`${singles.length} ${singles.length === 1 ? "photograph" : "photographs"} from the archive. Open one to see it full screen.`}
                  className="mb-8"
                />

                <MediaLightboxProvider
                  items={singles.map((placement) => placement.item)}
                  label={craft.name}
                >
                  <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                    {singles.map((placement, index) => {
                      const alt = mediaAlt(placement.item);
                      return (
                        <figure key={placement.id} className="min-w-0">
                          <div className="relative">
                            <MediaImage
                              media={placement.item}
                              picture={placement.picture}
                              aspect="4 / 3"
                              rounded="lg"
                              sizes="(min-width: 1024px) 22rem, (min-width: 640px) 45vw, 92vw"
                              className="border border-line-200"
                            />
                            {/*
                              THE TRIGGER IS DECLARED AFTER THE PICTURE. MediaImage renders a
                              `position: relative` frame, and positioned elements paint in DOM order
                              with no z-index anywhere on this page (contract §6) — an overlay before
                              it would sit under the photograph and swallow nothing.
                            */}
                            <LightboxTrigger
                              index={index}
                              label={`Open image ${index + 1} of ${singles.length} full screen${alt ? `: ${alt}` : ""}`}
                              className="absolute inset-0"
                            />
                          </div>

                          {placement.caption ? (
                            <figcaption className="mt-2 text-sm leading-relaxed text-ink-500">
                              {placement.caption}
                            </figcaption>
                          ) : null}
                        </figure>
                      );
                    })}
                  </div>
                </MediaLightboxProvider>
              </section>
            ) : null}

            {/* Rendered ONLY when a model is recorded. Never an empty canvas (Artifact3D's header). */}
            {craft.modelObjectKey ? (
              <section className="mt-16">
                <SectionHeading
                  title="The artefact in three dimensions"
                  className="mb-8"
                />
                <Artifact3D objectKey={craft.modelObjectKey} title={craft.name} />
              </section>
            ) : null}
          </div>

          <aside className="min-w-0">
            <div className="lg:sticky lg:top-24">
              {hasVisibleDefinitions(facts) ? (
                <div className="rounded-lg border border-line-200 bg-surface-50 p-6">
                  <h2 className="display-title text-lg">Details</h2>
                  <DefinitionList items={facts} className="mt-4" />
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-line-200 bg-surface-50 p-6">
                  <h2 className="display-title text-lg">Details</h2>
                  <p className="mt-2 text-sm leading-relaxed text-ink-500">
                    No region, school or date has been recorded against this craft yet.
                  </p>
                </div>
              )}

              {craft.school?.description ? (
                <div className="mt-6 rounded-lg border border-line-200 bg-card p-6">
                  <h2 className="field-label flex items-center gap-1.5">
                    <Layers aria-hidden="true" className="h-3.5 w-3.5" />
                    {craft.school.name}
                  </h2>
                  <p className="mt-2 text-sm leading-relaxed text-ink-700">
                    {craft.school.description}
                  </p>
                </div>
              ) : null}
            </div>
          </aside>
        </div>

        {/*
          Rendered unconditionally: `RelatedContent` returns null when there is nothing to relate, so a
          craft with no neighbours ends on its own last section rather than under a "Related crafts"
          heading with an apology beneath it.
        */}
        <RelatedContent
          className="mt-20"
          heading="Related crafts"
          description={`Other published crafts that share ${relatedBasis} with this one.`}
          items={relatedItems}
          more={
            relatedTruncated
              ? {
                  note: `More than these ${RELATED_LIMIT} crafts are connected to this one.`,
                  ...relatedMoreTarget
                }
              : undefined
          }
        />
      </div>
    </>
  );
}
