"use client";

/**
 * AnnouncementManager — the screen that decides what band, if any, sits across the top of the public site.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ONE THING THIS SCREEN EXISTS TO ANSWER: **is this announcement in front of readers right now, and
 * if not, why not.**
 *
 * A scheduled band has five states that look identical in a plain table — switched off, waiting to start,
 * showing, finished, and "switched on and inside its dates but standing behind a newer one" — and the
 * single most common confusion with a scheduled banner is not knowing which of them you are looking at. So
 * every row carries a badge with an ICON AND A WORD and a sentence saying, in plain terms, what is
 * happening: "Starts in 3 days — on 4 June 2026 at 09:00", "It stopped showing on 4 June", "Switched off.
 * Nobody outside the studio can see it, whatever the dates say."
 *
 * ⚠ ONLY ONE BAND IS EVER DRAWN, AND THE RULE IS "THE MOST RECENTLY WRITTEN ONE WINS". That rule is
 * implemented TWICE: here, in `showingRows` below, and in components/site/AnnouncementBar.tsx as
 * `orderBy: { createdAt: "desc" }` on a `findFirst`. It has to be duplicated — one half is a client
 * component and the other is a database query — and the two must agree, or this screen will promise one
 * thing and the site will show another. If the rule changes, change both.
 *
 * ⚠ `isShowing` BELOW IS THE CLIENT-SIDE TWIN OF `isAnnouncementActive()` IN lib/announcements.ts, which
 * is what the public read uses. The same accepted duplication as `statusProblems()` against
 * `publishTransition()`: the rule is three date comparisons, this file is a client component, and the
 * screen has to be able to recompute it as time passes rather than only when a request answers.
 *
 * SWITCHING ON A SECOND ONE IS WARNED, NOT REFUSED, AND THE WARNING SAYS WHICH ONE WINS. Refusing it would
 * stop an editor queueing next week's notice while this week's is still up. So the confirmation names the
 * announcement already showing and states, in so many words, which of the two readers will see — because
 * "you have two live announcements" is a fact nobody can act on without that.
 *
 * TIME IS RE-READ EVERY THIRTY SECONDS. A screen left open across a start time would otherwise keep saying
 * "starts in a moment" long after it started, and an editor watching for a band to appear would be watching
 * a screen that had stopped telling the truth.
 *
 * ⚠ EVERY DATE SENTENCE IS COMPUTED IN THE BROWSER, after the list arrives. "In three days" and the
 * formatted dates depend on the reader's own clock and time zone, which the server render does not know:
 * printing them during SSR produces a hydration mismatch React resolves by keeping the SERVER's answer,
 * which is the wrong one (see StatusControl.tsx, which documents the same trap). Nothing date-dependent
 * renders while `rows` is null, and `rows` only becomes non-null in the browser.
 *
 * ⚠ REMOVING IS SOFT, AND THE REMOVED ONES ARE LISTED HERE. `Announcement` carries `deletedAt`, but the
 * recycle-bin screen does not list announcements — so without this section a removed one would be
 * reachable from nowhere, which is the "quietly vanished" failure contract §1.6 exists to prevent. Putting
 * one back needs administrator access, so the control is ABSENT rather than disabled for anybody else, and
 * a sentence says who can do it (contract §1.8).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `items === null` versus `items === []` IS A DELIBERATE DISTINCTION (contract §9): null renders the
 * loading skeleton, `[]` renders the empty state. "No announcements" during a fetch is both wrong and
 * discouraging.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import {
  CalendarClock,
  CircleAlert,
  EyeOff,
  Link2,
  Megaphone,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RotateCcw,
  Trash2,
  TriangleAlert,
  type LucideIcon
} from "lucide-react";
// A TYPE-only import, so nothing of the Prisma client reaches the browser bundle — types are erased.
// It also makes the tone maps below exhaustive: adding a tone to the schema is a compile error here.
import type { AnnouncementTone } from "@prisma/client";

import { asApiClientError, del, patch, post } from "@/lib/client/fetcher";
import { useResource } from "@/lib/client/useResource";
import { cn } from "@/lib/utils";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/ToastProvider";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";
import { LinkDestinationField } from "@/components/studio/fields/LinkField";

/** Every address this screen calls, in one place, so the route handlers have one list to satisfy. */
const ENDPOINTS = {
  list: "/api/studio/announcements",
  create: "/api/studio/announcements",
  detail: (id: string) => `/api/studio/announcements/${encodeURIComponent(id)}`
} as const;

/**
 * ⚠ DUPLICATED FROM app/api/studio/announcements/route.ts, AND IT HAS TO BE. This file is a client
 * component; that one imports server-only modules. If a cap changes there, change it here, or a counter
 * will say "38 of 240" while the save refuses at 200.
 */
