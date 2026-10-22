# 阶段 3 · 多环境配置改造

> 目标：一套代码跑三套环境（development / test / production），配置与代码分离，环境差异只体现在配置里。
> 前端业务文件（`app.js` / `admin.js` / `kb.js`）仍然零改动；`assets/config.js` 仅新增一个"接口基址"读取点。

---

## 一、配置加载链路

```
server/config.js
   ├─ PROFILES            内置默认值（只放与环境强相关的项）
   ├─ env/<NODE_ENV>.env  按环境提供，模板入库
   ├─ .env                本地个人覆盖，不入库
   └─ process.env         部署平台注入，优先级最高
        ↓
   build(env)  ← 纯函数，可被测试直接喂对象
        ↓
   深度冻结的只读配置对象
```

`build()` 与 `get()` 分开的意义：测试不需要改 `process.env`，也不会互相污染；`get()` 才负责读文件与缓存单例。

---

## 二、三套环境差异表

| 维度 | development | test | production |
| --- | --- | --- | --- |
| 日志等级 | `debug` | `warn` | `info` |
| 静态缓存 | 不缓存 | 不缓存 | `public, max-age=3600` |
| CORS | `localhost:8080 / 8099` | 仅同源 | 仅同源，禁 `*` |
| 聊天限流（条/分/访客） | 12 | 60 | 12 |
| 分析限流（次/分/操作者） | 30 | 60 | 30 |
| 请求体上限 | 2MB | 2MB | 1MB |
| 登录防爆破 | 5 / 20 / 10min | 同左 | 同左（可调） |
| 口令校验 | 允许默认值（启动告警） | 允许 | **缺省或默认值直接拒绝启动** |
| 静态根 / 404 页 | 项目根 / `404.html` | 同左 | 同左（可指向构建产物） |

HTML 在任何环境下都是 `no-store`——发布后必须立即生效，不参与缓存策略。

---

## 三、环境隔离落到了哪些地方

| 要求 | 实现 |
| --- | --- |
| 接口地址分离 | 服务端 `CS_API_BASE`（默认空=同源）；前端 `assets/config.js` 支持 `window.__CS_API_BASE__`，所有请求经 `api(path)` 拼接 |
| 模型密钥分离 | `CS_MODEL_PROVIDER/NAME/BASE_URL/API_KEY`；配置对象只暴露 `apiKeySet`/`enabled` 布尔，**密钥不出现在任何响应与日志** |
| 限流阈值分离 | 聊天、分析、登录三组阈值全部进配置，`rpc.js` 与 `analytics/index.js` 不再写死数字 |
| 日志等级分离 | `server/logger.js` 按等级过滤；各模块用 `logger.create(level, tag)` 取实例 |
| 静态资源路径分离 | `CS_STATIC_ROOT` / `CS_NOT_FOUND_PAGE` / `CS_STATIC_CACHE` |
| 404 兜底跟随环境 | 兜底页路径来自配置；页面内跳转改为**从当前路径推导站点根**，不再写死 `/kubao-support-agent/` |
| 跨域跟随环境 | `CS_CORS_ORIGINS` 白名单；预检只对命中来源回写头，未命中返回 403 且不写 `Access-Control-Allow-Origin` |

---

## 四、顺手补的安全加固

静态根默认指向项目根，改造前 `/server/`、`/data/`、`/.env` 理论上可被直接请求。现在加了目录/文件黑名单：

```
data  env  server  test  node_modules  .git  .github  .workbuddy
以及任何 .env / .env.* 文件
```

命中即返回 404（不是 403——不暴露"这里存在但不给你看"）。

另有两个启动期保护：

1. 生产环境口令缺省/为默认值 → 进程**直接退出**，不带病上线。
2. `unhandledRejection` 统一兜底，只记日志、不裸抛堆栈。

---

## 五、新增/改动文件

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 新 | `server/config.js` | 配置层：profile、加载、校验、深度冻结、runtimeConfig |
| 新 | `server/logger.js` | 分级日志（阶段4 会替换为结构化日志，接口保持不变） |
| 新 | `env/development.env.example` `env/test.env.example` `env/production.env.example` | 三套环境模板 |
| 新 | `test/config.test.js` | 15 条配置测试 |
| 改 | `.env.example` | 重写为变量总表 + 加载优先级说明 |
| 改 | `server.js` | 端口/静态根/404/请求体上限/CORS/日志全部读配置；新增 `/api/runtime-config`；静态目录黑名单 |
| 改 | `server/store.js` | 数据目录来自配置 |
| 改 | `server/rpc.js` | 聊天限流、登录防爆破阈值来自配置 |
| 改 | `server/analytics/index.js` | 分析限流阈值、日志级别来自配置 |
| 改 | `404.html` | 跳转根路径改为动态推导 |
| 改 | `assets/config.js` | 新增 `window.__CS_API_BASE__` 支持（默认同源，行为不变） |
| 改 | `.gitignore` | `env/*.env` 忽略，保留 `*.env.example` |
| 改 | `README.md` | 「环境与配置（三套环境）」章节 |
| 改 | `package.json` | `npm test` 纳入配置测试 |

---

## 六、自测

```bash
npm test    # 74 条，全部通过
```

新增 21 条：

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `test/config.test.js` | 15 | 三环境默认值、生产强制校验（口令/通配符）、非法环境名/端口/日志等级/阈值、静态目录与 404 页存在性、环境变量覆盖、CORS 精确匹配（含"后缀伪装"攻击 `app.test.evil.test`）、模型密钥不外泄、配置不可变、`.env` 解析 |
| `test/http.test.js`（追加） | 6 | `/api/runtime-config` 不含密钥、CORS 预检放行/拒绝、未命中来源不写头、404 兜底页状态码、HTML 不缓存、源码/数据/环境目录不可静态访问 |

原有 53 条全部保持通过 —— 说明这次重构没有改变任何业务行为。

---

## 七、已知取舍（记录在案）

1. **`runtime-config` 暴露环境名**：`env: "production"` 这类信息对攻击者价值有限，但确实是最小信息面的一部分；如果后续要求更严，可只返回 `mode: "server"`，前端此刻并不依赖它。
2. **限流键仍是"操作者口令"**：阶段2 遗留项。改成 `IP + 口令` 需要引入可信代理头（`X-Forwarded-For`）解析，而该头的可信度取决于 Nginx 配置——留到阶段6 与反代一起做，避免现在用上不可信的 IP 反而被绕过。
3. **`.env` 只支持单行 KEY=VALUE**：不支持变量插值、多行值。零依赖是刻意的，复杂需求交给 systemd `EnvironmentFile`（阶段6）。
4. **`logger` 是过渡实现**：只有等级过滤，没有 traceId/JSON 行/耗时。阶段4 会整体替换，各模块通过 `logger.create()` 取实例，替换时不需要改调用点。
