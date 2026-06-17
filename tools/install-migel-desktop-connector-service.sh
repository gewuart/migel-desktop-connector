#!/bin/zsh
set -euo pipefail

LABEL="ai.migel.desktop-connector"
UID_VALUE="$(id -u)"
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
STATE_DIR="${MIGEL_DESKTOP_STATE_DIR:-$HOME/.migel/desktop-connector}"
ENV_PATH="${MIGEL_DESKTOP_ENV_PATH:-$STATE_DIR/desktop-connector.env}"
PID_PATH="${MIGEL_DESKTOP_PID_PATH:-$STATE_DIR/desktop-connector.pid}"
LOG_PATH="${MIGEL_DESKTOP_LOG_PATH:-$STATE_DIR/desktop-connector.log}"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
NODE_BIN="${NODE_BIN:-}"
COMMAND="${1:-install}"

if [[ -z "$NODE_BIN" ]]; then
  if [[ -x /opt/homebrew/opt/node@22/bin/node ]]; then
    NODE_BIN="/opt/homebrew/opt/node@22/bin/node"
  else
    NODE_BIN="$(command -v node)"
  fi
fi

if [[ ! -x "$NODE_BIN" ]]; then
  echo "找不到可执行的 node，无法安装 Migel Desktop Connector 服务。" >&2
  exit 1
fi

if [[ ! -f "$ENV_PATH" ]]; then
  echo "找不到 Desktop Connector env: $ENV_PATH" >&2
  exit 1
fi

mkdir -p "$PLIST_DIR" "$STATE_DIR"
chmod 700 "$STATE_DIR" 2>/dev/null || true

write_runner() {
  local runner_path="$STATE_DIR/run-desktop-connector.sh"
  cat > "$runner_path" <<EOF
#!/bin/zsh
set -euo pipefail

source "$ENV_PATH"
echo "\$\$" > "$PID_PATH"
exec "$NODE_BIN" "$REPO_ROOT/desktop-connector/src/main.mjs"
EOF
  chmod 700 "$runner_path"
  printf '%s\n' "$runner_path"
}

write_plist() {
  local runner_path="$1"
  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$runner_path</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_ROOT/desktop-connector</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>$LOG_PATH</string>
  <key>StandardErrorPath</key>
  <string>$LOG_PATH</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
    <key>PATH</key>
    <string>/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>NODE_USE_SYSTEM_CA</key>
    <string>1</string>
  </dict>
</dict>
</plist>
EOF
}

bootout_service() {
  launchctl bootout "gui/$UID_VALUE/$LABEL" >/dev/null 2>&1 || true
}

bootstrap_service() {
  launchctl bootstrap "gui/$UID_VALUE" "$PLIST_PATH"
  launchctl kickstart -k "gui/$UID_VALUE/$LABEL"
}

print_status() {
  launchctl print "gui/$UID_VALUE/$LABEL"
}

case "$COMMAND" in
  install|restart)
    runner_path="$(write_runner)"
    write_plist "$runner_path"
    bootout_service
    bootstrap_service
    print_status
    ;;
  uninstall)
    bootout_service
    rm -f "$PLIST_PATH"
    ;;
  status)
    print_status
    ;;
  *)
    echo "用法: $0 [install|restart|status|uninstall]" >&2
    exit 1
    ;;
esac
