/**
 * The type library fetcher.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IT DOES AND WHY IT IS A SCRIPT RATHER THAN TWELVE DOWNLOADS.
 *
 * The site shipped with exactly two faces — Inter for everything read as interface, Plus Jakarta Sans
 * for everything read as a heading — and no serif at all. That is a perfectly respectable pair for an
 * application and a poor one for a publisher: a page about craft that is set entirely in a neutral
 * screen sans reads as a dashboard, an `<em>` in Inter is a slant the browser invents, and there is no
 * face in the building that can set a book title, a pull quote or a column of citations properly.
 *
 * So this script builds a real library: ten more variable faces, all local, chosen so that each one
 * answers an editorial question the others cannot.
 *
 * A download is not the hard part. **THE LICENCE IS.** A font is somebody's work under somebody's
 * terms, exactly like a photograph, and a face shipped without checking its terms is the same class of
 * mistake as publishing a picture nobody may republish — except that a font is harder to notice,
 * because it arrives as a file nobody looks at again. `ACCEPTABLE_LICENCES` below is therefore an
 * ALLOWLIST, not a blocklist: a licence string this script has never seen is REFUSED rather than
 * assumed to be fine, and the licence it did see is written into the generated manifest beside the
 * face so that six months from now the answer to "may we use this?" is in the repository.
 *
 * ⚠ NO FACE IS EVER LOADED FROM A REMOTE HOST AT RUN TIME. This script is the only thing that touches
 * the network, it runs on a developer's machine, and what it leaves behind is a `.woff2` in `fonts/`
 * that `next/font/local` self-hosts. A Google-hosted `@font-face` would be a render-blocking
 * dependency on somebody else's uptime on every page, and a third party told the IP address of every
 * reader of an institutional site. See CONTRACT.md §2.
 *
 * WHY FONTSOURCE OVER JSDELIVR. Fontsource publishes the Google Fonts corpus as npm packages with a
 * machine-readable licence field and per-subset, per-axis `.woff2` builds. We take the `:vf` package's
 * `latin-wght-<style>.woff2` — the Latin subset of the weight axis — because that is one file per
 * style covering every weight the design system can ask for, at roughly the size of two static cuts.
 *
 * ⚠ `latin-wght-normal.woff2` CARRIES THE WEIGHT AXIS AND NOTHING ELSE. Several of these families have
 * more axes upstream — Fraunces has SOFT, WONK and optical size; Archivo has width; Source Serif and
 * Newsreader have optical size — and NONE of them are in the file we ship. `font-variation-settings`
 * for those axes is silently ignored. The manifest records this per face in `cautions` so that a
 * designer reading the family's specimen page does not spend an afternoon on an axis that is not here.
 *
 * ⚠ VARIABLE ONLY, BY REFUSAL. A family with no variable build is rejected with an explanation rather
 * than quietly downgraded to a static 400 — `ibm-plex-mono` and `barlow-condensed` were both on the
 * shortlist and both fail this check. A static cut would make `font-semibold` a synthetic smear on a
 * face the manifest advertises as having nine weights, which is worse than not offering the face.
 *
 * ⚠ IT IS DELIBERATELY NOT PART OF `npm run build`. It reaches the public internet, it is slow, and it
 * writes files that are then committed. Run it by hand when the library should change:
 *
 *     npx tsx scripts/fetch-fonts.ts                  # fetch every face whose file is missing
 *     npx tsx scripts/fetch-fonts.ts --force          # re-fetch everything, even if present
 *     npx tsx scripts/fetch-fonts.ts fraunces lora    # named faces only, always re-fetched
 *     npx tsx scripts/fetch-fonts.ts --licences       # licence texts ONLY; writes no manifest
 *
 * WHAT IT WRITES
 *   fonts/<id>-latin-var.woff2           the roman
 *   fonts/<id>-latin-var-italic.woff2    the true italic, where the family has one
 *   fonts/licences/<id>.txt              THE FULL LICENCE TEXT AND COPYRIGHT NOTICE — see below
 *   fonts/licences/README.md             the index a person reads first
 *   lib/typography/fonts.ts              the generated manifest: what each face IS, and what it is FOR
 *
 * WHAT IT CHECKS BUT DOES NOT WRITE
 *   app/layout.tsx — every face in the manifest must be declared there with the same CSS variable and
 *   the same weight range, or the picker offers a font that renders as a fallback. See `checkLayout`.
 *
 * ⚠ THE MANIFEST IS GENERATED AND MUST NOT BE EDITED BY HAND. Its header says so too. The editorial
 * prose in it — the sentence an administrator reads in a picker — lives in `ROSTER` below, which is
 * the file to edit when a description is wrong.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const FONTSOURCE_API = "https://api.fontsource.org/v1";
const JSDELIVR = "https://cdn.jsdelivr.net/fontsource/fonts";

/**
 * Where a family's LICENCE TEXT comes from — a different host from the fonts themselves.
 *
 * ⚠ THIS IS NOT THE SAME THING AS `ACCEPTABLE_LICENCES`, AND CONFUSING THE TWO IS THE BUG THIS
 * BLOCK EXISTS TO CLOSE. That map records WHICH licence a face is under and a URL where its terms can
 * be read. Recording a name and a link is a REFERENCE to a licence. The OFL asks for something
 * stronger: OFL-1.1 §2 permits redistribution "provided that each copy contains the above copyright
 * notice and this license" — the notice AND the text, travelling with the files. A URL in a
 * TypeScript manifest is neither, and the per-family copyright line ("Copyright 2011 The Lora Project
 * Authors…") appears nowhere in a manifest that only stores the string "OFL-1.1".
 *
 * So the licence text is fetched and committed beside the `.woff2` files it covers. §2 explicitly
 * allows "text files", which is exactly what `fonts/licences/<id>.txt` is.
 *
 * The npm package is the source rather than the `:vf` font CDN path, because the font path serves
 * only the binaries. Every Fontsource package ships the upstream LICENSE verbatim, which is where the
 * per-family copyright line lives.
 */
const FONTSOURCE_PACKAGE = "https://cdn.jsdelivr.net/npm/@fontsource-variable";

/**
 * The two bundled faces have no Fontsource package (see the `origin === "bundled"` note in `main`), so
 * their licence comes from the upstream project that publishes it. Both verified to return the full
 * OFL text with a leading copyright line.
 */
const BUNDLED_LICENCE_SOURCES: Readonly<Record<string, string>> = {
  inter: "https://raw.githubusercontent.com/rsms/inter/master/LICENSE.txt",
  jakarta: "https://raw.githubusercontent.com/tokotype/PlusJakartaSans/master/OFL.txt"
};

/**
 * Fontsource's API is a donated service in front of jsDelivr. Identifying the client and saying how to
 * reach it is the courtesy every automated consumer of a free API owes it.
 */
const USER_AGENT =
  "CxA-Portal-Fonts/1.0 (https://github.com/cxa-portal; ankit@chartmateapp.com) node-fetch";

/**
 * The licences this site may ship a face under.
 *
 * AN ALLOWLIST. Both entries are licences that permit self-hosting and redistribution inside a product
 * without a per-domain grant, which is exactly what committing a `.woff2` to this repository does.
 * A string that is not one of these — including one that merely looks free, and including the several
 * "free for personal use" spellings that circulate — is refused.
 *
 * `attribution` records whether the licence obliges a visible credit. Neither of these does: the OFL
 * requires the licence to travel with the font FILES (see `runLicences`, which fetches the text and the
 * per-family copyright notice into `fonts/licences/`), not a credit line on the page. That is a real
 * difference from the imagery fetcher, whose CC BY photographs must be credited where they appear.
 */
const ACCEPTABLE_LICENCES = new Map<string, { url: string; attribution: boolean }>([
  ["OFL-1.1", { url: "https://openfontlicense.org/open-font-license-official-text/", attribution: false }],
  ["Apache-2.0", { url: "https://www.apache.org/licenses/LICENSE-2.0", attribution: false }]
]);

// ─────────────────────────────────────────────────────────────────────────────
// The roster — hand-authored. Everything a person decided lives here.
// ─────────────────────────────────────────────────────────────────────────────

type FontRole = "serif-text" | "serif-display" | "sans" | "condensed" | "mono";
type FontUsage = "heading" | "body" | "eyebrow" | "quote" | "caption" | "figures";

