/**
 * The craft photography fetcher.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IT DOES AND WHY IT IS A SCRIPT RATHER THAN A HANDFUL OF DOWNLOADS.
 *
 * The site is about Indian craft, and until now it shipped with no photograph of any craft at all —
 * `public/` was empty. Editorial imagery has to come from somewhere, and "somewhere" for openly
 * licensed craft photography is Wikimedia Commons.
 *
 * A download is not the hard part. THE ATTRIBUTION IS. Every Creative Commons licence in the BY family
 * — which is nearly all of Commons — requires the author, the licence and a link to be carried with
 * the work. A photograph downloaded by hand arrives with none of that attached, and six months later
 * nobody can say where it came from or whether it may be used. So this script refuses to keep an image
 * it cannot attribute: it reads the author, the licence, the licence URL and the source page out of
 * the API's `extmetadata` at download time and writes them into a generated manifest beside the file.
 * `components/site/ImageCredit.tsx` then renders them, which is what actually satisfies the licence.
 *
 * IT ALSO REFUSES ANYTHING THAT IS NOT FREE. `ACCEPTABLE_LICENCES` is an allowlist, not a blocklist:
 * a licence string the script has never seen is rejected rather than assumed to be fine. Commons does
 * host non-free material under fair-use claims, and a fair-use claim made by an American encyclopaedia
 * is not one an Indian institution's website inherits.
 *
 * ⚠ IT IS DELIBERATELY NOT PART OF `npm run build`. It reaches the public internet, it is slow, and it
 * writes files that are then committed. Run it by hand when the picture set should change:
 *
 *     npx tsx scripts/fetch-craft-imagery.ts            # fetch everything missing
 *     npx tsx scripts/fetch-craft-imagery.ts --force    # re-fetch everything, even if present
 *     npx tsx scripts/fetch-craft-imagery.ts ajrakh     # one subject, by slug
 *
 * WHAT IT WRITES
 *   public/craft/<slug>.jpg      the photograph, at most 2000px on its long edge
 *   lib/media/craft-imagery.ts   the generated manifest: dimensions, author, licence, source
 *
 * ⚠ THE MANIFEST IS GENERATED AND MUST NOT BE EDITED BY HAND. Its header says so too. Editing it is
 * how a credit line ends up disagreeing with the file it credits.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";

/**
 * Commons asks every automated client to identify itself and to say how to get in touch. An anonymous
 * scraper is throttled or blocked, and rightly.
 */
const USER_AGENT =
  "CxA-Portal-Imagery/1.0 (https://github.com/cxa-portal; saurav@chartmateapp.com) node-fetch";

/** The long edge we store. Larger than any layout uses, so `next/image` always downsamples. */
const TARGET_WIDTH = 2000;

/** Below this, a photograph cannot fill a full-bleed banner without visible softness. */
const MIN_SOURCE_WIDTH = 1400;

/**
 * The licences this site may publish under, as Commons spells them.
 *
 * AN ALLOWLIST. A licence string that is not on this list is rejected — including one that merely
 * looks free — because the failure mode of guessing wrong is publishing somebody's work without the
 * right to do so. `requiresAttribution: false` marks the public-domain entries, where a credit is
 * courtesy rather than obligation; the manifest still records the author for every one of them.
 */
const ACCEPTABLE_LICENCES = new Map<string, { requiresAttribution: boolean }>([
  ["CC0", { requiresAttribution: false }],
  ["CC PDM 1.0", { requiresAttribution: false }],
  ["Public domain", { requiresAttribution: false }],
  ["PD-USGov", { requiresAttribution: false }],
  ["CC BY 2.0", { requiresAttribution: true }],
  ["CC BY 2.5", { requiresAttribution: true }],
  ["CC BY 3.0", { requiresAttribution: true }],
  ["CC BY 4.0", { requiresAttribution: true }],
  ["CC BY-SA 2.0", { requiresAttribution: true }],
  ["CC BY-SA 2.5", { requiresAttribution: true }],
  ["CC BY-SA 3.0", { requiresAttribution: true }],
  ["CC BY-SA 4.0", { requiresAttribution: true }]
]);

