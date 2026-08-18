"use client";

/**
 * VideoDialog — put a video into a body of writing, or change the one already there.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT IS THE ONLY PLACE A `videoEmbed` NODE IS WRITTEN, and it resolves before it writes.
 *
 * The reason is the same one `LinkDialog` gives for links: `components/RichText.tsx` renders a stored
 * document and has NOTHING ELSE — no database, no lookup, no second chance. A node naming a poster by
 * its media-library id would show no poster on the published page for ever, and nothing in the studio
 * would say why, because in the studio the id resolves perfectly. So every reference this dialog
 * writes is resolved to a STORAGE KEY here, once, at the moment of saving.
 *
 * That is also what `RichTextVideo` in lib/richtext.ts means by "frozen onto the node", and it carries
 * the consequence in the same words: replacing the film in the media library does not change a copy
 * already embedded in a document. Re-inserting it does.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ THE ADDRESS IS CHECKED BY THE PAGE'S OWN RESOLVER WHILE IT IS BEING TYPED. `resolveEmbedTarget` is
 * the function `HostedVideoFrame` will use, so a channel URL, a playlist or a Drive folder — the three
 * shapes that look right and cannot be embedded — are refused here rather than discovered by
 * publishing the article. There is one copy of that verdict and it lives in lib/media/video.ts.
 *
 * ⚠ THE DESCRIPTION IS REQUIRED, AND IT IS THE SAME RULE THE EMBED BLOCK'S SCHEMA ENFORCES. A screen
 * reader announces an untitled `<iframe>` as "frame" and an untitled `<video>` as "video". Unlike a
 * block payload, a node's attributes pass through no Zod schema on the way to the column — nothing
 * downstream would catch an empty one — so this dialog is the only gate there is, and it refuses to
 * save rather than warning.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Film, TriangleAlert } from "lucide-react";

import { asApiClientError, get } from "@/lib/client/fetcher";
import {
  EMBED_ASPECT_RATIOS,
  defaultVideoSettings,
  resolveEmbedTarget,
  type EmbedProvider,
  type VideoSettings
} from "@/lib/media/video";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import {
  lookupResolvePath,
  type LookupResponse
} from "@/components/studio/fields/EntityPicker";
import { VideoSettingsFields } from "@/components/studio/fields/VideoSettingsFields";
import { HelpText } from "@/components/studio/HelpText";

/**
 * What the dialog writes, and what it is opened with.
 *
 * ⚠ THESE ARE THE NODE'S ATTRIBUTES, IN THE NODE'S OWN NAMES. Two vocabularies for one shape is how a
 * `posterObjectKey` becomes a `posterKey` on one side of a save; `VideoEmbed` in extensions.ts is the
 * declaration this mirrors and the only other place these names appear.
 */
export interface VideoEmbedAttributes {
  provider: string;
  url: string;
  objectKey: string | null;
  mediaId: string | null;
  posterObjectKey: string | null;
  captionsObjectKey: string | null;
  title: string;
  caption: string | null;
  aspectRatio: string;
  settings: VideoSettings;
}

/** The film, as the media picker hands it back. Only the two fields a node needs are read. */
export interface ChosenFilm {
  id: string;
  objectKey: string;
  caption?: string | null;
}

export interface VideoDialogProps {
  open: boolean;
  onClose: () => void;
  /** The attributes of the video already selected, or null when one is being added. */
  value: VideoEmbedAttributes | null;
  onSave: (attributes: VideoEmbedAttributes) => void;
  /**
   * Open the media picker for a film and resolve with the chosen asset, or null.
   *
   * ⚠ A CALLBACK RATHER THAN THE PICKER ITSELF, exactly as `RichTextEditor.onRequestMedia` is and for
   * the same reason: this file must not depend on `components/studio/media/MediaPicker.tsx`, so either
   * can be worked on without the other. Omitted → the uploaded-film option is absent from the source
   * list, because a screen with no picker cannot choose one.
   */
  onRequestFilm?: () => Promise<ChosenFilm | null>;
}

const PROVIDER_OPTIONS: readonly { value: EmbedProvider; label: string }[] = [
  { value: "upload", label: "A film uploaded here (up to 200 MB)" },
  { value: "youtube", label: "YouTube" },
  { value: "vimeo", label: "Vimeo" },
  { value: "drive", label: "Google Drive" },
  { value: "iframe", label: "Somewhere else, in a frame" }
];

const ASPECT_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "16:9", label: "Widescreen (16:9) — most video" },
  { value: "4:3", label: "Older video (4:3)" },
  { value: "1:1", label: "Square (1:1)" },
  { value: "9:16", label: "Upright (9:16) — video shot on a phone" }
];

/** A fresh, complete set of attributes. A factory, because `settings` is an object the dialog edits. */
function blankAttributes(): VideoEmbedAttributes {
  return {
    provider: "youtube",
    url: "",
    objectKey: null,
    mediaId: null,
    posterObjectKey: null,
    captionsObjectKey: null,
    title: "",
    caption: null,
    aspectRatio: EMBED_ASPECT_RATIOS[0],
    settings: defaultVideoSettings()
  };
}

