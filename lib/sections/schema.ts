import { z } from "zod";
import type { SectionType } from "@prisma/client";

import { blockTypesetSchema } from "@/lib/typography/typeset";

/**
 * The typed contract for every renderable page block.
 *
 * `PageSection.data` is a JSON column, so this file is the ONLY thing standing between a builder's
 * drag-and-drop and a renderer reading a property that is not there. Adding a block type is: a value
 * in `SectionType`, a schema here, an entry in `lib/sections/registry.ts`, a renderer, an editor
 * form. No migration — that is the whole point of the hybrid model in `prisma/schema.prisma`.
 *
 * Six rules run through the file, and every one of them is a bug it prevents:
 *
 *  1. **NO `server-only`.** The studio's editor forms validate with these same schemas in the
 *     browser, so this module must be isomorphic. That is also why the Zod-error flattening at the
 *     bottom is repeated here instead of imported from `lib/api.ts`, which is `server-only`. The
 *     SHAPE it produces is deliberately identical to `ApiErrorBody.fieldErrors` so a section
 *     failure renders through the same form-error components as any other API failure.
 *
 *  2. **Every field has a default.** A payload written before a field existed still parses, gaining
 *     the new field's default. Without this, adding a property to a schema would turn every block
 *     already in the database into an editor-only error card — a silent, delayed, site-wide break.
 *
 *  3. **Optional text is `""`, never `undefined`.** Studio forms are controlled React state (§10);
 *     `value={data.eyebrow}` with `undefined` makes React switch the input to uncontrolled and warn.
 *     A single empty-string convention removes an entire class of "why did my cursor jump" bugs.
 *
 *  4. **Almost nothing is conditionally required.** Studio forms autosave every few seconds, so a
 *     rule that fires halfway through an edit ("you picked Manual but have not picked anything yet")
 *     refuses the save while the editor is still working. Where a value is genuinely missing, the
 *     RENDERER states it — §6: a block that quietly renders nothing is indistinguishable from a
 *     block that was never filled in. The exceptions are all of ONE KIND rather than a list to
 *     memorise: every conditionally required field in this file is an `<iframe>`'s accessible name —
 *     the EMBED, FORM_EMBED and DOCUMENT_EMBED titles — and each is an accessibility requirement
 *     rather than an editorial preference, because a screen reader announces an untitled `<iframe>`
 *     as "frame" and gives its reader nothing else to go on. Each binds only once there is something
 *     to label: a URL for the first two, a chosen document for the third (§10 — a field may only be
 *     mandatory where it is answerable). FORM_EMBED carries one further rule — a host allow-list —
 *     which is a SECURITY requirement; see its header.
 *
 *  5. **Every on-screen string carries a `.max()` and a `.describe()`.** The max is a length a human
 *     would choose, so a headline cannot silently become a paragraph; the description is the inline
 *     help the studio editor renders beneath the field, so no field is ever a guess.
 *
 *  6. **Payloads are flat and JSON-serialisable.** No dates, no `Map`, no class instances — the
 *     value goes into a Postgres `Json` column and comes back as plain JSON. The one nested value is
 *     the RICH_TEXT document, which is a Tiptap doc by definition.
 *
 * Enum VALUES here are code words (`center`, not `centre`) because they end up beside CSS; the
 * British prose lives in the labels and the help text, which is what a person actually reads.
 *
 * `z.object()` strips unknown keys, so a payload that accumulated junk from an older editor is
 * cleaned every time it is saved rather than growing forever.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Field helpers — the vocabulary every schema below is built from
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single line of on-screen text.
 *
 * Trimmed before the length check, so trailing spaces from a paste never cost a character and never
 * reach the page (a trailing space inside a gold-gradient span renders as a visible gap).
 */
function text(max: number, help: string) {
  return z
    .string()
    .trim()
    .max(max, `Keep this to ${max} characters or fewer.`)
    .default("")
    .describe(help);
}

/**
 * Anything that ends up in an `href`.
 *
 * `z.string().url()` is wrong here: it rejects `/about`, which is the value an administrator types
 * nine times out of ten. So the check is a shape test that accepts a site path, an in-page anchor, an
 * absolute http(s) URL, `mailto:` and `tel:` — and accepts empty, because "no link yet" is a normal
 * state, not a mistake.
 */
