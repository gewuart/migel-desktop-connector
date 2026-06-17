#!/bin/zsh
set -euo pipefail

LABEL="ai.migel.hermes-bridge"
UID_VALUE="$(id -u)"
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$HOME/.hermes/logs"
NODE_BIN="${NODE_BIN:-}"
COMMAND="${1:-install}"

if [[ -z "$NODE_BIN" ]]; then
  if [[ -x /opt/homebrew/opt/node@22/bin/node ]]; then
    NODE_BIN="/opt/homebrew/opt/node@22/bin/node"
  elif command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
  else
    NODE_BIN=""
  fi
fi

if [[ ! -x "$NODE_BIN" ]]; then
  echo "找不到可执行的 node，无法安装 bridge 服务。" >&2
  exit 1
fi

mkdir -p "$PLIST_DIR" "$LOG_DIR"

detect_advertised_host() {
  # CLAWPOST_* fallback keeps existing local launchd overrides working after the migel rename.
  if [[ -n "${HERMES_BRIDGE_ADVERTISED_HOST:-${CLAWPOST_ADVERTISED_HOST:-}}" ]]; then
    printf '%s\n' "${HERMES_BRIDGE_ADVERTISED_HOST:-$CLAWPOST_ADVERTISED_HOST}"
    return
  fi

  if [[ -n "${MIGEL_PUBLIC_HOST:-}" ]]; then
    printf '%s\n' "$MIGEL_PUBLIC_HOST"
    return
  fi

  if [[ -n "${MIGEL_PUBLIC_DOMAIN:-}" && -n "${MIGEL_SUBDOMAIN_ID:-${MIGEL_CONNECTOR_ID:-}}" ]]; then
    local prefix="${MIGEL_SUBDOMAIN_PREFIX:-h}"
    local subdomain_id="${MIGEL_SUBDOMAIN_ID:-$MIGEL_CONNECTOR_ID}"
    printf '%s-%s.%s\n' "$prefix" "$subdomain_id" "$MIGEL_PUBLIC_DOMAIN"
    return
  fi

  # Default product route uses the domestic relay.
  printf 'relay.gewuyishu.cn\n'
}

detect_bridge_host() {
  # CLAWPOST_* fallback keeps existing local launchd overrides working after the migel rename.
  if [[ -n "${HERMES_BRIDGE_HOST:-${CLAWPOST_HOST:-}}" ]]; then
    printf '%s\n' "${HERMES_BRIDGE_HOST:-$CLAWPOST_HOST}"
    return
  fi

  printf '127.0.0.1\n'
}

detect_bridge_port() {
  # CLAWPOST_* fallback keeps existing local launchd overrides working after the migel rename.
  if [[ -n "${HERMES_BRIDGE_PORT:-${CLAWPOST_PORT:-}}" ]]; then
    printf '%s\n' "${HERMES_BRIDGE_PORT:-$CLAWPOST_PORT}"
    return
  fi

  printf '8443\n'
}

write_plist() {
  local advertised_host
  advertised_host="$(detect_advertised_host)"
  local advertised_port="${HERMES_BRIDGE_ADVERTISED_PORT:-${CLAWPOST_ADVERTISED_PORT:-443}}"
  local advertised_secure="${HERMES_BRIDGE_ADVERTISED_SECURE:-${CLAWPOST_ADVERTISED_SECURE:-true}}"
  local bridge_host
  bridge_host="$(detect_bridge_host)"
  local bridge_port
  bridge_port="$(detect_bridge_port)"
  local bridge_path="${HERMES_BRIDGE_PATH:-${CLAWPOST_PATH:-/gateway}}"
  # OPENCLAW_CONFIG_PATH is accepted as a migration fallback for existing developer shells.
  local config_path="${HERMES_CONFIG_PATH:-${OPENCLAW_CONFIG_PATH:-$HOME/.hermes/hermes.json}}"
  local public_domain="${MIGEL_PUBLIC_DOMAIN:-}"
  local subdomain_prefix="${MIGEL_SUBDOMAIN_PREFIX:-h}"
  local subdomain_id="${MIGEL_SUBDOMAIN_ID:-${MIGEL_CONNECTOR_ID:-}}"
  local public_host="${MIGEL_PUBLIC_HOST:-}"
  local bridge_local_url="${MIGEL_BRIDGE_LOCAL_URL:-http://127.0.0.1:$bridge_port}"

  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO_ROOT/tools/hermes-bridge.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_ROOT</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/hermes-bridge.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/hermes-bridge.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
    <key>PATH</key>
    <string>/opt/homebrew/opt/node@22/bin:/Users/apple/.nvm:/Users/apple/.local/bin:/Users/apple/.npm-global/bin:/Users/apple/bin:/Users/apple/.volta/bin:/Users/apple/.asdf/shims:/Users/apple/.bun/bin:/Users/apple/Library/Application Support/fnm/aliases/default/bin:/Users/apple/.fnm/aliases/default/bin:/Users/apple/Library/pnpm:/Users/apple/.local/share/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>NODE_USE_SYSTEM_CA</key>
    <string>1</string>
    <key>HERMES_BRIDGE_HOST</key>
    <string>$bridge_host</string>
    <key>HERMES_BRIDGE_PORT</key>
    <string>$bridge_port</string>
    <key>HERMES_BRIDGE_PATH</key>
    <string>$bridge_path</string>
    <key>HERMES_BRIDGE_ADVERTISED_HOST</key>
    <string>$advertised_host</string>
    <key>HERMES_BRIDGE_ADVERTISED_PORT</key>
    <string>$advertised_port</string>
    <key>HERMES_BRIDGE_ADVERTISED_SECURE</key>
    <string>$advertised_secure</string>
    <key>HERMES_CONFIG_PATH</key>
    <string>$config_path</string>
    <key>MIGEL_PUBLIC_DOMAIN</key>
    <string>$public_domain</string>
    <key>MIGEL_SUBDOMAIN_PREFIX</key>
    <string>$subdomain_prefix</string>
    <key>MIGEL_SUBDOMAIN_ID</key>
    <string>$subdomain_id</string>
    <key>MIGEL_PUBLIC_HOST</key>
    <string>$public_host</string>
    <key>MIGEL_BRIDGE_LOCAL_URL</key>
    <string>$bridge_local_url</string>
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
  install)
    write_plist
    bootout_service
    bootstrap_service
    print_status
    ;;
  restart)
    write_plist
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
