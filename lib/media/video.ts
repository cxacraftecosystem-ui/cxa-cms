import { z } from "@/lib/zod";

/**
 * Video, in one module: what counts as one, where a pasted address points, and every setting the
 * player takes.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT IS ISOMORPHIC AND MUST STAY SO — no `server-only`, no `"use client"`, no Prisma, no React.
 *
 * Four surfaces read this file and they sit on both sides of the boundary:
 *
 *   • `components/sections/EmbedSection.tsx` and `components/site/VideoPlayer.tsx` — client, on the
 *     public site.
 *   • `components/studio/sections/EmbedForm.tsx` and `components/studio/editor/VideoDialog.tsx` —
 *     client, in the studio, showing an editor the SAME verdict the page will reach while they are
 *     still typing the address.
 *   • `lib/sections/schema.ts` — isomorphic, and validated in the browser as well as on the server
 *     (its rule 1).
 *   • `components/RichText.tsx` — a Server Component on the public site and a client one inside the
 *     studio's live preview, which is the reason it may import nothing that picks a side.
 *
 * Two copies of "is this a YouTube link" would disagree the first time either one learned about a URL
 * shape, and the disagreement would show as a studio that promises a video and a page that draws an
 * error card. That is the same argument `documentFormat` and `resolveFormTarget` make; this is the
 * third instance of it and the reason the parser moved out of the renderer it used to live in.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ NOTHING HERE AUTOPLAYS A THIRD PARTY. `autoplayOnScreen` below is honoured by OUR player, for a
 * file on the Centre's own object store, and by nothing else. A YouTube or Drive frame that mounted
 * itself when it scrolled into view would hand the reader's address and referrer to Google without
 * them ever asking to watch anything — which is the exact request `EmbedSection`'s poster exists to
 * withhold. The settings that a provider CAN honour (a start time, a loop) travel in the URL and take
 * effect after the reader presses play; the ones it cannot are said out loud in the studio form
 * rather than left as controls with no effect.
 */

// The zod-free half — film detection, embed resolution and the player's menus — lives in
// lib/media/video-embed.ts so public client components can import it without zod. Re-exported in full
// so every existing import of this module keeps working; the names the schema below needs are imported.
export * from "@/lib/media/video-embed";
import { VIDEO_OFF_SCREEN_BEHAVIOURS, type EmbedProvider } from "@/lib/media/video-embed";

/**
 * Every setting the player takes, as one nested object on the block's payload.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ EVERY FIELD HAS A DEFAULT AND THE WHOLE OBJECT HAS ONE. That is rule 2 of lib/sections/schema.ts
 * applied one level down: a MEDIA_SPLIT block saved before this object existed has no `videoSettings`
 * key at all, and `.prefault({})` is what makes it parse into a complete set of defaults rather than
 * turning every image-beside-text block on the site into an editor-only error card.
 *
 * ⚠ ZOD'S `.default()` FIRES FOR A MISSING KEY, NEVER FOR AN EXPLICIT `null` (contract §14). Nothing
 * in the studio writes null into these, and nothing should start.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * It is declared HERE rather than in lib/sections/schema.ts because the rich-text video node stores
 * the same settings as flat node attributes, and `components/studio/editor/VideoDialog.tsx` validates
 * them with this very schema — a second copy in the section module would be a second set of defaults
 * to keep in step.
 */
