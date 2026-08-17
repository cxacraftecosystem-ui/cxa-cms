"use client";

/**
 * StoryScrollForm — the editor for a page that NARRATES: chapters of writing, each with a photograph
 * that stays put while its own words scroll past it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ORDER IS THE CONTENT, AND SO IS THE LENGTH OF EACH CHAPTER. Unlike a feature grid, a reader
 * cannot skim this block — they walk through it. Which makes two affordances matter more here than
 * anywhere else: REORDERING (`RepeaterField` does it from the keyboard as well as by dragging, and
 * announces every move) and the character counter on the chapter body, which is what tells an editor
 * they have written a page rather than a paragraph before the save refuses them.
 *
 * ⚠ EVERY CHAPTER NEEDS A PICTURE, FROM EITHER SOURCE, AND THE FORM SAYS SO PER CHAPTER RATHER THAN
 * ONCE AT THE TOP. The whole block is a sequence of sticky figures; a chapter with no figure is a
 * gap in the middle of the story where the reader's eye has nothing to rest on, and the renderer
 * prints "the picture is missing" there rather than closing the gap (contract §1.6). `CraftImagePicker`
 * carries that sentence, so there is one copy of it across all four narrative forms.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE CHAPTER LINK IS OPTIONAL AND IT CHANGES WHAT THE CHAPTER IS. With an address the chapter ends
 * in a link; without one it is prose that runs into the next chapter. The words on that link are only
 * asked for once there is somewhere for it to go — a box for words that can never appear is a box
 * somebody will fill in for nothing (the same decision ActionStepsForm makes for its buttons).
 *
 * "WHICH SIDE" DOES NOTHING ON A PHONE, and the schema's own help text says the photograph always
 * comes first there. Worth knowing before an editor spends an afternoon alternating sides and then
 * looks at it on a telephone.
 */

import { storyScrollSectionSchema, type StoryScrollSectionData } from "@/lib/sections/schema";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { Textarea } from "@/components/ui/Textarea";
import { HelpText } from "@/components/studio/HelpText";
import { LinkDestinationField } from "@/components/studio/fields/LinkField";
import { MediaFramingField } from "@/components/studio/fields/MediaFramingField";
import { RepeaterField } from "@/components/studio/fields/RepeaterField";
import { CraftImagePicker } from "@/components/studio/sections/CraftImagePicker";
import type { SectionFormProps } from "@/components/studio/sections";

const SHAPE = storyScrollSectionSchema.shape;
const CHAPTER = SHAPE.chapters.removeDefault().element.shape;

type StoryChapter = StoryScrollSectionData["chapters"][number];

/** ⚠ Matches `.max(12)` on the chapters array. A different number here caps a list the save allows. */
const MAX_CHAPTERS = 12;

/** The CSS words are the stored values; the British prose is what a person reads (schema header). */
const SIDE_OPTIONS = [
  { value: "left", label: "Photographs on the left" },
  { value: "right", label: "Photographs on the right" }
] as const;

