"use client";

/**
 * TemplateManager — the templates themselves: writing one, editing one, copying one, retiring one and
 * removing one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT IS THE SECOND HALF OF THE TEMPLATES SCREEN, AND THE SPLIT IS DELIBERATE. Above it, the chooser
 * answers "make me a page from one of these" — plain forms posting to a Server Action, working with no
 * JavaScript at all. This half answers "change what is on offer", which is a different job for a
 * different moment, and it needs a client: a confirmation before a removal, a busy state on the row
 * being changed, and a list that refreshes without the reader losing their place.
 *
 * ⚠ IT REFRESHES BOTH HALVES, AND BOTH CALLS ARE LOAD-BEARING. `list.refresh()` re-reads this
 * component's own data; `router.refresh()` re-renders the Server Component above, which is where the
 * chooser's cards come from. Doing only the first leaves an administrator looking at a manager that says
 * a template is retired while the chooser above still offers it, which is worse than either being stale.
 *
 * ⚠ THE THREE KINDS OF TEMPLATE BEHAVE DIFFERENTLY, AND THE ROW SAYS WHICH IT IS.
 *
 *   • **Ships with the software** — one of the nine in lib/page-templates.ts. There is no row to edit
 *     and no row to delete: "Customise" makes one that stands in its place, and "Do not offer this"
 *     makes a hidden one, which is the only way to withdraw a built-in.
 *   • **Customised** — a row holding a built-in's key. Removing it brings the original back, and the
 *     confirmation says so, because that is the opposite of what "remove" usually means.
 *   • **Written here** — a row with a key of its own. Removing it removes it.
 *
 * ⚠ REMOVED TEMPLATES ARE LISTED AT THE FOOT, AND THAT IS WHY THE DELETE CAN BE SOFT. `BIN_TYPES` in
 * the recycle-bin route has no entry for a template, so without this section a removed one would be
 * reachable from nowhere at all — which reads as data destroyed rather than data kept (contract §1.6).
 * The same accepted arrangement as the announcements screen, which carries the same note.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `items === null` versus `items === []` is the usual deliberate distinction (contract §9) — though it
 * cannot arise on first paint here, because the Server Component above seeds `initialData` with the list
 * it has already read. It still matters after a failed refresh, where the list on screen is kept and the
 * failure is printed beside it.
 */

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BadgeCheck,
  Copy,
  EyeOff,
  FilePlus2,
  Layers,
  Pencil,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  WandSparkles
} from "lucide-react";

import { del, patch, post, asApiClientError } from "@/lib/client/fetcher";
import { useResource } from "@/lib/client/useResource";
import {
  TEMPLATE_LIMITS,
  type PageTemplateListResponse,
  type RemovedPageTemplate,
  type ResolvedPageTemplate
} from "@/lib/page-templates";
import { cn } from "@/lib/utils";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button, LinkButton } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/ToastProvider";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";
import { templateIcon } from "@/components/studio/templates/templateIcons";

/** Every address this screen calls, in one place, so the route handlers have one list to satisfy. */
const ENDPOINTS = {
  list: "/api/studio/templates",
  create: "/api/studio/templates",
  detail: (rowId: string) => `/api/studio/templates/${encodeURIComponent(rowId)}`
} as const;

/**
 * What a row can be busy doing.
 *
 * The ACTION is part of the busy state rather than only the key, because a spinner on the wrong control
 * is a plain lie about what the screen is doing: with a key alone, pressing Remove would spin the
 * Duplicate button beside it while the delete was in flight.
 */
type BusyAction = "create" | "copy" | "customise" | "switch" | "remove" | "restore";

/**
 * The stand-in key for the create panel, which has no row of its own.
 *
 * The underscores are load-bearing: keys are produced by `slugify`, which reduces every run of
 * non-alphanumeric characters to a hyphen and can therefore never make this one — so the create panel's
 * busy state can never spin a real template's button.
 */
const NEW_ROW = "__new__";

