# 项目总览

> **版本：1.7.0** · 分支：`dev` · 最后更新：2026-10-22

---

## 1. 这是什么

「哭包·智能客服 Agent」——一个可以直接上线的在线智能客服 Web 应用。功能覆盖多轮对话、FAQ 知识库检索、意图识别、自动转人工、坐席工单队列、长会话摘要、管理后台、满意度统计与工单数据分析。

核心特征：**零 npm 依赖、零构建步骤、单端口 HTTP**。Node ≥ 18 即可运行。

---

## 2. 两大部署模式

| | 服务器部署版本 | GitHub Pages 静态预览版 |
|---|---|---|
| **适用场景** | 生产上线，功能完整 | 界面展示、招聘演示 |
| **后端** | `node server.js`（systemd 常驻） | 无 |
| **数据** | `data/store.json`（本地文件） | 无 |
| **模式声明** | `window.__CS_MODE__ = 'server'` | `window.__CS_MODE__ = 'static'` |
| **前端请求** | 正常发 `/api/*` | **一个都不发** |
| **打包脚本** | `scripts/package.sh` → `dist/` | `scripts/build-pages.sh` → `dist-pages/` |
| **CI** | 不经过 CI | `.github/workflows/deploy-pages.yml` |
| **站点** | 你的域名 | `https://cry-88.github.io/kubao-support-agent/` |

**模式判定机制**（`assets/config.js` → `assets/runtime.js`）：

1. 优先读 `window.__CS_MODE__`（仅接受 `'server'` / `'static'`）
2. 声明缺失或非法 → 回退 `*.github.io` 域名判断
3. 都不是 → 默认 `'server'`

`runtime.js` 必须**先于** `config.js` 加载（`index.html` / `admin.html` 已保证，有测试断言）。

**可对接远程后端**：Pages 静态版构建时传 `CS_PAGES_API_BASE=https://support.example.com`，模式切为 `server` 并直连该后端（需后端放行 Origin）。

---

## 3. 架构与模块划分

```
kubao-support-agent/
│
├── 前端（纯静态，无框架无构建）
│   ├── index.html           用户端聊天页
│   ├── admin.html           坐席/管理后台
│   ├── 404.html             404 兜底
│   └── assets/
│       ├── runtime.js       运行模式声明（server/static）
│       ├── config.js        客户端初始化 + RPC 封装 + 模式判定
│       ├── kb.js             意图规则、FAQ 检索、提示词构造
│       ├── app.js            聊天逻辑：对话/流式/摘要/转人工/评分
│       ├── admin.js          后台逻辑：队列/认领/统计/知识库/导出
│       ├── dashboard.js      看板图表：原生 SVG 折线/环形图
│       ├── styles.css        通用样式
│       └── admin.css         后台样式
│
├── 后端（零依赖 Node ≥ 18）
│   ├── server.js             HTTP 服务入口：路由/CORS/traceId/SIGTERM 优雅退出
│   ├── server/
│   │   ├── config.js       三 profile 构建器 + 生产强校验
│   │   ├── logger.js       结构化日志 + AsyncLocalStorage traceId + 脱敏
│   │   ├── store.js         JSON 文件存储（按 schema.sql 7 张表建模）
│   │   ├── rpc.js           27+ handlers（对应 cs_* 函数）+ 登录防爆破 + 工单锁
│   │   ├── reply.js         本地应答引擎（SSE 流式，不编造数字）+ task 分流
│   │   ├── client-ip.js     可信代理判定（只取 XFF 最后一段）
│   │   ├── health.js        /health 健康检查
│   │   └── analytics/       数据分析 Agent
│   │       ├── dsl.js       白名单 DSL 定义（8 指标，1–90 天，≤200 行）
│   │       ├── parse.js     自然语言→DSL 规则解析
│   │       ├── execute.js   只读执行器
│   │       ├── rate.js      独立限流
│   │       └── index.js     统一入口
│   └── schema.sql            原始 SQL 建库脚本（PostgreSQL，保留供迁移用）
│
├── 构建/部署
│   ├── scripts/
│   │   ├── package.sh       服务器部署包（git ls-files + sha256 + 自检）
│   │   └── build-pages.sh   Pages 静态包（改写模式 + 产物自检）
│   └── deploy/
│       ├── install.sh       幂等安装：建用户/解包/切软链/装 unit/健康检查
│       ├── rollback.sh     版本回滚：切软链 + 重启（不动 data/）
│       ├── backup.sh        备份 data/ + env（600 权限，保留 14 天）
│       ├── systemd/          systemd unit
│       ├── nginx/            域名 HTTPS + 裸 IP 两套 Nginx 配置
│       └── env/              生产环境变量模板
│
├── CI
│   └── .github/workflows/deploy-pages.yml
│
├── 测试（node --test，134 项）
│   └── test/
│       ├── config.test.js
│       ├── client-ip.test.js
│       ├── logger.test.js
│       ├── analytics.test.js
│       ├── dashboard.test.js
│       ├── chat-task.test.js
│       ├── deploy.test.js
│       ├── pages.test.js
│       ├── http.test.js
│       └── fixtures.js
│
└── 文档
    └── docs/
        ├── OVERVIEW.md          ← 本文件
        ├── DEVELOP.md           开发维护手册
        ├── DELIVER.md           交付清单
        ├── stage1-assessment.md  阶段1 初始评估
        ├── stage2-analytics.md     阶段2 数据分析 Agent
        ├── stage3-config.md        阶段3 多环境配置
        ├── stage4-observability.md 阶段4 可观测性
        ├── stage5-dashboard.md     阶段5 看板升级
        ├── stage6-deploy.md        阶段6 Linux 部署
        ├── stage7-pages.md         阶段7 Pages 静态版
        └── screenshots/            界面截图
```

