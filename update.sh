#!/usr/bin/env bash
# Update DOGGS to the latest remote main commit.
# This file intentionally stays tiny and never changes: its own `git reset --hard` below
# rewrites it on disk mid-run, and on some systems bash keeps reading stale buffered bytes
# for anything after that point in a self-modifying script. So it does the pull only, then
# hands off (via exec, a fresh file open) to install.sh — the same deploy logic used for a
# fresh install — to actually apply the update (existing .env is kept, nothing is re-asked).
set -euo pipefail
BASE_DIR="$(cd "$(dirname "${BASH_SOURCE:-$0}")" && pwd)"
command -v git >/dev/null || { echo "[ERROR] Git is required for updates." >&2; exit 1; }
git -C "$BASE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "[ERROR] This installation is not a Git checkout. Reinstall DOGGS with install.sh." >&2; exit 1; }
echo "[UPDATE] Fetching origin/main into $BASE_DIR…"
git -C "$BASE_DIR" fetch origin main
echo "[UPDATE] Checking out the latest main…"
git -C "$BASE_DIR" checkout main
git -C "$BASE_DIR" reset --hard origin/main
MODE="--local"
if [[ -f /etc/systemd/system/doggs.service ]] && [[ -d /opt/doggs ]] && [[ "$BASE_DIR" != "/opt/doggs" ]]; then MODE="--system"; fi
exec bash "$BASE_DIR/install.sh" "$MODE"
