import { PrismaClient, type Prisma, type Role, type SectionType } from "@prisma/client";
import { SETTINGS_DEFAULTS, SETTINGS_GROUP_KEYS } from "../lib/settings/schema";
import {
  allPlaceholderPrompts,
  defaultSectionData,
  parseSectionData,
  // ⚠ THE PUBLISH GATE'S OWN PER-BLOCK ANSWER, imported rather than re-derived, and imported for the
  // prose repair's REPORT rather than for its decision. `lib/pages.ts` asks this exact question of every
  // block before it will let a page cross into publication, so quoting it is how the repair's output and
  // the gate's refusal can be read side by side instead of being two opinions. The seed already carries
  // one derivation of this vocabulary (`allPlaceholderPrompts`, for the flattened search text) and a
  // third would be the copy the header of lib/sections/schema.ts warns about.
  placeholderPromptsIn,
  sectionPlaceholderPrompts,
  type StatsSectionData
} from "../lib/sections/schema";
// The one implementation of "put the block's anchor back after a schema has stripped it". Imported rather
// than reproduced: an anchor lost in a repair cannot be typed back in, because no studio surface creates one
// (see the header of lib/sections/anchor.ts).
import { mergeSectionData } from "../lib/sections/anchor";
import { DEFAULT_FOOTER, DEFAULT_HEADER, type NavSeed } from "../lib/navigation";
// Neither of these is `server-only`, so both can be used here — which matters, because they are the two
// decisions the search index most needs to agree with the rest of the product. See "The search index" below.
import { isLive } from "../lib/content";
import { richTextToPlainText } from "../lib/richtext";
import { truncateWords } from "../lib/utils";

import { CORPUS, purgeCorpus, seedCorpus } from "./corpus";
/*
 * ⚠ BOTH OF THESE MODULES *ARE* `server-only`, WHICH THE COMMENT HERE USED TO DENY, AND THE IMPORTS
 * WORK ANYWAY FOR A REASON THAT IS NOT SAFE TO RELY ON. lib/search/index.ts and lib/auth/password.ts
 * both begin with `import "server-only"`.
 *
 * ⚠ THERE ARE TWO COPIES OF `server-only` IN THIS CHECKOUT AND THEY BEHAVE OPPOSITELY. Only one of them
 * is what makes these imports harmless, and an earlier version of this note generalised from that one to
 * the package as published. That was false, and it led to a "fix" that breaks the seed — see the
 * paragraph after next. Measured, not assumed:
 *
 *   • `node_modules/server-only` — an UNDECLARED STUB: `{"name":"server-only","version":
 *     "0.0.0-local-test","main":"index.js"}`, body `module.exports = {}`. `npm ls server-only` reports
 *     it **extraneous**; it is in neither `package.json` nor `package-lock.json`. This is the copy a
 *     plain `tsx` process resolves, and because its body does nothing, importing it does nothing.
 *   • `node_modules/next/dist/compiled/server-only` — the GENUINE published package (the real
 *     server-only@0.0.1 manifest, vendored by Next). Its `exports` map is
 *     `{".": {"react-server": "./empty.js", "default": "./index.js"}}`; `empty.js` is empty and
 *     `index.js` is nothing but `throw new Error("This module cannot be imported from a Client
 *     Component module. It should only be used from a Server Component.")`. Verified by EXECUTING it
 *     (`node -e "require('./node_modules/next/dist/compiled/server-only/index.js')"` prints that error),
 *     not by reading it.
 *
 * Inside Next neither copy is reached by node's own resolution at all: `create-compiler-aliases.js`
 * rewrites `server-only$` to Next's compiled copy — to `empty.js` when compiling for the SERVER and to
 * `index.js` when compiling for the CLIENT, which is exactly how the marker bites a client bundle and
 * stays silent in a Server Component. Plain node and `tsx` have no such alias and never set the
 * `react-server` condition, so they take the DEFAULT branch of any `exports` map they meet.
 *
 * Which is why a clean install breaks this file: `npm ci` deletes node_modules and reinstalls from the
 * lock file, so the undeclared stub is gone and `import "server-only"` fails with ERR_MODULE_NOT_FOUND
 * before a single row is written. `npm run smoke` has the same exposure through `../lib/pages`.
 *
 * ⚠ THE EXPOSURE IS BINARY, NOT CUMULATIVE, and that is what makes the second import below acceptable.
 * Either `server-only` resolves in a plain node process or it does not; the first import decides it, and
 * a second one adds no new way to fail. So the choice for each is decided on its own merits:
 *
 *   • `reindexAll` — imported for its type and as the authority the copy below defers to. Dropping it
 *     would only move the failure, and re-implementing it here would be a third copy of the search
 *     builder.
 *   • `hashPassword` — imported because the alternative is a SECOND COPY OF A SECURITY PARAMETER. This
 *     file used to carry its own `const BCRYPT_COST = 12` with a comment claiming lib/auth/password.ts
 *     could not be imported "because that module is `server-only`, which a plain tsx script is not" —
 *     doubly wrong: the import works (see above), and `BCRYPT_COST` is not exported from that module at
 *     all, so there was never anything to import. What the duplication really cost is drift: raising the
 *     cost in lib/auth/password.ts would have left the one account a fresh installation has hashed at
 *     the old one, silently and for ever. `hashPassword()` IS exported and is exactly
 *     `bcrypt.hash(plain, 12)`, so calling it changes no behaviour and removes the copy.
 *
 * ⚠ THE FIX IS **NOT** "DECLARE `server-only` IN package.json", AND THAT INSTRUCTION — WHICH THIS NOTE
 * USED TO GIVE AS A ONE-LINER — MAKES THINGS STRICTLY WORSE. Adding `"server-only": "^0.0.1"`, or
 * running `npm install server-only`, replaces the inert stub with the genuine package described above,
 * whose `default` condition is the module that THROWS. `npm run seed` would then die at the first of the
 * two imports below to be evaluated, before a single row is written, with the very error-at-import this
 * note exists to warn about — and it would fail on EVERY machine rather than only on a freshly installed
 * one. `npm run smoke` would die the same way through `scripts/smoke.ts`'s `../lib/pages`.
 *
 * A real fix has to give a plain node process a `server-only` that RESOLVES and is INERT, without giving
 * it the throwing one, and it must not touch the marker inside lib/search/index.ts or
 * lib/auth/password.ts — deleting `import "server-only"` there would remove the guard that keeps those
 * modules out of a client bundle, which is the wrong direction entirely. The cheapest shape that does
 * all three is to check the no-op IN and declare THAT: a one-file local package plus
 * `"server-only": "file:./vendor/server-only-noop"` in devDependencies, so `npm ci` reproduces today's
 * working behaviour deterministically. Next is unaffected, because (verified above) its own alias means
 * Next never resolves the dependency at all. ⚠ Whoever makes that change must re-run `npm run seed` and
 * `npm run smoke` against a freshly `npm ci`'d tree, because the failure being fixed is one that ONLY
 * appears after a clean install and so cannot be observed in a working checkout. None of that is this
 * file's change to make, so it is recorded rather than worked around.
 *
 * ⚠ THE PASSWORD *POLICY* IS STILL NOT SHARED, and that is deliberate rather than the same oversight.
 * `passwordProblems()` next to `hashPassword` is the studio's own policy and is strictly stricter than
 * `MIN_SEED_PASSWORD_LENGTH` below — it also refuses "admin123" inside a long string, which is precisely
 * the failure this file's header worries about. It is not called here because the length check runs
 * BEFORE the administrator row is looked up, so adopting a stricter rule would abort a re-run of the
 * whole seed for an installation whose administrator already exists and is not being touched. Moving the
 * check to after that lookup is what would make sharing it safe; until then the seed is the weaker of
 * the two and this note is the record of it.
 *
 * `isLive` and `richTextToPlainText` above genuinely are not `server-only` — checked, both files —
 * which is why they can be imported for their own sake rather than for this one's.
 */
import { hashPassword } from "../lib/auth/password";
// ⚠ `indexDocument` and `searchDocFromPage` are the CANONICAL builder, imported for the repair pass and for
// nothing else. The long note under "The search index" below explains why the seed's own document builder is
// a narrow copy and must never overwrite an existing row; the repair pass is the one case where the page's
// words have just been changed BY THIS FILE, so its index row has to be rebuilt — and rebuilt by the
// authority the studio uses, not by the copy. Same module as `reindexAll`, so no new import exposure.
import { indexDocument, reindexAll, searchDocFromPage } from "../lib/search/index";

/**
 * The seed.
 *
 * It brings a fresh database to the state where an administrator can sign in and start editing —
 * and no further. By default it creates STRUCTURE, not content: the pages the code links to, the
 * default navigation, the default settings, and one account.
 *
 * ⚠ `--with-corpus` IS THE ONE EXCEPTION, AND IT IS OPT-IN BY NAME FOR THE REASON THIS COMMENT USED
 * TO GIVE AS AN ABSOLUTE. Seeded fiction has a habit of reaching production and being discovered by
 * a visitor rather than by a developer, so the demonstration corpus (prisma/corpus/) is never
 * written unless it is asked for, and `--purge-corpus` takes every record of it out again in one
 * pass. The rule has not been relaxed; it has been given a door with a handle on both sides.
 *
 * The corpus exists because the alternative turned out to be worse: an installation with no content
 * has a homepage whose every showcase says it has nothing to show, an empty craft map, an A–Z index
 * of dead letters and a search that answers nothing — all of it CORRECT, and none of it something
 * anybody can evaluate or design against.
 *
 * ⚠ IT IS ALSO WHAT KEEPS THE STUDIO ACCESS LIST FROM BEING A LOCKOUT. Nobody signs in — by password or
 * by a provider — without an entry on that list (lib/auth/access.ts), and a list that is empty on the
 * day it ships admits nobody, including the person who would write the first entry. Three things here
 * answer that, and none of them is an exemption at sign-in time:
 *
 *   • the account it creates is a MASTER ADMIN, not an administrator — it is the only account in a
 *     fresh installation, so it has to be the tier that can add the second person;
 *   • it writes that account's own grant, so the very first sign-in goes through the same gate as
 *     every later one rather than around it;
 *   • it BACKFILLS a grant for every active account that has none, so upgrading an institution that
 *     already had twelve editors does not lock all twelve out of their own CMS.
 *
 * FOUR PROPERTIES, all of which matter more than they look:
 *
 *   1. **IDEMPOTENT.** Every write is an upsert on a natural key. Running it twice is a no-op, so it
 *      is safe to run against a database that already has content — which is exactly what happens
 *      when someone adds a new structural page and re-seeds.
 *   2. **NON-DESTRUCTIVE.** It never updates a row a human may have edited. An upsert's `update`
 *      branch is deliberately minimal (usually `{}`), because "re-seeding" must not silently revert
 *      an administrator's rewrite of the About page.
 *      ⚠ THERE ARE NOW THREE NAMED EXCEPTIONS, AND ALL THREE TURN ON "MAY HAVE EDITED" RATHER THAN
 *      WEAKENING THE PROPERTY. Each announces every action and every refusal, and each has a header
 *      that must be read before its conditions — or this line — are touched.
 *        • `ensureMasterAdmin()` promotes exactly one account, only where an installation has no master
 *          admin at all and could otherwise never make one.
 *        • `repairPlaceholderStats()` rewrites the homepage's figures block, only while it can PROVE
 *          nobody has authored it — the studio's own prompt still in the heading, no metric chosen, and
 *          every figure a nought. It runs on every seed.
 *        • `repairPlaceholderProse()` rewrites the placeholder prose of /about, only while the row's own
 *          timestamps PROVE no human has ever saved it, and only where the change removes words a reader
 *          is reading rather than adding words or moving a setting. ⚠ IT IS THE ONE EXCEPTION THAT DOES
 *          NOT RUN ON AN ORDINARY SEED: it is a mode of its own, asked for by name with
 *          `--repair-placeholder-prose`, and `npm run seed` never reaches it.
 *   3. **NO DEFAULT CREDENTIAL.** Without `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` it creates no
 *      account at all and says so. A seeded `admin@example.com / admin123` survives into production
 *      more often than anybody admits, and it is a complete compromise of the institution's public
 *      voice.
 *   4. **THE PASSWORD IS CHECKED.** A weak seed password is refused with the reason, rather than
 *      accepted and hashed.
 *
 * A FIFTH, added later: **the pages it creates are put into the search index as it creates them.** They are
 * created PUBLISHED, and an installation whose own Home, About and Contact pages cannot be found in its own
 * search reads as an empty site — see "The search index" below for why that code is a copy and not a call.
 */

const prisma = new PrismaClient();

/*
 * ⚠ THE COST FACTOR IS NO LONGER RESTATED HERE. `hashPassword()` from lib/auth/password.ts owns it, and
 * the note on that import explains why the copy that used to sit on this line was wrong twice over.
 *
 * The length floor below is still this file's own, and it is the WEAKER of the two rules in the product
 * — `passwordProblems()` is stricter. See the same note for why it is not called yet and what has to
 * move first.
 */
const MIN_SEED_PASSWORD_LENGTH = 12;

/**
 * The pages the CODE links to.
 *
 * `isSystem: true` marks them undeletable in the studio — deleting one would 404 a link the site
 * itself renders in its own navigation and footer. An editor can still rewrite, reorder and
 * unpublish them; they simply cannot be removed.
 *
 * Each ships with sections so the page is not a blank canvas on day one.
 *
 * ⚠ THE PAYLOADS BELOW ARE OVERRIDES, NOT WHOLE PAYLOADS. Each is merged over
 * `defaultSectionData(type)` and then VALIDATED with `parseSectionData` before it is written, and a
 * failure aborts the seed with the reason. Hand-writing a complete payload here looks tidier and is
 * how this file shipped a RICH_TEXT block with `body: null`: Zod's `.default()` fires for a MISSING
 * key, never for an explicit `null`, so the block stored, failed validation at render time, and left
 * an invisible gap on the About page that only a build log mentioned. Deriving from the schema's own
 * defaults makes that class of mistake impossible rather than merely unlikely.
 */
interface SeedSection {
  type: SectionType;
  label: string;
  /** Only the keys this seed cares about. Everything else comes from `defaultSectionData(type)`. */
  overrides?: Record<string, unknown>;
  /** A named anchor, so a menu entry can link to this passage (lib/sections/anchor.ts). */
  anchor?: string;
}

interface SeedPage {
  slug: string;
  title: string;
  navLabel?: string;
  seoDescription: string;
  sections: SeedSection[];
}

/**
 * Merge the overrides over the schema's defaults, then validate.
 *
 * Aborting on a failure is the point. A seed that writes a block it cannot validate has produced a
 * page with a hole in it, and the only trace is one line in a build log that nobody reads until a
 * visitor asks where the text went.
 *
 * `anchor` is attached AFTER validation because it deliberately lives outside every section schema —
 * it is addressing rather than content, and `z.object()` strips unknown keys rather than rejecting
 * them. See lib/sections/anchor.ts.
 */
function buildSectionData(section: SeedSection): Prisma.InputJsonValue {
  const base = defaultSectionData(section.type);
  const merged = { ...(base as Record<string, unknown>), ...(section.overrides ?? {}) };

  const parsed = parseSectionData(section.type, merged);
  if (!parsed.ok) {
    throw new Error(
      `Seed section "${section.label}" (${section.type}) is not valid and would render as a gap on the ` +
        `page: ${parsed.message}`
    );
  }

  const validated = parsed.data as Record<string, unknown>;
  return (section.anchor ? { ...validated, anchor: section.anchor } : validated) as Prisma.InputJsonValue;
}

