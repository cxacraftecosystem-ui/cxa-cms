import { NextResponse } from "next/server";

import { route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { siteName, siteUrl } from "@/lib/env";
import { canManageSettings } from "@/lib/permissions";

/**
 * THE ESCAPE HATCH — every content table as one JSON file, so the Centre is never locked into this
 * software.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ WHAT IS DELIBERATELY *NOT* IN THE FILE, AND WHY THAT IS THE MOST IMPORTANT DECISION HERE.
 *
 * There are no user accounts, no sessions, no linked Google or Microsoft identities, no studio access
 * list and no audit log. An "export everything" that hands out password hashes, a list of who is allowed
 * to sign in, and a record of every colleague's activity is not a backup — it is a breach with a
 * download button, and the export is available to every administrator rather than only to the one person
 * who manages access. The revision history is out for the same reason: it holds full snapshots of every
 * row that has ever been edited, INCLUDING user accounts.
 *
 * That is not a gap in portability. None of it is content: an institution moving to other software brings
 * its pages, people, projects, publications, photographs and enquiries, and creates its own accounts at
 * the far end. Anything genuinely needed from the accounts — who wrote a news article — survives as an
 * identifier on the row itself.
 *
 * ⚠ THE FILE CONTAINS PERSONAL DATA OF MEMBERS OF THE PUBLIC. Contact enquiries and event registrations
 * are people's names, email addresses, telephone numbers and messages. They are included because they are
 * the Centre's own records and an export without them is not a way out; they are the reason this endpoint
 * is `canManageSettings` and the reason the file says so about itself in `notes`. The two SURVEILLANCE
 * columns on an enquiry — the IP address and the browser string — are left out: they are anti-spam
 * evidence for the inbox screen, not records the Centre needs in order to leave.
 *
 * ⚠ THE CAP IS PER TABLE, STATED PER TABLE, INSIDE THE FILE. Every table reports `rowsInDatabase`,
 * `rowsExported` and `truncated`. A backup that quietly stopped at some round number is worse than no
 * backup, because it will be believed years later by somebody who never saw this screen (contract §1.6) —
 * and the person who opens this file is usually not the person who downloaded it.
 *
 * ⚠ IT IS STREAMED, IN BATCHES, AND THE FAILURE PATH STILL PRODUCES VALID JSON. The rows are read five
 * hundred at a time and written out as they arrive, so no single response is assembled in memory. The
 * consequence is that the status line and the headers are committed before the body is finished, so a
 * database failure half way through CANNOT become a 500 — instead the writer closes whatever brackets it
 * has open and appends an `incomplete` object naming the table it stopped in. A file that says it is
 * incomplete can be acted on; a truncated file that parses as complete cannot.
 *
 * NOTHING IS WRITTEN, so there is no `mutateWithHistory()` here. The act is recorded on the server console
 * instead, with the actor's address: `AuditAction` has no value that describes a read, and inventing one
 * would mean a migration, which does not belong in this file. That is a known gap and it is named here
 * rather than left for somebody to discover during an incident.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * A generous ceiling. The work is many short queries rather than one long one, but the REQUEST has to
 * survive all of them — the same reasoning as the search rebuild in `studio/reindex`.
 */
export const maxDuration = 300;

/**
 * The shape of the FILE, not of this application.
 *
 * It changes when a table is added, removed or renamed here, or when a column stops being exported —
 * anything a program written against yesterday's file would notice. Whoever writes an importer reads this
 * first, which is why it is the first key in the document.
 */
const SCHEMA_VERSION = "1";

/**
 * The most rows any one table contributes.
 *
 * High enough that no Centre-sized table reaches it, and it is reported inside the file per table either
 * way. It exists so that one runaway table — a page-view log left running for five years — cannot turn a
 * backup into an unbounded download.
 */
const MAX_ROWS_PER_TABLE = 25_000;

/** How many rows are held in memory at once. Bounded work per batch, not per table. */
const BATCH_SIZE = 500;

/**
 * One exported table.
 *
 * `count` and `read` are CLOSURES over the Prisma delegate rather than a delegate looked up by name: a
 * delegate indexed by a string erases the type of everything it returns, and every one of these needs its
 * own ordering — the join tables have no `id` to order by.
 */
interface ExportTable {
  /** The key in the file. The database's own table name, so a reader can pair the two. */
  name: string;
  /** One plain sentence. The person who opens this file may never have seen this application. */
  describes: string;
  count: () => Promise<number>;
  read: (skip: number, take: number) => Promise<unknown[]>;
}

/**
 * Every content table, in a reading order rather than an alphabetical one: the site's pages first, then
 * its files, then the people and the research, then the newsroom and the calendar, then the archive, and
 * the records and settings last.
 *
 * A TOTAL ORDERING on every read, always. `skip` with no `orderBy` is undefined behaviour across batches:
 * a row can appear in two of them and another in none, which in a backup is silent data loss.
 */
const TABLES: readonly ExportTable[] = [
  // ── Pages and their blocks ────────────────────────────────────────────────
  {
    name: "pages",
    describes:
      "Every page of the site, its web address, its publication state and its search-engine fields. Rows in the recycle bin are included and carry a deletedAt.",
    count: () => prisma.page.count(),
    read: (skip, take) => prisma.page.findMany({ orderBy: { id: "asc" }, skip, take })
  },
  {
    name: "page_sections",
    describes:
      "The ordered blocks each page is built from. `data` is the block's own payload, whose shape depends on `type`.",
    count: () => prisma.pageSection.count(),
    read: (skip, take) => prisma.pageSection.findMany({ orderBy: { id: "asc" }, skip, take })
  },

  // ── Media and files ───────────────────────────────────────────────────────
  {
    name: "media_folders",
    describes: "The folder tree the media library is organised into.",
    count: () => prisma.mediaFolder.count(),
    read: (skip, take) => prisma.mediaFolder.findMany({ orderBy: { id: "asc" }, skip, take })
  },
  {
    name: "media_assets",
    describes:
      "Every photograph, video and recording, with its description, caption, credit and copyright. `objectKey` names the file in object storage — the BYTES are not in this export, only the records that describe them.",
    count: () => prisma.mediaAsset.count(),
    read: (skip, take) => prisma.mediaAsset.findMany({ orderBy: { id: "asc" }, skip, take })
  },
  {
    name: "media_variants",
    describes:
      "The generated sizes of each image. Rebuildable from the originals, and included so a move does not have to regenerate them.",
    count: () => prisma.mediaVariant.count(),
    read: (skip, take) => prisma.mediaVariant.findMany({ orderBy: { id: "asc" }, skip, take })
  },
  {
    name: "media_collections",
    describes: "Named groups of media, used to gather pictures across folders.",
    count: () => prisma.mediaCollection.count(),
    read: (skip, take) => prisma.mediaCollection.findMany({ orderBy: { id: "asc" }, skip, take })
  },
  {
    name: "media_collection_items",
    describes: "Which media are in which collection, and in what order.",
    count: () => prisma.mediaCollectionItem.count(),
    read: (skip, take) =>
      prisma.mediaCollectionItem.findMany({
        orderBy: [{ collectionId: "asc" }, { assetId: "asc" }],
        skip,
        take
      })
  },
  {
    name: "file_assets",
    describes: "Documents, datasets and slide decks offered for download.",
    count: () => prisma.fileAsset.count(),
    read: (skip, take) => prisma.fileAsset.findMany({ orderBy: { id: "asc" }, skip, take })
  },
  {
    name: "file_versions",
    describes:
      "Each version of each file, so a citation of version 2 of a dataset still names the right bytes.",
    count: () => prisma.fileVersion.count(),
    read: (skip, take) => prisma.fileVersion.findMany({ orderBy: { id: "asc" }, skip, take })
  },

  // ── People ────────────────────────────────────────────────────────────────
  {
    name: "people",
    describes:
      "Everybody shown on the public site: faculty, scientists, students, staff, visitors and alumni, with their biographies and academic identifiers.",
    count: () => prisma.person.count(),
    read: (skip, take) => prisma.person.findMany({ orderBy: { id: "asc" }, skip, take })
  },

  // ── Research, projects, publications ──────────────────────────────────────
  {
    name: "research_areas",
    describes: "The themes the Centre works on. Projects and publications are filed under these.",
    count: () => prisma.researchArea.count(),
    read: (skip, take) => prisma.researchArea.findMany({ orderBy: { id: "asc" }, skip, take })
  },
  {
    name: "projects",
    describes: "Funded work, its dates, its funding and how far along it is.",
    count: () => prisma.project.count(),
    read: (skip, take) => prisma.project.findMany({ orderBy: { id: "asc" }, skip, take })
  },
  {
    name: "project_members",
    describes: "Who is on which project, in what role and in what order.",
    count: () => prisma.projectMember.count(),
    read: (skip, take) =>
      prisma.projectMember.findMany({
        orderBy: [{ projectId: "asc" }, { personId: "asc" }],
        skip,
        take
      })
  },
  {
    name: "project_milestones",
    describes: "The milestones of each project, with their due and completion dates.",
    count: () => prisma.projectMilestone.count(),
    read: (skip, take) => prisma.projectMilestone.findMany({ orderBy: { id: "asc" }, skip, take })
  },
  {
    name: "project_media",
    describes: "The photographs attached to each project, with their captions.",
    count: () => prisma.projectMedia.count(),
    read: (skip, take) =>
      prisma.projectMedia.findMany({ orderBy: [{ projectId: "asc" }, { assetId: "asc" }], skip, take })
  },
  {
    name: "project_files",
    describes: "The downloadable files attached to each project.",
    count: () => prisma.projectFile.count(),
    read: (skip, take) =>
      prisma.projectFile.findMany({ orderBy: [{ projectId: "asc" }, { fileId: "asc" }], skip, take })
  },
  {
    name: "project_partners",
    describes: "Which partner organisations are on which project.",
    count: () => prisma.projectPartner.count(),
    read: (skip, take) =>
      prisma.projectPartner.findMany({
        orderBy: [{ projectId: "asc" }, { partnerId: "asc" }],
        skip,
        take
      })
  },
  {
    name: "project_faqs",
    describes: "Questions and answers attached to a project.",
    count: () => prisma.projectFaq.count(),
    read: (skip, take) => prisma.projectFaq.findMany({ orderBy: { id: "asc" }, skip, take })
  },
  {
    name: "publications",
    describes:
      "Papers, books, patents, datasets and software, with their citation details, identifiers and BibTeX.",
    count: () => prisma.publication.count(),
    read: (skip, take) => prisma.publication.findMany({ orderBy: { id: "asc" }, skip, take })
  },
  {
    name: "publication_authors",
    describes:
      "Which Centre people are authors of which publication. The printed author line lives on the publication itself.",
    count: () => prisma.publicationAuthor.count(),
    read: (skip, take) =>
      prisma.publicationAuthor.findMany({
        orderBy: [{ publicationId: "asc" }, { personId: "asc" }],
        skip,
        take
      })
  },

  // ── Newsroom ──────────────────────────────────────────────────────────────
  {
    name: "categories",
    describes: "The newsroom's categories.",
    count: () => prisma.category.count(),
    read: (skip, take) => prisma.category.findMany({ orderBy: { id: "asc" }, skip, take })
  },
  {
    name: "tags",
    describes: "Tags, shared between news articles and events.",
    count: () => prisma.tag.count(),
    read: (skip, take) => prisma.tag.findMany({ orderBy: { id: "asc" }, skip, take })
  },
  {
    name: "posts",
    describes:
      "News articles and announcements. `body` is a structured document; `authorId` names an account that is NOT in this export.",
    count: () => prisma.post.count(),
    read: (skip, take) => prisma.post.findMany({ orderBy: { id: "asc" }, skip, take })
  },
  {
    name: "post_tags",
    describes: "Which tags are on which news article.",
    count: () => prisma.postTag.count(),
    read: (skip, take) =>
      prisma.postTag.findMany({ orderBy: [{ postId: "asc" }, { tagId: "asc" }], skip, take })
  },

  // ── Events ────────────────────────────────────────────────────────────────
  {
    name: "events",
    describes:
      "Seminars, workshops and conferences, with their times as absolute instants, their venues and their registration settings.",
    count: () => prisma.coeEvent.count(),
    read: (skip, take) => prisma.coeEvent.findMany({ orderBy: { id: "asc" }, skip, take })
  },
  {
    name: "event_agenda_items",
    describes: "The programme of each event.",
    count: () => prisma.eventAgendaItem.count(),
    read: (skip, take) => prisma.eventAgendaItem.findMany({ orderBy: { id: "asc" }, skip, take })
  },
  {
    name: "event_speakers",
    describes: "Which people speak at which event.",
    count: () => prisma.eventSpeaker.count(),
    read: (skip, take) =>
      prisma.eventSpeaker.findMany({ orderBy: [{ eventId: "asc" }, { personId: "asc" }], skip, take })
  },
  {
    name: "event_media",
    describes: "The photographs attached to each event.",
    count: () => prisma.eventMedia.count(),
    read: (skip, take) =>
      prisma.eventMedia.findMany({ orderBy: [{ eventId: "asc" }, { assetId: "asc" }], skip, take })
  },
  {
    name: "event_tags",
    describes: "Which tags are on which event.",
    count: () => prisma.eventTag.count(),
    read: (skip, take) =>
      prisma.eventTag.findMany({ orderBy: [{ eventId: "asc" }, { tagId: "asc" }], skip, take })
  },
  {
    name: "event_registrations",
    describes:
      "⚠ PERSONAL DATA. Who registered for each event: their name, email address, organisation, telephone number and any notes they left, with their attendance state and certificate code.",
    count: () => prisma.eventRegistration.count(),
    read: (skip, take) => prisma.eventRegistration.findMany({ orderBy: { id: "asc" }, skip, take })
  },

  // ── Craft archive ─────────────────────────────────────────────────────────
  {
    name: "craft_regions",
    describes: "The places crafts are recorded against, as a tree from nation down to cluster.",
    count: () => prisma.craftRegion.count(),
    read: (skip, take) => prisma.craftRegion.findMany({ orderBy: { id: "asc" }, skip, take })
  },
  {
    name: "craft_schools",
    describes: "The traditions and schools crafts belong to.",
    count: () => prisma.craftSchool.count(),
    read: (skip, take) => prisma.craftSchool.findMany({ orderBy: { id: "asc" }, skip, take })
  },
  {
    name: "crafts",
    describes:
      "The craft archive: local names in their own script, materials, techniques, origins and coordinates.",
    count: () => prisma.craft.count(),
    read: (skip, take) => prisma.craft.findMany({ orderBy: { id: "asc" }, skip, take })
  },
  {
    name: "craft_media",
    describes: "The photographs of each craft, including the before-and-after restoration pairs.",
    count: () => prisma.craftMedia.count(),
    read: (skip, take) =>
      prisma.craftMedia.findMany({ orderBy: [{ craftId: "asc" }, { assetId: "asc" }], skip, take })
  },

  // ── Gallery ───────────────────────────────────────────────────────────────
  {
    name: "gallery_albums",
    describes: "Photo albums, grouped by occasion.",
    count: () => prisma.galleryAlbum.count(),
    read: (skip, take) => prisma.galleryAlbum.findMany({ orderBy: { id: "asc" }, skip, take })
  },
  {
    name: "gallery_items",
    describes: "The pictures in each album, in order, with how each one is presented.",
    count: () => prisma.galleryItem.count(),
    read: (skip, take) => prisma.galleryItem.findMany({ orderBy: { id: "asc" }, skip, take })
  },

  // ── The site's own furniture ──────────────────────────────────────────────
  {
    name: "partners",
    describes: "Partner and funder organisations, with their logos and web addresses.",
    count: () => prisma.partner.count(),
    read: (skip, take) => prisma.partner.findMany({ orderBy: { id: "asc" }, skip, take })
  },
  {
    name: "navigation_items",
    describes: "The menus: the header, the footer columns and the small top bar.",
    count: () => prisma.navigationItem.count(),
    read: (skip, take) => prisma.navigationItem.findMany({ orderBy: { id: "asc" }, skip, take })
  },
  {
    name: "announcements",
    describes: "The site-wide notice bands and the windows they appear in.",
    count: () => prisma.announcement.count(),
    read: (skip, take) => prisma.announcement.findMany({ orderBy: { id: "asc" }, skip, take })
  },
  {
    name: "settings",
    describes:
      "Site settings, one JSON document per group: branding, contact, social, search and sharing, homepage, features and footer. No credentials of any kind are stored here.",
    count: () => prisma.setting.count(),
    read: (skip, take) => prisma.setting.findMany({ orderBy: { key: "asc" }, skip, take })
  },
  {
    name: "redirects",
    describes: "Old web addresses and where they now send readers.",
    count: () => prisma.redirect.count(),
    read: (skip, take) => prisma.redirect.findMany({ orderBy: { id: "asc" }, skip, take })
  },

  // ── Records ───────────────────────────────────────────────────────────────
  {
    name: "contact_submissions",
    describes:
      "⚠ PERSONAL DATA. Messages sent through the contact forms: name, email address, organisation, telephone number and the message itself, with how it was handled. The sender's IP address and browser string are deliberately NOT exported — they are anti-spam evidence rather than records of the Centre's work.",
    count: () => prisma.contactSubmission.count(),
    read: (skip, take) =>
      prisma.contactSubmission.findMany({
        orderBy: { id: "asc" },
        skip,
        take,
        // An explicit list rather than the whole row: the two omissions above are the point, and a
        // `select` is the only way to be sure a column added later is not swept in with them.
        select: {
          id: true,
          name: true,
          email: true,
          organisation: true,
          phone: true,
          subject: true,
          message: true,
          formKey: true,
          state: true,
          assigneeId: true,
          internalNote: true,
          repliedAt: true,
          spamScore: true,
          spamReason: true,
          createdAt: true,
          updatedAt: true,
          deletedAt: true
        }
      })
  },
  {
    name: "page_views_daily",
    describes:
      "First-party page views, by day, path and country. Deliberately coarse: there is no cookie, no visitor identifier and nothing that can be traced to a person.",
    count: () => prisma.pageViewDaily.count(),
    read: (skip, take) => prisma.pageViewDaily.findMany({ orderBy: { id: "asc" }, skip, take })
  },
  {
    name: "download_events",
    describes: "How many times each file, publication and dataset was downloaded, by day and country.",
    count: () => prisma.downloadEvent.count(),
    read: (skip, take) => prisma.downloadEvent.findMany({ orderBy: { id: "asc" }, skip, take })
  },
  {
    name: "search_query_logs",
    describes: "What visitors searched for, by day, and how many results each search found.",
    count: () => prisma.searchQueryLog.count(),
    read: (skip, take) => prisma.searchQueryLog.findMany({ orderBy: { id: "asc" }, skip, take })
  }
];

/**
 * What is left out, and why — IN THE FILE.
 *
 * ⚠ The plain-words version of this list is also on the studio's health screen, beside the download
 * control. That copy is a summary for a reader deciding whether to press the button; THIS one is the
 * authority, and it is the one an importer should be written against. If either changes, change both.
 */
const EXCLUDED: readonly { table: string; reason: string }[] = [
  {
    table: "users",
    reason:
      "Account records, including password hashes and two-step verification secrets. An export that carried these would turn one administrator's download into a full compromise of every account. Where a row here was written by somebody, their identifier survives on that row."
  },
  {
    table: "sessions",
    reason: "Live sign-in sessions. Meaningless outside this deployment and replayable inside it."
  },
  {
    table: "oauth_accounts",
    reason: "Links between accounts here and Google, Microsoft or Yahoo identities."
  },
  {
    table: "studio_access",
    reason:
      "The list of email addresses allowed to sign in at all. It is an authorisation control, and a copy of it is a map of who to attack."
  },
  {
    table: "audit_logs",
    reason:
      "Who changed what, when, from which address. A record of colleagues' activity rather than of the Centre's content."
  },
  {
    table: "revisions",
    reason:
      "The full history of every change. Each entry holds a complete snapshot of the row it describes, INCLUDING user accounts, so exporting it would reintroduce everything above by another route."
  },
  {
    table: "content_locks",
    reason: "Who currently has an editor open. Transient, and expires within minutes."
  },
  {
    table: "search_documents",
    reason:
      "The search index. Derived entirely from the content above and rebuilt from it in one action, so a copy would only be a second thing to keep in step."
  }
];

/** Read before anything else by whoever has to make sense of this file. */
const NOTES: readonly string[] = [
  "This file holds records, not files. Photographs, videos and documents live in object storage; each media row names its own object by `objectKey`, and the bytes have to be copied separately.",
  "It contains personal data of members of the public — contact enquiries and event registrations — so it deserves the same care as the inbox it came from. Do not put it anywhere it can be reached without signing in.",
  "Rows in the recycle bin are included and can be told apart by a `deletedAt` that is not null. Anything importing this should decide deliberately whether to bring them across.",
  "Dates and times are ISO 8601 instants in UTC. The Centre's own display timezone is a setting, not a property of these values.",
  "Where a row was written or is owned by a studio account, the identifier is kept and the account itself is not in this file. Those references will not resolve against anything in this export, and that is deliberate.",
  "Every table states how many rows the database holds and how many are in this file. If `truncated` is true anywhere, this is not a complete copy of that table.",
  "If the document ends with an `incomplete` object, the export stopped part-way through and the file is not a complete copy. The table it stopped in is named there."
];

export const GET = route(async () => {
  const user = await requireCapability(
    canManageSettings,
    "Exporting everything needs administrator access. An administrator can raise yours."
  );

  /**
   * The one record this endpoint leaves behind. See the file header for why it is a log line and not an
   * audit row: nothing here writes to the database, and `AuditAction` has no value that means "read".
   */
  console.info(`[export] a full content export was taken by ${user.email}`);

  const generatedAt = new Date();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (text: string) => controller.enqueue(encoder.encode(text));

      /** True while a table's `rows` array is open. The failure path needs to know to close it. */
      let openTable: string | null = null;

      /**
       * True once `"tables": {` has gone out.
       *
       * The recovery below has to know whether that object is open, because closing one that was never
       * opened produces a file that will not parse at all — and an unparseable export tells whoever opens
       * it nothing about what went wrong, which is the failure this whole path exists to avoid.
       */
      let tablesOpen = false;

      try {
        write("{\n");
        write(`"schemaVersion": ${JSON.stringify(SCHEMA_VERSION)},\n`);
        write(`"generatedAt": ${JSON.stringify(generatedAt.toISOString())},\n`);
        write(`"site": ${JSON.stringify({ name: siteName(), url: siteUrl() })},\n`);
        write(`"rowCapPerTable": ${MAX_ROWS_PER_TABLE},\n`);
        write(`"includedTables": ${JSON.stringify(TABLES.map((table) => table.name))},\n`);
        write(`"excluded": ${JSON.stringify(EXCLUDED)},\n`);
        write(`"notes": ${JSON.stringify(NOTES)},\n`);
        write('"tables": {\n');
        tablesOpen = true;

        let firstTable = true;
        for (const table of TABLES) {
          /**
           * ⚠ THE COUNT IS TAKEN BEFORE THE SEPARATING COMMA IS WRITTEN, and the order is load-bearing.
           *
           * This is the only `await` between one table's closing brace and the next table's opening one, so
           * it is the only place the loop can fail with nothing of this table written yet. Writing the comma
           * first would leave a dangling one at the end of the `tables` object, and the recovery below would
           * then close that object straight after it — producing a file that will not parse, in exactly the
           * situation where somebody needs to read what it says about itself.
           */
          const total = await table.count();
          const exported = Math.min(total, MAX_ROWS_PER_TABLE);

          if (!firstTable) write(",\n");
          firstTable = false;

          write(`${JSON.stringify(table.name)}: {`);
          write(`"describes": ${JSON.stringify(table.describes)},`);
          write(`"rowsInDatabase": ${total},`);
          write(`"rowsExported": ${exported},`);
          write(`"truncated": ${total > exported},`);
          if (total > exported) {
            write(
              `"truncationNote": ${JSON.stringify(
                `This table holds ${total} rows and this file carries the first ${exported} of them, ordered by identifier. The export stops at ${MAX_ROWS_PER_TABLE} rows per table. THIS IS NOT A COMPLETE COPY of ${table.name}.`
              )},`
            );
          }
          write('"rows": [');
          openTable = table.name;

          let written = 0;
          while (written < exported) {
            const batch = await table.read(written, Math.min(BATCH_SIZE, exported - written));
            // A table that answers fewer rows than asked for has been changed underneath this read — by a
            // delete, or by the recycle bin being emptied. Stopping is right: the count above already says
            // how many there were, so the file remains honest about the difference.
            if (batch.length === 0) break;
            for (const row of batch) {
              // One row per line, comma-first. A five-thousand-row table on a single line is a file no
              // text editor will open and no reviewer will read.
              write(written === 0 ? "\n" : ",\n");
              write(JSON.stringify(row));
              written += 1;
            }
          }

          write(written === 0 ? "]}" : "\n]}");
          openTable = null;
        }

        write("\n}\n}\n");
      } catch (error) {
        console.error("[export] the export failed part-way through", openTable, error);

        /**
         * ⚠ CLOSE WHAT IS OPEN, THEN SAY SO.
         *
         * The status line went out with the first chunk, so this cannot become a 500 — the only honest
         * remaining move is a file that parses and declares itself incomplete. A truncated file that
         * happens to parse as a complete export is the one outcome that must not be possible.
         *
         * ⚠ INSIDE ITS OWN try/catch, because one of the two ways to arrive here is the reader cancelling
         * the download — at which point `enqueue` throws as well, and an unguarded write would turn a
         * cancelled download into an unhandled rejection in the server log for every abandoned export.
         */
        try {
          if (openTable !== null) write("\n]}");
          // `}` closes the `tables` object and the comma separates the key that follows it — written only
          // where that object was actually opened. Before it was, the last thing out was a header line that
          // already ends in a comma, so `"incomplete"` follows exactly one comma in both cases and neither
          // branch can leave a doubled or a dangling one.
          if (tablesOpen) write("},");
          write(
            `"incomplete": ${JSON.stringify({
              stoppedInTable: openTable,
              message:
                "This export did not finish. Everything above this point was read successfully; everything after it is missing. Do not treat this file as a complete copy — take another export, and if it fails again the server log says why."
            })}}\n`
          );
        } catch {
          // The stream is already gone. Nothing can be said into it, and there is nothing to repair.
        }
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed or already errored — closing twice is not a failure worth reporting.
        }
      }
    }
  });

  const stamp = generatedAt.toISOString().slice(0, 10);

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // The date is in the NAME as well as inside the file: two exports a month apart otherwise sit in a
      // downloads folder as "export.json" and "export (1).json" and nobody can tell which is which.
      "content-disposition": `attachment; filename="cxa-content-export-${stamp}.json"`,
      // Never cached. It is a snapshot of live content, and a proxy holding it would hand one
      // administrator's copy — personal data included — to the next request that asked.
      "cache-control": "no-store, max-age=0"
    }
  });
});
