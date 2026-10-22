#!/usr/bin/env bash
# =============================================================================
# 哭包智能客服 · 版本回滚
#
# 风险等级：中（切软链 + 重启服务；不动 data/，不删任何 release）
# 影响范围：/opt/kubao-support/app 软链指向、kubao-support 服务进程
# 回滚方式：再执行一次本脚本并指定想回到的版本（release 目录都会保留）
#
# 用法：
#   sudo ./deploy/rollback.sh              # 回到上一个版本
#   sudo ./deploy/rollback.sh --to 20261022-221500
#   sudo ./deploy/rollback.sh --list
#
# 注意：只回滚代码，不回滚数据。若新版本已写入新字段，旧版本读取时按"缺字段即默认"
#       处理（server/store.js 对缺失 seq / agent_ip 等均容错），不会崩，但数据不会倒退。
#       需要连数据一起回到过去，请先用 backup.sh 的包恢复 data/。
# =============================================================================
set -euo pipefail

APP_DIR="/opt/kubao-support"
REL_DIR="$APP_DIR/releases"
CURRENT="$(readlink -f "$APP_DIR/app" 2>/dev/null || true)"
TARGET=""

while [ $# -gt 0 ]; do
  case "$1" in
    --to) TARGET="${2:-}"; shift 2 ;;
    --list)
      echo "现有版本（新 → 旧）："
      ls -1dt "$REL_DIR"/* 2>/dev/null | while read -r d; do
        mark=""
        [ "$d" = "$CURRENT" ] && mark="  ← 当前"
        echo "  $(basename "$d")$mark"
      done
      exit 0 ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "请用 root（或 sudo）执行" >&2; exit 1; }

if [ -z "$TARGET" ]; then
  # 取比当前次新的那个
  PREV="$(cat "$APP_DIR/previous_release" 2>/dev/null || true)"
  if [ -n "$PREV" ] && [ -d "$PREV" ] && [ "$PREV" != "$CURRENT" ]; then
    TARGET="$PREV"
  else
    TARGET="$(ls -1dt "$REL_DIR"/* 2>/dev/null | grep -v "^$CURRENT$" | head -n1 || true)"
  fi
fi

[ -n "$TARGET" ] || { echo "没有可回滚的版本" >&2; exit 1; }
[ -d "$TARGET" ] || TARGET="$REL_DIR/$TARGET"
[ -d "$TARGET" ] || { echo "目标版本不存在：$TARGET" >&2; exit 1; }
[ -f "$TARGET/server.js" ] || { echo "目标版本不完整（缺少 server.js）：$TARGET" >&2; exit 1; }

echo "[rollback] 当前：${CURRENT:-无}"
echo "[rollback] 目标：$TARGET"

ln -sfn "$TARGET" "$APP_DIR/app.new"
mv -Tf "$APP_DIR/app.new" "$APP_DIR/app"
chown -h kubao:kubao "$APP_DIR/app"
echo "$CURRENT" > "$APP_DIR/previous_release"

systemctl restart kubao-support

ok=0
for i in $(seq 1 20); do
  if curl -fsS --max-time 2 http://127.0.0.1:8080/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done

if [ "$ok" -eq 1 ]; then
  echo "[rollback] ✅ 已回滚并恢复正常：$(readlink -f "$APP_DIR/app")"
else
  echo "[rollback] ❌ 回滚后健康检查失败，日志："
  journalctl -u kubao-support -n 40 --no-pager || true
  exit 1
fi
