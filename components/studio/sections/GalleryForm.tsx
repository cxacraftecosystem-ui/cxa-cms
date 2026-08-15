"use client";

/**
 * GalleryForm — the editor for a wall of albums or of individual photographs.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * "ALBUMS OR PICTURES" IS THE FIRST QUESTION, NOT A LAYOUT DETAIL, BECAUSE IT CHANGES WHAT A
 * HAND-PICKED LIST MEANS.
 *
 * The gallery is the one block whose manual ids can name rows in two different tables (see
 * `galleryRowsFor` in `lib/sections/resolve.ts`): albums, or the pictures inside them. So `source` is
 * asked before the way of choosing — and switching it while a hand-picked list exists leaves that list
 * naming the wrong sort of record, which the page renders as nothing at all. The form says so, in
 * exactly the situation where it is true, rather than preventing a switch somebody may well want.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The rest is the shared curation shape — see ShowcaseForm.tsx, which is the one place any of it is
 * written.
 */

import { gallerySectionSchema, type GallerySectionData } from "@/lib/sections/schema";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { HelpText } from "@/components/studio/HelpText";
import { ShowcaseFields, showcaseHelp } from "@/components/studio/sections/ShowcaseForm";
import type { SectionFormProps } from "@/components/studio/sections";

const SHAPE = gallerySectionSchema.shape;

type Columns = GallerySectionData["columns"];

/** A checked conversion: a `grid-cols-NaN` is an invisible collapse rather than a message. */
function readColumns(raw: string, fallback: Columns): Columns {
  if (raw === "2") return 2;
  if (raw === "3") return 3;
  if (raw === "4") return 4;
  return fallback;
}

export function GalleryForm({ data, onChange, onDirty }: SectionFormProps<GallerySectionData>) {
  const update = (patch: Partial<GallerySectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  const showsImages = data.source === "images";
  const hasPicks = data.ids.length > 0;

  return (
    <ShowcaseFields
      data={data}
      onChange={onChange}
      onDirty={onDirty}
      // The hand-picked list names whichever table `source` chose. Getting this wrong would show album
      // titles for a list of pictures, which is unverifiable in exactly the way EntityPicker exists to
      // prevent.
      kind={showsImages ? "galleryImage" : "album"}
      plural={showsImages ? "pictures" : "albums"}
      latestMeaning="most recently published first"
      featuredMeaning="Albums have no featured setting, so this shows them in the order you arranged on the gallery screen. It is the same list as the most recent, ordered your way instead of by date."
      maxLimit={24}
      help={showcaseHelp(SHAPE)}
      beforeChoice={
        <>
          <Field label="Albums or the pictures themselves" help={SHAPE.source.description}>
            <Select
              value={data.source}
              options={[
                { value: "albums", label: "Albums — a cover for each, linking through" },
                { value: "images", label: "Pictures — the photographs themselves" }
              ]}
              onChange={(event) =>
                update({ source: event.target.value as GallerySectionData["source"] })
              }
            />
          </Field>

          {hasPicks && data.mode === "manual" ? (
            <HelpText tone="warn">
              You have {data.ids.length} chosen by hand. Changing the line above changes what that list
              is a list of, so those {showsImages ? "pictures" : "albums"} will show as missing and you
              will need to choose again.
            </HelpText>
          ) : null}
        </>
      }
    >
      <Field label="How they are arranged" help={SHAPE.layout.description}>
        <Select
          value={data.layout}
          options={[
            { value: "masonry", label: "Masonry — each picture keeps its own proportions" },
            { value: "grid", label: "Grid — all cropped to the same shape" },
            { value: "carousel", label: "Carousel — one scrolling line" }
          ]}
          onChange={(event) => update({ layout: event.target.value as GallerySectionData["layout"] })}
        />
      </Field>

      <Field label="How many across a wide screen" help={SHAPE.columns.description}>
        <Select
          value={String(data.columns)}
          options={[
            { value: "2", label: "Two across" },
            { value: "3", label: "Three across" },
            { value: "4", label: "Four across" }
          ]}
          onChange={(event) => update({ columns: readColumns(event.target.value, data.columns) })}
        />
      </Field>

      <Switch
        label="Open a picture full screen when it is clicked"
        description={SHAPE.lightbox.description}
        checked={data.lightbox}
        onCheckedChange={(checked) => update({ lightbox: checked })}
      />
    </ShowcaseFields>
  );
}
