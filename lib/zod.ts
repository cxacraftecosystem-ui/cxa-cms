/**
 * Zod, configured once for this application. Import `z` from HERE, never from "zod" directly — the
 * lint rule in eslint.config.mjs refuses the direct import.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IS CONFIGURED: THE SENTENCE A READER SEES WHEN A SCHEMA HAS NOT WRITTEN ONE OF ITS OWN.
 *
 * Every validation failure reaches somebody as a sentence — `describeZodError` in lib/api.ts puts the
 * first one in the banner and every one beside its field — and most schemas here write their own
 * (`.max(200, "…")`). Where one does not, Zod's built-in English is what is shown. Zod 4 rewrote that
 * English for developers: a missing title went from "Required" to "Invalid input: expected string,
 * received undefined", and a long one from "String must contain at most 200 character(s)" to "Too big:
 * expected string to have <=200 characters". The upgrade was not meant to change what an editor reads,
 * so the map below gives back Zod 3's wording for every check this codebase uses, word for word.
 *
 * It is a FALLBACK, nothing more. Zod asks a schema's own message first (`message`, `error`, a
 * `.refine` message), and this only when there is none; a code it does not name answers `undefined`,
 * which hands the issue on to Zod's own English.
 *
 * ⚠ WHY A RE-EXPORT AND NOT A SIDE-EFFECT IMPORT. `z.config()` is global to the copy of Zod it is called
 * on, and a server build and a browser bundle each have their own copy. A module every schema already
 * imports is the only place that cannot be forgotten in one of them.
 *
 * ⚠ ISSUE CODES ARE ZOD 4'S, AND NOTHING HERE TRANSLATES THEM. A client never sees one — lib/api.ts
 * answers every validation failure as `validation_failed` — but Zod 4 renamed several (`invalid_string`
 * is `invalid_format`, `invalid_enum_value` and `invalid_literal` are `invalid_value`), so code that
 * branches on `issue.code` must use the new names.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { z } from "zod";

type Issue = z.core.$ZodRawIssue;

/** Zod 3's name for the type a value arrived as — `nan` and `float` included, which it printed. */
function receivedType(input: unknown): string {
  if (input === undefined) return "undefined";
  if (input === null) return "null";
  if (Array.isArray(input)) return "array";
  if (input instanceof Date) return "date";
  if (typeof input === "number" && Number.isNaN(input)) return "nan";
  return typeof input;
}

/** Zod 3's way of listing what it expected: strings in single quotes, anything else as it prints. */
function quoted(value: unknown): string {
  return typeof value === "string" ? `'${value}'` : String(value);
}

/** Zod 4 names two shapes differently; Zod 3 called a record an object and a tuple an array. */
const ZOD3_EXPECTED: Readonly<Record<string, string>> = { record: "object", tuple: "array" };