export function VideoDialog({ open, onClose, value, onSave, onRequestFilm }: VideoDialogProps) {
  const [draft, setDraft] = useState<VideoEmbedAttributes>(() => value ?? blankAttributes());
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * True once the author has closed the dialog, and the reason the save checks it after its `await`.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * ⚠ CANCEL IS NOT DISABLED WHILE SAVING, AND IT MUST NOT BE. Only the Save button stands down: a
   * dialog whose every exit is taken away while a request is in flight is a dialog somebody is stuck
   * in when the request hangs, which is worse than the race below. Escape and the corner close are the
   * same door and are equally live.
   *
   * So the lookup can land AFTER the author has changed their mind — a cold serverless function or a
   * poor connection is all it takes — and without this the video they cancelled would appear in the
   * article a second later, with the dialog already gone and nothing to explain it. The flag is set by
   * an effect on `open` rather than by a handler, because Escape and a backdrop press go through
   * `Dialog`'s own `onClose` and never touch this file.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  const closedRef = useRef(false);
  useEffect(() => {
    if (!open) closedRef.current = true;
  }, [open]);

  /**
   * Re-seed when the dialog OPENS, never while it is open.
   *
   * A dialog that re-seeded on every change of `value` would fight the author: the editor updates the
   * node as soon as a save lands, `value` changes, and everything typed since would be replaced. The
   * open flag is the only thing this may key on.
   */
  useEffect(() => {
    if (!open) return;
    closedRef.current = false;
    setDraft(value ?? blankAttributes());
    setProblem(null);
    setSaving(false);
    // `value` is deliberately absent: see above. It is read for the seed and must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const isUpload = draft.provider === "upload";
  const hasFilm = Boolean(draft.objectKey);
  const hasUrl = draft.url.trim().length > 0;
  const hasSource = isUpload ? hasFilm : hasUrl;

  /** The page's own verdict on the address, asked of the page's own resolver. */
  const unreadable = useMemo(
    () => !isUpload && hasUrl && resolveEmbedTarget(draft.provider, draft.url) === null,
    [draft.provider, draft.url, hasUrl, isUpload]
  );

  const chooseFilm = useCallback(() => {
    if (!onRequestFilm) return;
    void (async () => {
      const film = await onRequestFilm();
      // Null is "the author closed the picker", which is not a failure and gets no message.
      if (!film) return;
      setDraft((current) => ({
        ...current,
        objectKey: film.objectKey,
        mediaId: film.id,
        // The library's own caption is a starting point, not an overwrite: an author who has already
        // written one here has said something the library does not know.
        caption: current.caption ?? film.caption ?? null
      }));
    })();
  }, [onRequestFilm]);

  const save = () => {
    if (!hasSource) {
      setProblem(
        isUpload
          ? "Choose a film before saving this video."
          : "Paste the address of the video before saving it."
      );
      return;
    }
    if (unreadable) {
      setProblem(
        "That address does not point at one thing that can be shown. A channel, a playlist and a Drive folder all look like this and none of them can be embedded."
      );
      return;
    }
    if (draft.title.trim().length === 0) {
      setProblem(
        "Describe this video before saving it. A screen reader announces an untitled frame only as 'frame', which tells the reader nothing about what is inside."
      );
      return;
    }

    setProblem(null);
    setSaving(true);

    void (async () => {
      try {
        /**
         * The poster and the subtitle file, resolved from library ids to STORAGE KEYS.
         *
         * ⚠ THIS IS THE STEP THE WHOLE DIALOG EXISTS FOR — see the header. `VideoSettingsFields` deals
         * in ids because that is what a block payload stores and what `EntityPicker` returns; a node
         * has to carry the key. One request, on an explicit action, for at most two ids.
         */
        const ids = [draft.settings.posterMediaId, draft.settings.captionsMediaId].filter(
          (id) => id.length > 0
        );
        const keys = new Map<string, string>();
        const path = lookupResolvePath("media", ids);
        if (path) {
          const response = await get<LookupResponse>(path);
          for (const item of response.items ?? []) {
            const key = item.media?.objectKey;
            if (key) keys.set(item.id, key);
          }
        }

        /**
         * ⚠ AN ID THAT DID NOT COME BACK IS NOT A NULL TO WRITE, IT IS SOMETHING TO SAY. A poster or a
         * subtitle file can be deleted between being chosen and being saved, and the lookup then
         * returns nothing for it. Writing `null` would leave the settings still NAMING the file — so
         * the dialog would reopen showing it chosen while the published page showed no poster at all,
         * which is the worst of both: an editor with no reason to suspect anything and no way to find
         * out. The save is refused, the ids are left exactly as they are, and the sentence names which
         * of the two it was.
         */
        // The author closed the dialog while this was in flight. See `closedRef`: writing the video
        // now would put it in the article a second after they cancelled it.
        if (closedRef.current) return;

        const missing: string[] = [];
        if (draft.settings.posterMediaId && !keys.has(draft.settings.posterMediaId)) {
          missing.push("the still picture");
        }
        if (draft.settings.captionsMediaId && !keys.has(draft.settings.captionsMediaId)) {
          missing.push("the subtitle file");
        }
        if (missing.length > 0) {
          setProblem(
            `${missing.join(" and ")} could not be found in the media library — ${missing.length === 1 ? "it has" : "they have"} most likely been deleted. Choose ${missing.length === 1 ? "another" : "others"} below, or clear the field, and try again.`
          );
          return;
        }

        onSave({
          ...draft,
          title: draft.title.trim(),
          url: draft.url.trim(),
          caption: draft.caption?.trim() || null,
          posterObjectKey: keys.get(draft.settings.posterMediaId) ?? null,
          captionsObjectKey: keys.get(draft.settings.captionsMediaId) ?? null
        });
        onClose();
      } catch (thrown) {
        /**
         * SAY IT AND STAY OPEN. Saving the node with no poster and no captions would look like a
         * success and quietly drop two things the author had chosen — the exact silent loss this
         * resolution step exists to prevent.
         */
        setProblem(
          `${asApiClientError(thrown).message} The video was not added, so nothing has been lost — try again.`
        );
      } finally {
        setSaving(false);
      }
    })();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={value ? "Change this video" : "Add a video"}
      description="It is drawn on the published page by the same player the video block uses."
      size="lg"
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={saving}>
            {saving ? "Adding…" : value ? "Save this video" : "Add this video"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Where the video is">
          <Select
            value={draft.provider}
            options={
              // With no picker there is no way to choose a film, so the option is absent rather than
              // present and inert — the same rule the toolbar's picture button follows.
              onRequestFilm ? PROVIDER_OPTIONS : PROVIDER_OPTIONS.filter((o) => o.value !== "upload")
            }
            onChange={(event) => setDraft((current) => ({ ...current, provider: event.target.value }))}
          />
        </Field>

        {isUpload ? (
          <div className="rounded-md border border-line-200 bg-surface-50 px-4 py-3">
            <p className="flex items-start gap-2 text-sm text-ink-700">
              <Film aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" />
              <span className="min-w-0 flex-1">
                {hasFilm ? (
                  // The KEY, not a friendly name: the node stores the key, and showing an author the
                  // thing that was actually written is how they can tell two takes of one recording
                  // apart. It is the same reason the media library shows a file name.
                  <span className="break-all font-mono text-xs text-ink-700">{draft.objectKey}</span>
                ) : (
                  "No film chosen yet."
                )}
              </span>
            </p>
            <div className="mt-2">
              <Button type="button" variant="secondary" size="sm" onClick={chooseFilm}>
                {hasFilm ? "Choose a different film" : "Choose a film"}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Field label="The address" maxLength={500} value={draft.url}>
              <Input
                value={draft.url}
                onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))}
                placeholder="https://www.youtube.com/watch?v=…"
                autoComplete="off"
                spellCheck={false}
                inputMode="url"
                className="font-mono text-xs"
              />
            </Field>

            {unreadable ? (
              <HelpText tone="warn">
                That address could not be read. Paste the ordinary share link for the single video or
                file — a channel, a playlist and a Drive folder cannot be embedded.
              </HelpText>
            ) : null}

            {draft.provider === "drive" ? (
              <HelpText>
                The file has to be shared as “Anyone with the link”, or readers will see Google’s
                sign-in page instead of the film.
              </HelpText>
            ) : null}
          </>
        )}

        <Field
          label="What this video contains"
          help="It is read aloud to anyone using a screen reader and is the only description they get, so “Video” is not enough."
          required
          maxLength={160}
          value={draft.title}
        >
          <Textarea
            rows={2}
            value={draft.title}
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
            placeholder="A five-minute film of the Bagru block-printing workshop, recorded in March 2026."
          />
        </Field>

        <Field
          label="Caption"
          help="One plain line under the film. Optional, and unlike a picture's caption it cannot carry a link."
          maxLength={240}
          value={draft.caption ?? ""}
        >
          <Input
            value={draft.caption ?? ""}
            onChange={(event) => setDraft((current) => ({ ...current, caption: event.target.value }))}
          />
        </Field>

        {!isUpload ? (
          <Field
            label="The shape of the frame"
            help="Getting it right avoids black bars; 9:16 is for phone-shot vertical video."
          >
            <Select
              value={draft.aspectRatio}
              options={ASPECT_OPTIONS}
              onChange={(event) =>
                setDraft((current) => ({ ...current, aspectRatio: event.target.value }))
              }
            />
          </Field>
        ) : null}

        <VideoSettingsFields
          provider={draft.provider}
          value={draft.settings}
          onChange={(next) => setDraft((current) => ({ ...current, settings: next }))}
        />

        {problem ? (
          // `role="alert"`: the author pressed save and it did not happen.
          <p role="alert" className="flex items-start gap-2 text-sm leading-relaxed text-error-600">
            <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{problem}</span>
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
