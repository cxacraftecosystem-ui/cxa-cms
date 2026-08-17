/**
 * framing-select-check — a picture fetched without its framing renders unframed, on one surface, silently.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS. Read the header of `scripts/media-select-check.ts` first: forty-four hand-written media
 * selects each carried their own column list, a crop was added to none of them, and the feature shipped
 * dead with `tsc`, `lint`, `route-check` and `smoke` all green. That script closed the hole for the columns
 * that live ON `MediaAsset`, by giving the list one home and failing anything that spells it out again.
 *
 * ⚠ THE RECORD FRAMING COLUMNS CANNOT BE CLOSED THAT WAY, which is why this is a second script and not
 * three more lines in the first one. `photoScreens`, `coverScreens`, `assetScreens` and `logoScreens` are
 * columns on TWELVE CONTENT MODELS, not on the asset, so no shared fragment can carry them: each is a
 * sibling of the relation it frames, written out per query, exactly the arrangement that failed before.
 * `MEDIA_IMAGE_SELECT` reaching a query proves nothing about whether the framing beside it came too.
 *
 * AND NOTHING ELSE CAN SEE THE MISS. `screens-check` asserts the resolver, `media-render-check` asserts the
 * component; both are given a framing as a fixture. A query that omits the column hands the renderer
 * `undefined`, which `resolvePicture` reads as "nobody framed this" — the SAME shape as the common case, so
 * TypeScript is satisfied, the page renders, and the picture is simply the wrong shape on that one surface.
 * The editor who set the framing sees it work in the studio and not on the site, or the reverse.
 *
 * WHAT IT CHECKS, over the twelve (model, relation, column) triples READ OUT OF prisma/schema.prisma:
 *
 *  1. `framing-not-selected` — a query that selects a framed relation (`cover: { select: … }`) must select
 *     the framing column as its SIBLING in the same select object. An `include:` block satisfies this on its
 *     own, because Prisma returns every scalar of the model from one; so does a same-file `...FRAGMENT`
 *     spread that names the column.
 *  2. `framing-without-picture` — the reverse. A framing must arrive beside SOMETHING it can be resolved
 *     against: either the relation, or `<relation>Id`, which is the key `pictureFromMap` actually resolves
 *     by. Neither means a framing that resolves to nothing whatever the editor set.
 *
 * ⚠ THE FIRST VERSION OF THIS SCRIPT FAILED ON EVERYTHING, and the reason is worth keeping: a check that
 * reports every correct select looks exactly like a check that has found something, and the difference is
 * only visible if you read the code it accuses. Four separate blind spots did it — an off-by-one-level in
 * `topLevelOnly`, rule 2 not knowing that an id resolves a framing, neither rule knowing `include` from
 * `select`, and neither seeing through a spread. Each is now a named helper with the symptom written above
 * it, because the next reader's instinct on a wall of findings will be to suppress rather than to check.
 *
 * ⚠ WHAT IT DELIBERATELY CANNOT SEE, so nobody mistakes a pass for a proof:
 *
 *  • **Whether the framing is RENDERED.** It proves the column is fetched. Whether the page then calls
 *    `framingAssets` and `pictureFromMap`, and whether `MediaImage` receives the `picture`, is the other
 *    half of the same bug — `media-render-check` covers the component, and the page needs a browser.
 *  • **WHICH MODEL a select belongs to.** A grep has no type information: `asset: { select: … }` reads the
 *    same whether the query is on `GalleryItem` (framed) or on `MediaCollectionItem` (no such column,
 *    because a collection row has no picture of its own to frame). The rule therefore flags EVERY select of
 *    a framed relation NAME and the exceptions are listed by hand in `EXEMPTIONS` below, one commented
 *    entry each. That is the deliberate trade: a widened regex would have to guess, and a guess that lets a
 *    real miss through is the failure this whole script exists to prevent. A stale exemption fails too.
 *  • **Whether a query FEEDS A RENDERER.** A select that exists to count rows, to check a checksum or to
 *    name a row in a picker needs no framing, and nothing in the text says which it is. Those are
 *    exemptions as well, with the reason written down, rather than a rule that quietly ignores them.
 *  • **Anything outside a Prisma select.** A framing parsed from a JSON payload, seeded from a fixture or
 *    posted by a form carries itself; `screenFramingColumn` at the API boundary is what guards those.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const ROOTS = ["app", "lib", "components", "scripts"];
const EXTENSIONS = [".ts", ".tsx"];

const SCHEMA = join("prisma", "schema.prisma");
const MIGRATION = join(
  "prisma",
  "migrations",
  "20260817120000_per_screen_framing_columns",
  "migration.sql"
);

/**
 * How many framed pictures there are. Asserted rather than trusted: the triples are read out of the schema
 * so a rename cannot rot them, and this number is what catches the opposite mistake — a thirteenth picture
 * given a column by somebody who never came here, or a column dropped while its editor stayed.
 */
