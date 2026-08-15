/**
 * Small shared helpers. No dependencies, safe on both sides of the server/client boundary.
 *
 * ⚠ AND SAFE IN A PLAIN NODE PROCESS, WHICH IS A THIRD CONSTRAINT AND NOT A CONSEQUENCE OF THE FIRST TWO.
 * `prisma/seed.ts` imports `truncateWords` from here under `tsx` — no bundler, no React and no `server-only`
 * alias — and `stableJson` below is written to be its second such import. So nothing here may ever import
 * `server-only`, `@/lib/db`, a React module, or anything that reads `process.env` at module scope: any one
 * of those turns a helper shared by three kinds of caller into a helper that breaks the one nobody was
 * thinking about. The file has ZERO imports, which is the cheapest way to keep all three promises at once.
 */

type ClassValue = string | false | null | undefined;

/**
 * Join class names.
 *
 * ⚠ THIS IS A PLAIN JOIN, NOT `tailwind-merge` — deliberately, and identically to the Field
 * Repository's `lib/utils.ts` (skill §11.1). Components are copied between the two products, and a
 * `cn()` that silently de-duplicates in one repo and not the other produces a component that looks
 * right in review and wrong in production.
 *
 * The consequence you must design around: **later classes do NOT win.** CSS source order decides. A
 * `@layer components` recipe is always beaten by any utility (so `className="field-button w-full"`
 * works as written), but to beat another *utility* you need `!` — e.g. `!bg-transparent`.
 */
export function cn(...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(" ");
}

/** Clamp with the bound order enforced, so a transposed call cannot return a value outside both. */
export function clamp(value: number, min: number, max: number): number {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}

/**
 * A URL-safe slug.
 *
 * NFD-normalises first so accented Latin characters decompose and their combining marks can be
 * stripped — without it "Café" becomes "caf" (the é is a single non-ASCII codepoint the character
 * class removes whole) rather than "cafe".
 */
export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96)
    .replace(/-+$/g, "");
}

/** Bytes as a human string. Base 1024, because that is what a file manager shows. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  const digits = value >= 100 || exponent === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[exponent]}`;
}

/**
 * Reading time in whole minutes, floored at 1.
 *
 * 220 wpm is the figure for on-screen prose. Returning 0 for a short note would render "0 min read",
 * which reads as a bug rather than as "this is quick".
 */
export function readingMinutes(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

/** Stable, total ordering by `sortOrder` then a tiebreaker, so a list never reshuffles between requests. */
export function bySortOrderThen<T extends { sortOrder: number }>(
  tiebreak: (item: T) => string
): (a: T, b: T) => number {
  return (a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return tiebreak(a).localeCompare(tiebreak(b));
  };
}

/** Truncate on a word boundary and say so with an ellipsis, never mid-word. */
export function truncateWords(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const cut = trimmed.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Split an array into chunks. Guards `size < 1`, which would otherwise loop forever — the kind of
 * bug that only appears when a caller computes the size from data.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += step) {
    out.push(items.slice(index, index + step));
  }
  return out;
}

/** `unique` preserving first-seen order, which is what every "pick the canonical one" case wants. */
export function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/** Escape a string for safe interpolation into a regular expression. */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * JSON with every object's keys sorted, for asking "is this document the same as that one?".
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ A PLAIN `JSON.stringify` COMPARISON IS ALWAYS UNEQUAL FOR A `jsonb` COLUMN, and it looks right until
 * it is run. Postgres normalises key order on the way in — shortest key first, then bytewise — so a row
 * written as `{eyebrow, heading, items, countUp, source}` reads back as `{items, source, countUp, eyebrow,
 * heading}`, and comparing the two textually reports "different" for a payload that is identical in
 * meaning. Whatever depended on the comparison then never fires: a skip that never skips, a "still the
 * default" test that always answers no.
 *
 * TWO CALLERS LEARNT THAT SEPARATELY, which is the whole argument for this living here rather than twice:
 *
 *   • `lib/health.ts` compares a stored `PageSection.data` against the all-defaults document it builds
 *     from the schema, to tell a block nobody has filled in from one somebody has emptied. It calls THIS
 *     function; the copy it used to carry is gone.
 *   • `repairPlaceholderStats()` in prisma/seed.ts compares a stored payload against the payload it is about
 *     to write, so a repair that would change nothing is skipped instead of logged as an action. ⚠ AT THE
 *     TIME OF WRITING THAT ONE IS STILL ITS OWN COPY — this function was moved here from health.ts by a pass
 *     that did not own prisma/seed.ts, and consolidating it is one import plus a deletion. Recorded in
 *     .audit/INTEGRATION-health-vocab.md rather than described here as though it had happened.
 *
 * Both questions are "same document?", both rows are `jsonb`, and neither caller can be trusted to
 * rediscover the reason a third time. This module was already the right home: it imports NOTHING, which is
 * what lets a `server-only` report, a client component and a plain-`tsx` seed script all read it.
 *
 * ⚠ SORTED WITH A `replacer`, DELIBERATELY, RATHER THAN BY WALKING THE VALUE FIRST. A pre-walk that
 * rebuilds objects before serialising never sees `toJSON()`, so a `Date` — which has no own enumerable
 * keys — is flattened to `{}` and TWO ROWS WITH DIFFERENT DATES COMPARE EQUAL. Neither caller above passes
 * a `Date` (section payloads are plain JSON by rule 6 of lib/sections/schema.ts), but a helper in this file
 * will eventually be handed a Prisma row, and silent equality is the worst answer this function could give.
 * As a `replacer` it is `JSON.stringify` in every respect except key order.
 *
 * ⚠ CODE-UNIT ORDER, NEVER `localeCompare`. Code units are the same on every machine; `localeCompare` reads
 * the runtime's default locale, which would make the OUTPUT of this function environment-dependent.
 * Comparisons inside one process would survive that, but the day somebody stores one of these strings or
 * compares two machines' output it would be a bug with no visible cause.
 *
 * ⚠ "EVERY KEY SORTED" IS NOT LITERALLY WHAT AN INTEGER-LIKE KEY GETS, and the difference is JavaScript's
 * rather than this function's. `{ "10": 1, "9": 2 }` serialises as `{"9":2,"10":1}` — ascending NUMERIC
 * order — however this comparator ranks the two, because array-index keys are enumerated first and in
 * numeric order by the language itself and `Object.fromEntries` cannot escape that. Measured, not assumed.
 * It is still perfectly DETERMINISTIC, which is the only property the callers need; it simply is not this
 * comparator's order, so nobody should read the output as proof of what the comparator did.
 *
 * It is a comparison key and nothing else: the string is not stable across schema changes (a new field with
 * a default changes it) and must never be persisted as a fingerprint.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const sorted = Object.entries(entry as Record<string, unknown>).sort(
      // `Number(a > b) - Number(a < b)` rather than a ternary chain: the same code-unit ordering,
      // and it cannot be misread as sorting by anything other than the key.
      ([a], [b]) => Number(a > b) - Number(a < b)
    );
    return Object.fromEntries(sorted);
  });
}

/** Deterministic non-cryptographic hash, for stable pseudo-random layout choices (never for secrets). */
export function stableHash(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
