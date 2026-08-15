"use client";

/**
 * SectionEditorPanel — the settings for the one block that is selected.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT DISPATCHES; IT DOES NOT KNOW WHAT ANY BLOCK CONTAINS.
 *
 * Every block type has its own form in `components/studio/sections/`, and this panel finds it in a map
 * keyed by type. That is the whole of the coupling: adding a block type is a value in `SectionType`, a
 * schema in `lib/sections/schema.ts`, an entry in `lib/sections/registry.ts`, a renderer, and a form —
 * with nothing to change here. A `switch` over every type in this file would be one more
 * place to remember, and the one that gets forgotten.
 *
 * A TYPE WITH NO FORM RENDERS AN EXPLANATION, NEVER A CRASH AND NEVER A BLANK PANEL. `SECTION_FORMS` is
 * total, so this cannot happen for a type this build knows about — the case it covers is a `PageSection`
 * row written by a NEWER release and read after a rollback. Three things then have to be true at once and
 * all three are: the page still shows the block exactly as it did, its settings are untouched, and the
 * reader is told which of those facts they are looking at. A panel that threw would take the whole
 * builder down with it, with an editor's unsaved work behind it.
 *
 * A BLOCK WHOSE SETTINGS DO NOT VALIDATE IS STILL EDITED HERE. The problem is stated at the top of the
 * panel, in the words the save itself would have produced, and the form beneath it opens as normal. This
 * is the recovery path — a form that refused to open would leave a page that could only be repaired in
 * the database. Per-field messages are the FORMS' own business: they run the same isomorphic schema in
 * the browser and report beside the offending box while the editor is still typing, which is why
 * `components/studio/sections` has no `fieldErrors` prop and this panel does not invent one.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * IT OWNS NO STATE. Every keystroke goes straight up to the builder, which holds the working copy and
 * the autosave. Two components that both believe they know the current settings will eventually
 * disagree, and the one that is wrong is always the one on screen.
 */

import type { ComponentType } from "react";
import { Info, MousePointer2, TriangleAlert } from "lucide-react";
import type { SectionType } from "@prisma/client";

import type { SectionPayloads } from "@/lib/sections/schema";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { FormSection } from "@/components/studio/FormSection";
import { SECTION_FORMS, type SectionFormProps } from "@/components/studio/sections";
import {
  safeSectionMeta,
  sectionIcon,
  type BuilderSection
} from "@/components/studio/builder/SectionCard";

// ─────────────────────────────────────────────────────────────────────────────
// The contract every per-type form is written against
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A block's form.
 *
 * `SectionFormProps` is IMPORTED from `components/studio/sections` rather than restated here, because
 * that folder is where the forms are written and a second declaration of the same props
 * would be a second thing to keep in step — the exact drift this codebase avoids everywhere else by
 * having one table. `ComponentType` rather than their bare function type only so the value is usable as
 * JSX under every React version; a plain function component satisfies it.
 */
export type SectionFormComponent<T extends SectionType = SectionType> = ComponentType<
  SectionFormProps<SectionPayloads[T]>
>;

/**
 * Every form, keyed by type — PARTIAL on purpose, even though `SECTION_FORMS` is total.
 *
 * The gap this leaves open is real and is not "a form somebody has not written yet": it is a
 * `PageSection` row written by a NEWER release and read after a rollback, whose `type` this build has
 * never heard of. Rendering an explanation for that case is what keeps one unknown row from taking the
 * whole builder down with an editor's unsaved work behind it.
 */
export type SectionFormMap = { [K in SectionType]?: SectionFormComponent<K> };

/**
 * The dispatch shape.
 *
 * Indexing a `SectionFormMap` with a value typed `SectionType` gives TypeScript a union of every
 * component type, and rendering that union asks it to intersect all of their prop types —
 * which collapses to `never` for the same reason the `Record<level, ElementType>` lookup in
 * `components/ui/Heading.tsx` does. The cast on the way out restates the guarantee the map's key
 * already makes: the component at key `HERO` takes a hero's settings.
 */
type AnySectionForm = ComponentType<SectionFormProps<SectionPayloads[SectionType]>>;

// ─────────────────────────────────────────────────────────────────────────────
// The panel
// ─────────────────────────────────────────────────────────────────────────────

/** How long the editor's own name for a block may be. Long enough to be useful, short enough to read. */
export const SECTION_LABEL_MAX_LENGTH = 80;

export interface SectionEditorPanelProps {
  /** The selected block, or null when nothing is selected. */
  section: BuilderSection | null;
  /**
   * The block's settings, as the form should see them.
   *
   * ⚠ THE BUILDER'S RAW WORKING COPY, NOT A FRESHLY PARSED VALUE. The settings are normalised once, when
   * the screen opens, and are exactly what has been typed after that. Re-parsing on every keystroke and
   * feeding the result back would fight the reader: the text schemas `.trim()`, so the space just typed
   * between two words would vanish and the cursor would jump.
   */
  value: unknown;
  /** What cannot be saved about this block, in plain words, or null. */
  problem: string | null;
  /**
   * Whole-payload messages from the last validation. Only the `_form` entries are read here: the forms
   * validate their own fields against the same isomorphic schema and report beside the offending box
   * while the editor is still typing, which is why `components/studio/sections` deliberately has no
   * `fieldErrors` prop.
   */
  fieldErrors: Record<string, string[]> | null;
  /**
   * The forms to dispatch to. Defaults to `SECTION_FORMS`, which is every one of them; pass a narrower
   * map for a screen that may only edit some kinds of block.
   */
  forms?: SectionFormMap;
  /** 0-based, for the "block 3 of 7" readout. -1 when nothing is selected. */
  index: number;
  total: number;
  /** True when a request is in flight that would make an edit pointless — a delete, say. */
  disabled?: boolean;
  onLabelChange: (label: string) => void;
  onDataChange: (data: unknown) => void;
  onVisibleChange: (visible: boolean) => void;
  className?: string;
}

