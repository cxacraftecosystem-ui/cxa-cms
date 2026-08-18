"use client";

/**
 * SettingsForm — one tabbed screen over every settings group, GENERATED FROM THEIR ZOD SCHEMAS.
 *
 * (How many groups there are is `SETTINGS_GROUP_KEYS`'s business and is deliberately not counted out in
 * this file: a tally in a comment is wrong the first time a group is added, and every sentence below that
 * used to name one had already gone stale by the time the next one arrived.)
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE FORM IS DERIVED, NOT WRITTEN OUT. `lib/settings/schema.ts` is the single description of what a
 * setting is: its type, its bounds, its default and — through `.describe()` and its own error messages —
 * what it means. This component walks `settingsFieldSchemas(group)` and renders a control per field, so
 * ADDING A SETTING IS ADDING A LINE TO THAT FILE. There is no second list here to keep in step, and no
 * release where the schema accepts a value the form cannot produce.
 *
 * That file is deliberately NOT `server-only` for exactly this reason (its own header says so): the
 * schemas are imported here, in the browser, and used to validate before anything is posted. The same
 * schema then validates again in `setSetting()`, which is the check that actually matters.
 *
 * THE COPY IS NOT DERIVED, AND THAT IS THE ONE DEVIATION. A label generated from a key gives
 * "Ogimagemediaid", and a studio written for a non-technical administrator cannot ship that. So there is a
 * table of proper labels and help sentences below, keyed by `group.field` — and a field with no entry in
 * it still renders, with a humanised name and a plain note saying it is new and undescribed. A new setting
 * therefore APPEARS without a code change, and a new setting with good words is one line of copy. Silence
 * would be the worse failure: a control nobody can name is a control nobody dares touch.
 *
 * ⚠ THE ACCENT IS LOCKED, AND THE LOCK IS EXPLAINED. `accentPreference` is a `z.literal` in the schema,
 * so the generator renders it as a read-only statement carrying `BRANDING_ACCENT_NOTE` verbatim. It is not
 * a colour picker and must never become one: the site has exactly one action colour, and a second one
 * turns "this is the thing to press" into a guess (contract §1.1). An administrator who finds a greyed-out
 * control with no explanation files a bug; one who reads the note does not.
 *
 * EACH GROUP SAVES ON ITS OWN, ATOMICALLY. `setSetting()` writes the document, its revision and its audit
 * entry in one transaction, and a group is one row — so a save either lands whole or does not land. There
 * is no partial state in which the site name has changed and the tagline has not.
 *
 * ⚠ THIS SCREEN ANSWERS "IS THIS GROUP UNSAVED", NOT `useAutosave`. That hook holds ONE baseline, taken
 * when it mounts, and one bar here stands over a document per group. Asked about the tab in front of it, a
 * single hook compares the CONTACT document against the BRANDING baseline it froze at mount, so simply
 * changing tab reads as an edit: the bar says "Unsaved changes" with a Discard beside it, the whole-studio
 * leave guard arms over work nobody did, and Save writes an unaltered document — a revision and an audit
 * entry with the reader's name on a change they never made. So dirtiness is ONE comparison, `drafts`
 * against `saved`, made per group and used for every claim on this screen: the bar's word, its Discard,
 * the leave guard and the list of other groups still holding changes. The hook is kept for what it is good
 * at here — running the request, the status vocabulary and the failure sentence — and nothing depends on
 * its own baseline, which is also why `enabled: false` costs nothing.
 *
 * ⚠ AND DISCARD GOES BACK TO THE LAST SAVE, NEVER TO THE PROPS. `settings` is what the server handed this
 * screen when it was opened and it is never read again — the form does not re-render from the server after
 * a save — so a group discarded to it would silently reinstate the values the reader had already replaced,
 * and the next Save would write them back over the live site. `saved` moves with each successful save,
 * which is what the discard confirmation ("since the last save") actually promises.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useMemo, useState } from "react";
import { CircleCheck, Lock, TriangleAlert, Wrench } from "lucide-react";
import { z } from "zod";

import { apiFetch } from "@/lib/client/fetcher";
import {
  ACCENT_PREFERENCE,
  BRANDING_ACCENT_NOTE,
  FEATURE_FLAGS,
  HERO_MODES,
  LEADERSHIP_LIST_NOTE,
  MAX_FEATURED_CRAFTS,
  MAX_LEADERSHIP,
  SEO_INDEXING_NOTE,
  SETTINGS_GROUPS,
  SOCIAL_PLATFORMS,
  TYPOGRAPHY_OPTION_LABELS,
  TYPOGRAPHY_SETTINGS_COPY,
  settingsFieldSchemas,
  settingsSchema,
  type SettingsGroup,
  type SettingsMap
} from "@/lib/settings/schema";
import { cn } from "@/lib/utils";
import { Field, FieldBlock } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { Tabs } from "@/components/ui/Tabs";
import { Textarea } from "@/components/ui/Textarea";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";
import { SaveBar } from "@/components/studio/SaveBar";
import { useAutosave, type AutosaveStatus } from "@/components/studio/useAutosave";
import { useLeaveGuard } from "@/components/studio/useUnsavedChanges";
import { EntityPicker } from "@/components/studio/fields/EntityPicker";
import { RepeaterField } from "@/components/studio/fields/RepeaterField";

/** One address per group. `PUT` replaces the whole document, which is what `setSetting()` expects. */
const settingsEndpoint = (group: SettingsGroup) =>
  `/api/studio/settings/${encodeURIComponent(group)}`;

