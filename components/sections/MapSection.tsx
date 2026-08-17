"use client";

/**
 * MapSection — a pin on a map with the postal address beneath it, and `MapCanvas`, the reusable map
 * the craft explorer uses too.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ADDRESS IS THE INFORMATION. THE MAP IS A CONVENIENCE.
 *
 * The text block underneath is rendered unconditionally — before the map has loaded, when WebGL is
 * unavailable, when the tile server is down, when the reader is on a metered connection with images
 * off, and when there are no coordinates at all. Nobody has ever needed to know where a building is
 * and been helped by an empty grey rectangle.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE STYLE IS BUILT INLINE, as a single raster source. A hosted style JSON is the usual way to get a
 * map and it is also an API key, a rate limit, a third-party outage and a request to somebody else's
 * server on every page view. A raster tile URL is none of those things: it needs no key and no
 * account, and swapping the provider is one environment variable.
 *
 * ⚠ THE DEFAULT IS OPENSTREETMAP'S OWN TILE SERVER, and OSM's tile usage policy is explicitly not
 * suitable for heavy production traffic — it is a volunteer-funded service intended for development
 * and low-volume use. A deployment that expects real traffic MUST point
 * `NEXT_PUBLIC_MAP_TILE_URL` at its own tile server or a commercial one (MapTiler, Stadia, Protomaps,
 * a self-hosted renderer) and set `NEXT_PUBLIC_MAP_ATTRIBUTION` to match. Leaving the default in
 * place at volume is discourteous and will eventually be blocked.
 *
 * ⚠ Both variables are written out IN FULL as `process.env.NEXT_PUBLIC_*`. Next's substitution is a
 * literal text replacement; a dynamic lookup like `process.env[name]` is not substituted and reads
 * `undefined` in the browser (the same trap `lib/media/url.ts` documents for the CDN base).
 *
 * THE LIBRARY AND ITS STYLESHEET ARE LOADED INSIDE THE EFFECT, not at the top of the file.
 * `SectionRenderer` imports every renderer statically, so a top-level `import "maplibre-gl"` would
 * put ~800 KB of WebGL mapping code and ~25 KB of CSS into the bundle of every page on the site,
 * including the ones with no map on them. Deferring the import to the effect is also what makes this
 * `ssr: false` — nothing touches `window` until after mount.
 *
 * THE PINS ARE A CIRCLE LAYER, NOT DOM MARKERS, and they are not interactive. Text labels would need
 * a `glyphs` endpoint, which is a hosted font service and reintroduces exactly the dependency the
 * inline style exists to remove. Interactivity would need every pin to be a real control inside a
 * canvas that has none — so the LIST BENEATH THE MAP carries the links instead. The map is a picture
 * of where things are; the list is the interface (contract §11).
 *
 * `map.remove()` on unmount is not tidiness. A leaked WebGL context survives a client-side
 * navigation, and browsers cap them at around sixteen: a reader who opens six pages with maps on them
 * eventually gets a blank canvas and a console warning on a page that has nothing wrong with it.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PageSection } from "@prisma/client";
import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
import { ExternalLink, MapPin } from "lucide-react";

import { Reveal } from "@/components/motion";
import { SectionHeading } from "@/components/site/SectionHeading";
import { LinkButton } from "@/components/ui/Button";
import type { MapSectionData } from "@/lib/sections/schema";
import { cn } from "@/lib/utils";

/** OpenStreetMap's own tiles. Development and low volume only — see the header. */
const DEFAULT_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const DEFAULT_ATTRIBUTION = "© OpenStreetMap contributors";

const TILE_URL = (process.env.NEXT_PUBLIC_MAP_TILE_URL ?? "").trim() || DEFAULT_TILE_URL;
const TILE_ATTRIBUTION =
  (process.env.NEXT_PUBLIC_MAP_ATTRIBUTION ?? "").trim() || DEFAULT_ATTRIBUTION;

/**
 * purple-700, resolved to sRGB.
 *
 * A WebGL paint property cannot read a CSS custom property and maplibre's colour parser does not
 * accept `oklch()`, so the one action colour has to be written here as the hex it renders to. If the
 * purple ramp in tailwind.config.ts ever moves, this moves with it.
 */
const PIN_FILL = "#772cb1";

export type MapHeight = "sm" | "md" | "lg";

/** Complete literal class strings — a height built by concatenation is purged (contract §5). */
const HEIGHT_CLASS: Record<MapHeight, string> = {
  sm: "h-64",
  md: "h-[26rem]",
  lg: "h-[34rem]"
};

export interface MapPoint {
  id: string;
  latitude: number;
  longitude: number;
  /** What the pin is. Rendered in the list beneath the map, never on the canvas. */
  label: string;
}

export interface MapCanvasProps {
  points: readonly MapPoint[];
  /** Where to open. Omitted, the map fits every point; with one point, it centres on it. */
  center?: { latitude: number; longitude: number };
  zoom?: number;
  height?: MapHeight;
  /** Names the map for a screen reader — "Map of the Centre", "Map of craft regions". */
  label: string;
  className?: string;
}

