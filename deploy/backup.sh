#!/usr/bin/env bash
# =============================================================================
# 哭包智能客服 · 数据备份
#
# 风险等级：低（只读业务数据并写备份文件，不改动线上数据）
# 影响范围：/var/backups/kubao-support（创建目录与压缩包）
# 回滚方式：本脚本不改变任何线上状态，无需回滚
#
# 用法：
#   sudo ./deploy/backup.sh
#   sudo ./deploy/backup.sh --keep 30        # 保留 30 天（默认 14 天）
#
# 一致性说明：
#   store.json 的写入是「临时文件 + rename」的原子替换，正常读取不会读到半截文件；
#   备份直接拷贝即可。若要求强一致（例如备份期间正在批量写入），
#   可在低峰期执行，或临时 systemctl stop 后再备份。
# =============================================================================
set -euo pipefail

APP_DIR="/opt/kubao-support"
DATA_DIR="$APP_DIR/data"
ENV_FILE="/etc/kubao-support/kubao-support.env"
DEST="/var/backups/kubao-support"
KEEP_DAYS=14

while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP_DAYS="${2:-14}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "请用 root（或 sudo）执行" >&2; exit 1; }
[ -d "$DATA_DIR" ] || { echo "数据目录不存在：$DATA_DIR" >&2; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST/kubao-support-${STAMP}.tar.gz"
mkdir -p "$DEST"
chmod 750 "$DEST"

echo "[backup] 打包数据目录…"
# 口令文件单独收进同一个包，恢复时不用再找
TMPLIST="$(mktemp)"
trap 'rm -f "$TMPLIST"' EXIT
tar -czf "$OUT" -C "$APP_DIR" data
if [ -f "$ENV_FILE" ]; then
  echo "[backup] 附上环境变量文件（含口令，包权限设为 600）"
  tar -rf "${OUT%.gz}" -C "$(dirname "$ENV_FILE")" "$(basename "$ENV_FILE")"
  gzip -f "${OUT%.gz}"
fi

chmod 600 "$OUT"
tar -tzf "$OUT" >/dev/null || { echo "[backup] 压缩包自检失败" >&2; exit 1; }

SIZE="$(du -h "$OUT" | cut -f1)"
echo "[backup] 完成：$OUT（$SIZE）"

echo "[backup] 清理 ${KEEP_DAYS} 天前的备份…"
find "$DEST" -name 'kubao-support-*.tar.gz' -type f -mtime "+$KEEP_DAYS" -print -delete || true

echo "[backup] 恢复方式："
echo "  systemctl stop kubao-support"
echo "  tar -xzf $OUT -C /opt/kubao-support        # 恢复 data/"
echo "  tar -xzf $OUT -C /etc/kubao-support        # 恢复环境变量（如包含）"
echo "  systemctl start kubao-support"
