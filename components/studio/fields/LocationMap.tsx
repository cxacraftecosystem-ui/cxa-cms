"use client";

/**
 * LocationMap — the map an editor places a pin on, wherever the studio asks for a coordinate.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS: THE MAP REACHED ONE SCREEN OUT OF FOUR.
 *
 * `MapPointPicker` — MapTiler's tiles with a place search bolted to the top — was built, wired into
 * `app/studio/crafts/regions/RegionMapManager.tsx`, and reached nothing else. Every other place in the
 * studio that asks where something IS asked for it as two numbers in two boxes:
 *
 *   • an EVENT's venue, which is the one coordinate an ordinary editor types most often;
 *   • a CRAFT's origin;
 *   • the MAP block, whose entire purpose is to draw a pin on a page.
 *
 * Two boxes are a fine way to PASTE a coordinate somebody already has and a hopeless way to FIND one.
 * Placing a workshop in rural Odisha meant looking a village up somewhere else, copying two numbers,
 * and having no way to see whether the pin landed in the right district — which is exactly what the
 * search and the tiles are for.
 *
 * So this is the whole control, in one place: the gate, the map, the search (which `MapPointPicker`
 * already carries), and the sentence for when it cannot load. Three screens drop it in beside the
 * boxes they already have; nothing about how each of them STORES a coordinate changes.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ IT DOES NOT OWN THE NUMBER FIELDS, AND THAT IS DELIBERATE. Three callers hold a coordinate three
 * different ways — the event editor as `number | null` behind its own draft-string field, the craft
 * editor as a raw draft string, the MAP block as a plain `number` — and each of those is right for its
 * own store (see `NumberField`'s header for why a plainly controlled number box cannot be typed a
 * decimal point into). A component that insisted on one of the three would have forced a rewrite of
 * the other two for no gain. This draws the map; the caller keeps its boxes.
 *
 * ⚠ A PICK IS TWO NUMBERS AT ONCE. `onPick` hands back both, already fixed to seven decimals by the
 * picker, and a caller must write them in ONE update. Writing them one at a time flashes a half-moved
 * pin and briefly leaves a pair that the caller's own range checks will mark as invalid.
 *
 * ⚠ NOTHING IS RENDERED WHEN THERE IS NO MAP KEY, AND THE ABSENCE IS EXPLAINED RATHER THAN SILENT. A
 * build without `NEXT_PUBLIC_MAPTILER_API_KEY` is a legitimate deployment — CI runs as one — and a
 * "Place it on the map" control that opens onto a grey rectangle reads as a broken studio rather than
 * as a missing key. The boxes above it set the same value and need no map at all, which is what the
 * sentence says.
 */

import { useId, useState } from "react";
import { MapPin } from "lucide-react";

import { mapTilerConfigured } from "@/lib/geo/basemap";
import { cn } from "@/lib/utils";
import { MapPointPicker } from "@/components/studio/fields/MapPointPicker";
import { HelpText } from "@/components/studio/HelpText";

export interface LocationMapProps {
  /** The pin, or null where the caller has nothing to draw yet. Parsed, never validated — see below. */
  latitude: number | null;
  longitude: number | null;
  /**
   * Both new values, together, as strings fixed to seven decimals.
   *
   * ⚠ SEVEN DECIMALS IS ABOUT A CENTIMETRE and is finer than any pointer can express. The picker fixes
   * them so that a round trip cannot write `26.900000000000002` into a record; a caller that re-parses
   * and re-formats would undo that.
   */
  onPick: (latitude: string, longitude: string) => void;
  /**
   * The map's accessible name. Say WHICH thing is being placed and what a click does — "Map for placing
   * the venue of ‘Bagru block-printing workshop’. Click where it is held."
   */
  ariaLabel: string;
  /** The words on the disclosure. Defaults to the phrasing every caller wants. */
  label?: string;
  className?: string;
}

export function LocationMap({
  latitude,
  longitude,
  onPick,
  ariaLabel,
  label = "Place it on a map",
  className
}: LocationMapProps) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  /**
   * ⚠ CLOSED UNTIL ASKED FOR, ON EVERY SCREEN. MapLibre plus its stylesheet is around a megabyte —
   * several times the next largest chunk in this application — and `MapPointPicker` loads it inside
   * the effect that mounts the canvas, behind a module-level promise cache. Rendering the picker
   * unconditionally would pull that megabyte on every event, craft and page-builder screen, most of
   * which are opened to change a title.
   */
  if (!mapTilerConfigured()) {
    return (
      <HelpText className={className}>
        A map cannot be shown in this deployment, because no map key is configured. The two boxes above
        set the same value.
      </HelpText>
    );
  }

  return (
    <div className={cn("min-w-0", className)}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        // Only while it exists. `aria-controls` pointing at an id that is not in the document is a
        // broken relationship rather than an absent one, and some readers announce it as such.
        aria-controls={open ? panelId : undefined}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-line-200 bg-card px-3 py-1.5 text-sm font-medium text-ink-700 transition hover:border-purple-300 hover:text-purple-700"
      >
        <MapPin aria-hidden="true" className="h-4 w-4" />
        {open ? "Hide the map" : label}
      </button>

      {open ? (
        <div id={panelId} className="mt-3">
          <MapPointPicker
            /*
              Parsed, not validated: a value the caller's own boxes are already refusing still moves the
              pin, so the editor can SEE that 260.9 is off the planet rather than only being told so.
            */
            lat={latitude}
            lon={longitude}
            ariaLabel={ariaLabel}
            onPick={onPick}
            onFailure={() => setFailed(true)}
          />

          {failed ? (
            <p className="mt-2 text-xs leading-5 text-amber-800">
              The map could not be loaded — it is a large download and the connection may have dropped.
              Close and reopen it to try again; the boxes above set the same value and need no map at
              all.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
