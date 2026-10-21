import pg from "pg";

/**
 * Counts the SQL statements the application sends, for the query-count regression tests in this folder.
 *
 * Prisma 7 talks to Postgres through `@prisma/adapter-pg`, which is node-postgres underneath: every
 * statement — a `findMany`, each relation an `include` loads, `BEGIN` and `COMMIT` of an interactive
 * transaction — ends in `pg.Client.prototype.query`. Wrapping that one method sees all of them without the
 * application's client being built any differently from production's, which is the point: a counter that
 * needed `lib/db.ts` to be configured for it would be measuring a different client.
 *
 * Installed once, on import, and inert until `countStatements` is running. The test runner gives every test
 * FILE its own process, and the tests inside one run in sequence, so there is never a second caller.
 */

type QueryArgument = string | { text?: string } | undefined;

let recording: string[] | null = null;

const prototype = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
const original = prototype.query;
prototype.query = function query(this: unknown, ...args: unknown[]) {
  if (recording) {
    const first = args[0] as QueryArgument;
    recording.push(typeof first === "string" ? first : (first?.text ?? "<unknown>"));
  }
  return original.apply(this, args);
};

/** Run `work` and return what it produced together with every statement it sent, in order. */
export async function countStatements<T>(work: () => Promise<T>): Promise<{ result: T; statements: string[] }> {
  if (recording) throw new Error("countStatements does not nest.");
  const statements: string[] = [];
  recording = statements;
  try {
    const result = await work();
    return { result, statements };
  } finally {
    recording = null;
  }
}

/** The statements that are not transaction control — what a reader means by "queries". */
export function dataStatements(statements: readonly string[]): string[] {
  return statements.filter((sql) => !/^\s*(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)\b/i.test(sql));
}
