"use client";

/**
 * Dialog — the modal surface. Portalled to `<body>`, focus-trapped, Escape-closed, focus-restoring.
 *
 * Nothing is installed to do this for us (no Radix, no Headless UI) and nothing may be added, so the
 * whole accessibility contract of §11 is here in one file. The pieces that are not obvious:
 *
 * THE KEY HANDLER IS BOUND TO THE WINDOW, IN CAPTURE — not to the panel. A panel-bound `onKeyDown`
 * only sees keys pressed while focus is inside the panel, and focus escapes more often than one
 * expects: a click on the backdrop, an autofocus that lost its element, a control that removed itself.
 * Escape has to work from wherever focus actually is. Capture, because a control on the page that
 * stops propagation must not be able to strand a modal open.
 *
 * ONLY THE TOPMOST DIALOG REACTS. Two dialogs both bind to the window in the same phase, and
 * `stopPropagation()` does NOT stop another listener on the SAME target — so a stack is the only way
 * to keep one Escape from closing two dialogs. A dialog that is NOT dismissable still calls
 * `preventDefault()` and `stopPropagation()` on Escape (contract §14): swallowing the key is the
 * point, otherwise it travels on and closes the dialog underneath the one that refused it.
 *
 * FOCUS RESTORATION USES A DOCUMENT-WIDE `focusin` TRACKER, NOT `document.activeElement` AT OPEN TIME.
 * A trigger very often disables itself in the same handler that opens the dialog ("Delete" becomes
 * "Deleting…"), and the browser drops focus to `<body>` the moment it does. Reading `activeElement`
 * then restores focus to nothing at all. The tracker is retained by every mounted `Dialog`, so the
 * element that was focused BEFORE the click is still on record. Restoration runs on the next
 * `requestAnimationFrame` so it lands after the scroll lock has put the page back where it was.
 *
 * DANGER TONE IS A DIFFERENT COMPONENT IN ALL BUT NAME: `role="alertdialog"`, the backdrop refuses to
 * dismiss, and initial focus goes to Cancel (any element marked `data-dialog-cancel`) rather than to
 * the first control. No reflex click and no reflex Enter can delete anything.
 *
 * AND A DANGER DIALOG DESCRIBES ITSELF FROM ITS BODY. `alertdialog` owes the reader the alert message
 * itself, not only its title, and a confirm keeps its message in `children` — `description` is the
 * one-line variant most confirms have no room for. So for the danger tone `aria-describedby` names the
 * body as well, which is the difference between "Delete Anita Sharma from the access list?" and being
 * told that the audit trail goes with it and that revoking would not have. It is deliberately NOT done
 * for the default tone: those bodies are whole forms, and announcing a form as a description on open
 * buries the one sentence that mattered.
 *
 * Z-INDEX IS AN INLINE STYLE, NOT A CLASS. The ladder rungs a dialog uses (100, and 105–108 for a
 * dialog opened from inside a dialog) are not stock Tailwind values, and a class name built by
 * interpolating a prop is purged by the content scan (contract §5). The prop exists so a confirm
 * raised from within a dialog can sit above it.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { TriangleAlert, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { DURATION, EASE_OUT, SPRING_LAYOUT, useReducedMotionPreference } from "@/components/motion";
import { useScrollLock } from "@/components/ui/useScrollLock";

export type DialogTone = "default" | "danger";
export type DialogSize = "sm" | "md" | "lg";

/** The ladder rung for an ordinary dialog (contract §6). */
export const DIALOG_Z = 100;
/** The rung for a dialog opened from inside another dialog. 105–108 are reserved for the stack. */
export const STACKED_DIALOG_Z = 105;

export interface DialogProps {
  open: boolean;
  /** Called for Escape, the close button and a backdrop click. Never called for a danger backdrop. */
  onClose: () => void;
  /** Plain sentence-case. It is the dialog's accessible name, so it must stand alone. */
  title: string;
  /**
   * One line of context, announced with the title. Say what will happen, not that it is important.
   *
   * A danger dialog does not need it: its `children` are announced as the description anyway (see the
   * header), so pass this only when there is a single line worth hearing before the body.
   */
  description?: string;
  tone?: DialogTone;
  /** Defaults to 100. Pass STACKED_DIALOG_Z for a dialog opened from inside a dialog. */
  zIndex?: number;
  /** Show the corner close button. Ignored when `dismissable` is false. */
  showClose?: boolean;
  /**
   * False for a dialog that must be answered — a two-factor challenge, an unsaved-changes decision.
   * Escape is still swallowed rather than ignored; see the header.
   */
  dismissable?: boolean;
  /** Wins over every other initial-focus rule. Point it at the safest control, not the keenest one. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  size?: DialogSize;
  /** The action row. Kept out of the scrolling body so the buttons never scroll away. */
  footer?: ReactNode;
  /** Applied to the panel. */
  className?: string;
  children?: ReactNode;
}

