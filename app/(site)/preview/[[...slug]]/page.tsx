import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Eye, TriangleAlert } from "lucide-react";

import { SectionRenderer } from "@/components/sections/SectionRenderer";
import { currentUser } from "@/lib/auth/current-user";
import {
  PAGE_PREVIEW_LIVE_QUERY_KEY,
  PAGE_PREVIEW_LIVE_QUERY_VALUE,
  PREVIEW_DRAFT_FALLBACK_NOTICE,
  previewDraftSections,
  readPreviewDraft
} from "@/lib/pages/preview-draft";
import { getPageForPreview, pageMetadataFor } from "@/lib/pages";
import { resolveSectionData } from "@/lib/sections/resolve";

/**
 * /studio/preview/[[...slug]] — the page as it will look, before anybody else can see it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS ROUTE DID NOT EXIST, AND THE ENTIRE PREVIEW FEATURE WAS DEAD BECAUSE OF IT.
 *
 * `app/studio/pages/[id]/page.tsx` has always built its preview address as
 * `/studio/preview/<slug>?preview=<token>` and handed it to `PreviewFrame`, which renders it in an
 * iframe. There was no route at that path. So the preview panel — the device widths, the light/dark
 * toggle, the reload-on-save, and later the whole live-draft mechanism — was a working front end
 * pointed at a 404.
 *
 * Nothing surfaced it. It typechecks (a preview URL is a STRING), it lints, it builds, and
 * `npm run route-check` deliberately only resolves `/api/…` literals, so a missing PAGE route is
 * outside what it can see. It is the same defect class `docs/OUTSTANDING.md` was written about —
 * "twenty-odd studio routes were called but never existed" — reappearing on the one kind of path
 * that check cannot cover.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ IT LIVES UNDER `(site)`, NOT UNDER `/studio`, AND THE PLACEMENT IS THE DESIGN.
 *
 * Two things follow, and both are what `lib/pages.ts` always described:
 *
 *   1. **The signed token is the gate.** `middleware.ts` matches `/studio/*` only, so this route is
 *      reachable without a session — which is the whole point of signing the slug with the server
 *      secret. A preview link can be sent to a colleague, a funder or a mailing list, and rotating
 *      `JWT_SECRET` invalidates every outstanding one at once.
 *   2. **It looks like the page.** The `(site)` layout gives it the real header, footer and type,
 *      so the preview is the design being reviewed rather than an approximation of it.
 *
 * Putting it under `/studio` — where the address in `app/studio/pages/[id]/page.tsx` used to point —
 * would have wrapped every preview in the CMS chrome: `app/studio/layout.tsx` renders `StudioShell`
 * around every signed-in descendant, and a route group cannot escape a parent layout. An editor
 * would have been reviewing their page inside a sidebar and a top bar that a visitor will never see.
 *
 * ⚠ AN OPTIONAL CATCH-ALL, `[[...slug]]`, because the homepage's slug is the EMPTY STRING. A plain
 * `[...slug]` would not match `/studio/preview` at all, and the homepage is the page most likely to
 * be previewed before publication.
 *
 * ⚠ `forceNoIndex`. An unpublished draft on a stable URL is exactly what a crawler that found the
 * link once will come back for. It is belt and braces behind the middleware, and it costs one
 * argument.
 */

/**
 * Never cached, never prerendered.
 *
 * A preview is one render of one draft for one person, and a cached one would show the previous
 * draft to the next reader — which on a preview screen is indistinguishable from "my edit did not
 * save". `searchParams` alone already forces this; stating it means a later refactor that stops
 * reading them cannot silently make the preview cacheable.
 */
export const dynamic = "force-dynamic";