interface Editorial {
  /** Fontsource id for fetched faces; a stable slug for the two already in `fonts/`. Manifest key. */
  id: string;
  /** Which group this face sits in, in a picker. */
  role: FontRole;
  /**
   * What this face may be used FOR — the filter a picker needs to stop somebody setting a 68-character
   * measure of body copy in a didone display serif. Ordered most to least suitable.
   */
  usage: readonly FontUsage[];
  /** The custom property `next/font/local` writes, e.g. `--font-lora`. */
  cssVariable: string;
  /**
   * The COMPLETE, LITERAL Tailwind class that selects this face.
   *
   * ⚠ Literal on purpose. `font-${key}` is built at run time, never appears in the source Tailwind
   * scans, and is purged — so the class silently does nothing (CONTRACT.md §5). A picker must emit one
   * of these strings verbatim.
   */
  fontClass: string;
  /** The `theme.extend.fontFamily` key in tailwind.config.ts that `fontClass` comes from. */
  tailwindKey: string;
  /**
   * THE SENTENCE AN ADMINISTRATOR READS IN THE PICKER. What this face is for, and when to choose it
   * over its neighbours — not what it looks like. "A text serif with a large x-height" is a fact;
   * "the safest default when a page should read as a document" is the sentence that gets it chosen.
   */
  purpose: string;
  /**
   * What this face cannot do, in the same voice. `null` where there is nothing to warn about.
   *
   * Weight limits are NOT stated here — they are in `weightMin`/`weightMax`, which `weightsFor()`
   * turns into the only weights a picker offers, so a person never meets the limit as a surprise.
   */
  cautions: string | null;
  /**
   * Whether `app/layout.tsx` preloads it. See the cost note in that file: the two original faces are
   * preloaded because every page is set in them; every added face is `preload: false` because it is
   * opt-in per block, and a preload for a face a page does not use is bytes spent for nothing.
   */
  preload: boolean;
}

type RosterEntry = Editorial &
  (
    | { origin: "fontsource" }
    /**
     * Already in `fonts/`, fetched by nobody, and therefore described by hand. The script still hashes
     * and measures the files so the manifest describes all twelve faces identically — a picker cannot
     * offer Inter if Inter is not in the manifest, and the manifest is the only place a face is
     * described.
     */
    | {
        origin: "bundled";
        family: string;
        licence: string;
        upstream: string;
        weightRange: string;
        romanFile: string;
        italicFile: string | null;
      }
  );

const ROSTER: readonly RosterEntry[] = [
  // ── The two faces that were already here ──────────────────────────────────
  {
    origin: "bundled",
    id: "inter",
    family: "Inter",
    licence: "OFL-1.1",
    upstream: "https://github.com/rsms/inter",
    weightRange: "100 900",
    romanFile: "inter-latin-var.woff2",
    italicFile: null,
    role: "sans",
    usage: ["body", "caption", "heading", "eyebrow"],
    cssVariable: "--font-inter",
    fontClass: "font-sans",
    tailwindKey: "sans",
    purpose:
      "The default voice of the whole site: a neutral screen sans with a tall x-height that is still legible at 13px in a table cell. Choose it when the type should not be noticed.",
    cautions:
      "No italic file ships for Inter, so an emphasis inside an Inter passage is a slant the browser invents rather than a drawn italic. A passage that has to set book titles, ship names or species names should be set in a serif that has a true italic.",
    preload: true
  },
  {
    origin: "bundled",
    id: "jakarta",
    family: "Plus Jakarta Sans",
    licence: "OFL-1.1",
    upstream: "https://github.com/tokotype/PlusJakartaSans",
    weightRange: "200 800",
    romanFile: "jakarta-latin-var.woff2",
    italicFile: null,
    role: "sans",
    usage: ["heading", "eyebrow"],
    cssVariable: "--font-jakarta",
    fontClass: "font-display",
    tailwindKey: "display",
    purpose:
      "The heading face of the institutional voice — geometric, a little narrower than Inter, so a headline reads as a headline without a change of colour or weight. This is what `.display-title` sets.",
    cautions:
      "The Tailwind key `font-serif` is an alias of THIS face and is not a serif at all — a legacy slot kept so existing markup keeps working (CONTRACT.md §14). Never reach for `font-serif` expecting a serif; name one of the serif faces below. Like Inter, it ships without an italic.",
    preload: true
  },

  // ── Text serifs. The reading half of the site, and the gap that mattered most ──
  {
    origin: "fontsource",
    id: "source-serif-4",
    role: "serif-text",
    usage: ["body", "quote", "heading"],
    cssVariable: "--font-source-serif",
    fontClass: "font-source-serif",
    tailwindKey: "source-serif",
    purpose:
      "A text serif with a large x-height and open counters — the most comfortable of these for a long passage on a screen, and the safest choice when a page should read as a document rather than as an interface.",
    cautions:
      "The file shipped here carries the weight axis only; Source Serif's optical-size axis is not in it, so a 48px heading does not automatically get the finer, higher-contrast drawing the family has for display sizes.",
    preload: true
  },
  {
    origin: "fontsource",
    id: "newsreader",
    role: "serif-text",
    usage: ["body", "heading", "quote"],
    cssVariable: "--font-newsreader",
    fontClass: "font-newsreader",
    tailwindKey: "newsreader",
    purpose:
      "A low-contrast serif drawn for news screens: sturdier than Source Serif at small sizes and a little narrower, so more words fit the line. Choose it for news, announcements and anything read once and quickly.",
    cautions:
      "Its optical-size axis is not in the shipped file, and its default drawing is tuned for text — set very large it looks slightly plain beside a display serif.",
    preload: false
  },
  {
    origin: "fontsource",
    id: "lora",
    role: "serif-text",
    usage: ["body", "quote", "heading"],
    cssVariable: "--font-lora",
    fontClass: "font-lora",
    tailwindKey: "lora",
    purpose:
      "A warm serif with brushed, calligraphic detail. It gives a page a made-by-hand quality that suits writing about craft, and it holds up for an essay set at 17–19px. Its italic is the most expressive in the library.",
    cautions: null,
    preload: false
  },
  {
    origin: "fontsource",
    id: "crimson-pro",
    role: "serif-text",
    usage: ["quote", "body", "heading"],
    cssVariable: "--font-crimson",
    fontClass: "font-crimson",
    tailwindKey: "crimson",
    purpose:
      "A book serif in the old-style tradition — small x-height, long ascenders, the most literary face here. It wants size and space: excellent for a pull quote or an essay set at 19px and up, pale and cramped below 16px.",
    cautions:
      "Because the x-height is small, Crimson Pro set at the same pixel size as Inter or Source Serif looks noticeably smaller. Set it one or two steps larger than you would set them, or it reads as timid rather than elegant.",
    preload: false
  },

  // ── Display serifs. Headline character, never a paragraph ──────────────────
  {
    origin: "fontsource",
    id: "fraunces",
    role: "serif-display",
    usage: ["heading", "quote"],
    cssVariable: "--font-fraunces",
    fontClass: "font-fraunces",
    tailwindKey: "fraunces",
    purpose:
      "A display serif with real character — soft, slightly wonky forms that carry an institutional identity without looking corporate. Use it for a page title or a section opener; never for a paragraph.",
    cautions:
      "Fraunces' SOFT, WONK and optical-size axes are NOT in the file shipped here — the Fontsource variable build exposes weight only — so `font-variation-settings` for them does nothing at all. What you get is the weight axis at the family's default softness.",
    preload: false
  },
  {
    origin: "fontsource",
    id: "playfair-display",
    role: "serif-display",
    usage: ["heading", "quote"],
    cssVariable: "--font-playfair",
    fontClass: "font-playfair",
    tailwindKey: "playfair",
    purpose:
      "A high-contrast didone for headlines with a formal, printed feel — hairline thins against heavy stems. The most ceremonial face in the library, and the right one for a citation, an award or a founding date.",
    cautions:
      "It needs size. Below about 24px the thin strokes thin out to nothing on a low-resolution screen, and the headline looks broken rather than fine. Never set body copy in it.",
    preload: false
  },

  // ── Sans alternatives to Inter ────────────────────────────────────────────
  {
    origin: "fontsource",
    id: "work-sans",
    role: "sans",
    usage: ["heading", "body", "eyebrow", "caption"],
    cssVariable: "--font-work-sans",
    fontClass: "font-work-sans",
    tailwindKey: "work-sans",
    purpose:
      "A humanist sans with more warmth than Inter and a slightly irregular rhythm that reads well at paragraph length. The alternative when a page should sound spoken rather than specified — and it has a true italic, which Inter does not.",
    cautions: null,
    preload: false
  },
  {
    origin: "fontsource",
    id: "figtree",
    role: "sans",
    usage: ["heading", "body", "eyebrow"],
    cssVariable: "--font-figtree",
    fontClass: "font-figtree",
    tailwindKey: "figtree",
    purpose:
      "A geometric sans with round, even forms and a friendly cast — the most contemporary face here. Good as a heading over a serif body, and usable for short body copy where Inter would feel institutional.",
    cautions:
      "Its even, circular forms make long paragraphs monotonous; past three or four lines the letters stop giving the eye anything to hold on to. Keep it above the fold.",
    preload: false
  },

  // ── Condensed. Eyebrows, labels, table headers ────────────────────────────
  {
    origin: "fontsource",
    id: "archivo-narrow",
    role: "condensed",
    usage: ["eyebrow", "caption", "heading"],
    cssVariable: "--font-archivo-narrow",
    fontClass: "font-archivo-narrow",
    tailwindKey: "archivo-narrow",
    purpose:
      "A condensed grotesque for eyebrows, small uppercase labels, table headers and captions: it fits a long label into a narrow column without shrinking the type. Pair it with wide letter-spacing when setting uppercase.",
    cautions:
      "It has no drawn small-caps set, so `font-variant-caps: small-caps` is synthesised from shrunken capitals and looks uneven at any size. Set uppercase with tracking instead — that is what `.eyebrow` already does.",
    preload: false
  },

  // ── Monospace. Citations, identifiers, anything that must line up ──────────
  {
    origin: "fontsource",
    id: "jetbrains-mono",
    role: "mono",
    usage: ["figures", "caption", "body"],
    cssVariable: "--font-jetbrains-mono",
    fontClass: "font-jetbrains-mono",
    tailwindKey: "jetbrains-mono",
    purpose:
      "A monospace with tabular figures, for citations, DOIs, accession numbers, file paths, code and any column of numbers that has to line up. Every figure is the same width at every weight, so a total does not shift when a row is emphasised.",
    cautions:
      "⚠ The `font-mono` Tailwind key does NOT resolve to this face. It points at `--font-mono`, which nothing in the project defines, so `font-mono` renders as the reader's system monospace. Use `font-jetbrains-mono` to actually get this file. And it is a code face: at paragraph length it is tiring — set the figures and the identifiers in it, not the prose around them.",
    preload: false
  }
];

