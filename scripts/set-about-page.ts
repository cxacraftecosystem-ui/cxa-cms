/**
 * Writes the Centre's own About-page copy — Overview, Vision, Mission and About DCH — into /about.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS RATHER THAN A SEED EDIT.
 *
 * `seedPages()` (prisma/seed.ts:1032-1044) writes a page ONLY when its slug is missing; where the page
 * exists it re-asserts `isSystem` and "touches nothing else". So against any database that has been
 * seeded once — which is every deployed one — editing the About copy in prisma/seed.ts changes what a
 * FRESH INSTALL gets and leaves the live page exactly as it is: the software's first-draft wording,
 * whose own note in the seed says it "describes what this software is for in terms that are true of any
 * craft-documentation centre". True of anybody is not the Centre's About page.
 *
 * The four passages below are the Centre's approved wording, copied VERBATIM. Nothing here paraphrases
 * them and nothing adds a sentence of its own; the whole job of this script is to get those exact words
 * into the database and to leave the page's addressing intact while doing it.
 *
 *   npx tsx scripts/set-about-page.ts
 *
 * Reads DATABASE_URL from the environment. ⚠ Point it at the right database — `.env` in this repo is the
 * LOCAL development one, and Prisma prefers it over an exported variable, so pass the target explicitly
 * on the command line when writing to production.
 *
 * ⚠ WHAT IT REPLACES AND WHAT IT PRESERVES, because on a live page that distinction is the whole risk.
 *
 *   REPLACED — the heading, the body and the editor-facing label of the four text blocks it claims, and
 *     the ORDER of every block on the page (the four passages become one contiguous run after the hero).
 *     A block is claimed when it already carries a passage's anchor, or when its heading already reads
 *     as that passage's — which is what makes a second run a no-op rather than a second copy of the
 *     page. On a seeded database that is exactly one block: the RICH_TEXT "Vision and mission"
 *     (prisma/seed.ts:710-761). Its three paragraphs of first-draft prose are the only words this script
 *     takes away from a reader.
 *
 *   PRESERVED — every other block, untouched: the HERO, the TIMELINE holding `#history` and the
 *     PEOPLE_SHOWCASE holding `#leadership` keep their payloads, their labels and their visibility. Also
 *     preserved on the blocks it does rewrite: the anchor (verbatim, via `mergeSectionData`), the
 *     arrangement, the width, the typesetting, any chosen picture and the eye toggle. This script writes
 *     COPY; it does not hold opinions about how the copy is set.
 *
 * ⚠ THE ANCHORS ARE THE THING THAT CAN QUIETLY BREAK, AND THEY DO NOT LIVE IN THE SCHEMA. The shipped
 * menu points at `/about#vision`, `/about#leadership` and `/about#history` (lib/navigation.ts:46-48),
 * an anchor lives OUTSIDE every section schema so `z.object()` strips it on every parse, and NO STUDIO
 * SURFACE CAN CREATE ONE — an anchor lost here cannot be typed back in (lib/sections/anchor.ts:27-37).
 * So the run ends by reading every menu entry that points into this page, live rows and shipped defaults
 * alike, and printing where each fragment now lands. A fragment that lands nowhere is printed as a
 * warning rather than left for a visitor to discover.
 *
 * It is idempotent: run it twice and the second run reports every passage unchanged and writes nothing.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { PrismaClient, type Prisma, type SectionType } from "@prisma/client";

import { DEFAULT_FOOTER, DEFAULT_HEADER, type NavSeed } from "../lib/navigation";
import { mergeSectionData, normaliseAnchor, sectionAnchor } from "../lib/sections/anchor";
import { parseSectionData } from "../lib/sections/schema";
import { stableJson } from "../lib/utils";

const prisma = new PrismaClient();

const PAGE_SLUG = "about";

/**
 * ⚠ THE DEFAULT INTERACTIVE-TRANSACTION TIMEOUT IS FIVE SECONDS AND THE WORK BELOW CAN EXCEED IT. A page
 * of a dozen blocks costs three reads, four writes and up to twenty-four `updateMany` round trips for the
 * renumber; against a database on the other side of the country at 60 ms a round trip, that is most of the
 * budget, and the failure is P2028 — the copy rolled back, on the one kind of deployment this script was
 * written for, while working perfectly on the laptop it was tested on. Thirty seconds is generous for the
 * same work and still short enough that no lock is held over a coffee break.
 */
