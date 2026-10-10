import "../newsletter/setup";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { PreferencesProvider } from "@/components/providers/PreferencesProvider";
import { RichText } from "@/components/RichText";
import { MdxLink } from "@/components/site/MdxLink";
import { SiteFooter } from "@/components/site/SiteFooter";
import { LinkButton } from "@/components/ui/Button";
import { MDX_SAFE_LINK, articleRemarkPlugins, mdxLinkProblems } from "@/lib/mdx-links";
import { assembleNavigation, type NavigationRow } from "@/lib/navigation";
import {
  MAX_RICH_TEXT_NODES,
  RICH_TEXT_TOO_LARGE,
  classifyHref,
  richTextLinksAreSafe,
  unsafeRichTextHrefs
} from "@/lib/safe-href";
import { richTextSectionSchema } from "@/lib/sections/schema";
import { SETTINGS_DEFAULTS } from "@/lib/settings/schema";
import {
  isStorableAnnouncementHref,
  isUsableRedirectDestination,
  navigationHrefSchema,
  publisherUrlSchema
} from "@/lib/studio/link-fields";

import { BYPASS_CORPUS } from "./href-corpus";

/**
 * The two bypasses an adversarial review found after lib/safe-href.ts landed — a JSX `<a>` in MDX, which
 * MDX never hands to the `components` map, and a rich-text document padded past the save-time walker's
 * node limit — and the render surfaces and route validators the first round of tests never reached.
 *
 * The render tests draw the real component to HTML and read back every `href` in it, so they assert what
 * a browser would be given rather than what a helper returned.
 */

/** Every href attribute in rendered HTML, entity-decoded. */
function hrefsIn(html: string): string[] {
  return [...html.matchAll(/\shref="([^"]*)"/g)].map((match) =>
    (match[1] ?? "")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
  );
}

/**
 * An href that lib/safe-href.ts would let a renderer emit (bare relative words included). Note that markdown
 * itself rewrites some corpus entries before any check sees them — `\/evil.example` is an escaped slash,
 * so the link is to the path `/evil.example`, and the parser turns NUL into U+FFFD, leaving a relative
 * path on this origin. Both are safe, which is what this asserts, rather than "the word evil is absent".
 */
function isEmittable(href: string): boolean {
  return ["internal", "same-page", "external", "contact", "relative"].includes(classifyHref(href).kind);
}

