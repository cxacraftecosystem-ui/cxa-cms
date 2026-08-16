import { SmoothScroll } from "@/components/motion/SmoothScroll";
import { AnnouncementBar } from "@/components/site/AnnouncementBar";
import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";
import { SplashCursorMount } from "@/components/site/SplashCursorMount";
import { StudioDoorway } from "@/components/site/StudioDoorway";
import type { NavNode } from "@/lib/navigation";
import { organizationJsonLd, serializeJsonLd, webSiteJsonLd } from "@/lib/seo";
import { getSettingsCached } from "@/lib/settings/service";
import { getNavigation } from "@/lib/navigation-server";
import type {
  FeatureFlag,
  FeaturesSettings,
  FooterSettings,
  SettingsMap
} from "@/lib/settings/schema";

/**
 * The public site frame.
 *
 * A SERVER COMPONENT that reads navigation and branding from the database once per request and hands
 * them down. The alternative — a client header that fetches its own menu — means every visitor
 * watches the navigation appear a beat after the page, and a crawler sees a site with no links at
 * all.
 *
 * WHAT LIVES HERE AND NOWHERE ELSE:
 *
 *   1. The skip link, FIRST in tab order. A keyboard reader must be able to get past a header with a
 *      dozen destinations in one keystroke.
 *   2. `SmoothScroll` (Lenis), which is scoped to this route group deliberately. A CMS that scrolls
 *      with inertia feels broken when you are trying to land on a table row, so the studio never
 *      mounts it.
 *   3. `main#main-content` with `tabIndex={-1}` — the skip link's target has to be focusable or the
 *      skip does nothing but move the scroll position, leaving focus back in the header.
 *   4. `StudioDoorway`, the invisible keyboard route into the CMS.
 *   5. `AnnouncementBar`, as the FIRST CHILD of `<main>` — see the note below.
 *   6. The SITE-WIDE JSON-LD: one ResearchOrganization node and one WebSite node. The organisation
 *      exists once, so it is said once, in the frame every public page shares — the per-page nodes
 *      (Article, Event, ScholarlyArticle, breadcrumbs) belong to the pages themselves.
 *
 * The header clearance is paid ONCE, by `.page-top` on `<main>`. No page adds its own top padding
 * for the header — that is how three numbers end up meaning one thing and drifting apart.
 */

/**
 * ⚠ A SECOND COPY OF THE HEADER'S FEATURE FILTER, AND IT MUST NOT DRIFT FROM IT.
 *
 * `SiteHeader` drops every destination behind a switched-off flag (contract §1.8: not rendered, never
 * rendered disabled). The footer did not, so an administrator who switched Craft Explorer off got the
 * intended header change and a site-wide footer link to a page that now answers 404 — the very state
 * the header's filter exists to prevent, repeated on every page of the site.
 *
 * The filter is applied HERE rather than inside `SiteFooter` because `SiteHeader.tsx` is a
 * `"use client"` module: every export of such a module becomes a client reference when a Server
 * Component imports it, so this file could not call the header's copy even if it were exported (the
 * same trap craft-explorer/[slug] documents about `splitRestorationPhases`). The right long-term home
 * is `lib/navigation.ts`, where both menus can import one implementation; until then the two lists
 * below must be kept identical to `FEATURE_ROUTES` in components/site/SiteHeader.tsx.
 *
 * Only flags that gate a WHOLE SURFACE belong here. `contactForm`, `eventRegistration` and `analytics`
 * gate part of a page that still exists and still needs its link.
 */
const FEATURE_ROUTES: ReadonlyArray<{ prefix: string; flag: FeatureFlag }> = [
  { prefix: "/craft-explorer", flag: "craftExplorer" },
  { prefix: "/gallery", flag: "gallery" },
  { prefix: "/events", flag: "events" },
  { prefix: "/publications", flag: "publications" }
];

/** The path part of a href, with any query or fragment removed. */
function baseOf(href: string): string {
  return href.split("?")[0]?.split("#")[0] ?? "";
}

function isHrefEnabled(href: string, features: FeaturesSettings): boolean {
  const base = baseOf(href);
  for (const route of FEATURE_ROUTES) {
    if (base === route.prefix || base.startsWith(`${route.prefix}/`)) return features[route.flag];
  }
  return true;
}

/**
 * Drop every footer entry whose destination has been switched off.
 *
 * A GROUP whose own href is gated but whose children are not survives, re-pointed at the first
 * destination still standing — dropping it whole would take its live children down with it. That is
 * the same resolution `filterNavByFeatures` reaches in the header, and the two menus must agree about
 * which destinations exist.
 */
function filterNavByFeatures(nodes: NavNode[], features: FeaturesSettings): NavNode[] {
  const out: NavNode[] = [];

  for (const node of nodes) {
    const children = filterNavByFeatures(node.children, features);

    if (isHrefEnabled(node.href, features)) {
      out.push({ ...node, children });
      continue;
    }

    const first = children[0];
    if (!first) continue;
    out.push({ ...node, href: first.href, children });
  }

  return out;
}

/**
 * The same treatment for the editor's own footer columns.
 *
 * `footer.columns` is a free-form list of links in the settings document, so nothing stops an editor
 * putting `/gallery` in one. A column left with no links standing is dropped rather than rendered as a
 * heading over nothing.
 */
