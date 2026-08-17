import { z } from "zod";
import { Prisma } from "@prisma/client";

import { assertSameOrigin, noContent, ok, route } from "@/lib/api";
import { mutateWithHistory, type TxClient } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { MEDIA_IMAGE_SELECT_WITH_ID } from "@/lib/media/select";
import { canAccessStudio, canManageContent } from "@/lib/permissions";
import { parseRichText } from "@/lib/richtext";
import {
  assertMediaAvailable,
  assertSlugAvailable,
  buildAuditContext,
  dropSearchDocument,
  fieldProblem,
  found,
  isUniqueViolation,
  optionalDateTime,
  optionalId,
  optionalText,
  parseStudioJson,
  publishTransition,
  requiredDateTime,
  requiredText,
  resolveTagIds,
  slugSchema,
  statusSchema,
  syncSearchDocument
} from "@/lib/studio/crud";

/**
 * One event: read it, save it, put it in the recycle bin.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * REPLACING A LIST MUST NOT THROW AWAY WHAT THE LIST DOES NOT CARRY.
 *
 * The editor sends speakers and pictures as plain arrays of ids — the order is the order — but the rows
 * behind them hold more than an id: `EventSpeaker.role` and `EventMedia.caption` are edited elsewhere. A
 * "delete everything and re-create it" replacement would therefore quietly wipe every speaker's role and
 * every caption each time somebody re-ordered the list.
 *
 * So the replacement is: delete the rows that are no longer wanted, then UPSERT the ones that are, writing
 * only the position. A row that survives keeps its other columns.
 *
 * THE AGENDA IS THE EXCEPTION, and it is deliberate: agenda lines have no identity of their own in the
 * editor (no id crosses the wire), so there is nothing to match an existing row against. They are replaced
 * outright, which is correct precisely because the row holds nothing the editor did not send.
 *
 * DELETING AN EVENT LEAVES ITS REGISTRATIONS ALONE. `EventRegistration` cascades on a REAL delete only, and
 * this is a soft delete — so an event restored from the recycle bin still has its attendance list, and the
 * people who registered have not been silently dropped from a record they are part of.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const TAG_LIMIT = 12;
const SPEAKER_LIMIT = 40;
const GALLERY_LIMIT = 120;
const AGENDA_LIMIT = 60;

const agendaItemSchema = z.object({
  title: requiredText(200, "An agenda line needs a title."),
  detail: optionalText(1000),
  speaker: optionalText(160),
  startsAt: optionalDateTime("The start of an agenda line"),
  endsAt: optionalDateTime("The end of an agenda line")
});

const eventBodySchema = z.object({
  title: requiredText(200, "An event needs a title. It appears in every listing and in search results."),
  slug: z.union([z.literal(""), slugSchema()]),
  subtitle: optionalText(240),
  summary: optionalText(600),
  body: z.unknown().optional(),
  mode: z.enum(["IN_PERSON", "ONLINE", "HYBRID"]),
  venue: optionalText(240),
  address: optionalText(400),
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
  isRegistrationOpen: z.boolean(),
  coverId: optionalId(),
  galleryIds: z
    .array(z.string().trim().max(40))
    .max(GALLERY_LIMIT, `An event holds at most ${GALLERY_LIMIT} pictures. Put the rest in a gallery album.`),
  speakerIds: z
    .array(z.string().trim().max(40))
    .max(SPEAKER_LIMIT, `An event lists at most ${SPEAKER_LIMIT} speakers.`),
  tags: z.array(z.string().trim().max(40)).max(TAG_LIMIT, `Use at most ${TAG_LIMIT} tags.`),
  agenda: z
    .array(agendaItemSchema)
    .max(AGENDA_LIMIT, `An agenda holds at most ${AGENDA_LIMIT} lines. Split a longer programme by day.`),
  status: statusSchema,
  isFeatured: z.boolean()
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
  status: true,
  publishedAt: true,
  isFeatured: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true
} as const;

type EventRow = Prisma.CoeEventGetPayload<{ select: typeof EVENT_SELECT }>;

// The shared renderable list plus the two columns the studio picker shows beside the thumbnail.
const MEDIA_SELECT = {
  ...MEDIA_IMAGE_SELECT_WITH_ID,
  kind: true,
  fileName: true
} as const;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const GET = route(async (request: Request, context: RouteContext) => {
  await requireCapability(canAccessStudio);
  const { id } = await context.params;

  const event = found(
    await prisma.coeEvent.findUnique({
      where: { id },
      select: {
        ...EVENT_SELECT,
        cover: { select: MEDIA_SELECT },
        agenda: {
          orderBy: { position: "asc" },
          select: {
            id: true,
            title: true,
            detail: true,
            speaker: true,
            startsAt: true,
            endsAt: true,
            position: true
          }
        },
        speakers: {
          orderBy: { position: "asc" },
          select: {
            position: true,
            role: true,
            person: { select: { id: true, name: true, slug: true, designation: true } }
          }
        },
        media: {
          orderBy: { position: "asc" },
          select: { position: true, caption: true, asset: { select: MEDIA_SELECT } }
        },
        tags: { select: { tag: { select: { id: true, name: true, slug: true } } } },
        _count: { select: { registrations: true } }
      }
    }),
    "That event"
  );

  const { tags, _count, ...row } = event;

  return ok({
    event: {
      ...row,
      tags: tags.map((link) => link.tag),
      registrationCount: _count.registrations
    }
  });
});

export const PATCH = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);
  const user = await requireCapability(
    canManageContent,
    "Changing an event needs editor access. An administrator can raise yours."
  );
  const { id } = await context.params;

  const body = await parseStudioJson(request, eventBodySchema.partial());

  const existing = found(
    await prisma.coeEvent.findFirst({ where: { id, deletedAt: null }, select: EVENT_SELECT }),
    "That event"
  );

  // An empty address arrives when somebody clears the field. Read as "leave it alone".
  const slug = body.slug && body.slug.length > 0 ? body.slug : existing.slug;
  if (slug !== existing.slug) await assertSlugAvailable("event", slug, id);

  if (body.coverId !== undefined) {
    await assertMediaAvailable(prisma, body.coverId, { field: "coverId", what: "cover picture" });
  }

  // Merged with what is stored: a PATCH that moves only the finishing time must still be checked against
  // the start it is not carrying.
  const startsAt = body.startsAt ?? existing.startsAt;
  const endsAt = body.endsAt !== undefined ? body.endsAt : existing.endsAt;
  if (endsAt && endsAt <= startsAt) {
    throw fieldProblem("endsAt", "An event cannot end before it starts. Check the finishing time.");
  }

  const opensAt =
    body.registrationOpensAt !== undefined ? body.registrationOpensAt : existing.registrationOpensAt;
  const closesAt =
    body.registrationClosesAt !== undefined ? body.registrationClosesAt : existing.registrationClosesAt;
  if (opensAt && closesAt && closesAt <= opensAt) {
    throw fieldProblem(
      "registrationClosesAt",
      "Registration cannot close before it opens. Check the two registration dates."
    );
  }

  // No `schedulable`: `CoeEvent` has no publishAt column, so SCHEDULED is refused with an explanation.
  const transition = publishTransition(existing, { status: body.status }, user);

  const doc = body.body !== undefined ? parseRichText(body.body ?? null) : undefined;

  const speakerIds = body.speakerIds === undefined ? null : await livePersonIds(body.speakerIds);
  const assetIds = body.galleryIds === undefined ? null : await liveAssetIds(body.galleryIds);

  try {
    const updated = await mutateWithHistory<EventRow>(
      buildAuditContext(request, user),
      {
        action: transition.action,
        entityType: "CoeEvent",
        entityLabel: body.title ?? existing.title,
        before: existing,
        summary: slug !== existing.slug ? `Address changed from /${existing.slug}` : null
      },
      async (tx) => {
        const row = await tx.coeEvent.update({
          where: { id },
          data: {
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(body.subtitle !== undefined ? { subtitle: body.subtitle } : {}),
            ...(body.summary !== undefined ? { summary: body.summary } : {}),
            ...(doc !== undefined
              ? { body: doc === null ? Prisma.JsonNull : (doc as unknown as Prisma.InputJsonValue) }
              : {}),
            ...(body.mode !== undefined ? { mode: body.mode } : {}),
            ...(body.venue !== undefined ? { venue: body.venue } : {}),
            ...(body.address !== undefined ? { address: body.address } : {}),
            ...(body.latitude !== undefined ? { latitude: body.latitude } : {}),
            ...(body.longitude !== undefined ? { longitude: body.longitude } : {}),
            ...(body.onlineUrl !== undefined ? { onlineUrl: body.onlineUrl } : {}),
            ...(body.startsAt !== undefined ? { startsAt: body.startsAt } : {}),
            ...(body.endsAt !== undefined ? { endsAt: body.endsAt } : {}),
            ...(body.registrationUrl !== undefined ? { registrationUrl: body.registrationUrl } : {}),
            ...(body.registrationOpensAt !== undefined
              ? { registrationOpensAt: body.registrationOpensAt }
              : {}),
            ...(body.registrationClosesAt !== undefined
              ? { registrationClosesAt: body.registrationClosesAt }
              : {}),
            ...(body.capacity !== undefined ? { capacity: body.capacity } : {}),
            ...(body.isRegistrationOpen !== undefined
              ? { isRegistrationOpen: body.isRegistrationOpen }
              : {}),
            ...(body.coverId !== undefined ? { coverId: body.coverId } : {}),
            ...(body.isFeatured !== undefined ? { isFeatured: body.isFeatured } : {}),
            slug,
            status: transition.status,
            ...(transition.publishedAt ? { publishedAt: transition.publishedAt } : {})
          },
          select: EVENT_SELECT
        });

        if (body.agenda !== undefined) {
          // Replaced outright: an agenda line carries no id, so there is nothing to match against — and it
          // holds nothing the editor did not send. See the header.
          await tx.eventAgendaItem.deleteMany({ where: { eventId: id } });
          if (body.agenda.length > 0) {
            await tx.eventAgendaItem.createMany({
              data: body.agenda.map((item, index) => ({
                eventId: id,
                title: item.title,
                detail: item.detail,
                speaker: item.speaker,
                startsAt: item.startsAt,
                endsAt: item.endsAt,
                position: index
              }))
            });
          }
        }

        if (speakerIds !== null) await replaceSpeakers(tx, id, speakerIds);
        if (assetIds !== null) await replaceMedia(tx, id, assetIds);

        if (body.tags !== undefined) {
          const tagIds = await resolveTagIds(tx, body.tags);
          await tx.eventTag.deleteMany({ where: { eventId: id } });
          if (tagIds.length > 0) {
            await tx.eventTag.createMany({
              data: tagIds.map((tagId) => ({ eventId: id, tagId })),
              skipDuplicates: true
            });
          }
        }

        const indexable = await tx.coeEvent.findUnique({
          where: { id },
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

    return ok({ event: updated });
  } catch (error) {
    if (isUniqueViolation(error)) await assertSlugAvailable("event", slug, id);
    throw error;
  }
});

export const DELETE = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);
  const user = await requireCapability(
    canManageContent,
    "Deleting an event needs editor access. An administrator can raise yours."
  );
  const { id } = await context.params;

  const existing = found(
    await prisma.coeEvent.findUnique({
      where: { id },
      select: { id: true, title: true, slug: true, startsAt: true, deletedAt: true }
    }),
    "That event"
  );

  if (existing.deletedAt) return noContent();

  await mutateWithHistory<{ id: string }>(
    buildAuditContext(request, user),
    {
      action: "DELETE",
      entityType: "CoeEvent",
      entityLabel: existing.title,
      before: existing,
      revise: false
    },
    async (tx) => {
      const row = await tx.coeEvent.update({
        where: { id },
        data: { deletedAt: new Date() },
        select: { id: true, title: true, deletedAt: true }
      });

      await dropSearchDocument(tx, "event", id);
      await tx.contentLock.deleteMany({ where: { entityType: "CoeEvent", entityId: id } });

      return row;
    }
  );

  return noContent();
});

/** Speakers, in the order given, keeping the role already recorded against anybody who stays. */
async function replaceSpeakers(tx: TxClient, eventId: string, personIds: readonly string[]): Promise<void> {
  // The empty case is spelled out rather than left to `notIn: []`, whose meaning ("everything" or
  // "nothing") is a detail of the query builder and not something a reader of this file should have to
  // know to see that clearing the list clears the rows.
  if (personIds.length === 0) {
    await tx.eventSpeaker.deleteMany({ where: { eventId } });
  } else {
    await tx.eventSpeaker.deleteMany({ where: { eventId, personId: { notIn: [...personIds] } } });
  }

  for (const [index, personId] of personIds.entries()) {
    await tx.eventSpeaker.upsert({
      where: { eventId_personId: { eventId, personId } },
      create: { eventId, personId, position: index },
      // Only the position: `role` is edited elsewhere and must survive a re-order.
      update: { position: index }
    });
  }
}

/** Pictures, in the order given, keeping each caption. */
async function replaceMedia(tx: TxClient, eventId: string, assetIds: readonly string[]): Promise<void> {
  if (assetIds.length === 0) {
    await tx.eventMedia.deleteMany({ where: { eventId } });
  } else {
    await tx.eventMedia.deleteMany({ where: { eventId, assetId: { notIn: [...assetIds] } } });
  }

  for (const [index, assetId] of assetIds.entries()) {
    await tx.eventMedia.upsert({
      where: { eventId_assetId: { eventId, assetId } },
      create: { eventId, assetId, position: index },
      update: { position: index }
    });
  }
}

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
