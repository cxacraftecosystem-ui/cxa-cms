/**
 * CSV, written once: the quoting, the formula guard and the byte-order mark that every export in this
 * application needs and that three of them had each grown their own copy of.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ WHY THIS FILE EXISTS, AND WHY IT IS THE FIX RATHER THAN A TIDY-UP
 *
 * `csvCell`, `csvRow` and `BOM` existed in THREE byte-identical copies —
 * `app/api/studio/inquiries/export/route.ts`, `app/api/studio/inquiries/[id]/route.ts` and
 * `app/studio/subscribers/export/route.ts` — under a header in the third of them that argued against
 * exactly that, in these words: "two implementations of an injection guard means one of them is
 * eventually weaker, and it will be the one nobody re-read." It was right, and it was describing itself.
 *
 * Nothing in this repository related the three. `route-check`, `theme-check`, `font-check`, `eslint` and
 * `tsc` all stay green while they drift, and `scripts/` holds no CSV check at all — so somebody
 * hardening the guard in one export (adding `\n` and the Unicode line separators to the leading-character
 * class, say, or switching to a tab-and-CR-aware sanitiser) would leave the other two on the old regex
 * with nothing anywhere to notice. The copy most likely to be left behind is the newsletter one, whose
 * entire content is attacker-supplied and whose reader is guaranteed to be a member of staff.
 *
 * ⚠ A `route.ts` MAY NOT EXPORT A HELPER — the generated check in `.next/types/**` fails the build on any
 * export that is not an HTTP handler — which is why the copies could not simply be hoisted into one of
 * them. A route may freely IMPORT one, and now does.
 *
 * ══ 1. THE QUOTING (RFC 4180), WHICH IS NOT OPTIONAL ══
 *
 * Every field is wrapped in double quotes and internal quotes are doubled. A contact-form message, a
 * consent sentence or a user-agent string contains commas, quotation marks and newlines — most of them do
 * — and without the quoting one record silently becomes several columns and several rows. That reads as
 * corrupted data rather than as a quoting bug, which is how it survives review.
 *
 * ══ 2. ⚠ THE FORMULA GUARD, WHICH IS THE MOST IMPORTANT THING IN THIS FILE ══
 *
 * A cell whose text begins `=`, `+`, `-`, `@`, a tab or a carriage return is evaluated as a FORMULA by
 * Excel, Numbers and Google Sheets. Everything these exports carry was typed by a stranger into a form on
 * the public internet, so `=HYPERLINK(...)` or `=cmd|'/c calc'!A1` in any field is a stranger running code
 * on the machine of whichever member of staff opens the file. A leading apostrophe makes the cell text; no
 * spreadsheet displays the apostrophe, so nothing is lost to read.
 *
 * ⚠ THE CHARACTER CLASS IS THE THING TO HARDEN, AND THIS IS NOW THE ONLY PLACE IT LIVES. Change it here
 * and every export in the application changes with it. That is the whole point of the file.
 *
 * ══ 3. THE BYTE-ORDER MARK, WHICH IS LOAD-BEARING ══
 *
 * Excel on Windows reads a CSV with no BOM in the system code page, so every name and every address with
 * a diacritic — and `normaliseEmail` accepts them, because internationalised addresses are real — arrives
 * as mojibake. Three bytes, ignored by every other reader. Written as an escape rather than as the
 * character itself, which is invisible in source and is exactly the sort of thing an editor silently
 * strips.
 *
 * ══ ⚠ THE ONE COPY THIS FILE DOES **NOT** REPLACE ══
 *
 * `app/studio/events/[id]/registrations/RegistrationsManager.tsx` carries a fourth implementation with a
 * DIFFERENT signature (`string | null` rather than `unknown`) inside a client component that builds its
 * file in the browser. It is deliberately left alone here: it is not this area's file, and reconciling it
 * is a change to a screen nobody asked to have touched. It is reported in the handover as the remaining
 * divergence. If you are the person who reconciles it, this file is where it should end up — and the
 * `unknown` signature below is a superset of the one it uses, so the move is mechanical.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** A UTF-8 byte-order mark. Prepend it to the whole file body, never to a row. See section 3. */
export const BOM = "\uFEFF";

/**
 * One cell: quoted, internal quotes doubled, and a leading formula character neutralised.
 *
 * ⚠ `unknown` RATHER THAN `string`, deliberately. A `Date` renders as an ISO string — UTC by definition,
 * which is why every date column in these exports is labelled "(UTC)" — and `null`/`undefined` render as
 * an empty quoted cell rather than as the words "null" or "undefined". A caller that had to convert
 * before calling would be a caller that can forget to.
 *
 * ⚠ NOT EXPORTED, and that is this repository's rule rather than an oversight: every one of the three
 * copies this file replaces used only `csvRow` and `BOM` at its call sites, so an exported `csvCell` would
 * be a symbol nothing imports — the defect class this codebase keeps producing. It is also the safer shape:
 * a caller that can reach a single cell can build a row without the guard, one field at a time. Export it
 * the day something outside this file genuinely needs one cell, and give it a caller in the same change.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  const raw =
    value instanceof Date ? value.toISOString() : typeof value === "string" ? value : String(value);
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** One row, terminated. */
export function csvRow(values: readonly unknown[]): string {
  // CRLF, because that is what a spreadsheet on Windows expects and every other reader tolerates.
  return `${values.map(csvCell).join(",")}\r\n`;
}
