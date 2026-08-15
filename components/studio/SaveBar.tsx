"use client";

/**
 * SaveBar — the sticky bar at the foot of every editor: what state the work is in, and the two things
 * a reader can do about it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE STATE IS IN WORDS, NOT IN A COLOUR OR A SPINNER.
 *
 * "Unsaved changes" · "Saving…" · "All changes saved" · "Could not save". A dot that turns from amber
 * to green is a signal nobody who cannot separate the two hues ever receives, and a spinner is a
 * picture of waiting that says nothing to a screen reader (contract §1.4, §11). The glyph and the
 * colour are the second and third copies of a signal the words already carry.
 *
 * AND THE LAST SAVE IS STATED IN RELATIVE WORDS — "saved 2 minutes ago". A timestamp is a fact about
 * the clock; "2 minutes ago" is a fact about the reader's session, which is what they are actually
 * asking. It is the difference between an editor who trusts the bar and one who saves compulsively.
 *
 * `aria-live="polite"` IS ON THE STATUS WORD ONLY — never on the bar, and never on the relative time.
 *
 *   • Not the bar: the buttons live in it. A live region wrapping them re-announces "Save, Discard
 *     changes" every time the status word ticks over, which is three words of news and eight of noise.
 *   • Not the relative time: it changes every fifteen seconds for as long as the editor is open. A
 *     polite region that updates on a timer interrupts a reader every fifteen seconds with something
 *     they did not ask for and cannot stop.
 *
 * The word changes only when something actually happened, which is exactly what a live region is for.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * DISCARD ALWAYS ASKS, AND IT ONLY EXISTS WHEN THERE IS SOMETHING TO DISCARD. Throwing away typing is
 * as irreversible as a delete, and there is no recycle bin for it — so the confirmation says what will
 * be lost rather than "Are you sure?". With nothing unsaved the button is absent, not disabled: a
 * control that does nothing is a control that teaches the reader to ignore it.
 *
 * SAVE IS A REAL `<button disabled>` WHEN THERE IS NOTHING TO SAVE, with the reason beside it in the
 * status line. That is the pattern Button.tsx sets out; it is not the §1.8 case, which is about a
 * PERMISSION — if the reader may not save at all, do not render this bar's Save at the call site.
 *
 * IT IS `sticky`, NOT `fixed`, so it does NOT re-pay `--scroll-gutter`. A sticky element is in normal
 * flow and inherits the padding the scroll lock puts on `<body>`; a fixed one cannot, which is why
 * `.overlay-frame` exists for those and is deliberately not used here (contract §6).
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CircleCheck, LoaderCircle, PencilLine, TriangleAlert, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import type { AutosaveStatus } from "@/components/studio/useAutosave";

/**
 * The same union `useAutosave` reports, imported rather than restated: two lists of states that must
 * agree will eventually not, and the one that is wrong is the one on screen.
 */
export type SaveBarStatus = AutosaveStatus;

/** How often the relative time is recomputed. Fifteen seconds is under the resolution of the words. */
const TICK_MS = 15_000;

const STATUS_WORD: Record<SaveBarStatus, string> = {
  idle: "No changes yet",
  dirty: "Unsaved changes",
  saving: "Saving…",
  saved: "All changes saved",
  error: "Could not save"
};

const STATUS_ICON: Record<SaveBarStatus, LucideIcon> = {
  idle: CircleCheck,
  dirty: PencilLine,
  saving: LoaderCircle,
  saved: CircleCheck,
  error: TriangleAlert
};

/**
 * Complete literal class strings — a name assembled by concatenation is purged (contract §5). The
 * status ramps are literal hex and do not invert, on purpose: a save state must read the same in both
 * themes (contract §3).
 */
const STATUS_CLASS: Record<SaveBarStatus, string> = {
  idle: "text-ink-500",
  dirty: "text-amber-800",
  saving: "text-ink-700",
  saved: "text-success-600",
  error: "text-error-600"
};

/**
 * "2 minutes ago", in British English, rounded the way a person would say it.
 *
 * Written here rather than reached for from a date library because the whole vocabulary is nine
 * phrases and every one of them has to be exactly right — "0 minutes ago" and "in 1 second" (which a
 * generic formatter will produce from a clock that has drifted a moment) are both worse than "just
 * now".
 */
