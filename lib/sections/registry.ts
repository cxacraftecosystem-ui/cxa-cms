import type { SectionType } from "@prisma/client";

/**
 * What each block type IS, in the words the person adding it uses.
 *
 * This drives the studio's "add a block" palette, and it is the only place the enum's SHOUTING_CASE
 * is translated. An administrator choosing between blocks is choosing between "Photo gallery" and
 * "Image beside text", not between GALLERY and MEDIA_SPLIT; a palette that shows the enum makes the
 * person adding a section guess, and a guess in a page builder is a page that has to be undone.
 *
 * Three things are worth knowing before editing this file:
 *
 *  • **The label is a noun phrase, the description is a sentence.** The description says what the
 *    block DOES and when to reach for it — "Use this once at the top of a page" is more useful than
 *    a restatement of the label. Together they are the whole of what a non-technical editor gets.
 *
 *  • **`icon` is a lucide name, as a string.** A string rather than a component so this module stays
 *    free of JSX and can be imported by a route handler, a seed script or a server component without
 *    dragging the icon set along. The palette resolves it once, where it renders.
 *
 *  • **`allowMultiple: false` means the palette must stop offering it once the page has one** — and
 *    per §7.5 of the contract it stops OFFERING it, rather than showing a disabled entry that
 *    explains itself only after a click.
 *
 * The groups answer "what am I trying to do", not "what is this made of":
 *   Structure — the shape of the page rather than anything it says.
 *   Content   — words this page owns.
 *   Showcase  — records curated from elsewhere in the CMS; the block stays current on its own.
 *   Media     — pictures, video and places.
 *   Story     — blocks that carry the reader THROUGH something rather than listing it. These are the
 *               only blocks whose motion is scroll-scrubbed rather than an entrance, and the only
 *               ones that cost the reader real attention, which is why they sit last in the palette.
 *
 * They are listed here in palette order, which is `SECTION_GROUPS` below and deliberately not the
 * enum's — see the note there.
 */

export type SectionGroup = "Content" | "Showcase" | "Media" | "Structure" | "Story";

export interface SectionMeta {
  type: SectionType;
  /** What the block is called in the palette and on a builder row. */
  label: string;
  /** One sentence: what it does, and when to use it. */
  description: string;
  /** A lucide-react icon name, e.g. "LayoutGrid". */
  icon: string;
  group: SectionGroup;
  /** May a page hold more than one? */
  allowMultiple: boolean;
}

/**
 * The palette, keyed by type.
 *
 * `satisfies Record<SectionType, SectionMeta>` rather than an annotation: it fails the build the
 * moment a value is added to the Prisma enum without an entry here, which is the difference between
 * finding out at compile time and finding out when a builder opens a palette with a blank row in it.
 */
