"use client";

/**
 * ShowcaseForm — ONE editor for every block that pulls records out of the studio.
 *
 * Research areas, projects, people, publications, news, events, partners, files, crafts and gallery
 * albums all share the curation shape defined once by `showcase()` in `lib/sections/schema.ts`: which
 * records, how many, and a link to the full list. Six near-identical files would be six places to fix
 * the same wording and six chances for one of them to disagree with the others, so `ShowcaseFields`
 * below is the shared half and each block type contributes only its own filters and layout as
 * `children`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE THREE WAYS OF CHOOSING ARE RADIO BUTTONS WITH PLAIN LABELS.
 *
 * "Latest / Featured / Manual" is the vocabulary of the payload, not of the person curating a page.
 * The options read "The most recent", "Only the ones I have marked as featured" and "Exactly these, in
 * this order", and each one says what it will actually do for THIS kind of record — because "the most
 * recent" means most recently published for news and soonest first for events, and an editor who has to
 * guess which will guess wrong.
 *
 * ⚠ "FEATURED" DOES NOT MEAN THE SAME THING FOR EVERY RECORD TYPE, AND THE FORM SAYS SO. Research
 * areas, people, partners, files and albums have no featured flag in the database at all
 * (`prisma/schema.prisma`), so `lib/sections/resolve.ts` resolves "featured" for those to the order an
 * administrator arranged on their own screen. Telling an editor to go and mark a person as featured —
 * on a screen with no such switch — is the sort of small lie that costs somebody an afternoon.
 *
 * THE CHOSEN LIST SHOWS REAL TITLES AND SURVIVES A CHANGE OF MODE. `showcase()` keeps `ids` resident in
 * every mode on purpose (see its header): flicking to "The most recent" to see how it looks must not
 * throw away a hand-picked order that cannot be recovered. The form states that, so nobody avoids the
 * experiment out of fear.
 *
 * AND THE LIMIT STILL APPLIES IN MANUAL MODE. `manualShowcase()` slices the hand-picked list to
 * `limit`, so choosing ten items with a limit of six shows six. That is the one combination in this
 * form that silently loses content, so it is the one thing the form warns about outright.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import {
  eventShowcaseSectionSchema,
  newsShowcaseSectionSchema,
  peopleShowcaseSectionSchema,
  projectShowcaseSectionSchema,
  researchShowcaseSectionSchema,
  type EventShowcaseSectionData,
  type NewsShowcaseSectionData,
  type PeopleShowcaseSectionData,
  type ProjectShowcaseSectionData,
  type ResearchShowcaseSectionData
} from "@/lib/sections/schema";
import { cn } from "@/lib/utils";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { Textarea } from "@/components/ui/Textarea";
import { HelpText } from "@/components/studio/HelpText";
import { EntityPicker, type LookupKind } from "@/components/studio/fields/EntityPicker";
import { LinkField } from "@/components/studio/fields/LinkField";
import type { SectionFormProps } from "@/components/studio/sections";

/** The curation half of every showcase payload — the eight fields `showcase()` builds. */
export interface ShowcaseLike {
  eyebrow: string;
  heading: string;
  body: string;
  mode: "latest" | "featured" | "manual";
  limit: number;
  ids: string[];
  ctaLabel: string;
  ctaHref: string;
}

/** `idList(24)` in the schema. The chosen list and the picker have to agree on it. */
const MAX_IDS = 24;

export interface ShowcaseHelp {
  eyebrow?: string;
  heading?: string;
  body?: string;
  mode?: string;
  limit?: string;
  ids?: string;
  ctaLabel?: string;
  ctaHref?: string;
}

/**
 * Read the schema's own `.describe()` sentences off a Zod shape.
 *
 * The parameter is `unknown` deliberately. A Zod shape's static type is generated — `.extend()` returns
 * a mapped intersection — and pinning that type here would tie this file to Zod's internals for no
 * benefit. Every read is guarded instead, so a shape missing a key produces no help sentence rather
 * than a crash, and the sentences themselves are never duplicated into this file.
 */
export function showcaseHelp(shape: unknown): ShowcaseHelp {
  const source = (shape ?? {}) as Record<string, { description?: unknown } | undefined>;
  const read = (key: keyof ShowcaseHelp): string | undefined => {
    const value = source[key]?.description;
    return typeof value === "string" ? value : undefined;
  };
  return {
    eyebrow: read("eyebrow"),
    heading: read("heading"),
    body: read("body"),
    mode: read("mode"),
    limit: read("limit"),
    ids: read("ids"),
    ctaLabel: read("ctaLabel"),
    ctaHref: read("ctaHref")
  };
}

