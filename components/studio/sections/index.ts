/**
 * The section editor registry — one form per block type, and the contract every form is written to.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE MAP IS `{ [K in SectionType]: SectionFormComponent<SectionPayloads[K]> }` AND THAT IS THE POINT.
 *
 * Adding a value to the Prisma `SectionType` enum is a COMPILE ERROR here until a form exists for it, and
 * wiring a type to the wrong form is a compile error too, because each entry is checked against its OWN
 * payload type. That is the same guarantee `SECTION_SCHEMAS` gives for schemas, `SECTION_REGISTRY` gives
 * for palette entries and `RENDERERS` gives for the public renderers — four tables that cannot drift
 * apart, because none of them will compile if they do.
 *
 * ⚠ Do NOT annotate it as `Record<SectionType, SectionFormComponent<unknown>>`. That widens every entry's
 * payload to the union of all thirty and throws away exactly the check this file exists for.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * NO `"use client"` ON THIS FILE, DELIBERATELY. Every form below carries its own, so they are client
 * components wherever they are imported from — but a function exported from a `"use client"` module becomes
 * a client REFERENCE, and calling it on the server throws. `mergeSectionData()` is exactly the sort of pure
 * helper a route handler wants when it saves a section, so this module stays neutral and the boundary stays
 * where the components are. That rule did not relax when the function's body moved: a `"use client"` here
 * would poison the RE-EXPORT below just as surely as it would a definition, and `preview-draft/route.ts`
 * reaches `mergeSectionData` through this file today.
 *
 * ⚠ WHICH IS A GAP THIS FILE CAN RECORD BUT NOT CLOSE. A route handler importing one pure helper from this
 * barrel drags thirty client component modules into the server graph with it — harmless (they are only
 * referenced, never called) but pointless. The honest shape is for the ONE server-side caller,
 * `preview-draft/route.ts`, to import from `@/lib/sections/anchor` directly, as
 * `sections/[sectionId]/route.ts` and `prisma/seed.ts` already do, leaving this export for studio code.
 * That file is outside this pass's set; it is reported as an integrator diff rather than left unsaid.
 *
 * ⚠ ONE, NOT TWO, AND THE MISCOUNT WAS WORTH CORRECTING RATHER THAN QUIETLY FIXING. This paragraph used to
 * say "the two SERVER-side callers", which sent a reader looking for a second one and landing on
 * `PageBuilder.tsx:98` — the other importer of `mergeSectionData` from here, and a `"use client"` module,
 * which is precisely the caller the closing clause says should KEEP the barrel. Re-measured this pass over
 * the whole tree: three modules import this one at RUNTIME — `PageBuilder.tsx` (client) and
 * `preview-draft/route.ts` (server) for `mergeSectionData`, and `SectionEditorPanel.tsx` (client) for
 * `SECTION_FORMS`. The twenty form modules take `SectionFormProps` through `import type`, which erases
 * and reaches no module at all. So exactly one importer is on the server, and it is the route handler.
 *
 * A `.ts` FILE, SO THERE IS NO JSX IN IT. The builder needs to render a form for a type it only knows at
 * runtime, and TypeScript cannot follow "the form looked up by this key takes the payload parsed for the
 * same key" — so `sectionFormFor()` below does that with one documented cast, in the way `renderSection()`
 * does for the public side. Thirty `as` casts spread across a builder is the alternative.
 *
 * ⚠ THIS PARAGRAPH USED TO CLAIM THE CAST WAS IN "ONE PLACE" AND IT WAS NOT, WHICH IS WHY THE CORRECTION
 * IS RECORDED RATHER THAN QUIETLY MADE. `sectionFormFor()` has no caller anywhere in the tree:
 * `SectionEditorPanel` looks the form up in `SECTION_FORMS` itself (`forms[section.type]`) and carries its
 * OWN cast to its own `AnySectionForm`, so there are two. The claim mattered because a second false
 * guarantee was attached to it — see the ⚠ on `sectionFormFor` — and one form after another was written
 * trusting it. Both halves are now stated as they are.
 *
 * WHAT EVERY FORM PROMISES:
 *
 *   • It is CONTROLLED. Studio forms are React state, because they autosave and need dirty tracking
 *     (contract §10). A form never holds a private copy of the payload.
 *   • It calls `onChange` with the WHOLE payload, never a patch. `useAutosave` compares serialised
 *     snapshots, so a complete object is what makes "typed a character and deleted it again" clean.
 *   • It calls `onDirty` by hand on every change. Several controls in these forms are themed buttons and
 *     pickers rather than native inputs, and a dirty tracker listening for `onInput` never sees those.
 *   • It VALIDATES LOCALLY AGAINST THE SCHEMA ITSELF rather than waiting to be told. `LinkField` runs the
 *     schema's own link rule, `EmbedForm` runs the schema's own `superRefine` — so the message an editor
 *     reads is the message the save would have produced, and there is no second copy of it to drift.
 *   • It never renders gold and it never animates. Gold is marketing-only and never appears on a studio
 *     screen (contract §1.1); motion in the studio is confined to state transitions that carry meaning.
 */

