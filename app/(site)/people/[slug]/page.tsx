import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Prisma } from "@prisma/client";
import {
  BookOpen,
  CalendarDays,
  ExternalLink,
  Fingerprint,
  Github,
  Globe,
  GraduationCap,
  Linkedin,
  Mail,
  Phone,
  type LucideIcon
} from "lucide-react";

import { Reveal } from "@/components/motion/Reveal";
import { BreadcrumbJsonLd, Breadcrumbs } from "@/components/site/Breadcrumbs";
import { CardGrid } from "@/components/site/CardGrid";
import { EntityCard } from "@/components/site/EntityCard";
import { formatCentreDate } from "@/components/site/EventDateBlock";
import { PERSON_KIND_LABELS, personTenure } from "@/components/site/PersonCard";
import { ProseArticle } from "@/components/site/ProseArticle";
import { SectionHeading } from "@/components/site/SectionHeading";
import { TagList } from "@/components/site/TagList";
import { Badge } from "@/components/ui/Badge";
import { MediaImage } from "@/components/ui/MediaImage";
import { personInitials } from "@/components/site/PersonCard";
import { liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { publicationDisplayVenue } from "@/lib/citation";
import { ogImageUrl } from "@/lib/media/url";
import { parseRichText, richTextExcerpt } from "@/lib/richtext";
import { absoluteUrl, pageMetadata, serializeJsonLd } from "@/lib/seo";
import { getSettingCached } from "@/lib/settings/service";
import { truncateWords } from "@/lib/utils";

import { PUBLICATION_KIND_LABELS, doiUrl } from "../../publications/filters";

/**
 * /people/[slug] — one person's profile.
 *
 * A SERVER COMPONENT that reads seven things in two round trips: the person, then their publications,
 * projects and speaking engagements with a count beside each. Nothing here is interactive, so nothing
 * here ships JavaScript beyond the `Reveal` wrappers.
 *
 * EVERY LIST ON THIS PAGE IS CAPPED AND EVERY CAP IS STATED. A profile with sixty publications must not
 * quietly show forty: a list that stops without saying so is indistinguishable from a person who has
 * published forty times (contract §1.6). Each section names its own total and links to the place the
 * rest can be read.
 *
 * THE EMAIL ADDRESS IS A PLAIN `mailto:` LINK. It is not obfuscated, not assembled by JavaScript and
 * not written as "name [at] example.org". Obfuscation breaks copy-and-paste, breaks a screen reader
 * reading the address aloud, breaks the browser's "copy link", and defeats no harvester written in the
 * last fifteen years — every one of them runs a JavaScript engine. The cost is borne entirely by
 * readers and the benefit is zero.
 *
 * `revalidate` IS SET DELIBERATELY. This page reads no request-scoped input, so without it Next would
 * render it once on first request and serve that copy for the life of the deployment — and a profile
 * the editor has hidden, archived or corrected would go on publishing the old name, email address and
 * telephone number until somebody redeployed. Visibility is resolved at read time by `loadPerson`, so
 * the window below is also the longest anything here can be stale.
 */

/** Five minutes. Long enough to be worth caching, short enough that a withdrawal takes effect. */
export const revalidate = 300;

const PUBLICATION_CAP = 50;
const PROJECT_CAP = 12;
const EVENT_CAP = 12;

/** Structurally identical to `MediaLike` in lib/media/url.ts — see the note on /people/page.tsx. */
const mediaSelect = {
  objectKey: true,
  width: true,
  height: true,
  altText: true,
  blurDataUrl: true,
  variants: { select: { label: true, format: true, objectKey: true, width: true } }
} satisfies Prisma.MediaAssetSelect;

/**
 * The publication columns a citation line needs.
 *
 * Wider than the row looks: `publicationDisplayVenue` reads volume, issue, publisher, the patent number
 * and the arXiv id to punctuate ONE line correctly (lib/citation.ts). Trimming this to "what is
 * visible" silently degrades every reference on the page.
 */
const publicationSelect = {
  id: true,
  slug: true,
  kind: true,
  title: true,
  authorLine: true,
  venue: true,
  publisher: true,
  volume: true,
  issue: true,
  pages: true,
  year: true,
  patentNumber: true,
  arxivId: true,
  doi: true,
  url: true
} satisfies Prisma.PublicationSelect;

/**
 * The person, memoised for ONE request.
 *
 * `generateMetadata` and the page body both need the row, and React's `cache()` means they share a
 * single query instead of asking twice for the same profile on every request.
 */
const loadPerson = cache(async (slug: string) => {
  return prisma.person.findFirst({
    // `isVisible` is checked here as well as on the roster: a profile the editor has hidden must not be
    // reachable by guessing its URL, and hiding it from the listing alone is not a guard.
    where: { ...liveStatusWhere(), isVisible: true, slug },
    select: {
      id: true,
      slug: true,
      name: true,
      kind: true,
      designation: true,
      department: true,
      bio: true,
      bioRich: true,
      email: true,
      phone: true,
      website: true,
      linkedin: true,
      googleScholar: true,
      orcid: true,
      github: true,
      researchInterests: true,
      startedOn: true,
      endedOn: true,
      updatedAt: true,
      publishedAt: true,
      photo: { select: mediaSelect }
    }
  });
});

type PersonRecord = NonNullable<Awaited<ReturnType<typeof loadPerson>>>;

// ─────────────────────────────────────────────────────────────────────────────
// Identity links
// ─────────────────────────────────────────────────────────────────────────────

interface ProfileLink {
  key: string;
  icon: LucideIcon;
  /** The visible text, and the first half of the accessible name. */
  label: string;
  /** Spoken after the label, so twenty "LinkedIn" links on a site are still distinguishable. */
  spoken: string;
  href: string;
  /** Opens in a new tab, and says so. `mailto:`/`tel:` hand off to an application instead. */
  external: boolean;
}

/**
 * Turn a stored identity value into a URL.
 *
 * ⚠ EDITORS PASTE BOTH SHAPES. An ORCID field holds "0000-0002-1825-0097" about half the time and
 * "https://orcid.org/0000-0002-1825-0097" the other half; the same is true of every field here. A link
 * built by concatenating a prefix onto whatever the column holds produces
 * `https://orcid.org/https://orcid.org/…`, which resolves to nothing — the identical failure
 * lib/citation.ts normalises DOIs to avoid.
 */
function profileUrl(raw: string | null, build: (handle: string) => string): string | null {
  const value = raw?.trim() ?? "";
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  // A leading slash is what a half-pasted path looks like; stripping it keeps the built URL clean.
  const handle = value.replace(/^\/+/, "");
  return handle.length > 0 ? build(handle) : null;
}

/** A website field that may or may not carry its scheme. Bare hosts are assumed to be https. */
function websiteUrl(raw: string | null): string | null {
  const value = raw?.trim() ?? "";
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : `https://${value.replace(/^\/+/, "")}`;
}

/** The visible text for a URL: the host and path, without the scheme nobody reads. */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function profileLinks(person: PersonRecord): ProfileLink[] {
  const links: ProfileLink[] = [];
  const email = person.email?.trim() ?? "";
  const phone = person.phone?.trim() ?? "";

  if (email) {
    links.push({
      key: "email",
      icon: Mail,
      label: email,
      spoken: `email ${person.name}`,
      href: `mailto:${email}`,
      external: false
    });
  }

  if (phone) {
    links.push({
      key: "phone",
      icon: Phone,
      label: phone,
      spoken: `telephone ${person.name}`,
      // The dialable form strips everything a keypad cannot send while the LABEL keeps the spacing the
      // editor typed, which is what makes a number readable.
      href: `tel:${phone.replace(/[^\d+]/g, "")}`,
      external: false
    });
  }

  const website = websiteUrl(person.website);
  if (website) {
    links.push({
      key: "website",
      icon: Globe,
      label: shortUrl(website),
      spoken: `personal website of ${person.name}`,
      href: website,
      external: true
    });
  }

  const linkedin = profileUrl(person.linkedin, (handle) => `https://www.linkedin.com/in/${handle}`);
  if (linkedin) {
    links.push({
      key: "linkedin",
      icon: Linkedin,
      label: "LinkedIn",
      spoken: `LinkedIn profile of ${person.name}`,
      href: linkedin,
      external: true
    });
  }

  const scholar = profileUrl(
    person.googleScholar,
    (handle) => `https://scholar.google.com/citations?user=${encodeURIComponent(handle)}`
  );
  if (scholar) {
    links.push({
      key: "scholar",
      icon: GraduationCap,
      label: "Google Scholar",
      spoken: `Google Scholar profile of ${person.name}`,
      href: scholar,
      external: true
    });
  }

  const orcid = profileUrl(person.orcid, (handle) => `https://orcid.org/${handle}`);
  if (orcid) {
    links.push({
      key: "orcid",
      icon: Fingerprint,
      // The identifier itself is the label: an ORCID is quoted in grant applications, so the number is
      // the useful thing on the page rather than the word "ORCID".
      label: `ORCID ${shortUrl(orcid).replace(/^orcid\.org\//i, "")}`,
      spoken: `ORCID record of ${person.name}`,
      href: orcid,
      external: true
    });
  }

  const github = profileUrl(person.github, (handle) => `https://github.com/${handle}`);
  if (github) {
    links.push({
      key: "github",
      icon: Github,
      label: "GitHub",
      spoken: `GitHub profile of ${person.name}`,
      href: github,
      external: true
    });
  }

  return links;
}

// ─────────────────────────────────────────────────────────────────────────────
// Metadata
// ─────────────────────────────────────────────────────────────────────────────

/** The one-line summary used for the meta description and the JSON-LD. */
function personSummary(person: PersonRecord): string {
  const bio = person.bio?.trim();
  if (bio) return bio;

  const rich = richTextExcerpt(parseRichText(person.bioRich), 200);
  if (rich) return rich;

  // No biography at all: the designation and department are still a truthful sentence, and a card with
  // no description is a card most platforms render as a bare grey rectangle.
  const role = [person.designation, person.department].filter(Boolean).join(", ");
  return role ? `${person.name} — ${role}.` : person.name;
}

export async function generateMetadata({
  params
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const person = await loadPerson(slug);

  if (!person) {
    // Not `notFound()`: this function only produces `<head>`, and throwing here would replace the
    // page's own 404 with a metadata error. `noIndex` keeps a mistyped or retired profile out of the
    // index while the page below renders the real not-found.
    return pageMetadata({
      title: "Profile not found",
      description: "This profile is not available.",
      path: `/people/${slug}`,
      noIndex: true
    });
  }

  return pageMetadata({
    title: person.name,
    description: personSummary(person),
    path: `/people/${person.slug}`,
    image: person.photo,
    type: "profile",
    keywords: person.researchInterests
  });
}

// ─────────────────────────────────────────────────────────────────────────────

export default async function PersonPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const person = await loadPerson(slug);
  if (!person) notFound();

  const authored: Prisma.PublicationWhereInput = {
    ...liveStatusWhere(),
    authors: { some: { personId: person.id } }
  };
  const memberOf: Prisma.ProjectWhereInput = {
    ...liveStatusWhere(),
    members: { some: { personId: person.id } }
  };
  const spokeAt: Prisma.CoeEventWhereInput = {
    ...liveStatusWhere(),
    speakers: { some: { personId: person.id } }
  };

  const [
    branding,
    publications,
    publicationCount,
    projects,
    projectCount,
    events,
    eventCount
  ] = await Promise.all([
    getSettingCached("branding"),
    prisma.publication.findMany({
      where: authored,
      // Newest first, with a TOTAL order: `id` last so two papers from the same year with the same
      // title cannot swap places between requests.
      orderBy: [{ year: "desc" }, { title: "asc" }, { id: "asc" }],
      take: PUBLICATION_CAP,
      select: publicationSelect
    }),
    prisma.publication.count({ where: authored }),
    prisma.project.findMany({
      where: memberOf,
      // `nulls: "last"` is load-bearing: Postgres sorts NULLs FIRST on a DESC order, so a project with
      // no start date would otherwise lead the list.
      orderBy: [{ startedOn: { sort: "desc", nulls: "last" } }, { title: "asc" }, { id: "asc" }],
      take: PROJECT_CAP,
      select: {
        id: true,
        slug: true,
        title: true,
        tagline: true,
        summary: true,
        startedOn: true,
        endedOn: true,
        cover: { select: mediaSelect },
        researchArea: { select: { title: true } }
      }
    }),
    prisma.project.count({ where: memberOf }),
    prisma.coeEvent.findMany({
      where: spokeAt,
      orderBy: [{ startsAt: "desc" }, { id: "asc" }],
      take: EVENT_CAP,
      select: {
        id: true,
        slug: true,
        title: true,
        startsAt: true,
        venue: true,
        speakers: {
          where: { personId: person.id },
          select: { role: true }
        }
      }
    }),
    prisma.coeEvent.count({ where: spokeAt })
  ]);

  const links = profileLinks(person);
  const tenure = personTenure(person);
  const interests = person.researchInterests.filter((interest) => interest.trim().length > 0);
  const trail = [
    { name: "Home", href: "/" },
    { name: "People", href: "/people" },
    { name: person.name, href: `/people/${person.slug}` }
  ];

  /**
   * Person JSON-LD.
   *
   * `sameAs` is the list of external profiles — the property that lets a search engine connect this
   * page to an ORCID record rather than guessing from a name. `serializeJsonLd` (never
   * `JSON.stringify`) because a biography containing `</script>` would otherwise close the element
   * early and everything after it would be parsed as HTML (lib/seo.ts).
   */
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Person",
    name: person.name,
    ...(person.designation ? { jobTitle: person.designation } : {}),
    ...(person.department ? { department: { "@type": "Organization", name: person.department } } : {}),
    worksFor: {
      "@type": "ResearchOrganization",
      name: branding.siteName,
      url: absoluteUrl("/")
    },
    url: absoluteUrl(`/people/${person.slug}`),
    ...(ogImageUrl(person.photo) ? { image: ogImageUrl(person.photo) } : {}),
    ...(person.email ? { email: `mailto:${person.email.trim()}` } : {}),
    ...(person.phone ? { telephone: person.phone.trim() } : {}),
    description: personSummary(person),
    ...(interests.length > 0 ? { knowsAbout: interests } : {}),
    ...(links.filter((link) => link.external).length > 0
      ? { sameAs: links.filter((link) => link.external).map((link) => link.href) }
      : {})
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />
      {/* Emitted once. `PageHero` would normally own both halves of the trail, but a profile leads with
          a portrait rather than a banner, so this page renders its own header (see below). */}
      <BreadcrumbJsonLd items={trail} />

      <section className="shell py-10 sm:py-14">
        <Breadcrumbs items={trail} className="mb-8" />

        <div className="grid gap-10 lg:grid-cols-[18rem_1fr] lg:gap-14">
          <div>
            {/* A portrait, so 4/5 rather than the 21/9 banner `PageHero` would give it. The space is
                reserved before the bytes arrive, so nothing below moves as the photograph loads. */}
            {person.photo ? (
              <MediaImage
                media={person.photo}
                aspect="4 / 5"
                rounded="lg"
                priority
                sizes="(min-width: 1024px) 18rem, 100vw"
                alt={person.photo?.altText?.trim() ? undefined : `Portrait of ${person.name}`}
                className="border border-line-200"
              />
            ) : (
              /*
               * ⚠ AN INITIALS PLATE, NOT `MediaImage`'S PLACEHOLDER, and the difference matters far
               * more here than on the card. That placeholder is a DIAGNOSTIC — it says "this asset has
               * no variants" or "no CDN is configured", which is exactly right for a photograph that
               * is MISSING. A person who simply has no portrait is not a fault to report, and at 18rem
               * wide the diagnostic is a grey rectangle the size of a real portrait.
               *
               * `PersonCard` already draws this plate; the helper is shared so the two cannot drift.
               * `aria-hidden` because the `<h1>` beside it carries the name — announcing the initials
               * as well would read it twice.
               */
              <div
                aria-hidden="true"
                style={{ aspectRatio: "4 / 5" }}
                className="flex items-center justify-center rounded-lg border border-line-200 bg-surface-100"
              >
                <span className="font-display text-6xl font-semibold tracking-tight text-purple-700/40">
                  {personInitials(person.name)}
                </span>
              </div>
            )}
          </div>

          <div className="min-w-0">
            <p className="eyebrow">{PERSON_KIND_LABELS[person.kind]}</p>
            <h1 className="display-title mt-3 text-balance text-4xl md:text-5xl">{person.name}</h1>

            {person.designation ? (
              <p className="mt-4 text-lg leading-relaxed text-ink-700">{person.designation}</p>
            ) : null}
            {person.department ? <p className="mt-1 text-base text-ink-500">{person.department}</p> : null}
            {tenure ? (
              <p className="mt-3 text-sm tabular-nums text-ink-500">
                {/* An alumnus reads as a closed range; a current member shows no end date, which is
                    the schema's own convention for `endedOn` (prisma/schema.prisma). */}
                {tenure}
              </p>
            ) : null}

            {links.length > 0 ? (
              <ul
                aria-label={`Contact and profiles for ${person.name}`}
                className="mt-8 flex flex-wrap gap-x-6 gap-y-3"
              >
                {links.map((link) => {
                  const Icon = link.icon;
                  return (
                    <li key={link.key}>
                      {/*
                        `rel="me noopener"` on every one: `me` is the identity claim an ORCID or a
                        Mastodon profile reads back to verify that this page and that account are the
                        same person, and `noopener` denies the destination a handle on this window. It
                        is inert on `mailto:`/`tel:`, which is cheaper than a conditional that could
                        drop it from an http link by mistake.
                      */}
                      <a
                        href={link.href}
                        rel="me noopener"
                        {...(link.external ? { target: "_blank" } : {})}
                        className="inline-flex items-center gap-2 rounded text-sm font-medium text-purple-700 transition-colors hover:text-purple-800"
                      >
                        <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                        <span className="break-all">{link.label}</span>
                        <span className="sr-only">
                          {" "}
                          — {link.spoken}
                          {link.external ? " (opens in a new tab)" : ""}
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        </div>
      </section>

      <div className="shell flex flex-col gap-20 pb-24 sm:gap-24 sm:pb-32">
        {/* ── Biography ─────────────────────────────────────────────────────── */}
        <Reveal as="section">
          <SectionHeading title="Biography" level={2} />
          <div className="mt-8">
            <ProseArticle
              value={person.bioRich}
              // The plain `bio` column is the fallback for a profile written before the rich editor, and
              // for one imported from a spreadsheet. Blank lines become paragraphs; nothing is
              // interpreted as markup.
              fallback={
                person.bio?.trim() ? (
                  <div className="prose-measure text-base leading-7 text-ink-700">
                    {person.bio
                      .split(/\n{2,}/)
                      .map((paragraph) => paragraph.trim())
                      .filter((paragraph) => paragraph.length > 0)
                      .map((paragraph, index) => (
                        <p key={index} className="mt-5 first:mt-0">
                          {paragraph}
                        </p>
                      ))}
                  </div>
                ) : (
                  <p className="text-base text-ink-500">
                    No biography has been added for {person.name} yet.
                  </p>
                )
              }
            />
          </div>
        </Reveal>

        {/* ── Research interests ────────────────────────────────────────────── */}
        {interests.length > 0 ? (
          <Reveal as="section">
            <SectionHeading title="Research interests" level={2} />
            {/* No `max`: this is the page the cards' "+N more" chip links to, so it must be the whole
                list. A second truncation here would be a dead end. */}
            <TagList tags={interests} label="Research interests" className="mt-8" />
          </Reveal>
        ) : null}

        {/* ── Publications ──────────────────────────────────────────────────── */}
        {publications.length > 0 ? (
          <Reveal as="section">
            <SectionHeading
              title="Publications"
              level={2}
              description={`${publicationCount} ${publicationCount === 1 ? "publication" : "publications"} with ${person.name} as an author.`}
              link={{
                href: `/publications?author=${encodeURIComponent(person.slug)}`,
                label: `All ${publicationCount} in the publications index`
              }}
            />

            <ul className="mt-8 divide-y divide-line-200 border-t border-line-200">
              {publications.map((publication) => {
                const venue = publicationDisplayVenue(publication);
                const doi = doiUrl(publication.doi);
                const external = doi ?? publication.url?.trim() ?? null;

                return (
                  <li key={publication.id} className="py-5">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <Badge size="sm">{PUBLICATION_KIND_LABELS[publication.kind]}</Badge>
                      <span className="text-xs tabular-nums text-ink-500">{publication.year}</span>
                    </div>

                    <h3 className="mt-2">
                      <Link
                        href={`/publications/${publication.slug}`}
                        className="display-title text-balance text-base leading-snug transition-colors hover:text-purple-700"
                      >
                        {publication.title}
                      </Link>
                    </h3>

                    {/* The authoritative author line, exactly as printed. Never rebuilt from the linked
                        people: `PublicationAuthor` holds only the Centre's own authors, so deriving the
                        line from it would drop every external co-author. */}
                    <p className="mt-1.5 text-sm leading-relaxed text-ink-700">
                      {publication.authorLine}
                    </p>

                    {venue ? <p className="mt-1 text-sm text-ink-500">{venue}</p> : null}

                    {external ? (
                      <p className="mt-2">
                        <a
                          href={external}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-sm font-medium text-purple-700 transition-colors hover:text-purple-800"
                        >
                          <ExternalLink aria-hidden="true" className="h-4 w-4" />
                          {doi ? "DOI" : "View"}
                          <span className="sr-only">
                            {" "}
                            for {publication.title} (opens in a new tab)
                          </span>
                        </a>
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            {publicationCount > publications.length ? (
              // The cap, stated (contract §1.6). The heading's link is where the rest are.
              <p className="mt-6 text-sm text-ink-500">
                This list shows the {publications.length} most recent of {publicationCount}.{" "}
                <Link
                  href={`/publications?author=${encodeURIComponent(person.slug)}`}
                  className="font-medium text-purple-700 hover:text-purple-800"
                >
                  See every publication by {person.name}
                </Link>
                .
              </p>
            ) : null}
          </Reveal>
        ) : null}

        {/* ── Projects ──────────────────────────────────────────────────────── */}
        {projects.length > 0 ? (
          <Reveal as="section">
            <SectionHeading
              title="Projects"
              level={2}
              description={`${projectCount === 1 ? "One project" : `${projectCount} projects`} ${person.name} works on.`}
            />

            <div className="mt-8">
              <CardGrid columns={3}>
                {projects.map((project) => {
                  const from = project.startedOn ? project.startedOn.getUTCFullYear() : null;
                  const to = project.endedOn ? project.endedOn.getUTCFullYear() : null;
                  // UTC, for the reason set out in `personTenure`: a local year turns a January date
                  // into the previous year for any reader west of the Centre.
                  const years =
                    from !== null ? (to !== null && to !== from ? `${from}–${to}` : `${from}`) : null;

                  return (
                    <EntityCard
                      key={project.id}
                      href={`/projects/${project.slug}`}
                      media={project.cover}
                      title={project.title}
                      eyebrow={project.researchArea?.title ?? undefined}
                      // Truncated on the SERVER: a CSS line clamp hides text from sighted readers while
                      // leaving it in the accessibility tree, so the two disagree about what the card
                      // says.
                      description={
                        project.tagline?.trim()
                          ? project.tagline
                          : project.summary?.trim()
                            ? truncateWords(project.summary, 140)
                            : undefined
                      }
                      meta={years ? <span className="tabular-nums">{years}</span> : undefined}
                      headingLevel={3}
                    />
                  );
                })}
              </CardGrid>
            </div>

            {projectCount > projects.length ? (
              <p className="mt-6 text-sm text-ink-500">
                Showing {projects.length} of {projectCount} projects.{" "}
                <Link href="/projects" className="font-medium text-purple-700 hover:text-purple-800">
                  Browse every project
                </Link>
                .
              </p>
            ) : null}
          </Reveal>
        ) : null}

        {/* ── Speaking ──────────────────────────────────────────────────────── */}
        {events.length > 0 ? (
          <Reveal as="section">
            <SectionHeading
              title="Talks and appearances"
              level={2}
              description={`Events at which ${person.name} spoke.`}
            />

            <ul className="mt-8 divide-y divide-line-200 border-t border-line-200">
              {events.map((event) => {
                // The `where` on the relation narrowed this to THIS person's row, so the first entry is
                // their role. It may be absent, which is why it is not rendered as an empty chip.
                const role = event.speakers[0]?.role?.trim() ?? "";

                return (
                  <li key={event.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-4">
                    <span className="inline-flex items-center gap-1.5 text-sm tabular-nums text-ink-500">
                      <CalendarDays aria-hidden="true" className="h-4 w-4" />
                      {/* Formatted in the Centre's timezone by the one module that owns that decision
                          (components/site/EventDateBlock.tsx), so this page and /events cannot print
                          two different dates for one event. */}
                      {formatCentreDate(event.startsAt)}
                    </span>

                    <h3 className="min-w-0 flex-1 text-base">
                      <Link
                        href={`/events/${event.slug}`}
                        className="display-title text-balance text-base leading-snug transition-colors hover:text-purple-700"
                      >
                        {event.title}
                      </Link>
                      {role ? <span className="ml-2 text-sm font-normal text-ink-500">{role}</span> : null}
                    </h3>

                    {event.venue ? (
                      <span className="text-sm text-ink-500">{event.venue}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            {eventCount > events.length ? (
              <p className="mt-6 text-sm text-ink-500">
                Showing the {events.length} most recent of {eventCount} appearances.
              </p>
            ) : null}
          </Reveal>
        ) : null}

        {/* Nothing but a biography: said plainly rather than left as a page that looks unfinished. */}
        {publications.length === 0 && projects.length === 0 && events.length === 0 ? (
          <p className="flex items-start gap-2.5 rounded-md border border-line-200 bg-surface-50 px-3.5 py-2.5 text-sm leading-relaxed text-ink-700">
            <BookOpen aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" />
            <span>
              No publications, projects or talks are linked to this profile yet. They appear here as
              soon as they are published.
            </span>
          </p>
        ) : null}
      </div>
    </>
  );
}
