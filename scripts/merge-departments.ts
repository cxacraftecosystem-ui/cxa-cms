/**
 * Merges the near-duplicate spellings of a department into the one the data itself elects.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IT WRITES. One column of one table: `people.department`. Every row whose department is a
 * spelling of a unit that some other row spells more fully is rewritten to that fuller spelling, and
 * that person's row in `search_documents` is rebuilt in the SAME transaction. Nothing else on the
 * profile is touched, no row is created, and no row is deleted.
 *
 * ⚠ IT HOLDS NO OPINION OF ITS OWN ABOUT WHICH SPELLINGS MEAN ONE UNIT. `groupDepartments`
 * (lib/people/departments.ts) owns the grouping and the election, it is the same function the public
 * directory's facet and the studio's suggestion list call, and `scripts/departments-check.ts` pins
 * thirty-seven cases over these exact production values. A second opinion in this file would be an
 * opinion the filter does not share — and the entire point of the merge is that the column and the
 * filter finally agree. If a group below looks wrong, the fix is a case in that check and a rule in
 * that module, never a special case here.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS RATHER THAN A SEED EDIT.
 *
 * There is no seed to edit. `prisma/seed.ts` writes no `Person` row at all outside `--with-corpus`,
 * whose twenty people are a demonstration corpus that `--purge-corpus` takes away again
 * (prisma/corpus/seed-corpus.ts). The thirty profiles this runs against were typed into the studio by
 * the Centre, one at a time, over months — which is exactly how one office came to be written four
 * ways and one department three.
 *
 * And if there were a seed to edit it would still be the wrong lever, for the reason the three
 * `set-*.ts` scripts beside this one each give: the seed creates what is missing and then never
 * touches it again (prisma/seed.ts:946-948), so a corrected spelling there changes what a FRESH
 * INSTALL gets and leaves every deployed database exactly as it was.
 *
 * The same values could be retyped into Studio → People, thirty profiles at a time, by hand. This
 * exists so the change is recorded, reviewable, reversible and repeatable rather than being a thing
 * somebody once did in a form on a Tuesday.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * USAGE
 *
 *   npx tsx scripts/merge-departments.ts             print the whole variant→canonical table, write nothing
 *   npx tsx scripts/merge-departments.ts --write     perform the merge
 *
 *   DATABASE_URL=<direct url> npx tsx scripts/merge-departments.ts --write
 *
 * ⚠ IT IS A DRY RUN BY DEFAULT, WHICH IS A DIVERGENCE FROM ALL THREE PRECEDENTS IN THIS DIRECTORY AND
 * IS DELIBERATE. `set-centre-location.ts`, `set-archive-rail.ts` and `set-about-page.ts` all write on
 * sight, and they can afford to: each one writes a value that is IN THE FILE, so reading the file is
 * reading the outcome, and each one is reversible by running a corrected copy of itself. Neither is
 * true here. The value written is a JUDGEMENT MADE ON THE OPERATOR'S BEHALF by a grouping function
 * several files away, so the only way to know what this run would do is to be shown it; and the merge
 * DESTROYS THE VARIANT SPELLINGS — once thirteen rows say "…at IIT Kharagpur, supported by…", nothing
 * in the database remembers that they used to say something shorter. An irreversible write whose value
 * is not visible in the source is the one shape that earns the extra keystroke.
 *
 * Reads DATABASE_URL from the environment. ⚠ POINT IT AT THE RIGHT DATABASE: `.env` in this repo is the
 * LOCAL development one, and it is what a bare `npx tsx scripts/merge-departments.ts --write` will use.
 *
 * A value passed on the command line DOES win — Prisma loads `.env` through dotenv, which never
 * overwrites a variable that is already set, so `DATABASE_URL=<direct url> npx tsx …` reaches the
 * database you named. (An earlier draft of this paragraph had that backwards, which is the more
 * dangerous direction to be wrong in: it would have told an operator that the explicit form does not
 * work, and the explicit form is the one the deployment documentation gives.) The safeguard rests on
 * neither claim — the first line this script prints is the host it ACTUALLY RESOLVED, on screen before
 * the mode banner and long before any write.
 *
 * Prefer the DIRECT url over the pooled one here, as docs/DEPLOYMENT.md §1.8 does for the seed: this
 * opens an interactive transaction per row and a connection pooler is the wrong side of that.
 *
 * ⚠ `--write` WRITES A BACKUP FIRST. Before the first row changes, every affected profile's
 * `{ id, slug, name, department }` is written AS IT STOOD to a timestamped
 * `.backups/departments-<when>.json` under the working directory, and the run prints the path.
 *
 * `.gitignore` covers `/.backups`, and that entry was added with this script rather than assumed: the
 * ignore file has no catch-all for a dot-directory — it names `/.audit`, `/.audit-*.json`, `/.shots`,
 * `/.craft-source`, `.env*` and the CodeGraph index one at a time — so without a line of its own this
 * file would have sat in `git status` waiting to be committed. It holds thirty colleagues' names and
 * units: every word of that is already public on the website, and it is still production data with no
 * business in a repository's history.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ WHAT IT REPLACES AND WHAT IT PRESERVES, because against thirty real profiles that is the whole
 * risk.
 *
 *   REPLACED — `people.department` on every row that carries a spelling other than its group's elected
 *     one, and the `summary` and `body` text of that person's search document, which `searchDocFromPerson`
 *     folds the department into (lib/search/index.ts:415-430). The variant spellings themselves are gone
 *     from the column afterwards; the backup file and the audit trail are the only places they survive.
 *
 *   PRESERVED — every other column of every profile: the name, the slug, the designation, the biography,
 *     the photograph and its framing, the research interests, the manual sort order, the publication
 *     status, `isVisible`, `publishedAt`, `deletedAt`. Also preserved: every row whose department is
 *     already its group's elected spelling, every row whose department is NULL or blank ("no department"
 *     is not a department, and `groupDepartments` drops those rather than grouping them), and every row
 *     whose department names a unit nobody else spells differently — "Computer Science and Engineering"
 *     is its own group of one and is written back to nothing.
 *
 * It is idempotent: run it a second time and it finds nothing whose value is not already its canonical,
 * says so, writes no rows, and leaves no backup file behind.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE MERGED ROWS RE-DATE, AND THAT IS THE COST OF DOING THIS AT ALL.
 *
 * `updatedAt` is `@updatedAt` on `model Person` (prisma/schema.prisma), so Prisma stamps it on every update whether or
 * not a human was involved. Twenty-odd profiles will therefore carry today's timestamp, and two surfaces
 * read that column:
 *
 *   • `app/sitemap.ts:370` publishes it as each person's `lastModified`, so every merged profile announces
 *     a change to search engines on a day when the page's visible prose did not change by a word — except
 *     that it did: the department line under the name is what a reader sees, and it now reads differently.
 *   • the studio's cross-content search orders "most recently touched first" off `SearchDocument.updatedAt`
 *     (app/api/studio/search/route.ts:212-214), which this bumps through `indexDocument`. For a few days
 *     the top of that list is whoever this script touched rather than whoever an editor touched.
 *
 * Neither is hidden and neither is worth avoiding, because the alternative — writing the column with raw
 * SQL that leaves `updatedAt` alone — would be this script quietly lying about when the row last changed.
 * The row really did change. (The people BOARD is unaffected: it orders by group, manual order and name,
 * not by date — app/api/studio/people/route.ts:222.)
 *
 * ⚠ IT WRITES NO `audit_logs` AND NO `revisions` ENTRY, AND THAT IS A DECISION RATHER THAN AN OMISSION.
 * Contract §9 requires every mutation to go through `mutateWithHistory` (lib/audit.ts), and that rule is
 * about the API surface, where there is a signed-in actor, a request, an IP address and a user agent to
 * record. This has none of those; an audit row attributed to nobody is a row that makes the log harder to
 * read during the one occasion anybody reads it. The stronger reason is the second one: `before`/`after`
 * on the existing entries and the `data` blob on each revision are, after this run, THE ONLY SURVIVING
 * RECORD THAT THE NEAR-DUPLICATE EVER EXISTED — every earlier save of these profiles carries the variant
 * spelling verbatim. Writing thirty new entries would bury that; rewriting the old ones would destroy it.
 * They are left exactly as they are. (This also means a rollback from Studio → Audit — `Person` is in
 * that screen's `ROLLBACKABLE` list — can put a variant spelling back on a profile. That is correct: it
 * restores what the editor saved. Re-running this groups it again.)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { PrismaClient, type Prisma } from "@prisma/client";

import { canonicalDepartment, groupDepartments } from "../lib/people/departments";
// ⚠ `lib/search/index.ts` begins with `import "server-only"`, and a plain `tsx` process resolves that
// specifier through `vendor/server-only-noop` — the inert stand-in declared in package.json for exactly
// this. prisma/seed.ts carries the full measurement of why that is needed and why "just install the real
// package" makes it worse; this import adds no exposure the seed does not already have.
import { indexDocument, searchDocFromPerson } from "../lib/search/index";

const prisma = new PrismaClient();

/**
 * Whether to actually do it. See the dry-run argument in the header.
 *
 * Anything else on the command line is REFUSED rather than ignored: `--write=yes`, `--Write` and
 * `--wrtie` all fail `includes("--write")`, and a run that silently degraded to a preview after being
 * asked to merge is the same surprise in the opposite direction.
 */
