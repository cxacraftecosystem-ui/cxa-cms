"use client";

/**
 * TaxonomyManager — the categories and tags of the newsroom, and the four things you can do to one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * EVERY DESTRUCTIVE ACTION STATES THE NUMBER OF ARTICLES IT WILL MOVE.
 *
 * "Merge Textiles into Craft?" is a question nobody can answer. "Merge Textiles into Craft? 14 articles
 * move to Craft and Textiles is removed" is a decision. The counts come from the server with the list, so
 * they are real numbers rather than a promise to find out afterwards.
 *
 * A TERM IN USE IS NOT DELETED, AND THE REFUSAL COMES WITH THE WAY FORWARD.
 *
 * Deleting a category that 14 articles are filed under would either orphan them or silently unfile them.
 * So Delete is offered only for a term nothing uses; for one in use, the screen says how many articles
 * use it and offers to move them somewhere first. That is the same operation as a merge, and it opens the
 * same dialog — one code path, so the count and the wording cannot drift apart.
 *
 * RENAMING DOES NOT CHANGE THE WEB ADDRESS, AND THE DIALOG SAYS SO. `/news/tag/textiles` is a link
 * somebody may have printed; re-deriving the address from a corrected spelling would break it silently.
 * A term that needs a new address is a new term with the old one merged into it.
 *
 * NO `DataTable` HERE, DELIBERATELY. Two of them on one screen would share the `sort` and `dir` query
 * parameters and fight over them, and a list of twenty categories needs neither sorting nor pagination
 * nor resizable columns. What it needs is the count beside each name, which a plain list gives.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Merge, Pencil, Plus, Tags, Trash2 } from "lucide-react";

import { asApiClientError, del, patch, post } from "@/lib/client/fetcher";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/ToastProvider";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";
import { RowActions, type RowAction } from "@/components/studio/RowActions";

export type TermGroup = "category" | "tag";

export interface TaxonomyTerm {
  id: string;
  name: string;
  /** The part of the address readers see. Stable across a rename — see the header. */
  slug: string;
  /** Categories carry one; tags do not. */
  description: string | null;
  /**
   * Articles filed under this term, not counting anything in the recycle bin.
   *
   * DRAFTS ARE COUNTED. This number's job is to say how much moves on a merge, and a draft filed under a
   * category moves too — counting only published articles would promise "3 articles move" and move nine.
   */
  articleCount: number;
}

export interface TaxonomyManagerProps {
  categories: readonly TaxonomyTerm[];
  tags: readonly TaxonomyTerm[];
  /** True when the tag list was capped, so the screen can say so rather than appearing complete. */
  tagsTruncated: boolean;
  tagTotal: number;
}

const ENDPOINT: Record<TermGroup, string> = {
  category: "/api/studio/news/categories",
  tag: "/api/studio/news/tags"
};

const NOUN: Record<TermGroup, { one: string; many: string }> = {
  category: { one: "category", many: "categories" },
  tag: { one: "tag", many: "tags" }
};

const NAME_MAX = 80;
const DESCRIPTION_MAX = 240;

type DialogState =
  | { kind: "closed" }
  | { kind: "create"; group: TermGroup }
  | { kind: "rename"; group: TermGroup; term: TaxonomyTerm }
  /** `reason` only changes the wording: a merge and a "move these before deleting" are one operation. */
  | { kind: "merge"; group: TermGroup; term: TaxonomyTerm; reason: "merge" | "delete" };

/** "1 article" / "14 articles". Written out because an English plural is not a suffix rule worth guessing. */
function articles(count: number): string {
  return count === 1 ? "1 article" : `${count} articles`;
}

/** Where the newsroom list is filtered to this term. A count nobody can click is a count they must trust. */
function filterHref(group: TermGroup, term: TaxonomyTerm): string {
  return group === "category"
    ? `/studio/news?category=${encodeURIComponent(term.id)}`
    : `/studio/news?tag=${encodeURIComponent(term.slug)}`;
}

