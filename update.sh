#!/usr/bin/env bash
# Update DOGGS from its Git repository while preserving configuration and data.
set -euo pipefail
SCRIPT_PATH="${BASH_SOURCE:-$0}"
BASE_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
REPOSITORY_URL="https://github.com/nickyreinert/doggs.git"
[[ -f "$BASE_DIR/app.py" ]] || { echo "[ERROR] Run this from an installed DOGGS folder." >&2; exit 1; }
command -v git >/dev/null || { echo "[ERROR] Git is required for updates. Install it, then rerun this command." >&2; exit 1; }
if ! git -C "$BASE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[UPDATE] Creating a shallow Git checkout…"
  git -C "$BASE_DIR" init -b main
  git -C "$BASE_DIR" remote add origin "$REPOSITORY_URL"
  git -C "$BASE_DIR" fetch --depth=1 origin main
  git -C "$BASE_DIR" reset --hard origin/main
else
  echo "[UPDATE] Pulling the latest DOGGS code…"
  git -C "$BASE_DIR" pull --ff-only origin main
fi
chmod +x "$BASE_DIR/install.sh" "$BASE_DIR/run.sh" "$BASE_DIR/update.sh"
if [[ ! -x "$BASE_DIR/.venv/bin/pip" ]]; then
  echo "[UPDATE] Virtual environment is missing; continuing with installation…"
  if [[ "$BASE_DIR" == "/opt/doggs" ]]; then exec "$BASE_DIR/install.sh" --system; else exec "$BASE_DIR/install.sh" --local; fi
fi
"$BASE_DIR/.venv/bin/pip" install -r "$BASE_DIR/requirements.txt"
if [[ "$BASE_DIR" == "/opt/doggs" ]] && command -v systemctl >/dev/null; then sudo systemctl restart doggs; fi
echo "[OK] DOGGS is up to date."
