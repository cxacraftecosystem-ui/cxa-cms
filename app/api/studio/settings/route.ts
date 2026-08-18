import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  ApiError,
  assertSameOrigin,
  badRequest,
  ok,
  parseJson,
  route
} from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { configurationWarnings, storageConfigured } from "@/lib/env";
import { buildAuditContext } from "@/lib/studio/crud";
import { canManageSettings } from "@/lib/permissions";
import {
  SETTINGS_GROUPS,
  isSettingsGroup,
  settingsGroupMeta,
  type SettingsGroup
} from "@/lib/settings/schema";
import { getSettings, setSetting } from "@/lib/settings/service";

/**
 * Site settings, over HTTP.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ONE GROUP AT A TIME, AND A GROUP THAT FAILS DOES NOT TAKE THE OTHERS DOWN WITH IT.
 *
 * This is the only rule in the file worth reading twice. A settings save commonly carries more than one
 * group — an administrator who has been through four tabs presses Save and expects the branding, the
 * contact details and the footer to land. If one of those documents has a problem (a title pattern with
 * no `%s`, a social link missing its scheme), validating the WHOLE payload and refusing it would throw
 * away three groups of correct work in order to punish the fourth. So each group is validated and written
 * on its own, through `setSetting()`, and the response reports the outcome PER GROUP.
 *
 * The failure is never silent: `failed` names every group that did not save, in the schema's own words,
 * with per-field messages keyed `group.field` so a form can attach them to the offending box. And if
 * NOTHING saved, the route throws a real 422 rather than answering 200 with a list of disappointments —
 * a save that changed nothing must read as a failure to the client.
 *
 * ⚠ EACH GROUP IS STILL ATOMIC IN ITSELF. `setSetting()` writes the document, its revision and its audit
 * entry in ONE transaction (settings/service.ts), so a group lands whole or not at all. What is NOT
 * atomic is the set of groups — deliberately, because that is the whole point above. A client that needs
 * all-or-nothing across groups should send them one request at a time.
 *
 * `requireCapability(canManageSettings)` IS THE FIRST STATEMENT after the origin check: administrator
 * only, the same predicate the settings screen renders behind and `StudioNav` hides the sidebar entry
 * with. These values are read by the root layout, the header, the footer and every metadata function, so
 * the tier that may change them is the highest one.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ PERMISSIONS ARE NOT CHECKED INSIDE `setSetting()` — its own header says so. This route is the
 * boundary. Anything else that ever calls that service must do the same check itself.
 */

export const dynamic = "force-dynamic";

/**
 * How many groups one request may carry: exactly as many as there ARE, derived rather than typed out,
 * so adding a group can never leave a cap behind that refuses a save of everything at once.
 *
 * It is protection rather than a policy, and what it protects against is a body full of names that are
 * no group at all — every one of those is answered with a named refusal in `outcomes` below, so without
 * a ceiling a thousand invented keys become a thousand sentences assembled and sent back.
 */
const MAX_GROUPS_PER_REQUEST = SETTINGS_GROUPS.length;

/**
 * Two shapes are accepted, and the reason is compatibility rather than indecision.
 *
 *   • `{ groups: { branding: {…}, seo: {…} } }` — several groups in one request, the shape this route
 *     exists for.
 *   • `{ group: "branding", value: {…} }` — one group, which is what a per-group form sends.
 *
 * Written as one object with optional members rather than a `z.union`, because a union failure reports
 * "Invalid input" against the whole body and tells the reader nothing about which half they got wrong.
 */
const SettingsPatchBody = z.object({
  groups: z.record(z.string(), z.unknown()).optional(),
  group: z.string().trim().min(1).max(64).optional(),
  value: z.unknown().optional()
});

interface GroupOutcome {
  group: string;
  /** The plain label, so a client can say "Search & sharing" rather than "seo". */
  label: string;
  saved: boolean;
  /** A sentence ready to render. Present only on a failure. */
  message?: string;
  /** Keyed `group.field`, matching what `lib/api.ts` promises for `fieldErrors`. */
  fieldErrors?: Record<string, string[]>;
}

function labelFor(group: string): string {
  return isSettingsGroup(group) ? settingsGroupMeta(group).label : group;
}

/**
 * Re-key a group's field errors under `group.field`.
 *
 * A response carrying `titleTemplate` from a multi-group save is ambiguous — several groups have fields
 * with the same name — and a form that attached it to the wrong tab would mark a box that is perfectly
 * fine.
 */
function prefixFieldErrors(
  group: string,
  fieldErrors: Record<string, string[]> | undefined
): Record<string, string[]> | undefined {
  if (!fieldErrors) return undefined;
  const out: Record<string, string[]> = {};
  for (const [path, messages] of Object.entries(fieldErrors)) {
    out[path === "_form" ? group : `${group}.${path}`] = messages;
  }
  return out;
}

async function readSettings() {
  /**
   * `getSettings()`, not `getSettingsCached()`.
   *
   * The cached reader is memoised per request and shared with anything else in the same render that read
   * a setting. This endpoint's whole purpose is to say exactly what is stored, so it asks the database
   * and takes the extra query.
   */
  const settings = await getSettings();
  return {
    settings,
    /** Sentences from `configurationWarnings()`. The studio's diagnostics panel renders them verbatim. */
    diagnostics: configurationWarnings(),
    /** So a client can explain why the picture fields have nothing to offer. */
    storageReady: storageConfigured()
  };
}

