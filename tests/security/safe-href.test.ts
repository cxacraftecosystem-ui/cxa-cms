import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyHref,
  isExternalHref,
  isInternalHref,
  isSafeSitePath,
  isStorableHref,
  richTextLinksAreSafe,
  safeExternalHref,
  safeHref,
  safeRedirectDestination,
  unsafeRichTextHrefs
} from "@/lib/safe-href";

import { BYPASS_CORPUS } from "./href-corpus";

describe("classifyHref: the bypass corpus", () => {
  for (const href of BYPASS_CORPUS) {
    it(`refuses ${JSON.stringify(href)}`, () => {
      const classified = classifyHref(href);
      assert.equal(classified.kind, "unsafe");
      // A caller that forgets to check `kind` still cannot emit the dangerous value.
      assert.equal(classified.href, "");
      assert.equal(safeHref(href), null);
      assert.equal(safeHref(href, { relative: true }), null);
      assert.equal(isInternalHref(href), false);
      assert.equal(isExternalHref(href), false);
      assert.equal(isStorableHref(href), false);
      assert.equal(isStorableHref(href, { relative: true }), false);
    });
  }
});

describe("classifyHref: what is still a link", () => {
  const cases: [string, string, string][] = [
    ["/", "internal", "/"],
    ["/about", "internal", "/about"],
    ["/about?x=1#y", "internal", "/about?x=1#y"],
    ["/research/heritage-ai", "internal", "/research/heritage-ai"],
    ["/research//double", "internal", "/research//double"],
    ["/caf%C3%A9", "internal", "/caf%C3%A9"],
    ["/a%20b", "internal", "/a%20b"],
    ["/?q=1", "internal", "/?q=1"],
    ["/#top", "internal", "/#top"],
    ["  /about  ", "internal", "/about"],
    ["#method", "same-page", "#method"],
    ["?page=2", "same-page", "?page=2"],
    ["https://example.org", "external", "https://example.org"],
    ["http://example.org/x?y#z", "external", "http://example.org/x?y#z"],
    ["HTTPS://Example.org/", "external", "HTTPS://Example.org/"],
    ["mailto:office@example.org", "contact", "mailto:office@example.org"],
    ["tel:+913222255221", "contact", "tel:+913222255221"],
    ["example.org/page", "relative", "example.org/page"],
    ["about", "relative", "about"],
    ["", "empty", ""],
    ["   ", "empty", ""]
  ];
  for (const [input, kind, href] of cases) {
    it(`${JSON.stringify(input)} is ${kind}`, () => {
      assert.deepEqual(classifyHref(input), { kind, href });
    });
  }

  it("is total over non-strings", () => {
    assert.equal(classifyHref(null).kind, "empty");
    assert.equal(classifyHref(undefined).kind, "empty");
    assert.equal(classifyHref(42).kind, "empty");
  });

  it("refuses a bare relative href unless the caller opts in", () => {
    assert.equal(safeHref("example.org"), null);
    assert.equal(safeHref("example.org", { relative: true }), "example.org");
    assert.equal(isStorableHref("example.org"), false);
    assert.equal(isStorableHref("example.org", { relative: true }), true);
  });

  it("honours a policy that excludes contact and same-page links", () => {
    assert.equal(safeHref("mailto:a@b.org", { contact: false }), null);
    assert.equal(safeHref("#x", { samePage: false }), null);
    assert.equal(safeExternalHref("mailto:a@b.org"), null);
    assert.equal(safeExternalHref("/about"), null);
    assert.equal(safeExternalHref("https://doi.org/10.1/x"), "https://doi.org/10.1/x");
  });
});

