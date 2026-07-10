# Linux systemd user-service implementation.

validate_linux_repo_path() {
  case "$HERE" in
    *' '*|*%*) die "Linux service path may not contain spaces or %: $HERE" ;;
  esac
}

systemd_user_require_bus() {
  command -v systemctl >/dev/null 2>&1 || die "systemctl is required on Linux"
  systemctl --user show-environment >/dev/null 2>&1 || die "systemd --user bus is unreachable; start a login session or enable linger for $USER"
}

systemd_user() {
  command -v systemctl >/dev/null 2>&1 || die "systemctl is required on Linux"
  systemctl --user "$@"
}

linux_require_installed() { [ -f "$SYSTEMD_UNIT" ] || die "service not installed; run ./agentx-service install first"; }

write_systemd_unit() {
  validate_linux_repo_path
  ensure_var_dir
  mkdir -p "$SYSTEMD_USER_DIR"
  cat > "$SYSTEMD_UNIT" <<EOF
[Unit]
Description=agentx-cc-router local Claude Code router
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=$HERE
ExecStart=$HERE/agentx-up
Environment=PATH=$SERVICE_PATH
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
}

linux_wait_or_die() {
  wait_for_router 10 && return 0
  journalctl --user -u "$UNIT" -n 50 --no-pager 2>/dev/null || true
  socket_status || true
  die "router did not begin listening on 127.0.0.1:$PORT"
}

linux_maybe_print_linger_hint() {
  if command -v loginctl >/dev/null 2>&1 && [ "$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null || true)" != "yes" ]; then
    printf 'hint: run loginctl enable-linger %s to keep the service alive after logout and on headless hosts\n' "$USER"
  fi
}

linux_install() {
  require_runtime; systemd_user_require_bus; write_systemd_unit
  systemd_user daemon-reload
  systemd_user enable --now "$UNIT"
  linux_wait_or_die; linux_maybe_print_linger_hint; linux_status
}

linux_start() {
  require_runtime; systemd_user_require_bus; linux_require_installed
  systemd_user start "$UNIT"
  linux_wait_or_die; linux_status
}

linux_stop() {
  systemd_user stop "$UNIT" >/dev/null 2>&1 || true
  socket_status || true
}

linux_restart() {
  require_runtime; systemd_user_require_bus; linux_require_installed
  systemd_user daemon-reload
  systemd_user restart "$UNIT"
  linux_wait_or_die; linux_status
}

linux_update() {
  require_runtime; systemd_user_require_bus; linux_require_installed; write_systemd_unit
  systemd_user daemon-reload
  systemd_user restart "$UNIT"
  linux_wait_or_die; linux_status
}

linux_uninstall() {
  systemd_user disable --now "$UNIT" >/dev/null 2>&1 || true
  systemd_user reset-failed "$UNIT" >/dev/null 2>&1 || true
  rm -f "$SYSTEMD_UNIT"
  systemd_user daemon-reload >/dev/null 2>&1 || true
  printf 'removed %s\n' "$SYSTEMD_UNIT"
  socket_status || true
}

linux_status() {
  systemd_user status "$UNIT" --no-pager || true
  socket_status
}

linux_logs() { journalctl --user -u "$UNIT" -n 100 -f; }