const LINK_SHAPE = /^(?:\/\S*|#\S*|https?:\/\/\S+|mailto:\S+|tel:\S+)$/;

function link(help: string) {
  return z
    .string()
    .trim()
    .max(500, "That link is too long to be right. Check it and paste it again.")
    .refine((value) => value === "" || LINK_SHAPE.test(value), {
      message:
        "Enter a link that starts with / for a page on this site, or with https:// for another site."
    })
    .default("")
    .describe(help);
}

/**
 * A reference to a `MediaAsset` row by id.
 *
 * Stored as an id, never a URL: a URL baked into a payload keeps pointing at bytes after the asset is
 * replaced, re-cropped or moved between buckets. The renderer resolves it through `lib/media/url.ts`,
 * which is also where "the variant does not exist" is handled — never assume one does (§14).
 */
function mediaId(help: string) {
  return z
    .string()
    .trim()
    .max(40, "That does not look like a media reference.")
    .default("")
    .describe(help);
}

/**
 * Per-screen framing for one picture: which part of it, and optionally which photograph, at each width.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ `.nullable().default(null)`, NOT `.default(emptyScreenFraming)`, AND THE DIFFERENCE IS STORED BYTES.
 * Every HERO row in the database was saved before this field existed. Defaulting to a full framing would
 * mean the next autosave of every one of them wrote six empty objects into `PageSection.data` — payload
 * for a decision nobody has made. `null` is the honest representation of "nobody has framed this", it is
 * what `resolvePicture` already treats as "use the asset's own crop", and the panel builds the six
 * buckets the first time an editor actually sets one.
 *
 * ⚠ THE SIX KEYS ARE WRITTEN OUT RATHER THAN GENERATED FROM `SCREEN_BUCKETS`. `z.object` needs a literal
 * shape to infer a useful type from, and building it with `Object.fromEntries` plus a cast would give
 * `SectionPayloads["HERO"]` an index signature instead of six known keys — so a typo in a bucket name
 * would compile. `screens-check` asserts these are exactly `SCREEN_BUCKET_IDS`, which is what keeps the
 * two in step; adding a bucket is then a failing assertion rather than a field that silently never saves.
 *
 * The bounds are the same ones `isUsableCrop` enforces at render (lib/media/crop.ts). Stating them here
 * as well is not duplication for its own sake: this is where an editor can be TOLD, and the render side's
 * test is what stops a hand-edited row drawing a broken frame. A rectangle outside these bounds degrades
 * to "no crop for this bucket", never to an empty picture.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const screenOverrideSchema = z.object({
  mediaId: z.string().trim().max(40, "That does not look like a media reference.").nullable().default(null),
  cropX: z.number().min(0).max(1).nullable().default(null),
  cropY: z.number().min(0).max(1).nullable().default(null),
  cropWidth: z.number().min(0).max(1).nullable().default(null),
  cropHeight: z.number().min(0).max(1).nullable().default(null),
  cropAspect: z.string().trim().max(20).nullable().default(null)
});

export const screenFramingSchema = z.object({
  base: screenOverrideSchema,
  sm: screenOverrideSchema,
  md: screenOverrideSchema,
  lg: screenOverrideSchema,
  xl: screenOverrideSchema,
  "2xl": screenOverrideSchema
});

function screenFraming(help: string) {
  return screenFramingSchema.nullable().default(null).describe(help);
}

/** A hand-picked list of record ids. The cap is stated in the message, because a silent cap is a lie. */
function idList(max: number, help: string) {
  return z
    .array(z.string().trim().min(1, "An empty id cannot be saved.").max(40))
    .max(max, `You can choose up to ${max} here. Add a second block if you need more.`)
    .default([])
    .describe(help);
}

/**
 * A calendar date, as the string an `<input type="date">` produces.
 *
 * STORED AS TEXT, NOT PARSED INTO ANYTHING. Rule 6 above: a payload goes into a `Json` column, and a
 * `Date` put in comes back out as a string anyway — one that has silently acquired a time and a zone
 * nobody typed. "2026-09-30" is what the editor means and it is what is kept.
 *
 * The check accepts either a bare `YYYY-MM-DD` or a full ISO instant, because both arrive: the date
 * picker gives the first, and a value pasted out of a spreadsheet or an older payload can be the second.
 *
 * ⚠ `Date.parse` IS NOT THE CHECK, AND MUST NOT BE. It accepts "2026-02-31" and quietly rolls it over to
 * 3 March — so a closing date typed one digit wrong would validate, save, and then be displayed as a
 * different day from the one in the studio, with nothing anywhere saying so. The day is therefore counted
 * against the real length of that month, leap years included, before the string is accepted at all.
 *
 * Empty is allowed and normal: "no deadline" is a state, not a mistake.
 */
const ISO_DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** Does `YYYY-MM-DD…` name a day that exists? See the rollover warning above. */
function namesARealDay(value: string): boolean {
  const match = ISO_DATE_SHAPE.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return false;
  if (month < 1 || month > 12 || day < 1) return false;

  // Day 0 of the FOLLOWING month is the last day of this one — the shortest way to ask "how long is
  // February in 2028". In UTC, so no local timezone can shift the answer by a day.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= lastDay;
}

function isoDate(help: string) {
  return z
    .string()
    .trim()
    .max(40, "That does not look like a date.")
    .refine((value) => value === "" || namesARealDay(value), {
      message:
        "Enter a real date as year-month-day, such as 2026-09-30. Check the day exists in that month."
    })
    .default("")
    .describe(help);
}

/**
 * A whole number typed into a number field.
 *
 * `z.coerce` because `<input type="number">` hands React a STRING. Refusing `"6"` would fail the save
 * with a message the editor cannot act on — the box plainly contains a six.
 */
function count(options: { min: number; max: number; fallback: number; help: string }) {
  return z.coerce
    .number()
    .int("Enter a whole number.")
    .min(options.min, `Enter ${options.min} or more.`)
    .max(options.max, `Enter ${options.max} or fewer.`)
    .default(options.fallback)
    .describe(options.help);
}

function flag(fallback: boolean, help: string) {
  return z.boolean().default(fallback).describe(help);
}

/**
 * A button.
 *
 * Both halves default to empty and NEITHER is required, because "typed the label, has not pasted the
 * link yet" is two seconds of every button's life and autosave runs during it. The renderer draws the
 * button only when both are present — a labelled button with no link is a dead control, and a linked
 * button with no label is invisible.
 */
function cta(what: string) {
  return z
    .object({
      label: text(40, `The words on the ${what} button. Leave it empty to hide the button.`),
      href: link(`Where the ${what} button goes.`)
    })
    .default({})
    .describe(`The ${what} button. It appears once it has both words and a link.`);
}

/**
 * A lucide icon name.
 *
 * Validated as a SHAPE, not against the icon set. Importing lucide's full export map here to check the
 * name would pull every icon into any bundle that imports this file; the studio's icon picker lists the
 * real exports and is the guard that matters. The renderers resolve a name through `featureIcon()` in
 * components/sections/FeatureGridSection.tsx, which falls back to a neutral glyph rather than throwing —
 * payloads outlive the code that wrote them, and lucide has renamed whole families of icons before.
 */
function iconName(help: string) {
  return z
    .string()
    .trim()
    .max(40, "That is not an icon name.")
    .regex(
      /^[A-Z][A-Za-z0-9]*$/,
      "Pick an icon from the list rather than typing one — icon names look like ArrowRight."
    )
    .or(z.literal(""))
    .default("")
    .describe(help);
}

/** Text alignment, as the CSS words. The studio's picker shows "Left / Centred / Right". */
const alignment = (fallback: "left" | "center" | "right", help: string) =>
  z.enum(["left", "center", "right"]).default(fallback).describe(help);

// Filter vocabularies mirrored from `prisma/schema.prisma`.
//
// Hardcoded rather than `z.nativeEnum(PersonKind)` because `nativeEnum` needs a VALUE import from
// `@prisma/client`, and this module is imported by studio client components — that import would drag
// the Prisma client into the browser bundle. Adding a kind to the schema means adding it here too;
// the empty string is "no filter", so the payload stays flat and a cleared picker is expressible.
//
// ⚠ THE MIRRORING IS NOT CHECKED BY ANYTHING. There is no `satisfies` to hang these off, because the
// empty string is not a member of either Prisma enum — so a value added to the schema and forgotten
// here compiles, and the symptom is a saved block whose filter Zod strips on the next read. Three
// files move together: this one, the option lists in components/studio/sections/ (ShowcaseForm.tsx
// for people, SimpleForms.tsx for publications) and the filter unions in ./resolve.ts.
const PERSON_KINDS = [
  "",
  "FACULTY",
  "SCIENTIST",
  "RESEARCHER",
  "STUDENT",
  "STAFF",
  "VISITOR",
  "ALUMNUS",
  "DC_HANDICRAFTS"
] as const;

const PROJECT_STATES = ["", "PROPOSED", "ACTIVE", "COMPLETED", "ON_HOLD"] as const;

const PUBLICATION_KINDS = [
  "",
  "JOURNAL_ARTICLE",
  "CONFERENCE_PAPER",
  "BOOK",
  "BOOK_CHAPTER",
  "PATENT",
  "DATASET",
  "SOFTWARE",
  "PREPRINT",
  "THESIS",
  "REPORT",
  "FLYER",
  "BOOKLET"
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// The curation shape — defined ONCE and reused by every block that pulls records
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "Which records, and how many" — the most repeated shape on the site.
 *
 * Three modes, one flat object rather than a discriminated union on `mode`. A union would drop `ids`
 * the moment an editor flicked to Latest to see what it looked like, and their hand-picked order
 * would be gone when they flicked back. Keeping every mode's fields resident costs a few unused bytes
 * in the payload and saves the one mistake that cannot be undone from the editor.
 *
 * Manual mode with an empty list is ALLOWED for the autosave reason in rule 4 above; the renderer
 * shows the studio "nothing has been chosen yet" rather than refusing the save.
 */
function showcase(options: {
  /** Plural noun as an administrator says it — "projects", "people". Goes straight into the help text. */
  plural: string;
  /** What "Latest" orders by for this record type. Editors guess wrong when this is not spelled out. */
  latestMeaning: string;
  fallbackLimit: number;
  maxLimit: number;
}) {
  const { plural, latestMeaning, fallbackLimit, maxLimit } = options;
  return z.object({
    eyebrow: text(60, `The small line above the heading. Often a category, such as “Our work”.`),
    heading: text(120, `The heading for this block of ${plural}.`),
    body: text(320, `One or two sentences under the heading. Leave it empty for just a heading.`),
    mode: z
      .enum(["latest", "featured", "manual"])
      .default("latest")
      .describe(
        `How the ${plural} are chosen. Latest keeps itself up to date (${latestMeaning}). Featured shows only the ones flagged as featured. Chosen by hand shows exactly the ${plural} you pick, in the order you pick them.`
      ),
    limit: count({
      min: 1,
      max: maxLimit,
      fallback: fallbackLimit,
      help: `At most how many ${plural} to show. Where there are more, the block says how many, so a shortened list never reads as the whole list.`
    }),
    ids: idList(
      24,
      `The ${plural} to show, in order. Used only when the mode above is “Chosen by hand”.`
    ),
    ctaLabel: text(40, `The words on the link below the block, such as “See all ${plural}”.`),
    ctaHref: link(`Where that link goes — usually the full ${plural} page.`)
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The block payloads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The cinematic page opener.
 *
 * `headlineAccent` is a SEPARATE field rather than markup inside `headline` because the gold gradient
 * is the one place gold is allowed (§1.1) and it must not be something an editor can paste arbitrary
 * HTML into. The renderer draws it immediately after the headline, in `.text-gold-gradient`.
 *
 * `backgroundKind` and `backgroundMediaId` are not cross-validated: choosing "Image" and then picking
 * the image is two steps, and autosave happens between them. With no image the renderer falls back to
 * the gradient, which is a hero, not a hole.
 */
export const heroSectionSchema = z.object({
  eyebrow: text(60, `The small line above the headline, such as "Centre of Excellence".`),
  headline: text(120, "The main line. Short and specific reads better than clever."),
  headlineAccent: text(
    60,
    "The part of the headline shown in the gold gradient. It is drawn straight after the headline, so write it as the continuation of that sentence."
  ),
  body: text(320, "A sentence or two under the headline. Say what this place does."),
  primaryCta: cta("main"),
  secondaryCta: cta("second"),
  backgroundMediaId: mediaId(
    "The image or video behind the hero. Only used when the background below is set to Image or Video."
  ),
  /**
   * ⚠ THE HERO IS WHERE ONE CROP HURTS MOST, WHICH IS WHY THIS LANDS HERE FIRST. The picture is drawn
   * full-bleed with `aspect="none"`, so the frame runs from roughly 0.5:1 on a phone to 2.5:1 on a wide
   * desktop — the same photograph in two frames that share almost nothing. A single rectangle cannot be
   * right for both, so the editor was being asked one question that had six different answers.
   */
  backgroundMediaScreens: screenFraming(
    "Optional. Frame the hero picture differently at each screen size, or use a different photograph on narrow screens. Anything left alone inherits from the next smaller size, and the smallest falls back to the picture's own crop."
  ),
  backgroundKind: z
    .enum(["particles", "gradient", "image", "video"])
    .default("gradient")
    .describe(
      "What sits behind the words. Particles and Gradient need no media and stay crisp on every screen; Image and Video need a file chosen above, and fall back to the gradient without one."
    ),
  alignment: alignment("center", "Where the words sit in the hero."),
  showScrollCue: flag(
    true,
    "Shows the small cue at the foot of the hero that tells a reader there is more below. Turn it off on a short page where there is not."
  ),
  /**
   * ⚠ OFF BY DEFAULT, AND `.default()` IS WHAT MAKES ADDING THIS FIELD SAFE. Every HERO row in the
   * database was saved before it existed; each parses with the flag false and renders exactly as it
   * always has. The story itself is a site-wide experience (components/site/story/), not content —
   * this flag only decides which hero carries the invitation to it, and the homepage is the one that
   * should.
   */
  showStory: flag(
    false,
    "Shows the gold invitation to the Centre's cinematic story under the buttons — a timed, skippable, full-screen telling of why the Centre exists. One hero on the site should carry it, normally the homepage's."
  )
});

/**
 * A Tiptap document.
 *
 * Only the envelope is validated. The node tree is the renderer's business: `components/RichText.tsx`
 * whitelists the node and mark types it draws and never uses `dangerouslySetInnerHTML`, so a schema
 * that tried to enumerate every node here would be a second, weaker copy of that whitelist —
 * guaranteed to drift, and trusted more than it deserves.
 *
 * ⚠ THIS IS WHY THE EDITOR'S VOCABULARY CAN GROW WITHOUT A MIGRATION, AND WHY IT MUST STAY THIS SHAPE.
 *
 * The studio can now write a dozen node types and three marks that did not exist when most of the
 * documents in the database were saved — pull quotes, drop caps, lead paragraphs, side notes,
 * definition lists, multi-column passages, captioned figures, attribution lines, small caps, letter
 * spacing and the brand text colours. Not one of them needed a change here, and that is the design
 * working rather than an oversight:
 *
 *  - `content` is `z.array(z.unknown())`, so a node type this file has never heard of parses. A union
 *    of known node shapes would have to be extended in lockstep with the editor, and the day somebody
 *    forgot, every page holding the new block would fail validation on save — turning a formatting
 *    feature into data loss.
 *  - `.passthrough()` keeps any envelope key Tiptap adds later, rather than stripping it. This is the
 *    ONE schema in this file that deliberately does not clean unknown keys (rule 6 above), because the
 *    thing being carried is a foreign document format, not our own payload.
 *  - Nothing here is required beyond `type: "doc"`, so a document saved before today — including one
 *    holding nothing but `[{ type: "paragraph" }]` — parses unchanged and renders exactly as it did.
 *
 * The safety that a stricter schema would appear to give is provided where it actually belongs:
 * `parseRichText()` in lib/richtext.ts coerces every node and attribute on the way out, `RichText.tsx`
 * renders only elements it chose and drops any `javascript:` href, and `describeSchemaDrift()` warns in
 * development when the editor can produce something the renderer cannot draw. Tightening this object
 * would add no protection and would break old rows.
 */
const richTextDocumentSchema = z
  .object({
    type: z.literal("doc"),
    content: z.array(z.unknown()).default([])
  })
  .passthrough();

export const richTextSectionSchema = z.object({
  eyebrow: text(60, "The small line above the heading. Optional."),
  heading: text(120, "The heading for this passage. Leave it empty to run straight into the text."),
  body: richTextDocumentSchema
    .default({ type: "doc", content: [] })
    .describe("The text itself, with its formatting."),
  width: z
    .enum(["narrow", "wide"])
    .default("narrow")
    .describe(
      "Narrow holds the text to a comfortable reading width of about 68 characters. Wide fills the column and suits tables and wide images."
    ),
  alignment: alignment(
    "left",
    "Where the text sits. Long passages read best left-aligned. Only the plain “text alone, sitting left” arrangement reads this — the other arrangements place the text themselves."
  ),
  /*
   * ⚠ `.default("left")` IS WHAT MAKES ADDING THESE THREE FIELDS SAFE, AND IT IS WHY THEY NEED NO
   * MIGRATION. Every RICH_TEXT row in the database was saved before an arrangement existed; each
   * parses as "left" and renders through exactly the JSX path it always has —
   * `components/sections/RichTextSection.tsx` keeps that path intact, `alignment` above included.
   *
   * `mediaId`/`craftImage` follow the two-source rule documented at `craftImageSlug` below, and are
   * deliberately NOT cross-validated against the arrangement (rule 4 above: autosave runs between
   * "picked the arrangement" and "picked the picture"). The three text-alone arrangements simply
   * ignore both fields, and the form says so on screen rather than leaving a control that quietly
   * does nothing.
   */
  layout: z
    .enum([
      "left",
      "right",
      "center",
      "text-left-media-right",
      "text-right-media-left",
      "center-media-between"
    ])
    .default("left")
    .describe(
      "How this passage is arranged on the page. Three are text alone: sitting left (the usual arrangement), pushed to the right-hand side, and centred. Two set the words beside a picture: text on the left with the picture on the right, or text on the right with the picture on the left — on a phone the picture sits above the words either way. The last centres the passage and puts the picture between the heading and the text. The text-alone arrangements ignore any picture chosen below."
    ),
  mediaId: mediaId(
    "A picture you have uploaded, shown by the arrangements that include one. Preferred over the one below."
  ),
  /*
   * ⚠ IT FRAMES THE UPLOADED PICTURE ONLY, WHICH IS WHY IT SITS BESIDE `mediaId` AND NOT BESIDE THE PAIR.
   * `craftImage` below is a slug into the compiled-in manifest with no `MediaAsset` row behind it, so
   * there is nothing to store a rectangle against and `StoryPicture`'s craft branch never sees this.
   * Like the arrangement's own comment above, it is deliberately not cross-validated against `layout`:
   * the three text-alone arrangements ignore it exactly as they ignore the two picture fields, and
   * `resolve.ts` only fetches its alternates on the arrangements that draw one. See HERO's
   * `backgroundMediaScreens` for why `null` is the resting state rather than a full framing.
   */
  mediaScreens: screenFraming(
    "Optional. Frame the uploaded picture differently at each screen size, or show a different photograph on narrow screens. Anything left alone inherits from the next smaller size. It has no effect on the arrangements that are text alone, or on one of the site's own craft photographs."
  ),
  craftImage: craftImageSlug(
    "One of the craft photographs that ship with the site. Used only when you have not chosen an uploaded picture above."
  ),
  /*
   * ⚠ `.default({})` IS LOAD-BEARING, AND IT IS WHY THIS FIELD NEEDS NO MIGRATION. Every child field
   * of `blockTypesetSchema` carries its own default of `inherit`, so `{}` parses into the complete
   * all-inherit document — which means every RICH_TEXT payload written before this field existed
   * parses unchanged and renders exactly as it did. Same shape as `cta()` and `homepage.censusOverride`.
   *
   * `inherit` everywhere is also the right RESTING state rather than a placeholder: a block says only
   * what it wants to differ from the house style set in Settings → Typesetting, so changing the house
   * style still reaches every block that never overrode it.
   */
  typeset: blockTypesetSchema
    .default({})
    .describe(
      "How this passage is set — its face, line length, reading size, leading and paragraph habits. Every field starts on the site's house style, which is set in Settings → Typesetting."
    )
});

// ─────────────────────────────────────────────────────────────────────────────
// The census — the figures this site can count for itself
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The things a headline figure can ask the database to COUNT, rather than being typed by hand.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS, AND WHAT IT IS FIXING.
 *
 * The seeded homepage shipped four figures reading 0 — "0 Crafts documented", "0 Field records",
 * "0 Publications", "0 Partner institutions" — under the caption "Figures update as records are
 * published". The database held 42 crafts, 30 publications and 13 partners at the time. So the page
 * made four false statements and then promised they were live, which is the worst possible pairing:
 * the caption is what stops a reader questioning the number.
 *
 * The figures were 0 because NOTHING EVER COUNTED ANYTHING. `value` is a hand-typed string, the seed
 * typed "0", and a string in a JSON column does not update itself however confidently the caption
 * says it will. There was no bug to fix in the counting code because there was no counting code —
 * only `/api/public/stats`, which counts correctly and which no page has ever called.
 *
 * So a figure may now NAME what it counts. `metric` is resolved against the database at render time
 * by lib/sections/resolve.ts, inside the same batched, snapshot-consistent transaction as every other
 * block on the page, and inherits the page's own `revalidate` window (300s on the homepage) rather
 * than inventing a second cache policy.
 *
 * ⚠ THE PRECEDENCE IS: TYPED VALUE, THEN COUNT, THEN NOTHING — AND NEVER ZERO.
 *
 *   1. a non-empty `value` WINS, always. An editor who has typed a figure has made a claim, possibly
 *      one the database cannot express ("3 of 5", "over 1,200 hours"), and a count that silently
 *      overwrote it would be the page contradicting the person responsible for it.
 *   2. otherwise the counted figure is used;
 *   3. and if there is no count — the database was unreachable, the metric is one this release does
 *      not know, or the count is genuinely zero — THE WHOLE ITEM IS DROPPED FROM THE ROW.
 *
 * Step 3 is the point of the whole exercise and it is worth being explicit about. A row of headline
 * figures exists to say "there is this much"; "0" in that position says "there is none of this", which
 * on a research centre's front page reads as a defunct institution rather than as an empty table. And
 * an unreachable database must never be able to turn a true figure into a false one. **A statistic
 * that is wrong is worse than a statistic that is absent**, so the absent one is what we render.
 * `StatsSection` drops the item; if every item drops, the block renders nothing at all.
 *
 * WHY A LIST OF NAMED METRICS RATHER THAN A FREE-TEXT QUERY. Every entry below is a predicate that
 * already exists elsewhere on the public site, and the resolver is required to use THAT predicate
 * rather than a new one — otherwise "42 crafts documented" could be counted with a filter the Craft
 * Explorer does not use, and the figure would disagree with the page it links to. The definitions
 * here are what the editor is shown in the studio, in words, so that a label like "Field records"
 * cannot quietly be attached to a count of something else.
 *
 * ⚠ ADDING A METRIC IS TWO EDITS, NOT ONE: a value here, and a `case` in `censusCount()` in
 * lib/sections/resolve.ts. The second edit is a COMPILE ERROR rather than a figure that is silently
 * always missing, and the thing that makes it one is `exhaustiveCensus(metric: never)` on that
 * switch's `default` branch — a new member of this tuple stops narrowing to `never` there and the build
 * fails. `noFigures()` in the same file is built by reducing over this tuple for the same reason, so a
 * metric cannot be absent from a census by omission either.
 *
 * ⚠ `SiteCensus.figures` IS `Record<CensusMetric, number | null>`, AND THE `| null` IS THE MECHANISM,
 * not a convenience. `null` means NOT COUNTED — no block on the page named this metric, the census is
 * suspended, or the read failed — and it is deliberately a different state from "counted, and the
 * answer was nought". A single `number` would have to use 0 for both, which is precisely the falsehood
 * this whole file exists to remove.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const CENSUS_METRICS = [
  "crafts",
  "people",
  "projects",
  "research",
  "publications",
  "events",
  "albums",
  "galleryItems",
  "partners"
] as const;

/** One countable figure. `""` is the resting state: a figure typed by hand, counting nothing. */
export type CensusMetric = (typeof CENSUS_METRICS)[number];

/**
 * What each metric MEANS, for the studio's picker and for anyone reading a label beside a figure.
 *
 * A `Record` keyed by the union rather than a list of objects, so adding a metric above without
 * describing it here is a compile error. The definitions are deliberately narrow — "items catalogued
 * in published gallery albums" and not "records" — because a vague definition is what lets a caption
 * claim more than the number supports.
 *
 * ITS CONSUMER IS `components/studio/sections/StatsForm.tsx`, which builds its "Where the figure comes
 * from" list out of `CENSUS_METRICS` and labels each option from `label` here, then renders the chosen
 * metric's `definition` as that field's own help so the sentence is read out with the control. That is
 * worth naming rather than leaving implied: this record shipped once with nothing importing it and no
 * picker anywhere, so an editor could not reach the census at all — and a feature nothing can reach is
 * indistinguishable from one that was never built.
 */
export const CENSUS_METRIC_DEFINITIONS: Record<CensusMetric, { label: string; definition: string }> = {
  crafts: {
    label: "Crafts",
    definition: "Crafts with a published record in the Craft Explorer."
  },
  people: {
    label: "People",
    definition:
      "People with a published profile who are also shown in the directory. Someone published but hidden from listings is not counted, because the directory does not show them either."
  },
  projects: { label: "Projects", definition: "Published projects, of every state." },
  research: { label: "Research areas", definition: "Published research areas." },
  publications: {
    label: "Publications",
    definition: "Published publication records of every kind, including datasets and patents."
  },
  events: { label: "Events", definition: "Published events, past and future together." },
  albums: { label: "Gallery albums", definition: "Published gallery albums." },
  galleryItems: {
    label: "Gallery records",
    definition:
      "Items catalogued inside published albums — photographs, video, panoramas and tours. An item in a draft album is not counted, because an album is the thing an editor publishes."
  },
  partners: {
    label: "Partner institutions",
    definition: "Partner institutions currently shown on the site."
  }
};

/**
 * The metric field on one figure.
 *
 * `z.enum` over `["", ...CENSUS_METRICS]` rather than a hand-written second list: the tuple above is
 * the single source, so a metric can never exist in the definitions and not in the schema.
 *
 * ⚠ `.catch("")` IS LOAD-BEARING AND IS THE SAFE DIRECTION. A payload naming a metric this release
 * has never heard of — written by a newer deployment, or naming one since removed — parses as "a
 * figure typed by hand" rather than failing the whole block. It therefore falls through to `value`,
 * and to nothing if `value` is empty. The alternative failure mode, a block that becomes an error
 * card because one dropdown moved on, would take a working homepage down for a cosmetic reason.
 */
function censusMetricField(help: string) {
  return z
    .enum(["", ...CENSUS_METRICS])
    .catch("")
    .default("")
    .describe(help);
}

/**
 * Headline figures.
 *
 * `value` is a STRING and always will be. "1,240", "12+", "3 of 5" and "₹4.2 cr" are all real answers
 * an administrator has given, and a numeric column would force every one of them into a lie or into a
 * separate suffix field that the count-up animation would then have to reassemble.
 *
 * It is ALSO, since the census landed above, the OVERRIDE: a figure that names a `metric` and carries
 * no `value` is counted, and one that carries both prints what was typed. See `CENSUS_METRICS` for
 * why that way round and not the other.
 */
export const statsSectionSchema = z.object({
  eyebrow: text(60, "The small line above the heading. Optional."),
  heading: text(120, "The heading above the figures. Optional."),
  items: z
    .array(
      z.object({
        label: text(60, "What the figure counts, such as “Research projects”."),
        value: text(
          16,
          "The figure exactly as it should read, including any comma or plus sign. Leave it empty where “Count from the site” is set, and the site will fill it in."
        ),
        metric: censusMetricField(
          "Count this figure from the site's own records instead of typing it. Anything typed in the figure box wins over the count; where neither is set, the figure is left out of the row rather than shown as nought."
        ),
        suffix: text(12, "A short unit shown after the figure, such as “cr” or “years”."),
        description: text(140, "One line of context beneath the figure. Optional.")
      })
    )
    .max(8, "Eight figures is the most that still reads as a row. Use a second block for more.")
    .default([])
    .describe("The figures, in the order they should appear."),
  countUp: flag(
    true,
    "Counts each figure up when the block scrolls into view. Readers who have asked for reduced motion see the final figure straight away, so nothing is lost."
  ),
  source: text(
    160,
    "Where these figures come from and when, such as “Annual report, March 2026”. Shown in small print under the row."
  )
});

export const featureGridSectionSchema = z.object({
  eyebrow: text(60, "The small line above the heading. Optional."),
  heading: text(120, "The heading above the grid."),
  body: text(320, "A sentence or two under the heading. Optional."),
  columns: z
    .union([z.literal(2), z.literal(3), z.literal(4)])
    .default(3)
    .describe(
      "How many cards sit across the grid on a wide screen. Narrow screens always stack them into one column."
    ),
  items: z
    .array(
      z.object({
        icon: iconName("The icon shown above the title. Optional."),
        title: text(80, "The card's title."),
        body: text(280, "What this card says. Two or three lines reads best."),
        href: link("Where the card goes when clicked. Leave it empty for a card that is not a link.")
      })
    )
    .max(12, "Twelve cards is the most one grid holds. Use a second block below it for more.")
    .default([])
    .describe("The cards, in the order they should appear.")
});

export const researchShowcaseSectionSchema = showcase({
  plural: "research areas",
  latestMeaning: "most recently published first",
  fallbackLimit: 6,
  maxLimit: 24
}).extend({
  layout: z
    .enum(["grid", "graph"])
    .default("grid")
    .describe(
      "Grid shows a card for each area. Graph shows the interactive map of how the areas connect, which is heavier and suits a page built around it."
    )
});

export const projectShowcaseSectionSchema = showcase({
  plural: "projects",
  latestMeaning: "most recently started first",
  fallbackLimit: 6,
  maxLimit: 24
}).extend({
  state: z
    .enum(PROJECT_STATES)
    .default("")
    .describe("Show only projects at this stage. Leave it on Any to show all of them."),
  layout: z
    .enum(["grid", "list"])
    .default("grid")
    .describe("Grid shows cover images. List is denser and better for long lists.")
});

export const peopleShowcaseSectionSchema = showcase({
  plural: "people",
  latestMeaning: "in the order set on the people page",
  fallbackLimit: 8,
  maxLimit: 48
}).extend({
  kind: z
    .enum(PERSON_KINDS)
    .default("")
    .describe("Show only one group, such as faculty. Leave it on Everyone to show all of them."),
  layout: z
    .enum(["grid", "row"])
    .default("grid")
    .describe("Grid wraps onto several lines. Row keeps everyone on one scrolling line."),
  showRole: flag(true, "Shows each person's designation under their name.")
});

export const publicationListSectionSchema = showcase({
  plural: "publications",
  latestMeaning: "newest year first",
  fallbackLimit: 10,
  maxLimit: 60
}).extend({
  kind: z
    .enum(PUBLICATION_KINDS)
    .default("")
    .describe("Show only one sort of publication. Leave it on Any to show all of them."),
  groupByYear: flag(
    true,
    "Puts a year heading above each group. Turn it off for a short hand-picked list."
  ),
  showAbstract: flag(
    false,
    "Shows the first lines of each abstract. Makes the list much longer, so it suits a page about a single topic."
  )
});

export const newsShowcaseSectionSchema = showcase({
  plural: "news items",
  latestMeaning: "most recently published first",
  fallbackLimit: 3,
  maxLimit: 24
}).extend({
  layout: z
    .enum(["feature", "grid", "list"])
    .default("grid")
    .describe(
      "Feature gives the first item a large card and the rest small ones. Grid treats them equally. List is text only."
    )
});

export const eventShowcaseSectionSchema = showcase({
  plural: "events",
  latestMeaning: "soonest first",
  fallbackLimit: 3,
  maxLimit: 24
}).extend({
  // Events are the one record type where "latest" is ambiguous — an archive page wants the opposite
  // ordering from a homepage. Making it explicit stops the homepage quietly advertising last year's
  // seminar the day after the newest one passes.
  when: z
    .enum(["upcoming", "past", "all"])
    .default("upcoming")
    .describe(
      "Which events to show. Upcoming counts forward from today and empties itself as events pass; Past counts backwards."
    ),
  layout: z
    .enum(["grid", "list"])
    .default("list")
    .describe("List shows date, title and venue on one line. Grid shows cover images.")
});

export const gallerySectionSchema = showcase({
  plural: "albums",
  latestMeaning: "most recently published first",
  fallbackLimit: 6,
  maxLimit: 24
}).extend({
  source: z
    .enum(["albums", "images"])
    .default("albums")
    .describe(
      "Albums shows a cover for each album and links through to it. Images shows the pictures themselves — with Chosen by hand, the list above is then images rather than albums."
    ),
  layout: z
    .enum(["masonry", "grid", "carousel"])
    .default("masonry")
    .describe(
      "Masonry keeps each picture's own proportions. Grid crops them all to the same shape. Carousel puts them on one scrolling line."
    ),
  columns: z
    .union([z.literal(2), z.literal(3), z.literal(4)])
    .default(3)
    .describe("How many across on a wide screen. Narrow screens use fewer."),
  lightbox: flag(
    true,
    "Opens a picture full screen when it is clicked, with the caption and credit beneath it."
  )
});

export const mediaSplitSectionSchema = z.object({
  mediaId: mediaId("The picture or video for this block."),
  /**
   * ⚠ THE FIELD ABOVE MAY HOLD A VIDEO, AND A FRAMING IS ONLY EVER ABOUT A PHOTOGRAPH. A film is drawn
   * by the browser's own player, which no rectangle of ours touches, so `MediaSplitForm` offers the
   * panel only once the chosen file is a picture — and both sides reach that verdict through
   * `isVideoObjectKey` below rather than each testing the file for itself. See HERO's
   * `backgroundMediaScreens` for why per-screen framing exists at all.
   */
  mediaScreens: screenFraming(
    "Optional. Frame this picture differently at each screen size, or use a different photograph on narrow screens. Anything left alone inherits from the next smaller size. It does nothing for a video."
  ),
  side: z
    .enum(["left", "right"])
    .default("left")
    .describe(
      "Which side the picture sits on. Alternating sides down a page gives it rhythm. On a narrow screen the picture always comes first."
    ),
  eyebrow: text(60, "The small line above the heading. Optional."),
  heading: text(120, "The heading beside the picture."),
  body: text(600, "The text beside the picture. Three or four sentences is the comfortable maximum."),
  caption: text(200, "A caption under the picture. Optional, and separate from the picture's own alt text."),
  primaryCta: cta("main"),
  secondaryCta: cta("second")
});

/**
 * Is a chosen file a film rather than a photograph?
 *
 * EXPORTED FOR THE SAME REASON AS `documentFormat` FURTHER DOWN. `MediaSplitSection` reaches this
 * verdict to choose between the browser's video player and `MediaImage`; `MediaSplitForm` has to reach
 * the SAME one to decide whether framing per screen size is a control with any visible effect. Two
 * copies of the list would disagree the first time either learned about a container, and an editor
 * would be offered six rows of framing for a film.
 *
 * It lives HERE rather than in the renderer because this module is isomorphic (rule 1) and the renderer
 * is not: a `"use client"` form importing that component tree to read one regular expression would
 * drag the whole of it into the studio bundle.
 *
 * ⚠ THE OBJECT KEY IS THE ONLY SIGNAL AVAILABLE — `MediaLike` carries no asset kind. It matters: a
 * video pushed through the image optimiser answers 400 and draws a broken frame with no clue why.
 */
const VIDEO_OBJECT_KEY = /\.(mp4|webm|ogv|mov|m4v)(\?|$)/i;

export function isVideoObjectKey(objectKey: string): boolean {
  return VIDEO_OBJECT_KEY.test(objectKey);
}

/**
 * A chronology.
 *
 * `year` is a STRING because the honest answers are not years: "c. 1780", "2024–26", "Mughal
 * period". A numeric column would force a made-up precision, and a made-up date in an archive is
 * worse than no date (see `Craft.originYear` in the schema, which carries the same note).
 */
export const timelineSectionSchema = z.object({
  eyebrow: text(60, "The small line above the heading. Optional."),
  heading: text(120, "The heading above the timeline."),
  body: text(320, "A sentence or two under the heading. Optional."),
  orientation: z
    .enum(["vertical", "horizontal"])
    .default("vertical")
    .describe(
      "Vertical runs down the page and holds long entries. Horizontal scrolls sideways and suits short ones."
    ),
  entries: z
    .array(
      z.object({
        year: text(
          24,
          "The date as it should read. Anything is allowed: 1947, c. 1780, 2024–26, or a period name."
        ),
        title: text(120, "What happened."),
        body: text(400, "The detail. Two or three sentences. Optional."),
        mediaId: mediaId("A picture for this entry. Optional."),
        /**
         * ⚠ THE FRAMING LIVES INSIDE THE ROW, WHICH IS WHAT MAKES A REPEATER SAFE HERE. A per-entry
         * override keyed on anything OUTSIDE the row — an index, a generated key — would follow the
         * wrong entry the moment somebody dragged one, because `RepeaterField` keys rows by a key it
         * never persists. Stored as a sibling of the `mediaId` it belongs to, it travels with the entry
         * through every reorder, and two entries showing the same photograph stay independent.
         */
        mediaScreens: screenFraming(
          "Optional. Frame this entry's picture differently at each screen size. Anything left alone inherits from the next smaller size."
        )
      })
    )
    .max(40, "Forty entries is the most one timeline holds. Split a longer history across two blocks.")
    .default([])
    .describe("The entries, oldest first unless you order them otherwise.")
});

export const partnerLogosSectionSchema = showcase({
  plural: "partners",
  latestMeaning: "in the order set on the partners page",
  fallbackLimit: 12,
  maxLimit: 48
}).extend({
  columns: z
    .union([z.literal(3), z.literal(4), z.literal(5), z.literal(6)])
    .default(5)
    .describe("How many logos across on a wide screen."),
  monochrome: flag(
    true,
    "Draws every logo in one tone so a wall of different brand colours does not fight the page, and returns a logo to its own colours when it is hovered."
  )
});

export const quoteSectionSchema = z.object({
  quote: text(400, "The words, without quotation marks — the design adds those."),
  attribution: text(80, "Who said it."),
  role: text(120, "Their position, such as “Director, Centre of Excellence”."),
  portraitMediaId: mediaId("A portrait of the person. Optional."),
  /**
   * ⚠ THE FRAME HERE NEVER CHANGES SHAPE, WHICH IS WHY THE HELP TEXT IS DELIBERATELY MODEST. The hero's
   * note above explains what a framing buys: a frame that runs from 0.5:1 to 2.5:1 cannot be served by
   * one rectangle. `QuoteSection` draws this portrait as a fixed 56px 1:1 circle at every width, so
   * there is no changing frame to answer — the only honest uses left are a tighter crop on small
   * screens, where 56px of a wide group shot is nobody's face, and a different photograph.
   */
  portraitMediaScreens: screenFraming(
    "Optional. The portrait is drawn as the same small circle at every screen size, so this is only for choosing a tighter crop or a different photograph at some widths — not for a frame that changes shape. Anything left alone inherits from the next smaller size, and the smallest falls back to the picture's own crop."
  ),
  alignment: alignment("center", "Where the quotation sits in the column.")
});

export const ctaSectionSchema = z.object({
  eyebrow: text(60, "The small line above the heading. Optional."),
  heading: text(120, "The invitation. A short imperative works best."),
  body: text(320, "What happens next if they act on it. Optional."),
  primaryCta: cta("main"),
  secondaryCta: cta("second"),
  tone: z
    .enum(["brand", "quiet"])
    .default("brand")
    .describe(
      "Brand fills the width with the deep purple panel and carries weight. Quiet sits on the page background and suits a second call further down, where a second loud panel would stop meaning anything."
    ),
  alignment: alignment("center", "Where the words sit in the panel.")
});

export const faqSectionSchema = z.object({
  eyebrow: text(60, "The small line above the heading. Optional."),
  heading: text(120, "The heading above the questions."),
  body: text(320, "A sentence or two under the heading. Optional."),
  items: z
    .array(
      z.object({
        question: text(200, "The question, in the words someone would actually ask it."),
        answer: text(1200, "The answer. Complete sentences — this is read as often as the page itself.")
      })
    )
    .max(30, "Thirty questions is the most one block holds. Group longer lists under two headings.")
    .default([])
    .describe("The questions, in the order they should appear."),
  allowMultipleOpen: flag(
    false,
    "Lets several answers stay open at once. With it off, opening one closes the last."
  )
});

export const contactFormSectionSchema = z.object({
  eyebrow: text(60, "The small line above the heading. Optional."),
  heading: text(120, "The heading above the form."),
  body: text(320, "What to expect, such as how long a reply usually takes. Optional."),
  // Mirrors `ContactSubmission.formKey`. It decides which inbox the message lands in, so it is a
  // closed list rather than free text — a typo here would file enquiries somewhere nobody looks.
  formKey: z
    .enum(["general", "admissions", "collaboration", "media"])
    .default("general")
    .describe("Which inbox these messages go to. It also decides who is notified."),
  submitLabel: text(40, "The words on the send button. Leave it empty for “Send message”."),
  successMessage: text(
    240,
    "What the sender reads once it has gone. Say whether a reply is coming and roughly when."
  ),
  showOrganisationField: flag(true, "Asks for the sender's organisation. Optional for them either way."),
  showPhoneField: flag(false, "Asks for a telephone number. Most enquiries are answered by email."),
  showContactDetails: flag(
    true,
    "Shows the Centre's address and telephone number beside the form, from the contact settings."
  )
});

export const mapSectionSchema = z.object({
  heading: text(120, "The heading above the map. Optional."),
  body: text(320, "A sentence or two under the heading. Optional."),
  // Degrees, validated to the real range. A transposed pair puts the Centre in the sea, and the
  // range check catches the commonest version of that (a longitude typed into the latitude box).
  //
  // Both default to 0, which is open ocean off West Africa — the renderer reads 0/0 as "no location
  // chosen yet" and shows the address with a prompt instead of a map of the Atlantic. That is the
  // blank gap this contract forbids, and it is cheaper to detect here than to make the field
  // mandatory on a block that has only just been dropped onto the page.
  latitude: z.coerce
    .number()
    .min(-90, "A latitude is between -90 and 90. Check the two numbers are not swapped.")
    .max(90, "A latitude is between -90 and 90. Check the two numbers are not swapped.")
    .default(0)
    .describe("Latitude in degrees, from the map service you copied it from."),
  longitude: z.coerce
    .number()
    .min(-180, "A longitude is between -180 and 180.")
    .max(180, "A longitude is between -180 and 180.")
    .default(0)
    .describe("Longitude in degrees."),
  zoom: count({
    min: 1,
    max: 20,
    fallback: 14,
    help: "How close in the map starts. 14 shows a neighbourhood; 18 shows a building."
  }),
  markerLabel: text(120, "The words on the pin, such as “Centre of Excellence”."),
  address: text(240, "The postal address, shown beside the map and readable without loading it."),
  directionsHref: link("A link to directions. Optional."),
  height: z
    .enum(["sm", "md", "lg"])
    .default("md")
    .describe("How tall the map is. Tall maps are handsome and push everything below them down.")
});

/**
 * An embedded video or frame.
 *
 * `title` is the one conditional requirement in this file, and it is an accessibility rule rather
 * than an editorial one: a screen reader announces an untitled `<iframe>` as "frame", which tells the
 * reader nothing about whether to enter it. It binds only once there is a URL, so a block that has
 * just been dropped onto the page still saves (§10 — a field may only be mandatory where it is
 * answerable).
 *
 * Because of that rule this is the ONE schema here that is a `ZodEffects` rather than a `ZodObject`:
 * an editor form reading field descriptions off `.shape` must go through `.innerType()` for this
 * type. Everything else in `SECTION_SCHEMAS` has `.shape` directly.
 */
export const embedSectionSchema = z
  .object({
    provider: z
      .enum(["youtube", "vimeo", "iframe"])
      .default("youtube")
      .describe(
        "Where the video is hosted. YouTube and Vimeo are loaded only when a reader asks to play, so they cost nothing until then. Frame embeds anything else and cannot be optimised."
      ),
    url: link("The address of the video or page to embed. Paste the ordinary share link."),
    title: text(
      160,
      "What this embed contains, in a sentence. It is read aloud to anyone using a screen reader and is the only description they get, so “Video” is not enough."
    ),
    aspectRatio: z
      .enum(["16:9", "4:3", "1:1", "9:16"])
      .default("16:9")
      .describe(
        "The shape of the frame. Getting it right avoids black bars; 9:16 is for phone-shot vertical video."
      ),
    caption: text(240, "A caption under the embed. Optional.")
  })
  .superRefine((value, ctx) => {
    if (value.url !== "" && value.title === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["title"],
        message:
          "Describe this embed before saving it. A screen reader announces an untitled frame only as 'frame', which tells the reader nothing about what is inside."
      });
    }
  });

/**
 * DOCUMENT_EMBED — one uploaded document, shown where the editor put it on the page.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT NAMES A `MediaAsset`, NOT A `FileAsset`, AND THAT IS A TECHNICAL FINDING RATHER THAN A
 * PREFERENCE.
 *
 * Both are existing upload paths and neither is being replaced here, so the question is only which
 * one produces bytes a browser can render IN PLACE:
 *
 *   • A `FileAsset` is served by `app/api/public/files/[slug]`, which 302s to a signed URL carrying
 *     `Content-Disposition: attachment` (lib/storage/client.ts, `presignDownload`). A browser
 *     handed an attachment DOWNLOADS it — an `<iframe>` pointed there leaves an empty box on the
 *     page and a file in the reader's Downloads folder, which is precisely the silent failure a
 *     preview block must not ship. That disposition is deliberate and load-bearing: the file store's
 *     presign route accepts `application/octet-stream` for research data specifically BECAUSE
 *     everything it serves is saved rather than rendered. It is not ours to weaken from here.
 *   • A `MediaAsset` is served straight off the object store's public base by
 *     `publicObjectUrl(objectKey)` — no disposition header, the stored `Content-Type`, and a
 *     DIFFERENT origin from the site. That renders inline, and `app/api/studio/media/presign`
 *     already accepts `application/pdf` and the PowerPoint types and files them as `DOCUMENT`.
 *
 * So the document is chosen from the media library, with the same `mediaId()` reference every other
 * block uses for an uploaded asset. A file that is ALSO meant to be counted as a download belongs in
 * a DOWNLOADS block beside this one; the two answer different questions.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `title` is required once a document is chosen — the third of the conditional requirements
 * described in rule 4 at the top of this file, and the same kind as the other two: it is the
 * `<iframe>`'s accessible name, and a screen reader announces an untitled frame as "frame". Because
 * of it this is a `ZodEffects` rather than a `ZodObject`, so the studio form reads its field
 * descriptions through `.innerType()`, as EMBED's and FORM_EMBED's do.
 *
 * ⚠ NOTHING HERE PROMISES A PREVIEW. A browser renders a PDF and renders nothing else — no
 * PowerPoint, no Word, no OpenDocument — so `DocumentEmbedSection` shows a download card for those
 * and says so in words. That is stated in the `mediaId` help below rather than left for an editor to
 * discover by publishing a page with a blank frame on it.
 */
export const documentEmbedSectionSchema = z
  .object({
    mediaId: mediaId(
      "The document, chosen from the media library. Upload it there first. A PDF is shown on the page itself; a PowerPoint, Word or OpenDocument file cannot be — browsers cannot draw those — so it is offered as a download with its name, type and size."
    ),
    title: text(
      160,
      "What this document is, in a sentence. It is the heading above it and the only description read aloud to anyone using a screen reader, so “PDF” is not enough."
    ),
    description: text(
      320,
      "A sentence or two under the heading — what is in the document, or which version this is. Optional."
    ),
    height: z
      .enum(["sm", "md", "lg", "xl"])
      .default("md")
      .describe(
        "How much of the page the document takes up. It scrolls inside its own frame whatever you choose, so this is about the shape of the page rather than about how much of the document can be read."
      ),
    downloadLabel: text(
      60,
      "The words on the link that opens the document on its own, which is always shown. Leave it empty for “Download the document”."
    )
  })
  .superRefine((value, ctx) => {
    if (value.mediaId !== "" && value.title === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["title"],
        message:
          "Describe this document before saving it. A screen reader announces an untitled frame only as 'frame', which tells the reader nothing about what is inside."
      });
    }
  });

/**
 * What a reader would call a document, and whether a browser can draw it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * EXPORTED BECAUSE THE STUDIO'S FORM SHOWS THE EDITOR EXACTLY THE VERDICT THE PAGE WILL REACH, while
 * they are still choosing the file — the same argument, and the same shape, as `resolveFormTarget` in
 * `components/sections/FormEmbedSection.tsx`. Two copies of this decision would disagree the first
 * time either learned about a format, and the disagreement would show as a studio that promises a
 * preview and a page that does not give one.
 *
 * It lives HERE rather than in the renderer because this module is isomorphic (rule 1) and the
 * renderer is not: a `"use client"` form importing the renderer would drag that whole component tree
 * into the studio bundle to read one lookup table.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * KEYED ON THE EXTENSION, NOT ON THE STORED MIME TYPE, following `DownloadsSection`: the extension is
 * what an editor actually named the file, whereas a declared type is whatever the uploading browser
 * guessed — and browsers guess `application/octet-stream` for a great deal.
 *
 * ⚠ `previewable` IS TRUE FOR PDF AND NOTHING ELSE, and that is a fact about browsers rather than a
 * policy of ours: none of them can draw a PowerPoint, a Word file or an OpenDocument. Adding a format
 * to this list makes `DocumentEmbedSection` frame it, so add one only when a browser has actually
 * been observed to render it.
 */
export interface DocumentFormat {
  /** Lowercased, no dot. `""` where the name carries none. */
  extension: string;
  /** "PDF", "PowerPoint presentation". Never empty — an unknown extension is shown in capitals. */
  label: string;
  /** Can a browser render it in a frame? Only a PDF can. */
  previewable: boolean;
  /** Lets a caller say "a PowerPoint presentation cannot be shown" rather than "this file type". */
  isPresentation: boolean;
}

const DOCUMENT_FORMAT_NAMES: Record<string, string> = {
  pdf: "PDF",
  ppt: "PowerPoint presentation",
  pptx: "PowerPoint presentation",
  pps: "PowerPoint slide show",
  ppsx: "PowerPoint slide show",
  key: "Keynote presentation",
  odp: "OpenDocument presentation",
  doc: "Word document",
  docx: "Word document",
  odt: "OpenDocument text",
  rtf: "Rich text document",
  xls: "Excel spreadsheet",
  xlsx: "Excel spreadsheet",
  ods: "OpenDocument spreadsheet",
  csv: "CSV data",
  txt: "Plain text",
  zip: "ZIP archive"
};

const PRESENTATION_EXTENSIONS = new Set(["ppt", "pptx", "pps", "ppsx", "key", "odp"]);

/**
 * The extension, lowercased and stripped of anything that is not a letter or a digit.
 *
 * Written out here rather than imported from `lib/storage/keys.ts`, which needs `node:crypto` for key
 * generation — a dependency this isomorphic module must not acquire, and the same trade
 * `DownloadsSection` makes for the same reason.
 */
function documentExtensionOf(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  if (index <= 0 || index === fileName.length - 1) return "";
  return fileName
    .slice(index + 1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Read a document's format off its name.
 *
 * Takes the object key as a second chance, because `buildObjectKey` preserves the extension at the
 * end of the key (lib/storage/keys.ts) and an asset imported from elsewhere can have lost its
 * original filename while keeping a usable key.
 */
export function documentFormat(fileName: string, objectKey = ""): DocumentFormat {
  const extension = documentExtensionOf(fileName) || documentExtensionOf(objectKey);
  return {
    extension,
    label: DOCUMENT_FORMAT_NAMES[extension] ?? (extension ? extension.toUpperCase() : "Document"),
    previewable: extension === "pdf",
    isPresentation: PRESENTATION_EXTENSIONS.has(extension)
  };
}

export const downloadsSectionSchema = showcase({
  plural: "files",
  latestMeaning: "most recently added first",
  fallbackLimit: 6,
  maxLimit: 40
}).extend({
  category: text(60, "Show only files in one category. Leave it empty to show every category."),
  showFileSize: flag(
    true,
    "Shows the type and size beside each file, so nobody starts a 40 MB download on a phone by accident."
  ),
  showUpdatedOn: flag(true, "Shows when each file was last replaced, which matters for datasets.")
});

export const craftExplorerSectionSchema = showcase({
  plural: "crafts",
  latestMeaning: "most recently published first",
  fallbackLimit: 12,
  maxLimit: 60
}).extend({
  view: z
    .enum(["map", "grid", "timeline"])
    .default("grid")
    .describe(
      "Grid shows a card for each craft. Map places them by region and needs their coordinates. Timeline orders them by origin and leaves out any craft with no date."
    ),
  regionSlug: text(
    120,
    "Show only crafts from one region, by its short name. Leave it empty for every region."
  ),
  showFilters: flag(
    true,
    "Gives readers the filters for region, material and technique. Turn it off where the block is a taster rather than the explorer itself."
  )
});

// ─────────────────────────────────────────────────────────────────────────────
// The application-page trio: what to do, the form to do it on, and where to read more
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A step's state, as a code word. `""` is "not stated", which is the honest default: most checklists
 * are a list of things to do rather than a set of windows that open and close.
 */
const STEP_STATUSES = ["", "open", "closed", "coming"] as const;

/**
 * "How to apply", "What to bring", "Submission checklist".
 *
 * FORM_EMBED, alone of the three below, has no `eyebrow`. Its `title` is not merely a heading — it is the
 * `<iframe>`'s accessible name, the one thing a screen reader announces about the frame — and a
 * decorative category line read out immediately before it would be the first thing that reader hears
 * about a form they are deciding whether to enter. The other two are ordinary content bands and carry an
 * eyebrow like the rest.
 *
 * ⚠ `deadline` IS A STRING AND `status` IS THE EDITOR'S OPINION, and the two can disagree. The renderer
 * does not reconcile them by hiding either: a passed deadline is stated as passed, in words, beside
 * whatever status the editor set. A checklist that quietly drops a step — or quietly recolours one — is
 * a checklist nobody can trust, and the reader who needed that step is exactly the reader who will not
 * discover it is missing (contract §1.6).
 */
export const actionStepsSectionSchema = z.object({
  eyebrow: text(60, "The small line above the heading, such as “Admissions 2026”. Optional."),
  heading: text(120, "The heading above the steps, such as “How to apply”."),
  body: text(320, "A sentence or two under the heading. Say who this is for. Optional."),
  numbered: flag(
    true,
    "Numbers the steps 1, 2, 3 and tells a screen reader they are in order. Turn it off for a checklist where the order does not matter — “what to bring” rather than “how to apply”."
  ),
  steps: z
    .array(
      z.object({
        title: text(120, "What this step is, in a few words — “Send two references”."),
        detail: text(
          600,
          "What the reader has to do, in complete sentences. Two or three lines reads best."
        ),
        href: link("Where this step leads — a form, a page, a file. Optional."),
        ctaLabel: text(
          40,
          "The words on this step's button, such as “Open the application form”. Leave it empty and the button reads “Open this step”."
        ),
        deadline: isoDate(
          "The closing date for this step, as year-month-day. The page shows the date and how long is left, and says plainly once it has passed. Optional."
        ),
        status: z
          .enum(STEP_STATUSES)
          .default("")
          .describe(
            "Whether this step is open. Shown as a word with an icon beside it, never as a colour alone. A closing date that has passed is stated as passed whatever you choose here, so the page cannot contradict itself."
          )
      })
    )
    .max(
      16,
      "Sixteen steps is the most anybody reads in one list. Split a longer process into two blocks with a heading each."
    )
    .default([])
    .describe("The steps, in the order they should be done.")
});

/**
 * The four services a small institution actually collects applications with.
 *
 * `other` is in the list because there is always another one — and it is the one provider whose form is
 * NEVER put in a frame. See the host allow-list below.
 */
const FORM_PROVIDERS = ["google", "microsoft", "typeform", "other"] as const;

export type FormEmbedProvider = (typeof FORM_PROVIDERS)[number];

/**
 * WHICH HOSTS MAY BE PUT IN AN IFRAME ON OUR OWN ORIGIN, per provider.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS IS AN ALLOW-LIST AND NOT A CONVENIENCE. An arbitrary URL rendered in a frame on
 * `centre.example/apply` is a page under somebody else's control wearing the Centre's domain, its
 * padlock and its header — which is the entire construction of a credential-harvesting page. The
 * reader has no way to tell the frame apart from the page around it, and every instinct we teach them
 * ("check the address bar") gives the wrong answer.
 *
 * `other` maps to an EMPTY list on purpose rather than being absent: an unknown service is offered as
 * an ordinary outbound link, which is safe because a link shows its destination and leaves our origin.
 * A uniform lookup with an empty list is also one fewer branch than a special case, and a branch is
 * where a check gets forgotten.
 *
 * Typeform is matched by SUFFIX because every account gets its own subdomain. The leading dot in
 * `.typeform.com` is load-bearing: without it `eviltypeform.com` passes.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const FORM_PROVIDER_HOSTS: Record<FormEmbedProvider, readonly string[]> = {
  // forms.gle is Google's short link. It redirects to docs.google.com inside the frame, which is why
  // it is accepted here rather than refused for not being the final host.
  google: ["docs.google.com", "forms.gle"],
  microsoft: ["forms.office.com", "forms.microsoft.com"],
  typeform: ["typeform.com"],
  other: []
};

/** Which hosts get a suffix match — `*.host` as well as `host` itself. */
const FORM_HOST_SUFFIX_MATCH: readonly string[] = ["typeform.com"];

/** The provider's name as an administrator says it. */
export const FORM_PROVIDER_LABELS: Record<FormEmbedProvider, string> = {
  google: "Google Forms",
  microsoft: "Microsoft Forms",
  typeform: "Typeform",
  other: "Another service"
};

/**
 * May this hostname be framed for this provider?
 *
 * `www.` is stripped first, so the address a reader copied out of a browser bar is judged on the same
 * terms as the share link. Exported because the schema, the studio's form and the public renderer must
 * all reach the same verdict, and three copies of a security check are three chances for one of them to
 * be out of date.
 */
export function formHostAllowed(provider: FormEmbedProvider, hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^www\./, "");
  if (host === "") return false;

  return FORM_PROVIDER_HOSTS[provider].some((allowed) => {
    if (host === allowed) return true;
    return FORM_HOST_SUFFIX_MATCH.includes(allowed) && host.endsWith(`.${allowed}`);
  });
}

/**
 * The refusal, as a sentence naming what IS accepted.
 *
 * "That address is not allowed" tells an editor nothing they can act on. Naming the hosts turns a
 * refusal into an instruction, which is the whole of §9's rule that a message is a plain human sentence
 * ready to render verbatim.
 */
export function describeFormHosts(provider: FormEmbedProvider): string {
  const hosts = FORM_PROVIDER_HOSTS[provider];
  if (hosts.length === 0) {
    return "A form from any other service is offered as a link rather than shown inside the page, because a page from an address we do not recognise must not be framed inside the Centre's own site.";
  }

  const named = hosts
    .map((host) => (FORM_HOST_SUFFIX_MATCH.includes(host) ? `${host} (and its subdomains)` : host))
    .join(" or ");
  return `For ${FORM_PROVIDER_LABELS[provider]}, the address has to be on ${named}.`;
}

/**
 * A Google Form, Microsoft Form or Typeform — how a small institution really collects applications.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * TWO RULES THAT ARE NOT PREFERENCES.
 *
 *  1. **The host is checked against the allow-list above.** See the warning on it. The check lives in
 *     `superRefine` rather than on the field, because it depends on `provider` — and it only fires once
 *     the address has a hostname with a dot in it, so an editor typing rather than pasting is not
 *     scolded at every keystroke (rule 4: a rule that fires halfway through an edit refuses the save
 *     while the editor is still working).
 *
 *  2. **`title` is required once there is a URL.** Identical in kind to the EMBED title below, and the
 *     second of the two conditional requirements in this file. A screen reader announces an untitled
 *     frame as "frame". It binds only once there is a form to label, per §10 — a field may only be
 *     mandatory where it is answerable.
 *
 * Because of rule 2 this is a `ZodEffects` rather than a `ZodObject`, so an editor form reading field
 * descriptions off `.shape` must go through `.innerType()` for this type, as it must for EMBED.
 *
 * `url` requires **https** specifically, not merely an absolute address. Every one of these providers
 * is https-only, and a form collecting somebody's name, address and date of birth over plain http is
 * not a thing the Centre should be able to publish by pasting the wrong link.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const formEmbedSectionSchema = z
  .object({
    provider: z
      .enum(FORM_PROVIDERS)
      .default("google")
      .describe(
        "Which service the form is on. This decides which addresses are accepted. Another service is offered to readers as a link rather than shown inside the page."
      ),
    url: z
      .string()
      .trim()
      .max(500, "That link is too long to be right. Check it and paste it again.")
      .refine((value) => value === "" || /^https:\/\/\S+$/.test(value), {
        message:
          "Paste the whole address of the form, starting with https:// — not a page on this site, and not a plain http address."
      })
      .default("")
      .describe("The address of the form. Paste the ordinary share or publish link."),
    title: text(
      160,
      "What this form is for, in a sentence. It is the heading above the form and it is read aloud to anyone using a screen reader, so “Form” is not enough."
    ),
    description: text(
      320,
      "What happens after they send it, such as how long a decision takes. Optional."
    ),
    height: z
      .enum(["sm", "md", "lg", "xl"])
      .default("lg")
      .describe(
        "How tall the form is on the page. A form shorter than its content scrolls inside its own box, which is awkward on a phone, so err on the tall side."
      ),
    openInNewTabLabel: text(
      60,
      "The words on the plain link to the form, which is always shown as well. Leave it empty for “Open the form in a new tab”."
    )
  })
  .superRefine((value, ctx) => {
    if (value.url !== "" && value.title === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["title"],
        message:
          "Describe this form before saving it. A screen reader announces an untitled frame only as 'frame', which tells the reader nothing about what is inside."
      });
    }

    if (value.url === "") return;

    let hostname = "";
    try {
      hostname = new URL(value.url).hostname;
    } catch {
      // Not yet a whole address. The field's own https rule has already said so; a second complaint
      // about its host would only bury the first.
      return;
    }

    // A hostname with no dot in it is an address somebody is still typing, not one they got wrong.
    if (!hostname.includes(".")) return;

    if (value.provider === "other") {
      // Nothing to refuse: `other` is never framed, so any https address is a legitimate link. The
      // renderer states on screen that it will open in a new tab rather than appear in the page.
      return;
    }

    if (!formHostAllowed(value.provider, hostname)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: `That address is on ${hostname}, which cannot be shown inside a page on this site. ${describeFormHosts(value.provider)} If the form is somewhere else, set the service to “Another service” and it will be offered as a link instead.`
      });
    }
  });

/**
 * A grid of resource links — guidelines, past papers, funding calls.
 *
 * Deliberately NOT a showcase block: these point at things that live outside the CMS as often as
 * inside it (a ministry circular, a partner university's page, a PDF in the file store), so there is
 * no table to curate from and the payload holds the links themselves.
 *
 * `external` is the editor's decision about opening a new tab and not a guess from the address. Some
 * absolute links belong in the same tab — a partner page a reader is meant to move on to — and some
 * internal ones are a download they will come straight back from. The renderer pairs the choice with
 * `rel="noopener noreferrer"` and a spoken "(opens in a new tab)", because a reader whose focus lands
 * in a new tab with no warning has lost their place and their Back button with it.
 */
export const linkGridSectionSchema = z.object({
  eyebrow: text(60, "The small line above the heading. Optional."),
  heading: text(120, "The heading above the links, such as “Guidelines and forms”."),
  body: text(320, "A sentence or two under the heading. Optional."),
  columns: z
    .union([z.literal(2), z.literal(3), z.literal(4)])
    .default(3)
    .describe(
      "How many links sit across the grid on a wide screen. Narrow screens always stack them into one column."
    ),
  items: z
    .array(
      z.object({
        label: text(80, "What this link is, in a few words."),
        description: text(240, "One line about what a reader will find there. Optional."),
        href: link("Where it goes. A page on this site, a file, or another site."),
        icon: iconName("The icon shown beside the label. Optional — without one the card is plain."),
        external: flag(
          false,
          "Opens the link in a new tab and says so, both on screen and aloud. Use it for another organisation's site, where losing this page would cost the reader their place."
        )
      })
    )
    .max(
      24,
      "Twenty-four links is the most one grid holds. Group a longer list under two headings, with a block each."
    )
    .default([])
    .describe("The links, in the order they should appear.")
});

/**
 * Deliberate empty space.
 *
 * Nothing but a size: this exists so a builder can breathe a page out without inventing a rich-text
 * block full of empty paragraphs, which is what happens when there is no spacer.
 */
export const spacerSectionSchema = z.object({
  size: z
    .enum(["sm", "md", "lg", "xl"])
    .default("md")
    .describe(
      "How much space to leave. Small is a paragraph's worth; extra large separates two parts of a page that are about different things."
    )
});

// ─────────────────────────────────────────────────────────────────────────────
// The narrative blocks — the four whose motion is scroll-SCRUBBED
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A picture, from EITHER of the site's two sources.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY TWO FIELDS RATHER THAN ONE, AND WHY THE MEDIA LIBRARY WINS.
 *
 * There are genuinely two places a photograph can come from here and they are not interchangeable:
 *
 *   • `mediaId` — a `MediaAsset` an editor uploaded. Addressed through the CDN, alt text in the
 *     database, replaceable without touching this payload. THIS IS THE ONE TO PREFER, always.
 *   • `craftImage` — a slug from `lib/media/craft-imagery.ts`: an openly licensed photograph
 *     committed to `public/craft/`, whose attribution is compiled in. It exists so a page can be
 *     built and look like something before anybody has uploaded anything, and so the craft archive
 *     has real photography rather than grey rectangles.
 *
 * The renderer prefers `mediaId` when both are set, which makes the upgrade path a one-field edit:
 * an editor uploads their own photograph of the same craft, picks it, and the bundled one steps
 * aside without anything else changing.
 *
 * ⚠ THE TWO ARE NOT CROSS-VALIDATED AND MUST NOT BE. Rule 4 above: autosave runs between "cleared
 * the old one" and "picked the new one", and a rule that fires in that gap refuses a save an editor
 * is in the middle of. A block with neither states so on the page rather than rendering a hole.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
function craftImageSlug(help: string) {
  return z
    .string()
    .trim()
    .max(60, "That is not a craft photograph name.")
    // A SHAPE test, not a check against the manifest. Importing the manifest here would put
    // the whole manifest into every studio bundle that touches this file, and — more to the point —
    // a payload outlives the picture set: a slug retired from the manifest must leave the block
    // rendering "the photograph is missing", never refusing to parse. `craftImage()` returns null and
    // the renderer says so.
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Pick a photograph from the list rather than typing one.")
    .or(z.literal(""))
    .default("")
    .describe(help);
}

/**
 * STORY_SCROLL — the block that lets a page NARRATE rather than list.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IT IS ON SCREEN: a sequence of chapters. Each one is a photograph that STAYS PUT while its
 * own paragraphs scroll past it, and is then replaced by the next chapter's photograph. The effect
 * is that the reader walks through a story at their own pace and the picture waits for them.
 *
 * ⚠ THE STICKINESS IS CSS, NOT JAVASCRIPT, AND THAT IS THE WHOLE ARCHITECTURE OF THIS BLOCK.
 * `position: sticky` on each chapter's figure does all of the work that matters. GSAP adds a slow
 * parallax inside the frame and a progress rail down the side, and if the GSAP chunk never arrives —
 * or the reader has asked for less motion, or JavaScript is off entirely — what remains is a
 * perfectly ordinary, perfectly readable article with sticky illustrations.
 *
 * The alternative, which this deliberately is NOT, is a pinned container whose chapters are stacked
 * on top of one another and cross-faded by scroll position. That reads well and degrades to a single
 * unreadable pile of overlapping text the moment anything about the JavaScript goes wrong.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const storyScrollSectionSchema = z.object({
  /**
   * ⚠ `.default("chapters")` IS WHAT MAKES ADDING THIS FIELD SAFE — every existing STORY_SCROLL row
   * parses as the block it always was. "cinematic" swaps the whole rendering for the Centre's own
   * scroll-driven telling (components/sections/story/CinematicScroll.tsx): a single authored
   * artwork whose words are code, deliberately NOT assembled from the chapter fields below — the
   * choreography and the copy are one composition, and a form field per line would let the two
   * halves drift apart. The chapters below are ignored in that mode and kept in the row untouched.
   */
  presentation: z
    .enum(["chapters", "cinematic"])
    .default("chapters")
    .describe(
      "How the story is told. Chapters is the ordinary photographs-and-paragraphs story built from the fields below. Cinematic is the Centre's own scroll-driven telling — a fixed, designed sequence whose words are part of the site itself; the fields below are ignored while it is chosen."
    ),
  eyebrow: text(60, "The small line above the heading, such as “The making of a shawl”. Optional."),
  heading: text(120, "The heading for the whole story."),
  body: text(
    320,
    "A sentence or two setting the story up, before the first chapter. Optional."
  ),
  side: z
    .enum(["left", "right"])
    .default("left")
    .describe(
      "Which side the photographs sit on. On a narrow screen each photograph always sits above its own words, whatever you choose."
    ),
  showProgress: flag(
    true,
    "Draws a thin rail down the side that fills as the reader moves through the story, and marks each chapter on it. The chapter numbers are shown as text as well, so a reader who cannot see the rail is not missing anything."
  ),
  chapters: z
    .array(
      z.object({
        kicker: text(40, "A word or two above the chapter title — “One”, “1870”, “The clay”."),
        title: text(120, "What this chapter is about, in a few words."),
        body: text(
          900,
          "The chapter itself. Two or three short paragraphs read best; leave a blank line between them."
        ),
        mediaId: mediaId("A photograph you have uploaded. Preferred over the one below."),
        /**
         * ⚠ INSIDE THE ROW, for the reason `timelineSectionSchema`'s entry sets out — an override kept
         * anywhere outside the chapter follows the wrong chapter the moment somebody drags one.
         *
         * ⚠ AND IT FRAMES THE UPLOADED PHOTOGRAPH ONLY. A `craftImage` slug resolves to a compiled-in
         * file with no `MediaAsset` row and no crop columns (see `craftImageSlug` above), so a chapter
         * drawing the bundled picture has nothing for a rectangle to be expressed against. The help text
         * says so, because the alternative is an editor framing a picture that never changes.
         */
        mediaScreens: screenFraming(
          "Optional. Frame this chapter's photograph differently at each screen size, or use a different photograph on narrow screens. Anything left alone inherits from the next smaller size. It applies to a photograph you have uploaded, not to one that ships with the site."
        ),
        craftImage: craftImageSlug(
          "One of the craft photographs that ship with the site. Used only when you have not chosen an uploaded photograph above."
        ),
        caption: text(160, "A line under the photograph, in the site's own words. Optional."),
        href: link("Where this chapter leads, if it leads anywhere. Optional."),
        ctaLabel: text(40, "The words on this chapter's link. Without them the link is not shown.")
      })
    )
    .max(
      12,
      "Twelve chapters is a long read. Past that, the story wants to be two pages rather than one block."
    )
    .default([])
    .describe("The chapters, in the order they are read.")
});

