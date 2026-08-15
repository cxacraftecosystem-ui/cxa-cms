"use client";

/**
 * SlashCommands — type "/" to insert a block without leaving the keyboard.
 *
 * IT DOES NOT USE A TIPTAP SUGGESTION PLUGIN. `@tiptap/suggestion` is not a dependency of this
 * project and nothing may be added (contract §13), so the trigger is derived from the editor state
 * and the keys are intercepted on the editor's own DOM node in the CAPTURE phase — before ProseMirror
 * sees them. That is the only way an Arrow key can move the highlight in this list instead of the
 * caret in the document, while focus stays in the writing area so typing keeps filtering.
 *
 * THE TRIGGER IS DELIBERATELY NARROW. "/" only opens the menu at the start of a block or after a
 * space, and never inside a code block. Without that rule the menu appears in the middle of
 * "and/or", over "24/7", and in every file path anybody writes — and each time it steals the next
 * Enter the author presses.
 *
 * ESCAPE CLOSES IT AND LEAVES THE "/" AS TYPED TEXT. Deleting what somebody typed because they
 * dismissed a menu is a surprise, and the text may well have been what they wanted: somebody writing
 * "the 1970s" has no interest in a block menu. The dismissal is remembered against the position of
 * that "/", so the menu does not spring back on the next keystroke.
 *
 * THERE IS NO `aria-live` COUNT. A region that re-announced "twenty-four blocks" on every keystroke
 * would talk over the typing it is describing (the same reasoning as the character counter in
 * Field.tsx). The pattern is announced instead by `aria-activedescendant` on the writing area, which
 * names the highlighted option as it changes — and those attributes are removed the moment the list
 * unmounts, because an `aria-controls` pointing at a missing id is worse than none (contract §11).
 *
 * ⚠ IT IS SECTIONED, AND THE SECTIONS ARE WHY THE ORDER OF `buildItems` MATTERS. The list is long
 * enough now that an unbroken run of two dozen rows is a wall — so the panel prints a heading before
 * each run. The highlight, though, is an index into the FLAT filtered array, and the render walks the
 * sections and counts as it goes; the two agree only because every item is declared in section order.
 * A new item added in the wrong place would highlight a different row from the one the arrow keys
 * think they are on. The headings are `role="presentation"`, so the options stay direct children of
 * the listbox in the accessibility tree, which is what the role requires.
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useState
} from "react";
import { createPortal } from "react-dom";
import { useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import {
  Asterisk,
  BookA,
  Columns2,
  Columns3,
  ImagePlus,
  Info,
  Lightbulb,
  List,
  ListOrdered,
  Minus,
  OctagonAlert,
  Sparkles,
  Table as TableIcon,
  TriangleAlert,
  type LucideIcon
} from "lucide-react";

import { cn } from "@/lib/utils";
import { BLOCK_STYLE_ICONS } from "@/components/studio/editor/EditorToolbar";
import {
  CALLOUT_TONE_HINTS,
  CALLOUT_TONE_LABELS,
  COLUMN_COUNT_HINTS,
  COLUMN_COUNT_LABELS,
  EDITOR_BLOCK_STYLES,
  RULE_VARIANT_HINTS,
  RULE_VARIANT_LABELS,
  type EditorBlockStyleId
} from "@/components/studio/editor/extensions";
import { CALLOUT_TONES, COLUMN_COUNTS, RULE_VARIANTS, type CalloutTone } from "@/lib/richtext";

/** The rung for a floating layer portalled to `<body>` (contract §6). Never invent another. */
const FLOATING_Z = 70;

/** Panel geometry, in pixels. The width is fixed so the two-line rows never reflow while filtering. */
const PANEL_WIDTH = 296;
const VIEWPORT_GUTTER = 8;
const CARET_GAP = 6;
/** Below this there is not enough room for two rows and the panel is better off above the caret. */
const MIN_ROOM_BELOW = 168;

