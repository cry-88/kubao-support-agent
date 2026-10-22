# 项目交付清单

---

## 一、服务器部署交付包

由 `scripts/package.sh` 产出，基于 `git ls-files` 清单打包，排除测试、文档截图、构建产物。

### 包含

| 类别 | 文件 | 用途 |
|---|---|---|
| **入口** | `server.js` | HTTP 服务启动入口 |
| **后端核心** | `server/config.js` | 三 profile 配置构建器 + 生产强校验 |
| | `server/logger.js` | 结构化日志 + traceId + 脱敏 |
| | `server/store.js` | JSON 文件存储（按 schema.sql 建模） |
| | `server/rpc.js` | 27+ RPC handlers + 防爆破 + 工单锁 |
| | `server/reply.js` | 本地应答引擎 + task 分流 |
| | `server/client-ip.js` | 可信代理判定 |
| | `server/health.js` | /health 健康检查 |
| **数据分析** | `server/analytics/dsl.js` | 白名单 DSL 定义 |
| | `server/analytics/parse.js` | 自然语言→DSL 解析 |
| | `server/analytics/execute.js` | 只读执行器 |
| | `server/analytics/rate.js` | 独立限流 |
| | `server/analytics/index.js` | 统一入口 |
| **前端** | `index.html` / `admin.html` / `404.html` | 页面 |
| | `assets/runtime.js` | 运行模式声明（`server`） |
| | `assets/config.js` | 客户端初始化 + RPC 封装 |
| | `assets/kb.js` | 意图规则 + FAQ 检索 |
| | `assets/app.js` | 聊天逻辑 |
| | `assets/admin.js` | 后台逻辑 |
| | `assets/dashboard.js` | 看板图表 |
| | `assets/styles.css` / `admin.css` | 样式 |
| **配置模板** | `.env.example` | 通用环境变量模板 |
| | `env/development.env.example` | 开发环境模板 |
| | `env/test.env.example` | 测试环境模板 |
| | `env/production.env.example` | 生产环境模板 |
| **数据库脚本** | `schema.sql` | PostgreSQL 建库（保留供迁移用） |
| **部署脚本** | `scripts/package.sh` | 打包 |
| | `deploy/install.sh` | 幂等安装 |
| | `deploy/rollback.sh` | 版本回滚 |
| | `deploy/backup.sh` | 数据备份 |
| | `deploy/systemd/kubao-support.service` | systemd unit |
| | `deploy/nginx/kubao-support.conf` | 域名 HTTPS + SSE |
| | `deploy/nginx/kubao-support-ip.conf` | 裸 IP 反代 |
| | `deploy/env/kubao-support.env.example` | 生产环境变量模板 |
| **元数据** | `package.json` | 版本号 + scripts |

### 不包含

| 排除项 | 原因 |
|---|---|
| `data/` | 业务数据，含口令，绝不入库 |
| `test/` | 测试代码不入生产线 |
| `.github/` | CI 配置不进服务器 |
| `.workbuddy/` | 开发工具内部文件 |
| `dist/` / `dist-pages/` | 构建产物 |
| `docs/` | 文档不入生产线（可选保留） |
| `node_modules/` | 零依赖，不存在 |

---

## 二、GitHub Pages 静态交付包

由 `scripts/build-pages.sh` 产出 `dist-pages/`，CI 只上传该目录。模式为 `static`，不发任何后端请求。

### 包含（12 文件，约 165K）

| 文件 | 用途 |
|---|---|
| `index.html` | 用户端页面（静态预览态） |
| `admin.html` | 后台页面（登录禁用） |
| `404.html` | 404 兜底 |
| `.nojekyll` | 禁用 Jekyll 处理 |
| `assets/runtime.js` | 运行模式声明（**构建时改写为 `static`**） |
| `assets/config.js` | 客户端初始化（静态态下不发请求） |
| `assets/kb.js` | 知识库逻辑 |
| `assets/app.js` | 聊天逻辑（静态态下禁用输入） |
| `assets/admin.js` | 后台逻辑（静态态下禁用登录） |
| `assets/dashboard.js` | 看板图表代码 |
| `assets/styles.css` | 通用样式 |
| `assets/admin.css` | 后台样式 |

### 不包含（构建脚本自检拦截）

| 排除项 | 自检规则 |
|---|---|
| `server.js` | 明确拦截 |
| `server/` 目录 | 拦截整目录 |
| `deploy/` 目录 | 拦截整目录 |
| `data/` 目录 | 拦截整目录 |
| `test/` 目录 | 拦截整目录 |
| `scripts/` 目录 | 拦截整目录 |
| `.env` / `.env.*` | 拦截 |
| `schema.sql` | 未复制 |

---

## 三、源码仓库

完整仓库（含测试、文档、CI、部署脚本）：

| 类别 | 数量 | 说明 |
|---|---|---|
| 后端 | 12 文件 | `server.js` + `server/*.js` + `server/analytics/*.js` |
| 前端 | 10 文件 | 3 HTML + 7 assets |
| 部署 | 8 文件 | `scripts/*` + `deploy/*` |
| 测试 | 10 文件 | 9 个 test + 1 个 fixtures |
| CI | 1 文件 | `deploy-pages.yml` |
| 配置模板 | 5 文件 | `.env.example` + `env/*.env.example` + `deploy/env/*` |
| 文档 | 9 文件 | `docs/` 7 阶段 + OVERVIEW + DEVELOP + 本文件 + screenshots/README |
| 元数据 | 3 文件 | `package.json` / `.gitignore` / `LICENSE` |
| **合计** | **约 58 文件** | `git ls-files` 统计 |

---

## 四、两套交付包对照

| 维度 | 服务器部署包 | Pages 静态包 |
|---|---|---|
| 产出脚本 | `package.sh` | `build-pages.sh` |
| 产出目录 | `dist/` | `dist-pages/` |
| 后端代码 | 包含 | **不包含** |
| 前端 | 包含 | 包含（只含页面与 assets） |
| 运行模式 | `server` | `static`（或 `server` + 远程后端） |
| 数据 | `data/store.json`（不打包） | 无 |
| 测试代码 | 不含 | 不含 |
| 部署脚本 | 包含 | 不含 |
| 典型大小 | ~280K（48 文件） | ~165K（12 文件） |
| 用途 | 生产上线 | 界面展示 |