// ─────────────────────────────────────────────────────────────────────────────
// Pairings — the "sensible default" half of the brief
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Twelve faces is a pile of switches until somebody says which ones go together.
 *
 * Each pairing is a complete, checked answer to "how should this page be set?": a heading face, a body
 * face and an accent face for eyebrows, labels and figures. They exist so that the first thing an
 * administrator meets is six named settings rather than twelve dropdowns, and so that the twelve
 * dropdowns remain available for the person who knows what they want.
 *
 * ⚠ Every id here is checked against `ROSTER` before the manifest is written. A pairing pointing at a
 * face that is not in the library would be a picker that crashes on the option nobody tested.
 */
interface Pairing {
  id: string;
  label: string;
  description: string;
  headingFaceId: string;
  bodyFaceId: string;
  accentFaceId: string;
}

const PAIRINGS: readonly Pairing[] = [
  {
    id: "institutional",
    label: "Institutional",
    description:
      "The Centre's own voice, and what every page is set in unless somebody changes it. Calm, current, and invisible — the right choice for anything that must not look like a campaign.",
    headingFaceId: "jakarta",
    bodyFaceId: "inter",
    accentFaceId: "archivo-narrow"
  },
  {
    id: "editorial",
    label: "Editorial feature",
    description:
      "A magazine feature: a display serif with personality over the most readable text serif in the library. For a long piece somebody is meant to sit down with — a field report, an essay, a craft profile.",
    headingFaceId: "fraunces",
    bodyFaceId: "source-serif-4",
    accentFaceId: "archivo-narrow"
  },
  {
    id: "scholarly",
    label: "Scholarly",
    description:
      "Formal and printed: a didone headline over an old-style book serif. For research pages, publications and anything that should look like it was typeset rather than laid out. Set the body a step larger than usual.",
    headingFaceId: "playfair-display",
    bodyFaceId: "crimson-pro",
    accentFaceId: "archivo-narrow"
  },
  {
    id: "reportage",
    label: "Reportage",
    description:
      "A humanist sans headline over a news serif — plain, quick and dated-feeling in the good sense. For news, announcements and event pages that are read once.",
    headingFaceId: "work-sans",
    bodyFaceId: "newsreader",
    accentFaceId: "archivo-narrow"
  },
  {
    id: "catalogue",
    label: "Catalogue",
    description:
      "Built for lists: a condensed heading, a neutral body and a monospace for the figures, so accession numbers, dimensions and dates align down the column. For the archive, specimen listings and anything mostly made of small labels.",
    headingFaceId: "archivo-narrow",
    bodyFaceId: "inter",
    accentFaceId: "jetbrains-mono"
  },
  {
    id: "contemporary",
    label: "Contemporary",
    description:
      "A geometric sans over a warm, brushed serif — the most modern setting here without turning cold. For landing pages and programme pages where the writing about craft should still feel hand-made.",
    headingFaceId: "figtree",
    bodyFaceId: "lora",
    accentFaceId: "archivo-narrow"
  }
];

const DEFAULT_PAIRING_ID = "institutional";

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const FONT_DIR = path.join(REPO_ROOT, "fonts");
const MANIFEST_PATH = path.join(REPO_ROOT, "lib", "typography", "fonts.ts");
const LAYOUT_PATH = path.join(REPO_ROOT, "app", "layout.tsx");

/**
 * What the OFL asks to travel with the files. Written into the manifest header, once, for all faces.
 *
 * Pre-wrapped, because it is emitted into a comment block: a single long line would leave the generated
 * file failing the 110-column shape every other file in this repository keeps.
 */
const LICENCE_NOTE = [
  "Every face here is under a licence that permits self-hosting and redistribution inside a product.",
  "The SIL Open Font License asks that its terms travel with the font FILES rather than appearing on",
  "the page — so unlike the CC BY photographs in lib/media/craft-imagery.ts, whose licence obliges",
  "attribution to the READER and which are credited on /credits, nothing here has to be rendered.",
  "⚠ THE FIELDS BELOW ARE NOT THAT OBLIGATION, THOUGH, AND AN EARLIER VERSION OF THIS NOTE CLAIMED",
  "THEY WERE. `licence` and `licenceUrl` are a NAME and a LINK; OFL-1.1 §2 permits redistribution",
  "\"provided that each copy contains the above copyright notice and this license\" — a copy of the",
  "text, plus a per-family copyright line that the string \"OFL-1.1\" does not contain. The licences",
  "therefore ship as files, in fonts/licences/, one per face plus a README indexing the notices.",
  "`npm run font-check` fails if one is missing, truncated, or is not the licence it claims to be."
];

// ─────────────────────────────────────────────────────────────────────────────
// The facts the network knows
// ─────────────────────────────────────────────────────────────────────────────

/** One shipped file. `bytes`/`sha256` describe what is on disk, so a re-run can tell changed from same. */
interface FaceFile {
  /** Repo-relative, forward slashes — it is quoted into the manifest and read by a human. */
  path: string;
  style: "normal" | "italic";
  bytes: number;
  sha256: string;
}

/** Everything the manifest carries that a person did not decide. */
interface Facts {
  family: string;
  licence: string;
  licenceUrl: string;
  upstream: string;
  version: string;
  weightRange: string;
  weightMin: number;
  weightMax: number;
  hasTrueItalic: boolean;
  files: FaceFile[];
}

interface FontsourceMeta {
  family?: string;
  license?: string;
  source?: string;
  version?: string;
  subsets?: string[];
  styles?: string[];
}

