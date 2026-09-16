-- Short-lived side table for the Telegram bot's interactive buttons.
--
-- Telegram caps callback_data at 64 bytes, which is nowhere near enough to
-- carry the rows an "undo" has to restore, or the candidate list behind a
-- disambiguation prompt. So the button carries a short id and the real payload
-- lives here. Rows are disposable: they are pruned after PRUNE_AFTER and
-- nothing but the chat depends on them.
CREATE TABLE IF NOT EXISTS bot_actions (
  id TEXT PRIMARY KEY,
  -- 'undo'   -> payload.ops is the list of inverse operations to replay
  -- 'choice' -> payload.options is the candidate list the user must pick from
  kind TEXT NOT NULL CHECK (kind IN ('undo', 'choice')),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bot_actions_created_at_idx ON bot_actions (created_at);

ALTER TABLE bot_actions ENABLE ROW LEVEL SECURITY;
