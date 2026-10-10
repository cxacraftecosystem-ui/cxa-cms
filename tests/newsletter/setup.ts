/**
 * The environment every newsletter test runs in, set BEFORE any module under test is imported (the
 * modules read it lazily, but the token signer refuses a weak secret, so a real-length one is supplied).
 *
 * Values already present win, so CI's environment and a local `.env` are used as they are.
 */
process.env.JWT_SECRET ??= "test-only-4f8a2b9d1e7c3a6058f4b2d9e1c7a3506f8b2d4e9c1a7350";
process.env.JWT_ALGORITHM ??= "HS256";
process.env.NEXT_PUBLIC_SITE_URL ??= "https://cxa.example.org";
process.env.NEXT_PUBLIC_SITE_NAME ??= "Centre of Excellence";

/** True when a database is available for the tests that need one. */
export const hasDatabase = Boolean(process.env.DATABASE_URL);