/** Zod 3's sentence for an issue, or `undefined` to let Zod 4 say it. */
export function zod3Message(issue: Issue): string | undefined {
  switch (issue.code) {
    case "invalid_type": {
      if (issue.input === undefined) return "Required";
      // `z.coerce.date()` turns text it cannot read into an Invalid Date, which is a Date: Zod 4 reports
      // it as the wrong type, Zod 3 as `invalid_date` — "Invalid date", not "Expected date, received date".
      if (issue.expected === "date" && issue.input instanceof Date) return "Invalid date";
      const received = receivedType(issue.input);
      if (issue.expected === "int") {
        return `Expected integer, received ${received === "number" ? "float" : received}`;
      }
      return `Expected ${ZOD3_EXPECTED[issue.expected] ?? issue.expected}, received ${received}`;
    }

    case "too_small": {
      const n = issue.minimum.toString();
      switch (issue.origin) {
        case "string":
          return issue.exact
            ? `String must contain exactly ${n} character(s)`
            : `String must contain ${issue.inclusive ? "at least" : "over"} ${n} character(s)`;
        case "array":
        case "set":
          return issue.exact
            ? `Array must contain exactly ${n} element(s)`
            : `Array must contain ${issue.inclusive ? "at least" : "more than"} ${n} element(s)`;
        case "number":
        case "int":
        case "bigint":
          return `Number must be ${issue.exact ? "exactly equal to " : issue.inclusive ? "greater than or equal to " : "greater than "}${n}`;
        default:
          return undefined;
      }
    }

    case "too_big": {
      const n = issue.maximum.toString();
      switch (issue.origin) {
        case "string":
          return issue.exact
            ? `String must contain exactly ${n} character(s)`
            : `String must contain ${issue.inclusive ? "at most" : "under"} ${n} character(s)`;
        case "array":
        case "set":
          return issue.exact
            ? `Array must contain exactly ${n} element(s)`
            : `Array must contain ${issue.inclusive ? "at most" : "less than"} ${n} element(s)`;
        case "number":
        case "int":
        case "bigint":
          return `Number must be ${issue.exact ? "exactly" : issue.inclusive ? "less than or equal to" : "less than"} ${n}`;
        default:
          return undefined;
      }
    }

    case "invalid_format":
      switch (issue.format) {
        case "email":
          return "Invalid email";
        case "url":
          return "Invalid url";
        case "regex":
          return "Invalid";
        case "starts_with":
          return `Invalid input: must start with "${(issue as { prefix?: string }).prefix ?? ""}"`;
        case "ends_with":
          return `Invalid input: must end with "${(issue as { suffix?: string }).suffix ?? ""}"`;
        case "includes":
          return `Invalid input: must include "${(issue as { includes?: string }).includes ?? ""}"`;
        default:
          return `Invalid ${issue.format}`;
      }

    case "invalid_value": {
      if (issue.inst instanceof z.ZodLiteral) {
        return `Invalid literal value, expected ${issue.values.map((value) => JSON.stringify(value)).join(" | ")}`;
      }
      const expected = issue.values.map(quoted).join(" | ");
      // Zod 3 answered an enum handed something that could not be one of its values at all — not a
      // string (nor a number, for a numeric enum) — as the wrong TYPE, so a missing choice said "Required".
      const numeric = typeof issue.input === "number" && issue.values.some((value) => typeof value === "number");
      if (typeof issue.input !== "string" && !numeric) {
        return issue.input === undefined ? "Required" : `Expected ${expected}, received ${receivedType(issue.input)}`;
      }
      return `Invalid enum value. Expected ${expected}, received '${String(issue.input)}'`;
    }

    case "unrecognized_keys":
      return `Unrecognized key(s) in object: ${issue.keys.map((key) => `'${key}'`).join(", ")}`;

    case "not_multiple_of":
      return `Number must be a multiple of ${String(issue.divisor)}`;

    case "invalid_union": {
      // A discriminated union whose tag matched none of its options carries the options it expected.
      const options = (issue as { options?: unknown }).options;
      if (Array.isArray(options) && options.length > 0) {
        return `Invalid discriminator value. Expected ${options.map(quoted).join(" | ")}`;
      }
      return "Invalid input";
    }

    default:
      return undefined;
  }
}

/**
 * Zod 3's `invalid_type_error`, in Zod 4: a sentence for a value of the WRONG type that leaves a missing
 * one to say "Required" and every other check its own message.
 *
 * Zod 4 folded `invalid_type_error` and `required_error` into a single `error` parameter, and a plain
 * string there is broader still — it also replaces the message of every check on the schema that has
 * none of its own (`.min(3)` would read "Give the place a name." too). This answers the wrong-type case
 * alone and passes everything else on, which is exactly what the Zod 3 parameter did.
 *
 *     z.string({ error: wrongTypeError("Give the place a name.") })
 */
