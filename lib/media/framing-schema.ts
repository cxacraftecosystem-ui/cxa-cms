import { z } from "zod";

import { SCREEN_BUCKET_IDS } from "./screens";

/**
 * The ONE Zod schema for a per-screen framing, wherever one is validated.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY IT IS ITS OWN MODULE. Two places validate a framing and they cannot share either of their homes:
 *
 *   • `lib/sections/schema.ts` validates the nine SECTION payload keys, and is imported by studio CLIENT
 *     components — so it must stay free of anything `server-only`.
 *   • `lib/studio/crud.ts` validates the twelve RECORD columns, and opens with `import "server-only"`
 *     because it pulls in the whole studio write path.
 *
 * The first cannot import the second. Writing the schema out twice was the first attempt and it was
 * wrong: two Zod objects describing one stored shape, kept in step by a check script noticing they had
 * drifted. One module both can import removes the drift instead of policing it.
 *
 * ⚠ IT DELIBERATELY DOES NOT LIVE IN `screens.ts`. That module is imported by every public section
 * renderer, and putting `zod` in it would pull the whole validator into the client bundle of every page
 * that draws a photograph — for code that only ever runs on a form submission.
 *
 * ⚠ THE SIX KEYS ARE LITERALS, NOT GENERATED FROM `SCREEN_BUCKET_IDS`. `z.object` needs a literal shape to
 * infer six KNOWN keys; building it with `Object.fromEntries` plus a cast yields an index signature, and an
 * index signature lets a typo in a bucket name compile. `bucketKeysAgree()` below is what keeps the
 * literals honest — it compares this schema's own keys against `SCREEN_BUCKET_IDS` — and
 * `scripts/screens-check.ts` asserts it.
 *
 * The numeric bounds match `isUsableCrop` in lib/media/crop.ts. That is not redundant: this layer can
 * answer an editor with a sentence, and the render-side test is what makes a hand-edited row degrade to
 * "no crop" instead of drawing a broken frame.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const screenOverride = z.object({
  mediaId: z.string().trim().max(40, "That does not look like a media reference.").nullable().default(null),
  cropX: z.number().min(0).max(1).nullable().default(null),
  cropY: z.number().min(0).max(1).nullable().default(null),
  cropWidth: z.number().min(0).max(1).nullable().default(null),
  cropHeight: z.number().min(0).max(1).nullable().default(null),
  cropAspect: z.string().trim().max(20).nullable().default(null)
});

export const screenFramingSchema = z.object({
  base: screenOverride,
  sm: screenOverride,
  md: screenOverride,
  lg: screenOverride,
  xl: screenOverride,
  "2xl": screenOverride
});

/**
 * A SECTION payload key: `.nullable().default(null)`.
 *
 * Null is the resting state, and defaulting to a full framing would make the next autosave of every block
 * that predates the field write six empty objects into `PageSection.data` for a decision nobody made.
 */
export function screenFramingPayload(help: string) {
  return screenFramingSchema.nullable().default(null).describe(help);
}

/**
 * A RECORD column on a partial update: `.nullable().optional()`.
 *
 * ⚠ TWO DIFFERENT STATEMENTS, BOTH NEEDED. `optional` is "the form did not send this, leave the column
 * alone" — every studio PATCH is partial. `nullable` is "the editor cleared it, write NULL". Collapse them
 * and clearing a framing becomes impossible.
 */
export function screenFramingColumn() {
  return screenFramingSchema.nullable().optional();
}

/** The schema's keys, for the assertion that they are exactly the bucket ids in order. */
export function screenFramingSchemaKeys(): string[] {
  return Object.keys(screenFramingSchema.shape);
}

/** True when the literal keys above match `SCREEN_BUCKETS`. Asserted by scripts/screens-check.ts. */
export function bucketKeysAgree(): boolean {
  return screenFramingSchemaKeys().join(",") === [...SCREEN_BUCKET_IDS].join(",");
}
