"use client";

/**
 * PeopleDirectory — the roster, filtered in the BROWSER.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS ONE IS NOT URL-DRIVEN. Every other listing on this site filters on the server through
 * `FilterBar`, because the corpus is unbounded and paging it is the only correct answer. A Centre's
 * roster is not: it is bounded by how many people work there, the server sends the whole thing in one
 * query, and filtering it here means typing is instant, there is no request to race, no generation
 * counter to get wrong, and no `items === null` "Loading…" state at all (contract §9). The trade is
 * that a filtered view is not a shareable link — which is the right trade for a search box somebody
 * uses for four seconds to find one colleague.
 *
 * THE SERVER'S ORDER IS PRESERVED. `Array.prototype.filter` keeps input order, and the page ordered
 * the roster by `sortOrder` then `name` then `id` — a TOTAL order. Nothing here re-sorts, so the list
 * cannot reshuffle between renders and look like data changing.
 *
 * NO DEBOUNCE. A debounce exists to stop requests, and there are none: filtering a few hundred rows in
 * a `useMemo` is one pass over an array. A timer here would only add latency to every keystroke.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useMemo, useState } from "react";
import type { PersonKind } from "@prisma/client";
import { FilterX, SearchX, TriangleAlert, Users } from "lucide-react";

import { CardGrid } from "@/components/site/CardGrid";
import {
  PERSON_KIND_GROUPS,
  PERSON_KIND_ORDER,
  PersonCard,
  type PersonCardPerson
} from "@/components/site/PersonCard";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { SearchInput } from "@/components/ui/SearchInput";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/utils";

export interface DirectoryPerson extends PersonCardPerson {
  /** React key. The slug would do, but the id is what the database calls this row. */
  id: string;
}

export interface PeopleDirectoryProps {
  /** The whole roster, already ordered. See the header. */
  people: readonly DirectoryPerson[];
  /** True when the server's query stopped short of everyone who is published. */
  truncated: boolean;
  /** The limit that was applied, named in the truncation sentence. */
  cap: number;
  /** How many published profiles there are in total. Equal to `people.length` unless capped. */
  total: number;
}

/**
 * Fold to a comparable form: lower case, diacritics stripped, whitespace collapsed.
 *
 * NFD FIRST, then strip the combining marks — the same order as `slugify` in lib/utils.ts and for the
 * same reason: "é" is a single codepoint that a character class removes whole, so "Chatterjée" would
 * become "Chatterj" rather than "Chatterjee" and a search for the ASCII spelling would find nothing.
 * Researchers' names carry diacritics constantly and readers type them without.
 */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Everything about a person that the search box looks at, folded once per row. */
function searchableText(person: DirectoryPerson): string {
  return fold(
    [
      person.name,
      person.designation ?? "",
      person.department ?? "",
      ...(person.researchInterests ?? [])
    ].join(" ")
  );
}

/** Sort a facet's values the way a reader reads a list of names: alphabetically, case-insensitively. */
function sortLabels(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b, "en-GB", { sensitivity: "base" }));
}

interface KindGroup {
  kind: PersonKind;
  label: string;
  people: DirectoryPerson[];
}

