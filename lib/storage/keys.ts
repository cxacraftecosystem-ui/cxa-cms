import { randomBytes } from "node:crypto";

/**
 * Object-key construction.
 *
 * A key is chosen ONCE, at upload, and is immutable thereafter — every derivative, every CDN cache
 * entry and every stored reference is built from it. Three properties matter:
 *
 *   1. **Date-partitioned.** `media/2026/07/…` keeps any single prefix small, which matters for
 *      listing, lifecycle rules and for S3's own partitioning.
 *   2. **Random, not sequential.** A guessable key lets anyone enumerate every asset in the bucket,
 *      including one uploaded to a draft that has not been published.
 *   3. **The original filename is PRESERVED, slugified, at the end.** A key of pure entropy makes
 *      every bucket-browser session an exercise in guessing, and a signed download URL that ends in
 *      `a7f3…` saves to the reader's disk under that name.
 */

const MAX_NAME_LENGTH = 60;

export const KEY_NAMESPACES = ["media", "files", "models", "tmp"] as const;
export type KeyNamespace = (typeof KEY_NAMESPACES)[number];

/** Extension WITHOUT the dot, lowercased, or "" when there is none. Multi-dot names keep only the last. */
export function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  if (index <= 0 || index === fileName.length - 1) return "";
  return fileName
    .slice(index + 1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * The filename stem, made safe for a key.
 *
 * Everything outside `[a-z0-9-]` collapses to a hyphen — including path separators, `..` and the
 * percent sign. That is the whole path-traversal defence for keys: a name like `../../etc/passwd`
 * becomes `etc-passwd` before it is ever concatenated with a prefix.
 */
export function safeStem(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]*$/, "");
  const slug = withoutExtension
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_LENGTH)
    .replace(/-+$/g, "");
  return slug || "file";
}

function datePrefix(at: Date): string {
  const year = at.getUTCFullYear();
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `${year}/${month}`;
}

/** A fresh key for an original upload. */
export function buildObjectKey(input: {
  namespace: KeyNamespace;
  fileName: string;
  at?: Date;
}): string {
  const at = input.at ?? new Date();
  const token = randomBytes(8).toString("hex");
  const extension = extensionOf(input.fileName);
  const stem = safeStem(input.fileName);
  const tail = extension ? `${stem}.${extension}` : stem;
  return `${input.namespace}/${datePrefix(at)}/${token}-${tail}`;
}

/**
 * The key for a derivative of `originalKey`.
 *
 * Derived from the original rather than random, so "delete every derivative of this asset" is a
 * prefix operation and a regeneration lands on the same keys — meaning the CDN serves the improved
 * bytes at the URL already embedded in published pages, with no cache-busting query string and no
 * stale references.
 */
export function buildVariantKey(input: {
  originalKey: string;
  label: string;
  format: string;
}): string {
  const withoutExtension = input.originalKey.replace(/\.[^./]*$/, "");
  return `${withoutExtension}/${input.label}.${input.format}`;
}

/** Every derivative of an original lives under this prefix. */
export function variantPrefix(originalKey: string): string {
  return `${originalKey.replace(/\.[^./]*$/, "")}/`;
}

/**
 * True when a character has no business being inside an object key: the C0 controls, DEL, and the
 * backslash (which several S3 gateways normalise into a forward slash, changing which object a key
 * addresses).
 *
 * Tested by CODEPOINT rather than with a regular expression character class. A range written as a
 * literal `[<NUL>-<US>]` is invisible in a diff, survives copy-paste as something else, and — the
 * reason this function exists — was once written in a way that spanned printable ASCII and rejected
 * every key the system had ever issued.
 */
function hasForbiddenCharacter(key: string): boolean {
  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

/**
 * Reject a key that could escape its namespace.
 *
 * Belt and braces: keys are built by `buildObjectKey`, never taken from a client. This exists for
 * the paths where one arrives from the database — a row written by an older version, or a restore
 * from a backup — before it is concatenated into a request.
 */
export function isSafeObjectKey(key: string): boolean {
  if (!key || key.length > 1024) return false;
  if (key.startsWith("/") || key.includes("..") || key.includes("//")) return false;
  if (hasForbiddenCharacter(key)) return false;
  return new RegExp(`^(${KEY_NAMESPACES.join("|")})/`).test(key);
}
