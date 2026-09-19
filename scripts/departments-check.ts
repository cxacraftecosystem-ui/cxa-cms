/**
 * The department-deduplication check.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IT PROVES, AND WHY IT IS A SCRIPT RATHER THAN A COMMENT.
 *
 * `lib/people/departments.ts` decides which spellings of a unit's name are the same unit. Both ways of
 * being wrong are silent:
 *
 *   • A MISSED MERGE puts two spellings of one department in the filter, and a reader who picks one is
 *     shown a fraction of the people in it with nothing on screen saying so (contract §1.6).
 *   • A FALSE MERGE takes a real department off the list entirely, and its people are then only
 *     reachable through somebody else's department.
 *
 * Neither shows up in a typecheck, in a lint, or in a screenshot. The rules are a closed list of word
 * forms — articles, acronyms, plurals, qualifier heads — and a single word added to one of those lists
 * can move an entry between the two failures above. So the cases live here, they run in
 * `npm run check`, and they include every spelling this Centre's database actually holds.
 *
 * USAGE
 *   npx tsx scripts/departments-check.ts     # exits non-zero on the first disagreement
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { canonicalDepartment, departmentCanonicalMap, groupDepartments } from "../lib/people/departments";

interface Case {
  /** What the case is checking, in the words a failure should be read in. */
  name: string;
  /** The spellings as they would come out of the column, repeats included. */
  input: (string | null | undefined)[];
  /**
   * The expected groups: the elected value first, then every other spelling that must land with it, in
   * any order. One array per real unit.
   */
  expected: string[][];
}

/** The four spellings of the Centre's own name that are in the production database today. */
const CENTRE_LONG =
  "Centre of Excellence for Unified AI-Enabled Craft Ecosystem Platform at IIT Kharagpur, supported by the Office of the Development Commissioner (Handicrafts), Ministry of Textiles, Government of India";
const CENTRE_KGP = "Centre of Excellence for an Unified AI-Enabled Craft Ecosystem Platform at IIT Kharagpur";
const CENTRE_THE = "Centre of Excellence for the Unified AI-Enabled Craft Ecosystem Platform";
const CENTRE_BARE = "Centre of Excellence for Unified AI-Enabled Craft Ecosystem Platform";

const HSS_ACRONYM = "Department of Humanities and Social Sciences (HSS)";
const HSS_FULL = "Department of Humanities and Social Sciences";
const HSS_BARE = "Humanities and Social Science";

