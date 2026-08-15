/**
 * Encodes the Centre's craft CONTACT SHEETS and generates `lib/media/craft-sheets.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT A SHEET IS, AND WHY IT IS NOT A PHOTOGRAPH
 *
 * The Centre's craft taxonomy arrived as one document — "Craft thumbnail" — holding forty-three
 * plates: one for each of the nine top-level categories, then one for each of the thirty-four
 * subcategories beneath them. Every plate is a MOSAIC of six to eight separate photographs laid out
 * on a flat cream ground, not a single frame. That is the whole reason this file exists next to
 * `craft-imagery.ts` rather than inside it.
 *
 * ⚠ A SHEET MAY NEVER BE USED WHERE A PHOTOGRAPH IS WANTED, and the two failures are different:
 *
 *   • As a full-bleed backdrop it is destroyed. `object-cover` on a phone keeps roughly the central
 *     43% of a 16:9 source, which slices the mosaic through the middle of its cells, and the cream
 *     gutters render as grey rules under the hero's veil. The hero therefore mounts sheets in a
 *     FRAME, at their own proportion, cropping nothing — see `SheetPlates` in HeroSection.tsx.
 *   • At thumbnail size it is illegible. Each cell is about an eighth of the sheet's width, so a
 *     240px card renders cells 30px across. A sheet wants a frame no narrower than ~380 CSS px.
 *
 * What a sheet IS good for is exactly what a contact sheet is good for anywhere else: showing the
 * BREADTH of a category in one object. Nine photographs of nine crafts say "we document nine
 * things"; one sheet says "each of these nine is itself a dozen traditions", which is the Centre's
 * actual claim and is not a sentence anybody has to read.
 *
 * ── RUNNING IT ────────────────────────────────────────────────────────────────────────────────
 *
 *   npm run build-craft-sheets
 *
 * Reads `.craft-source/imageNN.png` — the forty-three masters at 2048×1143, ~217 MB, extracted from
 * the source document and GITIGNORED. They are the input and are never served. Recover them with:
 *
 *   cd .craft-source && unzip -j "Craft thumbnail (2).docx" "word/media/*"
 *
 * Writes `public/craft/sheets/<slug>.jpg` and rewrites `lib/media/craft-sheets.ts` WHOLE. The
 * generated manifest is committed; the masters are not.
 *
 * ⚠ THE `image31.png`-STYLE NAMES ARE THE DOCUMENT'S ORDER, NOT THE TAXONOMY'S. Word numbers media
 * by first use in its own relationship table, so `image31` is the FIRST plate in the document and
 * `image1` is the eighteenth. The mapping in `SHEETS` below was read off the document body in
 * order — heading, then the image beneath it — and it is the only thing tying a picture to the
 * craft it shows. It cannot be derived and must not be "tidied".
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

const ROOT = process.cwd();
const SOURCE_DIR = path.join(ROOT, ".craft-source");
const OUT_DIR = path.join(ROOT, "public", "craft", "sheets");
const MANIFEST = path.join(ROOT, "lib", "media", "craft-sheets.ts");

/**
 * 1600px and quality 80.
 *
 * The widest a sheet is ever drawn is the hero's principal plate — about 460 CSS px, so 920px on a
 * 2× screen — and `next/image` serves an AVIF derivative of this file rather than this file. So the
 * stored width is a MASTER for the optimiser, not a delivery size, and 1600 leaves room for a
 * category header or a lightbox later without going back to the source document.
 *
 * Quality 80 rather than the 72 `fetch-craft-imagery.ts` uses on single photographs: a mosaic is
 * mostly EDGES — thirty-odd hard rectangle boundaries and the fine detail inside each cell — and
 * that is exactly what a low-quality JPEG spends its bits badly on. Measured on the textile sheet,
 * 72 → 221 KB and 80 → 270 KB; 49 KB is a fair price for not ringing every gutter.
 */
const SHEET_WIDTH = 1600;
const SHEET_QUALITY = 80;

interface SheetSpec {
  slug: string;
  /** The file in `.craft-source/`, without extension. Document order — see the header. */
  source: string;
  /** As the document titles it, tidied to sentence case. */
  title: string;
  categoryId: number;
  category: string;
  /** "1.2", or null when the sheet IS the category plate. */
  subcategoryId: string | null;
}

/**
 * The document, in its own order. Nine category plates, then the subcategory plates beneath each.
 *
 * ⚠ TWO ABSENCES ARE REAL AND ARE NOT TO BE FILLED IN. Category 8 (Paper) has a category plate and
 * no subcategory plates. Subcategory 9.8 (Other Crafts) is the only heading in the document with no
 * image under it at all. Both are gaps in the source, and inventing a picture for either would be
 * the archive asserting something it does not know.
 */
