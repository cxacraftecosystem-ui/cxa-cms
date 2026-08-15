import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { SectionRenderer, sectionsOwnPageTitle } from "@/components/sections/SectionRenderer";
import { PageHero } from "@/components/site/PageHero";
import { SectionHeading } from "@/components/site/SectionHeading";
import { LinkButton } from "@/components/ui/Button";
import { getNavigation } from "@/lib/navigation-server";
import { getPublishedPage, pageMetadataFor } from "@/lib/pages";
import { resolveSectionData } from "@/lib/sections/resolve";
import { pageMetadata } from "@/lib/seo";
import { getSettingCached } from "@/lib/settings/service";
import type { NavNode } from "@/lib/navigation";

/**
 * The home page.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT IS A `Page` ROW LIKE ANY OTHER — that is the entire point of the section model.
 *
 * The homepage's slug is `""` (prisma/schema.prisma, `Page.slug`), and its content is the ordered
 * `PageSection` rows hanging off it. So an administrator rearranges the front page of the institution
 * by dragging blocks in the studio, with no deploy and no developer. Hard-coding a hero and three
 * showcases here would have made the most-edited page on the site the one page nobody can edit.
 *
 * A SERVER COMPONENT THAT READS PRISMA DIRECTLY (contract §9). No state, no handlers, no fetch of our
 * own API over HTTP — the section renderers that need the browser carry their own `"use client"`.
 *
 * WHEN THERE IS NO ROW, THIS IS NOT AN ERROR AND NOT A 404. A database seeded by hand, a fresh
 * install, a restore that has not finished: the homepage still has to be a homepage. So it falls back
 * to a spare, dignified index — the Centre's name, its tagline and the ways into the site, taken from
 * the navigation an administrator has already configured. A 404 at `/` tells a visitor the institution
 * does not exist; an error page tells them it is broken. Neither is true.
 *
 * THE SAME FALLBACK COVERS A ROW WITH NOTHING VISIBLE ON IT, which is the other way to arrive at a
 * blank screen (contract §1.6 — a page that quietly renders nothing is indistinguishable from a page
 * that is broken). A homepage with every block hidden is a homepage in the middle of being built, and
 * a visitor who arrives during that should still be able to reach the research.
 *
 * NOTHING HERE MENTIONS THE STUDIO. The fallback is a page for readers, not a prompt for editors: no
 * visible link on the public site ever points at the CMS (contract §0).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * Five minutes.
 *
 * The homepage is the most-visited and the most-edited page on the site, so it wants both a cached
 * render and a short leash: an editor who publishes a news item expects to see it on the front page
 * without asking anybody to redeploy, and five minutes is short enough to feel like "soon" and long
 * enough that a launch-day traffic spike is served from cache.
 */
export const revalidate = 300;

/** The homepage's stored slug. `""`, not `"home"` — see `Page.slug` in prisma/schema.prisma. */
const HOME_SLUG = "";

/** Used when neither the SEO settings nor a page row have said anything. Specific beats generic. */
const FALLBACK_DESCRIPTION =
  "The research, people, publications and living archive of the Centre of Excellence.";

export async function generateMetadata(): Promise<Metadata> {
  const page = await getPublishedPage(HOME_SLUG);

  // `absoluteTitle` escapes the root layout's `%s · <site name>` template. The homepage's title is
  // almost always the institution's own name, and the template would print it twice.
  if (page) return pageMetadataFor(page, { absoluteTitle: true });

  const [branding, seo] = await Promise.all([
    getSettingCached("branding"),
    getSettingCached("seo")
  ]);
  const title = seo.defaultTitle.trim() || branding.siteName;

  return {
    ...pageMetadata({
      title,
      description: seo.defaultDescription.trim() || branding.tagline.trim() || FALLBACK_DESCRIPTION,
      path: "/"
    }),
    title: { absolute: title }
  };
}

