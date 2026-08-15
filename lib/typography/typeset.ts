import { z } from "zod";

import { FONT_ROLE_LABELS, fontFace } from "@/lib/typography/fonts";

/**
 * The typesetting vocabulary — every named measure, leading, size and paragraph habit in ONE place,
 * together with the complete class strings that express them.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS, AND WHAT WAS ACTUALLY WRONG.
 *
 * A RICH_TEXT block offered `width` and `alignment` and nothing else, so a long passage on this site
 * was set by whatever `components/RichText.tsx` happened to hardcode per node. Four faults followed,
 * and none of them is fixed by adding a switch:
 *
 *  1. **A heading was stranded from its own text.** RichText gives a heading `mt-12` and no bottom
 *     margin, and gives every paragraph `mt-5`. So the gap ABOVE a heading was 48px and the gap
 *     BELOW it was 20px — the same 20px as between two ordinary paragraphs. A heading that is no
 *     closer to the sentence it introduces than to the one it follows floats between two blocks
 *     instead of belonging to one. `.prose-typeset` gives the heading the gap below it and zeroes the
 *     following block's own margin, which is the whole of the fix and the most visible thing here.
 *  2. **One leading, one size, for every passage.** `text-base leading-7` is a reasonable single
 *     answer and a poor answer for a two-line standfirst, a 4,000-word essay and a dense table of
 *     provenance notes on the same site.
 *  3. **No line-breaking care at all.** No `text-wrap`, so a headline broke one word onto its own
 *     line and a paragraph ended on a two-letter widow; no hanging punctuation; no hyphenation
 *     available even where an editor wanted a justified column.
 *  4. **Nothing an institution could set once.** Every block was on its own, so a house style existed
 *     only as a habit in the person typing.
 *
 * THREE MECHANISMS, AND THEY ARE DELIBERATELY NOT INTERCHANGEABLE.
 *
 *  • **Named steps live here** as unions, so a value that has no class cannot be chosen and a class
 *    that has no value cannot be written. Every lookup below is a `Record<Union, string>`, which is
 *    what makes the pairing a compile error rather than a missing style.
 *  • **The classes are COMPLETE LITERAL STRINGS.** `./lib` is inside the content globs, so the words
 *    in this file are what keeps the CSS in the build; a name assembled as `` `ts-lead-${x}` `` is
 *    purged and the style silently vanishes (contract §5).
 *  • **The rules themselves live in `app/globals.css`.** They have to: they set custom properties and
 *    override the per-node utilities RichText writes, which needs element selectors and specificity
 *    that no utility can express.
 *
 * INHERITANCE IS THE POINT, NOT AN EXTRA. Every per-block field defaults to `"inherit"`, which resolves
 * to the `typography` settings group — so an institution sets its house style once and an editor who
 * touches nothing gets it. `resolveTypeset()` is the only place that knows how the two combine.
 *
 * THE FACES COME FROM `lib/typography/fonts.ts` AND ARE NOT DESCRIBED AGAIN HERE. That file is
 * generated from the roster in `scripts/fetch-fonts.ts`, and it is the one place a face is named, sized,
 * licensed and — the part an editor reads — explained. Every label and every sentence in the two face
 * dropdowns is `face.family`, `face.purpose` and `face.cautions` read straight out of it, so a face
 * cannot be offered here under a different name from the one it has anywhere else in the studio.
 *
 * ⚠ And note `font-serif` in Tailwind is Plus Jakarta Sans, NOT a serif (contract §14). A serif is
 * reached only through a face id — `lora`, `crimson-pro`, `source-serif-4` — never through that class.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────────────────────
// The dimensions
//
// Each one is: a HOUSE enum (the concrete values), a BLOCK enum (the same plus `inherit`), the labels
// an administrator reads, and the class that expresses each concrete value. The `Record` keyed on the
// enum's own union is the tie — add a value and the build fails until it has a label and a class.
// ─────────────────────────────────────────────────────────────────────────────

/** What an option looks like in a studio dropdown. `note` is the sentence shown once it is chosen. */
export interface TypesetChoice {
  label: string;
  note: string;
}

/** Rendered against every per-block dropdown's first entry. Named once so all ten agree. */
export const INHERIT_LABEL = "Follow the site's house style";

// ── Reading face ─────────────────────────────────────────────────────────────

/**
 * ⚠ THE TWO LISTS BELOW MIRROR `lib/typography/fonts.ts`, WHICH IS GENERATED. Adding a face to the
 * roster does NOT add it here, and that is a deliberate cost rather than an oversight.
 *
 * Two things force it. Zod's `z.enum` needs a literal tuple, which no `.map()` over the roster can
 * produce; and the studio's SETTINGS screen draws a control by reading the schema's shape, so a face
 * field that were a free-form string would render as a text box asking an administrator to type
 * `crimson-pro`. A closed list is what makes it a dropdown.
 *
 * The lists are the roster's own `usage` filter written out: `bodyFaceEnum` is every face whose usage
 * includes `body`, `headingFaceEnum` every face whose usage includes `heading`. That is the filter that
 * stops a 68-character measure of body copy being set in a display serif.
 *
 * Nothing breaks if the roster moves out from under them: a stored id that no longer ships resolves to
 * `null` through `fontFace()`, the passage falls back to the site's own face, and the studio names the
 * id it could not find rather than showing a blank option.
 */
export const bodyFaceEnum = z.enum([
  "jakarta",
  "inter",
  "source-serif-4",
  "newsreader",
  "lora",
  "crimson-pro",
  "work-sans",
  "figtree",
  "jetbrains-mono"
]);
export type BodyFaceId = z.infer<typeof bodyFaceEnum>;

