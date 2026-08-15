"use client";

/**
 * FaqList — the interactive half of the questions block.
 *
 * It exists as its own module for one reason: `FaqSection` emits FAQPage structured data through
 * `serializeJsonLd`, which lives in `lib/seo.ts` and is `server-only`, so that component cannot carry
 * a `"use client"` directive. The single-open behaviour needs state shared BETWEEN the items — an
 * `AccordionItem` left to itself keeps its own — so the state has to live in a client component, and
 * this is the smallest one that can hold it.
 *
 * ⚠ `AccordionItem` UNMOUNTS ITS PANEL WHEN CLOSED. Nothing here keeps state inside a panel, and
 * nothing may: a closed answer is gone from the document, which is also why the answers are plain
 * text rather than anything that could be mid-interaction.
 *
 * The open set is an array of indices rather than a Set because it is React state — a Set mutated in
 * place is the same object, and the re-render never happens.
 */

import { useState } from "react";

import { Accordion, AccordionItem } from "@/components/ui/Accordion";

export interface FaqListItem {
  question: string;
  answer: string;
}

export interface FaqListProps {
  items: readonly FaqListItem[];
  /** With this off, opening one answer closes the last. */
  allowMultipleOpen: boolean;
}

export function FaqList({ items, allowMultipleOpen }: FaqListProps) {
  const [open, setOpen] = useState<number[]>([]);

  const change = (index: number, next: boolean) => {
    setOpen((current) => {
      if (!next) return current.filter((value) => value !== index);
      if (!allowMultipleOpen) return [index];
      return current.includes(index) ? current : [...current, index];
    });
  };

  return (
    <Accordion>
      {items.map((item, index) => (
        <AccordionItem
          key={`${index}-${item.question}`}
          title={item.question}
          open={open.includes(index)}
          onOpenChange={(next) => change(index, next)}
        >
          {/*
            `whitespace-pre-line` so the blank lines an editor typed between paragraphs survive. The
            field is plain text by design — an answer is read as often as the page it sits on, and a
            second rich-text surface here would be a second thing to keep in step.
          */}
          <p className="whitespace-pre-line">{item.answer}</p>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
