"use client";

/**
 * MediaSplitForm — one picture on one side, words on the other.
 *
 * THE CAPTION IS NOT THE ALT TEXT, AND THE FORM SAYS SO. A caption is prose everybody reads; alt text
 * describes the picture to somebody who cannot see it, and it belongs to the ASSET rather than to this
 * block — the same photograph carries the same description wherever it is used, which is why it is
 * edited in the media library and not here (contract §11).
 *
 * "WHICH SIDE" DOES NOTHING ON A PHONE, and the schema's own help text says the picture always comes
 * first there. That is worth knowing before an editor spends time alternating sides down a page and then
 * checks it on a telephone.
 *
 * THE FRAMING PANEL IS OFFERED FOR A PICTURE AND NOT FOR A FILM, which is why this form looks the chosen
 * file up — see the note on the lookup below.
 */

import {
  isVideoObjectKey,
  mediaSplitSectionSchema,
  type MediaSplitSectionData
} from "@/lib/sections/schema";
import { useResource } from "@/lib/client/useResource";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { HelpText } from "@/components/studio/HelpText";
import {
  lookupResolvePath,
  type LookupItem,
  type LookupResponse
} from "@/components/studio/fields/EntityPicker";
import { LinkField } from "@/components/studio/fields/LinkField";
import { MediaFramingField } from "@/components/studio/fields/MediaFramingField";
import type { SectionFormProps } from "@/components/studio/sections";

const SHAPE = mediaSplitSectionSchema.shape;

/** A response is a cast, not a proof — the same guard `DocumentEmbedForm` makes on the same shape. */
function firstItem(response: LookupResponse | null): LookupItem | null {
  if (response === null || !Array.isArray(response.items)) return null;
  return response.items[0] ?? null;
}

/** `cta()` wraps each button in `.default({})`; the default comes off before the shape is readable. */
const PRIMARY_CTA = SHAPE.primaryCta.removeDefault().shape;
const SECONDARY_CTA = SHAPE.secondaryCta.removeDefault().shape;

export function MediaSplitForm({ data, onChange, onDirty }: SectionFormProps<MediaSplitSectionData>) {
  const update = (patch: Partial<MediaSplitSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  const hasMedia = data.mediaId.length > 0;

  /**
   * The chosen file, looked up so that the form knows which of the two things this block will draw.
   *
   * ⚠ THE BLOCK DECIDES BY THE FILE ITSELF, not by any setting an editor made — `MediaSplitSection`
   * gives a video the browser's own player and everything else a `MediaImage` — so the framing panel
   * cannot be gated without asking what was chosen. `EntityPicker` resolves the id for its own list but
   * hands back only the id, so this is one further small authenticated read per chosen file, for the
   * reason `DocumentEmbedForm` sets out at length above its own lookup.
   *
   * Suspended while nothing is chosen: `lookupResolvePath` answers null for an empty list, and
   * `useResource` treats null as "do not ask".
   */
  const lookup = useResource<LookupResponse>(lookupResolvePath("media", hasMedia ? [data.mediaId] : []));
  /**
   * A film, as far as we can tell YET — and the direction of that "yet" is deliberate. While the lookup
   * is in flight, and for a file that has since been deleted, this is false and the panel is offered: a
   * picture is the common case, so it gets no control flickering in and out, and a framing already
   * stored never becomes uneditable because a lookup failed. The cost is that a video shows the panel
   * for the moment before its name arrives.
   */
  const isVideo = isVideoObjectKey(firstItem(lookup.data)?.media?.objectKey ?? "");

  return (
    <div className="space-y-5">
      <MediaFramingField
        label="The picture or video"
        help={SHAPE.mediaId.description}
        framingHelp={SHAPE.mediaScreens.description}
        mediaId={data.mediaId}
        framing={data.mediaScreens}
        // Framing a film would be a control with no visible effect — see the schema's note on the field.
        offerFraming={!isVideo}
        onChange={({ mediaId, framing }) => update({ mediaId, mediaScreens: framing })}
      />

      {!hasMedia ? (
        <HelpText tone="warn">
          Without a picture this block is only its words, and the page shows a blank half where the
          picture should be. Choose one above, or use a text block instead.
        </HelpText>
      ) : null}

      <Field label="Which side the picture sits on" help={SHAPE.side.description}>
        <Select
          value={data.side}
          options={[
            { value: "left", label: "Picture on the left" },
            { value: "right", label: "Picture on the right" }
          ]}
          onChange={(event) => update({ side: event.target.value as MediaSplitSectionData["side"] })}
        />
      </Field>

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

      <Field label="The text beside it" help={SHAPE.body.description} maxLength={600} value={data.body}>
        <Textarea rows={5} value={data.body} onChange={(event) => update({ body: event.target.value })} />
      </Field>

      <Field
        label="Caption under the picture"
        help={SHAPE.caption.description}
        maxLength={200}
        value={data.caption}
      >
        <Input value={data.caption} onChange={(event) => update({ caption: event.target.value })} />
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
    </div>
  );
}
