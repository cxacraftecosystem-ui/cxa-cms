"use client";

/**
 * RichTextForm — the everyday text block: its heading, its writing surface, and its typesetting.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS FORM USED TO CARRY AN EDITOR OF ITS OWN, AND THAT WAS THE SINGLE WORST WRITING SURFACE IN THE
 *   PRODUCT. THE WHOLE OF WHY IT IS GONE.
 *
 * It mounted a bare `StarterKit` with eleven toolbar buttons: bold, italic, underline, two heading
 * levels, two lists, a quotation, a link, undo and redo. Every OTHER editor in this studio — news,
 * crafts, events, people, projects, research — mounts `components/studio/editor/RichTextEditor.tsx`,
 * which offers the lead paragraph, the drop cap, the pull quote, the side note, the four callout tones,
 * footnotes, definition lists, multi-column passages, tables, media-library figures, the "/" block menu
 * and the full mark set.
 *
 * AND `components/RichText.tsx` — the one public renderer — DRAWS ALL OF IT ALREADY. So the gap was not
 * "this block supports less". It was:
 *
 *   • **The pages an editor BUILDS had the poorest writing surface on the site**, while an article, a
 *     biography and a craft record all had the best one. "The typesetting of the pages that get created
 *     is yucky" is the owner's own sentence, and this file was the largest single cause of it: a page
 *     built out of RICH_TEXT blocks could not contain a standfirst, a pulled-out quotation, a note in
 *     the margin, a footnote or a table, because there was no way to type one.
 *   • **The house typesetting had almost nothing to act on.** The panel below offers a drop cap, a
 *     pull-quote treatment and a lead-paragraph size — and the editor above it could not produce a drop
 *     cap, a pull quote or a lead paragraph. Ten controls governing blocks that could not exist.
 *   • **A document PASTED IN from an article silently degraded.** The public HTML carries the studio's
 *     marker attributes (`data-lead`, `data-drop-cap`, `data-pull-quote`, `data-side-note`), and
 *     `parseHTML` in components/studio/editor/extensions.ts reads them back — but an extension that is
 *     not mounted cannot parse anything, so `paragraph`'s plain `p` rule won at priority 50 and every
 *     one of those nodes became an ordinary paragraph with no warning.
 *
 * ⚠ EVERYTHING THE OLD HEADER EXPLAINED IS STILL TRUE — IT IS JUST TRUE INSIDE `RichTextEditor` NOW, AND
 *   THAT IS THE POINT OF DELETING IT HERE RATHER THAN THE COST OF IT. `immediatelyRender: false` (the
 *   SSR/hydration guard), feeding the document in ONCE, reading the callbacks through a ref, and heading
 *   levels that never reach level 1 are all decisions that file makes and documents. Two of them it
 *   makes BETTER: it compares documents with a key-order-independent `fingerprint()` **and holds an
 *   external replacement until the field loses focus**, where this file rebuilt the editor the moment a
 *   differing document arrived — losing the caret and the undo history mid-sentence if an autosave
 *   response happened to differ. And it runs `describeSchemaDrift()` in development, which is the check
 *   that an editor cannot produce content the renderer would drop.
 *
 * ⚠ SO THE `orderInsensitiveJson` / `externalRevision` MACHINERY THAT USED TO LIVE HERE IS DELETED, NOT
 *   MOVED. It was a second, cruder implementation of one idea. Keeping both would be two answers to
 *   "has this document changed?", and the first time they disagreed the caret would jump.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ THE PICTURE PICKER IS MOUNTED HERE, BECAUSE `RichTextEditor` DELIBERATELY DOES NOT OWN ONE.
 *
 * It asks for a picture through a promise-returning callback instead (its header explains why), so a
 * caller that wants figures has to bridge the dialog to that promise. Every other caller does; this one
 * does it below. Hand it no callback and there is no figure button and no "/" entry offering one — the
 * prop's own documentation guarantees the control is ABSENT rather than present and inert. That is the
 * right failure, and the next block is about the one case where it is the failure we WANT.
 *
 * ⚠ `storageReady` ARRIVES AS AN OPTIONAL PROP, AND BOTH GATES THE HOUSE USES ARE WIRED TO IT.
 *
 * It is `storageConfigured()` from lib/env.ts — read from `S3_BUCKET`, `S3_REGION` and the access keys,
 * not one of which is a `NEXT_PUBLIC_` name — so it is a SERVER fact and this `"use client"` file cannot
 * read it. There is no client-safe module that can, and no endpoint an editor may call that reports it:
 * `GET /api/studio/settings` returns it but is `requireCapability(canManageSettings)`, administrator
 * only, so asking would answer "not ready" for every editor on a perfectly configured site. Checked, not
 * assumed.
 *
 * So the two gates below are the house ones, driven by the prop:
 *
 *   • `onRequestMedia={storageReady ? requestMedia : undefined}` — ArticleEditor.tsx:660's exact shape.
 *     With no callback `RichTextEditor` withholds the toolbar button AND the "/" menu entry rather than
 *     offering an inert one (its own lines 725 and 741 say so).
 *   • `storageReady` onto the picker itself — CraftEditor.tsx:1199's exact shape. It gates the "Add a
 *     file" button (MediaPicker.tsx:239) and the drop zone inside the dialog (UploadQueue.tsx:317).
 *
 * ⚠ WHAT IS NOT DONE, SAID PLAINLY: NOTHING PASSES THE PROP YET, SO IT DEFAULTS TO `true`.
 * `SectionFormProps` is `{ data, onChange, onDirty }` and
 * `components/studio/builder/SectionEditorPanel.tsx` renders `<Form data={…} onChange={…} />` — only
 * those two — even though `app/studio/pages/[id]/PageEditor.tsx` already holds `storageReady` and passes
 * it to its own SEO-image picker. Closing that is one optional field on `SectionFormProps`, one attribute
 * on `SectionEditorPanel`, and one pass-through in `PageBuilder`; all three are files this work does not
 * own, and the diff is filed for whoever does.
 *
 * ⚠ AND THE DEFAULT IS `true` BECAUSE EVERY OTHER DEFAULT WOULD LIE. `MediaPicker`'s own default is
 * `true` (MediaPicker.tsx:81), so `true` is exactly the behaviour that already shipped. `false` would
 * take a WORKING upload area away from every properly configured deployment — which is every real one —
 * and it would make the picker's own empty state read "Files cannot be uploaded until the file store has
 * been set up on this installation" on an installation where it plainly has been. A sentence on screen
 * that states a rule the system does not keep is worse than no sentence at all.
 *
 * So on a deployment with no object storage, until that one field lands, the upload area is still offered
 * here. What it is NOT is silent: `requireStorage()` in lib/storage/client.ts answers the presign request
 * with a **503** and the sentence "File storage is not configured on this deployment, so uploads are
 * unavailable. An administrator needs to set S3_BUCKET, S3_REGION and the access keys", and `UploadQueue`
 * prints exactly that through `asApiClientError`. Browsing the library — which is where a picture is
 * meant to come from — works either way.
 *
 * ⚠ AND ONE VISUAL WRINKLE, WRITTEN DOWN BECAUSE IT IS EASY TO MISTAKE FOR A BUG. `EditorToolbar` is
 * `position: sticky` at an INLINE `top: 64px` — the height of the studio's own top bar — and
 * `RichTextEditor` does not expose that offset. The page builder puts this form inside a panel that is
 * `lg:overflow-y-auto`, and an overflow ancestor becomes the scroll port for anything sticky inside it,
 * so above `lg` the toolbar pins 64px down from the panel's top edge instead of against the studio bar.
 * It stays visible and usable; it is one band lower than it should be. Below `lg` the page itself
 * scrolls and it is exactly right. The fix is a `stickyOffset` passthrough on `RichTextEditorProps`,
 * which is not this file's to add.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE TYPESETTING PANEL, AND THE THREE RULES IT FOLLOWS.
 *
 * 1. **EVERY CONTROL OPENS ON "Follow the site's house style".** Ten dropdowns that each arrived with an
 *    opinion would be ten decisions taken by whoever built the block rather than by the institution.
 *    `lib/typography/typeset.ts` resolves `inherit` against the `typography` settings group, so the
 *    default answer to all ten is "whatever Settings says", and a block only differs where somebody
 *    deliberately made it differ. That is also why the panel is a closed disclosure whose summary counts
 *    the overrides: the common case is none, and a wall of type controls above the text an editor came
 *    here to write is a wall between them and their job.
 *
 * 2. **A CHOICE THAT WILL NOT BE APPLIED SAYS SO, HERE, IMMEDIATELY.** A drop cap on centred text and
 *    justification on centred text are both impossible rather than merely unwise, and `resolveTypeset`
 *    returns the sentences explaining why. Without them an editor throws a switch, sees no change, and
 *    concludes the studio is broken (contract §1.6).
 *
 * 3. ⚠ **AND IF THE PAYLOAD CANNOT YET STORE THEM, THAT IS SAID TOO.** `typeset` is a field on
 *    `richTextSectionSchema` in `lib/sections/schema.ts`. `z.object()` strips unknown keys, so until
 *    that field exists every choice made here is discarded by the next save — silently, because nothing
 *    else would notice. The check below is a runtime look at the schema's own shape rather than a
 *    version flag: it is true the moment the field lands and needs nothing switching off afterwards.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useRef, useState } from "react";

import { richTextSectionSchema, type RichTextSectionData } from "@/lib/sections/schema";
import type { RichTextDoc } from "@/lib/richtext";
import {
  BLOCK_TYPESET_DEFAULT,
  FACE_CHOICES,
  HEADING_WRAP_CHOICES,
  HOUSE_TYPESET_DEFAULT,
  LEADING_CHOICES,
  MEASURE_CHOICES,
  PARAGRAPH_STYLE_CHOICES,
  SIZE_CHOICES,
  SPACING_CHOICES,
  TOGGLE_CHOICES,
  blockFaceEnum,
  blockHeadingWrapEnum,
  blockLeadingEnum,
  blockMeasureEnum,
  blockParagraphStyleEnum,
  blockSizeEnum,
  blockSpacingEnum,
  blockToggleEnum,
  blockTypesetSchema,
  countTypesetOverrides,
  resolveTypeset,
  typesetOf,
  withTypeset,
  type BlockTypeset,
  type TypesetChoice
} from "@/lib/typography/typeset";
import { Button } from "@/components/ui/Button";
import { Field, FieldBlock } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { HelpText } from "@/components/studio/HelpText";
import { RichTextEditor } from "@/components/studio/editor/RichTextEditor";
import type { EditorMediaSelection } from "@/components/studio/editor/extensions";
import { EntityPicker } from "@/components/studio/fields/EntityPicker";
import { CraftImagePicker } from "@/components/studio/sections/CraftImagePicker";
import { MediaPicker } from "@/components/studio/media/MediaPicker";
import type { StudioMediaAsset } from "@/components/studio/media/MediaGrid";
import type { SectionFormProps } from "@/components/studio/sections";

const SHAPE = richTextSectionSchema.shape;
const TYPESET_SHAPE = blockTypesetSchema.shape;

/**
 * Can a typesetting choice actually be SAVED on this deployment?
 *
 * See rule 3 in the header. Asked of the schema's own shape, once, at module load — the answer cannot
 * change while the studio is open, and asking per render would suggest it could.
 */
