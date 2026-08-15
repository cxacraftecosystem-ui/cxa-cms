import { z } from "zod";

import {
  FACE_CHOICES,
  HEADING_FACE_CHOICES,
  HEADING_WRAP_CHOICES,
  LEADING_CHOICES,
  MEASURE_CHOICES,
  PARAGRAPH_STYLE_CHOICES,
  PULL_QUOTE_CHOICES,
  SIZE_CHOICES,
  SPACING_CHOICES,
  bodyFaceEnum,
  headingFaceEnum,
  houseMeasureEnum,
  houseTypesetSchema,
  proseHeadingWrapEnum,
  proseLeadingEnum,
  proseParagraphStyleEnum,
  prosePullQuoteEnum,
  proseSizeEnum,
  proseSpacingEnum,
  type TypesetChoice
} from "@/lib/typography/typeset";

/**
 * Site settings: eight GROUPS, each one validated JSON document, each one row in `Setting`.
 *
 * WHY GROUPS AND NOT KEY/VALUE. A settings table with one row per field makes "read everything the
 * header needs" six round trips and gives the type system nothing to check — `settings.get("siteName")`
 * is `string | undefined` forever, at every call site. One document per group means one query, one
 * schema, one inferred type, and a studio screen per group that saves atomically.
 *
 * THIS FILE IS NOT `server-only`. The studio's settings forms are client components and need the
 * schemas to validate before they post, and the labels to render. It therefore imports nothing from
 * `lib/env.ts`, `lib/db.ts` or anything else that carries `import "server-only"` — the reading side
 * lives in `lib/settings/service.ts`.
 *
 * TWO CONVENTIONS RUN THROUGH EVERY GROUP:
 *
 *  1. **Every field has a `.default()`.** Adding a field in a later release must not invalidate every
 *     document already stored — a group whose stored JSON predates the new field still parses, with
 *     the new field filled in. It also means `schema.parse({})` yields the complete default document,
 *     which is how `SETTINGS_DEFAULTS` below is built rather than hand-written twice.
 *  2. **No group schema carries a top-level `.refine()` / `.superRefine()`.** Every group is a plain
 *     `z.object`, so the reader in `service.ts` can walk `.shape` and rescue the fields that DID
 *     parse when a stored document is partly corrupt. A cross-field rule at the top level would make
 *     the whole document unparseable and cost the group all of its content on read; where two fields
 *     interact (features.events / features.eventRegistration) the relationship is stated in the
 *     description and enforced where it is read.
 *
 * "Optional" text fields are the empty string, never `null`. Studio forms are controlled React state
 * (contract §10) and a controlled `<input>` whose value goes `null` warns and then silently switches
 * to uncontrolled. Media references ARE nullable, because "no image" is not "an image whose id is the
 * empty string".
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared field builders
// ─────────────────────────────────────────────────────────────────────────────

/** A short free-text box. Trimmed on parse so a stray space cannot make two values look different. */
const text = (max: number) =>
  z.string().trim().max(max, `Keep this to ${max} characters or fewer.`);

/**
 * A reference to a row in `MediaAsset`, or nothing.
 *
 * The trailing transform folds `""` into `null`: a cleared media picker posts an empty string in more
 * than one browser, and two different values meaning "no image" is how a fallback logo ends up being
 * requested for the id `""`.
 */
const mediaId = z
  .string()
  .trim()
  .max(64)
  .nullable()
  .default(null)
  .transform((value) => (value && value.length > 0 ? value : null));

/**
 * An email address, or nothing.
 *
 * Written as a refine rather than `z.union([z.literal(""), z.string().email()])` so the failure
 * message names what to do; a union failure reads "Invalid input", which tells the reader nothing.
 */
const optionalEmail = z
  .string()
  .trim()
  .max(254)
  .refine((value) => value === "" || z.string().email().safeParse(value).success, {
    message: "Enter a complete email address, such as centre@example.ac.in, or leave the box empty."
  })
  .default("");

/**
 * Telephone numbers are NOT format-checked.
 *
 * Every regex anybody writes for this rejects a real number somewhere — extensions, in-country
 * prefixes written with a leading 0, spacing conventions that differ by state. A refused save on a
 * correct number is a worse failure than a typo nobody validated.
 */
const optionalPhone = text(40).default("");

const HTTP_SCHEMES = /^https?:\/\//i;