/**
 * The map itself. Renders an empty framed box until it has mounted and the library has loaded, so
 * nothing below it moves when the canvas appears.
 *
 * Exported because the craft explorer needs the same map with many pins; the section below is one
 * caller of it, not its owner.
 */
export function MapCanvas({
  points,
  center,
  zoom = 13,
  height = "md",
  label,
  className
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  /**
   * The effect's dependencies are STRINGS AND NUMBERS, never the `points` array itself.
   *
   * A parent that rebuilds its array literal on every render — which every parent does — would
   * otherwise tear the map down and build a new one several times a second. Serialising the only
   * thing the effect actually reads (the coordinates; the labels are never drawn on the canvas, see
   * the header) makes the dependency exact instead of merely present.
   */
  const pointsJson = JSON.stringify(points.map((point) => [point.longitude, point.latitude]));
  const centreLng = center?.longitude ?? null;
  const centreLat = center?.latitude ?? null;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const coordinates = JSON.parse(pointsJson) as [number, number][];

    // A fresh attempt clears the last one's verdict. Without this a map that failed once keeps its
    // "could not be loaded" line for the rest of the page's life, even after a successful rebuild.
    setFailed(false);

    let map: MapLibreMap | null = null;
    // The imports below are asynchronous, so the component can be unmounted before they resolve. A
    // map created after that would attach to a detached node and never be torn down.
    let cancelled = false;

    const start = async () => {
      let maplibre: typeof import("maplibre-gl");
      try {
        // Started before the library so the two chunks download in parallel, and awaited after it so
        // the stylesheet is in the document before the first control is drawn. The import is typed by
        // types/css-side-effect.d.ts, which is why it needs no suppression.
        const stylesheet: Promise<unknown> = import("maplibre-gl/dist/maplibre-gl.css");
        maplibre = await import("maplibre-gl");
        await stylesheet;
      } catch {
        // The chunk failed to load — an offline reader, a blocked CDN, a deploy mid-flight. The
        // address beneath the map is still there, which is the whole point of rendering it always.
        if (!cancelled) setFailed(true);
        return;
      }

      if (cancelled) return;

      const style: StyleSpecification = {
        version: 8,
        sources: {
          basemap: {
            type: "raster",
            tiles: [TILE_URL],
            tileSize: 256,
            // Most raster schemes stop at 19; asking for 20 returns 404s that look like a broken map.
            maxzoom: 19
          }
        },
        layers: [{ id: "basemap", type: "raster", source: "basemap" }]
      };

      const first = coordinates[0];
      const origin: [number, number] | null =
        centreLng !== null && centreLat !== null ? [centreLng, centreLat] : (first ?? null);

      try {
        map = new maplibre.Map({
          container,
          style,
          // 0, 20 at zoom 1 is "the whole world", which is the only honest thing to show when there
          // is nothing to centre on.
          center: origin ?? [0, 20],
          zoom: origin ? zoom : 1,
          // Ours is rendered as real HTML beneath the canvas, where it is themed, selectable and
          // still legible if the map never draws.
          attributionControl: false,
          // A page-scroll gesture over a map must scroll the page. Without this, a reader swiping
          // past the map on a phone zooms it instead and loses their place in the article.
          cooperativeGestures: true
        });
      } catch {
        if (!cancelled) setFailed(true);
        return;
      }

      map.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");

      // A tile 404 or a WebGL warning is not worth blanking the map for; a failure to create the
      // context already threw above. This keeps maplibre's own errors out of the console noise.
      map.on("error", () => undefined);

      map.on("load", () => {
        if (cancelled || !map) return;

        if (coordinates.length > 0) {
          map.addSource("points", {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: coordinates.map(([longitude, latitude]) => ({
                type: "Feature" as const,
                properties: {},
                geometry: { type: "Point" as const, coordinates: [longitude, latitude] }
              }))
            }
          });

          // Two circles: a white halo under a purple dot, so a pin reads against both a pale street
          // map and a dark satellite one without a second colour being introduced.
          map.addLayer({
            id: "points-halo",
            type: "circle",
            source: "points",
            paint: { "circle-radius": 9, "circle-color": "#ffffff", "circle-opacity": 0.9 }
          });
          map.addLayer({
            id: "points-fill",
            type: "circle",
            source: "points",
            paint: { "circle-radius": 6, "circle-color": PIN_FILL }
          });
        }

        if (origin === first && coordinates.length > 1 && first) {
          const bounds = new maplibre.LngLatBounds(first, first);
          for (const coordinate of coordinates) bounds.extend(coordinate);
          // `animate: false` — this runs on load, and a map that flies to its own contents the
          // instant it appears is motion nobody asked for, in a component with no reduced-motion
          // branch to switch it off.
          map.fitBounds(bounds, { padding: 56, maxZoom: 14, animate: false });
        }
      });
    };

    void start();

    return () => {
      cancelled = true;
      // Frees the WebGL context, the tile requests and every listener in one call.
      map?.remove();
      map = null;
    };
  }, [centreLat, centreLng, pointsJson, zoom]);

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-lg border border-line-200 bg-surface-100",
        HEIGHT_CLASS[height],
        className
      )}
    >
      <div
        ref={containerRef}
        // `group` and NOT `img`. The obvious choice reads well — the map is a picture — but `img`
        // removes everything inside it from the accessibility tree, and inside it are the zoom
        // buttons. `group` names the area and leaves its controls reachable. Everything the map shows
        // is repeated as text below, so nothing here is available only to someone who can see it.
        role="group"
        aria-label={label}
        className="h-full w-full"
      />

      {failed ? (
        <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-ink-500">
          The map could not be loaded. The address and links below still work.
        </p>
      ) : null}
    </div>
  );
}

