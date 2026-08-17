"use client";

/**
 * The project editor — every field on the public project page, in the order an editor fills them in.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE FUNDING AMOUNT IS TEXT, AND THE SCREEN SAYS SO.
 *
 * `fundingAmount` is a string with the currency stored beside it, because a numeric column would have
 * to pick one currency and every grant that is not in it becomes wrong by exactly the exchange rate on
 * an unknown day (schema, `Project`). So "£450,000", "1.2 crore" and "45,00,000" are all valid and all
 * appear on the site EXACTLY as typed — no thousands separators are added, no symbol is inserted,
 * nothing is rounded. Without that sentence beside the field an administrator types `450000`, expects
 * the site to format it, and publishes a bare number.
 *
 * PROGRESS OF ZERO MEANS "NOT TRACKED", AND THE FIELD SAYS THAT ZERO HIDES THE BAR ENTIRELY. Otherwise
 * a project left at 0 looks, to the editor, like a project the site is reporting as not started — and
 * the natural fix is to type 1, which puts a 1% bar on the page for ever.
 *
 * THE TEAM IS TWO CONTROLS THAT SHARE ONE LIST. The picker chooses the people and their printed order;
 * the rows beneath it name what each one does. They are kept in step by id, so reordering or removing
 * somebody in the picker never leaves a role attached to the wrong person.
 *
 * AUTOSAVE STOPS FOR ANYTHING PUBLIC, IN BOTH DIRECTIONS — see `useAutosave`'s header. A published
 * project is never saved by a timer, and neither is one whose form has just been set to Published.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ContentStatus, ProjectStatus } from "@prisma/client";
import { ChevronDown, ImagePlus, Trash2, X } from "lucide-react";

import { del, patch, post } from "@/lib/client/fetcher";
import { useResource } from "@/lib/client/useResource";
import { clamp, cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { DateField } from "@/components/ui/DateField";
import { Field, FieldBlock } from "@/components/ui/Field";
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
import { EntityPicker, lookupResolvePath, type LookupItem, type LookupResponse } from "@/components/studio/fields/EntityPicker";
import { RepeaterField } from "@/components/studio/fields/RepeaterField";
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

export interface ProjectMemberValue {
  personId: string;
  /** "Principal investigator", "Research assistant". Optional — a name alone is a valid entry. */
  role: string;
}

export interface ProjectMilestoneValue {
  title: string;
  detail: string;
  /** `YYYY-MM-DD`, or "" — see the page's header for why these are UTC days rather than instants. */
  dueOn: string;
  completedOn: string;
}

export interface ProjectGalleryValue {
  asset: EditorMedia;
  caption: string;
}

export interface ProjectFaqValue {
  question: string;
  answer: string;
}

export interface ProjectFormValue {
  title: string;
  slug: string;
  tagline: string;
  summary: string;
  body: unknown;
  state: ProjectStatus;
  /** Zero or one. A single-choice picker still holds an array — one code path for one and for many. */
  researchAreaIds: string[];
  fundingBody: string;
  /** Free text, shown exactly as typed. See the header. */
  fundingAmount: string;
  fundingCurrency: string;
  startedOn: string;
  endedOn: string;
  /** Held as text; 0–100 once converted. Zero means "not tracked". */
  progress: string;
  cover: EditorMedia | null;
  members: ProjectMemberValue[];
  milestones: ProjectMilestoneValue[];
  gallery: ProjectGalleryValue[];
  fileIds: string[];
  publicationIds: string[];
  partnerIds: string[];
  faqs: ProjectFaqValue[];
  isFeatured: boolean;
  sortOrder: string;
  status: ContentStatus;
  publishedAt: string | null;
  /**
   * Send the old address to the new one when a published address changes. Defaults to true — the
   * `Redirect` table exists so that moving a page never has to break an existing link (schema). The
   * server ignores it unless the address actually changed on a record that is public.
   */
  createRedirect: boolean;
}

export interface ProjectEditorProps {
  projectId: string | null;
  initialValue: ProjectFormValue;
  siteUrl: string;
  storageReady: boolean;
  canPublish: boolean;
  canDelete: boolean;
}

const ENDPOINT = {
  collection: "/api/studio/projects",
  detail: (id: string) => `/api/studio/projects/${encodeURIComponent(id)}`
} as const;

const TITLE_MAX = 160;
const TAGLINE_MAX = 140;
const SUMMARY_MAX = 400;

