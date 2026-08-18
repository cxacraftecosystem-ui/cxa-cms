/**
 * video-check — the embed resolvers and the player's settings, asserted.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SCRIPT AND NOT A TEST FILE. `scripts/screens-check.ts` opens with the same sentence and
 * it has not changed: there is no test runner in this repository — `tsx` is the only thing that runs a
 * `.ts` file, and `npm run check` is where every gate lives. A `*.test.ts` would need a runner nobody
 * installed and would be run by nothing.
 *
 * WHY IT EXISTS. `lib/media/video.ts` turns an address a person pasted into an address a browser may
 * be given, and every one of its rules is a fact about somebody else's product that no type can carry:
 *
 *   • Google serves `/view` with `X-Frame-Options: SAMEORIGIN`, so the link an editor copies out of the
 *     address bar CANNOT be framed and must be rewritten to `/preview`. Get that wrong and every Drive
 *     embed on the site is a blank white rectangle, with nothing on the page or in the studio to say
 *     why — the failure is invisible to `tsc`, to `lint`, to the build and to a reader of the code.
 *   • Google inserts `u/<n>` — the signed-in account's index — into the path of a URL taken from the
 *     address bar, and it sits BEFORE the product on drive.google.com and AFTER it on
 *     docs.google.com. Both shapes were refused by the first version of the resolver; both are what an
 *     editor with two Google accounts actually pastes.
 *   • YouTube's `loop=1` does nothing on a single video: its player loops a PLAYLIST, so a looping film
 *     must be handed a playlist consisting of itself. A setting that silently does nothing is the shape
 *     of bug the studio forms in this repository exist to refuse.
 *   • Vimeo takes a start time as a FRAGMENT (`#t=90s`) and ignores it as a query parameter.
 *
 * Each of those was found by running the code rather than by reading it, and each would come back the
 * first time somebody "tidied" a branch. The assertions below are the record of what was measured.
 *
 * ⚠ IT ALSO ASSERTS WHAT MUST BE REFUSED, which is half the value. A channel, a playlist and a Drive
 * FOLDER all look like a video link and none of them can be embedded; a `javascript:` URL in an iframe
 * `src` is a script injection. A resolver that grew permissive would fail here rather than in public.
 *
 * ⚠ THE ID BELOW IS INVENTED AND NOTHING IS FETCHED. This runs offline, in milliseconds, and touches no
 * network and no database — the same property `font-check` and `screens-check` are built on.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import {
  attachedFilmSettings,
  defaultVideoSettings,
  isCaptionsObjectKey,
  isVideoObjectKey,
  providerHonours,
  readVideoSettings,
  resolveEmbedTarget,
  videoSettingsMediaIds
} from "../lib/media/video";

let checked = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
  checked += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${name}\n      expected ${e}\n      actual   ${a}`);
}

/** The `src` a provider resolves an address to, or null. Every check below is about this one string. */
function srcOf(provider: string, url: string): string | null {
  return resolveEmbedTarget(provider, url)?.src ?? null;
}

/** Long enough to pass `DRIVE_ID_SHAPE`, and deliberately not a real file. */
const DRIVE_ID = "1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUv";
const DRIVE_PREVIEW = `https://drive.google.com/file/d/${DRIVE_ID}/preview`;

// ─────────────────────────────────────────────────────────────────────────────
// Google Drive — every share shape an editor actually pastes
// ─────────────────────────────────────────────────────────────────────────────

check("drive: /view?usp=sharing", srcOf("drive", `https://drive.google.com/file/d/${DRIVE_ID}/view?usp=sharing`), DRIVE_PREVIEW);
check("drive: /view?usp=drive_link", srcOf("drive", `https://drive.google.com/file/d/${DRIVE_ID}/view?usp=drive_link`), DRIVE_PREVIEW);
check("drive: /edit", srcOf("drive", `https://drive.google.com/file/d/${DRIVE_ID}/edit`), DRIVE_PREVIEW);
check("drive: already /preview", srcOf("drive", DRIVE_PREVIEW), DRIVE_PREVIEW);
check("drive: bare /file/d/<id>", srcOf("drive", `https://drive.google.com/file/d/${DRIVE_ID}`), DRIVE_PREVIEW);
check("drive: open?id=", srcOf("drive", `https://drive.google.com/open?id=${DRIVE_ID}`), DRIVE_PREVIEW);
check("drive: uc?id=&export=download", srcOf("drive", `https://drive.google.com/uc?id=${DRIVE_ID}&export=download`), DRIVE_PREVIEW);
check("drive: www. prefix", srcOf("drive", `https://www.drive.google.com/file/d/${DRIVE_ID}/view`), DRIVE_PREVIEW);
// The signed-into-two-accounts shape. See `withoutAccountSegment`.
check("drive: /u/0/file/d/<id>/view", srcOf("drive", `https://drive.google.com/u/0/file/d/${DRIVE_ID}/view`), DRIVE_PREVIEW);

