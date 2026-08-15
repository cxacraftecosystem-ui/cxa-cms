/**
 * Rich text — the stored document shape, and every read of it that is not rendering.
 *
 * The CMS stores Tiptap/ProseMirror JSON in `Json` columns (`Post.body`, `Person.bioRich`,
 * `Project.body`, `CoeEvent.body`, `Craft.body`, `ResearchArea.body`). This module is the only place
 * that knows that shape: components/RichText.tsx renders it, the search indexer flattens it, and the
 * studio editor writes it, all through here. One reader means "it looked different after publishing"
 * cannot happen.
 *
 * NO `"use client"`, NO `server-only`, NO dependency beyond lib/utils. The same document has to be
 * readable from a Server Component, from the studio preview and from a route handler, so nothing
 * here may touch the database, the filesystem or the DOM.
 *
 * THE TYPES ARE DELIBERATELY PERMISSIVE. A stored document can be older than the code reading it — a
 * node type that has since been renamed, an attribute that has since moved — and a strict
 * discriminated union over unvalidated `Json` is a promise the compiler would enforce and the data
 * would break. So `type` is a named union WIDENED to accept any string: the names exist for
 * autocomplete and for the renderer's switch, not as a guarantee, and every consumer must handle a
 * type it does not recognise.
 */

import { clamp, slugify, truncateWords } from "@/lib/utils";

/**
 * Widen a literal union to any string without collapsing it, so an editor still offers the known
 * values. Spelled with `Record<never, never>` rather than the more familiar `{}` because the shared
 * lint config's `no-empty-object-type` rule objects to the latter.
 */
type LooseLiteral<T extends string> = T | (string & Record<never, never>);

/** Every node type the editor can produce. `text` is ProseMirror's leaf and is not editor-selectable. */
export const RICH_TEXT_NODE_TYPES = [
  "doc",
  "paragraph",
  "text",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "hardBreak",
  "image",
  "table",
  "tableRow",
  "tableHeader",
  "tableCell",
  // Custom nodes registered by the studio editor's extension set. Each one is drawn by a branch in
  // components/RichText.tsx and flattened by a case below — see the header of extensions.ts.
  "callout",
  "footnote",
  /** A standfirst: the larger opening paragraph that sits under a title. */
  "leadParagraph",
  /** A paragraph whose first letter is set as a drop cap. */
  "dropCap",
  /** A display quote lifted OUT of the argument, as opposed to `blockquote`, which sits inside it. */
  "pullQuote",
  /** "— Kamala Devi, master dyer". Legal at the end of a `blockquote` or a `pullQuote`. */
  "attribution",
  /** A quiet note beside the argument. Smaller and greyer than a quote, unboxed unlike a callout. */
  "sideNote",
  "definitionList",
  "definitionTerm",
  "definitionDetails",
  /** A passage set in two or three newspaper columns. */
  "columns",
  /** A picture with an EDITABLE caption. A bare `image` still renders — see `renderImage`. */
  "figure",
  "figureCaption"
] as const;

export type RichTextNodeType = (typeof RICH_TEXT_NODE_TYPES)[number];

export const RICH_TEXT_MARK_TYPES = [
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
  "link",
  "subscript",
  "superscript",
  "highlight",
  /** `font-variant-caps: small-caps` — for an acronym or a period name inside running prose. */
  "smallCaps",
  /** Letter spacing, from a closed list of three. Carries `amount`. */
  "tracking",
  /**
   * Text colour from the BRAND RAMP ONLY. Carries `value`, one of `TEXT_COLOURS`.
   *
   * ⚠ DELIBERATELY NOT NAMED `color`, and deliberately not Tiptap's own `textStyle` + `Color`
   * pairing (which is not a dependency here). That pair stores an arbitrary CSS colour, which is
   * exactly what contract §1.1 forbids: purple-700 is the only action colour and every neutral must
   * go through the themed ink ladder, so a free hex would put unreadable lime green on an
   * institutional page and would not invert under `data-theme="dark"`. The distinct name keeps the
   * difference visible in the stored JSON, so nobody later mistakes one for the other.
   */
  "textColour"
] as const;

