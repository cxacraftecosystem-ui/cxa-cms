import type { Metadata } from "next";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { Compass, Search } from "lucide-react";

import { SectionRenderer, sectionsOwnPageTitle } from "@/components/sections/SectionRenderer";
import { PageHero } from "@/components/site/PageHero";
import { LinkButton } from "@/components/ui/Button";
import {
  findPageRedirect,
  getPublishedPage,
  listPublishedPageSlugs,
  pageMetadataFor,
  slugFromSegments
} from "@/lib/pages";
import { resolveSectionData } from "@/lib/sections/resolve";
import { prerenderParams } from "@/lib/prerender";

/**
 * Every CMS-driven page that is not the homepage.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A `Page` ROW'S SLUG IS ITS FULL PATH, so this one route serves `/about`, `/about/history` and
 * `/research/roadmap` alike, out of the same builder. The alternative — a file per page — is the thing
 * the section model exists to replace.
 *
 * IT MUST NOT SHADOW THE REAL ROUTES. `/research` is a code route with filtering and pagination, and a
 * `Page` row that claimed it would replace a working listing with a hand-built imitation of one.
 *
 *   • **The mechanism is Next's own resolution order.** A static segment always beats a catch-all, so
 *     `app/(site)/research/page.tsx` answers `/research` and this file never sees the request. That is
 *     not a convention we maintain; it is how the router works.
 *   • **`RESERVED_PREFIXES` below is defence in depth**, and it is about the BUILD rather than the
 *     request: `generateStaticParams` must not offer a path that a code route already prerenders, or
 *     two builders claim one URL in the output. It also gives an editor who saved a shadowed slug a
 *     loud line in the build log instead of a page that is plainly published and plainly unreachable.
 *
 * A MISSING SLUG CHECKS THE `Redirect` TABLE BEFORE IT 404s, and that ordering is the whole reason the
 * table exists. An institutional URL is quoted in papers, syllabi and emails written years earlier, so
 * an editor's "I moved this page" must not break every existing citation.
 *
 * A SERVER COMPONENT reading Prisma directly (contract §9). Nothing here reads a search parameter or a
 * cookie — that would opt every CMS page into per-request rendering and throw away both the prerender
 * and the revalidation below. Preview lives on its own route; see `pagePreviewToken` in lib/pages.ts.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const revalidate = 300;

/**
 * ⚠ LOAD-BEARING, even though it is the default.
 *
 * With `dynamicParams = false` a page published after the last deployment would 404 until somebody
 * redeployed — which turns "publish" into a developer task and makes `revalidate` above pointless.
 * Stating it explicitly keeps it from being "tidied away" by someone who reads it as noise.
 */
export const dynamicParams = true;

/**
 * First path segments that belong to CODE, not to the page builder.
 *
 * Every `app/(site)/*` route in contract §12, plus the two doors to the studio. A `Page` row whose
 * first segment is one of these is skipped by `generateStaticParams` — see the header for why this is
 * belt and braces rather than the mechanism.
 *
 * ⚠ ADD TO THIS LIST WHEN YOU ADD A ROUTE under `app/(site)/`. Forgetting is not a silent failure: the
 * build prints the slug it skipped, and the code route keeps answering regardless.
 */
const RESERVED_PREFIXES = new Set([
  "about",
  "research",
  "projects",
  "publications",
  "people",
  "craft-explorer",
  "gallery",
  "news",
  "events",
  "contact",
  "search",
  // Not in the (site) group, but a prerendered static page at either path would sit in front of the
  // CMS. `/console` is a redirect in next.config.ts; `/studio` is its own route tree.
  "studio",
  "console",
  "api"
]);

/**
 * How many CMS pages to prerender at build time.
 *
 * Beyond this the remaining pages are rendered ON DEMAND and cached — `dynamicParams` above is what
 * makes that safe — so nothing becomes unreachable, it merely misses the head start. The cap exists
 * because a build that prerenders ten thousand pages is a build nobody waits for, and the log line
 * below is what stops the truncation being silent (contract §1.6).
 */
const PRERENDER_LIMIT = 1000;

export async function generateStaticParams(): Promise<{ slug: string[] }[]> {
  // Wrapped so an unreachable database at BUILD time does not fail the whole deploy. See
  // lib/prerender.ts: an empty list means "prerender none of them, render each on first request
  // instead", which is a complete fallback and not a swallowed error.
  return prerenderParams("[...slug]", buildPageParams);
}

