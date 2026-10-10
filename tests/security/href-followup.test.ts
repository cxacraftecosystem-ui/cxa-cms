import "../newsletter/setup";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { RichText } from "@/components/RichText";
import { MdxLink } from "@/components/site/MdxLink";
import { MDX_SAFE_LINK, articleRemarkPlugins, mdxLinkProblems } from "@/lib/mdx-links";
import {
  BLUR_DATA_URL_LABEL,
  classifyHref,
  isSafeSitePath,
  richTextLinksAreSafe,
  safeBlurDataUrl,
  safeRedirectDestination,
  unsafeRichTextHrefs
} from "@/lib/safe-href";
import { isUsableRedirectDestination } from "@/lib/studio/link-fields";

/**
 * Four gaps a second review found after lib/safe-href.ts and lib/mdx-links.ts landed:
 *
 *  1. A rich-text image node's `blurDataUrl` was accepted whenever it began `data:`, and next/image puts
 *     it UNESCAPED inside a CSS `url("…")` — a value that closed the string injected declarations.
 *  2. MDX kept `className` / `id` on allowed tags, so a transparent full-viewport layer over an allowed
 *     external link made any click on the article leave the site.
 *  3. `isSafeSitePath` refused encoded slashes only in the FIRST segment, so `/a/..%2F..%2F/evil.example`
 *     — `//evil.example` after one decode and normalisation — was `internal`.
 *  4. The MDX tag allow-list was applied only to names starting with a lowercase letter, but MDX also
 *     compiles `<Foo-bar>`, `<A-B>` and `<Svg:A>` to raw elements.
 *
 * Every case below failed before the fix.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. Blur placeholders
// ─────────────────────────────────────────────────────────────────────────────

const REAL_BLUR =
  "data:image/webp;base64,UklGRmgAAABXRUJQVlA4IFwAAAAwAgCdASoQAAkAA4BaJYgCdAYtLvr3YTGoAAD5CUJlfc4EI+iziprDwdYLeYy4VITc5NmW/P+BEaiXuN3nte6kmzO6D1IRHoXqzgut0rJiAXrgS83c11bNS4AAAA==";

/** The payload from the report: closes next/image's CSS string and draws a beaconing overlay. */
const CSS_BREAKOUT =
  'data:x");position:fixed;inset:0;z-index:2147483647;width:100vw;height:100vh;background:url(https://evil.example/beacon);x:url("';

const BAD_BLURS = [
  CSS_BREAKOUT,
  "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><image href='https://evil.example/x'/></svg>",
  "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
  "data:image/png;base64,AAAA');background:url(https://evil.example/b",
  'data:image/png;base64,AAAA")',
  "data:image/png;base64,AA AA",
  "data:text/html;base64,PHNjcmlwdD4=",
  "data:image/png,AAAA",
  "https://evil.example/blur.png",
  `data:image/png;base64,${"A".repeat(40_000)}`
];

function imageDoc(blurDataUrl: unknown): unknown {
  return {
    type: "doc",
    content: [{ type: "image", attrs: { src: "/uploads/picture.jpg", width: 800, height: 600, altText: "A picture", blurDataUrl } }]
  };
}

function figureDoc(blurDataUrl: unknown): unknown {
  return {
    type: "doc",
    content: [
      {
        type: "figure",
        content: [{ type: "image", attrs: { src: "/uploads/picture.jpg", width: 800, height: 600, blurDataUrl } }]
      }
    ]
  };
}

