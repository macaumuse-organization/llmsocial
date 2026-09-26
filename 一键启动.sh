#!/usr/bin/env bash
# One-click launcher for llmsocial on macOS / Linux:  bash 一键启动.sh
set -u
cd "$(dirname "$0")"

PORT=$(grep -E '^LLMSOCIAL_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2)
URL="http://127.0.0.1:${PORT:-8787}"

if ! command -v node >/dev/null 2>&1; then
  echo "没找到 Node.js。去 https://nodejs.org 装 LTS 版（22.18 或更新），装完再运行这个文件。"
  exit 1
fi
ver=$(node -v | sed 's/^v//')
major=${ver%%.*}
minor=$(echo "$ver" | cut -d. -f2)
if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 18 ]; }; then
  echo "Node.js 版本太旧（$ver），要 22.18 或更新。去 https://nodejs.org 装 LTS 版。"
  exit 1
fi

open_browser() {
  [ -n "${LLMSOCIAL_NO_BROWSER:-}" ] && return 0
  if command -v open >/dev/null 2>&1; then open "$1"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1; fi
}

if curl -s --noproxy '*' -m 2 -o /dev/null "$URL/api/auth/state"; then
  echo "llmsocial 已经在运行：$URL"
  open_browser "$URL"
  exit 0
fi

if [ ! -d node_modules ]; then
  echo "第一次运行，先安装依赖，要几分钟..."
  npm install || { echo "依赖安装失败，看上面的错误。网络不通的话开一下代理再试。"; exit 1; }
fi

# Wait in the background for the server to answer, then open the browser once.
(
  for _ in $(seq 1 180); do
    if curl -s --noproxy '*' -m 2 -o /dev/null "$URL/api/auth/state"; then open_browser "$URL"; exit 0; fi
    sleep 1
  done
) &

echo "正在启动 llmsocial，起来后浏览器会自动打开 $URL"
echo "这个窗口别关，关了服务就停。要停按 Ctrl+C。"
echo
exec npm start
