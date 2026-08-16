import type { NextConfig } from "next";

/**
 * Storage host allowlist for next/image.
 *
 * Derived from the SAME environment variables the storage layer reads (lib/storage/config.ts) so a
 * bucket change cannot leave the optimiser pointing at a host it will refuse. Parsing is defensive:
 * next.config.ts is evaluated during `next build` in environments where these may legitimately be
 * absent (a typecheck-only CI job), and throwing there would fail a build for a reason unrelated to
 * the change under test. A missing host simply contributes no pattern.
 *
 * ⚠ THE BASE URL'S PATH IS PART OF THE ALLOWANCE, NOT DECORATION. Every base URL this project
 * documents and ships is PATH-STYLE — the bucket is a path segment, as `S3_FORCE_PATH_STYLE` requires
 * for MinIO, R2 and Backblaze, and as docker-compose's `http://localhost:9000/cxa-media` shows. A
 * pattern that kept only the host and allowed `/**` would therefore authorise the optimiser to fetch
 * ANY object on that host, not merely the Centre's bucket — and `/_next/image` is unauthenticated
 * (middleware matches `/studio` and `/api/studio` only), so a stranger could push somebody else's
 * bucket through this deployment's optimiser and have it transcoded, cached and hotlinked from the
 * Centre's own domain at the Centre's cost. The configured path becomes the pattern's prefix; a base
 * with no path of its own still gets `/**`, because that is the virtual-hosted shape where the bucket
 * IS the host and the host-wide allowance is what the operator actually asked for.
 *
 * The de-duplication key carries the same prefix. Keyed on the host alone, a deployment whose CDN and
 * storage endpoint sit on one host under different bucket paths lost the second one silently, and
 * every image beneath it was refused as an unconfigured host.
 *
 * ⚠ ONE ENTRY STAYS HOST-WIDE AND CANNOT BE NARROWED HERE: `S3_ENDPOINT` is the SDK's own endpoint and
 * has no bucket path to derive a prefix from. Every image the site renders is addressed through
 * `NEXT_PUBLIC_CDN_URL` (see `publicObjectUrl`), so on a shared storage host that is the base to set —
 * the endpoint entry exists for a deployment that serves objects straight off the storage host, and it
 * is only as narrow as that host is private.
 */
function remotePatternsFromEnv(): NonNullable<NextConfig["images"]>["remotePatterns"] {
  const candidates = [
    process.env.NEXT_PUBLIC_CDN_URL,
    process.env.S3_PUBLIC_BASE_URL,
    process.env.S3_ENDPOINT
  ].filter((value): value is string => Boolean(value && value.trim()));

  const patterns: NonNullable<NextConfig["images"]>["remotePatterns"] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    let url: URL;
    try {
      url = new URL(candidate.trim());
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    // "/" and "" both mean "no bucket path" once the trailing slashes are gone.
    const prefix = url.pathname.replace(/\/+$/, "");
    const key = `${url.protocol}//${url.host}${prefix}`;
    if (seen.has(key)) continue;
    seen.add(key);
    patterns.push({
      protocol: url.protocol === "https:" ? "https" : "http",
      hostname: url.hostname,
      port: url.port || undefined,
      // Legitimate sources are always `<base>/<object key>` — see `publicObjectUrl` in
      // lib/media/url.ts — so everything the site renders lives beneath the prefix.
      pathname: prefix ? `${prefix}/**` : "/**"
    });
  }

  return patterns;
}

type HeaderRule = Awaited<ReturnType<NonNullable<NextConfig["headers"]>>>[number];

