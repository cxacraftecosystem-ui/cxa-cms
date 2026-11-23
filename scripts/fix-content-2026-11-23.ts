/**
 * The editor fixes from docs/OUTSTANDING.md ("Search-engine fixes that only an editor or the owner can
 * make"), applied to the stored content on 2026-11-23 — recorded here so they are reviewable and can be
 * read back later, the same reason scripts/set-centre-location.ts exists.
 *
 *   npx tsx scripts/fix-content-2026-11-23.ts            # preview: prints every change, writes nothing
 *   npx tsx scripts/fix-content-2026-11-23.ts --apply    # writes, then rebuilds the search index
 *
 * Reads DATABASE_URL from the environment. ⚠ `.env` here is the LOCAL database; pass production's URL
 * on the command line to write there.
 *
 * EVERY CHANGE NAMES THE VALUE IT EXPECTS TO FIND. A field already holding the new value is skipped, so a
 * second run does nothing; a record whose field holds anything else has been edited since this was
 * written, and the WHOLE record is left alone and reported rather than overwritten. Each record's
 * update and its audit entry (before and after, as the studio writes them) share one transaction.
 *
 * Where the facts come from: the alt text was written by looking at each picture; the second workshop's
 * address, the workshops' dates and the spelling "Shristi O Anusandhan" are as printed on the Centre's
 * own posters (the cover of each event and of the third workshop's article). The FAQ block is added to
 * About HIDDEN: it is new wording on a public page, so an editor reads it and switches it on.
 */

// First: loads .env before anything below reads the environment (see scripts/db.ts).
import { createScriptClient } from "./db";
import type { Prisma } from "@prisma/client";
import { faqSectionSchema } from "../lib/sections/schema";
import { reindexAll } from "../lib/search/index";
// The index is rebuilt through the app's own client (lib/db), a second pool to close at the end.
import { prisma as appPrisma } from "../lib/db";

const prisma = createScriptClient();
const APPLY = process.argv.includes("--apply");
const USER_AGENT = "scripts/fix-content-2026-11-23.ts (operator script)";

type Tx = Prisma.TransactionClient;
type Row = { id: string } & Record<string, unknown>;
type Fields = Record<string, readonly [from: string | null, to: string]>;

interface Target {
  entityType: string;
  /** How the record is named in the output and the audit entry. */
  name: string;
  find(tx: Tx): Promise<Row | null>;
  update(tx: Tx, id: string, data: Record<string, string>): Promise<Row>;
}

const person = (slug: string): Target => ({
  entityType: "Person",
  name: `person ${slug}`,
  find: (tx) => tx.person.findFirst({ where: { slug, deletedAt: null } }),
  update: (tx, id, data) => tx.person.update({ where: { id }, data: data as Prisma.PersonUpdateInput })
});
const publication = (slug: string): Target => ({
  entityType: "Publication",
  name: `publication ${slug}`,
  find: (tx) => tx.publication.findFirst({ where: { slug, deletedAt: null } }),
  update: (tx, id, data) => tx.publication.update({ where: { id }, data: data as Prisma.PublicationUpdateInput })
});
const album = (slug: string): Target => ({
  entityType: "GalleryAlbum",
  name: `album ${slug}`,
  find: (tx) => tx.galleryAlbum.findFirst({ where: { slug, deletedAt: null } }),
  update: (tx, id, data) => tx.galleryAlbum.update({ where: { id }, data: data as Prisma.GalleryAlbumUpdateInput })
});
const event = (slug: string): Target => ({
  entityType: "CoeEvent",
  name: `event ${slug}`,
  find: (tx) => tx.coeEvent.findFirst({ where: { slug, deletedAt: null } }),
  update: (tx, id, data) => tx.coeEvent.update({ where: { id }, data: data as Prisma.CoeEventUpdateInput })
});
const media = (id: string, fileName: string): Target => ({
  entityType: "MediaAsset",
  name: `picture ${fileName}`,
  find: (tx) => tx.mediaAsset.findFirst({ where: { id, deletedAt: null } }),
  update: (tx, rowId, data) => tx.mediaAsset.update({ where: { id: rowId }, data: data as Prisma.MediaAssetUpdateInput })
});

