import { hasDatabase } from "../newsletter/setup";
import { countStatements, dataStatements } from "./query-counter";

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { writeAuditMany, type AuditInput, type TxClient } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { applyRegistrationBatch, applyRegistrationStates } from "@/lib/events/registration-writes";
import { resolveTagIds } from "@/lib/studio/crud";
import {
  albumCategoryOptions,
  auditEntityTypeOptions,
  fileCategoryOptions,
  inquiryFormKeyOptions,
  publicationYearOptions
} from "@/lib/studio/distinct-values";
import { replaceEventMedia, replaceEventSpeakers, replaceGalleryItems, writeMenus } from "@/lib/studio/ordered-links";
import { freeFileSlug } from "@/lib/studio/slugs";

/**
 * QUERY-COUNT REGRESSION TESTS for the write paths that used to issue a statement per row, and for the
 * filter-option reads that used to fetch a whole table to de-duplicate it in memory.
 *
 * Each test pins the number of statements a call sends AND checks that the rows it leaves behind are the
 * ones the per-row version left — a count that dropped because the work stopped happening would be no
 * improvement. Where a count is pinned at two sizes, it is the same at both: that is what "not N+1" means.
 *
 * ⚠ THESE TESTS WRITE ROWS (and remove their own), so they refuse to run against anything but a database
 * on this machine — the same rule as tests/newsletter/outbox.db.test.ts. Writes that touch a shared table
 * (the menus) run inside a transaction that is rolled back.
 */

const LOCAL = /@(127\.0\.0\.1|localhost|\[::1\]|postgres)(:\d+)?\//.test(process.env.DATABASE_URL ?? "");
const skip = !hasDatabase ? "no DATABASE_URL" : !LOCAL ? "DATABASE_URL is not a local database" : false;

const RUN = `perf${Date.now().toString(36)}`;
const CONTEXT = { actor: null, ipAddress: "198.51.100.7", userAgent: "query-count test" };

/** Thrown to roll a transaction back once the assertions inside it are done. */
class RollBack extends Error {}

/** Run `work` inside a transaction that is always rolled back. */
async function inRolledBackTransaction(work: (tx: TxClient) => Promise<void>): Promise<void> {
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      await work(tx);
      throw new RollBack();
    }),
    RollBack
  );
}

const assetIds: string[] = [];
const personIds: string[] = [];
let albumId = "";
let eventId = "";

