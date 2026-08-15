"use client";

/**
 * SectionList — the ordered list of blocks on a page, and the one place the reorder arithmetic lives.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * EVERY REORDER LEAVES HERE AS A COMPLETE ORDER, NOT AS A MOVE.
 *
 * `onReorder` is handed the whole list of ids, top to bottom, however the reader produced it — a drag,
 * a Move up, a Move down. Two consequences, and both are why it is shaped that way:
 *
 *   • The builder can send ONE request that rewrites the range in a transaction. N position updates can
 *     interleave and leave two blocks claiming one position, which the `@@unique([pageId, position])`
 *     constraint in prisma/schema.prisma then refuses — after some of the updates have landed.
 *   • The arithmetic is written once. "Move up" implemented separately from "drag" is two functions
 *     that have to agree about what happens at the ends of the list, and they will not.
 *
 * THREE ROUTES TO THE SAME REORDER, DELIBERATELY:
 *
 *   1. dragging the handle with a pointer;
 *   2. focusing the handle and pressing space, then the arrow keys — dnd-kit's `KeyboardSensor` with
 *      `sortableKeyboardCoordinates`;
 *   3. Move up and Move down in each block's menu.
 *
 * The third is not a fallback for the second. A reorder that only works by dragging — even a keyboard
 * drag — is a reorder that needs a sustained, coordinated gesture, and an administrator with a
 * trackpad injury, a tremor, or a switch device cannot make one. Two arrow-key presses in a menu can be
 * made by anybody, and they say out loud what happened because the position readout on each card
 * changes.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ `sections === null` MEANS "NOT LOADED YET" AND `[]` MEANS "THIS PAGE HAS NO BLOCKS" (contract §9).
 * They are two different screens with two different remedies: a shimmer, and an invitation to add the
 * first block. "This page has no blocks" shown during a fetch tells an administrator their page has
 * been emptied.
 *
 * THE ANNOUNCEMENTS ARE WRITTEN OUT rather than left to dnd-kit's defaults, which say "Draggable item 3
 * was moved over droppable area 5". A reader who cannot see the list needs the block's NAME and its new
 * position, which is what these say.
 */

import { useMemo } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type ScreenReaderInstructions
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { Blocks, Plus, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import {
  SectionCard,
  sectionDisplayName,
  type BuilderSection
} from "@/components/studio/builder/SectionCard";

export interface SectionListProps {
  /** ⚠ `null` is "still loading", `[]` is "there are no blocks". See the header. */
  sections: BuilderSection[] | null;
  /** The block whose settings the editor panel is showing, or null. */
  selectedId: string | null;
  /**
   * Plain sentences describing what cannot be saved, keyed by block id. Only blocks with a problem
   * appear; a missing key means the settings are fine.
   */
  problems: ReadonlyMap<string, string>;
  /** The block to outline as "just saved", or null. */
  flashId?: string | null;
  /** True while a block is being added, copied or removed. Reordering stands down for that moment. */
  busy?: boolean;
  /** The failure sentence from the last reorder that could not be saved, VERBATIM from the server. */
  reorderError?: string | null;
  /** The complete new order, top to bottom. See the header — never a move. */
  onReorder: (ids: string[]) => void;
  onSelect: (id: string) => void;
  onDuplicate: (id: string) => void;
  onToggleVisible: (id: string) => void;
  onDelete: (id: string) => void;
  /** Opens the palette to insert at this 0-based position. */
  onAdd: (position: number) => void;
  className?: string;
}

const SCREEN_READER_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    "Press the space bar to pick this block up. Use the up and down arrow keys to move it. Press the space bar again to drop it in its new place, or escape to leave it where it was. Move up and Move down in the block's own menu do the same thing without a drag."
};

