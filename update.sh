#!/usr/bin/env bash
# Update DOGGS to the latest remote main commit.
set -euo pipefail
SCRIPT_PATH="${BASH_SOURCE:-$0}"
BASE_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
REPOSITORY_URL="https://github.com/nickyreinert/doggs.git"
command -v git >/dev/null || { echo "[ERROR] Git is required for updates." >&2; exit 1; }
if ! git -C "$BASE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[UPDATE] Initializing this installation as a Git checkout…"
  git -C "$BASE_DIR" init -b main
  git -C "$BASE_DIR" remote add origin "$REPOSITORY_URL"
fi
echo "[UPDATE] Fetching origin/main…"
git -C "$BASE_DIR" fetch origin main
echo "[UPDATE] Checking out the latest main…"
git -C "$BASE_DIR" checkout main
git -C "$BASE_DIR" reset --hard origin/main
echo "[OK] DOGGS now matches origin/main."
