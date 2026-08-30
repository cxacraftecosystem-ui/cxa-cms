import type { Metadata } from "next";
import type { CSSProperties } from "react";
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

  // The fallback index below is still the landing page, so it carries the corner marks too. Their
  // order matters less here — `PageHero` does not bleed — but it is kept the same as the branch
  // below so the two do not have to be reasoned about separately.
  if (!hasContent) {
    return (
      <>
        <HomeIndex />
        <LandingCornerMarks />
      </>
    );
  }

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

      {/* LAST, and not by taste — see LandingCornerMarks: it is out of flow, but `:first-child` is a
          DOM test, so an element before this one stops the hero bleeding to the top of the page. */}
      <LandingCornerMarks />
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

/**
 * ── THE TWO CORNER MARKS: DC HANDICRAFTS TOP-LEFT, IIT KHARAGPUR TOP-RIGHT ─────────────────────
 *
 * Corrected on 2026-08-31 by the owner: "the top left corner should be the handicraft logo, and the
 * right side should be white iit kgp logo, just like how it is for the designer portal web
 * application." What stood here put the Centre's own eight-point star in BOTH corners, arguing that
 * this product has a single institutional mark and that a different mark on the right would be a
 * claim nobody had made. That argument was wrong about the FILES rather than about the design — the
 * two partner marks exist and were simply not in this repository — so the fix is to bring them in.
 *
 * THE REFERENCE IS THE DESIGN PROTOTYPE WORKSHOP'S MASTHEAD (`components/hero/HeroLanding.tsx` in
 * the designer-portal repository) and both mechanisms below are copied from it rather than
 * re-derived. The two files under `public/logos/` are byte-for-byte that repository's, so a
 * researcher moving between the two products meets the same two seals in the same two corners.
 *
 * ⚠ THE TWO MARKS FAIL DIFFERENTLY IF A FILE GOES MISSING, and neither failure reaches a log. A PNG
 * that never arrives paints Chromium's broken-image glyph inside the cream plate — `alt=""`
 * suppresses that glyph only for an image with no intrinsic box, and this one carries `width` and
 * `height` on purpose, because they are what reserves its space before the file lands. A
 * `mask-image` whose source never arrives masks its box out completely and the corner is simply
 * empty. That asymmetry is why both paths are declared once, here, and never spelled inline.
 */
/*
 * `name` and `href` are carried on both records and read by neither, ON PURPOSE and not by
 * oversight. They are what says WHICH institution each file depicts and where its canonical page
 * is — the two facts a reader of this module would otherwise have to open a binary to recover, and
 * exactly what the provenance prose recommended at the foot of this header would need if an editor
 * ever places it. Deleting them saves nothing and loses the only identification these files have.
 */
const DC_HANDICRAFTS = {
  name: "Office of the Development Commissioner (Handicrafts)",
  href: "https://handicrafts.nic.in/",
  src: "/logos/dc-handicrafts.png",
  // Intrinsic dimensions. `w-auto` on the tag is what makes the rendered width follow from `h-7`.
  width: 600,
  height: 253
};

const IIT_KHARAGPUR = {
  name: "Indian Institute of Technology Kharagpur",
  href: "https://www.iitkgp.ac.in/",
  src: "/logos/iit-kharagpur.svg",
  width: 268,
  height: 300
};

/**
 * The seal, painted through its own alpha rather than drawn.
 *
 * ⚠ IT IS A MASK, NOT A PICTURE, AND THAT IS THE WHOLE REASON THERE IS NO `<img>` ON THE RIGHT. A
 * page's CSS cannot reach inside an SVG loaded through `<img>` to recolour it, and hand-editing the
 * file's fills would fork an asset this repository shares byte-for-byte with the designer portal.
 * Masking the file and painting the box white is the one approach that leaves the file alone.
 *
 * Declared at module scope: an object literal in JSX is a new object on every render.
 */
const SEAL_MASK = `url("${IIT_KHARAGPUR.src}")`;
const SEAL_MASK_STYLE: CSSProperties = {
  maskImage: SEAL_MASK,
  WebkitMaskImage: SEAL_MASK,
  maskSize: "contain",
  WebkitMaskSize: "contain",
  maskRepeat: "no-repeat",
  WebkitMaskRepeat: "no-repeat",
  maskPosition: "center",
  WebkitMaskPosition: "center",
  backgroundColor: "#ffffff"
};