const EXPECTED_TRIPLES = 12;

type Rule = "framing-not-selected" | "framing-without-picture";

interface Triple {
  /** The Prisma model, for the report only — the scan cannot tell which model a query is on. */
  model: string;
  /** The relation field: `photo`, `cover`, `asset`, `logo`. */
  relation: string;
  /** The framing column beside it: always `${relation}Screens`. */
  column: string;
  /** The table `@@map` names, so the migration can be cross-checked. */
  table: string;
}

/**
 * A select that is allowed to fetch one side without the other, with the reason.
 *
 * ⚠ EVERY ENTRY MUST STILL MATCH SOMETHING. An exemption for a query somebody has since deleted or wired
 * up properly is an exemption that will one day cover a NEW query nobody looked at, so a stale one fails
 * this script. `relations: ["*"]` covers every framed relation name in that file.
 */
interface Exemption {
  file: string;
  relations: string[];
  rule: Rule;
  why: string;
}

const EXEMPTIONS: Exemption[] = [
  {
    // The read side of `EntityPicker`: thirteen searches that answer "which records?" with a title, a
    // subtitle, a status chip and a thumbnail the size of a favicon. Nothing here draws a picture at a
    // screen width — the framing is set in the field the picker FEEDS, not shown in the picker — and one of
    // these selects is on `MediaCollectionItem`, which has no framing column at all.
    file: "app/api/studio/lookup/route.ts",
    relations: ["*"],
    rule: "framing-not-selected",
    why: "picker rows: a title and a thumbnail, no surface that varies by screen width"
  },
  {
    // `generateMetadata`'s own loader. It fetches the cover to build ONE OpenGraph card — a fixed
    // 1200×630 rendition rendered by app/(site)/news/[slug]/opengraph-image.tsx — and a framing is a set of
    // answers to "how wide is the reader's screen", a question a social-media crawler never asks. The page
    // component beside it fetches the framing and draws the article's actual cover.
    file: "app/(site)/news/[slug]/page.tsx",
    relations: ["cover"],
    rule: "framing-not-selected",
    why: "generateMetadata's loader: one fixed-size OpenGraph card, no screen width to answer to"
  },
  {
    // The same, for events.
    file: "app/(site)/events/[slug]/page.tsx",
    relations: ["cover"],
    rule: "framing-not-selected",
    why: "generateMetadata's loader: one fixed-size OpenGraph card, no screen width to answer to"
  }
];

interface Finding {
  file: string;
  line: number;
  rule: Rule;
  snippet: string;
  detail: string;
}

// ── The twelve triples, read out of the schema ─────────────────────────────────────────────────────
interface SchemaFacts {
  triples: Triple[];
  /** MediaAsset relations with NO framing column, which is what makes a relation NAME ambiguous. */
  unframed: { model: string; relation: string }[];
  problems: string[];
}

