import "server-only";

import type { SectionType } from "@prisma/client";

import { livePublishableWhere, liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { pagePath } from "@/lib/pages";
import {
  canAuthor,
  canManageContent,
  canManageMedia,
  canManageResearch,
  canManageStructure,
  type PermissionSubject
} from "@/lib/permissions";
import { sectionLabel } from "@/lib/sections/registry";
// ⚠ `sectionPlaceholderPrompts` RATHER THAN A LIST DERIVED HERE. See `judgementFor()` below: this report and
// the publish gate must never be able to disagree about what counts as the studio's own prompt text, and for
// one string they did.
import { parseSectionData, sectionPlaceholderPrompts } from "@/lib/sections/schema";
import { getSetting } from "@/lib/settings/service";
import { stableJson } from "@/lib/utils";
// The single declared home of the Centre's time zone (see its header). A date printed here in UTC could
// name the day before the one the site shows, which on this screen would look like a second fault.
import { formatCentreDate } from "@/components/site/EventDateBlock";

/**
 * THE CONTENT HEALTH REPORT — "is anything wrong with our site?", answered in one pass.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT A FINDING IS, AND WHY IT HAS THREE PARTS.
 *
 * Every finding says WHAT is wrong, WHY IT MATTERS in one sentence, and WHERE to fix it. All three are
 * required, and the middle one is the reason this module exists rather than a list of counts on the
 * dashboard: "12 images have no description" is a number an administrator can read for a year without
 * acting on it, and "somebody using a screen reader is told nothing at all about those twelve
 * photographs" is a job. A report that states a fault without stating its consequence trains its reader
 * to close it.
 *
 * SEVERITY IS ABOUT THE VISITOR, NOT ABOUT EFFORT. `urgent` means a visitor can see something wrong or
 * is being told something untrue right now; `important` means somebody loses something — a reader, a
 * search engine, a colleague — but nothing is broken; `tidy` is housekeeping that nothing public depends
 * on. Sorting by how hard something is to fix would put the site's blank published page below sixty
 * forgotten drafts.
 *
 * EVERY FINDING CARRIES THE PREDICATE OF THE SCREEN IT LINKS TO. A finding a reader cannot act on is not
 * shown greyed out — it is not shown at all, and the screen says so once rather than nineteen times
 * (contract §1.8). `can` is a REFERENCE to a predicate in lib/permissions.ts, so the row and the handler
 * behind the screen it points at are literally calling the same function (contract §1.7).
 *
 * COUNTS ARE TOTALS; EXAMPLES ARE CAPPED AND SAY SO. Naming three of twelve is the difference between a
 * number and a job, and a list that quietly stopped at three would read as three being all there were
 * (contract §1.6). `total` is always the real figure and `moreThanNamed` is what the screen prints.
 *
 * ⚠ EMPTY BLOCKS ARE JUDGED FROM THE VOCABULARY lib/sections/schema.ts EXPORTS, NOT FROM A LIST WRITTEN
 * HERE AND NOT FROM A SECOND DERIVATION OF ITS OWN. See `judgementFor()` below: whether a block type can be
 * judged at all is `sectionPlaceholderPrompts(type)` being non-empty — whether its seed carries prompt text
 * ("Add a headline", "Write the text for this section.", "Replace this photograph with one of your own.") —
 * which cleanly separates the blocks that render only their own words from the blocks that fill themselves
 * with records from elsewhere in the studio. A hand-written list of "self-contained types" here would be a
 * second copy of lib/sections/registry.ts and would rot the first time a block type was added; a second
 * DERIVATION here rotted faster than that, and the ⚠ on `judgementFor()` records what it cost. This report
 * and the publish gate in lib/pages.ts now read the same exported strings, so neither can be the stricter
 * one about which words count.
 *
 * ⚠ `CODE_OWNED_ROUTES` AND `UNCHECKABLE_COLLECTIONS` ARE TWINS OF THE TWO SETS IN app/studio/page.tsx.
 * They cannot be imported — that file is a page, and a page exports a component and its route config —
 * and both lists are maintained by hand against the directory listing in contract §12. A wrong entry can
 * only ever produce a false alarm on this screen, never a broken link on the site.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO. It never writes. It is read by one screen, on demand, and it
 * has no cron, no cache and no stored state — a health report that could be stale is a health report
 * nobody can act on, because the first question about every finding would be "is that still true?".
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

export type HealthSeverity = "urgent" | "important" | "tidy";

export interface HealthSeverityMeta {
  key: HealthSeverity;
  /** A heading in plain words. Never "P1" and never a colour name. */
  label: string;
  /** One sentence saying what this group of findings has in common. */
  description: string;
  /** A `BadgeTone` from components/ui/Badge.tsx. Paired with a word and a glyph, never alone (§11). */
  tone: "error" | "warn" | "neutral";
}

/** Worst first. The screen renders the groups in this order and so does nothing else. */
export const HEALTH_SEVERITIES: readonly HealthSeverityMeta[] = [
  {
    key: "urgent",
    label: "Wrong on the site now",
    description:
      "A visitor can see this, or is being told something that is not true. These are worth fixing today.",
    tone: "error"
  },
  {
    key: "important",
    label: "Worth fixing soon",
    description:
      "Nothing is broken, but somebody loses something: a reader who cannot see, a search engine, or whoever picks this up next year.",
    tone: "warn"
  },
  {
    key: "tidy",
    label: "Tidying up",
    description:
      "Housekeeping. Nothing on the public site depends on any of it, and leaving it alone costs nothing.",
    tone: "neutral"
  }
];