const TRANSACTION_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;

/**
 * One paragraph per string, as the minimum valid Tiptap document.
 *
 * ⚠ A RICH TEXT BODY MUST BE A DOCUMENT AND MUST NOT BE `null`. That is the mistake that put an
 * invisible gap on this very page once already — Zod's `.default()` fires for a MISSING key and never
 * for an explicit `null`, so the block stored, failed validation at render time, and only a build log
 * mentioned it (prisma/seed.ts:713-724). A helper rather than four hand-written literals so the shape is
 * written once, and variadic so a passage that later gains a second paragraph needs no reshaping.
 */
function doc(...paragraphs: string[]): Record<string, unknown> {
  return {
    type: "doc",
    content: paragraphs.map((text) => ({
      type: "paragraph",
      content: [{ type: "text", text }]
    }))
  };
}

interface Passage {
  /** The editor-facing name on the builder row. Never rendered. */
  label: string;
  /** The heading the reader sees, and the string a re-run matches an existing block by. */
  heading: string;
  /**
   * The anchor this passage should be reachable at, or null for a passage nothing links to.
   *
   * Only `vision` is set, and deliberately: the shipped menu quotes it (lib/navigation.ts:46) and it is
   * already on the block this passage claims. Inventing `#overview` or `#mission` here would be
   * addressing nothing links to, on a page where nothing in the studio can edit or remove it.
   */
  anchor: string | null;
  body: Record<string, unknown>;
}

/**
 * The Centre's About page, in the Centre's own words.
 *
 * ⚠ VERBATIM. This is approved institutional copy naming a sponsoring ministry; every clause is somebody's
 * claim about what the Centre is funded to do, and a tidier synonym here would be this script rewriting a
 * commitment nobody asked it to rewrite. Changes come from the Centre, not from an editor of this file.
 */
const PASSAGES: Passage[] = [
  {
    label: "Overview",
    heading: "Overview",
    anchor: null,
    body: doc(
      "The Centre of Excellence for a Unified AI-Enabled Craft Ecosystem Platform at IIT Kharagpur, supported by the Office of the Development Commissioner (Handicrafts), Ministry of Textiles, Government of India, brings together research, technology, design and traditional knowledge to strengthen India's handicraft ecosystem through documentation, improved tools and processes, digital repositories, AI-enabled learning, design support and market-linked innovation under a unified AI-assisted Digital Portal. The Centre was initiated in March 2026."
    )
  },
  {
    label: "Vision",
    heading: "Vision",
    // The one anchor the menu quotes into the middle of this page. See `Passage.anchor` above.
    anchor: "vision",
    body: doc(
      "To create an inclusive, future-ready handicraft ecosystem in which traditional knowledge, design, research, technology and stakeholders are connected through a unified AI-assisted Digital Portal, enabling preservation, innovation, stronger artisan capabilities and wider access to knowledge, opportunities and support."
    )
  },
  {
    label: "Mission",
    heading: "Mission",
    anchor: null,
    body: doc(
      "To develop and integrate craft documentation, improved tools and processes, digital repositories, AI-enabled learning, design support, institutional knowledge and market linkages within a unified digital platform that strengthens artisans, sustains craft traditions and supports responsible, scalable innovation across India's handicraft sector."
    )
  },
  {
    label: "About DCH",
    heading: "About DCH",
    anchor: null,
    body: doc(
      "The Office of the Development Commissioner (Handicrafts), Ministry of Textiles, Government of India, promotes the growth, sustainability and competitiveness of India's handicraft sector. It has sponsored the Centre of Excellence for a Unified AI-Enabled Craft Ecosystem Platform at IIT Kharagpur to develop a unified, AI-enabled ecosystem integrating research, technology, design, knowledge, artisan support and market development."
    )
  }
];

