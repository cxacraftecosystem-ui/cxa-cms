/**
 * Which of the Centre's own contact sheets stands for a craft.
 *
 * THE SCHEMA HAS NO CATEGORY COLUMN, and that is the whole difficulty this file exists to solve.
 * `lib/media/craft-sheets.ts` is organised by the Centre's own nine-category document — forty-three
 * plates, nine of them a category and the rest a subcategory — but `prisma.craft` stores a name, a
 * region, `materials[]` and `techniques[]` and nothing that says "this is a textile". So the category
 * is INFERRED from the two fields that actually carry it, and where it cannot be inferred a plate is
 * chosen by a stable hash rather than left out: one pin with no picture beside forty that have one
 * reads as a broken file, not as an honest gap.
 *
 * ⚠ NO PLATE IS EVER PRESENTED AS A PHOTOGRAPH OF THE NAMED CRAFT, which is what makes the hashed
 * fallback honest rather than a small lie. A sheet is a mosaic of six to eight photographs OF A
 * CATEGORY (see that manifest's header), so `MapHoverCard` captions every plate with the plate's own
 * subject — "Contact sheet: Hand block printing". A matched plate then reads as "this is that kind of
 * work" and an unmatched one as "a plate of Indian craft"; neither claims to be a picture of the
 * craft above it, and no caption has to change when a match becomes a fallback.
 *
 * ⚠ TECHNIQUES ARE SCANNED BEFORE MATERIALS, AND THE ORDER IS NOT A PREFERENCE. A Thanjavur painting
 * is painted ON CLOTH and a Pattachitra on treated cotton, so both records list "cotton" among their
 * materials; reading materials first files every painted picture in the corpus under textiles. The
 * technique — "hand painting", "gesso relief", "line drawing" — is what the craft IS. Materials are
 * the fallback for the records whose technique list is empty or unrecognised.
 *
 * ⚠ AND WITHIN EACH LIST, THE RECORD'S OWN ORDER DECIDES — the FIRST entry that matches anything
 * wins, not the first table row that matches anything. The corpus writes the defining technique
 * first and the supporting ones after it, and reading it any other way misfiles the crafts whose
 * second technique belongs to a louder category: chikankari lists `["hand embroidery", "shadow
 * work", "block printing"]` because the pattern is stamped before it is stitched, and a table-first
 * scan hands an embroidery a plate of printed cloth. Pattachitra, pashmina and Bishnupur terracotta
 * are each misfiled by the same reversal, in three different directions.
 *
 * WHAT IT ONLY GETS APPROXIMATELY RIGHT, said plainly: a korai-grass mat woven on a handloom
 * (Pattamadai) is filed under textiles, because weaving is what its record says first and loudest.
 * The caption is what keeps that from being a lie — the plate is labelled "Textile-based crafts", and
 * a woven mat is not misdescribed by it.
 *
 * Nothing here renders, and nothing here reads the database: it takes the three fields it needs so
 * that a server component can resolve a plate once, before the point crosses to the client, and the
 * client never has to ship the forty-three-entry manifest to look one up.
 */

import { hashUnit } from "@/components/craft/motifs";
import { CRAFT_CATEGORY_SHEETS, craftSheet, type CraftSheet } from "@/lib/media/craft-sheets";

/** What a plate can be chosen from — the three craft columns that carry a category between them. */
export interface SheetSubject {
  /** The craft's slug. Hashed for the fallback, so the same craft always draws the same plate. */
  slug: string;
  materials: readonly string[];
  techniques: readonly string[];
}

interface PlateRule {
  readonly term: RegExp;
  /** A slug in `lib/media/craft-sheets.ts`. Verified at use, never assumed — see `craftSheetFor`. */
  readonly plate: string;
}

/**
 * Compile a table of `[term, plate slug]` into matchers, in the table's own order.
 *
 * ⚠ WORD BOUNDARIES, NOT A BARE `includes`. The corpus lists "lampblack" as a pigment and "lacquer"
 * as a finish, and both contain the substring "lac" — which is itself a real material with its own
 * plate. `\blac\b` matches the dyestuff and neither of the other two. It also lets one term stand for
 * a family: `\bembroidery\b` catches "hand embroidery", "counted-thread embroidery" and
 * "metal-thread embroidery" without three rows.
 *
 * ⚠ NO `g` FLAG. A global regex carries `lastIndex` between calls, so a module-scope one would match
 * every other time it was tested — the classic way a lookup table starts returning different answers
 * for identical input.
 *
 * Every term below is written with letters, spaces and hyphens only, none of which is a regex
 * metacharacter, so nothing is escaped. A term containing `.`, `(` or `+` would have to be.
 */
