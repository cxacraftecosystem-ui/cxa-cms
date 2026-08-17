/**
 * media-select-check — a query that feeds an image must fetch every column the renderer reads.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS: A WHOLE FEATURE SHIPPED NON-FUNCTIONAL AND EVERY GATE WAS GREEN.
 *
 * `MediaAsset` gained four crop columns. A cropper was built to draw the rectangle, an API route was
 * written to save it, a migration added the columns, and the geometry to render it was written and
 * commented at length. Editors used it. Nothing on the site changed, because the crop was never
 * FETCHED: forty-four Prisma queries each carried their own hand-written copy of the media column list,
 * and not one of them was updated.
 *
 * ⚠ AND NOTHING COULD SEE IT. `MediaLike` (lib/media/url.ts) makes every field except `objectKey`
 * optional, because a call site legitimately renders an image without a blur placeholder or without
 * stored dimensions. So "this select omits the crop" and "this asset has no crop" are the SAME SHAPE to
 * TypeScript, and all forty-four typechecked. `eslint` saw valid objects. `route-check` proves a path
 * resolves, not what it selects. `smoke` reads status codes and HTML, and an uncropped photograph is
 * valid HTML. A human could not see it either: the picture rendered, it just rendered wrong, and only
 * the person who drew the rectangle knew what it was supposed to look like.
 *
 * The fix was to give the column list ONE home, `MEDIA_IMAGE_SELECT` in lib/media/select.ts. This script
 * is what stops the next media column repeating the whole story: add a field there and every query gets
 * it; write the list out by hand anywhere and this fails.
 *
 * ⚠ WHAT IT DELIBERATELY CANNOT SEE, so nobody mistakes a pass for a proof:
 *
 *  • **Whether the column is RENDERED.** It proves the data is fetched and carried, never that
 *    `MediaImage` does anything with it. That is the other half of the same bug and it needs a browser.
 *  • **Selects that fetch media columns without `blurDataUrl`.** The scan keys on that column because it
 *    appears in every media select in this repository and nowhere else. A future select that omits it
 *    would be invisible here.
 *  • **Data that arrives from outside Prisma** — a payload parsed from JSON, a fixture, an upload
 *    response. Those carry the crop or not on their own terms.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const ROOTS = ["app", "lib", "components", "scripts"];
const EXTENSIONS = [".ts", ".tsx"];

/** The one module allowed to write the column list out. */
const CANONICAL = join("lib", "media", "select.ts");

/** The columns `storedCrop` needs. All four or none — three of them is no crop at all. */
const CROP_COLUMNS = ["cropX", "cropY", "cropWidth", "cropHeight"] as const;

/**
 * How far from a hand-built `blurDataUrl:` a `cropX:` may sit and still count as the same object.
 *
 * A `MediaLike` assembled by hand lists its fields together, so twelve lines is generous. Being
 * generous is the right error: this check exists to catch the field being ABSENT, and a false pass on an
 * oddly-formatted object is cheaper than a false failure that trains somebody to skip the script.
 */
const NEARBY_LINES = 12;