/**
 * A full external web address.
 *
 * `z.string().url()` alone is NOT enough: it is satisfied by `javascript:alert(1)`, because `new URL`
 * parses any scheme. These values are rendered straight into `href`, so the scheme is checked here
 * rather than trusted at every render site.
 */
const externalUrl = z
  .string()
  .trim()
  .max(500)
  .url("Enter a full web address, including https://")
  .refine((value) => HTTP_SCHEMES.test(value), {
    message: "A link must start with http:// or https://"
  });

/**
 * A link destination that may be internal.
 *
 * Footer links point at site paths far more often than at other sites, so a plain URL check would
 * reject "/about". The allow-list is positive — anything not matching one of these five shapes is
 * refused, which is what keeps `javascript:` and `data:` out of the footer.
 */
const linkHref = z
  .string()
  .trim()
  .min(1, "A link needs a destination.")
  .max(500)
  .refine(
    (value) =>
      value.startsWith("/") ||
      value.startsWith("#") ||
      value.startsWith("mailto:") ||
      value.startsWith("tel:") ||
      HTTP_SCHEMES.test(value),
    { message: "A destination must start with /, #, https://, mailto: or tel:." }
  );

// ─────────────────────────────────────────────────────────────────────────────
// Caps
//
// Every cap is exported because contract §1.6 requires a limit to be STATED on screen. A list that
// quietly stops accepting rows is indistinguishable from a broken form.
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_DEPARTMENTS = 24;
export const MAX_SOCIAL_LINKS = 12;
export const MAX_FEATURED_CRAFTS = 8;
export const MAX_FOOTER_COLUMNS = 5;
export const MAX_FOOTER_LINKS_PER_COLUMN = 12;

// ─────────────────────────────────────────────────────────────────────────────
// branding
// ─────────────────────────────────────────────────────────────────────────────

/** The one action colour. Not a setting; a constant that the settings screen displays and locks. */
export const ACCENT_PREFERENCE = "purple" as const;

/**
 * Rendered verbatim beside the locked accent field. An administrator who finds a greyed-out control
 * with no explanation files a bug; one who reads this does not.
 */
export const BRANDING_ACCENT_NOTE =
  "The action colour is fixed to purple. One action colour is what makes a button read as a button " +
  "everywhere on the site and in the studio — a second one turns 'this is the thing to press' into a " +
  "guess. Gold is available to marketing sections on the public site only, never in the studio, and " +
  "never for a control.";

export const brandingSettingsSchema = z.object({
  siteName: text(120)
    .min(1, "The site needs a name. It appears in the header, the browser tab and every share card.")
    .default("Centre of Excellence"),
  /** Used where the full name will not fit: the mobile header, the favicon tooltip, a share card. */
  shortName: text(40).default("CxA"),
  tagline: text(200).default(""),
  logoMediaId: mediaId,
  /** Optional light-on-dark variant. When absent the dark theme reuses `logoMediaId`. */
  logoDarkMediaId: mediaId,
  faviconMediaId: mediaId,
  ogImageMediaId: mediaId,
  /**
   * Locked. `.catch()` rather than a hard failure on purpose: a document that somehow carries another
   * value is normalised back to purple on read instead of costing the site its own name, which is
   * what a validation failure on this field would do.
   */
  accentPreference: z.literal(ACCENT_PREFERENCE).catch(ACCENT_PREFERENCE)
});

export type BrandingSettings = z.infer<typeof brandingSettingsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// typography — the house style for long-form text
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one group whose schema is DEFINED ELSEWHERE, and the reason is worth the exception.
 *
 * Every field here names a typographic step — a measure of 68 characters, a leading of 1.7, a paragraph
 * gap of 1.2em — and each of those steps is rendered by a class string in `lib/typography/typeset.ts`
 * with the matching CSS in `app/globals.css`. A value and the class that draws it must not be able to
 * drift apart, and they cannot if they are written beside one another; a second copy of the union here
 * would be a second opinion about what "comfortable" means. So `houseTypesetSchema` is that file's, and
 * this file owns what an administrator sees: the group's place in the list, its name and its help.
 *
 * It is still a plain `z.object` with a `.default()` on every field, which is what the two conventions
 * in this file's header require — see `houseTypesetSchema` itself.
 *
 * ⚠ THE DEFAULTS ARE THE SITE AS IT SHOULD LOOK, not "as it looked". An installation that never opens
 * this screen gets a properly set page: balanced headings, tidy paragraph wrapping, a heading bound to
 * the text beneath it. Turning every field back to its default is therefore never a way to get the old
 * typesetting back — there is no control for that, on purpose.
 */
