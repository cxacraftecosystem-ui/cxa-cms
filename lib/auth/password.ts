import "server-only";
import bcrypt from "bcryptjs";

/**
 * Password hashing.
 *
 * bcrypt at cost 12: ~250ms on the class of hardware this deploys to, which is the standard
 * trade-off between "an interactive login feels instant" and "an offline attacker gets few guesses
 * per second". `bcryptjs` (pure JS) rather than a native binding so the same code runs on a
 * developer's Windows laptop, in CI and in a serverless function without a build step per platform.
 */
const BCRYPT_COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

/**
 * Verify a password.
 *
 * A user with NO password hash (invited but never set one, or SSO-only) must fail — but must fail in
 * the same amount of time as a wrong password. Returning early would make the two distinguishable by
 * timing, which turns the login form into an account-existence oracle. So the null case runs a
 * comparison against a fixed dummy hash and discards the result.
 */
const DUMMY_HASH = "$2a$12$C6UzMDM.H6dfI/f/IKcEeO1p1PjZ8XZH3iKZ0m5tXG3P8Q1eqIcMa";

export async function verifyPassword(plain: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) {
    await bcrypt.compare(plain, DUMMY_HASH);
    return false;
  }
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    // A malformed hash in the database is a data problem, not an authentication success.
    return false;
  }
}

/**
 * Password policy, as sentences the form can print verbatim.
 *
 * Length first and length foremost — it is the only property that reliably correlates with strength.
 * The composition rules are deliberately mild: a long passphrase must not be rejected for lacking a
 * digit, because that rule is exactly what drives people to "Password1!".
 */
export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 12) {
    problems.push("Use at least 12 characters. A short phrase of several words works well.");
  }
  if (password.length > 200) {
    problems.push("Keep it under 200 characters.");
  }
  if (/^\s|\s$/.test(password)) {
    problems.push("Remove the space at the start or end — it is easy to lose when typing it again.");
  }
  const lowered = password.toLowerCase();
  const COMMON = ["password", "12345678", "qwerty", "letmein", "welcome", "admin123", "iloveyou"];
  if (COMMON.some((entry) => lowered.includes(entry))) {
    problems.push("This contains a very common password. Choose something less predictable.");
  }
  if (new Set(password).size < 5) {
    problems.push("Use a wider variety of characters.");
  }
  return problems;
}
