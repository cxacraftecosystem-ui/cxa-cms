/**
 * /gallery/[slug] — one album.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A PANORAMA IS LABELLED AS ONE, IN WORDS AND WITH A GLYPH.
 *
 * `GalleryItem.presentation` records how an item is PRESENTED, which is not always what the asset is —
 * a still frame can introduce a virtual tour (prisma/schema.prisma). Those items are marked with a chip
 * carrying both an icon and the words "360° panorama" or "Virtual tour", because colour and a glyph never
 * carry meaning alone (contract §11) and because a reader who clicks a panorama expecting to look around
 * has been misled by a thumbnail.
 *
 * ⚠ AND THE PAGE SAYS WHAT THE VIEWER ACTUALLY DOES. `MediaLightbox` is a picture viewer: it opens the
 * still frame, not a 360° room and not a tour. A note under the grid states that plainly whenever the
 * album holds such an item, rather than letting a reader discover it by pressing something that does
 * less than it promised. An unrecognised `presentation` value is shown with its raw name for the same
 * reason — a value nobody has a renderer for is still a fact about the record.
 *
 * CREDIT IS PER ITEM; LOCATION IS PER ALBUM. `MediaAsset.credit` belongs to the photograph and is shown
 * under each one; there is no per-item location column in the schema, so `GalleryAlbum.location` is
 * stated once, in the album's own facts. Repeating the album's location under every picture would imply
 * it had been recorded per photograph.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE GRID STAYS ON THE SERVER. `MediaLightboxProvider` holds which picture is open and takes the
 * already-rendered thumbnails as `children`, so `next/image`, the layout and every caption are not
 * shipped to the browser for the sake of one click handler (components/site/MediaLightbox.tsx).
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { ArrowLeft, Compass, Globe, Images, Info, Video, type LucideIcon } from "lucide-react";

import { Reveal } from "@/components/motion";
import { DefinitionList, type DefinitionItem } from "@/components/site/DefinitionList";
import {
  LightboxTrigger,
  MediaLightboxProvider,
  type LightboxItem
} from "@/components/site/MediaLightbox";
import { PageHero } from "@/components/site/PageHero";
import { SectionHeading } from "@/components/site/SectionHeading";
import { ShareRow } from "@/components/site/ShareRow";
import { TagList } from "@/components/site/TagList";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { MediaImage } from "@/components/ui/MediaImage";
import { liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { framingAssets, withBaseAsset } from "@/lib/media/framing";
import { pictureFromMap, type ScreenFraming } from "@/lib/media/screens";
import { MEDIA_FIGURE_SELECT, MEDIA_IMAGE_SELECT } from "@/lib/media/select";
import { absoluteUrl, pageMetadata } from "@/lib/seo";
import { getSettingCached } from "@/lib/settings/service";
import { prerenderParams } from "@/lib/prerender";

/** Albums change rarely; ten minutes is plenty and keeps the pages served from cache. */
export const revalidate = 600;

/** A build-time budget, not a truncation: `dynamicParams` renders the rest on first request. */
const PRERENDER_LIMIT = 200;

/** See app/(site)/gallery/page.tsx — `happenedOn` is a calendar date and is read in UTC everywhere. */
const ALBUM_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC"
});

const albumSelect = {
  id: true,
  slug: true,
  title: true,
  description: true,
  category: true,
  location: true,
  credit: true,
  happenedOn: true,
  tags: true,
  publishedAt: true,
  updatedAt: true,
  cover: { select: MEDIA_IMAGE_SELECT },
  /**
   * The cover's per-screen framing, fetched with the cover it belongs to.
   *
   * ⚠ NOTHING ON THIS PAGE DRAWS THE COVER — the hero deliberately carries no image (see the `PageHero`
   * below), and the tiles are the album's own items. The column is selected anyway because the query that
   * fetches a picture and the query that fetches its framing must never be allowed to drift apart: a
   * cover drawn here later without it would render unframed, silently, on this page alone.
   */
  coverScreens: true,
  items: {
    orderBy: { position: "asc" },
    select: {
      id: true,
      caption: true,
      presentation: true,
      /**
       * The picture's id and THIS ROW's per-screen framing, in the same select as the photograph they
       * frame. `assetId` because a framing resolves by id (`pictureFromMap`) and `id` above is the row's
       * own; the framing is on the row rather than on the file because the same photograph is framed one
       * way in this album and another on a project page.
       */
      assetId: true,
      assetScreens: true,
      // The figure variant: `caption` and `credit` are printed under each photograph here.
      asset: { select: MEDIA_FIGURE_SELECT }
    }
  }
} satisfies Prisma.GalleryAlbumSelect;