export type RichTextMarkType = (typeof RICH_TEXT_MARK_TYPES)[number];

/** Callout tones. Each one carries an icon and a word as well as a colour (contract §11). */
export const CALLOUT_TONES = ["note", "tip", "warning", "danger"] as const;
export type CalloutTone = (typeof CALLOUT_TONES)[number];

/** The document's own heading ladder, 1–4. What HTML tag that becomes is the renderer's decision. */
export type RichTextHeadingLevel = 1 | 2 | 3 | 4;

export interface RichTextMark {
  type: LooseLiteral<RichTextMarkType>;
  attrs?: Record<string, unknown>;
}

export interface RichTextNode {
  type: LooseLiteral<RichTextNodeType>;
  attrs?: Record<string, unknown>;
  content?: RichTextNode[];
  marks?: RichTextMark[];
  /** Present only on `text` nodes. */
  text?: string;
}

export interface RichTextDoc extends RichTextNode {
  type: "doc";
  content: RichTextNode[];
}

export interface RichTextHeading {
  /** Slugified, made unique across the document — the anchor the renderer puts on the heading. */
  id: string;
  level: RichTextHeadingLevel;
  text: string;
}

export interface RichTextImage {
  /** Storage key of a media-library asset. Preferred; `mediaSrc()` resolves it to a URL. */
  objectKey: string | null;
  /** An already-resolved URL, for documents imported from elsewhere. */
  src: string | null;
  /** Null means "no alt was recorded", which is NOT the same as the deliberate empty alt of a
   *  decorative image — `mediaAlt()` collapses both to `""` at the point of rendering. */
  altText: string | null;
  caption: string | null;
  width: number | null;
  height: number | null;
  blurDataUrl: string | null;
}

export interface RichTextLink {
  href: string | null;
  title: string | null;
}

/**
 * How deep a document may nest before children are dropped.
 *
 * JSON cannot be cyclic, so this is not a loop guard — it is a stack guard. A pathological document
 * (a paste from a spreadsheet, a corrupted import) can nest hundreds of levels, and the walk below,
 * plus React's own recursion over the result, would overflow the stack and take down the whole page
 * rather than one block. Forty is far past any prose anyone writes.
 */
const MAX_NODE_DEPTH = 40;

/**
 * Node types whose siblings are separated by a newline when flattened to plain text.
 *
 * ⚠ A NEW BLOCK NODE THAT IS MISSING FROM THIS SET DOES NOT LOSE ITS TEXT — it loses the SEPARATOR,
 * and the last word of one block fuses with the first word of the next. The search index then holds
 * "…master dyerThe workshop began…", which matches neither "dyer" nor "The" as a whole word. So every
 * block registered in `RICH_TEXT_NODE_TYPES` belongs here.
 */
const BLOCK_NODE_TYPES: ReadonlySet<string> = new Set([
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "table",
  "tableRow",
  "callout",
  "leadParagraph",
  "dropCap",
  "pullQuote",
  "attribution",
  "sideNote",
  "definitionList",
  "definitionTerm",
  "definitionDetails",
  "columns",
  "figure",
  // A caption is indexed as prose, unlike alt text. It is frequently the only place a photographer or
  // a village is named, and a reader searching for that name expects to find the page carrying it.
  "figureCaption"
]);

/**
 * Nodes that are content by their mere existence — they carry meaning with no text of their own.
 *
 * `isEmptyRichText` needs this: a document holding one image and nothing else flattens to an empty
 * string, and calling it empty would hide the image from every "does this field have anything in
 * it?" check in the studio.
 */
const SELF_SUFFICIENT_NODE_TYPES: ReadonlySet<string> = new Set([
  "image",
  "horizontalRule",
  "table",
  "callout",
  "footnote",
  // A figure holds a picture, so a document containing one figure and no prose is not an empty field —
  // exactly the reasoning that put `image` on this list.
  "figure"
]);