export const headingFaceEnum = z.enum([
  "jakarta",
  "inter",
  "work-sans",
  "figtree",
  "archivo-narrow",
  "source-serif-4",
  "newsreader",
  "lora",
  "crimson-pro",
  "fraunces",
  "playfair-display"
]);
export type HeadingFaceId = z.infer<typeof headingFaceEnum>;

export const blockFaceEnum = z.enum([
  "inherit",
  "jakarta",
  "inter",
  "source-serif-4",
  "newsreader",
  "lora",
  "crimson-pro",
  "work-sans",
  "figtree",
  "jetbrains-mono"
]);
export type BlockFace = z.infer<typeof blockFaceEnum>;

/**
 * One face, as a dropdown entry — its family name, its shelf, and the roster's own prose about it.
 *
 * `purpose` and `cautions` are already written to be shown to a person (fonts.ts says so), so they are
 * printed verbatim. A second description here would be a second opinion about a face, and the one an
 * editor happened to read would depend on which screen they were standing on.
 */
function faceChoice(id: string): TypesetChoice {
  if (id === "inherit") return { label: INHERIT_LABEL, note: "" };

  const face = fontFace(id);
  if (!face) {
    // Named rather than blanked: an id that no longer ships is a fact somebody has to act on, and an
    // empty option is one nobody can even report.
    return {
      label: id,
      note: `This face is no longer shipped with the site. The passage is set in the site's own face until another is chosen here.`
    };
  }

  return {
    label: `${face.family} — ${FONT_ROLE_LABELS[face.role]}`,
    note: face.cautions ? `${face.purpose} ${face.cautions}` : face.purpose
  };
}

function faceChoices<T extends string>(ids: readonly T[]): Record<T, TypesetChoice> {
  const out = {} as Record<T, TypesetChoice>;
  for (const id of ids) out[id] = faceChoice(id);
  return out;
}

export const FACE_CHOICES: Record<BlockFace, TypesetChoice> = faceChoices(blockFaceEnum.options);

export const HEADING_FACE_CHOICES: Record<HeadingFaceId, TypesetChoice> = faceChoices(
  headingFaceEnum.options
);

/**
 * The class that sets the BODY face is read off the roster (`face.fontClass`), which is already a
 * complete literal string in a scanned file — so a face added to the roster needs no class written
 * anywhere for the body to be set in it.
 *
 * This is the fallback for the two cases where that lookup comes back empty: an id that no longer
 * ships, and an id that never did. `font-sans` is Inter, which every page already loads.
 */
const FALLBACK_FACE_CLASS = "font-sans";

/**
 * The DISPLAY face has to be spelled out per face, and cannot be read off the roster.
 *
 * The headings inside a passage are drawn by `components/RichText.tsx`, so no class of ours reaches
 * them directly — the only way in is an arbitrary variant on the wrapper, and `[&_h2]:${fontClass}` is
 * a built string, which Tailwind purges (contract §5). So the variants are written out, per face, as
 * complete literals. `Record<HeadingFaceId, string>` is what makes a face added to the list above a
 * compile error until it has them.
 *
 * They land in the utilities layer at (0,1,1) — the same specificity as the recipe's own heading rule
 * in globals.css and later in the output, so they win without `!` (contract §5).
 *
 * ⚠ THE FOURTH SELECTOR IS THE PULL QUOTE, AND IT IS NOT A HEADING SELECTOR BY ACCIDENT. A pull quote
 * is display type — RichText sets it `font-display` on the element itself — so on a site whose headings
 * are Playfair it was the one large piece of type still speaking in Plus Jakarta Sans. It cannot be
 * reached as `[&_blockquote]`, which would also catch an ordinary quotation *inside* the argument, and
 * that one is body copy and must stay in the reading face. So RichText marks the pulled-out kind with
 * `data-pull-quote` and this matches the attribute: `.wrapper [data-pull-quote]` is (0,2,0), which
 * beats the element's own `font-display` at (0,1,0) without `!`.
 *
 * ⚠ THAT LAST SENTENCE WAS FALSE WHEN IT WAS WRITTEN, AND IS THE REASON THIS NOTE IS HERE. The
 * attribute is the studio editor's own HTML contract (`pullQuote.renderHTML` in
 * components/studio/editor/extensions.ts writes `blockquote[data-pull-quote]`, and its `parseHTML`
 * reads it back) — but `components/RichText.tsx`, the PUBLIC renderer, wrote classes and no
 * attributes, so this selector matched nothing on a published page and the display face never reached
 * a pull quote. RichText now emits the same four markers the editor defines. **If that ever stops
 * being true, every `[data-*]` selector in this file goes quietly dead again** — which is why the
 * markers are listed with their elements in `PROSE_NODE_HOOK_CLASS` below rather than assumed.
 */
