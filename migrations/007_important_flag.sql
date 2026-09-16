-- Backs the "!" importance tag in /listas and the number-addressed
-- important/unimportant actions in telegram-webhook.ts. Important items sort
-- ahead of normal ones (within the open/done split /listas already used), and
-- carry a leading "!" on their display number.
ALTER TABLE planner_items ADD COLUMN IF NOT EXISTS important BOOLEAN NOT NULL DEFAULT false;
