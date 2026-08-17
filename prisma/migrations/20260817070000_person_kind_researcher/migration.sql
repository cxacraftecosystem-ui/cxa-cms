-- Rename the personnel group RESEARCH_ASSISTANT to RESEARCHER.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- WHY A RENAME AND NOT A NEW VALUE. "Research assistant" is a JOB TITLE, and it is one KIND of
-- researcher rather than a category of its own — a postdoc, a project associate and a research
-- assistant all belong in the same section of the public roster. The group was named after the
-- narrowest job it contained, so people who were plainly researchers had nowhere correct to sit.
-- Renaming the group keeps every existing row exactly where it is and costs nothing; adding
-- RESEARCHER alongside would have left two groups meaning the same thing and a migration to decide
-- who moved.
--
-- ⚠ THE JOB TITLE IS DELIBERATELY UNTOUCHED. `Person.designation` is free text, `ProjectMember.role`
-- is free text, and "Research assistant" remains a correct value in both — the help text on the Job
-- title field still offers it as an example. What changed is the name of the GROUP, which is
-- `Person.kind`. Anything in this repository that says "research assistant" about a job was left
-- alone on purpose; only the places naming the group were rewritten.
--
-- ⚠ `ALTER TYPE … RENAME VALUE` IS NOT `ADD VALUE`, AND THAT IS WHY THIS IS SAFE. The migration on
-- 20260816180000 warns at length that an enum value can never be removed, because Postgres offers
-- ADD VALUE and no DROP VALUE. A rename is the exception: it changes the LABEL and leaves the value's
-- identity alone, so no column is rewritten, no index is rebuilt, no row moves and nothing takes an
-- ACCESS EXCLUSIVE lock. It is also transactional — unlike ADD VALUE on older servers — so this whole
-- file commits or does none of it. The stack runs Postgres 17.
--
-- ⚠ AND THE JSON COPIES HAVE TO FOLLOW, WHICH IS THE HALF THAT IS EASY TO MISS. Renaming the label
-- updates `people.kind` for free, because the rows never held the text — they hold the type's value.
-- But this application also writes the label into JSONB, in three places, and those really do hold
-- text:
--
--   • `revisions.data`   — a Person revision is a full serialised profile, `kind` included, and
--                          `Person` is in `ROLLBACKABLE` (app/studio/audit/page.tsx). Restoring an
--                          untouched revision after this rename would try to write a label the type no
--                          longer has, and the administrator doing it would get a failed rollback on a
--                          record that looked fine.
--   • `audit_logs.before` / `.after` — the same serialised profiles, plus the People reorder entries
--                          whose payload is `{ kind, order: [...] }`. Nothing reads these back into the
--                          database, but the audit screen prints them, and a trail that names a group
--                          which no longer exists is a trail somebody has to come and ask about.
--   • `page_sections.data` — a people-showcase block stores its group filter here. No live block uses
--                          this group today (checked: zero rows), but a database restored from an older
--                          dump might, and the Zod enum in lib/sections/schema.ts would silently strip
--                          an unknown filter on the next read — a block that quietly stops filtering.
--
-- WHY A TEXT REPLACE RATHER THAN `jsonb_set`. The label appears at different depths and under
-- different keys in those three payload shapes — top-level on a profile, inside `order` on a reorder
-- entry, inside a section's `data` — so a targeted `jsonb_set` would need one statement per shape and
-- would silently miss any shape not thought of. Replacing the QUOTED token in the serialised text
-- catches every position, and the quotes are what make it safe: `"RESEARCH_ASSISTANT"` with both
-- quotes is a complete JSON string, so it cannot match a substring of a longer word, a key name, or
-- the phrase "research assistant" written in somebody's biography. Each statement is also restricted
-- to rows that actually contain it, so nothing else is rewritten or has its jsonb reformatted.
--
-- ⚠ SEARCH DOCUMENTS ARE LEFT ALONE, and that is a decision rather than an omission. `humaniseEnum`
-- in lib/search/index.ts lower-cases and de-underscores the group into the indexed text, so documents
-- written before today read "research assistant". Rewriting them here would mean reproducing the
-- indexer's text-building rules in SQL, where they would drift. The cost of leaving them is that
-- searching "research assistant" still finds those people until their records are next saved — which
-- is a feature, not a fault, since that is still what many readers will type.
--
-- ROLLING BACK is the same statement with the two labels swapped, plus the same three JSON updates in
-- reverse. Nothing is lost either way.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

-- AlterEnum
ALTER TYPE "PersonKind" RENAME VALUE 'RESEARCH_ASSISTANT' TO 'RESEARCHER';

-- The JSON copies of the old label.
UPDATE "revisions"
   SET data = replace(data::text, '"RESEARCH_ASSISTANT"', '"RESEARCHER"')::jsonb
 WHERE data::text LIKE '%"RESEARCH_ASSISTANT"%';

UPDATE "audit_logs"
   SET before = replace(before::text, '"RESEARCH_ASSISTANT"', '"RESEARCHER"')::jsonb
 WHERE before::text LIKE '%"RESEARCH_ASSISTANT"%';

UPDATE "audit_logs"
   SET after = replace(after::text, '"RESEARCH_ASSISTANT"', '"RESEARCHER"')::jsonb
 WHERE after::text LIKE '%"RESEARCH_ASSISTANT"%';

UPDATE "page_sections"
   SET data = replace(data::text, '"RESEARCH_ASSISTANT"', '"RESEARCHER"')::jsonb
 WHERE data::text LIKE '%"RESEARCH_ASSISTANT"%';
