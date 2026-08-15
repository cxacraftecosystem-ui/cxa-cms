/**
 * THE CORPUS WRITER — turns the slug-linked modules in this directory into rows.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IT IS FOR. See `types.ts`: a fresh install has three pages and no content, so every showcase
 * on the homepage says it has nothing to show and the craft explorer is an empty map. This writes a
 * coherent body of demonstration content so the site can be seen, demonstrated and designed against
 * on the day it is installed.
 *
 * ⚠ IT IS IDEMPOTENT AND IT NEVER OVERWRITES. Every record is created only if its slug is absent.
 * Re-running the seed after an editor has rewritten a craft must not put the sample text back —
 * that would destroy their work silently, and "I edited it and it reverted" is the single worst
 * thing a CMS can do. The counters therefore report what was CREATED, not what was written.
 *
 * ⚠ EVERY CROSS-REFERENCE IS RESOLVED HERE, AND AN UNRESOLVED ONE IS REPORTED BY NAME. The corpus
 * modules are written independently and none of them can know a `cuid()`. A project naming a
 * research area that nobody defined would otherwise be written with a null and vanish from the one
 * page it exists for, with nothing anywhere saying so. `unresolved` collects each miss with the
 * record and the field it came from, and `main()` prints the list.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ THE PHOTOGRAPHS ARE THE BUNDLED ONES, ADDRESSED THROUGH THE CDN BASE.
 *
 * `MediaAsset.objectKey` is written as `craft/<slug>.jpg`, which is exactly where the file sits
 * under `public/`. `publicObjectUrl()` prefixes it with `NEXT_PUBLIC_CDN_URL`, so:
 *
 *   • With the variable set to the site's own origin (`http://localhost:3000` in development), every
 *     seeded photograph resolves to a real file this very server is already serving.
 *   • With it EMPTY — the default — `mediaSrc()` returns null and `MediaImage` draws its labelled
 *     "no CDN configured" placeholder. That is the correct, documented behaviour and it tells an
 *     operator precisely what is missing. It is not a bug in this file.
 *
 * The assets carry no `MediaVariant` rows, deliberately: the derivative pipeline has not run on
 * them, and inventing variant keys that point at files which do not exist would turn a working
 * placeholder into a broken image.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import { CRAFT_IMAGES } from "../../lib/media/craft-imagery";
import { CORPUS_STATUS, corpusSlugs, type CorpusModule } from "./types";

/** Where a cross-reference failed, in words a person can act on. */
export interface UnresolvedReference {
  /** "project", "craft", … */
  record: string;
  /** The record's own slug. */
  slug: string;
  /** The field that pointed nowhere. */
  field: string;
  /** The slug it pointed at. */
  target: string;
}

export interface CorpusResult {
  created: Record<string, number>;
  unresolved: UnresolvedReference[];
}

/**
 * A Tiptap document from plain paragraphs.
 *
 * ⚠ AN EMPTY `content` ARRAY IS NOT THE SAME AS NO DOCUMENT. Tiptap renders `{type:"doc"}` with no
 * content as an empty editor; `null` is what the schema means by "nothing written yet". Passing an
 * empty paragraph list therefore returns null rather than an empty doc.
 */
function richText(paragraphs: readonly string[]): Prisma.InputJsonValue | undefined {
  const filled = paragraphs.map((p) => p.trim()).filter((p) => p.length > 0);
  if (filled.length === 0) return undefined;
  return {
    type: "doc",
    content: filled.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] }))
  };
}

/** `YYYY-MM-DD` → a Date at UTC midnight, or undefined. Never `new Date("")`, which is Invalid Date. */
function isoDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

/** "Fieldwork" → "fieldwork"; "The Centre" → "the-centre". Matches `slugify` in lib/utils.ts. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Write the corpus.
 *
 * The order below is a DEPENDENCY ORDER and cannot be rearranged: regions before crafts, people and
 * research areas before projects and publications, categories and tags before posts.
 */
