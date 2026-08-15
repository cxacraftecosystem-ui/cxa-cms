"use client";

/**
 * Tabs — a real tablist: roving tabindex, arrow keys, and panels a keyboard reader can scroll.
 *
 * ROVING TABINDEX, NOT SIX TAB STOPS. Exactly one tab is in the page's tab order (the selected one);
 * the rest are reachable with the arrow keys. A tablist that puts every tab in the tab order makes a
 * keyboard reader press Tab five times to get past a control they were not using.
 *
 * SELECTION FOLLOWS FOCUS. Arrow keys both move and select, which is the pattern for tabs whose
 * panels are already loaded; it means one key press does one thing. If a panel ever becomes expensive
 * enough that this is wrong, the fix is manual activation (Enter/Space to select) — not a debounce.
 *
 * EVERY PANEL IS `tabIndex={0}`. A panel that scrolls but cannot be focused is a region a keyboard
 * reader can see and cannot reach the bottom of. `aria-controls` is set only on the tab whose panel
 * is actually mounted — which is the selected one, because only its panel is rendered.
 *
 * THE ACTIVE INDICATOR IS ONE ELEMENT WITH A `layoutId`, so framer slides it between tabs instead of
 * cross-fading two of them. The id is namespaced with `useId()`: two Tabs on one page sharing a
 * layoutId would animate the indicator ACROSS the page from one component to the other. Under reduced
 * motion the same element is rendered without the `layoutId`, so it simply appears where it belongs
 * (contract §1.3 — framer writes inline styles and CSS cannot reach them).
 *
 * The panel itself is not animated. The indicator is the answer to "what did my key press do"; a
 * panel fading at the same time is a second thing moving for one intention.
 */

import { useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { SPRING_LAYOUT, useReducedMotionPreference } from "@/components/motion";

export interface TabItem {
  /** Stable across renders — it keys the panel, the ids and the selection. */
  id: string;
  label: ReactNode;
  icon?: LucideIcon;
  /** A count beside the label. Rendered as text, so it is never colour-only information. */
  count?: number;
  disabled?: boolean;
  /** Omit on every item to use Tabs purely as a selector, with the panels rendered by the caller. */
  content?: ReactNode;
}

export interface TabsProps {
  items: readonly TabItem[];
  value: string;
  onChange: (id: string) => void;
  /** Names the tablist. "Publication views", not "Tabs" — a reader hears the role already. */
  label: string;
  className?: string;
  listClassName?: string;
  panelClassName?: string;
}

export function Tabs({
  items,
  value,
  onChange,
  label,
  className,
  listClassName,
  panelClassName
}: TabsProps) {
  const reduce = useReducedMotionPreference();
  const uid = useId();
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const tabId = (id: string) => `${uid}-tab-${id}`;
  const panelId = (id: string) => `${uid}-panel-${id}`;

  const active = items.find((item) => item.id === value) ?? null;

  const focusAndSelect = (id: string) => {
    onChange(id);
    tabRefs.current.get(id)?.focus();
  };

  const move = (step: number | "first" | "last") => {
    // Disabled tabs are skipped rather than landed on and refused; an arrow key that appears to do
    // nothing reads as a broken control.
    const enabled = items.filter((item) => !item.disabled);
    if (enabled.length === 0) return;

    let nextIndex: number;
    if (step === "first") {
      nextIndex = 0;
    } else if (step === "last") {
      nextIndex = enabled.length - 1;
    } else {
      const current = enabled.findIndex((item) => item.id === value);
      const base = current === -1 ? 0 : current;
      nextIndex = (base + step + enabled.length) % enabled.length;
    }

    const next = enabled[nextIndex];
    if (!next) return;
    focusAndSelect(next.id);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      case "Home":
        event.preventDefault();
        move("first");
        break;
      case "End":
        event.preventDefault();
        move("last");
        break;
      default:
        break;
    }
  };

  return (
    <div className={className}>
      <div
        role="tablist"
        aria-label={label}
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        className={cn(
          "flex items-stretch gap-1 overflow-x-auto border-b border-line-200",
          listClassName
        )}
      >
        {items.map((item) => {
          const selected = item.id === value;
          const ItemIcon = item.icon;
          return (
            <button
              key={item.id}
              ref={(node) => {
                if (node) tabRefs.current.set(item.id, node);
                else tabRefs.current.delete(item.id);
              }}
              type="button"
              role="tab"
              id={tabId(item.id)}
              aria-selected={selected}
              // Only the selected tab's panel exists, so only it may claim to control one.
              aria-controls={selected && item.content !== undefined ? panelId(item.id) : undefined}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              onClick={() => onChange(item.id)}
              className={cn(
                "relative inline-flex shrink-0 items-center gap-2 whitespace-nowrap px-3.5 py-2.5 text-sm font-medium transition",
                item.disabled
                  ? "cursor-not-allowed text-ink-300"
                  : selected
                    ? "text-purple-700"
                    : "text-ink-500 hover:text-ink-900"
              )}
            >
              {ItemIcon ? <ItemIcon aria-hidden="true" className="h-4 w-4" /> : null}
              {item.label}
              {item.count !== undefined ? (
                <span className="rounded-full bg-surface-100 px-1.5 py-0.5 text-xs font-medium text-ink-500">
                  {item.count}
                </span>
              ) : null}

              {selected ? (
                <motion.span
                  aria-hidden="true"
                  // One element, shared identity: framer moves it rather than fading two of them.
                  layoutId={reduce ? undefined : `${uid}-tab-indicator`}
                  transition={SPRING_LAYOUT}
                  className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-purple-700"
                />
              ) : null}
            </button>
          );
        })}
      </div>

      {active?.content !== undefined ? (
        <div
          role="tabpanel"
          id={panelId(active.id)}
          aria-labelledby={tabId(active.id)}
          // Focusable so the panel can be scrolled from the keyboard once the reader tabs off the tab.
          tabIndex={0}
          className={cn("pt-5 outline-none", panelClassName)}
        >
          {active.content}
        </div>
      ) : null}
    </div>
  );
}
