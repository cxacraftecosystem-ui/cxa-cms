"use client";

/**
 * VideoSettingsFields — the player's settings, once, for every block that carries a film.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A CONTROL THAT WOULD DO NOTHING IS NOT SHOWN AT ALL.
 *
 * Three blocks store `videoSettings` — the video block, the image-beside-text block, and the video
 * node inside a body of writing — and only one of the video block's five providers is a player this
 * site controls. YouTube and Vimeo take a start time, a loop and a couple of others as parameters in
 * their URL; Google Drive's viewer takes nothing at all; a plain frame is somebody else's page.
 *
 * `providerHonours()` in lib/media/video.ts is the table that says which is which, and this component
 * renders exactly what it returns. That is contract §10 read from the other end: an editor who sets a
 * control, checks the page and finds nothing changed does not conclude "that setting does not apply
 * here" — they conclude the block is broken, and they are right to, because a control that cannot
 * work should not have been offered.
 *
 * Where a provider honours NOTHING the panel says so in a sentence rather than disappearing without
 * explanation (contract §1.6): an editor who saw these controls on the block next door needs to know
 * why they are not here.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ THE HELP TEXT IS THE SCHEMA'S, READ BY RUNNING IT. Writing a second sentence per field here would
 * give the studio two explanations of one setting, and the one on screen would be the one nobody
 * updated. `videoSettingsSchema` is a `.default({})`, so `.removeDefault()` comes off before `.shape`
 * is readable — the same step `MediaSplitForm` takes for its two `cta()` objects.
 *
 * ⚠ IT IS A `<fieldset>` WITH A `<legend>`, NOT A HEADING. A group of related controls is exactly what
 * a fieldset is for, it is announced as a group by every screen reader, and it does not add a level to
 * the document outline — which matters because this panel is dropped into three different forms, each
 * sitting at a different depth, and a hard-coded `<h3>` would skip a level in at least one of them
 * (contract §11).
 */

import {
  defaultVideoSettings,
  providerHonours,
  videoSettingsSchema,
  VIDEO_OFF_SCREEN_BEHAVIOURS,
  VIDEO_OFF_SCREEN_LABELS,
  type VideoSettings
} from "@/lib/media/video";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { EntityPicker } from "@/components/studio/fields/EntityPicker";
import { HelpText } from "@/components/studio/HelpText";
import { NumberField } from "@/components/studio/sections/ShowcaseForm";

/** `.default({})` wraps the object; the default comes off before the shape is readable. */
const SHAPE = videoSettingsSchema.removeDefault().shape;

export interface VideoSettingsFieldsProps {
  /**
   * Which provider these settings belong to.
   *
   * ⚠ A PLAIN STRING, NOT THE ENUM, and that is the same widening every other lookup on a stored
   * value in this tree carries: the builder hands a form its RAW working copy when a payload fails to
   * parse, so this really can be a value that has never been through the enum. `providerHonours`
   * answers "nothing" for one, which is the same answer Drive gives and is safe.
   */
  provider: string;
  /**
   * The settings, always complete.
   *
   * ⚠ NEVER PARTIAL AND NEVER NULL. `videoSettingsSchema` gives every field a default and the object
   * itself one, so a payload saved before these existed parses into a complete set — but the repair
   * path (`repairSectionData`, a shallow merge that does not parse) can hand a form an object missing
   * keys, and `data.videoSettings.loop` on it would be `undefined` in a `checked` prop, which is how
   * React switches a control from controlled to uncontrolled and warns. `settingsOrDefaults` below is
   * the one line that closes it.
   */
  value: VideoSettings | null | undefined;
  onChange: (next: VideoSettings) => void;
  /** Every control here is a themed button or picker and fires no native input event (contract §10). */
  onDirty?: () => void;
}

/**
 * A complete settings object, whatever arrived.
 *
 * The spread order is deliberate: defaults first, then whatever was stored, so a stored value always
 * wins and a missing one is filled rather than blanked.
 */
function settingsOrDefaults(value: VideoSettings | null | undefined): VideoSettings {
  return { ...defaultVideoSettings(), ...(value ?? {}) };
}

