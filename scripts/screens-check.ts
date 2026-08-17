/**
 * screens-check — the per-screen framing resolver, asserted.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SCRIPT AND NOT A TEST FILE. There is no test runner in this repository — `tsx` is the
 * only thing that runs a `.ts` file, and `npm run check` is where every gate lives (`route-check`,
 * `font-check`, `theme-check`, `media-select-check`). A `*.test.ts` would need a runner nobody installed
 * and would not be run by anything; a check script is run by the same command as everything else.
 *
 * WHY IT EXISTS AT ALL. `scripts/media-select-check.ts` opens with the sentence "A WHOLE FEATURE SHIPPED
 * NON-FUNCTIONAL AND EVERY GATE WAS GREEN" — the crop was stored, editable and rendered by nothing, and
 * `tsc`, `lint`, `route-check` and `smoke` all passed throughout. Per-screen framing is that same feature
 * multiplied by six buckets, and the mechanism that hid the first one is still armed: `MediaLike` makes
 * every field optional, so "this override was not loaded" and "this bucket has no override" are the same
 * shape to TypeScript.
 *
 * `resolvePicture` is the single boundary the public renderer and the studio's preview ladder BOTH go
 * through, so asserting it here is asserting the thing that decides what a reader sees.
 *
 * ⚠ WHAT IT CANNOT SEE: whether any component actually calls the resolver, and whether the emitted CSS
 * reaches a browser. Those need a running page, which is `scripts/smoke.ts`'s job.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { FULL_CROP, cropFrameStyle, cropImageStyle, storedCrop, type CropRect } from "../lib/media/crop";
import {
  SCREEN_BUCKETS,
  cropVarsFor,
  emptyScreenFraming,
  isEmptyScreenFraming,
  resolvePicture,
  screenBucketLabel,
  screenFramingMediaIds,
  setBucket,
  type Picture,
  type ScreenBucketId,
  type ScreenFraming
} from "../lib/media/screens";
import type { MediaLike } from "../lib/media/url";

interface Failure {
  what: string;
  detail: string;
}
const failures: Failure[] = [];
let checks = 0;

function check(ok: boolean, what: string, detail: string): void {
  checks += 1;
  if (!ok) failures.push({ what, detail });
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── Fixtures ────────────────────────────────────────────────────────────────
function asset(objectKey: string, crop?: Partial<CropRect>): MediaLike {
  return {
    objectKey,
    width: 2000,
    height: 1500,
    altText: objectKey,
    blurDataUrl: null,
    cropX: crop?.x ?? null,
    cropY: crop?.y ?? null,
    cropWidth: crop?.width ?? null,
    cropHeight: crop?.height ?? null,
    variants: [{ label: "lg", format: "webp", objectKey: `${objectKey}-lg`, width: 1600 }]
  };
}

const PLAIN = asset("plain");
const CROPPED = asset("cropped", { x: 0.1, y: 0.2, width: 0.5, height: 0.4 });
const ALT = asset("alt", { x: 0, y: 0.3, width: 1, height: 0.5 });

function framingWith(entries: Partial<Record<ScreenBucketId, Partial<ScreenFraming[ScreenBucketId]>>>): ScreenFraming {
  let framing = emptyScreenFraming();
  for (const [id, patch] of Object.entries(entries)) {
    framing = setBucket(framing, id as ScreenBucketId, { ...framing[id as ScreenBucketId], ...patch });
  }
  return framing;
}

/** Which band a browser at `width` CSS pixels would use — the last band whose bound it clears. */
function bandAt(picture: Picture, width: number) {
  let winner = picture[0];
  for (const band of picture) {
    const bucket = SCREEN_BUCKETS.find((entry) => entry.id === band.bucket);
    if (bucket && width >= bucket.min) winner = band;
  }
  return winner;
}

