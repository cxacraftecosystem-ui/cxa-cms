/**
 * The editor's extension set — the single definition of what an author is able to write.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS FILE AND `components/RichText.tsx` ARE ONE CONTRACT. Every node and every mark registered
 *   below must be one the renderer knows how to draw.
 *
 *   An editor that can produce a node the renderer does not draw is a way for an author to write
 *   content that SILENTLY VANISHES WHEN PUBLISHED. `renderUnknown()` in RichText.tsx renders nothing
 *   at all in production: the author sees their table in the studio, saves, and the published page
 *   simply has a gap where it was. Nobody is told, and the person who could fix it is the least
 *   likely to notice.
 *
 *   The allowed set is written down once, in `lib/richtext.ts` (`RICH_TEXT_NODE_TYPES` and
 *   `RICH_TEXT_MARK_TYPES`), and `describeSchemaDrift()` at the foot of this file compares the built
 *   schema against it. RichTextEditor calls it in development and warns. Adding an extension here
 *   means adding a case to RichText.tsx in the same change — or the drift check will say so.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHERE EACH PART OF THE SET COMES FROM:
 *
 *   doc, paragraph, text, hardBreak,      StarterKit
 *   blockquote, codeBlock, horizontalRule,
 *   heading (levels 1–4 only),
 *   bulletList, orderedList, listItem
 *   bold, italic, strike, code, underline  StarterKit
 *   link                                   @tiptap/extension-link, configured below
 *   subscript, superscript, highlight      their own packages
 *   image                                  @tiptap/extension-image, extended below
 *   table/tableRow/tableHeader/tableCell   @tiptap/extension-table*
 *   callout, footnote,                     defined here with `Node.create`
 *   leadParagraph, dropCap, pullQuote,
 *   attribution, sideNote, columns,
 *   definitionList/Term/Details,
 *   figure, figureCaption
 *   smallCaps, tracking, textColour        defined here with `Mark.create`
 *   horizontalRule.variant,                defined here with `addGlobalAttributes` — see
 *   codeBlock's `data-language`            `RichTextBlockAttributes`
 *
 * NOTHING BELOW ADDS A PACKAGE. Everything new is built from `@tiptap/core`'s `Node`, `Mark` and
 * `Extension` primitives, for the same reason `Callout` and `Footnote` always were: the dependency
 * list is closed (contract §13) and a bespoke node we own is a node whose stored shape we control.
 *
 * ⚠ THERE IS DELIBERATELY NO TASK LIST. StarterKit 3 does not carry `TaskList`/`TaskItem` — they live
 * in `@tiptap/extension-list`, which is present in `node_modules` only as a transitive dependency of
 * the starter kit and is NOT declared in package.json. Importing it would be adding an undeclared
 * dependency, which is worse than not having a checklist: the next `npm install` that flattens
 * differently breaks the studio's writing surface. If a checklist is genuinely wanted, declare the
 * package first and add `TaskList`/`TaskItem` here, a `taskList`/`taskItem` pair to
 * `RICH_TEXT_NODE_TYPES`, and a branch to RichText.tsx that renders a DISABLED checkbox — a published
 * page must not offer a control that cannot record anything.
 *
 * NO `"use client"`. This module is plain data and plain functions; the directive belongs on the
 * components that mount an editor. It must stay importable from a route handler too, because
 * `classifyEditorHref()` is the same rule the API layer should apply to a pasted link.
 */

import {
  Extension,
  Mark,
  Node,
  mergeAttributes,
  type Extensions
} from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import Highlight from "@tiptap/extension-highlight";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import TextAlign from "@tiptap/extension-text-align";
import Placeholder from "@tiptap/extension-placeholder";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";

import {
  CALLOUT_TONES,
  COLUMN_COUNTS,
  ORDERED_LIST_MARKERS,
  RICH_TEXT_MARK_TYPES,
  RICH_TEXT_NODE_TYPES,
  RULE_VARIANTS,
  TEXT_COLOURS,
  TRACKING_AMOUNTS,
  codeLanguageLabel,
  type CalloutTone,
  type ColumnCount,
  type OrderedListMarker,
  type RichTextHeadingLevel,
  type RuleVariant,
  type TextColourName,
  type TrackingAmount
} from "@/lib/richtext";

// ─────────────────────────────────────────────────────────────────────────────
// Heading levels
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 1–4, and no more.
 *
 * Levels 5 and 6 have no visual distinction at body size — RichText.tsx renders level 4 at `text-lg`
 * and there is nothing smaller left that still reads as a heading — so their only real effect is to
 * weaken the outline and the table of contents built from it. `lib/richtext.ts` clamps to 1–4 when
 * reading, so a document that arrived from elsewhere with an h5 is read as an h1; registering the
 * level here as well would let an author create that confusion deliberately.
 */
export const EDITOR_HEADING_LEVELS: readonly RichTextHeadingLevel[] = [1, 2, 3, 4];

// ─────────────────────────────────────────────────────────────────────────────
// Links — one rule, shared with the renderer
// ─────────────────────────────────────────────────────────────────────────────

export type EditorHrefKind =
  /** Nothing typed yet. */
  | "empty"
  /** `/research`, `#method`, `?page=2` — resolves on this site. */
  | "internal"
  /** An absolute http(s) URL to somewhere else. */
  | "external"
  /** `mailto:` or `tel:` — not a page, but a legitimate destination. */
  | "plain"
  /** `example.org/page`: probably meant to be external, but a browser will resolve it relatively. */
  | "no-protocol"
  /** `javascript:`, `data:`, anything else with a scheme. The renderer drops the anchor entirely. */
  | "unsafe";

export interface EditorHref {
  kind: EditorHrefKind;
  /** The href as it should be stored. Trimmed; never rewritten behind the author's back. */
  href: string;
  /** For `no-protocol`, the address we would suggest instead. Null otherwise. */
  suggestion: string | null;
}

/**
 * Classify a typed address.
 *
 * ⚠ THIS MIRRORS `classifyHref()` IN components/RichText.tsx ON PURPOSE, and the two must stay in
 * step. The renderer refuses to emit an anchor for anything it considers unsafe — a stored
 * `javascript:` href is script execution dressed as prose — so a link the editor happily accepts and
 * the renderer silently downgrades to plain text is a link the author believes they made. Better to
 * refuse it here, in front of the person who typed it, with a sentence saying why.
 */
export function classifyEditorHref(raw: string): EditorHref {
  const href = raw.trim();
  if (href.length === 0) return { kind: "empty", href, suggestion: null };

  if (href.startsWith("/") || href.startsWith("#") || href.startsWith("?")) {
    return { kind: "internal", href, suggestion: null };
  }

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();

  if (!scheme) {
    // No scheme and no leading slash. A browser resolves this against the current page, which is
    // almost never what somebody typing "example.org" meant.
    return { kind: "no-protocol", href, suggestion: `https://${href}` };
  }
  if (scheme === "mailto" || scheme === "tel") return { kind: "plain", href, suggestion: null };
  if (scheme !== "http" && scheme !== "https") return { kind: "unsafe", href, suggestion: null };

  try {
    // Parsed rather than pattern-matched: "https://" on its own passes a regex and is not a URL.
    new URL(href);
    return { kind: "external", href, suggestion: null };
  } catch {
    return { kind: "unsafe", href, suggestion: null };
  }
}

/** Would the renderer draw an anchor for this? The LinkDialog will not save anything else. */
export function isStorableEditorHref(raw: string): boolean {
  const kind = classifyEditorHref(raw).kind;
  return kind === "internal" || kind === "external" || kind === "plain" || kind === "no-protocol";
}

// ─────────────────────────────────────────────────────────────────────────────
// The callout node
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The tone words are the renderer's words.
 *
 * RichText.tsx labels the four tones "Note", "Tip", "Warning" and "Important" and draws each with an
 * icon. If the studio calls the last one "Danger", an author picks a word they will never see on the
 * published page — so these labels are copied from there deliberately, and moving one means moving
 * both. The icon names match too, for the same reason.
 */
export const CALLOUT_TONE_LABELS: Record<CalloutTone, string> = {
  note: "Note",
  tip: "Tip",
  warning: "Warning",
  danger: "Important"
};