export interface ShowcaseFieldsProps<T extends ShowcaseLike> {
  data: T;
  onChange: (next: T) => void;
  onDirty?: () => void;
  /** Which table the hand-picked list names. */
  kind: LookupKind;
  /** The plural noun, in the words an administrator uses: "projects", "news items". */
  plural: string;
  /** What "the most recent" orders by here — taken from the schema's own wording. */
  latestMeaning: string;
  /**
   * What "featured" does for THIS record type. Five of them have no featured flag; say what actually
   * happens rather than pointing at a switch that does not exist.
   */
  featuredMeaning: string;
  /** The schema's `.max()` on `limit`. */
  maxLimit: number;
  help: ShowcaseHelp;
  /**
   * Fields that must be answered BEFORE the way of choosing, because they change what is being chosen.
   * Only the gallery needs it: its `source` decides whether a hand-picked list names albums or
   * individual pictures.
   */
  beforeChoice?: ReactNode;
  /** This block's own filters and layout choices. Rendered between the curation and the link. */
  children?: ReactNode;
}

export function ShowcaseFields<T extends ShowcaseLike>({
  data,
  onChange,
  onDirty,
  kind,
  plural,
  latestMeaning,
  featuredMeaning,
  maxLimit,
  help,
  beforeChoice,
  children
}: ShowcaseFieldsProps<T>) {
  const modeName = `${useId()}mode`;

  /**
   * One patch, one change notification.
   *
   * The cast is the single unchecked step in this file, and it is a TypeScript limitation rather than a
   * widening: `patch` only ever carries keys of `ShowcaseLike`, every one of which is present on `T` by
   * its constraint, but a spread onto a generic cannot be verified. Keeping it here means no call site
   * needs one.
   */
  const update = (patch: Partial<ShowcaseLike>) => {
    onChange({ ...data, ...patch } as T);
    onDirty?.();
  };

  const manual = data.mode === "manual";
  const overLimit = manual && data.ids.length > data.limit;

  return (
    <div className="space-y-5">
      <Field label="Small line above the heading" help={help.eyebrow} maxLength={60} value={data.eyebrow}>
        <Input value={data.eyebrow} onChange={(event) => update({ eyebrow: event.target.value })} />
      </Field>

      <Field label="Heading" help={help.heading} maxLength={120} value={data.heading}>
        <Input value={data.heading} onChange={(event) => update({ heading: event.target.value })} />
      </Field>

      <Field label="Introduction" help={help.body} maxLength={320} value={data.body}>
        <Textarea rows={2} value={data.body} onChange={(event) => update({ body: event.target.value })} />
      </Field>

      {/*
        A real radio group: three native inputs sharing a name, so the arrow keys work, only one can be
        chosen and the whole thing appears in the accessibility tree as one question with three answers.
        `role="radiogroup"` + `aria-labelledby` rather than a `<fieldset>`, which brings its own layout
        quirks in a flex column, and rather than a heading, which would claim a rank in a document whose
        outline belongs to the screen around this form.
      */}
      {beforeChoice}

      {/* `aria-describedby` only when the sentence is actually rendered: pointing at a missing id is
          worse than not pointing at all (contract §11). */}
      <div
        role="radiogroup"
        aria-labelledby={`${modeName}label`}
        aria-describedby={help.mode ? `${modeName}help` : undefined}
      >
        <span id={`${modeName}label`} className="field-label">
          How the {plural} are chosen
        </span>
        {help.mode ? (
          <p id={`${modeName}help`} className="mt-1 text-xs leading-relaxed text-ink-500">
            {help.mode}
          </p>
        ) : null}

        <div className="mt-2 space-y-1.5">
          <ModeOption
            name={modeName}
            checked={data.mode === "latest"}
            onChoose={() => update({ mode: "latest" })}
            label="The most recent"
            description={`Keeps itself up to date on its own — ${latestMeaning}. New ${plural} appear here as they are published, with no editing.`}
          />
          <ModeOption
            name={modeName}
            checked={data.mode === "featured"}
            onChoose={() => update({ mode: "featured" })}
            label="Only the ones I have marked as featured"
            description={featuredMeaning}
          />
          <ModeOption
            name={modeName}
            checked={manual}
            onChoose={() => update({ mode: "manual" })}
            label="Exactly these, in this order"
            description={`You choose each one and arrange them. Nothing is added automatically, so this block only changes when you change it.`}
          />
        </div>
      </div>

      {manual ? (
        <>
          <EntityPicker
            kind={kind}
            label={`The ${plural} to show`}
            help={help.ids}
            ids={data.ids}
            onChange={(ids) => update({ ids })}
            max={MAX_IDS}
            footnote={
              <>
                If one of these is later unpublished it will not appear on the page, and this list will
                show it as a draft. If it is deleted, this list will show it as missing. Your chosen order
                is kept if you switch to another way of choosing and back again.
              </>
            }
          />

          {overLimit ? (
            <HelpText tone="warn">
              You have chosen {data.ids.length}, but the most this block will show is {data.limit}. Only
              the first {data.limit} in the list above will appear. Raise the number below, or take some
              out.
            </HelpText>
          ) : null}
        </>
      ) : null}

      <NumberField
        label="At most how many to show"
        help={help.limit}
        value={data.limit}
        onChange={(limit) => update({ limit })}
        min={1}
        max={maxLimit}
        integer
        inputClassName="max-w-[8rem]"
      />

      {children}

      <LinkField
        label="The link below the block"
        labelFieldLabel="Words on the link"
        value={{ label: data.ctaLabel, href: data.ctaHref }}
        onChange={(next) => update({ ctaLabel: next.label, ctaHref: next.href })}
        labelHelp={help.ctaLabel}
        hrefHelp={help.ctaHref}
      />
    </div>
  );
}

