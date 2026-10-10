import { EMAIL_COLOURS, escapeAttr, escapeHtml } from "@/lib/newsletter/email-richtext";

/**
 * The frame every newsletter issue is sent in: a table-based, inline-styled layout that renders the same
 * in Gmail, Outlook (Word's renderer, on Windows) and Apple Mail, plus the plain-text alternative.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE RULES THIS MARKUP KEEPS, BECAUSE EACH ONE IS A CLIENT THAT BREAKS WITHOUT IT
 *
 *   • **Tables for layout, never flex or grid.** Outlook's Word engine knows neither.
 *   • **Every style inline.** Gmail drops `<style>` in several contexts (forwarded mail, non-Google
 *     accounts in the app); a single `<style>` block is kept only for the progressive mobile tweak.
 *   • **A fixed 600px column with `max-width` fallbacks**, centred by an outer 100% table — the width
 *     every client agrees on.
 *   • **The preheader is a hidden first element.** Clients show the first text they find after the
 *     subject; without it that would be "View this in your browser" or the site name.
 *   • **The unsubscribe link is visible, in words, in the footer** — not only in the header — because a
 *     reader who never sees their client's button must still be able to leave in one click.
 *
 * ⚠ THE UNSUBSCRIBE URL IS A PLACEHOLDER UNTIL `personaliseIssueEmail`. The issue is rendered ONCE per
 * batch and personalised per recipient by a string replacement, which is what lets a send to thousands
 * of readers render the document once rather than thousands of times.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const UNSUBSCRIBE_PLACEHOLDER = "{{cxa-newsletter-unsubscribe-url}}";

export interface IssueEmailInput {
  title: string;
  preheader: string | null;
  /** From `richTextToEmailHtml`. */
  bodyHtml: string;
  /** From `richTextToEmailText`. */
  bodyText: string;
  siteName: string;
  siteOrigin: string;
  /** A test copy is labelled so in the body as well as in the subject. */
  isTest?: boolean;
}

export interface RenderedIssueEmail {
  html: string;
  text: string;
}

const FONT_STACK = "'Plus Jakarta Sans', 'Segoe UI', Helvetica, Arial, sans-serif";