export function TaxonomyManager({ categories, tags, tagsTruncated, tagTotal }: TaxonomyManagerProps) {
  const router = useRouter();
  const confirm = useConfirm();
  const { toast } = useToast();

  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mergeInto, setMergeInto] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const closeDialog = useCallback(() => {
    setDialog({ kind: "closed" });
    setName("");
    setDescription("");
    setMergeInto("");
    setError(null);
  }, []);

  const openCreate = useCallback((group: TermGroup) => {
    setName("");
    setDescription("");
    setError(null);
    setDialog({ kind: "create", group });
  }, []);

  const openRename = useCallback((group: TermGroup, term: TaxonomyTerm) => {
    setName(term.name);
    setDescription(term.description ?? "");
    setError(null);
    setDialog({ kind: "rename", group, term });
  }, []);

  const openMerge = useCallback(
    (group: TermGroup, term: TaxonomyTerm, reason: "merge" | "delete") => {
      setMergeInto("");
      setError(null);
      setDialog({ kind: "merge", group, term, reason });
    },
    []
  );

  const runCreate = useCallback(async () => {
    if (dialog.kind !== "create") return;
    setBusy(true);
    setError(null);
    try {
      await post<unknown>(ENDPOINT[dialog.group], {
        name: name.trim(),
        ...(dialog.group === "category" ? { description: description.trim() } : {})
      });
      toast({ tone: "success", title: `“${name.trim()}” has been added` });
      closeDialog();
      router.refresh();
    } catch (thrown) {
      // Shown inside the dialog rather than as a toast: the reader is standing in front of the field that
      // caused it, and a duplicate name is fixed by changing that field.
      setError(asApiClientError(thrown).message);
    } finally {
      setBusy(false);
    }
  }, [closeDialog, description, dialog, name, router, toast]);

  const runRename = useCallback(async () => {
    if (dialog.kind !== "rename") return;
    setBusy(true);
    setError(null);
    try {
      await patch<unknown>(`${ENDPOINT[dialog.group]}/${encodeURIComponent(dialog.term.id)}`, {
        name: name.trim(),
        ...(dialog.group === "category" ? { description: description.trim() } : {})
      });
      toast({
        tone: "success",
        title: `Renamed to “${name.trim()}”`,
        description: `The web address is still /${dialog.term.slug}, so existing links keep working.`
      });
      closeDialog();
      router.refresh();
    } catch (thrown) {
      setError(asApiClientError(thrown).message);
    } finally {
      setBusy(false);
    }
  }, [closeDialog, description, dialog, name, router, toast]);

  const runMerge = useCallback(async () => {
    if (dialog.kind !== "merge") return;
    if (mergeInto.length === 0) {
      setError(`Choose which ${NOUN[dialog.group].one} the articles should move to.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post<unknown>(
        `${ENDPOINT[dialog.group]}/${encodeURIComponent(dialog.term.id)}/merge`,
        { intoId: mergeInto }
      );
      toast({
        tone: "success",
        title: `“${dialog.term.name}” has been merged`,
        description: `${articles(dialog.term.articleCount)} moved, and “${dialog.term.name}” has been removed.`
      });
      closeDialog();
      router.refresh();
    } catch (thrown) {
      setError(asApiClientError(thrown).message);
    } finally {
      setBusy(false);
    }
  }, [closeDialog, dialog, mergeInto, router, toast]);

  /** Only ever called for a term nothing uses — the menu offers no Delete for one in use. */
  const runDelete = useCallback(
    async (group: TermGroup, term: TaxonomyTerm) => {
      const agreed = await confirm({
        title: `Delete the ${NOUN[group].one} “${term.name}”?`,
        body: (
          <p>
            Nothing is filed under it, so no article changes. Unlike an article, a{" "}
            {NOUN[group].one} does not go to the recycle bin — it is removed for good, and any link to{" "}
            <span className="break-all font-medium text-ink-900">
              /news/{group === "category" ? "category" : "tag"}/{term.slug}
            </span>{" "}
            will stop working.
          </p>
        ),
        confirmLabel: "Delete it",
        cancelLabel: "Keep it",
        tone: "danger"
      });
      if (!agreed) return;

      try {
        await del<void>(`${ENDPOINT[group]}/${encodeURIComponent(term.id)}`);
        toast({ tone: "success", title: `“${term.name}” has been deleted` });
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

  const renderGroup = (group: TermGroup, terms: readonly TaxonomyTerm[]) => {
    if (terms.length === 0) {
      return (
        <EmptyState
          icon={Tags}
          title={group === "category" ? "There are no categories yet" : "There are no tags yet"}
          description={
            group === "category"
              ? "A category is the one place an article is filed — “Research”, “Announcements”, “In the press”. Each has its own page on the site."
              : "A tag is a cross-cutting label. An article can carry several, and each tag has its own page listing everything under it. Tags are usually created while writing an article."
          }
          headingLevel={3}
          action={
            <Button variant="secondary" size="sm" icon={Plus} onClick={() => openCreate(group)}>
              Add {NOUN[group].one === "category" ? "a category" : "a tag"}
            </Button>
          }
        />
      );
    }

    return (
      <ul className="divide-y divide-line-200">
        {terms.map((term) => {
          const inUse = term.articleCount > 0;
          const others = terms.filter((candidate) => candidate.id !== term.id);

          const actions: RowAction[] = [
            {
              id: "rename",
              label: "Rename it",
              icon: Pencil,
              onSelect: () => openRename(group, term)
            },
            {
              id: "merge",
              label: `Merge into another ${NOUN[group].one}`,
              icon: Merge,
              // Not a permission: there is nowhere to merge to when it is the only one.
              disabled: others.length === 0,
              description:
                others.length === 0
                  ? `It is the only ${NOUN[group].one}, so there is nothing to merge it into.`
                  : `${articles(term.articleCount)} would move.`,
              onSelect: () => openMerge(group, term, "merge")
            },
            {
              id: "delete",
              label: inUse ? "Move its articles, then delete" : "Delete it",
              icon: inUse ? Merge : Trash2,
              tone: "danger",
              onSelect: () => (inUse ? openMerge(group, term, "delete") : void runDelete(group, term))
            }
          ];

          return (
            <li key={term.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink-900">{term.name}</p>
                <p className="mt-0.5 truncate font-mono text-[0.6875rem] text-ink-500">
                  /news/{group === "category" ? "category" : "tag"}/{term.slug}
                </p>
                {term.description ? (
                  <p className="mt-1 text-xs leading-relaxed text-ink-500">{term.description}</p>
                ) : null}
              </div>

              {/* The count is a link to the list already filtered, so a number can be checked rather
                  than taken on trust. */}
              <Link
                href={filterHref(group, term)}
                className={cn(
                  "shrink-0 rounded px-1.5 py-0.5 text-xs tabular-nums transition",
                  inUse
                    ? "text-ink-700 underline-offset-4 hover:text-purple-700 hover:underline"
                    : "text-ink-500 underline-offset-4 hover:text-purple-700 hover:underline"
                )}
              >
                {inUse ? articles(term.articleCount) : "Nothing filed here"}
              </Link>

              <RowActions subject={term.name} actions={actions} />
            </li>
          );
        })}
      </ul>
    );
  };

  // ── The dialog ────────────────────────────────────────────────────────────

  const dialogOpen = dialog.kind !== "closed";
  const group = dialog.kind === "closed" ? "category" : dialog.group;
  const noun = NOUN[group];
  const mergeCandidates =
    dialog.kind === "merge"
      ? (group === "category" ? categories : tags).filter(
          (candidate) => candidate.id !== dialog.term.id
        )
      : [];

  const dialogTitle =
    dialog.kind === "create"
      ? `Add a ${noun.one}`
      : dialog.kind === "rename"
        ? `Rename “${dialog.term.name}”`
        : dialog.kind === "merge"
          ? dialog.reason === "delete"
            ? `“${dialog.term.name}” is in use`
            : `Merge “${dialog.term.name}” into another ${noun.one}`
          : "";

  const submit =
    dialog.kind === "create" ? runCreate : dialog.kind === "rename" ? runRename : runMerge;

  const submitLabel =
    dialog.kind === "create"
      ? `Add this ${noun.one}`
      : dialog.kind === "rename"
        ? "Save the new name"
        : dialog.kind === "merge" && dialog.reason === "delete"
          ? "Move the articles and delete"
          : "Merge them";

  return (
    <div className="space-y-5">
      <FormSection
        title="Categories"
        description="One category per article. Each has its own page on the site, so a category with nothing in it is an empty page a reader can still reach."
        actions={
          <Button variant="secondary" size="sm" icon={Plus} onClick={() => openCreate("category")}>
            Add a category
          </Button>
        }
      >
        {renderGroup("category", categories)}
      </FormSection>

      <FormSection
        title="Tags"
        description="Cross-cutting labels. An article can carry several, and authors usually create them while writing rather than here."
        actions={
          <Button variant="secondary" size="sm" icon={Plus} onClick={() => openCreate("tag")}>
            Add a tag
          </Button>
        }
      >
        {renderGroup("tag", tags)}

        {/* A capped list says so, always (contract §1.6). */}
        {tagsTruncated ? (
          <HelpText>
            Showing the {tags.length} most used of {tagTotal} tags. The rest are still on the site and
            still work — they are left off this screen so it stays usable.
          </HelpText>
        ) : null}
      </FormSection>

      <Dialog
        open={dialogOpen}
        onClose={closeDialog}
        title={dialogTitle}
        size="sm"
        footer={
          <>
            <button type="button" data-dialog-cancel onClick={closeDialog} className="field-button-secondary">
              Cancel
            </button>
            <Button
              isLoading={busy}
              loadingLabel="working"
              // "Not available right now", with the reason already on screen above — there is nowhere to
              // move the articles to. Not a permission, so a disabled control is the right shape here.
              disabled={dialog.kind === "merge" && mergeCandidates.length === 0}
              onClick={() => void submit()}
            >
              {submitLabel}
            </Button>
          </>
        }
      >
        {dialog.kind === "create" || dialog.kind === "rename" ? (
          <div className="space-y-4">
            <Field
              label="Name"
              required
              maxLength={NAME_MAX}
              value={name}
              help="What readers see. Sentence case."
            >
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </Field>

            {group === "category" ? (
              <Field
                label="Description"
                maxLength={DESCRIPTION_MAX}
                value={description}
                help="One sentence, shown at the top of the category's own page. Leave it empty for none."
              >
                <Textarea
                  value={description}
                  rows={3}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>
            ) : null}

            {dialog.kind === "rename" ? (
              <HelpText>
                The web address stays as <span className="font-mono">/{dialog.term.slug}</span>, so links
                and bookmarks keep working. If the address itself has to change, add a new {noun.one} and
                merge this one into it.
              </HelpText>
            ) : null}
          </div>
        ) : dialog.kind === "merge" ? (
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-ink-700">
              {dialog.reason === "delete" ? (
                <>
                  {articles(dialog.term.articleCount)}{" "}
                  {dialog.term.articleCount === 1 ? "is" : "are"} filed under “{dialog.term.name}”, so it
                  cannot simply be deleted — those articles would be left unfiled. Choose where they should
                  go and they will be moved before it is removed.
                </>
              ) : (
                <>
                  {dialog.term.articleCount === 0 ? (
                    <>
                      Nothing is filed under “{dialog.term.name}”, so nothing moves. It will be removed and
                      the {noun.one} you choose is left as it is.
                    </>
                  ) : (
                    <>
                      {articles(dialog.term.articleCount)} will move to the {noun.one} you choose, and “
                      {dialog.term.name}” will be removed.
                    </>
                  )}
                </>
              )}
            </p>

            {mergeCandidates.length === 0 ? (
              // A required closed list with no options blocks a submit with no way forward, so the
              // requirement stands down and says what to do instead (contract §10).
              <HelpText tone="warn">
                There is no other {noun.one} to move them to. Add one first, then come back here.
              </HelpText>
            ) : (
              <Field
                label={`Move the articles to`}
                required
                help="Every article filed under the one being removed ends up here."
              >
                <Select
                  value={mergeInto}
                  placeholder={`Choose a ${noun.one}`}
                  options={mergeCandidates.map((candidate) => ({
                    value: candidate.id,
                    label:
                      candidate.articleCount > 0
                        ? `${candidate.name} — ${articles(candidate.articleCount)} already`
                        : `${candidate.name} — nothing filed yet`
                  }))}
                  onChange={(event) => setMergeInto(event.target.value)}
                />
              </Field>
            )}

            <HelpText tone="warn">
              This cannot be undone from the studio. The articles keep their own history, but the{" "}
              {noun.one} that is removed does not come back.
            </HelpText>
          </div>
        ) : null}

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