// ── 1. Nothing set must behave exactly as it did before any of this existed ──
{
  const uncropped = resolvePicture(PLAIN, null);
  check(uncropped !== null, "an asset resolves", "resolvePicture returned null for a real asset");
  check(uncropped?.length === 1, "no framing => one band", `got ${uncropped?.length} bands`);
  check(uncropped?.[0].crop === null, "no crop => null crop", "an uncropped asset produced a rectangle");
  check(uncropped?.[0].bucket === "base", "first band is base", `got ${uncropped?.[0].bucket}`);

  const cropped = resolvePicture(CROPPED, null);
  check(cropped?.length === 1, "asset crop alone => one band", `got ${cropped?.length} bands`);
  check(
    same(cropped?.[0].crop, storedCrop(CROPPED)),
    "asset crop is the base rectangle",
    "the resolved crop differs from the asset's own stored crop"
  );
  check(cropped?.[0].cropFrom === null, "asset crop has no source bucket", `got ${cropped?.[0].cropFrom}`);

  // The property thousands of production crops depend on: an empty framing changes nothing.
  const empty = resolvePicture(CROPPED, emptyScreenFraming());
  check(same(empty, cropped), "an empty framing is indistinguishable from none", "an empty framing changed the result");
  check(isEmptyScreenFraming(emptyScreenFraming()), "a fresh framing reads as empty", "isEmptyScreenFraming said otherwise");
  check(resolvePicture(null, emptyScreenFraming()) === null, "no asset => null", "resolvePicture invented a picture");
}

// ── 2. Collapsing compares against the band BELOW, not against base ─────────
{
  const identical = resolvePicture(PLAIN, framingWith({ md: { cropX: null } }));
  check(identical?.length === 1, "a bucket that sets nothing collapses", `got ${identical?.length} bands`);

  const twoBands = resolvePicture(
    PLAIN,
    framingWith({ lg: { cropX: 0.25, cropY: 0, cropWidth: 0.5, cropHeight: 1 } })
  );
  check(twoBands?.length === 2, "one override => two bands", `got ${twoBands?.length} bands`);
  check(bandAt(twoBands!, 500).crop === null, "below the override, no crop", "the override leaked downward");
  check(bandAt(twoBands!, 1400).crop?.width === 0.5, "at and above the override, it applies", "the override did not apply");
  check(bandAt(twoBands!, 1024).crop?.width === 0.5, "the override starts at its own lower bound", "off by one at 1024px");
  check(bandAt(twoBands!, 1023).crop === null, "and not one pixel below it", "the override started early");

  /**
   * THE CASE THAT MAKES THE COLLAPSE RULE LOAD-BEARING. base=A, sm=B, md=A. Dropping `md` because it
   * matches `base` would leave `sm`'s rule as the last one a 800px browser matches, so B would win where
   * A was asked for. Comparing against the previously EMITTED band is what prevents that.
   */
  const zigzag = resolvePicture(
    PLAIN,
    framingWith({ sm: { mediaId: "alt" }, md: { mediaId: "plain" } }),
    (id) => (id === "alt" ? ALT : id === "plain" ? PLAIN : null)
  );
  check(zigzag?.length === 3, "A, B, A emits three bands", `got ${zigzag?.length} bands`);
  check(bandAt(zigzag!, 700).media.objectKey === "alt", "B wins inside its own range", `got ${bandAt(zigzag!, 700).media.objectKey}`);
  check(bandAt(zigzag!, 800).media.objectKey === "plain", "A wins again above it", `got ${bandAt(zigzag!, 800).media.objectKey}`);
}

