"use client";

/**
 * ParallaxBannerForm — the editor for one photograph across the full width, with a line of text over
 * it, drifting more slowly than the page.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE SCRIM IS A CONTRAST CONTROL, NOT A DECORATION, AND THIS FORM TREATS IT AS ONE.
 *
 * The heading on this band is white over a photograph that can be any colour, and the person choosing
 * the photograph is not thinking about the contrast ratio of white type over its top-left quarter —
 * nor about the fact that the photograph can be swapped a year later by somebody who never read this
 * screen. So the schema's default lays a gradient scrim under the words, and choosing "no scrim" gets
 * a warning HERE, at the moment it is chosen, rather than a note somebody might read.
 *
 * The heading colour is fixed white rather than themed, deliberately: the band is a photograph in both
 * themes, so there is nothing for a theme to invert.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE DRIFT IS A NUMBER AND IT HAS AN HONEST ZERO. `speed` is a percentage of the band's own height,
 * and zero switches the drift off and leaves a plain photograph — which is a legitimate choice, not a
 * disabled block, so the form says so rather than treating it as a mistake. Above about twenty it
 * stops reading as depth and starts reading as a fault; the schema's own help says that, and it is
 * shown rather than paraphrased.
 *
 * ⚠ AND THE DIAL GOES HIGHER THAN THE PAGE GOES. The schema accepts up to forty; the renderer clamps
 * at sixteen and says so in its own header. A control that silently stops responding halfway along
 * its range is the cap-not-stated bug (contract §1.6), so `SPEED_DRAWN_MAX` below carries the number
 * and the form names it the moment it is passed.
 *
 * `NumberField` RATHER THAN A PLAIN CONTROLLED `<input type="number">` — see its header in
 * ShowcaseForm.tsx. The obvious version cannot be typed in: clearing the box to retype writes the old
 * figure straight back and backspace appears not to work.
 *
 * A BAND WITH NO WORDS IS A DARKENED PHOTOGRAPH FOR NOTHING, and that is said too. It is the one
 * combination here that is silently wrong: the block renders, the page looks deliberate, and the scrim
 * is dimming a picture for the benefit of text nobody wrote.
 */

import { parallaxBannerSectionSchema, type ParallaxBannerSectionData } from "@/lib/sections/schema";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { HelpText } from "@/components/studio/HelpText";
import { LinkField } from "@/components/studio/fields/LinkField";
import { MediaFramingField } from "@/components/studio/fields/MediaFramingField";
import { CraftImagePicker } from "@/components/studio/sections/CraftImagePicker";
import { NumberField } from "@/components/studio/sections/ShowcaseForm";
import type { SectionFormProps } from "@/components/studio/sections";

const SHAPE = parallaxBannerSectionSchema.shape;

/** `cta()` wraps the pair in `.default({})`; the default comes off before the shape is readable. */
const CTA = SHAPE.cta.removeDefault().shape;

/** ⚠ Matches `count({ min: 0, max: 40 })` on `speed`. Two different caps would be two different rules. */
const SPEED_MIN = 0;
const SPEED_MAX = 40;

/**
 * The most drift the PUBLIC BLOCK actually draws — `MAX_SAFE_SPEED` in
 * `components/sections/story/ParallaxStage.tsx`, restated.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS IS NOT `SPEED_MAX`, AND THE GAP BETWEEN THE TWO IS A SILENT CAP THAT HAS TO BE SPOKEN.
 *
 * Both picture sources draw a parallax image at 1.18× its frame, which leaves about nine per cent of
 * spare height, and the tween spends half its travel in each direction — so sixteen is ±8%, the most
 * the overscan can afford before the frame shows through as a pale bar along one edge. The renderer
 * therefore clamps: `Math.min(Math.max(requested, 0), 16)`. A payload of 40 is HONOURED AS 16 rather
 * than refused, deliberately, because a banner is not worth breaking over a number somebody nudged.
 *
 * Which leaves the studio owing the editor a sentence. Without one, a dial that reads 0–40 stops
 * doing anything at 16 and every further nudge is work spent on nothing — the cap that is not stated
 * on screen (contract §1.6). The schema's own help talks about taste ("above about twenty it stops
 * reading as depth"); this talks about what the page will draw, and the two are different facts.
 *
 * NOT IMPORTED FROM ParallaxStage.tsx. That module is the public block's client half and pulls
 * `useGsapScope` — and GSAP behind it — in with it, which is not a thing to add to the studio bundle
 * for one integer. If the overscan ever moves, both numbers move.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const SPEED_DRAWN_MAX = 16;

/** The CSS words are the stored values; the British prose is what a person reads (schema header). */
const HEIGHT_OPTIONS = [
  { value: "md", label: "Medium — a band between two parts of a page" },
  { value: "lg", label: "Large — the usual choice" },
  { value: "screen", label: "The whole screen — striking once, exhausting twice" }
] as const;

const OVERLAY_OPTIONS = [
  { value: "scrim", label: "A gradient scrim — the safe default" },
  { value: "deep", label: "A deep scrim — for a busy or pale photograph" },
  { value: "none", label: "No scrim — only over a photograph you have checked" }
] as const;

