"use client";

/**
 * EmbedForm — a video, from wherever it lives, or any other page in a frame.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE DESCRIPTION IS THE ONE MANDATORY FIELD IN THE WHOLE SECTION MODEL, AND IT IS AN ACCESSIBILITY
 * RULE RATHER THAN AN EDITORIAL PREFERENCE.
 *
 * A screen reader announces an untitled `<iframe>` as "frame", and an untitled `<video>` as "video",
 * which tells a reader nothing about whether to spend four minutes on it. `embedSectionSchema` is
 * therefore one of the three schemas in `lib/sections/schema.ts` that carry a `superRefine`, and is a
 * `ZodEffects` rather than a `ZodObject` — which is why the field descriptions below are reached
 * through `.innerType()`.
 *
 * The requirement binds ONLY once there is something to describe — an address for the four hosted
 * providers, a chosen film for `upload` — so a block that has just been dropped onto a page still
 * saves (contract §10 — a field may only be mandatory where it is answerable). The form mirrors that
 * exactly: the field is marked required, and shows the schema's own message, at the moment there is
 * something to name and not before.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE MESSAGE IS THE SCHEMA'S, READ BACK BY RUNNING IT. Writing a second sentence here would give the
 * studio two explanations of one rule, and the one on screen would be the one nobody updated.
 *
 * THE ADDRESS IS RESOLVED WHILE IT IS BEING TYPED, through the very function the page will use
 * (`resolveEmbedTarget`). So an editor who pastes a channel URL, a playlist, or a Drive FOLDER — the
 * three shapes that look right and cannot be embedded — is told here, rather than by publishing the
 * page and finding a dashed box on it. Two copies of that verdict would disagree the first time
 * either learned about a URL shape, which is why there is one and it lives in lib/media/video.ts.
 */

import { useMemo } from "react";

import { useResource } from "@/lib/client/useResource";
import {
  EMBED_PROVIDER_NAMES,
  EMBED_PROVIDER_PATTERNS,
  isVideoObjectKey,
  resolveEmbedTarget,
  type EmbedProvider
} from "@/lib/media/video";
import { embedSectionSchema, type EmbedSectionData } from "@/lib/sections/schema";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import {
  EntityPicker,
  lookupResolvePath,
  type LookupItem,
  type LookupResponse
} from "@/components/studio/fields/EntityPicker";
import { VideoSettingsFields } from "@/components/studio/fields/VideoSettingsFields";
import { HelpText } from "@/components/studio/HelpText";
import type { SectionFormProps } from "@/components/studio/sections";

/** `.innerType()` because this schema is a `ZodEffects` — see the header and the schema's own note. */
const SHAPE = embedSectionSchema.innerType().shape;

/**
 * The provider list, in the order an editor is most likely to want it.
 *
 * ⚠ `upload` IS FIRST BECAUSE IT IS THE ONLY ONE THIS SITE CONTROLS, and every other choice hands a
 * reader's address to somebody else the moment they press play. It is also the only one whose player
 * settings do anything, which the panel at the bottom of this form states for itself.
 */
const PROVIDER_OPTIONS: readonly { value: EmbedProvider; label: string }[] = [
  { value: "upload", label: "A film uploaded here (up to 200 MB)" },
  { value: "youtube", label: "YouTube" },
  { value: "vimeo", label: "Vimeo" },
  { value: "drive", label: "Google Drive" },
  { value: "iframe", label: "Somewhere else, in a frame" }
];

