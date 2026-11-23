import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { edgeTileSvg } from "@/components/site/embroidery-edge-tile";

/**
 * public/edge-thread.svg is generated from the craft motifs (scripts/build-edge-thread.ts) and served as
 * the stitched page edge's mask. It is a file so the browser caches it; this keeps the file from going
 * stale when the motifs or the tile change.
 */
describe("the stitched page edge's mask file", () => {
  it("matches what the motifs produce", () => {
    const onDisk = readFileSync(path.join(process.cwd(), "public", "edge-thread.svg"), "utf8");
    assert.equal(
      onDisk,
      edgeTileSvg(),
      "public/edge-thread.svg is stale: run `npx tsx scripts/build-edge-thread.ts` and commit the file"
    );
  });

  it("is one SVG with a viewBox, which CSS masks need to tile it", () => {
    const svg = edgeTileSvg();
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="20" height="56" viewBox="0 0 20 56">/);
    assert.ok(svg.endsWith("</svg>"));
  });
});
