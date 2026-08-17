import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { siteUrl, storageConfigured } from "@/lib/env";
import type { ScreenFraming } from "@/lib/media/screens";
import { MEDIA_IMAGE_SELECT_WITH_ID } from "@/lib/media/select";
import { canManageResearch, canPublish } from "@/lib/permissions";
import { LinkButton } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { CraftEditor, type CraftFormValue, type EditorMedia } from "./CraftEditor";

/**
 * One craft record — the editor's shell.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canManageResearch)` IS THE FIRST STATEMENT, and it throws rather than rendering
 * (contract §1.8). `/studio/crafts/new` is this same route.
 *
 * REGIONS AND SCHOOLS ARE READ HERE AS PLAIN LISTS, not through `EntityPicker`. The lookup endpoint
 * knows about the tables that have publication states and public pages; a `CraftRegion` has neither, it
 * is a small taxonomy, and a dropdown of eighty places is a better tool than a search box for it. The
 * lists are capped and the cap is stated on screen (contract §1.6).
 *
 * ⚠ NO `loading.tsx` MAY BE ADDED ABOVE THIS SEGMENT: it would turn the `notFound()` below into a
 * `200 OK` carrying 404 content (contract §13a). Note that `/craft-explorer` is also behind a feature
 * flag, and a flag that gates a surface gates its pages too.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Craft record"
};

/** Enough places and traditions for any real archive. A truncated list is stated on screen. */
const REGION_LIMIT = 200;
const SCHOOL_LIMIT = 200;

/**
 * The shared image columns plus the file name, which the editor prints beside each picture. The rest of
 * the list — including the crop — comes from `MEDIA_IMAGE_SELECT_WITH_ID` so a column added there is
 * fetched here too.
 */
const MEDIA_SELECT = {
  ...MEDIA_IMAGE_SELECT_WITH_ID,
  fileName: true
} as const;

/** `restorationPhase` is a nullable string rather than an enum, so "Before" must read as "before". */
function toPhase(value: string | null): "" | "before" | "after" {
  const phase = value?.trim().toLowerCase();
  if (phase === "before") return "before";
  if (phase === "after") return "after";
  return "";
}

function blankValue(): CraftFormValue {
  return {
    name: "",
    slug: "",
    localName: "",
    localNameLang: "",
    summary: "",
    body: null,
    regionId: "",
    schoolId: "",
    originYear: "",
    originNote: "",
    materialsText: "",
    techniquesText: "",
    latitude: "",
    longitude: "",
    cover: null,
    coverScreens: null,
    media: [],
    modelObjectKey: "",
    isFeatured: false,
    status: "DRAFT",
    publishedAt: null,
    // On by default: a broken link is worse than an unnecessary redirect, and the server only acts on
    // this when a published address actually changes.
    createRedirect: true
  };
}