const SHRISTI = "Shristi O Anusandhan";

const CHANGES: ReadonlyArray<readonly [Target, Fields]> = [
  // ── Names: "Prof." needs its space, as every other name on the site has it.
  [person("dr-bhaskar-bhowmick"), { name: ["Prof.Bhaskar Bhowmick", "Prof. Bhaskar Bhowmick"] }],
  [person("prof-jitendra-mahakud"), { name: ["Prof.Jitendra Mahakud", "Prof. Jitendra Mahakud"] }],
  [person("prof-mamoni-banerjee"), { name: ["Prof.Mamoni Banerjee", "Prof. Mamoni Banerjee"] }],
  [person("prof-ram-babu-roy"), { name: ["Prof.Ram Babu Roy", "Prof. Ram Babu Roy"] }],
  [person("titas-bhattacharjee-rudra"), { name: ["Prof.Titas Bhattacharjee (Rudra)", "Prof. Titas Bhattacharjee (Rudra)"] }],
  [person("dr-arjun-mukherjee"), { name: ["Prof.Arjun Mukherjee", "Prof. Arjun Mukherjee"] }],
  [
    person("prof-jenia-mukherjee"),
    { name: ["Prof Jenia Mukherjee", "Prof. Jenia Mukherjee"], designation: ["Co- Chairperson", "Co-Chairperson"] }
  ],

  // ── Publications: a file name left as a title, a double space, a line break in an author line, and
  // the two workshop reports, which had no abstract and so shared one generated description.
  [
    publication("publicity-booklet-dabu-hand-block-printing"),
    {
      title: ["PUBLICITY BOOKLET_DABU HAND BLOCK PRINTING", "Publicity Booklet: Dabu Hand Block Printing"],
      authorLine: [
        "Centre of Excellence for\nUnified AI-Enabled Craft Ecosystem Platform",
        "Centre of Excellence for Unified AI-Enabled Craft Ecosystem Platform"
      ]
    }
  ],
  [
    publication("the-first-craft-toolkit-workshop-srishti-o-anusandhan"),
    {
      title: ["The First Craft Toolkit Workshop (Srishti O Anusandhan)", `The First Craft Toolkit Workshop (${SHRISTI})`],
      abstract: [
        null,
        `Report of the First Craft Toolkit Workshop (${SHRISTI}), on the wood carving traditions of India, held from 25 March to 2 April 2026 at IIT Kharagpur.`
      ]
    }
  ],
  [
    publication("the-second-craft-toolkit-workshop-srishti-o-anusandhan"),
    {
      title: ["The  Second Craft Toolkit Workshop (Srishti O Anusandhan)", `The Second Craft Toolkit Workshop (${SHRISTI})`],
      abstract: [
        null,
        `Report of the Second Craft Toolkit Workshop (${SHRISTI}), on cane, bamboo and hand block printing, held from 17 to 27 June 2026 at IIT Kharagpur.`
      ]
    }
  ],

  // ── Albums: a file name left as a title; the first workshop's photographs shared their title with
  // its report (now named like the second workshop's album); the second album shared its description
  // with its event.
  [
    album("first-workshop-shrishti-o-anusandhan"),
    { title: ["First workshop_Shrishti_o_Anusandhan", "First Workshop on Wood Carving Traditions of India (Video)"] }
  ],
  [
    album("the-first-craft-toolkit-workshop-srishti-o-anusandhan"),
    { title: ["The First Craft Toolkit Workshop (Srishti O Anusandhan)", "First Workshop on Wood Carving Traditions of India"] }
  ],
  [
    album("second-workshop-on-cane-bamboo-craft-and-hand-block-printing"),
    {
      description: [
        "The Second Craft Toolkit Workshop at IIT Kharagpur brought together 16 artisans from diverse bamboo, cane, and hand-block printing traditions. It documented traditional tools, materials, techniques, and knowledge through demonstrations, interviews, and digital records, while promoting innovation, sustainability, knowledge exchange, and future craft development.",
        "Photographs from the Second Craft Toolkit Workshop at IIT Kharagpur, which brought together 16 artisans from diverse bamboo, cane, and hand-block printing traditions. It documented traditional tools, materials, techniques, and knowledge through demonstrations, interviews, and digital records, while promoting innovation, sustainability, knowledge exchange, and future craft development."
      ]
    }
  ],

  // ── The second workshop: no address (its venue names the Centre), and a hyphen for a separator.
  // The address is the workshop venue printed on its flyer.
  [
    event("bamboo-cane-craft-and-hand-block-printing-sristi-o-anusandhan"),
    {
      title: ["Bamboo & Cane Craft and Hand Block Printing-Sristi O Anusandhan", `Bamboo & Cane Craft and Hand Block Printing (${SHRISTI})`],
      address: [
        null,
        "CoE Handicrafts, Agri Business Incubation Foundation (ABIF) Building, Indian Institute of Technology Kharagpur, Kharagpur, West Bengal – 721302"
      ]
    }
  ],

  // ── Alt text, written by looking at each picture. A picture used in two places is described so the
  // text is true in both.
  ...(
    [
      ["cmtrb2met0001jt04o3j409c2", "JEP05417.jpg.jpeg", "A speaker at a podium addresses the room while four guests sit beside a glass table; the screen shows the 2nd Toolkit Workshop title slide."],
      ["cmtrb5mzl000jjt04wqzu4la7", "JEP05395.jpg.jpeg", "A guest in a shawl receives a bouquet in front of a screen titled 'Centre of Excellence for Unified AI-Enabled Craft Ecosystem Platform'."],
      ["cmtra8eng0001ji042b8kq06n", "JEP06550.jpg.jpeg", "A presenter in a pink shirt speaks to participants wearing purple lanyards; the screen behind him shows glass jars and potted plants."],
      ["cmtrabz9t000jji04x0z9nek4", "JEP07290.jpg.jpeg", "Participants sit in two facing rows, with a woman in black seated at the far end; a cane stool and a woven basket stand in the middle."],
      ["cmtraef730011ji04ujb1nllk", "JEP07324.jpg.jpeg", "A woman in black gestures as she speaks to participants seated in a circle; a woven basket and a cushioned stool are in the foreground."],
      ["cmtraharj001jji04gvg7puv0", "JEP06591.jpg.jpeg", "Two men seated at a desk at the front speak to participants wearing purple lanyards; the screen shows a railway track through trees."],
      ["cmtk3vua8000ji504j1k0j7cu", "Picture11.jpg", "Rows of light-coloured carved spoons, ladles, combs, bowls and plates displayed on a red cloth."],
      ["cmtrbc5ok0001ji04xoavrck4", "JEP07681.jpg.jpeg", "An artisan shows block-printed fabric to two visitors at a table, with wooden printing blocks in the foreground."],
      ["cmtk298l00001ig047z84u4f2", "1ST TOOLKIT WORKSHOP.jpg", "Poster for The First Craft Toolkit Workshop (Shristi O Anusandhan), 25 March – 2nd April 2026, IIT Kharagpur, showing two woodcarvers at work."],
      ["cmtk3wx7g0047i5045t1kw55y", "Picture5.png", "Two photos of participants seated around tables in discussion; in the right-hand photo, carved wooden figures stand on the table."],
      ["cmtk3wt9u003pi504mu4o91je", "Picture4.jpg", "Group photo of participants outside the RMSoEE building, under banners reading 'RMSoEE', 'Design' and 'Leadership', with a brass lamp."],
      ["cmtk3wowa0037i504si8y53zg", "Picture6.jpg", "Participants seated around a table in discussion, with carved wooden figures and printed sheets laid on the table."],
      ["cmtk3wdds002xi504r9b1hriz", "Picture7.jpg", "Five men sit behind a table laid out with carving chisels and carved wooden pieces, including vase-like vessels and figures."],
      ["cmtk3w93t002bi504ftvokouc", "Picture8.jpg", "Two artisans sit on floor mats carving pieces of wood with chisels, surrounded by wood shavings."],
      ["cmtk3vdya0001i504buz493qa", "Picture13.jpg", "A man seated on the ground works on a piece in his lap while another crouches to look at a carved wooden block; people stand behind."],
      ["cmtk3vujp000li50425tevtky", "Picture14.png", "Participants wearing ID badges, with two children, pose beside a standee for The First Craft Toolkit Workshop (Shristi O Anusandhan)."],
      ["cmtk3w2w5001hi504j9tbx985", "Picture10.png", "Two photos of women in headscarves seated on patterned rugs, carving pieces of wood with hand tools amid wood shavings."],
      ["cmtk3w7r2001xi504r3bbmhs3", "Picture9.jpg", "An artisan seated on a rug carves a small figure, with carved wooden figures and pieces lined up in front of him."],
      ["cmtk3vcgg0001ju04vbihs95p", "Picture12.jpg", "A dim, blurred wide view of an atrium hung with coloured banners, with display boards and people seated on floor mats."],
      ["cmtskvfxl0001jr04ioj3tpf5", "3rd workshop poster", "Poster for Shristi O Anusandhan, 3rd Toolkit Workshop for Mud Based Craft Traditions, 14th – 23rd September 2026, IIT Kharagpur, showing two potters."],
      ["cmtk2xkq40001ik04e838awct", "2ND WORKSHOP WORKSHOP.jpg", "Flyer for Shristi O Anusandhan, 2nd Toolkit Workshop for Cane, Bamboo and Block Printing, 17 – 27 June 2026, Centre of Excellence, IIT Kharagpur."]
    ] as const
  ).map(([id, fileName, alt]) => [media(id, fileName), { altText: [null, alt] }] as const)
];

