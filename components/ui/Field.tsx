"use client";

/**
 * Field and FieldBlock — the two form wrappers, and the rule for choosing between them.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ READ THIS BEFORE REACHING FOR EITHER. Getting it wrong produces two bugs that look like
 *   anything but a label.
 *
 * `Field` renders a real `<label>` wrapped around its control. That is the strongest association
 * HTML offers — and a `<label>` does two things people forget:
 *
 *   1. IT FORWARDS A STRAY CLICK to the first labelable control inside it. Put a themed dropdown
 *      (a `<button>` plus a popover) inside a `<label>` and the click that lands on the open menu is
 *      re-dispatched to the trigger: the menu slams shut after one pick, and nothing in the dropdown
 *      code says why.
 *   2. IT FOLDS EVERY NAMED DESCENDANT into the control's accessible name. A help sentence, a
 *      counter and a "Browse…" button inside the label all become part of what a screen reader reads
 *      before the reader has typed a character. `Field` defends its own five parts against this (see
 *      WHERE THE PARTS SIT below), but nothing here can defend against what a CALL SITE puts inside
 *      the label — which is why a button or a second control still belongs in `FieldBlock`.
 *
 * SO: a plain `<input>`, `<textarea>` or native `<select>` → **`Field`**.
 *     Anything containing a button, a dropdown, a file picker, a chip list, a colour swatch or a
 *     second control → **`FieldBlock`**, a `<div>` with an explicit `htmlFor`/`id` pair and no click
 *     forwarding at all.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Both render the same five parts — label, optional "(required)" marker, inline help, a character
 * counter when `maxLength` is set, and an error — and both publish a `FieldContext` so `Input`,
 * `Textarea` and `Select` pick up the id, `aria-describedby`, `aria-invalid` and `maxLength` without
 * the call site wiring four attributes by hand and forgetting one. A CUSTOM control (a combobox, a
 * media picker) must read `useFieldContext()` itself — there is nothing here that can reach into an
 * arbitrary child and attach them.
 *
 * WHERE THE PARTS SIT, AND WHY IT IS NOT SYMMETRICAL. Inside `Field`'s `<label>` there is only the
 * label text, the "(required)" marker and the control; the error, the counter and the counter's live
 * region are siblings AFTER the label, where trap 2 cannot reach them. Help is the one exception,
 * because it has to read between the label and the control and that position belongs to a child of
 * the `<label>` — so help stays inside and is `aria-hidden` instead. Hiding it costs the reader
 * nothing: a node referenced DIRECTLY by `aria-describedby` is still announced when it is hidden, and
 * `describedBy` below names it. What it buys is an input whose accessible name is its label and stays
 * its label: left in the tree, a counter inside the label rewrites the name of the very control being
 * typed into, once per keystroke. (`FieldBlock` hides nothing — its label holds the label text alone.)
 *
 * THE ERROR IS NOT A LIVE REGION. It is wired with `aria-describedby` + `aria-invalid` and left
 * silent, because a form that fails validation on eight fields would otherwise fire eight
 * interruptions in a row and the reader would hear none of them in a useful order. Announcing the
 * failure is the FORM's job: a failed submit must move focus to the first invalid control (or to a
 * summary above the form), at which point this message is read as that control's description.
 *
 * THE PARTS ARE BLOCK-DISPLAY `<span>`s, NOT `<p>`/`<div>`. A `<label>` takes phrasing content only,
 * so a paragraph or a div in the help slot — the one part still inside `Field`'s label — would be
 * invalid HTML. The error and counter keep the same shape even though they now sit outside it, so
 * one shell can go on serving both wrappers.
 */

