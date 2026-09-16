-- Backs the daily digest (/resumo, /resumo_hora, and the hourly schedule tick
-- in telegram-webhook.ts).
--
-- completed_at is set only when `done` flips true, and cleared when it flips
-- back — updated_at already moves on a plain list-to-list move, so it cannot
-- tell "completed today" from "just reorganized today".
ALTER TABLE planner_items ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- Tiny key-value store for the one thing the digest needs configurable from
-- chat without a redeploy: the local hour it closes the day at, plus the last
-- local date it actually ran, so an hourly tick that lands more than once
-- inside the same hour never double-sends.
CREATE TABLE IF NOT EXISTS bot_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS bot_settings_updated_at ON bot_settings;
CREATE TRIGGER bot_settings_updated_at
  BEFORE UPDATE ON bot_settings
  FOR EACH ROW
  EXECUTE FUNCTION system.update_updated_at();

ALTER TABLE bot_settings ENABLE ROW LEVEL SECURITY;
