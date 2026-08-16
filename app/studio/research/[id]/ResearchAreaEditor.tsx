"use client";

/**
 * The research-area editor.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ACCENT COLOUR IS EXPLAINED, NOT JUST OFFERED. It is used in ONE place — the diagram on the
 * research page — and nowhere else on the site. Without that sentence beside it an administrator will
 * reasonably assume it recolours the buttons and headings of the area's page, change it to the
 * Centre's brand colour, see no difference anywhere they thought to look, and conclude the field is
 * broken. The schema says the same thing for the same reason: the site has one action colour, and this
 * is a data-encoding channel in a visualisation, not a second accent (contract §1.1).
 *
 * NUMBERS ARE HELD AS TEXT. A half-typed number is a real state — an empty box, a lone minus sign —
 * and forcing every keystroke through `Number()` deletes both. The conversion happens once, on the way
 * to the server.
 *
 * AUTOSAVE STOPS FOR ANYTHING PUBLIC, IN BOTH DIRECTIONS. `useAutosave` refuses to run for a published
 * record, and this screen widens that to "published on the server OR about to be": choosing Published
 * in the form must not be autosaved four seconds later, and a live record whose form currently says
 * Draft must not be quietly unpublished by a background save. `PUBLISHED_AUTOSAVE_NOTICE` says so on
 * screen, because silence here loses work in one direction and publishes half a sentence in the other.
 *
 * A NEW AREA IS NEVER AUTOSAVED EITHER. Nothing exists until the reader presses Create, so there is
 * nothing to save to — and a blank record created by a timer is a row nobody meant to make.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ContentStatus } from "@prisma/client";
import { ImagePlus, Palette, Trash2 } from "lucide-react";

import { del, patch, post } from "@/lib/client/fetcher";
import { Field, FieldBlock } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { MediaImage } from "@/components/ui/MediaImage";
import { Textarea } from "@/components/ui/Textarea";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/ToastProvider";
import { DeleteButton } from "@/components/studio/DeleteButton";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";
import { SaveBar } from "@/components/studio/SaveBar";
import { SlugField } from "@/components/studio/SlugField";
import { StatusControl, statusProblems } from "@/components/studio/StatusControl";
import { PUBLISHED_AUTOSAVE_NOTICE, useAutosave } from "@/components/studio/useAutosave";
import { usePublishNotice } from "@/components/studio/usePublishNotice";
import { useLeaveGuard } from "@/components/studio/useUnsavedChanges";
import { IconPicker } from "@/components/studio/fields/IconPicker";
import { RichTextEditor } from "@/components/studio/editor/RichTextEditor";
import { MediaPicker } from "@/components/studio/media/MediaPicker";
import type { StudioMediaAsset } from "@/components/studio/media/MediaGrid";
import type { EditorMediaSelection } from "@/components/studio/editor/extensions";

/**
 * Just enough of a media row to preview it and remember which one it is.
 *
 * Satisfies `MediaLike`, so `MediaImage` can render it, without the editor having to carry the twenty
 * columns the media library's own screens need.
 */
export interface EditorMedia {
  id: string;
  fileName: string;
  altText: string | null;
  objectKey: string;
  width: number | null;
  height: number | null;
  blurDataUrl: string | null;
  variants: { label: string; format: string; objectKey: string; width: number }[];
}

export interface ResearchAreaFormValue {
  title: string;
  slug: string;
  summary: string;
  /** A Tiptap document, or null. `RichTextEditor` normalises whatever it is given. */
  body: unknown;
  /** A lucide icon name. `IconPicker` validates it against the exported set. */
  icon: string;
  /** A literal hex or `oklch(…)` value. Used by the research diagram ONLY. */
  accentColor: string;
  cover: EditorMedia | null;
  /** Held as text — see the header. */
  sortOrder: string;
  status: ContentStatus;
  /** Read-only here; the server stamps it. Shown by StatusControl's sentence. */
  publishedAt: string | null;
  /**
   * Send the old address to the new one when a published address changes.
   *
   * Defaults to true, because that is nearly always the right answer: the `Redirect` table exists so
   * that moving a page never has to break an existing link (schema). The server ignores it unless the
   * address actually changed on a record that is public.
   */
  createRedirect: boolean;
}

