/**
 * Safe hrefs — THE one rule for "is this link internal, external, or not a link at all".
 *
 * Every place that turns stored text into an `href` or a `Location` reads it from here: the rich-text
 * editor and renderer, the MDX renderer, navigation, the footer, every section block, the redirect
 * table, the studio link fields and the server-side validators that guard each of them on save. Before
 * this module there were more than a dozen copies of `href.startsWith("/")`, and every one of them
 * called `//evil.example` internal.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY "STARTS WITH /" IS NOT "ON THIS SITE"
 *
 *  • `//evil.example` is a protocol-relative URL: a browser resolves it to another HOST.
 *  • `/\evil.example` is the same thing in disguise — the WHATWG parser reads `\` as `/` in http(s).
 *  • `/\t/evil.example` and `/\n/evil.example` survive a "second character is not a slash" test, and
 *    then the parser STRIPS the tab or newline and resolves `//evil.example`. Leading C0 controls and
 *    spaces are stripped the same way, which is how ` javascript:` and `java\tscript:` get past a
 *    scheme check that looks at the raw string.
 *  • `/%2F%2Fevil.example` is harmless in an `<a>`, but anything that decodes before redirecting (a
 *    proxy, a framework router, a CDN rule) turns it into `//evil.example`. The same is true deeper in
 *    the path: `/a/..%2F..%2F/evil.example` decodes to `/a/../..//evil.example`, which normalises to
 *    `//evil.example` — so the encoded-separator and dot-segment checks apply to EVERY segment.
 *
 * Rendered through `next/link`, every one of those looks like an internal link and leaves the site.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE RULE, after removing ASCII control characters and trimming:
 *
 *  • internal   — exactly one leading `/`, followed by nothing or by a character that is not `/` or `\`,
 *                 and in which NO SEGMENT, percent-decoded (repeatedly), holds a `/`, `\` or control
 *                 character or is a dot segment (`.`, `..`).
 *  • same-page  — `#anchor` or `?query`. Cannot leave the document, let alone the origin.
 *  • external   — `http://` or `https://` that `new URL()` parses, with a host.
 *  • contact    — `mailto:` or `tel:`.
 *  • relative   — no scheme and no leading slash (`about`, `example.org`). Resolves on this origin, but
 *                 is almost never what was meant, so it is refused unless a caller opts in (rich text
 *                 keeps it, because its editor already offers to fix it).
 *  • unsafe     — everything else: `javascript:`, `data:`, `vbscript:`, any other scheme, `//`, `/\`,
 *                 any backslash anywhere, an encoded slash, backslash or control in any segment, a dot
 *                 segment (plain or encoded) anywhere, malformed percent-encoding in the first segment as
 *                 written (`/%zz`, `/100%`; `/100%25` is a correctly encoded `%` and is internal),
 *                 `https:` without `//`, an http(s) URL that does not parse.
 *
 * ZERO IMPORTS, NO `process.env`, NO DOM. It is imported by client components, route handlers, Zod
 * schemas and plain Node scripts alike (see lib/utils.ts for why that third kind of caller matters).
 */

export type SafeHrefKind =
  /** Nothing there. */
  | "empty"
  /** `/research` — a path on this site. */
  | "internal"
  /** `#method`, `?page=2` — this document. */
  | "same-page"
  /** An absolute http(s) URL. */
  | "external"
  /** `mailto:` or `tel:`. */
  | "contact"
  /** `example.org/page` — no scheme, no slash; a browser resolves it against the current page. */
  | "relative"
  /** Not a link. Render the words as plain text; refuse it on save. */
  | "unsafe";

export interface ClassifiedHref {
  kind: SafeHrefKind;
  /**
   * The href to emit: control characters removed and trimmed, otherwise as written. For an absolute
   * URL on `siteHost` (see `ClassifyOptions`) it is the path, query and hash only. Empty for `unsafe`,
   * so a caller that forgets to check `kind` still cannot emit the dangerous value.
   */
  href: string;
}

export interface ClassifyOptions {
  /**
   * This site's host (`cxa.example.org`). An absolute URL on it is reported as `internal`, with the
   * href reduced to path + query + hash — but only when that path is itself a safe internal path, so
   * `https://cxa.example.org//evil.example` stays external rather than becoming `//evil.example`.
   */
  siteHost?: string | null;
}

/** Which kinds a caller accepts. Defaults: internal, same-page, external and contact; not relative. */
export interface HrefPolicy {
  samePage?: boolean;
  external?: boolean;
  contact?: boolean;
  relative?: boolean;
}

