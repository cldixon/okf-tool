-- The operator's portal counts who was active in the last 30 days (TEMPRA-278, operator.ts):
-- sessions and agents by when they were last seen, so the count reads only the month's rows.
CREATE INDEX IF NOT EXISTS sessions_last_seen ON sessions (last_seen);
CREATE INDEX IF NOT EXISTS agents_last_seen ON agents (last_seen);
