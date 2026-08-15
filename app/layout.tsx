import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { PREFERENCES_BOOT_SCRIPT, THEME_COLOR } from "@/lib/preferences";
import { PreferencesProvider } from "@/components/providers/PreferencesProvider";
import { ToastProvider } from "@/components/ui/ToastProvider";
import { siteName, siteUrl } from "@/lib/env";

/**
 * The root layout.
 *
 * Deliberately THIN. It owns four things and nothing else: the fonts, the pre-paint theme boot, the
 * two providers that must exist exactly once in the whole tree, and the document-level metadata.
 * Everything visual — the header, the footer, the smooth-scroll rig — belongs to `app/(site)/layout`
 * so the studio can opt out of all of it.
 *
 * ⚠ MOUNT APP-WIDE PROVIDERS ONCE. A nested `ToastProvider` renders a second `aria-live` region and
 * a screen reader announces every toast twice; a nested `PreferencesProvider` shadows the real one,
 * so the theme toggle in the studio would stop moving the public site's theme (skill §1.7, §11.6).
 */

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE TYPE LIBRARY — twelve LOCAL variable faces.
 *
 * Never Google-hosted. A third-party font request on every page load is a blocking dependency on
 * someone else's uptime and a privacy leak on an institutional site, so every face here is a `.woff2`
 * committed to `fonts/` and fetched by `scripts/fetch-fonts.ts`, which refuses anything that is not
 * OFL or Apache-2.0. `lib/typography/fonts.ts` is the generated manifest and the one place a face is
 * *described* — what it is for, what its licence is, whether it has a real italic.
 *
 * `display: "swap"` on all of them: the fallback shows immediately and swaps when the face arrives.
 * For text-heavy pages that is the right trade — invisible text for three seconds is worse than one
 * reflow, and `adjustFontFallback` below keeps the reflow small.
 *
 * ── WHAT THIS COSTS, AND WHAT WAS DECIDED ────────────────────────────────────────────────────
 *
 * Twelve faces is 22 files and about 880 KB on disk. **No page fetches anything like that**, and the
 * reason is worth stating precisely, because the obvious reading of this file is alarming:
 *
 *  • A `localFont()` call emits `@font-face` rules and a class that sets one custom property. Putting
 *    that class on `<html>` costs a few bytes of CSS. **It does not fetch a font.** The browser fetches
 *    a file only when it has to paint a glyph that resolves to that family — so a face nothing on the
 *    page uses is never downloaded, which is exactly the behaviour an opt-in-per-block face wants.
 *
 *  • ⚠ **`preload` DEFAULTS TO TRUE, so omitting it is not neutral.** `preload: true` emits a
 *    `<link rel="preload" as="font">` for every route that imports the module — and this is the ROOT
 *    layout, so that means every route. Left at the default, these twelve faces would put 22
 *    high-priority font fetches, ~880 KB, in the head of every page, competing with the LCP image, for
 *    faces most pages never paint. **So every added face is `preload: false`.**
 *
 *  • **Inter and Jakarta stay `preload: true`.** Every page sets its body in Inter (`font-sans` on
 *    `<body>`) and its headings in Jakarta (`.display-title`), so those two files are on the critical
 *    path of every route and preloading them removes a round trip from first text. Flipping them to
 *    `false` to "save bytes" would save nothing and make every page paint its body copy in the fallback
 *    first — the one regression this whole arrangement exists to avoid.
 *
 *  • **What `preload: false` costs** is one round trip after CSS is applied, during which `swap` shows
 *    the metric-adjusted fallback. On an editorial face chosen for one block, that is the right trade.
 *    On the body face of every page, it would not be. That is the whole rule.
 *
 *  • `adjustFontFallback: "Times New Roman"` on the six serif faces makes Next synthesise the fallback
 *    from *serif* metrics rather than Arial's, so the swap moves the text far less. The sans, condensed
 *    and monospace faces keep the default (`"Arial"`), which is already the right shape for them.
 *
 * ⚠ **THE WEIGHT RANGES ARE WRITTEN OUT TWICE AND CANNOT BE DE-DUPLICATED.** Next's font plugin
 * evaluates these arguments at build time and rejects anything that is not a literal — `weight:
 * face.weightRange` fails with "Font loader values must be explicitly written literals". So the ranges
 * live here *and* in the manifest, and `scripts/fetch-fonts.ts` cross-checks every `variable` and every
 * `weightRange` against this file on every run. A face declared here with the wrong range is a face
 * whose heavier weights are silently clamped; a face missing here entirely is a picker offering a font
 * that renders as Georgia, with nothing anywhere saying why.
 *
 * ⚠ **A NEW FACE IS THREE EDITS, NOT ONE:** the `ROSTER` in `scripts/fetch-fonts.ts` (which fetches it
 * and writes the manifest), a `localFont()` call here, and a `fontFamily` key in `tailwind.config.ts`.
 * Miss the third and the class is purged; miss this one and the variable resolves to nothing. Neither
 * failure produces an error anywhere.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/* The two faces that were here first — the institutional voice, and the only two preloaded. */
