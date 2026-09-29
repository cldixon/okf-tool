# Fixtures

Google's four sample OKF v0.2 bundles (`acme_retail`, `crypto_bitcoin`, `ga4`, `stackoverflow`),
vendored unchanged from the canonical repository
[GoogleCloudPlatform/open-knowledge-format](https://github.com/GoogleCloudPlatform/open-knowledge-format)
at commit `ad30107c31c06aec8a7d5636e0d1058118604e6f` (`bundles/`), under the Apache 2.0 license in
[`LICENSE.md`](LICENSE.md).

They are the Phase 1 gate: each bundle must import into a fresh library and export with the same
parsed frontmatter and bodies (formatting canonicalized, `index.md` and `log.md` ignored because the
service synthesizes them), and byte-identical attachments.

Do not edit these files; re-vendor from upstream instead.