function relativeWords(saved: Date, now: number): string {
  const seconds = Math.max(0, Math.round((now - saved.getTime()) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return "less than a minute ago";

  const minutes = Math.round(seconds / 60);
  if (minutes === 1) return "a minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;

  const hours = Math.round(minutes / 60);
  if (hours === 1) return "an hour ago";
  if (hours < 24) return `${hours} hours ago`;

  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export interface SaveBarProps {
  status: SaveBarStatus;
  /** When the last successful save landed. `null` until one has. */
  lastSavedAt: Date | null;
  onSave: () => void;
  /** Puts the form back to what the server last gave it. Asked about first — see the header. */
  onDiscard: () => void;
  /**
   * The failure sentence, VERBATIM from `ApiClientError.message`. `lib/api.ts` guarantees it is
   * already a plain human sentence; re-wording it here would make the two halves of the product
   * disagree about what happened.
   */
  error?: string | null;
  /**
   * Disables Save and prints this beside it — a validation problem the reader must fix first. Say what
   * is wrong, not that something is: "The title is empty."
   */
  saveDisabledReason?: string | null;
  /**
   * A standing note about how this screen saves. For a published record, pass
   * `PUBLISHED_AUTOSAVE_NOTICE` from `useAutosave` — that sentence is the single most important thing
   * this bar can tell an editor.
   */
  note?: ReactNode;
  /** Extra actions to the left of Discard — Publish, "Preview on the site", a revision history button. */
  children?: ReactNode;
  saveLabel?: string;
  discardLabel?: string;
  /** What is being edited, named in the discard question: "this publication". */
  subject?: string;
  className?: string;
}

export function SaveBar({
  status,
  lastSavedAt,
  onSave,
  onDiscard,
  error,
  saveDisabledReason,
  note,
  children,
  saveLabel = "Save",
  discardLabel = "Discard changes",
  subject = "this page",
  className
}: SaveBarProps) {
  const confirm = useConfirm();

  /**
   * `null` until mounted, and the relative phrase is withheld until then.
   *
   * A relative time computed on the server is already stale by the time it hydrates, and the two
   * strings differ — a hydration mismatch React resolves by keeping whichever it wants. Waiting one
   * commit costs a single frame of a phrase that is about to start ticking anyway.
   */
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    if (lastSavedAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [lastSavedAt]);

  const saving = status === "saving";
  const dirty = status === "dirty" || status === "error";
  const blocked = typeof saveDisabledReason === "string" && saveDisabledReason.trim().length > 0;

  // "All changes saved" rather than "No changes yet" once there has been a save this session — the
  // words have to match what the reader remembers doing.
  const word = status === "idle" && lastSavedAt !== null ? STATUS_WORD.saved : STATUS_WORD[status];
  const Icon = STATUS_ICON[status];

  const relative = lastSavedAt !== null && now !== null ? relativeWords(lastSavedAt, now) : null;

  const discard = useCallback(async () => {
    const agreed = await confirm({
      title: `Discard the changes to ${subject}?`,
      body: (
        <p>
          Everything you have changed since the last save is thrown away and {subject} goes back to how
          it was. This cannot be undone — there is no recycle bin for unsaved typing.
        </p>
      ),
      confirmLabel: "Discard changes",
      cancelLabel: "Keep editing",
      tone: "danger"
    });
    if (agreed) onDiscard();
  }, [confirm, onDiscard, subject]);

  return (
    <div
      className={cn(
        // Rung 40 of the ladder — "bottom docks" (contract §6). Never higher: the studio top bar is 50
        // and page chrome must not exceed it.
        "sticky bottom-0 z-40 mt-6",
        className
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-t-md border border-b-0 border-line-200 bg-card px-4 py-3 shadow-panel">
        <div className="min-w-0 flex-1">
          <p className={cn("flex items-center gap-2 text-sm font-medium", STATUS_CLASS[status])}>
            {/* Decorative. The word beside it is what a reader is told, and the spin is collapsed by
                the global reduced-motion rule — the state is still legible without it. */}
            <Icon aria-hidden="true" className={cn("h-4 w-4 shrink-0", saving && "animate-spin")} />

            {/* THE live region, and the only one. See the header. */}
            <span aria-live="polite">{word}</span>

            {/* Outside the live region on purpose: this ticks on a timer. */}
            {relative !== null && !saving ? (
              <span className="font-normal text-ink-500">· saved {relative}</span>
            ) : null}
          </p>

          {error ? (
            // `role="alert"` rather than joining the polite region: a save that failed is the one thing
            // on this bar worth interrupting a reader for, and the sentence is the server's own.
            <p role="alert" className="prose-measure mt-1 text-xs leading-relaxed text-error-600">
              {error}
            </p>
          ) : null}

          {blocked ? (
            <p className="prose-measure mt-1 text-xs leading-relaxed text-amber-800">
              {saveDisabledReason}
            </p>
          ) : null}

          {note ? (
            <p className="prose-measure mt-1 text-xs leading-relaxed text-ink-500">{note}</p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {children}

          {/* Absent, not disabled, when there is nothing to throw away — see the header. */}
          {dirty && !saving ? (
            <Button variant="ghost" onClick={() => void discard()}>
              {discardLabel}
            </Button>
          ) : null}

          <Button
            onClick={onSave}
            isLoading={saving}
            loadingLabel="saving"
            disabled={blocked || (!dirty && !saving)}
          >
            {saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
