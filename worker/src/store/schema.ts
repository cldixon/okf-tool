import type { SqlHandle } from "./sql";

/**
 * The Library DO schema (spec: Data model). `blobs` and `events` are the source of truth and are
 * append-only; every other table is derived and can be rebuilt by replaying `events`. A page's
 * blob is its record: the stored tree and its markdown (tempra-dev: decisions/structured-documents);
 * `fts` indexes the markdown.
 *
 * Version 1 is a restart (TEMPRA-22): libraries stored in an earlier format are not read.
 * Version 2 names a library's markdown files pages, not concepts, and keeps no `type` column
 * (tempra-dev: decisions/pages-not-okf); `upgradeToPages` brings a version 1 library forward.
 */
export const SCHEMA_VERSION = 2;

/**
 * Counts over the whole ledger, kept by triggers as events are appended (TEMPRA-86), so `stats`
 * and `contributors` never scan it: the number of events and requests, and per person and agent
 * (the `by` in an event's meta, TEMPRA-75) their requests and first and last seq. Libraries from
 * before get these once, filled from the ledger (`LibraryStore`'s `addLedgerCounts`).
 */
export const LEDGER_COUNTS = `
CREATE TABLE IF NOT EXISTS ledger_counts (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  events   INTEGER NOT NULL,
  requests INTEGER NOT NULL
);
INSERT OR IGNORE INTO ledger_counts (id, events, requests) VALUES (1, 0, 0);
-- person and agent as json_extract gives them (agent may be NULL); agent_key tells NULL apart.
CREATE TABLE IF NOT EXISTS contributors (
  person    NOT NULL,
  agent,
  agent_key TEXT NOT NULL,
  requests  INTEGER NOT NULL,
  first_seq INTEGER NOT NULL,
  last_seq  INTEGER NOT NULL,
  PRIMARY KEY (person, agent_key)
);
CREATE INDEX IF NOT EXISTS contributors_last ON contributors(last_seq);
CREATE TRIGGER IF NOT EXISTS events_counted AFTER INSERT ON events
BEGIN
  UPDATE ledger_counts SET events = events + 1,
    requests = requests + NOT EXISTS (
      SELECT 1 FROM events WHERE request_id = NEW.request_id AND seq <> NEW.seq)
  WHERE id = 1;
  INSERT INTO contributors (person, agent, agent_key, requests, first_seq, last_seq)
  SELECT json_extract(NEW.meta, '$.by.person'), json_extract(NEW.meta, '$.by.agent'),
         CASE WHEN json_extract(NEW.meta, '$.by.agent') IS NULL THEN 'n'
              ELSE 's' || json_extract(NEW.meta, '$.by.agent') END,
         1, NEW.seq, NEW.seq
  WHERE NEW.meta IS NOT NULL AND json_extract(NEW.meta, '$.by.person') IS NOT NULL
  ON CONFLICT (person, agent_key) DO UPDATE SET last_seq = excluded.last_seq,
    requests = requests + NOT EXISTS (
      SELECT 1 FROM events e WHERE e.request_id = NEW.request_id AND e.seq <> NEW.seq
        AND json_extract(e.meta, '$.by.person') = json_extract(NEW.meta, '$.by.person')
        AND json_extract(e.meta, '$.by.agent') IS json_extract(NEW.meta, '$.by.agent'));
END;
`;

/**
 * Pele's verdicts on diagram sources, by Pele's version and the SHA-256 of the source
 * (`<version>:<sha256>`, TEMPRA-167), so an upgrade asks again: `error` is the
 * render service's failure as JSON, NULL when it draws. A cache of answers from outside the
 * ledger, not derived from it: losing it only means asking the render service again. Libraries
 * from before get it on open.
 */
