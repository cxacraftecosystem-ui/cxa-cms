"use client";

/**
 * ConfirmProvider — `const confirm = useConfirm(); if (await confirm({ … })) …`
 *
 * A promise-shaped confirmation, so a handler reads as one straight line instead of being split
 * across a piece of state, a callback and a second handler that has to remember what it was doing.
 *
 * ⚠ EVERY PATH SETTLES THE PROMISE, INCLUDING THE ONES THAT LOOK LIKE THEY DO NOT.
 *
 *   • A superseded request resolves `false`. Two confirms cannot be on screen at once, so the first
 *     one's `await` would otherwise never return.
 *   • Unmounting the provider resolves every outstanding request `false`.
 *
 * An `await` that can never settle is a handler frozen forever, with no error, no toast and nothing
 * on screen to explain why the button stopped working. `false` is the safe answer in both cases: it
 * means "the reader did not agree", which is exactly what happened.
 *
 * MOUNT IT ONCE, in app/studio/layout.tsx. A second, nested provider takes over `useConfirm()` for
 * everything below it and renders its own dialog — which, having been given the same z-index as the
 * surface that raised it and portalled from a different place in the tree, can appear BEHIND the
 * dialog asking the question. The reader sees a frozen screen and a modal they cannot reach. There is
 * one provider, at the top, and the z-index below is chosen by counting the dialogs already open.
 *
 * `requireTyping` is for a genuinely irreversible action — emptying the recycle bin, purging bytes
 * that no restore can bring back. Typing the item's name is friction on purpose: it makes the answer
 * a decision rather than a reflex.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode
} from "react";

import { cn } from "@/lib/utils";
import { Dialog, DIALOG_Z, STACKED_DIALOG_Z, type DialogTone } from "@/components/ui/Dialog";

export interface ConfirmOptions {
  /** The question, as a sentence. "Delete this publication?" — not "Are you sure?". */
  title: string;
  /** What will happen, and whether it can be undone. Rendered under the title. */
  body?: ReactNode;
  /** Name the action: "Delete", "Publish", "Purge" — never "OK", which answers nothing. */
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * Defaults to "danger" — `alertdialog`, focus on Cancel, no backdrop dismiss. Most confirmations in
   * a CMS are destructive, and the cost of asking a reversible question too carefully is nil. Pass
   * "default" for a question that only needs an answer, such as leaving a page with unsaved work.
   */
  tone?: DialogTone;
  /**
   * The exact text the reader must type before Confirm will act — normally the item's own name.
   * Reserved for actions with no undo.
   */
  requireTyping?: string;
  /** Overrides the automatic rung. Only needed if a confirm is raised from somewhere unusual. */
  zIndex?: number;
}

export type ConfirmFunction = (options: ConfirmOptions) => Promise<boolean>;

/** A named error: a silent `undefined` here turns `confirm(...)` into "not a function" three files away. */
export class ConfirmContextError extends Error {
  constructor() {
    super(
      "useConfirm() was called outside ConfirmProvider. Mount ConfirmProvider once in app/studio/layout.tsx, above every screen that asks for a confirmation."
    );
    this.name = "ConfirmContextError";
  }
}

const ConfirmContext = createContext<ConfirmFunction | null>(null);

interface PendingRequest {
  options: ConfirmOptions;
  resolve: (answer: boolean) => void;
  zIndex: number;
}

/** The top of the stacked range in the ladder (contract §6). Past this, dialogs share a rung. */
const MAX_STACKED_Z = 108;

