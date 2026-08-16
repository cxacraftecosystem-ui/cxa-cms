/**
 * SectionRenderer — the dispatcher. Every page built out of `PageSection` rows comes through here.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A BAD PAYLOAD MUST NOT TAKE THE PAGE DOWN, AND MUST NOT LEAVE A HOLE.
 *
 * `PageSection.data` is a JSON column. It is validated on write, but a payload can still arrive here
 * broken: a hand-edited row, a restored revision from an older schema, a migration that ran halfway,
 * a deployment rolled back to code that predates a field. Two failure modes, one answer:
 *
 *   1. **The payload does not parse.** Every field in lib/sections/schema.ts carries a default, so
 *      this means something genuinely wrong rather than merely old. In development the block renders
 *      as an outlined card naming the section, its type, its id and the validation message — which
 *      lib/sections/schema.ts has already written as a sentence naming the offending field, so the
 *      editor who broke it can see precisely what. In production it renders NOTHING and logs
 *      server-side: a visitor cannot act on a validation message and should not be shown one.
 *
 *   2. **The type is one this deployment has never heard of** — a row written by a NEWER deployment,
 *      seen after a rollback. Handled identically. A CMS whose renderer throws on an unrecognised
 *      block cannot be rolled back, which turns every bad release into a forward-only emergency.
 *
 * Note the deliberate asymmetry with a block that is merely EMPTY. An empty block states its
 * emptiness on screen (contract §1.6, and rule 4 of lib/sections/schema.ts); a block that is BROKEN
 * says nothing to a visitor, because "this part of the page is misconfigured" is a message for the
 * Centre and not for a reader who came to look at the research.
 *
 * THE MAP IS `{ [K in SectionType]: Renderer<K> }` AND THAT IS THE POINT. Adding a value to the
 * Prisma enum is a compile error here until a renderer exists for it, and wiring a type to the wrong
 * renderer is a compile error too, because each entry is checked against ITS OWN payload and row
 * types. That is the same guarantee `SECTION_SCHEMAS` gives for schemas and `SECTION_REGISTRY` gives
 * for palette entries. A `switch` with a `default` would have compiled happily and shipped a gap.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * NO RENDERER QUERIES. `lib/sections/resolve.ts` fetches every row a page needs in ONE batched pass,
 * and the `EXTRAS` table below is the only place that knows which map in that result belongs to which
 * block type. A renderer receives plain rows and stays pure and testable.
 *
 * IT IS ASYNC, FOR EXACTLY ONE REASON: the contact form's details column comes from the `contact`
 * settings group, and the form is a Client Component that cannot read `server-only` code. The read is
 * `cache()`-deduplicated and is skipped entirely unless the page actually holds a CONTACT_FORM block.
 *
 * A SERVER COMPONENT. It holds no state and no handlers, so the dispatch, the parsing and the error
 * handling all stay on the server; the individual renderers that need the browser carry their own
 * `"use client"`. `console.error` below therefore lands in the server log, where an operator will
 * look for it.
 */

import { Fragment, type ReactNode } from "react";
import type { PageSection, SectionType } from "@prisma/client";

import { sectionAnchor } from "@/lib/sections/anchor";
import { sectionLabel } from "@/lib/sections/registry";
import {
  galleryRowsFor,
  showcaseFor,
  type AlbumRow,
  type CraftRow,
  type EventRow,
  type FileRow,
  type GalleryImageRow,
  type PartnerRow,
  type PersonRow,
  type PostRow,
  type ProjectRow,
  type PublicationRow,
  type ResearchAreaRow,
  type ResolvedSectionData
} from "@/lib/sections/resolve";
import { parseSectionData, type SectionPayloads } from "@/lib/sections/schema";
import { getSettingCached } from "@/lib/settings/service";
import type { ContactSettings } from "@/lib/settings/schema";