const SHEETS: readonly SheetSpec[] = [
  // ── The nine category plates ────────────────────────────────────────────────
  { slug: "textile", source: "image31", title: "Textile-based crafts", categoryId: 1, category: "Textile-based crafts", subcategoryId: null },
  { slug: "metal", source: "image42", title: "Metal crafts", categoryId: 2, category: "Metal crafts", subcategoryId: null },
  { slug: "stone", source: "image40", title: "Stone crafts", categoryId: 3, category: "Stone crafts", subcategoryId: null },
  { slug: "wood", source: "image18", title: "Wood crafts", categoryId: 4, category: "Wood crafts", subcategoryId: null },
  { slug: "leather", source: "image12", title: "Leather crafts", categoryId: 5, category: "Leather crafts", subcategoryId: null },
  { slug: "natural-fibre", source: "image28", title: "Natural fibre and grass crafts", categoryId: 6, category: "Natural fibre and grass crafts", subcategoryId: null },
  { slug: "mud", source: "image39", title: "Mud-based crafts", categoryId: 7, category: "Mud-based crafts", subcategoryId: null },
  { slug: "paper", source: "image16", title: "Paper crafts", categoryId: 8, category: "Paper crafts", subcategoryId: null },
  { slug: "miscellaneous", source: "image25", title: "Miscellaneous crafts", categoryId: 9, category: "Miscellaneous crafts", subcategoryId: null },

  // ── 1. Textile ──────────────────────────────────────────────────────────────
  { slug: "textile-embroidery", source: "image15", title: "Embroidery", categoryId: 1, category: "Textile-based crafts", subcategoryId: "1.1" },
  { slug: "textile-block-printing", source: "image3", title: "Hand block printing", categoryId: 1, category: "Textile-based crafts", subcategoryId: "1.2" },
  { slug: "textile-carpets", source: "image9", title: "Carpets, rugs and durries", categoryId: 1, category: "Textile-based crafts", subcategoryId: "1.3" },
  { slug: "textile-other", source: "image10", title: "Other textile-based crafts", categoryId: 1, category: "Textile-based crafts", subcategoryId: "1.4" },

  // ── 2. Metal ────────────────────────────────────────────────────────────────
  { slug: "metal-silver", source: "image41", title: "Silver", categoryId: 2, category: "Metal crafts", subcategoryId: "2.1" },
  { slug: "metal-gold", source: "image20", title: "Gold", categoryId: 2, category: "Metal crafts", subcategoryId: "2.2" },
  { slug: "metal-bronze", source: "image4", title: "Bronze", categoryId: 2, category: "Metal crafts", subcategoryId: "2.3" },
  { slug: "metal-brass", source: "image34", title: "Brass", categoryId: 2, category: "Metal crafts", subcategoryId: "2.4" },
  { slug: "metal-iron", source: "image36", title: "Iron", categoryId: 2, category: "Metal crafts", subcategoryId: "2.5" },
  { slug: "metal-copper", source: "image21", title: "Copper", categoryId: 2, category: "Metal crafts", subcategoryId: "2.6" },
  { slug: "metal-other", source: "image6", title: "Other metal crafts", categoryId: 2, category: "Metal crafts", subcategoryId: "2.7" },

  // ── 3. Stone ────────────────────────────────────────────────────────────────
  { slug: "stone-carving", source: "image32", title: "Stone carving", categoryId: 3, category: "Stone crafts", subcategoryId: "3.1" },
  { slug: "stone-inlay", source: "image2", title: "Stone inlay", categoryId: 3, category: "Stone crafts", subcategoryId: "3.2" },
  { slug: "stone-other", source: "image29", title: "Other stone crafts", categoryId: 3, category: "Stone crafts", subcategoryId: "3.3" },

  // ── 4. Wood ─────────────────────────────────────────────────────────────────
  { slug: "wood-artwares", source: "image33", title: "Wooden artwares", categoryId: 4, category: "Wood crafts", subcategoryId: "4.1" },
  { slug: "wood-carving", source: "image17", title: "Wood carving", categoryId: 4, category: "Wood crafts", subcategoryId: "4.2" },
  { slug: "wood-inlay", source: "image1", title: "Wood inlay and marquetry", categoryId: 4, category: "Wood crafts", subcategoryId: "4.3" },
  { slug: "wood-lacquer", source: "image26", title: "Wood turning and lacquer ware", categoryId: 4, category: "Wood crafts", subcategoryId: "4.4" },
  { slug: "wood-furniture", source: "image27", title: "Wooden furniture", categoryId: 4, category: "Wood crafts", subcategoryId: "4.5" },

  // ── 5. Leather ──────────────────────────────────────────────────────────────
  { slug: "leather-footwear", source: "image13", title: "Leather footwear", categoryId: 5, category: "Leather crafts", subcategoryId: "5.1" },
  { slug: "leather-other", source: "image8", title: "Other leather articles", categoryId: 5, category: "Leather crafts", subcategoryId: "5.2" },

  // ── 6. Natural fibre and grass ──────────────────────────────────────────────
  { slug: "fibre-natural", source: "image37", title: "Natural fibre", categoryId: 6, category: "Natural fibre and grass crafts", subcategoryId: "6.1" },
  { slug: "fibre-cane-bamboo", source: "image22", title: "Cane and bamboo", categoryId: 6, category: "Natural fibre and grass crafts", subcategoryId: "6.2" },
  { slug: "fibre-grass", source: "image24", title: "Grass work", categoryId: 6, category: "Natural fibre and grass crafts", subcategoryId: "6.3" },
  { slug: "fibre-leaf-reed", source: "image23", title: "Leaf, reed and rattan", categoryId: 6, category: "Natural fibre and grass crafts", subcategoryId: "6.4" },

  // ── 7. Mud-based ────────────────────────────────────────────────────────────
  { slug: "mud-terracotta", source: "image35", title: "Terracotta and pottery", categoryId: 7, category: "Mud-based crafts", subcategoryId: "7.1" },
  { slug: "mud-other", source: "image7", title: "Other mud-based crafts", categoryId: 7, category: "Mud-based crafts", subcategoryId: "7.2" },

  // ── 9. Miscellaneous ────────────────────────────────────────────────────────
  { slug: "misc-folk-painting", source: "image5", title: "Folk painting", categoryId: 9, category: "Miscellaneous crafts", subcategoryId: "9.1" },
  { slug: "misc-jewellery", source: "image30", title: "Jewellery", categoryId: 9, category: "Miscellaneous crafts", subcategoryId: "9.2" },
  { slug: "misc-bone-horn-shell", source: "image14", title: "Bone, horn and shell", categoryId: 9, category: "Miscellaneous crafts", subcategoryId: "9.3" },
  { slug: "misc-lac-wax", source: "image38", title: "Lac and wax", categoryId: 9, category: "Miscellaneous crafts", subcategoryId: "9.4" },
  { slug: "misc-figurines-toys", source: "image43", title: "Figurines and toys", categoryId: 9, category: "Miscellaneous crafts", subcategoryId: "9.5" },
  { slug: "misc-musical-instruments", source: "image19", title: "Musical instruments", categoryId: 9, category: "Miscellaneous crafts", subcategoryId: "9.6" },
  { slug: "misc-glass-beads", source: "image11", title: "Glass and beads", categoryId: 9, category: "Miscellaneous crafts", subcategoryId: "9.7" }
];

