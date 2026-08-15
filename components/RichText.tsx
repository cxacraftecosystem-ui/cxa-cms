/**
 * RichText — renders a stored Tiptap/ProseMirror document as React elements.
 *
 * THERE IS NO `dangerouslySetInnerHTML` HERE AND THERE MUST NEVER BE ONE. The document is editor
 * input: it reaches this file from a `Json` column that anybody with AUTHOR rank can write. Every
 * node becomes an element this file chose, every attribute is coerced by lib/richtext.ts, and an
 * unrecognised node renders nothing rather than being trusted. A raw-HTML passthrough — even "just
 * for the embed block" — would hand stored XSS to the whole public site.
 *
 * It carries no `"use client"` and no `server-only`, on purpose. On the public site it is a Server
 * Component (no JavaScript ships for an article); inside the studio the same file renders the live
 * preview from a client component. One renderer is the whole point: what the editor sees and what
 * the visitor sees cannot drift apart if there is only one implementation.
 *
 * TYPOGRAPHY IS WRITTEN OUT LITERALLY, per node type. Tailwind's typography plugin is not installed
 * and must not be added (contract §13) — and the ink/line/surface ladders it does not know about are
 * the only way the prose inverts correctly under `data-theme="dark"`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ EVERY BLOCK THE STUDIO GIVES A MARKER ATTRIBUTE GETS THE SAME ATTRIBUTE HERE. THREE THINGS
 *   DEPENDED ON THAT AND TWO OF THEM WERE BROKEN.
 *
 * `components/studio/editor/extensions.ts` fixes an HTML contract for the nodes that are not plain
 * paragraphs: `p[data-lead]`, `p[data-drop-cap]`, `blockquote[data-pull-quote]`,
 * `aside[data-side-note]`, `footer[data-attribution]`, `div[data-callout]`, `div[data-columns]`,
 * `figure[data-figure]`, `hr[data-rule]`, and the three mark spans. It WRITES those in `renderHTML`
 * and READS them back in `parseHTML`. This file used to write classes and no attributes at all, and
 * three things broke on that:
 *
 *   1. **`lib/typography/typeset.ts` styles the pull quote through `[&_[data-pull-quote]]`** — the only
 *      way to reach a display quote without also catching an ordinary quotation, which is body copy and
 *      must stay in the reading face. That selector matched nothing on a published page, so on a site
 *      whose headings were Playfair the pull quote was the one large piece of type still set in Plus
 *      Jakarta Sans. The comment in that file *said* this renderer marked them. It did not.
 *   2. **The house prose recipe outranks a utility.** `.prose-typeset :is(p, li)` is (0,1,1) and every
 *      size below is (0,1,0) — so the recipe set the LEAD PARAGRAPH, the PULL QUOTE and the SIDE NOTE
 *      at body size, cancelling the three blocks whose entire purpose is not to be body size. An
 *      attribute inside an arbitrary variant is (0,2,0) and beats it; `PROSE_NODE_HOOK_CLASS` in
 *      `lib/typography/typeset.ts` is that list, and it needs these attributes to exist.
 *   3. **A published passage pasted back into the studio silently degraded.** `parseHTML` looks for the
 *      markers; `paragraph`'s bare `p` rule wins at priority 50 without them, so a lead paragraph, a
 *      drop cap, a pull quote and a side note all came back as ordinary paragraphs. extensions.ts warns
 *      about precisely that and raises those three rules to priority 60 to prevent it.
 *
 * ⚠ TWO BLOCKS STILL CANNOT ROUND-TRIP, AND IT IS NOT FIXABLE BY AN ATTRIBUTE. A FOOTNOTE'S BODY is
 *   printed in the list at the foot of the page, not inside its marker, so a `<sup>` marked as a
 *   footnote would parse back as a footnote whose only content was its own number — worse than not
 *   parsing. And the ORNAMENT RULE is a `<div>` holding three dots, because an `<hr>` is a void element
 *   and cannot hold them (see `renderRule`), so it cannot present itself as the `hr[data-rule]` the
 *   editor parses. Both are stated rather than papered over.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ The `image` node must be registered in the editor as a BLOCK node (`inline: false`). It renders
 * as a `<figure>`, and a `<figure>` inside a `<p>` is invalid HTML that the browser's parser will
 * silently restructure — which React then sees as a hydration mismatch.
 */

import { Fragment, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  CornerDownLeft,
  Hash,
  ImageOff,
  Info,
  Lightbulb,
  OctagonAlert,
  TriangleAlert,
  type LucideIcon
} from "lucide-react";

import { cn } from "@/lib/utils";
import { mediaAlt, mediaSrc } from "@/lib/media/url";
import {
  calloutToneOf,
  cellSpansOf,
  codeLanguageLabel,
  codeLanguageOf,
  columnCountOf,
  headingLevelOf,
  imageAttrsOf,
  isEmptyRichText,
  linkAttrsOf,
  orderedListMarkerOf,
  orderedListStartOf,
  parseRichText,
  richTextHeadingIds,
  ruleVariantOf,
  textAlignOf,
  textColourOf,
  trackingAmountOf,
  walkRichText,
  type CalloutTone,
  type ColumnCount,
  type OrderedListMarker,
  type RichTextDoc,
  type RichTextHeadingLevel,
  type RichTextMark,
  type RichTextNode,
  type TextAlignment,
  type TextColourName,
  type TrackingAmount
} from "@/lib/richtext";

export type RichTextVariant = "article" | "compact";

