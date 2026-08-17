"use client";

/**
 * TimelineForm — a chronology.
 *
 * THE DATE IS A TEXT BOX AND THAT IS THE WHOLE POINT OF IT. "c. 1780", "2024–26" and "Mughal period" are
 * the honest answers an archive gives, and a date picker would force a made-up precision — which, as the
 * schema says of `Craft.originYear`, is worse in an archive than no date at all. The help text and the
 * placeholder both show what is allowed, because a text box where a date is expected otherwise looks
 * like a mistake.
 *
 * ENTRIES ARE NOT SORTED FOR YOU. There is nothing to sort by: the dates are prose. The order in this
 * list is the order on the page, which is why the schema's own help says "oldest first unless you order
 * them otherwise" and why the reorder controls matter more here than anywhere else.
 */

import { timelineSectionSchema, type TimelineSectionData } from "@/lib/sections/schema";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { MediaFramingField } from "@/components/studio/fields/MediaFramingField";
import { RepeaterField } from "@/components/studio/fields/RepeaterField";
import type { SectionFormProps } from "@/components/studio/sections";

const SHAPE = timelineSectionSchema.shape;
const ENTRY = SHAPE.entries.removeDefault().element.shape;

type TimelineEntry = TimelineSectionData["entries"][number];

/** Matches `.max(40)` on the entries array. */
const MAX_ENTRIES = 40;

export function TimelineForm({ data, onChange, onDirty }: SectionFormProps<TimelineSectionData>) {
  const update = (patch: Partial<TimelineSectionData>) => {
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

      <Field label="Which way it runs" help={SHAPE.orientation.description}>
        <Select
          value={data.orientation}
          options={[
            { value: "vertical", label: "Down the page — holds long entries" },
            { value: "horizontal", label: "Sideways — suits short ones" }
          ]}
          onChange={(event) =>
            update({ orientation: event.target.value as TimelineSectionData["orientation"] })
          }
        />
      </Field>

      <RepeaterField<TimelineEntry>
        label="The entries"
        help={SHAPE.entries.description}
        items={data.entries}
        onChange={(entries) => update({ entries })}
        max={MAX_ENTRIES}
        itemNoun="entry"
        addLabel="Add an entry"
        emptyMessage="No entries yet. A timeline needs at least two to read as one."
        createItem={() => ({ year: "", title: "", body: "", mediaId: "", mediaScreens: null })}
        isEmpty={(entry) =>
          [entry.year, entry.title, entry.body, entry.mediaId].every(
            (field) => field.trim().length === 0
          )
        }
        summary={(entry) => {
          const date = entry.year.trim();
          const title = entry.title.trim();
          if (date.length > 0 && title.length > 0) return `${date} — ${title}`;
          return date.length > 0 ? date : title;
        }}
        renderItem={({ item, update: updateEntry }) => (
          <>
            <Field label="The date" help={ENTRY.year.description} maxLength={24} value={item.year}>
              <Input
                value={item.year}
                onChange={(event) => updateEntry({ ...item, year: event.target.value })}
                placeholder="c. 1780"
              />
            </Field>

            <Field label="What happened" help={ENTRY.title.description} maxLength={120} value={item.title}>
              <Input
                value={item.title}
                onChange={(event) => updateEntry({ ...item, title: event.target.value })}
              />
            </Field>

            <Field label="The detail" help={ENTRY.body.description} maxLength={400} value={item.body}>
              <Textarea
                rows={3}
                value={item.body}
                onChange={(event) => updateEntry({ ...item, body: event.target.value })}
              />
            </Field>

            <MediaFramingField
              label="Picture for this entry"
              help={ENTRY.mediaId.description}
              framingHelp={ENTRY.mediaScreens.description}
              mediaId={item.mediaId}
              framing={item.mediaScreens}
              onChange={({ mediaId, framing }) => updateEntry({ ...item, mediaId, mediaScreens: framing })}
            />
          </>
        )}
      />
    </div>
  );
}