interface BuiltSheet extends SheetSpec {
  src: string;
  width: number;
  height: number;
  blurDataUrl: string;
  sha256: string;
}

/**
 * A tiny blurred placeholder as a data URI.
 *
 * ⚠ THE SAME RECIPE AS `generateBlurDataUrl` IN lib/storage/derivatives.ts, DELIBERATELY DUPLICATED.
 * That module opens with `import "server-only"` and pulls in the S3 client at module scope, so a
 * BUILD script importing it would need live bucket credentials to encode a picture. Four lines of
 * sharp is a much smaller liability than that coupling. If the recipe there changes, change it here.
 */
async function blurDataUrl(bytes: Buffer): Promise<string> {
  const buffer = await sharp(bytes).resize(16, 16, { fit: "inside" }).webp({ quality: 40 }).toBuffer();
  return `data:image/webp;base64,${buffer.toString("base64")}`;
}

async function buildSheet(spec: SheetSpec): Promise<BuiltSheet> {
  const source = path.join(SOURCE_DIR, `${spec.source}.png`);
  const input = await readFile(source);

  const { data, info } = await sharp(input)
    // `withoutEnlargement` so a master smaller than 1600 is kept at its own width rather than being
    // upscaled — an upscaled derivative is worse than the original AND larger on the wire.
    .resize({ width: SHEET_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: SHEET_QUALITY, progressive: true, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  await writeFile(path.join(OUT_DIR, `${spec.slug}.jpg`), data);

  return {
    ...spec,
    src: `/craft/sheets/${spec.slug}.jpg`,
    // From sharp's own report on the OUTPUT, never from the requested width: the resize is
    // `withoutEnlargement` and the rounding of the derived height is sharp's to make, not ours.
    width: info.width,
    height: info.height,
    blurDataUrl: await blurDataUrl(data),
    // Of the STORED bytes, so a re-run can tell "unchanged" from "re-encoded".
    sha256: createHash("sha256").update(data).digest("hex").slice(0, 16)
  };
}

function emitManifest(sheets: readonly BuiltSheet[]): string {
  const entries = sheets
    .map(
      (s) => `  {
    slug: ${JSON.stringify(s.slug)},
    title: ${JSON.stringify(s.title)},
    categoryId: ${s.categoryId},
    category: ${JSON.stringify(s.category)},
    subcategoryId: ${s.subcategoryId === null ? "null" : JSON.stringify(s.subcategoryId)},
    src: ${JSON.stringify(s.src)},
    width: ${s.width},
    height: ${s.height},
    blurDataUrl: ${JSON.stringify(s.blurDataUrl)},
    sha256: ${JSON.stringify(s.sha256)}
  }`
    )
    .join(",\n");

  return `/**
 * THE CRAFT CONTACT SHEETS — GENERATED. DO NOT EDIT BY HAND.
 *
 * Written by \`npm run build-craft-sheets\`, from the Centre's own "Craft thumbnail" document. Every
 * entry is one PLATE: a mosaic of six to eight photographs of a craft category, laid out on a cream
 * ground. Nine plates for the top-level categories, then one for each documented subcategory.
 *
 * ⚠ THESE ARE THE CENTRE'S OWN PICTURES AND CARRY NO THIRD-PARTY LICENCE. That is the difference
 * between this manifest and \`craft-imagery.ts\`, whose twenty-six photographs are openly licensed
 * from Wikimedia Commons and each of which owes an attribution rendered by ImageCredit.tsx. Nothing
 * here owes one. Do not add credit machinery to a sheet, and do not move a sheet into the other
 * manifest, whose \`CraftImage\` type requires licence fields a sheet has no honest values for.
 *
 * ⚠ A SHEET IS NOT A PHOTOGRAPH AND BREAKS IN TWO SPECIFIC WAYS WHEN TREATED AS ONE — as a cropped
 * full-bleed backdrop, and at thumbnail size. Both are set out in scripts/build-craft-sheets.ts.
 * Mount a sheet in a frame at its own proportion, no narrower than about 380 CSS px.
 *
 * \`width\` and \`height\` are of the STORED file, so \`next/image\` reserves the right box and nothing
 * shifts when the picture decodes. \`blurDataUrl\` is a 16px WebP, under a kilobyte, for
 * \`placeholder="blur"\`.
 *
 * To change a picture, replace its master in \`.craft-source/\` and re-run — never edit this file.
 */

export interface CraftSheet {
  /** Stable key. Appears in committed markup, so it does not change when a picture is replaced. */
  slug: string;
  /** What the plate shows, as the site would say it. The default alt text. */
  title: string;
  /** 1–9, the document's own top-level numbering. */
  categoryId: number;
  /** The category this plate belongs to, spelled out. */
  category: string;
  /** "1.2" for a subcategory plate; \`null\` when the plate IS the category. */
  subcategoryId: string | null;
  /** Public path, ready for \`next/image\`. */
  src: string;
  width: number;
  height: number;
  /** A 16px WebP data URI for \`placeholder="blur"\`. */
  blurDataUrl: string;
  /** Of the stored bytes. Lets a re-run tell "unchanged" from "re-encoded". */
  sha256: string;
}

export const CRAFT_SHEETS: readonly CraftSheet[] = [
${entries}
];

const BY_SLUG: ReadonlyMap<string, CraftSheet> = new Map(
  CRAFT_SHEETS.map((sheet) => [sheet.slug, sheet])
);

/**
 * By slug, or null. Never throws: a slug can arrive from stored section data, and a plate can be
 * retired by a later run of the generator. Every caller must handle the null.
 */
export function craftSheet(slug: string): CraftSheet | null {
  return BY_SLUG.get(slug) ?? null;
}

/** The nine category plates, in the document's order. */
export const CRAFT_CATEGORY_SHEETS: readonly CraftSheet[] = CRAFT_SHEETS.filter(
  (sheet) => sheet.subcategoryId === null
);

/** Every slug, for a picker. */
export const CRAFT_SHEET_SLUGS: readonly string[] = CRAFT_SHEETS.map((sheet) => sheet.slug);
`;
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const built: BuiltSheet[] = [];
  // Sequential rather than parallel: sharp holds a decoded 2048×1143 bitmap per job, and
  // forty-three concurrent decodes is how a laptop meets its commit limit for no wall-clock gain.
  for (const spec of SHEETS) {
    const sheet = await buildSheet(spec);
    built.push(sheet);
    console.log(`  ${sheet.slug.padEnd(26)} ${sheet.width}×${sheet.height}  ${sheet.src}`);
  }

  await writeFile(MANIFEST, emitManifest(built), "utf8");

  const bytes = built.length;
  console.log(`\n${bytes} sheets → public/craft/sheets/`);
  console.log(`manifest → lib/media/craft-sheets.ts`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
