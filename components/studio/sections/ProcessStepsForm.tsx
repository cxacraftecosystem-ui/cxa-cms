"use client";

/**
 * ProcessStepsForm — the editor for how a thing is made: the stages, in order, with a line drawn
 * between them as the reader descends.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS IS NOT "STEPS TO FOLLOW", AND THE DIFFERENCE IS WHOSE JOB THE STEPS ARE.
 *
 *   • ACTION_STEPS — "Steps to follow" — is a list of things the READER must do. It carries closing
 *     dates, buttons and an open/closed state, and being clear matters more than being beautiful.
 *   • PROCESS_STEPS — this block — describes what SOMEBODY ELSE does: the stages of dyeing a cloth,
 *     the firing of a pot. There is nothing to click and no deadline to miss.
 *
 * Which is why there is no date field, no button and no status on this screen. Putting a closing date
 * on a description of how indigo is fermented would be nonsense; putting a scrubbed drawing animation
 * on an application deadline would be worse. An editor who wants either of those wants the other
 * block, and the palette says so in its description.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE NUMBERS ARE DRAWN BY THE RENDERER, NEVER TYPED. Nothing here asks for "1." at the start of a
 * stage; `numbered` decides whether they appear at all, and it is turned off for a process whose
 * stages genuinely happen at once. A stage numbered by hand goes wrong the first time one is inserted
 * in the middle, and that is the row nobody re-reads.
 *
 * THE LAYOUT CHOICE IS ABOUT THE NUMBER OF STAGES, so the form says which one this block's own count
 * suits — a note rather than a rule, because the schema deliberately does not cross-validate the two
 * (schema rule 4: a rule that fires halfway through an edit refuses a save an editor is in the middle
 * of). Every narrow screen gets a single column whichever is chosen.
 */

import { processStepsSectionSchema, type ProcessStepsSectionData } from "@/lib/sections/schema";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { Textarea } from "@/components/ui/Textarea";
import { HelpText } from "@/components/studio/HelpText";
import { MediaFramingField } from "@/components/studio/fields/MediaFramingField";
import { RepeaterField } from "@/components/studio/fields/RepeaterField";
import { CraftImagePicker } from "@/components/studio/sections/CraftImagePicker";
import type { SectionFormProps } from "@/components/studio/sections";

const SHAPE = processStepsSectionSchema.shape;
const STEP = SHAPE.steps.removeDefault().element.shape;

type ProcessStep = ProcessStepsSectionData["steps"][number];

/** ⚠ Matches `.max(12)` on the steps array. A different number here caps a list the save would allow. */
const MAX_STEPS = 12;

/** Below this many stages the alternating layout has nothing to alternate between. */
const ALTERNATING_SUITS_FROM = 4;

/** The CSS words are the stored values; the British prose is what a person reads (schema header). */
const LAYOUT_OPTIONS = [
  { value: "alternating", label: "Alternating sides — suits four stages or more" },
  { value: "column", label: "A single column — suits two or three" }
] as const;

