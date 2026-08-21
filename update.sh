#!/usr/bin/env bash
# Update DOGGS to the latest remote main commit.
set -euo pipefail
# Wrapping the whole script in `{ ... }` forces bash to fully parse this compound command
# (up to the matching closing brace) before running anything inside it. That protects us
# from this script's own `git reset --hard` overwriting the very file bash is reading
# mid-execution — a real hazard on self-updating scripts (some commands could otherwise
# silently never run). See the closing `}` + `exit` at the bottom of this file.
{
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
  if [[ -t 0 ]] || sudo -n true 2>/dev/null; then
    echo "[UPDATE] Stopping doggs.service…"
    sudo systemctl stop doggs
    SERVICE_ACTIVE=true
  else
    echo "[NOTE] doggs.service is active but sudo would need an interactive password here; skipping the stop/restart. Files still update below — run this from a real terminal (not a non-interactive script) to also restart the service automatically, or restart it yourself afterwards." >&2
  fi
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

TABLER_VERSION="1.4.0"
echo "[UPDATE] Refreshing Tabler CSS (optional 'Tabler' layout) in $BASE_DIR…"
BASE_TABLER_DIR="$BASE_DIR/static/vendor/tabler/css"; BASE_TABLER_FILE="$BASE_TABLER_DIR/tabler.min.css"
TABLER_URL="https://cdn.jsdelivr.net/npm/@tabler/core@${TABLER_VERSION}/dist/css/tabler.min.css"
mkdir -p "$BASE_TABLER_DIR"
if command -v curl >/dev/null 2>&1; then
  if curl -fsSL "$TABLER_URL" -o "$BASE_TABLER_FILE.tmp"; then
    mv "$BASE_TABLER_FILE.tmp" "$BASE_TABLER_FILE"
    echo "[OK] Fetched Tabler CSS v$TABLER_VERSION into $BASE_DIR."
  else
    rm -f "$BASE_TABLER_FILE.tmp"
    echo "[NOTE] Could not download Tabler CSS (offline?). The 'Tabler' layout option will look unstyled until this succeeds." >&2
  fi
fi

if [[ "$SERVICE_ACTIVE" == true ]]; then
  echo "[UPDATE] Starting doggs.service…"
  sudo systemctl start doggs
  SERVICE_ACTIVE=false
fi
echo "[OK] DOGGS now matches origin/main."
}
exit 0
