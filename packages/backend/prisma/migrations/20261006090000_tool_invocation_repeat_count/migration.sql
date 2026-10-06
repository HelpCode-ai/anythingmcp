-- How many identical calls this row stands for. A failing call that repeats
-- within a minute (same connector, tool and error) is counted on the first
-- row instead of being stored again: one workspace's own rate limit put
-- 21,000 identical 429 rows a day into this table. Existing rows stand for one
-- call each. Adding a column with a constant default is a catalog-only change
-- in Postgres 11+, so this does not rewrite the table.
ALTER TABLE "tool_invocations" ADD COLUMN "repeat_count" INTEGER NOT NULL DEFAULT 1;
