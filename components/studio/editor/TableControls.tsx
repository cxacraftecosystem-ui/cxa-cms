"use client";

/**
 * TableControls — the row of table commands, present only while the caret is inside a table.
 *
 * IT RENDERS NOTHING WHEN THE SELECTION IS NOT IN A TABLE. Ten permanently visible buttons that
 * refuse nine times out of ten are ten buttons an author learns to ignore; a bar that appears when it
 * applies is a bar that means something. This is a fact about where the caret is, not about
 * permission, so appearing and disappearing is right here and wrong for the main toolbar (see
 * EditorToolbar's header).
 *
 * THE BUTTONS CARRY VISIBLE WORDS, not only icons. There is no widely understood glyph for "split a
 * merged cell", and an administrator meeting this bar for the first time should not have to hover ten
 * things to find out what they do. The bar scrolls sideways on a narrow screen for the same reason the
 * toolbar does.
 *
 * "HEADER ROW" REFLECTS THE RENDERER'S RULE, not the cursor's cell. components/RichText.tsx promotes
 * the first row to a real `<thead>` only when EVERY cell in it is a header cell — so that is what the
 * pressed state is computed from. `isActive("tableHeader")` would say "on" whenever the caret happened
 * to sit in a single header cell somewhere in the middle of the table, and the author would believe
 * the table had column headings when the published page shows none.
 */

import { useEffect, useState } from "react";
import { useEditorState } from "@tiptap/react";
import { findParentNode, type Editor } from "@tiptap/core";
import {
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  Combine,
  PanelTop,
  Split,
  Table as TableIcon,
  Trash2,
  type LucideIcon
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  EDITOR_CONTROL_BASE,
  editorControlClass,
  useRovingFocus
} from "@/components/studio/editor/EditorToolbar";

/** The danger treatment. A complete literal string, and no colour in the base to fight with. */
const REMOVE_CLASS = "text-error-600 hover:bg-error-100 disabled:text-ink-300";

interface TableItem {
  id: string;
  /** The visible words. They are also the accessible name — see the note on `title` below. */
  label: string;
  /** The fuller sentence, on hover. It never carries information the label needs. */
  title: string;
  icon: LucideIcon;
  pressed?: boolean;
  available: boolean;
  run: () => void;
  className?: string;
}

/**
 * Does the FIRST row consist entirely of header cells?
 *
 * The same test RichText.tsx applies before it emits a `<thead>`. Written out rather than inferred
 * from `isActive`, so the studio's pressed state and the published page cannot disagree.
 */
function firstRowIsAllHeaders(instance: Editor): boolean {
  const table = findParentNode((node) => node.type.name === "table")(instance.state.selection);
  const firstRow = table?.node.firstChild;
  if (!firstRow || firstRow.childCount === 0) return false;
  for (let index = 0; index < firstRow.childCount; index += 1) {
    if (firstRow.child(index).type.name !== "tableHeader") return false;
  }
  return true;
}

function selectTableState(instance: Editor) {
  const can = instance.can().chain();
  return {
    inTable: instance.isActive("table"),
    hasHeaderRow: firstRowIsAllHeaders(instance),
    canAddRowBefore: can.addRowBefore().run(),
    canAddRowAfter: can.addRowAfter().run(),
    canDeleteRow: can.deleteRow().run(),
    canAddColumnBefore: can.addColumnBefore().run(),
    canAddColumnAfter: can.addColumnAfter().run(),
    canDeleteColumn: can.deleteColumn().run(),
    canToggleHeaderRow: can.toggleHeaderRow().run(),
    canMerge: can.mergeCells().run(),
    canSplit: can.splitCell().run(),
    canDeleteTable: can.deleteTable().run()
  };
}

type TableState = ReturnType<typeof selectTableState>;

export interface TableControlsProps {
  editor: Editor | null;
  className?: string;
}

export function TableControls({ editor, className }: TableControlsProps) {
  const state = useEditorState({
    editor,
    selector: ({ editor: instance }) => (instance ? selectTableState(instance) : null)
  });

  // Nothing at all, not an empty strip: the writing area must not shift down by 40px the moment a
  // caret enters a table and back up again when it leaves.
  if (!editor || !state?.inTable) return null;

  return <TableBar editor={editor} state={state} className={className} />;
}

