# syntax=docker/dockerfile:1.7
# ═══════════════════════════════════════════════════════════════════════════════════════════════
# CxA Centre of Excellence — multi-stage image.
#
#     docker compose build          # or: docker build -t cxa-portal:local .
#
# FOUR STAGES, and the two extra ones exist for reasons worth stating:
#
#   deps      node_modules, cached against the lockfile alone.
#   builder   the Next build, plus `prisma generate`.
#   migrator  a SEPARATE runnable image that keeps the Prisma CLI and the seed script. The runtime
#             stage cannot run migrations: standalone output contains only what the SERVER reaches, and
#             the Prisma CLI, the schema and `tsx` are all build-time tools it deliberately excludes.
#             Compose runs this once, to completion, before the app starts.
#   runtime   the standalone server and nothing else.
#
# ⚠ DEBIAN, NOT ALPINE, AND THAT IS A CONSIDERED CHOICE. This application carries two native
# dependencies — `sharp` (libvips, for the image derivative pipeline) and Prisma's query engine — and
# both need a build matching the C library. On Alpine that means musl variants: an explicit
# `binaryTargets = ["linux-musl-openssl-3.0.x"]` in schema.prisma, and a sharp build that has historically
# needed `--platform=linuxmusl`. Each is a separate thing to get right, each fails at RUN time rather than
# build time, and each fails with a message about an ELF header that says nothing about musl. Debian slim
# costs about 40 MB more and removes both problems.
# ═══════════════════════════════════════════════════════════════════════════════════════════════

ARG NODE_VERSION=22


# ═══════════════════════════════════════════════════════════════════════════════════════════════
# Stage 1 — deps
# ═══════════════════════════════════════════════════════════════════════════════════════════════
FROM node:${NODE_VERSION}-bookworm-slim AS deps

WORKDIR /app

# openssl is what Prisma's query engine links against. It is absent from the slim image, and without it
# `prisma generate` succeeds and every query at run time fails.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Lockfile-only copy, so editing a component does not reinstall the world.
COPY package.json package-lock.json ./

# ⚠ AND `vendor/`, BECAUSE THE LOCKFILE NOW POINTS INTO IT. `server-only` is declared as
# `file:./vendor/server-only-noop`, so `npm ci` RESOLVES that path rather than downloading anything — and
# a `file:` dependency whose directory is absent is a hard install failure, not a warning. Without this
# line the image stops at the very first step of the very first stage.
#
# The vendored package is four lines of `module.exports = {}` and exists because `import "server-only"` is
# a MARKER: Next aliases it away at build time (empty for the server graph, throwing for the client graph,
# which is what makes the guard bite), but `npm run seed` and `npm run smoke` run under plain node, which
# has no such alias. The REAL package throws when it is actually imported, so installing it from the
# registry would break both scripts on every machine — verified by executing it. See vendor/README or the
# note in prisma/seed.ts.
#
# It is copied before `npm ci` rather than with the source in the builder stage because `npm ci` is the
# thing that needs it, and this stage exists precisely so a source edit does not reinstall the world.
COPY vendor ./vendor

# `npm ci`, not `npm install`: it installs exactly the locked tree and fails loudly when package.json and
# the lockfile have drifted, rather than quietly resolving something new inside an image nobody inspects.
# devDependencies are required — typescript, tailwind, postcss and eslint all run during the build.
RUN npm ci --no-audit --no-fund


# ═══════════════════════════════════════════════════════════════════════════════════════════════
# Stage 2 — builder
# ═══════════════════════════════════════════════════════════════════════════════════════════════
FROM node:${NODE_VERSION}-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# ── The standalone switch ──────────────────────────────────────────────────────────────────────
# Written as a WRAPPER that re-exports the committed config with one field added, rather than as a
# second config file. Every header, redirect, image host and experimental flag therefore stays in force
# and is maintained in exactly one place; a duplicate config would drift the moment somebody adds a
# security header to the real one and not to this.
#
# It is not committed to next.config.ts because this repository also deploys to Vercel (vercel.json),
# where the platform supplies its own output handling and `standalone` is at best redundant.
RUN mv next.config.ts next.config.base.ts \
 && printf '%s\n' \
      'import type { NextConfig } from "next";' \
      'import base from "./next.config.base";' \
      '' \
      '// Generated by the Dockerfile — container builds only. See that file for why this cannot live' \
      '// in next.config.base.ts.' \
      'const config: NextConfig = { ...base, output: "standalone" };' \
      'export default config;' \
      > next.config.ts

# ── Build-time configuration ───────────────────────────────────────────────────────────────────
# ⚠ `NEXT_PUBLIC_*` VALUES ARE INLINED INTO THE BUNDLE HERE. They are not read from the container's
# environment at run time, so putting them in compose's `environment:` block does nothing at all —
# changing one requires a REBUILD, not a restart.
#
# They also default to HOST-REACHABLE addresses rather than compose service names, because the code that
# reads them executes in the BROWSER, which is outside the compose network and cannot resolve `minio`.
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ARG NEXT_PUBLIC_SITE_NAME=Centre of Excellence
ARG NEXT_PUBLIC_CDN_URL=