export const DIAGRAM_RENDERS = `
CREATE TABLE IF NOT EXISTS diagram_renders (key TEXT PRIMARY KEY, error TEXT);
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS blobs (
  hash      TEXT PRIMARY KEY,
  size      INTEGER NOT NULL,
  location  TEXT NOT NULL,
  content   BLOB,
  media     TEXT,
  width     INTEGER,
  height    INTEGER
);
-- blobs.width and height: an image's size in pixels from its header (TEMPRA-152); 0 when checked
-- and unknown, NULL when never worked out (a library from before, filled on first read). Kept out
-- of the CREATE TABLE, whose text SQLite rewrites on ALTER TABLE (a comment in it broke DROP
-- COLUMN on the SQLite that bun 1.3 ships).

CREATE TABLE IF NOT EXISTS events (
  seq         INTEGER PRIMARY KEY,
  ts          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  request_id  TEXT NOT NULL,
  op          TEXT NOT NULL,
  path        TEXT NOT NULL,
  prev_hash   TEXT,
  hash        TEXT,
  page_id     TEXT NOT NULL,
  meta        TEXT
);
CREATE INDEX IF NOT EXISTS events_path ON events(path, seq);
CREATE INDEX IF NOT EXISTS events_request ON events(request_id);
CREATE INDEX IF NOT EXISTS events_page ON events(page_id, seq);

CREATE TABLE IF NOT EXISTS paths (
  path        TEXT PRIMARY KEY,
  page_id     TEXT NOT NULL UNIQUE,
  hash        TEXT NOT NULL REFERENCES blobs(hash),
  kind        TEXT NOT NULL,
  last_seq    INTEGER NOT NULL,
  created_seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
  page_id      TEXT PRIMARY KEY,
  title        TEXT,
  description  TEXT,
  resource     TEXT,
  status       TEXT NOT NULL,
  stale_after  TEXT,
  stale_ms     INTEGER,
  generated_by TEXT,
  generated_at TEXT,
  extra        TEXT,
  lint         TEXT
);
-- pages.stale_ms: stale_after as epoch ms, for the staleness process's range query (TEMPRA-63).
CREATE INDEX IF NOT EXISTS pages_stale ON pages(stale_ms) WHERE stale_ms IS NOT NULL;
CREATE TABLE IF NOT EXISTS verifications (
  page_id TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL, seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS verifications_page ON verifications(page_id, seq);
CREATE TABLE IF NOT EXISTS tags (page_id TEXT, tag TEXT, PRIMARY KEY (page_id, tag));
-- Body links and internal \`sources[].resource\` citations, told apart by \`kind\`.
CREATE TABLE IF NOT EXISTS links (
  from_id    TEXT NOT NULL,
  to_id      TEXT,
  to_path    TEXT,
  anchor     TEXT,
  form       TEXT NOT NULL,
  raw        TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'body'
);
CREATE INDEX IF NOT EXISTS links_from_id ON links(from_id);
CREATE INDEX IF NOT EXISTS links_to_id ON links(to_id);
CREATE INDEX IF NOT EXISTS links_to_path ON links(to_path);
CREATE TABLE IF NOT EXISTS redirects (
  old_path   TEXT PRIMARY KEY,
  page_id    TEXT NOT NULL,
  since_seq  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  page_id     TEXT NOT NULL,
  id          TEXT,
  resource    TEXT NOT NULL,
  internal_id TEXT,
  cited       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sources_page ON sources(page_id);
-- Stemmed (TEMPRA-17): "comments" finds "comment"; LibraryStore's stemSearch upgrades older libraries.
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(page_id UNINDEXED, title, body, tags, tokenize = 'porter unicode61');
-- Each page's row in fts, so a write replaces it by rowid instead of scanning fts (TEMPRA-87).
CREATE TABLE IF NOT EXISTS fts_rows (page_id TEXT PRIMARY KEY, fts_rowid INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS cursors (maintainer TEXT PRIMARY KEY, seq INTEGER NOT NULL);
-- One row per day, page, surface, reader kind and reader (in actor), so reads are counted
-- with an upsert (TEMPRA-220). Its unique index, (page_id, day, surface, kind, actor), is made
-- by LibraryStore's addReadHistory, which also upgrades libraries from before (rows with '').
CREATE TABLE IF NOT EXISTS access_log (
  day TEXT, page_id TEXT, actor TEXT, reads INTEGER,
  surface TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT ''
);
-- The last read of each page on each surface (TEMPRA-220), kept past the usage window.
CREATE TABLE IF NOT EXISTS last_read (
  page_id TEXT NOT NULL, surface TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (page_id, surface)
);
CREATE TABLE IF NOT EXISTS flags (
  page_id TEXT, kind TEXT, since_seq INTEGER, detail TEXT,
  PRIMARY KEY (page_id, kind)
);
CREATE INDEX IF NOT EXISTS flags_kind ON flags(kind);

-- A thread's page_id is '' for a library thread (TEMPRA-222): on the library itself, not a
-- page, its events' path and page_id '' too. kind is 'comment' or 'request' (a bigger ask the
-- managed agent left for people's agents); LibraryStore's addThreadKinds upgrades older libraries.
CREATE TABLE IF NOT EXISTS threads (
  id           TEXT PRIMARY KEY,
  page_id      TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'comment',
  actor        TEXT NOT NULL,
  anchor       TEXT,
  status       TEXT NOT NULL,
  created_seq  INTEGER NOT NULL,
  last_seq     INTEGER NOT NULL,
  last_actor   TEXT NOT NULL,
  resolved_by  TEXT,
  resolved_seq INTEGER,
  replies      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS threads_page ON threads(page_id, last_seq);
CREATE INDEX IF NOT EXISTS threads_last ON threads(last_seq);
CREATE INDEX IF NOT EXISTS threads_open ON threads(page_id) WHERE status = 'open';
CREATE TABLE IF NOT EXISTS comments (
  id        TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  actor     TEXT NOT NULL,
  body      TEXT NOT NULL,
  ts        TEXT NOT NULL,
  seq       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_thread ON comments(thread_id, seq);
-- Historical snapshots look for each page's last content event; with op in it, this index
-- covers that query, so it never reads event rows.
CREATE INDEX IF NOT EXISTS events_content ON events(page_id, seq, op) WHERE op != 'comment';
${LEDGER_COUNTS}`;

