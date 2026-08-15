"use client";

/**
 * FormEmbedForm — a form built somewhere else (Google Forms, Microsoft Forms, Typeform) shown inside a page
 * of this site, or any other service offered as a plain link.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ADDRESS IS CHECKED AGAINST THE SCHEMA'S OWN ALLOW-LIST WHILE IT IS TYPED, AND THE LIST IS NAMED ON
 * SCREEN BEFORE IT IS BROKEN.
 *
 * The check is not a convenience. An arbitrary page in a frame on our own origin is a page under somebody
 * else's control wearing the Centre's domain, its padlock and its header — the entire construction of a
 * credential-harvesting page — and every instinct we teach a reader ("check the address bar") gives the
 * wrong answer. So `lib/sections/schema.ts` holds `FORM_PROVIDER_HOSTS`, `formHostAllowed()` and
 * `describeFormHosts()`, and this form calls THOSE rather than keeping a second copy: three
 * implementations of a security check are three chances for one of them to be out of date.
 *
 * ⚠ THE MESSAGES ARE THE SCHEMA'S, READ BACK BY RUNNING IT. Both rules that can fail here — the host and
 * the missing description — live in `formEmbedSectionSchema`'s `superRefine`, so the sentence an editor
 * reads is character for character the sentence the save would produce. Writing a second wording here
 * would give the studio two explanations of one rule, and the one on screen would be the one nobody
 * updated. (Because of that `superRefine` this schema is a `ZodEffects`, which is why the field
 * descriptions come through `.innerType()` — the same as EMBED.)
 *
 * WHAT IS ACCEPTED IS STATED WHETHER OR NOT IT HAS BEEN BROKEN. `describeFormHosts()` sits in the field's
 * own help on every render where there is an answer to give: a rule you only meet by breaking it reads as
 * a fault rather than as a rule. ⚠ There is exactly ONE render where there is no answer — a stored service
 * this build has never heard of, which is not hypothetical and used to take the whole page builder down
 * from this very line. See `knownProvider` below: that case states itself in place of the list rather than
 * falling silent, because a line that said nothing would leave the editor with no account, anywhere in
 * this form, of the service the row actually names.
 *
 * "ANOTHER SERVICE" IS NEVER FRAMED, AND THE FORM SAYS SO. It maps to an empty host list on purpose, so
 * any https address is accepted — and offered to a reader as an outbound link, which is safe because a
 * link shows its destination and leaves our origin.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ WHERE TO FIND THE ADDRESS IS SPELLED OUT PER SERVICE, AND THAT IS HALF THE POINT OF THIS FORM. Every
 * one of these services has a share screen with three or four options on it, only one of which is the
 * address that works, and choosing the wrong one is the step a non-technical editor gets stuck on. Google
 * Forms in particular is Send, then the link tab, then Copy — and nothing about the Send dialog suggests
 * that the email tab it opens on is the wrong one.
 *
 * `FieldBlock` FOR THE ADDRESS, `Field` FOR EVERYTHING ELSE. The address sits beside a link that opens it
 * in a new tab, and `Field` is a real `<label>`: it would fold that link's words into the input's
 * accessible name, so a screen reader would read "The address of the form, open the form in a new tab to
 * check it, edit text" before the reader had typed anything (Field.tsx). `FieldBlock` is a `<div>` with an
 * explicit `htmlFor` and does neither.
 */

import { useMemo } from "react";

import {
  FORM_PROVIDER_LABELS,
  describeFormHosts,
  formEmbedSectionSchema,
  formHostAllowed,
  type FormEmbedProvider,
  type FormEmbedSectionData
} from "@/lib/sections/schema";
import { Field, FieldBlock } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { HelpText } from "@/components/studio/HelpText";
import type { SectionFormProps } from "@/components/studio/sections";

/** `.innerType()` because this schema is a `ZodEffects` — see the header and the schema's own note. */
const SHAPE = formEmbedSectionSchema.innerType().shape;

/** The picker's order, quietest route last: the three that can be framed, then the one that cannot. */
const PROVIDERS: readonly FormEmbedProvider[] = ["google", "microsoft", "typeform", "other"];

/** How tall the frame is, in words rather than pixels. Matches the schema's `height` enum. */
const HEIGHT_OPTIONS: readonly { value: FormEmbedSectionData["height"]; label: string }[] = [
  { value: "sm", label: "Short — a handful of questions" },
  { value: "md", label: "Medium — about a page of questions" },
  { value: "lg", label: "Tall — a full application form" },
  { value: "xl", label: "Very tall — a long form with sections" }
];

