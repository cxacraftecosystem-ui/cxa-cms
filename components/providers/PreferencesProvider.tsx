"use client";

/**
 * PreferencesProvider — the single owner of theme and the three accessibility modes.
 *
 * MOUNTED EXACTLY ONCE, in app/layout.tsx. A second instance nested anywhere would shadow this one
 * for its subtree, so the studio's theme toggle would stop moving the public site's theme and the two
 * halves of the product would disagree about which palette is current.
 *
 * THIS PROVIDER DOES NOT DRIVE THE DOM ON FIRST RENDER — IT CATCHES UP WITH IT.
 * `PREFERENCES_BOOT_SCRIPT` has already stamped `data-theme` / `data-reduced-motion` /
 * `data-larger-text` / `data-high-contrast` onto `<html>` before first paint, reading the same
 * localStorage key. So state starts at `DEFAULT_PREFERENCES` — a value the server can also produce —
 * and a mount effect adopts what is actually stored. Seeding state from localStorage in the
 * initialiser instead would make the client's first render disagree with the server's markup, which
 * is a hydration error, and it would buy nothing: the attributes are already correct.
 *
 * The consequence to design around: for one render `resolvedTheme` is "light" even on a dark device.
 * Anything that renders a theme-dependent GLYPH (a sun/moon toggle) will settle on mount. Do not use
 * `resolvedTheme` to decide an `initial` animation state on a prerendered page — see contract §8.
 *
 * Every write goes through `commit()`, which does all three things at once: React state (so the UI
 * re-renders), `applyPreferences` (so `<html>` matches) and `writeStoredPreferences` (so the next
 * load's boot script matches). Doing two of the three is how a toggle "works" until you reload.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";

import {
  DEFAULT_PREFERENCES,
  applyPreferences,
  readStoredPreferences,
  writeStoredPreferences,
  type Preferences,
  type ThemeChoice
} from "@/lib/preferences";

export interface PreferencesContextValue {
  /** The stored choice. `theme` may be "system"; see `resolvedTheme` for what is actually painted. */
  preferences: Preferences;
  setPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  setTheme: (choice: ThemeChoice) => void;
  /** "system" collapsed against the OS query — always the palette on screen right now. */
  resolvedTheme: "light" | "dark";
  /** Flips to the opposite of what is on screen, which pins the choice to an explicit light/dark. */
  toggleTheme: () => void;
}

/**
 * A NAMED error, not a bare `throw new Error("...")` and emphatically not a silent `undefined`.
 *
 * A component that reads `undefined` here renders with default preferences: it looks almost right,
 * in the wrong theme, with no toggle working and nothing in the console to say why. The name is what
 * makes the stack trace answer the question on sight.
 */
export class PreferencesContextError extends Error {
  constructor() {
    super(
      "usePreferences() was called outside PreferencesProvider. Mount PreferencesProvider once in app/layout.tsx, above every component that reads or writes a preference."
    );
    this.name = "PreferencesContextError";
  }
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [systemDark, setSystemDark] = useState(false);
  // Until this is true the DOM is authoritative and this component knows nothing. Applying
  // DEFAULT_PREFERENCES before adoption would strip the attributes the boot script just wrote —
  // a visible flash of the wrong theme one tick after paint.
  const [adopted, setAdopted] = useState(false);

  useEffect(() => {
    setPreferences(readStoredPreferences());
    setAdopted(true);
  }, []);

  /**
   * The OS palette, held as STATE rather than read on demand.
   *
   * `resolveTheme()` in lib/preferences answers the same question, but it reads `matchMedia` at call
   * time and therefore cannot make React re-render when the reader flips their device to dark at
   * dusk. The subscription below can.
   */
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(query.matches);
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme: "light" | "dark" =
    preferences.theme === "system" ? (systemDark ? "dark" : "light") : preferences.theme;

  /**
   * Re-stamp `<html>` when the operating system moves underneath a "system" choice.
   *
   * Only "system" needs this: an explicit light or dark choice was pinned by `commit()` and does not
   * follow the device. The resolved theme is passed in explicitly rather than letting
   * `applyPreferences` re-query, so the attribute can never disagree with the `resolvedTheme` this
   * render handed to consumers. The STORED value is untouched — it stays "system".
   */
  useEffect(() => {
    if (!adopted || preferences.theme !== "system") return;
    applyPreferences({ ...preferences, theme: systemDark ? "dark" : "light" });
  }, [adopted, preferences, systemDark]);

  const commit = useCallback((next: Preferences) => {
    setPreferences(next);
    applyPreferences(next);
    writeStoredPreferences(next);
  }, []);

  const setPreference = useCallback(
    <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
      // Copy then assign, rather than a computed-key spread: TypeScript widens
      // `{ ...preferences, [key]: value }` and loses the `Preferences` shape.
      const next: Preferences = { ...preferences };
      next[key] = value;
      commit(next);
    },
    [commit, preferences]
  );

  const setTheme = useCallback(
    (choice: ThemeChoice) => {
      commit({ ...preferences, theme: choice });
    },
    [commit, preferences]
  );

  const toggleTheme = useCallback(() => {
    // Deliberately leaves "system" behind. A reader who reaches for the toggle is asking for the
    // other palette now, not for a rule that will change it again at sunset.
    commit({ ...preferences, theme: resolvedTheme === "dark" ? "light" : "dark" });
  }, [commit, preferences, resolvedTheme]);

  const value = useMemo<PreferencesContextValue>(
    () => ({ preferences, setPreference, setTheme, resolvedTheme, toggleTheme }),
    [preferences, setPreference, setTheme, resolvedTheme, toggleTheme]
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesContextValue {
  const value = useContext(PreferencesContext);
  if (value === null) throw new PreferencesContextError();
  return value;
}