/**
 * Questions and answers for About, every answer from something the site already says. Added HIDDEN —
 * see the header.
 */
const FAQ_LABEL = "Questions and answers (added hidden 2026-11-23: read, then show)";
const FAQ = faqSectionSchema.parse({
  heading: "Questions and answers",
  items: [
    {
      question: "What is the Centre of Excellence for Unified AI-Enabled Craft Ecosystem Platform?",
      answer:
        "A Centre of Excellence at the Indian Institute of Technology Kharagpur, set up as an initiative of the Office of the Development Commissioner (Handicrafts), Ministry of Textiles. It documents and studies India's craft traditions — how things are made, the tools artisans use and the science behind them — and brings artisans and researchers together in its workshops."
    },
    {
      question: "What does the Centre research?",
      answer:
        "Its work falls into three research areas: Craft Process and Traditional Knowledge Documentation; Toolkit Research, Assessment and Augmentation; and Science and Technology Behind Craft. Each has its own page under Research, with the projects and publications that belong to it."
    },
    {
      question: `What is ${SHRISTI}?`,
      answer: `${SHRISTI} is the Centre's series of craft toolkit workshops, where artisans demonstrate their tools, materials and techniques and the Centre documents them. The first, on the wood carving traditions of India, ran from 25 March to 2 April 2026; the second, on cane, bamboo and hand block printing, from 17 to 27 June 2026; and the third, on mud-based craft traditions, from 14 to 23 September 2026. All three were held at IIT Kharagpur.`
    },
    {
      question: "Where is the Centre?",
      answer: "In the ABIF Building on the campus of IIT Kharagpur, Kharagpur, West Bengal 721302, India. The Contact page has a map."
    },
    {
      question: "How can I get in touch?",
      answer:
        "Write to craftkgp.ai.coe@gmail.com, or use the form on the Contact page. The Centre is also on Instagram, Facebook and YouTube; the links are under Contact in the site's menu."
    },
    {
      question: "Where can I read the Centre's reports?",
      answer: "Under Research, on the Publications page, which lists the workshop reports, booklets and the Centre's other publications."
    }
  ]
});