export interface ResearchAreaEditorProps {
  /** Null for a research area that does not exist yet. */
  areaId: string | null;
  initialValue: ResearchAreaFormValue;
  siteUrl: string;
  storageReady: boolean;
  canPublish: boolean;
  canDelete: boolean;
}

const ENDPOINT = {
  collection: "/api/studio/research",
  detail: (id: string) => `/api/studio/research/${encodeURIComponent(id)}`
} as const;

const TITLE_MAX = 120;
const SUMMARY_MAX = 320;

/** `#abc` or `#aabbcc`. The native colour box speaks only this. */
const HEX_COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Where the colour box starts when nothing has been chosen. Purple-700, the house action colour. */
const COLOUR_FALLBACK = "#6d28d9";

/** A whole number, or null for an empty or unreadable box. */
function toIntOrNull(text: string): number | null {
  const value = Number.parseInt(text.trim(), 10);
  return Number.isFinite(value) ? value : null;
}

/** A trimmed value, or null. The API's schemas accept null for every nullable column. */
function orNull(text: string): string | null {
  const value = text.trim();
  return value.length > 0 ? value : null;
}

function toPayload(value: ResearchAreaFormValue) {
  return {
    title: value.title.trim(),
    slug: value.slug.trim(),
    summary: orNull(value.summary),
    body: value.body ?? null,
    icon: orNull(value.icon),
    accentColor: orNull(value.accentColor),
    coverId: value.cover?.id ?? null,
    sortOrder: toIntOrNull(value.sortOrder) ?? 0,
    status: value.status,
    createRedirect: value.createRedirect
  };
}

function toEditorMedia(asset: StudioMediaAsset): EditorMedia {
  return {
    id: asset.id,
    fileName: asset.fileName,
    altText: asset.altText,
    objectKey: asset.objectKey,
    width: asset.width,
    height: asset.height,
    blurDataUrl: asset.blurDataUrl,
    variants: asset.variants ?? []
  };
}