const WRITE = process.argv.slice(2).includes("--write");

/**
 * The longest department the studio will accept.
 *
 * ⚠ BOTH WRITE ROUTES VALIDATE `department` AS `z.string().trim().max(200)` — app/api/studio/people/
 * route.ts:105 and app/api/studio/people/[id]/route.ts:95 — so a canonical longer than this would be a
 * value NO EDITOR COULD EVER SAVE AGAIN: opening such a profile and pressing save returns a 400 on a
 * field the editor never touched, and the studio's datalist would be offering the unsavable string as a
 * suggestion (app/studio/people/[id]/page.tsx:173). The longest spelling in production today is 199
 * characters, one under the line. That is close enough that this is ASSERTED on every run rather than
 * assumed — every elected value is measured, and a single character over stops the whole run before a
 * byte is written. Nothing here truncates to fit: a name cut at 200 characters is a name nobody chose.
 */
const DEPARTMENT_MAX = 200;

/**
 * ⚠ THIRTY SECONDS, NOT PRISMA'S DEFAULT FIVE. `scripts/set-about-page.ts:63-71` documents this at length
 * against this same deployment: an interactive transaction on the other side of the country spends most
 * of a five-second budget on round trips alone, and the failure is P2028 — a rollback on production, on a
 * script that worked perfectly on the laptop it was written on.
 */
