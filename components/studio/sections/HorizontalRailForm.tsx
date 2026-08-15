"use client";

/**
 * HorizontalRailForm — the editor for a line of cards the reader travels along sideways.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ "HOLD THE PAGE STILL" IS THE ONE SETTING ON THIS SCREEN THAT COSTS THE READER SOMETHING.
 *
 * The rail itself is an ordinary scrollable strip: operable by touch, by a trackpad, by a scrollbar
 * and by the keyboard, and it is what every reader gets with no JavaScript, under reduced motion and
 * on a telephone. `pin` adds the cinema on wide screens — the section stops and the rail travels
 * sideways as the reader scrolls down — and it does that by TAKING THE SCROLL AWAY for the length of
 * the rail. On a long rail that is a long time for the page to refuse to go down.
 *
 * So the switch is an opt-in with an honest name, the schema's own sentence about the cost is shown
 * verbatim, and turning it on with more than six cards is warned about here — the one place where the
 * number of cards and the setting are visible at the same moment.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE ORDER IS EDITORIAL AND `RepeaterField` REORDERS FROM THE KEYBOARD as well as by dragging. The
 * first card is the one every reader sees without doing anything at all — on a rail, more so than in a
 * grid, because the later cards are off the edge of the screen until somebody moves them.
 *
 * A CARD'S LINK IS OPTIONAL AND IT DECIDES WHAT THE CARD IS: with an address the whole card is a
 * link, without one it is a picture with a caption. Both are legitimate on the same rail.
 */

import { horizontalRailSectionSchema, type HorizontalRailSectionData } from "@/lib/sections/schema";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { Textarea } from "@/components/ui/Textarea";
import { HelpText } from "@/components/studio/HelpText";
import { EntityPicker } from "@/components/studio/fields/EntityPicker";
import { LinkDestinationField } from "@/components/studio/fields/LinkField";
import { RepeaterField } from "@/components/studio/fields/RepeaterField";
import { CraftImagePicker } from "@/components/studio/sections/CraftImagePicker";
import type { SectionFormProps } from "@/components/studio/sections";

const SHAPE = horizontalRailSectionSchema.shape;
const ITEM = SHAPE.items.removeDefault().element.shape;

type RailCard = HorizontalRailSectionData["items"][number];

/** ⚠ Matches `.max(20)` on the items array. A different number here caps a list the save would allow. */
const MAX_CARDS = 20;

/**
 * The most cards a pinned rail should carry.
 *
 * The schema's own help says "six cards or fewer", so the number lives in both places and must move in
 * both. It is the length past which the scroll is held for longer than a reader will tolerate.
 */
const COMFORTABLE_PINNED_CARDS = 6;

/** The CSS words are the stored values; the British prose is what a person reads (schema header). */
const CARD_WIDTH_OPTIONS = [
  { value: "sm", label: "Small — about four cards at a time" },
  { value: "md", label: "Medium — about three at a time" },
  { value: "lg", label: "Large — about two at a time" }
] as const;

export function HorizontalRailForm({
  data,
  onChange,
  onDirty
}: SectionFormProps<HorizontalRailSectionData>) {
  const update = (patch: Partial<HorizontalRailSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  return (
    <div className="space-y-5">
      <Field label="How the line is drawn" help={SHAPE.presentation.description}>
        <Select
          value={data.presentation}
          options={[
            { value: "rail", label: "Rail — the scrolling line" },
            { value: "arc", label: "Arc — cards fanned along a curve the reader can turn" }
          ]}
          onChange={(event) =>
            update({ presentation: event.target.value as HorizontalRailSectionData["presentation"] })
          }
        />
      </Field>

      {data.presentation === "arc" ? (
        <HelpText tone="neutral">
          The arc draws the same cards below fanned along a curve, turned by dragging or by two
          arrow buttons. It sizes its own cards and never holds the page still, so the card width
          and &ldquo;hold the page&rdquo; settings apply to the rail only and are IGNORED while the
          arc is chosen; switch back and the rail returns exactly as it was.
        </HelpText>
      ) : null}

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

      <Field label="How wide each card is" help={SHAPE.cardWidth.description}>
        <Select
          value={data.cardWidth}
          options={CARD_WIDTH_OPTIONS}
          onChange={(event) =>
            update({ cardWidth: event.target.value as HorizontalRailSectionData["cardWidth"] })
          }
        />
      </Field>

      <Switch
        label="Hold the page still and move the rail"
        description={SHAPE.pin.description}
        checked={data.pin}
        onCheckedChange={(pin) => update({ pin })}
      />

      {/* The count and the setting are only visible together here — see the header. Quiet while the
          arc is chosen: pinning is ignored there, and a warning about a cost nobody is paying is
          noise that teaches editors to skip warnings. */}
      {data.presentation !== "arc" && data.pin && data.items.length > COMFORTABLE_PINNED_CARDS ? (
        <HelpText tone="warn">
          This rail holds {data.items.length} cards and the page is set to be held still while they
          pass. That is {data.items.length - COMFORTABLE_PINNED_CARDS} more than the{" "}
          {COMFORTABLE_PINNED_CARDS} this is comfortable with: a reader trying to get further down the
          page has to scroll through all of them first. Take some out, or switch the holding off.
        </HelpText>
      ) : null}

      <RepeaterField<RailCard>
        label="The cards"
        help={SHAPE.items.description}
        items={data.items}
        onChange={(items) => update({ items })}
        max={MAX_CARDS}
        itemNoun="card"
        addLabel="Add a card"
        emptyMessage="No cards yet. Add the first one — the left-hand card is the one every reader sees."
        createItem={() => ({
          title: "",
          detail: "",
          meta: "",
          mediaId: "",
          craftImage: "",
          href: ""
        })}
        isEmpty={(card) =>
          [card.title, card.detail, card.meta, card.mediaId, card.craftImage, card.href].every(
            (value) => value.trim().length === 0
          )
        }
        summary={(card) => card.title}
        renderItem={({ item, update: updateCard }) => (
          <>
            <Field label="What this card is" help={ITEM.title.description} maxLength={120} value={item.title}>
              <Input
                value={item.title}
                onChange={(event) => updateCard({ ...item, title: event.target.value })}
              />
            </Field>

            <Field label="A line or two about it" help={ITEM.detail.description} maxLength={280} value={item.detail}>
              <Textarea
                rows={3}
                value={item.detail}
                onChange={(event) => updateCard({ ...item, detail: event.target.value })}
              />
            </Field>

            <Field
              label="A small line under the title"
              help={ITEM.meta.description}
              maxLength={60}
              value={item.meta}
            >
              <Input
                value={item.meta}
                onChange={(event) => updateCard({ ...item, meta: event.target.value })}
                placeholder="Kutch, Gujarat"
              />
            </Field>

            <EntityPicker
              kind="media"
              max={1}
              label="A photograph you have uploaded"
              help={ITEM.mediaId.description}
              ids={item.mediaId.length > 0 ? [item.mediaId] : []}
              onChange={(next) => updateCard({ ...item, mediaId: next[0] ?? "" })}
            />

            <CraftImagePicker
              value={item.craftImage}
              onChange={(craftImage) => updateCard({ ...item, craftImage })}
              uploadedMediaId={item.mediaId}
              subject="this card"
              help={ITEM.craftImage.description}
            />

            <LinkDestinationField
              label="Where this card goes"
              value={item.href}
              help={ITEM.href.description}
              onChange={(href) => updateCard({ ...item, href })}
            />
          </>
        )}
      />
    </div>
  );
}
