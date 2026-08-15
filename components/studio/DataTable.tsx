"use client";

/**
 * DataTable — every list in the studio, generic over the row type.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * 1. `rows === null` AND `rows === []` ARE DIFFERENT SCREENS, and this is the rule the whole
 *    component is built around (contract §9).
 *
 *    `null` renders the table with SKELETON ROWS — header, column widths and all — so the layout does
 *    not jump when the data lands. `[]` renders the `empty` node INSTEAD of the table: a lone empty
 *    cell under six column headings reads as a broken table, and an editor's actual question ("is
 *    there nothing here, or has it not loaded?") is answered by which of the two they see. Rendering
 *    "No publications" during a fetch tells a researcher their work has vanished.
 *
 * 2. THE WHOLE ROW IS NOT A LINK. One cell carries it — style that link with
 *    `DATA_TABLE_PRIMARY_LINK_CLASS` — and the row gets a hover fill so it still reads as one target.
 *
 *    A row wrapped in an `<a>` fights every per-cell control inside it: a checkbox click navigates, a
 *    dropdown cannot open, a nested button is invalid HTML, and the row's accessible name becomes all
 *    six cells read as one sentence. A row-level `onClick` is worse — it cannot be middle-clicked,
 *    opened in a new tab, copied as a link, or reached by a keyboard at all.
 *
 * 3. "SELECT ALL" MEANS THIS PAGE, AND IT SAYS SO. The checkbox is named "Select all 20 on this page"
 *    and the bulk bar repeats the fact in words. This component only ever holds the rows it was given;
 *    a "Select all" that looked like it covered 137 records and silently covered 20 would eventually
 *    delete the wrong twenty, and nothing on screen would have said which twenty (contract §1.6).
 *
 * 4. SORTING WRITES TO THE URL, so a sorted view is a link somebody can send. `router.replace` and not
 *    `push`: sorting is not a place in history a reader wants Back to walk through. `scroll: false`,
 *    because re-sorting must not throw them to the top of the page. And `page` is dropped, because
 *    page 4 of one order is not page 4 of another and landing on an empty page 4 looks exactly like a
 *    list with no records.
 *
 *    There is NO "unsorted" third state. A table with no order is a table whose order the server chose
 *    and the reader cannot see; clicking a header cycles ascending → descending and stops there.
 *
 * 5. THE HEADER IS `sticky top-0 z-10` — rung 10 of the ladder, "sticky in-page chrome" (contract §6).
 *    ⚠ AND IT ONLY ACTUALLY STICKS WHEN `maxHeight` IS SET. The horizontal scroller this table lives in
 *    is `overflow-x-auto`, and CSS computes `overflow-y: visible` to `auto` alongside it — so the
 *    wrapper IS the scroll container in both axes and the header sticks to IT, not to the viewport.
 *    Without a height the wrapper never scrolls vertically and the sticky offset has nothing to do.
 *    Pass `maxHeight` for a long list and the header behaves as intended. There is no way to have both
 *    a horizontal scroller and a viewport-sticky header, and pretending otherwise would leave a header
 *    that inexplicably works on some screens and not others.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * COLUMNS ARE RESIZABLE, AND THE FIRST DRAG FREEZES THE LAYOUT. Until somebody resizes something the
 * table is `table-auto`, so it sizes itself to its content — which is what you want for a list of
 * titles of wildly different lengths. The moment a handle is grabbed, every column's current width is
 * measured and the table switches to `table-fixed`, so from then on dragging one column moves one edge
 * instead of redistributing all of them. Widths are per-visit and not persisted: keeping them would
 * mean a per-user store, and the cost of re-dragging is a second.
 *
 * MOTION IS ONE THING: the bulk bar appearing, which is a state change carrying meaning. The row flash
 * after a save is the `.flash-row` recipe from globals.css, whose static outline is the half that
 * survives reduced motion (contract §1.4). No entrance animation on the rows — an administrator who
 * hit a row wants to land on it, not watch it arrive.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, ArrowUp, ChevronsUpDown, Info, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { DURATION, EASE_OUT, useReducedMotionPreference } from "@/components/motion";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";

export type SortDirection = "asc" | "desc";
export type ColumnAlign = "start" | "center" | "end";

/** Nothing narrower is readable, and nothing narrower can be grabbed again to widen it. */
const MIN_COLUMN_WIDTH = 72;
/** One keyboard press of the resize handle. Coarse on purpose — a pixel at a time is not a gesture. */
const RESIZE_STEP = 16;
const SELECT_COLUMN_WIDTH = 44;
const ACTIONS_COLUMN_WIDTH = 56;
const DEFAULT_SKELETON_ROWS = 6;
/**
 * Dropped when the sort changes. Page 4 of one order is not page 4 of another, and landing on an empty
 * page 4 looks exactly like a list with no records.
 */