export interface RichTextProps {
  /** The raw column value, or an already-parsed document. Anything unrecognisable renders nothing. */
  value: unknown;
  /** Spacing and type scale only. It never changes which elements are produced. */
  variant?: RichTextVariant;
  className?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scale
//
// Every class string below is written out COMPLETE. Tailwind's content globs scan these files as
// text (contract §5); a class assembled by concatenation is purged and the style silently vanishes.
// ─────────────────────────────────────────────────────────────────────────────

interface Scale {
  root: string;
  paragraph: string;
  /** The standfirst. Larger than the body and darker, because it is read before the body is. */
  lead: string;
  /** A paragraph plus its `::first-letter` treatment, in one string — see `renderNode`'s ⚠. */
  dropCap: string;
  heading: Record<RichTextHeadingLevel, string>;
  list: string;
  listItem: string;
  blockquote: string;
  /** A display quote lifted out of the argument. Deliberately unlike `blockquote` — see `PullQuote`. */
  pullQuote: string;
  /** The credit line closing a quote of either kind. */
  attribution: string;
  /** A quiet aside: smaller and greyer than a quote, unboxed unlike a callout. */
  sideNote: string;
  definitionList: string;
  definitionTerm: string;
  definitionDetails: string;
  /** Spacing and break rules for a multi-column passage. The count comes from `COLUMN_CLASSES`. */
  columns: string;
  /** The wrapper that owns a code block's top margin, so the language label sits inside it. */
  codeFrame: string;
  codeLabel: string;
  codeBlock: string;
  figure: string;
  caption: string;
  tableFrame: string;
  cell: string;
  rule: string;
  /** The ornament variant of a dividing line: a centred row of dots, not an `<hr>`. */
  ruleOrnament: string;
  callout: string;
  calloutBody: string;
  footnotes: string;
  /** `sizes` for next/image. Wrong values here cost bandwidth on every article on the site. */
  imageSizes: string;
}

/**
 * The drop cap, as a `::first-letter` treatment.
 *
 * ⚠ `after:block after:clear-left after:content-['']` IS LOAD-BEARING AND LOOKS LIKE NOISE. The cap is
 * a float, so a paragraph SHORTER than the cap is tall leaves the float hanging below its own
 * paragraph and the next block wraps around it — an opening line of six words followed by a heading
 * indented three centimetres for no visible reason. The empty `::after` closes the float inside the
 * paragraph that owns it.
 *
 * ⚠ `text-ink-900`, NOT purple. A large purple letter on an article page competes with the one thing
 * purple-700 means on this site — "you can click this" (contract §1.1). A drop cap is decoration, and
 * decoration does not get the action colour.
 *
 * ⚠ `first-letter` follows the browser's idea of a first letter, which INCLUDES an opening quotation
 * mark or bracket. That is correct typographic behaviour, and it is why a drop-cap paragraph should
 * not start with “ — the cap becomes the quote mark. Nothing here can fix that; an author has to see it.
 */
const DROP_CAP_ARTICLE =
  "first-letter:float-left first-letter:mr-2.5 first-letter:mt-1 first-letter:font-display first-letter:text-[3.25rem] first-letter:font-bold first-letter:leading-[0.78] first-letter:text-ink-900 after:block after:clear-left after:content-['']";

const DROP_CAP_COMPACT =
  "first-letter:float-left first-letter:mr-2 first-letter:font-display first-letter:text-3xl first-letter:font-bold first-letter:leading-[0.85] first-letter:text-ink-900 after:block after:clear-left after:content-['']";

const SCALES: Record<RichTextVariant, Scale> = {
  article: {
    root: "text-base leading-7 text-ink-700",
    paragraph: "mt-5 first:mt-0",
    lead: "mt-6 text-lg leading-8 text-ink-900 first:mt-0 sm:text-xl sm:leading-9",
    dropCap: `mt-5 first:mt-0 ${DROP_CAP_ARTICLE}`,
    heading: {
      1: "mt-12 text-3xl leading-tight sm:text-4xl",
      2: "mt-12 text-2xl leading-snug sm:text-3xl",
      3: "mt-10 text-xl leading-snug sm:text-2xl",
      4: "mt-8 text-lg leading-snug"
    },
    list: "mt-5 pl-6 first:mt-0",
    listItem: "mt-2 first:mt-0 marker:text-ink-300",
    blockquote: "mt-6 border-l-2 border-purple-300 pl-5 text-lg leading-8 text-ink-700 first:mt-0",
    // No left rule and no quotation marks: the rules above and below are what say "this is lifted out",
    // and a quote mark drawn in CSS is a quote mark that neither copies nor reads aloud.
    pullQuote:
      "my-10 border-y border-line-200 py-7 text-center font-display text-2xl font-medium leading-snug tracking-tight text-ink-900 first:mt-0 sm:text-3xl",
    attribution: "mt-4 text-sm not-italic leading-6 text-ink-500",
    sideNote: "mt-6 border-l border-line-200 pl-4 text-sm leading-6 text-ink-500 first:mt-0",
    definitionList: "mt-6 first:mt-0",
    definitionTerm: "mt-5 font-semibold text-ink-900 first:mt-0",
    definitionDetails: "mt-1.5 border-l border-line-200 pl-4",
    columns: "mt-8 gap-8 first:mt-0 [&_figure]:break-inside-avoid [&_pre]:break-inside-avoid",
    codeFrame: "mt-6 first:mt-0",
    // ⚠ `block` IS LOAD-BEARING AND LOOKS DECORATIVE. The label is a `<span>` (see `renderNode`), and a
    // vertical margin is IGNORED on a non-replaced inline element — so without it the `mb-1.5` is
    // silently discarded and the label sits flush on the top border of the code frame.
    codeLabel: "mb-1.5 block text-xs font-semibold uppercase tracking-wide text-ink-500",
    codeBlock:
      "overflow-x-auto rounded-md border border-line-200 bg-surface-100 p-4 text-sm leading-6",
    figure: "mt-8 first:mt-0",
    caption: "mt-2 text-sm leading-6 text-ink-500",
    tableFrame: "mt-8 overflow-x-auto rounded-md border border-line-200 first:mt-0",
    cell: "px-3 py-2 text-sm leading-6",
    rule: "mt-10 border-line-200",
    ruleOrnament: "mt-10 flex items-center justify-center gap-2.5",
    callout: "mt-6 rounded-md border border-line-200 bg-surface-50 p-4 first:mt-0",
    calloutBody: "mt-2 text-base leading-7 text-ink-700",
    footnotes: "mt-12 border-t border-line-200 pt-6 text-sm leading-6 text-ink-500",
    imageSizes: "(min-width: 1024px) 48rem, 100vw"
  },
  compact: {
    root: "text-sm leading-6 text-ink-700",
    paragraph: "mt-3 first:mt-0",
    lead: "mt-4 text-base leading-7 text-ink-900 first:mt-0",
    dropCap: `mt-3 first:mt-0 ${DROP_CAP_COMPACT}`,
    heading: {
      1: "mt-6 text-lg leading-snug",
      2: "mt-6 text-base leading-snug",
      3: "mt-4 text-sm leading-snug",
      4: "mt-4 text-sm leading-snug"
    },
    list: "mt-3 pl-5 first:mt-0",
    listItem: "mt-1 first:mt-0 marker:text-ink-300",
    blockquote: "mt-4 border-l-2 border-purple-300 pl-4 text-sm leading-6 text-ink-700 first:mt-0",
    pullQuote:
      "my-5 border-y border-line-200 py-4 text-center font-display text-lg font-medium leading-snug tracking-tight text-ink-900 first:mt-0",
    attribution: "mt-2 text-xs not-italic leading-5 text-ink-500",
    sideNote: "mt-4 border-l border-line-200 pl-3 text-xs leading-5 text-ink-500 first:mt-0",
    definitionList: "mt-4 first:mt-0",
    definitionTerm: "mt-3 text-sm font-semibold text-ink-900 first:mt-0",
    definitionDetails: "mt-1 border-l border-line-200 pl-3",
    columns: "mt-4 gap-6 first:mt-0 [&_figure]:break-inside-avoid [&_pre]:break-inside-avoid",
    codeFrame: "mt-4 first:mt-0",
    // `block` for the same reason as the article scale above: an inline element drops `mb-1` entirely.
    codeLabel: "mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-500",
    codeBlock:
      "overflow-x-auto rounded-md border border-line-200 bg-surface-100 p-3 text-xs leading-5",
    figure: "mt-4 first:mt-0",
    caption: "mt-1.5 text-xs leading-5 text-ink-500",
    tableFrame: "mt-4 overflow-x-auto rounded-md border border-line-200 first:mt-0",
    cell: "px-2.5 py-1.5 text-xs leading-5",
    rule: "mt-6 border-line-200",
    ruleOrnament: "mt-6 flex items-center justify-center gap-2",
    callout: "mt-4 rounded-md border border-line-200 bg-surface-50 p-3 first:mt-0",
    calloutBody: "mt-1.5 text-sm leading-6 text-ink-700",
    footnotes: "mt-6 border-t border-line-200 pt-4 text-xs leading-5 text-ink-500",
    imageSizes: "(min-width: 768px) 24rem, 100vw"
  }
};

/**
 * The LEAD PARAGRAPH's own class string, for the one caller that has a standfirst but no node.
 *
 * ⚠ IT EXISTS SO THERE IS NOT A SECOND ANSWER TO "WHAT DOES A LEAD PARAGRAPH LOOK LIKE". A deck lives
 * in a COLUMN (`Post.excerpt`), not in the stored document, so `components/site/ProseArticle.tsx` has to
 * draw it itself — and a `text-lg sm:text-xl` copied into that file is the second copy of a number this
 * repo keeps producing. Reading `SCALES[variant].lead` means the standfirst a page passes in and a
 * `leadParagraph` node the editor inserted are the same paragraph, drawn from the same string.
 *
 * The caller must also write `data-lead` on the element, exactly as `renderNode` does — the class is
 * half of a lead paragraph and the marker attribute is the other half. See `PROSE_NODE_HOOK_CLASS` in
 * `lib/typography/typeset.ts`: inside the house recipe the ATTRIBUTE is what carries the size, at
 * (0,2,0), because the recipe's own (0,1,1) rule beats every utility in the string below.
 */
export function leadParagraphClassName(variant: RichTextVariant = "article"): string {
  return SCALES[variant].lead;
}

/**
 * How many columns a passage runs in, per breakpoint.
 *
 * ⚠ EVERY COUNT STARTS AT ONE. Two columns of prose inside a 360px-wide phone is four or five words a
 * line, which is unreadable — and three is one word a line. The author chooses the count for a wide
 * screen; the narrow screen is not negotiable. Complete literal strings, because a class assembled as
 * `columns-${count}` is purged by the content scan and silently does nothing (contract §5).
 */
const COLUMN_CLASSES: Record<ColumnCount, string> = {
  2: "columns-1 sm:columns-2",
  3: "columns-1 sm:columns-2 lg:columns-3"
};

/**
 * A numbered list's counter style.
 *
 * ⚠ These have to be CSS, not the `<ol type="a">` attribute. `list-decimal` in `scale.list`'s
 * neighbour sets `list-style-type` and CSS always beats a presentational attribute, so a `type` on the
 * element would be overridden and every list would come out in plain numbers.
 */
const ORDERED_LIST_MARKER_CLASSES: Record<OrderedListMarker, string> = {
  "1": "list-decimal",
  a: "list-[lower-alpha]",
  A: "list-[upper-alpha]",
  i: "list-[lower-roman]",
  I: "list-[upper-roman]"
};

/** `font-variant-caps` has no stock Tailwind utility, so it is an arbitrary property. */
const SMALL_CAPS_CLASS = "[font-variant-caps:small-caps]";

/** Stock Tailwind's own `letterSpacing` steps (contract §2 — the scale is not extended). */
const TRACKING_CLASSES: Record<TrackingAmount, string> = {
  tight: "tracking-tight",
  wide: "tracking-wide",
  wider: "tracking-wider"
};

/**
 * The three text colours, and all three go through a themed ladder.
 *
 * `brand` carries the same dark-mode exception as a link: purple-700 does not invert (contract §1.1)
 * and oklch(0.47) on oklch(0.17) is below any readable contrast, so the hue is kept and the lightness
 * is raised. `strong` and `muted` are ink rungs and invert on their own.
 */
const TEXT_COLOUR_CLASSES: Record<TextColourName, string> = {
  strong: "text-ink-900",
  muted: "text-ink-500",
  brand: "text-purple-700 dark:text-purple-300"
};

/** `first:mt-0` sits here rather than in each level so a heading opening a blockquote or a list item
 *  loses its top margin too. Tailwind emits variant utilities after plain ones, so it wins. */
const HEADING_BASE = "group font-display font-semibold tracking-tight text-ink-900 first:mt-0";

/**
 * The document's level 1 renders as an `<h2>`.
 *
 * The page owns the only `<h1>` (contract §11), and a body that could emit a second one would be an
 * accessibility fault on every article rather than a mistake in one. The *visual* size still follows
 * the level the editor chose, so an H1 still looks like an H1 — only the tag is clamped.
 */
const HEADING_TAGS: Record<RichTextHeadingLevel, "h2" | "h3" | "h4"> = {
  1: "h2",
  2: "h2",
  3: "h3",
  4: "h4"
};

const TEXT_ALIGN_CLASSES: Record<TextAlignment, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
  justify: "text-justify"
};

