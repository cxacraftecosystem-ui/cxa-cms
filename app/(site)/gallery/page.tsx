/**
 * /gallery — the albums.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A CARD SAYS HOW MANY PICTURES ARE IN THE ALBUM. That count is the difference between a link somebody
 * follows and a link somebody ignores — "Convocation 2026 · 84 pictures" is a promise, and an unlabelled
 * cover is a gamble. It comes from `_count` on the relation rather than from `items.length`, so no album
 * has to be loaded in full to be listed.
 *
 * DATES ARE FORMATTED IN UTC, DELIBERATELY. `GalleryAlbum.happenedOn` is a CALENDAR DATE, not an
 * instant: it records the day something happened. Formatting a midnight date in the server's local zone
 * moves it back a day everywhere west of UTC, which turns "3 March" into "2 March" for every reader at
 * once. The year filter is derived the same way (`getUTCFullYear`), so the year on a card and the year
 * in the dropdown can never disagree.
 *
 * `features.gallery` GATES THE WHOLE SURFACE — with it off, this page and every album page are 404,
 * matching what the setting promises in lib/settings/schema.ts. The media library itself is untouched.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A Server Component reading Prisma directly. The client pieces are `FilterBar` (with its own
 * Suspense boundary) and the album shelves themselves — `ExpandOnHover` is a hover interaction and
 * cannot be anything else. The shelf receives FINISHED strings only: cover URLs resolved through
 * `mediaSrc` here on the server, titles, and a composed meta line, so the island ships no media
 * plumbing and every album's accessible name is settled before hydration. With no JavaScript the
 * shelf's own `<noscript>` rescue widens the slivers and shows the labels, so the listing is still
 * fully readable (see components/ui/expand-on-hover.tsx).
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { Images, SearchX } from "lucide-react";

import { Reveal } from "@/components/motion";
import { FilterBar, type FilterGroup } from "@/components/site/FilterBar";
import { PageHero } from "@/components/site/PageHero";
import { SectionHeading } from "@/components/site/SectionHeading";
import { LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ExpandOnHover, type ExpandOnHoverItem } from "@/components/ui/expand-on-hover";
import { Pagination } from "@/components/ui/Pagination";
import { liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { mediaAlt, mediaSrc } from "@/lib/media/url";
import { pageMetadata } from "@/lib/seo";
import { getSettingCached } from "@/lib/settings/service";
import { chunk, unique } from "@/lib/utils";

const PAGE_SIZE = 12;
const NOUN = { singular: "album", plural: "albums" } as const;

/**
 * The most books one shelf holds. Not taste: eight collapsed slivers plus one expanded card plus
 * the gaps is ~62rem on desktop, comfortably inside the 84rem `.shell` — a single strip of all
 * twelve would overflow it the moment one expanded. The rows are BALANCED (12 → 6+6, not 8+4), so
 * a partly-filled last shelf never looks like albums failed to load.
 */
const SHELF_SIZE = 8;

const DESCRIPTION =
  "Photographs from the Centre's events, fieldwork and workshops, gathered into albums. Panoramas and " +
  "virtual tours are marked where an album holds them.";

/** See the file header: `happenedOn` is a calendar date and is read in UTC everywhere. */
const ALBUM_MONTH = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  year: "numeric",
  timeZone: "UTC"
});

function albumMonth(value: Date | null): string | null {
  if (!value || Number.isNaN(value.getTime())) return null;
  return ALBUM_MONTH.format(value);
}

const albumCardSelect = {
  id: true,
  slug: true,
  title: true,
  description: true,
  category: true,
  location: true,
  happenedOn: true,
  cover: {
    select: {
      objectKey: true,
      width: true,
      height: true,
      altText: true,
      blurDataUrl: true,
      variants: { select: { label: true, format: true, objectKey: true, width: true } }
    }
  },
  /** The count, not the rows. An album of 300 pictures costs the same to list as one of three. */
  _count: { select: { items: true } }
} satisfies Prisma.GalleryAlbumSelect;

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.length > 0 ? first : null;
}

