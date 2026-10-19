import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { bibtexValueToText } from "@/lib/citation";
import { decodeHtmlEntities, stripTags } from "@/lib/html-text";

describe("decodeHtmlEntities", () => {
  it("decodes each entity once, never the output of another", () => {
    assert.equal(decodeHtmlEntities("&amp;lt;script&amp;gt;"), "&lt;script&gt;");
    assert.equal(decodeHtmlEntities("&amp;quot;"), "&quot;");
  });

  it("decodes the entities Commons emits, numeric ones included", () => {
    assert.equal(decodeHtmlEntities("A &amp; B &quot;C&quot; D&#39;s &#039;E&apos; &lt;F&gt;&nbsp;G"), "A & B \"C\" D's 'E' <F> G");
    assert.equal(decodeHtmlEntities("&#x263A; &#9731;"), "\u263a \u2603");
  });

  it("leaves unknown and out-of-range references alone", () => {
    assert.equal(decodeHtmlEntities("&bogus; &#0; &#x110000;"), "&bogus; &#0; &#x110000;");
  });
});

describe("stripTags", () => {
  it("removes a tag rebuilt by an earlier pass", () => {
    assert.equal(stripTags("<scr<b>ipt>alert(1)</scr</b>ipt>"), "alert(1)");
  });

  it("keeps the text and puts the replacement in each tag's place", () => {
    assert.equal(stripTags('<a href="/x">Name</a>'), "Name");
    assert.equal(stripTags("<span>Anonymous</span><span>Unknown</span>", " "), " Anonymous  Unknown ");
  });

  it("leaves a lone angle bracket that is text", () => {
    assert.equal(stripTags("3 < 4"), "3 < 4");
  });
});

describe("bibtexValueToText", () => {
  it("undoes every escape lib/citation.ts writes", () => {
    assert.equal(
      bibtexValueToText("\\textbackslash{} \\{ \\} \\$ \\% \\& \\# \\_ \\textasciicircum{} \\textasciitilde{}"),
      "\\ { } $ % & # _ ^ ~"
    );
  });

  it("does not let an unescaped backslash escape what follows it", () => {
    assert.equal(bibtexValueToText("C:\\textbackslash{}_tmp"), "C:\\_tmp");
    assert.equal(bibtexValueToText("\\textbackslash{}\\_"), "\\_");
  });

  it("turns protective braces into spaces", () => {
    assert.equal(bibtexValueToText("{{GANs for Bagru}}"), "  GANs for Bagru  ");
  });
});
