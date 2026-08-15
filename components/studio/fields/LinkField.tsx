"use client";

/**
 * LinkField and LinkDestinationField — where a button or a card goes.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE POINT OF THIS FIELD IS THAT AN ADDRESS TYPED BY HAND IS USUALLY WRONG.
 *
 * "/About", "/about-us", "/research/roadmap " — each of them looks right in a text box and each of them
 * is a "page not found" on a live site. Three answers, in this order:
 *
 *   1. IT SEARCHES THE SITE'S OWN PAGES. Typing "abo" offers "About the Centre — /about", and choosing
 *      it fills in the address that certainly exists. Picking a real page is faster than typing a path
 *      AND it is the only way to be sure.
 *   2. IT SAYS WHEN AN ADDRESS RESOLVES TO NOTHING. A path that is neither one of the site's built-in
 *      sections nor a page in the studio gets a warning here, at the moment it is typed, rather than a
 *      404 discovered by a visitor.
 *   3. IT VALIDATES THE SHAPE USING THE SCHEMA'S OWN RULE, so the message an editor reads is the same
 *      sentence the save would produce. Re-writing that message here would give the studio two
 *      opinions about one value, and the one on screen would be the one that is out of date.
 *
 * A path inside a section the CODE owns — `/news/something`, `/people/someone` — is DELIBERATELY not
 * flagged. Those addresses belong to records rather than to pages, so this component cannot verify them
 * and says so instead of guessing. A confident wrong answer is worse than an honest "not checked".
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `FieldBlock` FOR THE DESTINATION, `Field` FOR THE WORDS. The destination has suggestion buttons
 * beside it and a `<label>` wrapped round a button forwards stray clicks into it (Field.tsx); the words
 * are a plain input and get the stronger structural association.
 *
 * A LABEL AND AN ADDRESS ARE BOTH OPTIONAL, TOGETHER OR SEPARATELY, and that is the schema's decision
 * rather than an oversight: "typed the label, has not pasted the link yet" is two seconds of every
 * button's life and the studio autosaves during it (`cta()` in lib/sections/schema.ts). What this field
 * does instead is SAY which half is missing, because a button with only one half never renders.
 */

import { useId, useMemo, useState } from "react";
import { ArrowUpRight, ExternalLink, FileText, Mail, Phone, Search } from "lucide-react";

import { buildQuery } from "@/lib/client/fetcher";
import { useDebouncedValue, useResource } from "@/lib/client/useResource";
import { ctaSectionSchema } from "@/lib/sections/schema";
import { cn } from "@/lib/utils";
import { Field, FieldBlock, useFieldContext } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { HelpText } from "@/components/studio/HelpText";
import type { LookupResponse } from "@/components/studio/fields/EntityPicker";

/**
 * The schema's own link rule, reached through the CTA schema rather than restated.
 *
 * `cta()` wraps the pair in `.default({})`, so the default has to come off before the shape is
 * readable. The message this produces is the one `lib/sections/schema.ts` wrote for a non-technical
 * reader — there is deliberately no second copy of it in this file.
 */
const HREF_SCHEMA = ctaSectionSchema.shape.primaryCta.removeDefault().shape.href;

function hrefProblem(value: string): string | null {
  const result = HREF_SCHEMA.safeParse(value);
  if (result.success) return null;
  return result.error.issues[0]?.message ?? "That address cannot be used as a link.";
}

/**
 * Addresses the code owns, not the studio.
 *
 * These are real routes under `app/(site)/` and they have no `Page` row, so looking them up would
 * report every one of them as missing. Adding a route to the site means adding it here; the cost of
 * forgetting is a spurious warning, not a broken link, which is the right direction for the mistake to
 * fall in.
 */
const BUILT_IN_PATHS: readonly string[] = [
  "/",
  "/about",
  "/contact",
  "/craft-explorer",
  "/events",
  "/gallery",
  "/news",
  "/people",
  "/projects",
  "/publications",
  "/research",
  "/search"
];

/** The sections whose deeper addresses belong to records — `/news/<article>`, `/people/<person>`. */
const BUILT_IN_SECTIONS: readonly string[] = [
  "about",
  "craft-explorer",
  "events",
  "gallery",
  "news",
  "people",
  "projects",
  "publications",
  "research"
];

