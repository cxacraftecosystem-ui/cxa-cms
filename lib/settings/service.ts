import "server-only";
import { cache } from "react";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ApiError, describeZodError } from "@/lib/api";
import { writeAudit, writeRevision, type AuditContext } from "@/lib/audit";
import {
  SETTINGS_DEFAULTS,
  SETTINGS_GROUP_KEYS,
  settingsFieldSchemas,
  settingsGroupMeta,
  settingsSchema,
  type SettingsGroup,
  type SettingsMap,
  type SettingsOf
} from "@/lib/settings/schema";

/**
 * Reading and writing site settings.
 *
 * THE RULE THIS MODULE EXISTS FOR: **a settings document that fails validation must never blank the
 * site's own name.** Settings are read by the root layout, the header, the footer and every metadata
 * function; a strict `schema.parse()` that throws on a document one editor left half-migrated takes
 * down every page at once, and a bare `?? defaults` on failure silently discards six fields that were
 * perfectly good in order to punish the one that was not.
 *
 * So the read is: parse; if that fails, parse each field on its own and keep the ones that pass; use
 * the default for the rest; warn on the server naming exactly which fields were lost. The site stays
 * up, the damage is bounded to the broken field, and the operator gets a sentence they can act on.
 *
 * Recovery is per TOP-LEVEL FIELD, not recursive. A malformed `censusOverride` reverts whole rather
 * than half — which is also the safe direction, since a half-recovered override is an override with a
 * missing explanation.
 */

/**
 * Hand back a COPY of the defaults, never the module-level constant.
 *
 * `SETTINGS_DEFAULTS` is shared by every request in the process. A caller that pushes onto
 * `footer.columns` on a returned default would corrupt the defaults for the life of the server, and
 * the symptom — a footer that grows a column per page view — would be attributed to anything but this.
 */
function defaultsFor<K extends SettingsGroup>(key: K): SettingsOf<K> {
  return structuredClone(SETTINGS_DEFAULTS[key]);
}

/**
 * Turn a stored JSON document into a valid settings object, salvaging what is salvageable.
 *
 * Only called for a row that EXISTS — a group nobody has saved yet is not a fault and must not warn,
 * or a fresh install prints seven warnings at boot and teaches its operator to ignore them.
 */
function resolve<K extends SettingsGroup>(key: K, stored: unknown): SettingsOf<K> {
  const schema = settingsSchema(key);
  const parsed = schema.safeParse(stored);
  if (parsed.success) return parsed.data;

  const label = settingsGroupMeta(key).label;

  // Not an object at all — a string, an array, a JSON null. There is nothing to salvage field by
  // field, so the whole group falls back.
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    console.warn(
      `[settings] the stored "${key}" document is not an object, so the built-in defaults are in use. ` +
        `Open Studio → Settings → ${label} and save the group to repair it.`
    );
    return defaultsFor(key);
  }

  const record = stored as Record<string, unknown>;
  const defaults = defaultsFor(key) as unknown as Record<string, unknown>;
  const rebuilt: Record<string, unknown> = {};
  const lost: string[] = [];

  for (const [field, fieldSchema] of Object.entries(settingsFieldSchemas(key))) {
    const attempt = fieldSchema.safeParse(record[field]);
    if (attempt.success) {
      rebuilt[field] = attempt.data;
    } else {
      rebuilt[field] = defaults[field];
      lost.push(field);
    }
  }

  console.warn(
    `[settings] the stored "${key}" document did not validate. Kept every field that was usable and ` +
      `fell back to the default for: ${lost.join(", ") || "none — the document failed as a whole"}. ` +
      `Open Studio → Settings → ${label} and save the group to repair it.`
  );

  // Re-parse the rebuilt document rather than trusting the assembly. Belt and braces: it costs one
  // cheap parse and it is what guarantees the return value really is `SettingsOf<K>` and not a
  // plausible-looking record.
  const rescued = schema.safeParse(rebuilt);
  if (rescued.success) return rescued.data;

  console.warn(`[settings] the "${key}" document could not be repaired field by field; using defaults.`);
  return defaultsFor(key);
}

/**
 * One group.
 *
 * Prefer `getSettingsCached()` on a render path — a header and a footer both calling this one cost
 * two queries, where the cached reader costs one for all seven groups. This exists for route handlers
 * and jobs that genuinely need a single group and no request-scoped memo.
 */
export async function getSetting<K extends SettingsGroup>(key: K): Promise<SettingsOf<K>> {
  const row = await readRow(key);
  if (!row) return defaultsFor(key);
  return resolve(key, row.value);
}

/**
 * Read one settings row, treating an UNREACHABLE database the same as an ABSENT row.
 *
 * This module already falls back to the schema defaults for a row that is missing or that fails to
 * parse, on the reasoning that a settings problem must never blank the site's own name. A database that
 * cannot be reached at all is the same situation arriving by a different route, and the two were treated
 * differently only because one throws.
 *
 * The difference matters most where this runs OUTSIDE a request. `next build` evaluates every metadata
 * route and every statically-rendered page, several of which read settings, so a throw here fails the
 * whole build — which is how this application first proved impossible to build inside a container,
 * where by design no database is reachable.
 *
 * ⚠ IT DOES NOT MASK A RUNTIME OUTAGE. Any page that also reads content will fail on that query and
 * return a 500 as it should; this only stops the SETTINGS read from being the thing that decides it, and
 * it logs loudly either way.
 */
