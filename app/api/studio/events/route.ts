import { z } from "zod";
import { Prisma } from "@prisma/client";

import { assertSameOrigin, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { MEDIA_IMAGE_SELECT_WITH_ID } from "@/lib/media/select";
import { canAccessStudio, canManageContent } from "@/lib/permissions";
import { parseRichText } from "@/lib/richtext";
import {
  assertMediaAvailable,
  assertSlugAvailable,
  binWhere,
  buildAuditContext,
  fieldProblem,
  isUniqueViolation,
  listQuerySchema,
  optionalDateTime,
  optionalId,
  optionalText,
  pageWindow,
  paginated,
  parseStudioJson,
  parseStudioQuery,
  publishTransition,
  requiredDateTime,
  requiredText,
  resolveSort,
  resolveTagIds,
  screenFramingField,
  slugFromTitle,
  slugSchema,
  statusSchema,
  syncSearchDocument,
  textSearchWhere
} from "@/lib/studio/crud";

/**
 * Events — the list, and creating one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * AN EVENT CANNOT BE SCHEDULED, and that is not an oversight. `CoeEvent` has `status` but no `publishAt`
 * column, so `liveStatusWhere()` treats only PUBLISHED as public — a SCHEDULED event would sit in the
 * studio looking imminent and never appear on the site at all. `publishTransition()` is called WITHOUT
 * `schedulable`, so it refuses the state and says what to choose instead.
 *
 * TIMES ARE ABSOLUTE INSTANTS. The site renders them in the Centre's timezone, which is a setting rather
 * than the reader's locale (prisma/schema.prisma): "the seminar is at 4pm" has to mean one time for
 * everybody. This handler therefore stores exactly what it is given and never re-interprets a date.
 *
 * `capacity: 0` IS NOT "UNLIMITED". Null is unlimited; zero means no places at all and everybody waits.
 * The public registration route reads it the same way, and treating one as the other would over-fill an
 * event whose organiser typed a nought on purpose.
 *
 * SPEAKERS, PICTURES AND TAGS ARE REPLACED WHOLE from the lists the editor sends, and an id that no longer
 * exists is DROPPED rather than refused: the cause is always another editor deleting a person or a
 * photograph while this screen was open, and failing the whole save over it would strand the organiser with
 * no way forward from that screen.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const TAG_LIMIT = 12;
const SPEAKER_LIMIT = 40;
const GALLERY_LIMIT = 120;
const AGENDA_LIMIT = 60;

const SORTABLE = {
  startsAt: "startsAt",
  updatedAt: "updatedAt",
  createdAt: "createdAt",
  publishedAt: "publishedAt",
  title: "title"
} as const;

const listSchema = listQuerySchema.extend({
  /** Which side of today. `upcoming` empties itself as events pass, which is what a dashboard wants. */
  when: z.enum(["", "upcoming", "past"]).default(""),
  mode: z.enum(["", "IN_PERSON", "ONLINE", "HYBRID"]).default(""),
  featured: z.enum(["", "true", "false"]).default(""),
  registration: z.enum(["", "open", "closed"]).default(""),
  tag: z.string().trim().max(96).default("")
});

const agendaItemSchema = z.object({
  title: requiredText(200, "An agenda line needs a title."),
  detail: optionalText(1000),
  /** Free text, not a person id: an agenda line often names somebody who is not in the people list. */
  speaker: optionalText(160),
  startsAt: optionalDateTime("The start of an agenda line"),
  endsAt: optionalDateTime("The end of an agenda line")
});