const CASES: Case[] = [
  // ── The production data, exactly as it stands ───────────────────────────────────────────────
  {
    name: "the four spellings of the Centre elect the one naming the institute and the ministry",
    input: [CENTRE_THE, CENTRE_LONG, CENTRE_KGP, CENTRE_BARE],
    expected: [[CENTRE_LONG, CENTRE_THE, CENTRE_KGP, CENTRE_BARE]]
  },
  {
    name: "the most popular spelling does not win — thirteen people carry the shortest one",
    input: [
      ...Array<string>(13).fill(CENTRE_THE),
      ...Array<string>(5).fill(CENTRE_LONG),
      CENTRE_KGP,
      CENTRE_BARE
    ],
    expected: [[CENTRE_LONG, CENTRE_THE, CENTRE_KGP, CENTRE_BARE]]
  },
  {
    name: "the acronym, the full name and the prefix-less spelling are one department",
    input: [HSS_FULL, HSS_ACRONYM, HSS_BARE],
    expected: [[HSS_ACRONYM, HSS_FULL, HSS_BARE]]
  },
  {
    name: "the whole production roster resolves to three units",
    input: [
      ...Array<string>(13).fill(CENTRE_THE),
      ...Array<string>(5).fill(CENTRE_LONG),
      CENTRE_KGP,
      CENTRE_BARE,
      HSS_ACRONYM,
      HSS_FULL,
      HSS_BARE,
      "Computer Science and Engineering",
      "Computer Science and Engineering",
      null,
      null
    ],
    expected: [
      [CENTRE_LONG, CENTRE_THE, CENTRE_KGP, CENTRE_BARE],
      [HSS_ACRONYM, HSS_FULL, HSS_BARE],
      ["Computer Science and Engineering"]
    ]
  },

  // ── Merges that must happen ────────────────────────────────────────────────────────────────
  {
    name: "an abbreviation and what it abbreviates",
    input: ["Dept. of Humanities and Social Sciences", HSS_ACRONYM],
    expected: [[HSS_ACRONYM, "Dept. of Humanities and Social Sciences"]]
  },
  {
    name: "an ampersand and the word it stands for",
    input: ["Department of Humanities & Social Sciences", HSS_FULL],
    expected: [[HSS_FULL, "Department of Humanities & Social Sciences"]]
  },
  {
    name: "an address appended with a preposition",
    input: ["Centre for Craft Studies", "Centre for Craft Studies at IIT Kharagpur"],
    expected: [["Centre for Craft Studies at IIT Kharagpur", "Centre for Craft Studies"]]
  },
  {
    name: "an address appended after a comma, with no preposition",
    input: ["Department of Design", "Department of Design, IIT Kharagpur"],
    expected: [["Department of Design, IIT Kharagpur", "Department of Design"]]
  },
  {
    name: "a sponsor clause",
    input: [
      "Craft Documentation Cell",
      "Craft Documentation Cell supported by the Ministry of Textiles"
    ],
    expected: [
      ["Craft Documentation Cell supported by the Ministry of Textiles", "Craft Documentation Cell"]
    ]
  },
  {
    name: "case alone is not a difference, and the shouted spelling is not elected",
    input: ["DEPARTMENT OF HUMANITIES AND SOCIAL SCIENCES", HSS_FULL],
    expected: [[HSS_FULL, "DEPARTMENT OF HUMANITIES AND SOCIAL SCIENCES"]]
  },
  {
    name: "a doubled space never becomes the house spelling",
    input: ["Department of  Humanities and Social Sciences", HSS_FULL],
    expected: [[HSS_FULL, "Department of  Humanities and Social Sciences"]]
  },
  {
    name: "surrounding whitespace is not a spelling",
    input: ["  Computer Science and Engineering  ", "Computer Science and Engineering"],
    expected: [["Computer Science and Engineering"]]
  },
  {
    name: "a trailing full stop",
    input: ["Computer Science and Engineering.", "Computer Science and Engineering"],
    expected: [["Computer Science and Engineering.", "Computer Science and Engineering"]]
  },
  {
    // The two are one unit; which of them is elected is settled by the last rule in `moreDescriptive`
    // rather than by anything meaningful — what this case fixes is that the answer never moves.
    name: "an en dash and a hyphen are one unit, and the tie is settled the same way every time",
    input: ["AI–Enabled Craft Platform", "AI-Enabled Craft Platform"],
    expected: [["AI-Enabled Craft Platform", "AI–Enabled Craft Platform"]]
  },
  {
    name: "a curly apostrophe and a straight one are one unit, settled the same way every time",
    input: ["Weavers’ Welfare Cell", "Weavers' Welfare Cell"],
    expected: [["Weavers' Welfare Cell", "Weavers’ Welfare Cell"]]
  },
  {
    name: "accents are not a difference, and the spelling that keeps them is elected",
    input: ["Atelier de Ceramique", "Atelier de Céramique"],
    expected: [["Atelier de Céramique", "Atelier de Ceramique"]]
  },
  {
    name: "IITKGP is IIT Kharagpur",
    input: ["Design Cell at IITKGP", "Design Cell", "Design Cell at IIT Kharagpur"],
    expected: [["Design Cell at IIT Kharagpur", "Design Cell at IITKGP", "Design Cell"]]
  },
  {
    name: "singular and plural",
    input: ["Department of Humanities and Social Science", HSS_FULL],
    expected: [[HSS_FULL, "Department of Humanities and Social Science"]]
  },
  {
    name: "a kind word omitted on one side only",
    input: ["Conservation Science", "Laboratory of Conservation Science"],
    expected: [["Laboratory of Conservation Science", "Conservation Science"]]
  },

  // ── Merges that must NOT happen ────────────────────────────────────────────────────────────
  {
    name: "a conjunction is not a qualifier",
    input: ["Computer Science", "Computer Science and Engineering"],
    expected: [["Computer Science and Engineering"], ["Computer Science"]]
  },
  {
    name: "an inserted adjective makes another department",
    input: ["Department of Physics", "Department of Applied Physics"],
    expected: [["Department of Applied Physics"], ["Department of Physics"]]
  },
  {
    name: "a school that grew a second subject",
    input: ["School of Design", "School of Design and Media"],
    expected: [["School of Design and Media"], ["School of Design"]]
  },
  {
    name: "a leading qualifier is part of the name",
    input: ["Archives", "Digital Archives"],
    expected: [["Digital Archives"], ["Archives"]]
  },
  {
    name: "two kinds of unit with one name are two units",
    input: ["Department of Design", "School of Design"],
    expected: [["Department of Design"], ["School of Design"]]
  },
  {
    name: "an unrecognised trailing word ends the match",
    input: ["Craft Ecosystem Platform", "Craft Ecosystem Platform Project"],
    expected: [["Craft Ecosystem Platform Project"], ["Craft Ecosystem Platform"]]
  },
  {
    name: "two institutes' centres of the same name are not joined through the bare spelling",
    input: [
      "Centre for Craft Studies at IIT Kharagpur",
      "Centre for Craft Studies at IIT Delhi",
      "Centre for Craft Studies"
    ],
    expected: [
      ["Centre for Craft Studies at IIT Kharagpur", "Centre for Craft Studies"],
      ["Centre for Craft Studies at IIT Delhi"]
    ]
  },
  {
    name: "a parenthetical that is a word, not an acronym, is a distinction",
    input: ["Department of Physics (Applied)", "Department of Physics"],
    expected: [["Department of Physics (Applied)"], ["Department of Physics"]]
  },
  {
    name: "two units whose acronyms collide stay apart",
    input: ["Department of Human Studies (HS)", "Department of Historical Studies (HS)"],
    expected: [["Department of Historical Studies (HS)"], ["Department of Human Studies (HS)"]]
  },
  {
    name: "a lone kind word keeps it and does not swallow every other unit",
    input: ["Directorate", "Directorate of Outreach", "Office"],
    expected: [["Directorate of Outreach"], ["Directorate"], ["Office"]]
  },
  {
    name: "the seeded units of the demonstration corpus stay apart",
    input: [
      "Materials and Technique",
      "Conservation Science",
      "Livelihoods and Markets",
      "Transmission and Pedagogy",
      "Digital Archives",
      "Archives",
      "Field Documentation",
      "Administration",
      "Directorate"
    ],
    expected: [
      ["Materials and Technique"],
      ["Conservation Science"],
      ["Livelihoods and Markets"],
      ["Transmission and Pedagogy"],
      ["Digital Archives"],
      ["Archives"],
      ["Field Documentation"],
      ["Administration"],
      ["Directorate"]
    ]
  },

  {
    // A subject is not an address. "in" and "on" were both qualifier heads for one draft of the module.
    name: "a subject appended after a preposition is another unit, not an address",
    input: ["Research Group", "Research Group in Machine Learning", "Working Group on Handloom"],
    expected: [
      ["Research Group in Machine Learning"],
      ["Working Group on Handloom"],
      ["Research Group"]
    ]
  },

  {
    /*
     * The false merge that a capitals-only acronym rule shipped: both brackets are capitals on an
     * identical base, so dropping every capitalised parenthetical reported the undergraduate and
     * postgraduate schools as one department and took one of them off the filter entirely.
     */
    name: "a capitalised parenthetical that is not an acronym of the words beside it holds two units apart",
    input: ["Department of Physics (UG)", "Department of Physics (PG)"],
    expected: [["Department of Physics (PG)"], ["Department of Physics (UG)"]]
  },
  {
    name: "an acronym spelled from the joining words too",
    input: ["Department of Humanities and Social Sciences (HASS)", HSS_FULL],
    expected: [["Department of Humanities and Social Sciences (HASS)", HSS_FULL]]
  },
  {
    name: "a single capital letter in brackets is not an acronym",
    input: ["Department of Design (A)", "Department of Design (B)"],
    expected: [["Department of Design (A)"], ["Department of Design (B)"]]
  },
  {
    name: "an abbreviation of a kind word is the same kind word",
    input: ["Lab of Conservation Science", "Laboratory of Conservation Science"],
    expected: [["Laboratory of Conservation Science", "Lab of Conservation Science"]]
  },
  {
    // "campus" was written into QUALIFIER_HEADS in a form the tokeniser never produces — it stems to
    // "campu" — so the entry read as covered and could never match.
    name: "every qualifier head is written in the form the tokeniser produces",
    input: ["Craft Design Cell", "Craft Design Cell Campus West"],
    expected: [["Craft Design Cell Campus West", "Craft Design Cell"]]
  },
  {
    /*
     * A soft hyphen is invisible and is `\p{Format}` — neither letter, mark nor punctuation — so the
     * alphabet test saw a character it could not account for and sent an ordinary English name down the
     * non-Latin path, where it could never merge with the identical name typed without it.
     */
    name: "an invisible soft hyphen or zero-width space is not a second department",
    input: [
      "Department of Human­ities and Social Sciences",
      HSS_FULL,
      "Computer​ Science and Engineering",
      "Computer Science and Engineering"
    ],
    expected: [
      [HSS_FULL, "Department of Human­ities and Social Sciences"],
      ["Computer Science and Engineering", "Computer​ Science and Engineering"]
    ]
  },

  // ── Scripts other than Latin ───────────────────────────────────────────────────────────────
  {
    /*
     * The regression that the non-Latin guard exists for: `\p{Diacritic}` matches Devanagari matras, so
     * the Latin fold sheds both names down to bare consonants and reports one department where there
     * are two.
     */
    name: "two Hindi unit names are not shed down to the same consonants",
    input: ["मानविकी एवं सामाजिक विज्ञान विभाग", "यांत्रिक अभियांत्रिकी विभाग"],
    expected: [["मानविकी एवं सामाजिक विज्ञान विभाग"], ["यांत्रिक अभियांत्रिकी विभाग"]]
  },
  {
    name: "one Hindi unit name written twice is one department",
    input: ["मानविकी एवं सामाजिक विज्ञान विभाग", "मानविकी एवं  सामाजिक विज्ञान विभाग"],
    expected: [["मानविकी एवं सामाजिक विज्ञान विभाग", "मानविकी एवं  सामाजिक विज्ञान विभाग"]]
  },

  // ── Absences ───────────────────────────────────────────────────────────────────────────────
  {
    name: "nothing at all is not a department",
    input: [null, undefined, "", "   ", "\t\n"],
    expected: []
  },
  {
    name: "a value with no words of its own is kept rather than dropped",
    input: ["—", "Computer Science and Engineering"],
    expected: [["Computer Science and Engineering"], ["—"]]
  },
  {
    // Two meaningless entries are two entries. Comparing their empty word lists as equal would report
    // them as one department named after whichever sorted first.
    name: "two values with no words of their own do not become one department",
    input: ["—", "()", "###"],
    expected: [["—"], ["()"], ["###"]]
  },
  {
    // Stripping the acronym empties the key, and an entry with no key was dropped from the facet
    // altogether — taking the person who carries it out of the filter with no way to find them.
    name: "an entry that is nothing but an acronym survives and groups on the acronym",
    input: ["(HSS)", "HSS"],
    expected: [["(HSS)", "HSS"]]
  }
];