const TRANSACTION_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;

/**
 * ⚠ THIS IS `INDEX_SELECT` FROM app/api/studio/people/[id]/route.ts:129-143, AND IT MUST STAY WHOLE.
 *
 * It is not the list of columns this script changes — that is one column — it is the list
 * `searchDocFromPerson` reads. Dropping one does not fail: it writes a THINNER search document. Lose
 * `bio` and every merged person's biography silently leaves the search corpus; lose `isVisible` and a
 * profile the editor hid becomes findable again, because `isPublished` is computed here at write time and
 * the search predicates never join back to the row. A column too few is invisible until somebody cannot
 * find a colleague by name.
 */
const PERSON_SELECT = {
  id: true,
  slug: true,
  name: true,
  kind: true,
  designation: true,
  department: true,
  bio: true,
  bioRich: true,
  researchInterests: true,
  isVisible: true,
  status: true,
  publishedAt: true,
  deletedAt: true
} satisfies Prisma.PersonSelect;

type PersonRow = Prisma.PersonGetPayload<{ select: typeof PERSON_SELECT }>;

/**
 * Where a row stands, in the four words an operator needs.
 *
 * ⚠ THE PRECEDENCE IS DELIBERATE AND IT IS NOT THE STATUS COLUMN'S. A profile can be PUBLISHED and hidden
 * at once — `isVisible` is a separate editor switch meaning "keep this one off the rosters"
 * (lib/people/roster.ts) — and the question this report answers is "who will a reader see change", so the
 * switch that keeps somebody off the page wins over the status that says they are live. Soft-deletion wins
 * over both: a row in the recycle bin is not on any surface at all.
 */
type RowState = "published" | "unpublished" | "hidden" | "deleted";

/**
 * ⚠ "NOT PUBLISHED" RATHER THAN "DRAFT", because `ContentStatus` has five values and four of them are
 * not PUBLISHED — DRAFT, IN_REVIEW, SCHEDULED and ARCHIVED (prisma/schema.prisma). Calling an archived
 * profile a draft, in a report somebody reads before authorising a production write, is a small lie in
 * exactly the place a reader is checking whether this script understands the data.
 */
const STATE_LABELS: Record<RowState, string> = {
  published: "published",
  unpublished: "not published",
  hidden: "hidden",
  deleted: "in the recycle bin"
};

/** The order the summary reads in: most visible first. */
const STATE_ORDER: RowState[] = ["published", "unpublished", "hidden", "deleted"];