const DISPLAY_FACE_CLASS: Record<HeadingFaceId, string> = {
  jakarta:
    "[&_h2]:font-display [&_h3]:font-display [&_h4]:font-display [&_[data-pull-quote]]:font-display",
  inter: "[&_h2]:font-sans [&_h3]:font-sans [&_h4]:font-sans [&_[data-pull-quote]]:font-sans",
  "work-sans":
    "[&_h2]:font-work-sans [&_h3]:font-work-sans [&_h4]:font-work-sans [&_[data-pull-quote]]:font-work-sans",
  figtree:
    "[&_h2]:font-figtree [&_h3]:font-figtree [&_h4]:font-figtree [&_[data-pull-quote]]:font-figtree",
  "archivo-narrow":
    "[&_h2]:font-archivo-narrow [&_h3]:font-archivo-narrow [&_h4]:font-archivo-narrow [&_[data-pull-quote]]:font-archivo-narrow",
  "source-serif-4":
    "[&_h2]:font-source-serif [&_h3]:font-source-serif [&_h4]:font-source-serif [&_[data-pull-quote]]:font-source-serif",
  newsreader:
    "[&_h2]:font-newsreader [&_h3]:font-newsreader [&_h4]:font-newsreader [&_[data-pull-quote]]:font-newsreader",
  lora: "[&_h2]:font-lora [&_h3]:font-lora [&_h4]:font-lora [&_[data-pull-quote]]:font-lora",
  "crimson-pro":
    "[&_h2]:font-crimson [&_h3]:font-crimson [&_h4]:font-crimson [&_[data-pull-quote]]:font-crimson",
  fraunces:
    "[&_h2]:font-fraunces [&_h3]:font-fraunces [&_h4]:font-fraunces [&_[data-pull-quote]]:font-fraunces",
  "playfair-display":
    "[&_h2]:font-playfair [&_h3]:font-playfair [&_h4]:font-playfair [&_[data-pull-quote]]:font-playfair"
};

// ── Measure (line length) ────────────────────────────────────────────────────

export const proseMeasureEnum = z.enum(["intimate", "standard", "generous", "wide", "full"]);
export type ProseMeasure = z.infer<typeof proseMeasureEnum>;

/** The house style cannot choose `full`: an unbounded line is a per-block escape, never a policy. */
export const houseMeasureEnum = z.enum(["intimate", "standard", "generous", "wide"]);
export type HouseMeasure = z.infer<typeof houseMeasureEnum>;

export const blockMeasureEnum = z.enum([
  "inherit",
  "intimate",
  "standard",
  "generous",
  "wide",
  "full"
]);
export type BlockMeasure = z.infer<typeof blockMeasureEnum>;

export const MEASURE_CHOICES: Record<BlockMeasure, TypesetChoice> = {
  inherit: {
    label: INHERIT_LABEL,
    note:
      "A narrow block takes the house measure. A wide block fills its column, because that is what " +
      "choosing Wide above asked for."
  },
  intimate: {
    label: "Intimate — about 54 characters",
    note: "A short line, for a passage set large or read slowly. Too narrow for a table."
  },
  standard: {
    label: "Standard — about 68 characters",
    note: "The site's reading width. Where the eye finds the start of the next line without hunting."
  },
  generous: {
    label: "Generous — about 78 characters",
    note: "A little wider, which suits prose full of long technical terms and Indian place names."
  },
  wide: {
    label: "Wide — about 88 characters",
    note: "As wide as a line can be before it becomes tiring. Use it for reference material."
  },
  full: {
    label: "Fill the column — no reading width",
    note:
      "No limit at all. Correct for a block that is mostly a wide table or a full-bleed picture, and " +
      "wrong for paragraphs — a line of 140 characters is one the eye loses its place in."
  }
};

const MEASURE_CLASS: Record<ProseMeasure, string> = {
  intimate: "ts-measure-intimate",
  standard: "ts-measure-standard",
  generous: "ts-measure-generous",
  wide: "ts-measure-wide",
  full: "ts-measure-full"
};

// ── Size ─────────────────────────────────────────────────────────────────────

export const proseSizeEnum = z.enum(["small", "standard", "large", "feature"]);
export type ProseSize = z.infer<typeof proseSizeEnum>;

export const blockSizeEnum = z.enum(["inherit", "small", "standard", "large", "feature"]);
export type BlockSize = z.infer<typeof blockSizeEnum>;

export const SIZE_CHOICES: Record<BlockSize, TypesetChoice> = {
  inherit: { label: INHERIT_LABEL, note: "" },
  small: {
    label: "Small",
    note: "For a note, a caveat or a list of conditions — anything that supports the page rather than being it."
  },
  standard: {
    label: "Standard",
    note: "The site's reading size: 16px on a phone, growing to 17px on a wide screen."
  },
  large: {
    label: "Large",
    note: "One step up, for the opening passage of a page or a short statement of intent."
  },
  feature: {
    label: "Feature",
    note:
      "Display size, up to 21px. It is meant for a standfirst of a few sentences; over a long passage " +
      "with headings in it the headings stop looking like headings."
  }
};

const SIZE_CLASS: Record<ProseSize, string> = {
  small: "ts-size-small",
  standard: "ts-size-standard",
  large: "ts-size-large",
  feature: "ts-size-feature"
};

// ── Leading (line spacing) ───────────────────────────────────────────────────

export const proseLeadingEnum = z.enum(["tight", "snug", "comfortable", "relaxed", "loose"]);
export type ProseLeading = z.infer<typeof proseLeadingEnum>;

export const blockLeadingEnum = z.enum([
  "inherit",
  "tight",
  "snug",
  "comfortable",
  "relaxed",
  "loose"
]);
export type BlockLeading = z.infer<typeof blockLeadingEnum>;

export const LEADING_CHOICES: Record<BlockLeading, TypesetChoice> = {
  inherit: { label: INHERIT_LABEL, note: "" },
  tight: {
    label: "Tight — 1.4",
    note: "Only for text set large. At reading size the lines run into one another."
  },
  snug: { label: "Snug — 1.55", note: "A dense column. Right for a short passage in a narrow measure." },
  comfortable: {
    label: "Comfortable — 1.7",
    note: "The site's reading leading, and the right answer for almost every passage."
  },
  relaxed: {
    label: "Relaxed — 1.85",
    note: "More air between lines. It helps a wide measure and it helps a reader with dyslexia."
  },
  loose: {
    label: "Loose — 2.0",
    note:
      "Very open. Genuinely easier for some readers; over a long passage it also stops a paragraph " +
      "reading as one block of text."
  }
};

