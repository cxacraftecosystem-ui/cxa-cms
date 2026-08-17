"use client";

/**
 * The craft editor.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE LOCAL NAME CARRIES ITS LANGUAGE, AND THE FIELD SAYS WHY.
 *
 * A name in Devanagari, Tamil or Bengali script is marked up with `lang` on the public site, and that
 * attribute is what tells a screen reader to switch voice. Without it the reader's English voice
 * attempts Devanagari letter by letter and produces sounds that are not words in either language — so a
 * local name with no language recorded is worse than no local name at all. That is the whole reason the
 * two fields sit together, and it is said beside them rather than left as institutional knowledge.
 *
 * A NEGATIVE ORIGIN YEAR MEANS BCE, AND THE FIELD SAYS SO AND SHOWS IT.
 *
 * The column is a plain integer and the convention is the minus sign, which is not guessable: an editor
 * typing "3000" for a Harappan craft would place it in the year 3000. The label states the rule and the
 * readout underneath says "c. 3000 BCE" as you type, so the convention is confirmed before it is saved.
 *
 * THE BEFORE-AND-AFTER PAIRING IS MADE BY ORDER, AND THE SCREEN SHOWS THE RESULT ROW BY ROW.
 *
 * `CraftMedia` has no column linking one half of a pair to the other — the editor's ordering is the only
 * evidence, so a "before" pairs with the NEXT "after" below it. Two consequences an editor cannot see
 * from the marks alone, and both are shown against every row:
 *
 *   • A PAIR NEEDS BOTH HALVES. A lone "after", and a "before" that never meets an "after", each render
 *     as an ordinary photograph. Half a comparison is not a comparison.
 *   • ORDER DECIDES WHO PAIRS WITH WHOM. Two "before"s in a row means the first one is on its own.
 *
 * ⚠ The rule is implemented twice — here, over the editor's rows, and in
 * `components/site/BeforeAfterSlider.tsx`'s `splitRestorationPhases`, over the rendered items. They
 * MUST agree: this screen's whole value is that it predicts what the page will do. If the pairing rule
 * changes there, change it here in the same commit.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ContentStatus } from "@prisma/client";
import { Box, ChevronDown, ImagePlus, Trash2, X } from "lucide-react";

import { del, patch, post } from "@/lib/client/fetcher";
import { summariseFailures, uploadFiles, type UploadProgress } from "@/lib/client/upload";
import type { ScreenFraming } from "@/lib/media/screens";
import { cn, unique } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Field, FieldBlock } from "@/components/ui/Field";
import { FileDropzone } from "@/components/ui/FileDropzone";
import { Input } from "@/components/ui/Input";
import { MediaImage } from "@/components/ui/MediaImage";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { Textarea } from "@/components/ui/Textarea";
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
import { ScreenFramingPanel } from "@/components/studio/fields/ScreenFramingPanel";
import { RichTextEditor } from "@/components/studio/editor/RichTextEditor";
import { MediaPicker } from "@/components/studio/media/MediaPicker";
import type { StudioMediaAsset } from "@/components/studio/media/MediaGrid";
import type { EditorMediaSelection } from "@/components/studio/editor/extensions";

/** Just enough of a media row to preview it and remember which one it is. Satisfies `MediaLike`. */
export interface EditorMedia {
  id: string;
  fileName: string;
  altText: string | null;
  objectKey: string;
  width: number | null;
  height: number | null;
  blurDataUrl: string | null;
  /**
   * The crop chosen on the asset. Carried so a picture rendered from this row honours it — a field
   * absent here is a field `MediaImage` never sees, whatever the query fetched.
   */
  cropX: number | null;
  cropY: number | null;
  cropWidth: number | null;
  cropHeight: number | null;
  variants: { label: string; format: string; objectKey: string; width: number }[];
}

/** `""` means the picture is not part of a restoration comparison. */
export type RestorationPhase = "" | "before" | "after";

export interface CraftMediaValue {
  asset: EditorMedia;
  caption: string;
  phase: RestorationPhase;
  /**
   * How THIS PICTURE IN THIS GALLERY is framed at each screen width, or null — the resting state, and what
   * nearly every row carries. It belongs to the row rather than to the file, so the same photograph can be
   * framed one way here and another in a gallery album. A row never changes its picture (a different
   * photograph is a different row), so unlike `coverScreens` there is nothing to clear it against.
   */
  assetScreens: ScreenFraming | null;
}

export interface CraftFormValue {
  name: string;
  slug: string;
  /** The craft's name in its own script. */
  localName: string;
  /** A language tag — "hi", "ta", "bn". Load-bearing for screen readers; see the header. */
  localNameLang: string;
  summary: string;
  body: unknown;
  /** A `CraftRegion` id, or "" for none. */
  regionId: string;
  /** A `CraftSchool` id, or "" for none. */
  schoolId: string;
  /** Held as text. NEGATIVE MEANS BCE. */
  originYear: string;
  originNote: string;
  materialsText: string;
  techniquesText: string;
  latitude: string;
  longitude: string;
  cover: EditorMedia | null;
  /**
   * The cover's framing per screen width, or null — which is the resting state and the common case.
   *
   * ⚠ IT IS CLEARED WHENEVER THE COVER CHANGES, and that is the rule `MediaFramingField` exists to keep
   * in one place for the section forms (see its header). The rectangles are fractions of ONE photograph,
   * so carried onto another they frame whatever happens to sit at those coordinates. This editor's cover
   * control is the media library dialog rather than an `EntityPicker`, so it keeps the rule itself — in
   * `onPicked` and beside the remove button.
   */
  coverScreens: ScreenFraming | null;
  media: CraftMediaValue[];
  /** The storage key of an uploaded glTF/GLB model, or "". */
  modelObjectKey: string;
  isFeatured: boolean;
  status: ContentStatus;
  publishedAt: string | null;
  /**
   * Send the old address to the new one when a published address changes. Defaults to true — the
   * `Redirect` table exists so that moving a page never has to break an existing link (schema). The
   * server ignores it unless the address actually changed on a record that is public.
   */
  createRedirect: boolean;
}

