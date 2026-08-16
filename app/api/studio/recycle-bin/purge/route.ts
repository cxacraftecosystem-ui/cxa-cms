import type { NextRequest } from "next/server";
import { z } from "zod";

import { ApiError, assertSameOrigin, badRequest, ok, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { isMasterAdmin } from "@/lib/permissions";
import { buildAuditContext, parseStudioJson } from "@/lib/studio/crud";

import { BIN_TYPES, isBinType, type BinType } from "../kinds";
import { purgeRecord } from "../purge-record";

/**
 * Deleting one record from the recycle bin, for good.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ MASTER ADMIN ONLY, AND THE REFUSAL IS HERE — not in whether a button was drawn.
 *
 * `lib/permissions.ts` puts `canPurge` and `canRestoreDeleted` at ADMINISTRATOR, and both are right for
 * what they do: the cron's window-based purge and putting something back. This is neither. The same file
 * argues that `canManageStudioAccess` is master-admin because "an administrator runs the site; a master
 * admin decides who is allowed near it" — and irreversible destruction of the archive belongs on that
 * side of the line for exactly the reason given there. The everyday administrator account is the one most
 * likely to be phished, and the difference is between "somebody defaced a page" and "somebody destroyed
 * the only copy of it".
 *
 * So the gate is `isMasterAdmin`, the named predicate lib/permissions.ts asks call sites to use rather
 * than comparing the role string themselves. `app/studio/recycle-bin/page.tsx` hides the control for
 * everybody else AND its Server Action checks the same predicate; neither of those is what makes this
 * safe. This is.
 *
 * ⚠ IT LIVES IN ITS OWN ROUTE, alongside `restore/`, and NOT as a `DELETE` on the listing route. Two
 * reasons, both learned from the version that did: a `DELETE` sharing a file with the bin's `GET` shared
 * its permission story by proximity and was read as "same screen, same tier", and a `DELETE` carrying its
 * confirmation in the QUERY STRING put the name of the record being destroyed into every access log and
 * proxy cache between here and the browser. A POST with a body does neither. The verb is POST rather
 * than DELETE for the same reason `restore/` is: the confirmation has to travel in a body.
 *
 * WHAT IT WILL REFUSE, and every refusal changes nothing at all:
 *   • the name typed back does not match the record's own            → 400
 *   • the record is not in the bin (somebody dealt with it already)   → 404
 *   • ⚠ something else still points at it                            → 409, with the records named
 *   • it is a structural page the site itself links to               → 409
 *   • its stored bytes could not be listed or removed                → 409 / 503, and the row is KEPT
 *
 * The reasoning behind each of those, and the order the bytes and the row are removed in, is in
 * `../purge-record.ts`. This file is the boundary; that file is the operation.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const PurgeBody = z.object({
  type: z.string().trim().min(1, "Which kind of record?").max(40),
  id: z.string().trim().min(1, "Which record?").max(64),
  /**
   * The record's own name, sent back.
   *
   * This is the API's half of the typed confirmation on the recycle-bin screen, and it is not decoration.
   * It is the only irreversible operation in the studio, and a client looping over the wrong array of ids
   * would otherwise destroy a fortnight of work with a 200 for each one. Echoing the name proves the
   * caller was looking at the record it is asking to destroy.
   *
   * ⚠ NO `ids` ARRAY, deliberately. `restore/` accepts one because a restore that got the wrong row is
   * undone by deleting it again; there is no such second chance here. See the note on bulk deletion at
   * the top of `../purge-record.ts`.
   */
  confirm: z.string().trim().min(1, "Type the record's name back to confirm.").max(400)
});

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    isMasterAdmin,
    "Deleting something for good needs master administrator access. An administrator can restore it or " +
      "leave it in the recycle bin, but only a master administrator can destroy it."
  );

  const body = await parseStudioJson(request, PurgeBody);
  if (!isBinType(body.type)) {
    throw badRequest(
      `This does not know how to delete a “${body.type}”, so nothing has been changed. The kinds it ` +
        `handles are: ${BIN_TYPES.join(", ")}.`
    );
  }
  const type: BinType = body.type;

  const outcome = await purgeRecord(buildAuditContext(request, user), {
    type,
    id: body.id,
    confirm: body.confirm
  });

  if (!outcome.ok) {
    // The status and the sentence both come from the operation, so this route and the studio screen
    // refuse for the same reasons in the same words.
    throw new ApiError(outcome.status, outcome.message, { code: outcome.code });
  }

  return ok({
    purged: true,
    type,
    id: body.id,
    label: outcome.label,
    storedFilesRemoved: outcome.storedFilesRemoved,
    alsoRemoved: outcome.alsoRemoved,
    message: outcome.message
  });
});