interface VariableMeta {
  axes?: Record<string, { min?: string; max?: string; default?: string } | undefined>;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" }
  });
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return (await response.json()) as T;
}

/**
 * Read the family's metadata and its variable axes, and REFUSE anything that fails a rule.
 *
 * The three refusals, in the order that matters:
 *
 *  1. **Licence not on the allowlist** — the reason this script exists. Refused loudly.
 *  2. **No variable build** — refused rather than downgraded to a static cut, because the manifest
 *     would then advertise a weight range the file cannot produce and every intermediate weight would
 *     be a synthetic smear. `ibm-plex-mono` and `barlow-condensed` both land here.
 *  3. **No Latin subset** — we only ever fetch `latin-*`, so a family without one would produce a
 *     404 two steps later, at download time, with a far less useful message.
 */
async function describe(id: string): Promise<{ meta: FontsourceMeta; weight: { min: number; max: number }; italic: boolean }> {
  const meta = await fetchJson<FontsourceMeta>(`${FONTSOURCE_API}/fonts/${id}`);

  const licence = meta.license ?? "";
  if (!ACCEPTABLE_LICENCES.has(licence)) {
    throw new Error(
      `licence "${licence || "(none reported)"}" is not on the allowlist ` +
        `(${Array.from(ACCEPTABLE_LICENCES.keys()).join(", ")}) — refusing to ship this face`
    );
  }

  if (!(meta.subsets ?? []).includes("latin")) {
    throw new Error("no latin subset — this script only fetches latin-*.woff2");
  }

  const variable = await fetchJson<VariableMeta>(`${FONTSOURCE_API}/variable/${id}`).catch(() => null);
  const wght = variable?.axes?.wght;
  const min = Number(wght?.min);
  const max = Number(wght?.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    throw new Error(
      "no variable weight axis — a static cut would make every weight but one a synthetic smear, " +
        "so this face is refused rather than downgraded"
    );
  }

  return { meta, weight: { min, max }, italic: (meta.styles ?? []).includes("italic") };
}

/**
 * Download one `.woff2` and store it — and the check on the bytes is not decoration.
 *
 * jsDelivr answers a miss with an HTML error page and HTTP 200 more often than one would like, and a
 * 400-byte HTML document saved as `lora-latin-var.woff2` is a face that fails at first paint in the
 * browser rather than here, where the message is useful. The first four bytes of every WOFF2 file are
 * the signature `wOF2`; anything else is not a font, whatever the status code said.
 */
async function downloadFace(id: string, style: "normal" | "italic"): Promise<FaceFile> {
  const url = `${JSDELIVR}/${id}:vf@latest/latin-wght-${style}.woff2`;
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`${style}: ${url} → HTTP ${response.status}`);

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 4096 || bytes.subarray(0, 4).toString("latin1") !== "wOF2") {
    throw new Error(
      `${style}: ${url} did not return a WOFF2 file (${bytes.length} bytes, signature ` +
        `"${bytes.subarray(0, 4).toString("latin1")}") — almost always a jsDelivr error page served as 200`
    );
  }

  const name = style === "italic" ? `${id}-latin-var-italic.woff2` : `${id}-latin-var.woff2`;
  await writeFile(path.join(FONT_DIR, name), bytes);
  return {
    path: `fonts/${name}`,
    style,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Licence texts — the obligation, not the reference
// ─────────────────────────────────────────────────────────────────────────────

/** Where a face's licence text is written. Convention, and `scripts/font-check.ts` asserts it. */
function licencePath(id: string): string {
  return path.join(FONT_DIR, "licences", `${id}.txt`);
}

/**
 * The copyright line, pulled out of a licence text so it can be indexed in one readable place.
 *
 * ⚠ IT IS NOT ALWAYS THE FIRST LINE, AND IT IS NOT ALWAYS PRESENT. Most OFL texts open with
 * `Copyright <year> The <Family> Project Authors (<url>)`, but Source Serif 4's opens with the bare
 * words "Google Inc." and reaches the word "Copyright" only inside the licence's own definitions
 * section — so a naive "first line containing Copyright" returns a fragment of boilerplate that reads
 * like a notice and is not one. The scan is therefore anchored to a line that STARTS with the word,
 * and a family with no such line returns null rather than a plausible lie.
 */
function copyrightNotice(text: string): string | null {
  const lines = text.split(/\r?\n/);

  /*
   * Stop where the licence's own text begins. Everything after this line is the OFL boilerplate,
   * which is identical in all twelve files and mentions copyright repeatedly without ever being a
   * notice — the preamble alone contains a wrapped line reading "copyright statement(s)." that a
   * looser scan happily returned for Source Serif 4, printing a fragment of the licence where the
   * author's name belonged.
   */
  const bodyAt = lines.findIndex((line) => /This Font Software is licensed under the SIL/i.test(line));
  const head = lines.slice(0, bodyAt > 0 ? bodyAt : Math.min(lines.length, 40));

  // A real notice carries a YEAR. That is what separates "Copyright 2011 The Lora Project Authors"
  // from prose that merely opens with the word.
  for (const line of head) {
    const trimmed = line.trim();
    if (/^copyright\s+(\(c\)\s*)?\d{4}/i.test(trimmed)) return trimmed;
  }

  /*
   * No dated notice. Source Serif 4's upstream LICENSE opens with the bare words "Google Inc." and
   * has no Copyright line at all — so the attribution is that first line, and returning null here
   * would drop the only credit the file carries. We ship exactly what upstream ships, which is the
   * obligation; what is missing is a parseable notice, not a licence.
   */
  const first = head.map((line) => line.trim()).find((line) => line.length > 0);
  return first && first.length <= 80 ? first : null;
}

/**
 * Fetch and store one family's licence text.
 *
 * ⚠ VALIDATED THE SAME WAY THE FONTS ARE. jsDelivr answers a miss with an HTML error page and HTTP
 * 200, so a licence file could silently become `<!DOCTYPE html>` — which would satisfy a check that
 * the file merely exists while satisfying the licence not at all. The body must actually name the
 * licence it claims to be.
 */
async function downloadLicence(
  id: string,
  origin: "fontsource" | "bundled"
): Promise<{ bytes: number; notice: string | null; licence: string }> {
  const url =
    origin === "bundled"
      ? BUNDLED_LICENCE_SOURCES[id]
      : `${FONTSOURCE_PACKAGE}/${id}/LICENSE`;
  if (!url) throw new Error(`no licence source is known for the bundled face "${id}"`);

  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`licence: ${url} → HTTP ${response.status}`);
  const text = await response.text();

  /*
   * ⚠ THE LICENCE IS IDENTIFIED FROM THE TEXT, NOT PASSED IN — and the first version of this function
   * did pass it in, which was wrong in a way that still printed a green line.
   *
   * `RosterEntry.licence` only exists on the two BUNDLED faces; for the other ten the licence is read
   * from the Fontsource API at download time, so it is `undefined` this early. The check therefore
   * fell through to its OFL default and "passed" ten families it had not actually identified — and the
   * index printed "undefined" in the Licence column, which is the visible half of the same mistake.
   *
   * Reading it out of the document is strictly stronger: it verifies the bytes on disk really are a
   * licence this project is allowed to ship, rather than trusting a field written somewhere else.
   */
  const MARKERS: readonly { licence: string; marker: string }[] = [
    { licence: "OFL-1.1", marker: "SIL OPEN FONT LICENSE" },
    { licence: "Apache-2.0", marker: "APACHE LICENSE" }
  ];
  const upper = text.toUpperCase();
  const identified = MARKERS.find((candidate) => upper.includes(candidate.marker));

  if (text.length < 1000 || !identified) {
    throw new Error(
      `licence: ${url} did not return a recognised licence text (${text.length} bytes; none of ` +
        `${MARKERS.map((candidate) => candidate.marker).join(", ")} present) — almost always an ` +
        `error page served as 200`
    );
  }
  // The allowlist is the authority on what may ship, and it is consulted here too so a family cannot
  // arrive under a licence the roster never approved just because its text parsed.
  if (!ACCEPTABLE_LICENCES.has(identified.licence)) {
    throw new Error(`licence: ${url} is ${identified.licence}, which is not on ACCEPTABLE_LICENCES`);
  }

  await mkdir(path.dirname(licencePath(id)), { recursive: true });
  await writeFile(licencePath(id), text);
  return { bytes: text.length, notice: copyrightNotice(text), licence: identified.licence };
}