import { ActionStepsSection } from "@/components/sections/ActionStepsSection";
import { ContactFormSection } from "@/components/sections/ContactFormSection";
import { CraftExplorerSection } from "@/components/sections/CraftExplorerSection";
import { CtaSection } from "@/components/sections/CtaSection";
import { DocumentEmbedSection } from "@/components/sections/DocumentEmbedSection";
import { DownloadsSection } from "@/components/sections/DownloadsSection";
import { EmbedSection } from "@/components/sections/EmbedSection";
import { EventShowcaseSection } from "@/components/sections/EventShowcaseSection";
import { FaqSection } from "@/components/sections/FaqSection";
import { FeatureGridSection } from "@/components/sections/FeatureGridSection";
import { FormEmbedSection } from "@/components/sections/FormEmbedSection";
import { GallerySection } from "@/components/sections/GallerySection";
import { HeroSection } from "@/components/sections/HeroSection";
import { HorizontalRailSection } from "@/components/sections/HorizontalRailSection";
import { LinkGridSection } from "@/components/sections/LinkGridSection";
import { ParallaxBannerSection } from "@/components/sections/ParallaxBannerSection";
import { PlatformPillarsSection } from "@/components/sections/PlatformPillarsSection";
import { IndiaMapSection } from "@/components/sections/IndiaMapSection";
import { ProcessStepsSection } from "@/components/sections/ProcessStepsSection";
import { StoryScrollSection } from "@/components/sections/StoryScrollSection";
import { MapSection } from "@/components/sections/MapSection";
import { MediaSplitSection } from "@/components/sections/MediaSplitSection";
import { NewsShowcaseSection } from "@/components/sections/NewsShowcaseSection";
import { PartnerLogosSection } from "@/components/sections/PartnerLogosSection";
import { PeopleShowcaseSection } from "@/components/sections/PeopleShowcaseSection";
import { ProjectShowcaseSection } from "@/components/sections/ProjectShowcaseSection";
import { PublicationListSection } from "@/components/sections/PublicationListSection";
import { QuoteSection } from "@/components/sections/QuoteSection";
import { ResearchShowcaseSection } from "@/components/sections/ResearchShowcaseSection";
import { RichTextSection } from "@/components/sections/RichTextSection";
import { SpacerSection } from "@/components/sections/SpacerSection";
import { StatsSection } from "@/components/sections/StatsSection";
import { TimelineSection } from "@/components/sections/TimelineSection";

// ─────────────────────────────────────────────────────────────────────────────
// What each renderer is called with
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The row type each showcase block is handed.
 *
 * Keys are a SUBSET of `SectionType` deliberately: a block that renders only its own payload appears
 * nowhere here and is handed nothing extra.
 */
interface ShowcaseRowOf {
  RESEARCH_SHOWCASE: ResearchAreaRow;
  PROJECT_SHOWCASE: ProjectRow;
  PEOPLE_SHOWCASE: PersonRow;
  PUBLICATION_LIST: PublicationRow;
  NEWS_SHOWCASE: PostRow;
  EVENT_SHOWCASE: EventRow;
  PARTNER_LOGOS: PartnerRow;
  DOWNLOADS: FileRow;
  CRAFT_EXPLORER: CraftRow;
}

/** How many rows matched, and how many hand-picked ids no longer resolve. Every showcase gets both. */
interface ShowcaseCounts {
  total: number;
  droppedIds: number;
}

/**
 * The props beyond `data` and `section`, per block type.
 *
 * Three shapes, because there are genuinely three kinds of block: one that pulls a list of records,
 * one that pulls named media assets out of `resolved.media`, and the gallery — the only block whose
 * manual ids can name rows in two different tables (see `galleryRowsFor`).
 */
type ExtraPropsOf<T extends SectionType> = T extends keyof ShowcaseRowOf
  ? { rows: ShowcaseRowOf[T][] } & ShowcaseCounts
  : T extends "GALLERY"
    ? { albums: AlbumRow[]; images: GalleryImageRow[] } & ShowcaseCounts
    : T extends "CONTACT_FORM"
      ? { contact: ContactSettings | null }
      : { resolved: ResolvedSectionData };

/**
 * The full call signature for one block type.
 *
 * A renderer may declare FEWER of these — most ignore `section`, several ignore `resolved` — and still
 * satisfy the map, because a function that asks for less than it is handed is assignable to one that
 * asks for more. What it may not do is ask for something else, which is the mistake this catches.
 */
export type SectionRenderProps<T extends SectionType> = {
  data: SectionPayloads[T];
  section: PageSection;
} & ExtraPropsOf<T>;

type Renderer<T extends SectionType> = (props: SectionRenderProps<T>) => ReactNode;

