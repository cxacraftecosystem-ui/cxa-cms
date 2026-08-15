"use client";

/**
 * TemplateEditor — what a page made from this template starts as.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS SCREEN EDITS AN ORDERED LIST OF BLOCK TYPES. IT DOES NOT EDIT ANY BLOCK'S CONTENT, AND IT
 * MUST NOT BE MADE TO. Every payload is built at the moment the template is used, by
 * `defaultSectionData()`, and validated by `parseSectionData()` — which is what stops a template going
 * stale when a block's schema changes, and what makes every payload valid by construction
 * (lib/page-templates.ts states the rule at length). A field here that stored a headline would be a
 * headline handed out at last release's shape for ever.
 *
 * SO THE TWO THINGS A ROW HOLDS ARE A LABEL AND A PURPOSE, AND BOTH ARE FOR THE PERSON BUILDING THE
 * PAGE. The label is written onto `PageSection.label` and is what makes a builder row read "Hero — the
 * programme in one line" instead of "HERO"; the purpose is the sentence shown under the block in the
 * template's preview, saying why it is in the arrangement. Neither is ever rendered on the public site.
 *
 * ⚠ `overrides` ARE CARRIED BUT NOT EDITABLE, AND THAT IS DELIBERATE. A copy of a built-in arrives with
 * the settings that make its blocks mean what its description says — "faculty only", "grouped by year" —
 * and they are round-tripped untouched. There is no box for them because they are per-block-schema keys:
 * `parseSectionData()` strips one that does not exist rather than failing, so a typed override would be
 * accepted, discarded and never reported. A free-text JSON box in a CMS is a way to be silently wrong.
 *
 * ⚠ A TEMPLATE WITH PROBLEMS CAN BE SAVED, BUT NOT OFFERED. `templateProblems()` — the SAME function the
 * route handler refuses with — is run on every keystroke and printed under the block list. Save stays
 * available while the template is switched off, because an unfinished arrangement is a normal state to
 * leave one in; switching it on is what the problems block. Saying why on screen beats a Save button that
 * refuses without explaining itself.
 *
 * SAVING IS MANUAL. `useAutosave` is used for its dirty tracking and its status vocabulary — a second
 * hand-rolled "is this dirty" flag is how two pieces of state start disagreeing — but the timer is off:
 * a template is offered to every colleague who makes a page, so a half-built list saved four seconds
 * after somebody starts typing is a broken arrangement in front of all of them.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * MOVING A BLOCK IS TWO BUTTONS, NOT A DRAG. A drag needs a keyboard equivalent, an announcement and a
 * sensor configuration to be usable at all, and this list is at most two dozen rows that are reordered
 * once when the template is written. Every move is announced in a live region, which is the half of
 * drag-and-drop that is usually missing.
 */

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Check, ListPlus, Trash2, X } from "lucide-react";
import type { SectionType } from "@prisma/client";

import { asApiClientError, del, patch } from "@/lib/client/fetcher";
import {
  TEMPLATE_LIMITS,
  templateProblems,
  type ResolvedPageTemplate,
  type TemplateBlockSpec
} from "@/lib/page-templates";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { Field, FieldBlock } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/ToastProvider";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";
import { SaveBar } from "@/components/studio/SaveBar";
import { useAutosave } from "@/components/studio/useAutosave";
import { useLeaveGuard } from "@/components/studio/useUnsavedChanges";
import { AddSectionPalette } from "@/components/studio/builder/AddSectionPalette";
import { safeSectionMeta, sectionIcon } from "@/components/studio/builder/SectionCard";
import {
  TEMPLATE_ICON_NAMES,
  humaniseTemplateIcon,
  isKnownTemplateIcon,
  templateIcon
} from "@/components/studio/templates/templateIcons";

const ENDPOINT = (rowId: string) => `/api/studio/templates/${encodeURIComponent(rowId)}`;

/**
 * A key for a row that has no id of its own.
 *
 * Two blocks of the same type in one template is normal, so `type` is not unique and the array index
 * changes the moment anything is moved — a key built from either would make React reuse the wrong
 * row's input state after a reorder, which shows up as text jumping between boxes. A counter is the
 * simplest thing that is stable for the life of the row. It is never rendered, so the server and the
 * browser starting it at different numbers cannot matter.
 */