function TableBar({
  editor,
  state,
  className
}: {
  editor: Editor;
  state: TableState;
  className?: string;
}) {
  const [overflowing, setOverflowing] = useState(false);
  const chain = () => editor.chain().focus();

  const items: TableItem[] = [
    {
      id: "row-before",
      label: "Row above",
      title: "Insert a row above this one",
      icon: ArrowUpToLine,
      available: state.canAddRowBefore,
      run: () => chain().addRowBefore().run()
    },
    {
      id: "row-after",
      label: "Row below",
      title: "Insert a row below this one",
      icon: ArrowDownToLine,
      available: state.canAddRowAfter,
      run: () => chain().addRowAfter().run()
    },
    {
      id: "row-delete",
      label: "Delete row",
      title: "Delete the row the cursor is in. Undo brings it back.",
      icon: Trash2,
      available: state.canDeleteRow,
      run: () => chain().deleteRow().run(),
      className: REMOVE_CLASS
    },
    {
      id: "column-before",
      label: "Column left",
      title: "Insert a column to the left of this one",
      icon: ArrowLeftToLine,
      available: state.canAddColumnBefore,
      run: () => chain().addColumnBefore().run()
    },
    {
      id: "column-after",
      label: "Column right",
      title: "Insert a column to the right of this one",
      icon: ArrowRightToLine,
      available: state.canAddColumnAfter,
      run: () => chain().addColumnAfter().run()
    },
    {
      id: "column-delete",
      label: "Delete column",
      title: "Delete the column the cursor is in. Undo brings it back.",
      icon: Trash2,
      available: state.canDeleteColumn,
      run: () => chain().deleteColumn().run(),
      className: REMOVE_CLASS
    },
    {
      id: "header-row",
      label: "Header row",
      title:
        "Turn the top row into column headings. A reader using a screen reader hears the heading before each cell.",
      icon: PanelTop,
      pressed: state.hasHeaderRow,
      available: state.canToggleHeaderRow,
      run: () => chain().toggleHeaderRow().run()
    },
    {
      id: "merge",
      label: "Merge",
      title: "Join the selected cells into one. Select two or more cells first.",
      icon: Combine,
      available: state.canMerge,
      run: () => chain().mergeCells().run()
    },
    {
      id: "split",
      label: "Split",
      title: "Separate a merged cell back into its own cells",
      icon: Split,
      available: state.canSplit,
      run: () => chain().splitCell().run()
    },
    {
      id: "delete-table",
      label: "Remove table",
      title: "Remove the whole table and everything in it. Undo brings it back.",
      icon: Trash2,
      available: state.canDeleteTable,
      run: () => chain().deleteTable().run(),
      className: REMOVE_CLASS
    }
  ];

  const roving = useRovingFocus(items.filter((item) => item.available).map((item) => item.id));

  // Same rule as the toolbar: the edge fade only appears while there is something off-screen, because
  // a permanent fade over the first and last button reads as two disabled controls.
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
      ref={roving.containerRef}
      role="toolbar"
      aria-label="Table"
      aria-orientation="horizontal"
      onKeyDown={roving.onKeyDown}
      className={cn(
        // Not sticky. The formatting toolbar above it is, and a second sticky bar would have to know
        // the first one's height — two numbers meaning one thing, which is how they drift apart.
        "flex items-center gap-1 overflow-x-auto border-b border-line-200 bg-surface-100 px-2 py-1.5",
        overflowing && "mask-edges-x",
        className
      )}
    >
      {/* Says why the bar appeared. `aria-hidden` because the toolbar's own label already says it. */}
      <span
        aria-hidden="true"
        className="ml-1 mr-1.5 inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-ink-500"
      >
        <TableIcon className="h-3.5 w-3.5" />
        Table
      </span>

      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            data-toolbar-item={item.id}
            tabIndex={item.id === roving.currentStop ? 0 : -1}
            disabled={!item.available}
            aria-pressed={item.pressed}
            // No `aria-label`: the visible words are the accessible name, so a voice-control user
            // saying "Header row" reaches this button (WCAG 2.5.3). The sentence goes in `title`.
            title={item.title}
            // A pointer press must not take focus from the writing area — the command applies at the
            // caret, and the cell selection would collapse before the command ran.
            onMouseDown={(event) => event.preventDefault()}
            onFocus={() => roving.onFocused(item.id)}
            onClick={item.run}
            className={
              item.className
                ? cn(EDITOR_CONTROL_BASE, item.className)
                : editorControlClass({ active: item.pressed, unavailable: !item.available })
            }
          >
            <Icon aria-hidden="true" className="h-3.5 w-3.5" />
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