export function PeopleDirectory({ people, truncated, cap, total }: PeopleDirectoryProps) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<string>("");
  const [department, setDepartment] = useState<string>("");
  const [interest, setInterest] = useState<string>("");

  /**
   * The search haystack, built once per roster rather than per keystroke.
   *
   * Folding four fields for four hundred people on every character typed is the difference between a
   * search box that feels instant and one that feels sticky on a mid-range phone.
   */
  const haystack = useMemo(() => {
    const index = new Map<string, string>();
    for (const person of people) index.set(person.id, searchableText(person));
    return index;
  }, [people]);

  /**
   * The facets come from the LOADED roster, so every option in them leads somewhere. A department list
   * built from a separate query could offer a department whose only member is on the far side of the
   * cap — a filter that returns nothing, with no way for the reader to know why.
   */
  const departments = useMemo(
    () =>
      sortLabels(
        new Set(
          people
            .map((person) => person.department?.trim() ?? "")
            .filter((value) => value.length > 0)
        )
      ),
    [people]
  );

  const interests = useMemo(
    () =>
      sortLabels(
        new Set(
          people.flatMap((person) =>
            (person.researchInterests ?? [])
              .map((value) => value.trim())
              .filter((value) => value.length > 0)
          )
        )
      ),
    [people]
  );

  const kinds = useMemo(() => {
    const counts = new Map<PersonKind, number>();
    for (const person of people) counts.set(person.kind, (counts.get(person.kind) ?? 0) + 1);
    return PERSON_KIND_ORDER.filter((value) => (counts.get(value) ?? 0) > 0).map((value) => ({
      value,
      // The count is part of the label so a reader can see how big a group is before choosing it.
      label: `${PERSON_KIND_GROUPS[value]} (${counts.get(value) ?? 0})`
    }));
  }, [people]);

  const matches = useMemo(() => {
    const needle = fold(query);
    const foldedInterest = interest ? fold(interest) : "";

    return people.filter((person) => {
      if (kind && person.kind !== kind) return false;
      if (department && (person.department?.trim() ?? "") !== department) return false;
      if (
        foldedInterest &&
        !(person.researchInterests ?? []).some((value) => fold(value) === foldedInterest)
      ) {
        return false;
      }
      if (needle.length === 0) return true;
      // Every whitespace-separated word must appear somewhere in the row, so "ravi textile" finds a
      // Ravi who works on textiles rather than everyone called Ravi and everyone in textiles.
      const text = haystack.get(person.id) ?? "";
      return needle.split(" ").every((word) => text.includes(word));
    });
  }, [people, haystack, query, kind, department, interest]);

  const groups = useMemo<KindGroup[]>(() => {
    const byKind = new Map<PersonKind, DirectoryPerson[]>();
    for (const person of matches) {
      const bucket = byKind.get(person.kind);
      if (bucket) bucket.push(person);
      else byKind.set(person.kind, [person]);
    }

    const ordered: KindGroup[] = [];
    for (const value of PERSON_KIND_ORDER) {
      const bucket = byKind.get(value);
      if (bucket && bucket.length > 0) {
        ordered.push({ kind: value, label: PERSON_KIND_GROUPS[value], people: bucket });
        byKind.delete(value);
      }
    }

    // Anything the order array does not name is appended rather than dropped. `PERSON_KIND_ORDER` is
    // maintained by hand, so a value added to the enum and to the label map but forgotten here would
    // otherwise make a whole group of people silently disappear from the roster.
    for (const [value, bucket] of byKind) {
      ordered.push({ kind: value, label: PERSON_KIND_GROUPS[value], people: bucket });
    }

    return ordered;
  }, [matches]);

  const filtering =
    query.trim().length > 0 || kind.length > 0 || department.length > 0 || interest.length > 0;

  const clearAll = () => {
    setQuery("");
    setKind("");
    setDepartment("");
    setInterest("");
  };

  const omitted = Math.max(0, total - people.length);

  return (
    <div className="flex flex-col gap-8">
      <section aria-label="Filter the directory" className="flex flex-col gap-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end">
          <SearchInput
            label="Search people by name, role, department or research interest"
            placeholder="Search people"
            value={query}
            onValueChange={setQuery}
            className="sm:min-w-[18rem] sm:flex-1"
          />

          {/*
            `Field` (a real <label>) is correct here and only here: each control is a NATIVE <select>,
            so there is no button inside to swallow the click a label forwards (Field.tsx).
          */}
          <Field label="Role" className="sm:w-56">
            <Select
              options={kinds}
              placeholder="All roles"
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            />
          </Field>

          {departments.length > 0 ? (
            <Field label="Department" className="sm:w-56">
              <Select
                options={departments.map((value) => ({ value, label: value }))}
                placeholder="All departments"
                value={department}
                onChange={(event) => setDepartment(event.target.value)}
              />
            </Field>
          ) : null}

          {interests.length > 0 ? (
            <Field label="Research interest" className="sm:w-64">
              <Select
                options={interests.map((value) => ({ value, label: value }))}
                placeholder="All research interests"
                value={interest}
                onChange={(event) => setInterest(event.target.value)}
              />
            </Field>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line-200 pt-4">
          {/*
            HAND-WRITTEN RATHER THAN `ResultSummary`. That component's range line is written for a paged
            server list — "Showing 1–12 of 84" — and these twelve are scattered through the roster
            rather than being its first twelve. The honest sentence for a filtered set is a count of
            matches, which is a different sentence.

            `role="status"` is right for a list that updates in place with no navigation: without it the
            grid below visibly rebuilds as the reader types and a screen-reader user is told nothing.
            The region is mounted from the first render, so it is registered before its text changes.
          */}
          <p role="status" className="text-sm text-ink-500">
            {matches.length === 0
              ? `No people match${filtering ? " these filters" : ""}`
              : filtering
                ? `${matches.length} of ${people.length} ${people.length === 1 ? "person" : "people"} match`
                : `${people.length} ${people.length === 1 ? "person" : "people"}`}
          </p>

          {filtering ? (
            <Button variant="ghost" icon={FilterX} onClick={clearAll}>
              Clear all filters
            </Button>
          ) : null}
        </div>

        {truncated ? (
          // The cap, stated on screen (contract §1.6). A roster that stops at four hundred looks
          // exactly like a Centre with four hundred people.
          <p className="flex items-start gap-2.5 rounded-md border border-line-200 bg-surface-50 px-3.5 py-2.5 text-sm leading-relaxed text-ink-700">
            <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warn-800" />
            <span>
              This directory loads at most {cap} profiles at once
              {omitted > 0
                ? `, so ${omitted} further ${omitted === 1 ? "person is" : "people are"} not listed here`
                : ""}
              . Search or filter to find someone who is missing.
            </span>
          </p>
        ) : null}
      </section>

      {groups.length === 0 ? (
        <EmptyState
          icon={filtering ? SearchX : Users}
          // Level 2: this stands where the group headings would have been, under the page's `<h1>`.
          headingLevel={2}
          title={filtering ? "No people match these filters" : "No profiles have been published yet"}
          description={
            filtering
              ? "Try a shorter search, or clear the filters to see the whole directory."
              : "People appear here as soon as their profiles are published."
          }
          action={
            filtering ? (
              <Button variant="secondary" icon={FilterX} onClick={clearAll}>
                Clear all filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        groups.map((group, index) => (
          <section key={group.kind} aria-labelledby={`group-${group.kind}`}>
            <h2
              id={`group-${group.kind}`}
              // `data-anchor` earns the header clearance from globals.css for a `#group-…` jump; never
              // restate it as a `scroll-mt-*` (contract §7).
              data-anchor=""
              className={cn(
                "display-title border-b border-line-200 pb-2 text-sm font-semibold uppercase tracking-[0.14em] text-ink-500",
                index > 0 ? "mt-4" : undefined
              )}
            >
              {group.label}
              <span className="ml-2 font-sans font-normal normal-case tracking-normal text-ink-300">
                {group.people.length}
              </span>
            </h2>

            <div className="mt-6">
              {/*
                No `stagger`: the grid re-renders on every keystroke, and a fade-up replayed as the
                reader types is a flicker book rather than an entrance. The cards under the first
                heading are also above the fold, where an entrance animation delays the content.
              */}
              <CardGrid columns={4}>
                {group.people.map((person) => (
                  <PersonCard key={person.id} person={person} headingLevel={3} />
                ))}
              </CardGrid>
            </div>
          </section>
        ))
      )}
    </div>
  );
}
