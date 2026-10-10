/**
 * lib/safe-href.ts is the ONE rule for "internal, external, or not a link at all". Every one of these
 * once passed a `href.startsWith("/")` test somewhere in the CMS and was rendered through `next/link`
 * as an internal-looking link that left the site (or, for a scheme, ran script).
 */
export const BYPASS_CORPUS: readonly string[] = [
  // Protocol-relative, and the backslash spellings the WHATWG parser reads as `//`.
  "//evil.example",
  "///evil.example",
  "//evil.example/path?x=1",
  "/\\evil.example",
  "\\\\evil.example",
  "\\/evil.example",
  "/\\/evil.example",
  "/foo\\bar",
  // A tab, newline or CR after the first slash: the parser strips it and resolves `//evil.example`.
  "/\t/evil.example",
  "/\n/evil.example",
  "/\r/evil.example",
  "/\r\n/evil.example",
  // Leading C0 controls and spaces are stripped by the parser too.
  "\t//evil.example",
  " //evil.example",
  "\u0000//evil.example",
  "\u001f//evil.example",
  "/\u0000/evil.example",
  // Encoded slashes / backslashes / controls in the first segment, single and double encoded.
  "/%2F%2Fevil.example",
  "/%2f%2fevil.example",
  "/%2F/evil.example",
  "/%5Cevil.example",
  "/%5cevil.example",
  "/%252F%252Fevil.example",
  "/%25252F%25252Fevil.example",
  "/%09/evil.example",
  "/%0a/evil.example",
  // Dot segments, plain and encoded. The URL parser folds them away, so each of these has a pathname of
  // `//evil.example` once normalised — a protocol-relative URL for anything that reuses that pathname.
  "/.//evil.example",
  "/..//evil.example",
  "/a/..//evil.example",
  "/%2e//evil.example",
  "/.%2e/%2e%2e//evil",
  "/%252e%252e//evil.example",
  // Malformed percent-encoding in the first segment.
  "/%E0%A4%A",
  "/%",
  // Script and data schemes, including the case and whitespace tricks.
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  " javascript:alert(1)",
  "\u0001javascript:alert(1)",
  "java\tscript:alert(1)",
  "java\nscript:alert(1)",
  "javascript\t:alert(1)",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  "vbscript:msgbox(1)",
  "file:///etc/passwd",
  "blob:https://cxa.example.org/uuid",
  "ftp://evil.example/",
  // http(s) that does not say `//host` or does not parse.
  "https:evil.example",
  "https:/evil.example",
  "https:///evil.example",
  "https:\\\\evil.example",
  "https://",
  "http://",
  "https://exa mple.org",
  // A contact scheme with nothing after it.
  "mailto:",
  "tel:"
];