/** Lint codes no longer reported (tempra-dev: decisions/pages-not-okf), dropped from stored lint. */
export const RETIRED_LINT = new Set([
  "missing_type",
  "generic_type",
  "missing_status",
  "footnote_uncited",
  "relative_link",
]);

/** Tables whose `concept_id` column is `page_id` from version 2. */
const RENAMED = [
  "events",
  "paths",
  "verifications",
  "tags",
  "redirects",
  "sources",
  "fts_rows",
  "access_log",
  "last_read",
  "flags",
  "threads",
];

/** Indexes named for concepts in version 1, and what replaces each. */
const RENAMED_INDEXES: [string, string][] = [
  ["events_concept", "CREATE INDEX IF NOT EXISTS events_page ON events(page_id, seq)"],
  [
    "verifications_concept",
    "CREATE INDEX IF NOT EXISTS verifications_page ON verifications(page_id, seq)",
  ],
  ["sources_concept", "CREATE INDEX IF NOT EXISTS sources_page ON sources(page_id)"],
  ["threads_concept", "CREATE INDEX IF NOT EXISTS threads_page ON threads(page_id, last_seq)"],
];

/**
 * Version 1 to 2, in the caller's transaction: `concept_id` columns become `page_id`, the
 * `concepts` table becomes `pages` without `type` (a page's `type`, where it has one, stays in
 * its frontmatter, in the record its markdown is rendered from), paths of kind `concept` become
 * `page`, the search index is rebuilt under the new column, and lint the server no longer reports is dropped. Structure flags
 * are rebuilt by the store when it opens (the `structure` marker is cleared). Tables a later
 * upgrade adds (`fts_rows`, `last_read`, a column such as `stale_ms`) may be missing in an old
 * library; those upgrades run after this one, with the new names.
 */