describe("blur placeholders: only a base64 raster reaches next/image", () => {
  it("accepts the pipeline's own WebP and plain png/jpeg/gif base64", () => {
    assert.equal(safeBlurDataUrl(REAL_BLUR), REAL_BLUR);
    for (const type of ["png", "jpeg", "gif"]) {
      assert.equal(safeBlurDataUrl(`data:image/${type};base64,AAAA`), `data:image/${type};base64,AAAA`);
    }
  });

  it("refuses anything that could leave a CSS string, any non-raster type, and absurd lengths", () => {
    for (const value of BAD_BLURS) assert.equal(safeBlurDataUrl(value), null, value.slice(0, 60));
    assert.equal(safeBlurDataUrl(null), null);
    assert.equal(safeBlurDataUrl(42), null);
  });

  it("refuses the document on save (it used to pass: only link marks were inspected)", () => {
    for (const value of BAD_BLURS) {
      assert.equal(richTextLinksAreSafe(imageDoc(value)), false, value.slice(0, 60));
      assert.equal(richTextLinksAreSafe(figureDoc(value)), false, value.slice(0, 60));
    }
    const reported = unsafeRichTextHrefs(imageDoc(CSS_BREAKOUT));
    assert.equal(reported.length, 1);
    assert.ok(reported[0]?.startsWith(BLUR_DATA_URL_LABEL));
    assert.equal(richTextLinksAreSafe(imageDoc(42)), false);
  });

  it("still saves a document whose picture has a real blur, or none", () => {
    assert.equal(richTextLinksAreSafe(imageDoc(REAL_BLUR)), true);
    assert.equal(richTextLinksAreSafe(imageDoc(null)), true);
    assert.equal(richTextLinksAreSafe(imageDoc("")), true);
    assert.equal(richTextLinksAreSafe(imageDoc(undefined)), true);
  });

  it("renders no injected CSS and no third-party url() from a stored payload", () => {
    for (const value of BAD_BLURS) {
      for (const doc of [imageDoc(value), figureDoc(value)]) {
        const html = renderToStaticMarkup(createElement(RichText, { value: doc }));
        assert.match(html, /<img/, "the picture itself still renders");
        assert.doesNotMatch(html, /evil\.example/, value.slice(0, 60));
        assert.doesNotMatch(html, /position:\s*fixed/, value.slice(0, 60));
        assert.doesNotMatch(html, /2147483647/, value.slice(0, 60));
      }
    }
  });

  it("still draws the blur placeholder for a real one", () => {
    const html = renderToStaticMarkup(createElement(RichText, { value: imageDoc(REAL_BLUR) }));
    assert.match(html, /UklGRmgAAABXRUJQVlA4IFwAAAAwAgCdASoQAAkAA4BaJYgCdAYtLvr3YTGoAAD5CUJlfc4EI/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MDX helpers
// ─────────────────────────────────────────────────────────────────────────────

async function renderMdx(source: string): Promise<string> {
  const [{ compileMDX }, remarkPlugins] = await Promise.all([import("next-mdx-remote/rsc"), articleRemarkPlugins()]);
  const { content } = await compileMDX({
    source,
    options: { mdxOptions: { remarkPlugins } },
    components: { a: MdxLink, [MDX_SAFE_LINK]: MdxLink, MediaFigure: () => null }
  });
  return renderToStaticMarkup(createElement("div", null, content as ReactNode));
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. MDX className / class / id
// ─────────────────────────────────────────────────────────────────────────────

describe("MDX: no author-controlled class or id (a transparent overlay over an external link)", () => {
  const OVERLAY =
    '<div className="fixed inset-0 z-50 opacity-0"><a href="https://evil.example">x</a></div>\n\nThe article.';

  it("renders the overlay with no class attribute anywhere it was written", async () => {
    const html = await renderMdx(OVERLAY);
    assert.doesNotMatch(html, /fixed|inset-0|z-50|opacity-0/, html);
    // The link itself is still an allowed external link; it is the full-viewport layer that is gone.
    assert.match(html, /href="https:\/\/evil\.example"/);
  });

  for (const source of [
    '<div className="fixed inset-0 z-50">overlay</div>',
    '<span class="fixed inset-0">overlay</span>',
    '<p id="site-header">overlay</p>',
    '<a href="https://example.org" className="fixed inset-0 z-50">x</a>'
  ]) {
    it(`strips on render and refuses on save: ${source}`, async () => {
      const html = await renderMdx(source);
      // MdxLink draws its own classes on an anchor; what must be gone is everything the AUTHOR wrote.
      assert.doesNotMatch(html, /fixed|inset-0|z-50|site-header|\sid="/, html);
      assert.notDeepEqual(await mdxLinkProblems(source), [], source);
    });
  }

  it("still saves ordinary prose", async () => {
    assert.deepEqual(await mdxLinkProblems("Some *prose* with [a link](https://example.org).\n\n<div>A block</div>"), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Encoded separators and dot segments beyond the first segment
// ─────────────────────────────────────────────────────────────────────────────

const DEEP_BYPASSES = [
  "/a/..%2F..%2F/evil.example",
  "/a/%2e%2e%2f%2e%2e%2f/evil.example",
  "/a/%2E%2E%2F%2E%2E%2F/evil.example",
  "/a/..%252F..%252F/evil.example",
  "/a/..%5C..%5C/evil.example",
  "/a/b%2F%2Fevil.example",
  "/a/b/%2F%2Fevil.example",
  "/a/..%2F..%2F%zz/evil.example",
  "/a/b%09/evil.example",
  "/a/b%00c",
  "/a/./b",
  "/a/../b",
  "/a/%2e/b",
  "/a/.%2E/b",
  "/a/b/..?x=1",
  "/a/..%2F..%2F/evil.example?x=1#y"
];

describe("isSafeSitePath: every segment, not only the first", () => {
  for (const path of DEEP_BYPASSES) {
    it(`refuses ${path}`, () => {
      assert.equal(isSafeSitePath(path), false);
      assert.equal(classifyHref(path).kind, "unsafe");
      assert.equal(safeRedirectDestination(path), null);
      assert.equal(isUsableRedirectDestination(path), false);
    });
  }

  it("refuses the same paths on this site's own host (no internal rewrite)", () => {
    for (const path of DEEP_BYPASSES.slice(0, 2)) {
      const kind = classifyHref(`https://cxa.example.org${path}`, { siteHost: "cxa.example.org" }).kind;
      assert.notEqual(kind, "internal", path);
    }
  });

  it("still accepts ordinary deep paths, including encoded characters and a stray % further along", () => {
    for (const path of [
      "/research/textiles",
      "/news/2026/10/a-story",
      "/search/100%",
      "/people/jos%C3%A9",
      "/files/report%20final.pdf",
      "/a/b.c/..d/...",
      "/studio/news?id=a%2Fb",
      "/page#section/..%2F"
    ]) {
      assert.equal(isSafeSitePath(path), true, path);
      assert.equal(classifyHref(path).kind, "internal", path);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Hyphenated and namespaced tag names
// ─────────────────────────────────────────────────────────────────────────────

describe("MDX: tags MDX compiles to raw elements whatever their case", () => {
  for (const [source, tag] of [
    ["<Foo-bar>x</Foo-bar>", "foo-bar"],
    ["<A-B>x</A-B>", "a-b"],
    ["<Svg:A>x</Svg:A>", "svg:a"],
    ["<foo-bar>x</foo-bar>", "foo-bar"],
    ["<Meta-x>x</Meta-x>", "meta-x"]
  ] as const) {
    it(`unwraps ${source} on render and refuses it on save`, async () => {
      const html = await renderMdx(source);
      assert.doesNotMatch(html.toLowerCase(), new RegExp(`<${tag}`), html);
      assert.match(html, /x/);
      assert.notDeepEqual(await mdxLinkProblems(source), [], source);
    });
  }

  it("still allows a lowercase allow-listed tag", async () => {
    const html = await renderMdx("<details><summary>More</summary>Body</details>");
    assert.match(html, /<details><summary>More<\/summary>/);
    assert.deepEqual(await mdxLinkProblems("<details><summary>More</summary>Body</details>"), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Third pass. 5. Presentational `background` (a CSS background-image) on allowed table tags
// ─────────────────────────────────────────────────────────────────────────────

describe("MDX: no author-chosen background image (table `background` is CSS background-image)", () => {
  const BEACON =
    '<table background="https://evil.example/b.png" width="100%"><tbody><tr><td background="https://evil.example/c.png" height="5000">x</td></tr></tbody></table>';

  it("renders the table with no background, width or height, and refuses it on save", async () => {
    const html = await renderMdx(BEACON);
    assert.doesNotMatch(html, /evil\.example/, html);
    assert.doesNotMatch(html, /background=|height=|width=/i, html);
    assert.match(html, /<td>x<\/td>/, "the table and its words remain");
    assert.notDeepEqual(await mdxLinkProblems(BEACON), []);
  });

  for (const source of [
    '<td background="https://evil.example/c.png">x</td>',
    '<div background="/uploads/picture.jpg">x</div>',
    '<th BACKGROUND="https://evil.example/c.png">x</th>',
    '<td bgcolor="#000" width="5000">x</td>'
  ]) {
    it(`strips on render and refuses on save: ${source}`, async () => {
      const html = await renderMdx(source);
      assert.doesNotMatch(html, /evil\.example|uploads|background|bgcolor|width=/i, html);
      assert.notDeepEqual(await mdxLinkProblems(source), [], source);
    });
  }

  it("still saves a plain table, and MediaFigure keeps its own width and height", async () => {
    assert.deepEqual(await mdxLinkProblems("<table><tbody><tr><td>x</td></tr></tbody></table>"), []);
    assert.deepEqual(await mdxLinkProblems('<MediaFigure objectKey="media/a.jpg" alt="A" width="800" height="600" />'), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Third pass. 6. A correctly encoded `%` in the first segment (regression from round two)
// ─────────────────────────────────────────────────────────────────────────────

describe("isSafeSitePath: a literal % written as %25 is a legitimate first segment", () => {
  for (const path of ["/100%25", "/100%25off", "/100%25/sale", "/100%25?x=1", "/caf%C3%A9%25"]) {
    it(`accepts ${path}`, () => {
      assert.equal(isSafeSitePath(path), true);
      assert.equal(classifyHref(path).kind, "internal");
      assert.equal(safeRedirectDestination(path), path);
    });
  }

  for (const path of ["/100%", "/%zz", "/%E0%A4%A", "/%252F%252Fevil.example", "/%252e%252e/evil.example", "/%2e%2e%2fevil.example"]) {
    it(`still refuses ${path}`, () => {
      assert.equal(isSafeSitePath(path), false);
      assert.equal(classifyHref(path).kind, "unsafe");
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Third pass. 7. A component name the renderer does not map must not reach compileMDX
// ─────────────────────────────────────────────────────────────────────────────

describe("MDX: unknown component names are unwrapped, so a saved article cannot break its page", () => {
  for (const source of [
    "<Foo_Bar>z</Foo_Bar>",
    "<x.y>z</x.y>",
    "<ÄB>z</ÄB>",
    "<Div>z</Div>",
    "<A href=\"https://example.org\">z</A>",
    "<MdxLink>z</MdxLink>",
    "Text <Inline>z</Inline> more"
  ]) {
    it(`renders ${source} without throwing and refuses it on save`, async () => {
      const html = await renderMdx(source);
      assert.match(html, /z/, html);
      assert.notDeepEqual(await mdxLinkProblems(source), [], source);
    });
  }

  for (const source of ["<Script>alert(1)</Script>", "<IFRAME>inner</IFRAME>"]) {
    it(`removes ${source} with its content`, async () => {
      const html = await renderMdx(source);
      assert.doesNotMatch(html, /alert|inner/i, html);
      assert.notDeepEqual(await mdxLinkProblems(source), [], source);
    });
  }

  it("still renders MediaFigure and a raw <a>", async () => {
    assert.deepEqual(await mdxLinkProblems('<MediaFigure objectKey="media/a.jpg" alt="A" />'), []);
    assert.deepEqual(await mdxLinkProblems('<a href="/research">r</a>'), []);
    assert.match(await renderMdx('<a href="/research">r</a>'), /href="\/research"/);
  });
});
