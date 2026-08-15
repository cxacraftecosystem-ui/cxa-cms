import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { requireStudioCapability } from "@/lib/auth/current-user";
import { canManageContent, canPublish } from "@/lib/permissions";
import { siteUrl, storageConfigured } from "@/lib/env";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { AlbumEditor, type AlbumDraft, type AlbumItemDraft } from "./AlbumEditor";

/**
 * One gallery album: its details, and its pictures in the order they will appear.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canManageContent)` IS THE FIRST STATEMENT, and it is the same predicate the
 * `/api/studio/gallery/*` handlers call. A failing check renders nothing at all (contract §1.8).
 *
 * `/studio/gallery/new` IS THIS ROUTE. The dynamic segment matches the word "new", so a create screen
 * and an edit screen are one file — which is the only way they can be guaranteed to offer the same
 * fields, the same help and the same validation. The editor is handed a blank draft with `id: null`,
 * and that null is what decides between a POST and a PATCH when it saves.
 *
 * ⚠ THE `notFound()` BELOW IS WHY THIS SEGMENT AND ITS PARENT MUST NEVER GAIN A `loading.tsx`. A
 * `loading.tsx` wraps the segment in a Suspense boundary, and streaming the fallback flushes the
 * response headers as `200 OK` before the body is decided — so a later `notFound()` renders 404 content
 * under a success status (contract §13a). Inside the studio that would leave an administrator looking at
 * "not found" for an album that a link in their own audit log claims exists.
 *
 * A SOFT-DELETED ALBUM IS "NOT FOUND" HERE, deliberately. A row in the recycle bin is not a draft:
 * editing one would let somebody keep working on an album they believe they have removed, and saving it
 * would resurrect it without ever passing through the restore that an administrator has to authorise.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/** The word that means "make a new one". Kept as a constant so the route and the copy cannot disagree. */
const NEW_ID = "new";

/** How many distinct categories are offered as suggestions. Beyond this the list stops being a help. */
const CATEGORY_SUGGESTION_LIMIT = 40;

export async function generateMetadata({
  params
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  if (id === NEW_ID) return { title: "New album" };

  // A narrow select: this runs as a separate pass from the page body, and reading the whole album twice
  // to build a browser tab title would double every query on the screen.
  const album = await prisma.galleryAlbum.findFirst({
    where: { id, deletedAt: null },
    select: { title: true }
  });
  return { title: album ? album.title : "Album" };
}

/**
 * Everything `<MediaImage>` needs, plus the two facts the editor states in words: what the file is
 * called, and whether anybody has written a description for it.
 */
const itemAssetSelect = {
  id: true,
  kind: true,
  fileName: true,
  objectKey: true,
  width: true,
  height: true,
  altText: true,
  blurDataUrl: true,
  variants: { select: { label: true, format: true, objectKey: true, width: true } }
} satisfies Prisma.MediaAssetSelect;

type ItemAsset = Prisma.MediaAssetGetPayload<{ select: typeof itemAssetSelect }>;

/** A stored picture as the editor holds it. Dates never appear here; a caption and an order do. */
function toItemDraft(row: {
  id: string;
  assetId: string;
  caption: string | null;
  presentation: string;
  tourEntry: string | null;
  asset: ItemAsset;
}): AlbumItemDraft {
  return {
    // The row's own id is the stable key: React reuses the tile's DOM when it moves, so focus follows
    // the picture that moved rather than the position it left.
    key: row.id,
    assetId: row.assetId,
    caption: row.caption ?? "",
    // `presentation` is a free-text column with a default of "image" (schema). An unrecognised value is
    // normalised in the editor rather than here, so the one list of allowed words lives in one file.
    presentation: row.presentation,
    tourEntry: row.tourEntry ?? "",
    asset: {
      id: row.asset.id,
      kind: row.asset.kind,
      fileName: row.asset.fileName,
      objectKey: row.asset.objectKey,
      width: row.asset.width,
      height: row.asset.height,
      altText: row.asset.altText,
      blurDataUrl: row.asset.blurDataUrl,
      variants: row.asset.variants
    }
  };
}

export default async function StudioAlbumPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireStudioCapability(
    canManageContent,
    "Editing the gallery needs editor access or higher. An administrator can raise yours."
  );

  const { id } = await params;
  const creating = id === NEW_ID;

  const [album, categoryRows] = await Promise.all([
    creating
      ? null
      : prisma.galleryAlbum.findFirst({
          where: { id, deletedAt: null },
          select: {
            id: true,
            slug: true,
            title: true,
            description: true,
            category: true,
            location: true,
            credit: true,
            happenedOn: true,
            coverId: true,
            sortOrder: true,
            status: true,
            publishedAt: true,
            tags: true,
            items: {
              orderBy: { position: "asc" },
              select: {
                id: true,
                assetId: true,
                caption: true,
                presentation: true,
                tourEntry: true,
                asset: { select: itemAssetSelect }
              }
            }
          }
        }),
    prisma.galleryAlbum.findMany({
      where: { deletedAt: null, NOT: { category: null } },
      select: { category: true },
      distinct: ["category"],
      orderBy: { category: "asc" },
      take: CATEGORY_SUGGESTION_LIMIT
    })
  ]);

  if (!creating && !album) notFound();

  /**
   * `happenedOn` is rendered as a `date` input, which speaks `YYYY-MM-DD` and nothing else.
   *
   * Sliced from the UTC ISO string rather than from local getters, because the column holds a DAY: an
   * album from the 1st of March in a zone behind UTC would otherwise show as the 28th of February.
   */
  const happenedOn = album?.happenedOn ? album.happenedOn.toISOString().slice(0, 10) : "";

  const draft: AlbumDraft = {
    id: album?.id ?? null,
    slug: album?.slug ?? "",
    title: album?.title ?? "",
    description: album?.description ?? "",
    category: album?.category ?? "",
    location: album?.location ?? "",
    credit: album?.credit ?? "",
    happenedOn,
    coverId: album?.coverId ?? null,
    sortOrder: album?.sortOrder ?? 0,
    status: album?.status ?? "DRAFT",
    publishedAt: album?.publishedAt ? album.publishedAt.toISOString() : null,
    tags: album?.tags ?? [],
    items: (album?.items ?? []).map(toItemDraft)
  };

  const categorySuggestions = categoryRows
    .map((row) => row.category)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  return (
    <div className="mx-auto w-full max-w-[84rem]">
      <StudioPageHeader
        title={creating ? "New album" : draft.title.trim().length > 0 ? draft.title : "Untitled album"}
        description="An album is a set of pictures from one occasion. The order you put them in here is the order a visitor sees, and the first picture is what shows in the gallery listing unless you choose another."
        // The single back control for this screen, and the only one — never a second at the foot of the
        // form (StudioPageHeader's header explains why).
        back={{ href: "/studio/gallery", label: "Gallery" }}
        breadcrumb={[
          { label: "Gallery", href: "/studio/gallery" },
          { label: creating ? "New album" : draft.title || "Album" }
        ]}
      />

      <AlbumEditor
        album={draft}
        // The SAME predicate the route handler enforces, so the control the reader sees and the answer
        // the server gives cannot disagree (contract §1.7).
        canPublish={canPublish(user)}
        storageReady={storageConfigured()}
        siteUrl={siteUrl()}
        categorySuggestions={categorySuggestions}
      />
    </div>
  );
}
