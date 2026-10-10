/**
 * MDX links — the lib/safe-href.ts rule applied to an MDX document, on render AND on save.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY `components: { a: MdxLink }` WAS NOT ENOUGH.
 *
 * MDX hands the `components` map only the elements MARKDOWN produced. `[words](//evil.example)` becomes
 * `_components.a` and reaches `MdxLink`, which refuses it. A JSX tag written in the source —
 * `<a href="//evil.example">words</a>` — compiles to a literal `_jsx("a", { href: "//evil.example" })`
 * and never meets the map at all. Every bypass the shared rule exists for (`//`, `/\`, `/%2F%2F`,
 * `javascript:`) went straight through to the page that way, and `Post.mdx`, which any AUTHOR can
 * write, had no check on save.
 *
 * So the rule is applied to the SYNTAX TREE, before anything is compiled, by `remarkSafeMdx`:
 *
 *  • A markdown link or link definition whose URL the rule refuses is unwrapped to its words (or, for
 *    a definition, dropped — the reference then prints as the text it was written as).
 *  • A JSX `<a>` is renamed to `MDX_SAFE_LINK`, a component the renderer maps to the same `MdxLink` the
 *    markdown links use, so a raw anchor and a markdown one are drawn — and checked — identically.
 *  • Every URL-bearing attribute on any JSX element (`href`, `src`, `action`, `cite`, `poster`, …) must
 *    be a literal string the rule accepts, or it is removed. An expression (`href={x}`) cannot be
 *    checked, so it is removed too; so are spreads, `on*` handlers, `style`, `dangerouslySetInnerHTML`,
 *    `className` / `class` / `id` (a class can draw a transparent full-viewport layer over the page
 *    around an allowed external link, so a click anywhere leaves the site — see `DROPPED_ATTRIBUTES`)
 *    and `background` (on a table tag it is a CSS background-image: a third-party beacon, and an
 *    author-chosen picture painted outside `MediaFigure`). On a RAW element `width`, `height` and
 *    `bgcolor` go too (`RAW_ELEMENT_DROPPED_ATTRIBUTES`); `MediaFigure` keeps its own width and height.
 *  • A JSX tag is kept only when the renderer can draw it: an EXACT lowercase name on `ALLOWED_TAGS`
 *    (text formatting, lists, tables, figures), or a component on `MDX_COMPONENT_NAMES` (the ones
 *    ProseArticle maps). A tag that navigates, loads, submits or runs something (`<base>`, `<meta>`,
 *    `<iframe>`, `<form>`, `<script>`, `<img>`, …), in ANY case, is removed with its content. Every other
 *    name is unwrapped to its content: unknown lowercase tags, `<A-B>` / `<Svg:A>` (raw elements to MDX
 *    whatever their case), `<Div>`, and component names nothing maps (`<Foo_Bar>`, `<x.y>`, `<ÄB>`). Those
 *    last ones used to pass both the tag list and the save check, and then compileMDX threw "Expected
 *    component `Foo_Bar` to be defined" at REQUEST time — a saved article broke its own public page.
 *    `<base href="https://evil.example">` would re-point every relative link on the page and
 *    `<meta http-equiv="refresh">` navigates without a link at all, so an attribute check alone could
 *    never be complete.
 *
 * ON SAVE, `mdxLinkProblems()` compiles the source with the very same plugin in REPORT mode, and a
 * route refuses the save when it reports anything — so what the server accepts is exactly what the
 * renderer would leave untouched, and (since only mapped component names survive) what it can draw.
 *
 * Source that does not compile is accepted on save (a half-typed draft is autosaved) and reported as
 * nothing: the renderer cannot produce a single element from it, so it carries no link, and the moment
 * it does compile the next save checks it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Server-only in practice (the compiler is loaded with a dynamic `import()`, as in ProseArticle), but it
 * carries no `server-only` marker so tests can import it.
 */

import { safeHref } from "@/lib/safe-href";

/** The component name a JSX `<a>` is renamed to. The renderer MUST map it (ProseArticle does). */
export const MDX_SAFE_LINK = "MdxSafeLink";

/**
 * The ONLY component (non-raw-element) JSX names an MDX document may use — exactly the non-markdown keys
 * of ProseArticle's `components` map. ⚠ KEEP THE TWO IN STEP: a name here that the renderer does not
 * map makes compileMDX throw for every visitor; a name mapped there but missing here is unwrapped (safe).
 */
export const MDX_COMPONENT_NAMES: ReadonlySet<string> = new Set(["MediaFigure", MDX_SAFE_LINK]);

/**
 * Raw-element JSX tags an MDX document may use, matched EXACTLY (lowercase): prose, lists, tables, figures. None of them navigates,
 * loads a resource, submits or runs anything. (`a` is here because it is rewritten, not passed through.)
 */
const ALLOWED_TAGS = new Set([
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "blockquote", "br", "caption", "cite",
  "code", "col", "colgroup", "data", "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption",
  "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "ins", "kbd", "li", "mark",
  "ol", "p", "pre", "q", "rp", "rt", "ruby", "s", "samp", "section", "small", "span", "strong", "sub",
  "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul", "var", "wbr"
]);

