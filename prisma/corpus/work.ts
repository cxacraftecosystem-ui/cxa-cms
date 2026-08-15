/**
 * THE WORK — the Centre's projects and its publications.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IS IN HERE. Fourteen research projects across all four `ProjectStatus` values, and thirty
 * publications across nine of the ten `PublicationKind` values — every one but `PATENT`, which a
 * centre that publishes other people's techniques openly has no business holding. Between them they are
 * what the Projects screen, the Publications screen, the research-area pages, every researcher's
 * profile and the "recent work" showcases on the homepage all read from. Empty, those surfaces each
 * say plainly that they have nothing — correctly, and uselessly.
 *
 * WHERE THE FACTS COME FROM, AND WHERE THEY STOP.
 *
 *   • THE CRAFTS ARE REAL and are described only as far as I could describe them accurately: the
 *     region, the material, the technique, the rough period. Ajrakh really is a resist-and-mordant
 *     print worked on both faces of the cloth in register; bidri really is a zinc-rich alloy
 *     blackened with a paste made from soil; a patola really is resolved in the dye on both warp
 *     and weft before a single pick is woven. Where I was unsure of a detail — a local-language
 *     term, which community holds a practice, an exact date — IT IS NOT HERE. A short entry is
 *     better than a confident wrong sentence about somebody else's craft on an institutional site.
 *
 *   • ⚠ THE CENTRE, ITS STAFF, ITS FUNDERS AND EVERY ONE OF THESE STUDIES ARE FICTIONAL. No real
 *     researcher, artisan or academic is named. No real journal is named as having published any of
 *     this. No real trust, ministry or council is named as having paid for any of it.
 *
 *   • ⚠ DOIs. Where a DOI appears at all it is under `10.5555/`, the reserved test prefix, which
 *     resolves to nothing anywhere. A real DOI here would attach a real, findable piece of somebody
 *     else's scholarship to a study that does not exist.
 *
 *   • ⚠ FUNDERS ARE INVENTED, and deliberately invented in plain English rather than in a
 *     plausible Indian institutional register — "The Ninth Loom Trust" cannot be mistaken for a
 *     body that exists, whereas a well-formed Sanskrit-rooted foundation name very easily can be.
 *     `Centre research fund (internal allocation)` is used where a project is unfunded, which is
 *     also the honest shape for a pilot and a proposal.
 *
 * JUDGEMENT CALLS.
 *
 *   1. **`progress` is derived from the state, not from the calendar.** COMPLETED is 100 and
 *      PROPOSED is 0 without exception; ON_HOLD sits partway and does not move. The ACTIVE figures
 *      are deliberately NOT a straight percentage of elapsed time — fieldwork front-loads and
 *      analysis back-loads — but none of them is far enough off its dates to read as a mistake.
 *
 *   2. **ON_HOLD projects have no `endedOn`.** A paused project with an end date on the card reads
 *      as a project that quietly finished. The body paragraph says why it stopped instead, in the
 *      plain terms an institution would actually use: a tranche not renewed, a permission not yet
 *      granted.
 *
 *   3. **Not every publication has a DOI, a volume or an abstract.** A corpus in which every record
 *      is complete is a corpus that never exercises the "field is missing" path in the citation
 *      renderer — and datasets, software and theses genuinely do not have issue numbers.
 *
 * ⚠ SLUGS THIS MODULE ONLY REFERENCES, AND WHICH ARE RECONCILED AGAINST `people.ts`. It defines
 * project and publication slugs; it POINTS at research areas and people that `people.ts` defines.
 * Every `researchArea`, every `members[].person` and every entry in every `authors` array below has
 * been checked against that file and resolves to a record in it. THEY MUST STAY THAT WAY. The six
 * area slugs, in full, are:
 *
 *   `material-science`, `field-documentation`, `livelihoods-and-markets`,
 *   `transmission-and-pedagogy`, `conservation-science`, `digital-archives`
 *
 * ⚠ AND `authorLine` MUST NAME THE SAME PEOPLE AS `authors`, in the same order. The line is what a
 * reader is shown as the citation; the slugs are what the "their publications" list is built from.
 * When the two disagree, one page states an authorship that the other silently contradicts.
 *
 * `seedCorpus()` reports any slug that resolves to nothing, by name, so a mismatch surfaces as a
 * line in the seed log rather than as a project with no team on it.
 *
 * ⚠ PHOTOGRAPHS ARE CRAFT-MANIFEST SLUGS from lib/media/craft-imagery.ts and nothing else. Each
 * project's cover is a photograph of the craft it studies, not a decorative stand-in.
 */

import type { SeedProject, SeedPublication } from "./types";

// ════════════════════════════════════════════════════════════════════════════════════════════════
// PROJECTS
// ════════════════════════════════════════════════════════════════════════════════════════════════

