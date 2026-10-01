# okf-tool

A hosted, agent-first store for Open Knowledge Format (OKF) bundles on Cloudflare.

The spec lives in a Claude Doc, not in this repo:
**OKF Knowledge Service — Spec** — https://claude.ai/artifact/KMuKyyFBSJHzukyEGqvUDn

The live doc is the source of truth. Do not add a markdown copy of the spec here; read and edit the doc instead.

## Deploy your own

Everything runs in your own Cloudflare account; the Workers Free plan is enough to start. The
project uses Cloudflare's [`cf` CLI](https://developers.cloudflare.com/cf/) (a dev dependency, so
`bunx cf` runs the pinned version) and its typed `worker/cloudflare.config.ts`.

### 1. Deploy

With [bun](https://bun.sh):

```sh
git clone https://github.com/cldixon/okf-tool && cd okf-tool && bun install
cd worker
bunx cf auth login                               # or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
bunx cf d1 create --name okf-accounts            # put its id in cloudflare.config.ts (DB)
bunx cf kv namespaces create --title okf-oauth   # put its id in cloudflare.config.ts (OAUTH_KV)
bunx cf r2 buckets create --name okf-blobs
bun run deploy                                   # applies D1 migrations, then cf deploy
```

You get `https://okf-service.<your-subdomain>.workers.dev` (the `name` in `cloudflare.config.ts` is
yours to change). `https://<your-worker>/healthz` should answer `{"ok":true,...}`, and
`https://<your-worker>/app` says "Sign-in is not set up" until step 2. `bun run deploy --dry-run`
builds and validates without touching your account.

### 2. Put Cloudflare Access in front of `/app/`

The web UI and the page where you approve apps sit behind
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/).
Access covers only `/app/`; `/mcp`, the OAuth endpoints and the REST API stay reachable by apps and
are protected by tokens.

1. In the Cloudflare dashboard, open **Zero Trust** (create the free organization if asked) and
   make sure a login method is available: **One-time PIN** (email codes) works with no setup.
2. **Access → Applications → Add an application → Self-hosted.** Add a public hostname: your
   Worker's host (e.g. `okf-service.<subdomain>.workers.dev`) with path `app`. Add a policy that
   allows the people who may use the UI and connect apps, e.g. **Include → Emails →
   you@example.com**. Do not use the Worker's one-click **Enable Cloudflare Access** toggle: it
   protects the whole hostname, including `/mcp`.
3. From the application's **Overview**, copy the **Application Audience (AUD) Tag**. Your team
   domain (`https://<team>.cloudflareaccess.com`) is shown in the Zero Trust **Settings**.
4. Set them as two secrets on the Worker: in the dashboard under **Workers & Pages → your Worker →
   Settings → Variables and Secrets**, add `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` as type
   **Secret**. Or, from `worker/`:

   ```sh
   bunx cf workers secrets update ACCESS_TEAM_DOMAIN --worker okf-service --type secret_text \
     --text https://<team>.cloudflareaccess.com
   bunx cf workers secrets update ACCESS_AUD --worker okf-service --type secret_text --text <AUD tag>
   ```

### 3. Create a library and connect an agent

