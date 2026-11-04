# Tempra

A hosted, agent-first store for libraries of markdown pages on Cloudflare, kept by people and their
agents. Libraries import from and export to Google's Open Knowledge Format (OKF) on request.

The design lives in the Tempra library `cl_dixon/tempra-dev` (see `CLAUDE.md`); the original
spec is in Claude Docs, not in this repo:
**OKF Knowledge Service — Spec** — https://claude.ai/artifact/KMuKyyFBSJHzukyEGqvUDn, and the
managed service built on it, **v2 Spec** — https://claude.ai/code/artifact/cea3e8c6-4161-4f53-aa6d-54093bc7ed75

The live doc is the source of truth. Do not add a markdown copy of the spec here; read and edit the doc instead.

## Deploy your own

Everything runs in your own Cloudflare account. Sign-in emails need the Workers Paid plan (Email
Sending) and a domain on Cloudflare. The
project uses Cloudflare's [`cf` CLI](https://developers.cloudflare.com/cf/) (a dev dependency, so
`bunx cf` runs the pinned version) and its typed `worker/cloudflare.config.ts`.

### 1. Deploy

With [bun](https://bun.sh):

```sh
git clone https://github.com/cldixon/tempra && cd tempra && bun install
cd worker
bunx cf auth login                               # or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
bunx cf d1 create --name tempra-accounts         # put its id in cloudflare.config.ts (DB)
bunx cf kv namespaces create --title tempra-oauth # put its id in cloudflare.config.ts (OAUTH_KV)
bunx cf r2 buckets create --name tempra-blobs
bun run deploy                                   # applies D1 migrations, then cf deploy
```

Before deploying, set `host` in `cloudflare.config.ts` to a hostname on a domain in your Cloudflare
account: the Worker is published there as a custom domain, and `workers.dev` is off. The `name`
is yours to change too. `https://<your-host>/healthz` should answer `{"ok":true,...}`, and
`https://<your-host>/` says "Sign-in is not set up" until step 2. `bun run deploy --dry-run`
builds and validates without touching your account.

### 2. Email sign-in

The web UI and the page where you approve apps sign people in by an emailed link. `/mcp`, the OAuth
endpoints and the REST API are protected by tokens instead. Each person gets their own account and
sees only their own libraries, tokens and connected apps.

1. In the dashboard, **Email Service → Email Sending**: onboard a domain on Cloudflare (a
   subdomain such as `mail.example.com` keeps its reputation apart).
2. Set `mailFrom` for your deployment in `cloudflare.config.ts` (e.g. `noreply@mail.example.com`)
   and deploy again.
3. Who may sign up is `SIGNUP` in the config: `invite` (the default; only invited emails and
   existing accounts get links, everyone else joins a waitlist), `closed` or `open`. Invite
   yourself: `bun run admin invite --email you@example.com --remote` (from `worker/`).
4. Optionally, set `OPERATOR_EMAIL` for the daily digest:
   `bunx cf workers secrets update OPERATOR_EMAIL --worker <worker name> --type secret_text --text you@example.com`.

### 3. Create a library and connect an agent

Open `https://<your-host>/` and sign in. **New library** creates one (to start from a bundle,
use its **Import & export** page). Then connect an agent as described under
[Agents (MCP)](#agents-mcp): add `https://<your-host>/mcp` as a connector in claude.ai, or mint a
token on the **Tokens** page for Claude Code.

## Development

Requires [bun](https://bun.sh).

```sh
bun install
bun run seed    # local user dev@localhost, library dev/dev and a write token (printed)
bun run dev     # cf dev on http://localhost:8787; sign in at / as dev@localhost
bun run check   # lint + typecheck + tests
bun run gate    # gate: round-trip Google's sample bundles and more through cf dev
```

With the dev server running and a seeded token:

```sh
T=tempra_...   # from bun run seed
L=http://localhost:8787/api/v1/libraries/dev/dev   # {owner handle}/{library}
curl -X PUT -H "Authorization: Bearer $T" -H 'If-None-Match: *' -H 'X-Note: first note' \
  --data-binary $'---\ntitle: Hello\ndescription: A first page.\n---\nHello.\n' $L/files/notes/hello.md
curl -H "Authorization: Bearer $T" $L/files/notes/hello.md       # the page's markdown, ETag = hash
curl -H "Authorization: Bearer $T" $L/files/index.md             # synthesized
curl -H "Authorization: Bearer $T" "$L/grep?pattern=Hello"
curl -H "Authorization: Bearer $T" $L/requests                   # the ledger, newest first
curl -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/x-tar' \
  --data-binary @bundle.tar "$L/import?strip=1"                  # import a tarball (an OKF bundle too)
curl -H "Authorization: Bearer $T" -o out.tar $L/export          # export the files
curl -H "Authorization: Bearer $T" -o okf.tar "$L/export?format=okf"  # or an OKF bundle
```

Routes are listed in the spec's HTTP API section; Phase 1 ships `/files` (GET, PUT, PATCH, DELETE,
move), `/batch`, `/tree`, `/grep`, `/pages`, `/search`, `/links`, `/events`, `/requests`,
`/history`, `/revert`, `/import` and `/export`; Phase 2 adds `/sources`, `/diff`, `/work`, `/verify`
and short-lived `/dl/…` download links.

## Web UI

`https://<your-host>/` is the built-in UI, for the signed-in person (see
[Deploy your own](#deploy-your-own), step 2). It lists your libraries, each at
`/<your handle>/<library>/` (library pages such as the ledger sit under `/-/`, e.g. `/<handle>/<library>/-/ledger`); each library page shows its directories and pages with
their trust tier and staleness. A page renders the body, with the frontmatter, the
sources (footnotes resolved, internal sources with their own trust and staleness), inbound links and
the history beside it. Every page takes `?at=<seq>` to show the library as it was then, and a
page's raw markdown is one click away.

The **ledger** lists every change request newest first (who, when, their note, the files touched),
filtered by directory, actor and date. Each change has a diff, each page links to "changes since
human verification", and any request can be **reverted** (or one file restored to an earlier
version) after a confirmation page; reverts are recorded as your own requests, so they can be undone
too.

**Verify** on a page records that you checked its current version: the trust tier becomes
human-reviewed until the next edit lapses it. The **work queue** lists stale pages, broken links and
lint, most linked-to first. **Import & export** downloads a library's files, or an OKF bundle (at any
sequence), and imports a `.tar` or `.tar.gz` as one revertible request. The **Libraries** page creates
libraries, and **Tokens** mints, lists and revokes bearer tokens. There is no editor, by design: ask an
agent.

A new account starts at `/welcome` (pick a handle and a first library), then lands on the
library's **Connect** page: the MCP URL for claude.ai, the command for Claude Code, a token link for
other clients, and a status line that shows the agent's first write. `/account` changes the
handle, lists and ends sessions, and deletes the account; a library's **Delete** tab deletes one
library. Pages are deliberately minimal for now.

The same management is available over REST with a `human:` token (mint one for your own actor on the
Tokens page), limited to your own libraries and tokens: `GET/POST /api/v1/libraries`, `GET/POST /api/v1/tokens` and
`DELETE /api/v1/tokens/{id}`.

## Agents (MCP)

The Worker serves an MCP server at `/mcp` (Streamable HTTP). Each connection reaches one library.

**claude.ai, ChatGPT and other apps (OAuth).** Add `https://<your-host>/mcp` as a custom
connector. The app sends you to `/authorize`, where you sign in and choose what the app may do:
which of your libraries (or a new one), read only or read and write, an optional
directory, the name its changes carry in the ledger (e.g. `claude-ai/connector`), and all tools or
file tools only. The **Agents** page (`/agents`) lists connected apps beside tokens and revokes them.

**Claude Code, scripts and scheduled tasks (bearer token).** Mint a token from **New token** on
the **Agents** page (`/agents`): pick the library, an actor such as `claude-code/laptop` (or `process:<name>` for a
scheduled job that may verify), read or write, and optionally a directory, an expiry and file tools
only. The secret is shown once, with the command to paste:

```sh
claude mcp add --transport http tempra https://<your-host>/mcp \
  --header "Authorization: Bearer <token>"
```

Tier 1 tools mirror file work (`start`, `browse`, `read`, `write`, `edit`, `grep`, `move`,
`delete`, `batch`, `attach`); tier 2 adds what files lack (`search`, `query`, `links`, `sources`,
`log`, `history`, `diff`, `revert`, `work`, `export`, and `verify` for `process:` tokens). A
connection limited to file tools sees tier 1 only. [`skills/tempra/SKILL.md`](skills/tempra/SKILL.md)
teaches the workflow to agents that load skills.

## Operations

- **Nightly export.** Each library's Durable Object wakes once a day at about 03:00 UTC. If anything
  changed since the last run, it writes `bundle.tar` (a conformant bundle), `ledger.jsonl` (every
  event and blob, so history can be rebuilt) and `manifest.json` to the R2 bucket under
  `exports/<library id>/<date>/`. Exports older than `EXPORT_RETENTION_DAYS` (a var in
  `cloudflare.config.ts`, default 30) are deleted; the newest is always kept. The library's **Import &
  export** page lists them for download and has **Export now**.
- **Point-in-time restore.** A library's **Recovery** page restores the whole library, ledger
  included, to any moment in the last 30 days and at least 2 minutes ago (Durable Object point-in-time
  recovery, whose history trails live writes by about a minute; a new library has none for its
  first minute or two); type the
  library's name to confirm. It first exports the library as it stands to
  `exports/<library id>/<date>-pre-restore-<hhmmssmmm>-<suffix>/`, records the restore under
  `restores/<library id>/`, and lists past restores with an **Undo**. To take back one change, revert
  it from the ledger instead. Local dev (`cf dev`) has no point-in-time recovery, so there a restore is
  refused without writing anything. Over REST, with a `human:` token for the library:
  `POST /api/v1/libraries/<owner>/<lib>/restore` with `{ "to": "<ISO time>" }` or
  `{ "undo": "<id>" }`, and `GET /api/v1/libraries/<owner>/<lib>/restores`; `worker/scripts/restore-smoke.ts` runs a restore and undo
  against a deployed Worker.
- **Usage.** Reads of a page's current version are counted per day; internal sources show their
  read count over the last 30 days, and the same run prunes older counts.
- **Health and stats.** `GET /healthz` checks D1, R2 and the Durable Object namespace (503 with the
  failing one otherwise). `GET /api/v1/libraries/<owner>/<lib>/stats` reports paths, events, requests,
  storage bytes, the export cursor and lag, and the last and next maintenance run; the library's
  home page shows the same.
- **Logs and deployments.** From `worker/`: `bun run logs` prints recent requests, Durable Object
  calls and alarms from Workers Observability (`--minutes 60`, `--errors`, `--json`);
  `bunx cf workers deployments list --worker <worker name>` lists deployments. `cf` cannot stream
  live logs yet, so for a live tail run `bunx wrangler tail <worker name>`.
- **Limits.** Per account: 10 libraries and 50 active tokens (`bun run admin limits --email <email>
  --set libraries=10` overrides). Per library: 100 MB of storage (`LIBRARY_STORAGE_MB`); past it,
  writes get `507` but reads, deletes and moves still work. Tokens and connected apps get 60 writes a
  minute per account and 600 requests a minute each (`429`). Usage is metered to the Analytics Engine
  dataset `tempra_usage` (staging's to `tempra_usage_staging`, previews' to `tempra_usage_preview`).
- **Daily sweep.** At 04:30 UTC a cron asks every library which attachment files it uses and deletes
  files no library has used for 31 days (longer than the restore window). It emails `OPERATOR_EMAIL` a
  digest when an export is stale, maintenance is overdue, a library is over 80% full, or the sweep was
  skipped.
- **Email.** Sign-in links, email changes and the digest go through Cloudflare Email Service, from
  `mailFrom` in `cloudflare.config.ts` (a domain onboarded for Email Sending; empty means no mailer).
  The digest address is the `OPERATOR_EMAIL` secret:
  `bunx cf workers secrets update OPERATOR_EMAIL --worker <worker name> --type secret_text --text <email>`.
- **Staging.** `bun run deploy --mode staging` deploys the staging Worker with its own D1, R2 and KV
  (`STAGING` in `cloudflare.config.ts`).
- **Who may sign up.** `bun run admin invite --email <email>`, `uninvite`, and `waitlist` (invites
  and people who asked without one). `SIGNUP` in the config picks open, invite or closed.
- **Accounts.** `bun run admin users` lists accounts and their libraries; `bun run admin transfer
  --library <owner>/<slug> --to <email>` gives a library to another account (who has signed in
  once); `bun run admin suspend --email <email>` refuses an account's sessions and tokens (`--undo`
  lifts it). Local D1 by default; add `--remote` for the deployed one.

For local development, copy `worker/.dev.vars.sample` to `worker/.dev.vars`. It sets
`DEV_SIGNIN=1`: on `localhost`, `/sign-in` shows the magic link on the page instead of mailing it.

`fixtures/` holds Google's sample OKF bundles (Apache 2.0), vendored for the round-trip tests.
