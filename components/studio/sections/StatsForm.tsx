"use client";

/**
 * StatsForm — the editor for a row of headline figures.
 *
 * THE FIGURE IS A TEXT BOX, NOT A NUMBER BOX, and the help text says so. "1,240", "12+", "3 of 5" and
 * "₹4.2 cr" are all answers administrators have actually given (see the note on `statsSectionSchema`),
 * and a number input would refuse every one of them — or, worse, silently strip the part that made it
 * true. The count-up animation reassembles the digits it finds; it is not the reason for the field's
 * type.
 *
 * THE SUMMARY LINE ON A COLLAPSED ROW IS THE FIGURE AND ITS LABEL, in that order, because that is how
 * the row reads on the page. A collapsed list of "Figure 1, Figure 2, Figure 3" would make the reorder
 * controls useless. A COUNTED figure has no typed value to show there, so `summariseFigure` names the
 * count instead — see its header.
 *
 * Field descriptions and limits come from `lib/sections/schema.ts` — the descriptions are read off it,
 * the limits are restated (Zod does not expose `.max()` publicly) and must match.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE "WHERE THE FIGURE COMES FROM" PICKER, AND WHY IT IS THE POINT OF THIS FILE.
 *
 * `metric` lets a figure ask the site to COUNT itself instead of being typed — the mechanism that
 * replaced four hand-typed noughts on the homepage (see `CENSUS_METRICS` in lib/sections/schema.ts and
 * `censusCount` in lib/sections/resolve.ts). It shipped with the schema field, the nine predicates, the
 * resolver, the renderer and a `CENSUS_METRIC_DEFINITIONS` record written explicitly "for the studio's
 * picker" — and no picker. An editor could not reach any of it, so in practice the census did not
 * exist: a feature nothing can reach is indistinguishable from one that was never built.
 *
 * THE OPTIONS ARE BUILT FROM `CENSUS_METRICS`, NOT WRITTEN OUT. Adding a metric to that tuple puts it
 * in this list, labelled from the same definitions the resolver's predicates are documented against, so
 * this form cannot offer a metric that does not resolve or miss one that does.
 *
 * ⚠ THE CHOSEN METRIC'S FULL DEFINITION IS RENDERED AS THE FIELD'S OWN `help`, not beside it. Two
 * reasons, and neither is cosmetic. A native `<option>` cannot hold a sentence like "People with a
 * published profile who are also shown in the directory" without becoming unreadable, so the definition
 * has to live outside the list; and passing it through `Field`'s `help` puts it in the control's
 * `aria-describedby`, so it is READ OUT when the picker takes focus. Rendered as a loose paragraph
 * underneath it would be visible help a screen-reader user is never told about (see HelpText's header).
 * The definitions are deliberately narrow — "items catalogued in published gallery albums", not
 * "records" — because a vague one is exactly what lets a label like "Field records" be attached to a
 * count of something else.
 *
 * ⚠ A TYPED FIGURE AND A CHOSEN METRIC TOGETHER IS THE ONE COMBINATION THAT SILENTLY DISCARDS WORK, so
 * it is the one thing this form warns about outright — the same rule `ShowcaseForm` applies to a
 * hand-picked list longer than its own limit. The typed value wins (that precedence is argued at length
 * on `CENSUS_METRICS`), so the count an editor just asked for would never appear and nothing on the
 * page would say why. The warning is a sibling of the field rather than its `help` because the `help`
 * already carries the rule in the schema's own words for a reader who cannot see the panel.
 *
 * ⚠ A METRIC THIS RELEASE DOES NOT KNOW *CAN* REACH THIS FORM, AND EVERY LOOKUP BELOW IS GUARDED
 * ACCORDINGLY. This paragraph used to say the opposite — "no guard is needed … every form is handed a
 * PARSED payload, never raw `PageSection.data` (see `sectionFormFor`)" — and it was wrong in a way that
 * put a white screen in front of an editor's unsaved work. The guarantee it cited holds only on the
 * SUCCESS branch, and it cited a symbol that is not on the path at all:
 *
 *   • `normaliseSection` in components/studio/builder/PageBuilder.tsx parses once at the door and, WHEN
 *     THE PARSE FAILS, falls back to `repairSectionData` — which is `{ ...defaults, ...raw }`, a
 *     deliberately SHALLOW merge that does not parse anything. `raw.items` therefore reaches this form
 *     verbatim, `metric` and all. That fallback is correct for what it is for: the editor has to SEE the
 *     wrong value in order to correct it. It simply is not a parsed payload.
 *   • ANY failure anywhere in the payload triggers it, not one in the offending item — a `heading` of 130
 *     characters (a limit tightened in a later release, an import, a hand edit) is enough.
 *   • `sectionFormFor()` has no caller in the tree. `SectionEditorPanel` looks the form up in
 *     `SECTION_FORMS` itself (`forms[section.type]`), so the header quoted above pointed at a guarantee
 *     nothing was enforcing.
 *
 * Demonstrated before the guard was written: stored `heading` 130 chars + `items[0].metric:
 * "fieldRecords"` (written by a newer deployment, then rolled back — the exact case `.catch("")` exists
 * for) → `parseSectionData` fails → the shallow repair keeps `metric: "fieldRecords"` → the old
 * `CENSUS_METRIC_DEFINITIONS[item.metric].label` threw `Cannot read properties of undefined`, a client
 * render error inside the page builder. `definitionFor()` below is the fix, and an unrecognised metric now
 * reads as "typed by hand" in this form — the same direction `censusMetricField()`'s `.catch("")` takes on
 * the way in and `censusFigure()` takes on the way out, so all three agree.
 *
 * ⚠ WHAT IS STILL NOT DEFENDED HERE, STATED RATHER THAN IMPLIED: the repair path can hand this form a
 * value of the wrong TYPE (`items` that is not an array, `label` that is a number), and no form of the
 * thirty survives that — `RepeaterField` maps over `items` before this file sees an item at all, and
 * `isEmpty` below calls `.trim()` on five fields. That is one defect with one root, in
 * `repairSectionData`, and it is not this file's to fix; it is reported as an integrator diff rather than
 * papered over with a `String()` in one form out of thirty. What IS this file's own is the lookup that can
 * legitimately miss — a metric the schema accepts the SHAPE of but this release has no definition for —
 * and that is what is guarded.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import {
  CENSUS_METRICS,
  CENSUS_METRIC_DEFINITIONS,
  statsSectionSchema,
  type CensusMetric,
  type StatsSectionData
} from "@/lib/sections/schema";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select, type SelectOption } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { HelpText } from "@/components/studio/HelpText";
import { RepeaterField } from "@/components/studio/fields/RepeaterField";
import type { SectionFormProps } from "@/components/studio/sections";

const SHAPE = statsSectionSchema.shape;

/**
 * The shape of ONE figure, reached through the array.
 *
 * `removeDefault()` then `.element` then `.shape` — all public Zod API, so the help sentences below are
 * the same strings the schema wrote and cannot drift from them.
 */