import type { ReactNode } from "react";
import type { SectionType } from "@prisma/client";

import type { SectionPayloads } from "@/lib/sections/schema";

import { ActionStepsForm } from "@/components/studio/sections/ActionStepsForm";
import { CtaForm } from "@/components/studio/sections/CtaForm";
import { EmbedForm } from "@/components/studio/sections/EmbedForm";
import { FaqForm } from "@/components/studio/sections/FaqForm";
import { FeatureGridForm } from "@/components/studio/sections/FeatureGridForm";
import { FormEmbedForm } from "@/components/studio/sections/FormEmbedForm";
import { GalleryForm } from "@/components/studio/sections/GalleryForm";
import { HeroForm } from "@/components/studio/sections/HeroForm";
import { HorizontalRailForm } from "@/components/studio/sections/HorizontalRailForm";
import { LinkGridForm } from "@/components/studio/sections/LinkGridForm";
import { MediaSplitForm } from "@/components/studio/sections/MediaSplitForm";
import { ParallaxBannerForm } from "@/components/studio/sections/ParallaxBannerForm";
import { PlatformPillarsForm } from "@/components/studio/sections/PlatformPillarsForm";
import { IndiaMapForm } from "@/components/studio/sections/IndiaMapForm";
import { ProcessStepsForm } from "@/components/studio/sections/ProcessStepsForm";
import { QuoteForm } from "@/components/studio/sections/QuoteForm";
import { RichTextForm } from "@/components/studio/sections/RichTextForm";
import {
  ContactFormForm,
  CraftExplorerForm,
  DownloadsForm,
  MapForm,
  PartnerLogosForm,
  PublicationListForm,
  SpacerForm
} from "@/components/studio/sections/SimpleForms";
import {
  EventShowcaseForm,
  NewsShowcaseForm,
  PeopleShowcaseForm,
  ProjectShowcaseForm,
  ResearchShowcaseForm
} from "@/components/studio/sections/ShowcaseForm";
import { StatsForm } from "@/components/studio/sections/StatsForm";
import { StoryScrollForm } from "@/components/studio/sections/StoryScrollForm";
import { TimelineForm } from "@/components/studio/sections/TimelineForm";

/**
 * What every section form is called with.
 *
 * There is deliberately no `fieldErrors` prop. A section payload is validated by the same isomorphic Zod
 * schema in the browser and on the server (`lib/sections/schema.ts` rule 1), so a form that needs to
 * report a problem runs the rule itself and reports it beside the field that caused it — which happens
 * while the editor is still typing rather than after a refused save.
 */
export interface SectionFormProps<T> {
  data: T;
  /** The WHOLE payload, every time. See the header. */
  onChange: (next: T) => void;
  /** Call it on every change. Custom controls fire no native input event (contract §10). */
  onDirty?: () => void;
}

export type SectionFormComponent<T> = (props: SectionFormProps<T>) => ReactNode;