async function buildPageParams(): Promise<{ slug: string[] }[]> {
  const slugs = await listPublishedPageSlugs();

  const params: { slug: string[] }[] = [];
  const shadowed: string[] = [];

  for (const slug of slugs) {
    const segments = slug.split("/").filter(Boolean);
    const first = segments[0];
    // `noUncheckedIndexedAccess`: indexing an array yields `string | undefined`, and an empty slug is
    // the homepage's — which this route cannot serve.
    if (!first) continue;

    if (RESERVED_PREFIXES.has(first)) {
      shadowed.push(slug);
      continue;
    }
    params.push({ slug: segments });
  }

  if (shadowed.length > 0) {
    // An editor's mistake, surfaced where a developer will see it. The page exists and is published;
    // it is simply unreachable because a code route owns its address.
    console.warn(
      `[pages] ${shadowed.length} published page(s) use an address that belongs to a built-in route, ` +
        `so they are not prerendered and will not be reachable: ${shadowed.join(", ")}. ` +
        "Give them a different address in Studio → Pages."
    );
  }

  if (params.length > PRERENDER_LIMIT) {
    console.warn(
      `[pages] ${params.length} pages exceeds the ${PRERENDER_LIMIT} prerender limit. The remainder ` +
        "are rendered on demand and cached, which is slower on first visit but otherwise identical."
    );
    return params.slice(0, PRERENDER_LIMIT);
  }

  return params;
}

interface CmsPageProps {
  /** Next 15: dynamic params arrive as a promise and must be awaited before they are read. */
  params: Promise<{ slug: string[] }>;
}

/**
 * Metadata from the row's own SEO fields.
 *
 * ⚠ IT MUST NOT CALL `notFound()` when the row is missing. `generateMetadata` runs alongside the page
 * component, and a 404 raised here would win — before the component has had the chance to check the
 * `Redirect` table. So an unresolved slug returns a `noindex` placeholder instead and lets the
 * component decide between a redirect and a 404. A redirect has no body, so this metadata is never
 * rendered in that case; when it really is a 404, `app/not-found.tsx` renders under it.
 */
export async function generateMetadata({ params }: CmsPageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = await getPublishedPage(slugFromSegments(slug));

  if (!page) {
    return {
      title: "Page not found",
      robots: { index: false, follow: false, googleBot: { index: false, follow: false } }
    };
  }

  // `seoNoIndex` is honoured through `pageMetadataFor`, which sets both `robots` and `googleBot` —
  // setting only the first leaves Google's crawler on its own default (lib/seo.ts).
  return pageMetadataFor(page);
}

export default async function CmsPage({ params }: CmsPageProps) {
  const { slug } = await params;
  const path = slugFromSegments(slug);

  // A catch-all cannot match `/`, so this is only reachable through a path made entirely of empty
  // segments. There is no page to look up and nothing to redirect to.
  if (!path) notFound();

  const page = await getPublishedPage(path);

  if (!page) {
    const moved = await findPageRedirect(path);
    if (moved) {
      // 308 for a permanent move so the new address replaces the old one in caches, bookmarks and
      // search indexes; 307 for a temporary one so it does not. Both preserve the method, which
      // matters for anything that arrives here by POST.
      if (moved.permanent) permanentRedirect(moved.destination);
      redirect(moved.destination);
    }
    notFound();
  }

  const sections = page.sections;
  const hasContent = sections.some((section) => section.isVisible);

  // A published page with every block hidden or none added. NOT a 404: the address is correct, the
  // page is published, and a citation of it is not wrong. NOT a blank frame either — an empty <main>
  // between a header and a footer reads as a site that has broken (contract §1.6). So it says what is
  // true, under the title the editor gave it, and offers the way onward that actually helps.
  if (!hasContent) {
    return (
      <PageHero
        eyebrow="Nothing here yet"
        title={page.title}
        description="This page has been published but nothing has been added to it yet. Searching will usually find what you are after elsewhere on the site."
        actions={
          <>
            <LinkButton href="/search" icon={Search}>
              Search the site
            </LinkButton>
            {/* The same two ways out, with the same icons, as app/not-found.tsx — a reader who has
                landed on both in one session should not have to re-learn the page. */}
            <LinkButton href="/" variant="secondary" icon={Compass}>
              Go to the home page
            </LinkButton>
          </>
        }
      />
    );
  }

  // ONE batched pass for every block on the page (lib/sections/resolve.ts).
  const resolved = await resolveSectionData(sections);

  /**
   * EVERY PAGE NEEDS EXACTLY ONE `<h1>`, AND THIS ROUTE HAS NO HERO OF ITS OWN TO FALL BACK ON.
   *
   * The blocks are the whole page here, so the only heading it can have is one a block draws — and the
   * only block that draws an `<h1>` is a hero WITH A HEADLINE IN IT (`sectionsOwnPageTitle` asks the
   * renderer's own question; see its comment). A page that opens with a text block, or whose hero
   * headline an editor has not written yet, therefore has no title in the document at all: every heading
   * on it starts at level 2 and a screen-reader user has nothing to begin the outline from.
   *
   * The title is supplied VISUALLY HIDDEN rather than as a `PageHero`. A visible band would change the
   * design of every existing page that opens with a text block — and where that block's first line
   * already repeats the page title, it would print it twice. A blank title is left alone: an empty
   * `<h1>` is a rung in the outline with nothing on it.
   */
  const title = page.title.trim();
  const needsTitle = title.length > 0 && !sectionsOwnPageTitle(sections);

  return (
    <>
      {needsTitle ? <h1 className="sr-only">{title}</h1> : null}
      <SectionRenderer sections={sections} resolved={resolved} />
    </>
  );
}
