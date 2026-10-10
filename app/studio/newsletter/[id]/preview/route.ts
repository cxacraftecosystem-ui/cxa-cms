import { NextResponse, type NextRequest } from "next/server";

import { route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { siteUrl } from "@/lib/env";
import { personaliseIssueEmail } from "@/lib/newsletter/email-layout";
import { renderIssue } from "@/lib/newsletter/issues";
import { loadIssue } from "@/lib/newsletter/issue-studio";
import { NEWSLETTER_UNSUBSCRIBE_PATH } from "@/lib/newsletter/paths";
import { canAuthor } from "@/lib/permissions";

/**
 * The issue as a subscriber receives it — the same HTML the drain sends, from the same renderer — for the
 * studio's preview frame and its "Open the preview" link.
 *
 * A ROUTE HANDLER under app/studio, like the subscribers export: `proxy.ts` has already sent a signed-out
 * visitor to the login screen, and `requireCapability` answers anybody signed in without the rank.
 *
 * The unsubscribe link points at the unsubscribe page with no token — a preview belongs to nobody, and a
 * working link signed for the viewer would unsubscribe a member of staff who clicked it to see where it
 * went. `?text=1` shows the plain-text part instead.
 *
 * ⚠ THE DOCUMENT CARRIES ITS OWN `<meta>` CSP WITH NO SCRIPT SOURCE AT ALL. The body is an editor's
 * document rendered through an escaping renderer (lib/newsletter/email-richtext.ts), and this is the
 * second wall: if anything ever slipped through, it still could not run in the studio's origin. It is a
 * meta element rather than a response header because next.config.ts sets the CSP header on every studio
 * response and replaces one set here; a meta policy is enforced in addition to the header. The studio's
 * preview frame is also sandboxed with no permissions.
 */

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const PREVIEW_POLICY = "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; form-action 'none'";

export const GET = route(async (request: NextRequest, context: Context) => {
  await requireCapability(canAuthor, "Previewing a newsletter issue needs author access or higher.");
  const { id } = await context.params;
  const issue = await loadIssue(id);

  const rendered = personaliseIssueEmail(renderIssue(issue), `${siteUrl()}${NEWSLETTER_UNSUBSCRIBE_PATH}`);
  const wantsText = new URL(request.url).searchParams.get("text") === "1";

  const html = rendered.html.replace(
    "<head>",
    `<head>
<meta http-equiv="Content-Security-Policy" content="${PREVIEW_POLICY}">`
  );

  return new NextResponse(wantsText ? rendered.text : html, {
    status: 200,
    headers: {
      "content-type": wantsText ? "text/plain; charset=utf-8" : "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
});
