# 开发维护手册

---

## 1. 环境要求

- Node ≥ 18（已在 22.22.2 上验证）
- 无需 `npm install`（零依赖）
- Git（用于提交和 `package.sh` 的 `git ls-files` 清单）

---

## 2. 本地启动服务端

```bash
# 开发模式（默认）
node server.js
# 等价于
npm start

# 切环境
NODE_ENV=production node server.js    # 生产：强校验 + info 日志 + 静态缓存
NODE_ENV=test node server.js          # 测试：warn 日志 + 限流放宽

# 打开
# http://localhost:8080            用户端
# http://localhost:8080/admin.html 坐席/管理后台
```

默认口令（首次启动写入 `data/store.json`）：

| 角色 | 口令 |
|---|---|
| 管理员 | `kubao-admin-2026` |
| 坐席·客服A | `kubao-agent-1` |
| 坐席·客服B | `kubao-agent-2` |

改口令：编辑 `data/store.json` 里 `settings[0].value` / `agents[].code`，或删除该文件后用环境变量 `CS_ADMIN_CODE`、`CS_AGENT_CODE_1/2` 重新初始化。

> 生产环境必须设置 `CS_ADMIN_CODE` 且非默认值，否则 `config.js` 强校验会拒绝启动（退出码 1）。

---

## 3. 本地构建 Pages 静态产物

```bash
# 构建静态版（默认 static 模式，不发任何请求）
bash scripts/build-pages.sh

# 指定远程后端（模式切回 server）
CS_PAGES_API_BASE=https://support.example.com bash scripts/build-pages.sh

# 本地预览
cd dist-pages && python -m http.server 8099
# 打开 http://localhost:8099
```

产物内容自检（构建脚本内置）：

- 不得出现 `server.js`、`server/`、`deploy/`、`data/`、`test/`、`scripts/`、`.env*`
- 必须包含 `index.html`、`admin.html`、`404.html`、`.nojekyll`、`assets/runtime.js`
- `assets/runtime.js` 必须是目标模式

---

## 4. 服务器部署包构建

```bash
bash scripts/package.sh
# 产出 dist/kubao-support-<version>-<sha>-<date>.tar.gz + .sha256
```

打包清单基于 `git ls-files`（只打已提交内容），排除 `data/`、`.git`、`node_modules/`、`dist/`、`test/`、`.workbuddy/`、`.github/`。

---

## 5. 全量测试

```bash
npm test    # 134 项
```

测试基于 Node 原生 `node:test`，无需额外依赖。覆盖配置、IP 安全、日志、分析、看板、聊天分流、部署、Pages、HTTP 层。

个别调试：

```bash
# 只跑 Pages 测试
node --test test/pages.test.js

# 只跑分析测试
node --test test/analytics.test.js
```

---

## 6. CI 流程与失败排查

CI 定义在 `.github/workflows/deploy-pages.yml`，两个 Job：

### check（语法检查 + 测试 + 扫描）

| 步骤 | 失败原因 | 排查 |
|---|---|---|
| `node --check` | JS 语法错 | 看报错行号 |
| 入口文件完整性 | 缺少必要文件 | 对照 `test/pages.test.js` 的清单 |
| `npm test` | 测试失败 | 拉到本地复现 |
| 密钥扫描 | 代码含 `sk-` / `ghp_` / `AKIA` / 私钥头 | 删掉或移到 `.env` |
| schema 结构检查 | 函数 <28 或表 <7 | 检查 `schema.sql` |

### deploy（构建 + 发布）

| 步骤 | 失败原因 | 排查 |
|---|---|---|
| `build-pages.sh` | 构建脚本报错 | 拉到本地 `bash scripts/build-pages.sh` |
| upload-pages-artifact | 权限问题 | Settings → Pages → Source = GitHub Actions |
| deploy-pages | Pages 未启用 | Settings → Pages 确认 |

CI 失败不会影响已发布的站点（只有 deploy 成功才会替换）。

---

## 7. 开发约定

### 文件修改边界

| 区域 | 文件 | 能否改前端逻辑 |
|---|---|---|
| 用户端 | `index.html` + `assets/app.js` / `kb.js` | 能 |
| 后台 | `admin.html` + `assets/admin.js` / `dashboard.js` | 能 |
| 模式声明 | `assets/runtime.js` | 仅改模式值，不改结构 |
| 客户端初始化 | `assets/config.js` | 改接口封装，不改业务逻辑 |
| 后端 | `server.js` + `server/*.js` | 自由改 |
| 部署 | `deploy/*` / `scripts/*` | 自由改 |

### 前端与后端的约定

前端通过 `assets/config.js` 的 `api(path)` 函数构造请求地址。

- `server` 模式：`api('/api/rpc')` → `/api/rpc`（同源）
- `server` + `__CS_API_BASE__`：`api('/api/rpc')` → `https://support.example.com/api/rpc`（跨域）
- `static` 模式：不调用 `api()`，不发任何请求

### 测试约定

- 新功能必须配测试
- 测试文件命名：`test/<scope>.test.js`
- `package.json` 的 `test` 脚本里加新文件名

### 提交规范

```
feat(scope): 中文说明
fix(scope): 中文说明
merge: 说明
docs(scope): 说明
chore: 说明
```

---

## 8. 常见问题排查

### 服务启动失败

```bash
# 看日志
node server.js 2>&1 | head -20

# 生产模式校验失败？检查必填变量
NODE_ENV=production node server.js
# 如果报 "CS_ADMIN_CODE 未设置" → 设环境变量
# 如果报 "CORS 禁止 *" → 检查 CS_CORS_ORIGINS
```

### 测试失败

```bash
# 看哪个子测试失败
npm test 2>&1 | grep -A5 "not ok"
```

### 构建失败

```bash
# Pages 构建
bash scripts/build-pages.sh
# 看自检报错，通常是缺文件或混入了后端文件

# 服务器打包
bash scripts/package.sh
# 需要 git 仓库且有提交
```

### 端口被占用

```bash
# 找占用 8080 的进程
lsof -i :8080   # Linux/Mac
netstat -ano | findstr :8080   # Windows

# 换端口
PORT=9090 node server.js
```