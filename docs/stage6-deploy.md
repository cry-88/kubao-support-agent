# 阶段 6 · Linux 服务器部署方案

> **执行状态：全部命令仅生成，未执行任何一条。** 本会话没有可用的 SSH 连接，也没有探测过任何服务器。
> 请逐条 review 后再运行；每条都标了风险等级、影响范围与回滚方式。

---

## 一、交付物

| 文件 | 作用 |
| --- | --- |
| `scripts/package.sh` | 构建发布包（`git archive` 只打已提交内容），带包内容自检与 sha256 |
| `deploy/install.sh` | 幂等安装/更新：建用户、解包、原子切软链、装 unit、健康检查 |
| `deploy/rollback.sh` | 版本回滚：切软链 + 重启 + 健康检查，不动数据 |
| `deploy/backup.sh` | 备份 data/ 与环境变量文件（含口令），权限 600，保留 14 天 |
| `deploy/systemd/kubao-support.service` | systemd 常驻：开机自启、崩溃自动重启、权限最小化 |
| `deploy/nginx/kubao-support.conf` | 域名 + HTTPS 反代（含 SSE 与真实 IP 透传） |
| `deploy/nginx/kubao-support-ip.conf` | 裸 IP 反代（无 TLS，仅内网/临时） |
| `deploy/env/kubao-support.env.example` | 生产环境变量模板（口令留空，人工填） |

---

## 二、目录规划

```
/opt/kubao-support/
├── app -> releases/20261022-223000     # 软链，systemd 的 WorkingDirectory
├── releases/
│   ├── 20261022-223000/                # 每次发布一个目录，保留最近 5 个
│   └── 20261021-101500/                # 回滚就是切回这里
├── data/                                # 业务数据，独立于 release
│   └── store.json                       # 会话/消息/口令，权限 750，禁止入包
├── previous_release                     # 记录上一次版本，回滚用
└── (无日志目录：日志走 journald)

/etc/kubao-support/
└── kubao-support.env                    # 600 root:kubao，含口令

/var/backups/kubao-support/              # 备份包，600，保留 14 天
```

**为什么把 data/ 放在 release 外面**：更新与回滚只动代码，数据永远在同一个位置。回滚不需要"恢复数据库"这种危险动作。

---

## 三、依赖与安装（命令清单 · 待确认）

> 以下命令在**服务器上**执行。风险等级：🟢 低（只读/安装软件）/ 🟡 中（改服务与配置）/ 🔴 高（可能影响线上）
> 影响范围与回滚方式逐条列出。

### 3.1 系统依赖

| # | 命令 | 风险 | 影响范围 | 回滚 |
| --- | --- | --- | --- | --- |
| 1 | `cat /etc/os-release && uname -m && node -v 2>/dev/null; nginx -v 2>&1` | 🟢 低 | 只读 | 无需 |
| 2 | `curl -fsSL https://deb.nodesource.com/setup_20.x \| sudo -E bash -` | 🟡 中 | 添加 NodeSource 软件源（写 `/etc/apt/sources.list.d/`） | `sudo rm /etc/apt/sources.list.d/nodesource.list` 后 `apt update` |
| 3 | `sudo apt-get install -y nodejs nginx` | 🟡 中 | 安装/升级 Node 与 Nginx | 已装则无变化；如需卸载 `sudo apt-get remove nodejs nginx` |
| 4 | `node -v && nginx -v` | 🟢 低 | 只读 | 无需 |

> CentOS/RHEL 用 `dnf install -y nodejs nginx`；Node 需 ≥ 18（应用启动时会强制校验）。

### 3.2 上传发布包

在**本地**执行打包（不接触服务器）：

```bash
./scripts/package.sh
# 产出 dist/kubao-support-<version>-<sha>-<ts>.tar.gz 与 .sha256
```

| # | 命令 | 风险 | 影响范围 | 回滚 |
| --- | --- | --- | --- | --- |
| 5 | `scp dist/kubao-support-*.tar.gz* <user>@<host>:/tmp/` | 🟢 低 | 只往 `/tmp` 写文件 | `rm /tmp/kubao-support-*.tar.gz*` |
| 6 | `ssh <user>@<host> "sha256sum -c /tmp/kubao-support-*.tar.gz.sha256 --ignore-missing"` | 🟢 低 | 只读校验 | 无需 |

### 3.3 首次安装

| # | 命令 | 风险 | 影响范围 | 回滚 |
| --- | --- | --- | --- | --- |
| 7 | `sudo mkdir -p /opt/kubao-support && sudo tar -xzf /tmp/kubao-support-*.tar.gz -C /tmp` | 🟢 低 | 建目录 + 解包到 /tmp | `sudo rm -rf /tmp/kubao-support-*` |
| 8 | `sudo /tmp/kubao-support-*/deploy/install.sh -p /tmp/kubao-support-*.tar.gz --no-start` | 🟡 中 | 建系统用户 `kubao`、`/opt/kubao-support/{releases,data}`、装 systemd unit、从模板创建 `/etc/kubao-support/kubao-support.env` | 未启动，无线上影响；撤除：`sudo systemctl disable kubao-support; sudo rm -rf /opt/kubao-support /etc/systemd/system/kubao-support.service` |
| 9 | `sudo install -m 600 -o root -g kubao /dev/null /dev/null`（占位，无需执行） | — | — | — |

