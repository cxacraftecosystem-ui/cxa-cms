"use client";

/**
 * RepeaterField — the add / remove / reorder list every repeating block is built from: the figures in
 * a key-figures block, the cards in a feature grid, the entries in a timeline, the questions in an
 * FAQ, the columns in a footer.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * FIVE DECISIONS, EACH OF WHICH IS A COMPLAINT THIS AVOIDS.
 *
 * 1. REORDERING WORKS FROM THE KEYBOARD, NOT ONLY BY DRAGGING. Drag is the discoverable way and it is
 *    here; it is also unusable with a keyboard, unusable with a screen reader and awkward on a small
 *    trackpad. So every row also carries plain "Move up" and "Move down" buttons, and a move — by
 *    either route — is announced, because a list that silently rearranged itself tells a reader who
 *    cannot see it nothing at all.
 *
 * 2. THE END-OF-LIST BUTTONS ARE `aria-disabled`, NOT `disabled`. Browsers blur a control the moment
 *    it becomes `disabled`, so moving a row to the top with the keyboard would drop focus to the
 *    document body and the next press would start from the top of the page. These stay focusable and
 *    do nothing, which keeps the reader standing where they were.
 *
 * 3. EACH ROW IS COLLAPSED TO A SUMMARY DRAWN FROM ITS OWN CONTENT. Forty timeline entries expanded
 *    is a screen nobody can navigate; forty rows reading "Entry 1, Entry 2" is no better. The summary
 *    is the caller's, because only the caller knows which field of an item names it.
 *
 * 4. REMOVAL IS CONFIRMED ONLY WHEN THERE IS SOMETHING TO LOSE. Confirming the removal of a row
 *    somebody has just added and not typed in is friction with no benefit, and friction with no
 *    benefit is what teaches people to click through confirmations without reading them.
 *
 * 5. THE LIMIT IS STATED BEFORE IT IS REACHED. "You can add up to 8; 6 added" is on screen from the
 *    first row, so the cap is a fact the editor plans around rather than a refusal that arrives after
 *    they have written the ninth one (contract §1.6 — a cap that is not stated is a lie).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ROWS ARE KEYED BY A GENERATED KEY, NOT BY THEIR INDEX. Two things depend on it: React reuses the
 * same DOM nodes when a row moves (so focus follows the row that moved, with no refocus code), and the
 * expanded/collapsed set stays attached to the ITEM rather than to the position — with index keys,
 * moving row 3 up would collapse row 2 and expand row 3 instead.
 *
 * NO ENTRANCE OR HEIGHT ANIMATION. The studio is calm and dense: an administrator opening a row wants
 * to be typing in it, not watching it unfold, and thirty animated heights in one list is a page that
 * feels broken. The chevron's rotation is a plain CSS transition, which the global reduced-motion rule
 * already collapses.
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, GripVertical, Plus, Trash2 } from "lucide-react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { HelpText } from "@/components/studio/HelpText";

/** Past this many rows a new list opens collapsed. Four expanded sub-forms still fit on one screen. */
const EXPAND_ALL_BELOW = 5;

export interface RepeaterItemRenderArgs<T> {
  item: T;
  /** 0-based. Shown to the reader as `index + 1`, because rows are counted from one everywhere else. */
  index: number;
  /** Replaces this row. Sub-forms call it with a spread: `update({ ...item, label: next })`. */
  update: (next: T) => void;
}

