"use client";

/**
 * BulkActions — the bar that appears when files are selected: move, tag, credit, delete.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * SEQUENTIAL, NOT PARALLEL, AND IT COLLECTS FAILURES RATHER THAN ABORTING.
 *
 * Forty parallel PATCHes make every one of them slow, and the first failure is ambiguous because they
 * were all competing with each other. Worse, a `Promise.all` REJECTS ON THE FIRST FAILURE and abandons
 * the rest — so a reader who selected forty photographs and one of them is locked ends up with an
 * unknowable number changed, no list of which, and a red banner. One at a time, each outcome recorded,
 * and the whole thing reported at the end.
 *
 * FAILED ROWS STAY SELECTED. Retrying is then one click on the same button, on exactly the files that
 * did not take — and the ones that succeeded are not touched a second time, which matters because each
 * write is a revision and an audit entry.
 *
 * IT COUNTS PROGRESS OUT LOUD AND CAN BE STOPPED. Anything left unattempted after a stop stays
 * selected and is named as unattempted rather than as failed: "we did not try" and "we tried and it
 * refused" are different facts and lead to different next steps.
 *
 * DELETING IS SOFT, AND WHAT IT BREAKS IS NAMED AFTERWARDS. The bar cannot know what uses a file — see
 * `applyDelete` — so it does not pretend to; it collects the reference list each `DELETE` answers with
 * and lists every record left without a picture, each as a link. The recovery window is stated as a
 * real number of days where the caller passed one, and not guessed at where it did not.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The bar's own motion is the one kind the studio allows: a state change that carries meaning, 4px and
 * 180ms. No entrance animation on anything else here.
 */

import { useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { FolderInput, Link2Off, Pencil, Tags, Trash2, TriangleAlert, X } from "lucide-react";

import { asApiClientError, del, patch } from "@/lib/client/fetcher";
import { cn, unique } from "@/lib/utils";
import { DURATION, EASE_OUT, useReducedMotionPreference } from "@/components/motion";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FieldBlock } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Select } from "@/components/ui/Select";
import {
  MEDIA_ENDPOINTS,
  type MediaDeleteResponse,
  type MediaFolderNode,
  type MediaUsage,
  type StudioMediaAsset
} from "./MediaGrid";

export interface BulkOutcome {
  /** Ids that were changed. The caller re-reads these rather than trusting local state. */
  changedIds: string[];
  /** Ids that failed or were never attempted. The caller leaves these SELECTED. */
  keepSelectedIds: string[];
}

export interface BulkActionsProps {
  /** The chosen rows, as they currently stand — tag edits are computed from their existing tags. */
  selected: readonly StudioMediaAsset[];
  /** How many rows are on this page altogether, so the bar can be honest about scope. */
  rowsOnPage: number;
  /** How many rows there are in the whole filtered list, if known. */
  totalRows?: number | null;
  folders: readonly MediaFolderNode[] | null;
  /**
   * How many days a deleted file can still be restored for — `MEDIA_PURGE_AFTER_DAYS` as configured on
   * this installation. Null where the caller does not know it, and the confirmation then names the
   * recycle bin without inventing a period.
   */
  recoveryDays?: number | null;
  onFinished: (outcome: BulkOutcome) => void;
  onClearSelection: () => void;
  className?: string;
}

/** One file that has gone to the recycle bin while something on the site was still using it. */
interface BrokenReference {
  fileName: string;
  usage: MediaUsage[];
  /** True when the server stopped counting. Said out loud rather than rounded off (contract §1.6). */
  truncated: boolean;
}

type Job =
  | { kind: "move" }
  | { kind: "tags" }
  | { kind: "credit" }
  | null;

interface Failure {
  id: string;
  fileName: string;
  reason: string;
  /** True when the run was stopped before this row was reached. A different fact from a refusal. */
  unattempted: boolean;
}