const TYPESET_STORED = Object.prototype.hasOwnProperty.call(SHAPE, "typeset");

/**
 * What an author can reach in the writing area, said in the field's own help.
 *
 * ⚠ IT IS COMPOSED WITH THE SCHEMA'S DESCRIPTION RATHER THAN REPLACING IT. `SHAPE.body.description` is
 * the one canonical sentence about what this field IS; this adds the one thing a schema cannot know —
 * which blocks the mounted editor can produce, and how to find them. Every other editor in the studio
 * writes its own version of this second sentence beside its own `RichTextEditor`, so this is the house
 * pattern rather than a sixth copy of a constant.
 */
const BODY_HELP = `${SHAPE.body.description ?? ""} Headings, lists, quotations, pull quotes, standfirsts, callouts, footnotes, definition lists, tables and pictures are all available; press “/” on an empty line for the full list.`;

const WIDTH_OPTIONS = [
  { value: "narrow", label: "Narrow — a comfortable reading width" },
  { value: "wide", label: "Wide — fills the column" }
] as const;

const ALIGNMENT_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "center", label: "Centred" },
  { value: "right", label: "Right" }
] as const;

/**
 * The six arrangements, worded as an editor would describe them to a colleague rather than as the
 * enum spells them. The order is the schema's, and it is deliberate: the three text-alone
 * arrangements first (the common case, and the one every existing block already is), then the
 * three that bring a picture.
 */