/** Used when a heading slugifies to nothing — a heading written entirely in a non-Latin script does,
 *  and an empty `id` is not an anchor anything can link to. */
const FALLBACK_HEADING_ID = "section";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Some rows hold the document as a JSON *string* rather than as a JSON object — an early importer
 * wrote it that way, and those rows are still in the database. Unwrapped once, not recursively: a
 * string nested inside a parsed document is text, not a document.
 */
function unwrapJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function normaliseMarks(value: unknown): RichTextMark[] {
  if (!Array.isArray(value)) return [];
  const marks: RichTextMark[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const type = typeof entry.type === "string" ? entry.type.trim() : "";
    if (!type) continue;
    const mark: RichTextMark = { type };
    if (isRecord(entry.attrs)) mark.attrs = { ...entry.attrs };
    marks.push(mark);
  }
  return marks;
}

function normaliseNodes(value: unknown, depth: number): RichTextNode[] {
  if (!Array.isArray(value)) return [];
  const nodes: RichTextNode[] = [];
  for (const entry of value) {
    const node = normaliseNode(entry, depth);
    if (node) nodes.push(node);
  }
  return nodes;
}

function normaliseNode(value: unknown, depth: number): RichTextNode | null {
  if (!isRecord(value)) return null;
  const type = typeof value.type === "string" ? value.type.trim() : "";
  if (!type) return null;

  if (type === "text") {
    // A text node with no text is not renderable and would only add an empty React child.
    const text = typeof value.text === "string" ? value.text : "";
    if (text.length === 0) return null;
    const node: RichTextNode = { type: "text", text };
    const marks = normaliseMarks(value.marks);
    if (marks.length > 0) node.marks = marks;
    return node;
  }

  const node: RichTextNode = { type };
  if (isRecord(value.attrs)) node.attrs = { ...value.attrs };
  const marks = normaliseMarks(value.marks);
  if (marks.length > 0) node.marks = marks;

  // Past the depth limit the node itself is kept and its children are dropped: the prose above the
  // pathological nesting is still readable, which is more useful than losing the whole block.
  if (depth < MAX_NODE_DEPTH) {
    const content = normaliseNodes(value.content, depth + 1);
    if (content.length > 0) node.content = content;
  }

  return node;
}

/**
 * Read a stored value as a document, or return null.
 *
 * TOLERANT BY DESIGN AND NEVER THROWS. Anything that is not recognisably a `doc` — null, a number, an
 * array, a half-migrated shape — is null, and the caller renders its empty state. The alternative,
 * throwing inside a Server Component, turns one bad row into a 500 for a whole page.
 *
 * The returned tree is normalised: every node has a string `type`, `content` is an array or absent,
 * and `attrs` is a plain object. The renderer is therefore allowed to trust the *shape* while still
 * treating every `type` and every attribute value as unverified.
 */
export function parseRichText(value: unknown): RichTextDoc | null {
  const raw = unwrapJsonString(value);
  if (!isRecord(raw)) return null;
  if (raw.type !== "doc") return null;

  const doc: RichTextDoc = { type: "doc", content: normaliseNodes(raw.content, 0) };
  if (isRecord(raw.attrs)) doc.attrs = { ...raw.attrs };
  return doc;
}

/** A fresh, valid, empty document — what the studio writes into a field nobody has typed in yet.
 *  A factory rather than a shared constant because the editor mutates the document it is given. */
