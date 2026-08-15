import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { ExternalLink } from "lucide-react";

import { listRevisions } from "@/lib/audit";
import { requireStudioCapability } from "@/lib/auth/current-user";
import { buildQuery } from "@/lib/client/fetcher";
import { isLive } from "@/lib/content";
import { prisma } from "@/lib/db";
import { siteName, siteUrl, storageConfigured } from "@/lib/env";
import { PAGE_PREVIEW_QUERY_KEY, pagePath, pagePreviewToken } from "@/lib/pages";
import { canManageStructure } from "@/lib/permissions";
import { StatusBadge } from "@/components/ui/StatusBadge";
// The single declared home of the Centre's zone — see its header. Every date this screen prints uses it.
import { CENTRE_TIME_ZONE } from "@/components/site/EventDateBlock";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import type { BuilderSection } from "@/components/studio/builder/SectionCard";
import { PageEditor, type PageSettingsValue } from "./PageEditor";

/**
 * The page editor.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A SERVER COMPONENT THAT DECIDES EVERY FACT, AND HANDS THE BEHAVIOUR TO ONE CLIENT COMPONENT.
 *
 * `requireStudioCapability(canManageStructure)` is the first statement, and it THROWS rather than rendering a
 * screen of controls the handlers would refuse (contract §1.8). Everything that needs the database — the
 * row, its blocks in order, its version history, the preview token — is read here; `PageEditor` owns the
 * typing, the saving and the lock.
 *
 * ⚠ THE DATES ARRIVE AS ISO STRINGS, NOT `Date` OBJECTS. `PageSettingsValue` is the shape that also
 * crosses the wire on a save, and a form whose fields were `Date`s on first paint and strings after the
 * first save would work until somebody called `.toISOString()` on one.
 *
 * `notFound()` IS CALLED HERE, so no `loading.tsx` may ever be added to this segment or above it: the
 * fallback flushes the response headers as `200 OK` before the body is decided, and the reader then gets
 * a 404 page inside a successful response (contract §13a).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * `cache()` so `generateMetadata` and the page body — two separate passes over one request — cost one
 * query rather than two. Without it every page editor issues the identical read twice, once to build a
 * browser-tab title.
 */
const loadPage = cache(async (id: string) => {
  return prisma.page.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      title: true,
      slug: true,
      navLabel: true,
      status: true,
      publishedAt: true,
      publishAt: true,
      unpublishAt: true,
      deletedAt: true,
      seoTitle: true,
      seoDescription: true,
      seoImageId: true,
      seoNoIndex: true,
      canonicalUrl: true,
      isSystem: true,
      sortOrder: true,
      seoImage: {
        select: {
          objectKey: true,
          width: true,
          height: true,
          altText: true,
          blurDataUrl: true,
          variants: { select: { label: true, format: true, objectKey: true, width: true } }
        }
      },
      sections: {
        // Ordered in SQL. `PageSection` has `@@unique([pageId, position])` and a dense 0-based ordering
        // maintained by the builder, so this is total.
        orderBy: { position: "asc" },
        select: { id: true, type: true, position: true, label: true, data: true, isVisible: true }
      }
    }
  });
});

