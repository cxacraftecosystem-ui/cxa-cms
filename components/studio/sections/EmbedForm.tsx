"use client";

/**
 * EmbedForm — a video, or any other page in a frame.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE DESCRIPTION IS THE ONE MANDATORY FIELD IN THE WHOLE SECTION MODEL, AND IT IS AN ACCESSIBILITY
 * RULE RATHER THAN AN EDITORIAL PREFERENCE.
 *
 * A screen reader announces an untitled `<iframe>` as "frame", which tells a reader nothing about
 * whether to enter it. `embedSectionSchema` is therefore the only schema in `lib/sections/schema.ts` that
 * carries a `superRefine`, and the only one that is a `ZodEffects` rather than a `ZodObject` — which is
 * why the field descriptions below are reached through `.innerType()`.
 *
 * The requirement binds ONLY once there is an address, so a block that has just been dropped onto a page
 * still saves (contract §10 — a field may only be mandatory where it is answerable). The form mirrors
 * that exactly: the field is marked required, and shows the schema's own message, at the moment the
 * address appears and not before.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE MESSAGE IS THE SCHEMA'S, READ BACK BY RUNNING IT. Writing a second sentence here would give the
 * studio two explanations of one rule, and the one on screen would be the one nobody updated.
 */

import { useMemo } from "react";

import { embedSectionSchema, type EmbedSectionData } from "@/lib/sections/schema";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { HelpText } from "@/components/studio/HelpText";
import type { SectionFormProps } from "@/components/studio/sections";

/** `.innerType()` because this schema is a `ZodEffects` — see the header and the schema's own note. */
const SHAPE = embedSectionSchema.innerType().shape;

/** What each provider's address normally looks like. A hint, never a refusal. */
const PROVIDER_PATTERNS: Record<EmbedSectionData["provider"], RegExp | null> = {
  youtube: /(?:youtube\.com|youtu\.be)/i,
  vimeo: /vimeo\.com/i,
  iframe: null
};

/**
 * The same table, read by an arbitrary string rather than by the enum.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS IS NOT DEFENSIVE PADDING. IT IS THE ONE THING BETWEEN AN UNKNOWN PROVIDER AND A CRASHED
 * PAGE BUILDER, and the widening is what makes the COMPILER admit the miss is possible.
 *
 * `PROVIDER_PATTERNS` above is keyed on `EmbedSectionData["provider"]`, so TypeScript believes
 * `PROVIDER_PATTERNS[data.provider]` always hits. It does not, on the builder's RECOVERY path — traced
 * end to end rather than assumed:
 *
 *   • `provider` is `z.enum([…]).default("youtube")` in lib/sections/schema.ts with NO `.catch()`, so a
 *     stored `"wistia"` — written by a newer deployment and read after a rollback, or arriving by
 *     import — fails the parse of the whole EMBED payload on its own. No other field need be wrong.
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
 * ⚠ THE ANNOTATION ABOVE IS UNCHANGED AND MUST STAY. This alias loosens no check: `PROVIDER_PATTERNS` is
 * still keyed on the enum, so forgetting an entry for a provider added to the schema is still a compile
 * error here. Reading through `Partial<Record<string, …>>` only makes the RESULT `| undefined`, which is
 * what forces the `?? null` below to exist — delete it and `tsc` fails with "possibly 'undefined'"
 * (measured on a probe of exactly these three declarations). That is the whole reason this is a widened
 * alias rather than a bare `?? null` on the narrow read: a bare one would be invisible to the type
 * system, leaving a comment as the only thing standing between a future tidy-up and the crash again.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const PATTERN_FOR_PROVIDER: Partial<Record<string, RegExp | null>> = PROVIDER_PATTERNS;

const PROVIDER_NAMES: Record<EmbedSectionData["provider"], string> = {
  youtube: "YouTube",
  vimeo: "Vimeo",
  // Never shown: `iframe` has no pattern, so the mismatch notice cannot appear for it.
  //
  // ⚠ AND THAT SENTENCE IS ALSO WHAT KEEPS THIS NARROW LOOKUP OFF THE CRASH PATH, so it is a rule rather
  // than a remark. The notice below renders only where a pattern was FOUND and failed, and an unknown
  // provider now resolves to `null` exactly as `iframe` does — so this table is never asked to name a
  // provider it has no entry for. Any new reader of `PROVIDER_NAMES` must be gated on `mismatched` too,
  // or widened the way `PATTERN_FOR_PROVIDER` is.
  iframe: "another site"
};

export function EmbedForm({ data, onChange, onDirty }: SectionFormProps<EmbedSectionData>) {
  const update = (patch: Partial<EmbedSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  const hasUrl = data.url.trim().length > 0;

  /**
   * The schema's verdict on this exact payload, so the message under the field is the message the save
   * would give. Only asked for when there is something to complain about.
   */
  const titleProblem = useMemo(() => {
    if (!hasUrl || data.title.trim().length > 0) return null;
    const result = embedSectionSchema.safeParse(data);
    if (result.success) return null;
    return result.error.issues.find((issue) => issue.path[0] === "title")?.message ?? null;
  }, [data, hasUrl]);

  /**
   * ⚠ `?? null` IS LOAD-BEARING AND THE COMPILER NOW ENFORCES IT — see `PATTERN_FOR_PROVIDER`. An unknown
   * provider has no pattern, and "no pattern" is spelled `null` in this file; leaving it as `undefined`
   * would satisfy the `!== null` below and take the whole builder down on `.test`.
   */
  const pattern = PATTERN_FOR_PROVIDER[data.provider] ?? null;
  const mismatched = hasUrl && pattern !== null && !pattern.test(data.url);

  return (
    <div className="space-y-5">
      <Field label="Where the video is hosted" help={SHAPE.provider.description}>
        <Select
          value={data.provider}
          options={[
            { value: "youtube", label: "YouTube" },
            { value: "vimeo", label: "Vimeo" },
            { value: "iframe", label: "Somewhere else, in a frame" }
          ]}
          onChange={(event) =>
            update({ provider: event.target.value as EmbedSectionData["provider"] })
          }
        />
      </Field>

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
          That does not look like an address on {PROVIDER_NAMES[data.provider]}. Either correct the line
          above, or choose “Somewhere else, in a frame”.
        </HelpText>
      ) : null}

      <Field
        label="What this embed contains"
        help={SHAPE.title.description}
        // Required only once there is an address to describe. See the header.
        required={hasUrl}
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

      <Field label="The shape of the frame" help={SHAPE.aspectRatio.description}>
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

      {data.provider === "iframe" && hasUrl ? (
        <HelpText tone="warn">
          A frame loads the other site as soon as the page opens, and nothing here can make it faster or
          stop it setting its own cookies. Use YouTube or Vimeo where you can — those load only when a
          reader asks to play.
        </HelpText>
      ) : null}
    </div>
  );
}