/**
 * HSTS — production builds only, returned as a zero-or-one-element array so it can be spread.
 *
 * TWO THINGS ABOUT THE LOCALHOST WORRY, because the obvious fear here is real but misdirected.
 *
 * The fear: HSTS is remembered by the browser PER HOST, so a `localhost` that has been told to use https
 * will refuse plain http for the whole two-year `max-age` — for every other project on that machine as
 * well — and it cannot be undone from the application, only by clearing the browser's HSTS store by
 * hand. That would be a genuinely unpleasant thing to inflict on a colleague's laptop.
 *
 * Why it does not happen: **the specification requires a browser to IGNORE this header when it arrives
 * over an insecure connection** (RFC 6797 §8.1). A local production build served over plain http on
 * localhost therefore sends a header that every browser discards. The protection is in the transport,
 * not in this guard.
 *
 * ⚠ SO WHAT THE `NODE_ENV` CHECK ACTUALLY DOES is narrower than it looks, and worth stating so nobody
 * "fixes" it later on the strength of the wrong reason. `headers()` is evaluated when the config is
 * loaded — at BUILD time for `next build`, at start-up for `next dev` — so this omits the header from
 * the development server and includes it in anything built for production, INCLUDING a production build
 * run locally for verification (`next build && next start`, which is what CI and `npm run smoke` do).
 * That is correct: such a build is production, and on http the header is inert anyway.
 *
 * `preload` is deliberately ABSENT. Submitting a domain to the browsers' preload list is close to
 * irreversible and belongs to whoever owns the domain, not to a framework config file.
 */
