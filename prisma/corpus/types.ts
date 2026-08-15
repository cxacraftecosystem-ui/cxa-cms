/**
 * THE DEMONSTRATION CORPUS — the shapes, and the one rule that holds it together.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY IT EXISTS. A fresh installation of this portal had three pages and nothing else: no craft, no
 * project, no person, no publication. So the homepage's narrative was followed by four showcase
 * blocks each saying it had nothing to show, the craft explorer was an empty map, the A–Z index was
 * a row of dead letters, and search returned nothing for every query. Every one of those surfaces
 * was CORRECT — they say plainly that they are empty, which is the contract — and the site was still
 * impossible to evaluate, demonstrate or design against.
 *
 * This is a coherent body of content about real Indian craft traditions, cross-referenced the way a
 * real archive would be, so every surface has something true to show on the day it is installed.
 *
 * ⚠ IT IS DEMONSTRATION DATA AND IT SAYS SO. Every record it writes is marked in the studio, and
 * `npx tsx prisma/seed.ts --purge-corpus` removes all of it in one transaction. An institution
 * putting real records in must be able to get the sample ones out without picking them apart by
 * hand — otherwise the safe move is never to seed at all, and the site ships empty again.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ EVERY CROSS-REFERENCE IS A SLUG, NEVER AN ID.
 *
 * The modules below are written independently and none of them can know a `cuid()` that does not
 * exist yet. So a project names its research area as `"material-science"`, a craft names its region
 * as `"kachchh"`, and `seedCorpus()` resolves every one of those to a real id after the records they
 * point at have been written. A slug that resolves to nothing is REPORTED — loudly, by name — rather
 * than quietly left null, because a silently unlinked project is a project that vanishes from the
 * one page it was written for.
 *
 * ⚠ AND EVERY PHOTOGRAPH IS A CRAFT-MANIFEST SLUG. `photo: "warli"` means the bundled, openly
 * licensed photograph in `public/craft/warli.jpg`, which `seedCorpus()` has already written as a
 * `MediaAsset`. There is no other source of imagery in a fresh install, and inventing an object key
 * that points at nothing would give every card the "image unavailable" placeholder.
 */

import type { ContentStatus, EventMode, PersonKind, ProjectStatus, PublicationKind } from "@prisma/client";

/**
 * A slug from `lib/media/craft-imagery.ts` — one of the 26 bundled photographs.
 *
 * Typed as a plain string rather than a union of the manifest's slugs on purpose: the manifest is
 * GENERATED and its contents change when somebody re-runs the fetcher, and a corpus module that
 * stopped compiling because a photograph was swapped would be a corpus nobody dares re-run. An
 * unknown slug is reported by `seedCorpus()` at write time instead.
 */
export type CraftPhotoSlug = string;

export interface SeedRegion {
  slug: string;
  name: string;
  /** "country" | "state" | "district" | "town". Free text; the explorer groups by it. */
  level: string;
  /** Another region's slug. The tree is at most three deep. */
  parent?: string;
  latitude?: number;
  longitude?: number;
}

export interface SeedSchool {
  slug: string;
  name: string;
  description?: string;
}

export interface SeedCraft {
  slug: string;
  name: string;
  /** The name in the language it is practised in, in that language's own script. */
  localName?: string;
  /** A BCP-47 tag — "hi", "gu", "ta", "bn". Announced by a screen reader as a language change. */
  localNameLang?: string;
  /** Two or three sentences. This is what the card, the map pin and the search result all show. */
  summary: string;
  /** Paragraphs. Rendered as the body of the craft's own page. */
  bodyParagraphs: string[];
  region: string;
  school?: string;
  originYear?: number;
  originNote?: string;
  /** Free-text spellings, as a practitioner would say them. The explorer slugs them for its URLs. */
  materials: string[];
  techniques: string[];
  latitude?: number;
  longitude?: number;
  photo?: CraftPhotoSlug;
  isFeatured?: boolean;
}