const SEED_PAGES: SeedPage[] = [
  {
    slug: "",
    title: "Home",
    navLabel: "Home",
    seoDescription:
      "The research, people, publications and living archive of the Centre of Excellence.",
    sections: [
      {
        type: "HERO",
        label: "Opening statement",
        /*
         * The owner's chapter-01 identity copy, verbatim in meaning with the script's ALL-CAPS
         * realised by the hero's own type treatments rather than typed into the strings (a screen
         * reader spells literal capitals out as an initialism, and the studio holds prose).
         *
         * ⚠ THE ACCENT IS THE WHOLE SECOND LINE. `headlineAccent` is matched INSIDE `headline` on
         * word boundaries (HeroHeadline.tsx), so the platform phrase paints gold as one run and
         * the visual break between "Centre of Excellence" and its qualifying line is the accent
         * boundary — which is exactly where the script draws it. Edit one and the other must keep
         * containing it, or the headline renders plainly with no gold at all.
         *
         * `showStory: false` — the story no longer needs an invitation HERE, because it plays
         * directly beneath this hero as the cinematic STORY_SCROLL block that follows. The modal
         * telling (components/site/story/) still exists for any hero an editor flips the flag on.
         */
        overrides: {
          eyebrow: "IIT Kharagpur · Centre of Excellence",
          headline:
            "Centre of Excellence for unified AI-enabled craft ecosystem platform",
          headlineAccent: "for unified AI-enabled craft ecosystem platform",
          body: "Connecting craft, knowledge, people and technology to build a living digital ecosystem for India's rich craft heritage.",
          primaryCta: { label: "Explore the ecosystem", href: "/craft-explorer" },
          secondaryCta: { label: "Discover our research", href: "/research" },
          backgroundKind: "particles",
          alignment: "left",
          showScrollCue: true,
          showStory: false
        }
      },
      /*
       * ═══════════════════════════════════════════════════════════════════════════════════════
       * THE HOMEPAGE NARRATES BEFORE IT LISTS, AND THE ORDER BELOW IS THE ARGUMENT.
       *
       * A research centre's front page is usually a grid of everything it owns: areas, projects,
       * news, events, partners. That page answers "what is here" and never answers "why should you
       * care", and a visitor who did not already know the answer leaves having read four headings.
       *
       * So the first half of this page is a story and the second half is the index. A reader is
       * carried through one cloth, one workshop and one method — and only then handed the
       * directory, by which point they know what they are looking at. Everything narrative sits
       * above the showcases, and every showcase stays exactly as it was, because the story is a
       * preface to the Centre's work rather than a replacement for it.
       *
       * ⚠ THE PHOTOGRAPHS ARE `craftImage` SLUGS, NOT UPLOADS. They resolve against the bundled
       * manifest in lib/media/craft-imagery.ts — openly licensed, attribution compiled in, rendered
       * with their credit by `StoryPicture`. So a fresh install has a real front page on day one
       * instead of a column of grey rectangles. The moment an editor uploads their own photograph
       * and picks it, `mediaId` wins and the bundled one steps aside with nothing else changing.
       * ═══════════════════════════════════════════════════════════════════════════════════════
       */
      {
        /*
         * THE CINEMATIC STORY — chapters 02–16 of the owner's script, playing directly beneath the
         * hero as one continuous night-purple piece (components/sections/story/CinematicScroll.tsx
         * owns the words and the choreography; `presentation: "cinematic"` is what summons it).
         *
         * ⚠ THE CHAPTER FIELDS BELOW ARE DELIBERATELY KEPT. They are the ordinary five-chapter
         * telling this block used to show, preserved exactly so an editor who switches the
         * presentation back to Chapters in the studio gets it back unharmed — the schema documents
         * this contract on the `presentation` field itself.
         */
        type: "STORY_SCROLL",
        label: "The story of the Centre",
        anchor: "story",
        overrides: {
          presentation: "cinematic",
          eyebrow: "Why this work exists",
          heading: "A craft is a memory that has to be used to survive",
          body: "Four things have to hold at once for a tradition to reach the next generation. This is what happens when one of them gives way — and what a record can do about it.",
          side: "left",
          showProgress: true,
          chapters: [
            {
              kicker: "The hand",
              title: "It lives in a body before it lives anywhere else",
              body: "A block printer judges the pressure of a stamp by the sound it makes on the cloth. A weaver knows a thread is wrong before their eye finds it.\n\nNone of that is written down anywhere, because it was never learnt from writing. It passed from one pair of hands to another across a shared table, over the years it takes for a movement to stop being a decision.\n\nThat is why a craft cannot be recovered from its objects alone. The finished cloth is the residue of the knowledge, not the knowledge.",
              craftImage: "block-print",
              caption: "Printing by hand at Halasur, Karnataka."
            },
            {
              kicker: "The material",
              title: "It depends on things that can quietly stop existing",
              body: "An indigo vat is a living culture that has to be fed and kept warm. A particular clay comes from one riverbank. A dye comes from a plant somebody has to still be growing.\n\nWhen a supply chain changes, the practice changes with it — and usually not by choice. A synthetic substitute arrives because the original became unobtainable, and a generation later nobody remembers what the original did differently.",
              craftImage: "kalamkari",
              caption: "Kalamkari, hand-painted with a bamboo pen and natural mordants."
            },
            {
              kicker: "The pattern",
              title: "The design carries information nobody wrote down",
              body: "A motif is rarely only decorative. It records a region, a community, a marriage, a debt, a season. A double ikat has to be planned thread by thread on both warp and weft before a single one is woven, which makes the pattern a set of instructions as much as a picture.\n\nRead carefully, a textile is a document. Read carelessly, it is a nice arrangement of colours — and the difference is whether anybody is still alive who can tell you which.",
              craftImage: "patola",
              caption: "Patola double ikat from Patan, resolved in the dye before the loom."
            },
            {
              kicker: "The break",
              title: "It ends in one generation, not gradually",
              body: "Craft traditions do not fade evenly. They end when the last person who does the difficult part stops doing it, and that is a single event with a date.\n\nBefore it, the practice looks small but alive. After it, what remains is objects, photographs and people who watched. The window in which the knowledge can still be recorded from the person who holds it is narrow, and it is almost never obvious from outside that it is closing.",
              craftImage: "dhokra",
              caption: "Dhokra lost-wax casting — each mould is destroyed to release its object."
            },
            {
              kicker: "The record",
              title: "What a record can and cannot do",
              body: "A record does not preserve a craft. Only practising it does that.\n\nWhat a record can do is make the practice legible to people outside it: to a student choosing what to learn, a policymaker deciding what to fund, a designer looking for a collaborator, a historian a century from now. It can hold the process, the vocabulary, the materials and the names, at a level of detail that lets somebody rebuild an understanding rather than admire a photograph.\n\nThat is what this archive is for, and it is why the method matters as much as the material.",
              craftImage: "handloom",
              caption: "A silk handloom at Kanchipuram, mid-warp.",
              href: "/craft-explorer",
              ctaLabel: "Open the craft archive"
            }
          ]
        }
      },
      /*
       * ═══════════════════════════════════════════════════════════════════════════════════════
       * THE CORPUS, IN NUMBERS — AND THE FOUR FALSEHOODS THIS BLOCK USED TO PUBLISH.
       *
       * It shipped as four figures with `value: "0"` and no heading override, so the homepage read:
       *
       *     Add a heading
       *     0 Crafts documented   0 Field records   0 Publications   0 Partner institutions
       *     Figures update as records are published.
       *
       * — beside a database holding 42 crafts, 30 publications and 13 partners. The caption is the
       * worst part of it: a reader who might have questioned four zeros is told they are live.
       *
       * ⚠ NOTHING WAS EVER GOING TO UPDATE THEM. `value` is a hand-typed string in a JSON column.
       * "Figures update as records are published" was not a stale promise, it was never true at all,
       * and the fix is not a better number to type — it is to stop typing numbers. Each figure below
       * names a `metric` and leaves `value` EMPTY, which is what asks the site to count it: see
       * `CENSUS_METRICS` in lib/sections/schema.ts, and `censusCount` in lib/sections/resolve.ts for
       * the predicates. Because `value` wins over a count, leaving it empty is not optional here —
       * a "0" left in any of these boxes would go on winning for ever.
       *
       * ⚠ "FIELD RECORDS" IS GONE AND ITS REPLACEMENT IS NOT AN ARBITRARY CHOICE. The honest metric
       * for it is `galleryItems` (items catalogued in published albums), and the demonstration corpus
       * writes no albums at all — so that figure would be nought, and a nought is dropped from the
       * row by design. A figure authored to be permanently absent is a figure that should not be
       * authored: it teaches whoever reads this seed that the block is broken. `people` is counted
       * instead, which the corpus fills with 24 published profiles, and the label says exactly what
       * that number is rather than reaching for the more impressive word.
       *
       * The heading is REAL COPY. It was previously left to the schema's placeholder, which is how
       * "Add a heading" reached the public page.
       *
       * ⚠ AND THE PUBLISH GATE WOULD NOT HAVE SAVED THIS ROW, WHICH IS WHY THE OVERRIDE IS LOAD-BEARING
       * RATHER THAN TIDY. This paragraph used to say `pagePublishBlockers()` in lib/pages.ts "has no
       * caller yet". IT HAS TWO, and neither of them covers this row: the PATCH handler
       * (`app/api/studio/pages/[id]/route.ts`) refuses only the CROSSING into publication —
       * DRAFT/IN_REVIEW/ARCHIVED → PUBLISHED or SCHEDULED — and the restore handler refuses prompt-bearing
       * BLOCKS being restored into a page that is already live. The seeded homepage is created PUBLISHED
       * and stays PUBLISHED, so it never crosses anything and is grandfathered BY DESIGN (an editor must
       * not be locked out of a form that cannot fix the block the refusal names). Read the ⚠ block on
       * `pagePublishBlockers` for both boundaries before assuming either way. The consequence for THIS
       * block is the whole reason `repairPlaceholderStats()` exists further down the file.
       *
       * ⚠ EDITING THIS LITERAL DOES NOT REPAIR A DATABASE THAT HAS ALREADY BEEN SEEDED. Property 2 of
       * this file is that the seed never updates a row a human may have edited, so `seedPages()` finds the
       * existing homepage and steps over it — measured, not assumed: before the repair pass was written,
       * the stored STATS payload of THIS development database still read `heading: "Add a heading"` with
       * four items at `value: "0"` and no `metric` key at all, and the page published four noughts under
       * "Figures update as records are published." Everything in this literal is therefore the fix for a
       * FRESH install only. `repairPlaceholderStats()` below is the fix for an installation that already
       * has the old row: it writes THIS block's payload over that one row, and only while it can prove
       * nobody has edited it. `--replace-pages` remains the blunt instrument and destroys editor work on
       * every seeded page (see its own header before running it).
       * ═══════════════════════════════════════════════════════════════════════════════════════
       */
      {
        type: "STATS",
        label: "The corpus, in numbers",
        overrides: {
          eyebrow: "The corpus",
          heading: "What is in the archive today",
          countUp: true,
          items: [
            {
              label: "Crafts documented",
              value: "",
              metric: "crafts",
              description: "Distinct traditions with a published record"
            },
            {
              label: "Practitioners and scholars",
              value: "",
              metric: "people",
              description: "Named in the archive, each with their own record"
            },
            {
              label: "Publications",
              value: "",
              metric: "publications",
              description: "Peer-reviewed, open access, datasets and patents"
            },
            { label: "Partner institutions", value: "", metric: "partners" }
          ],
          // Says what the figures ARE and how fresh they are, and promises nothing the page does not
          // do. The old line promised live figures over four hard-coded noughts; this one describes a
          // count taken during the render, which is what actually happens.
          source:
            "Counted from the Centre's own published records each time this page is rebuilt, not entered by hand."
        }
      },
      {
        // The platform, in three instruments — three fixed designed vignettes (the copy and drawings
        // are code; only this header is content), between the corpus figures and the daylight turn.
        type: "PLATFORM_PILLARS",
        label: "The platform — three instruments",
        overrides: {
          eyebrow: "The platform",
          heading: "Three instruments, one ecosystem"
        }
      },
      {
        /*
         * The daylight turn: the first photograph after the story's dawn, carrying the reader from
         * the telling into the collection itself. It used to sit directly under the hero; the
         * cinematic story owns that seat now.
         *
         * ⚠ THE FIVE-STAGE METHOD BLOCK (PROCESS_STEPS, "How a craft enters the archive") WAS
         * REMOVED FROM THIS PAGE, not from the product, when the cinematic landed: its five-step
         * ladder back-to-back with the story's five-verb ladder read as the same device twice. The
         * method copy remains in this file's git history and the block type remains in the palette
         * — an editor can re-add it to any page from the studio.
         */
        type: "PARALLAX_BANNER",
        label: "The turn — from the Centre to the work",
        anchor: "the-work",
        overrides: {
          eyebrow: "The archive",
          heading: "Every one of these was learnt from somebody",
          body: "Not from a manual. From a person, in a room, over years — which is the whole of why it can be lost.",
          craftImage: "jaali",
          height: "lg",
          overlay: "scrim",
          align: "left",
          speed: 14
        }
      },
      {
        /*
         * The country itself, straight after the archive's turn: the banner says "every one of
         * these was learnt from somebody" and the map answers WHERE — every region holding
         * published crafts, counted live, each row linking into the explorer filtered to it. The
         * block has no content of its own beyond this header (see indiaMapSectionSchema).
         */
        type: "INDIA_MAP",
        label: "Where the work is",
        anchor: "across-the-country",
        overrides: {
          eyebrow: "Across the country",
          heading: "Where the work is",
          body: "Every region holding published records, drawn on the official outline of India. Choose a place to open the archive there."
        }
      },
      {
        /*
         * Chapter 14 of the owner's script — the audiences — as a real daylight section rather
         * than a beat inside the cinematic: these six are commitments a visitor may want to act
         * on, and a grid they can dwell on serves that better than a scene that moves past.
         * ⚠ The script's own note: confirm all six against the Centre's actual commitments.
         */
        type: "FEATURE_GRID",
        label: "Who the ecosystem is for",
        anchor: "for-everyone",
        overrides: {
          eyebrow: "Who it is for",
          heading: "An ecosystem built for many perspectives",
          columns: 3,
          items: [
            {
              icon: "Hammer",
              title: "For artisans",
              body: "Making knowledge more visible, connected and discoverable.",
              href: "/craft-explorer"
            },
            {
              icon: "Handshake",
              title: "For communities",
              body: "Supporting the continuity of living cultural knowledge.",
              href: "/about"
            },
            {
              icon: "Microscope",
              title: "For researchers",
              body: "Opening new avenues for interdisciplinary research.",
              href: "/research"
            },
            {
              icon: "PenTool",
              title: "For designers",
              body: "Connecting contemporary creation with traditional knowledge.",
              href: "/gallery"
            },
            {
              icon: "GraduationCap",
              title: "For students",
              body: "Creating new opportunities for learning and experimentation.",
              href: "/events"
            },
            {
              icon: "Landmark",
              title: "For institutions",
              body: "Enabling collaboration across research, culture and technology.",
              href: "/contact"
            }
          ]
        }
      },
      {
        type: "HORIZONTAL_RAIL",
        label: "A line through the collection",
        anchor: "in-the-archive",
        overrides: {
          // The homepage draws this line as the arc: the same cards fanned along a turnable curve.
          presentation: "arc",
          eyebrow: "In the archive",
          heading: "Traditions currently documented",
          body: "A few of the practices held in the collection. Each has its own record: materials, technique, region, lineage and the people who work in it.",
          pin: false,
          cardWidth: "md",
          items: [
            { title: "Ajrakh and hand block printing", meta: "Rajasthan and Gujarat", detail: "Resist printing in natural dyes, built up in as many as sixteen passes.", craftImage: "block-print", href: "/craft-explorer" },
            { title: "Patola double ikat", meta: "Patan, Gujarat", detail: "Both warp and weft dyed to pattern before a single thread is woven.", craftImage: "patola", href: "/craft-explorer" },
            { title: "Pashmina hand-weaving", meta: "Srinagar, Kashmir", detail: "Fibre spun so fine it cannot be worked on a powered loom.", craftImage: "pashmina", href: "/craft-explorer" },
            { title: "Dhokra lost-wax casting", meta: "Bastar, Chhattisgarh", detail: "A four-thousand-year-old casting method with no two objects alike.", craftImage: "dhokra", href: "/craft-explorer" },
            { title: "Pichwai temple hangings", meta: "Nathdwara, Rajasthan", detail: "Devotional cloths painted to a fixed iconography and a seasonal calendar.", craftImage: "pichwai", href: "/craft-explorer" },
            { title: "Bidriware inlay", meta: "Bidar, Karnataka", detail: "Silver inlaid into a blackened zinc alloy, fixed with soil from the fort.", craftImage: "bidriware", href: "/craft-explorer" },
            { title: "Warli wall painting", meta: "Palghar, Maharashtra", detail: "A ritual grammar of circles, triangles and lines, painted on mud walls.", craftImage: "warli", href: "/craft-explorer" },
            { title: "Zardozi metal embroidery", meta: "Hyderabad and Lucknow", detail: "Gold and silver wire couched onto silk over a wooden frame.", craftImage: "zardozi", href: "/craft-explorer" }
          ]
        }
      },
      {
        type: "RESEARCH_SHOWCASE",
        label: "Research areas",
        overrides: {
          heading: "What we study",
          body: "Each area brings a different method to the same question: how a practice survives contact with the present.",
          mode: "featured",
          limit: 3,
          ids: [],
          ctaLabel: "All research areas",
          ctaHref: "/research"
        }
      },
      {
        type: "PROJECT_SHOWCASE",
        label: "Current projects",
        overrides: {
          heading: "Work in progress",
          mode: "latest",
          limit: 3,
          ids: [],
          ctaLabel: "All projects",
          ctaHref: "/projects"
        }
      },
      {
        type: "NEWS_SHOWCASE",
        label: "From the newsroom",
        overrides: { heading: "Latest", mode: "latest", limit: 3, ids: [], ctaLabel: "Newsroom", ctaHref: "/news" }
      },
      {
        type: "EVENT_SHOWCASE",
        label: "Upcoming events",
        overrides: { heading: "What is on", mode: "latest", limit: 3, ids: [], ctaLabel: "All events", ctaHref: "/events" }
      },
      {
        type: "CTA",
        label: "The closing invitation",
        overrides: {
          heading: "There is a craft near you that nobody has recorded",
          body: "If you practise one, teach one, or know a workshop whose knowledge is not written down anywhere, we would like to hear from you. Collaboration, fieldwork and access requests all start the same way.",
          primaryCta: { label: "Write to the Centre", href: "/contact" },
          secondaryCta: { label: "Read the research", href: "/research" },
          tone: "brand"
        }
      },
      {
        type: "PARTNER_LOGOS",
        label: "Partners",
        /*
         * ⚠ "latest", NOT "manual". Manual mode with an empty `ids` list is a block that correctly
         * and permanently says "No partners to show yet" — which is the right behaviour for the
         * mode, and the wrong mode for a seeded front page. It is the one showcase on this page that
         * was still empty after the demonstration corpus wrote thirteen partners, because every
         * other block picks its records up automatically and this one was waiting to be told.
         */
        overrides: { heading: "Working with", mode: "latest", limit: 24, ids: [] }
      }
    ]
  },
  {
    slug: "about",
    title: "About the Centre",
    navLabel: "About",
    seoDescription: "The Centre's vision, mission, history, leadership and organisation.",
    /*
     * ═══════════════════════════════════════════════════════════════════════════════════════
     * ⚠ EVERY ONE OF THESE FOUR BLOCKS WAS PUBLISHING A PLACEHOLDER, AND /about IS LINKED FROM THE
     * HEADER OF EVERY PAGE ON THE SITE. What a visitor actually read, verified against the database:
     *
     *   Hero      "Replace this with the Centre's own account of why it exists."
     *   Rich text "Write the text for this section."          ← the schema's own default, published
     *   Timeline  "Add a date — Add what happened", twice     ← the schema's own default, published
     *   Leadership  nothing at all (see below)
     *
     * The first three are the same defect as the homepage's "Add a heading": an override that was
     * never written, so the studio's prompt to an editor became the institution's public account of
     * itself. They are replaced with real, if deliberately spare, copy. `pagePublishBlockers()` in
     * lib/pages.ts now refuses to publish a page in that state, so these overrides are load-bearing —
     * `--replace-pages` would leave this page unpublishable without them.
     *
     * ⚠ EDITING THIS LITERAL DOES NOT REPAIR A DATABASE THAT HAS ALREADY BEEN SEEDED — the same trap the
     * homepage's STATS block carries a longer note about, and it caught this page too. Property 2 means
     * `seedPages()` steps over an existing /about, so for three passes these overrides were the fix for a
     * FRESH install only, while the four strings above went on being served to visitors. What mends an
     * installation that already has the old rows is `repairPlaceholderProse()` further down the file,
     * asked for by name with `--repair-placeholder-prose`.
     *
     * ⚠ AND IT MENDS THREE OF THE FOUR. The Leadership block below is left exactly as the old seed wrote
     * it — `mode: "manual"` with no ids, so it publishes a heading and no people — because that is an
     * empty paragraph and a display setting rather than a placeholder, and neither is a falsehood a
     * script should overwrite on somebody's behalf. Read that pass's header for the whole rule; the short
     * version is that it may remove words a reader is reading and may not add any.
     *
     * ⚠ THE COPY BELOW IS A FRESH INSTALLATION'S FIRST DRAFT, NOT THE CENTRE'S FINAL WORDS, and it is
     * written so that leaving it alone embarrasses nobody: it describes what this software is for in
     * terms that are true of any craft-documentation centre, and it says plainly, in the page's own
     * voice, that the detail belongs to whoever runs it. That is the difference between a placeholder
     * and a starting point — a placeholder is false the moment it is published, and this is not.
     * ═══════════════════════════════════════════════════════════════════════════════════════
     */
    sections: [
      {
        type: "HERO",
        label: "Page opening",
        overrides: {
          eyebrow: "About",
          headline: "A centre built around a question",
          body: "How does a practice that was never written down survive contact with the present? Everything here — the archive, the fieldwork, the teaching and the tools — is an attempt to answer that in a way somebody can use.",
          backgroundKind: "gradient",
          alignment: "left",
          showScrollCue: false
        }
      },
      {
        type: "RICH_TEXT",
        label: "Vision and mission",
        /*
         * ⚠ THE `body` OVERRIDE IS NOW COMPULSORY, WHICH REVERSES THE OLD NOTE HERE.
         *
         * It used to read: "No `body` override: the schema's own default is a valid one-paragraph
         * placeholder saying what belongs here." That is exactly what went wrong. The default is
         * "Write the text for this section." and it went out on the Centre's About page, because a
         * default that is correct in a form is a falsehood in a document.
         *
         * The other half of that note is still true and still a trap, so it is kept: passing
         * `body: null` is what broke this block before — see the note at the top of this file. A rich
         * text body must be a Tiptap document, and the shape below is the minimum valid one.
         */
        overrides: {
          heading: "Vision and mission",
          body: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "The Centre exists to make craft knowledge legible without flattening it. A tradition held in a pair of hands cannot be preserved by describing it, but it can be recorded closely enough that a student, a policymaker or a historian a century from now can rebuild an understanding of it rather than admire a photograph."
                  }
                ]
              },
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "Three commitments follow from that, and they govern the method set out on the home page. Work is done with practitioners rather than about them. Vocabulary is recorded in the language the workshop uses, before any translation. And every published record carries its provenance, so a correction from the community it came from takes precedence over the version already in print."
                  }
                ]
              },
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "This page is where the Centre sets out its own history, governance and funding in detail. Edit it in the studio; the sections below are here to be filled in rather than admired."
                  }
                ]
              }
            ]
          }
        },
        anchor: "vision"
      },
      {
        type: "TIMELINE",
        label: "History",
        /*
         * ⚠ `entries` IS OVERRIDDEN FOR THE SAME REASON, and there is no honest way to seed it with
         * real history: a fresh installation has none, and inventing a founding date for somebody
         * else's institution would be a fabricated record rather than a placeholder.
         *
         * So the block is seeded EMPTY, and that is a considered choice rather than a shrug.
         * `TimelineSection` renders nothing at all when there are no entries, so the page simply does
         * not carry a history section until somebody writes one — which is truthful. Two rows reading
         * "Add a date — Add what happened" were not.
         *
         * The block itself is kept rather than deleted so the anchor `#history` in the shipped default
         * navigation still lands somewhere on this page, and so an editor opening the builder finds the
         * block already in place with its heading written.
         */
        overrides: { heading: "How we got here", entries: [] },
        anchor: "history"
      },
      {
        type: "PEOPLE_SHOWCASE",
        label: "Leadership",
        /*
         * ⚠ "latest", NOT "manual" — THE SAME DEFECT THE PARTNER_LOGOS BLOCK ON THE HOMEPAGE CARRIES A
         * WARNING ABOUT, sitting undetected on the About page.
         *
         * Manual mode with an empty `ids` list is a block that correctly and permanently renders "No
         * people to show yet". Correct for the mode; wrong for a seeded page, because the seed cannot
         * know the id of anybody's director. With 24 published profiles in the demonstration corpus
         * this block showed nothing, under a heading reading "Leadership", on the page a visitor opens
         * to find out who runs the place.
         *
         * `latest` fills it from the people directory in the order set there — see `personSource()` in
         * lib/sections/resolve.ts, whose ordering is `sortOrder` then name — so the first six of the
         * Centre's own arrangement appear, and an editor who wants a hand-picked six switches the mode
         * back and picks them. A block that shows the wrong six is fixable in the studio; a block that
         * shows none reads as an institution with no staff.
         *
         * ⚠ THIS IS STILL A FRESH-INSTALL FIX ONLY, AND THE ROW ON THIS DEVELOPMENT DATABASE IS STILL
         * `manual`. `repairPlaceholderProse()` looked at it and REFUSED, deliberately and on every run:
         * the two fields that differ from this literal are an empty `body` and this very `mode`, and its
         * rule is that it may take away words a reader is reading and may never add words or move a
         * setting. Switching a block from manual to latest changes what the page SHOWS — from nothing to
         * six named people — and no evidence in the row can distinguish the seed's old default from an
         * editor who chose manual and has not yet picked anybody. So it is named on that pass's report
         * every time it runs, and it is left for a person. It is not an oversight and it is not a bug in
         * the pass; it is the one block on /about where a script should stop.
         */
        overrides: {
          heading: "Leadership",
          body: "The people responsible for the Centre's research, its archive and its teaching. The full directory lists everybody, including researchers, students and visiting fellows.",
          mode: "latest",
          limit: 6,
          ids: [],
          ctaLabel: "Everyone at the Centre",
          ctaHref: "/people"
        },
        anchor: "leadership"
      }
    ]
  },
  {
    slug: "contact",
    title: "Contact",
    seoDescription: "How to reach the Centre, its departments and its people.",
    sections: [
      {
        type: "HERO",
        label: "Page opening",
        overrides: {
          eyebrow: "Contact",
          headline: "Get in touch",
          body: "General enquiries, collaboration proposals, press and admissions.",
          backgroundKind: "gradient",
          alignment: "left",
          showScrollCue: false
        }
      },
      /*
       * ⚠ TWO MORE PUBLISHED PLACEHOLDERS, ON THE PAGE PEOPLE OPEN WHEN THEY WANT TO REACH SOMEBODY.
       * Verified in the database: this page was serving "Add a line about how long a reply usually
       * takes." under the form's heading, and "Add the postal address" under "Find us". Same defect as
       * the homepage and About — an override nobody wrote, so the studio's prompt became the copy.
       */
      {
        type: "CONTACT_FORM",
        label: "Enquiry form",
        overrides: {
          heading: "Send a message",
          // Says what the form is FOR and asks for what makes it routable. It deliberately promises no
          // reply time: the placeholder invited one ("how long a reply usually takes"), and a seed that
          // invented "within two working days" would be committing an institution it knows nothing
          // about to a service level. An unkept promise on a contact page is worse than no promise.
          body: "Enquiries about collaboration, fieldwork access, teaching and the use of archive material all begin here. Say which it is and include enough detail for us to send it to the right person."
        }
      },
      {
        type: "MAP",
        label: "Where we are",
        /*
         * ⚠ `address` IS SEEDED EMPTY, NOT WITH AN ADDRESS. A seed cannot know where an institution is,
         * and a plausible invented address on a contact page is not a placeholder — it is a fabricated
         * record that a reader could act on and a courier could drive to. Empty is omitted by
         * `MapSection`, so the block shows its heading and nothing false.
         *
         * `latitude`/`longitude` are left at their schema default of 0, which is CORRECT here and was
         * checked rather than assumed: `MapSection` treats 0,0 as "no coordinates set" and draws no map
         * at all, precisely because 0,0 is a real point in the Atlantic. That is the same "0 is not a
         * value" trap as the stats block, already handled properly in that renderer.
         */
        overrides: { heading: "Find us", address: "" }
      }
    ]
  }
];