/**
 * Links take the lighter rung of the brand hue on a dark canvas.
 *
 * purple-700 is the action colour and does not invert (contract §1.1) — which is right for a filled
 * button and wrong for text on `bg-0` in dark mode, where oklch(0.47) against oklch(0.17) is below
 * any readable contrast. Same hue, different lightness: the brand survives, the text is legible.
 */
const LINK_CLASSES =
  "text-purple-700 underline decoration-purple-300 underline-offset-2 transition-colors hover:decoration-purple-700 dark:text-purple-300 dark:decoration-purple-300/50 dark:hover:decoration-purple-300";

interface CalloutStyle {
  icon: LucideIcon;
  label: string;
  /** Both halves are literal colours. See the note on the highlight mark below. */
  chip: string;
}

/**
 * A callout says its tone in three ways: an icon, a word and a colour. Colour never carries meaning
 * on its own (contract §11).
 *
 * The tone is confined to the small icon chip; the box and the prose inside it stay on the themed
 * surface/ink ladders. A tinted fill across the whole box would have to fight the fact that the
 * status tints are literal hex and DO NOT invert, while `text-ink-700` does — the combination reads
 * as pale grey on pale cream in dark mode.
 */
const CALLOUT_STYLES: Record<CalloutTone, CalloutStyle> = {
  note: { icon: Info, label: "Note", chip: "bg-purple-100 text-purple-700" },
  tip: { icon: Lightbulb, label: "Tip", chip: "bg-success-100 text-success-600" },
  warning: { icon: TriangleAlert, label: "Warning", chip: "bg-warn-100 text-warn-800" },
  danger: { icon: OctagonAlert, label: "Important", chip: "bg-error-100 text-error-700" }
};

