"use client";

/**
 * CraftImagePicker — "one of the photographs that came with the site", chosen by looking at them.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT SITS BESIDE THE MEDIA-LIBRARY PICKER, AND IT SAYS WHICH OF THE TWO WINS.
 *
 * The four narrative blocks each take a picture from either of two places (`craftImageSlug` in
 * lib/sections/schema.ts): a `MediaAsset` an editor uploaded, or a slug from the bundled manifest in
 * `lib/media/craft-imagery.ts`. `components/sections/story/StoryPicture.tsx` is the one component
 * that decides between them, and its rule is that AN UPLOADED ASSET ALWAYS WINS.
 *
 * That rule is invisible from a form which shows two pickers side by side, and the symptom is an
 * editor choosing a bundled photograph, seeing no change on the page, and concluding the studio is
 * broken. So this component takes the uploaded id as well as its own value and states the outcome in
 * words whenever the two disagree — and states the other half too, because a block with NEITHER
 * source renders a "the picture is missing" panel rather than nothing (contract §1.6).
 *
 * ⚠ THE ATTRIBUTION IS ON SCREEN BEFORE THE SAVE, NOT ONLY ON THE PUBLIC PAGE. Every photograph in
 * the manifest is openly licensed and most of those licences require a credit; `ImageCredit` renders
 * it on the page, which is what makes publishing lawful. Showing the photographer and the licence
 * here as well is what lets an editor see what they are about to publish under — a CC BY-SA picture
 * carries obligations a public-domain one does not, and nobody can weigh that from a thumbnail.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A TRIGGER AND A PANEL, NOT AN INLINE GRID OF TWENTY-SIX THUMBNAILS. A story block holds up to
 * twelve chapters and a rail up to twenty cards, each with one of these; an inline grid would put
 * several hundred images into one editor screen. The panel is the same shape as `IconPicker`'s, which
 * is the picker an editor has already met on this screen.
 *
 * `FieldBlock`, NOT `Field`. This control is a button that opens a panel of buttons, and a `<label>`
 * wrapped round a button forwards stray clicks into it and folds every name inside it into the
 * control's accessible name (Field.tsx). The trigger reads its id and description off
 * `useFieldContext()`, which is why it is a separate component — a hook cannot read a provider that
 * its own parent renders.
 *
 * ⚠ A SLUG THAT NO LONGER RESOLVES IS SAID OUT LOUD. Payloads outlive the picture set: a slug retired
 * by a later run of `scripts/fetch-craft-imagery.ts` still parses (the schema checks the SHAPE of a
 * slug, deliberately, so a retired one never blocks a save) and resolves to nothing. The renderer
 * shows its "picture is missing" panel; this shows the editor why, because a picker that silently
 * displays "none" for a value that is not none is a picker nobody can trust.
 */

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ChevronDown, ImageOff, X } from "lucide-react";

import { CRAFT_IMAGES, craftImage, type CraftImage } from "@/lib/media/craft-imagery";
import { cn } from "@/lib/utils";
import { FieldBlock, useFieldContext } from "@/components/ui/Field";
import { Popover } from "@/components/ui/Popover";
import { HelpText } from "@/components/studio/HelpText";

/** The panel's width in pixels. Two columns of thumbnail wide enough to tell two weaves apart. */
const PANEL_WIDTH = 360;

export interface CraftImagePickerProps {
  /** The stored slug, or `""` for none. */
  value: string;
  onChange: (next: string) => void;
  /**
   * The uploaded asset chosen beside this picker, so the component can say which one the page will
   * actually use. Pass `""` when nothing is chosen — never leave it out to "keep it simple", because
   * the sentence it drives is the whole reason this prop exists.
   */
  uploadedMediaId: string;
  /**
   * What this picture belongs to, as a noun phrase an editor would use: "this chapter", "this card",
   * "this stage", "this band". It is dropped into the two sentences below, so it must read naturally
   * after "The page shows the uploaded photograph for …".
   */
  subject: string;
  /** Defaults to "A photograph that came with the site". */
  label?: string;
  /** The schema's own `.describe()` sentence for this field. */
  help?: string;
  error?: string | null;
  className?: string;
}