export interface NumberFieldProps {
  label: string;
  help?: string;
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  /** Whole numbers only. Off means a decimal is allowed — a coordinate. */
  integer?: boolean;
  className?: string;
  /** Goes to the input itself; number boxes are narrow and the wrapper is what a caller lays out. */
  inputClassName?: string;
}

/**
 * A number box that lets a person type a number.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE OBVIOUS VERSION OF THIS CANNOT BE TYPED IN, AND THAT IS WHY IT EXISTS.
 *
 * `value={String(data.latitude)}` with `onChange={parse}` is a controlled input that rejects every state
 * on the way to a number. Type "26." and the parse yields 26, React writes "26" back into the box, the
 * decimal point disappears, and the next digit makes 269 — clamped to 90. A latitude cannot be entered at
 * all. Clearing the box to retype has the same shape: the empty string parses to nothing, the old figure
 * is written straight back, and backspace appears not to work.
 *
 * So the BOX holds a draft string and the PAYLOAD holds the number. A draft that does not parse commits
 * nothing and is left alone; one that does parse is clamped and committed. On blur the box is made to
 * agree with what was actually stored, because a box still showing "200" after 90 was saved is a plain
 * lie about what is on the page.
 *
 * The reseed only fires when the value changed for a reason that was NOT our own commit — a discarded
 * draft, a restored revision. Reseeding on every value change would fight the reader mid-keystroke, which
 * is the bug this component is here to avoid.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * It lives in this file because both this form and SimpleForms.tsx need it and `components/ui/` has no
 * number primitive yet. If one is added, this is what it should replace.
 */
export function NumberField({
  label,
  help,
  value,
  onChange,
  min,
  max,
  integer = false,
  className,
  inputClassName
}: NumberFieldProps) {
  const [draft, setDraft] = useState(() => String(value));
  const committed = useRef(value);

  useEffect(() => {
    if (value === committed.current) return;
    committed.current = value;
    setDraft(String(value));
  }, [value]);

  const commit = (raw: string) => {
    setDraft(raw);
    const trimmed = raw.trim();
    const parsed = integer ? Number.parseInt(trimmed, 10) : Number.parseFloat(trimmed);
    // "", "-" and "-0" are states on the way to a number, not mistakes. Nothing is committed for them and
    // the draft is left exactly as typed.
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(Math.max(parsed, min), max);
    committed.current = clamped;
    onChange(clamped);
  };

  return (
    <Field label={label} help={help} className={className}>
      <Input
        type="number"
        inputMode={integer ? "numeric" : "decimal"}
        step={integer ? 1 : "any"}
        min={min}
        max={max}
        value={draft}
        onChange={(event) => commit(event.target.value)}
        onBlur={() => setDraft(String(committed.current))}
        className={inputClassName}
      />
    </Field>
  );
}

