import { publicObjectUrl } from "@/lib/media/url";
import { classifyHref } from "@/lib/safe-href";
import {
  calloutToneOf,
  cellSpansOf,
  headingLevelOf,
  imageAttrsOf,
  linkAttrsOf,
  orderedListStartOf,
  textAlignOf,
  textColourOf,
  videoAttrsOf,
  type RichTextDoc,
  type RichTextMark,
  type RichTextNode
} from "@/lib/richtext";

/**
 * A rich-text document (lib/richtext.ts) rendered for an EMAIL: inline-styled HTML, and plain text.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT components/RichText.tsx
 *
 * That renderer is right for a browser and wrong for a mail client in every way that matters here:
 * class names (Gmail strips `<style>` blocks in many contexts, Outlook ignores most of CSS), `next/image`,
 * client components, embedded video players, relative links. An email gets the SAME DOCUMENT — the one
 * the editor wrote, read through the same attribute readers in lib/richtext.ts — drawn with the small
 * vocabulary every client understands: `<p>`, `<h2>`, `<ul>`, `<table>`, `<a>`, `<img>`, with every style
 * written on the element.
 *
 * ⚠ THE ESCAPING IS THE SECURITY BOUNDARY. Every piece of text and every attribute value goes through
 * `escapeHtml`/`escapeAttr`; a link whose scheme is not http(s) or mailto is dropped to its text. An
 * editor cannot put script into a mailing, and neither can a pasted document.
 *
 * Pure: no `server-only`, no database. The site's origin is passed in, so the tests need no environment.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const EMAIL_COLOURS = {
  ink: "#1e1b2e",
  body: "#3a3651",
  muted: "#615d7a",
  line: "#e4e1ee",
  brand: "#6b2fa8",
  panel: "#f7f6fb",
  highlight: "#fff1b8"
} as const;

const FONT_STACK = "'Plus Jakarta Sans', 'Segoe UI', Helvetica, Arial, sans-serif";

/** Body text style, shared by every paragraph-like block. */
const P_STYLE = `margin:0 0 16px 0;font-family:${FONT_STACK};font-size:16px;line-height:26px;color:${EMAIL_COLOURS.body};`;

const MAX_DEPTH = 40;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const escapeAttr = escapeHtml;

/**
 * An href a mail client may follow, made absolute against the site, or null.
 *
 * Relative links ("/news/x") are resolved against the site's origin — an email has no base URL, so a
 * relative link is a dead one. The kind of link is decided by `classifyHref()` (lib/safe-href.ts), the
 * rule the site's renderer and the save-time validators share: `javascript:`, `data:`, a bare word, and
 * a path that only LOOKS like one of ours (`//evil.example`, `/\evil.example`, `/%2F%2Fevil.example`) are
 * refused, so an email never presents another host as a link to the Centre's own site.
 */
