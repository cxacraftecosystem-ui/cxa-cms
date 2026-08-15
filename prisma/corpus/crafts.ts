/**
 * THE CRAFT ARCHIVE — the regions, the stylistic lineages, and the forty-two traditions themselves.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IS IN HERE. Everything the craft explorer draws: a three-deep region tree from India down to
 * the town, six stylistic lineages, and forty-two craft records. Twenty-six of them carry one of the
 * bundled photographs — one craft per photograph, so no picture in `public/craft/` goes unused and
 * no card falls back to a placeholder. The other sixteen have no photograph, deliberately: an
 * archive whose length is exactly the length of its picture library is an archive that was written
 * around its pictures, and the sixteen were chosen to widen the range the pictures happen to cover
 * — grass, coir, hide, granite, sheet copper, castor oil; the north-east, Kerala, the Nilgiris.
 *
 * ⚠ WHERE THE FACTS COME FROM, AND WHERE THEY STOP. Every practice named below is real, is
 * somebody's living trade, and belongs to people who did not ask to be written about. Region,
 * material, technique and period are stated only where they are actually known. Where a detail was
 * uncertain it has been LEFT OUT rather than guessed at — there is no sentence here of the form
 * "traditionally, the such-and-such community…" unless the community is already in the name of the
 * craft. A short entry is a small failure; a confident wrong sentence about somebody's trade,
 * published by an institution, is a large one and it propagates.
 *
 * ⚠ NOTHING IN THIS FILE IS ABOUT THE CENTRE. No practitioner is named, no workshop is named, no
 * family is named. Where a craft is worked by a handful of households — patola, rogan — that fact is
 * stated and the households are not.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * JUDGEMENT CALLS, in the order they will bite somebody who edits this file.
 *
 * • `originYear` IS A CENTURY MARKER, NOT A DATE, and `originNote` always carries the real
 *   precision. Where a tradition is documented "from the fifteenth century" the year is written as
 *   1400 and the note says what is actually known; where the documented period is a late century the
 *   marker is the half-century. Two entries are genuine dates and say so in the note. Everything
 *   else has no year at all, because the timeline losing an entry costs less than the timeline
 *   asserting that somebody's craft began in a year nobody knows. An editor who "tidies" 1400 into
 *   1398 has invented a fact.
 *
 * • COORDINATES ARE A DELIBERATE MIXTURE OF TWO PRECISIONS. Town and district entries carry the
 *   place itself. State entries carry an approximate centroid chosen to fall unambiguously inside
 *   the state, so that a craft recorded only at state level ("kolam, Tamil Nadu") still gets a pin
 *   somewhere honest rather than none at all. A centroid is not a claim that the craft happens
 *   there. Anything not confidently known is omitted: a pin in the wrong state is worse than no pin,
 *   and a reader cannot tell a guessed pin from a surveyed one.
 *
 * • `latitude`/`longitude` ARE REPEATED ON THE CRAFT where the craft has a single identifiable
 *   centre. The region already carries them, but the explorer may plot either, and a craft that
 *   pins itself is a craft that survives being re-parented to a coarser region later.
 *
 * • LOCAL NAMES ARE SPARSE ON PURPOSE. Nine crafts carry one, in scripts and spellings that are
 *   settled. The rest do not, because a misspelt name in somebody's own script, announced to a
 *   screen reader as that language, is a worse insult than an English-only label. Do not fill the
 *   gaps in by transliterating backwards from the English.
 *
 * • MATERIAL AND TECHNIQUE SPELLINGS ARE A CONTROLLED VOCABULARY, and this is not fussiness. The
 *   explorer builds its filter facets by tallying these strings, so "natural indigo" and "Natural
 *   Indigo" become two filters that each find half the crafts that use it. Reuse the exact string
 *   already present — "natural indigo", "handloom weaving", "mordant dyeing", "lost-wax casting" —
 *   and only add a new one when the thing itself is new.
 *
 * • SCHOOLS ARE LINEAGES, NOT INSTITUTIONS, and only six crafts have one. Mithila, Nathdwara,
 *   Kalighat, Srikalahasti, Machilipatnam and Bagru name a way of working that a practitioner would
 *   recognise as distinct from its neighbour. Where no such lineage genuinely applies the field is
 *   empty rather than filled with the name of the town, which the region already holds.
 */

import type { SeedCraft, SeedRegion, SeedSchool } from "./types";

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// REGIONS
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Country → state → district → town. The tree is walked by the seeder in depth order, so the array
 * order below is for human legibility only.
 *
 * State coordinates are approximate centroids (see the note at the head of the file). District
 * entries carry their headquarters town, which is what a reader looking at a pin expects: "Kachchh"
 * plotted at Bhuj is right in the way that "Kachchh" plotted at the geometric middle of the Rann
 * would not be.
 */
export const REGIONS: SeedRegion[] = [
  { slug: "india", name: "India", level: "country", latitude: 22.0, longitude: 79.0 },

  // ── States ──────────────────────────────────────────────────────────────────────────────────
  { slug: "gujarat", name: "Gujarat", level: "state", parent: "india", latitude: 22.5, longitude: 71.5 },
  { slug: "rajasthan", name: "Rajasthan", level: "state", parent: "india", latitude: 26.5, longitude: 73.8 },
  { slug: "punjab", name: "Punjab", level: "state", parent: "india", latitude: 30.9, longitude: 75.5 },
  {
    slug: "jammu-and-kashmir",
    name: "Jammu and Kashmir",
    level: "state",
    parent: "india",
    latitude: 33.9,
    longitude: 75.1
  },
  {
    slug: "uttar-pradesh",
    name: "Uttar Pradesh",
    level: "state",
    parent: "india",
    latitude: 26.9,
    longitude: 80.5
  },
  { slug: "bihar", name: "Bihar", level: "state", parent: "india", latitude: 25.6, longitude: 85.5 },
  { slug: "west-bengal", name: "West Bengal", level: "state", parent: "india", latitude: 23.0, longitude: 87.6 },
  { slug: "odisha", name: "Odisha", level: "state", parent: "india", latitude: 20.5, longitude: 84.8 },
  {
    slug: "chhattisgarh",
    name: "Chhattisgarh",
    level: "state",
    parent: "india",
    latitude: 21.3,
    longitude: 82.0
  },
  { slug: "maharashtra", name: "Maharashtra", level: "state", parent: "india", latitude: 19.5, longitude: 75.5 },
  { slug: "karnataka", name: "Karnataka", level: "state", parent: "india", latitude: 14.8, longitude: 75.7 },
  { slug: "telangana", name: "Telangana", level: "state", parent: "india", latitude: 17.9, longitude: 79.2 },
  {
    slug: "andhra-pradesh",
    name: "Andhra Pradesh",
    level: "state",
    parent: "india",
    latitude: 15.8,
    longitude: 79.8
  },
  { slug: "tamil-nadu", name: "Tamil Nadu", level: "state", parent: "india", latitude: 11.0, longitude: 78.5 },
  { slug: "kerala", name: "Kerala", level: "state", parent: "india", latitude: 10.3, longitude: 76.5 },
  { slug: "assam", name: "Assam", level: "state", parent: "india", latitude: 26.3, longitude: 92.8 },
  { slug: "nagaland", name: "Nagaland", level: "state", parent: "india", latitude: 26.0, longitude: 94.5 },

  // ── Districts ───────────────────────────────────────────────────────────────────────────────
  { slug: "kachchh", name: "Kachchh", level: "district", parent: "gujarat", latitude: 23.2419, longitude: 69.6669 },
  { slug: "amritsar", name: "Amritsar", level: "district", parent: "punjab", latitude: 31.634, longitude: 74.8723 },
  {
    slug: "madhubani-district",
    name: "Madhubani",
    level: "district",
    parent: "bihar",
    latitude: 26.3477,
    longitude: 86.0716
  },
  { slug: "bankura", name: "Bankura", level: "district", parent: "west-bengal", latitude: 23.2324, longitude: 87.0716 },
  { slug: "puri", name: "Puri", level: "district", parent: "odisha", latitude: 19.8135, longitude: 85.8312 },
  { slug: "bastar", name: "Bastar", level: "district", parent: "chhattisgarh", latitude: 19.0785, longitude: 82.0147 },
  {
    slug: "anantapur",
    name: "Anantapur",
    level: "district",
    parent: "andhra-pradesh",
    latitude: 14.6819,
    longitude: 77.6006
  },
  { slug: "nilgiris", name: "The Nilgiris", level: "district", parent: "tamil-nadu", latitude: 11.4102, longitude: 76.695 },
  {
    slug: "tirunelveli",
    name: "Tirunelveli",
    level: "district",
    parent: "tamil-nadu",
    latitude: 8.7139,
    longitude: 77.7567
  },
  {
    slug: "pathanamthitta",
    name: "Pathanamthitta",
    level: "district",
    parent: "kerala",
    latitude: 9.2648,
    longitude: 76.787
  },
  { slug: "kamrup", name: "Kamrup", level: "district", parent: "assam", latitude: 26.1445, longitude: 91.7362 },

  // ── Towns ───────────────────────────────────────────────────────────────────────────────────
  // Nirona and Ajrakhpur are villages in Kachchh. Their exact coordinates are not confidently known
  // here, so they are recorded as places without pins of their own; the crafts sited there carry
  // Bhuj's coordinates, which is the nearest point this file is sure of.
  { slug: "nirona", name: "Nirona", level: "town", parent: "kachchh" },
  { slug: "ajrakhpur", name: "Ajrakhpur", level: "town", parent: "kachchh" },
  { slug: "patan", name: "Patan", level: "town", parent: "gujarat", latitude: 23.8493, longitude: 72.1266 },
  { slug: "ahmedabad", name: "Ahmedabad", level: "town", parent: "gujarat", latitude: 23.0225, longitude: 72.5714 },
  { slug: "jaipur", name: "Jaipur", level: "town", parent: "rajasthan", latitude: 26.9124, longitude: 75.7873 },
  { slug: "bagru", name: "Bagru", level: "town", parent: "rajasthan", latitude: 26.8133, longitude: 75.545 },
  { slug: "nathdwara", name: "Nathdwara", level: "town", parent: "rajasthan", latitude: 24.9333, longitude: 73.8167 },
  {
    slug: "jandiala-guru",
    name: "Jandiala Guru",
    level: "town",
    parent: "amritsar",
    latitude: 31.5646,
    longitude: 75.0281
  },
  { slug: "srinagar", name: "Srinagar", level: "town", parent: "jammu-and-kashmir", latitude: 34.0837, longitude: 74.7973 },
  { slug: "lucknow", name: "Lucknow", level: "town", parent: "uttar-pradesh", latitude: 26.8467, longitude: 80.9462 },
  { slug: "moradabad", name: "Moradabad", level: "town", parent: "uttar-pradesh", latitude: 28.8386, longitude: 78.7733 },
  { slug: "khurja", name: "Khurja", level: "town", parent: "uttar-pradesh", latitude: 28.2537, longitude: 77.8556 },
  { slug: "mathura", name: "Mathura", level: "town", parent: "uttar-pradesh", latitude: 27.4924, longitude: 77.6737 },
  {
    slug: "madhubani-town",
    name: "Madhubani",
    level: "town",
    parent: "madhubani-district",
    latitude: 26.3477,
    longitude: 86.0716
  },
  { slug: "kolkata", name: "Kolkata", level: "town", parent: "west-bengal", latitude: 22.5726, longitude: 88.3639 },
  { slug: "bishnupur", name: "Bishnupur", level: "town", parent: "bankura", latitude: 23.0667, longitude: 87.3167 },
  { slug: "raghurajpur", name: "Raghurajpur", level: "town", parent: "puri", latitude: 19.9066, longitude: 85.8378 },
  { slug: "palghar", name: "Palghar", level: "town", parent: "maharashtra", latitude: 19.6967, longitude: 72.7699 },
  { slug: "bidar", name: "Bidar", level: "town", parent: "karnataka", latitude: 17.9104, longitude: 77.5199 },
  { slug: "channapatna", name: "Channapatna", level: "town", parent: "karnataka", latitude: 12.6514, longitude: 77.2065 },
  { slug: "hyderabad", name: "Hyderabad", level: "town", parent: "telangana", latitude: 17.385, longitude: 78.4867 },
  {
    slug: "srikalahasti",
    name: "Srikalahasti",
    level: "town",
    parent: "andhra-pradesh",
    latitude: 13.7497,
    longitude: 79.6983
  },
  {
    slug: "machilipatnam",
    name: "Machilipatnam",
    level: "town",
    parent: "andhra-pradesh",
    latitude: 16.1875,
    longitude: 81.1389
  },
  {
    slug: "kanchipuram",
    name: "Kanchipuram",
    level: "town",
    parent: "tamil-nadu",
    latitude: 12.8342,
    longitude: 79.7036
  },
  { slug: "thanjavur", name: "Thanjavur", level: "town", parent: "tamil-nadu", latitude: 10.787, longitude: 79.1378 },
  {
    slug: "mamallapuram",
    name: "Mamallapuram",
    level: "town",
    parent: "tamil-nadu",
    latitude: 12.6208,
    longitude: 80.1945
  },
  { slug: "alappuzha", name: "Alappuzha", level: "town", parent: "kerala", latitude: 9.4981, longitude: 76.3388 },
  { slug: "aranmula", name: "Aranmula", level: "town", parent: "pathanamthitta", latitude: 9.3167, longitude: 76.6833 },
  { slug: "sualkuchi", name: "Sualkuchi", level: "town", parent: "kamrup", latitude: 26.1667, longitude: 91.5667 }
];

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SCHOOLS
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Six lineages, each attached to at least one craft. A school with no crafts is a dead filter in the
 * explorer, so none is declared speculatively.
 *
 * Srikalahasti and Machilipatnam are listed as separate schools rather than as one "kalamkari"
 * because the two do genuinely different work: one draws with a pen, the other prints with blocks,
 * and the dye chemistry they share is the only thing that makes them one word in English.
 */