export const typographySettingsSchema = houseTypesetSchema;

export type TypographySettings = z.infer<typeof typographySettingsSchema>;

/** The shape `app/studio/settings/SettingsForm.tsx` keys its copy table by. Structural, not imported. */
export interface SettingsFieldCopy {
  label: string;
  help?: string;
  multiline?: boolean;
}

/**
 * The studio's words for this group, keyed `typography.<field>` exactly as that screen's own table is.
 *
 * IT LIVES HERE BECAUSE THE FORM IS GENERATED AND THE COPY IS NOT. `SettingsForm` derives a control per
 * field from the schema and looks its label up in a written table — a field with no entry still renders,
 * under a humanised key and a note saying nobody has described it, which is honest and no way to ship a
 * group of twelve. Exporting the sentences means the screen needs one line to adopt them, and the same
 * decision `FEATURE_FLAGS` and `HERO_MODES` already took: the schema file owns the words.
 *
 * Each sentence says what the reader will SEE, and where the choice goes wrong. The dropdown values are
 * code words (`sans`, `balance`) because they end up beside CSS, so the help text is the only place a
 * non-technical administrator learns that "Sans" means Inter.
 */
export const TYPOGRAPHY_SETTINGS_COPY: Record<string, SettingsFieldCopy> = {
  "typography.bodyFace": {
    label: "Reading face",
    help:
      "The face every long passage on the site is set in. Only faces that can carry body text are listed — " +
      "a face drawn for headlines is unreadable over four hundred words, whatever it looks like in a " +
      "sample. Plus Jakarta Sans is the house default, so the whole site speaks in one voice; a serif " +
      "suits essays and catalogue entries that should read as documents. A text block can choose a " +
      "different one for itself."
  },
  "typography.headingFace": {
    label: "Heading face inside a passage",
    help:
      "The face used for headings within a piece of text — not the site's own headings, which come from " +
      "the theme. A single text block cannot override this: two heading faces on one page read as two " +
      "websites, and only the person who set the second one would know why."
  },
  "typography.measure": {
    label: "Reading width",
    help:
      "How long a line is allowed to get: Intimate is about 54 characters, Standard 68, Generous 78, Wide " +
      "88. Standard is where the eye finds the start of the next line without hunting for it. Wider suits " +
      "reference material and long technical terms; anything past Wide is tiring."
  },
  "typography.size": {
    label: "Reading size",
    help:
      "Standard is 16px on a phone growing to 17px on a wide screen. Small is for supporting notes, Large " +
      "for an opening passage, Feature for a standfirst of a few sentences — at Feature the headings " +
      "inside a long passage stop standing out from it."
  },
  "typography.leading": {
    label: "Space between lines",
    help:
      "Comfortable (1.7) is right for almost everything. Relaxed and Loose open the lines up, which helps " +
      "a wide measure and helps some readers considerably. Tight is only for text set large."
  },
  "typography.paragraphSpacing": {
    label: "Space between paragraphs",
    help:
      "Tight makes a passage read as one argument; Open makes it easy to skim before reading. The gap is " +
      "measured against the text size, so it stays in proportion at every reading size."
  },
  "typography.paragraphStyle": {
    label: "How paragraphs are separated",
    help:
      "Separated by space is what a reader expects on a screen. First line indented is how a book is set — " +
      "no gap, an indent instead — which is beautiful for a continuous essay and wrong for anything " +
      "somebody will scan, because the paragraphs stop being separable at a glance."
  },
  "typography.headingWrap": {
    label: "How a heading breaks across lines",
    help:
      "Balance gives a wrapped heading lines of similar length, so no single word is left alone at the " +
      "end. Pretty only prevents that lone last word, which is better for a long heading. Plain does " +
      "nothing, for when you have written the breaks yourself."
  },
  "typography.hyphenation": {
    label: "Break long words across lines",
    help:
      "Uses the page's language to hyphenate. It is what makes a justified column possible and a narrow " +
      "one tidy. Leave it off for a wide, ragged-right passage, where it breaks words for no gain."
  },
  "typography.justify": {
    label: "Straighten the right-hand edge",
    help:
      "Justifies every paragraph. It looks composed in print and fights on a screen: without hyphenation " +
      "and a measure of Standard or wider it opens gaps between words that read worse than a ragged edge. " +
      "It has no effect on centred or right-aligned text."
  },
  "typography.dropCap": {
    label: "Open a passage with a large first letter",
    help:
      "Sets the first letter over three lines, as a printed essay opens. It needs a first paragraph of " +
      "three or four lines to sit against, and it has no effect on centred or right-aligned text. As a " +
      "site-wide default it applies to EVERY text block, which is usually too many — most Centres want it " +
      "on one or two pages, set on the block itself."
  },
  "typography.pullQuote": {
    label: "How a quotation sits against the text",
    help:
      "Hanging puts the quotation's rule out in the margin so the quoted words line up with the rest of " +
      "the text, which is how a quotation is set in print. Indented pushes both inwards. On a narrow " +
      "screen there is no margin to hang into, so a hanging quotation is indented there in any case."
  }
};

