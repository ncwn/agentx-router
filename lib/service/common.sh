# Shared service configuration and router health checks.

LABEL="com.agentx.cc-router"
UNIT="agentx-cc-router.service"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
SYSTEMD_UNIT="$SYSTEMD_USER_DIR/$UNIT"
VAR_DIR="$HERE/var"
OUT_LOG="$VAR_DIR/router.out.log"
ERR_LOG="$VAR_DIR/router.err.log"

if [ -f "$HERE/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$HERE/.env"
  set +a
fi

PORT="${AGENTX_PORT:-8787}"
NODE_BIN=""
NODE_DIR=""
SERVICE_PATH=""

die() { printf 'agentx-service: %s\n' "$*" >&2; exit 1; }

os_name() {
  case "$(uname -s)" in
    Darwin) printf 'macos' ;;
    Linux) printf 'linux' ;;
    *) die "unsupported OS: $(uname -s)" ;;
  esac
}

ensure_var_dir() { mkdir -p "$VAR_DIR"; }

capture_node_path() {
  NODE_BIN="$(command -v node || true)"
  [ -n "$NODE_BIN" ] || die "node is required but was not found in PATH"
  NODE_DIR="$(cd "$(dirname "$NODE_BIN")" && pwd)"
  SERVICE_PATH="$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

require_env() { [ -f "$HERE/.env" ] || die "missing $HERE/.env; copy .env.example to .env and fill in upstreams/keys"; }
require_agentx_up() { [ -x "$HERE/agentx-up" ] || die "$HERE/agentx-up is missing or not executable"; }

require_runtime() {
  capture_node_path
  require_env
  require_agentx_up
  ensure_var_dir
}

xml_escape() {
  node -e 'const s=process.argv[1]; process.stdout.write(s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;") + "\n")' "$1"
}

port_listening() {
  node -e 'const net=require("net"); const port=+process.argv[1]; const s=net.connect({host:"127.0.0.1",port}); s.on("connect",()=>{s.destroy();process.exit(0)}); s.on("error",()=>process.exit(1)); setTimeout(()=>process.exit(1),800)' "$PORT" >/dev/null 2>&1
}

process_command_for_pid() {
  local pid="$1"
  if [ -r "/proc/$pid/cmdline" ]; then
    tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true
  else
    ps -ww -p "$pid" -o command= 2>/dev/null || true
  fi
}

pid_is_router() {
  local process_command
  process_command="$(process_command_for_pid "$1")"
  case "$process_command" in
    *"$HERE/router.js"*) return 0 ;;
    *) return 1 ;;
  esac
}

systemd_main_pid() {
  [ "$(os_name)" = "linux" ] || return 1
  command -v systemctl >/dev/null 2>&1 || return 1
  local pid
  pid="$(systemctl --user show --property=MainPID --value "$UNIT" 2>/dev/null || true)"
  case "$pid" in
    ''|0|*[!0-9]*) return 1 ;;
    *) printf '%s\n' "$pid" ;;
  esac
}

router_listener_pid() {
  local pid saw_listener=0
  if command -v lsof >/dev/null 2>&1; then
    while IFS= read -r pid; do
      [ -n "$pid" ] || continue
      saw_listener=1
      if pid_is_router "$pid"; then
        printf '%s\n' "$pid"
        return 0
      fi
    done < <(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u)
    [ "$saw_listener" -eq 0 ] || return 3
    port_listening && return 2
    return 1
  fi

  if [ "$(os_name)" = "linux" ]; then
    pid="$(systemd_main_pid || true)"
    if [ -n "$pid" ] && pid_is_router "$pid" && port_listening; then
      printf '%s\n' "$pid"
      return 0
    fi
  fi
  port_listening && return 2
  return 1
}

router_listening() { router_listener_pid >/dev/null; }

socket_status() {
  local pid status
  if pid="$(router_listener_pid)"; then
    printf 'router port: agentx router listening on 127.0.0.1:%s (pid %s)\n' "$PORT" "$pid"
    return 0
  else
    status=$?
  fi
  case "$status" in
    1) printf 'router port: not listening on 127.0.0.1:%s\n' "$PORT" ;;
    2) printf 'router port: listening on 127.0.0.1:%s, but router identity could not be verified\n' "$PORT" ;;
    3) printf 'router port: occupied on 127.0.0.1:%s by a non-agentx process\n' "$PORT" ;;
    *) printf 'router port: unable to determine router identity on 127.0.0.1:%s\n' "$PORT" ;;
  esac
  return 1
}

wait_for_router() {
  local seconds="${1:-10}" attempt
  for ((attempt=0; attempt<seconds; attempt++)); do
    router_listening && return 0
    sleep 1
  done
  return 1
}