/**
 * PARALLAX_BANNER — one photograph, full width, moving more slowly than the page.
 *
 * ⚠ THE SCRIM IS NOT DECORATION AND ITS DEFAULT IS NOT "none". Text over an arbitrary photograph is
 * a contrast failure waiting for the wrong picture: the photograph can be any colour, and an editor
 * choosing it is not thinking about the WCAG contrast of white type over the top-left quarter of it.
 * So the default lays a gradient scrim under the words, and the "no scrim" option says in its own
 * help text what it costs. The heading colour is fixed white rather than themed — the band is a
 * photograph in both themes, so there is nothing for a theme to invert.
 */
export const parallaxBannerSectionSchema = z.object({
  eyebrow: text(60, "The small line above the heading. Optional."),
  heading: text(120, "The line across the photograph. Short — it sits over a picture."),
  body: text(240, "A sentence under it. Optional, and shorter is better here than anywhere else."),
  mediaId: mediaId("A photograph you have uploaded. Preferred over the one below."),
  /**
   * ⚠ THIS BAND IS FULL-BLEED, SO IT IS THE HERO'S PROBLEM ALL OVER AGAIN. See
   * `backgroundMediaScreens` above for the argument. The photograph spans the window while the band's
   * height comes from `height` below, so one rectangle has to serve a frame that is roughly square on a
   * phone — taller than it is wide at the full-screen height — and several times wider than it is tall on
   * a desktop.
   *
   * ⚠ AND IT FRAMES THE UPLOADED PHOTOGRAPH ONLY. `craftImage` below is a slug into the compiled-in
   * manifest with no `MediaAsset` row behind it, so there is nothing to express a rectangle against and
   * `StoryPicture`'s craft branch never sees this. The help text says so, because an editor who has
   * chosen a bundled photograph would otherwise be framing something that never changes.
   */
  mediaScreens: screenFraming(
    "Optional. Frame the band's photograph differently at each screen size, or use a different photograph on narrow screens. Anything left alone inherits from the next smaller size. It applies to a photograph you have uploaded, not to one that ships with the site."
  ),
  craftImage: craftImageSlug(
    "One of the craft photographs that ship with the site. Used only when you have not chosen an uploaded photograph above."
  ),
  height: z
    .enum(["md", "lg", "screen"])
    .default("lg")
    .describe(
      "How tall the band is. Full screen is striking once on a page and exhausting twice — it costs the reader a whole screen with no way to skim it."
    ),
  overlay: z
    .enum(["scrim", "deep", "none"])
    .default("scrim")
    .describe(
      "How much the photograph is darkened behind the words. “None” is only safe over a picture you have checked yourself — white text over a pale photograph is unreadable, and which photograph it is can change later."
    ),
  align: alignment("left", "Where the words sit across the band."),
  cta: cta("main"),
  speed: count({
    min: 0,
    max: 40,
    fallback: 14,
    help: "How far the photograph drifts as the band passes, as a percentage of its own height. Zero switches the drift off and leaves a plain photograph. Above about twenty it stops reading as depth and starts reading as a mistake."
  })
});

