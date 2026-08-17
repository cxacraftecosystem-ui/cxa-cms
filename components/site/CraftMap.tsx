"use client";

/**
 * CraftMap and CraftExplorerPanes — the interactive half of `/craft-explorer`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * TWO EXPORTS IN ONE FILE, BECAUSE THE INTERACTION SPANS BOTH PANES.
 *
 * Picking a marker reveals the matching ROW. The nonce that makes a repeat pick flash again, the
 * `data-flash` attribute the CSS keys off, and the scroll that brings the row into view are one piece
 * of state read by two regions of the page — so the map and the list are rendered by one component.
 * Splitting them across two modules would mean a context provider whose only member is a selection,
 * and the row's `data-flash` must be RENDERED BY REACT (see `pick` below), not stamped onto the DOM
 * from an event handler.
 *
 *   • `CraftMap`            the canvas: clustered, keyboard-reachable markers.
 *   • `CraftExplorerPanes`  the two-pane shell: the map on the left, the list on the right, and the
 *                           reveal that ties them together.
 *
 * THE LIST IS THE ACCESSIBLE EQUIVALENT OF THE MAP, and it is never optional. A WebGL canvas cannot
 * be read, so everything the map shows — which crafts exist, where they are, in what region — is on
 * screen as text beside it, at the same ordinal. That is also why a marker below the clustering
 * threshold is not individually keyboard-reachable: its cluster is (and says how many crafts it
 * covers), and the row is reachable in the ordinary tab order. A reader who cannot use the map loses
 * nothing but the geography.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE STYLE IS BUILT INLINE, AS A SINGLE RASTER SOURCE, exactly as components/sections/MapSection.tsx
 * builds it, and the tile URL comes from the same `NEXT_PUBLIC_MAP_TILE_URL` convention. Read that
 * file's header before changing either: the default is OpenStreetMap's own volunteer-funded tile
 * server, which is explicitly not for production traffic, and both environment variables are written
 * out IN FULL because Next's substitution is a literal text replacement — `process.env[name]` is not
 * substituted and reads `undefined` in the browser.
 *
 * `maplibre-gl` AND ITS STYLESHEET ARE IMPORTED INSIDE THE EFFECT. That is what makes this component
 * `ssr: false` without a `next/dynamic` wrapper: nothing touches `window` until after mount, and the
 * ~800 KB of WebGL mapping code is not in the bundle of any page that has no map on it. A
 * `next/dynamic(…, { ssr: false })` cannot be used from the Server Component that renders this page
 * at all, so the deferral has to live here — the same decision, and the same reasoning, as
 * MapSection.
 *
 * ⚠ UNLIKE `MapCanvas`, THE MAP IS BUILT ONCE AND KEPT. MapCanvas is a static pin map and rebuilds
 * when its points change; this map is the reader's workspace, and a filter change that tore it down
 * would throw away their zoom and pan. Points changes re-fit the bounds and re-cluster instead.
 *
 * `map.remove()` on unmount frees the WebGL context. Browsers cap those at around sixteen: a reader
 * who opens several map pages in one session otherwise ends up with a blank canvas on a page that has
 * nothing wrong with it.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import type {
  Map as MapLibreMap,
  Marker as MapLibreMarker,
  StyleSpecification
} from "maplibre-gl";
import { Layers, MapPin } from "lucide-react";

import { useReducedMotionPreference } from "@/components/motion";
import { MapAttribution } from "@/components/sections/MapSection";
import { TagList } from "@/components/site/TagList";
import { Badge } from "@/components/ui/Badge";
import { CraftPlate } from "@/components/craft/CraftPlate";
import { MediaImage } from "@/components/ui/MediaImage";
import type { Picture } from "@/lib/media/screens";
import type { MediaLike } from "@/lib/media/url";
import { cn, truncateWords } from "@/lib/utils";

/** OpenStreetMap's own tiles. Development and low volume only — see the header. */
const DEFAULT_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_URL = (process.env.NEXT_PUBLIC_MAP_TILE_URL ?? "").trim() || DEFAULT_TILE_URL;

/**
 * The clustering grid, in SCREEN pixels.
 *
 * Clustering is done here rather than by maplibre's own `cluster: true` because a clustered GeoJSON
 * source draws circles into the canvas, and a circle in a canvas is not focusable, not speakable and
 * not a target voice control can reach. Every marker below is a real `<button>`, which is the whole
 * point (contract §11). Screen-space bucketing also means the threshold is a distance the reader can
 * see — two markers merge when they would overlap, at every zoom, with no zoom table to maintain.
 */
const CLUSTER_CELL_PX = 56;