const LAYOUT_OPTIONS = [
  { value: "left", label: "Text alone, sitting left" },
  { value: "right", label: "Text alone, pushed right" },
  { value: "center", label: "Text alone, centred" },
  { value: "text-left-media-right", label: "Text left, picture on the right" },
  { value: "text-right-media-left", label: "Text right, picture on the left" },
  { value: "center-media-between", label: "Centred, picture between heading and text" }
] as const;

/** The three arrangements that draw a picture. Mirrors `withPicture` in RichTextSection.tsx. */
const PICTURE_LAYOUTS = new Set<RichTextSectionData["layout"]>([
  "text-left-media-right",
  "text-right-media-left",
  "center-media-between"
]);

/**
 * A dropdown's options, from the Zod enum that validates it and the labels written beside it.
 *
 * `enumSchema.options` is the enum's own tuple, so the list on screen cannot contain a value the save
 * would refuse, or omit one it would accept. The `Record` keyed on that same union is what makes a
 * missing label a compile error rather than a blank line in a menu (see `lib/typography/typeset.ts`).
 */
function choiceOptions<T extends string>(
  values: readonly T[],
  choices: Record<T, TypesetChoice>
): readonly { value: T; label: string }[] {
  return values.map((value) => ({ value, label: choices[value].label }));
}