const SIZE_CLASS: Record<DialogSize, string> = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl"
};

/**
 * What counts as focusable, in one definition shared by every overlay in this folder.
 *
 * A popover that disagreed with the dialog it lives inside would hand focus to a different "last"
 * element and the two would fight over the end of the tab order.
 */
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    // `getClientRects()` is the "is this actually rendered" test that also works for fixed-position
    // elements, where the more common `offsetParent === null` check reports a false negative.
    (element) => element.getClientRects().length > 0
  );
}

// ─── The document focus tracker ──────────────────────────────────────────────────────────────────
// Module scope, reference counted: every mounted Dialog retains it, the last one to unmount releases
// it. It records the last element to receive focus ANYWHERE, including inside another dialog — which
// is exactly right for a confirm raised from a dialog, whose restore target is the button in the
// dialog beneath it.

let lastFocusedElement: HTMLElement | null = null;
let trackerHolders = 0;

function handleFocusIn(event: FocusEvent): void {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  // Focus landing on the body or the root is the browser giving up, not a place worth returning to.
  if (target === document.body || target === document.documentElement) return;
  lastFocusedElement = target;
}

function retainFocusTracker(): void {
  trackerHolders += 1;
  if (trackerHolders > 1) return;
  document.addEventListener("focusin", handleFocusIn, true);
  const active = document.activeElement;
  // Seed from the current focus, for the case where a Dialog is mounted conditionally at the same
  // moment it opens and there is no earlier focusin to have caught.
  if (active instanceof HTMLElement && active !== document.body) lastFocusedElement = active;
}

function releaseFocusTracker(): void {
  if (trackerHolders === 0) return;
  trackerHolders -= 1;
  if (trackerHolders > 0) return;
  document.removeEventListener("focusin", handleFocusIn, true);
}

// ─── The dialog stack ────────────────────────────────────────────────────────────────────────────

const dialogStack: string[] = [];

export function Dialog(props: DialogProps) {
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setContainer(document.body);
  }, []);

  // Retained by the OUTER component, which is mounted long before `open` flips, so the trigger that
  // opens the dialog is on record by the time it disables itself.
  useEffect(() => {
    retainFocusTracker();
    return releaseFocusTracker;
  }, []);

  if (!container) return null;

  return createPortal(
    // `initial={false}` is deliberately absent: a dialog only ever appears after an interaction, so
    // there is no prerendered first paint for its entrance to disagree with.
    <AnimatePresence>{props.open ? <DialogSurface {...props} /> : null}</AnimatePresence>,
    container
  );
}