export interface HealthFinding {
  /** Stable across runs, so it can be a React key and a link target. */
  id: string;
  severity: HealthSeverity;
  /** States the number AND the thing, in words. This is the line a reader scans. */
  title: string;
  /** ONE sentence: why it matters. Not what to do — that is the link. */
  why: string;
  /** The screen that fixes it, filtered where the list can be. */
  href: string;
  /** Names the destination: "Open the media library". Never "Click here". */
  fixLabel: string;
  /** The real figure, always. */
  total: number;
  /** Up to four of them, by name. Empty where the destination list is the better answer. */
  examples: string[];
  /** How many are NOT named above. The screen prints "and 9 more". */
  moreThanNamed: number;
  /** The predicate of the screen this points at. See the header. */
  can: (subject: PermissionSubject | null | undefined) => boolean;
}

export interface HealthReport {
  generatedAt: Date;
  /** Only findings with something to report, worst first. */
  findings: HealthFinding[];
  /** How many checks ran, including the ones that found nothing — so "all clear" can be specific. */
  checksRun: number;
  /** In plain words, what this report does not look at. Rendered on screen, always. */
  notChecked: readonly string[];
  /** A cap that bit during this run, as a full sentence. Empty when nothing was cut short. */
  limitsReached: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// The numbers behind the checks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long a draft may sit untouched before it is worth mentioning.
 *
 * Two months: long enough that a piece somebody is genuinely working on is never listed, short enough
 * that a draft abandoned before the summer is found before the person who wrote it has forgotten it.
 */
export const STALE_DRAFT_DAYS = 60;

/** How many examples a finding names. Four fits on one line at a studio width. */
const NAMED_EXAMPLES = 4;

/**
 * How many blocks are read to judge emptiness and to collect links.
 *
 * A page holds at most 60 blocks, so this is fifty published pages' worth of the largest pages anybody
 * builds. ⚠ When it bites it is STATED on screen through `limitsReached` — a check that quietly stopped
 * looking is indistinguishable from a check that found nothing (contract §1.6).
 */
const MAX_SECTIONS_SCANNED = 3000;

/**
 * The window a publication year has to fall inside.
 *
 * `Publication.year` is a REQUIRED integer, so "no year" cannot be stored as an absence — it arrives as a
 * placeholder instead, and 0 is what every importer and every hurried editor writes. So the check is for
 * a year that cannot be right rather than for a year that is missing.
 */
const EARLIEST_PLAUSIBLE_YEAR = 1400;
const YEARS_AHEAD_ALLOWED = 2;

/**
 * Routes the CODE owns rather than a `Page` row.
 *
 * ⚠ A twin of the set in app/studio/page.tsx. See the file header.
 */
const CODE_OWNED_ROUTES: ReadonlySet<string> = new Set([
  "/",
  "/about",
  "/research",
  "/projects",
  "/publications",
  "/people",
  "/gallery",
  "/events",
  "/news",
  "/craft-explorer",
  "/contact",
  "/search"
]);

/**
 * First path segments whose CHILDREN are database-backed detail routes — `/people/a-sharma`,
 * `/news/tag/textiles`.
 *
 * Verifying those would mean a query per collection every time this screen is opened. They are therefore
 * SKIPPED rather than guessed at, and the report says so in `notChecked`.
 *
 * ⚠ A twin of the set in app/studio/page.tsx. See the file header.
 */
const UNCHECKABLE_COLLECTIONS: ReadonlySet<string> = new Set([
  "research",
  "projects",
  "publications",
  "people",
  "gallery",
  "events",
  "news",
  "craft-explorer",
  "search"
]);

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

/** "3 pages" / "1 page". Written out, because an English plural is not a suffix rule worth guessing. */
function phrase(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/*
 * ⚠ THE `stableJson` THAT USED TO SIT HERE IS NOW `lib/utils.ts`'s, over a `sortKeysDeep` helper that is gone
 * with it. It was written here and, independently, a second time in prisma/seed.ts — both to ask "is this
 * stored payload the same document as the one I just built?", and both because a plain `JSON.stringify`
 * comparison is ALWAYS unequal for a `jsonb` column. Two callers learning that separately is the argument for
 * one home; the reasoning, and the reason the shared one is a `replacer` rather than a pre-walk, is in that
 * function's header. Nothing about this file's two comparisons changed.
 */

/**
 * Every string anywhere inside a JSON value.
 *
 * ⚠ THE DEPTH CAP DOES TWO JOBS, AND THE SECOND ONE IS A LIMIT ON THIS REPORT. It stops one pathological
 * payload from costing the whole screen — and it is the one respect in which this report is still narrower
 * than the publish gate, whose walker (`collectStringsDeep` in lib/sections/schema.ts) has no cap at all.
 * Twelve is about six levels of rich-text nesting, because a Tiptap level costs a node and its `content`
 * array. See the ⚠ on `judgementFor()`, which is where that difference matters.
 */
function collectStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 12) return out;
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, out, depth + 1);
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectStrings(entry, out, depth + 1);
    }
  }
  return out;
}