export function SectionList({
  sections,
  selectedId,
  problems,
  flashId = null,
  busy = false,
  reorderError = null,
  onReorder,
  onSelect,
  onDuplicate,
  onToggleVisible,
  onDelete,
  onAdd,
  className
}: SectionListProps) {
  const sensors = useSensors(
    // A short distance before a drag begins, so a press that wobbles on a trackpad is still a click.
    // Without it, selecting a block by pressing its handle occasionally reorders the page instead.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const ids = useMemo(() => (sections ?? []).map((section) => section.id), [sections]);

  const announcements = useMemo<Announcements>(() => {
    const rows = sections ?? [];
    const nameOf = (id: string | number): string => {
      const found = rows.find((section) => section.id === String(id));
      return found ? sectionDisplayName(found) : "this block";
    };
    const positionOf = (id: string | number): number => rows.findIndex((row) => row.id === String(id)) + 1;

    return {
      onDragStart: ({ active }) =>
        `Picked up ${nameOf(active.id)}. It was at position ${positionOf(active.id)} of ${rows.length}.`,
      onDragOver: ({ active, over }) =>
        over
          ? `${nameOf(active.id)} would move to position ${positionOf(over.id)} of ${rows.length}.`
          : `${nameOf(active.id)} is not over a place it can go.`,
      onDragEnd: ({ active, over }) =>
        over
          ? `${nameOf(active.id)} was moved to position ${positionOf(over.id)} of ${rows.length}. The new order is being saved.`
          : `${nameOf(active.id)} was left where it was.`,
      onDragCancel: ({ active }) => `Reordering was cancelled. ${nameOf(active.id)} was left where it was.`
    };
  }, [sections]);

  // ── Loading ────────────────────────────────────────────────────────────────
  if (sections === null) {
    return (
      <div className={cn("space-y-2", className)}>
        <Skeleton lines={4} height="3.5rem" label="Loading the blocks on this page…" />
      </div>
    );
  }

  const total = sections.length;

  const move = (from: number, to: number) => {
    if (to < 0 || to >= total || from === to) return;
    onReorder(arrayMove(ids, from, to));
  };

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    onReorder(arrayMove(ids, from, to));
  };

  // ── Empty ──────────────────────────────────────────────────────────────────
  if (total === 0) {
    return (
      <div className={cn(className)}>
        <EmptyState
          icon={Blocks}
          // Level 3: the panel this sits inside already owns an h2, and a second h2 here would make the
          // panel's title and this sentence read as peers in the outline (contract §14).
          headingLevel={3}
          title="This page has no blocks yet"
          description="A page is built from blocks — an opening banner, some writing, a row of figures, a list of projects. Add the first one and it appears here, in the order readers will see it."
          action={
            <Button icon={Plus} onClick={() => onAdd(0)}>
              Add the first block
            </Button>
          }
        />
      </div>
    );
  }

  // ── The list ───────────────────────────────────────────────────────────────
  return (
    <div className={cn("space-y-3", className)}>
      <p className="text-xs leading-relaxed text-ink-500">
        {total === 1 ? "One block" : `${total} blocks`}, in the order a reader meets them. Drag the handle
        on the left, or use Move up and Move down in a block&rsquo;s menu — both do exactly the same
        thing.
      </p>

      {reorderError ? (
        /*
          `role="alert"`, because a reorder that did not save is the one thing on this screen the reader
          must be interrupted about: the list they are looking at has just been put back, and without
          this they would carry on believing their new order is on the server. The sentence is the
          server's own — `lib/api.ts` guarantees it is ready to render.
        */
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-error-200 bg-error-100 px-3 py-2 text-xs leading-relaxed text-error-600"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <span className="font-medium">The new order was not saved.</span> {reorderError} The list
            above has been put back to the order the server has, so nothing is half-done.
          </span>
        </p>
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        // Vertical only, and inside the list: a block dragged sideways out of the column is a block the
        // reader has to hunt for, and there is nowhere else on this screen for it to go.
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        accessibility={{
          announcements,
          screenReaderInstructions: SCREEN_READER_INSTRUCTIONS
        }}
        onDragEnd={onDragEnd}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {/* An `<ol>`, because the order IS the meaning here — a screen reader announcing "list, 7
              items" and a position for each one is telling the reader what the page looks like. */}
          <ol className="space-y-2">
            {sections.map((section, index) => (
              <SectionCard
                key={section.id}
                section={section}
                index={index}
                total={total}
                isSelected={section.id === selectedId}
                problem={problems.get(section.id) ?? null}
                busy={busy}
                flash={flashId === section.id}
                onSelect={() => onSelect(section.id)}
                onMoveUp={() => move(index, index - 1)}
                onMoveDown={() => move(index, index + 1)}
                onDuplicate={() => onDuplicate(section.id)}
                onToggleVisible={() => onToggleVisible(section.id)}
                onDelete={() => onDelete(section.id)}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>

      <Button variant="secondary" icon={Plus} fullWidth onClick={() => onAdd(total)}>
        Add a block at the end
      </Button>
    </div>
  );
}
