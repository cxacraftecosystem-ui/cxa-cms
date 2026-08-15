"use client";

/**
 * UnsavedChangesProvider + useLeaveGuard — "you have not saved this yet".
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * TWO WAYS OUT OF A PAGE, AND THEY NEED TWO DIFFERENT MECHANISMS.
 *
 *   • A REAL UNLOAD — closing the tab, reloading, typing a new address, following a link to another
 *     site. Only the browser can stop that, through `beforeunload`, and it shows its own wording; a
 *     custom message has been ignored by every browser since 2016 and cannot be supplied.
 *   • AN IN-APP NAVIGATION — clicking a link in the studio sidebar. No unload happens at all, so
 *     `beforeunload` never fires and the editor is simply gone. This is the common case and the one
 *     that loses work, so it is intercepted here: a capture-phase click listener spots an internal
 *     link, cancels it, and asks.
 *
 * ⚠ THE BROWSER'S OWN BACK BUTTON CANNOT BE INTERCEPTED, and pretending otherwise is worse than
 * saying so. A client-side back is a `popstate`: it has already happened by the time any listener
 * runs, `beforeunload` does not fire, and the App Router has begun rendering the previous route.
 * "Pushing the URL back" does not re-render the editor — it leaves the address bar and the screen
 * disagreeing, which is a worse failure than the one it was trying to fix. So: links are guarded,
 * unloads are guarded, Back is not. `useAutosave` is the answer to Back — on an unpublished record
 * the work is already on the server four seconds after it was typed.
 *
 * PROGRAMMATIC NAVIGATION IS NOT INTERCEPTED EITHER — a `router.push()` from a button emits no click
 * on a link. A screen that navigates in code calls `confirmLeave()` first, and `allowNextNavigation()`
 * after it has saved.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY THE GUARD IS A REF, WRITTEN IN AN EFFECT WITH NO DEPENDENCY ARRAY.
 *
 * The interceptor is a document listener registered once; it cannot close over React state, because
 * the closure would freeze at the first render and report a form clean for ever. So each guard keeps
 * its `dirty` flag in a ref that the interceptor reads at click time.
 *
 * That ref is written in an EFFECT — never during render — and the effect has NO dependency array, so
 * it runs after EVERY commit. Both halves are load-bearing. A render can be discarded under
 * concurrent rendering (React starts one, abandons it, renders again); a ref written during that
 * render would leave the interceptor reading a `dirty` value from a render that never committed, and
 * it would then either block a navigation from a form the reader never dirtied or wave through one
 * from a form they did. No dependency array, because the comparison React would do for us is exactly
 * the comparison we do not want: the point is to mirror whatever committed, every time.
 *
 * AND THE CLEANUP UNREGISTERS. This is what stops a saved-and-navigated form from blocking the NEXT
 * screen: the editor unmounts, its guard leaves the set, and the list page the reader lands on is not
 * haunted by a dirty flag belonging to a component that no longer exists.
 *
 * THE PROVIDER OWNS ITS OWN DIALOG rather than borrowing `useConfirm()`. It could — the studio layout
 * mounts ConfirmProvider above this one — but then the order of two providers in a layout file would
 * decide whether the whole studio renders, and the wording of this particular question is worth
 * getting exactly right rather than passing through a generic confirm. `tone="default"`, on purpose:
 * ConfirmProvider's own note says a question that merely needs an answer — such as leaving a page with
 * unsaved work — is not a danger confirm. Escape and the backdrop both mean "stay", which is the safe
 * answer.
 *
 * MOUNT IT ONCE, in app/studio/layout.tsx.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from "react";
import { usePathname, useRouter } from "next/navigation";

import { Dialog } from "@/components/ui/Dialog";

/**
 * How long a one-shot pass survives. Long enough for the navigation it was granted for — including a
 * full unload, whose `beforeunload` fires after the current task — and short enough that a stray call
 * cannot leave the page unguarded for the rest of the session.
 */
const ALLOW_WINDOW_MS = 1000;

export interface LeaveAttempt {
  /** How the reader tried to leave. `beforeunload` is not represented — the browser handles that one. */
  kind: "link" | "programmatic";
  /** Where they were going, as an internal path. `null` when the caller did not name a destination. */
  href: string | null;
  /** Continue. Suppresses the guard for one navigation and performs it. */
  proceed: () => void;
  /** Stay put. Present so a custom handler reads symmetrically; doing nothing has the same effect. */
  cancel: () => void;
}

interface GuardState {
  dirty: boolean;
  onBlocked?: (attempt: LeaveAttempt) => void;
}

export interface UnsavedChangesContextValue {
  /** Is anything on screen unsaved right now? A function, not a value — see the note below. */
  isDirty: () => boolean;
  /**
   * Ask, if there is anything to ask about. Resolves true when it is safe to navigate — either because
   * nothing is dirty or because the reader chose to leave. Never rejects.
   *
   * For a screen that navigates in code: `if (await confirmLeave()) router.push(…)`.
   */
  confirmLeave: () => Promise<boolean>;
  /** Suppress the guard for one navigation, for a screen that has just saved and is moving on. */
  allowNextNavigation: () => void;
  /** ⚠ Used by `useLeaveGuard`. Call that instead — it owns the ref and effect discipline. */
  register: (guard: RefObject<GuardState>) => () => void;
}

