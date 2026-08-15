/**
 * SpacerSection — deliberate empty space, and nothing else.
 *
 * It exists so a builder can breathe a page out without inventing a text block full of empty
 * paragraphs, which is what people do when there is no spacer and which leaves the page carrying
 * markup that means nothing.
 *
 * ⚠ IT IS THE ONE BLOCK THAT DOES NOT WEAR THE `py-20 md:py-28` SECTION RHYTHM. The block IS the
 * space; wrapping it in the standard padding would make the smallest setting taller than the gap it
 * was meant to fine-tune. The four sizes are additions ON TOP of the rhythm the blocks either side
 * already have — which is why even `xl` is measured in a couple of paragraphs rather than a screen.
 *
 * `aria-hidden` and no children: there is nothing here to announce, and an unlabelled empty element
 * in the accessibility tree is a thing a screen reader stops on for no reason.
 */

import type { PageSection } from "@prisma/client";

import type { SpacerSectionData } from "@/lib/sections/schema";

export interface SpacerSectionProps {
  data: SpacerSectionData;
  section: PageSection;
}

/** Complete literal class strings — a `h-${size}` built from the payload is purged (contract §5). */
const SIZE_CLASS: Record<SpacerSectionData["size"], string> = {
  sm: "h-6 md:h-8",
  md: "h-12 md:h-16",
  lg: "h-20 md:h-28",
  xl: "h-32 md:h-44"
};

export function SpacerSection({ data }: SpacerSectionProps) {
  return <div aria-hidden="true" className={SIZE_CLASS[data.size]} />;
}
