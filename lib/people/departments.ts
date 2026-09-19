/**
 * Departments and units, deduplicated by MEANING rather than by string.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE PROBLEM THIS EXISTS FOR. `Person.department` is free text an editor types (prisma/schema.prisma),
 * and thirty people typing the name of one Centre produced four spellings of it:
 *
 *   "Centre of Excellence for the Unified AI-Enabled Craft Ecosystem Platform"
 *   "Centre of Excellence for an Unified AI-Enabled Craft Ecosystem Platform at IIT Kharagpur"
 *   "Centre of Excellence for Unified AI-Enabled Craft Ecosystem Platform"
 *   "Centre of Excellence for Unified AI-Enabled Craft Ecosystem Platform at IIT Kharagpur, supported
 *    by the Office of the Development Commissioner (Handicrafts), Ministry of Textiles, Government of
 *    India"
 *
 * Every one of those is the same office. A "Department" filter built by putting the column through a
 * `Set` offers all four, so a reader who picks one is shown a quarter of the people who work there and
 * has no way to tell that the other three exist — which is the failure contract §1.6 is about, arriving
 * through the data rather than through a `take`.
 *
 * WHAT THIS MODULE DOES AND DOES NOT DO. It GROUPS spellings that denote one real unit and ELECTS one
 * of them — always one of the supplied strings, character for character. It never concatenates two
 * entries, never invents a house style, never "tidies" what an editor wrote. The elected value is the
 * most DESCRIPTIVE entry in its group, never the shortest and never the most popular: the four
 * spellings above elect the long one that names the institute and the ministry, even though the short
 * one is what thirteen of the twenty people carry.
 *
 * IT IS ALSO DELIBERATELY CONSERVATIVE ABOUT MERGING. Two units with similar names are two units:
 * "Computer Science" is not "Computer Science and Engineering", "Department of Physics" is not
 * "Department of Applied Physics", and "Archives" is not "Digital Archives". A false merge hides a
 * whole unit from the directory and is invisible in review — so every merge rule below is a CLOSED
 * list, and anything a rule does not explicitly recognise stays separate.
 *
 * WHERE IT RUNS. Everywhere: the public directory filters in the browser (app/(site)/people/
 * PeopleDirectory.tsx), the studio's editor builds its suggestion list on the server (app/studio/
 * people/[id]/page.tsx), and the one-off merge script runs it under `tsx` in a plain Node process
 * (scripts/merge-departments.ts). So this file has ZERO IMPORTS, for the reason lib/utils.ts gives at
 * length about itself: a helper shared by three kinds of caller must not drag a bundler, React or
 * `server-only` into any of them.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * The words that name a KIND of unit rather than the unit itself.
 *
 * They matter twice. A leading one is optional — "Humanities and Social Science" and "Department of
 * Humanities and Social Sciences" are the same department written by two people — so the comparison
 * below is made against the name with its leading kind-word removed.
 *
 * But two DIFFERENT kind-words are not interchangeable: a "Department of Design" and a "School of
 * Design" are two entries an institute can genuinely hold at once, so they are only allowed to merge
 * when one of them omits the kind-word entirely. That is the whole of the prefix rule.
 */
const UNIT_KINDS: ReadonlySet<string> = stemmedSet([
  "department",
  "centre",
  "school",
  "faculty",
  "division",
  "institute",
  "laboratory",
  "lab",
  "unit",
  "office",
  "group",
  "cell",
  "directorate",
  "programme",
  "college",
  "academy",
  "chair"
]);

/**
 * Spellings folded to one form before anything else looks at them.
 *
 * Only entries whose two sides are genuinely the same word: an abbreviation and what it abbreviates, or
 * two national spellings of one word. Nothing here may map one unit's name onto another's.
 *
 * ⚠ THE VALUE MAY BE SEVERAL WORDS ("iitkgp" → "iit kharagpur"), which is why the caller splits it
 * again. Without that, "IITKGP" and "IIT Kharagpur" tokenise to different lengths and a suffix that
 * should match stops matching.
 */