export const videoSettingsSchema = z
  .object({
    autoplayOnScreen: z
      .boolean()
      .default(true)
      .describe(
        "Starts the film when it scrolls into view, muted, and only for a video stored on this site. Readers who have asked their device for reduced motion are never started automatically."
      ),
    offScreen: z
      .enum(VIDEO_OFF_SCREEN_BEHAVIOURS)
      .default("pause")
      .describe(
        "What happens when the reader scrolls past it. Shrinking it into the corner suits a recorded talk somebody listens to while reading."
      ),
    startMuted: z
      .boolean()
      .default(true)
      .describe(
        "Starts with the sound off. Leave this on if the film starts by itself: every browser refuses to start an unmuted video, so the two settings together would simply do nothing."
      ),
    loop: z.boolean().default(false).describe("Starts again from the beginning when it ends."),
    showControls: z
      .boolean()
      .default(true)
      .describe(
        "The play button, the progress bar and the sound control. Turning these off leaves a reader no way to stop the film, so it suits a short silent loop and nothing else."
      ),
    posterMediaId: z
      .string()
      .trim()
      .max(40, "That does not look like a media reference.")
      .default("")
      .describe(
        "A still picture shown before the film starts. Nothing makes one automatically, so a film with no still shows its own first frame once the browser has fetched enough to draw it."
      ),
    startAt: z
      .number()
      .int("Give the number of seconds as a whole number.")
      .min(0, "A start time cannot be negative.")
      .max(86_400, "That is longer than a day. Check the number of seconds.")
      .default(0)
      .describe("How many seconds in to start. Leave it at 0 to start at the beginning."),
    speedMenu: z
      .boolean()
      .default(true)
      .describe("Offers playback speeds from half to double. It suits a lecture or an interview."),
    allowPictureInPicture: z
      .boolean()
      .default(true)
      .describe(
        "Lets the reader pop the film out into a small window their browser keeps on top of everything else."
      ),
    allowDownload: z
      .boolean()
      .default(false)
      .describe(
        "Shows a link that saves the file. It does not protect anything — the address is public either way — it only decides whether the page offers it."
      ),
    rememberPosition: z
      .boolean()
      .default(false)
      .describe(
        "Brings the reader back to where they stopped last time, remembered in their own browser and never sent anywhere."
      ),
    captionsMediaId: z
      .string()
      .trim()
      .max(40, "That does not look like a media reference.")
      .default("")
      .describe(
        "A subtitle file in WebVTT format (.vtt), uploaded to the media library. Captions are the only way a deaf reader gets what is said."
      ),
    captionsLabel: z
      .string()
      .trim()
      .max(60, "Keep this to 60 characters or fewer.")
      .default("")
      .describe("What the subtitles are called in the menu — “English”. Left empty it reads “Captions”.")
  })
  /*
   * ⚠ `.prefault`, NOT `.default`, AND THE DIFFERENCE IS THE WHOLE POINT OF THIS LINE. Zod 4's
   * `.default(value)` hands `value` back as the OUTPUT without parsing it, so `{}` would arrive as `{}`
   * with none of the fields' own defaults filled in — every player setting undefined. `.prefault(value)`
   * parses `value` through the schema, which is what Zod 3's `.default` did and what every "`{}` parses
   * into a complete set of defaults" in this codebase relies on.
   */
  .prefault({});

export type VideoSettings = z.infer<typeof videoSettingsSchema>;

/**
 * The defaults, as a value.
 *
 * Produced by PARSING an empty object rather than written out again, so it can never disagree with
 * the schema above — the mistake `defaultSectionData` avoids the same way.
 */
export function defaultVideoSettings(): VideoSettings {
  return videoSettingsSchema.parse(undefined);
}

