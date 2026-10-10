import "./setup";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { composeConfirmation, composeUnsubscribeReceipt, composeWelcome } from "@/lib/newsletter/delivery";
import { personaliseIssueEmail, renderIssueEmail, UNSUBSCRIBE_PLACEHOLDER } from "@/lib/newsletter/email-layout";
import { richTextToEmailHtml, richTextToEmailText, safeEmailHref } from "@/lib/newsletter/email-richtext";
import { composeIssueMessage } from "@/lib/newsletter/issues";
import { LIST_UNSUBSCRIBE_POST_VALUE, listUnsubscribeHeaders } from "@/lib/newsletter/list-unsubscribe";
import { NEWSLETTER_ONE_CLICK_ENDPOINT } from "@/lib/newsletter/paths";
import { oneClickUnsubscribeUrlFor, verifyNewsletterToken } from "@/lib/newsletter/tokens";
import type { RichTextDoc } from "@/lib/richtext";

const SITE = "https://cxa.example.org";

describe("List-Unsubscribe headers (RFC 2369 / RFC 8058)", () => {
  it("names the one-click URL in angle brackets, with the One-Click POST signal", () => {
    const headers = listUnsubscribeHeaders("https://cxa.example.org/api/public/newsletter/one-click?token=v1.x.y");
    assert.deepEqual(headers, [
      { name: "List-Unsubscribe", value: "<https://cxa.example.org/api/public/newsletter/one-click?token=v1.x.y>" },
      { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" }
    ]);
    assert.equal(LIST_UNSUBSCRIBE_POST_VALUE, "List-Unsubscribe=One-Click");
  });

  it("refuses a URL that would break the header's syntax", () => {
    assert.throws(() => listUnsubscribeHeaders("https://a.example/x?y=1,2"));
    assert.throws(() => listUnsubscribeHeaders("https://a.example/x y"));
  });

  it("builds the one-click URL on the site's origin with a verifiable, non-expiring unsubscribe token", () => {
    const url = new URL(oneClickUnsubscribeUrlFor("reader@example.org"));
    assert.equal(url.origin, new URL(process.env.NEXT_PUBLIC_SITE_URL as string).origin);
    assert.equal(url.pathname, NEWSLETTER_ONE_CLICK_ENDPOINT);
    const verified = verifyNewsletterToken("unsubscribe", url.searchParams.get("token"));
    assert.ok(verified.ok);
    assert.equal(verified.ok && verified.emailKey, "reader@example.org");
    assert.equal(verified.ok && verified.expiresAt, null);
    // A confirm-purpose check must refuse it: the purpose is inside the signature.
    assert.equal(verifyNewsletterToken("confirm", url.searchParams.get("token")).ok, false);
  });

  it("is carried by mail to subscribers and never by a confirmation or a receipt", () => {
    const recipient = { to: "Reader@example.org", emailKey: "reader@example.org", subscriberId: "s1" };
    const names = (headers: { name: string }[]) => headers.map((header) => header.name);
    assert.deepEqual(names(composeWelcome(recipient).headers), ["List-Unsubscribe", "List-Unsubscribe-Post"]);
    assert.deepEqual(
      composeConfirmation({ ...recipient, nonce: "n".repeat(32), expiresAt: new Date(Date.now() + 3_600_000) }).headers,
      []
    );
    assert.deepEqual(composeUnsubscribeReceipt(recipient).headers, []);
  });
});

const DOC: RichTextDoc = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "From the field" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Read " },
        { type: "text", text: "the report", marks: [{ type: "link", attrs: { href: "/publications/report" } }] },
        { type: "text", text: " <script>alert(1)</script> & more." }
      ]
    },
    {
      type: "paragraph",
      content: [{ type: "text", text: "bad link", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }]
    },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "One" }] }] }] }
  ]
};

describe("the issue email", () => {
  it("escapes text, resolves relative links and drops unsafe ones", () => {
    const html = richTextToEmailHtml(DOC, { siteOrigin: SITE });
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; more."));
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes(`href="${SITE}/publications/report"`));
    assert.ok(!html.includes("javascript:"));
    assert.ok(html.includes("<ul"));
    assert.equal(safeEmailHref("data:text/html,x", SITE), null);
    assert.equal(safeEmailHref("mailto:a@b.org", SITE), "mailto:a@b.org");
  });

  it("has a plain-text part with links written out", () => {
    const text = richTextToEmailText(DOC, { siteOrigin: SITE });
    assert.ok(text.includes("FROM THE FIELD"));
    assert.ok(text.includes(`the report (${SITE}/publications/report)`));
    assert.ok(text.includes("- One"));
  });

  it("is a table layout with inline styles, a hidden preheader and a visible unsubscribe link", () => {
    const rendered = renderIssueEmail({
      title: "Autumn",
      preheader: "Three new crafts",
      bodyHtml: "<p>x</p>",
      bodyText: "x",
      siteName: "Centre of Excellence",
      siteOrigin: SITE
    });
    assert.ok(rendered.html.startsWith("<!DOCTYPE html>"));
    assert.ok(rendered.html.includes('role="presentation"'));
    assert.ok(rendered.html.includes("Three new crafts"));
    assert.ok(rendered.html.includes(">Unsubscribe</a>"));
    assert.ok(!/class="[^"]*"[^>]*>\s*<p>x/.test(rendered.html) || rendered.html.includes("style="));

    const personal = personaliseIssueEmail(rendered, "https://cxa.example.org/newsletter/unsubscribe?token=v1.a.b");
    assert.ok(!personal.html.includes(UNSUBSCRIBE_PLACEHOLDER));
    assert.ok(!personal.text.includes(UNSUBSCRIBE_PLACEHOLDER));
    assert.ok(personal.text.includes("https://cxa.example.org/newsletter/unsubscribe?token=v1.a.b"));
  });

  it("composes one copy per recipient with their own links and the one-click headers", () => {
    const rendered = renderIssueEmail({
      title: "Autumn",
      preheader: null,
      bodyHtml: "<p>x</p>",
      bodyText: "x",
      siteName: "Centre of Excellence",
      siteOrigin: SITE
    });
    const message = composeIssueMessage(
      rendered,
      { subject: "Autumn issue" },
      { to: "A@example.org", emailKey: "a@example.org", subscriberId: "s1" },
      "ISSUE"
    );
    assert.equal(message.subject, "Autumn issue");
    assert.ok(message.bodyHtml?.includes("/newsletter/unsubscribe?token="));
    assert.equal(message.headers[0]?.name, "List-Unsubscribe");
    assert.ok(message.headers[0]?.value.includes(NEWSLETTER_ONE_CLICK_ENDPOINT));

    const test = composeIssueMessage(rendered, { subject: "Autumn issue" }, { to: "me@example.org", emailKey: "me@example.org", subscriberId: null }, "ISSUE_TEST");
    assert.equal(test.subject, "[Test] Autumn issue");
  });
});
