/**
 * AccessScopeBadge — the marker that says an access list entry is a WHOLE DOMAIN and not one person.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS AT ALL. The studio access list decides who may sign in to the CMS, and since a row can
 * be "@iitkgp.ac.in" as well as "ada@iitkgp.ac.in", two entries that look almost identical in a table
 * differ by roughly the size of a university. A reader skimming the list to answer "who can get in?" must
 * not have to notice a single leading character to tell them apart — that is the kind of difference the
 * eye supplies from expectation rather than from the screen, and it is exactly the row somebody needs to
 * spot during an incident.
 *
 * ⚠ IT RENDERS NOTHING FOR AN ORDINARY ADDRESS, ON PURPOSE. A "Person" chip on every other row is noise
 * that trains the reader to stop looking at this column, which would defeat the one row it is for.
 * Marking the exception, not the rule, is what keeps the exception visible.
 *
 * COLOUR IS NEVER THE SIGNAL (contract §11). The glyph and the words "Whole domain" carry the meaning;
 * the tone only makes it findable. `info` rather than `warn` because a domain grant is a deliberate,
 * legitimate configuration and not a fault — a permanently amber row would be crying wolf, and the reader
 * would learn to ignore it long before the day it mattered.
 *
 * NO `"use client"` AND NO MOTION. It holds no state and does not animate, so a Server Component can
 * render it directly and there is no first paint to get wrong.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { Users } from "lucide-react";

import { Badge, type BadgeSize } from "@/components/ui/Badge";

/**
 * The `AccessKind` enum from prisma/schema.prisma, restated.
 *
 * ⚠ NOT IMPORTED FROM `@prisma/client`, and it has to be that way round. This renders inside a client
 * component tree, and pulling the generated client into the browser bundle to name two strings is how a
 * few hundred kilobytes of query engine types arrive on a page that wanted a chip. The `satisfies` in the
 * API routes is what keeps the two lists honest; here the union is small enough to read at a glance.
 */
export type AccessScope = "EMAIL" | "DOMAIN";

/**
 * The sentence a reader gets on hover, and the one the row's own words cannot fit.
 *
 * It says what the entry DOES rather than what it is — "everybody with an address here may sign in" is
 * the fact somebody is checking for, and "this is a domain entry" is not.
 */
const DOMAIN_TITLE =
  "Everybody with an address at this domain may sign in, including people who join later. An entry " +
  "naming one person is matched first, so a single address can be treated differently.";

export function AccessScopeBadge({
  kind,
  size = "sm"
}: {
  kind: AccessScope;
  /** `sm` beside a table row, `md` beside a heading. Matches `Badge`'s own two sizes. */
  size?: BadgeSize;
}) {
  if (kind !== "DOMAIN") return null;

  return (
    <Badge tone="info" size={size} icon={Users} title={DOMAIN_TITLE}>
      Whole domain
    </Badge>
  );
}