/** Tags removed WITH their content: what is inside a `<script>` or an `<iframe>` is not prose. */
const REMOVED_WITH_CONTENT = new Set([
  "applet", "area", "audio", "base", "body", "button", "canvas", "dialog", "embed", "form", "frame",
  "frameset", "head", "html", "iframe", "img", "input", "link", "map", "math", "meta", "noscript",
  "object", "option", "picture", "portal", "script", "select", "slot", "source", "style", "svg",
  "template", "textarea", "title", "track", "video"
]);

/** Attributes whose value is a URL. Compared lowercased with `:` and `-` removed (`xlink:href`). */
const URL_ATTRIBUTES = new Set([
  "href", "src", "action", "formaction", "poster", "cite", "xlinkhref", "data", "longdesc",
  "manifest", "codebase", "usemap", "profile", "dynsrc", "lowsrc"
]);

/**
 * Attributes removed outright: several URLs in one value, markup, script — or LAYOUT.
 *
 * ⚠ `className`, `class` AND `id` ARE HERE FOR THE SAME REASON `style` IS. Every Tailwind utility in the
 * build is reachable from a class attribute, and `<div className="fixed inset-0 z-50 opacity-0">` around
 * an (allowed) `<a href="https://evil.example">` is a transparent full-viewport layer that turns ANY
 * click on the article into a visit to another site — the same no-intent navigation `<meta refresh>`
 * and `<base>` are removed for. `id` goes with them: it can collide with, and be styled or targeted as,
 * an element of the page around the article. Prose needs neither.
 *
 * ⚠ `background` IS NOT A URL TO CHECK, IT IS CSS. On table/thead/tbody/tfoot/tr/td/th browsers still map
 * it to `background-image`, so `<td background="https://evil.example/b.png">` made every visitor fetch a
 * third-party image and painted an author-chosen picture over the cell — an image that never went
 * through `MediaFigure`. It used to sit on `URL_ATTRIBUTES`, whose rule accepts any external https URL;
 * a same-origin value would still bypass `MediaFigure`, so it is dropped outright.
 */
const DROPPED_ATTRIBUTES = new Set([
  "srcset", "imagesrcset", "ping", "srcdoc", "style", "dangerouslysetinnerhtml", "classname", "class", "id",
  "background"
]);

/**
 * Presentational sizing on RAW elements: `<td height="5000">` stretches the page by an author-chosen
 * amount and was the canvas a `background` image was painted on. Prose tables need neither. Not applied
 * to components — `MediaFigure` takes `width` / `height` as the picture's intrinsic size.
 */
const RAW_ELEMENT_DROPPED_ATTRIBUTES = new Set(["width", "height", "bgcolor"]);

/** What render would change, as the save-time check reports it. */
export interface MdxProblem {
  /** `[words](//evil.example)`, `<a href="//evil.example">`, `<script>` — what the author wrote. */
  label: string;
}

export interface RemarkSafeMdxOptions {
  /** Called once per change. Present on save (report mode); absent when rendering. */
  report?: (problem: MdxProblem) => void;
}

/* The few mdast / mdast-util-mdx-jsx shapes this file touches, written out rather than imported from
   transitive type packages. */
interface MdNode {
  type: string;
  children?: MdNode[];
  url?: string;
  identifier?: string;
  name?: string | null;
  attributes?: MdAttribute[];
}

interface MdAttribute {
  type: string;
  name?: string;
  value?: unknown;
}

function isJsxElement(node: MdNode): boolean {
  return node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement";
}

/**
 * Is this tag removed WITH its content? In any case, and by the local name of a namespaced tag too
 * (`<SCRIPT>`, `<svg:script>`): what is inside one is not prose.
 *
 * (Round two decided "raw element or component?" here, by MDX's own rule — lowercase, or a name holding
 * `-` or `:`. That no longer matters: only an exact `ALLOWED_TAGS` name or a `MDX_COMPONENT_NAMES` entry
 * is kept, so `<Foo-bar>`, `<A-B>` and `<Svg:A>` are unwrapped whichever way MDX would have read them.)
 */
function isRemovedWithContent(name: string): boolean {
  const lower = name.toLowerCase();
  const local = lower.slice(lower.lastIndexOf(":") + 1);
  return REMOVED_WITH_CONTENT.has(lower) || REMOVED_WITH_CONTENT.has(local);
}

function attributeKey(name: string): string {
  return name.toLowerCase().replace(/[:-]/g, "");
}

function describeValue(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : "{…}";
}

/** The rule every URL in MDX must pass: what `MdxLink` would draw as a link. */
function safeMdxUrl(raw: unknown): string | null {
  return safeHref(raw, { relative: true });
}

