#!/usr/bin/env bash
# Interactive DOGGS installer. Nothing is installed until the final confirmation.
set -euo pipefail
SCRIPT_PATH="${BASH_SOURCE:-$0}"
BASE_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
SYSTEM=""; PULL_MODEL=false; INSTALL_OLLAMA=false
REPOSITORY_URL="https://github.com/nickyreinert/doggs.git"
if [[ "${DOGGS_COLOR:-0}" == "1" && -t 1 ]]; then RESET=$'\033[0m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; BLUE=$'\033[34m'; CYAN=$'\033[36m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; else RESET= BOLD= DIM= BLUE= CYAN= GREEN= YELLOW= RED=; fi
heading() { printf '\n%s%s%s\n' "$BOLD$BLUE" "$1" "$RESET" >&2; printf '%*s\n' "${#1}" '' | tr ' ' '=' >&2; }
info() { printf '%s[INFO]%s %s\n' "$CYAN" "$RESET" "$1" >&2; }
detail() { printf '%s[DETAIL]%s %s\n' "$DIM" "$RESET" "$1" >&2; }
success() { printf '%s[OK]%s %s\n' "$GREEN" "$RESET" "$1" >&2; }
warning() { printf '%s[NOTE]%s %s\n' "$YELLOW" "$RESET" "$1" >&2; }
error() { printf '%s[ERROR]%s %s\n' "$RED" "$RESET" "$1" >&2; }
usage() { printf '%sUsage:%s %s [--system|--local]\n' "$BOLD" "$RESET" "$0"; }
ask() { local reply; printf '%s[?]%s %s %s(default: %s)%s ' "$BOLD$CYAN" "$RESET" "$1" "$DIM" "$2" "$RESET" >&2; if [[ -r /dev/tty ]]; then read -r reply </dev/tty || reply=""; else read -r reply || reply=""; fi; printf '%s' "${reply:-$2}"; }
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
install_ollama() {
  if command -v ollama >/dev/null 2>&1; then success "Ollama is available."; return; fi
  if [[ "$(uname -s)" == "Linux" ]]; then
    command -v curl >/dev/null || { error "curl is required to install Ollama."; exit 1; }
    info "Installing Ollama…"
    curl -fsSL https://ollama.com/install.sh | sh
  elif [[ "$(uname -s)" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
    info "Installing Ollama with Homebrew…"
    brew install --cask ollama
  else
    error "Ollama could not be installed automatically on this platform. Install it from https://ollama.com/download"
    exit 1
  fi
  command -v ollama >/dev/null 2>&1 || { error "Ollama installation did not provide the ollama command."; exit 1; }
  success "Ollama installed."
}
if [[ ! -f "$BASE_DIR/app.py" ]]; then
  heading "DOGGS bootstrap"
  TARGET_DIR="${DOGGS_INSTALL_DIR:-$PWD/doggs}"
  command -v curl >/dev/null || { error "curl is required for one-line installation."; exit 1; }
  command -v git >/dev/null || { error "Git is required: DOGGS installs from a proper Git checkout. Install Git, then rerun this command."; exit 1; }
  info "Cloning the latest DOGGS checkout to $TARGET_DIR…"
  git clone --depth=1 "$REPOSITORY_URL" "$TARGET_DIR"
  exec "$TARGET_DIR/install.sh" "$@"
fi
for arg in "$@"; do case "$arg" in --system) SYSTEM=true;; --local) SYSTEM=false;; -h|--help) usage; exit 0;; *) usage; exit 2;; esac; done

heading "DOGGS setup"
info "No packages have been installed yet."
if [[ -z "$SYSTEM" ]]; then if yes_no "Install as a systemd service (Ubuntu/NAS)?" "n"; then SYSTEM=true; else SYSTEM=false; fi; fi
if [[ "$SYSTEM" == true ]]; then APP_DIR="/opt/doggs"; DEFAULT_INCOMING="/opt/doggs/incoming"; DEFAULT_ARCHIVE="/opt/doggs/archive"; DEFAULT_DATA="/opt/doggs/data"; else APP_DIR="$BASE_DIR"; DEFAULT_INCOMING="./incoming"; DEFAULT_ARCHIVE="./archive"; DEFAULT_DATA="./data"; fi