// ── 3. A different photograph drops the inherited rectangle ──────────────────
{
  const picture = resolvePicture(
    CROPPED,
    framingWith({ lg: { mediaId: "alt" } }),
    (id) => (id === "alt" ? ALT : null)
  );
  const wide = bandAt(picture!, 1440);
  check(wide.media.objectKey === "alt", "the alternate photograph is used", `got ${wide.media.objectKey}`);
  check(
    same(wide.crop, storedCrop(ALT)),
    "it starts from ITS OWN stored crop",
    "the rectangle from the previous photograph was carried onto a different one"
  );
  check(wide.mediaFrom === "lg", "mediaFrom names the bucket that set it", `got ${wide.mediaFrom}`);

  // A bucket may name a photograph AND crop it in the same breath.
  const both = resolvePicture(
    CROPPED,
    framingWith({ lg: { mediaId: "alt", cropX: 0.5, cropY: 0.5, cropWidth: 0.4, cropHeight: 0.4 } }),
    (id) => (id === "alt" ? ALT : null)
  );
  const cropped = bandAt(both!, 1440);
  check(cropped.media.objectKey === "alt" && cropped.crop?.x === 0.5, "a bucket may set both at once", "one of the two was lost");
  check(cropped.cropFrom === "lg", "cropFrom names the bucket", `got ${cropped.cropFrom}`);
}

// ── 4. Bad data degrades to inherit, never to a broken frame ─────────────────
{
  const outOfRange = resolvePicture(PLAIN, framingWith({ md: { cropX: 0.9, cropY: 0, cropWidth: 0.5, cropHeight: 1 } }));
  check(outOfRange?.length === 1, "x+w past 1 is not a crop", `got ${outOfRange?.length} bands`);

  const partial = resolvePicture(PLAIN, framingWith({ md: { cropX: 0.1, cropY: 0.1, cropWidth: 0.5 } }));
  check(partial?.length === 1, "three of four numbers is not a crop", `got ${partial?.length} bands`);

  const zero = resolvePicture(PLAIN, framingWith({ md: { cropX: 0, cropY: 0, cropWidth: 0, cropHeight: 0 } }));
  check(zero?.length === 1, "a zero-size rectangle is not a crop", `got ${zero?.length} bands`);

  // An alternate photograph whose row has not been fetched must inherit, not blank the picture.
  const unresolved = resolvePicture(CROPPED, framingWith({ lg: { mediaId: "missing" } }));
  check(unresolved?.length === 1, "an unresolvable photograph inherits", `got ${unresolved?.length} bands`);
  check(
    unresolved?.[0].media.objectKey === "cropped",
    "and keeps the base photograph",
    "a missing join blanked a picture that had a perfectly good base"
  );

  // "Deliberately the whole picture at this width" is 0/0/1/1, and must survive as a real answer.
  const wholeOnDesktop = resolvePicture(CROPPED, framingWith({ lg: { cropX: 0, cropY: 0, cropWidth: 1, cropHeight: 1 } }));
  check(wholeOnDesktop?.length === 2, "the whole picture is a choice, not an absence", `got ${wholeOnDesktop?.length} bands`);
  check(same(bandAt(wholeOnDesktop!, 1440).crop, FULL_CROP), "and resolves to the full rectangle", "it was treated as inherit");
}

// ── 5. The geometry the renderer emits ──────────────────────────────────────
{
  const none = cropVarsFor({ bucket: "base", minRem: null, media: PLAIN, crop: null, mediaFrom: "base", cropFrom: null });
  check(none["--cxa-crop-w"] === "100%" && none["--cxa-crop-x"] === "0%", "no crop is a full-frame box", JSON.stringify(none));

  const full = cropFrameStyle(FULL_CROP);
  check(
    full.width === "100%" && full.height === "100%" && full.left === "0%" && full.top === "0%",
    "FULL_CROP is exactly today's rendering",
    JSON.stringify(full)
  );

  const vars = cropVarsFor({
    bucket: "base",
    minRem: null,
    media: CROPPED,
    crop: { x: 0.1, y: 0.05, width: 0.5, height: 0.4 },
    mediaFrom: "base",
    cropFrom: null
  });
  const box = cropFrameStyle({ x: 0.1, y: 0.05, width: 0.5, height: 0.4 });
  check(
    vars["--cxa-crop-w"] === box.width &&
      vars["--cxa-crop-h"] === box.height &&
      vars["--cxa-crop-x"] === box.left &&
      vars["--cxa-crop-y"] === box.top,
    "the variables and the inline box agree",
    `vars ${JSON.stringify(vars)} vs box ${JSON.stringify(box)}`
  );

  // The hover-zoom fix: the origin is the crop's own centre, expressed in the full image's coordinates.
  const origin = cropImageStyle({ x: 0.1, y: 0.05, width: 0.5, height: 0.4 });
  check(origin.transformOrigin === "35% 25%", "transform-origin is the frame's centre", String(origin.transformOrigin));
  check(cropImageStyle(FULL_CROP).transformOrigin === "50% 50%", "and the plain centre when uncropped", "origin drifted");
}