function strictTransportSecurityRule(): HeaderRule[] {
  if (process.env.NODE_ENV !== "production") return [];
  return [
    {
      source: "/:path*",
      headers: [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
    }
  ];
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  images: {
    // AVIF first, WebP second: the browser takes the first format it accepts, and AVIF is ~30%
    // smaller on the photographic material this site is mostly made of.
    formats: ["image/avif", "image/webp"],
    remotePatterns: remotePatternsFromEnv(),
    // The derivative pipeline (lib/storage/derivatives.ts) already emits these widths, so the
    // optimiser's own resizes land on cached originals rather than re-fetching the full-size object.
    deviceSizes: [420, 640, 828, 1080, 1280, 1600, 1920, 2560],
    imageSizes: [64, 96, 128, 160, 256, 384]
  },

  experimental: {
    // three/drei ship hundreds of deep ESM files; without this every /craft-explorer visit pulls the
    // whole barrel into the client graph.
    optimizePackageImports: ["lucide-react", "@react-three/drei", "date-fns", "framer-motion"],

    /**
     * ⚠ A TRANSIENT DATABASE BLIP MUST NOT KILL A 59-PAGE EXPORT. The build generates static pages
     * in parallel, and every worker opens its own Prisma pool against the one forwarded Docker
     * port — on this dev box (WSL mirrored networking) the stampede intermittently drops TCP
     * connects, and one failed page aborts the whole `next build`. One retry absorbs the blip;
     * a page that fails twice is a real defect and still fails the build, which is the contract
     * (lib/prerender.ts guards the reads that have an honest fallback; this guards the rest).
     */
    staticGenerationRetryCount: 1,

    /**
     * Enables `forbidden()` and `unauthorized()` from `next/navigation`, and with them
     * `app/forbidden.tsx`.
     *
     * WHY THIS IS NEEDED RATHER THAN NICE. A studio page's guard runs inside a Server Component, where
     * there is no route handler to catch a thrown error: the throw becomes an unhandled server error,
     * Next renders the nearest `error.tsx`, and the reader is told "something went wrong on our
     * side" — which is FALSE. Nothing went wrong; they simply do not have access to that screen. An
     * editor sent to fix the footer, who is shown a 500, reasonably reports a broken CMS.
     *
     * `error.tsx` cannot fix this on its own: Next REDACTS a server error's message in production
     * (replacing it with a generic string and a digest) precisely so a stack trace cannot reach a
     * browser, so the boundary has no way to tell a permission refusal from a genuine fault.
     *
     * `forbidden()` is the framework's own answer — it renders `app/forbidden.tsx` in place, with a
     * real 403 status, and is distinguishable from a fault by construction. See
     * `requireStudioCapability` in lib/auth/current-user.ts, which is the only caller.
     */
    authInterrupts: true
  },

  // sharp is a native binary. Bundling it into the serverless output corrupts the .node artefacts,
  // so it stays external and is resolved from node_modules at runtime.
  serverExternalPackages: ["sharp", "@prisma/client", "bcryptjs"],

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          /**
           * ⚠ `microphone=(self)`, AND THE EMPTY ALLOWLIST IT REPLACES IS WHY THE ORB NEVER HEARD
           * ANYTHING.
           *
           * This read `microphone=()` — an EMPTY allowlist, which is not "ask the reader first", it
           * is "this document may not use the microphone at all, including from its own origin".
           * Under it `getUserMedia({ audio: true })` rejects immediately with `NotAllowedError` and
           * the browser NEVER SHOWS A PROMPT. That is exactly the reported symptom: press "Let it
           * hear you", watch nothing happen, and never get asked for permission — in Chrome, which
           * has the API and would otherwise have offered it.
           *
           * It is also why every fix attempted inside `AiOrb.tsx` was wasted: the component was
           * asking correctly the whole time and the response header was refusing on its behalf,
           * one layer above anything a component can see. A header is the right place to look when
           * a browser API fails silently and identically for every user.
           *
           * `(self)` is the narrow grant, not a blanket one: this origin may ask, and the reader
           * still has to say yes at the browser's own prompt — which is where that decision belongs.
           * Cross-origin frames are still refused, and `camera=()` stays empty because nothing on
           * this site has ever wanted one. Adding an origin here is a real decision: it is the
           * difference between "no code on this page can reach the microphone" and "our code may
           * ask", so it should not be widened past `self` without a reason written down.
           */
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(self), geolocation=(self)"
          },
          /**
           * A DELIBERATELY PARTIAL Content-Security-Policy.
           *
           * There is no `script-src` or `style-src` here, and that is a considered choice rather than an
           * oversight. A meaningful `script-src` needs per-request nonces, and this application renders a
           * BLOCKING INLINE SCRIPT as the first child of `<body>` — the pre-paint theme boot
           * (lib/preferences.ts). Getting a nonce to it means routing every public request through
           * middleware, which today matches only `/studio`. A `script-src` with `'unsafe-inline'`
           * instead would be a policy that permits precisely the thing it is supposed to prevent, while
           * looking in an audit like protection. Better an honest gap than a decorative header.
           *
           * Every directive below, on the other hand, constrains a real attack path and touches no
           * script or style at all, so it cannot break a page:
           *
           *   • `base-uri 'self'` — an injected `<base href>` silently re-points EVERY relative URL on
           *     the page, including form actions, at another origin. Nothing legitimate here sets one.
           *   • `form-action 'self'` — the one that matters most for a CMS. An injected form cannot post
           *     an administrator's credentials to somebody else's server.
           *   • `object-src 'none'` — plugin embeds are a legacy execution vector with no modern use.
           *   • `frame-ancestors 'self'` — the modern replacement for X-Frame-Options, which is kept
           *     above only for browsers that predate it. This is what stops the studio being framed and
           *     click-jacked.
           *   • `upgrade-insecure-requests` — a mixed-content image from an old CMS row is fetched over
           *     https rather than silently blocked.
           *
           * ⚠ Adding `default-src` here would apply to scripts and styles by inheritance and WOULD break
           * the site. If a full policy is wanted, do it properly with nonces, not by extending this list.
           */
          {
            key: "Content-Security-Policy",
            value: [
              "base-uri 'self'",
              "form-action 'self'",
              "object-src 'none'",
              "frame-ancestors 'self'",
              "upgrade-insecure-requests"
            ].join("; ")
          },
          /**
           * Isolates this origin's browsing context from any window that opened it or that it opens, so
           * a cross-origin page cannot hold a reference to a studio window and poke at it.
           */
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          // Adobe's crossdomain.xml is long dead; saying so stops a stray policy file being honoured.
          { key: "X-Permitted-Cross-Domain-Policies", value: "none" }
        ]
      },
      // HSTS is appended below, in production only — see `strictTransportSecurityRule`.
      ...strictTransportSecurityRule(),
      {
        // The CMS must never be indexed, cached by a shared proxy, or embedded.
        source: "/studio/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet" },
          { key: "Cache-Control", value: "no-store, max-age=0, must-revalidate" }
        ]
      },
      {
        source: "/console/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet" }]
      }
    ];
  },

  async redirects() {
    return [
      // /console is the second documented door to the CMS. It is a redirect rather than a duplicate
      // route tree so there is exactly one set of pages to secure.
      { source: "/console", destination: "/studio", permanent: false },
      { source: "/console/:path*", destination: "/studio/:path*", permanent: false }
    ];
  }
};

export default nextConfig;