/** One sentence per tone, for the insert menu. Says when to use it, not what it looks like. */
export const CALLOUT_TONE_HINTS: Record<CalloutTone, string> = {
  note: "An aside the reader can take or leave.",
  tip: "Advice that makes something easier.",
  warning: "Something that could go wrong.",
  danger: "Something the reader must not miss."
};

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      /** Wrap the current block in a callout of this tone. */
      setCallout: (tone: CalloutTone) => ReturnType;
      /** Wrap, unwrap, or change the tone of the callout the cursor is in. */
      toggleCallout: (tone: CalloutTone) => ReturnType;
      /** Unwrap the callout, keeping its contents as ordinary blocks. */
      unsetCallout: () => ReturnType;
    };
    footnote: {
      /** Insert a footnote after the selection. `text` seeds its body. */
      insertFootnote: (text?: string) => ReturnType;
    };
    richTextTypography: {
      /** Small caps on or off across the selection. */
      toggleSmallCaps: () => ReturnType;
      /** Apply one of the three named letter-spacing steps. */
      setTracking: (amount: TrackingAmount) => ReturnType;
      /** Back to the face's own spacing. */
      unsetTracking: () => ReturnType;
      /** One of the three brand text colours. There is no free-hex form of this command, ever. */
      setTextColour: (value: TextColourName) => ReturnType;
      /** Back to the inherited body colour. */
      unsetTextColour: () => ReturnType;
    };
    richTextBlocks: {
      /** Standfirst ↔ ordinary paragraph. */
      toggleLeadParagraph: () => ReturnType;
      /** Drop-cap opener ↔ ordinary paragraph. */
      toggleDropCap: () => ReturnType;
      /** Wrap in — or unwrap from — a display pull quote. */
      togglePullQuote: () => ReturnType;
      /** Wrap in — or unwrap from — a quiet side note. */
      toggleSideNote: () => ReturnType;
      /** Wrap in — or unwrap from — a multi-column passage. */
      toggleColumns: (count: ColumnCount) => ReturnType;
      /** Change an existing passage's column count without unwrapping it. */
      setColumnCount: (count: ColumnCount) => ReturnType;
      /** Put the caret in the enclosing quote's attribution line, adding one if it has none. */
      setAttribution: () => ReturnType;
      /** Remove the attribution line the caret is in. */
      unsetAttribution: () => ReturnType;
      /** A fresh definition list with one empty term and one empty description. */
      insertDefinitionList: () => ReturnType;
      /** A picture with an editable caption. `caption` seeds the caption from the media library. */
      insertFigure: (image: Record<string, unknown>, caption?: string | null) => ReturnType;
      /** A dividing line of the given treatment. */
      setRule: (variant: RuleVariant) => ReturnType;
    };
    richTextVideo: {
      /** A video block: a film from the media library, or an address on a service that hosts one. */
      insertVideoEmbed: (attributes: Record<string, unknown>) => ReturnType;
      /**
       * Rewrite the attributes of the video the selection is on.
       *
       * ⚠ EVERY VIDEO THE SELECTION COVERS, NOT THE FIRST — that is what `updateAttributes` does, and
       * it is stated here because it is the one way this command can surprise somebody. A selection
       * dragged across two adjacent videos and then edited gives both the same title, address and
       * caption. In practice the dialog is opened from a caret or a node selection, which is one
       * video; the case worth knowing about is a deliberate sweep over two.
       */
      updateVideoEmbed: (attributes: Record<string, unknown>) => ReturnType;
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Where a new block goes
// ─────────────────────────────────────────────────────────────────────────────

interface BlockInsertion {
  /** Where to write. A RANGE when an empty block is being replaced outright. */
  at: number | { from: number; to: number };
  /** The document position the inserted node will start at, for placing the caret afterwards. */
  base: number;
}

/**
 * Decide where a block of `typeName` should land, and where its opening token will be. Null when
 * there is nowhere legal for it.
 *
 * TWO CASES, AND THE DIFFERENCE MATTERS TO AN AUTHOR. An empty paragraph is scaffolding — it is what
 * Tiptap leaves behind after Enter — so "insert a table here" means *here*, replacing it. A paragraph
 * with words in it is content, so the new block goes AFTER it: a command that swallowed the sentence
 * somebody had just written would be a data-loss bug dressed up as a formatting command (the same rule
 * `insertFootnote` follows).
 *
 * ⚠ IT ASKS THE SCHEMA BEFORE IT ANSWERS, AND CLIMBS WHEN THE ANSWER IS NO. The caret can sit in
 * places that hold inline content but no blocks at all — a figure's caption, a credit line, a
 * definition term — and simply inserting "after the current block" there produces a step ProseMirror
 * refuses, which is a toolbar button that does nothing at all when pressed. So each level is tested
 * with `canReplaceWith` and the search moves outwards until a container accepts the node. Returning
 * null when none does is what makes `editor.can()` false, and therefore what greys the control out
 * instead of leaving a live button that is quietly inert.
 *
 * `base` is returned rather than recomputed by the caller because every one of these commands then
 * needs to put the caret inside the thing it made — into a caption, into a definition term — and
 * counting tokens forwards from a known start is the only way to do that reliably. Positions are
 * one-per-token: `base + 1` is inside the new node, and each further open token costs one more.
 *
 * The loop stops above depth 0 and falls through to null rather than reading `$from.before(0)`, which
 * throws. Depth 0 is a real state, not a defensive nicety: a NodeSelection on a top-level block —
 * click a picture, then press a toolbar button — resolves to exactly that.
 */
function blockInsertionAt(state: EditorState, typeName: string): BlockInsertion | null {
  const type = state.schema.nodes[typeName];
  if (!type) return null;

  const { $from } = state.selection;

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const container = $from.node(depth - 1);
    const index = $from.indexAfter(depth - 1);
    const node = $from.node(depth);

    if (
      depth === $from.depth &&
      node.isTextblock &&
      node.content.size === 0 &&
      // The container must still hold a legal set of children once the empty block is gone — a side
      // note is `paragraph+`, so swapping its only paragraph for a table would leave it invalid.
      container.canReplaceWith(index - 1, index, type)
    ) {
      const before = $from.before(depth);
      return { at: { from: before, to: $from.after(depth) }, base: before };
    }

    if (container.canReplaceWith(index, index, type)) {
      const after = $from.after(depth);
      return { at: after, base: after };
    }
  }

  return null;
}

/** The quote types an attribution line may close. Both are drawn with a `<footer>` by the renderer. */
const QUOTE_NODE_NAMES = ["blockquote", "pullQuote"] as const;