interface WriteAnswer {
  key?: string;
  message?: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// How a row describes itself
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface OriginWords {
  tone: BadgeTone;
  word: string;
  icon: typeof ShieldCheck;
  /** One sentence: what this kind of template is, and what removing or retiring it would do. */
  sentence: string;
}

function describeOrigin(template: ResolvedPageTemplate): OriginWords {
  if (template.origin === "built-in") {
    return {
      tone: "neutral",
      word: "Ships with the software",
      icon: ShieldCheck,
      sentence:
        "One of the arrangements built into this software. It cannot be edited or removed directly — customise it to make a version of your own that stands in its place, or switch it off to stop offering it."
    };
  }

  if (template.origin === "replacement") {
    return {
      tone: "info",
      word: "Customised",
      icon: WandSparkles,
      sentence:
        "A version written here, standing in place of one of the arrangements built into the software. Removing it brings the original back."
    };
  }

  return {
    tone: "info",
    word: "Written here",
    icon: BadgeCheck,
    sentence: "Written in this studio. Removing it puts it in the removed list at the foot of this screen."
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The manager
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface TemplateManagerProps {
  /**
   * The list the Server Component above has already read, so the first paint is not a skeleton of
   * something the page is holding in its hand.
   */
  initialData: PageTemplateListResponse;
}

export function TemplateManager({ initialData }: TemplateManagerProps) {
  const router = useRouter();
  const { toast } = useToast();
  const confirm = useConfirm();

  const list = useResource<PageTemplateListResponse>(ENDPOINTS.list, { initialData });
  const [busy, setBusy] = useState<{ key: string; action: BusyAction } | null>(null);
  const [newName, setNewName] = useState("");

  const items = list.data?.items ?? null;
  const removed = list.data?.removed ?? [];

  const busyActionFor = (key: string): BusyAction | null => (busy?.key === key ? busy.action : null);

  const report = useCallback(
    (thrown: unknown, title: string) => {
      // The server's `message` is already a plain sentence ready to render (lib/api.ts guarantees it).
      toast({ tone: "error", title, description: asApiClientError(thrown).message });
    },
    [toast]
  );

  /** Both refreshes, always together. See the file header for why one of them is not enough. */
  const refreshBoth = useCallback(async () => {
    await list.refresh();
    router.refresh();
  }, [list, router]);

  const createBlank = useCallback(async () => {
    const name = newName.trim();
    if (name.length === 0) return;

    setBusy({ key: NEW_ROW, action: "create" });
    try {
      const answer = await post<WriteAnswer>(ENDPOINTS.create, { name });
      setNewName("");
      // Straight into the editor: a template with no blocks is not finished, and leaving somebody on a
      // list with a new empty row on it is leaving them to work out what to press next.
      if (answer?.key) router.push(`/studio/templates/${encodeURIComponent(answer.key)}`);
      else await refreshBoth();
    } catch (thrown) {
      report(thrown, "The template has not been created");
    } finally {
      setBusy(null);
    }
  }, [newName, refreshBoth, report, router]);

  const duplicate = useCallback(
    async (template: ResolvedPageTemplate) => {
      setBusy({ key: template.id, action: "copy" });
      try {
        const answer = await post<WriteAnswer>(ENDPOINTS.create, { from: template.id });
        if (answer?.key) router.push(`/studio/templates/${encodeURIComponent(answer.key)}`);
        else await refreshBoth();
      } catch (thrown) {
        report(thrown, "The copy has not been made");
      } finally {
        setBusy(null);
      }
    },
    [refreshBoth, report, router]
  );

  /**
   * Take a built-in over: create a row holding its key, so it stands in that built-in's place.
   *
   * `isHidden` decides which of the two things this button is. Visible, it is "Customise" — the
   * customisation replaces the original and is offered in its place, so nothing disappears from the
   * chooser. Hidden, it is "Do not offer this" — the same row, retired, which is the only way to
   * withdraw one of the arrangements built into the software.
   */
  const customise = useCallback(
    async (template: ResolvedPageTemplate, hidden: boolean) => {
      if (hidden) {
        const agreed = await confirm({
          title: `Stop offering “${template.name}”?`,
          body: (
            <>
              <p>
                It will no longer appear when somebody creates a page. Pages already made from it are
                untouched — a page keeps the blocks it was given.
              </p>
              <p className="mt-2">
                A template built into the software cannot be deleted, so this works by writing a copy of
                it that is switched off. Switching it back on offers that copy rather than the original;
                removing the copy brings the original back exactly as it was.
              </p>
            </>
          ),
          confirmLabel: "Stop offering it",
          cancelLabel: "Keep offering it",
          // Nothing is destroyed and every step is reversible, so a danger-toned dialog would spend the
          // reader's attention where it is not needed.
          tone: "default"
        });
        if (!agreed) return;
      }

      setBusy({ key: template.id, action: hidden ? "switch" : "customise" });
      try {
        const answer = await post<WriteAnswer>(ENDPOINTS.create, {
          from: template.id,
          replaceBuiltIn: true,
          isHidden: hidden
        });
        if (hidden) {
          await refreshBoth();
          toast({ tone: "success", title: "It is no longer offered", description: answer?.message });
        } else if (answer?.key) {
          router.push(`/studio/templates/${encodeURIComponent(answer.key)}`);
        } else {
          await refreshBoth();
        }
      } catch (thrown) {
        report(thrown, hidden ? "It is still being offered" : "The customisation has not been made");
      } finally {
        setBusy(null);
      }
    },
    [confirm, refreshBoth, report, router, toast]
  );

  const setHidden = useCallback(
    async (template: ResolvedPageTemplate, hidden: boolean) => {
      if (!template.rowId) return;

      setBusy({ key: template.id, action: "switch" });
      try {
        const answer = await patch<WriteAnswer>(ENDPOINTS.detail(template.rowId), { isHidden: hidden });
        await refreshBoth();
        toast({
          tone: "success",
          title: hidden ? "It is no longer offered" : "It is offered again",
          description: answer?.message
        });
      } catch (thrown) {
        report(thrown, hidden ? "It is still being offered" : "It is still switched off");
      } finally {
        setBusy(null);
      }
    },
    [refreshBoth, report, toast]
  );

  const remove = useCallback(
    async (template: ResolvedPageTemplate) => {
      if (!template.rowId) return;
      const replacesBuiltIn = template.origin === "replacement";

      const agreed = await confirm({
        title: `Remove “${template.name}”?`,
        body: (
          <>
            <p>
              Pages already made from it are untouched. A page keeps the blocks it was given, so nothing
              on the site changes.
            </p>
            <p className="mt-2">
              {replacesBuiltIn
                ? "This is a version of one of the arrangements built into the software. Removing it brings the original back, and it will be offered again the moment this is gone."
                : "It is kept, not destroyed: it appears under the removed ones at the foot of this screen, where it can be put back."}
            </p>
          </>
        ),
        confirmLabel: "Remove it",
        cancelLabel: "Keep it",
        tone: "danger"
      });
      if (!agreed) return;

      setBusy({ key: template.id, action: "remove" });
      try {
        const answer = await del<WriteAnswer>(ENDPOINTS.detail(template.rowId));
        await refreshBoth();
        toast({ tone: "success", title: "The template has been removed", description: answer?.message });
      } catch (thrown) {
        report(thrown, "The template has not been removed");
      } finally {
        setBusy(null);
      }
    },
    [confirm, refreshBoth, report, toast]
  );

  const restore = useCallback(
    async (row: RemovedPageTemplate) => {
      setBusy({ key: row.id, action: "restore" });
      try {
        const answer = await patch<WriteAnswer>(ENDPOINTS.detail(row.id), { restore: true });
        await refreshBoth();
        toast({ tone: "success", title: "It is back in the list", description: answer?.message });
      } catch (thrown) {
        report(thrown, "It has not been put back");
      } finally {
        setBusy(null);
      }
    },
    [refreshBoth, report, toast]
  );

  return (
    <div className="space-y-5">
      <FormSection
        title="The templates themselves"
        description="Every arrangement this studio offers, including the ones that are switched off. Editing a template changes what future pages start as — pages already made from it keep the blocks they were given."
      >
        {list.error ? (
          <p
            role="alert"
            className="flex items-start gap-1.5 rounded-md border border-error-200 bg-error-100 px-3 py-2.5 text-sm text-error-700"
          >
            <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {list.error.message} The list below is the last one that arrived, so it may be out of date.
            </span>
          </p>
        ) : null}

        {items === null ? (
          <div>
            <span role="status" className="sr-only">
              Loading the templates…
            </span>
            <div aria-hidden="true" className="space-y-2">
              {[0, 1, 2].map((row) => (
                <div key={row} className="skeleton h-20 w-full" />
              ))}
            </div>
          </div>
        ) : (
          <ul className="space-y-3">
            {items.map((template) => (
              <TemplateRow
                key={template.id}
                template={template}
                busyAction={busyActionFor(template.id)}
                onDuplicate={() => void duplicate(template)}
                onCustomise={(hidden) => void customise(template, hidden)}
                onSetHidden={(hidden) => void setHidden(template, hidden)}
                onRemove={() => void remove(template)}
              />
            ))}
          </ul>
        )}

        {/* A list that quietly stops is indistinguishable from a short list (contract §1.6). */}
        {list.data?.truncated ? (
          <HelpText tone="warn">
            This shows {list.data.rowCount > list.data.limit ? list.data.limit : list.data.rowCount} of{" "}
            {list.data.rowCount} templates written here. The rest are not listed, and cannot be edited from
            this screen. Remove the ones you no longer need so the list is a complete answer again.
          </HelpText>
        ) : null}
      </FormSection>

      {/* ── Writing a new one ─────────────────────────────────────────────────────────────────── */}
      <FormSection
        title="Write a new template"
        description="A blank arrangement with a name. It arrives switched off, so nothing is offered to a colleague until you have chosen its blocks and switched it on."
        footer={
          <Button
            icon={FilePlus2}
            isLoading={busy?.key === NEW_ROW}
            loadingLabel="creating"
            disabled={newName.trim().length === 0}
            onClick={() => void createBlank()}
          >
            Create it and choose its blocks
          </Button>
        }
      >
        <Field
          label="What the template is called"
          required
          help="A noun phrase, as somebody would name the thing they are about to make — “Laboratory page”, “Short course”. It is what a colleague chooses it by."
          maxLength={TEMPLATE_LIMITS.name}
          value={newName}
        >
          <Input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="Laboratory page"
            autoComplete="off"
            onKeyDown={(event) => {
              // Enter submits, because this panel is one box and a button and pressing Enter in a
              // single-field form is what everybody expects. Guarded on the busy state so a double
              // press cannot start two creations.
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (busy === null && newName.trim().length > 0) void createBlank();
            }}
          />
        </Field>

        <HelpText>
          Starting from something is usually quicker: choose <strong>Make a copy</strong> on the template
          nearest to what you want, and change what differs.
        </HelpText>
      </FormSection>

      {/* ── Removed ───────────────────────────────────────────────────────────────────────────── */}
      {removed.length > 0 ? (
        <RemovedList
          rows={removed}
          total={list.data?.removedTotal ?? removed.length}
          truncated={list.data?.removedTruncated ?? false}
          restoringId={busy?.action === "restore" ? busy.key : null}
          onRestore={(row) => void restore(row)}
        />
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// One row
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface TemplateRowProps {
  template: ResolvedPageTemplate;
  busyAction: BusyAction | null;
  onDuplicate: () => void;
  onCustomise: (hidden: boolean) => void;
  onSetHidden: (hidden: boolean) => void;
  onRemove: () => void;
}

function TemplateRow({
  template,
  busyAction,
  onDuplicate,
  onCustomise,
  onSetHidden,
  onRemove
}: TemplateRowProps) {
  const origin = describeOrigin(template);
  const OriginIcon = origin.icon;
  const Glyph = templateIcon(template.icon);
  const isBuiltIn = template.origin === "built-in";

  return (
    <li
      className={cn(
        "rounded-md border border-line-200 px-4 py-3.5",
        // A retired template is drawn back rather than hidden: it is still in the list, and the fill
        // says "not in play" without relying on colour alone — the badge beside it says the word.
        template.isHidden ? "bg-surface-100" : "bg-card"
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            aria-hidden="true"
            className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-purple-100 text-purple-700"
          >
            <Glyph className="h-4 w-4" />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <span className="font-display text-sm font-semibold text-ink-900">{template.name}</span>
              {/* Icon AND word, never colour alone (contract §11). */}
              <Badge tone={origin.tone} size="sm" icon={OriginIcon}>
                {origin.word}
              </Badge>
              {template.isHidden ? (
                <Badge tone="warn" size="sm" icon={EyeOff}>
                  Not offered
                </Badge>
              ) : null}
              <span className="text-xs tabular-nums text-ink-500">
                {template.blocks.length === 1 ? "1 block" : `${template.blocks.length} blocks`}
              </span>
            </div>

            {template.description.trim().length > 0 ? (
              <p className="prose-measure mt-1 text-xs leading-relaxed text-ink-500">
                {template.description}
              </p>
            ) : (
              // Said out loud rather than left blank: an empty description is what a colleague reads
              // in the chooser, and nobody notices it is missing from a row that simply has no text.
              <p className="mt-1 text-xs leading-relaxed text-ink-500">
                No description yet. It is the sentence a colleague reads when choosing this template.
              </p>
            )}

            <p className="mt-1 text-xs leading-relaxed text-ink-500">{origin.sentence}</p>

            {template.problems.length > 0 ? (
              <ul className="mt-2 space-y-1">
                {template.problems.map((problem) => (
                  <li key={problem}>
                    <HelpText tone="warn">{problem}</HelpText>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isBuiltIn ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                icon={WandSparkles}
                isLoading={busyAction === "customise"}
                loadingLabel="preparing"
                onClick={() => onCustomise(false)}
              >
                Customise
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={EyeOff}
                isLoading={busyAction === "switch"}
                loadingLabel="switching off"
                onClick={() => onCustomise(true)}
              >
                Stop offering it
              </Button>
            </>
          ) : (
            <>
              <LinkButton
                variant="secondary"
                size="sm"
                icon={Pencil}
                href={`/studio/templates/${encodeURIComponent(template.id)}`}
              >
                Edit
              </LinkButton>
              <Button
                variant="ghost"
                size="sm"
                icon={template.isHidden ? Plus : EyeOff}
                isLoading={busyAction === "switch"}
                loadingLabel={template.isHidden ? "switching on" : "switching off"}
                onClick={() => onSetHidden(!template.isHidden)}
              >
                {template.isHidden ? "Offer it" : "Stop offering it"}
              </Button>
            </>
          )}

          <Button
            variant="ghost"
            size="sm"
            icon={Copy}
            isLoading={busyAction === "copy"}
            loadingLabel="copying"
            onClick={onDuplicate}
          >
            Make a copy
          </Button>

          {/*
            A built-in has no row to remove, so the control is ABSENT rather than disabled — a control
            that does nothing teaches the reader to ignore the ones that do. "Stop offering it" above is
            the thing they actually want.
          */}
          {isBuiltIn ? null : (
            <Button
              variant="danger"
              size="sm"
              icon={Trash2}
              isLoading={busyAction === "remove"}
              loadingLabel="removing"
              onClick={onRemove}
            >
              Remove
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The removed ones
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Removed templates, and how to get one back.
 *
 * ⚠ THIS SECTION IS WHY THE DELETE CAN BE SOFT — see the file header. It is also where somebody hunting
 * a name the create panel refuses as taken will find it: the key stays reserved while a template is in
 * here, and the refusal points at this list by name.
 */
function RemovedList({
  rows,
  total,
  truncated,
  restoringId,
  onRestore
}: {
  rows: readonly RemovedPageTemplate[];
  total: number;
  truncated: boolean;
  /** The row being put back, or null. */
  restoringId: string | null;
  onRestore: (row: RemovedPageTemplate) => void;
}) {
  return (
    <FormSection
      title="Removed templates"
      description="Taken out of the list but kept. None of these is offered when a page is created. Putting one back brings it in switched off, so it can be checked before anybody is offered it again."
    >
      <ul className="space-y-2">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 rounded-md border border-line-200 bg-surface-50 px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium leading-relaxed text-ink-700">{row.name}</p>
              <p className="mt-0.5 text-xs text-ink-500">
                {row.blockCount === 1 ? "1 block" : `${row.blockCount} blocks`}. Its short code
                &ldquo;{row.key}&rdquo; stays reserved while it is in here, so a new template cannot take
                that name until this one is put back or purged.
              </p>
            </div>

            <Button
              variant="secondary"
              size="sm"
              icon={RotateCcw}
              isLoading={restoringId === row.id}
              loadingLabel="putting it back"
              onClick={() => onRestore(row)}
            >
              Put it back
            </Button>
          </li>
        ))}
      </ul>

      {truncated ? (
        <HelpText tone="warn">
          This shows the {rows.length} most recently removed templates of {total}. The older ones are not
          listed here.
        </HelpText>
      ) : (
        <HelpText icon={Layers}>
          Removed templates are not in the recycle bin — this is the only screen that lists them.
        </HelpText>
      )}
    </FormSection>
  );
}
