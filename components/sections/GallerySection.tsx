/**
 * GallerySection — albums or photographs from the media library, as a masonry wall, an even grid or
 * a scrolling line.
 *
 * A SERVER COMPONENT, and it stays one. The only interactive part is opening a picture full screen,
 * and that is handled by `MediaLightboxProvider` / `LightboxTrigger`, which take the already-rendered
 * thumbnails as `children`. Making the whole wall a Client Component to get one `onClick` would ship
 * `next/image`, the layout and every caption to the browser (see components/site/MediaLightbox.tsx).
 *
 * IT NEVER QUERIES. Both of its possible row types arrive from the one batched pass in
 * `lib/sections/resolve.ts` — a page renderer spreads `galleryRowsFor(resolved, section.id)` straight
 * into the props. THE GALLERY IS THE ONE BLOCK WHOSE MANUAL IDS CAN NAME ROWS IN TWO DIFFERENT TABLES
 * (albums, or the pictures themselves) depending on `source`, which is why it takes two lists and not
 * one: at most one of them is ever populated.
 *
 * MASONRY IS CSS MULTI-COLUMN, which fills the first column top to bottom before starting the second.
 * The VISUAL order is therefore columnar while the DOM order stays the editor's — which is the right
 * way round: a screen reader and the tab order follow the order the pictures were arranged in, and
 * the eye follows the wall. A JavaScript masonry that reordered the DOM would break that to gain
 * nothing a reader can see.
 *
 * THE CAP IS ALWAYS STATED. `limit` is a number an editor typed, and a wall that quietly stops at
 * twelve of forty is indistinguishable from an album with twelve pictures in it (contract §1.6).
 *
 * ⚠ `GalleryItem.presentation` can say "video", "panorama" or "tour", and this block draws all of
 * them as pictures — which is their still frame, and correct for a taster. The panorama viewer and
 * the virtual tour belong to the full `/gallery` album page, where there is room for them and where a
 * reader has asked for that particular album.
 */

import type { ReactElement } from "react";
import Link from "next/link";
import type { PageSection } from "@prisma/client";
import { Images } from "lucide-react";

import { Reveal } from "@/components/motion";
import { SectionHeading } from "@/components/site/SectionHeading";
import { EntityCard } from "@/components/site/EntityCard";
import {
  LightboxTrigger,
  MediaLightboxProvider,
  type LightboxItem
} from "@/components/site/MediaLightbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { MediaImage } from "@/components/ui/MediaImage";
import type { AlbumRow, GalleryImageRow } from "@/lib/sections/resolve";
import type { GallerySectionData } from "@/lib/sections/schema";
import { cn, truncateWords } from "@/lib/utils";

export interface GallerySectionProps {
  data: GallerySectionData;
  section: PageSection;
  /**
   * Resolved in one batched pass by `lib/sections/resolve.ts`; spread from `galleryRowsFor()`. Never
   * fetched here. At most one of the two lists is populated — see the header.
   */
  albums: AlbumRow[];
  images: GalleryImageRow[];
  /** How many rows match the block's criteria in total, ignoring `limit`. */
  total?: number;
  /** Hand-picked ids that no longer resolve. */
  droppedIds?: number;
}

/** Complete literal class strings — a `columns-${n}` built from a variable is purged (contract §5). */
const MASONRY_COLUMNS: Record<2 | 3 | 4, string> = {
  2: "columns-1 sm:columns-2",
  3: "columns-2 md:columns-3",
  4: "columns-2 md:columns-3 xl:columns-4"
};

const GRID_COLUMNS: Record<2 | 3 | 4, string> = {
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-2 md:grid-cols-3",
  4: "grid-cols-2 md:grid-cols-3 xl:grid-cols-4"
};

/**
 * The `sizes` hint per column count, so the optimiser is not asked for a 1600px file to fill a
 * quarter-width slot on a laptop.
 */
const IMAGE_SIZES: Record<2 | 3 | 4, string> = {
  2: "(min-width: 640px) 42vw, 92vw",
  3: "(min-width: 768px) 28vw, 46vw",
  4: "(min-width: 1280px) 21vw, (min-width: 768px) 28vw, 46vw"
};

/**
 * A date rendered in UTC on purpose.
 *
 * `happenedOn` is a calendar date, not an instant; formatting it in the server's local zone moves a
 * midnight date back a day in every zone west of UTC, which turns "3 March" into "2 March" for
 * everyone. Month and year are enough on a card — the exact day belongs on the album's own page.
 */