function ModeOption({
  name,
  checked,
  onChoose,
  label,
  description
}: {
  name: string;
  checked: boolean;
  onChoose: () => void;
  label: string;
  description: string;
}) {
  const uid = useId();
  const inputId = `${uid}radio`;
  const descriptionId = `${uid}description`;

  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 transition",
        checked ? "border-purple-300 bg-purple-50" : "border-line-200 bg-card"
      )}
    >
      {/*
        A wrapping `<label>` is right here for the same reason it is in Checkbox.tsx: the radio is the
        only labelable thing inside it, so the whole row becomes the target and nothing is folded into
        an accessible name that should not be.
      */}
      <label htmlFor={inputId} className="flex min-h-9 cursor-pointer items-center gap-3">
        <input
          id={inputId}
          type="radio"
          name={name}
          checked={checked}
          onChange={onChoose}
          aria-describedby={descriptionId}
          // The platform outline is kept and the brand ring added, exactly as Checkbox.tsx does: on a
          // 16px control the outline is the strongest cue there is, and a bare `ring-4` would be stock
          // blue (contract §3).
          className="h-4 w-4 shrink-0 accent-purple-700 focus-visible:ring-4 focus-visible:ring-purple-600/15"
        />
        <span className={cn("text-sm", checked ? "font-medium text-ink-900" : "text-ink-900")}>
          {label}
        </span>
      </label>
      {/* Outside the label, so it is a description rather than part of the option's name. */}
      <p id={descriptionId} className="ml-7 text-xs leading-relaxed text-ink-500">
        {description}
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The five block types whose only extra fields are filters and layout
//
// Each one passes its own schema's descriptions through `showcaseHelp`, so every sentence on screen is
// the sentence `lib/sections/schema.ts` wrote for it — including the parts that name the record type.
// ─────────────────────────────────────────────────────────────────────────────

const RESEARCH = researchShowcaseSectionSchema.shape;
const PROJECT = projectShowcaseSectionSchema.shape;
const PEOPLE = peopleShowcaseSectionSchema.shape;
const NEWS = newsShowcaseSectionSchema.shape;
const EVENT = eventShowcaseSectionSchema.shape;

/**
 * Why every `<select>` below ends in a cast.
 *
 * A native select can only ever hand back one of the `value`s it was given, and each list here is a
 * literal declared beside its handler. The alternative — a runtime guard per enum — would be five
 * copies of the same check for a value that cannot be anything else. Where a bad value would be
 * DANGEROUS rather than merely impossible (a number that could become `NaN`) it is checked instead; see
 * `readLimit` above and `readColumns` in FeatureGridForm.
 */

