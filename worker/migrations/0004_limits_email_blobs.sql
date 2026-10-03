-- v2 A3 (v2 spec: Limits, abuse and metering; Accounts and sign-in).

-- Per-account limit overrides, as JSON ({"libraries": 10}); NULL means the defaults (limits.ts).
ALTER TABLE users ADD COLUMN limits TEXT;

-- Links are for signing in or for confirming a new email address (then `user` is the account).
ALTER TABLE sign_in_links ADD COLUMN purpose TEXT NOT NULL DEFAULT 'sign-in';
ALTER TABLE sign_in_links ADD COLUMN user TEXT;

-- Attachment blobs no library references, since when; the daily sweep deletes them after 31 days.
CREATE TABLE blob_orphans (
  hash  TEXT PRIMARY KEY,
  since TEXT NOT NULL
);