const LEADING_CLASS: Record<ProseLeading, string> = {
  tight: "ts-lead-tight",
  snug: "ts-lead-snug",
  comfortable: "ts-lead-comfortable",
  relaxed: "ts-lead-relaxed",
  loose: "ts-lead-loose"
};

// ── Paragraph spacing ────────────────────────────────────────────────────────

export const proseSpacingEnum = z.enum(["tight", "standard", "open"]);
export type ProseSpacing = z.infer<typeof proseSpacingEnum>;

export const blockSpacingEnum = z.enum(["inherit", "tight", "standard", "open"]);
export type BlockSpacing = z.infer<typeof blockSpacingEnum>;

export const SPACING_CHOICES: Record<BlockSpacing, TypesetChoice> = {
  inherit: { label: INHERIT_LABEL, note: "" },
  tight: {
    label: "Tight",
    note: "Paragraphs close together, so a passage reads as one argument rather than a list of points."
  },
  standard: { label: "Standard", note: "The site's paragraph rhythm." },
  open: {
    label: "Open",
    note: "A clear pause between paragraphs. It suits a page somebody will skim before reading."
  }
};

const SPACING_CLASS: Record<ProseSpacing, string> = {
  tight: "ts-gap-tight",
  standard: "ts-gap-standard",
  open: "ts-gap-open"
};

// ── Paragraph style ──────────────────────────────────────────────────────────

export const proseParagraphStyleEnum = z.enum(["spaced", "indented"]);
export type ProseParagraphStyle = z.infer<typeof proseParagraphStyleEnum>;

export const blockParagraphStyleEnum = z.enum(["inherit", "spaced", "indented"]);
export type BlockParagraphStyle = z.infer<typeof blockParagraphStyleEnum>;

export const PARAGRAPH_STYLE_CHOICES: Record<BlockParagraphStyle, TypesetChoice> = {
  inherit: { label: INHERIT_LABEL, note: "" },
  spaced: {
    label: "Separated by space",
    note: "A gap between paragraphs, no indent. What a reader expects on a screen."
  },
  indented: {
    label: "First line indented",
    note:
      "No gap between paragraphs; each one after the first is indented instead, as a book is set. " +
      "Beautiful for a continuous essay, and wrong for anything a reader will scan — the paragraphs " +
      "stop being separable at a glance. The first paragraph of the passage, and the first after a " +
      "heading or a list, is never indented."
  }
};

const PARAGRAPH_STYLE_CLASS: Record<ProseParagraphStyle, string> = {
  // Nothing to add: the recipe's own paragraph spacing already IS the spaced setting. An empty string
  // here rather than a no-op class, so the rendered markup carries only classes that do something.
  spaced: "",
  indented: "ts-para-indented"
};

// ── How headings break ───────────────────────────────────────────────────────

export const proseHeadingWrapEnum = z.enum(["balance", "pretty", "plain"]);
export type ProseHeadingWrap = z.infer<typeof proseHeadingWrapEnum>;

export const blockHeadingWrapEnum = z.enum(["inherit", "balance", "pretty", "plain"]);
export type BlockHeadingWrap = z.infer<typeof blockHeadingWrapEnum>;

export const HEADING_WRAP_CHOICES: Record<BlockHeadingWrap, TypesetChoice> = {
  inherit: { label: INHERIT_LABEL, note: "" },
  balance: {
    label: "Balanced — even lines",
    note:
      "A heading that wraps is split into lines of similar length, so no single word is left alone on " +
      "the last line. The right answer for a heading of up to about ten words."
  },
  pretty: {
    label: "Tidy — avoid a lone last word",
    note:
      "Keeps the last line from holding one short word, without evening the lines up. Better than " +
      "Balanced for a long heading, which browsers stop balancing after a few lines anyway."
  },
  plain: {
    label: "Plain — break wherever it falls",
    note: "No line-breaking help at all. Choose it when you have written the breaks into the heading yourself."
  }
};

const HEADING_WRAP_CLASS: Record<ProseHeadingWrap, string> = {
  // `balance` is what `.prose-typeset` already applies to a heading, so the class list stays empty.
  balance: "",
  pretty: "ts-heading-pretty",
  plain: "ts-heading-plain"
};

/**
 * The same choice, for the block's OWN heading — which is a `SectionHeading`, outside the prose box.
 *
 * It maps onto the two utilities `globals.css` already publishes rather than a fourth `ts-` class, so
 * there is one implementation of "balance a heading" on the site.
 */
const SECTION_HEADING_WRAP_CLASS: Record<ProseHeadingWrap, string> = {
  balance: "text-balance",
  pretty: "text-pretty",
  plain: ""
};

// ── Pull quotes ──────────────────────────────────────────────────────────────

export const prosePullQuoteEnum = z.enum(["hanging", "inline"]);
export type ProsePullQuote = z.infer<typeof prosePullQuoteEnum>;

export const PULL_QUOTE_CHOICES: Record<ProsePullQuote, TypesetChoice> = {
  hanging: {
    label: "Hang the rule in the margin",
    note:
      "A quotation's vertical rule sits out in the margin and the quoted words line up with the rest " +
      "of the text. It is what makes a quotation look set rather than indented. On a narrow screen " +
      "there is no margin to hang into, so the quotation is indented there instead."
  },
  inline: {
    label: "Indent the quotation",
    note: "The rule and the quoted words are both indented from the text. Plainer, and never surprising."
  }
};

const PULL_QUOTE_CLASS: Record<ProsePullQuote, string> = {
  hanging: "ts-quote-hanging",
  inline: ""
};

// ── The three on/off habits ──────────────────────────────────────────────────

