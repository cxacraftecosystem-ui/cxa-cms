import { NextRequest } from "next/server";

import { assertSameOrigin, badRequest, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { canManageResearch } from "@/lib/permissions";
// The real import handler. See the header: this route FORWARDS to it rather than parsing anything itself.
import { POST as runImport } from "../route";

/**
 * The first step of importing publications: read the paste, say what is in it, CREATE NOTHING.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS ROUTE PARSES NOTHING. IT FORWARDS.
 *
 * `../route.ts` already answers exactly this question at `POST …/import?dryRun=1`: it reads BibTeX or a
 * list of DOIs, matches every row against what is already here — the DOI first, then the normalised title
 * and year — and answers `{ candidates, unreadable, truncated, limit }` without writing a thing. Its own
 * header names this file as one of the two acceptable fixes for the address the workbench calls.
 *
 * A SECOND PARSER HERE WOULD BE WORSE THAN NO PREVIEW AT ALL. The preview's only job is to tell somebody
 * what pressing Import will do. Two parsers cannot be kept in step — BibTeX brace matching, arXiv
 * detection, author-line separators, the duplicate rules, the row keys the Import step ticks — and the
 * first time they disagreed, the preview would be a confident description of something that then did not
 * happen. So there is one parser, one duplicate rule and one set of row keys, and this file is the
 * address they answer at.
 *
 * ⚠ THE `dryRun` FLAG IS FORCED, AND `keys` IS STRIPPED. Two independent guards for one property: a
 * request to THIS address can never create a publication. The forwarded handler treats a body with no
 * `keys` array as a dry run anyway, and it ignores `keys` entirely when the flag is set — so removing them
 * discards nothing a preview would have used. Both are here because the flag and the absence of `keys`
 * live in one `if` in another file, and this address must stay safe if that `if` is ever rewritten.
 *
 * ⚠ IT SHARES THE IMPORT'S RATE LIMIT, on purpose. The DOI path makes one outbound request to doi.org per
 * row, and a preview does that work whether or not anything is created — so a preview costs the same as an
 * import and is counted the same. A separate allowance here would be a way to make sixty lookups a
 * time without ever spending the import's budget.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const POST = route(async (request: NextRequest) => {
  // Both checks happen again inside the forwarded handler, which is the real boundary. They are here so a
  // request from another site, or from somebody without access, is refused before a paste is read at all —
  // and so this file cannot be mistaken for an unguarded address.
  assertSameOrigin(request);
  await requireCapability(
    canManageResearch,
    "Importing publications needs researcher access or higher. An administrator can raise yours."
  );

  const raw = await request.text();

  /**
   * The body, with any `keys` removed.
   *
   * Read here ONLY to drop that one field. Everything else — the `source` enum, the paste's length, the
   * shape of the whole body — is validated by the forwarded handler's own schema, so a malformed body
   * produces its message and not a second one worded differently.
   */
  let forwardedBody = raw;
  if (raw.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // The same sentence `parseJson` gives, because it is the same failure.
      throw badRequest("The request body was not valid JSON.");
    }
    if (isRecord(parsed) && "keys" in parsed) {
      const { keys: _keys, ...rest } = parsed;
      forwardedBody = JSON.stringify(rest);
    }
  }

  // The sibling address, with the flag that makes it answer rather than write. The path is derived by
  // dropping this segment rather than written out, so a deployment served under a prefix still resolves.
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/\/preview\/?$/, "");
  url.searchParams.set("dryRun", "1");

  // The original headers, so the forwarded handler's origin check, rate-limit bucket and audit context all
  // see the real request. `content-length` is dropped because the body above may be shorter than the one
  // that arrived; the runtime sets the right value for the body it is given.
  const headers = new Headers(request.headers);
  headers.delete("content-length");

  return runImport(new NextRequest(url, { method: "POST", headers, body: forwardedBody }));
});