interface Finding {
  file: string;
  line: number;
  rule: string;
  snippet: string;
  detail: string;
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
let filesScanned = 0;
let fragmentUsages = 0;
let handBuiltRows = 0;

for (const file of files) {
  const rel = relative(ROOT, file);
  const source = readFileSync(file, "utf8");
  const lines = source.split(/\r?\n/);
  filesScanned += 1;

  const isCanonical = rel.split("/").join(sep) === CANONICAL;
  if (source.includes("MEDIA_IMAGE_SELECT") || source.includes("MEDIA_FIGURE_SELECT")) {
    fragmentUsages += 1;
  }

  // This script's own source names every pattern it hunts for, in its comments and in its regexes.
  if (rel.split("/").join(sep) === join("scripts", "media-select-check.ts")) continue;

  lines.forEach((text, index) => {
    const lineNumber = index + 1;

    /**
     * A COMMENT IS NOT A QUERY. Skipped before anything else, because this codebase explains itself at
     * length and several of those explanations quote the very lines below as examples of what not to do.
     * A checker that cannot tell a warning from the mistake it warns about trains people to ignore it.
     */
    const trimmed = text.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;

    // A Prisma SELECT: `blurDataUrl: true`. Only the canonical module may spell the list out.
    if (/\bblurDataUrl\s*:\s*true\b/.test(text) && !isCanonical) {
      findings.push({
        file: rel,
        line: lineNumber,
        rule: "hand-rolled-select",
        snippet: text.trim(),
        detail:
          "A media select written out by hand. Spread MEDIA_IMAGE_SELECT (or _WITH_ID / MEDIA_FIGURE_SELECT) " +
          "from @/lib/media/select instead, so a column added there reaches this query too."
      });
    }

    /**
     * A hand-assembled `MediaLike`: `blurDataUrl: something`. It must carry the crop across as well.
     *
     * ⚠ THE WINDOW MUST ALSO MENTION `objectKey`, and that condition is what makes this rule usable
     * rather than noisy. Plenty of things in this repository hold a blur placeholder and are NOT media
     * rows — `CraftSheet` in scripts/build-craft-sheets.ts describes a generated static image with a
     * `src`, a width, a height and a blur, and never goes near `MediaImage`. `objectKey` is the one
     * field `MediaLike` requires, so its presence is the honest test for "this is a media row".
     *
     * ⚠ A TYPE DECLARATION IS NOT A VALUE, and flagging one is a false positive with a real cost: the
     * interfaces that describe a media row (`StudioMediaAsset`, the upload response, the derivative
     * result) mostly EXTEND `MediaLike`, so they already carry the crop columns as optional members and
     * there is nothing to add. What matters is the code that BUILDS a row, because a field not written
     * there is a field the renderer never sees. `blurDataUrl: string | null` is a type; no value
     * expression begins with a TypeScript primitive keyword, so that is a safe way to tell them apart.
     */
    const TYPE_KEYWORDS = /^(string|number|boolean|any|unknown|never|null|undefined)\b/;
    const valuePart = text.split(/\bblurDataUrl\s*\??\s*:\s*/)[1] ?? "";
    const isTypeDeclaration = TYPE_KEYWORDS.test(valuePart.trim());
    const assembled =
      !isTypeDeclaration && /\bblurDataUrl\s*:\s*(?!true\b)[A-Za-z_$(]/.test(text);
    if (assembled && !isCanonical) {
      const from = Math.max(0, index - NEARBY_LINES);
      const to = Math.min(lines.length, index + NEARBY_LINES + 1);
      const window = lines.slice(from, to).join("\n");
      if (!/\bobjectKey\s*:/.test(window)) return;
      handBuiltRows += 1;
      const missing = CROP_COLUMNS.filter((column) => !new RegExp(`\\b${column}\\s*:`).test(window));
      if (missing.length > 0) {
        findings.push({
          file: rel,
          line: lineNumber,
          rule: "crop-not-carried",
          snippet: text.trim(),
          detail:
            `This builds a media row by hand and does not carry ${missing.join(", ")}. ` +
            "Selecting the columns is only half the job — a field not named here is a field MediaImage never sees."
        });
      }
    }
  });
}

// ── The canonical list itself has to be right, or everything above is enforcing nothing ────────────
const canonicalProblems: string[] = [];
let canonicalSource = "";
try {
  canonicalSource = readFileSync(join(ROOT, CANONICAL), "utf8");
} catch {
  canonicalProblems.push(`${CANONICAL} could not be read. Nothing else this script says means anything.`);
}
if (canonicalSource) {
  for (const column of [...CROP_COLUMNS, "blurDataUrl", "objectKey", "variants"]) {
    if (!new RegExp(`\\b${column}\\s*:`).test(canonicalSource)) {
      canonicalProblems.push(`MEDIA_IMAGE_SELECT no longer fetches \`${column}\`.`);
    }
  }
}

let failed = false;

if (canonicalProblems.length > 0) {
  console.error(`\nFAIL — the shared media select is wrong:\n`);
  for (const problem of canonicalProblems) console.error(`  • ${problem}`);
  failed = true;
}

if (findings.length > 0) {
  console.error(`\nFAIL — ${findings.length} media select problem(s):\n`);
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}  [${finding.rule}]`);
    console.error(`    ${finding.snippet}`);
    console.error(`    ${finding.detail}\n`);
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
if (fragmentUsages < 10) {
  console.error(
    `\nFAIL — only ${fragmentUsages} file(s) reference the shared select. Either the sweep was reverted or ` +
      `the fragment was renamed and this script is now watching a name nobody uses.`
  );
  failed = true;
}

console.log(
  `media-select-check — ${filesScanned} files, ${fragmentUsages} using the shared select, ` +
    `${handBuiltRows} hand-assembled media row(s)`
);

if (failed) process.exit(1);

console.log("PASS — every media select goes through MEDIA_IMAGE_SELECT, and every hand-built row carries the crop.");
