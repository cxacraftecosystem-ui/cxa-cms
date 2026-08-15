"use client";

/**
 * DropdownMenu — the studio's row actions, as a real menu rather than a styled list of buttons.
 *
 * "Real menu" means the whole keyboard contract, because a menu is one of the few widgets a reader is
 * entitled to assume behaves the same everywhere: `role="menu"` and `role="menuitem"`, arrow keys,
 * Home and End, typeahead, and Escape returning focus to the trigger.
 *
 * FOCUS IS ROVING AND PROGRAMMATIC. Every item is `tabIndex={-1}`; the menu moves focus itself. Tab
 * therefore has to be closed by hand, HERE, from any item and not just the ends: the browser's own
 * sequential walk skips `tabindex="-1"` elements, and the panel is portalled to the end of `<body>`,
 * so an unhandled Tab from the middle of the menu walks past everything and out of the document while
 * the panel stays open behind it. So Tab closes the menu, hands focus back to the trigger and does
 * NOT call `preventDefault()` — the browser then continues from the trigger, which is where the
 * reader's place in the page really is. A menu is a detour, not a place to live.
 *
 * TYPEAHEAD SKIPS THE SPACE BAR UNTIL A SEARCH IS ALREADY RUNNING. Space activates the focused item,
 * and a menu where Space silently started a search instead of pressing the thing under focus would be
 * a menu that ignores the reader.
 *
 * SELECTING RETURNS FOCUS TO THE TRIGGER *BEFORE* RUNNING THE ACTION. Most of these actions open a
 * dialog, and the dialog records where focus was in order to give it back when it closes. Running the
 * action first would have the dialog memorise a menu item that is about to be unmounted, and closing
 * it would drop focus to `<body>`.
 *
 * Placement, portalling, Escape, outside-press and the scroll/resize rules all come from Popover —
 * the two must not grow separate opinions about where a floating panel goes.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";
import { MoreHorizontal, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Popover, type PopoverAlign, type PopoverSide } from "@/components/ui/Popover";

export interface DropdownMenuItem {
  id: string;
  /** Plain text: it is the accessible name AND what typeahead matches against. */
  label: string;
  icon?: LucideIcon;
  /** One short line under the label, for an action whose consequence is not obvious. */
  description?: string;
  tone?: "default" | "danger";
  /**
   * "Not available right now" — a restore on a row that is not deleted. NOT a permission check: a
   * gated action renders nothing at all (contract §1.8), so leave it out of the array instead.
   */
  disabled?: boolean;
  onSelect: () => void;
}

export interface DropdownMenuSeparator {
  id: string;
  separator: true;
}

export type DropdownMenuEntry = DropdownMenuItem | DropdownMenuSeparator;

export interface DropdownMenuProps {
  items: readonly DropdownMenuEntry[];
  /** The trigger's accessible name. Name the SUBJECT: "Actions for Bagru dyeing", not "Actions". */
  label: string;
  /** Visible trigger content. Defaults to the horizontal ellipsis. */
  trigger?: ReactNode;
  align?: PopoverAlign;
  side?: PopoverSide;
  disabled?: boolean;
  /** Applied to the trigger button. */
  className?: string;
  menuClassName?: string;
}

/** Milliseconds of quiet before the typeahead buffer is considered a new search. */
const TYPEAHEAD_RESET_MS = 500;

function isMenuItem(entry: DropdownMenuEntry): entry is DropdownMenuItem {
  return !("separator" in entry);
}