function isHeight(value: string): value is FormEmbedSectionData["height"] {
  return HEIGHT_OPTIONS.some((option) => option.value === value);
}

/** The hostname of an https address, or null while it is still being typed. */
function hostOf(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Which of the four this address plainly belongs to — for the "you have picked the wrong one" hint. */
function providerForHost(host: string): FormEmbedProvider | null {
  return (
    PROVIDERS.find((provider) => provider !== "other" && formHostAllowed(provider, host)) ?? null
  );
}

/**
 * The stored `provider`, read as the arbitrary string it can really be, and narrowed back to one of the
 * four — or `null` where this release has never heard of it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS IS NOT DEFENSIVE PADDING. IT IS THE ONE THING BETWEEN AN UNKNOWN PROVIDER AND A CRASHED PAGE
 * BUILDER, and taking the stored value as a `string` is what makes the COMPILER admit the miss is
 * possible.
 *
 * `data.provider` is TYPED `FormEmbedProvider`, so TypeScript believes every read of it is one of the
 * four. Both schema helpers this form calls then index `FORM_PROVIDER_HOSTS` — a `Record` keyed on that
 * same enum — with no guard of their own: `describeFormHosts` reads `.length` off the result
 * (lib/sections/schema.ts:1156-1157) and `formHostAllowed` reads `.some` (:1142). The type is wrong on
 * the builder's RECOVERY path — traced end to end rather than assumed:
 *
 *   • `provider` is `z.enum(FORM_PROVIDERS).default("google")` in lib/sections/schema.ts with NO
 *     `.catch()`, so a stored `"jotform"` — written by a newer deployment and read after a rollback, or
 *     arriving by import — fails the parse of the whole FORM_EMBED payload on its own. No other field
 *     need be wrong.
 *   • `normaliseSection` in components/studio/builder/PageBuilder.tsx then falls back to
 *     `repairSectionData`, which is `{ ...defaults, ...raw }` — a deliberately SHALLOW merge that DOES
 *     NOT PARSE. `raw.provider` therefore overwrites the default and survives verbatim. That fallback is
 *     right for what it is for: the editor has to SEE the wrong value in order to correct it.
 *   • `SectionEditorPanel` hands that working copy straight to this form — `data={value as …}`, and its
 *     `value` prop says "THE BUILDER'S RAW WORKING COPY, NOT A FRESHLY PARSED VALUE" in as many words.
 *
 * So `data.provider` really is `"jotform"` here. The old unguarded `describeFormHosts(data.provider)`
 * threw `TypeError: Cannot read properties of undefined (reading 'length')` on the FIRST render, before
 * the reader had touched anything — a client render error inside the page builder, which is a white
 * screen with an editor's unsaved work behind it and no way left to reach the block and correct it.
 *
 * THE THIRD INSTANCE OF ONE CRASH, and it is written out here so the three read as one decision:
 * `CENSUS_METRIC_DEFINITIONS[item.metric].label` in StatsForm.tsx (now `definitionFor()`) and
 * `PROVIDER_PATTERNS[data.provider].test(…)` in EmbedForm.tsx (now `PATTERN_FOR_PROVIDER`) were the first
 * two. All three read a table keyed on an enum with a value that had never been through the enum.
 *
 * ⚠ THE PARAMETER IS `string` ON PURPOSE AND MUST STAY. Narrowing it to `FormEmbedProvider` would make
 * the `?? null` look unreachable to the next reader AND to the compiler — which is exactly the false
 * guarantee this family of crashes grew out of. The RESULT being `| null` is what forces every read
 * below to say what happens when the service is one this build cannot speak for. It loosens no check:
 * `FORM_PROVIDER_HOSTS` is still `Record<FormEmbedProvider, …>` in the schema, so forgetting an entry
 * for a provider added there is still a compile error, in the file that owns it.
 *
 * ⚠ `PROVIDERS` IS A HAND-WRITTEN LIST, NOT A COMPILER-CHECKED ONE (the enum's own tuple,
 * `FORM_PROVIDERS`, is not exported). A fifth provider added to the schema and not added above would
 * therefore read as unknown here rather than crash — a degraded picker, which is the safe direction, but
 * add it above at the same time.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
function knownProvider(stored: string): FormEmbedProvider | null {
  return PROVIDERS.find((provider) => provider === stored) ?? null;
}

export function FormEmbedForm({ data, onChange, onDirty }: SectionFormProps<FormEmbedSectionData>) {
  const update = (patch: Partial<FormEmbedSectionData>) => {
    onChange({ ...data, ...patch });
    onDirty?.();
  };

  const url = data.url.trim();
  const hasUrl = url.length > 0;
  const host = hostOf(url);

  /**
   * The service this block is set to, where it is one this build knows — see `knownProvider`.
   *
   * ⚠ EVERY READ OF THE PROVIDER BELOW GOES THROUGH THIS ONE. A second read straight off `data.provider`
   * is the same crash again, because the type says four and the row can say anything.
   *
   * The two deliberate exceptions both need the RAW value rather than the narrowed one, and neither can
   * throw: the `<Select>`'s `value`, which is a controlled input and must not be handed a service this
   * form chose in place of the one the row holds; and the notice below, which quotes the unknown string
   * so the editor can see it. That notice is not decoration — the picker has no option matching an
   * unrecognised value, so without it this FORM never shows the editor what the row actually holds.
   */
  const provider = knownProvider(data.provider);

  /**
   * The schema's verdict on this exact payload, so the messages under the fields are the messages the save
   * would give. Asked for only when there is something that could be wrong.
   */
  const issues = useMemo(() => {
    if (!hasUrl) return { url: null, title: null };
    const result = formEmbedSectionSchema.safeParse(data);
    if (result.success) return { url: null, title: null };
    return {
      url: result.error.issues.find((issue) => issue.path[0] === "url")?.message ?? null,
      title: result.error.issues.find((issue) => issue.path[0] === "title")?.message ?? null
    };
  }, [data, hasUrl]);

  /**
   * "That is a Microsoft Forms address — change the service."
   *
   * The real mistake is almost always the picker rather than the address, and the schema's own refusal
   * names the hosts without being able to say which of the four the pasted one belongs to.
   *
   * Not offered at all where the stored service is one this build does not know: the notice under the
   * picker is the sentence that case needs, and "change the service to Typeform" alongside it would be
   * advice about the wrong problem.
   */
  const wrongProvider =
    hasUrl &&
    host !== null &&
    provider !== null &&
    provider !== "other" &&
    !formHostAllowed(provider, host)
      ? providerForHost(host)
      : null;

  return (
    <div className="space-y-5">
      <Field label="Which service the form is on" help={SHAPE.provider.description}>
        <Select
          value={data.provider}
          // ⚠ `choice`, not `provider`: this maps over `PROVIDERS` itself, so `FORM_PROVIDER_LABELS`
          // — `Record<FormEmbedProvider, string>` — cannot miss here, and naming it `provider` would
          // shadow the guarded value above with an unguarded one three lines from its warning.
          options={PROVIDERS.map((choice) => ({
            value: choice,
            label: FORM_PROVIDER_LABELS[choice]
          }))}
          onChange={(event) => update({ provider: event.target.value as FormEmbedProvider })}
        />
      </Field>

      {/*
        Always on screen, broken or not. See the header — and `knownProvider` for why the stored value has
        to be narrowed before either schema helper is called with it. The unknown branch QUOTES the value
        it found, and that is the point of it: the `<select>` above has no option matching "jotform", so
        the picker cannot show the editor what the row actually holds. ⚠ Nor does the panel's raw-payload
        readout help — it renders only where there is NO form for the block TYPE, and there is one for
        FORM_EMBED. The panel's validation banner does surface the value, as a schema error; this notice
        is what states it in the editor's own terms, beside the control that cannot display it.
      */}
      {provider === null ? (
        <HelpText tone="warn">
          This block is set to a service this version of the site does not know:{" "}
          <span className="font-mono">{data.provider}</span>. There is no list of accepted addresses for
          it, and the block will not save until you choose one of the four above.
        </HelpText>
      ) : (
        <HelpText>{describeFormHosts(provider)}</HelpText>
      )}

      {/* ⚠ `FieldBlock`, because of the link beside the box. See the header. */}
      <FieldBlock
        label="The address of the form"
        help={SHAPE.url.description}
        error={issues.url}
        maxLength={500}
        value={data.url}
      >
        <div className="min-w-0 space-y-2">
          <Input
            value={data.url}
            onChange={(event) => update({ url: event.target.value })}
            placeholder="https://docs.google.com/forms/d/e/…/viewform"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
            className="font-mono text-xs"
          />

          {hasUrl && host !== null ? (
            // A link, not a button, because it navigates — and the announcement matters: focus landing in
            // a new tab with no warning loses a reader their place and their Back button.
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-purple-700 underline underline-offset-2"
            >
              Open the form in a new tab to check it
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : null}
        </div>
      </FieldBlock>

      {wrongProvider ? (
        <HelpText tone="warn">
          That looks like a {FORM_PROVIDER_LABELS[wrongProvider]} address. Change the service above to{" "}
          {FORM_PROVIDER_LABELS[wrongProvider]} and it will be accepted as it is.
        </HelpText>
      ) : null}

      <WhereToFindIt provider={provider} />

      <Field
        label="What this form is for"
        help={SHAPE.title.description}
        // Asked for once there is a form to describe, and not before (contract §10). The message is the
        // schema's own — see the header.
        required={hasUrl}
        error={issues.title}
        maxLength={160}
        value={data.title}
      >
        <Textarea
          rows={2}
          value={data.title}
          onChange={(event) => update({ title: event.target.value })}
          placeholder="Application form for the summer block-printing workshop, closing on 14 August."
        />
      </Field>

      <Field
        label="What happens next"
        help={SHAPE.description.description}
        maxLength={320}
        value={data.description}
      >
        <Textarea
          rows={2}
          value={data.description}
          onChange={(event) => update({ description: event.target.value })}
          placeholder="We reply to every application by email within three weeks of the closing date."
        />
      </Field>

      {provider === "other" ? (
        // No height to choose: nothing is framed, so there is no frame to size. The control is ABSENT
        // rather than shown and ignored (contract §1.8).
        <HelpText tone="warn">
          A form on another service is not shown inside the page — it is offered as a link that opens in a
          new tab, because a page from an address we do not recognise must not be framed inside the
          Centre&rsquo;s own site. Everything else on this block still applies: the heading, the
          description, and the words on that link.
        </HelpText>
      ) : (
        <Field label="How tall the form is" help={SHAPE.height.description}>
          <Select
            value={data.height}
            options={HEIGHT_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(event) => {
              const next = event.target.value;
              if (isHeight(next)) update({ height: next });
            }}
          />
        </Field>
      )}

      <Field
        label="Words on the plain link"
        help={SHAPE.openInNewTabLabel.description}
        maxLength={60}
        value={data.openInNewTabLabel}
      >
        <Input
          value={data.openInNewTabLabel}
          onChange={(event) => update({ openInNewTabLabel: event.target.value })}
          placeholder="Open the application form in a new tab"
        />
      </Field>

      <HelpText>
        A form shown this way is still the service&rsquo;s own form: the answers go to that service and not
        into this studio, and whoever set it up there is the only person who can read them. The
        Centre&rsquo;s own contact form, whose messages arrive in the studio inbox, is the &ldquo;Contact
        form&rdquo; block instead.
      </HelpText>
    </div>
  );
}

/**
 * Where the address is, per service, in the words the buttons actually use.
 *
 * ⚠ THE ONE STEP EVERYBODY GETS WRONG IS SPELLED OUT: every one of these services opens its share dialog
 * on a tab that is NOT the address you want. Naming the tab is the difference between a paste that works
 * and twenty minutes of a form that will not appear.
 *
 * `null` — a stored service this build has never heard of, see `knownProvider` — falls to the last branch
 * with the rest. There is no share screen this release can describe for it, and the generic instruction is
 * true of every service there is.
 */
function WhereToFindIt({ provider }: { provider: FormEmbedProvider | null }) {
  if (provider === "google") {
    return (
      <HelpText>
        In Google Forms: open the form, press <span className="font-semibold">Send</span> at the top right,
        then choose the <span className="font-semibold">link tab</span> — the chain-link icon, which is the
        second of the three tabs and not the email one it opens on — and press{" "}
        <span className="font-semibold">Copy</span>. Paste that here. Leave{" "}
        <span className="font-semibold">Shorten URL</span> unticked if you can: the long address says which
        form it is, and a shortened one does not.
      </HelpText>
    );
  }

  if (provider === "microsoft") {
    return (
      <HelpText>
        In Microsoft Forms: open the form, press <span className="font-semibold">Collect responses</span>,
        and copy the link shown there. Check the setting above it first — a form set to your organisation
        only will ask every visitor to sign in, and most of them cannot.
      </HelpText>
    );
  }

  if (provider === "typeform") {
    return (
      <HelpText>
        In Typeform: open the form, press <span className="font-semibold">Share</span>, and copy the address
        under <span className="font-semibold">Share your typeform</span>. Each account has its own address,
        so it reads as your account name followed by typeform.com.
      </HelpText>
    );
  }

  return (
    <HelpText>
      Paste the address a visitor would use to open the form, exactly as the service gives it — starting
      with https://. Open it in a private window once to be sure it does not ask for a sign-in.
    </HelpText>
  );
}