/** The sentence under a dropdown: what the current choice does, or the field's own description. */
function choiceNote<T extends string>(
  value: T,
  choices: Record<T, TypesetChoice>,
  fallback: string | undefined
): string | undefined {
  const note = choices[value].note;
  return note.length > 0 ? note : fallback;
}

export function RichTextForm({
  data,
  onChange,
  onDirty,
  storageReady = true
}: SectionFormProps<RichTextSectionData> & {
  /**
   * False when object storage is not configured on this deployment — `storageConfigured()` from
   * lib/env.ts, resolved on the server and handed down.
   *
   * ⚠ IT IS AN EXTRA OPTIONAL PROP ON TOP OF `SectionFormProps`, NOT A CHANGE TO IT, and that is what
   * keeps this form a legal `SectionFormComponent`. A function whose parameter has one MORE optional
   * property is still assignable to one whose parameter has fewer — the registry's
   * `{ [K in SectionType]: SectionFormComponent<SectionPayloads[K]> }` annotation still accepts it, and
   * `npx tsc --noEmit` is the proof. Widening `SectionFormProps` itself would be the tidier shape and it
   * is the filed integrator diff; this is the half that can be written from inside this file.
   *
   * Defaults to `true` — see the header for why no other default is honest.
   */
  storageReady?: boolean;
}) {
  const update = (patch: Partial<RichTextSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  /**
   * The three questions the arrangement answers, computed once.
   *
   * ⚠ `hasPicture` IS ABOUT THE PAYLOAD, NOT THE RENDER — the same distinction RichTextSection
   * draws with `pictureChosen`: a chosen id that no longer resolves is StoryPicture's sentence to
   * say on the page, not this form's. And `usesStoredAlignment` mirrors that file's
   * `proseAlignment` gate exactly; the two must agree or the studio explains a page that is right.
   */
  const wantsPicture = PICTURE_LAYOUTS.has(data.layout);
  const hasPicture = data.mediaId.trim().length > 0 || data.craftImage.trim().length > 0;
  const usesStoredAlignment = data.layout === "left";

  // ── The media picker, as a promise ─────────────────────────────────────────
  //
  // `RichTextEditor` asks for a picture through a callback so that it does not depend on the picker
  // (see its header). Bridging the dialog to that promise needs a resolver held across renders — a
  // ref, because resolving is not a render. The same three pieces every other caller uses.

  const [pickerOpen, setPickerOpen] = useState(false);
  const mediaResolver = useRef<((chosen: EditorMediaSelection | null) => void) | null>(null);

  const requestMedia = useCallback(
    () =>
      new Promise<EditorMediaSelection | null>((resolve) => {
        mediaResolver.current = resolve;
        setPickerOpen(true);
      }),
    []
  );

  const closePicker = useCallback(() => {
    // Resolving with null is "the author changed their mind", which is not a failure and gets no
    // message. Leaving the promise unsettled would freeze the insert handler for the life of the page.
    mediaResolver.current?.(null);
    mediaResolver.current = null;
    setPickerOpen(false);
  }, []);

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

      {/* `FieldBlock`, because the editor's toolbar is a row of buttons and a `<label>` wrapped round a
          button forwards stray clicks into it (Field.tsx). */}
      <FieldBlock label="The text" help={BODY_HELP}>
        <RichTextEditor
          value={data.body}
          /**
           * ⚠ THE CAST IS REQUIRED AND IT WEAKENS NOTHING. `RichTextDoc` is an INTERFACE with
           * `type: "doc"` and `content: RichTextNode[]`, which is strictly more precise than the field's
           * own type; but that field is inferred from a `.passthrough()` Zod object, so it carries an
           * index signature (`{ [k: string]: unknown }`) — and TypeScript does not give an interface an
           * implicit index signature, only a type alias or an object literal. So a BETTER-typed value is
           * not assignable to a looser one, purely because of how the looser one is spelled. The
           * previous code carried the same cast for a worse reason: it was casting Tiptap's untyped
           * `getJSON()` output.
           *
           * `update()` is used rather than `onChange` directly so the block is marked dirty by the same
           * path every other field on this form uses — a themed control fires no native input event
           * (contract §10), and an autosave that thinks nothing changed is a lost paragraph.
           */
          onChange={(body: RichTextDoc) => update({ body: body as RichTextSectionData["body"] })}
          label="Section text"
          placeholder="Start writing, or press “/” for the list of blocks you can insert."
          /*
            Withheld rather than offered-and-broken when there is nowhere to put a picture — the shape
            ArticleEditor.tsx:660 uses. `RichTextEditor` drops the toolbar button and the "/" entry with
            it, so an author is never shown a control that cannot finish (see the header).
          */
          onRequestMedia={storageReady ? requestMedia : undefined}
        />
      </FieldBlock>

      <Field label="Reading width" help={SHAPE.width.description}>
        <Select
          value={data.width}
          options={WIDTH_OPTIONS}
          onChange={(event) => update({ width: event.target.value as RichTextSectionData["width"] })}
        />
      </Field>

      <Field label="How this passage is arranged" help={SHAPE.layout.description}>
        <Select
          value={data.layout}
          options={LAYOUT_OPTIONS}
          onChange={(event) =>
            update({ layout: event.target.value as RichTextSectionData["layout"] })
          }
        />
      </Field>

      {/*
        ⚠ THE ALIGNMENT FIELD IS ONLY LIVE ON ONE ARRANGEMENT, and it says so rather than sitting
        there doing nothing. `RichTextSection` reads `alignment` when the arrangement is "left" and
        places the text itself otherwise (its `proseAlignment` comment names this file as the half
        that must agree). A control that silently stops working is the defect this whole form's
        mismatch warnings exist to prevent — so on the other five arrangements the field is still
        shown (the value is kept, and returning to "sitting left" restores it) with the sentence
        that explains why it is not in charge today.
      */}
      <Field
        label="Where the text sits"
        help={
          usesStoredAlignment
            ? SHAPE.alignment.description
            : "This arrangement places the text itself, so this setting is not used while it is chosen. Your choice is kept — switch back to “Text alone, sitting left” and it applies again."
        }
      >
        <Select
          value={data.alignment}
          options={ALIGNMENT_OPTIONS}
          disabled={!usesStoredAlignment}
          onChange={(event) =>
            update({ alignment: event.target.value as RichTextSectionData["alignment"] })
          }
        />
      </Field>

      {/*
        The picture, asked for only by the arrangements that draw one — the same decision
        StoryScrollForm makes about a chapter's link words: a box that can never appear on the page
        is a box somebody will fill in for nothing.
      */}
      {wantsPicture ? (
        <>
          <EntityPicker
            kind="media"
            max={1}
            label="Picture"
            help={SHAPE.mediaId.description}
            ids={data.mediaId.trim() ? [data.mediaId.trim()] : []}
            onChange={(next) => update({ mediaId: next[0] ?? "" })}
          />

          <CraftImagePicker
            value={data.craftImage}
            onChange={(craftImage) => update({ craftImage })}
            uploadedMediaId={data.mediaId}
            subject="this passage"
            help={SHAPE.craftImage.description}
          />

          {!hasPicture ? (
            <HelpText tone="warn">
              This arrangement includes a picture but none has been chosen, so the passage renders
              as text alone. Choose one above, or pick a text-alone arrangement on purpose.
            </HelpText>
          ) : null}
        </>
      ) : hasPicture ? (
        // The other direction of the mismatch, which HeroForm states for its background and this
        // one must state too: a picture is chosen and nothing on the page will show it.
        <HelpText tone="warn">
          A picture is chosen but this arrangement is text alone, so it is not shown. Pick one of
          the three arrangements with a picture above to use it — the choice is kept either way.
        </HelpText>
      ) : null}

      <TypesetPanel
        typeset={typesetOf(data)}
        alignment={data.alignment}
        width={data.width}
        onPatch={(patch) => {
          /**
           * ⚠ `withTypeset` CARRIES THE ONE CAST, and it is in `lib/typography/typeset.ts` so it is in
           * exactly one place. Once `typeset` is a field on `richTextSectionSchema` the cast inside it
           * becomes redundant and can go; nothing here changes either way.
           */
          onChange(withTypeset(data, { ...typesetOf(data), ...patch }));
          onDirty?.();
        }}
      />

      {/*
        The picker itself. `kind="IMAGE"` because the picture node stores an image's storage key and
        nothing else could be inserted as a figure.

        ⚠ `onSelect` RESOLVES THE PROMISE AND CLEARS THE REF IN THE SAME BREATH. A resolver left in place
        would be called a second time by the next `onClose`, and a promise resolved twice is a picture
        inserted once and a handler that quietly believes it was cancelled.
      */}
      <MediaPicker
        open={pickerOpen}
        onClose={closePicker}
        onSelect={(assets: StudioMediaAsset[]) => {
          const chosen = assets[0];
          if (!chosen) return;
          // `StudioMediaAsset` already carries every field `EditorMediaSelection` asks for, so it goes
          // straight through — no URL is ever handed to the document (see the picture node).
          mediaResolver.current?.(chosen);
          mediaResolver.current = null;
          setPickerOpen(false);
        }}
        kind="IMAGE"
        /*
          Passed rather than left to default — CraftEditor.tsx:1199's shape. It is belt as well as braces:
          with `onRequestMedia` withheld above the dialog can never be opened, but a picker that has been
          TOLD the truth cannot offer an upload area that would fail, whatever opens it next.
        */
        storageReady={storageReady}
        title="Choose a picture to insert"
      />
    </div>
  );
}