export const PROJECTS: SeedProject[] = [
  {
    slug: "kachchh-ajrakh-process-survey",
    title: "The Kachchh ajrakh survey",
    tagline: "Recording a resist print stage by stage, in the workshops that still work it",
    summary:
      "A process-level record of ajrakh printing in Kachchh: every washing, resist, mordant and dye stage as it is actually worked today, timed and photographed in eleven workshops. The survey is building the reference against which later change can be measured.",
    bodyParagraphs: [
      "Ajrakh is a resist-and-mordant block print on cotton, worked in Kachchh in Gujarat, in Barmer in Rajasthan, and across the border in Sindh. Its distinguishing difficulty is that the finest cloths are printed on both faces in register, so that the pattern reads identically from either side — which means every subsequent stage has to be repeated twice without the two sets of impressions drifting apart.",
      "The sequence is long. The cloth is washed and steeped before anything is printed on it; a resist of lime and gum keeps the ground white; a printed mordant decides where the madder will take; the whole piece goes into an indigo vat, which colours only what no resist protects. Between stages the cloth is washed again, and the washing is not incidental — it is what removes the loosely bound colour that would otherwise dull every shade printed after it.",
      "The survey records each stage as a timed observation with the recipe as the printer states it, the temperature and the water source, rather than as a generalised description of 'the ajrakh process'. Workshops differ, and a survey that averages them away produces a process nobody works.",
      "Water is the constraint that shapes everything else here. Printing at this scale needs a great deal of it and needs it low in dissolved salts, and the relocation of printing families after the 2001 earthquake was in part a move towards a better supply. The survey logs source and consumption at every site for that reason."
    ],
    state: "ACTIVE",
    researchArea: "field-documentation",
    fundingBody: "The Ninth Loom Trust",
    fundingAmount: "62,00,000",
    fundingCurrency: "INR",
    startedOn: "2024-09-02",
    endedOn: "2027-03-31",
    progress: 60,
    photo: "block-print",
    isFeatured: true,
    members: [
      { person: "meera-ranganathan", role: "Principal investigator", isLead: true },
      { person: "mahendra-solanki", role: "Field coordinator" },
      { person: "tanmay-ghosh", role: "Process documentation" },
      { person: "arjun-thapa", role: "Photographer and imaging lead" },
      { person: "ananya-bhatt", role: "Research assistant" }
    ],
    milestones: [
      {
        title: "Workshop consent and participation agreed",
        detail: "Eleven workshops, each with a signed agreement covering how the record may be published and reused.",
        dueOn: "2024-11-29",
        isComplete: true
      },
      {
        title: "First full printing cycle recorded end to end",
        detail: "One cloth followed from first steeping to final wash, over nine weeks.",
        dueOn: "2025-04-18",
        isComplete: true
      },
      {
        title: "Water sampling at all eleven sites",
        dueOn: "2025-11-14",
        isComplete: true
      },
      {
        title: "Stage-by-stage record published to the archive",
        detail: "Timed observations, recipes as stated, and paired photographs of both faces.",
        dueOn: "2026-10-30",
        isComplete: false
      },
      {
        title: "Final report and printer review sessions",
        detail: "The draft goes back to each workshop before it goes anywhere else.",
        dueOn: "2027-02-27",
        isComplete: false
      }
    ]
  },

  {
    slug: "mordant-and-lightfastness",
    title: "Mordant, iron and light",
    tagline: "Six recipes, one accelerated-ageing rig, and a straight answer about fading",
    summary:
      "A controlled comparison of six mordant recipes used with madder and myrobalan on handspun cotton, tested for light-fastness and wash-fastness under accelerated ageing. The question behind it is one dyers are asked constantly and cannot currently answer with numbers.",
    bodyParagraphs: [
      "A mordant is what binds a dye to a fibre, and it does more than fix colour: it changes it. Madder on an alum mordant gives a red; the same madder over an iron mordant gives a brown-purple to near-black. Myrobalan, a tannin used across several printing traditions as a pre-treatment, leaves its own yellowish cast on the ground before any dye is applied at all.",
      "Practitioners know this thoroughly. What is genuinely not established is how the resulting colours behave over decades of ordinary domestic use — light through a window, repeated washing, a folded crease that never sees the sun. Buyers ask; the honest present answer is an impression rather than a measurement.",
      "The study dyes a standard handspun cotton with six recipes collected from working dyers, then splits every sample three ways: one held dark as a control, one under accelerated light exposure, one through a repeated wash cycle. Colour change is measured instrumentally at fixed intervals rather than judged by eye.",
      "The recipes are recorded as given and credited to the dyer who gave them, and no recipe enters the study without that dyer agreeing to its publication."
    ],
    state: "ACTIVE",
    researchArea: "material-science",
    fundingBody: "Vermilion Trust for Material Culture",
    fundingAmount: "41,50,000",
    fundingCurrency: "INR",
    startedOn: "2025-06-16",
    endedOn: "2027-06-30",
    progress: 45,
    photo: "kalamkari",
    members: [
      { person: "sudeshna-pal", role: "Principal investigator", isLead: true },
      { person: "anjali-deshmukh", role: "Analytical chemist" },
      { person: "heena-rathod", role: "Dye recipe collection and dyer liaison" },
      { person: "ananya-bhatt", role: "Laboratory technician" }
    ],
    milestones: [
      {
        title: "Recipes collected and agreed for publication",
        detail: "Six recipes from five dyers, each reviewed with its author.",
        dueOn: "2025-10-10",
        isComplete: true
      },
      {
        title: "Reference sample set dyed and catalogued",
        dueOn: "2026-02-20",
        isComplete: true
      },
      {
        title: "Light exposure run complete at 1,000 hours",
        dueOn: "2026-11-27",
        isComplete: false
      },
      {
        title: "Wash-fastness series complete",
        dueOn: "2027-03-19",
        isComplete: false
      },
      {
        title: "Dataset and plain-language summary for dyers released",
        detail: "The summary is the deliverable that matters to the people who supplied the recipes.",
        dueOn: "2027-06-12",
        isComplete: false
      }
    ]
  },

  {
    slug: "bidriware-alloy-and-patina",
    title: "The blackening of bidri",
    tagline: "What the soil of Bidar actually does to a zinc alloy",
    summary:
      "An analytical study of forty-one bidriware objects and eleven newly worked test pieces, examining the composition of the alloy, the silver inlay, and the patina produced by the traditional soil paste. Completed in 2024; the dataset and the analytical report are both open.",
    bodyParagraphs: [
      "Bidriware is made at Bidar in Karnataka. The body is a zinc-rich alloy with a small proportion of copper, cast, turned and engraved, then inlaid with silver wire or sheet hammered into the cut channels. The finished object is finally blackened — and it is the blackening that produces the effect the craft is known for, because the treatment darkens the alloy deeply while leaving the silver bright.",
      "That final treatment uses a paste made with soil taken from the Bidar fort site. This is not folklore attached to the craft after the fact; the earth is genuinely part of the process, and craftsmen have long held that soil from elsewhere does not work as well. The usual explanation is that salts in that particular earth drive the reaction with the zinc. Nobody had put a reasonable sample of it through analysis.",
      "The study characterised alloy composition across forty-one objects held in two collections, analysed the patina layer non-destructively where the object's condition required it, and ran a set of controlled blackening trials on newly cast test pieces using soil from four locations. It also recorded what practising bidri workers say about the paste, because a technical result that contradicts the practitioners without engaging them is a result that will not be used.",
      "The project closed in November 2024. Its measurements are published as a dataset so that a conservator treating a bidri object elsewhere has a compositional range to work from rather than a single published figure."
    ],
    state: "COMPLETED",
    researchArea: "material-science",
    fundingBody: "Anvil and Ash Foundation",
    fundingAmount: "38,00,000",
    fundingCurrency: "INR",
    startedOn: "2023-01-16",
    endedOn: "2024-11-29",
    progress: 100,
    photo: "bidriware",
    isFeatured: true,
    members: [
      { person: "faiz-ahmad-ansari", role: "Principal investigator", isLead: true },
      { person: "vaishali-rane", role: "Conservation scientist" },
      { person: "girish-kamath", role: "Metallurgical analysis" },
      { person: "rohit-vaghela", role: "Analytical chemist" },
      { person: "vivek-hegde", role: "Collections liaison" }
    ],
    milestones: [
      { title: "Object survey agreed with both lending collections", dueOn: "2023-04-21", isComplete: true },
      { title: "Alloy composition series complete", dueOn: "2023-12-15", isComplete: true },
      { title: "Controlled blackening trials on cast test pieces", dueOn: "2024-05-24", isComplete: true },
      { title: "Dataset published", dueOn: "2024-09-13", isComplete: true },
      { title: "Final analytical report issued", dueOn: "2024-11-29", isComplete: true }
    ]
  },

  {
    slug: "mithila-painters-oral-history",
    title: "Mithila painters: an oral history",
    tagline: "Sixty long interviews with the generation that took the painting off the wall",
    summary:
      "A recorded oral history with painters across the Mithila region of Bihar, centred on the shift from wall and floor painting to work on paper, and on how the craft was learnt within households. Interviews are conducted in the speaker's own language and archived with their transcripts.",
    bodyParagraphs: [
      "Madhubani or Mithila painting was, for most of its history, painting on surfaces that were not meant to last: the plastered walls of a house, the floor of a room prepared for a wedding. Work on paper became widespread from the 1960s, when it was taken up as a source of income during a period of severe drought, and that change is within living memory of people still painting.",
      "This programme records that memory before it is only second-hand. Sixty interviews of two to four hours each, conducted where the painter works, covering how they learnt, from whom, what was painted where in the house, what changed when the surface became paper and a market appeared, and what they think has been lost and gained.",
      "Interviews are conducted and archived in the language they were given in, with a transcript and an English summary. The recording is the record; the translation is a finding aid. Speakers hold a veto over publication of any passage, exercisable at any time, and three have used it.",
      "The programme deliberately includes painters who are not well known and painters who have stopped. A history assembled only from the people a market has already selected is a history of the market."
    ],
    state: "ACTIVE",
    researchArea: "field-documentation",
    fundingBody: "The Long Table Fund",
    fundingAmount: "29,00,000",
    fundingCurrency: "INR",
    startedOn: "2025-11-03",
    endedOn: "2027-10-29",
    progress: 35,
    photo: "madhubani",
    members: [
      { person: "jacob-mathai", role: "Principal investigator", isLead: true },
      { person: "abhilash-nayak", role: "Field coordinator" },
      { person: "farida-shaikh", role: "Interviewer and translator" },
      { person: "devendra-pathak", role: "Archivist" }
    ],
    milestones: [
      {
        title: "Interview protocol and consent process agreed",
        detail: "Including the withdrawal clause, which is explained aloud before recording begins.",
        dueOn: "2026-01-30",
        isComplete: true
      },
      { title: "First twenty interviews recorded", dueOn: "2026-06-26", isComplete: true },
      { title: "Sixty interviews recorded", dueOn: "2027-03-26", isComplete: false },
      { title: "Transcripts and summaries deposited", dueOn: "2027-08-27", isComplete: false },
      { title: "Listening sessions held in three districts", dueOn: "2027-10-15", isComplete: false }
    ]
  },

  {
    slug: "channapatna-lathe-school",
    title: "The Channapatna lathe pilot",
    tagline: "A two-year teaching partnership inside a working cluster, not a workshop about one",
    summary:
      "A pedagogy pilot run with turners in the Channapatna cluster in Karnataka, testing whether a structured apprenticeship with paid learning time recruits and keeps young turners better than short-course training does. Twenty-two learners across two cohorts.",
    bodyParagraphs: [
      "Channapatna makes lacquered turned toys and objects from a soft pale wood, Wrightia tinctoria, shaped on a lathe and coloured by pressing a stick of lacquer against the spinning piece so that friction melts it onto the surface. The finish is applied and polished in the same operation as the turning, which is why it cannot be taught out of sequence.",
      "The prevailing model for craft training is a short residential course. It produces certificates reliably and working turners rarely, because the part that takes time is not the knowledge but the hand. This pilot tests the alternative: eighteen months inside a working unit, with the learner paid for learning time and the master paid for teaching time, against an agreed set of competences rather than an attendance record.",
      "Two cohorts, twenty-two learners, with retention measured at six, twelve and twenty-four months after the placement ends — the last of which is the only figure that answers the question actually being asked. Cohort one has passed its twelve-month point.",
      "The comparison is with published outcomes from short-course programmes rather than with a control group drawn from the same cluster, because withholding a paid placement from half a group of young people in order to measure the other half is not a design the Centre was willing to run."
    ],
    state: "ACTIVE",
    researchArea: "transmission-and-pedagogy",
    fundingBody: "The Long Table Fund",
    fundingAmount: "55,00,000",
    fundingCurrency: "INR",
    startedOn: "2024-07-15",
    endedOn: "2026-12-18",
    progress: 70,
    photo: "channapatna",
    isFeatured: true,
    members: [
      { person: "jacob-mathai", role: "Principal investigator", isLead: true },
      { person: "mahendra-solanki", role: "Cluster coordinator" },
      { person: "priyanka-meshram", role: "Curriculum and assessment" },
      { person: "nabanita-saikia", role: "Evaluation lead" }
    ],
    milestones: [
      { title: "Competence framework agreed with master turners", dueOn: "2024-11-08", isComplete: true },
      { title: "Cohort one placed", dueOn: "2025-01-20", isComplete: true },
      { title: "Cohort two placed", dueOn: "2025-09-15", isComplete: true },
      { title: "Cohort one twelve-month retention measured", dueOn: "2026-07-31", isComplete: true },
      { title: "Pilot evaluation and cost-per-retained-turner published", dueOn: "2026-12-11", isComplete: false }
    ]
  },

  {
    slug: "pattachitra-support-conservation",
    title: "Conserving the painted patta",
    tagline: "The support fails before the paint does",
    summary:
      "A conservation study of cloth-based pattachitra paintings from Odisha, concentrating on the prepared support rather than the paint layer. Sixty-three works are being surveyed for delamination, and three cleaning and consolidation approaches are being trialled on sacrificial mock-ups.",
    bodyParagraphs: [
      "A pattachitra is painted on a support the painter makes: layers of cotton cloth laminated with a paste, coated with a fine ground of chalk or soft stone, and burnished smooth before any line is drawn. The painting is finished with a resinous coating that gives it its characteristic surface sheen.",
      "That construction fails in a specific way. Under humidity cycling the laminated layers separate from one another, and the ground — which is stiff and thin — cracks and lifts over the void. The paint is often in good condition on a support that is coming apart underneath it, which makes the usual instinct to treat the visible surface exactly the wrong first move.",
      "The project is surveying sixty-three works in three collections with raking light and transmitted light, mapping delamination rather than recording an overall condition grade. In parallel it is trialling consolidation on mock-up boards prepared by working painters to the same recipe, so that the trials are done on the material as it is actually made rather than on a laboratory approximation of it.",
      "Nothing is being tested on an original. The mock-ups are commissioned, paid for at a working rate, and destroyed at the end of the trial."
    ],
    state: "ACTIVE",
    researchArea: "conservation-science",
    fundingBody: "The Palm Leaf Trust",
    fundingAmount: "47,00,000",
    fundingCurrency: "INR",
    startedOn: "2025-02-10",
    endedOn: "2027-01-29",
    progress: 55,
    photo: "pattachitra",
    members: [
      { person: "anjali-deshmukh", role: "Principal investigator", isLead: true },
      { person: "vaishali-rane", role: "Conservator" },
      { person: "rohit-vaghela", role: "Analytical support" },
      { person: "arjun-thapa", role: "Imaging technician" },
      { person: "abhilash-nayak", role: "Research assistant" }
    ],
    milestones: [
      { title: "Condition survey protocol agreed across three collections", dueOn: "2025-05-30", isComplete: true },
      { title: "Forty works surveyed and mapped", dueOn: "2025-12-12", isComplete: true },
      { title: "Mock-up boards commissioned and prepared", dueOn: "2026-03-27", isComplete: true },
      { title: "Consolidation trials complete", dueOn: "2026-10-23", isComplete: false },
      { title: "Treatment guidance issued to participating collections", dueOn: "2027-01-22", isComplete: false }
    ]
  },

  {
    slug: "weaving-household-panel",
    title: "The weaving household panel",
    tagline: "The same four hundred households, asked the same questions, four years running",
    summary:
      "A four-year panel study of income, working hours and debt in four handloom weaving clusters. Because it returns to the same households each year, it can see a family leaving weaving — which a repeated one-off survey of the trade structurally cannot.",
    bodyParagraphs: [
      "Most published figures about craft livelihoods come from surveys of people currently practising the craft. That design has a hole in it that no sample size closes: the households that have stopped are, by construction, not in the sample. A trade can look stable in successive surveys while emptying out underneath them.",
      "This study follows four hundred and twelve households in four clusters and returns to each of them annually, whether or not anyone in the house is still weaving. Where a household has left the trade, the interview is about why and what they do now. That is the observation the study exists to make.",
      "The instrument covers loom-days worked, gross and net earnings by product type, yarn cost and where it was bought, credit taken and from whom, and who in the household does which part of the work — pre-loom preparation is largely unpaid and largely done by women, and a survey that asks only about the weaver misses most of the labour.",
      "Three of four annual rounds are complete. Attrition is at eleven per cent, which is low for a panel of this kind and is mostly migration rather than refusal."
    ],
    state: "ACTIVE",
    researchArea: "livelihoods-and-markets",
    fundingBody: "The Broadloom Endowment",
    fundingAmount: "78,00,000",
    fundingCurrency: "INR",
    startedOn: "2023-08-01",
    endedOn: "2026-12-31",
    progress: 75,
    photo: "handloom",
    members: [
      { person: "nabanita-saikia", role: "Principal investigator", isLead: true },
      { person: "mahendra-solanki", role: "Field coordinator" },
      { person: "sneha-toppo", role: "Survey design and analysis" },
      { person: "devendra-pathak", role: "Data manager" },
      { person: "farida-shaikh", role: "Qualitative interviews" }
    ],
    milestones: [
      { title: "Baseline round complete in all four clusters", dueOn: "2024-01-26", isComplete: true },
      { title: "Round two complete", dueOn: "2025-01-31", isComplete: true },
      { title: "Round three complete", dueOn: "2026-01-30", isComplete: true },
      { title: "Round four complete", dueOn: "2026-11-27", isComplete: false },
      { title: "Anonymised panel dataset and final report released", dueOn: "2026-12-18", isComplete: false }
    ]
  },

  {
    slug: "textile-collection-digitisation",
    title: "Digitising the study collection",
    tagline: "Two thousand textiles, and a vocabulary that lets you find them",
    summary:
      "The imaging, cataloguing and online release of the Centre's study collection of textiles and its associated field papers. The harder half of the work is the controlled vocabulary: a record nobody can search is a record nobody has.",
    bodyParagraphs: [
      "The collection holds a little over two thousand textiles and roughly nine linear metres of field papers, accumulated over three decades of survey work and never catalogued to a single standard. Its finding aid was a card index in two hands and a spreadsheet in three formats.",
      "Imaging is the straightforward part: a fixed rig, colour targets in every frame, whole-object and detail captures, and high-resolution deep zoom so a reader can look at a weave structure rather than at a photograph of a cloth. Around sixteen hundred objects are through it.",
      "The vocabulary is the real work. Technique, structure, material and region all need controlled terms, and every one of those terms is a decision about whose name for a thing is the one the catalogue uses. The rule adopted here is that the practitioner's term is the entry term, with regional variants and the anglicised form held as equivalents so that a search for either finds the object. Where a term is contested the record says so rather than picking a winner silently.",
      "Records are released under an open licence with stable identifiers, and every image carries its own rights statement, because a collection that is technically open and practically unciteable has not been opened."
    ],
    state: "ACTIVE",
    researchArea: "digital-archives",
    fundingBody: "The Ninth Loom Trust",
    fundingAmount: "94,00,000",
    fundingCurrency: "INR",
    startedOn: "2024-04-08",
    endedOn: "2026-11-30",
    progress: 80,
    photo: "kantha",
    isFeatured: true,
    members: [
      { person: "harpreet-kaur-sandhu", role: "Principal investigator", isLead: true },
      { person: "arjun-thapa", role: "Imaging lead" },
      { person: "vivek-hegde", role: "Cataloguer" },
      { person: "karthik-selvaraj", role: "Systems and metadata" },
      { person: "kavitha-reddy", role: "Rights and licensing" }
    ],
    milestones: [
      { title: "Imaging rig commissioned and colour workflow validated", dueOn: "2024-08-16", isComplete: true },
      { title: "Controlled vocabulary drafted and reviewed with practitioners", dueOn: "2025-02-28", isComplete: true },
      { title: "One thousand objects catalogued and imaged", dueOn: "2025-10-31", isComplete: true },
      { title: "Public catalogue released with deep-zoom viewing", dueOn: "2026-09-25", isComplete: false },
      { title: "Field papers digitised and linked to object records", dueOn: "2026-11-20", isComplete: false }
    ]
  },

  {
    slug: "zardozi-workshop-study",
    title: "Zardozi workshop economies",
    tagline: "Paused pending renewal of the second funding tranche",
    summary:
      "A study of piece rates, subcontracting chains and working conditions in metal-thread embroidery workshops. Fieldwork in two of four planned centres is complete; the project is on hold and no further fieldwork is being started.",
    bodyParagraphs: [
      "Zardozi is embroidery in metal thread and coiled metal wire, worked with a hook on cloth stretched taut over a wooden frame. It is highly skilled, extremely slow, and organised through long subcontracting chains in which the person doing the work is several steps removed from the person selling it. The study set out to map those chains and the rate at each step.",
      "Two of four planned centres are complete: two hundred and six workers interviewed, and rate cards collected at three levels of the chain in each. The findings so far are not being published in isolation, because a rate structure from half a sample invites exactly the generalisation the design was built to avoid.",
      "The project is on hold. Its second funding tranche was not renewed at the scheduled review and the field team's contracts ended in March. Nothing collected is at risk — the interviews are transcribed and deposited under embargo — but no further fieldwork will begin until funding is settled.",
      "If it does not resume, the two completed centres will be written up as a standalone report with the limitation stated in the title rather than in a footnote."
    ],
    state: "ON_HOLD",
    researchArea: "livelihoods-and-markets",
    fundingBody: "The Broadloom Endowment",
    fundingAmount: "34,00,000",
    fundingCurrency: "INR",
    startedOn: "2024-10-07",
    progress: 35,
    photo: "zardozi",
    members: [
      { person: "nabanita-saikia", role: "Principal investigator", isLead: true },
      { person: "farida-shaikh", role: "Field coordinator" },
      { person: "aarti-lokhande", role: "Survey design" },
      { person: "sneha-toppo", role: "Interviewer" }
    ],
    milestones: [
      { title: "Instrument piloted and rate-card protocol agreed", dueOn: "2025-01-31", isComplete: true },
      { title: "Centre one fieldwork complete", dueOn: "2025-07-25", isComplete: true },
      { title: "Centre two fieldwork complete", dueOn: "2026-02-27", isComplete: true },
      { title: "Centres three and four fieldwork", detail: "Not scheduled. Awaiting the funding decision.", isComplete: false },
      { title: "Comparative report across four centres", isComplete: false }
    ]
  },

  {
    slug: "pashmina-fibre-reference",
    title: "A fibre reference set for pashmina",
    tagline: "Proposed. An open reference against which a claim can be checked",
    summary:
      "A proposal to build an open reference set of fibre measurements — diameter distributions and surface scale morphology — for pashmina from Ladakhi goat flocks, so that a laboratory anywhere can check a fibre claim against published data rather than against a commercial database.",
    bodyParagraphs: [
      "Pashmina is the fine undercoat of goats kept at high altitude in Ladakh, combed out rather than shorn, and hand-spun and hand-woven in Kashmir. Its value rests on fibre fineness, and fineness is precisely the property that is easiest to dilute invisibly: a proportion of another fine animal fibre, or of a synthetic, is not detectable by hand or by eye in a finished shawl.",
      "Fibre identification is well-established science. Diameter distribution and the pattern of surface scales, measured under a microscope, distinguish these fibres reliably. What is missing is not the method but open reference data: the comparison sets that testing laboratories use are largely proprietary, which puts the ability to substantiate a claim behind a fee and out of reach of the people whose claim it is.",
      "The proposal is to sample from flocks across several herding areas and seasons, publish full measurement distributions with the sampling protocol, and release the microscope imagery. The intended user is a small cooperative that wants to be able to demonstrate what it is selling.",
      "The design has been reviewed with herders' representatives and weavers' cooperatives. Fieldwork would begin in January 2027 if the proposal is funded; nothing has started."
    ],
    state: "PROPOSED",
    researchArea: "material-science",
    fundingBody: "Centre research fund (internal allocation)",
    startedOn: "2027-01-04",
    endedOn: "2027-12-17",
    progress: 0,
    photo: "pashmina",
    members: [
      { person: "sudeshna-pal", role: "Principal investigator", isLead: true },
      { person: "girish-kamath", role: "Microscopy" },
      { person: "mahendra-solanki", role: "Field sampling coordinator" }
    ],
    milestones: [
      { title: "Sampling agreements with herding cooperatives", dueOn: "2027-02-26", isComplete: false },
      { title: "Seasonal sampling rounds complete", dueOn: "2027-08-27", isComplete: false },
      { title: "Measurement series and imagery complete", dueOn: "2027-11-12", isComplete: false },
      { title: "Open reference set published with protocol", dueOn: "2027-12-10", isComplete: false }
    ]
  },

  {
    slug: "warli-wall-record",
    title: "Warli walls: a photographic and measured record",
    tagline: "Completed. Two hundred and thirty painted walls, recorded where they stand",
    summary:
      "A completed survey of Warli wall painting in Palghar district, Maharashtra: two hundred and thirty painted walls photographed and measured in situ, with the household's account of who painted them, when, and for what occasion.",
    bodyParagraphs: [
      "Warli painting is made by the Warli community in and around Palghar district in Maharashtra. It is painted in white — rice paste — on a wall plastered with earth, using a chewed bamboo stick as a brush, and its forms are built from a very small geometric vocabulary: circles, triangles and lines assembled into figures, animals, trees and dancing rings.",
      "Its original setting is domestic and occasional. Paintings are made on the walls of a house for particular events, above all weddings, and they are not made to be permanent. Rain, replastering and rebuilding remove them. The versions most people have seen are on paper and canvas, made for sale, which is a real and living practice but a different one.",
      "The survey recorded two hundred and thirty painted walls where they stood, with scale, orientation, plaster condition and the household's account of the painting's occasion and author. Where the painter was living and willing, a short interview was recorded with them.",
      "The record is deposited with the households' consent and with a restriction they asked for: precise locations are not published. Interest from outside has not always been welcome, and a public map of painted houses is an invitation the survey was not asked to issue.",
      "The project closed in May 2025."
    ],
    state: "COMPLETED",
    researchArea: "field-documentation",
    fundingBody: "Vermilion Trust for Material Culture",
    fundingAmount: "33,00,000",
    fundingCurrency: "INR",
    startedOn: "2023-03-06",
    endedOn: "2025-05-30",
    progress: 100,
    photo: "warli",
    members: [
      { person: "meera-ranganathan", role: "Principal investigator", isLead: true },
      { person: "priyanka-meshram", role: "Community liaison" },
      { person: "tanmay-ghosh", role: "Photographer" },
      { person: "rohit-vaghela", role: "Field surveyor" }
    ],
    milestones: [
      { title: "Consent and access agreed with participating households", dueOn: "2023-07-14", isComplete: true },
      { title: "First season of recording complete", dueOn: "2024-02-23", isComplete: true },
      { title: "Second season complete, 230 walls recorded", dueOn: "2024-11-22", isComplete: true },
      { title: "Record deposited with access restrictions applied", dueOn: "2025-03-28", isComplete: true },
      { title: "Copies returned to every participating household", dueOn: "2025-05-30", isComplete: true }
    ]
  },

  {
    slug: "chikankari-stitch-atlas",
    title: "A stitch atlas for chikankari",
    tagline: "Completed. Each stitch photographed from both faces, at scale, with the hand that made it",
    summary:
      "A completed reference atlas of chikankari stitches as worked in Lucknow, each recorded from the front and the reverse at magnification, with a filmed working sequence and the name given by the embroiderer who worked it.",
    bodyParagraphs: [
      "Chikankari is a white-on-white embroidery worked on fine cotton in and around Lucknow, and it is not one stitch but a repertoire of many, each with its own name and its own use. Shadow work is done from the reverse of the cloth so that the thread shows through the muslin as a soft tone rather than a line. Small knotted stitches build raised grains. Openwork is made by teasing the ground threads apart with a needle to leave a lattice — the threads are separated, not cut, which is why the fabric does not fray at the hole.",
      "Working outlines are commonly block-printed onto the cloth before embroidery and washed out afterwards, which means the printer and the embroiderer are different trades on the same piece.",
      "The atlas records each stitch three ways: photographed from the face and the reverse at magnification against a scale, filmed as a working sequence at the embroiderer's own pace, and named as the embroiderer names it, with variant names noted rather than reconciled. Thirty-one stitches are covered.",
      "Every embroiderer who worked a sample is named in the atlas as its author and was paid at a commissioned-work rate rather than a sample rate. The project closed in December 2025 and the atlas is openly licensed."
    ],
    state: "COMPLETED",
    researchArea: "transmission-and-pedagogy",
    fundingBody: "The Ninth Loom Trust",
    fundingAmount: "26,00,000",
    fundingCurrency: "INR",
    startedOn: "2023-06-12",
    endedOn: "2025-12-19",
    progress: 100,
    photo: "chikankari",
    members: [
      { person: "jacob-mathai", role: "Principal investigator", isLead: true },
      { person: "farida-shaikh", role: "Field coordinator" },
      { person: "priyanka-meshram", role: "Pedagogical design" },
      { person: "tanmay-ghosh", role: "Photography and film" }
    ],
    milestones: [
      { title: "Stitch list agreed with participating embroiderers", dueOn: "2023-10-27", isComplete: true },
      { title: "Sample commissioning complete", dueOn: "2024-06-28", isComplete: true },
      { title: "Photography and filming complete", dueOn: "2025-03-21", isComplete: true },
      { title: "Atlas reviewed by its contributors", dueOn: "2025-09-26", isComplete: true },
      { title: "Atlas published under an open licence", dueOn: "2025-12-19", isComplete: true }
    ]
  },

  {
    slug: "bishnupur-terracotta-photogrammetry",
    title: "Photogrammetry of the Bishnupur terracotta panels",
    tagline: "Proposed. A measured record of surfaces that are weathering faster than they are being read",
    summary:
      "A proposal to make a measured photogrammetric record of the carved terracotta panels on the brick temples of Bishnupur in West Bengal, at a resolution that supports both condition monitoring and iconographic study.",
    bodyParagraphs: [
      "The temples at Bishnupur, in Bankura district, were built largely in the seventeenth and eighteenth centuries under Malla patronage. The region has little building stone, and the temples are of brick faced with moulded and carved terracotta panels — narrative scenes, court and hunting subjects, and dense ornamental registers.",
      "Fired clay in the open weathers steadily. Detail that is legible in a photograph from fifty years ago is not always legible now, and the change is gradual enough that it is difficult to argue about without measurement. A photogrammetric record gives a surface that can be re-surveyed and differenced.",
      "The proposal is for sub-millimetre capture of the panels on a defined set of temples, published as both a working three-dimensional model and a set of derived renderings that make shallow relief readable — raking-light simulation and curvature shading do far more for a worn panel than any photograph.",
      "It would be run with the consent and involvement of the authorities responsible for the monuments, and the proposal is not costed as a one-off: a baseline that is never re-surveyed answers nothing. Nothing has begun."
    ],
    state: "PROPOSED",
    researchArea: "digital-archives",
    fundingBody: "Centre research fund (internal allocation)",
    startedOn: "2027-02-01",
    endedOn: "2027-12-15",
    progress: 0,
    photo: "terracotta",
    members: [
      { person: "harpreet-kaur-sandhu", role: "Principal investigator", isLead: true },
      { person: "arjun-thapa", role: "Survey and capture" },
      { person: "abhilash-nayak", role: "Iconographic documentation" },
      { person: "karthik-selvaraj", role: "Data pipeline" }
    ],
    milestones: [
      { title: "Permissions and access agreed", dueOn: "2027-03-31", isComplete: false },
      { title: "Capture of the first temple group", dueOn: "2027-07-30", isComplete: false },
      { title: "Derived renderings and condition baseline", dueOn: "2027-10-29", isComplete: false },
      { title: "Models and baseline published", dueOn: "2027-12-10", isComplete: false }
    ]
  },

  {
    slug: "dhokra-core-and-alloy",
    title: "Core, wax and alloy in dhokra casting",
    tagline: "Paused pending a collections agreement",
    summary:
      "A materials study of lost-wax casting as practised by metalworking families in Bastar and adjoining districts, covering core clay, wax thread composition and the alloys poured. Fieldwork is complete; laboratory work on historic pieces is stalled awaiting an access agreement.",
    bodyParagraphs: [
      "Dhokra is lost-wax casting. In the hollow method a clay core is modelled first, then wrapped in fine threads of wax laid side by side — which is why the finished bronze carries that characteristic ribbed surface, since the wax pattern is the surface. The wrapped core is coated in clay, the wax is melted out through a channel, and molten metal is poured into the space it leaves. The mould must be broken to release the object, so every piece is a single cast and no two are identical.",
      "The study is looking at three things: the clay used for cores and its behaviour at pour temperature, the composition of the wax thread, which in practice is a mixture rather than a single material, and the alloys poured — scrap-derived and therefore variable in a way that a foundry alloy is not.",
      "Fieldwork with working casters is complete, including recorded pours and sampling of core clay and wax with the casters' agreement. The comparison against historic pieces is not.",
      "The project is paused there. The collection holding the historic material has asked for a revised sampling agreement following a change in its own policy, and negotiating it has taken longer than the field phase did. No sampling of any historic object has taken place and none will until that agreement is signed."
    ],
    state: "ON_HOLD",
    researchArea: "material-science",
    fundingBody: "Anvil and Ash Foundation",
    fundingAmount: "31,00,000",
    fundingCurrency: "INR",
    startedOn: "2025-01-20",
    progress: 25,
    photo: "dhokra",
    members: [
      { person: "faiz-ahmad-ansari", role: "Principal investigator", isLead: true },
      { person: "sneha-toppo", role: "Field coordinator" },
      { person: "vaishali-rane", role: "Conservation scientist" },
      { person: "girish-kamath", role: "Analytical chemist" }
    ],
    milestones: [
      { title: "Field agreements with casting families", dueOn: "2025-04-25", isComplete: true },
      { title: "Recorded pours and material sampling complete", dueOn: "2025-11-28", isComplete: true },
      {
        title: "Sampling agreement with the holding collection",
        detail: "Under negotiation. Everything after this milestone is blocked on it.",
        isComplete: false
      },
      { title: "Comparative analysis of historic pieces", isComplete: false },
      { title: "Final report", isComplete: false }
    ]
  }
];