export async function generateMetadata({
  params
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const page = await loadPage(id);
  // No `notFound()` here: the page body decides that, and doing it in both places would mean two
  // different renders of the same missing row.
  return { title: page ? page.title : "Page not found" };
}

export default async function StudioPageEditorPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireStudioCapability(
    canManageStructure,
    "Editing a page needs editor access or higher, because a page changes the shape of the public site. An administrator can raise yours."
  );

  const { id } = await params;
  const page = await loadPage(id);
  // A soft-deleted page is in the recycle bin, not merely unpublished. Editing one would let somebody
  // work for an hour on a row that the public site has already stopped serving.
  if (!page) notFound();

  const revisions = await listRevisions("Page", page.id);

  const initial: PageSettingsValue = {
    title: page.title,
    slug: page.slug,
    // The columns are nullable; the form is not. An `undefined` in a controlled input switches it to
    // uncontrolled and React warns, so every optional string arrives as `""`.
    navLabel: page.navLabel ?? "",
    status: page.status,
    publishedAt: page.publishedAt?.toISOString() ?? null,
    publishAt: page.publishAt?.toISOString() ?? null,
    unpublishAt: page.unpublishAt?.toISOString() ?? null,
    seoTitle: page.seoTitle ?? "",
    seoDescription: page.seoDescription ?? "",
    seoImageId: page.seoImageId,
    seoNoIndex: page.seoNoIndex,
    canonicalUrl: page.canonicalUrl ?? "",
    sortOrder: page.sortOrder
  };

  const sections: BuilderSection[] = page.sections.map((section) => ({
    id: section.id,
    type: section.type,
    position: section.position,
    label: section.label,
    // `data` is a JSON column, so it is whatever was last written to it — possibly by an older version
    // of the block's rules. The builder validates it at the door; nothing here assumes a shape.
    data: section.data as unknown,
    isVisible: section.isVisible
  }));

  /**
   * The preview address, COMPLETE with its token.
   *
   * The token is an HMAC of the slug (`lib/pages.ts`), so it is built on the server and never derived in
   * the browser. It is scoped to this one page: a forwarded link exposes this draft and nothing else.
   *
   * ⚠ The preview is served by its own route rather than by the public page, because reading a search
   * parameter inside `app/(site)/[...slug]` would opt every CMS page out of static rendering — see the
   * note on `pagePreviewToken`.
   *
   * ⚠ IT IS `/preview`, NOT `/studio/preview`, AND THE DIFFERENCE IS NOT COSMETIC. This used to point
   * at `/studio/preview/<slug>`, where NO ROUTE EXISTED — so the preview panel, the device widths and
   * the whole live-draft mechanism were a working front end aimed at a 404, and nothing surfaced it
   * because a preview address is a string and `npm run route-check` only resolves `/api/…` literals.
   * The route now lives at `app/(site)/preview/[[...slug]]`, which gives it two properties the studio
   * path could not have: it renders inside the real site layout, so the preview looks like the page
   * rather than like the page inside a sidebar; and it sits outside the middleware's `/studio/*`
   * matcher, so the signed token is genuinely the gate and a preview link can be forwarded.
   */
  const previewBase = page.slug.length > 0 ? `/preview/${page.slug}` : "/preview";
  const previewUrl = `${previewBase}${buildQuery({
    [PAGE_PREVIEW_QUERY_KEY]: pagePreviewToken(page.slug)
  })}`;

  const origin = siteUrl().replace(/\/+$/, "");
  const live = isLive(page);
  const publicPath = pagePath(page.slug);

  return (
    <div className="mx-auto w-full max-w-[100rem] space-y-6">
      <StudioPageHeader
        title={page.title}
        // The single back control on the screen. Nothing else may offer one (StudioPageHeader's header).
        back={{ href: "/studio/pages", label: "Pages" }}
        breadcrumb={[
          { label: "Pages", href: "/studio/pages" },
          { label: page.title }
        ]}
        description={
          <>
            This page answers at{" "}
            <span className="break-all font-mono text-xs text-ink-700">{publicPath}</span>. Content is the
            stack of blocks a reader sees; Settings holds its title and address; Search and sharing is how
            it appears elsewhere.
          </>
        }
        meta={<StatusBadge status={page.status} size="sm" />}
        actions={
          live ? (
            <a
              href={`${origin}${publicPath}`}
              target="_blank"
              rel="noreferrer"
              // Opted out of the unsaved-changes guard: it opens a new tab, so it takes neither the
              // reader nor their typing off this screen.
              data-allow-unsaved=""
              className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-line-200 bg-card px-3.5 py-2 text-sm font-medium text-ink-700 transition hover:border-purple-300 hover:text-purple-700"
            >
              <ExternalLink aria-hidden="true" className="h-4 w-4" />
              View on the site
            </a>
          ) : null
        }
      />

      <PageEditor
        mode="edit"
        pageId={page.id}
        initial={initial}
        initialSeoImage={page.seoImage}
        initialSections={sections}
        isSystem={page.isSystem}
        previewUrl={previewUrl}
        siteOrigin={origin}
        siteName={siteName()}
        // Read here, so `[]` genuinely means "no earlier versions" rather than "not fetched yet"
        // (contract §9). The history panel treats the two as different screens.
        revisions={revisions}
        user={user}
        storageReady={storageConfigured()}
        timeZone={CENTRE_TIME_ZONE}
      />
    </div>
  );
}