function filterFooterColumns(footer: FooterSettings, features: FeaturesSettings): FooterSettings {
  const columns = footer.columns
    .map((column) => ({
      ...column,
      links: column.links.filter((link) => isHrefEnabled(link.href, features))
    }))
    .filter((column) => column.links.length > 0);

  return { ...footer, columns };
}

/**
 * The Organization node, from the same settings read the frame already pays for.
 *
 * BLANK SETTINGS FIELDS ARE DROPPED, NEVER SERIALISED AS "". A fresh install stores an empty string
 * for every contact field except the country, which defaults to "India" — and an address consisting
 * of a country alone is a claim, not an address, so the address object is only emitted once a street
 * or a city has been typed. No `logo` either: `branding.logoMediaId` is an id, nothing on the render
 * path resolves it to a URL, and a schema.org logo is not worth a second query in the frame of every
 * page.
 */
function organizationNode(settings: SettingsMap): Record<string, unknown> {
  const { branding, contact, social } = settings;

  const street = [contact.addressLine1, contact.addressLine2]
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(", ");
  const city = contact.city.trim();

  return organizationJsonLd({
    name: branding.siteName,
    description: branding.tagline.trim() || null,
    email: contact.email || null,
    telephone: contact.phone || null,
    address:
      street.length > 0 || city.length > 0
        ? {
            street: street || null,
            city: city || null,
            region: contact.state.trim() || null,
            postalCode: contact.postalCode.trim() || null,
            country: contact.country.trim() || null
          }
        : null,
    sameAs: social.links.map((link) => link.url.trim()).filter((url) => url.length > 0)
  });
}

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  // One round trip for both, deduped by React `cache()` if a child asks again in the same request.
  const [settings, navigation] = await Promise.all([getSettingsCached(), getNavigation()]);

  return (
    <>
      {/*
        Escaped by `serializeJsonLd`, never a bare JSON.stringify — a `</script>` inside any settings
        string would end the element early and the rest would parse as HTML (lib/seo.ts). Two nodes as
        two scripts rather than an @graph: crawlers accept both, and separate scripts keep each node
        independently readable. No SearchAction on the WebSite node — robots.ts disallows /search.
      */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(organizationNode(settings)) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: serializeJsonLd(webSiteJsonLd({ name: settings.branding.siteName }))
        }}
      />

      <a
        href="#main-content"
        className="sr-only z-[60] rounded-md bg-purple-700 px-4 py-2 text-sm font-medium text-white shadow-cta focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to content
      </a>

      <SmoothScroll />

      <div className="relative flex min-h-screen flex-col bg-bg-0">
        <SiteHeader
          branding={settings.branding}
          items={navigation.header}
          features={settings.features}
        />

        {/*
          `tabIndex={-1}` makes this focusable by the skip link without putting it in the tab order.
          `.page-top` is the only place the header clearance is paid.
        */}
        {/*
          ⚠ NO `z-index` ON `<main>`, DELIBERATELY, AND IT IS LOAD-BEARING. An index here would make
          this element a STACKING CONTEXT, which traps every card inside it — the cards' own `z-45`
          would then be measured against each other rather than against the fluid cursor's `z-40`,
          and the trail would paint over all of them. See the header of components/site/SplashCursor.tsx.
        */}
        <main id="main-content" tabIndex={-1} className="page-top flex-1 outline-none">
          {/*
            INSIDE `<main>`, and first, exactly as AnnouncementBar's own header requires: the header is
            a `position: fixed` pill that occupies no flow space, so a band above it in the document
            would be painted underneath it, and a band outside `<main>` would need its own top padding —
            a second number meaning the same thing as `--nav-clearance` (contract §7). Sitting after
            `#main-content` also means a reader using the skip link lands on the announcement first.

            It renders nothing at all when no announcement is live, which is the normal state.
          */}
          <AnnouncementBar />
          {children}
        </main>

        <SiteFooter
          branding={settings.branding}
          contact={settings.contact}
          social={settings.social}
          footer={filterFooterColumns(settings.footer, settings.features)}
          items={filterNavByFeatures(navigation.footer, settings.features)}
        />

        {/*
          THE FLUID CURSOR TRAIL, MOUNTED AGAIN — and the sim underneath it is a different one.

          The note that stood here recorded that the effect had been unmounted because the previous,
          bespoke implementation FLICKERED on the owner's hardware: three passes at the cause (dye
          dissipation, a random-hue strobe, a mis-sampled SHADING display pass feeding canvas-sized
          texel offsets against a 720px dye buffer) each fixed something real and none of them ended
          it, and headless Chrome renders the sim's dye not at all so it could never be reproduced
          here. Removing the element was the right call at the time — an ornament that costs the
          owner a usable page has no claim on it.

          `components/site/SplashCursor.tsx` is now the reference implementation the owner supplied,
          ported verbatim, rather than that rewrite — so the display pass that was the last suspect
          is gone with the code that contained it. See that file's header.

          ⚠ IT IS STILL WORTH WATCHING ON REAL HARDWARE FOR A FULL MINUTE. The reason the flicker
          could not be chased here has not changed: headless Chrome does not render the dye, so this
          machine cannot tell you whether it is fixed. If it returns, remove this one element again
          and say so — that is a cheaper answer than a fourth pass at a shader.
        */}
        <SplashCursorMount />
      </div>

      <StudioDoorway />
    </>
  );
}
