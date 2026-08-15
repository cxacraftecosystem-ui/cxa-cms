import { ok, route } from "@/lib/api";
import { requireUser } from "@/lib/auth/current-user";

/**
 * Who is signed in.
 *
 * `requireUser()` RE-READS THE ROW rather than trusting the token, so the answer reflects a
 * demotion, a deactivation or a soft delete immediately instead of up to thirty minutes later when
 * the access token expires. That matters here more than it looks: this is the endpoint a studio
 * screen calls to decide which controls to render, and a stale role would draw buttons whose
 * requests the server is going to refuse — the "disabled control that lands on a refusal" the
 * contract forbids.
 *
 * A missing or expired session answers 401 through `route()`. The browser client treats that as its
 * cue to refresh once and retry, so a page opened after a long pause recovers on its own.
 */

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireUser();
  return ok({ user });
});