export async function seedCorpus(
  prisma: PrismaClient,
  modules: readonly CorpusModule[]
): Promise<CorpusResult> {
  const created: Record<string, number> = {};
  const unresolved: UnresolvedReference[] = [];
  const bump = (key: string) => {
    created[key] = (created[key] ?? 0) + 1;
  };

  const all = <T>(pick: (m: CorpusModule) => readonly T[] | undefined): T[] =>
    modules.flatMap((module) => [...(pick(module) ?? [])]);

  // ── Media, from the bundled manifest ──────────────────────────────────────
  const mediaBySlug = new Map<string, string>();
  for (const image of CRAFT_IMAGES) {
    const objectKey = `craft/${image.slug}.jpg`;
    const existing = await prisma.mediaAsset.findUnique({ where: { objectKey } });
    if (existing) {
      mediaBySlug.set(image.slug, existing.id);
      continue;
    }
    const row = await prisma.mediaAsset.create({
      data: {
        kind: "IMAGE",
        objectKey,
        fileName: `${image.slug}.jpg`,
        mimeType: "image/jpeg",
        // The manifest does not record the byte size and this column is not nullable. Zero is the
        // honest answer — "not measured" — and reads that way in the media library, where an
        // invented figure would be quietly wrong on every screen that totals storage.
        byteSize: 0,
        width: image.width,
        height: image.height,
        altText: image.title,
        caption: `${image.title} — ${image.region}.`,
        // The licence obligation, carried on the asset itself so it survives being used anywhere.
        credit: `${image.author}, ${image.licence}, via Wikimedia Commons`,
        tags: ["craft", "sample"]
      }
    });
    mediaBySlug.set(image.slug, row.id);
    bump("media");
  }

  const photoId = (slug: string | undefined, record: string, ownSlug: string): string | undefined => {
    if (!slug) return undefined;
    const id = mediaBySlug.get(slug);
    if (!id) unresolved.push({ record, slug: ownSlug, field: "photo", target: slug });
    return id;
  };

  // ── Regions: parents before children ──────────────────────────────────────
  const regionBySlug = new Map<string, string>();
  const regions = all((m) => m.regions);
  /*
   * Sorted by DEPTH, computed by walking each region's parent chain within the seed data itself.
   * A flat pass would fail for a district whose state happens to appear after it in the array, and
   * the corpus modules are written by different hands with no ordering contract between them.
   */
  const depthOf = (slug: string, seen = new Set<string>()): number => {
    if (seen.has(slug)) return 0; // A cycle. Treated as a root rather than recursed into.
    seen.add(slug);
    const region = regions.find((r) => r.slug === slug);
    return region?.parent ? depthOf(region.parent, seen) + 1 : 0;
  };
  const ordered = [...regions].sort((a, b) => depthOf(a.slug) - depthOf(b.slug));

  for (const region of ordered) {
    const existing = await prisma.craftRegion.findUnique({ where: { slug: region.slug } });
    if (existing) {
      regionBySlug.set(region.slug, existing.id);
      continue;
    }
    let parentId: string | undefined;
    if (region.parent) {
      parentId = regionBySlug.get(region.parent);
      if (!parentId) {
        unresolved.push({ record: "region", slug: region.slug, field: "parent", target: region.parent });
      }
    }
    const row = await prisma.craftRegion.create({
      data: {
        slug: region.slug,
        name: region.name,
        level: region.level,
        parentId: parentId ?? null,
        latitude: region.latitude ?? null,
        longitude: region.longitude ?? null
      }
    });
    regionBySlug.set(region.slug, row.id);
    bump("regions");
  }

  // ── Schools ───────────────────────────────────────────────────────────────
  const schoolBySlug = new Map<string, string>();
  for (const school of all((m) => m.schools)) {
    const existing = await prisma.craftSchool.findUnique({ where: { slug: school.slug } });
    if (existing) {
      schoolBySlug.set(school.slug, existing.id);
      continue;
    }
    const row = await prisma.craftSchool.create({
      data: { slug: school.slug, name: school.name, description: school.description ?? null }
    });
    schoolBySlug.set(school.slug, row.id);
    bump("schools");
  }

  // ── Crafts ────────────────────────────────────────────────────────────────
  for (const craft of all((m) => m.crafts)) {
    if (await prisma.craft.findUnique({ where: { slug: craft.slug } })) continue;

    const regionId = regionBySlug.get(craft.region);
    if (!regionId) {
      unresolved.push({ record: "craft", slug: craft.slug, field: "region", target: craft.region });
    }
    let schoolId: string | undefined;
    if (craft.school) {
      schoolId = schoolBySlug.get(craft.school);
      if (!schoolId) {
        unresolved.push({ record: "craft", slug: craft.slug, field: "school", target: craft.school });
      }
    }

    await prisma.craft.create({
      data: {
        slug: craft.slug,
        name: craft.name,
        localName: craft.localName ?? null,
        localNameLang: craft.localNameLang ?? null,
        summary: craft.summary,
        body: richText(craft.bodyParagraphs),
        regionId: regionId ?? null,
        schoolId: schoolId ?? null,
        originYear: craft.originYear ?? null,
        originNote: craft.originNote ?? null,
        materials: craft.materials,
        techniques: craft.techniques,
        latitude: craft.latitude ?? null,
        longitude: craft.longitude ?? null,
        coverId: photoId(craft.photo, "craft", craft.slug) ?? null,
        status: CORPUS_STATUS,
        publishedAt: new Date(),
        isFeatured: craft.isFeatured ?? false
      }
    });
    bump("crafts");
  }

  // ── Research areas ────────────────────────────────────────────────────────
  const areaBySlug = new Map<string, string>();
  for (const [index, area] of all((m) => m.researchAreas).entries()) {
    const existing = await prisma.researchArea.findUnique({ where: { slug: area.slug } });
    if (existing) {
      areaBySlug.set(area.slug, existing.id);
      continue;
    }
    const row = await prisma.researchArea.create({
      data: {
        slug: area.slug,
        title: area.title,
        summary: area.summary,
        body: richText(area.bodyParagraphs),
        icon: area.icon ?? null,
        coverId: photoId(area.photo, "researchArea", area.slug) ?? null,
        sortOrder: area.sortOrder ?? index,
        status: CORPUS_STATUS,
        publishedAt: new Date()
      }
    });
    areaBySlug.set(area.slug, row.id);
    bump("researchAreas");
  }

  // ── People ────────────────────────────────────────────────────────────────
  const personBySlug = new Map<string, string>();
  for (const [index, person] of all((m) => m.people).entries()) {
    const existing = await prisma.person.findUnique({ where: { slug: person.slug } });
    if (existing) {
      personBySlug.set(person.slug, existing.id);
      continue;
    }
    const row = await prisma.person.create({
      data: {
        slug: person.slug,
        name: person.name,
        kind: person.kind,
        designation: person.designation ?? null,
        department: person.department ?? null,
        bio: person.bio,
        email: person.email ?? null,
        website: person.website ?? null,
        orcid: person.orcid ?? null,
        googleScholar: person.googleScholar ?? null,
        researchInterests: person.researchInterests,
        sortOrder: person.sortOrder ?? index,
        isVisible: true,
        status: CORPUS_STATUS,
        publishedAt: new Date()
      }
    });
    personBySlug.set(person.slug, row.id);
    bump("people");
  }

  // ── Projects ──────────────────────────────────────────────────────────────
  for (const [index, project] of all((m) => m.projects).entries()) {
    if (await prisma.project.findUnique({ where: { slug: project.slug } })) continue;

    let researchAreaId: string | undefined;
    if (project.researchArea) {
      researchAreaId = areaBySlug.get(project.researchArea);
      if (!researchAreaId) {
        unresolved.push({
          record: "project",
          slug: project.slug,
          field: "researchArea",
          target: project.researchArea
        });
      }
    }

    const row = await prisma.project.create({
      data: {
        slug: project.slug,
        title: project.title,
        tagline: project.tagline ?? null,
        summary: project.summary,
        body: richText(project.bodyParagraphs),
        state: project.state,
        researchAreaId: researchAreaId ?? null,
        fundingBody: project.fundingBody ?? null,
        fundingAmount: project.fundingAmount ?? null,
        fundingCurrency: project.fundingCurrency ?? null,
        startedOn: isoDate(project.startedOn) ?? null,
        endedOn: isoDate(project.endedOn) ?? null,
        progress: project.progress ?? 0,
        coverId: photoId(project.photo, "project", project.slug) ?? null,
        status: CORPUS_STATUS,
        publishedAt: new Date(),
        isFeatured: project.isFeatured ?? false,
        sortOrder: index
      }
    });
    bump("projects");

    for (const [position, member] of (project.members ?? []).entries()) {
      const personId = personBySlug.get(member.person);
      if (!personId) {
        unresolved.push({ record: "project", slug: project.slug, field: "member", target: member.person });
        continue;
      }
      await prisma.projectMember.create({
        data: {
          projectId: row.id,
          personId,
          // `isLead` is expressed in the ROLE rather than in a column, because the schema has no
          // lead flag and the role is what every screen actually renders.
          role: member.isLead ? `${member.role} (lead)` : member.role,
          position
        }
      });
    }

    for (const [position, milestone] of (project.milestones ?? []).entries()) {
      await prisma.projectMilestone.create({
        data: {
          projectId: row.id,
          title: milestone.title,
          detail: milestone.detail ?? null,
          dueOn: isoDate(milestone.dueOn) ?? null,
          completedOn: milestone.isComplete ? (isoDate(milestone.dueOn) ?? new Date()) : null,
          position
        }
      });
    }
  }

  // ── Publications ──────────────────────────────────────────────────────────
  for (const publication of all((m) => m.publications)) {
    if (await prisma.publication.findUnique({ where: { slug: publication.slug } })) continue;

    let researchAreaId: string | undefined;
    if (publication.researchArea) {
      researchAreaId = areaBySlug.get(publication.researchArea);
      if (!researchAreaId) {
        unresolved.push({
          record: "publication",
          slug: publication.slug,
          field: "researchArea",
          target: publication.researchArea
        });
      }
    }

    const row = await prisma.publication.create({
      data: {
        slug: publication.slug,
        kind: publication.kind,
        title: publication.title,
        abstract: publication.abstract ?? null,
        authorLine: publication.authorLine,
        venue: publication.venue ?? null,
        publisher: publication.publisher ?? null,
        volume: publication.volume ?? null,
        issue: publication.issue ?? null,
        pages: publication.pages ?? null,
        year: publication.year,
        month: publication.month ?? null,
        doi: publication.doi ?? null,
        keywords: publication.keywords,
        researchAreaId: researchAreaId ?? null,
        isFeatured: publication.isFeatured ?? false,
        status: CORPUS_STATUS,
        publishedAt: new Date()
      }
    });
    bump("publications");

    for (const [position, slug] of (publication.authors ?? []).entries()) {
      const personId = personBySlug.get(slug);
      if (!personId) {
        unresolved.push({ record: "publication", slug: publication.slug, field: "author", target: slug });
        continue;
      }
      await prisma.publicationAuthor.create({
        data: { publicationId: row.id, personId, position }
      });
    }
  }

  // ── Newsroom: categories and tags first ───────────────────────────────────
  const categoryBySlug = new Map<string, string>();
  const tagBySlug = new Map<string, string>();

  const ensureCategory = async (name: string): Promise<string> => {
    const slug = slugify(name);
    const cached = categoryBySlug.get(slug);
    if (cached) return cached;
    const existing = await prisma.category.findUnique({ where: { slug } });
    if (existing) {
      categoryBySlug.set(slug, existing.id);
      return existing.id;
    }
    const row = await prisma.category.create({ data: { slug, name } });
    categoryBySlug.set(slug, row.id);
    bump("categories");
    return row.id;
  };

  const ensureTag = async (name: string): Promise<string> => {
    const slug = slugify(name);
    const cached = tagBySlug.get(slug);
    if (cached) return cached;
    const existing = await prisma.tag.findUnique({ where: { slug } });
    if (existing) {
      tagBySlug.set(slug, existing.id);
      return existing.id;
    }
    const row = await prisma.tag.create({ data: { slug, name } });
    tagBySlug.set(slug, row.id);
    bump("tags");
    return row.id;
  };

  for (const post of all((m) => m.posts)) {
    if (await prisma.post.findUnique({ where: { slug: post.slug } })) continue;

    const publishedAt = daysFromNow(-Math.abs(post.publishedDaysAgo));
    const row = await prisma.post.create({
      data: {
        slug: post.slug,
        title: post.title,
        subtitle: post.subtitle ?? null,
        excerpt: post.excerpt,
        body: richText(post.bodyParagraphs),
        coverId: photoId(post.photo, "post", post.slug) ?? null,
        categoryId: post.category ? await ensureCategory(post.category) : null,
        status: CORPUS_STATUS,
        publishedAt,
        isFeatured: post.isFeatured ?? false,
        // Roughly 200 words a minute over the body, floored at one. Stored rather than computed at
        // render time because the newsroom card shows it and the body is a JSON column.
        readingMinutes: Math.max(
          1,
          Math.round(post.bodyParagraphs.join(" ").split(/\s+/).length / 200)
        )
      }
    });
    bump("posts");

    for (const tag of post.tags ?? []) {
      await prisma.postTag.create({ data: { postId: row.id, tagId: await ensureTag(tag) } });
    }
  }

  // ── Events ────────────────────────────────────────────────────────────────
  for (const event of all((m) => m.events)) {
    if (await prisma.coeEvent.findUnique({ where: { slug: event.slug } })) continue;

    const startsAt = daysFromNow(event.startsInDays);
    const endsAt = event.durationHours
      ? new Date(startsAt.getTime() + event.durationHours * 60 * 60 * 1000)
      : null;

    const row = await prisma.coeEvent.create({
      data: {
        slug: event.slug,
        title: event.title,
        subtitle: event.subtitle ?? null,
        summary: event.summary,
        body: richText(event.bodyParagraphs),
        mode: event.mode,
        venue: event.venue ?? null,
        address: event.address ?? null,
        latitude: event.latitude ?? null,
        longitude: event.longitude ?? null,
        onlineUrl: event.onlineUrl ?? null,
        startsAt,
        endsAt,
        capacity: event.capacity ?? null,
        // ⚠ A PAST EVENT IS NEVER OPEN FOR REGISTRATION, whatever the corpus said. The two are
        // written by different hands and a card reading "Registration open" under a date last March
        // is the sort of contradiction that makes a whole site look untended.
        isRegistrationOpen: event.startsInDays > 0 ? (event.isRegistrationOpen ?? false) : false,
        coverId: photoId(event.photo, "event", event.slug) ?? null,
        status: CORPUS_STATUS,
        publishedAt: new Date(),
        isFeatured: event.isFeatured ?? false
      }
    });
    bump("events");

    for (const [position, item] of (event.agenda ?? []).entries()) {
      let itemStart: Date | null = null;
      if (item.startsAt) {
        const [hours, minutes] = item.startsAt.split(":").map(Number);
        if (Number.isFinite(hours) && Number.isFinite(minutes)) {
          itemStart = new Date(startsAt);
          itemStart.setHours(hours ?? 0, minutes ?? 0, 0, 0);
        }
      }
      await prisma.eventAgendaItem.create({
        data: {
          eventId: row.id,
          title: item.title,
          detail: item.detail ?? null,
          speaker: item.speaker ?? null,
          startsAt: itemStart,
          position
        }
      });
    }
  }

  // ── Partners ──────────────────────────────────────────────────────────────
  for (const [index, partner] of all((m) => m.partners).entries()) {
    if (await prisma.partner.findUnique({ where: { slug: partner.slug } })) continue;
    await prisma.partner.create({
      data: {
        slug: partner.slug,
        name: partner.name,
        url: partner.url ?? null,
        category: partner.category ?? null,
        sortOrder: partner.sortOrder ?? index,
        isVisible: true
      }
    });
    bump("partners");
  }

  // ── Gallery albums: the books on the shelf ────────────────────────────────
  // After media (each item resolves a manifest photograph) and independent of everything else.
  // The cover defaults to the first item's photograph — an album whose cover is not one of its
  // own pages would be a book wearing another book's jacket.
  for (const [index, album] of all((m) => m.galleryAlbums).entries()) {
    if (await prisma.galleryAlbum.findUnique({ where: { slug: album.slug } })) continue;

    const coverId = photoId(album.cover ?? album.items[0]?.photo, "galleryAlbum", album.slug);
    const created_ = await prisma.galleryAlbum.create({
      data: {
        slug: album.slug,
        title: album.title,
        description: album.description ?? null,
        category: album.category ?? null,
        location: album.location ?? null,
        happenedOn: album.happenedOn ? new Date(album.happenedOn) : null,
        coverId: coverId ?? null,
        sortOrder: index,
        status: CORPUS_STATUS,
        publishedAt: new Date()
      }
    });
    bump("galleryAlbums");

    for (const [position, item] of album.items.entries()) {
      const assetId = photoId(item.photo, "galleryAlbum", album.slug);
      if (!assetId) continue; // Already reported by photoId — a missing page must not sink the book.
      await prisma.galleryItem.create({
        data: {
          albumId: created_.id,
          assetId,
          position,
          caption: item.caption ?? null,
          presentation: "image"
        }
      });
      bump("galleryItems");
    }
  }

  return { created, unresolved };
}