export function ResearchAreaEditor({
  areaId,
  initialValue,
  siteUrl,
  storageReady,
  canPublish,
  canDelete
}: ResearchAreaEditorProps) {
  const router = useRouter();
  const { toast } = useToast();

  const [value, setValue] = useState<ResearchAreaFormValue>(initialValue);
  const [saved, setSaved] = useState<ResearchAreaFormValue>(initialValue);

  /** Which job the media picker is open for, or null. See `requestBodyMedia`. */
  const [picker, setPicker] = useState<"cover" | "body" | null>(null);
  /** The pending promise from the body editor's "insert a picture". */
  const bodyResolver = useRef<((selection: EditorMediaSelection | null) => void) | null>(null);
  /** Set once a brand-new area has been created, so `onSaved` knows where to send the reader. */
  const createdId = useRef<string | null>(null);

  const isNew = areaId === null;

  const update = useCallback(
    (patchValue: Partial<ResearchAreaFormValue>) =>
      setValue((current) => ({ ...current, ...patchValue })),
    []
  );

  /**
   * Public now, or about to be. Both halves matter — see the header.
   *
   * ARCHIVED counts as "was public": an archived record's page is already off the site, but a
   * background save that flipped it back would be a publish nobody pressed.
   */
  const isLiveOrGoingLive =
    saved.status === "PUBLISHED" ||
    saved.status === "SCHEDULED" ||
    value.status === "PUBLISHED" ||
    value.status === "SCHEDULED";

  const save = useCallback(
    async (next: ResearchAreaFormValue) => {
      if (areaId === null) {
        const created = await post<{ id: string }>(ENDPOINT.collection, toPayload(next));
        createdId.current = created.id;
        return;
      }
      await patch(ENDPOINT.detail(areaId), toPayload(next));
    },
    [areaId]
  );

  /** The public address, handed over the moment this area crosses onto the site. */
  const announcePublished = usePublishNotice({
    initial: initialValue,
    origin: siteUrl,
    basePath: "/research/",
    subject: "research area"
  });

  const autosave = useAutosave<ResearchAreaFormValue>({
    data: value,
    save,
    isPublished: isLiveOrGoingLive,
    // Nothing exists to save into until Create has been pressed.
    enabled: !isNew,
    onSaved: (sent) => {
      setSaved(sent);
      const fresh = createdId.current;
      if (fresh !== null) {
        createdId.current = null;
        toast({ tone: "success", title: "The research area has been created" });
        // After the creation notice, so the two arrive in the order they happened: an area can be
        // created straight into PUBLISHED, and "it exists" reads oddly after "it is public".
        announcePublished(sent);
        // A programmatic navigation, which the leave guard deliberately does not intercept — and the
        // form is clean by now anyway. `replace`, so Back does not return to a "new" screen that would
        // create a second copy.
        router.replace(`/studio/research/${fresh}`);
        return;
      }
      announcePublished(sent);
      // The list, the diagram and the header's status chip are all server-rendered from this row.
      router.refresh();
    }
  });

  useLeaveGuard(autosave.isDirty);

  // ── Validation ───────────────────────────────────────────────────────────────────────────────

  const saveBlockers = useMemo(() => {
    const problems: string[] = [];
    if (value.title.trim().length === 0) problems.push("The name is empty.");
    if (value.slug.trim().length === 0) problems.push("The web address is empty.");
    problems.push(...statusProblems(value, false));
    return problems;
  }, [value]);

  /**
   * Why this cannot go on the public site yet.
   *
   * The summary is in here rather than in `saveBlockers` on purpose: an area with no summary is a
   * perfectly reasonable draft, and only becomes a problem at the moment it appears in the diagram as
   * a bare heading.
   */
  const publishBlockers = useMemo(() => {
    const problems: string[] = [];
    if (value.title.trim().length === 0) problems.push("The area has no name.");
    if (value.slug.trim().length === 0) problems.push("The area has no web address.");
    if (value.summary.trim().length === 0) {
      problems.push(
        "There is no summary. The research diagram shows it under the name, so the area would appear as a bare heading."
      );
    }
    return problems;
  }, [value]);

  // ── The media picker ─────────────────────────────────────────────────────────────────────────

  const requestBodyMedia = useCallback(
    () =>
      new Promise<EditorMediaSelection | null>((resolve) => {
        bodyResolver.current = resolve;
        setPicker("body");
      }),
    []
  );

  /**
   * Settle the body editor's promise exactly once.
   *
   * A dialog that is dismissed without a choice MUST still settle it, or the editor's insert handler
   * waits for ever with no sign on screen that anything is wrong.
   */
  const settleBody = useCallback((selection: EditorMediaSelection | null) => {
    const resolve = bodyResolver.current;
    bodyResolver.current = null;
    resolve?.(selection);
  }, []);

  const closePicker = useCallback(() => {
    setPicker(null);
    settleBody(null);
  }, [settleBody]);

  const onPicked = useCallback(
    (assets: StudioMediaAsset[]) => {
      const first = assets[0] ?? null;
      if (picker === "body") {
        settleBody(first);
      } else if (first) {
        update({ cover: toEditorMedia(first) });
      }
      setPicker(null);
    },
    [picker, settleBody, update]
  );

  // ── Delete ───────────────────────────────────────────────────────────────────────────────────

  const remove = useCallback(async () => {
    if (areaId === null) return;
    await del(ENDPOINT.detail(areaId));
  }, [areaId]);

  return (
    <div className="mt-6 space-y-5">
      <FormSection
        title="Name and address"
        description="The name is what appears in the research diagram, in menus and at the top of the area's own page."
      >
        <Field
          label="Name"
          required
          maxLength={TITLE_MAX}
          value={value.title}
          help="Two or three words in sentence case — “Heritage and artificial intelligence”, not “HERITAGE AI”."
        >
          <Input
            value={value.title}
            onChange={(event) => update({ title: event.target.value })}
            placeholder="Heritage and artificial intelligence"
          />
        </Field>

        <SlugField
          value={value.slug}
          onChange={(slug) => update({ slug })}
          source={value.title}
          basePath="/research/"
          siteUrl={siteUrl}
          // `saved.slug`, not the value this screen opened with: after a save the stored address IS the
          // new one, and a warning about an address that no longer exists is a warning nobody can act on.
          originalValue={isNew ? undefined : saved.slug}
          isPublished={saved.status === "PUBLISHED"}
          redirect={{
            enabled: value.createRedirect,
            onEnabledChange: (createRedirect) => update({ createRedirect })
          }}
          required
        />
      </FormSection>

      <FormSection
        title="Summary and description"
        description="The summary is the one sentence the diagram and the listing show. The description is the full text on the area's own page, and can be left empty."
      >
        <Field
          label="Summary"
          maxLength={SUMMARY_MAX}
          value={value.summary}
          help="One or two plain sentences saying what this area of work is. It is shown in the research diagram, in search results and when somebody shares the page."
        >
          <Textarea
            value={value.summary}
            onChange={(event) => update({ summary: event.target.value })}
            rows={3}
          />
        </Field>

        <FieldBlock
          label="Description"
          help="The full text on the area's own page. Headings, lists, quotations and pictures are all available; press “/” on an empty line for the full list."
        >
          <RichTextEditor
            value={value.body}
            onChange={(body) => update({ body })}
            label="Research area description"
            placeholder="What this area covers, who works on it, and why it matters."
            onRequestMedia={requestBodyMedia}
          />
        </FieldBlock>
      </FormSection>

      <FormSection
        title="How it appears"
        description="The icon, the diagram colour, the picture at the top of the page and where this area sits in the list."
      >
        <IconPicker
          value={value.icon}
          onChange={(icon) => update({ icon })}
          help="A small symbol shown beside the name in the research diagram and in listings. Leave it empty for no symbol."
        />

        <AccentColourField
          value={value.accentColor}
          onChange={(accentColor) => update({ accentColor })}
        />

        <FieldBlock
          label="Cover picture"
          help="Shown across the top of this area's page and when the page is shared. Landscape works best — anything roughly twice as wide as it is tall."
        >
          {value.cover ? (
            <div className="flex flex-wrap items-start gap-4">
              <MediaImage
                media={value.cover}
                // Decorative here: the file name and the controls beside it already say what this is.
                alt=""
                aspect={16 / 9}
                rounded="md"
                sizes="240px"
                className="w-60 shrink-0"
              />
              <div className="min-w-0 flex-1 space-y-2">
                <p className="truncate text-sm text-ink-700">{value.cover.fileName}</p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" icon={ImagePlus} onClick={() => setPicker("cover")}>
                    Choose a different picture
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Trash2}
                    onClick={() => update({ cover: null })}
                  >
                    Remove the picture
                  </Button>
                </div>
                {value.cover.altText === null ? (
                  <HelpText tone="warn">
                    This picture has no description, so somebody using a screen reader is told nothing
                    about it. Add one in the media library — it takes a sentence.
                  </HelpText>
                ) : null}
              </div>
            </div>
          ) : (
            <Button variant="secondary" icon={ImagePlus} onClick={() => setPicker("cover")}>
              Choose a picture
            </Button>
          )}
        </FieldBlock>

        <Field
          label="Position in the list"
          help="Areas are shown in this order, lowest number first. Two areas with the same number fall back to alphabetical order."
        >
          <Input
            type="number"
            inputMode="numeric"
            value={value.sortOrder}
            onChange={(event) => update({ sortOrder: event.target.value })}
            className="max-w-[10rem]"
          />
        </Field>
      </FormSection>

      <FormSection
        title="Publication"
        description="Whether this area is on the public site. Research areas cannot be scheduled — they go public when you say so."
      >
        <StatusControl
          value={{ status: value.status, publishedAt: value.publishedAt }}
          onChange={(next) => update({ status: next.status })}
          canPublish={canPublish}
          // Research areas carry `status` and `publishedAt` only. Offering a schedule would write a
          // date into a column that does not exist (lib/content.ts).
          scheduling={false}
          publishBlockers={publishBlockers}
        />
      </FormSection>

      {/* A failing permission check renders nothing at all — there is no disabled Delete (contract §1.8). */}
      {canDelete && !isNew ? (
        <FormSection
          title="Delete this research area"
          tone="danger"
          description="Projects and publications filed under it are not deleted. They stop being filed under anything, and disappear from the research diagram until they are filed somewhere else."
        >
          <DeleteButton
            name={saved.title.trim().length > 0 ? saved.title : "this research area"}
            noun="research area"
            onDelete={remove}
            onDeleted={() => router.push("/studio/research")}
            successMessage={null}
          />
        </FormSection>
      ) : null}

      <SaveBar
        status={autosave.status}
        lastSavedAt={autosave.lastSavedAt}
        onSave={() => void autosave.saveNow()}
        onDiscard={() => setValue(saved)}
        error={autosave.error?.message ?? null}
        saveDisabledReason={saveBlockers[0] ?? null}
        saveLabel={isNew ? "Create research area" : "Save"}
        subject="this research area"
        note={
          isNew
            ? "Nothing is saved until you press Create. After that your changes are kept automatically every few seconds, until the area is published."
            : autosave.retriesExhausted
              ? "Saving automatically has stopped after several failures. Press Save to try again."
              : isLiveOrGoingLive
                ? PUBLISHED_AUTOSAVE_NOTICE
                : "Your changes are kept automatically every few seconds while this is a draft."
        }
      />

      <MediaPicker
        open={picker !== null}
        onClose={closePicker}
        onSelect={onPicked}
        multiple={false}
        kind="IMAGE"
        storageReady={storageReady}
        title={picker === "body" ? "Insert a picture" : "Choose a cover picture"}
      />
    </div>
  );
}