/**
 * The typesetting controls for one passage.
 *
 * A closed `<details>`, which needs no JavaScript, no state and no library — the same disclosure the
 * builder's own editor panel uses for the raw stored payload. The SUMMARY carries the state, so a block
 * that has been typeset by hand says so from the outside; a reader does not have to open ten dropdowns
 * to discover that nine of them are untouched.
 */
function TypesetPanel({
  typeset,
  alignment,
  width,
  onPatch
}: {
  typeset: BlockTypeset;
  alignment: RichTextSectionData["alignment"];
  width: RichTextSectionData["width"];
  onPatch: (patch: Partial<BlockTypeset>) => void;
}) {
  const overrides = countTypesetOverrides(typeset);

  /**
   * Resolved against the BUILT-IN house style, because a section form has no access to the settings —
   * `lib/settings/service.ts` is `server-only` and this is a client component. That is honest rather
   * than approximate: every field on `inherit` is left at the built-in default here, and the sentence
   * below the summary says so, so nothing on screen claims to know what the Centre has configured.
   *
   * What it is used for is the one thing it can be exact about: which of the choices made ON THIS BLOCK
   * cannot be applied, and why.
   */
  const resolved = resolveTypeset({
    block: typeset,
    house: HOUSE_TYPESET_DEFAULT,
    alignment,
    width
  });

  return (
    <details className="rounded-md border border-line-200 bg-surface-50 px-3.5 py-3">
      <summary className="cursor-pointer text-sm font-medium text-ink-900">
        Typesetting
        <span className="ml-2 font-normal text-ink-500">
          {overrides === 0
            ? "following the site's house style"
            : overrides === 1
              ? "1 change on this block"
              : `${overrides} changes on this block`}
        </span>
      </summary>

      <div className="mt-3 space-y-4">
        <HelpText>
          Every box starts on the site&rsquo;s house style, which is set once in Settings &rarr;
          Typesetting and applies to every passage on the site. Change one here only where this passage
          genuinely needs to differ. The notes under each box describe the built-in house style, so a box
          left on &ldquo;Follow the site&rsquo;s house style&rdquo; may read differently on the page if
          the Centre has changed it in Settings.
        </HelpText>

        {!TYPESET_STORED ? (
          /*
            THE ONE CASE WHERE THE CONTROLS ARE WITHHELD RATHER THAN DISABLED. If the block's payload
            cannot carry a typesetting choice, offering the choice would take an editor's decision and
            throw it away on the next autosave — a silent loss, which is worse than an absent control
            (contract §1.6). The sentence names the field and the file, because the person who can fix
            it is the one reading this.
          */
          <HelpText tone="warn">
            <span className="font-semibold">
              Typesetting cannot be stored on this deployment yet.
            </span>{" "}
            This passage is set in the site&rsquo;s house style, which is correct and complete — but the
            per-passage controls are not shown, because a choice made here would be discarded the next
            time the block was saved. Whoever looks after this site needs to add{" "}
            <code className="font-mono text-[0.75rem]">typeset</code> to the RICH_TEXT payload in{" "}
            <code className="font-mono text-[0.75rem]">lib/sections/schema.ts</code>; the controls appear
            by themselves once it is there.
          </HelpText>
        ) : (
          <>
            <TypesetSelect
              label="Reading face"
              value={typeset.face}
              values={blockFaceEnum.options}
              choices={FACE_CHOICES}
              fallbackHelp={TYPESET_SHAPE.face.description}
              onChange={(face) => onPatch({ face })}
            />

            <TypesetSelect
              label="Reading size"
              value={typeset.size}
              values={blockSizeEnum.options}
              choices={SIZE_CHOICES}
              fallbackHelp={TYPESET_SHAPE.size.description}
              onChange={(size) => onPatch({ size })}
            />

            <TypesetSelect
              label="Space between lines"
              value={typeset.leading}
              values={blockLeadingEnum.options}
              choices={LEADING_CHOICES}
              fallbackHelp={TYPESET_SHAPE.leading.description}
              onChange={(leading) => onPatch({ leading })}
            />

            <TypesetSelect
              label="Line length"
              value={typeset.measure}
              values={blockMeasureEnum.options}
              choices={MEASURE_CHOICES}
              fallbackHelp={TYPESET_SHAPE.measure.description}
              onChange={(measure) => onPatch({ measure })}
            />

            <TypesetSelect
              label="Space between paragraphs"
              value={typeset.paragraphSpacing}
              values={blockSpacingEnum.options}
              choices={SPACING_CHOICES}
              fallbackHelp={TYPESET_SHAPE.paragraphSpacing.description}
              onChange={(paragraphSpacing) => onPatch({ paragraphSpacing })}
            />

            <TypesetSelect
              label="How paragraphs are separated"
              value={typeset.paragraphStyle}
              values={blockParagraphStyleEnum.options}
              choices={PARAGRAPH_STYLE_CHOICES}
              fallbackHelp={TYPESET_SHAPE.paragraphStyle.description}
              onChange={(paragraphStyle) => onPatch({ paragraphStyle })}
            />

            <TypesetSelect
              label="How headings break across lines"
              value={typeset.headingWrap}
              values={blockHeadingWrapEnum.options}
              choices={HEADING_WRAP_CHOICES}
              fallbackHelp={TYPESET_SHAPE.headingWrap.description}
              onChange={(headingWrap) => onPatch({ headingWrap })}
            />

            {/* The three habits. Each is a three-state choice rather than a switch, because "off" and
                "not set" are different answers — see `blockToggleEnum`. */}
            <TypesetSelect
              label="Break long words across lines"
              value={typeset.hyphenation}
              values={blockToggleEnum.options}
              choices={TOGGLE_CHOICES}
              fallbackHelp={TYPESET_SHAPE.hyphenation.description}
              onChange={(hyphenation) => onPatch({ hyphenation })}
            />

            <TypesetSelect
              label="Straighten the right-hand edge"
              value={typeset.justify}
              values={blockToggleEnum.options}
              choices={TOGGLE_CHOICES}
              fallbackHelp={TYPESET_SHAPE.justify.description}
              onChange={(justify) => onPatch({ justify })}
            />

            <TypesetSelect
              label="Large first letter"
              value={typeset.dropCap}
              values={blockToggleEnum.options}
              choices={TOGGLE_CHOICES}
              fallbackHelp={TYPESET_SHAPE.dropCap.description}
              onChange={(dropCap) => onPatch({ dropCap })}
            />

            {resolved.notices.length > 0 ? (
              <HelpText tone="warn">
                {resolved.notices.length === 1
                  ? resolved.notices[0]
                  : resolved.notices.map((sentence) => (
                      <span key={sentence} className="mt-1 block first:mt-0">
                        {sentence}
                      </span>
                    ))}
              </HelpText>
            ) : null}

            {overrides > 0 ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onPatch(BLOCK_TYPESET_DEFAULT)}
              >
                Put every box back to the house style
              </Button>
            ) : null}
          </>
        )}
      </div>
    </details>
  );
}

/**
 * One typesetting dropdown.
 *
 * `values` comes from the Zod enum and `choices` is a `Record` over the same union, so the option list
 * and the schema cannot disagree and a value with no label does not compile. That pairing is the only
 * reason this wrapper exists rather than ten hand-written `<Field><Select>` pairs.
 */
function TypesetSelect<T extends string>({
  label,
  value,
  values,
  choices,
  fallbackHelp,
  onChange
}: {
  label: string;
  value: T;
  values: readonly T[];
  choices: Record<T, TypesetChoice>;
  fallbackHelp: string | undefined;
  onChange: (next: T) => void;
}) {
  return (
    <Field label={label} help={choiceNote(value, choices, fallbackHelp)}>
      <Select
        value={value}
        options={choiceOptions(values, choices)}
        // The list is generated from the same enum that validates the save, so the only values this
        // `<select>` can emit are members of `T`. That is what the assertion states.
        onChange={(event) => onChange(event.target.value as T)}
      />
    </Field>
  );
}
