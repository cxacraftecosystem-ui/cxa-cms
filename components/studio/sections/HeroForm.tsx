"use client";

/**
 * HeroForm — the editor for the page opener.
 *
 * THE HELP TEXT IS READ OFF THE SCHEMA, NOT COPIED FROM IT. `lib/sections/schema.ts` gives every field
 * a `.describe()` sentence written for a non-technical administrator, and `.description` is the public
 * way to read it back. Copying those sentences into this file would create two versions of the same
 * explanation, and the one on screen would be the one nobody remembered to update.
 *
 * The character limits ARE restated, because Zod does not expose a `.max()` without reaching into its
 * private `_def`. Each one below matches the schema; changing one means changing both, and the counter
 * under the field is what tells an editor before the save refuses them.
 *
 * `headlineAccent` IS A SEPARATE FIELD, not markup inside the headline, because the gold gradient is
 * the one place gold is allowed on the whole site (contract §1.1) and it must not be somewhere an
 * editor can paste arbitrary HTML. The form therefore shows the two halves as one sentence, so what is
 * being written is obvious.
 *
 * THE BACKGROUND PICTURE IS ALWAYS OFFERED, whatever the background style is set to. Choosing "A
 * picture" and then choosing the picture are two steps and the studio autosaves between them, so the
 * schema deliberately does not cross-validate the pair. What the form does instead is say when the
 * chosen file is not being used — silence there is how an editor ends up convinced the upload failed.
 */

import { heroSectionSchema, type HeroSectionData } from "@/lib/sections/schema";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { Textarea } from "@/components/ui/Textarea";
import { HelpText } from "@/components/studio/HelpText";
import { EntityPicker } from "@/components/studio/fields/EntityPicker";
import { LinkField } from "@/components/studio/fields/LinkField";
import { ScreenFramingPanel } from "@/components/studio/fields/ScreenFramingPanel";
import type { SectionFormProps } from "@/components/studio/sections";

const SHAPE = heroSectionSchema.shape;

/**
 * The two buttons' own field descriptions.
 *
 * `cta()` wraps each pair in `.default({})`, so the default comes off before the shape is readable. Read
 * rather than retyped, for the reason in the header: two copies of one sentence means the one on screen
 * is the stale one.
 */
const PRIMARY_CTA = SHAPE.primaryCta.removeDefault().shape;
const SECONDARY_CTA = SHAPE.secondaryCta.removeDefault().shape;

/** The CSS words are the stored values; the British prose is what a person reads (schema header). */
const ALIGNMENT_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "center", label: "Centred" },
  { value: "right", label: "Right" }
] as const;

const BACKGROUND_OPTIONS = [
  { value: "gradient", label: "Brand gradient — no file needed" },
  { value: "particles", label: "Moving particles — no file needed" },
  { value: "image", label: "A picture" },
  { value: "video", label: "A video" }
] as const;