/** Every block type to the form that edits it. See the warning in the header before annotating this. */
export const SECTION_FORMS: { [K in SectionType]: SectionFormComponent<SectionPayloads[K]> } = {
  HERO: HeroForm,
  RICH_TEXT: RichTextForm,
  STATS: StatsForm,
  FEATURE_GRID: FeatureGridForm,
  RESEARCH_SHOWCASE: ResearchShowcaseForm,
  PROJECT_SHOWCASE: ProjectShowcaseForm,
  PEOPLE_SHOWCASE: PeopleShowcaseForm,
  PUBLICATION_LIST: PublicationListForm,
  NEWS_SHOWCASE: NewsShowcaseForm,
  EVENT_SHOWCASE: EventShowcaseForm,
  GALLERY: GalleryForm,
  MEDIA_SPLIT: MediaSplitForm,
  TIMELINE: TimelineForm,
  PARTNER_LOGOS: PartnerLogosForm,
  QUOTE: QuoteForm,
  CTA: CtaForm,
  FAQ: FaqForm,
  CONTACT_FORM: ContactFormForm,
  MAP: MapForm,
  EMBED: EmbedForm,
  DOWNLOADS: DownloadsForm,
  CRAFT_EXPLORER: CraftExplorerForm,
  SPACER: SpacerForm,
  // The three newer blocks. ACTION_STEPS is a numbered sequence, FORM_EMBED is a form hosted by one of
  // four named services, LINK_GRID is a grid of onward destinations built from `LinkField`.
  ACTION_STEPS: ActionStepsForm,
  FORM_EMBED: FormEmbedForm,
  LINK_GRID: LinkGridForm,
  // The four narrative blocks (registry group "Story"). Each of the four takes its picture from EITHER
  // the media library or the bundled craft manifest, so each of the four forms pairs an `EntityPicker`
  // with a `CraftImagePicker` — and that picker, not the four forms, is what states the precedence an
  // uploaded photograph has over a bundled one (the rule StoryPicture.tsx implements). Four forms each
  // wording that sentence for themselves would be four chances to word it differently.
  STORY_SCROLL: StoryScrollForm,
  PARALLAX_BANNER: ParallaxBannerForm,
  HORIZONTAL_RAIL: HorizontalRailForm,
  PROCESS_STEPS: ProcessStepsForm,
  // The platform's three fixed vignettes: the drawings and their captions are code, so the form
  // edits the header only and says so (see PlatformPillarsForm's own header).
  PLATFORM_PILLARS: PlatformPillarsForm,
  INDIA_MAP: IndiaMapForm
};

/** The props a form takes once the type is only known at runtime. */
export interface AnySectionFormProps {
  data: unknown;
  onChange: (next: unknown) => void;
  onDirty?: () => void;
}

export type AnySectionForm = (props: AnySectionFormProps) => ReactNode;

