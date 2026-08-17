#!/usr/bin/env bash
set -euo pipefail
BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -t 1 ]]; then RESET=$'\033[0m'; BOLD=$'\033[1m'; CYAN=$'\033[36m'; GREEN=$'\033[32m'; RED=$'\033[31m'; else RESET= BOLD= CYAN= GREEN= RED=; fi
info() { printf '%s[RUN]%s %s\n' "$CYAN" "$RESET" "$1"; }
success() { printf '%s[OK]%s %s\n' "$GREEN" "$RESET" "$1"; }
error() { printf '%s[ERROR]%s %s\n' "$RED" "$RESET" "$1" >&2; }
if [[ ! -x "$BASE_DIR/.venv/bin/python" ]]; then
  error "Virtual environment missing. Run ./install.sh first."
  exit 1
fi
printf '%sDOGGS%s  local document archive\n' "$BOLD" "$RESET"
info "Loading configuration from .env (if present)"
success "Starting web server and inbox scanner — press Ctrl+C to stop"
exec "$BASE_DIR/.venv/bin/python" "$BASE_DIR/app.py"
