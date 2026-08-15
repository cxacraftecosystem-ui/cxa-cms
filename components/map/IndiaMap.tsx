"use client";

/**
 * The Centre's map of India — the outline, and a pin per craft region.
 *
 * PORTED from the Field Repository's map (the owner's own product; its module headers travel with
 * their files — indiaGeometry.ts carries the provenance argument for the OFFICIAL Government of
 * India depiction and must never be swapped for a Western dataset). This edition is the NATION
 * level only: the landing page asks "where is the work?", not "which district?", so the state and
 * district border fetches were left behind with the level toggle — the outline IS the national
 * border, inlined, with no loading state to get wrong.
 *
 * IT IS A GRAPHIC, AND IT IS MARKED AS ONE. The whole `<svg>` is `aria-hidden` and holds nothing
 * focusable — an SVG full of tabbable circles is "button, button, button" with nothing to compare.
 * Everything the picture says is said again by `MapPlaceList` beside it, a real list with real
 * counts and real links; a keyboard or screen-reader user gets the better interface of the two.
 *
 * NO MAPPING LIBRARY. maplibre already earns its quarter-megabyte in the craft explorer's real
 * basemap; here the whole geometry is 18 KiB of string and one `<path>`. Nothing re-renders on a
 * pointer move except the hover label.
 */

import { memo, useId, useMemo } from "react";

import { layoutPins, type MapPoint, type PlacedPin } from "@/components/map/layout";
import { indiaOutlinePath, unitsPerKilometre, VIEW_BOX } from "@/components/map/projection";

export type { MapPoint } from "@/components/map/layout";

export interface IndiaMapProps {
  points: MapPoint[];
  selectedKey?: string | null;
  hoveredKey?: string | null;
  onSelect?: (key: string) => void;
  onHover?: (key: string | null) => void;
  className?: string;
}

/** Built once from a path string that is itself built once — this never has a reason to re-render. */
const Coastline = memo(function Coastline() {
  return (
    <path
      d={indiaOutlinePath()}
      fillRule="evenodd"
      className="fill-purple-100/60 stroke-purple-300 dark:fill-purple-950/40"
      // A hairline stroke is what makes Lakshadweep visible: those islands are genuinely under a
      // pixel at this scale, and a fill alone would render the territory as nothing at all.
      strokeWidth={1.6}
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
    />
  );
});

export function IndiaMap({
  points,
  selectedKey = null,
  hoveredKey = null,
  onSelect,
  onHover,
  className = ""
}: IndiaMapProps) {
  const pins = useMemo(() => layoutPins(points, unitsPerKilometre()), [points]);
  const active = pins.find((pin) => pin.point.key === (hoveredKey ?? selectedKey)) ?? null;

  /**
   * THE SHARED NAME FOR A PLACE across the picture and the list beside it: `MapPlaceList` numbers
   * its rows 1..N in the callers' order and the hover label prints the same number, so "the third
   * one" means one thing in both views. Derived from `points`, not `pins` — the collision pass may
   * reorder while it nudges.
   */
  const ordinals = useMemo(
    () => new Map(points.map((point, index) => [point.key, index + 1])),
    [points]
  );

  // One id per mounted map, kept for parity with the source (a second map on a page must not
  // share defs with the first).
  useId();

  return (
    <svg
      viewBox={`0 0 ${VIEW_BOX.width} ${VIEW_BOX.height}`}
      className={`h-auto w-full max-w-full ${className}`}
      role="presentation"
      aria-hidden="true"
      focusable="false"
    >
      <Coastline />

      {/* Leader lines tie a displaced pin back to where the place really is — Bagru and Sanganer
          are 25 km apart, eight pixels at this scale, and two towns are two towns. */}
      {pins
        .filter((pin) => pin.displaced)
        .map((pin) => (
          <g key={`leader-${pin.point.key}`}>
            <line
              x1={pin.anchorX}
              y1={pin.anchorY}
              x2={pin.x}
              y2={pin.y}
              className="stroke-purple-400"
              strokeWidth={1.2}
            />
            <circle cx={pin.anchorX} cy={pin.anchorY} r={2} className="fill-purple-500" />
          </g>
        ))}

      {pins.map((pin) => (
        <Pin
          key={pin.point.key}
          pin={pin}
          isActive={pin.point.key === selectedKey || pin.point.key === hoveredKey}
          onSelect={onSelect}
          onHover={onHover}
        />
      ))}

      {active ? <HoverLabel pin={active} ordinal={ordinals.get(active.point.key)} /> : null}
      <ScaleBar />
    </svg>
  );
}

