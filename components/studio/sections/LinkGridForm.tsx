"use client";

/**
 * LinkGridForm — a grid of onward destinations: guidelines, past papers, funding calls, a partner's page.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT IS BUILT FROM `LinkField`, AND THAT IS THE WHOLE VALUE OF THIS FORM. An address typed by hand is
 * usually wrong — "/About", "/about-us", "/research/roadmap " each look right in a text box and each is a
 * "page not found" on a live site. `LinkField` searches the site's own pages, fills in an address that
 * certainly exists, warns when one resolves to nothing, and fills in an empty label from the page it found.
 * That last part removes the commonest double entry on this screen: choosing "About the Centre" gives the
 * card its words as well as its destination.
 *
 * IT ALSO SAYS WHEN A CARD WILL NOT APPEAR, which is the failure this block is prone to. A card needs both
 * words and an address: with words alone it has nowhere to go, with an address alone there is nothing to
 * click. `LinkField` prints that sentence itself, beside the pair it is about — so it is not repeated here,
 * and there is one copy of it rather than two that can drift apart.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `RepeaterField` REORDERS FROM THE KEYBOARD as well as by dragging, and announces every move. The order of
 * a link grid is editorial — the first card is the one most readers want — so it has to be editable by
 * everybody and not only by somebody who can drag (see that component's header).
 *
 * ⚠ "OPENS IN A NEW TAB" IS THE EDITOR'S DECISION AND NOT A GUESS FROM THE ADDRESS, which is why it is a
 * switch on every row rather than something this form works out. Some absolute links belong in the same tab
 * — a partner page a reader is meant to move on to — and some internal ones are a download they will come
 * straight back from. The renderer pairs the choice with `rel="noopener noreferrer"` and a spoken "(opens
 * in a new tab)", because a reader whose focus lands in a new tab with no warning has lost their place and
 * their Back button with it.
 *
 * THE COLUMN COUNT IS A NUMBER IN THE PAYLOAD AND A STRING IN THE `<select>`, and it is converted with a
 * CHECK rather than a cast. `Number(value) as 2 | 3 | 4` would put `NaN` into the payload the first time
 * anything unexpected arrived, and a `grid-cols-NaN` is an invisible layout collapse rather than a message
 * anybody can act on (the same reasoning as FeatureGridForm).
 *
 * THERE IS NO EYEBROW AND NO INTRODUCTION, and that is the schema's decision: this block sits on a page
 * somebody has arrived at in order to find something, and a decorative line above the links is one more
 * thing between them and it.
 */

import { linkGridSectionSchema, type LinkGridSectionData } from "@/lib/sections/schema";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { Textarea } from "@/components/ui/Textarea";
import { IconPicker } from "@/components/studio/fields/IconPicker";
import { LinkField } from "@/components/studio/fields/LinkField";
import { RepeaterField } from "@/components/studio/fields/RepeaterField";
import type { SectionFormProps } from "@/components/studio/sections";

const SHAPE = linkGridSectionSchema.shape;
const ITEM = SHAPE.items.removeDefault().element.shape;

type GridLink = LinkGridSectionData["items"][number];
type Columns = LinkGridSectionData["columns"];

/** ⚠ Matches `.max(24)` on the items array. A different number here caps a list the save would allow. */
const MAX_LINKS = 24;

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

export function LinkGridForm({ data, onChange, onDirty }: SectionFormProps<LinkGridSectionData>) {
  const update = (patch: Partial<LinkGridSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  return (
    <div className="space-y-5">
      <Field label="Heading" help={SHAPE.heading.description} maxLength={120} value={data.heading}>
        <Input
          value={data.heading}
          onChange={(event) => update({ heading: event.target.value })}
          placeholder="Guidelines and forms"
        />
      </Field>

      <Field label="Links across a wide screen" help={SHAPE.columns.description}>
        <Select
          value={String(data.columns)}
          options={COLUMN_OPTIONS}
          onChange={(event) => update({ columns: readColumns(event.target.value, data.columns) })}
        />
      </Field>

      <RepeaterField<GridLink>
        label="The links"
        help={SHAPE.items.description}
        items={data.items}
        onChange={(items) => update({ items })}
        max={MAX_LINKS}
        itemNoun="link"
        addLabel="Add a link"
        emptyMessage="No links yet. Add the first destination — search for a page by its title rather than typing an address."
        createItem={() => ({ label: "", description: "", href: "", icon: "", external: false })}
        isEmpty={(link) =>
          [link.label, link.description, link.href, link.icon].every(
            (field) => field.trim().length === 0
          ) && !link.external
        }
        // The words are what name the card; a row with none is named "This link is empty" by the repeater
        // itself, so a half-filled row is still legible in the collapsed list.
        summary={(link) => link.label}
        renderItem={({ item, update: updateLink }) => (
          <>
            <LinkField
              label="The card"
              labelFieldLabel="Words on the card"
              value={{ label: item.label, href: item.href }}
              onChange={(next) => updateLink({ ...item, label: next.label, href: next.href })}
              labelHelp={ITEM.label.description}
              hrefHelp={ITEM.href.description}
              labelMaxLength={80}
            />

            <Field
              label="A line under the words"
              help={ITEM.description.description}
              maxLength={240}
              value={item.description}
            >
              <Textarea
                rows={2}
                value={item.description}
                onChange={(event) => updateLink({ ...item, description: event.target.value })}
              />
            </Field>

            <IconPicker
              value={item.icon}
              onChange={(icon) => updateLink({ ...item, icon })}
              help={ITEM.icon.description}
            />

            <Switch
              label="Opens in a new tab"
              description={ITEM.external.description}
              checked={item.external}
              onCheckedChange={(external) => updateLink({ ...item, external })}
            />
          </>
        )}
      />
    </div>
  );
}