export interface RepeaterFieldProps<T> {
  /** The group's name, as a plural noun: "Figures", "Questions and answers". */
  label: string;
  /** The schema's own `.describe()` sentence for this list. */
  help?: ReactNode;
  items: readonly T[];
  onChange: (next: T[]) => void;
  /**
   * The schema's `.max()`. It is enforced here AND stated on screen — passing a different number from
   * the schema's would mean the form accepts a list the save then refuses.
   */
  max: number;
  /** A blank row. A FACTORY, so two added rows are never the same object. */
  createItem: () => T;
  /** One line naming this row, from its own content. Return `""` when there is nothing to name it by. */
  summary: (item: T, index: number) => string;
  /** Is there anything in this row? Decides whether removing it is confirmed. */
  isEmpty: (item: T) => boolean;
  renderItem: (args: RepeaterItemRenderArgs<T>) => ReactNode;
  /** The singular noun, lower case, as an administrator says it: "figure", "question", "entry". */
  itemNoun: string;
  /** Defaults to "Add a {itemNoun}". */
  addLabel?: string;
  /** What the empty list says. Defaults to a sentence built from `itemNoun`. */
  emptyMessage?: ReactNode;
  /** A validation message for the list as a whole. Empty string and null both mean no error. */
  error?: string | null;
  className?: string;
}