/**
 * HORIZONTAL_RAIL — a line of cards the reader travels along sideways.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ IT IS A REAL, NATIVELY SCROLLABLE RAIL FIRST, AND A SCROLL-DRIVEN ONE SECOND.
 *
 * The markup is an `overflow-x: auto` strip with scroll-snap — which is operable by touch, by a
 * trackpad, by a scrollbar and by the keyboard, and is exactly what a reader gets with no
 * JavaScript, under reduced motion, and on a phone. GSAP then adds the cinema on wide screens:
 * the section pins and the rail travels sideways as the reader scrolls down.
 *
 * The order matters because the opposite order is the common bug. A rail built as a pinned GSAP
 * effect first, with a fallback bolted on, is one whose fallback nobody ever looks at — and it is a
 * carousel that cannot be scrolled on the one device where sideways scrolling is natural.
 *
 * `pin` is therefore an OPT-IN with an honest name, and the help text says what switching it on
 * costs: pinning takes the scroll wheel away for the length of the rail, which on a long rail is a
 * long time to have the page refuse to go down.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const horizontalRailSectionSchema = z.object({
  /**
   * ⚠ `.default("rail")` IS WHAT MAKES ADDING THIS FIELD SAFE — every existing HORIZONTAL_RAIL row
   * parses as the block it always was. "arc" swaps the scrolling strip for a fan of the same cards
   * along a circular curve the reader turns by hand (components/site/ArcCarousel.tsx) — dragged, or
   * stepped a card at a time from two buttons, which are also the keyboard path. The cards below are
   * the SAME cards in both drawings; nothing about an editor's content changes when they switch.
   * `pin` and `cardWidth` are rail settings and are ignored while the arc is chosen — the arc sizes
   * its own cards and never takes the page's scroll away.
   */
  presentation: z
    .enum(["rail", "arc"])
    .default("rail")
    .describe(
      "How the line of crafts is drawn. Rail is the scrolling line. Arc fans the cards along a curve the reader can turn."
    ),
  eyebrow: text(60, "The small line above the heading. Optional."),
  heading: text(120, "The heading above the rail."),
  body: text(320, "A sentence or two under the heading. Optional."),
  pin: flag(
    false,
    "On a wide screen, holds the section still and moves the rail sideways as the reader scrolls down. It is the most cinematic thing on the site and it takes the scroll away for the length of the rail — use it once on a page, on a rail of six cards or fewer. Phones, keyboards and readers who have asked for less motion always get the ordinary sideways rail instead."
  ),
  cardWidth: z
    .enum(["sm", "md", "lg"])
    .default("md")
    .describe("How wide each card is. Large shows about two at a time, small about four."),
  items: z
    .array(
      z.object({
        title: text(120, "What this card is."),
        detail: text(280, "A line or two about it. Optional."),
        meta: text(60, "A small line under the title — a place, a date, a material. Optional."),
        mediaId: mediaId("A photograph you have uploaded. Preferred over the one below."),
        /**
         * ⚠ INSIDE THE ROW, for the reason TIMELINE's own note gives: `RepeaterField` keys rows by a
         * key it never persists, so a framing held anywhere outside the row would follow the wrong
         * card the moment somebody dragged one.
         *
         * ⚠ AND IT FRAMES THE UPLOADED ASSET ONLY. `craftImage` below is a slug into the compiled-in
         * manifest — there is no media row to crop and no `MediaAsset` for a bucket to name an
         * alternate against, so a card drawn from a craft photograph is framed by nothing here.
         */
        mediaScreens: screenFraming(
          "Optional. Frame this card's uploaded photograph differently at each screen size. Anything left alone inherits from the next smaller size. It applies to the rail; the arc sizes its own cards and ignores it."
        ),
        craftImage: craftImageSlug(
          "One of the craft photographs that ship with the site. Used only when you have not chosen an uploaded photograph above."
        ),
        href: link("Where this card goes. Optional — without it the card is not a link.")
      })
    )
    .max(
      20,
      "Twenty cards is the most a rail holds before finding the last one becomes work. Past that the reader wants a page with filters, not a rail."
    )
    .default([])
    .describe("The cards, left to right.")
});

