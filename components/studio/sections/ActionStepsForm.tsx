"use client";

/**
 * ActionStepsForm — a numbered sequence a reader is meant to follow: how to apply, what to bring, a
 * submission checklist.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ORDER IS THE CONTENT, which is what separates this block from a feature grid. A reader who does step
 * three before step two has been given the wrong instructions, so the affordance that matters most here is
 * REORDERING — and `RepeaterField` is used precisely because it reorders from the keyboard as well as by
 * dragging, and announces every move. Drag is the discoverable route and it is unusable with a keyboard or
 * a screen reader; the "Move up" and "Move down" buttons on every row are what make the order editable by
 * everybody (see that component's header).
 *
 * THE NUMBERS ARE DRAWN BY THE RENDERER, NEVER TYPED. Nothing here asks for "1." at the start of a step,
 * and `numbered` is the switch that decides whether they appear at all — off for a checklist where the
 * order does not matter. A step numbered by hand goes wrong the first time one is inserted in the middle,
 * and the row it breaks is the one nobody re-reads.
 *
 * ⚠ THE DEADLINE AND THE STATUS CAN DISAGREE, AND THE FORM SAYS SO RATHER THAN RECONCILING THEM. `deadline`
 * is a date and `status` is the editor's word for where the step stands; the renderer states a passed
 * deadline as passed whatever the status says, so the page cannot contradict itself. The alternative —
 * quietly recolouring or hiding a step whose date has gone — is a checklist nobody can trust, and the
 * reader who needed that step is exactly the reader who will not discover it is missing (contract §1.6).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * EACH STEP'S LINK IS OPTIONAL AND IT CHANGES WHAT THE STEP IS. With an address the step carries a button;
 * without one it is a plain instruction. `ctaLabel` is the words on that button and it falls back to "Open
 * this step" — which the field says, because a default nobody is told about is a default that surprises
 * somebody on a live page.
 *
 * THERE IS NO EYEBROW FIELD, and that is the schema's decision rather than an omission: this block sits on
 * a page somebody has arrived at in order to DO something, and a decorative category line above the
 * instructions is one more thing between them and the deadline.
 */

import { actionStepsSectionSchema, type ActionStepsSectionData } from "@/lib/sections/schema";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { Textarea } from "@/components/ui/Textarea";
import { HelpText } from "@/components/studio/HelpText";
import { LinkDestinationField } from "@/components/studio/fields/LinkField";
import { RepeaterField } from "@/components/studio/fields/RepeaterField";
import type { SectionFormProps } from "@/components/studio/sections";

const SHAPE = actionStepsSectionSchema.shape;
const STEP = SHAPE.steps.removeDefault().element.shape;

type ActionStep = ActionStepsSectionData["steps"][number];
type StepStatus = ActionStep["status"];

/** ⚠ Matches `.max(16)` on the steps array. A different number here caps a list the save would allow. */
const MAX_STEPS = 16;

/**
 * The status words as an administrator says them.
 *
 * `""` is "not stated" and it comes FIRST, because most checklists are a list of things to do rather than a
 * set of windows that open and close — the honest default is to say nothing about a step's state.
 */
const STATUS_OPTIONS: readonly { value: StepStatus; label: string }[] = [
  { value: "", label: "Not stated — no word is shown" },
  { value: "open", label: "Open — this step can be done now" },
  { value: "closed", label: "Closed — the window has passed" },
  { value: "coming", label: "Not open yet — it opens later" }
];

function isStatus(value: string): value is StepStatus {
  return STATUS_OPTIONS.some((option) => option.value === value);
}

