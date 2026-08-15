import type { SeedEvent, SeedPartner, SeedPost } from "./types";

/**
 * THE NEWSROOM — eighteen posts, thirteen events and thirteen partners.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS MODULE IS FOR. A demonstration site whose newsroom holds one post looks like a site
 * that launched this morning; a newsroom whose newest item is eight months old looks abandoned. So
 * the posts here run from three days back to about sixteen months, weighted heavily towards the
 * recent end, and the events straddle today in both directions — which is the only way the
 * "upcoming" and "past" tabs, and the homepage's EVENT_SHOWCASE, can both have something in them.
 *
 * The shapes are the ones an institution's newsroom actually contains: a field survey finishing, a
 * fellowship opening, a paper appearing, a collection catalogued, a partnership signed, a dataset
 * released, an exhibition, a workshop written up afterwards, an obituary, and a correction.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHERE THE FACTS COME FROM, AND WHERE THEY STOP.
 *
 * The craft traditions described below are real and are described from general published knowledge
 * of them: the region, the material, the technique, the rough period. Where a detail was uncertain
 * it was LEFT OUT rather than reconstructed — an entry that says less is recoverable, and a
 * confidently wrong sentence about somebody's craft on an institutional website is not. In
 * particular, no local-language term, script or community attribution appears here unless it was
 * certain; several posts are shorter than they might have been for exactly that reason.
 *
 * ⚠ EVERYTHING INSTITUTIONAL IS INVENTED. Every person named — practitioner, speaker, academic,
 * and the craftsperson in the obituary — is fictional, as is every journal, funder, museum, college
 * and collective. No DOI, ISBN or grant number appears anywhere in this file, because a plausible
 * one is indistinguishable from a real one to a reader and a real one would misattribute somebody
 * else's work.
 *
 * ⚠ AND NO INVENTED NAME CARRIES A CENTRE POST. Staff are referred to by role ("the field team",
 * "the Centre's conservator") and never by name. `people.ts` is written independently by somebody
 * else, and a post naming "the Centre's director, Dr So-and-so" would contradict the directory on
 * the day both are seeded. External speakers are named freely — they are not in that directory,
 * so nothing can disagree.
 *
 * JUDGEMENT CALLS WORTH KNOWING ABOUT.
 *
 *   • The Centre is placed in Pune, at an invented street address, with room names of its own. It
 *     had no location before this file; something had to be written on the event pages, and a real
 *     institution's address on a fictional centre's event listing is the one thing a venue field
 *     must never contain. One event is held off-site in Bhuj, because a craft centre that never
 *     leaves its own building is not a credible one.
 *   • Online addresses use `example.org`, which IANA reserves for exactly this. A tidier-looking
 *     invented domain is a domain somebody can register.
 *   • Registration is CLOSED on every past event without exception. It is the one field here that
 *     can contradict the date on its own card, and "register now" under a talk from last March is
 *     the kind of detail that makes a reader distrust everything else on the page.
 */

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Posts
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Five categories and no more.
 *
 * A newsroom that files eighteen posts under fourteen categories has a filter bar of buttons that
 * each return one item, which is worse for a reader than no filter at all. Tags carry the fine
 * detail instead, and they are allowed to be numerous because they overlap: a post tagged both
 * "madder" and "ajrakh" is reachable from either.
 */
