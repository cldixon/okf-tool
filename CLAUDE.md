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

After changing `worker/wrangler.jsonc`, run `bunx wrangler types` in `worker/` and commit the regenerated `worker-configuration.d.ts`.

## Layout
```
worker/                  Worker + Library Durable Object (TypeScript, Hono)
worker/src/index.ts      Worker entry: routing
worker/src/library.ts    Library DO: one per OKF library
worker/src/okf/          (planned) OKF semantics: parse, links, footnotes, trust, lint, index/log render
worker/src/store/        (planned) storage logic against a plain SQLite handle
worker/src/mcp/          (planned) MCP server
worker/migrations/       D1 migrations (account layer)
worker/test/             bun tests; worker/test/tsconfig.json adds bun types
skills/okf/SKILL.md      (planned) agent skill doc
fixtures/                (planned) Google's sample OKF bundles for round-trip tests
```

## Testing
- Unit tests run under `bun test`. `cloudflare:workers` does not exist outside workerd, so tests stub it with `mock.module` (see `worker/test/healthz.test.ts`).
- Keep storage and OKF logic free of Worker APIs so it can be tested under bun with `bun:sqlite` standing in for the DO's SQLite handle.

## Cloudflare
- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set in the cloud environment; wrangler reads them automatically.
- The D1 `database_id` in `wrangler.jsonc` is a placeholder until the remote database is created. Do not create or delete remote resources without asking.