/**
 * ── THE CORNER MARKS THEMSELVES ────────────────────────────────────────────────────────────────
 *
 * ⚠ BOTH MARKS SIT ON A PLATE, AND THE RIGHT-HAND PLATE IS THIS REPOSITORY'S OWN ADDITION.
 *
 * In the designer portal the pair rides a masthead that is ALWAYS dark purple, so only the DC mark
 * needs a plate — its red wordmark cannot survive a dark ground — and the seal is painted white
 * straight onto the bar. HERE THE GROUND IS NOT A CONSTANT. It is whatever an administrator has put
 * at the top of the front page, which is a row in the database rather than a line in this file.
 *
 * MEASURED at 1280 / 1440 / 1920 by screenshotting the corner band and averaging its pixels:
 *
 *   • with the seeded HERO block first (full-bleed, `bg-purple-950`) … rgb(57,21,85)    14.9:1 vs white
 *   • with that one block switched off in the studio ……………………………………… rgb(247,246,251)   1.08:1 vs white
 *
 * The second figure is the light page canvas, and 1.08:1 is an INVISIBLE MARK. It is not a
 * hypothetical reachable only by a developer: hiding the hero is one toggle in the studio, the
 * no-content fallback above renders `PageHero` on that same canvas, and an editor who simply leads
 * the page with a light block arrives there too.
 *
 * So the seal is given a `bg-purple-950` plate, mirroring the cream plate's own logic. That colour
 * is chosen over any other dark for one property a media query could not buy: IT IS THE HERO'S OWN
 * GROUND. On a hero-led page the plate is the same colour as what is behind it, so it disappears and
 * the seal reads bare, exactly as it does in the designer portal; on the light canvas the identical
 * plate is a dark chip holding the white seal at roughly 15:1. Nothing has to know which case it is
 * in, and there is no theme branch — brand colour does not invert (see `BrandMark`'s own header).
 *
 * ⚠ `hidden xl:flex` IS KEPT, AND THE NEW MARKS STRENGTHEN THAT RULE RATHER THAN WEAKEN IT. The
 * designer portal shows its pair from `md`, but its marks sit IN a masthead flex row that reserves
 * their space; these are absolutely positioned beside a centred, content-width header pill which is
 * `z-50` glass and wins every overlap. Clear air either side of the pill, measured on the seeded
 * six-entry menu rather than added up:
 *
 *      640px  145px        1024px   57px  ← the link strip appears and the pill jumps to 911px
 *      768px  209px        1152px  121px
 *      900px  275px        1280px  185px        1440px  265px        1920px  505px
 *
 * The left mark is the wider of the two — a 600×253 PNG at `h-7` inside `px-2`, about 82px — and it
 * is inset by 32px, so it needs about 114px. That clears at 1280 with 71px to spare, sits inside the
 * noise at 1152, and collides outright at 1024. The 768–900 band has room ONLY because the pill drops
 * its link strip below `lg`, and a rule that appeared at `md`, vanished at `lg` and returned at `xl`
 * would read as a bug to anyone resizing a window. `xl` is the one threshold clear at every width
 * above it. An unusually long `siteName` or a larger menu can still close the gap; that failure is
 * cosmetic and one-way, which is why this stays a breakpoint rather than a measurement.
 *
 * ⚠ NO RESPONSIVE HEIGHT PAIR, AND ITS ABSENCE IS DELIBERATE. The designer portal writes `h-5 lg:h-7`
 * on the DC mark because its row is live from `md` and genuinely crosses `lg`. This row does not
 * exist below `xl`, so a `lg:` variant here could never lose — it would be a dead class that reads
 * as a considered choice. The two heights are stated once, at the values `lg:` would have produced.
 *
 * DECORATIVE, AND STILL SO NOW THAT THE MARKS NAME TWO OTHER INSTITUTIONS. The row keeps
 * `aria-hidden`, `pointer-events-none` and no link. The designer portal's marks ARE links, and the
 * difference is DOM POSITION rather than taste: its pair is the first thing in its masthead, while
 * this element is rendered LAST on the page — see the call site, where `:first-child` is a DOM test
 * and the hero's bleed depends on nothing preceding it. An `sr-only` name here would therefore
 * announce "Office of the Development Commissioner (Handicrafts)" as the final utterance of the
 * homepage, detached from anything that explains it, and a link would be an invisible target lying
 * across the hero artwork. IIT Kharagpur is already named in text in the site footer. These two
 * boxes are ornament, and the provenance belongs in prose that an editor can place.
 */
function LandingCornerMarks() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-3 hidden h-14 items-center justify-between px-8 xl:flex"
    >
      {/* TOP-LEFT — the DC Handicrafts mark in its own colours, on the cream plate its red wordmark
          needs to survive any ground. `bg-logo-cream` is this repository's own token
          (tailwind.config.ts: `logo: { cream: "#FAF9F5" }`) and is character-for-character the
          designer portal's, so nothing had to be invented or approximated for it. */}
      <span className="flex items-center justify-center rounded-md bg-logo-cream px-2 py-1.5 shadow-md">
        {/* eslint-disable-next-line @next/next/no-img-element -- a static file in `public/` drawn at
            one fixed height in one corner of one page. `next/image` would put the optimiser in front
            of a 27KB PNG for a width already known at build time, and its generated wrapper would
            fight this plate's box for no benefit the reader could see. */}
        <img
          src={DC_HANDICRAFTS.src}
          alt=""
          width={DC_HANDICRAFTS.width}
          height={DC_HANDICRAFTS.height}
          className="h-7 w-auto"
        />
      </span>
      {/* TOP-RIGHT — the IIT Kharagpur seal, white, on the dark plate the header above measures. */}
      <span className="flex items-center justify-center rounded-md bg-purple-950 px-2 py-1.5 shadow-md">
        {/* `aspect-[268/300]` is the seal's intrinsic ratio, written out IN FULL rather than built
            from IIT_KHARAGPUR's numbers: Tailwind scans this file for whole class names and cannot
            interpolate one (contract §5), so an assembled string would compile to nothing and the
            box would collapse. `mask-size: contain` letterboxes the mark inside it, so the 0.08%
            rounding off the true 267.538×299.737 can never distort the seal. */}
        <span className="block aspect-[268/300] h-9" style={SEAL_MASK_STYLE} />
      </span>
    </div>
  );
}
