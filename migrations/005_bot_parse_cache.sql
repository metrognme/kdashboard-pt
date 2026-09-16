-- Memo table for the message classifier.
--
-- "comprar leite" parses to the same action every time, so paying a model
-- request for it again is pure waste — and on Gemini's free tier requests are
-- the scarce resource, not tokens.
--
-- Only time-independent results are ever stored here. A calendar action is
-- resolved against "now" ("amanhã às 14h"), so caching one would hand back
-- yesterday's date tomorrow; the writer refuses those.
CREATE TABLE IF NOT EXISTS bot_parse_cache (
  -- FNV-1a of the normalized message text. A hash rather than the text itself
  -- keeps the primary key short and fixed-width.
  message_hash TEXT PRIMARY KEY,
  action JSONB NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bot_parse_cache_last_used_idx ON bot_parse_cache (last_used_at);

ALTER TABLE bot_parse_cache ENABLE ROW LEVEL SECURITY;
