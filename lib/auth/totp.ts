import "server-only";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { authEnv } from "./config";

/**
 * TOTP (RFC 6238) — optional second factor for the CMS.
 *
 * Implemented here rather than pulled from a dependency because the algorithm is thirty lines and
 * the security-relevant details are all in HOW it is used, not in the arithmetic:
 *
 *   • The shared secret is ENCRYPTED AT REST (AES-256-GCM, key derived from JWT_SECRET). A plaintext
 *     TOTP secret in the database means one database read is a complete account takeover — the exact
 *     thing a second factor is bought to prevent.
 *   • Verification accepts a ±1 step window (±30s). Zero tolerance rejects a correct code typed by
 *     someone whose phone clock is two seconds out; a wide window turns a 30-second code into a
 *     several-minute one.
 *   • Codes are compared in CONSTANT TIME. A string `===` on a six-digit code is a timing oracle
 *     that reduces the search space one digit at a time.
 *
 * ⚠ A CODE IS NOT YET SPENT WHEN IT IS ACCEPTED, AND RFC 6238 §5.2 SAYS IT SHOULD BE. Verification
 * here is a pure function of (secret, code, clock): nothing records that a code has been used, so the
 * same six digits authenticate for the whole ±1-step window — up to ninety seconds — and a code seen
 * over somebody's shoulder, relayed by a phishing page or pasted into a chat can be replayed by an
 * attacker who already holds the password. Recovery codes are single-use (see `consumeRecoveryCode` in
 * the login route); authenticator codes are not, which is the wrong way round.
 *
 * The verifier cannot close that on its own — refusing a code requires remembering the last step this
 * ACCOUNT accepted, and there is no column for it. `matchTotpStep` below therefore returns the step it
 * matched rather than a bare boolean, which is the half that belongs in this module: a caller holding
 * the step can persist it and refuse anything at or below it, in a conditional `updateMany` so two
 * submissions of one code cannot both win. Until `User` carries that column, `verifyTotp` remains a
 * replay-tolerant check and the login route uses it as one.
 */

const DIGITS = 6;
const PERIOD_SECONDS = 30;
const WINDOW_STEPS = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(): string {
  // 20 bytes = 160 bits, the RFC 4226 recommendation, and exactly 32 base32 characters with no
  // padding — which is what every authenticator app expects to be handed.
  return base32Encode(randomBytes(20));
}

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error("The authenticator secret contains characters that are not base32.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** One HOTP code for a counter value. */
function hotp(secret: Buffer, counter: number): string {
  const buffer = Buffer.alloc(8);
  // Counter is a 64-bit big-endian integer. Written as two 32-bit halves because a JS number cannot
  // hold 64 bits exactly, and `writeBigUInt64BE` would force a BigInt on every call.
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac("sha1", secret).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

/** The code for "now", for tests and for the enrolment preview. */
export function currentTotp(secretBase32: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / PERIOD_SECONDS);
  return hotp(base32Decode(secretBase32), counter);
}

/**
 * Verify a submitted code AND SAY WHICH STEP IT WAS — the time-step counter, or null for no match.
 *
 * The counter is the return value rather than a boolean because it is the only thing that can make a
 * code single-use: see the ⚠ in the header. A caller that stores the step it accepted, and refuses
 * anything at or below it next time, closes the replay window; a caller that only ever asks "is this
 * code right?" cannot, because within the window the answer stays yes.
 *
 * Every candidate in the window is checked even after a match is found, so the number of HMACs
 * computed does not depend on WHICH step matched — a loop that breaks early tells an attacker
 * whether the clock skew is positive or negative. That also means the LAST match wins if a secret
 * ever produced one code for two steps, which is the safe way round: recording the higher step
 * refuses more later, never less.
 */
export function matchTotpStep(
  secretBase32: string,
  code: string,
  atMs: number = Date.now()
): number | null {
  const normalised = code.replace(/\D/g, "");
  if (normalised.length !== DIGITS) return null;

  let secret: Buffer;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return null;
  }

  const counter = Math.floor(atMs / 1000 / PERIOD_SECONDS);
  let matched: number | null = null;
  for (let step = -WINDOW_STEPS; step <= WINDOW_STEPS; step += 1) {
    const candidate = hotp(secret, counter + step);
    const a = Buffer.from(candidate);
    const b = Buffer.from(normalised);
    if (a.length === b.length && timingSafeEqual(a, b)) matched = counter + step;
  }
  return matched;
}

/**
 * The same check with the step discarded.
 *
 * ⚠ REPLAY-TOLERANT, by construction: a boolean carries nothing a caller could record, so a code
 * accepted here can be presented again for the rest of its window. Enrolment can live with that — the
 * code is being typed by the person who just scanned the secret — but sign-in cannot, and should move
 * to `matchTotpStep` as soon as there is somewhere to keep the step.
 */
export function verifyTotp(secretBase32: string, code: string, atMs: number = Date.now()): boolean {
  return matchTotpStep(secretBase32, code, atMs) !== null;
}

/** The `otpauth://` URI an authenticator app scans. */
export function totpUri(input: { secret: string; accountName: string; issuer: string }): string {
  const label = encodeURIComponent(`${input.issuer}:${input.accountName}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS)
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ── Encryption at rest ──────────────────────────────────────────────────────

const ENCRYPTION_SALT = "cxa-totp-v1";

function encryptionKey(): Buffer {
  // scrypt rather than a raw hash: the key is derived from JWT_SECRET, and a fast KDF would let an
  // attacker who obtains the database brute-force weak secrets offline at hashing speed.
  return scryptSync(authEnv().secret, ENCRYPTION_SALT, 32);
}

/** `v1.<iv>.<tag>.<ciphertext>`, all base64url. Versioned so the scheme can be rotated later. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/** Returns null rather than throwing: an undecryptable secret means 2FA is broken for that user, and
 *  the recovery path is "disable and re-enrol", not a 500 on the login screen. */
export function decryptSecret(stored: string): string | null {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const iv = Buffer.from(parts[1]!, "base64url");
    const tag = Buffer.from(parts[2]!, "base64url");
    const ciphertext = Buffer.from(parts[3]!, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Ten single-use recovery codes, formatted in two readable groups. */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString("hex").toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
  });
}

/**
 * The canonical form of a recovery code: upper case, punctuation stripped, re-hyphenated.
 *
 * IT LIVES HERE, BESIDE THE GENERATOR, AND NOWHERE ELSE. The code is hashed at issue time by
 * `/api/auth/two-factor` and compared at sign-in by `/api/auth/login`, and the two must agree
 * character for character or every recovery code silently fails to verify — at exactly the moment
 * someone has lost their phone and has no other way in. Two copies of this function, however well
 * commented, is a pair that drifts; one import cannot.
 *
 * The tolerance is deliberate. A recovery code is read off paper or out of a password manager and
 * typed by someone who is already locked out, so spaces, lower case and a missing or doubled hyphen
 * all have to resolve to the same value. Anything that is not the expected ten characters is
 * returned stripped but unhyphenated, so a malformed entry compares as itself rather than being
 * reshaped into something that might collide with a real code.
 */
export function canonicalRecoveryCode(input: string): string {
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.length === 10 ? `${cleaned.slice(0, 5)}-${cleaned.slice(5)}` : cleaned;
}