/**
 * A boxed aside. `content: "block+"` so a callout may hold more than one paragraph — a warning with a
 * list under it is the ordinary case, and the renderer draws its children through the same node
 * switch as the rest of the document.
 *
 * `defining: true` keeps the box intact when the author selects everything inside it and types over
 * the top; without it the replacement lands outside the callout and the box is quietly lost.
 */
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addOptions() {
    return { HTMLAttributes: {} as Record<string, unknown> };
  },

  addAttributes() {
    return {
      tone: {
        default: "note",
        // An unrecognised tone becomes `note` — the neutral one, never `danger`. This is the same
        // decision `calloutToneOf()` makes when reading, so a pasted box cannot arrive shouting.
        parseHTML: (element: HTMLElement) => {
          const raw = element.getAttribute("data-callout")?.toLowerCase();
          return CALLOUT_TONES.find((tone) => tone === raw) ?? "note";
        },
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-callout": typeof attributes.tone === "string" ? attributes.tone : "note"
        })
      }
    };
  },

  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },

  addCommands() {
    return {
      setCallout:
        (tone: CalloutTone) =>
        ({ commands }) =>
          commands.wrapIn(this.name, { tone }),

      toggleCallout:
        (tone: CalloutTone) =>
        ({ editor, commands }) => {
          // Already a callout of a DIFFERENT tone: change the tone rather than unwrapping and
          // re-wrapping, which would lose the selection and, in a nested list, the indentation.
          if (editor.isActive(this.name) && !editor.isActive(this.name, { tone })) {
            return commands.updateAttributes(this.name, { tone });
          }
          return commands.toggleWrap(this.name, { tone });
        },

      unsetCallout:
        () =>
        ({ commands }) =>
          commands.lift(this.name)
    };
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The footnote node
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Seeded into a new footnote and left SELECTED, so the first keystroke replaces it.
 *
 * An empty inline node is a zero-width target: the author cannot see it, cannot reliably click into
 * it, and a footnote with no body is numbered but not listed by the renderer. Placing visible,
 * pre-selected words costs one keystroke and makes the node findable.
 */
export const FOOTNOTE_PLACEHOLDER_TEXT = "Add the source here";

/** Non-cryptographic and only ever generated in the browser, on a click. */
function newFootnoteId(): string {
  return `fn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * A footnote: an INLINE node that carries its own body.
 *
 * The body lives in the node rather than in a separate list at the end of the document, because the
 * renderer numbers footnotes by DOCUMENT ORDER (see `collectFootnotes` in RichText.tsx) and moving a
 * sentence must move its note with it. In the studio the body therefore sits inline, styled as a
 * small chip; when published it moves to the numbered list at the foot of the article. The `title`
 * attribute below is the one-line explanation of that, available on hover.
 *
 * `id` is provenance only. The renderer builds its anchors from position, precisely because two
 * footnotes may share an id or carry none — so nothing breaks if this value is missing or duplicated.
 * It renders as `data-footnote-id`, never as a DOM `id`, which would collide with the page's own ids.
 */
export const Footnote = Node.create({
  name: "footnote",
  inline: true,
  group: "inline",
  content: "inline*",

  addOptions() {
    return { HTMLAttributes: {} as Record<string, unknown> };
  },

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-footnote-id"),
        renderHTML: (attributes: Record<string, unknown>) =>
          typeof attributes.id === "string" && attributes.id.length > 0
            ? { "data-footnote-id": attributes.id }
            : {}
      }
    };
  },

  parseHTML() {
    return [{ tag: "sup[data-footnote]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "sup",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        "data-footnote": "",
        title: "Footnote. This text moves to the bottom of the published page."
      }),
      0
    ];
  },

  addCommands() {
    return {
      insertFootnote:
        (text?: string) =>
        ({ chain, editor, state }) => {
          // A footnote inside a footnote would be numbered twice and read as a marker inside a note.
          // Refusing here also greys the toolbar button out while the caret is in one, because the
          // toolbar asks `can().insertFootnote()`.
          if (editor.isActive(this.name)) return false;

          const body = (text ?? "").trim() || FOOTNOTE_PLACEHOLDER_TEXT;
          // Inserted AFTER the selection, never over it. A footnote button that ate the sentence the
          // author had highlighted would be a data-loss bug dressed up as a formatting command.
          const at = state.selection.to;
          return chain()
            .insertContentAt(at, {
              type: this.name,
              attrs: { id: newFootnoteId() },
              content: [{ type: "text", text: body }]
            })
            // +1 steps over the node's own opening token; the body then runs for its own length.
            .setTextSelection({ from: at + 1, to: at + 1 + body.length })
            .run();
        }
    };
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Typographic marks
//
// Three marks that a house style needs and a word processor's bold/italic pair cannot express. Each
// one stores a NAMED STEP, never a raw CSS value: the renderer maps the name to a complete literal
// Tailwind class, so the same mark is the same size and the same hue in both themes and on both the
// public page and the studio preview. A stored `letter-spacing: 0.17em` would be none of those things.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Small caps.
 *
 * ⚠ THE FACE HAS NO REAL SMALL-CAP GLYPHS. Inter's variable file (contract §2) ships no `smcp`
 * feature, so browsers SYNTHESISE small caps by scaling capitals down. That is why the mark is
 * `font-variant-caps` rather than `text-transform: uppercase` plus a smaller size: synthesis keeps the
 * text as the author typed it, so it still copies, searches and reads aloud as "BCE" and not "bce".
 * A transform would change the letters themselves.
 *
 * The two `style` parse rules are what make a paste from a word processor keep the intent. Word and
 * Google Docs express small caps as an inline style and nothing else; without these the formatting is
 * dropped on arrival and the author has to reapply it by hand across a whole pasted article.
 */
export const SmallCaps = Mark.create({
  name: "smallCaps",

  addOptions() {
    return { HTMLAttributes: {} as Record<string, unknown> };
  },

  parseHTML() {
    return [
      { tag: "span[data-small-caps]" },
      {
        style: "font-variant-caps",
        getAttrs: (value: string) => (value === "small-caps" ? {} : false)
      },
      {
        style: "font-variant",
        getAttrs: (value: string) => (value === "small-caps" ? {} : false)
      }
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { "data-small-caps": "" }),
      0
    ];
  },

  addCommands() {
    return {
      toggleSmallCaps:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name)
    };
  },

  addKeyboardShortcuts() {
    // Mod+Shift+K, beside Mod+K for a link. Mod+K itself is taken, and small caps is the one of these
    // three marks an author reaches for often enough to want a key for.
    return { "Mod-Shift-k": () => this.editor.commands.toggleSmallCaps() };
  }
});

/**
 * Letter spacing, as one of three named steps.
 *
 * `wide` is the default because it is the one people mean: a run of capitals or small caps set at the
 * body's own spacing looks cramped, and opening it slightly is the fix. `tight` exists for a long
 * display word, `wider` for a spaced-out label.
 */
export const Tracking = Mark.create({
  name: "tracking",

  addOptions() {
    return { HTMLAttributes: {} as Record<string, unknown> };
  },

  addAttributes() {
    return {
      amount: {
        default: "wide",
        // An unrecognised step becomes `wide` rather than nothing, on the same reasoning as
        // `calloutToneOf`: the author asked for spacing, so give them the middle of the three.
        parseHTML: (element: HTMLElement) => {
          const raw = element.getAttribute("data-tracking")?.toLowerCase();
          return TRACKING_AMOUNTS.find((amount) => amount === raw) ?? "wide";
        },
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-tracking": typeof attributes.amount === "string" ? attributes.amount : "wide"
        })
      }
    };
  },

  parseHTML() {
    return [{ tag: "span[data-tracking]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },

  addCommands() {
    return {
      setTracking:
        (amount: TrackingAmount) =>
        ({ commands }) =>
          // `setMark` rather than `toggleMark`: picking "wider" while "wide" is on means "make it
          // wider", not "turn spacing off".
          commands.setMark(this.name, { amount }),

      unsetTracking:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name)
    };
  }
});

/**
 * Text colour, from the three-value brand ramp and from nowhere else.
 *
 * ⚠ THERE IS NO COLOUR PICKER AND THERE MUST NEVER BE ONE. See the note on `TEXT_COLOURS` in
 * lib/richtext.ts for the whole reason; the short version is contract §1.1 — purple-700 is the only
 * action colour, every neutral goes through the themed ink ladder, and a stored hex satisfies neither
 * and does not invert. `setTextColour` takes a `TextColourName`, so a free value cannot even be
 * expressed in TypeScript, and `textColourOf()` discards anything else on the way back in.
 */
export const TextColour = Mark.create({
  name: "textColour",

  addOptions() {
    return { HTMLAttributes: {} as Record<string, unknown> };
  },

  addAttributes() {
    return {
      value: {
        default: "brand",
        parseHTML: (element: HTMLElement) => {
          const raw = element.getAttribute("data-colour")?.toLowerCase();
          return TEXT_COLOURS.find((colour) => colour === raw) ?? "brand";
        },
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-colour": typeof attributes.value === "string" ? attributes.value : "brand"
        })
      }
    };
  },

  parseHTML() {
    // Only our own marker. A `style="color: …"` parse rule would be the colour picker arriving through
    // the clipboard instead of through a button, which is the same problem wearing a hat.
    return [{ tag: "span[data-colour]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },

  addCommands() {
    return {
      setTextColour:
        (value: TextColourName) =>
        ({ commands }) =>
          commands.setMark(this.name, { value }),

      unsetTextColour:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name)
    };
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Paragraph-shaped blocks
//
// `leadParagraph` and `dropCap` are separate NODES rather than attributes on `paragraph`. Two reasons.
// A node can be reached by `toggleNode`, so the studio's Style menu is one flat list of "what this
// block is" rather than a list plus a set of switches that interact. And an attribute added to
// `paragraph` would be written onto every paragraph in every document the moment the schema changed,
// where an unused node type costs nothing at all.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The standfirst — the larger opening paragraph under a title.
 *
 * ⚠ `priority: 60` on the parse rule, ABOVE paragraph's default of 50. Without it a lead paragraph
 * copied and pasted back into the editor — or a document round-tripped through HTML — matches
 * `paragraph`'s plain `p` rule first and silently becomes an ordinary paragraph. The same applies to
 * `dropCap` and `pullQuote` below.
 */
export const LeadParagraph = Node.create({
  name: "leadParagraph",
  group: "block",
  content: "inline*",

  addOptions() {
    return { HTMLAttributes: {} as Record<string, unknown> };
  },

  parseHTML() {
    return [{ tag: "p[data-lead]", priority: 60 }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "p",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { "data-lead": "" }),
      0
    ];
  },

  addCommands() {
    return {
      toggleLeadParagraph:
        () =>
        ({ commands }) =>
          commands.toggleNode(this.name, "paragraph")
    };
  },

  addKeyboardShortcuts() {
    return { "Mod-Alt-l": () => this.editor.commands.toggleLeadParagraph() };
  }
});

/**
 * A paragraph opening with a drop cap.
 *
 * The cap itself is drawn with CSS `::first-letter` — no wrapper span, no stored "which letter",
 * nothing for an author to keep in step when they rewrite the sentence. The renderer's own comment
 * carries the float-clearing trap that goes with it.
 */
export const DropCap = Node.create({
  name: "dropCap",
  group: "block",
  content: "inline*",

  addOptions() {
    return { HTMLAttributes: {} as Record<string, unknown> };
  },

  parseHTML() {
    return [{ tag: "p[data-drop-cap]", priority: 60 }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "p",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { "data-drop-cap": "" }),
      0
    ];
  },

  addCommands() {
    return {
      toggleDropCap:
        () =>
        ({ commands }) =>
          commands.toggleNode(this.name, "paragraph")
    };
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Quotes, notes and their attribution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A display pull quote, which is NOT a blockquote.
 *
 * The distinction is editorial and it is the reason both exist. A `blockquote` is somebody else's
 * words quoted *inside* the argument, at reading size, in sequence. A pull quote is a sentence lifted
 * OUT of the argument and set large to draw a reader in — usually a sentence that already appears in
 * the prose above it. Set them the same and the second one has no purpose; give an author only the
 * first and they will fake the second with a heading, which puts a non-heading into the page outline
 * and into the table of contents built from it.
 *
 * `content: "block+"` rather than `paragraph+` so an `attribution` fits (see the note on that node).
 */
export const PullQuote = Node.create({
  name: "pullQuote",
  group: "block",
  content: "block+",
  defining: true,

  addOptions() {
    return { HTMLAttributes: {} as Record<string, unknown> };
  },

  parseHTML() {
    return [{ tag: "blockquote[data-pull-quote]", priority: 60 }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "blockquote",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { "data-pull-quote": "" }),
      0
    ];
  },

  addCommands() {
    return {
      togglePullQuote:
        () =>
        ({ commands }) =>
          commands.toggleWrap(this.name)
    };
  },

  addKeyboardShortcuts() {
    return { "Mod-Alt-q": () => this.editor.commands.togglePullQuote() };
  }
});

/**
 * A quiet note beside the argument — the third member of a family that needs all three.
 *
 *   blockquote  someone else's words, reading size, purple rule
 *   sideNote    the author's own aside, SMALLER and greyer, hairline rule, no label
 *   callout     something the reader must not miss: boxed, toned, and it says its tone in a word
 *
 * A side note is the one to reach for when a callout would shout. Giving an author only the callout
 * means every parenthetical remark on the site arrives in a tinted box with "NOTE" over it, and after
 * the third one a reader stops seeing them — which is precisely when the real warning appears.
 *
 * `content: "paragraph+"`: a side note is one or two sentences. A note that can hold a table is a
 * callout that has been misnamed.
 */
export const SideNote = Node.create({
  name: "sideNote",
  group: "block",
  content: "paragraph+",
  defining: true,

  addOptions() {
    return { HTMLAttributes: {} as Record<string, unknown> };
  },

  parseHTML() {
    // Our own marker only. A bare `<aside>` from a pasted web page falls through to its children,
    // which arrive as ordinary paragraphs — nothing is lost, and nothing arbitrary is adopted.
    return [{ tag: "aside[data-side-note]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "aside",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { "data-side-note": "" }),
      0
    ];
  },

  addCommands() {
    return {
      toggleSideNote:
        () =>
        ({ commands }) =>
          commands.toggleWrap(this.name)
    };
  }
});

/**
 * "— Kamala Devi, master dyer". The closing line of a quote.
 *
 * ⚠ IT IS IN GROUP `block`, WHICH IS WIDER THAN IT LOOKS, AND THAT IS A DELIBERATE COMPROMISE.
 * `blockquote` comes from StarterKit and its content expression is `block+`; this file cannot narrow
 * it to `block+ attribution?` without importing and re-declaring `@tiptap/extension-blockquote`, which
 * is not a declared dependency. Being a `block` is therefore the only way an attribution can live
 * inside a quote at all. The consequence is that the schema would also permit one at the top of a
 * document, so the CONSTRAINT LIVES IN THE COMMAND instead: `setAttribution` walks up for a quote and
 * returns false when there is none, which is what greys the control out. A stray attribution written
 * some other way still renders — as a small dashed line — rather than vanishing, which is the right
 * failure for a JSON column that outlives its code.
 */
export const Attribution = Node.create({
  name: "attribution",
  group: "block",
  content: "inline*",
  defining: true,

  addOptions() {
    return { HTMLAttributes: {} as Record<string, unknown> };
  },

  parseHTML() {
    return [{ tag: "footer[data-attribution]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "footer",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { "data-attribution": "" }),
      0
    ];
  },

  addCommands() {
    return {
      setAttribution:
        () =>
        ({ state, chain }) => {
          const { $from } = state.selection;

          for (let depth = $from.depth; depth > 0; depth -= 1) {
            const ancestor = $from.node(depth);
            const isQuote = QUOTE_NODE_NAMES.some((quote) => quote === ancestor.type.name);
            if (!isQuote) continue;

            // Position arithmetic, counted from the quote's end. `$from.after(depth)` is the position
            // AFTER the quote, so `after - 1` is just inside its closing token — where a new
            // attribution goes — and `after - 2` is the last text position inside an attribution that
            // is already the quote's final child.
            const after = $from.after(depth);

            if (ancestor.lastChild?.type.name === this.name) {
              // One attribution per quote. A second would render as two dangling credit lines, so the
              // command puts the caret in the existing one instead — which is what the author wanted.
              return chain().setTextSelection(after - 2).run();
            }

            const at = after - 1;
            return chain()
              .insertContentAt(at, { type: this.name })
              .setTextSelection(at + 1)
              .run();
          }

          // Not inside a quote. Returning false is what makes `can().setAttribution()` false, and
          // therefore what greys the control out instead of inserting a credit line into open prose.
          return false;
        },

      unsetAttribution:
        () =>
        ({ commands }) =>
          commands.deleteNode(this.name)
    };
  },

  addKeyboardShortcuts() {
    return {
      /**
       * Enter in a credit line leaves the QUOTE, not just the line.
       *
       * The attribution is the quote's last child and holds inline content, so ProseMirror's default
       * Enter would split it into a second credit line — and the only way out would be the mouse.
       * The new paragraph therefore goes after the whole quote, which is where the next sentence of
       * the article belongs.
       */
      Enter: () => {
        if (!this.editor.isActive(this.name)) return false;
        const { $from } = this.editor.state.selection;

        for (let depth = $from.depth; depth > 0; depth -= 1) {
          const ancestor = $from.node(depth);
          if (!QUOTE_NODE_NAMES.some((quote) => quote === ancestor.type.name)) continue;
          const at = $from.after(depth);
          return this.editor
            .chain()
            .insertContentAt(at, { type: "paragraph" })
            .setTextSelection(at + 1)
            .run();
        }

        // A stray attribution outside a quote — see the ⚠ on this node. Let ProseMirror do whatever
        // it would have done rather than guess.
        return false;
      }
    };
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Definition lists
//
// A `<dl>` is the right element for a glossary, a materials list, a cast of contributors — anywhere a
// short label is paired with a sentence. Faking one with a bulleted list of "**Term** — meaning" loses
// the pairing for a screen reader, and faking it with a two-column table makes the browser announce
// "row 4 of 19" over every entry.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The list itself.
 *
 * `content: "(definitionTerm | definitionDetails)+"` mirrors HTML: a term may have several
 * descriptions, and a description may be shared by several terms. Requiring strict alternation would
 * refuse both, and both are ordinary.
 *
 * `parseHTML` matches a bare `<dl>`, so a glossary pasted from a web page or a Word file arrives whole
 * — one of the few paste wins available without a converter.
 */
export const DefinitionList = Node.create({
  name: "definitionList",
  group: "block",
  content: "(definitionTerm | definitionDetails)+",
  defining: true,

  addOptions() {
    return { HTMLAttributes: {} as Record<string, unknown> };
  },

  parseHTML() {
    return [{ tag: "dl" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["dl", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },

  addCommands() {
    return {
      insertDefinitionList:
        () =>
        ({ chain, state }) => {
          const target = blockInsertionAt(state, this.name);
          if (!target) return false;
          const { at, base } = target;
          return (
            chain()
              .insertContentAt(at, {
                type: this.name,
                content: [{ type: "definitionTerm" }, { type: "definitionDetails" }]
              })
              // +1 into the list, +1 into the first term. An author who has just asked for a glossary
              // wants to type the first word, not to go looking for where it went.
              .setTextSelection(base + 2)
              .run()
          );
        }
    };
  }
});

/**
 * Enter inside a definition list, for both halves.
 *
 * ONE SHARED FACTORY, because the two rules are mirror images and writing them twice is how they end
 * up disagreeing. From a term, Enter opens its description; from a description, Enter opens the next
 * term. That single behaviour is what makes a `<dl>` typeable at all — without it every entry needs
 * two trips to a menu, and an author writes a bulleted list instead.
 *
 * Enter on an EMPTY half leaves the list, which is the same "press Enter twice to get out" that every
 * list in every editor has taught people to expect. `clearNodes()` is what performs the exit: it lifts
 * the block out of the `<dl>` and normalises it to a paragraph, because `<dl>` does not accept one.
 */
function exitEmptyDefinitionBlock(
  name: string,
  editor: { state: EditorState; commands: { clearNodes: () => boolean } }
): boolean {
  const { $from, empty } = editor.state.selection;
  if (!empty) return false;
  if ($from.parent.type.name !== name) return false;
  if ($from.parent.content.size !== 0) return false;
  return editor.commands.clearNodes();
}

export const DefinitionTerm = Node.create({
  name: "definitionTerm",
  content: "inline*",
  defining: true,

  addOptions() {
    return { HTMLAttributes: {} as Record<string, unknown> };
  },

  parseHTML() {
    return [{ tag: "dt" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["dt", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => {
        if (exitEmptyDefinitionBlock(this.name, this.editor)) return true;
        if (!this.editor.isActive(this.name)) return false;
        return this.editor.chain().splitBlock().setNode("definitionDetails").run();
      }
    };
  }
});

export const DefinitionDetails = Node.create({
  name: "definitionDetails",
  content: "inline*",
  defining: true,

  addOptions() {
    return { HTMLAttributes: {} as Record<string, unknown> };
  },

  parseHTML() {
    return [{ tag: "dd" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["dd", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => {
        if (exitEmptyDefinitionBlock(this.name, this.editor)) return true;
        if (!this.editor.isActive(this.name)) return false;
        return this.editor.chain().splitBlock().setNode("definitionTerm").run();
      }
    };
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-column passages
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A passage set in newspaper columns.
 *
 * ⚠ CSS MULTI-COLUMN, NOT A GRID OF TWO EDITABLE HALVES, and the difference is what makes it usable.
 * Multi-column lets one paragraph FLOW from the foot of the first column to the head of the second, so
 * an author writes ordinary prose and the layout balances itself; a pair of side-by-side boxes makes
 * them decide by hand where the text should break, and that decision is wrong at every window width
 * except the one they made it at. It also collapses to a single column on a narrow screen for free,
 * where two boxes would need a second set of rules.
 */
export const Columns = Node.create({
  name: "columns",
  group: "block",
  content: "block+",
  defining: true,

  addOptions() {
    return { HTMLAttributes: {} as Record<string, unknown> };
  },

  addAttributes() {
    return {
      count: {
        default: 2,
        parseHTML: (element: HTMLElement) => {
          const raw = Number.parseInt(element.getAttribute("data-columns") ?? "", 10);
          return COLUMN_COUNTS.find((count) => count === raw) ?? 2;
        },
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-columns": String(
            COLUMN_COUNTS.find((count) => count === attributes.count) ?? 2
          )
        })
      }
    };
  },

  parseHTML() {
    return [{ tag: "div[data-columns]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },

  addCommands() {
    return {
      toggleColumns:
        (count: ColumnCount) =>
        ({ editor, commands }) => {
          // Already columns, but a different count: change the count. Unwrapping and re-wrapping would
          // lose the selection and, in a nested list, the indentation — the same reasoning as
          // `toggleCallout`.
          if (editor.isActive(this.name) && !editor.isActive(this.name, { count })) {
            return commands.updateAttributes(this.name, { count });
          }
          return commands.toggleWrap(this.name, { count });
        },

      setColumnCount:
        (count: ColumnCount) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, { count })
    };
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Figures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Seeded into an empty caption. Shown by the Placeholder extension, not stored.
 */
export const FIGURE_CAPTION_PLACEHOLDER = "Caption — say what this shows, or credit it";

/**
 * A picture with a caption that is REAL PROSE.
 *
 * The picture node already carried a `caption` attribute, and it was unreachable: it arrived from the
 * media library and there was no way to write or change one in the studio. An attribute could not
 * have been the answer either — a caption routinely wants a link ("Photograph: Anjali Rao") and
 * italics for a species or a title, and an attribute is a flat string.
 *
 * So a figure is a node with two children: the picture, and a `figureCaption` the author types into.
 *
 * ⚠ A BARE `image` STILL RENDERS, AND MUST. Every document saved before today holds one, with its
 * caption in the attribute; `renderImage` in RichText.tsx keeps drawing exactly that. This node is
 * additive — a new way to write a figure, not a migration of the old one.
 *
 * ⚠ INSIDE A FIGURE THE PICTURE'S OWN `caption` ATTRIBUTE IS IGNORED by the renderer, because the
 * `figureCaption` child is the caption. `insertFigure` therefore moves the media library's caption
 * into the child and leaves the attribute null, so the two can never disagree.
 *
 * `content: "image figureCaption"` — the caption node is always present and may be empty, which is
 * what gives the author somewhere to click. Because the picture is required, deleting it on its own is
 * refused by the schema; `figureCaption`'s Backspace rule below is the way out, and it removes the
 * whole figure.
 */
export const Figure = Node.create({
  name: "figure",
  group: "block",
  content: "image figureCaption",
  defining: true,

  addOptions() {
    return { HTMLAttributes: {} as Record<string, unknown> };
  },

  parseHTML() {
    // Our own marker only. `sanitisePastedHtml` in RichTextEditor.tsx unwraps a foreign `<figure>` and
    // turns its `<figcaption>` into a paragraph, so a pasted figure keeps its words even though its
    // remote picture cannot be kept.
    return [{ tag: "figure[data-figure]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "figure",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { "data-figure": "" }),
      0
    ];
  },

  addCommands() {
    return {
      insertFigure:
        (image: Record<string, unknown>, caption?: string | null) =>
        ({ chain, state }) => {
          const target = blockInsertionAt(state, this.name);
          if (!target) return false;
          const { at, base } = target;
          const seeded = (caption ?? "").trim();

          return (
            chain()
              .insertContentAt(at, {
                type: this.name,
                content: [
                  { type: "image", attrs: image },
                  seeded.length > 0
                    ? { type: "figureCaption", content: [{ type: "text", text: seeded }] }
                    : { type: "figureCaption" }
                ]
              })
              // +1 into the figure, +1 past the picture (a childless leaf, so `nodeSize` is 1), +1 into
              // the caption, then to the end of any seeded words so the author carries on rather than
              // overtypes a caption the media library already knew.
              .setTextSelection(base + 3 + seeded.length)
              .run()
          );
        }
    };
  }
});

export const FigureCaption = Node.create({
  name: "figureCaption",
  content: "inline*",
  defining: true,

  addOptions() {
    return { HTMLAttributes: {} as Record<string, unknown> };
  },

  parseHTML() {
    return [{ tag: "figcaption" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["figcaption", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },

  addKeyboardShortcuts() {
    return {
      /**
       * THE WAY OUT OF A FIGURE.
       *
       * The schema requires the picture, so Backspace onto it is refused and an author can find
       * themselves with a figure they cannot delete from the keyboard. Backspace in an EMPTY caption
       * therefore removes the whole figure: clear the words, press Backspace once more, gone. It only
       * fires on an empty caption, so it can never eat a caption somebody had written.
       */
      Backspace: () => {
        const { $from, empty } = this.editor.state.selection;
        if (!empty) return false;
        if ($from.parent.type.name !== this.name) return false;
        if ($from.parent.content.size !== 0) return false;
        return this.editor.commands.deleteNode("figure");
      }
    };
  }
});

/**
 * The words on the card an author sees in the editor, one per provider.
 *
 * ⚠ THEY ARE THE ONLY THING THE EDITOR CAN SHOW, and that is a limitation worth stating rather than
 * papering over. The card is what `renderHTML` emits — there is deliberately no node view (see the
 * node's own header) — so it cannot draw a poster, a thumbnail or the film itself. Naming the service
 * and the film is what makes two videos in one article tellable apart, which is the whole job.
 */
const VIDEO_EMBED_SOURCES: Record<string, string> = {
  upload: "Video — uploaded here",
  youtube: "Video — YouTube",
  vimeo: "Video — Vimeo",
  drive: "Video — Google Drive",
  iframe: "Video — in a frame"
};

/** What a video with nothing chosen yet says. It is a prompt, and it must read as one. */
export const VIDEO_EMBED_PLACEHOLDER = "Add a video";

/**
 * A string attribute carried on one `data-` attribute, in the shape every attribute in this file uses.
 *
 * Written once because the video node needs nine of them and nine copies of the same four lines is
 * where a typo in a `data-` name hides — an attribute that renders under one name and parses under
 * another is silently lost on every copy and paste, with nothing to see in the editor.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE FIELD NAME IS PASSED IN, NOT DERIVED FROM THE `data-` NAME, AND THE FIRST VERSION OF THIS
 * DERIVED IT AND WAS WRONG FOR A THIRD OF THE ATTRIBUTES.
 *
 * `renderHTML` is handed the whole attribute bag rather than the one value, so the helper has to know
 * which key to read. Turning `data-poster-key` into a camelCase key gives `posterKey`, and the field is
 * called `posterObjectKey` — so the read was `undefined`, the branch below returned `{}`, and the
 * attribute was written to the DOM by nothing. `data-captions-key`/`captionsObjectKey` and
 * `data-aspect`/`aspectRatio` were wrong the same way.
 *
 * ⚠ AND IT WOULD HAVE BEEN INVISIBLE IN THE STUDIO AND ON THE PAGE. A node's attributes live in the
 * ProseMirror JSON, which is what the `Json` column stores and what `components/RichText.tsx` reads —
 * neither goes near `renderHTML`. The only thing that would have been lost is the HTML round trip:
 * copy a video out of one article and paste it into another, and its poster, its subtitles and its
 * shape would silently not come with it. That is exactly the class of defect this helper exists to
 * prevent, arriving through the cleverness meant to prevent it.
 *
 * Two arguments, checked against each other by the caller writing them on one line, is the honest
 * shape. TypeScript cannot check the pair — the attribute bag is `Record<string, unknown>` and always
 * will be — so the thing to do is keep them adjacent and readable rather than clever.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
function stringAttribute(dataName: string, attributeKey: string, fallback: string | null) {
  return {
    default: fallback,
    parseHTML: (element: HTMLElement) => element.getAttribute(dataName),
    renderHTML: (attributes: Record<string, unknown>) => {
      const value = attributes[attributeKey];
      return typeof value === "string" && value.length > 0 ? { [dataName]: value } : {};
    }
  };
}

/**
 * JSON out of an attribute, or null.
 *
 * ⚠ IT MUST NOT THROW. `parseHTML` runs on every paste, and a `data-settings` that is not JSON — hand
 * edited, truncated by a copy — would take the whole editor down while somebody was pasting. `null`
 * means "nothing stored", which `readVideoSettings()` turns into the complete defaults.
 */
function readJsonAttribute(raw: string | null): unknown {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * A video: a film from the media library, or an address on a service that hosts one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT IS AN ATOM, AND EVERY ONE OF ITS PARTS IS AN ATTRIBUTE.
 *
 * The alternative — a `figure`-shaped node with a real caption child — was considered and refused.
 * `figure` needs a content expression naming its children, and that is exactly what makes a figure
 * undeletable from the keyboard until `FigureCaption` adds a Backspace rule to rescue it. A video's
 * caption is one plain line in practice, so the trade is: no italics and no link inside a video's
 * caption, and a node an author can select and delete like any other block. `RichTextVideo` in
 * lib/richtext.ts states the same cost from the reading side.
 *
 * ⚠ IT STORES STORAGE KEYS, NEVER URLS — the same rule the picture node follows and for the same
 * three reasons: a URL written into a document breaks the day the CDN host changes, cannot be resolved
 * to a variant, and would hotlink somebody else's server if it pointed at one. `objectKey` is what
 * `publicObjectUrl()` resolves; `mediaId` rides along so the media library can answer "which documents
 * use this film?" before somebody deletes it.
 *
 * ⚠ THE SETTINGS ARE ONE OBJECT ATTRIBUTE, NOT THIRTEEN SCALARS, and that is the one place this node
 * departs from the picture node's four separate crop attributes. The reason the crop is four is that
 * it is four numbers with no schema of their own; the reason this is one is that it HAS a schema —
 * `videoSettingsSchema` — shared with two block types, and splitting it here would mean thirteen
 * `data-` attributes to keep in step with it by hand. It serialises to one `data-settings` holding
 * JSON, which is an honest `data-` representation of an object where a nested one would not be, and
 * `readVideoSettings()` is what turns it back into a complete set with a per-field fallback.
 *
 * ⚠ THERE IS NO NODE VIEW, DELIBERATELY. One would let the editor draw the actual player, and drawing
 * the actual player inside a writing surface means an autoplaying film under the caret, a corner
 * player docking while somebody edits the paragraph below it, and a third-party iframe mounted every
 * time an article is opened for a typo — which is the exact request `HostedVideoFrame` refuses to make
 * on a reader's behalf and has no business making on an author's. The card below names the film; the
 * toolbar's own button re-opens the dialog on it, which is how it is edited.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const VideoEmbed = Node.create({
  name: "videoEmbed",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return { HTMLAttributes: {} as Record<string, unknown> };
  },

  addAttributes() {
    return {
      // ⚠ THE TWO NAMES ON EACH LINE MUST AGREE — the `data-` attribute and the field it is read from.
      //   Nothing checks them but this alignment; see `stringAttribute` for what happened when the
      //   second was derived from the first instead of written down.
      provider: stringAttribute("data-provider", "provider", "iframe"),
      url: stringAttribute("data-url", "url", ""),
      objectKey: stringAttribute("data-object-key", "objectKey", null),
      mediaId: stringAttribute("data-media-id", "mediaId", null),
      posterObjectKey: stringAttribute("data-poster-key", "posterObjectKey", null),
      captionsObjectKey: stringAttribute("data-captions-key", "captionsObjectKey", null),
      title: stringAttribute("data-title", "title", ""),
      caption: stringAttribute("data-caption", "caption", null),
      aspectRatio: stringAttribute("data-aspect", "aspectRatio", "16:9"),

      /** The player's settings, as JSON in one attribute. See `readJsonAttribute` for the guard. */
      settings: {
        default: null,
        parseHTML: (element: HTMLElement) => readJsonAttribute(element.getAttribute("data-settings")),
        renderHTML: (attributes: Record<string, unknown>) => {
          const value = attributes.settings;
          if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
          return { "data-settings": JSON.stringify(value) };
        }
      }
    };
  },

  parseHTML() {
    // Our own marker only. A `<video>` or an `<iframe>` pasted from elsewhere is NOT adopted: its
    // source is somebody else's server, and silently embedding whatever an author copied out of a
    // page is how a document ends up hotlinking a file that disappears.
    return [{ tag: "div[data-video-embed]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const provider = typeof node.attrs.provider === "string" ? node.attrs.provider : "iframe";
    const title = typeof node.attrs.title === "string" ? node.attrs.title.trim() : "";
    const url = typeof node.attrs.url === "string" ? node.attrs.url.trim() : "";
    const objectKey = typeof node.attrs.objectKey === "string" ? node.attrs.objectKey.trim() : "";
    const chosen = provider === "upload" ? objectKey.length > 0 : url.length > 0;

    return [
      "div",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { "data-video-embed": "" }),
      ["span", { "data-video-embed-source": "" }, VIDEO_EMBED_SOURCES[provider] ?? "Video"],
      [
        "span",
        { "data-video-embed-title": "" },
        // The prompt is a real sentence rather than an empty box, and it is the same shape every other
        // unfinished thing in this repository uses — see `SECTION_PLACEHOLDERS`.
        title || (chosen ? url || objectKey : VIDEO_EMBED_PLACEHOLDER)
      ]
    ];
  },

  addCommands() {
    return {
      insertVideoEmbed:
        (attributes: Record<string, unknown>) =>
        ({ chain, state }) => {
          const target = blockInsertionAt(state, this.name);
          if (!target) return false;
          const { at } = target;
          // No `setTextSelection` afterwards, unlike the figure and the definition list: an atom has
          // nothing to type into, and putting the caret inside one is not a position that exists.
          // Tiptap leaves the new node selected, which is what makes the toolbar's button reopen the
          // dialog on it.
          return chain().insertContentAt(at, { type: this.name, attrs: attributes }).run();
        },

      updateVideoEmbed:
        (attributes: Record<string, unknown>) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, attributes)
    };
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Attributes bolted onto blocks this file does not own
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two additions to StarterKit's own nodes, made with `addGlobalAttributes` because that is the ONE
 * mechanism Tiptap offers for extending a node whose extension is not imported here.
 *
 * 1. `horizontalRule.variant` — a hairline or an ornament. ⚠ The default is `hairline`, and that is
 *    what makes every rule saved before today render exactly the 1px line it always did. A default of
 *    `ornament` would silently redecorate every existing article.
 *
 * 2. `codeBlock`'s language, rendered into the DOM as `data-language` and `data-language-label`.
 *    The attribute itself already existed and already stored the language — `@tiptap/extension-code-block`
 *    declares it `rendered: false` and writes it only as a `class="language-…"` on the inner `<code>`.
 *    A CSS `attr()` cannot read a language out of a class name, so the studio had no way to SHOW an
 *    author which language a block was set to. These two attributes are the label, and the label is
 *    what the public renderer prints too, so the two surfaces agree.
 *
 *    ⚠ Declaring the same attribute name twice is safe HERE and for a reason worth knowing: Tiptap
 *    collects global attributes BEFORE a node's own, then builds the schema's `attrs` with a
 *    last-one-wins reduce — so `codeBlock`'s own `default` and `parseHTML` still win — while
 *    `getRenderedAttributes` merges EVERY entry, so this one's `renderHTML` is added rather than
 *    replacing anything. Supplying a `default` or a `parseHTML` below would break that balance.
 */
export const RichTextBlockAttributes = Extension.create({
  name: "richTextBlockAttributes",

  addGlobalAttributes() {
    return [
      {
        types: ["horizontalRule"],
        attributes: {
          variant: {
            default: "hairline",
            parseHTML: (element: HTMLElement) => {
              const raw = element.getAttribute("data-rule")?.toLowerCase();
              return RULE_VARIANTS.find((variant) => variant === raw) ?? "hairline";
            },
            renderHTML: (attributes: Record<string, unknown>) => ({
              "data-rule": RULE_VARIANTS.find((variant) => variant === attributes.variant) ?? "hairline"
            })
          }
        }
      },
      {
        types: ["codeBlock"],
        attributes: {
          language: {
            renderHTML: (attributes: Record<string, unknown>) => {
              const value = typeof attributes.language === "string" ? attributes.language : null;
              const label = codeLanguageLabel(value);
              if (!value || !label) return {};
              return { "data-language": value, "data-language-label": label };
            }
          }
        }
      }
    ];
  },

  addCommands() {
    return {
      setRule:
        (variant: RuleVariant) =>
        ({ chain, state }) => {
          // Not `setHorizontalRule().updateAttributes(...)`: after that command the selection has
          // already moved past the rule, so the update would land on whatever is there instead.
          const target = blockInsertionAt(state, "horizontalRule");
          if (!target) return false;
          return chain()
            .insertContentAt(target.at, { type: "horizontalRule", attrs: { variant } })
            .run();
        }
    };
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Images
// ─────────────────────────────────────────────────────────────────────────────

/** What the media picker hands back. Every field maps onto an attribute `lib/richtext.ts` reads. */
export interface EditorMediaSelection {
  /** The media library row id. Provenance — see the note on `mediaId` below. */
  id: string;
  /** Storage key of the ORIGINAL upload. This is what the renderer resolves to a URL. */
  objectKey: string;
  altText?: string | null;
  caption?: string | null;
  width?: number | null;
  height?: number | null;
  blurDataUrl?: string | null;
  /** The crop chosen on the asset. Carried onto the node — see the note on the crop attributes. */
  cropX?: number | null;
  cropY?: number | null;
  cropWidth?: number | null;
  cropHeight?: number | null;
}

/** The attributes an inserted picture carries. Nothing here is a URL — see the note on the node. */
export function imageAttrsFromMedia(media: EditorMediaSelection): Record<string, unknown> {
  return {
    objectKey: media.objectKey,
    mediaId: media.id,
    altText: media.altText?.trim() ?? null,
    caption: media.caption?.trim() ?? null,
    width: media.width ?? null,
    height: media.height ?? null,
    blurDataUrl: media.blurDataUrl ?? null,
    /**
     * The crop travels with the picture. Without these four, a photograph inserted into a body of text
     * ignored the rectangle its editor had drawn and was centre-trimmed by the frame — every other
     * surface on the site honoured it, and rich text alone did not.
     */
    cropX: media.cropX ?? null,
    cropY: media.cropY ?? null,
    cropWidth: media.cropWidth ?? null,
    cropHeight: media.cropHeight ?? null,
    // Deliberately null. The renderer resolves `objectKey` through the CDN and picks a width from
    // `sizes`; a stored `src` would freeze both.
    src: null
  };
}

/**
 * The picture node.
 *
 * ⚠ IT STORES A STORAGE KEY, NEVER A URL. A URL written into a document breaks the day the CDN host
 * changes, cannot pick a responsive variant, and — if it points at somebody else's server — hotlinks
 * an image this institution does not control. `objectKey` is what `mediaSrc()` resolves;
 * `mediaId` rides along so the media library can answer "which documents use this photograph?"
 * before somebody deletes it. Both are needed: the renderer only reads `objectKey`, and only the
 * library can resolve an id.
 *
 * `alt` and `title` from the stock extension are left registered but unused by our inserts. A
 * document imported from elsewhere carries them, and `lib/richtext.ts` falls back to both, so
 * dropping them would discard alt text somebody once wrote.
 *
 * The markdown input rule is REMOVED. Typing `![alt](https://…)` in the stock extension inserts an
 * image with a raw remote URL — exactly what the paragraph above forbids, arriving through the one
 * route nobody thinks to check.
 */
export const RichTextImage = Image.extend({
  addOptions() {
    const parent = this.parent?.();
    return {
      HTMLAttributes: parent?.HTMLAttributes ?? {},
      // No drag-to-resize node view: a stored pixel width is a decision the public renderer ignores
      // (it sizes from `sizes` and the variant list), so the handle would promise something that does
      // not survive publication.
      resize: parent?.resize ?? false,
      // Block, not inline. RichText.tsx renders a `<figure>`, and a `<figure>` inside a `<p>` is
      // invalid HTML that the browser's parser restructures — which React then reports as a
      // hydration mismatch on the published page.
      inline: false,
      allowBase64: false
    };
  },

  addInputRules() {
    return [];
  },

  addAttributes() {
    const parent = this.parent?.() ?? {};
    return {
      ...parent,

      objectKey: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-object-key"),
        renderHTML: (attributes: Record<string, unknown>) =>
          typeof attributes.objectKey === "string"
            ? { "data-object-key": attributes.objectKey }
            : {}
      },

      mediaId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-media-id"),
        renderHTML: (attributes: Record<string, unknown>) =>
          typeof attributes.mediaId === "string" ? { "data-media-id": attributes.mediaId } : {}
      },

      /**
       * The alt text, and the studio's nag for a missing one.
       *
       * It renders into the DOM's `alt` as well as our own marker, so the editor shows the same thing
       * a reader with images turned off would get. Declared AFTER the stock `alt` so that when both
       * exist this one wins the merge — and contributes nothing when it is empty, leaving the stock
       * value in place for an imported document.
       *
       * `data-alt-missing` is what the editor's amber outline hangs off. A picture with no
       * description is not a broken picture, so it may not look like an error — but it must be
       * visible, because the author is the only person who can write the sentence.
       */
      altText: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-alt-text"),
        renderHTML: (attributes: Record<string, unknown>) => {
          const value = typeof attributes.altText === "string" ? attributes.altText.trim() : "";
          if (value.length === 0) return { "data-alt-missing": "" };
          return { alt: value, "data-alt-text": value };
        }
      },

      caption: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-caption"),
        renderHTML: (attributes: Record<string, unknown>) =>
          typeof attributes.caption === "string" && attributes.caption.length > 0
            ? { "data-caption": attributes.caption }
            : {}
      },

      blurDataUrl: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-blur"),
        renderHTML: (attributes: Record<string, unknown>) =>
          typeof attributes.blurDataUrl === "string" ? { "data-blur": attributes.blurDataUrl } : {}
      },

      /**
       * The crop, frozen onto the node at insert time.
       *
       * ⚠ FROZEN, LIKE `width`, `height` AND `blurDataUrl` BESIDE IT, AND NOT LIKE THE VARIANT LIST.
       * The note on this node explains why no `src` and no variant list are stored: both go stale the
       * moment the derivative pipeline is re-run, so the renderer resolves them from `objectKey`
       * instead. The crop is the opposite case, and it belongs with the frozen half for the same reason
       * those three are there — the renderer for a document has the node and nothing else. It cannot
       * reach the asset row, so a crop left on the asset would simply not apply, which is exactly the
       * state every picture in every rich-text body was in.
       *
       * The consequence, stated plainly: re-cropping the asset in the media library does NOT re-crop a
       * copy already embedded in a document. Re-inserting the picture picks up the new rectangle. That
       * is the same contract the alt text and the dimensions beside it already have.
       *
       * Four separate attributes rather than one object, because Tiptap serialises attributes into HTML
       * and a nested object has no honest `data-` representation.
       */
      ...cropAttributes()
    };
  }
});