async function seedSettings(): Promise<number> {
  let written = 0;
  for (const key of SETTINGS_GROUP_KEYS) {
    const existing = await prisma.setting.findUnique({ where: { key } });
    if (existing) continue; // never overwrite an administrator's choices
    await prisma.setting.create({
      data: { key, value: SETTINGS_DEFAULTS[key] as unknown as Prisma.InputJsonValue }
    });
    written += 1;
  }
  return written;
}

async function seedNavigation(): Promise<number> {
  const existing = await prisma.navigationItem.count();
  if (existing > 0) return 0; // an edited menu is never rebuilt

  let written = 0;

  async function writeTree(nodes: NavSeed[], location: string, parentId: string | null): Promise<void> {
    for (const [index, node] of nodes.entries()) {
      const created = await prisma.navigationItem.create({
        data: {
          location,
          label: node.label,
          href: node.href,
          isExternal: node.isExternal ?? false,
          position: index,
          parentId
        }
      });
      written += 1;
      if (node.children?.length) await writeTree(node.children, location, created.id);
    }
  }

  await writeTree(DEFAULT_HEADER, "header", null);
  await writeTree(DEFAULT_FOOTER, "footer", null);
  return written;
}

/**
 * Re-apply the seeded SECTIONS to pages that already exist.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS DESTROYS EDITOR WORK, WHICH IS WHY IT IS AN EXPLICIT FLAG AND NOT A DEFAULT.
 *
 * The seed is idempotent on purpose: it creates a page that is missing and then never touches it
 * again, because an editor's homepage must not be overwritten by a deployment. That is the correct
 * behaviour and it is not changing.
 *
 * But it makes one legitimate task impossible — changing what a fresh install's pages SAY. Editing
 * `SEED_PAGES` on a database that has already been seeded does nothing at all, silently, which is
 * how somebody spends an afternoon rewriting copy that is never rendered.
 *
 * So: `npx tsx prisma/seed.ts --replace-pages` rewrites the sections of every page in `SEED_PAGES`
 * from the seed. It REFUSES under `NODE_ENV=production`, the same guard `npm run smoke` and
 * `npm run leak-check` use and for the same reason — those three are the only scripts here that
 * write over data somebody may care about.
 *
 * It replaces SECTIONS ONLY. Title, slug, status, SEO fields and publication dates are left alone,
 * because those are the fields an editor is most likely to have deliberately changed and the ones a
 * copy update has no business touching.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const REPLACE_PAGES = process.argv.includes("--replace-pages");

/** Write the demonstration corpus. Off by default — see the note at its call site. */
const WITH_CORPUS = process.argv.includes("--with-corpus");
/** Remove it again. Takes precedence: asking for both is asking for the removal. */
const PURGE_CORPUS = process.argv.includes("--purge-corpus");

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * Repair the seeded PROSE of one page. See `repairPlaceholderProse()` for the whole design.
 *
 * ⚠ THIS IS A **MODE**, NOT AN EXTRA PASS. When it is given, `main()` runs the prose repair and NOTHING
 * ELSE and exits: no settings, no navigation, no pages, no corpus, no search seeding, no administrator.
 * That is deliberate and it is the narrowness the write is worth. The one thing this invocation may
 * touch is the blocks of one page, so the one thing it does is look at them.
 *
 * ⚠ AND IT IS OPT-IN BY NAME, WHICH IS THE OPPOSITE OF THE DECISION `repairPlaceholderStats()` MADE
 * TWENTY LINES FROM HERE — read both before changing either, because the difference is the point.
 * That pass proves a FALSEHOOD from the payload alone: a figure reading "0" beside forty-two crafts is
 * wrong on its own terms, and five tests over the stored data settle it without reference to anything
 * else. Nothing keyed on prose can do that (its own header explains why at length), so this pass
 * substitutes a PROVENANCE proof — "no editor has ever saved this row" — and a provenance proof is a
 * claim about the installation's history rather than about the words on the page. A claim of that shape
 * belongs to whoever runs the command, so it is asked for by name, it prints every decision it makes,
 * and it does nothing whatever on an ordinary `npm run seed`.
 *
 *   npx tsx prisma/seed.ts --repair-placeholder-prose --dry-run   print every decision, write nothing
 *   npx tsx prisma/seed.ts --repair-placeholder-prose             do it
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const REPAIR_PROSE = process.argv.includes("--repair-placeholder-prose");

/**
 * Print what the prose repair WOULD do and write nothing.
 *
 * ⚠ ONLY MEANINGFUL BESIDE `--repair-placeholder-prose`, and it is not a general "don't write anything"
 * switch for this file. Every other pass here is an idempotent upsert with no preview to give, and a flag
 * that silently did nothing on `npm run seed --dry-run` would be a worse lie than no flag at all. Given
 * on its own it is REFUSED below rather than ignored, because a run that was asked to write nothing and
 * then seeded a database would be exactly the surprise this flag exists to prevent.
 */
const DRY_RUN = process.argv.includes("--dry-run");

/** `{ crafts: 26, people: 20 }` → `"26 crafts, 20 people"`. Sorted biggest first, so the eye lands right. */
function describeCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([key, n]) => `${n} ${key}`)
    .join(", ");
}

if (REPLACE_PAGES && process.env.NODE_ENV === "production") {
  throw new Error(
    "--replace-pages overwrites the sections of every seeded page and refuses to run with " +
      "NODE_ENV=production. If you genuinely mean to reset a production homepage, do it in the studio."
  );
}

/*
 * ⚠ THE SAME GUARD, AND FOR A WEAKER REASON THAN `--replace-pages` HAS — which is why it is a separate
 * check with its own sentence rather than a slug added to the condition above.
 *
 * `--replace-pages` refuses in production because it certainly destroys editor work. This pass refuses
 * because it CANNOT PROVE IT DOES NOT: its whole safety argument is that `updatedAt === createdAt` means
 * nobody has saved the block, and that argument is only as good as the assumption that this database's
 * history is the one this checkout can see. On a production installation that has been migrated, restored
 * from a dump, or copied between environments, a row's timestamps may have been rewritten by something
 * other than an editor, and the proof quietly stops being a proof. A development database is where that
 * assumption is safe and where the operator can look at the page afterwards.
 */
if (REPAIR_PROSE && process.env.NODE_ENV === "production") {
  throw new Error(
    "--repair-placeholder-prose rewrites the stored prose of a seeded page and refuses to run with " +
      "NODE_ENV=production. Its safety argument rests on row timestamps proving nobody has edited the " +
      "block, and a production row's history may have been rewritten by a restore rather than by an " +
      "editor. Fix the page on its Content tab in the studio instead."
  );
}

