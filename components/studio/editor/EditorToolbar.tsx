"use client";

/**
 * EditorToolbar — the row of formatting controls above the editing area.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * HOW IT IS GROUPED, AND WHY THAT IS THE HARD PART.
 *
 * The editor can now write about forty distinct things. Forty buttons in one row is not "exhaustive",
 * it is a wall an administrator has to read left to right every time they want bold. So the row holds
 * ONLY what is used constantly, and everything else lives behind one of four menus:
 *
 *   Style        ▾  every "what is this block" conversion: ordinary text, lead paragraph, drop cap,
 *                   headings 1–4, quote, pull quote, side note, code block. ONE trigger replaces six
 *                   buttons AND names the current style, which no row of icons ever did — an author
 *                   could not previously tell an H2 from an H3 without clicking one.
 *   Aa           ▾  typography an author reaches for a few times an article: small caps, raised and
 *                   lowered text, letter spacing, text colour, and "remove formatting".
 *   Numbering    ▾  a numbered list's counter style and its first number. Greyed out outside one.
 *   Language     ▾  a code block's language. Greyed out outside one.
 *   +            ▾  the rarer inserts: the four note boxes, a definition list, a multi-column
 *                   passage, the two dividing lines, and a quote's attribution line.
 *
 * Bold / italic / underline / strikethrough / inline code / highlight / link stay as buttons because
 * they are pressed constantly; so do the two lists, the picture, the table and the footnote. Undo,
 * redo and the shortcut list keep the far end.
 *
 * A reader who prefers the keyboard never needs any of it: every block is on the "/" menu, which is
 * filterable, and the common marks have keys. The menus are the mouse route, not the only route.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * IT IS A REAL TOOLBAR, in the ARIA sense: `role="toolbar"` with ONE tab stop and arrow keys moving
 * between the controls inside it. Twenty separately tabbable buttons in front of the editing area mean
 * twenty presses of Tab before a keyboard reader reaches the words — every time they come back to the
 * field. A roving tabindex costs one line per control and gives them one press.
 *
 * ⚠ THE MENU TRIGGERS ARE MEMBERS OF THAT ROVING GROUP, which is why `ui/DropdownMenu.tsx` is not used
 * here even though it is the studio's menu component and does everything else right. Its trigger is a
 * fixed 36px round icon button that owns its own `tabIndex`, so four of them would add four tab stops
 * to a bar whose entire contract is that it has one — and no prop can reach inside it to say otherwise.
 * `ToolbarMenu` below therefore composes `ui/Popover.tsx` directly: placement, portalling, Escape,
 * outside-press, the scroll rules and the z-index rung all still come from the one shared primitive, so
 * the two cannot grow separate opinions about where a floating panel goes. Only the trigger differs.
 *
 * ⚠ THE PANELS ARE `role="group"`, NOT `role="menu"`. Two reasons, and both are about honesty. Half of
 * these controls are STATES, not actions — "small caps is on", "the spacing is Wide" — and a
 * `role="menuitem"` cannot say so, while a button with `aria-pressed` can. And the numbering panel
 * contains a real `<input type="number">`, which is invalid inside a menu at all. Focus lands on the
 * first control when the panel opens (a portalled panel is at the end of `<body>`, so Tab from the
 * trigger would otherwise walk past the whole page), and Popover closes at either end of the panel and
 * hands focus back to the trigger.
 *
 * EVERY CONTROL CARRIES `aria-pressed` WHERE IT IS A STATE, and nothing where it is an action. "Bold"
 * is on or off and must say which; "Insert table" is neither, and an `aria-pressed="false"` on it
 * would be announced as "not pressed" — a state the reader then waits to see change.
 *
 * DISABLED HERE IS NOT THE DISABLED THE CONTRACT FORBIDS. §1.8 is about permission: an action a
 * reader may never take is absent, not greyed out. These controls are greyed out only when the
 * command cannot apply *to the cursor's current position* — bold inside a code block, a list inside a
 * table header, a counter style when the caret is not in a numbered list — which is a fact about where
 * the caret is, changes as it moves, and would be far more confusing as a control that vanishes and
 * comes back. The one genuinely conditional control is the picture button: with no media picker on the
 * screen it is not rendered at all.
 *
 * ON A NARROW SCREEN IT SCROLLS SIDEWAYS. Wrapping into three rows pushes the writing area down the
 * page every time the toolbar gains a button, and the author loses their place. `.mask-edges-x` fades
 * the ends so there is a visible cue that more exists — applied ONLY while it actually overflows,
 * because a permanent fade over the first and last button looks like two disabled controls.
 *
 * Motion: none of its own. A toolbar button changes colour and that is all. The studio is calm
 * (contract §0) and an administrator hitting a control must land on it immediately. The one animation
 * in play is Popover's entrance spring, which already honours reduced motion itself.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject
} from "react";
import { useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import {
  ALargeSmall,
  Asterisk,
  Baseline,
  Bold,
  Braces,
  CaseSensitive,
  CaseUpper,
  ChevronDown,
  CircleHelp,
  Code,
  Columns2,
  Columns3,
  BookA,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Highlighter,
  ImagePlus,
  Info,
  Film,
  Italic,
  Lightbulb,
  Link2,
  List,
  ListOrdered,
  Minus,
  MoveHorizontal,
  OctagonAlert,
  Pilcrow,
  Plus,
  Quote,
  Redo2,
  RemoveFormatting,
  SlidersHorizontal,
  Sparkles,
  SquareCode,
  StickyNote,
  Strikethrough,
  Subscript,
  Superscript,
  Table as TableIcon,
  TextQuote,
  TriangleAlert,
  Type,
  Underline,
  Undo2,
  X,
  type LucideIcon
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Popover } from "@/components/ui/Popover";
import {
  CALLOUT_TONE_HINTS,
  CALLOUT_TONE_LABELS,
  COLUMN_COUNT_HINTS,
  COLUMN_COUNT_LABELS,
  EDITOR_BLOCK_STYLES,
  EDITOR_ORDERED_LIST_MARKERS,
  ORDERED_LIST_MARKER_LABELS,
  RULE_VARIANT_HINTS,
  RULE_VARIANT_LABELS,
  TEXT_COLOUR_HINTS,
  TEXT_COLOUR_LABELS,
  TRACKING_HINTS,
  TRACKING_LABELS,
  type EditorBlockStyleId
} from "@/components/studio/editor/extensions";
import {
  CALLOUT_TONES,
  CODE_LANGUAGES,
  COLUMN_COUNTS,
  RULE_VARIANTS,
  TEXT_COLOURS,
  TRACKING_AMOUNTS,
  type CalloutTone,
  type ColumnCount
} from "@/lib/richtext";

// ─────────────────────────────────────────────────────────────────────────────
// The shared control treatment
//
// Complete literal class strings, one per state, never layered (contract §5): `cn()` is a plain join,
// so a base `text-ink-700` and an active `text-purple-700` would be settled by Tailwind's own output
// order rather than by the order they are written.
// ─────────────────────────────────────────────────────────────────────────────

export const EDITOR_CONTROL_BASE =
  "inline-flex min-h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed";

export const EDITOR_CONTROL_STATE = {
  idle: "text-ink-700 hover:bg-surface-100 hover:text-ink-900",
  /** purple-100 behind purple-700: the single action colour, at the one weight that reads as "on". */
  active: "bg-purple-100 text-purple-700 hover:bg-purple-200",
  unavailable: "text-ink-300"
} as const;