/**
 * PROCESS_STEPS — how a thing is made, in order, with a line drawn between the stages.
 *
 * ⚠ NOT THE SAME BLOCK AS ACTION_STEPS, AND THE DIFFERENCE IS THE READER'S JOB.
 *   • ACTION_STEPS is a list of things the READER has to DO: it carries closing dates, buttons and
 *     an open/closed state, and it is wrong for it to be beautiful at the expense of being clear.
 *   • PROCESS_STEPS is a description of what SOMEBODY ELSE does: the stages of dyeing a cloth, the
 *     firing of a pot. Nothing to click, nothing to miss a deadline for.
 * Putting a closing date on a description of how indigo is fermented would be nonsense, and putting
 * a scrubbed drawing animation on an application deadline would be worse. Hence two blocks.
 */
export const processStepsSectionSchema = z.object({
  eyebrow: text(60, "The small line above the heading, such as “From fleece to shawl”. Optional."),
  heading: text(120, "The heading above the stages, such as “How it is made”."),
  body: text(320, "A sentence or two under the heading. Optional."),
  numbered: flag(
    true,
    "Numbers the stages and tells a screen reader they are in order. Turn it off where the stages genuinely happen at once."
  ),
  layout: z
    .enum(["alternating", "column"])
    .default("alternating")
    .describe(
      "Alternating puts each stage on the opposite side of the line, which suits four or more. A single column suits two or three, and is what every narrow screen gets whichever you choose."
    ),
  steps: z
    .array(
      z.object({
        title: text(120, "What happens at this stage, in a few words."),
        detail: text(600, "What it involves, in complete sentences."),
        meta: text(60, "How long it takes, or who does it. A small line under the title. Optional."),
        mediaId: mediaId("A photograph you have uploaded. Preferred over the one below."),
        /**
         * ⚠ INSIDE THE ROW, for the reason `timelineSectionSchema`'s entry states: `RepeaterField` keys
         * rows by a key it never persists, so a framing held outside the row would follow the wrong
         * stage the moment somebody dragged one.
         *
         * ⚠ AND IT FRAMES THE UPLOADED PHOTOGRAPH ONLY. `craftImage` below is a slug into the
         * compiled-in manifest with no `MediaAsset` row behind it, so a stage drawing the bundled
         * picture has nothing for a rectangle to be expressed against.
         */
        mediaScreens: screenFraming(
          "Optional. Frame this stage's photograph differently at each screen size, or use a different photograph on narrow screens. Anything left alone inherits from the next smaller size. It applies to a photograph you have uploaded, not to one that ships with the site."
        ),
        craftImage: craftImageSlug(
          "One of the craft photographs that ship with the site. Used only when you have not chosen an uploaded photograph above."
        )
      })
    )
    .max(
      12,
      "Twelve stages is the most one diagram carries. A longer process is two diagrams with a heading each."
    )
    .default([])
    .describe("The stages, in the order they happen.")
});