function sanitizeAttributes(node: MdNode, tag: string, raw: boolean, report: (label: string) => void): void {
  const kept: MdAttribute[] = [];
  for (const attribute of node.attributes ?? []) {
    if (attribute.type !== "mdxJsxAttribute" || typeof attribute.name !== "string") {
      // `{...props}` — what it spreads cannot be known here.
      report(`<${tag} {…}>`);
      continue;
    }
    const key = attributeKey(attribute.name);
    if (key.startsWith("on") || DROPPED_ATTRIBUTES.has(key) || (raw && RAW_ELEMENT_DROPPED_ATTRIBUTES.has(key))) {
      report(`<${tag} ${attribute.name}=${describeValue(attribute.value)}>`);
      continue;
    }
    if (URL_ATTRIBUTES.has(key)) {
      const safe = typeof attribute.value === "string" ? safeMdxUrl(attribute.value) : null;
      if (safe === null) {
        report(`<${tag} ${attribute.name}=${describeValue(attribute.value)}>`);
        continue;
      }
      kept.push({ ...attribute, value: safe });
      continue;
    }
    if (attribute.value !== null && attribute.value !== undefined && typeof attribute.value !== "string") {
      // An expression value. next-mdx-remote strips these too (`blockJS`); doing it here means the save
      // check and the renderer agree without depending on that default.
      report(`<${tag} ${attribute.name}={…}>`);
      continue;
    }
    kept.push(attribute);
  }
  node.attributes = kept;
}

/** What replaces `node` in its parent: itself (possibly rewritten), its children, or nothing. */
function sanitizeNode(node: MdNode, report: (label: string) => void): MdNode[] {
  if (node.type === "link") {
    sanitizeChildren(node, report);
    const safe = safeMdxUrl(node.url);
    if (safe === null) {
      report(`[…](${node.url ?? ""})`);
      return node.children ?? [];
    }
    node.url = safe;
    return [node];
  }

  if (node.type === "definition") {
    const safe = safeMdxUrl(node.url);
    if (safe === null) {
      report(`[${node.identifier ?? ""}]: ${node.url ?? ""}`);
      return [];
    }
    node.url = safe;
    return [node];
  }

  if (isJsxElement(node) && typeof node.name === "string") {
    const tag = node.name;
    const component = MDX_COMPONENT_NAMES.has(tag);
    if (!component) {
      if (isRemovedWithContent(tag)) {
        report(`<${tag}>`);
        return [];
      }
      // EXACT name: MDX compiles `<div>` to a raw element but `<Div>` to a component reference that
      // nothing maps (compileMDX would throw). See the header.
      if (!ALLOWED_TAGS.has(tag)) {
        report(`<${tag}>`);
        sanitizeChildren(node, report);
        return node.children ?? [];
      }
    }
    sanitizeAttributes(node, tag, !component, report);
    // Through the same component a markdown link uses — see the header.
    if (tag === "a") node.name = MDX_SAFE_LINK;
  }

  sanitizeChildren(node, report);
  return [node];
}

function sanitizeChildren(node: MdNode, report: (label: string) => void): void {
  if (!Array.isArray(node.children)) return;
  const next: MdNode[] = [];
  for (const child of node.children) next.push(...sanitizeNode(child, report));
  node.children = next;
}

/**
 * The remark plugin. Put it LAST in `remarkPlugins` (after remark-gfm, whose autolinks it must see).
 *
 * Rendering passes no options and the tree is rewritten; the save check passes `report` and reads what
 * would have been rewritten.
 */
export function remarkSafeMdx(options: RemarkSafeMdxOptions = {}) {
  const report = (label: string) => options.report?.({ label });
  return (tree: MdNode) => {
    sanitizeChildren(tree, report);
  };
}

/**
 * The remark plugins an article's MDX is compiled with — ONE list, so the renderer and the save check
 * cannot drift apart. Loaded with a dynamic `import()`: see ProseArticle's header.
 */
export async function articleRemarkPlugins(options: RemarkSafeMdxOptions = {}) {
  const { default: remarkGfm } = await import("remark-gfm");
  const plugins: [typeof remarkGfm, [typeof remarkSafeMdx, RemarkSafeMdxOptions]] = [
    remarkGfm,
    [remarkSafeMdx, options]
  ];
  return plugins;
}

/**
 * The SAVE-TIME check: every link, attribute and tag in this MDX source that the renderer would refuse.
 * Empty means it may be stored. Source that does not compile reports nothing (see the header).
 */
export async function mdxLinkProblems(source: string | null | undefined): Promise<string[]> {
  if (typeof source !== "string" || source.trim().length === 0) return [];
  const problems: string[] = [];
  const [{ serialize }, plugins] = await Promise.all([
    import("next-mdx-remote/serialize"),
    articleRemarkPlugins({ report: (problem) => problems.push(problem.label) })
  ]);
  try {
    await serialize(source, { mdxOptions: { remarkPlugins: plugins } });
  } catch {
    return [];
  }
  return problems;
}

/** The sentence a refused MDX body gets. */
export function unsafeMdxMessage(problems: string[]): string {
  const listed = problems.slice(0, 3).join(", ");
  const more = problems.length > 3 ? ` and ${problems.length - 3} more` : "";
  return (
    `The MDX has something this site will not publish: ${listed}${more}. Write links as [words](https://…) ` +
    "for another website, [words](/page) for a page on this site or [words](mailto:…) for an email " +
    "address, and insert images with <MediaFigure />."
  );
}