export function renderIssueEmail(input: IssueEmailInput): RenderedIssueEmail {
  const siteName = escapeHtml(input.siteName);
  const siteHref = escapeAttr(`${input.siteOrigin}/`);
  const preheader = input.preheader ? escapeHtml(input.preheader) : "";

  const testBanner = input.isTest
    ? `<tr><td style="padding:10px 32px;background:${EMAIL_COLOURS.highlight};font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${EMAIL_COLOURS.ink};">This is a test copy. It has been sent only to you.</td></tr>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(input.title)}</title>
<!--[if mso]><style>table,td,h1,h2,h3,h4,p,a,li{font-family:Arial,sans-serif !important;}</style><![endif]-->
<style>
@media only screen and (max-width:620px){.cxa-container{width:100% !important;}.cxa-pad{padding-left:20px !important;padding-right:20px !important;}}
</style>
</head>
<body style="margin:0;padding:0;background:${EMAIL_COLOURS.panel};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${EMAIL_COLOURS.panel};opacity:0;">${preheader}${"&#847;&zwnj;&nbsp;".repeat(preheader ? 40 : 0)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${EMAIL_COLOURS.panel};border-collapse:collapse;">
<tr><td align="center" style="padding:24px 12px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" class="cxa-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border:1px solid ${EMAIL_COLOURS.line};border-collapse:collapse;">
<tr><td class="cxa-pad" style="padding:24px 32px 12px 32px;border-top:4px solid ${EMAIL_COLOURS.brand};font-family:${FONT_STACK};font-size:14px;line-height:20px;font-weight:700;letter-spacing:0.02em;"><a href="${siteHref}" style="color:${EMAIL_COLOURS.brand};text-decoration:none;">${siteName}</a></td></tr>
${testBanner}
<tr><td class="cxa-pad" style="padding:12px 32px 8px 32px;"><h1 style="margin:0;font-family:${FONT_STACK};font-size:28px;line-height:36px;font-weight:700;color:${EMAIL_COLOURS.ink};">${escapeHtml(input.title)}</h1></td></tr>
<tr><td class="cxa-pad" style="padding:16px 32px 16px 32px;">${input.bodyHtml}</td></tr>
<tr><td class="cxa-pad" style="padding:20px 32px 28px 32px;border-top:1px solid ${EMAIL_COLOURS.line};font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${EMAIL_COLOURS.muted};">
<p style="margin:0 0 8px 0;">You are receiving this because you subscribed to the ${siteName} newsletter and confirmed your address.</p>
<p style="margin:0;"><a href="${UNSUBSCRIBE_PLACEHOLDER}" style="color:${EMAIL_COLOURS.brand};text-decoration:underline;">Unsubscribe</a> &middot; one click, no account needed. &middot; <a href="${siteHref}" style="color:${EMAIL_COLOURS.muted};text-decoration:underline;">${escapeHtml(input.siteOrigin.replace(/^https?:\/\//, ""))}</a></p>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;

  const rule = "-".repeat(40);
  const text = [
    input.isTest ? "[TEST COPY — sent only to you]\n" : "",
    input.title,
    "",
    input.bodyText,
    "",
    rule,
    `You are receiving this because you subscribed to the ${input.siteName} newsletter and confirmed your address.`,
    `Unsubscribe in one click, no account needed: ${UNSUBSCRIBE_PLACEHOLDER}`,
    `${input.siteName} — ${input.siteOrigin}/`
  ]
    .filter((line, index) => !(index === 0 && line === ""))
    .join("\n");

  return { html, text };
}

/** One recipient's copy: the placeholder replaced by their own unsubscribe link. */
export function personaliseIssueEmail(rendered: RenderedIssueEmail, unsubscribeUrl: string): RenderedIssueEmail {
  return {
    html: rendered.html.split(UNSUBSCRIBE_PLACEHOLDER).join(escapeAttr(unsubscribeUrl)),
    text: rendered.text.split(UNSUBSCRIBE_PLACEHOLDER).join(unsubscribeUrl)
  };
}

// ── Account mail ────────────────────────────────────────────────────────────────────────────────────

export interface AccountEmailInput {
  /** The heading, and the HTML `<title>`. */
  title: string;
  /** The hidden first line clients show beside the subject. */
  preheader: string;
  /** Paragraphs of plain text, before the button. Escaped here; never HTML. */
  intro: readonly string[];
  /** The one link the message exists to carry, and the words on its button. */
  action: { label: string; url: string };
  /** Paragraphs of plain text, after the button. Escaped here; never HTML. */
  outro: readonly string[];
  /** Why this message was sent, in the footer. */
  reason: string;
  siteName: string;
  siteOrigin: string;
}

/**
 * The frame for ACCOUNT mail (a password-reset link) — THE SAME TABLE LAYOUT AS AN ISSUE, minus the
 * newsletter's promises.
 *
 * It keeps every rule in this file's header that is about clients (tables, inline styles, a 600px column,
 * the hidden preheader), and it drops the two that are about subscription: there is no unsubscribe link and
 * no `UNSUBSCRIBE_PLACEHOLDER`, because this is not a mailing and the recipient is not on one. Saying "you
 * are receiving this because you subscribed" on a password link would be false, and an unsubscribe link on
 * it would offer to stop something that was never started.
 *
 * ⚠ NO TRACKING. No pixel, no remote image at all, and the action URL is written VERBATIM into both parts,
 * once as the button and once as text the reader can copy — a client that strips links, or a reader who
 * will not click one in an email (which is the right instinct), can still paste it.
 *
 * Every string is plain text and escaped here. Nothing a caller passes is treated as markup.
 */
export function renderAccountEmail(input: AccountEmailInput): RenderedIssueEmail {
  const siteName = escapeHtml(input.siteName);
  const siteHref = escapeAttr(`${input.siteOrigin}/`);
  const actionHref = escapeAttr(input.action.url);
  const paragraph = (text: string) =>
    `<p style="margin:0 0 16px 0;font-family:${FONT_STACK};font-size:16px;line-height:26px;color:${EMAIL_COLOURS.body};">${escapeHtml(text)}</p>`;

  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(input.title)}</title>
<!--[if mso]><style>table,td,h1,h2,h3,h4,p,a,li{font-family:Arial,sans-serif !important;}</style><![endif]-->
<style>
@media only screen and (max-width:620px){.cxa-container{width:100% !important;}.cxa-pad{padding-left:20px !important;padding-right:20px !important;}}
</style>
</head>
<body style="margin:0;padding:0;background:${EMAIL_COLOURS.panel};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${EMAIL_COLOURS.panel};opacity:0;">${escapeHtml(input.preheader)}${"&#847;&zwnj;&nbsp;".repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${EMAIL_COLOURS.panel};border-collapse:collapse;">
<tr><td align="center" style="padding:24px 12px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" class="cxa-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border:1px solid ${EMAIL_COLOURS.line};border-collapse:collapse;">
<tr><td class="cxa-pad" style="padding:24px 32px 12px 32px;border-top:4px solid ${EMAIL_COLOURS.brand};font-family:${FONT_STACK};font-size:14px;line-height:20px;font-weight:700;letter-spacing:0.02em;"><a href="${siteHref}" style="color:${EMAIL_COLOURS.brand};text-decoration:none;">${siteName}</a></td></tr>
<tr><td class="cxa-pad" style="padding:12px 32px 8px 32px;"><h1 style="margin:0;font-family:${FONT_STACK};font-size:24px;line-height:32px;font-weight:700;color:${EMAIL_COLOURS.ink};">${escapeHtml(input.title)}</h1></td></tr>
<tr><td class="cxa-pad" style="padding:16px 32px 0 32px;">${input.intro.map(paragraph).join("")}</td></tr>
<tr><td class="cxa-pad" style="padding:0 32px 16px 32px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td style="border-radius:6px;background:${EMAIL_COLOURS.brand};"><a href="${actionHref}" style="display:inline-block;padding:12px 22px;font-family:${FONT_STACK};font-size:16px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(input.action.label)}</a></td></tr></table>
<p style="margin:16px 0 0 0;font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${EMAIL_COLOURS.muted};">If the button does not work, copy this address into your browser:<br><a href="${actionHref}" style="color:${EMAIL_COLOURS.brand};text-decoration:underline;word-break:break-all;">${escapeHtml(input.action.url)}</a></p>
</td></tr>
<tr><td class="cxa-pad" style="padding:8px 32px 8px 32px;">${input.outro.map(paragraph).join("")}</td></tr>
<tr><td class="cxa-pad" style="padding:20px 32px 28px 32px;border-top:1px solid ${EMAIL_COLOURS.line};font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${EMAIL_COLOURS.muted};">
<p style="margin:0;">${escapeHtml(input.reason)} &middot; <a href="${siteHref}" style="color:${EMAIL_COLOURS.muted};text-decoration:underline;">${escapeHtml(input.siteOrigin.replace(/^https?:\/\//, ""))}</a></p>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;

  const rule = "-".repeat(40);
  const text = [
    input.title,
    "",
    ...input.intro.flatMap((line) => [line, ""]),
    `${input.action.label}:`,
    input.action.url,
    "",
    ...input.outro.flatMap((line) => [line, ""]),
    rule,
    input.reason,
    `${input.siteName} — ${input.siteOrigin}/`
  ].join("\n");

  return { html, text };
}
