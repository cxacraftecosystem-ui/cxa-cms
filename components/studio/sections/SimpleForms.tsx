"use client";

/**
 * The block editors small enough not to need a file of their own — and one that is small only because
 * `ShowcaseFields` does the work.
 *
 * Exported individually rather than as a bundle, so `SECTION_FORMS` in index.ts reads as one name per
 * block type and nothing here is reached by an index nobody can search for.
 *
 * FOUR OF THESE ARE SHOWCASES. Partner logos, downloads, publications and the craft explorer all pull
 * records out of the studio with the same curation shape as the six in ShowcaseForm.tsx, so they compose
 * `ShowcaseFields` and add only their own filters. See that file's header for why the shared half exists
 * and, in particular, for why "featured" has to be explained differently for each record type — partners
 * and files have no featured flag in the database at all.
 *
 * THE OTHER THREE ARE THE BLOCKS THAT ARE NOT ABOUT RECORDS: the contact form, the map and the spacer.
 */

import {
  contactFormSectionSchema,
  craftExplorerSectionSchema,
  downloadsSectionSchema,
  mapSectionSchema,
  partnerLogosSectionSchema,
  publicationListSectionSchema,
  spacerSectionSchema,
  type ContactFormSectionData,
  type CraftExplorerSectionData,
  type DownloadsSectionData,
  type MapSectionData,
  type PartnerLogosSectionData,
  type PublicationListSectionData,
  type SpacerSectionData
} from "@/lib/sections/schema";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { Textarea } from "@/components/ui/Textarea";
import { HelpText } from "@/components/studio/HelpText";
import { LinkDestinationField } from "@/components/studio/fields/LinkField";
import { NumberField, ShowcaseFields, showcaseHelp } from "@/components/studio/sections/ShowcaseForm";
import type { SectionFormProps } from "@/components/studio/sections";

// ─────────────────────────────────────────────────────────────────────────────
// Partner logos
// ─────────────────────────────────────────────────────────────────────────────

const PARTNER = partnerLogosSectionSchema.shape;

type PartnerColumns = PartnerLogosSectionData["columns"];

function readPartnerColumns(raw: string, fallback: PartnerColumns): PartnerColumns {
  if (raw === "3") return 3;
  if (raw === "4") return 4;
  if (raw === "5") return 5;
  if (raw === "6") return 6;
  return fallback;
}