function upgradeToPages(sql: SqlHandle): void {
  const tables = new Set(
    sql
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((r) => r.name),
  );
  const columns = (table: string) =>
    new Set(sql.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name));

  for (const table of RENAMED) {
    if (tables.has(table) && columns(table).has("concept_id")) {
      sql.run(`ALTER TABLE ${table} RENAME COLUMN concept_id TO page_id`);
    }
  }
  for (const [old, create] of RENAMED_INDEXES) {
    sql.run(`DROP INDEX IF EXISTS ${old}`);
    sql.run(create);
  }

  // concepts to pages, rebuilt rather than altered: its CREATE TABLE text holds a comment, which
  // broke DROP COLUMN on the SQLite that bun 1.3 ships (see blobs above).
  if (tables.has("concepts")) {
    const had = columns("concepts");
    const keep = [
      "title",
      "description",
      "resource",
      "status",
      "stale_after",
      "stale_ms",
      "generated_by",
      "generated_at",
      "extra",
      "lint",
    ];
    sql.run("DROP INDEX IF EXISTS concepts_stale");
    sql.script(`CREATE TABLE pages (
  page_id      TEXT PRIMARY KEY,
  title        TEXT,
  description  TEXT,
  resource     TEXT,
  status       TEXT NOT NULL,
  stale_after  TEXT,
  stale_ms     INTEGER,
  generated_by TEXT,
  generated_at TEXT,
  extra        TEXT,
  lint         TEXT
);`);
    const cols = keep.filter((c) => had.has(c));
    sql.run(
      `INSERT INTO pages (page_id, ${cols.join(", ")}) SELECT concept_id, ${cols.join(", ")} FROM concepts`,
    );
    sql.run("DROP TABLE concepts");
    sql.run("CREATE INDEX IF NOT EXISTS pages_stale ON pages(stale_ms) WHERE stale_ms IS NOT NULL");
  }

  sql.run("UPDATE paths SET kind = 'page' WHERE kind = 'concept'");

  // FTS5 cannot rename a column: the rows move to a new table that takes the old one's place.
  if (tables.has("fts")) {
    sql.script(
      "CREATE VIRTUAL TABLE fts_pages USING fts5(page_id UNINDEXED, title, body, tags, tokenize = 'porter unicode61');",
    );
    sql.run(
      "INSERT INTO fts_pages (page_id, title, body, tags) SELECT concept_id, title, body, tags FROM fts",
    );
    sql.script("DROP TABLE fts; ALTER TABLE fts_pages RENAME TO fts;");
    if (tables.has("fts_rows")) {
      sql.run("DELETE FROM fts_rows");
      sql.run("INSERT INTO fts_rows (page_id, fts_rowid) SELECT page_id, rowid FROM fts");
    }
  }

  // Lint the server no longer reports: from each page's stored lint and from its `lint` flag.
  const keepLint = (json: string | null) =>
    (JSON.parse(json ?? "[]") as { code: string }[]).filter((l) => !RETIRED_LINT.has(l.code));
  for (const r of sql.all<{ page_id: string; lint: string | null }>(
    "SELECT page_id, lint FROM pages WHERE lint IS NOT NULL",
  )) {
    sql.run(
      "UPDATE pages SET lint = ? WHERE page_id = ?",
      JSON.stringify(keepLint(r.lint)),
      r.page_id,
    );
  }
  for (const f of sql.all<{ page_id: string; detail: string | null }>(
    "SELECT page_id, detail FROM flags WHERE kind = 'lint'",
  )) {
    const kept = keepLint(f.detail);
    if (kept.length === 0) {
      sql.run("DELETE FROM flags WHERE page_id = ? AND kind = 'lint'", f.page_id);
    } else {
      sql.run(
        "UPDATE flags SET detail = ? WHERE page_id = ? AND kind = 'lint'",
        JSON.stringify(kept),
        f.page_id,
      );
    }
  }
  // Structure flags are checked again when the store opens, by the checks as they are now.
  sql.run("DELETE FROM meta WHERE key IN ('structure', 'maint:structure_counts')");
}

/**
 * Creates the schema in a new library; a no-op when it is current. A version 1 library is brought
 * forward once (`upgradeToPages`), all in one transaction. A library stored in any other version
 * is refused: there is no migration across the TEMPRA-22 restart.
 */
export function migrate(sql: SqlHandle): void {
  sql.script("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  const row = sql.all<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")[0];
  if (row && Number(row.value) === SCHEMA_VERSION) return;
  if (row && Number(row.value) === 1) {
    sql.transaction(() => {
      upgradeToPages(sql);
      sql.run("UPDATE meta SET value = ? WHERE key = 'schema_version'", String(SCHEMA_VERSION));
    });
    return;
  }
  if (row) {
    throw new Error(
      `Library schema version ${row.value} is not ${SCHEMA_VERSION}; it predates the TEMPRA-22 restart and must be deleted.`,
    );
  }
  sql.transaction(() => {
    sql.script(SCHEMA);
    sql.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", String(SCHEMA_VERSION));
  });
}
