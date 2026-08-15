"use client";

/**
 * DeleteButton — a soft delete, always confirmed, and the confirmation says WHERE the item goes.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE QUESTION STATES THE CONSEQUENCE. "Are you sure?" is a question nobody can answer: it asks the
 * reader to weigh something without telling them what is on either side of the scales, so the honest
 * answers are "I don't know" and a reflex click. Every dialog this component raises says what will
 * happen to the item and whether it can be got back:
 *
 *   • recycle → "It will move to the recycle bin, where an administrator can restore it for 30 days."
 *   • purge   → "This removes it and its files for good. Nothing can bring it back."
 *
 * NOTHING USER-FACING IS EVER HARD-DELETED BY THE CMS (schema header). This button's default mode
 * writes `deletedAt` and nothing more; the recycle bin IS `deletedAt IS NOT NULL`, and a purge job is
 * the only writer of a real DELETE. `mode="purge"` exists for the recycle-bin screen, and it defaults
 * to `requireTyping` — typing the item's own name is friction on purpose, because it makes the answer
 * a decision rather than a reflex.
 *
 * THE DIALOG IS DANGER-TONE, WHICH IS NOT A COLOUR. `ConfirmProvider` gives a danger confirm
 * `role="alertdialog"`, puts initial focus on Cancel and refuses a backdrop dismiss, so no reflex
 * click and no reflex Enter can delete anything (contract §11).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * PERMISSION IS THE CALLER'S TO CHECK, AND IT IS CHECKED BY NOT RENDERING THIS. There is no
 * `disabled` prop for a reader who may not delete: a failing permission check renders NOTHING
 * (contract §1.8). Guard the whole component — `{canDelete ? <DeleteButton … /> : null}` — with the
 * same predicate from `lib/permissions.ts` that the route handler enforces. Deleting is stricter than
 * editing, and restoring is stricter again (`canRestoreDeleted` is ADMINISTRATOR).
 *
 * FAILURE IS REPORTED, NOT SWALLOWED. `onDelete` may throw; the message is shown in an error toast
 * verbatim, because `lib/api.ts` guarantees `message` is a plain human sentence ready to render and
 * re-wording it here would only make the two halves of the product disagree about what happened.
 *
 * THE BUTTON DISABLES AND ANNOUNCES WHILE THE DELETE RUNS (`Button`'s `isLoading`), so a second press
 * cannot fire a second request against a row that is already going.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";

import { asApiClientError } from "@/lib/client/fetcher";
import { cn } from "@/lib/utils";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { useToast } from "@/components/ui/ToastProvider";

export type DeleteMode = "recycle" | "purge";

export interface DeleteButtonProps {
  /** The item's own name, printed inside the question. "Bagru dyeing", not "this item". */
  name: string;
  /**
   * What kind of thing it is, LOWER CASE and singular: "publication", "page", "photograph". Used as
   * "Delete publication “Bagru dyeing”?".
   */
  noun?: string;
  /**
   * Performs the delete. Throw to report a failure — the thrown message is shown verbatim.
   * Resolving is taken as success.
   */
  onDelete: () => Promise<void> | void;
  /** Called after a successful delete. Where a caller navigates away or refreshes its list. */
  onDeleted?: () => void;
  /** `purge` is permanent and defaults to requiring the name to be typed. See the header. */
  mode?: DeleteMode;
  /** How long the recycle bin keeps it. Ignored when `mode="purge"`. */
  retentionDays?: number;
  /**
   * Anything else the reader should weigh: "The 12 photographs in it stay in the media library.",
   * "Three published pages link to it." Rendered as its own paragraph under the main consequence.
   */
  consequences?: ReactNode;
  /** Overrides the mode's default. `true` demands the name be typed before Confirm will act. */
  requireTyping?: boolean;
  /** The toast shown on success. Pass `null` for none — for a caller that navigates and reports itself. */
  successMessage?: string | null;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** The visible button text. Defaults to "Delete", or "Delete for good" when purging. */
  label?: string;
  /** For a dense table row: the glyph only, with the label kept for screen readers and voice control. */
  iconOnly?: boolean;
  className?: string;
}