/**
 * The diagram colour.
 *
 * `FieldBlock`, not `Field`: there is a button and a second control in here, and a `<label>` wrapped
 * round a button forwards stray clicks into it and folds its text into the input's accessible name
 * (Field.tsx).
 */
function AccentColourField({
  value,
  onChange
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const trimmed = value.trim();
  const isHex = HEX_COLOUR.test(trimmed);
  const chosen = trimmed.length > 0;

  return (
    <FieldBlock
      label="Colour in the research diagram"
      help={
        <>
          This colour is used <strong className="font-semibold text-ink-700">only</strong> to tell this
          area apart from the others in the diagram on the research page. It changes nothing else — not
          the buttons, not the links, not the headings, and nothing on this area&rsquo;s own page. Leave it
          empty and the diagram picks a colour for you.
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        {/* A native colour box, which speaks hex and nothing else — hence the branch below. */}
        <input
          type="color"
          aria-label="Pick the diagram colour"
          value={isHex ? trimmed : COLOUR_FALLBACK}
          onChange={(event) => onChange(event.target.value)}
          className="h-10 w-14 shrink-0 cursor-pointer rounded-md border border-line-200 bg-card p-1"
        />

        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          icon={Palette}
          placeholder="#6d28d9"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="min-w-0 flex-1 font-mono text-xs"
        />

        {chosen ? (
          <Button variant="ghost" size="sm" onClick={() => onChange("")}>
            Use the automatic colour
          </Button>
        ) : null}
      </div>

      {chosen && !isHex ? (
        <HelpText className="mt-2">
          This colour is written in a form the colour box above cannot show — the diagram will use it
          exactly as it is written here. Type a value beginning with a hash, such as #6d28d9, if you
          would rather pick it from the box.
        </HelpText>
      ) : null}

      {!chosen ? (
        <HelpText className="mt-2">
          No colour has been chosen, so the diagram gives this area one of its own. That is a perfectly
          good answer.
        </HelpText>
      ) : null}
    </FieldBlock>
  );
}