const MESSAGE_MAX = 240;
const LINK_LABEL_MAX = 48;

/**
 * The four tones, in the order the picker offers them: quietest first.
 *
 * The words match `components/site/AnnouncementBar.tsx`, which is what a visitor reads in front of the
 * message — so an editor choosing "Urgent" here knows the band will say "Urgent" there.
 */
const TONE_ORDER: readonly AnnouncementTone[] = ["INFO", "SUCCESS", "WARNING", "URGENT"];

const TONE_LABELS: Record<AnnouncementTone, string> = {
  INFO: "Notice — the Centre's purple",
  SUCCESS: "Good news — green",
  WARNING: "Please note — amber",
  URGENT: "Urgent — red"
};

/** One plain line per choice, so a picker is never a guess. */
const TONE_MEANINGS: Record<AnnouncementTone, string> = {
  INFO: "The ordinary band. For news, an invitation, a change of dates. The band reads “Notice” before your words.",
  SUCCESS:
    "For something that has opened or gone well — applications now open, a grant awarded. The band reads “Good news”.",
  WARNING:
    "For something a reader should weigh before they set out: a change of venue, a delayed publication. The band reads “Please note”.",
  URGENT:
    "For a closure or a safety notice, and nothing else. Used for anything less it stops meaning anything. The band reads “Urgent”."
};

/** How often the screen re-reads the clock. See the header. */
const NOW_TICK_MS = 30_000;

/**
 * What a row can be busy doing, and the stand-in id for the create panel, which has no row of its own.
 *
 * The ACTION is part of the busy state rather than only the id, because a spinner on the wrong control is a
 * plain lie about what the screen is doing: with an id alone, pressing Remove would spin the Switch-off
 * button beside it while the delete was in flight.
 */
type BusyAction = "create" | "save" | "switch" | "remove" | "restore";

const NEW_ROW = "new";