/** The four note-box tones, drawn with the same glyphs the renderer and the toolbar use. */
const CALLOUT_ICONS: Record<CalloutTone, LucideIcon> = {
  note: Info,
  tip: Lightbulb,
  warning: TriangleAlert,
  danger: OctagonAlert
};

interface SlashRange {
  from: number;
  to: number;
}

/**
 * The runs the panel prints a heading before, in the order it prints them.
 *
 * ⚠ `buildItems` MUST DECLARE ITS ITEMS IN THIS ORDER. See the ⚠ in the header: the highlight index
 * is an index into the flat filtered array and the render counts through the sections.
 */
const SLASH_SECTIONS: readonly { id: SlashSectionId; label: string }[] = [
  { id: "text", label: "Text" },
  { id: "lists", label: "Lists" },
  { id: "quotes", label: "Quotes and notes" },
  { id: "blocks", label: "Blocks and pictures" },
  { id: "dividers", label: "Dividing lines" }
];

type SlashSectionId = "text" | "lists" | "quotes" | "blocks" | "dividers";

interface SlashItem {
  id: string;
  section: SlashSectionId;
  /** Sentence case, and the same word the toolbar uses for the same block. */
  label: string;
  /** One short line saying what it is for, not what it looks like. */
  hint: string;
  icon: LucideIcon;
  /** Extra words the filter matches, for authors who know a different name for the thing. */
  keywords: string[];
  run: (editor: Editor, range: SlashRange) => void;
}

/**
 * Which run each block style belongs to.
 *
 * The styles themselves — their labels, their hints, their order — come from `EDITOR_BLOCK_STYLES` in
 * extensions.ts, so this menu and the toolbar's Style menu cannot offer different sets. Only the
 * grouping is this file's business, because only this file groups.
 */
const BLOCK_STYLE_SECTIONS: Record<EditorBlockStyleId, SlashSectionId> = {
  paragraph: "text",
  lead: "text",
  dropCap: "text",
  "heading-1": "text",
  "heading-2": "text",
  "heading-3": "text",
  "heading-4": "text",
  blockquote: "quotes",
  pullQuote: "quotes",
  sideNote: "quotes",
  codeBlock: "blocks"
};

/**
 * Apply a block style, having first removed the "/" and whatever was typed after it.
 *
 * ⚠ THE `deleteRange` COMES FIRST IN THE SAME CHAIN, always. Applying the style first and deleting
 * afterwards would leave the range pointing into a document that has already changed shape.
 */
function runBlockStyle(editor: Editor, range: SlashRange, id: EditorBlockStyleId): void {
  const chain = editor.chain().focus().deleteRange(range);
  switch (id) {
    case "paragraph":
      chain.setParagraph().run();
      return;
    case "lead":
      chain.toggleLeadParagraph().run();
      return;
    case "dropCap":
      chain.toggleDropCap().run();
      return;
    case "heading-1":
      chain.toggleHeading({ level: 1 }).run();
      return;
    case "heading-2":
      chain.toggleHeading({ level: 2 }).run();
      return;
    case "heading-3":
      chain.toggleHeading({ level: 3 }).run();
      return;
    case "heading-4":
      chain.toggleHeading({ level: 4 }).run();
      return;
    case "blockquote":
      chain.toggleBlockquote().run();
      return;
    case "pullQuote":
      chain.togglePullQuote().run();
      return;
    case "sideNote":
      chain.toggleSideNote().run();
      return;
    case "codeBlock":
      chain.toggleCodeBlock().run();
      return;
  }
}

/** Every block style belonging to one section, as menu items, in the shared order. */
function blockStyleItems(section: SlashSectionId): SlashItem[] {
  return EDITOR_BLOCK_STYLES.filter((style) => BLOCK_STYLE_SECTIONS[style.id] === section).map(
    (style) => ({
      id: `style-${style.id}`,
      section,
      label: style.label,
      hint: style.hint,
      icon: BLOCK_STYLE_ICONS[style.id],
      keywords: style.keywords,
      run: (editor: Editor, range: SlashRange) => runBlockStyle(editor, range, style.id)
    })
  );
}