export const GET = route(async () => {
  await requireCapability(
    canManageSettings,
    "Settings need administrator access. Ask an administrator to make the change, or to raise your access."
  );
  return ok(await readSettings());
});

const handleWrite = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageSettings,
    "Settings need administrator access. Ask an administrator to make the change, or to raise your access."
  );

  const body = await parseJson(request, SettingsPatchBody);

  /** The requested groups, in the order the registry lists them, so the report reads like the screen. */
  const requested: [string, unknown][] = [];
  if (body.groups) {
    for (const [key, value] of Object.entries(body.groups)) requested.push([key, value]);
  }
  if (body.group !== undefined) requested.push([body.group, body.value]);

  if (requested.length === 0) {
    throw badRequest(
      "Nothing was sent to save. Include the group you are changing and the values for it."
    );
  }
  if (requested.length > MAX_GROUPS_PER_REQUEST) {
    throw badRequest(
      `A settings save can carry at most ${MAX_GROUPS_PER_REQUEST} groups, and this one carried ` +
        `${requested.length}. Send them in more than one request.`
    );
  }

  // Assembled once per request and handed to every `setSetting` call, so every audit entry a single save
  // produces carries the same actor, address and browser.
  const context = buildAuditContext(request, user);

  const outcomes: GroupOutcome[] = [];

  for (const [key, value] of requested) {
    const label = labelFor(key);

    if (!isSettingsGroup(key)) {
      // Named rather than ignored. A group this build does not know about is almost always a typo, and a
      // request that quietly did nothing would look exactly like one that worked.
      outcomes.push({
        group: key,
        label,
        saved: false,
        message:
          `There is no settings group called “${key}”. The groups on this site are: ` +
          `${SETTINGS_GROUPS.map((entry) => entry.key).join(", ")}.`
      });
      continue;
    }

    try {
      // Validates against the group's own Zod schema and writes the row, its revision and its audit
      // entry in one transaction. See the header: the atomicity is per group, on purpose.
      await setSetting(key as SettingsGroup, value, context);
      outcomes.push({ group: key, label, saved: true });
    } catch (error) {
      if (error instanceof ApiError) {
        const fieldErrors = prefixFieldErrors(key, error.fieldErrors);
        outcomes.push({
          group: key,
          label,
          saved: false,
          message: error.message,
          ...(fieldErrors ? { fieldErrors } : {})
        });
        continue;
      }
      // Not a validation problem — a database fault, a serialisation failure. That is a bug rather than
      // bad input, so it goes up to `route()` and becomes a 500 with the detail in the server log only.
      throw error;
    }
  }

  const saved = outcomes.filter((entry) => entry.saved);
  const failed = outcomes.filter((entry) => !entry.saved);

  /**
   * NOTHING SAVED IS A FAILURE, and it answers like one.
   *
   * A 200 with an empty `saved` list would be reported by every client as a successful save — the studio's
   * save bar would print "Saved just now" over work that is still only on screen.
   */
  if (saved.length === 0) {
    const first = failed[0];
    const combined: Record<string, string[]> = {};
    for (const entry of failed) {
      for (const [path, messages] of Object.entries(entry.fieldErrors ?? {})) combined[path] = messages;
    }
    throw new ApiError(
      422,
      first
        ? failed.length === 1
          ? first.message ?? `The ${first.label.toLowerCase()} settings could not be saved.`
          : `None of the ${failed.length} settings groups could be saved. ${first.label}: ${first.message ?? "the values were refused."}`
        : "The settings could not be saved.",
      {
        code: "validation_failed",
        ...(Object.keys(combined).length > 0 ? { fieldErrors: combined } : {})
      }
    );
  }

  const { settings, diagnostics, storageReady } = await readSettings();

  /** The one saved group, when there is exactly one, so the sentence below can name it. */
  const onlySaved = saved.length === 1 ? saved[0] : undefined;

  return ok({
    saved: saved.map((entry) => ({ group: entry.group, label: entry.label })),
    failed,
    /**
     * The state as stored AFTER the write, so a client never has to guess what landed. Note that a group
     * read back here may differ from what was sent: every schema trims text and folds an empty media id
     * to null, and `getSettings()` repairs a stored document field by field rather than failing whole.
     */
    settings,
    diagnostics,
    storageReady,
    message:
      failed.length === 0
        ? onlySaved
          ? `The ${onlySaved.label.toLowerCase()} settings have been saved.`
          : `${saved.length} settings groups have been saved.`
        : `${saved.length} of ${outcomes.length} settings groups were saved. The rest are listed with the reason each was refused.`
  });
});

/**
 * PATCH is the documented verb; PUT is accepted because "replace these groups with these documents" is
 * exactly what the handler does, and a per-group form that spells it PUT should not get a 405 over a
 * distinction that makes no difference to the write.
 */
export const PATCH = handleWrite;
export const PUT = handleWrite;