/**
 * A complete settings object out of whatever was stored, never a failure.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ IT IS FOR THE RICH-TEXT VIDEO NODE, WHOSE ATTRIBUTES ARE NOT VALIDATED ANYWHERE. A block's
 * payload goes through `parseSectionData` on every write and arrives here already correct; a node's
 * attributes come out of a `Json` column through `lib/richtext.ts`, which coerces scalars and does not
 * — and must not, for the dependency reason its own note gives — know what a settings object is.
 *
 * So one bad field must cost that field and not the film. `safeParse` on the whole object is
 * all-or-nothing, which would turn a single stray `loop: "yes"` into a player that ignored the
 * poster, the captions and the start time as well — so the fallback is applied FIELD BY FIELD, by
 * parsing the object and then, on failure, parsing each key on its own against the same schema. The
 * fields that are fine survive; only the broken one goes back to its default.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function readVideoSettings(raw: unknown): VideoSettings {
  const whole = videoSettingsSchema.safeParse(raw ?? undefined);
  if (whole.success) return whole.data;

  const defaults = defaultVideoSettings();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return defaults;

  const source = raw as Record<string, unknown>;
  const shape = videoSettingsSchema.unwrap().shape;
  const repaired: Record<string, unknown> = { ...defaults };

  for (const key of Object.keys(defaults) as (keyof VideoSettings)[]) {
    if (!(key in source)) continue;
    const field = shape[key].safeParse(source[key]);
    if (field.success) repaired[key] = field.data;
  }

  return repaired as VideoSettings;
}

/**
 * The settings for a film that has no settings screen — an attachment on a project, an event, a craft
 * or an album.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ IT IS THE DEFAULTS WITH AUTOPLAY OFF, AND THE DIFFERENCE IS NOT A DETAIL. Those four surfaces
 * draw a WALL of films — a grid of up to several, all in one column of one page — and none of them
 * has anywhere for an editor to say otherwise, because the rows are attachments rather than blocks.
 * With `autoplayOnScreen` at its own default of `true`, scrolling down such a wall starts each film
 * as it arrives and stops the previous one (see `players` in VideoPlayer.tsx), which is a page that
 * flickers between soundtracks while the reader is trying to read.
 *
 * The block-level default stays `true`, because a block is a deliberate placement an editor chose and
 * can change. An attachment is not, so it gets the conservative answer: it starts when the reader
 * presses play, and pauses when they scroll past.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function attachedFilmSettings(): VideoSettings {
  return { ...defaultVideoSettings(), autoplayOnScreen: false };
}

/**
 * The `MediaAsset` ids a settings object names — the poster and the caption file.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ IT EXISTS SO `lib/sections/resolve.ts` CANNOT FORGET ONE, and forgetting one fails SILENTLY
 * rather than loudly: the batched media map is keyed by asset id, an id that was never fetched is
 * simply absent, and the player then draws a film with no poster and no captions and reports nothing.
 * That is the exact shape of the per-screen framing bug `screenFramingMediaIds` exists to prevent —
 * "this was not loaded" and "this was never set" being the same shape to the type system — so it gets
 * the same answer: one function, called by every collector, returning every id in the object.
 *
 * A field added to `videoSettingsSchema` that names an asset must be added HERE in the same edit.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function videoSettingsMediaIds(settings: VideoSettings | null | undefined): string[] {
  if (!settings) return [];
  return [settings.posterMediaId, settings.captionsMediaId].filter((id) => id.length > 0);
}

/**
 * Which of the settings this provider can actually honour.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ IT EXISTS SO A STUDIO FORM CAN HIDE A CONTROL THAT WOULD DO NOTHING, which is contract §10's rule
 * read from the other end: a control an editor can set and that changes nothing on the page is worse
 * than an absent one, because they will set it, check the page, and conclude the block is broken.
 *
 * `full` is our own player and honours everything. YouTube and Vimeo take a handful of parameters in
 * the URL, applied when the reader presses play. Google Drive's viewer takes NONE — `/preview` has no
 * documented parameters at all — and a plain frame is somebody else's page, over which nothing here
 * has any say.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export type VideoSettingKey = keyof VideoSettings;

/**
 * Every setting there is, DERIVED FROM THE SCHEMA rather than written out again.
 *
 * ⚠ A HAND-COPIED LIST HERE IS A LIST THAT SILENTLY LOSES A FIELD. `upload` honours everything by
 * definition — it is our own player — so a setting added to `videoSettingsSchema` and forgotten here
 * would be stored, editable nowhere, and honoured by a player that never saw a control for it.
 * Reading the schema's own keys makes that impossible.
 */
const EVERY_SETTING = Object.keys(videoSettingsSchema.unwrap().shape) as VideoSettingKey[];

/**
 * ⚠ `startMuted` IS ABSENT FROM THE TWO HOSTED PROVIDERS ON PURPOSE. It means "start silent because
 * it starts by itself", and neither of them ever does: the reader presses our poster first. Offering
 * it would be a control that made every deliberate press silent — see the note in `youTubeTarget`,
 * which refuses to write the parameter even when an old payload carries the setting.
 */
const PROVIDER_HONOURS: Record<EmbedProvider, readonly VideoSettingKey[]> = {
  upload: EVERY_SETTING,
  youtube: ["startAt", "loop", "showControls"],
  vimeo: ["startAt", "loop", "showControls"],
  drive: [],
  iframe: []
};

/**
 * Does this provider honour this setting?
 *
 * ⚠ WIDENED ON PURPOSE, and the reason is the same trace `EmbedForm`'s `PATTERN_FOR_PROVIDER` carries
 * in full: the studio's builder hands a form its RAW working copy when a payload fails to parse, so
 * `data.provider` really can be a string that has never been through the enum. A narrow read would
 * make the compiler believe this always hits, and the miss would be `undefined.includes(…)` — a
 * client render error inside the page builder, which is a white screen with an editor's unsaved work
 * behind it. An unknown provider honours nothing, which is the same answer `drive` and `iframe` give.
 */
export function providerHonours(provider: EmbedProvider | string, setting: VideoSettingKey): boolean {
  const honoured: Partial<Record<string, readonly VideoSettingKey[]>> = PROVIDER_HONOURS;
  return (honoured[provider] ?? []).includes(setting);
}
