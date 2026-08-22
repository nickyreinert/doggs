#!/usr/bin/env bash
# DOGGS installer. Uses sensible defaults for everything — folders, OCR language, and AI
# mode can all be changed later from the app's Settings dialog, so this only asks the one
# question that can't be changed afterward (systemd service vs. local run).
set -euo pipefail
SCRIPT_PATH="${BASH_SOURCE:-$0}"
BASE_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
SYSTEM=""
REPOSITORY_URL="https://github.com/nickyreinert/doggs.git"
if [[ "${DOGGS_COLOR:-0}" == "1" && -t 1 ]]; then RESET=$'\033[0m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; BLUE=$'\033[34m'; CYAN=$'\033[36m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; else RESET= BOLD= DIM= BLUE= CYAN= GREEN= YELLOW= RED=; fi
heading() { printf '\n%s%s%s\n' "$BOLD$BLUE" "$1" "$RESET" >&2; }
info() { printf '%s[INFO]%s %s\n' "$CYAN" "$RESET" "$1" >&2; }
success() { printf '%s[OK]%s %s\n' "$GREEN" "$RESET" "$1" >&2; }
warning() { printf '%s[NOTE]%s %s\n' "$YELLOW" "$RESET" "$1" >&2; }
error() { printf '%s[ERROR]%s %s\n' "$RED" "$RESET" "$1" >&2; }
usage() { printf '%sUsage:%s %s [--system|--local]\n' "$BOLD" "$RESET" "$0"; }
yes_no() { local reply; printf '%s[?]%s %s %s(default: %s)%s ' "$BOLD$CYAN" "$RESET" "$1" "$DIM" "$2" "$RESET" >&2; if [[ -r /dev/tty ]]; then read -r reply </dev/tty || reply=""; else read -r reply || reply=""; fi; reply="${reply:-$2}"; [[ "$reply" =~ ^[Yy]([Ee][Ss])?$ ]]; }
load_env() {
  local key value
  while IFS='=' read -r key value; do
    case "$key" in INCOMING_DIR|ARCHIVE_DIR|DATA_DIR|CSV_PATH|ERROR_DIR|DUPLICATE_DIR|HOST|PORT|OCR_LANG|AI_MODE|OLLAMA_URL|AI_MODEL) printf -v "$key" '%s' "$value";; esac
  done < "$BASE_DIR/.env"
}
absolute_path() { [[ "$1" = /* ]] && printf '%s' "$1" || printf '%s/%s' "$BASE_DIR" "$1"; }
open_address() {
  local host="${HOST:-0.0.0.0}" port="${PORT:-8383}" lan=""
  if [[ "$host" != "0.0.0.0" && "$host" != "::" ]]; then printf 'http://%s:%s' "$host" "$port"; return; fi
  if command -v hostname >/dev/null 2>&1; then lan="$(hostname -I 2>/dev/null | awk '{print $1}')" || true; fi
  if [[ -z "$lan" && "$(uname -s)" == "Darwin" ]] && command -v ipconfig >/dev/null 2>&1; then lan="$(ipconfig getifaddr en0 2>/dev/null || true)"; fi
  if [[ -n "$lan" ]]; then printf 'http://%s:%s (or http://localhost:%s)' "$lan" "$port" "$port"; else printf 'http://localhost:%s (from another device, use its LAN IP)' "$port"; fi
}
ocr_language_installed() { command -v tesseract >/dev/null 2>&1 && tesseract --list-langs 2>/dev/null | tail -n +2 | grep -Fxq "$1"; }
ensure_ocr_language() {
  local requested="$1" language package_list=() missing=()
  requested="${requested//,/+}"
  IFS='+' read -r -a languages <<< "$requested"
  for language in "${languages[@]}"; do
    [[ -n "$language" ]] || continue
    if ! ocr_language_installed "$language"; then missing+=("$language"); package_list+=("tesseract-ocr-$language"); fi
  done
  if [[ ${#missing[@]} -eq 0 ]]; then success "Tesseract language(s) '$requested' are available."; return; fi
  if command -v brew >/dev/null 2>&1; then
    info "Installing Tesseract and language data with Homebrew..."
    brew install tesseract tesseract-lang
  elif command -v apt-get >/dev/null 2>&1; then
    command -v sudo >/dev/null || { error "sudo is required to install Tesseract OCR."; exit 1; }
    info "Installing Tesseract language(s): ${missing[*]}..."
    sudo apt-get update
    sudo apt-get install -y tesseract-ocr "${package_list[@]}"
  else
    error "Tesseract language(s) '${missing[*]}' are missing, and no supported package manager was found. Install Tesseract plus its language data, then rerun this installer."
    exit 1
  fi
  for language in "${missing[@]}"; do ocr_language_installed "$language" || { error "Tesseract language '$language' could not be verified after installation."; exit 1; }; done
  success "Tesseract language(s) '$requested' are available."
}
if [[ ! -f "$BASE_DIR/app.py" ]]; then
  heading "DOGGS bootstrap"
  TARGET_DIR="${DOGGS_INSTALL_DIR:-$PWD/doggs}"
  command -v curl >/dev/null || { error "curl is required for one-line installation."; exit 1; }
  command -v git >/dev/null || { error "Git is required: DOGGS installs from a proper Git checkout. Install Git, then rerun this command."; exit 1; }
  info "Cloning DOGGS to $TARGET_DIR…"
  git clone --depth=1 "$REPOSITORY_URL" "$TARGET_DIR"
  exec "$TARGET_DIR/install.sh" "$@"
fi
for arg in "$@"; do case "$arg" in --system) SYSTEM=true;; --local) SYSTEM=false;; -h|--help) usage; exit 0;; *) usage; exit 2;; esac; done

heading "DOGGS setup"
if [[ -z "$SYSTEM" ]]; then if yes_no "Install as a systemd background service (recommended for a NAS/server)?" "y"; then SYSTEM=true; else SYSTEM=false; fi; fi
if [[ "$SYSTEM" == true ]]; then APP_DIR="/opt/doggs"; DEFAULT_INCOMING="/opt/doggs/incoming"; DEFAULT_ARCHIVE="/opt/doggs/archive"; DEFAULT_DATA="/opt/doggs/data"; else APP_DIR="$BASE_DIR"; DEFAULT_INCOMING="./incoming"; DEFAULT_ARCHIVE="./archive"; DEFAULT_DATA="./data"; fi
SERVICE_USER="$(id -un)"; SERVICE_GROUP="$(id -gn)"

if [[ ! -f "$BASE_DIR/.env" ]]; then
  info "Writing default configuration — change folders, OCR language, and AI mode anytime in Settings."
  AI_MODE="heuristic"; command -v ollama >/dev/null 2>&1 && AI_MODE="ollama"
  {
    echo "# Generated by install.sh — override any of this later via the app's Settings dialog, or by editing this file."
    printf 'INCOMING_DIR=%s\nARCHIVE_DIR=%s\nDATA_DIR=%s\n' "$DEFAULT_INCOMING" "$DEFAULT_ARCHIVE" "$DEFAULT_DATA"
    printf 'CSV_PATH=%s/index.csv\nERROR_DIR=%s/errors\nDUPLICATE_DIR=%s/duplicates\n' "$DEFAULT_DATA" "${DEFAULT_DATA%/data}" "${DEFAULT_DATA%/data}"
    printf 'HOST=0.0.0.0\nPORT=8383\nPOLL_SECONDS=300\nRECURSIVE_SCAN=0\nOCR_LANG=eng\nOCR_DPI=200\n'
    printf 'AI_MODE=%s\nOLLAMA_URL=http://127.0.0.1:11434\nAI_MODEL=qwen2.5:3b\nAI_TIMEOUT=60\nMAX_TEXT_CHARS=300\n' "$AI_MODE"
  } > "$BASE_DIR/.env"
else
  info "Keeping existing $BASE_DIR/.env."
fi
load_env

command -v git >/dev/null || { error "Git is required for installation."; exit 1; }
git -C "$BASE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { error "DOGGS must be installed from a Git checkout. Use the one-line installer or clone the repository first."; exit 1; }
info "Checking out the latest origin/main…"
git -C "$BASE_DIR" fetch origin main
git -C "$BASE_DIR" checkout main
git -C "$BASE_DIR" reset --hard origin/main

if [[ "$SYSTEM" == true ]]; then
  command -v sudo >/dev/null || { error "sudo is required for system installation."; exit 1; }
  heading "Installing as a background service"
  info "Installing system packages…"
  sudo apt-get update -qq; sudo apt-get install -qq -y curl git python3 python3-venv python3-pip >/dev/null
  ensure_ocr_language "$OCR_LANG"
  sudo mkdir -p "$APP_DIR"; sudo cp -a "$BASE_DIR/." "$APP_DIR/"; sudo chown -R "$SERVICE_USER:$SERVICE_GROUP" "$APP_DIR"
  info "Setting up the Python environment…"
  [[ -d "$APP_DIR/.venv" ]] || sudo -u "$SERVICE_USER" python3 -m venv "$APP_DIR/.venv"
  sudo -u "$SERVICE_USER" "$APP_DIR/.venv/bin/pip" install -q -U pip; sudo -u "$SERVICE_USER" "$APP_DIR/.venv/bin/pip" install -q -U -r "$APP_DIR/requirements.txt"
  sed "s/__DOGGS_SERVICE_USER__/$SERVICE_USER/g;s/__DOGGS_SERVICE_GROUP__/$SERVICE_GROUP/g" "$APP_DIR/doggs.service" | sudo tee /etc/systemd/system/doggs.service >/dev/null; sudo systemctl daemon-reload; sudo systemctl enable doggs; sudo systemctl restart doggs
  if sudo systemctl is-active --quiet doggs; then success "Running as doggs.service. Open $(open_address) — adjust folders, OCR language, and AI mode anytime in Settings."; else error "doggs.service did not start. Run: sudo systemctl status doggs --no-pager"; exit 1; fi
else
  command -v python3 >/dev/null || { error "python3 is required."; exit 1; }
  heading "Installing locally"
  ensure_ocr_language "$OCR_LANG"
  [[ -d "$APP_DIR/.venv" ]] || python3 -m venv "$APP_DIR/.venv"
  info "Setting up the Python environment…"
  "$APP_DIR/.venv/bin/pip" install -q -U pip; "$APP_DIR/.venv/bin/pip" install -q -U -r "$APP_DIR/requirements.txt"
  mkdir -p "$(absolute_path "$INCOMING_DIR")" "$(absolute_path "$ARCHIVE_DIR")" "$(absolute_path "$DATA_DIR")" "$(absolute_path "$ERROR_DIR")" "$(absolute_path "$DUPLICATE_DIR")"
  success "Installed. Start with ./run.sh, then open $(open_address) — adjust folders, OCR language, and AI mode anytime in Settings."
fi