export function DropdownMenu({
  items,
  label,
  trigger,
  align = "end",
  side = "bottom",
  disabled = false,
  className,
  menuClassName
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const typeahead = useRef({ buffer: "", at: 0 });
  // Which end the menu should open onto: ArrowUp on the trigger means "the last item".
  const openAt = useRef<"first" | "last">("first");

  const triggerId = useId();
  const menuId = useId();

  const navigable = items.filter(isMenuItem).filter((item) => !item.disabled);

  const focusItem = (item: DropdownMenuItem | undefined, preventScroll = false) => {
    if (!item) return;
    itemRefs.current.get(item.id)?.focus({ preventScroll });
  };

  const currentIndex = () =>
    navigable.findIndex((item) => itemRefs.current.get(item.id) === document.activeElement);

  const close = useCallback(() => {
    // Focus only goes back to the trigger if it was inside the menu. After a click somewhere else on
    // the page, yanking it back would move the reader away from what they just chose.
    const panel = panelRef.current;
    const active = document.activeElement;
    const inside = panel !== null && active instanceof Node && panel.contains(active);
    setOpen(false);
    if (inside) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const select = (item: DropdownMenuItem) => {
    if (item.disabled) return;
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
    item.onSelect();
  };

  // Placed on the next frame rather than in this effect: on the very first open the Popover needs one
  // extra commit to resolve its portal target, and by the following frame the panel is mounted AND
  // positioned. `preventScroll`, because a scroll raised by focusing would look like a user scroll to
  // the popover and close the menu it just opened.
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const target = openAt.current === "last" ? navigable[navigable.length - 1] : navigable[0];
      focusItem(target, true);
      openAt.current = "first";
    });
    return () => window.cancelAnimationFrame(frame);
    // Intentionally keyed on `open` alone: this runs once per opening, not whenever the items change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    openAt.current = event.key === "ArrowUp" ? "last" : "first";
    setOpen(true);
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Before the "is there anything to move to" guard: an empty menu must let go of Tab too, and
    // `close()` puts focus on the trigger synchronously, so the browser's default walk resumes from a
    // real element instead of from an item that is about to unmount. Deliberately not prevented and
    // deliberately not left to Popover, whose end-of-panel detection cannot see that every item in
    // between is unreachable by Tab.
    if (event.key === "Tab") {
      close();
      return;
    }

    if (navigable.length === 0) return;
    const index = currentIndex();

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusItem(navigable[(index + 1 + navigable.length) % navigable.length]);
        return;
      case "ArrowUp":
        event.preventDefault();
        focusItem(navigable[(index - 1 + navigable.length) % navigable.length]);
        return;
      case "Home":
        event.preventDefault();
        focusItem(navigable[0]);
        return;
      case "End":
        event.preventDefault();
        focusItem(navigable[navigable.length - 1]);
        return;
      default:
        break;
    }

    // Typeahead. Modified keys are shortcuts belonging to the browser, not letters.
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === " " && typeahead.current.buffer === "") return;

    event.preventDefault();
    const now = Date.now();
    if (now - typeahead.current.at > TYPEAHEAD_RESET_MS) typeahead.current.buffer = "";
    typeahead.current.at = now;
    typeahead.current.buffer += event.key.toLowerCase();

    const query = typeahead.current.buffer;
    const match = navigable.find((item) => item.label.toLowerCase().startsWith(query));
    focusItem(match);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={triggerId}
        aria-haspopup="menu"
        aria-expanded={open}
        // Only while the menu is in the document; an id that is not there is worse than none (§11).
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          "inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-500 transition hover:bg-surface-100 hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-60",
          className
        )}
      >
        {trigger ?? <MoreHorizontal aria-hidden="true" className="h-4 w-4" />}
      </button>

      <Popover
        open={open}
        onClose={close}
        anchorRef={triggerRef}
        panelRef={panelRef}
        onKeyDown={onMenuKeyDown}
        side={side}
        align={align}
        role="menu"
        // The id goes on the PANEL, so `aria-controls` above points at the element that actually
        // carries `role="menu"` — and nothing sits between the menu and its items.
        id={menuId}
        labelledBy={triggerId}
        className={cn("min-w-[12rem] max-w-[20rem]", menuClassName)}
      >
        {items.map((entry) =>
          isMenuItem(entry) ? (
            <button
              key={entry.id}
              ref={(node) => {
                if (node) itemRefs.current.set(entry.id, node);
                else itemRefs.current.delete(entry.id);
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={entry.disabled}
              onClick={() => select(entry)}
              className={cn(
                "flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition",
                entry.disabled
                  ? "cursor-not-allowed text-ink-300"
                  : entry.tone === "danger"
                    ? "text-error-600 hover:bg-error-100"
                    : "text-ink-700 hover:bg-surface-100 hover:text-ink-900"
              )}
            >
              {entry.icon ? <entry.icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" /> : null}
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{entry.label}</span>
                {entry.description ? (
                  <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">
                    {entry.description}
                  </span>
                ) : null}
              </span>
            </button>
          ) : (
            // `role="separator"` rather than a bare styled div: a screen reader announces the break
            // and the two groups stop reading as one long list.
            <div key={entry.id} role="separator" className="my-1 h-px bg-line-200" />
          )
        )}

        {navigable.length === 0 ? (
          // Never an empty panel. A menu that opens onto nothing looks like a failure; saying so is
          // the difference between "broken" and "nothing you can do here yet".
          <p className="px-2.5 py-2 text-sm text-ink-500">No actions are available for this row.</p>
        ) : null}
      </Popover>
    </>
  );
}