/**
 * Every link inside a JSON value.
 *
 * Collected by KEY NAME — anything called `url` or ending in `href` — rather than by looking for strings
 * that happen to start with a slash. That reaches `href`, `ctaHref`, `directionsHref` and `url` in the
 * section payloads AND the `href` a rich-text link mark carries deep inside a Tiptap document, without
 * mistaking a piece of prose beginning with a slash for a link.
 */
function collectLinks(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 12) return out;
  if (Array.isArray(value)) {
    for (const entry of value) collectLinks(entry, out, depth + 1);
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const name = key.toLowerCase();
      if (typeof entry === "string" && (name === "url" || name.endsWith("href"))) {
        out.push(entry);
        continue;
      }
      collectLinks(entry, out, depth + 1);
    }
  }
  return out;
}

/**
 * The site path a link points at, or null when it is not ours to judge.
 *
 * Null for an absolute address, a `mailto:`, a `tel:`, an in-page anchor and a protocol-relative
 * `//example.com` — every one of those either leaves this site or stays on the page, and neither can be
 * checked against the list of pages.
 */
function internalTarget(raw: string): string | null {
  const href = raw.trim();
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  const base = (href.split("?")[0] ?? "").split("#")[0] ?? "";
  if (base.length === 0) return null;
  const tidied = base.replace(/\/+$/, "");
  return tidied.length === 0 ? "/" : tidied;
}

/** Can this application tell whether that path answers? See `UNCHECKABLE_COLLECTIONS`. */
function isCheckable(base: string): boolean {
  if (CODE_OWNED_ROUTES.has(base)) return false;
  return !UNCHECKABLE_COLLECTIONS.has(base.split("/")[1] ?? "");
}

/** One link found somewhere, with enough context to be named on screen. */
interface FoundLink {
  target: string;
  /** "Header menu: Apply" / "About — Hero banner". Named, because a count sends somebody hunting. */
  where: string;
}

/**
 * Whether a block of this type can be judged empty, and what "empty" looks like for it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE DECISION IS DERIVED, NOT LISTED — AND THE DERIVATION IS `sectionPlaceholderPrompts()` IN
 * lib/sections/schema.ts, NOT A SECOND ONE WRITTEN HERE.
 *
 * The vocabulary is the prompt text a freshly dropped block starts with, selected from
 * `SECTION_PLACEHOLDERS` — the only place those strings exist. Where a block type has one, its content is
 * its own words, and a payload still carrying one of those strings is a block nobody has filled in. Where
 * it has none (every showcase block: projects, people, publications, news, events, albums, partners, files,
 * crafts) the block fills itself from the studio, so "no words of its own" is a normal, finished state and
 * the block is NOT judged. `SPACER`, which has no seed at all, falls out of the same test.
 *
 * ⚠ WHY IT IS IMPORTED RATHER THAN RE-DERIVED, WHICH IS THIS FUNCTION'S OWN HISTORY. This function used to
 * build its own list — `collectStrings(defaultSectionData(type))` filtered with `/^(add|write)\b/i` — and
 * that list was NARROWER than the publish gate's by exactly one string: it had no `replace`, so
 * STORY_SCROLL's "Replace this photograph with one of your own." was missing from it. That is the dangerous
 * direction. `pagePublishBlockers()` in lib/pages.ts would refuse to publish a page carrying only that
 * caption, and THIS REPORT — the screen an editor opens to find out what is wrong with the site — would
 * name nothing. A refusal nobody can diagnose is worse than either check alone.
 *
 * Measured across all 30 block types when the import replaced the copy, not reasoned about: one string
 * differed, in one type, and NO type crossed between "judged" and "not judged" (STORY_SCROLL already
 * carried six `Add…` prompts, so it was judged incompletely rather than not at all). The report is now
 * exactly as strict as the gate about WHICH WORDS count.
 *
 * ⚠ WHAT IS STILL NOT SHARED, STATED SO THE NEXT READER DOES NOT ASSUME IT IS. The gate asks its question
 * through `placeholderPromptsIn()`, which walks the RAW payload with an uncapped walker. This file walks the
 * PARSED payload with `collectStrings`, which stops at depth 12 — six levels of rich-text nesting, since a
 * Tiptap level costs a node and its `content` array. So a prompt string buried deeper than that inside a
 * rich-text document would still be refused there and unnamed here. The cap stays: it is what keeps one
 * pathological payload from costing the whole screen, and a string that deep is authored structure rather
 * than an untouched block. The vocabulary was the drift worth closing; this is a difference worth knowing.
 *
 * This report also applies a test the gate does not — `bare`, the payload with every field at its schema
 * default and NO seed applied, which is a block whose text has been cleared away entirely rather than never
 * written. So neither check is simply the stricter one, and the header on `PLACEHOLDER_PROMPT_PATTERN` in
 * lib/sections/schema.ts says the same thing from the other end.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
interface SectionJudgement {
  /**
   * `readonly` because it IS the cached array `sectionPlaceholderPrompts()` keeps, handed over rather than
   * copied — already trimmed, de-duplicated, sorted and free of empty strings.
   */
  prompts: readonly string[];
  bare: string;
}