/**
 * A capture group the regex beside it makes MANDATORY, as a `string`.
 *
 * ⚠ IT THROWS RATHER THAN DEFAULTING, and the difference matters here. `noUncheckedIndexedAccess` types
 * every group `string | undefined`; the tempting `?? ""` would turn a regex somebody had edited into an
 * empty relation name, and an empty name matches nothing — so every rule below would pass while checking
 * NOTHING. That is precisely the shape of failure this script exists to catch, and it must not be the shape
 * of the script's own failure. A group that is genuinely absent means the pattern above no longer says what
 * the code beneath it assumes, which is a broken gate and has to be loud.
 */
function group(match: RegExpMatchArray, at: number, what: string): string {
  const value = match[at];
  if (value === undefined) {
    throw new Error(
      `framing-select-check: the regex for ${what} matched but group ${at} is missing. The pattern and the code reading it have drifted apart — fix the pattern rather than defaulting the value.`
    );
  }
  return value;
}

function readSchema(): SchemaFacts {
  const triples: Triple[] = [];
  const unframed: { model: string; relation: string }[] = [];
  const problems: string[] = [];

  let source = "";
  try {
    source = readFileSync(join(ROOT, SCHEMA), "utf8");
  } catch {
    problems.push(`${SCHEMA} could not be read. Nothing else this script says means anything.`);
    return { triples, unframed, problems };
  }

  // One pass per model block. Prisma's own formatter keeps `model X {` and its closing `}` at column 0.
  const blocks = source.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm);
  for (const block of blocks) {
    const model = group(block, 1, "a model block's name");
    const body = group(block, 2, "a model block's body");
    const mapped = /@@map\("([^"]+)"\)/.exec(body);
    const table = mapped?.[1] ?? model;

    const fields = [...body.matchAll(/^\s{2}(\w+)\s+(\w+)(\?)?/gm)].map((field) => ({
      name: group(field, 1, "a field name"),
      type: group(field, 2, "a field type")
    }));
    const hasField = (name: string, type: string) =>
      fields.some((field) => field.name === name && field.type === type);

    for (const field of fields) {
      if (field.type !== "MediaAsset") continue;
      const column = `${field.name}Screens`;
      if (hasField(column, "Json")) triples.push({ model, relation: field.name, column, table });
      else unframed.push({ model, relation: field.name });
    }

    // A `Json` column named after nothing is a column no relation frames.
    for (const field of fields) {
      if (field.type !== "Json" || !field.name.endsWith("Screens")) continue;
      const relation = field.name.slice(0, -"Screens".length);
      if (!hasField(relation, "MediaAsset")) {
        problems.push(`${model}.${field.name} has no \`${relation} MediaAsset\` relation to frame.`);
      }
    }
  }

  if (triples.length !== EXPECTED_TRIPLES) {
    problems.push(
      `the schema describes ${triples.length} framed picture(s), not ${EXPECTED_TRIPLES}. Either a column ` +
        `was added or removed without touching this script, or the block parse no longer matches the file.`
    );
  }

  // The columns must exist in the database as well as in the schema, or every select below is a type error
  // rather than a rendering fault — and the migration header explains at length why the two must agree.
  let migration = "";
  try {
    migration = readFileSync(join(ROOT, MIGRATION), "utf8");
  } catch {
    problems.push(`${MIGRATION} could not be read, so the twelve columns cannot be confirmed to exist.`);
  }
  if (migration) {
    for (const triple of triples) {
      const added = new RegExp(`"${triple.table}"[^\\n]*"${triple.column}"`);
      if (!added.test(migration)) {
        problems.push(
          `${triple.model}.${triple.column} is in the schema but no migration adds "${triple.column}" to ` +
            `"${triple.table}". Prisma will report drift and the client will not expose the field.`
        );
      }
    }
  }

  return { triples, unframed, problems };
}