/**
 * Proper words for the VALUES in this group's dropdowns, keyed `typography.<field>` then by value.
 *
 * The settings screen labels a closed list by humanising its value — "Comfortable", "Intimate" — which
 * is readable and drops the only part that helps somebody choose: the number. "Comfortable — 1.7" and
 * "Intimate — about 54 characters" are decisions an administrator can take; a single adjective is a
 * guess. Every label here is the one the per-block panel already shows for the same value, read out of
 * the same maps, so the two screens cannot describe one setting differently.
 */
function optionLabels<T extends string>(
  values: readonly T[],
  choices: Record<T, TypesetChoice>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) out[value] = choices[value].label;
  return out;
}

export const TYPOGRAPHY_OPTION_LABELS: Record<string, Record<string, string>> = {
  "typography.bodyFace": optionLabels(bodyFaceEnum.options, FACE_CHOICES),
  "typography.headingFace": optionLabels(headingFaceEnum.options, HEADING_FACE_CHOICES),
  "typography.measure": optionLabels(houseMeasureEnum.options, MEASURE_CHOICES),
  "typography.size": optionLabels(proseSizeEnum.options, SIZE_CHOICES),
  "typography.leading": optionLabels(proseLeadingEnum.options, LEADING_CHOICES),
  "typography.paragraphSpacing": optionLabels(proseSpacingEnum.options, SPACING_CHOICES),
  "typography.paragraphStyle": optionLabels(proseParagraphStyleEnum.options, PARAGRAPH_STYLE_CHOICES),
  "typography.headingWrap": optionLabels(proseHeadingWrapEnum.options, HEADING_WRAP_CHOICES),
  "typography.pullQuote": optionLabels(prosePullQuoteEnum.options, PULL_QUOTE_CHOICES)
};

// ─────────────────────────────────────────────────────────────────────────────
// contact
// ─────────────────────────────────────────────────────────────────────────────

export const departmentContactSchema = z.object({
  name: text(120).min(1, "A department needs a name."),
  email: optionalEmail,
  phone: optionalPhone,
  /** "Admissions enquiries only, Monday to Friday" — the sentence that stops the wrong mail arriving. */
  note: text(240).default("")
});

export type DepartmentContact = z.infer<typeof departmentContactSchema>;

export const contactSettingsSchema = z.object({
  addressLine1: text(160).default(""),
  addressLine2: text(160).default(""),
  city: text(80).default(""),
  state: text(80).default(""),
  postalCode: text(24).default(""),
  country: text(80).default("India"),
  email: optionalEmail,
  phone: optionalPhone,
  /**
   * Coordinates are `number | null`, and `z.coerce.number()` is deliberately NOT used: `Number("")`
   * is 0, and 0, 0 is a real place in the Gulf of Guinea. An empty box must arrive as `null`, so the
   * studio form parses the text itself and sends null when it is blank.
   */
  mapLatitude: z
    .number()
    .min(-90, "Latitude runs from -90 to 90.")
    .max(90, "Latitude runs from -90 to 90.")
    .nullable()
    .default(null),
  mapLongitude: z
    .number()
    .min(-180, "Longitude runs from -180 to 180.")
    .max(180, "Longitude runs from -180 to 180.")
    .nullable()
    .default(null),
  /** Leaflet/Mapbox zoom levels. 13 shows a campus and the streets around it. */
  mapZoom: z
    .number()
    .int("Zoom must be a whole number.")
    .min(1, "Zoom runs from 1 (the whole world) to 20 (a building).")
    .max(20, "Zoom runs from 1 (the whole world) to 20 (a building).")
    .default(13),
  departments: z
    .array(departmentContactSchema)
    .max(MAX_DEPARTMENTS, `A maximum of ${MAX_DEPARTMENTS} departments can be listed.`)
    .default([])
});

