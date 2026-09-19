/**
 * The vocabulary of the Centre's roster: what each group of people is called, what order the groups go
 * in, and where each group's page lives.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS IN `lib/` AND NOT IN A COMPONENT, WHICH IS WHERE IT USED TO BE.
 *
 * These three maps lived in components/site/PersonCard.tsx, and two files had already been forced to
 * write their own copy rather than import a CARD:
 *
 *   • app/api/studio/people/reorder/route.ts — "A deliberate second copy … importing it here to read a
 *     label would pull a renderer and the components under it into an API route".
 *   • app/(site)/people/[slug]/opengraph-image.tsx — dropped the label from the share card altogether,
 *     because the vocabulary "lives in a component module that drags a good part of the site's card
 *     stack into a route which runs cold, once per crawler, to draw eight words".
 *
 * Both were right about the cost and both were paying it in a different currency: one in duplication
 * that a future edit would desynchronise, one in a share card that says less than it could. Two more
 * callers were about to join them — the site header, which is a CLIENT component and would have
 * shipped the card stack to every visitor, and app/sitemap.ts, which is neither.
 *
 * So the words moved here, where anything may import them: this module has no runtime imports at all
 * (the `PersonKind` import is a TYPE and is erased at compile time), so it costs a Server Component, a
 * Client Component, an API route, an OG image route and a plain `tsx` script exactly the same nothing.
 * `PersonCard` now imports them like everybody else and re-exports nothing.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { PersonKind } from "@prisma/client";

import type { NavNode } from "@/lib/navigation";

/**
 * The group order for the whole product: the Development Commissioner first, faculty next, alumni last.
 *
 * ⚠ IT DOES NOT MATCH THE DECLARATION ORDER OF THE `PersonKind` ENUM, and that is the point. It once
 * did, so a Postgres `ORDER BY kind` happened to produce the same sequence; `DC_HANDICRAFTS` was
 * appended at the END of the enum (a plain `ALTER TYPE … ADD VALUE`, see the migration) and belongs at
 * the HEAD of the roster, so the two orders have diverged. Every page groups from this array rather
 * than in SQL, which is why that divergence costs nothing — grouping in code is what made the enum free
 * to be appended to.
 *
 * DC, Handicrafts heads the list rather than sitting among the staff grades because it is an office of
 * the Ministry of Textiles rather than a rank of Centre employment, and a reader looking for it is
 * looking for the Centre's line to craft policy. That is a presentation decision and lives ONLY here:
 * moving the group is a one-line edit in this array, with no migration and no other file touched.
 */
export const PERSON_KIND_ORDER: readonly PersonKind[] = [
  "DC_HANDICRAFTS",
  "FACULTY",
  "SCIENTIST",
  "RESEARCHER",
  "STUDENT",
  "STAFF",
  "VISITOR",
  "ALUMNUS"
];

/** Singular — a chip beside one person's name, or the eyebrow on their profile. */
export const PERSON_KIND_LABELS: Record<PersonKind, string> = {
  FACULTY: "Faculty",
  SCIENTIST: "Scientist",
  RESEARCHER: "Researcher",
  STUDENT: "Student",
  STAFF: "Staff",
  VISITOR: "Visitor",
  ALUMNUS: "Alumnus",
  // "DC" is not expanded. It is how the office is written on every letterhead and how anyone looking
  // for it would scan a roster; "Development Commissioner (Handicrafts)" is the expansion and belongs
  // in the person's `designation`, which is what that free-text field is for. The comma is part of the
  // title, not a list separator.
  DC_HANDICRAFTS: "DC, Handicrafts"
};

/**
 * Plural — the heading over a group of them, the label on a group's page and in the header menu.
 *
 * Written out rather than derived from the singular because "Faculty" and "Staff" are already plural,
 * "Alumnus" pluralises to "Alumni" and "DC, Handicrafts" is one office — a naive `${label}s` gets four
 * of the eight wrong.
 */
export const PERSON_KIND_GROUPS: Record<PersonKind, string> = {
  FACULTY: "Faculty",
  SCIENTIST: "Scientists",
  RESEARCHER: "Researchers",
  STUDENT: "Students",
  STAFF: "Staff",
  VISITOR: "Visitors",
  ALUMNUS: "Alumni",
  // Identical to the singular label on purpose: there is one Development Commissioner (Handicrafts) at
  // a time, so "DCs, Handicrafts" would be a heading for a group that cannot have two members.
  DC_HANDICRAFTS: "DC, Handicrafts"
};

/** The directory itself. Restated as a constant so the group pages and the header agree on one string. */
export const PEOPLE_PATH = "/people";