/**
 * The four crop attributes, generated rather than written out four times.
 *
 * Each is a number or null, and the four are only meaningful together — `storedCrop` in lib/media/crop.ts
 * treats a partial set as no crop at all, which is the behaviour a document written before this existed
 * relies on: four absent attributes read as "show the whole picture", exactly as before.
 */
function cropAttributes(): Record<string, unknown> {
  const columns = ["cropX", "cropY", "cropWidth", "cropHeight"] as const;
  const attributes: Record<string, unknown> = {};
  for (const column of columns) {
    // "cropWidth" → "data-crop-width".
    const dataName = `data-${column.replace(/([A-Z])/g, "-$1").toLowerCase()}`;
    attributes[column] = {
      default: null,
      parseHTML: (element: HTMLElement) => {
        const raw = element.getAttribute(dataName);
        if (raw === null) return null;
        const parsed = Number.parseFloat(raw);
        return Number.isFinite(parsed) ? parsed : null;
      },
      renderHTML: (attrs: Record<string, unknown>) =>
        typeof attrs[column] === "number" ? { [dataName]: String(attrs[column]) } : {}
    };
  }
  return attributes;
}

// ─────────────────────────────────────────────────────────────────────────────
// The set
// ─────────────────────────────────────────────────────────────────────────────