export function ResearchShowcaseForm({
  data,
  onChange,
  onDirty
}: SectionFormProps<ResearchShowcaseSectionData>) {
  const update = (patch: Partial<ResearchShowcaseSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  return (
    <ShowcaseFields
      data={data}
      onChange={onChange}
      onDirty={onDirty}
      kind="research"
      plural="research areas"
      latestMeaning="most recently published first"
      featuredMeaning="Research areas have no featured setting, so this shows them in the order you arranged on the research screen. It is the same list as the most recent, ordered your way instead of by date."
      maxLimit={24}
      help={showcaseHelp(RESEARCH)}
    >
      <Field label="How they are shown" help={RESEARCH.layout.description}>
        <Select
          value={data.layout}
          options={[
            { value: "grid", label: "A card for each area" },
            { value: "graph", label: "The interactive map of how they connect" }
          ]}
          onChange={(event) =>
            update({ layout: event.target.value as ResearchShowcaseSectionData["layout"] })
          }
        />
      </Field>
    </ShowcaseFields>
  );
}

export function ProjectShowcaseForm({
  data,
  onChange,
  onDirty
}: SectionFormProps<ProjectShowcaseSectionData>) {
  const update = (patch: Partial<ProjectShowcaseSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  return (
    <ShowcaseFields
      data={data}
      onChange={onChange}
      onDirty={onDirty}
      kind="project"
      plural="projects"
      latestMeaning="most recently started first"
      featuredMeaning="Shows only projects switched on as featured on their own screen, your arrangement first. If none are marked, the block will be empty and will say so."
      maxLimit={24}
      help={showcaseHelp(PROJECT)}
    >
      <Field label="Only projects at this stage" help={PROJECT.state.description}>
        <Select
          value={data.state}
          options={[
            { value: "", label: "Any stage" },
            { value: "PROPOSED", label: "Proposed" },
            { value: "ACTIVE", label: "Active" },
            { value: "COMPLETED", label: "Completed" },
            { value: "ON_HOLD", label: "On hold" }
          ]}
          onChange={(event) =>
            update({ state: event.target.value as ProjectShowcaseSectionData["state"] })
          }
        />
      </Field>

      <Field label="How they are shown" help={PROJECT.layout.description}>
        <Select
          value={data.layout}
          options={[
            { value: "grid", label: "Cards with cover pictures" },
            { value: "list", label: "A denser list" }
          ]}
          onChange={(event) =>
            update({ layout: event.target.value as ProjectShowcaseSectionData["layout"] })
          }
        />
      </Field>
    </ShowcaseFields>
  );
}

export function PeopleShowcaseForm({
  data,
  onChange,
  onDirty
}: SectionFormProps<PeopleShowcaseSectionData>) {
  const update = (patch: Partial<PeopleShowcaseSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  return (
    <ShowcaseFields
      data={data}
      onChange={onChange}
      onDirty={onDirty}
      kind="person"
      plural="people"
      latestMeaning="in the order set on the people page"
      featuredMeaning="People have no featured setting, so this shows whoever is at the top of the order set on the people page. Rearrange them there to change who appears."
      maxLimit={48}
      help={showcaseHelp(PEOPLE)}
    >
      <Field label="Only one group" help={PEOPLE.kind.description}>
        <Select
          value={data.kind}
          options={[
            { value: "", label: "Everyone" },
            { value: "DC_HANDICRAFTS", label: "DC, Handicrafts" },
            { value: "FACULTY", label: "Faculty" },
            { value: "SCIENTIST", label: "Scientists" },
            { value: "RESEARCHER", label: "Researchers" },
            { value: "STUDENT", label: "Students" },
            { value: "STAFF", label: "Staff" },
            { value: "VISITOR", label: "Visitors" },
            { value: "ALUMNUS", label: "Alumni" }
          ]}
          onChange={(event) => update({ kind: event.target.value as PeopleShowcaseSectionData["kind"] })}
        />
      </Field>

      <Field label="How they are shown" help={PEOPLE.layout.description}>
        <Select
          value={data.layout}
          options={[
            { value: "grid", label: "A grid over several lines" },
            { value: "row", label: "One scrolling line" }
          ]}
          onChange={(event) =>
            update({ layout: event.target.value as PeopleShowcaseSectionData["layout"] })
          }
        />
      </Field>

      <Switch
        label="Show each person's position under their name"
        description={PEOPLE.showRole.description}
        checked={data.showRole}
        onCheckedChange={(checked) => update({ showRole: checked })}
      />
    </ShowcaseFields>
  );
}

export function NewsShowcaseForm({ data, onChange, onDirty }: SectionFormProps<NewsShowcaseSectionData>) {
  const update = (patch: Partial<NewsShowcaseSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  return (
    <ShowcaseFields
      data={data}
      onChange={onChange}
      onDirty={onDirty}
      kind="news"
      plural="news items"
      latestMeaning="most recently published first"
      featuredMeaning="Shows only news items switched on as featured on their own screen. If none are marked, the block will be empty and will say so."
      maxLimit={24}
      help={showcaseHelp(NEWS)}
    >
      <Field label="How they are shown" help={NEWS.layout.description}>
        <Select
          value={data.layout}
          options={[
            { value: "feature", label: "A large first card, then small ones" },
            { value: "grid", label: "All the same size" },
            { value: "list", label: "Text only" }
          ]}
          onChange={(event) => update({ layout: event.target.value as NewsShowcaseSectionData["layout"] })}
        />
      </Field>
    </ShowcaseFields>
  );
}

export function EventShowcaseForm({
  data,
  onChange,
  onDirty
}: SectionFormProps<EventShowcaseSectionData>) {
  const update = (patch: Partial<EventShowcaseSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  return (
    <ShowcaseFields
      data={data}
      onChange={onChange}
      onDirty={onDirty}
      kind="event"
      plural="events"
      latestMeaning="soonest first"
      featuredMeaning="Shows only events switched on as featured on their own screen, still limited to the period chosen below."
      maxLimit={24}
      help={showcaseHelp(EVENT)}
    >
      <Field label="Which events" help={EVENT.when.description}>
        <Select
          value={data.when}
          options={[
            { value: "upcoming", label: "Still to come" },
            { value: "past", label: "Already happened" },
            { value: "all", label: "All of them" }
          ]}
          onChange={(event) => update({ when: event.target.value as EventShowcaseSectionData["when"] })}
        />
      </Field>

      <Field label="How they are shown" help={EVENT.layout.description}>
        <Select
          value={data.layout}
          options={[
            { value: "list", label: "Date, title and venue on one line" },
            { value: "grid", label: "Cards with cover pictures" }
          ]}
          onChange={(event) => update({ layout: event.target.value as EventShowcaseSectionData["layout"] })}
        />
      </Field>

      {data.when === "upcoming" ? (
        <HelpText>
          An upcoming block empties itself as events pass. On a page that must never look bare, choose
          all of them instead, or keep a second block of past events below it.
        </HelpText>
      ) : null}
    </ShowcaseFields>
  );
}