export function PartnerLogosForm({
  data,
  onChange,
  onDirty
}: SectionFormProps<PartnerLogosSectionData>) {
  const update = (patch: Partial<PartnerLogosSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  return (
    <ShowcaseFields
      data={data}
      onChange={onChange}
      onDirty={onDirty}
      kind="partner"
      plural="partners"
      latestMeaning="in the order set on the partners page"
      featuredMeaning="Partners have no featured setting, so this shows them in the order you arranged on the partners screen — the same list as the most recent, which is already your answer to which come first."
      maxLimit={48}
      help={showcaseHelp(PARTNER)}
    >
      <Field label="Logos across a wide screen" help={PARTNER.columns.description}>
        <Select
          value={String(data.columns)}
          options={[
            { value: "3", label: "Three across" },
            { value: "4", label: "Four across" },
            { value: "5", label: "Five across" },
            { value: "6", label: "Six across" }
          ]}
          onChange={(event) => update({ columns: readPartnerColumns(event.target.value, data.columns) })}
        />
      </Field>

      <Switch
        label="Draw every logo in one tone"
        description={PARTNER.monochrome.description}
        checked={data.monochrome}
        onCheckedChange={(checked) => update({ monochrome: checked })}
      />
    </ShowcaseFields>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Downloads
// ─────────────────────────────────────────────────────────────────────────────

const DOWNLOADS = downloadsSectionSchema.shape;

export function DownloadsForm({ data, onChange, onDirty }: SectionFormProps<DownloadsSectionData>) {
  const update = (patch: Partial<DownloadsSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  return (
    <ShowcaseFields
      data={data}
      onChange={onChange}
      onDirty={onDirty}
      kind="file"
      plural="files"
      latestMeaning="most recently added first"
      featuredMeaning="Files have no featured setting, so this shows the same newest-first list as the most recent."
      maxLimit={40}
      help={showcaseHelp(DOWNLOADS)}
    >
      <Field
        label="Only one category"
        help={DOWNLOADS.category.description}
        maxLength={60}
        value={data.category}
      >
        <Input
          value={data.category}
          onChange={(event) => update({ category: event.target.value })}
          placeholder="Datasets"
        />
      </Field>

      {data.category.trim().length > 0 ? (
        <HelpText>
          Capital letters do not matter here — a file filed under “datasets” matches “Datasets”. A
          category that no file uses gives an empty block, and the block says so.
        </HelpText>
      ) : null}

      <Switch
        label="Show the type and size of each file"
        description={DOWNLOADS.showFileSize.description}
        checked={data.showFileSize}
        onCheckedChange={(checked) => update({ showFileSize: checked })}
      />

      <Switch
        label="Show when each file was last replaced"
        description={DOWNLOADS.showUpdatedOn.description}
        checked={data.showUpdatedOn}
        onCheckedChange={(checked) => update({ showUpdatedOn: checked })}
      />
    </ShowcaseFields>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Publications
// ─────────────────────────────────────────────────────────────────────────────

const PUBLICATIONS = publicationListSectionSchema.shape;

export function PublicationListForm({
  data,
  onChange,
  onDirty
}: SectionFormProps<PublicationListSectionData>) {
  const update = (patch: Partial<PublicationListSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  return (
    <ShowcaseFields
      data={data}
      onChange={onChange}
      onDirty={onDirty}
      kind="publication"
      plural="publications"
      latestMeaning="newest year first"
      featuredMeaning="Shows only publications switched on as featured on their own screen. If none are marked, the block will be empty and will say so."
      maxLimit={60}
      help={showcaseHelp(PUBLICATIONS)}
    >
      <Field label="Only one sort" help={PUBLICATIONS.kind.description}>
        <Select
          value={data.kind}
          options={[
            { value: "", label: "Any sort" },
            { value: "JOURNAL_ARTICLE", label: "Journal articles" },
            { value: "CONFERENCE_PAPER", label: "Conference papers" },
            { value: "BOOK", label: "Books" },
            { value: "BOOK_CHAPTER", label: "Book chapters" },
            { value: "PATENT", label: "Patents" },
            { value: "DATASET", label: "Datasets" },
            { value: "SOFTWARE", label: "Software" },
            { value: "PREPRINT", label: "Preprints" },
            { value: "THESIS", label: "Theses" },
            { value: "REPORT", label: "Reports" },
            { value: "BOOKLET", label: "Booklets" },
            { value: "FLYER", label: "Flyers" }
          ]}
          onChange={(event) =>
            update({ kind: event.target.value as PublicationListSectionData["kind"] })
          }
        />
      </Field>

      <Switch
        label="Put a year heading above each group"
        description={PUBLICATIONS.groupByYear.description}
        checked={data.groupByYear}
        onCheckedChange={(checked) => update({ groupByYear: checked })}
      />

      <Switch
        label="Show the first lines of each abstract"
        description={PUBLICATIONS.showAbstract.description}
        checked={data.showAbstract}
        onCheckedChange={(checked) => update({ showAbstract: checked })}
      />
    </ShowcaseFields>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Craft explorer
// ─────────────────────────────────────────────────────────────────────────────

const CRAFTS = craftExplorerSectionSchema.shape;

export function CraftExplorerForm({
  data,
  onChange,
  onDirty
}: SectionFormProps<CraftExplorerSectionData>) {
  const update = (patch: Partial<CraftExplorerSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  return (
    <ShowcaseFields
      data={data}
      onChange={onChange}
      onDirty={onDirty}
      kind="craft"
      plural="crafts"
      latestMeaning="most recently published first"
      featuredMeaning="Shows only crafts switched on as featured on their own screen. If none are marked, the block will be empty and will say so."
      maxLimit={60}
      help={showcaseHelp(CRAFTS)}
    >
      <Field label="How they are shown" help={CRAFTS.view.description}>
        <Select
          value={data.view}
          options={[
            { value: "grid", label: "A card for each craft" },
            { value: "map", label: "Placed on a map by region" },
            { value: "timeline", label: "Ordered by when they began" }
          ]}
          onChange={(event) => update({ view: event.target.value as CraftExplorerSectionData["view"] })}
        />
      </Field>

      {data.view === "map" ? (
        <HelpText tone="warn">
          Only crafts with coordinates appear on the map. A craft with no location is left off it
          altogether, so check the ones you expect to see have their place recorded.
        </HelpText>
      ) : null}

      {data.view === "timeline" ? (
        <HelpText tone="warn">
          Only crafts with a date of origin appear on the timeline. “Sometime in the medieval period” is a
          real answer and a craft that has it recorded that way is left off, which is deliberate — an
          invented year in an archive is worse than a gap.
        </HelpText>
      ) : null}

      <Field
        label="Only one region"
        help={CRAFTS.regionSlug.description}
        maxLength={120}
        value={data.regionSlug}
      >
        <Input
          value={data.regionSlug}
          onChange={(event) => update({ regionSlug: event.target.value })}
          placeholder="rajasthan"
          className="font-mono text-xs"
        />
      </Field>

      <Switch
        label="Give readers the filters"
        description={CRAFTS.showFilters.description}
        checked={data.showFilters}
        onCheckedChange={(checked) => update({ showFilters: checked })}
      />
    </ShowcaseFields>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Contact form
// ─────────────────────────────────────────────────────────────────────────────

const CONTACT = contactFormSectionSchema.shape;

/**
 * Named for the block type it serves, awkward repetition and all: every entry in `SECTION_FORMS` reads
 * `<TYPE>: <Type>Form`, and a form called something else would be the one line of that table nobody could
 * check at a glance.
 */
export function ContactFormForm({ data, onChange, onDirty }: SectionFormProps<ContactFormSectionData>) {
  const update = (patch: Partial<ContactFormSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  return (
    <div className="space-y-5">
      <Field
        label="Small line above the heading"
        help={CONTACT.eyebrow.description}
        maxLength={60}
        value={data.eyebrow}
      >
        <Input value={data.eyebrow} onChange={(event) => update({ eyebrow: event.target.value })} />
      </Field>

      <Field label="Heading" help={CONTACT.heading.description} maxLength={120} value={data.heading}>
        <Input value={data.heading} onChange={(event) => update({ heading: event.target.value })} />
      </Field>

      <Field label="What to expect" help={CONTACT.body.description} maxLength={320} value={data.body}>
        <Textarea rows={2} value={data.body} onChange={(event) => update({ body: event.target.value })} />
      </Field>

      <Field label="Which inbox these messages go to" help={CONTACT.formKey.description}>
        <Select
          value={data.formKey}
          options={[
            { value: "general", label: "General enquiries" },
            { value: "admissions", label: "Admissions" },
            { value: "collaboration", label: "Collaboration" },
            { value: "media", label: "Press and media" }
          ]}
          onChange={(event) =>
            update({ formKey: event.target.value as ContactFormSectionData["formKey"] })
          }
        />
      </Field>

      <Field
        label="Words on the send button"
        help={CONTACT.submitLabel.description}
        maxLength={40}
        value={data.submitLabel}
      >
        <Input
          value={data.submitLabel}
          onChange={(event) => update({ submitLabel: event.target.value })}
          placeholder="Send message"
        />
      </Field>

      <Field
        label="What the sender reads afterwards"
        help={CONTACT.successMessage.description}
        maxLength={240}
        value={data.successMessage}
      >
        <Textarea
          rows={3}
          value={data.successMessage}
          onChange={(event) => update({ successMessage: event.target.value })}
        />
      </Field>

      {data.successMessage.trim().length === 0 ? (
        <HelpText tone="warn">
          Without this, somebody who has just written to the Centre is told nothing at all. Say that the
          message has arrived and roughly when a reply is likely.
        </HelpText>
      ) : null}

      <Switch
        label="Ask for the sender's organisation"
        description={CONTACT.showOrganisationField.description}
        checked={data.showOrganisationField}
        onCheckedChange={(checked) => update({ showOrganisationField: checked })}
      />

      <Switch
        label="Ask for a telephone number"
        description={CONTACT.showPhoneField.description}
        checked={data.showPhoneField}
        onCheckedChange={(checked) => update({ showPhoneField: checked })}
      />

      <Switch
        label="Show the Centre's address beside the form"
        description={CONTACT.showContactDetails.description}
        checked={data.showContactDetails}
        onCheckedChange={(checked) => update({ showContactDetails: checked })}
      />

      {data.showContactDetails ? (
        <HelpText>
          The address and telephone number come from Settings, so they are the same everywhere on the site
          and are changed in one place.
        </HelpText>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Map
// ─────────────────────────────────────────────────────────────────────────────

const MAP = mapSectionSchema.shape;

export function MapForm({ data, onChange, onDirty }: SectionFormProps<MapSectionData>) {
  const update = (patch: Partial<MapSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  // Both zero is the schema's "no location chosen yet" — it is open ocean off West Africa, and the
  // renderer reads it as a prompt rather than drawing a map of the Atlantic.
  const noLocation = data.latitude === 0 && data.longitude === 0;

  return (
    <div className="space-y-5">
      <Field label="Heading" help={MAP.heading.description} maxLength={120} value={data.heading}>
        <Input value={data.heading} onChange={(event) => update({ heading: event.target.value })} />
      </Field>

      <Field label="Introduction" help={MAP.body.description} maxLength={320} value={data.body}>
        <Textarea rows={2} value={data.body} onChange={(event) => update({ body: event.target.value })} />
      </Field>

      {/* Both boxes are `NumberField`s, which hold a draft string. A plainly controlled number input
          cannot be typed a decimal point into at all — see that component's header. */}
      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField
          label="Latitude"
          help={MAP.latitude.description}
          value={data.latitude}
          onChange={(latitude) => update({ latitude })}
          min={-90}
          max={90}
          inputClassName="font-mono text-xs"
        />

        <NumberField
          label="Longitude"
          help={MAP.longitude.description}
          value={data.longitude}
          onChange={(longitude) => update({ longitude })}
          min={-180}
          max={180}
          inputClassName="font-mono text-xs"
        />
      </div>

      {noLocation ? (
        <HelpText tone="warn">
          No place has been set yet, so the map is not drawn and the address below is shown on its own.
          Find the Centre in a map service, copy the two numbers it gives, and paste them above — latitude
          first. Swapping the two puts the pin in the sea.
        </HelpText>
      ) : null}

      <NumberField
        label="How close in the map starts"
        help={MAP.zoom.description}
        value={data.zoom}
        onChange={(zoom) => update({ zoom })}
        min={1}
        max={20}
        integer
        inputClassName="max-w-[8rem]"
      />

      <Field
        label="Words on the pin"
        help={MAP.markerLabel.description}
        maxLength={120}
        value={data.markerLabel}
      >
        <Input
          value={data.markerLabel}
          onChange={(event) => update({ markerLabel: event.target.value })}
        />
      </Field>

      <Field label="Postal address" help={MAP.address.description} maxLength={240} value={data.address}>
        <Textarea
          rows={3}
          value={data.address}
          onChange={(event) => update({ address: event.target.value })}
        />
      </Field>

      {data.address.trim().length === 0 ? (
        <HelpText tone="warn">
          Without an address, a reader whose connection cannot load the map has nothing at all. It is also
          what somebody copies into their own phone, so it matters more than the map does.
        </HelpText>
      ) : null}

      <LinkDestinationField
        label="Link to directions"
        value={data.directionsHref}
        help={MAP.directionsHref.description}
        onChange={(directionsHref) => update({ directionsHref })}
      />

      <Field label="How tall the map is" help={MAP.height.description}>
        <Select
          value={data.height}
          options={[
            { value: "sm", label: "Short" },
            { value: "md", label: "Medium" },
            { value: "lg", label: "Tall" }
          ]}
          onChange={(event) => update({ height: event.target.value as MapSectionData["height"] })}
        />
      </Field>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Space
// ─────────────────────────────────────────────────────────────────────────────

const SPACER = spacerSectionSchema.shape;

export function SpacerForm({ data, onChange, onDirty }: SectionFormProps<SpacerSectionData>) {
  const update = (patch: Partial<SpacerSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  return (
    <div className="space-y-5">
      <Field label="How much space" help={SPACER.size.description}>
        <Select
          value={data.size}
          options={[
            { value: "sm", label: "Small — a paragraph's worth" },
            { value: "md", label: "Medium" },
            { value: "lg", label: "Large" },
            { value: "xl", label: "Extra large — separates two parts of a page" }
          ]}
          onChange={(event) => update({ size: event.target.value as SpacerSectionData["size"] })}
        />
      </Field>

      <HelpText>
        This block shows nothing on the page but the space itself. It is here so a page can breathe
        without adding empty paragraphs to a text block to make room.
      </HelpText>
    </div>
  );
}
