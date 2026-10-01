# CLAUDE.md

## Spec
The spec is a live Claude Doc and is the single source of truth:
**OKF Knowledge Service — Spec** — https://claude.ai/artifact/KMuKyyFBSJHzukyEGqvUDn

Read it with the Docs tools before starting on a feature. There is no markdown copy in this repo; do not add one. When implementation shows the spec is wrong, update the doc first, then the code.

## Tooling
- **bun for everything JS/TS**: installing (`bun install`, `bun add`), scripts (`bun run …`), tests (`bun test`), one-off binaries (`bunx`). Do not use npm, npx, yarn or pnpm, and do not commit other lockfiles.
- **TypeScript only** on the server (Worker + Durable Object). No Rust or WASM in v1.
- **Biome** for lint and format (`biome.json`); no ESLint or Prettier.
- **cf** (Cloudflare's CLI, beta, pinned) is a dev dependency of `worker/`; run it with `bunx cf …` from `worker/`. The Worker is configured in `worker/cloudflare.config.ts`; there is no `wrangler.jsonc`. To find a command, use `bunx cf cli search "<task>"` (anonymous wording: no names or IDs), then `--help` on the match or `bunx cf schema <command>`; do not walk nested `--help`. cf resource commands take IDs, not names or bindings (scripts/cf.ts reads the D1 ID from the config). Set `CF_SEND_TELEMETRY=false` in scripts and CI. Scripts call cf through `scripts/cf.ts`, which times out and retries, because cf (beta) sometimes hangs on local D1 commands; keep calls made through it safe to repeat.
- **wrangler** stays a dev dependency only as the bundler `cf dev`/`cf build` delegate to (`worker/wrangler.config.ts`). Use Wrangler directly only for what cf lacks: live logs (`bunx wrangler tail okf-service`).

## Commands (from the repo root)
| Command | What it does |
| --- | --- |
| `bun install` | Install all workspace deps |
| `bun run dev` | `cf dev` for the Worker (local D1, R2 and DO state in `worker/.wrangler/state`) |
| `bun run check` | Lint + typecheck + tests; run before every commit |
| `bun run format` | Apply Biome fixes |
| `bun run deploy` | Apply D1 migrations (database ID from `cloudflare.config.ts`), then `cf deploy`; `--dry-run` builds and validates only |
| `bun run seed` | Create a local user, library (`dev`) and write token in the local D1; prints the token. From `worker/`, `bun run seed --slug x --actor y` for more |
| `bun run logs` | Recent events from Workers Observability via `cf observability telemetry query` (`--minutes`, `--errors`, `--json`) |
| `bun run gate` | Gate: boots `cf dev` on fresh state (a throwaway project in `worker/.gate/`), round-trips Google's sample bundles over HTTP, renders every UI page for them, runs the nightly export through the DO into local R2, checks a restore is refused cleanly (no PITR locally), and runs the MCP smoke flow; also runs in CI |

Binding types come from `cloudflare.config.ts`: `bun run typecheck` regenerates them with `cf workers types` into `worker/.cloudflare/types/` (gitignored). Secrets are not in the config; type them in `worker/src/env.d.ts`.

## Layout
```
worker/                  Worker + Library Durable Object (TypeScript, Hono)
worker/src/index.ts      Worker entry: wires D1, the Library DO, R2 and KV into createWorker
worker/src/worker.ts     Cloudflare's OAuth provider in front of the app: discovery, /register, /token, guards /mcp
worker/src/app.ts        Hono app: REST routes under /api/v1/libraries/{lib}/, with injectable deps
worker/src/auth.ts       Bearer tokens: hash lookup in D1, scope, prefix, expiry, revocation
worker/src/access.ts     Cloudflare Access sign-in for /app/* (verifies the Access JWT)
worker/src/accounts.ts   Users and libraries in D1, for the consent page
worker/src/oauth/        /app/authorize consent page and /app/grants (list, revoke)
worker/src/ui/           Built-in UI under /app/ (behind Access): routes, views, markdown-to-HTML (no raw HTML, safe URLs only)
worker/src/client.ts     Worker <-> DO boundary: one `call` RPC, errors as data, R2 blob checks
worker/src/library.ts    Library DO: one per OKF library, hosts the store on its SQLite; its daily alarm runs the maintainers
worker/src/maintain.ts   Daily maintainers (nightly export to R2 with retention, usage pruning), free of Worker APIs
worker/src/recovery.ts   Point-in-time restore: pre-restore export, restore records in R2, undo; free of Worker APIs
worker/src/okf/          OKF semantics: parse, record, render, links, footnotes, trust, lint, index/log render, diff
worker/src/store/        Library schema and LibraryStore (writes, ledger, snapshots, queries) against a plain SQLite handle
worker/src/util/tar.ts   Tar reader and writer for import and export
worker/src/mcp/server.ts MCP server at /mcp: stateless Streamable HTTP, tier 1 and tier 2 tools, okf:// resources
worker/cloudflare.config.ts  The Worker for cf: bindings, Durable Object exports, compatibility
worker/scripts/          cf.ts (runs cf, reads the config), deploy.ts, logs.ts, seed.ts (`bun run seed`), gate.ts (`bun run gate`), mcp-smoke.ts (MCP flow against any URL), restore-smoke.ts (PITR restore and undo against a deployed Worker)
worker/migrations/       D1 migrations (account layer)
worker/test/             bun tests; worker/test/tsconfig.json adds bun types
skills/okf/SKILL.md      Agent skill doc: the OKF workflow over the MCP tools
fixtures/                Google's four sample OKF bundles, vendored unchanged; do not edit
```

## Testing
- Unit tests run under `bun test`. `cloudflare:workers` does not exist outside workerd, so tests stub it with `mock.module` (see `worker/test/healthz.test.ts`).
- Keep storage and OKF logic free of Worker APIs so it can be tested under bun with `bun:sqlite` standing in for the DO's SQLite handle (`worker/test/sqlite.ts`).
- Route and MCP tests (`worker/test/api.test.ts`, `mcp.test.ts`) run the real app in process via `worker/test/harness.ts`: a bun:sqlite store behind the same `callStore` the DO uses, an in-memory blob store and fake tokens. MCP tests drive it with the SDK's own client.
- MCP tool descriptions and `INSTRUCTIONS` in `worker/src/mcp/server.ts` carry the agent workflow; keep them in step with `skills/okf/SKILL.md`.
- `worker/test/oauth.test.ts` drives the OAuth flow as an MCP client would: discovery, DCR, consent (dev sign-in), token with PKCE, MCP calls, revocation.
- The DO write transaction must stay synchronous (no awaits); hash with `okf/hash.ts`, not WebCrypto.

## Cloudflare
- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set in the cloud environment; cf (and wrangler) read them automatically.
- Remote resources: D1 `okf-accounts` (id in `cloudflare.config.ts`) and R2 bucket `okf-blobs`. Do not create or delete remote resources without asking.
- Tokens and libraries are managed at `/app/tokens` and `/app` (or `/api/v1/tokens` and `/api/v1/libraries` with a `human:` token). `bun run seed --remote` (from `worker/`) still creates a library and token directly in the deployed D1.
- KV `okf-oauth` (binding `OAUTH_KV`) holds OAuth clients and grants. Secrets `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` come from the Access application covering `/app/*`; never put Access on `/mcp`. Local dev uses `DEV_ACCESS_EMAIL` from `worker/.dev.vars` (copy `worker/.dev.vars.sample`).
- `worker/` is the deployable project and must stay self-contained: its own `package.json` with every dependency, nothing imported from outside `worker/` at build time. `cloudflare.config.ts` must not import Worker code (scripts import it under bun).

## CI
`.github/workflows/ci.yml` runs on PRs and pushes to `main`: `bun run check`, `bun run gate` (cf dev, sample-bundle round-trip, UI pages, MCP smoke), and a standalone build of `worker/` copied alone (`cf deploy --dry-run`). All must pass before merging.
