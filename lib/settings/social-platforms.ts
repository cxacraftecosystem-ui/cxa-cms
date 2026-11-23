/**
 * The social platforms the studio's picker suggests, and the icon an unknown one falls back to.
 *
 * ⚠ THIS FILE IMPORTS NOTHING, AND THAT IS WHY IT EXISTS. These two constants used to live in
 * lib/settings/schema.ts, which builds every settings schema with zod when it loads. lib/socials.ts
 * needs them, SiteHeader needs lib/socials.ts, and SiteHeader is a client component on every public
 * page — so importing two plain arrays from the schema module put zod (with every one of its ~50 locale
 * message tables, about 88 KB compressed and 380 KB to parse) into the JavaScript of every page on the
 * site. A module that builds schemas at load time cannot be tree-shaken, so moving the constants out
 * is the only fix that holds. lib/settings/schema.ts re-exports both, so server code is unchanged.
 *
 * Keep it that way: anything a public client component reads from settings belongs in a zod-free
 * module like this one, never in the schema file.
 */

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
