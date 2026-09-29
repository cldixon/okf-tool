# CLAUDE.md

## Spec
The spec is a live Claude Doc and is the single source of truth:
**OKF Knowledge Service — Spec** — https://claude.ai/artifact/KMuKyyFBSJHzukyEGqvUDn

Read it with the Docs tools before starting on a feature. There is no markdown copy in this repo; do not add one. When implementation shows the spec is wrong, update the doc first, then the code.

## Tooling
- **bun for everything JS/TS**: installing (`bun install`, `bun add`), scripts (`bun run …`), tests (`bun test`), one-off binaries (`bunx`). Do not use npm, npx, yarn or pnpm, and do not commit other lockfiles.
- **TypeScript only** on the server (Worker + Durable Object). No Rust or WASM in v1.
- **Biome** for lint and format (`biome.json`); no ESLint or Prettier.
- **wrangler** is a dev dependency of `worker/`; run it with `bunx wrangler …` from `worker/`.

## Commands (from the repo root)
| Command | What it does |
| --- | --- |
| `bun install` | Install all workspace deps |
| `bun run dev` | `wrangler dev` for the Worker (local D1, R2 and DO state in `worker/.wrangler/`) |
| `bun run check` | Lint + typecheck + tests; run before every commit |
| `bun run format` | Apply Biome fixes |
| `bun run deploy` | Deploy the Worker to Cloudflare |
| `bun run seed` | Create a local user, library (`dev`) and write token in the local D1; prints the token. From `worker/`, `bun run seed --slug x --actor y` for more |
| `bun run gate` | Gate: boots `wrangler dev` on fresh state, round-trips Google's sample bundles over HTTP and runs the MCP smoke flow; also runs in CI |

After changing `worker/wrangler.jsonc`, run `bunx wrangler types` in `worker/` and commit the regenerated `worker-configuration.d.ts`.

## Layout
```
worker/                  Worker + Library Durable Object (TypeScript, Hono)
worker/src/index.ts      Worker entry: wires D1 auth, the Library DO and R2 into the app
worker/src/app.ts        Hono app: REST routes under /api/v1/libraries/{lib}/, with injectable deps
worker/src/auth.ts       Bearer tokens: hash lookup in D1, scope, prefix, expiry, revocation
worker/src/client.ts     Worker <-> DO boundary: one `call` RPC, errors as data, R2 blob checks
worker/src/library.ts    Library DO: one per OKF library, hosts the store on its SQLite
worker/src/okf/          OKF semantics: parse, record, render, links, footnotes, trust, lint, index/log render, diff
worker/src/store/        Library schema and LibraryStore (writes, ledger, snapshots, queries) against a plain SQLite handle
worker/src/util/tar.ts   Tar reader and writer for import and export
worker/src/mcp/server.ts MCP server at /mcp: stateless Streamable HTTP, tier 1 and tier 2 tools, okf:// resources
worker/scripts/          seed.ts (`bun run seed`), gate.ts (`bun run gate`), mcp-smoke.ts (MCP flow against any URL)
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
- The DO write transaction must stay synchronous (no awaits); hash with `okf/hash.ts`, not WebCrypto.

## Cloudflare
- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set in the cloud environment; wrangler reads them automatically.
- Remote resources: D1 `okf-accounts` (id in `wrangler.jsonc`) and R2 bucket `okf-blobs`. Do not create or delete remote resources without asking.
- `bun run seed --remote` (from `worker/`) creates a library and token in the deployed D1.

## CI
`.github/workflows/ci.yml` runs on PRs and pushes to `main`: `bun run check`, and `bun run gate` (wrangler dev, sample-bundle round-trip, MCP smoke). Both must pass before merging.
