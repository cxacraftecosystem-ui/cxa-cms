"use client";

/**
 * CopyButton and CopyLinkRow — handing a long, unguessable address to somebody else.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE CLIPBOARD IS OFTEN NOT THERE, AND IS NOT RELIABLE WHEN IT IS.
 *
 * `navigator.clipboard` is `undefined` on any origin the browser does not treat as secure — which is
 * every plain `http://` deployment of this CMS, and the LAN address (`http://192.168.…`) a colleague
 * opens the studio on to look at it on their own machine. Where the object DOES exist, `writeText()`
 * still rejects with a `NotAllowedError` when the document is not focused: press the button, click
 * into the mail window before the promise settles, and the write never happens.
 *
 * Both are handled, and both are SAID OUT LOUD. A copy button that silently does nothing is worse
 * than no copy button at all, because the reader walks away believing they are holding the link and
 * pastes whatever was on the clipboard before it — which, for the password link this component was
 * built for, is a message to a colleague containing somebody else's shopping list and no way in.
 *
 * SO THE SELECTABLE BOX IS THE REAL AFFORDANCE AND THE BUTTON IS THE SHORTCUT. `CopyLinkRow` always
 * renders a read-only input holding the whole address, which selects itself on focus and works by
 * keyboard and with a screen reader whatever the clipboard is doing. Where a caller already has such
 * a box on screen, `CopyButton` alone is the right piece, and its refusal sentence points at it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE ACCESSIBLE NAME CARRIES THE STATE: "Copy link" → "Copied" → "Could not copy". `Button` already
 * wraps its children in a polite live region (Button.tsx), so the swap is announced without a second
 * region here — and the word, not the tick glyph, is what a reader who cannot see the button receives.
 *
 * "Copied" RESETS AFTER `COPIED_RESET_MS`; "Could not copy" DOES NOT. The success has done its work in
 * two seconds and a button stuck on "Copied" lies about the next press. The failure is the only record
 * the reader has that the press did nothing, and a button that quietly goes back to offering "Copy
 * link" is exactly the silent failure this component exists to prevent. It clears on the next attempt,
 * which is the one event that makes it out of date.
 *
 * NOTHING HERE RAISES A TOAST, deliberately. This is rendered INSIDE a toast (Toast.tsx), and a toast
 * raised from within one queues behind the card the reader is already looking at — the confirmation
 * would arrive after the thing it confirms had gone. It also means `CopyButton` works with no
 * ToastProvider above it at all.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink, TriangleAlert, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Button,
  LinkButton,
  type ButtonSize,
  type ButtonVariant
} from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

/** Long enough to read the word, short enough that the button is telling the truth again soon. */
export const COPIED_RESET_MS = 2500;

type CopyState = "idle" | "copied" | "failed";

/** Icon per state. The word beside it is the signal; this is the second copy of it (contract §11). */
const STATE_ICON: Record<CopyState, LucideIcon> = {
  idle: Copy,
  copied: Check,
  failed: TriangleAlert
};

/**
 * Write to the clipboard, or throw.
 *
 * The guard is `!navigator.clipboard` rather than a `window.isSecureContext` test, because the two
 * disagree in the direction that matters: a browser can expose the object and still refuse the write.
 * The only honest question is whether the call succeeds. Same shape as `components/site/ShareRow.tsx`.
 */
async function writeToClipboard(value: string): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard) {
    throw new Error("This browser does not offer the clipboard to this page.");
  }
  await navigator.clipboard.writeText(value);
}

export interface CopyButtonProps {
  /** The exact text put on the clipboard. Not trimmed, not re-encoded — what you pass is what is copied. */
  value: string;
  /**
   * The resting label, and therefore the accessible name. Say what is being copied when more than one
   * copyable thing is on screen: "Copy the password link".
   */
  label?: string;
  /** The label while the copy is fresh. See the header for why it resets and the refusal does not. */
  copiedLabel?: string;
  failedLabel?: string;
  /**
   * What to do instead, shown when the clipboard refuses. It must name a route the reader actually
   * has — the default assumes a selectable box beside the button, which is what `CopyLinkRow` gives.
   */
  fallbackHint?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}