function resolveZIndex(previous: PendingRequest | null, override: number | undefined): number {
  if (override !== undefined) return override;
  // Superseding our own open confirm: stay on the rung we already occupy, or the replacement would
  // climb one step every time it is replaced.
  if (previous) return previous.zIndex;
  const openDialogs = document.querySelectorAll("[data-dialog]").length;
  if (openDialogs === 0) return DIALOG_Z;
  return Math.min(STACKED_DIALOG_Z + openDialogs - 1, MAX_STACKED_Z);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<PendingRequest | null>(null);
  const [typed, setTyped] = useState("");

  // The ref, not the state, is the authority on what is outstanding: `settle` is called from event
  // handlers and from an unmount cleanup, and neither can read a fresh `request` from a closure.
  const pending = useRef<PendingRequest | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const inputId = useId();
  const hintId = useId();

  const settle = useCallback((answer: boolean) => {
    const current = pending.current;
    pending.current = null;
    setRequest(null);
    setTyped("");
    current?.resolve(answer);
  }, []);

  const confirm = useCallback<ConfirmFunction>(
    (options) =>
      new Promise<boolean>((resolve) => {
        const previous = pending.current;
        pending.current = null;
        previous?.resolve(false);

        const next: PendingRequest = {
          options,
          resolve,
          zIndex: resolveZIndex(previous, options.zIndex)
        };
        pending.current = next;
        setTyped("");
        setRequest(next);
      }),
    []
  );

  useEffect(
    () => () => {
      const current = pending.current;
      pending.current = null;
      current?.resolve(false);
    },
    []
  );

  const options = request?.options;
  const tone = options?.tone ?? "danger";
  const requireTyping = options?.requireTyping;
  // Case and surrounding space are forgiven: the ceremony is what makes this a decision, and a reader
  // who typed the right name with a capital letter has already made it.
  const typingSatisfied =
    requireTyping === undefined ||
    typed.trim().toLowerCase() === requireTyping.trim().toLowerCase();

  return (
    // `confirm` is stable for the life of the provider, so the context value never changes identity
    // and no consumer re-renders because a confirmation was raised somewhere else.
    <ConfirmContext.Provider value={confirm}>
      {children}

      <Dialog
        open={request !== null}
        onClose={() => settle(false)}
        title={options?.title ?? ""}
        tone={tone}
        size="sm"
        zIndex={request?.zIndex ?? DIALOG_Z}
        // Cancel is the safe answer, so Cancel is where focus starts. `data-dialog-cancel` below says
        // the same thing declaratively; the ref is the belt to its braces.
        initialFocusRef={cancelRef}
        footer={
          <>
            <button
              ref={cancelRef}
              type="button"
              data-dialog-cancel
              onClick={() => settle(false)}
              className="field-button-secondary"
            >
              {options?.cancelLabel ?? "Cancel"}
            </button>
            <button
              type="button"
              // `aria-disabled` rather than `disabled`: a disabled button is unreachable by keyboard,
              // so the reader who cannot press it also cannot tab to it and find out why. This one
              // stays focusable, explains itself through `aria-describedby`, and sends focus to the
              // field it is waiting on.
              aria-disabled={!typingSatisfied}
              aria-describedby={requireTyping !== undefined ? hintId : undefined}
              onClick={() => {
                if (!typingSatisfied) {
                  inputRef.current?.focus();
                  return;
                }
                settle(true);
              }}
              className={cn(
                tone === "danger" ? "field-danger" : "field-button",
                !typingSatisfied && "cursor-not-allowed opacity-60"
              )}
            >
              {options?.confirmLabel ?? "Confirm"}
            </button>
          </>
        }
      >
        {options?.body ? <div className="text-sm leading-relaxed text-ink-700">{options.body}</div> : null}

        {requireTyping !== undefined ? (
          <div className={options?.body ? "mt-4" : undefined}>
            {/*
              A plain <label> is safe here because it wraps nothing but an <input>: a label containing
              a button would forward stray clicks into it and fold its text into the input's
              accessible name (contract §10).
            */}
            {/* Not `.field-label`: that recipe is uppercase, and a name rendered in capitals that the
                reader is being asked to copy is a name rendered wrongly. */}
            <label htmlFor={inputId} className="block text-xs font-medium text-ink-500">
              Type <span className="font-semibold text-ink-900">{requireTyping}</span> to confirm
            </label>
            <input
              ref={inputRef}
              id={inputId}
              type="text"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={hintId}
              className="field-input mt-1.5"
            />
            {/* The reason the button will not act is on screen, not implied by a greyed-out control. */}
            <p id={hintId} className="mt-1.5 text-xs leading-relaxed text-ink-500">
              {typingSatisfied
                ? "The name matches. This cannot be undone."
                : "This cannot be undone. Confirm stays inactive until the name above is typed in full."}
            </p>
          </div>
        ) : null}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFunction {
  const value = useContext(ConfirmContext);
  if (value === null) throw new ConfirmContextError();
  return value;
}