function compile(table: readonly (readonly [string, string])[]): readonly PlateRule[] {
  return table.map(([term, plate]) => ({ term: new RegExp(`\\b${term}\\b`), plate }));
}

/**
 * How a craft is MADE.
 *
 * ⚠ TABLE ORDER ONLY BREAKS TIES WITHIN ONE ENTRY, because the scan is entry-first (see the header).
 * It still matters where a single string could satisfy two rows — "stone carving" must be met before
 * the generic "relief carving" that a carved panel also matches — so the rows are kept most-specific
 * first anyway, and a row added later must be placed by the same rule rather than appended.
 *
 * ⚠ "COILING" IS DELIBERATELY ABSENT. It is the one technique in the corpus that two categories own
 * equally — a coiled pot and a coiled sikki-grass basket are built by the same motion — so a row for
 * it would file every grass basket under pottery. Left out, a coiled craft falls through to its next
 * technique or to its materials, both of which say which of the two it is.
 *
 * The terms are drawn from the fifty-two technique strings the corpus actually uses
 * (prisma/corpus/crafts.ts), not invented: a term that matches nothing is a row that does nothing.
 */
const TECHNIQUE_RULES = compile([
  // Paper. "papier" rather than "papier-mâché": JavaScript's `\b` is ASCII-only, so a boundary after
  // the "é" of "mâché" does not exist and the fuller term would never match anything.
  ["papier", "paper"],
  ["paper cutting", "paper"],
  ["stencil cutting", "paper"],

  // Metal. Casting and beating are the object; inlay is bidri, which has its own plate.
  ["metal inlay", "metal-other"],
  ["lost-wax", "metal"],
  ["sand casting", "metal"],
  ["metal casting", "metal"],
  ["sheet-metal beating", "metal"],
  ["engraving", "metal"],

  // Wood. Turning and lacquer are the Channapatna family; carving is its own plate.
  ["lacquer turnery", "wood-lacquer"],
  ["lacquer finishing", "wood-lacquer"],
  ["wood turning", "wood-lacquer"],
  ["wood carving", "wood-carving"],

  // Stone, before the generic "relief carving" that a stone craft also lists.
  ["stone carving", "stone-carving"],
  ["pierced screen work", "stone-carving"],
  ["relief carving", "wood-carving"],

  // Mud. Every one of these is a potter's verb.
  ["wheel throwing", "mud-terracotta"],
  ["kiln firing", "mud-terracotta"],
  ["glazing", "mud-terracotta"],
  ["hand modelling", "mud-terracotta"],
  ["mould pressing", "mud-terracotta"],

  ["leather punching", "leather-other"],

  // Textile. Printing and embroidery have their own plates; everything woven, spun or dyed shares
  // the category plate, because the manifest has no plate for weaving on its own.
  ["block printing", "textile-block-printing"],
  ["mud-resist printing", "textile-block-printing"],
  ["embroidery", "textile-embroidery"],
  ["darning stitch", "textile-embroidery"],
  ["running stitch", "textile-embroidery"],
  ["shadow work", "textile-embroidery"],
  ["quilting", "textile-embroidery"],
  ["handloom weaving", "textile"],
  ["backstrap weaving", "textile"],
  ["twill tapestry weaving", "textile"],
  ["supplementary weft weaving", "textile"],
  ["double ikat", "textile"],
  ["resist dyeing", "textile"],
  ["mordant dyeing", "textile"],
  ["natural dyeing", "textile"],
  ["hand spinning", "textile"],

  ["retting", "fibre-natural"],
  ["plaiting", "fibre-grass"],

  ["hand painting", "misc-folk-painting"],
  ["mural painting", "misc-folk-painting"],
  ["floor drawing", "misc-folk-painting"],
  ["line drawing", "misc-folk-painting"],
  ["pen drawing", "misc-folk-painting"],
  ["gesso relief", "misc-folk-painting"],
  ["gilding", "misc-folk-painting"]
]);