export type ContactSettings = z.infer<typeof contactSettingsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// social
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Suggestions for the platform picker, NOT a closed list.
 *
 * `platform` is validated as a free-form slug so a network nobody has heard of yet needs neither a
 * migration nor a release — it needs somebody to type its name. These entries exist so the common
 * ones arrive spelled consistently and with an icon. `icon` names a `lucide-react` export
 * (contract §13: lucide and only lucide); an unrecognised platform falls back to `Globe`.
 */
export const SOCIAL_PLATFORMS: readonly { value: string; label: string; icon: string }[] = [
  { value: "linkedin", label: "LinkedIn", icon: "Linkedin" },
  { value: "twitter", label: "X (Twitter)", icon: "Twitter" },
  { value: "youtube", label: "YouTube", icon: "Youtube" },
  { value: "instagram", label: "Instagram", icon: "Instagram" },
  { value: "facebook", label: "Facebook", icon: "Facebook" },
  { value: "github", label: "GitHub", icon: "Github" },
  { value: "rss", label: "RSS feed", icon: "Rss" },
  { value: "other", label: "Something else", icon: "Globe" }
];

export const SOCIAL_FALLBACK_ICON = "Globe";

export const socialLinkSchema = z.object({
  /** A lowercase slug: "linkedin", "mastodon", "bluesky". Matched against SOCIAL_PLATFORMS for an icon. */
  platform: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Choose or name a platform.")
    .max(40)
    .regex(/^[a-z0-9-]+$/, "Use lowercase letters, numbers and hyphens only."),
  url: externalUrl,
  /**
   * The accessible name for the link. Empty means "use the platform's label" — a bare icon link with
   * no name is unreachable by a screen reader, so the renderer must supply one either way.
   */
  label: text(60).default("")
});

export type SocialLink = z.infer<typeof socialLinkSchema>;

export const socialSettingsSchema = z.object({
  /**
   * An array rather than a field per network. A fixed shape means every new platform is a schema
   * change, a form change and a migration of every stored document; an array means an editor adds a
   * row. The order here is the order rendered — the studio reorders by dragging.
   */
  links: z
    .array(socialLinkSchema)
    .max(MAX_SOCIAL_LINKS, `A maximum of ${MAX_SOCIAL_LINKS} social links can be shown.`)
    .default([])
});

export type SocialSettings = z.infer<typeof socialSettingsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// seo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shown beside the indexing switch, in both states. The consequence of each position has to be
 * legible before the switch is thrown, not discovered a fortnight later in Search Console.
 */
export const SEO_INDEXING_NOTE =
  "Turn indexing off on a staging or preview deployment: every page then sends noindex and search " +
  "engines drop the site within days. Turn it on before launch — a production site left switched off " +
  "will not appear in any search result, and nothing on the page says so.";

export const seoSettingsSchema = z.object({
  /** The title of the homepage, and the fallback for any page that has not set its own. */
  defaultTitle: text(120).default(""),
  /**
   * `%s` is Next.js's placeholder for the page's own title. A template without it silently gives every
   * page the same title, which is both an SEO failure and unusable in a browser's tab strip — so it is
   * checked here rather than noticed in a crawl report.
   */
  titleTemplate: text(120)
    .refine((value) => value.includes("%s"), {
      message: "The template must contain %s, which is where the page's own title is inserted."
    })
    .default("%s · Centre of Excellence"),
  defaultDescription: text(320).default(""),
  defaultOgImageMediaId: mediaId,
  /**
   * A real switch, not a constant. A staging deployment that indexes competes with production for
   * the Centre's own name, and the only way to stop that without a code change is this.
   */
  robotsAllowIndexing: z.boolean().default(true),
  /** The bare token from the Search Console meta tag, not the whole tag. */
  googleSiteVerification: text(120).default("")
});

export type SeoSettings = z.infer<typeof seoSettingsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// homepage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How the homepage opens. Descriptions are written for an editor choosing between them, so they say
 * what the reader will see, not which component renders it.
 */