/**
 * PLATFORM_PILLARS — the platform, in three instruments.
 *
 * ⚠ THE THREE PILLARS ARE FIXED AND CARRY NO FIELDS, ON PURPOSE. Knowledge bases, field repositories
 * and knowledge-based systems are each a designed vignette — a scroll-scrubbed drawing with one title
 * and one sentence, composed together in `components/sections/PlatformPillarsSection.tsx` the way the
 * cinematic story's words are code (see `storyScrollSectionSchema`'s note on "cinematic"). An editable
 * array here would let the copy drift apart from the drawing it captions, and the drawing cannot be
 * edited from a form anyway. Only the header above the three is content: the block is placed, ordered,
 * headed and hidden through the CMS, and everything below the header is the site's own design.
 */
export const platformPillarsSectionSchema = z.object({
  eyebrow: text(60, `The small line above the heading, such as “The platform”. Optional.`),
  heading: text(
    120,
    "The heading above the three instruments. Leave it empty to run straight into them — the block still names itself to screen readers."
  ),
  body: text(320, "A sentence or two under the heading. Optional.")
});

/**
 * INDIA_MAP — the outline of India with a pin per craft region.
 *
 * Only the header is content, the same argument as PLATFORM_PILLARS above: the map is drawn from
 * the archive itself (regions with coordinates, counted from published crafts), so there is nothing
 * an editor could type into it that the records do not already say. The geometry is the official
 * depiction — components/map/indiaGeometry.ts carries the provenance argument and the warning
 * against substituting a Western dataset.
 */
export const indiaMapSectionSchema = z.object({
  eyebrow: text(60, `The small line above the heading, such as “Across the country”. Optional.`),
  heading: text(120, "The heading above the map."),
  body: text(
    320,
    "A sentence or two under the heading. Optional — the map and its list carry their own counts."
  )
});

// ─────────────────────────────────────────────────────────────────────────────
// The registry, and the types derived from it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every schema, keyed by `SectionType`.
 *
 * `satisfies` rather than a type annotation on purpose: the annotation would flatten every value to
 * `ZodTypeAny` and lose the per-type inference that `SectionPayloads` below is built from, while
 * `satisfies` still fails the build the moment a `SectionType` is added to the Prisma enum without a
 * schema here — which is exactly the mistake that would otherwise reach production as an error card.
 */
export const SECTION_SCHEMAS = {
  HERO: heroSectionSchema,
  RICH_TEXT: richTextSectionSchema,
  STATS: statsSectionSchema,
  FEATURE_GRID: featureGridSectionSchema,
  RESEARCH_SHOWCASE: researchShowcaseSectionSchema,
  PROJECT_SHOWCASE: projectShowcaseSectionSchema,
  PEOPLE_SHOWCASE: peopleShowcaseSectionSchema,
  PUBLICATION_LIST: publicationListSectionSchema,
  NEWS_SHOWCASE: newsShowcaseSectionSchema,
  EVENT_SHOWCASE: eventShowcaseSectionSchema,
  GALLERY: gallerySectionSchema,
  MEDIA_SPLIT: mediaSplitSectionSchema,
  TIMELINE: timelineSectionSchema,
  PARTNER_LOGOS: partnerLogosSectionSchema,
  QUOTE: quoteSectionSchema,
  CTA: ctaSectionSchema,
  FAQ: faqSectionSchema,
  CONTACT_FORM: contactFormSectionSchema,
  MAP: mapSectionSchema,
  EMBED: embedSectionSchema,
  DOWNLOADS: downloadsSectionSchema,
  CRAFT_EXPLORER: craftExplorerSectionSchema,
  SPACER: spacerSectionSchema,
  ACTION_STEPS: actionStepsSectionSchema,
  FORM_EMBED: formEmbedSectionSchema,
  LINK_GRID: linkGridSectionSchema,
  STORY_SCROLL: storyScrollSectionSchema,
  PARALLAX_BANNER: parallaxBannerSectionSchema,
  HORIZONTAL_RAIL: horizontalRailSectionSchema,
  PROCESS_STEPS: processStepsSectionSchema,
  PLATFORM_PILLARS: platformPillarsSectionSchema,
  INDIA_MAP: indiaMapSectionSchema,
  // One uploaded document — a PDF on the page, anything else as a download card. See its schema for
  // why it names a `MediaAsset` rather than a `FileAsset`.
  DOCUMENT_EMBED: documentEmbedSectionSchema
} satisfies Record<SectionType, z.ZodTypeAny>;

type SectionSchemas = typeof SECTION_SCHEMAS;

/** The parsed payload for each block type. */
export type SectionPayloads = { [K in SectionType]: z.infer<SectionSchemas[K]> };

/** The payload for one named block type — `SectionDataFor<"HERO">`. */
export type SectionDataFor<T extends SectionType> = SectionPayloads[T];

/**
 * Every block as a tagged pair, discriminated on `type`.
 *
 * This is the shape a renderer switches over: `switch (section.type)` narrows `section.data` to the
 * one payload, so a HERO renderer cannot read a field that only STATS has.
 */
export type SectionData = {
  [K in SectionType]: { type: K; data: SectionPayloads[K] };
}[SectionType];

export type HeroSectionData = SectionPayloads["HERO"];
export type RichTextSectionData = SectionPayloads["RICH_TEXT"];
export type StatsSectionData = SectionPayloads["STATS"];
export type FeatureGridSectionData = SectionPayloads["FEATURE_GRID"];
export type ResearchShowcaseSectionData = SectionPayloads["RESEARCH_SHOWCASE"];
export type ProjectShowcaseSectionData = SectionPayloads["PROJECT_SHOWCASE"];
export type PeopleShowcaseSectionData = SectionPayloads["PEOPLE_SHOWCASE"];
export type PublicationListSectionData = SectionPayloads["PUBLICATION_LIST"];
export type NewsShowcaseSectionData = SectionPayloads["NEWS_SHOWCASE"];
export type EventShowcaseSectionData = SectionPayloads["EVENT_SHOWCASE"];
export type GallerySectionData = SectionPayloads["GALLERY"];
export type MediaSplitSectionData = SectionPayloads["MEDIA_SPLIT"];
export type TimelineSectionData = SectionPayloads["TIMELINE"];
export type PartnerLogosSectionData = SectionPayloads["PARTNER_LOGOS"];
export type QuoteSectionData = SectionPayloads["QUOTE"];
export type CtaSectionData = SectionPayloads["CTA"];
export type FaqSectionData = SectionPayloads["FAQ"];
export type ContactFormSectionData = SectionPayloads["CONTACT_FORM"];
export type MapSectionData = SectionPayloads["MAP"];
export type EmbedSectionData = SectionPayloads["EMBED"];
export type DownloadsSectionData = SectionPayloads["DOWNLOADS"];
export type CraftExplorerSectionData = SectionPayloads["CRAFT_EXPLORER"];
export type SpacerSectionData = SectionPayloads["SPACER"];
export type ActionStepsSectionData = SectionPayloads["ACTION_STEPS"];
export type FormEmbedSectionData = SectionPayloads["FORM_EMBED"];
export type LinkGridSectionData = SectionPayloads["LINK_GRID"];
export type StoryScrollSectionData = SectionPayloads["STORY_SCROLL"];
export type ParallaxBannerSectionData = SectionPayloads["PARALLAX_BANNER"];
export type HorizontalRailSectionData = SectionPayloads["HORIZONTAL_RAIL"];
export type ProcessStepsSectionData = SectionPayloads["PROCESS_STEPS"];
export type PlatformPillarsSectionData = SectionPayloads["PLATFORM_PILLARS"];
export type IndiaMapSectionData = SectionPayloads["INDIA_MAP"];
export type DocumentEmbedSectionData = SectionPayloads["DOCUMENT_EMBED"];