const eventBodySchema = z.object({
  title: requiredText(200, "An event needs a title. It appears in every listing and in search results."),
  /** May arrive empty, in which case it is taken from the title. */
  slug: z.union([z.literal(""), slugSchema()]).optional(),
  subtitle: optionalText(240),
  summary: optionalText(600),
  body: z.unknown().optional(),
  mode: z.enum(["IN_PERSON", "ONLINE", "HYBRID"]).default("IN_PERSON"),
  venue: optionalText(240),
  address: optionalText(400),
  // Degrees, checked against the real range. A longitude typed into the latitude box is the commonest
  // version of this mistake, and it puts the venue in the sea.
  latitude: z
    .union([
      z.coerce
        .number()
        .min(-90, "A latitude is between -90 and 90. Check the two numbers are not swapped.")
        .max(90, "A latitude is between -90 and 90. Check the two numbers are not swapped."),
      z.null()
    ])
    .default(null),
  longitude: z
    .union([
      z.coerce.number().min(-180, "A longitude is between -180 and 180.").max(180, "A longitude is between -180 and 180."),
      z.null()
    ])
    .default(null),
  onlineUrl: optionalText(500).refine(
    (value) => value === null || /^https?:\/\//i.test(value),
    "A joining link must be a full address beginning with https://."
  ),
  startsAt: requiredDateTime("The start", "An event needs a date and time to start."),
  endsAt: optionalDateTime("The end"),
  registrationUrl: optionalText(500).refine(
    (value) => value === null || /^https?:\/\//i.test(value),
    "A registration link must be a full address beginning with https://."
  ),
  registrationOpensAt: optionalDateTime("The date registration opens"),
  registrationClosesAt: optionalDateTime("The date registration closes"),
  capacity: z
    .union([
      z.coerce
        .number()
        .int("A capacity is a whole number of people.")
        .min(0, "A capacity cannot be negative. Leave it empty for no limit.")
        .max(1_000_000, "That capacity is larger than any real room. Leave it empty for no limit."),
      z.null()
    ])
    .default(null),
  isRegistrationOpen: z.boolean().default(false),
  coverId: optionalId(),
  /**
   * The cover's per-screen framing. Accepted on creation as well as on the PATCH, because the editor is the
   * same form either way — a route that stripped it here would take a framing an editor set before their
   * first save and drop it without saying so.
   */
  coverScreens: screenFramingField(),
  galleryIds: z
    .array(z.string().trim().max(40))
    .max(GALLERY_LIMIT, `An event holds at most ${GALLERY_LIMIT} pictures. Put the rest in a gallery album.`)
    .default([]),
  /**
   * The gallery ROWS' per-screen framings, and each entry NAMES ITS PICTURE.
   *
   * ⚠ NOT A PARALLEL ARRAY ALONGSIDE `galleryIds`. That list is written by an id picker and stays a list of
   * ids; a second array matched to it by index would have to be kept in step by hand, and the first
   * re-order would frame the wrong photograph. Naming the asset in each entry means the two cannot drift.
   *
   * `.optional()` rather than `.default([])`: absent means "this caller has nothing to say about framing",
   * which must leave every stored framing alone — an empty list, by contrast, is a real answer meaning
   * nobody has framed anything.
   */
  galleryScreens: z
    .array(z.object({ assetId: z.string().trim().max(40), screens: screenFramingField() }))
    .max(GALLERY_LIMIT)
    .optional(),
  speakerIds: z
    .array(z.string().trim().max(40))
    .max(SPEAKER_LIMIT, `An event lists at most ${SPEAKER_LIMIT} speakers.`)
    .default([]),
  tags: z
    .array(z.string().trim().max(40))
    .max(TAG_LIMIT, `Use at most ${TAG_LIMIT} tags.`)
    .default([]),
  agenda: z
    .array(agendaItemSchema)
    .max(AGENDA_LIMIT, `An agenda holds at most ${AGENDA_LIMIT} lines. Split a longer programme by day.`)
    .default([]),
  status: statusSchema.default("DRAFT"),
  isFeatured: z.boolean().default(false)
});

const EVENT_SELECT = {
  id: true,
  slug: true,
  title: true,
  subtitle: true,
  summary: true,
  body: true,
  mode: true,
  venue: true,
  address: true,
  latitude: true,
  longitude: true,
  onlineUrl: true,
  startsAt: true,
  endsAt: true,
  registrationUrl: true,
  registrationOpensAt: true,
  registrationClosesAt: true,
  capacity: true,
  isRegistrationOpen: true,
  coverId: true,
  // Selected beside the cover it frames, so the created row answers with the framing it was given.
  coverScreens: true,
  status: true,
  publishedAt: true,
  isFeatured: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true
} as const;

type EventRow = Prisma.CoeEventGetPayload<{ select: typeof EVENT_SELECT }>;