const inter = localFont({
  src: "../fonts/inter-latin-var.woff2",
  variable: "--font-inter",
  display: "swap",
  weight: "100 900",
  preload: true,
  fallback: ["ui-sans-serif", "system-ui", "sans-serif"]
});

const jakarta = localFont({
  src: "../fonts/jakarta-latin-var.woff2",
  variable: "--font-jakarta",
  display: "swap",
  weight: "200 800",
  preload: true,
  fallback: ["ui-sans-serif", "system-ui", "sans-serif"]
});

/**
 * ── Text serifs ──────────────────────────────────────────────────────────────────────────────
 *
 * Each is declared with BOTH styles under one family, so `italic` on a serif passage selects the drawn
 * italic rather than shearing the roman. That is the whole reason a text serif was worth adding: a
 * synthesised oblique on a serif is visibly wrong, and it is what a book title in Inter looks like.
 */
const sourceSerif = localFont({
  src: [
    { path: "../fonts/source-serif-4-latin-var.woff2", weight: "200 900", style: "normal" },
    { path: "../fonts/source-serif-4-latin-var-italic.woff2", weight: "200 900", style: "italic" }
  ],
  variable: "--font-source-serif",
  display: "swap",
  /*
   * ⚠ THE ONLY ADDED FACE THAT IS PRELOADED, AND IT EARNED IT BY BECOMING THE DEFAULT BODY FACE.
   * The rule below still holds for the other nine: an opt-in face is fetched when a glyph is painted
   * with it, and preloading one a page does not use is bytes spent for nothing. But `houseTypesetSchema`
   * now defaults `bodyFace` to `source-serif-4`, so every page's running text is set in this file —
   * which is the exact condition that earns Inter and Jakarta their preloads. Leaving it `false` would
   * swap the body face of every page after first paint, on the primary reading surface.
   */
  preload: true,
  adjustFontFallback: "Times New Roman",
  fallback: ["ui-serif", "Georgia", "Cambria", "serif"]
});

const newsreader = localFont({
  src: [
    { path: "../fonts/newsreader-latin-var.woff2", weight: "200 800", style: "normal" },
    { path: "../fonts/newsreader-latin-var-italic.woff2", weight: "200 800", style: "italic" }
  ],
  variable: "--font-newsreader",
  display: "swap",
  preload: false,
  adjustFontFallback: "Times New Roman",
  fallback: ["ui-serif", "Georgia", "Cambria", "serif"]
});

const lora = localFont({
  src: [
    { path: "../fonts/lora-latin-var.woff2", weight: "400 700", style: "normal" },
    { path: "../fonts/lora-latin-var-italic.woff2", weight: "400 700", style: "italic" }
  ],
  variable: "--font-lora",
  display: "swap",
  preload: false,
  adjustFontFallback: "Times New Roman",
  fallback: ["ui-serif", "Georgia", "Cambria", "serif"]
});

const crimson = localFont({
  src: [
    { path: "../fonts/crimson-pro-latin-var.woff2", weight: "200 900", style: "normal" },
    { path: "../fonts/crimson-pro-latin-var-italic.woff2", weight: "200 900", style: "italic" }
  ],
  variable: "--font-crimson",
  display: "swap",
  preload: false,
  adjustFontFallback: "Times New Roman",
  fallback: ["ui-serif", "Georgia", "Cambria", "serif"]
});

/* ── Display serifs. Headline character; never a paragraph. ─────────────────────────────────── */
const fraunces = localFont({
  src: [
    { path: "../fonts/fraunces-latin-var.woff2", weight: "100 900", style: "normal" },
    { path: "../fonts/fraunces-latin-var-italic.woff2", weight: "100 900", style: "italic" }
  ],
  variable: "--font-fraunces",
  display: "swap",
  preload: false,
  adjustFontFallback: "Times New Roman",
  fallback: ["ui-serif", "Georgia", "Cambria", "serif"]
});

const playfair = localFont({
  src: [
    { path: "../fonts/playfair-display-latin-var.woff2", weight: "400 900", style: "normal" },
    { path: "../fonts/playfair-display-latin-var-italic.woff2", weight: "400 900", style: "italic" }
  ],
  variable: "--font-playfair",
  display: "swap",
  preload: false,
  adjustFontFallback: "Times New Roman",
  fallback: ["ui-serif", "Georgia", "Cambria", "serif"]
});

/**
 * ── Sans alternatives to Inter, and a condensed grotesque ────────────────────────────────────
 *
 * These fall back through `var(--font-inter)` before the system stack, exactly as `font-display` does:
 * if a chosen face has not arrived, the nearest thing already on the page is better than the OS default.
 */