CONFIGURE=true
if [[ -f "$BASE_DIR/.env" ]] && ! yes_no "A .env file already exists. Replace it with new settings?" "n"; then CONFIGURE=false; fi
if [[ "$CONFIGURE" == false ]]; then load_env; fi
if [[ "$CONFIGURE" == true ]]; then
  heading "Document storage configuration"
  INCOMING_DIR="$(ask "Incoming PDF folder" "$DEFAULT_INCOMING")"; ARCHIVE_DIR="$(ask "Archive folder" "$DEFAULT_ARCHIVE")"; DATA_DIR="$(ask "Index-data folder" "$DEFAULT_DATA")"
  ERROR_DIR="$(ask "Failed PDF folder" "${DEFAULT_DATA%/data}/errors")"; DUPLICATE_DIR="$(ask "Duplicate PDF folder" "${DEFAULT_DATA%/data}/duplicates")"
  HOST="$(ask "Listen host (127.0.0.1 for local-only)" "0.0.0.0")"; PORT="$(ask "Listen port" "8383")"; OCR_LANG="$(ask "Tesseract OCR language (e.g. deu or deu+eng)" "eng")"; OCR_LANG="${OCR_LANG//,/+}"
  if yes_no "Enable local Ollama metadata extraction?" "y"; then
    AI_MODE="ollama"; OLLAMA_URL="$(ask "Ollama URL" "http://127.0.0.1:11434")"; AI_MODEL="$(ask "Ollama model" "qwen2.5:3b")"
    if command -v ollama >/dev/null 2>&1; then
      if yes_no "Pull $AI_MODEL with Ollama after DOGGS installs?" "y"; then PULL_MODEL=true; fi
    else
      if yes_no "Ollama is missing. Install it and pull $AI_MODEL?" "y"; then INSTALL_OLLAMA=true; PULL_MODEL=true
      else warning "Ollama is not installed; DOGGS will use heuristics until it is available."; fi
    fi
  else AI_MODE="heuristic"; OLLAMA_URL="http://127.0.0.1:11434"; AI_MODEL="qwen2.5:3b"; fi
  {
    echo "# Generated by install.sh — edit and restart DOGGS to change settings."
    printf 'INCOMING_DIR=%s\nARCHIVE_DIR=%s\nDATA_DIR=%s\n' "$INCOMING_DIR" "$ARCHIVE_DIR" "$DATA_DIR"
    printf 'CSV_PATH=%s/index.csv\nERROR_DIR=%s\nDUPLICATE_DIR=%s\n' "$DATA_DIR" "$ERROR_DIR" "$DUPLICATE_DIR"
    printf 'HOST=%s\nPORT=%s\nPOLL_SECONDS=300\nRECURSIVE_SCAN=0\nOCR_LANG=%s\nOCR_DPI=200\n' "$HOST" "$PORT" "$OCR_LANG"
    printf 'AI_MODE=%s\nOLLAMA_URL=%s\nAI_MODEL=%s\nAI_TIMEOUT=60\nMAX_TEXT_CHARS=300\n' "$AI_MODE" "$OLLAMA_URL" "$AI_MODEL"
  } > "$BASE_DIR/.env"
  success "Saved configuration to $BASE_DIR/.env"
fi

heading "Installation summary"
if [[ "$SYSTEM" == true ]]; then detail "Target: /opt/doggs + doggs.service"; else detail "Target: local virtual environment"; fi
detail "Configuration: $BASE_DIR/.env"
if ! yes_no "Continue with installation?" "n"; then warning "Cancelled. Your .env configuration was saved."; exit 0; fi

command -v git >/dev/null || { error "Git is required for installation."; exit 1; }
git -C "$BASE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { error "DOGGS must be installed from a Git checkout. Use the one-line installer or clone the repository first."; exit 1; }
info "Checking out the latest origin/main…"
git -C "$BASE_DIR" fetch origin main
git -C "$BASE_DIR" checkout main
git -C "$BASE_DIR" reset --hard origin/main

if [[ "$SYSTEM" == true ]]; then
  command -v sudo >/dev/null || { error "sudo is required for system installation."; exit 1; }
  heading "Installing system service"
  sudo apt-get update; sudo apt-get install -y curl git python3 python3-venv python3-pip
  ensure_ocr_language "$OCR_LANG"
  sudo useradd -r -s /usr/sbin/nologin doggs 2>/dev/null || true; sudo mkdir -p "$APP_DIR"; sudo cp -a "$BASE_DIR/." "$APP_DIR/"; sudo chown -R doggs:doggs "$APP_DIR"; sudo rm -rf "$APP_DIR/.venv"
  sudo -u doggs python3 -m venv "$APP_DIR/.venv"; sudo -u doggs "$APP_DIR/.venv/bin/pip" install -U pip; sudo -u doggs "$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt"
  sudo cp "$APP_DIR/doggs.service" /etc/systemd/system/doggs.service; sudo systemctl daemon-reload; sudo systemctl enable --now doggs; success "Installed. Open $(open_address)"
else
  command -v python3 >/dev/null || { error "python3 is required."; exit 1; }; heading "Installing local application"; python3 -m venv "$APP_DIR/.venv"; "$APP_DIR/.venv/bin/pip" install -U pip; "$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt"
  load_env; ensure_ocr_language "$OCR_LANG"; mkdir -p "$(absolute_path "$INCOMING_DIR")" "$(absolute_path "$ARCHIVE_DIR")" "$(absolute_path "$DATA_DIR")" "$(absolute_path "$ERROR_DIR")" "$(absolute_path "$DUPLICATE_DIR")"; success "Installed. Start with ./run.sh, then open $(open_address)"
fi
if [[ "$INSTALL_OLLAMA" == true ]]; then
  heading "Installing Ollama"
  install_ollama
fi
if [[ "$PULL_MODEL" == true ]]; then
  heading "Downloading local AI model"
  ollama pull "$AI_MODEL"
fi