> `--no-start` 的原因：环境变量文件是模板，`CS_ADMIN_CODE` 还是空的。生产环境会**直接拒绝启动**（这是刻意设计，防止带默认口令上线）。

### 3.4 填口令

| # | 命令 | 风险 | 影响范围 | 回滚 |
| --- | --- | --- | --- | --- |
| 10 | `sudo -e /etc/kubao-support/kubao-support.env`，填 `CS_ADMIN_CODE`（≥12 位，含大小写/数字/符号）与坐席口令 | 🟡 中 | 只改该文件 | 改回即可；文件首次创建前会保留模板副本 |
| 11 | `sudo chmod 600 /etc/kubao-support/kubao-support.env && sudo chown root:kubao /etc/kubao-support/kubao-support.env` | 🟢 低 | 文件权限 | 无需（这是必须做的） |

### 3.5 启动与验证

| # | 命令 | 风险 | 影响范围 | 回滚 |
| --- | --- | --- | --- | --- |
| 12 | `sudo systemctl start kubao-support` | 🟡 中 | 启动 Node 进程（监听 127.0.0.1:8080） | `sudo systemctl stop kubao-support` |
| 13 | `curl -s http://127.0.0.1:8080/health \| head -c 400` | 🟢 低 | 只读 | 无需 |
| 14 | `sudo journalctl -u kubao-support -n 50 --no-pager` | 🟢 低 | 只读 | 无需 |
| 15 | `sudo systemctl enable kubao-support` | 🟡 中 | 开机自启 | `sudo systemctl disable kubao-support` |

### 3.6 Nginx 反代

**A. 裸 IP（内网/临时）**

| # | 命令 | 风险 | 影响范围 | 回滚 |
| --- | --- | --- | --- | --- |
| 16 | `sudo cp /opt/kubao-support/app/deploy/nginx/kubao-support-ip.conf /etc/nginx/conf.d/` | 🟡 中 | 新增站点配置；注意 `default_server` 可能与其他站点冲突 | `sudo rm /etc/nginx/conf.d/kubao-support-ip.conf` |
| 17 | `sudo nginx -t` | 🟢 低 | 只校验不生效 | 无需 |
| 18 | `sudo systemctl reload nginx` | 🟡 中 | 重载配置（不断连接） | `sudo systemctl reload nginx`（回退配置后再 reload） |
| 19 | `curl -s http://<服务器IP>/health` | 🟢 低 | 只读 | 无需 |

**B. 域名 + HTTPS**

| # | 命令 | 风险 | 影响范围 | 回滚 |
| --- | --- | --- | --- | --- |
| 20 | 把 `deploy/nginx/kubao-support.conf` 里的 `support.example.com` 改成真实域名后上传 | 🟡 中 | 新增站点配置 | 删除该文件并 reload |
| 21 | `sudo apt-get install -y certbot python3-certbot-nginx` | 🟡 中 | 安装证书工具 | `sudo apt-get remove certbot` |
| 22 | `sudo mkdir -p /var/www/certbot && sudo chown -R www-data:www-data /var/www/certbot` | 🟢 低 | 建 ACME 校验目录 | `sudo rm -rf /var/www/certbot` |
| 23 | `sudo certbot certonly --webroot -w /var/www/certbot -d <域名> --email <邮箱> --agree-tos -n` | 🟡 中 | 申请证书写入 `/etc/letsencrypt`；**要求域名已解析到本机且 80 端口可达** | `sudo certbot delete --cert-name <域名>` |
| 24 | `sudo nginx -t && sudo systemctl reload nginx` | 🟡 中 | 生效 HTTPS | 改回 HTTP 配置后 reload |
| 25 | `curl -sI https://<域名>/health \| head -5` | 🟢 低 | 只读 | 无需 |
| 26 | `sudo systemctl enable --now certbot.timer`（或 `certbot renew --dry-run` 验证） | 🟡 中 | 自动续期 | `sudo systemctl disable certbot.timer` |

> `Strict-Transport-Security` 已写在域名配置里。**确认 HTTPS 稳定后再启用**——HSTS 一旦下发，浏览器会强制走 https，回退成本高；保守做法是先注释该行，观察一周再开。

---

## 四、日常运维

### 4.1 发新版本（可逆）

```bash
# 本地
./scripts/package.sh
scp dist/kubao-support-*.tar.gz* <user>@<host>:/tmp/

# 服务器（风险：🟡 中；影响：服务重启约 1~2 秒；回滚：deploy/rollback.sh）
sudo /opt/kubao-support/app/deploy/install.sh -p /tmp/kubao-support-*.tar.gz
```

`install.sh` 会：解包到新 release → 原子切换软链 → 重启 → 健康检查（最多 20 秒）→ 失败时打印 journal 并提示回滚，**不自动回滚**（自动回滚容易把"配置错"当成"代码错"反复横跳）。