/** C0 controls and DEL. The URL parser strips tab/LF/CR anywhere and C0 + space at either end. */
const ASCII_CONTROL = /[\u0000-\u001F\u007F]/g;
const HAS_ASCII_CONTROL = /[\u0000-\u001F\u007F]/;
/** A URL scheme as the WHATWG parser reads one: a letter, then letters, digits, `+`, `-`, `.`. */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
/** `http://x` or `https://x` — the two slashes are required and the host must follow them directly. */
const HTTP_WITH_AUTHORITY = /^https?:\/\/[^/\\]/i;
/** How many rounds of percent-decoding a segment gets. Double-encoding is the usual trick. */
const MAX_DECODE_ROUNDS = 4;

const UNSAFE: ClassifiedHref = Object.freeze({ kind: "unsafe", href: "" }) as ClassifiedHref;

/**
 * The value as a browser would see it: every ASCII control character removed, then trimmed.
 *
 * Removing rather than refusing is right for RENDERING (the browser would have removed them too, so
 * classifying the cleaned form classifies what will actually be followed). Validators refuse them
 * outright instead — see `isStorableHref`.
 */
export function cleanHref(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(ASCII_CONTROL, "").trim();
}

/**
 * Is this a path on this site that no parser, router or redirect can turn into another host?
 *
 * Expects an already-cleaned value; `classifyHref` is the entry point for anything typed or stored.
 */
