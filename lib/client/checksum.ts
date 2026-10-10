/**
 * The SHA-256 of a file, in the form storage wants it: base64 of the 32 raw bytes.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THE BROWSER HASHES AT ALL. The presign routes REQUIRE this digest and sign it into the PUT as
 * `x-amz-checksum-sha256` (lib/storage/client.ts), so storage itself refuses a body that is not
 * byte-for-byte the file that was fingerprinted. The finalize routes then read the same digest back from
 * storage's `HEAD` and compare it with the signed ticket before a row is written.
 *
 * ⚠ WHY IT READS THE WHOLE FILE INTO MEMORY. `crypto.subtle.digest` is one-shot: WebCrypto has no
 * incremental SHA-256, and there is no multipart upload in this codebase that would allow per-part
 * checksums instead. The largest file any route accepts is 200 MB (lib/storage/upload-limits.ts), and
 * holding that as one `ArrayBuffer` for the second or so the native digest takes is acceptable on any
 * machine an editor works from. If the caps ever rise far beyond that, move to multipart with a per-part
 * `ChecksumSHA256` (each part ≤ a few hundred MB) rather than a JavaScript SHA-256 — a pure-JS hash of a
 * gigabyte is tens of seconds of a pegged main thread.
 *
 * Not `"use client"` and free of DOM-only APIs beyond `Blob` and `crypto.subtle`, both of which Node also
 * has, so tests/storage/checksum.test.ts runs it unchanged.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export async function sha256Base64(blob: Blob): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    // `crypto.subtle` exists only in a SECURE CONTEXT — https, or http://localhost. A studio opened over
    // plain http on a LAN address has none, and the upload cannot be fingerprinted there.
    throw new Error(
      "This browser cannot fingerprint the file because the studio is not open over a secure (https) connection, so it was not uploaded."
    );
  }
  const digest = new Uint8Array(await subtle.digest("SHA-256", await blob.arrayBuffer()));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}
