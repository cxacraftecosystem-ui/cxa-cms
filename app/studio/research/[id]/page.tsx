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
import {
  ResearchAreaEditor,
  type ResearchAreaFormValue,
  type EditorMedia
} from "./ResearchAreaEditor";

/**
 * One research area — the editor's shell.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `/studio/research/new` IS THIS SAME ROUTE. There is no separate "new" segment: the id `new` means
 * "nothing has been created yet", which is how the dashboard's "New …" links already work
 * (`components/studio/StudioNav.ts`, `app/studio/page.tsx`). One screen means one set of fields, one
 * set of validation rules and no chance of the two drifting apart.
 *
 * THE GUARD IS THE FIRST STATEMENT and it throws rather than rendering (contract §1.8).
 *
 * THIS FILE READS AND FRAMES; `ResearchAreaEditor.tsx` EDITS. The form is controlled React state with
 * autosave and dirty tracking (contract §10), which only a client component can hold; the permission
 * check and the database read only a Server Component can do. Everything crossing between them is
 * plain data.
 *
 * ⚠ NO `loading.tsx` MAY BE ADDED ABOVE THIS SEGMENT. It would flush the response headers as `200 OK`
 * before the `notFound()` below could decide otherwise, and a citation pointing at a withdrawn area
 * would appear to resolve (contract §13a).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Research area"
};

/** A blank area. Sort order 0 puts a new one at the top, where the reader can see what they just made. */
function blankValue(): ResearchAreaFormValue {
  return {
    title: "",
    slug: "",
    summary: "",
    body: null,
    icon: "",
    accentColor: "",
    cover: null,
    // Null, never an empty framing: six untouched buckets would be a decision nobody made, and the
    // autosave compares serialised snapshots (see `emptyScreenFraming` in lib/media/screens.ts).
    coverScreens: null,
    // Text, not a number: the editor holds every numeric field as typed so a half-typed value — an
    // empty box, a lone minus sign — survives the keystroke it was typed in.
    sortOrder: "0",
    status: "DRAFT",
    publishedAt: null,
    // On by default: a broken link is worse than an unnecessary redirect, and the server only acts on
    // this when a published address actually changes.
    createRedirect: true
  };
}

export default async function StudioResearchAreaPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireStudioCapability(
    canManageResearch,
    "Research areas need researcher access or higher. An administrator can raise yours."
  );

  const { id } = await params;
  const isNew = id === "new";

  const area = isNew
    ? null
    : await prisma.researchArea.findFirst({
        // `deletedAt: null` in the WHERE, not checked afterwards: a row in the recycle bin is not
        // editable here, and the recycle-bin screen is where it can be restored from.
        where: { id, deletedAt: null },
        select: {
          id: true,
          title: true,
          slug: true,
          summary: true,
          body: true,
          icon: true,
          accentColor: true,
          sortOrder: true,
          status: true,
          publishedAt: true,
          // The shared image columns — variants smallest first, so `pickVariant` can walk up — plus
          // `fileName`, which the preview thumbnail prints beside the picture.
          cover: { select: { ...MEDIA_IMAGE_SELECT_WITH_ID, fileName: true } },
          // The framing beside the picture it frames, so the panel reopens on what is stored rather than
          // on six empty buckets.
          coverScreens: true,
          _count: {
            select: {
              projects: { where: { deletedAt: null } },
              publications: { where: { deletedAt: null } }
            }
          }
        }
      });

  if (!isNew && !area) notFound();

  const cover: EditorMedia | null = area?.cover
    ? {
        id: area.cover.id,
        fileName: area.cover.fileName,
        altText: area.cover.altText,
        objectKey: area.cover.objectKey,
        width: area.cover.width,
        height: area.cover.height,
        blurDataUrl: area.cover.blurDataUrl,
        // The crop travels with the row: a field not named here is a field MediaImage never sees.
        cropX: area.cover.cropX ?? null,
        cropY: area.cover.cropY ?? null,
        cropWidth: area.cover.cropWidth ?? null,
        cropHeight: area.cover.cropHeight ?? null,
        variants: area.cover.variants
      }
    : null;

  const initialValue: ResearchAreaFormValue = area
    ? {
        title: area.title,
        slug: area.slug,
        summary: area.summary ?? "",
        body: area.body,
        icon: area.icon ?? "",
        accentColor: area.accentColor ?? "",
        cover,
        // A cast, not a parse: `Prisma.JsonValue` carries no shape, the route validates what goes in, and
        // the panel reads every bucket defensively (lib/media/screens.ts).
        coverScreens: (area.coverScreens ?? null) as unknown as ScreenFraming | null,
        sortOrder: String(area.sortOrder),
        status: area.status,
        // An ISO string, because that is what crosses the wire and what StatusControl reads.
        publishedAt: area.publishedAt?.toISOString() ?? null,
        createRedirect: true
      }
    : blankValue();

  const filedUnder = area ? area._count.projects + area._count.publications : 0;

  return (
    <div className="mx-auto w-full max-w-[72rem]">
      <StudioPageHeader
        title={isNew ? "New research area" : (area?.title ?? "Research area")}
        description={
          isNew
            ? "A theme the Centre works on. Fill in the name and a summary, then file projects and publications under it from their own screens."
            : "Everything on this screen appears on the research page and on the area's own page. Projects and publications filed under it are managed from their own screens."
        }
        back={{ href: "/studio/research", label: "Research areas" }}
        breadcrumb={[
          { label: "Research areas", href: "/studio/research" },
          { label: isNew ? "New" : (area?.title ?? "Research area") }
        ]}
        meta={
          area ? (
            <>
              <StatusBadge status={area.status} size="sm" />
              <span className="text-xs tabular-nums text-ink-500">
                {filedUnder === 1 ? "1 record filed here" : `${filedUnder} records filed here`}
              </span>
            </>
          ) : null
        }
        actions={
          // Only offered when there is actually something at the address. A "View on the site" link on
          // a draft leads to a "page not found", which reads as a broken CMS rather than as a draft.
          area && area.status === "PUBLISHED" ? (
            <LinkButton
              href={`/research/${area.slug}`}
              variant="secondary"
              icon={ExternalLink}
              newTab
            >
              View on the site
            </LinkButton>
          ) : null
        }
      />

      <ResearchAreaEditor
        areaId={area?.id ?? null}
        initialValue={initialValue}
        siteUrl={siteUrl()}
        // The file store not being set up is a real state on a fresh installation. The picker says so
        // rather than failing silently at the moment somebody tries to upload.
        storageReady={storageConfigured()}
        canPublish={canPublish(user)}
        canDelete={canManageResearch(user)}
      />
    </div>
  );
}
