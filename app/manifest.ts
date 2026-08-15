import type { MetadataRoute } from "next";
import { siteName } from "@/lib/env";

/**
 * The web app manifest.
 *
 * Modest by intent. This is a research institution's website, not an application: `display:
 * "browser"` keeps an installed shortcut in a normal browser window, with its address bar and its
 * back button. A standalone window on a site that is mostly long-form reading and outbound citation
 * links takes away exactly the controls a reader needs and gives nothing back.
 *
 * The `theme_color` duplicates `--bg-0`'s light value, kept in step by hand with lib/preferences.ts's
 * `THEME_COLOR` and the first line of `:root` in globals.css. There is no way to read a CSS custom
 * property from here, so the three are a triple that must move together.
 */
export default function manifest(): MetadataRoute.Manifest {
  const name = siteName();
  return {
    name,
    short_name: name.length > 12 ? "Centre" : name,
    description: "Research, people, publications and a living archive.",
    start_url: "/",
    display: "browser",
    background_color: "#f7f6fb",
    theme_color: "#f7f6fb",
    lang: "en-IN",
    categories: ["education", "reference"],
    icons: [
      {
        // The SVG serves every size a browser will ask for, so there is one file to keep correct.
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any"
      }
    ]
  };
}
