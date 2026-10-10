import "../newsletter/setup";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyEditorHref, isStorableEditorHref } from "@/components/studio/editor/extensions";
import { safeEmailHref } from "@/lib/newsletter/email-richtext";
import {
  formEmbedSectionSchema,
  linkGridSectionSchema,
  richTextSectionSchema
} from "@/lib/sections/schema";
import { footerLinkSchema, socialLinkSchema } from "@/lib/settings/schema";

import { BYPASS_CORPUS } from "./href-corpus";

/**
 * The surfaces that classified links on their own before lib/safe-href.ts existed — the rich-text
 * editor, the newsletter renderer, and the save-time schemas for section blocks and site settings.
 * Each of them accepted `//evil.example` or `/\evil.example` as "a page on this site". These import
 * only the surfaces themselves, so they exercise the rule each one actually applies.
 */

const SITE = "https://cxa.example.org";

/** The protocol-relative family: the ones a "starts with /" test called internal. */
const LOOKS_INTERNAL = BYPASS_CORPUS.filter((href) => /^[\s\u0000-\u001f]*[/\\]/.test(href));

describe("the rich-text editor (LinkDialog, paste and autolink)", () => {
  for (const href of BYPASS_CORPUS) {
    it(`refuses ${JSON.stringify(href)}`, () => {
      const classified = classifyEditorHref(href);
      assert.notEqual(classified.kind, "internal");
      assert.notEqual(classified.kind, "external");
      assert.equal(isStorableEditorHref(href), false);
    });
  }

  it("still accepts what an author legitimately types", () => {
    assert.equal(classifyEditorHref("/about").kind, "internal");
    assert.equal(classifyEditorHref("#method").kind, "internal");
    assert.equal(classifyEditorHref("https://example.org").kind, "external");
    assert.equal(classifyEditorHref("mailto:a@b.org").kind, "plain");
    assert.deepEqual(classifyEditorHref("example.org"), {
      kind: "no-protocol",
      href: "example.org",
      suggestion: "https://example.org"
    });
  });
});

describe("the newsletter renderer", () => {
  for (const href of LOOKS_INTERNAL) {
    it(`refuses ${JSON.stringify(href)} rather than resolving it against the site`, () => {
      assert.equal(safeEmailHref(href, SITE), null);
    });
  }

  it("still resolves a real site path and keeps an external one", () => {
    assert.equal(safeEmailHref("/news/x", SITE), `${SITE}/news/x`);
    assert.equal(safeEmailHref("https://example.org/a", SITE), "https://example.org/a");
    assert.equal(safeEmailHref("mailto:a@b.org", SITE), "mailto:a@b.org");
  });
});

describe("section blocks, on save", () => {
  const linkGrid = (href: string) =>
    linkGridSectionSchema.safeParse({ items: [{ label: "x", description: "", href, icon: "", external: false }] });

  for (const href of BYPASS_CORPUS) {
    if (href.trim().length === 0) continue;
    it(`a link field refuses ${JSON.stringify(href)}`, () => {
      assert.equal(linkGrid(href).success, false);
    });
  }

  it("a link field still accepts a path, an anchor, a web address and an empty value", () => {
    for (const href of ["/about", "#x", "https://example.org", "mailto:a@b.org", ""]) {
      assert.equal(linkGrid(href).success, true, href);
    }
  });

  it("a rich-text block refuses a document carrying an unsafe link mark", () => {
    const body = (href: string) => ({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href } }] }] }]
    });
    for (const href of ["//evil.example", "/\\evil.example", "/%2F%2Fevil.example", "javascript:alert(1)"]) {
      assert.equal(richTextSectionSchema.safeParse({ body: body(href) }).success, false, href);
    }
    assert.equal(richTextSectionSchema.safeParse({ body: body("/about") }).success, true);
  });

  it("a form embed refuses an https address whose host is not where it appears to be", () => {
    for (const url of ["https://\\evil.example/form", "https:///evil.example/form"]) {
      assert.equal(formEmbedSectionSchema.safeParse({ title: "Sign up", url }).success, false, url);
    }
    assert.equal(formEmbedSectionSchema.safeParse({ title: "Sign up", url: "https://docs.google.com/forms/d/e/x/viewform" }).success, true);
  });
});

describe("site settings, on save", () => {
  for (const href of LOOKS_INTERNAL) {
    if (href.trim().length === 0) continue;
    it(`a footer link refuses ${JSON.stringify(href)}`, () => {
      assert.equal(footerLinkSchema.safeParse({ label: "x", href }).success, false);
    });
  }

  it("a footer link still accepts a path and a web address", () => {
    assert.equal(footerLinkSchema.safeParse({ label: "x", href: "/about" }).success, true);
    assert.equal(footerLinkSchema.safeParse({ label: "x", href: "https://example.org" }).success, true);
  });

  it("a social link refuses an http(s) address whose host is not where it appears to be", () => {
    assert.equal(socialLinkSchema.safeParse({ platform: "website", url: "https://example.org" }).success, true);
    for (const url of ["https://\\evil.example", "https:///evil.example"]) {
      assert.equal(socialLinkSchema.safeParse({ platform: "website", url }).success, false, url);
    }
  });
});