// ── 6. The bucket table and the framing's shape ─────────────────────────────
{
  check(SCREEN_BUCKETS.length === 6, "five breakpoints make six ranges", `got ${SCREEN_BUCKETS.length}`);
  check(SCREEN_BUCKETS[0]?.minRem === null, "the first bucket needs no media query", "base carries a min-width");
  check(
    SCREEN_BUCKETS.every((bucket, index) => index === 0 || bucket.min > (SCREEN_BUCKETS[index - 1]?.min ?? -1)),
    "the buckets ascend",
    "SCREEN_BUCKETS is out of order"
  );
  check(
    SCREEN_BUCKETS.every((bucket, index) => index === SCREEN_BUCKETS.length - 1 || bucket.max === (SCREEN_BUCKETS[index + 1]?.min ?? 0) - 1),
    "the ranges meet with no gap and no overlap",
    "a bucket's max does not abut the next bucket's min"
  );
  check(
    SCREEN_BUCKETS.every((bucket) => bucket.minRem === null || /^[\d.]+rem$/.test(bucket.minRem)),
    "the queries are in rem, as Tailwind's screens are",
    "a bucket's minRem is not a rem value"
  );
  check(screenBucketLabel("md").includes("768"), "a label names its range", screenBucketLabel("md"));

  // Key ORDER is what keeps autosave from seeing a clean form as dirty.
  const order = Object.keys(emptyScreenFraming());
  check(same(order, SCREEN_BUCKETS.map((b) => b.id)), "keys are in bucket order", order.join(","));
  const afterSet = Object.keys(setBucket(emptyScreenFraming(), "2xl", { ...emptyScreenFraming()["2xl"], mediaId: "x" }));
  check(same(afterSet, order), "setBucket preserves key order", afterSet.join(","));
  check(
    JSON.stringify(setBucket(emptyScreenFraming(), "md", emptyScreenFraming().md)) ===
      JSON.stringify(emptyScreenFraming()),
    "setting a bucket to its own empty value serialises identically",
    "merely touching a bucket would mark the form dirty"
  );

  check(
    same(screenFramingMediaIds(framingWith({ sm: { mediaId: "a" }, lg: { mediaId: "a" }, xl: { mediaId: "b" } })), ["a", "b"]),
    "the alternate photographs are listed once each",
    JSON.stringify(screenFramingMediaIds(framingWith({ sm: { mediaId: "a" }, lg: { mediaId: "a" }, xl: { mediaId: "b" } })))
  );
  check(same(screenFramingMediaIds(null), []), "no framing names no photographs", "screenFramingMediaIds invented ids");
}

// ── Report ─────────────────────────────────────────────────────────────────
let failed = false;

if (failures.length > 0) {
  console.error(`\nFAIL — ${failures.length} of ${checks} assertion(s):\n`);
  for (const failure of failures) {
    console.error(`  ${failure.what}`);
    console.error(`    ${failure.detail}\n`);
  }
  failed = true;
}

// A run that asserted almost nothing is not a pass, whatever it printed.
if (checks < 40) {
  console.error(`\nFAIL — only ${checks} assertions ran. Something is wrong with this script, not the resolver.`);
  failed = true;
}

console.log(`screens-check — ${checks} assertions over ${SCREEN_BUCKETS.length} screen buckets`);

if (failed) process.exit(1);

console.log("PASS — the resolver cascades, collapses and degrades as specified.");