if (DRY_RUN && !REPAIR_PROSE) {
  throw new Error(
    "--dry-run only describes --repair-placeholder-prose, and on its own it would be a promise this " +
      "script cannot keep: every other pass here is an idempotent upsert with nothing to preview, so a " +
      "run accepting this flag alone would go on and seed the database. Add " +
      "--repair-placeholder-prose, or drop --dry-run."
  );
}

async function seedPages(): Promise<{ pages: number; sections: number }> {
  let pages = 0;
  let sections = 0;

  for (const seed of SEED_PAGES) {
    const existing = await prisma.page.findUnique({ where: { slug: seed.slug } });
    if (existing) {
      // The page is here. Make sure it is still marked structural — that flag is the only thing
      // stopping someone deleting the homepage — but touch nothing else.
      if (!existing.isSystem) {
        await prisma.page.update({ where: { id: existing.id }, data: { isSystem: true } });
      }

      if (REPLACE_PAGES && seed.sections.length > 0) {
        /*
         * One transaction, delete-then-create. `@@unique([pageId, position])` means an update in
         * place would collide the moment the new arrangement is a different length or order —
         * position 3 cannot be written while the old position 3 still exists — and working around
         * that with a two-pass renumber is three times the code for a path that only ever runs by
         * hand on a development database.
         */
        await prisma.$transaction([
          prisma.pageSection.deleteMany({ where: { pageId: existing.id } }),
          prisma.pageSection.createMany({
            data: seed.sections.map((section, index) => ({
              pageId: existing.id,
              type: section.type,
              label: section.label,
              position: index,
              data: buildSectionData(section)
            }))
          })
        ]);
        pages += 1;
        sections += seed.sections.length;
      }

      continue;
    }

    const page = await prisma.page.create({
      data: {
        slug: seed.slug,
        title: seed.title,
        navLabel: seed.navLabel ?? null,
        seoDescription: seed.seoDescription,
        isSystem: true,
        // PUBLISHED, not DRAFT. A fresh installation whose homepage 404s looks broken rather than
        // new, and the placeholder copy above says plainly that it is placeholder copy.
        status: "PUBLISHED",
        publishedAt: new Date()
      }
    });
    pages += 1;

    if (seed.sections.length > 0) {
      await prisma.pageSection.createMany({
        data: seed.sections.map((section, index) => ({
          pageId: page.id,
          type: section.type,
          label: section.label,
          position: index,
          data: buildSectionData(section)
        }))
      });
      sections += seed.sections.length;
    }
  }

  return { pages, sections };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The repair pass
//
// ⚠ THE ONE PLACE THIS FILE REWRITES CONTENT ON AN INSTALLATION THAT HAS ALREADY BEEN SEEDED, AND WHY
// PROPERTY 2 SURVIVES IT.
//
// The problem it exists for is not hypothetical; it is the defect this whole census mechanism was built to
// remove, and correcting `SEED_PAGES` did not remove it. The homepage of every installation seeded before
// the census landed stores, verbatim:
//
//     heading: "Add a heading"
//     items:   four figures, value "0", NO `metric` key at all
//     source:  "Figures update as records are published."
//
// — and renders "Add a heading / 0 Crafts documented / 0 Field records / 0 Publications / 0 Partner
// institutions / Figures update as records are published." beside a database holding 42 crafts, 24 people,
// 30 publications and 13 partners. Four false statements under a caption promising they are live, plus the
// studio's own prompt as the institution's public heading.
//
// NOTHING ELSE IN THE PRODUCT REPAIRS IT, and each of the three things that look as though they might have
// been checked rather than assumed:
//
//   • `seedPages()` above steps over an existing page by design (property 2), so editing `SEED_PAGES`
//     changes fresh installations only;
//   • `pagePublishBlockers()` refuses the CROSSING into publication. This page was created PUBLISHED and
//     has never crossed anything, so it is grandfathered — deliberately, because a rule keyed on "is
//     published" would lock an editor out of a form that cannot fix the blocks it names;
//   • `lib/health.ts` NAMES the block on a report, which requires somebody to open the report.
//
// So the row has to be written, and `--replace-pages` is the wrong instrument: it deletes and recreates
// every section of every seeded page, losing per-block revision history and any editor's work on all three.
//
// ⚠ HOW THIS STAYS NON-DESTRUCTIVE — the conditions are the whole design, not a safety net bolted on.
// `unrepairedStatsReason()` below refuses unless the stored block PROVES nobody has authored it, and every
// one of its five tests is there because a real editor state would otherwise be destroyed:
//
//   1. the payload must PARSE. A block whose settings are broken is one the studio's own repair path is
//      showing to an editor for correction, and overwriting it would delete what they are looking at;
//   2. the heading must still be one of the studio's own prompt strings, taken from
//      `sectionPlaceholderPrompts("STATS")` rather than typed here — so a heading anybody has written,
//      including a deliberately empty one, stops the repair dead;
//   3. no figure may already name a `metric`. If one does, an editor has met the census and made choices
//      in it, and those choices are theirs;
//   4. every figure's value must be blank or a bare nought. ⚠ THIS IS WHAT KEEPS THE REPAIR OFF A BLOCK
//      SOMEBODY DROPPED INTO THE BUILDER THIS MORNING: a fresh STATS block from `SECTION_PLACEHOLDERS`
//      carries three figures reading "Add a figure", which fails this test, so a new empty stats block on
//      any page can never be silently filled with the homepage's corpus figures;
//   5. and at least one of them must actually BE a nought. A block of blank figures publishes nothing and
//      states nothing false; there is no falsehood in it to repair, only an editor's unfinished work.
//
// The payload written is `buildSectionData()` over the homepage's own STATS entry in `SEED_PAGES` — the
// literal above, validated by the same function and the same schema as a fresh install, never a second copy
// of the copy. `mergeSectionData` carries the block's `anchor` across, because an anchor is addressing that
// a menu entry may already quote and it lives outside every section schema (lib/sections/anchor.ts).
//
// ⚠ WHAT IT DELIBERATELY DOES NOT REPAIR, so nobody reads a clean run as a clean database. A block that
// fails any test above is reported by name with the reason and left exactly as it is. And this pass covers
// ONE BLOCK TYPE ON ONE PAGE. The prose that used to be listed here is now the business of
// `repairPlaceholderProse()` further down the file, and the reasoning below is why these are two passes
// rather than one:
//
//   • a nought is a false STATEMENT OF FACT — it says "there is none of this" about forty-two crafts — and
//     the five tests above can prove the seed itself wrote it. Repairing it removes a falsehood;
//   • a prompt in a text block is an UNFINISHED sentence. Publishing it is embarrassing rather than untrue,
//     and the same tests cannot be built: there is no equivalent of "every figure is a nought" for a
//     paragraph, so a repair keyed on the prompt string alone would overwrite a block somebody had half
//     written, in a field where half written is the normal state of a first draft.
//
// ⚠ THAT SECOND BULLET IS STILL TRUE AND THE PROSE PASS DOES NOT CONTRADICT IT — it is keyed on PROVENANCE
// ("has any human ever saved this row", which the timestamps answer exactly) and not on the prompt string,
// which is the one thing this paragraph says cannot be done. Read its header before assuming either pass
// generalises to the other.
//
// ⚠ AND THE EXTENSION THIS PARAGRAPH USED TO PRESCRIBE WAS MEASURED AND IS WRONG, which is recorded here
// because it is the obvious idea and somebody will have it again. It read: "The honest extension … is a
// payload BYTE-IDENTICAL to `defaultSectionData(type)` — the same 'nobody has touched this block at all'
// predicate `lib/health.ts` already applies as its `bare` test." Two errors in one sentence:
//
//   • it matches NOTHING. Checked against all four of /about's blocks: every one of them carries the
//     seed's own overrides on top of the schema defaults, so none is byte-identical to `defaultSectionData`
//     and none ever was. For two of them it was not even reachable, because the SCHEMA HAD DRIFTED since
//     the rows were written — the HERO row held the `primaryCta` prompt that had since been removed from
//     the placeholder table, and the RICH_TEXT row had no `typeset` key at all. (`repairPlaceholderProse()`
//     has since rewritten both rows on this database, so the drift is no longer visible in them; the
//     argument is what is being recorded, not their current contents.) A test defeated by its own
//     schema's evolution answers "leave everything alone" for ever, on precisely the old rows it is for;
//   • `lib/health.ts`'s `bare` is NOT that predicate. It is `parseSectionData(type, {})` — every field at
//     its schema default with NO seed applied — and its own comment says so: "a block whose text has been
//     cleared away entirely rather than never written". `defaultSectionData(type)` is the opposite state,
//     the seeded placeholder. Naming one as the other is how the idea looked already-proven.
//
// `defaultSectionData` still earns a place in the prose pass, but PER FIELD and only to answer "is this key
// simply missing from a row older than the schema" — the one question it can settle soundly.
//
// It is NOT flag-gated, and that is a decision rather than an oversight. A repair nobody runs is how this
// defect survived two passes that both knew about it; the conditions above are what make running it safe,
// and every action and every refusal is printed.
//
// ⚠ `repairPlaceholderProse()` MAKES THE OPPOSITE CHOICE AND BOTH ARE RIGHT, which is worth a line here so
// the inconsistency is not read as drift. This pass is unconditional because its five tests prove a
// FALSEHOOD from the stored payload alone — no knowledge of the installation's history is needed, so there
// is nothing for an operator to consent to. The prose pass proves instead that no human has ever saved the
// row, which is a claim about this database's past rather than about its contents, and a claim of that
// shape can be wrong in ways the data cannot show (a restore, a dump reloaded, an environment copied). So
// it is asked for by name. The difference is what is being proved, not how much either is trusted.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A figure that says nothing but says it as a statistic: "0", "00", "0.0", "0,0". */
const BARE_NOUGHT = /^0+(?:[.,]0+)?$/;

/**
 * JSON with every object's keys sorted, for comparing a payload against a stored row.
 *
 * ⚠ A PLAIN `JSON.stringify` COMPARISON IS ALWAYS UNEQUAL HERE, and it looked right until it was run.
 * `PageSection.data` is a Postgres **jsonb** column, which normalises key order on the way in — shortest
 * key first, then bytewise — so a row written as `{eyebrow, heading, items, countUp, source}` reads back as
 * `{items, source, countUp, eyebrow, heading}`. Comparing the two textually therefore reported "different"
 * for a row that was byte-identical in meaning, and the skip that depends on it never fired. Sorting both
 * sides is what makes the question askable at all.
 *
 * ⚠ THERE IS A SECOND `stableJson` IN THE TREE AND THIS IS A STATED COPY, NOT A HIDDEN ONE — BUT THE TWIN
 * HAS MOVED SINCE THIS NOTE WAS WRITTEN. It was `lib/health.ts`'s, over a `sortKeysDeep` helper; that copy
 * and that helper are both GONE (grep `sortKeysDeep`: nothing in the tree DEFINES it, only prose — this
 * note and health.ts's ⚠ at :237, which records where it went). The twin now lives in `lib/utils.ts:170`,
 * exported, and lib/health.ts imports it from there. So the shared home this note asked for exists, and
 * consolidating this copy is
 * one import plus a deletion — this file ALREADY imports `truncateWords` from `../lib/utils` at the top,
 * which is a module that imports nothing and is therefore safe from a plain `tsx` process. It is left
 * standing here rather than merged because that merge would also have to correct `lib/utils.ts`'s own ⚠
 * note, which currently records this copy as outstanding, and this pass does not own that file.
 *
 * ⚠ AND THE TWO COPIES DO NOT SORT THE SAME WAY, WHICH IS THE PART WORTH KNOWING BEFORE MERGING THEM. This
 * one sorts with `localeCompare`; `lib/utils.ts`'s sorts by CODE UNIT (`Number(a > b) - Number(a < b)`) and
 * its header explains why at length: `localeCompare` reads the runtime's default locale, so THIS function's
 * output is environment-dependent and that one's is not. Two "stable" serialisers that disagree about key
 * order produce different strings for the same document, so a string from one must never be compared
 * against a string from the other.
 *
 * ⚠ THAT IS LATENT RATHER THAN LIVE TODAY, and measuring it is what makes the difference between a trap and
 * a scare. Every comparison in this file runs BOTH sides through THIS function, so its answers are sound
 * whatever the locale; nothing here is persisted or compared across processes. And measured over all 92
 * distinct keys in every `PageSection.data` row of the development database, the two comparators disagree on
 * NO pair — the payload keys are all lower-case camelCase, where the orders coincide. They part company as
 * soon as one is not: for `"Body"` and `"anchor"`, code-unit order puts `"Body"` first (`B` is 0x42, `a` is
 * 0x61) and `localeCompare` puts `"anchor"` first. Deliberately the SAME NAME as the twin, so anybody
 * grepping finds both rather than two helpers that look unrelated.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
        )
      : entry
  );
}

/**
 * Why this stored STATS payload must be left alone, or `null` when it is the shipped falsehood.
 *
 * A REASON RATHER THAN A BOOLEAN, so the run can say which test refused and an operator never has to guess
 * whether a block was skipped or missed. The reasons are written to be read by whoever runs the seed.
 */
function unrepairedStatsReason(raw: unknown): string | null {
  const parsed = parseSectionData("STATS", raw);
  if (!parsed.ok) return `its stored settings do not parse (${parsed.message}) — the studio is showing them to an editor for repair`;

  const data = parsed.data as StatsSectionData;

  const prompts = new Set(sectionPlaceholderPrompts("STATS").map((prompt) => prompt.trim()));
  if (!prompts.has(data.heading.trim())) {
    // "real copy" rather than "somebody's own words": on a fresh install the words are this SEED's, and a
    // line telling an operator that somebody has been editing a page created ten seconds ago would be a
    // small untruth in the pass that exists to remove one. (The common case of that is skipped silently
    // anyway — see the note in `repairPlaceholderStats`.)
    return `its heading is real copy (${JSON.stringify(data.heading)}), not the studio's prompt`;
  }

  if (data.items.length === 0) return "it has no figures in it at all";
  if (data.items.some((item) => item.metric !== "")) {
    return "one of its figures already counts from the site, so an editor has been in the census";
  }
  const values = data.items.map((item) => item.value.trim());
  const typed = values.filter((value) => value.length > 0 && !BARE_NOUGHT.test(value));
  if (typed.length > 0) {
    // Deliberately covers BOTH "somebody typed a real figure" and "this block is three days old and still
    // says Add a figure": the two are indistinguishable from here, and both mean the block is not the
    // shipped falsehood this pass repairs. Naming both keeps the printed reason honest in either case.
    return (
      `it carries figures that are not noughts (${typed.map((value) => JSON.stringify(value)).join(", ")}), ` +
      "so they are either somebody's own or still the studio's own prompt"
    );
  }
  if (!values.some((value) => BARE_NOUGHT.test(value))) {
    return "its figures are all blank, so it publishes nothing false — only unfinished work";
  }

  return null;
}

/**
 * Rewrite a homepage STATS block that is still publishing the four noughts under the studio's own prompt.
 *
 * Returns the number of rows written — 0 on a fresh install (the page was just created correct), 0 on an
 * installation an editor has looked after, and 1 on one carrying the old row.
 *
 * ⚠ THE SEARCH INDEX IS REWRITTEN FOR THE SAME PAGE, THROUGH THE CANONICAL BUILDER, and that is not the
 * thing "The search index" below refuses to do. That refusal is about this file's SIMPLIFIED copy of the
 * document builder never overwriting a row the real one wrote. Here the page's own words have just changed,
 * so its index row holds the placeholder this pass exists to delete — `searchDocFromPage` +
 * `indexDocument` are the same two functions the studio calls when an editor saves a page, so the row is
 * rebuilt by the authority rather than by the copy. Without this, "Add a heading" survives in the site's own
 * search corpus and the block's new labels are absent from it.
 */
async function repairPlaceholderStats(): Promise<number> {
  const homepage = SEED_PAGES.find((seed) => seed.slug === "");
  const seededStats = homepage?.sections.filter((section) => section.type === "STATS") ?? [];
  // Destructured rather than indexed because `noUncheckedIndexedAccess` is on in this project's tsconfig,
  // and the honest way to satisfy it is a guard rather than a `!` that outlives the reason for it.
  const [seeded, ...spareSeeds] = seededStats;
  if (!seeded || spareSeeds.length > 0) {
    // Not a data problem, a SEED problem: this pass writes one specific block and cannot guess which of
    // two it means. Loud, because the repair silently stopping happening is the failure mode.
    console.warn(
      `  ⚠ The figures repair did not run: the seeded homepage defines ${seededStats.length} STATS blocks ` +
        "and this pass only knows how to repair one. Give it the label to match on before adding a second."
    );
    return 0;
  }

  const page = await prisma.page.findUnique({
    where: { slug: "" },
    select: {
      id: true,
      slug: true,
      title: true,
      navLabel: true,
      seoDescription: true,
      seoNoIndex: true,
      status: true,
      publishedAt: true,
      publishAt: true,
      unpublishAt: true,
      deletedAt: true,
      sections: {
        where: { type: "STATS" },
        orderBy: { position: "asc" },
        select: { id: true, label: true, isVisible: true, data: true }
      }
    }
  });
  if (!page || page.sections.length === 0) return 0;

  const payload = buildSectionData(seeded);

  const repairable: typeof page.sections = [];
  for (const section of page.sections) {
    /*
     * ⚠ THE ONE SILENT SKIP, AND IT IS THE COMMON CASE. A row that is ALREADY byte for byte what this pass
     * would write needs neither a repair nor a sentence about one — and that is exactly the state of a
     * FRESH install, where `seedPages()` created the block from this same literal moments ago. Without this
     * every first-ever seed would print "left alone: its heading is real copy", which is true and reads as
     * a warning about a page that has just been created correctly.
     *
     * The comparison is against the MERGED payload rather than the raw one, so a block carrying an anchor
     * still matches: `mergeSectionData` is what the write below applies, so this asks precisely "would the
     * write change anything". `stableJson` rather than `JSON.stringify` because the column is jsonb — see
     * its own note, which records the version of this line that could never match.
     */
    if (stableJson(section.data) === stableJson(mergeSectionData(section.data, payload))) continue;

    const reason = unrepairedStatsReason(section.data);
    if (reason === null) {
      repairable.push(section);
      continue;
    }
    // Every other refusal is printed. A silent skip is indistinguishable from a repair that never ran,
    // which is exactly the state this pass exists to end.
    console.log(`  Figures block ${JSON.stringify(section.label ?? "(unlabelled)")} left alone: ${reason}.`);
  }

  const [target, ...alsoRepairable] = repairable;
  if (!target) return 0;
  if (alsoRepairable.length > 0) {
    console.warn(
      `  ⚠ The figures repair did not run: ${repairable.length} STATS blocks on the homepage are all still ` +
        "publishing the studio's prompt over noughts, and writing the same seeded figures into every one of " +
        "them would produce a page repeating itself. Fix one in the studio and re-run."
    );
    return 0;
  }

  await prisma.pageSection.update({
    where: { id: target.id },
    // `mergeSectionData` for the anchor, then back to `InputJsonValue` — the same round trip every block
    // save in the studio makes, and the cast is the one Prisma requires for a `Json` column.
    data: { data: mergeSectionData(target.data, payload) as Prisma.InputJsonValue }
  });

  console.log(
    `  Repaired the homepage figures block ${JSON.stringify(target.label ?? "(unlabelled)")}: it was still ` +
      "publishing the studio's prompt heading over hand-typed noughts. It now counts from the site's own " +
      "records" +
      (target.isVisible ? "." : " (the block is switched off, so nothing was visible either way).")
  );

  const reindexed = await prisma.page.findUnique({
    where: { id: page.id },
    select: {
      id: true,
      slug: true,
      title: true,
      navLabel: true,
      seoDescription: true,
      seoNoIndex: true,
      status: true,
      publishedAt: true,
      publishAt: true,
      unpublishAt: true,
      deletedAt: true,
      sections: { orderBy: { position: "asc" }, select: { isVisible: true, data: true } }
    }
  });
  if (reindexed) {
    await indexDocument(prisma, searchDocFromPage(reindexed));
    console.log("  The homepage's own search entry was rebuilt, so the prompt is gone from search as well.");
  }

  return 1;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The search index
//
// ⚠ A DELIBERATE, NARROW COPY OF lib/search/index.ts, WHICH OWNS THE CANONICAL BUILDER.
//
// The seeded pages are created PUBLISHED. Until they are indexed, a fresh installation cannot find its own
// Home, About or Contact page in its own search: somebody types "contact", gets nothing, and concludes the
// site is empty — and it stays that way until each page happens to be re-saved in the studio.
//
// Every other writer in the product calls `searchDocFromPage` and `indexDocument` from lib/search/index.ts.
//
// ⚠ THE REASON GIVEN HERE FOR NOT DOING THAT WAS WRONG, AND THE REAL REASON IS DIFFERENT AND NARROWER.
// It used to read: "That module begins with `import "server-only"`, a package that exists only inside
// Next's bundler, so a plain `tsx` script cannot resolve it and the seed would die with
// ERR_MODULE_NOT_FOUND before writing anything. (Checked, not assumed.)" The first clause is true — it
// does begin with that import — and the conclusion does not follow: this file already imports
// `reindexAll` from that very module at the top, and it resolves. See the note there for exactly why,
// and for the clean-install exposure that note now records.
//
// Removing that guard was never an option either way. `import "server-only"` is what stops a module
// holding database credentials and signing secrets being dragged into a browser bundle by one careless
// import in a client component. A convenience in a seed script does not buy that risk.
//
// WHAT ACTUALLY JUSTIFIES THE COPY IS THE FOURTH BULLET BELOW, AND ONLY THAT: `indexDocument()` is an
// `upsert`, so calling it here would OVERWRITE the index row of every page it touches with this
// simplified document. That is precisely what the seed must not do — a row written by the canonical
// builder is a better answer than one written here, and overwriting it would also break property 2 of
// this file (never update a row a human may have edited). A narrow, stated copy is the price of that
// guarantee; the other three bullets explain how the copy is kept honest rather than why it exists.
//
// So the rows are written directly, in the SAME SHAPE, and the duplication is stated rather than hidden:
//
//   • the fields, the caps, the URL rule and the "no-index means not in our search either" rule below mirror
//     `upsertArgs` and `searchDocFromPage`;
//   • `isLive` and `richTextToPlainText` are imported from the real modules, so the two rules most likely to
//     drift — what counts as published, and how stored rich text becomes words — are not copied at all;
//   • NOTHING EXISTING IS OVERWRITTEN. A page that already has an index row is left alone: that row was
//     written by the canonical builder, and this simplified one must never replace a better answer. It is
//     also what keeps the seed non-destructive on a database somebody has been editing;
//   • `reindexAll()` (app/api/studio/reindex) remains authoritative. If the two ever disagree, running it
//     replaces everything here with the real thing.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Mirrors lib/search/index.ts. The body is a search corpus and is never rendered, so a mid-word cut is fine. */
const MAX_BODY_CHARS = 20_000;
const MAX_SUMMARY_CHARS = 320;

/**
 * The keys inside a section payload that hold prose. Mirrors `SECTION_TEXT_KEYS`.
 *
 * An allowlist rather than every string in the JSON: a blanket walk sweeps in ids, storage keys, hex colours,
 * icon names and web addresses, none of which anybody will ever type into a search box.
 */
const SECTION_TEXT_KEYS = new Set([
  "heading",
  "title",
  "subtitle",
  "eyebrow",
  "text",
  "body",
  "summary",
  "description",
  "caption",
  "quote",
  "attribution",
  "question",
  "answer",
  "name",
  "role"
]);

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function collectSectionText(value: unknown, out: string[], depth = 0): void {
  if (depth > 8 || out.length > 400) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectSectionText(entry, out, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  // Stored rich text goes through the real renderer. The key allowlist alone would collect the node names
  // ("paragraph", "heading") and none of the words inside them.
  if (record.type === "doc" && Array.isArray(record.content)) {
    // Cast from the wider `value`, not from `record`: `Record<string, unknown>` has no `type` property to
    // TypeScript's eye, so the narrowed alias is the one it will not convert without a second hop.
    const asText = richTextToPlainText(value as Parameters<typeof richTextToPlainText>[0]);
    if (typeof asText === "string") out.push(collapse(asText));
    return;
  }
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") {
      if (SECTION_TEXT_KEYS.has(key)) out.push(entry);
      continue;
    }
    collectSectionText(entry, out, depth + 1);
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * THE STUDIO'S OWN PROMPT TEXT, LONGEST FIRST — the vocabulary `allPlaceholderPrompts()` was written for.
 *
 * ⚠ THIS IS THE ONE CHECK IN THE PRODUCT THAT HAS A PAGE'S **TEXT** AND NO IDEA WHICH BLOCKS PRODUCED IT,
 * which is exactly the situation that function's own header describes. Every other placeholder check in the
 * building asks the question PER BLOCK, against a whole field: `pagePublishBlockers()` in lib/pages.ts
 * through `placeholderPromptsIn()`, `judgementFor()` in lib/health.ts through `sectionPlaceholderPrompts()`
 * (it re-derived a narrower list of its own until it was made to import that one — the header on
 * `PLACEHOLDER_PROMPT_PATTERN` records what the one missing string cost), and
 * `unrepairedStatsReason()` above through `sectionPlaceholderPrompts("STATS")`. Here the text has already
 * been flattened by `sectionsToPlainText()` — a key allowlist over every block on the page, joined with
 * spaces — so the block boundaries are gone and only a substring test is possible.
 *
 * WHY THE INDEX IS WORTH CHECKING SEPARATELY AT ALL, rather than trusting the publish gate. The gate fires
 * on the CROSSING into publication (lib/pages.ts says so at length), and these pages do not cross: this
 * file creates them PUBLISHED and they stay PUBLISHED. So a placeholder that was already in a page row
 * before the gate existed is grandfathered on the page AND, without this, is copied word for word into the
 * site's own search corpus — where a prompt becomes a search RESULT, on a surface no editor ever opens and
 * no report covers. ⚠ MEASURED ON THIS DEVELOPMENT DATABASE, so this is a live path and not a guard: the
 * next run reports `/contact` for "Add a line about how long a reply usually takes.".
 *
 * ⚠ THE OTHER TWO PAGES USED TO BE ON THAT LINE AND HAVE BEEN MENDED, WHICH IS WHY THE LIST IS NOW ONE
 * ENTRY LONG RATHER THAN THREE — re-measured after each repair, not assumed. The homepage went first
 * (`repairPlaceholderStats()`), and /about followed (`repairPlaceholderProse()`), which also rebuilt that
 * page's search row through the canonical builder: querying the corpus for the exact phrase "Write the
 * text for this section." now returns nothing, where it used to return the Centre's own About page.
 * `/contact` remains, and remains deliberately: its two strings are stored on blocks that the static route
 * at app/(site)/contact/page.tsx SHADOWS and never renders, so they reach this corpus and no reader. That
 * makes it a search-index defect rather than a published one, and rewriting the prose of a page nobody
 * renders is the wrong fix for it.
 *
 * ⚠ IT WARNS AND INDEXES ANYWAY, AND THAT IS THE POINT RATHER THAN A COMPROMISE. Withholding the document
 * would make a real published page unfindable in its own site's search — filtering the symptom downstream,
 * and a worse failure than the one being reported, because an index that disagrees with the page is
 * undiagnosable from either end. The root fixes are the publish gate (for the next one),
 * `repairPlaceholderStats()` and `repairPlaceholderProse()` (for the rows this file knows how to mend) and
 * an editor (for the rest). This is the loud, honest report that those four exist.
 *
 * ⚠ SUBSTRING, AND SAFE — for the one reason the header in lib/sections/schema.ts sets out. The strings
 * matched are WHOLE prompts ("Write the text for this section."), never the leading verb, so the seeded
 * homepage's CTA button "Write to the Centre" cannot match one and no amount of finished copy beginning
 * with "Add" or "Write" can either. A pattern test here would report the site's own front page for ever.
 *
 * ⚠ IT IS A SUBSET OF WHAT THE PUBLISH GATE WOULD FIND, AND SAYING SO IS THE DIFFERENCE BETWEEN A LIMIT AND
 * A LIE. `sectionsToPlainText()` collects only the keys in `SECTION_TEXT_KEYS` above, so a prompt stored
 * under any other key is invisible here. Measured against this development database: `/contact` is
 * reported for "Add a line about how long a reply usually takes.", while its MAP block also holds "Add the
 * postal address" — a key the allowlist does not collect — and that one is NOT reported. ⚠ THE SAME GAP
 * SHOWED UP INSIDE `repairPlaceholderProse()` BELOW and is recorded there too: /about's timeline rows
 * rendered "Add a date" out of `year`, which this allowlist does not collect either, so the flattened text
 * never carried it even while a visitor was reading it. Widening the allowlist is a change to what the
 * search corpus contains and belongs with lib/search, which this file only mirrors. That is correct rather
 * than a miss for THIS check:
 * this check answers "what is about to enter the search corpus", and a prompt the corpus does not carry
 * cannot become a search result. `pagePublishBlockers()` in lib/pages.ts is the check that walks the RAW
 * payload and sees everything; `lib/health.ts` is the report that lists it. Do not let this one grow into a
 * third, weaker copy of either — it exists because the flattened text is a surface neither of them reads.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 */
const PLACEHOLDER_PROMPTS = allPlaceholderPrompts();

/**
 * The prompts a page's flattened text is still carrying.
 *
 * `PLACEHOLDER_PROMPTS` arrives longest-first, so a prompt that is a fragment of one already reported is
 * dropped — a report that counted one field as two would send an editor looking for a second field that does
 * not exist.
 *
 * ⚠ THAT SECOND `continue` IS A GUARD RATHER THAN A LIVE PATH TODAY, and saying which is the honest version:
 * measured over the 45 strings, NO prompt is currently a substring of another, so nothing reaches it. It is
 * kept because the vocabulary is derived from `SECTION_PLACEHOLDERS` and the day somebody writes a prompt
 * that extends an existing one, the ordering is already in place to make the longer one win — which is the
 * property `allPlaceholderPrompts()` sorts for and would otherwise be sorted for nobody.
 */
function promptsInIndexedText(text: string): string[] {
  const carried: string[] = [];
  for (const prompt of PLACEHOLDER_PROMPTS) {
    if (!text.includes(prompt)) continue;
    if (carried.some((longer) => longer.includes(prompt))) continue;
    carried.push(prompt);
  }
  return carried;
}

function sectionsToPlainText(
  sections: ReadonlyArray<{ isVisible: boolean; data: unknown }>
): string {
  const out: string[] = [];
  for (const section of sections) {
    // A hidden block is not on the page, so matching it would send a reader somewhere the words they
    // searched for do not appear.
    if (!section.isVisible) continue;
    collectSectionText(section.data, out);
  }
  return collapse(out.join(" "));
}

/**
 * Put the seeded pages into the search index, and leave every page that is already there alone.
 *
 * Reads each page back FROM THE DATABASE rather than building from the seed literals above, so a page an
 * editor has already rewritten is indexed as it now stands and not as it was first written.
 */
async function seedSearchIndex(): Promise<number> {
  const now = new Date();
  let written = 0;

  for (const seed of SEED_PAGES) {
    const page = await prisma.page.findUnique({
      where: { slug: seed.slug },
      select: {
        id: true,
        slug: true,
        title: true,
        navLabel: true,
        seoDescription: true,
        seoNoIndex: true,
        status: true,
        publishedAt: true,
        publishAt: true,
        unpublishAt: true,
        deletedAt: true,
        sections: { select: { isVisible: true, data: true } }
      }
    });
    // `seedPages` created or found this page moments ago, so the only way it is missing is a deletion in
    // between. Nothing to index, and nothing worth stopping a seed for.
    if (!page) continue;

    const summary = collapse(page.seoDescription ?? "");
    const body = collapse(
      [page.navLabel, page.seoDescription, sectionsToPlainText(page.sections)]
        .filter((part): part is string => Boolean(part && part.trim()))
        .join(" ")
    );

    /*
     * ⚠ CHECKED BEFORE THE "already indexed" SHORT-CIRCUIT BELOW, AND THE ORDER IS THE WHOLE VALUE OF THE
     * CHECK. The report is about the PAGE's words, not about whether this run happens to write an index
     * row — and the rows that carry a placeholder are exactly the OLD ones, which already have a search
     * document, so a check placed after the skip could never see the only pages it is for. Three pages and
     * three payloads: building the text for a page that is not about to be re-indexed costs nothing.
     *
     * The title is included as well as the body: it is a column rather than a block, so no prompt should
     * ever be in it, and a check that could not have told us so would be worth less than one that can.
     *
     * The full `body` is tested rather than the truncated copy written below — a prompt past
     * `MAX_BODY_CHARS` is still on the page, and reporting only what happens to fit in the index row would
     * make the warning quieter the longer the page got.
     */
    const carried = promptsInIndexedText(`${page.title} ${body}`);
    if (carried.length > 0) {
      console.warn(
        `  ⚠ ${page.slug.length === 0 ? "/" : `/${page.slug}`} is on the site carrying words the studio put ` +
          `there as a prompt: ${carried.map((prompt) => JSON.stringify(prompt)).join(", ")}.\n` +
          "    They are indexed exactly as they stand, because a search entry that disagrees with the page " +
          "is worse than one that repeats it.\n" +
          "    Replace them on the page's Content tab in the studio.\n" +
          "    (`--repair-placeholder-prose` mends a seeded page's prompts where it can prove no editor " +
          "has ever saved\n" +
          "     the block — run it with --dry-run first. `--replace-pages` would also do it, and destroys " +
          "editor work on\n" +
          "     every seeded page — read either one's own note before reaching for it.)"
      );
    }

    const existing = await prisma.searchDocument.findUnique({
      where: { entityType_entityId: { entityType: "page", entityId: page.id } },
      select: { id: true }
    });
    if (existing) continue;

    await prisma.searchDocument.create({
      data: {
        entityType: "page",
        entityId: page.id,
        title: collapse(page.title) || "Untitled page",
        summary: summary.length > 0 ? truncateWords(summary, MAX_SUMMARY_CHARS) : null,
        body: body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body,
        // The homepage's slug is the empty string, which would otherwise build the address "/".
        url: page.slug.length === 0 ? "/" : `/${page.slug.replace(/^\/+/, "")}`,
        keywords: [],
        // A page an editor has asked search engines to skip is not a destination in the site's own search
        // either — the intent is "this is not a place to land", and it does not stop at Google.
        isPublished: isLive(page, now) && page.seoNoIndex !== true
      }
    });
    written += 1;
  }

  return written;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The prose repair pass — /about
//
// ⚠ THE SECOND PLACE THIS FILE REWRITES CONTENT, AND THE FIRST ONE'S HEADER SAYS THIS PASS COULD NOT BE
// BUILT. READ THAT PARAGRAPH BEFORE THIS ONE. `repairPlaceholderStats()` above argues, correctly, that a
// nought is a false STATEMENT OF FACT while a prompt in a text block is an UNFINISHED SENTENCE, and that
// "there is no equivalent of 'every figure is a nought' for a paragraph, so a repair keyed on the prompt
// string alone would overwrite a block somebody had half written". Every word of that is still true, and
// nothing below weakens it: THIS PASS IS NOT KEYED ON THE PROMPT STRING.
//
// WHAT THIS WAS BUILT TO REPAIR, measured against the running server rather than assumed
// (curl :3200/about):
//
//     HERO       "Replace this with the Centre's own account of why it exists."   ← the opening paragraph
//     RICH_TEXT  "Write the text for this section."
//     TIMELINE   "Add a date" / "Add what happened", twice each
//
// — four placeholder strings rendered as real HTML text nodes on the page the site header links to from
// every other page. A fifth, the HERO's `primaryCta.label: "Add a button"`, was in the payload and reached
// the browser in the RSC stream but was drawn by nothing, because `cta()` needs both words and a link and
// its href was empty (lib/sections/schema.ts records removing that very prompt for that very reason).
//
// ⚠ THE PASS HAS SINCE RUN ON THIS DEVELOPMENT DATABASE, so the paragraph above is the state it was built
// for and NOT the state you will find. Re-measured the same way: `curl :3200/about` now contains none of
// those five strings, /about's HERO, RICH_TEXT and TIMELINE rows all have `updatedAt !== createdAt` (this
// pass wrote them), and `pagePublishBlockers()` names nothing on the page. That does not make any of the
// reasoning below stale — a second run is meant to find three payloads that already match and to go on
// refusing the fourth, which is the idempotence argument at the foot of this header — but a reader looking
// for those strings in order to confirm the header will not find them, and should not conclude it rotted.
//
// ⚠ THE OBVIOUS TEST WAS TRIED FIRST AND IT DOES NOT WORK. The extension this file's own header proposed
// was "a payload BYTE-IDENTICAL to `defaultSectionData(type)`". Measured on this database: it matches NONE
// of /about's four blocks, and for two of them it never could, because the SCHEMA HAD DRIFTED SINCE THE
// ROWS WERE WRITTEN — the HERO row carried the `primaryCta` prompt that had since been deleted from the
// placeholder table, and the RICH_TEXT row had no `typeset` key at all because the typesetting system did
// not exist when it was written. (Both of those rows have since been rewritten BY THIS PASS, so the drift
// is no longer visible in them; it is recorded because it is the argument, and because the next old row
// this idea is tried on will look exactly like they did.) A whole-payload comparison against today's
// defaults is therefore not a conservative version of this test, it is a test that silently answers "leave
// everything alone" for ever, on exactly the old rows the repair is for. (The idea is not wasted: `defaultSectionData` is consulted below, but
// PER FIELD and only for a key the stored row does not have at all, which is the one question it can
// answer soundly.)
//
// ⚠ SO THE SAFETY ARGUMENT IS PROVENANCE, NOT CONTENT, AND THAT IS THE WHOLE DIFFERENCE FROM THE STATS
// PASS. The question is never "do these words look unfinished" — a question about words that cannot be
// answered, which is what the paragraph above refuses to try. It is "has a human ever written to this
// row", which the database answers exactly:
//
//   1. `PageSection.updatedAt` is `@updatedAt` (prisma/schema.prisma), and every studio path that touches
//      a block goes through an update: saving one is `pageSection.update` in
//      app/api/studio/pages/[id]/sections/[sectionId]/route.ts, and reordering is `updateMany` on
//      `position` in lib/studio/crud.ts. So `updatedAt === createdAt` means NOBODY HAS SAVED OR MOVED
//      THIS BLOCK since the row appeared.
//   2. The row must still be the seed's own block in the seed's own place — same `type`, same `position`,
//      same `label`. ⚠ THIS IS WHAT KEEPS THE REPAIR OFF A BLOCK SOMEBODY DROPPED INTO THE BUILDER THIS
//      MORNING, which is the hazard test 4 of the stats pass exists for and the one thing a freshly added
//      block would otherwise sail past: it too has `updatedAt === createdAt`, and it too is full of
//      prompts, because `defaultSectionData()` put them there ten seconds ago. It does NOT have the
//      seed's label at the seed's position.
//   3. The page must have no stored `Revision` rows, because the restore route recreates a page's blocks
//      with fresh timestamps from a snapshot an editor made — which would hand test 1 a row that looks
//      untouched and holds somebody's work. ⚠ A GUARD RATHER THAN A LIVE PATH TODAY, and saying which is
//      the honest version: measured, all three seeded pages have zero revisions, and that route is
//      additionally guarded by `plannedSections !== null`, which no writer in this build produces (see the
//      note on it in lib/sections/schema.ts). It is kept because the day a snapshot carries blocks, this
//      is the test that stops it. ⚠ THAT COUNT ASKED THE WRONG QUESTION UNTIL RECENTLY — it spelled
//      `entityType` `"page"` where every writer of a Page revision spells it `"Page"`, so it could only
//      ever return zero and this test could only ever pass. Re-measured under the corrected spelling:
//      still zero on all three seeded pages, so the conclusion here survives the fix. The census, and why
//      both spellings appear in this file, are at the query itself.
//
// Measured, and the reason this is a proof rather than a hope: all nineteen section rows on the three
// seeded pages were created by three bulk inserts spanning 174 ms, while the page rows themselves have not
// been touched since they were made a fortnight earlier — the shape of `--replace-pages`, and not a shape
// an editor can produce, since adding a block is a single `create` with its own timestamp. ⚠ FOUR of the
// nineteen have ever been updated, and this count is re-measured rather than carried forward, because BOTH
// repair passes have now run on this database: the homepage STATS block (`repairPlaceholderStats()`), and
// /about's HERO, RICH_TEXT and TIMELINE (this pass, 47 minutes later). So the test is discriminating rather
// than vacuously true, and the rows it now excludes are precisely the rows a repair has written — which is
// the idempotence argument at the foot of this header, observed rather than predicted.
//
// ⚠ AND PROVENANCE ALONE IS STILL NOT ENOUGH TO WRITE, because it proves only that nothing will be
// DESTROYED. It says nothing about whether anything should be CHANGED, and a pass that rewrote every
// seed-written block to match today's literal would be `--replace-pages` with a longer header. So the
// write is additionally narrowed to what it is for, by a field-by-field diff (`describePayloadChanges`)
// and two absolute refusals:
//
//   • it may REMOVE or REPLACE words a reader is reading — that is the repair;
//   • it may NEVER ADD words to a field that is empty. An empty field is a decision that reads the same
//     whether an editor made it or nobody did, and filling it is authoring rather than repairing.
//   • it may NEVER CHANGE A SETTING. A mode, a limit, a switch, an alignment: those decide what a block
//     SHOWS, and moving one is a content decision that belongs to a person even when no work is at risk.
//
// ⚠ THOSE TWO REFUSALS ARE NOT HYPOTHETICAL — THEY ARE WHY THIS PASS REPAIRS THREE OF /about's FOUR
// BLOCKS AND REFUSES THE FOURTH. The PEOPLE_SHOWCASE block ("Leadership") differs from the seed in
// exactly two fields: `mode` is `manual` where the seed now says `latest`, and `body` is empty where the
// seed now has a sentence. It publishes NO placeholder and states nothing false — it renders a heading
// with no people under it, which is wrong for the mode and is the defect the ⚠ note on that block in
// `SEED_PAGES` describes at length, but it is a display decision and an unwritten paragraph rather than a
// falsehood. It is reported by name, with both fields, on every run, and left alone. A page repaired in
// part and honestly reported is a better outcome than a page overwritten.
//
// IDEMPOTENT, and by the cheapest possible means: the first thing asked of every block is whether the
// write would change anything at all, so a second run finds three payloads that already match, says so,
// and writes nothing. That ordering is also what keeps the pass honest after it has run — its own write
// bumps `updatedAt`, so test 1 above would refuse a repaired block for ever if it were reached, and it is
// not reached because there is nothing left to change.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The ONE page this pass will write to.
 *
 * ⚠ A SLUG RATHER THAN A LOOP OVER `SEED_PAGES`, and it is a deliberate limit on the size of the promise.
 * The mechanism below would work on any seeded page, and that is exactly the reason to name one: the
 * evidence in the header — the timestamps, the bulk insert, the absence of revisions, the field-by-field
 * diff of what would change — was gathered and read for /about's four blocks, and "it would probably be
 * fine elsewhere too" is not the same statement.
 *
 * The other two seeded pages, for whoever widens this:
 *
 *   • `/` is already correct. `repairPlaceholderStats()` mended its one bad row.
 *   • `/contact` stores "Add a line about how long a reply usually takes." and "Add the postal address",
 *     and ⚠ PUBLISHES NEITHER — verified with curl against the running site, not reasoned about. The
 *     static route at app/(site)/contact/page.tsx SHADOWS the Page row (its own header says so) and draws
 *     the form and the address from SETTINGS, so no block prose on that page reaches a visitor. Those two
 *     strings still reach the site's own SEARCH corpus through `seedSearchIndex()`, which is a real defect
 *     and a different one: the fix for a page nobody renders is not to rewrite its prose.
 */
const PROSE_REPAIR_SLUG = "about";

/**
 * "This payload has no key there at all", which `undefined` cannot say.
 *
 * A stored row written before a schema gained a field genuinely has no key, and that is a different fact
 * from a key holding nothing — the first is the row being older than the schema, the second is a field
 * somebody emptied. The diff below treats them differently, so it needs to be able to tell them apart.
 */
const ABSENT: unique symbol = Symbol("absent");

/**
 * One field the repair would change, in the terms the refusals are written in.
 *
 * `kind` is a JUDGEMENT, not a shape: the whole safety argument is a sentence about each of these, so the
 * classification happens once, here, and the decision below reads them rather than re-deriving anything.
 */
interface PayloadChange {
  /** `body`, `primaryCta.label`, `entries[0].title` — enough for an operator to open the right field. */
  path: string;
  kind:
    /** Words a reader is reading, replaced by other words. THE REPAIR. */
    | "replaces-prose"
    /** Words a reader is reading, taken away and not replaced. Allowed: it can only remove. */
    | "clears"
    /** A field that is empty, filled in. REFUSED — see the header. */
    | "adds-prose"
    /** A key the row does not have, given exactly the schema's own default. Allowed: nothing is decided. */
    | "fills-a-new-schema-field"
    /** Anything else: a mode, a limit, a switch, a link. REFUSED — see the header. */
    | "changes-a-setting";
  from: string;
  to: string;
}

/** Short enough to read in a terminal, long enough to recognise the field. */
function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.length > 96 ? `${text.slice(0, 93)}…` : text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A stored Tiptap document.
 *
 * ⚠ COMPARED AS TEXT AND NEVER WALKED, which is the same decision `collectSectionText` above makes and
 * for a sharper reason here. Walked as JSON, a three-paragraph replacement of a one-paragraph placeholder
 * reports "an array grew by two objects" — true of the column, meaningless about the page, and it would
 * be classified as ADDING words to fields that did not exist and refused. To an editor a rich text body is
 * ONE field, and to a reader it is one run of prose, so that is the unit the diff uses.
 */
function isRichTextDoc(value: unknown): boolean {
  return isPlainObject(value) && value.type === "doc" && Array.isArray(value.content);
}

function richTextWords(value: unknown): string {
  const asText = richTextToPlainText(value as Parameters<typeof richTextToPlainText>[0]);
  return typeof asText === "string" ? collapse(asText) : "";
}

/**
 * The prose a reader would lose (or gain) if this whole subtree were removed (or added).
 *
 * Prose-ness is decided by the nearest KEY, from `SECTION_TEXT_KEYS` above — the same allowlist the search
 * text uses, so "what counts as words on the page" has one answer in this file rather than two.
 *
 * ⚠ THE ALLOWLIST IS NARROWER THAN THE PAGE, AND THIS PASS IS CORRECT ANYWAY. Measured: /about's TIMELINE
 * entries render "Add a date" from `year`, which the allowlist does NOT collect, and "Add what happened"
 * from `title`, which it does. So the removal of those two rows is recognised as removing prose by one of
 * its two visible strings rather than both. That is enough to reach the right verdict here and it is not
 * enough in general; the gap belongs to the allowlist, which mirrors lib/search and is not this pass's to
 * widen. The block's full placeholder tally is printed separately, from the publish gate's own
 * `placeholderPromptsIn()`, which walks every string and names both.
 */
function collectProse(value: unknown, proseKey: boolean, out: string[] = []): string[] {
  if (isRichTextDoc(value)) {
    const words = richTextWords(value);
    if (words.length > 0) out.push(words);
    return out;
  }
  if (typeof value === "string") {
    if (proseKey && value.trim().length > 0) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectProse(entry, proseKey, out);
    return out;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) collectProse(entry, SECTION_TEXT_KEYS.has(key), out);
  }
  return out;
}

/** Both non-empty is a replacement; emptying is a removal; filling is authoring. */
function classifyStringChange(path: string, from: string, to: string, proseKey: boolean): PayloadChange {
  if (to.trim().length === 0) return { path, kind: "clears", from: preview(from), to: "" };
  if (from.trim().length === 0) {
    return { path, kind: proseKey ? "adds-prose" : "changes-a-setting", from: "", to: preview(to) };
  }
  return {
    path,
    kind: proseKey ? "replaces-prose" : "changes-a-setting",
    from: preview(from),
    to: preview(to)
  };
}

/**
 * Every field the write would change, classified.
 *
 * `defaults` is walked in step with the other two for one purpose only — answering "is this key simply
 * missing from a row older than the schema", which is the single question a comparison against
 * `defaultSectionData()` can settle soundly. See the ⚠ in the header for why the whole-payload version of
 * that comparison was tried and abandoned.
 */
function describePayloadChanges(
  stored: unknown,
  next: unknown,
  defaults: unknown,
  path: string,
  proseKey: boolean,
  out: PayloadChange[]
): void {
  if (isRichTextDoc(stored) || isRichTextDoc(next)) {
    const before = isRichTextDoc(stored) ? richTextWords(stored) : "";
    const after = isRichTextDoc(next) ? richTextWords(next) : "";
    if (before !== after) out.push(classifyStringChange(path, before, after, true));
    return;
  }

  if (stored === ABSENT) {
    if (next === ABSENT) return;
    if (defaults !== ABSENT && stableJson(next) === stableJson(defaults)) {
      out.push({ path, kind: "fills-a-new-schema-field", from: "(no such field)", to: preview(next) });
      return;
    }
    for (const words of collectProse(next, proseKey)) {
      out.push({ path, kind: "adds-prose", from: "", to: preview(words) });
    }
    return;
  }

  if (next === ABSENT) {
    for (const words of collectProse(stored, proseKey)) {
      out.push({ path, kind: "clears", from: preview(words), to: "" });
    }
    return;
  }

  if (typeof stored === "string" && typeof next === "string") {
    if (stored !== next) out.push(classifyStringChange(path, stored, next, proseKey));
    return;
  }

  if (Array.isArray(stored) && Array.isArray(next)) {
    // `noUncheckedIndexedAccess` is on, so every read past a length check is still `T | undefined`; the
    // explicit bound is what makes "past the end" mean ABSENT rather than `undefined`, which is the
    // distinction this whole walk turns on.
    for (let index = 0; index < Math.max(stored.length, next.length); index += 1) {
      describePayloadChanges(
        index < stored.length ? stored[index] : ABSENT,
        index < next.length ? next[index] : ABSENT,
        Array.isArray(defaults) && index < defaults.length ? defaults[index] : ABSENT,
        `${path}[${index}]`,
        proseKey,
        out
      );
    }
    return;
  }

  if (isPlainObject(stored) && isPlainObject(next)) {
    // Sorted so two runs over the same pair of payloads print their reasons in the same order — a report
    // whose lines move about between runs cannot be diffed by whoever is deciding whether to trust it.
    for (const key of [...new Set([...Object.keys(stored), ...Object.keys(next)])].sort()) {
      describePayloadChanges(
        key in stored ? stored[key] : ABSENT,
        key in next ? next[key] : ABSENT,
        isPlainObject(defaults) && key in defaults ? defaults[key] : ABSENT,
        path.length > 0 ? `${path}.${key}` : key,
        SECTION_TEXT_KEYS.has(key),
        out
      );
    }
    return;
  }

  // A boolean, a number, or a change of type. Every one of them is a setting, and none of them is a word
  // on the page. `stableJson` rather than `===` so two structurally equal values are not reported as a
  // change for the jsonb key-order reason its own note records.
  if (stableJson(stored) !== stableJson(next)) {
    out.push({ path, kind: "changes-a-setting", from: preview(stored), to: preview(next) });
  }
}

/** One stored block, with the two timestamps the provenance test needs. */
interface StoredBlock {
  id: string;
  type: SectionType;
  label: string | null;
  position: number;
  isVisible: boolean;
  data: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Why this block must be left alone, or `null` when it is a placeholder this pass may repair.
 *
 * A REASON RATHER THAN A BOOLEAN, exactly as `unrepairedStatsReason()` returns one and for the same
 * reason: every refusal is printed, so an operator never has to wonder whether a block was skipped or
 * missed.
 *
 * THE ORDER IS IDENTITY, THEN NOTHING-TO-DO, THEN PROVENANCE, THEN SCOPE, and it is that way so that every
 * reason is TRUE OF THE BLOCK IT NAMES rather than merely first to fire. "Is this the seed's block at all"
 * and "does its payload even parse" come first, because every later sentence is about a block this pass has
 * correctly identified and can read. "There is nothing to change" comes next and returns `null`, because a
 * block that needs no repair must not be described with a refusal — the caller prints it as nothing to do.
 * Only then the two provenance tests, and last the scope tests, which are the only ones that need the diff.
 */
function unrepairedProseReason(
  block: StoredBlock,
  seeded: SeedSection | undefined,
  changes: PayloadChange[],
  pageHasRevisions: boolean
): string | null {
  if (!seeded) {
    return "the seed no longer defines a block at that position, so there is nothing to repair it from";
  }
  if (block.type !== seeded.type || (block.label ?? "") !== seeded.label) {
    return (
      `it is not the block the seed put there — the seed defines ${seeded.type} ` +
      `${JSON.stringify(seeded.label)} at position ${block.position} and this row is ${block.type} ` +
      `${JSON.stringify(block.label ?? "(unlabelled)")}, so somebody has been building on this page`
    );
  }

  const parsed = parseSectionData(block.type, block.data);
  if (!parsed.ok) {
    return (
      `its stored settings do not parse (${parsed.message}) — the studio is showing them to an editor ` +
      "for repair"
    );
  }

  if (changes.length === 0) return null; // handled by the caller as "nothing to do", not as a refusal

  if (block.updatedAt.getTime() !== block.createdAt.getTime()) {
    return (
      `it has been saved since it was created (created ${block.createdAt.toISOString()}, last saved ` +
      `${block.updatedAt.toISOString()}), so somebody has worked on it`
    );
  }
  if (pageHasRevisions) {
    return "the page has stored revisions, so its blocks may have been restored from somebody's snapshot";
  }

  /*
   * ⚠ BOTH REFUSALS ARE COLLECTED AND BOTH ARE PRINTED, rather than returning on the first one found.
   * /about's PEOPLE_SHOWCASE block trips both — an empty `body` AND `mode: manual → latest` — and a
   * report that stopped at the first would send somebody to look at an unwritten paragraph and never
   * mention that the block is also in the wrong mode, which is the more consequential of the two and the
   * one the ⚠ note on that block in `SEED_PAGES` is about. A refusal is only useful if it names
   * everything the reader would have to decide.
   */
  const refusals: string[] = [];

  const adds = changes.filter((change) => change.kind === "adds-prose");
  if (adds.length > 0) {
    refusals.push(
      "the repair would write words into a field that is empty (" +
        adds.map((change) => change.path).join(", ") +
        "), and an empty field reads the same whether an editor emptied it or nobody filled it"
    );
  }
  const settings = changes.filter((change) => change.kind === "changes-a-setting");
  if (settings.length > 0) {
    refusals.push(
      "the repair would change what the block shows rather than what it says (" +
        settings
          .map((change) => `${change.path}: ${JSON.stringify(change.from)} → ${JSON.stringify(change.to)}`)
          .join("; ") +
        "), which is a decision for a person"
    );
  }
  if (refusals.length > 0) return refusals.join("; and ");

  if (!changes.some((change) => change.kind === "replaces-prose" || change.kind === "clears")) {
    return "it publishes no words this repair would remove, so there is nothing false on it to mend";
  }

  return null;
}

/**
 * Rewrite the blocks of `/about` that are still publishing the studio's own prompts as the Centre's prose.
 *
 * Returns the number of rows written — 0 under `--dry-run`, 0 on a fresh install (the page was created
 * correct), 0 on a second run, and one per repaired block on an installation carrying the old rows.
 *
 * ⚠ THE SEARCH INDEX IS REBUILT FOR THE SAME PAGE, THROUGH THE CANONICAL BUILDER, for the reason
 * `repairPlaceholderStats()` gives at its own call to these two functions: the page's words have just
 * changed, so its index row still holds the prompts this pass exists to delete. Without it the site's own
 * search goes on answering "Write the text for this section." — which is precisely the exposure
 * `seedSearchIndex()` warns about below, and it names /about while doing it.
 */
async function repairPlaceholderProse(dryRun: boolean): Promise<number> {
  const seed = SEED_PAGES.find((entry) => entry.slug === PROSE_REPAIR_SLUG);
  if (!seed) {
    console.warn(
      `  ⚠ The prose repair did not run: SEED_PAGES defines no page with the slug ` +
        `${JSON.stringify(PROSE_REPAIR_SLUG)}, so there is nothing to repair from.`
    );
    return 0;
  }

  const page = await prisma.page.findUnique({
    where: { slug: PROSE_REPAIR_SLUG },
    select: {
      id: true,
      slug: true,
      status: true,
      sections: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          type: true,
          label: true,
          position: true,
          isVisible: true,
          data: true,
          createdAt: true,
          updatedAt: true
        }
      }
    }
  });
  if (!page) {
    console.log(`  There is no /${PROSE_REPAIR_SLUG} page in this database — nothing to repair.`);
    return 0;
  }

  // The one page-level test, asked once. Its reason is the same for every block, and repeating it four
  // times would read as four separate findings.
  //
  // ⚠ `"Page"`, NOT `"page"`, AND THIS FILE CONTAINS BOTH SPELLINGS LEGITIMATELY. The two tables this
  // file asks about both carry a free-text `entityType` and they do not use the same convention:
  // `Revision` holds the MODEL NAME, PascalCase, while `SearchDocument` holds a lower-case search KIND.
  // Measured on the development database rather than inferred from the call sites — `groupBy` over each
  // column returns `Revision`: `ResearchArea`, `Page`, `PageSection`, `MediaAsset`, and `SearchDocument`:
  // `craft`, `event`, `page`, `person`, `post`, `project`, `publication`, `research-area`. Not one row
  // crosses. The lower-case spelling is written twice by `seedSearchIndex()` some five hundred lines above,
  // which is correct there and would be wrong here.
  //
  // Five call sites write a `Page` revision, every one of them through
  // `mutateWithHistory({ entityType: "Page" })`: `pages/route.ts` (create), `pages/[id]/route.ts` (PATCH),
  // `pages/[id]/duplicate/route.ts`, `pages/[id]/revisions/[version]/restore/route.ts`, and the Server
  // Action in `app/studio/templates/page.tsx`. (`pages/[id]`'s DELETE and `sections/order` pass
  // `revise: false` and write no revision at all; `cron/publish` writes an audit event only.)
  // `pages/[id]/revisions/route.ts:80` counts exactly the way this line now does.
  //
  // Neither column is an enum, so Postgres compares them case-sensitively and a mismatched spelling does not
  // fail: **it silently counts zero.** That is why this line was wrong and nothing caught it. A guard whose
  // whole purpose is to REFUSE gives exactly the same answer when it is broken as when the page is genuinely
  // untouched, so it answered "no revisions, safe to repair" about /about in every database it was ever run
  // against. ⚠ AND TEST 1 WOULD NOT HAVE COVERED FOR IT, which is the whole reason test 3 was written: a
  // restore recreates a page's blocks with FRESH timestamps, so `updatedAt === createdAt` would have said
  // "nobody has saved this" about a row holding somebody's restored work. So this guard was inert, in the
  // direction that never refuses, and a green dry run proved nothing about it. ⚠ Inert is not the same as
  // exploited: the restore route that would produce those rows is itself guarded by `plannedSections !==
  // null`, which no writer in this build satisfies (test 3's own note above), so nothing is known to have
  // been overwritten. It means the day that changes, this line has to already be right.
  //
  // ⚠ The correction does not change what this run reports, and that was checked rather than assumed: under
  // the correct spelling all three seeded pages still hold zero revisions, so the measurement the header
  // above rests on survives the fix. Nine `Page` revisions exist in this database, all on other pages.
  const revisions = await prisma.revision.count({
    where: { entityType: "Page", entityId: page.id }
  });

  console.log(
    `  /${PROSE_REPAIR_SLUG} is ${page.status} with ${page.sections.length} block(s), ` +
      `${revisions} stored revision(s).`
  );

  const repairable: Array<{ block: StoredBlock; payload: Prisma.InputJsonValue; changes: PayloadChange[] }> = [];

  for (const block of page.sections) {
    const seeded = seed.sections[block.position];
    const name = `${block.type} ${JSON.stringify(block.label ?? "(unlabelled)")}`;

    // Built before the refusals so the diff can be reported either way: an operator deciding whether a
    // refusal is right needs to see what the write would have done.
    const payload = seeded ? buildSectionData(seeded) : undefined;
    const changes: PayloadChange[] = [];
    /*
     * ⚠ ASKED SEPARATELY FROM THE DIFF, AND THE TWO CAN DISAGREE. "The classifier found nothing to
     * report" and "the payloads are the same" are different statements, and reporting the first as the
     * second is how a pass ends up announcing "already what the seed writes" over a row it has not
     * looked at properly. `describePayloadChanges` is deliberately silent about some differences it
     * judges to be nothing — a key the schema has dropped, holding no prose, is removed by the write and
     * says nothing to anybody — so the equality is measured directly, with `stableJson` because the
     * column is jsonb (see its note). Where the two answers part company the block is LEFT ALONE and the
     * gap is reported as a gap in this diff, never as a verdict about the block.
     */
    let identical = payload === undefined;
    if (payload !== undefined) {
      /*
       * ⚠ AGAINST THE MERGED PAYLOAD, NOT THE RAW ONE, AND FOR THE ANCHOR. `mergeSectionData` is what the
       * write applies, so this asks precisely "would the write change anything" — and an anchor lives
       * outside every section schema, so comparing against the unmerged payload would report /about's
       * three anchored blocks as losing `anchor: "vision"`, `"history"` and `"leadership"` on every run.
       * Those are addressing that the shipped default navigation already quotes (lib/sections/anchor.ts).
       */
      const merged = mergeSectionData(block.data, payload);
      identical = stableJson(block.data) === stableJson(merged);
      describePayloadChanges(block.data, merged, defaultSectionData(block.type), "", false, changes);
    }

    // The publish gate's own verdict on the stored row, printed beside this pass's. They answer different
    // questions — the gate asks "is one of today's prompt strings in here", this pass asks "is a reader
    // reading words the seed has since replaced" — and where they disagree, the disagreement is the most
    // informative thing on the report. Measured on /about before this pass ran: the gate named the
    // RICH_TEXT and TIMELINE strings and was SILENT about the HERO, whose prompt had been deleted from the
    // placeholder table after the row was written and was therefore in no vocabulary left to match. ⚠ Do
    // not expect to reproduce that today — the pass has run, and `pagePublishBlockers()` now names nothing
    // on /about (re-measured; /contact is the only seeded page it still names). The example is kept because
    // the asymmetry it shows is permanent: a prompt retired from `SECTION_PLACEHOLDERS` leaves the gate's
    // vocabulary while the words stay in the row, so the gate can only ever be a partial second opinion.
    const gatePrompts = placeholderPromptsIn(block.type, block.data);

    const reason = unrepairedProseReason(block, seeded, changes, revisions > 0);

    if (changes.length === 0) {
      console.log(
        identical
          ? `    ${name}: already what the seed writes — nothing to do.`
          : `    ${name}: LEFT ALONE — its stored payload differs from the seed's, and this pass's diff ` +
            "cannot say how. That is a gap in the diff, not a verdict about the block: look at the row " +
            "by hand before assuming either way."
      );
      continue;
    }

    if (reason !== null) {
      console.log(`    ${name}: LEFT ALONE — ${reason}.`);
      if (gatePrompts.length > 0) {
        console.log(
          `      ⚠ and it is still carrying ${gatePrompts.map((prompt) => JSON.stringify(prompt)).join(", ")}, ` +
            "which the publish gate would refuse. That one is for an editor."
        );
      }
      continue;
    }

    console.log(`    ${name}: REPAIRABLE.`);
    for (const change of changes) {
      console.log(`      ${change.kind}  ${change.path || "(the whole payload)"}`);
      if (change.from) console.log(`        was : ${JSON.stringify(change.from)}`);
      if (change.to) console.log(`        now : ${JSON.stringify(change.to)}`);
    }
    if (gatePrompts.length > 0) {
      console.log(
        `      removes the studio's own prompt(s): ${gatePrompts.map((prompt) => JSON.stringify(prompt)).join(", ")}`
      );
    }
    if (!block.isVisible) {
      console.log("        (the block is switched off, so nothing was visible either way)");
    }

    // `payload` is defined whenever `changes` is non-empty — `changes` can only be filled inside the
    // branch that built it — but `noUncheckedIndexedAccess`-grade honesty is a guard rather than a `!`.
    if (payload !== undefined) repairable.push({ block, payload, changes });
  }

  if (repairable.length === 0) {
    console.log("  Nothing to repair.");
    return 0;
  }

  if (dryRun) {
    console.log(
      `\n  --dry-run: ${repairable.length} block(s) WOULD be rewritten and nothing was written. ` +
        "Re-run without --dry-run to do it."
    );
    return 0;
  }

  for (const { block, payload } of repairable) {
    await prisma.pageSection.update({
      where: { id: block.id },
      // `mergeSectionData` for the anchor, then back to `InputJsonValue` — the same round trip every
      // block save in the studio makes, and the cast is the one Prisma requires for a `Json` column.
      data: { data: mergeSectionData(block.data, payload) as Prisma.InputJsonValue }
    });
    console.log(
      `  Repaired ${block.type} ${JSON.stringify(block.label ?? "(unlabelled)")} at position ${block.position}.`
    );
  }

  const reindexed = await prisma.page.findUnique({
    where: { id: page.id },
    select: {
      id: true,
      slug: true,
      title: true,
      navLabel: true,
      seoDescription: true,
      seoNoIndex: true,
      status: true,
      publishedAt: true,
      publishAt: true,
      unpublishAt: true,
      deletedAt: true,
      sections: { orderBy: { position: "asc" }, select: { isVisible: true, data: true } }
    }
  });
  if (reindexed) {
    await indexDocument(prisma, searchDocFromPage(reindexed));
    console.log(
      `  The /${PROSE_REPAIR_SLUG} search entry was rebuilt, so the prompts are gone from the site's own ` +
        "search as well."
    );
  }

  /*
   * ⚠ THE PAGE ITSELF WILL NOT CHANGE UNTIL IT IS REBUILT, AND SAYING SO IS PART OF THE REPAIR.
   * Measured against the running server: /about answers with `x-nextjs-prerender: 1`,
   * `x-nextjs-cache: HIT` and `Cache-Control: s-maxage=31536000`, because
   * app/(site)/about/page.tsx exports NEITHER `revalidate` NOR `dynamic` — unlike / and /contact, which
   * both set `revalidate = 300`. So it is prerendered once per deployment and served from that copy for a
   * year. An operator who repairs the row, reloads the page and sees the placeholder would reasonably
   * conclude this pass did nothing, which is why it is printed here rather than discovered.
   */
  console.log(
    "\n  ⚠ /about is a STATIC PRERENDER with no revalidate window, so the running site will go on serving\n" +
      "    the old copy until it is rebuilt. That is a defect in app/(site)/about/page.tsx — its two\n" +
      "    sibling routes both set `export const revalidate = 300` and it sets nothing — and it is not\n" +
      "    this file's to fix. The database is correct as of now."
  );

  return repairable.length;
}

/** The account, when there is one — the email as well as the id, because the grant is keyed on it. */
interface SeededAdministrator {
  id: string;
  email: string;
}

async function seedAdministrator(): Promise<SeededAdministrator | null> {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? "";
  const name = process.env.SEED_ADMIN_NAME?.trim() || "Centre Administrator";

  if (!email || !password) {
    console.log(
      "\n  No administrator was created.\n" +
        "  Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in .env and run `npm run seed` again.\n" +
        "  There is deliberately no default account: a seeded credential that reaches production is a\n" +
        "  complete compromise of the site.\n"
    );
    return null;
  }

  if (password.length < MIN_SEED_PASSWORD_LENGTH) {
    throw new Error(
      `SEED_ADMIN_PASSWORD must be at least ${MIN_SEED_PASSWORD_LENGTH} characters; it is ${password.length}. ` +
        "A short password on the only administrator account is the weakest link in the whole system."
    );
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // Do NOT reset the password of an account that already exists, and do NOT change its role here.
    // Re-running the seed must never be a way to take over an administrator's account by editing an
    // environment variable. (`ensureMasterAdmin` below may still promote it, but only when the
    // installation has no master admin at all — see the reasoning there.)
    console.log(`  Administrator ${email} already exists — left untouched.`);
    return { id: existing.id, email: existing.email };
  }

  const user = await prisma.user.create({
    data: {
      email,
      name,
      /**
       * MASTER ADMIN, not ADMINISTRATOR.
       *
       * This is the only account in a fresh installation, and adding somebody to the studio access
       * list is master-admin-only (lib/permissions.ts: `canManageStudioAccess`). Seeding it one tier
       * down would produce an installation whose single account can edit every page and invite
       * nobody — and, since a role may only ever be assigned at or below one's own tier, could never
       * promote itself out of that state either. It would be a dead end reachable only with SQL.
       */
      role: "MASTER_ADMIN",
      // The product's own hasher, not a second call to bcrypt at a cost restated here. See the note on
      // the import: identical output, one owner for the cost factor.
      passwordHash: await hashPassword(password),
      canPublish: true,
      canManageMedia: true
    }
  });

  console.log(`  Created master administrator ${email}.`);
  return { id: user.id, email: user.email };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The studio access list
//
// Every sign-in — password, Google, Microsoft, Yahoo — is refused unless the address has a row in
// `StudioAccess` (lib/auth/access.ts). These three passes are what make that list exist before anybody
// needs it. All three are additive: nothing here ever rewrites or un-revokes a row somebody else wrote,
// because a revoked grant is a decision an administrator made and re-running a seed is not a way to
// overturn it.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const SEED_GRANT_NOTE = "Added by the seed when this installation was set up.";
const BACKFILL_GRANT_NOTE =
  "Added by the seed for an account that already existed before the access list did.";

/** `a@x.org, B@Y.org` → `["a@x.org", "b@y.org"]`, empties dropped, duplicates collapsed. */
function parseEmailList(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const email = part.trim().toLowerCase();
    // A bare word is a typo, not an address, and a grant keyed on one can never match a sign-in.
    if (email.length > 0 && email.includes("@")) seen.add(email);
  }
  return [...seen];
}

/**
 * Write one grant, unless the address already has one.
 *
 * Returns whether it wrote. `findUnique` first rather than an upsert with an empty `update`, so the
 * distinction between "already there" and "just added" survives into the count printed at the end —
 * an operator running this against a live database needs to know which of the two happened.
 */
async function grantAccess(input: {
  email: string;
  name?: string | null;
  grantedRole: Role;
  note: string;
}): Promise<boolean> {
  const email = input.email.trim().toLowerCase();
  const existing = await prisma.studioAccess.findUnique({ where: { email } });
  // Includes a REVOKED grant. Somebody took that person off the list on purpose; a seed must not put
  // them back on it, least of all silently.
  if (existing) return false;

  await prisma.studioAccess.create({
    data: {
      email,
      name: input.name?.trim() || null,
      grantedRole: input.grantedRole,
      note: input.note,
      // Empty: any configured sign-in method. Narrowing to one is a deliberate act performed in the
      // access console by a person who means it, not a default the seed guesses at.
      allowedProviders: [],
      // No `addedById` — nobody added these, the installer did, and inventing an actor would put a
      // name against a decision that person never made.
      addedById: null
    }
  });
  return true;
}

/**
 * Grants for: the seeded administrator, anybody named in `SEED_MASTER_ADMIN_EMAILS`, and every active
 * account that has none.
 *
 * ⚠ THE BACKFILL IS THE PART THAT MATTERS ON AN UPGRADE. On a fresh database it does nothing. On an
 * institution's existing installation it is the difference between "the CMS carried on working" and
 * "nobody could sign in on Monday morning" — the allow-list arrives populated with exactly the people
 * who already had accounts, which is the list an administrator would have typed by hand anyway.
 *
 * Each grant records the role the account ALREADY holds, so nothing is widened by being written down.
 */
async function seedStudioAccess(adminEmail: string | null): Promise<{
  named: number;
  backfilled: number;
}> {
  let named = 0;

  if (adminEmail) {
    const wrote = await grantAccess({
      email: adminEmail,
      name: process.env.SEED_ADMIN_NAME?.trim() || "Centre Administrator",
      grantedRole: "MASTER_ADMIN",
      note: SEED_GRANT_NOTE
    });
    if (wrote) named += 1;
  }

  /**
   * `SEED_MASTER_ADMIN_EMAILS` — colleagues who should be able to sign in on day one.
   *
   * It creates GRANTS ONLY, never accounts: there is no password to invent and no name to guess, and
   * the account is built the first time the person actually signs in with their provider.
   *
   * ⚠ AND THE ACCOUNT THAT SIGN-IN BUILDS WILL BE AN ADMINISTRATOR, NOT A MASTER ADMIN, however this
   * grant is written. `initialRoleFor` caps a never-before-seen account one tier below the top on
   * purpose — becoming a master admin is an act performed on an existing account by an existing master
   * admin, so there is always a person and a timestamp behind it rather than an address somebody typed
   * into an environment variable. The grant still says MASTER_ADMIN because that is the intent it
   * records, and the promotion afterwards is one click.
   */
  for (const email of parseEmailList(process.env.SEED_MASTER_ADMIN_EMAILS)) {
    const wrote = await grantAccess({
      email,
      grantedRole: "MASTER_ADMIN",
      note: "Added by the seed from SEED_MASTER_ADMIN_EMAILS."
    });
    if (wrote) named += 1;
  }

  const active = await prisma.user.findMany({
    where: { isActive: true, deletedAt: null },
    select: { email: true, name: true, role: true }
  });
  // One read rather than one per user: an installation with a few hundred accounts would otherwise
  // spend a few hundred round trips proving that nothing needs doing.
  const listed = new Set(
    (await prisma.studioAccess.findMany({ select: { email: true } })).map((grant) => grant.email)
  );

  const missing = active.filter((user) => !listed.has(user.email.toLowerCase()));
  if (missing.length > 0) {
    const { count } = await prisma.studioAccess.createMany({
      data: missing.map((user) => ({
        email: user.email.toLowerCase(),
        name: user.name,
        grantedRole: user.role,
        note: BACKFILL_GRANT_NOTE,
        allowedProviders: [],
        addedById: null
      })),
      // A concurrent seed, or a grant written between the two reads above, must not abort the run on a
      // unique-constraint violation. The row that is already there is the one we would have written.
      skipDuplicates: true
    });
    return { named, backfilled: count };
  }

  return { named, backfilled: 0 };
}

/**
 * Make sure SOMEBODY can still administer the access list.
 *
 * ⚠ THE ONE PLACE THIS FILE CHANGES AN EXISTING ROW, AND THE CONDITIONS ARE DELIBERATELY NARROW.
 *
 * An installation that predates the master-admin tier has administrators and no master admin. Nobody
 * in it can ever create one: a role may only be assigned at or below one's own tier (`canAssignRole`),
 * so the top of the ladder is unreachable from below and the access console can never be opened again.
 * That is a permanent dead end fixable only with SQL against a production database at an hour when
 * nobody wants to be writing SQL against a production database.
 *
 * So exactly one promotion is made, and only when ALL of the following hold:
 *
 *   • the installation has NO active master admin at all — once one exists this never runs again;
 *   • the candidate account already exists, is active, and is at least an administrator;
 *   • it is either the address in `SEED_ADMIN_EMAIL` or one holding a grant that says MASTER_ADMIN.
 *
 * It is not a back door: it runs from a shell on the server, by somebody who already has the database
 * credentials. And it is announced in the output rather than done quietly, because a role change
 * nobody was told about is indistinguishable from a compromise when it is found later.
 */
async function ensureMasterAdmin(adminEmail: string | null): Promise<string | null> {
  const existing = await prisma.user.count({
    where: { role: "MASTER_ADMIN", isActive: true, deletedAt: null }
  });
  if (existing > 0) return null;

  const grantedMaster = await prisma.studioAccess.findMany({
    where: { grantedRole: "MASTER_ADMIN", revokedAt: null },
    select: { email: true }
  });

  const candidates = [adminEmail, ...grantedMaster.map((grant) => grant.email)].filter(
    (email): email is string => Boolean(email)
  );

  for (const email of candidates) {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    // ADMINISTRATOR at least: promoting an author straight to the top of the ladder because their
    // address appears in an environment variable is a bigger jump than this file should ever make.
    if (!user || !user.isActive || user.deletedAt || user.role !== "ADMINISTRATOR") continue;

    await prisma.user.update({ where: { id: user.id }, data: { role: "MASTER_ADMIN" } });
    console.log(
      `  Promoted ${user.email} to master administrator — this installation had none, and without one\n` +
        "  nobody could have managed the studio access list."
    );
    return user.id;
  }

  return null;
}

async function main(): Promise<void> {
  /*
   * ⚠ THE PROSE REPAIR IS A MODE AND IT RETURNS HERE, BEFORE A SINGLE OTHER ROW IS LOOKED AT.
   *
   * Everything below this branch is idempotent, so running the whole seed around the repair would be
   * harmless — and it would still be wrong. This invocation is allowed to write the blocks of one page,
   * and an operator who has just been talked through a database write by a paragraph of warnings should
   * be able to see, from the output alone, that nothing else was touched. Settings, navigation, pages,
   * the corpus, the search seeding and the administrator are all skipped, and the run says so.
   *
   * It is `--repair-placeholder-prose` that selects this, never `--dry-run` on its own: that combination
   * is refused at the top of the file, because a flag asking for nothing to be written must not fall
   * through to a pass that writes.
   */
  if (REPAIR_PROSE) {
    console.log(
      (DRY_RUN
        ? `\nDRY RUN — describing what a prose repair of /${PROSE_REPAIR_SLUG} would do. Nothing will be written.`
        : `\nRepairing the published placeholder prose on /${PROSE_REPAIR_SLUG}…`) +
        "\n\n  Nothing else in the seed runs under this flag: no settings, no navigation, no pages, no\n" +
        "  corpus, no search seeding and no administrator.\n"
    );
    const repaired = await repairPlaceholderProse(DRY_RUN);
    console.log(
      repaired > 0
        ? `\nDone. ${repaired} block(s) rewritten on /${PROSE_REPAIR_SLUG}.\n`
        : "\nDone. Nothing was written.\n"
    );
    return;
  }

  console.log("\nSeeding the Centre of Excellence portal…\n");

  const settings = await seedSettings();
  console.log(`  Settings groups written: ${settings} (existing groups were left alone)`);

  const navigation = await seedNavigation();
  console.log(
    navigation > 0
      ? `  Navigation items written: ${navigation}`
      : "  Navigation already exists — left alone"
  );

  const { pages, sections } = await seedPages();
  console.log(`  Pages written: ${pages}, sections: ${sections}`);

  /*
   * ⚠ THE REPAIR PASS, AND IT IS CALLED UNCONDITIONALLY ON PURPOSE. See its own header for the five
   * conditions that make that safe; the short version is that it refuses to write unless the stored block
   * proves nobody has authored it. It is called HERE — after `seedPages()`, before anything reads a page
   * back — because on a fresh install the page has just been created correct and this is a no-op, while on
   * an installation seeded before the census existed this is the only thing in the product that repairs the
   * homepage's four noughts.
   *
   * A previous pass of this work left the repair to "the studio or `--replace-pages`", both of which are
   * decisions a human has to remember to take, and the falsehood duly survived two rounds of review on a
   * live page. An unrun repair is indistinguishable from an unwritten one.
   */
  const repaired = await repairPlaceholderStats();
  // Printed either way, because "nothing happened" and "this pass did not run" look identical in a log
  // otherwise, and that ambiguity is how the defect it repairs survived two reviews.
  if (repaired === 0) console.log("  The homepage figures block needed no repair");

  /*
   * THE DEMONSTRATION CORPUS.
   *
   * Off by default and asked for by name, because it writes ~150 published records to the public
   * site. A deployment seeding an empty production database wants the pages and the administrator;
   * it emphatically does not want a fictional research centre's staff list appearing on it.
   *
   *   npx tsx prisma/seed.ts --with-corpus     write it (idempotent; never overwrites)
   *   npx tsx prisma/seed.ts --purge-corpus    take it out again
   *
   * See prisma/corpus/types.ts for what it is and why the site needed it.
   */
  if (PURGE_CORPUS) {
    const removed = await purgeCorpus(prisma, CORPUS);
    const total = Object.values(removed).reduce((sum, n) => sum + n, 0);
    console.log(
      total > 0
        ? `  Sample content removed: ${describeCounts(removed)}`
        : "  No sample content found to remove — nothing matched the corpus slugs."
    );
  } else if (WITH_CORPUS) {
    const { created, unresolved } = await seedCorpus(prisma, CORPUS);
    const total = Object.values(created).reduce((sum, n) => sum + n, 0);
    console.log(
      total > 0
        ? `  Sample content written: ${describeCounts(created)}`
        : "  Sample content already present — left alone."
    );

    /*
     * ⚠ THE CORPUS MUST BE INDEXED OR IT IS INVISIBLE TO THE SITE'S OWN SEARCH.
     *
     * `SearchDocument` rows are written by the studio's CRUD layer as an editor saves each record.
     * `seedCorpus()` writes through Prisma directly — it has to, because there is no editor and no
     * request — so nothing indexes what it creates. The first run of this seed therefore produced a
     * site with a hundred and fifty published records where `/search` answered nothing for "patola",
     * `/api/public/suggest` returned an empty list for every keystroke, and the only rows in the
     * index were the three seeded pages.
     *
     * Nothing surfaced it: every page rendered its records correctly, because a listing reads the
     * content tables and never touches the index. Only search was empty, and an empty search on a
     * site somebody is evaluating reads as "the search is broken".
     *
     * `reindexAll()` rather than indexing each record as it is written: it is the same function the
     * studio's own "Rebuild index" button calls, so there is one indexing path rather than two that
     * can disagree, and it is the tool `docs/OUTSTANDING.md` already names for exactly this. It is
     * heavy — it re-reads every content type — which is acceptable in a seed and would not be in a
     * request.
     */
    /*
     * ⚠ UNCONDITIONAL, NOT `if (total > 0)`. That guard was the first thing written here and it was
     * exactly wrong: the run that WRITES the corpus is the run that leaves it unindexed, so on the
     * second run — when `total` is 0 because every record already exists — the index would never be
     * built at all. The state this exists to repair is precisely "the records are there and the
     * index is not".
     *
     * Asking for `--with-corpus` is asking for content that can be found. `reindexAll()` is
     * idempotent and this is a manual operation, so paying for it every time is the cheap side of
     * the trade.
     */
    const { indexed, byType } = await reindexAll();
    console.log(`  Search index rebuilt: ${indexed} documents (${describeCounts(byType)})`);

    /*
     * ⚠ EVERY UNRESOLVED CROSS-REFERENCE IS NAMED, not counted.
     *
     * The corpus modules are written independently and link by slug, so a project can name a
     * research area nobody defined. Writing it with a null would make the project vanish from the one
     * page it exists for, silently. A count alone would be almost as bad — nobody can fix "3
     * unresolved references".
     */
    if (unresolved.length > 0) {
      console.warn(`
  ⚠ ${unresolved.length} cross-reference(s) in the sample content point at nothing:`);
      for (const miss of unresolved) {
        console.warn(`      ${miss.record} "${miss.slug}" → ${miss.field}: "${miss.target}"`);
      }
      console.warn("    Those records were written without that link. Fix the slug in prisma/corpus/ and re-run.\n");
    }
  }

  const indexed = await seedSearchIndex();
  console.log(
    indexed > 0
      ? `  Pages added to the site's own search: ${indexed}`
      : "  The site's own search already covers these pages — left alone"
  );

  const administrator = await seedAdministrator();

  // AFTER the administrator, so the account it grants access to exists first, and after every other
  // pass so the backfill sees whatever accounts this run created.
  const access = await seedStudioAccess(administrator?.email ?? null);
  console.log(
    access.named > 0
      ? `  Access-list grants written: ${access.named}`
      : "  Access list already covers the named administrators — left alone"
  );
  console.log(
    access.backfilled > 0
      ? `  Existing accounts backfilled onto the access list: ${access.backfilled} ` +
          "(they would otherwise have been refused at sign-in)"
      : "  Every active account is already on the access list — nothing to backfill"
  );

  await ensureMasterAdmin(administrator?.email ?? null);

  console.log("\nDone. Start the app with `npm run dev` and sign in at /studio.\n");
}

main()
  .catch((error) => {
    console.error("\nSeeding failed:\n", error, "\n");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
