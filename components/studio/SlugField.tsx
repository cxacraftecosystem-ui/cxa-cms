"use client";

/**
 * SlugField — the web-address field, and the four things it has to get right.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * 1. IT STOPS FOLLOWING THE TITLE THE MOMENT THE READER TOUCHES IT.
 *
 * While the field is untouched it derives from the title on every keystroke, which is what makes a new
 * record a single field to fill in. The instant somebody edits the address themselves it stops, for
 * good, and nothing the title does afterwards moves it. An auto-address that keeps overwriting a
 * hand-picked one is maddening in a specific way: the reader types the address they want, goes back to
 * fix a typo in the title, and watches their address silently revert. "Use the title" is the way back,
 * and it is a button they press — never something that happens to them.
 *
 * An item that arrives WITH an address is treated as already chosen, so opening an existing record and
 * editing its title never touches its published address.
 *
 * 2. IT SHOWS THE WHOLE RESULTING ADDRESS. Not the fragment being typed — the address a reader will
 * see in their browser and a citation will record. A field that shows "bagru-dyeing" and nothing else
 * asks the reader to imagine the rest.
 *
 * 3. CHANGING A PUBLISHED ADDRESS BREAKS EVERY EXISTING LINK, AND IT SAYS SO — then offers to create a
 * redirect, which is the only thing that actually fixes it. `Redirect` exists in the schema for
 * precisely this: "so moving a page never has to break an existing citation".
 *
 * 4. IT EXPLAINS THE WORD. An administrator does not know what a "slug" is and should never have to;
 * the label is "Web address" and the help sentence says what the thing is in plain words. The term
 * does not appear anywhere a reader can see it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * TYPED TEXT IS TIDIED LIVE, BUT ONLY TIDIED PROPERLY ON BLUR. Running the full `slugify()` on every
 * keystroke makes the field unusable: `slugify` strips a trailing hyphen, so typing "bagru-" deletes
 * the hyphen and "bagru-dyeing" can never be reached; and accented letters have to be normalised as
 * whole words ("Café" decomposes to "cafe", but strip the é one keystroke early and you get "caf").
 * So while typing it only lowercases and turns spaces into hyphens, and `slugify()` runs when the
 * reader leaves the field.
 *
 * `FieldBlock`, NOT `Field`. There is a `<button>` and a checkbox in here, and a `<label>` wrapped
 * around a button forwards stray clicks into it and folds its name into the input's accessible name
 * (Field.tsx). This is exactly the case the two wrappers exist to separate.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { WandSparkles } from "lucide-react";

import { cn, slugify } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { FieldBlock } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { HelpText } from "@/components/studio/HelpText";

/** `slugify()` truncates at 96 characters, so the counter and the enforcement agree by construction. */
const MAX_SLUG_LENGTH = 96;

export interface SlugRedirectOffer {
  /** Whether the reader has accepted the offer. Controlled by the caller — it is form state. */
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
}

export interface SlugFieldProps {
  /** The address fragment, with no slashes around it. `""` is legal only when `allowEmpty`. */
  value: string;
  onChange: (next: string) => void;
  /** The title the address is derived from while the reader has not chosen one. */
  source: string;
  /**
   * What comes before the fragment, with BOTH slashes: "/publications/". For a CMS page whose slug is
   * the whole path this is just "/".
   */
  basePath: string;
  /**
   * The site's own address without a trailing slash — "https://coe.example.ac.in". Omit it and the
   * preview shows the path alone, which is still useful but less concrete.
   */
  siteUrl?: string;
  /**
   * The address as it is STORED. Supplying it is what lets the component tell a change from a first
   * draft, which is the whole basis of the published-link warning.
   */
  originalValue?: string;
  /** True when the item is live on the public site. Drives the warning and the redirect offer. */
  isPublished?: boolean;
  /** Omit to hide the redirect offer — for a model with no redirect support. */
  redirect?: SlugRedirectOffer;
  /**
   * Forces the derive-from-title behaviour on (`true`) or off (`false`). Left undefined, it is on
   * while the field starts empty and off otherwise — see the header.
   */
  autoDerive?: boolean;
  /**
   * Allows `/` inside the value, for a `Page` whose address IS the whole path ("research/roadmap").
   * Each segment is tidied separately so the slashes survive.
   */
  allowSlashes?: boolean;
  /** An empty address is legal — the CMS homepage is the page whose address is empty. */
  allowEmpty?: boolean;
  /** The validation message from the server (a duplicate address). Empty and null both mean no error. */
  error?: string | null;
  required?: boolean;
  /** Default "Web address". Change it only if the screen calls it something else. */
  label?: string;
  className?: string;
}