const ITEM = SHAPE.items.removeDefault().element.shape;

type StatsItem = StatsSectionData["items"][number];

/** `"" | "crafts" | "people" | …` — the metric field's own type, so no second list is written here. */
type StatsMetric = StatsItem["metric"];

/** Matches `.max(8)` on the items array. Stated in the schema's own message as well. */
const MAX_ITEMS = 8;

/**
 * The closed list of countable figures, in `CENSUS_METRICS`' own order.
 *
 * That order is also the order lib/sections/resolve.ts issues its `count`s in, so the picker reads the
 * way the queries run — and, more usefully, it groups the collections an editor thinks of together
 * (crafts, people, projects, research) ahead of the ones they reach for rarely.
 *
 * `""` is NOT in this list: it is the `<Select>`'s `placeholder`, which renders as an empty-valued first
 * option and stays selectable, so an editor who chose a count by mistake can get back to typing by hand.
 */
const METRIC_OPTIONS: readonly SelectOption[] = CENSUS_METRICS.map((metric) => ({
  value: metric,
  // Unguarded, and legitimately so: this maps over `CENSUS_METRICS` itself, and
  // `CENSUS_METRIC_DEFINITIONS` is `Record<CensusMetric, …>`, so a missing entry is a compile error
  // rather than a runtime one. Every lookup by a STORED value goes through `definitionFor` instead.
  label: CENSUS_METRIC_DEFINITIONS[metric].label
}));

/** One entry of `CENSUS_METRIC_DEFINITIONS`, named so the guarded lookup can talk about its result. */
type CensusDefinition = (typeof CENSUS_METRIC_DEFINITIONS)[CensusMetric];