function show(value: unknown): string {
  return value === null || value === undefined ? "(empty)" : JSON.stringify(value);
}

async function applyChange(target: Target, fields: Fields): Promise<"changed" | "done" | "conflict" | "missing"> {
  return prisma.$transaction(async (tx) => {
    const row = await target.find(tx);
    if (!row) {
      console.log(`  MISSING   ${target.name}`);
      return "missing";
    }
    const data: Record<string, string> = {};
    for (const [field, [from, to]] of Object.entries(fields)) {
      const current = row[field] ?? null;
      if (current === to) continue;
      if (current !== from) {
        console.log(`  SKIPPED   ${target.name}: ${field} is ${show(current)}, expected ${show(from)} — edited since; left alone`);
        return "conflict";
      }
      data[field] = to;
    }
    if (Object.keys(data).length === 0) return "done";
    for (const [field, to] of Object.entries(data)) {
      console.log(`  ${APPLY ? "CHANGED" : "WOULD SET"} ${target.name}: ${field}\n      ${show(row[field])}\n   -> ${show(to)}`);
    }
    if (!APPLY) return "changed";
    const after = await target.update(tx, row.id, data);
    await tx.auditLog.create({
      data: {
        action: "UPDATE",
        entityType: target.entityType,
        entityId: row.id,
        entityLabel: String(after.title ?? after.name ?? after.fileName ?? target.name),
        before: JSON.parse(JSON.stringify(row)) as Prisma.InputJsonValue,
        after: JSON.parse(JSON.stringify(after)) as Prisma.InputJsonValue,
        userAgent: USER_AGENT
      }
    });
    return "changed";
  });
}

