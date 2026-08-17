"use client";

/**
 * The people board — one list per group, ordered by hand.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * NOT A `DataTable`, AND THE REASON IS THE ORDERING. A person's position inside their group is
 * editorial — a head of department goes above a research assistant, whatever their names are — so the
 * screen has to be a set of ordered lists rather than a sortable table. A table whose rows could be
 * dragged AND sorted by a column heading would be two orders fighting over one list.
 *
 * ORDERING WORKS FROM THE KEYBOARD, NOT ONLY BY DRAGGING. Drag is the discoverable route and it is
 * here; it is also unusable with a keyboard and with a screen reader. So every row carries plain "Move
 * up" and "Move down" buttons, and every move is announced — a list that silently rearranged itself
 * tells a reader who cannot see it nothing at all (RepeaterField.tsx, decision 1).
 *
 * THE END-OF-LIST BUTTONS ARE `aria-disabled`, NEVER `disabled`. Browsers blur a control the moment it
 * becomes disabled, so moving somebody to the top of their group with the keyboard would drop focus to
 * the document body and the next press would start from the top of the page.
 *
 * ⚠ DRAGGING CANNOT MOVE SOMEBODY INTO ANOTHER GROUP. Each group is its own list. A person's group is a
 * field on their profile, and changing it by dropping a row somewhere would rewrite a fact about their
 * job through a gesture meant to change a running order. The screen says so rather than leaving the
 * reader to discover it by trying.
 *
 * THE ORDER IS SAVED IMMEDIATELY AND OPTIMISTICALLY. A save bar for a drag would mean an editor
 * dragging four names and losing all four to a stray navigation. If the write fails the list snaps back
 * to what the server last said and the failure is named.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ContentStatus, PersonKind } from "@prisma/client";
import {
  ChevronDown,
  EyeOff,
  GripVertical,
  PencilLine,
  Plus,
  SearchX,
  Trash2,
  UserRound
} from "lucide-react";
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

import { asApiClientError, del, patch, post } from "@/lib/client/fetcher";
import type { Picture } from "@/lib/media/screens";
import type { MediaLike } from "@/lib/media/url";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { EmptyState } from "@/components/ui/EmptyState";
import { MediaImage } from "@/components/ui/MediaImage";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/ToastProvider";
import { PERSON_KIND_GROUPS, PERSON_KIND_ORDER } from "@/components/site/PersonCard";
import { HelpText } from "@/components/studio/HelpText";
import { RowActions } from "@/components/studio/RowActions";

export interface PersonRow {
  id: string;
  name: string;
  slug: string;
  kind: PersonKind;
  designation: string | null;
  department: string | null;
  /** False hides them from the listings while their profile page still exists. */
  isVisible: boolean;
  sortOrder: number;
  status: ContentStatus;
  projectCount: number;
  publicationCount: number;
  photo: MediaLike | null;
  /**
   * The portrait's per-screen framing, resolved on the SERVER.
   *
   * It arrives resolved because the alternate photographs a framing names are ids in a JSONB column that
   * no relation joins, so only the page's own query can fetch them (lib/media/framing.ts) — and this board
   * runs in the browser. The avatar is small, which is not a reason to leave the framing behind: an editor
   * looking at this list at a given width should see what the site draws at that width.
   */
  picture: Picture | null;
}

export interface PeopleBoardProps {
  people: readonly PersonRow[];
  /**
   * True when a search or a filter is narrowing the roster. "Nobody matches this search" and "nobody
   * has been added yet" are different situations with different remedies, and an empty screen that does
   * not say which one it is reads as a fault.
   */
  filtered: boolean;
  canReorder: boolean;
  /** Why ordering is off, in words. Required whenever `canReorder` is false. */
  reorderStandDownReason: string | null;
  canDelete: boolean;
  canPublish: boolean;
}

const ENDPOINT = {
  detail: (id: string) => `/api/studio/people/${encodeURIComponent(id)}`,
  reorder: "/api/studio/people/reorder"
} as const;

