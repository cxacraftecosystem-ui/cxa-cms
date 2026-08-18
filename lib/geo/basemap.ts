/**
 * Which basemap every map on this site draws, decided in one place.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * MAPTILER IS THE BASEMAP WHEREVER A MAP DRAWS GEOGRAPHY. That is a product decision and this module
 * is where it is enforced, because it was previously true of ONE studio screen and of nothing else:
 * `MapPointPicker` built a MapTiler style URL inline, and the two public maps built a raster style
 * from `NEXT_PUBLIC_MAP_TILE_URL` — so an editor placed a pin on MapTiler's vector tiles and a reader
 * saw the same place on OpenStreetMap's raster ones, in different colours, with different labels, at
 * different zoom ceilings. Three copies of "what a map looks like" is three answers.
 *
 * ⚠ THE ONE EXCEPTION IS THE HAND-DRAWN INDIA OUTLINE, and it is not a basemap at all.
 * `components/map/IndiaMap.tsx` and `components/map/indiaGeometry.ts` draw the official depiction of
 * the country as SVG paths — no tiles, no network, no key, and a boundary this institution is
 * required to render exactly. Nothing here applies to it and nothing here should be made to.
 *
 * ⚠ THE RASTER FALLBACK IS KEPT AND IS NOT A SECOND OPINION. A build with no `NEXT_PUBLIC_MAPTILER_API_KEY`
 * is a legitimate deployment — CI runs as one — and a public page whose map is a grey rectangle is a
 * worse outcome than one drawn on OpenStreetMap's own tiles. So the key decides, and the absence of a
 * key degrades to something that still works rather than to nothing. `mapTilerConfigured()` is how a
 * caller can say which it got.
 *
 * ⚠ ATTRIBUTION IS NOT OPTIONAL AND IT CHANGES WITH THE SOURCE. MapTiler's terms require both MapTiler
 * and OpenStreetMap to be credited; the raster path credits OpenStreetMap alone. `basemapAttribution()`
 * returns the right line for whichever is in force, so a caller cannot print one while drawing the
 * other.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ EVERY `process.env.NEXT_PUBLIC_*` HERE IS WRITTEN OUT IN FULL. Next's build-time substitution is a
 * literal text replacement; a dynamic lookup like `process.env[name]` is NOT substituted and reads
 * `undefined` in the browser. That is the trap `lib/media/url.ts` documents for the CDN base, and here
 * it would show as every map on the site rendering grey with a 403 on every tile.
 *
 * No `server-only` and no `"use client"`: a Server Component reads `basemapAttribution()` to print the
 * credit line beneath a map it does not itself draw.
 */

const MAPTILER_KEY = (process.env.NEXT_PUBLIC_MAPTILER_API_KEY ?? "").trim();

/**
 * The MapTiler style every map uses.
 *
 * `streets-v2` rather than one of the decorative styles: these maps exist to answer "where is this
 * place and how do I get to it", which needs roads, place names and a legible label hierarchy. It is
 * also the style `MapPointPicker` has always used, so the map an editor drops a pin on and the map a
 * reader sees are now the same map — which is the whole point of this module.
 */
const MAPTILER_STYLE = "streets-v2";

/** OpenStreetMap's own tiles. The fallback for a build with no key — see the header. */
const DEFAULT_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const DEFAULT_ATTRIBUTION = "© OpenStreetMap contributors";

/** The raster source, still configurable for a deployment that runs its own tile server. */
export const RASTER_TILE_URL =
  (process.env.NEXT_PUBLIC_MAP_TILE_URL ?? "").trim() || DEFAULT_TILE_URL;

const RASTER_ATTRIBUTION =
  (process.env.NEXT_PUBLIC_MAP_ATTRIBUTION ?? "").trim() || DEFAULT_ATTRIBUTION;

/**
 * Is there a MapTiler key in this build?
 *
 * Exported so a caller can say WHICH map it is showing, and so the studio's pin pickers can decide
 * whether to offer a map at all rather than opening one onto a grey rectangle.
 */
export function mapTilerConfigured(): boolean {
  return MAPTILER_KEY.length > 0;
}

/**
 * The MapTiler style URL, or null when there is no key.
 *
 * ⚠ A CALLER MUST BRANCH ON NULL RATHER THAN INTERPOLATING AN EMPTY KEY. `…/style.json?key=` is a
 * perfectly well-formed URL that MapTiler answers with a 403, and maplibre reports that as a style
 * that failed to load — a grey box with a console error, which is the one outcome the fallback exists
 * to prevent.
 */
export function mapTilerStyleUrl(): string | null {
  if (!mapTilerConfigured()) return null;
  return `https://api.maptiler.com/maps/${MAPTILER_STYLE}/style.json?key=${MAPTILER_KEY}`;
}

/**
 * The raster style specification, for the no-key fallback.
 *
 * Typed structurally rather than as maplibre's `StyleSpecification`, because this module must not
 * import `maplibre-gl`: that package is around a megabyte and every caller loads it inside an effect
 * precisely so it stays off the critical path (see `MapSection`'s header). A type-only import would be
 * erased and safe, but the shape below is small enough to state, and stating it keeps this module
 * importable by a Server Component that only wants the attribution line.
 */
export interface RasterBasemapStyle {
  version: 8;
  sources: {
    basemap: { type: "raster"; tiles: string[]; tileSize: number; maxzoom: number };
  };
  layers: { id: string; type: "raster"; source: string }[];
}

export function rasterBasemapStyle(): RasterBasemapStyle {
  return {
    version: 8,
    sources: {
      basemap: {
        type: "raster",
        tiles: [RASTER_TILE_URL],
        tileSize: 256,
        // Most raster schemes stop at 19; asking for 20 returns 404s that look like a broken map.
        maxzoom: 19
      }
    },
    layers: [{ id: "basemap", type: "raster", source: "basemap" }]
  };
}

/**
 * The credit line for whichever basemap is in force.
 *
 * ⚠ IT IS RENDERED AS REAL HTML BENEATH THE CANVAS on both public maps, rather than through maplibre's
 * own attribution control, so it is themed, selectable, and still legible when the map never draws.
 * That is why this returns a string rather than being left to the map library.
 */
export function basemapAttribution(): string {
  return mapTilerConfigured() ? "© MapTiler © OpenStreetMap contributors" : RASTER_ATTRIBUTION;
}