function DialogSurface({
  onClose,
  title,
  description,
  tone = "default",
  zIndex = DIALOG_Z,
  showClose = true,
  dismissable = true,
  initialFocusRef,
  size = "md",
  footer,
  className,
  children
}: DialogProps) {
  const reduce = useReducedMotionPreference();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const instanceId = useId();
  const titleId = useId();
  const descriptionId = useId();
  const bodyId = useId();

  // Kept in step with the two render guards below, so nothing is ever named that is not in the
  // document: an `aria-describedby` pointing at a missing id reads as no description at all (§11).
  const describedBy =
    [description ? descriptionId : null, tone === "danger" && children ? bodyId : null]
      .filter((id): id is string => id !== null)
      .join(" ") || undefined;

  // Held for as long as the surface is mounted — which includes the exit animation, so the scrollbar
  // does not come back while the panel is still fading.
  useScrollLock(true);

  const isTopmost = useCallback(
    () => dialogStack[dialogStack.length - 1] === instanceId,
    [instanceId]
  );

  useEffect(() => {
    dialogStack.push(instanceId);
    return () => {
      const index = dialogStack.lastIndexOf(instanceId);
      if (index !== -1) dialogStack.splice(index, 1);
    };
  }, [instanceId]);

  // Capture the restore target on mount and put focus back on unmount. Both halves live in one effect
  // so they cannot get out of step.
  useEffect(() => {
    restoreRef.current = lastFocusedElement;
    return () => {
      const target = restoreRef.current;
      if (!target) return;
      window.requestAnimationFrame(() => {
        // The element may have been removed while the dialog was open — a row that was deleted is the
        // ordinary case, not an edge one.
        if (!target.isConnected) return;
        // `preventScroll`, because the scroll lock has just put the page back where it was and a
        // focus-induced scroll would undo it.
        target.focus({ preventScroll: true });
      });
    };
  }, []);

  // Initial focus. Order: an explicit ref, then Cancel for a danger dialog, then anything the caller
  // marked `data-autofocus`, then the panel itself — which announces the title and description and
  // leaves nothing actionable under a reflex Enter.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    let target: HTMLElement | null = initialFocusRef?.current ?? null;
    if (!target && tone === "danger") target = panel.querySelector<HTMLElement>("[data-dialog-cancel]");
    if (!target && tone !== "danger") target = panel.querySelector<HTMLElement>("[data-autofocus]");
    (target ?? panel).focus({ preventScroll: true });
  }, [initialFocusRef, tone]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Tab") return;
      if (!isTopmost()) return;

      // A popover, menu or combobox portalled out of this dialog owns both keys while it is open: it
      // is visually on top, so Escape must dismiss it first and Tab must move within it.
      if (document.querySelector("[data-floating-layer]") !== null) return;

      if (event.key === "Escape") {
        // Both calls happen even when the dialog refuses to close. Letting the key travel on would
        // close the dialog UNDERNEATH this one (contract §14).
        event.preventDefault();
        event.stopPropagation();
        if (dismissable) onClose();
        return;
      }

      const panel = panelRef.current;
      if (!panel) return;

      const items = focusableWithin(panel);
      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);

      // A dialog with nothing to focus still must not leak focus to the page behind it.
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }

      // "Focus is outside the panel" is treated as "at the far end", so the first Tab after focus has
      // escaped lands back inside rather than continuing through the page behind the modal.
      if (event.shiftKey) {
        if (!inside || active === first || active === panel) {
          event.preventDefault();
          last.focus();
        }
        return;
      }

      if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [dismissable, isTopmost, onClose]);

  const canDismiss = dismissable;
  const backdropDismisses = canDismiss && tone !== "danger";

  return (
    <div
      // `data-dialog` is the hook a Popover uses to discover that it is inside a modal, so it portals
      // into THIS element rather than the body and sits above the panel instead of behind it.
      data-dialog
      data-tone={tone}
      className="fixed inset-0 flex items-center justify-center"
      // Inline, not utilities: `zIndex` is a prop (a template class string would be purged), and the
      // fixed wrapper cannot inherit the padding the scroll lock puts on <body>, so it re-pays the
      // vanished scrollbar itself (contract §6). Written here rather than with `.overlay-frame`
      // because `cn()` is a plain join and the padding utilities would out-specify the recipe.
      style={{
        zIndex,
        padding: "1rem",
        paddingRight: "calc(1rem + var(--scroll-gutter, 0px))"
      }}
    >
      <motion.div
        aria-hidden="true"
        onClick={backdropDismisses ? onClose : undefined}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: reduce ? 0 : DURATION.scrim, ease: EASE_OUT }}
        // A press that begins inside the panel and ends on the backdrop fires its click on the shared
        // ancestor, not on the backdrop — so a text selection dragged past the edge cannot dismiss.
        className={cn(
          "absolute inset-0 bg-ink-900/50 backdrop-blur-sm",
          backdropDismisses ? "cursor-pointer" : "cursor-default"
        )}
      />

      <motion.div
        ref={panelRef}
        // `alertdialog` interrupts the screen reader instead of waiting its turn. Correct here and
        // nowhere else: a destructive question the reader never hears is a destructive question they
        // answer with Enter.
        role={tone === "danger" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
        transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
        className={cn(
          // `relative` and later in DOM order than the backdrop, which is what puts it above without
          // inventing a second z-index inside the dialog's own stacking context.
          "relative flex max-h-[calc(100vh-2rem)] w-full flex-col overflow-hidden rounded-lg border border-line-200 bg-card shadow-cinema outline-none",
          SIZE_CLASS[size],
          className
        )}
      >
        <div className="flex items-start gap-3 border-b border-line-200 px-5 py-4">
          {tone === "danger" ? (
            // The icon is the half of the danger signal that survives a monochrome screen (§11).
            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-error-100 text-error-600">
              <TriangleAlert aria-hidden="true" className="h-4 w-4" />
            </span>
          ) : null}

          <div className="min-w-0 flex-1">
            {/* An h2: a dialog is its own heading context, and h2 leaves room for section headings
                inside the body without skipping a level (contract §11). */}
            <h2 id={titleId} className="font-display text-base font-semibold text-ink-900">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-1 text-sm leading-relaxed text-ink-500">
                {description}
              </p>
            ) : null}
          </div>

          {showClose && canDismiss ? (
            <button
              type="button"
              onClick={onClose}
              // Named with the title: several dialogs can exist in the accessibility tree at once and
              // three identical "Close" buttons tell a screen-reader user nothing.
              aria-label={`Close ${title}`}
              className="-mr-1.5 -mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-500 transition hover:bg-surface-100 hover:text-ink-900"
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
          ) : null}
        </div>

        {children ? (
          <div
            id={bodyId}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 text-sm text-ink-700"
          >
            {children}
          </div>
        ) : null}

        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line-200 bg-surface-50 px-5 py-3">
            {footer}
          </div>
        ) : null}
      </motion.div>
    </div>
  );
}