export const SECTION_REGISTRY = {
  // ── Structure ─────────────────────────────────────────────────────────────
  HERO: {
    type: "HERO",
    label: "Hero banner",
    description:
      "The full-height opening of a page: a headline, a short introduction and up to two buttons over a background.",
    icon: "PanelTop",
    group: "Structure",
    // One opening per page. A second hero halfway down reads as the start of a different page, and
    // both compete for the one <h1> the accessibility contract allows.
    allowMultiple: false
  },
  SPACER: {
    type: "SPACER",
    label: "Space",
    description:
      "Deliberate empty space between two blocks, so a page can breathe without adding empty paragraphs to make room.",
    icon: "MoveVertical",
    group: "Structure",
    allowMultiple: true
  },

  // ── Content ───────────────────────────────────────────────────────────────
  RICH_TEXT: {
    type: "RICH_TEXT",
    label: "Text",
    description:
      "Formatted writing: headings, paragraphs, lists, links and tables. The everyday block for anything a page says in its own words.",
    icon: "Type",
    group: "Content",
    allowMultiple: true
  },
  STATS: {
    type: "STATS",
    label: "Key figures",
    description:
      "A row of headline numbers with labels, such as projects funded or people trained, optionally counting up as the reader arrives.",
    icon: "TrendingUp",
    group: "Content",
    allowMultiple: true
  },
  FEATURE_GRID: {
    type: "FEATURE_GRID",
    label: "Feature grid",
    description:
      "Two to four columns of small cards, each with an icon, a title and a line or two. Good for capabilities, services or themes.",
    icon: "LayoutGrid",
    group: "Content",
    allowMultiple: true
  },
  TIMELINE: {
    type: "TIMELINE",
    label: "Timeline",
    description:
      "A chronology of dated entries. Dates are written as text, so “c. 1780” and “2024–26” are both allowed.",
    icon: "History",
    group: "Content",
    allowMultiple: true
  },
  QUOTE: {
    type: "QUOTE",
    label: "Quote",
    description:
      "A single quotation with an attribution and an optional portrait, set large across the column.",
    icon: "Quote",
    group: "Content",
    allowMultiple: true
  },
  CTA: {
    type: "CTA",
    label: "Call to action",
    description:
      "A panel that asks the reader to do one thing — apply, enquire, register — with one or two buttons.",
    icon: "MousePointerClick",
    group: "Content",
    allowMultiple: true
  },
  FAQ: {
    type: "FAQ",
    label: "Questions and answers",
    description:
      "Questions that open to reveal their answers. Use the words people actually ask in, not the official phrasing.",
    icon: "HelpCircle",
    group: "Content",
    allowMultiple: true
  },
  CONTACT_FORM: {
    type: "CONTACT_FORM",
    label: "Contact form",
    description:
      "A form whose messages arrive in the studio inbox. Choose which inbox, and whether to show the Centre's address beside it.",
    icon: "Mail",
    group: "Content",
    // Two forms on one page would put two fields called "Email" in the same document: the labels stop
    // identifying anything, and a screen reader announces both the same way.
    allowMultiple: false
  },
  FORM_EMBED: {
    type: "FORM_EMBED",
    label: "Embedded form",
    description:
      "A Google Form, Microsoft Form or Typeform shown on the page. Readers open it with a button, so nothing is loaded from the form's own service until somebody wants it, and there is always a plain link as well.",
    icon: "FileInput",
    // Beside the contact form rather than under Media: somebody looking for "the applications form"
    // looks where the other form is, not among the pictures.
    group: "Content",
    // Two embedded forms on one page is a page asking a reader to choose between two applications with
    // no explanation. Where that is genuinely the case, they belong on two pages.
    allowMultiple: false
  },
  ACTION_STEPS: {
    type: "ACTION_STEPS",
    label: "Steps to follow",
    description:
      "A numbered list of things a reader has to do, each with its own closing date and button. Use it for how to apply, what to bring, or a submission checklist.",
    icon: "ListChecks",
    group: "Content",
    // More than one is normal and useful: "Before you apply" and "After you apply" are two lists.
    allowMultiple: true
  },
  LINK_GRID: {
    type: "LINK_GRID",
    label: "Link grid",
    description:
      "A grid of links to guidelines, past papers, funding calls or anything else worth reading — on this site or another one.",
    icon: "Grid2x2",
    group: "Content",
    allowMultiple: true
  },

  // ── Showcase ──────────────────────────────────────────────────────────────
  RESEARCH_SHOWCASE: {
    type: "RESEARCH_SHOWCASE",
    label: "Research areas",
    description:
      "Research areas pulled from the CMS, as cards or as the interactive graph. Keeps itself up to date unless you pick them by hand.",
    icon: "Microscope",
    group: "Showcase",
    allowMultiple: true
  },
  PROJECT_SHOWCASE: {
    type: "PROJECT_SHOWCASE",
    label: "Projects",
    description:
      "Projects from the CMS — the latest, the featured ones, or a list you choose. Can be limited to one stage, such as active.",
    icon: "FolderKanban",
    group: "Showcase",
    allowMultiple: true
  },
  PEOPLE_SHOWCASE: {
    type: "PEOPLE_SHOWCASE",
    label: "People",
    description:
      "People from the CMS, with photographs and designations. Can be limited to one group, such as faculty.",
    icon: "Users",
    group: "Showcase",
    allowMultiple: true
  },
  PUBLICATION_LIST: {
    type: "PUBLICATION_LIST",
    label: "Publications",
    description:
      "Publications in citation form, optionally grouped by year and limited to one sort, such as journal articles.",
    icon: "BookOpen",
    group: "Showcase",
    allowMultiple: true
  },
  NEWS_SHOWCASE: {
    type: "NEWS_SHOWCASE",
    label: "News",
    description:
      "Recent news from the newsroom, as a feature, a grid or a plain list. Updates itself as new pieces are published.",
    icon: "Newspaper",
    group: "Showcase",
    allowMultiple: true
  },
  EVENT_SHOWCASE: {
    type: "EVENT_SHOWCASE",
    label: "Events",
    description:
      "Events from the calendar. Upcoming events empty themselves as they pass, so the block is never out of date.",
    icon: "CalendarDays",
    group: "Showcase",
    allowMultiple: true
  },
  PARTNER_LOGOS: {
    type: "PARTNER_LOGOS",
    label: "Partner logos",
    description:
      "A wall of partner and funder logos, drawn in one tone so a page of clashing brand colours stays calm.",
    icon: "Handshake",
    group: "Showcase",
    allowMultiple: true
  },
  CRAFT_EXPLORER: {
    type: "CRAFT_EXPLORER",
    label: "Craft explorer",
    description:
      "Crafts from the archive as a map, a grid or a timeline, with filters for region, material and technique.",
    icon: "Compass",
    group: "Showcase",
    // The map and its filters are heavy and take over a page. Two on one page compete for the reader
    // and load two copies of the same data.
    allowMultiple: false
  },
  DOWNLOADS: {
    type: "DOWNLOADS",
    label: "Downloads",
    description:
      "Files from the file store, with their type, size and version, so nobody starts a large download by accident.",
    icon: "Download",
    group: "Showcase",
    allowMultiple: true
  },

  // ── Media ─────────────────────────────────────────────────────────────────
  GALLERY: {
    type: "GALLERY",
    label: "Photo gallery",
    description:
      "Albums or photographs from the media library, as a masonry wall, an even grid or a scrolling line, opening full screen when clicked.",
    icon: "Images",
    group: "Media",
    allowMultiple: true
  },
  MEDIA_SPLIT: {
    type: "MEDIA_SPLIT",
    label: "Image beside text",
    description:
      "One picture or video on one side, a heading and text on the other. Alternate the side down a page to give it rhythm.",
    icon: "Columns2",
    group: "Media",
    allowMultiple: true
  },
  EMBED: {
    type: "EMBED",
    label: "Video or embed",
    description:
      "A YouTube or Vimeo video, or any other page in a frame. Always needs a description, which is what a screen reader announces.",
    icon: "Video",
    group: "Media",
    allowMultiple: true
  },
  MAP: {
    type: "MAP",
    label: "Map",
    description:
      "A pin on a map with the postal address beside it, so the address is readable whether or not the map loads.",
    icon: "Map",
    group: "Media",
    allowMultiple: true
  },

  // ── Story ─────────────────────────────────────────────────────────────────
  STORY_SCROLL: {
    type: "STORY_SCROLL",
    label: "Scrolling story",
    description:
      "Chapters of writing, each with a photograph that stays put while its words scroll past. Use it to explain how something is made, or to tell the history of one craft.",
    icon: "BookOpenText",
    group: "Story",
    // Two stories on one page is two pages. The reader has finished the first one by the time they
    // reach the second, and nothing tells them the page has started again.
    allowMultiple: false
  },
  PARALLAX_BANNER: {
    type: "PARALLAX_BANNER",
    label: "Photograph band",
    description:
      "One photograph across the full width with a line of text over it, drifting slowly as the reader passes. Use it to change the subject between two parts of a page.",
    icon: "GalleryHorizontalEnd",
    group: "Story",
    allowMultiple: true
  },
  HORIZONTAL_RAIL: {
    type: "HORIZONTAL_RAIL",
    label: "Sideways rail",
    description:
      "A line of cards the reader travels along sideways. It can be set to hold the page still and move the rail as they scroll down — striking once on a page, tiring twice.",
    icon: "GalleryHorizontal",
    group: "Story",
    allowMultiple: true
  },
  PROCESS_STEPS: {
    type: "PROCESS_STEPS",
    label: "How it is made",
    description:
      "The stages of a process, with a line drawn between them as the reader descends. For describing what somebody else does — “Steps to follow” is the block for things the reader must do.",
    icon: "Workflow",
    group: "Story",
    allowMultiple: true
  },
  PLATFORM_PILLARS: {
    type: "PLATFORM_PILLARS",
    label: "Platform pillars",
    description:
      "The platform's three instruments — the living archive, the field record and the intelligence layer — as three animated drawings with a fixed line of copy each. Only the heading above them is editable.",
    icon: "Columns3",
    group: "Story",
    // The three vignettes are one fixed composition describing THE platform. A second copy on the
    // same page would be the identical drawing twice, saying the identical thing.
    allowMultiple: false
  },
  INDIA_MAP: {
    type: "INDIA_MAP",
    label: "Map of India",
    description:
      "The outline of India with a pin for every region holding published crafts, counted live from the archive, beside a list that links each region into the explorer. Only the heading is editable.",
    icon: "MapPin",
    group: "Showcase",
    // One country, one map. A second copy is the identical picture saying the identical thing.
    allowMultiple: false
  }
} satisfies Record<SectionType, SectionMeta>;