const SYNONYMS: ReadonlyMap<string, string> = new Map([
  ["dept", "department"],
  ["deptt", "department"],
  ["depts", "department"],
  ["center", "centre"],
  ["ctr", "centre"],
  ["univ", "university"],
  ["inst", "institute"],
  ["govt", "government"],
  ["iitkgp", "iit kharagpur"],
  ["kgp", "kharagpur"],
  ["engg", "engineering"],
  ["sci", "science"],
  ["tech", "technology"],
  ["admin", "administration"],
  // Both are kind-words below, and two DIFFERENT kind-words never merge — so without this line a
  // "Lab of Conservation Science" and a "Laboratory of Conservation Science" could not be the same
  // unit under any rule, which is not a judgement anybody would make reading them.
  ["lab", "laboratory"],
  ["labs", "laboratory"]
]);

/**
 * Dropped from the comparison entirely.
 *
 * Articles only, and that is the point of the example this module was written for: "for the Unified
 * AI-Enabled Craft Ecosystem Platform", "for an Unified …" and "for Unified …" are one name typed by
 * three people, and the article is the whole of the difference.
 *
 * ⚠ "of", "for", "and" AND THE PREPOSITIONS ARE NOT HERE, DELIBERATELY. "and" is load-bearing — it is
 * what keeps "Computer Science" apart from "Computer Science and Engineering" — and the prepositions
 * are what mark a trailing clause as an ADDRESS rather than as more of the name (see QUALIFIER_HEADS).
 * A stop-word list that swallowed them would merge units this module exists to keep apart.
 */
const ARTICLES: ReadonlySet<string> = new Set(["the", "a", "an"]);

/**
 * The words a trailing QUALIFIER may begin with.
 *
 * A qualifier is the part of an entry that says where a unit is or who funds it rather than what it is
 * called: "… at IIT Kharagpur", "… , supported by the Office of the Development Commissioner
 * (Handicrafts), Ministry of Textiles, Government of India". Two entries that agree word for word up to
 * a qualifier are the same unit described at two levels of detail.
 *
 * ⚠ THIS LIST IS THE SAFETY PROPERTY OF THE WHOLE MODULE, AND IT IS CLOSED ON PURPOSE. The merge rule
 * is "identical, then a recognised qualifier" — never "identical, then anything". With an open rule
 * "School of Design" would swallow "School of Design and Media", "Department of Physics" would swallow
 * "Department of Physics Education", and the directory would quietly lose a unit. Anything not named
 * here — above all "and", "or", "&" — ends the match and the two entries stay separate.
 */
const QUALIFIER_HEADS: ReadonlySet<string> = stemmedSet([
  // Prepositions that introduce a place or a host.
  //
  // ⚠ "in" AND "on" ARE ABSENT, AND THEY WERE BOTH HERE FOR A DRAFT. They do introduce an address —
  // "Design Cell in Kharagpur" — but they introduce a SUBJECT far more often, and the two are
  // indistinguishable from the words alone: "Research Group" and "Research Group in Machine Learning"
  // are two groups, as are "Working Group" and "Working Group on Handloom". Losing the rare address
  // spelling costs one unmerged pair that a reader can still see; admitting the subject spelling
  // silently deletes a unit. "at" carries the address sense almost exclusively, which is why it stays.
  "at",
  "under",
  // Participles that introduce a sponsor.
  "supported",
  "sponsored",
  "funded",
  "hosted",
  "affiliated",
  "established",
  "administered",
  // Institutions and offices, for the entries that drop the preposition and simply append the address.
  "iit",
  "iisc",
  "nit",
  "iiit",
  "university",
  "institute",
  "ministry",
  "government",
  "office",
  "campus"
]);

/**
 * A word list in the form the tokeniser will actually produce.
 *
 * ⚠ WITHOUT THIS, "campus" WAS AN ENTRY THAT COULD NEVER MATCH. These sets are consulted with TOKENS,
 * and a token has already been through `stem` — which takes the "s" off any word of four letters or
 * more, so the tokeniser produces "campu" and the set held "campus". A dead entry in a closed list is
 * the worst kind of dead code: the list is the safety property of the module, and an entry that reads
 * as covered and is not is a merge nobody will notice failing to happen.
 */
