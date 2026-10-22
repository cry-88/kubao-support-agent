#!/usr/bin/env bash
# =============================================================================
# 哭包智能客服 · 首次安装 / 版本更新（幂等，可重复执行）
#
# 风险等级：中（创建系统用户、安装 systemd 单元、重启服务；不改动已有数据）
# 影响范围：/opt/kubao-support、/etc/systemd/system/kubao-support.service、
#           /etc/kubao-support（仅在文件缺失时创建）
# 回滚方式：deploy/rollback.sh 切回上一个 release；单元文件安装前会备份为 .bak
#
# 用法：
#   sudo ./deploy/install.sh -p dist/kubao-support-1.6.0-xxxx.tar.gz
#   sudo ./deploy/install.sh -p <pkg> --no-start      # 只部署不启动（首次配置口令时用）
#
# 说明：
#   - 不覆盖已存在的环境变量文件（口令不会被脚本改掉），缺失时才从模板创建并提示
#   - 数据目录独立于 release，更新与回滚都不会碰 data/
# =============================================================================
set -euo pipefail

APP_DIR="/opt/kubao-support"
REL_DIR="$APP_DIR/releases"
DATA_DIR="$APP_DIR/data"
ENV_DIR="/etc/kubao-support"
ENV_FILE="$ENV_DIR/kubao-support.env"
UNIT="/etc/systemd/system/kubao-support.service"
SERVICE_USER="kubao"
KEEP_RELEASES=5
PKG=""
START=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    -p|--package) PKG="${2:-}"; shift 2 ;;
    --no-start) START=0; shift ;;
    -h|--help) usage ;;
    *) echo "未知参数：$1" >&2; usage ;;
  esac
done

[ -n "$PKG" ] || { echo "缺少 -p <发布包.tar.gz>" >&2; usage; }
[ -f "$PKG" ] || { echo "发布包不存在：$PKG" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "请用 root（或 sudo）执行" >&2; exit 1; }

echo "== 1/9 依赖检查 =="
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "未找到 node，请先安装 Node.js 18+（见 docs/stage6-deploy.md）" >&2; exit 1; }
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { echo "Node 版本过低：$("$NODE_BIN" -v)，需要 >= 18" >&2; exit 1; }
echo "   node: $NODE_BIN ($("$NODE_BIN" -v))"

echo "== 2/9 校验发布包 =="
if [ -f "${PKG}.sha256" ]; then
  ( cd "$(dirname "$PKG")" && sha256sum -c "$(basename "${PKG}.sha256")" ) || { echo "校验失败，包可能损坏" >&2; exit 1; }
else
  echo "   未找到 .sha256，跳过校验（不建议）"
fi

echo "== 3/9 创建运行用户 =="
if id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "   用户已存在：$SERVICE_USER"
else
  useradd --system --shell /usr/sbin/nologin --home-dir "$APP_DIR" --no-create-home "$SERVICE_USER"
  echo "   已创建系统用户：$SERVICE_USER"
fi

echo "== 4/9 解包到 releases/ =="
mkdir -p "$REL_DIR" "$DATA_DIR"
chmod 750 "$DATA_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
REL="$REL_DIR/$STAMP"
mkdir -p "$REL"
tar -xzf "$PKG" -C "$REL" --strip-components=1
[ -f "$REL/server.js" ] || { echo "包结构异常：缺少 server.js" >&2; exit 1; }
echo "   已解包：$REL"

echo "== 5/9 切换软链（原子操作）=="
if [ -L "$APP_DIR/app" ] || [ -d "$APP_DIR/app" ]; then
  PREV="$(readlink -f "$APP_DIR/app" 2>/dev/null || true)"
  [ -n "$PREV" ] && echo "   当前版本：$PREV" && echo "$PREV" > "$APP_DIR/previous_release"
fi
ln -sfn "$REL" "$APP_DIR/app.new"
mv -Tf "$APP_DIR/app.new" "$APP_DIR/app"
chown -h "$SERVICE_USER:$SERVICE_USER" "$APP_DIR/app"
echo "   已指向：$(readlink -f "$APP_DIR/app")"

echo "== 6/9 权限 =="
chown -R "$SERVICE_USER:$SERVICE_USER" "$REL_DIR" "$DATA_DIR"
chmod -R u+rwX,go-rwx "$DATA_DIR"
echo "   releases/ 与 data/ 属主：$SERVICE_USER"

echo "== 7/9 安装 systemd 单元 =="
if [ -f "$UNIT" ] && ! cmp -s "$HERE/systemd/kubao-support.service" "$UNIT"; then
  BACKUP="$UNIT.bak.$(date +%Y%m%d-%H%M%S)"
  cp -a "$UNIT" "$BACKUP"
  echo "   已备份原单元：$BACKUP"
fi
install -m 644 "$HERE/systemd/kubao-support.service" "$UNIT"
systemctl daemon-reload
systemctl enable kubao-support >/dev/null
echo "   已安装并设为开机自启"

echo "== 8/9 环境变量 =="
mkdir -p "$ENV_DIR"
chown root:"$SERVICE_USER" "$ENV_DIR"
chmod 750 "$ENV_DIR"
if [ -f "$ENV_FILE" ]; then
  echo "   已存在：$ENV_FILE（保持不变）"
else
  install -m 600 -o root -g "$SERVICE_USER" "$HERE/env/kubao-support.env.example" "$ENV_FILE"
  echo "   已从模板创建：$ENV_FILE"
  echo "   ！！请立刻填写 CS_ADMIN_CODE，否则生产环境会拒绝启动 ！！"
  echo "   编辑：sudo editor $ENV_FILE"
  START=0
fi

echo "== 9/9 启动与健康检查 =="
if [ "$START" -eq 0 ]; then
  echo "   已跳过启动（--no-start 或首次创建环境变量）。填好口令后执行："
  echo "   sudo systemctl restart kubao-support && curl -s localhost:8080/health"
else
  systemctl restart kubao-support
  ok=0
  for i in $(seq 1 20); do
    if curl -fsS --max-time 2 http://127.0.0.1:8080/health >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
  if [ "$ok" -eq 1 ]; then
    echo "   ✅ 服务正常：$(curl -s http://127.0.0.1:8080/health | head -c 160)"
  else
    echo "   ❌ 健康检查未通过，最近日志："
    journalctl -u kubao-support -n 30 --no-pager || true
    echo "   回滚：sudo $HERE/rollback.sh"
    exit 1
  fi
fi

echo "== 清理旧版本（保留最近 $KEEP_RELEASES 个）=="
ls -1dt "$REL_DIR"/* 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | while read -r old; do
  echo "   删除：$old"
  rm -rf "$old"
done

echo "完成。常用命令："
echo "  systemctl status kubao-support"
echo "  journalctl -u kubao-support -f"
echo "  sudo $HERE/backup.sh"
echo "  sudo $HERE/rollback.sh"
