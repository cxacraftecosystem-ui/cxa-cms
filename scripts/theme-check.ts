/**
 * theme-check — a themed neutral must never be the scrim under unconditionally-coloured text.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS: DEFECT CLASS 15 SHIPPED FIVE TIMES AND NOTHING COULD SEE IT.
 *
 * `ink-900` is not a colour. It is a TOKEN THAT INVERTS: `30 27 46` in the light theme and
 * `242 240 249` in the dark one, because the whole ink ladder flips so that body text stays readable
 * against a flipped page. That is exactly right for text on a themed surface, and exactly wrong for a
 * SCRIM — a chip, a pill, a tooltip, a lightbox backdrop — because the thing behind a scrim is a
 * photograph, a map tile or a video poster, and none of those invert.
 *
 * So `bg-ink-900/55` paired with `text-white` is a plate that is near-black in light theme and
 * near-WHITE in dark theme, carrying white text either way. In the dark theme it is invisible. It
 * shipped on the CC BY attribution chip (the one element whose entire job is to satisfy a licence),
 * on both BeforeAfterSlider labels, on the CraftMap marker tooltip, and on the MediaLightbox backdrop
 * and its prev/next buttons — where it made the lightbox open as a white flash.
 *
 * ⚠ EVERY AUTOMATED GATE IN THIS REPOSITORY IS BLIND TO IT BY CONSTRUCTION. `tsc` sees a valid string.
 * `eslint` sees a valid class. `route-check` and `smoke` read HTML, not computed colour. `leak-check`
 * greps for markers. And a human does not see it either, because the light theme is what a developer,
 * a screenshot and the print stylesheet all default to. It is only visible to somebody who switches to
 * the dark theme on a page that happens to have a photograph on it.
 *
 * This closes that hole the cheap way — statically, in milliseconds, with no browser.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ WHAT IT DELIBERATELY CANNOT SEE, so nobody mistakes a pass for a proof:
 *
 *  • **Colours that meet across two elements.** It only flags a background and a text colour written in
 *    the SAME class string. A wrapper with `bg-ink-900` whose child carries `text-white` is the same
 *    bug and is invisible here. That is a deliberate trade: pairing across elements needs the rendered
 *    tree, and a check that needs a browser is a check that stops being run.
 *  • **Contrast RATIOS.** It answers "does this pair invert apart?", never "is 4.5:1 met?". Two colours
 *    can both be theme-stable and still be unreadable.
 *  • **Colours from anywhere but a Tailwind class** — inline styles, CSS variables computed at runtime,
 *    a colour arriving through a prop.
 *
 * It is a guard against ONE proven, repeated mistake, not a colour audit.
 *
 *     npx tsx scripts/theme-check.ts        # or: npm run theme-check
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

/** Where to look. Everything that can carry a Tailwind class. */
const ROOTS = ["app", "components", "lib"];
const EXTENSIONS = new Set([".ts", ".tsx"]);
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build"]);

/**
 * The tokens that INVERT, read off the `[data-theme="dark"]` block in `app/globals.css`.
 *
 * ⚠ THIS LIST MUST TRACK THAT BLOCK. It is verified below rather than trusted: the script reads
 * globals.css and fails if the stylesheet redefines a neutral this list has never heard of, because a
 * new inverting token nobody added here is a new instance of the bug that cannot be detected.
 */
const INVERTING = [
  "ink-300",
  "ink-500",
  "ink-700",
  "ink-900",
  "line-200",
  "surface-50",
  "surface-100",
  "surface-200",
  "surface-300",
  "bg-0",
  "card"
] as const;

/**
 * Colours that do NOT invert and are therefore safe as a scrim: the brand ramps.
 *
 * `--purple-950` is defined once in `:root` and never in the dark block, which is what makes
 * `bg-purple-950` + `text-white` the established spelling for a scrim over a photograph — the hero
 * bands and the footer already pair them as literal brand classes.
 */
const FIXED_TEXT = ["white", "black"] as const;

/**
 * A background utility built from an inverting token, with any variant prefixes and any opacity.
 *
 * `(?:[a-z-]+:)*` covers `hover:`, `sm:`, `group-hover:` and friends; `(?:\/\d+)?` covers `/55`.
 * `bg-bg-0` and `bg-card` are spelled without a numeric step, hence the alternation.
 */
const BG_INVERTING = new RegExp(
  `(?:^|\\s)(?:[a-z-]+:)*!?bg-(?:${INVERTING.map((token) => token.replace("-", "\\-")).join("|")})(?:\\/\\d+)?(?=\\s|$)`
);

const TEXT_FIXED = new RegExp(`(?:^|\\s)(?:[a-z-]+:)*!?text-(?:${FIXED_TEXT.join("|")})(?=\\s|$)`);

