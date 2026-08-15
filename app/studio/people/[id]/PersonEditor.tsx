"use client";

/**
 * The person editor.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * TWO SEPARATE SWITCHES DECIDE WHERE SOMEBODY APPEARS, AND THE SCREEN EXPLAINS BOTH.
 *
 *   • PUBLICATION decides whether the profile page exists on the public site at all.
 *   • "SHOW IN THE PEOPLE LISTS" decides whether they are listed on /people.
 *
 * The combination that needs the explanation is published-but-not-listed: a visiting researcher whose
 * page is linked from a project, or an alumnus somebody's paper still cites, without either of them
 * appearing in the current roster. Without the sentence beside it an editor turns the switch off,
 * cannot find the profile in the listing and concludes it is broken.
 *
 * THERE ARE TWO BIOGRAPHY FIELDS BECAUSE THE SITE USES TWO. The short one is the paragraph a card and a
 * search result show; the long one is the page itself. Neither is generated from the other — a card
 * built from the first paragraph of a long biography reads as a sentence cut in half.
 *
 * AUTOSAVE STOPS FOR ANYTHING PUBLIC, IN BOTH DIRECTIONS — see `useAutosave`'s header.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ContentStatus, PersonKind } from "@prisma/client";
import { ImagePlus, Trash2 } from "lucide-react";

import { del, patch, post } from "@/lib/client/fetcher";
import { unique } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Field, FieldBlock } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { MediaImage } from "@/components/ui/MediaImage";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/ToastProvider";
import { PERSON_KIND_GROUPS, PERSON_KIND_ORDER } from "@/components/site/PersonCard";
import { DeleteButton } from "@/components/studio/DeleteButton";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";
import { SaveBar } from "@/components/studio/SaveBar";
import { SlugField } from "@/components/studio/SlugField";
import { StatusControl, statusProblems } from "@/components/studio/StatusControl";
import { PUBLISHED_AUTOSAVE_NOTICE, useAutosave } from "@/components/studio/useAutosave";
import { useLeaveGuard } from "@/components/studio/useUnsavedChanges";
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
  variants: { label: string; format: string; objectKey: string; width: number }[];
}

export interface PersonFormValue {
  name: string;
  slug: string;
  kind: PersonKind;
  designation: string;
  department: string;
  /** The short biography: one paragraph, used on cards and in search results. */
  bio: string;
  /** The full biography as a rich-text document. */
  bioRich: unknown;
  /** Research interests, one per line or comma-separated. */
  interestsText: string;
  email: string;
  phone: string;
  website: string;
  linkedin: string;
  googleScholar: string;
  orcid: string;
  github: string;
  photo: EditorMedia | null;
  startedOn: string;
  endedOn: string;
  sortOrder: string;
  isVisible: boolean;
  status: ContentStatus;
  publishedAt: string | null;
  /**
   * Send the old address to the new one when a published address changes. Defaults to true — the
   * `Redirect` table exists so that moving a page never has to break an existing link (schema), and a
   * person's page is linked from projects, publications and other institutions' pages. The server
   * ignores it unless the address actually changed on a record that is public.
   */
  createRedirect: boolean;
}

export interface PersonEditorProps {
  personId: string | null;
  initialValue: PersonFormValue;
  siteUrl: string;
  storageReady: boolean;
  canPublish: boolean;
  canDelete: boolean;
}

const ENDPOINT = {
  collection: "/api/studio/people",
  detail: (id: string) => `/api/studio/people/${encodeURIComponent(id)}`
} as const;

const NAME_MAX = 120;
const BIO_MAX = 600;

/** ORCID is always 16 digits in four groups, with an X allowed as the final check character. */
const ORCID_SHAPE = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

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
    variants: asset.variants ?? []
  };
}

function toPayload(value: PersonFormValue) {
  return {
    name: value.name.trim(),
    slug: value.slug.trim(),
    kind: value.kind,
    designation: orNull(value.designation),
    department: orNull(value.department),
    bio: orNull(value.bio),
    bioRich: value.bioRich ?? null,
    researchInterests: parseList(value.interestsText),
    email: orNull(value.email),
    phone: orNull(value.phone),
    website: orNull(value.website),
    linkedin: orNull(value.linkedin),
    googleScholar: orNull(value.googleScholar),
    orcid: orNull(value.orcid),
    github: orNull(value.github),
    photoId: value.photo?.id ?? null,
    startedOn: orNull(value.startedOn),
    endedOn: orNull(value.endedOn),
    sortOrder: toIntOrZero(value.sortOrder),
    isVisible: value.isVisible,
    status: value.status,
    createRedirect: value.createRedirect
  };
}

