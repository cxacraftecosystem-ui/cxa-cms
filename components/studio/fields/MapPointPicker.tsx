"use client";

/**
 * The map, and the one place in this repository that loads it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ PORTED FROM `D:/Portal_Development_Designer/frontend/components/forms/MapPointPicker.tsx`. The
 * behaviour and the reasoning are that file's; the imports are rewired to this project's module layout.
 *
 * MapLibre is by far the largest thing this application can pull down — around a megabyte, several times
 * the next biggest chunk — and it sits behind a control that starts closed on every form that offers it. A
 * static import would put all of it on the critical path of every studio page carrying a coordinate field.
 *
 * The loader lives here rather than in a caller so that two callers cannot mean two module-level promise
 * caches, and therefore two downloads of the same megabyte in one session for an editor who opens a region
 * and then an album. One cache, one download — and a FAILURE IS DELIBERATELY NOT CACHED, so the next open
 * tries again rather than leaving a permanently dead control.
 *
 * ⚠ NOTHING HERE IS ON A PUBLIC PAGE, AND "HERE" MEANS MAPTILER, NOT MAPLIBRE. The public craft archive
 * and the map section already draw MapLibre canvases (components/site/CraftMap.tsx,
 * components/sections/MapSection.tsx) over a RASTER basemap whose URL is `NEXT_PUBLIC_MAP_TILE_URL`,
 * defaulting to OpenStreetMap's own tiles. What is studio-only is the pair this control adds: MapTiler's
 * vector style and MapTiler's geocoder. Both are billed per request against one account key, and a browse
 * map that every reader loads is a different order of volume from an editor placing one pin — so the public
 * maps keep their configurable raster source and gain no search box.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useRef } from "react";
import type * as maplibregl from "maplibre-gl";

import { PlaceSearchBox } from "@/components/studio/fields/PlaceSearchBox";
import type { PlaceHit } from "@/lib/geo/placeSearch";

/**
 * ⚠ WRITTEN OUT IN FULL, NOT READ THROUGH A VARIABLE. Next's build-time substitution is a literal text
 * replacement on `process.env.NEXT_PUBLIC_*`; a dynamic lookup is not substituted and reads `undefined` in
 * the browser — the trap lib/media/url.ts documents for the CDN base, and it would show here as a map that
 * renders grey with a 403 on every tile.
 */
const maptilerKey = process.env.NEXT_PUBLIC_MAPTILER_API_KEY;

/**
 * Whether a map can be drawn at all in this build.
 *
 * Exported so a caller can decide NOT TO OFFER the control rather than offering one that opens onto a grey
 * rectangle. A build without the key is a legitimate deployment, and a "Place on the map" control that does
 * nothing reads as a broken studio rather than as a missing key.
 */
export function mapPickerAvailable(): boolean {
  return Boolean(maptilerKey);
}

export type MapLibre = typeof maplibregl;

let maplibreRequest: Promise<MapLibre> | null = null;

export function loadMapLibre(): Promise<MapLibre> {
  maplibreRequest ??= Promise.all([
    import("maplibre-gl"),
    // The stylesheet ships separately; without it the canvas renders but every control is unstyled.
    import("maplibre-gl/dist/maplibre-gl.css")
  ])
    .then(([module]) => module)
    .catch((error: unknown) => {
      maplibreRequest = null;
      throw error;
    });
  return maplibreRequest;
}

/** The centre of India, for a picker opening with no point to show. */
const INDIA_CENTRE: [number, number] = [78.9629, 22.5937];

/**
 * How close a chosen place is framed when it has an extent of its own.
 *
 * `fitBounds` on a small village's bounding box lands somewhere past zoom 18 — a few rooftops, with no way
 * to tell which village they belong to. Capping it keeps the surrounding roads and the neighbouring
 * settlements on screen, which is what somebody needs in order to recognise the place and then click the
 * right part of it.
 */
const PLACE_MAX_ZOOM = 14;

/** Zoom for a place the geocoder gives as a bare point: close enough to see a village's streets. */
const PLACE_POINT_ZOOM = 13;

/**
 * Fly a map to a searched place.
 *
 * IT MOVES THE CAMERA AND NOTHING ELSE. There is no `onPick` here and there must never be one: a search
 * that placed the pin would put a geocoder's guess into a record with nobody in the loop. See
 * lib/geo/placeSearch.ts.
 */
export function flyToPlace(map: maplibregl.Map, hit: PlaceHit): void {
  if (hit.bbox) {
    // A district or a town is an area, and dropping onto the centre of one at street zoom shows an
    // arbitrary lane inside it rather than the thing that was asked for.
    map.fitBounds(hit.bbox, { padding: 40, maxZoom: PLACE_MAX_ZOOM, essential: true });
    return;
  }
  map.flyTo({ center: [hit.lon, hit.lat], zoom: PLACE_POINT_ZOOM, essential: true });
}