/**
 * The address patterns, read by an arbitrary string rather than by the enum.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS IS NOT DEFENSIVE PADDING. IT IS THE ONE THING BETWEEN AN UNKNOWN PROVIDER AND A CRASHED
 * PAGE BUILDER, and the widening is what makes the COMPILER admit the miss is possible.
 *
 * `EMBED_PROVIDER_PATTERNS` in lib/media/video.ts is keyed on `EmbedProvider`, so TypeScript believes
 * `EMBED_PROVIDER_PATTERNS[data.provider]` always hits. It does not, on the builder's RECOVERY path —
 * traced end to end rather than assumed:
 *
 *   • `provider` is `z.enum(EMBED_PROVIDERS).default("youtube")` in lib/sections/schema.ts with NO
 *     `.catch()`, so a stored `"wistia"` — written by a newer deployment and read after a rollback, or
 *     arriving by import — fails the parse of the whole EMBED payload on its own. No other field need
 *     be wrong.
 *   • `normaliseSection` in components/studio/builder/PageBuilder.tsx then falls back to
 *     `repairSectionData`, which is `{ ...defaults, ...raw }` — a deliberately SHALLOW merge that DOES
 *     NOT PARSE. `raw.provider` therefore overwrites the default and survives verbatim. That fallback
 *     is right for what it is for: the editor has to SEE the wrong value in order to correct it.
 *   • `SectionEditorPanel` hands that working copy straight to this form — `data={value as …}`, and its
 *     `value` prop says "THE BUILDER'S RAW WORKING COPY, NOT A FRESHLY PARSED VALUE" in as many words.
 *
 * So `data.provider` really is `"wistia"` here. The old narrow read then made `pattern !== null` TRUE,
 * because `undefined !== null`, and the next line threw `TypeError: Cannot read properties of undefined
 * (reading 'test')` — a client render error inside the page builder, which is a white screen with an
 * editor's unsaved work behind it. The identical crash was fixed in StatsForm.tsx first; this is its
 * sibling, found by grepping for the pattern rather than by waiting for it to happen twice.
 *
 * An unknown provider must mean "there is no pattern to check this address against" — the same answer
 * `iframe` already gives, and the same direction `definitionFor()` takes in StatsForm and `.catch("")`
 * takes in the schema. This release cannot say what such an address should look like, so it says nothing
 * rather than guessing.
 *
 * ⚠ THE ANNOTATION IN lib/media/video.ts IS UNCHANGED AND MUST STAY. This alias loosens no check: the
 * table there is still keyed on the enum, so forgetting an entry for a provider added to the schema is
 * still a compile error at its declaration. Reading through `Partial<Record<string, …>>` only makes the
 * RESULT `| undefined`, which is what forces the `?? null` below to exist — delete it and `tsc` fails
 * with "possibly 'undefined'". That is the whole reason this is a widened alias rather than a bare
 * `?? null` on the narrow read: a bare one would be invisible to the type system, leaving a comment as
 * the only thing standing between a future tidy-up and the crash again.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const PATTERN_FOR_PROVIDER: Partial<Record<string, RegExp | null>> = EMBED_PROVIDER_PATTERNS;

/**
 * The same widening for the provider's NAME.
 *
 * ⚠ IT USED TO BE A NARROW READ KEPT OFF THE CRASH PATH BY A COMMENT, and the comment was right about
 * today and could not be right about tomorrow. The mismatch notice below is still gated on a pattern
 * having been FOUND — so an unknown provider, which has no pattern, still cannot reach it — but the
 * sentence about what a provider can and cannot do is NOT gated that way, and a narrow read there would
 * be `undefined` interpolated into a sentence at best and the fourth instance of this repository's
 * signature crash at worst. One widened lookup covers both readers.
 */
const NAME_FOR_PROVIDER: Partial<Record<string, string>> = EMBED_PROVIDER_NAMES;

/** A response is a cast, not a proof — the same guard `MediaSplitForm` makes on the same shape. */
function firstItem(response: LookupResponse | null): LookupItem | null {
  if (response === null || !Array.isArray(response.items)) return null;
  return response.items[0] ?? null;
}