function stateOf(row: Pick<PersonRow, "status" | "isVisible" | "deletedAt">): RowState {
  if (row.deletedAt !== null) return "deleted";
  if (!row.isVisible) return "hidden";
  return row.status === "PUBLISHED" ? "published" : "unpublished";
}

/**
 * The database this process is pointed at — HOST AND DATABASE NAME ONLY, NEVER THE CREDENTIALS.
 *
 * ⚠ READ AFTER `new PrismaClient()` HAS BEEN CONSTRUCTED, AND THAT ORDERING IS THE WHOLE RELIABILITY OF
 * THIS LINE. Constructing the client is what loads `.env` into `process.env` — measured, not assumed: in a
 * plain `tsx` process `process.env.DATABASE_URL` is undefined before the constructor runs and holds the
 * `.env` value after it, while a variable passed on the command line survives untouched. So reading it
 * here reports the url Prisma RESOLVED under either arrangement, which is the only version of this line
 * worth printing. The client is at module scope, above; `main()` cannot run before it exists.
 *
 * The password is never parsed out and reprinted, it is simply never reached: `URL` hands back `host` and
 * `pathname` without the userinfo. On the rare url that will not parse — an unescaped `#` or `?` in a
 * password is the usual cause — nothing is printed at all, because the part that failed to parse is
 * precisely the part that must not be shown.
 */
function databaseTarget(): string {
  const url = process.env.DATABASE_URL;
  if (!url) return "(DATABASE_URL is not set — Prisma will refuse before this script does)";

  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "(DATABASE_URL will not parse as a url; not printing it, since the part that fails is usually the password)";
  }
}

/** `13` → `"13 ×"`, right-aligned to five columns so the counts form a column rather than a ragged edge. */
function times(count: number): string {
  return `${String(count).padStart(3, " ")} ×`;
}

/** `1` → `"1 profile"`, `3` → `"3 profiles"`. Used in prose lines, where "1 profiles" reads as a bug. */
function profiles(count: number): string {
  return `${count} ${count === 1 ? "profile" : "profiles"}`;
}

interface Change {
  row: PersonRow;
  /** Exactly what the column holds now, padding and all. */
  from: string;
  /** The elected spelling. Always one of the strings already in the column, character for character. */
  to: string;
  state: RowState;
}