interface PresentationSpec {
  label: string;
  icon: LucideIcon;
  tone: BadgeTone;
  /** True when the viewer shows a STILL of something interactive — the note below depends on it. */
  stillOnly: boolean;
}

/**
 * The four presentation kinds the schema documents.
 *
 * `image` has no chip: a photograph in a photograph album needs no label, and a badge on every tile
 * would make the two that matter invisible.
 */
const PRESENTATIONS: Record<string, PresentationSpec> = {
  image: { label: "Photograph", icon: Images, tone: "neutral", stillOnly: false },
  video: { label: "Video", icon: Video, tone: "info", stillOnly: true },
  panorama: { label: "360° panorama", icon: Globe, tone: "info", stillOnly: true },
  tour: { label: "Virtual tour", icon: Compass, tone: "info", stillOnly: true }
};

/**
 * `presentation` is a free-form string column, so an unrecognised value is possible — an import, a newer
 * studio than this renderer. It is shown with its raw name rather than silently treated as a photograph:
 * a label a reader does not recognise is still better than a promise the viewer cannot keep.
 */
function presentationOf(value: string): PresentationSpec {
  const known = PRESENTATIONS[value.trim().toLowerCase()];
  if (known) return known;
  return { label: value.trim() || "Unlabelled item", icon: Info, tone: "warn", stillOnly: true };
}

function albumDate(value: Date | null): string | null {
  if (!value || Number.isNaN(value.getTime())) return null;
  return ALBUM_DATE.format(value);
}

export async function generateStaticParams() {
  // Wrapped so an unreachable database at BUILD time does not fail the deploy — see
  // lib/prerender.ts for why an empty list is a complete fallback here and not a swallowed error.
  return prerenderParams("gallery/[slug]", async () => {
    const albums = await prisma.galleryAlbum.findMany({
      where: liveStatusWhere(),
      orderBy: [{ happenedOn: { sort: "desc", nulls: "last" } }, { title: "asc" }],
      take: PRERENDER_LIMIT,
      select: { slug: true }
    });
    return albums.map((album) => ({ slug: album.slug }));
  });
}