interface Subject {
  /** The file's basename and the manifest key. Kebab-case, stable — it appears in committed markup. */
  slug: string;
  /** What a reader is looking at, as the site would say it. Becomes the default alt text. */
  title: string;
  /** Where the craft is from, for the caption. */
  region: string;
  /** Passed to Commons search. Narrow beats broad: "Ajrakh block printing" not "Ajrakh". */
  query: string;
  /**
   * Prefer a picture of this shape.
   *
   * A full-bleed banner needs width; a portrait card needs height. Asking for the wrong one produces
   * a photograph that is technically correct and cropped to nothing at the size it is used.
   */
  orientation: "landscape" | "portrait" | "any";
  /**
   * A specific Commons file, chosen by a person, which SKIPS THE SEARCH ENTIRELY.
   *
   * ⚠ SEARCH DRIFT IS REAL AND IT IS NOT SUBTLE. "Moradabad brass" returns a photograph of biryani
   * above the brassware; "Indian paper cut art" returns nineteenth-century paintings of Native
   * Americans. A relevance score cannot see that, and neither can a resolution or licence filter.
   *
   * So: `query` is for finding a picture the first time, and `file` is for KEEPING the one that was
   * chosen. Every subject below whose search result was wrong carries an explicit file, and the
   * licence, size and format checks still run against it — an exact title is a way to be specific,
   * never a way to bypass the rules.
   */
  file?: string;
}

/**
 * The subjects, chosen to span the range the archive covers rather than to be a list of famous names:
 * textile, clay, metal, wood, paint, stone and paper, from as many regions as the crafts allow.
 */