export function HeroForm({ data, onChange, onDirty }: SectionFormProps<HeroSectionData>) {
  /**
   * One patch, one change notification.
   *
   * `onDirty` is called by hand on every change because several of the controls below are themed
   * buttons rather than native inputs, and a dirty tracker listening for `onInput` never sees those
   * (contract §10). Calling it for the native ones too costs nothing and means no control is special.
   */
  const update = (patch: Partial<HeroSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  const usesMedia = data.backgroundKind === "image" || data.backgroundKind === "video";
  const hasMedia = data.backgroundMediaId.length > 0;

  return (
    <div className="space-y-5">
      <Field label="Small line above the headline" help={SHAPE.eyebrow.description} maxLength={60} value={data.eyebrow}>
        <Input value={data.eyebrow} onChange={(event) => update({ eyebrow: event.target.value })} />
      </Field>

      <Field label="Headline" help={SHAPE.headline.description} maxLength={120} value={data.headline}>
        <Input value={data.headline} onChange={(event) => update({ headline: event.target.value })} />
      </Field>

      <Field
        label="The part in gold"
        help={SHAPE.headlineAccent.description}
        maxLength={60}
        value={data.headlineAccent}
      >
        <Input
          value={data.headlineAccent}
          onChange={(event) => update({ headlineAccent: event.target.value })}
        />
      </Field>

      {/* The two halves as they will actually read, so nobody has to imagine the join. */}
      {data.headline.length > 0 || data.headlineAccent.length > 0 ? (
        <p className="rounded-md border border-line-200 bg-surface-50 px-3 py-2 text-sm leading-relaxed text-ink-700">
          <span className="field-label block">The headline will read</span>
          <span className="mt-1 block font-display text-base font-semibold text-ink-900">
            {data.headline}
            {data.headlineAccent.length > 0 ? (
              <>
                {data.headline.length > 0 ? " " : null}
                {/*
                  Marked with the studio's purple underline, NOT with the gold gradient it will wear on
                  the page: gold is marketing-only and never appears on a studio screen (contract §1.1).
                  The field's own label says which part goes gold.
                */}
                <span className="underline decoration-purple-400 decoration-2 underline-offset-4">
                  {data.headlineAccent}
                </span>
              </>
            ) : null}
          </span>
        </p>
      ) : null}

      <Field label="Introduction" help={SHAPE.body.description} maxLength={320} value={data.body}>
        <Textarea rows={3} value={data.body} onChange={(event) => update({ body: event.target.value })} />
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

      <Field label="What sits behind the words" help={SHAPE.backgroundKind.description}>
        <Select
          value={data.backgroundKind}
          options={BACKGROUND_OPTIONS}
          onChange={(event) =>
            update({ backgroundKind: event.target.value as HeroSectionData["backgroundKind"] })
          }
        />
      </Field>

      <EntityPicker
        kind="media"
        max={1}
        label="Background picture or video"
        help={SHAPE.backgroundMediaId.description}
        ids={hasMedia ? [data.backgroundMediaId] : []}
        onChange={(next) => update({ backgroundMediaId: next[0] ?? "" })}
      />

      {/* Both directions of the mismatch are stated, because both are things an editor gets wrong. */}
      {usesMedia && !hasMedia ? (
        <HelpText tone="warn">
          The background is set to {data.backgroundKind === "video" ? "a video" : "a picture"} but none
          has been chosen, so the hero falls back to the brand gradient. That is a proper background, not
          a hole — choose a file above, or set the background to the gradient on purpose.
        </HelpText>
      ) : null}

      {/*
        Offered only when a picture is actually being drawn. Framing a video per screen size would be a
        control that does nothing — `MediaImage` draws the still frame, not the film — and framing a
        picture the hero is not using is a decision with no visible effect, which is how an editor comes
        to believe the panel is broken.
      */}
      {data.backgroundKind === "image" ? (
        <ScreenFramingPanel
          label="Framing per screen size"
          help={SHAPE.backgroundMediaScreens.description}
          mediaId={data.backgroundMediaId}
          value={data.backgroundMediaScreens}
          onChange={(next) => update({ backgroundMediaScreens: next })}
        />
      ) : null}

      {!usesMedia && hasMedia ? (
        <HelpText tone="warn">
          A file is chosen but the background is set to{" "}
          {data.backgroundKind === "particles" ? "moving particles" : "the brand gradient"}, so the file
          is not being shown. Change the background above to use it.
        </HelpText>
      ) : null}

      <Field label="Where the words sit" help={SHAPE.alignment.description}>
        <Select
          value={data.alignment}
          options={ALIGNMENT_OPTIONS}
          onChange={(event) => update({ alignment: event.target.value as HeroSectionData["alignment"] })}
        />
      </Field>

      <Switch
        label="Show the cue that there is more below"
        description={SHAPE.showScrollCue.description}
        checked={data.showScrollCue}
        onCheckedChange={(checked) => update({ showScrollCue: checked })}
      />

      <Switch
        label="Invite readers to watch the Centre's story"
        description={SHAPE.showStory.description}
        checked={data.showStory}
        onCheckedChange={(checked) => update({ showStory: checked })}
      />
    </div>
  );
}
