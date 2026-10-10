/**
 * The environment every storage test runs in, set BEFORE any module under test is imported.
 *
 * Storage is "configured" with dummy credentials and an endpoint nothing listens on: presigning is pure
 * computation and never touches the network, and every test that would send a request replaces the
 * client's `send` first. `storageEnv()` caches on first read, so these must be in place before
 * lib/storage/client.ts is first called — which is why this file is imported first.
 *
 * Values already present win only for the signing secret, so CI's environment is used as it is; the S3
 * values are always the dummies, so a developer's real bucket in `.env` can never be reached from here.
 */
process.env.JWT_SECRET ??= "test-only-4f8a2b9d1e7c3a6058f4b2d9e1c7a3506f8b2d4e9c1a7350";
process.env.JWT_ALGORITHM ??= "HS256";
process.env.NEXT_PUBLIC_SITE_URL ??= "https://cxa.example.org";

process.env.S3_BUCKET = "cxa-test-bucket";
process.env.S3_REGION = "ap-south-1";
process.env.S3_ACCESS_KEY_ID = "AKIATESTONLY";
process.env.S3_SECRET_ACCESS_KEY = "test-only-secret";
process.env.S3_ENDPOINT = "http://127.0.0.1:9";
process.env.S3_FORCE_PATH_STYLE = "true";
delete process.env.S3_PUBLIC_ENDPOINT;
delete process.env.S3_SSE_ALGORITHM;