// A folder has no in-page viewer, so it must be refused rather than framed into a blank box.
check("drive: a folder is refused", srcOf("drive", `https://drive.google.com/drive/folders/${DRIVE_ID}`), null);
check("drive: an account-scoped folder is refused", srcOf("drive", `https://drive.google.com/u/0/drive/folders/${DRIVE_ID}`), null);
check("drive: /drive/u/0/folders is refused", srcOf("drive", `https://drive.google.com/drive/u/0/folders/${DRIVE_ID}`), null);
check("drive: a short id is refused", srcOf("drive", "https://drive.google.com/file/d/abc/view"), null);

// ─────────────────────────────────────────────────────────────────────────────
// Google Docs, Slides and Sheets — the same substitution, a different path shape
// ─────────────────────────────────────────────────────────────────────────────

check("docs: document /edit", srcOf("drive", `https://docs.google.com/document/d/${DRIVE_ID}/edit`), `https://docs.google.com/document/d/${DRIVE_ID}/preview`);
check("docs: presentation /edit#slide", srcOf("drive", `https://docs.google.com/presentation/d/${DRIVE_ID}/edit#slide=id.p`), `https://docs.google.com/presentation/d/${DRIVE_ID}/preview`);
check("docs: spreadsheets /edit#gid", srcOf("drive", `https://docs.google.com/spreadsheets/d/${DRIVE_ID}/edit#gid=0`), `https://docs.google.com/spreadsheets/d/${DRIVE_ID}/preview`);
/** ⚠ A PUBLISHED DOCUMENT IS ALREADY FRAMEABLE and must pass through untouched — `/preview` is not an
 *  endpoint it has, so rewriting it would frame a Google error page. */
check("docs: a published /d/e/ link passes through", srcOf("drive", `https://docs.google.com/spreadsheets/d/e/${DRIVE_ID}/pubhtml`), `https://docs.google.com/spreadsheets/d/e/${DRIVE_ID}/pubhtml`);
check("docs: a published link keeps its query", srcOf("drive", `https://docs.google.com/spreadsheets/d/e/${DRIVE_ID}/pubhtml?widget=true&headers=false`), `https://docs.google.com/spreadsheets/d/e/${DRIVE_ID}/pubhtml?widget=true&headers=false`);
/**
 * ⚠ A PUBLISHED ID IS FAR LONGER THAN A FILE ID, and the first bound this file was written against cut
 * it off. Google's own "Publish to the web" dialog hands out `2PACX-…` ids of 80–90 characters, so a
 * cap that suited a 33-character Drive id made the whole published branch unreachable — dead code that
 * looked live. This is a real one, measured from a Slides publish dialog.
 */
const PUBLISHED_ID = "2PACX-1vTLQfDcT8YAcRvHhbYtOHCBEwPeF6GwsCTvfVEOFEbTKfKrJj-eOVoiDbHiOFKMHu-3xJEHZUDwpH7l";
check(
  "docs: a real 86-character published id is accepted",
  srcOf("drive", `https://docs.google.com/presentation/d/e/${PUBLISHED_ID}/pub`),
  `https://docs.google.com/presentation/d/e/${PUBLISHED_ID}/pub`
);
// ⚠ The account segment sits AFTER the product here and BEFORE it on drive.google.com.
check("docs: /document/u/1/d/<id>/edit", srcOf("drive", `https://docs.google.com/document/u/1/d/${DRIVE_ID}/edit`), `https://docs.google.com/document/d/${DRIVE_ID}/preview`);
// A form belongs in the FORM_EMBED block, which carries the host allow-list and the consent sentence.
check("docs: a form is refused", srcOf("drive", `https://docs.google.com/forms/d/${DRIVE_ID}/viewform`), null);

// ─────────────────────────────────────────────────────────────────────────────
// YouTube
// ─────────────────────────────────────────────────────────────────────────────

const YT = "dQw4w9WgXcQ";
const YT_BASE = `https://www.youtube-nocookie.com/embed/${YT}?autoplay=1&rel=0&modestbranding=1&playsinline=1`;

check("youtube: /watch?v=", srcOf("youtube", `https://www.youtube.com/watch?v=${YT}`), YT_BASE);
check("youtube: youtu.be", srcOf("youtube", `https://youtu.be/${YT}`), YT_BASE);
check("youtube: /shorts/", srcOf("youtube", `https://www.youtube.com/shorts/${YT}`), YT_BASE);
check("youtube: /live/", srcOf("youtube", `https://www.youtube.com/live/${YT}`), YT_BASE);
check("youtube: a channel is refused", srcOf("youtube", "https://www.youtube.com/@somechannel"), null);
check("youtube: a playlist is refused", srcOf("youtube", "https://www.youtube.com/playlist?list=PL1234567890"), null);
/** ⚠ `videoseries` SITS WHERE AN ID SITS AND IS MADE OF AN ID'S CHARACTERS. It is YouTube's own embed
 *  for a playlist, and accepted it produces a player that loads and reports the video unavailable. */