function Pin({
  pin,
  isActive,
  onSelect,
  onHover
}: {
  pin: PlacedPin;
  isActive: boolean;
  onSelect?: (key: string) => void;
  onHover?: (key: string | null) => void;
}) {
  const { point, x, y, radius } = pin;

  return (
    <g
      // Pointer-only, deliberately: focusable content inside an aria-hidden subtree is unreachable
      // by AT but still in the tab order — the worst of both. The list beside the map is the
      // keyboard path.
      className="cursor-pointer"
      onClick={() => onSelect?.(point.key)}
      onPointerEnter={() => onHover?.(point.key)}
      onPointerLeave={() => onHover?.(null)}
    >
      {/* An invisible target a little larger than the mark, so a small pin is not a small hit area. */}
      <circle cx={x} cy={y} r={radius + 8} fill="transparent" />

      <circle
        cx={x}
        cy={y}
        r={radius}
        className={`fill-purple-700 stroke-white ${isActive ? "opacity-100" : "opacity-90"}`}
        strokeWidth={2}
      />

      {/* The count belongs ON the pin, on EVERY pin — it is what stops a place holding nine crafts
          reading exactly like a place holding one. Size follows the digits so "12" fits and "1"
          does not rattle. */}
      <text
        x={x}
        y={y}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={radius * (point.total >= 100 ? 0.72 : point.total >= 10 ? 0.9 : 1.05)}
        className="pointer-events-none fill-white font-display font-bold"
      >
        {point.total}
      </text>
    </g>
  );
}

/**
 * The place name under the pointer, led by the number its row carries in the list — the reader has
 * read "3 · Kachchh" before they click, so when row 3 highlights, the two views visibly agree.
 */
function HoverLabel({ pin, ordinal }: { pin: PlacedPin; ordinal?: number }) {
  const text = ordinal ? `${ordinal} · ${pin.point.name}` : pin.point.name;
  const width = Math.max(96, text.length * 11 + 28);
  const left = Math.min(Math.max(pin.x - width / 2, 4), VIEW_BOX.width - width - 4);
  const above = pin.y - pin.radius - 40 > 0;
  const top = above ? pin.y - pin.radius - 40 : pin.y + pin.radius + 10;

  return (
    <g className="pointer-events-none">
      <rect x={left} y={top} width={width} height={31} rx={8} className="fill-ink-900" />
      <text
        x={left + width / 2}
        y={top + 16}
        textAnchor="middle"
        dominantBaseline="central"
        className="fill-bg-0 font-sans text-[15px] font-medium"
      >
        {text}
      </text>
    </g>
  );
}

/** Without one, nobody can tell whether two pins are 20 km apart or 200. */
function ScaleBar() {
  const kilometres = 500;
  const length = kilometres * unitsPerKilometre();
  const x = 26;
  const y = VIEW_BOX.height - 34;
  return (
    <g className="pointer-events-none">
      <line x1={x} y1={y} x2={x + length} y2={y} className="stroke-ink-500" strokeWidth={2} />
      <line x1={x} y1={y - 5} x2={x} y2={y + 5} className="stroke-ink-500" strokeWidth={2} />
      <line
        x1={x + length}
        y1={y - 5}
        x2={x + length}
        y2={y + 5}
        className="stroke-ink-500"
        strokeWidth={2}
      />
      <text x={x} y={y + 22} className="fill-ink-500 font-sans text-[15px]">
        {kilometres} km
      </text>
    </g>
  );
}
