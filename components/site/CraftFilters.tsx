/**
 * CraftFilters — the narrowing controls above the craft explorer.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A SERVER COMPONENT, DELIBERATELY.
 *
 * Every interactive part of a filter row already exists in `components/site/FilterBar.tsx`: the URL is
 * the state, one debounce covers the box and the chips, an empty group is ABSENT from the query string
 * rather than serialised as "everything ticked", and the `<Suspense>` that `useSearchParams()` needs
 * is built in. This file's whole job is to turn facet data into that component's configuration — which
 * is work with no state in it, so it ships no JavaScript of its own.
 *
 * THE OPTION LISTS COME FROM THE PUBLISHED CORPUS, NOT FROM THE FILTERED PAGE. A facet list built out
 * of the rows currently on screen can only ever offer what is already selected: pick "Rajasthan" and
 * every other region disappears, and the reader cannot get back without the browser's Back button.
 *
 * THE PERIOD IS NOT HERE. It is the timeline scrubber (`components/site/CraftTimeline.tsx`), which
 * writes `from`/`to`. One window over `originYear`, one pair of parameters, one control — a coarse
 * "period" select writing its own parameter would be a second source of truth for the same fact, and
 * the two would disagree the first time a reader used both.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A DIMENSION WITH NOTHING RECORDED IS NAMED RATHER THAN SILENTLY MISSING. A `<select>` whose only
 * entry is "All schools" is a control that cannot do anything; leaving it out is right, and saying
 * which dimensions are empty is what stops that reading as a bug in the page.
 */

import type { ReactNode } from "react";

import { FilterBar, type FilterGroup, type FilterOption } from "@/components/site/FilterBar";
import { cn } from "@/lib/utils";

/**
 * The query parameters the explorer owns, in one place.
 *
 * The page reads them, `FilterBar` writes four of them and `CraftTimeline` writes the other two. A
 * second spelling of any of these keys is a filter that quietly stops applying.
 */
export const CRAFT_PARAMS = {
  search: "q",
  region: "region",
  school: "school",
  material: "material",
  technique: "technique",
  from: "from",
  to: "to"
} as const;

export interface CraftFilterFacets {
  /** Regions that hold at least one published craft, alphabetically. `value` is the region slug. */
  regions: readonly FilterOption[];
  /** Schools that hold at least one published craft. `value` is the school slug. */
  schools: readonly FilterOption[];
  /** Materials across the corpus. `value` is a slug; the page maps it back to the stored spellings. */
  materials: readonly FilterOption[];
  /** Techniques, same convention as materials. */
  techniques: readonly FilterOption[];
}

export interface CraftFiltersProps {
  facets: CraftFilterFacets;
  /**
   * Printed under the controls when the option lists themselves are incomplete — a corpus larger than
   * the facet scan. A short filter list with no visible reason for it is indistinguishable from an
   * archive that only records four materials (contract §1.6).
   */
  note?: ReactNode;
  className?: string;
}

export function CraftFilters({ facets, note, className }: CraftFiltersProps) {
  const groups: FilterGroup[] = [];

  // Region and school are single-value closed lists: a craft has one of each, so a multiple-choice
  // control would promise an OR the data cannot express as an intersection.
  if (facets.regions.length > 0) {
    groups.push({
      key: CRAFT_PARAMS.region,
      label: "Region",
      options: facets.regions,
      control: "select",
      placeholder: "Every region"
    });
  }

  if (facets.schools.length > 0) {
    groups.push({
      key: CRAFT_PARAMS.school,
      label: "School",
      options: facets.schools,
      control: "select",
      placeholder: "Every school"
    });
  }

  // Materials and techniques are arrays on the record, so several at once is the honest control. The
  // page matches a craft that carries ANY of the chosen values — an archive search is looking for
  // "indigo or madder", not for a craft that uses both.
  if (facets.materials.length > 0) {
    groups.push({
      key: CRAFT_PARAMS.material,
      label: "Material",
      options: facets.materials,
      multiple: true,
      control: "chips",
      allLabel: "Any material"
    });
  }

  if (facets.techniques.length > 0) {
    groups.push({
      key: CRAFT_PARAMS.technique,
      label: "Technique",
      options: facets.techniques,
      multiple: true,
      control: "chips",
      allLabel: "Any technique"
    });
  }

  const missing = [
    facets.regions.length === 0 ? "region" : null,
    facets.schools.length === 0 ? "school" : null,
    facets.materials.length === 0 ? "material" : null,
    facets.techniques.length === 0 ? "technique" : null
  ].filter((entry): entry is string => entry !== null);

  return (
    <section aria-label="Narrow the archive" className={cn("flex flex-col gap-4", className)}>
      <FilterBar
        label="Craft filters"
        search={{
          key: CRAFT_PARAMS.search,
          // A search box's only accessible name. "Search" alone would be true of six boxes on this
          // site and speakable as none of them.
          label: "Search the craft archive",
          placeholder: "A craft, a material, a place…"
        }}
        groups={groups}
        /**
         * `from`/`to` are NOT reset by a filter change, and that is the point: a reader who has set the
         * timeline to the eighteenth century and then picks a region is narrowing, not starting again.
         * Only `page` is dropped, because page 4 of an unfiltered list is not page 4 of a filtered one.
         */
        resetParams={["page"]}
      />

      {missing.length > 0 ? (
        <p className="text-sm leading-relaxed text-ink-500">
          No {missing.join(", ")} {missing.length === 1 ? "has" : "have"} been recorded against any
          published craft yet, so {missing.length === 1 ? "that filter is" : "those filters are"} not
          offered.
        </p>
      ) : null}

      {note ? <div>{note}</div> : null}
    </section>
  );
}
