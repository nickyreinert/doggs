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
command -v git >/dev/null || { echo "[ERROR] Git is required for updates." >&2; exit 1; }
git -C "$BASE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "[ERROR] This installation is not a Git checkout. Reinstall DOGGS with install.sh." >&2; exit 1; }

# $BASE_DIR (where this script lives) is the only place that ever gets git/pip/Tabler updates.
# /opt/doggs — if install.sh set up a systemd service — is a deployment COPY of $BASE_DIR, kept
# in sync by copying below; it is never git- or pip-operated on directly.
SYSTEM=false
if [[ -f /etc/systemd/system/doggs.service ]] && [[ -d /opt/doggs ]] && [[ "$BASE_DIR" != "/opt/doggs" ]]; then SYSTEM=true; fi

SERVICE_ACTIVE=false
restore_service() { if [[ "$SERVICE_ACTIVE" == true ]]; then sudo systemctl start doggs || true; fi; }
trap restore_service EXIT
if [[ "$SYSTEM" == true ]] && command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet doggs; then
  if [[ -t 0 ]] || sudo -n true 2>/dev/null; then
    echo "[UPDATE] Stopping doggs.service…"
    sudo systemctl stop doggs
    SERVICE_ACTIVE=true
  else
    echo "[NOTE] doggs.service is active but sudo would need an interactive password here; skipping the stop/restart. Files still update below — run this from a real terminal (not a non-interactive script) to also restart the service automatically, or restart it yourself afterwards." >&2
  fi
fi

echo "[UPDATE] Fetching origin/main into $BASE_DIR…"
git -C "$BASE_DIR" fetch origin main
echo "[UPDATE] Checking out the latest main…"
git -C "$BASE_DIR" checkout main
git -C "$BASE_DIR" reset --hard origin/main

echo "[UPDATE] Refreshing Tabler CSS (optional 'Tabler' layout) in $BASE_DIR…"
TABLER_VERSION="1.4.0"
TABLER_DIR="$BASE_DIR/static/vendor/tabler/css"; TABLER_FILE="$TABLER_DIR/tabler.min.css"
TABLER_URL="https://cdn.jsdelivr.net/npm/@tabler/core@${TABLER_VERSION}/dist/css/tabler.min.css"
mkdir -p "$TABLER_DIR"
if command -v curl >/dev/null 2>&1; then
  if curl -fsSL "$TABLER_URL" -o "$TABLER_FILE.tmp"; then
    mv "$TABLER_FILE.tmp" "$TABLER_FILE"
    echo "[OK] Fetched Tabler CSS v$TABLER_VERSION."
  else
    rm -f "$TABLER_FILE.tmp"
    echo "[NOTE] Could not download Tabler CSS (offline?). The 'Tabler' layout option will look unstyled until this succeeds." >&2
  fi
fi

echo "[UPDATE] Upgrading Python dependencies in $BASE_DIR…"
VENV_PIP="$BASE_DIR/.venv/bin/pip"
if [[ "$SYSTEM" == false ]]; then
  [[ -x "$VENV_PIP" ]] || { echo "[ERROR] DOGGS virtual environment is missing in $BASE_DIR. Run ./install.sh to repair this installation." >&2; exit 1; }
  "$VENV_PIP" install --upgrade -r "$BASE_DIR/requirements.txt"
else
  echo "[UPDATE] Skipping — $BASE_DIR is only the checkout, not a running instance. Dependencies are upgraded in /opt/doggs below."
fi

if [[ "$SYSTEM" == true ]]; then
  command -v rsync >/dev/null || { echo "[ERROR] rsync is required to deploy to /opt/doggs. Install it (e.g. apt-get install rsync) and rerun." >&2; exit 1; }
  echo "[UPDATE] Deploying $BASE_DIR -> /opt/doggs…"
  SERVICE_USER="$(awk -F= '/^User=/{print $2; exit}' /etc/systemd/system/doggs.service)"
  if [[ -z "$SERVICE_USER" || "$SERVICE_USER" == __DOGGS_SERVICE_USER__ ]]; then SERVICE_USER="$(id -un)"; fi
  SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
  # Additive copy only (no --delete): never touches /opt/doggs' own data/incoming/archive/etc.
  # .git and .venv are excluded — /opt/doggs keeps its own virtualenv, updated via pip below.
  sudo rsync -a --exclude ".git" --exclude ".venv" "$BASE_DIR/" /opt/doggs/
  sudo chown -R "$SERVICE_USER:$SERVICE_GROUP" /opt/doggs
  sed "s/__DOGGS_SERVICE_USER__/$SERVICE_USER/g;s/__DOGGS_SERVICE_GROUP__/$SERVICE_GROUP/g" /opt/doggs/doggs.service | sudo tee /etc/systemd/system/doggs.service >/dev/null
  sudo systemctl daemon-reload
  OPT_VENV_PIP="/opt/doggs/.venv/bin/pip"
  [[ -x "$OPT_VENV_PIP" ]] || { echo "[ERROR] /opt/doggs virtual environment is missing. Run ./install.sh to repair this installation." >&2; exit 1; }
  echo "[UPDATE] Upgrading Python dependencies in /opt/doggs…"
  sudo -u "$SERVICE_USER" "$OPT_VENV_PIP" install --upgrade -r /opt/doggs/requirements.txt
fi

if [[ "$SERVICE_ACTIVE" == true ]]; then
  echo "[UPDATE] Starting doggs.service…"
  sudo systemctl start doggs
  SERVICE_ACTIVE=false
fi
echo "[OK] DOGGS now matches origin/main."
}
exit 0