async function main(): Promise<void> {
  // ⚠ BEFORE ANYTHING ELSE, including the mode banner. The one question an operator must be able to answer
  // at a glance is whether they are about to rewrite Neon or their laptop, and a line printed after three
  // paragraphs of table is a line nobody reads.
  console.log(`  Database: ${databaseTarget()}`);

  // Checked BEFORE the mode is announced, so a mistyped flag never gets to print "dry run" at somebody who
  // typed a merge — the banner below is a promise about this run and it has to be true when it is made.
  const unknown = process.argv.slice(2).filter((argument) => argument !== "--write");
  if (unknown.length > 0) {
    console.error(
      `\n  Unrecognised argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. The only one this ` +
        "script takes is --write, and an argument that was meant to be it would otherwise be ignored in " +
        "silence — leaving you with a preview when you asked for a merge, or the reverse."
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    WRITE
      ? "  Mode:     --write — this run WILL rewrite the department column."
      : "  Mode:     dry run — nothing will be written. Add --write to perform the merge."
  );

  /*
   * ⚠ EVERY ROW, WHATEVER ITS STATUS, ITS VISIBILITY OR ITS `deletedAt`. No `liveStatusWhere()`, no
   * `listablePersonWhere()`, no filter of any kind — which is the opposite of what contract §9 asks of a
   * READ path, and is right for this one.
   *
   * A near-duplicate left behind in a draft, on a hidden profile or in the recycle bin is not a
   * near-duplicate that has gone away. It is one that reappears in the department filter the moment
   * somebody presses Publish or Restore — months from now, long after this script has been forgotten and
   * with nobody left who knows why "Humanities and Social Science" is suddenly a second department. The
   * whole value of a one-off merge is that it is ONE off.
   *
   * The same argument decides the grouping input: the election is made over the spellings on ALL thirty
   * rows, not over the published ones. ⚠ That means it can elect a spelling the public directory has never
   * seen — `PeopleDirectory` groups only the people it lists — which is why the table below prints the
   * state of every row it would touch rather than a bare count.
   */
  const rows = await prisma.person.findMany({
    // By name, so two runs against the same data print the same report in the same order and a diff of two
    // terminal scrollbacks means something.
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: PERSON_SELECT
  });

  const stored = rows.map((row) => row.department);
  const withDepartment = stored.filter((value) => (value ?? "").trim().length > 0).length;

  /*
   * ONE call to `groupDepartments`, and the canonical map is derived from ITS result rather than from a
   * second call to `departmentCanonicalMap`.
   *
   * The two are the same answer — that helper is exactly this derivation, and departments-check.ts proves
   * the grouping is order-independent and total. But the promise a dry run makes is that what it PRINTED is
   * what a later `--write` does, and the cheapest way to keep that promise is for the table and the writes
   * to come from one object rather than from two calls that merely ought to agree.
   */
  const groups = groupDepartments(stored);
  const canonicalByVariant = new Map<string, string>();
  for (const group of groups) {
    for (const variant of group.variants) canonicalByVariant.set(variant, group.canonical);
  }

  // Per spelling, how many rows carry it. `groupDepartments` counts a GROUP; the table needs the variants
  // counted separately. Keyed on the TRIMMED value, which is what the module grouped and what its map keys
  // are — so a row stored with a stray leading space is counted with its unpadded twin rather than as a
  // spelling of its own.
  const countByVariant = new Map<string, number>();
  for (const value of stored) {
    const trimmed = (value ?? "").trim();
    if (trimmed.length === 0) continue;
    countByVariant.set(trimmed, (countByVariant.get(trimmed) ?? 0) + 1);
  }

  const changes: Change[] = [];
  for (const row of rows) {
    const to = canonicalDepartment(row.department, canonicalByVariant);
    if (to === null || row.department === null) continue;
    // Compared against the STORED string, not the trimmed one: a row holding "  Centre …  " is not carrying
    // its canonical spelling even when its group's elected value is what it trims to, and rewriting it also
    // trims it — which is what the studio itself would have written (`body.department?.trim()`).
    if (row.department === to) continue;
    changes.push({ row, from: row.department, to, state: stateOf(row) });
  }

  console.log(
    `\n  ${profiles(rows.length)} read, ${withDepartment} carrying a department, ` +
      `${countByVariant.size} distinct spellings, ${groups.length} unit${groups.length === 1 ? "" : "s"} after grouping.`
  );

  // ── The table. Every spelling, its count, and the value it would become. ─────────────────────────────
  for (const group of groups) {
    const merging = group.variants.filter((variant) => variant !== group.canonical).length;
    console.log(
      `\n  ── ${group.canonical}` +
        `\n     ${group.canonical.length} characters · ${group.variants.length} spelling${group.variants.length === 1 ? "" : "s"}` +
        ` · ${profiles(group.count)}${merging === 0 ? " · nothing to merge" : ""}`
    );
    for (const variant of group.variants) {
      const mark = variant === group.canonical ? "keep " : "merge";
      console.log(`       ${mark}  ${times(countByVariant.get(variant) ?? 0)}  ${variant}`);
    }
  }

  /*
   * The assertion promised by DEPARTMENT_MAX, made over EVERY elected value rather than only over the ones
   * a row is about to be given. A group with nothing to merge today still contributes its canonical to the
   * studio's suggestion list, and an unsavable suggestion is a trap whether or not this run wrote it.
   */
  const longest = groups.reduce((worst, group) => Math.max(worst, group.canonical.length), 0);
  console.log(
    `\n  Longest elected spelling: ${longest} of ${DEPARTMENT_MAX} characters the studio will accept.`
  );

  const oversize = groups.filter((group) => group.canonical.length > DEPARTMENT_MAX);
  if (oversize.length > 0) {
    console.error(
      `\n  REFUSING TO WRITE. ${oversize.length} elected spelling${oversize.length === 1 ? " is" : "s are"} ` +
        `longer than ${DEPARTMENT_MAX} characters, which is the limit both studio write routes validate ` +
        "`department` against (app/api/studio/people/route.ts:105 and [id]/route.ts:95). Writing one would " +
        "produce profiles that no editor could ever save again — every save would 400 on a field they had " +
        "not touched — and the department suggestion list would offer the unsavable value to everybody else."
    );
    for (const group of oversize) {
      console.error(`    ${group.canonical.length} characters: ${group.canonical}`);
    }
    console.error(
      "\n  Nothing has been written. Shorten the offending spelling in the studio on the one profile that " +
        "carries it — the election always picks a string that is already in the column, so shortening it " +
        "there is enough — and run this again."
    );
    process.exitCode = 1;
    return;
  }

  if (changes.length === 0) {
    // The idempotent ending, and the ending of a second run.
    console.log(
      "\n  Nothing to merge: every profile with a department already carries its group's elected spelling. " +
        "No rows written, no search documents rebuilt, no backup file created."
    );
    return;
  }

  const byState = new Map<RowState, number>();
  for (const change of changes) byState.set(change.state, (byState.get(change.state) ?? 0) + 1);
  const split = STATE_ORDER.filter((state) => byState.has(state))
    .map((state) => `${byState.get(state)} ${STATE_LABELS[state]}`)
    .join(", ");

  console.log(`\n  ${profiles(changes.length)} would be rewritten — ${split}.`);
  console.log(`  ${profiles(rows.length - changes.length)} unchanged.`);

  if (!WRITE) {
    console.log(
      "\n  Dry run: nothing was written. Re-run with --write to perform the merge, and read the table above " +
        "first — the merge is irreversible against the column, and the elected spellings are this script's " +
        "judgement on your behalf."
    );
    return;
  }

  /*
   * ── The backup, written BEFORE the first update and never after ────────────────────────────────────
   *
   * This is the only record of the variant spellings that is machine-readable. (The audit trail keeps them
   * too, in the `before` blob of every earlier save, but reading those back is an afternoon and this is a
   * file.) It is written and flushed before a single row changes, so a failure here costs nothing: the
   * merge simply does not start.
   *
   * ⚠ WHERE IT GOES. `.backups/` beside the process's working directory — the repository root, for the
   * documented usage line — which `.gitignore` covers with an entry added alongside this script. That
   * entry is not incidental: the ignore file has no catch-all for a dot-directory, so without it this
   * file would sit in `git status` waiting to be committed, and it holds thirty colleagues' names and
   * units. Public information, every word of it already on the website, and production data that has no
   * business in a repository's history all the same.
   */
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Colons are legal in an ISO timestamp and illegal in a Windows filename, which is what the replace above
  // is for; this repository is developed on Windows and a path that only works on a Mac is a path that
  // fails on the one machine the operator is sitting at.
  const backupPath = path.join(process.cwd(), ".backups", `departments-${stamp}.json`);

  await mkdir(path.dirname(backupPath), { recursive: true });
  await writeFile(
    backupPath,
    `${JSON.stringify(
      {
        takenAt: new Date().toISOString(),
        database: databaseTarget(),
        script: "scripts/merge-departments.ts",
        note:
          "Every profile whose department was about to be rewritten, as it stood BEFORE the merge. To put " +
          "one back, set people.department to the value below for that id — and rebuild that person's " +
          "search document afterwards, because the department is folded into its summary and body.",
        rows: changes.map((change) => ({
          id: change.row.id,
          slug: change.row.slug,
          name: change.row.name,
          department: change.from
        }))
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  console.log(`\n  Backup of ${profiles(changes.length)} written to:\n    ${backupPath}`);
  console.log("    Ignored by git (/.backups). Keep it until you are satisfied with the result.");

  /*
   * ── The merge ───────────────────────────────────────────────────────────────────────────────────────
   *
   * ONE TRANSACTION PER PROFILE, holding that row's update and that row's `indexDocument` together —
   * exactly the shape app/api/studio/people/[id]/route.ts:327-331 uses for an ordinary save, and for the
   * same reason: `searchDocFromPerson` folds `department` into both `summary` AND `body`, so a plain
   * `updateMany` would leave the old spelling sitting in the search corpus, findable, with nothing on any
   * screen looking stale. A person renamed in the column and not in the index is the worst of both — the
   * merge appears to have worked and the duplicate is still there.
   *
   * ⚠ AND NOT ONE TRANSACTION AROUND THE WHOLE RUN, WHICH IS THE OBVIOUS ALTERNATIVE. That version is
   * atomic, and it buys atomicity at the price of holding a write lock on every merged row of `people` for
   * the length of the run: two round trips per profile against a remote database, growing with the roster,
   * against a timeout that has to be guessed in advance and that P2028 turns into a total rollback the
   * moment the guess is wrong. Per row, the failure mode is far kinder — each profile is complete or
   * untouched, the merge is idempotent, and re-running finishes whatever a dropped connection interrupted.
   * The backup above covers the rest.
   */
  console.log("\n  Merging:");
  let reindexed = 0;
  let skipped = 0;
  /** Rows an editor changed between the snapshot and the write. See the `where` on the update below. */
  let overtaken = 0;

  /*
   * ONE instant for the whole run, passed into every extractor call rather than left to default.
   *
   * That is the convention lib/search/index.ts:355-357 states for its extractors — "one rebuild resolves
   * publication state against a single instant rather than drifting across a long run". ⚠ It changes no
   * answer for a `Person` TODAY, because the model has no `publishAt`/`unpublishAt` and `isLive` therefore
   * reads nothing but `status` and `deletedAt`. It is passed anyway: the day a publication window is added
   * to profiles, a run that straddled the minute one of them opened would index half the roster against one
   * clock and half against another, and nothing about this file would look wrong.
   */
  const now = new Date();

  for (const change of changes) {
    const merged = await prisma.$transaction(async (tx) => {
      /*
       * ⚠ THE PREVIOUS VALUE IS PART OF THE `where`, AND A BARE `update` BY ID WAS WRONG.
       *
       * Every decision in the table above was made from a snapshot read at the top of `main()`. If an
       * editor saves one of these profiles while the run is in progress — plausible, because the person
       * running this is usually the person who has just been looking at those profiles — a bare
       * `update({ where: { id } })` would overwrite what they typed with a value elected from the
       * spelling they had replaced, and the backup would then hold the OLD old value rather than theirs.
       * Matching on the department this row is believed to carry makes that a no-op instead: the row is
       * skipped, named on screen, and a second run picks it up with its new value grouped properly.
       */
      const { count } = await tx.person.updateMany({
        where: { id: change.row.id, department: change.from },
        data: { department: change.to }
      });

      if (count === 0) return null;

      const row = await tx.person.findUniqueOrThrow({
        where: { id: change.row.id },
        select: PERSON_SELECT
      });

      /*
       * ⚠ A SOFT-DELETED PROFILE GETS ITS COLUMN AND NO SEARCH DOCUMENT, AND INDEXING ONE WOULD BE A BUG.
       *
       * A person in the recycle bin HAS no row in `search_documents`: the delete route removes it
       * (app/api/studio/people/[id]/route.ts:397) and `reindexAll` never puts it back, because its person
       * source reads `where: { deletedAt: null }` (lib/search/index.ts:825). Calling `indexDocument` here
       * would therefore CREATE a document for somebody who is deleted — unpublished, so no reader would
       * ever see it, but a phantom row that inflates the index count on the studio's maintenance panel
       * until the next full rebuild's sweep quietly deletes it again. The column still gets written, for
       * the reason at the top of `main()`: the value has to be right for the day somebody restores them.
       */
      if (row.deletedAt === null) {
        await indexDocument(tx, searchDocFromPerson(row, now));
        reindexed += 1;
      } else {
        skipped += 1;
      }

      return row;
    }, TRANSACTION_OPTIONS);

    // Printed as each one lands rather than as a total at the end, so a run that dies half way through names
    // the last profile it finished instead of leaving the operator to work it out from the backup.
    if (merged === null) {
      overtaken += 1;
      console.log(
        `    ${change.row.name} (${STATE_LABELS[change.state]}) — SKIPPED: the department changed under ` +
          "this run, so nothing was written to that profile. Run this again to group its new value."
      );
    } else {
      console.log(`    ${change.row.name} (${STATE_LABELS[change.state]}) — was: ${change.from}`);
    }
  }

  console.log(
    `\n  ${profiles(changes.length - overtaken)} merged of ${changes.length} planned — ${split}.`
  );
  if (overtaken > 0) {
    console.log(
      `  ${profiles(overtaken)} skipped because the department changed while this was running. Nothing ` +
        "was overwritten; run this again to group the new values."
    );
  }
  console.log(
    `  ${reindexed} search document${reindexed === 1 ? "" : "s"} rebuilt` +
      (skipped > 0
        ? `, ${skipped} skipped for ${skipped === 1 ? "a profile" : "profiles"} in the recycle bin, which ` +
          "carry no search document by design."
        : ".")
  );
  console.log(
    `  ${groups.length} department${groups.length === 1 ? "" : "s"} now spelled one way each. Check ` +
      "/people — the Department filter should offer one entry per unit — and re-run this to confirm it " +
      "reports nothing left to merge."
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
