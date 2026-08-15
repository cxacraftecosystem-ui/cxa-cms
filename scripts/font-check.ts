/**
 * font-check — the type library on disk must match the type library the code believes in.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS: A LICENCE OBLIGATION THAT NOTHING ENFORCES IS AN OBLIGATION THAT LAPSES.
 *
 * `lib/typography/fonts.ts` is GENERATED, and every fact in it — a file's path, its byte count, its
 * hash, its licence — describes bytes on disk that nothing checks again. That is a manifest, and a
 * manifest is a claim. Delete `fonts/lora-latin-var.woff2` and TypeScript still compiles, `eslint`
 * still passes, `next build` still succeeds, and the first person to notice is a reader who gets
 * Georgia where Lora was specified — with no error anywhere, because a missing `@font-face` src is a
 * silent fallback by design.
 *
 * The licence half is worse, because it fails in the other direction: the fonts keep working
 * perfectly while the repository quietly stops complying. The SIL Open Font License permits
 * redistribution "provided that each copy contains the above copyright notice and this license"
 * (OFL-1.1 §2). This repository ships 22 font binaries. For a long time it shipped them with the
 * string `"OFL-1.1"` in a TypeScript file and a URL pointing at the licence's website — which is a
 * REFERENCE to a licence, not a copy of one, and contains no copyright notice at all. Nothing was
 * wrong on screen. Nothing could be.
 *
 * ⚠ SO THE POINT OF THIS SCRIPT IS NOT THE BYTE COUNTS. It is that "the licence travels with the
 * files" becomes an assertion that can FAIL, in the same way `leak-check` turned "drafts must not
 * leak" into one. Prose in a header decays; a check that exits non-zero does not.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ IT IS OFFLINE AND FAST, deliberately — it belongs in `npm run check` beside `route-check`, and a
 * gate that reaches the network is a gate that fails on a train. `scripts/fetch-fonts.ts` is the one
 * that talks to Fontsource; this only ever reads what that wrote. The two overlap on purpose: the
 * fetcher checks `app/layout.tsx` in far more detail (weight ranges, the exact `localFont()` block)
 * but only when somebody runs it, which may be months apart.
 *
 *     npx tsx scripts/font-check.ts        # or: npm run font-check
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { FONT_FACES, TYPE_LIBRARY_BYTES } from "../lib/typography/fonts";

const ROOT = process.cwd();
const FONT_DIR = path.join(ROOT, "fonts");
const LICENCE_DIR = path.join(FONT_DIR, "licences");

const problems: string[] = [];
/** Every assertion actually evaluated. The guard against a run that checks nothing and says PASS. */
let checks = 0;

function check(condition: boolean, message: string): void {
  checks += 1;
  if (!condition) problems.push(message);
}

