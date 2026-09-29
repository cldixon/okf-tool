-- Account layer (spec: Data model, D1 schema). Shared across libraries.
CREATE TABLE users (
  id      TEXT PRIMARY KEY,
  email   TEXT UNIQUE,
  actor   TEXT NOT NULL,
  created TEXT
);

CREATE TABLE libraries (
  id         TEXT PRIMARY KEY,
  slug       TEXT UNIQUE,
  owner      TEXT REFERENCES users(id),
  visibility TEXT NOT NULL,
  created    TEXT,
  do_id      TEXT NOT NULL -- the name the Library Durable Object is addressed by
);

CREATE TABLE tokens (
  id         TEXT PRIMARY KEY,
  hash       TEXT UNIQUE NOT NULL, -- sha256 of the secret; the secret is never stored
  library    TEXT REFERENCES libraries(id),
  actor      TEXT NOT NULL,
  scope      TEXT NOT NULL,        -- 'read' | 'write'
  prefix     TEXT,
  expires    TEXT,
  mcp_tiers  TEXT NOT NULL DEFAULT 'all',
  created_by TEXT,
  last_used  TEXT,
  revoked    TEXT
);
