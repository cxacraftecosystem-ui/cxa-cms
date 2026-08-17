"use client";

/**
 * QuoteForm — one quotation, set large across the column.
 *
 * NO QUOTATION MARKS IN THE TEXT. The design draws them, so a pasted pair renders as two sets — which
 * looks like a mistake nobody can find, because the second pair is in the CSS. The schema's help text
 * says it and the placeholder shows it.
 *
 * A QUOTATION WITH NOBODY BEHIND IT IS A SLOGAN. An unattributed quotation on an institutional page
 * reads as marketing rather than as something a person said, so the form asks for the name — it does not
 * refuse to save without one, because a half-finished block must always be savable (rule 4 of
 * `lib/sections/schema.ts`).
 */

import { quoteSectionSchema, type QuoteSectionData } from "@/lib/sections/schema";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { HelpText } from "@/components/studio/HelpText";
import { MediaFramingField } from "@/components/studio/fields/MediaFramingField";
import type { SectionFormProps } from "@/components/studio/sections";

const SHAPE = quoteSectionSchema.shape;

export function QuoteForm({ data, onChange, onDirty }: SectionFormProps<QuoteSectionData>) {
  const update = (patch: Partial<QuoteSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  const attributed = data.attribution.trim().length > 0;

  return (
    <div className="space-y-5">
      <Field label="The words" help={SHAPE.quote.description} maxLength={400} value={data.quote}>
        <Textarea
          rows={4}
          value={data.quote}
          onChange={(event) => update({ quote: event.target.value })}
          placeholder="The craft is not the object. It is what the hands know."
        />
      </Field>

      <Field label="Who said it" help={SHAPE.attribution.description} maxLength={80} value={data.attribution}>
        <Input
          value={data.attribution}
          onChange={(event) => update({ attribution: event.target.value })}
        />
      </Field>

      <Field label="Their position" help={SHAPE.role.description} maxLength={120} value={data.role}>
        <Input value={data.role} onChange={(event) => update({ role: event.target.value })} />
      </Field>

      {!attributed && data.quote.trim().length > 0 ? (
        <HelpText tone="warn">
          Nobody is named, so this will read as a slogan rather than as something a person said. Add a
          name above unless the quotation is deliberately anonymous.
        </HelpText>
      ) : null}

      {/*
        The panel is offered whenever a portrait is chosen, because this block has no state in which the
        picture is not drawn: `QuoteSection` renders the portrait as an image the moment one exists —
        there is no video path and no arrangement that parks it, so unlike the hero there is nothing to
        gate on. What the framing can usefully do here is narrow, and the schema's help says so.
      */}
      <MediaFramingField
        label="Portrait"
        help={SHAPE.portraitMediaId.description}
        framingHelp={SHAPE.portraitMediaScreens.description}
        mediaId={data.portraitMediaId}
        framing={data.portraitMediaScreens}
        onChange={({ mediaId, framing }) =>
          update({ portraitMediaId: mediaId, portraitMediaScreens: framing })
        }
      />

      <Field label="Where the quotation sits" help={SHAPE.alignment.description}>
        <Select
          value={data.alignment}
          options={[
            { value: "left", label: "Left" },
            { value: "center", label: "Centred" },
            { value: "right", label: "Right" }
          ]}
          onChange={(event) =>
            update({ alignment: event.target.value as QuoteSectionData["alignment"] })
          }
        />
      </Field>
    </div>
  );
}
