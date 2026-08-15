"use client";

/**
 * FeatureGridForm — the editor for a grid of small cards.
 *
 * TWO THINGS WORTH KNOWING BEFORE EDITING THIS FILE.
 *
 * `columns` IS A NUMBER IN THE PAYLOAD AND A STRING IN THE `<select>`. Every HTML form control holds
 * text, so the value is converted on the way in — and it is converted with a check rather than a cast,
 * because a `Number(value) as 2 | 3 | 4` would put `NaN` into the payload the first time anything
 * unexpected reached the handler, and a `grid-cols-NaN` is an invisible layout collapse rather than a
 * validation message.
 *
 * THE CARD LINK IS OPTIONAL AND THAT CHANGES WHAT THE CARD IS. With a link the whole card is clickable;
 * without one it is a plain panel. The field says so, because "why is my card not clickable" is
 * otherwise unanswerable from the screen.
 */

import { featureGridSectionSchema, type FeatureGridSectionData } from "@/lib/sections/schema";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { IconPicker } from "@/components/studio/fields/IconPicker";
import { LinkDestinationField } from "@/components/studio/fields/LinkField";
import { RepeaterField } from "@/components/studio/fields/RepeaterField";
import type { SectionFormProps } from "@/components/studio/sections";

const SHAPE = featureGridSectionSchema.shape;
const ITEM = SHAPE.items.removeDefault().element.shape;

type FeatureItem = FeatureGridSectionData["items"][number];
type Columns = FeatureGridSectionData["columns"];

/** Matches `.max(12)` on the items array. */
const MAX_ITEMS = 12;

const COLUMN_OPTIONS = [
  { value: "2", label: "Two across" },
  { value: "3", label: "Three across" },
  { value: "4", label: "Four across" }
] as const;

/** A checked conversion, never a cast. See the header. */
function readColumns(raw: string, fallback: Columns): Columns {
  if (raw === "2") return 2;
  if (raw === "3") return 3;
  if (raw === "4") return 4;
  return fallback;
}

export function FeatureGridForm({
  data,
  onChange,
  onDirty
}: SectionFormProps<FeatureGridSectionData>) {
  const update = (patch: Partial<FeatureGridSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

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

      <Field label="Heading" help={SHAPE.heading.description} maxLength={120} value={data.heading}>
        <Input value={data.heading} onChange={(event) => update({ heading: event.target.value })} />
      </Field>

      <Field label="Introduction" help={SHAPE.body.description} maxLength={320} value={data.body}>
        <Textarea rows={2} value={data.body} onChange={(event) => update({ body: event.target.value })} />
      </Field>

      <Field label="Cards across a wide screen" help={SHAPE.columns.description}>
        <Select
          value={String(data.columns)}
          options={COLUMN_OPTIONS}
          onChange={(event) => update({ columns: readColumns(event.target.value, data.columns) })}
        />
      </Field>

      <RepeaterField<FeatureItem>
        label="The cards"
        help={SHAPE.items.description}
        items={data.items}
        onChange={(items) => update({ items })}
        max={MAX_ITEMS}
        itemNoun="card"
        createItem={() => ({ icon: "", title: "", body: "", href: "" })}
        isEmpty={(item) =>
          [item.icon, item.title, item.body, item.href].every((field) => field.trim().length === 0)
        }
        summary={(item) => item.title}
        renderItem={({ item, update: updateItem }) => (
          <>
            <Field label="Title" help={ITEM.title.description} maxLength={80} value={item.title}>
              <Input
                value={item.title}
                onChange={(event) => updateItem({ ...item, title: event.target.value })}
              />
            </Field>

            <Field label="What it says" help={ITEM.body.description} maxLength={280} value={item.body}>
              <Textarea
                rows={3}
                value={item.body}
                onChange={(event) => updateItem({ ...item, body: event.target.value })}
              />
            </Field>

            <IconPicker
              value={item.icon}
              onChange={(icon) => updateItem({ ...item, icon })}
              help={ITEM.icon.description}
            />

            <LinkDestinationField
              label="Where the card goes"
              value={item.href}
              help={ITEM.href.description}
              onChange={(href) => updateItem({ ...item, href })}
            />
          </>
        )}
      />
    </div>
  );
}