export function RepeaterField<T>({
  label,
  help,
  items,
  onChange,
  max,
  createItem,
  summary,
  isEmpty,
  renderItem,
  itemNoun,
  addLabel,
  emptyMessage,
  error,
  className
}: RepeaterFieldProps<T>) {
  const confirm = useConfirm();
  const uid = useId();

  // The key generator. A ref rather than state: it is a counter nobody renders, and bumping it must
  // not schedule a render of its own.
  const nextKey = useRef(items.length);
  const [keys, setKeys] = useState<string[]>(() => items.map((_unused, index) => `${uid}-${index}`));
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(items.length < EXPAND_ALL_BELOW ? items.map((_unused, index) => `${uid}-${index}`) : [])
  );
  const [announcement, setAnnouncement] = useState("");

  /**
   * Re-seed the keys when the list length changed WITHOUT going through this component — the caller
   * discarding its draft, a revision being rolled back, a fresh block replacing the payload. Every
   * operation below updates both arrays together, so in normal use this effect finds nothing to do.
   */
  useEffect(() => {
    setKeys((current) => {
      if (current.length === items.length) return current;
      if (items.length < current.length) return current.slice(0, items.length);
      const grown = [...current];
      while (grown.length < items.length) {
        grown.push(`${uid}-${nextKey.current}`);
        nextKey.current += 1;
      }
      return grown;
    });
  }, [items.length, uid]);

  const commit = useCallback(
    (nextItems: T[], nextKeys: string[]) => {
      onChange(nextItems);
      setKeys(nextKeys);
    },
    [onChange]
  );

  const atLimit = items.length >= max;

  const add = useCallback(() => {
    if (atLimit) return;
    const key = `${uid}-${nextKey.current}`;
    nextKey.current += 1;
    commit([...items, createItem()], [...keys, key]);
    // A row somebody has just asked for opens: they added it in order to fill it in.
    setExpanded((current) => new Set(current).add(key));
    setAnnouncement(`${label}: ${itemNoun} ${items.length + 1} added.`);
  }, [atLimit, commit, createItem, items, itemNoun, keys, label, uid]);

  const move = useCallback(
    (from: number, to: number) => {
      if (from === to || to < 0 || to >= items.length) return;
      commit(arrayMove([...items], from, to), arrayMove(keys, from, to));
      setAnnouncement(
        `${itemNoun} moved from position ${from + 1} to position ${to + 1} of ${items.length}.`
      );
    },
    [commit, items, itemNoun, keys]
  );

  const remove = useCallback(
    async (index: number) => {
      const item = items[index];
      if (item === undefined) return;

      if (!isEmpty(item)) {
        const named = summary(item, index).trim();
        const agreed = await confirm({
          title: `Remove this ${itemNoun}?`,
          body: (
            <>
              {named.length > 0 ? (
                <p>
                  <span className="font-semibold text-ink-900">{named}</span> will be taken out of this
                  block.
                </p>
              ) : (
                <p>This {itemNoun} will be taken out of this block.</p>
              )}
              <p className="mt-2">
                It cannot be put back from here, though the page&rsquo;s history still holds the version
                that had it.
              </p>
            </>
          ),
          confirmLabel: "Remove"
        });
        if (!agreed) return;
      }

      commit(
        items.filter((_unused, position) => position !== index),
        keys.filter((_unused, position) => position !== index)
      );
      setAnnouncement(`${itemNoun} ${index + 1} removed. ${items.length - 1} left.`);
    },
    [commit, confirm, isEmpty, items, itemNoun, keys, summary]
  );

  const toggle = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /**
   * A short press must still be a click. Without the distance constraint the pointer sensor claims
   * every press on the grip and the handle can never be focused by clicking it, which is exactly how a
   * drag handle stops working with a trackpad.
   */
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const from = keys.indexOf(String(active.id));
      const to = keys.indexOf(String(over.id));
      if (from === -1 || to === -1) return;
      move(from, to);
    },
    [keys, move]
  );

  const countSentence = `You can add up to ${max}; ${items.length} added.`;
  const trimmedError = typeof error === "string" ? error.trim() : "";

  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="field-label">{label}</span>
        <span className={cn("text-xs tabular-nums", atLimit ? "text-amber-800" : "text-ink-500")}>
          {countSentence}
        </span>
      </div>

      {help ? <p className="mt-1 text-xs leading-relaxed text-ink-500">{help}</p> : null}

      {/*
        Mounted in both states so the region is registered before its content ever changes — a live
        region inserted at the same instant as its text is announced inconsistently (the same pattern
        as Field.tsx's character-limit notice).
      */}
      <span role="status" className="sr-only">
        {announcement}
      </span>

      {items.length === 0 ? (
        // Not `EmptyState`: that renders its own heading, and this list sits inside a form whose
        // heading levels belong to the screen around it (contract §14).
        <div className="mt-2 rounded-md border border-dashed border-line-200 bg-surface-50 px-4 py-6 text-center">
          <p className="text-sm text-ink-500">
            {emptyMessage ?? `No ${itemNoun}s yet. Add the first one to fill this block in.`}
          </p>
          <Button variant="secondary" size="sm" icon={Plus} onClick={add} className="mt-3">
            {addLabel ?? `Add a ${itemNoun}`}
          </Button>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          // Vertical only, and never outside the list: a row dragged sideways out of its own group is
          // a drag with nowhere to land, and the pointer ends up somewhere the drop cannot be read.
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={keys} strategy={verticalListSortingStrategy}>
            <ul className="mt-2 space-y-2">
              {items.map((item, index) => {
                const key = keys[index];
                // Only possible in the one render between the caller growing the list and the effect
                // above catching up. Skipping the row for that frame beats keying it by its index and
                // shuffling every row's expanded state.
                if (key === undefined) return null;

                return (
                  <RepeaterRow
                    key={key}
                    rowKey={key}
                    index={index}
                    count={items.length}
                    itemNoun={itemNoun}
                    summary={summary(item, index)}
                    open={expanded.has(key)}
                    onToggle={() => toggle(key)}
                    onMove={move}
                    onRemove={() => void remove(index)}
                  >
                    {renderItem({
                      item,
                      index,
                      update: (next) =>
                        onChange(items.map((current, position) => (position === index ? next : current)))
                    })}
                  </RepeaterRow>
                );
              })}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      {items.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {atLimit ? (
            <HelpText tone="warn">
              That is the most this block holds. Remove one before adding another, or add a second block
              below this one.
            </HelpText>
          ) : (
            <Button variant="secondary" size="sm" icon={Plus} onClick={add}>
              {addLabel ?? `Add a ${itemNoun}`}
            </Button>
          )}
        </div>
      ) : null}

      {trimmedError.length > 0 ? (
        <HelpText tone="error" className="mt-2">
          {trimmedError}
        </HelpText>
      ) : null}
    </div>
  );
}

