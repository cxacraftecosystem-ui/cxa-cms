"use client";

/**
 * PasswordInput — a password box with the reveal ("eye") toggle beside it.
 *
 * A password field that cannot be read back is the reason people pick shorter passwords, paste from
 * a document, or give up and use the one they already have. The toggle is the fix, and it belongs in
 * ONE component: this portal has eight password boxes across three screens, and eight copies of a
 * `useState` plus a positioned button is eight chances to get the label, the padding or the type
 * switch subtly different.
 *
 * ⚠ THE TOGGLE CANNOT LIVE IN `Input`'s `suffix` SLOT, AND `Input.tsx` SAYS SO. `suffix` renders
 * inside `Input`, which inside a `<Field>` is inside a real `<label>` — and a `<label>` re-dispatches
 * a stray click to the first labelable control it contains AND folds every named descendant into that
 * control's accessible name (Field.tsx's header sets out both traps). A reveal button there would be
 * announced as part of the field's name ("Password Show password, edit text") and would fight the
 * input for the click. So the button is a SIBLING of `Input` here, and every call site that uses this
 * component must use `FieldBlock` — a `<div>` with an explicit `htmlFor`, no wrapping label, no
 * forwarding — rather than `Field`.
 *
 * IT OWNS ITS OWN STATE, WHICH IS WHAT MAKES IT USABLE FROM A SERVER COMPONENT. `app/studio/account`
 * is a Server Component (it reads prisma, cookies and headers), and a Server Component cannot hand a
 * function across the boundary — `Input.tsx` documents the 500 that shipped when one tried. Nothing
 * here needs an `onChange` or a setter from the caller, so `<PasswordInput name="current" required />`
 * works unchanged from a server file: every prop it needs is a string or a boolean.
 *
 * FIRST PAINT IS ALWAYS THE HIDDEN STATE. `useState(false)` is the same answer on the server as on the
 * client, so the prerendered HTML and the first client render agree — nothing here is read from
 * storage or from a media query, which would hydrate into a mismatch.
 *
 * ⚠ `tabIndex={-1}` IS DELIBERATE. Without it the button sits between the password field and the
 * submit button, so every keyboard sign-in becomes Tab, Tab, Enter — and the reader who tabs once out
 * of habit lands on "Show password" and presses Enter, which reveals the password instead of signing
 * in. The toggle stays reachable by pointer, by touch, and by a screen reader's virtual cursor, which
 * is where it is actually used. It is a convenience for checking what was typed, never the only route
 * through the form: the field can be completed and submitted without it.
 *
 * WHAT A SCREEN READER HEARS. `aria-pressed` carries the STATE and the name carries the ACTION, so
 * the two do not restate one another: "Show password, toggle button, not pressed" becomes "Hide
 * password, toggle button, pressed".
 *
 * Keeping both is a considered compromise, not an oversight — a name describing the next action
 * beside a state describing the present one can be heard as contradicting itself. Dropping either is
 * worse. Without `aria-pressed`, somebody who arrives at the button (or comes back to the form later)
 * is told nothing about whether their password is currently on screen — which on a shared or
 * screen-shared machine is the one fact that matters. With a FIXED name, the button never says what
 * pressing it will achieve.
 *
 * There is no live region: the button takes focus when it is clicked, so its new name is announced
 * already, and a `role="status"` alongside would say the same thing a second time.
 */

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

import { cn } from "@/lib/utils";
import { Input, type InputProps } from "@/components/ui/Input";

export interface PasswordInputProps extends Omit<InputProps, "type" | "suffix"> {
  /**
   * What the button's accessible name calls this field: `subject="your new password"` gives "Show
   * your new password" / "Hide your new password".
   *
   * Defaults to "password", which is right for a screen with ONE password box. Pass something
   * distinguishing where a screen has more than one — `app/studio/account` has five, and five buttons
   * all named "Show password" leave a reader listing the page's buttons with no way to tell which
   * field each belongs to, and leave a voice-control user with an ambiguous target.
   */
  subject?: string;
}

export function PasswordInput({
  subject = "password",
  className,
  disabled,
  ...rest
}: PasswordInputProps) {
  const [revealed, setRevealed] = useState(false);
  const Glyph = revealed ? EyeOff : Eye;

  return (
    // Positions the button; `Input` brings its own `relative` wrapper for the leading glyph, and this
    // one has the same box, so `top-1/2` centres on the input either way.
    <span className="relative block">
      <Input
        type={revealed ? "text" : "password"}
        // ⚠ THESE THREE ARE FOR THE REVEALED STATE. A `type="password"` input is exempt from
        // autocapitalisation, autocorrection and spell-checking; the moment it becomes `type="text"`
        // a phone keyboard treats it as prose again and capitalises the first letter of the password
        // being typed. Set here rather than at the call sites so the eight boxes cannot disagree, and
        // before the spread so a caller can still override one.
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        disabled={disabled}
        {...rest}
        className={cn(
          // The eye is 40px wide and inset by 4px, so 44px has to be kept clear and `pr-12` (48px) is
          // the nearest step above that. `.field-input` pays 14px of right padding on its own, which
          // would leave the end of a long password sitting underneath the button.
          //
          // It arrives as `className`, i.e. AFTER `field-input` in the string — which decides nothing
          // (contract §5: `cn` is a plain join). It wins because `.field-input` lives in the
          // components layer and `pr-12` is a utility, and utilities are emitted afterwards. The same
          // mechanism `Input` itself relies on for `pl-10`.
          "pr-12",
          // ⚠ Edge draws its OWN reveal button on every password input (`::-ms-reveal`), so without
          // this the box shows two eyes side by side that disagree about state — Edge's tracks a
          // press-and-hold, ours a toggle.
          "[&::-ms-reveal]:hidden",
          className
        )}
      />

      <button
        // ⚠ `type` is explicit because this always sits inside a `<form>`: a `<button>` with no type
        // is a SUBMIT button, so the first press of the eye would post the half-filled sign-in form.
        type="button"
        onClick={() => setRevealed((current) => !current)}
        aria-pressed={revealed}
        aria-label={revealed ? `Hide ${subject}` : `Show ${subject}`}
        tabIndex={-1}
        // Frozen with the field it belongs to. A live control beside a disabled input reads as a
        // half-broken form, and revealing a password mid-submit is not something to invite.
        disabled={disabled}
        className="absolute right-1 top-1/2 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-md text-ink-500 transition hover:bg-surface-100 hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Glyph aria-hidden="true" className="h-4 w-4" />
      </button>
    </span>
  );
}