export function StoryScrollForm({ data, onChange, onDirty }: SectionFormProps<StoryScrollSectionData>) {
  /**
   * One patch, one change notification.
   *
   * `onDirty` is called by hand because several controls below are themed buttons rather than native
   * inputs, and a dirty tracker listening for `onInput` never sees those (contract §10).
   */
  const update = (patch: Partial<StoryScrollSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  return (
    <div className="space-y-5">
      <Field label="How the story is told" help={SHAPE.presentation.description}>
        <Select
          value={data.presentation}
          options={[
            { value: "chapters", label: "Chapters — photographs and paragraphs, from the fields below" },
            { value: "cinematic", label: "Cinematic — the Centre's own scroll-driven telling" }
          ]}
          onChange={(event) =>
            update({ presentation: event.target.value as StoryScrollSectionData["presentation"] })
          }
        />
      </Field>

      {data.presentation === "cinematic" ? (
        <HelpText tone="neutral">
          The cinematic telling is a fixed, designed sequence — the Centre&apos;s story with its
          choreography, drawn thread and imagery — whose words are part of the site itself rather
          than fields here. The fields below stay editable but are IGNORED ON THE PAGE while it is
          chosen; switch back to Chapters and your story returns exactly as it was.
        </HelpText>
      ) : null}

      <Field
        label="Small line above the heading"
        help={SHAPE.eyebrow.description}
        maxLength={60}
        value={data.eyebrow}
      >
        <Input
          value={data.eyebrow}
          onChange={(event) => update({ eyebrow: event.target.value })}
          placeholder="The making of a shawl"
        />
      </Field>

      <Field label="Heading" help={SHAPE.heading.description} maxLength={120} value={data.heading}>
        <Input value={data.heading} onChange={(event) => update({ heading: event.target.value })} />
      </Field>

      <Field label="Introduction" help={SHAPE.body.description} maxLength={320} value={data.body}>
        <Textarea rows={2} value={data.body} onChange={(event) => update({ body: event.target.value })} />
      </Field>

      <Field label="Which side the photographs sit on" help={SHAPE.side.description}>
        <Select
          value={data.side}
          options={SIDE_OPTIONS}
          onChange={(event) => update({ side: event.target.value as StoryScrollSectionData["side"] })}
        />
      </Field>

      <Switch
        label="Show a progress rail down the side"
        description={SHAPE.showProgress.description}
        checked={data.showProgress}
        onCheckedChange={(checked) => update({ showProgress: checked })}
      />

      {/*
        One chapter is not a story. Said as a note rather than enforced, because "written the first
        chapter, about to write the second" is a normal state and the studio autosaves during it
        (schema rule 4) — a rule that fired here would refuse a save an editor is in the middle of.
      */}
      {data.chapters.length === 1 ? (
        <HelpText tone="warn">
          There is one chapter, so nothing scrolls past anything: the block reads as a single picture
          beside some words. Add a second chapter, or use an “Image beside text” block instead.
        </HelpText>
      ) : null}

      <RepeaterField<StoryChapter>
        label="The chapters"
        help={SHAPE.chapters.description}
        items={data.chapters}
        onChange={(chapters) => update({ chapters })}
        max={MAX_CHAPTERS}
        itemNoun="chapter"
        addLabel="Add a chapter"
        emptyMessage="No chapters yet. Add the first one — a photograph, a title and two or three short paragraphs."
        createItem={() => ({
          kicker: "",
          title: "",
          body: "",
          mediaId: "",
          // Null, not a framing of six empty buckets: a new chapter nobody has framed must serialise
          // exactly as one saved before this field existed (see the schema's note on the default).
          mediaScreens: null,
          craftImage: "",
          caption: "",
          href: "",
          ctaLabel: ""
        })}
        isEmpty={(chapter) =>
          [
            chapter.kicker,
            chapter.title,
            chapter.body,
            chapter.mediaId,
            chapter.craftImage,
            chapter.caption,
            chapter.href,
            chapter.ctaLabel
          ].every((value) => value.trim().length === 0)
        }
        summary={(chapter) => {
          const kicker = chapter.kicker.trim();
          const title = chapter.title.trim();
          if (kicker.length > 0 && title.length > 0) return `${kicker} — ${title}`;
          return title.length > 0 ? title : kicker;
        }}
        renderItem={({ item, index, update: updateChapter }) => {
          const hasHref = item.href.trim().length > 0;

          return (
            <>
              <Field
                label="The word above the title"
                help={CHAPTER.kicker.description}
                maxLength={40}
                value={item.kicker}
              >
                <Input
                  value={item.kicker}
                  onChange={(event) => updateChapter({ ...item, kicker: event.target.value })}
                  placeholder={index === 0 ? "One" : "The clay"}
                />
              </Field>

              <Field
                label="What this chapter is about"
                help={CHAPTER.title.description}
                maxLength={120}
                value={item.title}
              >
                <Input
                  value={item.title}
                  onChange={(event) => updateChapter({ ...item, title: event.target.value })}
                />
              </Field>

              <Field
                label="The chapter itself"
                help={CHAPTER.body.description}
                maxLength={900}
                value={item.body}
              >
                <Textarea
                  rows={7}
                  value={item.body}
                  onChange={(event) => updateChapter({ ...item, body: event.target.value })}
                />
              </Field>

              <MediaFramingField
                label="A photograph you have uploaded"
                help={CHAPTER.mediaId.description}
                framingHelp={CHAPTER.mediaScreens.description}
                mediaId={item.mediaId}
                framing={item.mediaScreens}
                /*
                 * Only while the ordinary chapters are what gets drawn. The cinematic telling replaces
                 * the whole block with its own authored sequence and ignores every chapter field, so a
                 * framing set there would be a control with no visible effect. The craft picker below
                 * needs no such guard: `MediaFramingField` shows the panel only once an UPLOADED
                 * photograph is chosen, and that is the only picture a framing can apply to.
                 */
                offerFraming={data.presentation === "chapters"}
                onChange={({ mediaId, framing }) =>
                  updateChapter({ ...item, mediaId, mediaScreens: framing })
                }
              />

              <CraftImagePicker
                value={item.craftImage}
                onChange={(craftImage) => updateChapter({ ...item, craftImage })}
                uploadedMediaId={item.mediaId}
                subject="this chapter"
                help={CHAPTER.craftImage.description}
              />

              <Field
                label="A line under the photograph"
                help={CHAPTER.caption.description}
                maxLength={160}
                value={item.caption}
              >
                <Input
                  value={item.caption}
                  onChange={(event) => updateChapter({ ...item, caption: event.target.value })}
                />
              </Field>

              <LinkDestinationField
                label="Where this chapter leads"
                value={item.href}
                help={CHAPTER.href.description}
                onChange={(href) => updateChapter({ ...item, href })}
              />

              {hasHref ? (
                <Field
                  label="Words on this chapter's link"
                  help={CHAPTER.ctaLabel.description}
                  maxLength={40}
                  value={item.ctaLabel}
                >
                  <Input
                    value={item.ctaLabel}
                    onChange={(event) => updateChapter({ ...item, ctaLabel: event.target.value })}
                    placeholder="Read the full account"
                  />
                </Field>
              ) : (
                // Absent rather than shown empty — see the header.
                <HelpText>
                  Add an address above and this chapter ends in a link, with words you can set here.
                </HelpText>
              )}
            </>
          );
        }}
      />
    </div>
  );
}