export interface RichTextExtensionOptions {
  /** Shown in an empty document. One instruction, not a sales pitch. */
  placeholder?: string;
}

/**
 * The prompt for each block that is INVISIBLE WHEN EMPTY.
 *
 * A `<figcaption>`, a `<dt>` and a credit line are all zero-height when they hold nothing: an author
 * inserts a figure, sees a picture, and has no way of knowing there is a caption waiting under it. The
 * prompt is what makes the box findable, so it is not decoration — it is the only thing telling
 * somebody the field exists.
 *
 * Everything else returns `""` on purpose. `Placeholder` is configured with `includeChildren` below,
 * which means it decorates EVERY empty block; an empty string produces an empty pseudo-element with no
 * height, so the studio does not end up whispering "Start writing" into every blank paragraph in a
 * fifteen-paragraph article. The document's own prompt still reaches the first paragraph through the
 * `.is-editor-empty:first-child` rule in RichTextEditor.tsx.
 */
function placeholderForNode(documentPlaceholder: string) {
  return ({ node }: { node: { type: { name: string } } }): string => {
    switch (node.type.name) {
      case "figureCaption":
        return FIGURE_CAPTION_PLACEHOLDER;
      case "definitionTerm":
        return "Term";
      case "definitionDetails":
        return "What it means";
      case "attribution":
        return "Who said it, and what they do";
      case "paragraph":
        return documentPlaceholder;
      default:
        return "";
    }
  };
}