/**
 * The order the palette shows its groups in.
 *
 * Structure first because a page usually starts with a hero, then the words it owns, then what it
 * pulls in, then its pictures. It is a deliberate ordering, not the enum's.
 *
 * Story is LAST, and that placement is a judgement rather than an afterthought. These are the blocks
 * that cost the reader the most — a scrolling story is a commitment, a pinned rail takes the scroll
 * away — so they sit where somebody arrives having already found that none of the ordinary blocks
 * says what they meant, rather than at the top where they are the first thing tried.
 */
export const SECTION_GROUPS: SectionGroup[] = ["Structure", "Content", "Showcase", "Media", "Story"];

export const SECTION_GROUP_DESCRIPTIONS: Record<SectionGroup, string> = {
  Structure: "The shape of the page.",
  Content: "Words this page owns.",
  Showcase: "Records from elsewhere in the studio, kept up to date on their own.",
  Media: "Pictures, video and places.",
  Story: "Blocks that carry the reader through something, rather than listing it."
};

/** Every block, in palette order: by group, then in the order declared above. */
export const SECTION_META: SectionMeta[] = SECTION_GROUPS.flatMap((group) =>
  Object.values(SECTION_REGISTRY).filter((meta) => meta.group === group)
);

export function sectionMeta(type: SectionType): SectionMeta {
  return SECTION_REGISTRY[type];
}

/**
 * The name to show for a block type.
 *
 * Takes a plain string as well as a `SectionType` so a builder row can label a value that came off
 * the wire, and falls back to the raw value rather than to "Unknown": an editor who can see HERO can
 * at least say what they are looking at, where "Unknown block" tells them nothing at all.
 */
export function sectionLabel(type: SectionType | string): string {
  const meta = (SECTION_REGISTRY as Record<string, SectionMeta | undefined>)[type];
  return meta ? meta.label : String(type);
}

export function sectionsInGroup(group: SectionGroup): SectionMeta[] {
  return SECTION_META.filter((meta) => meta.group === group);
}