export function DeleteButton({
  name,
  noun = "item",
  onDelete,
  onDeleted,
  mode = "recycle",
  retentionDays = 30,
  consequences,
  requireTyping,
  successMessage,
  variant = "danger",
  size = "md",
  label,
  iconOnly = false,
  className
}: DeleteButtonProps) {
  const confirm = useConfirm();
  const { toast } = useToast();
  const [isDeleting, setIsDeleting] = useState(false);

  // The delete resolves after an `await`, by which time the row may have been removed from the table
  // and this button unmounted. Setting state then logs a React warning and — worse — the failure it
  // was reporting becomes invisible, so the guard is what makes the toast the reliable channel.
  const mounted = useRef(true);
  useEffect(() => {
    // Assigned on mount as well as cleared on unmount, so a StrictMode double-mount in development
    // does not leave the component permanently believing it is gone.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const purging = mode === "purge";
  const buttonLabel = label ?? (purging ? "Delete for good" : "Delete");
  const mustType = requireTyping ?? purging;

  const run = useCallback(async () => {
    const agreed = await confirm({
      // The name is in the title, so a reader who reads nothing else still knows which row they are
      // about to lose.
      title: purging ? `Delete “${name}” for good?` : `Delete ${noun} “${name}”?`,
      body: (
        <>
          <p>
            {purging ? (
              <>
                This removes “{name}” and any files stored with it for good. Nothing can bring it
                back, and any address that pointed at it will stop working.
              </>
            ) : (
              <>
                It will move to the recycle bin, where an administrator can restore it for{" "}
                {retentionDays} days. After that a clean-up job removes it for good. It disappears
                from the public site straight away.
              </>
            )}
          </p>
          {consequences ? <p className="mt-2">{consequences}</p> : null}
        </>
      ),
      // Name the action. "OK" answers nothing, and on a two-button dialog it is the reader guessing
      // which button belongs to which sentence.
      confirmLabel: purging ? "Delete for good" : "Move to recycle bin",
      cancelLabel: "Keep it",
      tone: "danger",
      requireTyping: mustType ? name : undefined
    });

    if (!agreed) return;

    setIsDeleting(true);
    try {
      await onDelete();
      if (successMessage !== null) {
        toast({
          tone: "success",
          title: successMessage ?? (purging ? `“${name}” has been deleted for good` : `“${name}” is in the recycle bin`),
          description: purging
            ? undefined
            : `An administrator can restore it for the next ${retentionDays} days.`
        });
      }
      onDeleted?.();
    } catch (thrown) {
      // `message` from lib/api.ts is already a plain sentence ready to render (contract §9).
      const failure = asApiClientError(thrown);
      toast({ tone: "error", title: "It has not been deleted", description: failure.message });
    } finally {
      if (mounted.current) setIsDeleting(false);
    }
  }, [
    confirm,
    consequences,
    mustType,
    name,
    noun,
    onDelete,
    onDeleted,
    purging,
    retentionDays,
    successMessage,
    toast
  ]);

  return (
    <Button
      variant={variant}
      size={size}
      icon={Trash2}
      isLoading={isDeleting}
      loadingLabel="deleting"
      onClick={() => void run()}
      // `!px-2.5` because `cn()` is a plain join and later classes do NOT win (contract §5): the
      // recipe's `px-4` would otherwise leave an icon-only button as wide as one with a label.
      className={cn(iconOnly && "!px-2.5", className)}
    >
      {/* Icon-only still carries the words, kept for screen readers and voice control ("click delete").
          Not an `aria-label`: Button puts its children in a polite live region so the wait announces
          itself, and an `aria-label` on the button would leave that region unnamed. */}
      {iconOnly ? <span className="sr-only">{buttonLabel} {name}</span> : buttonLabel}
    </Button>
  );
}