/** Past this many characters a single-line box is the wrong shape, so the generator uses a textarea. */
const MULTILINE_FROM = 200;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The copy
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface FieldCopy {
  label: string;
  help?: string;
  /** Forces a textarea for a field whose limit is short but whose content is prose. */
  multiline?: boolean;
}

/**
 * Proper words for every field that exists today, keyed `group.field` (or `group.field.subfield`).
 *
 * See the header: the CONTROL is generated, the WORDS are written. A field missing from this table still
 * renders — with a humanised name and a note that nobody has described it yet.
 */
const COPY: Record<string, FieldCopy> = {
  /*
   * The typesetting group's sentences are written where its schema is, and spread in FIRST so that a
   * hand-written entry below always wins if the two ever name the same field. Twelve fields arriving
   * with humanised keys ("Bodyface", "Pullquote") and the honest "nobody has described it yet" note
   * under each is what this avoids.
   */
  ...TYPOGRAPHY_SETTINGS_COPY,
  "branding.siteName": {
    label: "The Centre's name",
    help: "Appears in the header, in the browser tab, and on every card when somebody shares a page."
  },
  "branding.shortName": {
    label: "Short name",
    help: "Used where the full name will not fit — a phone's header, a share card. Two or three words."
  },
  "branding.tagline": {
    label: "Tagline",
    help: "One line under the name. What the Centre does, not what it aspires to.",
    multiline: true
  },
  "branding.logoMediaId": { label: "Logo", help: "Shown in the header. A wide image with room around it works best." },
  "branding.logoDarkMediaId": {
    label: "Logo for the dark theme",
    help: "A light-on-dark version. Leave it empty to use the same logo in both themes."
  },
  "branding.faviconMediaId": {
    label: "Browser tab icon",
    help: "A small square image. It is shown at about 32 pixels, so anything detailed disappears."
  },
  "branding.ogImageMediaId": {
    label: "Default sharing picture",
    help: "Used on social media and in chat previews for any page that has not chosen its own. 1200 by 630 is the shape that fits everywhere."
  },
  "branding.accentPreference": { label: "Action colour" },

  "contact.addressLine1": { label: "Address, first line" },
  "contact.addressLine2": { label: "Address, second line" },
  "contact.city": { label: "City" },
  "contact.state": { label: "State" },
  "contact.postalCode": { label: "Postcode" },
  "contact.country": { label: "Country" },
  "contact.email": { label: "General email address", help: "Where a message with no better home should go." },
  "contact.phone": { label: "Telephone", help: "Written as somebody would dial it, including the code." },
  "contact.mapLatitude": {
    label: "Map pin — latitude",
    help: "Leave both boxes empty for no map. Copy the two numbers from a map service; latitude is the first one."
  },
  "contact.mapLongitude": { label: "Map pin — longitude" },
  "contact.mapZoom": {
    label: "Map closeness",
    help: "1 shows the whole world; 20 shows a single building. 13 shows a campus and the streets around it."
  },
  "contact.departments": {
    label: "Who to write to about what",
    help: "One row per department, so a specific enquiry reaches the right desk instead of the general address."
  },
  "contact.departments.name": { label: "Department" },
  "contact.departments.email": { label: "Email address" },
  "contact.departments.phone": { label: "Telephone" },
  "contact.departments.note": {
    label: "When to use it",
    help: "The sentence that stops the wrong mail arriving — “Admissions enquiries only, Monday to Friday”."
  },

  "social.links": {
    label: "Social accounts",
    help: "Shown in the footer and the share bar, in this order. Drag to reorder."
  },
  "social.links.platform": {
    label: "Platform",
    help: "Lower case, letters, numbers and hyphens. A platform nobody has heard of yet needs nothing but its name typed here."
  },
  "social.links.url": { label: "Web address", help: "The full address of the account, beginning with https://" },
  "social.links.label": {
    label: "What to call it",
    help: "The name a screen reader reads out. Leave it empty to use the platform's own name."
  },

  "seo.defaultTitle": {
    label: "Homepage title",
    help: "Also the fallback for any page that has not set its own."
  },
  "seo.titleTemplate": {
    label: "Title pattern",
    help: "How a page's title is written in the browser tab. %s is where the page's own title goes — without it every page gets the same title."
  },
  "seo.defaultDescription": {
    label: "Default description",
    help: "Two sentences describing the Centre, used where a page has written none. Search engines show about 160 characters of it.",
    multiline: true
  },
  "seo.defaultOgImageMediaId": { label: "Default sharing picture" },
  "seo.robotsAllowIndexing": { label: "Let search engines list this site" },
  "seo.googleSiteVerification": {
    label: "Google verification code",
    help: "Only the code itself, not the whole tag Google gives you. Leave it empty unless you are setting up Search Console."
  },

  "homepage.heroMode": { label: "How the homepage opens" },
  "homepage.showNewsTicker": { label: "Show the scrolling news strip" },
  "homepage.tickerSpeedSeconds": {
    label: "Seconds for one full pass of the strip",
    help: "Time a pass with a watch. Slower is easier to read. The strip is switched off entirely for anybody who has asked for less movement, whatever this says."
  },
  "homepage.featuredCraftIds": {
    label: "Crafts featured on the homepage",
    help: "Chosen by hand, in this order. Only published crafts appear on the site."
  },
  "homepage.censusOverride": {
    label: "The counts strip",
    help: "The homepage normally counts published records. Turn this on for the weeks when the true count would mislead — a migration in progress, an embargoed batch — and say why."
  },
  "homepage.censusOverride.enabled": { label: "Show a note instead of the counts" },
  "homepage.censusOverride.note": {
    label: "What the note says",
    help: "Shown in place of the numbers. Say what is happening and when the counts will be right again.",
    multiline: true
  },

  /*
   * The one entry whose sentence is IMPORTED rather than written here, and the reason is the sentence
   * itself. It says what an empty list does — the About page falls back to every published faculty member
   * and scientist — which is a fact about that route, not a description of a box. Written out a second
   * time in this table it would be a second opinion about the fallback, and the copy on this screen would
   * go on promising the old behaviour for as long as it took somebody to notice. `lib/settings/schema.ts`
   * owns it, carries it on the field's own `.describe()`, and this is the same arrangement the typesetting
   * group, `FEATURE_FLAGS` and `SEO_INDEXING_NOTE` are already under.
   */
  "leadership.personIds": {
    label: "Who appears in the Leadership section",
    help: LEADERSHIP_LIST_NOTE
  },

  "footer.columns": {
    label: "Footer columns",
    help: "Each column has a heading and a list of links. Drag to reorder."
  },
  "footer.columns.heading": { label: "Column heading" },
  "footer.columns.links": { label: "Links in this column" },
  "footer.columns.links.label": { label: "Words on the link" },
  "footer.columns.links.href": {
    label: "Where it goes",
    help: "A path on this site beginning with /, a full https:// address, or mailto: / tel:."
  },
  "footer.legalNote": {
    label: "Legal line",
    help: "The copyright and policy line under the columns. Plain text — it is rendered as text, never as markup.",
    multiline: true
  },
  "footer.showCredit": { label: "Show the “built by” credit" }
};

