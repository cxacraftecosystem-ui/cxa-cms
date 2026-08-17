"use client";

/**
 * RegionMapManager — every craft region, and the two numbers that put one on the homepage map.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ONE SAVE PER ROW, DELIBERATELY. Coordinates are looked up one place at a time, and a single
 * save-everything button would let one mistyped row block seventy-nine finished ones — or worse,
 * save them around it and leave the reader unsure which rows took. Each row validates, saves and
 * reports on its own.
 *
 * TWO WAYS TO PLACE A REGION, AND NEITHER IS THE ONLY ONE. The two number fields are for somebody
 * holding a gazetteer coordinate; the map behind each row's "Place on the map" is for somebody who
 * knows where Kutch is and not what its decimal degrees are. They are the same value seen twice:
 * typing moves the pin, clicking rewrites the boxes. Which is WHY THE COORDINATES ARE HELD HERE
 * rather than inside each row — the picker and the fields are two views of one piece of state, and a
 * row that owned its own text could not be written to by a map drawn beside it. Everything else about
 * a row — whether it is saving, and what the server said if it refused — stays in the row, because
 * that is the part "one save per row" is about.
 *
 * ⚠ THE VALIDATION MIRRORS THE SERVER'S BOX EXACTLY — latitude 6–38, longitude 68–98, the
 * whole-degree box around India's outline (app/api/studio/crafts/regions/[id]/route.ts cites the
 * geometry). There is now ONE copy of it on the client, in components/studio/RegionMapPicker.tsx,
 * imported by both the fields below and the map: a click outside the box is refused in the same terms
 * and against the same four numbers as a typed value outside it, never clamped to the edge. The
 * client check exists so the refusal appears while the reader is still in the field; the server's is
 * the one that counts. A pin needs BOTH numbers, so a half-filled pair marks the empty box rather
 * than saving a value the map can never draw.
 *
 * WHAT A ROW SAYS ABOUT THE MAP is server-derived (`anchor`): the homepage rolls a region's crafts
 * up to the nearest placed ancestor, and this screen states each region's fate in the same words —
 * on the map, counting under a named parent, or reported as unplaced — so an editor can see exactly
 * what giving a region coordinates would change before typing anything.
 *
 * ⚠ WHAT THIS SCREEN DOES NOT DO IS FILE A CRAFT UNDER A REGION, AND THAT IS NOT AN OMISSION.
 * `Craft.regionId` is a single optional foreign key (prisma/schema.prisma — `region CraftRegion?`,
 * one region per craft, not a join table), and the studio already writes it in exactly one place:
 * the craft's own editor, "Where it comes from" (app/studio/crafts/[id]/CraftEditor.tsx), through
 * `PATCH /api/studio/crafts/[id]`. A craft picker here would be a SECOND writer for that one column,
 * and two screens that can each silently overwrite the other's answer is the shape of bug nobody
 * reproduces. What this screen owes that journey is a signpost to it, which is the note at the foot.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MapPin, Trash2 } from "lucide-react";

import { asApiClientError, del, patch } from "@/lib/client/fetcher";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/ToastProvider";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";
import { RowActions, type RowAction } from "@/components/studio/RowActions";
import {
  LAT_MAX,
  LAT_MIN,
  LNG_MAX,
  LNG_MIN,
  RegionMapPicker,
  type PlacedRegion
} from "@/components/studio/RegionMapPicker";
import { MapPointPicker, mapPickerAvailable } from "@/components/studio/fields/MapPointPicker";

/** Where this region's own published crafts land on the homepage map today. */
export type RegionAnchor =
  | { kind: "self" }
  | { kind: "ancestor"; name: string }
  | { kind: "none" };

export interface RegionRowData {
  id: string;
  slug: string;
  name: string;
  /** NATION | STATE | DISTRICT | CLUSTER — printed lower-case beside the name, as the pickers do. */
  level: string;
  parentName: string | null;
  /** Published crafts filed DIRECTLY under this region — the number the homepage map rolls up. */
  craftCount: number;
  /**
   * Live crafts filed directly under it, DRAFTS INCLUDED — a different question from `craftCount`.
   *
   * `craftCount` is what the map pins; this is what a removal would un-file. A region can perfectly well
   * have nothing published and four drafts, so a delete offered against the published number would be a
   * menu that disagrees with the route it calls.
   */
  liveCraftCount: number;
  /** Regions sitting directly under this one. They would be promoted to the top of the tree, not deleted. */
  childCount: number;
  /** Held as text, "" for unset — so a half-typed "26." survives being typed. */
  latitude: string;
  longitude: string;
  anchor: RegionAnchor;
}