let failures = 0;

/** A group is identified by its elected value; membership order within it is not part of the claim. */
function describe(groups: string[][]): string {
  return groups
    .map((group) => `    ${JSON.stringify(group[0])}${group.length > 1 ? ` + ${group.length - 1} more` : ""}`)
    .join("\n");
}

for (const testCase of CASES) {
  const actual = groupDepartments(testCase.input).map((group) => group.variants);

  const sameShape =
    actual.length === testCase.expected.length &&
    testCase.expected.every((expectedGroup) => {
      const match = actual.find((group) => group[0] === expectedGroup[0]);
      if (!match) return false;
      if (match.length !== expectedGroup.length) return false;
      return expectedGroup.every((variant) => match.includes(variant));
    });

  if (!sameShape) {
    failures += 1;
    console.error(`✖ ${testCase.name}`);
    console.error("  expected:");
    console.error(describe(testCase.expected));
    console.error("  actual:");
    console.error(describe(actual));
  }
}

/**
 * The map is the half the UI actually uses, so it is checked on its own terms rather than inferred from
 * the groups: every spelling supplied must resolve, and every one in a group must resolve to the SAME
 * value. A filter built on a map that answers null for a spelling silently drops that person.
 */
{
  const spellings = [CENTRE_THE, CENTRE_LONG, CENTRE_KGP, CENTRE_BARE, HSS_FULL, HSS_ACRONYM, HSS_BARE];
  const map = departmentCanonicalMap(spellings);

  for (const spelling of spellings) {
    const resolved = canonicalDepartment(spelling, map);
    if (resolved === null) {
      failures += 1;
      console.error(`✖ the canonical map dropped ${JSON.stringify(spelling)}`);
    }
  }

  // The same value with the whitespace a paste leaves behind must still resolve.
  if (canonicalDepartment(`  ${HSS_BARE}  `, map) !== HSS_ACRONYM) {
    failures += 1;
    console.error("✖ a padded spelling did not resolve to its elected value");
  }

  if (canonicalDepartment(null, map) !== null || canonicalDepartment("   ", map) !== null) {
    failures += 1;
    console.error("✖ an absent department did not resolve to null");
  }

  // An unknown spelling resolves to ITSELF rather than to null: a person whose department was typed
  // after the map was built must still be filterable, not invisible.
  if (canonicalDepartment("Department of Botany", map) !== "Department of Botany") {
    failures += 1;
    console.error("✖ an unknown spelling did not resolve to itself");
  }
}

/** The order rows arrive in must not change the answer. Same set, reversed, same groups. */
{
  const spellings = [CENTRE_THE, CENTRE_LONG, CENTRE_KGP, CENTRE_BARE, HSS_FULL, HSS_ACRONYM, HSS_BARE];
  const forward = groupDepartments(spellings).map((group) => group.canonical).sort();
  const backward = groupDepartments([...spellings].reverse()).map((group) => group.canonical).sort();

  if (JSON.stringify(forward) !== JSON.stringify(backward)) {
    failures += 1;
    console.error("✖ the elected values depend on the order the spellings arrived in");
    console.error(`  forward:  ${JSON.stringify(forward)}`);
    console.error(`  backward: ${JSON.stringify(backward)}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} department-deduplication ${failures === 1 ? "case" : "cases"} failed.`);
  process.exit(1);
}

console.log(`✓ departments: ${CASES.length} grouping cases, the canonical map and order-independence all hold.`);
