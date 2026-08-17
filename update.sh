#!/usr/bin/env bash
# Update DOGGS to the latest remote main commit.
set -euo pipefail
SCRIPT_PATH="${BASH_SOURCE:-$0}"
BASE_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
REPOSITORY_URL="https://github.com/nickyreinert/doggs.git"
command -v git >/dev/null || { echo "[ERROR] Git is required for updates." >&2; exit 1; }
git -C "$BASE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "[ERROR] This installation is not a Git checkout. Reinstall DOGGS with install.sh." >&2; exit 1; }
SERVICE_ACTIVE=false
restore_service() { if [[ "$SERVICE_ACTIVE" == true ]]; then sudo systemctl start doggs || true; fi; }
trap restore_service EXIT
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet doggs; then
  echo "[UPDATE] Stopping doggs.service…"
  sudo systemctl stop doggs
  SERVICE_ACTIVE=true
fi
echo "[UPDATE] Fetching origin/main…"
git -C "$BASE_DIR" fetch origin main
echo "[UPDATE] Checking out the latest main…"
git -C "$BASE_DIR" checkout main
git -C "$BASE_DIR" reset --hard origin/main
"$BASE_DIR/.venv/bin/pip" install -r "$BASE_DIR/requirements.txt"
if [[ "$SERVICE_ACTIVE" == true ]]; then
  echo "[UPDATE] Starting doggs.service…"
  sudo systemctl start doggs
  SERVICE_ACTIVE=false
fi
echo "[OK] DOGGS now matches origin/main."
