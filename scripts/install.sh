#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${AGYS_REPO_URL:-https://github.com/GotoLu/agys-switcher.git}"
INSTALL_DIR="${AGYS_INSTALL_DIR:-$HOME/.local/share/agys}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "错误: agys 仅支持 macOS。" >&2
  exit 1
fi

for cmd in git node npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "错误: 未检测到 $cmd，请先安装后重试。" >&2
    exit 1
  fi
done

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "错误: 需要 Node.js >= 22.0.0，当前版本为 $(node -v)。" >&2
  exit 1
fi

mkdir -p "$(dirname "$INSTALL_DIR")"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "检测到已有安装目录，正在更新: $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
else
  if [[ -e "$INSTALL_DIR" ]]; then
    echo "错误: 目标路径已存在且不是 git 仓库: $INSTALL_DIR" >&2
    echo "可通过 AGYS_INSTALL_DIR=/path/to/dir 指定其他安装路径。" >&2
    exit 1
  fi
  echo "正在克隆 agys 到 $INSTALL_DIR ..."
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

echo "正在安装依赖并构建 ..."
npm --prefix "$INSTALL_DIR" install --no-fund --no-audit
npm --prefix "$INSTALL_DIR" run build
npm --prefix "$INSTALL_DIR" link

echo ""
echo "安装完成！现在可以在任意终端目录运行："
echo "  agys          # 打开交互式主菜单"
echo "  agys add      # 通过 Google OAuth 添加账号"
echo "  agys ls       # 查看账号与 5h/周额度"
echo ""
echo "卸载方式：npm unlink -g agy-account && rm -rf \"$INSTALL_DIR\""