/**
 * A per-block switch has THREE states, not two.
 *
 * "Off" and "not set" are different answers: one refuses the house style, the other accepts it. A
 * boolean cannot hold that distinction, and a block that could only ever say "off" would silently
 * refuse a house style nobody had chosen yet.
 */
export const blockToggleEnum = z.enum(["inherit", "on", "off"]);
export type BlockToggle = z.infer<typeof blockToggleEnum>;

export const TOGGLE_CHOICES: Record<BlockToggle, TypesetChoice> = {
  inherit: { label: INHERIT_LABEL, note: "" },
  on: { label: "On", note: "" },
  off: { label: "Off", note: "" }
};

/** Complete literal class strings for the three habits. The "off" case is the absence of the class. */
const HYPHENS_CLASS = "ts-hyphens-on";
const JUSTIFY_CLASS = "ts-justify-on";
const DROPCAP_CLASS = "ts-dropcap";

export const HYPHENATION_NOTE =
  "Lets the browser break a long word across a line, using the page's language. It is what makes a " +
  "justified column possible and a narrow one tidy; without it a narrow measure ends up with rivers " +
  "of white space. Leave it off for a wide, ragged-right passage, where it only breaks words for no gain.";

export const JUSTIFY_NOTE =
  "Straightens the right-hand edge of every paragraph. It looks composed in a book and it fights on a " +
  "screen: unless hyphenation is on and the measure is Standard or wider, it opens gaps between words " +
  "that are worse than a ragged edge. It is ignored on centred and right-aligned text, where it means nothing.";

export const DROP_CAP_NOTE =
  "Sets the first letter of the passage over three lines, as a printed essay opens. It needs a first " +
  "paragraph of at least three or four lines to sit against, and it is ignored on centred and " +
  "right-aligned text, where a floated capital has nothing to align to.";

// ─────────────────────────────────────────────────────────────────────────────
// The two payloads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The HOUSE style: one object, the `typography` settings group.
 *
 * It lives here rather than in `lib/settings/schema.ts` for one reason — a leading of 1.7 and the class
 * that renders 1.7 must not be able to drift apart, and they cannot if they are written on the same
 * screen. `lib/settings/schema.ts` re-exports it as the group and owns the studio's wording for it.
 *
 * Every field has a `.default()`, per that file's first convention: a stored document written before a
 * field existed still parses and gains the new field's default.
 */
export const houseTypesetSchema = z.object({
  /*
   * ⚠ THE DEFAULT READING FACE IS A SERIF, AND THAT IS A DELIBERATE PRODUCT DECISION RATHER THAN A
   * TASTE ONE. It was `inter` — which meant twelve licensed faces shipped, were preloaded-or-not with
   * care, were licence-checked by `npm run font-check`, and then rendered on **not one page**. Every
   * article on the site read in the same UI sans it had always read in, and "the type library is
   * installed" is not the same claim as "the site is well set".
   *
   * Source Serif 4 is the right one of the ten to be the default, on the roster's own terms (read its
   * `purpose` in lib/typography/fonts.ts): it is a TEXT serif rather than a display serif, it holds up
   * at a body size where Playfair and Fraunces go pale and cramped, it carries a full 200–900 axis, and
   * it has a TRUE DRAWN ITALIC — which Inter does not, so until now every `<em>` in a published article
   * was a slant the browser invented by shearing the strokes. On a site that sets book titles, craft
   * names and Sanskrit terms in emphasis, that was the most-repeated typographic fault on the site.
   *
   * The HEADING face stays Plus Jakarta Sans. A serif body under a geometric sans heading is the
   * institutional pairing the roster names `institutional` and makes its default, and keeping the
   * headings put means this change is felt as "the prose reads better" rather than as a rebrand.
   *
   * It is one dropdown from being undone — Settings → Typesetting → Reading face — and a block can
   * still override it per passage. Nothing here is load-bearing for correctness: an id that stops
   * shipping resolves to `null` through `fontFace()` and falls back, as the note on the enums says.
   */
  bodyFace: bodyFaceEnum
    // Jakarta by the owner's decision — one voice from masthead to body copy. The serif options
    // remain one select away for an installation that wants its essays to read as documents.
    .default("jakarta")
    .describe("The face long passages of text are set in across the whole site."),
  headingFace: headingFaceEnum
    .default("jakarta")
    .describe("The face headings inside a passage are set in. A text block cannot override this."),
  measure: houseMeasureEnum
    .default("standard")
    .describe("How long a line of text is allowed to get before it wraps."),
  size: proseSizeEnum.default("standard").describe("The reading size for body text."),
  leading: proseLeadingEnum.default("comfortable").describe("The space between lines of text."),
  paragraphSpacing: proseSpacingEnum
    .default("standard")
    .describe("The space between one paragraph and the next."),
  paragraphStyle: proseParagraphStyleEnum
    .default("spaced")
    .describe("Whether paragraphs are separated by a gap or by an indented first line."),
  headingWrap: proseHeadingWrapEnum
    .default("balance")
    .describe("How a heading that is too long for one line is broken."),
  hyphenation: z.boolean().default(false).describe(HYPHENATION_NOTE),
  justify: z.boolean().default(false).describe(JUSTIFY_NOTE),
  dropCap: z.boolean().default(false).describe(DROP_CAP_NOTE),
  pullQuote: prosePullQuoteEnum
    .default("hanging")
    .describe("How a quotation inside a passage is set against the text around it.")
});

export type HouseTypeset = z.infer<typeof houseTypesetSchema>;

/** The house style with nothing configured — the fallback whenever the group cannot be read. */
export const HOUSE_TYPESET_DEFAULT: HouseTypeset = houseTypesetSchema.parse({});

