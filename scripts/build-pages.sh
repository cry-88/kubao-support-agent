#!/usr/bin/env bash
# =============================================================================
# 哭包智能客服 · GitHub Pages 静态站点构建
#
# 产出：dist-pages/（只含前端页面与静态资源，不含任何后端代码）
#
# 与服务器版的关系：
#   - 页面文件完全同源，同一套 index.html / admin.html / assets/*
#   - 唯一差异是 assets/runtime.js：构建时改写为 __CS_MODE__='static'，
#     页面进入"静态预览模式"，不发起任何后端请求
#   - 因此不需要维护第二套前端代码，也不会出现"演示版和线上版长得不一样"
#
# 用法：
#   ./scripts/build-pages.sh
#   CS_PAGES_API_BASE=https://support.example.com ./scripts/build-pages.sh
#     ↑ 若想让静态站点连远程后端，给它绝对地址（此时模式为 server）
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/dist-pages"
API_BASE="${CS_PAGES_API_BASE:-}"

cd "$ROOT"

echo "[pages] 清理输出目录"
rm -rf "$OUT"
mkdir -p "$OUT/assets"

echo "[pages] 复制页面"
for f in index.html admin.html 404.html; do
  test -f "$f" || { echo "[pages] 缺少 $f" >&2; exit 1; }
  cp "$f" "$OUT/"
done

echo "[pages] 复制静态资源"
cp assets/*.css "$OUT/assets/"
cp assets/*.js "$OUT/assets/"
# 图标/图片若存在一并带上（当前没有，留好位置）
if ls assets/*.png assets/*.svg assets/*.ico >/dev/null 2>&1; then
  cp assets/*.png assets/*.svg assets/*.ico "$OUT/assets/" 2>/dev/null || true
fi

echo "[pages] 改写运行模式"
if [ -n "$API_BASE" ]; then
  MODE="server"
  echo "[pages] 注意：指定了 CS_PAGES_API_BASE=$API_BASE，静态站点将直连该后端"
else
  MODE="static"
fi
cat > "$OUT/assets/runtime.js" <<EOF
/* 由 scripts/build-pages.sh 生成，请勿手工修改
 * 模式：$MODE
 * 生成时间：$(date -u +%Y-%m-%dT%H:%M:%SZ)
 */
window.__CS_MODE__ = '$MODE';
window.__CS_API_BASE__ = '$API_BASE';
EOF

# GitHub Pages 默认走 Jekyll，加这个文件避免处理下划线开头的路径、也加快部署
: > "$OUT/.nojekyll"

echo "[pages] 自检：不得包含任何后端/配置/数据文件"
case_out="$(find "$OUT" -type f \( \
  -name 'server.js' -o -path "$OUT/server/*" -o -path "$OUT/deploy/*" \
  -o -path "$OUT/data/*" -o -name '.env' -o -name '.env.*' \
  -o -path "$OUT/test/*" -o -path "$OUT/scripts/*" \) 2>/dev/null || true)"
if [ -n "$case_out" ]; then
  echo "[pages] 失败：输出目录混入后端文件：" >&2
  echo "$case_out" >&2
  exit 1
fi

# 关键文件必须在
for f in index.html admin.html 404.html .nojekyll assets/config.js assets/runtime.js assets/app.js assets/dashboard.js; do
  test -f "$OUT/$f" || { echo "[pages] 失败：缺少 $f" >&2; exit 1; }
done

# runtime.js 必须是目标模式
grep -q "__CS_MODE__ = '$MODE'" "$OUT/assets/runtime.js" || { echo "[pages] 失败：runtime.js 模式未写入" >&2; exit 1; }

echo "[pages] 完成：$OUT"
echo "[pages] 文件数：$(find "$OUT" -type f | wc -l)  体积：$(du -sh "$OUT" | cut -f1)  模式：$MODE"
find "$OUT" -type f | sed "s|$OUT/||" | sort | sed 's/^/  /'