export function PersonEditor({
  personId,
  initialValue,
  siteUrl,
  storageReady,
  canPublish,
  canDelete
}: PersonEditorProps) {
  const router = useRouter();
  const { toast } = useToast();

  const [value, setValue] = useState<PersonFormValue>(initialValue);
  const [saved, setSaved] = useState<PersonFormValue>(initialValue);
  const [picker, setPicker] = useState<"photo" | "body" | null>(null);
  const bodyResolver = useRef<((selection: EditorMediaSelection | null) => void) | null>(null);
  const createdId = useRef<string | null>(null);

  const isNew = personId === null;

  const update = useCallback(
    (next: Partial<PersonFormValue>) => setValue((current) => ({ ...current, ...next })),
    []
  );

  const isLiveOrGoingLive =
    saved.status === "PUBLISHED" ||
    saved.status === "SCHEDULED" ||
    value.status === "PUBLISHED" ||
    value.status === "SCHEDULED";

  const save = useCallback(
    async (next: PersonFormValue) => {
      if (personId === null) {
        const created = await post<{ id: string }>(ENDPOINT.collection, toPayload(next));
        createdId.current = created.id;
        return;
      }
      await patch(ENDPOINT.detail(personId), toPayload(next));
    },
    [personId]
  );

  const autosave = useAutosave<PersonFormValue>({
    data: value,
    save,
    isPublished: isLiveOrGoingLive,
    enabled: !isNew,
    onSaved: (sent) => {
      setSaved(sent);
      const fresh = createdId.current;
      if (fresh !== null) {
        createdId.current = null;
        toast({ tone: "success", title: "The profile has been created" });
        router.replace(`/studio/people/${fresh}`);
        return;
      }
      router.refresh();
    }
  });

  useLeaveGuard(autosave.isDirty);

  const interests = useMemo(() => parseList(value.interestsText), [value.interestsText]);

  const datesOutOfOrder =
    value.startedOn.length > 0 && value.endedOn.length > 0 && value.endedOn < value.startedOn;

  const orcidLooksWrong =
    value.orcid.trim().length > 0 && !ORCID_SHAPE.test(value.orcid.trim().toUpperCase());

  const saveBlockers = useMemo(() => {
    const problems: string[] = [];
    if (value.name.trim().length === 0) problems.push("The name is empty.");
    if (value.slug.trim().length === 0) problems.push("The web address is empty.");
    if (datesOutOfOrder) problems.push("The leaving date is before the joining date.");
    problems.push(...statusProblems(value, false));
    return problems;
  }, [value, datesOutOfOrder]);

  const publishBlockers = useMemo(() => {
    const problems: string[] = [];
    if (value.name.trim().length === 0) problems.push("The profile has no name.");
    if (value.slug.trim().length === 0) problems.push("The profile has no web address.");
    if (datesOutOfOrder) problems.push("The leaving date is before the joining date.");
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
      } else if (first) {
        update({ photo: toEditorMedia(first) });
      }
      setPicker(null);
    },
    [picker, settleBody, update]
  );

  const remove = useCallback(async () => {
    if (personId === null) return;
    await del(ENDPOINT.detail(personId));
  }, [personId]);

  return (
    <div className="mt-6 space-y-5">
      <FormSection
        title="Name and group"
        description="The group decides which heading this person appears under on the people page."
      >
        <Field
          label="Full name"
          required
          maxLength={NAME_MAX}
          value={value.name}
          help="As they would like to be credited, including any title they use in print."
        >
          <Input
            value={value.name}
            onChange={(event) => update({ name: event.target.value })}
            placeholder="Dr Anita Sharma"
          />
        </Field>

        <Field
          label="Group"
          required
          help="Somebody who has left the Centre usually moves to Alumni rather than being deleted — the record and every link to it survive."
        >
          <Select
            value={value.kind}
            options={PERSON_KIND_ORDER.map((kind) => ({
              value: kind,
              label: PERSON_KIND_GROUPS[kind]
            }))}
            onChange={(event) => update({ kind: event.target.value as PersonKind })}
          />
        </Field>

        <SlugField
          value={value.slug}
          onChange={(slug) => update({ slug })}
          source={value.name}
          basePath="/people/"
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

      <FormSection title="Role at the Centre" columns={2}>
        <Field label="Job title" help="“Professor”, “Senior scientist”, “Research assistant”.">
          <Input
            value={value.designation}
            onChange={(event) => update({ designation: event.target.value })}
          />
        </Field>

        <Field label="Department or unit" help="Optional. Shown under the job title.">
          <Input
            value={value.department}
            onChange={(event) => update({ department: event.target.value })}
          />
        </Field>

        <Field
          label="Joined on"
          help="Optional. Only the year is shown on the site."
        >
          <Input
            type="date"
            value={value.startedOn}
            onChange={(event) => update({ startedOn: event.target.value })}
          />
        </Field>

        <Field
          label="Left on"
          help="Leave this empty for anybody still at the Centre. An alumnus keeps their years."
          error={datesOutOfOrder ? "The leaving date must be on or after the joining date." : null}
        >
          <Input
            type="date"
            value={value.endedOn}
            onChange={(event) => update({ endedOn: event.target.value })}
          />
        </Field>
      </FormSection>

      <FormSection
        title="Photograph"
        description="A head-and-shoulders portrait. Portraits are shown taller than they are wide, so a photograph with room above the head crops best."
      >
        <FieldBlock label="Photograph">
          {value.photo ? (
            <div className="flex flex-wrap items-start gap-4">
              <MediaImage
                media={value.photo}
                // Decorative here: the name is on the same screen. On the public site the photograph
                // carries the description written in the media library.
                alt=""
                aspect={4 / 5}
                rounded="md"
                sizes="160px"
                className="w-40 shrink-0"
              />
              <div className="min-w-0 flex-1 space-y-2">
                <p className="truncate text-sm text-ink-700">{value.photo.fileName}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={ImagePlus}
                    onClick={() => setPicker("photo")}
                  >
                    Choose a different photograph
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Trash2}
                    onClick={() => update({ photo: null })}
                  >
                    Remove the photograph
                  </Button>
                </div>
                {value.photo.altText === null ? (
                  <HelpText tone="warn">
                    This photograph has no description, so somebody using a screen reader is told nothing
                    about it. For a portrait, the person&rsquo;s name and role is usually the right
                    sentence. Add it in the media library.
                  </HelpText>
                ) : null}
              </div>
            </div>
          ) : (
            <Button variant="secondary" icon={ImagePlus} onClick={() => setPicker("photo")}>
              Choose a photograph
            </Button>
          )}
        </FieldBlock>
      </FormSection>

      <FormSection
        title="Biography"
        description="Two fields, because the site uses two. Fill in the short one at least — it is what appears anywhere this person is listed."
      >
        <Field
          label="Short biography"
          maxLength={BIO_MAX}
          value={value.bio}
          help="One paragraph, shown on cards, in search results and when this page is shared. Written in the third person."
        >
          <Textarea
            value={value.bio}
            onChange={(event) => update({ bio: event.target.value })}
            rows={4}
          />
        </Field>

        <FieldBlock
          label="Full biography"
          help="The text on this person's own page. Headings, lists, quotations and pictures are all available; press “/” on an empty line for the full list. Leave it empty and the page shows the short biography on its own."
        >
          <RichTextEditor
            value={value.bioRich}
            onChange={(bioRich) => update({ bioRich })}
            label="Full biography"
            placeholder="Career, qualifications, current work and anything else worth saying at length."
            onRequestMedia={requestBodyMedia}
          />
        </FieldBlock>

        <FieldBlock
          label="Research interests"
          help="One per line, or separated by commas. They are shown as small chips on the profile and are searched by the site's search box."
        >
          <Textarea
            value={value.interestsText}
            onChange={(event) => update({ interestsText: event.target.value })}
            rows={3}
            placeholder={"natural dyes\nheritage documentation\ncomputer vision"}
          />

          {interests.length > 0 ? (
            <>
              <p className="mt-2 text-xs text-ink-500">
                {interests.length === 1
                  ? "This will be stored as one interest:"
                  : `This will be stored as ${interests.length} interests:`}
              </p>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {interests.map((interest) => (
                  <li
                    key={interest}
                    className="rounded-full border border-line-200 bg-surface-100 px-2.5 py-0.5 text-xs text-ink-700"
                  >
                    {interest}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </FieldBlock>
      </FormSection>

      <FormSection
        title="How to reach them, and where else they are"
        description="Everything here is optional, and everything here is public. Ask before publishing a direct telephone number."
        columns={2}
      >
        <Field label="Email address" help="Shown as a link on the profile page.">
          <Input
            type="email"
            value={value.email}
            onChange={(event) => update({ email: event.target.value })}
            spellCheck={false}
            placeholder="anita.sharma@example.ac.in"
          />
        </Field>

        <Field label="Telephone" help="Include the country code if it should work from abroad.">
          <Input
            type="tel"
            value={value.phone}
            onChange={(event) => update({ phone: event.target.value })}
            spellCheck={false}
          />
        </Field>

        <Field label="Personal website" help="A full address beginning with https://.">
          <Input
            type="url"
            value={value.website}
            onChange={(event) => update({ website: event.target.value })}
            spellCheck={false}
            placeholder="https://"
            className="font-mono text-xs"
          />
        </Field>

        <Field label="LinkedIn" help="The full address of their profile.">
          <Input
            type="url"
            value={value.linkedin}
            onChange={(event) => update({ linkedin: event.target.value })}
            spellCheck={false}
            placeholder="https://www.linkedin.com/in/…"
            className="font-mono text-xs"
          />
        </Field>

        <Field label="Google Scholar" help="The full address of their Scholar profile.">
          <Input
            type="url"
            value={value.googleScholar}
            onChange={(event) => update({ googleScholar: event.target.value })}
            spellCheck={false}
            placeholder="https://scholar.google.com/citations?user=…"
            className="font-mono text-xs"
          />
        </Field>

        <Field label="GitHub" help="Their username, or the full address of their account.">
          <Input
            value={value.github}
            onChange={(event) => update({ github: event.target.value })}
            spellCheck={false}
            className="font-mono text-xs"
          />
        </Field>

        <Field
          label="ORCID"
          className="sm:col-span-2"
          help="The 16-digit identifier, as printed: 0000-0002-1825-0097. It is how a reader tells two researchers with the same name apart, so the grouping matters."
          error={
            orcidLooksWrong
              ? "An ORCID is 16 characters in four groups of four, separated by hyphens — the last one may end in an X."
              : null
          }
        >
          <Input
            value={value.orcid}
            onChange={(event) => update({ orcid: event.target.value })}
            spellCheck={false}
            placeholder="0000-0002-1825-0097"
            className="max-w-[16rem] font-mono text-xs"
          />
        </Field>
      </FormSection>

      <FormSection
        title="Where this profile appears"
        description="These two switches do different things, and the difference matters."
      >
        <StatusControl
          value={{ status: value.status, publishedAt: value.publishedAt }}
          onChange={(next) => update({ status: next.status })}
          canPublish={canPublish}
          // People carry `status` and `publishedAt` only — there is nowhere to store a schedule.
          scheduling={false}
          publishBlockers={publishBlockers}
        />

        <Switch
          checked={value.isVisible}
          onCheckedChange={(isVisible) => update({ isVisible })}
          label="Show in the people lists"
          description="Turn this off and the profile page still exists and can still be linked from a project or a publication — it simply does not appear on the people page. That is what you want for a visitor or an alumnus who should stay reachable without being in the current roster."
        />

        <Field
          label="Position in their group"
          help="People are listed in this order within their group, lowest number first, before falling back to alphabetical order. It is usually easier to drag names on the people screen than to type numbers here."
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

      {canDelete && !isNew ? (
        <FormSection
          title="Delete this profile"
          tone="danger"
          description="Projects and publications this person is named on are not deleted, and no printed author line changes — that credit is a separate field and never comes from a profile. If they have simply left, changing their group to Alumni keeps the record."
        >
          <DeleteButton
            name={saved.name.trim().length > 0 ? saved.name : "this profile"}
            noun="profile"
            onDelete={remove}
            onDeleted={() => router.push("/studio/people")}
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
        saveLabel={isNew ? "Create profile" : "Save"}
        subject="this profile"
        note={
          isNew
            ? "Nothing is saved until you press Create. After that your changes are kept automatically every few seconds, until the profile is published."
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
        title={picker === "body" ? "Insert a picture" : "Choose a photograph"}
      />
    </div>
  );
}