check("youtube: /embed/videoseries is refused", srcOf("youtube", "https://www.youtube.com/embed/videoseries?list=PL1234567890"), null);
/** ⚠ THE SETTING MEANS "SILENT BECAUSE IT STARTS ITSELF", and a hosted embed only starts because the
 *  reader pressed our poster. Passing it on made every deliberate press silent. */
check(
  "youtube: startMuted is never passed on",
  resolveEmbedTarget("youtube", `https://youtu.be/${YT}`, { ...defaultVideoSettings(), startMuted: true })?.src,
  YT_BASE
);

/**
 * ⚠ `loop=1` ALONE DOES NOTHING. YouTube's player loops a PLAYLIST, so the documented way to loop one
 * film is to hand it a playlist consisting of itself. Without the second parameter the studio's "play
 * it again when it ends" switch is a control with no effect.
 */
check(
  "youtube: loop is a playlist of itself, plus start, controls and mute",
  resolveEmbedTarget("youtube", `https://youtu.be/${YT}`, {
    ...defaultVideoSettings(),
    loop: true,
    startAt: 42,
    showControls: false,
    startMuted: true
  })?.src,
  `${YT_BASE}&start=42&controls=0&loop=1&playlist=${YT}`
);

// ─────────────────────────────────────────────────────────────────────────────
// Vimeo
// ─────────────────────────────────────────────────────────────────────────────

check("vimeo: plain", srcOf("vimeo", "https://vimeo.com/123456789"), "https://player.vimeo.com/video/123456789?autoplay=1&dnt=1");
check("vimeo: unlisted hash as a segment", srcOf("vimeo", "https://vimeo.com/123456789/abc123def0"), "https://player.vimeo.com/video/123456789?autoplay=1&dnt=1&h=abc123def0");
check("vimeo: /video/<id>", srcOf("vimeo", "https://vimeo.com/video/123456789"), "https://player.vimeo.com/video/123456789?autoplay=1&dnt=1");
check("vimeo: a channel path still finds the film", srcOf("vimeo", "https://vimeo.com/channels/staff/123456789"), "https://player.vimeo.com/video/123456789?autoplay=1&dnt=1");
/** ⚠ A SHOWCASE LINK CARRIES TWO NUMBERS and the first one is the collection, not the film. */
check("vimeo: a showcase yields the film, not the collection", srcOf("vimeo", "https://vimeo.com/showcase/1234567/video/890123"), "https://player.vimeo.com/video/890123?autoplay=1&dnt=1");
check(
  "vimeo: startMuted is never passed on",
  resolveEmbedTarget("vimeo", "https://vimeo.com/123456789", { ...defaultVideoSettings(), startMuted: true })?.src,
  "https://player.vimeo.com/video/123456789?autoplay=1&dnt=1"
);

/** ⚠ VIMEO TAKES A START TIME AS A FRAGMENT. `?t=90` is accepted by the URL and ignored by the film. */
const vimeoAt = resolveEmbedTarget("vimeo", "https://vimeo.com/123456789", {
  ...defaultVideoSettings(),
  startAt: 90
});
check("vimeo: the start time is a fragment", vimeoAt?.src, "https://player.vimeo.com/video/123456789?autoplay=1&dnt=1#t=90s");
check(
  "vimeo: the result is still a parseable URL",
  (() => {
    try {
      return new URL(vimeoAt?.src ?? "").hash;
    } catch {
      return "unparseable";
    }
  })(),
  "#t=90s"
);

// ─────────────────────────────────────────────────────────────────────────────
// The uploaded film, the plain frame, and what must never be framed
// ─────────────────────────────────────────────────────────────────────────────

// `upload` is not a frame at all — it names a MediaAsset and is drawn by VideoPlayer.
check("upload: has no frame", resolveEmbedTarget("upload", "https://example.com/film.mp4"), null);
// A value written by a newer release and read after a rollback. It must degrade, never throw.
check("unknown provider: falls through to a plain frame", srcOf("wistia", "https://fast.wistia.net/embed/iframe/abc123"), "https://fast.wistia.net/embed/iframe/abc123");
check("iframe: a site path cannot be framed", srcOf("iframe", "/about"), null);
check("iframe: javascript: is refused", srcOf("iframe", "javascript:alert(1)"), null);
check("iframe: data: is refused", srcOf("iframe", "data:text/html,<script>alert(1)</script>"), null);
check("iframe: an empty address is refused", srcOf("iframe", "   "), null);