### 4.2 回滚

```bash
# 风险：🟡 中；影响：切代码 + 重启，不动 data/
sudo /opt/kubao-support/app/deploy/rollback.sh
sudo /opt/kubao-support/app/deploy/rollback.sh --list          # 看有哪些版本
sudo /opt/kubao-support/app/deploy/rollback.sh --to 20261021-101500
```

### 4.3 备份

```bash
# 风险：🟢 低；影响：只读数据 + 写备份包
sudo /opt/kubao-support/app/deploy/backup.sh
sudo /opt/kubao-support/app/deploy/backup.sh --keep 30
```

建议 crontab（🟡 中，改系统定时任务）：

```bash
# 每天 03:30 备份，保留 14 天
30 3 * * * root /opt/kubao-support/app/deploy/backup.sh >/var/log/kubao-backup.log 2>&1
```

### 4.4 常用观测

```bash
sudo systemctl status kubao-support
sudo journalctl -u kubao-support -f
sudo journalctl -u kubao-support -S today | grep '"event":"rate_limit"'
sudo journalctl -u kubao-support -S today | grep '"event":"auth.lockout"'
sudo journalctl -u kubao-support -S today | grep '"level":"error"'
curl -s http://127.0.0.1:8080/health | jq
```

日志是 JSON 行（`CS_LOG_FORMAT=json`），可直接 `jq` 或接 Loki/ES。

---

## 五、阶段6 的代码改动（可信代理 + IP 限流键）

| 改动 | 说明 |
| --- | --- |
| `server/client-ip.js`（新） | 真实 IP 解析：默认不信任何头；只有对端是可信代理才读 `X-Forwarded-For`，且**只取最后一段**（Nginx 追加的那段），客户端伪造的前缀无效 |
| `CS_TRUST_PROXY` / `CS_TRUSTED_PROXIES` | 生产默认开启，默认只信 `127.0.0.1,::1` |
| 日志 `remote_addr` + `ip_source` | 记录真实 IP 及来源（socket / x-forwarded-for），便于核对代理是否配好 |
| 分析/看板限流键 | 从「口令指纹」改为「口令指纹@IP」，不同来源各自计数 |
| 登录防爆破 | 新增按来源 IP 计数（`CS_LOGIN_MAX_PER_IP`，默认 10/10 分钟），避免单机换口令撞库、也避免有人故意打满全局阈值把所有人锁死 |
| `SIGTERM` 优雅退出 | 收到 systemd 停止信号先停止接新连接，最多等 10 秒收尾，超时强制退出 |

**为什么只取 XFF 最后一段**：`$proxy_add_x_forwarded_for` 会在客户端传来的值后面追加真实来源。若取第一段，攻击者只要自己伪造 `X-Forwarded-For: 1.2.3.4` 就能让限流键变成别人的 IP。取最后一段才锚定在"我们自己的代理看到的事实"。

**已知限制**：只支持单层可信代理。若将来前面再加 CDN（两层代理），需要把 CDN 网段加入 `CS_TRUSTED_PROXIES` 并按跳数剥离——当前拓扑（Nginx 与 Node 同机）不需要。

---

## 六、上线前检查清单

- [ ] `CS_ADMIN_CODE` 已改成独立强口令，未使用默认值
- [ ] `/etc/kubao-support/kubao-support.env` 权限 600、属主 `root:kubao`
- [ ] `CS_TRUST_PROXY=true` 且 `CS_TRUSTED_PROXIES` 与实际代理地址一致
- [ ] Nginx `proxy_buffering off`（否则流式回答会卡到结束才输出）
- [ ] `client_max_body_size` 与 `CS_BODY_LIMIT_BYTES` 一致（默认都是 1MB）
- [ ] `curl /health` 返回 `status: ok`，`checks.data_dir.writable` 为 true
- [ ] 日志里 `remote_addr` 是真实客户端 IP，`ip_source` 为 `x-forwarded-for`
- [ ] 防火墙只放行 22/80/443，8080 不对公网开放
- [ ] 已配置备份定时任务，并**实际恢复演练一次**
- [ ] 已确认回滚流程（`rollback.sh --list` 能看到至少两个版本）

---

## 七、方案取舍

1. **不做 Docker**。单实例 + 单文件数据 + 零依赖，systemd 已经够用；引入容器只会多一层网络与卷权限的坑。
2. **不自己写日志文件**。stdout → journald，滚动、轮转、保留策略交给系统；应用侧只负责结构化。
3. **单实例约束（重要）**：`store.json` 是整文件原子替换，**多进程会互相覆盖**。所以 unit 里没有配多实例，也不要 `--instances`。要水平扩展，必须先迁移到 PostgreSQL（阶段 8 会写迁移步骤）。
4. **回滚不自动执行**。健康检查失败时只提示，不自动切回——升级失败常见原因是环境变量配错，自动回滚会把问题掩盖成"版本问题"，反而难查。
5. **数据与代码分离**，所以回滚永远不需要碰 `data/`；反过来，恢复数据也不会把代码带回旧版本。