export const SCHOOLS: SeedSchool[] = [
  {
    slug: "mithila",
    name: "Mithila",
    description:
      "The painting tradition of the Mithila region of north Bihar, worked on walls and floors for domestic ritual long before it was worked on paper for sale. Its two best-known manners are kachni, built from fine hatched line, and bharni, built from areas of filled colour."
  },
  {
    slug: "nathdwara",
    name: "Nathdwara",
    description:
      "The painting workshops that grew around the shrine at Nathdwara in Rajasthan, working to a devotional calendar: cloth hangings, miniatures and shrine furnishings changed with the festival and the season."
  },
  {
    slug: "kalighat",
    name: "Kalighat",
    description:
      "The nineteenth-century painters who worked near the Kalighat temple in Calcutta, selling quickly made watercolours to pilgrims. The manner is a few sweeping brushstrokes, shaded volume and a flat ground, and its subjects ran from deities to sharp comedy about city life."
  },
  {
    slug: "srikalahasti",
    name: "Srikalahasti",
    description:
      "The pen-drawn branch of kalamkari, in which the whole design is drawn freehand on the cloth with a bamboo kalam before the mordants are dyed up. Its subjects are largely narrative and temple-related."
  },
  {
    slug: "machilipatnam",
    name: "Machilipatnam",
    description:
      "The block-printed branch of kalamkari, worked around Machilipatnam and Pedana on the Andhra coast. It shares the mordant chemistry of the pen-drawn work but builds its patterns from carved blocks, and its repertoire carries the Persian taste of the export trade it grew up in."
  },
  {
    slug: "bagru",
    name: "Bagru",
    description:
      "The printing lineage of Bagru in Rajasthan, distinguished by dabu — a mud resist stopped out by hand before dyeing — and by grounds dyed after printing rather than printed on white."
  }
];

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// CRAFTS
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Forty-two records, grouped below by what the maker actually handles: dyed and woven cloth, then
 * embroidery, then painting and drawing, then metal, then earth and stone, then wood, then the
 * fibres, then hide and paper. The explorer sorts them itself; the grouping is for whoever has to
 * read this file next.
 */
