"use client";

/**
 * Toast — one notice in the stack. The stack, the live region and the queue live in ToastProvider.
 *
 * ⚠ THE VIEWPORT IS `aria-live="polite"`, WHICH NEVER INTERRUPTS. A screen reader finishes whatever
 * it is saying and only then reads the toast — and if the reader moves on first, it may never be
 * read at all. **A toast is therefore the wrong home for anything the user must act on.** "Saved",
 * "Copied", "3 of 12 files failed" belong here; "This will delete 40 records — are you sure?" and
 * "Your session expired, sign in again" belong in a dialog, which takes focus and demands an answer.
 *
 * THE COUNTDOWN BANKS ELAPSED TIME IN A REF. The timer effect re-runs whenever the toast is paused
 * or resumed, and its cleanup adds the run it just cancelled to `elapsed`. Without that banking, every
 * pause would restart the full duration and a toast under a stationary pointer would live forever.
 *
 * IT PAUSES ON FOCUS AS WELL AS HOVER. A keyboard reader tabs towards Dismiss; if only hover paused
 * the countdown, the toast would vanish mid-reach and the next Tab would land somewhere unrelated.
 * Hover and focus are tracked as two independent flags so leaving with the pointer while focus is
 * still inside does not resume.
 *
 * Every tone carries an ICON AND A WORD. Colour alone is not a signal (contract §11) — and the status
 * ramps are literal hex that do NOT invert, so the tone colours appear as a light chip with dark
 * ink, which reads the same in both themes rather than sinking into the dark canvas.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A TOAST MAY CARRY ONE LINK, AND THAT IS THE ONLY INTERACTIVE THING IT WILL EVER HOLD.
 *
 * It exists for one case: something has just been published, and the editor wants its public address
 * without hunting for it. `link` renders the address in a selectable box with a copy button
 * (`CopyLinkRow`), so the shortcut is right where the news arrived.
 *
 * ⚠ THIS SITS AGAINST THE RULE AT THE TOP OF THIS FILE, AND STAYS INSIDE IT ONLY BECAUSE THE LINK IS A
 * SHORTCUT AND NEVER THE ONLY ROUTE. The record's own screen still shows the same address — in
 * `SlugField`'s preview, and in the "View on the site" action on its table row — so a polite region
 * that is never read costs the reader nothing but a few seconds. The day something appears here that
 * exists NOWHERE ELSE, it belongs in a dialog instead: a live region is not a place to put the only
 * copy of anything.
 *
 * The countdown for a link-carrying toast is longer than the rest (`LINKED_DURATION`), because reaching
 * a control is slower than reading a sentence — and once the pointer or focus arrives the countdown
 * pauses anyway, which is what makes the reach safe rather than a race.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  CircleCheck,
  Info,
  OctagonAlert,
  TriangleAlert,
  X,
  type LucideIcon
} from "lucide-react";

import { cn } from "@/lib/utils";
import { SPRING_TOAST, useReducedMotionPreference } from "@/components/motion";
import { CopyLinkRow } from "@/components/ui/CopyLink";

export type ToastTone = "info" | "success" | "warn" | "error";

/** One address a notice hands over, with a copy button. See the header — a toast carries at most one. */
export interface ToastLink {
  /** Absolute, and exactly as it should be pasted. */
  url: string;
  /** Names the box for a screen reader: "Public address of this page". Not drawn. */
  label: string;
  /**
   * Offer an Open button beside Copy. True for a page that is now live; FALSE for anything one-off —
   * following a password link from the studio spends it.
   */
  openable?: boolean;
}

export interface ToastOptions {
  /** One plain sentence. It is the accessible announcement, so it must stand alone. */
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Milliseconds on screen. Zero or less keeps it until it is dismissed by hand. */
  duration?: number;
  /** An address to hand over. See the header before adding one anywhere new. */
  link?: ToastLink;
}

/** An options object with the defaults resolved and an id attached. Built by ToastProvider. */
export interface ToastRecord {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
  duration: number;
  link?: ToastLink;
}

/** Long enough to read two lines, short enough not to sit over the page a reader is using. */
export const DEFAULT_DURATION = 5000;