const ALBUM_DATE = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  year: "numeric",
  timeZone: "UTC"
});

function formatAlbumDate(value: Date | null): string | null {
  if (!value) return null;
  if (Number.isNaN(value.getTime())) return null;
  return ALBUM_DATE.format(value);
}

export function GallerySection({
  data,
  section,
  albums,
  images,
  total,
  droppedIds = 0
}: GallerySectionProps) {
  const heading = data.heading.trim();
  const eyebrow = data.eyebrow.trim();
  const body = data.body.trim();
  const label = data.ctaLabel.trim();
  const href = data.ctaHref.trim();
  const link = label && href ? { href, label } : undefined;
  const showsHeader = Boolean(heading || eyebrow || body || link);

  const showingAlbums = data.source === "albums";
  const shown = showingAlbums ? albums.length : images.length;
  const matched = total ?? shown;
  const hidden = Math.max(0, matched - shown);

  // With no header of its own the cards are the first thing under the page's `<h1>`, so they take
  // level 2. With one, they sit under its `<h2>` at level 3. Levels never skip (contract §11).
  const cardHeadingLevel = showsHeader ? 3 : 2;
  const columns = data.columns;

  return (
    <section id={`block-${section.id}`} className="py-20 md:py-28">
      <div className="shell">
        {showsHeader ? (
          <Reveal>
            <SectionHeading
              eyebrow={eyebrow || undefined}
              title={heading || "Gallery"}
              description={body || undefined}
              link={link}
              className="mb-10"
              // A block with an introduction but no heading text still needs a heading in the
              // outline. It is taken off screen rather than invented — putting visible copy on the
              // page that no editor wrote is the worse of the two failures.
              titleClassName={heading ? undefined : "sr-only"}
            />
          </Reveal>
        ) : null}

        {shown === 0 ? (
          <EmptyState
            icon={Images}
            headingLevel={cardHeadingLevel}
            title={showingAlbums ? "No albums to show yet" : "No pictures to show yet"}
            description={
              showingAlbums
                ? "Albums appear here once they have been published in the studio."
                : "Pictures appear here once they have been added to this block in the studio."
            }
          />
        ) : showingAlbums ? (
          <AlbumGrid albums={albums} columns={columns} headingLevel={cardHeadingLevel} />
        ) : (
          <PictureWall
            images={images}
            layout={data.layout}
            columns={columns}
            lightbox={data.lightbox}
            label={heading || "Gallery"}
          />
        )}

        <GalleryNote
          hidden={hidden}
          matched={matched}
          dropped={droppedIds}
          noun={showingAlbums ? "albums" : "pictures"}
          link={link}
        />
      </div>
    </section>
  );
}

function AlbumGrid({
  albums,
  columns,
  headingLevel
}: {
  albums: readonly AlbumRow[];
  columns: 2 | 3 | 4;
  headingLevel: 2 | 3;
}) {
  return (
    <div className={cn("grid gap-6", GRID_COLUMNS[columns])}>
      {albums.map((album, index) => {
        const when = formatAlbumDate(album.happenedOn);
        return (
          <Reveal key={album.id} delay={Math.min(index, 8) * 0.05} className="h-full">
            <EntityCard
              href={`/gallery/${album.slug}`}
              media={album.cover}
              eyebrow={album.category ?? undefined}
              title={album.title}
              headingLevel={headingLevel}
              sizes={IMAGE_SIZES[columns]}
              description={album.description ? truncateWords(album.description, 140) : undefined}
              meta={
                <>
                  {when ? <span>{when}</span> : null}
                  {album.location ? <span>{album.location}</span> : null}
                  <span>
                    {album.itemCount} {album.itemCount === 1 ? "picture" : "pictures"}
                  </span>
                </>
              }
            />
          </Reveal>
        );
      })}
    </div>
  );
}

