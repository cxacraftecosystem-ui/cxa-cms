import type { Metadata } from "next";
import Link from "next/link";
import type { Prisma } from "@prisma/client";

import { Reveal } from "@/components/motion/Reveal";
import { CENTRE_TIME_ZONE } from "@/components/site/EventDateBlock";
import { PageHero } from "@/components/site/PageHero";
import { ResultSummary } from "@/components/site/ResultSummary";
import { livePublishableWhere, liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { prerenderSafe } from "@/lib/prerender";
import { pageMetadata } from "@/lib/seo";
import type { FeatureFlag, FeaturesSettings } from "@/lib/settings/schema";
import { getSettingCached } from "@/lib/settings/service";

/**
 * /a-z — every named thing on the site, in one alphabetical list.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHO THIS PAGE IS FOR.
 *
 * A researcher who knows the NAME of the thing and not where it lives. They half-remember a craft
 * called Bidriware, or a colleague called Iyer, or a paper with "kalamkari" in the title, and the site
 * offers them eleven listing pages each of which is the wrong one until they guess right. Search
 * answers that question only if they can spell it; an A–Z answers it if they can start it. It is the
 * cheapest thing a large site can do to stop feeling large.
 *
 * FIVE DECISIONS WORTH KNOWING:
 *
 *   1. **ONE BATCHED READ, not seven sequential ones.** Every list on this page comes out of a single
 *      `prisma.$transaction([...])`, following lib/sections/resolve.ts. That is one round trip AND one
 *      consistent snapshot — so a record published between two statements cannot appear under its
 *      letter while the count above the list says it is not there.
 *   2. **THERE IS NO CAP, deliberately.** Contract §1.6 says a list that stops must say so; the better
 *      answer here is not to stop. This page's whole value is being COMPLETE — a directory that
 *      silently ends at 200 entries is worse than no directory, because a reader who cannot find a
 *      craft in an A–Z index concludes the Centre does not have it. Each query is a slug-and-title
 *      select over an indexed publish filter; the whole corpus of a Centre of Excellence is a few
 *      hundred rows, and the page states its own total so the size is never a guess.
 *   3. **THE JUMP BAR IS PLAIN `<a href="#…">` AND SHIPS NO JAVASCRIPT.** Fragment links are the one
 *      piece of navigation the platform has always done natively, and this bar has to work in the
 *      state where a reader most needs it — a slow phone, a blocked bundle. Routing it through
 *      `scrollToElement` would make the bar a client component to buy a glide nobody asked for.
 *   4. **A LETTER WITH NOTHING UNDER IT IS RENDERED, VISIBLY DISABLED.** Dropping it would silently
 *      reflow the bar so that "Q" sits where a reader last saw "P"; rendering it as a live link that
 *      goes nowhere is worse still. It is a non-link, dimmed, and it says "no entries" to a screen
 *      reader — because colour never carries meaning alone (contract §11).
 *   5. **A SWITCHED-OFF SURFACE IS NOT LISTED**, exactly as `app/(site)/layout.tsx` drops it from the
 *      footer and `SiteHeader` drops it from the menu. This is NOT the truncation rule wearing a
 *      disguise: those records are not public at all while the flag is off — their own listing pages
 *      call `notFound()` — so they are not part of the corpus this page is a complete statement about,
 *      and announcing an administrative decision to the public would be a leak of it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ THE ANCHOR CLEARANCE IS PAID WITH A `!` AND THAT IS NOT DECORATION. globals.css gives every
 * anchor target `scroll-margin-top: var(--nav-clearance)`, which is the FIXED HEADER's clearance and
 * nothing else. This page adds a second piece of sticky chrome — the jump bar — so a target that
 * cleared only the header would land underneath the very bar that was used to reach it. The extra room
 * is derived from `--nav-clearance` rather than restated beside it, so moving the header still moves
 * everything (contract §7).
 *
 * The `!` is what makes it stick. That rule is `:target, [id][data-anchor] { … }` written in
 * globals.css AFTER `@tailwind utilities`, so it has the same specificity as a `scroll-mt-*` utility
 * and wins on source order — and `:target` matches precisely when a jump link has just been clicked,
 * which is the only moment this margin is ever read. A plain utility here would look right in the
 * source and do nothing in the one case it exists for.
 *
 * A Server Component throughout. `Reveal` is the only client code on the page.
 */

export const metadata: Metadata = pageMetadata({
  title: "A–Z index",
  description:
    "Everything on the site in one alphabetical list — crafts, research areas, projects, people, publications, events and pages, each with what kind of record it is.",
  path: "/a-z"
});

/**
 * Refreshed every five minutes rather than frozen at build time.
 *
 * ⚠ REQUIRED BY `prerenderSafe` BELOW, not merely nice to have: a page whose data read fell back at
 * build time is prerendered EMPTY, and with no revalidation window that snapshot would be served until
 * the next deploy. An empty A–Z index that never repairs itself is worse than a failed build.
 *
 * The window is also what the on-screen failure note promises ("within five minutes"), so the two
 * numbers are one number: change this and change that sentence with it.
 */
export const revalidate = 300;

const BREADCRUMBS = [
  { name: "Home", href: "/" },
  { name: "A–Z index", href: "/a-z" }
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// What an entry is
// ─────────────────────────────────────────────────────────────────────────────

type EntryKind =
  | "craft"
  | "research"
  | "project"
  | "person"
  | "publication"
  | "event"
  | "page";

/**
 * The label printed beside every entry.
 *
 * A WORD, not a colour and not an icon. Seven kinds of record share one list, and "which of these is
 * the paper and which is the project?" has to be answerable by reading, at a glance, in either theme
 * and with any colour vision (contract §11).
 */
const KIND_LABELS: Record<EntryKind, string> = {
  craft: "Craft",
  research: "Research area",
  project: "Project",
  person: "Person",
  publication: "Publication",
  event: "Event",
  page: "Page"
};

/** The same seven, plural, for the sentence that says what the index covers. */
const KIND_PLURALS: Record<EntryKind, string> = {
  craft: "crafts",
  research: "research areas",
  project: "projects",
  person: "people",
  publication: "publications",
  event: "events",
  page: "pages"
};

/** The order that sentence reads in. Not the order of the list, which is alphabetical by name. */
const KIND_ORDER: readonly EntryKind[] = [
  "craft",
  "research",
  "project",
  "person",
  "publication",
  "event",
  "page"
];

/** What one query knows about a row. `kind` and `key` are added by `read` below. */
interface AzSource {
  /** What the thing is called. This is what the list is alphabetised by. */
  name: string;
  /** One short disambiguator — a designation, a year, a region. Never a sentence. */
  detail: string | null;
  href: string;
}

interface AzEntry extends AzSource {
  kind: EntryKind;
  key: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The batch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One statement in the transaction, plus what to do with its answer.
 *
 * The `unknown` is the price of building the array at runtime — `$transaction` infers a tuple only
 * from a literal tuple, and this array's length depends on the feature flags. The single cast lives
 * inside `read`, three lines from the query that guarantees it, exactly as resolve.ts arranges it.
 */
interface IndexRead {
  kind: EntryKind;
  query: Prisma.PrismaPromise<unknown>;
  collect(result: unknown): AzEntry[];
}

/**
 * Pair a query with the function that turns its rows into entries.
 *
 * `R` is inferred from the query, so every `toEntry` below is checked against the columns its own
 * `select` actually asked for — a select and a renderer cannot drift apart here without a type error.
 * The key is built from the kind and the href rather than from a row id, which is why none of the
 * selects fetch one: an href is already unique within a kind, and no two kinds share a URL prefix.
 */
function read<R>(
  kind: EntryKind,
  query: Prisma.PrismaPromise<R[]>,
  toEntry: (row: R) => AzSource
): IndexRead {
  return {
    kind,
    query,
    collect: (result) =>
      (result as R[]).map((row) => {
        const source = toEntry(row);
        return { ...source, kind, key: `${kind}:${source.href}` };
      })
  };
}

/** Event dates in the CENTRE's zone, never the reader's — the rule EventDateBlock owns. */
const EVENT_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: CENTRE_TIME_ZONE
});

/**
 * Every list this page is built from, as one array of statements.
 *
 * ⚠ THE PUBLISH FILTERS ARE THE SAME TWO THE PAGES THEMSELVES USE. `Page` carries publishAt /
 * unpublishAt and therefore needs `livePublishableWhere()`; the other six carry only `status` and need
 * `liveStatusWhere()`. Reaching for the wrong one is a Prisma runtime error in one direction and a
 * leaked embargo in the other (contract §9) — which on this page would mean a draft's TITLE published
 * to the one screen designed to be read alphabetically.
 *
 * `Person.isVisible` is the second, editor-facing switch beside publication state: a person can be
 * published — so their page exists and can be cited — and still be deliberately absent from listings.
 * An index that reinstated them would undo that decision everywhere at once.
 */
function buildReads(features: FeaturesSettings, now: Date): IndexRead[] {
  const live = liveStatusWhere();
  const reads: IndexRead[] = [];

  if (features.craftExplorer) {
    reads.push(
      read(
        "craft",
        prisma.craft.findMany({
          where: live,
          select: { slug: true, name: true, region: { select: { name: true } } }
        }),
        (row) => ({
          name: row.name,
          detail: row.region?.name ?? null,
          href: `/craft-explorer/${row.slug}`
        })
      )
    );
  }

  reads.push(
    read(
      "research",
      prisma.researchArea.findMany({ where: live, select: { slug: true, title: true } }),
      (row) => ({ name: row.title, detail: null, href: `/research/${row.slug}` })
    )
  );

  reads.push(
    read(
      "project",
      prisma.project.findMany({ where: live, select: { slug: true, title: true } }),
      (row) => ({ name: row.title, detail: null, href: `/projects/${row.slug}` })
    )
  );

  reads.push(
    read(
      "person",
      prisma.person.findMany({
        where: { ...live, isVisible: true },
        select: { slug: true, name: true, designation: true }
      }),
      (row) => ({
        name: row.name,
        detail: row.designation?.trim() || null,
        href: `/people/${row.slug}`
      })
    )
  );

  if (features.publications) {
    reads.push(
      read(
        "publication",
        prisma.publication.findMany({ where: live, select: { slug: true, title: true, year: true } }),
        (row) => ({
          // The year is the one thing that tells two similarly-titled papers apart at a glance, and
          // it is a required column, so there is no "undated paper" branch to write.
          name: row.title,
          detail: String(row.year),
          href: `/publications/${row.slug}`
        })
      )
    );
  }

  if (features.events) {
    reads.push(
      read(
        "event",
        prisma.coeEvent.findMany({ where: live, select: { slug: true, title: true, startsAt: true } }),
        (row) => ({
          name: row.title,
          detail: EVENT_DATE.format(row.startsAt),
          href: `/events/${row.slug}`
        })
      )
    );
  }

  reads.push(
    read(
      "page",
      prisma.page.findMany({
        // The only model here with a schedule, so the only one filtered on time. `now` is the page's
        // single clock, shared with nothing else because nothing else needs one.
        //
        // ⚠ `seoNoIndex: false` IS THE SAME DECISION AS `Person.isVisible` ABOVE, and it is settled by
        // the same argument. `seoNoIndex` means "this page is not a destination" — `pageIsPublished` in
        // lib/search/index.ts excludes it from the site's own search for exactly that reason, and
        // argues there that the intent "does not stop at Google". An A–Z is a directory of
        // destinations, so it is closer to search than to the feeds, which include everything because a
        // feed is a chronological record rather than a directory. Listing a page an editor has marked
        // not-a-destination would undo that decision on the one screen built to be read straight
        // through. The coverage note below says the index does this, so a filtered row is a STATED
        // omission rather than a silent one.
        where: { ...livePublishableWhere(now), seoNoIndex: false },
        select: { slug: true, title: true }
      }),
      (row) => ({
        name: row.title,
        // The path, because somebody who half-remembers a URL is exactly the reader this page serves.
        detail: pathOf(row.slug),
        href: pathOf(row.slug)
      })
    )
  );

  return reads;
}

/** `Page.slug` is a path with no leading slash, and `""` is the homepage. */
function pathOf(slug: string): string {
  return slug ? `/${slug}` : "/";
}

// ─────────────────────────────────────────────────────────────────────────────
// The pages that are code, not rows
// ─────────────────────────────────────────────────────────────────────────────

interface SiteSection {
  href: string;
  /** Verbatim what the page calls itself on screen. A second name for one page is a second page. */
  name: string;
  /** The switch that 404s the route, where there is one. */
  flag?: FeatureFlag;
  /**
   * True where this route RENDERS a `Page` row of the same slug, so the editor's wording is the
   * page's real title and wins over the fallback name above. The three are the same three sitemap.ts
   * singles out for the same reason: they are code routes whose content comes from a row.
   *
   * ⚠ FALSE IS THE LOAD-BEARING VALUE. On every other route here the row and the route are two
   * different pages competing for one URL, and the route wins — see the note below.
   */
  fromPage?: boolean;
}

/**
 * The listing pages. They are ROUTES, not `Page` rows, so nothing in the database knows they exist —
 * an index built only from the tables would omit every index page on the site, which is the same
 * omission sitemap.ts spells out for the same list of paths.
 *
 * ⚠ A `Page` ROW WHOSE SLUG COLLIDES WITH ONE OF THESE IS NOT LISTED UNDER ITS OWN TITLE. A static
 * segment always beats a dynamic one (contract §13b), so `/research` renders the code route whatever
 * an editor named a row — and filing that row's title against a URL that renders something else would
 * be a wrong answer rather than a missing one. Nothing goes missing either way: the URL is still in the
 * index under the name the page actually displays. `CODE_OWNED_HREFS` is what enforces it, and it
 * deliberately ignores the feature flags — a switched-off route still answers on that URL, with a 404,
 * so an editor's row cannot inherit it either.
 */
const SITE_SECTIONS: readonly SiteSection[] = [
  { href: "/", name: "Home", fromPage: true },
  { href: "/about", name: "About the Centre", fromPage: true },
  { href: "/research", name: "Research areas" },
  { href: "/projects", name: "Projects" },
  { href: "/people", name: "People" },
  { href: "/publications", name: "Publications", flag: "publications" },
  { href: "/craft-explorer", name: "Craft Explorer", flag: "craftExplorer" },
  { href: "/gallery", name: "Gallery", flag: "gallery" },
  { href: "/news", name: "News" },
  { href: "/events", name: "Events", flag: "events" },
  { href: "/contact", name: "Contact", fromPage: true },
  /*
   * The newsletter sign-up page.
   *
   * ⚠ NO `fromPage`, AND THAT IS THE LOAD-BEARING HALF. There is no `Page` row behind this route — its
   * metadata comes from `pageMetadata()` in the file itself, not from the page builder — so it belongs
   * here exactly as `/search` and `/credits` do. Omitting `fromPage` also puts it in `CODE_OWNED_HREFS`,
   * which is the answer that stays right if an editor ever creates a row with the slug "newsletter": the
   * static segment wins the URL (contract §13b), so that row's title must not be filed against it.
   *
   * ⚠ IT FILES UNDER "T", NOT "N", and that is the documented rule rather than an oversight. `name` is
   * verbatim what the page calls itself on screen — its `PageHero` title is "The Centre's newsletter" —
   * and every other section here keeps that rule too ("Photography credits" files under P, not C).
   * Writing "Newsletter" to land it under N would be the second name for one page this type forbids, and
   * a reader who searched the site for the word would then find two different names for one address.
   */
  { href: "/newsletter", name: "The Centre's newsletter" },
  { href: "/search", name: "Search" },
  { href: "/credits", name: "Photography credits" },
  // It lists itself. A directory that leaves out one page because that page happens to be this one is
  // the beginning of a directory nobody can trust to be complete.
  { href: "/a-z", name: "A–Z index" }
];

/**
 * The URLs where a code route is the page and a same-slug `Page` row is not.
 *
 * Built from the list above rather than restated, so adding a section cannot leave a row shadowing it.
 * `/`, `/about` and `/contact` are absent because there the row IS the page.
 */
const CODE_OWNED_HREFS: ReadonlySet<string> = new Set(
  SITE_SECTIONS.filter((section) => !section.fromPage).map((section) => section.href)
);

// ─────────────────────────────────────────────────────────────────────────────
// Alphabetising
// ─────────────────────────────────────────────────────────────────────────────

const LETTERS: readonly string[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

/** Everything that does not begin with a Latin letter. Last in the bar, where an exception belongs. */
const OTHER_BUCKET = "#";

/**
 * What "#" means, in words.
 *
 * Read out beside the chip and beside the heading, because "#" is a symbol whose meaning here is pure
 * convention — and a reader who cannot see that it sits last in the bar has nothing else to go on
 * (contract §11). It says "outside A–Z" rather than "another script" so that a digit, a symbol and the
 * ligature the collator cannot fold to one letter are all covered honestly.
 */
const OTHER_GLOSS = " — numbers, symbols and letters outside A–Z";

/**
 * The name reduced to what alphabetising should actually look at.
 *
 * Diacritics are folded, so "Ājrakh" files under A rather than into the leftovers bucket, and a
 * leading quotation mark or bracket is dropped, so “Kalamkari” is not filed under a punctuation mark
 * no reader would think to look for. Both steps happen ONCE per entry and the result is what the
 * comparator reads too — deriving the letter one way and the sort order another is how a list ends up
 * with an entry sitting under a heading it does not belong to.
 */
function sortNameOf(name: string): string {
  return name
    .trim()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/^[^\p{L}\p{N}]+/u, "");
}

/**
 * Case- and accent-insensitive, so "de Souza" and "De Souza" are neighbours rather than a page apart,
 * and numeric so "Craft 2" precedes "Craft 10".
 *
 * Declared above `bucketOf` because that function asks it questions, not merely because the sort does.
 */
const COLLATOR = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/**
 * Which bucket a sort key belongs in.
 *
 * ⚠ TWO STEPS, BECAUSE FOLDING DIACRITICS DOES NOT FOLD EVERY LATIN LETTER. "Ā" decomposes into A plus
 * a combining macron and `sortNameOf` has already dealt with it; "Ø", "Ł" and "Đ" decompose into
 * nothing at all. Testing the code point alone therefore filed Ørsted under "#" while the collator
 * went on sorting it between the Or… and the Os… — an entry under a heading it does not belong to,
 * which is the one failure the shared sort key exists to prevent. So a first character that is not
 * A–Z is offered to the collator, which at base sensitivity answers that Ø is an O.
 *
 * What is left is genuinely left over: a digit, a symbol, another script, or a ligature that expands
 * to two letters (Æ, Œ) and so is equal to none of them. The heading over that bucket says so.
 *
 * The first CODE POINT rather than `charAt(0)`, which can hand back half a surrogate pair — not a
 * character the collator can be asked a sensible question about. An astral-plane script lands in the
 * leftovers bucket whole, which is where it belongs anyway.
 */
function bucketOf(sortName: string): string {
  const first = (Array.from(sortName)[0] ?? "").toUpperCase();
  // One character can upper-case into two — "ß" becomes "SS" — and the bucket is the first of them,
  // which is also where the collator sorts the word. Without this an S-word would fall through to the
  // leftovers.
  const initial = first.charAt(0);
  if (/^[A-Z]$/.test(initial)) return initial;
  return LETTERS.find((letter) => COLLATOR.compare(first, letter) === 0) ?? OTHER_BUCKET;
}

/** `#` is not a legal fragment on its own, so the leftovers bucket gets a name of its own. */
function anchorOf(bucket: string): string {
  return bucket === OTHER_BUCKET ? "az-other" : `az-${bucket.toLowerCase()}`;
}

interface RankedEntry extends AzEntry {
  sortName: string;
  bucket: string;
}

/**
 * A TOTAL ordering, and it has to be.
 *
 * The queries carry no `ORDER BY` — everything is merged and sorted here, because seven separately
 * ordered lists interleave into no order at all. Postgres is then free to return rows however the
 * index hands them back, so any tie left unbroken would render a different page on every request,
 * which reads as data changing by itself. Name, then kind, then href: href is unique, so there is
 * nothing left to be arbitrary about.
 */
function compareEntries(a: RankedEntry, b: RankedEntry): number {
  const byName = COLLATOR.compare(a.sortName, b.sortName);
  if (byName !== 0) return byName;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.href === b.href) return 0;
  return a.href < b.href ? -1 : 1;
}