interface PreviewPageProps {
  params: Promise<{ slug?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** The first value, when a parameter arrives repeated. `?preview=a&preview=b` is not two tokens. */
function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** `["research", "roadmap"]` → `"research/roadmap"`; absent → `""`, which is the homepage. */
function slugOf(segments: string[] | undefined): string {
  return (segments ?? []).join("/");
}

export async function generateMetadata({
  params,
  searchParams
}: PreviewPageProps): Promise<Metadata> {
  const page = await getPageForPreview(slugOf((await params).slug), first((await searchParams).preview));
  if (!page) return { title: "Preview", robots: { index: false, follow: false } };
  return pageMetadataFor(page, { forceNoIndex: true });
}

export default async function PagePreview({ params, searchParams }: PreviewPageProps) {
  /*
   * The session is OPTIONAL here, and that is the consequence of the route living outside `/studio`.
   *
   * The signed token is what authorises the render, so a colleague following a forwarded link with no
   * account sees the page. A SESSION is only needed for the LIVE draft, which is stored per editor —
   * without one there is nobody whose unsaved work this could be, and the saved page is the honest
   * answer. `currentUser()` returns null rather than throwing, which is exactly the shape that needs.
   */
  const user = await currentUser();

  const slug = slugOf((await params).slug);
  const query = await searchParams;

  const page = await getPageForPreview(slug, first(query.preview));

  /*
   * A 404 for BOTH "no such page" and "wrong token", deliberately and identically.
   *
   * Distinguishing them would turn this route into an oracle: a signed-in colleague could learn
   * which unpublished slugs exist by watching which ones answer differently, which is precisely the
   * thing the token is here to prevent.
   */
  if (!page) notFound();

  const wantsLive =
    first(query[PAGE_PREVIEW_LIVE_QUERY_KEY]) === PAGE_PREVIEW_LIVE_QUERY_VALUE;

  const saved = page.sections;
  let sections = saved;
  let notice: string | null = null;
  let unmatched = 0;

  if (wantsLive) {
    // No session means no editor, so there is no draft to look for — not an error, just the saved
    // page, said plainly by the notice below.
    const draft = user ? readPreviewDraft(page.id, user.id) : null;
    if (draft) {
      const merged = previewDraftSections(saved, draft);
      sections = merged.sections;
      unmatched = merged.unmatched;
    } else {
      /*
       * The draft is gone, or was never stored, or this instance is not the one that received it —
       * the store is per-process and says so. Whatever the cause, the reader asked for their unsaved
       * work and is getting the saved page, and SAYING SO IS THE WHOLE POINT. A live preview that
       * silently falls back is a preview showing the wrong page with every signal claiming it is
       * the right one, which is worse than not offering live preview at all.
       */
      notice = PREVIEW_DRAFT_FALLBACK_NOTICE;
    }
  }

  const visible = sections.filter((section) => section.isVisible);
  const resolved = await resolveSectionData(sections);

  return (
    <>
      {/*
        THE BANNER IS PART OF THE PREVIEW, NOT CHROME AROUND IT.

        It is the only thing distinguishing this render from the live site — the page below is
        byte-for-byte what a visitor would get — and an editor who forgets which of the two they are
        looking at is an editor about to report a bug against the wrong page. It scrolls away with
        the content rather than sticking, because a fixed band would cover the top of the very
        design being reviewed.
      */}
      <div className="border-b border-purple-200 bg-purple-50 px-5 py-2.5 text-purple-900 sm:px-8">
        <p className="mx-auto flex max-w-[84rem] flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium">
          <Eye aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span>
            Preview of <span className="font-semibold">{page.title || "Untitled page"}</span> —{" "}
            {wantsLive && !notice
              ? "including changes you have not saved."
              : "the page as it was last saved."}
          </span>
          <span className="text-purple-700">
            This is not on the public site{page.status === "PUBLISHED" ? " under this address" : ""}.
          </span>
        </p>
      </div>

      {notice ? (
        <div className="border-b border-amber-500/40 bg-amber-100 px-5 py-2.5 text-amber-800 sm:px-8">
          <p className="mx-auto flex max-w-[84rem] items-start gap-2 text-xs leading-relaxed">
            <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{notice}</span>
          </p>
        </div>
      ) : null}

      {unmatched > 0 ? (
        /*
          Contract §1.6: a page that quietly renders fewer blocks than the builder shows is
          indistinguishable from a page whose blocks have been deleted. `previewDraftSections`
          counts the blocks it could not place, and this is the only place that number can be said.
        */
        <div className="border-b border-amber-500/40 bg-amber-100 px-5 py-2.5 text-amber-800 sm:px-8">
          <p className="mx-auto flex max-w-[84rem] items-start gap-2 text-xs leading-relaxed">
            <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {unmatched === 1
                ? "One block you have just added is not in this preview yet — save the page to see it."
                : `${unmatched} blocks you have just added are not in this preview yet — save the page to see them.`}
            </span>
          </p>
        </div>
      ) : null}

      {visible.length === 0 ? (
        /*
          An empty page is a real state — a page created a minute ago, or one whose every block is
          switched off — and the preview must say which. Rendering nothing would look like the
          preview itself had failed, which is the report this screen would then generate.
        */
        <div className="shell page-top pb-24">
          <p className="panel p-6 text-sm leading-relaxed text-ink-700">
            This page has no visible blocks yet, so there is nothing to preview. Add a block in the
            builder, or switch one back on, and reload this panel.
          </p>
        </div>
      ) : (
        <SectionRenderer sections={sections} resolved={resolved} />
      )}
    </>
  );
}
