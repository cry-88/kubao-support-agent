# 哭包 · 智能客服 Agent

[![Deploy to GitHub Pages](https://github.com/cry-88/kubao-support-agent/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/cry-88/kubao-support-agent/actions/workflows/deploy-pages.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

一个可以直接上线的**在线智能客服 Web 应用**：多轮对话、FAQ 知识库检索、意图识别、自动转人工、坐席工单队列、长会话摘要、管理后台、满意度统计与工单数据分析。

单应用结构，没有 monorepo、没有 `packages/` 子包、没有打包构建；后端零依赖 Node ≥ 18，前端是纯静态页面。两种部署模式：**服务器部署**（功能完整）与 **GitHub Pages 静态预览**（只看界面）。

> [!IMPORTANT]
> **部署后第一件事：修改管理员口令。** 默认口令仅用于开发演示，生产环境必须设置环境变量 `CS_ADMIN_CODE` 为强口令，生产模式校验不通过会拒绝启动。

---

## 当前版本：本地后端模式（开箱即跑）

本仓库当前分支已改为**零依赖本地后端**，不再依赖云服务即可完整运行全部功能（对话、FAQ 检索、意图识别、订单查询、转人工、坐席工单、后台统计、数据分析、知识缺口、CSV 导出）：

```bash
node server.js          # 或 npm start（默认 development）
# 打开 http://localhost:8080       用户端
# 打开 http://localhost:8080/admin.html   坐席 / 管理后台

NODE_ENV=production node server.js   # 切环境，详见「环境与配置」
npm test                             # 134 条自测用例
```

默认口令（首次启动写入 `data/store.json`，请立即修改）：

| 角色 | 口令 |
| --- | --- |
| 管理员 | `kubao-admin-2026` |
| 坐席 · 客服A | `kubao-agent-1` |
| 坐席 · 客服B | `kubao-agent-2` |

改口令的两种方式：改 `data/store.json` 里 `settings[0].value` / `agents[].code`，或删除该文件后用环境变量 `CS_ADMIN_CODE`、`CS_AGENT_CODE_1/2` 重新初始化。

替换关系：

| 原实现 | 现实现 |
| --- | --- |
| `assets/config.js` 连 `@tencent-ai/workbuddy-cloud-sdk` | 同文件内的轻量客户端，走本项目 `/api/*`（接口形状不变，`app.js` / `admin.js` 未改动） |
| PostgreSQL + 28 个 `SECURITY DEFINER` 函数 | `server/rpc.js` 逐个还原同名函数与返回结构，数据落 `data/store.json` |
| 云端大模型（免密钥流式通道） | `server/reply.js` 确定性应答引擎：解析前端已检索好的 FAQ 与订单事实后作答，不编造数字，同样支持 SSE 流式与「停止生成」 |
| `schema.sql` 一次建库 | `server/store.js` 首次启动按同样种子数据（12 条 FAQ / 3 个演示订单）初始化 |

> 需要真实大模型改写措辞、或需要跨设备共享数据时，可接回 PostgreSQL（`schema.sql` 已就绪）与模型通道（设置 `CS_MODEL_*` 环境变量）；前端业务逻辑无需改动。

---

## 目录

- [功能列表](#功能列表)
- [系统架构](#系统架构)
- [技术栈](#技术栈)
- [目录结构](#目录结构)
- [部署步骤](#部署步骤)
- [环境与配置（三套环境）](#环境与配置三套环境)
- [日志、链路与健康检查](#日志链路与健康检查)
- [部署到 Linux 服务器](#部署到-linux-服务器)
- [界面截图](#界面截图)
- [数据模型](#数据模型)
- [服务端接口（RPC）](#服务端接口rpc)
- [安全模型](#安全模型)
- [配置说明](#配置说明)
- [分支策略](#分支策略)
- [已知限制与路线图](#已知限制与路线图)

> 更多文档：[项目总览](docs/OVERVIEW.md) · [开发手册](docs/DEVELOP.md) · [交付清单](docs/DELIVER.md) · [各阶段文档](docs/OVERVIEW.md#6-阶段文档索引)

---

## 功能列表

### 用户端（`index.html`）

| 功能 | 说明 |
|---|---|
| 多轮对话 | 携带最近 10 条上下文，流式输出，可随时「停止生成」 |
| 长会话摘要 | 有效消息超过 12 条后自动把前文压缩成 200 字摘要，后续轮次用「摘要 + 最近 6 条」，聊再久也不丢关键信息 |
| 意图识别 | 关键词规则优先，置信度不足时调用大模型做 JSON 分类，实时显示「退款 / 查询订单 / 技术支持」标签 |
| FAQ 检索 | 关键词命中长度 + 问题二元组重合度打分，Top3 注入提示词，气泡标注「FAQ 命中 N 条」 |
| 订单实时查询 | 正则提取订单号后查服务端真实数据再回答，避免模型编造物流与金额 |
| 自动转人工 | 「转人工」「投诉」立即转接；连续两轮无法识别意图也会自动转接 |
| 非工作时间兜底 | 22:00–9:00 转人工时提示留言，手机号 / 邮箱落库供次日跟进 |
| 人工接入实时反馈 | 坐席接入后 4 秒内显示「小美 已接入，正在为您处理」+ 等待计时 |
| 满意度评价 | 1–5 星 + 留言，写入云端并计入统计 |
| 发送限流 | 前端 1 秒间隔 / 每分钟 10 条，服务端硬限制每分钟 12 条 |
| 历史会话 | 本机访客可回看全部历史会话（按 `guest_key` 隔离） |

### 坐席端（`admin.html` → 工单队列）

- **队列排序**：待接入工单按等待时长倒序，满 3 分钟标黄、满 10 分钟标红
- **认领锁定**：点「接入」锁定给自己，其他坐席不可重复接入
- **回复署名**：坐席消息带工号名字，用户端显示「人工客服 · 小美」
- **释放 / 解决**：处理不完退回队列；处理完结并触发满意度评价
- **实时指标**：待接入量、我处理中、超时工单、今日已解决，10 秒自动刷新

### 管理端（`admin.html`）

- **数据概览**：累计会话 / 消息 / 平均满意度 / 好评率 / 待人工处理，满意度分布、意图分布、近 14 天趋势
- **数据分析看板**（阶段5 新增，仅对管理员开放）：
  - 工单量趋势折线（新建 / 转人工 / 已解决，14 天）
  - 意图标签占比环形图（含数量与百分比）
  - 坐席绩效表（接单量、平均首响、解决率、好评率，30 天窗口）
  - 知识缺口 Top 5，可一键跳到知识缺口页补库
  - 30 秒自动刷新；原生 SVG 绘制，无第三方图表库
- **对话记录**：状态筛选、分页、完整消息流（含联系方式与摘要）、人工回复、**导出 CSV**
- **知识库**：FAQ 增删改查，保存后前台即时生效
- **知识缺口**：统计近 30 天 FAQ 未命中的提问并按次数排序，一键「转为 FAQ」补进知识库

> 看板实现细节见 [`docs/stage5-dashboard.md`](docs/stage5-dashboard.md)，接口为 `cs_admin_dashboard`（一次返回趋势 / 意图 / 坐席 / 缺口四块数据）。

---

## 系统架构

```mermaid
flowchart TB
    subgraph 浏览器["浏览器（纯静态，无构建）"]
        U["用户端 index.html<br/>对话 / 意图 / 评分"]
        A["工作台 admin.html<br/>工单队列 / 统计 / 知识库"]
    end

    subgraph 后端["Node 后端（零依赖）"]
        API["server.js 路由<br/>/api/rpc · /api/chat · /api/faqs · /api/models · /health"]
        RPC["rpc.js<br/>27+ handlers (cs_*)<br/>防爆破 · 工单锁"]
        REPLY["reply.js<br/>本地应答引擎 (SSE)<br/>task 分流"]
        AN["analytics/<br/>DSL 白名单 + 只读执行"]
        STORE[("store.js<br/>data/store.json<br/>按 schema.sql 建模")]
    end

    U -- "POST /api/chat (SSE)<br/>GET /api/faqs" --> API
    A -- "POST /api/rpc<br/>cs_admin_* / cs_agent_*" --> API
    API --> RPC
    API --> REPLY
    REPLY --> AN
    RPC --> STORE
    REPLY --> STORE
```

**关键设计**：前端不直连数据表。所有读写都经过 `server/rpc.js` 的 handler 层，handler 内部校验访客密钥或坐席口令后才落 `data/store.json`。`schema.sql`（PostgreSQL 建库脚本）保留着，需要迁移到数据库时可直接用。

---

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 前端 | 原生 HTML + CSS + JavaScript | 无框架、无打包、无运行时依赖，改完刷新即生效 |
| 后端 | Node ≥ 18（零依赖） | `server.js` 单入口，无需 `npm install` |
| 数据 | `data/store.json` | 按 `schema.sql` 7 张表建模，原子整文件替换 |
| 模型 | `server/reply.js` 本地应答引擎 | 确定性模板作答，SSE 流式，不编造数字；可选接真实模型 |
| CI/CD | GitHub Actions | 语法检查 + 测试 + 密钥扫描 + 构建静态站点 + Pages 发布 |
| 部署 | systemd + Nginx | 单机方案，Node 监听 127.0.0.1，Nginx 透传 TLS 与真实 IP |

---

## 目录结构

```
kubao-support-agent/
├── index.html            # 用户端聊天页
├── admin.html            # 坐席 / 管理后台（按口令区分角色）
├── 404.html              # 404 兜底：3 秒回首页，兼容子路径部署
├── server.js             # HTTP 服务入口：路由/CORS/traceId/SIGTERM 优雅退出
├── package.json          # 版本 + scripts（零依赖）
├── .env.example          # 通用环境变量模板（入库）
├── .gitignore
├── LICENSE               # MIT
├── schema.sql            # PostgreSQL 建库脚本（保留供迁移用）
├── assets/
│   ├── runtime.js        # 运行模式声明：'server' / 'static'
│   ├── config.js         # 客户端初始化 + RPC 封装 + 模式判定
│   ├── kb.js             # 意图规则、FAQ 检索、提示词构造
│   ├── app.js            # 聊天页逻辑：对话、流式、摘要、转人工、评分
│   ├── admin.js          # 后台逻辑：队列、认领、统计、知识库、导出
│   ├── dashboard.js      # 看板图表：原生 SVG 折线/环形图
│   ├── styles.css        # 通用样式
│   └── admin.css         # 后台图表与队列样式
├── server/               # 后端模块
│   ├── config.js           三环境配置 + 生产强校验
│   ├── logger.js           结构化日志 + traceId + 脱敏
│   ├── store.js            JSON 文件存储（按 schema.sql 建模）
│   ├── rpc.js              27+ handlers + 防爆破 + 工单锁
│   ├── reply.js            本地应答引擎 + task 分流
│   ├── client-ip.js        可信代理判定
│   ├── health.js            /health 健康检查
│   └── analytics/          数据分析 Agent
│       ├── dsl.js           白名单 DSL（8 指标）
│       ├── parse.js         规则解析
│       ├── execute.js       只读执行器
│       ├── rate.js          独立限流
│       └── index.js
├── scripts/
│   ├── package.sh          # 服务器部署包（git ls-files + sha256）
│   └── build-pages.sh      # Pages 静态包（改写模式 + 自检）
├── deploy/               # Linux 部署
│   ├── install.sh / rollback.sh / backup.sh
│   ├── systemd/ / nginx/ / env/
├── env/                  # 三套环境模板（*.env.example）
├── test/                 # 134 项自测（node --test）
├── docs/                 # 文档 + 截图
│   ├── OVERVIEW.md        # 项目总览
│   ├── DEVELOP.md         # 开发维护手册
│   ├── DELIVER.md          # 交付清单
│   ├── stage1~7-*.md       # 各阶段交付文档
│   └── screenshots/
└── .github/workflows/
    └── deploy-pages.yml  # CI：语法检查 + 测试 + 密钥扫描 + 构建 + Pages 发布
```

---

## 部署步骤

### 第 1 步：本地预览

```bash
git clone <repo> && cd kubao-support-agent
node server.js            # 默认 development，打开 http://localhost:8080
```

首次启动自动初始化 `data/store.json`（12 条 FAQ / 3 个演示订单 / 2 个坐席）。

### 第 2 步：配置口令

开发模式下用默认口令即可。生产环境：

```bash
# env/production.env 或环境变量
CS_ADMIN_CODE=你的强口令
CS_AGENT_CODE_1=坐席1口令
CS_AGENT_CODE_2=坐席2口令

NODE_ENV=production node server.js    # 强校验：口令非默认值，CORS 禁 *
```

> 生产模式校验不通过会拒绝启动，退出码 1。

### 第 3 步：本地验证

```bash
npm start            # 等价于 node server.js
# 打开 http://localhost:8080
```

> [!NOTE]
> 本地预览即可完整体验全部功能（对话、工单、看板、导出），无需额外服务。

### 第 4 步：发布上线

**A. 发布到 Linux 服务器（推荐，功能完整）**

`Node（systemd 常驻）+ Nginx（TLS 与真实 IP 透传）`，零容器、零 npm 依赖。步骤与命令清单见 [`docs/stage6-deploy.md`](docs/stage6-deploy.md)：

```bash
./scripts/package.sh                       # 本地打包（含 sha256 与包内容自检）
scp dist/kubao-support-*.tar.gz* <user>@<host>:/tmp/
sudo /opt/kubao-support/app/deploy/install.sh -p /tmp/kubao-support-*.tar.gz
```

**B. 发布到 GitHub Pages（自动，仅静态预览）**

1. 仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**
2. push 到 `main`，或到 **Actions → Deploy to GitHub Pages → Run workflow** 手动触发
3. 站点地址不变：`https://cry-88.github.io/kubao-support-agent/`

CI 会先跑「语法检查 → 入口完整性 → `npm test` → 密钥扫描 → schema 结构检查」，再执行 `scripts/build-pages.sh` 构建，最后只把 `dist-pages/` 作为产物发布。本地想先验证：

```bash
bash scripts/build-pages.sh     # 产出 dist-pages/
python -m http.server 8099 -d dist-pages   # 打开 http://localhost:8099
```

**静态版怎么来的（不维护第二套前端）**

页面文件与服务器版完全同源，唯一差异是 `assets/runtime.js`：

| 文件 | 服务器版 | Pages 静态版 |
|---|---|---|
| `assets/runtime.js` | `window.__CS_MODE__ = 'server'` | 构建时改写为 `'static'` |
| `index.html` / `admin.html` / `assets/*` | 同一份 | 同一份 |

> [!WARNING]
> **Pages 版本只做静态预览，不跑任何业务。** 站点上没有后端进程，构建产物也不含 `server/`、`deploy/`、`data/`、`.env` 等任何文件（构建脚本有自检，混入即失败）。
> 代码已内置**静态预览模式**：`__CS_MODE__ === 'static'` 时不发起任何后端请求，禁用输入框与登录按钮，页面顶部提示「静态预览模式」。想看真实对话、工单与看板数据，必须访问服务器部署版本。

> [!NOTE]
> 若确实要让静态站点连接一台远程后端（后端需放行该 Origin）：
> `CS_PAGES_API_BASE=https://support.example.com bash scripts/build-pages.sh`
> 此时模式为 `server` 且 `__CS_API_BASE__` 指向该地址，页面行为与服务器版一致。

---

## 环境与配置（三套环境）

用 `NODE_ENV` 切换 `development` / `test` / `production`，配置全部走环境变量，代码里不写死。

**加载优先级（后者覆盖前者）**：内置 profile 默认值 → `env/<NODE_ENV>.env` → 项目根 `.env` → 真实进程环境变量。

```bash
cp env/development.env.example env/development.env
NODE_ENV=development node server.js      # 开发：debug 日志、放开 localhost 跨域、不缓存
NODE_ENV=test node server.js             # 测试：warn 日志、无跨域、限流放宽
NODE_ENV=production node server.js       # 生产：强校验 + info 日志 + 静态缓存
```

| 配置维度 | development | test | production |
| --- | --- | --- | --- |
| 日志等级 | `debug` | `warn` | `info` |
| 静态缓存 | 不缓存 | 不缓存 | `max-age=3600`（HTML 永远 `no-store`） |
| CORS | `localhost:8080/8099` | 仅同源 | 仅同源，**禁止 `*`** |
| 聊天限流 | 12 条/分/访客 | 60 | 12 |
| 分析限流 | 30 次/分 | 60 | 30 |
| 请求体上限 | 2MB | 2MB | 1MB |
| 口令校验 | 允许默认值（仅告警） | 允许 | **必须显式设置且非默认值，否则拒绝启动** |

配置文件：

- `.env.example` — 变量总表 + 说明（入库）
- `env/development.env.example` / `env/test.env.example` / `env/production.env.example` — 三套环境模板（入库）
- `env/*.env`、`.env` — 真实值，**已被 `.gitignore` 忽略**

主要变量（完整列表见 `.env.example`）：

| 变量 | 用途 | 默认 |
| --- | --- | --- |
| `NODE_ENV` | 环境切换 | `development` |
| `PORT` / `HOST` | 监听地址 | `8080` / `0.0.0.0` |
| `CS_STATIC_ROOT` | 静态资源根目录 | `.` |
| `CS_NOT_FOUND_PAGE` | 404 兜底页 | `404.html` |
| `CS_STATIC_CACHE` | 是否允许浏览器缓存静态资源 | 按环境 |
| `CS_API_BASE` | 前端接口基址（留空=同源） | 空 |
| `CS_CORS_ORIGINS` | 跨域白名单（逗号分隔） | 按环境 |
| `CS_CHAT_RATE` / `CS_ANALYTICS_RATE` | 限流阈值 | 见上表 |
| `CS_LOGIN_MAX_PER_CODE` / `CS_LOGIN_MAX_GLOBAL` / `CS_LOGIN_WINDOW_MIN` | 登录防爆破 | 5 / 20 / 10 |
| `CS_LOG_LEVEL` | 日志等级 | 按环境 |
| `CS_ADMIN_CODE` / `CS_AGENT_CODE_1/2` | 口令（仅首启初始化） | — |
| `CS_DATA_DIR` | 数据目录 | `data` |
| `CS_MODEL_PROVIDER` / `CS_MODEL_NAME` / `CS_MODEL_BASE_URL` / `CS_MODEL_API_KEY` | 模型通道（留空用本地引擎） | `local` |

> [!NOTE]
> 启动后可以 `GET /api/runtime-config` 查看当前环境、限流阈值、模型是否已配置——它**只返回非敏感信息**，口令与密钥永远不会出现在响应里。

---

## 日志、链路与健康检查

日志按环境切换格式：开发 `text`（可读，含堆栈），生产 `json`（一行一事件，交给 journald / 采集器，不带堆栈）。等级 `debug / info / warn / error` 由 `CS_LOG_LEVEL` 控制，生产默认 `info`，即已关闭 debug。

**链路追踪**：每个请求生成 `traceId`（或复用调用方传入的 `X-Request-Id`），通过 `AsyncLocalStorage` 贯穿整条异步链路，响应头回写 `X-Trace-Id`。

```bash
curl -H 'X-Request-Id: manual-trace-042' http://localhost:8080/api/models -D -
# X-Trace-Id: manual-trace-042

# 按 trace 还原一次请求
grep 'manual-trace-042' server.log | jq -c '{ts,module,event,msg,result}'
```

**关键事件**（`event` 字段，可直接检索）：

| event | 说明 |
| --- | --- |
| `http.request` | 每个请求一条：方法、路径、状态码、耗时、来源地址 |
| `rpc.call` | 每次 RPC：函数名、结果、耗时、会话 id、访客 key（打码） |
| `auth.login` / `auth.lockout` | 登录成功 / 失败 / 触发防爆破 |
| `ticket.claim` / `ticket.release` / `ticket.resolve` | 工单锁变更（含冲突 `result=conflict`） |
| `rate_limit` | 聊天或分析查询触发限流 |
| `model.call` | 应答生成耗时与字数 |
| `analytics.query` | 分析查询审计（谁、问了什么、命中哪个指标） |

> 轮询类接口（`cs_guest_poll`、`cs_agent_queue`）的调用日志降到 `debug`，避免生产日志被轮询刷满。

**健康检查**：`GET /health`（无需鉴权）

```bash
curl -s http://localhost:8080/health | jq
# { "status": "ok", "checks": { "config": {...}, "data_dir": {"writable": true}, "store": {"ok": true} }, "counts": {...} }
```

全部检查通过返回 `200`，任一失败（数据目录不可写、store 读写报错）返回 `503`。**不返回**绝对路径与任何口令 / 密钥，可直接给探针使用。

**异常收敛**：参数错误 400、请求体超限 413、业务失败 `{ok:false,error}`、未预料异常 500——响应体永远是中文人话，堆栈只进日志；500 响应里带 `trace_id` 便于对齐日志。

---
## 部署到 Linux 服务器

单机方案：**Node（systemd 常驻，只监听 127.0.0.1）+ Nginx（TLS 与真实 IP 透传）**，零容器、零 npm 依赖。

```bash
./scripts/package.sh                       # 本地打包（含 sha256 与包内容自检）
scp dist/kubao-support-*.tar.gz* <user>@<host>:/tmp/

# 服务器
sudo /opt/kubao-support/app/deploy/install.sh -p /tmp/kubao-support-*.tar.gz
sudo systemctl status kubao-support
curl -s http://127.0.0.1:8080/health
```

| 场景 | 配置文件 |
| --- | --- |
| 域名 + HTTPS | `deploy/nginx/kubao-support.conf`（含 ACME 校验、HSTS、SSE 关闭缓冲） |
| 裸 IP / 内网 | `deploy/nginx/kubao-support-ip.conf`（无 TLS，仅内网或临时演示） |

日常操作：

```bash
sudo deploy/rollback.sh --list        # 看有哪些版本
sudo deploy/rollback.sh               # 回滚到上一版（只切代码，不动 data/）
sudo deploy/backup.sh                 # 备份数据与环境变量（权限 600，保留 14 天）
sudo journalctl -u kubao-support -f   # 结构化日志
```

目录规划、命令清单（含风险等级与回滚方式）、上线检查清单见 [`docs/stage6-deploy.md`](docs/stage6-deploy.md)。

> **单实例约束**：数据存于单个 JSON 文件（整文件原子替换），多进程会互相覆盖。需要水平扩展请迁移到 PostgreSQL（`schema.sql` 已就绪）。

---

## 界面截图

截图统一放在 [`docs/screenshots/`](docs/screenshots/)，文件名与页面一一对应：

| 文件 | 对应页面 | 建议内容 |
|---|---|---|
| `01-chat.png` | `index.html` | 用户端对话，含意图标签、FAQ 命中标记、停止生成按钮 |
| `02-handoff.png` | `index.html` | 转人工等待态（含等待计时）与坐席已接入态 |
| `03-rating.png` | `index.html` | 结束咨询后的 1–5 星评价卡 |
| `04-queue.png` | `admin.html` → 工单队列 | 待接入 / 我处理中 / 超时标红 |
| `05-overview.png` | `admin.html` → 数据概览 | 满意度分布、意图分布、14 天趋势（**已提供**，含阶段5 新增的四块看板） |
| `06-faq.png` | `admin.html` → 知识库 | FAQ 增删改表单与列表 |

截图规范：1440×900 或 1280×800，裁掉浏览器边框，PNG 格式，单张小于 500KB。放好后把上面的文件引用替换成图片链接，README 会自动展示。

---

## 数据模型

| 表 | 用途 | 访问方式 |
|---|---|---|
| `cs_conversations` | 会话主表：状态、意图、满意度、坐席、摘要 | 仅函数 |
| `cs_messages` | 消息：`user` / `assistant` / `agent` / `system` | 仅函数 |
| `cs_faqs` | FAQ 知识库（问题、答案、分类、关键词、优先级） | 公开只读 + 管理员写 |
| `cs_orders` | 演示订单数据 | 仅 `cs_lookup_order` |
| `cs_agents` | 坐席账号（姓名、工号口令、状态） | 仅函数 |
| `cs_settings` | 服务端配置（管理员口令等） | 仅函数 |
| `cs_login_attempts` | 登录失败审计，用于防爆破 | 仅函数 |

会话状态机：`active`（智能应答）→ `handoff`（待人工 / 人工处理中）→ `closed`（已结束并评价）。

---

## 服务端接口（RPC）

所有 RPC 经 `POST /api/rpc` 分发，body 为 `{ func: "cs_xxx", params: {...} }`，返回统一结构 `{ ok: boolean, ... }`。

| 分组 | 函数 |
|---|---|
| 访客侧（校验 `guest_key`） | `cs_guest_start` / `list` / `messages` / `poll` / `append` / `update` / `rate` / `contact` / `summary_save` |
| 工具 | `cs_lookup_order` |
| 坐席侧（校验坐席口令） | `cs_console_login`、`cs_operator`、`cs_agent_queue` / `claim` / `release` / `messages` / `reply` / `resolve` |
| 管理侧（校验管理员口令） | `cs_admin_stats` / `conversations` / `messages` / `reply` / `resolve` / `faq_list` / `faq_save` / `faq_delete` / `gaps` / `export` / `csrf_token` / `dashboard` / `analytics` / `analytics_meta` |

---

## 安全模型

| 层次 | 做法 |
|---|---|
| 前端 | 只持有公开配置；不含任何长期密钥 |
| 后端 | `server/rpc.js` handler 层校验访客密钥或坐席口令；数据按 `guest_key` 隔离 |
| 登录 | 同口令 10 分钟 5 次失败锁定、全局 20 次锁定，失败延迟 0.2s，只存 `md5` 不存明文；按 IP 计数防爆破 |
| 模型 | 本地应答引擎不编造订单/金额/物流；模型输出按纯文本渲染，不执行、不拼 SQL |
| 输入 | 系统提示与用户输入分离，用户消息进 `user` 角色，降低提示注入风险 |
| 可信代理 | 默认不信 XFF；仅当对端在 `CS_TRUSTED_PROXIES` 内才读，且只取最后一段 |
| CI | 每次推送扫描 `sk-` / `ghp_` / `AKIA` / 私钥头，命中即阻断部署 |

---

## 配置说明

| 项 | 位置 | 修改方式 |
|---|---|---|
| 管理员口令 | `data/store.json` → `settings.admin_code` | 编辑 JSON；或删文件后设 `CS_ADMIN_CODE` 重启 |
| 坐席账号 | `data/store.json` → `agents` | 编辑 JSON；或设 `CS_AGENT_CODE_1/2` 重启 |
| 营业时间 | `assets/app.js` → `isBusinessHours()` | 默认 9:00–21:00（UTC+8） |
| 摘要阈值 | `assets/app.js` → `SUMMARY_AFTER` / `SUMMARY_STEP` | 默认 12 条触发、每 6 条重算 |
| 限流阈值 | 前端 `RATE` + 服务端 | 前端 10/分钟，服务端 12/分钟 |
| 运行模式 | `assets/runtime.js` | `server`（默认）/ `static`（Pages 构建时自动改写） |

---

## 分支策略

| 分支 | 用途 | 规则 |
|---|---|---|
| `main` | 稳定发布分支 | 对应线上 Pages；只从 `dev` 合并，不直接提交 |
| `dev` | 开发集成分支 | 所有 `feature/*` 阶段先合并到此验收 |
| `feature/stageN-*` | 单阶段开发 | 一个阶段一个分支，验收通过后合入 `dev` |

提交规范（中文）：

- `feat(scope): 说明` — 新功能
- `fix(scope): 说明` — 修复
- `merge: 说明` — 阶段合并
- `docs(scope): 说明` — 文档
- `chore: 说明` — 杂项

---

## 已知限制与路线图

**当前限制**

- 访客身份基于浏览器 `localStorage` 的随机密钥，清缓存或换设备会丢失历史
- 摘要是全量重压，超长会话仍有优化空间（可改为旧摘要 + 新增消息的增量合并）
- 限流以单浏览器为主，分布式刷量需在网关层加固
- GitHub Pages 版本是**静态预览模式**：页面与服务器版同源，但不发任何后端请求、后端代码也不进构建产物，只能看界面

**后续可做**

- [ ] 超时无人接入的自动告警（>5 分钟推送管理员）
- [ ] 截图上传，技术支持场景直接看报错画面
- [ ] 工单质检评分与首响时长、解决率等运营指标
- [ ] 会话码跨设备续聊
- [ ] 敏感信息（手机号、证件号）进模型前脱敏

---

## License

[MIT](LICENSE) © 2026 cry-88
