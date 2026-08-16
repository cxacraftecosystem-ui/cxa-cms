/**
 * The recycle bin's vocabulary — the kinds it carries and what an administrator calls them.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ONE LIST, FOUR READERS. `route.ts` lists the bin, `restore/route.ts` puts a row back,
 * `purge/route.ts` destroys one, and `app/studio/recycle-bin/page.tsx` draws the screen. Each of those
 * used to carry its own copy of this table, and four copies of a list is four chances for a kind to be
 * restorable but not listed, or listed but not destroyable — with nothing to say so until somebody hits
 * the branch that is missing.
 *
 * ⚠ ADDING A KIND IS A COMPILE-TIME OBLIGATION, and this file is what makes it one. `BinType` is derived
 * from `BIN_TYPES`, and every dispatch in the three routes is an exhaustive `switch` over it — so a new
 * entry here does not quietly become a kind that can be listed and then fails to restore. It is a type
 * error at each of the places that has to learn about it.
 *
 * Deliberately NOT in `lib/`: nothing outside the recycle bin has any business dispatching on this list,
 * and a shared helper is the usual way a private vocabulary becomes a public one nobody can change.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** The kinds the bin can list, restore and destroy. Each has a branch in every switch that dispatches on it. */
export const BIN_TYPES = [
  "Page",
  "Post",
  "Person",
  "Project",
  "Publication",
  "ResearchArea",
  "CoeEvent",
  "Craft",
  "GalleryAlbum",
  "Partner",
  "MediaAsset",
  "FileAsset",
  "ContactSubmission"
] as const;

export type BinType = (typeof BIN_TYPES)[number];

export interface BinTypeMeta {
  type: BinType;
  /** Plural, in the words an administrator uses. */
  label: string;
  /** Singular, so a sentence can say "delete this news article for good". */
  singular: string;
  /** True where `app/api/cron/purge` will eventually remove these on its own. */
  autoPurged: boolean;
}

/**
 * ⚠ TWO RETENTION RULES, AND THEY ARE NOT THE SAME — `autoPurged` is which one applies.
 *
 * Media files and stored files hold bytes that cost money, so the purge cron removes them once they have
 * been in the bin longer than the window. Everything else stays until somebody removes it. Both facts are
 * printed on the screen, because "the recycle bin empties itself" and "the recycle bin never empties" are
 * both wrong and lead to opposite mistakes.
 */
export const BIN_META: readonly BinTypeMeta[] = [
  { type: "Page", label: "Pages", singular: "page", autoPurged: false },
  { type: "Post", label: "News articles", singular: "news article", autoPurged: false },
  { type: "Person", label: "People", singular: "person's profile", autoPurged: false },
  { type: "Project", label: "Projects", singular: "project", autoPurged: false },
  { type: "Publication", label: "Publications", singular: "publication", autoPurged: false },
  { type: "ResearchArea", label: "Research areas", singular: "research area", autoPurged: false },
  { type: "CoeEvent", label: "Events", singular: "event", autoPurged: false },
  { type: "Craft", label: "Craft records", singular: "craft record", autoPurged: false },
  { type: "GalleryAlbum", label: "Gallery albums", singular: "album", autoPurged: false },
  { type: "Partner", label: "Partners", singular: "partner", autoPurged: false },
  { type: "MediaAsset", label: "Media files", singular: "media file", autoPurged: true },
  { type: "FileAsset", label: "Files", singular: "file", autoPurged: true },
  { type: "ContactSubmission", label: "Enquiries", singular: "enquiry", autoPurged: false }
];

/**
 * The description of a kind, or null.
 *
 * A `find` rather than a `Record` lookup: with `noUncheckedIndexedAccess` an index into a record is
 * `BinTypeMeta | undefined` at every one of thirteen call sites, and each of those would need its own
 * non-null assertion. One nullable answer, checked once, is the honest shape.
 */
export function metaFor(type: string): BinTypeMeta | null {
  return BIN_META.find((entry) => entry.type === type) ?? null;
}

export function isBinType(value: string): value is BinType {
  return (BIN_TYPES as readonly string[]).includes(value);
}

/** The recycle bin IS this filter. Written once so no branch anywhere can forget it. */
export const deletedWhere = { deletedAt: { not: null } } as const;