function pageFrom(value: string | string[] | undefined): number {
  const raw = one(value);
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 1 ? Math.floor(parsed) : 1;
}

function listHref(category: string | null, year: string | null): string {
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  if (year) params.set("year", year);
  const query = params.toString();
  return query.length > 0 ? `/gallery?${query}` : "/gallery";
}

export async function generateMetadata({
  searchParams
}: {
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const params = await searchParams;
  const category = one(params.category);
  const year = one(params.year);
  const page = pageFrom(params.page);
  const filtered = category !== null || year !== null;

  return pageMetadata({
    title: page > 1 ? `Gallery — page ${page}` : "Gallery",
    description: DESCRIPTION,
    path: page > 1 ? `/gallery?page=${page}` : "/gallery",
    // A filtered view is a view, not a destination: there is no page for it to be the canonical copy
    // of, so it stays out of the index rather than competing with /gallery.
    noIndex: filtered,
    keywords: ["photographs", "albums", "panoramas", "virtual tours"]
  });
}

export default async function GalleryIndexPage({
  searchParams
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const category = one(params.category);
  const year = one(params.year);
  const page = pageFrom(params.page);
  const filtered = category !== null || year !== null;

  const features = await getSettingCached("features");
  if (!features.gallery) notFound();

  const clauses: Prisma.GalleryAlbumWhereInput[] = [liveStatusWhere()];
  if (category) clauses.push({ category });

  const yearNumber = year ? Number.parseInt(year, 10) : Number.NaN;
  if (Number.isFinite(yearNumber)) {
    // A UTC range, matching how the year is DERIVED for the dropdown. Mixing a local-zone range with a
    // UTC-derived option list would drop the albums dated 1 January from the year that offers them.
    clauses.push({
      happenedOn: {
        gte: new Date(Date.UTC(yearNumber, 0, 1)),
        lt: new Date(Date.UTC(yearNumber + 1, 0, 1))
      }
    });
  }

  const where: Prisma.GalleryAlbumWhereInput = { AND: clauses };

  const [total, albums, calendar] = await Promise.all([
    prisma.galleryAlbum.count({ where }),
    prisma.galleryAlbum.findMany({
      where,
      /**
       * Most recent first, then the editor's own order, then the title.
       *
       * `nulls: "last"` is load-bearing: Postgres sorts NULLs FIRST on a descending order, so an album
       * with no date would otherwise open the gallery. The title is the final tiebreak so the order is
       * TOTAL — an unstable sort renders a different page on every request and reads as data changing
       * underneath the reader.
       */
      orderBy: [
        { happenedOn: { sort: "desc", nulls: "last" } },
        { sortOrder: "asc" },
        { title: "asc" }
      ],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: albumCardSelect
    }),
    // The filter options, from every live album rather than from the current page — two narrow columns.
    // Independent of the current filters on purpose: a dropdown that removed the other years as soon as
    // one was chosen would be a control that locks itself.
    prisma.galleryAlbum.findMany({
      where: liveStatusWhere(),
      select: { category: true, happenedOn: true }
    })
  ]);

  const categories = unique(
    calendar
      .map((album) => album.category?.trim())
      .filter((value): value is string => typeof value === "string" && value.length > 0)
  ).sort((a, b) => a.localeCompare(b));

  const years = unique(
    calendar
      .map((album) => album.happenedOn)
      .filter((value): value is Date => value !== null && !Number.isNaN(value.getTime()))
      .map((value) => String(value.getUTCFullYear()))
  ).sort().reverse();

  const groups: FilterGroup[] = [];
  if (categories.length > 0) {
    groups.push({
      key: "category",
      label: "Collection",
      control: "select",
      placeholder: "Every collection",
      // The stored string IS the value. It is what a reader sees on the card, so a slugified value would
      // be a second spelling of the same thing and the two would eventually disagree.
      options: categories.map((value) => ({ value, label: value }))
    });
  }
  if (years.length > 1) {
    groups.push({
      key: "year",
      label: "Year",
      control: "select",
      placeholder: "Every year",
      options: years.map((value) => ({ value, label: value }))
    });
  }

  const pastTheEnd = total > 0 && albums.length === 0;
  const href = listHref(category, year);

  /**
   * Albums → shelf items, finished here so the client island receives only strings. The meta line
   * matches what the old card grid stated: month, location, count — and the count stays because
   * "Convocation 2026 · 84 pictures" is a promise where an unlabelled cover is a gamble (header).
   * Zero is a fact, not an absence: an album somebody created and has not filled yet should say so
   * rather than look like a broken card. 1080 targets the `md` derivative — the expanded card is
   * 384px at its widest, so a 2× screen wants ~768px and `pickVariant` rounds up, never down.
   */
  const shelfItems: ExpandOnHoverItem[] = albums.map((album) => {
    const when = albumMonth(album.happenedOn);
    const count = album._count.items;
    const meta = [
      when,
      album.location?.trim() || null,
      `${count} ${count === 1 ? "picture" : "pictures"}`
    ]
      .filter(Boolean)
      .join(" · ");

    return {
      href: `/gallery/${album.slug}`,
      imageSrc: mediaSrc(album.cover, 1080),
      alt: mediaAlt(album.cover),
      title: album.title,
      meta
    };
  });

  // Balanced rows of at most SHELF_SIZE — see its comment for both halves of the arithmetic.
  const shelfRows = Math.max(1, Math.ceil(shelfItems.length / SHELF_SIZE));
  const shelves = chunk(shelfItems, Math.ceil(shelfItems.length / shelfRows));

  return (
    <>
      <PageHero
        eyebrow="Media centre"
        title="Gallery"
        description={DESCRIPTION}
        breadcrumbs={[
          { name: "Home", href: "/" },
          { name: "Gallery", href: "/gallery" }
        ]}
      />

      <div className="shell pb-24">
        {groups.length > 0 ? (
          <FilterBar
            label="Filter the albums"
            groups={groups}
            className="border-y border-line-200 py-6"
          />
        ) : null}

        {pastTheEnd ? (
          <EmptyState
            className="mt-12"
            headingLevel={2}
            icon={SearchX}
            title="That page is past the end of the gallery"
            description={`There are ${total} ${total === 1 ? NOUN.singular : NOUN.plural} in this view, which is fewer than page ${page} would need.`}
            action={
              <LinkButton href={href} variant="secondary">
                Back to the first page
              </LinkButton>
            }
          />
        ) : albums.length === 0 ? (
          <EmptyState
            className="mt-12"
            headingLevel={2}
            icon={filtered ? SearchX : Images}
            title={filtered ? "No albums match these filters" : "There are no albums yet"}
            description={
              filtered
                ? "Try another collection, or another year."
                : "Albums appear here as soon as they are published in the studio."
            }
            action={
              filtered ? (
                <LinkButton href="/gallery" variant="secondary">
                  Clear the filters
                </LinkButton>
              ) : undefined
            }
          />
        ) : (
          <>
            <SectionHeading
              level={2}
              title="Albums"
              // The `<h1>` already says Gallery; this heading is here so the shelves sit under something
              // in the document outline rather than beside the hero.
              titleClassName="sr-only"
              className="mt-12"
            />

            {/* Each shelf is its own strip with its own active card, wrapped in a `Reveal` so the
                entrance stays in the house vocabulary — the strip itself only ever animates the
                user-driven width and scrim, never its own arrival. */}
            <div className="mt-6 flex flex-col gap-4">
              {shelves.map((shelf) => (
                <Reveal as="div" key={shelf[0]?.href ?? "shelf"}>
                  <ExpandOnHover items={shelf} />
                </Reveal>
              ))}
            </div>

            {/* Pagination owns the range sentence, inside its own `role="status"`. Nothing is capped:
                every album is reachable by walking the pages. */}
            <Reveal as="div" className="mt-14">
              <Pagination
                page={page}
                pageSize={PAGE_SIZE}
                totalItems={total}
                baseHref={href}
                label="Gallery"
                itemNoun={NOUN}
              />
            </Reveal>
          </>
        )}
      </div>
    </>
  );
}
