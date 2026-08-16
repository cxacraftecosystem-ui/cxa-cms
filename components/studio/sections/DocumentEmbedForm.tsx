"use client";

/**
 * DocumentEmbedForm — put one uploaded document on the page, where the editor wants it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE FORM TELLS THE EDITOR WHAT THE PAGE WILL DO, BEFORE THEY PUBLISH IT.
 *
 * A browser can draw a PDF and can draw nothing else — no PowerPoint, no Word, no OpenDocument. An
 * editor who chooses a deck expecting a preview and gets a download card has been let down by this
 * screen and not by the renderer, so the verdict is stated the moment a document is chosen: which of
 * the two shapes the page will take, and why. `documentFormat()` in `lib/sections/schema.ts` reaches
 * that verdict, and `DocumentEmbedSection` reads the SAME function — the arrangement
 * `resolveFormTarget` and `FormEmbedForm` already use, for the same reason. A second table here would
 * disagree with the page the first time either learned about a format.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ IT LOOKS THE ASSET UP ITSELF, WHICH COSTS ONE EXTRA REQUEST, AND THAT IS SAID PLAINLY RATHER THAN
 * HIDDEN. `EntityPicker` resolves the chosen id to a title for its own list, but hands back only the
 * id — so the FILE NAME, which is the one thing the verdict depends on, is not available here without
 * asking. `useResource` holds no shared cache, so the picker and this form each issue the same
 * `?type=media&ids=…` GET. It is one small authenticated read per chosen document on a studio screen,
 * and it buys an editor the answer while they can still act on it. Widening `EntityPicker`'s
 * `onChange` to carry the whole `LookupItem` would remove the duplicate and is the better fix; it is
 * not made from this file, which does not own that control.
 *
 * THE HEIGHT CONTROL DISAPPEARS for a document that will not be framed, rather than sitting there
 * doing nothing (contract §1.8) — there is no frame to size when the page is showing a download card.
 * It stays while nothing is chosen, because at that point the block still expects a PDF.
 */

import { useMemo } from "react";

import {
  documentEmbedSectionSchema,
  documentFormat,
  type DocumentEmbedSectionData,
  type DocumentFormat
} from "@/lib/sections/schema";
import { useResource } from "@/lib/client/useResource";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { HelpText } from "@/components/studio/HelpText";
import {
  EntityPicker,
  lookupResolvePath,
  type LookupItem,
  type LookupResponse
} from "@/components/studio/fields/EntityPicker";
import type { SectionFormProps } from "@/components/studio/sections";

/** `.innerType()` because the schema is a `ZodEffects` — see its header, and EMBED's and FORM_EMBED's. */
const SHAPE = documentEmbedSectionSchema.innerType().shape;

/** How tall the frame is, in words rather than pixels. Matches the schema's `height` enum. */
const HEIGHT_OPTIONS: readonly { value: DocumentEmbedSectionData["height"]; label: string }[] = [
  { value: "sm", label: "Short — a single page at a glance" },
  { value: "md", label: "Medium — about a page of A4 (the usual choice)" },
  { value: "lg", label: "Tall — for a document meant to be read here" },
  { value: "xl", label: "Very tall — nearly a full screen on a large monitor" }
];

function isHeight(value: string): value is DocumentEmbedSectionData["height"] {
  return HEIGHT_OPTIONS.some((option) => option.value === value);
}

/** A response is a cast, not a proof — one guard here beats a crash two lines down. */
function firstItem(response: LookupResponse | null): LookupItem | null {
  if (response === null || !Array.isArray(response.items)) return null;
  return response.items[0] ?? null;
}