interface RepeaterRowProps {
  rowKey: string;
  index: number;
  count: number;
  itemNoun: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  onMove: (from: number, to: number) => void;
  onRemove: () => void;
  children: ReactNode;
}

function RepeaterRow({
  rowKey,
  index,
  count,
  itemNoun,
  summary,
  open,
  onToggle,
  onMove,
  onRemove,
  children
}: RepeaterRowProps) {
  const bodyId = `${rowKey}-body`;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: rowKey });

  const isFirst = index === 0;
  const isLast = index === count - 1;
  const position = `${index + 1} of ${count}`;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "rounded-md border border-line-200 bg-card",
        // The lift is two signals, and only one is motion: the shadow moves, the named ring does not.
        // A bare `ring-2` would be stock blue (contract §3).
        isDragging && "relative z-10 shadow-panel ring-2 ring-purple-600/30"
      )}
    >
      <div className="flex items-center gap-1 px-1.5 py-1.5">
        <button
          type="button"
          ref={setActivatorNodeRef}
          // `touch-none` stops a phone scrolling the page instead of starting the drag.
          className="inline-flex h-8 w-7 shrink-0 cursor-grab touch-none items-center justify-center rounded text-ink-300 transition hover:text-ink-700 focus-visible:ring-2 focus-visible:ring-purple-600/30"
          aria-label={`Drag to reorder ${itemNoun} ${position}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical aria-hidden="true" className="h-4 w-4" />
        </button>

        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          // Only while the panel exists: `aria-controls` pointing at a missing id is worse than not
          // pointing at all (contract §11).
          aria-controls={open ? bodyId : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1.5 text-left transition hover:bg-surface-100"
        >
          <span className="shrink-0 text-xs tabular-nums text-ink-500">{index + 1}</span>
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm",
              summary.trim().length > 0 ? "text-ink-900" : "text-ink-500"
            )}
          >
            {summary.trim().length > 0 ? summary : `This ${itemNoun} is empty`}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "h-4 w-4 shrink-0 text-ink-500 transition-transform",
              open && "rotate-180"
            )}
          />
        </button>

        <div className="flex shrink-0 items-center">
          <MoveButton
            direction="up"
            unavailable={isFirst}
            label={`Move ${itemNoun} ${position} up`}
            onClick={() => onMove(index, index - 1)}
          />
          <MoveButton
            direction="down"
            unavailable={isLast}
            label={`Move ${itemNoun} ${position} down`}
            onClick={() => onMove(index, index + 1)}
          />
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${itemNoun} ${position}`}
            className="inline-flex h-8 w-8 items-center justify-center rounded text-ink-500 transition hover:bg-error-100 hover:text-error-600 focus-visible:ring-2 focus-visible:ring-error-600/30"
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      </div>

      {open ? (
        <div id={bodyId} className="space-y-4 border-t border-line-200 px-3 py-4">
          {children}
        </div>
      ) : null}
    </li>
  );
}

/**
 * One end-of-list-aware move button.
 *
 * `aria-disabled` and a no-op rather than `disabled` — see decision 2 in the header. The greyed
 * treatment still says it is unavailable; what it does not do is throw the keyboard back to the top of
 * the document at the exact moment somebody finishes moving a row to the top of the list.
 */
function MoveButton({
  direction,
  unavailable,
  label,
  onClick
}: {
  direction: "up" | "down";
  unavailable: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-disabled={unavailable || undefined}
      onClick={() => {
        if (unavailable) return;
        onClick();
      }}
      className={cn(
        "inline-flex h-8 w-7 items-center justify-center rounded transition focus-visible:ring-2 focus-visible:ring-purple-600/30",
        unavailable ? "cursor-default text-ink-300 opacity-50" : "text-ink-500 hover:bg-surface-100 hover:text-ink-900"
      )}
    >
      <ChevronDown
        aria-hidden="true"
        className={cn("h-4 w-4", direction === "up" && "rotate-180")}
      />
    </button>
  );
}
