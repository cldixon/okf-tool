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

## Agents (MCP)

The Worker serves an MCP server at `/mcp` (Streamable HTTP). Each connection reaches one library.

**claude.ai, ChatGPT and other apps (OAuth).** Add `https://<your-worker>/mcp` as a custom
connector. The app sends you to `/app/authorize`, where you sign in with Cloudflare Access and choose
what the app may do: which library (or a new one), read only or read and write, an optional
directory, the name its changes carry in the ledger (e.g. `claude-ai/connector`), and all tools or
file tools only. `/app/grants` lists connected apps and revokes them.

**Claude Code, scripts and scheduled tasks (bearer token).** Mint a token with
`bun run seed --remote --slug <library> --actor <app>/<label>` from `worker/`, then:

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

5. Open `https://<your-worker>/app/grants`: after signing in you should see "Connected apps".

For local development, copy `worker/.dev.vars.example` to `worker/.dev.vars`; `/app/` then treats
`localhost` requests as signed in with `DEV_ACCESS_EMAIL`.

`fixtures/` holds Google's sample OKF bundles (Apache 2.0), vendored for the round-trip tests.
