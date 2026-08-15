import type { NextRequest } from "next/server";
import { z } from "zod";

import { ApiError, assertSameOrigin, ok, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { canManageSettings } from "@/lib/permissions";
import {
  SETTINGS_GROUPS,
  isSettingsGroup,
  settingsGroupMeta,
  type SettingsGroup
} from "@/lib/settings/schema";
import { getSetting, setSetting } from "@/lib/settings/service";
import { buildAuditContext, parseStudioJson } from "@/lib/studio/crud";

/**
 * One settings group, at its own address: `/api/studio/settings/<group>`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS FILE EXISTS BECAUSE THE SCREEN ASKS FOR IT, AND NOTHING ELSE ANSWERED.
 *
 * `SettingsForm` sends the group's document ALONE — `PUT /api/studio/settings/branding` with
 * `{ siteName: …, tagline: … }` — one request per tab, because each group saves on its own. The handler
 * that existed was at `/api/studio/settings` and took `{ group, value }` or `{ groups: … }`, so every
 * save in the studio reached a path with no handler and NO SETTING COULD BE SAVED AT ALL. A `fetch` path
 * is a string and nothing in TypeScript checks it against a route file (contract §13b), which is why
 * this went unnoticed through a clean typecheck, lint and build.
 *
 * The screen is the specification, so the address moved to the screen rather than the other way round.
 *
 * IT DELEGATES TO `setSetting()` AND VALIDATES NOTHING ITSELF. That service parses the group's own Zod
 * schema and writes the row, its revision and its audit entry in ONE transaction. A second validator
 * here — even a well-meaning "check it first so the message is nicer" — is a second opinion about what a
 * valid setting is, and the two would drift: the day the schema gains a field, one of them would accept a
 * document the other refuses, and which one you got would depend on the address you used. So there is one
 * write path and one validator, and this file only decides WHO may call it and WHICH group is meant.
 *
 * WHAT THIS FILE ADDS IS THE WORDING OF A REFUSAL. `setSetting()` throws a 422 carrying per-field
 * messages; those are passed through untouched, keyed by the field path the form marks its boxes with,
 * and the sentence in front of them names the group and says plainly that NOTHING was saved — so an
 * administrator who has typed into eight boxes knows the other seven are still on screen and still
 * unsaved, rather than guessing which half landed. Rejecting a whole group is unavoidable: a group is one
 * JSON document in one row, so there is no such thing as saving nine of its ten fields.
 *
 * PERMISSIONS ARE CHECKED HERE, NOT IN THE SERVICE. `setSetting()`'s own header says it authorises
 * nothing, and a service that sometimes authorises is a service every caller assumes always does. These
 * values are read by the root layout, the header, the footer and every metadata function, so the tier
 * that may change them is the highest one — `canManageSettings`, the same predicate the settings screen
 * renders behind and `StudioNav` hides the sidebar entry with (contract §1.7).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ PUT AND PATCH ARE THE SAME HANDLER. The form spells it PUT, which is also the honest verb — the body
 * replaces the group's whole document. PATCH is accepted because the sibling `../route.ts` accepts both
 * and a 405 over a distinction that makes no difference to the write is a failure nobody can explain from
 * the outside.
 */

export const dynamic = "force-dynamic";

/** One sentence, reused by every method here so a refusal reads the same wherever it comes from. */
const NEEDS_ADMIN =
  "Settings need administrator access. Ask an administrator to make the change, or to raise your access.";

interface RouteContext {
  params: Promise<{ group: string }>;
}

/**
 * The group named in the address, or a 404 that LISTS THE GROUPS.
 *
 * A misspelled group is nearly always a typo in a call site, and "not found" on its own leaves whoever
 * typed it re-reading their own code. Naming both the label and the key turns the refusal into the answer.
 */
async function groupFrom(context: RouteContext): Promise<SettingsGroup> {
  const { group } = await context.params;
  if (isSettingsGroup(group)) return group;

  const known = SETTINGS_GROUPS.map((entry) => `${entry.label} (${entry.key})`).join(", ");
  throw new ApiError(
    404,
    `There is no settings group called “${group}”. The groups on this site are: ${known}.`,
    { code: "not_found" }
  );
}

/**
 * The body: the group's own values, as a set of named fields.
 *
 * Deliberately NOT a `{ group, value }` envelope, and not both shapes. A settings document can contain a
 * field called `value` (nothing stops a future group from having one), so sniffing for an envelope would
 * make the meaning of a body depend on the names of the fields inside it. The address already says which
 * group is meant; the body is the document.
 *
 * The per-field validation happens in `setSetting()` — see the header. This schema only refuses a body
 * that is not a set of fields at all (a string, an array, a number), where the service's own message would
 * read "Expected object, received array" and mean nothing to an administrator.
 */
const documentSchema = z.record(z.string(), z.unknown(), {
  invalid_type_error:
    "A settings save has to carry the group's values as a set of named fields. Nothing has been changed."
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Reading one group
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Answers exactly what is stored for this group, repaired field by field where the stored document has
 * drifted (see `getSetting`). `../route.ts` answers all seven at once for the screen's first render; this
 * exists so the nested address is not a 405 for a read, which is the sort of asymmetry that sends somebody
 * hunting for a second bug after they have found the first.
 */
export const GET = route(async (_request: Request, context: RouteContext) => {
  await requireCapability(canManageSettings, NEEDS_ADMIN);
  const group = await groupFrom(context);
  const meta = settingsGroupMeta(group);

  return ok({ group, label: meta.label, values: await getSetting(group) });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Saving one group
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Re-word a validation refusal so it names the group and states what was NOT done.
 *
 * The per-field messages are the schema's own and are passed through unchanged — they are what the form
 * attaches to each box, keyed by the same path. Only the leading sentence is added, and it is the half a
 * reader acts on: which group, and the fact that nothing at all was written for it.
 */
function describeRefusal(label: string, error: ApiError): ApiError {
  const marked = Object.keys(error.fieldErrors ?? {}).filter((field) => field !== "_form").length;

  const tail =
    marked > 0
      ? " Nothing has been saved for this group, so everything else you have typed is still on screen."
      : "";

  return new ApiError(
    422,
    `The ${label.toLowerCase()} settings have not been saved. ${error.message}${tail}`,
    {
      code: error.code,
      ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {})
    }
  );
}

const handleWrite = route(async (request: NextRequest, context: RouteContext) => {
  // First statement, before anything is read: a mutation that has crossed from another site must not get
  // as far as touching the body (contract §9).
  assertSameOrigin(request);

  const user = await requireCapability(canManageSettings, NEEDS_ADMIN);
  const group = await groupFrom(context);
  const meta = settingsGroupMeta(group);

  const document = await parseStudioJson(request, documentSchema);

  try {
    // Validates against this group's schema and writes the row, its revision and its audit entry in one
    // transaction. The same call the multi-group endpoint makes, with the same context shape, so an audit
    // entry does not reveal which address was used to make an identical change.
    const values = await setSetting(group, document, buildAuditContext(request, user));

    return ok({
      group,
      label: meta.label,
      saved: true,
      /**
       * The document AS STORED, which may differ from what was sent: every schema trims its text and
       * folds an empty media reference to null. Answering with the parsed values means a client never has
       * to guess what landed.
       */
      values,
      message: `The ${meta.label.toLowerCase()} settings have been saved.`
    });
  } catch (error) {
    // A 422 is bad input and gets the group's name in front of it. Anything else — a database fault, a
    // serialisation failure — is a bug rather than a bad value, so it goes up to `route()` and becomes a
    // 500 with the detail in the server log only.
    if (error instanceof ApiError && error.status === 422) throw describeRefusal(meta.label, error);
    throw error;
  }
});

export const PUT = handleWrite;
export const PATCH = handleWrite;
