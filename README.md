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
`/history`, `/revert`, `/import` and `/export`.

`fixtures/` holds Google's sample OKF bundles (Apache 2.0), vendored for the round-trip tests.