/*
 * ⚠ THE MIRROR RULE — "inverting TEXT on a FIXED ground" — WAS WRITTEN, TESTED AND DELETED.
 *
 * It is a real failure mode in principle, and in practice it could not be told apart from correct code
 * without rendering the page. It produced twelve findings on this repository and every one was wrong,
 * for three distinct reasons worth recording so nobody rebuilds it:
 *
 *  1. **Variant scoping.** `bg-surface-100 text-ink-700 hover:bg-purple-50 hover:text-purple-700` is
 *     two self-consistent pairs — a themed base and a fixed hover — not one mixed pair. Reading a class
 *     string as an unordered bag of tokens cannot see that, and respecting it means implementing
 *     Tailwind's variant semantics.
 *  2. **Alpha.** `bg-purple-700/10 text-ink-900` is a 10% tint over whatever is beneath it, so the
 *     effective ground IS the themed surface showing through, and `text-ink-900` is exactly right.
 *     Deciding this needs the composited colour, not the class.
 *  3. It fires on the single commonest correct pattern in the codebase — a themed chip with a brand
 *     hover — so it would have been switched off within a day.
 *
 * A check with a 100% false-positive rate is worse than no check: it trains people to ignore the
 * output, including the rule below, which is precise. The scrim rule stays; the mirror does not.
 */

interface Finding {
  file: string;
  line: number;
  rule: string;
  detail: string;
  snippet: string;
}

const findings: Finding[] = [];
let filesScanned = 0;
let literalsScanned = 0;

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) out.push(...walk(full));
    else if (EXTENSIONS.has(path.extname(entry))) out.push(full);
  }
  return out;
}

/**
 * Every string literal in the file that looks like a class list, with the line it starts on.
 *
 * Deliberately NOT an attempt to parse JSX. Classes in this codebase reach an element through
 * `className="…"`, through `cn("…", cond && "…")`, through a module constant, and through a `cva`-style
 * map — so the only thing all of them share is that the classes are written in a string literal
 * somewhere. Scanning every literal and filtering to the ones that contain a Tailwind-looking token
 * catches all four shapes and costs nothing. A literal that is not a class list simply matches nothing.
 */
