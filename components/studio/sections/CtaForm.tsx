"use client";

/**
 * CtaForm — the panel that asks the reader to do one thing.
 *
 * THE TONE IS THE ONLY INTERESTING FIELD, AND IT IS ABOUT THE PAGE RATHER THAN THE BLOCK. A second loud
 * purple panel on one page makes both of them ordinary; the schema's own help text says as much, and the
 * form repeats the consequence where the choice is made. It is not a warning the studio can raise
 * automatically — a page CAN legitimately carry two, one at the top of a long application page and one
 * at the foot — so it is a sentence beside the control rather than a rule.
 *
 * A PANEL WITH NO BUTTON IS AN INVITATION WITH NOWHERE TO GO. Both buttons are optional in the schema,
 * because a half-typed button must still save (rule 4 of `lib/sections/schema.ts`), so the form says when
 * neither will render rather than the page saying nothing at all.
 */

import { ctaSectionSchema, type CtaSectionData } from "@/lib/sections/schema";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { HelpText } from "@/components/studio/HelpText";
import { LinkField } from "@/components/studio/fields/LinkField";
import type { SectionFormProps } from "@/components/studio/sections";

const SHAPE = ctaSectionSchema.shape;

/** `cta()` wraps each button in `.default({})`; the default comes off before the shape is readable. */
const PRIMARY_CTA = SHAPE.primaryCta.removeDefault().shape;
const SECONDARY_CTA = SHAPE.secondaryCta.removeDefault().shape;

function buttonRenders(button: { label: string; href: string }): boolean {
  // The renderer draws a button only when it has BOTH words and a link — a labelled button with no link
  // is a dead control and a linked button with no words is invisible (`cta()` in the schema).
  return button.label.trim().length > 0 && button.href.trim().length > 0;
}

export function CtaForm({ data, onChange, onDirty }: SectionFormProps<CtaSectionData>) {
  const update = (patch: Partial<CtaSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  const anyButton = buttonRenders(data.primaryCta) || buttonRenders(data.secondaryCta);

  return (
    <div className="space-y-5">
      <Field
        label="Small line above the heading"
        help={SHAPE.eyebrow.description}
        maxLength={60}
        value={data.eyebrow}
      >
        <Input value={data.eyebrow} onChange={(event) => update({ eyebrow: event.target.value })} />
      </Field>

      <Field label="The invitation" help={SHAPE.heading.description} maxLength={120} value={data.heading}>
        <Input
          value={data.heading}
          onChange={(event) => update({ heading: event.target.value })}
          placeholder="Work with us"
        />
      </Field>

      <Field label="What happens next" help={SHAPE.body.description} maxLength={320} value={data.body}>
        <Textarea rows={3} value={data.body} onChange={(event) => update({ body: event.target.value })} />
      </Field>

      <LinkField
        label="Main button"
        value={data.primaryCta}
        onChange={(next) => update({ primaryCta: next })}
        labelHelp={PRIMARY_CTA.label.description}
        hrefHelp={PRIMARY_CTA.href.description}
      />

      <LinkField
        label="Second button"
        value={data.secondaryCta}
        onChange={(next) => update({ secondaryCta: next })}
        labelHelp={SECONDARY_CTA.label.description}
        hrefHelp={SECONDARY_CTA.href.description}
      />

      {!anyButton ? (
        <HelpText tone="warn">
          Neither button will appear, because a button needs both words and an address. The panel will
          show its heading and text with nothing to act on.
        </HelpText>
      ) : null}

      <Field label="How loud the panel is" help={SHAPE.tone.description}>
        <Select
          value={data.tone}
          options={[
            { value: "brand", label: "Full-width purple panel" },
            { value: "quiet", label: "Quiet — sits on the page background" }
          ]}
          onChange={(event) => update({ tone: event.target.value as CtaSectionData["tone"] })}
        />
      </Field>

      {data.tone === "brand" ? (
        <HelpText>
          Use one of these per page. A second purple panel further down stops either of them meaning
          anything — choose the quiet tone for that one.
        </HelpText>
      ) : null}

      <Field label="Where the words sit" help={SHAPE.alignment.description}>
        <Select
          value={data.alignment}
          options={[
            { value: "left", label: "Left" },
            { value: "center", label: "Centred" },
            { value: "right", label: "Right" }
          ]}
          onChange={(event) => update({ alignment: event.target.value as CtaSectionData["alignment"] })}
        />
      </Field>
    </div>
  );
}
