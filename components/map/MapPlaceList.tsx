"use client";

/**
 * MapPlaceList — the map's other half: every place as a real row with a real count and a real link.
 *
 * The picture (`IndiaMap`) is aria-hidden decoration; THIS is the interface. Each row carries the
 * same ordinal the map's hover label prints, so "3 · Kachchh" means one thing in both views, and
 * each row is an ordinary link into the craft explorer filtered to that region — a keyboard or
 * screen-reader user loses nothing to the graphic and gains a plain list.
 *
 * Hover and focus are REPORTED UPWARD rather than owned: the parent holds one hovered key and
 * feeds it to both halves, so pointing at a pin highlights the row and focusing a row lights the
 * pin — one state, two views (the source app's contract, kept).
 */

import Link from "next/link";

import type { MapPoint } from "@/components/map/layout";
import { cn } from "@/lib/utils";

export interface MapPlaceListProps {
  points: MapPoint[];
  /** The explorer path with the region filter, e.g. `/craft-explorer?region=`. */
  hrefBase: string;
  hoveredKey?: string | null;
  onHover?: (key: string | null) => void;
  className?: string;
}

export function MapPlaceList({
  points,
  hrefBase,
  hoveredKey = null,
  onHover,
  className
}: MapPlaceListProps) {
  return (
    <ol className={cn("flex flex-col", className)}>
      {points.map((point, index) => {
        const active = point.key === hoveredKey;
        return (
          <li key={point.key}>
            <Link
              href={`${hrefBase}${encodeURIComponent(point.key)}`}
              onPointerEnter={() => onHover?.(point.key)}
              onPointerLeave={() => onHover?.(null)}
              onFocus={() => onHover?.(point.key)}
              onBlur={() => onHover?.(null)}
              className={cn(
                "flex min-h-11 items-baseline gap-3 rounded-md px-3 py-1.5 transition-colors",
                active ? "bg-purple-700/10" : "hover:bg-surface-100"
              )}
            >
              <span className="w-6 shrink-0 text-right font-display text-sm font-bold tabular-nums text-purple-700">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-900">
                {point.name}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-ink-500">
                {point.total === 1 ? "1 craft" : `${point.total} crafts`}
              </span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}