/** A named error: a silent `undefined` here becomes "not a function" three files from the cause. */
export class UnsavedChangesContextError extends Error {
  constructor() {
    super(
      "useLeaveGuard() / useUnsavedChanges() was called outside UnsavedChangesProvider. Mount UnsavedChangesProvider once in app/studio/layout.tsx, above every editor screen."
    );
    this.name = "UnsavedChangesContextError";
  }
}

const UnsavedChangesContext = createContext<UnsavedChangesContextValue | null>(null);

interface PendingRequest {
  href: string | null;
  resolve: (leave: boolean) => void;
}

/** `/path`, `#anchor` and `?query` are ours; anything else is another origin, a mailto or a tel. */
function isSameOrigin(anchor: HTMLAnchorElement): boolean {
  try {
    return new URL(anchor.href, window.location.href).origin === window.location.origin;
  } catch {
    // An href the URL parser refuses is not something we should be cancelling clicks on.
    return false;
  }
}

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  const [pending, setPending] = useState<PendingRequest | null>(null);

  /**
   * The ref, not the state, is the authority on what is outstanding. `settle` is called from event
   * handlers and from an unmount cleanup, and neither can read a fresh `pending` from a closure.
   */
  const pendingRef = useRef<PendingRequest | null>(null);
  const stayRef = useRef<HTMLButtonElement | null>(null);

  /** Every registered guard, by ref, so the listeners always read what last committed. */
  const guardsRef = useRef(new Set<RefObject<GuardState>>());

  /** One free pass, for the navigation we are about to perform ourselves. */
  const allowOnceRef = useRef(false);
  const allowTimerRef = useRef<number | null>(null);

  const register = useCallback((guard: RefObject<GuardState>) => {
    guardsRef.current.add(guard);
    return () => {
      guardsRef.current.delete(guard);
    };
  }, []);

  const dirtyGuards = useCallback((): GuardState[] => {
    const found: GuardState[] = [];
    guardsRef.current.forEach((guard) => {
      const state = guard.current;
      if (state?.dirty) found.push(state);
    });
    return found;
  }, []);

  const isDirty = useCallback(() => dirtyGuards().length > 0, [dirtyGuards]);

  const allowNextNavigation = useCallback(() => {
    allowOnceRef.current = true;
    if (allowTimerRef.current !== null) window.clearTimeout(allowTimerRef.current);
    allowTimerRef.current = window.setTimeout(() => {
      allowTimerRef.current = null;
      allowOnceRef.current = false;
    }, ALLOW_WINDOW_MS);
  }, []);

  /**
   * EVERY PATH SETTLES THE PROMISE, including the ones that look like they do not — a superseded
   * request and an unmounted provider both resolve `false`. An `await` that can never settle is a
   * handler frozen for ever, with nothing on screen to explain why the button stopped working, and
   * `false` ("the reader did not agree to leave") is the safe answer in both cases.
   */
  const settle = useCallback((leave: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(leave);
  }, []);

  useEffect(
    () => () => {
      const current = pendingRef.current;
      pendingRef.current = null;
      current?.resolve(false);
      if (allowTimerRef.current !== null) window.clearTimeout(allowTimerRef.current);
    },
    []
  );

  const ask = useCallback(
    (href: string | null): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        const previous = pendingRef.current;
        pendingRef.current = null;
        previous?.resolve(false);

        const next: PendingRequest = { href, resolve };
        pendingRef.current = next;
        setPending(next);
      }),
    []
  );

  const confirmLeave = useCallback(async (): Promise<boolean> => {
    if (!isDirty()) return true;

    // A screen that wants to handle this itself gets to. The first dirty guard with a handler wins:
    // two editors open at once is not a situation the studio creates, and picking one beats asking
    // twice about the same navigation.
    const custom = dirtyGuards().find((guard) => guard.onBlocked !== undefined);
    if (custom?.onBlocked) {
      let decided = false;
      return new Promise<boolean>((resolve) => {
        custom.onBlocked?.({
          kind: "programmatic",
          href: null,
          proceed: () => {
            if (decided) return;
            decided = true;
            allowNextNavigation();
            resolve(true);
          },
          cancel: () => {
            if (decided) return;
            decided = true;
            resolve(false);
          }
        });
      });
    }

    const leave = await ask(null);
    if (leave) allowNextNavigation();
    return leave;
  }, [allowNextNavigation, ask, dirtyGuards, isDirty]);

  // ── The real unload ────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (allowOnceRef.current) return;
      if (!isDirty()) return;
      // Both, deliberately: `preventDefault()` is the modern spelling and `returnValue` is what
      // several browsers still look at. The wording is the browser's — ours is ignored.
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  // ── The in-app navigation ──────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      // Somebody nearer the target already handled it. Cancelling on top of that would fight a
      // component that knows more about the click than we do.
      if (event.defaultPrevented) return;
      // Only a plain left click NAVIGATES THIS TAB. A middle click, a right click, Cmd/Ctrl-click and
      // Shift-click all open somewhere else, leaving this page — and its unsaved work — exactly where
      // it is, so blocking them would be pure obstruction.
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      if (allowOnceRef.current) return;
      if (!isDirty()) return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;

      // `target="_blank"` and `download` both leave this page alone.
      if (anchor.target.length > 0 && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;
      // The opt-out, for a link that deliberately must not be guarded (a "Preview" opening in place).
      if (anchor.dataset.allowUnsaved !== undefined) return;
      // Another origin: the browser's own `beforeunload` prompt covers it, and it covers it better.
      if (!isSameOrigin(anchor)) return;

      const url = new URL(anchor.href, window.location.href);
      // An anchor on the page we are already on is not leaving it.
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;

      const href = `${url.pathname}${url.search}${url.hash}`;

      event.preventDefault();
      // Capture phase plus `stopPropagation`, so the router's own click handling never sees it. Without
      // this the navigation happens anyway and the dialog opens over the page we just left.
      event.stopPropagation();

      const custom = dirtyGuards().find((guard) => guard.onBlocked !== undefined);
      const proceed = () => {
        allowNextNavigation();
        router.push(href);
      };

      if (custom?.onBlocked) {
        let decided = false;
        custom.onBlocked({
          kind: "link",
          href,
          proceed: () => {
            if (decided) return;
            decided = true;
            proceed();
          },
          cancel: () => {
            decided = true;
          }
        });
        return;
      }

      void ask(href).then((leave) => {
        if (leave) proceed();
      });
    };

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [allowNextNavigation, ask, dirtyGuards, isDirty, router]);

  // A completed navigation ends the pass. Belt to the timer's braces above.
  useEffect(() => {
    allowOnceRef.current = false;
  }, [pathname]);

  /**
   * The context value is built from callbacks that are all stable for the life of the provider, so its
   * identity never changes. That matters more here than usual: this provider sits above the whole
   * studio, and a value that changed whenever a form became dirty would re-render every screen on
   * every keystroke.
   */
  const value = useMemo<UnsavedChangesContextValue>(
    () => ({ isDirty, confirmLeave, allowNextNavigation, register }),
    [isDirty, confirmLeave, allowNextNavigation, register]
  );

  return (
    <UnsavedChangesContext.Provider value={value}>
      {children}

      <Dialog
        open={pending !== null}
        onClose={() => settle(false)}
        title="Leave without saving?"
        description="This page has changes that have not been saved yet."
        tone="default"
        size="sm"
        // Focus starts on the safe answer, so a reflex Enter keeps the work rather than losing it.
        initialFocusRef={stayRef}
        footer={
          <>
            <button
              ref={stayRef}
              type="button"
              data-dialog-cancel
              onClick={() => settle(false)}
              className="field-button-secondary"
            >
              Stay on this page
            </button>
            <button type="button" onClick={() => settle(true)} className="field-danger">
              Leave without saving
            </button>
          </>
        }
      >
        <p>
          If you leave now, everything you have changed since the last save is lost. There is no way to
          get it back.
        </p>
        {pending?.href ? (
          <p className="mt-2 text-ink-500">
            You were going to <span className="break-all font-medium text-ink-700">{pending.href}</span>.
          </p>
        ) : null}
      </Dialog>
    </UnsavedChangesContext.Provider>
  );
}

export function useUnsavedChanges(): UnsavedChangesContextValue {
  const value = useContext(UnsavedChangesContext);
  if (value === null) throw new UnsavedChangesContextError();
  return value;
}

/**
 * Guard this screen while `dirty` is true.
 *
 *   const autosave = useAutosave({ data, save });
 *   useLeaveGuard(autosave.isDirty);
 *
 * Pass `onBlocked` only if the screen wants to answer the question itself — offering "Save and leave",
 * say. Without it the provider's dialog asks, which is what nearly every screen wants.
 */
export function useLeaveGuard(dirty: boolean, onBlocked?: (attempt: LeaveAttempt) => void): void {
  const context = useContext(UnsavedChangesContext);
  if (context === null) throw new UnsavedChangesContextError();

  const guardRef = useRef<GuardState>({ dirty, onBlocked });

  // NO DEPENDENCY ARRAY, and the write is in the effect rather than in the render — see the header.
  // This is the whole reason the guard is a ref at all.
  useEffect(() => {
    guardRef.current = { dirty, onBlocked };
  });

  // `register` returns its own unregister function, which is exactly the shape an effect destructor
  // wants. The cleanup is what stops this screen guarding the next one.
  useEffect(() => context.register(guardRef), [context]);
}
