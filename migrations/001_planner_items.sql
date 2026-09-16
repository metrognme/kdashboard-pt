CREATE TABLE IF NOT EXISTS planner_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- All three lists are read by kindle-dashboard-data.ts, hashed by
  -- kindle-dashboard-events.ts, and rendered as their own tile. Adding a value
  -- here is not enough on its own: this file is CREATE TABLE IF NOT EXISTS, so
  -- existing deployments need a follow-up migration (see 003) to widen the
  -- constraint they already have.
  list_key TEXT NOT NULL CHECK (list_key IN ('grocery', 'todo', 'notes')),
  text TEXT NOT NULL CHECK (length(trim(text)) > 0),
  done BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS planner_items_list_done_created_idx
  ON planner_items (list_key, done, created_at);

DROP TRIGGER IF EXISTS planner_items_updated_at ON planner_items;
CREATE TRIGGER planner_items_updated_at
  BEFORE UPDATE ON planner_items
  FOR EACH ROW
  EXECUTE FUNCTION system.update_updated_at();
