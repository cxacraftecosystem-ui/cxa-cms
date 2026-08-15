"use client";

/**
 * IndiaMapStage — the one piece of state the map needs: which place is under the pointer.
 *
 * The picture and the list are two views of one hover (point at a pin → the row highlights; focus
 * a row → the pin lights), so the key lives here, above both, and nowhere else. Selection is a
 * navigation (the rows are links), so there is no selected state to hold — clicking a PIN merely
 * pins the hover so the label survives the pointer leaving, which is what a tap on a touch screen
 * needs to show anything at all.
 */

import { useState } from "react";

import { IndiaMap } from "@/components/map/IndiaMap";
import type { MapPoint } from "@/components/map/layout";
import { MapPlaceList } from "@/components/map/MapPlaceList";

export function IndiaMapStage({
  points,
  hrefBase
}: {
  points: MapPoint[];
  hrefBase: string;
}) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);

  return (
    <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:gap-12">
      <IndiaMap
        points={points}
        hoveredKey={hoveredKey}
        selectedKey={pinnedKey}
        onHover={setHoveredKey}
        onSelect={(key) => setPinnedKey((current) => (current === key ? null : key))}
      />
      <MapPlaceList
        points={points}
        hrefBase={hrefBase}
        hoveredKey={hoveredKey ?? pinnedKey}
        onHover={setHoveredKey}
        className="lg:max-h-[34rem] lg:overflow-y-auto lg:overscroll-contain"
      />
    </div>
  );
}