async function addFaq(): Promise<"changed" | "done" | "missing"> {
  return prisma.$transaction(async (tx) => {
    const page = await tx.page.findFirst({ where: { slug: "about", deletedAt: null }, include: { sections: true } });
    if (!page) {
      console.log("  MISSING   page about");
      return "missing";
    }
    if (page.sections.some((section) => section.type === "FAQ")) return "done";
    const position = Math.max(-1, ...page.sections.map((section) => section.position)) + 1;
    console.log(`  ${APPLY ? "ADDED" : "WOULD ADD"} page about: a HIDDEN FAQ block at position ${position}, ${FAQ.items.length} questions`);
    if (!APPLY) return "changed";
    const section = await tx.pageSection.create({
      data: { pageId: page.id, type: "FAQ", position, label: FAQ_LABEL, data: FAQ as Prisma.InputJsonValue, isVisible: false }
    });
    await tx.auditLog.create({
      data: {
        action: "CREATE",
        entityType: "PageSection",
        entityId: section.id,
        entityLabel: `${page.title} — ${FAQ_LABEL}`,
        after: JSON.parse(JSON.stringify(section)) as Prisma.InputJsonValue,
        userAgent: USER_AGENT
      }
    });
    return "changed";
  });
}

async function main(): Promise<void> {
  console.log(APPLY ? "Applying:" : "Preview (nothing is written; pass --apply to write):");
  const tally: Record<string, number> = {};
  for (const [target, fields] of CHANGES) {
    const outcome = await applyChange(target, fields);
    tally[outcome] = (tally[outcome] ?? 0) + 1;
  }
  const faq = await addFaq();
  tally[faq] = (tally[faq] ?? 0) + 1;
  console.log(`\nrecords: ${JSON.stringify(tally)}`);

  if (APPLY && (tally.changed ?? 0) > 0) {
    const result = await reindexAll();
    console.log(`search index rebuilt: ${result.indexed} documents ${JSON.stringify(result.byType)}`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => Promise.all([prisma.$disconnect(), appPrisma.$disconnect()]));