export const HERO_MODES: readonly { value: "cinematic" | "still" | "minimal"; label: string; description: string }[] = [
  {
    value: "cinematic",
    label: "Cinematic",
    description:
      "Full-height opening with the headline revealed word by word over an ambient wash. The most " +
      "arresting, and the heaviest — it loads an animation library the other two do not."
  },
  {
    value: "still",
    label: "Still image",
    description: "One photograph behind the headline, no motion. Fast, and safe on a slow connection."
  },
  {
    value: "minimal",
    label: "Type only",
    description:
      "Headline and standfirst on the page background, nothing else. Best when there is no photograph " +
      "good enough to fill a screen."
  }
];

export const homepageSettingsSchema = z.object({
  heroMode: z.enum(["cinematic", "still", "minimal"]).default("cinematic"),
  showNewsTicker: z.boolean().default(true),
  /**
   * Seconds for ONE complete pass of the ticker, not a speed — an editor can time a pass with a watch
   * and cannot reason about pixels per second. Floored at 10 because anything faster is unreadable;
   * the ticker is suppressed entirely under reduced motion regardless of this value.
   */
  tickerSpeedSeconds: z
    .number()
    .int("Give a whole number of seconds.")
    .min(10, "A pass faster than 10 seconds cannot be read.")
    .max(180, "A pass slower than 180 seconds looks stalled.")
    .default(45),
  featuredCraftIds: z
    .array(z.string().trim().min(1).max(64))
    .max(MAX_FEATURED_CRAFTS, `At most ${MAX_FEATURED_CRAFTS} crafts can be featured on the homepage.`)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Each craft can only be featured once."
    })
    .default([]),
  /**
   * The census/statistics strip on the homepage normally counts published rows. `enabled` suspends
   * that and shows `note` instead — for the weeks when the true count is misleading (a migration in
   * progress, an embargoed batch). The note is a sibling of the switch, not a separate setting
   * somebody forgets to fill in.
   *
   * ⚠ WHERE THIS IS READ, AND WHY THE NOTE IS NOT VALIDATED AS REQUIRED WHEN `enabled` IS ON.
   *
   * Making it conditionally required would need a `superRefine` on this group, which convention 2 at
   * the top of this file forbids: a cross-field rule at the top level makes a partly corrupt stored
   * document unparseable and costs the group ALL of its content on read, and this group holds the
   * homepage's hero mode and featured crafts as well. Convention 2's own remedy is that such a
   * relationship is "stated in the description and enforced where it is READ", so:
   *
   *   • `resolveSectionData()` in lib/sections/resolve.ts reads `enabled` BEFORE queuing any count, so
   *     a suspended census issues no statements at all and every figure comes back `null`;
   *   • `StatsSection` renders `note` in place of the row. With the switch on and the note EMPTY it
   *     falls back to `SUSPENDED_WITHOUT_NOTE` — a plain statement that the figures are not being
   *     shown — because otherwise a block whose every figure is counted disappears from the page
   *     entirely, which is the one outcome that renderer exists to prevent. It also logs the setting
   *     by name, since an unexplained suspension is an operator's problem rather than a reader's.
   *
   * ⚠ AND IT IS RENDERED PER BLOCK, NOT PER PAGE, WHICH THIS NOTE USED TO IMPLY IT WAS NOT. The census is
   * resolved once for a whole page, so this switch reaches every stats block on it — including one whose
   * figures are all typed by hand and which therefore has no suspended count to explain. `StatsSection`
   * prints the note only in a block where some figure actually asked to be counted (`asksForACount`);
   * anywhere else the sentence would be false about the block it sat under. So the note is addressed to
   * readers of the COUNTS, and an administrator writing it should say why the counts are paused rather
   * than describe the page as a whole.
   *
   * So an empty note degrades to something honest rather than to nothing; it is still worth writing,
   * because only the administrator can say WHY, and the fallback cannot.
   */
  censusOverride: z
    .object({
      enabled: z.boolean().default(false),
      note: text(240).default("")
    })
    .default({})
});

export type HomepageSettings = z.infer<typeof homepageSettingsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// features
// ─────────────────────────────────────────────────────────────────────────────

export const featuresSettingsSchema = z.object({
  craftExplorer: z.boolean().default(true),
  events: z.boolean().default(true),
  gallery: z.boolean().default(true),
  publications: z.boolean().default(true),
  contactForm: z.boolean().default(true),
  eventRegistration: z.boolean().default(true),
  analytics: z.boolean().default(true)
});

export type FeaturesSettings = z.infer<typeof featuresSettingsSchema>;
export type FeatureFlag = keyof FeaturesSettings;