/**
 * Fetch every licence, write the index, and report what is missing.
 *
 * Runs on EVERY invocation, including one that downloads no fonts at all, for the same reason the two
 * bundled faces are re-measured every time: a licence file that has been deleted, truncated or never
 * fetched is invisible until somebody asks the question, and by then the answer is "we shipped
 * twenty-two font binaries with no notice".
 *
 * Returns the problems rather than exiting, so a licence failure is reported beside the font failures
 * instead of hiding them.
 */
async function runLicences(entries: readonly RosterEntry[]): Promise<string[]> {
  const problems: string[] = [];
  const rows: { entry: RosterEntry; notice: string | null; licence: string; family: string; upstream: string }[] = [];

  /*
   * ⚠ `family` AND `upstream` LIVE ON THE MANIFEST, NOT ON THE ROSTER — for ten of the twelve faces.
   * `RosterEntry` carries them only in its `origin: "bundled"` arm; for a Fontsource face they are
   * read from the API during the download, which has not happened yet at this point in the run. Taking
   * them off `entry` therefore yielded `undefined` for ten families and printed it into the index.
   * The generated manifest already holds both, so it is read back here — the same trick `existingFacts`
   * exists for, and the reason a one-face run cannot destroy eleven records.
   */
  const known = await existingFacts();

  for (const entry of entries) {
    process.stdout.write(`  licence ${entry.id.padEnd(20)} `);
    const fromManifest = known.get(entry.id);
    const family = entry.origin === "bundled" ? entry.family : fromManifest?.family ?? entry.id;
    const upstream = entry.origin === "bundled" ? entry.upstream : fromManifest?.upstream ?? "—";
    try {
      const { bytes, notice, licence } = await downloadLicence(entry.id, entry.origin);
      rows.push({ entry, notice, licence, family, upstream });
      console.log(
        `${licence.padEnd(11)} ${String(bytes).padStart(5)} bytes  ` +
          `${notice ? "notice ok" : "⚠ no attribution line — credit by hand"}`
      );
    } catch (error) {
      console.log("FAILED");
      problems.push(`${entry.id}: ${(error as Error).message}`);
    }
  }

  const index = [
    "# Font licences",
    "",
    "**Generated by `npx tsx scripts/fetch-fonts.ts`. Do not edit by hand.**",
    "",
    "Every typeface shipped in `fonts/` is listed here with the full text of its licence in this",
    "directory. This is not decoration and not a courtesy: the SIL Open Font License permits",
    "redistribution *\"provided that each copy contains the above copyright notice and this license\"*",
    "(OFL-1.1 §2), and §2 accepts that notice as a text file alongside the fonts. These are those text",
    "files. Deleting one is a licence breach; `npm run font-check` fails if one goes missing.",
    "",
    "⚠ **The OFL does not require a credit on the rendered page** — unlike the CC BY photographs in",
    "`lib/media/craft-imagery.ts`, whose licence obliges attribution to the *reader* and which are",
    "credited on `/credits`. The obligation here is to whoever receives the font *files*, which is why",
    "it is met in the repository rather than in the interface.",
    "",
    "| Family | id | Licence | Copyright notice | Upstream |",
    "|---|---|---|---|---|"
  ];
  for (const { entry, notice, licence, family, upstream } of rows) {
    index.push(
      `| ${family} | \`${entry.id}\` | [${licence}](./${entry.id}.txt) | ` +
        `${notice ?? "— *(see the licence text)*"} | ${upstream} |`
    );
  }
  index.push("");
  await mkdir(path.join(FONT_DIR, "licences"), { recursive: true });
  await writeFile(path.join(FONT_DIR, "licences", "README.md"), `${index.join("\n")}\n`);

  return problems;
}