// ── Reading source the way a compiler would, not the way a grep does ───────────────────────────────
/**
 * Blank out comments and string bodies, keeping every byte's position and every newline.
 *
 * A COMMENT IS NOT A QUERY, and in this repository that is not a small distinction: the files being
 * scanned explain per-screen framing at length, several of them quote `cover: { select: … }` and
 * `coverScreens: true` in prose to say why the two travel together, and one of those quotations sits inside
 * the very select it describes. A checker that reads its own documentation as evidence — in either
 * direction, a false pass or a false failure — is a checker people learn to skip.
 */
function blankNonCode(source: string): string {
  const out = source.split("");
  let index = 0;
  const at = (offset: number) => source[index + offset] ?? "";
  const blankTo = (end: number) => {
    for (let cursor = index; cursor < end && cursor < source.length; cursor += 1) {
      if (source[cursor] !== "\n") out[cursor] = " ";
    }
  };

  while (index < source.length) {
    const char = source[index];
    if (char === "/" && at(1) === "/") {
      const end = source.indexOf("\n", index);
      blankTo(end === -1 ? source.length : end);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === "/" && at(1) === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blankTo(stop);
      index = stop;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === "\\") cursor += 2;
        else if (source[cursor] === quote) break;
        else cursor += 1;
      }
      blankTo(Math.min(cursor + 1, source.length));
      index = Math.min(cursor + 1, source.length);
      continue;
    }
    index += 1;
  }
  return out.join("");
}

/** The index of the `}` closing the `{` at `open`, or -1 if the file is unbalanced. */
function matchBrace(code: string, open: number): number {
  let depth = 0;
  for (let cursor = open; cursor < code.length; cursor += 1) {
    const char = code[cursor];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return -1;
}

/** The index of the `{` opening the object that CONTAINS `position`, or -1 at the top level. */
function enclosingOpen(code: string, position: number): number {
  let depth = 0;
  for (let cursor = position - 1; cursor >= 0; cursor -= 1) {
    const char = code[cursor];
    if (char === "}") depth += 1;
    else if (char === "{") {
      if (depth === 0) return cursor;
      depth -= 1;
    }
  }
  return -1;
}

/**
 * A sibling list with every same-file `...FRAGMENT` spread pasted in, one level deep.
 *
 * ⚠ WITHOUT THIS THE CHECK ACCUSES THE HOUSE PATTERN. This studio's list and detail routes are built as
 * `select: { ...POST_SELECT, cover: { select: … } }` — one shared fragment of scalars, extended per handler
 * — and `POST_SELECT` is where `coverScreens` is named. Reading only the literal keys sees a spread and a
 * relation, concludes the framing is missing, and reports four correct routes. A gate that reports correct
 * code is worse than no gate: it teaches the reader that its findings are noise.
 *
 * ONE LEVEL, AND SAME-FILE ONLY, deliberately. A fragment spread out of another module would need this
 * script to resolve imports, which is a type checker's job and not a grep's; if that shape ever appears the
 * honest answer is an EXEMPTION naming it, not a resolver that guesses. Recursion is not offered either: a
 * fragment that spreads a fragment is not a pattern this repository uses, and pretending to handle it would
 * make the failure silent when it does.
 */
function expandSpreads(code: string, siblings: string): string {
  let out = siblings;
  for (const spread of siblings.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)) {
    const name = spread[1];
    if (name === undefined) continue;
    const declaration = new RegExp(`\\bconst\\s+${name}\\s*(?::[^=]*)?=\\s*\\{`).exec(code);
    if (!declaration) continue;
    const open = declaration.index + declaration[0].length - 1;
    const close = matchBrace(code, open);
    if (close === -1) continue;
    out += `\n${topLevelOnly(code.slice(open + 1, close))}`;
  }
  return out;
}