/**
 * `cache` now earns its place for `bare` alone: the prompts arrive from a cache of their own inside
 * `sectionPlaceholderPrompts()`, while `bare` costs a `parseSectionData` per block type and this loop asks
 * the question once per block on every published page.
 */
function judgementFor(type: SectionType, cache: Map<SectionType, SectionJudgement | null>): SectionJudgement | null {
  const known = cache.get(type);
  if (known !== undefined) return known;

  const prompts = sectionPlaceholderPrompts(type);

  if (prompts.length === 0) {
    cache.set(type, null);
    return null;
  }

  const bareParse = parseSectionData(type, {});
  const judgement: SectionJudgement = {
    prompts,
    bare: bareParse.ok ? stableJson(bareParse.data) : ""
  };
  cache.set(type, judgement);
  return judgement;
}

// ─────────────────────────────────────────────────────────────────────────────
// The report
// ─────────────────────────────────────────────────────────────────────────────

/** What this report deliberately does not look at. Rendered on screen, in full, every time. */
const NOT_CHECKED: readonly string[] = [
  "Links into research, projects, people, news, events, the gallery and the craft archive. Checking those would mean a separate database query for every one of those collections each time this screen is opened, so a link to one of them is left alone rather than guessed at.",
  "Links to other organisations' websites. Nothing here ever follows one: a page that has been taken down elsewhere cannot be told apart from a server that was slow to answer, and reporting the second as the first would fill this screen with alarms nobody can act on.",
  "Photographs marked as decorative. An empty description is meaningful — it tells a screen reader to skip the picture — so an image somebody has deliberately marked that way is finished work and is not counted as missing anything.",
  "Blocks that fill themselves. A projects block or a news block draws its contents from elsewhere in the studio, so having no words of its own is normal and it is never reported as empty.",
  "Anything that is not published. A draft cannot mislead a visitor, so drafts appear only under Tidying up, and only because one nobody has touched since the spring is usually one somebody has forgotten.",
  "Whether a photograph, a date or a figure is the RIGHT one. This report can see what is missing and never what is mistaken — only a person who knows the work can do that."
];

/**
 * Run every check and return what is wrong.
 *
 * ONE `$transaction`, like the dashboard's: sequentially each of these would pay a full round trip to the
 * database, and on a pooled connection that is most of a second of blank screen for a page made almost
 * entirely of small integers. The rendering is filtered by the reader's permissions afterwards; the
 * QUERIES are unconditional, because building the batch from a set of predicates would make the returned
 * tuple's shape depend on who is looking, which TypeScript cannot follow.
 */