const DEFAULT_SORT_RESET_PARAMS: readonly string[] = ["page"];

/** Complete literal class strings — a name assembled by concatenation is purged (contract §5). */
const ALIGN_CLASS: Record<ColumnAlign, string> = {
  start: "text-left",
  center: "text-center",
  end: "text-right"
};

const HIDE_BELOW_CLASS = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell"
} as const;

/** Ragged widths, so a stack of placeholder bars reads as text rather than as a filled grid. */
const SKELETON_WIDTHS = ["w-3/4", "w-1/2", "w-2/3", "w-5/6", "w-2/5"] as const;

/**
 * The class for the ONE link in a row — see rule 2.
 *
 * `group-hover:` is why the row carries `group`: the title picks up the brand colour when the pointer
 * is anywhere on the row, so the row reads as a target without being one.
 */
export const DATA_TABLE_PRIMARY_LINK_CLASS =
  "rounded font-medium text-ink-900 underline-offset-4 transition-colors hover:text-purple-700 hover:underline group-hover:text-purple-700";

export interface DataTableColumn<Row> {
  /** Stable and unique. Used as the React key, the resize bookkeeping key and the default sort value. */
  key: string;
  /** The visible heading. Sentence case, no full stop. */
  header: ReactNode;
  /** Needed when `header` is a glyph or empty — a column with no name cannot be sorted or resized aloud. */
  headerLabel?: string;
  /**
   * Starting width in PIXELS. Not a CSS length: a drag has to add pixels to a number, and measuring a
   * `rem` back out of the DOM to do that is a round trip that can disagree with itself. Leave it out
   * for a column that should size to its content.
   */
  width?: number;
  align?: ColumnAlign;
  render: (row: Row, index: number) => ReactNode;
  /** Turns the heading into a sort button. */
  sortable?: boolean;
  /** The value written to the URL. Defaults to `key`. Use it when the column and the column in the
   *  database are not called the same thing. */
  sortKey?: string;
  /** Which way the first click sorts. Default ascending; pass "desc" for a date column. */
  defaultDirection?: SortDirection;
  /** Default true. Off for a column whose width is the point (a status chip, a thumbnail). */
  resizable?: boolean;
  /**
   * Drops the column below a breakpoint. A dense table on a phone must LOSE columns, not shrink them
   * to four characters each.
   */
  hideBelow?: keyof typeof HIDE_BELOW_CLASS;
}

export interface DataTableBulkAction<Row> {
  id: string;
  /** Name the action and let the bar carry the count: "Move to recycle bin". */
  label: string;
  icon?: LucideIcon;
  tone?: "default" | "danger";
  /**
   * Runs against the selected rows. The selection is cleared once this resolves — by then the rows it
   * acted on are stale. Throwing keeps the selection so the reader can try again, and reporting the
   * failure is the caller's job (it has the toast and it knows what was attempted).
   */
  onRun: (rows: Row[]) => void | Promise<void>;
}

export interface DataTableSortConfig {
  /** Default "sort". */
  sortParam?: string;
  /** Default "dir". */
  dirParam?: string;
  /** The order the server applies when the URL says nothing. Shown in the header as the active sort. */
  defaultKey?: string;
  defaultDirection?: SortDirection;
  /** Parameters dropped when the sort changes. Default `["page"]`. */
  resetParams?: readonly string[];
}

export interface TableSort {
  key: string;
  direction: SortDirection;
}

/**
 * Read the sort out of a query string, using the same convention `DataTable` writes.
 *
 * Exported so a Server Component page — which is where the database query lives — orders its rows from
 * the same two parameters the table renders its arrows from, with no second copy of the convention.
 * Accepts anything with a `get`, so both `URLSearchParams` and Next's `ReadonlyURLSearchParams` fit.
 */