export interface SeedResearchArea {
  slug: string;
  title: string;
  summary: string;
  bodyParagraphs: string[];
  /** A lucide export name. Falls back to a neutral glyph if the icon set has renamed it. */
  icon?: string;
  sortOrder?: number;
  photo?: CraftPhotoSlug;
}

export interface SeedPerson {
  slug: string;
  name: string;
  kind: PersonKind;
  designation?: string;
  department?: string;
  /** A paragraph. Shown on the directory card and at the head of their own page. */
  bio: string;
  email?: string;
  website?: string;
  orcid?: string;
  googleScholar?: string;
  researchInterests: string[];
  sortOrder?: number;
  /** ⚠ A PORTRAIT IS NOT AVAILABLE and must not be faked — see the note in `people.ts`. */
  photo?: undefined;
}

export interface SeedProjectMember {
  /** A person's slug. */
  person: string;
  role: string;
  isLead?: boolean;
}

export interface SeedProjectMilestone {
  title: string;
  detail?: string;
  /** `YYYY-MM-DD`. */
  dueOn?: string;
  isComplete?: boolean;
}

export interface SeedProject {
  slug: string;
  title: string;
  tagline?: string;
  summary: string;
  bodyParagraphs: string[];
  state: ProjectStatus;
  researchArea?: string;
  fundingBody?: string;
  fundingAmount?: string;
  fundingCurrency?: string;
  /** `YYYY-MM-DD`. */
  startedOn?: string;
  endedOn?: string;
  /** 0–100. Must agree with `state`: a COMPLETED project at 40% is a contradiction on the card. */
  progress?: number;
  members?: SeedProjectMember[];
  milestones?: SeedProjectMilestone[];
  photo?: CraftPhotoSlug;
  isFeatured?: boolean;
}

export interface SeedPublication {
  slug: string;
  kind: PublicationKind;
  title: string;
  abstract?: string;
  /** The full author line as it should be CITED, e.g. "Rao, M., & Iyer, S." */
  authorLine: string;
  /** Slugs of people who are authors, in order. Drives the "their publications" list. */
  authors?: string[];
  venue?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  year: number;
  month?: number;
  /** ⚠ MUST BE FICTIONAL. See the warning in `work.ts` — a real DOI would misattribute real work. */
  doi?: string;
  keywords: string[];
  researchArea?: string;
  isFeatured?: boolean;
}

export interface SeedPost {
  slug: string;
  title: string;
  subtitle?: string;
  excerpt: string;
  bodyParagraphs: string[];
  /** A category name; created if it does not exist. */
  category?: string;
  tags?: string[];
  /** Days BEFORE now. Keeps the newsroom plausibly recent whenever the seed is run. */
  publishedDaysAgo: number;
  photo?: CraftPhotoSlug;
  isFeatured?: boolean;
}

export interface SeedEventAgendaItem {
  title: string;
  detail?: string;
  /** `HH:MM`, 24-hour. */
  startsAt?: string;
  speaker?: string;
}

export interface SeedEvent {
  slug: string;
  title: string;
  subtitle?: string;
  summary: string;
  bodyParagraphs: string[];
  mode: EventMode;
  venue?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  onlineUrl?: string;
  /**
   * Days from now. NEGATIVE is in the past.
   *
   * ⚠ RELATIVE, NEVER ABSOLUTE. A corpus with fixed dates is a corpus whose "upcoming events" block
   * is empty six months after it was written — and an empty upcoming-events block on a demonstration
   * site reads as a broken feature rather than as stale sample data.
   */
  startsInDays: number;
  /** Hours after the start. */
  durationHours?: number;
  capacity?: number;
  isRegistrationOpen?: boolean;
  agenda?: SeedEventAgendaItem[];
  photo?: CraftPhotoSlug;
  isFeatured?: boolean;
}

export interface SeedPartner {
  slug: string;
  name: string;
  url?: string;
  /** "Funder" | "Academic" | "Museum" | "Government" | "Community". */
  category?: string;
  sortOrder?: number;
}

