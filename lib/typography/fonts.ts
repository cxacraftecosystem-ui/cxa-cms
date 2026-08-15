/**
 * THE TYPE LIBRARY — GENERATED. DO NOT EDIT BY HAND.
 *
 * Written by `npx tsx scripts/fetch-fonts.ts`. Every entry describes one face the site can set type
 * in: where its file is, what it costs, what its licence is, whether it has a real italic, and — the
 * part that matters editorially — WHAT IT IS FOR, in a sentence an administrator reads in a picker.
 *
 * This is the ONE place a face is described. A picker, a block's typesetting controls and the studio's
 * preview all read from here, so a face cannot be offered under two different names or two different
 * descriptions.
 *
 * All 12 faces in the fetcher's roster are present.
 * 10 have a true drawn italic and 2 do not; in those, an emphasis is
 * a slant the browser invents, which on a serif shears the strokes instead of redrawing them.
 * `hasTrueItalic` is the field to check before letting a block set a book title.
 *
 * TOTAL SHIPPED WEIGHT: 880 KB across 22 files.
 * Nothing like that is downloaded per page: `app/layout.tsx` preloads only the three faces every page
 * is set in — Inter, Plus Jakarta Sans and Source Serif 4, the last because `houseTypesetSchema`
 * defaults the body face to it — and every other face is fetched by the browser when, and only when, a
 * glyph is actually painted with it. Declaring a CSS variable does not fetch a file.
 *
 * Every face here is under a licence that permits self-hosting and redistribution inside a product.
 * The SIL Open Font License asks that its terms travel with the font FILES rather than appearing on
 * the page — so unlike the CC BY photographs in lib/media/craft-imagery.ts, whose licence obliges
 * attribution to the READER and which are credited on /credits, nothing here has to be rendered.
 * ⚠ THE FIELDS BELOW ARE NOT THAT OBLIGATION, THOUGH, AND AN EARLIER VERSION OF THIS NOTE CLAIMED
 * THEY WERE. `licence` and `licenceUrl` are a NAME and a LINK; OFL-1.1 §2 permits redistribution
 * "provided that each copy contains the above copyright notice and this license" — a copy of the
 * text, plus a per-family copyright line that the string "OFL-1.1" does not contain. The licences
 * therefore ship as files, in fonts/licences/, one per face plus a README indexing the notices.
 * `npm run font-check` fails if one is missing, truncated, or is not the licence it claims to be.
 *
 * ⚠ EDIT THE SCRIPT, NOT THIS FILE. The prose lives in `ROSTER` in scripts/fetch-fonts.ts; the facts
 * come from the Fontsource API and from the bytes on disk. Editing here is how a description comes to
 * disagree with the face it describes.
 *
 * ⚠ A FACE HERE MUST ALSO BE DECLARED IN app/layout.tsx AND KEYED IN tailwind.config.ts. Nothing in
 * TypeScript enforces that: `fontClass` is a string, and a class Tailwind never generated is a class
 * that silently does nothing. The fetcher cross-checks layout.tsx on every run and fails if a
 * `cssVariable` or `weightRange` is missing from it.
 */

/** Which group a face sits in, in a picker. Not a judgement of quality — a shelf. */
export type FontRole = "serif-text" | "serif-display" | "sans" | "condensed" | "mono";

/**
 * What a face may be used FOR. The filter that stops a 68-character measure of body copy being set in
 * a didone display serif. Ordered most to least suitable within each face.
 */
export type FontUsage = "heading" | "body" | "eyebrow" | "quote" | "caption" | "figures";