const SECTION_SELECT = {
  id: true,
  type: true,
  position: true,
  label: true,
  data: true,
  isVisible: true
} as const;

type SectionRow = Prisma.PageSectionGetPayload<{ select: typeof SECTION_SELECT }>;

/** A `Json` column as an object, or `{}` for the null, the array and the scalar a `Json` column also allows. */
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The heading a block is currently showing, read from the RAW payload rather than through the schema.
 *
 * ⚠ RAW ON PURPOSE. A row whose payload no longer parses — one written against an older schema, or one an
 * editor is being shown an error card for — is precisely the row a re-run must still recognise as "this
 * is the Mission passage". Reading it through `parseSectionData` would return nothing for that row, the
 * claim below would miss, and the script would write a SECOND Mission block beside the broken one.
 */
function storedHeading(data: unknown): string {
  const heading = asObject(data).heading;
  return typeof heading === "string" ? heading.trim() : "";
}

/** What one passage did, for the report printed at the end. */
interface PassageOutcome {
  heading: string;
  action: "created" | "rewritten" | "unchanged";
  /** The label of the block whose words were replaced, so the log names what was taken away. */
  replaced: string | null;
  /** The anchor the block carries now, whether it was already there or set by this run. */
  anchor: string | null;
  anchorAdded: boolean;
  /** A claimed block that an editor had switched off stays off. See where this is reported. */
  hidden: boolean;
}

interface PreservedBlock {
  label: string;
  type: SectionType;
  anchor: string | null;
}

interface MenuLink {
  fragment: string;
  /** Every menu entry quoting this fragment, described well enough to go and fix. */
  quotedBy: string[];
  /** The label of the block the fragment now lands on, or null for a link that scrolls nowhere. */
  landsOn: string | null;
}

interface Report {
  pageTitle: string;
  published: boolean;
  passages: PassageOutcome[];
  preserved: PreservedBlock[];
  reordered: boolean;
  menu: MenuLink[];
}

/**
 * Collect the `/about#…` fragments a menu tree quotes.
 *
 * Recursive because the menu is two levels deep by design and the anchors the header uses are all on the
 * SECOND level (lib/navigation.ts:41-50) — a walk of the top level alone would find none of them and
 * report a clean run.
 */
function collectSeedFragments(nodes: readonly NavSeed[], into: Map<string, string[]>): void {
  for (const node of nodes) {
    noteFragment(node.href, `the shipped default menu, “${node.label}”`, into);
    if (node.children) collectSeedFragments(node.children, into);
  }
}

/**
 * Record one href if it points into this page.
 *
 * `indexOf` rather than `startsWith`, so an entry written as a full `https://…/about#vision` counts too;
 * the fragment is run through `normaliseAnchor` for the same reason `sectionAnchor` does, so both sides
 * of the comparison below are cleaned by the same function and a stray `#` or capital cannot make a
 * working link look broken.
 */
function noteFragment(href: string, quotedBy: string, into: Map<string, string[]>): void {
  const marker = `/${PAGE_SLUG}#`;
  const at = href.indexOf(marker);
  if (at === -1) return;

  const fragment = normaliseAnchor(href.slice(at + marker.length));
  if (!fragment) return;

  const existing = into.get(fragment);
  if (existing) existing.push(quotedBy);
  else into.set(fragment, [quotedBy]);
}