export function SectionEditorPanel({
  section,
  value,
  problem,
  fieldErrors,
  forms = SECTION_FORMS,
  index,
  total,
  disabled = false,
  onLabelChange,
  onDataChange,
  onVisibleChange,
  className
}: SectionEditorPanelProps) {
  if (section === null) {
    return (
      <FormSection
        title="Block settings"
        description="Choose a block on the left and its settings appear here."
        className={className}
      >
        <EmptyState
          icon={MousePointer2}
          // Level 3, because this FormSection already owns the h2 (contract §14).
          headingLevel={3}
          title="No block is selected"
          description="Every block on this page has its own settings — the words it shows, which records it pulls in, how it is laid out. Choose one from the list to open it."
        />
      </FormSection>
    );
  }

  const meta = safeSectionMeta(section.type);
  const Icon = sectionIcon(section.type);
  const Form = forms[section.type] as AnySectionForm | undefined;

  /** Anything the schema reported about the settings as a whole rather than about one field. */
  const formLevelErrors = fieldErrors?._form ?? [];

  return (
    <FormSection
      // FormSection's `title` is a string because it is also the region's accessible name, so the glyph
      // goes in `actions` rather than into the heading — a name that includes an icon is a name with a
      // gap in it.
      title={meta.label}
      description={meta.description}
      actions={
        <span className="flex items-center gap-2 text-xs text-ink-500">
          <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-purple-700" />
          <span className="tabular-nums">
            Block {index + 1} of {total}
          </span>
        </span>
      }
      className={className}
    >
      {problem ? (
        /*
          `role="alert"`: the reader has just been sent here to fix something, and the sentence naming
          what is wrong is the reason they came. It is the only interrupting message in this panel.
        */
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-amber-800/25 bg-amber-100 px-3 py-2.5 text-xs leading-relaxed text-amber-800"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <span className="block font-medium">This block cannot be saved as it stands.</span>
            <span className="mt-0.5 block">{problem}</span>
            {formLevelErrors.length > 0 ? (
              <span className="mt-1 block">{formLevelErrors.join(" ")}</span>
            ) : null}
            <span className="mt-1 block">
              Everything else on this page saves as normal in the meantime, and nothing that is already
              on the site has changed.
            </span>
          </span>
        </div>
      ) : null}

      <Field
        label="Name for this block"
        help="Only ever shown here in the studio, so a long page reads as “Hero banner — Autumn campaign” rather than as four blocks with the same name. Readers never see it. Leave it empty if the page is short enough not to need it."
        maxLength={SECTION_LABEL_MAX_LENGTH}
        value={section.label ?? ""}
      >
        <Input
          value={section.label ?? ""}
          onChange={(event) => onLabelChange(event.target.value)}
          disabled={disabled}
          placeholder={meta.label}
          autoComplete="off"
        />
      </Field>

      <Switch
        label="Show this block on the page"
        description="Turned off, the block stays here with everything in it but readers do not see it. Use it to take something down without losing the work, rather than deleting it."
        checked={section.isVisible}
        disabled={disabled}
        onCheckedChange={onVisibleChange}
      />

      <div className="border-t border-line-200 pt-5">
        {Form ? (
          <Form
            // Keyed by the block, so switching between two blocks of the same kind gives the form a
            // fresh instance rather than one that keeps the previous block's local state — an open
            // accordion, a focused row, a half-typed link.
            key={section.id}
            // The cast restates what the map's key already guarantees — see `AnySectionForm` above.
            data={value as SectionPayloads[SectionType]}
            onChange={onDataChange}
          />
        ) : (
          <div className="space-y-3">
            <p className="flex items-start gap-2 rounded-md border border-purple-200 bg-purple-50 px-3 py-2.5 text-xs leading-relaxed text-purple-700">
              <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {/* The label is NOT lowercased: for a block this version does not recognise it is the
                    stored value itself, and "some_new_block" reads worse in lower case than it does as
                    it is stored. */}
                <span className="block font-medium">
                  “{meta.label}” cannot be edited on this screen.
                </span>
                <span className="mt-0.5 block">
                  Nothing has been lost: the page still shows this block exactly as it did, and
                  everything stored in it is still stored. You can rename it, hide it, move it or delete
                  it from the list on the left. To change what is inside it, ask whoever looks after this
                  site.
                </span>
              </span>
            </p>

            {/*
              The stored settings, verbatim. This is the one place in the studio where raw stored values
              are shown, and it is here because it is the only thing a person can usefully pass on when
              reporting the missing screen. Read-only, and closed until asked for.
            */}
            <details className="rounded-md border border-line-200 bg-surface-50 px-3 py-2">
              <summary className="cursor-pointer text-xs font-medium text-ink-700">
                Show the settings stored for this block
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[0.6875rem] leading-relaxed text-ink-500">
                {safeStringify(value)}
              </pre>
            </details>
          </div>
        )}
      </div>
    </FormSection>
  );
}

/**
 * The stored settings as text.
 *
 * Guarded, because this value came out of a JSON column and back through a fetch: it should always be
 * serialisable, and "should always" is not a reason to let one odd row take the panel down. The fallback
 * says what happened rather than showing an empty box.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "Nothing is stored for this block yet.";
  } catch {
    return "These settings could not be shown as text. Ask whoever looks after this site to look at them.";
  }
}
