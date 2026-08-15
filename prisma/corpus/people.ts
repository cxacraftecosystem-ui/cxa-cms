/**
 * THE CENTRE'S RESEARCH AREAS AND ITS PEOPLE.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IS IN HERE. Six research areas — what the Centre actually studies, rather than what reads
 * well on a funding application — and twenty-four people spread across every `PersonKind`. The
 * directory is deliberately NOT a wall of professors: a centre that documents craft runs on a
 * conservator, an archivist, a photographer, a field coordinator and somebody who pays the
 * practitioner fellows on time, and those five do as much of the work as the six faculty do.
 *
 * WHERE THE FACTS COME FROM. Two different places, and the distinction is the whole point:
 *
 *   • THE CRAFT FACTS ARE REAL. Ajrakh, patola, bidriware, dhokra, pattachitra, chikankari, warli,
 *     kolam and the rest are living practices belonging to real people. Region, material, technique
 *     and rough period are stated only where they are actually known. Where a detail was uncertain
 *     it was LEFT OUT rather than guessed at — a shorter entry is a smaller injury than a confident
 *     sentence that is wrong about somebody's trade. No local-language names or scripts appear here
 *     for the same reason, and no practice is attributed to a named community unless the community
 *     is already in the name of the craft itself.
 *
 *   • ⚠ THE CENTRE, ITS STAFF AND ITS WORK ARE FICTIONAL. Every name below is invented. None of
 *     these people exist, none of them stands in for anybody who does, and nothing here should be
 *     read as describing a real researcher, artisan or institution.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ NO PORTRAITS, ON PURPOSE — AND THIS IS THE MOST IMPORTANT NOTE IN THE FILE.
 *
 * `photo` is omitted for every person here, and no future edit should add one from the craft
 * manifest. The twenty-six bundled photographs are of crafts and of real, identifiable people at
 * work in them. Attaching one to a fictional staff profile would put a real weaver's or printer's
 * face under an invented name and an invented job title, on an institutional website, presented as
 * fact. That is not a placeholder; it is a misattribution of a living person's identity, and it
 * would survive every subsequent edit because nobody would think to check it.
 *
 * The directory renders an initials plate when a person has no portrait. That is the correct and
 * honest result: it says "we do not have a picture of this person", which is true.
 *
 * ⚠ NO ORCID, NO SCHOLAR PROFILE, NO TELEPHONE. The `SeedPerson` shape offers `orcid` and
 * `googleScholar` and both are left empty deliberately. An ORCID is a sixteen-digit identifier out
 * of a real, densely populated registry: any plausible-looking one that got typed here would stand
 * a good chance of resolving to an actual researcher, and would then attach a fictional biography
 * to their public record. There is no "clearly fictional" ORCID the way there is a clearly
 * fictional DOI prefix, so the field stays empty.
 *
 * Emails use `@cxa.example`. `.example` is reserved by RFC 2606 precisely so that documentation can
 * name a domain that is guaranteed never to belong to anyone — mail to it cannot reach a real
 * inbox, which a `.org` or `.in` address invented off the top of the head cannot promise.
 *
 * ⚠ SLUGS OTHER MODULES POINT AT. The research-area slugs are the join keys that `projects` and
 * `publications` name in their `researchArea` field. `material-science` is spelled exactly as the
 * worked example in `types.ts` spells it, because that example is the most likely thing a sibling
 * module will have copied. The other five read as they are titled.
 *
 * JUDGEMENT CALLS worth knowing about:
 *   • Six areas, not ten. Each one had to name a method, not a mood; "craft and identity" was cut
 *     because nothing concrete could be said about what the work would consist of.
 *   • Seniority and standing are split evenly between women and men at every grade, including the
 *     directorate. Names are spread across regions, languages and communities without any of them
 *     being made to carry a stereotype about the kind of work they do.
 *   • `sortOrder` ascends globally (directorate 1–6, laboratories 10–12, professional staff 20–24,
 *     assistants 30–32, doctoral students 40–42, visitors 50–51, alumni 60–61). The schema sorts
 *     within a `kind` group, so a single ascending sequence orders each group correctly as well.
 */

import type { SeedPerson, SeedResearchArea } from "./types";

/**
 * Six areas. Each is a method applied to the same question, and each is written so that a reader
 * can tell what somebody in it would actually spend Tuesday doing.
 */