describe("query counts", { skip }, () => {
  before(async () => {
    for (let index = 0; index < 12; index += 1) {
      const asset = await prisma.mediaAsset.create({
        data: {
          kind: "IMAGE",
          objectKey: `${RUN}/picture-${index}.jpg`,
          fileName: `picture-${index}.jpg`,
          mimeType: "image/jpeg",
          byteSize: 1
        },
        select: { id: true }
      });
      assetIds.push(asset.id);
    }
    for (let index = 0; index < 6; index += 1) {
      const person = await prisma.person.create({
        data: { slug: `${RUN}-person-${index}`, name: `Person ${index}`, kind: "FACULTY" },
        select: { id: true }
      });
      personIds.push(person.id);
    }
    albumId = (await prisma.galleryAlbum.create({ data: { slug: `${RUN}-album`, title: "Album" } })).id;
    eventId = (
      await prisma.coeEvent.create({ data: { slug: `${RUN}-event`, title: "Event", startsAt: new Date() } })
    ).id;
  });

  after(async () => {
    const registrationIds = (
      await prisma.eventRegistration.findMany({ where: { eventId }, select: { id: true } })
    ).map((row) => row.id);
    await prisma.auditLog.deleteMany({ where: { entityType: "EventRegistration", entityId: { in: registrationIds } } });
    // Cascades take the album's items, the event's speakers, pictures and registrations.
    await prisma.galleryAlbum.deleteMany({ where: { id: albumId } });
    await prisma.coeEvent.deleteMany({ where: { id: eventId } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.mediaAsset.deleteMany({ where: { id: { in: assetIds } } });
    await prisma.tag.deleteMany({ where: { slug: { startsWith: RUN } } });
    await prisma.fileAsset.deleteMany({ where: { slug: { startsWith: RUN } } });
  });

  // ── Tags ──────────────────────────────────────────────────────────────────────────────────────

  it("resolves any number of tags in two statements, keeping an existing tag's name and the order given", async () => {
    const existing = await prisma.tag.create({ data: { slug: `${RUN}-handloom`, name: `${RUN} Handloom` } });

    const names = [
      `${RUN} Zari`,
      `${RUN} handloom`, // the existing tag, spelled differently
      `${RUN} Ikat`,
      `${RUN} zari`, // a repeat of the first, by slug
      "   ",
      `${RUN} Bidri`,
      `${RUN} Kalamkari`,
      `${RUN} Phulkari`,
      `${RUN} Chikankari`,
      `${RUN} Sozni`
    ];

    const { result: ids, statements } = await countStatements(() =>
      prisma.$transaction((tx) => resolveTagIds(tx, names))
    );
    assert.equal(dataStatements(statements).length, 2, statements.join("\n"));

    const rows = await prisma.tag.findMany({ where: { id: { in: ids } }, select: { id: true, slug: true, name: true } });
    const byId = new Map(rows.map((row) => [row.id, row]));
    assert.deepEqual(
      ids.map((id) => byId.get(id)?.slug),
      [`${RUN}-zari`, `${RUN}-handloom`, `${RUN}-ikat`, `${RUN}-bidri`, `${RUN}-kalamkari`, `${RUN}-phulkari`, `${RUN}-chikankari`, `${RUN}-sozni`]
    );
    assert.equal(byId.get(existing.id)?.name, `${RUN} Handloom`, "an existing tag keeps the first spelling anybody used");
    assert.equal(byId.get(ids[0] ?? "")?.name, `${RUN} Zari`, "a new tag takes the first spelling in the list");

    const single = await countStatements(() => prisma.$transaction((tx) => resolveTagIds(tx, [`${RUN} Single`])));
    assert.equal(dataStatements(single.statements).length, 2);
    const none = await countStatements(() => prisma.$transaction((tx) => resolveTagIds(tx, ["  ", "!!"])));
    assert.equal(dataStatements(none.statements).length, 0);
  });

  // ── Gallery album pictures ────────────────────────────────────────────────────────────────────

  it("writes an album's pictures in three statements, keeping a framing the request did not mention", async () => {
    const [first, second, ...rest] = assetIds as [string, string, ...string[]];
    await prisma.galleryItem.createMany({
      data: [
        { albumId, assetId: first, position: 5, caption: "old", assetScreens: { sm: { x: 1 } } },
        { albumId, assetId: second, position: 6, caption: "gone" }
      ]
    });

    const items = [first, ...rest].map((assetId, index) => ({
      assetId,
      caption: `caption ${index}`,
      presentation: index === 1 ? "video" : "image",
      tourEntry: null,
      // The first row says nothing about framing; the rest say "none".
      ...(index === 0 ? {} : { assetScreens: null })
    }));

    const { statements } = await countStatements(() =>
      prisma.$transaction((tx) => replaceGalleryItems(tx, albumId, items))
    );
    assert.equal(dataStatements(statements).length, 3, statements.join("\n"));

    const stored = await prisma.galleryItem.findMany({ where: { albumId }, orderBy: { position: "asc" } });
    assert.deepEqual(
      stored.map((row) => [row.assetId, row.position, row.caption, row.presentation]),
      items.map((item, index) => [item.assetId, index, item.caption, item.presentation])
    );
    assert.deepEqual(stored[0]?.assetScreens, { sm: { x: 1 } }, "an absent framing is left as it was");
    assert.equal(stored.some((row) => row.assetId === second), false, "a picture no longer listed is removed");

    // The same three statements for a re-order of three, with the first row's framing now cleared on purpose.
    const reordered = [rest[1], rest[0], first].map((assetId, index) => ({
      assetId: assetId as string,
      caption: null,
      presentation: "image",
      tourEntry: index === 0 ? "scene-1" : null,
      assetScreens: assetId === first ? null : { md: { y: index } }
    }));
    const again = await countStatements(() =>
      prisma.$transaction((tx) => replaceGalleryItems(tx, albumId, reordered))
    );
    assert.equal(dataStatements(again.statements).length, 3);
    const after = await prisma.galleryItem.findMany({ where: { albumId }, orderBy: { position: "asc" } });
    assert.deepEqual(
      after.map((row) => [row.assetId, row.position, row.tourEntry, row.assetScreens]),
      reordered.map((item, index) => [item.assetId, index, item.tourEntry, item.assetScreens])
    );

    const cleared = await countStatements(() => prisma.$transaction((tx) => replaceGalleryItems(tx, albumId, [])));
    assert.equal(dataStatements(cleared.statements).length, 1);
    assert.equal(await prisma.galleryItem.count({ where: { albumId } }), 0);
  });

  // ── Event speakers and pictures ───────────────────────────────────────────────────────────────

  it("writes an event's speakers in three statements and keeps the role of anybody who stays", async () => {
    const [kept, dropped] = personIds as [string, string];
    await prisma.eventSpeaker.createMany({
      data: [
        { eventId, personId: kept, role: "Chair", position: 0 },
        { eventId, personId: dropped, role: "Panel", position: 1 }
      ]
    });
    const order = [...personIds.slice(2), kept];

    const { statements } = await countStatements(() =>
      prisma.$transaction((tx) => replaceEventSpeakers(tx, eventId, order))
    );
    assert.equal(dataStatements(statements).length, 3, statements.join("\n"));

    const stored = await prisma.eventSpeaker.findMany({ where: { eventId }, orderBy: { position: "asc" } });
    assert.deepEqual(
      stored.map((row) => [row.personId, row.position]),
      order.map((personId, index) => [personId, index])
    );
    assert.equal(stored.find((row) => row.personId === kept)?.role, "Chair");
    assert.equal(stored.some((row) => row.personId === dropped), false);
  });

  it("writes an event's pictures in three statements, framing only when the request speaks about framing", async () => {
    const [a, b, c, d] = assetIds as [string, string, string, string];
    await prisma.eventMedia.createMany({
      data: [{ eventId, assetId: a, position: 3, caption: "kept caption", assetScreens: { lg: { z: 1 } } }]
    });

    // No framing list: positions only, the stored framing untouched.
    const silent = await countStatements(() =>
      prisma.$transaction((tx) => replaceEventMedia(tx, eventId, [b, a, c], undefined))
    );
    assert.equal(dataStatements(silent.statements).length, 3, silent.statements.join("\n"));
    let stored = await prisma.eventMedia.findMany({ where: { eventId }, orderBy: { position: "asc" } });
    assert.deepEqual(stored.map((row) => [row.assetId, row.position]), [[b, 0], [a, 1], [c, 2]]);
    assert.deepEqual(stored.find((row) => row.assetId === a)?.assetScreens, { lg: { z: 1 } });
    assert.equal(stored.find((row) => row.assetId === a)?.caption, "kept caption");

    // A framing list: named pictures framed, every other listed picture cleared.
    const framed = await countStatements(() =>
      prisma.$transaction((tx) =>
        replaceEventMedia(tx, eventId, [d, a, b], [{ assetId: d, screens: { sm: { q: 2 } } }])
      )
    );
    assert.equal(dataStatements(framed.statements).length, 3);
    stored = await prisma.eventMedia.findMany({ where: { eventId }, orderBy: { position: "asc" } });
    assert.deepEqual(
      stored.map((row) => [row.assetId, row.position, row.assetScreens]),
      [[d, 0, { sm: { q: 2 } }], [a, 1, null], [b, 2, null]]
    );
  });

  // ── Menus ─────────────────────────────────────────────────────────────────────────────────────

  it("writes the menus in two statements however many items they hold", async () => {
    const entry = (label: string) => ({ label, href: `/${label}`, isExternal: false, isVisible: true });
    const locations = {
      header: [
        { ...entry("about"), children: [entry("history"), entry("vision")] },
        { ...entry("research"), children: [entry("areas"), entry("projects"), entry("papers")] },
        { ...entry("people"), children: [] }
      ],
      footer: [{ ...entry("contact"), children: [entry("map")] }],
      utility: [{ ...entry("search"), children: [] }]
    };

    await inRolledBackTransaction(async (tx) => {
      await tx.navigationItem.deleteMany({});
      const { result: written, statements } = await countStatements(() => writeMenus(tx, locations));
      assert.equal(dataStatements(statements).length, 2, statements.join("\n"));
      assert.equal(written, 11);

      const rows = await tx.navigationItem.findMany({ orderBy: [{ location: "asc" }, { position: "asc" }] });
      const byId = new Map(rows.map((row) => [row.id, row]));
      const shape = rows
        .filter((row) => row.parentId !== null)
        .map((row) => `${row.location}:${byId.get(row.parentId ?? "")?.label}>${row.label}@${row.position}`)
        .sort();
      assert.deepEqual(shape, [
        "footer:contact>map@0",
        "header:about>history@0",
        "header:about>vision@1",
        "header:research>areas@0",
        "header:research>papers@2",
        "header:research>projects@1"
      ]);
      assert.deepEqual(
        rows.filter((row) => row.parentId === null).map((row) => `${row.location}:${row.label}@${row.position}`),
        ["footer:contact@0", "header:about@0", "header:research@1", "header:people@2", "utility:search@0"]
      );
    });
  });

  // ── Audit entries ─────────────────────────────────────────────────────────────────────────────

  it("writes a batch of audit entries as one statement", async () => {
    const entries: AuditInput[] = Array.from({ length: 25 }, (_, index) => ({
      action: "UPDATE",
      entityType: `${RUN}-entity`,
      entityId: `${RUN}-${index}`,
      after: { index }
    }));
    await inRolledBackTransaction(async (tx) => {
      const { statements } = await countStatements(() => writeAuditMany(tx, CONTEXT, entries));
      assert.equal(statements.length, 1);
      const rows = await tx.auditLog.findMany({
        where: { entityType: `${RUN}-entity` },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }]
      });
      assert.deepEqual(rows.map((row) => row.entityId), entries.map((entry) => entry.entityId));
      assert.equal(rows[0]?.ipAddress, "198.51.100.7");
      const none = await countStatements(() => writeAuditMany(tx, CONTEXT, []));
      assert.equal(none.statements.length, 0);
    });
  });

  // ── Registrations ─────────────────────────────────────────────────────────────────────────────

  async function registrations(count: number, prefix: string): Promise<string[]> {
    await prisma.eventRegistration.createMany({
      data: Array.from({ length: count }, (_, index) => ({
        eventId,
        name: `${prefix} ${index}`,
        email: `${RUN}-${prefix}-${index}@example.invalid`
      }))
    });
    return (
      await prisma.eventRegistration.findMany({
        where: { eventId, email: { startsWith: `${RUN}-${prefix}-` } },
        orderBy: { email: "asc" },
        select: { id: true }
      })
    ).map((row) => row.id);
  }

  it("moves a batch of registrations in the same number of statements at 3 rows and at 30", async () => {
    const event = { id: eventId, title: "Event", capacity: null };
    const body = { allowOverCapacity: true };
    const small = await registrations(3, "small");
    const large = await registrations(30, "large");

    const few = await countStatements(() =>
      applyRegistrationBatch({ event, ids: small, state: "CONFIRMED", body, context: CONTEXT })
    );
    const many = await countStatements(() =>
      applyRegistrationBatch({ event, ids: large, state: "CONFIRMED", body, context: CONTEXT })
    );

    // Lock, read the rows, count the places, one UPDATE, one audit INSERT.
    assert.equal(dataStatements(few.statements).length, 5, few.statements.join("\n"));
    assert.equal(dataStatements(many.statements).length, 5, many.statements.join("\n"));
    assert.equal(many.result.changed, 30);
    assert.equal(many.result.placesTaken, 33);

    const moved = await prisma.eventRegistration.count({ where: { id: { in: large }, state: "CONFIRMED" } });
    assert.equal(moved, 30);

    // One audit entry per person, in the order walked, each with the running count of places.
    const audit = await prisma.auditLog.findMany({
      where: { entityType: "EventRegistration", entityId: { in: large } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { entityId: true, after: true }
    });
    assert.deepEqual(audit.map((row) => row.entityId), large);
    assert.deepEqual(
      audit.map((row) => (row.after as { placesTakenAfter: number }).placesTakenAfter),
      large.map((_, index) => 4 + index)
    );

    // A row already in the state asked for is reported, not written.
    const repeat = await countStatements(() =>
      applyRegistrationBatch({ event, ids: small, state: "CONFIRMED", body, context: CONTEXT })
    );
    assert.equal(repeat.result.changed, 0);
    assert.equal(repeat.result.unchanged.length, 3);
    assert.equal(dataStatements(repeat.statements).length, 3, "no UPDATE and no audit INSERT when nothing moves");
  });

  it("moves a set of registrations with one audit statement however many people it covers", async () => {
    const event = { id: eventId, title: "Event" };
    const small = await registrations(2, "set-small");
    const large = await registrations(20, "set-large");
    const input = { state: "WAITLISTED" as const, allowOverCapacity: true, expectedPlacesTaken: undefined, context: CONTEXT };

    const few = await countStatements(() => applyRegistrationStates({ ...input, event, ids: small }));
    const many = await countStatements(() => applyRegistrationStates({ ...input, event, ids: large }));
    assert.equal(dataStatements(few.statements).length, dataStatements(many.statements).length);
    assert.equal(dataStatements(many.statements).length, 6, many.statements.join("\n"));
    assert.equal(many.result.changed, 20);
    assert.equal(await prisma.auditLog.count({ where: { entityType: "EventRegistration", entityId: { in: large } } }), 20);
  });

  // ── Slugs ─────────────────────────────────────────────────────────────────────────────────────

  it("finds a free file address in one statement however many are taken", async () => {
    const base = `${RUN}-annual-report`;
    await prisma.fileAsset.createMany({
      data: [base, `${base}-2`, `${base}-3`, `${base}-5`].map((slug) => ({ slug, title: slug }))
    });
    const { result, statements } = await countStatements(() => freeFileSlug(`${RUN} Annual Report`));
    assert.equal(result, `${base}-4`);
    assert.equal(statements.length, 1);

    const fresh = await countStatements(() => freeFileSlug(`${RUN} Unused title`));
    assert.equal(fresh.result, `${RUN}-unused-title`);
    assert.equal(fresh.statements.length, 1);
  });

  // ── Filter options ────────────────────────────────────────────────────────────────────────────

  it("reads each filter's options as one grouped, limited query that matches the old in-memory distinct", async () => {
    await prisma.auditLog.createMany({
      data: ["Zeta", "Alpha", "Alpha", "Mid", "Mid", "Mid"].map((type, index) => ({
        action: "UPDATE",
        entityType: `${RUN}-${type}`,
        entityId: `${RUN}-${index}`
      }))
    });

    try {
      const cases = [
        {
          name: "audit entity types",
          next: () => auditEntityTypeOptions(3),
          old: () =>
            prisma.auditLog.findMany({ select: { entityType: true }, distinct: ["entityType"], orderBy: { entityType: "asc" }, take: 3 })
        },
        {
          name: "enquiry forms",
          next: () => inquiryFormKeyOptions(5),
          old: () =>
            prisma.contactSubmission.findMany({
              where: { deletedAt: null },
              select: { formKey: true },
              distinct: ["formKey"],
              orderBy: { formKey: "asc" },
              take: 5
            })
        },
        {
          name: "file categories",
          next: () => fileCategoryOptions(5),
          old: () =>
            prisma.fileAsset.findMany({
              where: { deletedAt: null, NOT: { category: null } },
              select: { category: true },
              distinct: ["category"],
              orderBy: { category: "asc" },
              take: 5
            })
        },
        {
          name: "album categories",
          next: () => albumCategoryOptions(5),
          old: () =>
            prisma.galleryAlbum.findMany({
              where: { deletedAt: null, NOT: { category: null } },
              select: { category: true },
              distinct: ["category"],
              orderBy: { category: "asc" },
              take: 5
            })
        },
        {
          name: "publication years",
          next: () => publicationYearOptions(5),
          old: () =>
            prisma.publication.findMany({
              where: { deletedAt: null },
              distinct: ["year"],
              select: { year: true },
              orderBy: { year: "desc" },
              take: 5
            })
        }
      ];

      for (const entry of cases) {
        const fresh = await countStatements(async () => entry.next());
        const legacy = await entry.old();
        assert.deepEqual(fresh.result, legacy, entry.name);
        assert.equal(fresh.statements.length, 1, entry.name);
        const [sql] = fresh.statements;
        assert.match(sql ?? "", /GROUP BY/i, `${entry.name}: grouped by the database`);
        assert.match(sql ?? "", /LIMIT/i, `${entry.name}: limited by the database`);
      }
    } finally {
      await prisma.auditLog.deleteMany({ where: { entityType: { startsWith: `${RUN}-` } } });
    }
  });
});