export function BulkActions({
  selected,
  rowsOnPage,
  totalRows,
  folders,
  recoveryDays = null,
  onFinished,
  onClearSelection,
  className
}: BulkActionsProps) {
  const confirm = useConfirm();
  const reduce = useReducedMotionPreference();

  const [job, setJob] = useState<Job>(null);
  const [folderId, setFolderId] = useState("");
  const [tagMode, setTagMode] = useState<"add" | "remove">("add");
  const [tagDraft, setTagDraft] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [credit, setCredit] = useState("");

  const [running, setRunning] = useState<string | null>(null);
  const [done, setDone] = useState(0);
  const [failures, setFailures] = useState<Failure[]>([]);
  /** What the last delete left without a picture. Stays on screen until it is dismissed. */
  const [broken, setBroken] = useState<BrokenReference[]>([]);

  const stopRef = useRef(false);
  const tagInputRef = useRef<HTMLInputElement | null>(null);

  const count = selected.length;

  const closeJob = () => {
    setJob(null);
    setTagDraft("");
    setTags([]);
    setCredit("");
    setFolderId("");
  };

  /**
   * Run `apply` over the selection, one at a time.
   *
   * `label` names what is happening, for the progress readout and for the failure list's heading.
   */
  const run = async (label: string, apply: (asset: StudioMediaAsset) => Promise<void>) => {
    if (count === 0 || running !== null) return;

    stopRef.current = false;
    setRunning(label);
    setDone(0);
    setFailures([]);

    const changed: string[] = [];
    const collected: Failure[] = [];

    for (let index = 0; index < selected.length; index += 1) {
      const asset = selected[index];
      if (!asset) continue;

      if (stopRef.current) {
        collected.push({
          id: asset.id,
          fileName: asset.fileName,
          reason: "You stopped before this one was reached, so it is unchanged.",
          unattempted: true
        });
        continue;
      }

      try {
        await apply(asset);
        changed.push(asset.id);
      } catch (thrown) {
        // The server's `message` is already a plain sentence (lib/api.ts guarantees it) and is repeated
        // verbatim — reworded, it would stop matching what the reader can look up.
        collected.push({
          id: asset.id,
          fileName: asset.fileName,
          reason: asApiClientError(thrown).message,
          unattempted: false
        });
      }
      setDone(index + 1);
    }

    setRunning(null);
    setFailures(collected);
    closeJob();
    onFinished({ changedIds: changed, keepSelectedIds: collected.map((entry) => entry.id) });
  };

  const addTag = () => {
    const tag = tagDraft.trim();
    if (tag.length === 0) return;
    if (tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
      setTagDraft("");
      return;
    }
    setTags((current) => [...current, tag]);
    setTagDraft("");
  };

  const applyMove = () =>
    run("Moving files", async (asset) => {
      await patch(MEDIA_ENDPOINTS.detail(asset.id), {
        // Explicit null rather than an omitted key: `folderId` is nullable, and Zod's `.default()`
        // fires for a MISSING key and never for an explicit null (contract §14).
        folderId: folderId.length > 0 ? folderId : null
      });
    });

  const applyTags = () =>
    run(tagMode === "add" ? "Adding tags" : "Removing tags", async (asset) => {
      const lowered = new Set(tags.map((tag) => tag.toLowerCase()));
      const next =
        tagMode === "add"
          ? unique([...asset.tags, ...tags])
          : asset.tags.filter((tag) => !lowered.has(tag.toLowerCase()));
      await patch(MEDIA_ENDPOINTS.detail(asset.id), { tags: next });
    });

  const applyCredit = () =>
    run("Setting the credit", async (asset) => {
      await patch(MEDIA_ENDPOINTS.detail(asset.id), { credit: credit.trim() || null });
    });

  /**
   * Move the selection to the recycle bin, and REPORT WHAT THAT BROKE.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * ⚠ NOTHING IN THE BROWSER CAN COUNT REFERENCES BEFORE THE FACT, and the confirmation says so rather
   * than implying the check has been made. "Is this photograph used anywhere" spans fifteen relations
   * — avatars, covers, galleries, page sharing images, craft photographs — and the rows the bar holds
   * carry none of that. Only the server counts, and it counts inside `DELETE`, which is the honest
   * place: a page that started using a file two seconds ago is included, where a check made before the
   * confirmation would already be out of date.
   *
   * So each reply's reference list is collected and shown afterwards, named, with a link to each
   * record. Discarding it would leave an administrator to find out from a reader — which is the outcome
   * the whole usage machinery in that route exists to prevent.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  const applyDelete = async () => {
    const agreed = await confirm({
      title:
        count === 1
          ? "Move 1 file to the recycle bin?"
          : `Move ${count} files to the recycle bin?`,
      body: (
        <>
          <p>
            They disappear from the site straight away, and nothing is destroyed:{" "}
            {/*
              The REAL configured window, or no number at all — see `recoveryDays`. And "an
              administrator can put them back", never "you can": deleting needs `canManageMedia`,
              restoring needs `canRestoreDeleted`, which is ADMINISTRATOR only (lib/permissions.ts).
            */}
            {typeof recoveryDays === "number"
              ? `they go to the recycle bin, where an administrator can put them back for the next ${
                  recoveryDays === 1 ? "1 day" : `${recoveryDays} days`
                }, after which the stored copies are removed for good.`
              : "they go to the recycle bin, where an administrator can put them back. Studio → Recycle bin states how long this installation keeps them for."}
          </p>
          <p className="mt-2">
            Anything on the site that used one of these files will be left without a picture.{" "}
            <span className="font-semibold">Which pages those are is not known yet</span> — that is
            counted as each file is removed, and every one of them will be listed here afterwards.
            Opening a file on its own shows the list before you commit to it.
          </p>
        </>
      ),
      confirmLabel: count === 1 ? "Move to recycle bin" : `Move ${count} files`
    });
    if (!agreed) return;

    setBroken([]);
    // Filled from inside the loop and read after it: `run` awaits every step before it returns, so by
    // the line below this array is complete.
    const collected: BrokenReference[] = [];

    await run("Moving to the recycle bin", async (asset) => {
      const result = await del<MediaDeleteResponse>(MEDIA_ENDPOINTS.detail(asset.id));
      if (result.referenceCount > 0) {
        collected.push({
          fileName: result.fileName,
          usage: result.references,
          truncated: result.referencesTruncated
        });
      }
    });

    setBroken(collected);
  };

  const folderOptions = (folders ?? [])
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((folder) => ({ value: folder.id, label: folder.path }));

  const realFailures = failures.filter((entry) => !entry.unattempted);
  const unattempted = failures.filter((entry) => entry.unattempted);

  return (
    <div className={cn("min-w-0", className)}>
      <AnimatePresence initial={false}>
        {count > 0 ? (
          <motion.div
            // A state change carrying meaning, so it is allowed to move — 4px and 180ms, no more.
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={{ duration: reduce ? 0 : DURATION.scrim, ease: EASE_OUT }}
            className="rounded-md border border-purple-200 bg-purple-50 px-3 py-2.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              {/*
                NOT a live region. The count changes on every tick of a checkbox and the browser already
                announces the checkbox's own state change; a polite region here would repeat it a moment
                later, every time.
              */}
              <p className="min-w-0 text-xs text-purple-700">
                <span className="font-semibold">
                  {count === 1 ? "1 file selected" : `${count} files selected`}
                </span>{" "}
                {/* The scope, said out loud: a bulk action that looked as if it covered 4,000 records
                    and covered 48 would eventually change the wrong forty-eight (contract §1.6). */}
                {typeof totalRows === "number" && totalRows > rowsOnPage
                  ? `— everything selected is on this page. There are ${totalRows} altogether, and files on other pages are not included.`
                  : `of ${rowsOnPage} on this page`}
              </p>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={FolderInput}
                  disabled={running !== null}
                  onClick={() => setJob({ kind: "move" })}
                >
                  Move to folder
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={Tags}
                  disabled={running !== null}
                  onClick={() => setJob({ kind: "tags" })}
                >
                  Tags
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={Pencil}
                  disabled={running !== null}
                  onClick={() => setJob({ kind: "credit" })}
                >
                  Set credit
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  icon={Trash2}
                  disabled={running !== null}
                  onClick={() => void applyDelete()}
                >
                  Delete
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={running !== null}
                  onClick={onClearSelection}
                >
                  Clear selection
                </Button>
              </div>
            </div>

            {running !== null ? (
              <div className="mt-3">
                <ProgressBar
                  value={count > 0 ? Math.round((done / count) * 100) : 0}
                  label={running}
                  hint={`${done} of ${count} done — one at a time, so nothing is half-changed`}
                />
                <div className="mt-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={X}
                    onClick={() => {
                      stopRef.current = true;
                    }}
                  >
                    Stop after the current file
                  </Button>
                </div>
              </div>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>

      {failures.length > 0 ? (
        // Named, not counted. `role="alert"` because something the reader asked for did not happen.
        <div
          role="alert"
          className="mt-2 rounded-md border border-error-200 bg-error-100 p-3 text-error-700"
        >
          <p className="flex items-start gap-1.5 text-sm font-semibold">
            <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {realFailures.length > 0
                ? realFailures.length === 1
                  ? "1 file was not changed"
                  : `${realFailures.length} files were not changed`
                : "The run was stopped"}
              {unattempted.length > 0
                ? realFailures.length > 0
                  ? `, and ${unattempted.length} were never attempted`
                  : ` — ${unattempted.length} ${unattempted.length === 1 ? "file was" : "files were"} never attempted`
                : ""}
            </span>
          </p>

          <ul className="mt-2 space-y-1.5">
            {failures.map((entry) => (
              <li key={entry.id} className="text-xs leading-relaxed">
                <span className="block break-all font-medium">{entry.fileName}</span>
                <span className="block">{entry.reason}</span>
              </li>
            ))}
          </ul>

          <p className="mt-2 text-xs leading-relaxed">
            These are still selected, so pressing the same button tries again on exactly these files and
            leaves the ones that already worked alone.
          </p>

          <div className="mt-2">
            <Button size="sm" variant="ghost" onClick={() => setFailures([])}>
              Dismiss this list
            </Button>
          </div>
        </div>
      ) : null}

      {broken.length > 0 ? (
        /*
          What the delete actually broke, named. `role="alert"`, not a toast: a toast is
          `aria-live="polite"`, never interrupts, and may never be read at all — and "the About page
          now has a hole in it" is the one thing on this screen somebody has to act on today. Amber
          rather than red because nothing failed: the deletion did exactly what was asked, and this is
          the consequence of asking.
        */
        <div
          role="alert"
          className="mt-2 rounded-md border border-amber-800/25 bg-amber-100 p-3 text-amber-800"
        >
          <p className="flex items-start gap-1.5 text-sm font-semibold">
            <Link2Off aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {broken.length === 1
                ? "1 of the files that was removed is still used on the site"
                : `${broken.length} of the files that were removed are still used on the site`}
            </span>
          </p>
          <p className="mt-1 text-xs leading-relaxed">
            These records will render without a picture until somebody chooses another one, or until
            an administrator puts the file back from the recycle bin.
          </p>

          <ul className="mt-2 space-y-2">
            {broken.map((entry) => (
              <li key={entry.fileName} className="text-xs leading-relaxed">
                <span className="block break-all font-semibold">{entry.fileName}</span>
                <ul className="mt-0.5 space-y-0.5">
                  {entry.usage.map((use, index) => (
                    <li key={`${use.where}-${use.label}-${index}`}>
                      {use.href ? (
                        <Link
                          href={use.href}
                          className="font-medium underline underline-offset-4"
                        >
                          {use.label}
                        </Link>
                      ) : (
                        <span className="font-medium">{use.label}</span>
                      )}
                      <span> — {use.where}</span>
                    </li>
                  ))}
                </ul>
                {entry.truncated ? (
                  // The cap, on screen. A list that quietly stops is indistinguishable from that being
                  // all there was (contract §1.6).
                  <p className="mt-0.5 italic">
                    There are more places than these — the count stops after a while. Treat the list as
                    “at least these”.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>

          <div className="mt-2">
            <Button size="sm" variant="ghost" onClick={() => setBroken([])}>
              Dismiss this list
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog
        open={job !== null}
        onClose={closeJob}
        title={
          job?.kind === "move"
            ? count === 1
              ? "Move 1 file"
              : `Move ${count} files`
            : job?.kind === "tags"
              ? count === 1
                ? "Tags for 1 file"
                : `Tags for ${count} files`
              : job?.kind === "credit"
                ? count === 1
                  ? "Credit for 1 file"
                  : `Credit for ${count} files`
                : ""
        }
        description={
          job?.kind === "credit"
            ? "This replaces whatever credit each of these files has now."
            : undefined
        }
        size="sm"
        footer={
          <>
            <button
              type="button"
              data-dialog-cancel
              onClick={closeJob}
              className="field-button-secondary"
            >
              Cancel
            </button>
            <Button
              disabled={job?.kind === "tags" && tags.length === 0}
              onClick={() => {
                if (job?.kind === "move") void applyMove();
                else if (job?.kind === "tags") void applyTags();
                else if (job?.kind === "credit") void applyCredit();
              }}
            >
              {job?.kind === "move"
                ? "Move"
                : job?.kind === "tags"
                  ? tagMode === "add"
                    ? "Add these tags"
                    : "Remove these tags"
                  : "Set credit"}
            </Button>
          </>
        }
      >
        {job?.kind === "move" ? (
          // `Field` (a real `<label>`) is right here: the control is a NATIVE `<select>`, so there is
          // no button inside for a stray click to be forwarded to (Field.tsx).
          <Field
            label="Move into"
            help="Folders only affect this library, never the website. Leave it on “Not in a folder” to take these files out of every folder."
          >
            <Select
              value={folderId}
              onChange={(event) => setFolderId(event.target.value)}
              placeholder="Not in a folder"
              options={folderOptions}
            />
          </Field>
        ) : null}

        {job?.kind === "tags" ? (
          <>
            <Field label="What should happen">
              <Select
                value={tagMode}
                onChange={(event) => setTagMode(event.target.value === "remove" ? "remove" : "add")}
                options={[
                  { value: "add", label: "Add these tags, keeping the ones already there" },
                  { value: "remove", label: "Remove these tags, leaving the others" }
                ]}
              />
            </Field>

            {/* A `FieldBlock` — a `<div>` with `htmlFor` — because this control contains buttons. */}
            <FieldBlock
              label="Tags"
              className="mt-3"
              help="Press Enter after each one. Capital letters are ignored when matching."
            >
              <div className="flex gap-2">
                <Input
                  ref={tagInputRef}
                  data-autofocus
                  value={tagDraft}
                  onChange={(event) => setTagDraft(event.target.value)}
                  onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    addTag();
                  }}
                  placeholder="Add a tag"
                />
                <Button variant="secondary" onClick={addTag} disabled={tagDraft.trim().length === 0}>
                  Add
                </Button>
              </div>

              {tags.length > 0 ? (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {tags.map((tag) => (
                    <li key={tag}>
                      <button
                        type="button"
                        onClick={() => setTags((current) => current.filter((entry) => entry !== tag))}
                        className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-purple-200 bg-purple-50 px-2.5 py-1 text-xs font-medium text-purple-700 transition hover:border-purple-300 hover:bg-purple-100"
                      >
                        {tag}
                        <X aria-hidden="true" className="h-3 w-3" />
                        <span className="sr-only"> — remove this tag</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-ink-500">
                  Nothing to apply yet — add at least one tag.
                </p>
              )}
            </FieldBlock>
          </>
        ) : null}

        {job?.kind === "credit" ? (
          <Field
            label="Credit"
            value={credit}
            maxLength={160}
            help="Who took or made these — “Photograph: R. Menon”. Leave it empty to clear the credit on all of them."
          >
            <Input
              data-autofocus
              value={credit}
              onChange={(event) => setCredit(event.target.value)}
            />
          </Field>
        ) : null}
      </Dialog>
    </div>
  );
}