/**
 * One entry per flag, for the studio's switch list.
 *
 * Each description says what DISAPPEARS, because that is the decision being taken. A flag that gates
 * a whole surface also gates its navigation entry and its API routes — turning a surface off while
 * leaving a link to it produces a 404 that looks like a broken deployment.
 */
export const FEATURE_FLAGS: readonly { key: FeatureFlag; label: string; description: string }[] = [
  {
    key: "craftExplorer",
    label: "Craft Explorer",
    description:
      "The map, the timeline and every craft page. Turning it off hides the section and its navigation " +
      "entry; the records themselves are untouched."
  },
  {
    key: "events",
    label: "Events",
    description:
      "The events listing, event pages and the events strip on the homepage. Turning this off also " +
      "stops registration, whatever the registration switch says."
  },
  {
    key: "gallery",
    label: "Gallery",
    description: "Albums, the lightbox and the virtual tours. The media library is unaffected."
  },
  {
    key: "publications",
    label: "Publications",
    description: "The publications index, filters and citation exports."
  },
  {
    key: "contactForm",
    label: "Contact form",
    description:
      "The form on the contact page. With it off the page still shows the address, the email and the " +
      "telephone number — a contact page with no way to make contact is worse than no page."
  },
  {
    key: "eventRegistration",
    label: "Event registration",
    description:
      "The registration form on event pages. Depends on Events: with Events off this has no effect."
  },
  {
    key: "analytics",
    label: "Analytics",
    description:
      "First-party page-view counting. No cookie and no visitor identifier is set either way; off " +
      "means the day/path/country counts are not written at all."
  }
];

// ─────────────────────────────────────────────────────────────────────────────
// footer
// ─────────────────────────────────────────────────────────────────────────────

export const footerLinkSchema = z.object({
  label: text(60).min(1, "A link needs a label."),
  href: linkHref
});

export type FooterLink = z.infer<typeof footerLinkSchema>;

export const footerColumnSchema = z.object({
  heading: text(60).min(1, "A column needs a heading."),
  links: z
    .array(footerLinkSchema)
    .max(
      MAX_FOOTER_LINKS_PER_COLUMN,
      `A column holds at most ${MAX_FOOTER_LINKS_PER_COLUMN} links before it stops fitting.`
    )
    .default([])
});

export type FooterColumn = z.infer<typeof footerColumnSchema>;

export const footerSettingsSchema = z.object({
  columns: z
    .array(footerColumnSchema)
    .max(MAX_FOOTER_COLUMNS, `The footer holds at most ${MAX_FOOTER_COLUMNS} columns.`)
    .default([]),
  /** The copyright and policy line. Plain text — it is rendered as text, never as HTML. */
  legalNote: text(400).default(""),
  showCredit: z.boolean().default(true)
});

export type FooterSettings = z.infer<typeof footerSettingsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// The registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The groups, in the order the studio lists them: identity first, then the things that describe the
 * Centre, then the switches that change what exists. This tuple is the single source of the ordering
 * AND of the `SettingsGroup` union, so a new group cannot be added to one and missed in the other.
 */
export const SETTINGS_GROUP_KEYS = [
  "branding",
  // Beside branding rather than at the end: a house typographic style is part of an institution's
  // identity, and an administrator setting up a new site meets it while they are still thinking about
  // how the place should look — not three tabs later, among the switches.
  "typography",
  "contact",
  "social",
  "seo",
  "homepage",
  "features",
  "footer"
] as const;

export type SettingsGroup = (typeof SETTINGS_GROUP_KEYS)[number];

export interface SettingsGroupMeta {
  key: SettingsGroup;
  label: string;
  /** One sentence, shown under the heading on the settings index. Says what changes, not what it is. */
  description: string;
  /** A `lucide-react` export name. Contract §13: lucide, and only lucide. */
  icon: string;
}

const GROUP_META: Record<SettingsGroup, Omit<SettingsGroupMeta, "key">> = {
  branding: {
    label: "Branding",
    description: "The Centre's name, tagline and logos, and the share card used when a page has none.",
    icon: "Palette"
  },
  typography: {
    label: "Typesetting",
    description:
      "How long-form text is set: the reading face, the line length, the leading and the paragraph rhythm every text block starts from.",
    icon: "Type"
  },
  contact: {
    label: "Contact",
    description: "The postal address, the map pin, and who to write to about what.",
    icon: "MapPin"
  },
  social: {
    label: "Social",
    description: "The accounts linked from the footer and the share bar, in the order they appear.",
    icon: "Share2"
  },
  seo: {
    label: "Search & sharing",
    description: "Default titles and descriptions, and whether search engines may index this deployment.",
    icon: "Search"
  },
  homepage: {
    label: "Homepage",
    description: "How the homepage opens, the news ticker, and which crafts are featured.",
    icon: "Home"
  },
  features: {
    label: "Features",
    description: "Which whole sections of the site exist. Turning one off hides its pages and its links.",
    icon: "ToggleLeft"
  },
  footer: {
    label: "Footer",
    description: "The footer columns, their links, and the legal line beneath them.",
    icon: "PanelBottom"
  }
};