/** One step out of an ACTION_STEPS block, for a component that renders a single row. */
export type ActionStep = ActionStepsSectionData["steps"][number];
/** One card out of a LINK_GRID block. */
export type LinkGridItem = LinkGridSectionData["items"][number];
/** One chapter of a STORY_SCROLL block, for the component that renders a single one. */
export type StoryChapter = StoryScrollSectionData["chapters"][number];
/** One card out of a HORIZONTAL_RAIL block. */
export type HorizontalRailItem = HorizontalRailSectionData["items"][number];
/** One stage of a PROCESS_STEPS block. */
export type ProcessStep = ProcessStepsSectionData["steps"][number];

/**
 * Every block type, derived from the registry rather than written out again.
 *
 * A second hand-written list is a list that drifts; this one cannot, because the registry above is
 * exhaustive by construction.
 */
export const SECTION_TYPES = Object.keys(SECTION_SCHEMAS) as SectionType[];

/** The block type as a Zod enum, for route handlers validating a `type` off the wire. */
export const sectionTypeSchema = z
  .enum(SECTION_TYPES as [SectionType, ...SectionType[]])
  .describe("Which sort of block this is.");

export function isSectionType(value: unknown): value is SectionType {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SECTION_SCHEMAS, value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

export type SectionParseResult<T extends SectionType> =
  | { ok: true; data: SectionPayloads[T] }
  | { ok: false; message: string; fieldErrors: Record<string, string[]> };

/**
 * Validate a payload against the schema for its type.
 *
 * Returns a result rather than throwing because both callers want the failure as data: the route
 * handler turns it into a 422 body, and the studio's block editor renders it under the offending
 * field while the editor keeps working. A throw would force the studio to wrap every keystroke.
 *
 * `null`/`undefined` are read as an empty object, not as a failure. Every field has a default, so an
 * empty payload parses into the complete default block — which is what a `Json` column holding
 * `{}` (the Prisma default for `PageSection.data`) should mean.
 */
export function parseSectionData<T extends SectionType>(
  type: T,
  data: unknown
): SectionParseResult<T> {
  // Widened to `ZodTypeAny` deliberately: indexing the registry with a generic key gives TypeScript a
  // union of 26 schema types, and calling `safeParse` on that union is a fight not worth having. The
  // cast on the way out restates the guarantee the registry's key already makes.
  const schema: z.ZodTypeAny | undefined = SECTION_SCHEMAS[type];

  // `type` is typed as a `SectionType`, but this function is on the boundary — the value regularly
  // arrives from a request body. An unknown type is a message, never a crash.
  if (!schema) {
    return {
      ok: false,
      message: `"${String(type)}" is not a sort of block this site knows how to render.`,
      fieldErrors: {}
    };
  }

  const result = schema.safeParse(data ?? {});
  if (result.success) {
    return { ok: true, data: result.data as SectionPayloads[T] };
  }

  return { ok: false, ...describeIssues(result.error) };
}

/**
 * A Zod failure as one readable sentence plus per-field messages.
 *
 * Deliberately the same shape and the same wording strategy as `describeZodError` in `lib/api.ts` —
 * the sentence NAMES THE FIRST FIELD, because a banner that does not say which box is wrong sends the
 * reader hunting through a twenty-field form. It is duplicated rather than imported because
 * `lib/api.ts` is `server-only` and the studio validates in the browser.
 */
function describeIssues(error: z.ZodError): {
  message: string;
  fieldErrors: Record<string, string[]>;
} {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : "_form";
    (fieldErrors[path] ??= []).push(issue.message);
  }

  const first = error.issues[0];
  if (!first) {
    return { message: "Some of the values in this block could not be saved.", fieldErrors };
  }

  const where = first.path.length > 0 ? `${first.path.join(" → ")}: ` : "";
  const others = error.issues.length - 1;
  const tail = others > 0 ? ` (and ${others} other problem${others === 1 ? "" : "s"})` : "";
  return { message: `${where}${first.message}${tail}`, fieldErrors };
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults for a freshly dropped block
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The seed text a new block starts with.
 *
 * Only the fields that would otherwise leave a visible hole are listed; everything else comes from
 * the schema's own defaults. Two kinds of seed text, and the difference is intentional:
 *
 *   • text that MUST be replaced reads as an instruction — "Add a headline" is obviously not copy;
 *   • text that is already correct stays as ordinary prose — a projects block headed "Projects"
 *     needs no editing at all, and inventing an instruction there would be busywork.
 *
 * The point of the whole table is §6 and the note on `PageSection.data`: a block a builder has just
 * dropped must render as something obviously editable, never as an error card and never as a blank
 * gap that looks like a bug in the page.
 */
const SECTION_PLACEHOLDERS: Partial<{ [K in SectionType]: z.input<SectionSchemas[K]> }> = {
  /*
   * ⚠ NO `primaryCta` SEED, AND THE REASON GENERALISES — see the same removal on CTA below.
   *
   * It used to read `{ label: "Add a button", href: "" }`, and that prompt could NEVER be rendered:
   * `cta()` above says a button is drawn only once it has both words and a link, and every renderer
   * enforces it (HeroSection, CtaSection). So the string had exactly one destination — a stored
   * payload — where it sat invisibly in every hero anybody made.
   *
   * That was harmless until `pagePublishBlockers()` in lib/pages.ts began refusing to publish a page
   * carrying a prompt, at which point it became actively hostile: an editor who wrote a headline and a
   * standfirst and never wanted a button would be refused, and told the block "still says Add a
   * button", about a button that is not on the page and never was. A gate that fires on something the
   * reader cannot see is a gate people learn to route around.
   *
   * The prompt is not lost, it has moved to where it belongs: the studio's hero form renders a
   * labelled, always-visible "Button text" control with its own help sentence from `cta()`. A form
   * placeholder is a property of the FORM. Putting it in the DOCUMENT means the document is wrong
   * until somebody notices.
   *
   * HERO is still judged unfinished by `lib/health.ts` — `headline` and `body` below keep prompts, and
   * that check needs only one.
   */
  HERO: {
    headline: "Add a headline",
    body: "Add a sentence or two about what this page is for."
  },
  RICH_TEXT: {
    body: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Write the text for this section." }]
        }
      ]
    }
  },
  /*
   * ⚠ `value` WAS `"0"`, AND THAT ONE CHARACTER IS WHY THE HOMEPAGE PUBLISHED FOUR FALSEHOODS.
   *
   * Every other seed in this map obeys the rule stated above: text that must be replaced READS AS AN
   * INSTRUCTION, so publishing it is embarrassing enough that somebody notices. "0" reads as a
   * finished statistic. It survived the studio, the seed, a review and a deployment, and it appeared
   * on the front page as "0 Crafts documented" beside a database holding forty-two of them — because
   * nothing about it looked unfinished to anybody, including to `lib/health.ts`, whose "not filled in"
   * check searches for exactly the prompt-shaped strings that "0" is not.
   *
   * "Add a figure" is the same string in the same field doing the job the field's neighbours already
   * do: it is visibly not a statistic, it is caught by `sectionPlaceholderPrompts` below, and it is
   * therefore refused at publication by `pagePublishBlockers` in lib/pages.ts. A block dropped into
   * the builder still renders three visible figures, so the shape of the block is still obvious —
   * which is the whole reason this map exists.
   */
  STATS: {
    heading: "Add a heading",
    items: [
      { label: "Add a label", value: "Add a figure", suffix: "", description: "" },
      { label: "Add a label", value: "Add a figure", suffix: "", description: "" },
      { label: "Add a label", value: "Add a figure", suffix: "", description: "" }
    ]
  },
  FEATURE_GRID: {
    heading: "Add a heading",
    items: [
      { icon: "", title: "Add a title", body: "Add a line or two about this.", href: "" },
      { icon: "", title: "Add a title", body: "Add a line or two about this.", href: "" },
      { icon: "", title: "Add a title", body: "Add a line or two about this.", href: "" }
    ]
  },
  RESEARCH_SHOWCASE: { heading: "Research areas", ctaLabel: "See all research", ctaHref: "/research" },
  PROJECT_SHOWCASE: { heading: "Projects", ctaLabel: "See all projects", ctaHref: "/projects" },
  PEOPLE_SHOWCASE: { heading: "People", ctaLabel: "Meet the team", ctaHref: "/people" },
  PUBLICATION_LIST: {
    heading: "Publications",
    ctaLabel: "See all publications",
    ctaHref: "/publications"
  },
  NEWS_SHOWCASE: { heading: "News", ctaLabel: "Read all news", ctaHref: "/news" },
  EVENT_SHOWCASE: { heading: "Events", ctaLabel: "See all events", ctaHref: "/events" },
  GALLERY: { heading: "Gallery", ctaLabel: "Open the gallery", ctaHref: "/gallery" },
  MEDIA_SPLIT: {
    heading: "Add a heading",
    body: "Add the text that sits beside the picture."
  },
  TIMELINE: {
    heading: "Add a heading",
    entries: [
      { year: "Add a date", title: "Add what happened", body: "", mediaId: "" },
      { year: "Add a date", title: "Add what happened", body: "", mediaId: "" }
    ]
  },
  PARTNER_LOGOS: { heading: "Our partners" },
  QUOTE: {
    quote: "Add the words that were said.",
    attribution: "Add a name",
    role: "Add their position"
  },
  // No `primaryCta` seed, for the reason set out on HERO above: a button prompt with no link can never
  // be rendered, so it could only ever leak into a stored payload and block publication for a block
  // that is finished. `heading` and `body` keep their prompts, so this type is still judged unfinished.
  CTA: {
    heading: "Add an invitation",
    body: "Add a line about what happens next."
  },
  FAQ: {
    heading: "Questions and answers",
    items: [
      { question: "Add a question", answer: "Add the answer." },
      { question: "Add a question", answer: "Add the answer." }
    ]
  },
  CONTACT_FORM: {
    heading: "Get in touch",
    body: "Add a line about how long a reply usually takes.",
    successMessage: "Thank you. Your message has reached us and we will reply by email."
  },
  MAP: { heading: "Find us", address: "Add the postal address" },
  EMBED: { title: "Add a description of this video" },
  DOWNLOADS: { heading: "Downloads" },
  CRAFT_EXPLORER: { heading: "Craft explorer", ctaLabel: "Open the explorer", ctaHref: "/craft-explorer" },
  ACTION_STEPS: {
    heading: "How to apply",
    body: "Add a line saying who this is for and when it closes.",
    /*
     * Three filled steps rather than one: a checklist with a single row does not look like a checklist,
     * and an editor shown three understands immediately that rows are added and removed.
     *
     * ⚠ THIS COMMENT USED TO CLAIM "the first carries a button so the shape of a step that leads
     * somewhere is visible", and it never did — all three have carried `href: ""` and `ctaLabel: ""`
     * since the block was written, and `ActionStepsSection` draws the button only where `href` is set.
     * A comment stating a rule the code below does not keep is a bug in this repository, so it is
     * corrected here rather than the code being changed to match it: seeding a working `href` would be
     * seeding somebody else's URL, which the FORM_EMBED note below refuses for exactly this reason, and
     * seeding a `ctaLabel` with no `href` would be an unrenderable prompt of the kind removed from HERO
     * and CTA above.
     *
     * No step carries a deadline either, and that one is deliberate: a made-up date in an instruction
     * is worse than no date.
     */
    steps: [
      {
        title: "Add the first step",
        detail: "Add what the reader has to do.",
        href: "",
        ctaLabel: "",
        deadline: "",
        status: ""
      },
      {
        title: "Add the second step",
        detail: "Add what the reader has to do.",
        href: "",
        ctaLabel: "",
        deadline: "",
        status: ""
      },
      {
        title: "Add the third step",
        detail: "Add what the reader has to do.",
        href: "",
        ctaLabel: "",
        deadline: "",
        status: ""
      }
    ]
  },
  // No seed URL, deliberately. Any address here would be somebody else's form, and a placeholder that
  // works is a placeholder that gets published. The title is seeded because it is the block's heading
  // and the frame's only description; the renderer says plainly that no form has been chosen yet.
  FORM_EMBED: { title: "Add a description of this form" },
  LINK_GRID: {
    heading: "Guidelines and forms",
    items: [
      { label: "Add a link", description: "Add a line about what this is.", href: "", icon: "", external: false },
      { label: "Add a link", description: "Add a line about what this is.", href: "", icon: "", external: false },
      { label: "Add a link", description: "Add a line about what this is.", href: "", icon: "", external: false }
    ]
  },

  /*
   * The narrative blocks.
   *
   * ⚠ THE SEEDED PHOTOGRAPHS ARE REAL ONES, and that is a deliberate departure from every other seed
   * in this map. Elsewhere a placeholder is a prompt in words ("Add a headline") precisely so that
   * publishing it is embarrassing enough to notice. These three blocks are the ones whose whole
   * point is the photograph, and a story block seeded with three grey rectangles does not show an
   * editor what they have just added — it shows them something broken, and the commonest response
   * to that is to delete the block.
   *
   * It is safe here in a way it would not be for a hero's headline, because these photographs are
   * committed to the repository under free licences with their attribution compiled in: a seeded
   * picture that reaches the public site is a correctly credited photograph of an Indian craft on
   * the website of a centre for Indian crafts. The WORDS are still prompts, so `lib/health.ts` still
   * finds an unfinished block on a published page and says so.
   */
  STORY_SCROLL: {
    heading: "Add the title of this story",
    body: "Add a sentence setting the story up.",
    chapters: [
      {
        kicker: "One",
        title: "Add the first chapter",
        body: "Add two or three short paragraphs. Leave a blank line between them.",
        craftImage: "block-print",
        caption: "Replace this photograph with one of your own."
      },
      {
        kicker: "Two",
        title: "Add the second chapter",
        body: "Add two or three short paragraphs. Leave a blank line between them.",
        craftImage: "handloom",
        caption: "Replace this photograph with one of your own."
      },
      {
        kicker: "Three",
        title: "Add the third chapter",
        body: "Add two or three short paragraphs. Leave a blank line between them.",
        craftImage: "kolam",
        caption: "Replace this photograph with one of your own."
      }
    ]
  },
  PARALLAX_BANNER: {
    heading: "Add a line across the photograph",
    body: "Add a sentence under it.",
    craftImage: "jaali"
  },
  HORIZONTAL_RAIL: {
    heading: "Add a heading",
    body: "Add a sentence or two under the heading.",
    items: [
      { title: "Add a card", meta: "Where it is from", detail: "Add a line about it.", craftImage: "bandhani" },
      { title: "Add a card", meta: "Where it is from", detail: "Add a line about it.", craftImage: "dhokra" },
      { title: "Add a card", meta: "Where it is from", detail: "Add a line about it.", craftImage: "pattachitra" },
      { title: "Add a card", meta: "Where it is from", detail: "Add a line about it.", craftImage: "blue-pottery" }
    ]
  },
  PROCESS_STEPS: {
    heading: "How it is made",
    steps: [
      { title: "Add the first stage", detail: "Add what happens at this stage.", meta: "", craftImage: "khurja-pottery" },
      { title: "Add the second stage", detail: "Add what happens at this stage.", meta: "", craftImage: "kalamkari" },
      { title: "Add the third stage", detail: "Add what happens at this stage.", meta: "", craftImage: "zardozi" }
    ]
  },
  // Only the heading, because only the header IS content on this block: the three instruments below
  // it are fixed designed vignettes, complete the moment the block is dropped. The prompt keeps the
  // block visibly unfinished to lib/health.ts and lib/pages.ts until somebody heads it or clears it.
  PLATFORM_PILLARS: {
    heading: "Add a heading"
  },
  // No `mediaId` seed, for the same reason FORM_EMBED has no seeded address: there is no document
  // this block could point at that would not be somebody else's, and a placeholder that works is a
  // placeholder that gets published. The title is seeded because it is both the visible heading and
  // the frame's only description, and the renderer states plainly that no document has been chosen.
  DOCUMENT_EMBED: { title: "Add a description of this document" }
  // SPACER needs no seed: its only field has a default and empty is what it is for.
};