const SUGGEST_DEBOUNCE_MS = 250;
const SUGGEST_LIMIT = 6;

export interface LinkValue {
  label: string;
  href: string;
}

type LinkShape = "empty" | "internal" | "anchor" | "external" | "email" | "telephone";

function shapeOf(href: string): LinkShape {
  const value = href.trim();
  if (value.length === 0) return "empty";
  if (value.startsWith("#")) return "anchor";
  if (value.startsWith("/")) return "internal";
  if (value.startsWith("mailto:")) return "email";
  if (value.startsWith("tel:")) return "telephone";
  return "external";
}

/** The path without its query or fragment — what a page lookup can actually be asked about. */
function bareInternalPath(href: string): string {
  const trimmed = href.trim();
  const cut = trimmed.split(/[?#]/, 1)[0] ?? trimmed;
  if (cut.length === 0) return "/";
  // "/about/" and "/about" are the same page; the trailing slash is dropped so both verify.
  return cut.length > 1 && cut.endsWith("/") ? cut.slice(0, -1) : cut;
}

export interface LinkDestinationFieldProps {
  /** Defaults to "Where it goes". */
  label?: string;
  value: string;
  onChange: (next: string) => void;
  /** The schema's `.describe()` sentence for this address. */
  help?: string;
  /** A validation message from elsewhere — a failed save. Local shape problems are found here. */
  error?: string | null;
  /** Called with a page's title when one is chosen, so a caller can fill in an empty button label. */
  onPageChosen?: (page: { title: string; path: string }) => void;
  className?: string;
}

/** The address on its own, for the many payload fields that are a bare `href` with no words. */
export function LinkDestinationField({
  label = "Where it goes",
  value,
  onChange,
  help,
  error,
  onPageChosen,
  className
}: LinkDestinationFieldProps) {
  const shapeProblem = hrefProblem(value);
  const message = (typeof error === "string" && error.trim().length > 0 ? error : shapeProblem) ?? null;

  return (
    <FieldBlock label={label} help={help} error={message} className={className}>
      <LinkDestinationControl value={value} onChange={onChange} onPageChosen={onPageChosen} />
    </FieldBlock>
  );
}

function LinkDestinationControl({
  value,
  onChange,
  onPageChosen
}: Pick<LinkDestinationFieldProps, "value" | "onChange" | "onPageChosen">) {
  const field = useFieldContext();
  const [dismissedSuggestions, setDismissedSuggestions] = useState(false);
  const shape = shapeOf(value);

  /**
   * Suggestions only while the value could still be a page.
   *
   * A pasted `https://` address is not a search term, and searching for one would put a request on the
   * wire for every character of a URL nobody wants suggestions about.
   */
  const term = value.trim();
  const wantsSuggestions =
    !dismissedSuggestions && term.length > 0 && (shape === "internal" || !term.includes(":"));

  const suggestPath = useDebouncedValue(
    wantsSuggestions
      ? `/api/studio/lookup${buildQuery({ type: "page", q: term.replace(/^\//, ""), limit: SUGGEST_LIMIT })}`
      : "",
    SUGGEST_DEBOUNCE_MS
  );
  const suggestions = useResource<LookupResponse>(suggestPath.length > 0 ? suggestPath : null);

  /**
   * Verification, which is a different question from suggestion: "is there a page at exactly this
   * address". Only asked for a path that is neither built in nor inside a built-in section.
   */
  const bare = shape === "internal" ? bareInternalPath(value) : "";
  const firstSegment = bare.split("/")[1] ?? "";
  const isBuiltIn = BUILT_IN_PATHS.includes(bare);
  const insideBuiltInSection = !isBuiltIn && BUILT_IN_SECTIONS.includes(firstSegment);
  const verifiable = shape === "internal" && !isBuiltIn && !insideBuiltInSection;

  const verifyPath = useDebouncedValue(
    verifiable ? `/api/studio/lookup${buildQuery({ type: "page", path: bare })}` : "",
    SUGGEST_DEBOUNCE_MS
  );
  const verify = useResource<LookupResponse>(verifyPath.length > 0 ? verifyPath : null);

  const matchedPage = useMemo(() => {
    const items = Array.isArray(verify.data?.items) ? verify.data.items : [];
    return items[0] ?? null;
  }, [verify.data]);

  // Settled, succeeded, and not superseded — the same three conditions EntityPicker uses before it is
  // willing to call something missing.
  const verifySettled = verify.data !== null && !verify.isLoading && verify.error === null;
  const resolvesToNothing = verifiable && verifySettled && matchedPage === null;

  const suggestionItems = Array.isArray(suggestions.data?.items) ? suggestions.data.items : [];
  const visibleSuggestions = suggestionItems.filter((item) => item.path.length > 0 && item.path !== value);
  // A shortened list of suggestions says that it is shortened, like every other list in the studio
  // (contract §1.6) — otherwise the page somebody is looking for looks as though it does not exist.
  const suggestionTotal =
    typeof suggestions.data?.total === "number" ? suggestions.data.total : suggestionItems.length;
  const moreSuggestions = Math.max(0, suggestionTotal - suggestionItems.length);

  const choosePage = (page: { title: string; path: string }) => {
    onChange(page.path);
    // Stops the panel reopening for the value we have just written into the box.
    setDismissedSuggestions(true);
    onPageChosen?.(page);
  };

  return (
    <div className="min-w-0">
      <Input
        id={field?.controlId}
        value={value}
        onChange={(event) => {
          setDismissedSuggestions(false);
          onChange(event.target.value);
        }}
        icon={shape === "internal" || shape === "empty" ? Search : undefined}
        placeholder="Search for a page, or paste an address"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        inputMode="url"
        className="font-mono text-xs"
      />

      {wantsSuggestions && visibleSuggestions.length > 0 ? (
        <div className="mt-1.5 rounded-md border border-line-200 bg-card p-1 shadow-sm">
          <p className="px-2 py-1 text-xs text-ink-500">Pages on this site:</p>
          <ul>
            {visibleSuggestions.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => choosePage({ title: item.title, path: item.path })}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition hover:bg-purple-50"
                >
                  <FileText aria-hidden="true" className="h-4 w-4 shrink-0 text-ink-300" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink-900">{item.title}</span>
                    <span className="block truncate font-mono text-[0.6875rem] text-ink-500">
                      {item.path}
                    </span>
                  </span>
                  <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-purple-700" />
                </button>
              </li>
            ))}
          </ul>

          {moreSuggestions > 0 ? (
            <p className="px-2 py-1 text-xs leading-relaxed text-ink-500">
              {moreSuggestions === 1
                ? "One more page matches. Type more of its title to see it."
                : `${moreSuggestions} more pages match. Type more of the title to narrow it down.`}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* What this address actually is, in one line, so nobody has to read the syntax to know. */}
      <LinkExplanation
        shape={shape}
        bare={bare}
        isBuiltIn={isBuiltIn}
        insideBuiltInSection={insideBuiltInSection}
        // Only once the check has settled: `useResource` keeps the previous answer while the next request
        // runs, and reporting the last path's title against the one being typed is a confident wrong
        // answer.
        matchedTitle={verifySettled ? (matchedPage?.title ?? null) : null}
        resolvesToNothing={resolvesToNothing}
      />
    </div>
  );
}

function LinkExplanation({
  shape,
  bare,
  isBuiltIn,
  insideBuiltInSection,
  matchedTitle,
  resolvesToNothing
}: {
  shape: LinkShape;
  bare: string;
  isBuiltIn: boolean;
  insideBuiltInSection: boolean;
  matchedTitle: string | null;
  resolvesToNothing: boolean;
}) {
  if (resolvesToNothing) {
    return (
      <HelpText tone="warn" className="mt-2">
        There is no page at <span className="font-mono font-semibold">{bare}</span>. Anyone following
        this link will see a “page not found”. Search for the page above, or create it first.
      </HelpText>
    );
  }

  if (shape === "empty") return null;

  if (shape === "internal") {
    if (matchedTitle !== null) {
      return (
        <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-success-600">
          <FileText aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Goes to <span className="font-semibold">{matchedTitle}</span> on this site.
          </span>
        </p>
      );
    }
    if (isBuiltIn) {
      return (
        <HelpText className="mt-2">
          One of the site&rsquo;s own sections. This address always exists.
        </HelpText>
      );
    }
    if (insideBuiltInSection) {
      return (
        <HelpText className="mt-2">
          This points at a single item inside{" "}
          <span className="font-mono">/{bare.split("/")[1] ?? ""}</span>. It cannot be checked from
          here, so open it once to be sure it works.
        </HelpText>
      );
    }
    return null;
  }

  if (shape === "anchor") {
    return (
      <HelpText className="mt-2">
        Jumps to a named part of the same page. The name has to match the one set on that block.
      </HelpText>
    );
  }

  if (shape === "email") {
    return (
      <HelpText className="mt-2" icon={Mail}>
        Opens the reader&rsquo;s email program with a new message to this address.
      </HelpText>
    );
  }

  if (shape === "telephone") {
    return (
      <HelpText className="mt-2" icon={Phone}>
        Dials this number on a phone. On a computer it usually does nothing, so give the number in the
        text as well.
      </HelpText>
    );
  }

  return (
    <HelpText className="mt-2" icon={ExternalLink}>
      Goes to another website. It opens in a new tab, and the reader is told so.
    </HelpText>
  );
}

export interface LinkFieldProps {
  /** The group's name — "Main button", "Second button". */
  label: string;
  value: LinkValue;
  onChange: (next: LinkValue) => void;
  /** The schema's `.describe()` for the words. */
  labelHelp?: string;
  /** The schema's `.describe()` for the address. */
  hrefHelp?: string;
  /** The schema's `.max()` for the words, so the counter and the enforcement agree. Default 40. */
  labelMaxLength?: number;
  /** What the words field is called. Default "Words on the button". */
  labelFieldLabel?: string;
  className?: string;
}

/**
 * The pair — words and destination — as one visibly grouped control.
 *
 * `role="group"` with `aria-labelledby` rather than a heading: this sits inside a form whose heading
 * ranks belong to the screen around it, and a group name is not a document heading. A `<fieldset>`
 * would do the same job and brings its own layout quirks in a flex column.
 */
export function LinkField({
  label,
  value,
  onChange,
  labelHelp,
  hrefHelp,
  labelMaxLength = 40,
  labelFieldLabel = "Words on the button",
  className
}: LinkFieldProps) {
  // `useId`, never a random string: an id generated with `Math.random` differs between the server's
  // render and the browser's and React reports a hydration mismatch on the attribute.
  const groupId = `${useId()}link-group`;

  const hasLabel = value.label.trim().length > 0;
  const hasHref = value.href.trim().length > 0;
  const halfFinished = hasLabel !== hasHref;

  return (
    <div
      role="group"
      aria-labelledby={groupId}
      className={cn("rounded-md border border-line-200 bg-surface-50 p-3", className)}
    >
      <span id={groupId} className="field-label">
        {label}
      </span>

      <div className="mt-2 space-y-3">
        <Field
          label={labelFieldLabel}
          help={labelHelp}
          maxLength={labelMaxLength}
          value={value.label}
        >
          <Input
            value={value.label}
            onChange={(event) => onChange({ ...value, label: event.target.value })}
            placeholder="Read the report"
          />
        </Field>

        <LinkDestinationField
          value={value.href}
          help={hrefHelp}
          onChange={(href) => onChange({ ...value, href })}
          // Filling in an empty label from the chosen page saves the commonest double entry there is.
          // It never overwrites words somebody has already written.
          onPageChosen={(page) =>
            onChange({ href: page.path, label: hasLabel ? value.label : page.title })
          }
        />

        {halfFinished ? (
          <HelpText tone="warn">
            {hasLabel
              ? "This button has words but nowhere to go, so it will not appear on the page. Add an address, or clear the words to leave it out on purpose."
              : "This button has an address but no words, so it will not appear on the page. Add the words that should be on it."}
          </HelpText>
        ) : null}
      </div>
    </div>
  );
}
