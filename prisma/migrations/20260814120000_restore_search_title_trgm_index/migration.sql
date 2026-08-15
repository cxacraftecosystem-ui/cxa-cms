-- Restore the trigram index on `search_documents.title`.
--
-- 20260730182500_search_indexes created it; 20260731054640_master_admin_studio_access_oauth dropped it
-- again with a bare `DROP INDEX "search_documents_title_trgm_idx";` and nothing put it back, so every
-- database built from the committed history since then has been without it. Nothing failed — the
-- queries kept returning the right answers, sequentially scanned, which is why it went unnoticed.
--
-- WHAT DEPENDS ON IT. lib/search/query.ts answers two things with `title ILIKE`: the command palette's
-- suggestions and the fallback for a single-word query the full-text index matched nothing for. Neither
-- can use the surviving `search_documents_fts_idx` — that one is built on `to_tsvector(...)`, a
-- different expression tree entirely — so without this index both are a full scan of the table, on
-- every keystroke, growing with the corpus.
--
-- ⚠ PRISMA WILL PROPOSE THIS DROP AGAIN. An expression index cannot be written in schema.prisma, so
-- `prisma migrate dev` sees an index it did not create and generates a `DROP INDEX` for it in the next
-- migration. That drop must be DELETED from the generated SQL before it is committed — exactly as it
-- should have been in 20260731054640. The same warning applies to `search_documents_fts_idx`.
--
-- ⚠ AND THE HISTORICAL DROP STAYS AS IT IS. A migration that has already run is immutable: editing it
-- changes its checksum and every deployed database refuses to migrate. The repair is this new
-- migration, written so it is a no-op on a database that still has the index.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "search_documents_title_trgm_idx"
  ON "search_documents" USING GIN (title gin_trgm_ops);