/** One shipped `.woff2`. `bytes` and `sha256` describe the file on disk, not the upstream original. */
export interface FontFile {
  /** Repo-relative path with forward slashes, e.g. `fonts/lora-latin-var.woff2`. */
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
  /** The custom property `next/font/local` writes in app/layout.tsx. */
  cssVariable: string;
  /**
   * The COMPLETE, LITERAL Tailwind class that selects this face — emit it verbatim.
   *
   * ⚠ Never build one: `font-${face.tailwindKey}` never appears in the source Tailwind scans and is
   * purged, so the class compiles to nothing and the text silently stays in the inherited face
   * (CONTRACT.md §5). Use a lookup, or use this string.
   */
  fontClass: string;
  /** The `theme.extend.fontFamily` key `fontClass` comes from. For diagnostics, not for building. */
  tailwindKey: string;
  /** What this face is for, and when to choose it over its neighbours. Written to be shown to a person. */
  purpose: string;
  /** What it cannot do, in the same voice. `null` where there is nothing to warn about. */
  cautions: string | null;
  licence: string;
  licenceUrl: string;
  /** Where the source lives, for the next person who has to answer a licence question. */
  upstream: string;
  /** The upstream release the file was built from, as Fontsource reports it. */
  version: string;
  /** Exactly what app/layout.tsx must pass as `weight`, e.g. `"200 900"`. */
  weightRange: string;
  weightMin: number;
  weightMax: number;
  /**
   * Whether a drawn italic ships. FALSE means an `<em>` is a browser-synthesised slant, which on a
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
  {
    id: "inter",
    family: "Inter",
    role: "sans",
    usage: ["body", "caption", "heading", "eyebrow"],
    cssVariable: "--font-inter",
    fontClass: "font-sans",
    tailwindKey: "sans",
    purpose: "The default voice of the whole site: a neutral screen sans with a tall x-height that is still legible at 13px in a table cell. Choose it when the type should not be noticed.",
    cautions: "No italic file ships for Inter, so an emphasis inside an Inter passage is a slant the browser invents rather than a drawn italic. A passage that has to set book titles, ship names or species names should be set in a serif that has a true italic.",
    licence: "OFL-1.1",
    licenceUrl: "https://openfontlicense.org/open-font-license-official-text/",
    upstream: "https://github.com/rsms/inter",
    version: "bundled",
    weightRange: "100 900",
    weightMin: 100,
    weightMax: 900,
    hasTrueItalic: false,
    preload: true,
    bytes: 48256,
    files: [
      { path: "fonts/inter-latin-var.woff2", style: "normal", bytes: 48256, sha256: "3100e775e8616cd2" }
    ]
  },
  {
    id: "jakarta",
    family: "Plus Jakarta Sans",
    role: "sans",
    // `body` and `caption` were added when the owner made Jakarta the site's ONE voice — it now
    // carries the interface (`font-sans` is Jakarta-first), the default reading face, and the
    // headings it always carried.
    usage: ["body", "caption", "heading", "eyebrow"],
    cssVariable: "--font-jakarta",
    fontClass: "font-display",
    tailwindKey: "display",
    purpose: "The voice of the whole site by the owner's decision — geometric, a little narrower than Inter, carrying the interface, the default reading face and every headline, so a page speaks in one hand from masthead to footnote. `.display-title` and `font-sans` both resolve to it.",
    cautions: "The Tailwind key `font-serif` is an alias of THIS face and is not a serif at all — a legacy slot kept so existing markup keeps working (CONTRACT.md §14). Never reach for `font-serif` expecting a serif; name one of the serif faces below. Like Inter, it ships without an italic, so emphasis in long passages is synthesised — an essay-heavy site may prefer a text serif as its reading face.",
    licence: "OFL-1.1",
    licenceUrl: "https://openfontlicense.org/open-font-license-official-text/",
    upstream: "https://github.com/tokotype/PlusJakartaSans",
    version: "bundled",
    weightRange: "200 800",
    weightMin: 200,
    weightMax: 800,
    hasTrueItalic: false,
    preload: true,
    bytes: 27348,
    files: [
      { path: "fonts/jakarta-latin-var.woff2", style: "normal", bytes: 27348, sha256: "153fc85b70298bee" }
    ]
  },
  {
    id: "source-serif-4",
    family: "Source Serif 4",
    role: "serif-text",
    usage: ["body", "quote", "heading"],
    cssVariable: "--font-source-serif",
    fontClass: "font-source-serif",
    tailwindKey: "source-serif",
    purpose: "A text serif with a large x-height and open counters — the most comfortable of these for a long passage on a screen, and the safest choice when a page should read as a document rather than as an interface.",
    cautions: "The file shipped here carries the weight axis only; Source Serif's optical-size axis is not in it, so a 48px heading does not automatically get the finer, higher-contrast drawing the family has for display sizes.",
    licence: "OFL-1.1",
    licenceUrl: "https://openfontlicense.org/open-font-license-official-text/",
    upstream: "https://github.com/google/fonts",
    version: "v14",
    weightRange: "200 900",
    weightMin: 200,
    weightMax: 900,
    hasTrueItalic: true,
    preload: true,
    bytes: 102340,
    files: [
      { path: "fonts/source-serif-4-latin-var.woff2", style: "normal", bytes: 50824, sha256: "c1df4596be502923" },
      { path: "fonts/source-serif-4-latin-var-italic.woff2", style: "italic", bytes: 51516, sha256: "663e7ef3037a56dc" }
    ]
  },
  {
    id: "newsreader",
    family: "Newsreader",
    role: "serif-text",
    usage: ["body", "heading", "quote"],
    cssVariable: "--font-newsreader",
    fontClass: "font-newsreader",
    tailwindKey: "newsreader",
    purpose: "A low-contrast serif drawn for news screens: sturdier than Source Serif at small sizes and a little narrower, so more words fit the line. Choose it for news, announcements and anything read once and quickly.",
    cautions: "Its optical-size axis is not in the shipped file, and its default drawing is tuned for text — set very large it looks slightly plain beside a display serif.",
    licence: "OFL-1.1",
    licenceUrl: "https://openfontlicense.org/open-font-license-official-text/",
    upstream: "https://github.com/google/fonts",
    version: "v26",
    weightRange: "200 800",
    weightMin: 200,
    weightMax: 800,
    hasTrueItalic: true,
    preload: false,
    bytes: 122604,
    files: [
      { path: "fonts/newsreader-latin-var.woff2", style: "normal", bytes: 58084, sha256: "62981321d9a3cc7a" },
      { path: "fonts/newsreader-latin-var-italic.woff2", style: "italic", bytes: 64520, sha256: "48bc8861b9b2ca93" }
    ]
  },
  {
    id: "lora",
    family: "Lora",
    role: "serif-text",
    usage: ["body", "quote", "heading"],
    cssVariable: "--font-lora",
    fontClass: "font-lora",
    tailwindKey: "lora",
    purpose: "A warm serif with brushed, calligraphic detail. It gives a page a made-by-hand quality that suits writing about craft, and it holds up for an essay set at 17–19px. Its italic is the most expressive in the library.",
    cautions: null,
    licence: "OFL-1.1",
    licenceUrl: "https://openfontlicense.org/open-font-license-official-text/",
    upstream: "https://github.com/google/fonts",
    version: "v37",
    weightRange: "400 700",
    weightMin: 400,
    weightMax: 700,
    hasTrueItalic: true,
    preload: false,
    bytes: 78560,
    files: [
      { path: "fonts/lora-latin-var.woff2", style: "normal", bytes: 37788, sha256: "ddb8c66035104e23" },
      { path: "fonts/lora-latin-var-italic.woff2", style: "italic", bytes: 40772, sha256: "d824d807d4d832d1" }
    ]
  },
  {
    id: "crimson-pro",
    family: "Crimson Pro",
    role: "serif-text",
    usage: ["quote", "body", "heading"],
    cssVariable: "--font-crimson",
    fontClass: "font-crimson",
    tailwindKey: "crimson",
    purpose: "A book serif in the old-style tradition — small x-height, long ascenders, the most literary face here. It wants size and space: excellent for a pull quote or an essay set at 19px and up, pale and cramped below 16px.",
    cautions: "Because the x-height is small, Crimson Pro set at the same pixel size as Inter or Source Serif looks noticeably smaller. Set it one or two steps larger than you would set them, or it reads as timid rather than elegant.",
    licence: "OFL-1.1",
    licenceUrl: "https://openfontlicense.org/open-font-license-official-text/",
    upstream: "https://github.com/google/fonts",
    version: "v28",
    weightRange: "200 900",
    weightMin: 200,
    weightMax: 900,
    hasTrueItalic: true,
    preload: false,
    bytes: 99632,
    files: [
      { path: "fonts/crimson-pro-latin-var.woff2", style: "normal", bytes: 48200, sha256: "20ce4189b9e41b34" },
      { path: "fonts/crimson-pro-latin-var-italic.woff2", style: "italic", bytes: 51432, sha256: "b3faa8f9ce36db53" }
    ]
  },
  {
    id: "fraunces",
    family: "Fraunces",
    role: "serif-display",
    usage: ["heading", "quote"],
    cssVariable: "--font-fraunces",
    fontClass: "font-fraunces",
    tailwindKey: "fraunces",
    purpose: "A display serif with real character — soft, slightly wonky forms that carry an institutional identity without looking corporate. Use it for a page title or a section opener; never for a paragraph.",
    cautions: "Fraunces' SOFT, WONK and optical-size axes are NOT in the file shipped here — the Fontsource variable build exposes weight only — so `font-variation-settings` for them does nothing at all. What you get is the weight axis at the family's default softness.",
    licence: "OFL-1.1",
    licenceUrl: "https://openfontlicense.org/open-font-license-official-text/",
    upstream: "https://github.com/google/fonts",
    version: "v38",
    weightRange: "100 900",
    weightMin: 100,
    weightMax: 900,
    hasTrueItalic: true,
    preload: false,
    bytes: 82276,
    files: [
      { path: "fonts/fraunces-latin-var.woff2", style: "normal", bytes: 36620, sha256: "7f9d191d999336d3" },
      { path: "fonts/fraunces-latin-var-italic.woff2", style: "italic", bytes: 45656, sha256: "bceec2ef4d549efb" }
    ]
  },
  {
    id: "playfair-display",
    family: "Playfair Display",
    role: "serif-display",
    usage: ["heading", "quote"],
    cssVariable: "--font-playfair",
    fontClass: "font-playfair",
    tailwindKey: "playfair",
    purpose: "A high-contrast didone for headlines with a formal, printed feel — hairline thins against heavy stems. The most ceremonial face in the library, and the right one for a citation, an award or a founding date.",
    cautions: "It needs size. Below about 24px the thin strokes thin out to nothing on a low-resolution screen, and the headline looks broken rather than fine. Never set body copy in it.",
    licence: "OFL-1.1",
    licenceUrl: "https://openfontlicense.org/open-font-license-official-text/",
    upstream: "https://github.com/google/fonts",
    version: "v40",
    weightRange: "400 900",
    weightMin: 400,
    weightMax: 900,
    hasTrueItalic: true,
    preload: false,
    bytes: 77208,
    files: [
      { path: "fonts/playfair-display-latin-var.woff2", style: "normal", bytes: 38404, sha256: "e0c764a8e9e1cce9" },
      { path: "fonts/playfair-display-latin-var-italic.woff2", style: "italic", bytes: 38804, sha256: "54af24bd0f911f0f" }
    ]
  },
  {
    id: "work-sans",
    family: "Work Sans",
    role: "sans",
    usage: ["heading", "body", "eyebrow", "caption"],
    cssVariable: "--font-work-sans",
    fontClass: "font-work-sans",
    tailwindKey: "work-sans",
    purpose: "A humanist sans with more warmth than Inter and a slightly irregular rhythm that reads well at paragraph length. The alternative when a page should sound spoken rather than specified — and it has a true italic, which Inter does not.",
    cautions: null,
    licence: "OFL-1.1",
    licenceUrl: "https://openfontlicense.org/open-font-license-official-text/",
    upstream: "https://github.com/google/fonts",
    version: "v24",
    weightRange: "100 900",
    weightMin: 100,
    weightMax: 900,
    hasTrueItalic: true,
    preload: false,
    bytes: 98496,
    files: [
      { path: "fonts/work-sans-latin-var.woff2", style: "normal", bytes: 50316, sha256: "1dd49afc07fb2231" },
      { path: "fonts/work-sans-latin-var-italic.woff2", style: "italic", bytes: 48180, sha256: "73468c2b5cc7c314" }
    ]
  },
  {
    id: "figtree",
    family: "Figtree",
    role: "sans",
    usage: ["heading", "body", "eyebrow"],
    cssVariable: "--font-figtree",
    fontClass: "font-figtree",
    tailwindKey: "figtree",
    purpose: "A geometric sans with round, even forms and a friendly cast — the most contemporary face here. Good as a heading over a serif body, and usable for short body copy where Inter would feel institutional.",
    cautions: "Its even, circular forms make long paragraphs monotonous; past three or four lines the letters stop giving the eye anything to hold on to. Keep it above the fold.",
    licence: "OFL-1.1",
    licenceUrl: "https://openfontlicense.org/open-font-license-official-text/",
    upstream: "https://github.com/google/fonts",
    version: "v9",
    weightRange: "300 900",
    weightMin: 300,
    weightMax: 900,
    hasTrueItalic: true,
    preload: false,
    bytes: 41084,
    files: [
      { path: "fonts/figtree-latin-var.woff2", style: "normal", bytes: 20156, sha256: "4ba7d3d096695818" },
      { path: "fonts/figtree-latin-var-italic.woff2", style: "italic", bytes: 20928, sha256: "7242fa62d13d4617" }
    ]
  },
  {
    id: "archivo-narrow",
    family: "Archivo Narrow",
    role: "condensed",
    usage: ["eyebrow", "caption", "heading"],
    cssVariable: "--font-archivo-narrow",
    fontClass: "font-archivo-narrow",
    tailwindKey: "archivo-narrow",
    purpose: "A condensed grotesque for eyebrows, small uppercase labels, table headers and captions: it fits a long label into a narrow column without shrinking the type. Pair it with wide letter-spacing when setting uppercase.",
    cautions: "It has no drawn small-caps set, so `font-variant-caps: small-caps` is synthesised from shrunken capitals and looks uneven at any size. Set uppercase with tracking instead — that is what `.eyebrow` already does.",
    licence: "OFL-1.1",
    licenceUrl: "https://openfontlicense.org/open-font-license-official-text/",
    upstream: "https://github.com/google/fonts",
    version: "v35",
    weightRange: "400 700",
    weightMin: 400,
    weightMax: 700,
    hasTrueItalic: true,
    preload: false,
    bytes: 39672,
    files: [
      { path: "fonts/archivo-narrow-latin-var.woff2", style: "normal", bytes: 18692, sha256: "e1097881272dd160" },
      { path: "fonts/archivo-narrow-latin-var-italic.woff2", style: "italic", bytes: 20980, sha256: "309571b55bd2a42c" }
    ]
  },
  {
    id: "jetbrains-mono",
    family: "JetBrains Mono",
    role: "mono",
    usage: ["figures", "caption", "body"],
    cssVariable: "--font-jetbrains-mono",
    fontClass: "font-jetbrains-mono",
    tailwindKey: "jetbrains-mono",
    purpose: "A monospace with tabular figures, for citations, DOIs, accession numbers, file paths, code and any column of numbers that has to line up. Every figure is the same width at every weight, so a total does not shift when a row is emphasised.",
    cautions: "⚠ The `font-mono` Tailwind key does NOT resolve to this face. It points at `--font-mono`, which nothing in the project defines, so `font-mono` renders as the reader's system monospace. Use `font-jetbrains-mono` to actually get this file. And it is a code face: at paragraph length it is tiring — set the figures and the identifiers in it, not the prose around them.",
    licence: "OFL-1.1",
    licenceUrl: "https://openfontlicense.org/open-font-license-official-text/",
    upstream: "https://github.com/google/fonts",
    version: "v24",
    weightRange: "100 800",
    weightMin: 100,
    weightMax: 800,
    hasTrueItalic: true,
    preload: false,
    bytes: 83368,
    files: [
      { path: "fonts/jetbrains-mono-latin-var.woff2", style: "normal", bytes: 40404, sha256: "18be452724bfdc23" },
      { path: "fonts/jetbrains-mono-latin-var-italic.woff2", style: "italic", bytes: 42964, sha256: "a8afa085e9ca5e53" }
    ]
  }
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
 * Sorted by role so a picker's groups stay in `FONT_ROLE_ORDER`, and within a role by how strongly the
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
  /** COMPLETE LITERAL — never build `font-${label}`. */
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
 * at 700, so `font-black` on Lora renders at bold and the control that set it appears to be broken.
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
  {
    id: "institutional",
    label: "Institutional",
    description: "The Centre's own voice, and what every page is set in unless somebody changes it. Calm, current, and invisible — the right choice for anything that must not look like a campaign.",
    headingFaceId: "jakarta",
    bodyFaceId: "inter",
    accentFaceId: "archivo-narrow"
  },
  {
    id: "editorial",
    label: "Editorial feature",
    description: "A magazine feature: a display serif with personality over the most readable text serif in the library. For a long piece somebody is meant to sit down with — a field report, an essay, a craft profile.",
    headingFaceId: "fraunces",
    bodyFaceId: "source-serif-4",
    accentFaceId: "archivo-narrow"
  },
  {
    id: "scholarly",
    label: "Scholarly",
    description: "Formal and printed: a didone headline over an old-style book serif. For research pages, publications and anything that should look like it was typeset rather than laid out. Set the body a step larger than usual.",
    headingFaceId: "playfair-display",
    bodyFaceId: "crimson-pro",
    accentFaceId: "archivo-narrow"
  },
  {
    id: "reportage",
    label: "Reportage",
    description: "A humanist sans headline over a news serif — plain, quick and dated-feeling in the good sense. For news, announcements and event pages that are read once.",
    headingFaceId: "work-sans",
    bodyFaceId: "newsreader",
    accentFaceId: "archivo-narrow"
  },
  {
    id: "catalogue",
    label: "Catalogue",
    description: "Built for lists: a condensed heading, a neutral body and a monospace for the figures, so accession numbers, dimensions and dates align down the column. For the archive, specimen listings and anything mostly made of small labels.",
    headingFaceId: "archivo-narrow",
    bodyFaceId: "inter",
    accentFaceId: "jetbrains-mono"
  },
  {
    id: "contemporary",
    label: "Contemporary",
    description: "A geometric sans over a warm, brushed serif — the most modern setting here without turning cold. For landing pages and programme pages where the writing about craft should still feel hand-made.",
    headingFaceId: "figtree",
    bodyFaceId: "lora",
    accentFaceId: "archivo-narrow"
  }
];

/**
 * What every page is set in unless somebody changes it — the two faces that were here before this
 * library existed. Changing this value restyles the whole site, which is why it is a named constant
 * and not a default buried in a component.
 */
export const DEFAULT_PAIRING_ID = "institutional";

/** By id, or null. Every id in every pairing is checked against the roster before this file is written. */
export function fontPairing(id: string): FontPairing | null {
  return FONT_PAIRINGS.find((pairing) => pairing.id === id) ?? null;
}

/** The three faces of a pairing, resolved. `null` if the pairing id is unknown. */
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
export const TYPE_LIBRARY_BYTES = 900844;
