import type { SqlHandle } from "./sql";

/**
 * The Library DO schema (spec: Data model). `blobs` and `events` are the source of truth and are
 * append-only; every other table is derived and can be rebuilt by replaying `events`.
 */
export const SCHEMA_VERSION = 2;

const V1 = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS blobs (
  hash      TEXT PRIMARY KEY,
  size      INTEGER NOT NULL,
  location  TEXT NOT NULL,
  content   BLOB,
  media     TEXT
);

CREATE TABLE IF NOT EXISTS events (
  seq         INTEGER PRIMARY KEY,
  ts          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  request_id  TEXT NOT NULL,
  op          TEXT NOT NULL,
  path        TEXT NOT NULL,
  prev_hash   TEXT,
  hash        TEXT,
  concept_id  TEXT NOT NULL,
  meta        TEXT
);
CREATE INDEX IF NOT EXISTS events_path ON events(path, seq);
CREATE INDEX IF NOT EXISTS events_request ON events(request_id);
CREATE INDEX IF NOT EXISTS events_concept ON events(concept_id, seq);

CREATE TABLE IF NOT EXISTS paths (
  path        TEXT PRIMARY KEY,
  concept_id  TEXT NOT NULL UNIQUE,
  hash        TEXT NOT NULL REFERENCES blobs(hash),
  kind        TEXT NOT NULL,
  last_seq    INTEGER NOT NULL,
  created_seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS concepts (
  concept_id   TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  title        TEXT,
  description  TEXT,
  resource     TEXT,
  status       TEXT NOT NULL,
  stale_after  TEXT,
  generated_by TEXT,
  generated_at TEXT,
  extra        TEXT,
  lint         TEXT
);
CREATE TABLE IF NOT EXISTS verifications (
  concept_id TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL, seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS verifications_concept ON verifications(concept_id, seq);
CREATE TABLE IF NOT EXISTS tags (concept_id TEXT, tag TEXT, PRIMARY KEY (concept_id, tag));
CREATE TABLE IF NOT EXISTS links (
  from_id    TEXT NOT NULL,
  to_id      TEXT,
  to_path    TEXT,
  anchor     TEXT,
  form       TEXT NOT NULL,
  raw        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS links_from_id ON links(from_id);
CREATE INDEX IF NOT EXISTS links_to_id ON links(to_id);
CREATE INDEX IF NOT EXISTS links_to_path ON links(to_path);
CREATE TABLE IF NOT EXISTS redirects (
  old_path   TEXT PRIMARY KEY,
  concept_id TEXT NOT NULL,
  since_seq  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  concept_id  TEXT NOT NULL,
  id          TEXT,
  resource    TEXT NOT NULL,
  internal_id TEXT,
  cited       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sources_concept ON sources(concept_id);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(concept_id UNINDEXED, title, body, tags);

CREATE TABLE IF NOT EXISTS cursors (maintainer TEXT PRIMARY KEY, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS access_log (day TEXT, concept_id TEXT, actor TEXT, reads INTEGER);
CREATE TABLE IF NOT EXISTS flags (
  concept_id TEXT, kind TEXT, since_seq INTEGER, detail TEXT,
  PRIMARY KEY (concept_id, kind)
);
`;

/** v2: links also carry internal `sources[].resource` citations, told apart by `kind`. */
const V2 = `ALTER TABLE links ADD COLUMN kind TEXT NOT NULL DEFAULT 'body';`;

/** Creates or migrates the schema forward; a no-op when already current. */
export function migrate(sql: SqlHandle): void {
  sql.script("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  const row = sql.all<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")[0];
  const current = row ? Number(row.value) : 0;
  if (current >= SCHEMA_VERSION) return;
  sql.transaction(() => {
    if (current < 1) sql.script(V1);
    if (current < 2) sql.script(V2);
    sql.run(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(SCHEMA_VERSION),
    );
  });
}