export const POSTS: SeedPost[] = [
  {
    slug: "ajrakh-water-survey-completed",
    title: "The water survey at Ajrakhpur is finished",
    subtitle: "Eleven months of measurements from the wash tanks, and a finding the printers gave us first",
    excerpt:
      "A year of sampling at the ajrakh wash tanks supports what the printers had said from the beginning: the rinse water, not the dye bath, decides how deep the red goes.",
    bodyParagraphs: [
      "Ajrakh is a resist-printed cloth of Kachchh and of Sindh across the border, worked in natural dyes through a long alternation of printing, dyeing and washing. A single length is washed more often than it is printed, and the washing is not a tidying-up stage between the interesting ones. It is where mordants are carried off or driven home, and where a printer decides whether a piece has come right.",
      "The printers told us at the first meeting that the water was the difficult part. That is not a general remark in Ajrakhpur. The settlement exists because of water: printing families moved here after the earthquake of 2001, when the supply they had used at Dhamadka became unworkable. A craft that relocated over its rinse water is a craft that knows what the rinse water does.",
      "The survey sampled at each wash stage in three workshops, once a month for eleven months, recording hardness, pH and temperature alongside the stage of the sequence and the season. Nothing about the process was altered for the survey; the sampling was arranged around the working day rather than the other way round, which is why it took eleven months rather than four.",
      "The depth and evenness of the madder red tracks the mineral content of the rinse water more closely than it tracks the length of the dye bath. That is consistent with what dyers working in madder elsewhere report — calcium-rich water has long been prized for these reds — but it had not been measured in this sequence, in these tanks, across a full year of a supply that changes with the season.",
      "The workshop-level figures are not published. The printers asked that their individual tanks not be identifiable, on the straightforward ground that a number attached to a named workshop becomes a claim about that workshop's cloth. The aggregated series is in the archive, and the method note is with it, so the same measurements can be taken somewhere else and compared.",
      "A dry-season repeat is planned. The question the printers want answered is not the one the survey set out to answer: they would like to know whether a treatment applied to the incoming supply would remove the seasonal swing without changing the reds, and that is a different study."
    ],
    category: "Fieldwork",
    tags: ["ajrakh", "block printing", "Kachchh", "natural dyes", "madder", "indigo", "water"],
    publishedDaysAgo: 3,
    photo: "block-print",
    isFeatured: true
  },

  {
    slug: "correction-bidriware-is-not-brass",
    title: "A correction: bidriware is not blackened brass",
    subtitle: "What our first catalogue entry said, what is actually happening, and why the difference matters",
    excerpt:
      "Our earliest catalogue entry for a bidri tray described its body as blackened brass; it is a zinc alloy, and that distinction is the whole reason the black holds.",
    bodyParagraphs: [
      "Bidriware is made in Bidar, in northern Karnataka: silver — sometimes brass — inlaid into a dark metal ground, so the pattern reads as bright line against a matt black field. The entry we wrote for the first tray to enter the collection called that ground \"blackened brass\". It is not, and the error was ours rather than inherited from anybody who told us.",
      "The body is an alloy in which zinc greatly predominates, with a small proportion of copper. After the inlay is set, the surface is treated with a paste that turns it permanently black while leaving the inlaid silver bright. The black belongs to the zinc. A copper-rich brass will not take it, which is why the alloy is made in the proportion it is made in and not in a more convenient one.",
      "The paste is made up with soil taken from the fort at Bidar. This is the part most often reported as folklore and it is not folklore: the soil is genuinely a working ingredient, and craftspeople distinguish between soil that works and soil that does not. We are not in a position to say with confidence which constituent is doing the work, so this entry no longer says.",
      "The mistake came in through a sale listing. Somebody drafting at speed took a phrase from an auction description, and \"blackened brass\" is a phrase that appears in a great many of them. It passed review because it read like the sort of thing a catalogue says.",
      "The entry has been rewritten and carries a note of the change with its date, which is our standing practice: a record that is silently corrected is a record whose earlier readers were never told. Anyone who cited the original description can see what it said and what replaced it.",
      "We would rather be told. The correspondence address on the contact page reaches the archive team, and a correction from somebody who works in the material takes precedence over the version already published."
    ],
    category: "Archive",
    tags: ["bidriware", "Bidar", "metalwork", "zinc", "silver inlay", "corrections", "cataloguing"],
    publishedDaysAgo: 9,
    photo: "bidriware"
  },

  {
    slug: "kantha-collection-catalogued",
    title: "One hundred and forty kanthas, now catalogued",
    excerpt:
      "The Ochre House textile collection has been catalogued piece by piece, and the resulting records say plainly how much about each one is unknown.",
    bodyParagraphs: [
      "A kantha is made from cloth that has already had a life. Worn saris and dhotis are layered and held together with running stitch, densely enough that the quilting itself becomes the surface, and the thread is frequently drawn from the coloured borders of the same worn cloth. The figurative kind, nakshi kantha, carries scenes and motifs across the field; plainer ones are quilted in rows and are no less skilled for it.",
      "The Ochre House Collection holds a hundred and forty of them, assembled privately over four decades and never described in any detail. Under the partnership announced last year, the whole of it has now been catalogued at the Centre and returned.",
      "Each record carries measurements, layer count, stitch density sampled at three points, fibre identification where it could be made without taking a sample, condition, and photographs of both faces. Both faces matter: on many pieces the reverse tells you more about the order of work than the front does.",
      "What most records do not carry is a maker. Kantha was domestic work, and the great majority of surviving pieces reached collections without a name attached. The catalogue says so in each case rather than offering a district and a decade as though they were an attribution. Where the collector recorded where a piece was acquired, that is given as an acquisition note and labelled as one, because where something was bought is not where it was made.",
      "The records are searchable from the archive, and the collection itself remains with its owner. Requests to examine a piece are passed on rather than decided here."
    ],
    category: "Archive",
    tags: ["kantha", "Bengal", "embroidery", "running stitch", "textiles", "cataloguing", "collections"],
    publishedDaysAgo: 16,
    photo: "kantha"
  },

  {
    slug: "documentation-fellowships-open",
    title: "Two documentation fellowships are open",
    subtitle: "Eleven months, for one practice recorded properly",
    excerpt:
      "Applications are open for two eleven-month fellowships to document a single craft practice in depth, and practitioners are as welcome to apply as researchers.",
    bodyParagraphs: [
      "The Centre is offering two fellowships, funded by the Loom and Kiln Trust, for the sustained documentation of one practice. Eleven months, one craft, one place. The length is deliberate: a season is not enough to see a material supply change, and most of what this work is for happens between seasons.",
      "A fellow spends the bulk of the period with the practice rather than with the literature. The output is a documented record — process, vocabulary, materials, tools, the judgements a practitioner makes without being able to say why — deposited in the archive under terms agreed with the people it came from. A written piece may follow. It is not the point.",
      "Practitioners are explicitly eligible and are encouraged to apply. A person who has worked in a craft for twenty years is documenting something they already understand, which is a different and frequently better proposition than a researcher learning it from the beginning. Applications from practitioners may be made in Hindi, Marathi, Gujarati, Bengali, Tamil, Telugu or Kannada, and may be submitted as a recording rather than as a written document.",
      "The award covers a stipend, travel, recording equipment and a modest budget for payments to the people whose time the work takes. That last line is not an afterthought: unpaid participation is a cost borne by the person with the least money in the arrangement, and a proposal that has not budgeted for it will be asked about it.",
      "Applications close at the end of next month. The full terms, the eligibility notes and the form are on the fellowships page, and questions about whether a particular proposal fits are better asked before submission than after."
    ],
    category: "Teaching",
    tags: ["fellowships", "documentation", "funding", "applications", "fieldwork"],
    publishedDaysAgo: 24
  },

  {
    slug: "talim-notation-paper",
    title: "A paper on talim, the notation that plans a kani shawl",
    subtitle: "A woven pattern that is written down before it is woven, in a script most of its readers cannot read",
    excerpt:
      "The Centre's first paper on kani weaving describes talim, the coded script that turns a painted design into a set of instructions a weaver can be read aloud from.",
    bodyParagraphs: [
      "A kani shawl is not woven with a shuttle. The weft is carried by small wooden sticks, one loaded with each colour in play, and a weaver may have dozens of them across the width of a fabric that advances perhaps a centimetre in a good day. Nothing about that process lets a weaver look at a painting and work out what to do next.",
      "What sits between the design and the loom is talim: a coded notation, written out by a specialist from the painted design, in which the marks record how many warp threads take which colour, pass by pass, for the whole length of the piece. It is read aloud while the weavers work. A shawl is therefore composed twice — once as an image and once as an instruction — and the second version is the one the loom actually follows.",
      "The paper describes the structure of the notation as it was found in working use, the division of labour between the person who writes it and the people who weave from it, and what happens at the seams where two weavers working from the same talim meet in the middle of a fabric.",
      "It also records something the field team did not expect. The notation is not standardised across workshops in the way a printed system would be. Conventions travel with the person who writes them, and a talim written for one workshop is not straightforwardly legible in another — which makes an inherited talim a document with a limited number of competent readers, and a decreasing one.",
      "The paper appears in the Journal of Material Practice and is open access. The examples reproduced in it are published with the agreement of the workshops they came from, and two sequences were withdrawn at their request before submission.",
      "A follow-up is in preparation on the transfer of a design from painting to notation, which is the stage at which most of the interpretive decisions are made and the stage about which least has been written."
    ],
    category: "Research",
    tags: ["pashmina", "kani", "talim", "Kashmir", "weaving", "notation", "publications"],
    publishedDaysAgo: 31,
    photo: "pashmina",
    isFeatured: true
  },

  {
    slug: "obituary-sarasamma-devineni",
    title: "Sarasamma Devineni, 1944–2026",
    subtitle: "A kalamkari painter of Srikalahasti, and one of the first people to record with the Centre",
    excerpt:
      "Sarasamma Devineni, who painted narrative kalamkari at Srikalahasti for more than fifty years and gave the Centre nineteen hours of her time, has died at the age of eighty-one.",
    bodyParagraphs: [
      "Sarasamma Devineni worked in the freehand kalamkari of Srikalahasti, in which the design is drawn onto prepared cloth with a bamboo pen bound with a wad that meters the flow, rather than printed from blocks as it is at the other centre of the craft. She painted narrative cloths for most of her working life, and she was still working, more slowly, in the year before she died.",
      "Her preparation was the part she was most exacting about. Cloth treated with myrobalan before drawing; the black drawn in a liquor made from iron and jaggery left to ferment, which develops on the cloth rather than arriving at its final colour from the pen; reds raised with mordants and a madder bath. She would not begin on a cloth she had not prepared herself, and she thought the habit of buying in prepared cloth was the change that had done the most damage to the craft.",
      "She recorded with the Centre over four sessions in its first year, nineteen hours in all, most of it at her own table with the work in front of her. She was patient with questions and short with flattery. Asked at one point what she would want written down if only one thing could be, she said the order of the washes.",
      "She taught within her family and, later, outside it. Several of the painters now working in the town learnt some part of what they do from her, and she was unsentimental about that: she said more than once that she had taught people who had gone on to do it better.",
      "Her recordings remain closed for the present. She had agreed to their eventual release and her family has asked for time before that happens, which is theirs to ask for. When they are opened they will be opened in full, with the questions in them as well as the answers.",
      "The Centre has written to her family. Anyone who worked with her and would like to add to what is held about her practice is welcome to write to the archive."
    ],
    category: "The Centre",
    tags: ["kalamkari", "Srikalahasti", "Andhra Pradesh", "natural dyes", "obituary", "oral record"],
    publishedDaysAgo: 40,
    photo: "kalamkari"
  },

  {
    slug: "bandhani-workshop-report",
    title: "Three days of tying, and a table of failures",
    subtitle: "What a bandhani workshop taught the people who thought they were running it",
    excerpt:
      "Twelve participants spent three days learning to tie bandhani resists, and the most useful record to come out of it was the tray of pieces that went wrong.",
    bodyParagraphs: [
      "Bandhani is a resist-dyed cloth of Gujarat and Rajasthan in which the pattern is made before the dye, by pulling up minute points of fabric and binding each one so tightly that the dye cannot enter. A single cloth may carry many thousands of these. The tying is done by hand, at speed, frequently by women working at home, and the fingernail is a tool in it.",
      "The workshop was led by a bandhani tier from Kachchh, who set the twelve participants to work on plain cotton and did not slow down for them. Nobody in the room produced a usable cloth. That was expected and was more or less the point.",
      "What was recorded was not the technique in the abstract but the failure modes: which knots slip in the bath, what a resist that was pulled too shallow looks like after dyeing, how a row loses its spacing when the tier's attention goes, and the difference between a point that resisted and a point that resisted at the surface only. Fifty-two failed pieces were photographed, labelled with what had gone wrong and kept.",
      "That tray is now a teaching set. A beginner shown a perfect cloth learns that the craft is difficult; a beginner shown forty ways of getting it wrong, each labelled, learns what to watch for. It is also a diagnostic reference for the archive, since a slipped resist in a historical piece looks exactly like a slipped resist made last week.",
      "The tier's own observation, made at the end of the second day, is in the record too: that the participants were tying with their eyes, and that after a few years the hands stop consulting them. It is the sort of remark that is easy to nod at and difficult to write a method around, and it is one of the reasons the workshop was recorded rather than merely held.",
      "A second workshop is planned. The failures from the first will be on the table at the start of it."
    ],
    category: "Teaching",
    tags: ["bandhani", "Kachchh", "Gujarat", "resist dyeing", "workshops", "teaching"],
    publishedDaysAgo: 52,
    photo: "bandhani"
  },

  {
    slug: "kolam-dataset-released",
    title: "A dataset of 1,120 kolam figures",
    subtitle: "Recorded at thresholds over one season, with their dot grids, and released openly",
    excerpt:
      "Eleven hundred and twenty kolam figures have been recorded at doorsteps over a single season and released with their dot grids as an open dataset.",
    bodyParagraphs: [
      "A kolam is drawn on the ground at a threshold, usually at dawn, usually in rice flour, and it is gone by the end of the day. Most are laid out on a grid of dots set down first, and a large family of them are made from a single continuous line that loops around the dots without crossing itself and returns to where it started. The grid is not scaffolding to be hidden; it is the thing the figure is composed against.",
      "The dataset holds 1,120 figures recorded over one season in three neighbourhoods. Each entry carries a photograph of the figure, the dot grid transcribed as a machine-readable array, the date, and whether the figure was drawn as a single line or built from several. Where the household described the figure — as belonging to a particular day, or to a particular family — that description is recorded in the words used.",
      "The grid transcription is the part that took the work. A photograph of a kolam is not a representation of its structure, and a figure whose grid has been recorded can be compared, counted, grouped and tested against the accounts of kolam that have been given in mathematics and in computer science. That literature has generally worked from small published samples. This is a larger one, recorded in use.",
      "Consent was asked at every doorstep and refused at some. No photograph in the set shows a person, no entry records a house number or a name, and the neighbourhood is given at the level of the neighbourhood. Several households asked to see the photograph before it was kept, which was the arrangement in any case.",
      "The set is released under an open licence and can be downloaded from the archive. The Centre would like to see it used by people it has not thought of, which is the usual argument for releasing data and, in this case, the actual reason.",
      "It is one season and three neighbourhoods, and it should not be read as a description of kolam in general. A second season is being recorded elsewhere, deliberately in a place with different practice, so that the first can be checked against something."
    ],
    category: "Fieldwork",
    tags: ["kolam", "Tamil Nadu", "datasets", "open data", "geometry", "fieldwork", "consent"],
    publishedDaysAgo: 67,
    photo: "kolam",
    isFeatured: true
  },

  {
    slug: "partnership-ochre-house-collection",
    title: "A three-year partnership with the Ochre House Collection",
    excerpt:
      "The Centre will catalogue and conserve the Ochre House Collection's textiles over three years, and the records will be public even though the objects are not.",
    bodyParagraphs: [
      "The Ochre House Collection is a private holding of some six hundred textiles, assembled over four decades and, until now, undescribed outside a handwritten acquisition ledger. Under an agreement signed this month, the Centre will catalogue the whole of it over three years, with condition assessment and conservation treatment where a piece needs it.",
      "The terms are worth stating because they are the terms that made the agreement possible. The objects stay with their owner. The records — measurements, structure, materials, condition, photographs — become part of the Centre's public archive and remain there whatever happens to the collection afterwards. Neither party can withdraw a record once it is published.",
      "That last clause is the one that took the longest to settle. A catalogue that can be recalled is a catalogue a scholar cannot cite, and a private collection that is described and then closed has cost the public record more than it gave it.",
      "Access to the objects themselves is at the owner's discretion, and the Centre does not decide it. Requests are forwarded, which is the honest arrangement rather than a promising one.",
      "Work begins with the quilted pieces, which are the most numerous and the most fragile. The kantha group has already been completed and its records are searchable."
    ],
    category: "The Centre",
    tags: ["partnerships", "collections", "cataloguing", "conservation", "textiles"],
    publishedDaysAgo: 84
  },

  {
    slug: "phulkari-exhibition-opens",
    title: "Worked from the back: an exhibition of phulkari",
    subtitle: "Twenty-eight pieces, hung so that the reverse can be seen",
    excerpt:
      "A display of twenty-eight phulkari pieces opens this week, hung away from the wall so that the side the embroiderer actually looked at can be seen.",
    bodyParagraphs: [
      "Phulkari is a Punjabi embroidery worked in floss silk on coarse handspun ground cloth, in a darning stitch that is counted and worked from the reverse of the fabric. The embroiderer sees the back. The face that everyone else looks at is the one she is not looking at while she makes it, and the density of the work is what turns a countable stitch into a surface that reads as woven.",
      "Where the stitching covers the ground entirely the piece is called a bagh. The effect depends on the direction the floss lies in: the same colour worked at different angles reads as two colours under a single light, and a photograph flattens that out almost completely.",
      "The exhibition takes both facts seriously. Twenty-eight pieces are hung clear of the wall so that both faces can be examined, and the lighting is angled rather than flat, which is unusual in a textile display and is the reason the room is dimmer than a visitor might expect.",
      "The labels give the ground cloth, the stitch, the condition and, where it is known, the provenance. Where it is not known they say so. Several pieces here have no history before the dealer who sold them, and a label that invents a district for such a piece is manufacturing evidence that other people will later cite.",
      "The display is free and open during archive hours. A walkthrough with the curator is scheduled, and the Centre will run a second one if the first fills."
    ],
    category: "Archive",
    tags: ["phulkari", "Punjab", "embroidery", "bagh", "exhibitions", "textiles"],
    publishedDaysAgo: 103,
    photo: "phulkari"
  },

  {
    slug: "blue-pottery-body-paper",
    title: "A paper on the blue pottery body, which contains no clay",
    excerpt:
      "Jaipur's blue pottery is made from a body that contains no clay at all, and a new paper measures how much its composition varies between workshops.",
    bodyParagraphs: [
      "The first thing to say about Jaipur blue pottery is that it is not, in the usual sense, pottery. The body contains no clay. It is built instead from ground quartz with powdered glass, fuller's earth, borax and gum, worked into a paste, pressed into moulds rather than thrown, and fired at a low temperature.",
      "That composition explains most of what is otherwise puzzling about the ware. It is why the pieces are light, why the white ground beneath the cobalt blue is so bright, why the forms are the forms they are — a body without plasticity cannot be raised on a wheel — and why the finished object is brittle in a way earthenware is not.",
      "The paper reports the composition of bodies taken from working batches in several workshops, together with the firing schedules in use. The variation between workshops is considerable and does not appear to be random: proportions are adjusted by feel, in response to the batch of quartz and to the weather, and the practitioners describe those adjustments in terms of how the paste behaves rather than in proportions.",
      "The most practically useful result concerns losses in the firing. A meaningful part of a workshop's output cracks, and the rate correlates with the proportion of glass in the body more than with the schedule. That is a finding a workshop can act on, and it was given to the participating workshops before it was submitted anywhere.",
      "The paper is in Studies in South Asian Craft. Its samples were taken with consent from batches that had already been mixed for production, so nothing was made for the study and nobody's day was interrupted for it."
    ],
    category: "Research",
    tags: ["blue pottery", "Jaipur", "Rajasthan", "ceramics", "quartz", "materials", "publications"],
    publishedDaysAgo: 128,
    photo: "blue-pottery"
  },

  {
    slug: "chikankari-stitch-index",
    title: "An index of chikankari stitches, in the words the workshops use",
    subtitle: "Thirty-one named stitches, and no attempt to reconcile the names",
    excerpt:
      "A working index of chikankari stitches has been published in the names each workshop actually uses, with the disagreements between them left visible.",
    bodyParagraphs: [
      "Chikankari is a white-on-white embroidery of Lucknow, worked on fine cotton and muslin, and it is not one stitch but a repertoire. Some are worked on the face; the shadow work is worked on the reverse, so the thread shows through the cloth as a softened tone rather than as a line; several are knots, made and set in different ways.",
      "The stitch that gives most people the wrong idea is the openwork. It looks like cut-work and it is not: the threads of the ground are pushed apart with the needle to open a hole, and stitching holds them in their new positions. Nothing is removed. A piece with genuine openwork has lost none of its ground, which is one of the ways it can be distinguished from an imitation.",
      "The index records thirty-one stitches as they were named in six workshops, with a photograph of each at working scale, a photograph of the reverse, and the sequence of movements. Every entry says which workshop the name came from.",
      "It does not reconcile the names, and that is the editorial decision the index exists to make. Two workshops may use one name for different stitches, or two names for what is visibly the same one. A single standardised vocabulary would be more convenient for a database and would destroy the information that the disagreement carries — about where a workshop's practice came from, and about which distinctions matter to the people making them.",
      "Anyone who works in chikankari and finds their own usage missing or misdescribed is asked to write. The index is versioned and every change is dated, so an entry that alters is not an entry that quietly becomes something else."
    ],
    category: "Archive",
    tags: ["chikankari", "Lucknow", "Uttar Pradesh", "embroidery", "vocabulary", "cataloguing"],
    publishedDaysAgo: 145,
    photo: "chikankari"
  },

  {
    slug: "channapatna-lacquer-survey",
    title: "The constraint at Channapatna is the wood",
    subtitle: "A survey of forty-one turning workshops",
    excerpt:
      "A survey of forty-one Channapatna workshops finds that the limit on the craft is not skill or demand but the supply of the soft wood it has always been turned from.",
    bodyParagraphs: [
      "The lacquered toys of Channapatna, in Karnataka, are turned on a lathe from a soft pale wood and coloured with lac. The lac is applied to the spinning piece so that friction melts it onto the surface, and it is then burnished — traditionally with a screwpine leaf held against the work — until it takes a shine. The colour is in the lacquer, not under it.",
      "The survey visited forty-one workshops over four months, recording what is made, in what quantity, from what stock of wood, with what colourants, and by how many people. It was designed to record the process. What came back was, in nearly every conversation, a supply problem.",
      "The wood the craft is built around is soft, close-grained and pale, which is what allows the fine turning and what lets the lac colour sit true. Workshops reported it as harder to obtain and more expensive year on year, and several have moved to substitutes for part of their range. The substitutes turn differently and take the lacquer differently, and the turners can tell which is which by the sound of the cut.",
      "Demand was not reported as the limit. Neither was skill: the workshops surveyed were training people, and were not short of them. The reported constraint was the raw material, and it is the one a survey of the craft's technique would have failed to notice entirely if the question had not been asked.",
      "Colourants divided the sample. Some workshops use only vegetable colouring, some use synthetic dyes in the lac, most use both depending on what a piece is for. The survey records what each workshop actually uses rather than what the craft is generally said to use, and those are not the same list.",
      "The report is in the archive with the schedule used, so it can be run again. The Centre has no standing on the supply question and has passed the findings to the growers' and turners' bodies that do."
    ],
    category: "Fieldwork",
    tags: ["Channapatna", "Karnataka", "lac", "wood turning", "toys", "materials", "livelihoods"],
    publishedDaysAgo: 160,
    photo: "channapatna"
  },

  {
    slug: "teaching-warli-a-note",
    title: "What a school workshop gets wrong about Warli painting",
    subtitle: "A note for teachers, written after we got it wrong ourselves",
    excerpt:
      "Warli painting is taught in schools as a set of shapes, and the thing that is lost in the translation is the part that makes it painting rather than pattern.",
    bodyParagraphs: [
      "Warli painting is the wall painting of the Warli people of Palghar district in Maharashtra and the country around it. It is made in white — rice paste — on a ground of earth, and its figures are built from a small number of geometric elements: circles, triangles and lines, with the human body typically two triangles meeting at a point.",
      "This is exactly the kind of description that makes a good school worksheet, and the worksheet is where the trouble begins. Reduced to its elements, Warli painting looks like a technique for making pleasing patterns out of simple shapes. Taught that way, what a class produces is a pattern, and what it learns is that a living ritual practice is a style.",
      "The paintings are made for occasions. The wedding painting is the clearest case: a particular composition, painted at a particular point in the proceedings, by particular people, in a house where a wedding is taking place. It is not a decoration applied to a wall that happened to be blank. Its content is the occasion.",
      "We ran a session that did it badly. Children copied figures from a sheet for an hour and went home pleased, and the Warli painter we had asked to lead it said afterwards, politely, that they had not been taught anything. She was right, and the note that follows was written with her.",
      "What we do now: the session begins with what the painting is for and who makes it, the elements are introduced as a way of building figures that do something rather than as a set of shapes, and the class composes a scene of their own with their own subject rather than copying one. Nobody leaves having made a Warli painting, and that is stated at the start. They leave having understood how one is put together, which is a smaller claim and a true one.",
      "The note is on the teaching pages, with the session plan, and it may be used and adapted freely."
    ],
    category: "Teaching",
    tags: ["Warli", "Palghar", "Maharashtra", "wall painting", "teaching", "schools"],
    publishedDaysAgo: 198,
    photo: "warli"
  },

  {
    slug: "pattachitra-conservation-report",
    title: "Sixty patas, and a coating that is failing",
    excerpt:
      "Condition work on sixty pattachitra paintings finds the prepared cloth ground, not the paint, to be what is most often failing.",
    bodyParagraphs: [
      "A pattachitra is painted on cloth that has been made into something closer to a board. Layers of cloth are stuck together and coated with a paste and a fine chalk, then burnished until the surface is smooth and hard enough to take a fine line. The Odia tradition centred on Raghurajpur and Puri is dominated by the Jagannath iconography; the painting is done with brushes made by the painter, in pigments prepared from mineral and other natural sources, and finished with a protective coating.",
      "The condition survey covered sixty pieces from three holdings. The pigment layer was, on the whole, in better order than expected. The failures are in the ground: the coated cloth is a laminate, and a laminate that has been rolled, stored damp or hung in a dry room separates.",
      "Where the layers have parted, the paint above them is intact and unsupported, which is the worst of both. It looks sound until it is handled. Eleven pieces in the sample were reclassified as unfit to handle on that basis, having previously been recorded as stable.",
      "The other recurring problem is the finish. The protective coating darkens and, on several pieces, has become brittle enough to craze. Removing it is a decision with no reversible version, and the survey has recommended against it in every case for the present.",
      "The report records treatment carried out, treatment declined, and the reasoning for both. The declined cases are the more useful half of it: a conservation record that lists only what was done tells the next conservator nothing about what was considered and rejected.",
      "Handling guidance for painted cloth of this construction has been rewritten and is on the archive pages. The short version is that these should be stored flat and should not be rolled, and that a piece which has been rolled should be opened by somebody who has seen the inside of one that failed."
    ],
    category: "Archive",
    tags: ["pattachitra", "Odisha", "Raghurajpur", "painting", "conservation", "collections"],
    publishedDaysAgo: 245,
    photo: "pattachitra"
  },

  {
    slug: "dhokra-alloy-paper",
    title: "What forty dhokra castings are made of",
    excerpt:
      "Analysis of forty dhokra castings shows an alloy that varies far more than the published descriptions of the craft suggest, and the reason is the scrap it is made from.",
    bodyParagraphs: [
      "Dhokra is lost-wax casting, worked by communities across Chhattisgarh, Odisha, West Bengal and Jharkhand. A clay core is built, covered in wax — frequently in fine threads, which is what gives the surface its characteristic coiled texture — then covered again in clay and fired, so that the wax runs out and molten metal takes its place. The mould is broken to release the object. Every piece is therefore unique, not as a marketing claim but as a consequence of the method.",
      "The technique is very old in the subcontinent, older by millennia than the communities now practising it, and it is usually described in the literature as being worked in brass or bell metal. The paper reports surface analysis of forty castings of known origin and finds the description too tidy.",
      "The metal is scrap. Workshops melt what they can buy, and what they can buy changes. The forty pieces vary widely in the proportions of copper, zinc and tin, and a number contain elements that arrived with the scrap rather than by intent. Two objects made in the same workshop in the same year can differ more than two objects made three hundred kilometres apart.",
      "That has a practical consequence for anybody trying to attribute an undocumented piece. Composition is not a reliable indicator of where a dhokra casting was made, and an attribution resting on it is resting on the metal trade of a particular year rather than on a workshop tradition.",
      "The analysis was non-destructive throughout, which limits what can be said: surface composition is not necessarily bulk composition, particularly on a cast object with a worked surface. The paper says so, and the sampling protocol is published with it.",
      "It appears in Studies in South Asian Craft. The castings analysed are in the Centre's collection and their records now carry the measurements."
    ],
    category: "Research",
    tags: ["dhokra", "lost-wax casting", "Bastar", "Chhattisgarh", "metalwork", "alloys", "publications"],
    publishedDaysAgo: 310,
    photo: "dhokra"
  },

  {
    slug: "reading-room-opens",
    title: "The reading room is open",
    excerpt:
      "The Centre's reading room has opened, with the reference collection, the field notebooks and a table for looking at things properly.",
    bodyParagraphs: [
      "The reading room opened this month. It holds the reference collection, the run of field notebooks from the first two seasons, the sample library, and the technical files that accompany the objects in the store.",
      "It is a small room and it is meant to be used. Six places, a large table, north light, and no restriction on who may book one. A researcher's affiliation is not asked for. Anybody who wants to look at what is here may write and arrange a time.",
      "The sample library is the part likely to be most useful and the part least likely to be found by anybody searching a catalogue. It holds dyed and undyed cloth, mordanted swatches, raw fibre, unfired and fired ceramic bodies, lac in the forms it arrives in, and the failed pieces from the workshops the Centre has run. Material can be handled. Several sets exist specifically to be handled.",
      "Field notebooks are consulted under the terms agreed with the people recorded in them, which vary notebook by notebook and are stated on each one's cover. Some are open, some are open with names redacted, and some are closed for a stated period. Nothing is closed without a reason recorded in the file.",
      "Booking is by email and the hours are on the visit page. The room closes when the archive closes, which is earlier than most people expect in winter."
    ],
    category: "The Centre",
    tags: ["reading room", "archive", "access", "reference collection", "visits"],
    publishedDaysAgo: 388,
    photo: "jaali"
  },

  {
    slug: "first-field-season-kachchh",
    title: "The first field season: Kachchh and north Gujarat",
    subtitle: "Eleven weeks, nine workshops, and a method that had to be rewritten twice",
    excerpt:
      "The Centre's first field season recorded nine workshops across Kachchh and north Gujarat, and produced a working method that looks very little like the one it started with.",
    bodyParagraphs: [
      "The first season ran for eleven weeks across Kachchh and north Gujarat, taking in block printers, tie-resist dyers, weavers and, at Patan, a double-ikat workshop where both the warp and the weft are resist-dyed to the pattern before anything is woven at all.",
      "The plan was to record process in a standard form: stages, timings, tools, materials, in a schedule designed in advance so that nine workshops could be compared. It survived about a fortnight.",
      "The first thing that broke it was that the stages are not the same stages. A sequence in which washing alternates with printing does not decompose into the same units as a sequence in which the pattern is complete before the loom is warped, and forcing both into one schedule produced records that were comparable and wrong.",
      "The second was vocabulary. Recording a stage in translation loses the distinctions the workshop makes, and those distinctions are frequently the finding. The method now takes terms in the language they are spoken in, unglossed, and translates afterwards in a separate pass that is kept separate on purpose.",
      "The third was time. A process that includes a fortnight of drying is not observable in a visit, and the season produced almost no usable record of anything slow. Later seasons are built around returning, which is more expensive and is the only way that particular problem can be solved.",
      "Nine workshops were recorded and all nine records are in the archive, including the early ones made with the schedule that did not work. They are labelled as such. A method that was revised twice in eleven weeks is a method whose earlier output has to be readable as earlier output, or the revision is not honest."
    ],
    category: "Fieldwork",
    tags: ["Kachchh", "Gujarat", "Patan", "patola", "block printing", "fieldwork", "method"],
    publishedDaysAgo: 470,
    photo: "patola"
  }
];

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Thirteen events, from about thirteen months back to four months ahead.
 *
 * ⚠ `startsInDays` IS RELATIVE, AND `isRegistrationOpen` HAS TO AGREE WITH IT. Every negative entry
 * below sets it false. It is the only field in this file that can contradict the date printed
 * beside it, and a "registration open" badge on a talk from last spring is what makes a reader stop
 * believing the rest of the page.
 *
 * The online addresses are on `example.org` — the domain IANA reserves for documentation. A more
 * convincing invented domain is one that somebody can go and register.
 */
