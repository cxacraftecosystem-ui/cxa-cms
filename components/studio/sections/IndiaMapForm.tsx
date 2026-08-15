"use client";

/**
 * IndiaMapForm — the editor for the INDIA_MAP block, and deliberately a small one.
 *
 * Only the header is content on this block. The map itself is drawn from the archive — regions
 * with coordinates, counted from published crafts — so there is nothing of it to edit here, and
 * the form says so rather than leaving an editor hunting for fields that do not exist
 * (`indiaMapSectionSchema` owns that argument; PlatformPillarsForm is the same shape for the same
 * reason).
 */

import { indiaMapSectionSchema, type IndiaMapSectionData } from "@/lib/sections/schema";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { HelpText } from "@/components/studio/HelpText";
import type { SectionFormProps } from "@/components/studio/sections";

const MAP = indiaMapSectionSchema.shape;

export function IndiaMapForm({ data, onChange, onDirty }: SectionFormProps<IndiaMapSectionData>) {
  const update = (patch: Partial<IndiaMapSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  return (
    <div className="space-y-5">
      <Field
        label="Small line above the heading"
        help={MAP.eyebrow.description}
        maxLength={60}
        value={data.eyebrow}
      >
        <Input value={data.eyebrow} onChange={(event) => update({ eyebrow: event.target.value })} />
      </Field>

      <Field label="Heading" help={MAP.heading.description} maxLength={120} value={data.heading}>
        <Input value={data.heading} onChange={(event) => update({ heading: event.target.value })} />
      </Field>

      <Field label="Introduction" help={MAP.body.description} maxLength={320} value={data.body}>
        <Textarea rows={2} value={data.body} onChange={(event) => update({ body: event.target.value })} />
      </Field>

      <HelpText>
        The map draws itself from the archive: every craft region that has coordinates appears with
        a count of its published crafts, and each row of the list beside it links into the craft
        explorer filtered to that region. Give a region coordinates (or publish a craft in it) and
        it joins the map on the next rebuild; nothing on the map is typed in here.
      </HelpText>
    </div>
  );
}