function assertOnlySafeHrefs(html: string, input: string): void {
  for (const href of hrefsIn(html)) {
    assert.ok(isEmittable(href), `${JSON.stringify(input)} rendered href=${JSON.stringify(href)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MDX — render
// ─────────────────────────────────────────────────────────────────────────────

/** Compile and render MDX exactly as ProseArticle does: the same plugin list, the same link components. */
async function renderMdx(source: string): Promise<string | null> {
  const [{ compileMDX }, remarkPlugins] = await Promise.all([
    import("next-mdx-remote/rsc"),
    articleRemarkPlugins()
  ]);
  let content: ReactNode;
  try {
    ({ content } = await compileMDX({
      source,
      options: { mdxOptions: { remarkPlugins } },
      components: {
        a: MdxLink,
        [MDX_SAFE_LINK]: MdxLink,
        MediaFigure: () => null
      }
    }));
  } catch {
    // Source the compiler refuses renders nothing at all, so it carries no link.
    return null;
  }
  return renderToStaticMarkup(createElement("div", null, content));
}

/** A JSX string attribute cannot hold `"` or a raw newline; the corpus entries that need them are skipped. */
function jsxAttribute(href: string): string | null {
  return /["\n\r]/.test(href) ? null : href;
}

describe("MDX, rendered: a JSX <a> no longer bypasses MdxLink", () => {
  it("draws a raw <a href=\"//evil.example\"> as its words, with no anchor (it used to be a live link)", async () => {
    const html = await renderMdx('Read <a href="//evil.example">this</a> now.');
    assert.ok(html !== null);
    assert.equal(hrefsIn(html).length, 0, html);
    assert.match(html, /this/);
  });

  for (const href of BYPASS_CORPUS) {
    const attribute = jsxAttribute(href);
    if (attribute === null) continue;
    it(`a JSX <a href=${JSON.stringify(href)}> renders no unsafe href`, async () => {
      const html = await renderMdx(`Go <a href="${attribute}">there</a>.`);
      if (html !== null) assertOnlySafeHrefs(html, href);
    });
    it(`a markdown [link](${JSON.stringify(href)}) renders no unsafe href`, async () => {
      const html = await renderMdx(`Go [there](<${href.replace(/[<>]/g, "")}>).\n\nAnd [ref][r].\n\n[r]: <${href.replace(/[<>]/g, "")}>\n`);
      if (html !== null) assertOnlySafeHrefs(html, href);
    });
  }

  it("removes the tags that navigate or load without an anchor", async () => {
    const html = await renderMdx(
      [
        '<base href="https://evil.example/" />',
        '<meta httpEquiv="refresh" content="0;url=//evil.example" />',
        '<iframe src="https://evil.example"></iframe>',
        '<form action="//evil.example"><button>Go</button></form>',
        '<img src="//evil.example/x.png" />',
        '<area href="//evil.example" />',
        "<script>alert(1)</script>",
        "",
        "Still here."
      ].join("\n")
    );
    assert.ok(html !== null);
    assert.doesNotMatch(html, /<(base|meta|iframe|form|img|area|script|button)\b/i, html);
    assert.doesNotMatch(html, /evil|alert/, html);
    assert.match(html, /Still here\./);
  });

  it("drops an unsafe URL attribute on an allowed tag, and every event handler", async () => {
    const html = await renderMdx('<blockquote cite="javascript:alert(1)" onClick="alert(1)">Quoted.</blockquote>');
    assert.ok(html !== null);
    assert.doesNotMatch(html, /cite=|onclick|alert/i, html);
    assert.match(html, /<blockquote>Quoted\.<\/blockquote>/);
  });

  it("still renders the links an author legitimately writes — markdown and JSX alike", async () => {
    const html = await renderMdx(
      'See [about](/about), <a href="/research">research</a>, <a href="https://example.org">a site</a> and [mail](mailto:a@b.org).'
    );
    assert.ok(html !== null);
    assert.deepEqual(hrefsIn(html), ["/about", "/research", "https://example.org", "mailto:a@b.org"]);
    assert.match(html, /target="_blank"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MDX — save
// ─────────────────────────────────────────────────────────────────────────────

describe("MDX, on save (mdxLinkProblems, which the news routes refuse on)", () => {
  it("refuses a raw <a href=\"//evil.example\"> (it used to be stored and published)", async () => {
    assert.deepEqual(await mdxLinkProblems('Read <a href="//evil.example">this</a>.'), ['<a href="//evil.example">']);
  });

  for (const href of BYPASS_CORPUS) {
    const attribute = jsxAttribute(href);
    if (attribute === null || attribute.trim().length === 0) continue;
    // MDX reads NUL as U+FFFD, so ` //evil.example` arrives as a bare relative path on this origin —
    // which the rich-text rule also allows — and the render test above shows it cannot leave the site.
    if (attribute.includes(" ")) continue;
    it(`refuses a JSX <a href=${JSON.stringify(href)}>`, async () => {
      const problems = await mdxLinkProblems(`Go <a href="${attribute}">there</a>.`);
      // Source the compiler cannot read renders nothing; anything it can read must be refused.
      const compiles = (await renderMdx(`Go <a href="${attribute}">there</a>.`)) !== null;
      if (compiles) assert.ok(problems.length > 0, `accepted ${JSON.stringify(href)}`);
    });
  }

  it("refuses a markdown link and a link definition the rule refuses", async () => {
    assert.equal((await mdxLinkProblems("[x](//evil.example)")).length, 1);
    assert.equal((await mdxLinkProblems("[x][r]\n\n[r]: /%2F%2Fevil.example\n")).length, 1);
    assert.equal((await mdxLinkProblems("[x](javascript:alert(1))")).length, 1);
  });

  it("refuses tags that navigate, load or run, an expression href and a spread", async () => {
    for (const source of [
      '<base href="https://evil.example/" />',
      '<meta httpEquiv="refresh" content="0;url=//evil.example" />',
      "<script>alert(1)</script>",
      '<iframe src="https://example.org"></iframe>',
      '<a href={"//evil.example"}>x</a>',
      "<a {...props}>x</a>",
      '<div onClick="alert(1)">x</div>'
    ]) {
      assert.ok((await mdxLinkProblems(source)).length > 0, source);
    }
  });

  it("accepts an ordinary article", async () => {
    const source = [
      "# Title",
      "",
      "See [about](/about), [a site](https://example.org), [mail](mailto:a@b.org), [here](#method)",
      'and <a href="/research">research</a>. A footnote-ish [ref][r].',
      "",
      "[r]: https://example.org/paper",
      "",
      '<MediaFigure objectKey="media/x.jpg" alt="A loom" />',
      "",
      "<details><summary>More</summary>Hidden text.</details>",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |"
    ].join("\n");
    assert.deepEqual(await mdxLinkProblems(source), []);
  });

  it("passes an empty body", async () => {
    assert.deepEqual(await mdxLinkProblems(""), []);
    assert.deepEqual(await mdxLinkProblems(null), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rich text — a document padded past the walker's limit
// ─────────────────────────────────────────────────────────────────────────────

describe("rich text on save: an oversized document fails closed", () => {
  const withLink = (href: string, padding: number) => ({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href } }] }] },
      ...new Array<number>(padding).fill(0)
    ]
  });

  it("refuses an unsafe link followed by 50,001 zeros (it used to report the document clean)", () => {
    const padded = withLink("//evil.example", MAX_RICH_TEXT_NODES + 1);
    assert.ok(JSON.stringify(padded).length < 150_000, "the payload is small");
    assert.equal(richTextLinksAreSafe(padded), false);
    assert.ok(unsafeRichTextHrefs(padded).includes(RICH_TEXT_TOO_LARGE));
    assert.equal(richTextSectionSchema.safeParse({ body: padded }).success, false);
  });

  it("refuses the same padding as a JSON string", () => {
    assert.equal(richTextLinksAreSafe(JSON.stringify(withLink("//evil.example", MAX_RICH_TEXT_NODES + 1))), false);
  });

  it("refuses a document past the limit even when its links are fine — it was never fully checked", () => {
    assert.equal(richTextLinksAreSafe(withLink("/about", MAX_RICH_TEXT_NODES + 1)), false);
  });

  it("still accepts a long but real article", () => {
    const paragraphs = Array.from({ length: 3_000 }, (_, index) => ({
      type: "paragraph",
      content: [
        { type: "text", text: `Paragraph ${index} ` },
        { type: "text", text: "link", marks: [{ type: "bold" }, { type: "link", attrs: { href: `/news/${index}` } }] }
      ]
    }));
    assert.equal(richTextLinksAreSafe({ type: "doc", content: paragraphs }), true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Render surfaces
// ─────────────────────────────────────────────────────────────────────────────

const linkDoc = (href: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "words", marks: [{ type: "link", attrs: { href } }] }] }]
});

describe("RichText (renderLink)", () => {
  for (const href of BYPASS_CORPUS) {
    it(`renders ${JSON.stringify(href)} as words with no unsafe href`, () => {
      const html = renderToStaticMarkup(createElement(RichText, { value: linkDoc(href) }));
      assertOnlySafeHrefs(html, href);
      assert.match(html, /words/);
    });
  }

  it("still links a path, a web address and an email address", () => {
    for (const href of ["/about", "https://example.org/", "mailto:a@b.org"]) {
      const html = renderToStaticMarkup(createElement(RichText, { value: linkDoc(href) }));
      assert.deepEqual(hrefsIn(html), [href]);
    }
  });
});

describe("MdxLink", () => {
  for (const href of BYPASS_CORPUS) {
    it(`renders ${JSON.stringify(href)} with no unsafe href`, () => {
      const html = renderToStaticMarkup(createElement(MdxLink, { href }, "words"));
      assertOnlySafeHrefs(html, href);
    });
  }

  it("still links a path and opens a web address beside the page", () => {
    assert.deepEqual(hrefsIn(renderToStaticMarkup(createElement(MdxLink, { href: "/about" }, "x"))), ["/about"]);
    const external = renderToStaticMarkup(createElement(MdxLink, { href: "https://example.org" }, "x"));
    assert.deepEqual(hrefsIn(external), ["https://example.org"]);
    assert.match(external, /noopener noreferrer/);
  });
});

describe("LinkButton", () => {
  for (const href of BYPASS_CORPUS) {
    it(`renders ${JSON.stringify(href)} with no href at all`, () => {
      const html = renderToStaticMarkup(createElement(LinkButton, { href }, "Go"));
      assert.deepEqual(hrefsIn(html), [], html);
    });
  }

  it("still links a path and a web address", () => {
    assert.deepEqual(hrefsIn(renderToStaticMarkup(createElement(LinkButton, { href: "/apply" }, "Go"))), ["/apply"]);
    assert.deepEqual(
      hrefsIn(renderToStaticMarkup(createElement(LinkButton, { href: "https://example.org" }, "Go"))),
      ["https://example.org"]
    );
  });
});

describe("SiteFooter (editor-written columns and navigation nodes)", () => {
  // SiteBrand (the studio door in the footer) calls `useRouter()` and the accessibility menu reads the
  // preferences context, so both are mounted as app/layout.tsx mounts them; an inert router stands in.
  const router = {
    back() {},
    forward() {},
    refresh() {},
    push() {},
    replace() {},
    prefetch() {}
  } as unknown as NonNullable<Parameters<typeof AppRouterContext.Provider>[0]["value"]>;
  const renderFooter = (href: string) =>
    renderToStaticMarkup(
      createElement(AppRouterContext.Provider, { value: router }, createElement(PreferencesProvider, null, createElement(SiteFooter, {
        branding: SETTINGS_DEFAULTS.branding,
        contact: SETTINGS_DEFAULTS.contact,
        social: { ...SETTINGS_DEFAULTS.social, links: [] },
        footer: { ...SETTINGS_DEFAULTS.footer, columns: [{ heading: "More", links: [{ label: "Column link", href }] }] },
        items: [
          { id: "n1", label: "Nav link", href, isExternal: false, children: [] },
          { id: "n2", label: "Nav external", href, isExternal: true, children: [] }
        ]
      })))
    );

  for (const href of BYPASS_CORPUS) {
    it(`renders ${JSON.stringify(href)} with no unsafe href`, () => {
      const html = renderFooter(href);
      assertOnlySafeHrefs(html, href);
      assert.match(html, /Column link/);
      assert.match(html, /Nav link/);
    });
  }

  it("still links a safe path in a column and in the menu", () => {
    const hrefs = hrefsIn(renderFooter("/visit"));
    assert.equal(hrefs.filter((href) => href === "/visit").length, 3);
  });
});

describe("assembleNavigation (the read-time filter getNavigation() applies)", () => {
  const row = (id: string, href: string, parentId: string | null = null): NavigationRow => ({
    id,
    label: id,
    href,
    isExternal: false,
    parentId,
    location: "header"
  });

  for (const href of BYPASS_CORPUS) {
    it(`leaves out a stored ${JSON.stringify(href)} and promotes its children`, () => {
      const tree = assembleNavigation([row("bad", href), row("child", "/child", "bad"), row("ok", "/ok")]);
      const ids = tree.header.map((node) => node.id);
      assert.deepEqual(ids.sort(), ["child", "ok"]);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Route validators
// ─────────────────────────────────────────────────────────────────────────────

describe("route validators, on save", () => {
  const nav = navigationHrefSchema();
  const publisher = publisherUrlSchema();

  for (const href of BYPASS_CORPUS) {
    if (href.trim().length === 0) continue;
    it(`refuse ${JSON.stringify(href)}`, () => {
      assert.equal(nav.safeParse(href).success, false, "navigation");
      assert.equal(isUsableRedirectDestination(href), false, "redirect");
      assert.equal(isStorableAnnouncementHref(href), false, "announcement");
      assert.equal(publisher.safeParse(href).success, false, "publisher");
    });
  }

  it("still accept what an editor legitimately enters", () => {
    for (const href of ["/about", "#top", "https://example.org", "mailto:a@b.org", "tel:+911234"]) {
      assert.equal(nav.safeParse(href).success, true, href);
      assert.equal(isStorableAnnouncementHref(href), true, href);
    }
    assert.equal(isStorableAnnouncementHref(null), true);
    for (const destination of ["/new-page", "https://example.org/x", "#section"]) {
      assert.equal(isUsableRedirectDestination(destination), true, destination);
    }
    assert.equal(isUsableRedirectDestination("mailto:a@b.org"), false);
    assert.equal(publisher.safeParse("https://doi.org/10.1/x").success, true);
    assert.equal(publisher.safeParse("").success, true);
    assert.equal(publisher.safeParse("/about").success, false);
  });
});