let blockSeq = 0;
const nextUid = (): string => `block-${(blockSeq += 1)}`;

interface DraftBlock extends TemplateBlockSpec {
  uid: string;
}

interface Draft {
  name: string;
  description: string;
  suggestedTitle: string;
  icon: string;
  isHidden: boolean;
  blocks: DraftBlock[];
}

function draftFrom(template: ResolvedPageTemplate): Draft {
  return {
    name: template.name,
    description: template.description,
    suggestedTitle: template.suggestedTitle,
    icon: template.icon,
    isHidden: template.isHidden,
    blocks: template.blocks.map((block) => ({ ...block, uid: nextUid() }))
  };
}

/** The body the route handler takes. `uid` is this screen's own bookkeeping and never leaves it. */
function payloadFrom(draft: Draft) {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    suggestedTitle: draft.suggestedTitle.trim(),
    icon: draft.icon.trim(),
    isHidden: draft.isHidden,
    blocks: draft.blocks.map((block) => ({
      type: block.type,
      label: block.label.trim(),
      purpose: block.purpose.trim(),
      ...(block.overrides ? { overrides: block.overrides } : {})
    }))
  };
}

export interface TemplateEditorProps {
  template: ResolvedPageTemplate;
  /** The `PageTemplate` row's id. Separate from `template.rowId`, which is nullable for a built-in. */
  rowId: string;
}