interface LetterGroup {
  bucket: string;
  anchorId: string;
  entries: RankedEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// The page
// ─────────────────────────────────────────────────────────────────────────────

export default async function AzIndexPage() {
  const features = await getSettingCached("features");
  const now = new Date();
  const reads = buildReads(features, now);

  const results = await prerenderSafe<unknown[]>(
    "a-z",
    () => prisma.$transaction(reads.map((read) => read.query)),
    []
  );

  /**
   * ⚠ AN UNREADABLE DATABASE IS NOT AN EMPTY SITE, AND THIS PAGE MUST NOT LOOK LIKE ONE.
   *
   * `prerenderSafe` answers `[]` when the read throws, and the code routes below are added whatever
   * happened — so without this the failure renders a dozen site sections under a heading that claims
   * to cover seven kinds of record, with nothing on screen to say the rest is missing. That is the
   * "quietly stops" defect wearing its worst disguise, because the page still looks finished.
   *
   * `$transaction` returns exactly one result per statement, so a short array IS the failure and the
   * page can say so. It repairs itself at the next revalidation; the note below says that too.
   */
  const readFailed = results.length !== reads.length;

  const entries: AzEntry[] = [];
  results.forEach((result, index) => {
    const source = reads[index];
    if (!source) return;
    // A loop rather than `push(...collect())`: the spread would pass one argument per row, and this
    // is the one list on the site with no upper bound on its length.
    for (const entry of source.collect(result)) {
      // The row a code route shadows, dropped here rather than filed against a URL that renders
      // something else. See the note over SITE_SECTIONS — the URL itself is listed either way.
      if (entry.kind === "page" && CODE_OWNED_HREFS.has(entry.href)) continue;
      entries.push(entry);
    }
  });

  /**
   * The code routes, added after the rows and never over them.
   *
   * `/about` and `/contact` reach this point already claimed by their own `Page` row, carrying the
   * title an editor typed — which is what those pages display and what their browser tab says. Every
   * other section either has no row or has just had it dropped above, so it takes the name written
   * there; one `claimed` test covers both, because by now a surviving row is always the real page.
   */
  const claimed = new Set(entries.map((entry) => entry.href));
  for (const section of SITE_SECTIONS) {
    if (section.flag && !features[section.flag]) continue;
    if (claimed.has(section.href)) continue;
    claimed.add(section.href);
    entries.push({
      kind: "page",
      key: `page:${section.href}`,
      name: section.name,
      detail: section.href,
      href: section.href
    });
  }

  /**
   * A record with a blank title cannot be filed under a letter, and is counted rather than dropped.
   *
   * It is not a real state — every editor screen requires a title — but "nothing appeared and nothing
   * said why" is the failure this codebase repeats most often, and one number is cheaper than the
   * afternoon somebody would spend looking for the missing row.
   */
  const named = entries.filter((entry) => entry.name.trim().length > 0);
  const unnamed = entries.length - named.length;

  const ranked: RankedEntry[] = named.map((entry) => {
    const sortName = sortNameOf(entry.name);
    return { ...entry, sortName, bucket: bucketOf(sortName) };
  });
  ranked.sort(compareEntries);

  const byBucket = new Map<string, RankedEntry[]>();
  for (const entry of ranked) {
    const existing = byBucket.get(entry.bucket);
    if (existing) existing.push(entry);
    else byBucket.set(entry.bucket, [entry]);
  }

  // Every bucket, in order, whether or not anything landed in it: the bar renders all of them and the
  // body renders the ones with entries. One list, so the two can never disagree about what exists.
  const groups: LetterGroup[] = [...LETTERS, OTHER_BUCKET].map((bucket) => ({
    bucket,
    anchorId: anchorOf(bucket),
    entries: byBucket.get(bucket) ?? []
  }));

  const covered = KIND_ORDER.filter((kind) => reads.some((entry) => entry.kind === kind));

  return (
    <>
      <PageHero
        eyebrow="Index"
        title="A–Z index"
        description="Everything published on this site, in one alphabetical list. Each entry says what kind of record it is, so you can tell a project from a paper before you click. A page an editor has marked as not a destination, and a person who has asked to be left out of listings, are the two things deliberately absent."
        breadcrumbs={BREADCRUMBS}
      />

      {/*
        `--az-jump` IS THE HEIGHT OF THE STICKY BAR, and it is declared HERE — on the one element that
        is an ancestor of both the bar and every letter target — because it is the targets that have to
        clear it. Twenty-seven `scroll-mt` values written out in `LetterSection` would drift the first
        time a chip changed size, and the symptom is a heading landing underneath the very bar that was
        used to reach it, on a page whose entire purpose is jumping to headings. (The bar's own `top` is
        a different number: `--nav-clearance`, the fixed header it sits below.)

        4.5rem, and the arithmetic is worth writing down because the shortfall is invisible until
        somebody jumps: the chips are `h-9` (2.25rem) inside `py-2` (1rem) over a hairline border, so
        the bar is 3.3rem — and on a platform whose scrollbars take space, the one this row grows on a
        narrow window adds a further ~1rem. 4rem covered the bar and not the scrollbar. Over-clearing
        costs a little blank space above the heading; under-clearing hides the heading itself.
      */}
      <section className="shell pb-24 [--az-jump:4.5rem]">
        <div className="sticky top-[var(--nav-clearance)] z-10 -mx-5 border-b border-line-200 bg-bg-0/90 px-5 py-2 backdrop-blur sm:-mx-8 sm:px-8">
          <nav aria-label="Jump to a letter">
            {/*
              ONE ROW, ALWAYS. Twenty-seven targets cannot fit across a phone, and letting them wrap
              would make the bar three rows tall there — a third of the screen, permanently, and a
              height the clearance above could no longer be a single number for. So it scrolls
              sideways on a narrow screen and simply fits on a wide one.
            */}
            <ul className="flex flex-nowrap items-center gap-1 overflow-x-auto overscroll-x-contain">
              {groups.map((group) => (
                <li key={group.bucket}>
                  {group.entries.length > 0 ? (
                    <a
                      href={`#${group.anchorId}`}
                      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line-200 bg-card text-sm font-semibold text-ink-900 transition-colors hover:border-purple-300 hover:bg-purple-50 hover:text-purple-700"
                    >
                      {group.bucket}
                      {group.bucket === OTHER_BUCKET ? (
                        <span className="sr-only">{OTHER_GLOSS}</span>
                      ) : null}
                    </a>
                  ) : (
                    /*
                      A NON-LINK, not a disabled link: a control that cannot act must not be
                      focusable, and the dimming is paired with words — both the dashed border and the
                      "no entries" — because colour never carries meaning on its own (contract §11).

                      ⚠ THE GLOSS IS REPEATED HERE. "#" needs explaining most in the state where it is
                      NOT a link, since a reader who cannot see it has no target page to arrive at and
                      work it out from; the live branch above had it and this one had dropped it.
                    */
                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-dashed border-line-200 bg-surface-50 text-sm font-semibold text-ink-300">
                      {group.bucket}
                      <span className="sr-only">
                        {group.bucket === OTHER_BUCKET ? OTHER_GLOSS : ""} — no entries
                      </span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <div className="mt-8">
          <ResultSummary
            shown={ranked.length}
            // The total is EVERY entry the page knows about, including the untitled ones it cannot
            // file. Passing `ranked.length` for both made the line read "Showing all 152 entries"
            // directly above a note saying two more matched and were not shown — the summary
            // contradicting its own footnote.
            total={ranked.length + unnamed}
            noun={{ singular: "entry", plural: "entries" }}
            // No cap is ever applied here, so the note carries the only two things that can be
            // missing: a record whose title is blank, and a database that could not be read.
            truncated={readFailed || unnamed > 0}
            omitted={unnamed > 0 ? unnamed : undefined}
            remedy={
              readFailed
                ? "The records could not be read just now, so only the site's own pages are listed. The full index returns at the next refresh, within five minutes."
                : unnamed > 0
                  ? "Those records have no title, so there is no letter to file them under. They are still reachable from their own section of the site."
                  : undefined
            }
          />

          <p className="prose-measure mt-4 text-sm leading-relaxed text-ink-500">
            This index covers {listSentence(covered.map((kind) => KIND_PLURALS[kind]))}. News articles
            are not in it — they are indexed by date, on the{" "}
            <Link
              href="/news"
              className="font-medium text-purple-700 underline underline-offset-2 hover:text-purple-800"
            >
              news page
            </Link>
            , which is how anybody looks for one.
            {features.gallery ? (
              <>
                {" "}
                Nor are gallery albums, which are browsed as pictures in the{" "}
                <Link
                  href="/gallery"
                  className="font-medium text-purple-700 underline underline-offset-2 hover:text-purple-800"
                >
                  gallery
                </Link>
                .
              </>
            ) : null}
          </p>
        </div>

        {/*
          NO EMPTY STATE, AND NOT BY OVERSIGHT. `SITE_SECTIONS` is unconditional apart from the four
          feature flags, so this list always holds at least the site's own pages — even on a brand-new
          installation with nothing published, and even when the database cannot be read at all. An
          empty state here could only ever be dead code saying "nothing has been published", which on
          the one occasion it rendered would be false. The state it was reaching for — everything
          missing except the sections — is real, and the note above is what says so.
        */}
        {groups
          .filter((group) => group.entries.length > 0)
          .map((group) => <LetterSection key={group.bucket} group={group} />)}
      </section>
    </>
  );
}

/** "crafts, research areas and pages" — an Oxford-comma-free list, as British English wants it. */
function listSentence(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "nothing";
  const head = items.slice(0, -1).join(", ");
  return `${head} and ${items[items.length - 1] ?? ""}`;
}

/**
 * One letter and everything under it.
 *
 * ⚠ `amount="some"` RATHER THAN THE DEFAULT 0.3, AND THIS IS THE BUG IT PREVENTS. `Reveal` starts at
 * `opacity: 0` and clears it when the viewport observer fires; with the default threshold the observer
 * needs 30% of the element visible at once, which an element four viewports tall can never be. A busy
 * letter — S on any Indian craft archive — would therefore stay permanently invisible while sitting
 * complete in the DOM. Any threshold at all is wrong for a block with no bounded height.
 *
 * The `<section>` carries the id and the scroll clearance; the reveal is INSIDE it. Framer writes a
 * transform, and a transformed ancestor becomes the containing block for everything beneath it — which
 * is also why the sticky jump bar above is not wrapped in one.
 */
function LetterSection({ group }: { group: LetterGroup }) {
  const count = group.entries.length;

  return (
    <section
      id={group.anchorId}
      className="!scroll-mt-[calc(var(--nav-clearance)+var(--az-jump))] pt-12"
    >
      <Reveal amount="some">
        <div className="flex items-baseline gap-4 border-b border-line-200 pb-3">
          {/*
            The document outline this page hands a screen reader is A, B, C … — which is exactly the
            table of contents somebody navigating by heading wants. That is why nothing else on the
            page is a level-2 heading.
          */}
          <h2 className="display-title text-3xl">
            {group.bucket}
            {group.bucket === OTHER_BUCKET ? <span className="sr-only">{OTHER_GLOSS}</span> : null}
          </h2>
          <p className="text-sm text-ink-500">
            {count} {count === 1 ? "entry" : "entries"}
            {group.bucket === OTHER_BUCKET
              ? " beginning with a number, a symbol or a letter outside A–Z"
              : null}
          </p>
        </div>

        {/*
          COLUMNS, NOT A GRID. A grid fills left to right, so an alphabetical run would read A, B, C
          across the row and then D on the next — the reader's eye has to zigzag. Multi-column layout
          fills top to bottom, which is how every printed index has ever worked.
        */}
        <ul className="mt-4 gap-x-10 sm:columns-2 xl:columns-3">
          {group.entries.map((entry) => (
            <li key={entry.key} className="break-inside-avoid">
              <Link
                href={entry.href}
                className="group block rounded-md px-2 py-2 transition-colors hover:bg-surface-50"
              >
                <span className="block font-medium leading-snug text-ink-900 transition-colors group-hover:text-purple-700">
                  {entry.name}
                </span>
                <span className="mt-0.5 block text-xs text-ink-500">
                  <span className="font-medium uppercase tracking-wide">
                    {KIND_LABELS[entry.kind]}
                  </span>
                  {entry.detail ? (
                    <>
                      <span aria-hidden="true"> · </span>
                      {entry.detail}
                    </>
                  ) : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Reveal>
    </section>
  );
}