/** "ogImageMediaId" → "Og image media id". The last resort, never the normal path. */
function humanise(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  if (words.length === 0) return key;
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function copyFor(path: string, key: string): FieldCopy & { described: boolean } {
  const found = COPY[path];
  if (found) return { ...found, described: true };
  return { label: humanise(key), described: false };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Reading a Zod schema
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The parts of a Zod definition this generator reads.
 *
 * ⚠ `_def` IS ZOD'S INTERNAL SHAPE, and reading it is a deliberate, contained decision: it is the only way
 * to ask a schema "what kind of value do you hold, and what are your bounds" without a second description
 * of every field living in this file — which is the whole thing the generator exists to avoid. The access
 * is confined to `defOf` and the two functions below, so a Zod upgrade that moves any of it breaks HERE,
 * loudly, rather than producing a form of blank boxes.
 */
interface ZodDefLike {
  typeName?: string;
  innerType?: z.ZodTypeAny;
  schema?: z.ZodTypeAny;
  type?: z.ZodTypeAny;
  values?: readonly unknown[];
  value?: unknown;
  shape?: () => Record<string, z.ZodTypeAny>;
  checks?: readonly { kind: string; value?: number }[];
  maxLength?: { value: number } | null;
  defaultValue?: () => unknown;
}

function defOf(schema: z.ZodTypeAny): ZodDefLike {
  return schema._def as unknown as ZodDefLike;
}

/** Peel `.default()`, `.catch()`, `.optional()`, `.nullable()` and every `.refine()`/`.transform()`. */
function unwrap(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; nullable: boolean } {
  let current = schema;
  let nullable = false;

  // Bounded, because a malformed chain must not be an infinite loop inside a render.
  for (let depth = 0; depth < 12; depth += 1) {
    const def = defOf(current);
    if (def.typeName === "ZodNullable") {
      nullable = true;
      if (!def.innerType) break;
      current = def.innerType;
      continue;
    }
    if (def.typeName === "ZodOptional" || def.typeName === "ZodDefault" || def.typeName === "ZodCatch") {
      if (!def.innerType) break;
      current = def.innerType;
      continue;
    }
    if (def.typeName === "ZodEffects") {
      if (!def.schema) break;
      current = def.schema;
      continue;
    }
    break;
  }

  return { inner: current, nullable };
}

type FieldShape =
  | { kind: "text"; max: number | undefined }
  | { kind: "boolean" }
  | { kind: "number"; int: boolean; min: number | undefined; max: number | undefined }
  | { kind: "enum"; values: string[] }
  | { kind: "literal"; value: string }
  | { kind: "stringList"; max: number | undefined }
  | { kind: "objectList"; item: Record<string, z.ZodTypeAny>; max: number | undefined }
  | { kind: "object"; shape: Record<string, z.ZodTypeAny> }
  | { kind: "unsupported"; typeName: string };

function shapeOf(schema: z.ZodTypeAny): FieldShape & { nullable: boolean } {
  const { inner, nullable } = unwrap(schema);
  const def = defOf(inner);

  switch (def.typeName) {
    case "ZodString": {
      const max = def.checks?.find((check) => check.kind === "max")?.value;
      return { kind: "text", max, nullable };
    }
    case "ZodBoolean":
      return { kind: "boolean", nullable };
    case "ZodNumber": {
      const checks = def.checks ?? [];
      return {
        kind: "number",
        int: checks.some((check) => check.kind === "int"),
        min: checks.find((check) => check.kind === "min")?.value,
        max: checks.find((check) => check.kind === "max")?.value,
        nullable
      };
    }
    case "ZodEnum":
      return {
        kind: "enum",
        values: (def.values ?? []).filter((value): value is string => typeof value === "string"),
        nullable
      };
    case "ZodLiteral":
      return { kind: "literal", value: String(def.value ?? ""), nullable };
    case "ZodArray": {
      const element = def.type;
      const max = def.maxLength?.value;
      if (!element) return { kind: "unsupported", typeName: "ZodArray", nullable };
      const { inner: elementInner } = unwrap(element);
      const elementDef = defOf(elementInner);
      if (elementDef.typeName === "ZodObject" && elementDef.shape) {
        return { kind: "objectList", item: elementDef.shape(), max, nullable };
      }
      return { kind: "stringList", max, nullable };
    }
    case "ZodObject":
      return { kind: "object", shape: def.shape?.() ?? {}, nullable };
    default:
      return { kind: "unsupported", typeName: def.typeName ?? "unknown", nullable };
  }
}

/** A blank value for a field, for a row somebody has just added to a repeating list. */
function blankFor(schema: z.ZodTypeAny): unknown {
  const shape = shapeOf(schema);
  switch (shape.kind) {
    case "boolean":
      return false;
    case "number":
      return shape.nullable ? null : (shape.min ?? 0);
    case "enum":
      return shape.values[0] ?? "";
    case "literal":
      return shape.value;
    case "stringList":
    case "objectList":
      return [];
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [key, member] of Object.entries(shape.shape)) out[key] = blankFor(member);
      return out;
    }
    default:
      // Text and anything unsupported: the empty string. Never `null` — a controlled `<input>` whose value
      // goes null warns and then silently switches to uncontrolled (schema.ts says the same).
      return shape.nullable && shape.kind !== "text" ? null : "";
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Values
// ─────────────────────────────────────────────────────────────────────────────────────────────────

type Document = Record<string, unknown>;

function asDocument(value: unknown): Document {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Document)
    : {};
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function asObjectList(value: unknown): Document[] {
  return Array.isArray(value) ? value.map(asDocument) : [];
}

/**
 * Every group's document in one map, keyed by group.
 *
 * Written once because the screen holds two of these — the drafts being edited and the last thing the
 * server accepted — and they begin life identical. Two loops that had to agree eventually would not.
 */
function documentsFrom(settings: SettingsMap): Record<string, Document> {
  const out: Record<string, Document> = {};
  for (const meta of SETTINGS_GROUPS) out[meta.key] = asDocument(settings[meta.key]);
  return out;
}

export interface SettingsFormProps {
  /** Every group, resolved and repaired by `getSettings()` on the server. */
  settings: SettingsMap;
  /** `configurationWarnings()` from lib/env.ts. Empty when nothing is missing. */
  diagnostics: readonly string[];
  /** True when object storage is configured, so the media pickers can say why they are empty. */
  storageReady: boolean;
}

export function SettingsForm({ settings, diagnostics, storageReady }: SettingsFormProps) {
  const [group, setGroup] = useState<SettingsGroup>("branding");
  /** One draft per group, so switching tabs does not throw away unsaved work in the one you left. */
  const [drafts, setDrafts] = useState<Record<string, Document>>(() => documentsFrom(settings));
  /**
   * What the server last accepted for each group. See the header: this — not the `settings` prop — is
   * what "unsaved" is measured against and what Discard puts back, because the prop stops being true the
   * moment anything is saved.
   */
  const [saved, setSaved] = useState<Record<string, Document>>(() => documentsFrom(settings));
  /** When each group last landed, so the bar's "saved 2 minutes ago" is about the group it sits under. */
  const [savedAt, setSavedAt] = useState<Record<string, Date>>({});
  /**
   * Which group the most recent request was for.
   *
   * The hook reports one "saving" and one failure for a bar that stands over every group's document, so
   * the answer has to be attributed: a reader who presses Save and changes tab must not find the tab they
   * moved to claiming to be saving, nor wearing the other group's error.
   */
  const [requestGroup, setRequestGroup] = useState<SettingsGroup | null>(null);
  /** Per-field messages from a failed save, keyed by the field path the server named. */
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const draft = drafts[group] ?? {};

  const setValue = useCallback(
    (key: string, value: unknown) => {
      setDrafts((current) => ({ ...current, [group]: { ...(current[group] ?? {}), [key]: value } }));
      // A field the reader has just changed is no longer the field the server complained about.
      setFieldErrors((current) => {
        if (current[key] === undefined) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    },
    [group]
  );

  const save = useCallback(
    async (body: Document) => {
      /**
       * WHICH GROUP THIS REQUEST IS FOR, fixed before anything can await.
       *
       * The reader may change tab while it is in flight, and every piece of state written below belongs to
       * the group that was SENT rather than to whichever one is on screen when the answer arrives.
       */
      const target = group;
      setRequestGroup(target);

      /**
       * VALIDATED HERE BEFORE IT LEAVES, with the SAME schema the server will use.
       *
       * Not instead of the server's check — `setSetting()` parses again, and that is the boundary. This one
       * exists so a reader who typed a title pattern without %s is told which box is wrong before a round
       * trip, in the schema's own words rather than in a second wording that would drift from it.
       */
      const parsed = settingsSchema(target).safeParse(body);
      if (!parsed.success) {
        const collected: Record<string, string[]> = {};
        for (const issue of parsed.error.issues) {
          const path = issue.path.join(".");
          const bucket = collected[path] ?? [];
          bucket.push(issue.message);
          collected[path] = bucket;
        }
        setFieldErrors(collected);
        // Thrown so `useAutosave` reports it on the bar rather than the save appearing to have worked.
        throw new Error(
          "Some of these settings cannot be saved yet. The boxes with a problem are marked below."
        );
      }

      setFieldErrors({});
      await apiFetch<void>(settingsEndpoint(target), { method: "PUT", body: parsed.data });

      /**
       * THE BODY AS IT WAS SENT, not `parsed.data`.
       *
       * What the reader is comparing against is their own draft, and the parsed copy differs from it
       * wherever Zod filled a default in for a key the draft leaves out — an emptied number box, say.
       * Recording the parsed document would leave the group reporting changes nobody made for as long as
       * the screen stayed open.
       */
      setSaved((current) => ({ ...current, [target]: body }));
      setSavedAt((current) => ({ ...current, [target]: new Date() }));
    },
    [group]
  );

  /**
   * `enabled: false` runs NO automatic timer; `saveNow()` still works.
   *
   * Settings are read by the root layout, the header, the footer and every metadata function, so a
   * half-typed site name saved four seconds after somebody starts editing is the wrong name on every page
   * of the site at once. What the hook is used for here is the request itself — one at a time, never two
   * in flight — and the two facts only it knows: that one is running, and that the last one failed. Its
   * own baseline is deliberately ignored, because it can hold exactly one and this screen edits every
   * group's document behind one bar (see the header).
   */
  const autosave = useAutosave<Document>({ data: draft, save, enabled: false });

  /**
   * The groups that differ from what the server last accepted, BY NAME and in the tab order.
   *
   * The one dirtiness answer on this screen — see the header for why it is not the hook's. Serialised
   * rather than compared field by field, which is the same rule `useAutosave` follows: both documents are
   * built by spreading a fixed shape, so a re-render with identical values is identical text, and typing a
   * character and deleting it again leaves the group clean.
   */
  const dirtyGroups = useMemo(
    () =>
      SETTINGS_GROUPS.filter(
        (entry) => JSON.stringify(drafts[entry.key] ?? {}) !== JSON.stringify(saved[entry.key] ?? {})
      ),
    [drafts, saved]
  );
  const isDirty = dirtyGroups.some((entry) => entry.key === group);

  /**
   * Leaving loses every group's typing, not just this tab's, so the guard is armed by ANY of them. The
   * warning below names which, because a dialog about work the reader cannot see is a dialog they dismiss.
   */
  useLeaveGuard(dirtyGroups.length > 0);

  /**
   * The bar's state for THIS group. The hook still owns the two facts only it can know — a request is in
   * flight, and the last one failed — and both are shown only under the group they belong to.
   */
  const status: AutosaveStatus =
    autosave.status === "saving" && requestGroup === group
      ? "saving"
      : autosave.error !== null && requestGroup === group
        ? "error"
        : isDirty
          ? "dirty"
          : savedAt[group] !== undefined
            ? "saved"
            : "idle";

  const fields = useMemo(() => settingsFieldSchemas(group), [group]);
  const meta = SETTINGS_GROUPS.find((entry) => entry.key === group) ?? SETTINGS_GROUPS[0];

  const undescribed = Object.keys(fields).filter(
    (key) => !copyFor(`${group}.${key}`, key).described
  );

  /**
   * Groups other than this one with unsaved changes, BY NAME.
   *
   * Each group saves on its own, so switching tabs keeps a draft rather than throwing it away — which is
   * kind, and also a way to leave the screen believing everything was saved. "2 other groups have unsaved
   * changes" would send somebody hunting through every tab on the screen; the names are the difference
   * between a number and a job.
   */
  const unsavedElsewhere = dirtyGroups
    .filter((entry) => entry.key !== group)
    .map((entry) => entry.label);

  return (
    <div className="space-y-6">
      {/* ── Diagnostics ────────────────────────────────────────────────────────────────────── */}
      <FormSection
        title="Diagnostics"
        description="What this installation is missing, read from the server as this page was rendered. These are set by whoever deploys the site, not on this screen."
      >
        {diagnostics.length === 0 ? (
          <p className="flex items-start gap-2 text-sm leading-relaxed text-success-600">
            <CircleCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Everything the application checks for is configured. Uploads, images, migrations and the
              site&rsquo;s own address are all set up.
            </span>
          </p>
        ) : (
          <div className="rounded-md border border-amber-800/25 bg-amber-100 px-3.5 py-3 text-amber-800">
            <p className="flex items-start gap-2 text-sm font-semibold">
              <Wrench aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {diagnostics.length === 1
                  ? "1 thing is not set up on this installation"
                  : `${diagnostics.length} things are not set up on this installation`}
              </span>
            </p>
            <ul className="mt-1.5 list-disc space-y-1 pl-6 text-xs leading-relaxed">
              {diagnostics.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs leading-relaxed">
              This is where you find out that uploads are disabled — rather than from an upload that fails
              at 90%. Each line names the setting that is missing; they live in the deployment&rsquo;s
              environment and cannot be changed from this screen.
            </p>
          </div>
        )}

        {!storageReady ? (
          <HelpText tone="warn">
            Because the file store is not set up, the picture fields below cannot be filled in — there is
            nothing to choose from and nothing can be uploaded.
          </HelpText>
        ) : null}
      </FormSection>

      <Tabs
        label="Settings groups"
        value={group}
        onChange={(next) => {
          const found = SETTINGS_GROUPS.find((entry) => entry.key === next);
          if (found) setGroup(found.key);
        }}
        items={SETTINGS_GROUPS.map((entry) => ({ id: entry.key, label: entry.label }))}
      />

      {unsavedElsewhere.length > 0 ? (
        <HelpText tone="warn">
          {unsavedElsewhere.length === 1
            ? `${unsavedElsewhere[0]} has changes you have not saved.`
            : `These groups have changes you have not saved: ${unsavedElsewhere.join(", ")}.`}{" "}
          Each group is saved on its own, so go back to it and press Save there. Leaving this screen loses
          them.
        </HelpText>
      ) : null}

      <FormSection title={meta?.label ?? "Settings"} description={meta?.description}>
        {undescribed.length > 0 ? (
          <HelpText>
            {undescribed.length === 1
              ? "One setting below is new and nobody has written a description for it yet."
              : `${undescribed.length} settings below are new and nobody has written descriptions for them yet.`}{" "}
            They still work — the form is generated from the settings themselves, so a new one appears here
            the moment it is added. Ask whoever added it what it does before changing it.
          </HelpText>
        ) : null}

        {Object.entries(fields).map(([key, schema]) => (
          <SettingField
            key={`${group}.${key}`}
            path={`${group}.${key}`}
            fieldKey={key}
            schema={schema}
            value={draft[key]}
            onChange={(next) => setValue(key, next)}
            errors={fieldErrors[key]}
            allErrors={fieldErrors}
            storageReady={storageReady}
          />
        ))}
      </FormSection>

      <SaveBar
        status={status}
        lastSavedAt={savedAt[group] ?? null}
        onSave={() => void autosave.saveNow()}
        onDiscard={() => {
          // Back to the last save, not to the props — see the header.
          setDrafts((current) => ({ ...current, [group]: saved[group] ?? {} }));
          setFieldErrors({});
        }}
        error={autosave.error !== null && requestGroup === group ? autosave.error.message : null}
        subject={`the ${(meta?.label ?? "settings").toLowerCase()} settings`}
        saveLabel={`Save ${(meta?.label ?? "settings").toLowerCase()}`}
        note="Settings are not saved automatically: they are read by every page of the site, so a half-typed value would be live everywhere within seconds. Each group is saved on its own, all at once — the change lands whole or not at all."
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// One generated field
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface SettingFieldProps {
  /** `group.field`, or `group.field.subfield` inside a repeating row. Keys the copy table. */
  path: string;
  fieldKey: string;
  schema: z.ZodTypeAny;
  value: unknown;
  onChange: (next: unknown) => void;
  errors: string[] | undefined;
  /** The whole error map, so a nested row can find the message for `departments.0.email`. */
  allErrors: Record<string, string[]>;
  storageReady: boolean;
}

/**
 * A reference to a `MediaAsset` is recognised by its NAME, not by its type.
 *
 * Every such field in the schema is built by the same `mediaId` helper, which produces an indistinguishable
 * nullable string — so the type cannot tell one from a short text box. The `MediaId` suffix is the
 * convention that file establishes, and a new picture setting that follows it gets a picture picker with no
 * change here; one that does not gets a text box, which is wrong but visibly wrong rather than broken.
 */
function isMediaField(key: string): boolean {
  return /MediaId$/.test(key);
}

function SettingField({
  path,
  fieldKey,
  schema,
  value,
  onChange,
  errors,
  allErrors,
  storageReady
}: SettingFieldProps) {
  const shape = shapeOf(schema);
  const copy = copyFor(path, fieldKey);
  const error = errors?.[0] ?? null;
  const help = copy.described
    ? copy.help
    : "This setting is new and nobody has described it yet. Leave it alone unless you know what it does.";

  // ── The locked accent ────────────────────────────────────────────────────────────────────────
  if (shape.kind === "literal") {
    return (
      <div className="rounded-md border border-line-200 bg-surface-50 px-3.5 py-3">
        <p className="field-label flex items-center gap-1.5">
          <Lock aria-hidden="true" className="h-3.5 w-3.5" />
          {copy.label}
        </p>
        <p className="mt-1.5 text-sm font-semibold text-purple-700">
          {shape.value === ACCENT_PREFERENCE ? "Purple" : shape.value}
        </p>
        {/*
          The note is rendered VERBATIM from the schema. A second wording here would be a second opinion
          about a rule the design contract owns.
        */}
        <p className="prose-measure mt-1.5 text-xs leading-relaxed text-ink-500">
          {path === "branding.accentPreference" ? BRANDING_ACCENT_NOTE : "This value is fixed."}
        </p>
      </div>
    );
  }

  // ── Pictures ─────────────────────────────────────────────────────────────────────────────────
  if (shape.kind === "text" && isMediaField(fieldKey)) {
    const current = typeof value === "string" && value.length > 0 ? [value] : [];
    return (
      <div className="min-w-0">
        <EntityPicker
          kind="media"
          label={copy.label}
          help={help}
          ids={current}
          max={1}
          onChange={(ids) => onChange(ids[0] ?? null)}
          error={error}
        />
        {!storageReady ? (
          <HelpText className="mt-1.5">
            Nothing can be chosen until the file store is set up.
          </HelpText>
        ) : null}
      </div>
    );
  }

  // ── Hand-picked crafts ───────────────────────────────────────────────────────────────────────
  if (shape.kind === "stringList" && path === "homepage.featuredCraftIds") {
    return (
      <EntityPicker
        kind="craft"
        label={copy.label}
        help={help}
        ids={asStringList(value)}
        max={shape.max ?? MAX_FEATURED_CRAFTS}
        onChange={(ids) => onChange(ids)}
        error={error}
        footnote="A craft that is not published will not appear on the homepage, even while it is chosen here."
      />
    );
  }

  // ── The Centre's leadership ──────────────────────────────────────────────────────────────────
  /*
   * ⚠ `browse`, WHICH THE CRAFTS PICKER DIRECTLY ABOVE DELIBERATELY DOES NOT PASS. The two lists are
   * arrived at in opposite ways. Somebody featuring crafts has a craft in mind and types its name, so a
   * search box is exactly the right control. Somebody naming the Centre's leadership is working down a
   * roster of colleagues: they know the faces, frequently not the spelling, and cannot type a query for a
   * name they are trying to remember — a search box in front of a list of one's own staff is a memory
   * test with the answer hidden behind it. `browse` turns the results panel into a tick list over
   * everybody of this kind and asks the endpoint for the whole roster rather than for the twenty most
   * recently edited, which is an order nobody picks a leadership team from. It still states on screen when
   * even that was not everything, so a list that stops early says so (contract §1.6).
   *
   * The cap is read off the SCHEMA first, exactly as the crafts branch reads it: a form that accepts more
   * than the save will take refuses work that has already been done, and there is only one right number
   * for that. `MAX_LEADERSHIP` is the fallback because `shape.max` comes out of Zod's internals — if a
   * version bump ever moved `maxLength`, the picker inheriting the component's own default of 24 would
   * quietly stop an administrator a sixth of the way through the roster with no explanation on screen.
   */
  if (shape.kind === "stringList" && path === "leadership.personIds") {
    return (
      <EntityPicker
        kind="person"
        browse
        label={copy.label}
        help={help}
        ids={asStringList(value)}
        max={shape.max ?? MAX_LEADERSHIP}
        onChange={(ids) => onChange(ids)}
        error={error}
        /*
          WHAT THE ROWS ALREADY SHOW, TRANSLATED INTO WHAT IT COSTS. The panel puts a status chip on every
          row and writes "Hidden from the site" under anybody switched out of the listings, so repeating
          either of those here would tell an administrator something they can already see. What it does not
          say is that the About page filters on BOTH — a chosen person passes only if they are published and
          visible — and that the section's answer to a name it cannot show is simply to draw one card fewer.
        */
        footnote="A person who is not published, or whose “Show in the people lists” switch is off, will not appear on the About page even while they are named here — the rows above say which of the two it is. The section draws one card fewer and says nothing, so an absence on the public page is only findable from this screen."
      />
    );
  }

  // ── Switches ─────────────────────────────────────────────────────────────────────────────────
  if (shape.kind === "boolean") {
    /**
     * A `Switch`, not a `Checkbox`: these are settings, and the difference is real (Switch.tsx). The saving
     * is still explicit, so the state word beside the knob is the honest one — it says what the switch is
     * set to, and the bar says whether that has been saved.
     */
    const description =
      path === "seo.robotsAllowIndexing"
        ? SEO_INDEXING_NOTE
        : FEATURE_FLAGS.find((flag) => path === `features.${flag.key}`)?.description ?? help;

    return (
      <div className="min-w-0">
        <Switch
          checked={value === true}
          onCheckedChange={(checked) => onChange(checked)}
          label={
            FEATURE_FLAGS.find((flag) => path === `features.${flag.key}`)?.label ?? copy.label
          }
          description={description}
        />
        {error ? <HelpText tone="error">{error}</HelpText> : null}
      </div>
    );
  }

  // ── Closed lists ─────────────────────────────────────────────────────────────────────────────
  if (shape.kind === "enum") {
    const heroMode = path === "homepage.heroMode";
    /*
     * A closed list takes its option WORDS from the same table its field does, where one exists —
     * which is what turns "intimate" into "Intimate — about 54 characters" and "lora" into
     * "Lora — Serif, for reading". A dropdown of bare slugs makes the reader guess what each does.
     *
     * `?.` rather than a lookup with a fallback object: under `noUncheckedIndexedAccess` the miss is
     * `undefined`, so every group that has written no option labels keeps `humanise(entry)` exactly as
     * before and nothing else on this screen changes.
     */
    const options = heroMode
      ? HERO_MODES.map((mode) => ({ value: mode.value, label: mode.label }))
      : shape.values.map((entry) => ({
          value: entry,
          label: TYPOGRAPHY_OPTION_LABELS[path]?.[entry] ?? humanise(entry)
        }));
    const chosenHelp = heroMode
      ? HERO_MODES.find((mode) => mode.value === value)?.description
      : undefined;

    return (
      <Field label={copy.label} help={chosenHelp ?? help} error={error}>
        <Select
          value={typeof value === "string" ? value : ""}
          options={options}
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>
    );
  }

  // ── Numbers ──────────────────────────────────────────────────────────────────────────────────
  if (shape.kind === "number") {
    const text = typeof value === "number" && Number.isFinite(value) ? String(value) : "";
    return (
      <Field
        label={copy.label}
        help={
          help ??
          (shape.min !== undefined && shape.max !== undefined
            ? `A number between ${shape.min} and ${shape.max}.`
            : undefined)
        }
        error={error}
      >
        <Input
          type="number"
          inputMode="decimal"
          value={text}
          step={shape.int ? 1 : "any"}
          min={shape.min}
          max={shape.max}
          onChange={(event) => {
            const raw = event.target.value.trim();
            /**
             * AN EMPTY BOX IS `null`, NEVER 0.
             *
             * `Number("")` is 0, and 0, 0 is a real place in the Gulf of Guinea — which is exactly why
             * `lib/settings/schema.ts` refuses to use `z.coerce.number()` for the map coordinates.
             *
             * For a field that CANNOT be null the value becomes `undefined`, which means the key is
             * MISSING when the document is serialised — and Zod's `.default()` fires for a missing key,
             * never for an explicit null (contract §14). So clearing such a box restores its default rather
             * than failing validation, which is the only sensible answer to an empty required number.
             */
            if (raw.length === 0) {
              onChange(shape.nullable ? null : undefined);
              return;
            }
            const parsed = shape.int ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
            onChange(Number.isFinite(parsed) ? parsed : shape.nullable ? null : undefined);
          }}
          className="max-w-48"
        />
      </Field>
    );
  }

  // ── A nested group of its own ────────────────────────────────────────────────────────────────
  if (shape.kind === "object") {
    const nested = asDocument(value);
    return (
      <fieldset className="min-w-0 rounded-md border border-line-200 bg-surface-50 p-3">
        {/* A `<legend>` rather than a heading: this is a group of controls inside a form, and its name is
            not a place in the document outline. */}
        <legend className="field-label px-1">{copy.label}</legend>
        {help ? <p className="px-1 pb-2 text-xs leading-relaxed text-ink-500">{help}</p> : null}
        <div className="space-y-4">
          {Object.entries(shape.shape).map(([childKey, childSchema]) => (
            <SettingField
              key={childKey}
              path={`${path}.${childKey}`}
              fieldKey={childKey}
              schema={childSchema}
              value={nested[childKey]}
              onChange={(next) => onChange({ ...nested, [childKey]: next })}
              errors={allErrors[`${fieldKey}.${childKey}`]}
              allErrors={allErrors}
              storageReady={storageReady}
            />
          ))}
        </div>
      </fieldset>
    );
  }

  // ── Repeating rows ───────────────────────────────────────────────────────────────────────────
  if (shape.kind === "objectList") {
    const rows = asObjectList(value);
    const itemShape = shape.item;
    const max = shape.max ?? 20;
    const nameKey =
      Object.keys(itemShape).find((key) => key === "name" || key === "heading" || key === "label") ??
      Object.keys(itemShape)[0] ??
      "";

    return (
      <RepeaterField<Document>
        label={copy.label}
        help={help}
        items={rows}
        onChange={(next) => onChange(next)}
        // The schema's own cap, so the form cannot accept a list the save then refuses (contract §1.6).
        max={max}
        createItem={() => {
          const blank: Document = {};
          for (const [key, member] of Object.entries(itemShape)) blank[key] = blankFor(member);
          return blank;
        }}
        summary={(item) => {
          const named = item[nameKey];
          return typeof named === "string" ? named : "";
        }}
        isEmpty={(item) =>
          Object.values(item).every(
            (entry) =>
              entry === null ||
              entry === undefined ||
              entry === "" ||
              (Array.isArray(entry) && entry.length === 0)
          )
        }
        itemNoun={singularise(copy.label)}
        error={error}
        renderItem={({ item, index, update }) => (
          <>
            {Object.entries(itemShape).map(([childKey, childSchema]) => (
              <SettingField
                key={childKey}
                path={`${path}.${childKey}`}
                fieldKey={childKey}
                schema={childSchema}
                value={item[childKey]}
                onChange={(next) => update({ ...item, [childKey]: next })}
                // The server names a nested problem by its full path, so a message about the third row's
                // email is attached to the third row's email box rather than to the list as a whole.
                errors={allErrors[`${fieldKey}.${index}.${childKey}`]}
                allErrors={allErrors}
                storageReady={storageReady}
              />
            ))}
            {path === "social.links" ? (
              <HelpText>
                Common platforms —{" "}
                {SOCIAL_PLATFORMS.slice(0, 6)
                  .map((platform) => platform.value)
                  .join(", ")}{" "}
                — get their own icon. Anything else gets a globe, which is fine.
              </HelpText>
            ) : null}
          </>
        )}
      />
    );
  }

  // ── A plain list of words ────────────────────────────────────────────────────────────────────
  if (shape.kind === "stringList") {
    const list = asStringList(value);
    return (
      <FieldBlock
        label={copy.label}
        help={`${help ?? ""} One per line.`.trim()}
        error={error}
      >
        <Textarea
          value={list.join("\n")}
          rows={4}
          onChange={(event) =>
            onChange(
              event.target.value
                .split("\n")
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0)
            )
          }
        />
        {shape.max !== undefined ? (
          <p
            className={cn(
              "mt-1.5 text-xs tabular-nums",
              list.length >= shape.max ? "text-amber-800" : "text-ink-500"
            )}
          >
            Up to {shape.max}; {list.length} listed.
          </p>
        ) : null}
      </FieldBlock>
    );
  }

  // ── Text ─────────────────────────────────────────────────────────────────────────────────────
  if (shape.kind === "text") {
    const text = typeof value === "string" ? value : "";
    const multiline = copy.multiline === true || (shape.max !== undefined && shape.max >= MULTILINE_FROM);
    return (
      <Field
        label={copy.label}
        help={help}
        error={error}
        maxLength={shape.max}
        value={text}
      >
        {multiline ? (
          <Textarea value={text} onChange={(event) => onChange(event.target.value)} rows={3} />
        ) : (
          <Input value={text} onChange={(event) => onChange(event.target.value)} />
        )}
      </Field>
    );
  }

  // ── Something this generator does not know ───────────────────────────────────────────────────
  /*
    SAID OUT LOUD, never skipped. A field the generator cannot draw is a setting that would be invisible on
    this screen and silently reset to its default the next time the group was saved — which is the worst of
    the available outcomes. Naming it means somebody adds a branch above.
  */
  return (
    <HelpText tone="warn" icon={TriangleAlert}>
      <span className="font-semibold">{copy.label}</span> is a kind of setting this screen cannot draw yet
      ({shape.typeName}). It is left exactly as it is and saving this group will not change it, but it
      cannot be edited here.
    </HelpText>
  );
}

/** "Footer columns" → "column". Good enough for a button label, and a fallback that is never empty. */
function singularise(label: string): string {
  const words = label.trim().toLowerCase().split(/\s+/);
  const last = words[words.length - 1] ?? "item";
  if (last.endsWith("ies")) return `${last.slice(0, -3)}y`;
  if (last.endsWith("s") && !last.endsWith("ss")) return last.slice(0, -1);
  return last;
}