export function CraftImagePicker({
  value,
  onChange,
  uploadedMediaId,
  subject,
  label = "A photograph that came with the site",
  help,
  error,
  className
}: CraftImagePickerProps) {
  const slug = value.trim();
  const chosen = slug.length > 0 ? craftImage(slug) : null;
  const hasUpload = uploadedMediaId.trim().length > 0;

  return (
    <FieldBlock label={label} help={help} error={error} className={className}>
      <CraftImagePickerControl value={slug} chosen={chosen} onChange={onChange} />

      {chosen ? <CraftImageCredit image={chosen} /> : null}

      {/*
        ⚠ THE SECOND HALF OF THIS SENTENCE DEPENDS ON THE UPLOAD, and getting it wrong sends an editor
        to repair a page that is already right. StoryPicture.tsx reaches the bundled manifest only
        after the uploaded asset has failed to resolve, so a retired slug beside an uploaded
        photograph costs the page nothing at all — it is a dead setting, not a missing picture.
      */}
      {slug.length > 0 && chosen === null ? (
        <HelpText tone="warn" className="mt-2">
          The photograph saved here (“{slug}”) is no longer one of the ones that ship with the site.{" "}
          {hasUpload ? (
            <>
              The page is not affected — it shows the uploaded photograph for {subject} either way —
              but this setting no longer means anything. Clear it, or choose another one above.
            </>
          ) : (
            <>
              The page therefore has nothing to show for {subject}. Choose another one above, or upload
              your own.
            </>
          )}
        </HelpText>
      ) : null}

      {/*
        The precedence, stated where the choice is made. Both directions are worth saying: a bundled
        photograph that will never appear looks like a broken picker, and a block with no picture at
        all renders a panel saying so rather than a hole.
      */}
      {hasUpload && chosen ? (
        <HelpText tone="warn" className="mt-2">
          You have chosen an uploaded photograph as well, and an uploaded photograph always wins. The
          page will show the uploaded one for {subject}; this one will not appear until the uploaded
          photograph is taken away above.
        </HelpText>
      ) : null}

      {!hasUpload && slug.length === 0 ? (
        <HelpText tone="warn" className="mt-2">
          Neither an uploaded photograph nor one of these has been chosen, so the page prints a panel
          saying the picture for {subject} is missing. That is deliberate — a silent gap is
          indistinguishable from a fault — but it is not something to publish.
        </HelpText>
      ) : null}
    </FieldBlock>
  );
}