export function TemplateEditor({ template, rowId }: TemplateEditorProps) {
  const router = useRouter();
  const { toast } = useToast();
  const confirm = useConfirm();

  const [draft, setDraft] = useState<Draft>(() => draftFrom(template));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [insertAt, setInsertAt] = useState(0);
  const [isRemoving, setIsRemoving] = useState(false);
  /** What just happened to the list, for a screen reader. See the file header on moving a block. */
  const [announcement, setAnnouncement] = useState("");

  const payload = useMemo(() => payloadFrom(draft), [draft]);

  const save = useCallback(
    async (body: ReturnType<typeof payloadFrom>) => {
      await patch<unknown>(ENDPOINT(rowId), body);
    },
    [rowId]
  );

  const autosave = useAutosave({ data: payload, save, enabled: false });
  useLeaveGuard(autosave.isDirty);

  const update = useCallback((next: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...next }));
  }, []);

  const updateBlock = useCallback((uid: string, next: Partial<TemplateBlockSpec>) => {
    setDraft((current) => ({
      ...current,
      blocks: current.blocks.map((block) => (block.uid === uid ? { ...block, ...next } : block))
    }));
  }, []);

  const addBlock = useCallback(
    (type: SectionType) => {
      const meta = safeSectionMeta(type);
      const at = Math.min(Math.max(insertAt, 0), draft.blocks.length);
      const blocks = [...draft.blocks];
      blocks.splice(at, 0, {
        uid: nextUid(),
        type,
        // Seeded with the palette's own name rather than left empty: a row with no name reads as a
        // block that failed to load, and the administrator renames it in place if they want to.
        label: meta.label,
        purpose: ""
      });

      setDraft({ ...draft, blocks });
      setPaletteOpen(false);
      setAnnouncement(`${meta.label} was added at position ${at + 1} of ${blocks.length}.`);
    },
    [draft, insertAt]
  );

  /**
   * ⚠ THESE TWO READ `draft` DIRECTLY RATHER THAN TAKING THE UPDATER FORM OF `setDraft`, and that is
   * deliberate: each one has to ANNOUNCE what it did, and a `setAnnouncement` called from inside a
   * `setDraft(current => …)` callback runs during the render pass — React warns about it, and in
   * StrictMode the updater is invoked twice, so the announcement is made twice. Reading the committed
   * state and writing both pieces of state from the event handler is the version that behaves.
   */
  const moveBlock = useCallback(
    (uid: string, direction: -1 | 1) => {
      const from = draft.blocks.findIndex((block) => block.uid === uid);
      if (from === -1) return;
      const to = from + direction;
      if (to < 0 || to >= draft.blocks.length) return;

      const blocks = [...draft.blocks];
      const moved = blocks[from];
      const displaced = blocks[to];
      // `noUncheckedIndexedAccess` is on, so both reads are `DraftBlock | undefined`. The bounds check
      // above already makes this unreachable; it is the shape the compiler asks for either way.
      if (!moved || !displaced) return;
      blocks[from] = displaced;
      blocks[to] = moved;

      setDraft({ ...draft, blocks });
      setAnnouncement(
        `${safeSectionMeta(moved.type).label} moved to position ${to + 1} of ${blocks.length}.`
      );
    },
    [draft]
  );

  const removeBlock = useCallback(
    (uid: string) => {
      const block = draft.blocks.find((entry) => entry.uid === uid);
      if (!block) return;
      const blocks = draft.blocks.filter((entry) => entry.uid !== uid);

      setDraft({ ...draft, blocks });
      setAnnouncement(
        `${safeSectionMeta(block.type).label} was taken out. ${blocks.length === 1 ? "1 block" : `${blocks.length} blocks`} left.`
      );
    },
    [draft]
  );

  const removeTemplate = useCallback(async () => {
    const replacesBuiltIn = template.origin === "replacement";

    const agreed = await confirm({
      title: `Remove “${draft.name.trim() || template.name}”?`,
      body: (
        <>
          <p>
            Pages already made from it are untouched. A page keeps the blocks it was given, so nothing on
            the site changes.
          </p>
          <p className="mt-2">
            {replacesBuiltIn
              ? "This is a version of one of the arrangements built into the software. Removing it brings the original back, and it will be offered again the moment this is gone."
              : "It is kept, not destroyed: it appears under the removed ones at the foot of the templates screen, where it can be put back. It is not in the recycle bin — that screen does not list templates."}
          </p>
        </>
      ),
      confirmLabel: "Remove it",
      cancelLabel: "Keep it",
      tone: "danger"
    });
    if (!agreed) return;

    setIsRemoving(true);
    try {
      const answer = await del<{ message?: string }>(ENDPOINT(rowId));
      // ⚠ Before navigating. The leave guard is watching `isDirty`, and unsaved edits to a template that
      // no longer exists would otherwise raise "you have unsaved changes" about a row that has gone.
      autosave.markSaved();
      toast({ tone: "success", title: "The template has been removed", description: answer?.message });
      router.push("/studio/templates");
      router.refresh();
    } catch (thrown) {
      setIsRemoving(false);
      // The server's `message` verbatim: lib/api.ts guarantees it is already a plain sentence, and
      // re-wording it here would make the two halves of the product disagree about what happened.
      toast({
        tone: "error",
        title: "The template has not been removed",
        description: asApiClientError(thrown).message
      });
    }
  }, [autosave, confirm, draft.name, rowId, router, template.name, template.origin, toast]);

  // ── What is wrong with it, in the route handler's own words ─────────────────────────────────────

  const problems = useMemo(
    () => templateProblems({ name: draft.name, blocks: draft.blocks }),
    [draft.name, draft.blocks]
  );

  const nameEmpty = draft.name.trim().length === 0;

  /**
   * Why Save is unavailable, or null.
   *
   * Only the two things the SERVER would refuse: an empty name, and an arrangement with problems while
   * the template is switched on. Anything else — no description, no icon — is incomplete rather than
   * wrong, and blocking a save on it would trap somebody who wanted to come back to it tomorrow.
   */
  const saveDisabledReason = nameEmpty
    ? "The template needs a name before it can be saved. It is what a colleague chooses it by."
    : !draft.isHidden && problems.length > 0
      ? `${problems.join(" ")} Switch it off below, or fix the list.`
      : null;

  const usedTypes = useMemo(() => draft.blocks.map((block) => block.type), [draft.blocks]);
  const insertAfter = insertAt > 0 ? draft.blocks[insertAt - 1] : undefined;

  return (
    <div className="space-y-5">
      {/*
        One live region for the whole list. `role="status"` is polite, and it is the only place a
        reorder is announced — the buttons themselves say "Move up", which is what will happen, not
        what did (contract §1.4: a signal that exists only as movement is one a reader may never get).
      */}
      <span role="status" className="sr-only">
        {announcement}
      </span>

      <FormSection
        title="What this template is"
        description="The words a colleague reads when they are choosing what sort of page to make. Written for somebody who has not made this kind of page before."
      >
        <Field
          label="Name"
          required
          help="A noun phrase, as somebody would name the thing they are about to make — “Programme or course”, “Annual report”."
          maxLength={TEMPLATE_LIMITS.name}
          value={draft.name}
          error={nameEmpty ? "The template needs a name." : null}
        >
          <Input
            value={draft.name}
            onChange={(event) => update({ name: event.target.value })}
            autoComplete="off"
          />
        </Field>

        <Field
          label="Description"
          help="Two sentences: what this arrangement is for, and when to reach for it instead of a blank page. It is the paragraph under the name on the templates screen."
          maxLength={TEMPLATE_LIMITS.description}
          value={draft.description}
        >
          <Textarea
            rows={3}
            value={draft.description}
            onChange={(event) => update({ description: event.target.value })}
            placeholder="A page that explains one programme and takes applications for it. Use it for a course, a residency or a training week."
          />
        </Field>

        <Field
          label="Suggested title for the new page"
          help="Pre-filled into the title box, so the form is never a blank one with no hint of what goes in it. A prompt rather than a real title — “Programme name”, not the name of one programme."
          maxLength={TEMPLATE_LIMITS.suggestedTitle}
          value={draft.suggestedTitle}
        >
          <Input
            value={draft.suggestedTitle}
            onChange={(event) => update({ suggestedTitle: event.target.value })}
            autoComplete="off"
          />
        </Field>

        <IconChoice value={draft.icon} onChange={(icon) => update({ icon })} />

        <Switch
          label="Offer this template"
          description="Off means it is kept but not shown when somebody creates a page. Switch it off while you are still building it, and on when the arrangement is one you would hand to a colleague."
          checked={!draft.isHidden}
          onCheckedChange={(checked) => update({ isHidden: !checked })}
        />

        {template.origin === "replacement" ? (
          <HelpText tone="warn">
            This stands in place of one of the arrangements built into the software, so switching it off
            withdraws that one as well. Removing this template brings the original back exactly as it was.
          </HelpText>
        ) : null}
      </FormSection>

      {/* ── The blocks ─────────────────────────────────────────────────────────────────────────── */}
      <FormSection
        title="The blocks it adds"
        description="In order, from the top of the page down. Each one arrives holding the same prompts a block dropped from the palette gets — “Add a headline” — for the person making the page to replace."
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={ListPlus}
            disabled={draft.blocks.length >= TEMPLATE_LIMITS.blocks}
            onClick={() => {
              setInsertAt(draft.blocks.length);
              setPaletteOpen(true);
            }}
          >
            Add a block
          </Button>
        }
      >
        {draft.blocks.length === 0 ? (
          // Not an `EmptyState`: this panel already owns an `<h2>`, and EmptyState renders its own
          // heading, which would put "No blocks yet" beside "The blocks it adds" in the outline
          // (contract §14). The sentence does the same work without the second heading.
          <p className="rounded-md border border-dashed border-line-200 bg-surface-50 px-4 py-6 text-center text-sm leading-relaxed text-ink-500">
            No blocks yet, so this template would create an empty page. Choose{" "}
            <span className="font-medium text-ink-700">Add a block</span> to start building the
            arrangement — a heading, then what the reader needs, then the invitation.
          </p>
        ) : (
          // An ordered list, because the order IS the template: what goes at the top of the page and
          // what comes after it. `<ol>` says that to a screen reader without a word of prose.
          <ol className="space-y-3">
            {draft.blocks.map((block, index) => (
              <BlockRow
                key={block.uid}
                block={block}
                index={index}
                total={draft.blocks.length}
                onChange={(next) => updateBlock(block.uid, next)}
                onMove={(direction) => moveBlock(block.uid, direction)}
                onRemove={() => removeBlock(block.uid)}
                onInsertAfter={() => {
                  setInsertAt(index + 1);
                  setPaletteOpen(true);
                }}
              />
            ))}
          </ol>
        )}

        {problems.length > 0 ? (
          <div className="space-y-1.5">
            {problems.map((problem) => (
              <HelpText key={problem} tone="warn">
                {problem}
              </HelpText>
            ))}
            <HelpText>
              A template with any of the above can still be saved, but it cannot be offered while it is —
              the page builder itself would refuse to rebuild the arrangement.
            </HelpText>
          </div>
        ) : null}

        {draft.blocks.length >= TEMPLATE_LIMITS.blocks ? (
          <HelpText tone="warn">
            A template holds at most {TEMPLATE_LIMITS.blocks} blocks, and this one is full. A page longer
            than that is two pages, and nobody scrolls to the foot of either.
          </HelpText>
        ) : null}
      </FormSection>

      {/* ── Removing it ────────────────────────────────────────────────────────────────────────── */}
      <FormSection
        tone="danger"
        title="Remove this template"
        description="It stops being offered when a page is created. Pages already made from it keep the blocks they were given, so nothing on the public site changes."
        footer={
          <Button
            variant="danger"
            icon={Trash2}
            isLoading={isRemoving}
            loadingLabel="removing"
            onClick={() => void removeTemplate()}
          >
            Remove this template
          </Button>
        }
      >
        {/*
          Not `DeleteButton`, deliberately. Its confirmation says the item moves to the recycle bin,
          where an administrator can restore it — and that is not true here: `BIN_TYPES` in the
          recycle-bin route has no entry for a template, so a removed one is listed on the templates
          screen instead. A dialog describing the wrong destination is worse than a plain one.
        */}
        <HelpText>
          {template.origin === "replacement"
            ? "This stands in place of one of the arrangements built into the software. Removing it brings that original back and offers it again."
            : "It is kept, not destroyed: it appears under the removed ones at the foot of the templates screen, which is the only place removed templates are listed."}
        </HelpText>
      </FormSection>

      <SaveBar
        status={autosave.status}
        lastSavedAt={autosave.lastSavedAt}
        onSave={() => void autosave.saveNow()}
        onDiscard={() => setDraft(draftFrom(template))}
        error={autosave.error?.message ?? null}
        saveDisabledReason={saveDisabledReason}
        subject="this template"
        saveLabel="Save the template"
        note="Templates are not saved automatically: this one is offered to every colleague who makes a page, so a half-built arrangement saved mid-thought would be in front of all of them. Saving changes what future pages start as — pages already made from it keep the blocks they were given."
      />

      <AddSectionPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        insertAt={insertAt}
        total={draft.blocks.length}
        insertAfterName={
          insertAfter ? `${safeSectionMeta(insertAfter.type).label} — ${insertAfter.label}` : null
        }
        usedTypes={usedTypes}
        onAdd={addBlock}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// One block
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface BlockRowProps {
  block: DraftBlock;
  index: number;
  total: number;
  onChange: (next: Partial<TemplateBlockSpec>) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  onInsertAfter: () => void;
}

