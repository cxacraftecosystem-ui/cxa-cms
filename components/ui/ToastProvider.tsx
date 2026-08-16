"use client";

/**
 * ToastProvider — the toast queue and the one live region the whole product announces through.
 *
 * MOUNTED EXACTLY ONCE, in app/layout.tsx. A nested second provider renders a second `aria-live`
 * region and a screen reader reads every notice twice.
 *
 * ⚠ `aria-live="polite"` NEVER INTERRUPTS. The reader finishes the sentence it is on and only then
 * reads the toast; if they navigate away first it may never be read at all. **A toast is therefore
 * the wrong home for anything the user must act on.** Confirmations, expired sessions and destructive
 * warnings need a dialog, which takes focus and will not proceed without an answer. The one control a
 * toast may hold is `link` — a published address with a copy button — and the argument for why that
 * stays inside this rule (it is a shortcut to something the record's own screen also shows, never the
 * only copy of anything) is set out at length in Toast.tsx. Read it before adding a second kind.
 *
 * THE VIEWPORT RENDERS EVEN WHEN EMPTY, AND THAT IS THE POINT. Assistive technology only announces
 * mutations inside a live region that ALREADY EXISTED when the mutation happened. A region mounted
 * at the same moment as its first child is announced by nothing — the most common way a toast system
 * ends up silent for exactly the people it was built for. `aria-atomic="false"` so an arriving toast
 * is read on its own rather than re-reading the two still on screen.
 *
 * OVERFLOW IS A QUEUE, NOT A CULL. At most MAX_VISIBLE cards are on screen; the rest wait and mount
 * — timer and all — as slots free. Dropping the overflow would mean a burst of five notices silently
 * loses two, which is precisely the "a list that quietly stops" failure in contract §1.6. FIFO,
 * because pre-empting a card someone is halfway through reading is worse than making them wait.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { AnimatePresence } from "framer-motion";

import { cn } from "@/lib/utils";
import {
  DEFAULT_DURATION,
  LINKED_DURATION,
  Toast,
  type ToastOptions,
  type ToastRecord
} from "@/components/ui/Toast";

/** Three is the most a reader can take in before the first one times out. */
export const MAX_VISIBLE = 3;

export interface ToastContextValue {
  /** Queues a notice and returns its id, so a long-running job can dismiss its own progress card. */
  toast: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

/**
 * A NAMED error. A silent `undefined` here turns `toast(...)` into a crash inside an event handler
 * with no indication that the missing piece is a provider several files away.
 */
export class ToastContextError extends Error {
  constructor() {
    super(
      "useToast() was called outside ToastProvider. Mount ToastProvider once in app/layout.tsx, above every component that raises a notice."
    );
    this.name = "ToastContextError";
  }
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<ToastRecord[]>([]);
  const nextId = useRef(0);

  // Both are stable for the life of the provider: `Toast`'s countdown effect lists `onDismiss` in
  // its dependencies, and an identity that changed every render would restart the timer every render.
  const dismiss = useCallback((id: string) => {
    setQueue((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback((options: ToastOptions) => {
    nextId.current += 1;
    const id = `toast-${nextId.current}`;
    const record: ToastRecord = {
      id,
      title: options.title,
      description: options.description,
      tone: options.tone ?? "info",
      // A notice carrying a link is asking the reader to REACH for something, not only to read it, so
      // it gets the longer countdown by default (Toast.tsx, LINKED_DURATION). An explicit `duration`
      // still wins — a caller who says 0 means "leave it until it is dismissed" either way.
      duration: options.duration ?? (options.link ? LINKED_DURATION : DEFAULT_DURATION),
      link: options.link
    };
    setQueue((current) => [...current, record]);
    return id;
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ toast, dismiss }), [toast, dismiss]);

  const visible = queue.slice(0, MAX_VISIBLE);
  const waiting = queue.length - visible.length;

  return (
    <ToastContext.Provider value={value}>
      {children}

      <ol
        aria-live="polite"
        aria-atomic="false"
        // Safari drops list semantics from a list with `list-style: none`; the explicit role keeps
        // "list, 2 items" in the announcement.
        role="list"
        className={cn(
          "pointer-events-none fixed bottom-0 right-0 z-[110] flex w-full max-w-sm list-none flex-col gap-2.5",
          // `pointer-events-none` on the column and `pointer-events-auto` on each card, so an empty
          // viewport does not swallow clicks on the bottom-right corner of every page.
          "[--toast-inset:1rem] sm:[--toast-inset:1.5rem]",
          "pb-[var(--toast-inset)] pl-[var(--toast-inset)]"
        )}
        // Fixed chrome cannot inherit the padding the scroll lock puts on <body>, so it pays the
        // vanished scrollbar back itself (contract §6). Written inline rather than as `.overlay-frame`
        // because `cn()` is a plain join: the `pl-*`/`pb-*` utilities above would out-specify a
        // @layer components recipe and the gutter would silently do nothing.
        style={{ paddingRight: "calc(var(--toast-inset) + var(--scroll-gutter, 0px))" }}
      >
        <AnimatePresence initial={false}>
          {visible.map((item) => (
            <Toast key={item.id} toast={item} onDismiss={dismiss} />
          ))}
        </AnimatePresence>

        {waiting > 0 ? (
          // Stated on screen, per contract §1.6 — a stack that stops at three is otherwise
          // indistinguishable from three being all there were. `aria-hidden` because each queued
          // notice announces itself when it arrives; announcing the counter as well would say the
          // same thing twice.
          <li
            aria-hidden="true"
            className="pointer-events-none rounded-md border border-line-200 bg-surface-50 px-3 py-1.5 text-xs text-ink-500"
          >
            {waiting === 1 ? "1 more notice is waiting" : `${waiting} more notices are waiting`}
          </li>
        ) : null}
      </ol>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (value === null) throw new ToastContextError();
  return value;
}