export interface CraftEditorProps {
  craftId: string | null;
  initialValue: CraftFormValue;
  siteUrl: string;
  storageReady: boolean;
  regions: readonly { value: string; label: string }[];
  regionsTruncated: boolean;
  schools: readonly { value: string; label: string }[];
  schoolsTruncated: boolean;
  canPublish: boolean;
  canDelete: boolean;
}

const ENDPOINT = {
  collection: "/api/studio/crafts",
  detail: (id: string) => `/api/studio/crafts/${encodeURIComponent(id)}`
} as const;

const NAME_MAX = 120;
const SUMMARY_MAX = 400;
const MAX_MEDIA = 60;

/** What the file dialog offers. Extensions as well as content types — see the note on the dropzone. */
const MODEL_ACCEPT = ["model/gltf-binary", "model/gltf+json", ".glb", ".gltf"] as const;

/**
 * The language tags offered by the local-name box.
 *
 * A `datalist`, not a closed list: this is a suggestion for the common cases and the box still accepts
 * anything, because a craft name may be in a language nobody thought to list. The labels name the
 * language in English, because that is what the person filling the form reads.
 */
const LANGUAGE_SUGGESTIONS: readonly { tag: string; label: string }[] = [
  { tag: "hi", label: "Hindi" },
  { tag: "sa", label: "Sanskrit" },
  { tag: "bn", label: "Bengali" },
  { tag: "gu", label: "Gujarati" },
  { tag: "mr", label: "Marathi" },
  { tag: "pa", label: "Punjabi" },
  { tag: "ta", label: "Tamil" },
  { tag: "te", label: "Telugu" },
  { tag: "kn", label: "Kannada" },
  { tag: "ml", label: "Malayalam" },
  { tag: "or", label: "Odia" },
  { tag: "as", label: "Assamese" },
  { tag: "ur", label: "Urdu" },
  { tag: "ne", label: "Nepali" },
  { tag: "sd", label: "Sindhi" },
  { tag: "ks", label: "Kashmiri" },
  { tag: "mni", label: "Manipuri" },
  { tag: "en", label: "English" }
];

const PHASE_OPTIONS: readonly { value: RestorationPhase; label: string }[] = [
  { value: "", label: "An ordinary picture" },
  { value: "before", label: "Before restoration" },
  { value: "after", label: "After restoration" }
];

function orNull(text: string): string | null {
  const value = text.trim();
  return value.length > 0 ? value : null;
}

/** One per line, or separated by commas. Trimmed, de-duplicated, order preserved. */
function parseList(text: string): string[] {
  return unique(
    text
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  );
}

/** A whole number, or null. `Number.parseInt` keeps the minus sign, which is the BCE convention. */
function toIntOrNull(text: string): number | null {
  const value = Number.parseInt(text.trim(), 10);
  return Number.isFinite(value) ? value : null;
}