function stemmedSet(words: readonly string[]): ReadonlySet<string> {
  return new Set(words.map(stem));
}

/**
 * Singular and plural folded to one form: one trailing "s" off a word of four letters or more.
 *
 * The length floor keeps "as" and "is" intact and the double-s guard keeps "Business" from becoming
 * "Busines". It is applied to both sides of every comparison AND to the word lists above, so a word it
 * folds oddly still folds identically wherever it appears.
 */
function stem(word: string): string {
  return word.length >= 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

/** One entry as this module sees it: what was typed, and what it is compared as. */
interface Entry {
  /** Exactly what was supplied, trimmed. This — never a rebuilt string — is what may be elected. */
  raw: string;
  /**
   * `raw` with its invisible characters removed and runs of whitespace collapsed. Used for length and
   * tidiness comparisons only, NEVER displayed — what is displayed is always `raw`.
   */
  tidy: string;
  /** The comparison tokens. See `tokenise`. */
  tokens: string[];
  /** The tokens with a leading unit-kind word removed, and which word it was. */
  core: string[];
  /** The leading unit-kind word, or null when the entry does not start with one. */
  kind: string | null;
  /** How many of the supplied values had this exact spelling. */
  count: number;
}

/**
 * Does this text contain a letter written in something other than the Latin alphabet?
 *
 * ⚠ THE WHOLE NORMALISATION BELOW IS LATIN-ONLY, AND SILENTLY MANGLES ANYTHING ELSE. `\p{Diacritic}`
 * matches the Devanagari vowel signs, so "मानविकी एवं सामाजिक विज्ञान विभाग" — Humanities and Social
 * Sciences, written the way half of this institute writes it — decomposes and then loses its matras,
 * leaving a string of bare consonants. Two different Hindi unit names shed down to the same consonants
 * and would be reported as one department.
 *
 * The same trap is already recorded on the other side of the repo: app/(site)/a-z/page.tsx explains
 * that diacritic stripping does not fold every LATIN letter either (Ø, Ł and Đ decompose into
 * nothing). Both are the same lesson — a fold is a claim about a script, not about text in general.
 *
 * So a value with a non-Latin letter in it takes the minimal path: case-folded and whitespace-collapsed
 * only. Two such values still compare equal when they are written identically, which is the honest
 * answer, and they never merge with anything on the strength of a transformation that does not apply to
 * them.
 */
function hasNonLatinLetter(value: string): boolean {
  const visible = withoutInvisibles(value);
  return (
    /\p{Letter}/u.test(visible) &&
    /[^\p{Script=Latin}\p{Mark}\p{Number}\p{Punctuation}\p{Symbol}\s]/u.test(visible)
  );
}

/**
 * Drop the characters that are not there.
 *
 * ⚠ A SOFT HYPHEN OR A ZERO-WIDTH SPACE USED TO DECIDE WHICH ALPHABET A DEPARTMENT WAS WRITTEN IN.
 * They are `\p{Format}`, which is neither a letter nor punctuation nor a mark, so the test above saw a
 * character it could not account for and sent a perfectly ordinary English name down the non-Latin
 * path — where it can never merge with the identical name somebody else typed without the invisible
 * character. They arrive constantly and invisibly: a soft hyphen from a word processor's hyphenation,
 * a zero-width space from a copy out of a PDF, a left-to-right mark from a bilingual document.
 *
 * Removed rather than accommodated, and removed EVERYWHERE rather than only from the alphabet test —
 * which is the second half of the same bug. A soft hyphen inside a word ("Human­ities") survives
 * folding as a character that is not a letter, so the tokeniser splits the word in two at it and the
 * value cannot match the same word typed cleanly. Stripping them in `fold` and on the non-Latin path
 * means no comparison anywhere ever sees one.
 */
function withoutInvisibles(value: string): string {
  return value.replace(/[\p{Format}­]/gu, "");
}

/**
 * Case, accents and punctuation removed; one string of comparable words.
 *
 * NFD FIRST, then strip the combining marks — the same order, and for the same reason, as `slugify` in
 * lib/utils.ts and `fold` in PeopleDirectory: "é" is a single codepoint that a character class removes
 * whole, so a diacritic-stripping pass written the other way round deletes the letter with the accent.
 */
function fold(value: string): string {
  return (
    withoutInvisibles(value)
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      // Typographic quotes and dashes come from a paste out of a document and must compare equal to the
      // ASCII ones somebody else typed.
      .replace(/[‘’‛]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[‐-―−]/g, "-")
      .toLowerCase()
      // Spaced out rather than deleted: "Humanities & Social Sciences" must tokenise exactly as
      // "Humanities and Social Sciences" does, including the "and" that guards against a false merge.
      .replace(/&/g, " and ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Remove a parenthetical that is nothing but an acronym OF THE WORDS BESIDE IT.
 *
 * "Department of Humanities and Social Sciences (HSS)" and "Department of Humanities and Social
 * Sciences" are one department: the acronym restates the words in front of it rather than
 * distinguishing two units.
 *
 * ⚠ BEING IN CAPITALS IS NOT ENOUGH, AND THE VERSION THAT THOUGHT IT WAS MERGED TWO REAL DEPARTMENTS.
 * "Department of Physics (UG)" and "Department of Physics (PG)" are both a capitalised parenthetical
 * on an identical base, so a rule that dropped every capitalised bracket reported the undergraduate
 * and postgraduate schools as one department and took one of them off the filter entirely. The
 * distinguishing parenthetical and the restating one look identical from the brackets alone; what
 * separates them is whether the letters are the INITIALS of the words outside.
 *
 * So the acronym must spell out of those initials, taken both with and without the joining words —
 * "Humanities and Social Sciences" gives "hss" and "hass", and both spellings of the acronym are in
 * use. "UG" spells nothing in "Department of Physics" and stays, which is the safe direction: a
 * parenthetical that is kept can only ever hold two units apart, never merge them.
 *
 * ⚠ DECIDED ON THE ORIGINAL CASING, BEFORE FOLDING. "(Handicrafts)" and "(Applied)" are words rather
 * than acronyms and never qualify — "Office of the Development Commissioner (Handicrafts)" is the name
 * of one office. Folding first would destroy the only signal that separates a shout from a word.
 */
function withoutAcronyms(value: string): string {
  return value.replace(/\(([^)]*)\)/g, (whole: string, inner: string, offset: number) => {
    const letters = inner.replace(/[^A-Za-z]/g, "");
    // Capitals only, and at least two of them: a single letter is never an acronym of anything, and a
    // mixed-case bracket is a word.
    if (letters.length < 2 || inner.trim() !== inner.trim().toUpperCase()) return whole;

    const outside = `${value.slice(0, offset)} ${value.slice(offset + whole.length)}`;
    return initialsOf(outside).some((initials) => initials.includes(letters.toLowerCase()))
      ? " "
      : whole;
  });
}

/** Joining words that an acronym may or may not count. See `initialsOf`. */
const ACRONYM_SKIPS: ReadonlySet<string> = new Set(["of", "for", "and", "the", "a", "an", "in", "at"]);

/**
 * The initials of a phrase, twice: counting the joining words and ignoring them.
 *
 * Both are in real use — a Department of Humanities and Social Sciences is written "HSS" here and
 * "HASS" elsewhere — and an acronym only has to match one of them.
 */
function initialsOf(phrase: string): string[] {
  const words = fold(phrase)
    .split(/[^a-z0-9']+/u)
    .filter((word) => word.length > 0);

  return [
    words.map((word) => word[0]).join(""),
    words
      .filter((word) => !ACRONYM_SKIPS.has(word))
      .map((word) => word[0])
      .join("")
  ];
}

/**
 * The comparison tokens for one entry.
 *
 * Singulars and plurals fold together through `stem` — "Humanities and Social Science" is what
 * somebody types for "… Social Sciences". The same function shapes the word lists above, so an entry
 * in one of them is written the way a token will actually arrive.
 */
function tokenise(raw: string): string[] {
  // The minimal path for anything that is not written in the Latin alphabet. See `hasNonLatinLetter`.
  if (hasNonLatinLetter(raw)) {
    return withoutInvisibles(raw)
      .normalize("NFC")
      .toLowerCase()
      .split(/\s+/u)
      .filter((word) => word.length > 0);
  }

  const tokens = latinTokens(withoutAcronyms(raw));

  /**
   * ⚠ AN ENTRY THAT IS NOTHING BUT AN ACRONYM KEEPS IT. "(HSS)" on its own strips to the empty string,
   * and an entry with no words has nothing to compare — so it was dropped from the facet entirely, and
   * the person carrying it became unreachable by the department filter. The acronym is that entry's
   * whole name, so the strip is undone rather than the row discarded.
   */
  return tokens.length > 0 ? tokens : latinTokens(raw);
}

/** The comparison words of a Latin-alphabet value. See `tokenise`, which decides when this applies. */
function latinTokens(value: string): string[] {
  const words = fold(value).split(/[^a-z0-9']+/u);
  const tokens: string[] = [];

  for (const word of words) {
    if (!word) continue;
    const expanded = SYNONYMS.get(word) ?? word;
    for (const part of expanded.split(" ")) {
      if (!part || ARTICLES.has(part)) continue;
      tokens.push(stem(part));
    }
  }

  return tokens;
}

/**
 * The tokens with a leading unit-kind word (and the "of"/"for" that follows it) removed.
 *
 * "department of humanities and social science" → "humanities and social science", so the entry that
 * omits the prefix compares equal to the one that carries it. An entry that is NOTHING but its kind
 * word — a lone "Directorate" — keeps it: stripping it would leave nothing to compare and every such
 * entry would collapse into one.
 */
function coreOf(tokens: string[]): { kind: string | null; core: string[] } {
  const head = tokens[0];
  if (!head || tokens.length < 2 || !UNIT_KINDS.has(head)) return { kind: null, core: tokens };

  let rest = tokens.slice(1);
  if (rest[0] === "of" || rest[0] === "for") rest = rest.slice(1);
  if (rest.length === 0) return { kind: null, core: tokens };

  return { kind: head, core: rest };
}

/** Is `short` the opening run of `long`, and strictly shorter? */
function opens(long: string[], short: string[]): boolean {
  if (short.length === 0 || short.length >= long.length) return false;
  for (let index = 0; index < short.length; index += 1) {
    if (long[index] !== short[index]) return false;
  }
  return true;
}

/**
 * Do two entries name the same unit?
 *
 * Exactly two ways to say yes, and nothing else counts:
 *
 *   1. The cores are word-for-word identical.
 *   2. One core opens the other and the remainder begins with a recognised qualifier word — that is
 *      the same name with an address or a sponsor appended (QUALIFIER_HEADS carries the argument).
 *
 * Both are subject to the kind-word rule: a "Department of X" and a "School of X" never merge, while
 * either merges with a bare "X".
 */
function sameUnit(a: Entry, b: Entry): boolean {
  /**
   * ⚠ AN ENTRY WITH NO COMPARISON WORDS MATCHES NOTHING, INCLUDING ANOTHER ONE. "—", "()" and "###"
   * all tokenise to nothing, and the identical-cores test below would call two empty lists equal — so
   * every meaningless entry in the column would be reported as one department, named after whichever
   * of them sorted first. They are kept apart instead: each stands alone in the list, exactly as an
   * editor typed it, and the people carrying it are still reachable.
   */
  if (a.core.length === 0 || b.core.length === 0) return false;

  if (a.kind !== null && b.kind !== null && a.kind !== b.kind) return false;

  const x = a.core;
  const y = b.core;
  if (x.length === y.length) return x.every((token, index) => token === y[index]);

  const [long, short] = x.length > y.length ? [x, y] : [y, x];
  if (!opens(long, short)) return false;

  const head = long[short.length];
  return head !== undefined && QUALIFIER_HEADS.has(head);
}

/**
 * Which of two spellings is the more descriptive?
 *
 * A TOTAL order, so the elected value never depends on the order rows came back from Postgres in or on
 * the insertion order of a `Map` — a canonical value that moved between two renders would look exactly
 * like an editor changing the data.
 *
 *   1. More comparison words wins. This is "most complete and descriptive" made mechanical: the entry
 *      that names the institute and the ministry carries more of them than the entry that does not.
 *   2. Then the longer text, which is what separates "… Social Sciences (HSS)" from "… Social
 *      Sciences" — the acronym adds no comparison word but is more informative to a reader.
 *   3. Then the tidier text — no doubled spaces, no invisible characters — so a stray keystroke or a
 *      soft hyphen a word processor left behind never becomes the house spelling of a department. This
 *      is why `tidy` strips both: a value that differs from its own tidy form loses here, and the clean
 *      spelling of the same name wins without any rule having to name the character that spoiled it.
 *   4. Then the one that is not SHOUTED. Two spellings that differ only in case are one spelling, and
 *      the all-capitals one is a caps-lock accident rather than the more descriptive entry; it is also
 *      what a screen reader spells out letter by letter.
 *   5. Then the one that keeps its accents. "Atelier de Céramique" and "Atelier de Ceramique" compare
 *      equal here, and the first is the unit's name while the second is what somebody's keyboard could
 *      manage. Counted as diacritics rather than as "non-ASCII characters", deliberately: the wider
 *      test would elect a spelling for carrying a stray non-breaking space.
 *   6. Then the one more people carry, and finally the alphabet. Both exist only to make the answer
 *      deterministic when everything above ties — two spellings separated by nothing but a straight or
 *      curly apostrophe are settled here, arbitrarily but identically on every render.
 *
 * ⚠ POPULARITY IS THE SECOND-TO-LAST TEST, NOT THE FIRST, AND THAT IS THE REQUIREMENT RATHER THAN A
 * PREFERENCE. Thirteen of the twenty people at the Centre carry its SHORTEST spelling; electing by
 * popularity would pick exactly the entry that says least about what the unit is.
 */
function moreDescriptive(a: Entry, b: Entry): number {
  if (a.tokens.length !== b.tokens.length) return b.tokens.length - a.tokens.length;
  if (a.tidy.length !== b.tidy.length) return b.tidy.length - a.tidy.length;

  const aTidy = a.raw === a.tidy ? 0 : 1;
  const bTidy = b.raw === b.tidy ? 0 : 1;
  if (aTidy !== bTidy) return aTidy - bTidy;

  const aShouted = isShouted(a.raw) ? 1 : 0;
  const bShouted = isShouted(b.raw) ? 1 : 0;
  if (aShouted !== bShouted) return aShouted - bShouted;

  const aAccents = diacritics(a.raw);
  const bAccents = diacritics(b.raw);
  if (aAccents !== bAccents) return bAccents - aAccents;

  if (a.count !== b.count) return b.count - a.count;
  return a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0;
}

/** Is this written in capitals throughout? A value with no cased letters at all is not "shouted". */
function isShouted(value: string): boolean {
  return value === value.toUpperCase() && value !== value.toLowerCase();
}

/** How many combining marks the text carries once decomposed — its accents, counted. */
function diacritics(value: string): number {
  return (value.normalize("NFD").match(/\p{Diacritic}/gu) ?? []).length;
}

/** One real unit, and every spelling of it that was supplied. */
export interface DepartmentGroup {
  /**
   * The spelling to show and to compare against — one of the supplied strings, character for
   * character. Never assembled, never edited.
   */
  canonical: string;
  /** Every distinct spelling in the group, most descriptive first. `canonical` is `variants[0]`. */
  variants: string[];
  /** How many of the supplied values fell into this group, counting repeats. */
  count: number;
}

/**
 * Group every spelling supplied into one entry per real unit.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * HOW THE GROUPS ARE FORMED, AND WHY NOT BY TRANSITIVE CLOSURE.
 *
 * Every entry is attached to the MOST DESCRIPTIVE entry it names the same unit as, working down from
 * the most descriptive. The obvious alternative — union anything that matches anything — is wrong here
 * in a way that only shows up with real data: a bare "Centre for Craft Studies" matches both "… at IIT
 * Kharagpur" and "… at IIT Delhi" (each is the same name plus an address), so a transitive union would
 * join the two institutes' centres through it and report one unit where there are two. Attaching to the
 * best match instead leaves those two apart and lands the ambiguous short entry on one of them, which
 * is the cheaper of the two mistakes and the only one that is not silent.
 *
 * The result does not depend on input order: the entries are sorted by a total order (`moreDescriptive`)
 * before anything is attached, so the same set of spellings always produces the same groups whatever
 * sequence they arrive in.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Blank and absent values are dropped rather than grouped — "no department" is not a department.
 */
export function groupDepartments(values: Iterable<string | null | undefined>): DepartmentGroup[] {
  const byRaw = new Map<string, Entry>();

  for (const value of values) {
    const raw = (value ?? "").trim();
    if (raw.length === 0) continue;

    const existing = byRaw.get(raw);
    if (existing) {
      existing.count += 1;
      continue;
    }

    const tokens = tokenise(raw);
    // An entry with no comparison words at all — "—", "()", "123" — cannot be matched against anything
    // and is kept as a group of its own rather than being silently dropped: it is what somebody typed,
    // and a filter offering it still finds the people who carry it.
    const { kind, core } = coreOf(tokens);
    byRaw.set(raw, {
      raw,
      tidy: withoutInvisibles(raw).replace(/\s+/g, " "),
      tokens,
      core,
      kind,
      count: 1
    });
  }

  const entries = [...byRaw.values()].sort(moreDescriptive);
  const groups: { lead: Entry; members: Entry[] }[] = [];

  for (const entry of entries) {
    const host = groups.find((group) => sameUnit(group.lead, entry));
    if (host) host.members.push(entry);
    else groups.push({ lead: entry, members: [entry] });
  }

  return groups.map((group) => ({
    canonical: group.lead.raw,
    variants: group.members.map((member) => member.raw),
    count: group.members.reduce((total, member) => total + member.count, 0)
  }));
}

/**
 * A lookup from any supplied spelling to the value elected for it.
 *
 * ⚠ THE FILTER AND THE OPTION LIST MUST BE BUILT FROM ONE CALL TO THIS, and that is the bug it exists
 * to prevent: an option list of canonical values compared against a raw column with `===` matches only
 * the people who happen to carry the elected spelling, so picking "Department of Humanities and Social
 * Sciences (HSS)" would show one of the three people in it and the other two would have vanished with
 * no way to find them.
 *
 * Keys are the TRIMMED spellings, which is what the column holds — the studio trims on write
 * (app/api/studio/people/route.ts) — and what `groupDepartments` grouped. A caller looking a value up
 * must trim it the same way; `canonicalDepartment` below does.
 */
export function departmentCanonicalMap(
  values: Iterable<string | null | undefined>
): Map<string, string> {
  const map = new Map<string, string>();
  for (const group of groupDepartments(values)) {
    for (const variant of group.variants) map.set(variant, group.canonical);
  }
  return map;
}

/**
 * One value through a map from `departmentCanonicalMap`.
 *
 * Absent or blank gives null — "no department" is not a department. A spelling the map has never seen
 * gives ITSELF, not null: it is a department the map was simply not built from, and a caller that
 * treated it as absent would drop that person out of a filter they belong in. The one caller that can
 * meet an unknown spelling is the directory, whose map is built from the same roster it filters, so in
 * practice this arises only if the two are ever built from different reads — which is exactly when
 * returning the person's own spelling is the answer that loses nobody.
 */
export function canonicalDepartment(
  value: string | null | undefined,
  map: ReadonlyMap<string, string>
): string | null {
  const raw = (value ?? "").trim();
  if (raw.length === 0) return null;
  return map.get(raw) ?? raw;
}

/**
 * The elected values alone, ordered the way a reader reads a list of names.
 *
 * `en-GB` with base sensitivity, matching `sortLabels` in PeopleDirectory — the two lists sit in the
 * same row of filters and must not sort by two different rules.
 */
export function canonicalDepartmentLabels(
  values: Iterable<string | null | undefined>
): string[] {
  return groupDepartments(values)
    .map((group) => group.canonical)
    .sort((a, b) => a.localeCompare(b, "en-GB", { sensitivity: "base" }));
}
