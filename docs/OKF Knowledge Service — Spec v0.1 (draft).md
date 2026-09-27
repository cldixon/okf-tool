# OKF Knowledge Service — Spec v0.1 (draft)

Sep 27, 2026 · @CL Dixon

## Overview

This is a hosted, agent-first store for Open Knowledge Format (OKF) bundles, built on Cloudflare, that any agent can read and write over MCP or a CLI and any human can read on the web or in Obsidian. The one-line pitch: a knowledge base that agents maintain and humans trust, with every change attributed, revertible and live.

OKF is Google Cloud's open format for knowledge: a directory of markdown files with YAML frontmatter, plus conventions for provenance (`sources`), trust (`generated`, `verified`), lifecycle (`status`, `stale_after`) and attested computations. Its authors left storage and serving out of scope and assume files on disk coordinated through git. This service is the missing serving layer: the bundle stays the interchange contract, the database is where the features live.

What it does that a git repo does not:

- Accepts writes from agents with no disk (web chat, hosted agents) and from any model or tool, over one API.
- Stamps provenance at write time from an authenticated actor, so `generated.by` and trust tiers are real rather than self-asserted.
- Keeps a per-library ledger (the WAL) of every change, grouped by request, so history, blame, rollback, snapshots and a live change feed are queries rather than features.
- Derives `index.md`, `log.md`, backlinks, frontmatter queries and full-text search on the server, so no client rebuilds them and nobody commits generated files.
- Turns stale concepts, broken links and human requests into a work queue that agents pull from.

What it is not: a general-purpose filesystem, a data catalog that stores datasets, a code host, or a WYSIWYG editor. Datasets and systems are described by concepts and referenced by `resource` URIs; they are not stored here. Code lives in git.

First user: the author, self-deployed to a personal Cloudflare account, with a small team and several agents (Claude Code, web chat, scheduled tasks) reading and writing one or more libraries. Everything in v1 is designed for that user; the hosted multi-tenant version is a later phase built on the same code.

Working name in this doc: **the service**. Product name still to be chosen (candidates: Quire, Cairn, Commonplace, Ledger). The revision-history feature is called **the ledger** regardless of product name.

## Scope

v1 is the smallest thing the author can use daily from Claude Code and web chat, with the ledger and OKF conformance complete, and nothing else. The deferred list is a commitment, not a backlog: items on it are not designed for in v1 beyond the one hook noted.

**In v1**

- Self-deploy to one Cloudflare account via a Deploy button; one tenant, many libraries.
- Library = one OKF bundle in a per-library Durable Object with SQLite; attachments in R2; accounts and library index in D1.
- Full write path: conditional writes (ETags), synchronous frontmatter, link, source and FTS indexing, lint warnings returned to the writer, actor stamping.
- The ledger: append-only events, request grouping, snapshot at any sequence, rollback by reverting events, change feed (poll and WebSocket).
- Derived files: `index.md` and `log.md` synthesized on read and at export; never stored.
- Async maintainers: staleness sweep, broken-link work queue, nightly export to R2.
- OKF import (directory upload, tarball, git URL) and export (conformant bundle), including v0.1 migration.
- HTTP API with bearer tokens; Cloudflare Access in front of the human UI.
- MCP server (Streamable HTTP, bearer auth) as the only agent interface: Claude Code, claude.ai and any MCP client connect to it. A Skill doc teaches the workflow to agents that load skills.
- Minimal built-in web UI: library list, concept render with trust and staleness badges, ledger view, verify button, import/export, token management.

**Deferred (v2 and later), with the v1 hook that keeps each cheap**

| Item | Phase | v1 hook |
| --- | --- | --- |
| CLI (Go or Rust, thin HTTP client) with local `sync` for disk-based agents and offline use | v2 | The `/batch` route and `/events?since=` cursor are the sync protocol; nothing else needed |
| Astro package, loader and Tempra-derived site | v2 | Public read API and change feed are stable; `?at=seq` on every read |
| Obsidian plugin (local mirror sync, history pane, blame gutter) | v2 | Same sync protocol as the CLI |
| Human requests as `type: Request` concepts and a threaded comment store | v2 | Work queue endpoint exists; comments table left out of schema |
| Git mirror (events out as commits, merged PRs in as events) | v2 | Request ID = commit, actor = author |
| Presigned direct-to-R2 uploads | v2 | Blobs are content-addressed at `blobs/<sha256>` from day one |
| MCP OAuth for claude.ai connectors | v2 | Token model is the identity; OAuth issues tokens |
| Hosted multi-tenant SaaS, public libraries, forking | v3 | Content tables are scoped to one library; no cross-library joins |
| Attested Computation execution and receipts | v3 | Contracts are indexed by `type`; receipts are ledger events when added |
| Vector search, media handlers, MDX-style components | later | none |

## Concepts and terminology