// ════════════════════════════════════════════════════════════════════════════════════════════════
// PUBLICATIONS
//
// ⚠ EVERY VENUE, PUBLISHER AND DOI BELOW IS INVENTED. The DOIs use `10.5555/`, the reserved test
// prefix, so none of them resolves. Naming a real journal as the publisher of a study that does not
// exist would be a false statement about that journal, not merely about the Centre.
//
// `authorLine` is the citation string and is the authoritative one — it includes external
// co-authors who are not Centre people and therefore have no slug. `authors` lists only the Centre
// people, IN THE SAME ORDER as they appear in the line.
// ════════════════════════════════════════════════════════════════════════════════════════════════

export const PUBLICATIONS: SeedPublication[] = [
  {
    slug: "zinc-alloy-composition-bidriware",
    kind: "JOURNAL_ARTICLE",
    title: "Alloy composition and patina formation in bidriware: a study of forty-one objects",
    abstract:
      "Bidriware is worked in a zinc-rich alloy with a minor copper addition, inlaid with silver and finished with a blackening treatment that darkens the ground while leaving the inlay bright. We report compositional analysis of forty-one objects from two collections and controlled blackening trials on newly cast test pieces treated with soil from four locations, including the Bidar fort site. The results support the practitioners' position that the source of the soil is not incidental to the result.",
    authorLine: "Ansari, F. A., Kamath, G., Vaghela, R., & Rane, V.",
    authors: ["faiz-ahmad-ansari", "girish-kamath", "rohit-vaghela", "vaishali-rane"],
    venue: "Journal of Material Analysis in Heritage",
    volume: "18",
    issue: "2",
    pages: "104–129",
    year: 2025,
    month: 4,
    doi: "10.5555/jmah.2025.18.104",
    keywords: ["bidriware", "zinc alloy", "silver inlay", "patina", "metalwork", "Bidar", "conservation science"],
    researchArea: "material-science",
    isFeatured: true
  },
  {
    slug: "bidriware-analytical-dataset",
    kind: "DATASET",
    title: "Bidriware alloy and patina measurements, 2023–2024",
    abstract:
      "Compositional measurements for forty-one bidriware objects and eleven cast test pieces, with instrument settings, sampling positions marked on object photographs, and the blackening trial protocol. Released so that a conservator treating a bidri object has a compositional range rather than a single published figure.",
    authorLine: "Ansari, F. A., Kamath, G., & Vaghela, R.",
    authors: ["faiz-ahmad-ansari", "girish-kamath", "rohit-vaghela"],
    publisher: "Centre of Excellence Research Data Repository",
    year: 2024,
    month: 9,
    doi: "10.5555/data.bidri.2024",
    keywords: ["bidriware", "zinc alloy", "patina", "open data", "metalwork", "conservation science"],
    researchArea: "material-science"
  },
  {
    slug: "sixteen-stages-ajrakh",
    kind: "JOURNAL_ARTICLE",
    title: "Counting the stages: process variation in Kachchh ajrakh printing",
    abstract:
      "Descriptions of ajrakh printing in the literature give stage counts ranging from twelve to over twenty for what is nominally the same process. Working from timed observation in eleven workshops, we show that the variation is not descriptive imprecision but real difference in practice, concentrated in the washing and steeping stages, and we argue that a single canonical sequence should not be published as though one existed.",
    authorLine: "Ranganathan, M., Solanki, M., & Bhatt, A.",
    authors: ["meera-ranganathan", "mahendra-solanki", "ananya-bhatt"],
    venue: "Studies in South Asian Textiles",
    volume: "31",
    issue: "1",
    pages: "22–48",
    year: 2026,
    month: 3,
    doi: "10.5555/ssat.2026.31.22",
    keywords: ["ajrakh", "block printing", "resist dyeing", "indigo", "madder", "Kachchh", "documentation"],
    researchArea: "field-documentation",
    isFeatured: true
  },
  {
    slug: "mordant-lightfastness-preprint",
    kind: "PREPRINT",
    title: "Light-fastness of six madder and myrobalan recipes on handspun cotton: interim results",
    abstract:
      "Interim results at 500 hours of accelerated light exposure for six mordant recipes collected from working dyers. Iron-mordanted samples are markedly more stable than alum-mordanted ones over this interval; the divergence between recipes using the same mordant is larger than expected and is not yet explained. Posted before peer review because dyers who supplied the recipes asked for the numbers as they arrive.",
    authorLine: "Pal, S., Deshmukh, A., & Rathod, H.",
    authors: ["sudeshna-pal", "anjali-deshmukh", "heena-rathod"],
    year: 2026,
    month: 5,
    keywords: ["madder", "myrobalan", "mordant", "iron", "light-fastness", "natural dye", "cotton"],
    researchArea: "material-science"
  },
  {
    slug: "indigo-vat-fermentation-management",
    kind: "JOURNAL_ARTICLE",
    title: "Keeping a fermentation vat: management practice in three indigo dyeing workshops",
    abstract:
      "A fermentation indigo vat is a living system that must be fed, warmed and read daily, and the reading is done by eye, nose and touch rather than by instrument. We recorded daily vat management in three workshops over one season alongside pH and temperature logging, and describe the correspondence between the practitioner's judgement and the measured state of the vat.",
    authorLine: "Rathod, H., Pal, S., & Bhatt, A.",
    authors: ["heena-rathod", "sudeshna-pal", "ananya-bhatt"],
    venue: "Journal of Craft and Material Culture",
    volume: "8",
    issue: "2",
    pages: "88–112",
    year: 2025,
    month: 6,
    doi: "10.5555/jcmc.2025.8.88",
    keywords: ["indigo", "fermentation vat", "natural dye", "reduction", "workshop practice"],
    researchArea: "material-science"
  },
  {
    slug: "delamination-pattachitra-supports",
    kind: "JOURNAL_ARTICLE",
    title: "Delamination in laminated cloth supports: a survey of sixty-three pattachitra paintings",
    abstract:
      "The support of a pattachitra is built by the painter from laminated cotton cloth, a prepared ground and a resinous finish. We surveyed sixty-three works under raking and transmitted light and mapped separation between layers. Delamination is widespread in works whose paint layer surveys as sound, which has direct consequences for the order in which treatment is undertaken.",
    authorLine: "Deshmukh, A., Rane, V., & Nayak, A.",
    authors: ["anjali-deshmukh", "vaishali-rane", "abhilash-nayak"],
    venue: "Review of Painting Conservation",
    volume: "22",
    issue: "1",
    pages: "40–63",
    year: 2026,
    month: 2,
    doi: "10.5555/rpc.2026.22.40",
    keywords: ["pattachitra", "conservation", "delamination", "tamarind paste", "ground layer", "Odisha"],
    researchArea: "conservation-science"
  },
  {
    slug: "leaving-the-loom",
    kind: "JOURNAL_ARTICLE",
    title: "Leaving the loom: three-year attrition in four handloom weaving clusters",
    abstract:
      "Surveys of practising weavers cannot observe households that have stopped weaving, and therefore systematically understate exit. Using three annual rounds of a panel that returns to the same 412 households regardless of whether anyone in them still weaves, we estimate exit rates by cluster and describe the sequence of events that typically precedes leaving.",
    authorLine: "Saikia, N., Toppo, S., Solanki, M., & Shaikh, F.",
    authors: ["nabanita-saikia", "sneha-toppo", "mahendra-solanki", "farida-shaikh"],
    venue: "Review of Craft Economies",
    volume: "14",
    issue: "2",
    pages: "159–188",
    year: 2026,
    month: 5,
    doi: "10.5555/rce.2026.14.159",
    keywords: ["handloom", "weaving", "livelihoods", "panel study", "attrition", "household economy"],
    researchArea: "livelihoods-and-markets",
    isFeatured: true
  },
  {
    slug: "pre-loom-labour-unpaid",
    kind: "JOURNAL_ARTICLE",
    title: "The work before the loom: unpaid preparation labour in weaving households",
    abstract:
      "Warping, sizing, bobbin winding and yarn preparation account for a substantial share of the hours behind a woven piece and are largely done by women within the household, unpaid and unrecorded. Drawing on time-use diaries from two panel rounds, we estimate that instruments which ask only about the weaver miss between a third and a half of total household labour.",
    authorLine: "Saikia, N., Shaikh, F., & Toppo, S.",
    authors: ["nabanita-saikia", "farida-shaikh", "sneha-toppo"],
    venue: "Review of Craft Economies",
    volume: "13",
    issue: "4",
    pages: "302–327",
    year: 2025,
    month: 11,
    doi: "10.5555/rce.2025.13.302",
    keywords: ["handloom", "livelihoods", "unpaid labour", "time use", "gender", "yarn preparation"],
    researchArea: "livelihoods-and-markets"
  },
  {
    slug: "weaving-household-panel-dataset",
    kind: "DATASET",
    title: "Weaving household panel, rounds one to three (anonymised)",
    abstract:
      "Anonymised household-level records from three annual rounds of a four-cluster panel of handloom weaving households, with the questionnaire, the sampling frame description and the anonymisation procedure. Cluster identifiers are generalised to region; households that left the trade are retained in the file and flagged.",
    authorLine: "Pathak, D., Saikia, N., & Toppo, S.",
    authors: ["devendra-pathak", "nabanita-saikia", "sneha-toppo"],
    publisher: "Centre of Excellence Research Data Repository",
    year: 2026,
    month: 4,
    doi: "10.5555/data.weavepanel.2026",
    keywords: ["handloom", "livelihoods", "panel data", "open data", "household economy"],
    researchArea: "livelihoods-and-markets"
  },
  {
    slug: "zardozi-interim-report",
    kind: "REPORT",
    title: "Piece rates and subcontracting in metal-thread embroidery: findings from two centres",
    abstract:
      "An interim report covering 206 workers in two embroidery centres, with rate cards collected at three levels of the subcontracting chain in each. The report states plainly that two centres are not four and that the rate structures described should not be generalised beyond them.",
    authorLine: "Saikia, N., Shaikh, F., & Lokhande, A.",
    authors: ["nabanita-saikia", "farida-shaikh", "aarti-lokhande"],
    publisher: "Centre of Excellence Press",
    pages: "1–58",
    year: 2026,
    month: 6,
    keywords: ["zardozi", "metal thread", "embroidery", "piece rates", "subcontracting", "livelihoods"],
    researchArea: "livelihoods-and-markets"
  },
  {
    slug: "chikankari-stitch-atlas-book",
    kind: "BOOK",
    title: "A Stitch Atlas for Chikankari",
    abstract:
      "Thirty-one stitches as worked in and around Lucknow, each photographed from the face and the reverse at magnification against a scale, with a filmed working sequence and the name given by the embroiderer who worked it. Variant names are recorded rather than reconciled. Every sample is credited to its maker.",
    authorLine: "Shaikh, F., Mathai, J., & Meshram, P.",
    authors: ["farida-shaikh", "jacob-mathai", "priyanka-meshram"],
    publisher: "Centre of Excellence Press",
    pages: "248",
    year: 2025,
    month: 12,
    keywords: ["chikankari", "embroidery", "shadow work", "openwork", "muslin", "Lucknow", "teaching reference"],
    researchArea: "transmission-and-pedagogy",
    isFeatured: true
  },
  {
    slug: "paid-apprenticeship-channapatna",
    kind: "JOURNAL_ARTICLE",
    title: "Paid apprenticeship against short-course training: interim outcomes from a lathe-turning pilot",
    abstract:
      "Short residential craft courses produce certificates reliably and working practitioners rarely. We report twelve-month retention for the first cohort of a pilot placing learners in working turning units for eighteen months with both learner and master paid, and compare it against published outcomes from short-course programmes. We set out why no control group was drawn from the same cluster.",
    authorLine: "Mathai, J., Meshram, P., & Saikia, N.",
    authors: ["jacob-mathai", "priyanka-meshram", "nabanita-saikia"],
    venue: "Journal of Vocational Learning and Craft",
    volume: "7",
    issue: "2",
    pages: "51–76",
    year: 2026,
    month: 7,
    doi: "10.5555/jvlc.2026.7.51",
    keywords: ["Channapatna", "lacquerware", "wood turning", "apprenticeship", "pedagogy", "transmission"],
    researchArea: "transmission-and-pedagogy"
  },
  {
    slug: "competence-not-attendance",
    kind: "BOOK_CHAPTER",
    title: "Competence, not attendance: assessing craft learning without written examination",
    abstract:
      "Craft competence is demonstrated in the object and in the hand, and assessment instruments borrowed from classroom education measure neither. This chapter describes an assessment framework built with master turners in which every criterion is a thing the learner can be asked to do at the lathe.",
    authorLine: "Mathai, J., & Meshram, P.",
    authors: ["jacob-mathai", "priyanka-meshram"],
    venue: "Teaching the Made Thing: Approaches to Craft Pedagogy",
    publisher: "Ridgeway Academic",
    pages: "133–156",
    year: 2025,
    keywords: ["pedagogy", "assessment", "apprenticeship", "wood turning", "transmission"],
    researchArea: "transmission-and-pedagogy"
  },
  {
    slug: "whose-word-is-the-entry-term",
    kind: "JOURNAL_ARTICLE",
    title: "Whose word is the entry term? Controlled vocabulary for a craft collection",
    abstract:
      "Every term in a controlled vocabulary is a decision about whose name for a thing the catalogue uses. We describe the vocabulary built for a collection of some two thousand textiles, in which the practitioner's term is the entry term and regional and anglicised forms are held as equivalents, and we report what happened when practitioners reviewed the draft.",
    authorLine: "Sandhu, H. K., Hegde, V., & Shaikh, F.",
    authors: ["harpreet-kaur-sandhu", "vivek-hegde", "farida-shaikh"],
    venue: "Cataloguing and Description Quarterly",
    volume: "41",
    issue: "3",
    pages: "188–210",
    year: 2026,
    month: 8,
    doi: "10.5555/cdq.2026.41.188",
    keywords: ["controlled vocabulary", "cataloguing", "metadata", "textiles", "terminology", "digital archive"],
    researchArea: "digital-archives",
    isFeatured: true
  },
  {
    slug: "weave-structure-viewer",
    kind: "SOFTWARE",
    title: "weave-structure-viewer: deep-zoom presentation of textile images with structural annotation",
    abstract:
      "A browser viewer for very large textile photographs that lets a reader move from the whole cloth to the interlacement of individual threads, with an annotation layer for marking structure, repeat and fault. Written for the study collection catalogue and released for reuse. Open source.",
    authorLine: "Selvaraj, K., Sandhu, H. K., & Thapa, A.",
    authors: ["karthik-selvaraj", "harpreet-kaur-sandhu", "arjun-thapa"],
    publisher: "Centre of Excellence",
    year: 2026,
    month: 1,
    keywords: ["software", "deep zoom", "textiles", "weave structure", "annotation", "digital archive"],
    researchArea: "digital-archives"
  },
  {
    slug: "study-collection-catalogue-dataset",
    kind: "DATASET",
    title: "Study collection catalogue: object records and controlled vocabulary, release one",
    abstract:
      "Catalogue records for the first thousand objects imaged and described in the study collection, with the controlled vocabulary as a SKOS file, stable identifiers, and per-image rights statements. Records are openly licensed; a small number of objects are described but not imaged at the depositor's request.",
    authorLine: "Hegde, V., Sandhu, H. K., & Reddy, K.",
    authors: ["vivek-hegde", "harpreet-kaur-sandhu", "kavitha-reddy"],
    publisher: "Centre of Excellence Research Data Repository",
    year: 2026,
    month: 2,
    doi: "10.5555/data.studycoll.2026",
    keywords: ["catalogue", "open data", "textiles", "controlled vocabulary", "digital archive"],
    researchArea: "digital-archives"
  },
  {
    slug: "recording-in-the-speakers-language",
    kind: "JOURNAL_ARTICLE",
    title: "Recording in the speaker's language: translation as finding aid, not as record",
    abstract:
      "Oral history programmes frequently archive the English translation and discard or bury the original recording, which makes the translator's choices unreviewable. We describe a practice in which the recording in the speaker's own language is the archival record and the translation is explicitly a finding aid, and discuss the additional cost this imposes and why it is worth paying.",
    authorLine: "Shaikh, F., Pathak, D., & Mathai, J.",
    authors: ["farida-shaikh", "devendra-pathak", "jacob-mathai"],
    venue: "Fieldwork and Method: A Review",
    volume: "12",
    issue: "1",
    pages: "9–31",
    year: 2026,
    month: 4,
    doi: "10.5555/fmr.2026.12.9",
    keywords: ["oral history", "translation", "archives", "method", "consent", "Mithila"],
    researchArea: "field-documentation"
  },
  {
    slug: "wall-to-paper-mithila",
    kind: "BOOK_CHAPTER",
    title: "From the wall to the paper: what changed when Mithila painting acquired a market",
    abstract:
      "Mithila painting moved onto paper from the 1960s and acquired buyers outside the region for the first time. Drawing on recorded interviews with painters who worked through that change, this chapter describes what the shift did to subject, scale, composition and to who in a household painted at all.",
    authorLine: "Meshram, P., & Mathai, J.",
    authors: ["priyanka-meshram", "jacob-mathai"],
    venue: "Markets and Making in Modern South Asia",
    publisher: "Ridgeway Academic",
    pages: "201–228",
    year: 2026,
    keywords: ["Madhubani", "Mithila", "painting", "oral history", "markets", "Bihar"],
    researchArea: "field-documentation"
  },
  {
    slug: "warli-wall-survey-report",
    kind: "REPORT",
    title: "Warli wall paintings in Palghar district: survey report",
    abstract:
      "A record of 230 painted walls documented in situ with scale, orientation, plaster condition and the household's account of occasion and author. Precise locations are withheld at the participating households' request; the report explains that decision and the terms under which the withheld data are held.",
    authorLine: "Ranganathan, M., Meshram, P., Ghosh, T., & Vaghela, R.",
    authors: ["meera-ranganathan", "priyanka-meshram", "tanmay-ghosh", "rohit-vaghela"],
    publisher: "Centre of Excellence Press",
    pages: "1–142",
    year: 2025,
    month: 5,
    keywords: ["Warli", "wall painting", "rice paste", "mud plaster", "Palghar", "survey", "Maharashtra"],
    researchArea: "field-documentation"
  },
  {
    slug: "restricted-access-community-record",
    kind: "CONFERENCE_PAPER",
    title: "Publishing less than you recorded: restricted access as a condition of consent",
    abstract:
      "A survey that maps where cultural objects are is also a map for people the community did not invite. We describe a survey in which locations were recorded but withheld from publication at the participants' request, and argue that the ability to publish a record at reduced resolution should be designed into an archive rather than negotiated afterwards.",
    authorLine: "Pathak, D., & Meshram, P.",
    authors: ["devendra-pathak", "priyanka-meshram"],
    venue: "International Meeting on Craft Documentation and Care",
    pages: "112–124",
    year: 2026,
    month: 3,
    keywords: ["consent", "access restriction", "archives", "research ethics", "Warli", "method"],
    researchArea: "field-documentation"
  },
  {
    slug: "double-ikat-planning-thesis",
    kind: "THESIS",
    title: "Resolving the pattern before the loom: planning and error in double ikat",
    abstract:
      "In a double ikat both warp and weft are resist-dyed to the finished design before weaving begins, so the pattern must be fully resolved as a set of measured bindings in advance and the weaver's task at the loom is to bring the two into register. This thesis examines how that planning is carried and taught, and what happens to a piece when the two sets do not meet.",
    authorLine: "Ranganathan, M.",
    authors: ["meera-ranganathan"],
    publisher: "Centre of Excellence",
    year: 2024,
    keywords: ["patola", "double ikat", "resist dyeing", "silk", "Patan", "weaving", "planning"],
    researchArea: "material-science"
  },
  {
    slug: "frit-body-blue-pottery-thesis",
    kind: "THESIS",
    title: "A body without clay: firing behaviour of frit-based blue pottery",
    abstract:
      "Jaipur blue pottery is made from a body of ground quartz, glass and binder that contains no clay, which is why it is fired at low temperature and why it is brittle and unforgiving to form. This thesis characterises the body and its firing behaviour across a range of recipes gathered from working potters, and relates breakage rates to composition.",
    authorLine: "Vaghela, R.",
    authors: ["rohit-vaghela"],
    publisher: "Centre of Excellence",
    year: 2023,
    keywords: ["blue pottery", "frit", "quartz", "glaze", "cobalt", "Jaipur", "ceramics"],
    researchArea: "material-science"
  },
  {
    slug: "phulkari-floss-silk-degradation",
    kind: "JOURNAL_ARTICLE",
    title: "Floss silk on handspun cotton: differential degradation in phulkari embroideries",
    abstract:
      "Phulkari is worked in floss silk in a darning stitch from the reverse of a handspun cotton ground, so that long floats of untwisted silk cover the face of the cloth. Silk and cotton age differently, and in the pieces surveyed here the embroidery is consistently in worse condition than the ground it sits on. We report the survey and discuss the storage implications.",
    authorLine: "Deshmukh, A., Pal, S., & Rane, V.",
    authors: ["anjali-deshmukh", "sudeshna-pal", "vaishali-rane"],
    venue: "Review of Painting Conservation",
    volume: "21",
    issue: "4",
    pages: "289–308",
    year: 2025,
    month: 10,
    doi: "10.5555/rpc.2025.21.289",
    keywords: ["phulkari", "floss silk", "khaddar", "darning stitch", "conservation", "Punjab"],
    researchArea: "conservation-science"
  },
  {
    slug: "open-fibre-reference-preprint",
    kind: "PREPRINT",
    title: "The case for an open fibre reference set for fine animal fibres",
    abstract:
      "Distinguishing pashmina from other fine animal fibres is settled science — diameter distribution and surface scale morphology do it reliably — but the reference sets against which a sample is compared are largely proprietary. We argue that this puts the ability to substantiate a claim beyond the reach of the small producers whose claim it is, and set out what an open reference set would need to contain.",
    authorLine: "Pal, S., Kamath, G., & Solanki, M.",
    authors: ["sudeshna-pal", "girish-kamath", "mahendra-solanki"],
    year: 2026,
    month: 7,
    keywords: ["pashmina", "cashmere", "fibre identification", "microscopy", "Ladakh", "open data", "certification"],
    researchArea: "material-science"
  },
  {
    slug: "gesso-relief-thanjavur",
    kind: "JOURNAL_ARTICLE",
    title: "Raised ground and gold leaf: the gesso relief of Thanjavur painting",
    abstract:
      "A Thanjavur painting is built on a cloth-covered wooden panel with areas of the design raised in a gesso paste before gold leaf is applied over them, giving the ornament genuine physical relief. We examine the composition and thickness of the raised ground in nineteen panels and relate failure of the gilding to the behaviour of the layer beneath it.",
    authorLine: "Rane, V., Vaghela, R., & Nayak, A.",
    authors: ["vaishali-rane", "rohit-vaghela", "abhilash-nayak"],
    venue: "Journal of Material Analysis in Heritage",
    volume: "17",
    issue: "3",
    pages: "201–224",
    year: 2024,
    month: 8,
    doi: "10.5555/jmah.2024.17.201",
    keywords: ["Thanjavur painting", "gesso", "gold leaf", "gilding", "panel painting", "conservation science"],
    researchArea: "conservation-science"
  },
  {
    slug: "lost-wax-thread-wrapped-cores",
    kind: "JOURNAL_ARTICLE",
    title: "Thread-wrapped cores in lost-wax casting: surface as consequence of pattern",
    abstract:
      "In the hollow lost-wax method used in Bastar and adjoining districts, the wax pattern is built as fine threads laid side by side over a clay core, and the ribbed surface of the finished bronze is a direct record of that construction. Working from recorded pours, we relate thread gauge and laying practice to the cast surface, and note that the mould is destroyed at every casting so that no piece can be repeated.",
    authorLine: "Kamath, G., Ansari, F. A., & Toppo, S.",
    authors: ["girish-kamath", "faiz-ahmad-ansari", "sneha-toppo"],
    venue: "Journal of Craft and Material Culture",
    volume: "7",
    issue: "1",
    pages: "33–57",
    year: 2024,
    month: 2,
    doi: "10.5555/jcmc.2024.7.33",
    keywords: ["dhokra", "lost wax", "bronze", "brass", "casting", "core clay", "Bastar"],
    researchArea: "material-science"
  },
  {
    slug: "photogrammetry-shallow-relief",
    kind: "CONFERENCE_PAPER",
    title: "Reading shallow relief: derived renderings from photogrammetric survey of weathered terracotta",
    abstract:
      "A photograph of a worn terracotta panel is often illegible where the surface has lost contrast but not shape. Using survey data from brick temple facades, we compare curvature shading, ambient occlusion and simulated raking light as means of recovering legibility, and recommend which to publish alongside the model.",
    authorLine: "Thapa, A., Selvaraj, K., & Sandhu, H. K.",
    authors: ["arjun-thapa", "karthik-selvaraj", "harpreet-kaur-sandhu"],
    venue: "Workshop on Cultural Heritage Data",
    pages: "45–58",
    year: 2025,
    month: 7,
    keywords: ["photogrammetry", "terracotta", "Bishnupur", "relief", "digital archive", "condition monitoring"],
    researchArea: "digital-archives"
  },
  {
    slug: "what-a-record-cannot-do",
    kind: "JOURNAL_ARTICLE",
    title: "What a record cannot do: the limits of documentation in craft preservation",
    abstract:
      "Documentation is routinely described as preserving a craft. It does not: only continued practice does that. This paper distinguishes what a record can genuinely achieve — legibility to outsiders, a basis for teaching, evidence for policy, a reference for later reconstruction — from what is claimed for it, and argues that overstating the first makes it easier to stop funding the second.",
    authorLine: "Ranganathan, M., & Pathak, D.",
    authors: ["meera-ranganathan", "devendra-pathak"],
    venue: "Fieldwork and Method: A Review",
    volume: "9",
    issue: "2",
    pages: "77–96",
    year: 2023,
    month: 6,
    doi: "10.5555/fmr.2023.9.77",
    keywords: ["documentation", "preservation", "policy", "method", "transmission"],
    researchArea: "field-documentation"
  },
  {
    slug: "early-survey-of-craft-cluster-records",
    kind: "REPORT",
    title: "What is already recorded: a review of existing craft cluster documentation",
    abstract:
      "Before beginning its own surveys the Centre reviewed what documentation already existed for the clusters it intended to work in, where it was held and whether it could be consulted. The finding that shaped everything since: a great deal has been recorded and very little of it is findable, and duplicating a survey is a common and avoidable cost.",
    authorLine: "Pathak, D., Ghosh, T., & Sandhu, H. K.",
    authors: ["devendra-pathak", "tanmay-ghosh", "harpreet-kaur-sandhu"],
    publisher: "Centre of Excellence Press",
    pages: "1–96",
    year: 2019,
    month: 10,
    keywords: ["documentation", "archives", "survey", "craft clusters", "findability"],
    researchArea: "field-documentation"
  },
  {
    slug: "photographing-cloth",
    kind: "BOOK_CHAPTER",
    title: "Photographing cloth: lighting, scale and the problem of sheen",
    abstract:
      "A textile photographed with a single soft light looks like a flat pattern; the structure that identifies it is carried in specular highlight and in shadow at the interlacement. This chapter sets out a lighting and capture method for textiles that keeps structure legible, and explains why a colour target and a scale in every frame are not optional.",
    authorLine: "Thapa, A., & Ghosh, T.",
    authors: ["arjun-thapa", "tanmay-ghosh"],
    venue: "Imaging the Material Object",
    publisher: "Ridgeway Academic",
    pages: "89–114",
    year: 2022,
    keywords: ["photography", "imaging", "textiles", "weave structure", "colour management", "digital archive"],
    researchArea: "digital-archives"
  }
];