export default async function StudioCraftPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireStudioCapability(
    canManageResearch,
    "The craft archive needs researcher access or higher. An administrator can raise yours."
  );

  const { id } = await params;
  const isNew = id === "new";

  const [craft, regionRows, schoolRows] = await Promise.all([
    isNew
      ? null
      : prisma.craft.findFirst({
          where: { id, deletedAt: null },
          select: {
            id: true,
            name: true,
            slug: true,
            localName: true,
            localNameLang: true,
            summary: true,
            body: true,
            regionId: true,
            schoolId: true,
            originYear: true,
            originNote: true,
            materials: true,
            techniques: true,
            latitude: true,
            longitude: true,
            modelObjectKey: true,
            isFeatured: true,
            status: true,
            publishedAt: true,
            cover: { select: MEDIA_SELECT },
            coverScreens: true,
            media: {
              // Each row's own framing beside its picture, for the same reason `coverScreens` is above:
              // the panel has to open on what is stored, or the next save posts null back and clears it.
              select: {
                caption: true,
                restorationPhase: true,
                assetScreens: true,
                asset: { select: MEDIA_SELECT }
              },
              orderBy: { position: "asc" }
            }
          }
        }),
    prisma.craftRegion.findMany({
      select: { id: true, name: true, level: true },
      orderBy: { name: "asc" },
      take: REGION_LIMIT + 1
    }),
    prisma.craftSchool.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: SCHOOL_LIMIT + 1
    })
  ]);

  if (!isNew && !craft) notFound();

  const regionsTruncated = regionRows.length > REGION_LIMIT;
  const schoolsTruncated = schoolRows.length > SCHOOL_LIMIT;

  const cover: EditorMedia | null = craft?.cover
    ? { ...craft.cover, variants: craft.cover.variants }
    : null;

  const initialValue: CraftFormValue = craft
    ? {
        name: craft.name,
        slug: craft.slug,
        localName: craft.localName ?? "",
        localNameLang: craft.localNameLang ?? "",
        summary: craft.summary ?? "",
        body: craft.body,
        regionId: craft.regionId ?? "",
        schoolId: craft.schoolId ?? "",
        // Text, so a lone minus sign — the first keystroke of every BCE year — survives being typed.
        originYear: craft.originYear === null ? "" : String(craft.originYear),
        originNote: craft.originNote ?? "",
        materialsText: craft.materials.join("\n"),
        techniquesText: craft.techniques.join("\n"),
        latitude: craft.latitude === null ? "" : String(craft.latitude),
        longitude: craft.longitude === null ? "" : String(craft.longitude),
        cover,
        /**
         * The column is `Json?`, so the shape is a claim rather than a proof: the route validates it with
         * `screenFramingField()` on the way in, and the editor's framing panel reads every bucket
         * defensively — a rectangle it cannot use shows as "not set" rather than as a broken row.
         */
        coverScreens: (craft.coverScreens ?? null) as unknown as ScreenFraming | null,
        media: craft.media.map((entry) => ({
          asset: { ...entry.asset, variants: entry.asset.variants },
          caption: entry.caption ?? "",
          phase: toPhase(entry.restorationPhase),
          // A cast rather than a parse, on the same terms as `coverScreens` above it.
          assetScreens: (entry.assetScreens ?? null) as unknown as ScreenFraming | null
        })),
        modelObjectKey: craft.modelObjectKey ?? "",
        isFeatured: craft.isFeatured,
        status: craft.status,
        publishedAt: craft.publishedAt?.toISOString() ?? null,
        createRedirect: true
      }
    : blankValue();

  return (
    <div className="mx-auto w-full max-w-[76rem]">
      <StudioPageHeader
        title={isNew ? "New craft record" : (craft?.name ?? "Craft record")}
        description={
          isNew
            ? "Start with the name and where the craft comes from. Materials, techniques, photographs and a 3D scan can all be added later."
            : "Everything on this screen appears in the craft explorer and on this craft's own page."
        }
        back={{ href: "/studio/crafts", label: "Craft archive" }}
        breadcrumb={[
          { label: "Craft archive", href: "/studio/crafts" },
          { label: isNew ? "New" : (craft?.name ?? "Craft record") }
        ]}
        meta={craft ? <StatusBadge status={craft.status} size="sm" /> : null}
        actions={
          craft && craft.status === "PUBLISHED" ? (
            <LinkButton
              href={`/craft-explorer/${craft.slug}`}
              variant="secondary"
              icon={ExternalLink}
              newTab
            >
              View on the site
            </LinkButton>
          ) : null
        }
      />

      <CraftEditor
        craftId={craft?.id ?? null}
        initialValue={initialValue}
        siteUrl={siteUrl()}
        storageReady={storageConfigured()}
        regions={regionRows.slice(0, REGION_LIMIT).map((region) => ({
          value: region.id,
          // The level is part of the label because "Jaipur" the district and "Jaipur" the cluster are
          // two different places in this archive.
          label: `${region.name} (${region.level.toLowerCase()})`
        }))}
        regionsTruncated={regionsTruncated}
        schools={schoolRows.slice(0, SCHOOL_LIMIT).map((school) => ({
          value: school.id,
          label: school.name
        }))}
        schoolsTruncated={schoolsTruncated}
        canPublish={canPublish(user)}
        canDelete={canManageResearch(user)}
      />
    </div>
  );
}