/**
 * The key an object literal is the value of — `include` in `include: { cover: … }`, `select` in a select.
 *
 * ⚠ THIS IS WHAT TELLS AN `include` FROM A `select`, AND PRISMA TREATS THE TWO OPPOSITELY. A `select`
 * returns exactly the fields named in it, so a framing column omitted from one does not arrive. An
 * `include` returns EVERY SCALAR of the model plus the relations named in it — so `include: { cover: {
 * select: … } }` already carries `coverId` and `coverScreens`, and naming them would be redundant rather
 * than required. `app/(site)/craft-explorer/[slug]/page.tsx` is exactly that shape and resolves its framing
 * correctly; reporting it would be a false accusation against working code, and a gate that cries wolf on
 * the correct pattern gets suppressed rather than fixed.
 *
 * "" when there is no identifier before the brace — a bare object, an argument list, a function body.
 */
function enclosingKey(code: string, open: number): string {
  // Back over whitespace and the colon, then take the identifier.
  let cursor = open - 1;
  while (cursor >= 0 && /\s/.test(code[cursor] ?? "")) cursor -= 1;
  if (code[cursor] !== ":") return "";
  cursor -= 1;
  while (cursor >= 0 && /\s/.test(code[cursor] ?? "")) cursor -= 1;
  const end = cursor + 1;
  while (cursor >= 0 && /[\w$]/.test(code[cursor] ?? "")) cursor -= 1;
  return code.slice(cursor + 1, end);
}

/**
 * An object's own keys, with every nested object and array emptied.
 *
 * The framing must be a SIBLING of the relation, and only flattening to one level can tell the difference:
 * a `coverScreens` on the nested album select two levels down is not the one this cover needed, and reading
 * it as though it were is the false pass that would make the whole check decorative.
 *
 * ⚠ `slice` IS THE OBJECT'S INTERIOR — between its braces, NOT including them. Handing in the braces too
 * puts every key one level deep, so this returns the outer pair and nothing else, every sibling list comes
 * back empty, and BOTH rules below fire on the same correct line: the relation is reported as missing its
 * framing and the framing beside it is reported as having no relation. That was the first version of this
 * script, and the symptom is worth writing down because a check that fails on everything looks exactly like
 * a check that has found something.
 */