/**
 * The definitions, indexed by an arbitrary string rather than by `CensusMetric`.
 *
 * ⚠ THIS WIDENING IS THE POINT, NOT A CONVENIENCE, and it loosens no check: it makes TypeScript admit
 * what is true at runtime. `CENSUS_METRIC_DEFINITIONS[metric]` where `metric: CensusMetric` is typed as
 * ALWAYS PRESENT, so the compiler cannot see the miss — and a miss is reachable, because the payload
 * this form is handed has not always been through the enum (see the header). Reading through a
 * `Partial<Record<string, …>>` gives back `| undefined`, which is what forces every caller to say what
 * happens when there is no definition. It is the same idiom `sectionFormFor` uses for the same reason.
 */
const METRIC_DEFINITIONS: Partial<Record<string, CensusDefinition>> = CENSUS_METRIC_DEFINITIONS;

/**
 * What a stored `metric` means, or `undefined` where this release cannot say.
 *
 * `unknown` rather than `StatsMetric`, deliberately: on the repair path the stored value has not been
 * through `censusMetricField()` and may be any JSON scalar at all, and a signature promising otherwise
 * would be the same false guarantee this file has already been burnt by. `""` — the resting state, "typed
 * by hand" — answers `undefined` like every other unrecognised value, which is exactly right: neither
 * names a count this build can take.
 */
function definitionFor(metric: unknown): CensusDefinition | undefined {
  if (typeof metric !== "string" || metric.length === 0) return undefined;
  return METRIC_DEFINITIONS[metric];
}

/**
 * What this figure will actually be, in a few words, for the collapsed row.
 *
 * A COUNTED figure has no typed value at all, so without this the row would collapse to its label alone
 * — and to "This figure is empty" while the label is still unwritten, about a row that is finished and
 * will render a number. That is the same mistake the block itself used to make in the other direction.
 *
 * A metric with no definition falls through to `""`, which is what the PAGE does with it too: `.catch("")`
 * made it "typed by hand", and with nothing typed `StatsSection` drops the figure. So a row this build
 * cannot count summarises as empty — which is the truth about it — rather than crashing the panel.
 */
function summariseFigure(item: StatsItem): string {
  const typed = `${item.value}${item.suffix}`.trim();
  if (typed.length > 0) return typed;
  const counted = definitionFor(item.metric);
  if (counted) return `Counted: ${counted.label}`;
  return "";
}