describe("classifyHref with the site's own host", () => {
  const siteHost = "cxa.example.org";

  it("reduces an absolute URL on this site to its path", () => {
    assert.deepEqual(classifyHref("https://cxa.example.org/news?x=1#y", { siteHost }), {
      kind: "internal",
      href: "/news?x=1#y"
    });
  });

  it("does not turn an absolute URL into a protocol-relative path", () => {
    // `${pathname}` of this URL is `//evil.example` — handed to next/link it would leave the site.
    assert.equal(classifyHref("https://cxa.example.org//evil.example", { siteHost }).kind, "external");
    assert.equal(classifyHref("https://cxa.example.org/%2F%2Fevil.example", { siteHost }).kind, "external");
  });

  it("keeps another host, including one hidden behind userinfo, external", () => {
    assert.equal(classifyHref("https://cxa.example.org@evil.example/", { siteHost }).kind, "external");
    assert.equal(classifyHref("https://cxa.example.org.evil.example/", { siteHost }).kind, "external");
  });
});

describe("isStorableHref (save time)", () => {
  it("refuses a control character anywhere, rather than cleaning it", () => {
    assert.equal(isStorableHref("/ab\tout"), false);
    assert.equal(isStorableHref("https://example.org/\nx"), false);
    assert.equal(isStorableHref("/about"), true);
  });

  it("refuses an empty value — a schema that allows none says so itself", () => {
    assert.equal(isStorableHref(""), false);
    assert.equal(isStorableHref(null), false);
  });
});

describe("isSafeSitePath", () => {
  it("accepts ordinary paths and refuses the protocol-relative family", () => {
    assert.equal(isSafeSitePath("/studio/pages"), true);
    assert.equal(isSafeSitePath("/"), true);
    for (const path of ["//evil.example", "/\\evil.example", "/%2F%2Fevil.example", "/%5Cevil", "/\t/evil", "about"]) {
      assert.equal(isSafeSitePath(path), false, path);
    }
  });
});

describe("safeRedirectDestination (a Location header)", () => {
  const cases: [string, string | null][] = [
    ["/new-page", "/new-page"],
    ["new-page", "/new-page"],
    ["//example.com", "/example.com"],
    ["///example.com", "/example.com"],
    ["https://example.org/x", "https://example.org/x"],
    ["#section", "#section"],
    ["?q=1", "?q=1"],
    ["/\\evil.example", null],
    ["\\\\evil.example", null],
    ["/%2F%2Fevil.example", null],
    ["/%5Cevil.example", null],
    ["https:\\\\evil.example", null],
    ["", null],
    ["   ", null]
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      assert.equal(safeRedirectDestination(input), expected);
    });
  }

  it("never yields a value that leaves the site unless it is an explicit http(s) URL", () => {
    for (const href of BYPASS_CORPUS) {
      const destination = safeRedirectDestination(href);
      if (destination === null) continue;
      assert.ok(destination.startsWith("/") && isSafeSitePath(destination), `${JSON.stringify(href)} → ${destination}`);
    }
  });
});

describe("rich-text documents (save-time check of every link mark)", () => {
  const doc = (href: string) => ({
    type: "doc",
    content: [
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "go", marks: [{ type: "bold" }, { type: "link", attrs: { href } }] }]
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  });

  it("finds an unsafe link however deep it is nested", () => {
    for (const href of BYPASS_CORPUS) {
      if (href.trim().length === 0) continue;
      assert.equal(richTextLinksAreSafe(doc(href)), false, JSON.stringify(href));
    }
  });

  it("accepts the links the editor can legitimately make", () => {
    for (const href of ["/about", "#x", "https://example.org", "mailto:a@b.org", "tel:+91", "example.org"]) {
      assert.equal(richTextLinksAreSafe(doc(href)), true, href);
    }
  });

  it("reads a document stored as a JSON string, and passes absent values", () => {
    assert.deepEqual(unsafeRichTextHrefs(JSON.stringify(doc("//evil.example"))), ["//evil.example"]);
    assert.equal(richTextLinksAreSafe(null), true);
    assert.equal(richTextLinksAreSafe(undefined), true);
    assert.equal(richTextLinksAreSafe({ type: "doc", content: [] }), true);
  });
});