export interface MapPointPickerProps {
  lat: number | null;
  lon: number | null;
  /**
   * ⚠ THE COORDINATES ARRIVE AS STRINGS, fixed to seven decimals — about a centimetre, far finer than
   * anything a pointer can express. The caller stores them as numbers, and a round trip through `toFixed`
   * is the only place the precision can be pinned: handing over a raw float writes 26.900000000000002 into
   * a record.
   */
  onPick: (lat: string, lon: string) => void;
  /** Told once when the module could not be fetched, so the caller can say so in its own words. */
  onFailure?: () => void;
  markerColor?: string;
  ariaLabel: string;
}

/**
 * A map you click once to state a point.
 *
 * One marker and one meaning. The studio's other maps draw many pins at once and need colour to tell them
 * apart; a single coordinate given a multi-marker canvas would invent a distinction the record does not
 * make.
 */
export function MapPointPicker({
  lat,
  lon,
  onPick,
  onFailure,
  // The studio's own purple, not the site's gold: gold is marketing-only and never appears on a studio
  // screen (contract §1.1).
  markerColor = "#6b21a8",
  ariaLabel
}: MapPointPickerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const moduleRef = useRef<MapLibre | null>(null);

  /**
   * The click handler, held in a ref and read through it by the map's own listener.
   *
   * The alternative is rebuilding the map whenever `onPick` changes identity — which it does on every
   * render of the parent form, because it closes over the row being edited. Rebuilding a MapLibre instance
   * per keystroke in a neighbouring field is a megabyte of WebGL teardown and setup, and the visible
   * symptom is a map that blinks white while somebody types.
   */
  const pickRef = useRef(onPick);
  useEffect(() => {
    pickRef.current = onPick;
  }, [onPick]);

  const failureRef = useRef(onFailure);
  useEffect(() => {
    failureRef.current = onFailure;
  }, [onFailure]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !maptilerKey) return;
    // Closing the panel (or unmounting the form) before the download lands must not leave a map attached to
    // a container React has already taken back.
    let cancelled = false;
    let instance: maplibregl.Map | null = null;

    loadMapLibre()
      .then((maplibre) => {
        if (cancelled) return;
        moduleRef.current = maplibre;
        const map = new maplibre.Map({
          container,
          style: `https://api.maptiler.com/maps/streets-v2/style.json?key=${maptilerKey}`,
          center: lat !== null && lon !== null ? [lon, lat] : INDIA_CENTRE,
          zoom: lat !== null && lon !== null ? 12 : 4
        });
        instance = map;
        mapRef.current = map;
        map.addControl(new maplibre.NavigationControl({ visualizePitch: true }), "top-right");
        map.on("click", (event) => {
          pickRef.current(event.lngLat.lat.toFixed(7), event.lngLat.lng.toFixed(7));
        });
      })
      .catch(() => {
        if (!cancelled) failureRef.current?.();
      });

    return () => {
      cancelled = true;
      markerRef.current?.remove();
      markerRef.current = null;
      instance?.remove();
      if (instance && mapRef.current === instance) mapRef.current = null;
    };
    // Built once per mount. The coordinates are read at open time and thereafter tracked by the marker
    // effect below, which moves the pin without rebuilding the canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the marker in step with the boxes, without rebuilding the map.
  useEffect(() => {
    const maplibre = moduleRef.current;
    const map = mapRef.current;
    if (!maplibre || !map) return;
    markerRef.current?.remove();
    markerRef.current = null;
    if (lat === null || lon === null) return;
    markerRef.current = new maplibre.Marker({ color: markerColor }).setLngLat([lon, lat]).addTo(map);
    map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 12), essential: true });
  }, [lat, lon, markerColor]);

  /**
   * Bias the search to where the map is looking, read at request time.
   *
   * Deliberately NOT state: `getCenter` changes on every frame of a drag, and holding it in state would
   * re-render this component — the one that owns a megabyte of WebGL — at sixty hertz while somebody pans.
   */
  const proximity = useCallback(() => {
    const centre = mapRef.current?.getCenter();
    return centre ? { lon: centre.lng, lat: centre.lat } : null;
  }, []);

  const flyTo = useCallback((hit: PlaceHit) => {
    // The map is still downloading on a slow link. Nothing to move, and nothing is wrong — the editor can
    // search again a second later, and no value has been touched either way.
    const map = mapRef.current;
    if (map) flyToPlace(map, hit);
  }, []);

  return (
    <div className="grid gap-2">
      {/*
        Above the canvas, so a keyboard user reaches the searchable half BEFORE the pointer-only half, and
        so the list opens over the map rather than off the bottom of a phone.
      */}
      <PlaceSearchBox getProximity={proximity} onChoose={flyTo} label="Search for a place to move the map" />
      <div
        ref={containerRef}
        /*
          A map is a pointer instrument and cannot be operated from a keyboard, so it is NOT given a
          tabindex: landing on it would trap a keyboard user on a control with nothing to press. The typed
          latitude and longitude boxes beside it are the keyboard route to the same value, which is why they
          are never hidden when the map is open.
        */
        role="application"
        aria-label={ariaLabel}
        className="h-72 w-full overflow-hidden rounded-md border border-line-200 bg-surface-50"
      />
    </div>
  );
}