// ─────────────────────────────────────────────────────────────────────────────
// Which file is which
// ─────────────────────────────────────────────────────────────────────────────

check("film: .mp4", isVideoObjectKey("media/2026/03/clip.mp4"), true);
check("film: .MOV, whatever the case", isVideoObjectKey("media/2026/03/CLIP.MOV"), true);
check("film: not a photograph", isVideoObjectKey("media/2026/03/photo.jpg"), false);
check("captions: .vtt", isCaptionsObjectKey("media/2026/03/subtitles.vtt"), true);
check("captions: not a report", isCaptionsObjectKey("media/2026/03/report.pdf"), false);

// ─────────────────────────────────────────────────────────────────────────────
// The settings, and the repair that must never be all-or-nothing
// ─────────────────────────────────────────────────────────────────────────────

const defaults = defaultVideoSettings();

// The defaults are a promise the studio's help text makes; they are asserted rather than assumed.
check("defaults: it starts when it comes into view", defaults.autoplayOnScreen, true);
check("defaults: it pauses when the reader scrolls past", defaults.offScreen, "pause");
check("defaults: it starts silent", defaults.startMuted, true);
check("defaults: it has controls", defaults.showControls, true);
check("defaults: it does not loop", defaults.loop, false);
check("defaults: it does not offer the file", defaults.allowDownload, false);

check("repair: undefined becomes the defaults", readVideoSettings(undefined), defaults);
check("repair: null becomes the defaults", readVideoSettings(null), defaults);
check("repair: a string becomes the defaults", readVideoSettings("nonsense"), defaults);
check("repair: an array becomes the defaults", readVideoSettings([1, 2]), defaults);

/**
 * ⚠ ONE BAD FIELD MUST COST THAT FIELD AND NOT THE FILM. A rich-text video node's attributes go through
 * no schema on the way into the `Json` column, so a hand-edited or migrated document really can carry
 * one wrong value — and an all-or-nothing `safeParse` would throw away the poster, the captions and the
 * start time along with it.
 */
const damaged = readVideoSettings({ loop: "yes", startAt: 120, offScreen: "minimise" });
check("repair: the bad field falls back", damaged.loop, defaults.loop);
check("repair: a good field beside it survives", damaged.startAt, 120);
check("repair: another good field survives", damaged.offScreen, "minimise");

const partial = readVideoSettings({ allowDownload: true });
check("repair: a partial object keeps what it has", partial.allowDownload, true);
check("repair: a partial object fills what it lacks", partial.showControls, true);

check("collector: names the poster and the captions", videoSettingsMediaIds({ ...defaults, posterMediaId: "abc", captionsMediaId: "def" }), ["abc", "def"]);
check("collector: names nothing when nothing is chosen", videoSettingsMediaIds(defaults), []);
check("collector: tolerates null", videoSettingsMediaIds(null), []);

/** ⚠ AN ATTACHMENT HAS NO SETTINGS SCREEN, so it must not start itself in a wall of other films. */
check("attached films do not start themselves", attachedFilmSettings().autoplayOnScreen, false);
check("attached films are otherwise the defaults", { ...attachedFilmSettings(), autoplayOnScreen: true }, defaults);

// ─────────────────────────────────────────────────────────────────────────────
// Which provider honours which setting
// ─────────────────────────────────────────────────────────────────────────────

check("honours: an uploaded film takes the corner player", providerHonours("upload", "offScreen"), true);
check("honours: YouTube cannot take the corner player", providerHonours("youtube", "offScreen"), false);
check("honours: YouTube takes a start time", providerHonours("youtube", "startAt"), true);
check("honours: Drive takes nothing", providerHonours("drive", "startAt"), false);
check("honours: a plain frame takes nothing", providerHonours("iframe", "loop"), false);
// The widening that keeps the studio's form off the page builder's crash path.
check("honours: an unknown provider takes nothing", providerHonours("wistia", "loop"), false);
/** ⚠ THE ONE SETTING A HOSTED PROVIDER MUST NOT BE OFFERED. See the note in `youTubeTarget`. */
check("honours: YouTube is never offered a muted start", providerHonours("youtube", "startMuted"), false);
check("honours: Vimeo is never offered a muted start", providerHonours("vimeo", "startMuted"), false);
/** `upload` is our own player, so it honours the whole schema — derived, never hand-copied. */
check("honours: an uploaded film honours every setting", Object.keys(defaults).every((key) => providerHonours("upload", key as never)), true);

// ─────────────────────────────────────────────────────────────────────────────

console.log(`video-check — ${checked} assertions over the embed resolvers and the player's settings`);

if (failures.length > 0) {
  console.error(`\nFAIL — ${failures.length} of ${checked}:\n`);
  for (const failure of failures) console.error(`  ${failure}\n`);
  process.exit(1);
}

console.log("PASS — every share link resolves as measured, and a damaged settings object repairs one field at a time.");
