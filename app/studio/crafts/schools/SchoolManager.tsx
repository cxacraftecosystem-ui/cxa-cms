"use client";

/**
 * SchoolManager — the schools and traditions a craft can belong to, and the three things you can do to one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS SCREEN EXISTS BECAUSE THE FIELD IT FILLS WAS UNFILLABLE. `Craft.schoolId` has always been there,
 * the craft editor has always offered a "School or tradition" picker, and the craft page has always printed
 * the name — and nothing anywhere in the studio could create one. So every craft read "No school recorded",
 * and an editor who DID have a named school had no move to make. A picker whose list can only ever be empty
 * reads as a fault in the studio rather than as an absence in the record.
 *
 * DELIBERATELY SHAPED ON app/studio/news/taxonomy/TaxonomyManager.tsx, which is the same problem one product
 * over: a small list of named terms, a count beside each, and every destructive action stating the number it
 * would move. Two rules are carried over verbatim because they are not about the newsroom:
 *
 *   • RENAMING DOES NOT CHANGE THE WEB ADDRESS, and the dialog says so. `?school=<slug>` is a public link
 *     (app/(site)/craft-explorer/[slug]/page.tsx builds it for every craft filed under one), so re-deriving
 *     the address from a corrected spelling would break bookmarks silently.
 *   • A SCHOOL IN USE IS NOT DELETED. What differs from the newsroom is the way forward: there is no merge
 *     here. A category is mandatory on an article, so a category can only be swapped; a school is optional
 *     on a craft, so the equivalent is "clear the field", which the craft's own editor already owns. A merge
 *     offered here would be a SECOND writer for `Craft.schoolId` — the objection the regions screen records
 *     at length — so the count links to the crafts instead and the editor clears them where that column
 *     belongs. app/api/studio/crafts/schools/[id]/route.ts refuses the delete in the same terms.
 *
 * NO `DataTable`, for the reason TaxonomyManager gives: a list of twenty named traditions needs no sorting,
 * no pagination and no resizable columns. What it needs is the count beside each name, which a plain list
 * gives, and which links to the archive already filtered so a number can be checked rather than trusted.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Landmark, Pencil, Plus, Trash2 } from "lucide-react";

import { asApiClientError, del, patch, post } from "@/lib/client/fetcher";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/ToastProvider";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";
import { RowActions, type RowAction } from "@/components/studio/RowActions";

export interface SchoolRowData {
  id: string;
  name: string;
  /** The public query value. Stable across a rename — see the header. */
  slug: string;
  description: string | null;
  /**
   * Crafts filed under this school, not counting anything in the recycle bin.
   *
   * DRAFTS ARE COUNTED. This number's job is to say what a delete would un-file, and a draft filed under a
   * school is un-filed just the same — counting only published crafts would promise "nothing is filed here"
   * and then clear nine drafts.
   */
  craftCount: number;
}

export interface SchoolManagerProps {
  schools: readonly SchoolRowData[];
}

const NAME_MAX = 160;
const DESCRIPTION_MAX = 600;

const ENDPOINT = "/api/studio/crafts/schools";

type DialogState =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "rename"; school: SchoolRowData };

/** "1 craft" / "9 crafts". Written out, because an English plural is not a suffix rule worth guessing. */
function crafts(count: number): string {
  return count === 1 ? "1 craft" : `${count} crafts`;
}