const ALIGN_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "center", label: "Centred" },
  { value: "right", label: "Right" }
] as const;

export function ParallaxBannerForm({
  data,
  onChange,
  onDirty
}: SectionFormProps<ParallaxBannerSectionData>) {
  const update = (patch: Partial<ParallaxBannerSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  const hasWords =
    data.heading.trim().length > 0 ||
    data.body.trim().length > 0 ||
    data.eyebrow.trim().length > 0;

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

      <Field label="The line under it" help={SHAPE.body.description} maxLength={240} value={data.body}>
        <Textarea rows={2} value={data.body} onChange={(event) => update({ body: event.target.value })} />
      </Field>

      {/*
        NO `offerFraming` TEST HERE, AND THAT IS A DECISION RATHER THAN AN OMISSION. This band has one
        arrangement and one picture, always drawn as an image across the full width — there is no video
        branch and no setting that parks the photograph, so the panel is never a control with no visible
        effect. (`speed: 0` stops the drift; it still draws the photograph.) The craft picker below needs
        no guard either: `MediaFramingField` offers the panel only once an UPLOADED photograph is chosen,
        and that is the only picture a framing can apply to — a bundled one has no media row to crop.
      */}
      <MediaFramingField
        label="A photograph you have uploaded"
        help={SHAPE.mediaId.description}
        framingHelp={SHAPE.mediaScreens.description}
        mediaId={data.mediaId}
        framing={data.mediaScreens}
        onChange={({ mediaId, framing }) => update({ mediaId, mediaScreens: framing })}
      />

      <CraftImagePicker
        value={data.craftImage}
        onChange={(craftImage) => update({ craftImage })}
        uploadedMediaId={data.mediaId}
        subject="this band"
        help={SHAPE.craftImage.description}
      />

      <Field label="How tall the band is" help={SHAPE.height.description}>
        <Select
          value={data.height}
          options={HEIGHT_OPTIONS}
          onChange={(event) =>
            update({ height: event.target.value as ParallaxBannerSectionData["height"] })
          }
        />
      </Field>

      <Field label="How much the photograph is darkened" help={SHAPE.overlay.description}>
        <Select
          value={data.overlay}
          options={OVERLAY_OPTIONS}
          onChange={(event) =>
            update({ overlay: event.target.value as ParallaxBannerSectionData["overlay"] })
          }
        />
      </Field>

      {/* Stated at the moment it is chosen, not left to the help text — see the header. */}
      {data.overlay === "none" && hasWords ? (
        <HelpText tone="warn">
          With no scrim the white heading sits straight on the photograph. Look at the band on a wide
          screen and on a telephone before publishing it, and remember that whoever replaces this
          photograph later will not see this warning.
        </HelpText>
      ) : null}

      {/*
        ⚠ THE SCRIM CLAUSE IS CONDITIONAL, because it is a statement of fact about this band. With the
        overlay set to "none" there is nothing darkening anything, and a warning that describes a
        scrim that is not there is a warning an editor will check, find false, and stop believing.
      */}
      {!hasWords ? (
        <HelpText tone="warn">
          There is no eyebrow, heading or line under it, so this band is a photograph with nothing over
          it
          {data.overlay === "none"
            ? ""
            : " — and the scrim is darkening it for the benefit of words nobody has written"}
          . Add a heading, or use a photograph in an “Image beside text” block instead.
        </HelpText>
      ) : null}

      <Field label="Where the words sit across the band" help={SHAPE.align.description}>
        <Select
          value={data.align}
          options={ALIGN_OPTIONS}
          onChange={(event) => update({ align: event.target.value as ParallaxBannerSectionData["align"] })}
        />
      </Field>

      <LinkField
        label="Main button"
        value={data.cta}
        onChange={(next) => update({ cta: next })}
        labelHelp={CTA.label.description}
        hrefHelp={CTA.href.description}
      />

      <NumberField
        label="How far the photograph drifts"
        help={SHAPE.speed.description}
        value={data.speed}
        onChange={(speed) => update({ speed })}
        min={SPEED_MIN}
        max={SPEED_MAX}
        integer
        inputClassName="max-w-[8rem]"
      />

      {/*
        Zero is a CHOICE here, not an unfinished setting, so it is stated in the neutral tone. A
        warning would tell an editor to undo something they meant — and a still photograph is exactly
        what a reader who has asked for less motion gets in every case anyway.
      */}
      {data.speed === 0 ? (
        <HelpText>
          The drift is switched off, so this is a plain full-width photograph. That is a proper
          setting, and it is also what readers who have asked for less motion always see.
        </HelpText>
      ) : null}

      {/* The cap, said where the dial is. See SPEED_DRAWN_MAX. */}
      {data.speed > SPEED_DRAWN_MAX ? (
        <HelpText tone="warn">
          {data.speed} is more drift than the band can draw: anything above {SPEED_DRAWN_MAX} is drawn
          as {SPEED_DRAWN_MAX}, because past that the photograph runs out of the spare height it is
          cropped with and a pale bar appears along one edge. Raising this further changes nothing on
          the page. Fourteen is what a new band starts at.
        </HelpText>
      ) : null}
    </div>
  );
}
