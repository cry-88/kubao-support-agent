#!/usr/bin/env bash
# =============================================================================
# 哭包智能客服 · 发布包构建（本地执行，不接触服务器）
#
# 用法：
#   ./scripts/package.sh              # 打包当前 HEAD
#   ./scripts/package.sh --worktree   # 打包工作区（含未提交改动，仅供本地验证）
#
# 产物：
#   dist/kubao-support-<version>-<sha>-<date>.tar.gz
#   dist/kubao-support-<version>-<sha>-<date>.tar.gz.sha256
#
# 设计：
#   - 默认用 git archive，只打已提交内容，保证"线上跑的就是仓库里的"
#   - 排除 data/、.git、node_modules、dist、测试与文档，减小体积
#   - 打包后自检：必须包含 server.js / server/ / assets/ / index.html；不得包含 data/
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
MODE="${1:-}"

cd "$ROOT"

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)"
if [ "$MODE" = "--worktree" ]; then
  SHA="worktree"
else
  SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
fi
STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="kubao-support-${VERSION}-${SHA}-${STAMP}"

mkdir -p "$DIST"
OUT="$DIST/$NAME.tar.gz"

echo "[package] 版本 $VERSION  提交 $SHA"

# ---------- 收集文件清单（两种模式共用一套排除规则）----------
# 排除：测试、内部笔记、CI 配置、构建产物、业务数据、依赖
# 保留：docs（systemd 单元的 Documentation 指向它）、deploy、scripts、env 模板
EXCLUDE_RE='^(test|\.workbuddy|\.github|dist|data|data-test|node_modules)/'

TMPLIST="$(mktemp)"
trap 'rm -f "$TMPLIST"' EXIT

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [ "$MODE" = "--worktree" ]; then
    echo "[package] 模式：工作区打包（含未提交改动，不推荐用于上线）"
    git ls-files --cached --others --exclude-standard | grep -vE "$EXCLUDE_RE" > "$TMPLIST"
  else
    echo "[package] 模式：仅已提交内容（git ls-files）"
    git ls-files | grep -vE "$EXCLUDE_RE" > "$TMPLIST"
  fi
else
  echo "[package] 模式：无 git 仓库，按目录扫描"
  find . -type f \
    -not -path './.git/*' -not -path './data/*' -not -path './data-test/*' \
    -not -path './dist/*' -not -path './node_modules/*' -not -path './test/*' \
    -not -path './.workbuddy/*' -not -path './.github/*' \
    | sed 's|^\./||' > "$TMPLIST"
fi

[ -s "$TMPLIST" ] || { echo "[package] 失败：文件清单为空" >&2; exit 1; }
echo "[package] 待打包文件：$(wc -l < "$TMPLIST") 个"

tar -czf "$OUT" --transform "s|^|${NAME}/|" -T "$TMPLIST"

# ---------- 自检 ----------
echo "[package] 自检包内容…"
LIST="$(tar -tzf "$OUT")"
fail() { echo "[package] 失败：$1" >&2; rm -f "$OUT"; exit 1; }

for f in "$NAME/server.js" "$NAME/index.html" "$NAME/admin.html" "$NAME/assets/app.js" "$NAME/assets/dashboard.js"; do
  echo "$LIST" | grep -qx "$f" || fail "缺少必需文件 $f"
done
echo "$LIST" | grep -qx "$NAME/server/rpc.js" || fail "缺少 server/ 目录"
if echo "$LIST" | grep -q "^$NAME/data/"; then
  fail "包内出现 data/ 目录（业务数据与口令绝不能进发布包）"
fi
# 允许 .env.example（模板），其余任何 .env / .env.<环境> 都不允许
BAD_ENV="$(echo "$LIST" | grep -E "^$NAME/\.env(\..+)?$" | grep -vE "^$NAME/\.env\.example$" || true)"
if [ -n "$BAD_ENV" ]; then
  fail "包内出现环境配置文件：$(echo "$BAD_ENV" | head -n3 | tr '\n' ' ')"
fi

( cd "$DIST" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )

SIZE="$(du -h "$OUT" | cut -f1)"
echo "[package] 完成：$OUT（$SIZE）"
echo "[package] 校验：$OUT.sha256"