function isTone(value: string): value is AnnouncementTone {
  return (TONE_ORDER as readonly string[]).includes(value);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface AnnouncementRow {
  id: string;
  message: string;
  href: string | null;
  linkLabel: string | null;
  tone: AnnouncementTone;
  /** ISO 8601 throughout: JSON has no date type. */
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
  dismissible: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface AnnouncementListResponse {
  items: AnnouncementRow[];
  total: number;
  /** True when this answer does not carry every row. The screen says so (contract §1.6). */
  truncated: boolean;
  removed: AnnouncementRow[];
  removedTotal: number;
  removedTruncated: boolean;
  limit: number;
}

interface WriteResponse {
  announcement?: AnnouncementRow;
  message?: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Dates
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function parseIso(iso: string | null): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * An ISO instant as a `datetime-local` box wants it: `YYYY-MM-DDTHH:mm`, in local time, no zone.
 *
 * ⚠ Built by hand from the LOCAL getters, never by slicing `toISOString()` — that returns UTC, and a slice
 * of it puts a 9am start in Jaipur into the box as 03:30, which the reader then "corrects". Duplicated from
 * components/studio/StatusControl.tsx, which does not export it; if either changes, change both.
 */
function toLocalInputValue(iso: string | null): string {
  const date = parseIso(iso);
  if (!date) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The reverse.
 *
 * `new Date("2026-07-30T09:00")` is parsed as LOCAL time by the specification, which is what is wanted here
 * — and note it differs from `new Date("2026-07-30")`, which is parsed as UTC. The two spellings look alike
 * and mean different instants.
 */
function parseLocalInput(value: string): Date | null {
  if (value.trim().length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function fromLocalInputValue(value: string): string | null {
  const date = parseLocalInput(value);
  return date ? date.toISOString() : null;
}

/** "4 June 2026 at 09:00", in the reader's own zone — which the field beneath it says out loud. */
function exactly(date: Date): string {
  return format(date, "d MMMM yyyy 'at' HH:mm");
}

/** "in 3 days", "2 days ago". Never a bare date: "how long" is the question being asked. */
function relatively(date: Date): string {
  return formatDistanceToNow(date, { addSuffix: true });
}

/** The clock, re-read on an interval so a screen left open does not stop telling the truth. */
function useNow(intervalMs: number): Date {
  // Seeded during render, which on the server is the server's clock — nothing date-dependent is drawn until
  // the list arrives, and the list only arrives in the browser. See the header.
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);

  return now;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// What state is this announcement in?
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Is the announcement inside its dates right now, IGNORING the on/off switch?
 *
 * Separate from `isShowing` because the confirmation before switching one on has to ask exactly this: "if I
 * turn this on, does anything change for a reader this minute?"
 */
function withinWindow(row: AnnouncementRow, now: Date): boolean {
  const startsAt = parseIso(row.startsAt);
  const endsAt = parseIso(row.endsAt);
  if (startsAt && startsAt.getTime() > now.getTime()) return false;
  if (endsAt && endsAt.getTime() <= now.getTime()) return false;
  return true;
}

/** ⚠ The client-side twin of `isAnnouncementActive()` in lib/announcements.ts. See the header. */
function isShowing(row: AnnouncementRow, now: Date): boolean {
  return row.deletedAt === null && row.isActive && withinWindow(row, now);
}

interface RowState {
  tone: BadgeTone;
  word: string;
  icon: LucideIcon;
  /** The plain sentence. Says what is happening, and where it is not showing, why not. */
  sentence: string;
}

/**
 * The five states, spelled out.
 *
 * Every branch is written explicitly rather than falling through to a default, for the same reason
 * `isLive()` in lib/content.ts is: "it was not switched off so we said it was showing" is how a screen ends
 * up lying about what the public can see.
 */
function describeRow(row: AnnouncementRow, now: Date, winner: AnnouncementRow | null): RowState {
  if (!row.isActive) {
    return {
      tone: "neutral",
      word: "Switched off",
      icon: PowerOff,
      sentence:
        "Nobody outside the studio can see it, whatever the dates say. Switch it on when it is ready."
    };
  }

  const startsAt = parseIso(row.startsAt);
  if (startsAt && startsAt.getTime() > now.getTime()) {
    return {
      tone: "info",
      word: "Waiting to start",
      icon: CalendarClock,
      sentence: `Switched on, but it starts ${relatively(startsAt)} — on ${exactly(startsAt)}. Nothing is shown before then.`
    };
  }

  const endsAt = parseIso(row.endsAt);
  if (endsAt && endsAt.getTime() <= now.getTime()) {
    return {
      tone: "neutral",
      word: "Finished",
      icon: CalendarClock,
      sentence: `It stopped showing on ${exactly(endsAt)}, ${relatively(endsAt)}. It is still switched on, so clearing or moving the end date would bring it straight back.`
    };
  }

  if (winner && winner.id !== row.id) {
    return {
      tone: "warn",
      word: "Hidden behind another",
      icon: EyeOff,
      sentence: `It is switched on and inside its dates, but “${winner.message}” was written more recently and is the one readers see. This one appears if that one is switched off, ends, or is removed.`
    };
  }

  return {
    tone: "success",
    word: "Showing now",
    icon: Megaphone,
    sentence: endsAt
      ? `On every page of the site until ${exactly(endsAt)}, ${relatively(endsAt)}.`
      : "On every page of the site. No end date is set, so it stays until it is switched off."
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The draft an editor is holding
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface Draft {
  message: string;
  href: string;
  linkLabel: string;
  tone: AnnouncementTone;
  /** `datetime-local` values: local time, no zone. Converted on the way out. */
  startsAt: string;
  endsAt: string;
  isActive: boolean;
  dismissible: boolean;
}

function blankDraft(): Draft {
  return {
    message: "",
    href: "",
    linkLabel: "",
    tone: "INFO",
    startsAt: "",
    endsAt: "",
    /**
     * ON, matching the column's own default and what an editor writing one expects: they came here to put
     * something in front of readers. The warning about a second live announcement is on screen from the
     * moment this panel opens, so nothing is switched on unknowingly.
     *
     * (The ROUTE defaults this to off for a body that omits the key. That is a different question — a
     * client bug must not publish — and the form always sends an explicit value.)
     */
    isActive: true,
    dismissible: true
  };
}

function draftFrom(row: AnnouncementRow): Draft {
  return {
    message: row.message,
    href: row.href ?? "",
    linkLabel: row.linkLabel ?? "",
    tone: row.tone,
    startsAt: toLocalInputValue(row.startsAt),
    endsAt: toLocalInputValue(row.endsAt),
    isActive: row.isActive,
    dismissible: row.dismissible
  };
}

function payloadFrom(draft: Draft) {
  return {
    message: draft.message.trim(),
    href: draft.href.trim(),
    linkLabel: draft.linkLabel.trim(),
    tone: draft.tone,
    startsAt: fromLocalInputValue(draft.startsAt),
    endsAt: fromLocalInputValue(draft.endsAt),
    isActive: draft.isActive,
    dismissible: draft.dismissible
  };
}

/**
 * The one thing that can be wrong with a window.
 *
 * ⚠ WORD FOR WORD the sentence both route handlers refuse the save with. Duplicated because those modules
 * are server-only; if one is reworded, reword both, or the studio will refuse a save for one reason and
 * explain a different one.
 */
function windowProblem(draft: Draft): string | null {
  const startsAt = parseLocalInput(draft.startsAt);
  const endsAt = parseLocalInput(draft.endsAt);
  if (!startsAt || !endsAt) return null;
  if (endsAt.getTime() > startsAt.getTime()) return null;
  return "The date it stops showing has to be after the date it starts. As it stands the announcement would never appear.";
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The screen
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface AnnouncementManagerProps {
  /**
   * Whether this reader may put a removed announcement back — `canRestoreDeleted`, which is administrator
   * and above. ⚠ A COURTESY: the route handler enforces the same predicate (contract §1.7).
   */
  canRestore: boolean;
}

export function AnnouncementManager({ canRestore }: AnnouncementManagerProps) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const now = useNow(NOW_TICK_MS);

  const list = useResource<AnnouncementListResponse>(ENDPOINTS.list);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  /** Which row is busy, and with what. See `BusyAction` for why the action is part of it. */
  const [busy, setBusy] = useState<{ id: string; action: BusyAction } | null>(null);

  /** The busy action for one row, or null. Handed to the card so each control spins for its own work. */
  const busyActionFor = (id: string): BusyAction | null => (busy?.id === id ? busy.action : null);

  const rows = list.data?.items ?? null;
  const removed = list.data?.removed ?? [];
  const truncated = list.data?.truncated ?? false;

  /**
   * Every announcement inside its dates and switched on, newest first.
   *
   * The list arrives newest-first from the route, so the FIRST entry is the one readers see. That is the
   * rule the public band implements as a database ordering — see the header.
   */
  const showingRows = useMemo(() => (rows ?? []).filter((row) => isShowing(row, now)), [rows, now]);
  const winner = showingRows[0] ?? null;

  const report = useCallback(
    (thrown: unknown, title: string) => {
      // The server's `message` is already a plain sentence ready to render (lib/api.ts guarantees it).
      toast({ tone: "error", title, description: asApiClientError(thrown).message });
    },
    [toast]
  );

  const announce = useCallback(
    (title: string, description?: string) => {
      toast({ tone: "success", title, ...(description ? { description } : {}) });
    },
    [toast]
  );

  const create = useCallback(
    async (draft: Draft) => {
      setBusy({ id: NEW_ROW, action: "create" });
      try {
        const answer = await post<WriteResponse>(ENDPOINTS.create, payloadFrom(draft));
        setCreating(false);
        await list.refresh();
        announce("The announcement has been saved", answer?.message);
      } catch (thrown) {
        report(thrown, "The announcement has not been saved");
      } finally {
        setBusy(null);
      }
    },
    [announce, list, report]
  );

  const save = useCallback(
    async (row: AnnouncementRow, draft: Draft) => {
      setBusy({ id: row.id, action: "save" });
      try {
        const answer = await patch<WriteResponse>(ENDPOINTS.detail(row.id), payloadFrom(draft));
        setEditingId(null);
        await list.refresh();
        announce("The announcement has been saved", answer?.message);
      } catch (thrown) {
        report(thrown, "The announcement has not been saved");
      } finally {
        setBusy(null);
      }
    },
    [announce, list, report]
  );

  /**
   * Switch one on or off.
   *
   * ⚠ THE WARNING BEFORE A SECOND LIVE ANNOUNCEMENT, AND IT NAMES THE WINNER. Only raised when turning one
   * ON would change what a reader sees THIS MINUTE — an announcement that does not start until next week
   * changes nothing yet, and a confirmation about a clash that has not happened is a confirmation people
   * learn to click through without reading.
   */
  const setActive = useCallback(
    async (row: AnnouncementRow, next: boolean) => {
      if (next && withinWindow(row, now) && winner && winner.id !== row.id) {
        // Both are in the list, which is ordered newest-first, so position decides.
        const mine = (rows ?? []).findIndex((entry) => entry.id === row.id);
        const theirs = (rows ?? []).findIndex((entry) => entry.id === winner.id);
        const thisWins = mine !== -1 && theirs !== -1 && mine < theirs;

        const agreed = await confirm({
          title: "Switch this on as well?",
          body: (
            <>
              <p>
                <span className="font-semibold text-ink-900">“{winner.message}”</span> is showing on the
                site right now, and only one band is ever drawn.
              </p>
              <p className="mt-2">
                {thisWins
                  ? "This one was written more recently, so readers will see this one from now on and the other will stop appearing until this one ends or is switched off."
                  : "That one was written more recently, so readers will keep seeing it. This one will only appear once that one ends, is switched off, or is removed."}
              </p>
            </>
          ),
          confirmLabel: "Switch it on",
          cancelLabel: "Leave it off",
          // Not destructive: nothing is lost either way, and a danger-toned dialog for a reversible switch
          // spends the reader's attention where it is not needed.
          tone: "default"
        });
        if (!agreed) return;
      }

      setBusy({ id: row.id, action: "switch" });
      try {
        const answer = await patch<WriteResponse>(ENDPOINTS.detail(row.id), { isActive: next });
        await list.refresh();
        announce(next ? "Switched on" : "Switched off", answer?.message);
      } catch (thrown) {
        report(thrown, next ? "It has not been switched on" : "It has not been switched off");
      } finally {
        setBusy(null);
      }
    },
    [announce, confirm, list, now, report, rows, winner]
  );

  const remove = useCallback(
    async (row: AnnouncementRow) => {
      const showing = isShowing(row, now);

      const agreed = await confirm({
        title: "Remove this announcement?",
        body: (
          <>
            <p>
              <span className="font-semibold text-ink-900">“{row.message}”</span> will be taken out of the
              list.
            </p>
            <p className="mt-2">
              {showing
                ? "It is showing on the site at this moment, so it will go from every page. A reader with a page already open may still see it for a few minutes."
                : "It is not showing on the site at the moment, so nothing changes for readers."}
            </p>
            <p className="mt-2">
              It is kept, not destroyed: it appears under the removed ones at the foot of this screen, where
              an administrator can put it back. Switching it off instead leaves it in the list to reuse.
            </p>
          </>
        ),
        confirmLabel: "Remove it",
        cancelLabel: "Keep it",
        tone: "danger"
      });
      if (!agreed) return;

      setBusy({ id: row.id, action: "remove" });
      try {
        const answer = await del<WriteResponse>(ENDPOINTS.detail(row.id));
        if (editingId === row.id) setEditingId(null);
        await list.refresh();
        announce("The announcement has been removed", answer?.message);
      } catch (thrown) {
        report(thrown, "The announcement has not been removed");
      } finally {
        setBusy(null);
      }
    },
    [announce, confirm, editingId, list, now, report]
  );

  const restore = useCallback(
    async (row: AnnouncementRow) => {
      setBusy({ id: row.id, action: "restore" });
      try {
        const answer = await patch<WriteResponse>(ENDPOINTS.detail(row.id), { restore: true });
        await list.refresh();
        announce("The announcement is back in the list", answer?.message);
      } catch (thrown) {
        report(thrown, "It has not been put back");
      } finally {
        setBusy(null);
      }
    },
    [announce, list, report]
  );

  return (
    <div className="space-y-5">
      {/*
        ⚠ THE MOST USEFUL SENTENCE ON THE SCREEN, and it is at the top for that reason: what the public is
        actually looking at this minute. Held back until the list has arrived — "nothing is showing" is a
        claim, and making it while the fetch is still running would be a false one.
      */}
      {rows !== null ? (
        <div
          className={cn(
            "flex flex-wrap items-start gap-x-3 gap-y-2 rounded-md border px-3.5 py-3",
            winner ? "border-success-600/25 bg-success-100" : "border-line-200 bg-surface-50"
          )}
        >
          {winner ? (
            <Megaphone aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success-600" />
          ) : (
            <PowerOff aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" />
          )}
          <p
            className={cn(
              "min-w-0 flex-1 text-sm leading-relaxed",
              winner ? "text-success-600" : "text-ink-500"
            )}
          >
            {winner ? (
              <>
                Readers see this at the top of every page right now:{" "}
                <span className="font-semibold">“{winner.message}”</span>
                {showingRows.length > 1
                  ? ` — ${showingRows.length - 1} other ${showingRows.length === 2 ? "announcement is" : "announcements are"} switched on and inside their dates, waiting behind it.`
                  : "."}
              </>
            ) : (
              "No announcement is showing on the site at the moment. The band is left off the page entirely rather than drawn empty."
            )}
          </p>
        </div>
      ) : null}

      {/* ── Writing a new one ─────────────────────────────────────────────────────────────────── */}
      {creating ? (
        <AnnouncementForm
          heading="Write an announcement"
          description="It appears as one band across the top of every page. Keep it to a sentence: it is read by everybody who visits, on every page, so it earns its place by being short."
          initial={blankDraft()}
          submitLabel="Save the announcement"
          isSaving={busy?.id === NEW_ROW}
          otherShowing={winner}
          onCancel={() => setCreating(false)}
          onSubmit={(draft) => void create(draft)}
        />
      ) : (
        <div>
          <Button variant="secondary" icon={Plus} onClick={() => setCreating(true)}>
            Write an announcement
          </Button>
        </div>
      )}

      {list.error ? (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-md border border-error-200 bg-error-100 px-3 py-2.5 text-sm text-error-700"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{list.error.message}</span>
        </p>
      ) : null}

      {/* ── The list ──────────────────────────────────────────────────────────────────────────── */}
      {rows === null ? (
        <div className="space-y-2">
          <span role="status" className="sr-only">
            Loading the announcements…
          </span>
          <div aria-hidden="true" className="space-y-2">
            {[0, 1, 2].map((row) => (
              <div key={row} className="skeleton h-24 w-full" />
            ))}
          </div>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          headingLevel={2}
          title="No announcements yet"
          description="Nothing is shown at the top of the site. Write one when there is something every visitor needs to know — a closure, a deadline, a call for applications — and switch it off again afterwards."
          action={
            <Button variant="secondary" icon={Plus} onClick={() => setCreating(true)}>
              Write an announcement
            </Button>
          }
        />
      ) : (
        <section aria-label="Announcements">
          <ul className="space-y-3">
            {rows.map((row) => (
              <AnnouncementCard
                key={row.id}
                row={row}
                state={describeRow(row, now, winner)}
                isEditing={editingId === row.id}
                busyAction={busyActionFor(row.id)}
                otherShowing={winner && winner.id !== row.id ? winner : null}
                onEdit={() => setEditingId(row.id)}
                onCancelEdit={() => setEditingId(null)}
                onSave={(draft) => void save(row, draft)}
                onSetActive={(next) => void setActive(row, next)}
                onRemove={() => void remove(row)}
              />
            ))}
          </ul>

          {/* A list that quietly stops is indistinguishable from a short list (contract §1.6). */}
          {truncated ? (
            <HelpText tone="warn" className="mt-3">
              This screen shows the {rows.length} most recent announcements of{" "}
              {list.data?.total ?? rows.length}. The older ones are not listed, and the judgement above
              about which one readers see takes account only of the ones shown here. Remove the ones you no
              longer need so the list is a complete answer again.
            </HelpText>
          ) : null}
        </section>
      )}

      {/* ── Removed ───────────────────────────────────────────────────────────────────────────── */}
      {removed.length > 0 ? (
        <RemovedList
          rows={removed}
          total={list.data?.removedTotal ?? removed.length}
          truncated={list.data?.removedTruncated ?? false}
          canRestore={canRestore}
          restoringId={busy?.action === "restore" ? busy.id : null}
          onRestore={(row) => void restore(row)}
        />
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// One row
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface AnnouncementCardProps {
  row: AnnouncementRow;
  state: RowState;
  isEditing: boolean;
  /** What this row is busy doing, or null. See `busy` on the screen above. */
  busyAction: BusyAction | null;
  /** The announcement readers currently see, when it is not this one. For the editor's warning. */
  otherShowing: AnnouncementRow | null;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (draft: Draft) => void;
  onSetActive: (next: boolean) => void;
  onRemove: () => void;
}

function AnnouncementCard({
  row,
  state,
  isEditing,
  busyAction,
  otherShowing,
  onEdit,
  onCancelEdit,
  onSave,
  onSetActive,
  onRemove
}: AnnouncementCardProps) {
  const StateIcon = state.icon;
  const hasLinkWords = row.linkLabel !== null && row.linkLabel.trim().length > 0;

  return (
    <li className="panel px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        {/* Icon AND word, never colour alone (contract §11). */}
        <Badge tone={state.tone} size="sm" icon={StateIcon}>
          {state.word}
        </Badge>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={row.isActive ? PowerOff : Power}
            isLoading={busyAction === "switch"}
            loadingLabel={row.isActive ? "switching off" : "switching on"}
            onClick={() => onSetActive(!row.isActive)}
          >
            {row.isActive ? "Switch off" : "Switch on"}
          </Button>

          {isEditing ? null : (
            <Button variant="ghost" size="sm" icon={Pencil} onClick={onEdit}>
              Change it
            </Button>
          )}

          <Button
            variant="danger"
            size="sm"
            icon={Trash2}
            isLoading={busyAction === "remove"}
            loadingLabel="removing"
            onClick={onRemove}
          >
            Remove
          </Button>
        </div>
      </div>

      <p className="mt-3 text-pretty text-sm font-medium leading-relaxed text-ink-900">{row.message}</p>

      {row.href ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-ink-500">
          <Link2 aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">
            {/* The band reads "Read more" when no words are given — said here so the two agree. */}
            <span className="font-medium text-ink-700">
              {hasLinkWords ? row.linkLabel : "Read more"}
            </span>{" "}
            goes to <span className="font-mono">{row.href}</span>
            {hasLinkWords
              ? ""
              : " — no words were given for the link, so the band reads “Read more”, which tells a reader less."}
          </span>
        </p>
      ) : null}

      <p className="mt-2 text-xs leading-relaxed text-ink-500">{state.sentence}</p>

      <p className="mt-1 text-xs leading-relaxed text-ink-500">
        {TONE_LABELS[row.tone]}.{" "}
        {row.dismissible
          ? "A reader can close it, and it stays closed for them until the wording changes."
          : "A reader cannot close it — there is no close button on the band at all."}
      </p>

      {isEditing ? (
        <div className="mt-4 border-t border-line-200 pt-4">
          <AnnouncementForm
            // Remounted per row and per save, so one announcement's draft can never be saved onto another
            // and a refreshed row reseeds the boxes.
            key={`${row.id}-${row.updatedAt}`}
            heading="Change this announcement"
            description="Saving takes effect straight away, though a page a reader already has open may show the old wording for a few minutes."
            initial={draftFrom(row)}
            submitLabel="Save the changes"
            isSaving={busyAction === "save"}
            otherShowing={otherShowing}
            onCancel={onCancelEdit}
            onSubmit={onSave}
          />
        </div>
      ) : null}
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The removed ones
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Removed announcements, and how to get one back.
 *
 * ⚠ THIS SECTION IS WHY THE DELETE CAN BE SOFT. Nothing else in the studio lists a removed announcement —
 * the recycle-bin screen's `BIN_TYPES` has no entry for them — so without it a removed row would be
 * reachable from nowhere at all, which reads as data destroyed rather than data kept.
 *
 * The Restore control is ABSENT for a reader who cannot use it, never disabled (contract §1.8), and a
 * sentence says who can. An editor who cannot find a control concludes the CMS is broken; an editor told
 * "an administrator can put this back" knows whom to ask.
 */
function RemovedList({
  rows,
  total,
  truncated,
  canRestore,
  restoringId,
  onRestore
}: {
  rows: readonly AnnouncementRow[];
  total: number;
  truncated: boolean;
  canRestore: boolean;
  /** The row being put back, or null. */
  restoringId: string | null;
  onRestore: (row: AnnouncementRow) => void;
}) {
  return (
    <FormSection
      title="Removed announcements"
      description="Taken out of the list but kept. None of these is on the public site, and none of them can be. Putting one back needs administrator access, and it comes back switched off."
    >
      <ul className="space-y-2">
        {rows.map((row) => {
          const removedAt = parseIso(row.deletedAt);
          return (
            <li
              key={row.id}
              className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 rounded-md border border-line-200 bg-surface-50 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="text-pretty text-sm leading-relaxed text-ink-700">{row.message}</p>
                {removedAt ? (
                  <p className="mt-0.5 text-xs text-ink-500">
                    Removed {relatively(removedAt)}, on {exactly(removedAt)}.
                  </p>
                ) : null}
              </div>

              {canRestore ? (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={RotateCcw}
                  isLoading={restoringId === row.id}
                  loadingLabel="putting it back"
                  onClick={() => onRestore(row)}
                >
                  Put it back
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>

      {canRestore ? null : (
        <HelpText>
          Only an administrator can put a removed announcement back. If one of these is needed again, ask an
          administrator, or write a new announcement with the same wording.
        </HelpText>
      )}

      {truncated ? (
        <HelpText tone="warn">
          This shows the {rows.length} most recently removed announcements of {total}. The older ones are
          not listed here.
        </HelpText>
      ) : null}
    </FormSection>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The fields, shared by writing a new one and changing an old one
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface AnnouncementFormProps {
  heading: string;
  description: string;
  initial: Draft;
  submitLabel: string;
  isSaving: boolean;
  /** The announcement readers currently see, when it is not this one. Drives the clash warning. */
  otherShowing: AnnouncementRow | null;
  onCancel: () => void;
  onSubmit: (draft: Draft) => void;
}

/**
 * The editor, used for both writing a new announcement and changing an existing one.
 *
 * ⚠ THE DATE BOXES SPEAK THIS COMPUTER'S TIME ZONE, AND THE SCREEN SAYS SO. `datetime-local` has no zone of
 * its own; the value is read as the browser's local time and stored as an absolute instant. An
 * administrator scheduling from another country must be told which zone the box is speaking, or "starts at
 * 9am" means two different instants to the two people who set it and read it (the same rule
 * StatusControl.tsx states for scheduled pages).
 *
 * ⚠ THE LINK'S WORDS AND ITS ADDRESS ARE TWO SEPARATE FIELDS RATHER THAN A `LinkField`. `LinkField`'s own
 * warning says a half-finished pair "will not appear on the page", which is true of a button and NOT true
 * here: the band draws the link with the words "Read more" when none are given. A field that describes the
 * wrong behaviour is worse than two fields.
 *
 * ⚠ AND THE DISMISSAL RULE IS STATED WHERE THE WORDING IS EDITED. A dismissal is remembered against the
 * announcement AND its last edit (see AnnouncementBar.tsx), so correcting a date shows the correction to
 * everybody again — which is the behaviour an editor wants and would never guess.
 */
function AnnouncementForm({
  heading,
  description,
  initial,
  submitLabel,
  isSaving,
  otherShowing,
  onCancel,
  onSubmit
}: AnnouncementFormProps) {
  const [draft, setDraft] = useState<Draft>(initial);

  const update = (next: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...next }));
  };

  const problem = windowProblem(draft);
  const messageEmpty = draft.message.trim().length === 0;
  const startsAt = parseLocalInput(draft.startsAt);
  const endsAt = parseLocalInput(draft.endsAt);

  return (
    <FormSection
      title={heading}
      description={description}
      // FormSection's default rank of 2 is right in BOTH positions. The page's `<h1>` is the only heading
      // above either of them: the list is a `<section>` named by `aria-label` and the cards render no
      // heading of their own, so an `<h3>` here would skip a level rather than nest under one (§11).
      actions={
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      }
      footer={
        <Button
          isLoading={isSaving}
          loadingLabel="saving"
          disabled={messageEmpty || problem !== null}
          onClick={() => onSubmit(draft)}
        >
          {submitLabel}
        </Button>
      }
    >
      <Field
        label="What it says"
        required
        help="One sentence, in plain words: what has happened, and what a reader should do about it. It is shown on every page, so anything longer than a sentence is read by nobody."
        maxLength={MESSAGE_MAX}
        value={draft.message}
      >
        <Textarea
          rows={2}
          value={draft.message}
          onChange={(event) => update({ message: event.target.value })}
          placeholder="The Centre is closed on 14 August for the public holiday."
        />
      </Field>

      <LinkDestinationField
        label="Where it leads"
        value={draft.href}
        help="Optional. A page on this site, or another address, for a reader who wants the detail. Leave it empty for a notice that needs no follow-up."
        onChange={(href) => update({ href })}
      />

      <Field
        label="Words on the link"
        help="What a reader clicks — “Read the notice”, “See the new dates”. Left empty, the band says “Read more”, which tells them less."
        maxLength={LINK_LABEL_MAX}
        value={draft.linkLabel}
      >
        <Input
          value={draft.linkLabel}
          onChange={(event) => update({ linkLabel: event.target.value })}
          placeholder="Read the notice"
        />
      </Field>

      <Field label="How the band reads" help={TONE_MEANINGS[draft.tone]}>
        <Select
          value={draft.tone}
          options={TONE_ORDER.map((tone) => ({ value: tone, label: TONE_LABELS[tone] }))}
          onChange={(event) => {
            const next = event.target.value;
            if (isTone(next)) update({ tone: next });
          }}
        />
      </Field>

      {draft.tone === "URGENT" ? (
        <HelpText tone="warn" icon={CircleAlert}>
          A red band is for a closure or a safety notice. Every other announcement in it makes the next real
          emergency read like ordinary news.
        </HelpText>
      ) : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Starts showing" help="Leave it empty to start as soon as it is switched on.">
          <Input
            type="datetime-local"
            value={draft.startsAt}
            onChange={(event) => update({ startsAt: event.target.value })}
          />
        </Field>

        <Field
          label="Stops showing"
          help="Leave it empty and it stays up until somebody switches it off."
          error={problem}
        >
          <Input
            type="datetime-local"
            value={draft.endsAt}
            onChange={(event) => update({ endsAt: event.target.value })}
          />
        </Field>
      </div>

      <HelpText>
        Both boxes are read in this computer&rsquo;s time zone, and the announcement appears and disappears
        on its own — nothing has to be remembered or run. The site checks the dates on every visit, so one
        whose end date has passed cannot stay up.
        {startsAt ? ` It starts on ${exactly(startsAt)}.` : ""}
        {endsAt ? ` It stops on ${exactly(endsAt)}.` : ""}
      </HelpText>

      <Switch
        label="Switched on"
        description="Off means nobody outside the studio sees it, whatever the dates say. On means the dates decide."
        checked={draft.isActive}
        onCheckedChange={(checked) => update({ isActive: checked })}
      />

      {draft.isActive && otherShowing ? (
        <HelpText tone="warn">
          “{otherShowing.message}” is showing on the site right now, and only one band is ever drawn. Readers
          see whichever of the two was written more recently; the other waits until that one ends or is
          switched off.
        </HelpText>
      ) : null}

      <Switch
        label="A reader may close it"
        description="Adds a close button to the band. Once closed it stays closed for that reader, in that browser — until the wording is changed, at which point they are shown it again, because a correction has to reach the people who read the original. Turn it off for something nobody should be able to put out of sight, such as a closure."
        checked={draft.dismissible}
        onCheckedChange={(checked) => update({ dismissible: checked })}
      />

      {messageEmpty ? (
        <HelpText>The announcement needs something to say before it can be saved.</HelpText>
      ) : null}
    </FormSection>
  );
}
