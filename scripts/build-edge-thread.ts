/**
 * Write public/edge-thread.svg — the stitched page edge's repeat — from the craft motifs.
 *
 * Run after changing components/craft/motifs.ts or components/site/embroidery-edge-tile.ts:
 *
 *     npx tsx scripts/build-edge-thread.ts
 *
 * tests/site/edge-thread.test.ts fails until the file matches what the motifs produce, so a stale tile
 * cannot ship. The file is an asset rather than something built at request time because the browser then
 * downloads it once and caches it, instead of every page carrying the 8.4 kB tile (or the motif module).
 */

import { writeFileSync } from "node:fs";
import path from "node:path";

import { edgeTileSvg } from "../components/site/embroidery-edge-tile";

const target = path.join(process.cwd(), "public", "edge-thread.svg");
writeFileSync(target, edgeTileSvg(), "utf8");
console.log(`wrote ${path.relative(process.cwd(), target)}`);
