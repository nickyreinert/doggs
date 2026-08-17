#!/usr/bin/env bash
# Update DOGGS while preserving its configuration, documents, and index.
set -euo pipefail
SCRIPT_PATH="${BASH_SOURCE:-$0}"
BASE_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
ARCHIVE_URL="https://github.com/nickyreinert/doggs/archive/refs/heads/main.tar.gz"
[[ -f "$BASE_DIR/app.py" ]] || { echo "[ERROR] Run this from an installed DOGGS folder." >&2; exit 1; }
command -v curl >/dev/null || { echo "[ERROR] curl is required." >&2; exit 1; }
TMP_DIR="$(mktemp -d)"; trap 'rm -rf "$TMP_DIR"' EXIT
echo "[UPDATE] Downloading latest DOGGS…"
curl -fsSL "${ARCHIVE_URL}?cache_bust=$(date +%s)" | tar -xz -C "$TMP_DIR" --strip-components=1
echo "[UPDATE] Applying code update; preserving .env and runtime folders…"
tar -C "$TMP_DIR" --exclude='.env' --exclude='.venv' --exclude='.git' --exclude='incoming' --exclude='archive' --exclude='data' --exclude='duplicates' --exclude='errors' -cf - . | tar -C "$BASE_DIR" -xf -
chmod +x "$BASE_DIR/install.sh" "$BASE_DIR/run.sh" "$BASE_DIR/updates.sh"
if [[ ! -x "$BASE_DIR/.venv/bin/pip" ]]; then
  echo "[UPDATE] Virtual environment is missing; continuing with installation…"
  if [[ "$BASE_DIR" == "/opt/doggs" ]]; then exec "$BASE_DIR/install.sh" --system; else exec "$BASE_DIR/install.sh" --local; fi
fi
"$BASE_DIR/.venv/bin/pip" install -r "$BASE_DIR/requirements.txt"
if [[ "$BASE_DIR" == "/opt/doggs" ]] && command -v systemctl >/dev/null; then sudo systemctl restart doggs; fi
echo "[OK] DOGGS is up to date."