function topLevelOnly(slice: string): string {
  let depth = 0;
  let out = "";
  for (const char of slice) {
    if (char === "{" || char === "[") {
      if (depth === 0) out += char;
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) out += char;
      continue;
    }
    if (depth === 0) out += char;
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

// ── The scan ───────────────────────────────────────────────────────────────────────────────────────
const { triples, unframed, problems } = readSchema();
const RELATIONS = [...new Set(triples.map((triple) => triple.relation))];
const COLUMNS = [...new Set(triples.map((triple) => triple.column))];

const files: string[] = [];
for (const root of ROOTS) {
  const full = join(ROOT, root);
  try {
    if (statSync(full).isDirectory()) walk(full, files);
  } catch {
    // A root that does not exist is not this script's problem to report.
  }
}

const findings: Finding[] = [];
const usedExemptions = new Set<Exemption>();
let filesScanned = 0;
let relationSelects = 0;
let framedSelects = 0;
let framingColumnSelects = 0;

/** The exemption covering this hit, if one does. */
function exemptionFor(file: string, relation: string, rule: Rule): Exemption | undefined {
  return EXEMPTIONS.find(
    (entry) =>
      entry.file === file &&
      entry.rule === rule &&
      (entry.relations.includes("*") || entry.relations.includes(relation))
  );
}

const SELF = join("scripts", "framing-select-check.ts");

for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join("/");
  // This script's own source names every pattern it hunts for, in its comments and in its regexes.
  if (relative(ROOT, file) === SELF) continue;

  const source = readFileSync(file, "utf8");
  filesScanned += 1;
  if (RELATIONS.length === 0) continue;

  const code = blankNonCode(source);
  const lineOf = (index: number) => code.slice(0, index).split("\n").length;
  const textOf = (index: number) => source.split(/\r?\n/)[lineOf(index) - 1]?.trim() ?? "";

  // 1. A relation select must carry the framing column beside it.
  const selects = code.matchAll(new RegExp(`\\b(${RELATIONS.join("|")})\\s*:\\s*\\{`, "g"));
  for (const match of selects) {
    const relation = group(match, 1, "a relation select");
    const open = match.index + match[0].length - 1;
    const close = matchBrace(code, open);
    if (close === -1) continue;

    // `select:` is what makes this a QUERY. A `{ id, kind, … }` object of the same name is a row somebody
    // assembled by hand, which is `media-select-check`'s territory and not a fetch at all.
    const own = code.slice(open, close + 1);
    if (!/\bselect\s*:/.test(own) && !/\binclude\s*:/.test(own)) continue;
    relationSelects += 1;

    const parentOpen = enclosingOpen(code, match.index);
    const parentClose = parentOpen === -1 ? -1 : matchBrace(code, parentOpen);
    const siblings =
      parentOpen === -1 || parentClose === -1
        ? ""
        : expandSpreads(code, topLevelOnly(code.slice(parentOpen + 1, parentClose)));
    const column = `${relation}Screens`;
    if (new RegExp(`\\b${column}\\s*:`).test(siblings)) {
      framedSelects += 1;
      continue;
    }
    // An `include` already carries every scalar of the model, this framing among them — see `enclosingKey`.
    if (enclosingKey(code, parentOpen) === "include") {
      framedSelects += 1;
      continue;
    }

    const exemption = exemptionFor(rel, relation, "framing-not-selected");
    if (exemption) {
      usedExemptions.add(exemption);
      continue;
    }

    const models = triples
      .filter((triple) => triple.relation === relation)
      .map((triple) => triple.model)
      .join(", ");
    findings.push({
      file: rel,
      line: lineOf(match.index),
      rule: "framing-not-selected",
      snippet: textOf(match.index),
      detail:
        `This fetches the \`${relation}\` picture without \`${column}\` beside it. On ${models} that column ` +
        `is the per-screen framing, so whatever this query feeds draws every framed picture unframed — and ` +
        `an unframed picture is valid markup, which is why no other gate reports it. Add \`${column}: true\` ` +
        `(and \`${relation}Id: true\`, which \`pictureFromMap\` resolves the base photograph by) to this same ` +
        `select. If this surface genuinely cannot use a framing, say so in EXEMPTIONS with the reason.`
    });
  }

  /**
   * 2. And the reverse: a framing with no picture to resolve it against.
   *
   * ⚠ EITHER THE RELATION OR THE ID SATISFIES THIS, AND THE ID IS THE COMMONER OF THE TWO.
   * `resolvePicture` takes a base media ID and a map of assets, so `pictureFromMap(coverId, coverScreens,
   * media)` is how every page in this repository resolves one — rule 1's own message above says as much.
   * The frequent and CORRECT shape `coverId: true, coverScreens: true` therefore has no nested relation and
   * needs none: it is a scalar payload for an editor, a revision snapshot, an API answer. Demanding
   * `cover: { select: … }` here flagged fifteen correct selects on this script's first run, which is the
   * number at which a gate stops being read and starts being switched off.
   *
   * What is left is the genuine miss: a framing fetched with NEITHER the photograph nor its id, which
   * resolves to nothing whatever the editor set.
   */
  if (COLUMNS.length === 0) continue;
  const columns = code.matchAll(new RegExp(`\\b(${COLUMNS.join("|")})\\s*:\\s*true\\b`, "g"));
  for (const match of columns) {
    framingColumnSelects += 1;
    const column = group(match, 1, "a framing column select");
    const relation = column.slice(0, -"Screens".length);
    const parentOpen = enclosingOpen(code, match.index);
    const parentClose = parentOpen === -1 ? -1 : matchBrace(code, parentOpen);
    const siblings =
      parentOpen === -1 || parentClose === -1
        ? ""
        : expandSpreads(code, topLevelOnly(code.slice(parentOpen + 1, parentClose)));
    if (new RegExp(`\\b${relation}\\s*:\\s*\\{`).test(siblings)) continue;
    // The id, written out or spread in through a shared fragment that names it.
    if (new RegExp(`\\b${relation}Id\\s*:\\s*true\\b`).test(siblings)) continue;

    const exemption = exemptionFor(rel, relation, "framing-without-picture");
    if (exemption) {
      usedExemptions.add(exemption);
      continue;
    }

    findings.push({
      file: rel,
      line: lineOf(match.index),
      rule: "framing-without-picture",
      snippet: textOf(match.index),
      detail:
        `This selects \`${column}\` with neither \`${relation}: { select: … }\` nor \`${relation}Id: true\` ` +
        `in the same object, so the framing arrives with no photograph and no id to resolve it against — ` +
        `\`pictureFromMap\` needs one of the two. Add \`${relation}Id: true\` beside it, or fetch the ` +
        `relation, or drop the column: a framing alone resolves to nothing and reads as a control that does ` +
        `nothing.`
    });
  }
}

