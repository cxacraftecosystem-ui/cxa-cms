"use client";

/**
 * FaqForm — questions that open to reveal their answers.
 *
 * THE QUESTION IS WRITTEN AS SOMEBODY WOULD ASK IT. "How do I apply?" finds a reader; "Application
 * procedure" is a filing label. The schema says so in its help text and the placeholder shows it, because
 * this is the single most common thing to get wrong on an FAQ block and it makes the difference between a
 * page people search and a page people skim past.
 *
 * THE ANSWER IS 1,200 CHARACTERS, WHICH IS DELIBERATELY GENEROUS, and it is plain text rather than
 * formatted writing: an accordion full of headings and lists is a page pretending to be an article. Where
 * an answer genuinely needs formatting, the answer is a page and the FAQ entry links to it.
 */

import { faqSectionSchema, type FaqSectionData } from "@/lib/sections/schema";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { Textarea } from "@/components/ui/Textarea";
import { RepeaterField } from "@/components/studio/fields/RepeaterField";
import type { SectionFormProps } from "@/components/studio/sections";

const SHAPE = faqSectionSchema.shape;
const ITEM = SHAPE.items.removeDefault().element.shape;

type FaqItem = FaqSectionData["items"][number];

/** Matches `.max(30)` on the items array. */
const MAX_ITEMS = 30;

export function FaqForm({ data, onChange, onDirty }: SectionFormProps<FaqSectionData>) {
  const update = (patch: Partial<FaqSectionData>) => {
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

      <RepeaterField<FaqItem>
        label="The questions"
        help={SHAPE.items.description}
        items={data.items}
        onChange={(items) => update({ items })}
        max={MAX_ITEMS}
        itemNoun="question"
        addLabel="Add a question"
        createItem={() => ({ question: "", answer: "" })}
        isEmpty={(item) => item.question.trim().length === 0 && item.answer.trim().length === 0}
        summary={(item) => item.question}
        renderItem={({ item, update: updateItem }) => (
          <>
            <Field
              label="The question"
              help={ITEM.question.description}
              maxLength={200}
              value={item.question}
            >
              <Input
                value={item.question}
                onChange={(event) => updateItem({ ...item, question: event.target.value })}
                placeholder="How do I apply for a research position?"
              />
            </Field>

            <Field label="The answer" help={ITEM.answer.description} maxLength={1200} value={item.answer}>
              <Textarea
                rows={5}
                value={item.answer}
                onChange={(event) => updateItem({ ...item, answer: event.target.value })}
              />
            </Field>
          </>
        )}
      />

      <Switch
        label="Let several answers stay open at once"
        description={SHAPE.allowMultipleOpen.description}
        checked={data.allowMultipleOpen}
        onCheckedChange={(checked) => update({ allowMultipleOpen: checked })}
      />
    </div>
  );
}