export const RESEARCH_AREAS: SeedResearchArea[] = [
  {
    slug: "material-science",
    title: "Materials and Technique",
    summary:
      "What a craft is physically made of, and what happens to the practice when it can no longer be made of that. Fibre, clay, dye, alloy and binder, characterised in the laboratory and traced back to the ground they came from.",
    bodyParagraphs: [
      "Every craft sits on top of a supply chain older than any workshop still using it. An indigo vat is a living fermentation that has to be fed and kept warm, and it fails if it is neglected for a fortnight. A potter's body may depend on earth from one bend of one river. A dye comes from a plant that somebody, somewhere, has to still be growing at a scale that makes it worth harvesting. None of these are decorative facts about the craft; they are the constraints that produced its forms.",
      "When a material becomes unobtainable, the practice changes to accommodate the substitute, and the change is almost never written down. A generation later the original is remembered as a preference rather than as a different material that behaved differently. Establishing what was actually in use, and when it stopped being in use, is the first thing this area does — by analysis where a sample can properly be taken, and by asking where it cannot.",
      "The laboratory work is unglamorous and specific: fibre identification under magnification, chromatography to separate a natural dye from the synthetic that replaced it, elemental analysis of a cast alloy whose composition varies because the metal going into the crucible is scrap. Bidriware is the standing example of why this matters. The black surface of a bidri vessel is routinely described as a patina, as though it were the accident of age; it is a deliberately induced compound, and the soil used to produce it is taken from inside the fort at Bidar. The soil is genuinely part of the process rather than a piece of local colour, which is exactly the sort of claim that has to be tested rather than repeated.",
      "Technique is measured on the same terms. How many printing and washing passes, in what order, at what temperature, with how long between them. How fine a yarn can be spun by hand before it stops holding together, and why that number is what keeps a fabric off a powered loom. The aim is a description detailed enough that somebody could argue with it.",
      "Results go to the workshop the samples came from before they go anywhere else, in the language of that workshop, and a practitioner's objection to a finding is treated as evidence rather than as a complaint."
    ],
    icon: "Microscope",
    sortOrder: 1,
    photo: "bidriware"
  },
  {
    slug: "field-documentation",
    title: "Field Documentation and Archival Method",
    summary:
      "How a living practice becomes a record without becoming a specimen. Consent, sequence, vocabulary, and the discipline of writing down what you were not allowed to write down.",
    bodyParagraphs: [
      "The finished object is the easiest thing in a workshop to photograph and the least informative thing in it. What this area records is the sequence: the preparation that takes four days before anything visible happens, the failures, the corrections, and the judgements a practitioner makes continuously without being able to say afterwards why. A printer who hears that a block has landed wrong has made a measurement; the recording has to be good enough to catch it.",
      "Consent is treated as a document rather than a conversation, and as something that is revisited rather than assumed. Before a recording begins, the people whose knowledge it is say what may be published, what may be held and studied but not shown, and what must not leave the room. Those three categories are carried on the record for its whole life, and a later request to withdraw something takes precedence over the version already online.",
      "Vocabulary is taken as it is spoken. Tools, stages, motifs and faults are recorded in the words the workshop uses, in its own language, before any translation and before any mapping onto a standard term list. A term standardised too early is a distinction destroyed, and the distinctions are frequently the finding — a workshop with four words for a fault that the catalogue calls one thing is telling you something about the process.",
      "The method also insists on recording absence. A record that says nothing about a stage may mean the stage was not observed, or that it was observed and withheld, or that it does not exist; those are three different facts and a silent gap collapses them into one. Field notes carry the reason, so that a reader in twenty years is not left to guess."
    ],
    icon: "Archive",
    sortOrder: 2,
    photo: "handloom"
  },
  {
    slug: "livelihoods-and-markets",
    title: "Livelihoods, Markets and Rights",
    summary:
      "What a craft earns, who in the household it earns it for, and what protection exists when the name of a practice becomes more valuable than the practice.",
    bodyParagraphs: [
      "A craft with no buyer is a hobby, and the economics is not a separate subject from the technique — it decides how many passes a printer can afford to make and how fine a weaver can afford to spin. This area follows the money along the chain: the piece rate paid to the person at the loom, the margin at each intermediary, and the point at which most of the value is added, which is very often the point furthest from the workshop.",
      "Household accounting matters more than individual accounting, because the household is usually the unit that produces. Preparatory work — sorting, spinning, warping, tying, polishing — is frequently done by women in the same house and frequently not counted as work at all, which makes the craft look more profitable per hour than it is and makes the labour of half the people doing it invisible in every survey that asks who the artisan is.",
      "India protects craft names through geographical indication registration, and the distinction that catches people out is that a geographical indication protects the NAME, not the technique. Anybody may weave the way a registered craft is woven; what they may not do is sell the result under the registered name if they are outside the defined area and the registered body. The right is held collectively rather than by an individual, and enforcing it is a cost borne by the holders, which is a considerable difficulty for a body of a few hundred weavers facing a mill.",
      "The work here is survey and case study rather than advocacy: what a cluster's incomes actually are, how they move over a season, what happens to a workshop when the design intermediary who brought the orders moves on, and which interventions had a measurable effect on earnings rather than a photogenic launch."
    ],
    icon: "Scale",
    sortOrder: 3,
    photo: "patola"
  },
  {
    slug: "transmission-and-pedagogy",
    title: "Transmission and Pedagogy",
    summary:
      "How the knowledge moves from one pair of hands to another, what part of it can be taught in a room, and what happens when a three-week module is asked to stand in for six years.",
    bodyParagraphs: [
      "Craft knowledge is acquired in a body before it exists anywhere else, and it is acquired slowly. An apprenticeship is not a course with a syllabus; it is years of proximity, in which the learner does the preparatory work for a long time before being allowed near the difficult part, and in which correction is mostly physical. Describing that structure accurately — who teaches, at what age, in exchange for what, with what point of graduation — is the first task of this area, because most of it has never been set down.",
      "The second task is to be honest about the split. Some of the knowledge is propositional and transfers perfectly well into a book: proportions, sequences, recipes, the names of things. Some of it is a calibrated judgement that only accumulates with repetition, and no amount of documentation substitutes for the repetitions. Confusing the two is what produces a graduate who can describe a technique in detail and cannot perform it.",
      "Design schools and craft courses are studied here as a phenomenon in their own right. A visiting module gives a student a fortnight in a workshop and a portfolio piece; it gives the workshop a week of disrupted production and, sometimes, a motif that leaves with somebody else's name on it. Neither outcome is inevitable, and the arrangements that avoid them are worth documenting precisely.",
      "The area also produces teaching material with workshops rather than about them, and follows up on whether transmission actually occurred — how many learners were taken on, how many were still working three years later, and what the ones who left went to do instead."
    ],
    icon: "GraduationCap",
    sortOrder: 4,
    photo: "chikankari"
  },
  {
    slug: "conservation-science",
    title: "Conservation Science",
    summary:
      "Keeping the objects, and the harder problem of keeping the tools that are still in use. Deterioration mechanisms, storage, minimal intervention, and knowing when to leave something alone.",
    bodyParagraphs: [
      "Objects fail in ways that can be predicted and slowed. Textiles are damaged by light in a way that does not reverse and accumulates from every hour of display. Iron-based mordants, which give many painted and printed cottons their blacks, go on reacting with the fibre they sit on, so the black lines of a piece can become the first areas to fall out of it — the drawing destroys its own support. Understanding the mechanism decides the treatment; without it, conservation is decoration.",
      "Most of what protects a collection is environmental rather than interventive. Stable relative humidity, low light, clean air, flat storage with the right supports, and inspection on a schedule will do more for a hundred textiles than heroic treatment will do for one. This area's practical output is largely storage specifications, condition reports and light budgets, which is unexciting and is the work.",
      "A working tool is a different problem altogether, and it is the one this area finds most interesting. A printing block that is still printing cannot be treated as a museum object: it has to remain usable, it is expected to wear, and a block worn unevenly is evidence about how it was held and what was printed most. Freezing it would destroy both its function and the record it is accumulating. Deciding what to stabilise, what to document and then let wear, and what to copy so the original can be retired is a judgement made case by case with the workshop that owns it.",
      "Nothing is treated before it is recorded. Photography, condition description and, where it is warranted, analysis all happen first, because treatment removes evidence — and the evidence removed is usually the dirt, the repair and the wear, which is to say the object's history of use."
    ],
    icon: "FlaskConical",
    sortOrder: 5,
    photo: "kantha"
  },
  {
    slug: "digital-archives",
    title: "Digital Tools for the Archive",
    summary:
      "The software half of the problem: describing a record so it can be found, compared with its neighbours, and still be readable in thirty years by somebody with none of the context.",
    bodyParagraphs: [
      "A catalogue is an argument about what things are alike. Once region, material, technique and lineage are recorded as identifiers rather than as free text, a craft can be set against its neighbours and questions become askable that nobody could ask of a shelf of reports: which practices in this district share a mordant, which techniques appear on both sides of a linguistic boundary, where a material stops being available. That is the whole reason the archive is a database and not a stack of PDFs.",
      "The vocabulary problem is handled by keeping both halves. The practitioner's term is the record; the standard term is an index entry pointing at it. Searching for the standard term finds the record, and reading the record still shows the word the workshop said, with its language marked. Collapsing the first into the second would make the archive searchable and would delete the finding.",
      "Pattern is the hardest thing to describe and the most rewarding when it works, because much of it is generative rather than pictorial. A kolam is produced by a rule applied around a grid of dots, and it has been studied by computer scientists as a formal grammar for exactly that reason. A double ikat has to be resolved thread by thread on warp and weft before a single one is woven, which makes its pattern a set of instructions as much as a picture. Notation that records the rule, and not only the finished image, is worth a great deal to anybody trying to understand the practice rather than admire it.",
      "Imaging is chosen for what it has to answer. Raking light for surface texture, colour targets in every frame so that a dye recorded this year can be compared with the same dye recorded in ten, photogrammetry where three-dimensional form carries the information. Formats are chosen for longevity over convenience, and the migration plan is written before the first file is deposited rather than after the first format is orphaned.",
      "Finally, not everything that can be published should be. Access controls in the catalogue exist to honour the terms recorded in the field, and the default for anything not explicitly cleared is that it is held and not shown."
    ],
    icon: "Database",
    sortOrder: 6,
    photo: "kolam"
  }
];