export function editorControlClass(options: {
  active?: boolean;
  unavailable?: boolean;
  className?: string;
}): string {
  const state = options.unavailable
    ? EDITOR_CONTROL_STATE.unavailable
    : options.active
      ? EDITOR_CONTROL_STATE.active
      : EDITOR_CONTROL_STATE.idle;
  return cn(EDITOR_CONTROL_BASE, state, options.className);
}

/** One row inside a menu panel. Wider than a toolbar button, because it carries words. */
const MENU_ROW_BASE =
  "flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition disabled:cursor-not-allowed";

const MENU_ROW_STATE = {
  idle: "text-ink-700 hover:bg-surface-100 hover:text-ink-900",
  active: "bg-purple-100 text-purple-700",
  unavailable: "text-ink-300"
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// The roving tabindex
//
// Shared with TableControls, which is the same pattern with different buttons. One implementation, so
// the two bars cannot disagree about what an arrow key does.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Marks a button as a member of a roving group. The hook finds its items by this attribute.
 *
 * ⚠ The buttons write it out LITERALLY as `data-toolbar-item=…`, because a JSX attribute NAME cannot
 * be interpolated from a constant. Renaming it means changing both this and every button.
 */
export const TOOLBAR_ITEM_ATTRIBUTE = "data-toolbar-item";

export interface RovingFocus {
  /** Put this on the element with `role="toolbar"`. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** The id that holds `tabIndex={0}`. Everything else is -1. */
  currentStop: string | null;
  /** Call from each button's `onFocus`, so a click also moves the tab stop. */
  onFocused: (id: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

/**
 * One tab stop for a whole bar, arrow keys between the buttons inside it.
 *
 * `reachableIds` is the buttons that are NOT disabled, in visual order. It is identified by id rather
 * than by index because a disabled button drops out of the set: an index would point at a different
 * button the moment the caret moved, so the reader's place in the bar would change because they moved
 * the caret.
 */
export function useRovingFocus(reachableIds: readonly string[]): RovingFocus {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [tabStopId, setTabStopId] = useState<string | null>(null);

  const currentStop =
    tabStopId && reachableIds.includes(tabStopId) ? tabStopId : (reachableIds[0] ?? null);

  const focusItem = useCallback((id: string) => {
    const container = containerRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLButtonElement>(
      `[${TOOLBAR_ITEM_ATTRIBUTE}="${id}"]`
    );
    if (!target) return;
    setTabStopId(id);
    target.focus();
    // `inline: "nearest"` so a button at the far end of an overflowing bar scrolls into view, and
    // `block: "nearest"` so reaching it never scrolls the page underneath.
    target.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    if (reachableIds.length === 0) return;

    const index = currentStop ? reachableIds.indexOf(currentStop) : -1;
    const from = index === -1 ? 0 : index;
    let next = from;
    if (event.key === "ArrowRight") next = (from + 1) % reachableIds.length;
    if (event.key === "ArrowLeft") next = (from - 1 + reachableIds.length) % reachableIds.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = reachableIds.length - 1;

    const target = reachableIds[next];
    if (!target) return;
    // Prevented only once a move is certain, so an arrow key in a bar with one button still does
    // whatever the browser would have done.
    event.preventDefault();
    focusItem(target);
  };

  return { containerRef, currentStop, onFocused: setTabStopId, onKeyDown };
}

// ─────────────────────────────────────────────────────────────────────────────
// What a control is
// ─────────────────────────────────────────────────────────────────────────────

/** One button. `pressed` undefined means "this is an action, not a state" — see the header. */
interface ToolbarButtonSpec {
  control: "button";
  id: string;
  /** The accessible name. A verb or the name of the style; never an abbreviation. */
  label: string;
  icon: LucideIcon;
  pressed?: boolean;
  available: boolean;
  run: () => void;
  /** Appended to the visible title for a mouse user: the keyboard shortcut. */
  shortcut?: string;
}

/** One row inside a menu panel, or a heading that names a run of them. */
type MenuEntry =
  | {
      kind: "row";
      id: string;
      label: string;
      /** One short line saying when to use it. Optional for a row whose label says everything. */
      hint?: string;
      icon?: LucideIcon;
      /** Present when the row is a STATE. Absent when it is an action. */
      pressed?: boolean;
      available: boolean;
      run: () => void;
    }
  | { kind: "heading"; id: string; label: string };

interface ToolbarMenuSpec {
  control: "menu";
  id: string;
  /** The trigger's accessible name. Says what the menu is for, not "More". */
  label: string;
  icon: LucideIcon;
  /** Words shown on the trigger beside the icon. Only the Style menu has any — it names the state. */
  caption?: string;
  available: boolean;
  entries: MenuEntry[];
  /** Extra controls under the entries. The numbering panel puts its "Start at" field here. */
  footer?: ReactNode;
  /** A fixed panel width in pixels, so two-line rows do not reflow as the panel is read. */
  width?: number;
}

type ToolbarControl = ToolbarButtonSpec | ToolbarMenuSpec;

interface ToolbarGroup {
  /** Names the group for a screen reader moving by group. */
  label: string;
  items: ToolbarControl[];
}

export interface EditorToolbarProps {
  editor: Editor | null;
  /** Opens the link dialog. The toolbar never writes a link itself — see LinkDialog. */
  onRequestLink: () => void;
  /**
   * Opens the media picker. WHEN OMITTED THE PICTURE BUTTON IS NOT RENDERED: a screen with no picker
   * has no way to insert a picture, and a button that cannot work is worse than no button.
   */
  onRequestImage?: () => void;
  /**
   * Opens the video dialog — on the video the caret is in, or on a blank one.
   *
   * ⚠ NOT GATED ON A MEDIA PICKER, unlike the picture button above, and the difference is real rather
   * than an inconsistency: a video may be a YouTube, Vimeo or Google Drive address, which needs no
   * media library at all. The dialog is what withholds the "a film uploaded here" option on a screen
   * that cannot pick one.
   */
  onRequestVideo?: () => void;
  /** Opens the keyboard-shortcut list. */
  onShowShortcuts: () => void;
  /** Names the toolbar. Include the field it belongs to when a page has two editors. */
  label?: string;
  /**
   * How far below the top of the scroll port the toolbar comes to rest, in pixels.
   *
   * Default 64, which is `h-16` — the height of the sticky studio top bar in
   * components/studio/StudioTopBar.tsx. It is a prop rather than a `top-16` class because an editor
   * inside a dialog or a preview pane has no top bar above it, and a toolbar hiding 64px of that
   * panel would be a bug with no obvious cause. There is no CSS variable for the bar's height; if one
   * is ever added, this default should read it instead.
   */
  stickyOffset?: number;
  className?: string;
}

/**
 * An icon per block style, in the order EDITOR_BLOCK_STYLES declares them.
 *
 * `CaseUpper` for the drop cap and `Baseline` for the lead paragraph are the two that need saying:
 * neither has an obvious glyph, so both rows carry their words as well — which every row in a menu
 * does, and is exactly why the rare controls went into menus rather than staying as bare icons.
 *
 * Exported because SlashCommands.tsx offers the same eleven styles and must draw them with the same
 * glyphs: a block that is a `TextQuote` here and something else there is two blocks as far as an
 * author is concerned.
 */
export const BLOCK_STYLE_ICONS: Record<EditorBlockStyleId, LucideIcon> = {
  paragraph: Pilcrow,
  lead: Baseline,
  dropCap: CaseUpper,
  "heading-1": Heading1,
  "heading-2": Heading2,
  "heading-3": Heading3,
  "heading-4": Heading4,
  blockquote: Quote,
  pullQuote: TextQuote,
  sideNote: StickyNote,
  codeBlock: SquareCode
};

const CALLOUT_TONE_ICONS: Record<CalloutTone, LucideIcon> = {
  note: Info,
  tip: Lightbulb,
  warning: TriangleAlert,
  danger: OctagonAlert
};

const COLUMN_COUNT_ICONS: Record<ColumnCount, LucideIcon> = {
  2: Columns2,
  3: Columns3
};

/** The lowest and highest first number a list may start at. A stated cap, not a silent clamp. */
const ORDERED_LIST_START_MIN = 1;
const ORDERED_LIST_START_MAX = 999;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything the controls need, as primitives.
 *
 * The selector returns booleans, numbers and short strings only. `useEditorState`'s default equality
 * check is a deep compare, so on a flat record of primitives the toolbar re-renders when a control's
 * appearance actually changes and not once per keystroke.
 *
 * ⚠ `canAttribution` is derived from `isActive`, NOT from `can().setAttribution()`. Every other
 * availability here asks the command, which is the right question — but `setAttribution` reads the
 * ancestor chain and moves the caret, and "is the caret inside a quote" is the same answer arrived at
 * without a dry-run transaction. The command still refuses on its own; this only decides the greying.
 */
function selectToolbarState(instance: Editor) {
  const can = instance.can().chain();
  const orderedListAttrs = instance.getAttributes("orderedList");
  const codeBlockAttrs = instance.getAttributes("codeBlock");
  const columnsAttrs = instance.getAttributes("columns");

  return {
    // ── Block style ──────────────────────────────────────────────────────────
    paragraph: instance.isActive("paragraph"),
    lead: instance.isActive("leadParagraph"),
    dropCap: instance.isActive("dropCap"),
    heading1: instance.isActive("heading", { level: 1 }),
    heading2: instance.isActive("heading", { level: 2 }),
    heading3: instance.isActive("heading", { level: 3 }),
    heading4: instance.isActive("heading", { level: 4 }),
    blockquote: instance.isActive("blockquote"),
    pullQuote: instance.isActive("pullQuote"),
    sideNote: instance.isActive("sideNote"),
    codeBlock: instance.isActive("codeBlock"),

    canHeading: can.toggleHeading({ level: 2 }).run(),
    canLead: can.toggleLeadParagraph().run(),
    canDropCap: can.toggleDropCap().run(),
    canBlockquote: can.toggleBlockquote().run(),
    canPullQuote: can.togglePullQuote().run(),
    canSideNote: can.toggleSideNote().run(),
    canCodeBlock: can.toggleCodeBlock().run(),
    canParagraph: can.setParagraph().run(),

    // ── Marks ────────────────────────────────────────────────────────────────
    bold: instance.isActive("bold"),
    italic: instance.isActive("italic"),
    underline: instance.isActive("underline"),
    strike: instance.isActive("strike"),
    code: instance.isActive("code"),
    highlight: instance.isActive("highlight"),
    superscript: instance.isActive("superscript"),
    subscript: instance.isActive("subscript"),
    link: instance.isActive("link"),
    smallCaps: instance.isActive("smallCaps"),
    tracking: instance.isActive("tracking"),
    trackingTight: instance.isActive("tracking", { amount: "tight" }),
    trackingWide: instance.isActive("tracking", { amount: "wide" }),
    trackingWider: instance.isActive("tracking", { amount: "wider" }),
    textColour: instance.isActive("textColour"),
    colourStrong: instance.isActive("textColour", { value: "strong" }),
    colourMuted: instance.isActive("textColour", { value: "muted" }),
    colourBrand: instance.isActive("textColour", { value: "brand" }),
    canMark: can.toggleBold().run(),
    // "Remove formatting" acts on a selection, so with nothing selected there is nothing for it to
    // do. Enabled-but-inert would leave a reader pressing it and watching nothing happen.
    hasSelection: !instance.state.selection.empty,

    // ── Lists ────────────────────────────────────────────────────────────────
    bulletList: instance.isActive("bulletList"),
    orderedList: instance.isActive("orderedList"),
    canBulletList: can.toggleBulletList().run(),
    canOrderedList: can.toggleOrderedList().run(),
    orderedListStart:
      typeof orderedListAttrs.start === "number" && Number.isFinite(orderedListAttrs.start)
        ? orderedListAttrs.start
        : 1,
    // Null on an ordered list means plain numbers, which is what `type` is absent for.
    orderedListMarker: typeof orderedListAttrs.type === "string" ? orderedListAttrs.type : "1",

    // ── Blocks and inserts ───────────────────────────────────────────────────
    callout: instance.isActive("callout"),
    // The TONE, not just "am I in a box". Without it all four rows light up together and the menu
    // says the block is a Note and a Warning at once.
    calloutTone:
      typeof instance.getAttributes("callout").tone === "string"
        ? (instance.getAttributes("callout").tone as string)
        : "",
    canCallout: can.toggleCallout("note").run(),
    columns: instance.isActive("columns"),
    columnCount: typeof columnsAttrs.count === "number" ? columnsAttrs.count : 2,
    canColumns: can.toggleColumns(2).run(),
    canDefinitionList: can.insertDefinitionList().run(),
    canRule: can.setRule("hairline").run(),
    canTable: can.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    /**
     * Is the caret on a video, and could one be inserted where it is?
     *
     * `videoEmbed` is what makes ONE button both "add" and "change", the way the link button already
     * is.
     *
     * ⚠ `canVideo` IS BESIDE IT BECAUSE "IT CAN ALWAYS LAND SOMEWHERE" IS FALSE, AND THE COMMENT THAT
     * SAID SO PUT A DEAD BUTTON ON THE TOOLBAR. `blockInsertionAt` climbs outwards until a container
     * accepts the node — but its loop stops ABOVE depth 0, deliberately (reading `$from.before(0)`
     * throws), and depth 0 is a real, reachable state: a NodeSelection on a top-level block, which is
     * what clicking a picture gives you. From there the command returns false, the insert silently does
     * nothing, and the dialog closes over an article that gained no video. Every other insert control
     * on this toolbar is gated on `can()` for exactly this reason.
     *
     * The two are OR'd where the button is built, so a selected video can still be edited — that
     * selection is itself at depth 0 and would otherwise grey out the one control that changes it.
     */
    videoEmbed: instance.isActive("videoEmbed"),
    canVideo: can.insertVideoEmbed({}).run(),
    canFootnote: can.insertFootnote().run(),
    canAttribution: instance.isActive("blockquote") || instance.isActive("pullQuote"),
    inAttribution: instance.isActive("attribution"),
    codeLanguage: typeof codeBlockAttrs.language === "string" ? codeBlockAttrs.language : "",

    canUndo: can.undo().run(),
    canRedo: can.redo().run()
  };
}

type ToolbarState = ReturnType<typeof selectToolbarState>;

/**
 * The subscriber.
 *
 * `useEditorState` is how a Tiptap 3 editor is watched: the editor does NOT re-render its React tree
 * on every transaction any more (`shouldRerenderOnTransaction` defaults to false), so a toolbar that
 * read `editor.isActive(...)` during render would show the state of whichever transaction last
 * happened to re-render it — usually the one before the click.
 *
 * The bar itself is a separate component so the roving-focus hook is never called conditionally: it
 * needs the list of reachable controls, and that list does not exist until there is an editor.
 */
export function EditorToolbar(props: EditorToolbarProps) {
  const { editor, className } = props;

  const state = useEditorState({
    editor,
    selector: ({ editor: instance }) => (instance ? selectToolbarState(instance) : null)
  });

  if (!editor || !state) {
    // No skeleton. The toolbar exists for a fraction of a second before the editor is ready, and a
    // shimmering row of fake buttons at the top of a form is more alarming than an empty strip.
    return (
      <div
        className={cn(
          "flex min-h-11 items-center gap-2 border-b border-line-200 bg-surface-50 px-2 py-1.5 text-xs text-ink-500",
          className
        )}
      >
        Preparing the editor…
      </div>
    );
  }

  return <ToolbarBar {...props} editor={editor} state={state} />;
}

/** Is this block style the one the caret is in? */
function blockStylePressed(id: EditorBlockStyleId, state: ToolbarState): boolean {
  switch (id) {
    case "paragraph":
      // Every textblock that is not one of the others reports as a paragraph, which is exactly what
      // "Ordinary text" means — but a lead paragraph and a drop cap are their OWN node types, so they
      // do not, and the three cannot both be lit at once.
      return state.paragraph;
    case "lead":
      return state.lead;
    case "dropCap":
      return state.dropCap;
    case "heading-1":
      return state.heading1;
    case "heading-2":
      return state.heading2;
    case "heading-3":
      return state.heading3;
    case "heading-4":
      return state.heading4;
    case "blockquote":
      return state.blockquote;
    case "pullQuote":
      return state.pullQuote;
    case "sideNote":
      return state.sideNote;
    case "codeBlock":
      return state.codeBlock;
  }
}

function blockStyleAvailable(id: EditorBlockStyleId, state: ToolbarState): boolean {
  switch (id) {
    case "paragraph":
      return state.canParagraph;
    case "lead":
      return state.canLead;
    case "dropCap":
      return state.canDropCap;
    case "heading-1":
    case "heading-2":
    case "heading-3":
    case "heading-4":
      return state.canHeading;
    case "blockquote":
      return state.canBlockquote;
    case "pullQuote":
      return state.canPullQuote;
    case "sideNote":
      return state.canSideNote;
    case "codeBlock":
      return state.canCodeBlock;
  }
}

function ToolbarBar({
  editor,
  state,
  onRequestLink,
  onRequestImage,
  onRequestVideo,
  onShowShortcuts,
  label = "Formatting",
  stickyOffset = 64,
  className
}: EditorToolbarProps & { editor: Editor; state: ToolbarState }) {
  const [overflowing, setOverflowing] = useState(false);
  const chain = () => editor.chain().focus();

  const runBlockStyle = (id: EditorBlockStyleId) => {
    switch (id) {
      case "paragraph":
        return chain().setParagraph().run();
      case "lead":
        return chain().toggleLeadParagraph().run();
      case "dropCap":
        return chain().toggleDropCap().run();
      case "heading-1":
        return chain().toggleHeading({ level: 1 }).run();
      case "heading-2":
        return chain().toggleHeading({ level: 2 }).run();
      case "heading-3":
        return chain().toggleHeading({ level: 3 }).run();
      case "heading-4":
        return chain().toggleHeading({ level: 4 }).run();
      case "blockquote":
        return chain().toggleBlockquote().run();
      case "pullQuote":
        return chain().togglePullQuote().run();
      case "sideNote":
        return chain().toggleSideNote().run();
      case "codeBlock":
        return chain().toggleCodeBlock().run();
    }
  };

  // The words on the Style trigger. Naming the current block is the whole reason six icon buttons
  // became one menu: nothing in a row of glyphs ever told an author whether they were in an H2 or H3.
  const activeStyle = EDITOR_BLOCK_STYLES.find((style) => blockStylePressed(style.id, state));

  /**
   * The shortcut a block style has, where it has one.
   *
   * A lookup rather than a field on `EDITOR_BLOCK_STYLES`, because a key binding belongs to the
   * extension that installs it and the styles list is shared with the "/" menu, which shows no keys.
   */
  const blockStyleShortcut: Partial<Record<EditorBlockStyleId, string>> = {
    paragraph: "Mod+Alt+0",
    lead: "Mod+Alt+L",
    "heading-1": "Mod+Alt+1",
    "heading-2": "Mod+Alt+2",
    "heading-3": "Mod+Alt+3",
    "heading-4": "Mod+Alt+4",
    blockquote: "Mod+Shift+B",
    pullQuote: "Mod+Alt+Q",
    codeBlock: "Mod+Alt+C"
  };

  const groups: ToolbarGroup[] = [
    {
      label: "Block style",
      items: [
        {
          control: "menu",
          id: "style",
          label: "Change what this block is",
          icon: Type,
          caption: activeStyle?.label ?? "Style",
          // Somewhere block styles do not apply at all — inside a figure's caption or a credit line,
          // whose parents accept neither a heading nor a quote.
          available: state.canHeading || state.canBlockquote || state.canParagraph,
          width: 288,
          entries: EDITOR_BLOCK_STYLES.map((style) => {
            const shortcut = blockStyleShortcut[style.id];
            return {
              kind: "row" as const,
              id: `style-${style.id}`,
              label: shortcut ? `${style.label} · ${describeShortcut(shortcut)}` : style.label,
              hint: style.hint,
              icon: BLOCK_STYLE_ICONS[style.id],
              pressed: blockStylePressed(style.id, state),
              available: blockStyleAvailable(style.id, state),
              run: () => runBlockStyle(style.id)
            };
          })
        }
      ]
    },
    {
      label: "Formatting",
      items: [
        {
          control: "button",
          id: "bold",
          label: "Bold",
          icon: Bold,
          pressed: state.bold,
          available: state.canMark,
          shortcut: "Mod+B",
          run: () => chain().toggleBold().run()
        },
        {
          control: "button",
          id: "italic",
          label: "Italic",
          icon: Italic,
          pressed: state.italic,
          available: state.canMark,
          shortcut: "Mod+I",
          run: () => chain().toggleItalic().run()
        },
        {
          control: "button",
          id: "underline",
          label: "Underline",
          icon: Underline,
          pressed: state.underline,
          available: state.canMark,
          shortcut: "Mod+U",
          run: () => chain().toggleUnderline().run()
        },
        {
          control: "button",
          id: "strike",
          label: "Strikethrough",
          icon: Strikethrough,
          pressed: state.strike,
          available: state.canMark,
          shortcut: "Mod+Shift+X",
          run: () => chain().toggleStrike().run()
        },
        {
          control: "button",
          id: "code",
          label: "Code, inside a line",
          icon: Code,
          pressed: state.code,
          available: state.canMark,
          shortcut: "Mod+E",
          run: () => chain().toggleCode().run()
        },
        {
          control: "button",
          id: "highlight",
          label: "Highlight",
          icon: Highlighter,
          pressed: state.highlight,
          available: state.canMark,
          shortcut: "Mod+Shift+H",
          run: () => chain().toggleHighlight().run()
        },
        {
          control: "button",
          id: "link",
          label: state.link ? "Edit this link" : "Add a link",
          icon: Link2,
          pressed: state.link,
          available: true,
          shortcut: "Mod+K",
          run: onRequestLink
        }
      ]
    },
    {
      label: "Typography",
      items: [
        {
          control: "menu",
          id: "typography",
          label: "More text formatting",
          icon: CaseSensitive,
          available: state.canMark || state.hasSelection,
          width: 296,
          entries: [
            { kind: "heading", id: "letterforms-heading", label: "Letterforms" },
            {
              kind: "row",
              id: "small-caps",
              label: `Small caps · ${describeShortcut("Mod+Shift+K")}`,
              hint: "For an acronym or a period name inside running prose.",
              icon: ALargeSmall,
              pressed: state.smallCaps,
              available: state.canMark,
              run: () => chain().toggleSmallCaps().run()
            },
            {
              kind: "row",
              id: "superscript",
              label: "Raised text",
              hint: "For a reference mark or an ordinal.",
              icon: Superscript,
              pressed: state.superscript,
              available: state.canMark,
              run: () => chain().toggleSuperscript().run()
            },
            {
              kind: "row",
              id: "subscript",
              label: "Lowered text",
              hint: "For a formula.",
              icon: Subscript,
              pressed: state.subscript,
              available: state.canMark,
              run: () => chain().toggleSubscript().run()
            },

            { kind: "heading", id: "tracking-heading", label: "Letter spacing" },
            {
              kind: "row",
              id: "tracking-none",
              label: "Normal",
              hint: "The face's own spacing.",
              icon: MoveHorizontal,
              // Deliberately a POSITIVE way to turn spacing off, rather than pressing the lit option
              // again. A reader should never have to guess that a control toggles.
              pressed: !state.tracking,
              available: state.canMark,
              run: () => chain().unsetTracking().run()
            },
            ...TRACKING_AMOUNTS.map((amount) => ({
              kind: "row" as const,
              id: `tracking-${amount}`,
              label: TRACKING_LABELS[amount],
              hint: TRACKING_HINTS[amount],
              icon: MoveHorizontal,
              pressed:
                amount === "tight"
                  ? state.trackingTight
                  : amount === "wide"
                    ? state.trackingWide
                    : state.trackingWider,
              available: state.canMark,
              run: () => chain().setTracking(amount).run()
            })),

            { kind: "heading", id: "colour-heading", label: "Text colour" },
            {
              kind: "row",
              id: "colour-default",
              label: "Body colour",
              hint: "Inherits the page's own text colour.",
              pressed: !state.textColour,
              available: state.canMark && !state.highlight,
              run: () => chain().unsetTextColour().run()
            },
            ...TEXT_COLOURS.map((value) => ({
              kind: "row" as const,
              id: `colour-${value}`,
              label: TEXT_COLOUR_LABELS[value],
              hint: TEXT_COLOUR_HINTS[value],
              pressed:
                value === "strong"
                  ? state.colourStrong
                  : value === "muted"
                    ? state.colourMuted
                    : state.colourBrand,
              // ⚠ Unavailable over a highlight, and that is not a limitation to be fixed. The
              // highlight's amber fill and amber text are a fixed, non-inverting pair chosen for
              // legibility in both themes; a third colour inside it has no guaranteed contrast, so
              // the renderer discards it. Greying the control out is how the author is told BEFORE
              // they pick, rather than by the published page silently ignoring them.
              available: state.canMark && !state.highlight,
              run: () => chain().setTextColour(value).run()
            })),

            { kind: "heading", id: "cleanup-heading", label: "Clean up" },
            {
              kind: "row",
              id: "clear",
              label: "Remove formatting",
              hint: "Strips every mark from the selection. Blocks are left alone.",
              icon: RemoveFormatting,
              // An action, not a state: no `pressed`.
              available: state.hasSelection,
              run: () => chain().unsetAllMarks().run()
            }
          ]
        }
      ]
    },
    {
      label: "Lists",
      items: [
        {
          control: "button",
          id: "bullet-list",
          label: "Bulleted list",
          icon: List,
          pressed: state.bulletList,
          available: state.canBulletList,
          shortcut: "Mod+Shift+8",
          run: () => chain().toggleBulletList().run()
        },
        {
          control: "button",
          id: "ordered-list",
          label: "Numbered list",
          icon: ListOrdered,
          pressed: state.orderedList,
          available: state.canOrderedList,
          shortcut: "Mod+Shift+7",
          run: () => chain().toggleOrderedList().run()
        },
        {
          control: "menu",
          id: "numbering",
          label: "Numbering of this list",
          icon: SlidersHorizontal,
          // A fact about where the caret is, not a permission: outside a numbered list there is no
          // list to renumber.
          available: state.orderedList,
          width: 264,
          entries: [
            { kind: "heading", id: "marker-heading", label: "Counter style" },
            ...EDITOR_ORDERED_LIST_MARKERS.map((marker) => ({
              kind: "row" as const,
              id: `marker-${marker}`,
              label: ORDERED_LIST_MARKER_LABELS[marker],
              pressed: state.orderedListMarker === marker,
              available: state.orderedList,
              run: () =>
                chain()
                  // `type: null` for plain numbers, so the attribute is absent rather than storing
                  // "1" — which is what every list written before this control existed looks like.
                  .updateAttributes("orderedList", { type: marker === "1" ? null : marker })
                  .run()
            }))
          ],
          footer: (
            <OrderedListStartField
              editor={editor}
              value={state.orderedListStart}
              disabled={!state.orderedList}
            />
          )
        },
        {
          control: "menu",
          id: "code-language",
          label: "Language of this code block",
          icon: Braces,
          available: state.codeBlock,
          width: 264,
          entries: [
            { kind: "heading", id: "language-heading", label: "Printed above the block" },
            {
              kind: "row",
              id: "language-none",
              label: "No label",
              pressed: state.codeLanguage === "",
              available: state.codeBlock,
              run: () => chain().updateAttributes("codeBlock", { language: null }).run()
            },
            ...CODE_LANGUAGES.map((language) => ({
              kind: "row" as const,
              id: `language-${language.value}`,
              label: language.label,
              pressed: state.codeLanguage === language.value,
              available: state.codeBlock,
              run: () =>
                chain().updateAttributes("codeBlock", { language: language.value }).run()
            }))
          ]
        }
      ]
    },
    {
      label: "Insert",
      items: [
        ...(onRequestImage
          ? [
              {
                control: "button" as const,
                id: "image",
                label: "Picture with a caption, from the media library",
                icon: ImagePlus,
                available: true,
                run: onRequestImage
              }
            ]
          : []),
        ...(onRequestVideo
          ? [
              {
                control: "button" as const,
                id: "video",
                // The label says which of the two the press will do, because the button does both and
                // a control whose effect depends on the caret must say so where the caret is.
                label: state.videoEmbed
                  ? "Change this video"
                  : "Video — uploaded here, or from YouTube, Vimeo or Google Drive",
                icon: Film,
                // See `canVideo`: a video cannot land from every caret position, and a control that
                // does nothing when pressed is worse than one that is visibly unavailable.
                available: state.videoEmbed || state.canVideo,
                // `pressed` rather than a second style: the button reports the caret's state through
                // `aria-pressed`, which is the same thing the bold and link buttons do.
                pressed: state.videoEmbed,
                run: onRequestVideo
              }
            ]
          : []),
        {
          control: "button",
          id: "table",
          label: "Table, three rows by three columns",
          icon: TableIcon,
          available: state.canTable,
          run: () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
        },
        {
          control: "button",
          id: "footnote",
          label: "Footnote",
          icon: Asterisk,
          available: state.canFootnote,
          run: () => chain().insertFootnote().run()
        },
        {
          control: "menu",
          id: "insert",
          label: "Insert something else",
          icon: Plus,
          available: true,
          width: 312,
          entries: [
            { kind: "heading", id: "boxes-heading", label: "Note boxes" },
            ...CALLOUT_TONES.map((tone) => ({
              kind: "row" as const,
              id: `callout-${tone}`,
              label: `${CALLOUT_TONE_LABELS[tone]} box`,
              hint: CALLOUT_TONE_HINTS[tone],
              icon: CALLOUT_TONE_ICONS[tone],
              pressed: state.callout && state.calloutTone === tone,
              available: state.canCallout,
              run: () => chain().toggleCallout(tone).run()
            })),

            { kind: "heading", id: "structure-heading", label: "Structure" },
            {
              kind: "row",
              id: "definition-list",
              label: "Definition list",
              hint: "Pairs a short term with its meaning. For a glossary or a materials list.",
              icon: BookA,
              available: state.canDefinitionList,
              run: () => chain().insertDefinitionList().run()
            },
            ...COLUMN_COUNTS.map((count) => ({
              kind: "row" as const,
              id: `columns-${count}`,
              label: COLUMN_COUNT_LABELS[count],
              hint: COLUMN_COUNT_HINTS[count],
              icon: COLUMN_COUNT_ICONS[count],
              pressed: state.columns && state.columnCount === count,
              available: state.canColumns,
              run: () => chain().toggleColumns(count).run()
            })),

            { kind: "heading", id: "rules-heading", label: "Dividing lines" },
            ...RULE_VARIANTS.map((variant) => ({
              kind: "row" as const,
              id: `rule-${variant}`,
              label: RULE_VARIANT_LABELS[variant],
              hint: RULE_VARIANT_HINTS[variant],
              icon: variant === "ornament" ? Sparkles : Minus,
              available: state.canRule,
              run: () => chain().setRule(variant).run()
            })),

            { kind: "heading", id: "credit-heading", label: "Quote credit" },
            {
              kind: "row",
              id: "attribution",
              label: "Attribution line",
              hint: "Who said it. Only inside a quote or a pull quote.",
              icon: Quote,
              available: state.canAttribution,
              run: () => chain().setAttribution().run()
            },
            {
              kind: "row",
              id: "attribution-remove",
              label: "Remove this attribution",
              icon: X,
              available: state.inAttribution,
              run: () => chain().unsetAttribution().run()
            }
          ]
        }
      ]
    },
    {
      label: "Undo",
      items: [
        {
          control: "button",
          id: "undo",
          label: "Undo",
          icon: Undo2,
          available: state.canUndo,
          shortcut: "Mod+Z",
          run: () => chain().undo().run()
        },
        {
          control: "button",
          id: "redo",
          label: "Redo",
          icon: Redo2,
          available: state.canRedo,
          shortcut: "Mod+Shift+Z",
          run: () => chain().redo().run()
        },
        {
          control: "button",
          id: "shortcuts",
          label: "Keyboard shortcuts",
          icon: CircleHelp,
          available: true,
          run: onShowShortcuts
        }
      ]
    }
  ];

  // The reachable order, flattened across groups: arrow keys cross a group boundary without the
  // reader having to know there was one. A menu trigger is a member like any other button — see the ⚠
  // in the header about why `DropdownMenu` could not be used here.
  const reachableIds = groups.flatMap((group) =>
    group.items.filter((item) => item.available).map((item) => item.id)
  );
  const roving = useRovingFocus(reachableIds);

  // The mask must only appear when there is something off-screen to hint at. Observing the scroller is
  // enough: every control is always rendered (unavailable ones are disabled, not removed), so the
  // content width does not change on its own.
  useEffect(() => {
    const element = roving.containerRef.current;
    if (!element) return;
    const measure = () => setOverflowing(element.scrollWidth - element.clientWidth > 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [roving.containerRef]);

  return (
    <div
      // Sticky at rung 10 — "sticky in-page chrome (table heads, studio toolbars)" from the ladder in
      // contract §6. It must never be raised: the studio top bar is at 50 and owns everything above.
      // The menu panels sit at 70 because they are portalled to `<body>` and Popover owns that rung.
      //
      // ⚠ The offset is an INLINE STYLE, not a `top-*` class: it is a prop, and a class name built by
      // interpolating one is purged by the content scan (contract §5). Same reasoning as Dialog's
      // z-index.
      style={{ top: stickyOffset }}
      className={cn("sticky z-10 border-b border-line-200 bg-surface-50", className)}
    >
      <div
        ref={roving.containerRef}
        role="toolbar"
        aria-label={label}
        aria-orientation="horizontal"
        onKeyDown={roving.onKeyDown}
        className={cn(
          "flex items-center gap-1 overflow-x-auto px-2 py-1.5",
          overflowing && "mask-edges-x"
        )}
      >
        {groups.map((group, groupIndex) => (
          <div
            key={group.label}
            role="group"
            aria-label={group.label}
            className={cn(
              "flex shrink-0 items-center gap-0.5",
              // A hairline between groups instead of a gap: at this density a gap wide enough to read
              // as a separation is wide enough to cost a button on a phone.
              groupIndex > 0 && "ml-1 border-l border-line-200 pl-1.5"
            )}
          >
            {group.items.map((item) =>
              item.control === "menu" ? (
                <ToolbarMenu
                  key={item.id}
                  menu={item}
                  isTabStop={item.id === roving.currentStop}
                  onFocused={roving.onFocused}
                />
              ) : (
                <ToolbarButton
                  key={item.id}
                  item={item}
                  isTabStop={item.id === roving.currentStop}
                  onFocused={roving.onFocused}
                />
              )
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolbarButton({
  item,
  isTabStop,
  onFocused
}: {
  item: ToolbarButtonSpec;
  isTabStop: boolean;
  onFocused: (id: string) => void;
}): ReactNode {
  const Icon = item.icon;
  const title = item.shortcut ? `${item.label} (${describeShortcut(item.shortcut)})` : item.label;

  return (
    <button
      type="button"
      data-toolbar-item={item.id}
      // ONE tab stop. Every other button is reachable by arrow key only, which is what makes the
      // toolbar a single stop in the page's tab order.
      tabIndex={isTabStop ? 0 : -1}
      disabled={!item.available}
      aria-label={item.label}
      aria-pressed={item.pressed}
      // `title` is the mouse user's label. It is a duplicate of `aria-label`, deliberately: nothing
      // here exists ONLY in the tooltip (Tooltip.tsx's rule), and the shortcut is the extra a mouse
      // user gets for free.
      title={title}
      // A pointer press must not steal focus from the writing area — the caret is where the command
      // is going to apply, and a button that takes focus first collapses the selection.
      onMouseDown={(event) => event.preventDefault()}
      onFocus={() => onFocused(item.id)}
      onClick={item.run}
      className={editorControlClass({ active: item.pressed, unavailable: !item.available })}
    >
      <Icon aria-hidden="true" className="h-4 w-4" />
    </button>
  );
}

/**
 * A toolbar control that opens a panel.
 *
 * ⚠ THE TRIGGER TAKES FOCUS, unlike every other button in this bar. It has to: it owns
 * `aria-expanded`, it is a member of the roving group, and the panel's own focus has to come back
 * somewhere on Escape. That is safe because ProseMirror REMEMBERS its selection across a blur and
 * every command in these panels runs through `editor.chain().focus()`, which restores it — the one
 * exception is the numbering panel's number field, and its own comment explains why it must not.
 */
function ToolbarMenu({
  menu,
  isTabStop,
  onFocused
}: {
  menu: ToolbarMenuSpec;
  isTabStop: boolean;
  onFocused: (id: string) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerId = useId();
  const panelId = useId();
  const Icon = menu.icon;

  const close = useCallback(() => {
    // Focus only comes back to the trigger if it was inside the panel. After a click elsewhere on the
    // page, yanking it back would move the reader away from what they had just done.
    const panel = panelRef.current;
    const active = document.activeElement;
    const inside = panel !== null && active instanceof Node && panel.contains(active);
    setOpen(false);
    if (inside) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  /**
   * Focus the first control in the panel, on the frame AFTER it opens.
   *
   * A portalled panel sits at the end of `<body>`, so Tab from the trigger would walk past the whole
   * page rather than into the panel. Moving focus in is what makes the panel reachable at all — and it
   * must wait a frame, because Popover needs one extra commit to resolve its portal target, and
   * `preventScroll` because a scroll raised by focusing looks like a user scroll to Popover and would
   * close the panel it had just opened.
   */
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]), input:not([disabled])'
      );
      first?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown") return;
    // ArrowDown opens, the way every menu button does — but ArrowLeft and ArrowRight are left alone so
    // they still move along the toolbar. That is the one keyboard difference from a normal menu, and
    // it is the right one: this button lives in a bar.
    event.preventDefault();
    setOpen(true);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-toolbar-item={menu.id}
        id={triggerId}
        tabIndex={isTabStop ? 0 : -1}
        disabled={!menu.available}
        // ⚠ NO `aria-haspopup`, deliberately. Its allowed values are `menu`, `listbox`, `tree`, `grid`
        // and `dialog`, and this panel is none of them — it is a `role="group"` of toggle buttons (see
        // the header for why). Claiming `menu` would promise a screen-reader user arrow-key navigation
        // and `menuitem` semantics that are not there. `aria-expanded` plus `aria-controls` is the
        // disclosure pattern, and it describes exactly what this is.
        aria-expanded={open}
        // Only while the panel is in the document; an id that is not there is worse than none (§11).
        aria-controls={open ? panelId : undefined}
        aria-label={menu.label}
        title={menu.label}
        onFocus={() => onFocused(menu.id)}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={onTriggerKeyDown}
        className={editorControlClass({ active: open, unavailable: !menu.available })}
      >
        <Icon aria-hidden="true" className="h-4 w-4" />
        {menu.caption ? (
          <span className="max-w-[8.5rem] truncate">{menu.caption}</span>
        ) : null}
        <ChevronDown aria-hidden="true" className="h-3 w-3 shrink-0" />
      </button>

      <Popover
        open={open}
        onClose={close}
        anchorRef={triggerRef}
        panelRef={panelRef}
        side="bottom"
        align="start"
        // `group`, not `menu` — see the ⚠ in this file's header, and the trigger's own note about why
        // it carries no `aria-haspopup` to match.
        role="group"
        id={panelId}
        labelledBy={triggerId}
        width={menu.width}
      >
        {menu.entries.map((entry) =>
          entry.kind === "heading" ? (
            <p
              key={entry.id}
              // A plain heading, not a `role="separator"`: it carries words, and a separator with a
              // label is announced twice by some screen readers.
              className="px-2.5 pb-1 pt-2.5 text-xs font-semibold uppercase tracking-wide text-ink-500 first:pt-1"
            >
              {entry.label}
            </p>
          ) : (
            <button
              key={entry.id}
              type="button"
              disabled={!entry.available}
              aria-pressed={entry.pressed}
              onClick={() => {
                entry.run();
                close();
              }}
              className={cn(
                MENU_ROW_BASE,
                !entry.available
                  ? MENU_ROW_STATE.unavailable
                  : entry.pressed
                    ? MENU_ROW_STATE.active
                    : MENU_ROW_STATE.idle
              )}
            >
              {entry.icon ? (
                <entry.icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              ) : (
                // A blank of the icon's exact width, so rows with and without one still line up. The
                // text-colour rows have no icon on purpose: three identical swatches would say less
                // than their names already do.
                <span aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{entry.label}</span>
                {entry.hint ? (
                  <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">
                    {entry.hint}
                  </span>
                ) : null}
              </span>
            </button>
          )
        )}

        {menu.footer}
      </Popover>
    </>
  );
}

/**
 * "Start at" for a numbered list.
 *
 * ⚠ IT UPDATES WITHOUT `.focus()`, WHICH IS THE OPPOSITE OF EVERY OTHER CONTROL HERE. `chain().focus()`
 * would pull focus back into the writing area on the first keystroke, so typing "12" would set the
 * list to 1 and then throw the caret out of the field. ProseMirror keeps its selection while focus is
 * elsewhere, so `updateAttributes` still lands on the list the author is looking at.
 *
 * Local state, committed only when the value is a real number in range: a controlled input driven
 * straight off the document would make an empty box impossible to type through — clearing it would
 * snap the old number back before the new one could be typed. Out-of-range and half-typed values are
 * simply not committed, and the box keeps what was typed until it becomes valid.
 *
 * It remounts on every open (Popover unmounts its panel), so the seed is always the current value.
 */
function OrderedListStartField({
  editor,
  value,
  disabled
}: {
  editor: Editor;
  value: number;
  disabled: boolean;
}): ReactNode {
  const fieldId = useId();
  const [draft, setDraft] = useState(() => String(value));

  const commit = (next: string) => {
    setDraft(next);
    const parsed = Number.parseInt(next, 10);
    if (!Number.isFinite(parsed)) return;
    if (parsed < ORDERED_LIST_START_MIN || parsed > ORDERED_LIST_START_MAX) return;
    editor.chain().updateAttributes("orderedList", { start: parsed }).run();
  };

  return (
    <div className="mt-1 border-t border-line-200 px-2.5 pb-1 pt-2.5">
      <label htmlFor={fieldId} className="block text-xs font-medium text-ink-700">
        Start at
      </label>
      <input
        id={fieldId}
        type="number"
        inputMode="numeric"
        min={ORDERED_LIST_START_MIN}
        max={ORDERED_LIST_START_MAX}
        value={draft}
        disabled={disabled}
        onChange={(event) => commit(event.target.value)}
        // Both halves of the ring named: a bare `ring-4` is stock BLUE (contract §3).
        className="mt-1 w-24 rounded-md border border-line-200 bg-card px-2 py-1 text-sm text-ink-900 outline-none transition focus:border-purple-600 focus:ring-4 focus:ring-purple-600/15 disabled:cursor-not-allowed disabled:text-ink-300"
      />
      <p className="mt-1.5 text-xs leading-relaxed text-ink-500">
        {`Whole numbers from ${ORDERED_LIST_START_MIN} to ${ORDERED_LIST_START_MAX}. Use it to carry on a list that a picture or a note interrupted.`}
      </p>
    </div>
  );
}

/**
 * "Mod+Shift+X" → "Ctrl + Shift + X", or the Mac wording. Spaced, because "Mod+Shift+X" is unreadable.
 *
 * Reading `navigator` here is safe despite being render-time: `useEditor({ immediatelyRender: false })`
 * returns null on the server AND on the first client render, so no button — and therefore no `title`
 * — exists in the HTML that hydration compares.
 */
function describeShortcut(shortcut: string): string {
  const isMac =
    typeof navigator !== "undefined" && /Mac|iPad|iPhone|iPod/.test(navigator.userAgent);
  return shortcut
    .split("+")
    .map((part) => (part === "Mod" ? (isMac ? "Cmd" : "Ctrl") : part))
    .join(" + ");
}
