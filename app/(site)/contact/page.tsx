/**
 * /contact — how to reach the Centre.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ADDRESS, THE EMAIL AND THE DEPARTMENT LIST ARE RENDERED UNCONDITIONALLY, AS TEXT.
 *
 * Everything else on this page can fail: the enquiry form is behind a feature flag, the map needs
 * WebGL and a tile server, and both need JavaScript. None of that may be the only way to make contact.
 * A contact page whose only route through is a form is a contact page that is broken for anybody the
 * form does not work for — and `FEATURE_FLAGS` in lib/settings/schema.ts says exactly that about the
 * `contactForm` switch: with it off the page still shows the address, the email and the telephone
 * number, because a contact page with no way to make contact is worse than no page.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A SERVER COMPONENT reading the `contact`, `social`, `branding` and `features` settings groups in one
 * query through `getSettingsCached()`. The two blocks it composes — `ContactFormSection` and
 * `MapSection` — are Client Components, so the payloads handed to them are plain, serialisable objects
 * typed against the SAME schemas the studio validates against (lib/sections/schema.ts). Typed literals
 * rather than a runtime `parse()`: TypeScript then fails the build if a block gains a field, which is
 * strictly better than a page that throws at request time.
 *
 * ⚠ THIS ROUTE SHADOWS A `Page` ROW WITH THE SLUG "contact". A static segment always wins over the
 * catch-all, so any blocks an editor adds to that page are not rendered here — the form, the map and
 * the contact details on this page come from SETTINGS, which is where they belong (one address, edited
 * once, used by the footer and this page alike). The page row is still read for its SEO fields, so an
 * editor who writes a description for "contact" gets it.
 *
 * `export const revalidate` IS SET. This page reads no request-scoped input, so without it Next would
 * render it once and serve that copy for the life of the deployment — and a corrected telephone number
 * would never appear.
 */

import type { Metadata } from "next";
import { cache } from "react";
import type { PageSection } from "@prisma/client";
import {
  Facebook,
  Github,
  Globe,
  Instagram,
  Linkedin,
  Mail,
  Phone,
  Rss,
  Twitter,
  Youtube,
  type LucideIcon
} from "lucide-react";

