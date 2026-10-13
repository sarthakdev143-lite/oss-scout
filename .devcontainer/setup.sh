#!/usr/bin/env bash
# Codespace setup (postCreateCommand; safe to re-run): pinned Bun and opencode, the plugin's
# dependencies, and the state directory. See docs/CODESPACES.md.
set -euo pipefail

BUN_VERSION="1.3.14"      # the version oss-scout's tests run on
OPENCODE_VERSION="2.0.24" # the opencode V2 release oss-scout was checked against
STATE_DIR="/workspaces/.oss-scout"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$(bun --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
  npm install --global "bun@$BUN_VERSION"
fi
if [ "$(opencode --version 2>/dev/null || true)" != "opencode v$OPENCODE_VERSION" ]; then
  npm install --global "@opencode/cli@$OPENCODE_VERSION"
fi

# opencode V2 does not install a local plugin's dependencies itself.
(cd "$repo_root" && bun install --frozen-lockfile)

# State lives under /workspaces (kept across container rebuilds), outside the git checkout.
if [ ! -d "$STATE_DIR" ]; then
  mkdir -p "$STATE_DIR" 2>/dev/null || { sudo mkdir -p "$STATE_DIR" && sudo chown "$(id -u):$(id -g)" "$STATE_DIR"; }
fi
chmod 700 "$STATE_DIR"

echo
echo "oss-scout: Bun $(bun --version), $(opencode --version), state in $STATE_DIR"
echo "Next: bun run cli doctor   (docs/CODESPACES.md)"