async function readRow(key: SettingsGroup): Promise<{ value: unknown } | null> {
  try {
    return await prisma.setting.findUnique({ where: { key } });
  } catch (error) {
    console.error(
      `[settings] "${key}" could not be read, so its defaults are being used. ` +
        `Reason: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Every group, in one query.
 *
 * Seven documents is a few kilobytes; issuing seven round trips to fetch them separately costs more
 * than reading the lot. Groups with no row simply take their defaults.
 */
export async function getSettings(): Promise<SettingsMap> {
  // Same tolerance as `readRow`, and for the same reason: this is called by the site layout, which the
  // build renders. An unreachable database yields every group's defaults rather than a failed build.
  const rows = await prisma.setting
    .findMany({ where: { key: { in: [...SETTINGS_GROUP_KEYS] } } })
    .catch((error: unknown) => {
      console.error(
        "[settings] the settings could not be read, so every group is using its defaults. " +
          `Reason: ${error instanceof Error ? error.message : String(error)}`
      );
      return [] as { key: string; value: unknown }[];
    });
  const stored = new Map(rows.map((row) => [row.key, row.value]));

  const settings = {} as SettingsMap;
  for (const key of SETTINGS_GROUP_KEYS) {
    // The cast is on this line only: the loop variable is the union of every key, so TypeScript sees
    // a union of value types on both sides and cannot pair them up. `resolve` is still called with a
    // narrowed key, so the runtime correspondence holds.
    (settings as Record<SettingsGroup, unknown>)[key] = stored.has(key)
      ? resolve(key, stored.get(key))
      : defaultsFor(key);
  }
  return settings;
}

/**
 * `getSettings()`, memoised for the duration of ONE request.
 *
 * React's `cache()` is per-render, not a time-based cache, which is exactly what is wanted here: the
 * layout, the header, the footer and `generateMetadata` all read branding in a single render and pay
 * for one query — and an administrator who saves a change sees it on the very next request, with no
 * revalidation call and no deploy. A cross-request cache would need invalidating from `setSetting`,
 * and a stale site name that only a redeploy clears is a worse bug than an extra query.
 */
export const getSettingsCached = cache(getSettings);

/** Sugar for the common render-path read: `await getSettingCached("branding")`. One query per request. */
export async function getSettingCached<K extends SettingsGroup>(key: K): Promise<SettingsOf<K>> {
  const all = await getSettingsCached();
  return all[key];
}

/**
 * Validate, write, version and audit — in ONE transaction.
 *
 * NOT `mutateWithHistory()`: that helper requires the mutation to return a row with an `id`, and
 * `Setting`'s primary key is `key`. Rather than invent a synthetic id that would then appear in the
 * audit log's `after` payload as a column that does not exist, this opens its own transaction and
 * calls the same two primitives the helper does — so the property that matters (the log cannot exist
 * without the change, nor the change without the log) is preserved exactly.
 *
 * PERMISSIONS ARE NOT CHECKED HERE. The route handler calls `canManageSettings` from
 * `lib/permissions.ts` before reaching this, per contract §7. A service that sometimes authorises is
 * a service every caller assumes always does.
 */
export async function setSetting<K extends SettingsGroup>(
  key: K,
  value: unknown,
  context: AuditContext
): Promise<SettingsOf<K>> {
  const parsed = settingsSchema(key).safeParse(value);
  if (!parsed.success) {
    // 422 with per-field messages, matching what `parseJson` throws, so the studio form highlights
    // the offending box instead of showing a banner and leaving the reader to hunt.
    const { message, fieldErrors } = describeZodError(parsed.error);
    throw new ApiError(422, message, { code: "validation_failed", fieldErrors });
  }
  const next = parsed.data;
  const meta = settingsGroupMeta(key);

  // `Setting.value` is a NON-nullable Json column, so `Prisma.JsonNull` is not in play here — that
  // sentinel is only needed for nullable Json fields. The cast is because TypeScript cannot see that
  // an interface with only JSON-typed members satisfies `InputJsonValue`; Zod produced this object
  // from parsed JSON, so it is one by construction.
  const document = next as unknown as Prisma.InputJsonValue;
  const actorId = context.actor?.id ?? null;

  await prisma.$transaction(async (tx) => {
    const existing = await tx.setting.findUnique({ where: { key } });

    await tx.setting.upsert({
      where: { key },
      create: { key, value: document, updatedBy: actorId },
      update: { value: document, updatedBy: actorId }
    });

    await writeRevision(tx, {
      entityType: "Setting",
      entityId: key,
      data: next,
      summary: `${meta.label} settings saved`,
      authorId: actorId
    });

    await writeAudit(tx, context, {
      action: existing ? "UPDATE" : "CREATE",
      entityType: "Setting",
      entityId: key,
      entityLabel: `${meta.label} settings`,
      // The RAW stored document, not a re-validated one: "what was actually there" is the only
      // useful `before` during an incident, and repairing it first would hide the corruption that
      // caused the incident.
      before: existing?.value ?? null,
      after: next
    });
  });

  return next;
}
