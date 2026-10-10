import { PrismaPg } from "@prisma/adapter-pg";

/**
 * The database connection: Prisma 7's PostgreSQL driver adapter, configured from the SAME `DATABASE_URL`
 * the application has always used.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THERE IS AN ADAPTER AT ALL. From Prisma 7 the client has no query engine of its own: it compiles
 * queries in-process and hands them to a driver, and `new PrismaClient()` without one throws ("A driver
 * adapter is required"). `@prisma/adapter-pg` is node-postgres — one `pg.Pool` under the client.
 *
 * WHY THE URL IS TRANSLATED RATHER THAN PASSED THROUGH. Production's `DATABASE_URL` carries parameters
 * that were PRISMA'S OWN until Prisma 7 (docs/DEPLOYMENT.md §1.4) — `connection_limit`, `pool_timeout`,
 * `pgbouncer`, `schema` — and an `sslmode` that node-postgres reads differently. Handed to node-postgres
 * verbatim they would be ignored or, worse, reinterpreted, and the URL is a deployment secret this
 * upgrade must not need re-issued. So each one is read here and given its node-postgres meaning:
 *
 *   • `connection_limit` → the pool's `max`: ONE pool per copy of the application, of that size, as
 *     before. Absent, node-postgres's own default (10) applies.
 *   • `pool_timeout` (seconds) → `connectionTimeoutMillis`: how long a query waits for a free connection,
 *     or for a new one to open, before failing. Absent, Prisma's old default of 10 s is kept, because
 *     node-postgres's own default is to wait for ever.
 *   • `pgbouncer=true` → nothing to do, and that is the point. Prisma had to be told to stop naming its
 *     prepared statements behind a transaction pooler; the adapter names none unless it is handed a
 *     `statementNameGenerator`, and this file hands it none.
 *   • `schema` → the adapter's own `schema` option.
 *   • `sslmode=require` → TLS WITHOUT verifying the certificate — exactly what Prisma 6 and libpq do.
 *     ⚠ node-postgres treats `require` as `verify-full` and checks the certificate against Node's own CA
 *     list, which does not hold the CA Supabase's pooler presents its certificate from: left to
 *     node-postgres, every production query would fail with "self-signed certificate in certificate
 *     chain". `verify-ca` and `verify-full` keep verification; `disable` turns TLS off; `prefer` and
 *     `allow` mean "TLS if offered", which node-postgres cannot do, so they connect in plain text — what a
 *     local Postgres without TLS needs. Prisma's `sslaccept=accept_invalid_certs|strict` is honoured too.
 *
 * Everything else in the URL — host, port, user, password, database, `application_name`, `options` — is
 * node-postgres's own and goes through untouched.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * NO `server-only`: the seed, the smoke test, the leak check and the maintenance scripts build their
 * clients with this under plain Node, as `lib/db.ts` does inside the application.
 */
export function prismaAdapter(databaseUrl: string | undefined): PrismaPg {
  const { connectionString, pool, schema } = translateDatabaseUrl(databaseUrl);
  return new PrismaPg({ connectionString, ...pool }, schema ? { schema } : undefined);
}

/** Prisma 6's parameters that node-postgres must not see — each is translated above, or meaningless now. */
const PRISMA_ONLY_PARAMETERS = [
  "connection_limit",
  "pool_timeout",
  "connect_timeout",
  "socket_timeout",
  "pgbouncer",
  "statement_cache_size",
  "schema",
  "sslmode",
  "sslaccept",
  "sslcert",
  "sslidentity",
  "sslpassword"
] as const;

const DEFAULT_POOL_TIMEOUT_SECONDS = 10;

interface TranslatedUrl {
  connectionString: string | undefined;
  pool: {
    max?: number;
    connectionTimeoutMillis: number;
    ssl?: boolean | { rejectUnauthorized: boolean };
  };
  schema: string | undefined;
}

/** Exported for the adapter check in scripts/; the application only ever calls `prismaAdapter`. */
export function translateDatabaseUrl(databaseUrl: string | undefined): TranslatedUrl {
  if (!databaseUrl) {
    return { connectionString: undefined, pool: { connectionTimeoutMillis: DEFAULT_POOL_TIMEOUT_SECONDS * 1000 }, schema: undefined };
  }

  const url = new URL(databaseUrl);
  const read = (name: string) => url.searchParams.get(name) ?? undefined;
  const seconds = (value: string | undefined) => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };

  const limit = seconds(read("connection_limit"));
  const poolTimeout = seconds(read("pool_timeout")) ?? DEFAULT_POOL_TIMEOUT_SECONDS;
  const schema = read("schema");
  const ssl = sslFor(read("sslmode"), read("sslaccept"));

  for (const name of PRISMA_ONLY_PARAMETERS) url.searchParams.delete(name);

  return {
    connectionString: url.toString(),
    pool: {
      ...(limit !== undefined && limit > 0 ? { max: Math.floor(limit) } : {}),
      connectionTimeoutMillis: poolTimeout * 1000,
      ...(ssl === undefined ? {} : { ssl })
    },
    schema
  };
}

function sslFor(
  sslmode: string | undefined,
  sslaccept: string | undefined
): boolean | { rejectUnauthorized: boolean } | undefined {
  const verify =
    sslaccept === "accept_invalid_certs" ? false : sslaccept === "strict" ? true : undefined;
  switch (sslmode) {
    case "require":
      return { rejectUnauthorized: verify ?? false };
    case "verify-ca":
    case "verify-full":
      return { rejectUnauthorized: verify ?? true };
    case "disable":
    case "prefer":
    case "allow":
      return false;
    default:
      return verify === undefined ? undefined : { rejectUnauthorized: verify };
  }
}