export const GET = route(async (request: Request) => {
  await requireCapability(canAccessStudio);

  const query = parseStudioQuery(request, listSchema);
  const { page, pageSize, skip, take } = pageWindow(query);
  const now = new Date();

  const where: Record<string, unknown> = {
    ...binWhere(query.bin),
    ...(query.status === "" ? {} : { status: query.status }),
    ...(query.mode === "" ? {} : { mode: query.mode }),
    ...(query.featured === "" ? {} : { isFeatured: query.featured === "true" }),
    ...(query.registration === "" ? {} : { isRegistrationOpen: query.registration === "open" }),
    ...(query.tag === "" ? {} : { tags: { some: { tag: { slug: query.tag } } } }),
    ...(query.when === "" ? {} : { startsAt: query.when === "upcoming" ? { gte: now } : { lt: now } }),
    ...textSearchWhere(query.q, ["title", "subtitle", "summary", "venue"])
  };

  const [rows, total] = await prisma.$transaction([
    prisma.coeEvent.findMany({
      where,
      orderBy: resolveSort(query, SORTABLE, "startsAt"),
      skip,
      take,
      select: {
        id: true,
        slug: true,
        title: true,
        subtitle: true,
        mode: true,
        venue: true,
        startsAt: true,
        endsAt: true,
        capacity: true,
        isRegistrationOpen: true,
        status: true,
        publishedAt: true,
        isFeatured: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
        // Beside the picture, so a caller of this list can resolve the framing rather than
        // drawing every framed cover unframed. `coverId` is the key `pictureFromMap` resolves by.
        coverId: true,
        coverScreens: true,
        cover: { select: MEDIA_IMAGE_SELECT_WITH_ID },
        tags: { select: { tag: { select: { id: true, name: true, slug: true } } } },
        _count: { select: { registrations: true } }
      }
    }),
    prisma.coeEvent.count({ where })
  ]);

  return ok(
    paginated(
      rows.map(({ tags, _count, ...row }) => ({
        ...row,
        tags: tags.map((link) => link.tag),
        // The number of REGISTRATIONS, not of places taken — those are the confirmed and attended ones
        // only, and the registrations screen is where that distinction is drawn and stated.
        registrationCount: _count.registrations
      })),
      total,
      page,
      pageSize
    )
  );
});

export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  const user = await requireCapability(
    canManageContent,
    "Creating an event needs editor access. An administrator can raise yours."
  );

  const body = await parseStudioJson(request, eventBodySchema);

  const slug = body.slug && body.slug.length > 0 ? body.slug : slugFromTitle(body.title);
  if (slug.length === 0) {
    throw fieldProblem(
      "slug",
      "This event needs a web address, and one could not be made from its title. Type one — lower-case letters, numbers and hyphens."
    );
  }

  assertTimeOrder(body);
  await assertSlugAvailable("event", slug);
  await assertMediaAvailable(prisma, body.coverId, { field: "coverId", what: "cover picture" });

  // Refused rather than defaulted: `CoeEvent` cannot store a publication date, so a SCHEDULED event would
  // never go public. `publishTransition` says so in the words the editor's own status control uses.
  const transition = publishTransition({ status: "DRAFT", publishedAt: null }, { status: body.status }, user);

  const doc = parseRichText(body.body ?? null);

  const [speakerIds, assetIds] = await Promise.all([
    livePersonIds(body.speakerIds),
    liveAssetIds(body.galleryIds)
  ]);

  try {
    const created = await mutateWithHistory<EventRow>(
      buildAuditContext(request, user),
      {
        action: transition.action,
        entityType: "CoeEvent",
        entityLabel: body.title,
        summary: "Created"
      },
      async (tx) => {
        const row = await tx.coeEvent.create({
          data: {
            title: body.title,
            slug,
            subtitle: body.subtitle,
            summary: body.summary,
            body: doc === null ? Prisma.JsonNull : (doc as unknown as Prisma.InputJsonValue),
            mode: body.mode,
            venue: body.venue,
            address: body.address,
            latitude: body.latitude,
            longitude: body.longitude,
            onlineUrl: body.onlineUrl,
            startsAt: body.startsAt,
            endsAt: body.endsAt,
            registrationUrl: body.registrationUrl,
            registrationOpensAt: body.registrationOpensAt,
            registrationClosesAt: body.registrationClosesAt,
            capacity: body.capacity,
            isRegistrationOpen: body.isRegistrationOpen,
            coverId: body.coverId,
            /**
             * Absent and cleared are the same answer on a CREATE — there is no stored framing to leave
             * alone — and both mean SQL NULL. `Prisma.JsonNull` rather than a bare `null`, because on a
             * Json column `null` means "ignore this field" and the column would take its default instead.
             */
            coverScreens: body.coverScreens
              ? (body.coverScreens as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            isFeatured: body.isFeatured,
            status: transition.status,
            ...(transition.publishedAt ? { publishedAt: transition.publishedAt } : {})
          },
          select: EVENT_SELECT
        });

        if (body.agenda.length > 0) {
          await tx.eventAgendaItem.createMany({
            // The array order IS the order. Nothing on screen carries a position number, so deriving it
            // from the list is the only reading that cannot disagree with what the organiser sees.
            data: body.agenda.map((item, index) => ({
              eventId: row.id,
              title: item.title,
              detail: item.detail,
              speaker: item.speaker,
              startsAt: item.startsAt,
              endsAt: item.endsAt,
              position: index
            }))
          });
        }

        if (speakerIds.length > 0) {
          await tx.eventSpeaker.createMany({
            data: speakerIds.map((personId, index) => ({ eventId: row.id, personId, position: index })),
            skipDuplicates: true
          });
        }

        if (assetIds.length > 0) {
          // The framing travels with the picture it frames, so an event created with a row already framed
          // keeps it. `Prisma.JsonNull` for a row nobody framed, for the reason given on `coverScreens`.
          // `as const` so each pair infers as a TUPLE rather than an array of the union of its two
          // members, which is what `new Map` needs to see.
          const framings = new Map(
            (body.galleryScreens ?? []).map((entry) => [entry.assetId, entry.screens ?? null] as const)
          );
          await tx.eventMedia.createMany({
            data: assetIds.map((assetId, index) => {
              const screens = framings.get(assetId) ?? null;
              return {
                eventId: row.id,
                assetId,
                position: index,
                assetScreens: screens ? (screens as unknown as Prisma.InputJsonValue) : Prisma.JsonNull
              };
            }),
            skipDuplicates: true
          });
        }

        const tagIds = await resolveTagIds(tx, body.tags);
        if (tagIds.length > 0) {
          await tx.eventTag.createMany({
            data: tagIds.map((tagId) => ({ eventId: row.id, tagId })),
            skipDuplicates: true
          });
        }

        const indexable = await tx.coeEvent.findUnique({
          where: { id: row.id },
          select: {
            id: true,
            slug: true,
            title: true,
            subtitle: true,
            summary: true,
            body: true,
            mode: true,
            venue: true,
            address: true,
            status: true,
            publishedAt: true,
            deletedAt: true,
            tags: { select: { tag: { select: { name: true } } } }
          }
        });
        if (indexable) await syncSearchDocument(tx, "event", indexable);

        return row;
      }
    );

    return ok({ event: created }, { status: 201 });
  } catch (error) {
    if (isUniqueViolation(error)) await assertSlugAvailable("event", slug);
    throw error;
  }
});