/**
 * The PER-BLOCK overrides, stored on `PageSection.data.typeset`.
 *
 * ⚠ EVERY FIELD DEFAULTS TO `inherit`, and that is what makes this safe to add to a live site: a block
 * saved before this existed parses into an object of `inherit`s and renders exactly as the house style
 * says. There is no migration and no block that has to be visited.
 */
export const blockTypesetSchema = z.object({
  face: blockFaceEnum.default("inherit").describe("The face this passage is set in."),
  measure: blockMeasureEnum.default("inherit").describe("How long a line in this passage may get."),
  size: blockSizeEnum.default("inherit").describe("The reading size for this passage."),
  leading: blockLeadingEnum.default("inherit").describe("The space between lines in this passage."),
  paragraphSpacing: blockSpacingEnum
    .default("inherit")
    .describe("The space between paragraphs in this passage."),
  paragraphStyle: blockParagraphStyleEnum
    .default("inherit")
    .describe("Whether paragraphs here are separated by a gap or by an indented first line."),
  headingWrap: blockHeadingWrapEnum
    .default("inherit")
    .describe("How headings in this passage are broken across lines."),
  hyphenation: blockToggleEnum.default("inherit").describe(HYPHENATION_NOTE),
  justify: blockToggleEnum.default("inherit").describe(JUSTIFY_NOTE),
  dropCap: blockToggleEnum.default("inherit").describe(DROP_CAP_NOTE)
});

export type BlockTypeset = z.infer<typeof blockTypesetSchema>;

/** Every field on `inherit`. What an untouched block means, and what a broken payload falls back to. */
export const BLOCK_TYPESET_DEFAULT: BlockTypeset = blockTypesetSchema.parse({});

/**
 * Read the stored overrides out of whatever is on the payload.
 *
 * ⚠ `value ?? {}` IS LOAD-BEARING. Zod's `.default()` fires for a MISSING key and never for an explicit
 * `null` (contract §14), and this value comes out of a `jsonb` column where `null` is an ordinary thing
 * to find. Without the coalesce a null would fail validation and take the whole object to the fallback
 * — the same answer by a worse route, and one that would hide a real parse failure behind it.
 *
 * A payload that fails for any other reason falls back whole rather than field by field: these ten
 * fields describe one visual decision, and half of somebody's typesetting is not a typesetting.
 */
export function readBlockTypeset(value: unknown): BlockTypeset {
  const parsed = blockTypesetSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : BLOCK_TYPESET_DEFAULT;
}

/**
 * The overrides carried by a section payload, wherever the key has got to.
 *
 * ⚠ THIS CAST IS THE ONE PLACE THE `typeset` KEY IS REACHED WITHOUT THE TYPE SYSTEM'S HELP, and it is
 * here so it is nowhere else.
 *
 * `typeset: blockTypesetSchema.default({})` HAS since landed on `richTextSectionSchema`, so the key is
 * now genuinely stored and `TYPESET_STORED` in `RichTextForm` has flipped itself on. The index-signature
 * read stays anyway, deliberately: this helper is called with the payload of ANY section type, and only
 * RICH_TEXT carries the field. Typing the parameter to the rich-text payload would make it unusable for
 * the next block that wants typesetting; reading through an index signature works for every one of them
 * and returns the all-inherit default where the key is absent.
 */
export function typesetOf(payload: object): BlockTypeset {
  return readBlockTypeset((payload as Record<string, unknown>).typeset);
}