/**
 * The countdown for a toast carrying a link.
 *
 * Reading a sentence and reaching a control are different jobs: five seconds is generous for the
 * first and mean for the second, and a copy button that vanishes from under the pointer teaches an
 * editor never to trust one again. Hover and focus both pause the countdown (see the header), so this
 * only has to be long enough for the reader to START moving.
 */
export const LINKED_DURATION = 12_000;

interface ToneStyle {
  icon: LucideIcon;
  /** The word. This is the half of the signal that survives a monochrome screen or colour blindness. */
  word: string;
  /** Literal, complete class strings — a concatenated class name is purged (contract §5). */
  chip: string;
}

export const TOAST_TONES: Record<ToastTone, ToneStyle> = {
  info: { icon: Info, word: "Notice", chip: "bg-purple-100 text-purple-700" },
  success: { icon: CircleCheck, word: "Done", chip: "bg-success-100 text-success-600" },
  // amber-100 + amber-800 as a pair; amber-50 and amber-200 are stock Tailwind here and will not
  // pair correctly (contract §1).
  warn: { icon: TriangleAlert, word: "Warning", chip: "bg-amber-100 text-amber-800" },
  error: { icon: OctagonAlert, word: "Error", chip: "bg-error-100 text-error-600" }
};

export interface ToastProps {
  toast: ToastRecord;
  /** Must be referentially stable, or the timer effect restarts on every parent render. */
  onDismiss: (id: string) => void;
}

export function Toast({ toast, onDismiss }: ToastProps) {
  const reduce = useReducedMotionPreference();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const elapsed = useRef(0);

  const paused = hovered || focused;
  const { id, duration } = toast;

  useEffect(() => {
    if (paused || duration <= 0) return;
    const remaining = Math.max(0, duration - elapsed.current);
    const startedAt = Date.now();
    const handle = window.setTimeout(() => onDismiss(id), remaining);
    return () => {
      window.clearTimeout(handle);
      // The banking. Also runs on unmount, where it is simply discarded with the component.
      elapsed.current += Date.now() - startedAt;
    };
  }, [paused, duration, id, onDismiss]);

  const tone = TOAST_TONES[toast.tone];
  const ToneIcon = tone.icon;

  return (
    <motion.li
      // A toast only exists after an interaction, so it is never part of a prerendered first paint —
      // branching `initial` here cannot cause the hydration flash contract §8 warns about on the
      // public site. `layout="position"` and not plain `layout`: a scaling entrance under a size
      // layout animation distorts the card while the stack reflows.
      layout={reduce ? false : "position"}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.97 }}
      // SPRING_TOAST already carries `type: "spring"` — spreading it after a literal `type` silently
      // overwrites one of them, which is why TypeScript refuses the duplicate rather than picking.
      transition={reduce ? { duration: 0 } : SPRING_TOAST}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      // React's onFocus/onBlur are focusin/focusout and bubble, so focusing Dismiss pauses the card.
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      className="pointer-events-auto w-full rounded-lg border border-line-200 bg-card p-3.5 shadow-lg"
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
            tone.chip
          )}
        >
          <ToneIcon aria-hidden="true" className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-500">
            {tone.word}
          </p>
          <p className="mt-0.5 text-sm font-medium text-ink-900">{toast.title}</p>
          {toast.description ? (
            <p className="mt-1 text-sm leading-relaxed text-ink-500">{toast.description}</p>
          ) : null}

          {/*
            The address, in a box that can be selected, with the copy shortcut beside it. Outside the
            two paragraphs above rather than inside one of them: a live region reads its text, and an
            input's VALUE is not text a polite announcement picks up — the `title` has to stand alone
            regardless, which is the rule at the top of this file.
          */}
          {toast.link ? (
            <CopyLinkRow
              value={toast.link.url}
              label={toast.link.label}
              openable={toast.link.openable ?? false}
              className="mt-2.5"
            />
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => onDismiss(id)}
          // Named, because several toasts can be on screen and "Dismiss" three times over tells a
          // screen-reader user nothing about which one they are on.
          aria-label={`Dismiss notice: ${toast.title}`}
          className="-mr-1 -mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-500 transition hover:bg-surface-100 hover:text-ink-900"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
    </motion.li>
  );
}