export const EVENTS: SeedEvent[] = [
  {
    slug: "lecture-reading-a-shawl",
    title: "Reading a shawl before it is woven",
    subtitle: "Talim, and the people who can still read it",
    summary:
      "A public lecture on the coded notation that turns a painted design into instructions a kani weaver can be read aloud from.",
    bodyParagraphs: [
      "A kani shawl is woven with small wooden sticks rather than a shuttle, one for each colour in play, and the pattern is worked out in full before a thread is laid. What sits between the design and the loom is a written code: how many warp threads take which colour, pass by pass, for the length of the piece.",
      "Bashir Ahmad Wani has written that code for workshops in Srinagar for over thirty years. He will explain how a painted design is converted, why the conventions differ between workshops, and what happens when a talim outlives the person who wrote it.",
      "The lecture is in English and Urdu, with examples shown at working scale. It is online and free, and the recording will be published afterwards with the speaker's agreement."
    ],
    mode: "ONLINE",
    onlineUrl: "https://example.org/coe/events/lecture-reading-a-shawl",
    startsInDays: 6,
    durationHours: 1.5,
    capacity: 300,
    isRegistrationOpen: true,
    photo: "pashmina"
  },

  {
    slug: "workshop-two-days-at-the-printing-table",
    title: "Two days at the printing table",
    subtitle: "Hand block printing in natural dyes, with Rehana Sumar",
    summary:
      "A two-day workshop on resist and mordant block printing, held in Bhuj with a printer who has worked the sequence since she was fourteen.",
    bodyParagraphs: [
      "Resist printing in natural dyes is a sequence rather than a technique: printing, dyeing and washing alternate, and a length of cloth is washed more often than it is printed. Most of what decides the outcome happens in the stages that produce nothing visible.",
      "Participants work through a shortened version of the sequence on cotton, printing a resist, printing a mordant, taking the cloth through a dye bath and washing between each stage. Nobody completes a full sequence in two days. The point is to have handled each stage rather than to leave with a finished cloth.",
      "Fourteen places. No experience is required and none is assumed; the workshop is held in Hindi and Gujarati with translation. Cloth, dyes and blocks are provided. Bring clothes that can be ruined, because they will be.",
      "The workshop is held at the district craft hall in Bhuj rather than at the Centre. The tanks are there and so are the people."
    ],
    mode: "IN_PERSON",
    venue: "District Craft Hall, Bhuj",
    address: "Craft Hall, Station Road, Bhuj, Kachchh, Gujarat",
    latitude: 23.242,
    longitude: 69.6669,
    startsInDays: 12,
    durationHours: 12,
    capacity: 14,
    isRegistrationOpen: true,
    agenda: [
      { title: "Preparing the cloth", detail: "Scouring, and why an unprepared cloth takes colour unevenly.", startsAt: "09:30", speaker: "Rehana Sumar" },
      { title: "Printing a resist", detail: "Registering the block, and reading the sound of the impression.", startsAt: "11:00", speaker: "Rehana Sumar" },
      { title: "Mordants", detail: "What a mordant does, and what it does when it is printed unevenly.", startsAt: "14:00", speaker: "Rehana Sumar" },
      { title: "The dye bath and the wash", detail: "Day two. The bath, the rinses, and the pieces that go wrong.", startsAt: "09:30", speaker: "Rehana Sumar" },
      { title: "Looking at the results together", detail: "Each piece examined, including the failures, which are the more instructive half.", startsAt: "15:00" }
    ],
    photo: "block-print",
    isFeatured: true
  },

  {
    slug: "walkthrough-worked-from-the-back",
    title: "Walkthrough: Worked from the back",
    summary:
      "An hour in the gallery with the curator of the phulkari display, which is hung so that both faces of each piece can be seen.",
    bodyParagraphs: [
      "Phulkari is worked from the reverse of the cloth in a counted darning stitch, so the embroiderer sees the side nobody else looks at. The display is hung clear of the wall for that reason, and lit at an angle so that the direction of the floss silk reads as it does in the hand.",
      "The walkthrough goes through eight pieces in detail: the ground cloth, the stitch, what the reverse tells you about the order of work, and what can and cannot be said about where each piece came from.",
      "Twenty-five places, free. The gallery is on the ground floor and is step-free throughout. A second walkthrough will be scheduled if this one fills."
    ],
    mode: "IN_PERSON",
    venue: "The Gallery, Craft Archive Building",
    address: "14 Sahyadri Road, Aundh, Pune 411007",
    latitude: 18.559,
    longitude: 73.8074,
    startsInDays: 25,
    durationHours: 1,
    capacity: 25,
    isRegistrationOpen: true,
    photo: "phulkari"
  },

  {
    slug: "seminar-measuring-colour",
    title: "Measuring colour without taking a sample",
    subtitle: "Methods seminar",
    summary:
      "A working seminar on non-destructive colour measurement for textiles, and on the difference between what the instrument records and what the eye is doing.",
    bodyParagraphs: [
      "Colour is the property most often described in a catalogue and the one most often described badly. A named colour is a judgement made under one light by one person; a measured colour is a set of numbers that is reproducible and that frequently fails to match anybody's description of the same cloth.",
      "The seminar covers instrument choice, geometry, the effect of the textile's own structure on a reading, and how to record enough metadata that a measurement taken now can be compared with one taken in ten years.",
      "It is a working session rather than a lecture. Participants are asked to bring a measurement problem of their own, and the second half is spent on those. Attend in the seminar room or online.",
      "Led by Dr Sneha Pillai of Riverbank College of Art and Conservation, with the Centre's conservation team."
    ],
    mode: "HYBRID",
    venue: "Seminar Room 1, Craft Archive Building",
    address: "14 Sahyadri Road, Aundh, Pune 411007",
    latitude: 18.559,
    longitude: 73.8074,
    onlineUrl: "https://example.org/coe/events/seminar-measuring-colour",
    startsInDays: 41,
    durationHours: 3,
    capacity: 40,
    isRegistrationOpen: true
  },

  {
    slug: "symposium-what-a-record-cannot-hold",
    title: "What a record cannot hold",
    subtitle: "A one-day symposium on the limits of documentation",
    summary:
      "Practitioners, archivists and researchers spend a day on the parts of a craft that documentation reliably fails to capture, and on what to do about it.",
    bodyParagraphs: [
      "Every documentation method makes a choice about what counts as the thing being documented. Photographs privilege the object, recordings privilege what can be said aloud, and measurement privileges what can be measured. What falls outside all three is, frequently, the knowledge that took twenty years to acquire.",
      "The symposium takes that as its subject rather than as a caveat. Six sessions, half of them led by practitioners, on judgement, timing, touch, failure, the vocabulary of faults, and the question of who the record is for.",
      "It is deliberately small. A hundred and twenty places in the room, unlimited online, and the discussion periods are longer than the papers. Lunch and tea are provided; the room is step-free and a hearing loop is fitted.",
      "Papers are not published as proceedings. A summary of the discussion is written afterwards and circulated to everybody who spoke, for correction, before it goes into the archive."
    ],
    mode: "HYBRID",
    venue: "The Long Room, Craft Archive Building",
    address: "14 Sahyadri Road, Aundh, Pune 411007",
    latitude: 18.559,
    longitude: 73.8074,
    onlineUrl: "https://example.org/coe/events/symposium-what-a-record-cannot-hold",
    startsInDays: 58,
    durationHours: 8,
    capacity: 120,
    isRegistrationOpen: true,
    agenda: [
      { title: "Registration and tea", startsAt: "09:00" },
      { title: "Opening: what this day is for", detail: "Ten minutes, and then out of the way.", startsAt: "09:45" },
      { title: "Judgement", detail: "How a practitioner knows a stage is finished, and whether that can be written down.", startsAt: "10:00", speaker: "Rehana Sumar" },
      { title: "The vocabulary of faults", detail: "What workshops call the things that go wrong, and why those names are the most useful part of a technical vocabulary.", startsAt: "11:15", speaker: "Farida Sheikh" },
      { title: "Lunch", startsAt: "12:30" },
      { title: "Recording what takes a fortnight", detail: "Slow processes, and the systematic bias of research visits towards the parts that are quick.", startsAt: "13:30", speaker: "Dr Anwar Hussain, Institute for Material Studies, Guwahati" },
      { title: "Who the record is for", detail: "A panel. Practitioners, an archivist and a funder, on the uses a record is actually put to.", startsAt: "14:45", speaker: "Shantabai Waghmare, Ratan Meher and Dr Meera Raut" },
      { title: "Open discussion", detail: "Unstructured, minuted, and circulated for correction afterwards.", startsAt: "16:00" }
    ],
    photo: "jaali",
    isFeatured: true
  },

  {
    slug: "open-day-at-the-centre",
    title: "Open day",
    summary:
      "The store, the sample library and the conservation bench, open to anyone who wants to see what is in them, with demonstrations through the afternoon.",
    bodyParagraphs: [
      "Once a year the working parts of the Centre are opened. The object store, the sample library, the conservation bench and the recording room are all open, and the people who work in them are there to be asked about it.",
      "Demonstrations run through the afternoon: a turner working on a lathe, a printer at the table, and a conservator explaining what is being done to a piece and why it will take four months.",
      "There is a room for children with material that is meant to be handled, and a table of failed workshop pieces that anybody may pick up.",
      "No booking is needed and there is no charge. The building is step-free; the store is reached by lift. Come at any point between eleven and five."
    ],
    mode: "IN_PERSON",
    venue: "Craft Archive Building",
    address: "14 Sahyadri Road, Aundh, Pune 411007",
    latitude: 18.559,
    longitude: 73.8074,
    startsInDays: 89,
    durationHours: 6,
    // Not a contradiction: there is nothing to register for. The body says so in as many words.
    isRegistrationOpen: false,
    photo: "channapatna"
  },

  {
    slug: "day-school-documenting-a-process",
    title: "Documenting a process: a day school",
    summary:
      "A one-day course in recording a craft process properly, for anybody who is about to try, using a natural-dye sequence as the worked example.",
    bodyParagraphs: [
      "Most first attempts at documenting a process record the object at the end of it. This day school is about the rest: the stages, the order, the tools, the vocabulary, the waiting, and the decisions a practitioner makes without narrating them.",
      "The worked example throughout is a natural-dye sequence, chosen because it is long, because much of it produces nothing to photograph, and because it goes wrong in instructive ways.",
      "Twenty places. It is aimed at people beginning a documentation project — students, curators, and practitioners intending to record their own work — and assumes no technical background. Equipment is provided for the practical sessions.",
      "Participants leave with the Centre's recording schedule, its consent templates, and a completed short record of their own."
    ],
    mode: "IN_PERSON",
    venue: "Seminar Room 1, Craft Archive Building",
    address: "14 Sahyadri Road, Aundh, Pune 411007",
    latitude: 18.559,
    longitude: 73.8074,
    startsInDays: 115,
    durationHours: 7,
    capacity: 20,
    isRegistrationOpen: true,
    agenda: [
      { title: "What you are actually recording", detail: "Process, object, person, place — and what each choice excludes.", startsAt: "09:30" },
      { title: "Consent, in practice", detail: "What a form covers, what it does not, and why it is revisited.", startsAt: "11:00" },
      { title: "Recording a sequence", detail: "Practical. A dye sequence, recorded in pairs, with the schedule.", startsAt: "13:00" },
      { title: "Vocabulary", detail: "Taking terms in the language they are spoken in, and translating in a separate pass.", startsAt: "15:00", speaker: "Dr Rukhsana Parveen, Riverbank College of Art and Conservation" },
      { title: "Reading each other's records", detail: "The part everybody finds uncomfortable and nobody regrets.", startsAt: "16:00" }
    ],
    photo: "kalamkari"
  },

  {
    slug: "lecture-forty-dhokra-castings",
    title: "What forty dhokra castings are made of",
    summary:
      "A lecture on the surface analysis of forty lost-wax castings, and on why composition turns out to be a poor guide to where a piece was made.",
    bodyParagraphs: [
      "Dhokra is usually described as being cast in brass or bell metal. Analysis of forty castings of known origin found an alloy that varies far more than that description allows, for a straightforward reason: the metal is scrap, and what a workshop can buy changes from year to year.",
      "The lecture sets out the method, the limits of non-destructive surface analysis on a cast and worked object, and the consequence for anybody attempting to attribute an undocumented piece.",
      "Given online, with the dataset available afterwards."
    ],
    mode: "ONLINE",
    onlineUrl: "https://example.org/coe/events/lecture-forty-dhokra-castings",
    startsInDays: -18,
    durationHours: 1,
    isRegistrationOpen: false,
    photo: "dhokra"
  },

  {
    slug: "workshop-a-day-of-running-stitch",
    title: "A day of running stitch",
    subtitle: "Kantha, with Nandita Bose",
    summary:
      "A day spent layering worn cloth and quilting it, on the principle that a stitch is best understood at the density it is actually worked.",
    bodyParagraphs: [
      "Kantha is made from cloth that has already been used: layers of worn sari and dhoti held together with running stitch, often with thread drawn from the borders of the same cloth. The stitch is simple. The density is not, and it is the density that turns quilting into a surface.",
      "Participants layered and quilted a small panel, working at a spacing set by the tutor rather than one they chose, which most found harder than expected.",
      "Sixteen places, all taken. Material was provided; participants were asked to bring worn cotton of their own and most did."
    ],
    mode: "IN_PERSON",
    venue: "Workshop 2, Craft Archive Building",
    address: "14 Sahyadri Road, Aundh, Pune 411007",
    latitude: 18.559,
    longitude: 73.8074,
    startsInDays: -47,
    durationHours: 6,
    capacity: 16,
    isRegistrationOpen: false,
    photo: "kantha"
  },

  {
    slug: "symposium-whose-record-is-it",
    title: "Whose record is it",
    subtitle: "A day on consent, ownership and the terms of access",
    summary:
      "A symposium on who controls a record of somebody else's knowledge, held with practitioners in the room rather than as its subject.",
    bodyParagraphs: [
      "Documentation produces an asset. It is held by an institution, catalogued by an institution and made available on an institution's terms, and the knowledge in it belongs to somebody else. That arrangement is normal and it is not obviously defensible.",
      "The day worked through it in specific cases: a recording released after the death of the person recorded, a motif catalogued and then used commercially by a third party, and a workshop that asked for its data to be withdrawn after publication.",
      "Half the speakers were practitioners. The summary of the discussion was circulated to everybody who spoke before it entered the archive, and two accounts were amended at their request.",
      "The consent templates the Centre now uses were rewritten as a result of this day, and are published for anybody to adapt."
    ],
    mode: "IN_PERSON",
    venue: "The Long Room, Craft Archive Building",
    address: "14 Sahyadri Road, Aundh, Pune 411007",
    latitude: 18.559,
    longitude: 73.8074,
    startsInDays: -96,
    durationHours: 7,
    capacity: 100,
    isRegistrationOpen: false,
    agenda: [
      { title: "Opening", startsAt: "10:00" },
      { title: "A recording released after a death", detail: "What was agreed, who was left to decide, and what the file now says.", startsAt: "10:15", speaker: "Dr Vikram Sathe, Deccan School of Design History" },
      { title: "A motif, catalogued and then sold", detail: "What publication made possible, and whether it should have.", startsAt: "11:30", speaker: "P. Lakshmi Devi" },
      { title: "Lunch", startsAt: "13:00" },
      { title: "Withdrawal after publication", detail: "A workshop's request, and what an archive can and cannot undo.", startsAt: "14:00", speaker: "Anjali Sahoo" },
      { title: "Rewriting the consent form, in the room", detail: "The working session that produced the templates now in use.", startsAt: "15:15" }
    ],
    photo: "madhubani"
  },

  {
    slug: "seminar-vocabulary-before-translation",
    title: "Recording a vocabulary before translating it",
    subtitle: "Methods seminar",
    summary:
      "A seminar on why a technical term standardised too early is a distinction destroyed, with examples from three field seasons.",
    bodyParagraphs: [
      "A workshop's own words for its tools, stages and faults carry distinctions that a translation flattens. Recording them in translation is therefore a loss that happens before anybody notices, because the resulting record reads perfectly well.",
      "The seminar set out the Centre's practice of taking terms unglossed and translating in a separate later pass, with worked examples of distinctions that survived the change of method and would not have survived the old one.",
      "Held online. The recording and the examples are in the archive."
    ],
    mode: "ONLINE",
    onlineUrl: "https://example.org/coe/events/seminar-vocabulary-before-translation",
    startsInDays: -180,
    durationHours: 1.5,
    isRegistrationOpen: false
  },

  {
    slug: "opening-the-pichwai-display",
    title: "Opening: the pichwai display",
    summary:
      "The opening of a small display of pichwai, the painted cloths hung behind the image in the shrines at Nathdwara and changed with the season.",
    bodyParagraphs: [
      "A pichwai is a painted cloth hung behind the deity in a shrine. At Nathdwara in Rajasthan they are changed through the year, so the cloth in place on a given day is a function of the festival calendar and the season rather than of a curator's preference.",
      "The display showed six cloths together with the calendar that governs them, which is the context in which they were made and the one a gallery ordinarily removes.",
      "The opening included a short talk on the iconography and on what a display of this kind necessarily takes away from the objects in it."
    ],
    mode: "IN_PERSON",
    venue: "The Gallery, Craft Archive Building",
    address: "14 Sahyadri Road, Aundh, Pune 411007",
    latitude: 18.559,
    longitude: 73.8074,
    startsInDays: -265,
    durationHours: 2,
    isRegistrationOpen: false,
    photo: "pichwai"
  },

  {
    slug: "inaugural-lecture",
    title: "The Centre's inaugural lecture",
    subtitle: "A craft is a memory that has to be used to survive",
    summary:
      "The lecture that opened the Centre, on why a record does not preserve a practice and what it can do instead.",
    bodyParagraphs: [
      "The argument of the lecture was that a record preserves nothing. Only practising a craft preserves it, and an archive that claims otherwise is selling comfort to people who are not the ones losing anything.",
      "What a record can do is make a practice legible from outside it — to a student choosing what to learn, to somebody deciding what to fund, to a historian a century from now — at a level of detail that supports rebuilding an understanding rather than admiring a photograph.",
      "The lecture set out the five stages that the Centre's method has followed since, and committed it publicly to the first of them: that nothing is recorded until the people whose knowledge it is have agreed what may be published.",
      "The text is in the archive."
    ],
    mode: "IN_PERSON",
    venue: "The Long Room, Craft Archive Building",
    address: "14 Sahyadri Road, Aundh, Pune 411007",
    latitude: 18.559,
    longitude: 73.8074,
    startsInDays: -400,
    durationHours: 1.5,
    isRegistrationOpen: false
  }
];

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Partners
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Thirteen partners across the five categories, all invented.
 *
 * ⚠ NO `url` ON ANY OF THEM, AND THAT IS THE POINT OF THE FIELD BEING OPTIONAL. Pointing a
 * fictional centre's partner logo at a real organisation's website asserts a relationship that
 * organisation has not agreed to, and inventing a domain claims one somebody else may register
 * tomorrow. An institution replacing this sample data with its real partners fills the field in.
 *
 * `sortOrder` groups them by category, because PARTNER_LOGOS renders one flat row and an
 * alphabetical mix of funders and community collectives reads as a list of logos rather than as a
 * statement about who the Centre works with.
 */
