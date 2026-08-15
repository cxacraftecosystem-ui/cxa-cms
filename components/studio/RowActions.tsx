"use client";

/**
 * RowActions — the "…" menu at the end of a table row.
 *
 * A thin, opinionated wrapper over `DropdownMenu`, which already owns the whole keyboard contract
 * (arrows, Home/End, typeahead, Escape returning focus to the trigger) and the placement rules. What
 * this adds is the two policies a row menu must never get wrong:
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * 1. IT NEVER RENDERS AN ACTION THE READER CANNOT PERFORM.
 *
 * `show: false` removes the entry entirely. A failing permission check renders NOTHING, never a
 * disabled control (contract §1.8) — an ungated "Delete" that lands on a refusal invites every tier
 * to press it, and a greyed-out row of five actions tells an author nothing except that the CMS is
 * withholding something.
 *
 * ⚠ `show` MUST BE THE SAME PREDICATE `lib/permissions.ts` GIVES THE ROUTE HANDLER — `canPublish(user)`,
 * `canEditRecord(user, row.authorId)`. A client guard that only hides a control is not a guard
 * (contract §1.7): hiding it here is for the reader's benefit, and the handler refusing it is the
 * actual boundary. Two predicates that disagree is how a rule silently stops matching.
 *
 * `disabled` is a different thing and is NOT a permission: it means "not available right now" — a
 * Restore on a row that is not in the recycle bin. The reader may do it, just not to this row.
 *
 * 2. DESTRUCTIVE ENTRIES ARE MOVED TO THE FOOT AND SEPARATED.
 *
 * Whatever order the caller passes them in, `tone: "danger"` entries are collected and placed after a
 * `role="separator"`. Reflexes are the enemy here: a Delete sitting immediately under Duplicate is a
 * Delete that gets pressed by a hand that meant to press Duplicate, and a menu whose dangerous entry
 * moves position between two screens is a menu nobody can build a reflex against safely. The tone
 * gives it the error treatment, the separator gives it distance, and the confirmation (see
 * `DeleteButton`) gives it a question with a stated consequence.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WITH NOTHING TO SHOW IT RENDERS NOTHING AT ALL — not a trigger, not an empty menu. A "…" button
 * that opens onto "No actions are available" is a control that lies about being a control; an absent
 * button is the honest answer, and the row simply has no trailing cell content.
 *
 * `"use client"`, because every entry carries an `onSelect` and only a client component can make one.
 */

import type { LucideIcon } from "lucide-react";

import { DropdownMenu, type DropdownMenuEntry } from "@/components/ui/DropdownMenu";
import type { PopoverAlign, PopoverSide } from "@/components/ui/Popover";

export interface RowAction {
  /** Stable within the row's menu. Used as the React key and by the typeahead's focus bookkeeping. */
  id: string;
  /** Plain text — it is the accessible name AND what typeahead matches. "Move to recycle bin". */
  label: string;
  icon?: LucideIcon;
  /** One short line for an action whose consequence is not obvious from its label. */
  description?: string;
  /** `danger` moves the entry below the separator and gives it the error treatment. */
  tone?: "default" | "danger";
  /**
   * "Not available for THIS row." Renders greyed and unselectable, with the reason belonging in
   * `description`. ⚠ NOT a permission check — see the header, and use `show` for that.
   */
  disabled?: boolean;
  /**
   * Whether the reader may do this at all. `false` removes the entry; `undefined` means yes.
   * Pass the same predicate from `lib/permissions.ts` that the route handler checks.
   */
  show?: boolean;
  onSelect: () => void;
}

export interface RowActionsProps {
  /**
   * What the row IS, for the trigger's accessible name: "Bagru dyeing" becomes "Actions for Bagru
   * dyeing". A table of twenty buttons all named "Actions" is a table a screen-reader user cannot
   * navigate.
   */
  subject: string;
  actions: readonly RowAction[];
  align?: PopoverAlign;
  side?: PopoverSide;
  /** Applied to the trigger button. */
  className?: string;
}

function isVisible(action: RowAction): boolean {
  return action.show !== false;
}

export function RowActions({ subject, actions, align = "end", side = "bottom", className }: RowActionsProps) {
  const visible = actions.filter(isVisible);

  // Partitioned rather than sorted: a stable partition keeps the caller's order inside each half, so
  // the safe actions stay in the sequence the screen chose and only the dangerous ones move.
  const safe = visible.filter((action) => action.tone !== "danger");
  const destructive = visible.filter((action) => action.tone === "danger");

  if (visible.length === 0) return null;

  const entries: DropdownMenuEntry[] = [];

  for (const action of safe) {
    entries.push({
      id: action.id,
      label: action.label,
      icon: action.icon,
      description: action.description,
      disabled: action.disabled,
      onSelect: action.onSelect
    });
  }

  // No separator when one half is empty — a menu opening onto a rule with nothing above it reads as a
  // rendering fault, and `role="separator"` would announce a break between one group and nothing.
  if (safe.length > 0 && destructive.length > 0) {
    entries.push({ id: "row-actions-danger-separator", separator: true });
  }

  for (const action of destructive) {
    entries.push({
      id: action.id,
      label: action.label,
      icon: action.icon,
      description: action.description,
      tone: "danger",
      disabled: action.disabled,
      onSelect: action.onSelect
    });
  }

  return (
    <DropdownMenu
      items={entries}
      label={`Actions for ${subject}`}
      align={align}
      side={side}
      className={className}
    />
  );
}