export const SETTINGS_GROUPS: readonly SettingsGroupMeta[] = SETTINGS_GROUP_KEYS.map((key) => ({
  key,
  ...GROUP_META[key]
}));

export function settingsGroupMeta(key: SettingsGroup): SettingsGroupMeta {
  return { key, ...GROUP_META[key] };
}

/** True for a string that names a group. Use it before indexing anything by a route parameter. */
export function isSettingsGroup(value: unknown): value is SettingsGroup {
  return typeof value === "string" && (SETTINGS_GROUP_KEYS as readonly string[]).includes(value);
}

/** The parsed shape of each group. The one place the key → type correspondence is written down. */
export interface SettingsMap {
  branding: BrandingSettings;
  typography: TypographySettings;
  contact: ContactSettings;
  social: SocialSettings;
  seo: SeoSettings;
  homepage: HomepageSettings;
  features: FeaturesSettings;
  footer: FooterSettings;
}

export type SettingsOf<K extends SettingsGroup> = SettingsMap[K];

/**
 * `satisfies Record<SettingsGroup, z.AnyZodObject>` does two jobs: it fails the build if a group is
 * added to the key tuple without a schema, and it proves every entry is a plain object schema — which
 * is what makes `settingsFieldSchemas()` below safe rather than hopeful.
 */
export const SETTINGS_SCHEMAS = {
  branding: brandingSettingsSchema,
  typography: typographySettingsSchema,
  contact: contactSettingsSchema,
  social: socialSettingsSchema,
  seo: seoSettingsSchema,
  homepage: homepageSettingsSchema,
  features: featuresSettingsSchema,
  footer: footerSettingsSchema
} as const satisfies Record<SettingsGroup, z.AnyZodObject>;

/**
 * The schema for a group, typed to that group's output.
 *
 * Zod cannot express "indexing this map with K yields a schema whose output is SettingsMap[K]", so
 * the correspondence is asserted here — once, next to the map that defines it — instead of at every
 * call site.
 */
export function settingsSchema<K extends SettingsGroup>(key: K): z.ZodType<SettingsOf<K>> {
  return SETTINGS_SCHEMAS[key] as unknown as z.ZodType<SettingsOf<K>>;
}

/**
 * The per-FIELD schemas of a group.
 *
 * Exists for the partial-recovery read in `service.ts`: when a stored document fails to validate, the
 * reader parses each field on its own and keeps the ones that pass. Safe because of the `satisfies`
 * above — every value in the map really is a `ZodObject`, so `.shape` is always there.
 */
export function settingsFieldSchemas(key: SettingsGroup): Record<string, z.ZodTypeAny> {
  return (SETTINGS_SCHEMAS[key] as unknown as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
}

/**
 * The complete default document for every group.
 *
 * DERIVED, not written out again: every field carries a `.default()`, so parsing `{}` produces the
 * whole default document. Hand-maintaining a second copy is how a default drifts from its schema and
 * a "reset to defaults" button starts writing a document that no longer validates. It also fails
 * LOUDLY at import time — the first time anything touches this module — if a field is ever added
 * without a default, rather than at the first read of a group nobody has saved yet.
 *
 * `siteName`'s default matches `lib/env.ts`'s `siteName()` fallback on purpose; this file cannot
 * import that one, because it is `server-only` and this module is used by client forms.
 */
export const SETTINGS_DEFAULTS: SettingsMap = {
  branding: brandingSettingsSchema.parse({}),
  typography: typographySettingsSchema.parse({}),
  contact: contactSettingsSchema.parse({}),
  social: socialSettingsSchema.parse({}),
  seo: seoSettingsSchema.parse({}),
  homepage: homepageSettingsSchema.parse({}),
  features: featuresSettingsSchema.parse({}),
  footer: footerSettingsSchema.parse({})
};
