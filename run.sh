#!/usr/bin/env bash
set -euo pipefail
BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE="doggs"
if [[ -t 1 ]]; then RESET=$'\033[0m'; BOLD=$'\033[1m'; CYAN=$'\033[36m'; GREEN=$'\033[32m'; RED=$'\033[31m'; else RESET= BOLD= CYAN= GREEN= RED=; fi
info() { printf '%s[RUN]%s %s\n' "$CYAN" "$RESET" "$1"; }
success() { printf '%s[OK]%s %s\n' "$GREEN" "$RESET" "$1"; }
error() { printf '%s[ERROR]%s %s\n' "$RED" "$RESET" "$1" >&2; }

usage() {
  cat <<EOF
${BOLD}DOGGS${RESET}  local document archive

Usage: ./run.sh [command]

Commands:
  run, foreground   Run in the foreground; Ctrl+C stops it (default)
  start             Start the systemd service ($SERVICE.service)
  stop              Stop the systemd service
  restart           Restart the systemd service
  status            Show the systemd service status
  logs              Follow the service logs (journalctl)
  help, -h, --help  Show this help

start, stop, restart and logs use systemd and need sudo (except logs on
some setups). They require the service to be installed (see install.sh).
EOF
}

require_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    error "systemctl not found; use './run.sh run' to run in the foreground."
    exit 1
  fi
  if ! systemctl cat "$SERVICE.service" >/dev/null 2>&1; then
    error "$SERVICE.service is not installed. Run ./install.sh or use './run.sh run'."
    exit 1
  fi
}

sctl() {
  if [[ $EUID -eq 0 ]]; then systemctl "$@"; else sudo systemctl "$@"; fi
}

run_foreground() {
  if [[ ! -x "$BASE_DIR/.venv/bin/python" ]]; then
    error "Virtual environment missing. Run ./install.sh first."
    exit 1
  fi
  printf '%sDOGGS%s  local document archive\n' "$BOLD" "$RESET"
  info "Loading configuration from .env (if present)"
  success "Starting web server and inbox scanner — press Ctrl+C to stop"
  exec "$BASE_DIR/.venv/bin/python" "$BASE_DIR/app.py"
}

case "${1:-run}" in
  run|foreground) run_foreground ;;
  start)   require_service; info "Starting $SERVICE"; sctl start "$SERVICE"; success "Started" ;;
  stop)    require_service; info "Stopping $SERVICE"; sctl stop "$SERVICE"; success "Stopped" ;;
  restart) require_service; info "Restarting $SERVICE"; sctl restart "$SERVICE"; success "Restarted" ;;
  status)  require_service; systemctl status "$SERVICE" --no-pager || true ;;
  logs)    require_service; exec journalctl -u "$SERVICE" -f ;;
  help|-h|--help) usage ;;
  *) error "Unknown command: $1"; usage >&2; exit 2 ;;
esac
