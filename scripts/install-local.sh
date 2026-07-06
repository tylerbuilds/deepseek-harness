#!/usr/bin/env bash
set -euo pipefail
shopt -s lastpipe 2>/dev/null || true
umask 022

PROJECT="deepseek-harness"
QUIET=0
NO_BUILD=0
FORCE=0
PRINT_CONFIG=0
INSTALL_DIR="${HOME}/bin"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_DIR="${TMPDIR:-/tmp}/${PROJECT}.install.lock"
CONFIG_DIR="${HOME}/.config/deepseek-harness"
CONFIG_PATH="${CONFIG_DIR}/mcp-server.json"
CODEX_CONFIG_PATH="${CONFIG_DIR}/codex-mcp-server.toml"

usage() {
  cat <<USAGE
deepseek-harness local installer

Usage:
  bash scripts/install-local.sh [options]

Options:
  --install-dir PATH  Install launchers here (default: ${HOME}/bin)
  --no-build          Skip npm install/build
  --force             Reinstall launchers even if present
  --print-config      Print MCP config JSON after install
  --quiet             Reduce output
  -h, --help          Show this help

Installs:
  deepseek-harness      CLI launcher
  deepseek-harness-mcp  MCP stdio launcher

No secrets are written. Provide DEEPSEEK_API_KEY only in the client environment
when explicitly running approved live DeepSeek calls.
USAGE
}

info() { [ "$QUIET" -eq 1 ] || printf '\033[0;34m->\033[0m %s\n' "$*"; }
ok() { [ "$QUIET" -eq 1 ] || printf '\033[0;32mOK\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN\033[0m %s\n' "$*" >&2; }
err() { printf '\033[0;31mERR\033[0m %s\n' "$*" >&2; }

cleanup() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir)
      INSTALL_DIR="${2:?missing --install-dir value}"
      shift 2
      ;;
    --no-build)
      NO_BUILD=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --print-config)
      PRINT_CONFIG=1
      shift
      ;;
    --quiet)
      QUIET=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      err "Unknown option: $1"
      usage
      exit 2
      ;;
  esac
done

acquire_lock() {
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    err "Another deepseek-harness install appears to be running: $LOCK_DIR"
    exit 1
  fi
}

check_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Required command not found: $1"
    exit 1
  fi
}

atomic_write() {
  local target="$1"
  local tmp
  tmp="$(mktemp "${target}.tmp.XXXXXX")"
  cat > "$tmp"
  chmod 0755 "$tmp"
  mv "$tmp" "$target"
}

write_launchers() {
  mkdir -p "$INSTALL_DIR"
  if [ ! -w "$INSTALL_DIR" ]; then
    err "Install directory is not writable: $INSTALL_DIR"
    exit 1
  fi

  local cli="${INSTALL_DIR}/deepseek-harness"
  local mcp="${INSTALL_DIR}/deepseek-harness-mcp"

  if [ "$FORCE" -eq 0 ] && { [ -e "$cli" ] || [ -e "$mcp" ]; }; then
    warn "Launchers already exist. Use --force to overwrite."
  else
    atomic_write "$cli" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$REPO_ROOT"
exec node "$REPO_ROOT/dist/src/cli.js" "\$@"
EOF
    atomic_write "$mcp" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$REPO_ROOT"
exec node "$REPO_ROOT/dist/src/mcp.js"
EOF
    ok "Installed launchers in $INSTALL_DIR"
  fi
}

write_mcp_config() {
  mkdir -p "$CONFIG_DIR"
  node "$REPO_ROOT/dist/src/cli.js" mcp-config \
    --command "$INSTALL_DIR/deepseek-harness-mcp" \
    --state-dir "$REPO_ROOT/.state" \
    --artifact-dir "$REPO_ROOT/artifacts" > "$CONFIG_PATH"
  ok "Wrote MCP config snippet: $CONFIG_PATH"
  node "$REPO_ROOT/dist/src/cli.js" mcp-config \
    --format codex-toml \
    --command "$INSTALL_DIR/deepseek-harness-mcp" \
    --state-dir "$REPO_ROOT/.state" \
    --artifact-dir "$REPO_ROOT/artifacts" > "$CODEX_CONFIG_PATH"
  ok "Wrote Codex MCP config snippet: $CODEX_CONFIG_PATH"
}

main() {
  acquire_lock
  check_command node
  check_command npm

  info "Repository: $REPO_ROOT"
  info "Install dir: $INSTALL_DIR"

  cd "$REPO_ROOT"
  if [ "$NO_BUILD" -eq 0 ]; then
    info "Installing Node dependencies"
    npm ci
    info "Building TypeScript"
    npm run build
  elif [ ! -f "$REPO_ROOT/dist/src/mcp.js" ]; then
    err "--no-build requested but dist/src/mcp.js does not exist"
    exit 1
  fi

  write_launchers
  write_mcp_config

  if [ "$PRINT_CONFIG" -eq 1 ]; then
    cat "$CONFIG_PATH"
  fi

  ok "Install complete"
  info "MCP command: $INSTALL_DIR/deepseek-harness-mcp"
  info "CLI command: $INSTALL_DIR/deepseek-harness"
  info "Smoke: npm run mcp:smoke -- --command $INSTALL_DIR/deepseek-harness-mcp"
}

main
