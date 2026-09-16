-- 001 originally shipped with CHECK (list_key IN ('grocery', 'todo')) and was later
-- edited in place to add 'notes'. Because 001 is CREATE TABLE IF NOT EXISTS, that edit
-- only reaches brand-new projects: any backend bootstrapped before it still carries the
-- two-value constraint and rejects every note insert with a check violation.
--
-- Re-state the constraint here so old and new deployments converge. Idempotent: both the
-- implicit name Postgres generated for the inline column check and our explicit name are
-- dropped first, so this is safe to re-run.

ALTER TABLE planner_items DROP CONSTRAINT IF EXISTS planner_items_list_key_check;
ALTER TABLE planner_items DROP CONSTRAINT IF EXISTS planner_items_list_key_allowed;

ALTER TABLE planner_items
  ADD CONSTRAINT planner_items_list_key_allowed
  CHECK (list_key IN ('grocery', 'todo', 'notes'));