export default async function HomePage() {
  const page = await getPublishedPage(HOME_SLUG);
  const sections = page?.sections ?? [];

  // `isVisible` is checked HERE as well as inside `SectionRenderer` because the question is different:
  // the renderer asks "does this block render?", and this asks "would anything at all render?". A page
  // whose blocks are all switched off must take the fallback rather than produce an empty <main>.
  const hasContent = sections.some((section) => section.isVisible);
  if (!hasContent) return <HomeIndex />;

  // ONE batched pass for every block on the page (lib/sections/resolve.ts). The renderers are pure and
  // never query for themselves, so a four-showcase homepage is one round trip rather than four.
  const resolved = await resolveSectionData(sections);

  /**
   * THE HOME PAGE MUST STILL HAVE AN `<h1>` WHEN ITS HERO HAS NO HEADLINE.
   *
   * `sectionsOwnPageTitle` asks the renderer's own question — "will any block actually draw the
   * heading?" — rather than "is there a hero here?". A homepage whose hero headline is blank, or whose
   * hero is switched off while a showcase block below it is not, has no `<h1>` at all: every heading on
   * it starts at level 2, and the outline a screen-reader user navigates by has no title to begin from.
   *
   * The fallback is the page row's own title — the words an administrator typed in the studio, and the
   * words in the browser tab — rendered VISUALLY HIDDEN. Not a `PageHero`: the blocks the editor
   * arranged are the front page's design, and dropping a title band on top of them would be this file
   * overruling the builder, which is the one thing it exists not to do. A blank title is left alone,
   * because an empty `<h1>` is a rung in the outline with nothing on it.
   */
  const title = page?.title.trim() ?? "";
  const needsTitle = title.length > 0 && !sectionsOwnPageTitle(sections);

  return (
    <>
      {needsTitle ? <h1 className="sr-only">{title}</h1> : null}
      <SectionRenderer sections={sections} resolved={resolved} />
    </>
  );
}

/**
 * The homepage with no homepage: the Centre named, and the ways in.
 *
 * The destinations come from the header navigation rather than a list written here, so an administrator
 * who has configured their menu sees their own sections, and `getNavigation()` already falls back to
 * `DEFAULT_HEADER` when the table is empty — a fresh install therefore still gets a real index instead
 * of an empty grid. The read is `cache()`-wrapped and the site layout has already made it, so this
 * costs nothing.
 *
 * The menu is small by design (at most two levels, contract §8 of lib/navigation.ts) and nothing here
 * caps it, so there is no truncation to declare.
 */
async function HomeIndex() {
  const [branding, navigation] = await Promise.all([getSettingCached("branding"), getNavigation()]);
  const destinations = navigation.header;

  return (
    <>
      <PageHero
        title={branding.siteName}
        description={branding.tagline.trim() || FALLBACK_DESCRIPTION}
        actions={
          <>
            <LinkButton href="/research" icon={ArrowRight} iconPosition="end">
              Explore the research
            </LinkButton>
            <LinkButton href="/contact" variant="secondary">
              Contact the Centre
            </LinkButton>
          </>
        }
      />

      <section className="shell pb-24">
        {/* Level 2: PageHero above owns the page's one <h1> (contract §11). */}
        <SectionHeading
          level={2}
          title="Where to begin"
          description="The main sections of the site."
        />

        <ul className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {destinations.map((node) => (
            <li key={node.id} className="panel p-5">
              <h3 className="font-display text-base font-semibold text-ink-900">
                <NavDestination node={node} />
              </h3>

              {node.children.length > 0 ? (
                <ul className="mt-3 space-y-1.5">
                  {node.children.map((child) => (
                    <li key={child.id}>
                      <NavDestination node={child} muted />
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

/**
 * One navigation destination.
 *
 * `isExternal` is honoured rather than ignored: an external link opened in the same tab loses the
 * reader's place, and one opened in a new tab without saying so loses them entirely — hence the
 * `rel` pair and the spoken suffix (contract §11). `next/link` is for internal paths only; routing an
 * absolute URL through the client router adds prefetching for a page it cannot prefetch.
 */
function NavDestination({ node, muted = false }: { node: NavNode; muted?: boolean }) {
  const className = muted
    ? "text-sm text-ink-500 underline decoration-line-200 underline-offset-4 transition hover:text-purple-700 hover:decoration-purple-700"
    : "text-purple-700 underline decoration-purple-300 underline-offset-4 transition hover:decoration-purple-700";

  if (node.isExternal) {
    return (
      <a href={node.href} className={className} target="_blank" rel="noopener noreferrer">
        {node.label}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }

  return (
    <Link href={node.href} className={className}>
      {node.label}
    </Link>
  );
}