async function main(): Promise<void> {
  const page = await prisma.page.findUnique({
    where: { slug: PAGE_SLUG },
    select: { id: true, title: true, status: true, deletedAt: true }
  });

  if (!page || page.deletedAt) {
    console.error(
      `There is no /${PAGE_SLUG} page on this database. This script rewrites that page's passages and ` +
        "deliberately does not create the page: a page carries a title, a description, its system flag " +
        "and its publication state, and inventing those here would publish a page nobody wrote. Run the " +
        "seed against this database first, then run this."
    );
    process.exitCode = 1;
    return;
  }

  // One transaction for the read, the claim and every write. The claim decides which existing block each
  // passage replaces, so a block added or deleted between the read and the write would silently change
  // what is replaced — and the two-pass renumber at the end is not a state any other writer should see
  // half of.
  const report = await prisma.$transaction(async (tx) => {
    const rows = await tx.pageSection.findMany({
      where: { pageId: page.id },
      orderBy: { position: "asc" },
      select: SECTION_SELECT
    });

    // Every anchor already on the page, BEFORE anything is written. Read once and used as the test for
    // "does this address already exist somewhere", so a passage can never be given an anchor that is
    // already an id on another block — two elements with one id is a link that scrolls to whichever the
    // browser reaches first.
    const anchorsOnPage = new Set(
      rows.map((row) => sectionAnchor(row.data)).filter((anchor): anchor is string => anchor !== null)
    );

    /*
     * WHICH EXISTING BLOCK EACH PASSAGE REPLACES.
     *
     * Two passes, and the order between them matters. ANCHOR FIRST: the seeded "Vision and mission" block
     * carries `vision` under a heading that matches nothing below, and claiming it by that anchor is what
     * keeps `/about#vision` landing on the Vision passage instead of stranding the anchor on prose that
     * has been replaced elsewhere. HEADING SECOND: that is what a re-run matches on, and it is the whole
     * of this script's idempotence.
     *
     * A passage that claims nothing gets a new block. That is the honest outcome — the alternative,
     * guessing that some other RICH_TEXT block "is really" the Overview, would overwrite whatever an
     * editor had written there.
     */
    const claims = new Map<number, SectionRow>();
    const claimedIds = new Set<string>();

    for (const [index, passage] of PASSAGES.entries()) {
      if (!passage.anchor) continue;
      const match = rows.find(
        (row) =>
          row.type === "RICH_TEXT" && !claimedIds.has(row.id) && sectionAnchor(row.data) === passage.anchor
      );
      if (match) {
        claims.set(index, match);
        claimedIds.add(match.id);
      }
    }

    for (const [index, passage] of PASSAGES.entries()) {
      if (claims.has(index)) continue;
      // Case-insensitively, because "About DCH" and "About DCH " are the same passage to a reader and the
      // difference is a keystroke nobody can see in the studio.
      const wanted = passage.heading.toLowerCase();
      const match = rows.find(
        (row) =>
          row.type === "RICH_TEXT" &&
          !claimedIds.has(row.id) &&
          storedHeading(row.data).toLowerCase() === wanted
      );
      if (match) {
        claims.set(index, match);
        claimedIds.add(match.id);
      }
    }

    const passages: PassageOutcome[] = [];
    /** The four blocks in passage order, as ids, for the renumber below. Filled as each is written. */
    const passageIds: string[] = [];

    // `max + 1` rather than the row count. The builder keeps `position` dense (prisma/schema.prisma:469),
    // but a page edited by anything else need not be, and this value only has to be FREE — the renumber
    // at the end puts every block back into a dense 0-based run whatever it was before.
    let nextFreePosition = rows.reduce((highest, row) => Math.max(highest, row.position), -1) + 1;

    for (const [index, passage] of PASSAGES.entries()) {
      const existing = claims.get(index);
      const base = asObject(existing?.data);
      const carried = sectionAnchor(base);

      /*
       * The anchor is SET only where it would otherwise not exist anywhere: the block carries none of its
       * own, and no other block on the page already claims that address. Both halves are load-bearing.
       * Without the first, a passage claiming a block that carries `history` would have that anchor
       * overwritten — `mergeSectionData` keeps one `anchor` key, not two — and the menu entry pointing at
       * it would scroll nowhere. Without the second, a re-run against a page where somebody had moved
       * `vision` onto another block would put the same id on two elements.
       */
      const anchorAdded = passage.anchor !== null && carried === null && !anchorsOnPage.has(passage.anchor);
      const raw = anchorAdded ? { ...base, anchor: passage.anchor } : base;

      /*
       * Merged over whatever the block already holds, never over `defaultSectionData("RICH_TEXT")`: the
       * schema default for `body` is the studio's prompt "Write the text for this section."
       * (lib/sections/schema.ts:1929-1939), and a payload built from it is one forgotten override away
       * from publishing that prompt. Merging over the stored row also leaves the editor's arrangement,
       * width, typesetting and picture exactly as they were — this script writes copy, not layout.
       *
       * Parsed BEFORE it is written, so a typo in the four passages above fails here, in a terminal, with
       * the field named — rather than at render time as an editor-only error card where a reader sees a
       * gap. The parse also strips the anchor, which is why `mergeSectionData` puts it back.
       */
      const parsed = parseSectionData("RICH_TEXT", { ...base, heading: passage.heading, body: passage.body });
      if (!parsed.ok) {
        throw new Error(
          `The "${passage.heading}" passage is not a valid text block and would render as an error card ` +
            `rather than as copy: ${parsed.message}`
        );
      }

      const data = mergeSectionData(raw, parsed.data);

      if (!existing) {
        const created = await tx.pageSection.create({
          data: {
            pageId: page.id,
            type: "RICH_TEXT",
            position: nextFreePosition,
            label: passage.label,
            data: data as Prisma.InputJsonValue,
            /*
             * ⚠ VISIBLE, WHICH IS THE OPPOSITE OF WHAT THE STUDIO'S "ADD A BLOCK" DOES, AND FOR THE SAME
             * REASON. That path forces a new block on a live page to arrive HIDDEN because it arrives
             * "wearing its seeded placeholder wording" (app/api/studio/pages/[id]/sections/route.ts:44-49).
             * These blocks arrive wearing the Centre's approved copy. Publishing that is the entire point
             * of running this, and a page that silently gained four switched-off blocks would look, to the
             * operator who ran it, exactly like a script that had done nothing.
             */
            isVisible: true
          },
          select: { id: true }
        });
        nextFreePosition += 1;
        passageIds.push(created.id);
        passages.push({
          heading: passage.heading,
          action: "created",
          replaced: null,
          anchor: anchorAdded ? passage.anchor : null,
          anchorAdded,
          hidden: false
        });
        continue;
      }

      passageIds.push(existing.id);

      // `stableJson` on both sides because `data` is a **jsonb** column, which normalises key order on the
      // way in: a plain `JSON.stringify` comparison reports "different" for a row that is byte-identical in
      // meaning, and the no-op skip that depends on it would never fire (lib/utils.ts:170).
      const sameData = stableJson(existing.data) === stableJson(data);
      const sameLabel = existing.label === passage.label;

      if (!sameData || !sameLabel) {
        await tx.pageSection.update({
          where: { id: existing.id },
          data: { data: data as Prisma.InputJsonValue, label: passage.label }
        });
      }

      passages.push({
        heading: passage.heading,
        // The label alone changing still counts as a rewrite: it is a change an operator should see named.
        action: sameData && sameLabel ? "unchanged" : "rewritten",
        replaced: existing.label,
        anchor: carried ?? (anchorAdded ? passage.anchor : null),
        anchorAdded,
        hidden: !existing.isVisible
      });
    }

    /*
     * THE ORDER OF THE WHOLE PAGE.
     *
     * The four passages become one contiguous run, in the order they are written above, sitting directly
     * after the page's opening hero — a page that opens, then says what the Centre is, then what it
     * intends, then who funds it. Every other block keeps its own relative order after them, which on the
     * seeded page leaves the history and the leadership exactly where a reader who has scrolled past the
     * prose expects them.
     */
    const others = rows.filter((row) => !claimedIds.has(row.id));
    const first = others[0];
    // Annotated, not inferred: the empty branch would otherwise be `never[]`, and `.map` over the union of
    // that and `SectionRow[]` is a call TypeScript refuses to resolve.
    const opener: SectionRow[] = first && first.type === "HERO" ? [first] : [];
    const rest = others.slice(opener.length);
    const orderedIds = [...opener.map((row) => row.id), ...passageIds, ...rest.map((row) => row.id)];

    /*
     * Renumbered only where the numbering is not already what it should be — which on a second run it is,
     * so a re-run writes nothing at all rather than 2N pointless UPDATEs against a live page.
     *
     * The test is against the POSITIONS and not merely against the order: `rows` is read `orderBy
     * position`, so a page numbered 0, 2, 5 reads back in the right sequence and an order-only comparison
     * would call it correct. The builder's arithmetic assumes a dense 0-based run
     * (prisma/schema.prisma:469), so leaving it sparse is a trap for the next person to drag a block.
     */
    const reordered =
      orderedIds.length !== rows.length ||
      orderedIds.some((id, index) => {
        const current = rows[index];
        return !current || current.id !== id || current.position !== index;
      });

    /*
     * ⚠ TWO PASSES THROUGH THE NEGATIVES, AND A SINGLE PASS CANNOT WORK. `@@unique([pageId, position])` is
     * a unique index, and Postgres checks one of those PER ROW the instant that row is written — so moving
     * a block to position 0 while another still sits there is refused and kills the transaction, and every
     * new arrangement overlaps the old one somewhere. `-1 - index` is unique per block and can never
     * collide with a final value, which is always >= 0.
     *
     * This is `rewriteSectionPositions()` from lib/studio/crud.ts, whose header carries the full argument,
     * deliberately reproduced rather than imported: that module opens with `import "server-only"` and pulls
     * in the studio's whole write plumbing, and its failures are `ApiError`s — an HTTP status and a
     * sentence written for a browser, which is not a thing a terminal can do anything with.
     *
     * It is still a loop here, and in the product it is not: `rewriteSectionPositions` does each pass in
     * one statement, because a per-row loop inside an interactive transaction is what made the people
     * board unable to save an order (app/api/studio/people/reorder/route.ts). A setup script run by hand
     * from a terminal against a page it is itself authoring can afford the round trips; an editor pressing
     * an arrow cannot.
     */
    if (reordered) {
      for (const [index, id] of orderedIds.entries()) {
        await tx.pageSection.updateMany({ where: { id, pageId: page.id }, data: { position: -1 - index } });
      }
      for (const [index, id] of orderedIds.entries()) {
        await tx.pageSection.updateMany({ where: { id, pageId: page.id }, data: { position: index } });
      }
    }

    /*
     * WHERE EVERY MENU LINK INTO THIS PAGE NOW LANDS.
     *
     * The live rows AND the shipped defaults, unioned rather than resolved the way lib/navigation-server.ts
     * resolves them (rows for a location if it has any, otherwise the default). Checking a fragment that
     * nothing actually renders costs one printed line; missing one costs a menu entry that scrolls nowhere,
     * on a page whose anchors no studio surface can restore.
     */
    const fragments = new Map<string, string[]>();
    collectSeedFragments(DEFAULT_HEADER, fragments);
    collectSeedFragments(DEFAULT_FOOTER, fragments);

    const navRows = await tx.navigationItem.findMany({
      where: { href: { contains: `/${PAGE_SLUG}#` } },
      select: { label: true, href: true, location: true }
    });
    for (const item of navRows) noteFragment(item.href, `the ${item.location} menu, “${item.label}”`, fragments);

    // Re-read rather than reasoned about: the anchors that matter are the ones on the page AFTER the write,
    // and a report derived from what the script believes it did cannot catch the case where it was wrong.
    const finalRows = await tx.pageSection.findMany({
      where: { pageId: page.id },
      orderBy: { position: "asc" },
      select: { label: true, type: true, data: true }
    });

    const landing = new Map<string, string>();
    for (const row of finalRows) {
      const anchor = sectionAnchor(row.data);
      // The parentheses are required rather than tidy: `??` may not be mixed with `||` unparenthesised.
      // An unlabelled block is named by its heading, and a block with neither by its type — anything is
      // better than an empty pair of quotation marks in the one line an operator reads to check a link.
      if (anchor && !landing.has(anchor)) {
        landing.set(anchor, row.label ?? (storedHeading(row.data) || row.type));
      }
    }

    const menu: MenuLink[] = [...fragments.entries()]
      .map(([fragment, quotedBy]) => ({ fragment, quotedBy, landsOn: landing.get(fragment) ?? null }))
      .sort((a, b) => a.fragment.localeCompare(b.fragment));

    const preserved: PreservedBlock[] = others.map((row) => ({
      label: row.label ?? "(unlabelled)",
      type: row.type,
      anchor: sectionAnchor(row.data)
    }));

    return {
      pageTitle: page.title,
      // The seed's own liveness rule is not re-derived here: this is only a closing note, and a note that
      // needed `isLive`'s five branches to be right would be a second, weaker copy of them.
      published: page.status === "PUBLISHED",
      passages,
      preserved,
      reordered,
      menu
    } satisfies Report;
  }, TRANSACTION_OPTIONS);

  print(report);
}