export async function buildHealthReport(now: Date = new Date()): Promise<HealthReport> {
  const staleBefore = new Date(now.getTime() - STALE_DRAFT_DAYS * 24 * 60 * 60 * 1000);
  const yearCeiling = now.getUTCFullYear() + YEARS_AHEAD_ALLOWED;

  /**
   * ⚠ `livePublishableWhere()` ALREADY CONTAINS AN `OR`, so a second one may never be spread beside it —
   * the later key wins and the publication filter silently vanishes (lib/studio/crud.ts says the same
   * about `textSearchWhere`). Both conditions are therefore nested under `AND`.
   */
  const liveWithoutSeoDescription = {
    AND: [
      livePublishableWhere(now),
      { seoNoIndex: false },
      { OR: [{ seoDescription: null }, { seoDescription: "" }] }
    ]
  };

  /** A published event that has finished. `endsAt` decides it where there is one; otherwise the start. */
  const finishedEvent = {
    ...liveStatusWhere(),
    isRegistrationOpen: true,
    OR: [{ endsAt: { lt: now } }, { endsAt: null, startsAt: { lt: now } }]
  };

  const implausibleYear = {
    deletedAt: null,
    OR: [{ year: { lt: EARLIEST_PLAUSIBLE_YEAR } }, { year: { gt: yearCeiling } }]
  };

  /** Visible blocks on pages a visitor can reach. Hidden blocks render nothing, so they cannot be wrong. */
  const visibleBlocksOnLivePages = { isVisible: true, page: livePublishableWhere(now) };

  const [
    // ── Media ───────────────────────────────────────────────────────────────
    /**
     * ⚠ `altText: null` ONLY, never `OR: [{ altText: null }, { altText: "" }]`.
     *
     * `""` is written deliberately by the "this image is decorative" checkbox and is MEANINGFUL HTML: it
     * instructs a screen reader to skip the image, which for a border or a texture is exactly right and
     * exactly complete. Counting it here would make this finding nag forever about work an editor has
     * already finished — and a figure that never reaches zero however much work is done is a figure
     * people stop reading, which costs the genuine gaps their only prompt. The same note is on the
     * dashboard's tile, which asks the identical question.
     */
    imagesMissingAltTotal,
    imagesMissingAltRows,

    // ── Pages ───────────────────────────────────────────────────────────────
    pagesMissingSeoTotal,
    pagesMissingSeoRows,
    scheduledNoDateTotalPages,
    scheduledNoDateRowsPages,
    scheduledNoDateTotalPosts,
    scheduledNoDateRowsPosts,
    scheduledPagesPastDue,
    scheduledPostsPastDue,

    // ── Events, publications, people ────────────────────────────────────────
    eventsStillOpenTotal,
    eventsStillOpenRows,
    publicationsBadYearTotal,
    publicationsBadYearRows,
    peopleMissingPhotoTotal,
    peopleMissingPhotoRows,

    // ── The link and block scan ─────────────────────────────────────────────
    livePages,
    navigationLinks,
    blockRows,
    blockTotal,

    // ── Forgotten drafts ────────────────────────────────────────────────────
    staleDraftPages,
    staleDraftPosts,
    staleDraftPeople,
    staleDraftEvents,
    staleDraftAlbums,
    staleDraftAreas,
    staleDraftProjects,
    staleDraftPublications,
    staleDraftCrafts
  ] = await prisma.$transaction([
    prisma.mediaAsset.count({ where: { deletedAt: null, kind: "IMAGE", altText: null } }),
    prisma.mediaAsset.findMany({
      where: { deletedAt: null, kind: "IMAGE", altText: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: NAMED_EXAMPLES,
      select: { fileName: true }
    }),

    prisma.page.count({ where: liveWithoutSeoDescription }),
    prisma.page.findMany({
      where: liveWithoutSeoDescription,
      orderBy: [{ slug: "asc" }],
      take: NAMED_EXAMPLES,
      select: { title: true, slug: true }
    }),

    /**
     * A SCHEDULED row with no date will never publish: `isLive()` treats a missing `publishAt` as not
     * live, which is the safe direction and also a silent one — nothing anywhere says so but this.
     *
     * Counted AND named, in two queries each, rather than counting the names: a finding whose total was
     * the length of a capped list of examples would report five when there were forty (contract §1.6).
     */
    prisma.page.count({ where: { deletedAt: null, status: "SCHEDULED", publishAt: null } }),
    prisma.page.findMany({
      where: { deletedAt: null, status: "SCHEDULED", publishAt: null },
      orderBy: [{ slug: "asc" }],
      take: NAMED_EXAMPLES,
      select: { title: true, slug: true }
    }),
    prisma.post.count({ where: { deletedAt: null, status: "SCHEDULED", publishAt: null } }),
    prisma.post.findMany({
      where: { deletedAt: null, status: "SCHEDULED", publishAt: null },
      orderBy: [{ title: "asc" }],
      take: NAMED_EXAMPLES,
      select: { title: true }
    }),

    prisma.page.count({
      where: { deletedAt: null, status: "SCHEDULED", publishAt: { lte: now } }
    }),
    prisma.post.count({
      where: { deletedAt: null, status: "SCHEDULED", publishAt: { lte: now } }
    }),

    prisma.coeEvent.count({ where: finishedEvent }),
    prisma.coeEvent.findMany({
      where: finishedEvent,
      orderBy: [{ startsAt: "desc" }],
      take: NAMED_EXAMPLES,
      select: { title: true, startsAt: true }
    }),

    prisma.publication.count({ where: implausibleYear }),
    prisma.publication.findMany({
      where: implausibleYear,
      orderBy: [{ title: "asc" }],
      take: NAMED_EXAMPLES,
      select: { title: true, year: true }
    }),

    prisma.person.count({ where: { ...liveStatusWhere(), photoId: null } }),
    prisma.person.findMany({
      where: { ...liveStatusWhere(), photoId: null },
      orderBy: [{ name: "asc" }],
      take: NAMED_EXAMPLES,
      select: { name: true }
    }),

    /**
     * Every page a visitor can reach, with one bit of extra information: does it have at least one
     * VISIBLE block?
     *
     * `take: 1` rather than a count, because the question is "any" and because a count taken here would
     * include hidden blocks — a page whose only three blocks are switched off renders nothing at all, and
     * a count of three would hide exactly that.
     */
    prisma.page.findMany({
      where: livePublishableWhere(now),
      orderBy: [{ slug: "asc" }],
      select: {
        id: true,
        slug: true,
        title: true,
        isSystem: true,
        sections: { where: { isVisible: true }, take: 1, select: { id: true } }
      }
    }),

    prisma.navigationItem.findMany({
      where: { isVisible: true, isExternal: false },
      select: { label: true, href: true, location: true }
    }),

    prisma.pageSection.findMany({
      where: visibleBlocksOnLivePages,
      // A total ordering, so the cap always cuts the same place and two runs a minute apart do not
      // disagree about which blocks were looked at.
      orderBy: [{ pageId: "asc" }, { position: "asc" }],
      take: MAX_SECTIONS_SCANNED,
      select: { type: true, data: true, page: { select: { title: true, slug: true } } }
    }),
    prisma.pageSection.count({ where: visibleBlocksOnLivePages }),

    prisma.page.count({
      where: { deletedAt: null, status: "DRAFT", updatedAt: { lt: staleBefore } }
    }),
    prisma.post.count({
      where: { deletedAt: null, status: "DRAFT", updatedAt: { lt: staleBefore } }
    }),
    prisma.person.count({
      where: { deletedAt: null, status: "DRAFT", updatedAt: { lt: staleBefore } }
    }),
    prisma.coeEvent.count({
      where: { deletedAt: null, status: "DRAFT", updatedAt: { lt: staleBefore } }
    }),
    prisma.galleryAlbum.count({
      where: { deletedAt: null, status: "DRAFT", updatedAt: { lt: staleBefore } }
    }),
    prisma.researchArea.count({
      where: { deletedAt: null, status: "DRAFT", updatedAt: { lt: staleBefore } }
    }),
    prisma.project.count({
      where: { deletedAt: null, status: "DRAFT", updatedAt: { lt: staleBefore } }
    }),
    prisma.publication.count({
      where: { deletedAt: null, status: "DRAFT", updatedAt: { lt: staleBefore } }
    }),
    prisma.craft.count({
      where: { deletedAt: null, status: "DRAFT", updatedAt: { lt: staleBefore } }
    })
  ]);

  /**
   * The footer's links, read separately.
   *
   * Settings live in a JSON document rather than a table, so they cannot join the batch above. The reader
   * in lib/settings/service.ts already treats an unreachable database and a corrupt document the same way
   * — it returns the defaults and warns on the server — so an empty footer here costs this one check and
   * never the screen.
   */
  const footer = await getSetting("footer");

  const limitsReached: string[] = [];

  // ── The link scan ─────────────────────────────────────────────────────────

  const livePagePaths = new Set(livePages.map((row) => pagePath(row.slug)));

  const found: FoundLink[] = [];

  for (const item of navigationLinks) {
    const target = internalTarget(item.href);
    if (target) found.push({ target, where: `${item.location} menu: ${item.label}` });
  }

  for (const column of footer.columns) {
    for (const link of column.links) {
      const target = internalTarget(link.href);
      if (target) found.push({ target, where: `Footer, ${column.heading}: ${link.label}` });
    }
  }

  const notFilledIn: string[] = [];
  const unreadableBlocks: string[] = [];
  const judgements = new Map<SectionType, SectionJudgement | null>();

  for (const block of blockRows) {
    const blockName = `${block.page.title} — ${sectionLabel(block.type)}`;

    for (const raw of collectLinks(block.data)) {
      const target = internalTarget(raw);
      if (target) found.push({ target, where: blockName });
    }

    const parsed = parseSectionData(block.type, block.data);
    if (!parsed.ok) {
      unreadableBlocks.push(blockName);
      continue;
    }

    const judgement = judgementFor(block.type, judgements);
    if (!judgement) continue;

    const payload = stableJson(parsed.data);
    if (payload === judgement.bare) {
      notFilledIn.push(blockName);
      continue;
    }

    // EXACT, TRIMMED, CASE-SENSITIVE — the same match the publish gate makes, and never the pattern that
    // selected the vocabulary. The seeded homepage's finished button reads "Write to the Centre"; a leading-
    // verb test would report the site's own front page for ever. lib/sections/schema.ts argues this at
    // length. Only the PAYLOAD side is trimmed here: the vocabulary arrives trimmed already.
    const strings = new Set(collectStrings(parsed.data).map((value) => value.trim()));
    if (judgement.prompts.some((prompt) => strings.has(prompt))) {
      notFilledIn.push(blockName);
    }
  }

  if (blockTotal > blockRows.length) {
    limitsReached.push(
      `The blocks on published pages were read up to ${MAX_SECTIONS_SCANNED} of them, and there are ${blockTotal}. The two checks that read them — links inside pages, and blocks nobody has filled in — therefore cover the first ${blockRows.length} and no more.`
    );
  }

  const brokenLinks: string[] = [];
  const seenBroken = new Set<string>();
  for (const link of found) {
    if (!isCheckable(link.target)) continue;
    if (livePagePaths.has(link.target)) continue;
    const entry = `${link.where} → ${link.target}`;
    if (seenBroken.has(entry)) continue;
    seenBroken.add(entry);
    brokenLinks.push(entry);
  }

  const linkedPaths = new Set(found.map((link) => link.target));
  const orphanPages = livePages
    .filter((row) => {
      const path = pagePath(row.slug);
      // The homepage and the pages the site's own code renders are reached from the header, the footer
      // and the address bar; calling one an orphan would be a permanent false alarm.
      if (path === "/" || row.isSystem || CODE_OWNED_ROUTES.has(path)) return false;
      return !linkedPaths.has(path);
    })
    .map((row) => `${row.title} (${pagePath(row.slug)})`);

  const blankPages = livePages
    .filter((row) => row.sections.length === 0)
    .map((row) => `${row.title} (${pagePath(row.slug)})`);

  const scheduledNoDateTotal = scheduledNoDateTotalPages + scheduledNoDateTotalPosts;
  const scheduledNoDateNames = [
    ...scheduledNoDateRowsPages.map((row) => `${row.title} (${pagePath(row.slug)})`),
    ...scheduledNoDateRowsPosts.map((row) => `${row.title} (news article)`)
  ];

  const scheduledPastDue = scheduledPagesPastDue + scheduledPostsPastDue;

  // ── The findings ──────────────────────────────────────────────────────────

  const candidates: HealthFinding[] = [
    // ── Urgent ──────────────────────────────────────────────────────────────
    finding({
      id: "pages-with-no-blocks",
      severity: "urgent",
      total: blankPages.length,
      examples: blankPages,
      title: `${phrase(blankPages.length, "published page has", "published pages have")} nothing on it`,
      why: "A visitor who follows a link to one of these reaches a page with a heading and nothing underneath it, which reads as a site that is broken rather than as one that is unfinished.",
      href: "/studio/pages?status=PUBLISHED",
      fixLabel: "Open Pages",
      can: canManageStructure
    }),
    finding({
      id: "events-registration-open-after-the-event",
      severity: "urgent",
      total: eventsStillOpenTotal,
      examples: eventsStillOpenRows.map((row) => `${row.title} (${formatCentreDate(row.startsAt)})`),
      title: `${phrase(eventsStillOpenTotal, "event that has finished is", "events that have finished are")} still taking registrations`,
      why: "The public page invites people to register for something that has already happened, and collects their name and email address for it.",
      href: "/studio/events",
      fixLabel: "Open Events",
      can: canManageContent
    }),
    finding({
      id: "scheduled-with-no-date",
      severity: "urgent",
      total: scheduledNoDateTotal,
      examples: scheduledNoDateNames,
      title: `${phrase(scheduledNoDateTotal, "item is", "items are")} marked as scheduled with no date`,
      why: "Nothing will ever publish these: the studio says they are on their way out and the site treats them as unpublished, so whoever wrote them believes the job is done.",
      href: "/studio/pages?status=SCHEDULED",
      fixLabel: "Open Pages",
      can: canManageStructure
    }),
    finding({
      id: "internal-links-that-lead-nowhere",
      severity: "urgent",
      total: brokenLinks.length,
      examples: brokenLinks,
      title: `${phrase(brokenLinks.length, "link points", "links point")} at a page that is not published`,
      why: "Each of these gives a visitor “page not found” from a menu or a page the Centre wrote itself, which is the one kind of broken link nobody outside can report to you.",
      href: "/studio/navigation",
      fixLabel: "Open Navigation",
      can: canManageStructure
    }),
    finding({
      id: "blocks-that-cannot-be-read",
      severity: "urgent",
      total: unreadableBlocks.length,
      examples: unreadableBlocks,
      title: `${phrase(unreadableBlocks.length, "block on a published page cannot be read", "blocks on published pages cannot be read")}`,
      why: "The studio shows an editor a warning where each of these sits and a visitor sees nothing there at all, so the page is missing a piece and only the studio knows it.",
      href: "/studio/pages?status=PUBLISHED",
      fixLabel: "Open Pages",
      can: canManageStructure
    }),

    // ── Worth fixing soon ───────────────────────────────────────────────────
    finding({
      id: "blocks-nobody-has-filled-in",
      severity: "important",
      total: notFilledIn.length,
      examples: notFilledIn,
      title: `${phrase(notFilledIn.length, "block on a published page has", "blocks on published pages have")} not been filled in`,
      why: "These still hold the words the studio put there as a prompt, or nothing at all, so the public page is showing instructions meant for whoever was building it.",
      href: "/studio/pages?status=PUBLISHED",
      fixLabel: "Open Pages",
      can: canManageStructure
    }),
    finding({
      id: "images-with-no-description",
      severity: "important",
      total: imagesMissingAltTotal,
      examples: imagesMissingAltRows.map((row) => row.fileName),
      title: `${phrase(imagesMissingAltTotal, "image has", "images have")} no description`,
      why: "A short sentence describing each picture is what somebody using a screen reader hears instead of it, and without one they are told only that an image is there.",
      href: "/studio/media?missingAlt=1",
      fixLabel: "Open the media library",
      can: canManageMedia
    }),
    finding({
      id: "pages-with-no-search-description",
      severity: "important",
      total: pagesMissingSeoTotal,
      examples: pagesMissingSeoRows.map((row) => `${row.title} (${pagePath(row.slug)})`),
      title: `${phrase(pagesMissingSeoTotal, "published page has", "published pages have")} no description for search engines`,
      why: "Google and every messaging app that shows a preview will invent a summary from whatever text they find first, and the Centre loses the one sentence it could have chosen itself.",
      href: "/studio/pages?status=PUBLISHED",
      fixLabel: "Open Pages",
      can: canManageStructure
    }),
    finding({
      id: "people-with-no-photograph",
      severity: "important",
      total: peopleMissingPhotoTotal,
      examples: peopleMissingPhotoRows.map((row) => row.name),
      title: `${phrase(peopleMissingPhotoTotal, "person on the site has", "people on the site have")} no photograph`,
      why: "The people pages are the part of an institutional site visitors read most, and a row of initials beside a row of faces reads as somebody who has left rather than somebody who is here.",
      href: "/studio/people",
      fixLabel: "Open People",
      can: canManageContent
    }),
    finding({
      id: "publications-with-no-year",
      severity: "important",
      total: publicationsBadYearTotal,
      examples: publicationsBadYearRows.map((row) => `${row.title} (year given as ${row.year})`),
      title: `${phrase(publicationsBadYearTotal, "publication has", "publications have")} no usable year`,
      why: "A year is part of how a publication is cited and how the list is grouped, so one of these cannot be found by anybody looking for the work in the year it appeared.",
      href: "/studio/publications",
      fixLabel: "Open Publications",
      can: canManageResearch
    }),
    finding({
      id: "scheduled-date-has-passed",
      severity: "important",
      total: scheduledPastDue,
      examples: [],
      title: `${phrase(scheduledPastDue, "item is", "items are")} still marked as scheduled although the date has passed`,
      why: "These are public — the site works out what is published from the dates rather than from the label — but the studio's own list disagrees, so nobody reading it can tell what is out.",
      href: "/studio/pages?status=SCHEDULED",
      fixLabel: "Open Pages",
      can: canManageStructure
    }),

    // ── Tidying up ──────────────────────────────────────────────────────────
    finding({
      id: "pages-nothing-links-to",
      severity: "tidy",
      total: orphanPages.length,
      examples: orphanPages,
      title: `${phrase(orphanPages.length, "published page is", "published pages are")} not linked from anywhere`,
      why: "Nothing in the menus, the footer or any other page leads to these, so only somebody who already has the address will ever read them.",
      href: "/studio/navigation",
      fixLabel: "Open Navigation",
      can: canManageStructure
    }),
    ...staleDrafts([
      { count: staleDraftPages, singular: "page", plural: "pages", href: "/studio/pages?status=DRAFT", fix: "Open Pages", can: canManageStructure },
      { count: staleDraftPosts, singular: "news article", plural: "news articles", href: "/studio/news?status=DRAFT", fix: "Open News", can: canAuthor },
      { count: staleDraftPeople, singular: "profile", plural: "profiles", href: "/studio/people?status=DRAFT", fix: "Open People", can: canManageContent },
      { count: staleDraftEvents, singular: "event", plural: "events", href: "/studio/events?status=DRAFT", fix: "Open Events", can: canManageContent },
      { count: staleDraftAlbums, singular: "album", plural: "albums", href: "/studio/gallery?status=DRAFT", fix: "Open Gallery", can: canManageContent },
      { count: staleDraftAreas, singular: "research area", plural: "research areas", href: "/studio/research?status=DRAFT", fix: "Open Research areas", can: canManageResearch },
      { count: staleDraftProjects, singular: "project", plural: "projects", href: "/studio/projects?status=DRAFT", fix: "Open Projects", can: canManageResearch },
      { count: staleDraftPublications, singular: "publication", plural: "publications", href: "/studio/publications?status=DRAFT", fix: "Open Publications", can: canManageResearch },
      { count: staleDraftCrafts, singular: "craft record", plural: "craft records", href: "/studio/crafts?status=DRAFT", fix: "Open the craft archive", can: canManageResearch }
    ])
  ];

  const order: Record<HealthSeverity, number> = { urgent: 0, important: 1, tidy: 2 };

  return {
    generatedAt: now,
    findings: candidates
      .filter((entry) => entry.total > 0)
      // Stable within a severity: the array order above is editorial, and a report that reshuffled
      // between two refreshes would look like the site changing rather than the page re-rendering.
      .sort((a, b) => order[a.severity] - order[b.severity]),
    checksRun: candidates.length,
    notChecked: NOT_CHECKED,
    limitsReached
  };
}

/**
 * Build one finding, capping its examples and recording how many were left unnamed.
 *
 * The capping happens HERE rather than at each call site so that no finding can be written that quietly
 * names three of forty (contract §1.6). `total` is whatever the caller counted; `examples` is whatever it
 * could name, which for a database count is at most `NAMED_EXAMPLES` and for a list computed in memory is
 * the whole thing.
 */
function finding(
  input: Omit<HealthFinding, "examples" | "moreThanNamed"> & { examples: readonly string[] }
): HealthFinding {
  const named = input.examples.slice(0, NAMED_EXAMPLES);
  return {
    id: input.id,
    severity: input.severity,
    title: input.title,
    why: input.why,
    href: input.href,
    fixLabel: input.fixLabel,
    total: input.total,
    examples: named,
    moreThanNamed: Math.max(0, input.total - named.length),
    can: input.can
  };
}

interface StaleDraftKind {
  count: number;
  singular: string;
  plural: string;
  href: string;
  fix: string;
  can: (subject: PermissionSubject | null | undefined) => boolean;
}

/**
 * One finding per record type rather than a single total.
 *
 * A combined "31 drafts have not been touched since April" has nowhere to send anybody: the drafts are on
 * nine different screens. Each of these lands on the list it belongs to, already filtered to drafts.
 */
function staleDrafts(kinds: readonly StaleDraftKind[]): HealthFinding[] {
  return kinds.map((kind) =>
    finding({
      id: `stale-drafts-${kind.plural.replace(/\s+/g, "-")}`,
      severity: "tidy",
      total: kind.count,
      examples: [],
      title: `${phrase(kind.count, `${kind.singular} has`, `${kind.plural} have`)} been left as a draft for more than ${STALE_DRAFT_DAYS} days`,
      why: "A draft nobody has opened since the spring is usually one somebody has forgotten rather than one they are still writing, and it will sit in every list until it is finished or thrown away.",
      href: kind.href,
      fixLabel: kind.fix,
      can: kind.can
    })
  );
}