/**
 * What every corpus module exports.
 *
 * `Partial` so a module can supply one collection and leave the rest to its siblings — the seeder
 * merges them, and a missing key is an absence rather than an empty array that would look deliberate.
 */
/**
 * A gallery album — the "book" on the gallery shelf, and the pages inside it.
 *
 * Albums exist in the corpus because the gallery index is a designed surface (the hover-expand
 * bookshelf) that an evaluator cannot judge against the honest-but-empty "There are no albums yet"
 * card. Every photograph is a craft-manifest slug, like everywhere else in the corpus; an album's
 * cover defaults to its first item's photograph, so most albums never state one.
 */
export interface SeedGalleryAlbum {
  slug: string;
  title: string;
  /** A sentence or two. Shown on the album's own page. */
  description?: string;
  /** "Fieldwork" | "Workshops" | "Exhibitions"… — free text; the gallery filters by it. */
  category?: string;
  location?: string;
  /** ISO date of the event the album records. */
  happenedOn?: string;
  /** Craft-manifest slug for the cover. Defaults to the first item's photograph. */
  cover?: CraftPhotoSlug;
  items: readonly { photo: CraftPhotoSlug; caption?: string }[];
}

export interface CorpusModule {
  regions?: readonly SeedRegion[];
  schools?: readonly SeedSchool[];
  crafts?: readonly SeedCraft[];
  researchAreas?: readonly SeedResearchArea[];
  people?: readonly SeedPerson[];
  projects?: readonly SeedProject[];
  publications?: readonly SeedPublication[];
  posts?: readonly SeedPost[];
  events?: readonly SeedEvent[];
  partners?: readonly SeedPartner[];
  galleryAlbums?: readonly SeedGalleryAlbum[];
}

/**
 * The status every corpus record is written with.
 *
 * PUBLISHED, deliberately. Demonstration content that arrives as a draft is demonstration content
 * nobody sees — and the point of the exercise is that the public site has something on it. The
 * `--purge-corpus` flag is what makes that safe.
 */
export const CORPUS_STATUS: ContentStatus = "PUBLISHED";

/**
 * HOW `--purge-corpus` KNOWS WHAT TO DELETE: it matches the SLUGS the corpus modules declare, and
 * nothing else.
 *
 * ⚠ THE ALTERNATIVES ARE BOTH WORSE, and it is worth saying why.
 *
 *   • A stamped tag column would need a migration on nine tables to hold a flag that exists only for
 *     sample data — and `Craft`, `Project` and `Person` have no tag field to stamp.
 *   • A slug PREFIX (`sample-warli`) would put the word "sample" in every public URL the
 *     demonstration site shows, which is precisely the site somebody is being shown.
 *
 * Matching the declared slugs has one consequence, and it is the right one: **a record an editor has
 * renamed is left alone.** Renaming is the first thing an institution evaluating the software does,
 * and a purge that deleted their edited version would destroy real work to tidy up sample content.
 * Leaving one behind is a tidiness problem; deleting one is a data-loss problem.
 */
export function corpusSlugs(modules: readonly CorpusModule[]): {
  crafts: string[];
  regions: string[];
  schools: string[];
  researchAreas: string[];
  people: string[];
  projects: string[];
  publications: string[];
  posts: string[];
  events: string[];
  partners: string[];
  galleryAlbums: string[];
} {
  const gather = <T extends { slug: string }>(pick: (m: CorpusModule) => readonly T[] | undefined) =>
    modules.flatMap((module) => (pick(module) ?? []).map((entry) => entry.slug));

  return {
    crafts: gather((m) => m.crafts),
    regions: gather((m) => m.regions),
    schools: gather((m) => m.schools),
    researchAreas: gather((m) => m.researchAreas),
    people: gather((m) => m.people),
    projects: gather((m) => m.projects),
    publications: gather((m) => m.publications),
    posts: gather((m) => m.posts),
    events: gather((m) => m.events),
    partners: gather((m) => m.partners),
    galleryAlbums: gather((m) => m.galleryAlbums)
  };
}