export function readTableSort(
  params: { get: (name: string) => string | null },
  options: Pick<DataTableSortConfig, "sortParam" | "dirParam" | "defaultKey" | "defaultDirection"> = {}
): TableSort | null {
  const key = params.get(options.sortParam ?? "sort") ?? options.defaultKey ?? null;
  if (key === null || key.length === 0) return null;
  const raw = params.get(options.dirParam ?? "dir");
  const direction: SortDirection =
    raw === "asc" || raw === "desc" ? raw : (options.defaultDirection ?? "asc");
  return { key, direction };
}

export interface DataTableProps<Row> {
  /** `null` while loading, `[]` when there is nothing. See rule 1 — they are not the same. */
  rows: readonly Row[] | null;
  columns: readonly DataTableColumn<Row>[];
  /** Must be stable for a row across renders — the database id, not the array index. */
  getRowId: (row: Row) => string;
  /**
   * What `[]` renders. An `<EmptyState>`, and remember it renders its OWN heading: pass
   * `headingLevel={3}` inside a section that already owns an `<h2>` (contract §14). Say WHY it is
   * empty — "nothing matches these filters" and "nothing has been added yet" have different remedies.
   */
  empty: ReactNode;
  /** The table's accessible name: "Publications". Not "Table". */
  label: string;
  selectable?: boolean;
  /** Names a row for its checkbox: "Bagru dyeing". Twenty checkboxes called "Select row" are twenty
   *  identical controls. Falls back to the row's position, which is better than nothing and worse than
   *  a name. */
  getRowLabel?: (row: Row) => string;
  /** A row this reader may not act on is not selectable — a bulk delete must not include it. */
  canSelectRow?: (row: Row) => boolean;
  bulkActions?: readonly DataTableBulkAction<Row>[];
  /** How many rows there are altogether, so the bulk bar can be honest about what is NOT selected. */
  totalItems?: number;
  /** The trailing, unlabelled cell. Put `RowActions` here. */
  rowActions?: (row: Row) => ReactNode;
  /**
   * Flashes one row — "this is the one you just saved". Clear it after about a second: the `.flash-row`
   * outline is the static half of the signal and persists for as long as this is set, and a permanent
   * outline on one row stops meaning anything.
   */
  flashRowId?: string | null;
  sort?: DataTableSortConfig;
  /** Gives the table its own vertical scroll — and is what makes the sticky header work. See rule 5. */
  maxHeight?: number | string;
  /**
   * Say it here when the list is capped or truncated: "Only the first 500 rows are shown." A list that
   * quietly stops is indistinguishable from a place with no records (contract §1.6).
   */
  capNote?: ReactNode;
  /** How many placeholder rows while loading. Default 6. */
  skeletonRows?: number;
  className?: string;
}

