import "server-only";
import encodeQR from "qr";

/**
 * The scannable square for two-step verification setup — the `otpauth://` URI from `totpUri()`
 * (lib/auth/totp.ts) drawn as SVG geometry, ON THE SERVER, during the setup step of
 * `app/studio/account/page.tsx`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * OWNER-APPROVED EXCEPTION TO CONTRACT §13, 2026-10-10. The contract forbids new dependencies, and this
 * file is the reason one was added: `qr` (paulmillr/qr), PINNED EXACTLY at 0.7.2 in package.json. It was
 * chosen over `qrcode` (three runtime dependencies, including `yargs` and `pngjs`, for a CLI and PNG
 * output this site does not need), `uqr` (no decoder, so nothing could prove its output scans) and
 * `qrcode-generator` (no decoder, a 2025 release line) because it has ZERO runtime dependencies, NO
 * install scripts, and ships a DECODER (`qr/decode.js`) — which is what lets
 * `tests/security/totp-qr.test.ts` prove that the square on screen decodes to exactly the URI, rather
 * than trusting that it does. A square that silently does not scan is the failure the old header of
 * the account page refused to risk; the round-trip test is what retires that objection.
 *
 * ⚠ NOTHING HERE MAY MOVE TO THE CLIENT, AND NOTHING HERE CALLS ANYBODY ELSE.
 *
 *   • `import "server-only"` makes importing this from a client component a build error. The URI
 *     contains the shared secret; the secret lives in an `httpOnly` cookie and in the server render,
 *     and the ONLY thing that leaves the server is the drawn geometry inside a `no-store` response —
 *     which is the same exposure the typed setup key beside it already has, and no more.
 *   • No external QR service, no `<img src="https://…?data=otpauth…">`. That pattern posts the secret
 *     to a third party in a URL, where it lands in their access logs for ever.
 *   • No `data:` URL either: the square is inline SVG geometry, so there is no image request, nothing
 *     for a CSP `img-src` to argue about, and no encoded copy of the URI in an attribute.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY THE SVG IS DRAWN HERE RATHER THAN BY THE LIBRARY. `encodeQR(…, "svg")` returns a markup string,
 * which would have to be injected with `dangerouslySetInnerHTML` and could not carry `role`/`aria-label`
 * without string surgery. The library is asked for the module MATRIX instead and this file turns it
 * into one `<path>`, which the page renders as ordinary JSX.
 */

/**
 * The quiet zone, in modules, on every side.
 *
 * ISO/IEC 18004 asks for FOUR. The library defaults to two, which is enough for most phone cameras
 * against a plain white page — and this square is drawn on a studio screen that may be in the dark
 * theme, where the area around it is near-black. A dark surround eats into a thin quiet zone and makes
 * the finder patterns hard to isolate, so the full four is used and the white square carries them.
 */
export const QR_QUIET_ZONE_MODULES = 4;

/**
 * Error correction level M (~15% of the symbol recoverable). L would give a smaller square, but a
 * screen photographed at an angle with a glare stripe across it is the ordinary case here; H would
 * push a ~150-character URI to a version dense enough to be hard to focus on from a laptop screen.
 */
const ERROR_CORRECTION = "medium" as const;

/**
 * The module matrix INCLUDING the quiet zone: `true` is a dark module.
 *
 * Exported for the tests, which rasterise it (and the path below) and hand the pixels to the
 * library's decoder.
 */
export function qrMatrix(text: string): boolean[][] {
  return encodeQR(text, "raw", { ecc: ERROR_CORRECTION, border: QR_QUIET_ZONE_MODULES });
}

/**
 * One SVG path that draws every dark module as a 1×1 square in a `size`×`size` viewBox.
 *
 * Runs of adjacent dark modules in a row are merged into one rectangle (`M x y h n v 1 h -n z`), which
 * keeps the path to a few kilobytes and leaves no hairline seams between neighbouring modules when the
 * browser anti-aliases — a seam is a light line across a dark run, and a scanner reads it as one.
 */
export function qrPath(matrix: readonly (readonly boolean[])[]): string {
  const commands: string[] = [];
  matrix.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x += 1;
      const run = x - start;
      commands.push(`M${start} ${y}h${run}v1h-${run}z`);
    }
  });
  return commands.join("");
}

export interface QrDrawing {
  /** The side of the square viewBox, in modules, quiet zone included. */
  size: number;
  /** The `d` of the one dark path. */
  path: string;
}

/** What the account page renders: a white `size`×`size` square, and this path on it in black. */
export function totpQrDrawing(otpauthUri: string): QrDrawing {
  const matrix = qrMatrix(otpauthUri);
  return { size: matrix.length, path: qrPath(matrix) };
}