// ── Report ─────────────────────────────────────────────────────────────────────────────────────────
let failed = false;

if (problems.length > 0) {
  console.error(`\nFAIL — the schema this script reads its rules out of is wrong:\n`);
  for (const problem of problems) console.error(`  • ${problem}`);
  failed = true;
}

if (findings.length > 0) {
  console.error(`\nFAIL — ${findings.length} framing select problem(s):\n`);
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}  [${finding.rule}]`);
    console.error(`    ${finding.snippet}`);
    console.error(`    ${finding.detail}\n`);
  }
  failed = true;
}

const stale = EXEMPTIONS.filter((entry) => !usedExemptions.has(entry));
if (stale.length > 0) {
  console.error(`\nFAIL — ${stale.length} exemption(s) match nothing any more:\n`);
  for (const entry of stale) {
    console.error(`  ${entry.file}  [${entry.rule}]  ${entry.relations.join(", ")}`);
    console.error(
      `    Exempted because: ${entry.why}. Nothing there matches now, so this entry is standing ready to ` +
        `excuse a query nobody has read. Delete it.\n`
    );
  }
  failed = true;
}

// A scan that examined almost nothing is not a pass, whatever it printed.
if (filesScanned < 100) {
  console.error(
    `\nFAIL — only ${filesScanned} files were scanned. Something is wrong with this script, not the queries.`
  );
  failed = true;
}
if (relationSelects < 30) {
  console.error(
    `\nFAIL — only ${relationSelects} relation select(s) were recognised. Every framed picture in this CMS is ` +
      `fetched somewhere, so a number this low means the pattern this script matches is no longer the ` +
      `pattern the queries are written in.`
  );
  failed = true;
}
if (framedSelects < 20) {
  console.error(
    `\nFAIL — only ${framedSelects} select(s) carry a framing column. Either the record wiring was reverted ` +
      `or the columns were renamed and this script is now watching names nobody uses.`
  );
  failed = true;
}

const ambiguous = [...new Set(unframed.map((entry) => entry.relation))].filter((name) =>
  RELATIONS.includes(name)
);
console.log(
  `framing-select-check — ${filesScanned} files, ${triples.length} framed picture(s), ` +
    `${relationSelects} relation select(s) of which ${framedSelects} carry the framing, ` +
    `${framingColumnSelects} framing column select(s)` +
    (ambiguous.length > 0
      ? `, ${ambiguous.length} ambiguous relation name(s) [${ambiguous.join(", ")}] a grep cannot attribute`
      : "")
);

if (failed) process.exit(1);

console.log("PASS — every query that fetches a framed picture fetches the framing beside it.");
