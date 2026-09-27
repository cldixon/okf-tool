#!/usr/bin/env bash
# Install workspace deps at the start of Claude Code on the web sessions.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR"
bun install --frozen-lockfile >/dev/null
echo 'export WRANGLER_SEND_METRICS=false' >> "${CLAUDE_ENV_FILE:-/dev/null}"