/**
 * Every block type to the component that draws it.
 *
 * ⚠ Do NOT annotate this as `Record<SectionType, Renderer<SectionType>>`. That widens every entry's
 * payload and row types to the union of ALL of them and throws away the per-type check that
 * makes a mis-wired entry — HERO pointing at the stats renderer — a compile error.
 */
const RENDERERS: { [K in SectionType]: Renderer<K> } = {
  HERO: HeroSection,
  RICH_TEXT: RichTextSection,
  STATS: StatsSection,
  FEATURE_GRID: FeatureGridSection,
  RESEARCH_SHOWCASE: ResearchShowcaseSection,
  PROJECT_SHOWCASE: ProjectShowcaseSection,
  PEOPLE_SHOWCASE: PeopleShowcaseSection,
  PUBLICATION_LIST: PublicationListSection,
  NEWS_SHOWCASE: NewsShowcaseSection,
  EVENT_SHOWCASE: EventShowcaseSection,
  GALLERY: GallerySection,
  MEDIA_SPLIT: MediaSplitSection,
  TIMELINE: TimelineSection,
  PARTNER_LOGOS: PartnerLogosSection,
  QUOTE: QuoteSection,
  CTA: CtaSection,
  FAQ: FaqSection,
  CONTACT_FORM: ContactFormSection,
  MAP: MapSection,
  EMBED: EmbedSection,
  DOWNLOADS: DownloadsSection,
  CRAFT_EXPLORER: CraftExplorerSection,
  SPACER: SpacerSection,
  // None of the three appears in `EXTRAS` below: each renders only its own payload, so each is handed
  // `{ resolved }` and simply does not declare it.
  ACTION_STEPS: ActionStepsSection,
  FORM_EMBED: FormEmbedSection,
  LINK_GRID: LinkGridSection,
  /*
   * The narrative four. Each is handed `{ resolved }` like the three above, and each uses it — a
   * picture in one of these blocks may be an uploaded `MediaAsset` (resolved here, in the batched
   * read) or a slug from the bundled craft manifest (resolved from a compiled-in constant, with no
   * query at all). `components/sections/story/StoryPicture.tsx` owns that precedence so the four
   * renderers cannot disagree about it.
   */
  STORY_SCROLL: StoryScrollSection,
  PARALLAX_BANNER: ParallaxBannerSection,
  HORIZONTAL_RAIL: HorizontalRailSection,
  PROCESS_STEPS: ProcessStepsSection,
  // The platform's three fixed vignettes. All copy and geometry are code (see the schema's note),
  // so it renders only its own payload and is handed `{ resolved }` it does not declare.
  PLATFORM_PILLARS: PlatformPillarsSection,
  INDIA_MAP: IndiaMapSection,
  /*
   * One uploaded document, placed on the page. It is absent from `EXTRAS` below and takes the
   * fall-through `{ resolved }`, which is exactly right: like the hero's backdrop and the picture
   * beside a text block, its document is a `MediaAsset` named BY ID in the payload and keyed by ASSET
   * id in `resolved.media`, not a curated list keyed by block. `lib/sections/resolve.ts` is where that
   * id is collected into the batched read; the renderer states its own case when it resolves to
   * nothing, because an asset can be deleted after a payload has named it.
   */
  DOCUMENT_EMBED: DocumentEmbedSection
};

// ─────────────────────────────────────────────────────────────────────────────
// Which resolved map belongs to which block type
// ─────────────────────────────────────────────────────────────────────────────

interface ExtrasContext {
  sectionId: string;
  resolved: ResolvedSectionData;
  contact: ContactSettings | null;
}

/**
 * The one place that knows a NEWS_SHOWCASE reads `resolved.news`.
 *
 * A table rather than a `switch` so the mapping is legible in one screen, and so a block type absent
 * from it visibly falls through to `resolved` — which is what the media-consuming blocks (hero, image
 * beside text, timeline, quote) want, because their assets are keyed by ASSET id and not by block.
 */
