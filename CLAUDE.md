# CLAUDE.md

## Spec
The spec is a live Claude Doc and is the single source of truth:
**OKF Knowledge Service — Spec** — https://claude.ai/artifact/KMuKyyFBSJHzukyEGqvUDn

The managed-service work (accounts, magic-link sign-in, tenancy, then sharing) is specified in a
companion doc that builds on it: **OKF Service — v2 Spec (managed service)** —
https://claude.ai/code/artifact/cea3e8c6-4161-4f53-aa6d-54093bc7ed75

Read them with the Docs tools before starting on a feature. There is no markdown copy in this repo; do not add one. When implementation shows the spec is wrong, update the doc first, then the code.

## UI
Until the design pass, every page is plain HTML with browser defaults: white background, black text, blue links. No stylesheets, inline styles or scripts (the CSP has no `style-src`), and as little text as works: headings, labels, links, short sentences. Class attributes may stay as hooks for the later design pass. This applies to every page, new or old.

## Tooling
- **bun for everything JS/TS**: installing (`bun install`, `bun add`), scripts (`bun run …`), tests (`bun test`), one-off binaries (`bunx`). Do not use npm, npx, yarn or pnpm, and do not commit other lockfiles.
- **TypeScript only** on the server (Worker + Durable Object). No Rust or WASM in v1.
- **Biome** for lint and format (`biome.json`); no ESLint or Prettier.
- **cf** (Cloudflare's CLI, beta, pinned) is a dev dependency of `worker/`; run it with `bunx cf …` from `worker/`. The Worker is configured in `worker/cloudflare.config.ts`; there is no `wrangler.jsonc`. To find a command, use `bunx cf cli search "<task>"` (anonymous wording: no names or IDs), then `--help` on the match or `bunx cf schema <command>`; do not walk nested `--help`. cf resource commands take IDs, not names or bindings (scripts/cf.ts reads the D1 ID from the config). Set `CF_SEND_TELEMETRY=false` in scripts and CI. Scripts call cf through `scripts/cf.ts` (async): cf (beta) sometimes prints its result and then never exits (a confirmation prompt keeps it alive, e.g. `d1 migrations apply`), so the helper accepts a complete JSON result once cf goes quiet, and otherwise times out and retries; keep calls made through it safe to repeat.
- **wrangler** stays a dev dependency only as the bundler `cf dev`/`cf build` delegate to (`worker/wrangler.config.ts`). Use Wrangler directly only for what cf lacks: live logs (`bunx wrangler tail okf-service`).

## Commands (from the repo root)
| Command | What it does |
| --- | --- |
| `bun install` | Install all workspace deps |
| `bun run dev` | `cf dev` for the Worker (local D1, R2 and DO state in `worker/.wrangler/state`) |
| `bun run check` | Lint + typecheck + tests; run before every commit |
| `bun run format` | Apply Biome fixes |
| `bun run deploy` | Apply D1 migrations (database ID from `cloudflare.config.ts`), then `cf deploy`; `--dry-run` builds and validates only; `--mode staging` deploys the staging Worker (its resource ids must be set first) |
| `bun run seed` | Create a local user (`dev@localhost`, handle `dev`), library (`dev/dev`) and write token in the local D1; prints the token. From `worker/`, `bun run seed --slug x --actor y` for more |
| `bun run admin` | Accounts on D1 (local, or `--remote`): `users`, `transfer --library <owner>/<slug> --to <email>`, `suspend --email <email> [--undo]`, `limits --email <email> [--set libraries=10] [--reset]` |
| `bun run logs` | Recent events from Workers Observability via `cf observability telemetry query` (`--minutes`, `--errors`, `--json`) |
| `bun run gate` | Gate: boots `cf dev` on fresh state (a throwaway project in `worker/.gate/`), round-trips Google's sample bundles over HTTP, renders every UI page for them (signed in by a dev magic link), runs the nightly export through the DO into local R2, checks a restore is refused cleanly (no PITR locally), signs up a second account that must see nothing of the first, has a fresh account go through first run, connect over OAuth with PKCE, write through MCP and delete its library, runs the daily sweep through the scheduled handler, and runs the MCP smoke flow; also runs in CI |

Binding types come from `cloudflare.config.ts`: `bun run typecheck` regenerates them with `cf workers types` into `worker/.cloudflare/types/` (gitignored). Secrets are not in the config; type them in `worker/src/env.d.ts`.

## Layout
```
worker/                  Worker + Library Durable Object (TypeScript, Hono)
worker/src/index.ts      Worker entry: wires D1, the Library DO, R2 and KV into createWorker
worker/src/worker.ts     Cloudflare's OAuth provider in front of the app: discovery, /register, /token, guards /mcp
worker/src/app.ts        Hono app: REST routes under /api/v1/libraries/{owner}/{lib}/, with injectable deps
worker/src/auth.ts       Bearer tokens: hash lookup in D1, scope, prefix, expiry, revocation, suspension
worker/src/accounts.ts   Users (handles), libraries and tokens in D1, every query scoped to one account
worker/src/tenancy.ts    authorizeLibrary: the one check that a caller may reach {owner}/{slug}; 404 otherwise
worker/src/session.ts    Magic links and sessions in D1 (hashes only), the session cookie
worker/src/signin.ts     /app/sign-in, /app/sign-out and signedIn(); Access JWTs still accepted until the A4 cut-over
worker/src/access.ts     Cloudflare Access JWT check (transition only; removed at A4)
worker/src/lifecycle.ts  Deleting a library or an account: rows, grants, then the DO and R2 exports (Deps.destroyLibrary)
worker/src/limits.ts     Per-account limits (libraries, tokens) with overrides in users.limits; storage per library
worker/src/usage.ts      Rate limits (Rate Limiting bindings) and metering (Analytics Engine) for tokens and apps
worker/src/sweep.ts      The daily cron: blob sweep (31 days unreferenced) and operator digest; free of Worker APIs
worker/src/legal.ts      /terms (draft) and /privacy
worker/src/oauth/        /app/authorize consent page and /app/grants (list, revoke)
worker/src/ui/           Built-in UI under /app/: routes, views, account.ts (welcome, connect, account, delete), markdown-to-HTML (no raw HTML, safe URLs only)
worker/src/client.ts     Worker <-> DO boundary: one `call` RPC, errors as data, R2 blob checks
worker/src/library.ts    Library DO: one per OKF library, hosts the store on its SQLite; its daily alarm runs the maintainers
worker/src/maintain.ts   Daily maintainers (nightly export to R2 with retention, usage pruning), free of Worker APIs
worker/src/recovery.ts   Point-in-time restore: pre-restore export, restore records in R2, undo; free of Worker APIs
worker/src/okf/          OKF semantics: parse, record, render, links, footnotes, trust, lint, index/log render, diff
worker/src/store/        Library schema and LibraryStore (writes, ledger, snapshots, queries) against a plain SQLite handle
worker/src/util/tar.ts   Tar reader and writer for import and export
worker/src/mcp/server.ts MCP server at /mcp: stateless Streamable HTTP, tier 1 and tier 2 tools, okf:// resources
worker/cloudflare.config.ts  The Worker for cf: bindings, Durable Object exports, compatibility
worker/scripts/          cf.ts (runs cf, reads the config), deploy.ts, logs.ts, seed.ts (`bun run seed`), admin.ts (`bun run admin`), gate.ts (`bun run gate`), mcp-smoke.ts (MCP flow against any URL), restore-smoke.ts (PITR restore and undo against a deployed Worker)
worker/migrations/       D1 migrations (account layer)
worker/test/             bun tests; worker/test/tsconfig.json adds bun types
skills/okf/SKILL.md      Agent skill doc: the OKF workflow over the MCP tools
fixtures/                Google's four sample OKF bundles, vendored unchanged; do not edit
```

## Testing
- Unit tests run under `bun test`. `cloudflare:workers` does not exist outside workerd, so tests stub it with `mock.module` (see `worker/test/healthz.test.ts`).
- Keep storage and OKF logic free of Worker APIs so it can be tested under bun with `bun:sqlite` standing in for the DO's SQLite handle (`worker/test/sqlite.ts`).
- Route and MCP tests (`worker/test/api.test.ts`, `mcp.test.ts`) run the real app in process via `worker/test/harness.ts`: a bun:sqlite store behind the same `callStore` the DO uses, the real account SQL and migrations on bun:sqlite (`worker/test/d1.ts`), an in-memory blob store and fixed test tokens. `s.app` is signed in as the demo library's owner (`owner/demo`), `s.anon` has no session, `s.stranger()` makes a second account. MCP tests drive it with the SDK's own client.
- Tenancy (`worker/test/tenancy.test.ts`) walks every registered `{owner}/{lib}` route as a stranger and expects 404. A new library route needs nothing extra to be covered, but must go through `authorizeLibrary`.
- MCP tool descriptions and `INSTRUCTIONS` in `worker/src/mcp/server.ts` carry the agent workflow; keep them in step with `skills/okf/SKILL.md`.
- `worker/test/oauth.test.ts` drives the OAuth flow as an MCP client would: discovery, DCR, consent (dev sign-in), token with PKCE, MCP calls, revocation.
- The DO write transaction must stay synchronous (no awaits); hash with `okf/hash.ts`, not WebCrypto.

## Cloudflare
- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set in the cloud environment; cf (and wrangler) read them automatically.
- Remote resources: D1 `okf-accounts` (id in `cloudflare.config.ts`) and R2 bucket `okf-blobs`. Do not create or delete remote resources without asking.
- Tokens and libraries are managed at `/app/tokens` and `/app` (or `/api/v1/tokens` and `/api/v1/libraries` with a `human:` token). `bun run seed --remote` (from `worker/`) still creates a library and token directly in the deployed D1.
- KV `okf-oauth` (binding `OAUTH_KV`) holds OAuth clients and grants. Secrets `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` come from the Access application covering `/app/*`; until the v2 A4 cut-over, an Access sign-in is accepted alongside magic-link sessions. Never put Access on `/mcp`. Local dev uses `DEV_SIGNIN=1` from `worker/.dev.vars` (copy `worker/.dev.vars.sample`): sign-in links show on the page for localhost.
- `cloudflare.config.ts` is a function of `--mode`: production by default, `staging` for a separate Worker with its own D1, R2 and KV (ids not set yet; creating them needs the operator's go-ahead). Scripts pick the mode from `OKF_MODE`.
- Mail goes through Cloudflare Email Service: the `EMAIL` binding is added only when `mailFrom` is set for a deployment in `cloudflare.config.ts`, which needs a sending domain onboarded in Cloudflare. Production sends from `noreply@mail.tempra.dev` (`mail.tempra.dev` is onboarded); local dev with `DEV_SIGNIN=1` still shows links on the page instead of mailing them. `OPERATOR_EMAIL` (a Worker secret, so the address stays out of the repo) receives the daily digest.
- Rate limits are `WRITE_LIMITER` (60 writes a minute per account) and `REQUEST_LIMITER` (600 requests a minute per token or app); metering writes to the Analytics Engine dataset `okf_usage`; storage per library is `LIBRARY_STORAGE_MB`.
- The deployed library `okf-tool` is owned by the seed user (`user_dev`). With tenancy, only its owner sees it in the UI: before deploying A1+ code, move it with `bun run admin transfer --library dev/okf-tool --to <author's email> --remote` (ask first; it changes production).
- `worker/` is the deployable project and must stay self-contained: its own `package.json` with every dependency, nothing imported from outside `worker/` at build time. `cloudflare.config.ts` must not import Worker code (scripts import it under bun).

## CI
`.github/workflows/ci.yml` runs on PRs and pushes to `main`: `bun run check`, `bun run gate` (cf dev, sample-bundle round-trip, UI pages, MCP smoke), and a standalone build of `worker/` copied alone (`cf deploy --dry-run`). All must pass before merging.