export function safeEmailHref(raw: string | null, siteOrigin: string): string | null {
  const link = classifyHref(raw);
  switch (link.kind) {
    case "external":
      return new URL(link.href).toString();
    case "contact":
      return /^mailto:/i.test(link.href) ? link.href : null;
    case "internal":
      break;
    case "same-page":
      // An anchor means nothing outside the page it was written on; a bare query is relative to the site.
      if (link.href.startsWith("#")) return null;
      break;
    default:
      return null;
  }
  try {
    const url = new URL(link.href, `${siteOrigin}/`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export interface EmailRenderContext {
  /** `https://example.org`, no trailing slash. */
  siteOrigin: string;
}

interface Collected {
  footnotes: string[];
}

function textAlignStyle(node: RichTextNode): string {
  const align = textAlignOf(node);
  return align ? `text-align:${align};` : "";
}

function renderMarks(text: string, marks: readonly RichTextMark[] | undefined, ctx: EmailRenderContext): string {
  let html = escapeHtml(text).replace(/\n/g, "<br>");
  if (!marks) return html;
  // Links outermost, so a bold word inside a link keeps the link's colour on the whole run.
  const ordered = [...marks].sort((a, b) => (a.type === "link" ? 1 : 0) - (b.type === "link" ? 1 : 0));
  for (const mark of ordered) {
    switch (mark.type) {
      case "bold":
        html = `<strong style="font-weight:700;">${html}</strong>`;
        break;
      case "italic":
        html = `<em>${html}</em>`;
        break;
      case "underline":
        html = `<u>${html}</u>`;
        break;
      case "strike":
        html = `<s>${html}</s>`;
        break;
      case "code":
        html = `<code style="font-family:Consolas,Menlo,monospace;font-size:14px;background:${EMAIL_COLOURS.panel};padding:1px 4px;">${html}</code>`;
        break;
      case "subscript":
        html = `<sub>${html}</sub>`;
        break;
      case "superscript":
        html = `<sup>${html}</sup>`;
        break;
      case "highlight":
        html = `<span style="background:${EMAIL_COLOURS.highlight};">${html}</span>`;
        break;
      case "smallCaps":
        html = `<span style="font-variant:small-caps;">${html}</span>`;
        break;
      case "textColour": {
        const colour = textColourOf(mark);
        const value =
          colour === "strong" ? EMAIL_COLOURS.ink : colour === "muted" ? EMAIL_COLOURS.muted : colour === "brand" ? EMAIL_COLOURS.brand : null;
        if (value) html = `<span style="color:${value};">${html}</span>`;
        break;
      }
      case "link": {
        const href = safeEmailHref(linkAttrsOf(mark).href, ctx.siteOrigin);
        if (href) {
          html = `<a href="${escapeAttr(href)}" style="color:${EMAIL_COLOURS.brand};text-decoration:underline;">${html}</a>`;
        }
        break;
      }
      default:
        // `tracking` and anything unknown: the words survive, the decoration does not.
        break;
    }
  }
  return html;
}

function renderInline(nodes: readonly RichTextNode[] | undefined, ctx: EmailRenderContext, collected: Collected, depth: number): string {
  if (!nodes) return "";
  return nodes.map((node) => renderNode(node, ctx, collected, depth + 1)).join("");
}

function renderChildren(node: RichTextNode, ctx: EmailRenderContext, collected: Collected, depth: number): string {
  return renderInline(node.content, ctx, collected, depth);
}

const HEADING_SIZES: Record<number, [number, number]> = { 1: [26, 34], 2: [22, 30], 3: [19, 27], 4: [17, 25] };

function renderNode(node: RichTextNode, ctx: EmailRenderContext, collected: Collected, depth: number): string {
  if (depth > MAX_DEPTH) return "";

  switch (node.type) {
    case "text":
      return renderMarks(node.text ?? "", node.marks, ctx);
    case "hardBreak":
      return "<br>";
    case "paragraph":
    case "dropCap": {
      const inner = renderChildren(node, ctx, collected, depth);
      // An empty paragraph is a deliberate gap in the editor; a non-breaking space keeps its height.
      return `<p style="${P_STYLE}${textAlignStyle(node)}">${inner.length > 0 ? inner : "&nbsp;"}</p>`;
    }
    case "leadParagraph":
      return `<p style="${P_STYLE}font-size:19px;line-height:29px;color:${EMAIL_COLOURS.ink};${textAlignStyle(node)}">${renderChildren(node, ctx, collected, depth)}</p>`;
    case "heading": {
      // The issue's own title is the email's h1, so the document's levels start one below it.
      const level = Math.min(4, headingLevelOf(node) + 1);
      const [size, height] = HEADING_SIZES[level] ?? [17, 25];
      return `<h${level} style="margin:24px 0 12px 0;font-family:${FONT_STACK};font-size:${size}px;line-height:${height}px;font-weight:700;color:${EMAIL_COLOURS.ink};${textAlignStyle(node)}">${renderChildren(node, ctx, collected, depth)}</h${level}>`;
    }
    case "bulletList":
      return `<ul style="margin:0 0 16px 0;padding:0 0 0 24px;font-family:${FONT_STACK};font-size:16px;line-height:26px;color:${EMAIL_COLOURS.body};">${renderChildren(node, ctx, collected, depth)}</ul>`;
    case "orderedList": {
      const start = orderedListStartOf(node);
      return `<ol${start && start !== 1 ? ` start="${start}"` : ""} style="margin:0 0 16px 0;padding:0 0 0 24px;font-family:${FONT_STACK};font-size:16px;line-height:26px;color:${EMAIL_COLOURS.body};">${renderChildren(node, ctx, collected, depth)}</ol>`;
    }
    case "listItem":
      // A list item's paragraphs carry a bottom margin of their own; inside a list that doubles the gap.
      return `<li style="margin:0 0 6px 0;">${renderChildren(node, ctx, collected, depth).replace(/margin:0 0 16px 0;/g, "margin:0;")}</li>`;
    case "blockquote":
    case "pullQuote":
      return `<blockquote style="margin:0 0 16px 0;padding:4px 0 4px 16px;border-left:3px solid ${EMAIL_COLOURS.brand};font-style:italic;">${renderChildren(node, ctx, collected, depth)}</blockquote>`;
    case "attribution":
      return `<p style="${P_STYLE}font-style:normal;color:${EMAIL_COLOURS.muted};font-size:14px;">${renderChildren(node, ctx, collected, depth)}</p>`;
    case "sideNote":
      return `<p style="${P_STYLE}font-size:14px;line-height:22px;color:${EMAIL_COLOURS.muted};">${renderChildren(node, ctx, collected, depth)}</p>`;
    case "callout": {
      const tone = calloutToneOf(node);
      const word = tone === "warning" ? "Please note" : tone === "danger" ? "Important" : tone === "tip" ? "Tip" : "Note";
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;border-collapse:collapse;"><tr><td style="padding:14px 16px;background:${EMAIL_COLOURS.panel};border-left:3px solid ${EMAIL_COLOURS.brand};"><p style="${P_STYLE}margin:0 0 6px 0;font-weight:700;color:${EMAIL_COLOURS.ink};">${word}</p>${renderChildren(node, ctx, collected, depth)}</td></tr></table>`;
    }
    case "codeBlock":
      return `<pre style="margin:0 0 16px 0;padding:12px;background:${EMAIL_COLOURS.panel};font-family:Consolas,Menlo,monospace;font-size:13px;line-height:20px;white-space:pre-wrap;color:${EMAIL_COLOURS.ink};">${escapeHtml(plainOf(node))}</pre>`;
    case "horizontalRule":
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px 0;"><tr><td style="border-top:1px solid ${EMAIL_COLOURS.line};font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
    case "image":
      return renderImage(node, null, ctx);
    case "figure": {
      const image = node.content?.find((child) => child.type === "image");
      const caption = node.content?.find((child) => child.type === "figureCaption");
      return image ? renderImage(image, caption ? renderChildren(caption, ctx, collected, depth) : null, ctx) : "";
    }
    case "figureCaption":
      return `<p style="${P_STYLE}font-size:14px;color:${EMAIL_COLOURS.muted};">${renderChildren(node, ctx, collected, depth)}</p>`;
    case "videoEmbed": {
      // No mail client plays video. The film becomes a link to watch it, named by its own title.
      const video = videoAttrsOf(node);
      const href = video.provider === "upload" ? publicObjectUrl(video.objectKey) : safeEmailHref(video.url, ctx.siteOrigin);
      if (!href) return "";
      const label = video.title.length > 0 ? video.title : "Watch the film";
      return `<p style="${P_STYLE}"><a href="${escapeAttr(href)}" style="color:${EMAIL_COLOURS.brand};font-weight:700;text-decoration:underline;">&#9654; ${escapeHtml(label)}</a>${video.caption ? `<br><span style="font-size:14px;color:${EMAIL_COLOURS.muted};">${escapeHtml(video.caption)}</span>` : ""}</p>`;
    }
    case "footnote": {
      collected.footnotes.push(renderChildren(node, ctx, collected, depth));
      const n = collected.footnotes.length;
      return `<sup style="font-size:11px;">[${n}]</sup>`;
    }
    case "table":
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;border-collapse:collapse;font-family:${FONT_STACK};font-size:14px;line-height:22px;color:${EMAIL_COLOURS.body};">${renderChildren(node, ctx, collected, depth)}</table>`;
    case "tableRow":
      return `<tr>${renderChildren(node, ctx, collected, depth)}</tr>`;
    case "tableHeader":
    case "tableCell": {
      const { colSpan, rowSpan } = cellSpansOf(node);
      const tag = node.type === "tableHeader" ? "th" : "td";
      const spans = `${colSpan > 1 ? ` colspan="${colSpan}"` : ""}${rowSpan > 1 ? ` rowspan="${rowSpan}"` : ""}`;
      const inner = renderChildren(node, ctx, collected, depth).replace(/margin:0 0 16px 0;/g, "margin:0;");
      return `<${tag}${spans} style="border:1px solid ${EMAIL_COLOURS.line};padding:8px;text-align:left;vertical-align:top;${tag === "th" ? `background:${EMAIL_COLOURS.panel};font-weight:700;color:${EMAIL_COLOURS.ink};` : ""}">${inner}</${tag}>`;
    }
    case "definitionList":
      return `<div style="margin:0 0 16px 0;">${renderChildren(node, ctx, collected, depth)}</div>`;
    case "definitionTerm":
      return `<p style="${P_STYLE}margin:0;font-weight:700;color:${EMAIL_COLOURS.ink};">${renderChildren(node, ctx, collected, depth)}</p>`;
    case "definitionDetails":
      return `<div style="margin:0 0 12px 16px;">${renderChildren(node, ctx, collected, depth)}</div>`;
    case "columns":
      // Newspaper columns do not survive a phone-width mail client; the passage is set as one column.
      return renderChildren(node, ctx, collected, depth);
    default:
      // An unknown node keeps its words. The same rule components/RichText.tsx follows.
      return renderChildren(node, ctx, collected, depth);
  }
}

function renderImage(node: RichTextNode, captionHtml: string | null, ctx: EmailRenderContext): string {
  const attrs = imageAttrsOf(node);
  const src = publicObjectUrl(attrs.objectKey) ?? safeEmailHref(attrs.src, ctx.siteOrigin);
  if (!src) return "";
  const alt = attrs.altText ?? "";
  const width = 560;
  const height =
    attrs.width && attrs.height && attrs.width > 0 ? Math.round((attrs.height / attrs.width) * width) : null;
  const caption =
    captionHtml ??
    (attrs.caption ? escapeHtml(attrs.caption) : null);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;"><tr><td><img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" width="${width}"${height ? ` height="${height}"` : ""} style="display:block;width:100%;max-width:${width}px;height:auto;border:0;outline:none;text-decoration:none;"></td></tr>${caption ? `<tr><td style="padding-top:6px;font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${EMAIL_COLOURS.muted};">${caption.replace(/<\/?p[^>]*>/g, "")}</td></tr>` : ""}</table>`;
}

/** The raw text under a node, unescaped. */
function plainOf(node: RichTextNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(plainOf).join("");
}

/** The body of an issue as email HTML. Footnotes are gathered and set as numbered notes at the end. */
export function richTextToEmailHtml(doc: RichTextDoc | null, ctx: EmailRenderContext): string {
  if (!doc) return "";
  const collected: Collected = { footnotes: [] };
  const body = renderInline(doc.content, ctx, collected, 0);
  if (collected.footnotes.length === 0) return body;
  const notes = collected.footnotes
    .map(
      (note, index) =>
        `<p style="${P_STYLE}font-size:13px;line-height:20px;color:${EMAIL_COLOURS.muted};margin:0 0 6px 0;">[${index + 1}] ${note.replace(/<\/?p[^>]*>/g, "")}</p>`
    )
    .join("");
  return `${body}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 0 0;"><tr><td style="border-top:1px solid ${EMAIL_COLOURS.line};padding-top:12px;">${notes}</td></tr></table>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plain text
// ─────────────────────────────────────────────────────────────────────────────

function inlineText(nodes: readonly RichTextNode[] | undefined, ctx: EmailRenderContext, depth: number): string {
  if (!nodes || depth > MAX_DEPTH) return "";
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") {
      const text = node.text ?? "";
      const link = node.marks?.find((mark) => mark.type === "link");
      const href = link ? safeEmailHref(linkAttrsOf(link).href, ctx.siteOrigin) : null;
      // A link in plain text is its words followed by the address — the only form every client shows.
      out += href && href !== text ? `${text} (${href})` : text;
    } else if (node.type === "hardBreak") {
      out += "\n";
    } else if (node.type === "footnote") {
      out += ` [${inlineText(node.content, ctx, depth + 1).trim()}]`;
    } else {
      out += inlineText(node.content, ctx, depth + 1);
    }
  }
  return out;
}

function blockText(node: RichTextNode, ctx: EmailRenderContext, depth: number, listPrefix?: string): string[] {
  if (depth > MAX_DEPTH) return [];
  switch (node.type) {
    case "heading": {
      const text = inlineText(node.content, ctx, depth).trim();
      return text ? [text.toUpperCase()] : [];
    }
    case "bulletList":
    case "orderedList": {
      const start = node.type === "orderedList" ? (orderedListStartOf(node) ?? 1) : 0;
      const lines: string[] = [];
      (node.content ?? []).forEach((item, index) => {
        const prefix = node.type === "orderedList" ? `${start + index}. ` : "- ";
        lines.push(blockText(item, ctx, depth + 1, prefix).join("\n"));
      });
      return [lines.join("\n")];
    }
    case "listItem": {
      const parts = (node.content ?? []).flatMap((child) => blockText(child, ctx, depth + 1));
      return [`${listPrefix ?? "- "}${parts.join("\n   ")}`];
    }
    case "blockquote":
    case "pullQuote": {
      const parts = (node.content ?? []).flatMap((child) => blockText(child, ctx, depth + 1));
      return parts.map((part) => part.split("\n").map((line) => `> ${line}`).join("\n"));
    }
    case "horizontalRule":
      return ["----"];
    case "image": {
      const attrs = imageAttrsOf(node);
      return attrs.altText ? [`[Picture: ${attrs.altText}]`] : [];
    }
    case "videoEmbed": {
      const video = videoAttrsOf(node);
      const href = video.provider === "upload" ? publicObjectUrl(video.objectKey) : safeEmailHref(video.url, ctx.siteOrigin);
      return href ? [`${video.title || "Watch the film"}: ${href}`] : [];
    }
    case "table":
      return [
        (node.content ?? [])
          .map((row) => (row.content ?? []).map((cell) => inlineText(cell.content, ctx, depth + 2).trim()).join(" | "))
          .join("\n")
      ];
    case "paragraph":
    case "dropCap":
    case "leadParagraph":
    case "attribution":
    case "sideNote":
    case "figureCaption":
    case "definitionTerm":
    case "codeBlock": {
      const text = inlineText(node.content, ctx, depth);
      return text.trim().length > 0 ? [text.trim()] : [];
    }
    default:
      if (node.content && node.content.some((child) => child.type !== "text" && child.type !== "hardBreak")) {
        return node.content.flatMap((child) => blockText(child, ctx, depth + 1));
      }
      {
        const text = inlineText(node.content, ctx, depth).trim();
        return text ? [text] : [];
      }
  }
}

/** The body of an issue as plain text — the `text/plain` alternative every message carries. */
export function richTextToEmailText(doc: RichTextDoc | null, ctx: EmailRenderContext): string {
  if (!doc) return "";
  return doc.content
    .flatMap((node) => blockText(node, ctx, 0))
    .filter((block) => block.length > 0)
    .join("\n\n");
}
