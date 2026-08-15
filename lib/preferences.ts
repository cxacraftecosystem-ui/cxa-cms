/**
 * Viewer preferences: theme and the three accessibility modes.
 *
 * CLIENT-SAFE (no `server-only`) — the boot script, the provider and the settings panel all use it.
 *
 * Everything is driven by ATTRIBUTES ON `<html>`, never by class names on a container:
 *
 *   data-theme="light" | "dark"        — always present after boot
 *   data-reduced-motion="true"         — present only when ON, removed when off
 *   data-larger-text="true"            — ditto
 *   data-high-contrast="true"          — ditto
 *
 * The "present only when on" rule matters. `tailwind.config.ts` sets
 * `darkMode: ["class", '[data-theme="dark"]']`, so `dark:` compiles to `:is([data-theme="dark"] *)`
 * and — this is the trap — **`class="dark"` on a container does nothing.** `dark:` is an EXCEPTION
 * mechanism for the handful of cases a token cannot express, not the theming mechanism.
 *
 * And there is deliberately NO `[data-reduced-motion="false"]` rule in globals.css: the in-app
 * toggle can only ever ADD reduction on top of the operating system's preference, never undo it.
 */

export const PREFERENCES_STORAGE_KEY = "cxa_preferences";

export type ThemeChoice = "light" | "dark" | "system";

export interface Preferences {
  theme: ThemeChoice;
  reducedMotion: boolean;
  largerText: boolean;
  highContrast: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  reducedMotion: false,
  largerText: false,
  highContrast: false
};

/**
 * The `<meta name="theme-color">` values, KEPT IN STEP WITH `--bg-0` BY HAND.
 *
 * There is no way to read a CSS custom property before paint, so these two hex strings duplicate the
 * first line of each theme block in globals.css. Change one, change the other — a mismatch shows as
 * a strip of the wrong colour behind a phone's status bar.
 */
export const THEME_COLOR = { light: "#f7f6fb", dark: "#110f19" } as const;

export function parsePreferences(raw: unknown): Preferences {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PREFERENCES };
  const source = raw as Partial<Record<keyof Preferences, unknown>>;
  const theme = source.theme;
  return {
    theme: theme === "light" || theme === "dark" || theme === "system" ? theme : "system",
    reducedMotion: source.reducedMotion === true,
    largerText: source.largerText === true,
    highContrast: source.highContrast === true
  };
}

export function readStoredPreferences(): Preferences {
  if (typeof window === "undefined") return { ...DEFAULT_PREFERENCES };
  try {
    const raw = window.localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    return parsePreferences(JSON.parse(raw));
  } catch {
    // localStorage THROWS when blocked (Safari private mode, an enterprise policy, a sandboxed
    // iframe). An exception here would leave the whole page unstyled, so the default is returned and
    // the reader simply gets the system theme.
    return { ...DEFAULT_PREFERENCES };
  }
}

export function writeStoredPreferences(preferences: Preferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Same reason as above: a preference that cannot be persisted must still apply for this visit.
  }
}

export function resolveTheme(choice: ThemeChoice): "light" | "dark" {
  if (choice === "light" || choice === "dark") return choice;
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Write the preferences onto `<html>`, and update the theme-color meta tag.
 *
 * The meta pair in `viewport` is only the PRE-JS fallback; this strips its `media` attribute and
 * rewrites `content`, because two `theme-color` tags with media queries plus a third without them is
 * ambiguous and browsers disagree about which wins.
 */
export function applyPreferences(preferences: Preferences): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const theme = resolveTheme(preferences.theme);

  root.setAttribute("data-theme", theme);
  toggleAttribute(root, "data-reduced-motion", preferences.reducedMotion);
  toggleAttribute(root, "data-larger-text", preferences.largerText);
  toggleAttribute(root, "data-high-contrast", preferences.highContrast);

  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  metas.forEach((meta) => {
    meta.removeAttribute("media");
    meta.setAttribute("content", THEME_COLOR[theme]);
  });
}

function toggleAttribute(element: HTMLElement, name: string, on: boolean): void {
  // Present-or-absent, never `="false"`. See the note at the top of this file.
  if (on) element.setAttribute(name, "true");
  else element.removeAttribute(name);
}

/**
 * The pre-hydration boot script.
 *
 * Rendered as the FIRST, BLOCKING child of `<body>` in app/layout.tsx. Without it every load flashes
 * the light theme before React hydrates; without `suppressHydrationWarning` on `<html>` the
 * attributes it writes flood the console with hydration mismatches. Both are intentional and one
 * cannot be removed without the other.
 *
 * Written as a string of ES5 inside a try/catch: it runs before any bundle, on whatever the reader's
 * browser is, and a syntax error here is a blank page.
 */
export const PREFERENCES_BOOT_SCRIPT = `(function(){try{
var d=document.documentElement;
var raw=null;try{raw=window.localStorage.getItem(${JSON.stringify(PREFERENCES_STORAGE_KEY)});}catch(e){}
var p={};if(raw){try{p=JSON.parse(raw)||{};}catch(e){p={};}}
var t=p.theme;
if(t!=="light"&&t!=="dark"){t=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}
d.setAttribute("data-theme",t);
if(p.reducedMotion===true){d.setAttribute("data-reduced-motion","true");}
if(p.largerText===true){d.setAttribute("data-larger-text","true");}
if(p.highContrast===true){d.setAttribute("data-high-contrast","true");}
var m=document.querySelectorAll('meta[name="theme-color"]');
for(var i=0;i<m.length;i++){m[i].removeAttribute("media");m[i].setAttribute("content",t==="dark"?${JSON.stringify(THEME_COLOR.dark)}:${JSON.stringify(THEME_COLOR.light)});}
}catch(e){}})();`;