function readIfPresent(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The manifest is not empty
// ─────────────────────────────────────────────────────────────────────────────
//
// First, because every loop below is vacuously true over an empty roster — which is exactly how the
// first version of `leak-check`'s social-card probe reported success while testing nothing.
check(FONT_FACES.length > 0, "lib/typography/fonts.ts declares no faces at all");

// ─────────────────────────────────────────────────────────────────────────────
// 2. Every declared file exists, and is the file the manifest describes
// ─────────────────────────────────────────────────────────────────────────────

/** Declared paths, to find files on disk that no face claims. */
const declared = new Set<string>();

for (const face of FONT_FACES) {
  const label = `${face.id} (${face.family})`;

  check(face.files.length > 0, `${label}: declares no files`);

  let declaredBytes = 0;
  for (const file of face.files) {
    declared.add(path.normalize(file.path));
    const absolute = path.join(ROOT, file.path);

    let bytes: Buffer | null = null;
    try {
      bytes = readFileSync(absolute);
    } catch {
      /* reported below */
    }

    if (!bytes) {
      check(false, `${label}: ${file.path} is declared in the manifest but is NOT ON DISK`);
      continue;
    }

    declaredBytes += file.bytes;
    check(
      bytes.length === file.bytes,
      `${label}: ${file.path} is ${bytes.length} bytes, manifest says ${file.bytes}`
    );

    // The hash is what distinguishes "the file is there" from "the file is the one that was measured".
    // A truncated download and a replaced face both pass a byte-count check often enough to matter.
    const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    check(sha === file.sha256, `${label}: ${file.path} hashes to ${sha}, manifest says ${file.sha256}`);

    // jsDelivr answers a miss with an HTML page and HTTP 200, so a "font" on disk may be a web page.
    check(
      bytes.subarray(0, 4).toString("latin1") === "wOF2",
      `${label}: ${file.path} is not a WOFF2 file (signature "${bytes.subarray(0, 4).toString("latin1")}")`
    );
  }

  check(
    face.bytes === declaredBytes,
    `${label}: face.bytes is ${face.bytes} but its files sum to ${declaredBytes}`
  );

  // ── internal consistency of the row itself ──────────────────────────────────
  check(
    face.weightRange === `${face.weightMin} ${face.weightMax}`,
    `${label}: weightRange "${face.weightRange}" disagrees with weightMin/Max ${face.weightMin}/${face.weightMax}`
  );
  check(
    face.fontClass === `font-${face.tailwindKey}`,
    `${label}: fontClass "${face.fontClass}" is not "font-${face.tailwindKey}"`
  );

  // `hasTrueItalic` is what a block consults before setting a book title. If it lies in the optimistic
  // direction, an <em> silently becomes a browser-synthesised slant on a serif, which shears the
  // strokes instead of redrawing them — the exact thing the field exists to prevent.
  const italicOnDisk = face.files.some((file) => file.style === "italic");
  check(
    face.hasTrueItalic === italicOnDisk,
    `${label}: hasTrueItalic is ${face.hasTrueItalic} but an italic file is ${italicOnDisk ? "present" : "absent"}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE LICENCE OBLIGATION
// ─────────────────────────────────────────────────────────────────────────────

const licenceIndex = readIfPresent(path.join(LICENCE_DIR, "README.md"));
check(licenceIndex !== null, "fonts/licences/README.md is missing — the licence index is not shipped");

for (const face of FONT_FACES) {
  const label = `${face.id} (${face.family})`;

  // The manifest must still SAY what the licence is...
  check(face.licence.trim().length > 0, `${label}: no licence recorded in the manifest`);
  check(face.licenceUrl.trim().length > 0, `${label}: no licenceUrl recorded in the manifest`);
  check(face.upstream.trim().length > 0, `${label}: no upstream recorded in the manifest`);

  // ...and the licence TEXT must ship beside the fonts, which is the part §2 actually asks for.
  const text = readIfPresent(path.join(LICENCE_DIR, `${face.id}.txt`));
  if (text === null) {
    check(
      false,
      `${label}: fonts/licences/${face.id}.txt IS MISSING. The OFL permits redistribution only if ` +
        `each copy carries the notice and the licence; run "npx tsx scripts/fetch-fonts.ts --licences"`
    );
    continue;
  }

  check(
    text.length >= 1000,
    `${label}: fonts/licences/${face.id}.txt is only ${text.length} bytes — truncated, not a licence`
  );

  const upper = text.toUpperCase();
  const names =
    face.licence === "Apache-2.0" ? upper.includes("APACHE LICENSE") : upper.includes("SIL OPEN FONT LICENSE");
  check(
    names,
    `${label}: fonts/licences/${face.id}.txt does not contain the ${face.licence} text it is supposed to be`
  );

  // The index is what a person reads instead of twelve near-identical files, so a face missing from it
  // is a face nobody will find the attribution for.
  if (licenceIndex !== null) {
    check(
      licenceIndex.includes(`./${face.id}.txt`),
      `${label}: not listed in fonts/licences/README.md`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Nothing on disk is undeclared
// ─────────────────────────────────────────────────────────────────────────────
//
// The opposite direction, and the one a manifest can never catch by itself: a `.woff2` that no face
// claims is either a face somebody forgot to declare (so it is downloaded by nobody and does nothing)
// or a font being redistributed with no licence record at all. Both are worth a failure.

let onDisk: string[] = [];
try {
  onDisk = readdirSync(FONT_DIR).filter((name) => name.endsWith(".woff2"));
} catch {
  check(false, "fonts/ does not exist");
}

for (const name of onDisk) {
  check(
    declared.has(path.normalize(`fonts/${name}`)),
    `fonts/${name} is on disk but NO face in the manifest declares it`
  );
}

// And the same for licence texts, so a removed face does not leave its licence behind looking current.
const faceIds = new Set(FONT_FACES.map((face) => face.id));
try {
  for (const name of readdirSync(LICENCE_DIR)) {
    if (!name.endsWith(".txt")) continue;
    check(
      faceIds.has(name.replace(/\.txt$/, "")),
      `fonts/licences/${name} has no matching face in the manifest`
    );
  }
} catch {
  check(false, "fonts/licences/ does not exist — no licence text is shipped for any face");
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. The declared total, and the two files that must agree with the manifest
// ─────────────────────────────────────────────────────────────────────────────

const summed = FONT_FACES.reduce((total, face) => total + face.bytes, 0);
check(
  TYPE_LIBRARY_BYTES === summed,
  `TYPE_LIBRARY_BYTES is ${TYPE_LIBRARY_BYTES} but the faces sum to ${summed}`
);

/*
 * ⚠ A FACE THE LAYOUT DOES NOT DECLARE IS A PICKER OPTION THAT RENDERS AS A FALLBACK, silently.
 * `next/font/local` refuses non-literal arguments, so every face has to be typed out by hand in
 * `app/layout.tsx` — which means it can be forgotten, and nothing downstream would say so. Likewise a
 * `tailwindKey` with no entry in `tailwind.config.ts` compiles `font-lora` to nothing at all.
 *
 * This is the cheap half of the check the fetcher does properly; it is here because it costs a
 * millisecond and the fetcher only runs when somebody deliberately runs it.
 */
const layout = readIfPresent(path.join(ROOT, "app", "layout.tsx"));
const tailwind = readIfPresent(path.join(ROOT, "tailwind.config.ts"));
check(layout !== null, "app/layout.tsx could not be read");
check(tailwind !== null, "tailwind.config.ts could not be read");

for (const face of FONT_FACES) {
  if (layout !== null) {
    check(
      layout.includes(face.cssVariable),
      `${face.id}: ${face.cssVariable} is never declared in app/layout.tsx — the face would render as a fallback`
    );
  }
  if (tailwind !== null) {
    check(
      new RegExp(`["']?${face.tailwindKey}["']?\\s*:`).test(tailwind),
      `${face.id}: fontFamily key "${face.tailwindKey}" is absent from tailwind.config.ts — "${face.fontClass}" compiles to nothing`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

const italics = FONT_FACES.filter((face) => face.hasTrueItalic).length;
const files = FONT_FACES.reduce((total, face) => total + face.files.length, 0);

console.log(
  `font-check — ${FONT_FACES.length} faces, ${files} files, ${italics} with a true italic, ` +
    `${(TYPE_LIBRARY_BYTES / 1024).toFixed(0)} KB, ${checks} assertions`
);

if (problems.length > 0) {
  console.error(`\nFAIL — ${problems.length} problem(s):\n`);
  for (const problem of problems) console.error(`  • ${problem}`);
  console.error("");
  process.exit(1);
}

// A run that asserted almost nothing is not a pass, whatever it printed. The threshold is deliberately
// far below the real count (~230) and only catches the case where the manifest emptied out.
if (checks < 20) {
  console.error(`\nFAIL — only ${checks} assertions ran. Something is wrong with this script, not the fonts.`);
  process.exit(1);
}

console.log("PASS — every declared face is on disk, hashes match, and every licence ships with it.");
