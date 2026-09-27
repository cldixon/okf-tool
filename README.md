# okf-tool

A hosted, agent-first store for Open Knowledge Format (OKF) bundles on Cloudflare.

The spec lives in a Claude Doc, not in this repo:
**OKF Knowledge Service — Spec** — https://claude.ai/artifact/KMuKyyFBSJHzukyEGqvUDn

The live doc is the source of truth. Do not add a markdown copy of the spec here; read and edit the doc instead.

## Development

Requires [bun](https://bun.sh).

```sh
bun install
bun run dev     # wrangler dev on http://localhost:8787
bun run check   # lint + typecheck + tests
```