export function ProcessStepsForm({
  data,
  onChange,
  onDirty
}: SectionFormProps<ProcessStepsSectionData>) {
  const update = (patch: Partial<ProcessStepsSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  const alternatingButShort =
    data.layout === "alternating" &&
    data.steps.length > 0 &&
    data.steps.length < ALTERNATING_SUITS_FROM;

  return (
    <div className="space-y-5">
      <Field
        label="Small line above the heading"
        help={SHAPE.eyebrow.description}
        maxLength={60}
        value={data.eyebrow}
      >
        <Input
          value={data.eyebrow}
          onChange={(event) => update({ eyebrow: event.target.value })}
          placeholder="From fleece to shawl"
        />
      </Field>

      <Field label="Heading" help={SHAPE.heading.description} maxLength={120} value={data.heading}>
        <Input
          value={data.heading}
          onChange={(event) => update({ heading: event.target.value })}
          placeholder="How it is made"
        />
      </Field>

      <Field label="Introduction" help={SHAPE.body.description} maxLength={320} value={data.body}>
        <Textarea rows={2} value={data.body} onChange={(event) => update({ body: event.target.value })} />
      </Field>

      <Switch
        label="Number the stages"
        description={SHAPE.numbered.description}
        checked={data.numbered}
        onCheckedChange={(numbered) => update({ numbered })}
      />

      <Field label="How the stages are laid out" help={SHAPE.layout.description}>
        <Select
          value={data.layout}
          options={LAYOUT_OPTIONS}
          onChange={(event) =>
            update({ layout: event.target.value as ProcessStepsSectionData["layout"] })
          }
        />
      </Field>

      {/* A note, not a rule — see the header. */}
      {alternatingButShort ? (
        <HelpText>
          There{" "}
          {data.steps.length === 1 ? "is one stage" : `are ${data.steps.length} stages`}, so the
          alternating layout has little to alternate between and leaves a wide gap down one side. A
          single column reads better until there are {ALTERNATING_SUITS_FROM}.
        </HelpText>
      ) : null}

      <RepeaterField<ProcessStep>
        label="The stages"
        help={SHAPE.steps.description}
        items={data.steps}
        onChange={(steps) => update({ steps })}
        max={MAX_STEPS}
        itemNoun="stage"
        addLabel="Add a stage"
        emptyMessage="No stages yet. Add the first thing that happens — where the material comes from is usually it."
        createItem={() => ({
          title: "",
          detail: "",
          meta: "",
          mediaId: "",
          // Null, not a framing of six empty buckets: a new stage nobody has framed must serialise
          // exactly as one saved before this field existed (see the schema's note on the default).
          mediaScreens: null,
          craftImage: ""
        })}
        isEmpty={(step) =>
          [step.title, step.detail, step.meta, step.mediaId, step.craftImage].every(
            (value) => value.trim().length === 0
          )
        }
        summary={(step) => step.title}
        renderItem={({ item, index, update: updateStep }) => (
          <>
            <Field
              label="What happens at this stage"
              help={STEP.title.description}
              maxLength={120}
              value={item.title}
            >
              <Input
                value={item.title}
                onChange={(event) => updateStep({ ...item, title: event.target.value })}
                // No "1." in the example: the number is the renderer's. See the header.
                placeholder={index === 0 ? "Sorting the fleece" : "Dyeing"}
              />
            </Field>

            <Field label="What it involves" help={STEP.detail.description} maxLength={600} value={item.detail}>
              <Textarea
                rows={4}
                value={item.detail}
                onChange={(event) => updateStep({ ...item, detail: event.target.value })}
              />
            </Field>

            <Field
              label="How long it takes, or who does it"
              help={STEP.meta.description}
              maxLength={60}
              value={item.meta}
            >
              <Input
                value={item.meta}
                onChange={(event) => updateStep({ ...item, meta: event.target.value })}
                placeholder="Three days"
              />
            </Field>

            {/*
              Both layouts draw this photograph as an image at every width, so the panel is offered
              unconditionally — there is no video source here and no arrangement that parks the picture.
              The craft picker below needs no guard either: `MediaFramingField` shows the panel only once
              an UPLOADED photograph is chosen, and that is the only picture a framing can apply to.
            */}
            <MediaFramingField
              label="A photograph you have uploaded"
              help={STEP.mediaId.description}
              framingHelp={STEP.mediaScreens.description}
              mediaId={item.mediaId}
              framing={item.mediaScreens}
              onChange={({ mediaId, framing }) =>
                updateStep({ ...item, mediaId, mediaScreens: framing })
              }
            />

            <CraftImagePicker
              value={item.craftImage}
              onChange={(craftImage) => updateStep({ ...item, craftImage })}
              uploadedMediaId={item.mediaId}
              subject="this stage"
              help={STEP.craftImage.description}
            />
          </>
        )}
      />
    </div>
  );
}
