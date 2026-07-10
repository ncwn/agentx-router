# macOS LaunchAgent implementation.

mac_domain() { printf 'gui/%s' "$(id -u)"; }

mac_require_gui_domain() {
  launchctl print "$(mac_domain)" >/dev/null 2>&1 || die "macOS LaunchAgent user domain unavailable; install/start/restart require a desktop session"
}

mac_require_installed() { [ -f "$PLIST" ] || die "service not installed; run ./agentx-service install first"; }

write_macos_plist() {
  ensure_var_dir
  mkdir -p "$HOME/Library/LaunchAgents"
  local program workdir stdout stderr service_path
  program="$(xml_escape "$HERE/agentx-up")"
  workdir="$(xml_escape "$HERE")"
  stdout="$(xml_escape "$OUT_LOG")"
  stderr="$(xml_escape "$ERR_LOG")"
  service_path="$(xml_escape "$SERVICE_PATH")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$program</string></array>
  <key>WorkingDirectory</key><string>$workdir</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$service_path</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$stdout</string>
  <key>StandardErrorPath</key><string>$stderr</string>
</dict>
</plist>
EOF
}

mac_bootstrap() {
  local attempt
  launchctl bootout "$(mac_domain)" "$PLIST" >/dev/null 2>&1 || true
  for attempt in 1 2 3 4 5; do
    if launchctl bootstrap "$(mac_domain)" "$PLIST" >/dev/null 2>&1; then
      launchctl enable "$(mac_domain)/$LABEL" >/dev/null 2>&1 || true
      return 0
    fi
    sleep 1
  done
  die "launchctl bootstrap failed for $PLIST"
}

mac_wait_or_die() {
  wait_for_router 10 && return 0
  tail -n 50 "$ERR_LOG" 2>/dev/null || true
  socket_status || true
  die "router did not begin listening on 127.0.0.1:$PORT"
}

mac_install() {
  require_runtime; mac_require_gui_domain; write_macos_plist; mac_bootstrap
  launchctl kickstart -k "$(mac_domain)/$LABEL" >/dev/null 2>&1 || true
  mac_wait_or_die; mac_status
}

mac_start() {
  require_runtime; mac_require_gui_domain; mac_require_installed; mac_bootstrap
  launchctl kickstart -k "$(mac_domain)/$LABEL"
  mac_wait_or_die; mac_status
}

mac_stop() {
  if [ -f "$PLIST" ]; then
    launchctl bootout "$(mac_domain)" "$PLIST" >/dev/null 2>&1 || true
  else
    printf 'launchd service: not installed (%s)\n' "$LABEL"
  fi
  socket_status || true
}

mac_restart() {
  require_runtime; mac_require_gui_domain; mac_require_installed; write_macos_plist; mac_bootstrap
  launchctl kickstart -k "$(mac_domain)/$LABEL"
  mac_wait_or_die; mac_status
}

mac_update() { mac_restart; }

mac_uninstall() {
  if [ -f "$PLIST" ]; then
    launchctl bootout "$(mac_domain)" "$PLIST" >/dev/null 2>&1 || true
    rm -f "$PLIST"
    printf 'removed %s\n' "$PLIST"
  else
    printf 'launchd plist already absent: %s\n' "$PLIST"
  fi
  socket_status || true
}

mac_status() {
  launchctl print "$(mac_domain)/$LABEL" 2>/dev/null || printf 'launchd service: not loaded (%s)\n' "$LABEL"
  socket_status
}

mac_logs() {
  ensure_var_dir
  touch "$OUT_LOG" "$ERR_LOG"
  printf '==> %s\n==> %s\n' "$OUT_LOG" "$ERR_LOG"
  tail -n 100 -f "$OUT_LOG" "$ERR_LOG"
}