/** Measure and hash a file already on disk — how the two bundled faces get their manifest row. */
async function measure(name: string, style: "normal" | "italic"): Promise<FaceFile> {
  const bytes = await readFile(path.join(FONT_DIR, name));
  return {
    path: `fonts/${name}`,
    style,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The generated manifest
// ─────────────────────────────────────────────────────────────────────────────

function q(value: string): string {
  return JSON.stringify(value);
}

function faceLiteral(entry: RosterEntry, facts: Facts): string {
  const files = facts.files
    .map(
      (file) =>
        `      { path: ${q(file.path)}, style: ${q(file.style)}, bytes: ${file.bytes}, sha256: ${q(file.sha256)} }`
    )
    .join(",\n");

  return `  {
    id: ${q(entry.id)},
    family: ${q(facts.family)},
    role: ${q(entry.role)},
    usage: [${entry.usage.map(q).join(", ")}],
    cssVariable: ${q(entry.cssVariable)},
    fontClass: ${q(entry.fontClass)},
    tailwindKey: ${q(entry.tailwindKey)},
    purpose: ${q(entry.purpose)},
    cautions: ${entry.cautions === null ? "null" : q(entry.cautions)},
    licence: ${q(facts.licence)},
    licenceUrl: ${q(facts.licenceUrl)},
    upstream: ${q(facts.upstream)},
    version: ${q(facts.version)},
    weightRange: ${q(facts.weightRange)},
    weightMin: ${facts.weightMin},
    weightMax: ${facts.weightMax},
    hasTrueItalic: ${facts.hasTrueItalic},
    preload: ${entry.preload},
    bytes: ${facts.files.reduce((total, file) => total + file.bytes, 0)},
    files: [
${files}
    ]
  }`;
}

function pairingLiteral(pairing: Pairing): string {
  return `  {
    id: ${q(pairing.id)},
    label: ${q(pairing.label)},
    description: ${q(pairing.description)},
    headingFaceId: ${q(pairing.headingFaceId)},
    bodyFaceId: ${q(pairing.bodyFaceId)},
    accentFaceId: ${q(pairing.accentFaceId)}
  }`;
}

function manifestSource(rows: { entry: RosterEntry; facts: Facts }[], missing: string[]): string {
  const totalBytes = rows.reduce(
    (total, row) => total + row.facts.files.reduce((sum, file) => sum + file.bytes, 0),
    0
  );
  const withItalic = rows.filter((row) => row.facts.hasTrueItalic).length;

  /**
   * ⚠ THE COVERAGE LINE IS NOT DECORATION. A roster entry whose files could not be fetched is left out
   * of the manifest rather than written half-complete, and a library that quietly stops one face short
   * is indistinguishable from a library that never had that face (CONTRACT.md §1.6). So the count, and
   * the names of anything absent, are stated in the file itself and not only in the console.
   */
  const coverage =
    missing.length === 0
      ? ` * All ${rows.length} faces in the fetcher's roster are present.`
      : ` * ⚠ ${rows.length} of ${rows.length + missing.length} faces in the fetcher's roster are present.\n` +
        ` * ABSENT, and therefore not offered anywhere: ${missing.join(", ")}.\n` +
        ` * Re-run \`npx tsx scripts/fetch-fonts.ts ${missing.join(" ")}\` to fill the gap.`;

  return `/**
 * THE TYPE LIBRARY — GENERATED. DO NOT EDIT BY HAND.
 *
 * Written by \`npx tsx scripts/fetch-fonts.ts\`. Every entry describes one face the site can set type
 * in: where its file is, what it costs, what its licence is, whether it has a real italic, and — the
 * part that matters editorially — WHAT IT IS FOR, in a sentence an administrator reads in a picker.
 *
 * This is the ONE place a face is described. A picker, a block's typesetting controls and the studio's
 * preview all read from here, so a face cannot be offered under two different names or two different
 * descriptions.
 *
${coverage}
 * ${withItalic} have a true drawn italic and ${rows.length - withItalic} do not; in those, an emphasis is
 * a slant the browser invents, which on a serif shears the strokes instead of redrawing them.
 * \`hasTrueItalic\` is the field to check before letting a block set a book title.
 *
 * TOTAL SHIPPED WEIGHT: ${(totalBytes / 1024).toFixed(0)} KB across ${rows.reduce((n, r) => n + r.facts.files.length, 0)} files.
 * Nothing like that is downloaded per page: \`app/layout.tsx\` preloads only the three faces every page
 * is set in — Inter, Plus Jakarta Sans and Source Serif 4, the last because \`houseTypesetSchema\`
 * defaults the body face to it — and every other face is fetched by the browser when, and only when, a
 * glyph is actually painted with it. Declaring a CSS variable does not fetch a file.
 *
${LICENCE_NOTE.map((line) => ` * ${line}`).join("\n")}
 *
 * ⚠ EDIT THE SCRIPT, NOT THIS FILE. The prose lives in \`ROSTER\` in scripts/fetch-fonts.ts; the facts
 * come from the Fontsource API and from the bytes on disk. Editing here is how a description comes to
 * disagree with the face it describes.
 *
 * ⚠ A FACE HERE MUST ALSO BE DECLARED IN app/layout.tsx AND KEYED IN tailwind.config.ts. Nothing in
 * TypeScript enforces that: \`fontClass\` is a string, and a class Tailwind never generated is a class
 * that silently does nothing. The fetcher cross-checks layout.tsx on every run and fails if a
 * \`cssVariable\` or \`weightRange\` is missing from it.
 */

/** Which group a face sits in, in a picker. Not a judgement of quality — a shelf. */
export type FontRole = "serif-text" | "serif-display" | "sans" | "condensed" | "mono";

/**
 * What a face may be used FOR. The filter that stops a 68-character measure of body copy being set in
 * a didone display serif. Ordered most to least suitable within each face.
 */
export type FontUsage = "heading" | "body" | "eyebrow" | "quote" | "caption" | "figures";

/** One shipped \`.woff2\`. \`bytes\` and \`sha256\` describe the file on disk, not the upstream original. */
export interface FontFile {
  /** Repo-relative path with forward slashes, e.g. \`fonts/lora-latin-var.woff2\`. */
  path: string;
  style: "normal" | "italic";
  bytes: number;
  /** First 16 hex characters of the SHA-256 of the stored bytes. */
  sha256: string;
}

export interface FontFace {
  /** Stable key. Appears in stored section data, so it must not change when a file is replaced. */
  id: string;
  /** The family name as its designer spells it. Safe to print. */
  family: string;
  role: FontRole;
  usage: readonly FontUsage[];
  /** The custom property \`next/font/local\` writes in app/layout.tsx. */
  cssVariable: string;
  /**
   * The COMPLETE, LITERAL Tailwind class that selects this face — emit it verbatim.
   *
   * ⚠ Never build one: \`font-\${face.tailwindKey}\` never appears in the source Tailwind scans and is
   * purged, so the class compiles to nothing and the text silently stays in the inherited face
   * (CONTRACT.md §5). Use a lookup, or use this string.
   */
  fontClass: string;
  /** The \`theme.extend.fontFamily\` key \`fontClass\` comes from. For diagnostics, not for building. */
  tailwindKey: string;
  /** What this face is for, and when to choose it over its neighbours. Written to be shown to a person. */
  purpose: string;
  /** What it cannot do, in the same voice. \`null\` where there is nothing to warn about. */
  cautions: string | null;
  licence: string;
  licenceUrl: string;
  /** Where the source lives, for the next person who has to answer a licence question. */
  upstream: string;
  /** The upstream release the file was built from, as Fontsource reports it. */
  version: string;
  /** Exactly what app/layout.tsx must pass as \`weight\`, e.g. \`"200 900"\`. */
  weightRange: string;
  weightMin: number;
  weightMax: number;
  /**
   * Whether a drawn italic ships. FALSE means an \`<em>\` is a browser-synthesised slant, which on a
   * serif is visibly wrong — the strokes shear instead of being redrawn.
   */
  hasTrueItalic: boolean;
  /** Whether app/layout.tsx preloads it. False = fetched on first painted glyph. */
  preload: boolean;
  /** Total shipped bytes for this face, both styles. */
  bytes: number;
  files: readonly FontFile[];
}

export const FONT_FACES: readonly FontFace[] = [
${rows.map((row) => faceLiteral(row.entry, row.facts)).join(",\n")}
];

/** Render order for a grouped picker. Reading faces first, ornament last. */
export const FONT_ROLE_ORDER: readonly FontRole[] = [
  "serif-text",
  "serif-display",
  "sans",
  "condensed",
  "mono"
];

/** Group headings, in the words an administrator uses rather than the words a typographer uses. */
export const FONT_ROLE_LABELS: Record<FontRole, string> = {
  "serif-text": "Serif — for reading",
  "serif-display": "Serif — for headlines",
  sans: "Sans-serif",
  condensed: "Condensed",
  mono: "Monospace"
};

export const FONT_USAGE_LABELS: Record<FontUsage, string> = {
  heading: "Headings",
  body: "Body text",
  eyebrow: "Eyebrows and labels",
  quote: "Pull quotes",
  caption: "Captions",
  figures: "Figures and identifiers"
};

export const FONT_FACE_IDS: readonly string[] = FONT_FACES.map((face) => face.id);

/** By id, or null. Never throws: an id can arrive from stored section data written years ago. */
export function fontFace(id: string): FontFace | null {
  return FONT_FACES.find((face) => face.id === id) ?? null;
}

/**
 * The faces fit for a job, in the order they should be offered.
 *
 * Sorted by role so a picker's groups stay in \`FONT_ROLE_ORDER\`, and within a role by how strongly the
 * face claims that use — a face listing "body" first is a better body face than one listing it third.
 */
export function facesForUsage(usage: FontUsage): readonly FontFace[] {
  return FONT_FACES.filter((face) => face.usage.includes(usage)).sort((a, b) => {
    const role = FONT_ROLE_ORDER.indexOf(a.role) - FONT_ROLE_ORDER.indexOf(b.role);
    if (role !== 0) return role;
    return a.usage.indexOf(usage) - b.usage.indexOf(usage);
  });
}

/** Faces grouped for a picker, empty groups dropped. */
export function facesByRole(): readonly { role: FontRole; label: string; faces: readonly FontFace[] }[] {
  return FONT_ROLE_ORDER.map((role) => ({
    role,
    label: FONT_ROLE_LABELS[role],
    faces: FONT_FACES.filter((face) => face.role === role)
  })).filter((group) => group.faces.length > 0);
}

/** One weight step, with the complete literal class. */
export interface TailwindWeight {
  /** What a person calls it. */
  label: string;
  value: number;
  /** COMPLETE LITERAL — never build \`font-\${label}\`. */
  className: string;
}

export const TAILWIND_WEIGHTS: readonly TailwindWeight[] = [
  { label: "Thin", value: 100, className: "font-thin" },
  { label: "Extra light", value: 200, className: "font-extralight" },
  { label: "Light", value: 300, className: "font-light" },
  { label: "Regular", value: 400, className: "font-normal" },
  { label: "Medium", value: 500, className: "font-medium" },
  { label: "Semibold", value: 600, className: "font-semibold" },
  { label: "Bold", value: 700, className: "font-bold" },
  { label: "Extra bold", value: 800, className: "font-extrabold" },
  { label: "Black", value: 900, className: "font-black" }
];

/**
 * The weights a face can actually produce.
 *
 * ⚠ OFFER NOTHING ELSE. A variable font CLAMPS a request outside its axis, silently: Lora's axis stops
 * at 700, so \`font-black\` on Lora renders at bold and the control that set it appears to be broken.
 * Filtering here means a person never meets that, rather than meeting it and doubting the whole picker.
 */
export function weightsFor(face: FontFace): readonly TailwindWeight[] {
  return TAILWIND_WEIGHTS.filter(
    (weight) => weight.value >= face.weightMin && weight.value <= face.weightMax
  );
}

/**
 * A complete answer to "how should this page be set?" — a heading face, a body face, and an accent face
 * for eyebrows, labels and figures.
 *
 * These exist so the first thing an administrator meets is a short list of named settings rather than
 * three dropdowns over twelve faces each. The dropdowns stay available for whoever wants them.
 */
export interface FontPairing {
  id: string;
  label: string;
  description: string;
  headingFaceId: string;
  bodyFaceId: string;
  accentFaceId: string;
}

export const FONT_PAIRINGS: readonly FontPairing[] = [
${PAIRINGS.map(pairingLiteral).join(",\n")}
];

/**
 * What every page is set in unless somebody changes it — the two faces that were here before this
 * library existed. Changing this value restyles the whole site, which is why it is a named constant
 * and not a default buried in a component.
 */
export const DEFAULT_PAIRING_ID = ${q(DEFAULT_PAIRING_ID)};

/** By id, or null. Every id in every pairing is checked against the roster before this file is written. */
export function fontPairing(id: string): FontPairing | null {
  return FONT_PAIRINGS.find((pairing) => pairing.id === id) ?? null;
}

/** The three faces of a pairing, resolved. \`null\` if the pairing id is unknown. */
export function pairingFaces(
  id: string
): { heading: FontFace; body: FontFace; accent: FontFace } | null {
  const pairing = fontPairing(id);
  if (!pairing) return null;
  const heading = fontFace(pairing.headingFaceId);
  const body = fontFace(pairing.bodyFaceId);
  const accent = fontFace(pairing.accentFaceId);
  // A pairing whose faces are absent would render as three fallbacks and read as a broken page, so it
  // is treated as unknown rather than partially applied.
  if (!heading || !body || !accent) return null;
  return { heading, body, accent };
}

/** Total bytes of every face in the library. Nothing loads all of it; this is the shelf, not the page. */
export const TYPE_LIBRARY_BYTES = ${totalBytes};
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the manifest back
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The facts already on file, per face.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS FUNCTION EXISTS SO THAT A ONE-FACE RUN CANNOT DESTROY ELEVEN LICENCE RECORDS.
 *
 * `main()` rewrites the whole manifest from the rows it holds. Without this, `npx tsx
 * scripts/fetch-fonts.ts lora` would write a manifest containing exactly one face — and the licence,
 * version and weight range of every other face would be gone while the `.woff2` files stayed on disk,
 * leaving eleven fonts in the repository that nothing could say anything about. That is the same
 * failure the imagery fetcher's `existingManifest()` guards, and for the same reason.
 *
 * IT PARSES THE GENERATED LITERAL RATHER THAN IMPORTING THE MODULE, because importing would make the
 * fetcher unusable exactly when it is most needed: while the manifest is half-written, or does not
 * typecheck, or names a file that is not there. The parse is deliberately strict — a block that does
 * not yield every fact is DISCARDED rather than half-kept, and the face is then reported as absent
 * instead of being written out with holes in it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function existingFacts(): Promise<Map<string, Facts>> {
  const found = new Map<string, Facts>();

  let source: string;
  try {
    source = await readFile(MANIFEST_PATH, "utf8");
  } catch {
    return found; // First run. An empty map is the right answer, not an error.
  }

  // Only the array literal, so the `FontFace` INTERFACE above it — whose field names are identical —
  // cannot be mistaken for an entry.
  const start = source.indexOf("export const FONT_FACES");
  if (start < 0) return found;
  const body = source.slice(start);

  const text = (block: string, name: string): string | null => {
    const match = block.match(new RegExp(`\\b${name}: "((?:[^"\\\\]|\\\\.)*)"`));
    return match?.[1] === undefined ? null : (JSON.parse(`"${match[1]}"`) as string);
  };
  const number = (block: string, name: string): number | null => {
    const match = block.match(new RegExp(`\\b${name}: (\\d+)`));
    return match?.[1] ? Number(match[1]) : null;
  };

  for (const match of body.matchAll(/\{\s*id: "[^"]+",[\s\S]*?files: \[[\s\S]*?\]\s*\}/g)) {
    const block = match[0];
    const id = text(block, "id");
    const family = text(block, "family");
    const licence = text(block, "licence");
    const licenceUrl = text(block, "licenceUrl");
    const upstream = text(block, "upstream");
    const version = text(block, "version");
    const weightRange = text(block, "weightRange");
    const weightMin = number(block, "weightMin");
    const weightMax = number(block, "weightMax");

    const files: FaceFile[] = [];
    for (const file of block.matchAll(
      /\{ path: "([^"]+)", style: "(normal|italic)", bytes: (\d+), sha256: "([0-9a-f]*)" \}/g
    )) {
      const [, filePath, style, bytes, sha256] = file;
      if (!filePath || !style || !bytes) continue;
      files.push({
        path: filePath,
        style: style as "normal" | "italic",
        bytes: Number(bytes),
        sha256: sha256 ?? ""
      });
    }

    if (!id || !family || !licence || !licenceUrl || !upstream || !version) continue;
    if (!weightRange || weightMin === null || weightMax === null || files.length === 0) continue;

    found.set(id, {
      family,
      licence,
      licenceUrl,
      upstream,
      version,
      weightRange,
      weightMin,
      weightMax,
      hasTrueItalic: files.some((file) => file.style === "italic"),
      files
    });
  }

  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// The cross-check against app/layout.tsx
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A face in the manifest that `app/layout.tsx` does not declare is the worst kind of broken.
 *
 * `next/font/local` is what emits the `@font-face` rule and defines the custom property; the manifest
 * only *claims* a face exists. If the two disagree, a picker offers "Lora", an editor chooses it, the
 * block gets `font-lora`, `--font-lora` resolves to nothing, and the text renders in the fallback —
 * with no error anywhere. Nothing in TypeScript can catch it, because both halves are strings.
 *
 * ⚠ AND `next/font/local` CANNOT READ THE MANIFEST. Its arguments must be statically analysable
 * literals — Next rejects `weight: face.weightRange` with "Font loader values must be explicitly
 * written literals" — so the weight range genuinely has to be typed out twice. This check is the only
 * thing standing between "twice" and "differently".
 *
 * It runs on EVERY invocation, including one that downloads nothing, because the way this breaks is
 * somebody editing layout.tsx, not somebody running the fetcher. It is a substring check on the file,
 * not a parse: it proves the variable and the weight range are both mentioned, and cannot prove they
 * are mentioned in the same `localFont()` call.
 */
