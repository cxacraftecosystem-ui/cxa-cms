import type { NextRequest } from "next/server";

import { assertSameOrigin, ok, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { eraseAccount } from "@/lib/auth/erase-account";
import { isMasterAdmin } from "@/lib/permissions";
import { buildAuditContext, parseStudioJson } from "@/lib/studio/crud";
import { z } from "@/lib/zod";

/**
 * Delete an account permanently. Master administrators only; every rule is in lib/auth/erase-account.ts.
 *
 * POST rather than DELETE because the request carries a body — the address the master admin typed to
 * confirm — and a body on DELETE is dropped by enough proxies to make it the wrong place for a safeguard.
 */

export const dynamic = "force-dynamic";

const EraseBody = z.object({
  confirmEmail: z.string().trim().min(1, "Type the account's email address to confirm.").max(320)
});

export const POST = route(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    assertSameOrigin(request);

    const actor = await requireCapability(
      isMasterAdmin,
      "Only a master administrator can delete an account permanently."
    );

    const { id } = await params;
    const { confirmEmail } = await parseStudioJson(request, EraseBody);

    const result = await eraseAccount({
      context: buildAuditContext(request, actor),
      actor,
      targetId: id,
      confirmEmail
    });

    return ok({
      erased: true,
      ...result,
      message: [
        "The account has been deleted and every device it was signed in on is signed out.",
        result.contentKept > 0
          ? `What they wrote stays on the site, credited to “${result.placeholderName}”.`
          : "There was no content credited to it.",
        result.domainEntryStillAdmits
          ? `The access list still admits everybody at ${result.domainEntryStillAdmits}, so this address could sign in again and get a new account. Narrow that entry if it should not.`
          : "Their address is off the studio access list.",
        "This is in the audit log with your name on it."
      ].join(" ")
    });
  }
);