export function CopyButton({
  value,
  label = "Copy link",
  copiedLabel = "Copied",
  failedLabel = "Could not copy",
  fallbackHint = "Your browser would not let this page use the clipboard. Select the address and copy it by hand.",
  variant = "secondary",
  size = "sm",
  className
}: CopyButtonProps) {
  const [state, setState] = useState<CopyState>("idle");
  /**
   * Counts attempts, and keys the refusal below so a second failure remounts the region and is
   * announced again — the same device `StatusControl` uses for a refused status. A screen reader will
   * not read a region whose contents have not changed, and a reader who pressed the same button twice
   * and heard nothing the second time has been told the control is broken.
   */
  const [attempt, setAttempt] = useState(0);
  const timer = useRef<number | null>(null);

  // Cleared on unmount so no `setState` lands in a tree that has gone. This is not theoretical here:
  // the component's usual home is a toast that dismisses itself on a countdown of its own, and with a
  // 5-second toast and a 2.5-second reset the toast wins the race whenever the reader presses late.
  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback(async () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setAttempt((count) => count + 1);

    try {
      await writeToClipboard(value);
      setState("copied");
      timer.current = window.setTimeout(() => setState("idle"), COPIED_RESET_MS);
    } catch {
      // The thrown message is deliberately discarded. A DOMException says "Document is not focused",
      // which names the browser's difficulty rather than the reader's next move; `fallbackHint` names
      // the move, and that is the only thing worth putting on screen.
      setState("failed");
    }
  }, [value]);

  const word = state === "copied" ? copiedLabel : state === "failed" ? failedLabel : label;

  return (
    <span className={cn("inline-flex min-w-0 flex-col items-start gap-1.5", className)}>
      <Button variant={variant} size={size} icon={STATE_ICON[state]} onClick={() => void copy()}>
        {word}
      </Button>

      {/*
        `role="alert"` rather than a polite region: the reader has just pressed a control and it did
        not do what it says on it, which is the one case that warrants interrupting them. The button's
        own live region has already carried the short word; this carries what to do about it.
      */}
      {state === "failed" ? (
        <span key={attempt} role="alert" className="text-xs leading-relaxed text-error-600">
          {fallbackHint}
        </span>
      ) : null}
    </span>
  );
}

export interface CopyLinkRowProps {
  /** The whole address, exactly as it should be pasted. */
  value: string;
  /**
   * Names the box for a screen reader — "Public address of this page". It is NOT drawn: the sentence
   * above the row is what a sighted reader has, and a visible second label would repeat it.
   */
  label: string;
  /**
   * Adds an Open button beside Copy. Off by default — plenty of copyable strings (a one-off password
   * link that is spent the moment it is followed) must NOT be offered as something to click.
   */
  openable?: boolean;
  openLabel?: string;
  copyLabel?: string;
  className?: string;
}

/**
 * The address in a box you can select, with the shortcut beside it.
 *
 * The box is first in the tab order on purpose: it is the route that always works, so a keyboard
 * reader meets it before the button that may refuse.
 */
export function CopyLinkRow({
  value,
  label,
  openable = false,
  openLabel = "Open it",
  copyLabel = "Copy link",
  className
}: CopyLinkRowProps) {
  return (
    <div className={cn("min-w-0 space-y-2", className)}>
      <Input
        readOnly
        value={value}
        aria-label={label}
        // Selecting on focus is the whole point of the box: it puts the address under the reader's own
        // copy shortcut in one keystroke, with no clipboard permission involved at any point.
        onFocus={(event) => event.currentTarget.select()}
        className="font-mono text-xs"
      />

      <div className="flex flex-wrap items-start gap-2">
        <CopyButton
          value={value}
          label={copyLabel}
          fallbackHint="The clipboard was refused. The address is in the box above — select it and copy it by hand."
        />

        {openable ? (
          <LinkButton href={value} variant="ghost" size="sm" icon={ExternalLink} newTab>
            {openLabel}
          </LinkButton>
        ) : null}
      </div>
    </div>
  );
}
