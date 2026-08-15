/**
 * Capture every page that matters, in one pass, and stitch a contact sheet.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY: A CHANGE TO TYPE OR COLOUR TOUCHES EVERY PAGE, AND NOBODY CAN HOLD TWENTY PAGES IN THEIR HEAD.
 *
 * `shoot.mjs` captures one page well. That is the right tool when you are working on one page, and the
 * wrong one for the question "is the site still coherent after changing the body face" — which needs
 * every page side by side, in one image, at a size where a wrong measure or a stranded heading is
 * visible.
 *
 * So this drives `shoot.mjs` over a list, then composites the results into a sheet with each page
 * labelled. The individual full-resolution captures are kept, because the sheet is for spotting a
 * problem and the capture is for diagnosing it.
 *
 * ⚠ IT IS A HUMAN'S TOOL, NOT AN ASSERTION. There is no golden image and no diff: a typographic change
 * is SUPPOSED to change every page, so a pixel comparison would fail by design and teach nothing. What
 * this removes is the excuse for not looking.
 *
 * ⚠ AND IT IS NOT A SUBSTITUTE FOR `smoke`. A page that renders beautifully can still be serving a
 * draft record or answering 200 on a missing one. This sees appearance and nothing else.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * USAGE
 *   npx next start -p 3000 &
 *   node scripts/dev/sweep.mjs [--base http://127.0.0.1:3000] [--width 1440] [--print] [--dark] [--reduced-motion]
 *
 * Writes `.shots/sweep-<variant>/<name>.png` per page and `.shots/sweep-sheet-<variant>.jpg` as the
 * contact sheet, where <variant> is the width (or "print"). Read the desktop and phone sheets together:
 * a measure that is comfortable at 1440 can be four words a line at 390.
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

import sharp from "sharp";

/**
 * The pages worth a look, and why each is on the list.
 *
 * Deliberately not "every route": a sheet of forty tiles is as unreadable as no sheet. Each entry here
 * is the one page that would show a given class of problem first.
 */
const PAGES = [
  { name: "home", path: "/", why: "the hero, the narrative blocks, every showcase" },
  { name: "craft-detail", path: "/craft-explorer/patola", why: "long-form prose beside a photograph" },
  { name: "explorer", path: "/craft-explorer", why: "faceted filters, a map, a dense result list" },
  { name: "a-z", path: "/a-z", why: "the densest type on the site" },
  { name: "people", path: "/people", why: "a card grid with no photographs" },
  { name: "person", path: "/people/meera-ranganathan", why: "a profile — biography measure" },
  { name: "publications", path: "/publications", why: "citations, tabular figures, grouped headings" },
  { name: "news", path: "/news", why: "the newsroom index" },
  { name: "article", path: "/news/phulkari-exhibition-opens", why: "an article: the real reading test" },
  { name: "events", path: "/events", why: "date blocks and two states" },
  { name: "about", path: "/about", why: "a page built from blocks in the studio" },
  { name: "credits", path: "/credits", why: "long lists of small type" },
  { name: "accessibility", path: "/accessibility", why: "headings, prose and a contents list" },
  { name: "contact", path: "/contact", why: "a form" }
];

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const base = flag("base", "http://127.0.0.1:3000").replace(/\/$/, "");
const width = Number(flag("width", 1440));
const printMedia = argv.includes("--print");

/**
 * `--dark` and `--reduced-motion`, passed straight through to `shoot.mjs`.
 *
 * ⚠ THE DARK SHEET IS NOT A NICE-TO-HAVE. Five real bugs shipped on surfaces that are correct in the
 * light theme and unreadable in the dark one (defect class 15) — a white plate under white text on the
 * attribution chip, on both slider labels, on the map tooltip, and on the lightbox. Not one of them was
 * catchable by any gate in this repository, and none of them appeared in a screenshot, because every
 * screenshot ever taken here was light-theme. Fourteen pages in the dark theme, side by side, is the
 * cheapest way that class of fault ever becomes visible again.
 */
const darkTheme = argv.includes("--dark");
const reducedMotion = argv.includes("--reduced-motion");

/*
 * ⚠ THE OUTPUT PATHS CARRY THE WIDTH, so a desktop sweep and a phone sweep coexist instead of the
 * second silently overwriting the first. That matters more than it sounds: typographic faults are worst
 * at 390px — a measure that is comfortable at 1440 is four words a line on a phone — so the two sheets
 * are read together, and a tool that could only hold one of them would hide the harder half.
 */
const variant = [printMedia ? "print" : `${width}`, darkTheme ? "dark" : null, reducedMotion ? "reduced" : null]
  .filter(Boolean)
  .join("-");