function BlockRow({ block, index, total, onChange, onMove, onRemove, onInsertAfter }: BlockRowProps) {
  const meta = safeSectionMeta(block.type);
  const Glyph = sectionIcon(block.type);
  const overrideCount = block.overrides ? Object.keys(block.overrides).length : 0;

  return (
    <li className="rounded-md border border-line-200 bg-surface-50 px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            aria-hidden="true"
            className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line-200 bg-card text-ink-500"
          >
            <Glyph className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink-900">
              {/* The number is written out rather than left to the list's own marker: a marker is not
                  selectable text, and somebody reading this to a colleague needs to say "block four". */}
              {index + 1}. {meta.label}
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-500">{meta.description}</p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            icon={ArrowUp}
            disabled={index === 0}
            aria-label={`Move ${meta.label} up, to position ${index}`}
            onClick={() => onMove(-1)}
          />
          <Button
            variant="ghost"
            size="sm"
            icon={ArrowDown}
            disabled={index === total - 1}
            aria-label={`Move ${meta.label} down, to position ${index + 2}`}
            onClick={() => onMove(1)}
          />
          <Button
            variant="ghost"
            size="sm"
            icon={ListPlus}
            aria-label={`Add a block after ${meta.label}`}
            onClick={onInsertAfter}
          />
          <Button
            variant="ghost"
            size="sm"
            icon={X}
            aria-label={`Take ${meta.label} out of this template`}
            onClick={onRemove}
          />
        </div>
      </div>

      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <Field
          label="What it is called in the builder"
          help="The name on the row when somebody opens the page — “Hero — the programme in one line”. Never shown on the public site."
          maxLength={TEMPLATE_LIMITS.blockLabel}
          value={block.label}
        >
          <Input
            value={block.label}
            onChange={(event) => onChange({ label: event.target.value })}
            autoComplete="off"
          />
        </Field>

        <Field
          label="Why it is here"
          help="One sentence for the template's preview: what this block is for in this arrangement, and what to put in it."
          maxLength={TEMPLATE_LIMITS.blockPurpose}
          value={block.purpose}
        >
          <Textarea
            rows={2}
            value={block.purpose}
            onChange={(event) => onChange({ purpose: event.target.value })}
          />
        </Field>
      </div>

      {overrideCount > 0 ? (
        <HelpText className="mt-2">
          {overrideCount === 1
            ? "One setting is carried with this block"
            : `${overrideCount} settings are carried with this block`}{" "}
          — such as a heading it can state confidently, or a filter that makes it mean what the template
          says. They are kept as they are; the settings themselves are changed on the page afterwards.
        </HelpText>
      ) : null}
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The glyph
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The icon, as a closed grid rather than a text box.
 *
 * `FieldBlock`, NOT `Field`: this is a group of buttons, and a `<label>` wrapped round a button
 * forwards a stray click into the first one and folds every name inside into the accessible name
 * (Field.tsx). The list is exactly what the templates screen can draw — an icon it cannot resolve is
 * rendered as the neutral template glyph, so a picker offering more would let somebody choose one that
 * appears to have been accepted and was not.
 */
function IconChoice({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const stored = value.trim();
  const unknown = stored.length > 0 && !isKnownTemplateIcon(stored);

  return (
    <FieldBlock
      label="Glyph"
      help="The small picture beside the template's name. It carries no meaning of its own — the name is what a colleague reads — so pick whichever is nearest and move on."
    >
      <div className="flex flex-wrap gap-1.5">
        {TEMPLATE_ICON_NAMES.map((name) => {
          const Glyph = templateIcon(name);
          const chosen = name === stored;
          return (
            <button
              key={name}
              type="button"
              // `aria-pressed` rather than a radio group: these are buttons that set a value, and a
              // pressed state is what a screen reader needs to know which one is in force.
              aria-pressed={chosen}
              aria-label={humaniseTemplateIcon(name)}
              title={humaniseTemplateIcon(name)}
              onClick={() => onChange(chosen ? "" : name)}
              className={cn(
                "relative inline-flex h-9 w-9 items-center justify-center rounded-md border transition-colors",
                chosen
                  ? "border-purple-700 bg-purple-100 text-purple-700"
                  : "border-line-200 bg-card text-ink-500 hover:border-purple-200 hover:text-ink-900"
              )}
            >
              <Glyph aria-hidden="true" className="h-4 w-4" />
              {/* A VISIBLE tick as well as the fill. Colour never carries the signal alone (contract
                  §11) — and unlike a fill, a mark survives greyscale printing and forced-colours mode.
                  `aria-pressed` above carries the same fact to the accessibility tree. */}
              {chosen ? (
                <span
                  aria-hidden="true"
                  className="absolute -right-1 -top-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-purple-700 text-white"
                >
                  <Check className="h-2.5 w-2.5" />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {unknown ? (
        <HelpText tone="warn" className="mt-2">
          This template is stored with the glyph &ldquo;{stored}&rdquo;, which this version of the site
          cannot draw — it is shown as the plain template mark instead. Choosing one above replaces it.
        </HelpText>
      ) : stored.length === 0 ? (
        <HelpText className="mt-2">
          No glyph chosen, so the plain template mark is drawn. That is a perfectly good answer.
        </HelpText>
      ) : null}
    </FieldBlock>
  );
}