export function wrongTypeError(message: string) {
  return (issue: { code: string; input?: unknown }): string | undefined =>
    issue.code === "invalid_type" && issue.input !== undefined ? message : undefined;
}

/**
 * A PATCH body: the schema's fields, every one optional, and a field the request leaves out STAYS out —
 * `undefined` in the result, so the handler leaves the stored value alone.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ USE THIS, NOT `.partial()`: ZOD 4'S `.partial()` FILLS IN DEFAULTS. Zod 4 lets a field's
 * `.default()` answer for a missing key even inside `.optional()`, so `eventBodySchema.partial()` parses
 * `{ "title": "…" }` into `{ title, isFeatured: false, tags: [], … }`. Every PATCH handler here updates
 * exactly the fields that are not `undefined`, so renaming an event would also have taken it off the
 * homepage and stripped its tags. Zod 3's `.partial()` left a missing key missing, and that is what
 * those handlers were written against — this is it, rebuilt: each field's default comes off before the
 * field is made optional.
 *
 * A default reached through anything but `.optional()` and `.nullable()` cannot be taken off here, and
 * building the schema throws rather than letting it quietly fill in.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function patchOf<Shape extends z.core.$ZodShape, Config extends z.core.$ZodObjectConfig>(
  schema: z.ZodObject<Shape, Config>
): z.ZodObject<{ -readonly [K in keyof Shape]: z.ZodOptional<Shape[K]> }, Config> {
  const fields: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    fields[key] = withoutDefault(field as z.ZodType, key).optional();
  }
  // `.partial()` first: it keeps the object's own handling of unknown keys, and drops any refinement on
  // the whole object (Zod 3 could not `.partial()` one at all), which is what lets `.extend()` run.
  return schema.partial().extend(fields) as unknown as z.ZodObject<
    { -readonly [K in keyof Shape]: z.ZodOptional<Shape[K]> },
    Config
  >;
}

/**
 * `field` with every default that would answer for a missing key taken off, and nothing else changed.
 *
 * ⚠ A WRAPPER THAT IS REBUILT KEEPS ITS CHECKS. `.refine()` is a check on whatever it follows, so
 * `optionalText(500).refine(isWebAddress)` hangs the address test on the `.transform()` pipe — rebuilding
 * that pipe without re-attaching it would let a PATCH store what a create refuses.
 */
function withoutDefault(field: z.ZodType, key: string): z.ZodType {
  const rebuilt = rebuildWithoutDefault(field, key);
  if (rebuilt === field) return field;
  const checks = field.def.checks ?? [];
  return checks.length > 0 ? rebuilt.check(...(checks as z.core.$ZodCheck<unknown>[])) : rebuilt;
}

function rebuildWithoutDefault(field: z.ZodType, key: string): z.ZodType {
  if (field instanceof z.ZodDefault || field instanceof z.ZodPrefault) {
    return withoutDefault(field.unwrap() as z.ZodType, key);
  }
  if (field instanceof z.ZodOptional || field instanceof z.ZodNullable) {
    const inner = withoutDefault(field.unwrap() as z.ZodType, key);
    if (inner === field.unwrap()) return field;
    return field instanceof z.ZodOptional ? inner.optional() : inner.nullable();
  }
  // A `.transform()` is a pipe out of the schema before it, so that schema's default is the pipe's.
  if (field instanceof z.ZodPipe) {
    const input = withoutDefault(field.in as z.ZodType, key);
    return input === field.in ? field : z.pipe(input, field.out as z.ZodType);
  }
  if (field instanceof z.ZodCatch) {
    const inner = withoutDefault(field.unwrap() as z.ZodType, key);
    return inner === field.unwrap() ? field : inner.catch(field.def.catchValue);
  }
  if (field._zod.optin === "defaulted") {
    throw new Error(`patchOf: "${key}" has a default inside a ${field.def.type}, which this cannot take off.`);
  }
  return field;
}

z.config({ customError: zod3Message });

export { z };
