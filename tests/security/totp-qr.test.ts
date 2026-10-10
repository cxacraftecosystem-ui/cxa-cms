import "../newsletter/setup";

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import decodeQR from "qr/decode.js";

import { QR_QUIET_ZONE_MODULES, qrMatrix, qrPath, totpQrDrawing } from "@/lib/auth/totp-qr";
import { generateTotpSecret, totpUri } from "@/lib/auth/totp";

/**
 * The two-step verification QR code (owner-approved exception to contract §13, 2026-10-10).
 *
 * The square is only worth drawing if it scans, so these tests hand the drawing — the matrix AND the SVG
 * path the page actually renders — to the library's own DECODER and require the exact `otpauth://` URI
 * back. Then they pin where the square is drawn: on the server, never in a client bundle, never in a URL.
 */

const PIXELS_PER_MODULE = 4;

/** An RGBA image of a module grid, white for light modules and black for dark. */
function rasterise(grid: readonly (readonly boolean[])[]): { width: number; height: number; data: Uint8Array } {
  const size = grid.length * PIXELS_PER_MODULE;
  const data = new Uint8Array(size * size * 4).fill(255);
  grid.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < PIXELS_PER_MODULE; dy += 1) {
        for (let dx = 0; dx < PIXELS_PER_MODULE; dx += 1) {
          const offset = ((y * PIXELS_PER_MODULE + dy) * size + x * PIXELS_PER_MODULE + dx) * 4;
          data[offset] = 0;
          data[offset + 1] = 0;
          data[offset + 2] = 0;
        }
      }
    })
  );
  return { width: size, height: size, data };
}

/** Read the page's SVG path back into a module grid — the inverse of `qrPath`, and nothing cleverer. */
function gridFromPath(d: string, size: number): boolean[][] {
  const grid = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const pattern = /M(\d+) (\d+)h(\d+)v1h-(\d+)z/g;
  let consumed = 0;
  for (const match of d.matchAll(pattern)) {
    const [whole, x, y, run, back] = match;
    assert.equal(run, back, "every run closes on itself");
    for (let i = 0; i < Number(run); i += 1) grid[Number(y)]![Number(x) + i] = true;
    consumed += whole.length;
  }
  assert.equal(consumed, d.length, "the path contains nothing but module runs");
  return grid;
}

const URI = totpUri({
  secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
  accountName: "someone.long-name@aicraft.iitkgp.ac.in",
  issuer: "Centre of Excellence"
});

describe("the two-step verification QR code", () => {
  it("the matrix decodes to exactly the otpauth URI", () => {
    assert.equal(decodeQR(rasterise(qrMatrix(URI))), URI);
  });

  it("the SVG path the page renders decodes to exactly the otpauth URI", () => {
    const drawing = totpQrDrawing(URI);
    assert.equal(decodeQR(rasterise(gridFromPath(drawing.path, drawing.size))), URI);
  });

  it("round-trips fresh secrets too, not just one fixed URI", () => {
    for (let i = 0; i < 5; i += 1) {
      const uri = totpUri({ secret: generateTotpSecret(), accountName: `p${i}@example.org`, issuer: "Studio" });
      const drawing = totpQrDrawing(uri);
      assert.equal(decodeQR(rasterise(gridFromPath(drawing.path, drawing.size))), uri);
    }
  });

  it("carries a four-module quiet zone on every side", () => {
    const grid = qrMatrix(URI);
    const n = grid.length;
    for (let i = 0; i < n; i += 1) {
      for (let q = 0; q < QR_QUIET_ZONE_MODULES; q += 1) {
        assert.equal(grid[q]![i], false);
        assert.equal(grid[n - 1 - q]![i], false);
        assert.equal(grid[i]![q], false);
        assert.equal(grid[i]![n - 1 - q], false);
      }
    }
    assert.equal(qrPath([[false]]), "");
  });
});

describe("where the square is drawn", () => {
  const root = process.cwd();
  const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");
  const page = read("app/studio/account/page.tsx");

  it("the encoder module is server-only and the only importer of `qr`", () => {
    assert.match(read("lib/auth/totp-qr.ts"), /^import "server-only";/);
    const importers: string[] = [];
    (function walk(dir: string) {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".next" || name === ".git" || name === "tests") continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && /from\s+"qr(\/[^"]*)?"/.test(readFileSync(full, "utf8"))) {
          importers.push(path.relative(root, full).replace(/\\/g, "/"));
        }
      }
    })(root);
    assert.deepEqual(importers, ["lib/auth/totp-qr.ts"]);
  });

  it("no client component imports it, and the account page is a Server Component", () => {
    assert.doesNotMatch(page, /^\s*["']use client["']/m);
    (function walk(dir: string) {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".next" || name === ".git") continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name)) {
          const text = readFileSync(full, "utf8");
          if (/^\s*["']use client["']/.test(text)) {
            assert.doesNotMatch(text, /totp-qr|lib\/auth\/totp"/, `${full} is a client component`);
          }
        }
      }
    })(path.join(root, "app"));
  });

  it("the SVG is an accessible image whose label never contains the secret or the URI", () => {
    assert.match(page, /role="img"/);
    const label = /aria-label=\{`([^`]*)`\}/.exec(page)?.[1] ?? "";
    assert.match(label, /QR code/);
    assert.doesNotMatch(label, /secret|uri|pendingSecret|otpauth/i);
    // White ground, black modules, regardless of theme.
    assert.match(page, /fill="#ffffff"/);
    assert.match(page, /<path d=\{qr\.path\} fill="#000000"/);
  });

  it("the typed-key fallback is still on screen", () => {
    assert.match(page, /\{groupSecret\(pendingSecret\)\}/);
  });

  it("the secret never goes into the page's own URL, a data: URL or an external QR service", () => {
    // Every redirect out of the setup carries a fixed flag or a problem code, never the secret.
    for (const call of page.matchAll(/backWith\(\{([^}]*)\}\)/g)) {
      assert.doesNotMatch(call[1]!, /secret/i, `backWith(${call[1]}) must not carry the secret`);
    }
    assert.doesNotMatch(page, /data:image/);
    assert.doesNotMatch(page, /https?:\/\/[^"'`\s]*(qr|chart\.googleapis)/i);
    assert.doesNotMatch(page, /searchParams\.set\([^)]*secret/i);
  });
});