const EXTRAS: Partial<Record<SectionType, (context: ExtrasContext) => object>> = {
  RESEARCH_SHOWCASE: ({ resolved, sectionId }) => showcaseFor(resolved.research, sectionId),
  PROJECT_SHOWCASE: ({ resolved, sectionId }) => showcaseFor(resolved.projects, sectionId),
  PEOPLE_SHOWCASE: ({ resolved, sectionId }) => showcaseFor(resolved.people, sectionId),
  PUBLICATION_LIST: ({ resolved, sectionId }) => showcaseFor(resolved.publications, sectionId),
  NEWS_SHOWCASE: ({ resolved, sectionId }) => showcaseFor(resolved.news, sectionId),
  EVENT_SHOWCASE: ({ resolved, sectionId }) => showcaseFor(resolved.events, sectionId),
  PARTNER_LOGOS: ({ resolved, sectionId }) => showcaseFor(resolved.partners, sectionId),
  DOWNLOADS: ({ resolved, sectionId }) => showcaseFor(resolved.files, sectionId),
  CRAFT_EXPLORER: ({ resolved, sectionId }) => showcaseFor(resolved.crafts, sectionId),
  GALLERY: ({ resolved, sectionId }) => galleryRowsFor(resolved, sectionId),
  CONTACT_FORM: ({ contact }) => ({ contact })
};

/**
 * The props for one block, assembled.
 *
 * ⚠ THE RETURN IS DELIBERATELY LOOSE, and this is the single unchecked step in the file. `section.type`
 * is a union here, so nothing in the type system can tie "the extras built for this row" to "the
 * renderer looked up for this row" — the two are only correlated at runtime, through the same key.
 * The `RENDERERS` map above is what proves each renderer matches its own payload and rows; this
 * function is where we assert that the key used to reach both was the same key. Keep the assertion
 * here, in one place, rather than spreading `as` casts across every call site.
 */
type LooseProps = Record<string, unknown>;
type LooseRenderer = (props: LooseProps) => ReactNode;

// ─────────────────────────────────────────────────────────────────────────────
// Does anything on this page own the <h1>?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Will one of these blocks actually RENDER the page's `<h1>`?
 *
 * ⚠ "A HERO BLOCK EXISTS" IS A DIFFERENT QUESTION, and answering that one instead is how pages shipped
 * with no `<h1>` at all. `HeroSection` draws its heading only when the headline has words in it — a
 * hero whose headline an editor cleared, or has not written yet, still draws its eyebrow, its
 * introduction, its buttons and its backdrop, and no heading. A hidden block draws nothing. A block
 * whose payload fails validation draws nothing in production (see `renderSection`). Each of those is a
 * page whose outline begins at level 2 and whose title exists only in the browser tab — which a
 * screen-reader user, who navigates by the outline, has no way to read at all.
 *
 * `HERO` is the ONLY type that can produce an `<h1>`, and that is enforced elsewhere rather than
 * assumed here: `SectionHeading` starts at level 2 and level 1 is deliberately absent from its union,
 * and `components/RichText.tsx` clamps an editor's level-1 heading down to an `<h2>`.
 *
 * The Zod parse runs twice for a hero — once here and once in `renderSection` — which is one pure
 * re-parse of one small payload per page, and cheaper than a second opinion about what a hero draws.
 *
 * A caller told `false` MUST supply the `<h1>` itself, from the page's own title. See
 * `app/(site)/page.tsx`, `app/(site)/[...slug]/page.tsx` and `app/(site)/about/page.tsx` — the three
 * routes that build a page out of blocks.
 */