export const CRAFTS: SeedCraft[] = [
  // ── Dyed and woven cloth ────────────────────────────────────────────────────────────────────
  {
    slug: "bandhani",
    name: "Bandhani tie-resist dyeing",
    localName: "બાંધણી",
    localNameLang: "gu",
    summary:
      "A resist dye technique in which thousands of individual points of cloth are pinched up and bound with thread before dyeing, so that each binding leaves an undyed dot. It is worked across Kachchh and Saurashtra in Gujarat and around Jaipur, Sikar and Jodhpur in Rajasthan.",
    bodyParagraphs: [
      "The cloth is first folded, often into four or eight layers, and the pattern is transferred by pressing it against a block charged with a fugitive colour. The tier then works over the printed dots, lifting each one into a tiny peak with the fingernail and whipping a thread around it. Practitioners who tie for a living grow the nail of one finger long for exactly this, and a single fine sari may carry tens of thousands of points.",
      "Dyeing runs from light to dark. The bound cloth goes into the palest colour, is lifted and dried, and further ties are added or selectively opened before the next bath, so that the same cloth can carry three or four colours without any of them being painted on. The knots are never untied one by one: the finished cloth is opened by pulling it on the bias, and the sound of several thousand knots giving way at once is how a tier knows the work has survived.",
      "The dots are read, not merely admired. Their arrangement distinguishes a wedding cloth from an everyday one, and particular grounds and borders belong to particular occasions and communities. Because the tying is done by hand in the round, no two cloths repeat exactly, and the small irregularity of the dot grid is the ordinary evidence that a cloth was tied rather than printed.",
      "The technique's vulnerability is in its economics rather than its materials. Tying is slow, paid by the piece, and almost entirely invisible in the finished object to a buyer who has not been told what to look for, which makes printed imitation of the dot pattern a direct competitor for the same shelf."
    ],
    region: "kachchh",
    originNote: "Long established across Gujarat and Rajasthan; the technique itself is older than any of its documented centres.",
    materials: ["cotton", "mulberry silk", "natural dyes"],
    techniques: ["resist dyeing", "tie-resist dyeing"],
    latitude: 23.2419,
    longitude: 69.6669,
    photo: "bandhani"
  },
  {
    slug: "patola",
    name: "Patan patola double ikat",
    localName: "પટોળા",
    localNameLang: "gu",
    summary:
      "A silk cloth in which both the warp and the weft are resist-dyed before weaving, so that the pattern exists in the yarn and only assembles itself on the loom. It is woven at Patan in northern Gujarat by a very small number of households.",
    bodyParagraphs: [
      "In ordinary ikat one set of threads carries the pattern. In double ikat both do, which means the design must be worked out thread by thread in both directions and then dyed into two separate bundles of yarn that have never met. Sections of warp and weft are bound off with thread, dyed, unbound, rebound elsewhere and dyed again, once for every colour in the cloth.",
      "The loom is set at a slight tilt and worked by two weavers. Because the weft carries half the image, each pick has to be nudged into register with the warp before it is beaten in — done with a pointed steel rod, thread by thread, for the length of the cloth. A sari can take many months, and an error is not correctable: the yarn was dyed for one position and no other.",
      "The pattern is symmetrical to the point of being reversible, and the classic repertoires — elephants and parrots, dancing figures, geometric grids — are traditional sets rather than free invention. Gujarati double ikat travelled in the Indian Ocean trade for centuries, and cloths of this kind were valued in Indonesia as heirloom textiles well beyond the point where they were being made for local use.",
      "Very few families still weave it. The knowledge that is scarce is not the weaving but the planning: the ability to hold a finished cloth in mind and resolve it into two independent dye plans before a thread is tied."
    ],
    region: "patan",
    originYear: 1500,
    originNote: "Gujarati double ikat is documented in the Indian Ocean textile trade from the sixteenth century; the practice at Patan is older than its earliest surviving cloths.",
    materials: ["mulberry silk", "natural dyes"],
    techniques: ["double ikat", "resist dyeing", "handloom weaving"],
    latitude: 23.8493,
    longitude: 72.1266,
    photo: "patola",
    isFeatured: true
  },
  {
    slug: "ajrakh",
    name: "Ajrakh resist printing",
    summary:
      "A resist-printed cotton cloth built up over many separate stages of printing, dyeing and washing, using natural indigo and madder over a myrobalan-prepared ground. It is worked in Kachchh, principally at Dhamadka and at Ajrakhpur, and on the other side of the border in Sindh.",
    bodyParagraphs: [
      "The cloth is prepared before any pattern touches it: washed, steeped, and treated with myrobalan, which leaves a pale fawn ground and fixes the mordants that follow. Printing then alternates with dyeing. Resist pastes are printed where the colour is to be excluded, mordants where it is to be taken, and the cloth goes into the indigo vat or the madder bath and comes back out to be washed and printed again. A full ajrakh passes through many such rounds, and most of the labour is in washing and drying between them.",
      "A true ajrakh is printed on both faces, in register, so the cloth has no wrong side. Getting the two impressions to align across a shrinking, repeatedly wetted length of cotton is the part of the work that takes years to learn, and it is why the blocks are cut with registration marks at their corners.",
      "The designs are geometric, built from a small vocabulary of stars, trefoils and interlaced grids repeating within ruled borders. The characteristic reading of an ajrakh is the way the same motif appears in reserve, in red and in blue on one cloth — the record of which round each area was stopped out in.",
      "Ajrakhpur exists because of a disaster: printers displaced by the 2001 Kachchh earthquake founded the settlement, in part to be near cleaner water, since the washing that ajrakh depends on is impossible where the groundwater is bad."
    ],
    region: "ajrakhpur",
    materials: ["cotton", "natural indigo", "madder", "myrobalan", "natural dyes"],
    techniques: ["block printing", "resist dyeing", "mordant dyeing", "natural dyeing"],
    latitude: 23.2419,
    longitude: 69.6669
  },
  {
    slug: "block-print",
    name: "Bagru and Sanganer hand block printing",
    summary:
      "Cotton printed by hand with carved wooden blocks, one colour and one block at a time, in the printing towns south and west of Jaipur. Bagru is known for dabu, a mud resist applied before dyeing; Sanganer for fine floral printing directly onto a white ground.",
    bodyParagraphs: [
      "The blocks are cut from seasoned hard wood, usually by specialist carvers rather than by the printers themselves. A design of three colours needs at least three blocks — an outline block and one filler for each colour — and each is cut so that its corners carry a registration point. The printer works down a long table, dipping the block into a tray of colour resting on a bed of cloth, positioning it by eye and striking it once with the heel of the hand.",
      "Dabu is what distinguishes Bagru work. A paste of clay, gum and chaff is printed over the areas that are to stay pale, dusted with sawdust so it does not smear, and left to dry. The cloth is then dyed as a whole, and the mud comes away in the wash carrying the dye with it. Because the ground is dyed rather than printed, a dabu cloth can hold an even indigo across its whole width — something no amount of block printing will achieve.",
      "Colour comes from mordants as much as from dye. An iron liquor prints black or grey, alum prints as red once the cloth has been through the madder bath, and the same block will therefore produce different colours depending only on what it was dipped in. This is why old printed cottons can carry several colours from a single dyeing.",
      "Repeated washing in large volumes of water is intrinsic to the process, which ties the trade to particular rivers and wells and makes it acutely sensitive to what else is being discharged upstream."
    ],
    region: "bagru",
    school: "bagru",
    materials: ["cotton", "natural indigo", "madder", "natural dyes", "teak"],
    techniques: ["block printing", "mud-resist printing", "mordant dyeing", "natural dyeing"],
    latitude: 26.8133,
    longitude: 75.545,
    photo: "block-print"
  },
  {
    slug: "handloom-kanchipuram",
    name: "Kanchipuram silk weaving",
    summary:
      "Heavy mulberry-silk saris woven on handlooms at Kanchipuram in Tamil Nadu, with borders and end-piece in a contrasting colour joined to the body by an interlocked weave rather than stitched on.",
    bodyParagraphs: [
      "The distinctive construction is the contrast border. Body and border are woven in different colours, sometimes from different weights of silk, and are locked together at the selvedge as the weaving proceeds — the korvai technique — so the join is a woven interlacement rather than a seam. It is slow, needs a second person at the loom for the border, and it is the reason a Kanchipuram border does not come away with wear.",
      "Zari is the other defining material: a fine silver wire wrapped around a silk core and then gilded, woven in as a supplementary weft to make the border and end-piece patterning. The weight of a sari is largely the weight of its zari, and the quantity used is one of the things a buyer traditionally checks.",
      "The loom is a pit loom or a raised frame loom with a jacquard or a drawloom-derived mechanism for the figured areas. Patterns are geometric and architectural — temple-tower triangles along the border, checks, and repeating motifs in the field — and are set up as a lifting plan before weaving starts.",
      "The town's weaving is an inherited household trade organised around cooperatives and master weavers, and its economics turn on the price of silk and of zari, both of which are bought in and both of which move independently of what a woven sari can be sold for."
    ],
    region: "kanchipuram",
    materials: ["mulberry silk", "zari"],
    techniques: ["handloom weaving", "supplementary weft weaving"],
    latitude: 12.8342,
    longitude: 79.7036,
    photo: "handloom"
  },
  {
    slug: "pashmina",
    name: "Kashmir pashmina weaving",
    summary:
      "Shawls hand-spun and hand-woven at Srinagar from the fine undercoat of the Changthangi goat, which is reared on the high plateau of Ladakh. The yarn is too fine and too weakly twisted to survive a power loom, so every stage from the fibre to the cloth is done by hand.",
    bodyParagraphs: [
      "The raw material is not shorn but combed out in spring, when the goats shed the down they grew through a winter at altitude. The fleece arrives mixed with coarse guard hair, and the first labour — done by hand, a pinch at a time — is separating the two. What remains is a very short, very fine fibre that will not tolerate mechanical carding.",
      "Spinning is done on a wheel, traditionally by women working at home, and produces a yarn fine enough that a shawl's warp may run to several thousand ends. Weaving is on a handloom, slowly, in a humid room, because the yarn breaks if it dries out. A plain shawl is weeks of work; a repair to a broken end costs a weaver more time than the length he would have woven in it.",
      "Two decorative traditions sit on top of the weaving. Kani shawls are woven with a large number of small wooden bobbins, each carrying one colour, worked into the shed by hand according to a coded pattern read aloud from a written notation — a tapestry technique in which the design is built as the cloth grows. Sozni is fine needle embroidery worked on the finished cloth, so dense in the best work that the ground almost disappears.",
      "Because the fibre commands a high price and the name is not self-evidently verifiable, adulteration and mislabelling are the trade's chronic problem, and identifying genuinely hand-spun, hand-woven cloth is a laboratory question as much as a connoisseur's one."
    ],
    region: "srinagar",
    originNote: "Shawl weaving at Srinagar is documented from the medieval period, and Kashmir shawls were an established long-distance trade by the seventeenth century.",
    materials: ["pashmina wool", "silk floss"],
    techniques: ["hand spinning", "handloom weaving", "twill tapestry weaving", "hand embroidery"],
    latitude: 34.0837,
    longitude: 74.7973,
    photo: "pashmina"
  },
  {
    slug: "muga-silk-weaving",
    name: "Muga and eri silk weaving",
    summary:
      "Weaving in Assam's own silks: muga, produced by a wild silkmoth found only in the region and naturally golden, and eri, spun from cocoons the moth has already left. Sualkuchi, on the north bank of the Brahmaputra, is the best-known weaving town.",
    bodyParagraphs: [
      "Muga comes from a semi-domesticated moth reared outdoors on host trees rather than in sheds, which ties production to a particular climate and a particular set of trees and makes the crop vulnerable to weather in a way mulberry silk is not. The fibre is a deep natural gold that takes no dyeing to achieve, and it is one of the few silks that is said to improve with washing, gaining lustre rather than losing it.",
      "Eri is reeled differently. The cocoon is open-ended, so the moth emerges and the fibre is spun from the staple rather than unwound in a continuous filament — which gives a warmer, woollier cloth and means no insect is killed in the making. It is the everyday cloth of the two, used for wrappers and shawls.",
      "Weaving in Assam has historically been domestic and overwhelmingly done by women, with a loom in the house as an ordinary fitting rather than a workshop trade. Sualkuchi is the exception that grew into a specialist town, weaving mekhela-chador and other garment lengths for sale.",
      "Patterning is largely in supplementary weft, worked in bands across the ends and in scattered motifs across the field, and the vocabulary of those motifs is regional and specific enough that a cloth can be placed by them."
    ],
    region: "sualkuchi",
    materials: ["muga silk", "eri silk", "mulberry silk"],
    techniques: ["handloom weaving", "supplementary weft weaving", "hand spinning"],
    latitude: 26.1667,
    longitude: 91.5667
  },
  {
    slug: "loin-loom-weaving",
    name: "Loin-loom weaving in Nagaland",
    summary:
      "Cloth woven on a backstrap loom, where the warp is stretched between a fixed point and a strap passing behind the weaver, who tensions the whole loom with her own body. Narrow woven panels are then sewn together edge to edge to make a shawl or a wrap.",
    bodyParagraphs: [
      "The loom has no frame. Its parts — a breast beam, a warp beam lashed to a post or a wall, a sword, a shed rod and a set of heddles on a stick — are portable and are set up wherever there is room to sit. Tension is controlled by the weaver leaning back or forward, which is what limits the width: a panel is only as wide as the weaver can comfortably beat across, so most cloths are made of three or more panels joined lengthwise.",
      "That constraint shapes the design. Because a shawl is assembled from panels, its bands run the length of the cloth and its patterning is planned so that the sewn joins fall between bands rather than through a motif. Patterns are built in stripes and in supplementary weft picked up by hand, without a mechanical shedding device.",
      "Cloth in the Naga hills is not neutral. Particular combinations of band, colour and motif belong to particular communities, and in several of them the right to wear a given shawl has been earned rather than bought. This portal records the technique and does not attempt to catalogue those entitlements, which are properly described by the communities that hold them.",
      "The loom is still in domestic use, and it is also the base of a considerable contemporary production of stoles and yardage for sale outside the region — a shift that changes what is woven far more than it changes how."
    ],
    region: "nagaland",
    materials: ["cotton", "wool"],
    techniques: ["backstrap weaving", "supplementary weft weaving"]
  },
  {
    slug: "baluchari",
    name: "Baluchari figured silk",
    summary:
      "A silk sari whose end-piece carries narrative scenes — court figures, riders, episodes from the epics — woven in supplementary weft rather than printed or embroidered. Originally woven at Baluchar in Murshidabad, it is now made at Bishnupur in Bankura district.",
    bodyParagraphs: [
      "What makes a Baluchari is the pallu. Instead of a geometric border repeat, the end-piece is composed as a set of framed panels containing figures, and the figures are made by lifting particular warp ends for particular picks — so the picture exists as an interlacement and is visible in reverse on the underside.",
      "In the earlier work the lifting sequence was controlled by a drawloom operated with a second person seated above the loom, calling and pulling the pattern. Contemporary weaving uses a jacquard, which shifts the labour from the loom to the punching of the pattern cards: designing a new pallu means designing several thousand card perforations before a thread moves.",
      "The scenes are period documents in themselves. Nineteenth-century pallus carry the dress, the carriages and occasionally the steamers of the world the weavers were living in, which is one of the reasons the type is studied as much as it is worn.",
      "The move to Bishnupur was a revival rather than a continuity: the Murshidabad trade declined, and the weaving was re-established in the twentieth century in a town that already had a silk industry."
    ],
    region: "bishnupur",
    originYear: 1750,
    originNote: "Woven at Baluchar in Murshidabad in the eighteenth and nineteenth centuries; re-established at Bishnupur in the twentieth.",
    materials: ["mulberry silk"],
    techniques: ["handloom weaving", "supplementary weft weaving"],
    latitude: 23.0667,
    longitude: 87.3167
  },

  // ── Embroidery and stitched cloth ───────────────────────────────────────────────────────────
  {
    slug: "chikankari",
    name: "Chikankari",
    localName: "चिकनकारी",
    localNameLang: "hi",
    summary:
      "White cotton or silk thread embroidered on fine, light cloth at Lucknow, using a repertoire of some dozens of named stitches. The pattern is block-printed onto the cloth in a washable colour first, embroidered over, and then washed out.",
    bodyParagraphs: [
      "The sequence surprises people who assume the embroiderer draws. A block printer prints the design in a fugitive blue; the cloth then passes to embroiderers, often several of them, each doing the stitches they specialise in; finally the finished piece is washed, and the printed guide disappears. If the washing is skimped the blue stays, which is one of the ordinary ways to judge a piece.",
      "The stitches divide into three families and it is worth knowing which is which. Flat stitches lie on the surface. Embossed stitches — the small grain-like knots and raised dots — stand above it and give the cloth its texture in raking light. And bakhiya, the herringbone worked on the reverse of the cloth, shows through fine muslin as a soft shadow, which is why it is called shadow work: the darker area is not thread at all, it is thread seen through the ground.",
      "Jaali is the technique that distinguishes serious work. A net-like open area is made not by cutting threads but by pushing the warp and weft apart with the needle and holding them there with stitching, so the cloth is never weakened. Done well it looks like inserted lace and is in fact the same continuous cloth.",
      "Chikankari is a divided trade — printer, embroiderer, washer, finisher — and the embroiderers, largely women working at home and paid by the piece, hold the skill on which the value of the finished garment depends while sitting furthest from the point where that value is realised."
    ],
    region: "lucknow",
    originYear: 1700,
    originNote: "Documented at Lucknow from the eighteenth century.",
    materials: ["cotton", "muslin", "mulberry silk"],
    techniques: ["hand embroidery", "shadow work", "block printing"],
    latitude: 26.8467,
    longitude: 80.9462,
    photo: "chikankari",
    isFeatured: true
  },
  {
    slug: "phulkari",
    name: "Phulkari",
    localName: "ਫੁਲਕਾਰੀ",
    localNameLang: "pa",
    summary:
      "Embroidery worked in untwisted floss silk on coarse hand-spun cotton, in a darning stitch counted against the threads of the ground and worked from the reverse side of the cloth. It belongs to Punjab, on both sides of the present border.",
    bodyParagraphs: [
      "The ground is khaddar — hand-spun, hand-woven cotton, loosely enough woven that its threads can be counted by touch. The embroiderer works from the back, taking a stitch over a fixed number of ground threads, so the pattern appears on the front as long floats of floss silk. Because the floss is untwisted it lies flat and catches light along its length, and the direction in which a block of stitches runs changes its apparent colour. Whole patterns are built out of that one effect, using a single thread colour.",
      "The counting is the discipline. There is no drawn design; the geometry is held in the head and executed against the weave, which means a mistake in the count propagates and the shape closes wrong several inches later.",
      "A bagh is the dense form, in which the stitching covers the ground so completely that no cotton shows and the cloth becomes, in effect, a silk surface with a cotton backing. The sparser forms leave the ground visible and place motifs across it. Both were domestic productions for family occasions rather than commodities, which is why so much old work has no maker's name and a very clear occasion.",
      "The floss silk was historically brought in from outside Punjab, so the craft has always depended on a trade in materials as well as on a technique."
    ],
    region: "punjab",
    materials: ["khadi", "silk floss"],
    techniques: ["hand embroidery", "darning stitch", "counted-thread embroidery"],
    photo: "phulkari"
  },
  {
    slug: "kantha",
    name: "Kantha",
    localName: "কাঁথা",
    localNameLang: "bn",
    summary:
      "Quilting worked in plain running stitch through several layers of worn cotton cloth, traditionally using thread drawn from the borders of the same saris being quilted. It is domestic work from across Bengal, on both sides of the border.",
    bodyParagraphs: [
      "The material is what is already in the house. Three, five or seven soft old saris or dhotis are laid together and stitched through with a fine running stitch, and the thread for the stitching is unpicked from the coloured borders of the cloths themselves. Nothing is bought, which is why kantha is one of the few textile traditions whose economics never depended on a market.",
      "The stitch does two things at once. It holds the layers, and by its own tension it puckers them, so a finished kantha has a rippled surface that a flat quilting stitch would not give. Running the stitch lines in different directions across different areas is how the maker controls where the cloth ripples and where it lies flat.",
      "Nakshi kantha is the figured kind. Motifs are worked in the same running stitch as fields of parallel lines that follow the contour of the shape, so a lotus, an elephant or a scene of daily life reads as an area of differently directed stitching rather than as an outline filled in. The centre is usually a lotus, with the corners and the field filled around it.",
      "Because the pieces were made for use — as wraps, covers and coverings for books and mirrors — most are worn out rather than kept, and the surviving corpus is skewed towards the ones somebody decided were too good to use."
    ],
    region: "west-bengal",
    materials: ["cotton", "silk floss"],
    techniques: ["hand embroidery", "running stitch", "quilting"],
    photo: "kantha"
  },
  {
    slug: "zardozi",
    name: "Zardozi metal-thread embroidery",
    summary:
      "Embroidery in metal thread, coiled wire and sequins, worked with a hook from beneath a cloth stretched drum-tight on a wooden frame. It is done at Hyderabad, Lucknow, Bhopal, Delhi and elsewhere, largely for garments and furnishing.",
    bodyParagraphs: [
      "The frame — the adda — is the whole apparatus. A length of cloth is laced to it under even tension and several embroiderers sit along it at once. They work with an ari, a fine hook held above the cloth that catches the thread passed up from a hand underneath, producing a chain stitch far faster than a needle would. Everything about the process assumes the cloth cannot move.",
      "The materials are more varied than the word gold suggests: flat metal strip, wire wrapped around a silk core, tightly coiled springs of wire cut into short lengths and threaded on like beads, small sequins, and spangles. A raised motif is built by couching padding down first and working the metal over it, so the surface has real relief and catches light from a distance.",
      "Historically the wire was gold or silver over a silk core, and old pieces were sometimes burnt to recover the metal — which is one reason why so little early work survives relative to how much was made. Most present-day work uses metallised polyester, which is lighter, does not tarnish, and is a different material with different behaviour rather than a straightforward substitute.",
      "The trade is organised in workshops around a master who sets out and prices the design, and the labour is measured in embroiderer-days on a frame. A heavily worked bridal panel can represent several weeks of continuous work by a row of people."
    ],
    region: "hyderabad",
    materials: ["gold and silver thread", "zari", "sequins", "mulberry silk", "cotton"],
    techniques: ["hand embroidery", "metal-thread embroidery"],
    latitude: 17.385,
    longitude: 78.4867,
    photo: "zardozi"
  },
  {
    slug: "toda-embroidery",
    name: "Toda embroidery",
    summary:
      "Counted-thread embroidery in red and black wool on a white cotton ground, worked by the Toda community of the Nilgiri hills. The stitching is worked so that the cloth is usable from either side, the two faces carrying the pattern in reverse.",
    bodyParagraphs: [
      "The ground cloth is a plain white cotton with woven bands of red and black, and the embroidery is worked between and across those bands, counted against the weave without any drawn guide. The needle picks up and passes over set numbers of threads, and the pattern grows as a geometry of interlocking blocks and stepped shapes.",
      "The work is deliberately reversible. Rather than finishing the back, the embroiderer manages the floats so that the reverse carries the same design with the colours exchanged, and the finished cloth — the shawl worn wrapped over the shoulder — is worn either way about.",
      "Motifs are named and belong to a settled repertoire drawn from the community's surroundings and ritual life. Because the embroidery is counted rather than drawn, scale is governed by the weave of the ground: a coarser cloth produces the same design larger.",
      "The Nilgiris are a small area and the community is small, which makes the craft's continuity a question of a few hundred practitioners rather than of a regional industry. Sale outside the community has become part of how it is sustained, and the shawl remains the form on which the technique is judged."
    ],
    region: "nilgiris",
    materials: ["cotton", "wool"],
    techniques: ["hand embroidery", "counted-thread embroidery", "darning stitch"],
    latitude: 11.4102,
    longitude: 76.695
  },

  // ── Painting and drawing ────────────────────────────────────────────────────────────────────
  {
    slug: "madhubani",
    name: "Madhubani painting",
    summary:
      "The painting tradition of the Mithila region of north Bihar, worked for generations on the mud walls and floors of houses for weddings and festivals, and on paper since the 1960s. Its manners include kachni, built from fine hatched line, and bharni, built from filled areas of colour.",
    bodyParagraphs: [
      "The wall painting came first and had a fixed place in domestic ritual: particular rooms, particular occasions, particular subjects, renewed when the occasion recurred and otherwise allowed to weather. The surface was the wall itself, prepared with mud and dung and left to dry to an even, absorbent ground.",
      "Drawing is done with a nib cut from bamboo or a small stick wrapped with a pad of cotton, which holds enough colour for a continuous line and gives the characteristic even, unmodulated stroke. There is no underdrawing and no correction: the outline is laid down first and the filling follows it.",
      "Kachni fills the enclosed shapes with dense parallel hatching, so the picture is built almost entirely from line and the colour is incidental. Bharni fills them with flat colour inside a heavy outline. Later manners include work built from rows of small repeated marks derived from tattoo patterning. The subjects are drawn from a settled repertoire — deities, the marriage chamber, fish, birds, the sun and moon, flowering trees — arranged to fill the surface completely, with the ground worked up rather than left blank.",
      "The move onto paper in the 1960s, encouraged as a source of income during a period of drought and hardship, took a ritual practice performed by women in their own houses and made it a portable, signed, saleable object. That is the single largest change in the tradition's history, and it is recent enough that its consequences — for who paints, for what is painted, and for whose name is on it — are still working themselves out."
    ],
    region: "madhubani-town",
    school: "mithila",
    originNote: "A domestic wall and floor painting practice of long standing; work on paper for sale dates from the 1960s.",
    materials: ["handmade paper", "mineral pigments", "lampblack", "cow dung"],
    techniques: ["hand painting", "line drawing", "mural painting"],
    latitude: 26.3477,
    longitude: 86.0716,
    photo: "madhubani",
    isFeatured: true
  },
  {
    slug: "pattachitra",
    name: "Pattachitra",
    localName: "ପଟ୍ଟଚିତ୍ର",
    localNameLang: "or",
    summary:
      "Painting on a prepared cloth panel, made by laminating layers of cotton with tamarind-seed paste and chalk and burnishing the surface to a hard, slightly glossy ground. It is worked in Odisha, above all in the village of Raghurajpur near Puri, and its subject matter is dominated by Jagannath and the Puri temple.",
    bodyParagraphs: [
      "The support is made before anything is painted. Two or more thin cotton cloths are stuck together with a paste of tamarind seed, coated with a mixture of chalk and the same paste, dried, and then rubbed smooth with a stone until the surface is hard enough to take a fine line and slightly polished. A properly made patti is stiff, resilient, and will roll without cracking.",
      "Colours come from ground earth and stone — a yellow and a red from mineral sources, white from burnt and ground conch shell, black from lamp soot — bound with gum. Brushes are made by the painter from animal hair set into a quill or a stick, some of them a very few hairs thick.",
      "The painting is built outline first, without preliminary drawing, and the final black line is laid over the finished colour rather than under it. The compositions are dense: figures within borders, borders within borders, and every remaining space filled with foliage, so there is effectively no ground. When the paint is dry the panel is coated with lacquer and warmed, which fixes the surface and gives the whole thing its characteristic sheen.",
      "The same skills are applied to painted wooden toys, to palm-leaf engraving and to the annual repainting of temple images, so a household's year is not a single continuous production of pictures for sale."
    ],
    region: "raghurajpur",
    materials: ["cotton", "tamarind seed glue", "chalk", "mineral pigments", "lampblack", "lacquer"],
    techniques: ["hand painting", "line drawing", "lacquer finishing"],
    latitude: 19.9066,
    longitude: 85.8378,
    photo: "pattachitra",
    isFeatured: true
  },
  {
    slug: "kalamkari",
    name: "Srikalahasti kalamkari",
    summary:
      "Cloth painting in which the design is drawn freehand with a bamboo pen and the colours are produced by dyeing mordants rather than by applying pigment. It is worked at Srikalahasti in Andhra Pradesh, largely on narrative and temple subjects.",
    bodyParagraphs: [
      "The cloth is prepared with myrobalan and buffalo milk. The myrobalan supplies the tannin the black depends on; the milk keeps the drawn line from bleeding into the surrounding cotton, which it otherwise would, since the cloth is being drawn on wet. This preparation is why the ground of a finished kalamkari is a warm off-white rather than a bleached one.",
      "The kalam is a length of bamboo with one end beaten into fibres and bound with a wad of cloth or hair, which acts as a reservoir; the painter squeezes it to control flow. The black outline is drawn first, in a liquor of iron and jaggery left to ferment, which is colourless-to-brown going on and turns black by reaction with the tannin already in the cloth.",
      "Red is not painted red. Alum is drawn onto the areas that are to be red, the whole cloth is boiled with madder or a related root, and only the alum-bearing areas take the colour; the rest is washed clean. Blue is added afterwards, with the indigo either painted on or the cloth dipped after the other areas are stopped out with wax. Yellow, being less stable, usually goes on last.",
      "So the picture emerges in stages, none of which looks much like the finished thing, and a mistake made at the drawing stage is only fully visible several washes later. The work is done near running water, and the repeated washing between stages is as much of the labour as the drawing is."
    ],
    region: "srikalahasti",
    school: "srikalahasti",
    materials: ["cotton", "myrobalan", "iron acetate", "madder", "alum", "natural indigo"],
    techniques: ["hand painting", "pen drawing", "mordant dyeing", "natural dyeing"],
    latitude: 13.7497,
    longitude: 79.6983,
    photo: "kalamkari"
  },
  {
    slug: "machilipatnam-kalamkari",
    name: "Machilipatnam kalamkari",
    summary:
      "The block-printed branch of kalamkari, worked around Machilipatnam and Pedana on the Andhra coast. It uses the same mordant-and-dye chemistry as the pen-drawn work but builds its patterns from carved wooden blocks, and its repertoire reflects the export trade it grew up serving.",
    bodyParagraphs: [
      "The cloth is prepared as it is for pen work — treated with myrobalan and milk — but the design is then printed rather than drawn. An outline block is printed first and filler blocks follow, carrying mordants rather than colours, so the printed cloth looks pale and muddy until it has been through the dye bath.",
      "The repertoire is dominated by repeating floral and vegetal patterns, trees and creepers within borders, and this reflects the port's history: Machilipatnam produced painted and printed cottons for markets across the Bay of Bengal and westwards, and the taste of those markets is legible in the designs.",
      "Because the chemistry is the same, the two branches are frequently sold under one word, and a buyer is entitled to know which they have: pen-drawn work carries the irregularity of a hand-held line, block-printed work repeats exactly and shows the seam where one impression meets the next.",
      "Both branches depend on many changes of water. The finishing washes are done in the open, and the work is therefore tied to the season as well as to the supply."
    ],
    region: "machilipatnam",
    school: "machilipatnam",
    materials: ["cotton", "myrobalan", "iron acetate", "madder", "alum", "natural indigo", "teak"],
    techniques: ["block printing", "mordant dyeing", "natural dyeing"],
    latitude: 16.1875,
    longitude: 81.1389
  },
  {
    slug: "warli",
    name: "Warli wall painting",
    localName: "वारली",
    localNameLang: "mr",
    summary:
      "Wall painting of the Warli community of Palghar district in Maharashtra, worked in white rice paste on a ground of mud and dung. Its figures are built from a very small geometric vocabulary — two triangles for a body, a circle for a head, a line for a limb.",
    bodyParagraphs: [
      "The painting is done on the interior walls of the house, on a ground of earth mixed with cow dung which dries to a dark, even, slightly absorbent brown. The paint is rice flour ground with water and a little gum, applied with a chewed bamboo twig that behaves like a stiff brush and gives a dry, granular line.",
      "The drawing system is genuinely economical. A human figure is two triangles meeting at their points, with a circle for the head and single strokes for arms and legs; the same construction serves for a man, a woman, a dancer and a figure carrying a pot, distinguished by what the limbs are doing rather than by any added detail. Animals, trees, houses and hills are drawn with the same restraint.",
      "The most formal of these paintings is the chauk, made for a wedding, which is a square framed field with a presiding figure inside it and is painted by particular women rather than by anyone. Around it the wall fills with everything else: the harvest, the hunt, a market, a spiral of figures winding round a musician playing the tarpa.",
      "Since the 1970s the same imagery has been painted on paper and cloth for sale, and the vocabulary has proved so portable that it has been copied onto every conceivable surface by people with no connection to the community. That is a live question about credit and consent rather than a settled historical one, and the record should say so."
    ],
    region: "palghar",
    originNote: "A domestic wall-painting practice; the earliest firmly documented examples are twentieth-century, although the practice is older than its documentation.",
    materials: ["rice flour", "cow dung", "bamboo"],
    techniques: ["mural painting", "hand painting", "line drawing"],
    latitude: 19.6967,
    longitude: 72.7699,
    photo: "warli"
  },
  {
    slug: "pichwai",
    name: "Pichwai temple hangings",
    localName: "पिछवाई",
    localNameLang: "hi",
    summary:
      "Large painted cloths hung behind the image in the shrine at Nathdwara in Rajasthan, changed according to the festival calendar and the season. Their subjects — cows, lotus ponds, groves, the monsoon — are tied to what is being observed on the day they hang.",
    bodyParagraphs: [
      "A pichwai is functional before it is decorative: it is the backdrop against which the image is seen, and its subject is determined by the occasion. A cloth for the autumn festival of lamps is not interchangeable with one for the spring, and a workshop's year is organised around producing and rotating them.",
      "The cloth is cotton, sized and burnished to take paint. Colours are prepared from mineral and plant sources with a binder, and gold and silver are used both as leaf and as paint. Compositions are strongly symmetrical, with a central figure, ranks of attendant cows or devotees, and a border of repeating motifs.",
      "The painters at Nathdwara worked as a hereditary workshop tradition serving the shrine, and the same hands produced miniature paintings, portable shrine furnishings and, later, printed images. That range is why the town's style is recognisable across formats.",
      "Cloths made for sale rather than for use in the shrine are now a large part of the trade, and a hanging painted for a wall in a house is doing a different job from one painted for a particular day in the temple year — a distinction that a catalogue entry should preserve."
    ],
    region: "nathdwara",
    school: "nathdwara",
    originYear: 1700,
    originNote: "The shrine at Nathdwara was established in the late seventeenth century, and the painting workshops grew up around it.",
    materials: ["cotton", "mineral pigments", "gold leaf"],
    techniques: ["hand painting", "gilding"],
    latitude: 24.9333,
    longitude: 73.8167,
    photo: "pichwai"
  },
  {
    slug: "thanjavur-painting",
    name: "Thanjavur painting",
    summary:
      "Devotional panel painting on a wooden plank, in which the ornament is built up in low relief in gesso and covered with gold leaf, with the painting worked around it. It took its present form at the Maratha court of Thanjavur in the late eighteenth century.",
    bodyParagraphs: [
      "The support is a plank, historically jackwood, with cloth glued over it to give a stable surface. Over the cloth goes a ground of chalk and adhesive. The design is drawn, and then the areas that are to be jewellery, crowns, columns, thrones and borders are built up with successive applications of the same paste, so that they stand physically above the surface.",
      "Gold leaf is laid over the raised work. It follows the relief exactly, so the ornament catches light from any angle and reads as an object rather than as a painted representation of one. Inset stones — historically semi-precious, later glass and foil-backed beads — are set into the gesso in the same operation.",
      "Only then is the picture painted, in flat opaque colour, in the areas the gold does not occupy: faces, limbs, drapery and ground. The figures are frontal, large-eyed and set close to the picture plane, usually with a curtain or arch framing them.",
      "Because so much of the surface is gold and gesso rather than paint, condition problems in these panels are mostly structural — the gesso lifting from the cloth, the leaf failing where the relief has cracked — which makes them a conservation problem quite unlike a painting on paper."
    ],
    region: "thanjavur",
    originYear: 1750,
    originNote: "Took its present form at the Maratha court of Thanjavur in the late eighteenth century.",
    materials: ["teak", "chalk", "gold leaf", "mineral pigments", "glass"],
    techniques: ["hand painting", "gesso relief", "gilding"],
    latitude: 10.787,
    longitude: 79.1378,
    photo: "thanjavur"
  },
  {
    slug: "kalighat-painting",
    name: "Kalighat painting",
    summary:
      "Quickly painted watercolours made for pilgrims near the Kalighat temple in nineteenth-century Calcutta, on cheap mill-made paper. The manner is a few sweeping brushstrokes, a shaded volume and a bare ground, and the subjects ran from deities to sharp satire on city life.",
    bodyParagraphs: [
      "These were cheap pictures made fast, and the technique is entirely shaped by that. The figure is laid in with a broad loaded brush in one or two strokes, shaded along one edge to give it volume, and finished with a rapid black outline. There is no background: the paper is left blank, which both saves time and throws the figure forward.",
      "The materials were what the bazaar supplied — imported machine-made paper, commercial watercolours, occasionally tinsel — rather than the prepared grounds and hand-ground mineral colours of older painting. This is a tradition that begins with an industrial supply chain rather than being disrupted by one.",
      "The subject matter is the interesting part. Alongside the deities bought as souvenirs of a temple visit, the painters produced a running commentary on nineteenth-century Calcutta: the dandified clerk, the domineering wife, the fashionable courtesan, and at least one notorious murder trial, sold as a picture within weeks of the verdict.",
      "The trade collapsed when cheap lithographs and then photographs took its market, and the surviving pictures were largely preserved by collectors outside Bengal. Its formal influence on later Indian painting is out of all proportion to the fifty-odd years in which it was a going concern."
    ],
    region: "kolkata",
    school: "kalighat",
    originYear: 1800,
    originNote: "Made for pilgrims at the Kalighat temple through the nineteenth century.",
    materials: ["handmade paper", "mineral pigments"],
    techniques: ["hand painting", "line drawing"],
    latitude: 22.5726,
    longitude: 88.3639
  },
  {
    slug: "kolam",
    name: "Kolam",
    localName: "கோலம்",
    localNameLang: "ta",
    summary:
      "A drawing made on the ground at the threshold of a house, most often in rice flour let out between the fingers, renewed daily and expected to be walked over and worn away. It is everyday practice across Tamil Nadu.",
    bodyParagraphs: [
      "The ground is swept and sprinkled with water first, so the flour adheres. The drawing is made by taking a pinch of rice flour and letting it run out between thumb and forefinger in a controlled stream while the hand moves — the line is a falling stream of powder, not a mark made by contact, which is why an experienced hand can draw an unbroken curve several feet long without stopping.",
      "Most kolams are constructed on a grid of dots, laid down first in a counted arrangement. The lines are then drawn around, through or between the dots according to the type. In the looped kind, a single continuous line winds around every dot in the grid and closes on itself without ever being lifted or crossing itself twice at the same place — a constraint stringent enough that these patterns have been studied as formal grammars.",
      "The practice is daily and domestic, done at dawn, and it is meant to be impermanent: the day's kolam is destroyed by feet, wheels and rain, and drawn again the next morning. Rice flour is used partly so that ants and birds feed on it, which makes the offering the point rather than the picture.",
      "Festival kolams are larger, coloured, and sometimes worked in wet paste rather than dry flour so they survive longer, and competitions have made large public kolams a recognisable form in their own right. The daily kolam remains the one that carries the skill."
    ],
    region: "tamil-nadu",
    materials: ["rice flour"],
    techniques: ["floor drawing", "line drawing"],
    photo: "kolam"
  },
  {
    slug: "sanjhi",
    name: "Sanjhi paper cutting",
    summary:
      "Stencils cut freehand from paper with fine scissors, used to lay images in coloured powder — and, in the most demanding form, on the surface of still water. It is associated with the temple towns of the Braj region around Mathura.",
    bodyParagraphs: [
      "The whole image is cut, not drawn: a single sheet is held in the hand and worked with small scissors until what remains is a lattice of connected paper, every part of which must stay attached to the rest or the stencil falls apart. There is no cutting mat and no knife; the tension is controlled entirely by how the paper is held.",
      "The stencil is then used. Dry colour is sifted through it onto a prepared ground to leave the image, and the stencil is lifted away. In the form for which the tradition is best known, the stencil is held just above a tank of still water and the colour is sifted onto the surface, where it floats — an image that exists for as long as the water stays undisturbed.",
      "The subject matter is devotional and seasonal, tied to particular observances in the Braj calendar, and the compositions are dense with foliage and figures because a dense design is more stable as a stencil than a sparse one.",
      "Very few people cut at the level the water technique requires, and the skill is essentially unrecoverable from the objects: a cut stencil records the result and not the sequence of cuts that produced it, so the knowledge is only transmissible by watching."
    ],
    region: "mathura",
    materials: ["handmade paper", "mineral pigments"],
    techniques: ["paper cutting", "stencil cutting"],
    latitude: 27.4924,
    longitude: 77.6737
  },
  {
    slug: "rogan-painting",
    name: "Rogan painting",
    summary:
      "Cloth painting in which the paint is a thick, elastic paste of boiled castor oil and pigment, drawn out into a fine thread on a metal rod and laid onto the cloth without the rod ever touching it. It is worked at Nirona in Kachchh by a very small number of practitioners.",
    bodyParagraphs: [
      "Castor oil is boiled for many hours until it thickens into a residue with the consistency of a stiff gum, and pigment is worked into it. Kept under water, the paste stays workable; taken out and worked between the fingers, it becomes elastic enough to be drawn into a thread.",
      "The painter takes up a small quantity on a blunt iron rod, twists it until a fine filament forms, and lays that filament onto the cloth by lowering it — the thread transfers because it touches the cloth, while the rod stays above the surface. Line quality is controlled by how fast the hand moves and how far the rod is held from the cloth.",
      "The design is usually worked on one half of the cloth and the cloth is then folded onto itself, printing a mirror image while the paint is still tacky. The symmetry of a rogan cloth is therefore an artefact of the process rather than a matter of drawing the second half.",
      "The number of people who do this is very small — a single extended family's work has kept it in existence in recent decades — which makes it one of the clearest cases in the archive of a technique whose survival is a question about individuals rather than about an industry."
    ],
    region: "nirona",
    materials: ["cotton", "castor oil", "mineral pigments"],
    techniques: ["hand painting", "line drawing"],
    latitude: 23.2419,
    longitude: 69.6669
  },

  // ── Metal ───────────────────────────────────────────────────────────────────────────────────
  {
    slug: "bidriware",
    name: "Bidriware",
    summary:
      "Vessels and objects cast in a zinc-rich alloy, inlaid with pure silver, and then blackened by a treatment that darkens the alloy to a deep matt black while leaving the silver bright. It is made at Bidar in northern Karnataka, and the blackening depends on soil taken from the town's fort.",
    bodyParagraphs: [
      "The body is cast first, in an alloy that is largely zinc with a small proportion of copper, and turned and filed to shape. The surface is then temporarily darkened with a copper sulphate solution so that the craftsman can see his drawing, and the design is engraved into it with a chisel, cutting grooves undercut slightly at the edges so the inlay will hold.",
      "Silver — as drawn wire for line, or as cut sheet for broader areas — is hammered into those grooves. Nothing solders it: it is held mechanically by the undercut, and the surface is then filed and rubbed flush so that inlay and ground are one plane.",
      "The final stage is the one that gives the ware its name and its look. A paste of soil from inside Bidar fort, mixed with ammonium chloride and water, is heated and applied to the piece. It reacts with the zinc alloy to produce a permanent, lightless black, and does not affect the silver at all, so the pattern comes up in brilliant white against a black that no polish will lift.",
      "The dependence on that particular soil is real rather than folklore, and is generally attributed to its composition and to its having been sheltered from weathering inside the fort. It is also a genuine constraint on the craft: a material that comes from one specific place, in a town that is now built up, is a supply chain with no substitute."
    ],
    region: "bidar",
    originYear: 1400,
    originNote: "Associated with the Bahmani court at Bidar and documented from the fifteenth century.",
    materials: ["zinc alloy", "copper", "silver", "sal ammoniac", "soil"],
    techniques: ["metal casting", "engraving", "metal inlay", "polishing"],
    latitude: 17.9104,
    longitude: 77.5199,
    photo: "bidriware",
    isFeatured: true
  },
  {
    slug: "dhokra",
    name: "Dhokra lost-wax casting",
    summary:
      "Hollow brass casting by the lost-wax method, in which the model is built up from hand-rolled threads of wax laid over a clay core, so that the finished metal carries the wax coil as its surface. It is made in Bastar in Chhattisgarh and across a belt reaching into Odisha, Jharkhand and West Bengal.",
    bodyParagraphs: [
      "A core is modelled in clay to roughly the shape and mass of the finished object, dried, and then covered in wax. In this tradition the wax is not applied as a sheet but rolled into long threads of even thickness and wound, coiled and laid over the core like drawing in three dimensions — which is why the finished bronze has a corded, linear surface that no chasing produced.",
      "The waxed model is coated with successive layers of clay, fine first so it takes the detail, then coarse for strength, and a channel and a crucible are attached. The whole assembly is fired: the wax runs out, and molten metal — often scrap brass — runs in to take its place.",
      "When the mould is broken open the casting is finished. It cannot be broken open twice, so every piece is unique by construction, and the small irregularities of the coil, the seam and the channel are evidence of process rather than defects to be filed away.",
      "Lost-wax casting in the subcontinent is very old — metal figures made this way are known from the Indus period — but the age of the technique is not evidence for the age of any particular living tradition, and this record does not date the Bastar practice to it."
    ],
    region: "bastar",
    materials: ["brass", "beeswax", "clay"],
    techniques: ["lost-wax casting", "metal casting", "hand modelling"],
    latitude: 19.0785,
    longitude: 82.0147,
    photo: "dhokra",
    isFeatured: true
  },
  {
    slug: "moradabad-brass",
    name: "Moradabad brass work",
    summary:
      "Brass vessels, fittings and ornament made at Moradabad in western Uttar Pradesh, where casting, turning, engraving and finishing are done as separate specialised trades feeding a single large export industry.",
    bodyParagraphs: [
      "Most work begins as a casting: molten brass poured into a sand mould taken from a wooden or metal pattern, then knocked out, cleaned and turned on a lathe to true the surfaces. Sheet work is raised and spun separately. What arrives at the engraver is therefore already a finished shape.",
      "The decoration is cut into the surface with chisels and gravers, and the characteristic Moradabad ornament is a dense all-over field of small cuts that catch light differently according to their direction, so a pattern reads as texture from across a room and as line up close.",
      "Finishing is where most of the visible variety is produced: pieces may be left bright, oxidised to darken the recesses, electroplated in nickel or silver, or lacquered to stop the brass from tarnishing. Much of what is sold as a single object has passed through five or six workshops.",
      "The city's dependence on export orders means the repertoire tracks foreign taste closely, and the pressure on the craft is less about the loss of technique than about wages, health in the casting and polishing shops, and the price of metal."
    ],
    region: "moradabad",
    materials: ["brass", "copper", "clay"],
    techniques: ["sand casting", "metal casting", "engraving", "polishing"],
    latitude: 28.8386,
    longitude: 78.7733,
    photo: "brass-casting"
  },
  {
    slug: "thatheras-jandiala-guru",
    name: "Hand-beaten brass and copper utensils",
    summary:
      "Cooking and serving vessels raised by hand from cast ingots that have been flattened into sheet, then beaten to shape over successive heatings. The craft of the Thatheras of Jandiala Guru in Punjab was inscribed on a UNESCO intangible heritage list in 2014.",
    bodyParagraphs: [
      "The metal starts as a cast ingot, flattened into thin sheet by hammering rather than rolling. From that sheet a vessel is raised: the smith works the metal over a stake with a hammer, driving it up into a curve, and takes it repeatedly to a furnace as it work-hardens so it can be beaten further without splitting.",
      "The finished surface is a field of overlapping hammer marks, which is a structural signature as much as a decorative one — the pattern shows the order in which the metal was moved. Vessels are finished with sand and tamarind, which cuts the oxide and leaves the metal bright.",
      "Different alloys are used for different jobs: brass for some vessels, copper for others, and tinning applied inside where the food requires it. The forms are functional and named — cooking pots, water vessels, large cauldrons for communal kitchens — and their proportions are set by use rather than by fashion.",
      "The trade is a workshop trade with a clear division of labour and a long apprenticeship, and its competitor is not another craft but stainless steel and aluminium, which are lighter, cheaper and require no maintenance."
    ],
    region: "jandiala-guru",
    materials: ["brass", "copper"],
    techniques: ["sheet-metal beating", "metal casting", "polishing"],
    latitude: 31.5646,
    longitude: 75.0281
  },
  {
    slug: "aranmula-kannadi",
    name: "Aranmula metal mirror",
    summary:
      "A mirror made not of glass but of a polished metal alloy, so that the reflecting surface is the front face itself and the image has no secondary reflection behind it. It is made at Aranmula in Kerala, by a small number of households.",
    bodyParagraphs: [
      "An ordinary mirror reflects from a silvered layer behind a sheet of glass, so the glass surface produces a faint second image offset from the first. A front-surface metal mirror has nothing in front of the reflector, and the doubling disappears — which is the whole point of the object and is immediately visible when one is held next to a glass mirror.",
      "The alloy is a tin-and-copper mixture whose exact proportion is the difficult part and is held closely within the families that make them; too little tin and the metal will not take the polish, too much and the casting is unworkably brittle. The metal is cast in moulds built from local clay, then broken out.",
      "The polishing is the labour. The cast face is ground and then polished by hand for days with progressively finer abrasives until it is optically flat, and any error at this stage means starting again — the surface cannot be corrected locally without introducing distortion.",
      "The mirrors are set in metal frames and are used in ritual as much as for looking at oneself, and the pieces are sold as objects with a provenance. Both the alloy knowledge and the polishing skill sit with a handful of families, which is the practical definition of a craft at risk."
    ],
    region: "aranmula",
    materials: ["copper", "tin", "clay"],
    techniques: ["metal casting", "polishing"],
    latitude: 9.3167,
    longitude: 76.6833
  },

  // ── Earth, glaze and stone ──────────────────────────────────────────────────────────────────
  {
    slug: "blue-pottery",
    name: "Jaipur blue pottery",
    summary:
      "Glazed ware whose body contains no clay at all: it is made from ground quartz and glass bound with a little fuller's earth and gum, shaped in moulds, painted with cobalt and copper oxides, glazed and fired once at a low temperature.",
    bodyParagraphs: [
      "The body is the unusual part. Quartz is ground fine and mixed with powdered glass, a small quantity of fuller's earth, borax and gum. The resulting paste has almost no plasticity, so it cannot be thrown on a wheel — pieces are pressed into plaster moulds, or formed over them, and joined while still damp.",
      "Because there is no clay, the fired body is white and slightly translucent at the edges, and it is also brittle: blue pottery chips where an earthenware pot would survive, and large flat forms crack in drying more readily than a potter used to clay would expect.",
      "Painting is done directly onto the dried body with metallic oxides — cobalt for the characteristic blue, copper for turquoise green — and the glaze, itself largely glass, goes over the top. The whole thing is fired once, comparatively cool, which is what keeps the colours bright and the glaze glassy.",
      "The technique arrived in Jaipur from a Persian-derived tradition of frit ware and was developed there in the nineteenth century under court patronage; it had almost died out by the mid-twentieth century and was revived by a deliberate effort to bring back the body recipe and the firing."
    ],
    region: "jaipur",
    originYear: 1800,
    originNote: "Developed at Jaipur in the nineteenth century from an older Persian-derived frit-ware tradition, and deliberately revived in the mid-twentieth century after a near-collapse.",
    materials: ["quartz", "glass", "cobalt oxide", "glaze"],
    techniques: ["mould pressing", "glazing", "kiln firing", "hand painting"],
    latitude: 26.9124,
    longitude: 75.7873,
    photo: "blue-pottery"
  },
  {
    slug: "khurja-pottery",
    name: "Khurja glazed pottery",
    summary:
      "Glazed ceramic ware made at Khurja in western Uttar Pradesh, using a clay body — unlike the clay-free Jaipur ware — fired twice, once to biscuit and again after glazing. The town supplies a large part of the country's everyday glazed tableware.",
    bodyParagraphs: [
      "The body is a blend of clays with quartz and feldspar, prepared as a slip and either cast in moulds or thrown, depending on the form. Fired to biscuit, it is porous enough to take the glaze evenly by dipping, which is what makes a two-fire process worth the extra fuel.",
      "Decoration is applied over or under the glaze with metallic-oxide colours, and the familiar Khurja repertoire is a blue-and-brown floral drawn quickly and freehand around the wall of the pot. Painters work in a production rhythm — hundreds of pieces a day — and the economy of the brushwork follows from that.",
      "The second firing melts the glaze into a hard, food-safe surface and matures the body. Kiln management is the town's real expertise: what distinguishes the work is consistency across a large batch rather than any single spectacular piece.",
      "Khurja sits between craft and light industry, and it demonstrates something the archive should not hide — that a traditional pottery centre can survive precisely by becoming a supplier of ordinary goods, and that the resulting change in the work is a change in scale before it is a change in skill."
    ],
    region: "khurja",
    materials: ["clay", "quartz", "glaze", "cobalt oxide"],
    techniques: ["wheel throwing", "mould pressing", "glazing", "kiln firing", "hand painting"],
    latitude: 28.2537,
    longitude: 77.8556,
    photo: "khurja-pottery"
  },
  {
    slug: "bishnupur-terracotta",
    name: "Bishnupur terracotta temple work",
    summary:
      "Architectural ornament in fired clay, covering the walls of the brick temples of Bishnupur in West Bengal with panels of narrative relief. The delta has no building stone, so brick and terracotta do the work that carved stone does elsewhere.",
    bodyParagraphs: [
      "The absence of stone is the origin of the style. In an alluvial plain the available material is clay, so temples were built of brick, and the surface that in a stone temple would be carved after building is here made as separate fired panels and set into the facade.",
      "Panels were carved or pressed in the leather-hard clay before firing, which is a different discipline from stone carving: the material is soft and forgiving but shrinks as it dries and again as it fires, so the composition has to anticipate a reduction that is not perfectly even. Undercutting that would be routine in stone risks losing the piece in the kiln.",
      "The subject matter runs from the epics — long registers of battle scenes, ranks of chariots and archers — to hunting, boats, court scenes and daily life, and the panels are laid out in horizontal bands so that a wall is read from the ground upwards.",
      "The temples were built under the Malla rulers of Bishnupur, and several carry dated inscriptions. The craft of architectural terracotta is much older than any of them; the dated buildings only fix when this particular concentration of it was made."
    ],
    region: "bishnupur",
    originYear: 1643,
    originNote: "A date taken from one of the dated Bishnupur temples, not the origin of the craft: architectural terracotta in Bengal is considerably older.",
    materials: ["terracotta clay", "clay"],
    techniques: ["hand modelling", "mould pressing", "kiln firing", "relief carving"],
    latitude: 23.0667,
    longitude: 87.3167,
    photo: "terracotta"
  },
  {
    slug: "stone-jaali",
    name: "Pierced stone jaali screens",
    summary:
      "A window or screen cut through a single slab of stone, so that the pattern is what remains after the openings have been removed. Jaali work is found across western India in sandstone and marble, and the sixteenth-century screens of Ahmedabad are among its most-copied examples.",
    bodyParagraphs: [
      "The screen is subtractive: a slab is dressed flat, the design is set out on it, holes are drilled through at the centre of each opening, and the waste is then cut away with saw and chisel from both faces. Nothing is assembled, so the whole pattern must remain structurally connected — every element carries load, and a design that would be merely thin as a drawing will fail as a screen.",
      "This is why jaali geometry looks the way it does. Interlacing bands, repeating stars and continuous vegetal scrolls all distribute stress through many small connections rather than a few slender ones, and the density of the pattern is a structural decision before it is an aesthetic one.",
      "A screen does real environmental work. It cuts direct sun while admitting light, it preserves privacy in one direction while allowing a view in the other, and because air accelerates through the narrow openings it moves a room's air more effectively than an open window of the same area.",
      "The stones used are chosen for how they cut: sandstone for its workability at large scale, marble where fineness matters. The carver's skill is judged on the evenness of the members and on whether the pattern reads cleanly when seen against bright light, which is unforgiving of any variation in thickness."
    ],
    region: "ahmedabad",
    originYear: 1500,
    originNote: "The Ahmedabad screens are sixteenth-century; pierced stone screens in Indian architecture are older.",
    materials: ["sandstone", "marble"],
    techniques: ["stone carving", "pierced screen work"],
    latitude: 23.0225,
    longitude: 72.5714,
    photo: "jaali"
  },
  {
    slug: "mamallapuram-stone-carving",
    name: "Granite carving at Mamallapuram",
    summary:
      "Sculpture and architectural carving in granite on the Tamil Nadu coast, in the town whose seventh- and eighth-century rock-cut monuments are the tradition's most famous work. Workshops there still carve temple images and architectural members to the proportional systems the tradition sets out.",
    bodyParagraphs: [
      "Granite is unforgiving. It is hard, it is brittle at the edges, and it cannot be built up — everything is removed and nothing can be put back, so the carving proceeds from the outside in, in stages, keeping the whole block roughly in balance rather than finishing one part before starting another.",
      "The work is done with tempered steel points and chisels struck with an iron hammer, and much of the day's labour is dressing tools: the stone blunts a point quickly, and a carver expects to re-sharpen many times between rests. The characteristic rhythm of a carving yard is that sound.",
      "Images are not composed freely. Proportion, posture, attributes and the relation of the figure to its niche follow the canonical systems used for temple sculpture, and a carver's competence is judged partly on knowing them. The stone is measured out in units derived from the figure's own dimensions before a chisel touches it.",
      "The monuments cut here in the seventh and eighth centuries under the Pallavas — the rock-cut shrines, the great relief panel, the monolithic temples — remain the reference against which the town's work is measured, and their presence is one reason a living carving trade is still concentrated on this stretch of coast."
    ],
    region: "mamallapuram",
    originYear: 700,
    originNote: "The rock-cut monuments at Mamallapuram were made in the seventh and eighth centuries; stone carving in the region is older and has been continuous since.",
    materials: ["granite"],
    techniques: ["stone carving", "relief carving"],
    latitude: 12.6208,
    longitude: 80.1945
  },

  // ── Wood and lacquer ────────────────────────────────────────────────────────────────────────
  {
    slug: "channapatna-toys",
    name: "Channapatna lacquered toys",
    summary:
      "Turned wooden toys and figures coloured with lacquer applied on the lathe, made at Channapatna in Karnataka. The wood used is a soft, close-grained pale timber that turns cleanly and takes colour evenly.",
    bodyParagraphs: [
      "The timber is seasoned, cut to length and turned on a lathe — historically a hand- or foot-driven one, now usually powered. Forms are built from a small number of turned profiles: spheres, spindles, discs and rings, assembled into figures, rattles, spinning tops and stacking sets. Anything not a solid of revolution has to be carved separately and fitted.",
      "The colour goes on while the piece is still spinning. A stick of lacquer — a natural resin coloured with dye — is held against the turning work, and the friction melts it onto the surface. The lacquer is then burnished with a leaf held against the spinning piece, which spreads it into an even film and polishes it in the same operation.",
      "Because the colour is a resin fused to the wood rather than a paint film sitting on it, it wears rather than flakes, which is one reason the toys have a reputation for being safe for small children. Colourants used are typically vegetable-derived, and the absence of solvent-based paint is now a selling point as well as a tradition.",
      "The craft is a lathe trade with a long apprenticeship in a narrow skill: the cut quality, the fit of the joints and the evenness of the lacquer are all the work of the same hands, and a workshop's output is limited by the number of people who can hold that combination."
    ],
    region: "channapatna",
    materials: ["ivory wood", "lac", "natural dyes"],
    techniques: ["wood turning", "lacquer turnery", "polishing"],
    latitude: 12.6514,
    longitude: 77.2065,
    photo: "channapatna"
  },
  {
    slug: "odisha-wood-carving",
    name: "Odisha wood carving",
    summary:
      "Carving in wood for images, temple doors, chariot components and household objects across Odisha, worked with hand tools in relief and in the round. Its most demanding application is ritual: images that must be carved from specified timber to specified rules.",
    bodyParagraphs: [
      "Most work is done with a set of chisels and gouges and a wooden mallet, with the piece held between the feet or against a low block rather than in a vice. Relief carving on doors and panels is laid out with the ground cut back first so that the design stands proud, and the modelling follows once the depth is established.",
      "In-the-round work is more constrained than relief because the block sets the limits: the figure has to be planned so that its extremities fall inside the timber, and the carver works around it, keeping the whole roughly in step rather than finishing one side.",
      "Ritual image-carving is a specialism within the trade. Images for temple use are made from prescribed woods — neem among them — chosen by trained eyes to specified criteria, and are carved by particular hereditary carvers rather than by the trade at large. The technical demands are ordinary; the constraints around them are not.",
      "The same skills feed a large secular production of decorative panels, figures and painted wooden toys, often finished by painters rather than by the carvers themselves, so a finished object may pass through two trades before it is sold."
    ],
    region: "odisha",
    materials: ["neem wood", "teak", "mineral pigments"],
    techniques: ["wood carving", "relief carving", "hand painting"],
    photo: "wood-carving"
  },
  {
    slug: "kashmir-papier-mache",
    name: "Kashmir papier-mâché",
    summary:
      "Objects built from paper pulp pressed into moulds, surfaced with a fine white ground, and then painted with dense miniature ornament and varnished. It is two trades in sequence: one that makes the object, and one that decorates it.",
    bodyParagraphs: [
      "Waste paper is soaked until it breaks down, pounded to a pulp, and bound with a starch paste. The pulp is pressed into or over a mould, dried, and then cut off the mould in halves and rejoined, which is how hollow forms — boxes, pen cases, bowls, screens — are made without a seam that shows.",
      "The surface is prepared before painting: a thin coat of gypsum or a similar white ground is laid on and burnished with a hard stone until it is smooth and slightly polished, hard enough to take a very fine brush.",
      "Painting is done with brushes of a few hairs, in an ornament of repeating floral and vegetal patterning covering the entire surface, often with gold. The best work carries several layers of pattern at different scales, so an object rewards being looked at from a foot away and from an inch. It is finished with a clear varnish that deepens the colours and protects them.",
      "The two trades — making the body and painting it — are separately organised and separately paid, and the painting has historically been the more prestigious and the better documented of them. The base-making skill is the one more likely to disappear quietly."
    ],
    region: "srinagar",
    originYear: 1400,
    originNote: "Associated by tradition with fifteenth-century Kashmir; the surviving objects are much later.",
    materials: ["waste paper pulp", "gypsum", "mineral pigments", "gold leaf"],
    techniques: ["papier-mâché", "mould pressing", "hand painting", "lacquer finishing"],
    latitude: 34.0837,
    longitude: 74.7973,
    photo: "papier-mache"
  },

  // ── Grass, cane and fibre ───────────────────────────────────────────────────────────────────
  {
    slug: "sikki-grass-work",
    name: "Sikki grass work",
    summary:
      "Baskets, boxes and figures made from a golden wetland grass, split and coiled around a core and stitched with a metal awl. It is a domestic craft of the Mithila region of north Bihar, made for household use and for wedding gifts.",
    bodyParagraphs: [
      "The grass is cut when its stems have the right colour and flexibility, the pith is removed, and the stems are split lengthwise into strips of even width. Some strips are dyed; a good deal of the work is left in the grass's own pale gold, which is what gives the finished object its light.",
      "Construction is by coiling. A bundle of coarser grass is used as a core, wound in a spiral, and the split sikki is wrapped around it and stitched into the previous coil with a pointed metal tool that opens a passage rather than piercing. The shape is controlled entirely by where the coil is pulled tighter and where it is allowed to spread.",
      "Because the stitching is what shows, the pattern is made by exchanging one colour of strip for another as the coil grows, which means a design has to be planned as a length rather than as an area — the maker knows how many turns of the spiral will produce a given band.",
      "The objects are functional and ceremonial at once: containers for grain and spices, boxes given at marriages, and figures made for festivals. The craft is done alongside other household work rather than in a workshop, which makes its scale hard to measure and its transmission dependent on whether anyone in the next generation is still sitting in the same room."
    ],
    region: "madhubani-district",
    materials: ["sikki grass", "natural dyes"],
    techniques: ["coiling", "plaiting"],
    latitude: 26.3477,
    longitude: 86.0716
  },
  {
    slug: "pattamadai-mats",
    name: "Korai grass mat weaving",
    summary:
      "Fine sleeping mats woven from a split sedge, worked so finely that the best of them can be folded like cloth. They are made at Pattamadai in Tirunelveli district, Tamil Nadu.",
    bodyParagraphs: [
      "The raw material is korai, a sedge that grows in wet ground along the river. The stems are cut, dried, and then split lengthwise — and the fineness of the finished mat is decided at this stage, because a mat's grade is essentially a function of how narrow the splits are. The finest work uses strips slit to something close to a thread.",
      "Split korai is soaked, often for several days, to make it pliable enough to weave without cracking, and it is woven wet on a simple loom with a cotton warp. The weaver keeps the material damp throughout; a strip that dries mid-weave will break.",
      "The result is a mat that is soft, cool and flexible rather than stiff, and the very fine grades will fold without creasing permanently. Coloured strips are introduced for borders and for woven names or motifs, added by exchanging the weft.",
      "The economics are brutal in the way the finest handwork usually is: a top-grade mat takes weeks, is sold once, and competes on the shelf with a plastic mat that costs a fraction and does most of the same job."
    ],
    region: "tirunelveli",
    materials: ["korai grass", "cotton", "natural dyes"],
    techniques: ["handloom weaving", "plaiting"],
    latitude: 8.7139,
    longitude: 77.7567
  },
  {
    slug: "coir-work",
    name: "Coir spinning and weaving",
    summary:
      "Yarn, rope and matting made from the fibre of the coconut husk, which is first rotted in brackish water for months to release it. Alappuzha and the backwater districts of Kerala are the centre of the trade.",
    bodyParagraphs: [
      "The fibre is not simply pulled from the husk. Husks are steeped in the backwaters — the brackish, slow-moving water is part of the process — for months, until bacterial action has broken down the pith binding the fibre together. Retted husks are then beaten with mallets to separate the fibre from the residue, and the fibre is washed and dried.",
      "Spinning is done by hand or on a wheel, twisting the short fibres into a two-ply yarn. The characteristic long ropewalks of the region exist because the yarn is spun as a continuous length between two points, with the spinner walking backwards as the twist runs in.",
      "Weaving is done on heavy handlooms, producing mats and matting in plain weave and in patterned constructions, sometimes with dyed yarn worked in. Coir is stiff, abrasive and hard on the hands and on the loom, and the equipment reflects it.",
      "Retting is where the environmental cost sits: it consumes water, it degrades the water it is done in, and shortening it produces weaker fibre. Reconciling the quality of the fibre with the health of the backwaters is the trade's live technical problem rather than a matter of preserving a technique."
    ],
    region: "alappuzha",
    materials: ["coconut fibre", "natural dyes"],
    techniques: ["retting", "hand spinning", "handloom weaving"],
    latitude: 9.4981,
    longitude: 76.3388
  },

  // ── Hide, and the last of the painted traditions ────────────────────────────────────────────
  {
    slug: "tholu-bommalata",
    name: "Leather shadow puppets",
    summary:
      "Large jointed puppets cut from hide that has been scraped until it is translucent, painted on both faces, and performed against a lit cloth screen. In Andhra Pradesh the tradition is concentrated around Nimmalakunta in Anantapur district.",
    bodyParagraphs: [
      "The hide is the whole technical problem. It is cleaned, stretched and scraped down repeatedly until light passes through it, thin enough to be translucent but still strong enough to hold a punched hole and take handling night after night. A puppet the height of a person may use several skins matched for thickness.",
      "The figure is cut out, and the interior detail — jewellery, drapery, hair, the fill patterns of a costume — is punched through with awls and cutters so that light comes through as pattern. Colour is applied with dyes to both faces, because the audience sees transmitted light: an unpainted back would wash out the front.",
      "Limbs are jointed at the shoulder, elbow, hip and knee, tied so they hang and swing, and the puppet is manipulated by rods against a white cloth lit from behind. The show runs at night through episodes of the epics over successive evenings, with music and dialogue, and the puppeteers who cut the figures usually perform them.",
      "The audience for all-night performance has largely gone, and with it the reason to maintain a full company's worth of figures. What survives is partly a market for the puppets as objects, which keeps the cutting and painting alive while the repertoire that gave them their movement is at greater risk than the craft itself."
    ],
    region: "anantapur",
    materials: ["goat hide", "natural dyes", "bamboo"],
    techniques: ["leather punching", "hand painting", "line drawing"],
    latitude: 14.6819,
    longitude: 77.6006
  }
];