---

## 4. 数据流

### 用户端聊天

```
浏览器 app.js
  │
  ├─ 启动时 loadFaqs() → GET /api/faqs
  ├─ pickModel() → GET /api/models
  │
  └─ 发送消息 → POST /api/chat (SSE)
       │
       server.js 路由 → reply.js
         │
         ├─ task=classify → 返回意图 JSON
         ├─ task=summary   → 返回摘要
         ├─ task=analytics → 走 analytics/ 链路
         └─ task=answer (默认) →
              ├─ rpc.js: cs_guest_append (写消息 + 限流)
              ├─ kb.js 逻辑（前端已执行）：FAQ 检索 + 意图标签
              ├─ 订单查询：cs_lookup_order（正则提取订单号）
              ├─ 本地应答引擎模板化作答（不编造数字）
              └─ SSE 逐字推送，可 abort
```

### 工单与后台

```
admin.html
  │
  ├─ 登录 → POST /api/rpc { cs_console_login }
  │         rpc.js: 校验口令 + 防爆破（5次/码/10分, 20次/全局）
  │
  ├─ 队列轮询 → cs_agent_queue (10s)
  ├─ 接入工单 → cs_agent_claim (互斥锁)
  ├─ 回复/解决 → cs_agent_reply / cs_agent_resolve
  │
  └─ 管理员：
      ├─ cs_admin_stats / cs_admin_dashboard → 看板数据
      ├─ cs_admin_analytics → DSL 查询 + CSV 导出
      ├─ cs_admin_faq_save/delete → 知识库管理
      └─ cs_admin_export → 全量 CSV 导出
```

---

## 5. 分支策略

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

## 6. 阶段文档索引

| 阶段 | 文档 | 主要交付 |
|---|---|---|
| 1 | [stage1-assessment.md](stage1-assessment.md) | 初始评估、本地后端基线 |
| 2 | [stage2-analytics.md](stage2-analytics.md) | 数据分析 Agent（DSL 白名单 + 规则解析 + 只读执行） |
| 3 | [stage3-config.md](stage3-config.md) | 三环境配置（dev/test/prod）+ 生产强校验 |
| 4 | [stage4-observability.md](stage4-observability.md) | 结构化日志 + traceId + /health |
| 5 | [stage5-dashboard.md](stage5-dashboard.md) | 管理看板升级（趋势/意图/坐席/缺口，原生 SVG 图表） |
| 6 | [stage6-deploy.md](stage6-deploy.md) | Linux 部署方案（systemd + Nginx + 可信代理） |
| 7 | [stage7-pages.md](stage7-pages.md) | Pages 静态版适配 + CI 改造（显式运行模式 + 只发布构建产物） |

---

## 7. 测试

```bash
npm test    # 134 项全量
```

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `config.test.js` | 3+ | 三 profile 构建、生产强校验 |
| `client-ip.test.js` | 9+ | 可信代理判定 + XFF 最后段 |
| `logger.test.js` | 多条 | 格式切换、traceId 贯穿、脱敏 |
| `analytics.test.js` | 多条 | DSL 解析、指标白名单、限流、CSV 导出 |
| `dashboard.test.js` | 多条 | 看板数据结构正确性 |
| `chat-task.test.js` | 多条 | /api/chat task 分流 |
| `deploy.test.js` | 9+ | 打包脚本、systemd unit、Nginx 配置 |
| `pages.test.js` | 10 | 模式判定、加载顺序、构建产物、CI 契约 |
| `http.test.js` | 3+ | HTTP 层路由、CORS、健康检查 |