Open `https://<your-worker>/app` and sign in. **New library** creates one (to start from a bundle,
use its **Import & export** page). Then connect an agent as described under
[Agents (MCP)](#agents-mcp): add `https://<your-worker>/mcp` as a connector in claude.ai, or mint a
token on the **Tokens** page for Claude Code.

## Development

Requires [bun](https://bun.sh).

```sh
bun install
bun run seed    # local user, library `dev` and a write token (printed)
bun run dev     # cf dev on http://localhost:8787
bun run check   # lint + typecheck + tests
bun run gate    # gate: round-trip Google's sample bundles and more through cf dev
```

With the dev server running and a seeded token:

```sh
T=okf_...   # from bun run seed
L=http://localhost:8787/api/v1/libraries/dev
curl -X PUT -H "Authorization: Bearer $T" -H 'If-None-Match: *' -H 'X-Note: first note' \
  --data-binary $'---\ntype: Note\ntitle: Hello\n---\nHello.\n' $L/files/notes/hello.md
curl -H "Authorization: Bearer $T" $L/files/notes/hello.md       # rendered OKF markdown, ETag = hash
curl -H "Authorization: Bearer $T" $L/files/index.md             # synthesized
curl -H "Authorization: Bearer $T" "$L/grep?pattern=Hello"
curl -H "Authorization: Bearer $T" $L/requests                   # the ledger, newest first
curl -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/x-tar' \
  --data-binary @bundle.tar "$L/import?strip=1"                  # import a bundle tarball
curl -H "Authorization: Bearer $T" -o out.tar $L/export          # export a conformant bundle
```

Routes are listed in the spec's HTTP API section; Phase 1 ships `/files` (GET, PUT, PATCH, DELETE,
move), `/batch`, `/tree`, `/grep`, `/concepts`, `/search`, `/links`, `/events`, `/requests`,
`/history`, `/revert`, `/import` and `/export`; Phase 2 adds `/sources`, `/diff`, `/work`, `/verify`
and short-lived `/dl/…` download links.

## Web UI

`https://<your-worker>/app` is the built-in UI, behind the same Cloudflare Access sign-in (see
[Deploy your own](#deploy-your-own), step 2). It lists your libraries; each library page shows its directories and concepts with
their type, trust tier and staleness. A concept page renders the body, with the frontmatter, the
sources (footnotes resolved, internal sources with their own trust and staleness), inbound links and
the history beside it. Every page takes `?at=<seq>` to show the library as it was then, and a
concept's raw markdown is one click away.

The **ledger** lists every change request newest first (who, when, their note, the files touched),
filtered by directory, actor and date. Each change has a diff, each concept links to "changes since
human verification", and any request can be **reverted** (or one file restored to an earlier
version) after a confirmation page; reverts are recorded as your own requests, so they can be undone
too.

**Verify** on a concept records that you checked its current version: the trust tier becomes
human-reviewed until the next edit lapses it. The **work queue** lists stale concepts, broken links and
lint, most linked-to first. **Import & export** downloads a library as a conformant bundle (at any
sequence) and imports a `.tar` or `.tar.gz` as one revertible request. The **Libraries** page creates
libraries, and **Tokens** mints, lists and revokes bearer tokens. There is no editor, by design: ask an
agent.

The same management is available over REST with a `human:` token (mint one for your own actor on the
Tokens page): `GET/POST /api/v1/libraries`, `GET/POST /api/v1/tokens` and
`DELETE /api/v1/tokens/{id}`.

## Agents (MCP)

The Worker serves an MCP server at `/mcp` (Streamable HTTP). Each connection reaches one library.

**claude.ai, ChatGPT and other apps (OAuth).** Add `https://<your-worker>/mcp` as a custom
connector. The app sends you to `/app/authorize`, where you sign in with Cloudflare Access and choose
what the app may do: which library (or a new one), read only or read and write, an optional
directory, the name its changes carry in the ledger (e.g. `claude-ai/connector`), and all tools or
file tools only. `/app/grants` lists connected apps and revokes them.

**Claude Code, scripts and scheduled tasks (bearer token).** Mint a token on the **Tokens** page
(`/app/tokens`): pick the library, an actor such as `claude-code/laptop` (or `process:<name>` for a
scheduled job that may verify), read or write, and optionally a directory, an expiry and file tools
only. The secret is shown once, with the command to paste:

```sh
claude mcp add --transport http okf https://<your-worker>/mcp \
  --header "Authorization: Bearer <token>"
```

Tier 1 tools mirror file work (`start`, `browse`, `read`, `write`, `edit`, `grep`, `move`,
`delete`, `batch`, `attach`); tier 2 adds what files lack (`search`, `query`, `links`, `sources`,
`log`, `history`, `diff`, `revert`, `work`, `export`, and `verify` for `process:` tokens). A
connection limited to file tools sees tier 1 only. [`skills/okf/SKILL.md`](skills/okf/SKILL.md)
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
  `exports/<library id>/<date>-pre-restore-<hhmmssmmm>/`, records the restore under
  `restores/<library id>/`, and lists past restores with an **Undo**. To take back one change, revert
  it from the ledger instead. Local dev (`cf dev`) has no point-in-time recovery, so there a restore is
  refused without writing anything. Over REST, with a `human:` token for the library:
  `POST /api/v1/libraries/<lib>/restore` with `{ "to": "<ISO time>" }` or `{ "undo": "<id>" }`, and
  `GET /api/v1/libraries/<lib>/restores`; `worker/scripts/restore-smoke.ts` runs a restore and undo
  against a deployed Worker.
- **Usage.** Reads of a concept's current version are counted per day; internal sources show their
  read count over the last 30 days, and the same run prunes older counts.
- **Health and stats.** `GET /healthz` checks D1, R2 and the Durable Object namespace (503 with the
  failing one otherwise). `GET /api/v1/libraries/<lib>/stats` reports paths, events, requests,
  storage bytes, the export cursor and lag, and the last and next maintenance run; the library's
  home page shows the same.
- **Logs and deployments.** From `worker/`: `bun run logs` prints recent requests, Durable Object
  calls and alarms from Workers Observability (`--minutes 60`, `--errors`, `--json`);
  `bunx cf workers deployments list --worker okf-service` lists deployments. `cf` cannot stream
  live logs yet, so for a live tail run `bunx wrangler tail okf-service`.

For local development, copy `worker/.dev.vars.sample` to `worker/.dev.vars`; `/app/` then treats
`localhost` requests as signed in with `DEV_ACCESS_EMAIL`.

`fixtures/` holds Google's sample OKF bundles (Apache 2.0), vendored for the round-trip tests.
