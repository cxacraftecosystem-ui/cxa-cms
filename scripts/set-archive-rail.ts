/**
 * Rewrites the landing page's "In the archive" fan to the Centre's own nine craft categories.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS RATHER THAN A SEED EDIT.
 *
 * The fan shipped as eight named traditions — Ajrakh, Patola, Pashmina and so on — each pointing at
 * `/craft-explorer` and each drawing a Wikimedia Commons photograph. Two things were wrong with it:
 * the pictures were not the Centre's, and ELEVEN rows shared one href, so any picture chosen from
 * the row's destination was the same picture eleven times.
 *
 * The honest fix is not a better hash. It is to make the fan say what the Centre's archive is
 * actually organised by: the nine top-level categories of its own taxonomy, each naming its own
 * contact sheet, so the picture and the words agree by construction rather than by coincidence.
 *
 * A script rather than a change to prisma/seed.ts, because seeding never overwrites a page that
 * already exists (`Pages written: 0` on every run against a live database). Editing the seed would
 * change what a FRESH install gets and leave the deployed site exactly as it was.
 *
 *   npx tsx scripts/set-archive-rail.ts
 *
 * ⚠ IT OVERWRITES THE SECTION'S `items` AND NOTHING ELSE — the heading, body, presentation and
 * anchor are left as the editor has them. Re-running is idempotent. Anything an editor has since
 * typed into these rows IS replaced, which is the point, but it is worth knowing before running it
 * a second time months from now.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { PrismaClient } from "@prisma/client";

import { CRAFT_CATEGORY_SHEETS } from "../lib/media/craft-sheets";

const prisma = new PrismaClient();

/**
 * What each category actually is, in the site's own register.
 *
 * Plain and specific, never marketing copy: what the material is and what is done to it. Keyed by
 * the sheet slug so a category that is renamed in the manifest cannot silently lose its sentence —
 * the lookup fails loudly instead.
 */
const DETAIL: Record<string, string> = {
  textile:
    "Weaving, dyeing, printing and embroidery — the largest branch of the archive, and the one with the most hands still in it.",
  metal:
    "Silver, gold, bronze, brass, iron and copper, cast, beaten, engraved and inlaid.",
  stone:
    "Carving, inlay and lattice, worked in marble, sandstone and soapstone.",
  wood: "Carving, turning, lacquer and marquetry, from toys to temple doors.",
  leather: "Footwear and worked articles, tanned and finished by hand.",
  "natural-fibre":
    "Cane, bamboo, grass, leaf and reed — the crafts of what grows nearby.",
  mud: "Terracotta and pottery, thrown, moulded and fired.",
  paper: "Hand-made sheets, papier-mâché and the crafts built on them.",
  miscellaneous:
    "Folk painting, jewellery, bone and horn, lac, toys, instruments, glass and beads."
};

async function main(): Promise<void> {
  const section = await prisma.pageSection.findFirst({
    where: { type: "HORIZONTAL_RAIL", page: { slug: "" } },
    select: { id: true, data: true }
  });

  if (!section) {
    console.error("No HORIZONTAL_RAIL section on the landing page. Nothing changed.");
    process.exitCode = 1;
    return;
  }

  const items = CRAFT_CATEGORY_SHEETS.map((sheet) => {
    const detail = DETAIL[sheet.slug];
    if (!detail) throw new Error(`No sentence written for the "${sheet.slug}" category.`);
    return {
      title: sheet.title,
      // The document's own numbering, so the fan and the taxonomy read as one system.
      meta: `Category ${sheet.categoryId}`,
      detail,
      // ⚠ THE SHEET SLUG GOES IN `craftImage`. HorizontalRailSection resolves that field against
      // the SHEET manifest before the photograph manifest, precisely so an editor can name a plate
      // here without a second field and a second migration.
      craftImage: sheet.slug,
      mediaId: "",
      href: "/craft-explorer"
    };
  });

  // Spread, not replace: `presentation: "arc"`, the heading, the body and the anchor all live in
  // this same Json blob and are the editor's.
  const data = { ...(section.data as Record<string, unknown>), items };

  await prisma.pageSection.update({ where: { id: section.id }, data: { data } });

  console.log(`Rewrote the archive fan to ${items.length} categories:`);
  for (const item of items) console.log(`  ${item.meta.padEnd(11)} ${item.title}`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