/**
 * Twenty-four people. Departments deliberately reuse the research-area titles, so a reader landing
 * on an area page and a reader landing on the directory arrive at the same set of names.
 *
 * ⚠ EVERY NAME IS INVENTED. See the header. No `photo`, no `orcid`, no `googleScholar`, no
 * telephone number on any record in this list, and none should be added.
 */
export const PEOPLE: SeedPerson[] = [
  // ── Directorate and faculty ──────────────────────────────────────────────────────────────────
  {
    slug: "meera-ranganathan",
    name: "Meera Ranganathan",
    kind: "FACULTY",
    designation: "Director and Professor of Historical Textiles",
    department: "Directorate",
    bio: "Ranganathan came to craft research from museum cataloguing — ten years of writing accession cards for trade textiles that had travelled a great deal further than the people who made them, and a slowly hardening conviction that the cards described objects while saying almost nothing about practices. Her own work is on resist-dyed and double-ikat cloth from western India and its long export history, and on the narrower question of what a catalogue entry must contain for a technique to be reconstructable from the record alone. She has led the Centre since it opened and still keeps one week of fieldwork in every term, on the grounds that a director who has stopped going is a director being told what she wants to hear.",
    email: "m.ranganathan@cxa.example",
    researchInterests: [
      "double ikat",
      "resist dyeing",
      "trade textiles",
      "catalogue description",
      "patola",
      "archival method"
    ],
    sortOrder: 1
  },
  {
    slug: "faiz-ahmad-ansari",
    name: "Faiz Ahmad Ansari",
    kind: "FACULTY",
    designation: "Professor of Material Culture; Head of Materials and Technique",
    department: "Materials and Technique",
    bio: "Ansari trained as a metallurgist and spent his first working years on industrial corrosion before a conservation report sent him in another direction: it described the black surface of a bidri vessel as a patina, as though it were an accident of age. He went to Bidar, found that the black is deliberately induced and that the soil used to produce it is fetched from inside the fort, and has been working on the metalwork traditions of the Deccan ever since. He runs the Centre's alloy and surface analysis programme, and teaches a seminar whose first exercise is to take a widely repeated claim about a craft and establish whether anybody has ever tested it.",
    email: "f.ansari@cxa.example",
    researchInterests: [
      "bidriware",
      "zinc alloys",
      "metal inlay",
      "surface treatments",
      "corrosion",
      "elemental analysis"
    ],
    sortOrder: 2
  },
  {
    slug: "anjali-deshmukh",
    name: "Anjali Deshmukh",
    kind: "FACULTY",
    designation: "Professor of Conservation Science",
    department: "Conservation Science",
    bio: "Deshmukh trained in paper and textile conservation and has spent most of her career on deterioration mechanisms rather than treatment — in particular on iron-mordanted blacks, which go on attacking the cloth beneath them long after the painting is finished, so that the drawn line is often the first part of a piece to fail. She argues, at length and to anyone who will sit still, that documentation must precede treatment, because a treatment removes the dirt, the old repair and the pattern of wear, and those three things are the object's record of having been used. She convenes the Centre's storage and light-budget review.",
    email: "a.deshmukh@cxa.example",
    researchInterests: [
      "textile conservation",
      "iron mordants",
      "preventive conservation",
      "light damage",
      "storage environments",
      "condition reporting"
    ],
    sortOrder: 3
  },
  {
    slug: "nabanita-saikia",
    name: "Nabanita Saikia",
    kind: "FACULTY",
    designation: "Associate Professor of Craft Economics",
    department: "Livelihoods and Markets",
    bio: "Saikia is an economist who came to craft through a household survey in a weaving town where the reported incomes made no sense until she stopped asking who the weaver was and started asking who else in the house had worked that week. The answer — that the spinning, warping and finishing were being done by women whose hours nobody was counting — has shaped everything she has done since. She works on piece rates, on the household as the true unit of production, and on geographical indications, where her interest is less in obtaining a registration than in what a cluster is actually able to do with one afterwards.",
    email: "n.saikia@cxa.example",
    researchInterests: [
      "piece rates",
      "household labour",
      "geographical indications",
      "handloom economics",
      "market access",
      "cluster surveys"
    ],
    sortOrder: 4
  },
  {
    slug: "jacob-mathai",
    name: "Jacob Mathai",
    kind: "FACULTY",
    designation: "Professor of Craft Pedagogy",
    department: "Transmission and Pedagogy",
    bio: "Mathai taught in a design school for eleven years and watched a succession of intelligent students complete a three-week craft module, produce a portfolio piece and leave believing they had learnt something a workshop takes six years to teach. He now studies apprenticeship as a curriculum in its own right: what is taught first, what is withheld until the learner is ready, how correction is given when it is given by hand, and where the point of graduation actually falls. He is unsentimental about it — he holds that a good deal of craft teaching is genuinely inefficient and could be improved, and that knowing which parts cannot be shortened is the only way to tell.",
    email: "j.mathai@cxa.example",
    researchInterests: [
      "apprenticeship",
      "tacit skill",
      "curriculum design",
      "workshop teaching",
      "assessment",
      "craft education policy"
    ],
    sortOrder: 5
  },
  {
    slug: "harpreet-kaur-sandhu",
    name: "Harpreet Kaur Sandhu",
    kind: "FACULTY",
    designation: "Associate Professor of Digital Humanities; Head of Digital Archives",
    department: "Digital Archives",
    bio: "Sandhu built the Centre's catalogue and continues to be responsible for it, which she describes as the difference between designing a schema and living in one. She came from library systems, and brought with her a rule the archive now runs on: the practitioner's term is the record and the standard vocabulary is only an index pointing at it, so that a search finds the entry without the entry losing the word the workshop actually said. Her current work is on notation for generative pattern — recording the rule that produces a design rather than only the design — and on the unfashionable question of whether the files deposited this year will still open in thirty.",
    email: "h.sandhu@cxa.example",
    researchInterests: [
      "controlled vocabulary",
      "linked data",
      "pattern notation",
      "digital preservation",
      "catalogue design",
      "search"
    ],
    sortOrder: 6
  },

  // ── Laboratories ─────────────────────────────────────────────────────────────────────────────
  {
    slug: "sudeshna-pal",
    name: "Sudeshna Pal",
    kind: "SCIENTIST",
    designation: "Senior Scientist, Textile and Dye Laboratory",
    department: "Materials and Technique",
    bio: "Pal runs the dye and fibre laboratory, where most of the questions that arrive amount to one of two things: what is this made of, and is this colour the plant it is claimed to be. Separating a natural indigo from the synthetic that displaced it is routine work by chromatography; establishing when the changeover happened in a particular workshop is not, and that is the part she finds worth doing. She wrote the laboratory's sampling protocol, which takes the smallest sample that can answer the question asked and declines the job outright when no sample that small would answer it — a rule that has cost the Centre several commissions and has never yet been overruled.",
    email: "s.pal@cxa.example",
    researchInterests: [
      "dye analysis",
      "natural indigo",
      "fibre identification",
      "mordants",
      "chromatography",
      "sampling protocols"
    ],
    sortOrder: 10
  },
  {
    slug: "girish-kamath",
    name: "Girish Kamath",
    kind: "SCIENTIST",
    designation: "Scientist, Metals and Alloys",
    department: "Materials and Technique",
    bio: "Kamath works on cast metal, and principally on the lost-wax traditions of central and eastern India, where each mould is broken to release the object inside it so that no two castings are ever identical. His standing point is that the alloy in a dhokra piece cannot be assumed, because the metal going into the crucible is scrap of whatever composition the week's buying produced; the only honest thing to do is measure it, casting by casting, and then ask what the variation does to the surface and the sound. He also maintains the Centre's reference collection of failed castings, which he considers the more instructive half of the collection.",
    email: "g.kamath@cxa.example",
    researchInterests: [
      "lost-wax casting",
      "dhokra",
      "bell metal",
      "alloy composition",
      "foundry practice",
      "casting defects"
    ],
    sortOrder: 11
  },
  {
    slug: "rohit-vaghela",
    name: "Rohit Vaghela",
    kind: "SCIENTIST",
    designation: "Scientist, Ceramics and Earth Materials",
    department: "Materials and Technique",
    bio: "Vaghela's subject is what potters call the body — the mixture that is formed and fired — and his favourite example is the blue pottery of Jaipur, whose body contains no clay at all but is built from ground quartz held together with gum and fired at a low temperature. The consequence is a ware that is brittle, cannot be thrown in the ordinary way and has a repertoire of forms determined almost entirely by that constraint, which is as clear a case as he knows of a material writing a craft's vocabulary. He measures firing temperatures in working kilns, which mostly means persuading people to let him put a probe somewhere inconvenient.",
    email: "r.vaghela@cxa.example",
    researchInterests: [
      "clay bodies",
      "glaze chemistry",
      "blue pottery",
      "kiln temperature",
      "terracotta",
      "firing faults"
    ],
    sortOrder: 12
  },

  // ── Professional staff. The half of the Centre that makes the other half possible. ───────────
  {
    slug: "vaishali-rane",
    name: "Vaishali Rane",
    kind: "STAFF",
    designation: "Conservator, Objects and Metals",
    department: "Conservation Science",
    bio: "Rane treats the Centre's reference collection and the objects lent to it, and she is the person who decides, in practice, how far an intervention goes. Her working distinction is between an object that has stopped being used and a tool that has not: a printing block still in weekly service has to remain usable, is expected to wear, and carries in its uneven wear a record of how it was held and what was printed most often, none of which survives being stabilised into a museum piece. Where a block genuinely cannot go on, she has it recorded and copied so the workshop keeps a working tool and the archive keeps the original.",
    email: "v.rane@cxa.example",
    researchInterests: [
      "objects conservation",
      "printing blocks",
      "minimal intervention",
      "metal cleaning",
      "condition reporting",
      "working tools"
    ],
    sortOrder: 20
  },
  {
    slug: "devendra-pathak",
    name: "Devendra Pathak",
    kind: "STAFF",
    designation: "Head of Archives",
    department: "Archives",
    bio: "Pathak is responsible for accessioning, and for the part of the archive nobody sees: the consent files. Every record that enters the collection carries who made it, when, with whom present, and on what terms it may be published, studied or withheld, and he will refuse an accession that arrives without them however good the material is. He also runs the withdrawal procedure — the route by which a community that recorded something ten years ago can have it taken down — and takes the view that an archive without a working way out is one that people are right not to trust with anything important.",
    email: "d.pathak@cxa.example",
    researchInterests: [
      "archival description",
      "consent and access",
      "provenance",
      "oral history collections",
      "records management",
      "accessioning"
    ],
    sortOrder: 21
  },
  {
    slug: "arjun-thapa",
    name: "Arjun Thapa",
    kind: "STAFF",
    designation: "Documentation Photographer",
    department: "Field Documentation",
    bio: "Thapa photographs process rather than product, which in practice means long sequences at fixed intervals over several days and a great deal of waiting for the interesting four minutes. He puts a colour target in every frame so that a dye recorded this season can be compared honestly with the same dye recorded in ten years' time, and he uses raking light for anything where surface texture is the information — a weave structure, a tool mark, the depth of an impression. He is firm that the best photograph of a workshop is often the one that shows the mess, and has lost several arguments about it with people preparing exhibition material.",
    email: "a.thapa@cxa.example",
    researchInterests: [
      "process photography",
      "colour management",
      "raking light",
      "photogrammetry",
      "field recording",
      "image metadata"
    ],
    sortOrder: 22
  },
  {
    slug: "mahendra-solanki",
    name: "Mahendra Solanki",
    kind: "STAFF",
    designation: "Field Coordinator, Western India",
    department: "Field Documentation",
    bio: "Solanki arranges the fieldwork in the western clusters and knows, in a way no calendar records, which weeks a workshop cannot receive visitors because the orders are due or the family is occupied elsewhere. He translates, he makes the introductions, and he is most often the person who has to tell a research team that the answer is no — a function he regards as the useful part of the job rather than an obstruction of it. Several of the Centre's longest working relationships exist because he spent two years visiting a workshop without asking it for anything.",
    email: "m.solanki@cxa.example",
    researchInterests: [
      "fieldwork logistics",
      "community liaison",
      "consent processes",
      "block printing",
      "Kachchh",
      "interpreting"
    ],
    sortOrder: 23
  },
  {
    slug: "kavitha-reddy",
    name: "Kavitha Reddy",
    kind: "STAFF",
    designation: "Administrative Officer",
    department: "Administration",
    bio: "Reddy handles budgets, contracts, procurement and the fellowship payments, and made one change on arriving that has done more for the practitioner fellowship than any amount of publicity: fellows are paid on the day, in advance where travel is involved, rather than reimbursed at the end of the month. A reimbursement cycle, she pointed out at the meeting where this was decided, is a filter that quietly removes precisely the people the fellowship exists to bring in. She also keeps the register of agreements with workshops, so that anybody can find out in a minute what the Centre has promised whom.",
    email: "k.reddy@cxa.example",
    researchInterests: [
      "research administration",
      "fellowship schemes",
      "practitioner payments",
      "contracts",
      "procurement",
      "agreements with workshops"
    ],
    sortOrder: 24
  },

  // ── Research assistants ──────────────────────────────────────────────────────────────────────
  {
    slug: "farida-shaikh",
    name: "Farida Shaikh",
    kind: "RESEARCH_ASSISTANT",
    designation: "Research Assistant, Field Documentation",
    department: "Field Documentation",
    bio: "Shaikh compiles the workshop glossaries: the names of tools, stages, motifs and — the part she has come to think is the most valuable — faults, recorded in the language they are spoken in before anybody attempts a translation. The work turned into a research interest when she found a Lucknow embroidery workshop using four distinct words for what the standard term list treats as a single defect, each one implying a different cause and a different remedy. She now writes on the cost of premature standardisation, and on how to build an index that finds a record without flattening the words inside it.",
    email: "f.shaikh@cxa.example",
    researchInterests: [
      "craft vocabulary",
      "chikankari",
      "interview method",
      "glossaries",
      "oral history",
      "controlled vocabulary"
    ],
    sortOrder: 30
  },
  {
    slug: "abhilash-nayak",
    name: "Abhilash Nayak",
    kind: "RESEARCH_ASSISTANT",
    designation: "Research Assistant, Eastern India Field Station",
    department: "Field Documentation",
    bio: "Nayak works out of the Centre's Odisha station on pattachitra and on the region's wood carving. His running argument is that the documentation of a painting tradition tends to start at the wrong point: the cloth for a pattachitra is prepared over several days with tamarind-seed paste and chalk, burnished until it will take a fine line, and that preparation takes longer and determines more than the painting does, yet it is what every photographer skips. He has been recording the preparation stages in sequence for three years and is assembling the first properly timed account of them.",
    email: "a.nayak@cxa.example",
    researchInterests: [
      "pattachitra",
      "ground preparation",
      "mineral pigments",
      "wood carving",
      "process documentation",
      "Odisha"
    ],
    sortOrder: 31
  },
  {
    slug: "priyanka-meshram",
    name: "Priyanka Meshram",
    kind: "RESEARCH_ASSISTANT",
    designation: "Research Assistant, Painting and Wall Practices",
    department: "Transmission and Pedagogy",
    bio: "Meshram works in Palghar district on Warli painting, and on the specific question of what changes when a wall practice moves onto paper and canvas for sale. Her finding so far is a careful one: the visual grammar transfers almost intact — the circles, triangles and lines, and the rules about what may be placed next to what — while the occasion does not, so that a form which existed for particular moments in a household's year becomes something produced continuously to order. She is interested in how painters themselves describe that shift, which is rarely as a loss and rarely as a straightforward gain.",
    email: "p.meshram@cxa.example",
    researchInterests: [
      "Warli painting",
      "wall practices",
      "ritual occasion",
      "commercial transfer",
      "rice paste",
      "apprenticeship"
    ],
    sortOrder: 32
  },

  // ── Doctoral students ────────────────────────────────────────────────────────────────────────
  {
    slug: "ananya-bhatt",
    name: "Ananya Bhatt",
    kind: "STUDENT",
    designation: "Doctoral candidate, Materials and Technique",
    department: "Materials and Technique",
    bio: "Bhatt came from environmental engineering and is writing on water. Resist printing in natural dyes is built up over many passes of printing, washing and drying, and each of those washes needs clean water and somewhere for the used water to go; in several printing towns both of those are now the binding constraint on how the craft is practised, ahead of skill, market or materials. She is measuring consumption per metre across workshops that use different sequences, and looking at what the practice has already quietly changed in order to use less.",
    email: "a.bhatt@cxa.example",
    researchInterests: [
      "natural dyes",
      "block printing",
      "indigo",
      "water use",
      "effluent",
      "washing sequences"
    ],
    sortOrder: 40
  },
  {
    slug: "karthik-selvaraj",
    name: "Karthik Selvaraj",
    kind: "STUDENT",
    designation: "Doctoral candidate, Digital Archives",
    department: "Digital Archives",
    bio: "Selvaraj grew up watching a kolam drawn on the threshold every morning and did not think of it as a subject until a lecture on picture grammars, in which the same drawings turned up as an example of a formal language. His thesis is a notation for recording such a figure as the rule that generates it around its grid of dots, rather than as an image of the result, so that two kolams can be compared by their construction and a variant can be described as a change to a rule. He is unusually careful about what the notation leaves out, and keeps a list of it.",
    email: "k.selvaraj@cxa.example",
    researchInterests: [
      "kolam",
      "formal grammars",
      "pattern notation",
      "generative description",
      "computational documentation",
      "linked data"
    ],
    sortOrder: 41
  },
  {
    slug: "sneha-toppo",
    name: "Sneha Toppo",
    kind: "STUDENT",
    designation: "Doctoral candidate, Livelihoods and Markets",
    department: "Livelihoods and Markets",
    bio: "Toppo studies the economics of lost-wax casting households in central India: who owns the furnace, who buys the scrap metal that becomes the alloy, who does the wax work, and how the proceeds of a firing are divided when a single firing represents several people's fortnight. Her first result was a methodological one — that the unit which makes sense of the accounts is the household rather than the caster named on the invoice — and it has since made her sceptical of every income figure for the craft that has been published, including the ones she started out relying on.",
    email: "s.toppo@cxa.example",
    researchInterests: [
      "lost-wax casting",
      "household economics",
      "scrap metal supply",
      "cooperatives",
      "piece rates",
      "bell metal"
    ],
    sortOrder: 42
  },

  // ── Visitors ─────────────────────────────────────────────────────────────────────────────────
  {
    slug: "heena-rathod",
    name: "Heena Rathod",
    kind: "VISITOR",
    designation: "Practitioner Fellow, Natural Dyeing and Resist Printing",
    department: "Materials and Technique",
    bio: "Rathod is a dyer and printer working in resist-printed cotton, in residence for two terms under the practitioner fellowship. She keeps the teaching vat in the dye studio, which means the students discover that an indigo vat is a fermentation that has to be fed and watched rather than a bucket of colour, and that it will punish a long weekend. Her contribution to the Centre's seminar has been a blunt one and has stuck: a dye recipe recorded without the water it was made with is not a recipe, because the water is an ingredient and it is different in every town.",
    email: "h.rathod@cxa.example",
    researchInterests: [
      "indigo vat",
      "resist printing",
      "madder",
      "mud resist",
      "water chemistry",
      "natural dyes"
    ],
    sortOrder: 50
  },
  {
    slug: "vivek-hegde",
    name: "Vivek Hegde",
    kind: "VISITOR",
    designation: "Visiting Fellow, Museum Documentation",
    department: "Digital Archives",
    bio: "Hegde is a curator on secondment from a regional museum, spending a year on the reconciliation problem that both institutions have and neither can solve alone: a museum accession vocabulary written to describe objects, and an archive of practitioner terms written to describe processes, which cover much of the same ground in mutually unintelligible words. He is producing a mapping between them that records where the two genuinely disagree instead of forcing a match, and he is more interested in the disagreements than in the mapping.",
    email: "v.hegde@cxa.example",
    researchInterests: [
      "museum cataloguing",
      "controlled vocabulary",
      "accession records",
      "provenance",
      "loans and display",
      "catalogue description"
    ],
    sortOrder: 51
  },

  // ── Alumni ───────────────────────────────────────────────────────────────────────────────────
  {
    slug: "aarti-lokhande",
    name: "Aarti Lokhande",
    kind: "ALUMNUS",
    designation: "Alumna, doctoral programme in craft economics",
    department: "Livelihoods and Markets",
    bio: "Lokhande's thesis was on cluster-level cooperative purchasing of yarn — the unromantic finding that a group of weavers buying together at the right moment in the season kept more of their earnings than any of the design interventions being tried in the same district at the same time. She now works on procurement policy at a state handloom development body and returns for one teaching week a year, which she uses to tell doctoral students that the interesting question is usually the one about the invoice.",
    email: "a.lokhande@cxa.example",
    researchInterests: [
      "yarn procurement",
      "cooperatives",
      "handloom policy",
      "cluster development",
      "piece rates",
      "market access"
    ],
    sortOrder: 60
  },
  {
    slug: "tanmay-ghosh",
    name: "Tanmay Ghosh",
    kind: "ALUMNUS",
    designation: "Alumnus, master's programme in documentation",
    department: "Field Documentation",
    bio: "Ghosh shot the Centre's first process films, including the long sequence on terracotta panel making that is still the most-consulted item in the moving-image collection. He now records workshops on commission for museums and cultural bodies, and continues to deposit a copy of everything with the archive under the consent terms it was originally recorded on — an arrangement he negotiated himself as a student and which the Centre has since made standard for external work.",
    email: "t.ghosh@cxa.example",
    researchInterests: [
      "process film",
      "field photography",
      "archival deposit",
      "consent",
      "terracotta",
      "moving image"
    ],
    sortOrder: 61
  }
];
