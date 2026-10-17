/**
 * Turning a small HTML fragment (a Wikimedia Commons `extmetadata` value, say) into one line of text.
 *
 * Two rules, and both exist because the obvious chain of `.replace` calls gets them wrong:
 *
 *   1. ENTITIES ARE DECODED IN ONE PASS. Decoding `&amp;` first and `&lt;` after it turns the
 *      literal text `&amp;lt;` (an uploader who typed "&lt;") into `<`, i.e. it decodes twice. A single
 *      scan never revisits what it has produced, so `&amp;lt;` becomes `&lt;`, which is what it said.
 *   2. TAGS ARE STRIPPED UNTIL NONE ARE LEFT. One pass over `<scr<b>ipt>` removes `<b>` and leaves
 *      `<script>`; repeating until the string stops changing removes it too.
 *
 * The result is TEXT. It is still rendered through React (which escapes it), never as markup.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " "
};

/** Decode the handful of entities Commons emits, plus numeric references, in a single scan. */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (match, decimal, hex, name) => {
    if (decimal !== undefined || hex !== undefined) {
      const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[String(name).toLowerCase()] ?? match;
  });
}

/** Remove every tag, repeating until a pass removes nothing, with `replacement` in each tag's place. */
export function stripTags(value: string, replacement = ""): string {
  let current = value;
  for (;;) {
    const next = current.replace(/<[^<>]*>/g, replacement);
    if (next === current) return current;
    current = next;
  }
}