/**
 * The form for a block type, ready to render.
 *
 * ⚠ THE CAST IS THE SINGLE UNCHECKED STEP IN THIS FILE, and it restates a guarantee the map above has
 * already proved: each entry accepts its own payload. What TypeScript cannot express is that the key used
 * to look up the FORM is the same key used to parse the DATA — the two are correlated at runtime only.
 * Keeping the assertion here is the same decision `SectionRenderer.tsx` makes for the public side. "Here,
 * once" is what this used to say and it is not true of the product — see the correction in the header.
 *
 * Returns null for a type this deployment has never heard of — a row written by a NEWER release and seen
 * after a rollback. `SectionEditorPanel` renders a card saying exactly that, off its own lookup rather than
 * off this one; "undefined is not a function" inside a page builder is a white screen with an editor's
 * unsaved work behind it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ NOTHING CALLS THIS, AND THE RULE IT USED TO STATE WAS A GUARANTEE NOTHING WAS ENFORCING. THAT
 * SENTENCE PUT THREE WHITE SCREENS IN FRONT OF EDITORS, SO IT IS CORRECTED HERE RATHER THAN DELETED.
 * (It said two until the third was found and fixed; the count is deliberately kept in step with the list
 * below, because the number is the only thing that shows how far one false guarantee travelled.)
 *
 * It read: "The DATA handed to the returned form must be a PARSED payload from `parseSectionData()`, never
 * the raw `PageSection.data`. Every form reads its fields directly … because the schema guarantees each one
 * is present." Form after form was then written trusting it, and it is false on the builder's RECOVERY path:
 *
 *   • `normaliseSection` (components/studio/builder/PageBuilder.tsx) parses once at the door and, WHEN THE
 *     PARSE FAILS, falls back to `repairSectionData` — `{ ...defaults, ...raw }`, a deliberately shallow
 *     merge that DOES NOT PARSE. Every raw value present in the row survives verbatim. That is correct for
 *     what it is for: the editor has to SEE the wrong value in order to correct it.
 *   • ANY failure anywhere in the payload takes that branch, not one in the offending field.
 *   • `SectionEditorPanel` then hands the form that working copy, and says so on its own `value` prop.
 *
 * THREE crashes have now been demonstrated and fixed at the forms rather than here, because the repair path
 * is right and it is the FORMS that must survive it:
 *
 *   • `CENSUS_METRIC_DEFINITIONS[item.metric].label` in StatsForm.tsx — now `definitionFor()`;
 *   • `PROVIDER_PATTERNS[data.provider].test(…)` in EmbedForm.tsx — now `PATTERN_FOR_PROVIDER`, with the
 *     trace written out on it;
 *   • `describeFormHosts(data.provider)` in FormEmbedForm.tsx — now `knownProvider()`. The worst of the
 *     three: it was UNCONDITIONAL, so an unknown provider took the builder down on the first render rather
 *     than on a keystroke, and the crash was inside the schema helper rather than at the form's own
 *     bracket, which is why grepping for `TABLE[data.field]` did not find it the first two times.
 *
 * All three read a table keyed on an enum with a value that had never been through the enum. ⚠ **A FORM MAY
 * NOT ASSUME ITS PAYLOAD PARSED. A lookup keyed on a stored value must be widened so the compiler forces the
 * miss to be handled — and that includes a lookup one call deep, inside a helper whose parameter is typed to
 * the enum** — that is the rule this file can honestly state, and it is the one every new form should be
 * read against. The `components/studio/sections/` tree was swept again for a fourth instance when the third
 * was fixed; there is none. The only remaining narrow read of a stored value is `PROVIDER_NAMES[data.provider]`
 * in EmbedForm.tsx, which its own ⚠ shows is gated off the crash path and which interpolates rather than
 * dereferences.
 *
 * ⚠ STILL NOT DEFENDED ANYWHERE, stated so it is not rediscovered as a surprise: the same path can hand a
 * form a value of the wrong TYPE (`items` that is not an array, `label` that is a number), and no form of
 * the thirty survives that. One defect, one root, in `repairSectionData` — a file outside this pass's set,
 * reported as an integrator diff rather than papered over with a `String()` in one form out of thirty.
 *
 * KEPT DESPITE HAVING NO CALLER, and the reason is not sentiment. The `Partial<Record<string, …>>` read
 * below is the pattern the crash fixes copied, and `StatsForm.tsx` cites this function BY NAME as the
 * idiom `METRIC_DEFINITIONS` follows — deleting it would turn live references into references to
 * nothing, which is this repository's other recurring defect. Said plainly here instead, exactly as
 * `lib/sections/anchor.ts` does for `suggestAnchor`.
 *
 * ⚠ COUNTS WERE DELIBERATELY REMOVED FROM THIS PARAGRAPH. It used to say "both crash fixes" and "twice",
 * and each number was corrected by a later pass and then falsified again by the pass after it — three
 * separate agents spent effort re-counting citations that change whenever anybody edits a sibling form.
 * A claim that has to be re-measured on every edit will be wrong more often than right. State the
 * relationship, not the tally.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function sectionFormFor(type: SectionType | string): AnySectionForm | null {
  const lookup: Partial<Record<string, AnySectionForm>> = SECTION_FORMS as unknown as Partial<
    Record<string, AnySectionForm>
  >;
  return lookup[type] ?? null;
}

/**
 * Fold an edited payload back into the row's stored `data`, keeping the one key that lives outside it.
 *
 * ⚠ CALL THIS INSTEAD OF WRITING THE FORM'S PAYLOAD STRAIGHT BACK. A section's named anchor is stored on
 * `data.anchor` and is deliberately NOT part of any of the thirty schemas — it is addressing rather
 * than content, and adding it to thirty schemas would be thirty chances to forget one (see
 * `lib/sections/anchor.ts`). `z.object()` strips unknown keys, so the parsed payload a form receives has
 * already lost it: writing that payload back would delete the anchor the first time anybody edited any
 * field, and every menu entry pointing at `/about#history` would quietly stop working.
 *
 * Nothing else is carried over. Junk accumulated by an older editor is meant to be cleaned on every save,
 * which is exactly what `z.object()`'s stripping is for.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS IS NOW A RE-EXPORT, AND THE REASON IS A SILENT, UNRECOVERABLE FAILURE RATHER THAN TIDINESS.
 *
 * The body used to live here as well, BYTE-IDENTICAL to the one in `lib/sections/anchor.ts` (diffed:
 * same md5). Two copies would be merely untidy if one set of callers used one of them — but the callers
 * were SPLIT down the middle, which is what made it dangerous:
 *
 *   • `app/api/studio/pages/[id]/preview-draft/route.ts` and `PageBuilder.tsx` imported THIS one;
 *   • `app/api/studio/pages/[id]/sections/[sectionId]/route.ts` and `prisma/seed.ts` imported THAT one.
 *
 * So a fix or a hardening applied to either copy would leave the other one deleting block anchors — and
 * that loss is both silent and unrecoverable by the editor, because `lib/sections/anchor.ts` records that
 * NO studio surface can type an anchor back in: `suggestAnchor` has no caller and the block settings panel
 * has no field for an address on the page. Today's anchors come from the seed and from imports, three of
 * them quoted by the shipped default menu in `lib/navigation.ts`. One dropped anchor is a menu entry that
 * scrolls nowhere, with no screen anywhere to retype it on.
 *
 * ⚠ THE DIRECTION IS index → anchor, NOT THE REVERSE, and it is not arbitrary. `lib/sections/anchor.ts` is
 * where the whole argument for living outside the schema is written, it is the copy the SERVER-side writers
 * already import, and it is dependency-free of this module — so pointing this way cannot make a cycle,
 * while pointing the other way would put a barrel of thirty client components behind a helper the seed
 * script imports. The header above is kept as the pointer a reader arriving from a studio import needs;
 * the implementation, and the last word on it, are in one place.
 *
 * The neutrality this module's header claims is unaffected: `lib/sections/anchor.ts` carries no
 * `"use client"` and no `server-only`, and its only dependency is `slugify` from `lib/utils.ts`, whose own
 * header says it is "safe on both sides of the server/client boundary".
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export { mergeSectionData } from "@/lib/sections/anchor";

// The individual forms are exported as well, for a screen that edits one block type on its own rather
// than through the builder — the homepage hero, for instance, or a settings screen that owns one block.
export { ActionStepsForm } from "@/components/studio/sections/ActionStepsForm";
export { CtaForm } from "@/components/studio/sections/CtaForm";
export { EmbedForm } from "@/components/studio/sections/EmbedForm";
export { FaqForm } from "@/components/studio/sections/FaqForm";
export { FeatureGridForm } from "@/components/studio/sections/FeatureGridForm";
export { FormEmbedForm } from "@/components/studio/sections/FormEmbedForm";
export { GalleryForm } from "@/components/studio/sections/GalleryForm";
export { HeroForm } from "@/components/studio/sections/HeroForm";
export { HorizontalRailForm } from "@/components/studio/sections/HorizontalRailForm";
export { LinkGridForm } from "@/components/studio/sections/LinkGridForm";
export { MediaSplitForm } from "@/components/studio/sections/MediaSplitForm";
export { ParallaxBannerForm } from "@/components/studio/sections/ParallaxBannerForm";
export { PlatformPillarsForm } from "@/components/studio/sections/PlatformPillarsForm";
export { IndiaMapForm } from "@/components/studio/sections/IndiaMapForm";
export { ProcessStepsForm } from "@/components/studio/sections/ProcessStepsForm";
export { QuoteForm } from "@/components/studio/sections/QuoteForm";
export { RichTextForm } from "@/components/studio/sections/RichTextForm";
export { StatsForm } from "@/components/studio/sections/StatsForm";
export { StoryScrollForm } from "@/components/studio/sections/StoryScrollForm";
export { TimelineForm } from "@/components/studio/sections/TimelineForm";
// The picker the four narrative forms share. Exported for the same reason the forms are: a screen that
// edits one block on its own still has to offer both picture sources, and both must state which wins.
export {
  CraftImagePicker,
  type CraftImagePickerProps
} from "@/components/studio/sections/CraftImagePicker";
export {
  ContactFormForm,
  CraftExplorerForm,
  DownloadsForm,
  MapForm,
  PartnerLogosForm,
  PublicationListForm,
  SpacerForm
} from "@/components/studio/sections/SimpleForms";
export {
  EventShowcaseForm,
  NewsShowcaseForm,
  // `NumberField` lives in ShowcaseForm.tsx because both it and SimpleForms.tsx need it; it is exported
  // here as well because any studio screen with a number in it wants the same behaviour, and the plainly
  // controlled version of that field cannot be typed a decimal point into (see its header).
  NumberField,
  PeopleShowcaseForm,
  ProjectShowcaseForm,
  ResearchShowcaseForm,
  ShowcaseFields,
  showcaseHelp,
  type NumberFieldProps,
  type ShowcaseFieldsProps,
  type ShowcaseHelp,
  type ShowcaseLike
} from "@/components/studio/sections/ShowcaseForm";