export interface SlashCommandsProps {
  editor: Editor | null;
  /**
   * Opens the media picker. Omitted → the picture entry is absent from the menu, because a screen
   * with no picker cannot insert one.
   */
  onRequestImage?: () => void;
}

/**
 * Every block the menu offers, DECLARED IN SECTION ORDER.
 *
 * ⚠ The order is load-bearing — see the ⚠ in this file's header. Within a section the order is
 * editorial: the thing an author reaches for most often is first.
 */
function buildItems(onRequestImage?: () => void): SlashItem[] {
  const callouts: SlashItem[] = CALLOUT_TONES.map((tone) => ({
    id: `callout-${tone}`,
    section: "quotes" as const,
    label: `${CALLOUT_TONE_LABELS[tone]} box`,
    hint: CALLOUT_TONE_HINTS[tone],
    icon: CALLOUT_ICONS[tone],
    keywords: ["callout", "box", "aside", tone],
    run: (editor: Editor, range: SlashRange) =>
      editor.chain().focus().deleteRange(range).toggleCallout(tone).run()
  }));

  const picture: SlashItem[] = onRequestImage
    ? [
        {
          id: "image",
          section: "blocks",
          label: "Picture",
          hint: "One from the media library, with a caption you can write.",
          icon: ImagePlus,
          keywords: ["image", "photo", "photograph", "figure", "caption"],
          run: (editor, range) => {
            // The "/" and its query go first, in their own step, so the document is tidy while the
            // picker is open — the author may spend a minute in there, and an autosave could land in
            // between.
            editor.chain().focus().deleteRange(range).run();
            onRequestImage();
          }
        }
      ]
    : [];

  return [
    // ── Text ─────────────────────────────────────────────────────────────────
    ...blockStyleItems("text"),

    // ── Lists ────────────────────────────────────────────────────────────────
    {
      id: "bullet-list",
      section: "lists",
      label: "Bulleted list",
      hint: "Points in no particular order.",
      icon: List,
      keywords: ["bullets", "unordered", "ul"],
      run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run()
    },
    {
      id: "ordered-list",
      section: "lists",
      label: "Numbered list",
      hint: "Steps that happen in order. The numbering style is on the toolbar.",
      icon: ListOrdered,
      keywords: ["numbers", "ordered", "steps", "ol"],
      run: (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run()
    },
    {
      id: "definition-list",
      section: "lists",
      label: "Definition list",
      hint: "Pairs a short term with its meaning. Enter moves between the two halves.",
      icon: BookA,
      keywords: ["glossary", "terms", "dictionary", "materials", "dl"],
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).insertDefinitionList().run()
    },

    // ── Quotes and notes ─────────────────────────────────────────────────────
    ...blockStyleItems("quotes"),
    ...callouts,

    // ── Blocks and pictures ──────────────────────────────────────────────────
    ...picture,
    {
      id: "table",
      section: "blocks",
      label: "Table",
      hint: "Three rows by three columns, with a header row.",
      icon: TableIcon,
      keywords: ["grid", "rows", "columns"],
      run: (editor, range) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run()
    },
    ...blockStyleItems("blocks"),
    ...COLUMN_COUNTS.map((count) => ({
      id: `columns-${count}`,
      section: "blocks" as const,
      label: COLUMN_COUNT_LABELS[count],
      hint: COLUMN_COUNT_HINTS[count],
      icon: count === 3 ? Columns3 : Columns2,
      keywords: ["column", "newspaper", "split", "side by side"],
      run: (editor: Editor, range: SlashRange) =>
        editor.chain().focus().deleteRange(range).toggleColumns(count).run()
    })),
    {
      id: "footnote",
      section: "blocks",
      label: "Footnote",
      hint: "A note that moves to the bottom of the published page.",
      icon: Asterisk,
      keywords: ["reference", "source", "endnote", "citation"],
      run: (editor, range) => editor.chain().focus().deleteRange(range).insertFootnote().run()
    },

    // ── Dividing lines ───────────────────────────────────────────────────────
    ...RULE_VARIANTS.map((variant) => ({
      id: `rule-${variant}`,
      section: "dividers" as const,
      label: RULE_VARIANT_LABELS[variant],
      hint: RULE_VARIANT_HINTS[variant],
      icon: variant === "ornament" ? Sparkles : Minus,
      keywords: ["divider", "separator", "horizontal rule", "hr", "break", variant],
      run: (editor: Editor, range: SlashRange) =>
        editor.chain().focus().deleteRange(range).setRule(variant).run()
    }))
  ];
}