/** Below this spread in degrees a cluster's members are, for practical purposes, in one place. */
const DEGENERATE_SPREAD = 1e-6;

/**
 * Both panes scroll independently — ONLY from `lg` up.
 *
 * `max-height` is what actually creates the two independent scrollers; the `sticky` keeps them pinned
 * if the grid row is ever taller than the cap. `overscroll-contain` stops a gesture that reaches the
 * end of one pane from lurching the page behind it.
 *
 * ⚠ NONE OF IT APPLIES BELOW `lg`. A nested same-axis scroller on a touch screen is a gesture nobody
 * can aim: the reader flicks to scroll the page and the inner box eats it. On a phone the two panes
 * are ordinary page flow, one after the other.
 */
const PANE_SCROLL =
  "lg:sticky lg:top-24 lg:max-h-[calc(100dvh-7.5rem)] lg:overflow-y-auto lg:overscroll-contain";

/** How much of the row must already be clear of the pane's edge for "no scroll needed" to be true. */
const REVEAL_SLACK_PX = 24;

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One craft on the map.
 *
 * `ordinal` is 1-BASED AND COMES FROM THE ARRAY ORDER OF THE LIST (`index + 1`), never from anything
 * the map computes. Marker layout reorders as collisions are resolved, and a number derived from that
 * would change as markers were nudged — so the shared name for a craft across the two views is fixed
 * before either view is rendered.
 */
export interface CraftMapPoint {
  id: string;
  ordinal: number;
  name: string;
  regionName: string | null;
  latitude: number;
  longitude: number;
}

/** One craft in the list. Plain data: this crosses the server/client boundary as props. */
export interface CraftRowData {
  id: string;
  slug: string;
  name: string;
  /** In its own script, rendered with `lang` so a screen reader does not read it in an English voice. */
  localName: string | null;
  localNameLang: string | null;
  summary: string | null;
  regionName: string | null;
  schoolName: string | null;
  originYear: number | null;
  originNote: string | null;
  materials: string[];
  latitude: number | null;
  longitude: number | null;
  cover: MediaLike | null;
  /**
   * The cover's per-screen framing, ALREADY RESOLVED by the page — the alternate photographs a framing
   * names are arbitrary ids in a JSONB column that no relation joins, so only the server can fetch them.
   * Null, or a single band, means nothing was overridden and `MediaImage` draws exactly what it always
   * drew.
   */
  picture: Picture | null;
}

export interface CraftMapProps {
  points: readonly CraftMapPoint[];
  /** The craft whose row is currently revealed, so its marker can carry the same state. */
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Names the map region for a screen reader — "Map of where these crafts are practised". */
  label: string;
  className?: string;
}

interface MapEngine {
  map: MapLibreMap;
  maplibre: typeof import("maplibre-gl");
}

interface CraftCluster {
  /** Every member id, in ordinal order — stable across a re-cluster that changed nothing. */
  key: string;
  longitude: number;
  latitude: number;
  members: CraftMapPoint[];
  /** False when every member sits at the same coordinates, where zooming can never separate them. */
  expandable: boolean;
}

interface MarkerView {
  key: string;
  cluster: CraftCluster;
  /** maplibre positions THIS element; the button inside it is free to use its own transforms. */
  container: HTMLDivElement;
}

// ─────────────────────────────────────────────────────────────────────────────
// Clustering
// ─────────────────────────────────────────────────────────────────────────────

function clusterPoints(map: MapLibreMap, points: readonly CraftMapPoint[]): CraftCluster[] {
  const buckets = new Map<string, CraftMapPoint[]>();

  for (const point of points) {
    const projected = map.project([point.longitude, point.latitude]);
    const cell = `${Math.floor(projected.x / CLUSTER_CELL_PX)}:${Math.floor(projected.y / CLUSTER_CELL_PX)}`;
    const bucket = buckets.get(cell);
    if (bucket) bucket.push(point);
    else buckets.set(cell, [point]);
  }

  const clusters: CraftCluster[] = [];

  for (const bucket of buckets.values()) {
    const members = [...bucket].sort((a, b) => a.ordinal - b.ordinal);
    const first = members[0];
    // The bound is proved by construction — a bucket is only created with a member in it — but
    // `noUncheckedIndexedAccess` cannot see that, and a marker at `undefined, undefined` would be a
    // pin in the Atlantic.
    if (!first) continue;

    let longitudeSum = 0;
    let latitudeSum = 0;
    let minLongitude = first.longitude;
    let maxLongitude = first.longitude;
    let minLatitude = first.latitude;
    let maxLatitude = first.latitude;

    for (const member of members) {
      longitudeSum += member.longitude;
      latitudeSum += member.latitude;
      minLongitude = Math.min(minLongitude, member.longitude);
      maxLongitude = Math.max(maxLongitude, member.longitude);
      minLatitude = Math.min(minLatitude, member.latitude);
      maxLatitude = Math.max(maxLatitude, member.latitude);
    }

    const spread = Math.max(maxLongitude - minLongitude, maxLatitude - minLatitude);

    clusters.push({
      key: members.map((member) => member.id).join("|"),
      // A plain mean, which is wrong across the antimeridian and right everywhere this archive
      // records. A single member keeps its exact position rather than an averaged one.
      longitude: members.length === 1 ? first.longitude : longitudeSum / members.length,
      latitude: members.length === 1 ? first.latitude : latitudeSum / members.length,
      members,
      expandable: members.length > 1 && spread > DEGENERATE_SPREAD
    });
  }

  // Sorted by the lowest ordinal in each cluster, so the markers are inserted into the DOM in the
  // same order as the rows and the tab order walks the map the way the eye walks the list.
  clusters.sort((a, b) => (a.members[0]?.ordinal ?? 0) - (b.members[0]?.ordinal ?? 0));
  return clusters;
}

