"use client";

/**
 * PlatformPillarsForm — the editor for the PLATFORM_PILLARS block, and deliberately a small one.
 *
 * Only the header is content on this block. The three instruments beneath it — the living archive,
 * the field record and the intelligence layer — are fixed, designed vignettes whose drawings and
 * one-line captions are code (`platformPillarsSectionSchema` owns that argument), so there is
 * nothing of theirs to edit here and the form says so rather than leaving an editor hunting for
 * fields that do not exist.
 *
 * The usual promises hold (see components/studio/sections/index.ts): controlled state, the WHOLE
 * payload on every `onChange`, `onDirty` called by hand, help text read off the schema's own
 * `.describe()` so the sentence beside the field is the sentence the save enforces.
 */

import {
  platformPillarsSectionSchema,
  type PlatformPillarsSectionData
} from "@/lib/sections/schema";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { HelpText } from "@/components/studio/HelpText";
import type { SectionFormProps } from "@/components/studio/sections";

const PILLARS = platformPillarsSectionSchema.shape;

export function PlatformPillarsForm({
  data,
  onChange,
  onDirty
}: SectionFormProps<PlatformPillarsSectionData>) {
  const update = (patch: Partial<PlatformPillarsSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  return (
    <div className="space-y-5">
      <Field
        label="Small line above the heading"
        help={PILLARS.eyebrow.description}
        maxLength={60}
        value={data.eyebrow}
      >
        <Input value={data.eyebrow} onChange={(event) => update({ eyebrow: event.target.value })} />
      </Field>

      <Field label="Heading" help={PILLARS.heading.description} maxLength={120} value={data.heading}>
        <Input value={data.heading} onChange={(event) => update({ heading: event.target.value })} />
      </Field>

      <Field label="Introduction" help={PILLARS.body.description} maxLength={320} value={data.body}>
        <Textarea rows={2} value={data.body} onChange={(event) => update({ body: event.target.value })} />
      </Field>

      <HelpText>
        The three instruments themselves — the living archive, the field record and the intelligence
        layer — are drawings with fixed words, designed as part of the site. They cannot be edited
        here; only the heading above them is yours.
      </HelpText>
    </div>
  );
}