export function emptyRichTextDoc(): RichTextDoc {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Attribute readers
//
// Everything in `attrs` came out of a Json column, so each of these coerces rather than casts. They
// live here rather than in the renderer so that the studio's editor and the public renderer read a
// given attribute the same way.
// ─────────────────────────────────────────────────────────────────────────────

function attrString(node: RichTextNode | RichTextMark, key: string): string | null {
  const value = node.attrs?.[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function attrNumber(node: RichTextNode, key: string): number | null {
  const value = node.attrs?.[key];
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  // Widths and levels arrive as strings from HTML paste ("600px" included).
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const HEADING_LEVELS: readonly RichTextHeadingLevel[] = [1, 2, 3, 4];

/** The document's heading level, clamped to 1–4. Defaults to 1, ProseMirror's own schema default. */
export function headingLevelOf(node: RichTextNode): RichTextHeadingLevel {
  const raw = attrNumber(node, "level");
  if (raw === null) return 1;
  return HEADING_LEVELS[Math.round(clamp(raw, 1, 4)) - 1] ?? 1;
}

/** The callout's tone. An unrecognised tone becomes `note` — the neutral one, never `danger`. */
export function calloutToneOf(node: RichTextNode): CalloutTone {
  const raw = attrString(node, "tone")?.toLowerCase();
  const match = CALLOUT_TONES.find((tone) => tone === raw);
  return match ?? "note";
}

/** The footnote's own identifier, if it was given one. Not used as an anchor — see RichText.tsx. */
export function footnoteIdOf(node: RichTextNode): string | null {
  return attrString(node, "id");
}

export function codeLanguageOf(node: RichTextNode): string | null {
  return attrString(node, "language");
}

/**
 * The languages the studio offers for a code block, and the words it prints above one.
 *
 * ⚠ THIS IS A LABEL LIST, NOT A HIGHLIGHTER. No syntax-highlighting library is installed and none may
 * be added (contract §13) — `lowlight` plus a grammar set is upwards of 200 KB on a public article
 * page, for prose that contains a code sample perhaps twice on this whole site. The label answers the
 * question a reader actually has ("what am I looking at?"); colouring the tokens does not.
 *
 * Values are the lowercase words an author would type and the ones HTML has always used in
 * `class="language-…"`, so a document imported from a markdown fence arrives already matching.
 */
export const CODE_LANGUAGES: readonly { value: string; label: string }[] = [
  { value: "text", label: "Plain text" },
  { value: "bash", label: "Shell" },
  { value: "json", label: "JSON" },
  { value: "xml", label: "XML" },
  { value: "html", label: "HTML" },
  { value: "css", label: "CSS" },
  { value: "javascript", label: "JavaScript" },
  { value: "typescript", label: "TypeScript" },
  { value: "python", label: "Python" },
  { value: "r", label: "R" },
  { value: "sql", label: "SQL" },
  { value: "yaml", label: "YAML" },
  { value: "markdown", label: "Markdown" },
  { value: "latex", label: "LaTeX" }
];

/**
 * The words to print above a code block.
 *
 * An unrecognised value is printed AS TYPED rather than dropped: the list above is what the studio
 * offers, not what a document may contain — a fence pasted from a repository can say `kotlin`, and
 * printing "kotlin" is right where printing nothing would silently lose the author's label.
 */
export function codeLanguageLabel(value: string | null): string | null {
  if (!value) return null;
  const known = CODE_LANGUAGES.find((entry) => entry.value === value.toLowerCase());
  return known ? known.label : value;
}

/** An ordered list's first number. Below 1 is meaningless in HTML, so it is ignored. */
export function orderedListStartOf(node: RichTextNode): number | null {
  const raw = attrNumber(node, "start");
  if (raw === null) return null;
  const start = Math.round(raw);
  return start >= 1 ? start : null;
}

/**
 * An ordered list's counter style, as HTML's own `type` values.
 *
 * These are the letters `@tiptap/extension-list` already stores on an ordered list, so a document that
 * arrived from a paste of `a. b. c.` carries one before anything in this repository asked for it.
 * Null means "plain numbers" — which is also what an unrecognised value becomes, because a stored
 * `type="circle"` (a *bulleted* list's marker) would otherwise produce a numbered list with no
 * numbers at all.
 */
export const ORDERED_LIST_MARKERS = ["1", "a", "A", "i", "I"] as const;
export type OrderedListMarker = (typeof ORDERED_LIST_MARKERS)[number];

export function orderedListMarkerOf(node: RichTextNode): OrderedListMarker | null {
  const raw = attrString(node, "type");
  return ORDERED_LIST_MARKERS.find((marker) => marker === raw) ?? null;
}

/**
 * A dividing line's treatment.
 *
 * ⚠ `hairline` IS THE DEFAULT AND THAT IS WHAT MAKES OLD DOCUMENTS SAFE. Every `horizontalRule` saved
 * before this attribute existed has no `variant` at all, reads back as `hairline`, and renders exactly
 * the 1px line it always did. Adding a variant may therefore never change the default.
 */
export const RULE_VARIANTS = ["hairline", "ornament"] as const;
export type RuleVariant = (typeof RULE_VARIANTS)[number];

export function ruleVariantOf(node: RichTextNode): RuleVariant {
  const raw = attrString(node, "variant")?.toLowerCase();
  return RULE_VARIANTS.find((variant) => variant === raw) ?? "hairline";
}

/**
 * How many columns a `columns` passage runs in.
 *
 * Two by default, and two is the only count that suits the narrow reading measure. Three is offered
 * for a wide block of short entries — a glossary, a list of place names — and the renderer steps it
 * down at every breakpoint, because three columns of prose on a phone is one word per line.
 */
export const COLUMN_COUNTS = [2, 3] as const;
export type ColumnCount = (typeof COLUMN_COUNTS)[number];

export function columnCountOf(node: RichTextNode): ColumnCount {
  const raw = attrNumber(node, "count");
  return COLUMN_COUNTS.find((count) => count === raw) ?? 2;
}

/**
 * Letter spacing, as three named steps rather than a number.
 *
 * A free `em` value is a number an author has to guess and a number that looks wrong at every size it
 * was not chosen at. These three map onto stock Tailwind's own `tracking-*` steps (contract §2:
 * `letterSpacing` is stock and is not extended), so spaced text sits on the same scale as the rest of
 * the site's type instead of beside it.
 */
export const TRACKING_AMOUNTS = ["tight", "wide", "wider"] as const;
export type TrackingAmount = (typeof TRACKING_AMOUNTS)[number];

export function trackingAmountOf(mark: RichTextMark): TrackingAmount | null {
  const raw = attrString(mark, "amount")?.toLowerCase();
  return TRACKING_AMOUNTS.find((amount) => amount === raw) ?? null;
}

/**
 * The three text colours an author may choose, and there will never be a fourth from a picker.
 *
 * Body prose is `ink-700`. These are the two rungs either side of it plus the brand hue:
 *
 *  - `strong` → `ink-900`, the heading rung. Emphasis without the weight change `bold` brings, which
 *    is what a proper noun or a defined term wants.
 *  - `muted` → `ink-500`, the same rung as a caption. For an aside inside a sentence.
 *  - `brand` → `purple-700`, lightened to `purple-300` on a dark canvas because purple-700 does not
 *    invert and is unreadable on `bg-0` in dark mode (the same rule links follow).
 *
 * ⚠ ALL THREE GO THROUGH THE THEMED LADDERS, which is the entire reason the list is closed. A hex
 * from a colour picker cannot invert, has no guaranteed contrast in either theme, and — on an
 * institutional page where purple-700 is the one action colour (contract §1.1) — teaches a reader
 * that colour no longer means "this is a link".
 */
export const TEXT_COLOURS = ["strong", "muted", "brand"] as const;
export type TextColourName = (typeof TEXT_COLOURS)[number];

export function textColourOf(mark: RichTextMark): TextColourName | null {
  const raw = attrString(mark, "value")?.toLowerCase();
  return TEXT_COLOURS.find((value) => value === raw) ?? null;
}

const TEXT_ALIGNMENTS = ["left", "center", "right", "justify"] as const;
export type TextAlignment = (typeof TEXT_ALIGNMENTS)[number];

/** Set by @tiptap/extension-text-align. Absent on most nodes; dropping it would silently discard a
 *  choice the editor made and could see in the studio. */
export function textAlignOf(node: RichTextNode): TextAlignment | null {
  const raw = attrString(node, "textAlign")?.toLowerCase();
  return TEXT_ALIGNMENTS.find((alignment) => alignment === raw) ?? null;
}

/**
 * An image node's attributes.
 *
 * Both `objectKey` and `src` are read: the media library inserts the former (so the derivative
 * pipeline and `mediaSrc()` can pick a width), while a document imported from elsewhere carries only
 * the latter. `alt` and `altText` are both accepted because Tiptap's stock image extension uses the
 * first name and the media library uses the second.
 */
export function imageAttrsOf(node: RichTextNode): RichTextImage {
  return {
    objectKey: attrString(node, "objectKey"),
    src: attrString(node, "src"),
    altText: attrString(node, "altText") ?? attrString(node, "alt"),
    caption: attrString(node, "caption") ?? attrString(node, "title"),
    width: attrNumber(node, "width"),
    height: attrNumber(node, "height"),
    blurDataUrl: attrString(node, "blurDataUrl")
  };
}

export function linkAttrsOf(mark: RichTextMark): RichTextLink {
  return { href: attrString(mark, "href"), title: attrString(mark, "title") };
}

/** A table cell's spans, floored at 1 — a `colspan` of 0 means "to the end of the row" in HTML and
 *  would swallow the rest of the table. */
export function cellSpansOf(node: RichTextNode): { colSpan: number; rowSpan: number } {
  const colSpan = attrNumber(node, "colspan");
  const rowSpan = attrNumber(node, "rowspan");
  return {
    colSpan: colSpan && colSpan >= 1 ? Math.round(colSpan) : 1,
    rowSpan: rowSpan && rowSpan >= 1 ? Math.round(rowSpan) : 1
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Walking and flattening
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Visit every node in document order, parents before children.
 *
 * Exported because several callers need a different question answered from the same walk — which
 * media assets does this document reference, does it contain an embed, how many words is it — and a
 * second hand-rolled recursion is a second place to forget a node type.
 */
export function walkRichText(
  doc: RichTextDoc | RichTextNode | null | undefined,
  visit: (node: RichTextNode) => void
): void {
  if (!doc) return;
  const children = doc.content;
  if (!children) return;
  for (const child of children) {
    visit(child);
    walkRichText(child, visit);
  }
}

interface TextPiece {
  text: string;
  /** Whether a newline is required between this piece and its neighbour. */
  block: boolean;
}

function serialiseNode(node: RichTextNode): TextPiece {
  if (node.type === "text") return { text: node.text ?? "", block: false };
  // A hard break is inline but IS a line ending; without this, "line one" and "line two" fuse.
  if (node.type === "hardBreak") return { text: "\n", block: false };
  // An image contributes nothing. Its alt text describes a picture to somebody who cannot see it —
  // it is not prose, and in an excerpt it reads as a caption that wandered into the article.
  if (node.type === "image" || node.type === "horizontalRule") return { text: "", block: true };
  if (node.type === "tableRow") return { text: serialiseNodes(node.content ?? [], " "), block: true };
  // A footnote is an INLINE node carrying a whole sentence, so it is flattened as a block: its body is
  // not part of the word it hangs off. Without this, "in 1947" followed by a note reading "Nehru's
  // speech" indexes as "1947Nehru's" and neither word is findable.
  if (node.type === "footnote") return { text: serialiseNodes(node.content ?? []), block: true };
  return { text: serialiseNodes(node.content ?? []), block: BLOCK_NODE_TYPES.has(node.type) };
}

/**
 * Join a node list. Blocks are separated by a newline, inline pieces by nothing, unless the caller
 * forces a separator — which a table row does, so that "12 | Jaipur" does not become "12Jaipur".
 */
function serialiseNodes(nodes: readonly RichTextNode[], separator?: string): string {
  let out = "";
  let previousWasBlock = false;
  let started = false;

  for (const node of nodes) {
    const piece = serialiseNode(node);
    if (piece.text.length === 0) continue;
    if (!started) {
      out = piece.text;
      previousWasBlock = piece.block;
      started = true;
      continue;
    }
    out += (separator ?? (piece.block || previousWasBlock ? "\n" : "")) + piece.text;
    previousWasBlock = piece.block;
  }

  return out;
}

/**
 * The document as plain text — what the search index stores, what reading time is measured from, and
 * what an excerpt is cut out of.
 *
 * `SearchDocument.body` is plain text for exactly this reason: indexing the raw JSON would let a
 * search for "type" match every paragraph in the site.
 */
export function richTextToPlainText(doc: RichTextDoc | RichTextNode | null | undefined): string {
  if (!doc?.content) return "";
  return serialiseNodes(doc.content).trim();
}

/**
 * A one-line summary, cut on a word boundary.
 *
 * Newlines collapse to spaces first: an excerpt is rendered in a card or a meta description, both of
 * which are single-line contexts where a stray newline shows up as a double space.
 */
export function richTextExcerpt(
  doc: RichTextDoc | RichTextNode | null | undefined,
  maxChars = 200
): string {
  const flat = richTextToPlainText(doc).replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "";
  return truncateWords(flat, maxChars);
}

/**
 * Anchor ids for every heading, keyed by the heading node itself.
 *
 * Keyed by node identity so the renderer and the table of contents cannot disagree: the renderer
 * looks each heading up in this map instead of re-deriving a slug and hoping the two functions stay
 * in step. A caller that parses the document separately still gets identical ids, because the
 * algorithm depends only on document order.
 *
 * Duplicate titles are the reason this exists at all — two "Method" headings would otherwise both
 * claim `#method` and every link to the second one would land on the first.
 */
export function richTextHeadingIds(
  doc: RichTextDoc | null | undefined
): Map<RichTextNode, string> {
  const ids = new Map<RichTextNode, string>();
  const taken = new Set<string>();

  walkRichText(doc, (node) => {
    if (node.type !== "heading") return;
    const base = slugify(serialiseNodes(node.content ?? [])) || FALLBACK_HEADING_ID;

    // The suffix loop re-checks rather than trusting a counter, because a document can legitimately
    // contain a heading whose own slug is "method-2" alongside two headings called "Method".
    let candidate = base;
    let suffix = 2;
    while (taken.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }

    taken.add(candidate);
    ids.set(node, candidate);
  });

  return ids;
}

/** The table of contents: every heading in document order, with the anchor the renderer will use. */
export function richTextHeadings(doc: RichTextDoc | null | undefined): RichTextHeading[] {
  const headings: RichTextHeading[] = [];
  // A Map iterates in insertion order, which is document order.
  for (const [node, id] of richTextHeadingIds(doc)) {
    headings.push({ id, level: headingLevelOf(node), text: serialiseNodes(node.content ?? []) });
  }
  return headings;
}

/** Fewer entries than this and no contents list is drawn: a list of one item is noise. */
export const TOC_MIN_ENTRIES = 2;

/**
 * Will a contents list for these headings draw anything?
 *
 * ⚠ THE COMPONENT VANISHING IS NOT THE SAME AS ITS COLUMN VANISHING. `app/(site)/news/[slug]` lays an
 * article out as `lg:grid-cols-[minmax(0,1fr)_15rem]` and puts `TableOfContents` in the second track.
 * Returning `null` removes the CONTENT; the `15rem` track is declared by the PARENT and stays exactly
 * where it is. Measured over CDP on the built site, with the old class restored on a live page:
 * `grid-template-columns` computed to **`976px 240px`** with one child — 240px of track reserved for
 * nothing. And on the seeded corpus EIGHTEEN OF EIGHTEEN news articles are in that state, because not
 * one reaches `TOC_MIN_ENTRIES`, so the contents list renders nowhere at all.
 *
 * ⚠ BUT IT IS NOT WHY AN ARTICLE LOOKS WIDE-MARGINED, AND SAYING SO WOULD BE THE MISTAKE THIS REPO
 * KEEPS MAKING. The same measurement, before and after: the cover photograph is **1278px either way**
 * (it breaks out of the column) and the prose is **576px either way** (`--measure`, 68ch). So removing
 * the empty track changes the article column from 976px to 1280px and moves NOTHING a reader can see.
 * The white space to the right of the prose is the measure inside an 84rem shell — a deliberate
 * decision in `.prose-measure`, not this bug. What this fixes is a track declared for content that is
 * never there, which matters the moment anything in that column is NOT measure-capped: a full-width
 * table, a figure, a future block. It is hygiene, and it was verified to be hygiene rather than
 * assumed to be a cure.
 *
 * ⚠ AND A CALLER CANNOT WORK IT OUT FOR ITSELF. `TableOfContents` filters its entries by
 * `id.length > 0`, so a page counting raw headings over-counts precisely when a heading failed to get
 * a slug — the case where the list is likeliest to fall short. Filter and threshold live here, once,
 * so a layout and the component can never disagree about whether there is a contents list.
 *
 * ⚠ AND IT LIVES IN THIS FILE RATHER THAN BESIDE THE COMPONENT BECAUSE OF A BUILD ERROR, NOT TASTE.
 * `TableOfContents.tsx` is `"use client"`, which makes every export from it a client reference; a
 * Server Component calling one fails the PRERENDER with "Attempted to call … from the server but it
 * is on the client". This module takes neither directive (see the header) and already owns
 * `RichTextHeading`, so both sides can reach it.
 */
export function tableOfContentsWillRender(
  headings: readonly RichTextHeading[],
  minEntries: number = TOC_MIN_ENTRIES
): boolean {
  return headings.filter((heading) => heading.id.length > 0).length >= minEntries;
}

function hasSubstance(node: RichTextNode): boolean {
  if (node.type === "text") return (node.text ?? "").trim().length > 0;
  if (SELF_SUFFICIENT_NODE_TYPES.has(node.type)) return true;
  // A lone line break is not content — it is the shape of an empty field somebody pressed Enter in.
  if (node.type === "hardBreak") return false;
  return (node.content ?? []).some(hasSubstance);
}

/**
 * Is there anything in this document?
 *
 * A DOCUMENT HOLDING ONE EMPTY PARAGRAPH IS EMPTY. Tiptap always emits that — it is the shape of an
 * untouched field — so a plain null check reports every field anybody has ever clicked into as
 * having content, and the site renders an empty `<p>` where it should render nothing.
 *
 * An image, a rule, a table or a callout still counts, even though the document flattens to "".
 */
export function isEmptyRichText(doc: RichTextDoc | RichTextNode | null | undefined): boolean {
  if (!doc?.content) return true;
  return !doc.content.some(hasSubstance);
}

/**
 * Is this document short enough to CENTRE without hurting the reader?
 *
 * The centred RICH_TEXT arrangements centre the heading always, and the body only when it is a
 * standfirst rather than an essay — centred prose over more than a few lines makes every line start
 * in a different place, which is exactly the hunting the measure exists to prevent. "Short" is
 * therefore: at most two blocks with anything in them, every one an ordinary paragraph (a list, a
 * table or a heading never reads centred), and no more text overall than a couple of sentences.
 *
 * Asked in two places that must agree — `components/sections/RichTextSection.tsx` decides the page,
 * and `components/studio/sections/RichTextForm.tsx` decides which typesetting notices are true — so
 * the answer lives here, beside `isEmptyRichText`, rather than in either of them.
 */
const SHORT_RICH_TEXT_MAX_CHARS = 280;

export function isShortRichText(doc: RichTextDoc | null | undefined): boolean {
  if (!doc?.content) return false;
  const blocks = doc.content.filter(hasSubstance);
  if (blocks.length === 0 || blocks.length > 2) return false;
  if (!blocks.every((node) => node.type === "paragraph")) return false;
  return richTextToPlainText(doc).length <= SHORT_RICH_TEXT_MAX_CHARS;
}