| Term | Meaning |
| --- | --- |
| Library | One OKF bundle: a named tree of concepts and attachments with its own ledger. One Durable Object per library. The unit of sharing, export and tokens. |
| Concept | One markdown file with YAML frontmatter, per OKF §4. Identified by its path (concept ID) and by a stable internal ID that survives renames. |
| Attachment | Any non-markdown file in the library (image, PDF, executor or attester code under `references/`). A path whose bytes live in R2. |
| Blob | Immutable content addressed by SHA-256. Markdown blobs are stored inline in SQLite; attachment blobs in R2. |
| Path | A slash-separated location in the library, no leading slash in storage; rendered with a leading slash in OKF links. Directories are prefixes, not objects. |
| Ledger | The append-only event log for a library: who changed which path from which blob to which blob, when, in which request. The source of truth; everything else is derived. |
| Event | One row in the ledger: `seq`, `ts`, `actor`, `request_id`, `op`, `path`, `prev_hash`, `hash`. |
| Request | A group of events from one API call or one CLI `sync`, sharing a `request_id`. The commit-like unit for history, diff and rollback. |
| Snapshot | The path-to-hash map of a library as of a sequence number. Computed, never stored. |
| Actor | The OKF §7 identity stamped on writes: `human:<id>`, `process:<id>`, or `<producer>/<version>` for agents. Derived from the token, never supplied by the writer. |
| Token | A bearer credential bound to one actor and one library, with `read` or `write` scope and optional prefix restriction and expiry. |
| Maintainer | A server-side consumer of the ledger with its own cursor that keeps derived state current (staleness flags, usage counts, exports). |
| Work queue | A derived list of things an agent should do in a library: stale concepts, broken links, oversized files, and later human requests. |
| Derived file | `index.md` and `log.md`: rendered from the index and ledger on read and at export. Never authored, never stored. |

## OKF conformance

The service targets OKF v0.2 and must round-trip: any conformant bundle imports without loss, and any export is a conformant bundle that Google's validator, visualizer, okf-core and an Obsidian vault accept unchanged. The bundle is the interchange contract; nothing the service adds may be required to read an export.

**What the service stamps.** On every write of a concept it sets `generated: { by, at }` from the token's actor and the server clock, overwriting whatever the writer supplied. `verified` entries with a `human:` actor can only be added by the verify action of an authenticated human; a write that includes a `human:` verifier from a non-human token has that entry stripped and a lint warning returned. Non-human `verified` entries (a `process:` re-check) may be written by a `process:` token.

**What the service derives.** Trust tier (§5.3), staleness (`now >= stale_after`), effective status (absent = `stable`), the link graph in both directions, footnote-to-source resolution, and `usage_count` for internal sources from its own access log over a configurable `usage_window`. Derived values are exposed through the API and UI and are never written back into frontmatter except `usage_count`, which is optional and off by default.

**What the service synthesizes.** `index.md` at every directory level and `log.md` at the root, per §8 and §9, rendered on request and materialized at export and in the git mirror. The root `index.md` carries `okf_version: "0.2"`. On import, incoming `index.md` and `log.md` are discarded; the tree is authoritative. An imported `log.md` may be replayed into the ledger as historical events attributed to `process:import` when the dates parse, so history is not lost.

**Lint on write (warn, never reject, per §11).** Missing or empty `type`; unparseable frontmatter; timestamps without an explicit offset; actors not matching §7; a `sources` entry without `resource`; footnote labels with no matching `sources[].id`; links to paths that do not exist (reported, and added to the work queue); `status` outside `draft | stable | deprecated`; a bare `verified` mapping (accepted and normalized to a list); v0.1 fields `timestamp` and a `# Citations` body list (accepted, migrated per §13). The one hard rejection is size: a concept over the configured cap (default 100 KB) is refused with a message instructing the writer to split it into linked concepts.

**Reserved and conventional.** `index.md` and `log.md` cannot be written by clients. `references/` is a plain directory with no special handling in v1. `type` values are free strings; the UI groups by them. The `# Schema`, `# Examples` and `# Computation` headings are recognized for rendering only.

**Extensions.** The service adds no frontmatter keys. Internal facts (stable ID, ledger sequence, request ID) live in the database and the API, not in files. If a feature needs a field the spec lacks, that is a proposal to the spec, recorded in Open questions, not a private key.

## Backend architecture

A single Worker is the only internet-facing component; every library is its own Durable Object with its own SQLite; D1 holds the account layer; R2 holds attachment bytes and exports.

&#91;embedded content: backend architecture · 3 clients, 1 Worker, 3 stores\]

Every client talks to the Worker over HTTPS. The Worker authenticates, resolves the library, and forwards to that library's Durable Object, which owns all content, indexes and the ledger; D1 is touched only for accounts, library listing and token lookup; R2 only for attachments and exports.

**Why these pieces.** The Durable Object gives a single writer per library (exact ledger sequence numbers with no coordination), in-process SQLite (graph and frontmatter queries in milliseconds, no per-query network hop), synchronous indexing in the same transaction as the write, WebSockets with hibernation for the change feed, alarms for scheduled maintainers, and built-in point-in-time recovery of the object's storage. D1 stays for what needs a console and cross-library queries: who exists, which libraries they own, which tokens are valid. R2 stays for bytes that do not belong in SQLite and for durable, independently readable exports.

**Request flow for a write.** Worker: validate token, load actor and scope from D1 (cached), check path against prefix scope, forward to DO. DO, in one transaction: check `If-Match` against the path's current hash; store the blob (inline for markdown, R2 put for attachments, keyed by SHA-256); run okf-core to parse frontmatter, extract links and footnotes, and lint; update `paths`, `concepts`, `links`, `sources`, `fts`; append the event with the request ID and stamped actor; broadcast to WebSocket subscribers. Return the new hash, sequence number and lint warnings.

**Request flow for a read.** Worker validates and forwards; DO answers from SQLite. `?at=<seq>` reads resolve the path's hash as of that sequence from the ledger and return that blob. Attachment reads stream from R2 through the Worker in v1 (presigned GETs deferred).