const SUBJECTS: readonly Subject[] = [
  // Ajrakh itself has nothing freely licensed on Commons at a usable size. Hand block printing is the
  // same family of work and is well photographed, so the SUBJECT changed rather than the standard.
  { slug: "block-print", title: "Hand block printing", region: "Bagru and Sanganer, Rajasthan", query: "block printing India textile", orientation: "portrait", file: "File:Woman doing Block Printing at Halasur village, Karnataka.jpg" },
  { slug: "bandhani", title: "Bandhani tie-dye", region: "Gujarat and Rajasthan", query: "Bandhani textile", orientation: "landscape" },
  { slug: "bidriware", title: "Bidriware inlay", region: "Bidar, Karnataka", query: "Bidriware", orientation: "landscape" },
  { slug: "blue-pottery", title: "Blue pottery", region: "Jaipur, Rajasthan", query: "Jaipur blue pottery", orientation: "landscape" },
  { slug: "chikankari", title: "Chikankari embroidery", region: "Lucknow, Uttar Pradesh", query: "Chikankari embroidery", orientation: "landscape" },
  { slug: "dhokra", title: "Dhokra lost-wax casting", region: "Bastar, Chhattisgarh", query: "Dokra art Chhattisgarh", orientation: "landscape", file: "File:Dokra from tribes of Bastar DSCN1172 02.jpg" },
  { slug: "kalamkari", title: "Kalamkari hand-painting", region: "Srikalahasti, Andhra Pradesh", query: "Kalamkari painting textile", orientation: "landscape" },
  { slug: "kantha", title: "Kantha running stitch", region: "Bengal", query: "Kantha embroidery", orientation: "landscape" },
  { slug: "madhubani", title: "Madhubani painting", region: "Mithila, Bihar", query: "Madhubani painting", orientation: "landscape" },
  { slug: "pattachitra", title: "Pattachitra scroll painting", region: "Raghurajpur, Odisha", query: "Pattachitra Odisha", orientation: "portrait" },
  { slug: "phulkari", title: "Phulkari darning stitch", region: "Punjab", query: "Phulkari embroidery", orientation: "landscape" },
  { slug: "warli", title: "Warli wall painting", region: "Palghar, Maharashtra", query: "Warli painting", orientation: "landscape" },
  { slug: "channapatna", title: "Channapatna lacquered toys", region: "Channapatna, Karnataka", query: "Channapatna toys", orientation: "landscape" },
  { slug: "terracotta", title: "Terracotta temple work", region: "Bishnupur, West Bengal", query: "Bishnupur terracotta temple", orientation: "landscape" },
  { slug: "pashmina", title: "Pashmina hand-weaving", region: "Srinagar, Kashmir", query: "Pashmina shawl Kashmir", orientation: "landscape", file: "File:Pashmina weaving in Srinagar.jpg" },
  { slug: "patola", title: "Patola double ikat", region: "Patan, Gujarat", query: "Patola sari Patan", orientation: "portrait" },
  { slug: "zardozi", title: "Zardozi metal embroidery", region: "Hyderabad, Telangana", query: "Zardozi", orientation: "portrait", file: "File:Zari zardozi in Hyderabad, India.jpeg" },
  { slug: "thanjavur", title: "Thanjavur gilded painting", region: "Thanjavur, Tamil Nadu", query: "Tanjore painting Thanjavur gold", orientation: "portrait", file: "File:Tanjore Painting Vinyaka.jpg" },
  // "Sanjhi paper art" returns two files and neither is usable; pichwai is the temple-hanging
  // tradition from the same devotional world and is extensively photographed in the public domain.
  { slug: "pichwai", title: "Pichwai temple hanging", region: "Nathdwara, Rajasthan", query: "Pichwai painting", orientation: "any", file: "File:Temple hanging (pechhavai) - Google Art Project.jpg" },
  { slug: "kolam", title: "Kolam floor drawing", region: "Tamil Nadu", query: "Kolam rangoli floor", orientation: "landscape" },
  { slug: "jaali", title: "Stone jaali screen", region: "Rajasthan and Gujarat", query: "Jali stone screen India", orientation: "landscape" },
  // ⚠ "Moradabad brass" ranks a photograph of BIRYANI above the brassware. Hence the exact file.
  { slug: "brass-casting", title: "Brass and bell-metal work", region: "Moradabad, Uttar Pradesh", query: "Moradabad brass", orientation: "landscape", file: "File:Brass Handicrafts of Moradabad.jpg" },
  { slug: "handloom", title: "Handloom weaving", region: "Kanchipuram, Tamil Nadu", query: "handloom weaving India", orientation: "landscape", file: "File:Complicated hand-loom for silk weaving, Kanchipuram, Tamil Nadu.jpg" },
  { slug: "khurja-pottery", title: "Khurja glazed pottery", region: "Khurja, Uttar Pradesh", query: "Khurja pottery potter", orientation: "landscape", file: "File:Khurja Pottery.jpg" },
  { slug: "papier-mache", title: "Papier-mâché pen box", region: "Kashmir", query: "papier mache Kashmir box painted", orientation: "any", file: "File:Pen Box (qalamdan) LACMA M.89.160a-b.jpg" },
  { slug: "wood-carving", title: "Wood carving", region: "Odisha", query: "wood carving India craft", orientation: "landscape", file: "File:Woodcarving in the Odisha Crafts Museum 02.jpg" }
];

// ─────────────────────────────────────────────────────────────────────────────
// The Commons API
// ─────────────────────────────────────────────────────────────────────────────

interface Candidate {
  fileTitle: string;
  width: number;
  height: number;
  /** A pre-scaled URL at TARGET_WIDTH; Commons renders these itself, so we never fetch a 40 MB TIFF. */
  thumbUrl: string;
  descriptionUrl: string;
  licenceShortName: string;
  licenceUrl: string | null;
  author: string;
  /** The Commons "credit"/source field, when the uploader supplied one. */
  credit: string | null;
}

