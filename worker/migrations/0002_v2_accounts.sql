-- v2 accounts (v2 spec: Accounts and sign-in, Tenancy and authorization).

-- Every user has a handle: library paths carry it, and their actor is human:<handle>.
ALTER TABLE users ADD COLUMN handle TEXT;
-- Set by the operator to refuse the account's sessions and tokens without deleting anything.
ALTER TABLE users ADD COLUMN suspended TEXT;
UPDATE users SET handle = lower(replace(substr(actor, 7), '.', '-'));
UPDATE users SET handle = handle || '-' || rowid
WHERE EXISTS (SELECT 1 FROM users u WHERE u.handle = users.handle AND u.rowid < users.rowid);
CREATE UNIQUE INDEX users_handle ON users (handle);

-- Library names are unique per owner, not across the service: rebuild the table without the
-- global UNIQUE(slug). tokens.library references it, so foreign keys are checked at commit.
PRAGMA defer_foreign_keys = true;
CREATE TABLE libraries_v2 (
  id         TEXT PRIMARY KEY,
  slug       TEXT NOT NULL,
  owner      TEXT REFERENCES users(id),
  visibility TEXT NOT NULL,
  created    TEXT,
  do_id      TEXT NOT NULL, -- the name the Library Durable Object is addressed by
  UNIQUE (owner, slug)
);
INSERT INTO libraries_v2 (id, slug, owner, visibility, created, do_id)
  SELECT id, slug, owner, visibility, created, do_id FROM libraries;
DROP TABLE libraries;
ALTER TABLE libraries_v2 RENAME TO libraries;
PRAGMA defer_foreign_keys = false;

-- Magic links: only a hash of the secret is stored; single use, short-lived.
CREATE TABLE sign_in_links (
  hash    TEXT PRIMARY KEY,
  email   TEXT NOT NULL,
  created TEXT NOT NULL,
  expires TEXT NOT NULL,
  ip      TEXT,
  used    TEXT
);
CREATE INDEX sign_in_links_email ON sign_in_links (email, created);

-- Browser sessions: only a hash of the cookie's secret is stored.
CREATE TABLE sessions (
  hash         TEXT PRIMARY KEY,
  user         TEXT NOT NULL REFERENCES users(id),
  created      TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  idle_expires TEXT NOT NULL,
  expires      TEXT NOT NULL,
  user_agent   TEXT
);
CREATE INDEX sessions_user ON sessions (user);