/**
 * A valid, minimal, obviously-editable payload for a newly added block.
 *
 * Built by PARSING the seed rather than by writing an object literal, so the returned value cannot
 * drift out of agreement with the schema: if a seed were wrong, this would fail loudly here rather
 * than quietly produce a block that fails validation the first time it autosaves.
 *
 * Returns a fresh object every call. The studio mutates what it is given, and handing out the shared
 * constant would let one edited block rewrite the default for every block added afterwards.
 */
export function defaultSectionData(type: SectionType): unknown {
  const schema: z.ZodTypeAny | undefined = SECTION_SCHEMAS[type];
  if (!schema) return {};

  const seed = SECTION_PLACEHOLDERS[type];
  const seeded = schema.safeParse(seed ?? {});
  if (seeded.success) return seeded.data;

  // A seed that does not satisfy its own schema is a programming error, not an editor's. It is
  // logged and stepped over rather than thrown: refusing to add a block would strand a builder mid
  // page for a mistake they cannot see or fix.
  console.error(`[sections] the placeholder for ${type} does not match its schema`, seeded.error);
  return schema.parse({});
}

// ─────────────────────────────────────────────────────────────────────────────
// The placeholder vocabulary — the one list of words that must never be published
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The words the studio puts in a block so an editor knows what to type, collected so that nothing
 * downstream has to guess at them.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS EXPORTED RATHER THAN RE-DERIVED BY EACH CONSUMER.
 *
 * Four files need to know this list and they must not be allowed to disagree:
 *
 *   • `pagePublishBlockers()` in lib/pages.ts, which refuses to publish a page still carrying one;
 *   • the health report in lib/health.ts, which names the blocks that still carry one;
 *   • prisma/seed.ts, which reports one that is about to be copied into the site's own search corpus
 *     and refuses to repair a block whose words are somebody's rather than the studio's;
 *   • scripts/smoke.ts, which reports one that a visitor is already being served.
 *
 * A rule enforced by four separate copies of a regular expression is a rule that holds until one of
 * them is edited. Worse, a check that is WEAKER than the gate produces a page that cannot be
 * published and cannot be diagnosed. So the vocabulary is derived here, once, from
 * `SECTION_PLACEHOLDERS` — which is the only place the strings actually exist.
 *
 * ⚠ ALL FOUR NOW READ IT, AND THIS CENSUS IS RE-MEASURED RATHER THAN INHERITED. Two earlier versions of
 * this header were wrong in OPPOSITE directions — the first claimed every consumer imported these exports
 * when one of them did not, and the second went on describing that gap after it had been closed, which is
 * the more dangerous of the two because it invites the reader to close it again somewhere new. So the list
 * below is what a grep for the three export names returns today, per export, and re-running it is cheaper
 * than trusting it:
 *
 *   • `sectionPlaceholderPrompts()` — lib/health.ts:20, where `judgementFor()` uses it to decide whether a
 *     block type can be judged empty at all; and prisma/seed.ts:14, where `unrepairedStatsReason()` refuses
 *     to repair a STATS block whose heading is not one of these strings.
 *   • `placeholderPromptsIn()` — lib/pages.ts:12 (the gate itself) and prisma/seed.ts:13, where
 *     `repairPlaceholderProse()` prints the gate's own verdict on a stored row beside its own, so the two
 *     can be read side by side instead of being two opinions.
 *   • `allPlaceholderPrompts()` — prisma/seed.ts:4, where `seedSearchIndex()` runs it over the flattened
 *     text of every seeded page on every seed; and scripts/smoke.ts:50, where `promptsServedIn()` runs it
 *     over the HTML every public path actually serves.
 *
 * ⚠ WHICH OF THEM CAN REFUSE ANYTHING IS A NARROWER QUESTION, and the answer is ONE. `pagePublishBlockers()`
 * is called from `app/api/studio/pages/[id]/route.ts` (the PATCH, on the crossing into publication), which a
 * person presses and can therefore be refused by. It is ALSO called from
 * `pages/[id]/revisions/[version]/restore`, and ⚠ THAT SECOND CALL CANNOT FIRE ON ANY INPUT THIS BUILD
 * PRODUCES: it is guarded by `plannedSections !== null`, which needs a `sections` array inside a stored Page
 * revision, and no writer of one puts blocks there (see the ⚠ note on that condition in the restore route
 * for the whole mechanism, and the survey in `pagePublishBlockers`'s own header for every other crossing).
 * It is a guard kept for the day a snapshot carries blocks, not a live consumer, and counting it as one is
 * how a header overstates what is enforced. Everything else on the census REPORTS.
 *
 * ⚠ THE ONE-STRING DIVERGENCE THIS HEADER USED TO WARN ABOUT IS CLOSED, AND IT IS KEPT WRITTEN DOWN BECAUSE
 * IT IS THE EXACT FAILURE THESE EXPORTS EXIST TO PREVENT. `judgementFor()` in lib/health.ts once re-derived
 * its own list from `defaultSectionData(type)` with `/^(add|write)\b/i` — no `replace` — which made the
 * REPORT narrower than the GATE by exactly one string: STORY_SCROLL's "Replace this photograph with one of
 * your own.". A block carrying only that string would have been refused at publication and would not have
 * appeared on the health report, which is the undiagnosable failure. lib/health.ts:20 now IMPORTS
 * `sectionPlaceholderPrompts`, so the two can no longer disagree about which words count. Re-measured today
 * rather than carried over: the vocabulary is 45 strings, and that caption is still the only one of them a
 * `/^(add|write)\b/i` filter would drop — so `replace` is still load-bearing in the pattern below and
 * removing it would re-open the gap from the other end.
 *
 * ⚠ SHARING THE VOCABULARY IS NOT SHARING THE ANSWER, and reading it as such is the next mistake. The gate
 * walks the RAW payload with an uncapped walker; the report walks the PARSED payload with a walker that
 * stops at depth 12, so a prompt buried deeper than that is still refused there and unnamed here. The report
 * also applies a test the gate does not — a payload identical to the all-defaults `bare` document. Neither
 * is simply the stricter one, and `judgementFor()`'s own header says so from the other end.
 *
 * ⚠ `scripts/smoke.ts` NOW CARRIES THE PLACEHOLDER ASSERTION IT WAS ONCE MISSING, and the reason both it and
 * the seed's check exist is unchanged by that. The smoke assertion reads the HTML a visitor is actually
 * served; the seed's check reads the text on its way into the search index. They catch different failures —
 * a renderer that printed a prompt the payload does not literally contain would be caught only by the first,
 * and a prompt on a page no route renders (measured: /contact, whose blocks the static route shadows) would
 * be caught only by the second — so neither retires the other.
 *
 * ⚠ THE PATTERN BELOW SELECTS THE VOCABULARY. IT IS NEVER THE MATCH, AND THE DIFFERENCE IS NOT
 * COSMETIC. The seeded homepage carries a button reading **"Write to the Centre"** — finished,
 * deliberate, published copy that happens to begin with one of these verbs. A gate that tested every
 * string on a page against `/^(?:add|write|replace)\b/i` would refuse to publish the site's own front
 * page and would go on refusing it, with a message pointing at a button that is perfectly correct.
 * That is a worse failure than the one this whole mechanism exists to prevent, because it cannot be
 * fixed by editing the block.
 *
 * So the pattern runs ONLY over `SECTION_PLACEHOLDERS`, and every consumer then matches the resulting
 * STRINGS, never this pattern: exactly and trimmed where it holds a block's own payload (the gate, the
 * health report, the seed's STATS repair), and as a whole prompt sentence where all it holds is flattened
 * text or served markup (`promptsInIndexedText()` in the seed, `promptsServedIn()` in smoke — see the ⚠ on
 * `allPlaceholderPrompts()` below for why a substring test is safe there and only there). "Write the text
 * for this section." is in the vocabulary; "Write to the Centre" is not, can never be, and is safe forever.
 * `lib/health.ts` reaches the same verdict by the same means — `judgementFor()` there matches these exact
 * strings, now the ones this file exports — which is what made the one-string divergence above a divergence
 * rather than two unrelated checks, and what makes one shared import a real closure of it.
 *
 * Verified against the live database rather than reasoned about, and RE-MEASURED after the two repair passes
 * ran, because the example this paragraph used to give has since been mended. The homepage's CTA button
 * still reads "Write to the Centre" and still produces no blocker. The homepage's STATS block no longer
 * produces one either — `repairPlaceholderStats()` rewrote its heading to "What is in the archive today" —
 * and neither does /about, which `repairPlaceholderProse()` mended. What the gate names today is /contact:
 * "Add a line about how long a reply usually takes." on its CONTACT_FORM block and "Add the postal address"
 * on its MAP block, both still stored, both deliberately left (the static route at
 * app/(site)/contact/page.tsx shadows that page, so no reader sees either).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const PLACEHOLDER_PROMPT_PATTERN = /^(?:add|write|replace)\b/i;

/**
 * Every string anywhere inside a JSON value.
 *
 * Walks arrays and plain objects and ignores everything else. `lib/health.ts` has a twin of this;
 * it is a five-line walker rather than a shared import because this module is isomorphic (rule 1 at
 * the top of the file) and health.ts is `server-only`, so the dependency could only run one way.
 */
function collectStringsDeep(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") {
    into.push(value);
    return into;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStringsDeep(entry, into);
    return into;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectStringsDeep(entry, into);
  }
  return into;
}

/**
 * Computed once per block type and kept, because `defaultSectionData` parses a schema on every call
 * and the publish gate asks this question once per block on a page.
 */
const placeholderPromptCache = new Map<SectionType, readonly string[]>();

/**
 * The prompt strings a freshly dropped block of this type starts with.
 *
 * Empty for every block that fills itself from the studio — a projects block, a news block, an album
 * block — because those carry no words of their own and "no words" is their finished state, not an
 * unfinished one. That is exactly the test `lib/health.ts` applies to decide whether a block type can be
 * judged empty at all — by CALLING this function rather than by deriving the list a second time — and it is
 * why neither file needs a hand-written list of "self-contained" types that would rot the first time a block
 * was added.
 */
export function sectionPlaceholderPrompts(type: SectionType): readonly string[] {
  const cached = placeholderPromptCache.get(type);
  if (cached) return cached;

  const prompts = Array.from(
    new Set(
      collectStringsDeep(defaultSectionData(type))
        .map((value) => value.trim())
        .filter((value) => value.length > 0 && PLACEHOLDER_PROMPT_PATTERN.test(value))
    )
  ).sort();

  placeholderPromptCache.set(type, prompts);
  return prompts;
}

/**
 * The whole vocabulary, across every block type — for a test that has a page's HTML and no idea which
 * blocks built it.
 *
 * Sorted longest-first. A caller scanning rendered markup wants the most specific match to win: reporting
 * the longer string names the field an editor has to go and fix, while reporting a fragment of it would
 * send them looking for a second field that does not exist. ⚠ THAT ORDERING IS A GUARD RATHER THAN A LIVE
 * PATH TODAY, and both callers say so in the same words: measured over the 45 strings, no entry is currently
 * a substring of another ("Add a line about it." and "Add a line about what this is." share a prefix and
 * neither contains the other), so the de-duplication it enables never fires. It is kept because the
 * vocabulary is derived from `SECTION_PLACEHOLDERS`, where the day somebody writes a prompt that extends an
 * existing one costs nobody a thought.
 *
 * ⚠ ITS TWO CONSUMERS ARE `seedSearchIndex()` IN prisma/seed.ts AND THE PUBLIC-PAGE SCAN IN
 * scripts/smoke.ts, AND THE REASON BOTH ARE THE RIGHT SHAPE IS THE SENTENCE ABOVE. For two commits this
 * function had NO consumer at all — it was written for a smoke assertion nobody had added, and an earlier
 * version of this comment said so and left it there, which is this repository's signature defect (a thing
 * fully built, correct, and reached by nothing). That smoke assertion now exists (`promptsServedIn()`, run
 * over the body of every public path), but the consumer this function turned out to need FIRST was already
 * in the tree: the seed flattens each page through `sectionsToPlainText()` — a key allowlist over every
 * block, joined with spaces — and then has to ask "is any of the studio's own
 * prompt text about to become a search RESULT on this site", with the block boundaries gone and no way to
 * ask per type. That is exactly the shape this function answers and the reason it is sorted this way.
 *
 * ⚠ A CALLER MATCHES WHOLE STRINGS FROM THIS LIST, NEVER THE PATTERN THAT SELECTED THEM. Against
 * concatenated text a substring test is the only test available, and it is safe for precisely one reason:
 * every entry is a complete prompt sentence, so "Write the text for this section." cannot be found inside
 * the seeded homepage's finished CTA "Write to the Centre". See the header above; loosening that is how
 * this whole mechanism would end up refusing the site's own front page.
 */
export function allPlaceholderPrompts(): string[] {
  const every = new Set<string>();
  for (const type of Object.keys(SECTION_SCHEMAS) as SectionType[]) {
    for (const prompt of sectionPlaceholderPrompts(type)) every.add(prompt);
  }
  return [...every].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * The prompts a specific payload is STILL carrying — the question the publish gate actually asks.
 *
 * Exact, trimmed, case-sensitive matching against this type's own vocabulary. See the header for why
 * it may never be loosened into a pattern test.
 *
 * The payload is walked RAW rather than parsed, deliberately: a block whose data no longer satisfies
 * its schema is already refused elsewhere and must not also silently pass this check by failing to
 * parse.
 */
export function placeholderPromptsIn(type: SectionType, data: unknown): string[] {
  const vocabulary = sectionPlaceholderPrompts(type);
  if (vocabulary.length === 0) return [];

  const present = new Set(collectStringsDeep(data).map((value) => value.trim()));
  return vocabulary.filter((prompt) => present.has(prompt));
}