import { createContext, useContext, useId, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The invalid treatment, shared by every control that composes `.field-input`.
 *
 * The `focus:` twin is load-bearing. `.field-input` sets `focus:border-purple-600` — a class plus a
 * pseudo-class, specificity (0,2,0) — and a plain `border-error-600` utility is (0,1,0), so it LOSES
 * the moment the field is focused and the error border turns purple exactly when the reader is
 * looking at it. Matching the pseudo-class ties the specificity, and utilities are emitted after the
 * components layer, so ours wins on source order.
 */
export const FIELD_INVALID_CLASS =
  "border-error-600 focus:border-error-600 focus:ring-error-600/15";

export interface FieldContextValue {
  /** Put this on the control. `Input`/`Textarea`/`Select` do it for you. */
  controlId: string;
  /** The label element's id, for a composite widget that needs `aria-labelledby` instead. */
  labelId: string;
  /** Space-separated ids of the help, counter and error nodes; undefined when there are none. */
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
  maxLength: number | undefined;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/** Null outside a Field/FieldBlock — a bare `<Input>` is legal, it just wires nothing for you. */
export function useFieldContext(): FieldContextValue | null {
  return useContext(FieldContext);
}

export interface FieldProps {
  /** The visible label. Kept short; explanation belongs in `help`. */
  label: ReactNode;
  children: ReactNode;
  /**
   * The control's id. Generated when omitted — pass it only when the id has to be stable across
   * renders for something outside this component (a `aria-controls`, a deep link, a test hook).
   */
  htmlFor?: string;
  /**
   * Renders the "(required)" marker and sets `aria-required` on the control.
   *
   * ⚠ A field may only be mandatory WHERE IT IS ANSWERABLE (contract §10). A required closed list
   * whose options failed to load blocks the submit with no way forward — stand the requirement down
   * rather than leaving the reader stuck.
   */
  required?: boolean;
  /** One plain sentence under the label. Read out as the control's description. */
  help?: ReactNode;
  /** The validation message. Empty string and null both mean "no error". */
  error?: string | null;
  /** Enforced on the control AND counted below it, from this one number so they cannot disagree. */
  maxLength?: number;
  /** The current value. Required for the counter — without it there is nothing to count. */
  value?: string;
  /** Keeps the label for screen readers and voice control but takes it off the screen. */
  hideLabel?: boolean;
  /** Applies to the outer wrapper `<div>` — the layout handle, in both wrappers alike. */
  className?: string;
}

interface FieldShell {
  context: FieldContextValue;
  requiredMark: ReactNode;
  help: ReactNode;
  footer: ReactNode;
}

/**
 * The shared body of both wrappers. Everything except which element does the wrapping.
 *
 * `helpInsideLabel` says whether the caller renders `help` as a child of a real `<label>` — `Field`
 * does, `FieldBlock` does not. Only that case hides help from the accessibility tree, and only to keep
 * it out of the control's accessible name; see WHERE THE PARTS SIT in the header.
 */
function useFieldShell(
  { htmlFor, required = false, help, error, maxLength, value }: FieldProps,
  { helpInsideLabel }: { helpInsideLabel: boolean }
): FieldShell {
  const uid = useId();
  const controlId = htmlFor ?? `${uid}control`;
  const labelId = `${uid}label`;
  const helpId = `${uid}help`;
  const counterId = `${uid}counter`;
  const errorId = `${uid}error`;

  const message = typeof error === "string" ? error.trim() : "";
  const hasError = message.length > 0;

  // Counted in UTF-16 code units, deliberately, because that is what the browser's own `maxLength`
  // enforces. Counting code points would read "119 of 120" while the input silently refused the
  // next keystroke, and a counter that disagrees with the enforcement is worse than no counter.
  const counter =
    typeof maxLength === "number" && maxLength > 0 && typeof value === "string"
      ? { used: value.length, limit: maxLength, full: value.length >= maxLength }
      : null;

  const describedBy =
    [help ? helpId : null, counter ? counterId : null, hasError ? errorId : null]
      .filter((id): id is string => id !== null)
      .join(" ") || undefined;

  const requiredMark = required ? (
    // `aria-hidden`, because `aria-required` on the control already carries this fact to assistive
    // technology. Leaving the marker in the accessible name makes it read "Title (required),
    // required, edit text". The marker is for eyes; the attribute is for the tree.
    <span aria-hidden="true" className="normal-case text-ink-500">
      (required)
    </span>
  ) : null;

  const helpNode = help ? (
    <span
      id={helpId}
      // ⚠ Hidden ONLY where this span is a child of a `<label>`, and never at the cost of the
      // sentence: `describedBy` above names this id directly, and a directly named node is read out
      // as the description whether or not it is hidden. Left in the tree it would ALSO be swallowed
      // by the label — the same sentence twice, once as the control's name and once as its
      // description, with the name the reader needs buried in front of it.
      aria-hidden={helpInsideLabel ? "true" : undefined}
      className="mt-1 block text-xs leading-relaxed text-ink-500"
    >
      {help}
    </span>
  ) : null;

  const footer =
    hasError || counter ? (
      <span className="mt-1.5 flex items-start justify-between gap-3">
        <span className="min-w-0 flex-1">
          {hasError ? (
            <span id={errorId} className="flex items-start gap-1.5 text-sm text-error-600">
              {/* Icon AND word: colour alone never carries the signal (contract §11). */}
              <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{message}</span>
            </span>
          ) : null}
        </span>

        {counter ? (
          <>
            <span
              id={counterId}
              className={cn(
                "shrink-0 text-xs tabular-nums",
                counter.full ? "text-error-600" : "text-ink-500"
              )}
            >
              {counter.used} of {counter.limit} characters
            </span>
            {/*
              Reaching the limit is a SILENT failure: the browser simply stops accepting keystrokes.
              This region is mounted from the first render (so it is registered before its content
              ever changes) and holds one sentence that appears exactly once, when the limit is hit.
              The visible counter above is deliberately NOT live — a region that changed on every
              keystroke would talk over the typing it is describing.
            */}
            <span role="status" className="sr-only">
              {counter.full ? "Character limit reached." : ""}
            </span>
          </>
        ) : null}
      </span>
    ) : null;

  return {
    context: { controlId, labelId, describedBy, invalid: hasError, required, maxLength },
    requiredMark,
    help: helpNode,
    footer
  };
}

/**
 * A `<label>` wrapped around one plain control.
 *
 * ⚠ NOT for anything containing a button or a custom dropdown — see the header. Not for a Checkbox
 * or Switch either: those carry their own label, and nesting one here gives the control two.
 */
export function Field(props: FieldProps) {
  const { label, children, className, hideLabel = false } = props;
  const shell = useFieldShell(props, { helpInsideLabel: true });

  return (
    <FieldContext.Provider value={shell.context}>
      {/*
        A `<div>` around the `<label>` rather than the label doing the wrapping itself: the error and
        the counter belong AFTER the label, out of reach of trap 2, and something has to hold them.
        `className` lands on the div and the label inside it is full width, so the pair lays out as
        one block exactly as a lone label did.
      */}
      <div className={cn("block", className)}>
        <label htmlFor={shell.context.controlId} id={shell.context.labelId} className="block">
          <span className={cn("field-label flex items-center gap-1.5", hideLabel && "sr-only")}>
            {label}
            {shell.requiredMark}
          </span>
          {shell.help}
          <span className="mt-2 block">{children}</span>
        </label>
        {shell.footer}
      </div>
    </FieldContext.Provider>
  );
}

/**
 * A `<div>` whose label points at the control by id.
 *
 * The association is explicit rather than structural, so there is no click forwarding: a click on
 * the label reaches the control once (opening a dropdown, focusing an input) and a click inside a
 * popover stays where it landed. Composite widgets built from `<div>`s cannot be targeted by
 * `htmlFor` at all — those read `labelId` off `useFieldContext()` and set `aria-labelledby`.
 */
export function FieldBlock(props: FieldProps) {
  const { label, children, className, hideLabel = false } = props;
  const shell = useFieldShell(props, { helpInsideLabel: false });

  return (
    <FieldContext.Provider value={shell.context}>
      <div className={cn("block", className)}>
        <label
          htmlFor={shell.context.controlId}
          id={shell.context.labelId}
          className={cn("field-label flex items-center gap-1.5", hideLabel && "sr-only")}
        >
          {label}
          {shell.requiredMark}
        </label>
        {shell.help}
        <div className="mt-2">{children}</div>
        {shell.footer}
      </div>
    </FieldContext.Provider>
  );
}