export function DataTable<Row>({
  rows,
  columns,
  getRowId,
  empty,
  label,
  selectable = false,
  getRowLabel,
  canSelectRow,
  bulkActions,
  totalItems,
  rowActions,
  flashRowId,
  sort,
  maxHeight,
  capNote,
  skeletonRows = DEFAULT_SKELETON_ROWS,
  className
}: DataTableProps<Row>) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const reduce = useReducedMotionPreference();
  const uid = useId();

  const theadRef = useRef<HTMLTableSectionElement | null>(null);

  const [widths, setWidths] = useState<Record<string, number>>({});
  /** True once anything has been dragged — see the note about `table-fixed` in the header. */
  const [frozen, setFrozen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ key: string; startX: number; startWidth: number } | null>(null);

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [running, setRunning] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ── Sorting ────────────────────────────────────────────────────────────────────────────────────

  const sortParam = sort?.sortParam ?? "sort";
  const dirParam = sort?.dirParam ?? "dir";
  // Memoised so `applySort` keeps one identity: an inline `?? ["page"]` is a new array every render,
  // which would change the callback's identity on every render and defeat any memoised child.
  const sortResetParams = useMemo(
    () => sort?.resetParams ?? DEFAULT_SORT_RESET_PARAMS,
    [sort?.resetParams]
  );
  const activeSort = readTableSort(params, {
    sortParam,
    dirParam,
    defaultKey: sort?.defaultKey,
    defaultDirection: sort?.defaultDirection
  });

  const applySort = useCallback(
    (key: string, firstDirection: SortDirection) => {
      const next: SortDirection =
        // `activeSort !== null &&` rather than `activeSort?.key ===`: optional chaining does not narrow
        // `activeSort` for the branch, so reading `.direction` there would not compile.
        activeSort !== null && activeSort.key === key
          ? activeSort.direction === "asc"
            ? "desc"
            : "asc"
          : firstDirection;

      // Built from the CURRENT query so filters, and anything else the screen owns, survive a sort.
      const search = new URLSearchParams(params.toString());
      search.set(sortParam, key);
      search.set(dirParam, next);
      for (const param of sortResetParams) search.delete(param);

      const query = search.toString();
      router.replace(query.length > 0 ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [activeSort, dirParam, params, pathname, router, sortParam, sortResetParams]
  );

  // ── Resizing ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Measure every column once, then switch to `table-fixed`. Until this happens the browser is sizing
   * the table to its content and a drag would move all the other edges too.
   */
  const freezeLayout = useCallback(() => {
    if (frozen) return;
    const head = theadRef.current;
    if (!head) return;

    const measured: Record<string, number> = {};
    head.querySelectorAll<HTMLElement>("th[data-column-key]").forEach((cell) => {
      const key = cell.dataset.columnKey;
      if (!key) return;
      measured[key] = Math.max(MIN_COLUMN_WIDTH, Math.round(cell.getBoundingClientRect().width));
    });

    // Anything already set by a declared `width` or an earlier drag wins over the measurement.
    setWidths((current) => ({ ...measured, ...current }));
    setFrozen(true);
  }, [frozen]);

  const widthOf = useCallback(
    (column: DataTableColumn<Row>): number | undefined => widths[column.key] ?? column.width,
    [widths]
  );

  const setWidth = useCallback((key: string, next: number) => {
    setWidths((current) => ({ ...current, [key]: Math.max(MIN_COLUMN_WIDTH, Math.round(next)) }));
  }, []);

  const onResizeStart = (column: DataTableColumn<Row>) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    // The handle sits inside the heading, which may itself be a sort button. Without both of these the
    // drag also sorts the column.
    event.preventDefault();
    event.stopPropagation();

    freezeLayout();

    const cell = event.currentTarget.closest("th");
    const startWidth =
      widths[column.key] ??
      column.width ??
      (cell instanceof HTMLElement ? Math.round(cell.getBoundingClientRect().width) : MIN_COLUMN_WIDTH);

    dragRef.current = { key: column.key, startX: event.clientX, startWidth };
    setDragging(true);
    // Capture, so a drag that leaves the header — which is most of them — keeps sending us moves.
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onResizeMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setWidth(drag.key, drag.startWidth + (event.clientX - drag.startX));
  };

  const endResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onResizeKeyDown = (column: DataTableColumn<Row>) => (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    freezeLayout();

    const cell = event.currentTarget.closest("th");
    const current =
      widths[column.key] ??
      column.width ??
      (cell instanceof HTMLElement ? Math.round(cell.getBoundingClientRect().width) : MIN_COLUMN_WIDTH);

    setWidth(column.key, current + (event.key === "ArrowRight" ? RESIZE_STEP : -RESIZE_STEP));
  };

  // ── Selection ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Memoised so that the loading case (`rows === null`) does not hand a fresh `[]` to three memos on
   * every render. When `rows` is an array this is the same reference the caller gave us.
   */
  const visibleRows = useMemo(() => rows ?? [], [rows]);
  const rowIds = useMemo(() => visibleRows.map((row) => getRowId(row)), [visibleRows, getRowId]);
  /**
   * One string standing for "the rows on screen changed", so an effect can depend on it. An array
   * cannot: `rowIds` is a fresh array on every render, so listing it would run the prune effect on
   * every render rather than when the rows change. A newline separates them because a cuid cannot
   * contain one, so two different row sets can never collapse to the same key.
   */
  const rowIdsKey = rowIds.join("\n");

  const selectableIds = useMemo(
    () =>
      visibleRows
        .filter((row) => canSelectRow?.(row) !== false)
        .map((row) => getRowId(row)),
    [visibleRows, canSelectRow, getRowId]
  );

  const selectedRows = useMemo(
    () =>
      visibleRows.filter(
        (row) => canSelectRow?.(row) !== false && selected.has(getRowId(row))
      ),
    [visibleRows, canSelectRow, getRowId, selected]
  );

  /**
   * Drop ids that are no longer on screen.
   *
   * The derived `selectedRows` above already ignores them, so this is not about correctness of the
   * count — it is about the set not growing without bound as a reader pages through a list, and about
   * a stale id not being silently re-selected if a row comes back on a later page.
   */
  useEffect(() => {
    setSelected((current) => {
      if (current.size === 0) return current;
      const allowed = new Set(rowIds);
      const next = new Set<string>();
      current.forEach((id) => {
        if (allowed.has(id)) next.add(id);
      });
      return next.size === current.size ? current : next;
    });
    // Keyed on the joined ids: `rowIds` is a fresh array every render, and listing it would run this
    // on every render instead of when the rows actually change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowIdsKey]);

  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const someSelected = selectedRows.length > 0 && !allSelected;

  const toggleRow = (id: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set<string>() : new Set(selectableIds));
  };

  const runBulkAction = useCallback(
    async (action: DataTableBulkAction<Row>) => {
      const targets = selectedRows;
      if (targets.length === 0) return;

      setRunning(action.id);
      try {
        await action.onRun(targets);
        if (mountedRef.current) setSelected(new Set<string>());
      } catch (thrown) {
        // Reporting belongs to the caller, which knows what it attempted and has the toast. Logged so
        // an operator reading the console is not left with a selection that mysteriously stayed put.
        console.error(`[DataTable] the bulk action "${action.id}" failed`, thrown);
      } finally {
        if (mountedRef.current) setRunning(null);
      }
    },
    [selectedRows]
  );

  // ── Render ─────────────────────────────────────────────────────────────────────────────────────

  const loading = rows === null;
  const skeletonCount = Math.max(1, Math.floor(skeletonRows));

  const scrollStyle = maxHeight === undefined ? undefined : { maxHeight, overflowY: "auto" as const };

  const selectAllLabel = `Select all ${selectableIds.length} on this page`;

  const headingClass =
    "sticky top-0 z-10 border-b border-line-200 bg-surface-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-500";

  // `[]` is answered by the empty state instead of the table — see rule 1. After every hook, so the
  // hook order never changes between renders.
  if (rows !== null && rows.length === 0) {
    return <div className={cn("min-w-0", className)}>{empty}</div>;
  }

  return (
    <div className={cn("min-w-0", className)}>
      {/*
        Mounted from the first render so the region is registered before its content ever changes — a
        live region inserted at the same instant as its text is announced inconsistently. One sentence
        for the whole table, rather than one per skeleton bar.
      */}
      <span role="status" className="sr-only">
        {loading ? `Loading ${label}…` : ""}
      </span>

      {selectable && bulkActions && bulkActions.length > 0 ? (
        <AnimatePresence initial={false}>
          {selectedRows.length > 0 ? (
            <motion.div
              // A state change carrying meaning, so it is allowed to move — 4px and 180ms, no more.
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
              transition={{ duration: reduce ? 0 : DURATION.scrim, ease: EASE_OUT }}
              className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-purple-200 bg-purple-50 px-3 py-2"
            >
              {/*
                NOT a live region. The count changes on every tick of a checkbox, and the browser
                already announces the checkbox's own state change — a polite region here would say the
                same thing again, half a second later, every time.
              */}
              <p className="min-w-0 text-xs text-purple-700">
                <span className="font-semibold">
                  {selectedRows.length === 1 ? "1 row selected" : `${selectedRows.length} rows selected`}
                </span>
                {/* Rule 3, in words: what is NOT selected, said out loud. */}
                {typeof totalItems === "number" && totalItems > rowIds.length ? (
                  <>
                    {" "}
                    — everything selected is on this page. There are {totalItems} altogether, and rows on
                    other pages are not included.
                  </>
                ) : (
                  <> of {rowIds.length} on this page</>
                )}
              </p>

              <div className="flex flex-wrap items-center gap-2">
                {bulkActions.map((action) => (
                  <Button
                    key={action.id}
                    size="sm"
                    variant={action.tone === "danger" ? "danger" : "secondary"}
                    icon={action.icon}
                    isLoading={running === action.id}
                    loadingLabel="working"
                    disabled={running !== null && running !== action.id}
                    onClick={() => void runBulkAction(action)}
                  >
                    {action.label}
                  </Button>
                ))}

                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set<string>())}>
                  Clear selection
                </Button>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      ) : null}

      <div
        className="overflow-x-auto rounded-md border border-line-200 bg-card"
        style={scrollStyle}
      >
        <table
          aria-label={label}
          className={cn(
            "w-full border-collapse text-sm",
            frozen ? "table-fixed" : "table-auto",
            // Stops the drag selecting the header text it is dragging across.
            dragging && "select-none"
          )}
        >
          {/*
            Widths live on `<col>` rather than on each `<th>`: one declaration per column, applied to
            every cell in it, and nothing for the body rows to disagree with.
          */}
          <colgroup>
            {selectable ? <col style={{ width: SELECT_COLUMN_WIDTH }} /> : null}
            {columns.map((column) => (
              <col key={column.key} style={{ width: widthOf(column) }} />
            ))}
            {rowActions ? <col style={{ width: ACTIONS_COLUMN_WIDTH }} /> : null}
          </colgroup>

          <thead ref={theadRef}>
            <tr>
              {selectable ? (
                <th scope="col" className={cn(headingClass, "px-2")}>
                  <Checkbox
                    checked={allSelected}
                    indeterminate={someSelected}
                    onCheckedChange={toggleAll}
                    disabled={selectableIds.length === 0}
                    title={selectAllLabel}
                    // Rule 3: the name states the scope. It is visually hidden because a heading cell
                    // has no room for it, and the bulk bar repeats the fact where there is room.
                    label={<span className="sr-only">{selectAllLabel}</span>}
                    // `!` on both: `cn()` is a plain join and later classes do NOT win (contract §5),
                    // so the recipe's own `min-h-11`/`py-1.5` would otherwise make every row 44px
                    // taller than the rest of the table.
                    className="!min-h-0 !py-0 justify-center"
                  />
                </th>
              ) : null}

              {columns.map((column) => {
                const sortKey = column.sortKey ?? column.key;
                // The DIRECTION or null, rather than a boolean: `isSorted === true` does not narrow
                // `activeSort` away from null for TypeScript, and every use below needs the direction.
                const sortedDirection: SortDirection | null =
                  activeSort !== null && activeSort.key === sortKey ? activeSort.direction : null;
                const resizable = column.resizable !== false;
                const name = column.headerLabel ?? (typeof column.header === "string" ? column.header : column.key);
                const SortIcon =
                  sortedDirection === null
                    ? ChevronsUpDown
                    : sortedDirection === "asc"
                      ? ArrowUp
                      : ArrowDown;

                return (
                  <th
                    key={column.key}
                    scope="col"
                    data-column-key={column.key}
                    // `aria-sort` is how a screen reader is told the order, and it belongs on the
                    // heading cell rather than on the button inside it.
                    aria-sort={
                      sortedDirection === null
                        ? undefined
                        : sortedDirection === "asc"
                          ? "ascending"
                          : "descending"
                    }
                    className={cn(
                      headingClass,
                      "relative",
                      ALIGN_CLASS[column.align ?? "start"],
                      column.hideBelow ? HIDE_BELOW_CLASS[column.hideBelow] : undefined
                    )}
                  >
                    {column.sortable ? (
                      <button
                        type="button"
                        onClick={() => applySort(sortKey, column.defaultDirection ?? "asc")}
                        className="inline-flex max-w-full items-center gap-1.5 rounded text-xs font-semibold uppercase tracking-wide text-ink-500 transition-colors hover:text-purple-700"
                      >
                        <span className="truncate">{column.header}</span>
                        <SortIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                        {/* The heading's `aria-sort` says which way it IS sorted; this says what the
                            button will DO, which is a different fact and the one a reader needs before
                            pressing it. */}
                        <span className="sr-only">
                          {sortedDirection === "asc"
                            ? " — sorted A to Z, press to reverse"
                            : sortedDirection === "desc"
                              ? " — sorted Z to A, press to reverse"
                              : " — press to sort by this column"}
                        </span>
                      </button>
                    ) : (
                      <span className="block truncate">
                        {column.header}
                        {column.headerLabel && typeof column.header !== "string" ? (
                          <span className="sr-only">{column.headerLabel}</span>
                        ) : null}
                      </span>
                    )}

                    {resizable ? (
                      // A real `<button>` (contract §11), not a `<div>` with a cursor. Arrow keys move
                      // it, which is the only way a keyboard reader can widen a truncated column.
                      <button
                        type="button"
                        aria-label={`Resize the ${name} column`}
                        title={`Drag to resize the ${name} column, or use the left and right arrow keys`}
                        onPointerDown={onResizeStart(column)}
                        onPointerMove={onResizeMove}
                        onPointerUp={endResize}
                        onLostPointerCapture={endResize}
                        onKeyDown={onResizeKeyDown(column)}
                        className="absolute right-0 top-0 h-full w-2 cursor-col-resize touch-none rounded-none text-transparent transition-colors hover:bg-purple-300 focus-visible:bg-purple-600"
                      />
                    ) : null}
                  </th>
                );
              })}

              {rowActions ? (
                <th scope="col" className={cn(headingClass, "px-2")}>
                  {/* Named for a screen reader, blank for eyes: a column of "…" buttons needs a name
                      and does not need a heading taking up width. */}
                  <span className="sr-only">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>

          {loading ? (
            // `aria-hidden`, with the one announcement above. Left visible to the accessibility tree
            // this would be thirty meaningless blocks; announced per block it would say "Loading"
            // thirty times (Skeleton.tsx). The bars use the `.skeleton` recipe directly for that
            // reason — the component insists on its own announcement, and here we want exactly one.
            <tbody aria-hidden="true">
              {Array.from({ length: skeletonCount }, (_unused, rowIndex) => (
                // The index is the right key: identical, ordered placeholders with no identity and
                // nothing to reorder.
                <tr key={rowIndex} className="border-b border-line-200 last:border-b-0">
                  {selectable ? (
                    <td className="px-3 py-3">
                      <div className="skeleton h-4 w-4" />
                    </td>
                  ) : null}
                  {columns.map((column, columnIndex) => (
                    <td
                      key={column.key}
                      className={cn(
                        "px-3 py-3",
                        column.hideBelow ? HIDE_BELOW_CLASS[column.hideBelow] : undefined
                      )}
                    >
                      <div
                        className={cn(
                          "skeleton h-4",
                          SKELETON_WIDTHS[(rowIndex + columnIndex) % SKELETON_WIDTHS.length] ?? "w-2/3"
                        )}
                      />
                    </td>
                  ))}
                  {rowActions ? (
                    <td className="px-3 py-3">
                      <div className="skeleton h-4 w-4" />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          ) : (
            <tbody>
              {visibleRows.map((row, index) => {
                const id = getRowId(row);
                const isSelected = selected.has(id);
                const rowLabel = getRowLabel?.(row) ?? `row ${index + 1}`;
                const selectableRow = canSelectRow?.(row) !== false;

                return (
                  <tr
                    key={id}
                    // `group` is what `DATA_TABLE_PRIMARY_LINK_CLASS` hangs its hover on; `flash-row`
                    // is the recipe from globals.css, whose static outline survives reduced motion.
                    className={cn(
                      "group flash-row border-b border-line-200 transition-colors last:border-b-0 hover:bg-surface-50",
                      isSelected && "bg-purple-50"
                    )}
                    data-flash={flashRowId === id ? "true" : undefined}
                  >
                    {selectable ? (
                      <td className="px-2 py-2.5 align-middle">
                        {selectableRow ? (
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={(checked) => toggleRow(id, checked)}
                            label={<span className="sr-only">Select {rowLabel}</span>}
                            // `!` on both: `cn()` is a plain join and later classes do NOT win (contract §5),
                    // so the recipe's own `min-h-11`/`py-1.5` would otherwise make every row 44px
                    // taller than the rest of the table.
                    className="!min-h-0 !py-0 justify-center"
                          />
                        ) : null}
                      </td>
                    ) : null}

                    {columns.map((column) => (
                      <td
                        key={column.key}
                        className={cn(
                          "px-3 py-2.5 align-middle text-ink-700",
                          ALIGN_CLASS[column.align ?? "start"],
                          column.hideBelow ? HIDE_BELOW_CLASS[column.hideBelow] : undefined,
                          // `min-w-0` on the cell plus the caller's own truncation is what keeps a long
                          // title from forcing the table wider than its column.
                          "min-w-0"
                        )}
                      >
                        {column.render(row, index)}
                      </td>
                    ))}

                    {rowActions ? (
                      <td className="px-2 py-2.5 text-right align-middle">{rowActions(row)}</td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          )}
        </table>
      </div>

      {capNote ? (
        // Rule: a cap is stated on screen, in the same place the reader is looking (contract §1.6).
        <p
          id={`${uid}cap`}
          className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-ink-500"
        >
          <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{capNote}</span>
        </p>
      ) : null}
    </div>
  );
}