/** The same key, on the way back out. The counterpart of `typesetOf`, and the other half of the cast. */
export function withTypeset<T extends object>(payload: T, typeset: BlockTypeset): T {
  return { ...payload, typeset } as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

/** What a block actually gets, once its overrides have been read against the house style. */
export interface ResolvedTypeset {
  face: BodyFaceId;
  headingFace: HeadingFaceId;
  measure: ProseMeasure;
  size: ProseSize;
  leading: ProseLeading;
  paragraphSpacing: ProseSpacing;
  paragraphStyle: ProseParagraphStyle;
  headingWrap: ProseHeadingWrap;
  hyphenation: boolean;
  justify: boolean;
  dropCap: boolean;
  pullQuote: ProsePullQuote;
  /**
   * What an editor has to be told about these choices, each as a finished sentence.
   *
   * Two kinds, deliberately in one list because they need saying in one place: a choice that could NOT
   * be applied at all, and a choice that was applied and will read badly. A control that quietly does
   * nothing is the worst kind (contract §1.6). The studio form prints these under the fields; the
   * public renderer ignores them, because a visitor cannot act on them.
   */
  notices: readonly string[];
}

export interface ResolveTypesetOptions {
  /** The block's own overrides — `typesetOf(data)`. */
  block: BlockTypeset;
  /** The `typography` settings group. Pass `HOUSE_TYPESET_DEFAULT` when it cannot be read. */
  house: HouseTypeset;
  /** The block's `alignment`. Two habits are meaningless off a flush-left edge; see below. */
  alignment: "left" | "center" | "right";
  /** The block's `width`. It decides what an unset measure means; see `MEASURE_CHOICES.inherit`. */
  width: "narrow" | "wide";
}

function toggle(value: BlockToggle, house: boolean): boolean {
  if (value === "on") return true;
  if (value === "off") return false;
  return house;
}

/**
 * Combine the house style, the block's overrides and the two things the block already knew about
 * itself.
 *
 * THE TWO REFUSALS ARE DELIBERATE AND BOTH ARE ANNOUNCED.
 *
 *  • **A drop cap needs a flush left edge.** It is a floated letter, so on centred or right-aligned
 *    text the first lines wrap around a capital that is nowhere near the words it belongs to.
 *  • **Justification needs the same.** `text-align: justify` and `text-align: center` are the same
 *    property, so honouring both is impossible; centring is the one the editor can see they asked for.
 *
 * Silently dropping either would leave an editor looking at a switch they had thrown and a page that
 * ignored it, which is exactly the fault this whole file exists to remove.
 */
export function resolveTypeset({
  block,
  house,
  alignment,
  width
}: ResolveTypesetOptions): ResolvedTypeset {
  const flush = alignment === "left";
  const notices: string[] = [];

  const dropCapAsked = toggle(block.dropCap, house.dropCap);
  const justifyAsked = toggle(block.justify, house.justify);

  if (dropCapAsked && !flush) {
    notices.push(
      "The drop cap is not applied here: it is a letter that floats to the left of the first lines, " +
        "and this passage is not left-aligned."
    );
  }
  if (justifyAsked && !flush) {
    notices.push(
      "Justification is not applied here: text cannot be both justified and centred, and this passage " +
        "is centred or right-aligned."
    );
  }

  const measure: ProseMeasure =
    block.measure === "inherit" ? (width === "wide" ? "full" : house.measure) : block.measure;

  const hyphenation = toggle(block.hyphenation, house.hyphenation);
  const justify = justifyAsked && flush;

  if (justify && !hyphenation) {
    notices.push(
      "Justified text without hyphenation opens gaps between words. Turn hyphenation on as well, or " +
        "leave the right-hand edge ragged."
    );
  }

  return {
    face: block.face === "inherit" ? house.bodyFace : block.face,
    headingFace: house.headingFace,
    measure,
    size: block.size === "inherit" ? house.size : block.size,
    leading: block.leading === "inherit" ? house.leading : block.leading,
    paragraphSpacing:
      block.paragraphSpacing === "inherit" ? house.paragraphSpacing : block.paragraphSpacing,
    paragraphStyle:
      block.paragraphStyle === "inherit" ? house.paragraphStyle : block.paragraphStyle,
    headingWrap: block.headingWrap === "inherit" ? house.headingWrap : block.headingWrap,
    hyphenation,
    justify,
    dropCap: dropCapAsked && flush,
    pullQuote: house.pullQuote,
    notices
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Classes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE THREE BLOCKS THAT ARE NOT BODY TEXT, AND THE ONE THING THAT WAS CANCELLING THEM.
 *
 * `.prose-typeset :is(p, li) { font-size: var(--prose-size); line-height: var(--prose-leading) }` is
 * the rule that makes a passage read at the house size, and it is (0,1,1) — a class plus an element.
 * Every size `components/RichText.tsx` writes is a utility at (0,1,0), and a `sm:` variant adds no
 * specificity at all, because a media query never does. So the recipe won over all of them, and three
 * blocks whose whole purpose is to be a DIFFERENT size from the body were silently set at body size:
 *
 *  • **The lead paragraph** (`p[data-lead]`) — `text-lg sm:text-xl` → the house reading size. The
 *    standfirst was built, offered in the editor's Style menu, and indistinguishable from the
 *    paragraph after it on every page where the recipe was on. This is the literal first item in the
 *    owner's complaint about the typesetting of published pages.
 *  • **The pull quote** (`blockquote[data-pull-quote]`) — `text-2xl sm:text-3xl` → the (0,1,1) rule
 *    `.prose-typeset blockquote { font-size: calc(var(--prose-size) * 1.12) }`. A sentence lifted out
 *    of the argument and set 12% larger than the argument is not lifted out of anything.
 *  • **The side note** (`aside[data-side-note]`) — the `<aside>` keeps its own `text-sm` (the recipe
 *    does not target `aside`), and then the recipe dragged the PARAGRAPHS inside it back up to reading
 *    size, so a quiet aside was body copy with a hairline beside it.
 *
 * WHY THIS IS A LIST OF UTILITIES AND NOT FOUR MORE LINES IN `app/globals.css`. The recipe already
 * carries a rescue list — it calls them "the two islands the reading size must not flood" — and these
 * are the same idea. They are here instead because an ATTRIBUTE selector inside an arbitrary variant is
 * (0,2,0), which beats the recipe's (0,1,1) without `!` anywhere, and because the list of "what in a
 * document is not body text" then sits on the same screen as the class list that turns the recipe on.
 * ⚠ The alternative home is `.prose-typeset` itself in `app/globals.css`; if these are ever moved
 * there, MOVE them — a size declared in both places is two numbers that can drift.
 *
 * ⚠ THE VALUES DELIBERATELY MIRROR THE `article` SCALE IN `components/RichText.tsx`, which still sets
 * them on the elements themselves for the case where a document is rendered with no recipe around it
 * at all. A passage must not read differently inside and outside the recipe, so a change to that
 * file's `lead`, `pullQuote` or `sideNote` is a change to this constant. There is no way to share one
 * string: a class assembled as `` `[&_[data-lead]]:${size}` `` is built at run time, is not in the
 * source Tailwind scans, and is purged (contract §5).
 *
 * ⚠ AND EVERY MARKER HERE IS THE STUDIO EDITOR'S OWN, not invented for styling. `data-lead`,
 * `data-drop-cap`, `data-pull-quote`, `data-side-note` and `data-attribution` are what
 * `components/studio/editor/extensions.ts` writes in `renderHTML` and reads in `parseHTML`, so the
 * published HTML for these blocks is HTML the editor can parse back. One vocabulary, three files.
 *
 * THE LEAD'S SIZE IS `max()`, FOR THE REASON THE RECIPE'S `h4` GUARD IS. `--prose-size` is a house
 * choice and can be as large as 21px (Feature). A lead paragraph pinned to 1.125rem would then be
 * SMALLER than the body it introduces, which is the same fault as a heading smaller than its
 * paragraph. `1.18 ×` keeps the step proportional and the floor keeps it a step.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const PROSE_NODE_HOOK_CLASS = [
  // The lead paragraph — the standfirst.
  "[&_[data-lead]]:text-[max(1.125rem,calc(var(--prose-size,1.0625rem)*1.18))]",
  "[&_[data-lead]]:leading-[1.5]",
  "[&_[data-lead]]:text-ink-900",
  // The pull quote. Display sizes, so they are stock steps rather than a multiple of the reading size
  // — this is type set to be looked at rather than read, and it is the one place on a prose page where
  // a fixed size is the right answer.
  "[&_[data-pull-quote]]:my-10",
  "[&_[data-pull-quote]]:text-2xl",
  "sm:[&_[data-pull-quote]]:text-3xl",
  // ⚠ Its own paragraphs need both of these restated. `.prose-typeset blockquote :is(p, li)` is
  // (0,1,2) and sets `line-height: 1.55` for a READING-size quotation, which is loose at 30px; and
  // `.ts-justify-on :is(p, li)` would justify the words of a centred quote, because justification and
  // centring are the same property. (0,2,1) beats both.
  "[&_[data-pull-quote]_p]:text-center",
  "[&_[data-pull-quote]_p]:leading-snug",
  // The side note. `1em` is "the size my parent is", which is what the `<aside>`'s own `text-sm`
  // already decided — written as a length rather than `inherit` so there is no chance of Tailwind
  // reading it as a colour and dropping the class.
  "[&_[data-side-note]_p]:text-[1em]",
  "[&_[data-side-note]_p]:leading-[inherit]"
].join(" ");

/**
 * The READING FACE alone, as one complete literal class.
 *
 * `typesetClassName` below is the whole recipe and belongs on a box that contains a DOCUMENT. This is
 * for the several places on the site that set one paragraph, or a string of text that was never a
 * document at all, and must still be in the same face as the prose around them: a publication's
 * abstract, a citation, a plain-text biography written before the rich editor existed. Giving them the
 * full recipe would hand a `--prose-gap` and a heading rhythm to something with no headings in it.
 *
 * It reads `face.fontClass` off the generated roster — the one place a face's class is written — so a
 * face added to `lib/typography/fonts.ts` needs nothing here. `FALLBACK_FACE_CLASS` covers an id that
 * no longer ships, which resolves to `null` rather than throwing.
 */
export function typesetFaceClassName(resolved: ResolvedTypeset): string {
  return fontFace(resolved.face)?.fontClass ?? FALLBACK_FACE_CLASS;
}

/**
 * The complete class list for the element that WRAPS the rendered document.
 *
 * `.prose-typeset` is the recipe; every `ts-*` class re-points one custom property that the recipe
 * reads. They all sit on ONE element, which is what lets `app/globals.css` express the whole thing as
 * `.prose-typeset <element>` rules that outrank the per-node utilities `components/RichText.tsx`
 * writes — a `mt-5` is (0,1,0) and `.prose-typeset p` is (0,1,1), so the recipe wins without `!`.
 *
 * `.prose-measure` is included rather than restated: `--measure` stays the one number the whole site
 * uses for a reading width (contract §7), and the `ts-measure-*` classes only re-point it locally.
 */
export function typesetClassName(resolved: ResolvedTypeset): string {
  return [
    "prose-typeset",
    "prose-measure",
    typesetFaceClassName(resolved),
    DISPLAY_FACE_CLASS[resolved.headingFace],
    PROSE_NODE_HOOK_CLASS,
    MEASURE_CLASS[resolved.measure],
    SIZE_CLASS[resolved.size],
    LEADING_CLASS[resolved.leading],
    SPACING_CLASS[resolved.paragraphSpacing],
    PARAGRAPH_STYLE_CLASS[resolved.paragraphStyle],
    HEADING_WRAP_CLASS[resolved.headingWrap],
    PULL_QUOTE_CLASS[resolved.pullQuote],
    resolved.hyphenation ? HYPHENS_CLASS : "",
    resolved.justify ? JUSTIFY_CLASS : "",
    resolved.dropCap ? DROPCAP_CLASS : ""
  ]
    .filter((entry) => entry.length > 0)
    .join(" ");
}

/**
 * The measure alone, for an element that sits BESIDE the prose rather than inside it.
 *
 * The block's own heading is a `SectionHeading`, not a node in the document, so it does not inherit
 * the wrapper's custom properties — and a heading measured differently from the text under it is a
 * heading that visibly does not belong to it.
 */
export function typesetMeasureClassName(resolved: ResolvedTypeset): string {
  return `prose-measure ${MEASURE_CLASS[resolved.measure]}`;
}

/** True when the measure genuinely constrains the column, so a caller knows whether to centre it. */
export function typesetIsConstrained(resolved: ResolvedTypeset): boolean {
  return resolved.measure !== "full";
}

/**
 * The wrap treatment for the block's own heading, which is a sibling of the prose rather than inside it.
 *
 * Returns "" for `plain`, so a caller can pass it straight to `cn()` — which is a plain join and drops
 * falsy entries (contract §5).
 */
export function sectionHeadingWrapClass(resolved: ResolvedTypeset): string {
  return SECTION_HEADING_WRAP_CLASS[resolved.headingWrap];
}

/**
 * A one-line summary of what a block has overridden, for the studio.
 *
 * Counted rather than listed: the summary sits on a closed disclosure, and "3 changes" invites the
 * reader to open it while a list of three field names is a list they have to read twice.
 */
export function countTypesetOverrides(block: BlockTypeset): number {
  return Object.values(block).filter((value) => value !== "inherit").length;
}