/**
 * Where a group's page lives: `/people/group/<slug>`.
 *
 * ⚠ THE `group` SEGMENT IS WHAT KEEPS THESE PAGES AND THE PROFILES APART, AND IT IS NOT DECORATION.
 * `/people/[slug]` is one person's profile, and a person's slug is free text an editor types. Had the
 * groups been addressed at `/people/faculty`, a profile slugged "faculty" would have COLLIDED WITH THE
 * GROUP PAGE — and a static segment beats a dynamic one, so the collision would have taken the PROFILE
 * off the site, silently, with nothing to see but a person nobody can reach.
 *
 * At two segments deep there is nothing to defend and nothing is reserved: `[slug]` matches exactly one
 * segment, so no profile address can reach these pages, and a person slugged "group" still resolves at
 * `/people/group` because this directory holds no page of its own at that depth.
 *
 * The shape is also the one this site already uses for a facet of a listing — `/news/category/<slug>`
 * and `/news/tag/<slug>` — rather than a second one invented for this.
 */
export const PEOPLE_GROUP_PREFIX = "/people/group";

/**
 * The address of each group, as a word rather than as an enum value.
 *
 * ⚠ THESE ARE PUBLIC URLs AND THEY ARE WRITTEN OUT, NOT DERIVED. `slugify(PERSON_KIND_GROUPS[kind])`
 * would produce the same eight strings today and would silently change one of them the day somebody
 * improves a label — and a renamed URL is a broken bookmark, a broken citation and a 404 in somebody
 * else's page. Labels are presentation and may be edited freely; these are addresses and may not.
 */
export const PERSON_GROUP_SLUGS: Record<PersonKind, string> = {
  DC_HANDICRAFTS: "dc-handicrafts",
  FACULTY: "faculty",
  SCIENTIST: "scientists",
  RESEARCHER: "researchers",
  STUDENT: "students",
  STAFF: "staff",
  VISITOR: "visitors",
  ALUMNUS: "alumni"
};

/**
 * What each group's page says under its title.
 *
 * One sentence, in the Centre's own terms rather than the enum's: a reader arriving on
 * `/people/group/researchers` from a search engine has no idea what this institution calls its grades,
 * and "Researchers" alone tells them nothing they did not already read in the title.
 */
export const PERSON_GROUP_DESCRIPTIONS: Record<PersonKind, string> = {
  DC_HANDICRAFTS:
    "The Office of the Development Commissioner (Handicrafts), Ministry of Textiles — the Centre's line to national craft policy, and the office under which this work is carried out.",
  FACULTY:
    "The professors of the institute who lead the Centre's research, supervise its students and hold its academic work to account.",
  SCIENTIST:
    "The scientific staff of the Centre: the people who run its instruments, its methods and its laboratory work.",
  RESEARCHER:
    "Research staff, associates and fellows — the people carrying the Centre's projects from a question to a result.",
  STUDENT:
    "The doctoral, master's and undergraduate students working on the Centre's research and building the next generation of it.",
  STAFF:
    "The administrative, technical and support staff who keep the Centre running, its records straight and its doors open.",
  VISITOR:
    "Visiting researchers, practitioners and artisans in residence — the people who bring another institution's or another craft's knowledge to the Centre for a season.",
  ALUMNUS:
    "The people who built what is here and have since moved on. Their work, and every link to it, stays where it was."
};

/** Every group address, in the order the roster lists them. Used by the sitemap and the header. */
export function personGroupPath(kind: PersonKind): string {
  return `${PEOPLE_GROUP_PREFIX}/${PERSON_GROUP_SLUGS[kind]}`;
}

/**
 * The group a `/people/group/<slug>` address names, or null when it names nothing.
 *
 * NULL RATHER THAN A THROW, because the caller is a page handler resolving a segment a stranger typed,
 * and a studio control calling it on half-typed input: an unknown group is a 404, which is a different
 * thing from a fault.
 *
 * Matched case-insensitively, which rescues `/people/group/FACULTY` and nothing more — a capitalised
 * `/People/Group/Faculty` never reaches this function at all, because the static segments of the route
 * are matched case-sensitively by Next long before the slug is read. The canonical address is emitted
 * by `personGroupPath` and declared in every page's `<link rel="canonical">`, so the lenient spellings
 * that do resolve cannot become a second address in a search index.
 */
