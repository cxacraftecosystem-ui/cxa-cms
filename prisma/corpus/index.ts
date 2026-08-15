/**
 * The demonstration corpus, assembled.
 *
 * Four modules, written independently and linked only by SLUG (see `types.ts`), collected here into
 * the `CorpusModule[]` that `seedCorpus()` and `purgeCorpus()` both consume.
 *
 * ⚠ THE ORDER OF THIS ARRAY DOES NOT MATTER AND MUST NOT BE MADE TO. `seedCorpus()` writes in
 * dependency order — regions before crafts, people and research areas before projects and
 * publications, categories before posts — by walking the COLLECTIONS, not the modules. A reader
 * tempted to "fix" the order here so that `people` comes before `work` would be encoding a
 * relationship that is already handled, in the one place it cannot be seen from.
 *
 * A module that supplies nothing for a collection simply omits the key; the writer treats an absent
 * key and an empty array identically.
 */

import { CRAFTS, REGIONS, SCHOOLS } from "./crafts";
import { GALLERY_ALBUMS } from "./gallery";
import { POSTS, EVENTS, PARTNERS } from "./newsroom";
import { PEOPLE, RESEARCH_AREAS } from "./people";
import { PROJECTS, PUBLICATIONS } from "./work";
import type { CorpusModule } from "./types";

export const CORPUS: readonly CorpusModule[] = [
  { regions: REGIONS, schools: SCHOOLS, crafts: CRAFTS },
  { researchAreas: RESEARCH_AREAS, people: PEOPLE },
  { projects: PROJECTS, publications: PUBLICATIONS },
  { posts: POSTS, events: EVENTS, partners: PARTNERS },
  { galleryAlbums: GALLERY_ALBUMS }
];

export { seedCorpus, purgeCorpus, type CorpusResult, type UnresolvedReference } from "./seed-corpus";
export { corpusSlugs, type CorpusModule } from "./types";