/**
 * The site's own origin, for deciding whether a link leaves the site.
 *
 * Written out in full rather than read through a variable: Next's build-time substitution is a
 * literal text replacement on `process.env.NEXT_PUBLIC_*`, and a dynamic lookup silently reads
 * `undefined` in the browser (the trap documented in lib/media/url.ts).
 *
 * When it is unset, every absolute URL is treated as external. That is the safe direction: an
 * internal link opening in a new tab is a nuisance, an external link without `rel="noopener"` hands
 * the opener window to another origin.
 */
const SITE_HOST = (() => {
  const configured = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim();
  if (!configured) return null;
  try {
    return new URL(configured).host.toLowerCase();
  } catch {
    return null;
  }
})();

type LinkKind = "internal" | "external" | "plain" | "unsafe";

/**
 * Decide what kind of link an href is.
 *
 * `unsafe` is the load-bearing case: a stored `javascript:` or `data:` href is script execution
 * dressed as prose, and it survives a JSON-only pipeline untouched because it is just a string in an
 * attribute. Those render as plain text with no anchor at all.
 */
function classifyHref(href: string): { kind: LinkKind; href: string } {
  if (href.startsWith("#")) return { kind: "plain", href };
  if (href.startsWith("/")) return { kind: "internal", href };

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
  if (!scheme) {
    // A relative href with no leading slash. Left to the browser to resolve, exactly as it would in
    // the editor — rewriting an editor's link is a worse surprise than an occasional 404.
    return { kind: "plain", href };
  }
  if (scheme === "mailto" || scheme === "tel") return { kind: "plain", href };
  if (scheme !== "http" && scheme !== "https") return { kind: "unsafe", href };

  try {
    const url = new URL(href);
    if (SITE_HOST && url.host.toLowerCase() === SITE_HOST) {
      return { kind: "internal", href: `${url.pathname}${url.search}${url.hash}` };
    }
    return { kind: "external", href };
  } catch {
    return { kind: "unsafe", href };
  }
}

interface RenderContext {
  scale: Scale;
  /** Keyed by node identity, so the anchor the renderer writes is the one `richTextHeadings()` says. */
  headingIds: Map<RichTextNode, string>;
  footnotes: Map<RichTextNode, FootnoteEntry>;
}

interface FootnoteEntry {
  index: number;
  /** A footnote with no text of its own gets a number but no link: an href pointing at an id that
   *  was never rendered is worse than no href (contract §11). */
  listed: boolean;
}