const workSans = localFont({
  src: [
    { path: "../fonts/work-sans-latin-var.woff2", weight: "100 900", style: "normal" },
    { path: "../fonts/work-sans-latin-var-italic.woff2", weight: "100 900", style: "italic" }
  ],
  variable: "--font-work-sans",
  display: "swap",
  preload: false,
  fallback: ["ui-sans-serif", "system-ui", "sans-serif"]
});

const figtree = localFont({
  src: [
    { path: "../fonts/figtree-latin-var.woff2", weight: "300 900", style: "normal" },
    { path: "../fonts/figtree-latin-var-italic.woff2", weight: "300 900", style: "italic" }
  ],
  variable: "--font-figtree",
  display: "swap",
  preload: false,
  fallback: ["ui-sans-serif", "system-ui", "sans-serif"]
});

const archivoNarrow = localFont({
  src: [
    { path: "../fonts/archivo-narrow-latin-var.woff2", weight: "400 700", style: "normal" },
    { path: "../fonts/archivo-narrow-latin-var-italic.woff2", weight: "400 700", style: "italic" }
  ],
  variable: "--font-archivo-narrow",
  display: "swap",
  preload: false,
  fallback: ["ui-sans-serif", "system-ui", "sans-serif"]
});

/**
 * ── Monospace ────────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ This does NOT become `font-mono`. That key points at `--font-mono`, which nothing in the project
 * defines, so `font-mono` has always resolved to the reader's system monospace — and 83 places across
 * 40 files are set that way today, nearly all of them studio identifiers and JSON diffs. Defining
 * `--font-mono` here would restyle every one of them in a commit about adding fonts, and would change
 * the metrics of the audit log's `<pre>` blocks and the recovery-code inputs at the same time. So the
 * real face gets its own key, `font-jetbrains-mono`, and a screen opts in. See tailwind.config.ts.
 */
const jetbrainsMono = localFont({
  src: [
    { path: "../fonts/jetbrains-mono-latin-var.woff2", weight: "100 800", style: "normal" },
    { path: "../fonts/jetbrains-mono-latin-var-italic.woff2", weight: "100 800", style: "italic" }
  ],
  variable: "--font-jetbrains-mono",
  display: "swap",
  preload: false,
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"]
});

/**
 * Every face's variable class, on `<html>`, so any block anywhere can name any face.
 *
 * A list rather than a template literal because there are twelve of them and a missing `${}` in a
 * hand-built string is a face that resolves to nothing on every page with no error. These are
 * `next/font`'s own generated class names — nothing here is a Tailwind class, so nothing here is
 * subject to the purge.
 */
const TYPE_LIBRARY = [
  inter,
  jakarta,
  sourceSerif,
  newsreader,
  lora,
  crimson,
  fraunces,
  playfair,
  workSans,
  figtree,
  archivoNarrow,
  jetbrainsMono
];

const fontVariableClasses = TYPE_LIBRARY.map((face) => face.variable).join(" ");

export function generateMetadata(): Metadata {
  const url = siteUrl();
  const name = siteName();
  return {
    metadataBase: new URL(url),
    title: {
      default: name,
      // Every page's own title is appended to the institution's name, so a browser tab, a bookmark
      // and a search result all identify the Centre without each page having to remember to.
      template: `%s · ${name}`
    },
    description:
      "The research, people, publications and living archive of the Centre of Excellence.",
    applicationName: name,
    openGraph: { type: "website", siteName: name, url, locale: "en_IN" },
    twitter: { card: "summary_large_image" },
    robots: { index: true, follow: true }
    // `icons` is deliberately ABSENT. Next derives the <link rel> tags from the file convention —
    // app/icon.svg and app/apple-icon.tsx — and writes them with content-hashed URLs. Declaring them
    // here as well emits a SECOND, unhashed pair pointing at paths that are not served, which is a
    // 404 in every page's <head> and a browser that falls back to no icon at all.
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The PRE-JS fallback only. `applyPreferences()` strips the `media` attributes and rewrites
  // `content` the moment the boot script runs — see lib/preferences.ts.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLOR.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLOR.dark }
  ],
  colorScheme: "light dark"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `suppressHydrationWarning` is INTENTIONAL: the boot script writes attributes React did not
    // render. Removing it floods the console; removing the script flashes the light theme on every
    // load. The two go together.
    <html lang="en" suppressHydrationWarning className={fontVariableClasses}>
      <body className="min-h-screen bg-bg-0 font-sans text-ink-900 antialiased">
        {/*
          FIRST, BLOCKING child of <body>. It must run before the first paint, which is why it is a
          raw script tag rather than a component: a Next `<Script>` with any strategy runs later.
        */}
        <script dangerouslySetInnerHTML={{ __html: PREFERENCES_BOOT_SCRIPT }} />
        <PreferencesProvider>
          <ToastProvider>{children}</ToastProvider>
        </PreferencesProvider>
      </body>
    </html>
  );
}