export function SchoolManager({ schools }: SchoolManagerProps) {
  const router = useRouter();
  const confirm = useConfirm();
  const { toast } = useToast();

  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const closeDialog = useCallback(() => {
    setDialog({ kind: "closed" });
    setName("");
    setDescription("");
    setError(null);
  }, []);

  const openCreate = useCallback(() => {
    setName("");
    setDescription("");
    setError(null);
    setDialog({ kind: "create" });
  }, []);

  const openRename = useCallback((school: SchoolRowData) => {
    setName(school.name);
    setDescription(school.description ?? "");
    setError(null);
    setDialog({ kind: "rename", school });
  }, []);

  const runCreate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const answer = await post<{ message?: string }>(ENDPOINT, {
        name: name.trim(),
        description: description.trim()
      });
      toast({
        tone: "success",
        title: `“${name.trim()}” has been added`,
        // The server's own sentence, which says where the new school now appears.
        description: answer.message
      });
      closeDialog();
      router.refresh();
    } catch (thrown) {
      // Shown inside the dialog, not as a toast: the reader is standing in front of the field that caused
      // it, and a duplicate name is fixed by changing that field.
      setError(asApiClientError(thrown).message);
    } finally {
      setBusy(false);
    }
  }, [closeDialog, description, name, router, toast]);

  const runRename = useCallback(async () => {
    if (dialog.kind !== "rename") return;
    const school = dialog.school;
    setBusy(true);
    setError(null);
    try {
      await patch<unknown>(`${ENDPOINT}/${encodeURIComponent(school.id)}`, {
        name: name.trim(),
        description: description.trim()
      });
      toast({
        tone: "success",
        title: `“${school.name}” has been saved`,
        description: `The web address is still ?school=${school.slug}, so existing links keep working.`
      });
      closeDialog();
      router.refresh();
    } catch (thrown) {
      setError(asApiClientError(thrown).message);
    } finally {
      setBusy(false);
    }
  }, [closeDialog, description, dialog, name, router, toast]);

  /**
   * Only ever reached for a school nothing is filed under — the menu offers no Delete for one in use, and
   * the route refuses it as well. The confirm exists because the removal is permanent: a school has no
   * recycle bin, so this is the one warning there is.
   */
  const runDelete = useCallback(
    async (school: SchoolRowData) => {
      const agreed = await confirm({
        title: `Delete “${school.name}”?`,
        body: (
          <p>
            No craft is filed under it, so no craft changes. Unlike a craft, a school does not go to the
            recycle bin — it is removed for good, and it stops being offered on every craft&apos;s “School or
            tradition” field.
          </p>
        ),
        confirmLabel: "Delete it",
        cancelLabel: "Keep it",
        tone: "danger"
      });
      if (!agreed) return;

      try {
        const answer = await del<{ message?: string }>(
          `${ENDPOINT}/${encodeURIComponent(school.id)}`
        );
        toast({
          tone: "success",
          title: `“${school.name}” has been deleted`,
          // Carries the route's note about recycled crafts that have just lost their filing — rows nobody
          // can see from this screen.
          description: answer.message
        });
        router.refresh();
      } catch (thrown) {
        toast({
          tone: "error",
          title: "It has not been deleted",
          description: asApiClientError(thrown).message
        });
      }
    },
    [confirm, router, toast]
  );

  const dialogOpen = dialog.kind !== "closed";
  const submit = dialog.kind === "create" ? runCreate : runRename;

  return (
    <div className="space-y-5">
      <FormSection
        title="Schools and traditions"
        description="A named school, gharana, guild or workshop lineage a craft belongs to. It is optional on a craft — many traditions have no named school — and it is what the archive's “School” filter narrows by."
        actions={
          <Button variant="secondary" size="sm" icon={Plus} onClick={openCreate}>
            Add a school
          </Button>
        }
      >
        {schools.length === 0 ? (
          <EmptyState
            icon={Landmark}
            title="No school or tradition has been recorded yet"
            description="Until one is, every craft's “School or tradition” field has an empty list and each craft reads “No school recorded”. Add the ones the Centre documents — “Raghurajpur pattachitra”, “Bagru chhipa”, “Kutch Rabari” — and they appear on every craft's picker."
            headingLevel={3}
            action={
              <Button variant="secondary" size="sm" icon={Plus} onClick={openCreate}>
                Add the first one
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-line-200">
            {schools.map((school) => {
              const inUse = school.craftCount > 0;

              const actions: RowAction[] = [
                {
                  id: "rename",
                  label: "Edit the name or note",
                  icon: Pencil,
                  onSelect: () => openRename(school)
                },
                {
                  id: "delete",
                  label: inUse ? "Clear it from its crafts first" : "Delete it",
                  icon: Trash2,
                  tone: "danger",
                  // Not a permission — there is nothing to raise. It is a consequence, and the
                  // description says which one (contract §10).
                  disabled: inUse,
                  description: inUse
                    ? `${crafts(school.craftCount)} would be left with no school. Open ${school.craftCount === 1 ? "it" : "them"} and clear the field, then delete this.`
                    : "Nothing is filed under it, so no craft changes.",
                  onSelect: () => void runDelete(school)
                }
              ];

              return (
                <li key={school.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink-900">{school.name}</p>
                    <p className="mt-0.5 truncate font-mono text-[0.6875rem] text-ink-500">
                      ?school={school.slug}
                    </p>
                    {school.description ? (
                      <p className="mt-1 text-xs leading-relaxed text-ink-500">{school.description}</p>
                    ) : null}
                  </div>

                  {/* The count links to the archive already filtered, so a number can be checked rather
                      than taken on trust — and it is the route an editor takes to clear the field. */}
                  <Link
                    href={`/studio/crafts?school=${encodeURIComponent(school.slug)}`}
                    className="shrink-0 rounded px-1.5 py-0.5 text-xs tabular-nums text-ink-500 underline-offset-4 transition hover:text-purple-700 hover:underline"
                  >
                    {inUse ? crafts(school.craftCount) : "Nothing filed here"}
                  </Link>

                  <RowActions subject={school.name} actions={actions} />
                </li>
              );
            })}
          </ul>
        )}

        <HelpText>
          A craft is filed under a school on the craft&apos;s own record, under “Where it comes from”. This
          screen keeps the list of schools; it deliberately does not file crafts, so that one column has one
          writer.
        </HelpText>
      </FormSection>

      <Dialog
        open={dialogOpen}
        onClose={closeDialog}
        title={dialog.kind === "rename" ? `Edit “${dialog.school.name}”` : "Add a school or tradition"}
        size="sm"
        footer={
          <>
            <button
              type="button"
              data-dialog-cancel
              onClick={closeDialog}
              className="field-button-secondary"
            >
              Cancel
            </button>
            <Button isLoading={busy} loadingLabel="saving" onClick={() => void submit()}>
              {dialog.kind === "rename" ? "Save it" : "Add this school"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field
            label="Name"
            required
            maxLength={NAME_MAX}
            value={name}
            help="What readers see on a craft's page. Sentence case, and specific enough to tell two traditions apart — “Raghurajpur pattachitra” rather than “Pattachitra”."
          >
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>

          <Field
            label="Note"
            maxLength={DESCRIPTION_MAX}
            value={description}
            help="One or two sentences on what the school is. Shown to editors here; leave it empty if there is nothing to add."
          >
            <Textarea
              value={description}
              rows={3}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>

          {dialog.kind === "rename" ? (
            <HelpText>
              The web address stays as <span className="font-mono">?school={dialog.school.slug}</span>, so
              links and bookmarks keep working. If the address itself has to change, add a new school and
              re-file its crafts onto it from each craft&apos;s own record.
            </HelpText>
          ) : (
            <HelpText>
              The web address is made from the name, and it does not change afterwards — so a name worth
              getting right now is worth a moment. It appears as{" "}
              <span className="font-mono">?school=…</span> on the public archive.
            </HelpText>
          )}
        </div>

        {error ? (
          // `role="alert"`: the reader has just pressed something and been stopped.
          <p role="alert" className="mt-3 text-sm leading-relaxed text-error-600">
            {error}
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}