/** Today, as the `<input type="date">` and the schema both want it: `YYYY-MM-DD` in local time. */
function todayValue(): string {
  const now = new Date();
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function ActionStepsForm({
  data,
  onChange,
  onDirty
}: SectionFormProps<ActionStepsSectionData>) {
  const update = (patch: Partial<ActionStepsSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  return (
    <div className="space-y-5">
      <Field label="Heading" help={SHAPE.heading.description} maxLength={120} value={data.heading}>
        <Input
          value={data.heading}
          onChange={(event) => update({ heading: event.target.value })}
          placeholder="How to apply"
        />
      </Field>

      <Field label="Introduction" help={SHAPE.body.description} maxLength={320} value={data.body}>
        <Textarea rows={2} value={data.body} onChange={(event) => update({ body: event.target.value })} />
      </Field>

      <Switch
        label="Number the steps"
        description={SHAPE.numbered.description}
        checked={data.numbered}
        onCheckedChange={(checked) => update({ numbered: checked })}
      />

      <RepeaterField<ActionStep>
        label="The steps"
        help={SHAPE.steps.description}
        items={data.steps}
        onChange={(steps) => update({ steps })}
        max={MAX_STEPS}
        itemNoun="step"
        addLabel="Add a step"
        emptyMessage="No steps yet. Add the first thing a reader has to do."
        createItem={() => ({
          title: "",
          detail: "",
          href: "",
          ctaLabel: "",
          deadline: "",
          status: ""
        })}
        isEmpty={(step) =>
          [step.title, step.detail, step.href, step.ctaLabel, step.deadline].every(
            (field) => field.trim().length === 0
          ) && step.status === ""
        }
        summary={(step) => step.title}
        renderItem={({ item, index, update: updateStep }) => {
          const hasHref = item.href.trim().length > 0;

          return (
            <>
              <Field label="What this step is" help={STEP.title.description} maxLength={120} value={item.title}>
                <Input
                  value={item.title}
                  onChange={(event) => updateStep({ ...item, title: event.target.value })}
                  // No "1." in the example: the number is the renderer's. See the header.
                  placeholder={index === 0 ? "Read the eligibility notes" : "Send two references"}
                />
              </Field>

              <Field label="The detail" help={STEP.detail.description} maxLength={600} value={item.detail}>
                <Textarea
                  rows={3}
                  value={item.detail}
                  onChange={(event) => updateStep({ ...item, detail: event.target.value })}
                />
              </Field>

              <LinkDestinationField
                label="Where this step goes"
                value={item.href}
                help={STEP.href.description}
                onChange={(href) => updateStep({ ...item, href })}
              />

              {hasHref ? (
                <Field
                  label="Words on this step's button"
                  help={STEP.ctaLabel.description}
                  maxLength={40}
                  value={item.ctaLabel}
                >
                  <Input
                    value={item.ctaLabel}
                    onChange={(event) => updateStep({ ...item, ctaLabel: event.target.value })}
                    placeholder="Open the application form"
                  />
                </Field>
              ) : (
                // The field is ABSENT rather than shown empty: words for a button that cannot appear are
                // words nobody will ever read, and an empty box invites somebody to fill it in for nothing.
                <HelpText>
                  Add an address above and a button appears on this step, with words you can set here.
                </HelpText>
              )}

              <Field
                label="Closing date for this step"
                help={STEP.deadline.description}
                value={item.deadline}
              >
                <Input
                  type="date"
                  value={item.deadline}
                  onChange={(event) => updateStep({ ...item, deadline: event.target.value })}
                  // Nothing before today is refused — a step whose date has gone is a normal thing to be
                  // looking at, and the page states it as passed rather than hiding it.
                  max="2999-12-31"
                />
              </Field>

              <Field label="Where this step stands" help={STEP.status.description}>
                <Select
                  value={item.status}
                  options={STATUS_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label
                  }))}
                  onChange={(event) => {
                    const next = event.target.value;
                    if (isStatus(next)) updateStep({ ...item, status: next });
                  }}
                />
              </Field>

              {/*
                ⚠ The one place the two fields can contradict each other, said plainly where both are. The
                page does not resolve it by hiding either — see the header.
              */}
              {item.status === "open" &&
              item.deadline.trim().length > 0 &&
              item.deadline < todayValue() ? (
                <HelpText tone="warn">
                  This step is marked open, but its closing date has already passed. The page will say the
                  date has gone whatever is chosen here, so the two will read as a contradiction. Move the
                  date, or set the step to Closed.
                </HelpText>
              ) : null}
            </>
          );
        }}
      />
    </div>
  );
}