export function isSafeSitePath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (path.includes("\\") || HAS_ASCII_CONTROL.test(path)) return false;
  const second = path.charAt(1);
  if (second === "/") return false;

  const segments = (path.slice(1).split(/[?#]/, 1)[0] ?? "").split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const raw = segments[index] ?? "";
    // Malformed percent-encoding in the FIRST segment AS WRITTEN: no legitimate page is named like that,
    // and a lenient decoder somewhere downstream may read it differently from a strict one. ONE strict
    // round only: `/100%25` (a correctly encoded literal `%`) decodes to `100%`, and a second strict
    // round would throw on that and refuse a legitimate path — round two did exactly that, while the same
    // text further along (`/search/100%25`) was accepted. Double-encoded tricks (`%252F`) are caught
    // below by the lenient loop, which keeps decoding. Further along (`/search/100%`) malformed escapes
    // are allowed — but the checks below still read the segment the way a LENIENT decoder would, so
    // `..%2F%zz` cannot hide an encoded slash behind one bad escape.
    if (index === 0 && !isWellFormedPercentEncoding(raw)) return false;
    const segment = decodeSegmentLeniently(raw);
    // A dot segment, plain or encoded (`.`, `..`, `%2e`, `.%2E`), in ANY position. The URL parser folds
    // them away, so `/.//evil.example` or `/a/..//evil.example` normalises to a pathname of
    // `//evil.example` — harmless as an `<a href>` on this origin, but a protocol-relative URL the moment
    // anything reuses `new URL(x).pathname` as an href or a `Location`. No page here is named `.` or `..`.
    if (segment === "." || segment === "..") return false;
    // An encoded `/`, `\` or control character in ANY segment. `/a/..%2F..%2F/evil.example` and
    // `/a/%2e%2e%2f%2e%2e%2f/evil.example` pass a dot-segment test (`..%2F` is not `..`), yet ONE decode
    // gives `/a/../..//evil.example`, which normalises to `//evil.example`. That is the "anything that
    // decodes before redirecting" threat in the header, and it is not confined to the first segment.
    if (/[/\\\u0000-\u001F\u007F]/.test(segment)) return false;
  }
  return true;
}

/** Does one strict `decodeURIComponent` accept this segment as written? (One round — see `isSafeSitePath`.) */
function isWellFormedPercentEncoding(raw: string): boolean {
  try {
    decodeURIComponent(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * A path segment as the most lenient decoder would read it: every well-formed `%XX` that encodes an
 * ASCII byte is decoded, repeatedly, and anything else (`%zz`, a lone `%`, a UTF-8 byte) is left as
 * written. Never throws. Only used to look for separators, controls and dot segments, all ASCII.
 */
function decodeSegmentLeniently(raw: string): string {
  let segment = raw;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    const decoded = segment.replace(/%([0-7][0-9a-f])/gi, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    );
    if (decoded === segment) break;
    segment = decoded;
  }
  return segment;
}

/** Is this an absolute http(s) URL with a host, written with `//`, that `new URL()` accepts? */
function isAbsoluteHttpUrl(href: string): URL | null {
  if (!HTTP_WITH_AUTHORITY.test(href)) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url;
  } catch {
    return null;
  }
}

/** Decide what kind of link a stored or typed href is. Never throws. */
export function classifyHref(raw: unknown, options: ClassifyOptions = {}): ClassifiedHref {
  const href = cleanHref(raw);
  if (href.length === 0) return { kind: "empty", href };

  // A backslash is a slash to the URL parser in http(s), and no legitimate destination needs one.
  if (href.includes("\\")) return UNSAFE;

  if (href.startsWith("#") || href.startsWith("?")) return { kind: "same-page", href };
  if (href.startsWith("/")) return isSafeSitePath(href) ? { kind: "internal", href } : UNSAFE;

  const scheme = SCHEME.exec(href)?.[1]?.toLowerCase();
  if (!scheme) return { kind: "relative", href };

  if (scheme === "mailto" || scheme === "tel") {
    return href.length > scheme.length + 1 ? { kind: "contact", href } : UNSAFE;
  }
  if (scheme !== "http" && scheme !== "https") return UNSAFE;

  const url = isAbsoluteHttpUrl(href);
  if (!url) return UNSAFE;

  const siteHost = options.siteHost?.trim().toLowerCase();
  if (siteHost && url.host.toLowerCase() === siteHost) {
    const local = `${url.pathname}${url.search}${url.hash}`;
    if (isSafeSitePath(local)) return { kind: "internal", href: local };
  }
  return { kind: "external", href };
}

function allowedBy(kind: SafeHrefKind, policy: HrefPolicy): boolean {
  switch (kind) {
    case "internal":
      return true;
    case "same-page":
      return policy.samePage ?? true;
    case "external":
      return policy.external ?? true;
    case "contact":
      return policy.contact ?? true;
    case "relative":
      return policy.relative ?? false;
    default:
      return false;
  }
}

/**
 * The href to put in an attribute, or null when there must be no link at all.
 *
 * Use this at every RENDER site: a null means "draw the words, not an anchor".
 */
export function safeHref(raw: unknown, policy: HrefPolicy = {}, options: ClassifyOptions = {}): string | null {
  const classified = classifyHref(raw, options);
  return allowedBy(classified.kind, policy) ? classified.href : null;
}

/** Will this href route on this site — a safe path, an anchor or a query? (`next/link` territory.) */
export function isInternalHref(raw: unknown): boolean {
  const kind = classifyHref(raw).kind;
  return kind === "internal" || kind === "same-page";
}

/** Is this an absolute http(s) URL that parses? */
export function isExternalHref(raw: unknown): boolean {
  return classifyHref(raw).kind === "external";
}

/** The href of an absolute http(s) URL (a publisher link, a partner's website), or null for anything else. */
export function safeExternalHref(raw: unknown): string | null {
  const classified = classifyHref(raw);
  return classified.kind === "external" ? classified.href : null;
}

/**
 * The SAVE-TIME rule, for Zod `.refine()` and server actions.
 *
 * Stricter than rendering in one way: a value carrying ASCII control characters anywhere is refused
 * rather than cleaned, because the only reason to type a tab inside a URL is to smuggle something past
 * a check. Empty is NOT accepted here — a schema that allows "no link yet" says so itself.
 */
export function isStorableHref(raw: unknown, policy: HrefPolicy = {}): boolean {
  if (typeof raw !== "string") return false;
  if (HAS_ASCII_CONTROL.test(raw.trim())) return false;
  return allowedBy(classifyHref(raw).kind, policy);
}

// ─────────────────────────────────────────────────────────────────────────────
// Blur placeholders — a data URL that ends up inside CSS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The only shape a blur placeholder may have: a base64 raster image. Nothing else is accepted, not even
 * `data:image/svg+xml` — see `safeBlurDataUrl`.
 */
const SAFE_BLUR_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

/** Far above what the derivative pipeline writes (a 16px WebP, under a kilobyte). */
export const MAX_BLUR_DATA_URL_LENGTH = 32_768;

/**
 * A blur placeholder that may be handed to next/image as `blurDataURL`, or null.
 *
 * ⚠ NOT A COSMETIC CHECK. next/image writes `blurDataURL` UNESCAPED inside
 * `background-image:url("data:image/svg+xml,…href='<blurDataURL>'…")` in the `<img>` style attribute.
 * A rich-text image node carries this value as an attribute an author can set, and a value such as
 * `data:x");position:fixed;inset:0;background:url(https://evil.example/beacon);x:url("` closed the CSS
 * string and turned every visitor's copy of the page into a full-viewport overlay that fetched a
 * third-party URL. "Starts with `data:`" was the whole check. The base64 alphabet cannot hold a quote,
 * a parenthesis, a semicolon or whitespace, so a value that matches cannot leave the string it is in.
 */
export function safeBlurDataUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_BLUR_DATA_URL_LENGTH) return null;
  return SAFE_BLUR_DATA_URL.test(value) ? value : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rich text — every link mark (and blur placeholder) in a stored document
// ─────────────────────────────────────────────────────────────────────────────

/**
 * More entries than any document the editor can produce (a long article is a few thousand). A document
 * past it is REFUSED, not half-checked — see `unsafeRichTextHrefs`.
 */
export const MAX_RICH_TEXT_NODES = 50_000;

/**
 * What `unsafeRichTextHrefs` reports for a document too large to walk to the end. It is not an href; it
 * is there so the list is never empty for a document nobody has finished checking.
 */
export const RICH_TEXT_TOO_LARGE = "[document too large to check]";

/** The prefix `unsafeRichTextHrefs` puts before a refused image `blurDataUrl`, which is not an href. */
export const BLUR_DATA_URL_LABEL = "[image blurDataUrl] ";

/**
 * Every link href in a Tiptap/ProseMirror document that the save-time rule refuses — and every node
 * `blurDataUrl` that `safeBlurDataUrl` refuses, reported as `BLUR_DATA_URL_LABEL` + the value's start.
 * (The editor only ever copies that attribute from a media row, so a refused one was hand-crafted.)
 *
 * Walks the raw JSON rather than `parseRichText()`'s output on purpose: the validator must see exactly
 * what will be stored, and this module may not import lib/richtext.ts (zero imports, see the header).
 * A JSON string holding a document — which `parseRichText()` also accepts — is unwrapped first.
 * Bare relative hrefs are allowed, because the editor's LinkDialog offers them (with a suggestion).
 *
 * ⚠ IT FAILS CLOSED. It used to stop at the node limit and return what it had found so far, so a link
 * to `//evil.example` followed by fifty thousand zeros (about 100 KB of JSON) was reported as clean.
 * Every entry pushed is counted — arrays and scalars included, before anything is popped — and a
 * document that crosses the limit reports `RICH_TEXT_TOO_LARGE`, which makes `richTextLinksAreSafe`
 * false.
 */
export function unsafeRichTextHrefs(value: unknown): string[] {
  let root = value;
  if (typeof root === "string") {
    try {
      root = JSON.parse(root) as unknown;
    } catch {
      return [];
    }
  }

  const found: string[] = [];
  const stack: unknown[] = [root];
  let seen = 1;
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      seen += node.length;
      if (seen > MAX_RICH_TEXT_NODES) return [...found, RICH_TEXT_TOO_LARGE];
      for (const entry of node) stack.push(entry);
      continue;
    }
    if (node === null || typeof node !== "object") continue;
    const record = node as Record<string, unknown>;
    if (record.attrs && typeof record.attrs === "object") {
      const attrs = record.attrs as Record<string, unknown>;
      if (record.type === "link") {
        const href = attrs.href;
        if (typeof href === "string" && href.trim().length > 0 && !isStorableHref(href, { relative: true })) {
          found.push(href);
        }
      }
      // Any node, not only `image`: the value reaches CSS wherever a renderer reads it (see
      // `safeBlurDataUrl`), and a node type renamed tomorrow must not carry it past this check.
      const blur = attrs.blurDataUrl;
      if (blur !== undefined && blur !== null && !(typeof blur === "string" && blur.trim().length === 0)) {
        if (safeBlurDataUrl(blur) === null) found.push(`${BLUR_DATA_URL_LABEL}${String(blur).slice(0, 80)}`);
      }
    }
    if (Array.isArray(record.content)) stack.push(record.content);
    if (Array.isArray(record.marks)) stack.push(record.marks);
  }
  return found;
}