const OUT_DIR = path.join(process.cwd(), ".shots", `sweep-${variant}`);
const SHEET = path.join(process.cwd(), ".shots", `sweep-sheet-${variant}.jpg`);

/** One capture, by shelling out to the tool that already knows how to do it properly. */
function capture(page) {
  return new Promise((resolve) => {
    const out = path.join(OUT_DIR, `${page.name}.png`);
    const args = [
      path.join("scripts", "dev", "shoot.mjs"),
      `${base}${page.path}`,
      out,
      String(width),
      "1000"
    ];
    if (printMedia) args.push("--print");
    if (darkTheme) args.push("--dark");
    if (reducedMotion) args.push("--reduced-motion");

    // ⚠ A FAILED CAPTURE MUST NOT STOP THE SWEEP. One page that hangs — a map, an unreachable tile —
    // would otherwise cost the other thirteen. It is reported and skipped, and the sheet says so.
    const child = spawn(process.execPath, args, { stdio: "ignore" });
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ ...page, out, ok: code === 0 });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ...page, out, ok: false });
    });
  });
}

/**
 * The contact sheet.
 *
 * Each tile is the TOP of its page rather than the whole scroll: a full-page capture of an article is
 * ten thousand pixels tall, and scaled into a tile it shows nothing at all. The top 1400px is where a
 * typographic problem announces itself.
 */
async function buildSheet(captured) {
  const TILE_W = 460;
  const TILE_H = 460;
  const COLS = 4;
  const LABEL_H = 22;
  const usable = captured.filter((page) => page.ok);

  if (usable.length === 0) {
    console.error("Nothing captured, so no sheet was written.");
    return;
  }

  const composites = [];
  for (const [index, page] of usable.entries()) {
    const meta = await sharp(page.out).metadata();
    const cropHeight = Math.min(1400, meta.height ?? 1400);

    // `fit: "cover"` from the TOP: the tile is filled by width and cropped by height, so a 390px phone
    // capture reads as a phone rather than sitting in a 460px tile with ground either side.
    const tile = await sharp(page.out)
      .extract({ left: 0, top: 0, width: meta.width ?? width, height: cropHeight })
      .resize({ width: TILE_W, height: TILE_H, fit: "cover", position: "top" })
      .toBuffer();

    const label = await sharp({
      create: {
        width: TILE_W,
        height: LABEL_H,
        channels: 3,
        background: "#1e1b2e"
      }
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="${TILE_W}" height="${LABEL_H}">
               <text x="6" y="15" font-family="sans-serif" font-size="12" fill="#f2f0f9">${page.name} — ${page.path}</text>
             </svg>`
          ),
          top: 0,
          left: 0
        }
      ])
      .png()
      .toBuffer();

    const col = index % COLS;
    const row = Math.floor(index / COLS);
    composites.push({ input: label, left: col * TILE_W, top: row * (TILE_H + LABEL_H) });
    composites.push({ input: tile, left: col * TILE_W, top: row * (TILE_H + LABEL_H) + LABEL_H });
  }

  const rows = Math.ceil(usable.length / COLS);
  await sharp({
    create: {
      width: TILE_W * COLS,
      height: rows * (TILE_H + LABEL_H),
      channels: 3,
      background: "#110f19"
    }
  })
    .composite(composites)
    .jpeg({ quality: 82 })
    .toFile(SHEET);

  console.log(`\nSheet: ${SHEET}  (${usable.length} of ${captured.length} pages, ${COLS} columns)`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const conditions = [
    printMedia ? "print media" : null,
    darkTheme ? "DARK theme" : null,
    reducedMotion ? "reduced motion" : null
  ].filter(Boolean);
  console.log(
    `Sweeping ${PAGES.length} pages at ${width}px${conditions.length > 0 ? ` — ${conditions.join(", ")}` : ""}…\n`
  );

  const captured = [];
  for (const page of PAGES) {
    // Sequential, deliberately: each capture launches its own Chrome, and fourteen at once would
    // contend for CPU badly enough to change what the animations look like when the shutter opens.
    const result = await capture(page);
    captured.push(result);
    console.log(`  ${result.ok ? "ok  " : "FAIL"} ${result.name.padEnd(14)} ${result.path}`);
  }

  const failed = captured.filter((page) => !page.ok);
  await buildSheet(captured);

  if (failed.length > 0) {
    console.error(`\n⚠ ${failed.length} page(s) could not be captured and are ABSENT from the sheet:`);
    for (const page of failed) console.error(`    ${page.name} — ${page.path}`);
    // Non-zero, because a sheet missing a page silently is a sheet that says the site is fine when
    // one of its pages could not even be rendered.
    process.exitCode = 1;
  }
}

await main();
