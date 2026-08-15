import { z } from "zod";

import { ApiError, assertSameOrigin, noContent, ok, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import {
  PREVIEW_DRAFT_MAX_BYTES,
  PREVIEW_DRAFT_MAX_SECTIONS,
  PREVIEW_DRAFT_TTL_MS,
  clearPreviewDraft,
  putPreviewDraft,
  type PreviewDraftSection
} from "@/lib/pages/preview-draft";
import { canManageStructure } from "@/lib/permissions";
import { sectionLabel } from "@/lib/sections/registry";
import { parseSectionData, sectionTypeSchema } from "@/lib/sections/schema";
import { found, optionalText, parseStudioJson } from "@/lib/studio/crud";
import { mergeSectionData } from "@/components/studio/sections";
import { formatBytes } from "@/lib/utils";

/**
 * The live preview draft for one page: send it, or throw it away.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS ROUTE WRITES NOTHING TO THE DATABASE, AND THAT IS THE POINT.
 *
 * The page builder holds the working copy of every block. A few hundred milliseconds after the editor
 * stops typing it PUTs that copy here; the blocks go into `lib/pages/preview-draft.ts`, keyed by page
 * AND by the editor who sent them, with a ten-minute life; and the preview route renders them in place
 * of the saved rows so the frame shows the real page including unsaved words.
 *
 * Nothing is persisted, nothing is revised and nothing is audited, because nothing has CHANGED — a
 * preview is a read. `mutateWithHistory()` is deliberately absent for that reason: a revision per
 * keystroke would bury the history this CMS exists to keep, and an audit entry for "looked at it" is
 * noise an incident review has to wade through.
 *
 * ⚠ IT IS STILL A STUDIO MUTATION IN EVERY WAY THAT MATTERS, so it carries the full set: an origin
 * check (contract §9), the same `canManageStructure` capability the section routes enforce, and a
 * store keyed by `user.id` so one editor's unsaved sentence can never surface in another's preview.
 * `requireCapability` re-reads the user row, so an editor demoted a minute ago cannot still push a
 * draft on a token minted before the demotion.
 *
 * EVERY BLOCK IS VALIDATED WITH `parseSectionData`, exactly as the save routes do, and A FAILURE
 * REFUSES THE WHOLE DRAFT rather than storing the blocks that passed. A preview missing one block is a
 * preview of a page that does not exist, and the editor would be checking the very thing that is not
 * there. The refusal names the block, so the builder can say what is holding the live preview up while
 * the last good draft stays on screen.
 *
 * A DRAFT THAT IS TOO LARGE IS REFUSED WHOLE AND THE OLD ONE IS DISCARDED — never truncated. See the
 * cap note in `lib/pages/preview-draft.ts`; the reasoning is that half a page is a lie and the last
 * saved page is not.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * One block on the wire — the same fields `BuilderSection` carries, because the builder sends its
 * working copy verbatim.
 *
 * `position` is accepted here although the section routes refuse it, and the difference is real: there
 * is no `@@unique([pageId, position])` to collide with in a `Map`, and the preview must be able to
 * show a reorder that has not been saved yet. The store renumbers densely on read, so a duplicate or
 * a gap sent mid-drag costs nothing.
 */
const draftSectionSchema = z.object({
  id: z.string().trim().min(1, "A block with no id cannot be previewed.").max(40),
  type: sectionTypeSchema,
  position: z.coerce.number().int().min(0).max(1000),
  label: optionalText(80),
  /** Omitted is read as an empty payload by `parseSectionData`, which fills in every default. */
  data: z.unknown().optional(),
  isVisible: z.boolean().default(true)
});

const putSchema = z.object({
  sections: z
    .array(draftSectionSchema)
    .max(
      PREVIEW_DRAFT_MAX_SECTIONS,
      `A page holds at most ${PREVIEW_DRAFT_MAX_SECTIONS} blocks, so a preview of more than that cannot be right.`
    )
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const PUT = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);
  const user = await requireCapability(
    canManageStructure,
    "Previewing unsaved changes to a page needs editor access. An administrator can raise yours."
  );
  const { id } = await context.params;

  const body = await parseStudioJson(request, putSchema);

  // The page is looked up for the same reason the section routes look it up: an id in an address is a
  // request, not a fact. It also stops a draft accumulating against a page that no longer exists.
  const page = found(
    await prisma.page.findFirst({ where: { id, deletedAt: null }, select: { id: true, title: true } }),
    "That page"
  );

  const sections: PreviewDraftSection[] = [];

  for (const entry of body.sections) {
    const parsed = parseSectionData(entry.type, entry.data);
    if (!parsed.ok) {
      // Named the way the builder names it, so the sentence an editor reads matches the row they can
      // see: the editor's own label when there is one, and the block's kind when there is not.
      const name = entry.label?.trim() || sectionLabel(entry.type);
      throw new ApiError(
        422,
        `The live preview is waiting for “${name}”: ${parsed.message} The preview is still showing the last version that could be sent.`,
        { code: "validation_failed", fieldErrors: parsed.fieldErrors }
      );
    }

    sections.push({
      id: entry.id,
      type: entry.type,
      position: entry.position,
      label: entry.label,
      /*
        ⚠ `mergeSectionData` IS NOT OPTIONAL HERE, for the reason its own header gives: a block's named
        anchor lives on `data.anchor` and is deliberately outside all twenty-three schemas, so
        `z.object()` has already stripped it from `parsed.data`. Storing the bare parsed payload would
        preview a page whose in-page links go nowhere — and an editor checking a menu entry against
        `/about#history` would conclude the menu was broken.
      */
      data: mergeSectionData(entry.data, parsed.data),
      isVisible: entry.isVisible
    });
  }

  const stored = putPreviewDraft({ pageId: page.id, editorId: user.id, sections });

  if (!stored.ok) {
    // 413 rather than 422: nothing about the content is invalid, there is simply too much of it. The
    // sentence quotes both numbers, because a cap that is not said is indistinguishable from a bug
    // (contract §1.6), and it says what the preview is showing INSTEAD — which is the half an editor
    // can act on.
    throw new ApiError(
      413,
      `This page is too large to preview before it is saved (${formatBytes(stored.bytes)}; the limit is ${formatBytes(stored.limit)}). The preview is showing the page as it was last saved. Save the page to see all of it, or move some of it onto a second page.`,
      { code: "too_large" }
    );
  }

  return ok({
    // Everything the builder needs to say something true on screen: when it was stored, when it stops
    // being honoured, and how big it was — so a page creeping towards the cap is visible before it
    // hits it rather than after.
    storedAt: stored.draft.storedAt,
    expiresAt: stored.draft.expiresAt,
    ttlSeconds: Math.round(PREVIEW_DRAFT_TTL_MS / 1000),
    sections: stored.draft.sections.length,
    bytes: stored.draft.bytes,
    maxBytes: PREVIEW_DRAFT_MAX_BYTES
  });
});

/**
 * Throw the draft away — what "turn live preview off" does.
 *
 * Idempotent, and answers 204 whether or not there was anything to delete. A 404 for "it was already
 * gone" would make the builder report a failure for the one outcome the caller wanted.
 *
 * The page is NOT looked up first, deliberately: a draft for a page that has since been deleted is
 * exactly the sort of thing that should still be removable, and a 404 here would strand it in memory
 * until its TTL.
 */
export const DELETE = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);
  const user = await requireCapability(
    canManageStructure,
    "Previewing unsaved changes to a page needs editor access. An administrator can raise yours."
  );
  const { id } = await context.params;

  clearPreviewDraft(id, user.id);
  return noContent();
});