/**
 * One arrangement waiting to be saved: the order to send, and the board it came from.
 *
 * The rows travel WITH the ids because they are what the board goes back to if a later save fails —
 * remembering only the ids would mean rebuilding the arrangement from a `rows` that has since moved on.
 */
interface OrderAttempt {
  ids: string[];
  rows: readonly PersonRow[];
}

const RETENTION_DAYS = 30;

export function PeopleBoard({
  people,
  filtered,
  canReorder,
  reorderStandDownReason,
  canDelete,
  canPublish
}: PeopleBoardProps) {
  const router = useRouter();
  const confirm = useConfirm();
  const { toast } = useToast();

  /**
   * The rows as the screen currently shows them.
   *
   * Seeded from the server and re-seeded whenever the server sends a new array — which happens on a
   * navigation or a `router.refresh()`, and not on this component's own state changes. That is what
   * makes an optimistic reorder visible immediately and still lets the server be the authority a moment
   * later.
   */
  const [rows, setRows] = useState<readonly PersonRow[]>(people);

  /**
   * The last arrangement the SERVER agreed to, and what a failed save snaps back to.
   *
   * ⚠ NOT the `people` prop, which is what this used to snap back to. A save that succeeds asks for a
   * `router.refresh()`, and that payload takes a round trip to land — until it does, the prop still
   * holds the order from BEFORE that save. Reverting to it after a LATER move failed therefore rewound
   * the board past the failure and undid a move that had actually been committed, which reads as the
   * board losing work at random.
   */
  const confirmedRows = useRef<readonly PersonRow[]>(people);

  /**
   * One request in flight per group, and one slot holding that group's LATEST order.
   *
   * Every request carries the COMPLETE order of its group, so an older one is not merely redundant, it
   * is wrong: an editor pressing "move down" four times used to fire four overlapping POSTs that
   * contended for the same rows, and whichever landed last decided the order. Joining the running
   * request is how that is prevented. Same shape as `PageBuilder`'s `orderBusy`/`orderPending`.
   */
  const orderBusy = useRef(new Set<PersonKind>());
  const orderPending = useRef(new Map<PersonKind, OrderAttempt>());

  useEffect(() => {
    // A refresh landing mid-drag must not rewind the board: anything queued is NEWER than this payload,
    // and the save that is running will ask for another refresh when it finishes.
    if (orderBusy.current.size > 0 || orderPending.current.size > 0) return;
    setRows(people);
    confirmedRows.current = people;
  }, [people]);

  const [announcement, setAnnouncement] = useState("");
  const [savingKind, setSavingKind] = useState<PersonKind | null>(null);

  const groups = useMemo(
    () =>
      PERSON_KIND_ORDER.map((kind) => ({
        kind,
        members: rows.filter((row) => row.kind === kind)
      })).filter((group) => group.members.length > 0),
    [rows]
  );

  const pushOrder = useCallback(
    async (kind: PersonKind, attempt: OrderAttempt) => {
      if (orderBusy.current.has(kind)) {
        orderPending.current.set(kind, attempt);
        return;
      }

      orderBusy.current.add(kind);
      setSavingKind(kind);
      try {
        let queued: OrderAttempt | undefined = attempt;
        let saved = false;

        while (queued) {
          orderPending.current.delete(kind);
          try {
            await post(ENDPOINT.reorder, { kind, ids: queued.ids });
            confirmedRows.current = queued.rows;
            saved = true;
          } catch (thrown) {
            // Snap back to what the server last agreed to, so the screen never keeps an order the
            // database refused. Silently keeping it would be worse than the failure. Anything still
            // queued is dropped with it — it was built on top of the arrangement being thrown away.
            orderPending.current.delete(kind);
            setRows(confirmedRows.current);
            toast({
              tone: "error",
              title: `The order of ${PERSON_KIND_GROUPS[kind].toLowerCase()} has not been saved`,
              description: asApiClientError(thrown).message
            });
            return;
          }
          queued = orderPending.current.get(kind);
        }

        // Once, at the end, rather than after each request in the run: the list, the public pages and
        // the `sortOrder` numbers are all server-rendered from this, and one payload carries them all.
        if (saved) router.refresh();
      } finally {
        orderBusy.current.delete(kind);
        setSavingKind(null);
      }
    },
    [router, toast]
  );

  const move = useCallback(
    (kind: PersonKind, from: number, to: number) => {
      const members = rows.filter((row) => row.kind === kind);
      if (from === to) return;
      /**
       * ⚠ BOTH ENDS ARE BOUNDED, AND `from` IS THE ONE THAT USED NOT TO BE.
       *
       * `onDragEnd` derives both indexes with `indexOf`, which answers -1 for an id that is no longer
       * in the group — and `arrayMove(list, -1, to)` does not refuse that, it quietly moves the LAST
       * person instead and then saves it. A wrong move that persists is worse than no move at all.
       */
      if (from < 0 || from >= members.length) return;
      if (to < 0 || to >= members.length) return;

      const reordered = arrayMove([...members], from, to);
      const moved = members[from];

      /**
       * The group is rewritten IN PLACE. Appending it to the tail — which is what this used to do —
       * still renders correctly, because `groups` re-derives the sections from `PERSON_KIND_ORDER`
       * rather than from this array's shape. But it leaves `rows` in an order the server never had,
       * and this array is what `confirmedRows` remembers and what a failed save is compared against.
       */
      const queue = [...reordered];
      const nextRows = rows.map((row) => (row.kind === kind ? (queue.shift() ?? row) : row));

      setRows(nextRows);
      setAnnouncement(
        `${moved?.name ?? "That person"} moved from position ${from + 1} to position ${to + 1} of ${members.length} in ${PERSON_KIND_GROUPS[kind]}.`
      );
      void pushOrder(kind, { ids: reordered.map((row) => row.id), rows: nextRows });
    },
    [rows, pushOrder]
  );

  const askAndDelete = useCallback(
    async (person: PersonRow) => {
      const attached = person.projectCount + person.publicationCount;

      const agreed = await confirm({
        title: `Delete the profile for “${person.name}”?`,
        body: (
          <>
            <p>
              It will move to the recycle bin, where an administrator can restore it for{" "}
              {RETENTION_DAYS} days. The profile disappears from the public site straight away.
            </p>
            {attached > 0 ? (
              <p className="mt-2">
                {person.name} is named on{" "}
                {person.projectCount === 1 ? "1 project" : `${person.projectCount} projects`} and{" "}
                {person.publicationCount === 1
                  ? "1 publication"
                  : `${person.publicationCount} publications`}
                . Those records are not deleted, and the author lines on the publications are unchanged —
                the printed credit is a separate field and never comes from a profile. What goes is the
                link that put this publication on their page.
              </p>
            ) : null}
            <p className="mt-2">
              If they have simply left the Centre, changing their group to Alumni keeps the record
              instead.
            </p>
          </>
        ),
        confirmLabel: "Move to recycle bin",
        cancelLabel: "Keep the profile",
        tone: "danger"
      });
      if (!agreed) return;

      try {
        await del(ENDPOINT.detail(person.id));
        toast({
          tone: "success",
          title: `The profile for “${person.name}” is in the recycle bin`,
          description: `An administrator can restore it for the next ${RETENTION_DAYS} days.`
        });
        router.refresh();
      } catch (thrown) {
        toast({
          tone: "error",
          title: "The profile has not been deleted",
          description: asApiClientError(thrown).message
        });
      }
    },
    [confirm, router, toast]
  );

  const archive = useCallback(
    async (person: PersonRow) => {
      const agreed = await confirm({
        title: `Take the profile for “${person.name}” off the public site?`,
        body: (
          <p>
            It stays in the studio as an archived record and can be published again at any time. Anyone
            following a link to it will see a “page not found”.
          </p>
        ),
        confirmLabel: "Take it off the site",
        cancelLabel: "Leave it published"
      });
      if (!agreed) return;

      try {
        await patch(ENDPOINT.detail(person.id), { status: "ARCHIVED" });
        toast({ tone: "success", title: `“${person.name}” is no longer on the public site` });
        router.refresh();
      } catch (thrown) {
        toast({
          tone: "error",
          title: "It is still published",
          description: asApiClientError(thrown).message
        });
      }
    },
    [confirm, router, toast]
  );

  const sensors = useSensors(
    // Without the distance constraint the pointer sensor claims every press on the grip, and the handle
    // can never be focused by clicking it — which is exactly how a drag handle stops working on a
    // trackpad.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  if (rows.length === 0) {
    return (
      <EmptyState
        headingLevel={2}
        icon={filtered ? SearchX : UserRound}
        title={filtered ? "Nobody matches these filters" : "No profiles have been added yet"}
        description={
          filtered
            ? "Clear the filters above to see the whole roster. A search looks at the name, the job title, the department and the email address."
            : "A profile is how somebody appears on the public site. Faculty, scientists, students, staff, visitors and alumni all live here, each in their own group."
        }
        action={
          filtered ? null : (
            <LinkButton href="/studio/people/new" icon={Plus}>
              New profile
            </LinkButton>
          )
        }
      />
    );
  }

  return (
    <div className="space-y-8">
      {/* Mounted in both states so the region is registered before its content ever changes. */}
      <span role="status" className="sr-only">
        {announcement}
      </span>

      {!canReorder && reorderStandDownReason !== null ? (
        <HelpText>{reorderStandDownReason}</HelpText>
      ) : (
        <HelpText>
          Drag a name, or use the move buttons, to change the order within a group. The new order is
          saved straight away. Dragging cannot move somebody into another group — their group is a field
          on their own profile.
        </HelpText>
      )}

      {groups.map((group) => (
        <section key={group.kind} aria-labelledby={`group-${group.kind}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2
              id={`group-${group.kind}`}
              className="font-display text-base font-semibold text-ink-900"
            >
              {PERSON_KIND_GROUPS[group.kind]}
            </h2>
            <p className="text-xs tabular-nums text-ink-500">
              {group.members.length === 1 ? "1 person" : `${group.members.length} people`}
              {savingKind === group.kind ? " · saving the new order…" : ""}
            </p>
          </div>

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragEnd={(event: DragEndEvent) => {
              const { active, over } = event;
              if (!over || active.id === over.id) return;
              const ids = group.members.map((member) => member.id);
              move(group.kind, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
            }}
          >
            <SortableContext
              items={group.members.map((member) => member.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="mt-2 space-y-1.5">
                {group.members.map((member, index) => (
                  <PersonBoardRow
                    key={member.id}
                    person={member}
                    index={index}
                    count={group.members.length}
                    groupLabel={PERSON_KIND_GROUPS[group.kind]}
                    canReorder={canReorder}
                    canDelete={canDelete}
                    canPublish={canPublish}
                    onMove={(from, to) => move(group.kind, from, to)}
                    onDelete={() => void askAndDelete(member)}
                    onArchive={() => void archive(member)}
                    onOpen={() => router.push(`/studio/people/${member.id}`)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        </section>
      ))}
    </div>
  );
}

interface PersonBoardRowProps {
  person: PersonRow;
  index: number;
  count: number;
  groupLabel: string;
  canReorder: boolean;
  canDelete: boolean;
  canPublish: boolean;
  onMove: (from: number, to: number) => void;
  onDelete: () => void;
  onArchive: () => void;
  onOpen: () => void;
}

function PersonBoardRow({
  person,
  index,
  count,
  groupLabel,
  canReorder,
  canDelete,
  canPublish,
  onMove,
  onDelete,
  onArchive,
  onOpen
}: PersonBoardRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: person.id, disabled: !canReorder });

  const position = `${index + 1} of ${count} in ${groupLabel}`;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-line-200 bg-card px-2 py-2",
        // The lift is two signals and only one of them is motion: the shadow moves, the named ring does
        // not. A bare `ring-2` would be stock blue (contract §3).
        isDragging && "relative z-10 shadow-panel ring-2 ring-purple-600/30"
      )}
    >
      {canReorder ? (
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label={`Drag to reorder ${person.name}, currently ${position}`}
          // `touch-none` stops a phone scrolling the page instead of starting the drag.
          className="inline-flex h-8 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-ink-300 transition hover:text-ink-700 focus-visible:ring-2 focus-visible:ring-purple-600/30"
          {...attributes}
          {...listeners}
        >
          <GripVertical aria-hidden="true" className="h-4 w-4" />
        </button>
      ) : null}

      <span className="w-6 shrink-0 text-xs tabular-nums text-ink-500">{index + 1}</span>

      <MediaImage
        media={person.photo}
        picture={person.picture}
        // Decorative: the name is right beside it.
        alt=""
        aspect={1}
        rounded="sm"
        sizes="48px"
        className="h-11 w-11 shrink-0"
      />

      <span className="min-w-[12rem] flex-1">
        <Link
          href={`/studio/people/${person.id}`}
          className="rounded font-medium text-ink-900 underline-offset-4 transition-colors hover:text-purple-700 hover:underline"
        >
          {person.name}
        </Link>
        <span className="mt-0.5 block truncate text-xs text-ink-500">
          {[person.designation, person.department].filter(Boolean).join(" · ") || "No job title"}
        </span>
      </span>

      <span className="hidden shrink-0 text-xs tabular-nums text-ink-500 lg:block">
        {person.projectCount === 1 ? "1 project" : `${person.projectCount} projects`}
        <span aria-hidden="true"> · </span>
        {person.publicationCount === 1
          ? "1 publication"
          : `${person.publicationCount} publications`}
      </span>

      {!person.isVisible ? (
        // A word and a glyph, never a colour alone (contract §11).
        <Badge tone="warn" size="sm" icon={EyeOff} className="shrink-0">
          Not in the lists
        </Badge>
      ) : null}

      <StatusBadge status={person.status} size="sm" className="shrink-0" />

      <span className="flex shrink-0 items-center">
        {canReorder ? (
          <>
            <MoveButton
              label={`Move ${person.name} up, currently ${position}`}
              unavailable={index === 0}
              rotate
              onClick={() => onMove(index, index - 1)}
            />
            <MoveButton
              label={`Move ${person.name} down, currently ${position}`}
              unavailable={index === count - 1}
              onClick={() => onMove(index, index + 1)}
            />
          </>
        ) : null}

        <RowActions
          subject={person.name}
          actions={[
            {
              id: "edit",
              label: "Open this profile",
              icon: PencilLine,
              onSelect: onOpen
            },
            {
              id: "view",
              label: "Open on the public site",
              icon: UserRound,
              disabled: person.status !== "PUBLISHED",
              description:
                person.status === "PUBLISHED"
                  ? undefined
                  : "The profile is not on the public site yet.",
              onSelect: () => window.open(`/people/${person.slug}`, "_blank", "noopener,noreferrer")
            },
            {
              id: "archive",
              label: "Take off the public site",
              icon: EyeOff,
              show: canPublish,
              disabled: person.status !== "PUBLISHED",
              onSelect: onArchive
            },
            {
              id: "delete",
              label: "Move to recycle bin",
              icon: Trash2,
              tone: "danger",
              show: canDelete,
              onSelect: onDelete
            }
          ]}
        />
      </span>
    </li>
  );
}

/** One end-of-list-aware move button. `aria-disabled`, never `disabled` — see the board's header. */
function MoveButton({
  label,
  unavailable,
  rotate = false,
  onClick
}: {
  label: string;
  unavailable: boolean;
  rotate?: boolean;
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
        "inline-flex h-8 w-6 items-center justify-center rounded transition focus-visible:ring-2 focus-visible:ring-purple-600/30",
        unavailable
          ? "cursor-default text-ink-300 opacity-50"
          : "text-ink-500 hover:bg-surface-100 hover:text-ink-900"
      )}
    >
      <ChevronDown aria-hidden="true" className={cn("h-4 w-4", rotate && "rotate-180")} />
    </button>
  );
}