function collectFootnotes(doc: RichTextDoc): {
  map: Map<RichTextNode, FootnoteEntry>;
  listed: { node: RichTextNode; index: number }[];
} {
  const map = new Map<RichTextNode, FootnoteEntry>();
  const listed: { node: RichTextNode; index: number }[] = [];

  walkRichText(doc, (node) => {
    if (node.type !== "footnote") return;
    // Numbered by DOCUMENT ORDER, not by the node's `id` attribute: two footnotes may share an id
    // (or carry none), and an anchor has to be unique on the page.
    const index = map.size + 1;
    const hasBody = (node.content ?? []).length > 0;
    map.set(node, { index, listed: hasBody });
    if (hasBody) listed.push({ node, index });
  });

  return { map, listed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Marks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap a text node in its marks.
 *
 * Applied in a FIXED ORDER regardless of the order they appear in the JSON, so two documents with
 * the same formatting always produce the same DOM. Tiptap does not guarantee mark order, and a
 * `<strong><em>` here against an `<em><strong>` there is a diff nobody can explain and, in the
 * studio preview, a hydration mismatch.
 *
 * ⚠ THE ORDER IS NOT ARBITRARY WHERE COLOUR IS CONCERNED. Marks are applied innermost first, and the
 * INNERMOST element's own `color` wins for its own text. `bold` renders `<strong class="text-ink-900">`,
 * so a colour span wrapped AROUND the `<strong>` would be overridden and bold coloured text would come
 * out plain. Hence `textColour` goes on before `bold` — inside it — and `code`, which owns its own
 * colour on purpose, goes on before that.
 */
function renderText(node: RichTextNode, key: string): ReactNode {
  const marks = node.marks ?? [];
  const has = (type: string) => marks.some((mark) => mark.type === type);

  let content: ReactNode = node.text ?? "";

  if (has("code")) {
    // `rounded` is 4px in this config — tighter than `rounded-sm` (8px), which is what inline code
    // wants at body size. Reading the class name is not enough to know the radius (contract §4).
    content = (
      <code className="rounded bg-surface-200 px-1 py-0.5 font-mono text-[0.9em] text-ink-900">
        {content}
      </code>
    );
  }

  // The face has no real small-cap glyphs, so the browser synthesises them from capitals. See the
  // `SmallCaps` mark in the editor's extension set for why that is still the right property to use.
  if (has("smallCaps")) content = <span className={SMALL_CAPS_CLASS}>{content}</span>;

  const trackingMark = marks.find((mark) => mark.type === "tracking");
  const tracking = trackingMark ? trackingAmountOf(trackingMark) : null;
  if (tracking) content = <span className={TRACKING_CLASSES[tracking]}>{content}</span>;

  /**
   * ⚠ HIGHLIGHT WINS OVER TEXT COLOUR, and dropping the colour is the deliberate choice.
   *
   * The highlight is a fixed, NON-inverting `bg-warn-100` deliberately paired with a fixed
   * `text-warn-800` — that pair is the only reason highlighted text is legible in both themes (see the
   * mark below). A brand-purple or ink-500 foreground inside it would be chosen against the page's
   * background, not against a fixed amber one, and in dark mode the result is unreadable.
   *
   * The studio makes the same decision visibly rather than silently: the colour controls are
   * unavailable while the selection is highlighted, so nobody picks a colour that is then discarded.
   */
  const colourMark = has("highlight")
    ? undefined
    : marks.find((mark) => mark.type === "textColour");
  const colour = colourMark ? textColourOf(colourMark) : null;
  if (colour) content = <span className={TEXT_COLOUR_CLASSES[colour]}>{content}</span>;

  if (has("subscript")) content = <sub className="text-[0.75em]">{content}</sub>;
  if (has("superscript")) content = <sup className="text-[0.75em]">{content}</sup>;
  if (has("strike")) content = <s>{content}</s>;
  if (has("underline")) content = <u className="underline underline-offset-2">{content}</u>;
  if (has("italic")) content = <em>{content}</em>;
  if (has("bold")) content = <strong className="font-semibold text-ink-900">{content}</strong>;
  if (has("highlight")) {
    // BOTH colours are literal. `bg-warn-100` is a fixed hex that does not invert, so pairing it
    // with `text-ink-900` — which does — turns highlighted text white-on-cream in dark mode. Any
    // `color` attribute the mark carries is ignored for the same reason: an arbitrary stored fill
    // has no guaranteed contrast against either theme's text.
    content = <mark className="rounded bg-warn-100 px-0.5 text-warn-800">{content}</mark>;
  }

  const link = marks.find((mark) => mark.type === "link");
  if (link) content = renderLink(link, content);

  return <Fragment key={key}>{content}</Fragment>;
}

function renderLink(mark: RichTextMark, children: ReactNode): ReactNode {
  const { href, title } = linkAttrsOf(mark);
  if (!href) return children;

  const link = classifyHref(href);
  if (link.kind === "unsafe") return children;

  if (link.kind === "internal") {
    return (
      <Link href={link.href} title={title ?? undefined} className={LINK_CLASSES}>
        {children}
      </Link>
    );
  }

  if (link.kind === "plain") {
    return (
      <a href={link.href} title={title ?? undefined} className={LINK_CLASSES}>
        {children}
      </a>
    );
  }

  return (
    <a
      href={link.href}
      title={title ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      className={LINK_CLASSES}
    >
      {children}
      {/* Sighted readers get the new tab as a surprise they can undo; a screen-reader user gets no
          cue at all unless the destination says so before it is followed. */}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Nodes
// ─────────────────────────────────────────────────────────────────────────────

function renderNodes(nodes: readonly RichTextNode[], ctx: RenderContext): ReactNode[] {
  // Index keys are correct here and only here: a stored document is rendered whole and never
  // reordered, inserted into or filtered on the client.
  return nodes.map((node, index) => renderNode(node, `${node.type}-${index}`, ctx));
}

function renderNode(node: RichTextNode, key: string, ctx: RenderContext): ReactNode {
  const { scale } = ctx;
  const children = node.content ?? [];

  switch (node.type) {
    case "text":
      return renderText(node, key);

    case "paragraph": {
      const align = textAlignOf(node);
      return (
        <p key={key} className={cn(scale.paragraph, align && TEXT_ALIGN_CLASSES[align])}>
          {renderNodes(children, ctx)}
        </p>
      );
    }

    case "leadParagraph": {
      const align = textAlignOf(node);
      return (
        // `data-lead` is the studio's own marker for this node (see the header). It is also what the
        // house recipe's size hook hangs off, so a standfirst is a standfirst inside a `.prose-typeset`
        // box as well as outside one.
        <p key={key} data-lead="" className={cn(scale.lead, align && TEXT_ALIGN_CLASSES[align])}>
          {renderNodes(children, ctx)}
        </p>
      );
    }

    case "dropCap": {
      // Alignment is read for the same reason `paragraph` reads it: the studio registers `textAlign`
      // on headings and paragraphs only, so a drop cap written HERE never carries one — but a document
      // that arrived from elsewhere can, and dropping a value somebody set is the silent loss this
      // whole file exists to prevent. (A centred drop cap does look wrong: the cap floats left while
      // the text sits away from it. Nothing can fix that but the author.)
      const align = textAlignOf(node);
      return (
        <p
          key={key}
          data-drop-cap=""
          className={cn(scale.dropCap, align && TEXT_ALIGN_CLASSES[align])}
        >
          {renderNodes(children, ctx)}
        </p>
      );
    }

    case "heading":
      return renderHeading(node, key, ctx);

    case "bulletList":
      return (
        <ul key={key} className={cn(scale.list, "list-disc")}>
          {renderNodes(children, ctx)}
        </ul>
      );

    case "orderedList": {
      const start = orderedListStartOf(node);
      // Null means "plain numbers", which is what every list written before the marker was offered
      // has — so an old document renders exactly as it always did.
      const marker = orderedListMarkerOf(node) ?? "1";
      return (
        <ol
          key={key}
          className={cn(scale.list, ORDERED_LIST_MARKER_CLASSES[marker])}
          start={start ?? undefined}
        >
          {renderNodes(children, ctx)}
        </ol>
      );
    }

    case "listItem":
      return (
        <li key={key} className={scale.listItem}>
          {renderNodes(children, ctx)}
        </li>
      );

    case "blockquote":
      return (
        <blockquote key={key} className={scale.blockquote}>
          {renderNodes(children, ctx)}
        </blockquote>
      );

    case "pullQuote":
      return (
        // ⚠ `data-pull-quote` IS LOAD-BEARING, NOT DECORATION. It is the only hook that separates a
        // display quote from an ordinary quotation, and `lib/typography/typeset.ts` reaches it twice —
        // once for the heading face, once for the display size the recipe would otherwise flatten.
        <blockquote key={key} data-pull-quote="" className={scale.pullQuote}>
          {renderNodes(children, ctx)}
        </blockquote>
      );

    case "attribution":
      return (
        <footer key={key} data-attribution="" className={scale.attribution}>
          {/* The dash is punctuation, not information. A screen reader announcing "em dash" before
              every credit line is noise, so it is hidden and the `<cite>` carries the meaning. */}
          <span aria-hidden="true">— </span>
          {/* `not-italic` because browsers italicise `<cite>` by default and preflight leaves that
              alone. A credit line set in italic beside a large quote reads as part of the quote. */}
          <cite className="not-italic">{renderNodes(children, ctx)}</cite>
        </footer>
      );

    case "sideNote":
      return (
        // The `<aside>` keeps its own smaller size; the recipe does not target `aside`. Its PARAGRAPHS
        // are what the recipe would drag back to reading size, and `data-side-note` is what the hook in
        // `lib/typography/typeset.ts` uses to stop it.
        <aside key={key} data-side-note="" className={scale.sideNote}>
          {renderNodes(children, ctx)}
        </aside>
      );

    case "definitionList":
      return (
        <dl key={key} className={scale.definitionList}>
          {renderNodes(children, ctx)}
        </dl>
      );

    case "definitionTerm":
      return (
        <dt key={key} className={scale.definitionTerm}>
          {renderNodes(children, ctx)}
        </dt>
      );

    case "definitionDetails":
      return (
        <dd key={key} className={scale.definitionDetails}>
          {renderNodes(children, ctx)}
        </dd>
      );

    case "columns": {
      const count = columnCountOf(node);
      return (
        // The count is on the attribute as well as in the class, because that is the shape the editor
        // parses (`div[data-columns]`, the number read off the attribute). The class is what actually
        // draws the columns here.
        <div key={key} data-columns={String(count)} className={cn(scale.columns, COLUMN_CLASSES[count])}>
          {renderNodes(children, ctx)}
        </div>
      );
    }

    case "codeBlock": {
      const language = codeLanguageOf(node);
      const label = codeLanguageLabel(language);
      // The wrapper owns the top margin so the label sits inside the block's own spacing. Without a
      // language there is no label and the result is byte-for-byte the block that shipped before.
      return (
        <div key={key} className={scale.codeFrame}>
          {/*
            ⚠ A `<span>`, NOT A `<p>`, AND THAT IS THE FIX RATHER THAN A STYLE CHOICE. The house recipe
            sets `font-size` and `line-height` on every `p` inside it at (0,1,1), which beat this label's
            own `text-xs` at (0,1,0) — so "PYTHON" was rendered uppercase at the article's reading size,
            seventeen pixels tall, above the code it labels. A language label is not a paragraph of prose,
            so the honest repair is to stop claiming it is one; the recipe then correctly never reaches it
            and no override is needed anywhere.

            ⚠ AND THE `block` THAT MAKES THE GAP WORK IS IN `scale.codeLabel`, NOT HERE. A `<span>` is
            inline, and vertical margins are ignored on a non-replaced inline element, so the `mb-1.5` /
            `mb-1` in those two strings is inert without it and the label sits on the `<pre>`'s top
            border. This comment claimed `class="block"` for a class string that did not contain it —
            which is why the rule now lives beside the class it constrains, in both variants.
          */}
          {label ? <span className={scale.codeLabel}>{label}</span> : null}
          <pre className={scale.codeBlock} data-language={language ?? undefined}>
            <code className="font-mono text-ink-900">{renderNodes(children, ctx)}</code>
          </pre>
        </div>
      );
    }

    case "horizontalRule":
      return renderRule(node, key, ctx);

    case "hardBreak":
      return <br key={key} />;

    case "image":
      return renderImage(node, key, ctx);

    case "figure":
      return renderFigure(node, key, ctx);

    case "figureCaption":
      // Only reached for a caption that is NOT inside a figure — `renderFigure` draws its own. The
      // schema forbids that, but a hand-written or migrated document can still hold one, and drawing
      // it as a caption keeps the words rather than dropping them.
      return (
        <p key={key} className={scale.caption}>
          {renderNodes(children, ctx)}
        </p>
      );

    case "table":
      return renderTable(node, key, ctx);

    // Rows and cells are only ever reached through renderTable, which knows whether a row belongs in
    // the head or the body. Reaching one here means the document nested it somewhere impossible.
    case "tableRow":
    case "tableHeader":
    case "tableCell":
      return null;

    case "callout":
      return renderCallout(node, key, ctx);

    case "footnote":
      return renderFootnoteMarker(node, key, ctx);

    default:
      return renderUnknown(node, key);
  }
}

function renderHeading(node: RichTextNode, key: string, ctx: RenderContext): ReactNode {
  const level = headingLevelOf(node);
  const Tag = HEADING_TAGS[level];
  const id = ctx.headingIds.get(node);
  const align = textAlignOf(node);

  return (
    <Tag
      key={key}
      id={id}
      // globals.css gives `[id][data-anchor]` the header clearance. Restating it as a `scroll-mt-*`
      // per heading is how two numbers meaning one thing drift apart (contract §7).
      data-anchor={id ? "" : undefined}
      className={cn(HEADING_BASE, ctx.scale.heading[level], align && TEXT_ALIGN_CLASSES[align])}
    >
      {renderNodes(node.content ?? [], ctx)}
      {id ? (
        <a
          href={`#${id}`}
          className="ml-2 inline-flex align-middle text-ink-300 opacity-0 transition-opacity hover:text-purple-700 focus-visible:opacity-100 group-hover:opacity-100 dark:hover:text-purple-300"
        >
          <Hash className="h-[0.7em] w-[0.7em]" aria-hidden="true" />
          <span className="sr-only">Link to this section</span>
        </a>
      ) : null}
    </Tag>
  );
}

/**
 * A dividing line, in one of two treatments.
 *
 * `hairline` is the `<hr>` this file always drew, and it is what every rule saved before the variant
 * existed reads back as (`ruleVariantOf` defaults to it) — so no published page changed.
 *
 * `ornament` cannot be an `<hr>`, because an `<hr>` is a void element and an ornament has something in
 * the middle of it. ⚠ THE DOTS ARE DRAWN, NOT TYPED. A typographic ornament character (❧, ❊, ⁂)
 * depends on a font that carries it, and neither local face does (contract §2) — so it would arrive as
 * whatever the system fallback has, or as a blank box. Three `rounded-full` spans always look the same.
 */
function renderRule(node: RichTextNode, key: string, ctx: RenderContext): ReactNode {
  if (ruleVariantOf(node) === "ornament") {
    return (
      <div key={key} role="separator" className={ctx.scale.ruleOrnament}>
        {[0, 1, 2].map((dot) => (
          <span key={dot} aria-hidden="true" className="block h-1 w-1 rounded-full bg-ink-300" />
        ))}
      </div>
    );
  }

  // No border-width utility: preflight already gives `<hr>` a 1px top border. Naming the colour
  // is not optional — an unnamed border is preflight's literal gray-200, which does not invert.
  return <hr key={key} className={ctx.scale.rule} />;
}

/**
 * A figure: a picture with a caption an author actually typed.
 *
 * ⚠ INSIDE A FIGURE, THE PICTURE'S OWN `caption` ATTRIBUTE IS IGNORED. The `figureCaption` child is
 * the caption, and the media library's stored caption was copied into it when the figure was inserted.
 * Drawing both would print the credit twice, once frozen at the moment of insertion and once as the
 * author since rewrote it.
 *
 * A figure with no picture child is impossible under the schema and still handled, because a `Json`
 * column outlives the code that wrote it: it draws the same "not available" panel a broken picture
 * gets, so the caption's words survive and the gap is stated rather than left blank (contract §1.6).
 */
function renderFigure(node: RichTextNode, key: string, ctx: RenderContext): ReactNode {
  const children = node.content ?? [];
  const picture = children.find((child) => child.type === "image") ?? null;
  const captionNode = children.find((child) => child.type === "figureCaption") ?? null;
  const captionContent = captionNode?.content ?? [];

  return (
    <figure key={key} className={ctx.scale.figure}>
      {picture ? renderPicture(picture, ctx) : renderUnavailablePicture()}
      {captionContent.length > 0 ? (
        <figcaption className={ctx.scale.caption}>{renderNodes(captionContent, ctx)}</figcaption>
      ) : null}
    </figure>
  );
}

/**
 * SAY SO RATHER THAN LEAVE A GAP (contract §1.6). An image dropped silently from the middle of an
 * article is indistinguishable from an article that never had one, and the editor who could fix it is
 * the person least likely to notice.
 */
function renderUnavailablePicture(): ReactNode {
  return (
    <div className="flex items-center gap-3 rounded-md border border-dashed border-line-200 bg-surface-50 px-4 py-6 text-sm text-ink-500">
      <ImageOff className="h-5 w-5 shrink-0" aria-hidden="true" />
      <span>This image is not available. Its file may have been moved or removed.</span>
    </div>
  );
}

/**
 * The picture ALONE — no `<figure>`, no caption.
 *
 * Split out because a picture now reaches the page two ways: as a bare `image` node (every document
 * written before the figure existed, captioned by an attribute) and as the first child of a `figure`
 * (captioned by a sibling node). One implementation of "how a stored picture becomes an `<img>`" is
 * what stops the two drifting into different `sizes` values and different placeholder behaviour.
 */
function renderPicture(node: RichTextNode, ctx: RenderContext): ReactNode {
  const image = imageAttrsOf(node);
  const asset = image.objectKey
    ? {
        objectKey: image.objectKey,
        width: image.width,
        height: image.height,
        altText: image.altText,
        blurDataUrl: image.blurDataUrl
      }
    : null;

  // A media-library asset resolves through the CDN; an imported document may already carry a URL.
  // `mediaSrc` returns null rather than a guess when no public base is configured.
  //
  // The node stores only the ORIGINAL's key, never the variant list: a list embedded in a document
  // goes stale the moment the derivative pipeline is re-run with better settings. next/image's
  // optimiser produces the served widths from `sizes` instead.
  const src = asset ? mediaSrc(asset, 1600) : image.src;
  const alt = mediaAlt({ altText: image.altText });

  if (!src) return renderUnavailablePicture();

  // Dimensions are recorded at upload. When a document predates that, a 3:2 placeholder reserves
  // roughly the right space: `h-auto` means the browser corrects the height from the real image once
  // it loads, so a wrong ratio costs a small layout shift rather than a distorted picture.
  const width = image.width ?? 1600;
  const height = image.height ?? 1067;
  const blur = image.blurDataUrl?.startsWith("data:") ? image.blurDataUrl : null;

  return (
    <Image
      src={src}
      alt={alt}
      width={width}
      height={height}
      sizes={ctx.scale.imageSizes}
      className="h-auto w-full rounded-md border border-line-200"
      {...(blur ? { placeholder: "blur" as const, blurDataURL: blur } : {})}
    />
  );
}

/**
 * A bare `image` node — the shape EVERY document written before the `figure` node used, and the shape
 * an imported document still uses.
 *
 * It keeps the attribute-borne caption it always had. This is not a legacy path to be tidied away
 * later: nothing migrates a `Json` column, so both shapes are permanently live and both must render.
 */
function renderImage(node: RichTextNode, key: string, ctx: RenderContext): ReactNode {
  const caption = imageAttrsOf(node).caption;

  return (
    <figure key={key} className={ctx.scale.figure}>
      {renderPicture(node, ctx)}
      {caption ? <figcaption className={ctx.scale.caption}>{caption}</figcaption> : null}
    </figure>
  );
}

function renderTable(node: RichTextNode, key: string, ctx: RenderContext): ReactNode {
  const rows = (node.content ?? []).filter((row) => row.type === "tableRow");
  if (rows.length === 0) return null;

  // A first row made entirely of header cells becomes a real `<thead>`, so a screen reader can
  // announce the column a cell belongs to instead of reading a grid of unlabelled numbers.
  const firstRow = rows[0];
  const firstCells = firstRow?.content ?? [];
  const headerRow =
    firstRow && firstCells.length > 0 && firstCells.every((cell) => cell.type === "tableHeader")
      ? firstRow
      : null;
  const bodyRows = headerRow ? rows.slice(1) : rows;

  return (
    <div
      key={key}
      className={ctx.scale.tableFrame}
      // A WIDE TABLE SCROLLS INSIDE ITS OWN BOX. Letting it widen the page turns every other
      // section on the page into a sideways-scrolling one. The region is focusable because a
      // scrollable area that only a mouse can reach is not keyboard operable.
      role="region"
      aria-label="Table"
      tabIndex={0}
    >
      <table className="w-full border-collapse text-left">
        {headerRow ? (
          <thead className="border-b border-line-200 bg-surface-100">
            {renderTableRow(headerRow, "head-row", ctx, true)}
          </thead>
        ) : null}
        <tbody className="divide-y divide-line-200">
          {bodyRows.map((row, index) => renderTableRow(row, `row-${index}`, ctx, false))}
        </tbody>
      </table>
    </div>
  );
}

function renderTableRow(
  row: RichTextNode,
  key: string,
  ctx: RenderContext,
  inHead: boolean
): ReactNode {
  const cells = row.content ?? [];
  return (
    <tr key={key}>
      {cells.map((cell, index) => {
        const { colSpan, rowSpan } = cellSpansOf(cell);
        const cellKey = `cell-${index}`;
        if (cell.type === "tableHeader") {
          return (
            <th
              key={cellKey}
              // A header cell outside the head is a row label, and `scope` is what tells a screen
              // reader which of the two it is.
              scope={inHead ? "col" : "row"}
              colSpan={colSpan > 1 ? colSpan : undefined}
              rowSpan={rowSpan > 1 ? rowSpan : undefined}
              className={cn(ctx.scale.cell, "align-top font-semibold text-ink-900")}
            >
              {renderNodes(cell.content ?? [], ctx)}
            </th>
          );
        }
        return (
          <td
            key={cellKey}
            colSpan={colSpan > 1 ? colSpan : undefined}
            rowSpan={rowSpan > 1 ? rowSpan : undefined}
            className={cn(ctx.scale.cell, "align-top")}
          >
            {renderNodes(cell.content ?? [], ctx)}
          </td>
        );
      })}
    </tr>
  );
}

function renderCallout(node: RichTextNode, key: string, ctx: RenderContext): ReactNode {
  const tone = calloutToneOf(node);
  const style = CALLOUT_STYLES[tone];
  const Icon = style.icon;

  return (
    <div key={key} className={ctx.scale.callout}>
      <p className="flex items-center gap-2">
        <span
          className={cn("inline-flex h-6 w-6 shrink-0 items-center justify-center rounded", style.chip)}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">
          {style.label}
        </span>
      </p>
      <div className={ctx.scale.calloutBody}>{renderNodes(node.content ?? [], ctx)}</div>
    </div>
  );
}

function renderFootnoteMarker(node: RichTextNode, key: string, ctx: RenderContext): ReactNode {
  const entry = ctx.footnotes.get(node);
  if (!entry) return null;

  const marker = (
    <sup
      key={key}
      id={entry.listed ? `footnote-ref-${entry.index}` : undefined}
      data-anchor={entry.listed ? "" : undefined}
      className="ml-0.5 text-[0.7em] font-semibold text-purple-700 dark:text-purple-300"
    >
      {entry.listed ? (
        <a href={`#footnote-${entry.index}`} className="no-underline hover:underline">
          {entry.index}
          <span className="sr-only"> — see footnote {entry.index}</span>
        </a>
      ) : (
        entry.index
      )}
    </sup>
  );

  return marker;
}

/**
 * A node type this renderer does not know.
 *
 * In production it renders NOTHING — a document written by a newer studio must not be able to crash
 * a published page, and a reader is better served by a missing block than by an error page.
 *
 * In development it renders a marker naming the type, because the silent version of this is a block
 * that quietly disappears and nobody finds out until an editor asks why their table vanished.
 */
function renderUnknown(node: RichTextNode, key: string): ReactNode {
  if (process.env.NODE_ENV === "production") return null;
  return (
    <span
      key={key}
      className="my-1 inline-block rounded border border-dashed border-line-200 px-1.5 py-0.5 align-middle font-mono text-xs text-ink-500"
    >
      Unsupported block: {node.type}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function RichText({ value, variant = "article", className }: RichTextProps): ReactNode {
  const doc = parseRichText(value);

  // Nothing at all for an empty document, not an empty styled container: a `<div>` carrying the
  // prose margins where a body used to be leaves a gap the page's own spacing has already paid for.
  // Callers that want a fallback ("No biography has been added yet") render it themselves.
  if (!doc || isEmptyRichText(doc)) return null;

  const scale = SCALES[variant];
  const { map: footnotes, listed } = collectFootnotes(doc);
  const ctx: RenderContext = { scale, headingIds: richTextHeadingIds(doc), footnotes };

  return (
    <div className={cn(scale.root, className)}>
      {renderNodes(doc.content, ctx)}

      {listed.length > 0 ? (
        <section aria-label="Footnotes" className={scale.footnotes}>
          <ol className="list-decimal pl-5">
            {listed.map((item) => (
              <li
                key={item.index}
                id={`footnote-${item.index}`}
                data-anchor=""
                // `value` keeps the printed number in step with the marker in the text. Footnotes
                // with no body are numbered but not listed, so plain sequential numbering here would
                // disagree with the superscripts.
                value={item.index}
                className="mt-2 first:mt-0 marker:text-ink-300"
              >
                {renderNodes(item.node.content ?? [], ctx)}
                <a
                  href={`#footnote-ref-${item.index}`}
                  className="ml-1.5 inline-flex align-middle text-ink-300 transition-colors hover:text-purple-700 dark:hover:text-purple-300"
                >
                  <CornerDownLeft className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="sr-only">Back to footnote {item.index} in the text</span>
                </a>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

export default RichText;