/** The schema's caps, stated on screen by `RepeaterField` and enforced by the same numbers. */
const MAX_MILESTONES = 40;
const MAX_FAQS = 20;
const MAX_TEAM = 40;
const MAX_GALLERY = 48;
const MAX_LINKED = 40;

/**
 * ⚠ The wording must stay in step with `app/(site)/projects/page.tsx` and this group's `ProjectTable`.
 * One project cannot be "Active" here and "In progress" there.
 */
const STAGE_OPTIONS: readonly { value: ProjectStatus; label: string }[] = [
  { value: "ACTIVE", label: "Active" },
  { value: "COMPLETED", label: "Completed" },
  { value: "PROPOSED", label: "Proposed" },
  { value: "ON_HOLD", label: "On hold" }
];

const STAGE_MEANINGS: Record<ProjectStatus, string> = {
  ACTIVE: "Work is going on now.",
  COMPLETED: "The work has finished. It stays on the site as part of the record.",
  PROPOSED: "Submitted or planned, not started.",
  ON_HOLD: "Started, and paused for now."
};

function orNull(text: string): string | null {
  const value = text.trim();
  return value.length > 0 ? value : null;
}

function toIntOrZero(text: string): number {
  const value = Number.parseInt(text.trim(), 10);
  return Number.isFinite(value) ? value : 0;
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

/**
 * The body the API is given.
 *
 * The nested lists are sent WHOLE, with their positions, and the handler replaces each list inside the
 * one transaction `mutateWithHistory()` already opens. Sending a diff would mean the client deciding
 * what changed, and a client that gets that wrong deletes a row nobody touched.
 */
function toPayload(value: ProjectFormValue) {
  return {
    title: value.title.trim(),
    slug: value.slug.trim(),
    tagline: orNull(value.tagline),
    summary: orNull(value.summary),
    body: value.body ?? null,
    state: value.state,
    researchAreaId: value.researchAreaIds[0] ?? null,
    fundingBody: orNull(value.fundingBody),
    fundingAmount: orNull(value.fundingAmount),
    fundingCurrency: orNull(value.fundingCurrency),
    startedOn: orNull(value.startedOn),
    endedOn: orNull(value.endedOn),
    // Clamped here as well as on the server: a bar that can read 140% is worse than no bar (schema).
    progress: clamp(toIntOrZero(value.progress), 0, 100),
    coverId: value.cover?.id ?? null,
    members: value.members.map((member, position) => ({
      personId: member.personId,
      role: orNull(member.role),
      position
    })),
    milestones: value.milestones
      .filter((milestone) => milestone.title.trim().length > 0)
      .map((milestone, position) => ({
        title: milestone.title.trim(),
        detail: orNull(milestone.detail),
        dueOn: orNull(milestone.dueOn),
        completedOn: orNull(milestone.completedOn),
        position
      })),
    media: value.gallery.map((entry, position) => ({
      assetId: entry.asset.id,
      caption: orNull(entry.caption),
      position
    })),
    fileIds: value.fileIds,
    publicationIds: value.publicationIds,
    partnerIds: value.partnerIds,
    faqs: value.faqs
      .filter((faq) => faq.question.trim().length > 0 && faq.answer.trim().length > 0)
      .map((faq, position) => ({
        question: faq.question.trim(),
        answer: faq.answer.trim(),
        position
      })),
    isFeatured: value.isFeatured,
    sortOrder: toIntOrZero(value.sortOrder),
    status: value.status,
    createRedirect: value.createRedirect
  };
}

export function ProjectEditor({
  projectId,
  initialValue,
  siteUrl,
  storageReady,
  canPublish,
  canDelete
}: ProjectEditorProps) {
  const router = useRouter();
  const { toast } = useToast();

  const [value, setValue] = useState<ProjectFormValue>(initialValue);
  const [saved, setSaved] = useState<ProjectFormValue>(initialValue);
  const [picker, setPicker] = useState<"cover" | "gallery" | "body" | null>(null);
  const bodyResolver = useRef<((selection: EditorMediaSelection | null) => void) | null>(null);
  const createdId = useRef<string | null>(null);

  const isNew = projectId === null;

  const update = useCallback(
    (next: Partial<ProjectFormValue>) => setValue((current) => ({ ...current, ...next })),
    []
  );

  const isLiveOrGoingLive =
    saved.status === "PUBLISHED" ||
    saved.status === "SCHEDULED" ||
    value.status === "PUBLISHED" ||
    value.status === "SCHEDULED";

  const save = useCallback(
    async (next: ProjectFormValue) => {
      if (projectId === null) {
        const created = await post<{ id: string }>(ENDPOINT.collection, toPayload(next));
        createdId.current = created.id;
        return;
      }
      await patch(ENDPOINT.detail(projectId), toPayload(next));
    },
    [projectId]
  );

  /** The public address, handed over the moment this project crosses onto the site. */
  const announcePublished = usePublishNotice({
    initial: initialValue,
    origin: siteUrl,
    basePath: "/projects/",
    subject: "project"
  });

  const autosave = useAutosave<ProjectFormValue>({
    data: value,
    save,
    isPublished: isLiveOrGoingLive,
    enabled: !isNew,
    onSaved: (sent) => {
      setSaved(sent);
      const fresh = createdId.current;
      if (fresh !== null) {
        createdId.current = null;
        toast({ tone: "success", title: "The project has been created" });
        // After the creation notice, so the two arrive in the order they happened.
        announcePublished(sent);
        router.replace(`/studio/projects/${fresh}`);
        return;
      }
      announcePublished(sent);
      router.refresh();
    }
  });

  useLeaveGuard(autosave.isDirty);

  // ── Validation ───────────────────────────────────────────────────────────────────────────────

  const datesOutOfOrder =
    value.startedOn.length > 0 &&
    value.endedOn.length > 0 &&
    value.endedOn < value.startedOn;

  const progressNumber = toIntOrZero(value.progress);
  const progressOutOfRange =
    value.progress.trim().length > 0 && (progressNumber < 0 || progressNumber > 100);

  const saveBlockers = useMemo(() => {
    const problems: string[] = [];
    if (value.title.trim().length === 0) problems.push("The title is empty.");
    if (value.slug.trim().length === 0) problems.push("The web address is empty.");
    if (datesOutOfOrder) problems.push("The end date is before the start date.");
    if (progressOutOfRange) problems.push("Progress must be a number between 0 and 100.");
    problems.push(...statusProblems(value, false));
    return problems;
  }, [value, datesOutOfOrder, progressOutOfRange]);

  const publishBlockers = useMemo(() => {
    const problems: string[] = [];
    if (value.title.trim().length === 0) problems.push("The project has no title.");
    if (value.slug.trim().length === 0) problems.push("The project has no web address.");
    if (value.summary.trim().length === 0) {
      problems.push("There is no summary. The projects listing shows it under the title, so the card would be a title on its own.");
    }
    if (value.researchAreaIds.length === 0) {
      problems.push("No research area has been chosen, so this project will not appear under any theme on the research page.");
    }
    if (datesOutOfOrder) problems.push("The end date is before the start date.");
    return problems;
  }, [value, datesOutOfOrder]);

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
          const already = new Set(current.gallery.map((entry) => entry.asset.id));
          const additions = assets
            .filter((asset) => !already.has(asset.id))
            .map((asset) => ({ asset: toEditorMedia(asset), caption: "" }));
          // The cap is enforced here as well as stated below it, so a picker with forty selections
          // cannot smuggle in more than the list holds.
          return { ...current, gallery: [...current.gallery, ...additions].slice(0, MAX_GALLERY) };
        });
      } else if (first) {
        update({ cover: toEditorMedia(first) });
      }
      setPicker(null);
    },
    [picker, settleBody, update]
  );

  // ── Team ─────────────────────────────────────────────────────────────────────────────────────

  const memberIds = useMemo(() => value.members.map((member) => member.personId), [value.members]);

  const setMemberIds = useCallback(
    (ids: string[]) => {
      setValue((current) => {
        // Keyed by id so a reorder or a removal never leaves a role attached to the wrong person.
        const byId = new Map(current.members.map((member) => [member.personId, member]));
        return {
          ...current,
          members: ids.map((id) => byId.get(id) ?? { personId: id, role: "" })
        };
      });
    },
    []
  );

  const setMemberRole = useCallback((personId: string, role: string) => {
    setValue((current) => ({
      ...current,
      members: current.members.map((member) =>
        member.personId === personId ? { ...member, role } : member
      )
    }));
  }, []);

  // ── Delete ───────────────────────────────────────────────────────────────────────────────────

  const remove = useCallback(async () => {
    if (projectId === null) return;
    await del(ENDPOINT.detail(projectId));
  }, [projectId]);

  return (
    <div className="mt-6 space-y-5">
      <FormSection
        title="Title and address"
        description="The title is used everywhere this project is listed. The web address is what a link or a citation records."
      >
        <Field label="Title" required maxLength={TITLE_MAX} value={value.title}>
          <Input
            value={value.title}
            onChange={(event) => update({ title: event.target.value })}
            placeholder="Digitising the Bagru block-printing archive"
          />
        </Field>

        <Field
          label="Tagline"
          maxLength={TAGLINE_MAX}
          value={value.tagline}
          help="One short line under the title on the project's page. Leave it empty if the title says enough."
        >
          <Input
            value={value.tagline}
            onChange={(event) => update({ tagline: event.target.value })}
          />
        </Field>

        <SlugField
          value={value.slug}
          onChange={(slug) => update({ slug })}
          source={value.title}
          basePath="/projects/"
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
        title="Overview and description"
        description="The summary is the paragraph every listing shows. The description is the full text on the project's own page."
      >
        <Field
          label="Summary"
          maxLength={SUMMARY_MAX}
          value={value.summary}
          help="Two or three plain sentences: what the project is doing and why. It appears on the projects listing, in search results and when the page is shared."
        >
          <Textarea
            value={value.summary}
            onChange={(event) => update({ summary: event.target.value })}
            rows={4}
          />
        </Field>

        <FieldBlock
          label="Description"
          help="The full account of the project. Headings, lists, quotations, tables and pictures are all available; press “/” on an empty line for the full list."
        >
          <RichTextEditor
            value={value.body}
            onChange={(body) => update({ body })}
            label="Project description"
            placeholder="What the project set out to do, how it is being done, and what has come of it so far."
            onRequestMedia={requestBodyMedia}
          />
        </FieldBlock>
      </FormSection>

      <FormSection
        title="Where it belongs"
        description="The research area files this project under a theme on the research page. The stage says where the work stands, which is not the same thing as whether the page is published."
        columns={1}
      >
        <EntityPicker
          kind="research"
          label="Research area"
          ids={value.researchAreaIds}
          onChange={(ids) => update({ researchAreaIds: ids })}
          max={1}
          help="The theme this project sits under. A project with no area still has its own page, but it will not appear anywhere on the research page."
        />

        <Field label="Stage" help={STAGE_MEANINGS[value.state]}>
          <Select
            value={value.state}
            options={STAGE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(event) => update({ state: event.target.value as ProjectStatus })}
          />
        </Field>
      </FormSection>

      <FormSection
        title="Funding"
        description="Who paid for the work, and how much. Both are optional, and both appear on the project's page exactly as typed here."
        columns={2}
      >
        <Field
          label="Funding body"
          help="The organisation that awarded the grant, written as they write it."
        >
          <Input
            value={value.fundingBody}
            onChange={(event) => update({ fundingBody: event.target.value })}
            placeholder="Ministry of Textiles"
          />
        </Field>

        <Field
          label="Currency"
          help="Shown just before the amount. Leave it empty if the amount below already carries a symbol."
          maxLength={12}
          value={value.fundingCurrency}
        >
          <Input
            value={value.fundingCurrency}
            onChange={(event) => update({ fundingCurrency: event.target.value })}
            placeholder="INR"
            className="max-w-[10rem]"
          />
        </Field>

        <Field
          label="Amount"
          help={
            <>
              Written out however it should appear — &ldquo;₹45,00,000&rdquo;, &ldquo;1.2 crore&rdquo;,
              &ldquo;£450,000&rdquo;. It is shown on the site{" "}
              <strong className="font-semibold text-ink-700">exactly as you type it</strong>: no
              separators are added, no symbol is inserted and nothing is rounded. So type the whole thing,
              not a bare number.
            </>
          }
          className="sm:col-span-2"
        >
          <Input
            value={value.fundingAmount}
            onChange={(event) => update({ fundingAmount: event.target.value })}
            placeholder="₹45,00,000"
          />
        </Field>
      </FormSection>

      <FormSection
        title="Dates and progress"
        description="The dates are days, not times. Progress is the bar on the project's page."
        columns={2}
      >
        {/*
          ⚠ THE UTC CONVENTION THIS SCREEN WAS BUILT ON IS UNTOUCHED. Every date on this form is a
          `YYYY-MM-DD` STRING from the moment `page.tsx` slices it out of `toISOString()` to the moment
          it is posted back — "DATES CROSS AS `YYYY-MM-DD`, IN UTC" in that file's header is the whole
          rule, and it holds because `DateField` is string-in/string-out and parses nothing on the way
          through (its header explains at length why it refuses to own a zone). A picker that handed
          back a `Date` here would have re-parsed a day as an instant and moved it by one.

          `DateField` brings its own `FieldBlock`, which is why these are no longer `Field`s: the field
          now contains the button that opens the calendar, and `Field` renders a real `<label>` — which
          folds every named descendant into the box's accessible name and re-dispatches a stray click
          back into the box (Field.tsx sets out both traps).
        */}
        <DateField
          label="Started on"
          help="Leave it empty if the start date is not settled."
          value={value.startedOn}
          onChange={(startedOn) => update({ startedOn })}
        />

        <DateField
          label="Ended on"
          help="Leave it empty while the project is still running."
          error={datesOutOfOrder ? "The end date must be on or after the start date." : null}
          value={value.endedOn}
          onChange={(endedOn) => update({ endedOn })}
        />

        <FieldBlock
          label="Progress"
          className="sm:col-span-2"
          error={progressOutOfRange ? "Progress must be a whole number between 0 and 100." : null}
          help={
            <>
              How far along the work is, as a percentage.{" "}
              <strong className="font-semibold text-ink-700">Zero means not tracked</strong>: at 0 no bar
              is shown on the project&rsquo;s page at all, which is the right answer for a project whose
              progress nobody is measuring. Do not type 1 to mean &ldquo;just started&rdquo; unless you
              want a 1% bar on the site.
            </>
          }
        >
          <div className="flex flex-wrap items-center gap-4">
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              value={value.progress}
              onChange={(event) => update({ progress: event.target.value })}
              suffix="%"
              className="max-w-[9rem]"
            />
            <div className="min-w-[14rem] flex-1">
              {progressNumber > 0 ? (
                <ProgressBar
                  value={clamp(progressNumber, 0, 100)}
                  label="How the bar will look on the project's page"
                  hint="This is what a visitor sees."
                />
              ) : (
                <p className="text-xs leading-relaxed text-ink-500">
                  No bar will be shown on the project&rsquo;s page.
                </p>
              )}
            </div>
          </div>
        </FieldBlock>
      </FormSection>

      <FormSection
        title="Team"
        description="Everybody working on this project, in the order they should be listed. Only people who already have a profile can be chosen — add a profile first if somebody is missing."
      >
        <EntityPicker
          kind="person"
          label="People on this project"
          ids={memberIds}
          onChange={setMemberIds}
          max={MAX_TEAM}
          help="Search by name. Drag to reorder — the order here is the order on the project's page."
          footnote="Somebody whose profile is not published will not appear on the public page, even though they are listed here."
        />

        <TeamRoles members={value.members} onRoleChange={setMemberRole} />
      </FormSection>

      <FormSection
        title="Milestones"
        description="The stages of the work, in order. A milestone with a completion date is shown as done; one with only a due date is shown as still to come."
      >
        <RepeaterField<ProjectMilestoneValue>
          label="Milestones"
          items={value.milestones}
          onChange={(milestones) => update({ milestones })}
          max={MAX_MILESTONES}
          itemNoun="milestone"
          createItem={() => ({ title: "", detail: "", dueOn: "", completedOn: "" })}
          summary={(milestone) => milestone.title}
          isEmpty={(milestone) =>
            milestone.title.trim().length === 0 &&
            milestone.detail.trim().length === 0 &&
            milestone.dueOn.length === 0 &&
            milestone.completedOn.length === 0
          }
          help="A milestone with no title is left out when this is saved."
          renderItem={({ item, index, update: updateItem }) => (
            <>
              <Field label="What it is" required>
                <Input
                  value={item.title}
                  onChange={(event) => updateItem({ ...item, title: event.target.value })}
                  placeholder="Field survey of the Bagru workshops"
                />
              </Field>

              <Field label="A little more detail" help="Optional. One or two sentences.">
                <Textarea
                  value={item.detail}
                  onChange={(event) => updateItem({ ...item, detail: event.target.value })}
                  rows={2}
                />
              </Field>

              {/*
                The same two `YYYY-MM-DD` strings the milestone has always held — see the note beside
                "Started on" above for why nothing here parses them, and why the wrapper is
                `DateField`'s own `FieldBlock` rather than a `Field`.

                ⚠ The comparison below is still LEXICAL, on two fixed-width zero-padded days, which is
                the only reason it can be written as `<`. It goes on working because `DateField` emits
                exactly that shape or the empty string and never a half-typed value — the length guards
                either side already refuse the empty string.
              */}
              <div className="grid gap-4 sm:grid-cols-2">
                <DateField
                  label="Due on"
                  help="When it should be finished."
                  value={item.dueOn}
                  onChange={(dueOn) => updateItem({ ...item, dueOn })}
                />

                <DateField
                  label="Completed on"
                  help="Fill this in when it is done. Until then leave it empty."
                  error={
                    item.completedOn.length > 0 &&
                    item.dueOn.length > 0 &&
                    item.completedOn < item.dueOn
                      ? // Not an error, just worth seeing: finishing early is good news, and the site
                        // says so. Passed as `error` because that is the only inline slot a repeater row
                        // has, and the sentence makes clear nothing is wrong.
                        "Finished before it was due — nothing to fix, this is just what the site will say."
                      : null
                  }
                  value={item.completedOn}
                  onChange={(completedOn) => updateItem({ ...item, completedOn })}
                />
              </div>

              <p className="text-xs text-ink-500">Milestone {index + 1} on the project&rsquo;s page.</p>
            </>
          )}
        />
      </FormSection>

      <FormSection
        title="Pictures"
        description="The gallery on the project's page, in this order. Pictures come from the media library, so the same photograph can be used by several projects without being uploaded twice."
        actions={
          value.gallery.length < MAX_GALLERY ? (
            <Button variant="secondary" size="sm" icon={ImagePlus} onClick={() => setPicker("gallery")}>
              Add pictures
            </Button>
          ) : null
        }
      >
        <GalleryEditor
          items={value.gallery}
          onChange={(gallery) => update({ gallery })}
          max={MAX_GALLERY}
          onAdd={() => setPicker("gallery")}
        />
      </FormSection>

      <FormSection
        title="What this project has produced"
        description="Publications, downloadable files and the organisations working on it. Each of these is chosen from records that already exist."
      >
        <EntityPicker
          kind="publication"
          label="Publications from this project"
          ids={value.publicationIds}
          onChange={(publicationIds) => update({ publicationIds })}
          max={MAX_LINKED}
          help="Papers, chapters, datasets and patents that came out of this work. They are listed on the project's page and the project is named on each publication."
        />

        <EntityPicker
          kind="file"
          label="Files people can download"
          ids={value.fileIds}
          onChange={(fileIds) => update({ fileIds })}
          max={MAX_LINKED}
          help="Reports, datasets and slide decks from the file store. A file that is not marked public cannot be downloaded from the site, whatever is listed here."
        />

        <EntityPicker
          kind="partner"
          label="Partners"
          ids={value.partnerIds}
          onChange={(partnerIds) => update({ partnerIds })}
          max={MAX_LINKED}
          help="Institutions, funders and companies working on this project. Their logos appear on the project's page."
        />
      </FormSection>

      <FormSection
        title="Questions and answers"
        description="Shown at the foot of the project's page. Useful for the questions the team is asked repeatedly."
      >
        <RepeaterField<ProjectFaqValue>
          label="Questions and answers"
          items={value.faqs}
          onChange={(faqs) => update({ faqs })}
          max={MAX_FAQS}
          itemNoun="question"
          createItem={() => ({ question: "", answer: "" })}
          summary={(faq) => faq.question}
          isEmpty={(faq) => faq.question.trim().length === 0 && faq.answer.trim().length === 0}
          help="A question with no answer, or an answer with no question, is left out when this is saved."
          renderItem={({ item, update: updateItem }) => (
            <>
              <Field label="Question" required>
                <Input
                  value={item.question}
                  onChange={(event) => updateItem({ ...item, question: event.target.value })}
                  placeholder="Can the archive be used for teaching?"
                />
              </Field>
              <Field label="Answer" required>
                <Textarea
                  value={item.answer}
                  onChange={(event) => updateItem({ ...item, answer: event.target.value })}
                  rows={3}
                />
              </Field>
            </>
          )}
        />
      </FormSection>

      <FormSection
        title="Cover picture and placement"
        description="The cover is the picture at the top of the project's page and the one used when the page is shared."
      >
        <FieldBlock
          label="Cover picture"
          help="Landscape works best — anything roughly twice as wide as it is tall."
        >
          {value.cover ? (
            <div className="flex flex-wrap items-start gap-4">
              <MediaImage
                media={value.cover}
                alt=""
                aspect={16 / 9}
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

        <Switch
          checked={value.isFeatured}
          onCheckedChange={(isFeatured) => update({ isFeatured })}
          label="Feature this project"
          description="Featured projects can be pulled onto the homepage and other pages by a projects block. It does not change the project's own page."
        />

        <Field
          label="Position in the list"
          help="Projects are listed in this order, lowest number first, before falling back to their dates."
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
        description="Whether this project's page is on the public site. This is not the same as the stage above: a completed project can be published and an active one can be a draft."
      >
        <StatusControl
          value={{ status: value.status, publishedAt: value.publishedAt }}
          onChange={(next) => update({ status: next.status })}
          canPublish={canPublish}
          // Projects carry `status` and `publishedAt` only — there is nowhere to store a schedule.
          scheduling={false}
          publishBlockers={publishBlockers}
        />
      </FormSection>

      {canDelete && !isNew ? (
        <FormSection
          title="Delete this project"
          tone="danger"
          description="The people, publications, files, partners and photographs attached to it are not deleted — only their link to this project."
        >
          <DeleteButton
            name={saved.title.trim().length > 0 ? saved.title : "this project"}
            noun="project"
            onDelete={remove}
            onDeleted={() => router.push("/studio/projects")}
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
        saveLabel={isNew ? "Create project" : "Save"}
        subject="this project"
        note={
          isNew
            ? "Nothing is saved until you press Create. After that your changes are kept automatically every few seconds, until the project is published."
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
              ? "Add pictures to this project"
              : "Choose a cover picture"
        }
      />
    </div>
  );
}

/**
 * What each person does on the project.
 *
 * The names are resolved through the SAME lookup endpoint the picker above uses, rather than being
 * passed down from the server: one source for the strings, and a person added a moment ago shows their
 * name here without the page being reloaded. A row whose person cannot be resolved says so — a name
 * that silently disappeared from a list is indistinguishable from one nobody added (contract §1.6).
 */
function TeamRoles({
  members,
  onRoleChange
}: {
  members: readonly ProjectMemberValue[];
  onRoleChange: (personId: string, role: string) => void;
}) {
  const ids = useMemo(() => members.map((member) => member.personId), [members]);
  const resolved = useResource<LookupResponse>(lookupResolvePath("person", ids));

  const byId = useMemo(() => {
    const map = new Map<string, LookupItem>();
    for (const item of resolved.data?.items ?? []) map.set(item.id, item);
    return map;
  }, [resolved.data]);

  if (members.length === 0) return null;

  const settled = resolved.data !== null && !resolved.isLoading && resolved.error === null;

  return (
    <div className="min-w-0">
      <span className="field-label">What each person does</span>
      <p className="mt-1 text-xs leading-relaxed text-ink-500">
        Optional, and shown under each name on the project&rsquo;s page. Leave a row empty and only the
        name is shown. The order is the one set in the list above.
      </p>

      <ul className="mt-2 space-y-2">
        {members.map((member, index) => {
          const person = byId.get(member.personId);
          const missing = settled && person === undefined;
          const name = person?.title ?? null;

          return (
            <li
              key={member.personId}
              className={cn(
                "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border bg-card px-3 py-2",
                missing ? "border-amber-800/40 bg-amber-100" : "border-line-200"
              )}
            >
              <span className="shrink-0 text-xs tabular-nums text-ink-500">{index + 1}</span>

              <span className="min-w-[10rem] flex-1 text-sm text-ink-900">
                {name ??
                  (missing
                    ? "This person has been deleted, so this row will be ignored"
                    : "Looking up this person…")}
              </span>

              <Input
                value={member.role}
                onChange={(event) => onRoleChange(member.personId, event.target.value)}
                placeholder="Principal investigator"
                aria-label={`What ${name ?? `person ${index + 1}`} does on this project`}
                className="min-w-[12rem] flex-1"
              />
            </li>
          );
        })}
      </ul>

      {resolved.error !== null ? (
        <HelpText tone="error" className="mt-2">
          {resolved.error.message} The names cannot be listed until that is fixed — nothing has been
          lost, and the roles you have typed are still here.
        </HelpText>
      ) : null}
    </div>
  );
}

/**
 * The project's gallery.
 *
 * NOT a `RepeaterField`: a repeater's "Add" makes a blank row, and a gallery row with no picture in it
 * is not a thing that can exist — every row here starts life as a choice from the media library. What
 * it borrows from the repeater is the important half: reordering works from the keyboard as well as by
 * pointer, because "Move up" is the only route a keyboard or a screen reader has.
 */
function GalleryEditor({
  items,
  onChange,
  max,
  onAdd
}: {
  items: readonly ProjectGalleryValue[];
  onChange: (next: ProjectGalleryValue[]) => void;
  max: number;
  onAdd: () => void;
}) {
  const [announcement, setAnnouncement] = useState("");

  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return;
    const next = [...items];
    const moved = next[from];
    if (moved === undefined) return;
    next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
    setAnnouncement(`Moved from position ${from + 1} to position ${to + 1} of ${items.length}.`);
  };

  const removeAt = (index: number) => {
    const removed = items[index];
    onChange(items.filter((_unused, position) => position !== index));
    setAnnouncement(
      `${removed?.asset.fileName ?? "That picture"} taken out. ${items.length - 1} left.`
    );
  };

  const setCaption = (index: number, caption: string) => {
    onChange(items.map((entry, position) => (position === index ? { ...entry, caption } : entry)));
  };

  const missingDescriptions = items.filter((entry) => entry.asset.altText === null).length;

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="field-label">Pictures</span>
        {/* The cap is on screen from the first row, not sprung on the reader at the last (contract §1.6). */}
        <span
          className={cn(
            "text-xs tabular-nums",
            items.length >= max ? "text-amber-800" : "text-ink-500"
          )}
        >
          You can add up to {max}; {items.length} added.
        </span>
      </div>

      {/* Mounted in both states so the region is registered before its content ever changes. */}
      <span role="status" className="sr-only">
        {announcement}
      </span>

      {items.length === 0 ? (
        <div className="mt-2 rounded-md border border-dashed border-line-200 bg-surface-50 px-4 py-6 text-center">
          <p className="text-sm text-ink-500">
            No pictures yet. The project&rsquo;s page simply has no gallery until one is added.
          </p>
          <Button variant="secondary" size="sm" icon={ImagePlus} onClick={onAdd} className="mt-3">
            Add pictures
          </Button>
        </div>
      ) : (
        <ul className="mt-2 space-y-2">
          {items.map((entry, index) => (
            <li
              key={entry.asset.id}
              className="flex flex-wrap items-start gap-3 rounded-md border border-line-200 bg-card p-2"
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

              <div className="min-w-[14rem] flex-1 space-y-1.5">
                <p className="truncate text-xs text-ink-500">{entry.asset.fileName}</p>
                <Input
                  value={entry.caption}
                  onChange={(event) => setCaption(index, event.target.value)}
                  placeholder="Caption shown under the picture"
                  aria-label={`Caption for picture ${index + 1}`}
                />
                {entry.asset.altText === null ? (
                  <HelpText tone="warn">
                    No description, so a screen reader says nothing about this picture. A caption is not
                    the same thing — add a description in the media library.
                  </HelpText>
                ) : null}
              </div>

              <div className="flex shrink-0 items-center">
                {/*
                  `aria-disabled` and a no-op at the ends, never `disabled`: browsers blur a control the
                  moment it becomes disabled, so moving a picture to the top with the keyboard would
                  drop focus to the document body (RepeaterField.tsx, decision 2).
                */}
                <MoveButton
                  label={`Move picture ${index + 1} of ${items.length} up`}
                  unavailable={index === 0}
                  rotate
                  onClick={() => move(index, index - 1)}
                />
                <MoveButton
                  label={`Move picture ${index + 1} of ${items.length} down`}
                  unavailable={index === items.length - 1}
                  onClick={() => move(index, index + 1)}
                />
                <button
                  type="button"
                  onClick={() => removeAt(index)}
                  aria-label={`Take ${entry.asset.fileName} out of this gallery`}
                  className="inline-flex h-8 w-8 items-center justify-center rounded text-ink-500 transition hover:bg-error-100 hover:text-error-600 focus-visible:ring-2 focus-visible:ring-error-600/30"
                >
                  <X aria-hidden="true" className="h-4 w-4" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {missingDescriptions > 0 ? (
        <HelpText tone="warn" className="mt-2">
          {missingDescriptions === 1
            ? "One of these pictures has no description"
            : `${missingDescriptions} of these pictures have no description`}
          , so somebody using a screen reader is told nothing about{" "}
          {missingDescriptions === 1 ? "it" : "them"}. Descriptions are written once, in the media
          library, and are then used everywhere the picture appears.
        </HelpText>
      ) : null}

      {items.length >= max ? (
        <HelpText tone="warn" className="mt-2">
          That is the most this gallery holds. Take one out before adding another.
        </HelpText>
      ) : null}
    </div>
  );
}

/** One end-of-list-aware move button. See the note at its only call site. */
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