/** For `.refine()`: true when no link in the document would be refused. Absent and null pass. */
export function richTextLinksAreSafe(value: unknown): boolean {
  return unsafeRichTextHrefs(value).length === 0;
}

/** The sentence a refused document gets, shared so every rich-text field says the same thing. */
export const UNSAFE_RICH_TEXT_LINK_MESSAGE =
  "A link in the text points somewhere it cannot. Use one starting with https:// for another website, / for a page on this site, or mailto: for an email address. (A picture whose blur placeholder is not a base64 image is refused too: re-insert it from the media library.)";

// ─────────────────────────────────────────────────────────────────────────────
// Redirects — a value that goes into a `Location` header
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A redirect row's destination as it may be sent in `Location`, or null when it must be ignored.
 *
 * An absolute http(s) URL, an anchor or a query is kept. Anything else is read as a path on this site:
 * leading slashes collapse to one (`//example.com` was almost always a typo for `/example.com`), a bare
 * word gains its slash — and the result must then pass `isSafeSitePath`, so `/\evil.example`,
 * `/%2F%2Fevil.example` and a control character smuggled after the slash are refused rather than sent.
 */
export function safeRedirectDestination(raw: unknown): string | null {
  const value = cleanHref(raw);
  if (!value) return null;

  const classified = classifyHref(value);
  if (classified.kind === "external" || classified.kind === "same-page") return classified.href;

  const path = `/${value.replace(/^\/+/, "")}`;
  return isSafeSitePath(path) ? path : null;
}