**Language split.** The Worker and Durable Object are TypeScript (Hono for routing, the official MCP SDK, Cloudflare's OAuth provider library later). All OKF semantics run on the server in TypeScript inside the DO: frontmatter parsing, link and footnote extraction, trust-tier derivation, lint, and rendering of `index.md` and `log.md`. The parse is sub-millisecond, so there is no performance case for another language. The CLI is Rust and contains no OKF logic: it is an HTTP client that moves bytes and hashes local files for `sync`. Rust code cannot run natively on Workers (only JavaScript and WebAssembly do), so Rust on the server is out of scope; if an offline `lint` command is wanted in the CLI later, the community `okf-core` crate can provide it there, with a shared fixture suite keeping it and the server's parser in agreement. The storage logic is written against a plain SQLite handle so it runs unchanged in the DO, in tests, and in any future off-Cloudflare host.

**Limits that shape the design.** One DO's SQLite is capped in the tens of gigabytes; a library of markdown is megabytes, so this is not a constraint, but a library is the unit of scale and a single library is never sharded. DO wall-clock duration is billed while active, so the WebSocket implementation must use the hibernation API from the start. R2 object keys are immutable content hashes; paths never appear in R2.

## Data model

The library DO's SQLite holds two kinds of tables: source-of-truth (`blobs`, `events`) and derived (everything else), where every derived table can be rebuilt by replaying `events` against `blobs`.

**Library DO schema (per library)**

```sql
-- source of truth
CREATE TABLE blobs (
  hash      TEXT PRIMARY KEY,      -- sha256 hex of raw bytes
  size      INTEGER NOT NULL,
  location  TEXT NOT NULL,         -- 'inline' | 'r2'
  content   BLOB,                  -- present when location = 'inline'
  media     TEXT                   -- mime type, from extension + sniff
);

CREATE TABLE events (
  seq         INTEGER PRIMARY KEY, -- per-library, monotonic, assigned by the DO
  ts          TEXT NOT NULL,       -- ISO 8601 UTC, server clock
  actor       TEXT NOT NULL,       -- OKF §7 actor string, from the token
  request_id  TEXT NOT NULL,       -- groups events from one API call / sync
  op          TEXT NOT NULL,       -- 'put' | 'delete' | 'move' | 'import' | 'revert'
  path        TEXT NOT NULL,
  prev_hash   TEXT,                -- NULL on create
  hash        TEXT,                -- NULL on delete
  concept_id  TEXT NOT NULL,       -- stable id, survives moves
  meta        TEXT                 -- JSON: from_path on move, reverted_seq on revert, note
);
CREATE INDEX events_path ON events(path, seq);
CREATE INDEX events_request ON events(request_id);
CREATE INDEX events_concept ON events(concept_id, seq);

-- derived: current state
CREATE TABLE paths (
  path        TEXT PRIMARY KEY,
  concept_id  TEXT NOT NULL UNIQUE,
  hash        TEXT NOT NULL REFERENCES blobs(hash),
  kind        TEXT NOT NULL,       -- 'concept' | 'attachment'
  last_seq    INTEGER NOT NULL,
  created_seq INTEGER NOT NULL
);

CREATE TABLE concepts (             -- one row per markdown path, parsed frontmatter
  path         TEXT PRIMARY KEY REFERENCES paths(path) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  title        TEXT,
  description  TEXT,
  resource     TEXT,
  status       TEXT NOT NULL,      -- effective: absent -> 'stable'
  stale_after  TEXT,
  generated_by TEXT,
  generated_at TEXT,
  trust_tier   TEXT NOT NULL,      -- 'unverified' | 'machine' | 'human'
  verified_at  TEXT,               -- latest verified[].at
  frontmatter  TEXT NOT NULL,      -- full YAML as JSON, incl. unknown keys
  lint         TEXT                -- JSON array of warnings from last write
);
CREATE TABLE tags (path TEXT, tag TEXT, PRIMARY KEY (path, tag));
CREATE TABLE links (
  from_path  TEXT NOT NULL,
  to_path    TEXT NOT NULL,        -- normalized bundle-relative, no leading slash
  raw        TEXT NOT NULL,        -- link text as written
  resolved   INTEGER NOT NULL,     -- 1 if to_path exists at write time
  PRIMARY KEY (from_path, to_path, raw)
);
CREATE INDEX links_to ON links(to_path);
CREATE TABLE sources (
  path        TEXT NOT NULL,
  id          TEXT,                -- sources[].id, may be NULL
  resource    TEXT NOT NULL,
  internal_to TEXT,                -- to_path when resource is bundle-relative
  signals     TEXT,                -- JSON: author, usage_count, last_modified, window
  cited       INTEGER NOT NULL     -- count of footnotes referencing id
);
CREATE VIRTUAL TABLE fts USING fts5(path UNINDEXED, title, body, tags);

-- derived: maintainers and telemetry
CREATE TABLE cursors (maintainer TEXT PRIMARY KEY, seq INTEGER NOT NULL);
CREATE TABLE access_log (ts TEXT, path TEXT, actor TEXT, kind TEXT); -- 'read'; rolled up by a maintainer
CREATE TABLE flags (
  path TEXT, kind TEXT, since_seq INTEGER, detail TEXT,
  PRIMARY KEY (path, kind)         -- 'stale' | 'broken_link' | 'oversized' | 'lint'
);
```

**Rules.** `events` and `blobs` are append-only; nothing updates or deletes a row in either. `paths` is a materialized view of "newest event per path with a non-null hash". A move writes one event with `op='move'`, `meta.from_path`, and the same `concept_id`; links in other bodies pointing at the old path are rewritten by the link maintainer as separate `put` events attributed to `process:link-maintainer`. Attachment blobs have `location='r2'` and no `content`; the R2 key is `blobs/<hash>`. Markdown over the size cap is refused before any row is written.

**D1 schema (account layer, shared)**

```sql
CREATE TABLE users     (id TEXT PRIMARY KEY, email TEXT UNIQUE, actor TEXT NOT NULL, created TEXT);
CREATE TABLE libraries (id TEXT PRIMARY KEY, slug TEXT UNIQUE, owner TEXT REFERENCES users(id),
                        visibility TEXT NOT NULL, created TEXT, do_id TEXT NOT NULL);
CREATE TABLE tokens    (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, library TEXT REFERENCES libraries(id),
                        actor TEXT NOT NULL, scope TEXT NOT NULL, prefix TEXT, expires TEXT,
                        created_by TEXT, last_used TEXT, revoked TEXT);
```

Tokens store only a hash of the secret. `actor` on a token is set at creation and immutable; it is the string stamped into `generated.by`. `visibility` is `private` in v1; `unlisted` and `public` are reserved for the hosted phase.

## The ledger

The ledger is the `events` table: an append-only, per-library log where each row records that an actor moved one path from one content hash to another, in one request, at one sequence number. Every history, blame, diff, snapshot, rollback, feed and maintainer feature is a query over it.

**Event semantics**

| `op` | `prev_hash` | `hash` | Meaning |
| --- | --- | --- | --- |
| `put` | NULL or old | new | Create or replace the content at `path` |
| `delete` | old | NULL | Remove `path`; the blob stays |
| `move` | same | same | `meta.from_path` → `path`; `concept_id` unchanged |
| `import` | NULL | new | A `put` produced by bundle import; `meta.source` names the origin |
| `revert` | current | target | A `put` whose content is the hash at `meta.reverted_seq`; never rewrites history |

`seq` is assigned inside the DO transaction and is gapless per library. `ts` is the server clock. `actor` and `request_id` are set by the Worker, never by the client; a client may supply a `note` that lands in `meta` for the log.

**Requests.** All events from one API call share a `request_id`. A CLI `sync` that pushes many files makes one call with a multipart body, so it is one request. The ledger UI and `log.md` group by request: one entry, N paths, one actor, one timestamp. Diff of a request = the set of (prev\_hash, hash) pairs it contains.

**Snapshots.** The state at sequence N is, for every path, the newest event with `seq <= N` whose `hash` is non-null and not superseded by a later delete or move within N. Implemented as a query with a window over `events`; cached per (library, N) in the DO since it is immutable. Every read endpoint accepts `?at=N`; every listing and query endpoint accepts it too, by rebuilding the frontmatter index for N on demand (acceptable for v1; a materialized snapshot table is a later optimization).

**Rollback.** Two forms, both forward-only. Revert one path: a `revert` event pointing the path at its hash as of a chosen `seq`. Revert a request: one `revert` event per path the request touched, sharing a new `request_id`, attributed to the actor who asked. Nothing is ever removed from the log; the mistake and its correction are both visible and both attributed.

**Change feed.** `GET /events?since=N` returns events with `seq > N`, paginated; the same stream is pushed over a WebSocket held with the hibernation API. A client's sync cursor is the last `seq` it applied. Feeds may be filtered by path prefix.

**Derived state and replay.** Every table except `events` and `blobs` is a projection of the ledger. A maintainer is a projection with a cursor in `cursors`; a rebuild sets the cursor to zero and replays. The write path's synchronous indexing is the same code run at cursor = head. This is the recovery story for bugs in indexing code and the migration story for schema changes to derived tables: drop, replay.

**Blame.** For a path, the events for its `concept_id` in order; for a line, the diff between adjacent blobs. Computed on demand by the API (`GET /blame/<path>`), not stored.

**Time travel in the UI.** A sequence picker on any concept page, a "since last human verification" diff, and the ledger page itself: reverse-chronological requests with actor, paths and note, filterable by prefix, actor and date.

**Git mirror (v2).** The mirror keeps the service compatible with the workflow OKF's authors assume (a bundle in a repo, pull requests, tools that read files) without making the repo a second source of truth. The ledger is authoritative; the repo is a projection of it.

- Outbound: a maintainer with a cursor turns each request into one commit. The request `note` is the message; the actor is the author (a `human:` actor maps to the user's name and email, an agent actor to `<producer>/<version> <bot@service>`); the tree is the snapshot at that sequence with `index.md` and `log.md` materialized. Commits are created through the GitHub API (trees, commits, refs), since Workers have no git binary. A clone of the mirror is a conformant bundle with full history, identical to an export.
- Inbound: a pull request merged on GitHub fires a webhook. The service reads the merge diff and applies it as one request through the normal write path, attributed to the merging user, with `If-Match` on each file's hash as of the PR's base commit. A file changed in the service since the PR branched is skipped and flagged in the work queue, never force-applied. Commit history from the repo is not imported as ledger history; only the resulting file changes are.
- Not supported: pushing directly to the mirror's default branch (rejected by branch protection; the mirror overwrites it), and two-way history sync. `index.md` and `log.md` changes in a PR are ignored.
- v1 hook: `request_id`, `actor` and `note` already give the commit its identity; the export code already produces the tree.

## Write path and maintainers

Derived state is kept in three tiers by when it is computed: in the write transaction, on read, or by a ledger consumer running later. The rule for placing a task: if the writer's next read must see it, it is synchronous; if it is a rendering of existing data, it is on-read; otherwise it is a maintainer.

**Tier 1: synchronous, in the write transaction**

1. Reject if size > cap (markdown) or path is reserved (`index.md`, `log.md`).
2. Check `If-Match` against `paths.hash`; mismatch returns 412 with the current hash.
3. Hash the raw bytes; insert into `blobs` if new (inline or R2).
4. For markdown: okf-core parses frontmatter, body headings, links and footnotes. Stamp `generated`, strip disallowed `verified` entries, normalize a bare `verified` mapping, apply v0.1 migrations. The stamped bytes are what is stored and hashed, so the writer's copy and the server's differ only in fields the server owns.
5. Upsert `concepts`, `tags`, `links`, `sources`; replace the `fts` row.
6. Mark `links.resolved` for links into this path from elsewhere (a new path may fix earlier broken links) and clear their `broken_link` flags.
7. Append the event; update `paths`; broadcast to feed subscribers.
8. Return `{ path, hash, seq, request_id, lint: [...] }`.

A multi-file request (import, sync push) runs steps 1 to 7 per file inside one transaction and one `request_id`; any hard rejection fails the whole request.

**Tier 2: derived on read, never stored**

- `index.md` for any directory: one section per subdirectory and one for concepts, each entry `* [title](relative) - description`, from `concepts` and `paths`. Root index carries `okf_version: "0.2"`.
- `log.md`: requests newest first, grouped by day, one bullet per request with actor, note and paths, from `events`.
- Trust tier, staleness and effective status are columns already computed at write; "stale now" is `stale_after <= now` evaluated at read.
- Backlinks: `SELECT from_path FROM links WHERE to_path = ?`.
- Blame, diffs, snapshots: from `events` and `blobs`.

All of these are cached in the DO keyed by head `seq` and invalidated by any write.

**Tier 3: maintainers (ledger consumers with cursors)**

| Maintainer | Trigger | What it does | Writes |
| --- | --- | --- | --- |
| link-maintainer | after any `move` or `delete` event | Rewrites links in other bodies that pointed at the old path; flags links now broken | `put` events as `process:link-maintainer` |
| staleness | DO alarm, hourly | Flags concepts with `stale_after <= now`; clears flags when re-verified or regenerated | `flags` rows only |
| usage-rollup | DO alarm, daily | Aggregates `access_log` into per-path read counts over the window; exposes them for internal `sources` | `sources.signals` (in-memory view; frontmatter write-back is opt-in) |
| export | DO alarm, nightly | Materializes the bundle (with synthesized files) and a SQLite dump to R2 under `exports/<library>/<date>/` | R2 objects |
| work-queue | on read | Not a consumer; a query that unions `flags` (stale, broken\_link, oversized, lint) ranked by age and inbound link count | nothing |

Maintainers are idempotent and replayable from cursor zero. The link-maintainer is the only one that writes events, and it is the only actor other than tokens that can; its events carry the triggering `request_id` in `meta` so the UI can show "this rename caused these 12 link updates".

**The agent work queue.** `GET /work` returns the current flags for a library as tasks an agent can act on: `{ kind, path, since, detail, suggested_action }`. The server never runs an LLM; it produces the list, and any agent (a scheduled Claude Code task, a teammate's session) pulls from it over MCP and writes back through the normal path. In v1 the kinds are `stale`, `broken_link`, `oversized` and `lint`; `request` (human-filed) is added in v2. Picking a task is not exclusive in v1; a claim mechanism is a later addition.

## HTTP API

One JSON-and-bytes API under `/api/v1/libraries/{lib}/`, path-addressed, with ETags for concurrency; the CLI, the MCP server and the web UI are all clients of it. All routes take `Authorization: Bearer <token>` or a Cloudflare Access identity. Paths in URLs are the OKF path without leading slash, URL-encoded.

**Files**

| Method and route | Purpose | Notes |
| --- | --- | --- |
| `GET /files/{path}` | Raw bytes of a concept or attachment | Returns `ETag: <hash>`, `X-Seq`. `Accept: application/json` returns `{ path, hash, seq, frontmatter, body, lint }` for concepts. `?at=N` for snapshots. |
| `PUT /files/{path}` | Create or replace | Body = raw bytes. `If-Match: <hash>` required for replace, `If-None-Match: *` for create. Header `X-Note` optional. 412 on mismatch with current hash in body. Returns `{ path, hash, seq, request_id, lint }`. |
| `DELETE /files/{path}` | Delete | `If-Match` required. |
| `POST /files/{path}/move` | Rename or move | Body `{ to }`. Triggers link-maintainer. |
| `GET /tree?prefix=&depth=` | List paths | Returns entries with `kind`, `hash`, `seq`, and for concepts `type`, `title`, `description`, `status`, `trust_tier`, `stale`. |
| `POST /batch` | Many writes in one request | Multipart: each part a `PUT`/`DELETE` with its own path and `If-Match`. One `request_id`, all-or-nothing. Used by `sync` and import. |

**Derived files**

| Route | Purpose |
| --- | --- |
| `GET /files/{dir}/index.md` | Synthesized listing for that directory |
| `GET /files/log.md` | Synthesized log; `?prefix=` scopes it |

Both are read-only; `PUT` to them returns 405.

**Queries**

| Route | Purpose |
| --- | --- |
| `GET /concepts?type=&tag=&status=&trust=&stale=true&prefix=` | Frontmatter query; any combination; paginated |
| `GET /search?q=` | FTS over title, body, tags; returns paths with snippets |
| `GET /links/{path}` | `{ outbound: [...], inbound: [...], broken: [...] }` |
| `GET /sources/{path}` | Sources with resolved footnote counts and internal signals |
| `GET /graph?prefix=` | Nodes and edges for a visualizer, same shape Google's viz consumes |

**Ledger**

| Route | Purpose |
| --- | --- |
| `GET /events?since=&prefix=&actor=&limit=` | Change feed, ascending by `seq` |
| `GET /requests?before=&prefix=&limit=` | Requests newest first, each with its events |
| `GET /requests/{id}` | One request with per-path diffs |
| `GET /history/{path}` | Events for the path's `concept_id`, with blob hashes |
| `GET /blame/{path}` | Per-line attribution against the current blob |
| `GET /diff?path=&from=&to=` | Unified diff between two sequences |
| `POST /revert` | `{ path, to_seq }` or `{ request_id }`; returns the new request |
| `WS /feed?since=` | Same events as `GET /events`, pushed |

**Trust and work**

| Route | Purpose |
| --- | --- |
| `POST /verify/{path}` | Human-only. Appends `{ by: human:<id>, at: now }` to `verified`; one `put` event |
| `GET /work?kind=&limit=` | The work queue |

**Attachments** use the same `/files/{path}` routes; the Worker streams bytes to and from R2. A `HEAD` returns size and media type without the body.

**Import and export**

| Route | Purpose |
| --- | --- |
| `POST /import` | Multipart or `{ git_url }` or `{ r2_key }`; runs as one request; returns `{ request_id, files, warnings }` |
| `GET /export?at=N&format=tar\|zip` | Conformant bundle with synthesized files; default head |
| `GET /dump` | SQLite dump of the library for inspection or off-platform restore |

**Library and token management** live under `/api/v1/libraries` and `/api/v1/tokens` (create, list, revoke), human-only.

**Conventions.** Errors are `{ error, code, detail }` with standard status codes; `412` carries `current_hash`. All timestamps are ISO 8601 UTC. Responses to writes always include `lint` so agents can self-correct. Rate limits per token are configurable and default generous for a self-deploy.

## Agent interfaces

MCP is the only agent interface in v1: Claude Code, claude.ai and any other MCP client connect to the same server, and a Skill doc teaches the workflow to agents that load skills. A CLI with local sync is deferred to v2; its protocol (`/batch` plus the `/events` cursor) already exists in the API.

**MCP server.** Served by the Worker at `/mcp` over Streamable HTTP. Auth in v1 is a bearer token in the `Authorization` header, which Claude Code supports directly (`claude mcp add --transport http <url> --header ...`) and which other clients accept as a custom header; OAuth for claude.ai's connector flow is v2. One server exposes all libraries the token can reach; tools take a `library` argument, defaulting to the token's library when it has only one.

| Tool | Maps to | Notes |
| --- | --- | --- |
| `start(library?)` | root `index.md` + library summary | The entry point: returns the synthesized root index, counts by type, open work count, and three lines of guidance. Tool description tells agents to call it first |
| `list(prefix?, depth?, at?)` | `GET /tree` |  |
| `index(dir?)` | synthesized `index.md` | Progressive disclosure one level at a time |
| `read(path, at?)` | `GET /files` (JSON) | Returns frontmatter, body, hash, seq, trust tier, stale flag, lint, inbound link count |
| `write(path, content, if_match?, note?)` | `PUT /files` | Returns hash, seq, request\_id, lint. Description states that `generated` is stamped and `verified` is not the agent's to set |
| `write_many(files[], note?)` | `POST /batch` | One request\_id; all-or-nothing |
| `delete(path, if_match)` / `move(from, to)` | as named |  |
| `query(type?, tag?, status?, stale?, trust?, prefix?)` | `GET /concepts` |  |
| `search(q, prefix?)` | `GET /search` |  |
| `links(path)` / `sources(path)` | as named |  |
| `log(prefix?, since?, limit?)` | `GET /requests` | What other agents and humans did |
| `history(path)` / `diff(path, from, to)` | as named |  |
| `revert(path?, to_seq?, request_id?)` | `POST /revert` |  |
| `work(kind?, limit?)` | `GET /work` | The maintenance queue |
| `export(at?)` | `GET /export` | Returns a short-lived download URL |

Concepts are also exposed as MCP resources (`okf://<library>/<path>`) so clients that support resources can attach one to context directly; the resource list is the tree, paginated. Tool descriptions carry the workflow guidance in compressed form because most MCP clients never load a skill: call `start` first, read `index.md` before opening documents, check trust and staleness before relying on a body, read `lint` after every write and fix warnings, keep concepts under the size cap, and use `work` to find what needs doing.

**Skill doc.** A `SKILL.md` for Claude Code and other skill-loading agents, published in the repo and installable from it. It teaches: what OKF is in ten lines; the progressive-disclosure loop (`start`, `index`, follow links, `read`, look at frontmatter before the body); how to write a conformant concept (required `type`, recommended fields, bundle-relative links, footnotes keyed to `sources[].id`, one concept per idea); the trust rules (`generated` is stamped, `verified` is human-only, `status` and `stale_after` are the agent's to set honestly); conflict handling (pass `if_match`, on a 412 re-read and reapply); how to use `log` to see what others did and `work` to pick up maintenance; and when to split a concept.

**Multi-agent etiquette (in both).** Read before write and pass `if_match`. Put a one-line `note` on every write so the ledger reads well to humans. Prefer `write_many` for related changes so they land as one request. Never write `index.md` or `log.md`. Do not claim verification.

**CLI (v2 outline, language undecided between Go and Rust).** A thin HTTP client with no OKF logic: `login`, `ls`, `get`, `put`, `rm`, `mv`, `query`, `search`, `log`, `history`, `diff`, `revert`, `work`, `export`, `import`, and `sync <dir>`. Sync keeps state in `.okf/` (library, prefix, last applied `seq`, per-path hashes); pull applies `/events?since=` to disk, push sends changed files as one `/batch` with `If-Match` per file, and a 412 writes the server version beside the local file as `path.remote.md` and reports the conflict rather than merging. Synthesized files are written read-only on pull and never pushed. The Obsidian plugin reuses this protocol.

## Human interfaces

v1 ships a minimal built-in web UI served by the Worker; the Astro package and the Obsidian plugin are v2 and are outlined here only to fix the API contracts they need.

**Built-in UI (v1).** Server-rendered pages behind Cloudflare Access, plain HTML with a small amount of client script, no framework. Pages: library list; directory view (the synthesized `index.md`, rendered); concept view with the body rendered, frontmatter in a side panel, trust and staleness badges, sources with signals, footnotes resolved, inbound links, a history list and a sequence picker; a diff view between two sequences; the ledger page (requests newest first, filter by prefix, actor, date); the work queue; a verify button on concept pages; token management (create with actor, scope, prefix, expiry; revoke); import and export; and a raw-source view. No editor in v1: humans edit through the CLI, Obsidian, or by asking an agent. The UI exists so the author can see what agents did and trust or revert it.

**Astro package (v2 outline).** A package `@<name>/astro` providing a content-layer loader (build-time, pulls a library or prefix into the content store, with a deploy hook fired by the change feed) and a request-time client with route caching keyed by path tags, revalidated by ledger events (the Tempra pattern). Components: `<Concept>`, `<TrustBadge>`, `<Sources>`, `<Backlinks>`, `<History>`, `<Index>`. Starter templates: docs site, reading site, catalog viewer. Every page accepts `?at=N` and passes it through; historical renders are cached indefinitely. Templates degrade when optional frontmatter is absent. Requires only the public read API and the feed, both fixed in v1.

**Obsidian plugin (v2 outline).** Local mirror kept in sync with the same protocol as `okf sync`; the vault sees ordinary files. Adds a history pane, a blame gutter via a CodeMirror extension, an activity feed, and a verify command. Conflicts: the human's file stays, the agent's version lands in history and is surfaced as a diff. `.obsidian/` is excluded from sync.

## Auth, identity and actors

Identity is the OKF actor string, and it is always derived by the server from the credential; nothing a client sends can change who a write is attributed to.

**Humans.** Cloudflare Access in front of the UI and the human-only API routes. The Worker reads the Access JWT, maps the email to a `users` row (created on first sign-in), and uses that row's `actor`, which is `human:<local-part>` by default and editable once. Access is free for small seat counts and needs no code beyond JWT verification.

**Agents.** Bearer tokens created by a human in the UI or CLI. A token carries: `library`, `actor` (immutable; the operator chooses it at creation, e.g. `claude-code/laptop`, `process:nightly-verify`), `scope` (`read` or `write`), optional `prefix` (writes outside it are 403), optional `expires`. The secret is shown once; only its hash is stored. Tokens whose actor begins with `human:` cannot be created; a human acting through the CLI logs in with a token minted for their own `human:` actor by the UI, and only those tokens may call `verify`.

**What actors govern.** `generated.by` on every write. Which `verified` entries a write may carry (`human:` only via the verify action with a human credential; `process:` only from a token whose actor begins with `process:`). Ledger attribution and the work queue's "who last touched this". Rate limits, per token.

**Not in v1.** OAuth issuance (needed for claude.ai remote connectors), per-user permissions within a library beyond prefix scope, sharing with other humans, public access. The `visibility` column and the token model are designed so these are additive.

**Threats considered.** Token leakage: prefix scope and expiry limit blast radius; revocation is immediate since the Worker checks D1 on each request (with a short cache). Attribution spoofing: impossible by construction. Attachment probing by hash: every blob read goes through a path in a library the token can read; there is no read-by-hash route. Arbitrary HTML in attachments: served with `Content-Disposition: attachment` and a restrictive CSP in v1; inline rendering of HTML attachments is deferred with the media-handler work.

## Deployment

v1 is one Worker deployed to the operator's own Cloudflare account with a Deploy to Cloudflare button; the same Worker, unchanged, is what a later hosted version runs per tenant.

**What the button provisions.** The Worker with its Durable Object namespace (SQLite-backed, declared via a migration in the wrangler config; instances are created on first use, nothing to pre-provision), one D1 database, one R2 bucket, and the secrets the Worker needs (an app secret for signing, an optional Access audience). The operator then enables Cloudflare Access on the Worker's hostname for the UI routes and creates their first token from the UI.

**wrangler config (sketch)**

```toml
name = "okf-service"
main = "src/index.ts"
compatibility_date = "2026-09-01"

[[durable_objects.bindings]]
name = "LIBRARY"
class_name = "Library"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Library"]

[[d1_databases]]
binding = "DB"
database_name = "okf-accounts"

[[r2_buckets]]
binding = "BLOBS"
bucket_name = "okf-blobs"

[triggers]
crons = ["17 3 * * *"]   # account-level sweep: wake every library DO for nightly export
```

**Schema migrations.** D1 migrations via wrangler's migration files. DO SQLite schema is versioned inside the object: a `schema_version` row, migrated forward on first request after a deploy. Derived tables may be dropped and rebuilt by replay; `events` and `blobs` migrations are additive only (new columns with defaults), never destructive.

**Backups and recovery.** Three layers. Durable Object storage is synchronously replicated and offers point-in-time recovery for about 30 days per object, exposed as an admin action in the UI ("restore this library to \<time>"). The nightly export maintainer writes a conformant bundle plus a SQLite dump to R2 under `exports/<library>/<date>/`, with configurable retention. Restore from export is a first-class path: create a library, import the bundle, replay the dump's `events` and `blobs` if present so history is kept. The `export` route (and its button in the UI) gives the operator an off-platform copy on demand; a scheduled git mirror is v2.

**Local development.** `wrangler dev` runs the Worker, the DO with SQLite persisted to disk, D1 and R2 emulated locally. A `just` or `make` target runs the round-trip test: import Google's sample bundles, export, diff against the originals modulo synthesized files.

**Observability.** Workers logs to the Cloudflare dashboard or a log push; a `/healthz` route reporting DO reachability, D1 and R2 checks; per-library stats endpoint (paths, events, size, cursor lag per maintainer) for the UI's library page.

## Implementation plan

Four phases, in dependency order, each ending in a gate the author can check without anyone else's help; v2 work does not start until gate 4 passes.

&#91;embedded content: implementation roadmap · 4 phases, 4 gates\]

Each gate is a single observable test: the core round-trips Google's sample bundles byte-for-byte modulo synthesized files; an agent in Claude Code writes through MCP every day for two weeks; the author can see, verify and revert those writes in the UI; and a fresh Cloudflare account can deploy from the README in under fifteen minutes.

**Phase 1: Core.** Evaluate `okf-core` (docs.rs) for reuse versus a fork; the deciding factors are the YAML subset it parses, WASM build size, and whether its refactoring module is sound. Build the Library DO with the schema above, the write transaction, the ledger, snapshots, and the query endpoints. Worker routing, token auth against D1, and the `/files`, `/tree`, `/concepts`, `/search`, `/links`, `/events`, `/requests`, `/history`, `/revert` routes. Import from a directory and export to a tarball, because the gate needs them. Tests run against `wrangler dev` with the DO persisted locally.

**Phase 2: MCP and Skill.** The MCP server on the Worker with the full tool table, the `start` entry point, resources, and tool descriptions that carry the workflow guidance. The Skill doc. Import via the API so a library can be seeded from a sample bundle when wanted. Gate: two weeks of the author working through it from Claude Code, starting from an empty library, not an import, so the test is whether an agent given only the tools and the Skill doc produces a good bundle from nothing. The first library is this service itself (architecture, decisions, API, open questions), maintained by the agents building it; a second agent (a scheduled task or claude.ai via a bearer-token connector) writes to it at least once. Google's sample bundles are fixtures for Phase 1, not the starting point for use.

**Phase 3: UI.** The built-in pages behind Access: library list, directory and concept views with trust and staleness, history and diff, the ledger page, the work queue, verify, import/export and token management. Gate: the author reviews a week of agent writes in the ledger, verifies one concept, and reverts one request, all from the browser.

**Phase 4: Ship.** Maintainers on alarms, nightly export, PITR restore action, `okf_version` and v0.1 migration on import, the Deploy button and README, healthz and stats. Gate: deploy to a second, empty account from the README and import a Google sample bundle.

**Language and repo layout**

```
/worker                 TypeScript: Worker + Library DO + MCP + UI
/worker/src/okf         OKF semantics: parse, links, footnotes, trust, lint, index/log render
/worker/src/store       Storage logic against a SQLite handle (runs in DO and in tests)
/worker/src/mcp         MCP server: tools, resources, descriptions
/skills/okf/SKILL.md    The agent skill doc
/fixtures               Google's sample bundles + expected parse results, vendored for tests
/docs                   Operator docs, Deploy button README
/cli                    (v2) Go or Rust thin client with sync; not created in v1
```

**Why one TypeScript codebase in v1.** Everything the server does per request is a few SQLite statements and one small parse, and the Cloudflare ecosystem it needs (Hono, the MCP SDK, the OAuth provider library, DO and D1 bindings) is TypeScript-first, so coding agents are fastest there. With MCP as the only agent interface there is no second language in v1 at all. The CLI, when it comes, is a separate thin client whose language (Go or Rust) is chosen on distribution and sync-loop ergonomics, not on shared code, because it shares none.

**Handing off to Claude Code.** Each phase becomes one epic with the gate as its acceptance test; each table in this doc (schema, routes, CLI commands, MCP tools, maintainers) becomes a checklist. The spec is the source of truth; when implementation finds it wrong, the fix is a spec edit first.

## Open questions

Decisions the author should make before Phase 1 starts, and spec ambiguities to resolve during it.

- [ ] Product name, MCP server name, and the resource URI scheme (`okf://` is provisional and should carry the product name so it does not read as an official OKF scheme).
- [ ] Offline `lint` in the CLI: not in v1. If added later, use the community `okf-core` crate in the CLI and keep it aligned with the server's TypeScript parser through the shared `/fixtures` suite.
- [ ] Stamped bytes vs writer's bytes: the write path rewrites frontmatter to stamp `generated`. Should the server preserve the writer's key order and formatting (harder, friendlier to diffs) or re-serialize (simpler, changes diffs)? Proposed: preserve order, touch only the stamped keys.
- [ ] Size cap default (100 KB proposed) and whether it applies to attachments (proposed: 25 MB via Worker in v1).
- [ ] `usage_count` write-back: off by default, or never written to frontmatter and only exposed through the API? Proposed: API only until someone asks.
- [ ] Link rewriting on move: rewrite bodies (chosen) vs resolve at render. Confirm before building the link-maintainer.
- [ ] Directory rename: one `move` event per descendant path (simple, N events) or a single `move` with a prefix (one event, harder snapshots). Proposed: per path, one request.
- [ ] Snapshot query cost: the window query over `events` is fine for thousands of events; decide the threshold at which a materialized `snapshots` table is added.
- [ ] Import of `log.md` into the ledger as historical `process:import` events: worth it in v1, or defer.
- [ ] Human actor form: `human:<email local part>` vs `human:<chosen handle>`. Affects what exported bundles show.
- [ ] Spec proposals to file upstream once v1 exists: a conventional `type: Request` with `fulfilled` status; guidance that `index.md` and `log.md` may be consumer-generated and should not be committed; a note on stable IDs behind paths.
- [ ] Whether the MCP server should expose the synthesized `index.md` as the default entry point (a `start` tool) so agents without the Skill doc still do progressive disclosure.

**Sources**

- [OKF specification (v0.2)](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
- [OKF README, reference agent and sample bundles](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/README.md)
- [okf-core Rust crate](https://docs.rs/okf-core)
- [okf-wiki (Obsidian + OKF)](https://github.com/mchu1966/okf-wiki)
- [skosovsky/okf CLI](https://github.com/skosovsky/okf)