function classLiterals(source: string): { value: string; line: number }[] {
  const out: { value: string; line: number }[] = [];

  /*
   * ⚠ COMMENTS ARE BLANKED FIRST, AND SKIPPING THIS STEP IS WHAT MADE THE FIRST RUN OF THIS SCRIPT
   * REPORT TWO FINDINGS THAT WERE BOTH PROSE.
   *
   * This repository comments heavily, and English contains apostrophes. An unpaired `'` in "one's" or
   * "§3)." opens a string as far as the naive scanner is concerned, and the "literal" that comes out is
   * a run of sentences that happens to contain the characters `bg-` and `text-white` somewhere in it.
   * Both false positives on the first run were exactly that. Blanking comments to same-length runs of
   * spaces keeps every byte offset intact, so reported line numbers stay true.
   */
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (line, prefix: string) => prefix + " ".repeat(line.length - prefix.length));

  const pattern = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stripped)) !== null) {
    const value = match[2];
    if (!value || value.length > 4000) continue;
    if (!/(?:^|\s)(?:[a-z-]+:)*!?(?:bg|text)-/.test(value)) continue;

    /*
     * A class list is entirely lower-case. Prose is not. Requiring every whitespace-separated token to
     * be free of capitals and of sentence punctuation is a cheap, sound second gate — it costs a few
     * legitimate arbitrary values (`bg-[url(...)]` with a capital in the path), which is the right
     * trade for a rule whose whole value is that its findings can be trusted.
     */
    const tokens = value.split(/\s+/).filter(Boolean);
    const looksLikeClasses = tokens.every((token) => /^[a-z0-9!:><@&_~+*='".,%#()[\]\\/-]+$/.test(token));
    if (!looksLikeClasses) continue;

    const line = stripped.slice(0, match.index).split("\n").length;
    out.push({ value, line });
  }
  return out;
}

function inspect(file: string): void {
  const source = readFileSync(file, "utf8");
  filesScanned += 1;
  const relative = path.relative(ROOT, file).replace(/\\/g, "/");

  for (const { value, line } of classLiterals(source)) {
    literalsScanned += 1;

    if (BG_INVERTING.test(value) && TEXT_FIXED.test(value)) {
      findings.push({
        file: relative,
        line,
        rule: "inverting-scrim",
        detail:
          "a background from an INVERTING token carries unconditionally-coloured text, so the plate " +
          "flips with the theme while the text does not. Use the non-inverting brand ramp " +
          "(bg-purple-950/…) — see defect class 15 in docs/OUTSTANDING.md.",
        snippet: value.replace(/\s+/g, " ").slice(0, 160)
      });
    }

  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The token list must still match the stylesheet
// ─────────────────────────────────────────────────────────────────────────────

function checkTokenList(): string[] {
  const problems: string[] = [];
  let css: string;
  try {
    css = readFileSync(path.join(ROOT, "app", "globals.css"), "utf8");
  } catch {
    return ["app/globals.css could not be read, so the inverting-token list could not be verified"];
  }

  const open = css.indexOf('[data-theme="dark"]');
  if (open < 0) return ['no [data-theme="dark"] block found in app/globals.css'];

  let depth = 0;
  let index = css.indexOf("{", open);
  const start = index + 1;
  for (; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const block = css.slice(start, index);
  // The capture group always participates when the pattern matches, so the filter is a type-level
  // guard for `noUncheckedIndexedAccess` rather than a real branch — but narrowing HERE keeps
  // `declared` a `Set<string>`, so every reader below is spared the same dance.
  const declared = new Set(
    Array.from(block.matchAll(/--([a-z0-9-]+)\s*:/g), (m) => m[1]).filter(
      (name): name is string => name !== undefined
    )
  );

  // Gradients and shadows are not colours a class can pair with text, so they are not our business.
  const IGNORED = new Set(["grad-mesh"]);
  const known = new Set<string>(INVERTING);

  for (const token of declared) {
    if (IGNORED.has(token) || known.has(token)) continue;
    problems.push(
      `app/globals.css redefines --${token} under [data-theme="dark"], but INVERTING in ` +
        `scripts/theme-check.ts has never heard of it. A new inverting token that this list does not ` +
        `know about is a new instance of defect class 15 that cannot be detected. Add it.`
    );
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-test — the rules must be able to FAIL
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠ THIS IS NOT CEREMONY. `leak-check`'s first social-card probe reported success while testing nothing,
// because it built a path that 404'd for every fixture and skipped them all (defect class 11). A green
// run from a rule that cannot match is indistinguishable from a green run from clean code — so the rules
// are pointed at the five strings that actually shipped, and at the strings that replaced them.

function selfTest(): string[] {
  const problems: string[] = [];

  const MUST_FLAG: readonly string[] = [
    // The five real ones, exactly as they were written before the fix.
    "inline-block rounded-sm bg-ink-900/55 px-2 py-1 text-white backdrop-blur-sm",
    "pointer-events-none absolute bottom-3 left-3 rounded-full bg-ink-900/70 px-2.5 py-1 text-xs font-medium text-white",
    "pointer-events-none absolute bottom-full left-1/2 mb-2 rounded-md bg-ink-900/90 px-2 py-1 text-xs font-medium text-white",
    "absolute left-1 top-1/2 inline-flex h-12 w-12 rounded-full bg-ink-900/60 text-white transition hover:bg-ink-900/80",
    // Variant-prefixed and important-flagged spellings of the same mistake.
    "sm:bg-surface-100 text-white",
    "!bg-card text-black"
  ];

  const MUST_NOT_FLAG: readonly string[] = [
    // The fixes that replaced them.
    "inline-block rounded-sm bg-purple-950/70 px-2 py-1 text-white backdrop-blur-sm",
    "absolute inset-0 bg-purple-950/92 backdrop-blur-sm",
    // A themed surface carrying themed text — the normal, correct case, and by far the commonest.
    "rounded-md border border-line-200 bg-card px-3.5 py-2.5 text-sm text-ink-900",
    // A scrim with no text on it at all: NavSheet and StudioShell do this deliberately.
    "absolute inset-0 cursor-pointer bg-ink-900/50 backdrop-blur-sm",
    // A fixed ground with fixed text — the established brand pairing.
    "rounded-lg bg-purple-950 text-white"
  ];

  const flags = (sample: string): boolean => BG_INVERTING.test(sample) && TEXT_FIXED.test(sample);

  for (const sample of MUST_FLAG) {
    if (!flags(sample)) problems.push(`RULE IS BLIND: should have flagged but did not — "${sample}"`);
  }
  for (const sample of MUST_NOT_FLAG) {
    if (flags(sample)) problems.push(`RULE IS NOISY: should not have flagged but did — "${sample}"`);
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

const selfTestProblems = selfTest();
const tokenProblems = checkTokenList();

for (const dir of ROOTS) {
  for (const file of walk(path.join(ROOT, dir))) inspect(file);
}

console.log(
  `theme-check — ${filesScanned} files, ${literalsScanned} class literals, ` +
    `${INVERTING.length} inverting tokens, ${selfTestProblems.length === 0 ? "self-test ok" : "SELF-TEST FAILED"}`
);

let failed = false;

if (selfTestProblems.length > 0) {
  console.error(`\nFAIL — the rules themselves are wrong, so nothing below can be trusted:\n`);
  for (const problem of selfTestProblems) console.error(`  • ${problem}`);
  failed = true;
}

if (tokenProblems.length > 0) {
  console.error(`\nFAIL — the inverting-token list is out of date:\n`);
  for (const problem of tokenProblems) console.error(`  • ${problem}`);
  failed = true;
}

if (findings.length > 0) {
  console.error(`\nFAIL — ${findings.length} theme-inversion problem(s):\n`);
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}  [${finding.rule}]`);
    console.error(`    ${finding.snippet}`);
    console.error(`    ${finding.detail}\n`);
  }
  failed = true;
}

// A scan that examined almost nothing is not a pass, whatever it printed.
if (filesScanned < 50 || literalsScanned < 100) {
  console.error(
    `\nFAIL — only ${filesScanned} files and ${literalsScanned} class literals were scanned. ` +
      `Something is wrong with this script, not the styles.`
  );
  failed = true;
}

if (failed) process.exit(1);

console.log("PASS — no themed neutral is used as a scrim under unconditionally-coloured text.");