export function EmbedForm({ data, onChange, onDirty }: SectionFormProps<EmbedSectionData>) {
  const update = (patch: Partial<EmbedSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  const isUpload = data.provider === "upload";
  const hasUrl = data.url.trim().length > 0;
  const hasMedia = data.mediaId.trim().length > 0;
  /** What the schema's conditional requirement is actually gated on. See the header. */
  const hasSomething = hasUrl || hasMedia;

  /**
   * The schema's verdict on this exact payload, so the message under the field is the message the save
   * would give. Only asked for when there is something to complain about.
   */
  const titleProblem = useMemo(() => {
    if (!hasSomething || data.title.trim().length > 0) return null;
    const result = embedSectionSchema.safeParse(data);
    if (result.success) return null;
    return result.error.issues.find((issue) => issue.path[0] === "title")?.message ?? null;
  }, [data, hasSomething]);

  /**
   * ⚠ `?? null` IS LOAD-BEARING AND THE COMPILER NOW ENFORCES IT — see `PATTERN_FOR_PROVIDER`. An unknown
   * provider has no pattern, and "no pattern" is spelled `null` in this file; leaving it as `undefined`
   * would satisfy the `!== null` below and take the whole builder down on `.test`.
   */
  const pattern = PATTERN_FOR_PROVIDER[data.provider] ?? null;
  const mismatched = !isUpload && hasUrl && pattern !== null && !pattern.test(data.url);

  /**
   * Could the page actually make an address out of this? Asked of the page's own resolver.
   *
   * Only when the pattern is happy, so an editor who has pasted a Vimeo link into a YouTube block gets
   * ONE message about the one mistake rather than two about the same one.
   *
   * The two halves are split on whether this provider HAS a shape at all, because the advice differs
   * and a wrong-but-plausible sentence is worse than none: on a named service the address is almost
   * always a channel, a playlist or a folder, and on a plain frame it is almost always a site path or
   * a typed address that is not a whole URL.
   */
  const unreadable =
    !isUpload && hasUrl && !mismatched && resolveEmbedTarget(data.provider, data.url) === null;
  const unreadableOnService = unreadable && pattern !== null;
  const unreadablePlain = unreadable && pattern === null;

  const providerName = NAME_FOR_PROVIDER[data.provider] ?? "that service";

  /**
   * The chosen file, looked up so the form can say whether it is actually a film.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * ⚠ THE PICKER CANNOT NARROW ITSELF, AND THAT IS A FACT ABOUT THE LOOKUP ROUTE RATHER THAN A GAP
   * HERE. `EntityPicker`'s `kind` is a TABLE — `media` — and `/api/studio/lookup` has no `MediaKind`
   * filter at all, so the panel lists every asset of every kind whatever this block wants. An editor
   * choosing a photograph for a field labelled "The film" gets no complaint from the picker, and the
   * page then draws a `<video>` whose source is a JPEG: a black box with a play button that does
   * nothing, and nothing anywhere saying why.
   *
   * So the form asks. One further small authenticated read per chosen file, for the same reason
   * `MediaSplitForm` and `DocumentEmbedForm` each make one — and, like theirs, it is suspended while
   * nothing is chosen (`lookupResolvePath` answers null for an empty list, and `useResource` treats
   * null as "do not ask").
   *
   * ⚠ THE DIRECTION OF THE "YET" IS DELIBERATE. While the lookup is in flight, and for a file that
   * has since been deleted, `chosenKey` is empty and no complaint is shown: a warning that flickers
   * onto the screen every time a block is opened would be worse than one that arrives a moment late.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  const filmLookup = useResource<LookupResponse>(
    lookupResolvePath("media", isUpload && hasMedia ? [data.mediaId] : [])
  );
  const chosenKey = firstItem(filmLookup.data)?.media?.objectKey ?? "";
  const chosenIsNotFilm = chosenKey.length > 0 && !isVideoObjectKey(chosenKey);

  return (
    <div className="space-y-5">
      <Field label="Where the video is" help={SHAPE.provider.description}>
        <Select
          value={data.provider}
          options={PROVIDER_OPTIONS}
          onChange={(event) =>
            update({ provider: event.target.value as EmbedSectionData["provider"] })
          }
        />
      </Field>

      {isUpload ? (
        <>
          <EntityPicker
            kind="media"
            max={1}
            label="The film"
            help={SHAPE.mediaId.description}
            ids={hasMedia ? [data.mediaId] : []}
            onChange={(ids) => update({ mediaId: ids[0] ?? "" })}
            upload
            uploadMediaKind="VIDEO"
          />

          {!hasMedia ? (
            <HelpText tone="warn">
              Without a film this block draws a line saying so and nothing else. Choose one above, or
              switch to YouTube, Vimeo or Google Drive if it is too large to upload.
            </HelpText>
          ) : null}

          {chosenIsNotFilm ? (
            <HelpText tone="warn">
              That file is not a video, so the page would draw a player with nothing to play. Choose an
              MP4, WebM or QuickTime file — or, if you meant to show a picture, use the “Image beside
              text” block instead.
            </HelpText>
          ) : null}
        </>
      ) : (
        <>
          <Field label="The address" help={SHAPE.url.description} maxLength={500} value={data.url}>
            <Input
              value={data.url}
              onChange={(event) => update({ url: event.target.value })}
              placeholder="https://www.youtube.com/watch?v=…"
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              className="font-mono text-xs"
            />
          </Field>

          {mismatched ? (
            <HelpText tone="warn">
              That does not look like an address on {providerName}. Either correct the line above, or
              choose “Somewhere else, in a frame”.
            </HelpText>
          ) : null}

          {unreadableOnService ? (
            <HelpText tone="warn">
              That address is on {providerName} but does not point at one thing that can be shown. A
              channel, a playlist and a Drive folder all look like this and none of them can be
              embedded — paste the link to the single video or file instead.
            </HelpText>
          ) : null}

          {unreadablePlain ? (
            <HelpText tone="warn">
              A frame needs a whole web address beginning with https://. A path on this site cannot be
              framed — link to it instead.
            </HelpText>
          ) : null}

          {data.provider === "drive" ? (
            <HelpText>
              The file has to be shared as “Anyone with the link”, or readers will see Google’s sign-in
              page instead of the film. Nothing here can check that from this side.
            </HelpText>
          ) : null}
        </>
      )}

      <Field
        label="What this embed contains"
        help={SHAPE.title.description}
        // Required only once there is something to describe. See the header.
        required={hasSomething}
        error={titleProblem}
        maxLength={160}
        value={data.title}
      >
        <Textarea
          rows={2}
          value={data.title}
          onChange={(event) => update({ title: event.target.value })}
          placeholder="A five-minute film of the Bagru block-printing workshop, recorded in March 2026."
        />
      </Field>

      <Field
        label="The shape of the frame"
        help={
          isUpload
            ? // The uploaded branch is not a frame at all — `VideoPlayer` lets the film size itself, so
              // this only caps the width. Said here rather than in the schema's `.describe()`, which one
              // sentence has to serve both branches.
              "How wide the film may be. An uploaded film keeps its own proportions, so this never puts black bars around it — it only stops an upright recording filling three screens."
            : SHAPE.aspectRatio.description
        }
      >
        <Select
          value={data.aspectRatio}
          options={[
            { value: "16:9", label: "Widescreen (16:9) — most video" },
            { value: "4:3", label: "Older video (4:3)" },
            { value: "1:1", label: "Square (1:1)" },
            { value: "9:16", label: "Upright (9:16) — video shot on a phone" }
          ]}
          onChange={(event) =>
            update({ aspectRatio: event.target.value as EmbedSectionData["aspectRatio"] })
          }
        />
      </Field>

      <Field label="Caption" help={SHAPE.caption.description} maxLength={240} value={data.caption}>
        <Input value={data.caption} onChange={(event) => update({ caption: event.target.value })} />
      </Field>

      <VideoSettingsFields
        provider={data.provider}
        value={data.videoSettings}
        onChange={(next) => update({ videoSettings: next })}
        onDirty={onDirty}
      />

      {data.provider === "iframe" && hasUrl ? (
        <HelpText tone="warn">
          A frame loads the other site as soon as a reader presses play, and nothing here can make it
          faster or stop it setting its own cookies. Use YouTube, Vimeo or Google Drive where you can —
          those are at least loaded only when a reader asks.
        </HelpText>
      ) : null}
    </div>
  );
}