export async function generateMetadata({
  params
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;

  const album = await prisma.galleryAlbum.findFirst({
    where: { slug, ...liveStatusWhere() },
    select: {
      title: true,
      description: true,
      location: true,
      happenedOn: true,
      publishedAt: true,
      updatedAt: true,
      cover: { select: MEDIA_IMAGE_SELECT },
      // Carried for the same reason as in `albumSelect` above. A share card is one fixed-size image with
      // no screen to vary by, so no band of the framing can apply to it — but a select that fetches a
      // picture and leaves its framing behind is the shape of the bug, wherever the row ends up going.
      coverScreens: true,
      _count: { select: { items: true } }
    }
  });

  if (!album) {
    return pageMetadata({ title: "Album not found", path: `/gallery/${slug}`, noIndex: true });
  }

  const when = albumDate(album.happenedOn);
  const count = album._count.items;
  const description =
    album.description?.trim() ||
    // Assembled from what the record actually holds rather than left empty: a share card with no
    // description is a card most platforms render as a title and a grey rectangle.
    [
      `${count} ${count === 1 ? "photograph" : "photographs"}`,
      album.location?.trim() || null,
      when
    ]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(" · ");

  return pageMetadata({
    title: album.title,
    description,
    path: `/gallery/${slug}`,
    image: album.cover,
    type: "article",
    publishedTime: album.publishedAt,
    modifiedTime: album.updatedAt
  });
}

export default async function GalleryAlbumPage({
  params
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const features = await getSettingCached("features");
  if (!features.gallery) notFound();

  const album = await prisma.galleryAlbum.findFirst({
    where: { slug, ...liveStatusWhere() },
    select: albumSelect
  });

  // A missing row and an unpublished one are the same answer to a reader: this address holds nothing.
  if (!album) notFound();

  const when = albumDate(album.happenedOn);
  const path = `/gallery/${album.slug}`;
  const count = album.items.length;

  /**
   * The viewer's item list, in the same order as the grid.
   *
   * ⚠ THE INDEXES MUST MATCH. `LightboxTrigger` opens by index, so every tile in the grid has to have a
   * corresponding entry here — including the panoramas and tours, which open as their still frame.
   * Filtering those out of one list and not the other would open the wrong picture, which is the sort of
   * bug that looks like a broken thumbnail rather than a broken index.
   *
   * ⚠ AND THE PER-SCREEN FRAMING IS DELIBERATELY NOT CARRIED IN HERE, though the tiles below use it. The
   * viewer draws the whole photograph at its OWN proportions (`aspect={ratio}` plus `!object-contain` in
   * MediaLightbox.tsx), so there is no per-width frame for a rectangle to fit — and a crop drawn for a
   * 4:3 tile would trim the picture a reader has just asked to see in full.
   */
  const items: LightboxItem[] = album.items.map((item) => ({
    id: item.id,
    objectKey: item.asset.objectKey,
    width: item.asset.width,
    height: item.asset.height,
    altText: item.asset.altText,
    blurDataUrl: item.asset.blurDataUrl,
    // The crop travels with the row: a field not named here is a field MediaImage never sees.
    cropX: item.asset.cropX ?? null,
    cropY: item.asset.cropY ?? null,
    cropWidth: item.asset.cropWidth ?? null,
    cropHeight: item.asset.cropHeight ?? null,
    variants: item.asset.variants,
    // The PLACEMENT's caption wins over the asset's: the same photograph carries a different caption in
    // one album than it does in another.
    caption: item.caption ?? item.asset.caption,
    credit: item.asset.credit
  }));

  /**
   * The tiles' framings, and ONE query for the whole album.
   *
   * ⚠ THE PANORAMAS AND TOURS ARE FRAMED TOO, because this grid draws every item as a still picture
   * whatever its `presentation` says — the chip beside it is what tells a reader it is more than that. A
   * framing skipped for those would be a control that worked on some tiles and not others.
   *
   * `framingAssets` costs no query when nothing is framed, which is nearly every album, so it is called
   * without a guard (lib/media/framing.ts). The base photograph goes into the same map because
   * `pictureFromMap` looks it up by id like any other band, and with no framing at all each picture
   * resolves to a single band — which `MediaImage` ignores, drawing exactly what it drew before.
   */
  const itemFramings = album.items.map(
    (item) => (item.assetScreens ?? null) as unknown as ScreenFraming | null
  );
  const itemFramingMedia = await framingAssets(...itemFramings);
  const itemPictures = album.items.map((item, index) =>
    pictureFromMap(
      item.assetId,
      itemFramings[index] ?? null,
      withBaseAsset(itemFramingMedia, item.assetId, item.asset)
    )
  );

  const interactiveKinds = album.items
    .map((item) => presentationOf(item.presentation))
    .filter((spec) => spec.stillOnly);

  const facts: DefinitionItem[] = [
    { term: "Collection", value: album.category },
    { term: "Location", value: album.location },
    { term: "Date", value: when },
    { term: "Credit", value: album.credit },
    {
      term: "Pictures",
      // `0` is a value, not an absence — an album nobody has filled yet should say so.
      value: `${count} ${count === 1 ? "item" : "items"}`
    }
  ];

  return (
    <>
      {/*
        NO `media` ON THIS HERO, DELIBERATELY. `GalleryAlbum.cover` is nearly always one of the
        photographs below it, and a hero banner showing the same picture as the first tile reads as a
        rendering fault rather than as a design. The cover earns its keep on the /gallery card, where the
        album's contents are not otherwise visible.
      */}
      <PageHero
        eyebrow={album.category?.trim() || "Album"}
        title={album.title}
        description={album.description ?? undefined}
        breadcrumbs={[
          { name: "Home", href: "/" },
          { name: "Gallery", href: "/gallery" },
          { name: album.title, href: path }
        ]}
        meta={
          <>
            {when && album.happenedOn ? (
              <time dateTime={album.happenedOn.toISOString().slice(0, 10)}>{when}</time>
            ) : null}
            {album.location?.trim() ? <span>{album.location}</span> : null}
            <span>
              {count} {count === 1 ? "picture" : "pictures"}
            </span>
          </>
        }
      />

      <div className="shell pb-24">
        {count === 0 ? (
          <EmptyState
            headingLevel={2}
            icon={Images}
            title="This album is empty"
            description="The album has been published but no pictures have been added to it yet."
            action={
              <LinkButton href="/gallery" variant="secondary" icon={ArrowLeft}>
                Back to the gallery
              </LinkButton>
            }
          />
        ) : (
          <>
            <SectionHeading
              level={2}
              title={`Pictures in ${album.title}`}
              // The `<h1>` already names the album; this heading exists so the grid sits under something
              // in the document outline rather than beside the hero.
              titleClassName="sr-only"
            />

            <MediaLightboxProvider items={items} label={album.title}>
              <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                {album.items.map((item, index) => {
                  const spec = presentationOf(item.presentation);
                  const described =
                    item.asset.altText?.trim() ||
                    item.caption?.trim() ||
                    item.asset.caption?.trim() ||
                    "";
                  const credit = item.asset.credit?.trim();
                  const caption = (item.caption ?? item.asset.caption)?.trim();

                  return (
                    <li key={item.id}>
                      <figure className="min-w-0">
                        {/*
                          DOM ORDER IS LOAD-BEARING: the picture, then the label, then the trigger.
                          Positioned elements paint in DOM order and nothing here carries a z-index
                          (contract §6), so a trigger declared before the picture would be painted over by
                          it and a press would hit nothing. The label is `pointer-events-none` so it
                          cannot swallow the press either, whichever way round the two end up.
                        */}
                        <div className="group relative overflow-hidden rounded-md bg-surface-100">
                          <MediaImage
                            media={item.asset}
                            picture={itemPictures[index] ?? null}
                            aspect="4 / 3"
                            rounded="none"
                            sizes="(min-width: 1024px) 30vw, (min-width: 640px) 45vw, 92vw"
                            // The first row, and only the first row. This page's hero carries no image
                            // (see the PageHero below — the album's cover is already the first tile), so
                            // the top of the grid IS the largest thing painted and the one worth
                            // prioritising. Every tile marked priority would mean none of them was.
                            priority={index < 3}
                            className="w-full"
                            imageClassName="transition-transform duration-500 ease-out group-hover:scale-[1.03]"
                          />

                          {spec.stillOnly ? (
                            <span className="pointer-events-none absolute left-2 top-2">
                              <Badge tone={spec.tone} icon={spec.icon} size="sm">
                                {spec.label}
                              </Badge>
                            </span>
                          ) : null}

                          <LightboxTrigger
                            index={index}
                            // The name says what pressing it DOES, and says which item it is — the alt
                            // text describes the picture, which is a different sentence.
                            label={
                              described
                                ? `Open ${spec.stillOnly ? `the still frame of this ${spec.label.toLowerCase()}` : "image"} ${index + 1} of ${count} full screen: ${described}`
                                : `Open ${spec.stillOnly ? "the still frame of" : "image"} ${index + 1} of ${count} full screen`
                            }
                            className="absolute inset-0 h-full w-full"
                          />
                        </div>

                        {caption || credit || spec.stillOnly ? (
                          <figcaption className="mt-2 text-xs leading-relaxed text-ink-500">
                            {caption}
                            {credit ? (
                              // The photographer, named. An uncredited photograph in an archive is a
                              // rights problem as much as a discourtesy.
                              <span className="text-ink-300">{caption ? " — " : ""}{credit}</span>
                            ) : null}
                          </figcaption>
                        ) : null}
                      </figure>
                    </li>
                  );
                })}
              </ul>
            </MediaLightboxProvider>

            {interactiveKinds.length > 0 ? (
              // SAID, NOT DISCOVERED. See the file header: the viewer opens a still frame, and an item
              // labelled "Virtual tour" would otherwise promise something the press does not deliver.
              <p className="mt-6 flex items-start gap-2.5 rounded-md border border-line-200 bg-surface-50 px-3.5 py-2.5 text-sm leading-relaxed text-ink-700">
                <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" />
                <span>
                  {interactiveKinds.length === 1
                    ? "One item in this album is marked as a panorama, video or tour."
                    : `${interactiveKinds.length} items in this album are marked as panoramas, videos or tours.`}{" "}
                  Opening one here shows its still frame full screen — the interactive version is not
                  played in this viewer.
                </span>
              </p>
            ) : null}
          </>
        )}

        <div className="mt-16 grid gap-12 border-t border-line-200 pt-12 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0">
            <SectionHeading level={2} title="About this album" titleClassName="text-xl" />
            <div className="mt-5">
              <DefinitionList items={facts} layout="inline" />
            </div>

            {album.tags.length > 0 ? (
              <div className="mt-8">
                <p className="field-label">Tagged</p>
                {/* Album tags are free-text strings on the row (`GalleryAlbum.tags`), not `Tag` rows, so
                    there is no archive page to link them to. Plain chips rather than links that lead
                    nowhere. */}
                <TagList tags={album.tags} label="Album tags" className="mt-2.5" />
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-8">
            <div>
              <SectionHeading level={2} title="Share" titleClassName="text-xl" />
              <ShareRow
                className="mt-4"
                url={absoluteUrl(path)}
                title={album.title}
                text={album.description?.trim() || undefined}
                label="Share this album"
              />
            </div>

            <Reveal as="div">
              <LinkButton href="/gallery" variant="secondary" icon={ArrowLeft}>
                All albums
              </LinkButton>
            </Reveal>
          </div>
        </div>
      </div>
    </>
  );
}