export interface RegionMapManagerProps {
  regions: readonly RegionRowData[];
  /** True when the list was capped, so the screen can say so rather than appearing complete. */
  truncated: boolean;
  limit: number;
}

/** One region's two boxes as the reader currently has them. Text, for the reason `RegionRowData` says. */
interface Coordinates {
  latitude: string;
  longitude: string;
}

function toFloatOrNull(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const value = Number.parseFloat(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** "1 published craft" / "14 published crafts". Written out — a plural is not a suffix rule. */
function crafts(count: number): string {
  return count === 1 ? "1 published craft" : `${count} published crafts`;
}

/**
 * "1 craft" / "4 crafts" — the LIVE set, drafts included.
 *
 * ⚠ SEPARATE FROM `crafts()` ABOVE ON PURPOSE, and the two must not be merged. That one says "published",
 * because it describes what the map pins. This one describes what a removal would un-file, which includes
 * every draft — printing "1 published craft" in a sentence about drafts would be a false statement in the
 * one place it does the most damage.
 */
function liveCrafts(count: number): string {
  return count === 1 ? "1 craft" : `${count} crafts`;
}

/** "1 region" / "3 regions", for the same reason. */
function regions(count: number): string {
  return count === 1 ? "1 region" : `${count} regions`;
}

function anchorPhrase(region: RegionRowData): string {
  switch (region.anchor.kind) {
    case "self":
      return "On the map.";
    case "ancestor":
      return `Counts under ${region.anchor.name} on the map.`;
    case "none":
      return region.craftCount > 0
        ? "Not on the map — its crafts are reported as not yet placed."
        : "Not on the map.";
  }
}

function RegionRow({
  region,
  value,
  onChange,
  isOpen,
  onToggle,
  placed
}: {
  region: RegionRowData;
  /** The live boxes, owned by the list above — see this file's header. */
  value: Coordinates;
  onChange: (next: Coordinates) => void;
  /** Whether THIS row's map is the one showing. At most one is, so at most one outline is mounted. */
  isOpen: boolean;
  onToggle: () => void;
  /** Every region with coordinates right now, this one included — the picker drops itself. */
  placed: readonly PlacedRegion[];
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const { toast } = useToast();
  const pickerId = useId();

  // What the server last agreed to, so the row knows when there is anything to save. Still the row's
  // own business: it is what THIS row's Save button is about, and no other row or map reads it.
  const [saved, setSaved] = useState({ latitude: region.latitude, longitude: region.longitude });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Told once by the picker when the megabyte of MapLibre could not be fetched. */
  const [mapFailed, setMapFailed] = useState(false);

  const { latitude, longitude } = value;
  const lat = toFloatOrNull(latitude);
  const lng = toFloatOrNull(longitude);
  const hasLat = latitude.trim().length > 0;
  const hasLng = longitude.trim().length > 0;

  const latOutOfRange = hasLat && (lat === null || lat < LAT_MIN || lat > LAT_MAX);
  const lngOutOfRange = hasLng && (lng === null || lng < LNG_MIN || lng > LNG_MAX);
  // A pin needs both numbers. The error marks the EMPTY box, because that is the one to act on.
  const latMissing = !hasLat && hasLng;
  const lngMissing = hasLat && !hasLng;

  const latError = latOutOfRange
    ? `A number between ${LAT_MIN} and ${LAT_MAX}.`
    : latMissing
      ? "Fill this in too, or clear both."
      : null;
  const lngError = lngOutOfRange
    ? `A number between ${LNG_MIN} and ${LNG_MAX}.`
    : lngMissing
      ? "Fill this in too, or clear both."
      : null;

  const invalid = latError !== null || lngError !== null;
  const dirty = latitude.trim() !== saved.latitude.trim() || longitude.trim() !== saved.longitude.trim();

  const runSave = async () => {
    setBusy(true);
    setError(null);
    try {
      const answer = await patch<{ changed: boolean; message: string }>(
        `/api/studio/crafts/regions/${encodeURIComponent(region.id)}`,
        { latitude: lat, longitude: lng }
      );
      setSaved({ latitude: latitude.trim(), longitude: longitude.trim() });
      toast({ tone: "success", title: `“${region.name}” has been saved`, description: answer.message });
      // The anchor phrases are server-derived — clearing a state's pin changes what every child row
      // says — so the whole list is refreshed rather than patched by hand.
      router.refresh();
    } catch (thrown) {
      // Shown inside the row rather than as a toast: the reader is standing in front of the fields
      // that caused it.
      setError(asApiClientError(thrown).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Remove the region entirely.
   *
   * ⚠ OFFERED BECAUSE A REGION CAN NOW BE TYPED IN, AND SO TYPED IN WRONGLY. A name, a level and a parent are
   * fixed once recorded (the route edits coordinates and nothing else, and says why), so without a delete a
   * cluster recorded as a state would sit in the tree and in every craft's picker for good. This is the only
   * correction there is.
   *
   * The two blocking conditions are checked HERE ONLY SO THE MENU CAN EXPLAIN ITSELF — the route refuses
   * both regardless, and its refusal is the one that counts. Both numbers come from the server with the
   * list, so the sentence below is a real count rather than a promise to find out.
   */
  const blockedBy =
    region.childCount > 0
      ? `${regions(region.childCount)} ${region.childCount === 1 ? "sits" : "sit"} under it and would be promoted to the top of the tree.`
      : region.liveCraftCount > 0
        ? `${liveCrafts(region.liveCraftCount)} ${region.liveCraftCount === 1 ? "is" : "are"} filed under it — drafts included — and would be left with no region.`
        : null;

  const runDelete = async () => {
    const agreed = await confirm({
      title: `Remove “${region.name}” from the gazetteer?`,
      body: (
        <p>
          Nothing is filed under it, so no craft and no other region changes. Unlike a craft, a region does
          not go to the recycle bin — it is removed for good, and its name, level and parent cannot be
          recovered from the studio.
        </p>
      ),
      confirmLabel: "Remove it",
      cancelLabel: "Keep it",
      tone: "danger"
    });
    if (!agreed) return;

    try {
      const answer = await del<{ message?: string }>(
        `/api/studio/crafts/regions/${encodeURIComponent(region.id)}`
      );
      toast({
        tone: "success",
        title: `“${region.name}” has been removed`,
        // The route's own sentence, which names any recycled crafts that have just lost their filing —
        // rows nobody can see from this screen.
        description: answer.message
      });
      router.refresh();
    } catch (thrown) {
      toast({
        tone: "error",
        title: "It has not been removed",
        description: asApiClientError(thrown).message
      });
    }
  };

  const actions: RowAction[] = [
    {
      id: "delete",
      label: blockedBy === null ? "Remove this region" : "Cannot be removed yet",
      icon: Trash2,
      tone: "danger",
      // Not a permission — there is nothing an administrator could raise. It is a consequence, and the
      // description states which one (contract §10).
      disabled: blockedBy !== null,
      description: blockedBy ?? "Nothing is filed under it, so no craft and no other region changes.",
      onSelect: () => void runDelete()
    }
  ];

  return (
    <li className="py-4">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink-900">
            {region.name} <span className="font-normal text-ink-500">({region.level.toLowerCase()})</span>
          </p>
          {region.parentName ? (
            <p className="mt-0.5 text-xs text-ink-500">In {region.parentName}</p>
          ) : null}
          <p className="mt-1 text-xs text-ink-500">
            {/* The count is a link to the archive already filtered, so a number can be checked
                rather than taken on trust. */}
            <Link
              href={`/studio/crafts?region=${encodeURIComponent(region.slug)}&status=PUBLISHED`}
              className="tabular-nums underline-offset-4 hover:text-purple-700 hover:underline"
            >
              {region.craftCount > 0 ? crafts(region.craftCount) : "Nothing published here"}
            </Link>{" "}
            · {anchorPhrase(region)}
          </p>

          {/*
            The disclosure that opens this row's map. It sits under the region's name rather than
            beside the Save button so that the thing it opens appears directly beneath it.

            ⚠ `aria-controls` ONLY WHILE THE PICKER IS MOUNTED — pointing at an id that is not in the
            document is worse than not pointing at all (contract §11).
          */}
          <div className="mt-2">
            <Button
              variant="ghost"
              size="sm"
              icon={MapPin}
              aria-expanded={isOpen}
              aria-controls={isOpen ? pickerId : undefined}
              onClick={onToggle}
            >
              {isOpen ? "Hide the map" : "Place on the map"}
              <span className="sr-only"> for {region.name}</span>
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-start gap-3">
          <Field
            className="w-36"
            label={
              <>
                Latitude<span className="sr-only"> of {region.name}</span>
              </>
            }
            error={latError}
            help={`North, ${LAT_MIN}–${LAT_MAX}.`}
          >
            <Input
              inputMode="decimal"
              value={latitude}
              onChange={(event) => onChange({ latitude: event.target.value, longitude })}
              placeholder="26.9124"
              className="font-mono text-xs"
            />
          </Field>

          <Field
            className="w-36"
            label={
              <>
                Longitude<span className="sr-only"> of {region.name}</span>
              </>
            }
            error={lngError}
            help={`East, ${LNG_MIN}–${LNG_MAX}.`}
          >
            <Input
              inputMode="decimal"
              value={longitude}
              onChange={(event) => onChange({ latitude, longitude: event.target.value })}
              placeholder="75.7873"
              className="font-mono text-xs"
            />
          </Field>

          {/* Aligned with the inputs, under the fields' label-and-help rows. Disabled while there is
              nothing to save or the fields' own errors above say why (contract §10). */}
          <div className="pt-[3.25rem]">
            <Button
              variant="secondary"
              size="sm"
              isLoading={busy}
              loadingLabel="saving"
              disabled={!dirty || invalid}
              onClick={() => void runSave()}
            >
              Save<span className="sr-only"> {region.name}’s coordinates</span>
            </Button>
          </div>

          {/* Aligned with Save, so the row's two verbs sit on one line rather than one above the other. */}
          <div className="pt-[3.25rem]">
            <RowActions subject={region.name} actions={actions} />
          </div>
        </div>
      </div>

      {isOpen ? (
        /**
         * ⚠ TWO PICKERS, AND WHICH ONE APPEARS DEPENDS ON WHETHER THERE IS A MAP KEY.
         *
         * `MapPointPicker` draws real MapTiler tiles and carries a PLACE SEARCH — type "Barpali", the
         * camera goes there, and the pin is still placed by hand. That search is the thing this screen was
         * missing: without it, placing a cluster in rural Odisha meant panning two thousand kilometres
         * across a map of the whole country to find a village that could have been named in eight
         * keystrokes.
         *
         * `RegionMapPicker` — the hand-drawn India outline — stays as the fallback for a build with no key,
         * which is a legitimate deployment. It is not merely a lesser option: it is the only one of the two
         * that draws the SIBLING regions (`others`), so it shows where this place sits relative to the ones
         * already placed. The tiled map shows the actual terrain and can find a place by name; the outline
         * shows the set. A build with a key gets the search, and loses the sibling pins — which is the right
         * way round, because the row's own sentence above already states this region's fate on the map.
         */
        mapPickerAvailable() ? (
          <div id={pickerId} className="mt-4">
            <MapPointPicker
              lat={lat}
              lon={lng}
              ariaLabel={`Map for placing “${region.name}”. Click where the region is.`}
              // A pick is two numbers at once — writing them one at a time would flash a half-moved pin
              // and, worse, briefly leave a legal pair the fields would mark as out of range. The picker
              // hands back strings already fixed to seven decimals, so nothing is re-formatted here.
              onPick={(nextLatitude, nextLongitude) =>
                onChange({ latitude: nextLatitude, longitude: nextLongitude })
              }
              onFailure={() => setMapFailed(true)}
            />
            {mapFailed ? (
              <p className="mt-2 text-xs leading-5 text-amber-800">
                The map could not be loaded — it is a large download and the connection may have dropped.
                Close and reopen this row to try again; the two boxes above set the same value and need no
                map at all.
              </p>
            ) : null}
          </div>
        ) : (
          <RegionMapPicker
            id={pickerId}
            className="mt-4"
            regionName={region.name}
            // Parsed, not validated: a value the fields are already refusing still moves the pin, so
            // the reader can SEE that 260.9 is off the country rather than only being told so.
            latitude={lat}
            longitude={lng}
            others={placed.filter((other) => other.id !== region.id)}
            // A pick is two numbers at once — writing them one at a time would flash a half-moved pin
            // and, worse, briefly leave a legal pair the fields would mark as out of range.
            onPick={(nextLatitude, nextLongitude) =>
              onChange({ latitude: String(nextLatitude), longitude: String(nextLongitude) })
            }
          />
        )
      ) : null}

      {error ? (
        // `role="alert"`: the reader has just pressed Save and been stopped.
        <p role="alert" className="mt-2 text-sm leading-relaxed text-error-600">
          {error}
        </p>
      ) : null}
    </li>
  );
}

/**
 * The list, and the coordinates every row and every map read from.
 *
 * Split from `RegionMapManager` below ONLY so the empty state can be an early return: hooks cannot
 * sit after one, and an empty gazetteer has nothing for this state to be about.
 */
function RegionList({ regions, truncated, limit }: RegionMapManagerProps) {
  /**
   * The boxes, by region id — and ONLY for rows that have been touched.
   *
   * ⚠ SPARSE ON PURPOSE, WITH THE PROPS AS THE FALLBACK. Seeding this from `regions` once would
   * freeze the screen against its own `router.refresh()`, and re-seeding it on every render would
   * throw away what the reader is typing. Reading through to the prop for any row not in the map
   * gives an untouched row the server's latest answer and a touched one the reader's, which is the
   * behaviour both halves need.
   *
   * THE COST, STATED RATHER THAN OPTIMISED AWAY: a keystroke in one row now re-renders every row,
   * where before it re-rendered one. That is the price of the two-way binding and it is affordable
   * because of a bound this screen already documents — `REGION_LIMIT` is "a safety bound, not a page
   * size… the gazetteer holds tens of regions, not thousands" (page.tsx). Tens of rows of plain
   * inputs is nothing. If this list ever genuinely runs to hundreds, the fix is `memo` on `RegionRow`
   * plus stable per-row callbacks — NOT moving the text back into the rows, which is what makes the
   * map able to write to it at all.
   */
  const [drafts, setDrafts] = useState<Record<string, Coordinates>>({});

  /** At most one map is open, so at most one 18 KiB outline is ever mounted. */
  const [openId, setOpenId] = useState<string | null>(null);

  const coordinatesFor = (region: RegionRowData): Coordinates =>
    drafts[region.id] ?? { latitude: region.latitude, longitude: region.longitude };

  /**
   * Every region that has a pin right now, for the faint dots behind whichever one is being placed.
   *
   * Read from the DRAFTS, not from the props: a region moved and not yet saved should appear where
   * the editor has just put it, or the picture would contradict the boxes on the same screen.
   */
  const placed = useMemo(() => {
    const list: PlacedRegion[] = [];
    for (const region of regions) {
      const held = drafts[region.id] ?? region;
      const latitude = toFloatOrNull(held.latitude);
      const longitude = toFloatOrNull(held.longitude);
      // Both or neither, exactly as the map and the server require — half a coordinate is not a dot.
      if (latitude === null || longitude === null) continue;
      list.push({ id: region.id, latitude, longitude });
    }
    return list;
  }, [regions, drafts]);

  return (
    <FormSection
      title="Where each region sits"
      description="Decimal degrees, or a click on the map. With coordinates the region appears on the homepage map; without, its crafts count under the nearest parent that has them."
    >
      <ul className="divide-y divide-line-200">
        {regions.map((region) => (
          <RegionRow
            key={region.id}
            region={region}
            value={coordinatesFor(region)}
            onChange={(next) => setDrafts((held) => ({ ...held, [region.id]: next }))}
            isOpen={openId === region.id}
            onToggle={() => setOpenId((open) => (open === region.id ? null : region.id))}
            placed={placed}
          />
        ))}
      </ul>

      {/*
        The signpost, not a second way to do it — see this file's header. `region=none` is a filter the
        craft archive already supports (app/studio/crafts/page.tsx), and it is the exact list an editor
        with a placed region and no crafts on it needs: the crafts that are filed nowhere.
      */}
      <HelpText>
        A craft is filed under a region on the craft’s own page, under “Where it comes from” — not
        here. If a region has a pin but nothing published on it,{" "}
        <Link
          href="/studio/crafts?region=none"
          className="underline underline-offset-4 hover:text-purple-700"
        >
          the crafts with no region recorded
        </Link>{" "}
        are the place to start.
      </HelpText>

      {/* A capped list says so, always (contract §1.6). */}
      {truncated ? (
        <HelpText>
          Only the first {limit} regions are listed here, alphabetically. There are more — and a
          region left off this screen still counts on the map exactly as its stored coordinates say.
        </HelpText>
      ) : null}
    </FormSection>
  );
}

export function RegionMapManager({ regions, truncated, limit }: RegionMapManagerProps) {
  if (regions.length === 0) {
    return (
      /*
        ⚠ THIS USED TO SAY REGIONS COULD NOT BE CREATED HERE — "they are seeded alongside the corpus rather
        than created here" — which was true of a seeded deployment and a dead end for every other one: the
        craft editor's region picker was empty, its help said the work happened elsewhere, and there was no
        elsewhere. `RegionCreateForm` in the header above is that elsewhere now, so the empty state points
        at it instead of explaining why the screen can do nothing.
      */
      <EmptyState
        icon={MapPin}
        title="No region has been recorded yet"
        description="A region is a place a craft comes from — a state, a district, or a cluster of workshops — and it is what puts a craft on the homepage map. Use “Add a region” above to record the first one; it arrives without a pin, and this is where you then click where it is. Regions seeded with a craft corpus appear here too."
      />
    );
  }

  return <RegionList regions={regions} truncated={truncated} limit={limit} />;
}