/**
 * Remove every record the corpus declares, by slug.
 *
 * ⚠ IT DELETES BY THE SLUGS THE MODULES DECLARE AND NOTHING ELSE — see the long note on
 * `corpusSlugs` in types.ts. A record an editor has RENAMED is deliberately left behind: renaming is
 * the first thing somebody evaluating the software does, and deleting their edited version to tidy
 * up sample content would be data loss. Leaving one behind is untidy; removing one is unrecoverable.
 *
 * Order is the reverse of creation. The join rows (`ProjectMember`, `PublicationAuthor`, `PostTag`,
 * `ProjectMilestone`, `EventAgendaItem`) all cascade from their parents, so they need no pass of
 * their own; the media assets do NOT cascade and are removed by their own object keys.
 */
export async function purgeCorpus(
  prisma: PrismaClient,
  modules: readonly CorpusModule[]
): Promise<Record<string, number>> {
  const slugs = corpusSlugs(modules);
  const removed: Record<string, number> = {};

  const wipe = async (key: string, run: () => Promise<{ count: number }>) => {
    const { count } = await run();
    if (count > 0) removed[key] = count;
  };

  // Albums first: their items cascade with them, and their covers reference the media wiped below.
  await wipe("galleryAlbums", () =>
    prisma.galleryAlbum.deleteMany({ where: { slug: { in: slugs.galleryAlbums } } })
  );
  await wipe("posts", () => prisma.post.deleteMany({ where: { slug: { in: slugs.posts } } }));
  await wipe("events", () => prisma.coeEvent.deleteMany({ where: { slug: { in: slugs.events } } }));
  await wipe("publications", () =>
    prisma.publication.deleteMany({ where: { slug: { in: slugs.publications } } })
  );
  await wipe("projects", () => prisma.project.deleteMany({ where: { slug: { in: slugs.projects } } }));
  await wipe("people", () => prisma.person.deleteMany({ where: { slug: { in: slugs.people } } }));
  await wipe("researchAreas", () =>
    prisma.researchArea.deleteMany({ where: { slug: { in: slugs.researchAreas } } })
  );
  await wipe("crafts", () => prisma.craft.deleteMany({ where: { slug: { in: slugs.crafts } } }));
  await wipe("schools", () => prisma.craftSchool.deleteMany({ where: { slug: { in: slugs.schools } } }));
  await wipe("regions", () => prisma.craftRegion.deleteMany({ where: { slug: { in: slugs.regions } } }));
  await wipe("partners", () => prisma.partner.deleteMany({ where: { slug: { in: slugs.partners } } }));
  await wipe("media", () =>
    prisma.mediaAsset.deleteMany({
      where: { objectKey: { in: CRAFT_IMAGES.map((image) => `craft/${image.slug}.jpg`) } }
    })
  );

  return removed;
}