function CraftImagePickerControl({
  value,
  chosen,
  onChange
}: {
  value: string;
  chosen: CraftImage | null;
  onChange: (next: string) => void;
}) {
  const field = useFieldContext();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  /*
   * The panel is not a focus trap (see Popover.tsx), so focus is placed on its first control the
   * instant it opens — otherwise the first arrow key or space scrolls the form behind it. One frame's
   * delay, because the panel is positioned after it mounts.
   */
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLButtonElement>("button");
      first?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const choose = (slug: string) => {
    onChange(slug);
    setOpen(false);
    // Focus returns to the trigger, which is where the reader's place in the tab order is.
    triggerRef.current?.focus({ preventScroll: true });
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          ref={triggerRef}
          id={field?.controlId}
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          aria-describedby={field?.describedBy}
          className="field-button-secondary min-w-0 justify-start gap-3 pl-2 text-left"
        >
          <span
            aria-hidden="true"
            className="relative flex h-11 w-16 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-surface-100 text-ink-300"
          >
            {chosen ? (
              <Image
                src={chosen.src}
                alt=""
                fill
                sizes="64px"
                className="object-cover"
              />
            ) : (
              <span className="text-xs">none</span>
            )}
          </span>

          <span className="min-w-0">
            <span className="block truncate text-sm">
              {chosen ? chosen.title : "Choose a photograph"}
            </span>
            <span className="block truncate text-xs font-normal text-ink-500">
              {chosen ? chosen.region : `${CRAFT_IMAGES.length} come with the site`}
            </span>
          </span>

          <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-ink-500" />
        </button>

        {value.length > 0 ? (
          <button
            type="button"
            onClick={() => onChange("")}
            className="field-button-ghost min-h-8 px-2 py-1 text-xs"
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
            Use none of these
          </button>
        ) : null}
      </div>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        panelRef={panelRef}
        label="Choose a photograph that came with the site"
        width={PANEL_WIDTH}
        // `!p-0`, with the bang. `Popover` sets `p-1.5`, `cn()` is a plain join and later classes do
        // NOT win (contract §5) — Tailwind emits `p-1.5` after `p-0`, so an unforced override loses.
        className="!p-0"
      >
        <div className="grid grid-cols-2 gap-2 p-2">
          {/*
            The way OUT of a choice, first, and as a real option rather than only as the small button
            beside the trigger: somebody who opened the panel to change their mind is already here.
          */}
          <button
            type="button"
            onClick={() => choose("")}
            aria-pressed={value.length === 0}
            className={cn(
              "col-span-2 flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition",
              value.length === 0
                ? "border-purple-600 bg-purple-50 text-purple-700"
                : "border-line-200 bg-card text-ink-700 hover:border-purple-300 hover:bg-purple-50"
            )}
          >
            <ImageOff aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span className="min-w-0">
              <span className="block font-medium">No photograph from this set</span>
              <span className="block text-xs text-ink-500">
                Leave it empty and upload your own instead.
              </span>
            </span>
          </button>

          {CRAFT_IMAGES.map((image) => {
            const selected = image.slug === value;

            return (
              <button
                key={image.slug}
                type="button"
                onClick={() => choose(image.slug)}
                // A toggle button, so the chosen one is announced as pressed rather than only looking
                // different — colour never carries meaning alone (contract §11).
                aria-pressed={selected}
                className={cn(
                  "min-w-0 rounded-md border p-1 text-left transition",
                  selected
                    ? "border-purple-600 bg-purple-50"
                    : "border-line-200 bg-card hover:border-purple-300 hover:bg-purple-50"
                )}
              >
                <span className="relative block aspect-[4/3] w-full overflow-hidden rounded-sm bg-surface-200">
                  {/*
                    Decorative: the title and the region underneath name the photograph, and reading
                    both would say the same words twice.
                  */}
                  <Image
                    src={image.src}
                    alt=""
                    fill
                    sizes="180px"
                    loading="lazy"
                    className="object-cover"
                  />
                </span>
                <span
                  className={cn(
                    "mt-1.5 block truncate px-0.5 text-xs font-medium",
                    selected ? "text-purple-700" : "text-ink-900"
                  )}
                >
                  {image.title}
                </span>
                <span className="block truncate px-0.5 text-[0.6875rem] text-ink-500">
                  {image.region}
                </span>
              </button>
            );
          })}
        </div>

        <p className="border-t border-line-200 px-3 py-2 text-xs leading-relaxed text-ink-500">
          These {CRAFT_IMAGES.length} photographs are the whole set that ships with the site. They are
          openly licensed and each one carries its photographer&rsquo;s credit on the page
          automatically. To use anything else, upload it to the media library.
        </p>
      </Popover>
    </>
  );
}

/**
 * Who took the chosen photograph and under what terms.
 *
 * Shown for the CHOSEN one only. A licence beside all twenty-six would be twenty-six lines of small
 * print nobody reads; beside the one being published it is the fact an editor needs — "CC BY-SA 4.0"
 * and "Public domain" are different obligations, and the difference is invisible in a thumbnail.
 *
 * ⚠ THE CLOSING SENTENCE IS "WHENEVER THIS IS THE PHOTOGRAPH THE PAGE SHOWS", not "whether or not you
 * do anything here". The two are not the same claim: an uploaded photograph replaces this one and
 * takes its credit with it (`CraftPhoto` is never rendered at all), so the unconditional wording
 * promised an attribution that would not appear. The warning underneath is what covers that case.
 */
function CraftImageCredit({ image }: { image: CraftImage }) {
  return (
    <p className="mt-2 text-xs leading-relaxed text-ink-500">
      Photograph by {image.author}.{" "}
      {image.licenceUrl ? (
        <ExternalNote href={image.licenceUrl}>{image.licence}</ExternalNote>
      ) : (
        <span className="font-medium text-ink-700">{image.licence}</span>
      )}
      . <ExternalNote href={image.sourceUrl}>Where this photograph came from</ExternalNote>. Whenever
      this is the photograph the page shows, that credit is printed under it automatically — there is
      nothing to add here.
    </p>
  );
}

/**
 * A link out of the studio.
 *
 * The new tab is SAID, not merely done: a reader whose focus lands in another tab with no warning has
 * lost their place and their Back button with it (contract §11).
 */
function ExternalNote({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-purple-700 underline underline-offset-2 hover:text-purple-800"
    >
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