// ─────────────────────────────────────────────────────────────────────────────
// The map
// ─────────────────────────────────────────────────────────────────────────────

export function CraftMap({ points, selectedId, onSelect, label, className }: CraftMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [engine, setEngine] = useState<MapEngine | null>(null);
  const [failed, setFailed] = useState(false);
  const [views, setViews] = useState<MarkerView[]>([]);

  const reduce = useReducedMotionPreference();
  /**
   * Read through a ref inside the map effects rather than listed as a dependency.
   *
   * The preference can flip mid-visit (the accessibility panel writes it live), and it decides only
   * whether a fit is animated. In a dependency array it would re-fit the bounds — throwing the
   * reader's viewport away — because they turned a switch on.
   */
  const reduceRef = useRef(reduce);
  useEffect(() => {
    reduceRef.current = reduce;
  }, [reduce]);

  const markersRef = useRef<{ marker: MapLibreMarker; container: HTMLDivElement }[]>([]);
  /** The cluster set currently on screen, so an unchanged re-cluster rebuilds nothing. */
  const clusterKeyRef = useRef("");
  /** False until the first fit, which is the one that must not animate. */
  const fittedRef = useRef(false);

  /**
   * The effects below depend on STRINGS, never on the `points` array itself, and read the points back
   * out of the string.
   *
   * A parent that rebuilds its array literal on every render — which this one does, on every pick —
   * would otherwise re-fit the map and destroy every marker several times a second. Serialising makes
   * the dependency exact instead of merely present (the technique MapCanvas documents).
   */
  const pointsJson = JSON.stringify(points);
  const coordinatesJson = JSON.stringify(points.map((point) => [point.longitude, point.latitude]));

  // ── Build the map, once ────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let map: MapLibreMap | null = null;
    // The imports are asynchronous, so the component can unmount before they resolve. A map created
    // after that would attach to a detached node and never be torn down.
    let cancelled = false;

    const start = async () => {
      let maplibre: typeof import("maplibre-gl");
      try {
        // Started before the library so the two chunks download in parallel, and awaited after it so
        // the stylesheet is in the document before the first control is drawn.
        // The import is typed by types/css-side-effect.d.ts, which is why it needs no suppression.
        const stylesheet: Promise<unknown> = import("maplibre-gl/dist/maplibre-gl.css");
        maplibre = await import("maplibre-gl");
        await stylesheet;
      } catch {
        // The chunk failed — an offline reader, a blocked CDN, a deploy mid-flight. The list beside
        // the map is the whole archive in words, which is why it is rendered unconditionally.
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

      try {
        map = new maplibre.Map({
          container,
          style,
          // The whole world at zoom 1 is the only honest opening view: the fit effect below runs in
          // the same commit that reports the map ready, so this is seen for at most one frame.
          center: [0, 20],
          zoom: 1,
          // Rendered as real HTML beneath the canvas, where it is themed and still legible if the
          // map never draws.
          attributionControl: false,
          // A page-scroll gesture over a map must scroll the page. Without this a reader swiping past
          // the map on a phone zooms it instead and loses their place.
          cooperativeGestures: true
        });
      } catch {
        if (!cancelled) setFailed(true);
        return;
      }

      // Keyboard-operable zoom. The compass is dropped: this map never rotates.
      map.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");
      // A tile 404 or a WebGL warning is not worth blanking the map for; a failure to create the
      // context already threw above.
      map.on("error", () => undefined);

      map.once("load", () => {
        if (cancelled || !map) return;
        setEngine({ map, maplibre });
      });
    };

    void start();

    return () => {
      cancelled = true;
      for (const entry of markersRef.current) entry.marker.remove();
      markersRef.current = [];
      clusterKeyRef.current = "";
      // Frees the WebGL context, the tile requests and every listener in one call.
      map?.remove();
      map = null;
    };
  }, []);

  // ── Fit the bounds to whatever is on the map now ───────────────────────────
  useEffect(() => {
    if (!engine) return;
    const { map, maplibre } = engine;

    const coordinates = JSON.parse(coordinatesJson) as [number, number][];
    const first = coordinates[0];
    if (!first) return;

    const bounds = new maplibre.LngLatBounds(first, first);
    for (const coordinate of coordinates) bounds.extend(coordinate);

    map.fitBounds(bounds, {
      padding: 56,
      // 11 keeps a village visible in its district rather than filling the pane with one street.
      maxZoom: 11,
      // The FIRST fit never animates — a map that flies to its own contents the instant it appears is
      // motion nobody asked for. Later fits answer a filter the reader just changed, so they are
      // animated, and reduced motion turns that back off.
      animate: fittedRef.current && !reduceRef.current
    });

    fittedRef.current = true;
  }, [engine, coordinatesJson]);

  // ── Cluster, and keep the markers in step with the viewport ────────────────
  useEffect(() => {
    if (!engine) return;
    const { map, maplibre } = engine;
    const current = JSON.parse(pointsJson) as CraftMapPoint[];

    const rebuild = (force: boolean) => {
      const clusters = clusterPoints(map, current);
      const key = clusters.map((cluster) => cluster.key).join("~");

      // Panning within a zoom level usually changes nothing: maplibre repositions a marker from its
      // own `lngLat`, so an unchanged cluster set needs no new markers. Rebuilding anyway would blow
      // away the focus of a reader who is tabbing the map while it settles.
      if (!force && key === clusterKeyRef.current) return;
      clusterKeyRef.current = key;

      for (const entry of markersRef.current) entry.marker.remove();

      const created: { marker: MapLibreMarker; container: HTMLDivElement }[] = [];
      const next: MarkerView[] = [];

      for (const cluster of clusters) {
        // A plain container, because maplibre writes an inline `transform` on the element it is given
        // and a button that positioned itself with a transform would lose it.
        const container = document.createElement("div");
        const marker = new maplibre.Marker({ element: container, anchor: "center" })
          .setLngLat([cluster.longitude, cluster.latitude])
          .addTo(map);

        created.push({ marker, container });
        next.push({ key: cluster.key, cluster, container });
      }

      markersRef.current = created;
      setViews(next);
    };

    /**
     * COALESCED INTO ONE FRAME, and `resize` is the reason.
     *
     * `moveend` and `zoomend` fire once when the reader lets go, so a direct call would be fine for
     * them. `resize` does not: maplibre reports it from a `ResizeObserver`, so dragging a window edge
     * — or a phone's address bar sliding away, which changes the `100dvh` this pane is capped at —
     * fires it as fast as the browser lays out. Every one of those re-projects all 42 points, and
     * because a resize changes the projection the cluster key almost always DOES change, so the guard
     * in `rebuild` does not catch it: the map would tear down and recreate up to forty marker elements
     * per frame, re-render that many portals, and throw away the focus of anyone tabbing the markers,
     * for the whole duration of the drag. One rAF collapses a burst into a single rebuild against the
     * final size.
     */
    let frame = 0;
    const onSettled = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        rebuild(false);
      });
    };

    rebuild(true);
    map.on("moveend", onSettled);
    map.on("zoomend", onSettled);
    // The pane is a `max-height` scroller from `lg` up, so its width changes at every breakpoint and
    // whenever the reader resizes. maplibre tracks that itself and fires `resize`.
    map.on("resize", onSettled);

    return () => {
      // Before the listeners come off: a queued frame would otherwise rebuild markers onto a map this
      // effect has finished with, or — on unmount — one the build effect has already removed.
      if (frame !== 0) window.cancelAnimationFrame(frame);
      map.off("moveend", onSettled);
      map.off("zoomend", onSettled);
      map.off("resize", onSettled);
    };
  }, [engine, pointsJson]);

  const expand = useCallback(
    (cluster: CraftCluster) => {
      if (!engine) return;
      const { map, maplibre } = engine;
      const first = cluster.members[0];
      if (!first) return;

      const bounds = new maplibre.LngLatBounds(
        [first.longitude, first.latitude],
        [first.longitude, first.latitude]
      );
      for (const member of cluster.members) bounds.extend([member.longitude, member.latitude]);

      map.fitBounds(bounds, {
        padding: 72,
        maxZoom: 15,
        // Answering a click, so it animates — unless the reader asked for less motion.
        animate: !reduce
      });
    },
    [engine, reduce]
  );

  return (
    <div className={cn("min-w-0", className)}>
      <div className="relative overflow-hidden rounded-lg border border-line-200 bg-surface-100">
        <div
          ref={containerRef}
          // `group` and NOT `img`: `img` removes everything inside it from the accessibility tree,
          // and inside it are the zoom buttons and every marker. Everything the map shows is repeated
          // as text in the list beside it, so nothing here is available only to someone who can see.
          role="group"
          aria-label={label}
          className="h-[24rem] w-full sm:h-[30rem] lg:h-[calc(100dvh-10rem)]"
        />

        {failed ? (
          <p className="absolute inset-0 flex items-center justify-center bg-surface-100 p-6 text-center text-sm text-ink-500">
            The map could not be loaded. Every craft is listed beside it, with its region.
          </p>
        ) : null}

        {/*
          The markers' contents, rendered through portals into the containers maplibre positions.
          A portal keeps them inside the React tree, so a change of `selectedId` re-renders the marker
          without touching maplibre — which is what lets a pick update the map without rebuilding it.
        */}
        {views.map((view) =>
          createPortal(
            <CraftMarker
              cluster={view.cluster}
              selectedId={selectedId}
              onSelect={onSelect}
              onExpand={expand}
            />,
            view.container,
            view.key
          )
        )}
      </div>

      <MapAttribution />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// A marker
// ─────────────────────────────────────────────────────────────────────────────

const MARKER_BASE =
  "group relative flex items-center justify-center rounded-full border-2 border-white bg-purple-700 font-semibold text-white shadow-md transition duration-200 ease-out hover:bg-purple-800 active:scale-95";

/** Named colours on both rings: a bare `ring-2` is preflight's stock BLUE (contract §3). */
const MARKER_SELECTED = "bg-purple-900 ring-2 ring-white";

function CraftMarker({
  cluster,
  selectedId,
  onSelect,
  onExpand
}: {
  cluster: CraftCluster;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onExpand: (cluster: CraftCluster) => void;
}) {
  const members = cluster.members;
  const single = members.length === 1 ? members[0] : null;
  const holdsSelection = selectedId !== null && members.some((member) => member.id === selectedId);

  const names = members
    .slice(0, 3)
    .map((member) => `${member.ordinal} · ${member.name}`)
    .join(", ");
  const unnamed = members.length - Math.min(3, members.length);

  /**
   * The accessible name says what pressing it DOES, and carries the state the ring only shows.
   *
   * A cluster whose members share one set of coordinates cannot be separated by zooming, however many
   * times the reader tries — so it reveals its first craft in the list instead, and says so.
   */
  const description = single
    ? `Craft ${single.ordinal}, ${single.name}${single.regionName ? `, ${single.regionName}` : ""} — show it in the list${holdsSelection ? ", currently shown" : ""}`
    : cluster.expandable
      ? `${members.length} crafts in this area: ${names}${unnamed > 0 ? `, and ${unnamed} more` : ""} — zoom in to separate them`
      : `${members.length} crafts recorded at the same place: ${names}${unnamed > 0 ? `, and ${unnamed} more` : ""} — show the first in the list`;

  const activate = () => {
    if (single) {
      onSelect(single.id);
      return;
    }
    if (cluster.expandable) {
      onExpand(cluster);
      return;
    }
    const first = members[0];
    if (first) onSelect(first.id);
  };

  return (
    <button
      type="button"
      onClick={activate}
      aria-label={description}
      className={cn(
        MARKER_BASE,
        single ? "h-6 w-6" : "h-8 min-w-8 px-1.5 text-xs",
        holdsSelection ? MARKER_SELECTED : undefined
      )}
    >
      {/*
        THE COUNT IS THE ONLY THING INSIDE THE DISC, and a single craft shows no number at all. The
        ordinal lives in the hover label: two numbers on a 24px disc make both unreadable, and the
        count is the one a reader needs before they have decided which marker to press.
      */}
      {single ? null : <span aria-hidden="true">{members.length}</span>}

      {/*
        The hover label. `group-focus-visible` as well as `group-hover`, so a reader arriving by
        keyboard is told which marker they are standing on. `aria-hidden` because the button's own
        `aria-label` already says all of this and better.
      */}
      <span
        aria-hidden="true"
        // ⚠ `purple-950`, not `ink-900`: this label floats over MAP TILES, so its text is
        // unconditionally white and its scrim must be unconditionally dark. `ink-900` inverts with the
        // theme (#1e1b2e → #f2f0f9) and made this a white chip carrying white text. See ImageCredit.tsx.
        className="pointer-events-none absolute bottom-full left-1/2 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-purple-950/90 px-2 py-1 text-xs font-medium text-white opacity-0 transition-opacity duration-200 ease-out group-hover:opacity-100 group-focus-visible:opacity-100 sm:block"
      >
        {single ? (
          <>
            {single.ordinal} · {single.name}
            {single.regionName ? (
              <span className="text-white/70"> · {single.regionName}</span>
            ) : null}
          </>
        ) : (
          `${members.length} crafts`
        )}
      </span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The two panes
// ─────────────────────────────────────────────────────────────────────────────

export interface CraftExplorerPanesProps {
  /** In the order the ordinals are derived from. The server decides the order; this never re-sorts. */
  crafts: readonly CraftRowData[];
  /** Rendered instead of the panes when there is nothing to show — an EmptyState from the page. */
  empty?: ReactNode;
  /** Printed under the list: the cap, the total, anything left out. Never omitted when it applies. */
  note?: ReactNode;
  /** Where a row links to. */
  basePath?: string;
}

/**
 * A year as it should read. Negative is BCE, which is why the column is signed rather than a string;
 * a qualification such as "sometime in the medieval period" belongs in `originNote` beside it.
 *
 * Identical to the helper in components/sections/CraftExplorerSection.tsx on purpose — the preview
 * block and the explorer must not spell a date two ways.
 */
function formatOriginYear(year: number): string {
  return year < 0 ? `${Math.abs(year)} BCE` : String(year);
}

export function CraftExplorerPanes({
  crafts,
  empty,
  note,
  basePath = "/craft-explorer"
}: CraftExplorerPanesProps) {
  const reduce = useReducedMotionPreference();
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef(new Map<string, HTMLLIElement>());

  /**
   * THE NONCE IS STATE, NOT A REF.
   *
   * Picking the SAME marker twice must flash the row again, so the reveal has to run on a repeat pick
   * — and a ref written in a handler and read in an effect does not schedule the render that shows the
   * flash. Bumping a counter in state is what makes the second pick a new commit.
   *
   * It is deliberately NOT in the URL. A picked marker is a glance, not a destination; the craft's own
   * page is the thing worth linking to.
   */
  const [pick, setPick] = useState<{ id: string; nonce: number } | null>(null);
  /** Which row carries `data-flash`. Cleared and re-set so the CSS animation restarts — see below. */
  const [flashId, setFlashId] = useState<string | null>(null);

  const select = useCallback((id: string) => {
    setPick((previous) => ({ id, nonce: (previous?.nonce ?? 0) + 1 }));
  }, []);

  // A pick can outlive the row it named: the reader changes a filter and the craft leaves the list.
  const selectedId = pick && crafts.some((craft) => craft.id === pick.id) ? pick.id : null;

  useEffect(() => {
    if (!pick) return;
    const row = rowsRef.current.get(pick.id);
    if (!row) return;

    // Cleared FIRST. `.flash-row[data-flash="true"]` carries the animation, and an attribute that
    // goes true → true is not a change the browser restarts an animation for.
    setFlashId(null);

    /**
     * ONE FRAME LATER, and the order inside the callback is load-bearing.
     *
     * The reveal is triggered from an effect in the same commit that may have inserted a panel above
     * the rows, so measuring now would measure the layout the row is about to leave. And the measure
     * comes BEFORE the flash is re-set: reading layout is what forces the browser to compute the
     * un-animated state it was just given, which is what lets the animation start again.
     */
    const frame = window.requestAnimationFrame(() => {
      revealRow(row, listRef.current, reduce);
      /**
       * Force the un-animated state to be COMPUTED, not merely written.
       *
       * An animation restarts when the computed `animation-name` changes between two style
       * recalculations. React flushes the `setFlashId(null)` above before yielding to the browser, so
       * the attribute is already gone — but if nothing reads layout in between, the browser can
       * coalesce both writes into one recalculation, see no change, and let the finished animation
       * stand. Reading a layout property is what makes the intermediate state real. `revealRow`
       * usually does this already; this line is what makes it true on the path where it does not.
       */
      void row.offsetHeight;
      setFlashId(pick.id);
    });

    return () => window.cancelAnimationFrame(frame);
    // `reduce` is intentionally absent: it decides how the scroll moves, and flipping the preference
    // must not re-scroll a reader who has not picked anything new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick]);

  if (crafts.length === 0) return <>{empty}</>;

  const points: CraftMapPoint[] = [];
  crafts.forEach((craft, index) => {
    if (typeof craft.latitude !== "number" || typeof craft.longitude !== "number") return;
    points.push({
      id: craft.id,
      ordinal: index + 1,
      name: craft.name,
      regionName: craft.regionName,
      latitude: craft.latitude,
      longitude: craft.longitude
    });
  });

  const unlocated = crafts.length - points.length;
  const selectedIndex = selectedId ? crafts.findIndex((craft) => craft.id === selectedId) : -1;
  const selected = selectedIndex >= 0 ? crafts[selectedIndex] : undefined;

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,27rem)] lg:gap-10 xl:grid-cols-[minmax(0,1fr)_minmax(0,31rem)]">
      <div className={cn("min-w-0", PANE_SCROLL)}>
        {/*
          Both panes carry a heading, and both are `sr-only`.
          Heading levels never skip (contract §11) and the rows below are `<h3>`s — without an `<h2>`
          between them and the page's `<h1>` the outline would claim a level of structure that does not
          exist. Neither heading is worth screen space: a map with a map in it and a list beside it are
          self-evident to anybody who can see them, and this is exactly what `sr-only` is for.
        */}
        <h2 className="sr-only">Where these crafts are practised</h2>

        {points.length > 0 ? (
          <CraftMap
            points={points}
            selectedId={selectedId}
            onSelect={select}
            label="Map of where these crafts are practised"
          />
        ) : (
          <div className="flex h-[24rem] items-center justify-center rounded-lg border border-dashed border-line-200 bg-surface-50 p-6 sm:h-[30rem]">
            <p className="prose-measure text-center text-sm leading-relaxed text-ink-500">
              None of the crafts in this selection has a recorded location, so there is nothing to
              place on a map. They are all listed beside it.
            </p>
          </div>
        )}

        {unlocated > 0 && points.length > 0 ? (
          <p className="mt-3 text-sm leading-relaxed text-ink-500">
            {unlocated} of these {unlocated === 1 ? "crafts has" : "crafts have"} no recorded location
            and {unlocated === 1 ? "is" : "are"} not on the map. All {crafts.length} are in the list.
          </p>
        ) : null}
      </div>

      <div ref={listRef} className={cn("min-w-0", PANE_SCROLL)}>
        <h2 className="sr-only">The crafts in this selection</h2>

        {/*
          Mounted from the first render, so the region is registered before its content ever changes.
          This is the answer to a discrete action — a marker the reader just pressed — and NOT a
          scroll-position readout, which must never be live (contract §8).
        */}
        <p role="status" className="sr-only">
          {selected && selectedIndex >= 0
            ? `${selectedIndex + 1} · ${selected.name} is highlighted in the list.`
            : ""}
        </p>

        <ol className="flex flex-col gap-3">
          {crafts.map((craft, index) => {
            const ordinal = index + 1;
            const isSelected = craft.id === selectedId;

            return (
              <li
                key={craft.id}
                ref={(node) => {
                  if (node) rowsRef.current.set(craft.id, node);
                  else rowsRef.current.delete(craft.id);
                }}
                // The class carries the pulse AND the outline that outlives it; the attribute is what
                // React flips. globals.css keeps them together so no component invents a second
                // "this one, just now" treatment.
                data-flash={flashId === craft.id ? "true" : "false"}
                className={cn(
                  // `border` on its own would be preflight's literal gray-200, which does not invert
                  // (contract §3) — but it is not on its own here: the width and the COLOUR are set in
                  // the same class string, and the two are different properties, so the plain join in
                  // `cn()` cannot let one beat the other.
                  "flash-row flex gap-4 rounded-lg border bg-card p-4 transition-colors",
                  isSelected ? "border-purple-300" : "border-line-200"
                )}
              >
                <p
                  /**
                   * The shared name for this craft across both views. From the array order, so it
                   * cannot be changed by a marker being nudged out of a collision.
                   *
                   * NOT `aria-hidden`, even though the `<ol>` already carries the item's position. Not
                   * every screen reader announces that position, and the live region above says
                   * "3 · Bagru" — a reader who cannot find the 3 has been given a reference to nothing.
                   * One number read twice is a cheaper fault than a reference that cannot be resolved.
                   */
                  className="w-6 shrink-0 pt-0.5 text-sm font-semibold tabular-nums text-purple-700"
                >
                  {ordinal}.
                </p>

                {/*
                  ⚠ THE PLATE, NOT THE DIAGNOSTIC, WHEN THERE IS NO PHOTOGRAPH. `MediaImage`'s
                  placeholder says "No image", which is a message to whoever can fix a failed upload.
                  Sixteen of the forty-two crafts have no photograph and will not have one until
                  somebody licenses it, so this list — the archive's own index, beside the map —
                  printed that diagnostic sixteen times as though the records were broken. See
                  components/craft/CraftPlate.tsx; `PersonCard` draws the same distinction with its
                  initials plate, and this is the surface that was missed when that landed.
                */}
                {craft.cover ? (
                  <MediaImage
                    media={craft.cover}
                    picture={craft.picture}
                    aspect="1 / 1"
                    rounded="sm"
                    sizes="80px"
                    alt=""
                    className="w-16 shrink-0 self-start sm:w-20"
                  />
                ) : (
                  <div className="flex w-16 shrink-0 items-center justify-center self-start rounded-sm bg-purple-50 [aspect-ratio:1/1] sm:w-20">
                    <CraftPlate slug={craft.slug} />
                  </div>
                )}

                <div className="min-w-0 flex-1">
                  <h3 className="display-title text-base leading-snug">
                    <Link
                      href={`${basePath}/${craft.slug}`}
                      className="rounded transition-colors hover:text-purple-700"
                    >
                      {craft.name}
                    </Link>
                    {craft.localName ? (
                      <span
                        lang={craft.localNameLang ?? undefined}
                        className="mt-0.5 block text-sm font-medium text-ink-500"
                      >
                        {craft.localName}
                      </span>
                    ) : null}
                  </h3>

                  <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-500">
                    {craft.regionName ? <span>{craft.regionName}</span> : null}
                    {craft.schoolName ? <span>· {craft.schoolName}</span> : null}
                    {craft.originYear !== null ? (
                      <span>· {formatOriginYear(craft.originYear)}</span>
                    ) : craft.originNote ? (
                      <span>· {craft.originNote}</span>
                    ) : null}
                  </p>

                  {craft.summary ? (
                    // Truncated on the server-rendered value rather than clamped in CSS: a line clamp
                    // hides text from sighted readers and leaves it in the accessibility tree.
                    <p className="mt-2 text-sm leading-relaxed text-ink-500">
                      {truncateWords(craft.summary, 150)}
                    </p>
                  ) : null}

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {craft.materials.length > 0 ? (
                      <TagList
                        tags={craft.materials}
                        label="Materials"
                        size="sm"
                        max={3}
                        moreHref={`${basePath}/${craft.slug}`}
                      />
                    ) : null}

                    {/* The word beside the outline: colour never carries meaning alone (§11). */}
                    {isSelected ? (
                      <Badge tone="info" size="sm" icon={MapPin}>
                        Picked on the map
                      </Badge>
                    ) : null}

                    {craft.latitude === null || craft.longitude === null ? (
                      <Badge tone="neutral" size="sm" icon={Layers}>
                        No recorded location
                      </Badge>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>

        {note ? <div className="mt-6">{note}</div> : null}
      </div>
    </div>
  );
}

/**
 * Bring a row into view, moving as little as possible.
 *
 * THE CONTAINER IS MEASURED AT CALL TIME. `scrollHeight > clientHeight + 1` is the only reliable way
 * to know whether the pane is an independent scroller right now: the same component is a bounded
 * scroller on a wide screen and ordinary page flow on a phone, and reading a breakpoint in JavaScript
 * would be a second source of truth for something CSS has already decided.
 *
 * A row already comfortably inside the pane is LEFT ALONE. A list that lurches on every click loses
 * the row the reader was reading, which is the opposite of what a reveal is for.
 */
function revealRow(row: HTMLElement, container: HTMLElement | null, reduce: boolean): void {
  const behavior: ScrollBehavior = reduce ? "auto" : "smooth";
  const scroller =
    container && container.scrollHeight > container.clientHeight + 1 ? container : null;

  if (!scroller) {
    /**
     * Ordinary page flow. `block: "nearest"` is the same "only as far as necessary" rule, applied by
     * the browser against the viewport instead of against a pane.
     *
     * Deliberately NOT `scrollToElement()` from components/motion: that helper lands its target at the
     * top of the viewport with the full header clearance paid, which is right for an anchor jump and
     * exactly wrong here — the whole point of this function is to move as little as possible. Lenis is
     * only mounted when reduced motion is off, and it reconciles an external scroll on the next frame,
     * so the two do not fight over this.
     */
    row.scrollIntoView({ block: "nearest", behavior });
    return;
  }

  const rowBox = row.getBoundingClientRect();
  const paneBox = scroller.getBoundingClientRect();

  if (rowBox.top < paneBox.top + REVEAL_SLACK_PX) {
    scroller.scrollBy({ top: rowBox.top - paneBox.top - REVEAL_SLACK_PX, behavior });
    return;
  }

  if (rowBox.bottom > paneBox.bottom - REVEAL_SLACK_PX) {
    scroller.scrollBy({ top: rowBox.bottom - paneBox.bottom + REVEAL_SLACK_PX, behavior });
  }
}
