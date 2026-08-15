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
 * ⚠ THE VALIDATION MIRRORS THE SERVER'S BOX EXACTLY — latitude 6–38, longitude 68–98, the
 * whole-degree box around India's outline (app/api/studio/crafts/regions/[id]/route.ts cites the
 * geometry). The client check exists so the refusal appears while the reader is still in the field;
 * the server's is the one that counts. A pin needs BOTH numbers, so a half-filled pair marks the
 * empty box rather than saving a value the map can never draw.
 *
 * WHAT A ROW SAYS ABOUT THE MAP is server-derived (`anchor`): the homepage rolls a region's crafts
 * up to the nearest placed ancestor, and this screen states each region's fate in the same words —
 * on the map, counting under a named parent, or reported as unplaced — so an editor can see exactly
 * what giving a region coordinates would change before typing anything.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MapPin } from "lucide-react";

import { asApiClientError, patch } from "@/lib/client/fetcher";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/ToastProvider";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";

/** ⚠ The same box as `app/api/studio/crafts/regions/[id]/route.ts`. Change them together. */
const LAT_MIN = 6;
const LAT_MAX = 38;
const LNG_MIN = 68;
const LNG_MAX = 98;

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

function RegionRow({ region }: { region: RegionRowData }) {
  const router = useRouter();
  const { toast } = useToast();

  const [latitude, setLatitude] = useState(region.latitude);
  const [longitude, setLongitude] = useState(region.longitude);
  // What the server last agreed to, so the row knows when there is anything to save.
  const [saved, setSaved] = useState({ latitude: region.latitude, longitude: region.longitude });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
              onChange={(event) => setLatitude(event.target.value)}
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
              onChange={(event) => setLongitude(event.target.value)}
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
        </div>
      </div>

      {error ? (
        // `role="alert"`: the reader has just pressed Save and been stopped.
        <p role="alert" className="mt-2 text-sm leading-relaxed text-error-600">
          {error}
        </p>
      ) : null}
    </li>
  );
}

export function RegionMapManager({ regions, truncated, limit }: RegionMapManagerProps) {
  if (regions.length === 0) {
    return (
      <EmptyState
        icon={MapPin}
        title="There are no regions yet"
        description="Regions arrive with the craft corpus — they are seeded alongside it rather than created here. Once regions exist, this is where each one is given the coordinates that put it on the homepage map."
      />
    );
  }

  return (
    <FormSection
      title="Where each region sits"
      description="Decimal degrees. With coordinates the region appears on the homepage map; without, its crafts count under the nearest parent that has them."
    >
      <ul className="divide-y divide-line-200">
        {regions.map((region) => (
          <RegionRow key={region.id} region={region} />
        ))}
      </ul>

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