/**
 * The live tidy: lower case, spaces to hyphens, nothing else. See the header for why this is not
 * `slugify()`.
 */
function tidyWhileTyping(input: string, allowSlashes: boolean): string {
  const collapsed = input.toLowerCase().replace(/\s+/g, "-");
  return allowSlashes ? collapsed : collapsed.replace(/\//g, "-");
}

/** The real tidy, on blur and on "Use the title". Applied per segment so a page's slashes survive. */
function normalise(input: string, allowSlashes: boolean): string {
  if (!allowSlashes) return slugify(input);
  return input
    .split("/")
    .map((segment) => slugify(segment))
    .filter((segment) => segment.length > 0)
    .join("/");
}

export function SlugField({
  value,
  onChange,
  source,
  basePath,
  siteUrl,
  originalValue,
  isPublished = false,
  redirect,
  autoDerive,
  allowSlashes = false,
  allowEmpty = false,
  error,
  required = false,
  label = "Web address",
  className
}: SlugFieldProps) {
  const uid = useId();
  const previewId = `${uid}preview`;

  /**
   * `true` means "the reader owns this address; leave it alone".
   *
   * Seeded from whether there IS one already: an existing record's address must never be rewritten by
   * a title edit, and a brand-new record's should follow the title until somebody says otherwise.
   */
  const [touched, setTouched] = useState(() => autoDerive ?? value.trim().length > 0);
  const deriving = autoDerive === false ? false : !touched;

  // The derive effect must read the CURRENT value and callback without listing either as a dependency,
  // or every keystroke in the title would re-run against a stale closure — or worse, re-derive on a
  // render where only `onChange`'s identity changed. Both refs are written in an effect, never during
  // render: a render can be discarded under concurrent rendering, and a ref written on a discarded
  // render leaves this reading state that never committed.
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    if (!deriving) return;
    const derived = normalise(source, allowSlashes);
    if (derived === valueRef.current) return;
    onChangeRef.current(derived);
  }, [deriving, source, allowSlashes]);

  const handleTyping = useCallback(
    (raw: string) => {
      // Any keystroke in this field is the reader taking ownership of the address.
      setTouched(true);
      onChange(tidyWhileTyping(raw, allowSlashes));
    },
    [allowSlashes, onChange]
  );

  const handleBlur = useCallback(() => {
    const tidy = normalise(value, allowSlashes);
    if (tidy !== value) onChange(tidy);
  }, [allowSlashes, onChange, value]);

  const useTitle = useCallback(() => {
    // Pressing this hands the address back to the title, and it keeps following until the reader
    // edits it again. They asked for it explicitly, so resuming is not a surprise.
    setTouched(false);
    const derived = normalise(source, allowSlashes);
    if (derived !== value) onChange(derived);
  }, [allowSlashes, onChange, source, value]);

  const derivedFromTitle = useMemo(() => normalise(source, allowSlashes), [source, allowSlashes]);
  const canUseTitle = derivedFromTitle.length > 0 && derivedFromTitle !== value;

  const trimmedBase = basePath.endsWith("/") ? basePath : `${basePath}/`;
  const origin = siteUrl?.replace(/\/+$/, "") ?? "";
  // The new address is assembled in the preview below rather than here, so the slug itself can be
  // emphasised inside it. Only the OLD one needs to exist as a whole string — it goes into a sentence.
  const oldUrl = originalValue === undefined ? null : `${origin}${trimmedBase}${originalValue}`;

  const addressChanged =
    originalValue !== undefined && originalValue.length > 0 && value !== originalValue;
  const warnAboutLinks = isPublished && addressChanged;

  const isEmpty = value.trim().length === 0;

  return (
    <div className={cn("min-w-0", className)}>
      <FieldBlock
        label={label}
        required={required}
        error={error}
        maxLength={MAX_SLUG_LENGTH}
        value={value}
        help={
          <>
            The last part of the web address, in lower case with hyphens instead of spaces. People see
            it in their browser and a citation records it, so keep it short and readable.
            {allowSlashes ? (
              <> A slash puts this page underneath another one — “research/roadmap”.</>
            ) : null}
          </>
        }
      >
        <div className="flex flex-wrap items-start gap-2">
          <Input
            value={value}
            onChange={(event) => handleTyping(event.target.value)}
            onBlur={handleBlur}
            // Autocorrect and autocapitalise both fight a lower-case-only field on a phone, and a
            // browser's saved-address suggestions have nothing useful to offer here.
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
            placeholder={allowEmpty ? "(leave empty for the homepage)" : "bagru-dyeing"}
            className="min-w-0 flex-1 font-mono text-xs"
          />

          {canUseTitle ? (
            <Button variant="secondary" size="sm" icon={WandSparkles} onClick={useTitle}>
              Use the title
            </Button>
          ) : null}
        </div>

        {/*
          The resulting address, restated in full.

          NOT wired into the field's `aria-describedby`, on purpose: it changes on every keystroke, and
          a description that is re-read after each character talks over the typing it is describing.
          It is ordinary text inside the form, so a screen-reader user reading down the page still
          reaches it.
        */}
        <p id={previewId} className="mt-2 break-all font-mono text-[0.6875rem] leading-relaxed text-ink-500">
          {isEmpty && allowEmpty ? (
            <>
              {origin.length > 0 ? origin : trimmedBase} <span className="text-ink-700">— the homepage</span>
            </>
          ) : (
            <>
              {origin}
              {trimmedBase}
              <span className="font-semibold text-ink-900">{isEmpty ? "…" : value}</span>
            </>
          )}
        </p>
      </FieldBlock>

      {/*
        Mounted in BOTH states so the live region is registered before its content ever changes — a
        region inserted at the same instant as its text is announced inconsistently (the same pattern
        as Field.tsx's character-limit notice). It holds one sentence that appears exactly once, when
        the reader changes the address of something that is already public.
      */}
      <span role="status" className="sr-only">
        {warnAboutLinks
          ? "Changing this address will break existing links to this item. A redirect can be created."
          : ""}
      </span>

      {warnAboutLinks ? (
        <div className="mt-3 space-y-2">
          <HelpText tone="warn">
            This is published at <span className="break-all font-semibold">{oldUrl}</span>. Changing the
            address breaks every existing link, bookmark and citation pointing at the old one — those
            visitors will see a “page not found”.
          </HelpText>

          {redirect ? (
            <Checkbox
              checked={redirect.enabled}
              onCheckedChange={redirect.onEnabledChange}
              label="Send the old address to the new one"
              description="Anyone following an old link is taken to the new address instead of a “page not found”. Leave this on unless you have a reason not to."
              className="ml-1"
            />
          ) : null}
        </div>
      ) : null}

      {isEmpty && !allowEmpty ? (
        <HelpText tone="warn" className="mt-3">
          An address is needed before this can be saved. It is usually the title with hyphens instead of
          spaces.
        </HelpText>
      ) : null}
    </div>
  );
}