/** The attribution line. Real HTML rather than maplibre's control — see `attributionControl` above. */
export function MapAttribution({ className }: { className?: string }) {
  return (
    <p className={cn("mt-2 text-xs text-ink-500", className)}>
      Map data {TILE_ATTRIBUTION}
    </p>
  );
}

export interface MapSectionProps {
  data: MapSectionData;
  section: PageSection;
}

/**
 * 0, 0 is a real place — open ocean in the Gulf of Guinea — and it is also the value a MAP block has
 * the moment it is dropped onto a page, before anyone has pasted coordinates in. Treating it as "not
 * set yet" is the difference between showing the address and showing the Atlantic (see the note on
 * `mapSectionSchema` in lib/sections/schema.ts).
 */
function hasLocation(data: MapSectionData): boolean {
  return data.latitude !== 0 || data.longitude !== 0;
}

export function MapSection({ data, section }: MapSectionProps) {
  const located = hasLocation(data);
  const address = data.address.trim();
  const hasHeading = data.heading.trim().length > 0;

  const osmHref = located
    ? `https://www.openstreetmap.org/?mlat=${data.latitude}&mlon=${data.longitude}#map=${data.zoom}/${data.latitude}/${data.longitude}`
    : null;

  const points: MapPoint[] = located
    ? [
        {
          id: "primary",
          latitude: data.latitude,
          longitude: data.longitude,
          label: data.markerLabel || address || "This location"
        }
      ]
    : [];

  return (
    <section id={`block-${section.id}`} className="py-20 md:py-28">
      <div className="shell">
        {/*
          A HEADING IS NOT FORCED HERE, unlike in the FAQ, the timeline, the feature grid and the
          figures. Nothing inside this block is a heading — the map carries its own accessible name and
          the address is a plain list beside it — so a block with neither a heading nor an introduction
          skips no level in the page outline (contract §11). Where there IS an introduction, the heading
          below owns it, and "Find us" is taken off screen if the editor cleared the words.
        */}
        {hasHeading || data.body ? (
          <Reveal>
            <SectionHeading
              title={hasHeading ? data.heading : "Find us"}
              description={data.body || undefined}
              className="mb-10"
              titleClassName={hasHeading ? undefined : "sr-only"}
            />
          </Reveal>
        ) : null}

        {located ? (
          <Reveal>
            <MapCanvas
              points={points}
              center={{ latitude: data.latitude, longitude: data.longitude }}
              zoom={data.zoom}
              height={data.height}
              label={
                data.markerLabel
                  ? `Map showing ${data.markerLabel}`
                  : "Map showing this location"
              }
            />
            <MapAttribution />
          </Reveal>
        ) : null}

        <Reveal
          as="div"
          className={cn(
            "flex flex-col gap-5 rounded-lg border border-line-200 bg-card p-6 sm:flex-row sm:items-start sm:justify-between",
            located ? "mt-6" : undefined
          )}
        >
          <div className="flex min-w-0 gap-3">
            <MapPin aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-purple-700" />
            <div className="min-w-0">
              {data.markerLabel ? (
                <p className="font-display text-base font-semibold text-ink-900">
                  {data.markerLabel}
                </p>
              ) : null}

              {address ? (
                // `whitespace-pre-line` keeps the line breaks an administrator typed. An address is
                // written on several lines by everyone who has ever written one.
                <address
                  className={cn(
                    "whitespace-pre-line text-sm not-italic leading-relaxed text-ink-700",
                    data.markerLabel ? "mt-1" : undefined
                  )}
                >
                  {address}
                </address>
              ) : (
                <p className="text-sm leading-relaxed text-ink-500">
                  No address has been added to this block yet.
                </p>
              )}

              {!located ? (
                <p className="mt-2 text-sm text-ink-500">
                  No map position has been set for this address yet.
                </p>
              ) : null}
            </div>
          </div>

          <MapLinks directionsHref={data.directionsHref} osmHref={osmHref} />
        </Reveal>
      </div>
    </section>
  );
}

function MapLinks({
  directionsHref,
  osmHref
}: {
  directionsHref: string;
  osmHref: string | null;
}): ReactNode {
  if (!directionsHref && !osmHref) return null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3">
      {directionsHref ? (
        <LinkButton href={directionsHref} variant="secondary" newTab icon={ExternalLink}>
          Get directions
        </LinkButton>
      ) : null}

      {osmHref ? (
        <a
          href={osmHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-purple-700 transition-colors hover:text-purple-800"
        >
          Open in OpenStreetMap
          <ExternalLink aria-hidden="true" className="h-4 w-4" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : null}
    </div>
  );
}