/**
 * The two impossible orderings, refused by name.
 *
 * Both are attached to the field that is wrong rather than to the form, because an organiser who has just
 * typed one date needs to know which of the four boxes to look at.
 */
function assertTimeOrder(values: {
  startsAt: Date;
  endsAt: Date | null;
  registrationOpensAt: Date | null;
  registrationClosesAt: Date | null;
}): void {
  if (values.endsAt && values.endsAt <= values.startsAt) {
    throw fieldProblem("endsAt", "An event cannot end before it starts. Check the finishing time.");
  }
  if (
    values.registrationOpensAt &&
    values.registrationClosesAt &&
    values.registrationClosesAt <= values.registrationOpensAt
  ) {
    throw fieldProblem(
      "registrationClosesAt",
      "Registration cannot close before it opens. Check the two registration dates."
    );
  }
}

/** The people who still exist, in the order given. See the note in the header about dropping. */
async function livePersonIds(ids: readonly string[]): Promise<string[]> {
  const wanted = [...new Set(ids.filter((id) => id.length > 0))];
  if (wanted.length === 0) return [];
  const rows = await prisma.person.findMany({
    where: { id: { in: wanted }, deletedAt: null },
    select: { id: true }
  });
  const live = new Set(rows.map((row) => row.id));
  return wanted.filter((id) => live.has(id));
}

/** The pictures that are still in the library, in the order given. */
async function liveAssetIds(ids: readonly string[]): Promise<string[]> {
  const wanted = [...new Set(ids.filter((id) => id.length > 0))];
  if (wanted.length === 0) return [];
  const rows = await prisma.mediaAsset.findMany({
    where: { id: { in: wanted }, deletedAt: null },
    select: { id: true }
  });
  const live = new Set(rows.map((row) => row.id));
  return wanted.filter((id) => live.has(id));
}