export function personGroupFromSlug(slug: string): PersonKind | null {
  /*
   * ⚠ THE DECODE IS GUARDED, AND AN UNGUARDED ONE WAS A 500 AND TWO CRASHED STUDIO SCREENS.
   *
   * Next has ALREADY decoded a dynamic segment by the time it reaches a page, so this second decode is
   * only ever undoing a double encoding — and on a value that is merely unusual it throws: `/people/
   * group/100%25` arrives here as "100%", and `decodeURIComponent("100%")` is a `URIError`. Thrown out
   * of `generateMetadata` that is a 500 for an address whose only crime is not naming a group, which is
   * precisely what this function's "null rather than a throw" promise exists to prevent.
   *
   * It is worse through `isPersonGroupPath`, which two studio controls call DURING RENDER on whatever
   * has been typed so far (components/studio/fields/LinkField.tsx, app/studio/navigation/
   * NavigationEditor.tsx): a single "%" in the address box took the screen down mid-keystroke.
   *
   * An address that cannot be decoded names no group, which is the same answer as any other unknown
   * address.
   */
  let decoded = slug;
  try {
    decoded = decodeURIComponent(slug);
  } catch {
    decoded = slug;
  }

  const wanted = decoded.trim().toLowerCase();

  /*
   * Iterated over the SLUG RECORD rather than over `PERSON_KIND_ORDER`, and the difference is a whole
   * group. `PERSON_GROUP_SLUGS` is a `Record<PersonKind, string>` — a value added to the enum and
   * forgotten there is a compile error — while `PERSON_KIND_ORDER` is a hand-kept array that the roster
   * and the counts both APPEND to when they meet a kind it omits. Resolving from the order array would
   * make such a group the one thing those fallbacks are designed to prevent: listed in the menu, listed
   * on /people, and 404 at its own address.
   */
  for (const [kind, groupSlug] of Object.entries(PERSON_GROUP_SLUGS)) {
    if (groupSlug === wanted) return kind as PersonKind;
  }
  return null;
}

/**
 * Is this address one of the group pages?
 *
 * Used by the studio's link field and the navigation editor, which otherwise report every code route as
 * an address with no `Page` row behind it.
 */
export function isPersonGroupPath(path: string): boolean {
  const base = path.split("?")[0]?.split("#")[0] ?? "";
  const trimmed = base.length > 1 ? base.replace(/\/+$/, "") : base;
  if (!trimmed.startsWith(`${PEOPLE_GROUP_PREFIX}/`)) return false;
  return personGroupFromSlug(trimmed.slice(PEOPLE_GROUP_PREFIX.length + 1)) !== null;
}

/** One group of the roster and how many listable people are in it. */
export interface PersonGroupCount {
  kind: PersonKind;
  count: number;
}

/**
 * The groups as CHILDREN OF A NAV ENTRY — the shape the header's existing dropdown renders.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * DATA, NOT A COMPONENT, FOR THE SAME REASON `socialNavChildren` IS (lib/socials.ts, which carries the
 * argument in full). The header hangs these nodes on the People entry's children and every behaviour
 * follows from code that was already there: `StripItem`'s hover-and-focus disclosure on a laptop,
 * `NavSheet`'s always-expanded child list on a phone, the Escape that closes the panel without closing
 * the sheet, the focus that returns to the trigger, the active-page treatment, both themes and the
 * reduced-motion branch. None of it is re-implemented, and there is no second kind of menu to keep in
 * step with the first.
 *
 * ⚠ ONLY GROUPS WITH SOMEBODY IN THEM SHOULD BE PASSED IN, and the caller is what enforces it —
 * `listablePeopleByGroup` (lib/people/roster.ts) omits the empty ones. Every group has a PAGE regardless;
 * a menu entry is a different promise from an address, and an entry that leads to "nobody is listed
 * here" is a promise broken. This is not contract §1.6 truncation: nothing is being hidden, because an
 * empty group has nothing in it to hide.
 *
 * ⚠ NO `icon`, DELIBERATELY. `NavNode.icon` is a React COMPONENT (lib/navigation.ts), so a node carrying
 * one may only ever be minted on the client. These nodes carry none, which is what makes them safe to
 * build anywhere — but the header still builds them client-side, beside the socials, so there is one
 * place where synthesised nav children are made rather than two.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function peopleGroupNavChildren(groups: readonly PersonGroupCount[]): NavNode[] {
  return groups.map((group) => ({
    // Keyed on the enum value, which is unique and stable for the life of the group — so React reuses
    // the row's DOM when a group appears or empties rather than remounting the whole panel.
    id: `${PEOPLE_GROUP_NAV_ID_PREFIX}${group.kind}`,
    label: PERSON_KIND_GROUPS[group.kind],
    href: personGroupPath(group.kind),
    // Internal, which is what routes these rows through `next/link` rather than the external branch —
    // and what makes them eligible for the active-page treatment. See the header's `withPeopleGroups`.
    isExternal: false,
    // The tree is two levels deep by design (lib/navigation.ts's header) and these ARE the second level.
    children: []
  }));
}

/**
 * The id prefix these synthesised rows carry.
 *
 * Distinct from anything the database can mint — `NavigationItem.id` is a cuid — so a synthesised row
 * and an editor's row can never collide on a React key, and a reader of the DOM can tell which is which.
 */
const PEOPLE_GROUP_NAV_ID_PREFIX = "people-group:";