export function createRichTextExtensions(
  options: RichTextExtensionOptions = {}
): Extensions {
  const { placeholder = "Start writing, or press / for a list of blocks" } = options;

  return [
    StarterKit.configure({
      heading: { levels: [...EDITOR_HEADING_LEVELS] },

      // Registered separately below, because its configuration is the load-bearing part and a reader
      // should not have to know that the starter kit happens to re-export it.
      link: false,

      codeBlock: {
        // Tab inside a code block indents; it must not walk the focus out of the editor mid-line.
        exitOnTripleEnter: true,
        exitOnArrowDown: true
      },

      /**
       * OFF. It would keep an empty paragraph at the end of the document so there is always somewhere
       * to click after a table or a picture — but that paragraph is STORED, and RichText.tsx draws
       * every paragraph, so every article ending in a table would publish with a stray gap under it.
       *
       * The problem it solves is already solved: StarterKit's gapcursor lets the author click or arrow
       * into the space after a block and start typing, which creates the paragraph only if they
       * actually want one.
       */
      trailingNode: false
    }),

    /**
     * ⚠ `openOnClick: false`. A link that navigates while you are editing it is unusable: one stray
     * click on the word you were trying to correct and the studio is replaced by the public page,
     * taking the unsaved document with it.
     */
    Link.configure({
      openOnClick: false,
      // A pasted URL over selected text becomes a link on that text. This is the one automatic
      // behaviour worth keeping — it is what everybody expects and it never destroys anything.
      linkOnPaste: true,
      autolink: true,
      defaultProtocol: "https",
      protocols: ["mailto", "tel"],
      // Cleared, so the stored mark is a bare `href` and the renderer decides `target` and `rel` from
      // whether the destination is this site. A stored `target: "_blank"` would be a decision made in
      // the studio months ago about a domain that has since become ours.
      HTMLAttributes: { target: null, rel: null, class: null },
      // The same rule as the renderer, so a `javascript:` href cannot enter through a paste.
      isAllowedUri: (uri: string) => isStorableEditorHref(uri)
    }),

    Highlight.configure({
      // Single colour, deliberately. RichText.tsx ignores any `color` attribute on the mark — an
      // arbitrary stored fill has no guaranteed contrast against either theme — so a colour picker
      // here would offer a choice that disappears on publication.
      multicolor: false
    }),

    Subscript,
    Superscript,

    /**
     * Registered with NO toolbar control, on purpose.
     *
     * Nothing in the studio sets an alignment. It is here so a document that arrived with one — an
     * import, a paste from a Word file with centred captions — keeps it: an unregistered attribute is
     * stripped by ProseMirror the moment the document is loaded, and the next save would write the
     * stripped version back over a choice somebody made.
     */
    TextAlign.configure({ types: ["heading", "paragraph"] }),

    RichTextImage,

    Table.configure({
      // No drag-to-resize. Column widths are stored as a `colwidth` attribute that the public
      // renderer ignores, so the handle would offer an adjustment that vanishes on publication.
      resizable: false,
      allowTableNodeSelection: true
    }),
    TableRow,
    TableHeader,
    TableCell,

    Callout,
    Footnote,

    // Typographic marks. See their own headers; all three store a named step from a closed list.
    SmallCaps,
    Tracking,
    TextColour,

    // Paragraph-shaped blocks and the quote family.
    LeadParagraph,
    DropCap,
    PullQuote,
    SideNote,
    Attribution,

    // Definition lists: the container and its two halves, which are useless apart.
    DefinitionList,
    DefinitionTerm,
    DefinitionDetails,

    Columns,

    // The figure pair. ⚠ `figure`'s content expression NAMES `image`, so `RichTextImage` above is not
    // optional here: dropping it would not merely remove pictures, it would throw while the schema was
    // being compiled and the editor would fail to mount at all. (Array order itself does not matter —
    // ProseMirror collects every node spec before it resolves any content expression — but the two
    // belong beside each other for the reader.)
    Figure,
    FigureCaption,

    // The video. An atom with no content expression, so — unlike `figure` — nothing else has to be
    // registered beside it for the schema to compile. `components/RichText.tsx` draws it through the
    // same two client islands the EMBED block uses.
    VideoEmbed,

    // Rule variants, and the code block's language made visible. Extends StarterKit's own nodes.
    RichTextBlockAttributes,

    Placeholder.configure({
      placeholder: placeholderForNode(placeholder),
      // Only while it can be typed into. A read-only preview showing "Start writing" invites a click
      // that does nothing.
      showOnlyWhenEditable: true,
      // Both are needed to reach a caption or a definition term at all: `includeChildren` lets the
      // scan descend past the top level, and `showOnlyCurrent: false` shows the prompt BEFORE the
      // caret arrives — which is the entire point, since the box is invisible until it is labelled.
      //
      // Neither is expensive, despite looking like "walk the document on every keystroke". The
      // extension keeps its decorations in a state field: the full walk happens once, when the editor
      // is created, and every transaction after that rescans only the top-level blocks the change
      // actually touched. The alternative — a node view per caption — would cost far more.
      includeChildren: true,
      showOnlyCurrent: false
    })
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// The words on every control
//
// All of it lives here, beside the extensions the words describe, for the reason CALLOUT_TONE_LABELS
// already gave: a label written inside a component's JSX is a label nobody updates when the extension
// changes, and an author who picks "Danger" and reads "Important" on the published page has been lied
// to. The toolbar, the "/" menu and the shortcut list all read these.
//
// EVERY HINT SAYS WHEN TO USE THE THING, NOT WHAT IT LOOKS LIKE. An administrator can see what it
// looks like; what they cannot see is which of two similar blocks they are supposed to reach for.
// ─────────────────────────────────────────────────────────────────────────────

export const TRACKING_LABELS: Record<TrackingAmount, string> = {
  tight: "Tight",
  wide: "Wide",
  wider: "Wider"
};

export const TRACKING_HINTS: Record<TrackingAmount, string> = {
  tight: "Pulls a long display word together.",
  wide: "Opens up a run of capitals or small caps.",
  wider: "For a short label, spaced right out."
};

export const TEXT_COLOUR_LABELS: Record<TextColourName, string> = {
  strong: "Strong",
  muted: "Muted",
  brand: "Brand purple"
};

export const TEXT_COLOUR_HINTS: Record<TextColourName, string> = {
  strong: "Darker than the body, for a name or a defined term. No change in weight.",
  muted: "Lighter than the body, for an aside inside a sentence.",
  brand: "The institution's purple. Use it once on a page, not once a paragraph."
};

export const RULE_VARIANT_LABELS: Record<RuleVariant, string> = {
  hairline: "Hairline",
  ornament: "Ornament"
};

export const RULE_VARIANT_HINTS: Record<RuleVariant, string> = {
  hairline: "A plain line between two parts of a page.",
  ornament: "Three small dots. A pause in a long piece, rather than a new section."
};

export const COLUMN_COUNT_LABELS: Record<ColumnCount, string> = {
  2: "Two columns",
  3: "Three columns"
};

export const COLUMN_COUNT_HINTS: Record<ColumnCount, string> = {
  2: "A passage set in two columns. It becomes one column on a phone.",
  3: "Three columns, for short entries such as a list of places. Steps down on narrow screens."
};

/**
 * The counter styles for a numbered list, written as the reader sees them.
 *
 * "1, 2, 3" rather than "Decimal": an administrator picking a list style is looking at a page, not at a
 * CSS specification, and every one of these is unmistakable as an example.
 */
export const ORDERED_LIST_MARKER_LABELS: Record<OrderedListMarker, string> = {
  "1": "1, 2, 3",
  a: "a, b, c",
  A: "A, B, C",
  i: "i, ii, iii",
  I: "I, II, III"
};

/** Every ordered-list marker, in the order the studio offers them. */
export const EDITOR_ORDERED_LIST_MARKERS: readonly OrderedListMarker[] = ORDERED_LIST_MARKERS;

/**
 * The block styles the Style menu offers, in the order it offers them.
 *
 * ONE LIST, ONE ORDER, TWO CONSUMERS: the toolbar's Style menu and the "/" menu read the same array,
 * so a block cannot be reachable from one and missing from the other. `kind` is what the control needs
 * to know and nothing more — `convert` blocks replace the current block, `wrap` blocks go around it —
 * because the two behave differently when the caret is in the middle of a list.
 */
export type EditorBlockStyleId =
  | "paragraph"
  | "lead"
  | "dropCap"
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "heading-4"
  | "blockquote"
  | "pullQuote"
  | "sideNote"
  | "codeBlock";

export interface EditorBlockStyle {
  id: EditorBlockStyleId;
  label: string;
  hint: string;
  /** Extra words the "/" menu's filter matches, for an author who knows another name for it. */
  keywords: string[];
}

export const EDITOR_BLOCK_STYLES: readonly EditorBlockStyle[] = [
  {
    id: "paragraph",
    label: "Ordinary text",
    hint: "Turns the current block back into plain writing.",
    keywords: ["body", "plain", "normal", "text", "paragraph"]
  },
  {
    id: "lead",
    label: "Lead paragraph",
    hint: "The larger opening sentence under a title. One per piece.",
    keywords: ["standfirst", "intro", "introduction", "summary", "deck"]
  },
  {
    id: "dropCap",
    label: "Drop cap opener",
    hint: "Sets the first letter large. For the paragraph that opens a long article.",
    keywords: ["initial", "capital", "first letter", "illuminated"]
  },
  {
    id: "heading-1",
    label: "Heading 1",
    hint: "The largest heading, for the main parts of a long piece.",
    keywords: ["title", "section", "h1"]
  },
  {
    id: "heading-2",
    label: "Heading 2",
    hint: "A section heading.",
    keywords: ["title", "section", "h2"]
  },
  {
    id: "heading-3",
    label: "Heading 3",
    hint: "A heading inside a section.",
    keywords: ["title", "section", "h3"]
  },
  {
    id: "heading-4",
    label: "Heading 4",
    hint: "The smallest heading.",
    keywords: ["title", "section", "h4"]
  },
  {
    id: "blockquote",
    label: "Quote",
    hint: "Somebody else's words, quoted inside the argument.",
    keywords: ["quotation", "citation", "blockquote"]
  },
  {
    id: "pullQuote",
    label: "Pull quote",
    hint: "A sentence lifted out and set large, to draw a reader in.",
    keywords: ["display quote", "callout quote", "feature", "highlight"]
  },
  {
    id: "sideNote",
    label: "Side note",
    hint: "A quiet aside in small grey type. Use it where a note box would shout.",
    keywords: ["aside", "marginal", "remark", "parenthesis"]
  },
  {
    id: "codeBlock",
    label: "Code block",
    hint: "Text kept exactly as typed, in a fixed-width face.",
    keywords: ["pre", "snippet", "monospace"]
  }
];

// ─────────────────────────────────────────────────────────────────────────────
// Keyboard shortcuts, as data
// ─────────────────────────────────────────────────────────────────────────────

export interface EditorShortcut {
  /** `Mod` is swapped for Ctrl or Cmd when rendered — see RichTextEditor. */
  keys: string;
  action: string;
}

export interface EditorShortcutGroup {
  title: string;
  shortcuts: EditorShortcut[];
}

/**
 * The list behind the "?" button.
 *
 * It lives beside the extensions that provide the shortcuts so the two cannot drift: a shortcut
 * documented in a component's JSX is a shortcut nobody updates when the extension changes. Every
 * entry below is either a Tiptap default or bound explicitly in RichTextEditor.
 */
export const EDITOR_SHORTCUT_GROUPS: readonly EditorShortcutGroup[] = [
  {
    title: "Text",
    shortcuts: [
      { keys: "Mod+B", action: "Bold" },
      { keys: "Mod+I", action: "Italic" },
      { keys: "Mod+U", action: "Underline" },
      { keys: "Mod+Shift+X", action: "Strikethrough" },
      { keys: "Mod+E", action: "Code, inside a line" },
      { keys: "Mod+Shift+H", action: "Highlight" },
      { keys: "Mod+.", action: "Raised text, for a reference mark" },
      { keys: "Mod+,", action: "Lowered text, for a formula" },
      { keys: "Mod+Shift+K", action: "Small caps" },
      { keys: "Mod+K", action: "Add or edit a link" }
    ]
  },
  {
    title: "Blocks",
    shortcuts: [
      { keys: "Mod+Alt+1", action: "Heading 1" },
      { keys: "Mod+Alt+2", action: "Heading 2" },
      { keys: "Mod+Alt+3", action: "Heading 3" },
      { keys: "Mod+Alt+4", action: "Heading 4" },
      { keys: "Mod+Alt+0", action: "Back to ordinary text" },
      { keys: "Mod+Alt+L", action: "Lead paragraph" },
      { keys: "Mod+Shift+8", action: "Bulleted list" },
      { keys: "Mod+Shift+7", action: "Numbered list" },
      { keys: "Mod+Shift+B", action: "Quote" },
      { keys: "Mod+Alt+Q", action: "Pull quote" },
      { keys: "Mod+Alt+C", action: "Code block" }
    ]
  },
  {
    /**
     * There are deliberately NO key bindings for letter spacing, text colour, drop caps, side notes,
     * definition lists, columns or the two dividing lines.
     *
     * Every one of them is reached from the toolbar and from "/", and eight more three-key chords
     * nobody can remember is not "exhaustive" — it is a list this dialog would be longer than.
     * A shortcut earns its place by being something an author does several times in one sitting.
     */
    title: "Getting around",
    shortcuts: [
      { keys: "/", action: "Insert menu, at the start of an empty line" },
      { keys: "Tab", action: "Next cell, inside a table" },
      { keys: "Shift+Tab", action: "Previous cell, inside a table" },
      { keys: "Enter", action: "Next half of a definition list; twice to leave it" },
      { keys: "Shift+Enter", action: "New line without starting a new paragraph" },
      { keys: "Mod+Z", action: "Undo" },
      { keys: "Mod+Shift+Z", action: "Redo" }
    ]
  }
];

// ─────────────────────────────────────────────────────────────────────────────
// The drift check
// ─────────────────────────────────────────────────────────────────────────────

export interface SchemaDrift {
  /** Node types the editor can produce and the renderer does not draw. */
  unrenderableNodes: string[];
  /** Marks the editor can apply and the renderer ignores. */
  unrenderableMarks: string[];
}

/**
 * Compare the built schema against the set `lib/richtext.ts` declares.
 *
 * Structurally typed rather than taking ProseMirror's `Schema`, so this stays callable from a test or
 * a script without dragging `@tiptap/pm` in. Anything it reports is content an author can create and
 * a reader will never see (see the header) — RichTextEditor logs it in development, where somebody
 * who can act on it is watching.
 */
export function describeSchemaDrift(schema: {
  nodes: Record<string, unknown>;
  marks: Record<string, unknown>;
}): SchemaDrift {
  const knownNodes: readonly string[] = RICH_TEXT_NODE_TYPES;
  const knownMarks: readonly string[] = RICH_TEXT_MARK_TYPES;

  return {
    unrenderableNodes: Object.keys(schema.nodes).filter((name) => !knownNodes.includes(name)),
    unrenderableMarks: Object.keys(schema.marks).filter((name) => !knownMarks.includes(name))
  };
}