function toFloatOrNull(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const value = Number.parseFloat(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** "c. 3000 BCE" / "c. 1500". The same wording the list column uses. */
function originLabel(year: number | null): string | null {
  if (year === null) return null;
  return year < 0 ? `c. ${Math.abs(year)} BCE` : `c. ${year}`;
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
    // The crop travels with the row: a field not named here is a field MediaImage never sees.
    cropX: asset.cropX ?? null,
    cropY: asset.cropY ?? null,
    cropWidth: asset.cropWidth ?? null,
    cropHeight: asset.cropHeight ?? null,
    variants: asset.variants ?? []
  };
}

function toPayload(value: CraftFormValue) {
  return {
    name: value.name.trim(),
    slug: value.slug.trim(),
    localName: orNull(value.localName),
    localNameLang: orNull(value.localNameLang),
    summary: orNull(value.summary),
    body: value.body ?? null,
    regionId: orNull(value.regionId),
    schoolId: orNull(value.schoolId),
    originYear: toIntOrNull(value.originYear),
    originNote: orNull(value.originNote),
    materials: parseList(value.materialsText),
    techniques: parseList(value.techniquesText),
    latitude: toFloatOrNull(value.latitude),
    longitude: toFloatOrNull(value.longitude),
    coverId: value.cover?.id ?? null,
    coverScreens: value.coverScreens,
    // Sent WHOLE, with positions, and replaced inside the one transaction `mutateWithHistory()` opens.
    // The position is the pairing evidence, so it has to be explicit rather than implied.
    media: value.media.map((entry, position) => ({
      assetId: entry.asset.id,
      caption: orNull(entry.caption),
      // `null`, never "", for a picture that is not part of a pair: the column is nullable and the
      // renderer compares against the words "before" and "after".
      restorationPhase: entry.phase.length > 0 ? entry.phase : null,
      // Beside the id it frames, on every save. Null means "this row's panel was cleared" rather than
      // "leave the column alone" — see `screenFramingField` in lib/studio/crud.ts.
      assetScreens: entry.assetScreens,
      position
    })),
    modelObjectKey: orNull(value.modelObjectKey),
    isFeatured: value.isFeatured,
    status: value.status,
    createRedirect: value.createRedirect
  };
}

/** What will become of one picture once the page is rendered. */
type RowRole = "single" | "pair-before" | "pair-after";

interface RowPlan {
  role: RowRole;
  /** The other half's row number (1-based), for a paired row. */
  partner: number | null;
}

/**
 * Work out which pictures will pair, exactly as the public page will.
 *
 * ⚠ THE SAME RULE AS `splitRestorationPhases` in `components/site/BeforeAfterSlider.tsx`: a "before" is
 * held, and the next "after" completes it. Reimplemented here over the editor's own row shape rather
 * than mapping every row into a lightbox item — see this file's header. If the rule changes there, it
 * changes here in the same commit.
 */
function planRestoration(items: readonly CraftMediaValue[]): RowPlan[] {
  const plan: RowPlan[] = items.map(() => ({ role: "single", partner: null }));
  let pendingBefore: number | null = null;

  items.forEach((item, index) => {
    if (item.phase === "before") {
      // Two "before"s running: the first never found its partner, so it stays an ordinary picture.
      pendingBefore = index;
      return;
    }
    if (item.phase === "after" && pendingBefore !== null) {
      plan[pendingBefore] = { role: "pair-before", partner: index + 1 };
      plan[index] = { role: "pair-after", partner: pendingBefore + 1 };
      pendingBefore = null;
    }
    // An "after" with nothing before it, and an unmarked picture, are both left as singles.
  });

  return plan;
}

export function CraftEditor({
  craftId,
  initialValue,
  siteUrl,
  storageReady,
  regions,
  regionsTruncated,
  schools,
  schoolsTruncated,
  canPublish,
  canDelete
}: CraftEditorProps) {
  const router = useRouter();
  const { toast } = useToast();

  const [value, setValue] = useState<CraftFormValue>(initialValue);
  const [saved, setSaved] = useState<CraftFormValue>(initialValue);
  const [picker, setPicker] = useState<"cover" | "gallery" | "body" | null>(null);
  const bodyResolver = useRef<((selection: EditorMediaSelection | null) => void) | null>(null);
  const createdId = useRef<string | null>(null);
  const [modelUpload, setModelUpload] = useState<UploadProgress | null>(null);

  const isNew = craftId === null;

  const update = useCallback(
    (next: Partial<CraftFormValue>) => setValue((current) => ({ ...current, ...next })),
    []
  );

  const isLiveOrGoingLive =
    saved.status === "PUBLISHED" ||
    saved.status === "SCHEDULED" ||
    value.status === "PUBLISHED" ||
    value.status === "SCHEDULED";

  const save = useCallback(
    async (next: CraftFormValue) => {
      if (craftId === null) {
        const created = await post<{ id: string }>(ENDPOINT.collection, toPayload(next));
        createdId.current = created.id;
        return;
      }
      await patch(ENDPOINT.detail(craftId), toPayload(next));
    },
    [craftId]
  );

  /**
   * Hands over the public address the moment this record crosses onto the site. `basePath` is the same
   * string `SlugField` is given below, so the preview in the form and the link in the notice cannot
   * disagree about where the craft has gone.
   */
  const announcePublished = usePublishNotice({
    initial: initialValue,
    origin: siteUrl,
    basePath: "/craft-explorer/",
    subject: "craft record"
  });

  const autosave = useAutosave<CraftFormValue>({
    data: value,
    save,
    isPublished: isLiveOrGoingLive,
    enabled: !isNew,
    onSaved: (sent) => {
      setSaved(sent);
      const fresh = createdId.current;
      if (fresh !== null) {
        createdId.current = null;
        toast({ tone: "success", title: "The craft record has been created" });
        // Announced AFTER the creation notice, so the two arrive in the order they happened — a record
        // can be created straight into PUBLISHED, and "it exists" reads oddly after "it is public".
        announcePublished(sent);
        router.replace(`/studio/crafts/${fresh}`);
        return;
      }
      announcePublished(sent);
      router.refresh();
    }
  });

  useLeaveGuard(autosave.isDirty);

  const originYear = toIntOrNull(value.originYear);
  const materials = useMemo(() => parseList(value.materialsText), [value.materialsText]);
  const techniques = useMemo(() => parseList(value.techniquesText), [value.techniquesText]);
  const plan = useMemo(() => planRestoration(value.media), [value.media]);

  const latitude = toFloatOrNull(value.latitude);
  const longitude = toFloatOrNull(value.longitude);
  const latitudeOutOfRange =
    value.latitude.trim().length > 0 && (latitude === null || latitude < -90 || latitude > 90);
  const longitudeOutOfRange =
    value.longitude.trim().length > 0 && (longitude === null || longitude < -180 || longitude > 180);
  const halfACoordinate =
    (value.latitude.trim().length > 0) !== (value.longitude.trim().length > 0);

  const localNameWithoutLanguage =
    value.localName.trim().length > 0 && value.localNameLang.trim().length === 0;

  const saveBlockers = useMemo(() => {
    const problems: string[] = [];
    if (value.name.trim().length === 0) problems.push("The name is empty.");
    if (value.slug.trim().length === 0) problems.push("The web address is empty.");
    if (latitudeOutOfRange) problems.push("The latitude must be a number between -90 and 90.");
    if (longitudeOutOfRange) problems.push("The longitude must be a number between -180 and 180.");
    problems.push(...statusProblems(value, false));
    return problems;
  }, [value, latitudeOutOfRange, longitudeOutOfRange]);

  const publishBlockers = useMemo(() => {
    const problems: string[] = [];
    if (value.name.trim().length === 0) problems.push("The craft has no name.");
    if (value.slug.trim().length === 0) problems.push("The craft has no web address.");
    if (value.summary.trim().length === 0) {
      problems.push(
        "There is no summary. The craft explorer shows it under the name, so the card would be a name on its own."
      );
    }
    if (localNameWithoutLanguage) {
      problems.push(
        "The local name has no language recorded. A screen reader would read it with an English voice, which produces sounds that are not words in either language."
      );
    }
    return problems;
  }, [value, localNameWithoutLanguage]);

  // ── The media picker ─────────────────────────────────────────────────────────────────────────

  const requestBodyMedia = useCallback(
    () =>
      new Promise<EditorMediaSelection | null>((resolve) => {
        bodyResolver.current = resolve;
        setPicker("body");
      }),
    []
  );

  /** A dismissed dialog must still settle the promise, or the body editor waits for ever. */
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
      } else if (picker === "gallery") {
        setValue((current) => {
          const already = new Set(current.media.map((entry) => entry.asset.id));
          const additions = assets
            .filter((asset) => !already.has(asset.id))
            .map((asset) => ({
              asset: toEditorMedia(asset),
              caption: "",
              phase: "" as RestorationPhase,
              // A new row starts unframed — null, never an empty framing (`emptyScreenFraming`'s header
              // explains why six blank buckets would mark a clean form dirty).
              assetScreens: null
            }));
          return { ...current, media: [...current.media, ...additions].slice(0, MAX_MEDIA) };
        });
      } else if (first) {
        // A DIFFERENT photograph invalidates every rectangle framed on the old one — see `coverScreens`
        // on `CraftFormValue`. Chosen through `setValue` rather than `update` so the comparison is
        // against the current cover rather than one captured when this callback was made.
        setValue((current) => ({
          ...current,
          cover: toEditorMedia(first),
          coverScreens: first.id === current.cover?.id ? current.coverScreens : null
        }));
      }
      setPicker(null);
    },
    // `update` is deliberately absent: both branches above write through `setValue`'s updater so the
    // comparison is against the CURRENT value rather than one captured when this callback was made.
    [picker, settleBody]
  );

  // ── The 3D model ─────────────────────────────────────────────────────────────────────────────

  /**
   * Upload a glTF or GLB file and keep its storage key.
   *
   * ⚠ `uploadFiles` RESOLVES ON PARTIAL FAILURE. A caller that ignores `failed` reports a success the
   * reader believes and quietly loses the file (lib/client/upload.ts). So the failed list is inspected
   * and the file is NAMED in what is shown.
   */
  const uploadModel = useCallback(
    async (files: File[]) => {
      const file = files[0];
      if (!file) return;

      setModelUpload({
        overall: 0,
        completed: 0,
        total: 1,
        files: [{ file: file.name, status: "pending", progress: 0 }]
      });

      try {
        const result = await uploadFiles([file], {
          // Forced, because a browser often reports a .glb as an unknown binary and the kind cannot be
          // guessed from that.
          kind: "MODEL_3D",
          onProgress: (progress) => setModelUpload(progress)
        });

        const uploaded = result.uploaded[0];
        if (uploaded) {
          update({ modelObjectKey: uploaded.objectKey });
          toast({
            tone: "success",
            title: `${uploaded.fileName} has been uploaded`,
            description: "Save the record to attach it to this craft."
          });
        }
        if (result.failed.length > 0) {
          toast({
            tone: "error",
            title: "The model was not uploaded",
            description: summariseFailures(result.failed)
          });
        }
      } catch (thrown) {
        // `UploadError` is thrown only when nothing landed at all. Its message is a plain sentence.
        toast({
          tone: "error",
          title: "The model was not uploaded",
          description: thrown instanceof Error ? thrown.message : "Something went wrong."
        });
      } finally {
        setModelUpload(null);
      }
    },
    [toast, update]
  );

  const remove = useCallback(async () => {
    if (craftId === null) return;
    await del(ENDPOINT.detail(craftId));
  }, [craftId]);

  // ── Media list helpers ───────────────────────────────────────────────────────────────────────

  const moveMedia = (from: number, to: number) => {
    if (to < 0 || to >= value.media.length || from === to) return;
    const next = [...value.media];
    const moved = next[from];
    if (moved === undefined) return;
    next.splice(from, 1);
    next.splice(to, 0, moved);
    update({ media: next });
  };

  const setMedia = (index: number, next: Partial<CraftMediaValue>) => {
    update({
      media: value.media.map((entry, position) =>
        position === index ? { ...entry, ...next } : entry
      )
    });
  };

  const removeMedia = (index: number) => {
    update({ media: value.media.filter((_unused, position) => position !== index) });
  };

  const pairCount = plan.filter((entry) => entry.role === "pair-before").length;
  const strandedBefore = value.media.filter(
    (entry, index) => entry.phase === "before" && plan[index]?.role === "single"
  ).length;
  const strandedAfter = value.media.filter(
    (entry, index) => entry.phase === "after" && plan[index]?.role === "single"
  ).length;
  const missingDescriptions = value.media.filter((entry) => entry.asset.altText === null).length;

  return (
    <div className="mt-6 space-y-5">
      <FormSection
        title="Name and address"
        description="The English name is used in listings and menus. The local name is shown beside it, in its own script."
      >
        <Field label="Name" required maxLength={NAME_MAX} value={value.name}>
          <Input
            value={value.name}
            onChange={(event) => update({ name: event.target.value })}
            placeholder="Bagru hand-block printing"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Local name, in its own script"
            help="The name the craft is known by where it is made — “बगरू छपाई”. Paste it exactly; nothing here is transliterated."
          >
            <Input
              value={value.localName}
              onChange={(event) => update({ localName: event.target.value })}
              // `lang` on the input as well, so a screen reader reads back what has been typed in the
              // right voice while it is being typed.
              lang={value.localNameLang.trim().length > 0 ? value.localNameLang.trim() : undefined}
            />
          </Field>

          {/*
            `FieldBlock`, not `Field`: there is a `datalist` attached to this input, and the block
            wrapper keeps the association explicit rather than structural.
          */}
          <FieldBlock
            label="What language is that name in?"
            error={
              localNameWithoutLanguage
                ? "A local name needs its language before this can be published."
                : null
            }
            help="Needed so the site can mark the name up correctly. A screen reader uses it to switch voice: without it, Devanagari or Tamil letters are read with an English voice and come out as sounds that are not words in either language. Type a short language code — “hi” for Hindi, “ta” for Tamil — or choose one from the list."
          >
            <Input
              value={value.localNameLang}
              onChange={(event) => update({ localNameLang: event.target.value })}
              list="craft-language-tags"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="hi"
              className="max-w-[12rem] font-mono text-xs"
            />
            <datalist id="craft-language-tags">
              {LANGUAGE_SUGGESTIONS.map((entry) => (
                <option key={entry.tag} value={entry.tag}>
                  {entry.label}
                </option>
              ))}
            </datalist>
          </FieldBlock>
        </div>

        <SlugField
          value={value.slug}
          onChange={(slug) => update({ slug })}
          source={value.name}
          basePath="/craft-explorer/"
          siteUrl={siteUrl}
          // `saved.slug`, not the value this screen opened with: after a save the stored address IS the
          // new one, and a warning about an address that no longer exists cannot be acted on.
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
        description="The summary is the sentence the craft explorer shows on the card. The description is the full account on the craft's own page."
      >
        <Field
          label="Summary"
          maxLength={SUMMARY_MAX}
          value={value.summary}
          help="Two or three plain sentences: what the craft is and what makes it distinctive."
        >
          <Textarea
            value={value.summary}
            onChange={(event) => update({ summary: event.target.value })}
            rows={3}
          />
        </Field>

        <FieldBlock
          label="Description"
          help="The full account. Headings, lists, quotations and pictures are all available; press “/” on an empty line for the full list."
        >
          <RichTextEditor
            value={value.body}
            onChange={(body) => update({ body })}
            label="Craft description"
            placeholder="History, the process, the people who practise it, and what threatens it."
            onRequestMedia={requestBodyMedia}
          />
        </FieldBlock>
      </FormSection>

      <FormSection
        title="Where it comes from"
        description="The region places this craft on the map in the craft explorer. The school is the tradition or lineage it belongs to."
        columns={2}
      >
        {/*
          ⚠ BOTH HELP LINES NAME THE SCREEN THAT FILLS THE LIST, and that is not decoration. These two
          fields used to say "regions are set up separately" and "leave it empty if the craft belongs to no
          named school" while there was NOWHERE in the studio that either was set up: regions were seeded
          and read-only, and `CraftSchool` had no route and no screen at all. So an editor with a real
          school in front of them read a picker with an empty list, a sentence implying the work happened
          elsewhere, and no elsewhere. A field that cannot be filled must say where it is filled.
        */}
        <Field
          label="Region"
          help={
            <>
              Where the craft comes from, and what places it on the craft explorer&apos;s map. Leave it
              empty if the place is not settled — the record still works, it simply is not on the map.{" "}
              {regions.length === 0 ? (
                <>No region has been recorded yet, so this list is empty until one is.</>
              ) : null}{" "}
              Regions are added and placed on{" "}
              <Link href="/studio/crafts/regions" className="font-medium text-purple-700 underline-offset-4 hover:underline">
                Regions on the map
              </Link>
              .
            </>
          }
        >
          <Select
            value={value.regionId}
            options={regions}
            placeholder="No region recorded"
            onChange={(event) => update({ regionId: event.target.value })}
          />
        </Field>

        <Field
          label="School or tradition"
          help={
            <>
              The named school, gharana or workshop lineage this craft belongs to. Leave it empty if it
              belongs to no named school — many traditions do not.{" "}
              {schools.length === 0 ? (
                <>None has been recorded yet, so this list is empty until one is.</>
              ) : null}{" "}
              Schools are added on{" "}
              <Link href="/studio/crafts/schools" className="font-medium text-purple-700 underline-offset-4 hover:underline">
                Schools and traditions
              </Link>
              .
            </>
          }
        >
          <Select
            value={value.schoolId}
            options={schools}
            placeholder="No school recorded"
            onChange={(event) => update({ schoolId: event.target.value })}
          />
        </Field>

        {regionsTruncated || schoolsTruncated ? (
          <div className="sm:col-span-2">
            {regionsTruncated ? (
              <HelpText>
                Only the first {regions.length} regions are listed here, alphabetically. There are more.
              </HelpText>
            ) : null}
            {schoolsTruncated ? (
              <HelpText>
                Only the first {schools.length} schools are listed here, alphabetically. There are more.
              </HelpText>
            ) : null}
          </div>
        ) : null}

        <Field
          label="Latitude"
          error={latitudeOutOfRange ? "A number between -90 and 90." : null}
          help="Optional, and only useful with a longitude beside it. Decimal degrees, north positive."
        >
          <Input
            inputMode="decimal"
            value={value.latitude}
            onChange={(event) => update({ latitude: event.target.value })}
            placeholder="26.9124"
            className="font-mono text-xs"
          />
        </Field>

        <Field
          label="Longitude"
          error={longitudeOutOfRange ? "A number between -180 and 180." : null}
          help="Decimal degrees, east positive."
        >
          <Input
            inputMode="decimal"
            value={value.longitude}
            onChange={(event) => update({ longitude: event.target.value })}
            placeholder="75.7873"
            className="font-mono text-xs"
          />
        </Field>

        {halfACoordinate ? (
          <div className="sm:col-span-2">
            <HelpText tone="warn">
              Only one of the two coordinates has been filled in, so this craft cannot be placed on the
              map. A point needs both.
            </HelpText>
          </div>
        ) : null}
      </FormSection>

      <FormSection
        title="When it began"
        description="Approximate is expected. A made-up precise year is worse than an empty entry on the timeline."
        columns={2}
      >
        <FieldBlock
          label="Origin year — a minus sign means BCE"
          help="A whole number. Put a minus sign in front for a year before the Common Era: -3000 means 3000 BCE. Leave it empty if the period is not known, and say what is known in the note beside it."
        >
          {/*
            NOT `type="number"`, deliberately. A number input reports its value as the empty string
            while the content is not a valid number — and a lone minus sign, which is the first
            keystroke of every BCE year, is exactly that. A controlled number input can therefore eat
            the very character this field exists for. Plain text with a numeric keypad on a phone.
          */}
          <Input
            inputMode="numeric"
            value={value.originYear}
            onChange={(event) => update({ originYear: event.target.value })}
            placeholder="-3000"
            spellCheck={false}
            className="max-w-[12rem]"
          />

          {/* The convention, confirmed as it is typed. Not a live region: it changes on every keystroke. */}
          <p className="mt-2 text-xs text-ink-700">
            {originYear === null
              ? "No year recorded — the timeline will simply not show this craft."
              : `The site will show this as “${originLabel(originYear)}”.`}
          </p>
        </FieldBlock>

        <Field
          label="Note about the date"
          help="“Medieval period”, “documented from the 1700s”, “oral tradition places it earlier”. Shown beside the year."
        >
          <Input
            value={value.originNote}
            onChange={(event) => update({ originNote: event.target.value })}
          />
        </Field>
      </FormSection>

      <FormSection
        title="Materials and techniques"
        description="These are what a visitor filters the craft explorer by, so the same words used across records are worth more than precise ones used once."
        columns={2}
      >
        <FieldBlock
          label="Materials"
          help="One per line, or separated by commas."
        >
          <Textarea
            value={value.materialsText}
            onChange={(event) => update({ materialsText: event.target.value })}
            rows={4}
            placeholder={"cotton\nindigo\nmadder root\npomegranate rind"}
          />
          <ChipPreview items={materials} noun="material" />
        </FieldBlock>

        <FieldBlock label="Techniques" help="One per line, or separated by commas.">
          <Textarea
            value={value.techniquesText}
            onChange={(event) => update({ techniquesText: event.target.value })}
            rows={4}
            placeholder={"hand-block printing\nresist dyeing\nsun bleaching"}
          />
          <ChipPreview items={techniques} noun="technique" />
        </FieldBlock>
      </FormSection>

      <FormSection
        title="Cover picture"
        description="The picture on the craft's card in the explorer and at the top of its own page."
      >
        <FieldBlock label="Cover picture">
          {value.cover ? (
            <div className="flex flex-wrap items-start gap-4">
              <MediaImage
                media={value.cover}
                alt=""
                aspect={4 / 3}
                rounded="md"
                sizes="240px"
                className="w-60 shrink-0"
              />
              <div className="min-w-0 flex-1 space-y-2">
                <p className="truncate text-sm text-ink-700">{value.cover.fileName}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={ImagePlus}
                    onClick={() => setPicker("cover")}
                  >
                    Choose a different picture
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Trash2}
                    onClick={() => update({ cover: null, coverScreens: null })}
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

          {/*
            Offered only once there is a picture, because framing nothing is a control with nothing to act
            on — the same condition `MediaFramingField` applies on the section forms. It is SUPPLEMENTARY:
            one photograph is used at every width unless a bucket says otherwise, so the panel starts shut,
            and it rides this form's autosave rather than patching anything of its own.
          */}
          {value.cover ? (
            <div className="mt-3">
              <ScreenFramingPanel
                label="Framing per screen size"
                mediaId={value.cover.id}
                value={value.coverScreens}
                onChange={(next) => update({ coverScreens: next })}
              />
            </div>
          ) : null}
        </FieldBlock>
      </FormSection>

      <FormSection
        title="Photographs, and before-and-after pairs"
        description="The gallery on the craft's page, in this order. A picture can also be marked as one half of a restoration comparison — read the note below before using that."
        actions={
          value.media.length < MAX_MEDIA ? (
            <Button
              variant="secondary"
              size="sm"
              icon={ImagePlus}
              onClick={() => setPicker("gallery")}
            >
              Add pictures
            </Button>
          ) : null
        }
      >
        <div className="rounded-md border border-line-200 bg-surface-50 px-4 py-3">
          <p className="text-sm font-medium text-ink-900">How a before-and-after pair is made</p>
          <ul className="mt-1.5 ml-4 list-disc space-y-1 text-xs leading-relaxed text-ink-700">
            <li>
              Mark one picture <strong>Before restoration</strong> and put the matching picture
              immediately below it, marked <strong>After restoration</strong>. The pair is made by that
              order and nothing else — a “before” pairs with the next “after” under it.
            </li>
            <li>
              <strong>A pair needs both halves.</strong> A picture marked “after” with no “before” above
              it, and a “before” that never meets an “after”, are each shown as an ordinary photograph
              instead. Half a comparison is not a comparison.
            </li>
            <li>
              Every row below says what will become of it, so you can check the result before saving.
            </li>
          </ul>
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="field-label">Pictures</span>
            <span
              className={cn(
                "text-xs tabular-nums",
                value.media.length >= MAX_MEDIA ? "text-amber-800" : "text-ink-500"
              )}
            >
              You can add up to {MAX_MEDIA}; {value.media.length} added.
            </span>
          </div>

          {value.media.length === 0 ? (
            <div className="mt-2 rounded-md border border-dashed border-line-200 bg-surface-50 px-4 py-6 text-center">
              <p className="text-sm text-ink-500">
                No pictures yet. The craft&rsquo;s page simply has no gallery until one is added.
              </p>
              <Button
                variant="secondary"
                size="sm"
                icon={ImagePlus}
                onClick={() => setPicker("gallery")}
                className="mt-3"
              >
                Add pictures
              </Button>
            </div>
          ) : (
            <ul className="mt-2 space-y-2">
              {value.media.map((entry, index) => {
                const rowPlan = plan[index] ?? { role: "single" as RowRole, partner: null };
                const stranded = entry.phase.length > 0 && rowPlan.role === "single";

                return (
                  <li
                    key={entry.asset.id}
                    className={cn(
                      "flex flex-wrap items-start gap-3 rounded-md border bg-card p-2",
                      // A stranded half is tinted AND worded. amber-100 with amber-800 as a pair
                      // (contract §1) — the status ramps are literal hex and do not invert on purpose.
                      stranded ? "border-amber-800/40 bg-amber-100" : "border-line-200"
                    )}
                  >
                    <span className="shrink-0 pt-1 text-xs tabular-nums text-ink-500">{index + 1}</span>

                    <MediaImage
                      media={entry.asset}
                      alt=""
                      aspect={4 / 3}
                      rounded="sm"
                      sizes="120px"
                      className="w-28 shrink-0"
                    />

                    <div className="min-w-[16rem] flex-1 space-y-2">
                      <p className="truncate text-xs text-ink-500">{entry.asset.fileName}</p>

                      <Input
                        value={entry.caption}
                        onChange={(event) => setMedia(index, { caption: event.target.value })}
                        placeholder="Caption shown under the picture"
                        aria-label={`Caption for picture ${index + 1}`}
                      />

                      <div className="flex flex-wrap items-center gap-2">
                        <Select
                          value={entry.phase}
                          options={PHASE_OPTIONS.map((option) => ({
                            value: option.value,
                            label: option.label
                          }))}
                          aria-label={`What picture ${index + 1} is`}
                          onChange={(event) =>
                            setMedia(index, { phase: event.target.value as RestorationPhase })
                          }
                          className="max-w-[16rem]"
                        />

                        <span
                          className={cn(
                            "text-xs leading-relaxed",
                            stranded ? "text-amber-800" : "text-ink-500"
                          )}
                        >
                          {rowPlan.role === "pair-before"
                            ? `Pairs with picture ${rowPlan.partner} as a before-and-after slider.`
                            : rowPlan.role === "pair-after"
                              ? `The “after” half of the pair with picture ${rowPlan.partner}.`
                              : entry.phase === "before"
                                ? "Marked “before”, but there is no “after” under it — it will be shown as an ordinary picture."
                                : entry.phase === "after"
                                  ? "Marked “after”, but there is no “before” above it — it will be shown as an ordinary picture."
                                  : "Shown as an ordinary picture in the gallery."}
                        </span>
                      </div>

                      {entry.asset.altText === null ? (
                        <HelpText tone="warn">
                          No description, so a screen reader says nothing about this picture. A caption is
                          not the same thing — add a description in the media library.
                        </HelpText>
                      ) : null}

                      {/*
                        THIS ROW'S FRAMING, AND ONLY WHERE THE PICTURE IS DRAWN AS AN ORDINARY TILE.

                        A paired picture goes into `BeforeAfterSlider`, which overlays the two halves in one
                        frame whose shape is the "after"'s so that the seam reveals rather than moves.
                        Re-framing one half at some widths would slide that seam across the subject, so the
                        slider is handed the plain rows and the panel is not offered here — the same gate
                        `HeroForm` puts on a video background, for the same reason.

                        `rowPlan.role` is the editor's own preview of what the page will do, so a row marked
                        "before" with no "after" under it is a single tile HERE as well as there, and keeps
                        its panel. Not `MediaFramingField`: a row's photograph is not swappable, so there is
                        nothing for that component's clear-on-change rule to act on.
                      */}
                      {rowPlan.role === "single" ? (
                        <ScreenFramingPanel
                          label="Framing per screen size, in this gallery"
                          help="Optional. Frame this picture differently at each screen size, or use a different photograph on narrow screens. Anything left alone inherits from the next smaller size, and the smallest falls back to the picture's own crop. It applies to the gallery tile on the craft's page; opening a picture full screen always shows the whole photograph."
                          mediaId={entry.asset.id}
                          value={entry.assetScreens}
                          onChange={(next) => setMedia(index, { assetScreens: next })}
                        />
                      ) : null}
                    </div>

                    <div className="flex shrink-0 items-center">
                      {/*
                        `aria-disabled` and a no-op at the ends, never `disabled`: browsers blur a control
                        the moment it becomes disabled, so moving a picture to the top with the keyboard
                        would drop focus to the document body (RepeaterField.tsx, decision 2).
                      */}
                      <MoveButton
                        label={`Move picture ${index + 1} of ${value.media.length} up`}
                        unavailable={index === 0}
                        rotate
                        onClick={() => moveMedia(index, index - 1)}
                      />
                      <MoveButton
                        label={`Move picture ${index + 1} of ${value.media.length} down`}
                        unavailable={index === value.media.length - 1}
                        onClick={() => moveMedia(index, index + 1)}
                      />
                      <button
                        type="button"
                        onClick={() => removeMedia(index)}
                        aria-label={`Take ${entry.asset.fileName} out of this gallery`}
                        className="inline-flex h-8 w-8 items-center justify-center rounded text-ink-500 transition hover:bg-error-100 hover:text-error-600 focus-visible:ring-2 focus-visible:ring-error-600/30"
                      >
                        <X aria-hidden="true" className="h-4 w-4" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {pairCount > 0 ? (
            <p className="mt-2 text-xs leading-relaxed text-ink-700">
              {pairCount === 1
                ? "One before-and-after slider will be shown."
                : `${pairCount} before-and-after sliders will be shown.`}
            </p>
          ) : null}

          {strandedBefore + strandedAfter > 0 ? (
            <HelpText tone="warn" className="mt-2">
              {strandedBefore > 0
                ? `${strandedBefore === 1 ? "One picture is" : `${strandedBefore} pictures are`} marked “before” with no “after” under ${strandedBefore === 1 ? "it" : "them"}. `
                : ""}
              {strandedAfter > 0
                ? `${strandedAfter === 1 ? "One picture is" : `${strandedAfter} pictures are`} marked “after” with no “before” above ${strandedAfter === 1 ? "it" : "them"}. `
                : ""}
              Each of those will be shown as an ordinary photograph. Move the two halves next to each
              other, in that order, to make a comparison.
            </HelpText>
          ) : null}

          {missingDescriptions > 0 ? (
            <HelpText tone="warn" className="mt-2">
              {missingDescriptions === 1
                ? "One of these pictures has no description"
                : `${missingDescriptions} of these pictures have no description`}
              , so somebody using a screen reader is told nothing about{" "}
              {missingDescriptions === 1 ? "it" : "them"}. Descriptions are written once, in the media
              library, and used everywhere the picture appears.
            </HelpText>
          ) : null}

          {value.media.length >= MAX_MEDIA ? (
            <HelpText tone="warn" className="mt-2">
              That is the most this gallery holds. Take one out before adding another.
            </HelpText>
          ) : null}
        </div>
      </FormSection>

      <FormSection
        title="3D model"
        description="A glTF or GLB scan of an object, shown in a viewer on the craft's page. Most crafts have none, and the viewer is only there when a model is."
      >
        {value.modelObjectKey.trim().length > 0 ? (
          <div className="space-y-2">
            <p className="flex items-start gap-2 text-sm text-ink-700">
              <Box aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-purple-700" />
              <span className="min-w-0">
                A model is attached.
                <span className="mt-0.5 block break-all font-mono text-[0.6875rem] text-ink-500">
                  {value.modelObjectKey}
                </span>
              </span>
            </p>
            <Button
              variant="ghost"
              size="sm"
              icon={Trash2}
              onClick={() => update({ modelObjectKey: "" })}
            >
              Remove the model
            </Button>
            <HelpText>
              Removing it here takes the viewer off the craft&rsquo;s page. The file itself stays in the
              store and can be attached again.
            </HelpText>
          </div>
        ) : modelUpload !== null ? (
          <ProgressBar
            value={Math.round(modelUpload.overall * 100)}
            label="Uploading the model"
            hint={modelUpload.files[0]?.file ?? "Uploading…"}
          />
        ) : (
          <>
            <FileDropzone
              onFiles={(files) => void uploadModel(files)}
              accept={MODEL_ACCEPT}
              acceptSummary="glTF and GLB models"
              multiple={false}
              title="Add a 3D model"
              disabled={!storageReady}
              disabledReason="The file store is not set up, so nothing can be uploaded yet. An administrator can configure it in Settings."
            />
            <HelpText>
              A .glb file is usually the right choice: it is a single file with the textures inside it. If
              the browser says it cannot tell what the file is, check that the name ends in .glb or
              .gltf.
            </HelpText>
          </>
        )}
      </FormSection>

      <FormSection
        title="Publication"
        description="Whether this craft appears in the craft explorer. Craft records cannot be scheduled."
      >
        <StatusControl
          value={{ status: value.status, publishedAt: value.publishedAt }}
          onChange={(next) => update({ status: next.status })}
          canPublish={canPublish}
          scheduling={false}
          publishBlockers={publishBlockers}
        />

        <Switch
          checked={value.isFeatured}
          onCheckedChange={(isFeatured) => update({ isFeatured })}
          label="Feature this craft"
          description="Featured crafts can be pulled onto the homepage and other pages by a craft block. It does not change this craft's own page."
        />
      </FormSection>

      {canDelete && !isNew ? (
        <FormSection
          title="Delete this craft record"
          tone="danger"
          description="The photographs and the model stay in the store and can be used elsewhere. Only this record and the order of its pictures go."
        >
          <DeleteButton
            name={saved.name.trim().length > 0 ? saved.name : "this craft record"}
            noun="craft record"
            onDelete={remove}
            onDeleted={() => router.push("/studio/crafts")}
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
        saveLabel={isNew ? "Create craft record" : "Save"}
        subject="this craft record"
        note={
          isNew
            ? "Nothing is saved until you press Create. After that your changes are kept automatically every few seconds, until the record is published."
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
        multiple={picker === "gallery"}
        kind="IMAGE"
        storageReady={storageReady}
        title={
          picker === "body"
            ? "Insert a picture"
            : picker === "gallery"
              ? "Add pictures to this craft"
              : "Choose a cover picture"
        }
      />
    </div>
  );
}

/** What a line-separated list will actually be stored as. */
function ChipPreview({ items, noun }: { items: readonly string[]; noun: string }) {
  if (items.length === 0) return null;
  return (
    <>
      <p className="mt-2 text-xs text-ink-500">
        {items.length === 1
          ? `This will be stored as one ${noun}:`
          : `This will be stored as ${items.length} ${noun}s:`}
      </p>
      <ul className="mt-1.5 flex flex-wrap gap-1.5">
        {items.map((item) => (
          <li
            key={item}
            className="rounded-full border border-line-200 bg-surface-100 px-2.5 py-0.5 text-xs text-ink-700"
          >
            {item}
          </li>
        ))}
      </ul>
    </>
  );
}

/** One end-of-list-aware move button. `aria-disabled`, never `disabled` — see its call site. */
function MoveButton({
  label,
  unavailable,
  rotate = false,
  onClick
}: {
  label: string;
  unavailable: boolean;
  rotate?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-disabled={unavailable || undefined}
      onClick={() => {
        if (unavailable) return;
        onClick();
      }}
      className={cn(
        "inline-flex h-8 w-7 items-center justify-center rounded transition focus-visible:ring-2 focus-visible:ring-purple-600/30",
        unavailable
          ? "cursor-default text-ink-300 opacity-50"
          : "text-ink-500 hover:bg-surface-100 hover:text-ink-900"
      )}
    >
      <ChevronDown aria-hidden="true" className={cn("h-4 w-4", rotate && "rotate-180")} />
    </button>
  );
}