/**
 * Commons returns small HTML fragments in `extmetadata`. Strip to text; a credit line is not markup.
 *
 * ⚠ CLOSING TAGS BECOME SPACES, AND THAT LINE IS LOAD-BEARING. `<span>Anonymous</span><span>Unknown
 * author</span>` is a real value Commons returns, and stripping tags without putting anything in
 * their place produces "AnonymousUnknown author" — which is what the first run of this script wrote
 * into the manifest, and which would have been published under a photograph as its author's name.
 */
function plainText(value: string | undefined): string {
  if (!value) return "";
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/[a-z][^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tidy an author string into something that can be printed under a photograph.
 *
 * Commons is a wiki, so the `Artist` field is whatever an uploader typed fifteen years ago. Three
 * shapes recur and all three look wrong in a credit line:
 *
 *   • The same name twice — two nested elements carrying identical text.
 *   • "Anonymous", "Unknown author", "Unknown author or not provided", and combinations.
 *   • A trailing wiki-ism such as a bare "(talk)" left over from a signature.
 *
 * All of them collapse to one canonical `UNKNOWN_AUTHOR`, which the credit component knows to render
 * as "Photographer unknown" rather than printing the word "Unknown" as though it were a surname.
 */
const UNKNOWN_AUTHOR = "Unknown";

function normaliseAuthor(raw: string): string {
  let value = raw.replace(/\(talk\)/gi, "").replace(/\s+/g, " ").trim();
  if (value.length === 0) return UNKNOWN_AUTHOR;

  // "Foo Foo" -> "Foo". Split at the midpoint rather than by words, because the duplicated run can
  // itself contain spaces ("Raj Gopal Singh Raj Gopal Singh").
  if (value.length % 2 === 1) {
    const half = (value.length - 1) / 2;
    if (value[half] === " " && value.slice(0, half) === value.slice(half + 1)) {
      value = value.slice(0, half);
    }
  }

  if (/^(anonymous|unknown|not provided|no author|see source)/i.test(value)) return UNKNOWN_AUTHOR;
  return value;
}

interface ExtMetadataField {
  value?: string;
}

interface ImageInfo {
  width?: number;
  height?: number;
  thumburl?: string;
  url?: string;
  descriptionurl?: string;
  extmetadata?: Record<string, ExtMetadataField | undefined>;
}

interface SearchPage {
  title?: string;
  imageinfo?: ImageInfo[];
}

async function searchCommons(subject: Subject): Promise<Candidate[]> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    // ⚠ VERSION 2, NOT 1. Version 1 returns `query.pages` as an OBJECT keyed by page id; version 2
    // returns it as an ARRAY. The code below iterates, so version 1 fails with "pages is not
    // iterable" on every subject that actually matched — and succeeds silently on every subject that
    // matched nothing, which is the worst possible way round.
    formatversion: "2",
    prop: "imageinfo",
    iiprop: "url|size|extmetadata",
    iiurlwidth: String(TARGET_WIDTH)
  });

  if (subject.file) {
    // `titles` addresses the file directly. Everything downstream — licence allowlist, minimum
    // width, format check — is unchanged, so a hand-picked file that turns out to be non-free is
    // still rejected rather than trusted because a person typed it.
    params.set("titles", subject.file);
  } else {
    params.set("generator", "search");
    params.set("gsrsearch", `filetype:bitmap ${subject.query}`);
    params.set("gsrnamespace", "6");
    // Deliberately generous: most results are rejected for licence, size or shape, and a search that
    // returns twelve candidates for a narrow craft term routinely yields only two usable ones.
    params.set("gsrlimit", "24");
  }

  const response = await fetch(`${COMMONS_API}?${params.toString()}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" }
  });
  if (!response.ok) throw new Error(`Commons search failed for "${subject.query}": HTTP ${response.status}`);

  const body = (await response.json()) as { query?: { pages?: SearchPage[] } };
  const pages = body.query?.pages ?? [];

  const candidates: Candidate[] = [];
  for (const page of pages) {
    const info = page.imageinfo?.[0];
    if (!info || !page.title) continue;

    const meta = info.extmetadata ?? {};
    const licence = plainText(meta.LicenseShortName?.value);
    const width = info.width ?? 0;
    const height = info.height ?? 0;
    const thumbUrl = info.thumburl ?? info.url;

    if (!thumbUrl || !info.descriptionurl) continue;
    if (!ACCEPTABLE_LICENCES.has(licence)) continue;
    if (width < MIN_SOURCE_WIDTH) continue;

    // An SVG or a PNG diagram is not a photograph. `filetype:bitmap` already excludes SVG; this
    // excludes the scanned line drawings that come back for painting terms.
    if (!/\.(jpe?g|png)$/i.test(page.title)) continue;

    candidates.push({
      fileTitle: page.title,
      width,
      height,
      thumbUrl,
      descriptionUrl: info.descriptionurl,
      licenceShortName: licence,
      licenceUrl: plainText(meta.LicenseUrl?.value) || null,
      author: normaliseAuthor(plainText(meta.Artist?.value)),
      credit: plainText(meta.Credit?.value) || null
    });
  }

  return candidates;
}

/**
 * Rank the candidates and take the best.
 *
 * Shape first, because a portrait photograph in a 21:9 banner is unusable however good it is; then
 * resolution, because everything else is a matter of taste this script cannot exercise. The chooser
 * is deliberately simple — a human reviews the result set afterwards and re-runs with a different
 * `query` for any subject whose picture is wrong. Pretending an algorithm can judge a photograph would
 * mean nobody looks at them.
 */
function bestCandidate(subject: Subject, candidates: Candidate[]): Candidate | null {
  const scored = candidates
    .map((candidate) => {
      const ratio = candidate.width / candidate.height;
      let score = 0;

      if (subject.orientation === "landscape") score += ratio >= 1.3 ? 40 : ratio >= 1.1 ? 15 : -40;
      else if (subject.orientation === "portrait") score += ratio <= 0.85 ? 40 : ratio <= 1 ? 15 : -40;

      // Resolution, flattened: 4000px is not twice as useful as 2000px when we store 2000.
      score += Math.min(20, Math.round(candidate.width / 250));

      // A licence with no share-alike obligation is easier for the institution to live with.
      if (candidate.licenceShortName.startsWith("CC BY ")) score += 6;
      if (!ACCEPTABLE_LICENCES.get(candidate.licenceShortName)?.requiresAttribution) score += 8;

      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.candidate ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Download and manifest
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const IMAGE_DIR = path.join(REPO_ROOT, "public", "craft");
const MANIFEST_PATH = path.join(REPO_ROOT, "lib", "media", "craft-imagery.ts");

interface ManifestEntry {
  slug: string;
  title: string;
  region: string;
  src: string;
  width: number;
  height: number;
  author: string;
  licence: string;
  licenceUrl: string | null;
  sourceUrl: string;
  /** Of the STORED bytes, so a re-run can tell "already correct" from "changed upstream". */
  sha256: string;
}

/**
 * Fetch, RE-ENCODE, and store — and the re-encode is not optional.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * Commons serves its scaled renditions at archival quality: the first run of this script produced
 * twenty-six files totalling 78 MB, several of them over 5 MB each. That is not a size a repository
 * should carry, and `next/image` does not fix it — the optimiser reads the file from disk on every
 * cold cache entry, so an oversized original is decode time on the server for every width it emits.
 *
 * `sharp` is already a dependency (the derivative pipeline uses it), so the fix is one pass:
 *
 *   • **mozjpeg at quality 72.** On photographic material this is visually indistinguishable from the
 *     original at the sizes the site actually renders, and it is roughly a tenth of the bytes.
 *   • **`progressive`**, so a slow connection paints a whole soft picture and then sharpens it,
 *     rather than a sharp band that grows downward.
 *   • **`.rotate()` FIRST AND WITH NO ARGUMENT**, which applies the EXIF orientation tag and then
 *     drops it. Without it a phone photograph stored with "rotate 90°" in its metadata is written out
 *     with the tag stripped by the re-encode and the pixels untouched — so it appears on its side,
 *     and the width and height in the manifest describe the wrong axes.
 *   • **No metadata copied.** EXIF on a Commons photograph routinely carries the photographer's GPS
 *     position. Republishing that is a privacy leak the licence certainly does not ask for.
 *
 * The dimensions come back from sharp's own output info rather than being computed from the source,
 * so the manifest cannot disagree with the file even when `.rotate()` has swapped the axes.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function download(
  candidate: Candidate,
  slug: string
): Promise<{ bytes: Buffer; width: number; height: number }> {
  const response = await fetch(candidate.thumbUrl, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`download failed for ${slug}: HTTP ${response.status}`);

  const source = Buffer.from(await response.arrayBuffer());
  const { data, info } = await sharp(source)
    .rotate()
    .resize({ width: TARGET_WIDTH, height: TARGET_WIDTH, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 72, progressive: true, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  // Everything is stored as .jpg regardless of the source extension: `next/image` re-encodes to AVIF
  // or WebP on the way out, so the stored format only has to be one the optimiser reads.
  await writeFile(path.join(IMAGE_DIR, `${slug}.jpg`), data);
  return { bytes: data, width: info.width, height: info.height };
}

function manifestSource(entries: ManifestEntry[]): string {
  const rows = entries
    .map(
      (entry) => `  {
    slug: ${JSON.stringify(entry.slug)},
    title: ${JSON.stringify(entry.title)},
    region: ${JSON.stringify(entry.region)},
    src: ${JSON.stringify(entry.src)},
    width: ${entry.width},
    height: ${entry.height},
    author: ${JSON.stringify(entry.author)},
    licence: ${JSON.stringify(entry.licence)},
    licenceUrl: ${entry.licenceUrl === null ? "null" : JSON.stringify(entry.licenceUrl)},
    sourceUrl: ${JSON.stringify(entry.sourceUrl)},
    sha256: ${JSON.stringify(entry.sha256)}
  }`
    )
    .join(",\n");

  return `/**
 * THE CRAFT IMAGERY MANIFEST — GENERATED. DO NOT EDIT BY HAND.
 *
 * Written by \`npx tsx scripts/fetch-craft-imagery.ts\`. Every entry describes one photograph in
 * public/craft/ and carries what its licence requires to be carried: the author, the licence, a link
 * to the licence text and a link to the file's page on Wikimedia Commons.
 *
 * ⚠ EDITING THIS FILE IS HOW A CREDIT COMES TO DISAGREE WITH THE PICTURE IT CREDITS. To change a
 * photograph, change its \`query\` in the script and re-run it for that slug.
 *
 * \`width\` and \`height\` are the dimensions of the STORED file, so \`next/image\` reserves the right
 * box and the card does not shift when the picture decodes.
 *
 * Every licence here is a free one; the script rejects anything not on its allowlist. Attribution is
 * rendered by components/site/ImageCredit.tsx, which is what actually satisfies the CC BY family.
 */

export interface CraftImage {
  /** Stable key. Appears in committed markup, so it does not change when a picture is replaced. */
  slug: string;
  /** What the photograph shows, as the site would say it. The default alt text. */
  title: string;
  /** Where the craft is from. Rendered in the caption. */
  region: string;
  /** Public path, ready for \`next/image\`. */
  src: string;
  width: number;
  height: number;
  author: string;
  licence: string;
  licenceUrl: string | null;
  sourceUrl: string;
  /** Of the stored bytes. Lets a re-run tell "unchanged" from "replaced upstream". */
  sha256: string;
}

export const CRAFT_IMAGES: readonly CraftImage[] = [
${rows}
];

/** By slug, or null. Never throws: a slug can arrive from stored section data. */
export function craftImage(slug: string): CraftImage | null {
  return CRAFT_IMAGES.find((image) => image.slug === slug) ?? null;
}

/** Every slug, for a picker. */
export const CRAFT_IMAGE_SLUGS: readonly string[] = CRAFT_IMAGES.map((image) => image.slug);
`;
}

/**
 * The manifest as it stands, parsed back into entries — WHOLE ENTRIES, not just their slugs.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS FUNCTION EXISTS TO STOP A SINGLE-SUBJECT RUN DESTROYING TWENTY-FIVE LICENCE RECORDS.
 *
 * `main()` rewrites the manifest from the entries it has in hand. An earlier version of this file
 * collected only the subjects it had just fetched, so `npx tsx scripts/fetch-craft-imagery.ts warli`
 * wrote a manifest containing exactly one photograph — and the author, licence and source URL of
 * every other picture in `public/craft/` were gone, while the JPEGs themselves stayed on disk. The
 * files would then have rendered with no attribution at all, which is the precise failure the whole
 * script exists to prevent.
 *
 * So the rewrite is a MERGE over what is already there, and that requires reading the existing
 * entries in full.
 *
 * IT PARSES THE GENERATED LITERAL RATHER THAN IMPORTING THE MODULE. Importing would make the fetcher
 * unusable exactly when it is most needed — while the manifest is half-written or does not typecheck.
 * The parse is deliberately strict: a block that does not yield every field is DISCARDED rather than
 * half-kept, because a partial entry would be written back out as a credit with holes in it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function existingManifest(): Promise<Map<string, ManifestEntry>> {
  const entries = new Map<string, ManifestEntry>();

  let source: string;
  try {
    source = await readFile(MANIFEST_PATH, "utf8");
  } catch {
    // No manifest yet — the first run. An empty map is the right answer, not an error.
    return entries;
  }

  // Only the array literal, so the `CraftImage` INTERFACE above it (whose field names are identical)
  // cannot be mistaken for an entry.
  const arrayStart = source.indexOf("export const CRAFT_IMAGES");
  const body = arrayStart >= 0 ? source.slice(arrayStart) : source;

  const field = (block: string, name: string): string | null => {
    const match = block.match(new RegExp(`\\b${name}: "((?:[^"\\\\]|\\\\.)*)"`));
    return match?.[1] ? JSON.parse(`"${match[1]}"`) : null;
  };
  const number = (block: string, name: string): number | null => {
    const match = block.match(new RegExp(`\\b${name}: (\\d+)`));
    return match?.[1] ? Number(match[1]) : null;
  };

  for (const match of body.matchAll(/\{\s*slug: "[^"]+",[\s\S]*?sha256: "[^"]*"\s*\}/g)) {
    const block = match[0];
    const slug = field(block, "slug");
    const title = field(block, "title");
    const region = field(block, "region");
    const src = field(block, "src");
    const width = number(block, "width");
    const height = number(block, "height");
    const author = field(block, "author");
    const licence = field(block, "licence");
    const sourceUrl = field(block, "sourceUrl");
    const sha256 = field(block, "sha256");

    if (!slug || !title || !region || !src || !width || !height || !author || !licence || !sourceUrl) {
      continue;
    }

    entries.set(slug, {
      slug,
      title,
      region,
      src,
      width,
      height,
      author,
      licence,
      // `null` is a legitimate stored value (a public-domain file has no licence deed to link to),
      // so its absence is not a reason to discard the entry.
      licenceUrl: field(block, "licenceUrl"),
      sourceUrl,
      sha256: sha256 ?? ""
    });
  }

  return entries;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const only = argv.filter((arg) => !arg.startsWith("--"));

  const wanted = only.length > 0 ? SUBJECTS.filter((s) => only.includes(s.slug)) : SUBJECTS;
  if (wanted.length === 0) {
    console.error(`No subject matches ${only.join(", ")}. Known slugs: ${SUBJECTS.map((s) => s.slug).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  await mkdir(IMAGE_DIR, { recursive: true });

  /**
   * THE MERGE TARGET, seeded with every entry already on file.
   *
   * A subject that is fetched overwrites its entry; a subject that is not fetched — because this is a
   * single-subject run, or because it was skipped as already present — keeps the one it had. So the
   * manifest that gets written always describes every photograph in `public/craft/`, never only the
   * ones this invocation happened to touch.
   */
  const merged = await existingManifest();
  const failures: string[] = [];
  let fetched = 0;
  let skipped = 0;

  for (const subject of wanted) {
    /**
     * Skip anything already fetched, unless `--force` or an explicit subject list says otherwise.
     *
     * ⚠ THE FILE ON DISK IS CHECKED, NOT ONLY THE MANIFEST ENTRY. A manifest row whose JPEG has been
     * deleted is the state a re-run is most needed for, and trusting the row alone would skip it
     * forever — leaving a credit for a photograph that is not there.
     *
     * NAMING A SUBJECT ALWAYS RE-FETCHES IT. `… fetch-craft-imagery.ts warli` is a request to replace
     * that photograph; there would be no other way to ask.
     */
    if (!force && only.length === 0 && merged.has(subject.slug)) {
      const onDisk = await stat(path.join(IMAGE_DIR, `${subject.slug}.jpg`)).catch(() => null);
      if (onDisk?.isFile()) {
        skipped++;
        continue;
      }
    }

    process.stdout.write(`· ${subject.slug.padEnd(16)} `);
    try {
      const candidates = await searchCommons(subject);
      const chosen = bestCandidate(subject, candidates);
      if (!chosen) {
        failures.push(`${subject.slug}: no freely licensed candidate at ${MIN_SOURCE_WIDTH}px or wider`);
        process.stdout.write("no usable candidate\n");
        continue;
      }

      const { bytes, width, height } = await download(chosen, subject.slug);
      fetched++;

      merged.set(subject.slug, {
        slug: subject.slug,
        title: subject.title,
        region: subject.region,
        src: `/craft/${subject.slug}.jpg`,
        width,
        height,
        author: chosen.author,
        licence: chosen.licenceShortName,
        licenceUrl: chosen.licenceUrl,
        sourceUrl: chosen.descriptionUrl,
        sha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16)
      });

      process.stdout.write(
        `${String(width).padStart(4)}×${String(height).padEnd(4)} ${chosen.licenceShortName.padEnd(13)} ${chosen.author.slice(0, 40)}\n`
      );
    } catch (error) {
      failures.push(`${subject.slug}: ${error instanceof Error ? error.message : String(error)}`);
      process.stdout.write("failed\n");
    }

    // Courtesy to Commons. It is a donated service and this script is not in a hurry.
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  if (fetched > 0) {
    const entries = Array.from(merged.values()).sort((a, b) => a.slug.localeCompare(b.slug));
    await writeFile(MANIFEST_PATH, manifestSource(entries), "utf8");
    console.log(
      `\nWrote ${entries.length} entries to lib/media/craft-imagery.ts ` +
        `(${fetched} fetched, ${entries.length - fetched} carried over${skipped > 0 ? `, ${skipped} already present` : ""})`
    );
  } else {
    // Nothing was fetched, so nothing may be written. Rewriting the manifest here would be a
    // no-change write at best and, if a subject failed, a way to lose an entry for no reason.
    console.log(`\nNothing fetched — ${skipped} subject(s) already present, manifest left alone.`);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} subject(s) produced nothing:`);
    for (const failure of failures) console.error(`  ${failure}`);
    // Non-zero, deliberately: a partial picture set is exactly the state somebody needs to be told
    // about, and a silent success would leave a story block pointing at a file that does not exist.
    process.exitCode = 1;
  }
}

void main();