export function VideoSettingsFields({
  provider,
  value,
  onChange,
  onDirty
}: VideoSettingsFieldsProps) {
  const settings = settingsOrDefaults(value);

  const update = (patch: Partial<VideoSettings>) => {
    onChange({ ...settings, ...patch });
    onDirty?.();
  };

  const honours = (key: keyof VideoSettings) => providerHonours(provider, key);

  /**
   * Does this provider honour anything at all? Asked of the whole object rather than of a list
   * written out again here, so a setting added to the schema cannot be left out of this test.
   */
  const honoursAnything = (Object.keys(settings) as (keyof VideoSettings)[]).some(honours);

  if (!honoursAnything) {
    return (
      <HelpText>
        A video from this source is played by whoever hosts it, so none of this site&rsquo;s player
        settings apply to it. Upload the film here instead if you need them.
      </HelpText>
    );
  }

  /**
   * The one combination that silently does nothing, said out loud where it is made.
   *
   * Every browser refuses to start an unmuted video without a gesture from the reader. So "start it
   * when it comes into view" plus "start it with the sound on" is not two settings that fight — it is
   * one setting that never fires, and the film simply sits there looking broken.
   */
  const autoplayNeedsMute =
    honours("autoplayOnScreen") && settings.autoplayOnScreen && !settings.startMuted;

  return (
    <fieldset className="space-y-4 rounded-md border border-line-200 bg-surface-50 px-4 py-4">
      <legend className="px-1 text-sm font-semibold text-ink-900">How the film plays</legend>

      {honours("autoplayOnScreen") ? (
        <Switch
          label="Start playing when the reader scrolls to it"
          description={SHAPE.autoplayOnScreen.description}
          checked={settings.autoplayOnScreen}
          onCheckedChange={(checked) => update({ autoplayOnScreen: checked })}
        />
      ) : null}

      {autoplayNeedsMute ? (
        <HelpText tone="warn">
          A film that starts by itself has to start silent — every browser refuses otherwise — so with
          the sound on below it will simply never start. Turn “Start with the sound off” back on, or
          let the reader press play.
        </HelpText>
      ) : null}

      {honours("offScreen") ? (
        <Field label="When the reader scrolls past it" help={SHAPE.offScreen.description}>
          <Select
            value={settings.offScreen}
            options={VIDEO_OFF_SCREEN_BEHAVIOURS.map((behaviour) => ({
              value: behaviour,
              label: VIDEO_OFF_SCREEN_LABELS[behaviour]
            }))}
            onChange={(event) =>
              update({ offScreen: event.target.value as VideoSettings["offScreen"] })
            }
          />
        </Field>
      ) : null}

      {honours("startMuted") ? (
        <Switch
          label="Start with the sound off"
          description={SHAPE.startMuted.description}
          checked={settings.startMuted}
          onCheckedChange={(checked) => update({ startMuted: checked })}
        />
      ) : null}

      {honours("loop") ? (
        <Switch
          label="Play it again when it ends"
          description={SHAPE.loop.description}
          checked={settings.loop}
          onCheckedChange={(checked) => update({ loop: checked })}
        />
      ) : null}

      {honours("showControls") ? (
        <>
          <Switch
            label="Show the play and volume controls"
            description={SHAPE.showControls.description}
            checked={settings.showControls}
            onCheckedChange={(checked) => update({ showControls: checked })}
          />
          {!settings.showControls ? (
            <HelpText tone="warn">
              With no controls a reader cannot pause the film, turn the sound down or move through it,
              and somebody using only a keyboard cannot reach it at all. Use this for a short silent
              loop and nothing else.
            </HelpText>
          ) : null}
        </>
      ) : null}

      {honours("startAt") ? (
        <NumberField
          label="Start this many seconds in"
          help={SHAPE.startAt.description}
          value={settings.startAt}
          onChange={(next) => update({ startAt: Math.round(next) })}
          min={0}
          max={86_400}
          integer
          inputClassName="max-w-[8rem]"
        />
      ) : null}

      {honours("posterMediaId") ? (
        <EntityPicker
          kind="media"
          max={1}
          label="A still picture to show before it plays"
          help={SHAPE.posterMediaId.description}
          ids={settings.posterMediaId ? [settings.posterMediaId] : []}
          onChange={(ids) => update({ posterMediaId: ids[0] ?? "" })}
          upload
          uploadMediaKind="IMAGE"
        />
      ) : null}

      {honours("speedMenu") ? (
        <Switch
          label="Offer playback speeds"
          description={SHAPE.speedMenu.description}
          checked={settings.speedMenu}
          onCheckedChange={(checked) => update({ speedMenu: checked })}
        />
      ) : null}

      {honours("allowPictureInPicture") ? (
        <Switch
          label="Allow the browser’s pop-out window"
          description={SHAPE.allowPictureInPicture.description}
          checked={settings.allowPictureInPicture}
          onCheckedChange={(checked) => update({ allowPictureInPicture: checked })}
        />
      ) : null}

      {honours("allowDownload") ? (
        <Switch
          label="Offer a link that saves the file"
          description={SHAPE.allowDownload.description}
          checked={settings.allowDownload}
          onCheckedChange={(checked) => update({ allowDownload: checked })}
        />
      ) : null}

      {honours("rememberPosition") ? (
        <Switch
          label="Bring the reader back to where they stopped"
          description={SHAPE.rememberPosition.description}
          checked={settings.rememberPosition}
          onCheckedChange={(checked) => update({ rememberPosition: checked })}
        />
      ) : null}

      {honours("captionsMediaId") ? (
        <>
          <EntityPicker
            kind="media"
            max={1}
            label="Subtitles"
            help={SHAPE.captionsMediaId.description}
            ids={settings.captionsMediaId ? [settings.captionsMediaId] : []}
            onChange={(ids) => update({ captionsMediaId: ids[0] ?? "" })}
            upload
            // A `.vtt` is filed as a DOCUMENT (see the MIME tables), so the chooser offers documents.
            // The sentence above the picker is what says which document, and the player checks the
            // name again before it offers the track at all — a browser handed anything else as
            // subtitles fails in silence.
            uploadMediaKind="DOCUMENT"
            footnote="It must be a WebVTT file — the name ends in .vtt. Any other file is ignored by the player."
          />

          {settings.captionsMediaId ? (
            <Field
              label="What the subtitles are called"
              help={SHAPE.captionsLabel.description}
              maxLength={60}
              value={settings.captionsLabel}
            >
              <Input
                value={settings.captionsLabel}
                onChange={(event) => update({ captionsLabel: event.target.value })}
                placeholder="English"
              />
            </Field>
          ) : null}
        </>
      ) : null}
    </fieldset>
  );
}