function PictureWall({
  images,
  layout,
  columns,
  lightbox,
  label
}: {
  images: readonly GalleryImageRow[];
  layout: GallerySectionData["layout"];
  columns: 2 | 3 | 4;
  lightbox: boolean;
  label: string;
}) {
  const sizes = IMAGE_SIZES[columns];

  const tile = (item: GalleryImageRow, index: number) => {
    const description = item.altText?.trim() || item.caption?.trim() || "";

    return (
      <figure className="min-w-0">
        {/*
          THE TRIGGER IS AN OVERLAY, NOT A WRAPPER, and the DOM order is load-bearing: the picture
          first, the button after it. `MediaImage` renders a `position: relative` frame and nothing
          here carries a z-index (contract §6), so a button declared BEFORE the picture would be
          painted over by it and a press would hit nothing. It is also the only arrangement that keeps
          the caption out of the button's accessible name and the markup valid — a `<button>` takes
          phrasing content, and the frame is a `<div>`. This is the same shape `EntityCard` uses.
        */}
        <div className={cn("group relative overflow-hidden rounded-md", lightbox && "bg-surface-100")}>
          <MediaImage
            media={item}
            // Masonry keeps each picture's own proportions; grid and carousel crop everything to one
            // shape so the rows line up. That is the whole difference between the layouts.
            aspect={layout === "masonry" ? undefined : "4 / 3"}
            rounded="none"
            sizes={sizes}
            className="w-full"
            imageClassName={
              lightbox
                ? "transition-transform duration-500 ease-out group-hover:scale-[1.03]"
                : undefined
            }
          />

          {lightbox ? (
            <LightboxTrigger
              index={index}
              label={
                description
                  ? `Open image ${index + 1} of ${images.length} full screen: ${description}`
                  : `Open image ${index + 1} of ${images.length} full screen`
              }
              className="absolute inset-0 h-full w-full"
            />
          ) : null}
        </div>

        {item.caption ? (
          <figcaption className="mt-2 text-xs leading-relaxed text-ink-500">
            {item.caption}
            {item.credit ? <span className="text-ink-300"> — {item.credit}</span> : null}
          </figcaption>
        ) : null}
      </figure>
    );
  };

  let wall: ReactElement;

  if (layout === "carousel") {
    wall = (
      // A horizontally scrolling region is focusable so it can be scrolled with the keyboard, and
      // named so a screen reader says what is in it rather than "scrollable region".
      <div
        role="region"
        aria-label={`${label} — scrollable pictures`}
        tabIndex={0}
        className="mask-edges-x flex snap-x snap-mandatory gap-4 overflow-x-auto pb-3"
      >
        {images.map((item, index) => (
          <div key={item.id} className="w-64 shrink-0 snap-start sm:w-80">
            {tile(item, index)}
          </div>
        ))}
      </div>
    );
  } else if (layout === "masonry") {
    wall = (
      <div className={cn("gap-4", MASONRY_COLUMNS[columns])}>
        {images.map((item, index) => (
          // `break-inside-avoid` keeps a picture and its caption in one column. Without it a caption
          // can be orphaned at the top of the next column, describing a picture that is not there.
          <div key={item.id} className="mb-4 break-inside-avoid">
            {tile(item, index)}
          </div>
        ))}
      </div>
    );
  } else {
    wall = (
      <div className={cn("grid gap-4", GRID_COLUMNS[columns])}>
        {images.map((item, index) => (
          <div key={item.id}>{tile(item, index)}</div>
        ))}
      </div>
    );
  }

  if (!lightbox) return wall;

  // `GalleryImageRow` is flattened onto its asset, so it already satisfies the lightbox's item shape;
  // the annotation is here to make that a checked fact rather than an inference.
  const items: readonly LightboxItem[] = images;

  return (
    <MediaLightboxProvider items={items} label={label}>
      {wall}
    </MediaLightboxProvider>
  );
}

/**
 * The footnote. Two separate facts, and both matter:
 *
 *   • `hidden` — the block is showing fewer rows than match it, because of `limit`.
 *   • `dropped` — hand-picked rows that are no longer published, so the wall is shorter than the
 *     arrangement the editor made and nothing else on the page would say so.
 */
function GalleryNote({
  hidden,
  matched,
  dropped,
  noun,
  link
}: {
  hidden: number;
  matched: number;
  dropped: number;
  noun: "albums" | "pictures";
  link?: { href: string; label: string };
}) {
  if (hidden === 0 && dropped === 0) return null;

  const singular = noun === "albums" ? "album" : "picture";

  return (
    <p className="mt-8 text-sm text-ink-500">
      {hidden > 0 ? (
        <>
          Showing {matched - hidden} of {matched} {noun}.{" "}
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
          {dropped} chosen {dropped === 1 ? `${singular} is` : `${noun} are`} no longer published and{" "}
          {dropped === 1 ? "is" : "are"} not shown.
        </>
      ) : null}
    </p>
  );
}