function print(report: Report): void {
  const rewritten = report.passages.filter((passage) => passage.action !== "unchanged").length;

  console.log(
    rewritten === 0 && !report.reordered
      ? `/${PAGE_SLUG} (“${report.pageTitle}”) already carries the Centre's copy. Nothing was written.`
      : `/${PAGE_SLUG} (“${report.pageTitle}”) now carries the Centre's copy:`
  );

  for (const [index, passage] of report.passages.entries()) {
    const anchor = passage.anchor
      ? `  #${passage.anchor}${passage.anchorAdded ? " (added)" : " (kept)"}`
      : "";
    const over = passage.replaced ? ` over “${passage.replaced}”` : "";
    console.log(`  ${index + 1}. ${passage.heading.padEnd(12)} ${passage.action}${over}${anchor}`);
  }

  if (report.reordered) {
    console.log("  Every block was renumbered so the four passages sit in one run after the page's opening.");
  }

  // Named one by one rather than counted, because "3 blocks untouched" is not something an operator can
  // check against the page in front of them.
  if (report.preserved.length > 0) {
    console.log(`\n  Left exactly as they were, ${report.preserved.length}:`);
    for (const block of report.preserved) {
      const anchor = block.anchor ? `, #${block.anchor}` : "";
      console.log(`    “${block.label}” (${block.type}${anchor})`);
    }
  }

  console.log("\n  Menu links into this page:");
  if (report.menu.length === 0) {
    console.log("    none — no menu entry, live or shipped, points at a passage on this page.");
  }
  for (const link of report.menu) {
    if (link.landsOn) {
      console.log(`    #${link.fragment.padEnd(12)} → “${link.landsOn}”`);
    } else {
      // ⚠ The one genuinely bad outcome, so it is a warning and it says what to do about it. No studio
      // surface creates an anchor (lib/sections/anchor.ts:33-37), so the fix is this script or the seed.
      console.warn(
        `    ⚠ #${link.fragment} lands on NOTHING. Quoted by ${link.quotedBy.join(", ")}. That link now ` +
          "scrolls nowhere; put the anchor back on a block, or change the menu entry."
      );
    }
  }

  const hidden = report.passages.filter((passage) => passage.hidden);
  if (hidden.length > 0) {
    console.log(
      `\n  ⚠ ${hidden.length} of these blocks are switched off in the studio (${hidden
        .map((passage) => passage.heading)
        .join(", ")}), so the words above are written but not on the page. Turning a block back on changes ` +
        "what a reader sees, so it is left for a person."
    );
  }

  if (!report.published) {
    console.log("\n  Note: the page itself is not published, so none of this is on the public site yet.");
  }

  /*
   * ⚠ THE SEARCH INDEX HOLDS A COPY OF THIS PAGE'S WORDS and has just gone stale: a page's searchable text
   * is built from the text inside its blocks, so until it is rebuilt the site's own search still matches
   * the prose this run replaced and shows its summary in the results.
   *
   * It is a printed instruction rather than a call, and that is a decision. lib/search/index.ts opens with
   * `import "server-only"`, which resolves under a plain `tsx` process today ONLY because of an undeclared
   * stub in node_modules — after `npm ci` that stub is gone and the import fails with ERR_MODULE_NOT_FOUND
   * before a single row is written (prisma/seed.ts:29-90 measures this). Importing it here would trade a
   * stale index, which the next save of the page fixes, for a script that cannot run at all on a clean
   * checkout, which nothing fixes.
   */
  if (rewritten > 0) {
    console.log(
      "\n  The site's own search still holds the old wording. Open the page in the studio and save it, or " +
        "run the seed, to rebuild its search entry."
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
