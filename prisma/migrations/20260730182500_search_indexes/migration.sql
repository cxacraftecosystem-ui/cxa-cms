-- Full-text search indexes for `search_documents`.
--
-- Prisma cannot express an EXPRESSION index in schema.prisma, so this migration is hand-written and
-- must be kept in step with the query in lib/search/query.ts. If the expression here and the one in
-- the query ever differ by so much as a `coalesce`, Postgres silently declines to use the index and
-- every search becomes a sequential scan of the whole table — fast on a hundred rows, and a timeout
-- on a hundred thousand.
--
-- Three things about the expression are load-bearing:
--
--  1. `coalesce` on every column. `summary` is nullable and `text || NULL` is NULL in SQL, so one
--     missing summary would null the entire concatenation and that row would match nothing, ever,
--     silently.
--  2. The TWO-argument `to_tsvector` with a literal config. The one-argument form depends on
--     `default_text_search_config`, which makes it STABLE rather than IMMUTABLE, and Postgres refuses
--     to build an index on a non-immutable expression.
--  3. `keywords` is deliberately absent. `array_to_string` is STABLE for the same reason, so
--     including it would make this index impossible to create. lib/search/index.ts folds the keywords
--     into `body` at write time instead, which is why they are still searchable.

CREATE INDEX IF NOT EXISTS "search_documents_fts_idx"
  ON "search_documents"
  USING GIN (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(body, '')));

-- Trigram index for the short-query prefix fallback. A one- or two-character query produces a
-- tsquery that matches nothing useful, so the query falls back to ILIKE on the title; without this
-- index that fallback is a table scan on every keystroke of a search-as-you-type box.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "search_documents_title_trgm_idx"
  ON "search_documents" USING GIN (title gin_trgm_ops);