export function DocumentEmbedForm({
  data,
  onChange,
  onDirty
}: SectionFormProps<DocumentEmbedSectionData>) {
  const update = (patch: Partial<DocumentEmbedSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  const chosen = data.mediaId.trim();
  const hasDocument = chosen.length > 0;

  // Suspended while nothing is chosen: `lookupResolvePath` answers null for an empty list, and
  // `useResource` treats null as "do not ask".
  const lookup = useResource<LookupResponse>(lookupResolvePath("media", hasDocument ? [chosen] : []));
  const asset = firstItem(lookup.data);

  /**
   * The lookup titles a media row with its FILE NAME (falling back to the id, for a row that somehow
   * has none), which is exactly what the format is read off. A row with no usable name resolves to
   * "Document" and to "cannot be previewed", which is the safe direction: the block then promises a
   * download card and delivers one.
   */
  const format = asset ? documentFormat(asset.title) : null;

  /**
   * The schema's verdict on this exact payload, so the message under the title is the message the save
   * would produce rather than a second wording of it. Asked for only once there is a document, which
   * is the only state in which the rule can fire.
   */
  const titleIssue = useMemo(() => {
    if (!hasDocument) return null;
    const result = documentEmbedSectionSchema.safeParse(data);
    if (result.success) return null;
    return result.error.issues.find((issue) => issue.path[0] === "title")?.message ?? null;
  }, [data, hasDocument]);

  return (
    <div className="space-y-5">
      <EntityPicker
        kind="media"
        max={1}
        label="The document"
        help={SHAPE.mediaId.description}
        ids={hasDocument ? [chosen] : []}
        onChange={(next) => update({ mediaId: next[0] ?? "" })}
        footnote="Upload the document in Media first. A file that also needs to be counted as a download — a dataset, a form to fill in — belongs in a Downloads block instead, which serves it through the file store and records every download."
      />

      <Verdict
        hasDocument={hasDocument}
        loading={lookup.data === null && lookup.isLoading}
        fileName={asset?.title ?? ""}
        format={format}
      />

      <Field
        label="What this document is"
        help={SHAPE.title.description}
        // Asked for once there is a document to describe, and not before (contract §10). The message is
        // the schema's own.
        required={hasDocument}
        error={titleIssue}
        maxLength={160}
        value={data.title}
      >
        <Textarea
          rows={2}
          value={data.title}
          onChange={(event) => update({ title: event.target.value })}
          placeholder="The Centre's annual report for 2025–26, including the audited accounts."
        />
      </Field>

      <Field
        label="A line or two about it"
        help={SHAPE.description.description}
        maxLength={320}
        value={data.description}
      >
        <Textarea
          rows={2}
          value={data.description}
          onChange={(event) => update({ description: event.target.value })}
          placeholder="Published in September 2026. The chapter on the cluster programme begins on page 24."
        />
      </Field>

      {/* Absent, not disabled, where there is no frame to size. See the header. */}
      {format !== null && !format.previewable ? null : (
        <Field label="How much of the page it takes up" help={SHAPE.height.description}>
          <Select
            value={data.height}
            options={HEIGHT_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(event) => {
              const next = event.target.value;
              if (isHeight(next)) update({ height: next });
            }}
          />
        </Field>
      )}

      <Field
        label="Words on the download link"
        help={SHAPE.downloadLabel.description}
        maxLength={60}
        value={data.downloadLabel}
      >
        <Input
          value={data.downloadLabel}
          onChange={(event) => update({ downloadLabel: event.target.value })}
          placeholder="Download the annual report"
        />
      </Field>

      <HelpText>
        The link is shown whatever the format, and it carries the type and size in its own words — so
        nobody starts a 40 MB download on a telephone by accident, and a reader whose PDF viewer is
        switched off still has a way to the document.
      </HelpText>
    </div>
  );
}

/**
 * Which of the two shapes the page will take, said before it is published.
 *
 * Four states, and they are four because collapsing any pair of them would mislead:
 *
 *   • NOTHING CHOSEN — the block will say so on the page, which is deliberate and is still not
 *     something to publish.
 *   • LOOKING IT UP — not the same as "cannot be previewed" (contract §9). A verdict rendered while
 *     the request is in flight is a verdict on a document nobody has read the name of yet.
 *   • A PDF — framed on the page.
 *   • ANYTHING ELSE — a download card, with the reason.
 *
 * NOTHING IS SAID for a document that has been deleted since it was chosen, or for a lookup that
 * failed: `EntityPicker` states both, in its own words, directly above this — and two notices about
 * one problem send an editor looking for two problems.
 */
function Verdict({
  hasDocument,
  loading,
  fileName,
  format
}: {
  hasDocument: boolean;
  loading: boolean;
  fileName: string;
  format: DocumentFormat | null;
}) {
  if (!hasDocument) {
    return (
      <HelpText tone="warn">
        Nothing is chosen yet, so this block says on the page that no document has been chosen. That is
        deliberate — a block that quietly showed nothing would look like a fault in the page — but it
        is not something to publish.
      </HelpText>
    );
  }

  if (loading) return <HelpText>Looking the document up…</HelpText>;
  if (format === null) return null;

  if (format.previewable) {
    return (
      <HelpText>
        This is a {format.label}, so it is shown on the page itself, in a frame the reader can scroll,
        with a link under it for anyone who would rather download it.
      </HelpText>
    );
  }

  return (
    <HelpText tone="warn">
      <span className="font-semibold">{fileName}</span> is a {format.label.toLowerCase()}, and no
      browser can draw one inside a page. The block will show a card naming the file, its type and its
      size, with a download button — not a preview. If it has to be read on the page, export it as a
      PDF and choose that instead. ⚠ The Centre&rsquo;s documents are deliberately not routed through
      Office Online or Google&rsquo;s viewer to fake a preview: both of those work by fetching the file
      into their own servers and keeping a copy.
    </HelpText>
  );
}