/**
 * What a craft is MADE OF, scanned only when no technique matched.
 *
 * ⚠ A COMPOUND THAT CONTAINS A LATER TERM MUST COME BEFORE IT, and here table order really does
 * carry weight: one material string can satisfy two rows. "gold and silver thread" is a TEXTILE
 * material containing the whole word "silver", and met by the silversmith's row first it would put a
 * plate of silver vessels beside a zardozi embroidery. The same trap is why "ivory wood" sits with
 * the woods rather than anywhere near the bone-and-horn plate.
 */
const MATERIAL_RULES = compile([
  // The compounds, first, for the reason above.
  ["gold and silver thread", "textile-embroidery"],
  ["silk floss", "textile"],
  ["ivory wood", "wood"],

  ["terracotta", "mud-terracotta"],
  ["clay", "mud-terracotta"],
  ["glaze", "mud-terracotta"],
  ["cobalt oxide", "mud-terracotta"],

  ["marble", "stone-carving"],
  ["granite", "stone-carving"],
  ["sandstone", "stone-carving"],
  ["quartz", "stone"],

  ["silver", "metal-silver"],
  ["gold", "metal-gold"],
  ["brass", "metal-brass"],
  ["copper", "metal-copper"],
  ["bronze", "metal-bronze"],
  ["iron", "metal-iron"],
  ["zinc alloy", "metal-other"],
  ["tin", "metal"],

  ["teak", "wood"],
  ["neem wood", "wood"],
  ["wood", "wood"],

  ["bamboo", "fibre-cane-bamboo"],
  ["cane", "fibre-cane-bamboo"],
  ["grass", "fibre-grass"],
  ["fibre", "fibre-natural"],

  ["paper", "paper"],
  ["hide", "leather"],
  ["leather", "leather"],

  ["lacquer", "misc-lac-wax"],
  ["lac", "misc-lac-wax"],
  ["beeswax", "misc-lac-wax"],

  ["glass", "misc-glass-beads"],
  ["sequins", "misc-glass-beads"],
  ["mineral pigments", "misc-folk-painting"],

  // The textile fibres, last of their family: a craft that reached this far is not printed, not
  // embroidered and not woven by any recorded technique, so the category plate is the honest one.
  ["pashmina", "textile"],
  ["silk", "textile"],
  ["cotton", "textile"],
  ["muslin", "textile"],
  ["khadi", "textile"],
  ["wool", "textile"],
  ["zari", "textile"]
]);

/**
 * The plate for the FIRST entry that matches any rule — entries outer, rules inner.
 *
 * The loop nesting is the rule the header argues for, and reversing it is a one-character change
 * that silently misfiles a quarter of the archive. Fifty rules against five entries is 250 boundary
 * tests per craft, run once per pin on the server; it is not worth an index.
 */
function firstPlate(rules: readonly PlateRule[], entries: readonly string[]): string | null {
  for (const entry of entries) {
    const text = entry.toLowerCase();
    for (const rule of rules) {
      if (rule.term.test(text)) return rule.plate;
    }
  }
  return null;
}

/**
 * The plate for one craft, or `null` if the manifest is empty.
 *
 * ⚠ `craftSheet()` CAN RETURN NULL — a plate is retired whenever `npm run build-craft-sheets` is run
 * against a changed source document — so a matched slug whose plate has gone falls THROUGH to the
 * hashed pick rather than leaving the card pictureless. The `null` return is reserved for the one
 * case no fallback can cover: a manifest with no category plates in it at all.
 *
 * The fallback hashes the SLUG rather than the name: a craft renamed in the studio keeps its picture,
 * which is the whole point of a deterministic pick — the reader who scrolls back up sees the same
 * plate they saw a moment ago.
 */
export function craftSheetFor(craft: SheetSubject): CraftSheet | null {
  const matched =
    firstPlate(TECHNIQUE_RULES, craft.techniques) ?? firstPlate(MATERIAL_RULES, craft.materials);

  if (matched !== null) {
    const sheet = craftSheet(matched);
    if (sheet !== null) return sheet;
  }

  // `hashUnit` returns [0, 1), so this index is always in range — but `noUncheckedIndexedAccess` is
  // right to insist, because the range depends on a generated array being non-empty.
  const index = Math.floor(hashUnit("map-plate", craft.slug) * CRAFT_CATEGORY_SHEETS.length);
  return CRAFT_CATEGORY_SHEETS[index] ?? null;
}
