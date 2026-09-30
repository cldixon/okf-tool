# okf-tool

A hosted, agent-first store for Open Knowledge Format (OKF) bundles on Cloudflare.

The spec lives in a Claude Doc, not in this repo:
**OKF Knowledge Service — Spec** — https://claude.ai/artifact/KMuKyyFBSJHzukyEGqvUDn

The live doc is the source of truth. Do not add a markdown copy of the spec here; read and edit the doc instead.

## Development

Requires [bun](https://bun.sh).

```sh
bun install
bun run seed    # local user, library `dev` and a write token (printed)
bun run dev     # wrangler dev on http://localhost:8787
bun run check   # lint + typecheck + tests
bun run gate    # Phase 1 gate: round-trip Google's sample bundles through wrangler dev
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
Operator setup). It lists your libraries; each library page shows its directories and concepts with
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

## Operator setup: sign-in for connecting apps

Connecting an app is approved by a person signed in through
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/).
Access covers only `/app/`; `/mcp`, the OAuth endpoints and the REST API stay reachable by apps and
are protected by tokens. Once per deployment:

1. In the Cloudflare dashboard, open **Zero Trust** (create the free organization if asked) and
   make sure a login method is available: **One-time PIN** (email codes) works with no setup.
2. **Access → Applications → Add an application → Self-hosted.** Add a public hostname: your
   Worker's host (e.g. `okf-service.<subdomain>.workers.dev`) with path `app`. Add a policy that
   allows the people who may connect apps, e.g. **Include → Emails → you@example.com**.
   Do not use the Worker's one-click **Enable Cloudflare Access** toggle: it protects the whole
   hostname, including `/mcp`.
3. From the application's **Overview**, copy the **Application Audience (AUD) Tag**. Your team
   domain (`https://<team>.cloudflareaccess.com`) is shown in the Zero Trust **Settings**.
4. From `worker/`:

   ```sh
   bunx wrangler secret put ACCESS_TEAM_DOMAIN   # https://<team>.cloudflareaccess.com
   bunx wrangler secret put ACCESS_AUD           # the audience tag
   ```

5. Open `https://<your-worker>/app`: after signing in you should see your libraries.

## Operations

- **Nightly export.** Each library's Durable Object wakes once a day at about 03:00 UTC. If anything
  changed since the last run, it writes `bundle.tar` (a conformant bundle), `ledger.jsonl` (every
  event and blob, so history can be rebuilt) and `manifest.json` to the R2 bucket under
  `exports/<library id>/<date>/`. Exports older than `EXPORT_RETENTION_DAYS` (a var in
  `wrangler.jsonc`, default 30) are deleted; the newest is always kept. The library's **Import &
  export** page lists them for download and has **Export now**.
- **Usage.** Reads of a concept's current version are counted per day; internal sources show their
  read count over the last 30 days, and the same run prunes older counts.
- **Health and stats.** `GET /healthz` checks D1, R2 and the Durable Object namespace (503 with the
  failing one otherwise). `GET /api/v1/libraries/<lib>/stats` reports paths, events, requests,
  storage bytes, the export cursor and lag, and the last and next maintenance run; the library's
  home page shows the same.

For local development, copy `worker/.dev.vars.example` to `worker/.dev.vars`; `/app/` then treats
`localhost` requests as signed in with `DEV_ACCESS_EMAIL`.

`fixtures/` holds Google's sample OKF bundles (Apache 2.0), vendored for the round-trip tests.
