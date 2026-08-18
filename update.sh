#!/usr/bin/env bash
# Update DOGGS to the latest remote main commit.
set -euo pipefail
SCRIPT_PATH="${BASH_SOURCE:-$0}"
BASE_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
REPOSITORY_URL="https://github.com/nickyreinert/doggs.git"
command -v git >/dev/null || { echo "[ERROR] Git is required for updates." >&2; exit 1; }
TARGET_DIR="$BASE_DIR"
if [[ -f /etc/systemd/system/doggs.service ]] && [[ -d /opt/doggs/.git ]]; then TARGET_DIR="/opt/doggs"; fi
git -C "$TARGET_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "[ERROR] This installation is not a Git checkout. Reinstall DOGGS with install.sh." >&2; exit 1; }
SERVICE_ACTIVE=false
restore_service() { if [[ "$SERVICE_ACTIVE" == true ]]; then sudo systemctl start doggs || true; fi; }
trap restore_service EXIT
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet doggs; then
  echo "[UPDATE] Stopping doggs.service…"
  sudo systemctl stop doggs
  SERVICE_ACTIVE=true
fi
echo "[UPDATE] Fetching origin/main…"
if [[ "$TARGET_DIR" == "/opt/doggs" ]]; then echo "[UPDATE] Updating the system-service deployment in /opt/doggs…"; sudo git -C "$TARGET_DIR" fetch origin main; else git -C "$TARGET_DIR" fetch origin main; fi
echo "[UPDATE] Checking out the latest main…"
if [[ "$TARGET_DIR" == "/opt/doggs" ]]; then sudo git -C "$TARGET_DIR" checkout main; sudo git -C "$TARGET_DIR" reset --hard origin/main; else git -C "$TARGET_DIR" checkout main; git -C "$TARGET_DIR" reset --hard origin/main; fi
if [[ "$TARGET_DIR" == "/opt/doggs" ]]; then
  SERVICE_USER="$(awk -F= '/^User=/{print $2; exit}' /etc/systemd/system/doggs.service)"
  if [[ -z "$SERVICE_USER" || "$SERVICE_USER" == "doggs" || "$SERVICE_USER" == __DOGGS_SERVICE_USER__ ]]; then SERVICE_USER="$(id -un)"; fi
  SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
  sed "s/__DOGGS_SERVICE_USER__/$SERVICE_USER/g;s/__DOGGS_SERVICE_GROUP__/$SERVICE_GROUP/g" "$TARGET_DIR/doggs.service" | sudo tee /etc/systemd/system/doggs.service >/dev/null
  sudo systemctl daemon-reload
fi
VENV_PIP="$TARGET_DIR/.venv/bin/pip"
[[ -x "$VENV_PIP" ]] || { echo "[ERROR] DOGGS virtual environment is missing. Run ./install.sh to repair this installation." >&2; exit 1; }
echo "[UPDATE] Upgrading Python dependencies…"
if [[ "$TARGET_DIR" == "/opt/doggs" ]]; then sudo -u "${SERVICE_USER:-root}" "$VENV_PIP" install --upgrade -r "$TARGET_DIR/requirements.txt"; else "$VENV_PIP" install --upgrade -r "$TARGET_DIR/requirements.txt"; fi
if [[ "$SERVICE_ACTIVE" == true ]]; then
  echo "[UPDATE] Starting doggs.service…"
  sudo systemctl start doggs
  SERVICE_ACTIVE=false
fi
echo "[OK] DOGGS now matches origin/main."