import { Reveal } from "@/components/motion";
import { ContactFormSection } from "@/components/sections/ContactFormSection";
import { MapSection } from "@/components/sections/MapSection";
import { PageHero } from "@/components/site/PageHero";
import { SectionHeading } from "@/components/site/SectionHeading";
import { livePublishableWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import type { ContactFormSectionData, MapSectionData } from "@/lib/sections/schema";
import { pageMetadata } from "@/lib/seo";
import { SOCIAL_PLATFORMS, type ContactSettings, type SocialLink } from "@/lib/settings/schema";
import { getSettingsCached } from "@/lib/settings/service";

const CONTACT_PATH = "/contact";

/** Five minutes, matching the other settings-driven public pages. */
export const revalidate = 300;

/**
 * The `Page` row behind this route, for its SEO fields only.
 *
 * `livePublishableWhere()` and NOT `liveStatusWhere()`: `Page` carries `publishAt`/`unpublishAt`, and
 * the two helpers are separate functions precisely so a filter cannot reference a column the model
 * does not have (lib/content.ts). An unpublished row simply means no editor-supplied metadata — the
 * route itself is structural and is never hidden by it.
 */
const loadContactPage = cache(async () =>
  // An unreachable database answers `null`, the same as "no such page" — and this page already
  // composes a complete default when the row is absent. `next build` renders it, so a throw here
  // would fail the deploy; see lib/prerender.ts for the argument at length.
  prisma.page
    .findFirst({
    where: { ...livePublishableWhere(), slug: "contact" },
    select: {
      title: true,
      seoTitle: true,
      seoDescription: true,
      seoNoIndex: true,
      seoImage: {
        select: {
          objectKey: true,
          width: true,
          height: true,
          altText: true,
          blurDataUrl: true,
          variants: { select: { label: true, format: true, objectKey: true, width: true } }
        }
      }
    }
    })
    .catch((error: unknown) => {
      console.error(
        `[contact] the page could not be read, so the built-in default is being shown. ` +
          `Reason: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    })
);

const DEFAULT_DESCRIPTION =
  "Where the Centre is, who to write to about what, and a form that reaches the right inbox.";

export async function generateMetadata(): Promise<Metadata> {
  const [page, settings] = await Promise.all([loadContactPage(), getSettingsCached()]);

  return pageMetadata({
    title: page?.seoTitle || page?.title || "Contact",
    description: page?.seoDescription || settings.contact.addressLine1 || DEFAULT_DESCRIPTION,
    path: CONTACT_PATH,
    image: page?.seoImage,
    noIndex: page?.seoNoIndex === true
  });
}

/**
 * A synthetic `PageSection`.
 *
 * Both blocks take the row they were rendered from, and use it for one thing: the `id="block-…"`
 * anchor. There is no row here — this page is composed in code rather than assembled in the builder —
 * so a deterministic stand-in is supplied. The timestamps are the epoch on purpose: nothing reads
 * them, and a `new Date()` would differ between the prerender and every revalidation, which is the
 * sort of difference that turns into a hydration mismatch the day somebody starts rendering it.
 */
function syntheticSection(id: string, type: PageSection["type"]): PageSection {
  const epoch = new Date(0);
  return {
    id,
    pageId: "contact-page",
    type,
    position: 0,
    label: null,
    data: {},
    isVisible: true,
    createdAt: epoch,
    updatedAt: epoch
  };
}

/**
 * lucide icons for the platforms `SOCIAL_PLATFORMS` names, plus `x` as an alias for Twitter.
 *
 * A literal map rather than a lookup by name into the icon set: `platform` is validated as a free-form
 * slug so a network nobody has heard of yet needs no release (lib/settings/schema.ts), and resolving an
 * arbitrary string against a module's exports is both untypeable and a way to ship the whole icon set.
 * Anything unrecognised gets `Globe`, which is what `SOCIAL_FALLBACK_ICON` already says it should.
 */
const SOCIAL_ICONS: Record<string, LucideIcon> = {
  linkedin: Linkedin,
  twitter: Twitter,
  x: Twitter,
  youtube: Youtube,
  instagram: Instagram,
  facebook: Facebook,
  github: Github,
  rss: Rss
};

function socialLabel(link: SocialLink): string {
  if (link.label.trim().length > 0) return link.label.trim();
  const known = SOCIAL_PLATFORMS.find((platform) => platform.value === link.platform);
  return known?.label ?? link.platform;
}

/** The postal address, one line per line an administrator typed. */
function addressLines(contact: ContactSettings): string[] {
  return [
    contact.addressLine1,
    contact.addressLine2,
    [contact.city, contact.state].filter((part) => part.trim().length > 0).join(", "),
    [contact.postalCode, contact.country].filter((part) => part.trim().length > 0).join(" ")
  ]
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export default async function ContactPage() {
  const settings = await getSettingsCached();
  const { branding, contact, social, features } = settings;

  const lines = addressLines(contact);
  const departments = contact.departments.filter(
    (department) => department.name.trim().length > 0
  );
  const socialLinks = social.links.filter((link) => link.url.trim().length > 0);

  const formData: ContactFormSectionData = {
    eyebrow: "",
    heading: "Send an enquiry",
    body:
      "Anything the list below does not cover. Messages reach the general enquiries inbox and are " +
      "usually answered by email within three working days.",
    formKey: "general",
    submitLabel: "",
    successMessage: "",
    showOrganisationField: true,
    // Most enquiries are answered by email, and asking for a number nobody will ring is a field for
    // its own sake.
    showPhoneField: false,
    // The details are a section of their own below, with the departments. Rendering them beside the
    // form as well would print the same address twice on one page.
    showContactDetails: false
  };

  const mapData: MapSectionData = {
    heading: "Where to find us",
    body: "The Centre's postal address, and the pin it corresponds to.",
    // 0/0 is how `MapSection` recognises "no position has been set", and `mapLatitude` is null until an
    // administrator fills it in — so null becomes 0 and the block shows the address with a note rather
    // than a map of the Atlantic. See the header of components/sections/MapSection.tsx.
    latitude: contact.mapLatitude ?? 0,
    longitude: contact.mapLongitude ?? 0,
    zoom: contact.mapZoom,
    markerLabel: branding.siteName,
    // `whitespace-pre-line` in the block keeps these breaks, which is how everybody writes an address.
    address: lines.join("\n"),
    // No invented third-party directions link. The block offers "Open in OpenStreetMap" from the
    // coordinates it already has, which needs no account and no key.
    directionsHref: "",
    height: "md"
  };

  return (
    <>
      <PageHero
        eyebrow="Contact"
        title="Get in touch"
        description={DEFAULT_DESCRIPTION}
        breadcrumbs={[
          { name: "Home", href: "/" },
          { name: "Contact", href: CONTACT_PATH }
        ]}
      />

      {features.contactForm ? (
        <ContactFormSection
          data={formData}
          section={syntheticSection("contact-form", "CONTACT_FORM")}
          // Null rather than the settings object: `showContactDetails` is false, so passing them would
          // hand a Client Component data it has been told not to render.
          contact={null}
        />
      ) : (
        <section className="py-20 md:py-28">
          <div className="shell">
            <Reveal>
              <SectionHeading
                title="The enquiry form is not available"
                description="It has been switched off for this deployment. Everything below still reaches the Centre — write to the address or the inbox that fits your question."
              />
            </Reveal>
          </div>
        </section>
      )}

      <section className="py-8 md:py-12">
        <div className="shell">
          <Reveal>
            <SectionHeading
              title="Who to write to"
              description="Each inbox is read by the people it names. Sending an enquiry to the right one is the fastest way to an answer."
              className="mb-10"
            />
          </Reveal>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {contact.email || contact.phone ? (
              <Reveal as="div" className="h-full">
                <div className="flex h-full flex-col rounded-lg border border-line-200 bg-card p-6">
                  <h3 className="display-title text-lg">General enquiries</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink-500">
                    Anything without an inbox of its own.
                  </p>

                  <ul className="mt-4 flex flex-col gap-2 text-sm">
                    {contact.email ? (
                      <li className="flex items-start gap-2">
                        <Mail aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-purple-700" />
                        <a
                          href={`mailto:${contact.email}`}
                          className="font-medium text-purple-700 transition-colors hover:text-purple-800"
                        >
                          {contact.email}
                        </a>
                      </li>
                    ) : null}

                    {contact.phone ? (
                      <li className="flex items-start gap-2">
                        <Phone aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-purple-700" />
                        <a
                          // A telephone number is a link on every device that can dial and harmless on
                          // the ones that cannot. The spaces are stripped from the `href` only — the
                          // visible number keeps the grouping somebody chose.
                          href={`tel:${contact.phone.replace(/\s+/g, "")}`}
                          className="font-medium text-purple-700 transition-colors hover:text-purple-800"
                        >
                          {contact.phone}
                        </a>
                      </li>
                    ) : null}
                  </ul>
                </div>
              </Reveal>
            ) : null}

            {departments.map((department, index) => (
              <Reveal
                // The name is not guaranteed unique — two "Admissions" rows can survive a merge — so
                // the index is part of the key. This list is server-rendered whole and never reordered.
                key={`${department.name}-${index}`}
                delay={Math.min(index + 1, 8) * 0.05}
                className="h-full"
              >
                <div className="flex h-full flex-col rounded-lg border border-line-200 bg-card p-6">
                  <h3 className="display-title text-lg">{department.name}</h3>

                  {department.note ? (
                    <p className="mt-1.5 text-sm leading-relaxed text-ink-500">{department.note}</p>
                  ) : null}

                  {department.email || department.phone ? (
                    <ul className="mt-4 flex flex-col gap-2 text-sm">
                      {department.email ? (
                        <li className="flex items-start gap-2">
                          <Mail
                            aria-hidden="true"
                            className="mt-0.5 h-4 w-4 shrink-0 text-purple-700"
                          />
                          <a
                            href={`mailto:${department.email}`}
                            className="font-medium text-purple-700 transition-colors hover:text-purple-800"
                          >
                            {department.email}
                          </a>
                        </li>
                      ) : null}

                      {department.phone ? (
                        <li className="flex items-start gap-2">
                          <Phone
                            aria-hidden="true"
                            className="mt-0.5 h-4 w-4 shrink-0 text-purple-700"
                          />
                          <span className="text-ink-700">{department.phone}</span>
                        </li>
                      ) : null}
                    </ul>
                  ) : (
                    <p className="mt-4 text-sm leading-relaxed text-ink-500">
                      No address has been published for this department yet. Use the general enquiries
                      inbox and ask for it by name.
                    </p>
                  )}
                </div>
              </Reveal>
            ))}
          </div>

          {departments.length === 0 && !contact.email && !contact.phone ? (
            // Not an empty grid. An administrator reading this knows where to fix it, and a visitor
            // knows the omission is not their browser.
            <p className="rounded-lg border border-dashed border-line-200 bg-surface-50 px-6 py-8 text-center text-sm leading-relaxed text-ink-500">
              No email address, telephone number or department contact has been published yet. The
              postal address below is the only route through at the moment.
            </p>
          ) : null}
        </div>
      </section>

      {/*
        THE MAP BLOCK, WHICH IS ALSO THE POSTAL ADDRESS. It renders the address as text every time —
        before the canvas loads, when WebGL is unavailable, when the tile server is down, and when there
        are no coordinates at all.

        The wrapper carries `id="map"`, the anchor the About page's "See the map" button targets
        (/contact#map). The block's own id is `block-contact-map` — spelled from the synthetic row
        above, a shape no hand-written link would guess — so the readable name lives here instead.
        `data-anchor` earns the header clearance from globals.css; never restate it as a `scroll-mt-*`
        (contract §7).
      */}
      <div id="map" data-anchor="">
        <MapSection data={mapData} section={syntheticSection("contact-map", "MAP")} />
      </div>

      {socialLinks.length > 0 ? (
        <section className="py-16 md:py-20">
          <div className="shell">
            <Reveal>
              <SectionHeading
                title="Elsewhere"
                description="The Centre's own accounts. Anything published there is published here first."
                className="mb-8"
              />
            </Reveal>

            <Reveal as="ul" className="flex flex-wrap gap-3">
              {socialLinks.map((link, index) => {
                const Icon = SOCIAL_ICONS[link.platform] ?? Globe;
                const label = socialLabel(link);

                return (
                  <li key={`${link.platform}-${index}`}>
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-10 items-center gap-2 rounded-md border border-line-200 bg-card px-4 py-2 text-sm font-medium text-ink-900 transition hover:border-purple-300 hover:bg-purple-50"
                    >
                      <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-purple-700" />
                      {label}
                      {/* A reader whose focus lands in a new tab with no warning has lost their place
                          and their Back button with it. */}
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  </li>
                );
              })}
            </Reveal>
          </div>
        </section>
      ) : null}
    </>
  );
}