export function sectionsOwnPageTitle(sections: readonly PageSection[]): boolean {
  return sections.some((section) => {
    if (!section.isVisible) return false;
    if (section.type !== "HERO") return false;
    const parsed = parseSectionData("HERO", section.data);
    return parsed.ok && parsed.data.headline.trim().length > 0;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The component
// ─────────────────────────────────────────────────────────────────────────────

export interface SectionRendererProps {
  sections: readonly PageSection[];
  /** The batched read from `lib/sections/resolve.ts` for THESE sections. */
  resolved: ResolvedSectionData;
}

export async function SectionRenderer({ sections, resolved }: SectionRendererProps) {
  // Copied before sorting: `sections` is a prop, and sorting it in place would mutate the caller's
  // array. The query that produced it is already ordered; this makes the guarantee local rather than
  // distributed across every page that renders a page body.
  const ordered = [...sections].sort((a, b) => a.position - b.position);

  // Read once, and only when something on the page needs it. `getSettingCached` is `cache()`-wrapped,
  // so a layout that has already read the group pays nothing here.
  const needsContact = ordered.some(
    (section) => section.type === "CONTACT_FORM" && section.isVisible
  );
  const contact: ContactSettings | null = needsContact ? await getSettingCached("contact") : null;

  return (
    <>
      {ordered.map((section) => {
        const rendered = renderSection(section, resolved, contact);
        if (rendered === null) return null;

        /**
         * A NAMED ANCHOR, so a menu entry can point at a passage rather than a page —
         * `/about#history` is exactly what the shipped default navigation does.
         *
         * Read off the RAW `data` (see lib/sections/anchor.ts): the anchor is addressing rather than
         * content, so it lives outside the validated payload and a block whose content failed
         * validation is still reachable by its anchor. A link that lands and a block that shows an
         * editor an error beats a link that goes nowhere.
         *
         * The wrapper is a plain `<div>` and NOT a `<section>`: every renderer already emits its own
         * `<section>` with its own vertical rhythm, and nesting one inside another would add a second
         * landmark to the accessibility tree for one visual band. `scroll-margin-top` comes from
         * globals.css's `[id][data-anchor]` rule, so the header clearance is not restated here.
         */
        const anchor = sectionAnchor(section.data);

        return anchor ? (
          <div key={section.id} id={anchor} data-anchor="">
            {rendered}
          </div>
        ) : (
          <Fragment key={section.id}>{rendered}</Fragment>
        );
      })}
    </>
  );
}

function renderSection(
  section: PageSection,
  resolved: ResolvedSectionData,
  contact: ContactSettings | null
): ReactNode {
  // Hidden is not deleted: an editor turning a block off expects it gone from the page and still
  // there in the builder.
  if (!section.isVisible) return null;

  /**
   * `RENDERERS[section.type]` can never be undefined according to the types, and CAN be undefined in
   * fact — `section.type` arrives from a database that may be one deployment ahead of this code. The
   * `Partial` view is what turns "undefined is not a function" into a message.
   */
  const lookup: Partial<Record<string, LooseRenderer>> = RENDERERS as unknown as Partial<
    Record<string, LooseRenderer>
  >;
  const Renderer = lookup[section.type];

  if (!Renderer) {
    return (
      <SectionProblem
        section={section}
        reason={`This deployment has no renderer for a "${String(section.type)}" block. It was most likely written by a newer release.`}
      />
    );
  }

  const parsed = parseSectionData(section.type, section.data);
  if (!parsed.ok) return <SectionProblem section={section} reason={parsed.message} />;

  const buildExtras = EXTRAS[section.type];
  const extras = buildExtras
    ? buildExtras({ sectionId: section.id, resolved, contact })
    : // Everything not in the table reads named media assets out of `resolved.media`, keyed by asset
      // id. Handing the whole object over costs nothing — it is already built.
      { resolved };

  return <Renderer data={parsed.data} section={section} {...extras} />;
}

/**
 * What a broken block looks like.
 *
 * Production returns `null` rather than an empty wrapper: an empty `<section className="py-20">` would
 * leave a visible gap that reads as a design mistake rather than as a block that failed.
 */
function SectionProblem({ section, reason }: { section: PageSection; reason: string }): ReactNode {
  // Logged in BOTH environments. In development the card is easy to miss on a long page; in
  // production the log is the only trace there is.
  console.error(
    `[sections] ${String(section.type)} block ${section.id} on page ${section.pageId} was not rendered: ${reason}`
  );

  if (process.env.NODE_ENV === "production") return null;

  return (
    <section className="py-8" data-section-error={String(section.type)}>
      <div className="shell">
        {/* amber-100 with amber-800 as a PAIR — amber-50 and amber-200 are stock Tailwind here and do
            not pair correctly (contract §1). */}
        <div className="rounded-lg border border-dashed border-amber-800/40 bg-amber-100 p-4 text-amber-800">
          <p className="text-sm font-semibold">
            {section.label?.trim() || sectionLabel(section.type)} — this block could not be rendered
          </p>
          <p className="mt-1.5 text-sm leading-relaxed">{reason}</p>
          <p className="mt-2 font-mono text-xs opacity-80">
            {String(section.type)} · {section.id}
          </p>
          <p className="mt-2 text-xs">
            This card appears in development only. In production the block is left out of the page
            entirely and the failure is written to the server log.
          </p>
        </div>
      </div>
    </section>
  );
}
