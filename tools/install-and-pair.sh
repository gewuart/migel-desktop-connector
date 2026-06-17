#!/bin/zsh
set -euo pipefail

REMOTE_REPO_URL="${MIGEL_REPO_URL:-${1:-}}"
AGENT="${MIGEL_AGENT:-${2:-hermes}}"
WORKDIR="${MIGEL_INSTALL_DIR:-$HOME/.migel/installers/migel-desktop}"
BRANCH="${MIGEL_REPO_BRANCH:-main}"
PAIR_CODE="${MIGEL_PAIR_CODE:-${3:-}}"
DESKTOP_CLAIM="${MIGEL_DESKTOP_CLAIM:-${4:-}}"
INSTALL_ONLY="${MIGEL_INSTALL_ONLY:-false}"
DRY_RUN="${MIGEL_DRY_RUN:-false}"
REQUIRE_NODE_MAJOR="22"

usage() {
  cat <<'EOF'
用法：
  curl -fsSL https://raw.githubusercontent.com/<org>/migel-desktop/main/tools/install-and-pair.sh | bash -s -- <repo_url> [hermes|openclaw] [pair_code] [desktop_claim]

示例：
  curl -fsSL https://raw.githubusercontent.com/<org>/migel-desktop/main/tools/install-and-pair.sh | bash -s -- https://github.com/<org>/migel-desktop.git hermes

环境变量：
  MIGEL_REPO_URL         Migel 桌面仓库地址
  MIGEL_AGENT            hermes 或 openclaw，默认 hermes
  MIGEL_INSTALL_DIR      本地安装目录，默认 ~/.migel/installers/migel-desktop
  MIGEL_REPO_BRANCH      仓库分支，默认 main
  MIGEL_PAIR_CODE        兼容旧流程的一次性配对码
  MIGEL_DESKTOP_CLAIM    桌面短期 claim，通常由 Migel App 生成的命令携带
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ -z "$REMOTE_REPO_URL" ]]; then
  echo "缺少仓库地址。请传入 MIGEL_REPO_URL 或作为第一个参数。" >&2
  usage
  exit 1
fi

if [[ "$AGENT" != "hermes" && "$AGENT" != "openclaw" ]]; then
  echo "AGENT 只能是 hermes 或 openclaw。" >&2
  exit 1
fi

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

if ! need_cmd git; then
  echo "缺少 git，请先安装 git。" >&2
  exit 1
fi

if ! need_cmd node; then
  echo "缺少 node，请先安装 Node.js ${REQUIRE_NODE_MAJOR}+。" >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt "$REQUIRE_NODE_MAJOR" ]]; then
  echo "Node.js 版本过低：$(node -v)。请升级到 ${REQUIRE_NODE_MAJOR}+。" >&2
  exit 1
fi

local_repo_path() {
  case "$REMOTE_REPO_URL" in
    file://*)
      python3 -c 'import sys, urllib.parse; print(urllib.parse.unquote(urllib.parse.urlparse(sys.argv[1]).path))' "$REMOTE_REPO_URL"
      ;;
    /*|~/*|./*|../*)
      printf '%s\n' "$REMOTE_REPO_URL"
      ;;
    *)
      return 1
      ;;
  esac
}

mkdir -p "$(dirname "$WORKDIR")"
if [[ ! -d "$WORKDIR/.git" ]]; then
  if [[ "$DRY_RUN" == "true" ]] && LOCAL_REPO="$(local_repo_path 2>/dev/null)" && [[ -d "$LOCAL_REPO" ]]; then
    echo "DRY RUN: 正在复制本地 Migel 工作树..."
    rm -rf "$WORKDIR"
    mkdir -p "$WORKDIR"
    (cd "$LOCAL_REPO" && tar --exclude='.git' -cf - .) | (cd "$WORKDIR" && tar -xf -)
  else
    echo "正在下载 Migel 桌面连接器..."
    git clone --branch "$BRANCH" "$REMOTE_REPO_URL" "$WORKDIR"
  fi
else
  echo "正在更新 Migel 桌面连接器..."
  git -C "$WORKDIR" fetch origin "$BRANCH"
  git -C "$WORKDIR" checkout "$BRANCH"
  git -C "$WORKDIR" pull --ff-only origin "$BRANCH"
fi

cd "$WORKDIR"

for required in \
  tools/migel-skill-bootstrap.mjs \
  tools/migel-pairing-skill.mjs \
  tools/migel-desktop-bootstrap.mjs \
  tools/install-hermes-bridge-service.sh \
  tools/install-migel-desktop-connector-service.sh \
  desktop-connector/src/main.mjs; do
  if [[ ! -e "$required" ]]; then
    echo "仓库内容不完整：缺少 $required" >&2
    exit 1
  fi
done

if [[ ! -d tools/node_modules/qrcode ]]; then
  echo "正在安装 tools 依赖..."
  (cd tools && npm install --omit=dev --no-audit --no-fund)
fi

if [[ -f gateway/package.json && ! -d gateway/node_modules/ws ]]; then
  echo "正在安装 gateway 依赖..."
  (cd gateway && npm install --omit=dev --no-audit --no-fund)
fi

if [[ -f desktop-connector/package.json && ! -d desktop-connector/node_modules ]]; then
  echo "正在安装 desktop-connector 依赖..."
  (cd desktop-connector && npm install --omit=dev --no-audit --no-fund)
fi

PAIR_ARGS=(node tools/migel-skill-bootstrap.mjs --agent "$AGENT")
if [[ -n "$PAIR_CODE" ]]; then
  PAIR_ARGS+=(--pair-code "$PAIR_CODE")
fi
if [[ -n "$DESKTOP_CLAIM" ]]; then
  PAIR_ARGS+=(--desktop-claim "$DESKTOP_CLAIM")
fi
if [[ "$INSTALL_ONLY" == "true" ]]; then
  PAIR_ARGS+=(--install-only true)
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo "DRY RUN: 依赖安装检查完成，验证 bootstrap 参数，不安装服务、不启动连接器。"
  "${PAIR_ARGS[@]}" --install-only true --dry-run true
  exit 0
fi

echo "正在安装或重启 Hermes bridge 服务..."
zsh tools/install-hermes-bridge-service.sh install

echo "正在启动 Migel 配对流程..."
"${PAIR_ARGS[@]}"