# ⚠ THE TWO MAP VARIABLES ARE A PAIR AND MUST BE SET TOGETHER. `components/sections/MapSection.tsx`
# reads both: the tile URL decides which provider's tiles are drawn, the attribution decides whose
# credit is printed under every map. Because both are inlined at build time, a container that pointed
# the tiles at Stadia or MapTiler while this argument was absent would publish "© OpenStreetMap
# contributors" beneath somebody else's tiles on the contact page and the craft explorer — a licence
# breach with no way to correct it short of another rebuild. An ARG for one without the other is what
# made that unavoidable, so they are declared together.
ARG NEXT_PUBLIC_MAP_TILE_URL=
ARG NEXT_PUBLIC_MAP_ATTRIBUTION=

# `S3_PUBLIC_BASE_URL` is read by next.config.ts at BUILD time as well, because the image optimiser's
# `remotePatterns` allowlist is derived from it (see `remotePatternsFromEnv`). A host missing from that
# list is refused by the optimiser at request time, which renders as a broken image rather than an error.
ARG S3_PUBLIC_BASE_URL=

ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} \
    NEXT_PUBLIC_SITE_NAME=${NEXT_PUBLIC_SITE_NAME} \
    NEXT_PUBLIC_CDN_URL=${NEXT_PUBLIC_CDN_URL} \
    NEXT_PUBLIC_MAP_TILE_URL=${NEXT_PUBLIC_MAP_TILE_URL} \
    NEXT_PUBLIC_MAP_ATTRIBUTION=${NEXT_PUBLIC_MAP_ATTRIBUTION} \
    S3_PUBLIC_BASE_URL=${S3_PUBLIC_BASE_URL} \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

# A build-only placeholder. `lib/auth/config.ts` refuses to start on a weak secret, and `next build`
# evaluates enough of the app (metadata, route modules) to reach it. This value never leaves the builder
# stage — the runtime stage receives the real one from the environment.
ENV JWT_SECRET=build-stage-only-1f4a8c2e9b7d3506a1f4c8e2b9d7350a6f1c4e8b2d9a73

# A syntactically valid URL the build never connects to. `generateStaticParams` reads the database, and
# `lib/prerender.ts` catches the failure and prerenders nothing — the pages then render on first request
# instead, which is the same behaviour as a route with no `generateStaticParams` at all.
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build?schema=public \
    DIRECT_DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build?schema=public

# `prisma generate` before `next build`: the build imports `@prisma/client`, and without the generated
# client it fails with a message about a missing module rather than a missing generate step.
RUN npx prisma generate

RUN npm run build


# ═══════════════════════════════════════════════════════════════════════════════════════════════
# Stage 3 — migrator
#
# Run once by compose, to completion, before the app starts. It needs the full dependency tree because
# it runs the Prisma CLI and `tsx`; that is exactly why it cannot be the runtime image.
# ═══════════════════════════════════════════════════════════════════════════════════════════════
FROM node:${NODE_VERSION}-bookworm-slim AS migrator

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY package.json package-lock.json tsconfig.json ./
# ⚠ `vendor/` TRAVELS WITH `node_modules`, NOT WITH THE SOURCE. npm materialises a `file:` dependency as a
# SYMLINK into its target directory on Linux, so `node_modules/server-only` copied out of the deps stage
# may be a link pointing at `../vendor/server-only-noop`. Without this line that link dangles, and the
# failure lands at the worst possible moment: `import "server-only"` is reached by lib/search/index.ts and
# lib/auth/password.ts, which prisma/seed.ts imports — so the container would migrate the database and
# then die in the seed, leaving a half-provisioned deployment rather than refusing to start.
#
# Harmless if npm copied rather than linked (it does on some platforms): the directory is two small files
# and the stage already carries the whole of node_modules.
COPY vendor ./vendor
COPY prisma ./prisma
COPY lib ./lib
COPY scripts ./scripts

# `migrate deploy`, never `migrate dev`: deploy applies committed migrations and nothing else, while dev
# will happily invent one from a schema drift — which in a container means an unreviewed DDL statement
# against a real database.
#
# The seed follows in the same command because it is idempotent and non-destructive by construction
# (prisma/seed.ts), so running it on every start is a no-op after the first.
CMD ["sh", "-c", "npx prisma migrate deploy && npm run seed"]


# ═══════════════════════════════════════════════════════════════════════════════════════════════
# Stage 4 — runtime
# ═══════════════════════════════════════════════════════════════════════════════════════════════
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

WORKDIR /app

# node:bookworm-slim already ships an unprivileged `node` account (uid 1000). Reusing it is one fewer
# thing to get wrong than inventing another, and the server needs to write nothing on disk.
USER node

# The three pieces standalone output splits into. Only the first is self-contained: the static chunks and
# the public assets are emitted OUTSIDE the traced bundle and the server expects them at these exact
# paths. Miss `.next/static` and every page loads with no CSS and no JavaScript — a 200 that looks like a
# broken stylesheet rather than a missing copy step.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# ⚠ PRISMA'S ENGINE IS COPIED EXPLICITLY. Next's dependency tracing follows `import` statements, and the
# query engine is a BINARY the client loads at run time by path — nothing imports it, so nothing traces
# it. `serverExternalPackages` in next.config.ts keeps `@prisma/client` out of the bundle, which is
# correct, and leaves getting it into the image to this copy.
COPY --from=builder --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=node:node /app/node_modules/@prisma/client ./node_modules/@prisma/client

EXPOSE 3000

# A 3xx or a 404 still proves the server is answering; only a 5xx or a refused connection means it is
# not. The probe therefore accepts anything under 500 rather than demanding 200.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(r => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))"]

# `server.js` is what standalone output emits — a plain Node server. `next start` is NOT available here
# and would fail: the Next CLI is not part of the traced bundle.
CMD ["node", "server.js"]