export function StatsForm({ data, onChange, onDirty }: SectionFormProps<StatsSectionData>) {
  const update = (patch: Partial<StatsSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  return (
    <div className="space-y-5">
      <Field
        label="Small line above the heading"
        help={SHAPE.eyebrow.description}
        maxLength={60}
        value={data.eyebrow}
      >
        <Input value={data.eyebrow} onChange={(event) => update({ eyebrow: event.target.value })} />
      </Field>

      <Field label="Heading" help={SHAPE.heading.description} maxLength={120} value={data.heading}>
        <Input value={data.heading} onChange={(event) => update({ heading: event.target.value })} />
      </Field>

      <RepeaterField<StatsItem>
        label="The figures"
        help={SHAPE.items.description}
        items={data.items}
        onChange={(items) => update({ items })}
        max={MAX_ITEMS}
        itemNoun="figure"
        // ⚠ `metric: ""` IS NOT A FILLER. It is the schema's own resting state — "this figure is typed
        // by hand, and counts nothing" — so a newly added row behaves exactly as every row did before
        // the census existed, and the editor opts into counting rather than out of it.
        createItem={() => ({ label: "", value: "", metric: "", suffix: "", description: "" })}
        // `metric` counts towards emptiness: a row whose ONLY content is a chosen metric renders a real
        // figure on the page, so treating it as blank would remove it with no confirmation at all.
        isEmpty={(item) =>
          [item.label, item.value, item.metric, item.suffix, item.description].every(
            (field) => field.trim().length === 0
          )
        }
        summary={(item) => {
          const figure = summariseFigure(item);
          const label = item.label.trim();
          if (figure.length > 0 && label.length > 0) return `${figure} — ${label}`;
          return figure.length > 0 ? figure : label;
        }}
        renderItem={({ item, update: updateItem }) => {
          /**
           * The chosen metric, or `undefined` where the figure is typed by hand — AND where the stored
           * metric is one this build has no definition for, which is the same thing as far as the page is
           * concerned: nothing will be counted for it. See `definitionFor`.
           */
          const counted = definitionFor(item.metric);
          /**
           * The count this row asked for AND WILL NOT GET, because it also carries a typed figure and the
           * typed one wins. `null` in every other case, so the warning below both fires and names the
           * metric from one narrowing.
           *
           * Keyed on `counted` rather than on `item.metric` being non-empty, so an unrecognised metric does
           * NOT raise the warning: there is no count for it to lose, and warning about one would send an
           * editor hunting for a figure that was never going to appear.
           */
          const deadCount = counted && item.value.trim().length > 0 ? counted : null;

          return (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="The figure" help={ITEM.value.description} maxLength={16} value={item.value}>
                  <Input
                    value={item.value}
                    onChange={(event) => updateItem({ ...item, value: event.target.value })}
                    // The placeholder follows the choice below, so an empty box on a counted figure
                    // reads as "the site fills this in" rather than as work left undone. Keyed on
                    // `counted`, NOT on `item.metric`: a metric this build cannot count must not promise
                    // that the site will fill the box in, because it will not.
                    placeholder={counted ? "Counted automatically" : "1,240"}
                    // A text input, deliberately. See the header.
                    inputMode="text"
                  />
                </Field>

                <Field label="Unit after it" help={ITEM.suffix.description} maxLength={12} value={item.suffix}>
                  <Input
                    value={item.suffix}
                    onChange={(event) => updateItem({ ...item, suffix: event.target.value })}
                    placeholder="cr"
                  />
                </Field>
              </div>

              {/*
                The census picker. See the header for why the definition is the field's `help` and not a
                paragraph beside it, and for how an unrecognised stored value reaches this form at all —
                every read of it here goes through `definitionFor`, and a value the list does not contain
                selects no option, so the `<select>` shows the "typed by hand" placeholder, which is what
                the page will do with it too.
              */}
              <Field
                label="Where the figure comes from"
                help={
                  <>
                    {ITEM.metric.description}
                    {/*
                      The definition ALONE, with no "Crafts:" prefix in front of it. The chosen metric's
                      name is already the select's visible value, and a screen reader announces that value
                      immediately before this sentence — so a prefix would be the same word three times in
                      one breath ("Crafts, combo box, Crafts: Crafts with a published record…").
                    */}
                    {counted ? (
                      <span className="mt-1 block text-ink-700">{counted.definition}</span>
                    ) : null}
                  </>
                }
              >
                <Select
                  value={item.metric}
                  placeholder="Typed by hand, in the box above"
                  options={METRIC_OPTIONS}
                  // A native select can only hand back one of the values it was given, and that list is
                  // `CENSUS_METRICS` itself — the same argument the casts in ShowcaseForm rest on.
                  onChange={(event) =>
                    updateItem({ ...item, metric: event.target.value as StatsMetric })
                  }
                />
              </Field>

              {deadCount ? (
                <HelpText tone="warn">
                  This figure is both typed in and counted from the site, and what is typed in wins — so
                  the count of {deadCount.label.toLowerCase()} will not appear anywhere. Clear the figure
                  box to let the site count it, or set &ldquo;Where the figure comes from&rdquo; back to
                  typed by hand.
                </HelpText>
              ) : null}

              <Field label="What it counts" help={ITEM.label.description} maxLength={60} value={item.label}>
                <Input
                  value={item.label}
                  onChange={(event) => updateItem({ ...item, label: event.target.value })}
                  placeholder="Research projects"
                />
              </Field>

              <Field
                label="One line of context"
                help={ITEM.description.description}
                maxLength={140}
                value={item.description}
              >
                <Input
                  value={item.description}
                  onChange={(event) => updateItem({ ...item, description: event.target.value })}
                />
              </Field>
            </>
          );
        }}
      />

      <Switch
        label="Count each figure up as the reader arrives"
        description={SHAPE.countUp.description}
        checked={data.countUp}
        onCheckedChange={(checked) => update({ countUp: checked })}
      />

      <Field
        label="Where these figures come from"
        help={SHAPE.source.description}
        maxLength={160}
        value={data.source}
      >
        <Input
          value={data.source}
          onChange={(event) => update({ source: event.target.value })}
          placeholder="Annual report, March 2026"
        />
      </Field>
    </div>
  );
}