export const PARTNERS: SeedPartner[] = [
  { slug: "loom-and-kiln-trust", name: "The Loom and Kiln Trust", category: "Funder", sortOrder: 1 },
  { slug: "nine-rivers-fund", name: "Nine Rivers Fund for Cultural Research", category: "Funder", sortOrder: 2 },
  { slug: "chandrakala-endowment", name: "Chandrakala Endowment for Material Culture", category: "Funder", sortOrder: 3 },

  { slug: "deccan-school-of-design-history", name: "Deccan School of Design History", category: "Academic", sortOrder: 4 },
  { slug: "institute-for-material-studies", name: "Institute for Material Studies, Guwahati", category: "Academic", sortOrder: 5 },
  { slug: "riverbank-college", name: "Riverbank College of Art and Conservation", category: "Academic", sortOrder: 6 },

  { slug: "municipal-craft-museum-nashik", name: "Municipal Craft Museum, Nashik", category: "Museum", sortOrder: 7 },
  { slug: "ochre-house-collection", name: "The Ochre House Collection", category: "Museum", sortOrder: 8 },
  { slug: "highfield-museum", name: "Highfield Museum of South Asian Art", category: "Museum", sortOrder: 9 },

  { slug: "regional-handicrafts-board", name: "Regional Handicrafts Development Board", category: "Government", sortOrder: 10 },
  { slug: "district-craft-cluster-mission", name: "District Craft Cluster Mission", category: "Government", sortOrder: 11 },

  { slug: "printers-and-dyers-mutual", name: "The Printers' and Dyers' Mutual Society", category: "Community", sortOrder: 12 },
  { slug: "kalagram-artisans-collective", name: "Kalagram Artisans' Collective", category: "Community", sortOrder: 13 }
];
