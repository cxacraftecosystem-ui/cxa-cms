/**
 * site-url-check — `siteUrl()` must name the deployment it runs on, and never another one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS. Every link this application sends somebody — a password link, an invitation, a
 * newsletter confirmation — is `siteUrl()` plus a token, so the origin it returns decides where
 * somebody else's credential is delivered. Three rules, each of which is a real failure if broken:
 *
 *   1. A configured NEXT_PUBLIC_SITE_URL always wins, on a preview as anywhere else.
 *   2. A Vercel PREVIEW without one answers with its own address — the branch URL, else the
 *      deployment URL — instead of throwing. Previews build with NODE_ENV=production, and before
 *      this every preview build died collecting page data.
 *   3. PRODUCTION without one still THROWS, although Vercel sets VERCEL_URL there too. A fallback
 *      that leaked into production would publish canonical URLs and sitemap entries naming a
 *      throwaway *.vercel.app host, with every signal green.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Pure: it sets environment variables in this process and calls the function. No database, no
 * network, no build.
 *
 *     npx tsx scripts/site-url-check.ts        # or: npm run site-url-check
 */

import assert from "node:assert/strict";
import { configurationWarnings, siteUrl } from "../lib/env";

// Next declares NODE_ENV read-only on `process.env`; this script has to set it.
const env = process.env as Record<string, string | undefined>;

const VARIABLES = ["NEXT_PUBLIC_SITE_URL", "NODE_ENV", "VERCEL_ENV", "VERCEL_BRANCH_URL", "VERCEL_URL"];

const BRANCH = "cxa-cms-git-some-branch-team.vercel.app";
const DEPLOYMENT = "cxa-cms-abc123def-team.vercel.app";

interface Case {
  name: string;
  set: Record<string, string>;
  check: () => void;
}

const siteUrlWarned = () =>
  configurationWarnings().some((warning) => warning.startsWith("NEXT_PUBLIC_SITE_URL is not set"));

const CASES: Case[] = [
  {
    name: "a preview with no configured origin uses its branch URL",
    set: { NODE_ENV: "production", VERCEL_ENV: "preview", VERCEL_BRANCH_URL: BRANCH, VERCEL_URL: DEPLOYMENT },
    check: () => {
      assert.equal(siteUrl(), `https://${BRANCH}`);
      assert.equal(siteUrlWarned(), false, "a preview using its own address is not a misconfiguration");
    }
  },
  {
    name: "a preview with no branch URL uses its deployment URL",
    set: { NODE_ENV: "production", VERCEL_ENV: "preview", VERCEL_URL: DEPLOYMENT },
    check: () => assert.equal(siteUrl(), `https://${DEPLOYMENT}`)
  },
  {
    name: "a configured origin wins on a preview, without its trailing slash",
    set: {
      NODE_ENV: "production",
      VERCEL_ENV: "preview",
      VERCEL_BRANCH_URL: BRANCH,
      NEXT_PUBLIC_SITE_URL: "https://preview.example.org/"
    },
    check: () => assert.equal(siteUrl(), "https://preview.example.org")
  },
  {
    name: "production with no configured origin throws, VERCEL_URL notwithstanding",
    set: { NODE_ENV: "production", VERCEL_ENV: "production", VERCEL_BRANCH_URL: BRANCH, VERCEL_URL: DEPLOYMENT },
    check: () => {
      assert.throws(() => siteUrl(), /NEXT_PUBLIC_SITE_URL is required in production/);
      assert.equal(siteUrlWarned(), true, "the diagnostics panel must still name the missing origin");
    }
  },
  {
    name: "a preview that exposes no address of its own throws rather than guessing",
    set: { NODE_ENV: "production", VERCEL_ENV: "preview" },
    check: () => assert.throws(() => siteUrl(), /NEXT_PUBLIC_SITE_URL is required in production/)
  },
  {
    name: "a production build off Vercel still throws",
    set: { NODE_ENV: "production" },
    check: () => assert.throws(() => siteUrl(), /NEXT_PUBLIC_SITE_URL is required in production/)
  },
  {
    name: "local development falls back to localhost",
    set: { NODE_ENV: "development" },
    check: () => assert.equal(siteUrl(), "http://localhost:3000")
  }
];

const saved = Object.fromEntries(VARIABLES.map((name) => [name, env[name]]));
const failures: string[] = [];

for (const testCase of CASES) {
  for (const name of VARIABLES) delete env[name];
  Object.assign(env, testCase.set);
  try {
    testCase.check();
  } catch (error) {
    failures.push(`${testCase.name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

for (const name of VARIABLES) {
  const value = saved[name];
  if (value === undefined) delete env[name];
  else env[name] = value;
}

console.log(`site-url-check — ${CASES.length} cases`);

if (failures.length > 0) {
  console.error(`\nFAIL — ${failures.length} case(s):\n`);
  for (const failure of failures) console.error(`  • ${failure}`);
  process.exit(1);
}

console.log("PASS — previews link to themselves, production still refuses to guess.");
