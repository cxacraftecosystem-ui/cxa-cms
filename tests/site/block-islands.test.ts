import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { BLOCK_ISLANDS, CINEMATIC_STORY_KEY, islandsFor, type IslandKey } from "@/lib/sections/block-islands";

/**
 * lib/sections/block-islands.ts lists the code-split pieces each block type renders, so a client-side
 * navigation can fetch them together. The list is hand-kept; this follows each renderer's imports through
 * the source and fails when a block imports a piece the list does not name, or the list names one no
 * block imports any more. It also checks that every `dynamic()` call registers its own loader, under its
 * own name, which is what lets the early fetch hit the chunks the piece itself will ask for.
 */

const ROOT = process.cwd();
const LAZY = "@/components/sections/lazy-islands";
const CLIENT_SECTIONS = "@/components/sections/client-sections";

function read(file: string): string {
  return readFileSync(file, "utf8");
}

function resolveAlias(specifier: string): string | null {
  const base = path.join(ROOT, specifier.replace(/^@\//, ""));
  for (const candidate of [`${base}.tsx`, `${base}.ts`, path.join(base, "index.tsx"), path.join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** `import { A, B as C } from "x"` → [["A", "x"], ["B", "x"]]; `import type` lines are skipped. */
function namedImports(source: string): Array<[name: string, from: string]> {
  const out: Array<[string, string]> = [];
  for (const [, typeOnly, names = "", from = ""] of source.matchAll(
    /^import\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)";/gm
  )) {
    if (typeOnly) continue;
    for (const part of names.split(",")) {
      const cleaned = part.trim();
      if (!cleaned || cleaned.startsWith("type ")) continue;
      out.push([(cleaned.split(/\s+as\s+/)[0] ?? cleaned).trim(), from]);
    }
  }
  return out;
}

/** The pieces a wrapper file defines, checking each `dynamic()` registers its loader under its own name. */
function registeredPieces(specifier: string): Set<string> {
  const source = read(resolveAlias(specifier)!);
  const dynamicCalls = [...source.matchAll(/export const (\w+) = dynamic\(/g)].map(([, name = ""]) => name);
  const registered = new Map(
    [...source.matchAll(/export const (\w+) = dynamic\(\s*island\("(\w+)", \(\) => import\("[^"]+"\)\.then\(\(module\) => module\.(\w+)\)\)/g)].map(
      ([, exported = "", key = "", member = ""]) => [exported, { key, member }]
    )
  );
  for (const name of dynamicCalls) {
    const entry = registered.get(name);
    assert.ok(entry, `${specifier}: ${name}'s dynamic() does not pass its loader through island()`);
    assert.equal(entry.key, name, `${specifier}: ${name} is registered as "${entry.key}"`);
    assert.equal(entry.member, name, `${specifier}: ${name} loads module.${entry.member}`);
  }
  return new Set(dynamicCalls);
}

const lazyPieces = registeredPieces(LAZY);
const clientSectionPieces = registeredPieces(CLIENT_SECTIONS);

/** Every piece a file renders, following its imports of other block files. */
function piecesRenderedBy(file: string, seen = new Set<string>()): Set<string> {
  const found = new Set<string>();
  if (seen.has(file)) return found;
  seen.add(file);
  for (const [name, from] of namedImports(read(file))) {
    if (from === LAZY) {
      if (lazyPieces.has(name)) found.add(name);
    } else if (from.startsWith("@/components/sections/") && from !== CLIENT_SECTIONS) {
      const next = resolveAlias(from);
      if (next) for (const piece of piecesRenderedBy(next, seen)) found.add(piece);
    }
  }
  return found;
}

/** SectionRenderer's RENDERERS table: block type → what it renders. */
function rendered(): Map<string, Set<string>> {
  const source = read(path.join(ROOT, "components/sections/SectionRenderer.tsx"));
  const importsByName = new Map(namedImports(source));
  const start = source.indexOf("const RENDERERS");
  const table = source.slice(start, source.indexOf("};", start));
  const out = new Map<string, Set<string>>();
  for (const [, type = "", component = ""] of table.matchAll(/^\s+([A-Z_]+): (\w+),?$/gm)) {
    const from = importsByName.get(component);
    assert.ok(from, `no import for the ${type} renderer ${component}`);
    if (from === CLIENT_SECTIONS) {
      assert.ok(clientSectionPieces.has(component), `${component} is not a dynamic() in client-sections`);
      out.set(type, new Set([component])); // the block is a piece itself
    } else {
      out.set(type, piecesRenderedBy(resolveAlias(from)!));
    }
  }
  return out;
}

describe("the block → code-split piece table", () => {
  const byType = rendered();

  it("found the renderer table and both wrapper files", () => {
    assert.ok(byType.size >= 30, `only ${byType.size} renderers parsed`);
    assert.ok(lazyPieces.size >= 20, `only ${lazyPieces.size} pieces in lazy-islands`);
    assert.equal(clientSectionPieces.size, 3);
  });

  for (const [type, pieces] of byType) {
    it(`lists exactly the pieces the ${type} block renders`, () => {
      const listed = new Set(BLOCK_ISLANDS[type as IslandKey] ?? []);
      if (type === "STORY_SCROLL") {
        for (const name of BLOCK_ISLANDS[CINEMATIC_STORY_KEY] ?? []) listed.add(name);
      }
      assert.deepEqual([...listed].sort(), [...pieces].sort());
    });
  }

  it("names only pieces that exist", () => {
    for (const names of Object.values(BLOCK_ISLANDS)) {
      for (const name of names ?? []) {
        assert.ok(lazyPieces.has(name) || clientSectionPieces.has(name), `no piece named ${name}`);
      }
    }
  });

  it("de-duplicates pieces across blocks, in page order", () => {
    assert.deepEqual(islandsFor(["MEDIA_SPLIT", "EMBED", "HERO"]), ["VideoPlayer", "HostedVideoFrame"]);
  });
});
