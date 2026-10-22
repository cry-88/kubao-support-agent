# 阶段 7 · GitHub Pages 静态版本适配与 CI 改造

> 范围：**只做静态展示链路**，不触碰阶段 6 的服务器部署链路（`scripts/package.sh`、`deploy/*`、systemd、Nginx 均未修改）。
> 站点地址不变：`https://cry-88.github.io/kubao-support-agent/`

---

## 一、要解决的问题

原实现靠**猜域名**判断是不是 Pages：

```js
/\.github\.io$/i.test(location.hostname)
```

三个毛病：

1. 判断散落在 `app.js` / `admin.js` 两处，改一处漏一处
2. 静态站点换个域名（比如自己的静态托管、本地 `file://` 打开）判断就失效
3. CI 直接把**仓库根目录**当产物发布，`server/`、`deploy/`、`test/`、`data/` 全被推到公开站点上

阶段 7 的做法：**模式改成显式声明，产物改成先构建再发布**。

---

## 二、运行模式设计

新增 `assets/runtime.js`——服务器版与静态版之间**唯一需要替换的文件**：

```js
window.__CS_MODE__ = 'server';   // 'server' | 'static'
window.__CS_API_BASE__ = '';     // 静态站点要连远程后端时填绝对地址
```

| | 服务器部署版本 | GitHub Pages 静态版 |
| --- | --- | --- |
| `assets/runtime.js` | 仓库里的 `'server'` | 构建时由 `build-pages.sh` 改写为 `'static'` |
| 页面 / 样式 / 其余 JS | 同一份 | 同一份 |
| 后端请求 | 同源 `/api/*` | **一个都不发** |

判定优先级（`assets/config.js`）：

1. `window.__CS_MODE__` 显式声明（`'static'` / `'server'`）
2. 声明缺失或非法 → 回退 `*.github.io` 域名判断（兼容历史部署，行为不变）
3. 都不是 → `'server'`

对外暴露 `window.CS_MODE` 与 `window.isStaticMode()`，`app.js` / `admin.js` 统一改读后者。

**加载顺序约束**：`runtime.js` 必须在 `config.js` 之前引入；`index.html` / `admin.html` 已调整，并有测试守着。

---

## 三、变更清单

| 文件 | 变更 | 说明 |
| --- | --- | --- |
| `assets/runtime.js` | 新增 | 模式声明，构建时唯一被替换的文件 |
| `assets/config.js` | 改 | 读 `__CS_MODE__`，兜底域名判断，导出 `isStaticMode()` |
| `assets/app.js` | 改 | `isStaticPreview()` 改读 `isStaticMode()`；静态态下 `boot()` 直接 return，不建云客户端 |
| `assets/admin.js` | 改 | 同一判断；文案「云托管域名」→「服务器部署版本」 |
| `index.html` / `admin.html` | 改 | 在 `config.js` 前插入 `runtime.js`，静态资源版本号统一 `20261022e` |
| `scripts/build-pages.sh` | 新增 | 构建 `dist-pages/`：复制页面与 `assets/`、改写 runtime、写 `.nojekyll`、产物自检 |
| `.github/workflows/deploy-pages.yml` | 重写 | `check`（语法 + 入口完整性 + `npm test` + 密钥扫描 + schema 结构）→ `deploy`（构建 → 上传 `dist-pages` → 发布） |
| `test/pages.test.js` | 新增 | 10 条：模式判定、加载顺序、构建脚本契约、CI 契约、真实构建产物校验 |
| `.gitignore` | 改 | 忽略 `dist-pages/` |
| `package.json` | 改 | `test` 加入 `test/pages.test.js`，版本 1.6.0 → 1.7.0 |
| `README.md` | 改 | 目录结构、第 5 步 A/B 部署章节、配置说明、已知限制 |
| `docs/stage6-deploy.md` / `scripts/package.sh` | 改 | 注释里 `git archive` → `git ls-files`（与实现对齐） |

---

## 四、构建脚本

```bash
bash scripts/build-pages.sh                       # 产出 dist-pages/，模式 static
CS_PAGES_API_BASE=https://support.example.com \
  bash scripts/build-pages.sh                     # 静态站点连远程后端，模式 server
```

自检规则（任一不满足即非零退出）：

- 产物里不得出现 `server.js`、`server/`、`deploy/`、`data/`、`test/`、`scripts/`、`.env*`
- `index.html`、`admin.html`、`404.html`、`.nojekyll`、`assets/config.js`、`assets/runtime.js`、`assets/dashboard.js` 必须存在
- `assets/runtime.js` 必须确实是目标模式

产物清单（静态版，约 12 个文件）：

```
404.html  admin.html  index.html  .nojekyll
assets/{app,admin,config,dashboard,kb,runtime}.js
assets/{styles,admin}.css
```

---

## 五、CI 流程

`push` 到 `main` 或手动触发：

```
check:  node --check（server/*.js + assets/*.js）
        入口文件存在性
        npm test
        密钥扫描（sk- / ghp_ / gho_ / AKIA / PRIVATE KEY，排除本 workflow 与构建产物）
        schema.sql 结构（≥28 函数 / ≥7 表）
deploy: bash scripts/build-pages.sh
        upload-pages-artifact: dist-pages     ← 只传产物，不再传仓库根目录
        deploy-pages@v4
```

`concurrency.group: pages` + `cancel-in-progress: true`，多次推送只保留最后一次。

---

## 六、验证结果

`npm test` 全量通过（含新增 `test/pages.test.js`）。额外做的手工验证：

- 本地 `python -m http.server 8099 -d dist-pages`，Chrome 打开 → 顶部显示「静态预览模式」横幅
- Network 面板：**没有任何 `/api/*` 请求**，输入框与后台登录按钮为禁用态
- `admin.html` 打开即提示「当前为 GitHub Pages 静态预览版，工作台需在服务器部署版本中使用」

服务器版回归：`node server.js` 在 8080 正常，`__CS_MODE__='server'` 路径未变，对话 / 工单 / 看板 / 导出全部可用。

---

## 七、待执行的命令（仅生成，未执行）

本阶段所有操作都在本地完成，**没有产生任何需要上服务器执行的命令**。

需要用户/维护者手工做的一件事（GitHub 网页操作，非命令行）：

1. 仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**（若之前已选则无需改动）

可选的本地验证命令（风险：无，只在本机读写 `dist-pages/`）：

```bash
bash scripts/build-pages.sh
python -m http.server 8099 -d dist-pages
```

---

## 八、风险与回滚

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| `runtime.js` 未先于 `config.js` 加载 | 模式判定退化到域名判断 | 测试断言两者下标顺序 |
| 构建产物混入后端代码 | 源码对外泄露 | 构建脚本自检 + CI 只上传 `dist-pages` + 测试断言 |
| 静态态下仍发请求 | Pages 上满屏报错 | `boot()` 在预览分支直接 return |
| 历史部署（无 `runtime.js`） | 行为变化 | `config.js` 保留 `*.github.io` 兜底，行为与改造前一致 |

回滚：把 `assets/runtime.js` 从 HTML 引用中去掉即可退回旧逻辑（代码仍在 `config.js` 里），或整体回滚本阶段提交；服务器部署链路完全不受影响。