async function checkLayout(rows: { entry: RosterEntry; facts: Facts }[]): Promise<string[]> {
  let layout: string;
  try {
    layout = await readFile(LAYOUT_PATH, "utf8");
  } catch {
    return ["app/layout.tsx could not be read, so nothing was cross-checked"];
  }

  const problems: string[] = [];
  for (const { entry, facts } of rows) {
    const declaresVariable = layout.includes(`"${entry.cssVariable}"`);
    const declaresWeight = layout.includes(`"${facts.weightRange}"`);
    if (!declaresVariable) {
      problems.push(
        `${entry.id}: app/layout.tsx never declares ${entry.cssVariable}, so ${entry.fontClass} ` +
          `resolves to the fallback stack. Add:\n` +
          `      const ${entry.id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())} = localFont({\n` +
          `        src: [${facts.files
            .map((file) => `{ path: "../${file.path}", weight: "${facts.weightRange}", style: "${file.style}" }`)
            .join(", ")}],\n` +
          `        variable: "${entry.cssVariable}", display: "swap", preload: ${entry.preload}\n` +
          `      });`
      );
    } else if (!declaresWeight) {
      problems.push(
        `${entry.id}: app/layout.tsx declares ${entry.cssVariable} but the weight range ` +
          `"${facts.weightRange}" appears nowhere in it. Every weight outside whatever it does declare ` +
          `will be clamped or synthesised.`
      );
    }
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const licencesOnly = argv.includes("--licences");
  const only = argv.filter((arg) => !arg.startsWith("--"));

  const wanted = only.length > 0 ? ROSTER.filter((entry) => only.includes(entry.id)) : ROSTER;
  if (wanted.length === 0) {
    console.error(
      `No face matches ${only.join(", ")}. Known ids: ${ROSTER.map((entry) => entry.id).join(", ")}`
    );
    process.exitCode = 1;
    return;
  }

  /**
   * Validate the hand-authored tables BEFORE touching the network.
   *
   * A duplicate id would silently shadow a face in every `find()` in the manifest; a pairing pointing
   * at a face that is not in the roster would be an option that renders as three fallbacks. Both are
   * typos, and both are far cheaper to catch here than after twenty downloads.
   */
  const ids = new Set<string>();
  const structural: string[] = [];
  for (const entry of ROSTER) {
    if (ids.has(entry.id)) structural.push(`duplicate roster id "${entry.id}"`);
    ids.add(entry.id);
  }
  for (const pairing of PAIRINGS) {
    for (const [slot, faceId] of [
      ["headingFaceId", pairing.headingFaceId],
      ["bodyFaceId", pairing.bodyFaceId],
      ["accentFaceId", pairing.accentFaceId]
    ] as const) {
      if (!ids.has(faceId)) structural.push(`pairing "${pairing.id}" ${slot} → unknown face "${faceId}"`);
    }
  }
  if (!ids.has(DEFAULT_PAIRING_ID) && !PAIRINGS.some((pairing) => pairing.id === DEFAULT_PAIRING_ID)) {
    structural.push(`DEFAULT_PAIRING_ID "${DEFAULT_PAIRING_ID}" is not one of the pairings`);
  }
  if (structural.length > 0) {
    console.error("The roster does not hang together — nothing was fetched:");
    for (const problem of structural) console.error(`  ${problem}`);
    process.exitCode = 1;
    return;
  }

  await mkdir(FONT_DIR, { recursive: true });

  /**
   * ⚠ LICENCES FIRST, AND FOR THE WHOLE ROSTER RATHER THAN THE SELECTED FACES.
   *
   * A run naming one face (`… fetch-fonts.ts lora`) must not leave the other eleven licences to rot —
   * that is the same failure `existingFacts()` exists to prevent for the manifest, one directory over.
   * Doing it before the downloads also means a licence host that is unreachable is reported before
   * twenty font binaries are written, rather than after.
   */
  const licenceProblems = await runLicences(ROSTER);
  if (licencesOnly) {
    if (licenceProblems.length > 0) {
      console.error(`\n${licenceProblems.length} licence problem(s):`);
      for (const problem of licenceProblems) console.error(`  ${problem}`);
      process.exitCode = 1;
      return;
    }
    console.log(`\nLicences: ${ROSTER.length} written to fonts/licences/. The manifest was not touched.`);
    return;
  }

  /** Seeded with everything already on file, so an unfetched face keeps the facts it had. */
  const facts = await existingFacts();
  const failures: string[] = [];
  let fetched = 0;
  let skipped = 0;

  for (const entry of wanted) {
    /**
     * The bundled faces are never downloaded — there is no Fontsource package for the exact Inter and
     * Jakarta builds already committed here, and re-fetching them from the corpus would replace two
     * files that have shipped for months with subtly different ones. They are measured instead, and
     * measured on EVERY run, so their manifest row cannot drift from the bytes on disk.
     */
    if (entry.origin === "bundled") {
      process.stdout.write(`· ${entry.id.padEnd(18)} `);
      try {
        const files = [await measure(entry.romanFile, "normal")];
        if (entry.italicFile) files.push(await measure(entry.italicFile, "italic"));
        const [min, max] = entry.weightRange.split(" ").map(Number);
        facts.set(entry.id, {
          family: entry.family,
          licence: entry.licence,
          licenceUrl: ACCEPTABLE_LICENCES.get(entry.licence)?.url ?? "",
          upstream: entry.upstream,
          version: "bundled",
          weightRange: entry.weightRange,
          weightMin: min ?? 400,
          weightMax: max ?? 400,
          hasTrueItalic: files.some((file) => file.style === "italic"),
          files
        });
        fetched++;
        process.stdout.write(
          `already committed  ${entry.licence.padEnd(11)} ${entry.weightRange.padEnd(9)} ` +
            `${(files.reduce((sum, file) => sum + file.bytes, 0) / 1024).toFixed(0)} KB\n`
        );
      } catch (error) {
        failures.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
        process.stdout.write("missing from fonts/\n");
      }
      continue;
    }

    /**
     * Skip anything already downloaded, unless `--force` or an explicit list says otherwise.
     *
     * ⚠ THE FILE ON DISK IS CHECKED, NOT ONLY THE MANIFEST ROW. A row whose `.woff2` has been deleted
     * is exactly the state a re-run is needed for, and trusting the row would skip it forever —
     * leaving the manifest advertising a face the browser cannot load.
     *
     * NAMING A FACE ALWAYS RE-FETCHES IT: there would be no other way to ask.
     */
    if (!force && only.length === 0 && facts.has(entry.id)) {
      const roman = await stat(path.join(FONT_DIR, `${entry.id}-latin-var.woff2`)).catch(() => null);
      if (roman?.isFile()) {
        skipped++;
        continue;
      }
    }

    process.stdout.write(`· ${entry.id.padEnd(18)} `);
    try {
      const { meta, weight, italic } = await describe(entry.id);
      const files = [await downloadFace(entry.id, "normal")];
      if (italic) files.push(await downloadFace(entry.id, "italic"));

      facts.set(entry.id, {
        family: meta.family ?? entry.id,
        licence: meta.license ?? "",
        licenceUrl: ACCEPTABLE_LICENCES.get(meta.license ?? "")?.url ?? "",
        upstream: meta.source ?? "https://github.com/google/fonts",
        version: meta.version ?? "unknown",
        weightRange: `${weight.min} ${weight.max}`,
        weightMin: weight.min,
        weightMax: weight.max,
        hasTrueItalic: italic,
        files
      });
      fetched++;

      process.stdout.write(
        `${(meta.family ?? entry.id).padEnd(19)} ${(meta.license ?? "?").padEnd(11)} ` +
          `${`${weight.min}–${weight.max}`.padEnd(9)} ` +
          `${(files.reduce((sum, file) => sum + file.bytes, 0) / 1024).toFixed(0).padStart(3)} KB  ` +
          `${italic ? "roman + true italic" : "roman only — NO ITALIC"}\n`
      );
    } catch (error) {
      failures.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
      process.stdout.write("refused or failed\n");
    }

    // Courtesy to a donated service. This script is not in a hurry.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  /**
   * Assemble the manifest in ROSTER ORDER, not fetch order — the file is read by people, and the
   * roster's order is the argument for the library (reading serifs, then display, then sans, then
   * ornament). A face with no facts is left out and NAMED, never written half-complete.
   */
  const rows: { entry: RosterEntry; facts: Facts }[] = [];
  const missing: string[] = [];
  for (const entry of ROSTER) {
    const known = facts.get(entry.id);
    if (known) rows.push({ entry, facts: known });
    else missing.push(entry.id);
  }

  if (fetched > 0) {
    await mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
    await writeFile(MANIFEST_PATH, manifestSource(rows, missing), "utf8");
    console.log(
      `\nWrote ${rows.length} faces to lib/typography/fonts.ts ` +
        `(${fetched} fetched or measured, ${rows.length - fetched} carried over` +
        `${skipped > 0 ? `, ${skipped} already present` : ""})`
    );
  } else {
    // Nothing was fetched, so nothing may be written: a no-change rewrite at best, and a way to lose a
    // face's licence record for no reason if one of them had failed.
    console.log(`\nNothing fetched — ${skipped} face(s) already present, manifest left alone.`);
  }

  // Always, even when nothing was fetched: the way this breaks is an edit to layout.tsx.
  const layoutProblems = await checkLayout(rows);
  if (layoutProblems.length > 0) {
    console.error(`\napp/layout.tsx does not declare every face in the manifest:`);
    for (const problem of layoutProblems) console.error(`  ${problem}`);
  } else if (rows.length > 0) {
    console.log(`app/layout.tsx declares all ${rows.length} faces with matching weight ranges.`);
  }

  if (missing.length > 0) {
    console.error(`\n${missing.length} roster face(s) are absent from the library: ${missing.join(", ")}`);
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} face(s) produced nothing:`);
    for (const failure of failures) console.error(`  ${failure}`);
  }
  if (licenceProblems.length > 0) {
    console.error(`\n${licenceProblems.length} licence problem(s):`);
    for (const problem of licenceProblems) console.error(`  ${problem}`);
  }

  // Non-zero for any of the four, deliberately. A half-built type library is precisely the state
  // somebody needs to be told about: silent success here means a picker offering a font that is not
  // there, and text that quietly renders as Times New Roman on a published page. A missing licence is
  // in the same list because a face whose terms are not shipped must not be treated as ready either.
  if (
    failures.length > 0 ||
    missing.length > 0 ||
    layoutProblems.length > 0 ||
    licenceProblems.length > 0
  ) {
    process.exitCode = 1;
  }
}

void main();