function matches(item: SlashItem, query: string): boolean {
  if (query.length === 0) return true;
  const needle = query.toLowerCase();
  if (item.label.toLowerCase().includes(needle)) return true;
  return item.keywords.some((keyword) => keyword.toLowerCase().includes(needle));
}

export function SlashCommands({ editor, onRequestImage }: SlashCommandsProps) {
  const listboxId = useId();
  const items = useMemo(() => buildItems(onRequestImage), [onRequestImage]);
  const [highlighted, setHighlighted] = useState(0);
  /** The document position of a "/" the reader dismissed. Null once the trigger has moved on. */
  const [dismissedFrom, setDismissedFrom] = useState<number | null>(null);
  const [placement, setPlacement] = useState<{
    left: number;
    top: number | null;
    bottom: number | null;
    maxHeight: number;
  } | null>(null);

  /**
   * The trigger, derived from the editor state.
   *
   * Returns primitives so `useEditorState`'s deep comparison keeps this to one re-render per change
   * of the query rather than one per transaction.
   */
  const trigger = useEditorState({
    editor,
    selector: ({ editor: instance }) => {
      if (!instance || !instance.isEditable) return null;
      const { selection } = instance.state;
      // A range selection is not a caret, and "/" typed over a selection replaces it.
      if (!selection.empty) return null;

      const $from = selection.$from;
      const parent = $from.parent;
      if (!parent.isTextblock) return null;
      // Inside a code block "/" is code. A menu there would be wrong every single time.
      if (parent.type.name === "codeBlock") return null;

      // `￼` (object replacement) stands in for an inline leaf — a footnote, an emoji shortcut —
      // so the character before the "/" counts as "not a space" and the mid-word rule still holds.
      const textBefore = parent.textBetween(0, $from.parentOffset, undefined, "￼");
      const match = /(?:^|\s)\/([^\s/]*)$/.exec(textBefore);
      if (!match) return null;

      const query = match[1] ?? "";
      const to = selection.from;
      const from = to - query.length - 1;
      return { from, to, query };
    }
  });

  const active = trigger && trigger.from !== dismissedFrom ? trigger : null;
  // Memoised because the key handler below depends on it: `useEditorState` returns a stable snapshot,
  // so a new array on every render would re-bind the keydown listener on every render for nothing.
  const filtered = useMemo(
    () => (active ? items.filter((item) => matches(item, active.query)) : []),
    [active, items]
  );

  // A new "/" somewhere else clears an earlier dismissal; without this, dismissing once would leave
  // the menu switched off for the position it happened to be at.
  useEffect(() => {
    if (dismissedFrom === null) return;
    if (!trigger || trigger.from !== dismissedFrom) setDismissedFrom(null);
  }, [dismissedFrom, trigger]);

  // Filtering changes the list under the highlight, so the highlight goes back to the top. Keyed on
  // the query rather than on the array, which is a new object on every render.
  useEffect(() => {
    setHighlighted(0);
  }, [active?.query]);

  const measure = useCallback(() => {
    if (!editor || !active) return;
    let caret: { left: number; top: number; bottom: number };
    try {
      caret = editor.view.coordsAtPos(active.from);
    } catch {
      // The position can be stale for one frame after a transaction that shortened the document.
      // Losing the menu for that frame is better than throwing inside a layout effect.
      return;
    }

    const left = Math.max(
      VIEWPORT_GUTTER,
      Math.min(caret.left, window.innerWidth - PANEL_WIDTH - VIEWPORT_GUTTER)
    );
    const roomBelow = window.innerHeight - caret.bottom - CARET_GAP - VIEWPORT_GUTTER;
    const roomAbove = caret.top - CARET_GAP - VIEWPORT_GUTTER;

    // FLIPPING NEEDS BOTH CONDITIONS: too little room below AND more room above. On a short viewport
    // where it fits in neither direction, downward at least scrolls into the space that exists.
    if (roomBelow < MIN_ROOM_BELOW && roomAbove > roomBelow) {
      setPlacement({
        left,
        top: null,
        bottom: window.innerHeight - caret.top + CARET_GAP,
        maxHeight: roomAbove
      });
      return;
    }
    setPlacement({ left, top: caret.bottom + CARET_GAP, bottom: null, maxHeight: roomBelow });
  }, [active, editor]);

  // Measured before paint, so the panel is never visible in the wrong place.
  useLayoutEffect(() => {
    if (!active) {
      setPlacement(null);
      return;
    }
    measure();
  }, [active, measure]);

  // The caret moves with the page. Capture, because the scrolling ancestor is a studio panel rather
  // than the window, and a bubbling listener on the window never hears it.
  useEffect(() => {
    if (!active) return;
    const onScrollOrResize = () => measure();
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [active, measure]);

  const choose = useCallback(
    (item: SlashItem) => {
      if (!editor || !active) return;
      item.run(editor, { from: active.from, to: active.to });
    },
    [active, editor]
  );

  /**
   * The keys, taken on the editor's own node in the capture phase.
   *
   * Capture is load-bearing: ProseMirror's keymap runs on the same node, and by the time a bubbling
   * listener heard ArrowDown the caret would already have moved. Everything intercepted here is also
   * `stopPropagation`-ed, so the key cannot reach the dialog machinery either — Escape must close
   * this menu, not the panel the editor is sitting in.
   */
  useEffect(() => {
    if (!editor || !active) return;
    const dom = editor.view.dom;
    const count = filtered.length;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissedFrom(active.from);
        return;
      }

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (count === 0) return;
        event.preventDefault();
        event.stopPropagation();
        setHighlighted((current) => {
          const next = event.key === "ArrowDown" ? current + 1 : current - 1;
          // Wraps, because a list of eleven with a highlight stuck at the bottom makes the reader
          // press Up ten times to reach the first entry.
          return (next + count) % count;
        });
        return;
      }

      if (event.key === "Enter") {
        // An empty filtered list must NOT swallow Enter: the author typed "/xyz" and means to keep
        // writing, and eating their line break would be inexplicable.
        if (count === 0) return;
        const item = filtered[highlighted] ?? filtered[0];
        if (!item) return;
        event.preventDefault();
        event.stopPropagation();
        choose(item);
      }
    };

    dom.addEventListener("keydown", onKeyDown, true);
    return () => dom.removeEventListener("keydown", onKeyDown, true);
  }, [active, choose, editor, filtered, highlighted]);

  // Leaving the writing area closes the menu. A panel floating over the page after the author has
  // clicked somewhere else is a panel they cannot dismiss.
  useEffect(() => {
    if (!editor || !active) return;
    const onBlur = () => setDismissedFrom(active.from);
    editor.on("blur", onBlur);
    return () => {
      editor.off("blur", onBlur);
    };
  }, [active, editor]);

  const highlightedId = filtered[highlighted]?.id;

  /**
   * The writing area advertises the list while it is open.
   *
   * Written onto the ProseMirror node directly because that is the element focus is actually on — an
   * `aria-activedescendant` on a wrapper describes nothing. Both attributes are removed on cleanup:
   * `aria-controls` pointing at an unmounted id is worse than not pointing (contract §11).
   */
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    if (!active || filtered.length === 0) {
      dom.removeAttribute("aria-controls");
      dom.removeAttribute("aria-activedescendant");
      dom.removeAttribute("aria-expanded");
      return;
    }
    dom.setAttribute("aria-controls", listboxId);
    dom.setAttribute("aria-expanded", "true");
    if (highlightedId) dom.setAttribute("aria-activedescendant", `${listboxId}-${highlightedId}`);
    return () => {
      dom.removeAttribute("aria-controls");
      dom.removeAttribute("aria-activedescendant");
      dom.removeAttribute("aria-expanded");
    };
  }, [active, editor, filtered.length, highlightedId, listboxId]);

  if (!active || !placement || typeof document === "undefined") return null;

  return createPortal(
    <div
      // The hook Dialog.tsx looks for: while a floating layer is open the dialog underneath leaves
      // Escape and Tab alone, so this menu gets the key first.
      data-floating-layer=""
      style={{
        position: "fixed",
        left: placement.left,
        ...(placement.top === null ? { bottom: placement.bottom ?? 0 } : { top: placement.top }),
        width: PANEL_WIDTH,
        maxHeight: Math.max(120, placement.maxHeight),
        zIndex: FLOATING_Z
      }}
      className="overflow-y-auto overscroll-contain rounded-md border border-line-200 bg-card p-1 shadow-panel"
    >
      <ul id={listboxId} role="listbox" aria-label="Blocks to insert" className="m-0 list-none p-0">
        {filtered.length === 0 ? (
          // SAY SO rather than close (contract §1.6). A menu that vanishes when nothing matches is
          // indistinguishable from a menu that has broken, and the author's next move is to reload
          // the page and lose the paragraph they were writing.
          <li className="px-3 py-2.5 text-xs leading-relaxed text-ink-500">
            Nothing matches “{active.query}”. Press Escape to carry on typing.
          </li>
        ) : (
          // `flatIndex` counts through the sections in the same order `filtered` runs in, which is why
          // `buildItems` has to declare its items in section order. It is mutated inside the map on
          // purpose: the alternative is a second pass building a lookup, for a list of two dozen rows.
          (() => {
            let flatIndex = -1;
            return SLASH_SECTIONS.map((section) => {
              const rows = filtered.filter((item) => item.section === section.id);
              // A section with nothing matching the filter prints no heading. A heading over an empty
              // run reads as a section that has broken.
              if (rows.length === 0) return null;

              return (
                <Fragment key={section.id}>
                  <li
                    // Presentational, so the options below stay DIRECT children of the listbox in the
                    // accessibility tree — which `role="listbox"` requires and a real `<li>` would
                    // break. Sighted readers get the grouping; a screen-reader user gets each option
                    // named by `aria-activedescendant` as the highlight moves, which is the thing they
                    // actually need.
                    role="presentation"
                    className="px-2.5 pb-1 pt-2.5 text-xs font-semibold uppercase tracking-wide text-ink-500 first:pt-1"
                  >
                    {section.label}
                  </li>

                  {rows.map((item) => {
                    flatIndex += 1;
                    const index = flatIndex;
                    const Icon = item.icon;
                    const isHighlighted = index === highlighted;
                    return (
                      <li key={item.id} role="none">
                        <button
                          type="button"
                          id={`${listboxId}-${item.id}`}
                          role="option"
                          aria-selected={isHighlighted}
                          // Focus must stay in the document: the command applies at the caret, and a
                          // button that took focus would collapse the selection it is about to act on.
                          tabIndex={-1}
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseEnter={() => setHighlighted(index)}
                          onClick={() => choose(item)}
                          className={cn(
                            "flex w-full items-start gap-2.5 rounded px-2.5 py-2 text-left transition",
                            isHighlighted ? "bg-purple-100" : "bg-card hover:bg-surface-100"
                          )}
                        >
                          <span
                            className={cn(
                              "mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded",
                              isHighlighted
                                ? "bg-purple-200 text-purple-700"
                                : "bg-surface-100 text-ink-500"
                            )}
                          >
                            <Icon aria-hidden="true" className="h-3.5 w-3.5" />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-sm font-medium text-ink-900">
                              {item.label}
                            </span>
                            <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">
                              {item.hint}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </Fragment>
              );
            });
          })()
        )}
      </ul>
    </div>,
    document.body
  );
}
